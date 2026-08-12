// Headless proof of the M4 ledger core: fork → advance branches → merge, with
// the mechanical-vs-arbitrated split from dag.ts. Run with `npm run test:ledger`.

import { Ledger, type LedgerOp } from "../src/core/ledger.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let n = 0;
const id = () => `t:${++n}`;

// fork advances two branches off the trunk snapshot.
{
  const l = new Ledger({ goal: "ship" });
  l.apply({ id: id(), type: "fork", branches: ["A", "B"] });
  check("fork creates branches seeded from trunk", l.forked && eq(l.branches.get("A"), { goal: "ship" }) && eq(l.branches.get("B"), { goal: "ship" }));
}

// disjoint edits merge mechanically (no resolver needed).
{
  const l = new Ledger();
  l.apply({ id: id(), type: "fork", branches: ["A", "B"] });
  l.apply({ id: id(), type: "edit", branch: "A", key: "owner", value: "ada", author: "ada" });
  l.apply({ id: id(), type: "edit", branch: "B", key: "deadline", value: "monday", author: "bob" });
  const prep = l.prepareMerge("A", "B");
  check("disjoint edits produce no conflicts", prep.conflicts.length === 0, JSON.stringify(prep.conflicts));
  const merge: LedgerOp = { id: id(), type: "merge", branches: ["A", "B"], resolved: prep.merged, author: "trunk", viaArbitration: false };
  l.apply(merge);
  check("mechanical merge folds both edits into trunk", eq(l.trunk, { owner: "ada", deadline: "monday" }));
  check("branches close after merge", !l.forked);
}

// same key changed incompatibly is a collision the ledger surfaces.
{
  const l = new Ledger();
  l.apply({ id: id(), type: "fork", branches: ["A", "B"] });
  l.apply({ id: id(), type: "edit", branch: "A", key: "deadline", value: "friday, scope cut", author: "ada" });
  l.apply({ id: id(), type: "edit", branch: "B", key: "deadline", value: "monday, full scope", author: "bob" });
  const prep = l.prepareMerge("A", "B");
  check("collision on the same key is detected", prep.conflicts.length === 1 && prep.conflicts[0].key === "deadline");

  // Applying the arbitrated resolution (as it would arrive inside the merge op).
  const merge: LedgerOp = {
    id: id(),
    type: "merge",
    branches: ["A", "B"],
    resolved: { ...prep.merged, deadline: "wednesday, core scope" },
    author: "trunk",
    viaArbitration: true,
    rationale: "split the difference",
  };
  l.apply(merge);
  check("arbitrated value lands in trunk", eq(l.trunk, { deadline: "wednesday, core scope" }));
  check("history records the AI-arbitrated merge", l.history.some((h) => h.kind === "merge" && h.summary.includes("AI arbitrated")));
}

// apply is idempotent — replaying an op changes nothing.
{
  const l = new Ledger();
  const fork: LedgerOp = { id: "dup", type: "fork", branches: ["A", "B"] };
  l.apply(fork);
  l.apply({ id: id(), type: "edit", branch: "A", key: "x", value: "1", author: "a" });
  const before = JSON.stringify([...l.branches]);
  l.apply(fork); // replay
  check("replaying an op is a no-op", JSON.stringify([...l.branches]) === before);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
