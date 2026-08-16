// Spawning is delegation made real: build an AI seat, wired so it can itself
// spin up further seats. When a seat receives "@me delegate <handle> using
// <provider>/<model> to <task>", it creates that child seat on the chosen model
// and hands it the task through the room — so the child joins as its own
// participant and shares its work back to the group, exactly like any seat.

import { AgentSeat, type DelegateSpec } from "./seat.js";
import { createModelResponder, createDelegateResponder } from "./responder.js";

export interface SpawnConfig {
  relayUrl: string;
  room: string;
  handle: string;
  providerId?: string;
  model?: string;
  onReply?: (handle: string, text: string) => void;
  onError?: (handle: string, err: Error) => void;
  /** How long to let a spawned child join before handing it the task (ms). */
  handoffDelayMs?: number;
  /** A worker seat is scoped to one delegated subtask: it answers from a bounded
   *  slice of context and publishes a single result, instead of joining the chat
   *  on the full transcript. Delegated children are workers; the root seat isn't. */
  worker?: boolean;
}

/** Create, wire, and start an AI seat that can also delegate. Returns the seat
 *  so the caller can close it. Children are spawned with the same config shape,
 *  so delegation nests arbitrarily. */
export function spawnAgent(cfg: SpawnConfig): AgentSeat {
  const handoff = cfg.handoffDelayMs ?? 400;

  // A conversational participant reads the whole room; a delegated worker
  // answers one scoped subtask from bounded context. Same seat machinery either
  // way — only the responder differs.
  const respond = cfg.worker
    ? createDelegateResponder({ providerId: cfg.providerId, model: cfg.model })
    : createModelResponder({ providerId: cfg.providerId, model: cfg.model });

  const seat = new AgentSeat({
    relayUrl: cfg.relayUrl,
    room: cfg.room,
    handle: cfg.handle,
    respond,
    onReply: (t) => cfg.onReply?.(cfg.handle, t),
    onError: (e) => cfg.onError?.(cfg.handle, e),
    onDelegate: (spec: DelegateSpec) => {
      // Bring up the child on its chosen model...
      spawnAgent({
        relayUrl: cfg.relayUrl,
        room: cfg.room,
        handle: spec.handle,
        providerId: spec.providerId ?? cfg.providerId,
        model: spec.model,
        onReply: cfg.onReply,
        onError: cfg.onError,
        handoffDelayMs: handoff,
        worker: true, // scoped to the delegated subtask; nested delegation stays scoped too
      });
      // ...then hand it the task by addressing it in the room, once it's joined.
      setTimeout(() => seat.roomClient.send(`@${spec.handle} ${spec.task}`), handoff);
    },
  });

  seat.start();
  return seat;
}
