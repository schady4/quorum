// Room summaries — a cheap way for a client to learn "what's new" across many
// rooms without opening a socket to each. The relay answers, per room, with
// metadata it already has: the op count and the last op's time + author. It
// stays zero-knowledge — no message content, which it can't read.
//
// A client (e.g. a rooms list) compares the current count against the count it
// last saw to show an unread/activity badge, and uses lastTs/lastAuthor for a
// "last active" line. Pure `fetch`, so it's isomorphic (Node / browser / RN).

import { AUTH_HEADER } from "./blob.js";

export interface RoomSummary {
  /** Total ops in the room's log (append-only; includes reaction/edit control
   *  ops, which the relay can't distinguish — so treat it as activity, not a
   *  precise message count). */
  count: number;
  /** Time of the last op, when it carried one (epoch ms). */
  lastTs?: number;
  /** Author of the last op. */
  lastAuthor?: string;
}

export type SummaryResponse = Record<string, RoomSummary>;

/** Fetch summaries for a set of rooms from a relay's HTTP endpoint. */
export async function roomSummaries(base: string, rooms: string[], authToken?: string): Promise<SummaryResponse> {
  const qs = rooms.map((r) => encodeURIComponent(r)).join(",");
  const res = await fetch(`${base}/rooms/summary?rooms=${qs}`, {
    headers: { ...(authToken ? { [AUTH_HEADER]: authToken } : {}) },
  });
  if (!res.ok) throw new Error(`room summary failed (${res.status})`);
  return (await res.json()) as SummaryResponse;
}
