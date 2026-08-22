// The blob channel — how large attachments move without breaking the relay's
// zero-knowledge property or bloating the CRDT log.
//
// A file's bytes are sealed with the room key ON THE CLIENT, then uploaded to
// the relay's blob store keyed by the sha256 of the *ciphertext*. The chat
// message carries only a small reference {blobId, name, mime, size}; a receiver
// fetches the ciphertext by id and opens it with the same room key. The relay
// only ever holds opaque sealed bytes it cannot read — same guarantee as the
// message stream — and the durable op log stays tiny.
//
// Pure `fetch` + @noble hashing, so this is isomorphic: identical on Node, the
// browser, and React Native.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const AUTH_HEADER = "x-quorum-auth";

/** Derive the relay's HTTP(S) base from its WebSocket URL (ws->http, wss->https).
 *  The blob store lives on the same host/port as the room socket. */
export function blobBaseUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

/** Content address for a sealed blob — the id it's stored and fetched under. */
export function blobId(sealed: Uint8Array): string {
  return bytesToHex(sha256(sealed));
}

function blobUrl(base: string, room: string, id: string): string {
  return `${base}/blob/${encodeURIComponent(room)}/${encodeURIComponent(id)}`;
}

/** Upload sealed bytes. Idempotent: re-putting the same id is a no-op server-side.
 *  Returns the id (content hash) the blob is stored under. */
export async function putBlob(base: string, room: string, sealed: Uint8Array, authToken?: string): Promise<string> {
  const id = blobId(sealed);
  const res = await fetch(blobUrl(base, room, id), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...(authToken ? { [AUTH_HEADER]: authToken } : {}) },
    body: sealed,
  });
  if (!res.ok) throw new Error(`blob upload failed (${res.status})`);
  return id;
}

/** Fetch sealed bytes by id. Throws if the relay doesn't have them. */
export async function getBlob(base: string, room: string, id: string, authToken?: string): Promise<Uint8Array> {
  const res = await fetch(blobUrl(base, room, id), {
    headers: { ...(authToken ? { [AUTH_HEADER]: authToken } : {}) },
  });
  if (!res.ok) throw new Error(`blob not found (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
