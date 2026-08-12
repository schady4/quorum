// The room wire protocol. Deliberately tiny: the relay moves CRDT ops and
// presence, and nothing about convergence lives here — that's the replicas'
// job. Both directions are newline-free JSON frames over one WebSocket.

import type { Op } from "../core/crdt.js";

/** client -> server, first frame after connecting. */
export interface Hello {
  t: "hello";
  room: string;
  handle: string;
}

/** server -> client, the catch-up frame: full op log + who's here. */
export interface Welcome {
  t: "welcome";
  room: string;
  participants: string[];
  ops: Op[];
}

/** either direction: one CRDT op to integrate. */
export interface OpFrame {
  t: "op";
  op: Op;
}

/** server -> clients: the room roster changed. */
export interface Presence {
  t: "presence";
  participants: string[];
}

export type ClientMsg = Hello | OpFrame;
export type ServerMsg = Welcome | OpFrame | Presence;

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode(data: string): ClientMsg | ServerMsg {
  return JSON.parse(data) as ClientMsg | ServerMsg;
}
