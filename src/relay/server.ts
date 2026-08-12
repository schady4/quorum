// The chat backbone — a small, self-hostable relay. It broadcasts CRDT ops
// between the terminals in a room and holds the DAG session ledger. It is
// deliberately dumb: convergence is the CRDT math on each replica, not
// something the server computes. Run your own, or point at a shared one.
//
// M1: implement over WebSocket. Placeholder below fixes the wire message shape.

import type { Op } from "../core/crdt.js";

export type RoomMessage =
  | { t: "op"; room: string; op: Op }
  | { t: "join"; room: string; handle: string }
  | { t: "leave"; room: string; handle: string }
  | { t: "presence"; room: string; participants: string[] };

export interface RelayOptions {
  port: number;
}

export function startRelay(_opts: RelayOptions): never {
  throw new Error("startRelay(): implemented in M1");
}
