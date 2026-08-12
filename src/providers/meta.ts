import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { openaiCompatibleGenerate } from "./openai-compatible.js";

// Meta / Llama. Llama is served by many OpenAI-compatible hosts, so the host's
// base URL is required; point it at whichever Llama endpoint you use.
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
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    if (!creds.LLAMA_BASE_URL) throw new Error("meta: LLAMA_BASE_URL is required");
    return openaiCompatibleGenerate(creds.LLAMA_BASE_URL, creds.LLAMA_API_KEY, req);
  },
};
