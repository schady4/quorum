// The provider-adapter interface — the extensibility surface of Quorum.
//
// Every model, from any vendor, plugs in behind THIS one interface: Claude,
// OpenAI, Meta/Llama, Kimi, and local / open-source models are all just
// adapters. Adding a new model to Quorum means adding a file that implements
// `ProviderAdapter` and registering it — the router, the TUI, and the room
// protocol never change.
//
// Nothing here is model-specific on purpose. If a concept only makes sense for
// one vendor, it does not belong in this interface.

/** A credential the adapter needs, collected by first-run setup and stored locally. */
export interface CredentialSpec {
  /** Stable key, e.g. "ANTHROPIC_API_KEY". */
  key: string;
  /** Human label shown at the install/setup prompt. */
  label: string;
  /** Whether the tool is unusable without it (vs. optional, e.g. a base URL). */
  required: boolean;
  /** True for secrets, so the prompt masks input and the store encrypts at rest. */
  secret: boolean;
}

/** One model the adapter exposes, e.g. { id: "claude-sonnet-5", label: "Claude Sonnet 5" }. */
export interface ModelInfo {
  id: string;
  label: string;
  /** Optional coarse hints the router may weigh when choosing a model. */
  strengths?: string[];
  contextWindow?: number;
}

/** A single turn in the shared conversation, provider-neutral. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  /** The author's handle in the room (human or AI seat). */
  author?: string;
  content: string;
}

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Tool schemas (e.g. surfaced from MCP servers) the model may call. */
  tools?: unknown[];
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  /** Populated when the model asks to call a tool; the agent loop dispatches it. */
  toolCalls?: { name: string; input: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Implement this to add a model vendor to Quorum.
 *
 * An adapter is stateless with respect to the room: it turns a provider-neutral
 * request into a call against one vendor's API and returns a provider-neutral
 * result. Everything about seats, convergence, and history lives above it.
 */
export interface ProviderAdapter {
  /** Stable id, e.g. "anthropic", "openai", "meta", "kimi", "local". */
  id: string;
  /** Display name, e.g. "Anthropic (Claude)". */
  label: string;
  /** Credentials first-run setup should collect for this provider. */
  credentials: CredentialSpec[];
  /** Models this adapter exposes. May be static or fetched at init. */
  listModels(): Promise<ModelInfo[]> | ModelInfo[];
  /** One-shot / non-streaming generation. */
  generate(req: GenerateRequest, creds: Record<string, string>): Promise<GenerateResult>;
}
