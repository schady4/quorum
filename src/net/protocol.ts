// The room wire protocol. Deliberately tiny: the relay moves CRDT ops and
// presence, and nothing about convergence lives here — that's the replicas'
// job. Both directions are newline-free JSON frames over one WebSocket.

import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";

/** A durable progress marker: seat `seat` has finished handling chat entry
 *  `handled`. Stored and replayed by the relay like any op, so a seat that
 *  reconnects reconstructs what it already did and resumes instead of
 *  re-answering. Its own concern, kept out of the belief-state ledger. */
export interface CheckpointOp {
  id: string;
  seat: string;
  handled: string;
}

/** client -> server, first frame after connecting. The optional `key` is the
 *  shared room secret; a relay started with a key rejects a hello without the
 *  matching one. Omitted against an open (keyless) relay. */
export interface Hello {
  t: "hello";
  room: string;
  handle: string;
  /** Auth token derived from the room secret (never the secret itself). The
   *  relay gates joins on it; a one-way derivation, so the relay can't recover
   *  the secret or the encryption key. Omitted against an open relay. */
  auth?: string;
  /** Stable per-client id, unchanged across a client's reconnects. Lets the
   *  relay tell a reconnect (same id reclaims its handle) from a collision (a
   *  different client wanting a handle that's already live). */
  clientId?: string;
}

/** server -> client: the join was refused (e.g. wrong or missing room key).
 *  The socket is closed right after; the client should not retry. */
export interface Denied {
  t: "denied";
  reason: string;
}

/** server -> client, the catch-up frame: all op logs + who's here. */
export interface Welcome {
  t: "welcome";
  room: string;
  participants: string[];
  ops: Op[];
  ledgerOps: LedgerOp[];
  checkpointOps: CheckpointOp[];
}

/** either direction: one CRDT (chat surface) op to integrate. */
export interface OpFrame {
  t: "op";
  op: Op;
}

/** either direction: one DAG ledger op (fork / edit / merge). */
export interface LedgerFrame {
  t: "ledger";
  op: LedgerOp;
}

/** either direction: one seat progress checkpoint. */
export interface CheckpointFrame {
  t: "checkpoint";
  op: CheckpointOp;
}

/** server -> clients: the room roster changed. */
export interface Presence {
  t: "presence";
  participants: string[];
}

export type ClientMsg = Hello | OpFrame | LedgerFrame | CheckpointFrame;
export type ServerMsg = Welcome | OpFrame | LedgerFrame | CheckpointFrame | Presence | Denied;

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode(data: string): ClientMsg | ServerMsg {
  return JSON.parse(data) as ClientMsg | ServerMsg;
}
