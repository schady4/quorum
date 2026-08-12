// Integration proof for M4: the DAG ledger replicated across a room. Two
// clients fork, advance branches, and merge — mechanically when disjoint, and
// via a single (faked) arbitration call when they collide. Both replicas
// converge on the same trunk, and a late joiner catches the ledger up.
// Offline. Run with `npm run test:session`.

import { startRelay } from "../src/relay/server.js";
import { RoomClient } from "../src/net/client.js";
import type { MergeResolver } from "../src/core/ledger.js";

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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextOpen = (c: RoomClient) => new Promise<void>((res) => c.once("open", () => res()));

async function main(): Promise<void> {
  const relay = await startRelay({ port: 0 });
  const url = `ws://localhost:${relay.port}`;

  const ada = new RoomClient(url, "plan", "ada");
  const bob = new RoomClient(url, "plan", "bob");
  ada.connect();
  bob.connect();
  await Promise.all([nextOpen(ada), nextOpen(bob)]);
  await wait(100);

  // Fork, then each advances a different branch — disjoint.
  ada.fork(["A", "B"]);
  await wait(80);
  check("both replicas see the fork", ada.ledger.forked && bob.ledger.forked);

  ada.setDecision("A", "owner", "ada");
  bob.setDecision("B", "deadline", "monday");
  await wait(120);
  check(
    "branch edits converge across replicas",
    eq(ada.ledger.branches.get("A"), bob.ledger.branches.get("A")) && eq(ada.ledger.branches.get("B"), bob.ledger.branches.get("B")),
  );

  // Mechanical merge — no resolver should be consulted.
  let resolverCalls = 0;
  const resolver: MergeResolver = async (prep) => {
    resolverCalls++;
    return { resolved: Object.fromEntries(prep.conflicts.map((c) => [c.key, "ARBITRATED"])), rationale: "test" };
  };

  const r1 = await ada.merge("A", "B", resolver);
  await wait(120);
  check("mechanical merge ran no arbitration", r1.conflicts === 0 && resolverCalls === 0);
  check("both replicas converge on merged trunk", eq(ada.ledger.trunk, { owner: "ada", deadline: "monday" }) && eq(bob.ledger.trunk, ada.ledger.trunk));

  // Now force a collision and confirm exactly one arbitration call resolves it.
  ada.fork(["A", "B"]);
  await wait(80);
  ada.setDecision("A", "deadline", "friday, scope cut");
  bob.setDecision("B", "deadline", "monday, full scope");
  await wait(120);

  const r2 = await bob.merge("A", "B", resolver);
  await wait(120);
  check("collision triggered exactly one arbitration call", r2.conflicts === 1 && r2.arbitrated && resolverCalls === 1);
  check("arbitrated trunk converges on both replicas", ada.ledger.trunk.deadline === "ARBITRATED" && bob.ledger.trunk.deadline === "ARBITRATED");

  // Late joiner catches the whole ledger up from the relay's log.
  const cara = new RoomClient(url, "plan", "cara");
  cara.connect();
  await nextOpen(cara);
  await wait(120);
  check("late joiner reconstructs the ledger", eq(cara.ledger.trunk, ada.ledger.trunk) && !cara.ledger.forked);

  ada.close();
  bob.close();
  cara.close();
  await relay.close();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
