// Tanya AI orchestrator (PRD v1.7 §3 Fitur 38, AI-01..14; bead legend-xq8y).
// One question: preflight (feature switch, PII, quota, budget) -> cache ->
// tool loop (max 6 provider turns, 25 s overall) -> persist -> answer.
// The model sees data only through `tool_result` blocks produced by
// `invokeAiTool` with the CALLER's access; the system prompt is a constant.
// Write tools only create action requests (AIG-03); ids are returned.

import {
  AiError,
  askAiResponseSchema,
  getAiTool,
  toolSourceSchema,
  type AiMessageSource,
  type AiModelCapabilities,
  type AiToolCode,
  type AskAi,
  type AskAiResponse,
} from "@starter/shared/ai";
import type { ScopedTenantContext } from "@starter/shared/core";
import { env } from "../config/env.ts";
import { getModelCapabilities } from "../lib/ai/model-capabilities.ts";
import { redactPii, scanPii, type PiiKind } from "../lib/ai/pii.ts";
import { prepareAiRequest } from "../lib/ai/request-policy.ts";
import { resolveTenantAiCapabilities } from "./ai-provider-config.service.ts";
import type {
  AiChatMessage,
  AiCompletionRequest,
  AiCompletionResult,
  AiContentBlock,
} from "../lib/ai/types.ts";
import { logger } from "../lib/logger.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";
import type { AiChannel, AiToolContext } from "./ai-tools/types.ts";
import {
  aiCacheGet,
  aiCachePut,
  aiComplete,
  aiPreflight,
  gatewayContext,
  recordAiOutputPiiRedacted,
  type AiCacheKeyInput,
} from "./ai-gateway.service.ts";
import {
  invokeAiTool,
  listCallableTools,
  toToolSpecs,
} from "./ai-tool-invoke.service.ts";
import {
  getConversationDetail,
  isSharedTool,
  persistTurn,
  type PersistedTurn,
} from "./ai-conversation.service.ts";
import {
  AI_EMPTY_ANSWER_MESSAGE,
  AI_HIDDEN_ANSWER_MESSAGE,
  AI_LOOP_LIMIT_MESSAGE,
  AI_MAX_TOKENS_MESSAGE,
  AI_REFUSAL_MESSAGE,
  AI_SYSTEM_PROMPT,
  toolMessageText,
} from "./ai-prompts.ts";

export const AI_MAX_TURNS = 6;
export const AI_DEADLINE_MS = 25_000;
export const AI_MAX_OUTPUT_TOKENS = 2048;
/** Answers without self-only tools may be shared inside a tenant for 15 min. */
export const AI_CACHE_TTL_SECONDS = 900;
const ANSWER_MAX_CHARS = 8000;
const SOURCES_MAX = 20;
const CHANNEL: AiChannel = "tanya_ai";

type ToolRow = {
  toolCode: AiToolCode;
  text: string;
  sources: AiMessageSource[];
};

type CachedAnswer = {
  text: string;
  sources: AiMessageSource[];
  tools: ToolRow[];
};

/** Everything the orchestrator touches outside itself; tests replace it. */
export type OrchestratorDeps = {
  preflight: typeof aiPreflight;
  resolveCapabilities?: (
    access: AccessSnapshot,
  ) => Promise<AiModelCapabilities>;
  complete: (
    access: AccessSnapshot,
    request: AiCompletionRequest,
    meta: { feature: string; channel: AiChannel; outletId?: string | null },
  ) => Promise<AiCompletionResult>;
  listTools: typeof listCallableTools;
  toSpecs: typeof toToolSpecs;
  invoke: typeof invokeAiTool;
  cacheGet: (access: AccessSnapshot, key: AiCacheKeyInput) => Promise<unknown>;
  cachePut: (
    access: AccessSnapshot,
    key: AiCacheKeyInput,
    value: CachedAnswer,
    ttlSeconds: number,
  ) => Promise<void>;
  loadHistory: (
    access: AccessSnapshot,
    context: ScopedTenantContext,
    conversationId: string,
  ) => Promise<AiChatMessage[]>;
  persist: typeof persistTurn;
  /** Audit row for an answer masked for PII; optional so test deps may omit it. */
  auditOutputPii?: (
    access: AccessSnapshot,
    meta: { feature: string; kinds: readonly PiiKind[] },
  ) => Promise<void>;
  now: () => Date;
};

async function defaultLoadHistory(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  conversationId: string,
): Promise<AiChatMessage[]> {
  const detail = await getConversationDetail(access, context, conversationId);
  return toHistory(
    detail.messages
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.content !== AI_HIDDEN_ANSWER_MESSAGE,
      )
      .map((message) => ({
        role: message.role as "user" | "assistant",
        text: message.content,
      })),
  );
}

/** Last turns as plain text, strictly alternating and starting with the user. */
export function toHistory(
  items: readonly { role: "user" | "assistant"; text: string }[],
): AiChatMessage[] {
  const out: AiChatMessage[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.role === item.role)
      last.content.push({ type: "text", text: item.text });
    else
      out.push({
        role: item.role,
        content: [{ type: "text", text: item.text }],
      });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

export const defaultDeps: OrchestratorDeps = {
  preflight: aiPreflight,
  complete: aiComplete,
  resolveCapabilities: (access) =>
    resolveTenantAiCapabilities(gatewayContext(access)),
  listTools: listCallableTools,
  toSpecs: toToolSpecs,
  invoke: invokeAiTool,
  cacheGet: aiCacheGet,
  cachePut: (access, key, value, ttl) =>
    aiCachePut(access, key, { ...value }, ttl),
  loadHistory: defaultLoadHistory,
  persist: persistTurn,
  auditOutputPii: (access, meta) =>
    recordAiOutputPiiRedacted(access, { ...meta, channel: CHANNEL }),
  now: () => new Date(),
};

const cachedAnswerShape = (value: unknown): CachedAnswer | null => {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<CachedAnswer>;
  if (typeof v.text !== "string" || v.text.length === 0) return null;
  if (!Array.isArray(v.sources) || !Array.isArray(v.tools)) return null;
  return v as CachedAnswer;
};

function toMessageSource(raw: unknown): AiMessageSource | null {
  const parsed = toolSourceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { label, link, metricCode, period } = parsed.data;
  return {
    label,
    link,
    ...(metricCode ? { metricCode } : {}),
    period: { from: period.from, to: period.to },
  };
}

const sourceKey = (source: AiMessageSource) =>
  `${source.link}|${source.label}|${source.metricCode ?? ""}|${source.period?.from ?? ""}|${source.period?.to ?? ""}`;

function addSources(
  into: AiMessageSource[],
  from: readonly AiMessageSource[],
): void {
  const seen = new Set(into.map(sourceKey));
  for (const source of from) {
    if (into.length >= SOURCES_MAX) return;
    if (seen.has(sourceKey(source))) continue;
    seen.add(sourceKey(source));
    into.push(source);
  }
}

function sourcesOf(output: unknown): AiMessageSource[] {
  const list = (output as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const source = toMessageSource(raw);
    return source ? [source] : [];
  });
}

function textOf(content: readonly AiContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AiError("AI_PROVIDER_UNAVAILABLE")),
      ms,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type LoopOutcome = {
  text: string;
  tools: ToolRow[];
  sources: AiMessageSource[];
  actionRequestIds: string[];
  /** Only a clean end_turn with no tool error may be cached. */
  cacheable: boolean;
  /** PII kinds the model's answer carried; `text` is already masked. */
  piiKinds: PiiKind[];
};

async function toolsStillCallable(
  access: AccessSnapshot,
  cached: CachedAnswer,
  deps: OrchestratorDeps,
): Promise<boolean> {
  const callable = new Set<string>(
    (
      await deps.listTools({
        access,
        channel: CHANNEL,
        mcpClientId: null,
        now: deps.now(),
      })
    ).map((tool) => tool.code),
  );
  return cached.tools.every((tool) => callable.has(tool.toolCode));
}

async function runLoop(
  access: AccessSnapshot,
  input: AskAi,
  history: AiChatMessage[],
  deps: OrchestratorDeps,
): Promise<LoopOutcome> {
  const started = deps.now().getTime();
  const ctx: AiToolContext = {
    access,
    channel: CHANNEL,
    mcpClientId: null,
    now: deps.now(),
  };
  const capabilities = deps.resolveCapabilities
    ? await deps.resolveCapabilities(access)
    : getModelCapabilities(env.AI_MODEL);
  const tools = deps.toSpecs(await deps.listTools(ctx));
  const questionText = input.outletId
    ? `${input.question}\n\n[Outlet terpilih: ${input.outletId}]`
    : input.question;
  const messages: AiChatMessage[] = [
    ...history,
    { role: "user", content: [{ type: "text", text: questionText }] },
  ];

  const toolRows = new Map<AiToolCode, ToolRow>();
  const sources: AiMessageSource[] = [];
  const actionRequestIds: string[] = [];
  let anyToolFailed = false;
  // The caller's own payslip, profit share or authorised labor cost is shown
  // as returned by the tool; only then is the salary kind left unmasked.
  let ownSalaryShown = false;
  const finish = (text: string, cacheable: boolean): LoopOutcome => {
    // Model output is scanned like input: personal data is masked before the
    // answer is cached, stored or shown, and such an answer is never cached.
    const clipped = text.slice(0, ANSWER_MAX_CHARS);
    const skipKinds: PiiKind[] = ownSalaryShown ? ["salary"] : [];
    const piiKinds = scanPii(clipped, skipKinds).found;
    return {
      text: piiKinds.length > 0 ? redactPii(clipped, skipKinds) : clipped,
      tools: [...toolRows.values()],
      sources,
      actionRequestIds,
      cacheable:
        cacheable &&
        piiKinds.length === 0 &&
        !ownSalaryShown &&
        !anyToolFailed &&
        actionRequestIds.length === 0 &&
        [...toolRows.keys()].every(isSharedTool),
      piiKinds,
    };
  };

  for (let turn = 0; turn < AI_MAX_TURNS; turn += 1) {
    const remaining = AI_DEADLINE_MS - (deps.now().getTime() - started);
    if (remaining <= 0) return finish(AI_LOOP_LIMIT_MESSAGE, false);
    const result = await withDeadline(
      deps.complete(
        access,
        prepareAiRequest(
          {
            system: AI_SYSTEM_PROMPT,
            messages,
            tools,
            maxTokens: AI_MAX_OUTPUT_TOKENS,
          },
          capabilities,
        ),
        {
          feature: input.feature,
          channel: CHANNEL,
          outletId: input.outletId ?? null,
        },
      ),
      remaining,
    );
    if (result.stopReason === "refusal")
      return finish(AI_REFUSAL_MESSAGE, false);
    if (result.stopReason === "max_tokens")
      return finish(AI_MAX_TOKENS_MESSAGE, false);

    const calls = result.content.flatMap((block) =>
      block.type === "tool_use" ? [block] : [],
    );
    if (calls.length === 0) {
      const text = textOf(result.content);
      return text
        ? finish(text, result.stopReason === "end_turn")
        : finish(AI_EMPTY_ANSWER_MESSAGE, false);
    }

    // Opaque (thinking) blocks go back unchanged with the tool_use blocks.
    messages.push({ role: "assistant", content: result.content });
    const outcomes = await Promise.all(
      calls.map((call) =>
        deps.invoke(ctx, call.name, call.input, { conversationId: null }),
      ),
    );
    const results: AiContentBlock[] = calls.map((call, index) => {
      const outcome = outcomes[index]!;
      if (!outcome.ok) {
        anyToolFailed = true;
        return {
          type: "tool_result",
          toolUseId: call.id,
          content: JSON.stringify({
            error: outcome.errorCode,
            message: outcome.message,
          }),
          isError: true,
        };
      }
      const def = getAiTool(outcome.toolCode);
      const found = sourcesOf(outcome.output);
      addSources(sources, found);
      const row = toolRows.get(outcome.toolCode) ?? {
        toolCode: outcome.toolCode,
        text: toolMessageText(def?.name ?? outcome.toolCode),
        sources: [],
      };
      addSources(row.sources, found);
      toolRows.set(outcome.toolCode, row);
      if (
        outcome.toolCode === "TL-09" ||
        outcome.toolCode === "TL-12" ||
        (outcome.toolCode === "TL-05" &&
          (outcome.output as { laborCostIdr?: unknown } | null)?.laborCostIdr !=
            null)
      )
        ownSalaryShown = true;
      const requestId = (outcome.output as { actionRequestId?: unknown } | null)
        ?.actionRequestId;
      if (
        def?.kind === "write" &&
        typeof requestId === "string" &&
        actionRequestIds.length < 10
      )
        actionRequestIds.push(requestId);
      return {
        type: "tool_result",
        toolUseId: call.id,
        content: JSON.stringify(outcome.output),
      };
    });
    // All results of one assistant turn go back in ONE user message.
    messages.push({ role: "user", content: results });
  }
  return finish(AI_LOOP_LIMIT_MESSAGE, false);
}

/** Answer one question for the caller. Errors are `AiError` with a code. */
export async function askAi(
  access: AccessSnapshot,
  context: ScopedTenantContext,
  input: AskAi,
  deps: OrchestratorDeps = defaultDeps,
): Promise<AskAiResponse> {
  if (
    input.outletId &&
    !access.allows("ai.ask", { type: "outlet", id: input.outletId })
  )
    throw new AiError(
      "AI_TOOL_FORBIDDEN",
      "Anda tidak punya akses ke outlet ini.",
    );

  await deps.preflight(access, {
    feature: input.feature,
    channel: CHANNEL,
    text: input.question,
  });

  const history = input.conversationId
    ? await deps.loadHistory(access, context, input.conversationId)
    : [];
  const cacheKey: AiCacheKeyInput = {
    scope: input.feature,
    question: input.question,
    outletIds: input.outletId ? [input.outletId] : null,
  };
  // A follow-up depends on earlier turns, so only first questions are cached.
  const hit =
    history.length === 0
      ? cachedAnswerShape(await deps.cacheGet(access, cacheKey))
      : null;
  // An entry made while a tool was allowed is ignored once the kill switch or
  // the caller's permission no longer covers every tool it used.
  const cached =
    hit && (await toolsStillCallable(access, hit, deps)) ? hit : null;

  const outcome: LoopOutcome = cached
    ? {
        text: cached.text,
        tools: cached.tools,
        sources: cached.sources,
        actionRequestIds: [],
        cacheable: false,
        piiKinds: [],
      }
    : await runLoop(access, input, history, deps);

  if (outcome.piiKinds.length > 0)
    await deps
      .auditOutputPii?.(access, {
        feature: input.feature,
        kinds: outcome.piiKinds,
      })
      // The answer is already masked, so a failed audit never fails it.
      .catch((error: unknown) =>
        logger.warn({ err: error }, "ai output pii audit failed"),
      );

  if (!cached && outcome.cacheable && history.length === 0)
    await deps
      .cachePut(
        access,
        cacheKey,
        { text: outcome.text, sources: outcome.sources, tools: outcome.tools },
        AI_CACHE_TTL_SECONDS,
      )
      .catch(() => undefined); // a cache failure never fails the answer

  const turn: PersistedTurn = await deps.persist(
    access,
    context,
    {
      conversationId: input.conversationId ?? null,
      feature: input.feature,
      title: input.question.slice(0, 60),
      question: input.question,
      answer: outcome.text,
      answerSources: outcome.sources,
      tools: outcome.tools,
    },
    deps.now(),
  );
  return askAiResponseSchema.parse({
    ...turn,
    actionRequestIds: outcome.actionRequestIds,
  });
}
