import type { GenerateRequest, GenerateResult, ProviderAdapter } from "./types.js";

// Anthropic (Claude). Server-side call to the Messages API — unlike the browser
// demo in the sibling repo, there's no dangerous-direct-browser header here; the
// key stays on the machine running the seat.
const API_URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export const anthropic: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic (Claude)",
  credentials: [
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", required: true, secret: true },
  ],
  listModels: () => [
    { id: "claude-opus-5", label: "Claude Opus 5", strengths: ["reasoning", "code"] },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", strengths: ["general", "speed"] },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", strengths: ["speed", "cheap"] },
  ],
  async generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult> {
    const key = creds.ANTHROPIC_API_KEY;
    if (!key) throw new Error("NO_API_KEY");

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 400,
        system: req.system,
        messages: req.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
      }),
      signal: req.signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message || `Anthropic API error (${res.status})`);
    }

    const data = (await res.json()) as {
      content: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      text,
      usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens },
    };
  },
};
