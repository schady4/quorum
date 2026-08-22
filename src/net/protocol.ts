// The room wire protocol. Deliberately tiny: the relay moves CRDT ops and
// presence, and nothing about convergence lives here — that's the replicas'
// job. Both directions are newline-free JSON frames over one WebSocket.

import type { Op } from "../core/crdt.js";
import type { LedgerOp } from "../core/ledger.js";

/** A durable progress marker: seat `seat` has finished handling chat entry
 *  `handled`. Stored and replayed by the relay like any op, so a seat that
 *  reconnects reconstructs what it already did and resumes instead of
 *  re-answering. Its own concern, kept out of the belief-state ledger. */
export interface CheckpointOp {
  id: string;
  seat: string;
  handled: string;
}

/** client -> server, first frame after connecting. The optional `key` is the
 *  shared room secret; a relay started with a key rejects a hello without the
 *  matching one. Omitted against an open (keyless) relay. */
export interface Hello {
  t: "hello";
  room: string;
  handle: string;
  /** Auth token derived from the room secret (never the secret itself). The
   *  relay gates joins on it; a one-way derivation, so the relay can't recover
   *  the secret or the encryption key. Omitted against an open relay. */
  auth?: string;
  /** Stable per-client id, unchanged across a client's reconnects. Lets the
   *  relay tell a reconnect (same id reclaims its handle) from a collision (a
   *  different client wanting a handle that's already live). */
  clientId?: string;
  /** Whether this seat is a human or an AI participant. Drives "last human out"
   *  detection — the torch is held by humans. Defaults to human when omitted. */
  kind?: "human" | "agent";
}

/** server -> client: the join was refused (e.g. wrong or missing room key).
 *  The socket is closed right after; the client should not retry. */
export interface Denied {
  t: "denied";
  reason: string;
}

/** server -> client, the catch-up frame: all op logs + who's here. */
export interface Welcome {
  t: "welcome";
  room: string;
  participants: string[];
  /** The subset of `participants` that are AI seats — so a client can tell who
   *  the humans are (participants minus agents). */
  agents: string[];
  ops: Op[];
  ledgerOps: LedgerOp[];
  checkpointOps: CheckpointOp[];
}

/** either direction: one CRDT (chat surface) op to integrate. */
export interface OpFrame {
  t: "op";
  op: Op;
}

/** either direction: one DAG ledger op (fork / edit / merge). */
export interface LedgerFrame {
  t: "ledger";
  op: LedgerOp;
}

/** either direction: one seat progress checkpoint. */
export interface CheckpointFrame {
  t: "checkpoint";
  op: CheckpointOp;
}

/** server -> clients: the room roster changed. */
export interface Presence {
  t: "presence";
  participants: string[];
  /** The subset of `participants` that are AI seats. */
  agents: string[];
}

/** either direction: an EPHEMERAL signal — typing state, read receipts, and the
 *  like. The relay fans it out to the other members and forgets it: never
 *  stored in the op log, never in a welcome catch-up, never in a saved bond. So
 *  it's the right channel for transient, high-frequency metadata that must not
 *  bloat the durable history. `sig` names the kind ("typing", "read", …), `from`
 *  is the sender's handle, `data` is kind-specific (structural metadata, sent in
 *  the clear like op ids and handles). */
export interface Signal {
  t: "signal";
  sig: string;
  from: string;
  data?: unknown;
}

/** client -> server: register a device push token for this member, so the relay
 *  can notify them of new messages while they're disconnected. The relay keys it
 *  by the joined handle and room and keeps it across reconnects. It only ever
 *  pushes metadata (who, which room) — never content, which it can't read. */
export interface RegisterPush {
  t: "register-push";
  /** An Expo push token (ExponentPushToken[…]). */
  token: string;
}

/** client -> server: mute (or unmute) push for this member in the joined room.
 *  A muted member is skipped by the relay's offline-notify, so the mute holds
 *  even when the app is closed. Kept across reconnects, keyed by handle. */
export interface SetMute {
  t: "set-mute";
  muted: boolean;
}

export type ClientMsg = Hello | OpFrame | LedgerFrame | CheckpointFrame | Signal | RegisterPush | SetMute;
export type ServerMsg = Welcome | OpFrame | LedgerFrame | CheckpointFrame | Presence | Denied | Signal;

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode(data: string): ClientMsg | ServerMsg {
  return JSON.parse(data) as ClientMsg | ServerMsg;
}
