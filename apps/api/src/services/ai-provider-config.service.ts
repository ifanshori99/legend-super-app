// Per-tenant AI provider config (WS-12, bead legend-dwrr; docs/DECISIONS.md
// "WS-12 provider AI per tenant" items 4-12). One OpenAI-compatible provider
// per tenant, authenticated by an API key.
//
// The key lives in memory only while it is sealed (PUT), probed, or used to
// build the tenant provider. It never reaches a response, audit row, log line,
// error message, or `ai_usage_events`. Reads expose `hasKey` and `keyLast4`.
// Tenant URLs are always checked strictly (even in development and tests).
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  AiError,
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
import { aiProviderConfigs } from "../db/schema/ai-provider.ts";
import { withTenant } from "../db/tenant.ts";
import {
  aiProviderNetwork,
  buildTenantAiProvider,
  getAiProvider,
  isAiProviderOverridden,
} from "../lib/ai/provider-factory.ts";
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

function toConfig(row: ConfigRow): AiProviderConfig {
  return {
    connectionType: row.connectionType,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
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

const toView = (row: ConfigRow | undefined): AiProviderView => ({
  config: row ? toConfig(row) : null,
  fallbackAvailable: getAiProvider() !== null,
});

/** Fields safe for an audit row: never the key, only whether one exists. */
function auditSnapshot(row: ConfigRow): Record<string, unknown> {
  return {
    connectionType: row.connectionType,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
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
): Promise<ConfigRow | undefined> {
  const query = tx
    .select()
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
    toView(await readRow(tx, context.tenant.tenantId)),
  );
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
  const row = await withTenant(db, context, async (tx) => {
    const current = await readRow(tx, tenantId, true);
    // A stored key never moves to another host: a new URL needs a new key.
    if (!input.apiKey && (!current || current.baseUrl !== baseUrl))
      throw new AiError("AI_PROVIDER_KEY_REQUIRED");

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
  return toView(row);
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
    return toView(undefined);
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

    const testedAt = new Date();
    await withTenant(db, context, async (tx) => {
      await tx
        .update(aiProviderConfigs)
        .set({
          lastTestStatus: outcome.status,
          lastTestedAt: testedAt,
          lastTestErrorCode: outcome.errorCode,
          // A test is not a config change: keep updated_at (it versions caches).
          updatedAt: sql`${aiProviderConfigs.updatedAt}`,
        })
        .where(
          and(
            eq(aiProviderConfigs.tenantId, tenantId),
            eq(aiProviderConfigs.id, row.id),
            eq(aiProviderConfigs.baseUrl, row.baseUrl),
            eq(aiProviderConfigs.defaultModel, row.defaultModel),
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
};

/**
 * Which provider serves this tenant: a test override first, then the tenant's
 * own config, then the platform env provider. A tenant that has a config but
 * an unusable one (reserved type, unreadable key) gets null: the platform key
 * is never used behind a misconfigured tenant. No cache: one indexed query and
 * one decryption per call, and a DELETE applies in every process at once.
 */
export async function resolveTenantAiProvider(
  context: ScopedTenantContext,
): Promise<ResolvedAiProvider | null> {
  if (isAiProviderOverridden()) {
    const provider = getAiProvider();
    return provider
      ? { provider, model: env.AI_MODEL, source: "platform" }
      : null;
  }
  const row = await withTenant(db, context, (tx) =>
    readRow(tx, context.tenant.tenantId),
  );
  if (row) {
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
    };
  }
  const provider = getAiProvider();
  return provider
    ? { provider, model: env.AI_MODEL, source: "platform" }
    : null;
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
  return row?.version ?? "none";
}
