// Integration proof of client auto-reconnect: a client whose relay is absent
// retries with backoff and joins on its own once the relay appears; an
// intentional close() stops retrying. A friend on flaky Wi-Fi rejoins without
// re-running `join` — and, paired with durable checkpoints, an AI seat resumes
// where it left off. Offline; no keys. Run with `npm run test:reconnect`.
//
// The relay is started *after* the client is already retrying, so nothing races
// a live socket against a relay shutdown — that timing is the flaky part.

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
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));

async function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await wait(25);
  }
  return cond();
}

async function main(): Promise<void> {
  // Discover a free port, then release it — the client will dial it while it's
  // empty and retry until we bring the relay up there.
  const probe = await startRelay({ port: 0 });
  const port = probe.port;
  await probe.close();
  const url = `ws://localhost:${port}`;

  const client = new RoomClient(url, "lobby", "ada");
  client.reconnect.baseMs = 60; // speed the test up
  client.reconnect.maxMs = 240;

  let opens = 0;
  let reconnecting = 0;
  client.on("open", () => opens++);
  client.on("reconnecting", () => reconnecting++);
  client.on("error", () => {}); // swallow the expected ECONNREFUSED while empty

  // --- Relay absent: the client should keep retrying, not give up. ---------
  client.connect();
  const retried = await waitUntil(() => reconnecting >= 2);
  check("client retries while the relay is absent", retried, `reconnecting=${reconnecting}`);
  check("no successful open yet", opens === 0, `opens=${opens}`);

  // --- Relay appears: the client should join on its own. -------------------
  const relay = await startRelay({ port });
  const connected = await waitUntil(() => opens >= 1);
  check("client connects once the relay appears", connected, `opens=${opens}`);

  // --- It's functional: an observer sees ada's message. --------------------
  const observer = new RoomClient(url, "lobby", "bob");
  observer.on("error", () => {});
  observer.connect();
  await nextOpen(observer);

  client.send("back online");
  const delivered = await waitUntil(() =>
    observer.entries().some((e: Entry) => e.author === "ada" && e.value === "back online"),
  );
  check("message after reconnect reaches peers", delivered, observer.entries().map((e) => `${e.author}:${e.value}`).join(" | "));

  // --- Intentional close must NOT reconnect. -------------------------------
  const opensBefore = opens;
  const reconnBefore = reconnecting;
  client.close();
  await wait(400);
  check("intentional close does not reconnect", opens === opensBefore && reconnecting === reconnBefore, `opens ${opensBefore}->${opens}, reconnecting ${reconnBefore}->${reconnecting}`);

  observer.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
