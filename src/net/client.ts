// A room client. Connects to a relay, keeps a local CRDT replica of the room's
// message stream, and turns "send a message" into one CRDT op anchored at the
// current tail. Concurrent messages from different participants converge by the
// same causal-tree rule that orders characters — the chat stream is just an RGA
// whose elements are whole messages instead of single characters.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createSurface, type CrdtSurface, type Entry, type InsertOp } from "../core/crdt.js";
import { Ledger, type LedgerOp, type MergeResolver } from "../core/ledger.js";
import { decode, encode, type CheckpointOp } from "./protocol.js";

const NO_IDS: ReadonlySet<string> = new Set();

let _seq = 0;
/** A process-unique site id, so op ids never collide across clients. */
function newClientId(): string {
  return `${Date.now().toString(36)}-${(_seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface RoomClientEvents {
  update: (entries: Entry[]) => void;
  presence: (participants: string[]) => void;
  ledger: (ledger: Ledger) => void;
  checkpoint: (op: CheckpointOp) => void;
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
}

export class RoomClient extends EventEmitter {
  readonly clientId = newClientId();
  private surface: CrdtSurface = createSurface();
  readonly ledger = new Ledger();
  /** Durable seat progress: seat handle -> the chat entry ids it has handled. */
  private checkpoints = new Map<string, Set<string>>();
  private counter = 0;
  private ws: WebSocket | null = null;
  participants: string[] = [];

  constructor(
    readonly url: string,
    readonly room: string,
    readonly handle: string,
  ) {
    super();
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(encode({ t: "hello", room: this.room, handle: this.handle }));
      this.emit("open");
    });

    ws.on("message", (data: Buffer) => {
      const msg = decode(data.toString());
      if (msg.t === "welcome") {
        for (const op of msg.ops) this.surface.apply(op);
        for (const op of msg.ledgerOps) this.ledger.apply(op);
        // Seed progress before the first update fires, so a rejoining seat knows
        // what it already handled before it decides what to answer.
        for (const op of msg.checkpointOps ?? []) this.applyCheckpoint(op);
        this.participants = msg.participants;
        this.emit("presence", this.participants);
        this.emit("update", this.surface.entries());
        this.emit("ledger", this.ledger);
      } else if (msg.t === "op") {
        this.surface.apply(msg.op);
        this.emit("update", this.surface.entries());
      } else if (msg.t === "ledger") {
        this.ledger.apply(msg.op);
        this.emit("ledger", this.ledger);
      } else if (msg.t === "checkpoint") {
        this.applyCheckpoint(msg.op);
        this.emit("checkpoint", msg.op);
      } else if (msg.t === "presence") {
        this.participants = msg.participants;
        this.emit("presence", this.participants);
      }
    });

    ws.on("close", () => this.emit("close"));
    ws.on("error", (err: Error) => this.emit("error", err));
  }

  /** Post a message: apply locally for instant echo, then broadcast the op. */
  send(text: string): void {
    const op: InsertOp = {
      type: "insert",
      id: `${this.clientId}:${++this.counter}`,
      after: this.surface.tail(),
      value: text,
      author: this.handle,
    };
    this.surface.apply(op);
    this.emit("update", this.surface.entries());
    this.ws?.send(encode({ t: "op", op }));
  }

  entries(): Entry[] {
    return this.surface.entries();
  }

  private applyCheckpoint(op: CheckpointOp): void {
    let s = this.checkpoints.get(op.seat);
    if (!s) {
      s = new Set();
      this.checkpoints.set(op.seat, s);
    }
    s.add(op.handled);
  }

  /** The chat entry ids a given seat has durably recorded as handled — replayed
   *  from the relay on reconnect, so a seat can seed its progress on rejoin. */
  handledBy(seat: string): ReadonlySet<string> {
    return this.checkpoints.get(seat) ?? NO_IDS;
  }

  /** Record that this seat finished handling a chat entry. Applied locally and
   *  broadcast, so it survives a reconnect and every replica can see it. */
  checkpoint(handled: string): void {
    const op: CheckpointOp = { id: `${this.clientId}:${++this.counter}`, seat: this.handle, handled };
    this.applyCheckpoint(op);
    this.ws?.send(encode({ t: "checkpoint", op }));
  }

  private sendLedger(op: LedgerOp): void {
    this.ledger.apply(op);
    this.emit("ledger", this.ledger);
    this.ws?.send(encode({ t: "ledger", op }));
  }

  /** Fork the trunk decision-state into named branches. */
  fork(branches: string[]): void {
    this.sendLedger({ id: `${this.clientId}:${++this.counter}`, type: "fork", branches });
  }

  /** Advance one branch by setting a decision key. */
  setDecision(branch: string, key: string, value: string): void {
    this.sendLedger({
      id: `${this.clientId}:${++this.counter}`,
      type: "edit",
      branch,
      key,
      value,
      author: this.handle,
    });
  }

  /**
   * Merge two branches. Non-overlapping edits reconcile mechanically; if the
   * branches collide on a key and a resolver is supplied, it's called once (the
   * single AI arbitration) and its resolution rides inside the broadcast op so
   * every replica applies the same result. Returns whether arbitration ran.
   */
  async merge(a: string, b: string, resolver?: MergeResolver): Promise<{ conflicts: number; arbitrated: boolean }> {
    const prep = this.ledger.prepareMerge(a, b);
    let resolved = prep.merged;
    let viaArbitration = false;
    let rationale: string | undefined;

    if (prep.conflicts.length) {
      if (resolver) {
        const r = await resolver(prep);
        resolved = { ...prep.merged, ...r.resolved };
        viaArbitration = true;
        rationale = r.rationale;
      } else {
        rationale = "unresolved: no arbiter present (branches held at ancestor)";
      }
    }

    this.sendLedger({
      id: `${this.clientId}:${++this.counter}`,
      type: "merge",
      branches: [a, b],
      resolved,
      author: this.handle,
      viaArbitration,
      rationale,
    });
    return { conflicts: prep.conflicts.length, arbitrated: viaArbitration };
  }

  close(): void {
    this.ws?.close();
  }
}
