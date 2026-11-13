// Discovery is advisory: metadata may be absent on standard OpenAI endpoints.
// Never fetch during inference; effective capabilities are saved per tenant.
import {
  aiModelCapabilityOverridesSchema,
  type AiModelCapabilities,
  type AiModelCapabilityOverrides,
  type AiReasoningEffort,
} from "@starter/shared/ai";
import { aiProviderNetwork } from "./provider-factory.ts";
import { checkAiUrl, type HostResolver } from "./url-guard.ts";

const SAFE: AiModelCapabilities = {
  contextWindow: 4096,
  maxOutputTokens: 1024,
  supportsTools: false,
  supportsReasoning: false,
  reasoningEfforts: [],
  source: "default",
};
const EFFORTS: AiReasoningEffort[] = ["low", "medium", "high"];
const KNOWN: Record<string, [number, number, boolean]> = {
  "gpt-4o": [128_000, 16_384, false],
  "gpt-4o-mini": [128_000, 16_384, false],
  "gpt-4.1": [1_047_576, 32_768, false],
  "gpt-4.1-mini": [1_047_576, 32_768, false],
  "gpt-4.1-nano": [1_047_576, 32_768, false],
  o3: [200_000, 100_000, true],
  "o3-mini": [200_000, 100_000, true],
  "o4-mini": [200_000, 100_000, true],
  "gpt-5": [400_000, 128_000, true],
  "gpt-5-mini": [400_000, 128_000, true],
  "gpt-5-nano": [400_000, 128_000, true],
  "claude-opus-5-5": [200_000, 8192, true],
  "claude-sonnet-5-5": [200_000, 8192, true],
  "claude-haiku-5-5": [200_000, 8192, true],
  "claude-opus-4-6": [200_000, 8192, true],
  "claude-sonnet-4-6": [200_000, 8192, true],
  "claude-sonnet-4-5": [200_000, 8192, true],
  "claude-haiku-4-5": [200_000, 8192, true],
};

/** Exact names or dated snapshots only; lookalike names remain unknown. */
export function getModelCapabilities(model: string): AiModelCapabilities {
  const name = model.replace(/^openai\//, "");
  const snapshotBase = name.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const entry = Object.hasOwn(KNOWN, name)
    ? KNOWN[name]
    : Object.hasOwn(KNOWN, snapshotBase)
      ? KNOWN[snapshotBase]
      : undefined;
  return entry
    ? {
        contextWindow: entry[0],
        maxOutputTokens: entry[1],
        supportsTools: true,
        supportsReasoning: entry[2],
        reasoningEfforts: entry[2] ? [...EFFORTS] : [],
        source: "known",
      }
    : { ...SAFE, reasoningEfforts: [] };
}

export function applyCapabilityOverrides(
  detected: AiModelCapabilities,
  overrides?: AiModelCapabilityOverrides | null,
): AiModelCapabilities {
  const valid = aiModelCapabilityOverridesSchema.parse(overrides ?? {});
  const merged = { ...detected, ...valid };
  return {
    ...merged,
    maxOutputTokens: Math.min(merged.maxOutputTokens, merged.contextWindow - 1),
    reasoningEfforts: merged.supportsReasoning
      ? [
          ...new Set(
            valid.reasoningEfforts ??
              (valid.supportsReasoning === true && !detected.supportsReasoning
                ? EFFORTS
                : detected.reasoningEfforts),
          ),
        ]
      : [],
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const limit = (value: unknown, max: number, min = 1): number | undefined =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined;

function metadataCapabilities(
  model: string,
  data: unknown,
): AiModelCapabilities {
  const base = getModelCapabilities(model);
  const root = record(data);
  const item = Array.isArray(root?.data)
    ? root.data.map(record).find((entry) => entry?.id === model)
    : undefined;
  if (!item) return base;
  const top = record(item.top_provider);
  const contexts = [
    item.context_length,
    item.max_model_len,
    item.context_window,
    top?.context_length,
  ]
    .map((value) => limit(value, 2_000_000, 1024))
    .filter((value): value is number => value !== undefined);
  const outputs = [
    item.max_output_tokens,
    item.max_completion_tokens,
    top?.max_completion_tokens,
  ]
    .map((value) => limit(value, 200_000))
    .filter((value): value is number => value !== undefined);
  const output = outputs.length ? Math.min(...outputs) : undefined;
  const parameters = Array.isArray(item.supported_parameters)
    ? item.supported_parameters.filter(
        (value): value is string => typeof value === "string",
      )
    : undefined;
  const tools =
    typeof item.supports_tools === "boolean"
      ? item.supports_tools
      : parameters
        ? parameters.includes("tools")
        : undefined;
  const reasoning =
    typeof item.supports_reasoning === "boolean"
      ? item.supports_reasoning
      : parameters
        ? parameters.some((p) => p === "reasoning" || p === "reasoning_effort")
        : undefined;
  const efforts = Array.isArray(item.reasoning_efforts)
    ? EFFORTS.filter((effort) =>
        (item.reasoning_efforts as unknown[]).includes(effort),
      )
    : undefined;
  const hasMetadata =
    contexts.length > 0 ||
    output !== undefined ||
    tools !== undefined ||
    reasoning !== undefined;
  const contextWindow = contexts.length
    ? Math.min(...contexts)
    : base.contextWindow;
  const supportsReasoning = reasoning ?? base.supportsReasoning;
  return {
    contextWindow,
    maxOutputTokens: Math.min(
      output ?? base.maxOutputTokens,
      contextWindow - 1,
    ),
    supportsTools: tools ?? base.supportsTools,
    supportsReasoning,
    reasoningEfforts: supportsReasoning
      ? efforts !== undefined
        ? efforts
        : [...EFFORTS]
      : [],
    source: hasMetadata ? "metadata" : base.source,
  };
}

/** Bounded, strict public-HTTPS metadata call; upstream bodies/errors stay private. */
export async function detectModelCapabilities(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  resolve?: HostResolver;
  overrides?: AiModelCapabilityOverrides | null;
}): Promise<AiModelCapabilities> {
  let detected = getModelCapabilities(options.model);
  try {
    const net = aiProviderNetwork();
    const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
    if (
      !(await checkAiUrl(url, true, options.resolve ?? net.resolve)) &&
      new URL(url).port === ""
    ) {
      const response = await (options.fetch ?? net.fetch)(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1_048_576)
              throw new Error("Metadata response too large");
            chunks.push(value);
          }
          detected = metadataCapabilities(
            options.model,
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    }
  } catch {
    // Capability lookup is optional and must not reveal keys or upstream text.
  }
  return applyCapabilityOverrides(detected, options.overrides);
}
