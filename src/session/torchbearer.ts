// The torchbearer: when a chat is truly ending, the last human out is offered
// the chance to save it before it's gone. The torch is held by humans — AI seats
// don't decide, and don't keep a room "alive" for this purpose. Pure decision
// logic here (unit-testable); the interactive prompt lives in the TUI.

import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeSave, type Session } from "./qdag.js";

/** The humans in a room: everyone who isn't an AI seat. */
export function humansAmong(participants: string[], agents: string[]): string[] {
  const a = new Set(agents);
  return participants.filter((p) => !a.has(p));
}

/** Is `self` the only human left? This is who is offered the save on the way out
 *  — AI seats present or not, the torch passes only among humans. */
export function isLastHuman(participants: string[], agents: string[], self: string): boolean {
  const humans = humansAmong(participants, agents);
  return humans.length === 1 && humans[0] === self;
}

/** The prompt shown to the last human out. */
export function savePrompt(): string {
  return "You're the last one here — save this session before it's gone? [y/N] ";
}

/** A stable, filesystem-safe, timestamped filename for a room's save. */
export function saveFilename(room: string, at: Date = new Date()): string {
  const safe = room.replace(/[^a-zA-Z0-9._-]/g, "_") || "room";
  const ts = at.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19); // -> 2026-08-22-12-34-56
  return `${safe}-${ts}.qdag`;
}

/** Where saves land by default (~/.quorum/saves, or $QUORUM_CONFIG_DIR/saves). */
export function defaultSaveDir(): string {
  const base = process.env.QUORUM_CONFIG_DIR || join(homedir(), ".quorum");
  return join(base, "saves");
}

/** The one-liner shown after a save — how to bring the room back. */
export function reviveHint(path: string, sealed: boolean): string {
  return `Saved → ${path}\nRevive:  quorum open ${path}${sealed ? " --key <room-key>" : ""}`;
}

/** Stream a session out to a file — one chunk at a time, sealed when keyed, so
 *  even a huge session writes in bounded memory. */
export function writeSessionFile(session: Session, key: string | undefined, path: string): void {
  const fd = openSync(path, "w");
  try {
    let first = true;
    writeSave(
      session,
      (line) => {
        writeSync(fd, first ? line : "\n" + line);
        first = false;
      },
      { key },
    );
  } finally {
    closeSync(fd);
  }
}

/** Save a session under `dir`, returning the path written. */
export function saveSessionToDir(session: Session, key: string | undefined, dir: string = defaultSaveDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, saveFilename(session.room, new Date(session.created)));
  writeSessionFile(session, key, path);
  return path;
}
