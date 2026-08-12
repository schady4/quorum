// Integration proof for M1: two clients, through the real relay, converge on
// the same message stream — including a late joiner who catches up from the op
// log, and concurrent sends that land in the same order on both replicas.
//
// Headless (no Ink): drives RoomClient directly. Run with `npm run test:net`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
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
const settle = () => wait(120);
const stream = (c: RoomClient) => c.entries().map((e: Entry) => `${e.author}:${e.value}`);

async function nextOpen(c: RoomClient): Promise<void> {
  await new Promise<void>((res) => c.once("open", () => res()));
}

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0 }); // OS-assigned free port
  const url = `ws://localhost:${relay.port}`;

  // Two clients join the same room.
  const alice = new RoomClient(url, "lobby", "alice");
  const bob = new RoomClient(url, "lobby", "bob");
  alice.connect();
  bob.connect();
  await Promise.all([nextOpen(alice), nextOpen(bob)]);
  await settle();

  // Sequential messages propagate both ways.
  alice.send("hi from alice");
  await settle();
  bob.send("hi from bob");
  await settle();

  check("both clients see both messages", alice.entries().length === 2 && bob.entries().length === 2);
  check(
    "message streams are identical across replicas",
    JSON.stringify(stream(alice)) === JSON.stringify(stream(bob)),
    `${JSON.stringify(stream(alice))} vs ${JSON.stringify(stream(bob))}`,
  );

  // Concurrent sends (no settle between) must still converge to one order.
  alice.send("concurrent-A");
  bob.send("concurrent-B");
  await settle();
  check(
    "concurrent sends converge to the same order on both",
    JSON.stringify(stream(alice)) === JSON.stringify(stream(bob)),
    `${JSON.stringify(stream(alice))} vs ${JSON.stringify(stream(bob))}`,
  );
  check("all four messages present", alice.entries().length === 4);

  // A late joiner catches up from the relay's op log.
  const carol = new RoomClient(url, "lobby", "carol");
  carol.connect();
  await nextOpen(carol);
  await settle();
  check(
    "late joiner reconstructs the full stream",
    JSON.stringify(stream(carol)) === JSON.stringify(stream(alice)),
    `${JSON.stringify(stream(carol))}`,
  );

  // Presence reflects the roster.
  check("presence lists all three participants", carol.participants.length === 3, carol.participants.join(","));

  alice.close();
  bob.close();
  carol.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
