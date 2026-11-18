// Overtime ("lembur"): versioned formulas, requests through the approval
// matrix, and the payroll feed (PRD v1.7 §3 Kelompok D 29 "Cuti, Izin &
// Lembur", PAYR-02 "rumus lembur" versioned; §6 H `overtime_requests`; bead
// legend-hggk). Routes: routes/hris-leave.routes.ts.
//
// - A formula is a draft until published; a published row never changes. The
//   formula in force for a date is the latest published version whose
//   `effective_from` is on or before it (`resolveOvertimeFormula`).
// - A request pins the formula it was filed under (`formula_id`), so a newer
//   formula never changes old overtime (`computeApprovedOvertimePay` reads the
//   pinned parameters). A holiday on the date (tenant-wide or that outlet)
//   forces the formula's rest-day type; otherwise the client's day type, else
//   `workday`.
// - Requests are filed by the employee for their own record (the contract has
//   no employeeId). The approval matrix decides (sourceModule `hris_overtime`);
//   `approval.resolved` and the decide endpoint both end in
//   `settleOvertimeRequest`, which is idempotent under the row lock.
// - No published formula for the date → 409 OVERTIME_FORMULA_MISSING.
// - Tiers are per day: several approved requests on one date are priced as one
//   day's cumulative hours and each request gets its share of that total.

import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  assertOutletInScope,
  encodeCursor,
  idr,
  isOutletInScope,
  outletIdSchema,
  type Decimal4,
  type Idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { TenantId, z } from "@starter/shared/core";
import {
  overtimeFormulaSchema,
  overtimeHours,
  addBusinessDays,
  overtimeRequestSchema,
  transitionOvertimeRequest,
  weekStartOf,
  createOvertimeFormula as createOvertimeFormulaEndpoint,
  createOvertimeRequest as createOvertimeRequestEndpoint,
  decideOvertimeRequest as decideOvertimeRequestEndpoint,
  listOvertimeFormulas as listOvertimeFormulasEndpoint,
  listOvertimeRequests as listOvertimeRequestsEndpoint,
  publishOvertimeFormula as publishOvertimeFormulaEndpoint,
  type OvertimeFormula,
  type OvertimeRequest,
} from "@starter/shared/hris";
import {
  computeOvertimePay,
  overtimeParametersSchema,
  type OvertimeDayType,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  holidays,
  overtimeFormulas,
  overtimeRequests,
} from "../db/schema/hris-leave.ts";
import { shiftAssignments } from "../db/schema/hris-scheduling.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_MANAGE_CODE,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import {
  HRIS_LEAVE_AUDIT_SAFE_FIELDS,
  cursorDateId,
  cursorVersionId,
  idempotentHrisWrite,
  tenantOrOutletAudit,
} from "./hris-holiday.service.ts";
import {
  cancelApprovalRequest,
  decideApprovalRequest,
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";

export const HRIS_OVERTIME_SOURCE_MODULE = "hris_overtime";
export const HRIS_OVERTIME_OBJECT_TYPE = "overtime_request";

const OVERTIME_APPROVE_CODE = "hr.overtime.approve";

type FormulaRow = typeof overtimeFormulas.$inferSelect;
type RequestRow = typeof overtimeRequests.$inferSelect;
type CreateRequestBody = z.output<typeof createOvertimeRequestEndpoint.body>;
type ListRequestsQuery = z.output<typeof listOvertimeRequestsEndpoint.query>;
type DecideBody = z.output<typeof decideOvertimeRequestEndpoint.body>;
type ListFormulasQuery = z.output<typeof listOvertimeFormulasEndpoint.query>;
type CreateFormulaBody = z.output<typeof createOvertimeFormulaEndpoint.body>;
type PublishFormulaBody = z.output<typeof publishOvertimeFormulaEndpoint.body>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const lower = (value: string) => value.toLowerCase();

export function toOvertimeFormula(row: FormulaRow): OvertimeFormula {
  return overtimeFormulaSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    status: row.status,
    parameters: row.parameters,
    restDayType: row.restDayType,
    legalBasis: row.legalBasis,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedBy: row.publishedBy,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * A request ended by the matrix (expired, cancelled from the inbox) has a
 * decision time but no deciding user, which the contract allows.
 */
export function toOvertimeRequest(row: RequestRow): OvertimeRequest {
  return overtimeRequestSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    outletId: row.outletId,
    date: row.date,
    minutes: row.minutes,
    reason: row.reason,
    rejectionReason: row.rejectionReason,
    dayType: row.dayType,
    formulaId: row.formulaId,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  });
}

function overtimeAudit(
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: RequestRow,
  action: string,
  after: Record<string, unknown>,
) {
  return hrisAuditEntry(context, actor, now, {
    outletId: row.outletId,
    action,
    objectType: HRIS_OVERTIME_OBJECT_TYPE,
    objectId: row.id,
    after,
  });
}

// ----------------------------------------------------------------- formulas

/** Latest published formula effective on `date`, or null. */
export async function resolveOvertimeFormula(
  tx: Tx,
  tenantId: TenantId,
  date: string,
): Promise<FormulaRow | null> {
  const [row] = await tx
    .select()
    .from(overtimeFormulas)
    .where(
      and(
        eq(overtimeFormulas.tenantId, tenantId),
        eq(overtimeFormulas.status, "published"),
        lte(overtimeFormulas.effectiveFrom, date),
      ),
    )
    .orderBy(
      desc(overtimeFormulas.effectiveFrom),
      desc(overtimeFormulas.version),
    )
    .limit(1);
  return row ?? null;
}

/** Formulas are tenant-wide configuration: writes need tenant-wide HR manage. */
function canWriteFormula(access: HrisAccess): boolean {
  return access.reach([HRIS_MANAGE_CODE])?.kind === "tenant";
}

/** GET /api/hris/overtime-formulas — newest version first. */
export async function listOvertimeFormulas(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListFormulasQuery,
  now: Date = new Date(),
): Promise<Page<OvertimeFormula>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (
      access.reach([
        HRIS_MANAGE_CODE,
        "payroll.view",
        OVERTIME_APPROVE_CODE,
      ]) === null
    )
      throw forbidden();
    const filters: SQL[] = [
      eq(overtimeFormulas.tenantId, context.tenant.tenantId),
    ];
    if (query.cursor) {
      const [version, id] = cursorVersionId(query.cursor);
      filters.push(
        or(
          lt(overtimeFormulas.version, version),
          and(
            eq(overtimeFormulas.version, version),
            lt(overtimeFormulas.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(overtimeFormulas)
      .where(and(...filters))
      .orderBy(desc(overtimeFormulas.version), desc(overtimeFormulas.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toOvertimeFormula),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([String(last.version), last.id])
            : null,
      },
    };
  });
}

/** POST /api/hris/overtime-formulas — a draft with version = max + 1. */
export async function createOvertimeFormula(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateFormulaBody,
  now: Date = new Date(),
): Promise<OvertimeFormula> {
  const parameters = overtimeParametersSchema.parse(input.parameters);
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (!canWriteFormula(access)) throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "overtime-formula.create",
      {
        actor: access.actorUserId,
        effectiveFrom: input.effectiveFrom,
        parameters,
        restDayType: input.restDayType,
        legalBasis: input.legalBasis,
      },
      async () => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:overtime-formula:${context.tenant.tenantId}`}, 0))`,
        );
        const [max] = await tx
          .select({ value: sql<number>`coalesce(max(version), 0)::int` })
          .from(overtimeFormulas)
          .where(eq(overtimeFormulas.tenantId, context.tenant.tenantId));
        const [row] = await tx
          .insert(overtimeFormulas)
          .values({
            tenantId: context.tenant.tenantId,
            version: (max?.value ?? 0) + 1,
            effectiveFrom: input.effectiveFrom,
            status: "draft",
            parameters,
            restDayType: input.restDayType,
            legalBasis: input.legalBasis,
            createdAt: now,
            createdBy: access.actorUserId,
          })
          .returning();
        if (!row) throw new Error("Overtime formula insert returned no row");
        await recordAudit(
          tx,
          context,
          tenantOrOutletAudit(context, access.actorUserId, now, {
            outletId: null,
            action: "hris.overtime_formula.created",
            objectType: "overtime_formula",
            objectId: row.id,
            after: { version: row.version, status: row.status },
          }),
          HRIS_LEAVE_AUDIT_SAFE_FIELDS,
        );
        return toOvertimeFormula(row);
      },
    );
  });
}

/** POST /api/hris/overtime-formulas/:id/publish — draft → published, once. */
export async function publishOvertimeFormula(
  context: ScopedTenantContext,
  actorUserId: string,
  formulaId: string,
  input: PublishFormulaBody,
  now: Date = new Date(),
): Promise<OvertimeFormula> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (!canWriteFormula(access)) throw forbidden();
    return idempotentHrisWrite(
      tx,
      context,
      input.idempotencyKey,
      "overtime-formula.publish",
      { actor: access.actorUserId, formulaId: lower(formulaId) },
      async () => {
        const [current] = await tx
          .select()
          .from(overtimeFormulas)
          .where(
            and(
              eq(overtimeFormulas.tenantId, context.tenant.tenantId),
              eq(overtimeFormulas.id, formulaId),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) throw notFound("Rumus lembur");
        // Published rows never change: a retry replays through the
        // idempotency key, a new key on a published version is a conflict.
        if (current.status !== "draft")
          throw new HttpError(
            409,
            "CONFLICT",
            "Hanya rumus lembur berstatus draft yang bisa dipublikasikan.",
          );
        const [row] = await tx
          .update(overtimeFormulas)
          .set({
            status: "published",
            publishedAt: now,
            publishedBy: access.actorUserId,
          })
          .where(
            and(
              eq(overtimeFormulas.id, current.id),
              eq(overtimeFormulas.status, "draft"),
            ),
          )
          .returning();
        if (!row) throw new Error("Overtime formula publish returned no row");
        await recordAudit(
          tx,
          context,
          tenantOrOutletAudit(context, access.actorUserId, now, {
            outletId: null,
            action: "hris.overtime_formula.published",
            objectType: "overtime_formula",
            objectId: row.id,
            after: { version: row.version, status: row.status },
          }),
          HRIS_LEAVE_AUDIT_SAFE_FIELDS,
        );
        return toOvertimeFormula(row);
      },
    );
  });
}

// ----------------------------------------------------------------- requests

/** Short text the approver sees in the inbox (3 to 500 characters). */
function requestReasonFor(
  minutes: number,
  dayType: OvertimeDayType,
  date: string,
  reason: string,
): string {
  // The approver sees the tier (day type) and the hours the pay is based on.
  return `Lembur ${overtimeHours(minutes)} jam (${minutes} menit), hari ${dayType}, pada ${date}: ${reason.trim()}`.slice(
    0,
    500,
  );
}

/**
 * National or company holiday on `date` for the tenant or that outlet (forces
 * the rest-day type). Collective leave ("cuti bersama", founder decision Q7) is
 * not one: working that day is paid at the normal workday tiers. When a
 * national/company holiday falls on the same date, the rest-day type wins.
 */
async function holidayOn(
  tx: Tx,
  tenantId: TenantId,
  date: string,
  outletId: string,
): Promise<boolean> {
  const [holiday] = await tx
    .select({ id: holidays.id })
    .from(holidays)
    .where(
      and(
        eq(holidays.tenantId, tenantId),
        eq(holidays.date, date),
        ne(holidays.type, "collective"),
        or(isNull(holidays.outletId), eq(holidays.outletId, outletId)),
      ),
    )
    .limit(1);
  return holiday !== undefined;
}

/**
 * Whether `date` is the employee's rest day. A national/company holiday is.
 * Otherwise only a published roster can prove it: the employee must have at
 * least one published or swapped shift in that Monday-Sunday week and none on
 * `date` itself. Anyone else (never rostered that week, office staff, managers,
 * an unpublished roster) is a workday, the lowest tier, so nobody is paid a
 * rest-day rate the roster does not support.
 */
async function isRestDayFor(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  outletId: string,
  date: string,
): Promise<boolean> {
  if (await holidayOn(tx, tenantId, date, outletId)) return true;
  const weekStart = weekStartOf(date);
  const rows = await tx
    .select({ businessDate: shiftAssignments.businessDate })
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        eq(shiftAssignments.employeeId, employeeId),
        gte(shiftAssignments.businessDate, weekStart),
        lte(shiftAssignments.businessDate, addBusinessDays(weekStart, 6)),
        inArray(shiftAssignments.status, ["published", "swapped"]),
      ),
    );
  return rows.length > 0 && !rows.some((row) => row.businessDate === date);
}

const OVERTIME_DAILY_LIMIT_MINUTES = 720;

/**
 * POST /api/hris/overtime-requests — the caller files overtime for their own
 * employee record. Idempotent on `idempotencyKey` (same body replays the row).
 */
export async function createOvertimeRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateRequestBody,
  now: Date = new Date(),
): Promise<OvertimeRequest> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const own = access.own;
    const mayFile =
      access.snapshot.permissions.includes("self.profile.view") ||
      access.snapshot.permissions.includes("self.attendance.clock");
    if (own === null || !mayFile) throw forbidden();
    assertOutletInScope(context.outletScope, input.outletId);

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:overtime-create:${context.tenant.tenantId}:${input.idempotencyKey}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(overtimeRequests)
      .where(
        and(
          eq(overtimeRequests.tenantId, context.tenant.tenantId),
          eq(overtimeRequests.createIdempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (
        lower(existing.requestedBy) !== lower(access.actorUserId) ||
        lower(existing.outletId) !== lower(input.outletId) ||
        existing.date !== input.date ||
        existing.minutes !== input.minutes ||
        existing.reason !== input.reason
      )
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return toOvertimeRequest(existing);
    }

    const [employee] = await tx
      .select({ status: employees.status })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.id, own.id),
        ),
      )
      .limit(1);
    if (
      !employee ||
      employee.status === "resigned" ||
      employee.status === "terminated"
    )
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Karyawan tidak aktif, lembur tidak bisa diajukan.",
      );

    const formula = await resolveOvertimeFormula(
      tx,
      context.tenant.tenantId,
      input.date,
    );
    if (!formula)
      throw new HttpError(
        409,
        "OVERTIME_FORMULA_MISSING",
        "Belum ada rumus lembur yang berlaku pada tanggal ini.",
      );
    // The tier is derived on the server, never taken from the employee: a
    // holiday, or a day off inside a week they are rostered for, is a rest day;
    // everything else is a workday.
    const dayType: OvertimeDayType = (await isRestDayFor(
      tx,
      context.tenant.tenantId,
      own.id,
      input.outletId,
      input.date,
    ))
      ? formula.restDayType
      : "workday";

    // One employee's daily total (pending + approved) is capped; the lock
    // serialises concurrent filings (different idempotency keys) for them.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:overtime-daily:${context.tenant.tenantId}:${own.id}`}, 0))`,
    );
    const [booked] = await tx
      .select({
        minutes: sql<number>`coalesce(sum(${overtimeRequests.minutes}), 0)::int`,
      })
      .from(overtimeRequests)
      .where(
        and(
          eq(overtimeRequests.tenantId, context.tenant.tenantId),
          eq(overtimeRequests.employeeId, own.id),
          eq(overtimeRequests.date, input.date),
          inArray(overtimeRequests.status, ["pending", "approved"]),
        ),
      );
    if ((booked?.minutes ?? 0) + input.minutes > OVERTIME_DAILY_LIMIT_MINUTES)
      throw new HttpError(
        409,
        "OVERTIME_DAILY_LIMIT",
        "Total lembur pada tanggal ini melebihi 12 jam (720 menit).",
      );

    const id = randomUUID();
    const [inserted] = await tx
      .insert(overtimeRequests)
      .values({
        id,
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        employeeId: own.id,
        date: input.date,
        minutes: input.minutes,
        dayType,
        reason: input.reason,
        status: "pending",
        formulaId: formula.id,
        requestedBy: access.actorUserId,
        requestedAt: now,
        createIdempotencyKey: input.idempotencyKey,
        updatedAt: now,
      })
      .returning();
    if (!inserted) throw new Error("Overtime request insert returned no row");

    const opened = await openApprovalRequest(tx, context, {
      sourceModule: HRIS_OVERTIME_SOURCE_MODULE,
      actionType: "overtime",
      objectType: HRIS_OVERTIME_OBJECT_TYPE,
      objectId: id,
      amountIdr: null,
      outletId: input.outletId,
      requestedBy: access.actorUserId,
      source: "user",
      requestReason: requestReasonFor(
        input.minutes,
        dayType,
        input.date,
        input.reason,
      ),
      idempotencyKey: input.idempotencyKey,
      now,
    });
    const [row] = await tx
      .update(overtimeRequests)
      .set(
        opened.required
          ? { approvalChainId: opened.chainId, updatedAt: now }
          : {
              // Below every tier of the matrix: approved on filing.
              status: "approved",
              decidedBy: access.actorUserId,
              decidedAt: now,
              updatedAt: now,
            },
      )
      .where(eq(overtimeRequests.id, id))
      .returning();
    if (!row) throw new Error("Overtime request update returned no row");
    await recordAudit(
      tx,
      context,
      overtimeAudit(
        context,
        access.actorUserId,
        now,
        row,
        opened.required
          ? "hris.overtime_request.created"
          : "hris.overtime_request.auto_approved",
        {
          status: row.status,
          date: row.date,
          minutes: row.minutes,
          dayType: row.dayType,
          formulaId: row.formulaId,
        },
      ),
      HRIS_LEAVE_AUDIT_SAFE_FIELDS,
    );
    return toOvertimeRequest(row);
  });
}

/** GET /api/hris/overtime-requests — own rows plus the outlets HR / approvers reach. */
export async function listOvertimeRequests(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListRequestsQuery,
  now: Date = new Date(),
): Promise<Page<OvertimeRequest>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach([HRIS_MANAGE_CODE, OVERTIME_APPROVE_CODE]);
    if (reach === null && access.own === null) throw forbidden();
    const visible: SQL[] = [];
    if (reach?.kind === "tenant") visible.push(sql`true`);
    else if (reach?.kind === "outlets")
      visible.push(inArray(overtimeRequests.outletId, [...reach.outletIds]));
    if (access.own)
      visible.push(eq(overtimeRequests.employeeId, access.own.id));
    const filters: SQL[] = [
      eq(overtimeRequests.tenantId, context.tenant.tenantId),
      or(...visible)!,
    ];
    if (query.employeeId)
      filters.push(eq(overtimeRequests.employeeId, query.employeeId));
    if (query.status) filters.push(eq(overtimeRequests.status, query.status));
    if (query.from) filters.push(gte(overtimeRequests.date, query.from));
    if (query.to) filters.push(lte(overtimeRequests.date, query.to));
    if (query.cursor) {
      const [date, id] = cursorDateId(query.cursor);
      filters.push(
        or(
          lt(overtimeRequests.date, date),
          and(eq(overtimeRequests.date, date), lt(overtimeRequests.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(overtimeRequests)
      .where(and(...filters))
      .orderBy(desc(overtimeRequests.date), desc(overtimeRequests.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const names =
      page.length === 0
        ? []
        : await tx
            .select({
              id: employees.id,
              outletId: employees.homeOutletId,
              name: employees.fullName,
            })
            .from(employees)
            .where(
              and(
                eq(employees.tenantId, context.tenant.tenantId),
                inArray(employees.id, [
                  ...new Set(page.map((row) => row.employeeId)),
                ]),
                inArray(employees.homeOutletId, [
                  ...new Set(page.map((row) => row.outletId)),
                ]),
              ),
            );
    return {
      data: page.map((row) => ({
        ...toOvertimeRequest(row),
        employeeName:
          names.find(
            (item) =>
              lower(item.id) === lower(row.employeeId) &&
              lower(item.outletId) === lower(row.outletId),
          )?.name ?? null,
      })),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.date, last.id])
            : null,
      },
    };
  });
}

// ------------------------------------------------------------------ decide

const TARGET_STATUS = {
  approve: "approved",
  reject: "rejected",
  cancel: "cancelled",
} as const;

/** Context that covers exactly one outlet (settling after an authorised decision). */
function outletContextOf(
  context: ScopedTenantContext,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
}

/**
 * POST /api/hris/overtime-requests/:id/decision. approve / reject go through
 * the approval matrix exactly like `/api/approvals/:id/decisions` (role, scope,
 * MFA, requester != approver, levels in order); the request settles from the
 * chain outcome. cancel: the requester (while pending) or HR manage (also an
 * approved request). A repeated decision returns the row unchanged.
 */
export async function decideOvertimeRequest(
  context: ScopedTenantContext,
  actorUserId: string,
  overtimeRequestId: string,
  input: DecideBody,
  options: { readonly mfaVerified: boolean },
  now: Date = new Date(),
): Promise<OvertimeRequest> {
  const target = TARGET_STATUS[input.action];
  const prepared = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const [row] = await tx
      .select()
      .from(overtimeRequests)
      .where(
        and(
          eq(overtimeRequests.tenantId, context.tenant.tenantId),
          eq(overtimeRequests.id, overtimeRequestId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row || !isOutletInScope(context.outletScope, row.outletId))
      throw notFound("Lembur");
    const isOwn =
      access.own !== null && lower(access.own.id) === lower(row.employeeId);
    const outletTarget = { type: "outlet", id: row.outletId } as const;
    const canManage = access
      .permissionsAt(row.outletId)
      .includes(HRIS_MANAGE_CODE);
    const canApprove = access.snapshot.allows(
      OVERTIME_APPROVE_CODE,
      outletTarget,
    );
    if (!isOwn && !canManage && !canApprove) throw notFound("Lembur");
    if (row.status === target) return { done: toOvertimeRequest(row) };

    if (input.action === "cancel") {
      const requester = lower(row.requestedBy) === lower(access.actorUserId);
      if (!canManage && !(requester && row.status === "pending"))
        throw forbidden();
      transitionOvertimeRequest(row.status, "cancel");
      if (row.status === "pending" && row.approvalChainId !== null)
        await cancelApprovalRequest(tx, context, {
          chainId: row.approvalChainId,
          sourceModule: HRIS_OVERTIME_SOURCE_MODULE,
          actorUserId: access.actorUserId,
          now,
        });
      const [cancelled] = await tx
        .update(overtimeRequests)
        .set({
          status: "cancelled",
          decidedBy: access.actorUserId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(overtimeRequests.id, row.id))
        .returning();
      if (!cancelled) throw new Error("Overtime cancel returned no row");
      await recordAudit(
        tx,
        context,
        overtimeAudit(
          context,
          access.actorUserId,
          now,
          cancelled,
          "hris.overtime_request.cancelled",
          { status: "cancelled", action: "cancel" },
        ),
        HRIS_LEAVE_AUDIT_SAFE_FIELDS,
      );
      return { done: toOvertimeRequest(cancelled) };
    }

    transitionOvertimeRequest(row.status, input.action);
    if (!canApprove) throw forbidden();
    if (row.approvalChainId === null)
      throw new HttpError(
        409,
        "CONFLICT",
        "Lembur tidak punya rantai approval.",
      );
    const [open] = await tx
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.chainId, row.approvalChainId),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .orderBy(asc(approvalRequests.level))
      .limit(1);
    return { done: null, openId: open?.id ?? null, outletId: row.outletId };
  });
  if (prepared.done) return prepared.done;

  // The matrix opens its own transaction (its reach rules, MFA, levels).
  if (prepared.openId !== null)
    await decideApprovalRequest(
      context.tenant,
      actorUserId,
      prepared.openId,
      {
        decision: input.action === "approve" ? "approved" : "rejected",
        reason:
          input.action === "approve"
            ? "Lembur disetujui melalui HRIS"
            : input.rejectionReason!,
      },
      {
        mfaVerified: options.mfaVerified,
        idempotencyKey: input.idempotencyKey,
      },
    );
  const settled = await settleOvertimeRequest(
    outletContextOf(context, prepared.outletId),
    overtimeRequestId,
    now,
  );
  if (!settled) throw notFound("Lembur");
  return settled;
}

/**
 * Applies the approval chain's outcome to the request (consumer of
 * `approval.resolved` and the decide endpoint). Row locked FOR UPDATE and the
 * outcome re-read from the database, so the event is only a trigger. Idempotent:
 * a settled request is returned unchanged. Null when the row is not visible
 * (other tenant, outlet outside the context).
 */
export async function settleOvertimeRequest(
  context: ScopedTenantContext,
  overtimeRequestId: string,
  now: Date = new Date(),
): Promise<OvertimeRequest | null> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(overtimeRequests)
      .where(
        and(
          eq(overtimeRequests.tenantId, context.tenant.tenantId),
          eq(overtimeRequests.id, overtimeRequestId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row || !isOutletInScope(context.outletScope, row.outletId))
      return null;
    if (row.status !== "pending" || row.approvalChainId === null)
      return toOvertimeRequest(row);
    const outcome = await getApprovalChainOutcome(tx, {
      chainId: row.approvalChainId,
      sourceModule: HRIS_OVERTIME_SOURCE_MODULE,
    });
    if (outcome === "pending") return toOvertimeRequest(row);
    const levels = await tx
      .select({
        decidedBy: approvalRequests.decidedBy,
        decidedAt: approvalRequests.decidedAt,
        reason: approvalRequests.reason,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenant.tenantId),
          eq(approvalRequests.chainId, row.approvalChainId),
        ),
      )
      .orderBy(desc(approvalRequests.level));
    // A human rejection keeps the chain's decider. A matrix expiry or a system
    // cancel has no human decider: decidedBy stays null (never the requester)
    // and decidedAt is the settle time.
    const systemEnded = outcome === "expired" || outcome === "cancelled";
    const decider = systemEnded
      ? undefined
      : levels.find((level) => level.decidedBy !== null);
    const status =
      outcome === "approved"
        ? "approved"
        : outcome === "cancelled"
          ? "cancelled"
          : "rejected";
    // A holiday added after filing is honoured at approval: it forces the
    // pinned formula's rest-day type, like it does on filing.
    let dayType = row.dayType;
    if (
      status === "approved" &&
      row.formulaId !== null &&
      (await holidayOn(tx, context.tenant.tenantId, row.date, row.outletId))
    ) {
      const [formula] = await tx
        .select({ restDayType: overtimeFormulas.restDayType })
        .from(overtimeFormulas)
        .where(
          and(
            eq(overtimeFormulas.tenantId, context.tenant.tenantId),
            eq(overtimeFormulas.id, row.formulaId),
          ),
        )
        .limit(1);
      if (formula) dayType = formula.restDayType;
    }
    const [updated] = await tx
      .update(overtimeRequests)
      .set({
        status,
        rejectionReason:
          status === "rejected" && !systemEnded
            ? (decider?.reason ?? null)
            : null,
        dayType,
        decidedBy: (decider?.decidedBy ?? null) as RequestRow["decidedBy"],
        decidedAt: systemEnded ? now : (decider?.decidedAt ?? now),
        updatedAt: now,
      })
      .where(
        and(
          eq(overtimeRequests.id, row.id),
          eq(overtimeRequests.status, "pending"),
        ),
      )
      .returning();
    if (!updated) throw new Error("Overtime request changed under its lock");
    await recordAudit(
      tx,
      context,
      {
        ...hrisAuditEntry(context, decider?.decidedBy ?? row.requestedBy, now, {
          outletId: updated.outletId,
          action: `hris.overtime_request.${status}`,
          objectType: HRIS_OVERTIME_OBJECT_TYPE,
          objectId: updated.id,
          after: { status, approvalOutcome: outcome, dayType },
        }),
        actorType: decider ? ("user" as const) : ("system" as const),
        actorId: decider?.decidedBy ?? null,
      },
      HRIS_LEAVE_AUDIT_SAFE_FIELDS,
    );
    return toOvertimeRequest(updated);
  });
}

// ------------------------------------------------------------ payroll feed

export type ApprovedOvertimeItem = {
  readonly overtimeRequestId: string;
  readonly date: string;
  readonly dayType: OvertimeDayType;
  readonly hours: Decimal4;
  readonly formulaId: string;
  readonly formulaVersion: number;
  readonly payIdr: Idr;
};

/** Load only the immutable formula versions pinned by approved requests. */
export async function loadPinnedOvertimeFormulas(
  tx: Tx,
  tenantId: TenantId,
  requests: readonly Pick<RequestRow, "formulaId">[],
): Promise<Map<string, FormulaRow>> {
  const formulaIds = [
    ...new Set(
      requests.map((row) => {
        if (row.formulaId === null)
          throw new HttpError(
            409,
            "OVERTIME_FORMULA_MISSING",
            "Lembur disetujui tanpa rumus yang tercatat.",
          );
        return row.formulaId;
      }),
    ),
  ];
  const formulas =
    formulaIds.length === 0
      ? []
      : await tx
          .select()
          .from(overtimeFormulas)
          .where(
            and(
              eq(overtimeFormulas.tenantId, tenantId),
              inArray(overtimeFormulas.id, formulaIds),
            ),
          );
  const byId = new Map(formulas.map((formula) => [formula.id, formula]));
  for (const formulaId of formulaIds)
    if (!byId.has(formulaId)) throw notFound("Rumus lembur");
  return byId;
}

/**
 * Overtime pay of one employee's approved requests dated [from, to], priced
 * with the formula version each request pinned (a newer formula never changes
 * old overtime). Tiers are per day: minutes of one date (same day type and
 * formula) are summed first and converted to hours once; each item is its
 * minutes' share of that day's pay and the items add up exactly to it. Integer
 * IDR only.
 */
export async function computeApprovedOvertimePay(
  context: ScopedTenantContext,
  input: {
    readonly employeeId: string;
    readonly from: string;
    readonly to: string;
    readonly monthlyBaseIdr: Idr | number;
  },
): Promise<{ items: ApprovedOvertimeItem[]; totalIdr: Idr }> {
  const base = idr(input.monthlyBaseIdr);
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [
      eq(overtimeRequests.tenantId, context.tenant.tenantId),
      eq(overtimeRequests.employeeId, input.employeeId),
      eq(overtimeRequests.status, "approved"),
      gte(overtimeRequests.date, input.from),
      lte(overtimeRequests.date, input.to),
    ];
    if (context.outletScope.kind !== "tenant")
      filters.push(
        inArray(overtimeRequests.outletId, [...context.outletScope.outletIds]),
      );
    const rows = await tx
      .select()
      .from(overtimeRequests)
      .where(and(...filters))
      .orderBy(
        asc(overtimeRequests.date),
        asc(overtimeRequests.requestedAt),
        asc(overtimeRequests.id),
      );
    const byId = await loadPinnedOvertimeFormulas(
      tx,
      context.tenant.tenantId,
      rows,
    );

    // Minutes are summed per (day, day type, formula) first and converted to
    // hours once; the group's pay is then split across its requests by minutes
    // (cumulative floor shares, so the items add up exactly to the group pay).
    const groups = new Map<
      string,
      { minutes: number; formula: FormulaRow; dayType: OvertimeDayType }
    >();
    for (const row of rows) {
      const formula = byId.get(row.formulaId as string);
      if (!formula) throw notFound("Rumus lembur");
      const key = `${row.date}|${row.dayType}|${formula.id}`;
      const group = groups.get(key) ?? {
        minutes: 0,
        formula,
        dayType: row.dayType,
      };
      group.minutes += row.minutes;
      groups.set(key, group);
    }
    const groupPay = new Map<string, bigint>();
    for (const [key, group] of groups)
      groupPay.set(
        key,
        BigInt(
          computeOvertimePay(
            group.formula.parameters,
            group.dayType,
            overtimeHours(group.minutes),
            base,
          ),
        ),
      );

    const items: ApprovedOvertimeItem[] = [];
    const running = new Map<string, { minutes: number; paid: bigint }>();
    let total = 0;
    for (const row of rows) {
      const formula = byId.get(row.formulaId as string)!;
      const key = `${row.date}|${row.dayType}|${formula.id}`;
      const group = groups.get(key)!;
      const before = running.get(key) ?? { minutes: 0, paid: 0n };
      const minutesAfter = before.minutes + row.minutes;
      const paidAfter =
        (groupPay.get(key)! * BigInt(minutesAfter)) / BigInt(group.minutes);
      const payIdr = idr(Number(paidAfter - before.paid));
      running.set(key, { minutes: minutesAfter, paid: paidAfter });
      total += payIdr;
      items.push({
        overtimeRequestId: row.id,
        date: row.date,
        dayType: row.dayType,
        hours: overtimeHours(row.minutes),
        formulaId: formula.id,
        formulaVersion: formula.version,
        payIdr,
      });
    }
    return { items, totalIdr: idr(total) };
  });
}
