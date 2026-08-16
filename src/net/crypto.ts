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
// Only content is encrypted. Structural metadata — op ids, causal `after`
// pointers, author handles, branch names, decision keys — stays plaintext so
// the relay can order and dedupe, and the three-way merge can still compare
// keys. Who is in the room and how much they say is not hidden; what they say
// is. An open room (no key) uses the identity transform, unchanged from before.

import { scryptSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";

const MASTER_SALT = Buffer.from("quorum/v1");
const PREFIX = "e1:"; // versioned sealed-blob marker

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

function master(secret: string): Buffer {
  // scrypt first so a human-chosen key still costs work to attack; HKDF then
  // splits the master into independent subkeys.
  return scryptSync(secret, MASTER_SALT, 32);
}

function sub(m: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", m, MASTER_SALT, Buffer.from(info), 32));
}

/** The relay-side token for a secret — what `quorum host` configures the relay
 *  with. Room-independent, so one key gates every room on the relay. */
export function deriveAuthToken(secret: string | undefined): string {
  if (!secret) return "";
  return sub(master(secret), "auth").toString("base64url");
}

/** Build the full crypto for a room from the shared secret. */
export function roomCrypto(secret: string | undefined, room: string): RoomCrypto {
  if (!secret) return OPEN_ROOM;
  const m = master(secret);
  const authToken = sub(m, "auth").toString("base64url");
  const encKey = sub(m, `enc:${room}`);
  return {
    authToken,
    enc(plain: string): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", encKey, iv);
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      const tag = c.getAuthTag();
      return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
    },
    dec(blob: string): string {
      if (!blob.startsWith(PREFIX)) return blob; // tolerate plaintext (open peer)
      const raw = Buffer.from(blob.slice(PREFIX.length), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ct = raw.subarray(28);
      const d = createDecipheriv("aes-256-gcm", encKey, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    },
  };
}

/** Constant-time token comparison for the relay's join gate. An empty configured
 *  token means the relay is open — every join passes. */
export function authMatches(configured: string | undefined, provided: string | undefined): boolean {
  if (!configured) return true;
  if (typeof provided !== "string") return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
