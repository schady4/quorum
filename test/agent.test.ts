// Integration proof for M2: an AI seat joins a room like any client, answers
// when @mentioned, stays silent otherwise, and never loops on its own messages.
// Offline — a fake responder stands in for the model, so no network or key is
// needed. Run with `npm run test:agent`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { AgentSeat } from "../src/agent/seat.js";
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
const textOf = (c: RoomClient) => c.entries().map((e: Entry) => `${e.author}: ${e.value}`);

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  // A fake model: echo the last message's text. Also counts calls so we can
  // prove the seat doesn't re-answer or loop.
  let calls = 0;
  const fakeRespond = async (entries: Entry[], _self: string): Promise<string> => {
    calls++;
    const last = entries[entries.length - 1];
    return `echo: ${last.value}`;
  };

  const human = new RoomClient(url, "lobby", "ada");
  const seat = new AgentSeat({ relayUrl: url, room: "lobby", handle: "claude", respond: fakeRespond });
  human.connect();
  seat.start();
  await Promise.all([nextOpen(human), nextOpen(seat.roomClient)]);
  await wait(120);

  // 1. A message with no mention: the seat stays silent.
  human.send("just chatting, no mention here");
  await wait(200);
  check("no reply without a mention", calls === 0 && human.entries().length === 1, textOf(human).join(" | "));

  // 2. A mention: the seat replies exactly once, and the human sees it.
  human.send("@claude are you there?");
  await wait(250);
  const fromClaude = human.entries().filter((e) => e.author === "claude");
  check("replies once when mentioned", calls === 1 && fromClaude.length === 1, `calls=${calls}`);
  check("reply is visible to the human", fromClaude[0]?.value === "echo: @claude are you there?", fromClaude[0]?.value);

  // 3. The seat's own reply must not trigger another reply (no self-loop).
  await wait(250);
  check("does not loop on its own message", calls === 1, `calls=${calls}`);

  // 4. Both replicas converged on the same stream (human + agent seat).
  check(
    "human and agent seat share one converged stream",
    JSON.stringify(textOf(human)) === JSON.stringify(textOf(seat.roomClient)),
    `${JSON.stringify(textOf(human))} vs ${JSON.stringify(textOf(seat.roomClient))}`,
  );

  human.close();
  seat.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
