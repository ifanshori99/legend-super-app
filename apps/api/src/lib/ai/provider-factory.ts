import { env } from "../../config/env";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import { createFakeProvider } from "./fake";
import { checkAiUrl } from "./url-guard";
import type { AiProvider } from "./types";

let override: AiProvider | null | undefined;
let cached: AiProvider | null | undefined;

function build(): AiProvider | null {
  if (env.AI_PROVIDER === "fake") return createFakeProvider();
  if (env.AI_PROVIDER === "openai-compatible") {
    if (!env.AI_BASE_URL) return null;
    return createOpenAiCompatibleProvider({
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY ?? null,
      model: env.AI_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
      checkUrl: (url) => checkAiUrl(url, env.isProduction),
    });
  }
  if (!env.ANTHROPIC_API_KEY) return null;
  return createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.AI_MODEL,
    effort: env.AI_EFFORT,
    timeoutMs: env.AI_TIMEOUT_MS,
  });
}

/** The configured provider, or null when AI is off (no key). Never throws. */
export function getAiProvider(): AiProvider | null {
  if (override !== undefined) return override;
  if (cached === undefined) cached = build();
  return cached;
}

/** Test hook: pass a provider (or null for "AI off"); `undefined` restores env. */
export function setAiProviderForTests(provider: AiProvider | null | undefined) {
  override = provider;
}
