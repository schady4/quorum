// Layer 1 — the CRDT live surface. Every terminal in a room is a replica here;
// concurrent edits converge with no locks and no merge calls. This is what
// unifies a friends-list session into one window even under network lag.
//
// M0: port the RGA-style sequence CRDT out of the sibling repo
// (multiplayer-ai/src/TwoLayerPoc.jsx), stripped of React, with a headless
// convergence test suite. Placeholder below fixes the op shape everything else
// builds against.

/** A globally unique, totally-orderable id for a CRDT node. */
export type OpId = string;

export interface InsertOp {
  type: "insert";
  id: OpId;
  /** id of the left neighbor this node is inserted after (null = head). */
  after: OpId | null;
  value: string;
  author: string;
}

export interface DeleteOp {
  type: "delete";
  id: OpId;
}

export type Op = InsertOp | DeleteOp;

export interface CrdtSurface {
  apply(op: Op): void;
  /** Materialize the converged text. */
  toString(): string;
}

export function createSurface(): CrdtSurface {
  throw new Error("createSurface(): ported in M0 from multiplayer-ai TwoLayerPoc");
}
