import Anthropic from "@anthropic-ai/sdk";
import { AiError } from "@starter/shared/ai";
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiContentBlock,
  AiProvider,
  AiStopReason,
  AiToolSpec,
} from "./types";

// Anthropic adapter (default provider). Maps lib/ai/types.ts to the SDK's beta
// Messages API, which carries server-side fallbacks. Design (sub-brief
// §Decisions):
//   - adaptive thinking: `thinking` is omitted; effort comes from
//     `output_config.effort`. Thinking (and fallback) blocks come back as
//     `opaque` blocks and are replayed unchanged within the same tool loop.
//   - `tool_choice` is never sent (forced choice is refused with a 400 on this
//     model; the default is `auto`), and there is no assistant prefill.
//   - `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta.
//   - the stable system block and the last tool carry `cache_control`.
// The key, prompts, tool data, and SDK error bodies are never logged or
// passed on: every failure surfaces as AiError("AI_PROVIDER_UNAVAILABLE").

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The slice of the SDK client this adapter uses (a test double fits it). */
export type AnthropicClientLike = {
  beta: {
    messages: {
      create(
        body: BetaCreateParams,
        options?: { signal?: AbortSignal },
      ): PromiseLike<BetaMessage>;
    };
  };
};

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  client?: AnthropicClientLike;
};

const PROVIDER = "anthropic";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// Keywords strict tool schemas do not accept; a schema that uses one is sent
// without `strict` rather than risking a 400.
const STRICT_UNSUPPORTED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "pattern",
  "format",
  "oneOf",
  "not",
  "patternProperties",
]);

function strictCompatible(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(strictCompatible);
  if (!node || typeof node !== "object") return true;
  const record = node as Record<string, unknown>;
  if (record.type === "object" && record.additionalProperties !== false)
    return false;
  return Object.entries(record).every(([key, value]) =>
    // `properties` keys are field names, not keywords.
    key === "properties"
      ? Object.values(value as Record<string, unknown>).every(strictCompatible)
      : !STRICT_UNSUPPORTED.has(key) && strictCompatible(value),
  );
}

function toTools(tools: AiToolSpec[]): BetaCreateParams["tools"] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as { type: "object" },
    ...(strictCompatible(tool.inputSchema) ? { strict: true } : {}),
    ...(index === tools.length - 1
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }));
}

function toMessages(
  messages: AiCompletionRequest["messages"],
): BetaCreateParams["messages"] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.flatMap((block): never[] | unknown[] => {
      switch (block.type) {
        case "text":
          return [{ type: "text", text: block.text }];
        case "tool_use":
          return [
            {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input,
            },
          ];
        case "tool_result":
          return [
            {
              type: "tool_result",
              tool_use_id: block.toolUseId,
              content: block.content,
              ...(block.isError ? { is_error: true } : {}),
            },
          ];
        case "opaque":
          // Only this provider's own blocks are replayed.
          return block.provider === PROVIDER ? [block.data] : [];
      }
    }),
  })) as BetaCreateParams["messages"];
}

function fromContent(blocks: BetaMessage["content"]): AiContentBlock[] {
  return blocks.map((block): AiContentBlock => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool_use")
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    // thinking, redacted_thinking, fallback, ...: replayed as received.
    return { type: "opaque", provider: PROVIDER, data: block };
  });
}

function fromStopReason(reason: BetaMessage["stop_reason"]): AiStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): AiProvider {
  const client: AnthropicClientLike =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 0,
    });

  return {
    name: PROVIDER,
    async complete(request, callOptions): Promise<AiCompletionResult> {
      const body: BetaCreateParams = {
        model: options.model,
        max_tokens: request.maxTokens,
        system: [
          {
            type: "text",
            text: request.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: toMessages(request.messages),
        ...(request.tools.length ? { tools: toTools(request.tools) } : {}),
        ...(request.reasoningEffort
          ? { output_config: { effort: request.reasoningEffort } }
          : {}),
        fallbacks: "default",
        betas: [FALLBACK_BETA],
      };
      let message: BetaMessage;
      try {
        message = await client.beta.messages.create(
          body,
          callOptions?.signal ? { signal: callOptions.signal } : undefined,
        );
      } catch {
        throw new AiError("AI_PROVIDER_UNAVAILABLE");
      }
      const usage = message.usage;
      return {
        content: fromContent(message.content),
        stopReason: fromStopReason(message.stop_reason),
        usage: {
          inputTokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
        model: message.model,
      };
    },
  };
}
