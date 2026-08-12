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
