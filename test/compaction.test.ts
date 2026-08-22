// CRDT retention compaction: a room's persisted log is trimmed to the last N
// messages, but ONLY while the room is quiescent (no members) — on the last
// member leaving, and on boot. Proves: no compaction while someone's connected;
// compaction on empty keeps the last N with original ids + re-anchored head; a
// fresh joiner catches up to just those; boot compaction tightens further; and
// the trimmed messages still decrypt. Offline; no model keys. Run: npm run test:compaction.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { MemoryRelayStore } from "../src/relay/store.js";
import { deriveAuthToken } from "../src/net/crypto.js";
import { ROOT } from "../src/core/crdt.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));
async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (cond()) return true; await wait(25); }
  return cond();
}

const SECRET = "correct horse battery";

async function main(): Promise<void> {
  const token = deriveAuthToken(SECRET);
  const store = new MemoryRelayStore();
  const relay = await startRelay({ port: 0, authToken: token, store, maxOpsPerRoom: 3 });
  const url = `ws://localhost:${relay.port}`;

  const ada = new RoomClient(url, "lobby", "ada", SECRET);
  ada.on("error", () => {});
  ada.connect();
  await nextOpen(ada);
  for (let i = 1; i <= 6; i++) ada.send(`m${i}`);
  await waitUntil(() => ada.entries().length === 6);
  const adaIds = ada.entries().map((e) => e.id);

  // While ada is connected the room is NOT quiescent — the log grows to 6 and is
  // never compacted.
  await waitUntil(() => store.load("lobby").ops.length === 6);
  await wait(100); // give any (erroneous) compaction a chance to run
  check("no compaction while a member is connected", store.load("lobby").ops.length === 6);

  // ada leaves → room empty → compact to the last 3.
  ada.close();
  await waitUntil(() => store.load("lobby").ops.length === 3);
  const compacted = store.load("lobby");
  check("compacted to the last N on the room emptying", compacted.ops.length === 3);
  check("compaction keeps the ORIGINAL ids of the last N", JSON.stringify(compacted.ops.map((o) => o.id)) === JSON.stringify(adaIds.slice(-3)));
  check("the new head is re-anchored to ROOT", compacted.ops[0].type === "insert" && compacted.ops[0].after === ROOT);

  // A fresh joiner catches up to only the last 3 — and they still decrypt.
  const bob = new RoomClient(url, "lobby", "bob", SECRET);
  bob.on("error", () => {});
  bob.connect();
  await nextOpen(bob);
  await waitUntil(() => bob.entries().length === 3);
  const texts = bob.entries().map((e) => e.value);
  check("a fresh joiner sees only the retained messages", bob.entries().length === 3);
  check("the retained messages decrypt in order", JSON.stringify(texts) === JSON.stringify(["m4", "m5", "m6"]));
  bob.close();
  await wait(80);
  await relay.close();

  // Boot compaction: a new relay on the same store with a tighter cap trims more
  // before serving anyone.
  const relay2 = await startRelay({ port: 0, authToken: token, store, maxOpsPerRoom: 2 });
  check("boot compaction tightens the log to the new cap", store.load("lobby").ops.length === 2);
  const cass = new RoomClient(`ws://localhost:${relay2.port}`, "lobby", "cass", SECRET);
  cass.on("error", () => {});
  cass.connect();
  await nextOpen(cass);
  await waitUntil(() => cass.entries().length === 2);
  check("a joiner after boot compaction sees the last 2", JSON.stringify(cass.entries().map((e) => e.value)) === JSON.stringify(["m5", "m6"]));
  cass.close();
  await relay2.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
