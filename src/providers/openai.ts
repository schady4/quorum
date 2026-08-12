import type { ProviderAdapter } from "./types.js";

// OpenAI. Adapter stub — implemented in M3.
export const openai: ProviderAdapter = {
  id: "openai",
  label: "OpenAI",
  credentials: [
    { key: "OPENAI_API_KEY", label: "OpenAI API key", required: true, secret: true },
    { key: "OPENAI_BASE_URL", label: "Base URL (optional, for proxies)", required: false, secret: false },
  ],
  listModels: () => [
    { id: "gpt-5", label: "GPT-5", strengths: ["general", "code"] },
    { id: "gpt-5-mini", label: "GPT-5 mini", strengths: ["speed", "cheap"] },
  ],
  async generate() {
    throw new Error("openai.generate(): implemented in M3");
  },
};
