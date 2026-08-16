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
