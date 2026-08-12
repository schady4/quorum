import type { ProviderAdapter } from "./types.js";

// Anthropic (Claude). The one adapter with a working reference in the sibling
// repo (multiplayer-ai/src/lib/anthropic.js) to port from in M3.
export const anthropic: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  credentials: [
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", required: true, secret: true },
  ],
  listModels: () => [
    { id: "claude-opus-5", label: "Claude Opus 5", strengths: ["reasoning", "code"] },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", strengths: ["general", "speed"] },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", strengths: ["speed", "cheap"] },
  ],
  async generate() {
    throw new Error("anthropic.generate(): implemented in M3");
  },
};
