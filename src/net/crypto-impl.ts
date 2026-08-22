// The Node crypto backend — native `node:crypto`, fast. Loaded on the server and
// CLI. A React Native / browser bundle is redirected away from this file (to
// crypto-impl.native.ts) so `node:crypto` is never pulled into a mobile bundle.

import { scryptSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { CryptoBackend } from "./crypto-backend.js";

export const backend: CryptoBackend = {
  scrypt: (secret, salt, dkLen) => new Uint8Array(scryptSync(Buffer.from(secret), Buffer.from(salt), dkLen)),
  hkdf: (ikm, salt, info, len) => new Uint8Array(hkdfSync("sha256", Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), len)),
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
  aesGcmSeal: (key, iv, plaintext) => {
    const c = createCipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
    const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
    return { ct: new Uint8Array(ct), tag: new Uint8Array(c.getAuthTag()) };
  },
  aesGcmOpen: (key, iv, tag, ct) => {
    const d = createDecipheriv("aes-256-gcm", Buffer.from(key), Buffer.from(iv));
    d.setAuthTag(Buffer.from(tag));
    return new Uint8Array(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
  },
};
