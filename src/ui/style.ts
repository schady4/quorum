// Quorum's answer to lipgloss: one small, dependency-free ANSI kit so every
// surface — `host`, `agent`, `setup`, `providers`, and the Ink room TUI —
// speaks the same visual language instead of each printing plain text in its
// own voice. 16-color ANSI only, no truecolor: safe over SSH, tmux, and
// whatever terminal a friend you invited happens to be running. Every helper
// degrades to plain text automatically when stdout/stderr isn't a TTY (piped
// output, CI logs), so nothing here changes what a script sees.

const CODE = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  blueBright: "\x1b[94m",
} as const;

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a string with any ANSI codes stripped — for padding boxes
 *  that contain already-colored text. */
export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function paint(code: string, tty: boolean, s: string): string {
  return tty ? `${code}${s}${CODE.reset}` : s;
}

/** True when the given stream will actually render escape codes. Each style
 *  function takes the stream it's headed for so `host`/`agent` (stderr) and
 *  anything writing to stdout degrade independently and correctly when piped. */
function isTTY(stream: NodeJS.WriteStream = process.stderr): boolean {
  return Boolean(stream.isTTY);
}

export const style = {
  brand: (s: string, stream?: NodeJS.WriteStream) => paint(CODE.blueBright, isTTY(stream), s),
  bold: (s: string, stream?: NodeJS.WriteStream) => paint(CODE.bold, isTTY(stream), s),
  dim: (s: string, stream?: NodeJS.WriteStream) => paint(CODE.gray, isTTY(stream), s),
  ok: (s: string, stream?: NodeJS.WriteStream) => paint(CODE.green, isTTY(stream), s),
  warn: (s: string, stream?: NodeJS.WriteStream) => paint(CODE.yellow, isTTY(stream), s),
  err: (s: string, stream?: NodeJS.WriteStream) => paint(CODE.red, isTTY(stream), s),
};

// --- Per-handle color, shared with the Ink TUI --------------------------------
// Same handle -> same color everywhere: a person's messages in the room TUI and
// their agent's startup lines in its own terminal read as the same participant.
// The Ink component owns its own named-color palette (Ink wants color names,
// not ANSI codes); this hash is what keeps the two palettes in lockstep.

const HANDLE_PALETTE = [CODE.cyan, CODE.yellow, CODE.green, CODE.magenta, CODE.blue, CODE.red];
/** Ink color names, same order/length as HANDLE_PALETTE above — kept in sync
 *  by hand since Ink and raw ANSI can't share one literal list. */
export const INK_HANDLE_PALETTE = ["cyan", "yellow", "green", "magenta", "blue", "red"] as const;

/** Stable index into a palette of length `paletteLength` for a given handle. */
export function hueIndex(handle: string, paletteLength: number): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return h % paletteLength;
}

export function colorForHandle(handle: string, stream?: NodeJS.WriteStream): (s: string) => string {
  const code = HANDLE_PALETTE[hueIndex(handle, HANDLE_PALETTE.length)];
  return (s: string) => paint(code, isTTY(stream), s);
}

// --- Boxes ---------------------------------------------------------------------
// A plain-text echo of the Ink TUI's `borderStyle="round"` panels, so a card
// printed by `host`/`providers`/`setup` reads as the same object language as
// the room window. Lines may already contain ANSI codes; width accounts for it.

export interface BoxOptions {
  title?: string;
  stream?: NodeJS.WriteStream;
}

export function box(lines: string[], opts: BoxOptions = {}): string {
  const tty = isTTY(opts.stream);
  const border = (s: string) => paint(CODE.gray, tty, s);
  const contentWidth = Math.max(1, ...lines.map(visibleLength), opts.title ? visibleLength(opts.title) + 2 : 0);

  const top = opts.title
    ? border(`╭─ ${paint(CODE.blueBright, tty, opts.title)}${border(" " + "─".repeat(Math.max(0, contentWidth - visibleLength(opts.title) - 1)) + "╮")}`)
    : border(`╭${"─".repeat(contentWidth + 2)}╮`);
  const bottom = border(`╰${"─".repeat(contentWidth + 2)}╯`);
  const body = lines.map((l) => `${border("│")} ${l}${" ".repeat(contentWidth - visibleLength(l))} ${border("│")}`);

  return [top, ...body, bottom].join("\n");
}

// --- Spinner ---------------------------------------------------------------
// A braille-dot spinner for a real wait (a network round trip, a socket open)
// — never a fake delay. Falls back to a single static line when the target
// stream isn't a TTY, so piped/CI output stays clean single-line text.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private readonly tty: boolean;

  /** `label` should NOT include a trailing "…" — the spinner always appends
   *  its own, in both animated and static-fallback form. */
  constructor(
    private label: string,
    private readonly stream: NodeJS.WriteStream = process.stderr,
  ) {
    this.tty = isTTY(stream);
  }

  start(): void {
    if (!this.tty) {
      this.stream.write(`${this.label}… `);
      return;
    }
    this.stream.write("\x1b[?25l"); // hide cursor while animating
    this.render();
    this.timer = setInterval(() => this.render(), 80);
    this.timer.unref?.();
  }

  private render(): void {
    this.frame = (this.frame + 1) % FRAMES.length;
    this.stream.write(`\r${paint(CODE.blueBright, true, FRAMES[this.frame])} ${this.label}…\x1b[K`);
  }

  /** Stop animating and leave a final, non-animated line in its place. */
  stop(finalLine?: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty) {
      this.stream.write(`\r\x1b[K\x1b[?25h`); // clear the spinner line, restore cursor
      if (finalLine) this.stream.write(finalLine + "\n");
    } else if (finalLine) {
      this.stream.write(finalLine + "\n");
    }
  }
}
