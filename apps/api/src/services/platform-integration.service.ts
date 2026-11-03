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
  PlatformError,
  canTransitionIntegration,
  featureFlagsSchema,
  isIntegrationProviderAvailable,
  resolveIntegration,
  tenantIntegrationSchema,
  type IntegrationProvider,
  type TenantIntegration,
  type UpsertIntegrationInput,
} from "@starter/shared/platform";
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
import { newSecretRef, openSecret, sealSecret } from "../lib/secrets.ts";
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";

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
) {
  const sealed = sealSecret(
    canonicalJson(credentials),
    credentialAad(tenantId, integrationId),
  );
  return {
    credentialsEncrypted: sealed,
    credentialsKeyVersion: sealedVersion(sealed),
    credentialFields: Object.keys(credentials).sort(),
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

/** True when `incoming` equals what is stored (idempotent PUT keeps the blob). */
function sameStoredCredentials(
  row: IntegrationRow,
  incoming: Record<string, string>,
): boolean {
  if (!row.credentialsEncrypted) return false;
  try {
    return canonicalJson(openCredentials(row)) === canonicalJson(incoming);
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
        continue;
      }
    }
    return { data };
  });
}

/**
 * PUT /api/org/integrations: idempotent upsert keyed by (tenant, outlet,
 * provider). A new row starts as `draft`. `credentials` omitted keeps the
 * stored secret; present replaces it as a whole (new secret reference). The
 * same body twice changes nothing and writes no second audit row.
 */
export async function upsertIntegration(
  context: ScopedTenantContext,
  input: UpsertIntegrationInput,
  actorUserId: string,
): Promise<TenantIntegration> {
  return withTenant(db, context, async (tx) => {
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

    const credentialColumns = (integrationId: string) =>
      input.credentials
        ? {
            ...sealCredentials(tenantId, integrationId, input.credentials),
            credentialSecretRef: newSecretRef(),
            credentialsSetAt: new Date(),
            credentialsSetBy: actorUserId,
          }
        : {};

    let current = await lockByKey(tx, tenantId, input.outletId, input.provider);
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
          ...credentialColumns(id),
        })
        .onConflictDoNothing()
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

    const [row] = await tx
      .update(tenantIntegrations)
      .set({
        ...(configChanged ? { config: input.config } : {}),
        ...(credentialsChanged ? credentialColumns(current.id) : {}),
      })
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.id, current.id),
        ),
      )
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    await audit(tx, context, {
      action: credentialsChanged
        ? "integration.credentials.replaced"
        : "integration.config.updated",
      actorUserId,
      row,
      before: current,
    });
    return toIntegration(row);
  });
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
  return withTenant(db, context, async (tx) => {
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
    if (input.status === "active")
      await assertProviderAvailable(tx, tenantId, current.provider);
    const [row] = await tx
      .update(tenantIntegrations)
      .set({ status: input.status })
      .where(
        and(
          eq(tenantIntegrations.tenantId, tenantId),
          eq(tenantIntegrations.id, integrationId),
        ),
      )
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Integration not found.");
    await audit(tx, context, {
      action: "integration.status.changed",
      actorUserId,
      row,
      before: current,
    });
    return toIntegration(row);
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
