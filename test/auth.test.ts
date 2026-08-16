// Integration proof of the shared room key: a keyed relay admits clients with
// the matching key and refuses the rest, an open relay ignores keys, and a
// refused join is terminal (no reconnect loop). Offline; no model keys.
// Run with `npm run test:auth`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { deriveAuthToken } from "../src/net/crypto.js";
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

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await wait(25);
  }
  return cond();
}

async function main(): Promise<void> {
  // --- Keyed relay: right key joins and converges; wrong/missing key refused. --
  const keyed = await startRelay({ port: 0, authToken: deriveAuthToken("s3cret") });
  const url = `ws://localhost:${keyed.port}`;

  const ada = new RoomClient(url, "lobby", "ada", "s3cret");
  ada.on("error", () => {});
  ada.connect();
  await nextOpen(ada);
  await waitUntil(() => ada.participants.includes("ada"));
  check("correct key is admitted (got a welcome)", ada.participants.includes("ada"), ada.participants.join(","));

  const bob = new RoomClient(url, "lobby", "bob", "s3cret");
  bob.on("error", () => {});
  bob.connect();
  await nextOpen(bob);
  ada.send("hello behind the key");
  const delivered = await waitUntil(() =>
    bob.entries().some((e: Entry) => e.author === "ada" && e.value === "hello behind the key"),
  );
  check("keyed peers converge", delivered, bob.entries().map((e) => `${e.author}:${e.value}`).join(" | "));

  // Wrong key: denied, terminal, and never enters the roster.
  const mallory = new RoomClient(url, "lobby", "mallory", "letmein");
  let deniedReason = "";
  let reconnects = 0;
  mallory.on("denied", (r) => (deniedReason = r));
  mallory.on("reconnecting", () => reconnects++);
  mallory.on("error", () => {});
  mallory.connect();
  await waitUntil(() => deniedReason !== "");
  check("wrong key is denied", deniedReason.length > 0, `reason="${deniedReason}"`);
  check("denied client never joined the roster", mallory.participants.length === 0, mallory.participants.join(","));

  // No key against a keyed relay is also denied.
  const nokey = new RoomClient(url, "lobby", "nokey");
  let nokeyDenied = false;
  nokey.on("denied", () => (nokeyDenied = true));
  nokey.on("error", () => {});
  nokey.connect();
  await waitUntil(() => nokeyDenied);
  check("missing key is denied", nokeyDenied);

  await wait(400); // give any (incorrect) reconnect a chance to fire
  check("a denied join does not retry", reconnects === 0, `reconnects=${reconnects}`);
  check("denied clients never reached the room", !bob.participants.includes("mallory") && !bob.participants.includes("nokey"), bob.participants.join(","));

  ada.close();
  bob.close();
  mallory.close();
  nokey.close();
  await keyed.close();

  // --- Open relay: a client that happens to pass a key still joins. ----------
  const open = await startRelay({ port: 0 });
  const openUrl = `ws://localhost:${open.port}`;
  const carol = new RoomClient(openUrl, "lobby", "carol", "irrelevant-key");
  carol.on("error", () => {});
  carol.connect();
  await nextOpen(carol);
  const joinedOpen = await waitUntil(() => carol.participants.includes("carol"));
  check("open relay ignores a supplied key", joinedOpen, carol.participants.join(","));

  carol.close();
  await open.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
