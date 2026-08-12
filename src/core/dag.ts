// Layer 2 — the DAG commit ledger. When a line of thought concludes, the
// converged surface is snapshotted into a content-addressed node. Deliberate
// branches merge three-way against a common ancestor: non-overlapping edits
// reconcile mechanically (zero inference); only genuine semantic collisions —
// two branches changing the same belief incompatibly — escalate to a single AI
// arbitration call (wired in M4).
//
// Ported from the sibling repo (multiplayer-ai/src/DagMergePoc.jsx). The state
// carried by a node is a small key/value "belief store": toy-sized on purpose,
// because the merge logic does not know or care how big the state is — proving
// reconciliation here proves it at scale, only the materials change.
//
// The content-address hash below is a toy djb2 (matching the POC). Swap it for
// a real hash (SHA-256) once the DAG persists across sessions.

export type BeliefState = Record<string, string>;

export type NodeKind = "root" | "edit" | "merge";

export interface DagNode {
  id: string;
  kind: NodeKind;
  /** "trunk" | a seat handle | an AI participant's handle. */
  author: string;
  /** Parent hashes: none at root, one on an edit, two on a merge. */
  parents: string[];
  /** Content address of `state`. */
  hash: string;
  /** Full resolved belief-state at this node. */
  state: BeliefState;
  /** The single key/value that changed vs. the parent, when kind === "edit". */
  delta: { key: string; value: string } | null;
  msg: string;
  timestamp: number;
}

export interface Conflict {
  key: string;
  base: string | undefined;
  a: string | undefined;
  b: string | undefined;
}

export interface MergeResult {
  /** The mechanically merged state; conflicted keys hold the ancestor value. */
  merged: BeliefState;
  /** Non-empty when two branches changed the same key incompatibly. */
  conflicts: Conflict[];
  /** True when `conflicts` is non-empty — i.e. AI arbitration is needed (M4). */
  needsArbitration: boolean;
}

/** djb2 content-address of a belief-state. Deterministic; toy (not SHA). */
export function contentHash(state: BeliefState): string {
  const s = stableStringify(state);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return "0x" + h.toString(16).padStart(8, "0");
}

/** Key-sorted JSON so equal states always hash identically. */
function stableStringify(state: BeliefState): string {
  const keys = Object.keys(state).sort();
  return JSON.stringify(keys.map((k) => [k, state[k]]));
}

/**
 * Three-way merge against a common ancestor.
 *
 * For each key: if both branches changed it to different values, it is a
 * genuine collision (held at the ancestor value, reported for arbitration).
 * Otherwise the side that changed wins, mechanically, with zero inference.
 */
export function threeWayMerge(ancestor: BeliefState, a: BeliefState, b: BeliefState): MergeResult {
  const keys = new Set([...Object.keys(ancestor), ...Object.keys(a), ...Object.keys(b)]);
  const merged: BeliefState = {};
  const conflicts: Conflict[] = [];

  for (const k of keys) {
    const base = ancestor[k];
    const av = a[k];
    const bv = b[k];
    const aChanged = av !== base;
    const bChanged = bv !== base;

    if (aChanged && bChanged && av !== bv) {
      conflicts.push({ key: k, base, a: av, b: bv });
      if (base !== undefined) merged[k] = base; // hold ancestor until resolved
    } else if (bChanged) {
      merged[k] = bv;
    } else if (aChanged) {
      merged[k] = av;
    } else if (base !== undefined) {
      merged[k] = base;
    }
  }

  return { merged, conflicts, needsArbitration: conflicts.length > 0 };
}

let _counter = 0;
const nextId = (): string => `n${++_counter}`;

interface MakeNodeArgs {
  kind: NodeKind;
  author: string;
  parents?: string[];
  state: BeliefState;
  delta?: { key: string; value: string } | null;
  msg?: string;
}

/** Build a stamped, content-addressed DAG node. */
export function makeNode({ kind, author, parents = [], state, delta = null, msg = "" }: MakeNodeArgs): DagNode {
  return {
    id: nextId(),
    kind,
    author,
    parents,
    hash: contentHash(state),
    state,
    delta,
    msg,
    timestamp: Date.now(),
  };
}

/** Reset the node-id counter. Test/session-boundary helper. */
export function resetNodeIds(): void {
  _counter = 0;
}
