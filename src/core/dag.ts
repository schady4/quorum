// Layer 2 — the DAG commit ledger. When a line of thought concludes, the
// converged surface is snapshotted into a content-addressed node. Branches
// merge three-way against a common ancestor: non-overlapping edits reconcile
// mechanically (zero inference); only genuine semantic collisions escalate to a
// single AI arbitration call.
//
// M0: port from the sibling repo (multiplayer-ai/src/DagMergePoc.jsx). Swap the
// toy djb2 content hash for a real hash (SHA-256) once the DAG persists across
// sessions. Placeholder below fixes the node shape.

export interface DagNode {
  /** Content address of this node. */
  hash: string;
  /** Parent hashes (two on a merge, one on a normal commit, none at root). */
  parents: string[];
  /** Snapshot of the converged surface at commit time. */
  snapshot: string;
  author: string;
  timestamp: number;
}

export interface MergeResult {
  merged: string;
  /** True when a semantic collision needs AI arbitration (M4). */
  needsArbitration: boolean;
  /** The conflicting spans, when needsArbitration. */
  conflicts?: { base: string; a: string; b: string }[];
}

export function threeWayMerge(_base: DagNode, _a: DagNode, _b: DagNode): MergeResult {
  throw new Error("threeWayMerge(): ported in M0 from multiplayer-ai DagMergePoc");
}
