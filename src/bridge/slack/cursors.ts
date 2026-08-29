// Crash-safe bridge state — the "deterministic, not a coin flip" guarantee.
//
// Correctness must NOT depend on a graceful shutdown; a `kill -9` has to recover
// identically. We persist two high-water marks plus a bounded set of recently
// processed Slack timestamps, and we write them atomically (temp file + rename)
// so a crash mid-write can never leave a torn cursor file.
//
//   slackTs   — the highest Slack message `ts` already relayed INTO the room.
//               On restart we pull Slack history since this and skip anything at
//               or below it, so an at-least-once redelivery is a no-op.
//   quorumOp  — the last Quorum op id already posted OUT to Slack. On restart we
//               resume past it, so history isn't re-spammed and the
//               post-then-crash duplicate window is closed.
//   seenTs    — a small ring of the most recent inbound `ts` values, so
//               near-boundary out-of-order redelivery is also deduped, not just
//               the strict high-water case.
//
// This module does the persistence only; the dedup DECISIONS live in core.ts,
// which is what keeps them unit-testable together.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** How many recent inbound timestamps to remember for out-of-order dedup. */
const SEEN_CAP = 512;

export interface CursorState {
  slackTs: string;
  quorumOp: string;
  seenTs: string[];
}

const EMPTY: CursorState = { slackTs: "0", quorumOp: "", seenTs: [] };

/** A durable, atomically-written cursor file for one channel⟷room link. */
export class CursorStore {
  private state: CursorState;

  constructor(readonly path: string) {
    this.state = load(path);
  }

  get slackTs(): string {
    return this.state.slackTs;
  }
  get quorumOp(): string {
    return this.state.quorumOp;
  }

  /** True if this inbound Slack `ts` was already processed — at or below the
   *  high-water mark, or in the recent-seen ring. */
  hasSeen(ts: string): boolean {
    return numLE(ts, this.state.slackTs) || this.state.seenTs.includes(ts);
  }

  /** Record an inbound `ts` as processed and advance the high-water mark. Cursors
   *  advance only AFTER the op is confirmed applied to the room, then persist
   *  atomically — so a crash between apply and persist replays harmlessly. */
  markInbound(ts: string): void {
    const seen = this.state.seenTs.concat(ts);
    this.state = {
      ...this.state,
      slackTs: numGT(ts, this.state.slackTs) ? ts : this.state.slackTs,
      seenTs: seen.length > SEEN_CAP ? seen.slice(seen.length - SEEN_CAP) : seen,
    };
    this.persist();
  }

  /** Record that a Quorum op id was posted to Slack. */
  markOutbound(opId: string): void {
    if (opId === this.state.quorumOp) return;
    this.state = { ...this.state, quorumOp: opId };
    this.persist();
  }

  private persist(): void {
    save(this.path, this.state);
  }
}

/** Numeric compare of Slack ts strings ("1503435956.000247"). String compare is
 *  unsafe across integer widths, so we parse. A malformed ts sorts as 0. */
function asNum(ts: string): number {
  const n = Number.parseFloat(ts);
  return Number.isFinite(n) ? n : 0;
}
function numGT(a: string, b: string): boolean {
  return asNum(a) > asNum(b);
}
function numLE(a: string, b: string): boolean {
  return asNum(a) <= asNum(b);
}

function load(path: string): CursorState {
  try {
    if (!existsSync(path)) return { ...EMPTY };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CursorState>;
    return {
      slackTs: typeof parsed.slackTs === "string" ? parsed.slackTs : "0",
      quorumOp: typeof parsed.quorumOp === "string" ? parsed.quorumOp : "",
      seenTs: Array.isArray(parsed.seenTs) ? parsed.seenTs.filter((t) => typeof t === "string") : [],
    };
  } catch {
    // A corrupt cursor file must not wedge the bridge. Start clean; the worst
    // case is one bounded re-backfill from Slack history, which dedups itself.
    return { ...EMPTY };
  }
}

/** Atomic write: serialize to a temp sibling, then rename over the target.
 *  rename() is atomic on POSIX, so a reader never sees a half-written file. */
function save(path: string, state: CursorState): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}
