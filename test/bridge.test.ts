// Slack bridge engine — parsed commands, crash-safe cursors, and the core
// relay: per-user identity inbound, no echo-back, banner + ordered outbound,
// `/quorum` dispatch (incl. the key refusal), and graceful shutdown. All with
// fakes — no live workspace. Run: npm run test:bridge

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../src/core/crdt.js";
import { parseQuorumCommand } from "../src/bridge/slack/commands.js";
import { CursorStore } from "../src/bridge/slack/cursors.js";
import { SlackBridge, defaultHandleFor, type BridgeOptions, type RoomSeat, type SlackGateway } from "../src/bridge/slack/core.js";

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- Fakes ------------------------------------------------------------------

let _eid = 0;
/** A shared converged room: every seat reads the same log and is notified on
 *  every append — the CRDT convergence property, modeled minimally. */
class FakeRoom {
  entries: Entry[] = [];
  seats: FakeSeat[] = [];
  push(author: string, value: string): void {
    this.entries.push({ id: `${author}:${++_eid}`, value, author, ts: Date.now() });
    for (const s of this.seats) s.fireUpdate();
  }
  setPresence(p: string[]): void {
    for (const s of this.seats) {
      s.participants = p;
      s.firePresence(p);
    }
  }
}
class FakeSeat implements RoomSeat {
  participants: string[] = [];
  agents: string[] = [];
  closed = false;
  forks: string[][] = [];
  sets: Array<[string, string, string]> = [];
  merges: Array<[string, string]> = [];
  private ups: Array<(e: Entry[]) => void> = [];
  private pres: Array<(p: string[]) => void> = [];
  constructor(
    private readonly room: FakeRoom,
    readonly handle: string,
    readonly kind: "human" | "agent",
  ) {
    room.seats.push(this);
  }
  connect(): void {
    this.fireUpdate(); // stand-in for the relay's welcome → first update
  }
  close(): void {
    this.closed = true;
  }
  send(text: string): void {
    this.room.push(this.handle, text);
  }
  fork(branches: string[]): void {
    this.forks.push(branches);
  }
  setDecision(branch: string, key: string, value: string): void {
    this.sets.push([branch, key, value]);
  }
  async merge(a: string, b: string): Promise<{ conflicts: number; arbitrated: boolean }> {
    this.merges.push([a, b]);
    return { conflicts: 0, arbitrated: false };
  }
  entries(): Entry[] {
    return this.room.entries;
  }
  on(event: "update" | "presence", fn: any): unknown {
    if (event === "update") this.ups.push(fn);
    else this.pres.push(fn);
    return this;
  }
  fireUpdate(): void {
    for (const f of this.ups) f(this.room.entries);
  }
  firePresence(p: string[]): void {
    for (const f of this.pres) f(p);
  }
}

interface Posted {
  text: string;
  username?: string;
  quorumOp?: string;
}
class FakeGateway implements SlackGateway {
  posts: Posted[] = [];
  async post(msg: Posted): Promise<string> {
    this.posts.push(msg);
    return `${Date.now()}.${this.posts.length}`;
  }
  texts(): string[] {
    return this.posts.map((p) => p.text);
  }
}

function harness(opts: { seatAgent?: BridgeOptions["seatAgent"]; announcePresence?: boolean } = {}) {
  const room = new FakeRoom();
  const gateway = new FakeGateway();
  const dir = mkdtempSync(join(tmpdir(), "qbridge-"));
  const cursors = new CursorStore(join(dir, "cursors.json"));
  const seats: FakeSeat[] = [];
  const bridge = new SlackBridge({
    gateway,
    cursors,
    room: "lobby",
    channel: "general",
    announcePresence: opts.announcePresence,
    seatAgent: opts.seatAgent as any,
    makeSeat: (handle, kind) => {
      const s = new FakeSeat(room, handle, kind);
      seats.push(s);
      return s;
    },
  });
  return { room, gateway, cursors, bridge, seats, dir };
}

// --- 1. Command grammar -----------------------------------------------------

await test("parse: /quorum key … is REFUSED (secrets never traverse Slack)", () => {
  const c = parseQuorumCommand("key set hunter2");
  ok(c.kind === "refused", `expected refused, got ${c.kind}`);
});
await test("parse: fork / set / merge / status / agent", () => {
  ok(parseQuorumCommand("fork A B").kind === "fork", "fork");
  const set = parseQuorumCommand("set A owner alice");
  ok(set.kind === "set" && set.value === "alice", "set value");
  ok(parseQuorumCommand("merge A B").kind === "merge", "merge");
  ok(parseQuorumCommand("status").kind === "status", "status");
  const a = parseQuorumCommand("agent claude --provider anthropic --model x");
  ok(a.kind === "agent" && a.provider === "anthropic" && a.model === "x", "agent flags");
});
await test("parse: empty shows help; garbage is a friendly error", () => {
  ok(parseQuorumCommand("").kind === "help", "empty→help");
  ok(parseQuorumCommand("wat").kind === "error", "unknown→error");
  ok(parseQuorumCommand("fork A").kind === "error", "missing arg→error");
});

// --- 2. Cursors (crash-safe idempotency) ------------------------------------

await test("cursors: dedup by ts, numeric compare, persist across reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "qcur-"));
  const path = join(dir, "c.json");
  const c = new CursorStore(path);
  ok(!c.hasSeen("100.000200"), "unseen initially");
  c.markInbound("100.000200");
  ok(c.hasSeen("100.000200"), "seen after mark");
  ok(c.hasSeen("100.000100"), "older ts is below the high-water mark (numeric)");
  ok(!c.hasSeen("100.000300"), "newer ts not yet seen");
  c.markOutbound("op-7");
  // Reload from disk — a fresh process must recover the same state (kill -9 safe).
  const c2 = new CursorStore(path);
  ok(c2.hasSeen("100.000200") && c2.quorumOp === "op-7", "state survived reload");
  rmSync(dir, { recursive: true, force: true });
});
await test("cursors: 999… vs 1000… compares numerically, not lexically", () => {
  const dir = mkdtempSync(join(tmpdir(), "qcur2-"));
  const c = new CursorStore(join(dir, "c.json"));
  c.markInbound("1000.000000");
  ok(c.hasSeen("999.000000"), "999 < 1000 numerically (lexical would say otherwise)");
  rmSync(dir, { recursive: true, force: true });
});

// --- 3. Inbound: Slack → Quorum, per-user identity, dedup -------------------

await test("inbound: a Slack user is seated as a handle; message lands authored as them", async () => {
  const h = harness();
  h.bridge.start();
  await tick();
  h.bridge.onSlackMessage({ userId: "U1", userName: "Ada Lovelace", text: "hello room", ts: "10.0001" });
  await tick();
  const mine = h.room.entries.filter((e) => e.value === "hello room");
  ok(mine.length === 1, "message reached the room exactly once");
  ok(mine[0].author === "ada-lovelace", `authored as slug handle, got ${mine[0].author}`);
});
await test("inbound: a redelivered ts is dropped (exactly-once)", async () => {
  const h = harness();
  h.bridge.start();
  await tick();
  h.bridge.onSlackMessage({ userId: "U1", userName: "Ada", text: "twice?", ts: "11.0001" });
  h.bridge.onSlackMessage({ userId: "U1", userName: "Ada", text: "twice?", ts: "11.0001" });
  await tick();
  ok(h.room.entries.filter((e) => e.value === "twice?").length === 1, "duplicate ts relayed only once");
});

// --- 4. Outbound: Quorum → Slack, banner, no echo-back ----------------------

await test("outbound: a native message is posted to Slack with author + quorumOp", async () => {
  const h = harness();
  h.bridge.start();
  await tick(); // seed + banner
  h.room.push("ada", "from the terminal");
  await tick();
  const relayed = h.gateway.posts.find((p) => p.text === "from the terminal");
  ok(!!relayed, "native message was relayed to Slack");
  ok(relayed!.username === "ada", "carried the author as username");
  ok(!!relayed!.quorumOp, "stamped a quorumOp for outbound idempotency");
});
await test("outbound: the first view is a banner, not a backlog dump", async () => {
  const h = harness();
  h.room.push("ada", "old history 1");
  h.room.push("ada", "old history 2");
  h.bridge.start();
  await tick();
  ok(h.gateway.posts.length === 1 && /bridged to Quorum room/.test(h.gateway.posts[0].text), "only a banner, history seeded as posted");
});
await test("outbound: a Slack-origin message is NOT echoed back to Slack", async () => {
  const h = harness();
  h.bridge.start();
  await tick();
  const before = h.gateway.posts.length;
  h.bridge.onSlackMessage({ userId: "U9", userName: "Grace", text: "no loop please", ts: "20.0001" });
  await tick();
  ok(!h.gateway.texts().includes("no loop please"), "must not post a Slack-authored message back into Slack");
  ok(h.gateway.posts.length === before, "no new Slack posts from a Slack-origin message");
});

// --- 5. Command dispatch ----------------------------------------------------

async function runCmd(bridge: SlackBridge, text: string): Promise<{ text: string; inChannel: boolean }[]> {
  const replies: { text: string; inChannel: boolean }[] = [];
  await bridge.onSlackCommand({ userId: "U1", text }, async (m) => {
    replies.push(m);
  });
  return replies;
}
await test("command: fork/set/merge drive the control seat and reply in-channel", async () => {
  const h = harness();
  h.bridge.start();
  await tick();
  const control = h.seats[0]; // the bridge's own control seat is made first
  const fr = await runCmd(h.bridge, "fork A B");
  ok(control.forks.length === 1 && fr[0].inChannel, "fork issued + in-channel reply");
  await runCmd(h.bridge, "set A owner alice");
  ok(control.sets.length === 1 && control.sets[0][2] === "alice", "set issued");
  const mr = await runCmd(h.bridge, "merge A B");
  ok(control.merges.length === 1 && /merged/.test(mr[0].text), "merge issued");
});
await test("command: /quorum key is refused ephemerally", async () => {
  const h = harness();
  h.bridge.start();
  await tick();
  const r = await runCmd(h.bridge, "key hunter2");
  ok(r.length === 1 && !r[0].inChannel && /never go through Slack|Keys/i.test(r[0].text), "refused, ephemeral");
});
await test("command: agent seats via host creds when configured; refused otherwise", async () => {
  const disposed: string[] = [];
  const withAgent = harness({
    seatAgent: async ({ handle }) => {
      return () => disposed.push(handle);
    },
  });
  withAgent.bridge.start();
  await tick();
  const r = await runCmd(withAgent.bridge, "agent claude --provider anthropic");
  ok(/seated/.test(r[0].text) && r[0].inChannel, "seated + announced in-channel");
  await withAgent.bridge.shutdown();
  ok(disposed.includes("claude"), "shutdown disposed the seated agent");

  const noAgent = harness();
  noAgent.bridge.start();
  await tick();
  const r2 = await runCmd(noAgent.bridge, "agent claude");
  ok(!r2[0].inChannel && /no AI seating configured/i.test(r2[0].text), "refused when host has no seating");
});

// --- 6. Shutdown ------------------------------------------------------------

await test("shutdown: announces offline and closes seats", async () => {
  const h = harness();
  h.bridge.start();
  await tick();
  h.bridge.onSlackMessage({ userId: "U1", userName: "Ada", text: "hi", ts: "30.0001" });
  await tick();
  await h.bridge.shutdown();
  ok(/offline/i.test(h.gateway.texts().join("\n")), "posted an offline notice");
  ok(h.seats.every((s) => s.closed), "every seat was closed");
});

// --- misc -------------------------------------------------------------------

await test("defaultHandleFor: slugs names, falls back to an id", () => {
  ok(defaultHandleFor({ id: "U1", name: "Ada Lovelace" }) === "ada-lovelace", "slug");
  ok(defaultHandleFor({ id: "U2", name: "" }) === "slack-U2", "fallback to id");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
