import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { openaiCompatibleGenerate } from "./openai-compatible.js";

// Kimi (Moonshot AI). OpenAI-compatible; MOONSHOT_BASE_URL overrides the
// default region endpoint.
export const kimi: ProviderAdapter = {
  id: "kimi",
  label: "Kimi (Moonshot)",
  credentials: [
    { key: "MOONSHOT_API_KEY", label: "Moonshot/Kimi API key", required: true, secret: true },
    { key: "MOONSHOT_BASE_URL", label: "Base URL (optional, region override)", required: false, secret: false },
  ],
  listModels: () => [
    { id: "kimi-k2", label: "Kimi K2", strengths: ["long-context", "general"] },
  ],
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    return openaiCompatibleGenerate(creds.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1", creds.MOONSHOT_API_KEY, req);
  },
};
