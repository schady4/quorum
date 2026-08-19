// Headless proof of the TUI's pure logic: the input line editor (cursor moves,
// edits, history recall) and the message viewport (which slice is on screen,
// scroll clamping). No terminal — the Ink component just holds this state.
// Run with `npm run test:tui`.

import { EMPTY, fromValue, insert, backspace, del, left, right, home, end, pushHistory, historyValue } from "../src/tui/lineedit.js";
import { windowFor, clampOffset } from "../src/tui/viewport.js";
import { maskForDisplay, deniedHelp } from "../src/tui/app.js";

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

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// --- line editor -------------------------------------------------------------
test("fromValue puts the cursor at the end", () => eq(fromValue("abc"), { value: "abc", cursor: 3 }));

test("insert lands text at the cursor", () => {
  eq(insert({ value: "abc", cursor: 1 }, "X"), { value: "aXbc", cursor: 2 });
  eq(insert(EMPTY, "hi"), { value: "hi", cursor: 2 });
});

test("backspace deletes before the cursor and stops at 0", () => {
  eq(backspace({ value: "abc", cursor: 2 }), { value: "ac", cursor: 1 });
  eq(backspace({ value: "abc", cursor: 0 }), { value: "abc", cursor: 0 });
});

test("delete removes under the cursor and is a no-op at the end", () => {
  eq(del({ value: "abc", cursor: 1 }), { value: "ac", cursor: 1 });
  eq(del({ value: "abc", cursor: 3 }), { value: "abc", cursor: 3 });
});

test("left/right/home/end move within bounds", () => {
  eq(left({ value: "abc", cursor: 0 }), { value: "abc", cursor: 0 });
  eq(right({ value: "abc", cursor: 3 }), { value: "abc", cursor: 3 });
  eq(home({ value: "abc", cursor: 2 }), { value: "abc", cursor: 0 });
  eq(end({ value: "abc", cursor: 0 }), { value: "abc", cursor: 3 });
});

// --- history -----------------------------------------------------------------
test("pushHistory appends, skipping blanks and consecutive dupes", () => {
  eq(pushHistory([], "hi"), ["hi"]);
  eq(pushHistory(["hi"], "hi"), ["hi"]);
  eq(pushHistory(["hi"], ""), ["hi"]);
  eq(pushHistory(["hi"], "yo"), ["hi", "yo"]);
});

test("historyValue: end index returns the live draft, others the item", () => {
  const items = ["one", "two"];
  eq(historyValue(items, 2, "draft"), "draft"); // at/after end -> draft
  eq(historyValue(items, 1, "draft"), "two");
  eq(historyValue(items, 0, "draft"), "one");
});

// --- viewport ----------------------------------------------------------------
test("clampOffset keeps the scroll within [0, total-rows]", () => {
  eq(clampOffset(10, 5, 0), 0);
  eq(clampOffset(10, 5, 100), 5);
  eq(clampOffset(10, 5, -3), 0);
  eq(clampOffset(3, 5, 2), 0); // fewer messages than rows -> no scroll
});

test("windowFor pins to the newest at offset 0", () => {
  eq(windowFor(10, 5, 0), { start: 5, end: 10, hiddenAbove: 5, hiddenBelow: 0 });
});

test("windowFor scrolls up by the offset", () => {
  eq(windowFor(10, 5, 3), { start: 2, end: 7, hiddenAbove: 2, hiddenBelow: 3 });
});

test("windowFor clamps an over-scroll to the top", () => {
  eq(windowFor(10, 5, 100), { start: 0, end: 5, hiddenAbove: 0, hiddenBelow: 5 });
});

test("windowFor shows everything when it all fits", () => {
  eq(windowFor(3, 10, 0), { start: 0, end: 3, hiddenAbove: 0, hiddenBelow: 0 });
  eq(windowFor(0, 5, 0), { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
});

// --- /key input masking -------------------------------------------------------
// The line's real value must survive untouched (it's what actually gets
// submitted) — only the on-screen render should ever swap the secret for bullets.

test("maskForDisplay leaves ordinary chat untouched", () => {
  eq(maskForDisplay("hey @claude how's it going"), "hey @claude how's it going");
});

test("maskForDisplay leaves other slash commands untouched", () => {
  eq(maskForDisplay("/fork A B"), "/fork A B");
});

test("maskForDisplay masks the value after provider id, keeps the prefix readable", () => {
  eq(maskForDisplay("/key anthropic sk-ant-abc123"), "/key anthropic " + "•".repeat("sk-ant-abc123".length));
});

test("maskForDisplay doesn't mask while only the provider id is typed", () => {
  eq(maskForDisplay("/key anthropic"), "/key anthropic");
});

test("maskForDisplay handles a named credential key before the value", () => {
  eq(maskForDisplay("/key openai OPENAI_API_KEY sk-xyz"), "/key openai " + "•".repeat("OPENAI_API_KEY sk-xyz".length));
});

// --- denied-join helper text ---------------------------------------------
// A denied join is always one of two relay-reported reasons; each should
// steer toward its one real fix, not a generic "check the key" for both.

test("deniedHelp points a handle collision at picking a new --as", () => {
  const msg = deniedHelp('handle "claude" is already in use in this room', "ws://localhost:8787");
  ok(msg.includes("--as"), "should mention the fix (a different --as handle)");
  ok(!msg.includes("quorum host"), "a handle collision isn't a key problem — shouldn't send them to the host's key");
});

test("deniedHelp points a bad/missing key at the host's invite line", () => {
  const msg = deniedHelp("wrong or missing room key", "ws://localhost:8787");
  ok(msg.includes("quorum host"), "should point at the host as the source of truth for the key");
  ok(msg.includes("ws://localhost:8787"), "should echo the relay URL actually being used");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
