// Room crypto — the single-secret basis for both auth and end-to-end encryption.
//
// Friends share ONE secret K (the room key). From it each client derives, with
// no further coordination:
//   - an auth token   — room-independent, sent to the relay to pass the join
//                       gate. A one-way derivation, so a relay that holds it
//                       cannot recover K or the encryption key.
//   - an encryption key — per-room, NEVER sent anywhere. Chat and ledger values
//                       are AES-256-GCM sealed with it before they touch the
//                       wire, so the relay is a zero-knowledge mailbox.
//
// The primitives come from a platform backend (crypto-impl.ts on Node, its
// pure-JS twin in React Native / the browser); everything above is portable
// bytes-and-base64, so the same crypto runs on the server, the desktop, and the
// phone, and their outputs interoperate.
//
// Only content is encrypted. Structural metadata — op ids, causal `after`
// pointers, author handles, branch names, decision keys — stays plaintext. An
// open room (no key) uses the identity transform.

import { backend } from "./crypto-impl.js";

const PREFIX = "e1:"; // versioned sealed-blob marker
const te = new TextEncoder();
const td = new TextDecoder();
const utf8 = (s: string): Uint8Array => te.encode(s);
const fromUtf8 = (b: Uint8Array): string => td.decode(b);
const MASTER_SALT = utf8("quorum/v1");

// Portable base64 (btoa/atob are global on Node and in RN/Hermes). Chunked
// String.fromCharCode avoids a stack overflow on large blobs.
function b64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface RoomCrypto {
  /** Room-independent token presented to the relay's join gate. Empty = open. */
  authToken: string;
  /** Seal a plaintext string for the wire. Identity when the room is open. */
  enc(plain: string): string;
  /** Open a sealed blob. Returns plaintext unchanged if it isn't sealed. */
  dec(blob: string): string;
}

/** The open-room transform: no auth, no encryption. */
export const OPEN_ROOM: RoomCrypto = { authToken: "", enc: (s) => s, dec: (s) => s };

function master(secret: string): Uint8Array {
  // scrypt first so a human-chosen key still costs work to attack; HKDF then
  // splits the master into independent subkeys.
  return backend.scrypt(utf8(secret), MASTER_SALT, 32);
}
function sub(m: Uint8Array, info: string): Uint8Array {
  return backend.hkdf(m, MASTER_SALT, utf8(info), 32);
}

/** The relay-side token for a secret — what `quorum host` configures the relay
 *  with. Room-independent, so one key gates every room on the relay. */
export function deriveAuthToken(secret: string | undefined): string {
  if (!secret) return "";
  return b64url(sub(master(secret), "auth"));
}

/** Build the full crypto for a room from the shared secret. */
export function roomCrypto(secret: string | undefined, room: string): RoomCrypto {
  if (!secret) return OPEN_ROOM;
  const m = master(secret);
  const authToken = b64url(sub(m, "auth"));
  const encKey = sub(m, `enc:${room}`);
  return {
    authToken,
    enc(plain: string): string {
      const iv = backend.randomBytes(12);
      const { ct, tag } = backend.aesGcmSeal(encKey, iv, utf8(plain));
      const blob = new Uint8Array(iv.length + tag.length + ct.length);
      blob.set(iv, 0);
      blob.set(tag, iv.length);
      blob.set(ct, iv.length + tag.length);
      return PREFIX + b64(blob);
    },
    dec(blob: string): string {
      if (!blob.startsWith(PREFIX)) return blob; // tolerate plaintext (open peer)
      const raw = unb64(blob.slice(PREFIX.length));
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ct = raw.subarray(28);
      return fromUtf8(backend.aesGcmOpen(encKey, iv, tag, ct));
    },
  };
}

/** Constant-time token comparison for the relay's join gate. An empty configured
 *  token means the relay is open — every join passes. */
export function authMatches(configured: string | undefined, provided: string | undefined): boolean {
  if (!configured) return true;
  if (typeof provided !== "string" || provided.length !== configured.length) return false;
  let diff = 0;
  for (let i = 0; i < configured.length; i++) diff |= configured.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
