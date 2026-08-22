// Message timestamps + the room-summary endpoint. Proves an op now carries the
// author's wall-clock time through to entries, and that a client can learn each
// room's activity (op count + last time/author) over HTTP without opening a
// socket — metadata only, auth-gated. Offline; no model keys. Run: npm run test:summary.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import { deriveAuthToken } from "../src/net/crypto.js";
import { roomSummaries } from "../src/net/summary.js";
import { blobBaseUrl } from "../src/net/blob.js";

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

async function main(): Promise<void> {
  const token = deriveAuthToken(SECRET);
  const relay = await startRelay({ port: 0, authToken: token });
  const url = `ws://localhost:${relay.port}`;
  const base = blobBaseUrl(url);

  const ada = new RoomClient(url, "lobby", "ada", SECRET);
  ada.on("error", () => {});
  ada.connect();
  await nextOpen(ada);

  const before = Date.now();
  ada.send("first");
  ada.send("second");
  await waitUntil(() => ada.entries().length === 2);
  const after = Date.now();

  // Timestamps: entries now carry a plausible wall-clock ts.
  const entries = ada.entries();
  check("entries carry a timestamp", typeof entries[0].ts === "number");
  check("the timestamp is the author's send time", entries[0].ts! >= before && entries[1].ts! <= after);
  check("timestamps are display metadata, order is still causal", entries[0].value === "first" && entries[1].value === "second");

  // Summary: op count + last activity, without a second socket.
  const sum = await roomSummaries(base, ["lobby", "empty-room"], token);
  check("summary reports the room's op count", sum["lobby"].count === 2);
  check("summary reports the last author", sum["lobby"].lastAuthor === "ada");
  check("summary reports a last timestamp", typeof sum["lobby"].lastTs === "number");
  check("an unknown room summarizes as empty", sum["empty-room"].count === 0);

  // Auth gate.
  let forbidden = false;
  try { await roomSummaries(base, ["lobby"]); } catch { forbidden = true; }
  check("summary without the auth token is refused", forbidden);

  // Content stays private — the summary never carries message text.
  check("the summary carries no message content", !JSON.stringify(sum).includes("first") && !JSON.stringify(sum).includes("second"));

  ada.close();
  await relay.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
