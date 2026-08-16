// The router — Quorum's switchboard, and the piece that makes it multi-model.
//
// Two jobs:
//   1. route(task) -> { provider, model }   pick who answers a given request
//   2. delegate(...)                        spin up a new instance on a chosen
//                                           model that joins the room as its
//                                           own participant
//
// M3 fixed the shapes; this file now carries a real policy. The policy is a
// pure function of the request's *intent* (a RouteHint) and the strengths each
// provider advertises for its models — no I/O beyond listModels, so it stays
// trivially testable. Callers are unchanged: an explicit preference still wins,
// and a hint with no `kind` still resolves to the first registered model, so
// every existing call keeps its old behavior.

import { providers, getProvider } from "../providers/index.js";
import type { GenerateRequest, GenerateResult, ModelInfo, ProviderAdapter } from "../providers/types.js";

export interface RouteHint {
  /** Free-form intent, e.g. "code", "summarize", "arbitrate-merge". */
  kind?: string;
  /** Coarse effort tier. Scales model choice up/down independent of `kind` —
   *  the "match effort to query complexity" lever. Omit to let `kind` decide. */
  effort?: "low" | "high";
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

// Which model strengths a given intent wants, most-wanted first. The router
// scores each candidate by how well its advertised `strengths` overlap this
// list, weighting earlier entries higher. Kinds absent here score flat and fall
// back to registration order — exactly the old default.
const KIND_PROFILE: Record<string, string[]> = {
  code: ["code", "reasoning"],
  reasoning: ["reasoning", "code"],
  plan: ["reasoning", "code"],
  "arbitrate-merge": ["reasoning", "code"],
  analyze: ["reasoning", "long-context"],
  summarize: ["speed", "general"],
  compact: ["speed", "cheap"],
  chat: ["general", "speed"],
  general: ["general"],
};

// Effort tiers nudge the profile without needing a distinct `kind`: a "low"
// effort request biases toward fast/cheap models even for a reasoning-shaped
// task, and "high" biases toward the strong ones. These strengths are appended
// to the kind profile at a lower weight, so they break ties rather than
// overriding a clear intent.
const EFFORT_BIAS: Record<"low" | "high", string[]> = {
  low: ["cheap", "speed"],
  high: ["reasoning", "code"],
};

/** The ranked list of desired strengths for a hint: kind first, effort as a
 *  tie-breaker appended after. Deduped, order preserved. */
export function profileFor(hint: RouteHint): string[] {
  const base = (hint.kind && KIND_PROFILE[hint.kind]) || [];
  const bias = hint.effort ? EFFORT_BIAS[hint.effort] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...base, ...bias]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/** Score a model against a ranked strength profile. Earlier strengths in the
 *  profile are worth more, so a model that nails the top priority beats one
 *  that only matches a lesser one. A model with no strengths (or an empty
 *  profile) scores 0 and defers to ordering. */
export function scoreModel(model: ModelInfo, profile: string[]): number {
  if (!model.strengths || profile.length === 0) return 0;
  let score = 0;
  for (let i = 0; i < profile.length; i++) {
    if (model.strengths.includes(profile[i])) score += profile.length - i;
  }
  return score;
}

/** A lightweight heuristic for the effort dimension: does this message look
 *  like it warrants a frontier model, or is it small talk? Callers (e.g. the
 *  responder) use it so a "hey what's up" doesn't spend a reasoning model while
 *  a code review or design question does. Deliberately cheap and conservative —
 *  it only ever *raises* effort on strong signals, defaulting to low. */
export function classifyEffort(text: string): "low" | "high" {
  const t = text.toLowerCase();
  if (/```|\bfunction\b|\bclass\b|=>|\bdef\b/.test(text)) return "high";
  if (/\b(why|how come|design|architect|debug|prove|analyze|analyse|trade-?off|refactor|optimi[sz]e|reconcile)\b/.test(t)) return "high";
  if (text.length > 320) return "high";
  return "low";
}

async function modelsOf(p: ProviderAdapter): Promise<ModelInfo[]> {
  return Promise.resolve(p.listModels());
}

/** Best model within one provider for a profile: highest score, ties broken by
 *  the provider's own listing order (index 0 first). Returns null if the
 *  provider exposes no models. */
async function bestModel(p: ProviderAdapter, profile: string[]): Promise<ModelInfo | null> {
  const models = await modelsOf(p);
  if (models.length === 0) return null;
  let best = models[0];
  let bestScore = scoreModel(best, profile);
  for (let i = 1; i < models.length; i++) {
    const s = scoreModel(models[i], profile);
    if (s > bestScore) {
      best = models[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * Choose which provider/model should handle a request.
 *
 * Order of precedence:
 *   1. An explicit preferModel is used verbatim (paired with its provider).
 *   2. With a preferProvider but no model, the best model *within that
 *      provider* for the hint's profile is chosen (not merely the first).
 *   3. With no preference, every registered provider's models are scored and
 *      the global best wins; ties fall back to registration + listing order,
 *      which reproduces the old "first provider, first model" default when the
 *      profile is empty.
 */
export async function route(hint: RouteHint = {}): Promise<RouteDecision> {
  const profile = profileFor(hint);

  // (1) / (2): an explicit provider preference.
  if (hint.preferProvider) {
    const p = getProvider(hint.preferProvider);
    if (!p) throw new Error(`Unknown provider: ${hint.preferProvider}`);
    if (hint.preferModel) {
      return { provider: p.id, model: hint.preferModel, reason: "explicit provider + model" };
    }
    const model = await bestModel(p, profile);
    if (!model) throw new Error(`Provider ${p.id} exposes no models`);
    const reason = profile.length
      ? `best ${p.id} model for ${describe(hint)}: ${model.label}`
      : `default ${p.id} model`;
    return { provider: p.id, model: model.id, reason };
  }

  // A bare preferModel with no provider: honor it against the first provider
  // that lists it, else the first provider overall (keeps old lenient behavior).
  if (hint.preferModel) {
    for (const p of providers) {
      const models = await modelsOf(p);
      if (models.some((m) => m.id === hint.preferModel)) {
        return { provider: p.id, model: hint.preferModel, reason: "explicit model" };
      }
    }
    const p = providers[0];
    if (!p) throw new Error("No providers registered");
    return { provider: p.id, model: hint.preferModel, reason: "explicit model (unlisted)" };
  }

  // (3): no preference — score across every provider.
  let winner: { provider: string; model: ModelInfo } | null = null;
  let winnerScore = -1;
  for (const p of providers) {
    const models = await modelsOf(p);
    for (const m of models) {
      const s = scoreModel(m, profile);
      if (s > winnerScore) {
        winner = { provider: p.id, model: m };
        winnerScore = s;
      }
    }
  }
  if (!winner) throw new Error("No providers expose any models");
  const reason = profile.length && winnerScore > 0
    ? `best model for ${describe(hint)}: ${winner.model.label}`
    : "default route (first available model)";
  return { provider: winner.provider, model: winner.model.id, reason };
}

function describe(hint: RouteHint): string {
  return [hint.kind, hint.effort && `${hint.effort}-effort`].filter(Boolean).join("/") || "request";
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

// Delegation — an agent spinning up a new instance on a chosen model to own a
// subtask — lives in the agent layer (agent/spawn.ts), where it has the room
// and participant machinery to attach a child seat to. The router's job is the
// model choice above; the spawner uses it when building each child's responder.
