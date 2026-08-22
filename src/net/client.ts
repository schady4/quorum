// A room client. Connects to a relay, keeps a local CRDT replica of the room's
// message stream, and turns "send a message" into one CRDT op anchored at the
// current tail. Concurrent messages from different participants converge by the
// same causal-tree rule that orders characters — the chat stream is just an RGA
// whose elements are whole messages instead of single characters.

import { Emitter } from "./emitter.js";
import { makeSocket } from "./ws-impl.js";
import { OPEN, type Socket } from "./socket.js";
import { createSurface, type CrdtSurface, type Entry, type InsertOp, type Op } from "../core/crdt.js";
import { Ledger, type LedgerOp, type MergeResolver } from "../core/ledger.js";
import type { BeliefState } from "../core/dag.js";
import { decode, encode, type CheckpointOp, type ClientMsg } from "./protocol.js";
import { roomCrypto, type RoomCrypto } from "./crypto.js";
import type { RoomStore, StoredKind } from "../session/store.js";

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

export class RoomClient extends Emitter<RoomClientEvents> {
  readonly clientId = newClientId();
  private surface: CrdtSurface = createSurface();
  readonly ledger = new Ledger();
  /** Decrypted ledger ops in apply order — the replayable decision-DAG history,
   *  which the live Ledger (a materialized view) doesn't keep. Used to persist
   *  and to serialize a session for a save. Deduped by op id. */
  private ledgerLog: LedgerOp[] = [];
  private ledgerSeen = new Set<string>();
  /** Durable seat progress: seat handle -> the chat entry ids it has handled. */
  private checkpoints = new Map<string, Set<string>>();
  /** End-to-end crypto derived from the room secret; identity for an open room. */
  private readonly crypto: RoomCrypto;
  /** Decrypted-value cache, keyed by op id (op values are immutable). */
  private readonly plain = new Map<string, string>();
  private counter = 0;
  private ws: Socket | null = null;
  participants: string[] = [];
  /** The subset of `participants` that are AI seats, per the relay. */
  agents: string[] = [];

  /** Optional durable store. When set, the client loads persisted frames on
   *  connect, appends every (sealed) frame it sees, and re-seeds the relay with
   *  anything the relay is missing — so any client is a backup that can restore
   *  a room the relay lost. Set it before connect(). */
  store?: RoomStore;
  private persistedIds = new Set<string>();
  private storeLoaded = false;

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
    /** Human or AI seat — reported to the relay so a human client can tell when
     *  it's the last one out (the torch is held by humans). */
    readonly kind: "human" | "agent" = "human",
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
    if (!this.storeLoaded) {
      this.storeLoaded = true;
      this.loadFromStore();
    }
    this.open();
  }

  /** Append a (sealed) frame to the durable store, once per op id. */
  private persist(t: StoredKind, op: { id: string }): void {
    if (!this.store || this.persistedIds.has(op.id)) return;
    this.persistedIds.add(op.id);
    this.store.append(this.room, { t, op });
  }

  /** Apply everything persisted for this room, so the client has its history
   *  before the relay's welcome (and even offline). Idempotent with the welcome. */
  private loadFromStore(): void {
    if (!this.store) return;
    for (const f of this.store.load(this.room)) {
      this.persistedIds.add((f.op as { id: string }).id);
      if (f.t === "op") this.surface.apply(f.op as Op);
      else if (f.t === "ledger") this.applyLedgerLocal(this.decLedger(f.op as LedgerOp));
      else if (f.t === "checkpoint") this.applyCheckpoint(f.op as CheckpointOp);
    }
  }

  /** After catch-up, push any persisted frames the relay didn't send back — so a
   *  relay that lost its memory is restored from this client's durable log. */
  private reseed(have: Set<string>): void {
    if (!this.store || !this.live) return;
    for (const f of this.store.load(this.room)) {
      if (!have.has((f.op as { id: string }).id)) this.ws!.send(encode({ t: f.t, op: f.op } as ClientMsg));
    }
  }

  private open(): void {
    const ws = makeSocket(this.url);
    this.ws = ws;

    ws.onOpen(() => {
      this.attempt = 0; // a successful connection resets the backoff
      ws.send(encode({ t: "hello", room: this.room, handle: this.handle, auth: this.crypto.authToken, clientId: this.clientId, kind: this.kind }));
      this.startHeartbeat();
      this.emit("open");
    });

    // Any traffic from the relay — a frame, a pong to our ping, or its own ping
    // — proves it's still there.
    ws.onActivity(() => (this.sawActivity = true));

    ws.onMessage((data: string) => {
      this.sawActivity = true;
      const msg = decode(data);
      if (msg.t === "welcome") {
        const have = new Set<string>();
        for (const op of msg.ops) {
          this.surface.apply(op);
          this.persist("op", op);
          have.add(op.id);
        }
        for (const op of msg.ledgerOps) {
          this.applyLedgerLocal(this.decLedger(op));
          this.persist("ledger", op);
          have.add(op.id);
        }
        // Seed progress before the first update fires, so a rejoining seat knows
        // what it already handled before it decides what to answer.
        for (const op of msg.checkpointOps ?? []) {
          this.applyCheckpoint(op);
          this.persist("checkpoint", op);
          have.add(op.id);
        }
        this.participants = msg.participants;
        this.agents = msg.agents ?? [];
        this.reseed(have); // restore the relay from our durable log if it lost anything
        this.emit("presence", this.participants);
        this.emit("update", this.viewEntries());
        this.emit("ledger", this.ledger);
      } else if (msg.t === "op") {
        this.surface.apply(msg.op);
        this.persist("op", msg.op);
        this.emit("update", this.viewEntries());
      } else if (msg.t === "ledger") {
        this.applyLedgerLocal(this.decLedger(msg.op));
        this.persist("ledger", msg.op);
        this.emit("ledger", this.ledger);
      } else if (msg.t === "checkpoint") {
        this.applyCheckpoint(msg.op);
        this.persist("checkpoint", msg.op);
        this.emit("checkpoint", msg.op);
      } else if (msg.t === "presence") {
        this.participants = msg.participants;
        this.agents = msg.agents ?? [];
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

    ws.onClose(() => {
      this.stopHeartbeat();
      this.emit("close");
      if (!this.closing) this.scheduleReconnect();
    });
    // Guard the emit: with no "error" listener attached, a bare EventEmitter
    // 'error' would throw and crash the process — exactly what we don't want
    // during a transient drop, where the reconnect loop is the recovery path.
    ws.onError((err: Error) => {
      if (this.listenerCount("error")) this.emit("error", err);
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Browser/RN can't send WS pings, so there's no client-side silence check
    // there — the relay's own keepalive still reaps a dead client.
    if (!this.ws?.canPing) return;
    this.sawActivity = true; // a fresh connection starts alive
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== OPEN) return;
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
    return this.ws?.readyState === OPEN;
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
    this.persist("op", op);
    this.emit("update", this.viewEntries());
    if (this.live) this.ws!.send(encode({ t: "op", op }));
  }

  /** Replay externally-built frames (e.g. from a saved .qdag bond) onto a room:
   *  seal each value, apply locally, and broadcast — preserving the *original*
   *  authors, unlike send() which authors as this client. This is how a bond is
   *  brought back to life; assumes a fresh room so the frames' after-chain lands
   *  cleanly. */
  replay(frames: { ops?: InsertOp[]; ledgerOps?: LedgerOp[] }): void {
    for (const op of frames.ops ?? []) {
      const sealed: InsertOp = { ...op, value: this.crypto.enc(op.value) };
      this.surface.apply(sealed);
      this.persist("op", sealed);
      if (this.live) this.ws!.send(encode({ t: "op", op: sealed }));
    }
    if (frames.ops?.length) this.emit("update", this.viewEntries());
    for (const op of frames.ledgerOps ?? []) {
      this.applyLedgerLocal(op); // the local Ledger holds plaintext
      const wire = this.encLedger(op);
      this.persist("ledger", wire);
      if (this.live) this.ws!.send(encode({ t: "ledger", op: wire }));
    }
    if (frames.ledgerOps?.length) this.emit("ledger", this.ledger);
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
    this.persist("checkpoint", op);
    if (this.live) this.ws!.send(encode({ t: "checkpoint", op }));
  }

  private sendLedger(op: LedgerOp): void {
    this.applyLedgerLocal(op); // the local Ledger + log hold plaintext
    const wire = this.encLedger(op); // wire + store hold ciphertext
    this.persist("ledger", wire);
    this.emit("ledger", this.ledger);
    if (this.live) this.ws!.send(encode({ t: "ledger", op: wire }));
  }

  /** Apply a plaintext ledger op to the live Ledger and record it in the
   *  replayable log (deduped), so the decision-DAG history can be saved/revived. */
  private applyLedgerLocal(op: LedgerOp): void {
    if (!this.ledgerSeen.has(op.id)) {
      this.ledgerSeen.add(op.id);
      this.ledgerLog.push(op);
    }
    this.ledger.apply(op);
  }

  /** The decrypted decision-DAG history in apply order — replay it to rebuild
   *  the ledger. The bond/save serializes this; the store persists it. */
  ledgerOps(): LedgerOp[] {
    return [...this.ledgerLog];
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
