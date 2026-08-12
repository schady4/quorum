import type { ProviderAdapter } from "./types.js";

// Local / open-source models via an OpenAI-compatible server (Ollama, llama.cpp,
// vLLM, LM Studio, ...). No API key by default; just a base URL. This is the
// "any open-source model" path. Adapter stub — implemented in M3.
export const local: ProviderAdapter = {
  id: "local",
  label: "Local / open-source (OpenAI-compatible)",
  credentials: [
    { key: "LOCAL_BASE_URL", label: "Local server base URL (e.g. http://localhost:11434/v1)", required: true, secret: false },
    { key: "LOCAL_API_KEY", label: "API key (optional; many local servers need none)", required: false, secret: true },
  ],
  // Local models are user-defined; M3 fetches the server's model list at init.
  listModels: () => [],
  async generate() {
    throw new Error("local.generate(): implemented in M3");
  },
};
