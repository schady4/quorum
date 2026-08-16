// A pure line editor for the TUI input: a value plus a cursor index, with the
// usual movements and edits. Kept free of React/Ink so it's unit-testable
// without a terminal — the component just holds a Line in state and calls these.

export interface Line {
  value: string;
  cursor: number;
}

export const EMPTY: Line = { value: "", cursor: 0 };

/** A line holding `value` with the cursor at its end. */
export function fromValue(value: string): Line {
  return { value, cursor: value.length };
}

/** Insert text at the cursor (handles multi-char paste too). */
export function insert(l: Line, s: string): Line {
  return { value: l.value.slice(0, l.cursor) + s + l.value.slice(l.cursor), cursor: l.cursor + s.length };
}

/** Delete the character before the cursor. */
export function backspace(l: Line): Line {
  if (l.cursor === 0) return l;
  return { value: l.value.slice(0, l.cursor - 1) + l.value.slice(l.cursor), cursor: l.cursor - 1 };
}

/** Delete the character under the cursor. */
export function del(l: Line): Line {
  if (l.cursor >= l.value.length) return l;
  return { value: l.value.slice(0, l.cursor) + l.value.slice(l.cursor + 1), cursor: l.cursor };
}

export function left(l: Line): Line {
  return l.cursor > 0 ? { value: l.value, cursor: l.cursor - 1 } : l;
}

export function right(l: Line): Line {
  return l.cursor < l.value.length ? { value: l.value, cursor: l.cursor + 1 } : l;
}

export function home(l: Line): Line {
  return { value: l.value, cursor: 0 };
}

export function end(l: Line): Line {
  return { value: l.value, cursor: l.value.length };
}

// --- Command history (shell-style recall) ------------------------------------
// `items` is oldest -> newest. `index` ranges over [0, items.length]; the value
// items.length means "not in history — the live draft", held by the caller.

/** Append a submitted line, skipping a blank or an immediate duplicate. */
export function pushHistory(items: string[], entry: string): string[] {
  if (!entry || items[items.length - 1] === entry) return items;
  return [...items, entry];
}

/** The value shown at a given history index; `draft` is returned at the end. */
export function historyValue(items: string[], index: number, draft: string): string {
  if (index >= items.length) return draft;
  if (index < 0) return items[0] ?? draft;
  return items[index];
}
