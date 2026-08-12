import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { openaiCompatibleGenerate } from "./openai-compatible.js";

// OpenAI. The canonical OpenAI-compatible endpoint; OPENAI_BASE_URL overrides it
// for proxies or Azure-style hosts.
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
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    return openaiCompatibleGenerate(creds.OPENAI_BASE_URL || "https://api.openai.com/v1", creds.OPENAI_API_KEY, req);
  },
};
