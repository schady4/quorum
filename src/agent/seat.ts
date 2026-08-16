// An AI participant. It joins a room exactly like a human — as a RoomClient —
// but its "input" is the converged message stream and its output is a model
// reply. This is the piece that makes the thing multiplayer *AI*: the AI holds
// a seat, it isn't a feature bolted onto one human's client.
//
// Two disciplines keep it well-behaved:
//   - loop guard: it never reacts to its own messages, and it responds to each
//     triggering message at most once.
//   - trigger policy: by default it speaks only when @mentioned, so AI seats
//     don't talk over the room or spiral into AI-to-AI loops. Swap the policy
//     for anything (always-on, addressed-questions-only) without touching the
//     model call.

import { RoomClient } from "../net/client.js";
import type { Entry } from "../core/crdt.js";
import type { Responder } from "./responder.js";

export type TriggerPolicy = (latest: Entry, entries: Entry[], self: string) => boolean;

/** Default: respond only when the message text @mentions this seat's handle. */
export const mentionTrigger: TriggerPolicy = (latest, _entries, self) =>
  latest.value.toLowerCase().includes(`@${self.toLowerCase()}`);

/** A request to spin up another AI seat on a chosen model to own a subtask. */
export interface DelegateSpec {
  handle: string;
  providerId?: string;
  model?: string;
  task: string;
}

// "@self delegate <handle> [using <provider>[/<model>]] to <task>"
const DELEGATE_RE =
  /delegate\s+(\S+?)(?:\s+using\s+([a-z0-9-]+)(?:\/([\w.:-]+))?)?\s+to\s+([\s\S]+)/i;

/** Parse a delegation directive addressed to `self`, or null if it isn't one. */
export function parseDelegate(text: string, self: string): DelegateSpec | null {
  if (!text.toLowerCase().includes(`@${self.toLowerCase()}`)) return null;
  const m = DELEGATE_RE.exec(text);
  if (!m) return null;
  return { handle: m[1].replace(/^@/, ""), providerId: m[2], model: m[3], task: m[4].trim() };
}

export interface AgentSeatOptions {
  relayUrl: string;
  room: string;
  handle: string;
  respond: Responder;
  shouldRespond?: TriggerPolicy;
  /** Handle a delegation directive by spinning up another seat. When set, a
   *  "@self delegate ..." message delegates instead of being answered. */
  onDelegate?: (spec: DelegateSpec) => void;
  onReply?: (text: string) => void;
  onError?: (err: Error) => void;
}

export class AgentSeat {
  private client: RoomClient;
  private busy = false;
  private handled = new Set<string>();
  private trigger: TriggerPolicy;

  constructor(private readonly opts: AgentSeatOptions) {
    this.client = new RoomClient(opts.relayUrl, opts.room, opts.handle);
    this.trigger = opts.shouldRespond ?? mentionTrigger;
    this.client.on("update", (entries: Entry[]) => {
      void this.onUpdate(entries);
    });
  }

  get roomClient(): RoomClient {
    return this.client;
  }

  start(): void {
    this.client.connect();
  }

  close(): void {
    this.client.close();
  }

  /** Fold the durable progress log into our in-memory handled set. On a fresh
   *  reconnect this is what stops the seat from re-answering messages a previous
   *  incarnation already handled — it resumes instead of repeating. */
  private syncCheckpoints(): void {
    for (const id of this.client.handledBy(this.opts.handle)) this.handled.add(id);
  }

  /** Newest message worth answering: skip our own, stop at anything already
   *  handled (older is older), return the first that trips the trigger. */
  private pickTarget(entries: Entry[]): Entry | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.author === this.opts.handle) continue;
      if (this.handled.has(e.id)) break;
      if (this.trigger(e, entries, this.opts.handle)) return e;
    }
    return null;
  }

  private async onUpdate(entries: Entry[]): Promise<void> {
    if (this.busy) return; // finish the current reply first; re-drain after
    this.syncCheckpoints(); // resume from durable progress before choosing a target
    const target = this.pickTarget(entries);
    if (!target) return;

    this.handled.add(target.id);

    // A delegation directive takes precedence over answering it directly.
    if (this.opts.onDelegate) {
      const spec = parseDelegate(target.value, this.opts.handle);
      if (spec) {
        try {
          this.client.send(`spinning up @${spec.handle} (${spec.providerId ?? "default"}${spec.model ? "/" + spec.model : ""}) to: ${spec.task}`);
          this.opts.onDelegate(spec);
          this.client.checkpoint(target.id); // durably: this delegation is done
        } catch (err) {
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
    }

    this.busy = true;
    try {
      const reply = await this.opts.respond(entries, this.opts.handle);
      if (reply) {
        this.client.send(reply);
        this.client.checkpoint(target.id); // durably: this message is answered
        this.opts.onReply?.(reply);
      }
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.busy = false;
      // Catch anything that arrived while we were generating.
      const pending = this.pickTarget(this.client.entries());
      if (pending) void this.onUpdate(this.client.entries());
    }
  }
}
