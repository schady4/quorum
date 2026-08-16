// Headless proof of scoped delegation's context logic: extractAssignment picks
// the right task from the room and strips the mention, so a delegated worker
// answers its subtask rather than re-reading the whole conversation. Pure — no
// network, no model call. Run with `npm run test:responder`.

import { extractAssignment } from "../src/agent/responder.js";
import type { Entry } from "../src/core/crdt.js";

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

const E = (id: string, author: string, value: string): Entry => ({ id, author, value });

test("assignment is the newest @mention, with the mention stripped", () => {
  const entries = [
    E("1", "ada", "let's plan the launch"),
    E("2", "lead", "@scribe summarize the thread so far"),
    E("3", "bob", "sounds good"),
  ];
  const { task, assignmentId } = extractAssignment(entries, "scribe");
  eq(task, "summarize the thread so far");
  eq(assignmentId, "2");
});

test("worker's own messages are never picked as the assignment", () => {
  const entries = [
    E("1", "lead", "@scribe draft the summary"),
    E("2", "scribe", "@scribe note to self"), // self-authored, must be skipped
  ];
  const { task, assignmentId } = extractAssignment(entries, "scribe");
  eq(task, "draft the summary");
  eq(assignmentId, "1");
});

test("newest mention wins when there are several", () => {
  const entries = [
    E("1", "lead", "@scribe do the first thing"),
    E("2", "lead", "@scribe actually do the second thing"),
  ];
  eq(extractAssignment(entries, "scribe").task, "actually do the second thing");
});

test("falls back to newest non-self message when unmentioned", () => {
  const entries = [E("1", "ada", "hello"), E("2", "bob", "the actual task")];
  const { task } = extractAssignment(entries, "scribe");
  eq(task, "the actual task");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
