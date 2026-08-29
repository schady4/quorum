// The Slack bridge engine — a third kind of seat on the bus.
//
// This is the whole bridge MINUS Slack's SDK and minus the network: it takes an
// injected `SlackGateway` (post to a channel / reply to a command) and a factory
// that mints room seats, so every rule below — per-user identity, inbound dedup,
// ordered outbound relay, `/quorum` dispatch, graceful shutdown — is exercised
// by test/bridge.test.ts with fakes, no live workspace required. The real Slack
// wiring is the thin adapter in bolt.ts.
//
// Design of record: docs/wiki/Slack-Bridge.md. The non-negotiables it enforces:
//   • Multiplayer AI + provenance — one RoomClient PER Slack user (Model B), so
//     native seats and AIs receive real {author, content} and address people by
//     name. That's what `makeSeat(handle, "human")` per user gives us.
//   • Keys never touch Slack — `/quorum key` is refused in commands.ts; seats are
//     summoned on the bridge host with ITS credentials, never a key from Slack.
//   • No data loss — inbound dedups by Slack `ts` (CursorStore), outbound seeds
//     from the room's existing log so a reconnect never re-spams history, and
//     both cursors persist atomically, so `kill -9` recovers identically.

import type { Entry } from "../../core/crdt.js";
import { parseQuorumCommand, QUORUM_HELP } from "./commands.js";
import type { CursorStore } from "./cursors.js";

/** The minimal room-seat surface the bridge uses — structurally satisfied by the
 *  SDK's `RoomClient`, and by the fake in tests. */
export interface RoomSeat {
  readonly handle: string;
  participants: string[];
  agents: string[];
  connect(): void;
  close(): void;
  send(text: string): void;
  fork(branches: string[]): void;
  setDecision(branch: string, key: string, value: string): void;
  merge(a: string, b: string): Promise<{ conflicts: number; arbitrated: boolean }>;
  entries(): Entry[];
  on(event: "update", fn: (entries: Entry[]) => void): unknown;
  on(event: "presence", fn: (participants: string[]) => void): unknown;
}

/** What the engine needs from Slack in the channel direction: `post` puts a
 *  message in the bridged channel (Quorum→Slack) and returns its `ts`. Replying
 *  to a `/quorum` command is a separate, per-invocation responder (each Slack
 *  command carries its own short-lived `response_url`), passed into
 *  `onSlackCommand` rather than held here. */
export interface SlackGateway {
  post(msg: { text: string; username?: string; quorumOp?: string }): Promise<string>;
}

/** Reply to a single `/quorum` invocation — ephemeral to the caller, or posted
 *  in-channel. One of these is handed to `onSlackCommand` per command. */
export type CommandResponder = (msg: { text: string; inChannel: boolean }) => Promise<void>;

/** One inbound Slack chat message (already resolved by the adapter). */
export interface InboundMessage {
  userId: string;
  userName: string;
  text: string;
  ts: string;
}

export interface BridgeOptions {
  gateway: SlackGateway;
  cursors: CursorStore;
  /** Mint a room seat bound to a handle. The bridge's own control seat is made
   *  with kind "agent"; each Slack user gets one with kind "human". */
  makeSeat: (handle: string, kind: "human" | "agent") => RoomSeat;
  /** Human-readable room/channel labels, for banners and status. */
  room: string;
  channel?: string;
  /** The bridge's own control-seat handle (issues fork/set/merge). */
  bridgeHandle?: string;
  /** Map a Slack user to a stable Quorum handle. Default: a slug of the name. */
  handleFor?: (user: { id: string; name: string }) => string;
  /** Seat an AI on the bridge host using ITS OWN credentials (never a Slack key).
   *  Returns a disposer. Absent ⇒ `/quorum agent` reports it's unavailable. */
  seatAgent?: (spec: { handle: string; provider?: string; model?: string }) => Promise<() => void>;
  /** Announce native joins/leaves into Slack. Default true. */
  announcePresence?: boolean;
  log?: (line: string) => void;
}

/** Default handle mapping: a filesystem-safe slug of the Slack display name. */
export function defaultHandleFor(user: { id: string; name: string }): string {
  const slug = (user.name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `slack-${user.id}`;
}

export class SlackBridge {
  private readonly gateway: SlackGateway;
  private readonly cursors: CursorStore;
  private readonly makeSeat: (handle: string, kind: "human" | "agent") => RoomSeat;
  private readonly handleFor: (user: { id: string; name: string }) => string;
  private readonly bridgeHandle: string;
  private readonly announcePresence: boolean;
  private readonly log: (line: string) => void;

  private outbound!: RoomSeat;
  /** One seat per active Slack user — real presence + provenance (Model B). */
  private readonly userSeats = new Map<string, RoomSeat>();
  /** Every handle the bridge itself authors as (control seat + all user seats).
   *  Entries by these authors ORIGINATED on the Slack side (or are the bridge's
   *  own control echoes) and must never be relayed back into Slack. */
  private readonly managed = new Set<string>();
  /** Quorum op ids already posted (or seeded as history) — outbound idempotency. */
  private readonly posted = new Set<string>();
  private readonly agentDisposers = new Map<string, () => void>();
  private lastPresence: string[] = [];
  private seeded = false;
  private pumping = false;
  private closing = false;

  constructor(private readonly opts: BridgeOptions) {
    this.gateway = opts.gateway;
    this.cursors = opts.cursors;
    this.makeSeat = opts.makeSeat;
    this.handleFor = opts.handleFor ?? defaultHandleFor;
    this.bridgeHandle = opts.bridgeHandle ?? "slack-bridge";
    this.announcePresence = opts.announcePresence ?? true;
    this.log = opts.log ?? (() => {});
  }

  /** Connect the control seat and start relaying. The control seat is also the
   *  bridge's ears: it holds a full room replica and drives the Quorum→Slack
   *  direction. */
  start(): void {
    this.managed.add(this.bridgeHandle);
    this.outbound = this.makeSeat(this.bridgeHandle, "agent");
    this.outbound.on("update", (entries: Entry[]) => this.onUpdate(entries));
    this.outbound.on("presence", (p: string[]) => this.onPresence(p));
    this.outbound.connect();
    this.log(`bridge starting: #${this.opts.channel ?? "?"} ⟷ ${this.opts.room}`);
  }

  // --- Quorum → Slack ---------------------------------------------------------

  private onUpdate(entries: Entry[]): void {
    if (!this.seeded) {
      // First view of the room = history. Seed it all as already-posted so a
      // fresh link (or a reconnect) never dumps the backlog into Slack. New
      // messages after this point are what we relay.
      for (const e of entries) this.posted.add(e.id);
      this.seeded = true;
      void this.gateway
        .post({ text: `🔗 bridged to Quorum room *${this.opts.room}* — messages here are shared outside Slack (other room members + any AI seats).` })
        .catch((err) => this.log(`banner failed: ${errMsg(err)}`));
      return;
    }
    void this.pump();
  }

  /** Drain unposted entries into Slack, one at a time, in order. Serialized so
   *  overlapping update events can't double-post or reorder; an entry is marked
   *  posted only after Slack confirms, so a failed post is retried on the next
   *  update rather than lost. */
  private async pump(): Promise<void> {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (;;) {
        const next = this.nextUnposted();
        if (!next) break;
        if (this.managed.has(next.author)) {
          // Slack-origin or bridge control echo — account for it, never echo back.
          this.posted.add(next.id);
          continue;
        }
        try {
          await this.gateway.post({ text: next.value, username: next.author, quorumOp: next.id });
        } catch (err) {
          this.log(`post failed (will retry): ${errMsg(err)}`);
          break; // leave it unposted; the next update re-enters the pump
        }
        this.posted.add(next.id);
        this.cursors.markOutbound(next.id);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** The earliest room entry we haven't accounted for yet, in sequence order. */
  private nextUnposted(): Entry | undefined {
    for (const e of this.outbound.entries()) if (!this.posted.has(e.id)) return e;
    return undefined;
  }

  private onPresence(participants: string[]): void {
    if (!this.announcePresence || !this.seeded) {
      this.lastPresence = participants;
      return;
    }
    const before = new Set(this.lastPresence);
    const after = new Set(participants);
    const joined = participants.filter((p) => !before.has(p) && !this.managed.has(p));
    const left = this.lastPresence.filter((p) => !after.has(p) && !this.managed.has(p));
    this.lastPresence = participants;
    for (const p of joined) void this.gateway.post({ text: `➕ *${p}* joined the room` }).catch(() => {});
    for (const p of left) void this.gateway.post({ text: `➖ *${p}* left the room` }).catch(() => {});
  }

  // --- Slack → Quorum ---------------------------------------------------------

  /** Relay one Slack chat message into the room, authored as that user's handle.
   *  Idempotent: a redelivered `ts` (Slack retries, or a post-restart backfill)
   *  is dropped. */
  onSlackMessage(msg: InboundMessage): void {
    if (this.closing) return;
    if (this.cursors.hasSeen(msg.ts)) {
      this.log(`skip duplicate ts=${msg.ts}`);
      return;
    }
    const text = msg.text.trim();
    if (!text) return;
    const seat = this.seatForUser(msg.userId, msg.userName);
    seat.send(text);
    // Advance the cursor only after the op is applied locally (send() applies
    // synchronously before it broadcasts), then persist atomically.
    this.cursors.markInbound(msg.ts);
  }

  private seatForUser(userId: string, userName: string): RoomSeat {
    let seat = this.userSeats.get(userId);
    if (!seat) {
      const handle = this.handleFor({ id: userId, name: userName });
      seat = this.makeSeat(handle, "human");
      this.managed.add(handle);
      this.userSeats.set(userId, seat);
      seat.connect();
      this.log(`seated Slack user ${userName} as @${handle}`);
    }
    return seat;
  }

  // --- /quorum commands -------------------------------------------------------

  async onSlackCommand(cmd: { userId: string; text: string }, respond: CommandResponder): Promise<void> {
    const parsed = parseQuorumCommand(cmd.text);
    switch (parsed.kind) {
      case "help":
        return respond({ text: QUORUM_HELP, inChannel: false });
      case "refused":
        return respond({ text: `⛔ ${parsed.reason}`, inChannel: false });
      case "error":
        return respond({ text: `⚠️ ${parsed.message}`, inChannel: false });

      case "status":
        return respond({ text: this.statusText(), inChannel: true });

      case "fork":
        this.outbound.fork([parsed.a, parsed.b]);
        return respond({ text: `🔱 forked into *${parsed.a}* and *${parsed.b}*`, inChannel: true });

      case "set":
        this.outbound.setDecision(parsed.branch, parsed.key, parsed.value);
        return respond({ text: `✏️ set *${parsed.key}* = \`${parsed.value}\` on *${parsed.branch}*`, inChannel: true });

      case "merge": {
        const r = await this.outbound.merge(parsed.a, parsed.b);
        const note = r.conflicts ? ` (${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"}${r.arbitrated ? ", AI-arbitrated" : ""})` : "";
        return respond({ text: `🔀 merged *${parsed.a}* + *${parsed.b}*${note}`, inChannel: true });
      }

      case "agent": {
        if (!this.opts.seatAgent) {
          return respond({
            text: "⛔ This bridge host has no AI seating configured. Run `quorum setup` on the host to add provider credentials.",
            inChannel: false,
          });
        }
        try {
          const dispose = await this.opts.seatAgent({ handle: parsed.handle, provider: parsed.provider, model: parsed.model });
          this.agentDisposers.set(parsed.handle, dispose);
          const via = parsed.provider ? ` (${parsed.provider}${parsed.model ? `/${parsed.model}` : ""})` : "";
          return respond({ text: `🤖 seated *@${parsed.handle}*${via} — mention it in the channel to talk.`, inChannel: true });
        } catch (err) {
          return respond({ text: `⚠️ couldn't seat @${parsed.handle}: ${errMsg(err)}`, inChannel: false });
        }
      }
    }
  }

  private statusText(): string {
    const live = (this.lastPresence.length ? this.lastPresence : this.outbound.participants).filter((p) => !this.managed.has(p));
    const ai = this.outbound.agents.filter((a) => !this.managed.has(a));
    const slackUsers = [...this.userSeats.values()].map((s) => s.handle);
    return [
      `*Quorum bridge* — #${this.opts.channel ?? "?"} ⟷ *${this.opts.room}*`,
      `• live in room: ${live.length ? live.join(", ") : "(none)"}`,
      `• AI seats: ${ai.length ? ai.join(", ") : "(none)"}`,
      `• Slack users bridged: ${slackUsers.length ? slackUsers.join(", ") : "(none)"}`,
      `• cursors: slackTs=${this.cursors.slackTs} quorumOp=${this.cursors.quorumOp || "(none)"}`,
    ].join("\n");
  }

  // --- Lifecycle --------------------------------------------------------------

  /** Graceful shutdown — a nicety, not a crutch: cursors already persisted after
   *  every relayed op, so a `kill -9` instead of this loses nothing. This just
   *  tidies up: announce offline, dispose AI seats, close sockets. */
  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.gateway.post({ text: "🔌 Quorum bridge going offline." });
    } catch {
      /* best-effort */
    }
    for (const [handle, dispose] of this.agentDisposers) {
      try {
        dispose();
      } catch (err) {
        this.log(`dispose ${handle} failed: ${errMsg(err)}`);
      }
    }
    this.agentDisposers.clear();
    for (const seat of this.userSeats.values()) {
      try {
        seat.close();
      } catch {
        /* ignore */
      }
    }
    this.userSeats.clear();
    try {
      this.outbound?.close();
    } catch {
      /* ignore */
    }
    this.log("bridge offline");
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
