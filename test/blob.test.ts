// The blob channel: large attachments sealed on the client, stored by the relay
// as opaque bytes, fetched and opened by a peer with the room key. Proves the
// relay stays zero-knowledge (it holds ciphertext), the round-trip recovers the
// original bytes, content-addressing works, and the auth gate + size cap hold.
// Offline; no model keys. Run with `npm run test:blob`.

import { startRelay } from "../src/relay/server.js";
import { roomCrypto, deriveAuthToken } from "../src/net/crypto.js";
import { putBlob, getBlob, blobBaseUrl, blobId, AUTH_HEADER } from "../src/net/blob.js";

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

const SECRET = "correct horse battery";
const ROOM = "lobby";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 2654435761) & 0xff;
  return b;
}

async function main(): Promise<void> {
  const token = deriveAuthToken(SECRET);
  const relay = await startRelay({ port: 0, authToken: token, maxBlobBytes: 1024 });
  const base = blobBaseUrl(`ws://localhost:${relay.port}`);
  const crypto = roomCrypto(SECRET, ROOM);

  // Seal a "file" and upload it.
  const original = randomBytes(600);
  const sealed = crypto.encBytes(original);
  check("sealing changes the bytes", sealed.length !== original.length || !sealed.every((v, i) => v === original[i]));

  const id = await putBlob(base, ROOM, sealed, token);
  check("the id is the content hash of the ciphertext", id === blobId(sealed));

  // What the relay hands back is the SEALED bytes — it never saw plaintext.
  const fetched = await getBlob(base, ROOM, id, token);
  check("the relay returns exactly the sealed bytes", fetched.length === sealed.length && fetched.every((v, i) => v === sealed[i]));
  const looksLikePlaintext = fetched.length === original.length && fetched.every((v, i) => v === original[i]);
  check("the stored blob is ciphertext, not plaintext", !looksLikePlaintext);

  // A peer with the key opens it back to the original.
  const opened = crypto.decBytes(fetched);
  check("decBytes recovers the original file", opened.length === original.length && opened.every((v, i) => v === original[i]));

  // Content addressing: an unknown id 404s.
  let missing = false;
  try {
    await getBlob(base, ROOM, "deadbeef".repeat(8), token);
  } catch {
    missing = true;
  }
  check("an unknown blob id is not found", missing);

  // Auth gate: no token → forbidden.
  let forbidden = false;
  try {
    await putBlob(base, ROOM, crypto.encBytes(randomBytes(10)));
  } catch {
    forbidden = true;
  }
  check("upload without the auth token is refused", forbidden);

  // Size cap: over maxBlobBytes → rejected.
  let tooLarge = false;
  try {
    await putBlob(base, ROOM, randomBytes(4096), token);
  } catch {
    tooLarge = true;
  }
  check("a blob over the size cap is rejected", tooLarge);

  await relay.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
