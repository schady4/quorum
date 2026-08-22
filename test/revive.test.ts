// Proof of revival: a saved .qdag bond, streamed through client.replay onto a
// relay, brings the room back — a fresh joiner converges on the full history
// (with the ORIGINAL authors, not the reviver's) and the decision DAG. Offline.
// Run with `npm run test:revive`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { deriveAuthToken } from "../src/net/crypto.js";
import { encodeSave, streamFrames, type Session } from "../src/session/qdag.js";
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
function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));
async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await wait(25);
  }
  return cond();
}

const KEY = "s3cret";
const session: Session = {
  room: "vault",
  created: 1700000000000,
  roster: ["ada", "claude", "bob"],
  messages: [
    { author: "ada", text: "reviving the launch thread" },
    { author: "claude", text: "owner ada, deadline monday" },
    { author: "bob", text: "back in business" },
  ],
  ledger: [
    { type: "fork", branches: ["A", "B"] },
    { type: "edit", branch: "A", key: "owner", value: "ada", author: "ada" },
    { type: "edit", branch: "B", key: "deadline", value: "monday", author: "bob" },
    { type: "merge", branches: ["A", "B"], resolved: { owner: "ada", deadline: "monday" }, author: "claude", viaArbitration: true, rationale: "kept both" },
  ],
};

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0, authToken: deriveAuthToken(KEY) });
  const url = `ws://localhost:${relay.port}`;

  // The reviver joins a fresh (empty) relay and replays the bond from its file.
  const reviver = new RoomClient(url, session.room, "reviver", KEY);
  reviver.on("error", () => {});
  reviver.connect();
  await nextOpen(reviver);

  const file = encodeSave(session, KEY);
  streamFrames(file.split("\n"), { key: KEY }, (frames) => reviver.replay(frames));
  await wait(150); // let the replayed frames reach the relay

  check("the reviver shows the full history locally", reviver.entries().length === session.messages.length);
  check("revived ledger DAG replays to the merged trunk", eq(reviver.ledger.trunk, { owner: "ada", deadline: "monday" }) && !reviver.ledger.forked);

  // A friend who was on the DAG rejoins the revived room and converges.
  const friend = new RoomClient(url, session.room, "bob", KEY);
  friend.on("error", () => {});
  friend.connect();
  await nextOpen(friend);

  const converged = await waitUntil(() => friend.entries().length === session.messages.length);
  check("a fresh joiner converges on the revived history", converged, `got ${friend.entries().length}`);

  const seen = friend.entries().map((e: Entry) => ({ author: e.author, text: e.value }));
  check("messages keep their ORIGINAL authors (not the reviver's)", eq(seen, session.messages), JSON.stringify(seen));
  check("the joiner sees the revived decision DAG too", eq(friend.ledger.trunk, { owner: "ada", deadline: "monday" }));

  reviver.close();
  friend.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
