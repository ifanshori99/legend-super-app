// Shared plumbing for the AP/AR, fixed-asset and budget services (bead
// legend-hpgo; PRD v1.7 §3.19). Wire shapes come from
// `@starter/shared/accounting`; nothing here redefines a contract type.
//
// - Idempotency: every command key is bound to a sha256 fingerprint of its
//   canonical request (operation + payload). The same key with the same
//   payload replays the stored response; with another payload it fails
//   IDEMPOTENCY_KEY_REUSED (409). A per-key advisory lock serializes two
//   concurrent deliveries of one key, so the second waits and replays.
// - Outlet reach (TEN-03): entity-level rows (outlet null) need tenant scope;
//   an outlet row needs that outlet in scope. RLS only enforces tenant on these
//   tables (outlet_id is nullable), so the service is the outlet layer.
// - Audit: default-deny field list; no names, no free text in masked changes.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  accountMapFor,
  accountMappingSchema,
  type AccountId,
  type LegalEntityId,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  DEFAULT_TIME_ZONE,
  idempotencyKeySchema,
  localDateOf,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { accountMappings } from "../db/schema/accounting.ts";
import { accountingCommandIdempotency } from "../db/schema/accounting-ap-fa.ts";
import type { TenantTransaction } from "./accounting-shared.ts";
import { recordAudit } from "./core-audit.ts";

export type { TenantTransaction } from "./accounting-shared.ts";

/** Stable JSON: object keys sorted, so the fingerprint ignores key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  return value;
}

/** sha256 of the canonical request a key was first used for. */
export function commandFingerprint(
  tenantId: string,
  operation: string,
  request: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([tenantId, operation, canonical(request)]))
    .digest("hex");
}

/**
 * Runs `run` at most once per (tenant, key). A replay with the same payload
 * returns the stored response; another payload is refused. Must run inside
 * the caller's tenant transaction so the command and its key commit together.
 */
export async function idempotentCommand<T>(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: { key: string; operation: string; request: unknown },
  run: () => Promise<T>,
): Promise<T> {
  const key = idempotencyKeySchema.parse(input.key);
  const tenantId = context.tenant.tenantId;
  const fingerprint = commandFingerprint(
    tenantId,
    input.operation,
    input.request,
  );
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`acc-apfa:idem:${tenantId}:${key}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(accountingCommandIdempotency)
    .where(
      and(
        eq(accountingCommandIdempotency.tenantId, tenantId),
        eq(accountingCommandIdempotency.key, key),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== input.operation ||
      existing.fingerprint !== fingerprint
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different request.",
      );
    return existing.response as T;
  }
  const response = await run();
  await tx.insert(accountingCommandIdempotency).values({
    tenantId,
    key,
    operation: input.operation,
    fingerprint,
    response: response as object,
  });
  return response;
}

/** Transaction-scoped lock on an arbitrary name (tenant-prefixed by caller). */
export async function advisoryLock(
  tx: TenantTransaction,
  name: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${name}, 0))`,
  );
}

/**
 * TEN-03 for rows with a nullable outlet: entity-level (null) needs tenant
 * scope, an outlet row needs that outlet in scope (OUTLET_OUT_OF_SCOPE).
 */
export function assertOutletReach(
  context: ScopedTenantContext,
  outletId: string | null,
): void {
  if (outletId === null) {
    if (context.outletScope.kind !== "tenant")
      throw new CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Data tingkat badan usaha memerlukan akses seluruh tenant.",
      );
    return;
  }
  assertOutletInScope(context.outletScope, outletId);
}

/** True when the caller may see a row with this outlet (no existence leak). */
export function outletVisible(
  context: ScopedTenantContext,
  outletId: string | null,
): boolean {
  if (context.outletScope.kind === "tenant") return true;
  if (outletId === null) return false;
  return (context.outletScope.outletIds as readonly string[]).includes(
    outletId.toLowerCase(),
  );
}

/** Entity-level work (runs, budgets upsert): tenant scope only. */
export function assertTenantScope(context: ScopedTenantContext): void {
  if (context.outletScope.kind !== "tenant")
    throw new CoreError(
      "OUTLET_OUT_OF_SCOPE",
      "Tindakan ini memerlukan akses seluruh tenant.",
    );
}

/** Posting-role → account map of one legal entity (fails closed later). */
export async function loadAccountMap(
  tx: TenantTransaction,
  tenantId: string,
  legalEntityId: string,
): Promise<ReadonlyMap<PostingAccountRole, AccountId>> {
  const rows = await tx
    .select()
    .from(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
      ),
    )
    .orderBy(asc(accountMappings.role));
  return accountMapFor(
    rows.map((row) =>
      accountMappingSchema.parse({
        tenantId: row.tenantId,
        legalEntityId: row.legalEntityId,
        role: row.role,
        accountId: row.accountId,
      }),
    ),
    legalEntityId as LegalEntityId,
  );
}

/**
 * "Today" for entity-level dates. Legal entities carry no time zone, so the
 * platform default (Asia/Jakarta, D-CORE-6) decides; PRD silent, documented.
 */
export function entityToday(now: Date): BusinessDate {
  return localDateOf(now, DEFAULT_TIME_ZONE);
}

/** Server-minted id for a new accounting row (UUID aggregate, D-CORE-1). */
export const newId = (): string => randomUUID();

/** Field names an AP/FA/budget audit row may keep unmasked (default-deny). */
const AUDIT_SAFE_FIELDS = [
  "status",
  "kind",
  "method",
  "period",
  "count",
  "costIdr",
  "residualValueIdr",
  "usefulLifeMonths",
  "depreciationStartPeriod",
  "accumulatedDepreciationIdr",
  "proceedsIdr",
  "resultIdr",
  "newCarryingAmountIdr",
  "amountIdr",
  "outstandingIdr",
  "disposedOn",
  "revaluedOn",
  "settledOn",
  "acquiredOn",
  "journalEntryId",
  "balanceAfterIdr",
  "journalStatus",
  "parkCode",
] as const;

/** One append-only audit row inside the caller's transaction. */
export async function auditApFa(
  tx: TenantTransaction,
  context: ScopedTenantContext,
  input: {
    actorId: UserId | null;
    action: string;
    objectType: string;
    objectId: string | null;
    outletId?: string | null;
    reason?: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId ?? null,
      actorType: input.actorId ? "user" : "system",
      actorId: input.actorId,
      deviceId: null,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      reason: input.reason ?? null,
      maskedChanges: { before: input.before, after: input.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: new Date().toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}
