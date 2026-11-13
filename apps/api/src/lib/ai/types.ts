// Provider-neutral LLM types for the WS-12 AI gateway (bead legend-zfi4).
// Every provider adapter (lib/ai/anthropic.ts, openai-compatible.ts, fake.ts)
// maps to and from these shapes, so the orchestrator and gateway never import
// a vendor SDK. Shared contract: docs/briefs/sub-ws12-ai.md §Interfaces.

/** One block of model or user content. */
export type AiContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      toolUseId: string;
      /** JSON text of the tool output, or an error message. Treated as data. */
      content: string;
      isError?: boolean;
    }
  /**
   * Provider-specific block (e.g. Anthropic `thinking`) that must be sent back
   * unchanged in the same tool loop. Other providers ignore it.
   */
  | { type: "opaque"; provider: string; data: unknown };

export type AiChatMessage = {
  role: "user" | "assistant";
  content: AiContentBlock[];
};

export type AiToolSpec = {
  /** Catalog tool name (snake_case), e.g. `get_sales_summary`. */
  name: string;
  description: string;
  /** JSON Schema of the tool input (from the catalog zod schema). */
  inputSchema: Record<string, unknown>;
};

export type AiCompletionRequest = {
  system: string;
  messages: AiChatMessage[];
  tools: AiToolSpec[];
  /** Total generated tokens, including hidden reasoning. */
  maxTokens: number;
  reasoningEffort?: "low" | "medium" | "high";
};

export type AiStopReason =
  "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export type AiCompletionResult = {
  content: AiContentBlock[];
  stopReason: AiStopReason;
  usage: { inputTokens: number; outputTokens: number };
  /** Model that actually answered (may differ after a server-side fallback). */
  model: string;
};

export interface AiProvider {
  readonly name: string;
  complete(
    request: AiCompletionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AiCompletionResult>;
}
