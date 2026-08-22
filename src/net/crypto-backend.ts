// The crypto primitives RoomCrypto needs, as raw byte operations — the seam that
// lets the client's encryption run on Node and on the phone/web. The Node build
// backs these with native `node:crypto` (fast); a React Native / browser bundle
// is redirected to crypto-impl.native.ts (audited pure-JS @noble) by the
// "react-native"/"browser" fields in package.json. Both produce the identical
// scrypt/HKDF/AES-256-GCM outputs, so a phone and a laptop in the same room
// derive the same keys and decrypt each other.

export interface CryptoBackend {
  /** scrypt with the RFC 7914 defaults Node uses (N=16384, r=8, p=1). */
  scrypt(secret: Uint8Array, salt: Uint8Array, dkLen: number): Uint8Array;
  /** HKDF-SHA256. */
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Uint8Array;
  randomBytes(n: number): Uint8Array;
  /** AES-256-GCM seal → ciphertext + 16-byte tag (kept separate so the wire
   *  layout is iv|tag|ct on every platform). */
  aesGcmSeal(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): { ct: Uint8Array; tag: Uint8Array };
  /** AES-256-GCM open; throws on a bad tag (wrong key or tampered data). */
  aesGcmOpen(key: Uint8Array, iv: Uint8Array, tag: Uint8Array, ct: Uint8Array): Uint8Array;
}
