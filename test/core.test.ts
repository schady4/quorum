// Headless proof of the M0 substrate: CRDT convergence and DAG three-way merge,
// with no browser and no network. Run with `npm test`.
//
// A tiny throw-on-failure harness (no test-framework dependency) keeps this
// runnable through `tsx` on any Node >= 18.

import { createSurface, Writer, ROOT, type Op } from "../src/core/crdt.js";
import { threeWayMerge, contentHash, type BeliefState } from "../src/core/dag.js";

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function eq<T>(actual: T, expected: T, msg = ""): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n      expected ${e}\n      got      ${a}`);
}

// A small seeded PRNG so "random" delivery orders are reproducible.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Produce a random delivery order that still respects causality: an insert is
// delivered only after the node it anchors to, and a delete after its insert.
// Concurrent (independent) ops may land in any order — the property under test.
function causalShuffle(ops: Op[], rand: () => number): Op[] {
  const remaining = [...ops];
  const delivered = new Set<string>([ROOT]);
  const out: Op[] = [];
  while (remaining.length) {
    const ready = remaining.filter((op) =>
      op.type === "insert" ? delivered.has(op.after) : delivered.has(op.id),
    );
    if (!ready.length) throw new Error("dependency cycle — ops are not causally deliverable");
    const pick = ready[Math.floor(rand() * ready.length)];
    out.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
    if (pick.type === "insert") delivered.add(pick.id);
  }
  return out;
}

function replay(ops: Op[]): string {
  const s = createSurface();
  for (const op of ops) s.apply(op);
  return s.toString();
}

// ── CRDT ─────────────────────────────────────────────────────────────────────

test("apply is idempotent", () => {
  const s = createSurface();
  const ops = new Writer("A").append("hi", ROOT);
  for (const op of ops) s.apply(op);
  for (const op of ops) s.apply(op); // twice
  eq(s.toString(), "hi");
});

test("single writer preserves order", () => {
  const s = createSurface();
  for (const op of new Writer("A").append("hello", ROOT)) s.apply(op);
  eq(s.toString(), "hello");
});

test("concurrent same-anchor inserts converge deterministically", () => {
  // Two sites both append from the empty surface (anchor = ROOT): the classic
  // concurrent-insert case. Every valid delivery order must yield one text.
  const a = new Writer("A").append("AAA", ROOT);
  const b = new Writer("B").append("BBB", ROOT);
  const all = [...a, ...b];

  const seen = new Set<string>();
  const r = rng(1);
  for (let i = 0; i < 200; i++) seen.add(replay(causalShuffle(all, r)));

  eq(seen.size, 1, "all delivery orders converged to a single text");
  // Concurrent children of the same anchor are ordered by id descending, so
  // the higher site id ("B:*" > "A:*") takes the head — deterministically.
  eq([...seen][0], "BBBAAA");
});

test("two replicas converge under different causal delivery orders", () => {
  // Three writers interleaving, anchored into a shared, growing sequence.
  const wa = new Writer("A");
  const wb = new Writer("B");
  const wc = new Writer("C");
  const ops: Op[] = [
    ...wa.append("fork ", ROOT),
    ...wb.append("merge ", ROOT),
    ...wc.append("share", ROOT),
  ];

  const replica1 = replay(causalShuffle(ops, rng(42)));
  const replica2 = replay(causalShuffle(ops, rng(1337)));
  eq(replica1, replica2, "independent replicas reached the same state");
});

test("deletes tombstone without breaking order", () => {
  const s = createSurface();
  const ops = new Writer("A").append("abcd", ROOT);
  for (const op of ops) s.apply(op);
  const secondCharId = ops[1].id; // "b"
  s.apply({ type: "delete", id: secondCharId });
  eq(s.toString(), "acd");
});

// ── DAG ──────────────────────────────────────────────────────────────────────

test("contentHash is deterministic and key-order independent", () => {
  const x: BeliefState = { goal: "ship", owner: "A" };
  const y: BeliefState = { owner: "A", goal: "ship" };
  eq(contentHash(x), contentHash(y), "same content ⇒ same address");
  if (contentHash(x) === contentHash({ goal: "slip", owner: "A" })) {
    throw new Error("different content must not collide here");
  }
});

test("mechanical merge: disjoint keys reconcile with zero conflicts", () => {
  const ancestor: BeliefState = { goal: "ship the POC", owner: "unassigned", deadline: "friday" };
  const a: BeliefState = { ...ancestor, owner: "A" }; // A claims ownership
  const b: BeliefState = { ...ancestor, deadline: "monday" }; // B moves the date
  const res = threeWayMerge(ancestor, a, b);
  eq(res.needsArbitration, false);
  eq(res.conflicts.length, 0);
  eq(res.merged, { goal: "ship the POC", owner: "A", deadline: "monday" });
});

test("semantic collision: same key changed incompatibly escalates", () => {
  const ancestor: BeliefState = { deadline: "friday" };
  const a: BeliefState = { deadline: "friday, scope cut" };
  const b: BeliefState = { deadline: "monday, full scope" };
  const res = threeWayMerge(ancestor, a, b);
  eq(res.needsArbitration, true, "collision needs AI arbitration (M4)");
  eq(res.conflicts.length, 1);
  eq(res.conflicts[0].key, "deadline");
  eq(res.merged.deadline, "friday", "holds the ancestor value until resolved");
});

test("identical change on both branches is not a conflict", () => {
  const ancestor: BeliefState = { owner: "unassigned" };
  const both: BeliefState = { owner: "A" };
  const res = threeWayMerge(ancestor, both, both);
  eq(res.needsArbitration, false);
  eq(res.merged, { owner: "A" });
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
