// The DAG session ledger, live inside a room. A room carries a shared decision
// state — a small key/value belief store — that participants can fork into
// named branches, advance independently (a human or an AI seat editing a key),
// and merge back. Non-overlapping edits reconcile mechanically (zero
// inference); a genuine collision — two branches changing the same key
// incompatibly — escalates to a single AI arbitration call.
//
// Built on the tested three-way merge in dag.ts. The ledger is driven by an op
// log, exactly like the CRDT surface: every replica applies the same ops in
// order and lands on the same state. The one non-deterministic step — asking a
// model to arbitrate a collision — happens once, at the initiator, whose
// resolved values ride along inside the merge op, so applying a merge stays
// deterministic everywhere.

import { threeWayMerge, contentHash, type BeliefState, type Conflict } from "./dag.js";

export type LedgerOp =
  | { id: string; type: "fork"; branches: string[] }
  | { id: string; type: "edit"; branch: string; key: string; value: string; author: string }
  | {
      id: string;
      type: "merge";
      branches: [string, string];
      resolved: BeliefState;
      author: string;
      viaArbitration: boolean;
      rationale?: string;
    };

export interface HistoryEntry {
  kind: "fork" | "edit" | "merge";
  author?: string;
  summary: string;
  hash: string;
}

/** What an initiator needs to decide a merge: the ancestor, both branch tips,
 *  the mechanical result, and any collisions that need arbitration. */
export interface MergePrep {
  ancestor: BeliefState;
  a: BeliefState;
  b: BeliefState;
  merged: BeliefState;
  conflicts: Conflict[];
}

/** Resolve collisions. In production this is one AI call; in tests it's a fake.
 *  Returns values for the conflicted keys plus a one-line rationale. */
export type MergeResolver = (prep: MergePrep) => Promise<{ resolved: BeliefState; rationale?: string }>;

export class Ledger {
  trunk: BeliefState;
  /** Ancestor snapshot held while branches diverge; null when not forked. */
  base: BeliefState | null = null;
  branches = new Map<string, BeliefState>();
  history: HistoryEntry[] = [];
  private seen = new Set<string>();

  constructor(seed: BeliefState = {}) {
    this.trunk = { ...seed };
  }

  get forked(): boolean {
    return this.branches.size > 0;
  }

  branchNames(): string[] {
    return [...this.branches.keys()];
  }

  /** Apply a ledger op. Deterministic and idempotent — every replica converges. */
  apply(op: LedgerOp): void {
    if (this.seen.has(op.id)) return;
    this.seen.add(op.id);

    switch (op.type) {
      case "fork": {
        this.base = { ...this.trunk };
        this.branches.clear();
        for (const name of op.branches) this.branches.set(name, { ...this.trunk });
        this.history.push({ kind: "fork", summary: `forked → ${op.branches.join(", ")}`, hash: contentHash(this.trunk) });
        break;
      }
      case "edit": {
        const b = this.branches.get(op.branch);
        if (!b) return; // edit on an unknown/closed branch is a no-op
        b[op.key] = op.value;
        this.history.push({ kind: "edit", author: op.author, summary: `${op.branch}: ${op.key} = ${op.value}`, hash: contentHash(b) });
        break;
      }
      case "merge": {
        this.trunk = { ...op.resolved };
        this.branches.clear();
        this.base = null;
        this.history.push({
          kind: "merge",
          author: op.author,
          summary: op.viaArbitration
            ? `merged (AI arbitrated${op.rationale ? ": " + op.rationale : ""})`
            : "merged (mechanical, 0 inference)",
          hash: contentHash(this.trunk),
        });
        break;
      }
    }
  }

  /** Gather the materials to merge two branches — pure, no side effects. */
  prepareMerge(a: string, b: string): MergePrep {
    const sa = this.branches.get(a);
    const sb = this.branches.get(b);
    if (!sa || !sb) throw new Error(`both branches must exist to merge (have: ${this.branchNames().join(", ") || "none"})`);
    const ancestor = this.base ?? this.trunk;
    const { merged, conflicts } = threeWayMerge(ancestor, sa, sb);
    return { ancestor, a: sa, b: sb, merged, conflicts };
  }
}
