import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { openaiCompatibleGenerate } from "./openai-compatible.js";

// Local / open-source models via an OpenAI-compatible server (Ollama, llama.cpp,
// vLLM, LM Studio, ...). This is the "any open-source model" path: just a base
// URL, usually no key. Models are whatever the server hosts, so pass --model.
export const local: ProviderAdapter = {
  id: "local",
  label: "Local / open-source (OpenAI-compatible)",
  credentials: [
    { key: "LOCAL_BASE_URL", label: "Local server base URL (e.g. http://localhost:11434/v1)", required: true, secret: false },
    { key: "LOCAL_API_KEY", label: "API key (optional; many local servers need none)", required: false, secret: true },
  ],
  // The server defines its own model list; select one with --model.
  listModels: () => [],
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    if (!creds.LOCAL_BASE_URL) throw new Error("local: LOCAL_BASE_URL is required");
    return openaiCompatibleGenerate(creds.LOCAL_BASE_URL, creds.LOCAL_API_KEY, req);
  },
};
