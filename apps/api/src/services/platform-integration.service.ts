// Per-tenant integrations store (PRD v1.7 §3 F4 "Integrasi per Tenant", §6 A
// `tenant_integrations`; PAY-06).
//
// Credentials are WRITE-ONLY:
// - sealed with lib/secrets.ts (AES-256-GCM, AAD bound to tenant + row id) and
//   stored with the envelope/key version;
// - a read returns only the opaque `sec_…` reference, the field names and
//   who/when set them (`credentialRefSchema`), never a value;
// - audit snapshots carry field names and flags only, and nothing here logs.
//
// Every function takes the server-minted ScopedTenantContext and runs inside
// `withTenant`, so RLS (`app.enforce_tenant_rls`) applies on top of the
// explicit tenant_id filters. The tenant never comes from the request (TEN-02).

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  GATEWAY_CREDENTIAL_SPECS,
  GATEWAY_PREVIOUS_VALID_UNTIL,
  PlatformError,
  canTransitionIntegration,
  featureFlagsSchema,
  gatewayCredentialIssues,
  isGatewayPreviousKey,
  isGatewayProvider,
  isIntegrationProviderAvailable,
  resolveIntegration,
  tenantIntegrationSchema,
  type IntegrationProvider,
  type TenantIntegration,
  type UpsertIntegrationInput,
} from "@starter/shared/platform";
import { normalizeWhatsAppNumber } from "@starter/shared/identity";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema/index.ts";
import { db } from "../db/index.ts";
import { outlets, tenantIntegrations, tenants } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { newSecretRef, openSecret, sealSecret } from "../lib/secrets.ts";
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";
import { duitkuSandboxRefused } from "./payment-duitku-sandbox-policy.ts";
import { clearDoitWebhookSecretCache } from "./payment-webhook.service.ts";
import { gatewaySecretGraceMs } from "./platform-payment-gateway.service.ts";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type IntegrationRow = typeof tenantIntegrations.$inferSelect;

// ------------------------------------------------------------- sealing

/** AAD binds a sealed blob to its tenant and row: a copied blob fails to open. */
function credentialAad(tenantId: string, integrationId: string): string {
  return `tenant_integration:${tenantId}:${integrationId}`;
}

/** Leading version byte of a lib/secrets.ts envelope. */
export function sealedVersion(sealed: string): number {
  const version = Buffer.from(sealed, "base64")[0];
  if (version === undefined) throw new Error("Sealed value is empty");
  return version;
}

let currentVersion: number | undefined;
/**
 * The envelope/key version lib/secrets.ts writes today, read from a probe
 * envelope so this module never duplicates the constant.
 */
export function currentCredentialKeyVersion(): number {
  currentVersion ??= sealedVersion(sealSecret("probe", "key-version-probe"));
  return currentVersion;
}

/** Stable JSON: sorted keys, so equal credentials compare equal. */
function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  );
}

function sealCredentials(
  tenantId: string,
  integrationId: string,
  credentials: Record<string, string>,
  /** Fields the client sent; `previous*` keys of a rotation stay unlisted. */
  clientFields: readonly string[] = Object.keys(credentials),
) {
  const sealed = sealSecret(
    canonicalJson(credentials),
    credentialAad(tenantId, integrationId),
  );
  return {
    credentialsEncrypted: sealed,
    credentialsKeyVersion: sealedVersion(sealed),
    credentialFields: [...clientFields].sort(),
  };
}

/** Opens a row's credentials. Server-side only; never return or log this. */
function openCredentials(row: IntegrationRow): Record<string, string> {
  if (!row.credentialsEncrypted)
    throw new Error("Integration has no stored credentials");
  const parsed: unknown = JSON.parse(
    openSecret(row.credentialsEncrypted, credentialAad(row.tenantId, row.id)),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === "string")
  )
    throw new Error("Stored credentials are malformed");
  return parsed as Record<string, string>;
}

/** The fields a client sent: a gateway blob also holds server-written `previous*` keys. */
function clientCredentialFields(
  provider: IntegrationProvider,
  credentials: Record<string, string>,
): Record<string, string> {
  if (!isGatewayProvider(provider)) return credentials;
  return Object.fromEntries(
    Object.entries(credentials).filter(([key]) => !isGatewayPreviousKey(key)),
  );
}

/**
 * Sealed blob of a replaced gateway credential set (sub-302 D17). When a
 * rotating field changed, the old values ride along as `previous*` plus
 * `previousValidUntil` (one generation only: older previous* keys are
 * dropped). Otherwise an existing previous generation is carried through.
 */
function withPreviousGeneration(
  provider: IntegrationProvider,
  stored: Record<string, string> | null,
  incoming: Record<string, string>,
  graceMs: number,
): { credentials: Record<string, string>; previousValidUntil: string | null } {
  if (!isGatewayProvider(provider) || !stored)
    return { credentials: incoming, previousValidUntil: null };
  const spec = GATEWAY_CREDENTIAL_SPECS[provider as "doit" | "duitku"];
  const previousKeys = spec.previous as Record<string, string>;
  const rotatingChanged = spec.rotating.some(
    (field) => stored[field] !== undefined && stored[field] !== incoming[field],
  );
  if (!rotatingChanged) {
    const carried = Object.fromEntries(
      Object.entries(stored).filter(([key]) => isGatewayPreviousKey(key)),
    );
    return {
      credentials: { ...incoming, ...carried },
      previousValidUntil: null,
    };
  }
  const previousValidUntil = new Date(Date.now() + graceMs).toISOString();
  const previous: Record<string, string> = {};
  for (const field of spec.rotating) {
    const key = previousKeys[field];
    const value = stored[field];
    if (key !== undefined && value !== undefined) previous[key] = value;
  }
  return {
    credentials: {
      ...incoming,
      ...previous,
      [GATEWAY_PREVIOUS_VALID_UNTIL]: previousValidUntil,
    },
    previousValidUntil,
  };
}

/** True when `incoming` equals what is stored (idempotent PUT keeps the blob). */
function sameStoredCredentials(
  row: IntegrationRow,
  incoming: Record<string, string>,
): boolean {
  if (!row.credentialsEncrypted) return false;
  try {
    return (
      canonicalJson(
        clientCredentialFields(row.provider, openCredentials(row)),
      ) === canonicalJson(incoming)
    );
  } catch {
    // Unreadable blob (tampered, foreign key): replace it with the new one.
    return false;
  }
}

// ------------------------------------------------------------- mapping

function hasCredentials(row: IntegrationRow): boolean {
  return (
    row.credentialsEncrypted !== null &&
    row.credentialSecretRef !== null &&
    (row.credentialFields?.length ?? 0) > 0 &&
    row.credentialsSetAt !== null &&
    row.credentialsSetBy !== null
  );
}

/** Wire shape: the secret reference and field names, never a value. */
function toIntegration(row: IntegrationRow): TenantIntegration {
  return tenantIntegrationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    provider: row.provider,
    config: row.config,
    credentials: hasCredentials(row)
      ? {
          secretRef: row.credentialSecretRef,
          fields: row.credentialFields,
          setAt: row.credentialsSetAt?.toISOString(),
          setBy: row.credentialsSetBy,
        }
      : null,
    status: row.status,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** Audit-safe snapshot: names and flags only (PAY-06: no secret in audit). */
function auditSnapshot(row: IntegrationRow): Record<string, unknown> {
  return {
    provider: row.provider,
    outletId: row.outletId,
    status: row.status,
    configKeys: Object.keys(row.config).sort(),
    credentialFields: row.credentialFields ?? [],
    credentialsConfigured: row.credentialsEncrypted !== null,
  };
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  entry: {
    action: string;
    actorUserId: string | null;
    row: IntegrationRow;
    before: IntegrationRow | null;
  },
): Promise<void> {
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: entry.row.outletId,
      actorType: entry.actorUserId ? "user" : "system",
      actorId: entry.actorUserId,
      deviceId: null,
      action: entry.action,
      objectType: "tenant_integration",
      objectId: entry.row.id,
      reason: null,
      before: entry.before ? auditSnapshot(entry.before) : null,
      after: auditSnapshot(entry.row),
      sensitiveAccess: false,
    },
    { tx: tx as AuditTransaction, context },
  );
}

/** Audit row whose `after` is a small named payload (no row snapshot, no secret). */
async function auditDetail(
  tx: Tx,
  context: ScopedTenantContext,
  entry: {
    action: string;
    actorUserId: string | null;
    row: IntegrationRow;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(
    {
      tenantId: context.tenant.tenantId,
      outletId: entry.row.outletId,
      actorType: entry.actorUserId ? "user" : "system",
      actorId: entry.actorUserId,
      deviceId: null,
      action: entry.action,
      objectType: "tenant_integration",
      objectId: entry.row.id,
      reason: null,
      before: null,
      after: entry.detail,
      sensitiveAccess: false,
    },
    { tx: tx as AuditTransaction, context },
  );
}

// ------------------------------------------------------------- guards

/** Outlet rows are visible/writable only inside the caller's outlet scope. */
function scopeFilter(context: ScopedTenantContext): SQL | undefined {
  if (context.outletScope.kind === "tenant") return undefined;
  return inArray(tenantIntegrations.outletId, [
    ...context.outletScope.outletIds,
  ]);
}

function assertRowInScope(context: ScopedTenantContext, row: IntegrationRow) {
  if (context.outletScope.kind === "tenant") return;
  // A tenant-wide row is a tenant setting: outlet-scoped callers cannot touch it.
  if (row.outletId === null)
    throw new HttpError(404, "NOT_FOUND", "Integration not found.");
  assertOutletInScope(context.outletScope, row.outletId);
}

async function assertProviderAvailable(
  tx: Tx,
  tenantId: string,
  provider: IntegrationProvider,
): Promise<void> {
  const [row] = await tx
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  const flags = featureFlagsSchema.safeParse(row.featureFlags);
  // Fail closed: unreadable flags make every provider unavailable.
  if (!flags.success || !isIntegrationProviderAvailable(flags.data, provider))
    throw new PlatformError("INTEGRATION_PROVIDER_NOT_AVAILABLE");
}

async function requireOutlet(tx: Tx, tenantId: string, outletId: string) {
  const [row] = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
}

async function lockByKey(
  tx: Tx,
  tenantId: string,
  outletId: string | null,
  provider: IntegrationProvider,
): Promise<IntegrationRow | undefined> {
  const [row] = await tx
    .select()
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, tenantId),
        eq(tenantIntegrations.provider, provider),
        outletId === null
          ? isNull(tenantIntegrations.outletId)
          : eq(tenantIntegrations.outletId, outletId),
      ),
    )
    .limit(1)
    .for("update");
  return row;
}

/**
 * True when `error` (or its drizzle `cause` chain) is the unique violation of
 * one of the WhatsApp number indexes: another tenant already routes that
 * number (legend-mbd2).
 */
function isWhatsAppNumberClaim(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    (candidate.code === "23505" &&
      (candidate.constraint === "tenant_integrations_whatsapp_number_key" ||
        candidate.constraint === "tenant_integrations_whatsapp_routing_key")) ||
    isWhatsAppNumberClaim(candidate.cause, depth + 1)
  );
}

const WHATSAPP_PHONE_NUMBER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Canonical whatsapp config (legend-mbd2): the receiving number as digits and
 * the phoneNumberId trimmed. The login flow routes on the same JS trim and
 * normalization, so what is stored must be what the claim indexes see.
 */
function canonicalWhatsAppConfig(
  config: UpsertIntegrationInput["config"],
): UpsertIntegrationInput["config"] {
  const next = { ...config };
  // null or blank means "not set yet" (a draft), same as configText().
  const unset = (value: unknown) =>
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "");
  const receiving = next.receivingNumber;
  if (!unset(receiving)) {
    const digits = normalizeWhatsAppNumber(
      typeof receiving === "boolean" ? "" : String(receiving),
    );
    if (!digits)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Receiving WhatsApp number is not a valid number.",
      );
    next.receivingNumber = digits;
  }
  const phoneNumberId = next.phoneNumberId;
  if (!unset(phoneNumberId)) {
    const trimmed =
      typeof phoneNumberId === "boolean" ? "" : String(phoneNumberId).trim();
    if (!WHATSAPP_PHONE_NUMBER_ID.test(trimmed))
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "WhatsApp phone number ID may only use letters, digits, dot, dash and underscore (1 to 64).",
      );
    next.phoneNumberId = trimmed;
  }
  return next;
}

/** Runs a write that can set a whatsapp row active; maps a number clash. */
async function claimingWhatsAppNumber<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isWhatsAppNumberClaim(error))
      throw new PlatformError("WHATSAPP_NUMBER_TAKEN");
    throw error;
  }
}

/** 1269 C0: the adapter refuses a sandbox account in production, so a saved or
 * activated one would only break payments. */
function assertDuitkuSandboxAllowed(row: {
  provider: IntegrationProvider;
  config: Record<string, unknown>;
}): void {
  if (
    row.provider === "duitku" &&
    row.config.environment === "sandbox" &&
    duitkuSandboxRefused()
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Invalid duitku settings: environment (sandbox is not allowed in production).",
    );
}

// ------------------------------------------------------------- services

/** GET /api/org/integrations: masked rows of the caller's tenant. */
export async function listIntegrations(
  context: ScopedTenantContext,
): Promise<{ data: TenantIntegration[] }> {
  return withTenant(db, context, async (tx) => {
    const filters = [eq(tenantIntegrations.tenantId, context.tenant.tenantId)];
    const scope = scopeFilter(context);
    if (scope) filters.push(scope);
    const rows = await tx
      .select()
      .from(tenantIntegrations)
      .where(and(...filters))
      .orderBy(
        asc(tenantIntegrations.provider),
        sql`${tenantIntegrations.outletId} NULLS FIRST`,
        asc(tenantIntegrations.id),
      );
    // A row written outside this service (seed/legacy) can hold a sealed blob
    // without the secret-reference metadata the wire contract needs. It is
    // left out of the list instead of failing the whole page; a PUT with
    // credentials repairs it. Rows written here always satisfy the contract.
    const data: TenantIntegration[] = [];
    for (const row of rows) {
      try {
        data.push(toIntegration(row));
      } catch {
        // Id only: never the error message or any credential material.
        logger.warn(
          { tenantId: context.tenant.tenantId, integrationId: row.id },
          "integration row skipped: stored credentials unreadable",
        );
        continue;
      }
    }
    return { data };
  });
}

/** The `maxFee*` keys of a config (C4a fee caps), for comparison. */
function feeCapKeys(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config)
      .filter(([key]) => key.startsWith("maxFee"))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * PUT /api/org/integrations: idempotent upsert keyed by (tenant, outlet,
 * provider). A new row starts as `draft`. `credentials` omitted keeps the
 * stored secret; present replaces it as a whole (new secret reference). The
 * same body twice changes nothing and writes no second audit row.
 */
export async function upsertIntegration(
  context: ScopedTenantContext,
  rawInput: UpsertIntegrationInput,
  actorUserId: string,
  options: { readonly platform?: boolean } = {},
): Promise<TenantIntegration> {
  const input =
    rawInput.provider === "whatsapp"
      ? { ...rawInput, config: canonicalWhatsAppConfig(rawInput.config) }
      : rawInput;
  // Super Admin's grace window for a replaced gateway secret (D17); read
  // before the transaction so no second connection is taken inside it.
  const graceMs =
    input.credentials && isGatewayProvider(input.provider)
      ? await gatewaySecretGraceMs(input.provider)
      : 0;
  const result = await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    if (input.outletId !== null) {
      assertOutletInScope(context.outletScope, input.outletId);
      await requireOutlet(tx, tenantId, input.outletId);
    } else if (context.outletScope.kind !== "tenant") {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Tenant-wide integrations need tenant-wide access.",
      );
    }
    await assertProviderAvailable(tx, tenantId, input.provider);
    let current = await lockByKey(tx, tenantId, input.outletId, input.provider);
    // 1272 K5 P2: the C4a fee caps (`maxFee*`) are the platform's. A tenant or
    // outlet admin saves them as stored, so the cap check below reads the
    // stored value and a request body cannot raise its own limit.
    if (
      options.platform !== true &&
      canonicalJson(feeCapKeys(current?.config ?? {})) !==
        canonicalJson(feeCapKeys(input.config))
    )
      throw new HttpError(
        403,
        "DUITKU_FEE_CAP_PLATFORM_ONLY",
        "Batas biaya gateway hanya bisa diubah oleh platform.",
      );
    // Field names only: a refused body must not echo a value (PAY-06).
    const issues = gatewayCredentialIssues(
      input.provider,
      input.config,
      input.credentials,
    );
    if (issues.length > 0)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        `Invalid ${input.provider} settings: ${issues.join(", ")}.`,
      );
    assertDuitkuSandboxAllowed(input);

    const credentialColumns = (
      integrationId: string,
      stored: Record<string, string> | null = null,
    ) => {
      if (!input.credentials) return { sealed: {}, previousValidUntil: null };
      const next = withPreviousGeneration(
        input.provider,
        stored,
        input.credentials,
        graceMs,
      );
      return {
        sealed: {
          ...sealCredentials(
            tenantId,
            integrationId,
            next.credentials,
            Object.keys(input.credentials),
          ),
          credentialSecretRef: newSecretRef(),
          credentialsSetAt: new Date(),
          credentialsSetBy: actorUserId,
        },
        previousValidUntil: next.previousValidUntil,
      };
    };

    if (!current) {
      const id = randomUUID();
      const [inserted] = await tx
        .insert(tenantIntegrations)
        .values({
          id,
          tenantId,
          outletId: input.outletId,
          provider: input.provider,
          config: input.config,
          status: "draft",
          ...credentialColumns(id).sealed,
        })
        // Explicit target: a bare DO NOTHING would also swallow a clash on
        // the WhatsApp number indexes and look like "a concurrent PUT won".
        .onConflictDoNothing(
          input.outletId === null
            ? {
                target: [
                  tenantIntegrations.tenantId,
                  tenantIntegrations.provider,
                ],
                where: sql`${tenantIntegrations.outletId} IS NULL`,
              }
            : {
                target: [
                  tenantIntegrations.tenantId,
                  tenantIntegrations.outletId,
                  tenantIntegrations.provider,
                ],
                where: sql`${tenantIntegrations.outletId} IS NOT NULL`,
              },
        )
        .returning();
      if (inserted) {
        await audit(tx, context, {
          action: "integration.created",
          actorUserId,
          row: inserted,
          before: null,
        });
        return toIntegration(inserted);
      }
      // A concurrent PUT created the row first: update it instead.
      current = await lockByKey(tx, tenantId, input.outletId, input.provider);
      if (!current)
        throw new HttpError(409, "CONFLICT", "Try the change again.");
    }

    const configChanged =
      canonicalJson(current.config) !== canonicalJson(input.config);
    const credentialsChanged =
      input.credentials !== undefined &&
      !sameStoredCredentials(current, input.credentials);
    if (!configChanged && !credentialsChanged) return toIntegration(current);

    let storedCredentials: Record<string, string> | null = null;
    if (credentialsChanged && current.credentialsEncrypted) {
      try {
        storedCredentials = openCredentials(current);
      } catch {
        // Unreadable blob: nothing to keep as the previous generation.
      }
    }
    const replacement = credentialsChanged
      ? credentialColumns(current.id, storedCredentials)
      : { sealed: {}, previousValidUntil: null };
    const [row] = await claimingWhatsAppNumber(() =>
      tx
        .update(tenantIntegrations)
        .set({
          ...(configChanged ? { config: input.config } : {}),
          ...replacement.sealed,
        })
        .where(
          and(
            eq(tenantIntegrations.tenantId, tenantId),
            eq(tenantIntegrations.id, current.id),
          ),
        )
        .returning(),
    );
    if (!row) throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    await audit(tx, context, {
      action: credentialsChanged
        ? "integration.credentials.replaced"
        : "integration.config.updated",
      actorUserId,
      row,
      before: current,
    });
    if (replacement.previousValidUntil)
      await auditDetail(tx, context, {
        action: "integration.credentials_rotated",
        actorUserId,
        row,
        detail: {
          provider: row.provider,
          previousValidUntil: replacement.previousValidUntil,
        },
      });
    return toIntegration(row);
  });
  // After commit: the webhook secret cache must not outlive a change.
  clearDoitWebhookSecretCache(context.tenant.tenantId);
  return result;
}

/**
 * POST /api/org/integrations/:integrationId/status. Contract state machine
 * (`canTransitionIntegration`): activating needs stored credentials and a
 * provider Super Admin still makes available. Same status = no-op.
 */
export async function setIntegrationStatus(
  context: ScopedTenantContext,
  integrationId: string,
  input: { status: "active" | "disabled" },
  actorUserId: string,
): Promise<TenantIntegration> {
  const result = await withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [current] = await tx
      .select()
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.id, integrationId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current)
      throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    assertRowInScope(context, current);
    if (current.status === input.status) return toIntegration(current);
    if (
      !canTransitionIntegration(
        current.status,
        input.status,
        hasCredentials(current),
      )
    )
      throw new PlatformError("INVALID_TRANSITION");
    if (input.status === "active") {
      await assertProviderAvailable(tx, tenantId, current.provider);
      assertDuitkuSandboxAllowed(current);
    }
    const [row] = await claimingWhatsAppNumber(() =>
      tx
        .update(tenantIntegrations)
        .set({ status: input.status })
        .where(
          and(
            eq(tenantIntegrations.tenantId, tenantId),
            eq(tenantIntegrations.id, integrationId),
          ),
        )
        .returning(),
    );
    if (!row) throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    await audit(tx, context, {
      action: "integration.status.changed",
      actorUserId,
      row,
      before: current,
    });
    return toIntegration(row);
  });
  // After commit: a disabled or activated secret applies at once.
  clearDoitWebhookSecretCache(context.tenant.tenantId);
  return result;
}

/**
 * A row the caller may reach, for the gateway "test connection" action
 * (sub-302 D16): same scope rules as a status change, any status (a draft is
 * testable). Unknown id, other tenant or out of scope = 404.
 */
export async function getIntegrationForCheck(
  context: ScopedTenantContext,
  integrationId: string,
): Promise<{
  id: string;
  provider: IntegrationProvider;
  outletId: string | null;
}> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, context.tenant.tenantId),
          eq(tenantIntegrations.id, integrationId),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    assertRowInScope(context, row);
    return { id: row.id, provider: row.provider, outletId: row.outletId };
  });
}

/**
 * Stores the outcome of a connection test: `last_checked_at`,
 * `last_error_code` (null on ok) and the `integration.connection_tested`
 * audit row, in one transaction. The error code is a fixed adapter code,
 * never provider text.
 */
export async function recordConnectionCheck(
  context: ScopedTenantContext,
  integrationId: string,
  actorUserId: string,
  outcome: { ok: boolean; errorCode: string | null },
): Promise<{ checkedAt: string }> {
  return withTenant(db, context, async (tx) => {
    const checkedAt = new Date();
    const [row] = await tx
      .update(tenantIntegrations)
      .set({ lastCheckedAt: checkedAt, lastErrorCode: outcome.errorCode })
      .where(
        and(
          eq(tenantIntegrations.tenantId, context.tenant.tenantId),
          eq(tenantIntegrations.id, integrationId),
        ),
      )
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    await auditDetail(tx, context, {
      action: "integration.connection_tested",
      actorUserId,
      row,
      detail: { ok: outcome.ok, errorCode: outcome.errorCode },
    });
    return {
      checkedAt: row.lastCheckedAt?.toISOString() ?? checkedAt.toISOString(),
    };
  });
}

/**
 * Key rotation: re-seals every stored credential of the tenant whose
 * envelope/key version is not the current one (or all of them with
 * `force`), with a fresh nonce under the current key. The secret reference
 * and set-at/by stay: the secret itself did not change. One audit row per
 * re-sealed integration, actor `system` unless a user triggered it.
 */
export async function rotateIntegrationCredentials(
  context: ScopedTenantContext,
  options: { actorUserId?: string | null; force?: boolean } = {},
): Promise<{ rotated: number }> {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new HttpError(403, "FORBIDDEN", "Key rotation needs tenant scope.");
  const version = currentCredentialKeyVersion();
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const stale = options.force
      ? sql`true`
      : or(
          isNull(tenantIntegrations.credentialsKeyVersion),
          ne(tenantIntegrations.credentialsKeyVersion, version),
        );
    const rows = await tx
      .select()
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          sql`${tenantIntegrations.credentialsEncrypted} IS NOT NULL`,
          stale,
        ),
      )
      .orderBy(asc(tenantIntegrations.id))
      .for("update");
    let rotated = 0;
    for (const current of rows) {
      const sealed = sealCredentials(
        tenantId,
        current.id,
        openCredentials(current),
      );
      const [row] = await tx
        .update(tenantIntegrations)
        .set({
          credentialsEncrypted: sealed.credentialsEncrypted,
          credentialsKeyVersion: sealed.credentialsKeyVersion,
        })
        .where(
          and(
            eq(tenantIntegrations.tenantId, tenantId),
            eq(tenantIntegrations.id, current.id),
          ),
        )
        .returning();
      if (!row) continue;
      await audit(tx, context, {
        action: "integration.credentials.rotated",
        actorUserId: options.actorUserId ?? null,
        row,
        before: current,
      });
      rotated += 1;
    }
    return { rotated };
  });
}

/**
 * Server-side credential lookup for provider adapters (DOIT, KirimDev, …):
 * the active outlet row wins over the active tenant row (`resolveIntegration`),
 * none = null (fail closed). The plaintext stays in the caller's memory: never
 * return it from a route, put it in an event or audit, or log it.
 */
export async function loadActiveIntegrationCredentials(
  context: ScopedTenantContext,
  provider: IntegrationProvider,
  outletId: string | null,
): Promise<{
  integration: TenantIntegration;
  credentials: Record<string, string>;
} | null> {
  if (outletId !== null) assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    // Super Admin withdrew the provider: stored rows no longer apply.
    try {
      await assertProviderAvailable(tx, tenantId, provider);
    } catch (error) {
      if (error instanceof PlatformError) return null;
      throw error;
    }
    const rows = await tx
      .select()
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.provider, provider),
          eq(tenantIntegrations.status, "active"),
        ),
      );
    const chosen = resolveIntegration(
      rows.map(toIntegration),
      provider,
      outletId,
    );
    const row = chosen && rows.find((candidate) => candidate.id === chosen.id);
    if (!chosen || !row) return null;
    return { integration: chosen, credentials: openCredentials(row) };
  });
}

/**
 * Credentials of one integration row by id, whatever its status: a payment
 * already minted on this row is still checked (and its webhook verified) with
 * the account that created it after the row is disabled or an outlet row
 * starts to win. Never use it to pick credentials for new work; that is
 * `loadActiveIntegrationCredentials`. A withdrawn provider, an unknown id, a
 * row of another provider or outlet outside the caller's scope, or a row
 * without stored credentials = null.
 */
export async function loadIntegrationCredentialsById(
  context: ScopedTenantContext,
  provider: IntegrationProvider,
  integrationId: string,
  options: {
    /**
     * The caller reconciles a payment ALREADY minted on this integration
     * (callback verification, status check, poll, cancel). The plan check is
     * skipped: removing the provider from the plan stops new payments, never
     * the reconciliation of money already in flight (Codex P1 legend-rgddb).
     * Tenant, provider, integration id and outlet scope still bind the row.
     */
    forStoredIntent?: boolean;
  } = {},
): Promise<{
  integration: TenantIntegration;
  credentials: Record<string, string>;
} | null> {
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    if (!options.forStoredIntent)
      try {
        await assertProviderAvailable(tx, tenantId, provider);
      } catch (error) {
        if (error instanceof PlatformError) return null;
        throw error;
      }
    const [row] = await tx
      .select()
      .from(tenantIntegrations)
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.id, integrationId),
          eq(tenantIntegrations.provider, provider),
        ),
      )
      .limit(1);
    if (!row || !row.credentialsEncrypted) return null;
    if (
      row.outletId !== null &&
      context.outletScope.kind === "outlets" &&
      !(context.outletScope.outletIds as readonly string[]).includes(
        row.outletId,
      )
    )
      return null;
    return {
      integration: toIntegration(row),
      credentials: openCredentials(row),
    };
  });
}
