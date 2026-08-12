import type { ProviderAdapter } from "./types.js";

// Kimi (Moonshot AI). Adapter stub — implemented in M3.
export const kimi: ProviderAdapter = {
  id: "kimi",
  label: "Kimi (Moonshot)",
  credentials: [
    { key: "MOONSHOT_API_KEY", label: "Moonshot/Kimi API key", required: true, secret: true },
  ],
  listModels: () => [
    { id: "kimi-k2", label: "Kimi K2", strengths: ["long-context", "general"] },
  ],
  async generate() {
    throw new Error("kimi.generate(): implemented in M3");
  },
};
