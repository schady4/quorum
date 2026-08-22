// The bond — a portable, revivable save of a room's DAG. It binds the roster
// and the complete decision-DAG (branches, merges, provenance) together with the
// message thread, end-to-end sealed so only someone with the room key can open
// it.
//
// Chunked by design, so a huge session (AI seats generate volume) never has to
// be gzipped, sealed, or loaded in one shot. The save is NDJSON:
//
//   line 1   manifest  { magic, room, created, sealed, roster, ledger }
//   line 2…  chunks    { i, n, hash, body }   each an independently sealed,
//                                             integrity-hashed slice of messages
//
// The decision-DAG (ledger) is tiny and lives whole in the manifest; only the
// unbounded message stream is chunked. Encode streams a chunk at a time, decode
// verifies + opens a chunk at a time, revive replays a chunk at a time — peak
// memory is one chunk regardless of total size.
//
// Why a save is small: a live room's op log is fat with CRDT plumbing (op ids,
// causal `after` pointers, clientId prefixes) that exists only so concurrent
// edits converge. A finished save has nothing to merge against, so we keep only
// the materialized result — messages in converged order + the replayable ledger
// ops (which reconstruct the exact branch/merge DAG) — gzip each chunk, seal it.
// Reviving reassigns fresh ids, so a decoded bond replays cleanly onto a new room.

import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { roomCrypto, type RoomCrypto } from "../net/crypto.js";
import { ROOT, type Entry, type InsertOp } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";

const MAGIC = "QDAG2";
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024; // ~4 MB of message text per chunk

/** A ledger op without its id — ids are live-only and reassigned on revive. */
export type LedgerOpBody =
  | Omit<Extract<LedgerOp, { type: "fork" }>, "id">
  | Omit<Extract<LedgerOp, { type: "edit" }>, "id">
  | Omit<Extract<LedgerOp, { type: "merge" }>, "id">;

/** The materialized session a bond carries. */
export interface Session {
  room: string;
  created: number;
  /** Who was on the DAG — "binds the users". */
  roster: string[];
  /** Messages in converged order (plaintext). */
  messages: { author: string; text: string }[];
  /** The replayable decision-DAG history (ids stripped). */
  ledger: LedgerOpBody[];
}

export interface SaveOptions {
  /** Room secret; when set, the ledger and every chunk are sealed at rest. */
  key?: string;
  /** Max plaintext bytes of messages per chunk (default ~4 MB). */
  maxChunkBytes?: number;
}

/** Anything shaped like a joined RoomClient — duck-typed so this module never
 *  imports the client (and stays trivially testable). */
export interface SessionSource {
  room: string;
  participants: string[];
  entries(): Entry[];
  ledgerOps(): LedgerOp[];
}

/** Materialize a session from a live client (or anything shaped like one). */
export function sessionFromClient(src: SessionSource): Session {
  const stripId = (op: LedgerOp): LedgerOpBody => {
    const { id: _id, ...body } = op;
    return body as LedgerOpBody;
  };
  return {
    room: src.room,
    created: Date.now(),
    roster: [...src.participants],
    messages: src.entries().map((e) => ({ author: e.author, text: e.value })),
    ledger: src.ledgerOps().map(stripId),
  };
}

// --- container primitives ----------------------------------------------------

interface Manifest {
  magic: string;
  room: string;
  created: number;
  sealed: boolean;
  roster: string[];
  ledger: string; // packed body of the ledger ops
}
interface Chunk {
  i: number;
  n: number;
  hash: string;
  body: string;
}

// The room crypto is built ONCE per save/read and threaded through, not
// reconstructed per chunk (its scrypt derivation is deliberately expensive).
/** Pack raw bytes for storage: gzip, base64, and (when keyed) AES-256-GCM seal. */
function packBody(raw: Buffer, crypto: RoomCrypto): string {
  return crypto.enc(gzipSync(raw).toString("base64"));
}
/** The inverse of packBody. */
function unpackBody(body: string, crypto: RoomCrypto): Buffer {
  return gunzipSync(Buffer.from(crypto.dec(body), "base64"));
}
function hash16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Split messages into byte-bounded slices without materializing all of them. */
function* chunkMessages(messages: Iterable<{ author: string; text: string }>, maxBytes: number): Generator<{ author: string; text: string }[]> {
  let buf: { author: string; text: string }[] = [];
  let size = 0;
  for (const m of messages) {
    const s = m.author.length + m.text.length + 8;
    if (buf.length && size + s > maxBytes) {
      yield buf;
      buf = [];
      size = 0;
    }
    buf.push(m);
    size += s;
  }
  if (buf.length) yield buf;
}

// --- encode ------------------------------------------------------------------

/** Stream a session out as NDJSON lines (one chunk sealed at a time). Point
 *  `emit` at a file/stream to save arbitrarily large sessions in bounded memory. */
export function writeSave(session: Session, emit: (line: string) => void, opts: SaveOptions = {}): void {
  const { key, maxChunkBytes = DEFAULT_CHUNK_BYTES } = opts;
  const sealed = key != null && key !== "";
  const room = session.room;
  const crypto = roomCrypto(key, room);
  const ledger = packBody(Buffer.from(JSON.stringify(session.ledger), "utf8"), crypto);
  const manifest: Manifest = { magic: MAGIC, room, created: session.created, sealed, roster: session.roster, ledger };
  emit(JSON.stringify(manifest));
  let i = 0;
  for (const slice of chunkMessages(session.messages, maxChunkBytes)) {
    const raw = Buffer.from(JSON.stringify(slice.map((m) => [m.author, m.text])), "utf8");
    const body = packBody(raw, crypto);
    const chunk: Chunk = { i: i++, n: slice.length, hash: hash16(body), body };
    emit(JSON.stringify(chunk));
  }
}

/** Encode a session to a `.qdag` save string. Convenience over `writeSave` for
 *  saves that fit in memory; for very large sessions stream `writeSave` to a file. */
export function encodeSave(session: Session, key?: string): string {
  const lines: string[] = [];
  writeSave(session, (l) => lines.push(l), { key });
  return lines.join("\n");
}

// --- decode ------------------------------------------------------------------

function parseManifest(line: string, key?: string): Manifest {
  const man = JSON.parse(line) as Manifest;
  if (man.magic !== MAGIC) throw new Error("not a Quorum save (bad magic)");
  if (man.sealed && (key == null || key === "")) throw new Error("this save is encrypted — provide the room key to open it");
  return man;
}

/** Decode a whole `.qdag` save into a Session. For very large saves prefer
 *  `streamFrames`, which never holds more than one chunk. */
export function decodeSave(file: string, key?: string): Session {
  const lines = file.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("empty save");
  const man = parseManifest(lines[0], key);
  const crypto = roomCrypto(key, man.room);
  const ledger = JSON.parse(unpackBody(man.ledger, crypto).toString("utf8")) as LedgerOpBody[];
  const messages: { author: string; text: string }[] = [];
  for (let li = 1; li < lines.length; li++) {
    const c = JSON.parse(lines[li]) as Chunk;
    if (hash16(c.body) !== c.hash) throw new Error(`save chunk ${c.i} failed its integrity check`);
    const slice = JSON.parse(unpackBody(c.body, crypto).toString("utf8")) as [string, string][];
    for (const [a, t] of slice) messages.push({ author: a, text: t });
  }
  return { room: man.room, created: man.created, roster: man.roster, messages, ledger };
}

/** Read just a save's manifest — room, roster, and the decrypted ledger DAG —
 *  without touching the message chunks. Validates the key cheaply (the ledger
 *  unpack throws on the wrong one), so a caller can check access before streaming. */
export function readManifest(file: string, key?: string): { room: string; created: number; roster: string[]; ledger: LedgerOpBody[]; sealed: boolean } {
  const nl = file.indexOf("\n");
  const firstLine = nl === -1 ? file : file.slice(0, nl);
  const man = parseManifest(firstLine, key);
  const ledger = JSON.parse(unpackBody(man.ledger, roomCrypto(key, man.room)).toString("utf8")) as LedgerOpBody[];
  return { room: man.room, created: man.created, roster: man.roster, ledger, sealed: man.sealed };
}

// --- revive ------------------------------------------------------------------

/** Rebuild op frames from an in-memory session, with fresh ids, so a bond can be
 *  replayed onto a new room. Messages keep their original authors; the ledger
 *  DAG replays in order. `site` namespaces the fresh ids so revives never clash. */
export function framesFrom(session: Session, site = "revive"): { ops: InsertOp[]; ledgerOps: LedgerOp[] } {
  const ops: InsertOp[] = [];
  let after = ROOT;
  session.messages.forEach((m, i) => {
    const id = `${site}:${i + 1}`;
    ops.push({ type: "insert", id, after, value: m.text, author: m.author });
    after = id;
  });
  const ledgerOps = session.ledger.map((body, i) => ({ ...body, id: `${site}L:${i + 1}` }) as LedgerOp);
  return { ops, ledgerOps };
}

/** Stream revival frames from a `.qdag` save's lines, one chunk at a time —
 *  bounded memory for any size. `emit` is called with the ledger frames once,
 *  then with a batch of message ops per chunk, in order. */
export function streamFrames(lines: Iterable<string>, opts: { key?: string } = {}, emit: (frames: { ops?: InsertOp[]; ledgerOps?: LedgerOp[] }) => void, site = "revive"): void {
  const it = lines[Symbol.iterator]();
  const first = it.next();
  if (first.done) throw new Error("empty save");
  const man = parseManifest(first.value, opts.key);
  const crypto = roomCrypto(opts.key, man.room);
  const ledger = JSON.parse(unpackBody(man.ledger, crypto).toString("utf8")) as LedgerOpBody[];
  emit({ ledgerOps: ledger.map((body, i) => ({ ...body, id: `${site}L:${i + 1}` }) as LedgerOp) });

  let after = ROOT;
  let n = 0;
  for (let r = it.next(); !r.done; r = it.next()) {
    if (!r.value) continue;
    const c = JSON.parse(r.value) as Chunk;
    if (hash16(c.body) !== c.hash) throw new Error(`save chunk ${c.i} failed its integrity check`);
    const slice = JSON.parse(unpackBody(c.body, crypto).toString("utf8")) as [string, string][];
    const ops: InsertOp[] = [];
    for (const [a, t] of slice) {
      const id = `${site}:${++n}`;
      ops.push({ type: "insert", id, after, value: t, author: a });
      after = id;
    }
    emit({ ops });
  }
}
