import { AiError } from "@starter/shared/ai";
import { estimateRequestInputTokens } from "./request-policy";
import type {
  AiChatMessage,
  AiCompletionRequest,
  AiCompletionResult,
  AiContentBlock,
  AiProvider,
  AiStopReason,
} from "./types";

// Any service that speaks OpenAI's Chat Completions (POST
// <baseUrl>/chat/completions): OpenRouter, Together, Groq, DeepSeek, a local
// Ollama or vLLM, OpenAI itself (docs/plan/providers.md). Plain fetch rather
// than the `openai` SDK: one endpoint, redirects are refused outright (SSRF,
// lib/ai/url-guard.ts), and the lockfile stays small.
//
// Tools use the function-calling shape. A 400 that names a parameter is
// answered by adapting once and retrying; the adaptation is remembered for
// this provider instance:
//   - max_tokens refused (newer OpenAI reasoning models) -> max_completion_tokens;
//   - temperature is never sent, so there is nothing to adapt there;
//   - tools refused -> retried without tools (the model then answers in text).
// 429, 5xx, and network failures are retried once; a timeout is not. The key,
// prompts, tool data, and the service's error body are never logged or passed
// on: every failure surfaces as AiError("AI_PROVIDER_UNAVAILABLE").

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  /** Tries per request for retryable failures (429, 5xx, network). */
  maxAttempts?: number;
  fetch?: typeof fetch;
  /** Runs before every request; returns why the URL may not be called, or null. */
  checkUrl?: (url: string) => Promise<string | null>;
  wait?: (ms: number) => Promise<void>;
};

type Adaptation = {
  tokenParam: "max_tokens" | "max_completion_tokens";
  noTools: boolean;
};

type ChatToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};
type ChatResponse = {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | { text?: string }[] | null;
      refusal?: string | null;
      tool_calls?: ChatToolCall[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Reasoning models served this way may prepend their thinking.
const stripThinking = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  return "";
}

// The service's error message, lowercased, only to decide on an adaptation.
async function errorText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 4000).toLowerCase();
  } catch {
    return "";
  }
}

function adaptationFor(
  message: string,
  current: Adaptation,
): Partial<Adaptation> | null {
  if (
    current.tokenParam === "max_tokens" &&
    /max_tokens/.test(message) &&
    /max_completion_tokens|not supported|unsupported/.test(message)
  )
    return { tokenParam: "max_completion_tokens" };
  if (!current.noTools && /\btools?\b|function/.test(message))
    return { noTools: true };
  return null;
}

function retryDelay(res: Response | null, attempt: number) {
  const seconds = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.min(seconds * 1000, 2000);
  return 300 * attempt;
}

function toChatMessages(request: AiCompletionRequest) {
  const out: Record<string, unknown>[] = [
    { role: "system", content: request.system },
  ];
  for (const message of request.messages) pushMessage(out, message);
  return out;
}

function pushMessage(out: Record<string, unknown>[], message: AiChatMessage) {
  const text = message.content
    .filter(
      (b): b is Extract<AiContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
  if (message.role === "assistant") {
    const toolCalls = message.content
      .filter(
        (b): b is Extract<AiContentBlock, { type: "tool_use" }> =>
          b.type === "tool_use",
      )
      .map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    out.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    return;
  }
  // Tool results are their own `tool` messages; they come first so they
  // directly follow the assistant tool_calls message.
  for (const block of message.content)
    if (block.type === "tool_result")
      out.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: block.content,
      });
  if (text) out.push({ role: "user", content: text });
}

function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AiError("AI_PROVIDER_UNAVAILABLE");
  }
}

function stopReason(
  finish: string | null | undefined,
  hasTools: boolean,
): AiStopReason {
  if (hasTools || finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (finish === "stop" || finish == null) return "end_turn";
  return "other";
}

export function createOpenAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): AiProvider {
  const doFetch: typeof fetch =
    options.fetch ?? ((url, init) => fetch(url, init));
  const wait = options.wait ?? sleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const adaptation: Adaptation = { tokenParam: "max_tokens", noTools: false };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  function body(request: AiCompletionRequest) {
    return {
      model: options.model,
      messages: toChatMessages(request),
      [request.reasoningEffort
        ? "max_completion_tokens"
        : adaptation.tokenParam]: request.maxTokens,
      ...(request.reasoningEffort
        ? { reasoning_effort: request.reasoningEffort }
        : {}),
      ...(request.tools.length && !adaptation.noTools
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
      stream: false,
    };
  }

  async function send(
    request: AiCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    if (options.checkUrl && (await options.checkUrl(url)))
      throw new AiError("AI_PROVIDER_UNAVAILABLE");
    let attempt = 0;
    let adaptationsLeft = 3;
    for (;;) {
      attempt += 1;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body(request)),
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
            : AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError")
          throw new AiError("AI_PROVIDER_UNAVAILABLE");
        if (attempt < maxAttempts) {
          await wait(retryDelay(null, attempt));
          continue;
        }
        throw new AiError("AI_PROVIDER_UNAVAILABLE");
      }
      if (res.ok) {
        try {
          return (await res.json()) as ChatResponse;
        } catch {
          throw new AiError("AI_PROVIDER_UNAVAILABLE");
        }
      }
      if (res.status === 400 || res.status === 422) {
        const change =
          adaptationsLeft > 0 &&
          adaptationFor(await errorText(res), adaptation);
        if (change) {
          Object.assign(adaptation, change);
          adaptationsLeft -= 1;
          attempt -= 1;
          continue;
        }
        throw new AiError("AI_PROVIDER_UNAVAILABLE");
      }
      // Drain the body so the connection can be reused; never read it out.
      await res.body?.cancel().catch(() => undefined);
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        await wait(retryDelay(res, attempt));
        continue;
      }
      throw new AiError("AI_PROVIDER_UNAVAILABLE");
    }
  }

  return {
    name: "openai-compatible",
    async complete(request, callOptions): Promise<AiCompletionResult> {
      const response = await send(request, callOptions?.signal);
      const choice = response.choices?.[0];
      if (!choice?.message) throw new AiError("AI_PROVIDER_UNAVAILABLE");
      const message = choice.message;
      const content: AiContentBlock[] = [];
      if (message.refusal || choice.finish_reason === "content_filter")
        return {
          content,
          stopReason: "refusal",
          usage: usageOf(response, request, ""),
          model: response.model?.trim() || options.model,
        };
      const text = stripThinking(contentText(message.content));
      if (text) content.push({ type: "text", text });
      const calls = message.tool_calls ?? [];
      for (const [index, call] of calls.entries()) {
        if (!call.function?.name) throw new AiError("AI_PROVIDER_UNAVAILABLE");
        content.push({
          type: "tool_use",
          id: call.id || `call_${index}`,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        });
      }
      if (!content.length) throw new AiError("AI_PROVIDER_UNAVAILABLE");
      return {
        content,
        stopReason: stopReason(choice.finish_reason, calls.length > 0),
        usage: usageOf(response, request, text),
        model: response.model?.trim() || options.model,
      };
    },
  };
}

// Missing usage is charged at the authorized upper bound, including hidden
// reasoning. Releasing that reserve based on visible text could hide spend.
function usageOf(
  response: ChatResponse,
  request: AiCompletionRequest,
  _outputText: string,
) {
  void _outputText;
  const usage = response.usage ?? {};
  return {
    inputTokens:
      count(usage.prompt_tokens) ??
      count(usage.input_tokens) ??
      estimateRequestInputTokens(request),
    outputTokens:
      count(usage.completion_tokens) ??
      count(usage.output_tokens) ??
      request.maxTokens,
  };
}
