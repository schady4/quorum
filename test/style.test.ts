// Headless proof of the shared ANSI style kit: color/box helpers degrade to
// plain text off a TTY, hueIndex stays deterministic (so a handle's color
// matches between the CLI and the Ink TUI), and box() pads around already-
// colored text using visible width, not raw string length. No terminal.
// Run with `npm run test:style`.

import { style, box, visibleLength, hueIndex, colorForHandle, INK_HANDLE_PALETTE, Spinner } from "../src/ui/style.js";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// A stream that reports as non-TTY, like piped output or a CI log.
const plain = { isTTY: false } as NodeJS.WriteStream;
// A stream that reports as a real terminal.
const tty = { isTTY: true } as NodeJS.WriteStream;

test("style functions no-op on a non-TTY stream", () => {
  ok(style.ok("hi", plain) === "hi", "should be plain text, no escape codes");
  ok(style.err("hi", plain) === "hi", "should be plain text, no escape codes");
});

test("style functions wrap with escape codes on a TTY stream", () => {
  const painted = style.ok("hi", tty);
  ok(painted !== "hi", "expected the text to be wrapped");
  ok(painted.includes("hi"), "original text should still be present");
});

test("visibleLength ignores ANSI escape codes", () => {
  ok(visibleLength(style.ok("abcd", tty)) === 4, "colored 4-char string should still measure as 4");
  ok(visibleLength("abcd") === 4);
});

test("hueIndex is deterministic and in range", () => {
  const a = hueIndex("claude", INK_HANDLE_PALETTE.length);
  const b = hueIndex("claude", INK_HANDLE_PALETTE.length);
  ok(a === b, "same handle should hash to the same index every time");
  ok(a >= 0 && a < INK_HANDLE_PALETTE.length, "index should be within the palette");
});

test("colorForHandle: same handle -> same color, consistently", () => {
  const paint1 = colorForHandle("claude", tty);
  const paint2 = colorForHandle("claude", tty);
  ok(paint1("x") === paint2("x"), "two seats named the same should render identically");
});

test("box() pads content to a uniform width even with embedded color codes", () => {
  const rendered = box(["short", style.ok("colored but short", tty)], { stream: plain });
  const lines = rendered.split("\n");
  const widths = new Set(lines.map((l) => visibleLength(l)));
  ok(widths.size === 1, `all box lines should share one visible width, got ${[...widths].join(", ")}`);
});

test("box() renders a title when given one", () => {
  const rendered = box(["hello"], { title: "quorum", stream: plain });
  ok(rendered.includes("quorum"), "title text should appear in the box");
});

test("Spinner falls back to a single static line on a non-TTY stream", () => {
  const writes: string[] = [];
  const fakeStream = {
    isTTY: false,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const s = new Spinner("checking key", fakeStream);
  s.start();
  s.stop("✓ done");
  ok(writes.join("") === "checking key… ✓ done\n", `unexpected non-TTY spinner output: ${JSON.stringify(writes)}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
