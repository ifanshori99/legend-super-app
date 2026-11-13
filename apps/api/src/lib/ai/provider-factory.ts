import { env } from "../../config/env";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import { createFakeProvider } from "./fake";
import {
  createGuardedFetch,
  defaultHostResolver,
  guardedFetch,
} from "./guarded-fetch";
import { checkAiUrl, type HostResolver } from "./url-guard";
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
      // One paid attempt per gateway reservation.
      maxAttempts: 1,
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

/**
 * Test hook: stand in for the env-built platform provider without marking it
 * as an override, so tenant resolution still runs and a test can prove a
 * tenant with a config row never falls back to it. `undefined` rebuilds from env.
 */
export function setPlatformAiProviderForTests(
  provider: AiProvider | null | undefined,
) {
  cached = provider;
}

/** True while a test has replaced the env provider (including "AI off"). */
export function isAiProviderOverridden(): boolean {
  return override !== undefined;
}

type AiProviderNetwork = { fetch: typeof fetch; resolve: HostResolver };

let networkOverride: AiProviderNetwork | undefined;

/**
 * Network used for tenant-owned provider URLs: PUT validation, connection
 * probe, and the tenant provider. Default is the DNS-pinning guarded fetch.
 */
export function aiProviderNetwork(): AiProviderNetwork {
  return (
    networkOverride ?? { fetch: guardedFetch, resolve: defaultHostResolver }
  );
}

/**
 * Test hook: inject fetch and/or resolver; `null` restores the defaults. A
 * resolver alone also drives the guarded fetch's connect-time lookup.
 */
export function setAiProviderNetworkForTests(
  net: { fetch?: typeof fetch; resolve?: HostResolver } | null,
) {
  if (!net) {
    networkOverride = undefined;
    return;
  }
  const resolve = net.resolve ?? defaultHostResolver;
  networkOverride = {
    fetch:
      net.fetch ?? (net.resolve ? createGuardedFetch(resolve) : guardedFetch),
    resolve,
  };
}

/**
 * A tenant's own OpenAI-compatible provider. The URL is always checked
 * strictly (tenants are never trusted to point at an internal network), even
 * in development and tests.
 */
export function buildTenantAiProvider(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): AiProvider {
  return createOpenAiCompatibleProvider({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: env.AI_TIMEOUT_MS,
    // Ambiguous failures may already be billable; do not retry silently.
    maxAttempts: 1,
    fetch: (url, init) => aiProviderNetwork().fetch(url, init),
    checkUrl: (url) => checkAiUrl(url, true, aiProviderNetwork().resolve),
  });
}
