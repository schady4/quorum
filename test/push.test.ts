// The relay push service: a disconnected member who registered a device token
// gets a metadata-only push when the room gets a new message. Proves the sender
// is skipped, connected members are skipped, the body carries NO message
// content (zero-knowledge), reconnect re-registers, and the cooldown holds.
// The push sender is injected, so nothing hits the network. Run: npm run test:push.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import type { PushMessage } from "../src/net/push.js";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));
async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (cond()) return true; await wait(25); }
  return cond();
}

const ADA_TOKEN = "ExponentPushToken[ada-device-xyz]";
const SECRET_TEXT = "meet me at the docks at midnight";

async function main(): Promise<void> {
  const pushes: PushMessage[] = [];
  const relay = await startRelay({ port: 0, pushCooldownMs: 0, sendPush: async (msgs) => { pushes.push(...msgs); } });
  const url = `ws://localhost:${relay.port}`;

  // Ada joins, registers a push token, then leaves (goes "offline").
  const ada = new RoomClient(url, "lobby", "ada");
  ada.on("error", () => {});
  ada.connect();
  await nextOpen(ada);
  ada.registerPush(ADA_TOKEN);
  await wait(80); // let the registration land
  ada.close();
  await wait(80);

  // Bob joins and sends a message while ada is offline.
  const bob = new RoomClient(url, "lobby", "bob");
  bob.on("error", () => {});
  bob.connect();
  await nextOpen(bob);
  bob.send(SECRET_TEXT);

  await waitUntil(() => pushes.length > 0);
  check("an offline registered member gets a push", pushes.length === 1);
  check("the push targets ada's device token", pushes[0]?.to === ADA_TOKEN);
  check("the push names the sender (metadata only)", pushes[0]?.body.includes("bob") === true);
  check("the push carries NO message content", !JSON.stringify(pushes[0]).includes("docks"));
  check("the push deep-links to the room", (pushes[0]?.data as any)?.room === "lobby");

  // A connected member is not pushed: ada reconnects (re-registers), bob sends.
  pushes.length = 0;
  ada.connect();
  await nextOpen(ada);
  await waitUntil(() => ada.participants.length === 2);
  await wait(50);
  bob.send("second message");
  await wait(200);
  check("a connected member is NOT pushed", pushes.length === 0);

  // The sender themselves is never pushed even while others are offline.
  pushes.length = 0;
  bob.close();
  await wait(80);
  ada.send("ada talking to herself"); // bob offline, ada is the sender
  await wait(200);
  check("the sender is never pushed", pushes.every((p) => p.to !== ADA_TOKEN));

  // Relay-side mute: ada mutes, goes offline; bob's message must NOT push her.
  ada.setMuted(true);
  await wait(80);
  ada.close();
  await wait(80);
  pushes.length = 0;
  bob.connect();
  await nextOpen(bob);
  bob.send("while ada is muted");
  await wait(200);
  check("a muted, offline member is NOT pushed", pushes.length === 0);

  // Unmute restores delivery.
  ada.setMuted(false);
  ada.connect();
  await nextOpen(ada);
  await wait(80);
  ada.close();
  await wait(80);
  pushes.length = 0;
  bob.send("ada unmuted now");
  await wait(200);
  check("unmuting restores push delivery", pushes.some((p) => p.to === ADA_TOKEN));

  ada.close();
  bob.close();
  await relay.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
