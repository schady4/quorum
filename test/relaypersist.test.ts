// Relay persistence: a room's history + blobs survive a relay restart, even with
// nobody online. We run a relay backed by a store, send messages and upload a
// blob, stop the relay, start a FRESH relay on the same store, and prove a new
// joiner catches up to the old messages and the blob is still fetchable. The
// FileRelayStore is exercised on a temp dir, and the stored bytes are ciphertext.
// Run: npm run test:relaypersist.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { FileRelayStore } from "../src/relay/store.js";
import { deriveAuthToken, roomCrypto } from "../src/net/crypto.js";
import { putBlob, getBlob, blobBaseUrl } from "../src/net/blob.js";
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

const SECRET = "correct horse battery";
const CHAT = "persist me across a restart";
const ADA_TOKEN = "ExponentPushToken[ada-device]";
const CASS_TOKEN = "ExponentPushToken[cass-device]";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-relay-"));
  const token = deriveAuthToken(SECRET);

  // --- session 1: write history + a blob, register push/mute, then stop -----
  const store1 = new FileRelayStore(dir);
  const relay1 = await startRelay({ port: 0, authToken: token, store: store1 });
  const base1 = blobBaseUrl(`ws://localhost:${relay1.port}`);
  const crypto = roomCrypto(SECRET, "lobby");

  const ada = new RoomClient(`ws://localhost:${relay1.port}`, "lobby", "ada", SECRET);
  ada.on("error", () => {});
  ada.connect();
  await nextOpen(ada);
  ada.registerPush(ADA_TOKEN); // ada wants pushes, unmuted
  ada.send(CHAT);
  ada.send("second line");
  await waitUntil(() => ada.entries().length === 2);

  // cass registers a token but mutes the room — both should persist.
  const cass = new RoomClient(`ws://localhost:${relay1.port}`, "lobby", "cass", SECRET);
  cass.on("error", () => {});
  cass.connect();
  await nextOpen(cass);
  cass.registerPush(CASS_TOKEN);
  cass.setMuted(true);
  await wait(80);

  const sealed = crypto.encBytes(new Uint8Array([1, 2, 3, 4, 5]));
  const blobId = await putBlob(base1, "lobby", sealed, token);

  ada.close();
  cass.close();
  await wait(80);
  await relay1.close(); // relay is gone; only the store on disk remains

  // The store on disk holds ciphertext, not plaintext.
  const onDisk = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], "log.ndjson"), "utf8");
  check("the persisted log is ciphertext (no plaintext leaked)", !onDisk.includes(CHAT));

  // --- session 2: fresh relay on the SAME store -----------------------------
  const pushes: PushMessage[] = [];
  const store2 = new FileRelayStore(dir);
  const relay2 = await startRelay({ port: 0, authToken: token, store: store2, pushCooldownMs: 0, sendPush: async (m) => { pushes.push(...m); } });
  const base2 = blobBaseUrl(`ws://localhost:${relay2.port}`);

  // A brand-new joiner (who was never here before) catches up to the history.
  const bob = new RoomClient(`ws://localhost:${relay2.port}`, "lobby", "bob", SECRET);
  bob.on("error", () => {});
  bob.connect();
  await nextOpen(bob);
  await waitUntil(() => bob.entries().length === 2);

  const texts = bob.entries().map((e) => e.value);
  check("history survived the restart", bob.entries().length === 2);
  check("messages decrypt correctly after reload", texts[0] === CHAT && texts[1] === "second line");

  // The blob is still fetchable + decryptable after the restart.
  const fetched = await getBlob(base2, "lobby", blobId, token);
  const opened = crypto.decBytes(fetched);
  check("a blob uploaded before the restart is still fetchable", opened.length === 5 && opened[0] === 1 && opened[4] === 5);

  // ada and cass are offline across the restart, but their push/mute state was
  // persisted: bob's message pushes ada (reloaded token) and skips muted cass.
  bob.send("anyone around?");
  await waitUntil(() => pushes.length > 0);
  await wait(100);
  check("a persisted push token still reaches an offline member after restart", pushes.some((p) => p.to === ADA_TOKEN));
  check("a persisted mute still suppresses push after restart", pushes.every((p) => p.to !== CASS_TOKEN));

  bob.close();
  await relay2.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
