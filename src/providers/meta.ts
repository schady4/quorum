import type { ProviderAdapter } from "./types.js";

// Meta / Llama. Hosted-Llama endpoint by default; point OPENAI-style base URLs
// at any Llama host. Adapter stub — implemented in M3.
export const meta: ProviderAdapter = {
  id: "meta",
  label: "Meta (Llama)",
  credentials: [
    { key: "LLAMA_API_KEY", label: "Llama host API key", required: true, secret: true },
    { key: "LLAMA_BASE_URL", label: "Llama host base URL", required: true, secret: false },
  ],
  listModels: () => [
    { id: "llama-4-maverick", label: "Llama 4 Maverick", strengths: ["general"] },
    { id: "llama-4-scout", label: "Llama 4 Scout", strengths: ["speed", "long-context"] },
  ],
  async generate() {
    throw new Error("meta.generate(): implemented in M3");
  },
};
