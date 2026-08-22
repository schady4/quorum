// The React Native / browser crypto backend — audited pure-JS @noble, no
// `node:crypto`, so it bundles cleanly for mobile and web. A bundler is
// redirected here from crypto-impl.ts by the "react-native"/"browser" fields in
// package.json. Outputs match the Node backend byte-for-byte (scrypt RFC 7914
// defaults, HKDF-SHA256, AES-256-GCM), so a phone interoperates with a laptop.

import { scrypt } from "@noble/hashes/scrypt.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import type { CryptoBackend } from "./crypto-backend.js";

export const backend: CryptoBackend = {
  scrypt: (secret, salt, dkLen) => scrypt(secret, salt, { N: 16384, r: 8, p: 1, dkLen }),
  hkdf: (ikm, salt, info, len) => hkdf(sha256, ikm, salt, info, len),
  randomBytes: (n) => nobleRandomBytes(n),
  aesGcmSeal: (key, iv, plaintext) => {
    const out = gcm(key, iv).encrypt(plaintext); // ciphertext with the 16-byte tag appended
    return { ct: out.slice(0, out.length - 16), tag: out.slice(out.length - 16) };
  },
  aesGcmOpen: (key, iv, tag, ct) => {
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0);
    combined.set(tag, ct.length);
    return gcm(key, iv).decrypt(combined);
  },
};
