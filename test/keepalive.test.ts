// Integration proof of relay keepalive + handle-uniqueness: two different
// clients can't hold the same handle at once (the newcomer is refused), a
// handle frees up when its holder leaves, and the ping/pong heartbeat leaves
// healthy clients connected. Offline; no model keys.
// Run with `npm run test:keepalive`.

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

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await wait(25);
  }
  return cond();
}

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  const obs = new RoomClient(url, "lobby", "obs");
  obs.on("error", () => {});
  obs.connect();
  await nextOpen(obs);

  // --- A different client cannot steal a live handle. ----------------------
  const a = new RoomClient(url, "lobby", "dup");
  a.on("error", () => {});
  a.connect();
  await nextOpen(a);
  await waitUntil(() => obs.participants.includes("dup"));

  const b = new RoomClient(url, "lobby", "dup"); // new instance -> different clientId
  let denied = "";
  b.on("denied", (r) => (denied = r));
  b.on("error", () => {});
  b.connect();
  await waitUntil(() => denied !== "");
  check("a different client is refused a live handle", /in use/.test(denied), `reason="${denied}"`);

  a.send("still here");
  const stillThere = await waitUntil(() => obs.entries().some((e: Entry) => e.author === "dup" && e.value === "still here"));
  check("the original handle-holder is unaffected", stillThere);
  check("roster shows the handle exactly once", obs.participants.filter((p) => p === "dup").length === 1, obs.participants.join(","));

  // --- A handle frees up once its holder leaves. ---------------------------
  const solo1 = new RoomClient(url, "lobby", "solo");
  solo1.on("error", () => {});
  solo1.connect();
  await nextOpen(solo1);
  await waitUntil(() => obs.participants.includes("solo"));
  solo1.close();
  await waitUntil(() => !obs.participants.includes("solo"));

  const solo2 = new RoomClient(url, "lobby", "solo"); // different client, handle now free
  let solo2Denied = false;
  solo2.on("denied", () => (solo2Denied = true));
  solo2.on("error", () => {});
  solo2.connect();
  await nextOpen(solo2);
  const solo2Joined = await waitUntil(() => obs.participants.includes("solo"));
  check("a vacated handle can be reclaimed", solo2Joined && !solo2Denied, `joined=${solo2Joined} denied=${solo2Denied}`);

  a.close();
  b.close();
  solo2.close();
  obs.close();
  await relay.close();

  // --- Keepalive does not kill healthy clients. ----------------------------
  const fast = await startRelay({ port: 0, heartbeatMs: 80 });
  const furl = `ws://localhost:${fast.port}`;
  const h1 = new RoomClient(furl, "lobby", "h1");
  const h2 = new RoomClient(furl, "lobby", "h2");
  let h1opens = 0;
  h1.on("open", () => h1opens++);
  h1.on("error", () => {});
  h2.on("error", () => {});
  h1.connect();
  h2.connect();
  await Promise.all([nextOpen(h1), nextOpen(h2)]);

  await wait(400); // ~5 heartbeat beats — a healthy client auto-pongs and survives

  h1.send("alive after heartbeats");
  const survived = await waitUntil(() => h2.entries().some((e: Entry) => e.author === "h1" && e.value === "alive after heartbeats"));
  check("healthy clients survive the heartbeat", survived && h1opens === 1, `survived=${survived} opens=${h1opens}`);

  h1.close();
  h2.close();
  await fast.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
