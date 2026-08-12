// The single AI call that reconciles a genuine collision. Built as a
// MergeResolver so the ledger stays model-agnostic: it goes through the same
// router + provider adapters as everything else. Ported from the proof of
// context (multiplayer-ai/src/DagMergePoc.jsx :: mergeConflict).

import { route } from "../router/index.js";
import { getProvider } from "../providers/index.js";
import { loadCredentials, missingRequired } from "../config/credentials.js";
import type { MergeResolver } from "../core/ledger.js";
import type { BeliefState } from "../core/dag.js";

export interface MergeResolverOptions {
  providerId?: string;
  model?: string;
}

export function createMergeResolver(opts: MergeResolverOptions = {}): MergeResolver {
  return async (prep) => {
    const decision = await route({ preferProvider: opts.providerId, preferModel: opts.model });
    const provider = getProvider(decision.provider);
    if (!provider) throw new Error(`Unknown provider: ${decision.provider}`);
    const creds = loadCredentials(provider);
    const missing = missingRequired(provider, creds);
    if (missing.length) throw new Error(`Missing credentials for ${provider.id}: ${missing.join(", ")}`);

    const keys = prep.conflicts.map((c) => c.key);
    const system =
      "You reconcile conflicting edits in a shared workspace. Given a common " +
      "ancestor and two branches that changed the same keys incompatibly, choose " +
      "or synthesize the best value for each conflicted key. Reply with ONLY a " +
      'JSON object, no markdown: {"resolved": {"<key>": "<value>", ...}, "rationale": "<one sentence>"}.';
    const content =
      `Ancestor:\n${JSON.stringify(prep.ancestor)}\n\n` +
      `Branch A:\n${JSON.stringify(prep.a)}\n\n` +
      `Branch B:\n${JSON.stringify(prep.b)}\n\n` +
      `Conflicted keys:\n${JSON.stringify(keys)}`;

    const res = await provider.generate({ model: decision.model, system, maxTokens: 500, messages: [{ role: "user", content }] }, creds);
    const parsed = safeJson(res.text);

    // Take only the conflicted keys, coerced to strings; fall back to branch B.
    const resolved: BeliefState = {};
    for (const c of prep.conflicts) {
      const v = parsed?.resolved?.[c.key];
      resolved[c.key] = v != null ? String(v) : String(c.b ?? "");
    }
    const rationale = typeof parsed?.rationale === "string" ? parsed.rationale : undefined;
    return { resolved, rationale };
  };
}

function safeJson(text: string): { resolved?: Record<string, unknown>; rationale?: unknown } | null {
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}
