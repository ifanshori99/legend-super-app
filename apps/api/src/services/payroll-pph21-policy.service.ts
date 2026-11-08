// Tenant PPh 21 policy versions (bead legend-y4wp, PRD v1.7 §3 D.30 "PPh 21",
// R15, R20; contract `@starter/shared/hris/payroll` pph21-policy.ts). Routes:
// routes/payroll-pph21-policy.routes.ts.
//
// A version is tenant data versioned by effective business date. Rows are
// append-only (no update or delete here, and the app role has neither
// privilege: migration 0064), so a version never changes after it is stored.
// A run that keeps the version id (`resolvePph21PolicyFor` returns it) can
// therefore reproduce its tax later; storing that id in the run snapshot is
// the payroll run's job (follow-up bead). Reading needs `payroll.view`, publishing
// needs `payroll.run` (payroll/endpoints.ts: "policies ... payroll.run
// (write), payroll.view (read)"), both tenant-wide: the policy is not outlet
// owned.
//
// Rules for a new version: the effective date may not be before the tenant's
// current business date (a past date would silently change taxes already
// withheld), and two versions cannot share a date. Both answer
// PAYROLL_PPH21_POLICY_CONFLICT (409). The version number is max + 1 inside
// the same transaction; a concurrent publisher that loses the unique index
// race gets the same conflict code.

import { asc, eq } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  businessDateSchema,
  createUlid,
  DEFAULT_BUSINESS_DAY_CLOCK,
  userIdSchema,
  type BusinessDate,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  PayrollError,
  createPph21PolicyVersionInputSchema,
  pph21PolicyParametersSchema,
  pph21PolicyVersionSchema,
  resolvePph21Policy,
  type CreatePph21PolicyVersionInput,
  type Pph21PolicyParameters,
  type Pph21PolicyVersion,
  type Pph21PolicyVersionId,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { payrollPph21Policies } from "../db/schema/payroll-pph21-policy.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { forbidden, uniqueViolation } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type Tx,
} from "./permission-resolver.ts";

const READ_CODE: PermissionCode = "payroll.view";
const WRITE_CODE: PermissionCode = "payroll.run";

/** Field names only; every value is an enum or a number, never free text. */
const AUDIT_SAFE_FIELDS = [
  "version",
  "previousVersion",
  "effectiveFrom",
  "occupationalCostCap",
  "noTaxIdSurcharge",
  "combinedSpouseStatus",
  "mixedSchemeAllocation",
  "roundingMode",
] as const;

export type Pph21PolicyInForce = {
  readonly parameters: Pph21PolicyParameters;
  /** `default` = the tenant has no version effective on the date. */
  readonly source: "default" | "version";
  readonly version: number | null;
  readonly effectiveFrom: BusinessDate | null;
  /** Row id of the version; null for the default. Pin this in a run. */
  readonly versionId: Pph21PolicyVersionId | null;
};

async function assertCan(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  code: PermissionCode,
): Promise<UserId> {
  const actor = userIdSchema.parse(actorUserId);
  const data = await loadTenantAccessInTransaction(tx, context, actor);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actor,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  // Tenant-wide configuration: a tenant-wide right and a tenant-wide context.
  if (
    context.outletScope.kind !== "tenant" ||
    !snapshot.allows(code, { type: "tenant" })
  )
    throw forbidden();
  return actor;
}

const toVersion = (
  row: typeof payrollPph21Policies.$inferSelect,
): Pph21PolicyVersion =>
  pph21PolicyVersionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    // Parsed again on read: a row edited outside the service fails loudly
    // instead of silently changing a tax.
    parameters: pph21PolicyParametersSchema.parse(row.parameters),
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });

async function loadVersions(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<Pph21PolicyVersion[]> {
  const rows = await tx
    .select()
    .from(payrollPph21Policies)
    .where(eq(payrollPph21Policies.tenantId, context.tenant.tenantId))
    .orderBy(asc(payrollPph21Policies.version));
  return rows.map(toVersion);
}

function inForce(
  versions: readonly Pph21PolicyVersion[],
  date: BusinessDate,
): Pph21PolicyInForce {
  const parameters = resolvePph21Policy(versions, date);
  // resolvePph21Policy returns the stored object itself, or the default.
  const match = versions.find(
    (candidate) => candidate.parameters === parameters,
  );
  return match
    ? {
        parameters,
        source: "version",
        version: match.version,
        effectiveFrom: match.effectiveFrom,
        versionId: match.id,
      }
    : {
        parameters,
        source: "default",
        version: null,
        effectiveFrom: null,
        versionId: null,
      };
}

/** Every version of the tenant, oldest first. */
export async function listPph21PolicyVersions(
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<Pph21PolicyVersion[]> {
  return withTenant(db, context, async (tx) => {
    await assertCan(tx, context, actorUserId, READ_CODE);
    return loadVersions(tx, context);
  });
}

/**
 * Policy for a tax month (payroll engine entry point; the default when the
 * tenant published none), with the id of the version it came from so the run
 * can keep it. No permission check: the payroll run that calls this has
 * already authorised its caller. Use `getPph21PolicyInForce` for anything
 * that reaches a client.
 */
export async function resolvePph21PolicyFor(
  context: ScopedTenantContext,
  date: BusinessDate,
): Promise<Pph21PolicyInForce> {
  const day = businessDateSchema.parse(date);
  return withTenant(db, context, async (tx) =>
    inForce(await loadVersions(tx, context), day),
  );
}

/** Same resolution with the version it came from, behind `payroll.view`. */
export async function getPph21PolicyInForce(
  context: ScopedTenantContext,
  actorUserId: string,
  date: BusinessDate,
): Promise<Pph21PolicyInForce> {
  const day = businessDateSchema.parse(date);
  return withTenant(db, context, async (tx) => {
    await assertCan(tx, context, actorUserId, READ_CODE);
    return inForce(await loadVersions(tx, context), day);
  });
}

function conflict(message: string): PayrollError {
  return new PayrollError("PAYROLL_PPH21_POLICY_CONFLICT", message);
}

export async function createPph21PolicyVersion(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePph21PolicyVersionInput,
  now: Date = new Date(),
  idempotencyKey?: string,
): Promise<Pph21PolicyVersion> {
  const body = createPph21PolicyVersionInputSchema.parse(input);
  return withTenant(db, context, async (tx) => {
    const actor = await assertCan(tx, context, actorUserId, WRITE_CODE);
    // HTTP writes carry a key: a replay of the same request returns the first
    // result, the same key with another body is IDEMPOTENCY_KEY_REUSED.
    if (idempotencyKey !== undefined)
      return idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.pph21_policy.create",
        { actor, body },
        () => insertVersion(tx, context, actor, body, now),
      );
    return insertVersion(tx, context, actor, body, now);
  });
}

async function insertVersion(
  tx: Tx,
  context: ScopedTenantContext,
  actor: UserId,
  body: CreatePph21PolicyVersionInput,
  now: Date,
): Promise<Pph21PolicyVersion> {
  const today = businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK);
  if (body.effectiveFrom < today)
    throw conflict(
      "Tanggal berlaku kebijakan PPh 21 tidak boleh sebelum hari ini.",
    );
  const existing = await loadVersions(tx, context);
  if (existing.some((row) => row.effectiveFrom === body.effectiveFrom))
    throw conflict(
      "Sudah ada versi kebijakan PPh 21 dengan tanggal berlaku yang sama.",
    );
  const previous = inForce(existing, body.effectiveFrom);
  const version =
    existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

  let row: typeof payrollPph21Policies.$inferSelect | undefined;
  try {
    [row] = await tx
      .insert(payrollPph21Policies)
      .values({
        tenantId: context.tenant.tenantId,
        version,
        effectiveFrom: body.effectiveFrom,
        parameters: body.parameters,
        reason: body.reason,
        createdBy: actor,
        createdAt: now,
      })
      .returning();
  } catch (error) {
    // Lost a race with another publisher for the same version or date.
    if (uniqueViolation(error))
      throw conflict(
        "Versi kebijakan PPh 21 baru saja dibuat. Muat ulang lalu coba lagi.",
      );
    throw error;
  }
  if (!row) throw new Error("PPh 21 policy version was not stored");
  const created = toVersion(row);

  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "payroll.pph21_policy.created",
      objectType: "payroll_pph21_policy",
      objectId: created.id,
      reason: created.reason,
      maskedChanges: {
        before: {
          previousVersion: previous.version,
          parameters: previous.parameters,
        },
        after: {
          version: created.version,
          effectiveFrom: created.effectiveFrom,
          parameters: created.parameters,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
  return created;
}
