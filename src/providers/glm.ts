import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";
import { openaiCompatibleGenerate } from "./openai-compatible.js";

// GLM (Zhipu AI / Z.ai). OpenAI-compatible; ZHIPU_BASE_URL overrides the
// default international (Z.ai) endpoint, e.g. for the mainland China API.
export const glm: ProviderAdapter = {
  id: "glm",
  label: "GLM (Zhipu)",
  credentials: [
    { key: "ZHIPU_API_KEY", label: "Zhipu/Z.ai API key", required: true, secret: true },
    { key: "ZHIPU_BASE_URL", label: "Base URL (optional, region override)", required: false, secret: false },
  ],
  listModels: () => [
    { id: "glm-4.6", label: "GLM-4.6", strengths: ["general", "long-context"] },
    { id: "glm-4.5-air", label: "GLM-4.5 Air", strengths: ["fast"] },
  ],
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    return openaiCompatibleGenerate(creds.ZHIPU_BASE_URL || "https://api.z.ai/api/paas/v4", creds.ZHIPU_API_KEY, req);
  },
};
