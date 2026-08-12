// The router — Quorum's switchboard, and the piece that makes it multi-model.
//
// Two jobs:
//   1. route(task) -> { provider, model }   pick who answers a given request
//   2. delegate(...)                        spin up a new instance on a chosen
//                                           model that joins the room as its
//                                           own participant
//
// M3 fills these in. This file fixes the shapes so the room protocol, the TUI,
// and the AI participant can be built against a stable seam before the routing
// policy exists.

import { providers, getProvider } from "../providers/index.js";
import type { GenerateRequest, GenerateResult } from "../providers/types.js";

export interface RouteHint {
  /** Free-form intent, e.g. "code", "summarize", "arbitrate-merge". */
  kind?: string;
  /** Caller's explicit preference; wins over policy when set. */
  preferProvider?: string;
  preferModel?: string;
}

export interface RouteDecision {
  provider: string;
  model: string;
  /** Why this route was chosen — surfaced in the room for provenance. */
  reason: string;
}

/**
 * Choose which provider/model should handle a request.
 *
 * Placeholder policy: honor an explicit preference, else fall back to the first
 * registered provider's first model. M3 replaces the body with real policy
 * (per-kind routing, cost/latency/strength weighting) without changing callers.
 */
export async function route(hint: RouteHint = {}): Promise<RouteDecision> {
  if (hint.preferProvider) {
    const p = getProvider(hint.preferProvider);
    if (!p) throw new Error(`Unknown provider: ${hint.preferProvider}`);
    const models = await p.listModels();
    const model = hint.preferModel ?? models[0]?.id;
    if (!model) throw new Error(`Provider ${p.id} exposes no models`);
    return { provider: p.id, model, reason: "explicit preference" };
  }

  const p = providers[0];
  if (!p) throw new Error("No providers registered");
  const models = await p.listModels();
  const model = hint.preferModel ?? models[0]?.id;
  if (!model) throw new Error(`Provider ${p.id} exposes no models`);
  return { provider: p.id, model, reason: "default route (M3: replace with policy)" };
}

/** Run one generation through whatever the router decided. */
export async function dispatch(
  req: Omit<GenerateRequest, "model">,
  creds: Record<string, string>,
  hint?: RouteHint,
): Promise<GenerateResult> {
  const decision = await route(hint);
  const provider = getProvider(decision.provider)!;
  return provider.generate({ ...req, model: decision.model }, creds);
}

/**
 * Delegation primitive (M3). An agent asks the router to spin up a new instance
 * on a chosen model to own a subtask; that instance joins the room as its own
 * participant and shares back to the group. Stubbed until the AI participant
 * (M2) and room protocol (M1) exist to attach it to.
 */
export async function delegate(_hint: RouteHint, _task: string): Promise<never> {
  throw new Error("delegate(): implemented in M3 (needs M1 room + M2 participant)");
}
