// The room wire protocol. Deliberately tiny: the relay moves CRDT ops and
// presence, and nothing about convergence lives here — that's the replicas'
// job. Both directions are newline-free JSON frames over one WebSocket.

import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";

/** client -> server, first frame after connecting. */
export interface Hello {
  t: "hello";
  room: string;
  handle: string;
}

/** server -> client, the catch-up frame: both op logs + who's here. */
export interface Welcome {
  t: "welcome";
  room: string;
  participants: string[];
  ops: Op[];
  ledgerOps: LedgerOp[];
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

/** server -> clients: the room roster changed. */
export interface Presence {
  t: "presence";
  participants: string[];
}

export type ClientMsg = Hello | OpFrame | LedgerFrame;
export type ServerMsg = Welcome | OpFrame | LedgerFrame | Presence;

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode(data: string): ClientMsg | ServerMsg {
  return JSON.parse(data) as ClientMsg | ServerMsg;
}
