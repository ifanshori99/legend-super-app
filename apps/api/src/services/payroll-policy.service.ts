// Payroll policies and THR schedules (bead legend-gfcr, PRD v1.7 §3 D.30
// "Kebijakan Payroll", §6 H `payroll_policies` / `thr_schedules`; contract
// `@starter/shared/hris/payroll` policies.ts). Routes:
// routes/payroll-policy.routes.ts.
//
// Reading needs `payroll.view`, writing `payroll.run`, both tenant-wide
// (payroll/endpoints.ts header). A policy update merges the stored row with
// the patch and parses the whole object with `payrollPolicySchema` again
// before saving (zjwa rule): a patch can never store what the contract
// refuses. Policy changes apply to runs created afterwards; a run keeps its
// snapshot. THR schedules are append-only here (the app role has no DELETE;
// paying or cancelling is the THR engine's job).
//
// Audit values are field names or enum values only: never names, dates of
// employees or free text.

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  encodeCursor,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import {
  cycleReopensPaidDays,
  findEmploymentTypeOverlap,
  payrollPolicySchema,
  thrScheduleSchema,
  type CreatePayrollPolicyInput,
  type CreateThrScheduleInput,
  type PayrollPolicy,
  type ThrSchedule,
  type UpdatePayrollPolicyInput,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  payrollPolicies,
  payrollRuns,
  thrSchedules,
} from "../db/schema/payroll.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { cursorPair, notFound, uniqueViolation } from "./hris-access.ts";
import { idempotentHrisWrite } from "./hris-employee.service.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import type { Tx } from "./permission-resolver.ts";

const READ_CODE: PermissionCode = "payroll.view";
const WRITE_CODE: PermissionCode = "payroll.run";

/** Field names and enum values only. */
const AUDIT_SAFE_FIELDS = ["changedFields", "status", "frequency"] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

export type PageQuery = { cursor?: string | undefined; limit: number };

/** PostgreSQL foreign key violation (23503), also behind a driver wrapper. */
function foreignKeyViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23503" ||
    foreignKeyViolation(candidate.cause, depth + 1)
  );
}

const unknownLegalEntity = () =>
  new HttpError(
    422,
    "VALIDATION_ERROR",
    "Badan usaha tidak ditemukan di tenant ini.",
  );

/** Cursor `[sortKey, id]` with a UUID id, or 422 (never a database error). */
function checkedCursor(cursor: string): [string, string] {
  const pair = cursorPair(cursor);
  if (!UUID_PATTERN.test(pair[1]))
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return pair;
}

const toPolicy = (row: typeof payrollPolicies.$inferSelect): PayrollPolicy =>
  // JSONB columns are parsed again through the contract: a row edited outside
  // the service fails loudly instead of silently changing a payroll cycle.
  payrollPolicySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    name: row.name,
    employeeGroup: row.employeeGroup,
    cycle: row.cycle,
    payDateAdjustment: row.payDateAdjustment,
    jkkRiskClass: row.jkkRiskClass,
    bpjsProgrammes: row.bpjsProgrammes,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/**
 * Refuses a policy whose employment types intersect another ACTIVE policy of
 * the same legal entity (bead legend-1213): a run takes every employee of its
 * policy's types, so a shared type pays that employee in two runs of one
 * period. An advisory lock per legal entity serializes two writers, so two
 * racing creates cannot both pass.
 */
async function assertNoEmploymentTypeOverlap(
  tx: Tx,
  tenantId: TenantId,
  legalEntityId: string,
  excludePolicyId: string | null,
  employeeGroup: PayrollPolicy["employeeGroup"],
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`payroll-policy-types:${tenantId}:${legalEntityId}`}, 0))`,
  );
  const rows = await tx
    .select()
    .from(payrollPolicies)
    .where(
      and(
        eq(payrollPolicies.tenantId, tenantId),
        eq(payrollPolicies.legalEntityId, legalEntityId),
        eq(payrollPolicies.isActive, true),
        // The same group code is the unique-key conflict (its own message).
        ne(payrollPolicies.employeeGroupCode, employeeGroup.code),
        ...(excludePolicyId
          ? [
              ne(
                payrollPolicies.id,
                excludePolicyId as (typeof payrollPolicies.$inferSelect)["id"],
              ),
            ]
          : []),
      ),
    );
  const overlap = findEmploymentTypeOverlap(
    employeeGroup.employmentTypes,
    rows.map(toPolicy),
  );
  if (overlap)
    throw new HttpError(
      409,
      "PAYROLL_POLICY_EMPLOYMENT_OVERLAP",
      `Jenis kerja ${overlap.types.join(", ")} sudah dicakup kebijakan aktif "${overlap.name}" di badan usaha ini. Satu jenis kerja hanya boleh ada di satu kebijakan aktif supaya karyawan tidak digaji dua kali.`,
    );
}

/**
 * Refuses a cycle whose next period would start on or before the end of the
 * latest live (not reversed) regular run of the policy: those days are already
 * paid. A change that keeps the period boundaries (e.g. only the pay day)
 * passes.
 */
async function assertCycleKeepsPaidDays(
  tx: Tx,
  tenantId: TenantId,
  policy: PayrollPolicy,
): Promise<void> {
  const [latest] = await tx
    .select({ periodEnd: payrollRuns.periodEnd })
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.tenantId, tenantId),
        eq(payrollRuns.payrollPolicyId, policy.id),
        eq(payrollRuns.runType, "regular"),
        ne(payrollRuns.status, "reversed"),
      ),
    )
    .orderBy(desc(payrollRuns.periodEnd))
    .limit(1);
  if (latest && cycleReopensPaidDays(policy.cycle, latest.periodEnd))
    throw new HttpError(
      409,
      "PAYROLL_POLICY_CYCLE_OVERLAPS_RUN",
      `Siklus baru membuka periode yang beririsan dengan payroll yang sudah ada sampai ${latest.periodEnd}. Hari itu sudah dibayar; batalkan atau selesaikan payroll tersebut dulu, atau buat kebijakan baru.`,
    );
}

const toThrSchedule = (row: typeof thrSchedules.$inferSelect): ThrSchedule =>
  thrScheduleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    name: row.name,
    holidayName: row.holidayName,
    holidayDate: row.holidayDate,
    tenureAsOfDate: row.tenureAsOfDate,
    payDate: row.payDate,
    employeeIds: row.employeeIds,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });

function auditEvent(
  context: ScopedTenantContext,
  actor: UserId,
  now: Date,
  entry: {
    action: string;
    objectType: string;
    objectId: string;
    after: Record<string, unknown>;
  },
) {
  return {
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    actorType: "user" as const,
    actorId: actor,
    deviceId: null,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    reason: null,
    maskedChanges: { before: null, after: entry.after },
    ipHash: null,
    sensitiveAccess: false,
    retentionClass: "audit_2y" as const,
    createdAt: now.toISOString(),
  };
}

// ---- Policies -------------------------------------------------------------

/** GET /api/hris/payroll/policies (name, id order). */
export async function listPayrollPolicies(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PageQuery & { legalEntityId?: string | undefined },
): Promise<Page<PayrollPolicy>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    const filters = [eq(payrollPolicies.tenantId, context.tenant.tenantId)];
    if (query.legalEntityId)
      filters.push(eq(payrollPolicies.legalEntityId, query.legalEntityId));
    if (query.cursor) {
      const [name, id] = checkedCursor(query.cursor);
      filters.push(
        sql`(${payrollPolicies.name}, ${payrollPolicies.id}) > (${name}, ${id}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(payrollPolicies)
      .where(and(...filters))
      .orderBy(asc(payrollPolicies.name), asc(payrollPolicies.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toPolicy),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

/** POST /api/hris/payroll/policies */
export async function createPayrollPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreatePayrollPolicyInput,
  now: Date = new Date(),
): Promise<PayrollPolicy> {
  const { idempotencyKey, ...body } = input;
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.policy.create",
      { actor, body },
      async () => {
        await assertNoEmploymentTypeOverlap(
          tx,
          context.tenant.tenantId,
          body.legalEntityId,
          null,
          body.employeeGroup,
        );
        let row: typeof payrollPolicies.$inferSelect | undefined;
        try {
          [row] = await tx
            .insert(payrollPolicies)
            .values({
              tenantId: context.tenant.tenantId,
              legalEntityId: body.legalEntityId,
              name: body.name,
              employeeGroupCode: body.employeeGroup.code,
              employeeGroup: body.employeeGroup,
              cycle: body.cycle,
              payDateAdjustment: body.payDateAdjustment,
              jkkRiskClass: body.jkkRiskClass,
              bpjsProgrammes: body.bpjsProgrammes,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        } catch (error) {
          if (uniqueViolation(error))
            throw new HttpError(
              409,
              "CONFLICT",
              "Badan usaha ini sudah punya kebijakan payroll untuk kelompok karyawan tersebut.",
            );
          if (foreignKeyViolation(error)) throw unknownLegalEntity();
          throw error;
        }
        if (!row) throw new Error("Payroll policy was not stored");
        const created = toPolicy(row);
        await recordAudit(
          tx,
          context,
          auditEvent(context, actor, now, {
            action: "payroll.policy.created",
            objectType: "payroll_policy",
            objectId: created.id,
            after: { frequency: created.cycle.frequency },
          }),
          AUDIT_SAFE_FIELDS,
        );
        return created;
      },
    );
  });
}

/** PATCH /api/hris/payroll/policies/:payrollPolicyId */
export async function updatePayrollPolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  payrollPolicyId: string,
  input: UpdatePayrollPolicyInput & { idempotencyKey: string },
  now: Date = new Date(),
): Promise<PayrollPolicy> {
  const { idempotencyKey, ...patch } = input;
  const changedFields = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field);
  if (changedFields.length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Tidak ada perubahan.");
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.policy.update",
      { actor, payrollPolicyId, patch },
      async () => {
        const [current] = await tx
          .select()
          .from(payrollPolicies)
          .where(
            and(
              eq(payrollPolicies.tenantId, context.tenant.tenantId),
              eq(
                payrollPolicies.id,
                payrollPolicyId as (typeof payrollPolicies.$inferSelect)["id"],
              ),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) throw notFound("Kebijakan payroll");
        // Merge, then parse the whole object: a patch cannot store a value
        // (or a combination, like a pay day before the cut-off) that the
        // contract refuses. A ZodError answers 422.
        const merged = payrollPolicySchema.parse({
          ...toPolicy(current),
          ...Object.fromEntries(
            Object.entries(patch).filter(([, value]) => value !== undefined),
          ),
          updatedAt: now.toISOString(),
        });
        // Reactivation brings the policy's types back into play (bead
        // legend-1213); a cycle change must not reopen days a live run paid.
        if (merged.isActive && !current.isActive)
          await assertNoEmploymentTypeOverlap(
            tx,
            context.tenant.tenantId,
            current.legalEntityId,
            current.id,
            merged.employeeGroup,
          );
        if (
          patch.cycle !== undefined &&
          !isDeepStrictEqual(patch.cycle, toPolicy(current).cycle)
        )
          await assertCycleKeepsPaidDays(tx, context.tenant.tenantId, merged);
        const [row] = await tx
          .update(payrollPolicies)
          .set({
            name: merged.name,
            cycle: merged.cycle,
            payDateAdjustment: merged.payDateAdjustment,
            jkkRiskClass: merged.jkkRiskClass,
            bpjsProgrammes: merged.bpjsProgrammes,
            isActive: merged.isActive,
            updatedAt: now,
          })
          .where(
            and(
              eq(payrollPolicies.tenantId, context.tenant.tenantId),
              eq(payrollPolicies.id, current.id),
            ),
          )
          .returning();
        if (!row) throw notFound("Kebijakan payroll");
        const updated = toPolicy(row);
        await recordAudit(
          tx,
          context,
          auditEvent(context, actor, now, {
            action: "payroll.policy.updated",
            objectType: "payroll_policy",
            objectId: updated.id,
            after: { changedFields },
          }),
          AUDIT_SAFE_FIELDS,
        );
        return updated;
      },
    );
  });
}

// ---- THR schedules --------------------------------------------------------

/** GET /api/hris/payroll/thr-schedules (holiday date newest first, id). */
export async function listThrSchedules(
  context: ScopedTenantContext,
  actorUserId: string,
  query: PageQuery,
): Promise<Page<ThrSchedule>> {
  return withTenant(db, context, async (tx) => {
    await assertPayrollTenantCan(tx, context, actorUserId, READ_CODE);
    const filters = [eq(thrSchedules.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const [holidayDate, id] = checkedCursor(query.cursor);
      filters.push(
        sql`(${thrSchedules.holidayDate}, ${thrSchedules.id}) < (${holidayDate}::date, ${id}::uuid)`,
      );
    }
    const rows = await tx
      .select()
      .from(thrSchedules)
      .where(and(...filters))
      .orderBy(desc(thrSchedules.holidayDate), desc(thrSchedules.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toThrSchedule),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.holidayDate, last.id])
            : null,
      },
    };
  });
}

/** POST /api/hris/payroll/thr-schedules */
export async function createThrSchedule(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateThrScheduleInput,
  now: Date = new Date(),
): Promise<ThrSchedule> {
  const { idempotencyKey, ...body } = input;
  return withTenant(db, context, async (tx) => {
    const actor = await assertPayrollTenantCan(
      tx,
      context,
      actorUserId,
      WRITE_CODE,
    );
    return idempotentHrisWrite(
      tx,
      context,
      idempotencyKey,
      "payroll.thr_schedule.create",
      { actor, body },
      async () => {
        const employeeIds =
          body.employeeIds === null ? null : [...new Set(body.employeeIds)];
        if (employeeIds !== null)
          await assertEmployeesOfTenant(tx, context, employeeIds);
        let row: typeof thrSchedules.$inferSelect | undefined;
        try {
          [row] = await tx
            .insert(thrSchedules)
            .values({
              id: randomUUID() as (typeof thrSchedules.$inferSelect)["id"],
              tenantId: context.tenant.tenantId,
              legalEntityId: body.legalEntityId,
              name: body.name,
              holidayName: body.holidayName,
              holidayDate: body.holidayDate,
              tenureAsOfDate: body.tenureAsOfDate,
              payDate: body.payDate,
              employeeIds,
              status: "scheduled",
              createdBy: actor,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        } catch (error) {
          if (foreignKeyViolation(error)) throw unknownLegalEntity();
          throw error;
        }
        if (!row) throw new Error("THR schedule was not stored");
        const created = toThrSchedule(row);
        await recordAudit(
          tx,
          context,
          auditEvent(context, actor, now, {
            action: "payroll.thr_schedule.created",
            objectType: "thr_schedule",
            objectId: created.id,
            after: { status: created.status },
          }),
          AUDIT_SAFE_FIELDS,
        );
        return created;
      },
    );
  });
}

/** Every id must be an employee of the tenant, else 422 (never a leak of which). */
async function assertEmployeesOfTenant(
  tx: Tx,
  context: ScopedTenantContext,
  employeeIds: readonly string[],
): Promise<void> {
  const found = await tx
    .select({ id: employees.id })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        inArray(employees.id, [...employeeIds]),
      ),
    );
  if (found.length !== employeeIds.length)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Ada karyawan yang tidak ditemukan di tenant ini.",
    );
}
