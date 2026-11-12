import type {
  AiModelCapabilities,
  AiReasoningEffort,
} from "@starter/shared/ai";
import type { AiChatMessage, AiCompletionRequest } from "./types.ts";

// Baseline seams for behavioral red tests; policy implementation follows red.
export function selectReasoningEffort(_input: {
  question: string;
  capabilities: AiModelCapabilities;
  toolRounds?: number;
}): AiReasoningEffort | undefined {
  void _input;
  return undefined;
}
export function estimateRequestInputTokens(
  _request: AiCompletionRequest,
): number {
  void _request;
  return 0;
}
export function trimMessagesToContext(
  messages: AiChatMessage[],
  _contextWindow: number,
  _maxOutputTokens: number,
  _system = "",
  _tools: AiCompletionRequest["tools"] = [],
): AiChatMessage[] {
  void _system;
  void _tools;
  return messages;
}
export function prepareAiRequest(
  request: AiCompletionRequest,
  _capabilities: AiModelCapabilities,
): AiCompletionRequest {
  void _capabilities;
  return request;
}
