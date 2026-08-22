// The ephemeral signal channel: a signal fans out to the OTHER members and is
// never stored — a late joiner sees no trace of it, and it doesn't touch the
// chat surface. This is what read receipts and typing indicators ride on.
// Offline; no model keys. Run with `npm run test:signal`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";

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

  const ada = new RoomClient(url, "lobby", "ada");
  const bob = new RoomClient(url, "lobby", "bob");
  ada.on("error", () => {});
  bob.on("error", () => {});

  const received: { sig: string; from: string; data: unknown }[] = [];
  bob.on("signal", (m) => received.push(m));
  let adaHeardOwn = false;
  ada.on("signal", () => (adaHeardOwn = true));

  ada.connect();
  bob.connect();
  await Promise.all([nextOpen(ada), nextOpen(bob)]);
  await waitUntil(() => ada.participants.length === 2 && bob.participants.length === 2);

  // ada signals typing; bob should hear it, ada should not hear her own.
  ada.signal("typing", { on: true });
  await waitUntil(() => received.length === 1);

  check("a signal reaches the other member", received.length === 1);
  check("it carries the sender handle", received[0]?.from === "ada");
  check("it carries the kind", received[0]?.sig === "typing");
  check("it carries the data payload", (received[0]?.data as any)?.on === true);
  check("the sender does not receive their own signal", adaHeardOwn === false);

  // A read receipt is just another signal — same path.
  ada.signal("read", { upTo: "op-42" });
  await waitUntil(() => received.length === 2);
  check("a second signal kind also fans out", received[1]?.sig === "read" && (received[1]?.data as any)?.upTo === "op-42");

  // Signals are ephemeral: a fresh joiner's welcome carries no trace, and the
  // chat surface is untouched by all this signaling.
  const cass = new RoomClient(url, "lobby", "cass");
  cass.on("error", () => {});
  let cassSignals = 0;
  cass.on("signal", () => cassSignals++);
  cass.connect();
  await nextOpen(cass);
  await wait(100);
  check("a late joiner replays no past signals", cassSignals === 0);
  check("no signal ever became a chat message", ada.entries().length === 0 && bob.entries().length === 0);

  ada.close();
  bob.close();
  cass.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
