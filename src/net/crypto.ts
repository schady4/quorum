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
import { base64, base64urlnopad } from "@scure/base";
import { utf8ToBytes, bytesToUtf8 } from "@noble/ciphers/utils.js";

const PREFIX = "e1:"; // versioned sealed-blob marker

// Bytes<->text via the @noble/@scure isomorphic libraries rather than ambient
// globals: `TextEncoder`/`TextDecoder` and `btoa`/`atob` aren't reliably present
// on React Native (Hermes), so we lean on the same pure-JS toolkit that backs
// the crypto. Outputs are identical to the global implementations, so the wire
// format is unchanged and a phone interoperates byte-for-byte with Node.
const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
const fromUtf8 = (b: Uint8Array): string => bytesToUtf8(b);
const MASTER_SALT = utf8("quorum/v1");

/** Standard base64 (padded) — the on-wire sealed-blob encoding. */
function b64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}
function unb64(s: string): Uint8Array {
  return base64.decode(s);
}
/** URL-safe, unpadded base64 — used for the relay auth token. */
function b64url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

export interface RoomCrypto {
  /** Room-independent token presented to the relay's join gate. Empty = open. */
  authToken: string;
  /** Seal a plaintext string for the wire. Identity when the room is open. */
  enc(plain: string): string;
  /** Open a sealed blob. Returns plaintext unchanged if it isn't sealed. */
  dec(blob: string): string;
  /** Seal raw bytes (for binary blobs — file attachments over the blob channel).
   *  Returns iv|tag|ct as bytes. Identity when the room is open. */
  encBytes(plain: Uint8Array): Uint8Array;
  /** Open bytes sealed by encBytes. Identity when the room is open. */
  decBytes(sealed: Uint8Array): Uint8Array;
}

/** The open-room transform: no auth, no encryption. */
export const OPEN_ROOM: RoomCrypto = {
  authToken: "",
  enc: (s) => s,
  dec: (s) => s,
  encBytes: (b) => b,
  decBytes: (b) => b,
};

// scrypt is deliberately slow (RFC 7914 defaults, ~16MB working set) so a
// human-chosen secret costs real work to brute-force. On the pure-JS React
// Native backend (no native scrypt) that cost is real wall-clock time — and
// every roomCrypto() call re-pays it for the same secret, including the
// redundant one RoomClient's constructor makes on top of the app's own. Cache
// the master key per secret so a legitimate repeat call (the common case: the
// same room reopened, or RoomClient re-deriving what the app already has) is
// instant. A wrong guess is still a cache miss and still pays full cost, so
// this doesn't weaken the KDF's brute-force resistance. Bounded + LRU-ish so a
// long-running process doesn't grow this unboundedly.
const MASTER_CACHE_MAX = 32;
const masterCache = new Map<string, Uint8Array>();

function master(secret: string): Uint8Array {
  const cached = masterCache.get(secret);
  if (cached) {
    masterCache.delete(secret); // bump to most-recently-used
    masterCache.set(secret, cached);
    return cached;
  }
  // scrypt first so a human-chosen key still costs work to attack; HKDF then
  // splits the master into independent subkeys.
  const m = backend.scrypt(utf8(secret), MASTER_SALT, 32);
  if (masterCache.size >= MASTER_CACHE_MAX) {
    const oldest = masterCache.keys().next().value;
    if (oldest !== undefined) masterCache.delete(oldest);
  }
  masterCache.set(secret, m);
  return m;
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
    encBytes(plain: Uint8Array): Uint8Array {
      const iv = backend.randomBytes(12);
      const { ct, tag } = backend.aesGcmSeal(encKey, iv, plain);
      const out = new Uint8Array(iv.length + tag.length + ct.length);
      out.set(iv, 0);
      out.set(tag, iv.length);
      out.set(ct, iv.length + tag.length);
      return out;
    },
    decBytes(sealed: Uint8Array): Uint8Array {
      const iv = sealed.subarray(0, 12);
      const tag = sealed.subarray(12, 28);
      const ct = sealed.subarray(28);
      return backend.aesGcmOpen(encKey, iv, tag, ct);
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
