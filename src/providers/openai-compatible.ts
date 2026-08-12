// One HTTP path shared by every OpenAI-compatible vendor: OpenAI itself, most
// hosted-Llama endpoints, Kimi/Moonshot, and local servers (Ollama, vLLM,
// llama.cpp, LM Studio). They all speak POST {baseUrl}/chat/completions with a
// Bearer key, so an adapter is just "which base URL, which credential keys" —
// the wire call lives here once.

import type { GenerateRequest, GenerateResult } from "./types.js";

export async function openaiCompatibleGenerate(
  baseUrl: string,
  apiKey: string | undefined,
  req: GenerateRequest,
): Promise<GenerateResult> {
  const messages: { role: string; content: string }[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens ?? 400, messages }),
    signal: req.signal,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || `API error (${res.status})`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
  };
}
