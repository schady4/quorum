import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { openaiCompatibleGenerate } from "./openai-compatible.js";

// Grok (xAI). OpenAI-compatible.
export const grok: ProviderAdapter = {
  id: "grok",
  label: "Grok (xAI)",
  credentials: [{ key: "XAI_API_KEY", label: "xAI API key", required: true, secret: true }],
  listModels: () => [
    { id: "grok-4", label: "Grok 4", strengths: ["general", "reasoning"] },
    { id: "grok-4-fast", label: "Grok 4 Fast", strengths: ["general", "fast"] },
  ],
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    return openaiCompatibleGenerate("https://api.x.ai/v1", creds.XAI_API_KEY, req);
  },
};
