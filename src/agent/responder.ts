// A responder turns the room's converged transcript into the AI seat's next
// message, going through the router (which model answers?) and a provider
// adapter (how to call it). Swapping the provider or model changes nothing
// here — that is the whole point of the router + adapter seam.

import { route, classifyEffort } from "../router/index.js";
import { getProvider } from "../providers/index.js";
import { loadCredentials, missingRequired } from "../config/credentials.js";
import type { Entry } from "../core/crdt.js";

export type Responder = (entries: Entry[], self: string) => Promise<string>;

export interface ResponderOptions {
  /** Preferred provider id (e.g. "anthropic"). Omit to let the router decide. */
  providerId?: string;
  /** Preferred model id. Omit for the provider's default. */
  model?: string;
  /** Override the system prompt. */
  system?: string;
  maxTokens?: number;
  /** Intent for the router. Defaults to "chat"; a delegated worker with a
   *  narrower job can pass e.g. "summarize" or "code". */
  kind?: string;
  /** Fix the effort tier instead of inferring it from the message. Omit to let
   *  the responder scale effort to the triggering message's apparent difficulty. */
  effort?: "low" | "high";
}

function defaultSystem(self: string): string {
  return (
    `You are "${self}", a participant in a multiplayer terminal chat shared by ` +
    `humans and other AI participants. Everyone sees the same message stream. ` +
    `Keep replies short and useful — one or two sentences. Reply with only your ` +
    `message text, no name prefix and no preamble.`
  );
}

/** Build a router-backed responder. The transcript is sent as a single user
 *  turn, which keeps the call portable across providers with different
 *  multi-turn/alternation rules. */
export function createModelResponder(opts: ResponderOptions = {}): Responder {
  return async (entries, self) => {
    // Scale model effort to the message we're actually answering: the newest
    // entry that isn't ours. Small talk stays on a fast model; a design or code
    // question earns a stronger one. An explicit opts.effort overrides.
    const trigger = [...entries].reverse().find((e) => e.author !== self);
    const effort = opts.effort ?? (trigger ? classifyEffort(trigger.value) : "low");
    // A hard message shifts intent, not just tier: "chat" small talk stays on a
    // fast generalist, while a design/code question routes to a reasoning model.
    const kind = opts.kind ?? (effort === "high" ? "reasoning" : "chat");
    const decision = await route({
      preferProvider: opts.providerId,
      preferModel: opts.model,
      kind,
      effort,
    });
    const provider = getProvider(decision.provider);
    if (!provider) throw new Error(`Unknown provider: ${decision.provider}`);

    const creds = loadCredentials(provider);
    const missing = missingRequired(provider, creds);
    if (missing.length) {
      throw new Error(`Missing credentials for ${provider.id}: ${missing.join(", ")} (set them as environment variables)`);
    }

    const transcript = entries.map((e) => `${e.author}: ${e.value}`).join("\n");
    const result = await provider.generate(
      {
        model: decision.model,
        system: opts.system ?? defaultSystem(self),
        maxTokens: opts.maxTokens ?? 400,
        messages: [{ role: "user", content: `${transcript}\n\nWrite the next message as ${self}.` }],
      },
      creds,
    );
    return result.text.trim();
  };
}

// --- Scoped delegation --------------------------------------------------------
// A delegated worker is the isolated-context half of Quorum's multi-agent story.
// A conversational seat (above) reads the whole converged surface — good for
// staying in the discussion, but it means every seat re-processes the entire
// room and can get pulled into it. A worker instead answers one assigned subtask
// from a *bounded* slice of context and publishes a single result back into the
// room — the shared coordination + provenance layer — without joining the chat.

export interface DelegateResponderOptions extends ResponderOptions {
  /** How many recent room entries to include as background, excluding the
   *  assignment and the worker's own messages. Bounds the worker's context
   *  instead of feeding it the whole transcript. Default 6. */
  contextWindow?: number;
}

function defaultWorkerSystem(self: string): string {
  return (
    `You are "${self}", an AI worker delegated a single, specific subtask in a ` +
    `shared multiplayer room. Do exactly that task and nothing else. Reply once ` +
    `with a self-contained result the group can use directly — no questions back, ` +
    `no preamble, no name prefix. Be concise and, where it helps, structured.`
  );
}

/** The task a worker was handed: the newest entry that @mentions it, with the
 *  mention stripped. Falls back to the newest message that isn't the worker's
 *  own. Also returns that entry's id so the caller can exclude it from context. */
export function extractAssignment(entries: Entry[], self: string): { task: string; assignmentId?: string } {
  const tag = `@${self.toLowerCase()}`;
  const strip = new RegExp(`@${self}\\b`, "ig");
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.author === self) continue;
    if (e.value.toLowerCase().includes(tag)) {
      return { task: e.value.replace(strip, "").trim(), assignmentId: e.id };
    }
  }
  const last = [...entries].reverse().find((e) => e.author !== self);
  return { task: last?.value.trim() ?? "", assignmentId: last?.id };
}

/** Build a responder for a delegated worker: it answers its assigned subtask
 *  from a bounded tail of room context rather than the full converged
 *  transcript, and routes by the task's own apparent effort. */
export function createDelegateResponder(opts: DelegateResponderOptions = {}): Responder {
  const windowN = opts.contextWindow ?? 6;
  return async (entries, self) => {
    const { task, assignmentId } = extractAssignment(entries, self);

    const decision = await route({
      preferProvider: opts.providerId,
      preferModel: opts.model,
      kind: opts.kind ?? "general",
      effort: opts.effort ?? classifyEffort(task),
    });
    const provider = getProvider(decision.provider);
    if (!provider) throw new Error(`Unknown provider: ${decision.provider}`);

    const creds = loadCredentials(provider);
    const missing = missingRequired(provider, creds);
    if (missing.length) {
      throw new Error(`Missing credentials for ${provider.id}: ${missing.join(", ")} (set them as environment variables)`);
    }

    // Background: a bounded tail of the room for reference only — the task is
    // the instruction. Excludes the assignment itself and the worker's own turns.
    const background = entries
      .filter((e) => e.id !== assignmentId && e.author !== self)
      .slice(-windowN)
      .map((e) => `${e.author}: ${e.value}`)
      .join("\n");

    const content = background
      ? `Task:\n${task}\n\nBackground (room context, for reference only):\n${background}`
      : `Task:\n${task}`;

    const result = await provider.generate(
      {
        model: decision.model,
        system: opts.system ?? defaultWorkerSystem(self),
        maxTokens: opts.maxTokens ?? 600,
        messages: [{ role: "user", content }],
      },
      creds,
    );
    return result.text.trim();
  };
}
