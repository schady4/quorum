// Credential loading. Values come from two places: the environment and the
// local store written by `quorum setup`. The environment wins, so a one-off
// `ANTHROPIC_API_KEY=… quorum agent …` overrides whatever is saved.

import type { ProviderAdapter } from "../providers/types.js";
import { loadStore } from "./store.js";

/** Resolve an adapter's declared credentials from env, then the local store. */
export function loadCredentials(provider: ProviderAdapter): Record<string, string> {
  const store = loadStore();
  const out: Record<string, string> = {};
  for (const c of provider.credentials) {
    const v = process.env[c.key] ?? store[c.key];
    if (v) out[c.key] = v;
  }
  return out;
}

/** Which required credentials are still missing. Empty ⇒ ready to call. */
export function missingRequired(provider: ProviderAdapter, creds: Record<string, string>): string[] {
  return provider.credentials.filter((c) => c.required && !creds[c.key]).map((c) => c.key);
}

/** The cheapest model an adapter offers, so a validation probe never reaches
 *  for the most expensive one. Falls back to whatever's listed first; a
 *  provider with no static list (e.g. "local", whose models live on the
 *  user's own server) returns undefined — nothing to probe against. */
function probeModel(models: { id: string; strengths?: string[] }[]): string | undefined {
  return models.find((m) => m.strengths?.includes("cheap"))?.id ?? models[0]?.id;
}

/**
 * Fire one minimal real call to confirm credentials actually work — not just
 * that they're present. This is what catches a bad or out-of-funds key at
 * `quorum setup` time instead of leaving it to silently fail on every future
 * @mention. Skipped (reported ok) for adapters with no listable default model,
 * since there's nothing meaningful to probe.
 */
export async function testProvider(
  provider: ProviderAdapter,
  creds: Record<string, string>,
): Promise<{ ok: boolean; message?: string }> {
  const model = probeModel(await provider.listModels());
  if (!model) return { ok: true };
  try {
    await provider.generate({ model, maxTokens: 5, messages: [{ role: "user", content: "Reply with just: OK" }] }, creds);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
