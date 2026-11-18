// Leave types, balances, accrual, carry-over and its expiry (PRD v1.7 §3
// Kelompok D 29 "Cuti, Izin & Lembur", F27 "kebijakan saldo, akrual,
// carry-over"; §6 H `leave_types`, `leave_balances`; bead legend-hggk).
// Routes: routes/hris-leave.routes.ts. Requests and approval settle live in
// hris-leave-request.service.ts, which reuses `lockBalanceForUpdate` and
// `countLeaveDays` from here.
//
// - Leave types are tenant-wide master data: writing needs tenant-wide
//   `hr.employee.manage` in a tenant-wide context. Reading is open to every HR
//   reader, leave approver and employee with a self-service right.
// - Accrual, carry-over and expiry move a balance only when the matching
//   `leave_accruals` ledger row was actually inserted (unique per employee,
//   type, kind and period), so running a job twice, or two jobs at once, grants
//   once. Concurrent requests serialize on the balance row (FOR UPDATE).
// - Day counts are Decimal4 (scaled 10^4 bigint arithmetic, never floats).

import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  encodeCursor,
  formatDecimal4,
  idempotencyKeySchema,
  localDateOf,
  parseDecimal4,
  divideRounded,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  leavePolicySchema,
  leaveTypeSchema,
  listLeaveBalances as listLeaveBalancesEndpoint,
  listLeaveTypes as listLeaveTypesEndpoint,
  createLeaveType as createLeaveTypeEndpoint,
  updateLeaveType as updateLeaveTypeEndpoint,
  type LeaveAccrualRunResult,
  type LeaveBalance,
  type LeaveType,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { eqId } from "../db/branded-ids.ts";
import { db } from "../db/index.ts";
import { employees, hrisIdempotency } from "../db/schema/hris.ts";
import {
  holidays,
  leaveAccruals,
  leaveBalances,
  leaveRequests,
  leaveTypes,
} from "../db/schema/hris-leave.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  hrisFingerprintMatches,
  hrisRequestFingerprint,
} from "../lib/hris-pii.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  HRIS_READ_CODES,
  HRIS_SELF_CODE,
  cursorPair,
  forbidden,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";

type LeaveTypeRow = typeof leaveTypes.$inferSelect;
type LeaveBalanceRow = typeof leaveBalances.$inferSelect;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type ListTypesQuery = z.output<typeof listLeaveTypesEndpoint.query>;
type ListBalancesQuery = z.output<typeof listLeaveBalancesEndpoint.query>;
type CreateTypeBody = z.output<typeof createLeaveTypeEndpoint.body>;
type UpdateTypeBody = z.output<typeof updateLeaveTypeEndpoint.body>;

const SCALE = 10_000n;
const LEAVE_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "code",
  "period",
  "fromYear",
  "asOf",
  "granted",
  "skipped",
] as const;
const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- mapping

const toLeaveType = (row: LeaveTypeRow): LeaveType =>
  leaveTypeSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
    paid: row.paid,
    requiresAttachment: row.requiresAttachment,
    policy: leavePolicySchema.parse(row.policy),
    isActive: row.isActive,
  });

/**
 * Not run through `leaveBalanceSchema`: its refine rejects used + pending above
 * entitled + carried, which a type with `negativeAllowanceDays` legitimately
 * reaches.
 */
const toLeaveBalance = (row: LeaveBalanceRow): LeaveBalance => ({
  id: row.id as LeaveBalance["id"],
  tenantId: row.tenantId,
  employeeId: row.employeeId as LeaveBalance["employeeId"],
  leaveTypeId: row.leaveTypeId as LeaveBalance["leaveTypeId"],
  periodYear: row.periodYear,
  entitledDays: row.entitledDays as Decimal4,
  carriedOverDays: row.carriedOverDays as Decimal4,
  usedDays: row.usedDays as Decimal4,
  pendingDays: row.pendingDays as Decimal4,
});

function pageOf<Row, T>(
  rows: Row[],
  limit: number,
  map: (row: Row) => T,
  keys: (row: Row) => string[],
): Page<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data: data.map(map),
    meta: {
      limit,
      nextCursor: rows.length > limit && last ? encodeCursor(keys(last)) : null,
    },
  };
}

// ----------------------------------------------------------------- access

/** Who may read leave master data and balances: HR/approver reach or an own employee row. */
function leaveReadReach(access: HrisAccess) {
  return access.reach([
    ...HRIS_READ_CODES,
    "hr.leave.approve",
    "self.leave.request",
  ]);
}

function holdsSelfLeave(access: HrisAccess): boolean {
  return (
    access.own !== null &&
    (access.snapshot.permissions.includes("self.leave.request") ||
      access.snapshot.permissions.includes(HRIS_SELF_CODE))
  );
}

/** Tenant-wide master data / batch jobs: tenant-wide manage right and context. */
async function assertCanManage(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  now: Date,
): Promise<string> {
  const access = await loadHrisAccess(tx, context, actorUserId, now);
  if (
    context.outletScope.kind !== "tenant" ||
    !access.snapshot.allows(HRIS_MANAGE_CODE, { type: "tenant" })
  )
    throw forbidden();
  return access.actorUserId;
}

/**
 * Who runs a batch job: an HR user (HTTP, permission-checked) or the system
 * (scheduled worker job, hris-leave-jobs.ts; audit actorType system, no user).
 */
export type LeaveJobActor = { type: "user"; id: string } | { type: "system" };

/**
 * HTTP actors need tenant-wide manage rights; the system actor only needs a
 * tenant-wide context (the worker mints one per tenant).
 */
async function authorizeJobActor(
  tx: Tx,
  context: ScopedTenantContext,
  actor: LeaveJobActor,
  now: Date,
): Promise<LeaveJobActor> {
  if (actor.type === "system") {
    if (context.outletScope.kind !== "tenant") throw forbidden();
    return actor;
  }
  return {
    type: "user",
    id: await assertCanManage(tx, context, actor.id, now),
  };
}

async function auditTenantWide(
  tx: Tx,
  context: ScopedTenantContext,
  actor: LeaveJobActor,
  now: Date,
  entry: {
    action: string;
    objectType: string;
    objectId: string;
    after: Record<string, unknown> | null;
  },
) {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: actor.type,
      actorId: actor.type === "user" ? actor.id : null,
      deviceId: null,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      reason: null,
      maskedChanges: { before: null, after: entry.after },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    LEAVE_AUDIT_SAFE_FIELDS,
  );
}

/** Idempotent write bound to an HMAC fingerprint of the request. */
async function idempotentWrite<T>(
  tx: Tx,
  context: ScopedTenantContext,
  key: string,
  operation: string,
  request: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const parsedKey = idempotencyKeySchema.parse(key);
  const fingerprint = hrisRequestFingerprint(context.tenant.tenantId, {
    operation,
    request,
  });
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:idem:${context.tenant.tenantId}:${parsedKey}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(hrisIdempotency)
    .where(
      and(
        eq(hrisIdempotency.tenantId, context.tenant.tenantId),
        eq(hrisIdempotency.key, parsedKey),
      ),
    )
    .limit(1);
  if (existing) {
    if (
      existing.operation !== operation ||
      !hrisFingerprintMatches(
        context.tenant.tenantId,
        { operation, request },
        existing.fingerprint,
      )
    )
      throw new CoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency key already used for a different request.",
      );
    return existing.response as T;
  }
  const response = await run();
  await tx.insert(hrisIdempotency).values({
    tenantId: context.tenant.tenantId,
    key: parsedKey,
    operation,
    fingerprint,
    response: response as object,
  });
  return response;
}

// ------------------------------------------------------------ leave types

/** GET /api/hris/leave/types */
export async function listLeaveTypes(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListTypesQuery,
  now = new Date(),
): Promise<Page<LeaveType>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (leaveReadReach(access) === null && !holdsSelfLeave(access))
      throw forbidden();
    const filters: SQL[] = [eq(leaveTypes.tenantId, context.tenant.tenantId)];
    if (query.cursor) {
      const [code, id] = cursorPair(query.cursor);
      filters.push(
        or(
          gt(leaveTypes.code, code),
          and(eq(leaveTypes.code, code), gt(leaveTypes.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(leaveTypes)
      .where(and(...filters))
      .orderBy(asc(leaveTypes.code), asc(leaveTypes.id))
      .limit(query.limit + 1);
    return pageOf(rows, query.limit, toLeaveType, (row) => [row.code, row.id]);
  });
}

/** POST /api/hris/leave/types */
export async function createLeaveType(
  context: ScopedTenantContext,
  actorUserId: string,
  body: CreateTypeBody,
  now = new Date(),
): Promise<LeaveType> {
  const { idempotencyKey, ...input } = body;
  return withTenant(db, context, async (tx) => {
    const actor = await assertCanManage(tx, context, actorUserId, now);
    return idempotentWrite(
      tx,
      context,
      idempotencyKey,
      "leave_type.create",
      { actor, input },
      async () => {
        const [row] = await tx
          .insert(leaveTypes)
          .values({
            tenantId: context.tenant.tenantId,
            code: input.code,
            name: input.name,
            paid: input.paid,
            requiresAttachment: input.requiresAttachment,
            policy: leavePolicySchema.parse(input.policy),
            isActive: input.isActive ?? true,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .catch((error: unknown) => {
            if (uniqueViolation(error))
              throw new HttpError(
                409,
                "CONFLICT",
                "Kode jenis cuti sudah dipakai.",
              );
            throw error;
          });
        if (!row) throw new Error("Leave type insert returned no row");
        await auditTenantWide(tx, context, { type: "user", id: actor }, now, {
          action: "hris.leave_type.created",
          objectType: "leave_type",
          objectId: row.id,
          after: { code: row.code },
        });
        return toLeaveType(row);
      },
    );
  });
}

/** PATCH /api/hris/leave/types/:leaveTypeId — the code never changes. */
export async function updateLeaveType(
  context: ScopedTenantContext,
  actorUserId: string,
  leaveTypeId: string,
  body: UpdateTypeBody,
  now = new Date(),
): Promise<LeaveType> {
  const { idempotencyKey, ...patch } = body;
  const changed = Object.keys(patch).filter(
    (key) => patch[key as keyof typeof patch] !== undefined,
  );
  if (changed.length === 0)
    throw new HttpError(422, "VALIDATION_ERROR", "Tidak ada perubahan.");
  return withTenant(db, context, async (tx) => {
    const actor = await assertCanManage(tx, context, actorUserId, now);
    return idempotentWrite(
      tx,
      context,
      idempotencyKey,
      "leave_type.update",
      { actor, leaveTypeId, patch },
      async () => {
        const [current] = await tx
          .select({ id: leaveTypes.id, policy: leaveTypes.policy })
          .from(leaveTypes)
          .where(
            and(
              eq(leaveTypes.tenantId, context.tenant.tenantId),
              eq(leaveTypes.id, leaveTypeId),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) throw notFound("Jenis cuti");
        if (patch.policy !== undefined) {
          const next = leavePolicySchema.parse(patch.policy);
          const before = leavePolicySchema.parse(current.policy);
          if (next.tracksBalance !== before.tracksBalance) {
            // Flipping tracksBalance under a pending request would leave its
            // reservation stuck (or drive pendingDays negative at settle).
            const [pending] = await tx
              .select({ id: leaveRequests.id })
              .from(leaveRequests)
              .where(
                and(
                  eq(leaveRequests.tenantId, context.tenant.tenantId),
                  eq(leaveRequests.leaveTypeId, current.id),
                  eq(leaveRequests.status, "pending"),
                ),
              )
              .limit(1);
            if (pending)
              throw new HttpError(
                409,
                "LEAVE_TYPE_HAS_PENDING_REQUESTS",
                "Jenis cuti punya pengajuan yang masih menunggu; selesaikan dulu sebelum mengubah pelacakan saldo.",
              );
          }
        }
        const [row] = await tx
          .update(leaveTypes)
          .set({
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.paid !== undefined && { paid: patch.paid }),
            ...(patch.requiresAttachment !== undefined && {
              requiresAttachment: patch.requiresAttachment,
            }),
            ...(patch.policy !== undefined && {
              policy: leavePolicySchema.parse(patch.policy),
            }),
            ...(patch.isActive !== undefined && { isActive: patch.isActive }),
            updatedAt: now,
          })
          .where(
            and(
              eq(leaveTypes.tenantId, context.tenant.tenantId),
              eq(leaveTypes.id, current.id),
            ),
          )
          .returning();
        if (!row) throw new Error("Leave type update returned no row");
        await auditTenantWide(tx, context, { type: "user", id: actor }, now, {
          action: "hris.leave_type.updated",
          objectType: "leave_type",
          objectId: row.id,
          after: { code: row.code, changedFields: changed },
        });
        return toLeaveType(row);
      },
    );
  });
}

// --------------------------------------------------------------- balances

/**
 * GET /api/hris/leave/balances — HR or leave approvers see the balances of
 * employees whose home outlet they reach; an employee always sees their own.
 */
export async function listLeaveBalances(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListBalancesQuery,
  now = new Date(),
): Promise<Page<LeaveBalance>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach([HRIS_MANAGE_CODE, "hr.leave.approve"]);
    const own = holdsSelfLeave(access) ? access.own : null;
    if (reach === null && own === null) throw forbidden();
    const visible: SQL[] = [];
    if (reach?.kind === "tenant") visible.push(sql`true`);
    else if (reach)
      visible.push(inArray(employees.homeOutletId, [...reach.outletIds]));
    if (own) visible.push(eq(leaveBalances.employeeId, own.id));
    const filters: SQL[] = [
      eq(leaveBalances.tenantId, context.tenant.tenantId),
      or(...visible)!,
    ];
    if (query.employeeId)
      filters.push(eq(leaveBalances.employeeId, query.employeeId));
    if (query.year !== undefined)
      filters.push(eq(leaveBalances.periodYear, query.year));
    if (query.cursor) {
      const [year, id] = cursorPair(query.cursor);
      filters.push(
        or(
          lt(leaveBalances.periodYear, Number(year)),
          and(
            eq(leaveBalances.periodYear, Number(year)),
            gt(leaveBalances.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select({ balance: leaveBalances })
      .from(leaveBalances)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, leaveBalances.tenantId),
          eq(employees.id, leaveBalances.employeeId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(leaveBalances.periodYear), asc(leaveBalances.id))
      .limit(query.limit + 1);
    return pageOf(
      rows,
      query.limit,
      (row) => toLeaveBalance(row.balance),
      (row) => [String(row.balance.periodYear), row.balance.id],
    );
  });
}

// ------------------------------------------------- helpers used by requests

/** The balance row of one employee, type and year, locked until commit; null if none. */
export async function lockBalanceForUpdate(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
): Promise<LeaveBalanceRow | null> {
  const [row] = await tx
    .select()
    .from(leaveBalances)
    .where(
      and(
        eq(leaveBalances.tenantId, tenantId as LeaveBalanceRow["tenantId"]),
        eq(leaveBalances.employeeId, employeeId),
        eq(leaveBalances.leaveTypeId, leaveTypeId),
        eq(leaveBalances.periodYear, periodYear),
      ),
    )
    .for("update")
    .limit(1);
  return row ?? null;
}

/**
 * Carried-over days a balance can still count on business date `today`
 * (scaled Decimal4). From `carry_over_expires_on` on, days taken consume the
 * carried-over part first (same rule as `expireLeaveCarryOver`), so only the
 * part held by `used + pending` still counts. The rest is forfeit even before
 * the expiry job has written it off.
 */
export function usableCarriedOverDays(
  balance: Pick<
    LeaveBalanceRow,
    "carriedOverDays" | "usedDays" | "pendingDays" | "carryOverExpiresOn"
  >,
  today: string,
): bigint {
  const carried = parseDecimal4(balance.carriedOverDays);
  if (balance.carryOverExpiresOn === null || balance.carryOverExpiresOn > today)
    return carried;
  const taken =
    parseDecimal4(balance.usedDays) + parseDecimal4(balance.pendingDays);
  const held = taken > 0n ? taken : 0n;
  return carried < held ? carried : held;
}

function dayNumber(date: string): number {
  if (!BUSINESS_DATE_PATTERN.test(date))
    throw new HttpError(422, "VALIDATION_ERROR", "Tanggal tidak valid.");
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * Calendar days from `startDate` to `endDate` inclusive, minus the dates that
 * are a holiday for the outlet (tenant-wide holidays and that outlet's own).
 * A date that is both counts once. Weekends are not excluded.
 * `excludedDates` (ascending) are the holiday dates left out of `days`; the
 * request stores them so later holiday edits never change what it counted.
 */
export async function countLeaveDays(
  tx: Tx,
  input: {
    tenantId: string;
    outletId: string;
    startDate: string;
    endDate: string;
  },
): Promise<{ days: Decimal4; excludedDates: string[] }> {
  const first = dayNumber(input.startDate);
  const last = dayNumber(input.endDate);
  if (last < first)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Tanggal akhir tidak boleh sebelum tanggal mulai.",
    );
  const rows = await tx
    .selectDistinct({ date: holidays.date })
    .from(holidays)
    .where(
      and(
        eq(holidays.tenantId, input.tenantId as LeaveBalanceRow["tenantId"]),
        gte(holidays.date, input.startDate),
        lte(holidays.date, input.endDate),
        or(
          sql`${holidays.outletId} IS NULL`,
          eqId(holidays.outletId, input.outletId),
        ),
      ),
    );
  const count = BigInt(last - first + 1 - rows.length);
  return {
    days: formatDecimal4(count * SCALE),
    excludedDates: rows.map((row) => row.date).sort(),
  };
}

// ---------------------------------------------------------------- accrual

type ActiveLeaveType = {
  row: LeaveTypeRow;
  policy: ReturnType<typeof policyOf>;
};
const policyOf = (row: LeaveTypeRow) => leavePolicySchema.parse(row.policy);

async function activeTrackedTypes(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<ActiveLeaveType[]> {
  const rows = await tx
    .select()
    .from(leaveTypes)
    .where(
      and(
        eq(leaveTypes.tenantId, context.tenant.tenantId),
        eq(leaveTypes.isActive, true),
      ),
    )
    .orderBy(asc(leaveTypes.code));
  return rows
    .map((row) => ({ row, policy: policyOf(row) }))
    .filter(({ policy }) => policy.tracksBalance);
}

/**
 * Inserts the ledger row; true only when this call inserted it (and so owns
 * the matching balance movement).
 */
async function claimLedger(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date,
  row: {
    employeeId: string;
    leaveTypeId: string;
    kind: "grant" | "carry_over" | "carry_over_expiry";
    period: string;
    days: bigint;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(leaveAccruals)
    .values({
      tenantId: context.tenant.tenantId,
      employeeId: row.employeeId,
      leaveTypeId: row.leaveTypeId,
      kind: row.kind,
      period: row.period,
      days: formatDecimal4(row.days),
      createdAt: now,
      // TODO: `leave_accruals.created_by` is uuid but user ids are text; the
      // audit row records the actor until the column type is aligned.
      createdBy: null,
    })
    .onConflictDoNothing({
      target: [
        leaveAccruals.tenantId,
        leaveAccruals.employeeId,
        leaveAccruals.leaveTypeId,
        leaveAccruals.kind,
        leaveAccruals.period,
      ],
    })
    .returning({ id: leaveAccruals.id });
  return inserted.length > 0;
}

/** Adds days to `entitled_days` / `carried_over_days` of the (new or existing) balance row. */
async function addToBalance(
  tx: Tx,
  context: ScopedTenantContext,
  now: Date,
  row: {
    employeeId: string;
    leaveTypeId: string;
    periodYear: number;
    entitled?: bigint;
    carriedOver?: bigint;
    carryOverExpiresOn?: string | null;
  },
) {
  const entitled = formatDecimal4(row.entitled ?? 0n);
  const carried = formatDecimal4(row.carriedOver ?? 0n);
  await tx
    .insert(leaveBalances)
    .values({
      tenantId: context.tenant.tenantId,
      employeeId: row.employeeId,
      leaveTypeId: row.leaveTypeId,
      periodYear: row.periodYear,
      entitledDays: entitled,
      carriedOverDays: carried,
      carryOverExpiresOn: row.carryOverExpiresOn ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        leaveBalances.tenantId,
        leaveBalances.employeeId,
        leaveBalances.leaveTypeId,
        leaveBalances.periodYear,
      ],
      set: {
        entitledDays: sql`${leaveBalances.entitledDays} + ${entitled}::numeric`,
        carriedOverDays: sql`${leaveBalances.carriedOverDays} + ${carried}::numeric`,
        ...(row.carryOverExpiresOn !== undefined && {
          carryOverExpiresOn: row.carryOverExpiresOn,
        }),
        updatedAt: now,
      },
    });
}

/** round4(annual × month / 12) − round4(annual × (month − 1) / 12): 12 months sum to annual. */
function monthlyShare(annual: bigint, month: number): bigint {
  const upTo = (m: number) => divideRounded(annual * BigInt(m), 12n, "half_up");
  return upTo(month) - upTo(month - 1);
}

/**
 * POST /api/hris/leave/accruals/run — grants the leave of one month for every
 * active employee and active balance-tracking type. `upfront` types grant the
 * whole year once (ledger period `YYYY`) on the first run of the year that
 * reaches the employee; `monthly` types grant one 1/12 share per month (ledger
 * period `YYYY-MM`). Employees who join after the month, or left before it,
 * are skipped. Running twice grants once.
 */
export async function runLeaveAccrual(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { period: string },
  now = new Date(),
): Promise<LeaveAccrualRunResult> {
  return accrueLeave(context, { type: "user", id: actorUserId }, input, now);
}

/** Accrual body shared by the HTTP path and the scheduled job. */
export async function accrueLeave(
  context: ScopedTenantContext,
  jobActor: LeaveJobActor,
  input: { period: string },
  now = new Date(),
): Promise<LeaveAccrualRunResult> {
  const match = PERIOD_PATTERN.exec(input.period);
  if (!match)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Periode memakai format YYYY-MM.",
    );
  const year = Number(match[1]);
  const month = Number(match[2]);
  const monthStart = `${match[1]}-${match[2]}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0))
    .toISOString()
    .slice(0, 10);
  return withTenant(db, context, async (tx) => {
    const actor = await authorizeJobActor(tx, context, jobActor, now);
    const types = await activeTrackedTypes(tx, context);
    const staff = await tx
      .select({
        id: employees.id,
        joinDate: employees.joinDate,
        endDate: employees.endDate,
      })
      .from(employees)
      .where(
        and(
          eq(employees.tenantId, context.tenant.tenantId),
          eq(employees.status, "active"),
        ),
      )
      .orderBy(asc(employees.id));
    let granted = 0;
    let skipped = 0;
    for (const employee of staff) {
      const eligible =
        employee.joinDate <= monthEnd &&
        (employee.endDate === null || employee.endDate >= monthStart);
      for (const { row, policy } of types) {
        const annual = parseDecimal4(policy.annualDays);
        const days =
          policy.accrual === "monthly" ? monthlyShare(annual, month) : annual;
        if (!eligible || days <= 0n) {
          skipped += 1;
          continue;
        }
        const claimed = await claimLedger(tx, context, now, {
          employeeId: employee.id,
          leaveTypeId: row.id,
          kind: "grant",
          period: policy.accrual === "monthly" ? input.period : String(year),
          days,
        });
        if (!claimed) {
          skipped += 1;
          continue;
        }
        await addToBalance(tx, context, now, {
          employeeId: employee.id,
          leaveTypeId: row.id,
          periodYear: year,
          entitled: days,
        });
        granted += 1;
      }
    }
    await auditTenantWide(tx, context, actor, now, {
      action: "hris.leave_accrual.run",
      objectType: "leave_accrual",
      objectId: createUlid(now.getTime()),
      after: { period: input.period, granted, skipped },
    });
    return { granted, skipped };
  });
}

/**
 * POST /api/hris/leave/carry-over/run — moves the unused days of `fromYear`
 * into `fromYear + 1` as `carried_over_days`, capped by the type's
 * `carryOverMaxDays`. The carried days expire `carryOverExpiryMonths` months
 * into the new year (never when 0). Idempotent through the ledger.
 */
export async function runLeaveCarryOver(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { fromYear: number },
  now = new Date(),
): Promise<LeaveAccrualRunResult> {
  return carryOverLeave(context, { type: "user", id: actorUserId }, input, now);
}

/** Carry-over body shared by the HTTP path and the scheduled job. */
export async function carryOverLeave(
  context: ScopedTenantContext,
  jobActor: LeaveJobActor,
  input: { fromYear: number },
  now = new Date(),
): Promise<LeaveAccrualRunResult> {
  const { fromYear } = input;
  if (!Number.isInteger(fromYear) || fromYear < 2000 || fromYear > 2099)
    throw new HttpError(422, "VALIDATION_ERROR", "Tahun asal tidak valid.");
  if (fromYear >= Number(localDateOf(now).slice(0, 4)))
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Tahun asal harus sebelum tahun berjalan.",
    );
  const toYear = fromYear + 1;
  return withTenant(db, context, async (tx) => {
    const actor = await authorizeJobActor(tx, context, jobActor, now);
    const types = new Map(
      (await activeTrackedTypes(tx, context)).map((type) => [
        type.row.id,
        type.policy,
      ]),
    );
    const balances = await tx
      .select()
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.tenantId, context.tenant.tenantId),
          eq(leaveBalances.periodYear, fromYear),
        ),
      )
      .orderBy(asc(leaveBalances.id))
      .for("update");
    let granted = 0;
    let skipped = 0;
    for (const balance of balances) {
      const policy = types.get(balance.leaveTypeId);
      const max = policy ? parseDecimal4(policy.carryOverMaxDays) : 0n;
      // Pending days are undecided: skip without a ledger row so a later run
      // picks the balance up once the request settles.
      if (!policy || max <= 0n || parseDecimal4(balance.pendingDays) > 0n) {
        skipped += 1;
        continue;
      }
      // Carry that expired during `fromYear` and was not taken does not roll
      // over again, even when the expiry job has not written it off yet.
      const available =
        parseDecimal4(balance.entitledDays) +
        usableCarriedOverDays(balance, `${toYear}-01-01`) -
        parseDecimal4(balance.usedDays) -
        parseDecimal4(balance.pendingDays);
      const carried = available <= 0n ? 0n : available < max ? available : max;
      const claimed = await claimLedger(tx, context, now, {
        employeeId: balance.employeeId,
        leaveTypeId: balance.leaveTypeId,
        kind: "carry_over",
        period: String(toYear),
        days: carried,
      });
      if (!claimed) {
        skipped += 1;
        continue;
      }
      if (carried > 0n)
        await addToBalance(tx, context, now, {
          employeeId: balance.employeeId,
          leaveTypeId: balance.leaveTypeId,
          periodYear: toYear,
          carriedOver: carried,
          carryOverExpiresOn:
            policy.carryOverExpiryMonths > 0
              ? new Date(Date.UTC(toYear, policy.carryOverExpiryMonths, 1))
                  .toISOString()
                  .slice(0, 10)
              : null,
        });
      granted += 1;
    }
    await auditTenantWide(tx, context, actor, now, {
      action: "hris.leave_carry_over.run",
      objectType: "leave_carry_over",
      objectId: createUlid(now.getTime()),
      after: { fromYear, granted, skipped },
    });
    return { granted, skipped };
  });
}

/**
 * POST /api/hris/leave/carry-over/expire — forfeits the carried-over days of
 * every balance whose `carry_over_expires_on` is on or before `asOf`. Days
 * taken consume the carried-over part first, so only
 * `carried − (used + pending)` is forfeited, also while days are still
 * pending. Idempotent through the ledger.
 */
export async function expireLeaveCarryOver(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { asOf: string },
  now = new Date(),
): Promise<LeaveAccrualRunResult> {
  return expireCarryOverLeave(
    context,
    { type: "user", id: actorUserId },
    input,
    now,
  );
}

/**
 * Writes off the carried-over days of one balance whose
 * `carry_over_expires_on` is on or before `asOf`: claims the
 * `carry_over_expiry` ledger row (once per balance) and clamps carried to
 * what `used + pending` still holds (days taken consume the carried-over part
 * first). Pending days hold their carried part until decided; releasing them
 * later forfeits it then (`moveBalance` in hris-leave-request.service.ts).
 * The caller holds the balance row lock. Used by the expiry job and, so that
 * expired carry is never spent before the job ran, by leave filing and the
 * collective-leave deduction. `audit` runs only when days were forfeited.
 * Returns the balance as it is now; `claimed` = this call inserted the row.
 */
export async function expireBalanceCarryOver(
  tx: Tx,
  context: ScopedTenantContext,
  balance: LeaveBalanceRow,
  asOf: string,
  now: Date,
  audit?: (after: {
    periodYear: number;
    forfeitedDays: Decimal4;
    carriedOverDays: Decimal4;
  }) => Promise<void>,
): Promise<{ balance: LeaveBalanceRow; claimed: boolean }> {
  const carried = parseDecimal4(balance.carriedOverDays);
  if (
    balance.carryOverExpiresOn === null ||
    balance.carryOverExpiresOn > asOf ||
    carried <= 0n
  )
    return { balance, claimed: false };
  const forfeited = carried - usableCarriedOverDays(balance, asOf);
  const claimed = await claimLedger(tx, context, now, {
    employeeId: balance.employeeId,
    leaveTypeId: balance.leaveTypeId,
    kind: "carry_over_expiry",
    period: String(balance.periodYear),
    days: -forfeited,
  });
  if (!claimed || forfeited <= 0n) return { balance, claimed };
  const kept = formatDecimal4(carried - forfeited);
  await tx
    .update(leaveBalances)
    .set({ carriedOverDays: kept, updatedAt: now })
    .where(
      and(
        eq(leaveBalances.tenantId, context.tenant.tenantId),
        eq(leaveBalances.id, balance.id),
      ),
    );
  await audit?.({
    periodYear: balance.periodYear,
    forfeitedDays: formatDecimal4(forfeited),
    carriedOverDays: kept,
  });
  return {
    balance: { ...balance, carriedOverDays: kept, updatedAt: now },
    claimed,
  };
}

/** Expiry body shared by the HTTP path and the scheduled job. */
export async function expireCarryOverLeave(
  context: ScopedTenantContext,
  jobActor: LeaveJobActor,
  input: { asOf: string },
  now = new Date(),
): Promise<LeaveAccrualRunResult> {
  if (!BUSINESS_DATE_PATTERN.test(input.asOf))
    throw new HttpError(422, "VALIDATION_ERROR", "Tanggal tidak valid.");
  if (input.asOf > localDateOf(now))
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Tanggal tidak boleh di masa depan.",
    );
  return withTenant(db, context, async (tx) => {
    const actor = await authorizeJobActor(tx, context, jobActor, now);
    const balances = await tx
      .select()
      .from(leaveBalances)
      .where(
        and(
          eq(leaveBalances.tenantId, context.tenant.tenantId),
          lte(leaveBalances.carryOverExpiresOn, input.asOf),
          gt(leaveBalances.carriedOverDays, "0"),
        ),
      )
      .orderBy(asc(leaveBalances.id))
      .for("update");
    let granted = 0;
    let skipped = 0;
    for (const balance of balances) {
      // The run is audited once below, not per balance.
      const { claimed } = await expireBalanceCarryOver(
        tx,
        context,
        balance,
        input.asOf,
        now,
      );
      if (claimed) granted += 1;
      else skipped += 1;
    }
    await auditTenantWide(tx, context, actor, now, {
      action: "hris.leave_carry_over.expired",
      objectType: "leave_carry_over",
      objectId: createUlid(now.getTime()),
      after: { asOf: input.asOf, granted, skipped },
    });
    return { granted, skipped };
  });
}
