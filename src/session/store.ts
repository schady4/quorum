// Per-client persistence: the durable half of the storage story. A client that
// holds a store writes every op it sees to it and reloads them on start, so it
// keeps working across restarts and — because the frames are the exact sealed
// ones from the wire — any client can push its log back to re-seed a relay that
// lost its memory. Storage-at-rest is encrypted for free: we persist the sealed
// frames, never the plaintext.
//
// The interface is deliberately tiny and platform-swappable: a filesystem
// backend on Node/desktop, an IndexedDB backend on browser/mobile (a later
// phase). The client depends on the interface, not the backend.

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type StoredKind = "op" | "ledger" | "checkpoint";

/** One persisted frame — the sealed op exactly as it crossed the wire. */
export interface StoredFrame {
  t: StoredKind;
  op: unknown;
}

export interface RoomStore {
  /** Everything persisted for a room, in append order. */
  load(room: string): StoredFrame[];
  /** Durably append one frame. */
  append(room: string, frame: StoredFrame): void;
}

/** In-memory store — a test aid and a sensible default when nothing is durable. */
export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, StoredFrame[]>();
  load(room: string): StoredFrame[] {
    return [...(this.rooms.get(room) ?? [])];
  }
  append(room: string, frame: StoredFrame): void {
    const a = this.rooms.get(room) ?? [];
    a.push(frame);
    this.rooms.set(room, a);
  }
}

/** Filesystem store: append-only JSONL per room, sealed frames at rest. */
export class FileRoomStore implements RoomStore {
  constructor(private readonly dir: string = defaultDir()) {}

  private path(room: string): string {
    mkdirSync(this.dir, { recursive: true });
    return join(this.dir, safeName(room) + ".jsonl");
  }

  load(room: string): StoredFrame[] {
    const p = this.path(room);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredFrame);
  }

  append(room: string, frame: StoredFrame): void {
    appendFileSync(this.path(room), JSON.stringify(frame) + "\n");
  }
}

/** Rooms live under ~/.quorum/rooms (or $QUORUM_CONFIG_DIR/rooms for tests). */
function defaultDir(): string {
  const base = process.env.QUORUM_CONFIG_DIR || join(homedir(), ".quorum");
  return join(base, "rooms");
}

/** Keep a room name safe as a filename. */
function safeName(room: string): string {
  return room.replace(/[^a-zA-Z0-9._-]/g, "_") || "room";
}
