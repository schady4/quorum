// Server-side durability for the relay. Without it a relay holds every room's
// op log (and blobs) in memory, so a restart forgets everything — clients can
// re-seed what they still hold, but a room whose members are all offline is
// lost. A RelayStore persists the append-only logs and the blob store so the
// relay reloads them on boot.
//
// Everything the store holds is exactly what the relay holds: sealed op values
// and opaque blob bytes. Persisting them keeps the zero-knowledge property — the
// bytes on disk are ciphertext the relay itself can't read.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";
import type { CheckpointOp } from "../net/protocol.js";

export interface RoomLog {
  ops: Op[];
  ledgerOps: LedgerOp[];
  checkpointOps: CheckpointOp[];
}

/** Per-member push/mute state — persisted so a member who's offline across a
 *  relay restart is still reachable (and still muted if they chose to be). */
export interface MemberState {
  /** handle -> device push tokens. */
  pushTokens: Record<string, string[]>;
  /** handles that muted the room. */
  muted: string[];
}

const EMPTY_MEMBERS: MemberState = { pushTokens: {}, muted: [] };

export interface RelayStore {
  /** Room names that have persisted state (so the relay can preload them). */
  rooms(): string[];
  /** Load a room's persisted logs (empty arrays when nothing is stored). */
  load(room: string): RoomLog;
  appendOp(room: string, op: Op): void;
  appendLedger(room: string, op: LedgerOp): void;
  appendCheckpoint(room: string, op: CheckpointOp): void;
  /** Persist a sealed blob; loadBlob returns null when absent. */
  saveBlob(room: string, id: string, bytes: Uint8Array): void;
  loadBlob(room: string, id: string): Uint8Array | null;
  /** Per-member push/mute state (empty when none stored). */
  loadMembers(room: string): MemberState;
  saveMembers(room: string, state: MemberState): void;
}

type LogLine =
  | { t: "op"; op: Op }
  | { t: "ledger"; op: LedgerOp }
  | { t: "checkpoint"; op: CheckpointOp };

/** In-memory store — for tests, or a relay that wants to hand its state to
 *  something else. Persists across `startRelay` calls that share the instance. */
export class MemoryRelayStore implements RelayStore {
  private logs = new Map<string, LogLine[]>();
  private blobs = new Map<string, Uint8Array>();
  private lines(room: string): LogLine[] {
    let l = this.logs.get(room);
    if (!l) this.logs.set(room, (l = []));
    return l;
  }
  rooms(): string[] {
    return [...this.logs.keys()];
  }
  load(room: string): RoomLog {
    const out: RoomLog = { ops: [], ledgerOps: [], checkpointOps: [] };
    for (const l of this.logs.get(room) ?? []) {
      if (l.t === "op") out.ops.push(l.op);
      else if (l.t === "ledger") out.ledgerOps.push(l.op);
      else out.checkpointOps.push(l.op);
    }
    return out;
  }
  appendOp(room: string, op: Op): void { this.lines(room).push({ t: "op", op }); }
  appendLedger(room: string, op: LedgerOp): void { this.lines(room).push({ t: "ledger", op }); }
  appendCheckpoint(room: string, op: CheckpointOp): void { this.lines(room).push({ t: "checkpoint", op }); }
  saveBlob(room: string, id: string, bytes: Uint8Array): void { this.blobs.set(`${room}/${id}`, bytes); }
  loadBlob(room: string, id: string): Uint8Array | null { return this.blobs.get(`${room}/${id}`) ?? null; }
  private members = new Map<string, MemberState>();
  loadMembers(room: string): MemberState { return this.members.get(room) ?? { ...EMPTY_MEMBERS }; }
  saveMembers(room: string, state: MemberState): void { this.members.set(room, state); }
}

/** Disk-backed store. Each room is a directory holding an append-only NDJSON log
 *  (one line per op) and a `blobs/` folder of sealed byte files. */
export class FileRelayStore implements RelayStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Room names are arbitrary; map them to a stable, filesystem-safe directory.
  private roomDir(room: string): string {
    const safe = room.replace(/[^\w.-]/g, "_").slice(0, 64);
    const hash = createHash("sha256").update(room).digest("hex").slice(0, 8);
    return path.join(this.dir, `${safe}-${hash}`);
  }
  private logPath(room: string): string {
    return path.join(this.roomDir(room), "log.ndjson");
  }
  private nameFile(room: string): string {
    return path.join(this.roomDir(room), "room");
  }
  private ensureRoom(room: string): string {
    const d = this.roomDir(room);
    fs.mkdirSync(path.join(d, "blobs"), { recursive: true });
    if (!fs.existsSync(this.nameFile(room))) fs.writeFileSync(this.nameFile(room), room, "utf8");
    return d;
  }

  rooms(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(this.dir)) {
      const name = path.join(this.dir, entry, "room");
      if (fs.existsSync(name)) out.push(fs.readFileSync(name, "utf8"));
    }
    return out;
  }

  load(room: string): RoomLog {
    const out: RoomLog = { ops: [], ledgerOps: [], checkpointOps: [] };
    const p = this.logPath(room);
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      if (!line) continue;
      let l: LogLine;
      try { l = JSON.parse(line) as LogLine; } catch { continue; }
      if (l.t === "op") out.ops.push(l.op);
      else if (l.t === "ledger") out.ledgerOps.push(l.op);
      else if (l.t === "checkpoint") out.checkpointOps.push(l.op);
    }
    return out;
  }

  private append(room: string, line: LogLine): void {
    this.ensureRoom(room);
    fs.appendFileSync(this.logPath(room), JSON.stringify(line) + "\n");
  }
  appendOp(room: string, op: Op): void { this.append(room, { t: "op", op }); }
  appendLedger(room: string, op: LedgerOp): void { this.append(room, { t: "ledger", op }); }
  appendCheckpoint(room: string, op: CheckpointOp): void { this.append(room, { t: "checkpoint", op }); }

  saveBlob(room: string, id: string, bytes: Uint8Array): void {
    this.ensureRoom(room);
    const safeId = id.replace(/[^\w.-]/g, "_");
    fs.writeFileSync(path.join(this.roomDir(room), "blobs", safeId), Buffer.from(bytes));
  }
  loadBlob(room: string, id: string): Uint8Array | null {
    const safeId = id.replace(/[^\w.-]/g, "_");
    const p = path.join(this.roomDir(room), "blobs", safeId);
    return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
  }

  private membersPath(room: string): string {
    return path.join(this.roomDir(room), "members.json");
  }
  loadMembers(room: string): MemberState {
    const p = this.membersPath(room);
    if (!fs.existsSync(p)) return { ...EMPTY_MEMBERS };
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<MemberState>;
      return { pushTokens: parsed.pushTokens ?? {}, muted: parsed.muted ?? [] };
    } catch {
      return { ...EMPTY_MEMBERS };
    }
  }
  saveMembers(room: string, state: MemberState): void {
    this.ensureRoom(room);
    fs.writeFileSync(this.membersPath(room), JSON.stringify(state));
  }
}
