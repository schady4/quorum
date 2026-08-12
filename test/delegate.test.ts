// Integration proof for M3's delegation: a seat receiving "@self delegate <h>
// ... to <task>" spins up another seat, which joins the room as its own
// participant and does the work — everyone sees it. Offline: fake responders
// stand in for models, so no network or key is needed.
// Run with `npm run test:delegate`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { AgentSeat, parseDelegate, type DelegateSpec } from "../src/agent/seat.js";
import type { Entry } from "../src/core/crdt.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));

function testParser(): void {
  const a = parseDelegate("@lead delegate scribe using openai/gpt-5 to summarize the thread", "lead");
  check("parses handle, provider, model, task", !!a && a.handle === "scribe" && a.providerId === "openai" && a.model === "gpt-5" && a.task === "summarize the thread", JSON.stringify(a));

  const b = parseDelegate("@lead delegate helper to draft a plan", "lead");
  check("parses bare delegate (provider/model optional)", !!b && b.handle === "helper" && b.providerId === undefined && b.task === "draft a plan", JSON.stringify(b));

  const c = parseDelegate("@lead what do you think?", "lead");
  check("non-delegate mention is not a delegation", c === null);

  const d = parseDelegate("delegate x to y", "lead");
  check("delegation without a mention is ignored", d === null);
}

async function main(): Promise<void> {
  testParser();

  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;
  const seats: { close(): void }[] = [];

  const echo = (label: string) => async (entries: Entry[]): Promise<string> => {
    const last = entries[entries.length - 1];
    return `[${label}] handled: ${last.value}`;
  };

  // The lead seat delegates by spawning a child echo seat and handing it the task.
  const lead = new AgentSeat({
    relayUrl: url,
    room: "lobby",
    handle: "lead",
    respond: echo("lead"),
    onDelegate: (spec: DelegateSpec) => {
      const child = new AgentSeat({
        relayUrl: url,
        room: "lobby",
        handle: spec.handle,
        respond: echo(spec.handle),
      });
      child.start();
      seats.push(child);
      setTimeout(() => lead.roomClient.send(`@${spec.handle} ${spec.task}`), 150);
    },
  });
  lead.start();
  seats.push(lead);

  const human = new RoomClient(url, "lobby", "ada");
  human.connect();
  await Promise.all([nextOpen(human), nextOpen(lead.roomClient)]);
  await wait(120);

  // Human asks the lead to delegate.
  human.send("@lead delegate scribe to summarize the notes");
  await wait(600); // ack -> spawn -> handoff -> child reply

  const authors = human.entries().map((e) => e.author);
  check("lead acknowledged the delegation", human.entries().some((e) => e.author === "lead" && e.value.includes("spinning up @scribe")), authors.join(","));
  check("delegated seat joined as its own participant", human.participants.includes("scribe"), human.participants.join(","));
  check("delegated seat did the task and shared it", human.entries().some((e) => e.author === "scribe" && e.value.includes("summarize the notes")), human.entries().filter((e) => e.author === "scribe").map((e) => e.value).join(" | "));

  for (const s of seats) s.close();
  human.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
