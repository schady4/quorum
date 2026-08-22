// Proof of the wired RoomStore: a client persists every (sealed) frame, reloads
// its history on restart (even before the relay answers), and re-seeds a relay
// that lost its memory — so any client is a backup. Offline. Run with
// `npm run test:restore`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { MemoryRoomStore } from "../src/session/store.js";
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
const msgs = (c: RoomClient) => c.entries().map((e: Entry) => ({ author: e.author, text: e.value }));

const KEY = "s3cret";

async function main(): Promise<void> {
  const store = new MemoryRoomStore();

  // --- A client persists every sealed frame it sends. ----------------------
  const relay1 = await startRelay({ port: 0, authToken: deriveAuthToken(KEY) });
  const url1 = `ws://localhost:${relay1.port}`;

  const a = new RoomClient(url1, "lobby", "ada", KEY);
  a.store = store;
  a.on("error", () => {});
  a.connect();
  await nextOpen(a);
  a.send("first");
  a.send("second");
  await wait(120);

  const opFrames = store.load("lobby").filter((f) => f.t === "op");
  check("the client persisted both messages", opFrames.length === 2, `stored ${opFrames.length}`);
  check("persisted frames are sealed at rest", (opFrames[0].op as { value: string }).value.startsWith("e1:"));
  a.close();

  // --- A restart reloads history from the store, even before the relay. -----
  const b = new RoomClient(url1, "lobby", "ada-again", KEY);
  b.store = store;
  b.on("error", () => {});
  b.connect(); // loadFromStore runs synchronously here, before any welcome
  check("history is restored from disk on restart (offline)", eq(msgs(b), [{ author: "ada", text: "first" }, { author: "ada", text: "second" }]), JSON.stringify(msgs(b)));
  b.close();
  await relay1.close();

  // --- A brand-new relay lost everything; a client re-seeds it. ------------
  const relay2 = await startRelay({ port: 0, authToken: deriveAuthToken(KEY) });
  const url2 = `ws://localhost:${relay2.port}`;

  const reviver = new RoomClient(url2, "lobby", "reviver", KEY);
  reviver.store = store; // same durable log
  reviver.on("error", () => {});
  reviver.connect();
  await nextOpen(reviver); // empty welcome -> re-seeds the 2 ops into relay2
  await wait(150);

  const obs = new RoomClient(url2, "lobby", "obs", KEY); // no store — a plain joiner
  obs.on("error", () => {});
  obs.connect();
  await nextOpen(obs);
  const restored = await waitUntil(() => obs.entries().length === 2);
  check("a fresh relay is restored from the client's log", restored, `got ${obs.entries().length}`);
  check("the re-seeded messages keep their original author + text", eq(msgs(obs), [{ author: "ada", text: "first" }, { author: "ada", text: "second" }]), JSON.stringify(msgs(obs)));

  reviver.close();
  obs.close();
  await relay2.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
