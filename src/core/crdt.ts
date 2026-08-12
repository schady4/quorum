// Layer 1 — the CRDT live surface. Every terminal in a room is a replica here;
// concurrent edits converge deterministically with no locks and no merge calls.
// This is what unifies a friends-list session into one window even under lag.
//
// Ported from the proof of context in the sibling repo
// (multiplayer-ai/src/TwoLayerPoc.jsx), stripped of React — and corrected. The
// original demo ran a single in-memory document, so it never exercised
// cross-replica convergence; its flat "skip the adjacent same-anchor sibling"
// scan mis-orders concurrent multi-character runs when a chain's later
// characters arrive before another chain's first, and two replicas can diverge.
//
// This is the standard fix: a causal-tree RGA. Each node records the node it
// was inserted after ("after"), forming a tree rooted at ROOT. A node's
// children are the nodes inserted immediately after it; concurrent children of
// the same parent are ordered by id (a total order), so the sequence is a pure
// preorder walk of the tree — structural, identical on every replica, and
// independent of the order ops arrive in. Convergence is the math, restored.

/** A globally unique, totally-orderable id for a node, shaped "site:counter". */
export type OpId = string;

/** The virtual head every sequence is anchored from. */
export const ROOT: OpId = "ROOT";

export interface InsertOp {
  type: "insert";
  id: OpId;
  /** id of the left-neighbor this node is inserted after; ROOT = head. */
  after: OpId;
  /** A single character. Strings are inserted as one op per character. */
  value: string;
  /** Which replica authored the op (its site id). */
  author: string;
}

export interface DeleteOp {
  type: "delete";
  id: OpId;
}

export type Op = InsertOp | DeleteOp;

interface Node {
  id: OpId;
  value: string;
  after: OpId;
  deleted: boolean;
}

export interface CrdtSurface {
  /** Integrate one op. Idempotent — applying the same op twice is a no-op. */
  apply(op: Op): void;
  /** Materialize the converged text. */
  toString(): string;
  /** Visible (non-deleted) element ids, in sequence order. */
  visibleIds(): OpId[];
  /** The id to anchor an append to (last visible element, or ROOT if empty). */
  tail(): OpId;
}

class Surface implements CrdtSurface {
  private nodes = new Map<OpId, Node>();
  /** parent id -> child ids, kept sorted by id descending (higher id first). */
  private children = new Map<OpId, OpId[]>();

  apply(op: Op): void {
    if (op.type === "insert") this.integrateInsert(op);
    else this.integrateDelete(op);
  }

  private integrateInsert(op: InsertOp): void {
    if (this.nodes.has(op.id)) return; // idempotent
    this.nodes.set(op.id, { id: op.id, value: op.value, after: op.after, deleted: false });

    // Register under its parent, holding the sibling list in a fixed total
    // order (descending id) so every replica lays concurrent inserts out the
    // same way regardless of arrival order.
    const siblings = this.children.get(op.after) ?? [];
    let i = 0;
    while (i < siblings.length && siblings[i] > op.id) i++;
    siblings.splice(i, 0, op.id);
    this.children.set(op.after, siblings);
  }

  private integrateDelete(op: DeleteOp): void {
    const n = this.nodes.get(op.id);
    if (n) n.deleted = true;
  }

  /** Preorder walk of the causal tree — the canonical sequence order. */
  private walk(): Node[] {
    const out: Node[] = [];
    const visit = (parent: OpId): void => {
      const kids = this.children.get(parent);
      if (!kids) return;
      for (const id of kids) {
        const n = this.nodes.get(id)!;
        out.push(n);
        visit(id);
      }
    };
    visit(ROOT);
    return out;
  }

  toString(): string {
    let s = "";
    for (const n of this.walk()) if (!n.deleted) s += n.value;
    return s;
  }

  visibleIds(): OpId[] {
    return this.walk().filter((n) => !n.deleted).map((n) => n.id);
  }

  tail(): OpId {
    const v = this.visibleIds();
    return v.length ? v[v.length - 1] : ROOT;
  }
}

export function createSurface(): CrdtSurface {
  return new Surface();
}

/**
 * A per-site op generator. Holds the monotonic counter that, with the site id,
 * makes every op id globally unique. `append` produces the ops to add `str`
 * after `anchor` (typically the surface tail) without applying them — so a
 * caller or test can deliver them over the wire in any (causally valid) order.
 */
export class Writer {
  private counter = 0;
  constructor(public readonly site: string) {}

  append(str: string, anchor: OpId): InsertOp[] {
    const ops: InsertOp[] = [];
    let after = anchor;
    for (const ch of str) {
      this.counter += 1;
      const id = `${this.site}:${this.counter}`;
      ops.push({ type: "insert", id, after, value: ch, author: this.site });
      after = id;
    }
    return ops;
  }
}
