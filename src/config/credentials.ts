// Credential loading. For now, credentials come from the environment; the
// first-run `quorum setup` flow (M5) will collect and store them, using each
// adapter's declared `credentials` to know what to ask for.

import type { ProviderAdapter } from "../providers/types.js";

/** Pull the credentials an adapter declares out of the environment. */
export function loadCredentials(provider: ProviderAdapter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of provider.credentials) {
    const v = process.env[c.key];
    if (v) out[c.key] = v;
  }
  return out;
}

/** Which required credentials are still missing. Empty ⇒ ready to call. */
export function missingRequired(provider: ProviderAdapter, creds: Record<string, string>): string[] {
  return provider.credentials.filter((c) => c.required && !creds[c.key]).map((c) => c.key);
}
