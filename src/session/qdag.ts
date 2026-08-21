// The bond — a portable, revivable save of a room's DAG. It binds the roster
// and the complete decision-DAG (branches, merges, provenance) together with the
// message thread, small enough to hand around, and end-to-end sealed so only
// someone with the room key can open it.
//
// Why it's small: a *live* room is an op log fat with CRDT plumbing (op ids,
// causal `after` pointers, clientId prefixes) that exists only to let concurrent
// edits converge. A *finished* save has nothing left to merge against, so we
// keep only the materialized result — messages in converged order + the
// replayable ledger-op sequence (which reconstructs the exact branch/merge DAG)
// — then intern repeated strings, gzip, and seal once. Reviving reassigns fresh
// ids, so a decoded bond replays cleanly onto a new room.

import { gzipSync, gunzipSync } from "node:zlib";
import { roomCrypto } from "../net/crypto.js";
import { ROOT, type Entry, type InsertOp } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";

const MAGIC = "QDAG1";

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

// --- compact (interned + columnar) representation ----------------------------

interface Compact {
  v: 1;
  room: string;
  created: number;
  dict: string[];
  roster: number[];
  msgs: [number, string][]; // [authorIdx, text]
  led: unknown[];
}

function compact(session: Session): Compact {
  const dict: string[] = [];
  const idx = (s: string): number => {
    let i = dict.indexOf(s);
    if (i < 0) {
      i = dict.length;
      dict.push(s);
    }
    return i;
  };
  const roster = session.roster.map(idx);
  const msgs = session.messages.map((m) => [idx(m.author), m.text] as [number, string]);
  const led = session.ledger.map((op) => {
    if (op.type === "fork") return [0, op.branches.map(idx)];
    if (op.type === "edit") return [1, idx(op.branch), idx(op.key), op.value, idx(op.author)];
    const resolved = Object.entries(op.resolved).map(([k, v]) => [idx(k), v]);
    return [2, [idx(op.branches[0]), idx(op.branches[1])], resolved, idx(op.author), op.viaArbitration ? 1 : 0, op.rationale ?? null];
  });
  return { v: 1, room: session.room, created: session.created, dict, roster, msgs, led };
}

function expand(c: Compact): Session {
  const d = c.dict;
  const ledger: LedgerOpBody[] = c.led.map((raw) => {
    const a = raw as unknown[];
    const kind = a[0] as number;
    if (kind === 0) return { type: "fork", branches: (a[1] as number[]).map((i) => d[i]) };
    if (kind === 1) return { type: "edit", branch: d[a[1] as number], key: d[a[2] as number], value: a[3] as string, author: d[a[4] as number] };
    const [ai, bi] = a[1] as [number, number];
    const resolved: Record<string, string> = {};
    for (const [ki, v] of a[2] as [number, string][]) resolved[d[ki]] = v;
    const rationale = a[5] as string | null;
    return {
      type: "merge",
      branches: [d[ai], d[bi]],
      resolved,
      author: d[a[3] as number],
      viaArbitration: a[4] === 1,
      ...(rationale != null ? { rationale } : {}),
    };
  });
  return {
    room: c.room,
    created: c.created,
    roster: c.roster.map((i) => d[i]),
    messages: c.msgs.map(([ai, t]) => ({ author: d[ai], text: t })),
    ledger,
  };
}

// --- the on-disk container (a portable JSON envelope) ------------------------

/** Encode a session to a `.qdag` save. With `key`, the body is gzipped then
 *  AES-256-GCM sealed — encrypted at rest, openable only with the room key. */
export function encodeSave(session: Session, key?: string): string {
  const gzB64 = gzipSync(Buffer.from(JSON.stringify(compact(session)), "utf8")).toString("base64");
  const sealed = key != null && key !== "";
  const body = sealed ? roomCrypto(key, session.room).enc(gzB64) : gzB64;
  return JSON.stringify({ magic: MAGIC, room: session.room, created: session.created, sealed, body });
}

/** Decode a `.qdag` save. A sealed save needs the room key. */
export function decodeSave(file: string, key?: string): Session {
  const env = JSON.parse(file) as { magic: string; room: string; sealed: boolean; body: string };
  if (env.magic !== MAGIC) throw new Error("not a Quorum save (bad magic)");
  if (env.sealed && (key == null || key === "")) throw new Error("this save is encrypted — provide the room key to open it");
  const gzB64 = env.sealed ? roomCrypto(key as string, env.room).dec(env.body) : env.body;
  const c = JSON.parse(gunzipSync(Buffer.from(gzB64, "base64")).toString("utf8")) as Compact;
  return expand(c);
}

// --- revival: regenerate live frames from a decoded session ------------------

/** Rebuild op frames from a session, with fresh ids, so a bond can be replayed
 *  onto a new room. Messages keep their original authors (that's the point of a
 *  bond); the ledger DAG replays in order. `site` namespaces the fresh ids so a
 *  revive never collides with another. */
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
