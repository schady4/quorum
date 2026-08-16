// Integration proof of durable seat checkpoints: a seat that answers a message
// records its progress into the relay's checkpoint log, so a fresh incarnation
// (after a crash/reconnect) resumes rather than re-answering — yet still handles
// genuinely new messages. Offline: a counting fake responder stands in for the
// model. Run with `npm run test:durable`.

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
const claudeMsgs = (c: RoomClient) => c.entries().filter((e: Entry) => e.author === "claude");

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  // A counting responder so we can tell whether a given seat actually spoke.
  const calls = { first: 0, second: 0 };
  const responder = (bucket: "first" | "second") => async (_entries: Entry[], self: string) => {
    calls[bucket]++;
    return `pong from ${self}`;
  };

  const human = new RoomClient(url, "lobby", "ada");
  human.connect();
  await nextOpen(human);

  // --- First incarnation answers one message, then "crashes". --------------
  const first = new AgentSeat({ relayUrl: url, room: "lobby", handle: "claude", respond: responder("first") });
  first.start();
  await nextOpen(first.roomClient);
  await wait(120);

  human.send("@claude ping");
  await wait(400); // reply + checkpoint broadcast

  check("first seat answered once", calls.first === 1, `calls.first=${calls.first}`);
  check("room has exactly one claude message", claudeMsgs(human).length === 1, `count=${claudeMsgs(human).length}`);

  first.close(); // simulate a crash / disconnect
  await wait(120);

  // --- Second incarnation rejoins; must NOT re-answer the handled message. --
  const second = new AgentSeat({ relayUrl: url, room: "lobby", handle: "claude", respond: responder("second") });
  second.start();
  await nextOpen(second.roomClient);
  await wait(400); // welcome replays the checkpoint; onUpdate would re-answer without it

  check("rejoined seat did not re-answer the handled message", calls.second === 0, `calls.second=${calls.second}`);
  check("still exactly one claude message after rejoin", claudeMsgs(human).length === 1, `count=${claudeMsgs(human).length}`);

  // --- ...but it resumes: a genuinely new message is still answered. --------
  human.send("@claude pong");
  await wait(400);

  check("rejoined seat answers a new message", calls.second === 1, `calls.second=${calls.second}`);
  check("room now has two claude messages", claudeMsgs(human).length === 2, `count=${claudeMsgs(human).length}`);

  second.close();
  human.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
