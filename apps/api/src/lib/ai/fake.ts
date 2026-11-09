import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
} from "./types";

// Rough token count for the usage meter: about four characters per token.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export type FakeAiResponder = (
  request: AiCompletionRequest,
) => Pick<AiCompletionResult, "content" | "stopReason"> &
  Partial<Pick<AiCompletionResult, "usage" | "model">>;

// Deterministic provider for development and tests: no network, no key. The
// optional responder scripts the answer (including tool_use blocks); without
// one it echoes a fixed text. Refused in production (config/env.ts).
export function createFakeProvider(
  responder?: FakeAiResponder,
): AiProvider & { readonly calls: AiCompletionRequest[] } {
  const calls: AiCompletionRequest[] = [];
  return {
    name: "fake",
    calls,
    async complete(request) {
      calls.push(request);
      const reply = responder?.(request) ?? {
        content: [{ type: "text" as const, text: "Jawaban uji." }],
        stopReason: "end_turn" as const,
      };
      const outputText = reply.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return {
        content: reply.content,
        stopReason: reply.stopReason,
        usage: reply.usage ?? {
          inputTokens:
            estimateTokens(request.system) +
            estimateTokens(JSON.stringify(request.messages)),
          outputTokens: estimateTokens(outputText),
        },
        model: reply.model ?? "fake-1",
      };
    },
  };
}
