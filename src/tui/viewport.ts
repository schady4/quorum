// Which slice of the message list is on screen, given a viewport height (in
// rows) and how far the reader has scrolled up from the bottom. Pure, so the
// scroll math is unit-tested without a terminal. Newest messages sit at the
// bottom; offset 0 pins the view there (auto-scroll).

export interface Window {
  /** First visible index (inclusive). */
  start: number;
  /** One past the last visible index. */
  end: number;
  /** Messages hidden above the viewport (scroll up to see them). */
  hiddenAbove: number;
  /** Messages hidden below the viewport (scroll down / newer). */
  hiddenBelow: number;
}

/** Keep a scroll offset within [0, total - rows]. */
export function clampOffset(total: number, rows: number, offset: number): number {
  const maxOffset = Math.max(0, total - Math.max(1, rows));
  return Math.min(Math.max(0, offset), maxOffset);
}

/** The visible window for `total` messages in `rows` lines at scroll `offset`. */
export function windowFor(total: number, rows: number, offset: number): Window {
  const r = Math.max(1, rows);
  const off = clampOffset(total, r, offset);
  const end = Math.max(0, total - off);
  const start = Math.max(0, end - r);
  return { start, end, hiddenAbove: start, hiddenBelow: total - end };
}
