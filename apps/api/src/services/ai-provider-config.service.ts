// Per-tenant AI provider config (WS-12, bead legend-dwrr; docs/DECISIONS.md
// "WS-12 provider AI per tenant" items 4-12). One OpenAI-compatible provider
// per tenant, authenticated by an API key.
//
// The key lives in memory only while it is sealed (PUT), probed, or used to
// build the tenant provider. It never reaches a response, audit row, log line,
// error message, or `ai_usage_events`. Reads expose `hasKey` and `keyLast4`.
// Tenant URLs are always checked strictly (even in development and tests).
import { randomUUID } from "node:crypto";
import {
  ChatgptCodexError,
  createChatgptCodexProvider,
  getChatgptCodexModelCapabilities,
} from "../lib/ai/chatgpt-codex.ts";
import {
  getChatgptCredentials,
  getChatgptProviderState,
  invalidateChatgptConnection,
  chatgptConnectionVersionOf,
} from "./ai-chatgpt.service.ts";

import {
  and,
  asc,
  eq,
  getTableColumns,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  AiError,
  aiModelCapabilitiesSchema,
  aiModelCapabilityOverridesSchema,
  type AiModelCapabilities,
  type AiModelCapabilityOverrides,
  type PatchAiProviderConfigInput,
  type AiProviderConfig,
  type AiProviderTestErrorCode,
  type AiProviderTestResult,
  type AiProviderView,
  type UpsertAiProviderConfigInput,
} from "@starter/shared/ai";
import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { isAiPlatformLocked } from "./ai-platform-lock.ts";
import { aiProviderConfigs } from "../db/schema/ai-provider.ts";
import { withTenant } from "../db/tenant.ts";
import {
  aiProviderNetwork,
  buildTenantAiProvider,
  getAiProvider,
  isAiProviderOverridden,
} from "../lib/ai/provider-factory.ts";
import {
  applyCapabilityOverrides,
  detectModelCapabilities,
  getModelCapabilities,
} from "../lib/ai/model-capabilities.ts";
import { probeOpenAiCompatible } from "../lib/ai/provider-probe.ts";
import { checkAiUrl } from "../lib/ai/url-guard.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import {
  currentSealVersion,
  openSecret,
  sealedVersion,
  sealSecret,
} from "../lib/secrets.ts";
import type { AiProvider } from "../lib/ai/types.ts";
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";

type ConfigRow = typeof aiProviderConfigs.$inferSelect;

/** Minimum gap between two connection tests of one tenant. */
const TEST_INTERVAL_MS = 10_000;
/** Hard cap of one probe (DECISIONS butir 9), whatever AI_TIMEOUT_MS says. */
const PROBE_MAX_TIMEOUT_MS = 15_000;

/**
 * Tenants with a connection test in flight (tenantId -> attempt time). The DB
 * check on last_tested_at only sees finished tests; this slot, claimed before
 * the probe, stops two concurrent tests of one tenant from both passing it.
 */
const testsInFlight = new Map<string, number>();

const aadOf = (tenantId: string, id: string) =>
  `ai_provider_config:${tenantId}:${id}`;

const normaliseBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

// One message for every refusal: the client must not learn whether a name
// resolved to a private address or was not found (internal DNS).
const URL_BLOCKED_MESSAGE =
  "Base URL tidak diizinkan. Pakai alamat https publik di port 443.";

/** Tenant URLs use the default https port only (empty or `:443`). */
function hasTenantPort(value: string): boolean {
  try {
    const { port } = new URL(value);
    return port === "" || port === "443";
  } catch {
    return false;
  }
}

function assertTenantScope(context: ScopedTenantContext): void {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new HttpError(403, "FORBIDDEN", "AI provider needs tenant scope.");
}

function capabilitiesOf(row: ConfigRow): AiModelCapabilities {
  const detected = aiModelCapabilitiesSchema.safeParse(
    row.detectedCapabilities,
  );
  const overrides = aiModelCapabilityOverridesSchema.safeParse(
    row.capabilityOverrides,
  );
  return applyCapabilityOverrides(
    detected.success ? detected.data : getModelCapabilities(row.defaultModel),
    overrides.success ? overrides.data : null,
  );
}

function toConfig(row: ConfigRow): AiProviderConfig {
  return {
    connectionType: row.connectionType,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    capabilities: capabilitiesOf(row),
    capabilityOverrides: row.capabilityOverrides,
    hasKey: row.apiKeyEncrypted !== null,
    keyLast4: row.apiKeyLast4,
    keySetAt: row.apiKeySetAt?.toISOString() ?? null,
    lastTest:
      row.lastTestStatus && row.lastTestedAt
        ? {
            status: row.lastTestStatus,
            testedAt: row.lastTestedAt.toISOString(),
            errorCode: (row.lastTestErrorCode ??
              null) as AiProviderTestErrorCode | null,
          }
        : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const toView = (
  row: ConfigRow | undefined,
  platformLocked: boolean,
): AiProviderView => ({
  config: row ? toConfig(row) : null,
  fallbackAvailable: getAiProvider() !== null,
  platformLocked,
});

/** Fields safe for an audit row: never the key, only whether one exists. */
function auditSnapshot(row: ConfigRow): Record<string, unknown> {
  return {
    connectionType: row.connectionType,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    capabilities: capabilitiesOf(row),
    capabilityOverrides: row.capabilityOverrides,
    hasKey: row.apiKeyEncrypted !== null,
    keyLast4: row.apiKeyLast4,
  };
}

async function audit(
  tx: AuditTransaction,
  context: ScopedTenantContext,
  entry: {
    action: string;
    actorUserId: string | null;
    row: ConfigRow;
    before: ConfigRow | null;
    after: ConfigRow | null;
  },
): Promise<void> {
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: entry.actorUserId ? "user" : "system",
      actorId: entry.actorUserId,
      deviceId: null,
      action: entry.action,
      objectType: "ai_provider_config",
      objectId: entry.row.id,
      reason: null,
      before: entry.before ? auditSnapshot(entry.before) : null,
      after: entry.after ? auditSnapshot(entry.after) : null,
      sensitiveAccess: false,
    },
    { tx, context },
  );
}

async function readRow(
  tx: AuditTransaction,
  tenantId: TenantId,
  lock = false,
): Promise<(ConfigRow & { rowVersion: string }) | undefined> {
  const query = tx
    .select({
      ...getTableColumns(aiProviderConfigs),
      rowVersion: sql<string>`${aiProviderConfigs.updatedAt}::text`,
    })
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.tenantId, tenantId))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row;
}

/** The tenant's config without any key material (GET). */
export async function getAiProviderView(
  context: ScopedTenantContext,
): Promise<AiProviderView> {
  assertTenantScope(context);
  return withTenant(db, context, async (tx) =>
    toView(
      await readRow(tx, context.tenant.tenantId),
      await isAiPlatformLocked(tx, context.tenant.tenantId),
    ),
  );
}

/** Partial override edits never erase fields the caller did not provide. */
function mergeCapabilityOverrides(
  previous: AiModelCapabilityOverrides | null,
  patch: AiModelCapabilityOverrides | null | undefined,
): AiModelCapabilityOverrides | null {
  if (patch === undefined) return previous;
  if (patch === null) return null;
  const fields = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(fields).length === 0) return previous;
  // Validate the combined tuple: individually valid partial context/output
  // values can conflict with a field already saved in the tenant's settings.
  return aiModelCapabilityOverridesSchema.parse({ ...previous, ...fields });
}

/** Overrides-only edit: row-lock merge, no credential opening or network I/O. */
export async function patchAiProviderCapabilities(
  context: ScopedTenantContext,
  userId: string,
  input: PatchAiProviderConfigInput,
): Promise<AiProviderView> {
  assertTenantScope(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const current = await readRow(tx, tenantId, true);
    if (!current) throw new AiError("AI_PROVIDER_NOT_CONFIGURED");
    const previous =
      current.capabilityOverrides === null
        ? null
        : aiModelCapabilityOverridesSchema.parse(current.capabilityOverrides);
    const capabilityOverrides = mergeCapabilityOverrides(
      previous,
      input.capabilityOverrides,
    );
    if (JSON.stringify(previous) === JSON.stringify(capabilityOverrides))
      return toView(current, await isAiPlatformLocked(tx, tenantId));
    const [saved] = await tx
      .update(aiProviderConfigs)
      .set({
        capabilityOverrides,
        updatedAt: sql`greatest(clock_timestamp(), ${aiProviderConfigs.updatedAt} + interval '1 microsecond')`,
      })
      .where(
        and(
          eq(aiProviderConfigs.tenantId, tenantId),
          eq(aiProviderConfigs.id, current.id),
        ),
      )
      .returning();
    if (!saved) throw new AiError("AI_PROVIDER_NOT_CONFIGURED");
    await audit(tx, context, {
      action: "ai_provider.updated",
      actorUserId: userId,
      row: saved,
      before: current,
      after: saved,
    });
    return toView(saved, await isAiPlatformLocked(tx, tenantId));
  });
}

/** Save or replace the tenant's provider config (PUT). */
export async function saveAiProviderConfig(
  context: ScopedTenantContext,
  userId: string,
  input: UpsertAiProviderConfigInput,
): Promise<AiProviderView> {
  assertTenantScope(context);
  if (input.connectionType !== "api_key")
    throw new AiError("AI_PROVIDER_CONNECTION_UNSUPPORTED");
  const baseUrl = normaliseBaseUrl(input.baseUrl);
  // Tenants never point at an internal network: strict even in dev and test.
  const blockedReason = await checkAiUrl(
    baseUrl,
    true,
    aiProviderNetwork().resolve,
  );
  if (blockedReason || !hasTenantPort(baseUrl))
    throw new AiError("AI_PROVIDER_URL_BLOCKED", URL_BLOCKED_MESSAGE);

  const tenantId = context.tenant.tenantId;
  const before = await withTenant(db, context, (tx) => readRow(tx, tenantId));
  // Never send a stored key to a changed host, including during discovery.
  if (!input.apiKey && (!before || before.baseUrl !== baseUrl))
    throw new AiError("AI_PROVIDER_KEY_REQUIRED");
  const sameModel =
    before?.baseUrl === baseUrl && before.defaultModel === input.defaultModel;
  // This snapshot is fenced by rowVersion under the write lock below. A
  // concurrent PATCH makes this PUT retry rather than losing either update.
  const capabilityOverrides = mergeCapabilityOverrides(
    sameModel ? before.capabilityOverrides : null,
    input.capabilityOverrides,
  );
  const discoveryKey = input.apiKey ?? (before ? openKey(before) : null);
  if (!discoveryKey) throw new AiError("AI_PROVIDER_KEY_REQUIRED");
  // Do network I/O outside the DB transaction; the snapshot guard below makes
  // sure this discovery cannot overwrite a concurrent key/config change.
  const detectedCapabilities = await detectModelCapabilities({
    baseUrl,
    apiKey: discoveryKey,
    model: input.defaultModel,
  });
  const row = await withTenant(db, context, async (tx) => {
    const current = await readRow(tx, tenantId, true);
    if (
      current?.id !== before?.id ||
      current?.rowVersion !== before?.rowVersion ||
      current?.apiKeyEncrypted !== before?.apiKeyEncrypted
    )
      throw new HttpError(
        409,
        "CONFLICT",
        "AI provider changed during discovery. Try again.",
      );

    const id = current?.id ?? randomUUID();
    const now = new Date();
    const keyFields = input.apiKey
      ? (() => {
          const sealed = sealSecret(input.apiKey, aadOf(tenantId, id));
          return {
            apiKeyEncrypted: sealed,
            apiKeyKeyVersion: sealedVersion(sealed),
            apiKeyLast4: input.apiKey.slice(-4),
            apiKeySetAt: now,
            apiKeySetBy: userId,
          };
        })()
      : {};
    const changed =
      !current ||
      current.baseUrl !== baseUrl ||
      current.defaultModel !== input.defaultModel ||
      input.apiKey !== undefined;
    const testReset = changed
      ? { lastTestStatus: null, lastTestedAt: null, lastTestErrorCode: null }
      : {};

    let saved: ConfigRow | undefined;
    if (current) {
      [saved] = await tx
        .update(aiProviderConfigs)
        .set({
          connectionType: "api_key",
          baseUrl,
          defaultModel: input.defaultModel,
          detectedCapabilities,
          capabilityOverrides,
          // Microsecond monotonic version: app-clock milliseconds can collide.
          updatedAt: sql`greatest(clock_timestamp(), ${aiProviderConfigs.updatedAt} + interval '1 microsecond')`,
          ...keyFields,
          ...testReset,
        })
        .where(
          and(
            eq(aiProviderConfigs.tenantId, tenantId),
            eq(aiProviderConfigs.id, current.id),
          ),
        )
        .returning();
    } else {
      [saved] = await tx
        .insert(aiProviderConfigs)
        .values({
          id,
          tenantId,
          connectionType: "api_key",
          baseUrl,
          defaultModel: input.defaultModel,
          detectedCapabilities,
          capabilityOverrides,
          ...keyFields,
        } as typeof aiProviderConfigs.$inferInsert)
        .onConflictDoNothing()
        .returning();
    }
    if (!saved)
      throw new HttpError(
        409,
        "CONFLICT",
        "AI provider was changed at the same time. Try again.",
      );
    await audit(tx, context, {
      action: current ? "ai_provider.updated" : "ai_provider.created",
      actorUserId: userId,
      row: saved,
      before: current ?? null,
      after: saved,
    });
    return saved;
  });
  return toView(row, await isAiPlatformLocked(db, context.tenant.tenantId));
}

/** Hard delete (DELETE); the tenant falls back to the platform provider. */
export async function removeAiProviderConfig(
  context: ScopedTenantContext,
  userId: string,
): Promise<AiProviderView> {
  assertTenantScope(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const current = await readRow(tx, tenantId, true);
    if (!current) throw new AiError("AI_PROVIDER_NOT_CONFIGURED");
    await tx
      .delete(aiProviderConfigs)
      .where(
        and(
          eq(aiProviderConfigs.tenantId, tenantId),
          eq(aiProviderConfigs.id, current.id),
        ),
      );
    await audit(tx, context, {
      action: "ai_provider.deleted",
      actorUserId: userId,
      row: current,
      before: current,
      after: null,
    });
    return toView(undefined, await isAiPlatformLocked(tx, tenantId));
  });
}

/**
 * Tests the stored config (POST /test). The probe never throws and returns a
 * code from the fixed catalogue; the result is saved on the row, unless the
 * config changed while the probe ran.
 */
export async function testAiProviderConnection(
  context: ScopedTenantContext,
): Promise<AiProviderTestResult> {
  assertTenantScope(context);
  const tenantId = context.tenant.tenantId;
  const row = await withTenant(db, context, (tx) => readRow(tx, tenantId));
  if (!row) throw new AiError("AI_PROVIDER_NOT_CONFIGURED");
  if (
    row.lastTestedAt &&
    Date.now() - row.lastTestedAt.getTime() < TEST_INTERVAL_MS
  )
    throw new AiError("AI_PROVIDER_TEST_TOO_SOON");
  // No await between this check and the claim: the claim is atomic per process.
  if (testsInFlight.has(tenantId))
    throw new AiError("AI_PROVIDER_TEST_TOO_SOON");
  testsInFlight.set(tenantId, Date.now());

  try {
    let outcome: {
      status: "ok" | "failed";
      errorCode: AiProviderTestErrorCode | null;
    };
    const apiKey = openKey(row);
    if (apiKey === null) {
      outcome = { status: "failed", errorCode: "KEY_UNREADABLE" };
    } else if (!hasTenantPort(row.baseUrl)) {
      outcome = { status: "failed", errorCode: "URL_BLOCKED" };
    } else {
      outcome = await probeOpenAiCompatible({
        baseUrl: row.baseUrl,
        apiKey,
        model: row.defaultModel,
        timeoutMs: Math.min(env.AI_TIMEOUT_MS, PROBE_MAX_TIMEOUT_MS),
      });
    }

    const detectedCapabilities =
      apiKey !== null && hasTenantPort(row.baseUrl)
        ? await detectModelCapabilities({
            baseUrl: row.baseUrl,
            apiKey,
            model: row.defaultModel,
          })
        : row.detectedCapabilities;
    const capabilitiesChanged =
      JSON.stringify(detectedCapabilities) !==
      JSON.stringify(row.detectedCapabilities);
    const testedAt = new Date();
    await withTenant(db, context, async (tx) => {
      await tx
        .update(aiProviderConfigs)
        .set({
          lastTestStatus: outcome.status,
          lastTestedAt: testedAt,
          lastTestErrorCode: outcome.errorCode,
          detectedCapabilities,
          // A changed capability changes the request and invalidates cached answers.
          updatedAt: capabilitiesChanged
            ? sql`greatest(clock_timestamp(), ${aiProviderConfigs.updatedAt} + interval '1 microsecond')`
            : sql`${aiProviderConfigs.updatedAt}`,
        })
        .where(
          and(
            eq(aiProviderConfigs.tenantId, tenantId),
            eq(aiProviderConfigs.id, row.id),
            eq(aiProviderConfigs.baseUrl, row.baseUrl),
            eq(aiProviderConfigs.defaultModel, row.defaultModel),
            sql`${aiProviderConfigs.updatedAt}::text = ${row.rowVersion}`,
            row.apiKeyEncrypted === null
              ? isNull(aiProviderConfigs.apiKeyEncrypted)
              : eq(aiProviderConfigs.apiKeyEncrypted, row.apiKeyEncrypted),
          ),
        );
    });
    return {
      status: outcome.status,
      testedAt: testedAt.toISOString(),
      errorCode: outcome.errorCode,
    };
  } finally {
    testsInFlight.delete(tenantId);
  }
}

/** The key of a row, or null when it cannot be opened (never throws). */
function openKey(row: ConfigRow): string | null {
  if (row.connectionType !== "api_key" || !row.apiKeyEncrypted) return null;
  try {
    return openSecret(row.apiKeyEncrypted, aadOf(row.tenantId, row.id));
  } catch {
    return null;
  }
}

export type ResolvedAiProvider = {
  provider: AiProvider;
  model: string;
  source: "tenant" | "platform";
  capabilities: AiModelCapabilities;
  /** Chosen only by this server; never accepted from callers or remote models. */
  billingMode: "api_metered" | "chatgpt_plan";
};

/**
 * Which provider serves this tenant: a test override first, then the tenant's
 * own config, then the platform env provider. A tenant that has a config but
 * an unusable one (reserved type, unreadable key) gets null: the platform key
 * is never used behind a misconfigured tenant. No cache: one indexed query and
 * one decryption per call, and a DELETE applies in every process at once.
 */
/** The tenant's explicit API-key fallback, never the platform's credentials. */
export async function resolveTenantCustomAiProvider(
  context: ScopedTenantContext,
): Promise<ResolvedAiProvider | null> {
  const row = await withTenant(db, context, (tx) =>
    readRow(tx, context.tenant.tenantId),
  );
  if (!row) return null;
  const apiKey = openKey(row);
  if (apiKey === null || !hasTenantPort(row.baseUrl)) return null;
  return {
    provider: buildTenantAiProvider({
      baseUrl: row.baseUrl,
      apiKey,
      model: row.defaultModel,
    }),
    model: row.defaultModel,
    source: "tenant",
    capabilities: capabilitiesOf(row),
    billingMode: "api_metered",
  };
}
export async function resolveTenantAiProvider(
  context: ScopedTenantContext,
): Promise<ResolvedAiProvider | null> {
  if (isAiProviderOverridden()) {
    const provider = getAiProvider();
    return provider
      ? {
          provider,
          model: env.AI_MODEL,
          source: "platform",
          capabilities: getModelCapabilities(env.AI_MODEL),
          billingMode: "api_metered",
        }
      : null;
  }
  const chatgpt = await getChatgptProviderState(context);
  if (chatgpt.exists) {
    if (!chatgpt.active || !chatgpt.model || chatgpt.generation === null)
      return resolveTenantCustomAiProvider(context);
    const model = chatgpt.model;
    const generation = chatgpt.generation;
    // The transport speaks tools/reasoning, but that alone does not prove a
    // particular unknown model supports either. Keep A's conservative default.
    const capabilities = getChatgptCodexModelCapabilities(model);
    return {
      model,
      source: "tenant",
      capabilities,
      billingMode: "chatgpt_plan",
      provider: {
        name: "chatgpt-codex",
        async complete(request, options) {
          // Capture only inside this attempt. A shared provider object may be
          // used concurrently; no other call can replace its issued credential
          // fingerprint. Refresh-only rotations change this fingerprint too.
          let issuedCredentialVersion: string | undefined;
          const provider = createChatgptCodexProvider({
            model,
            getCredentials: async () => {
              const credentials = await getChatgptCredentials(
                context,
                generation,
              );
              issuedCredentialVersion = credentials?.credentialVersion;
              return credentials;
            },
            stillConnected: async () => {
              const state = await getChatgptProviderState(context);
              return state.active && state.generation === generation;
            },
          });
          try {
            return await provider.complete(request, options);
          } catch (error) {
            if (
              error instanceof ChatgptCodexError &&
              error.kind === "auth" &&
              error.upstreamAuthRejected &&
              issuedCredentialVersion
            ) {
              await invalidateChatgptConnection(context, generation, {
                credentialVersion: issuedCredentialVersion,
              });
            }
            throw error;
          }
        },
      },
    };
  }
  const custom = await resolveTenantCustomAiProvider(context);
  if (custom) return custom;
  // A broken API-key configuration never falls through to a platform key.
  const configured = await withTenant(db, context, (tx) =>
    readRow(tx, context.tenant.tenantId),
  );
  if (configured) return null;
  const provider = getAiProvider();
  return provider
    ? {
        provider,
        model: env.AI_MODEL,
        source: "platform",
        capabilities: getModelCapabilities(env.AI_MODEL),
        billingMode: "api_metered",
      }
    : null;
}

/** Effective tenant capabilities without any metadata network call. */
export async function resolveTenantAiCapabilities(
  context: ScopedTenantContext,
): Promise<AiModelCapabilities> {
  return (
    (await resolveTenantAiProvider(context))?.capabilities ??
    getModelCapabilities("unknown")
  );
}

/**
 * Key rotation: re-seals the tenant's stored key when its envelope/key version
 * is not the current one (or always with `force`), with a fresh nonce. The key
 * itself, `updated_at`, and set-at/by stay. Pattern of
 * `rotateIntegrationCredentials`.
 */
export async function rotateAiProviderKeys(
  context: ScopedTenantContext,
  options: { actorUserId?: string | null; force?: boolean } = {},
): Promise<{ rotated: number }> {
  assertTenantScope(context);
  const version = currentSealVersion();
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const stale = options.force
      ? sql`true`
      : or(
          isNull(aiProviderConfigs.apiKeyKeyVersion),
          ne(aiProviderConfigs.apiKeyKeyVersion, version),
        );
    const rows = await tx
      .select()
      .from(aiProviderConfigs)
      .where(
        and(
          eq(aiProviderConfigs.tenantId, tenantId),
          sql`${aiProviderConfigs.apiKeyEncrypted} IS NOT NULL`,
          stale,
        ),
      )
      .orderBy(asc(aiProviderConfigs.id))
      .for("update");
    let rotated = 0;
    for (const current of rows) {
      const apiKey = openKey(current);
      if (apiKey === null) {
        // One unreadable blob must not stop the others. Row id only, no key.
        logger.warn({ configId: current.id }, "ai provider key unreadable");
        continue;
      }
      const sealed = sealSecret(apiKey, aadOf(tenantId, current.id));
      const [row] = await tx
        .update(aiProviderConfigs)
        .set({
          apiKeyEncrypted: sealed,
          apiKeyKeyVersion: sealedVersion(sealed),
          updatedAt: sql`${aiProviderConfigs.updatedAt}`,
        })
        .where(
          and(
            eq(aiProviderConfigs.tenantId, tenantId),
            eq(aiProviderConfigs.id, current.id),
          ),
        )
        .returning();
      if (!row) continue;
      await audit(tx, context, {
        action: "ai_provider.key_rotated",
        actorUserId: options.actorUserId ?? null,
        row,
        before: current,
        after: row,
      });
      rotated += 1;
    }
    return { rotated };
  });
}

/** `updated_at` of the tenant's provider config as text, or "none". */
export async function aiProviderVersionOf(
  tx: AuditTransaction,
  tenantId: TenantId,
): Promise<string> {
  const [row] = await tx
    .select({ version: sql<string>`${aiProviderConfigs.updatedAt}::text` })
    .from(aiProviderConfigs)
    .where(eq(aiProviderConfigs.tenantId, tenantId))
    .limit(1);
  return `${row?.version ?? "none"}|chatgpt:${await chatgptConnectionVersionOf(tx, tenantId)}`;
}
