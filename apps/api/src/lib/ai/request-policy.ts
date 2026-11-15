// Request policy is provider-neutral. The byte bound deliberately overestimates
// tokenization (including non-Latin text) so context and budget checks fail closed.
import {
  AiError,
  type AiModelCapabilities,
  type AiReasoningEffort,
} from "@starter/shared/ai";
import { redactToolResultContent } from "./pii.ts";
import type { AiChatMessage, AiCompletionRequest } from "./types.ts";

const EFFORTS: readonly AiReasoningEffort[] = ["low", "medium", "high"];

export function selectReasoningEffort(input: {
  question: string;
  capabilities: AiModelCapabilities;
  toolRounds?: number;
}): AiReasoningEffort | undefined {
  const { capabilities, question, toolRounds = 0 } = input;
  if (!capabilities.supportsReasoning) return undefined;
  const available = EFFORTS.filter((effort) =>
    capabilities.reasoningEfforts.includes(effort),
  );
  if (!available.length) return undefined;
  const desired =
    toolRounds >= 2 ||
    /analisis|analy[sz]|forecast|prediksi|proyeksi|bandingkan|compare|skenario|scenario/i.test(
      question,
    )
      ? 2
      : toolRounds > 0 ||
          question.length > 160 ||
          /jelaskan|detail|laporan|report/i.test(question)
        ? 1
        : 0;
  return (
    available.filter((effort) => EFFORTS.indexOf(effort) <= desired).at(-1) ??
    available[0]
  );
}

/** JSON bytes bound textual tokens; fixed allowances cover vendor framing. */
export function estimateRequestInputTokens(
  request: AiCompletionRequest,
): number {
  const serialized = JSON.stringify({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });
  return (
    Buffer.byteLength(serialized, "utf8") +
    256 +
    request.messages.length * 64 +
    request.tools.length * 128
  );
}

/** Remove whole earlier turns, keeping tool-use/result chains inseparable. */
export function trimMessagesToContext(
  messages: AiChatMessage[],
  contextWindow: number,
  maxOutputTokens: number,
  system = "",
  tools: AiCompletionRequest["tools"] = [],
): AiChatMessage[] {
  // Reject malformed protocol instead of passing orphaned tool content to a
  // provider. A complete result batch must immediately follow its call batch.
  let pending = new Set<string>();
  for (const message of messages) {
    const uses = message.content.flatMap((block) =>
      block.type === "tool_use" ? [block.id] : [],
    );
    const results = message.content.flatMap((block) =>
      block.type === "tool_result" ? [block.toolUseId] : [],
    );
    if (pending.size) {
      if (
        message.role !== "user" ||
        results.length !== pending.size ||
        new Set(results).size !== results.length ||
        results.some((id) => !pending.has(id))
      )
        throw new AiError("AI_PROVIDER_UNAVAILABLE");
      pending = new Set();
    } else if (results.length) throw new AiError("AI_PROVIDER_UNAVAILABLE");
    if (uses.length) {
      if (message.role !== "assistant" || new Set(uses).size !== uses.length)
        throw new AiError("AI_PROVIDER_UNAVAILABLE");
      pending = new Set(uses);
    }
  }
  if (pending.size) throw new AiError("AI_PROVIDER_UNAVAILABLE");
  let retained = [...messages];
  const fits = () =>
    estimateRequestInputTokens({
      system,
      messages: retained,
      tools,
      maxTokens: maxOutputTokens,
    }) +
      maxOutputTokens <=
    contextWindow;
  while (!fits()) {
    // A normal user message starts a turn. Tool-result messages continue the
    // preceding assistant call and must never become an orphan at the front.
    const nextTurn = retained.findIndex(
      (message, index) =>
        index > 0 &&
        message.role === "user" &&
        !message.content.some((block) => block.type === "tool_result"),
    );
    if (nextTurn < 0) throw new AiError("AI_PROVIDER_UNAVAILABLE");
    retained = retained.slice(nextTurn);
  }
  return retained;
}

/**
 * Single choke point for AIG-02: every provider request passes through
 * prepareAiRequest, so tool results are masked here for every caller
 * (orchestrator, drafts, system calls). The user still sees the unmasked
 * result; only what is sent to the provider is redacted.
 */
function redactToolResults(messages: AiChatMessage[]): AiChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: message.content.map((block) =>
      block.type === "tool_result"
        ? { ...block, content: redactToolResultContent(block.content) }
        : block,
    ),
  }));
}

export function prepareAiRequest(
  request: AiCompletionRequest,
  capabilities: AiModelCapabilities,
): AiCompletionRequest {
  const maxTokens = Math.min(
    Math.trunc(request.maxTokens),
    capabilities.maxOutputTokens,
    capabilities.contextWindow - 1,
  );
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
    throw new AiError("AI_PROVIDER_UNAVAILABLE");
  const tools = capabilities.supportsTools ? request.tools : [];
  const question =
    [...request.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          message.content.some((block) => block.type === "text"),
      )
      ?.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n") ?? "";
  const effort = selectReasoningEffort({
    question,
    capabilities,
    toolRounds: request.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === "tool_use").length,
  });
  const { reasoningEffort: _ignored, ...base } = request;
  void _ignored;
  return {
    ...base,
    tools,
    maxTokens,
    messages: trimMessagesToContext(
      redactToolResults(request.messages),
      capabilities.contextWindow,
      maxTokens,
      request.system,
      tools,
    ),
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}
