// A room client. Connects to a relay, keeps a local CRDT replica of the room's
// message stream, and turns "send a message" into one CRDT op anchored at the
// current tail. Concurrent messages from different participants converge by the
// same causal-tree rule that orders characters — the chat stream is just an RGA
// whose elements are whole messages instead of single characters.

import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createSurface, type CrdtSurface, type Entry, type InsertOp } from "../core/crdt.js";
import { Ledger, type LedgerOp, type MergeResolver } from "../core/ledger.js";
import type { BeliefState } from "../core/dag.js";
import { decode, encode, type CheckpointOp } from "./protocol.js";
import { roomCrypto, type RoomCrypto } from "./crypto.js";

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
  /** A drop was detected and a reconnect is scheduled. */
  reconnecting: (info: { attempt: number; delayMs: number }) => void;
  /** The relay refused the join (e.g. wrong room key). Terminal — no retry. */
  denied: (reason: string) => void;
  close: () => void;
  error: (err: Error) => void;
}

export class RoomClient extends EventEmitter {
  readonly clientId = newClientId();
  private surface: CrdtSurface = createSurface();
  readonly ledger = new Ledger();
  /** Durable seat progress: seat handle -> the chat entry ids it has handled. */
  private checkpoints = new Map<string, Set<string>>();
  /** End-to-end crypto derived from the room secret; identity for an open room. */
  private readonly crypto: RoomCrypto;
  /** Decrypted-value cache, keyed by op id (op values are immutable). */
  private readonly plain = new Map<string, string>();
  private counter = 0;
  private ws: WebSocket | null = null;
  participants: string[] = [];

  /** Reconnect backoff schedule. Public so callers (and tests) can tune it; the
   *  delay is baseMs * 2^attempt, capped at maxMs, plus up to 20% jitter. */
  readonly reconnect = { baseMs: 500, maxMs: 15_000 };
  private closing = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Client-side liveness. If a whole interval passes with no activity from the
   *  relay — no pong, message, or ping — the relay is presumed gone (sleep, NAT
   *  drop, crash) even though the socket never closed, so we terminate it and
   *  let the reconnect loop take over. Tunable by callers and tests. */
  readonly heartbeat = { intervalMs: 15_000 };
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sawActivity = false;

  constructor(
    readonly url: string,
    readonly room: string,
    readonly handle: string,
    /** Shared room secret. Derives the relay auth token and the E2E encryption
     *  key; never sent to the relay itself. Omit against an open relay. */
    readonly key?: string,
  ) {
    super();
    this.crypto = roomCrypto(key, room);
  }

  /** The surface, decrypted for readers. Everything above this boundary — the
   *  TUI, AI seats, @mention detection — sees plaintext; only the wire, the
   *  surface, and the relay hold ciphertext. Cached per op id. */
  private viewEntries(): Entry[] {
    return this.surface.entries().map((e) => {
      let v = this.plain.get(e.id);
      if (v === undefined) {
        v = this.crypto.dec(e.value);
        this.plain.set(e.id, v);
      }
      return { ...e, value: v };
    });
  }

  /** Seal a ledger op's content for the wire (edit value, merge resolved). */
  private encLedger(op: LedgerOp): LedgerOp {
    if (op.type === "edit") return { ...op, value: this.crypto.enc(op.value) };
    if (op.type === "merge") return { ...op, resolved: this.sealState(op.resolved, this.crypto.enc) };
    return op;
  }

  /** Open a ledger op received from the wire before it reaches the Ledger, which
   *  works on plaintext (its three-way merge compares values). */
  private decLedger(op: LedgerOp): LedgerOp {
    if (op.type === "edit") return { ...op, value: this.crypto.dec(op.value) };
    if (op.type === "merge") return { ...op, resolved: this.sealState(op.resolved, this.crypto.dec) };
    return op;
  }

  private sealState(state: BeliefState, fn: (s: string) => string): BeliefState {
    const out: BeliefState = {};
    for (const k of Object.keys(state)) out[k] = fn(state[k]);
    return out;
  }

  connect(): void {
    this.closing = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0; // a successful connection resets the backoff
      ws.send(encode({ t: "hello", room: this.room, handle: this.handle, auth: this.crypto.authToken, clientId: this.clientId }));
      this.startHeartbeat();
      this.emit("open");
    });

    // Any traffic from the relay — a frame, a pong to our ping, or its own ping
    // — proves it's still there. The library auto-answers relay pings for us.
    ws.on("pong", () => (this.sawActivity = true));
    ws.on("ping", () => (this.sawActivity = true));

    ws.on("message", (data: Buffer) => {
      this.sawActivity = true;
      const msg = decode(data.toString());
      if (msg.t === "welcome") {
        for (const op of msg.ops) this.surface.apply(op);
        for (const op of msg.ledgerOps) this.ledger.apply(this.decLedger(op));
        // Seed progress before the first update fires, so a rejoining seat knows
        // what it already handled before it decides what to answer.
        for (const op of msg.checkpointOps ?? []) this.applyCheckpoint(op);
        this.participants = msg.participants;
        this.emit("presence", this.participants);
        this.emit("update", this.viewEntries());
        this.emit("ledger", this.ledger);
      } else if (msg.t === "op") {
        this.surface.apply(msg.op);
        this.emit("update", this.viewEntries());
      } else if (msg.t === "ledger") {
        this.ledger.apply(this.decLedger(msg.op));
        this.emit("ledger", this.ledger);
      } else if (msg.t === "checkpoint") {
        this.applyCheckpoint(msg.op);
        this.emit("checkpoint", msg.op);
      } else if (msg.t === "presence") {
        this.participants = msg.participants;
        this.emit("presence", this.participants);
      } else if (msg.t === "denied") {
        // A refused join won't succeed on retry — stop the reconnect loop and
        // surface the reason. Prefer a "denied" listener; fall back to "error".
        this.closing = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.listenerCount("denied")) this.emit("denied", msg.reason);
        else if (this.listenerCount("error")) this.emit("error", new Error(`join denied: ${msg.reason}`));
      }
    });

    ws.on("close", () => {
      this.stopHeartbeat();
      this.emit("close");
      if (!this.closing) this.scheduleReconnect();
    });
    // Guard the emit: with no "error" listener attached, a bare EventEmitter
    // 'error' would throw and crash the process — exactly what we don't want
    // during a transient drop, where the reconnect loop is the recovery path.
    ws.on("error", (err: Error) => {
      if (this.listenerCount("error")) this.emit("error", err);
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sawActivity = true; // a fresh connection starts alive
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (!this.sawActivity) {
        // A whole interval of silence: the relay is gone but the socket never
        // closed. Kill it ourselves so `close` fires and reconnect takes over.
        this.stopHeartbeat();
        this.ws.terminate();
        return;
      }
      this.sawActivity = false;
      try {
        this.ws.ping();
      } catch {
        /* socket not writable — the next tick's readyState check handles it */
      }
    }, this.heartbeat.intervalMs);
    this.heartbeatTimer.unref?.(); // never keep the process alive just for this
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const n = this.attempt++;
    const base = Math.min(this.reconnect.maxMs, this.reconnect.baseMs * 2 ** n);
    const delay = Math.round(base + Math.random() * base * 0.2);
    this.emit("reconnecting", { attempt: n + 1, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) this.open();
    }, delay);
  }

  /** True only while the socket is open and ready to transmit. */
  private get live(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Post a message: apply locally for instant echo, then broadcast the op.
   *  During a reconnect window the local echo still lands; the broadcast is
   *  simply skipped rather than throwing on a not-yet-open socket. */
  send(text: string): void {
    const op: InsertOp = {
      type: "insert",
      id: `${this.clientId}:${++this.counter}`,
      after: this.surface.tail(),
      value: this.crypto.enc(text), // ciphertext on the wire and in the surface
      author: this.handle,
    };
    this.surface.apply(op);
    this.emit("update", this.viewEntries());
    if (this.live) this.ws!.send(encode({ t: "op", op }));
  }

  entries(): Entry[] {
    return this.viewEntries();
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
    if (this.live) this.ws!.send(encode({ t: "checkpoint", op }));
  }

  private sendLedger(op: LedgerOp): void {
    this.ledger.apply(op); // the local Ledger holds plaintext
    this.emit("ledger", this.ledger);
    if (this.live) this.ws!.send(encode({ t: "ledger", op: this.encLedger(op) })); // wire holds ciphertext
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

  /** Intentional shutdown: cancel any pending reconnect and close the socket.
   *  Sets the `closing` flag so the drop that follows does not trigger a retry. */
  close(): void {
    this.closing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }
}
