// Provider registry. Registering an adapter here is the entire cost of adding a
// model vendor to Quorum — nothing downstream needs to know it exists.

import type { ProviderAdapter } from "./types.js";
import { anthropic } from "./anthropic.js";
import { openai } from "./openai.js";
import { meta } from "./meta.js";
import { kimi } from "./kimi.js";
import { local } from "./local.js";

export const providers: ProviderAdapter[] = [anthropic, openai, meta, kimi, local];

export function getProvider(id: string): ProviderAdapter | undefined {
  return providers.find((p) => p.id === id);
}

export type { ProviderAdapter } from "./types.js";
