// Attendance corrections (PRD v1.7 §3 F25 "Koreksi Absensi", HR-02; §6 H
// `attendance_corrections`; bead legend-wh71). Routes:
// routes/hris-attendance-correction.routes.ts.
//
// - The employee files a correction for themselves (`self.attendance.clock`
//   on their own employee row) with the log to fix (or null when the log is
//   missing), the corrected type/time and a reason.
// - The approval matrix owns the decision: `openApprovalRequest` (source
//   module `hris_attendance`, action `attendance_correction`) opens the chain,
//   `decideApprovalRequest` records each level. This module never decides by
//   itself.
// - `settleAttendanceCorrection` applies the chain outcome re-read under the
//   correction row lock, so a replayed or forged `approval.resolved` event is
//   a no-op (see hris-approval-consumers.ts). It is also called inline after a
//   decision.
// - Approval creates a new `manual_correction` log (validity valid) by direct
//   insert; the original log is left untouched (attendance_logs is immutable
//   apart from its review fields).
// - A correction never lands in a payroll period that is already closed
//   (locked, paid or reversed): 409 on filing and on approval. A chain that
//   approves after the period closed in the meantime settles as rejected.
// - The reason is personal data: never in an audit field, event payload or
//   approval request reason.

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  createUlid,
  encodeCursor,
  localDateOf,
  toIsoDateTime,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  attendanceCorrectionSchema,
  decideAttendanceCorrection as decideAttendanceCorrectionEndpoint,
  listAttendanceCorrections as listAttendanceCorrectionsEndpoint,
  requestAttendanceCorrection as requestAttendanceCorrectionEndpoint,
  transitionAttendanceCorrection,
  type AttendanceCorrection,
  type AttendanceCorrectionStatus,
} from "@starter/shared/hris";
import type { z } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { employees } from "../db/schema/hris.ts";
import {
  attendanceCorrections,
  attendanceLogs,
} from "../db/schema/hris-attendance.ts";
import { shiftAssignments } from "../db/schema/hris-scheduling.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  HRIS_MANAGE_CODE,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  isReachedEmployee,
  loadHrisAccess,
  notFound,
  reachedEmployeeCondition,
  uniqueViolation,
  type HrisAccess,
  type Tx,
} from "./hris-access.ts";
import { computeWorkTiming } from "./hris-attendance-logic.ts";
import { lockEmployeeLeaveAttendance } from "./hris-leave-attendance-lock.ts";
import { findApprovedLeaveOnDate } from "./hris-leave-request.service.ts";
import { assertPayrollOpen, isPayrollClosed } from "./hris-payroll-lock.ts";
import { loadOutletTimeZone } from "./hris-scheduling-common.ts";
import {
  decideApprovalRequest,
  getApprovalChainOutcome,
  openApprovalRequest,
} from "./platform-approval.service.ts";

export const HRIS_ATTENDANCE_SOURCE_MODULE = "hris_attendance";
export const HRIS_ATTENDANCE_OBJECT_TYPE = "attendance_correction";

type CorrectionRow = typeof attendanceCorrections.$inferSelect;
type RequestBody = z.output<typeof requestAttendanceCorrectionEndpoint.body>;
type DecideBody = z.output<typeof decideAttendanceCorrectionEndpoint.body>;
type ListQuery = z.output<typeof listAttendanceCorrectionsEndpoint.query>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const APPROVE_REASON = "Koreksi absensi disetujui";
const REJECT_REASON = "Koreksi absensi ditolak";
const REQUEST_REASON = "Pengajuan koreksi absensi";

const APPROVE_CODE = "hr.attendance_correction.approve";
const SELF_CODE = "self.attendance.clock";
/** Codes whose outlet reach lets a caller see other employees' corrections. */
const MANAGE_CODES = [
  HRIS_MANAGE_CODE,
  "hr.attendance.manage",
  APPROVE_CODE,
] as const;

const ATTENDANCE_AUDIT_SAFE_FIELDS = [
  ...HRIS_AUDIT_SAFE_FIELDS,
  "status",
  "cause",
] as const;

const lower = (value: string) => value.toLowerCase();

/** RLS scope of exactly one outlet: approval rows are outlet-owned (TEN-03). */
function outletScoped(
  context: ScopedTenantContext,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [outletId],
  } as Parameters<typeof establishScopedTenantContext>[1]);
}

function toCorrection(row: CorrectionRow): AttendanceCorrection {
  return attendanceCorrectionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    employeeId: row.employeeId,
    attendanceLogId: row.attendanceLogId,
    requestedType: row.requestedType,
    requestedOccurredAt: toIsoDateTime(row.requestedOccurredAt),
    reason: row.reason,
    status: row.status,
    requestedAt: toIsoDateTime(row.requestedAt),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? toIsoDateTime(row.decidedAt) : null,
  });
}

async function auditCorrection(
  tx: Tx,
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  row: CorrectionRow,
  action: string,
  cause?: string,
) {
  await recordAudit(
    tx,
    context,
    hrisAuditEntry(context, actor, now, {
      outletId: row.outletId,
      action,
      objectType: HRIS_ATTENDANCE_OBJECT_TYPE,
      objectId: row.id,
      after: cause ? { status: row.status, cause } : { status: row.status },
    }),
    ATTENDANCE_AUDIT_SAFE_FIELDS,
  );
}

// ------------------------------------------------------------ visibility

/**
 * Corrections the caller may list/decide, plus their own rows. Tenant-wide
 * reach (HR) sees all; outlet reach (supervisor) only direct reports inside
 * those outlets (employees.manager_id).
 */
function visibleCondition(
  tx: Tx,
  tenantId: TenantId,
  access: HrisAccess,
): SQL | null {
  const conditions: SQL[] = [];
  const managed = reachedEmployeeCondition(
    tx,
    tenantId,
    access,
    MANAGE_CODES,
    attendanceCorrections.outletId,
    attendanceCorrections.employeeId,
  );
  if (managed) conditions.push(managed);
  // Reach without reports (no employee record): an empty list, not a 403.
  else if (access.reach(MANAGE_CODES) !== null) conditions.push(sql`false`);
  if (access.own)
    conditions.push(eq(attendanceCorrections.employeeId, access.own.id));
  return conditions.length === 0 ? null : or(...conditions)!;
}

async function canSee(
  tx: Tx,
  access: HrisAccess,
  row: CorrectionRow,
): Promise<boolean> {
  if (access.own && lower(access.own.id) === lower(row.employeeId)) return true;
  return isReachedEmployee(
    tx,
    row.tenantId,
    access,
    MANAGE_CODES,
    row.outletId,
    row.employeeId,
  );
}

async function findCorrection(
  tx: Tx,
  tenantId: TenantId,
  correctionId: string,
  lock = false,
): Promise<CorrectionRow | null> {
  const query = tx
    .select()
    .from(attendanceCorrections)
    .where(
      and(
        eq(attendanceCorrections.tenantId, tenantId),
        eq(attendanceCorrections.id, correctionId),
      ),
    )
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  return row ?? null;
}

// --------------------------------------------------------------- payroll

// The closed-period check itself lives in hris-payroll-lock.ts (shared with leave).
const PAYROLL_LOCKED_MESSAGE =
  "Periode payroll sudah dikunci; koreksi absensi tidak bisa diajukan.";

/** Outlet-local dates a correction touches: the requested time and the log's own day. */
async function correctionDates(
  tx: Tx,
  row: Pick<
    CorrectionRow,
    "tenantId" | "outletId" | "attendanceLogId" | "requestedOccurredAt"
  >,
): Promise<{ timeZone: string; dates: string[]; logDate: string | null }> {
  const timeZone = await loadOutletTimeZone(tx, row.tenantId, row.outletId);
  if (timeZone === null) throw notFound("Outlet");
  let logDate: string | null = null;
  if (row.attendanceLogId !== null) {
    const [log] = await tx
      .select({ businessDate: attendanceLogs.businessDate })
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.tenantId, row.tenantId),
          eq(attendanceLogs.id, row.attendanceLogId),
        ),
      )
      .limit(1);
    logDate = log?.businessDate ?? null;
  }
  const dates = new Set<string>([
    localDateOf(row.requestedOccurredAt, timeZone),
  ]);
  if (logDate !== null) dates.add(logDate);
  return { timeZone, dates: [...dates], logDate };
}

/**
 * Bead legend-em8y2: no valid log on a day with approved leave (the day would
 * be paid as leave and as work). Reads across outlets. Throwing rolls back the
 * caller's transaction, so no log is written and nothing is marked approved.
 */
async function assertNoApprovedLeave(
  tx: Tx,
  row: Pick<CorrectionRow, "tenantId" | "employeeId">,
  businessDate: string,
): Promise<void> {
  const leaves = await findApprovedLeaveOnDate(
    tx,
    row.tenantId,
    row.employeeId,
    businessDate,
  );
  if (leaves.length === 0) return;
  throw new HttpError(
    409,
    "ATTENDANCE_CORRECTION_LEAVE_DAY",
    "Karyawan punya cuti yang disetujui pada tanggal ini; koreksi absensi tidak bisa disetujui. Batalkan cuti hari itu lebih dulu bila karyawan memang masuk kerja.",
  );
}

// --------------------------------------------------------------- request

/**
 * POST /api/hris/attendance/corrections — the employee files a correction for
 * themselves. Replaying the same idempotency key returns the stored row.
 */
export async function requestAttendanceCorrection(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RequestBody,
  now = new Date(),
): Promise<AttendanceCorrection> {
  const requestedAt = new Date(input.requestedOccurredAt);
  if (requestedAt.getTime() > now.getTime())
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Waktu koreksi tidak boleh di masa depan.",
    );

  // The outlet decides the RLS scope the approval chain is opened under
  // (approval rows are outlet-owned). It must be the log's outlet, or the
  // employee's home outlet when the log is missing.
  const gate = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    if (access.own === null || !access.snapshot.permissions.includes(SELF_CODE))
      throw forbidden();
    // The browser pre-check is advisory; the session is the authority. A tab
    // that was opened by another account must not file under this session
    // (legend-2boxs). Runs before any read or write of idempotency state.
    if (
      input.expectedEmployeeId !== undefined &&
      lower(input.expectedEmployeeId) !== lower(access.own.id)
    )
      throw new HttpError(
        409,
        "ATTENDANCE_CORRECTION_IDENTITY_MISMATCH",
        "Sesi ini bukan milik karyawan yang mengajukan koreksi. Muat ulang halaman.",
      );
    if (input.attendanceLogId !== null) {
      const [log] = await tx
        .select({
          employeeId: attendanceLogs.employeeId,
          outletId: attendanceLogs.outletId,
        })
        .from(attendanceLogs)
        .where(
          and(
            eq(attendanceLogs.tenantId, context.tenant.tenantId),
            eq(attendanceLogs.id, input.attendanceLogId),
          ),
        )
        .limit(1);
      if (!log || lower(log.employeeId) !== lower(access.own.id))
        throw notFound("Log absensi");
      if (lower(log.outletId) !== lower(input.outletId))
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Outlet tidak sesuai dengan log absensi.",
        );
    } else if (lower(access.own.homeOutletId) !== lower(input.outletId)) {
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Outlet harus outlet utama karyawan.",
      );
    }
    return { outletId: input.outletId };
  });
  const scoped = outletScoped(context, gate.outletId);

  return withTenant(db, scoped, async (tx) => {
    const access = await loadHrisAccess(tx, scoped, actorUserId, now);
    const own = access.own;
    if (own === null || !access.snapshot.permissions.includes(SELF_CODE))
      throw forbidden();
    // Re-check inside the write transaction: HR may relink the account to
    // another employee between the gate and here (legend-2boxs).
    if (
      input.expectedEmployeeId !== undefined &&
      lower(input.expectedEmployeeId) !== lower(own.id)
    )
      throw new HttpError(
        409,
        "ATTENDANCE_CORRECTION_IDENTITY_MISMATCH",
        "Sesi ini bukan milik karyawan yang mengajukan koreksi. Muat ulang halaman.",
      );
    const tenantId = scoped.tenant.tenantId;
    const [employee] = await tx
      .select({ status: employees.status })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, own.id)))
      .limit(1);
    if (!employee) throw forbidden();
    if (employee.status !== "active" && employee.status !== "onboarding")
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Karyawan tidak aktif; tidak bisa mengajukan koreksi absensi.",
      );

    // One filing per employee at a time: serialises the idempotency lookup.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:attendance_correction:${tenantId}:${own.id}`}, 0))`,
    );

    const [replayed] = await tx
      .select()
      .from(attendanceCorrections)
      .where(
        and(
          eq(attendanceCorrections.tenantId, tenantId),
          eq(attendanceCorrections.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (replayed) {
      if (
        lower(replayed.employeeId) !== lower(own.id) ||
        lower(replayed.outletId) !== lower(input.outletId) ||
        replayed.attendanceLogId !== input.attendanceLogId ||
        replayed.requestedType !== input.requestedType ||
        replayed.requestedOccurredAt.getTime() !== requestedAt.getTime()
      )
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return toCorrection(replayed);
    }

    const { dates } = await correctionDates(tx, {
      tenantId,
      outletId: input.outletId,
      attendanceLogId: input.attendanceLogId,
      requestedOccurredAt: requestedAt,
    });
    await assertPayrollOpen(
      tx,
      tenantId,
      own.id,
      dates,
      PAYROLL_LOCKED_MESSAGE,
    );

    const [inserted] = await tx
      .insert(attendanceCorrections)
      .values({
        tenantId,
        outletId: input.outletId,
        employeeId: own.id,
        attendanceLogId: input.attendanceLogId,
        requestedType: input.requestedType,
        requestedOccurredAt: requestedAt,
        reason: input.reason,
        status: "pending",
        requestedBy: access.actorUserId,
        requestedAt: now,
        idempotencyKey: input.idempotencyKey,
        updatedAt: now,
      })
      .returning()
      .catch((error: unknown) => {
        if (
          uniqueViolation(error)?.constraint ===
          "attendance_corrections_tenant_idempotency_key"
        )
          throw new CoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key already used for a different request.",
          );
        throw error;
      });
    if (!inserted)
      throw new Error("Attendance correction insert returned no row");

    const opened = await openApprovalRequest(tx, scoped, {
      sourceModule: HRIS_ATTENDANCE_SOURCE_MODULE,
      actionType: "attendance_correction",
      objectType: HRIS_ATTENDANCE_OBJECT_TYPE,
      objectId: inserted.id,
      amountIdr: null,
      outletId: input.outletId,
      requestedBy: access.actorUserId,
      source: "user",
      requestReason: REQUEST_REASON,
      now,
    });

    let row: CorrectionRow;
    if (opened.required) {
      [row] = (await tx
        .update(attendanceCorrections)
        .set({ approvalChainId: opened.chainId })
        .where(eq(attendanceCorrections.id, inserted.id))
        .returning()) as [CorrectionRow];
    } else {
      // Below every tier of the matrix: approved on filing, log created at once.
      row = await applyApproved(tx, inserted, access.actorUserId, now, now);
    }
    await auditCorrection(
      tx,
      scoped,
      access.actorUserId,
      now,
      row,
      "hris.attendance_correction.created",
    );
    return toCorrection(row);
  });
}

// ------------------------------------------------------------------ list

/** GET /api/hris/attendance/corrections — approver reach by outlet, else own rows. */
export async function listAttendanceCorrections(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListQuery,
): Promise<Page<AttendanceCorrection>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const visible = visibleCondition(tx, context.tenant.tenantId, access);
    if (visible === null) throw forbidden();
    const filters: SQL[] = [
      eq(attendanceCorrections.tenantId, context.tenant.tenantId),
      visible,
    ];
    if (query.employeeId)
      filters.push(eq(attendanceCorrections.employeeId, query.employeeId));
    if (query.status)
      filters.push(eq(attendanceCorrections.status, query.status));
    if (query.cursor) {
      const [requestedAt, id] = cursorPair(query.cursor);
      const at = new Date(requestedAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          lt(attendanceCorrections.requestedAt, at),
          and(
            eq(attendanceCorrections.requestedAt, at),
            lt(attendanceCorrections.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(attendanceCorrections)
      .where(and(...filters))
      .orderBy(
        desc(attendanceCorrections.requestedAt),
        desc(attendanceCorrections.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toCorrection),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.requestedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

async function getCorrection(
  context: ScopedTenantContext,
  actorUserId: string,
  correctionId: string,
): Promise<AttendanceCorrection> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const row = await findCorrection(tx, context.tenant.tenantId, correctionId);
    if (!row || !(await canSee(tx, access, row)))
      throw notFound("Koreksi absensi");
    return toCorrection(row);
  });
}

// ---------------------------------------------------------------- decide

/**
 * POST /api/hris/attendance/corrections/:id/decision. approve/reject go
 * through the approval matrix (same rules as `/api/approvals/:id/decisions`:
 * reach, level order, requester != approver, MFA) then settle.
 */
export async function decideAttendanceCorrection(
  context: ScopedTenantContext,
  actorUserId: string,
  correctionId: string,
  input: DecideBody,
  options: { readonly mfaVerified: boolean },
  now = new Date(),
): Promise<AttendanceCorrection> {
  const gate = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const row = await findCorrection(tx, context.tenant.tenantId, correctionId);
    if (!row || !(await canSee(tx, access, row)))
      throw notFound("Koreksi absensi");
    if (
      !access.snapshot.allows(APPROVE_CODE, {
        type: "outlet",
        id: row.outletId,
      })
    )
      throw forbidden();
    const replay =
      (input.action === "approve" && row.status === "approved") ||
      (input.action === "reject" && row.status === "rejected");
    if (replay) return { row, openId: null, replay: true };
    // Validates the transition (409 CONFLICT when not allowed).
    transitionAttendanceCorrection(
      row.status as AttendanceCorrectionStatus,
      input.action,
    );
    if (input.action === "approve") {
      const { dates, timeZone, logDate } = await correctionDates(tx, row);
      await assertPayrollOpen(
        tx,
        row.tenantId,
        row.employeeId,
        dates,
        PAYROLL_LOCKED_MESSAGE,
      );
      // Before decideApprovalRequest: a refused day must not leave an
      // approved chain behind a pending correction.
      await assertNoApprovedLeave(
        tx,
        row,
        logDate ?? localDateOf(row.requestedOccurredAt, timeZone),
      );
    }
    let openId: string | null = null;
    if (row.approvalChainId) {
      const [open] = await tx
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.chainId, row.approvalChainId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .limit(1);
      openId = open?.id ?? null;
    }
    return { row, openId, replay: false };
  });

  if (gate.replay) return getCorrection(context, actorUserId, gate.row.id);

  if (gate.openId !== null)
    await decideApprovalRequest(
      context.tenant,
      actorUserId,
      gate.openId,
      {
        decision: input.action === "approve" ? "approved" : "rejected",
        reason: input.action === "approve" ? APPROVE_REASON : REJECT_REASON,
      } as Parameters<typeof decideApprovalRequest>[3],
      {
        mfaVerified: options.mfaVerified,
        idempotencyKey: input.idempotencyKey,
        now,
      },
    );
  await settleAttendanceCorrection(context, gate.row.id, now);
  return getCorrection(context, actorUserId, gate.row.id);
}

// ---------------------------------------------------------------- settle

/**
 * Marks the correction approved and creates its `manual_correction` log:
 * the one place a corrected log is written. Caller holds the row lock (or just
 * inserted the row) and has checked the payroll period.
 */
async function applyApproved(
  tx: Tx,
  row: CorrectionRow,
  decidedBy: string,
  decidedAt: Date,
  now: Date,
): Promise<CorrectionRow> {
  const { timeZone, logDate } = await correctionDates(tx, row);
  // A correction of an existing log stays on that log's business day (an
  // overnight "out" belongs to the shift that started the day before).
  const businessDate =
    logDate ?? localDateOf(row.requestedOccurredAt, timeZone);
  // legend-x0avw: serialise with leave approval before the leave check.
  await lockEmployeeLeaveAttendance(tx, row.tenantId, row.employeeId);
  // Second safety net; the decision gate refuses first (legend-em8y2).
  await assertNoApprovedLeave(tx, row, businessDate);
  const shifts = await tx
    .select({
      id: shiftAssignments.id,
      segments: shiftAssignments.segments,
    })
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, row.tenantId),
        eq(shiftAssignments.employeeId, row.employeeId),
        eq(shiftAssignments.businessDate, businessDate),
        inArray(shiftAssignments.status, ["published", "swapped"]),
      ),
    )
    .orderBy(asc(shiftAssignments.id));
  const segments = shifts.flatMap((shift) => shift.segments);
  const firstShift = shifts
    .map((shift) => ({
      id: shift.id,
      start: Math.min(...shift.segments.map((s) => Date.parse(s.startsAt))),
    }))
    .sort((a, b) => a.start - b.start)[0];
  const timing = computeWorkTiming({
    segments,
    clockInAt: row.requestedType === "in" ? row.requestedOccurredAt : null,
    clockOutAt: row.requestedType === "out" ? row.requestedOccurredAt : null,
    timeZone,
  });
  const isIn = row.requestedType === "in";
  const isOut = row.requestedType === "out";
  const logId = createUlid(now.getTime());
  await tx.insert(attendanceLogs).values({
    id: logId,
    tenantId: row.tenantId,
    outletId: row.outletId,
    employeeId: row.employeeId,
    type: row.requestedType,
    method: "manual_correction",
    occurredAt: row.requestedOccurredAt,
    receivedAt: now,
    geoDistanceM: null,
    deviceIdHash: null,
    photoKey: null,
    validity: "valid",
    flagReasons: [],
    shiftAssignmentId: firstShift?.id ?? null,
    businessDate,
    lateMinutes: isIn ? timing.lateMinutes : null,
    earlyLeaveMinutes: isOut ? timing.earlyLeaveMinutes : null,
    overtimeMinutes: isOut ? timing.overtimeMinutes : null,
    offline: false,
    clientEventId: `correction:${row.id}`,
    correctionId: row.id,
    reviewStatus: "none",
  });
  const [updated] = await tx
    .update(attendanceCorrections)
    .set({
      status: transitionAttendanceCorrection("pending", "approve"),
      decidedBy: userIdSchema.parse(decidedBy),
      decidedAt,
      resultingLogId: logId,
      updatedAt: now,
    })
    .where(eq(attendanceCorrections.id, row.id))
    .returning();
  if (!updated) throw new Error("Attendance correction update returned no row");
  return updated;
}

/**
 * Whether the last decider of the chain reaches the correction's employee at
 * its outlet (tenant reach, HR, or direct supervisor), the same rule as the
 * correction endpoints (`canSee`). Re-read here because the inbox decision
 * only checks role and outlet.
 */
async function deciderReachesEmployee(
  tx: Tx,
  context: ScopedTenantContext,
  row: CorrectionRow,
  decidedBy: string | null,
  now: Date,
): Promise<boolean> {
  if (decidedBy === null) return false;
  const access = await loadHrisAccess(tx, context, decidedBy, now);
  return isReachedEmployee(
    tx,
    row.tenantId,
    access,
    MANAGE_CODES,
    row.outletId,
    row.employeeId,
  );
}

/**
 * Applies the approval chain outcome to the correction. Locks the row,
 * re-reads the chain from the database (an event payload is a trigger, never
 * the authority) and does nothing when the correction is no longer pending or
 * the chain is still open: idempotent and replay safe.
 */
export async function settleAttendanceCorrection(
  context: ScopedTenantContext,
  correctionId: string,
  now = new Date(),
): Promise<AttendanceCorrectionStatus> {
  const outletId = await withTenant(db, context, async (tx) => {
    const row = await findCorrection(tx, context.tenant.tenantId, correctionId);
    return row?.outletId ?? null;
  });
  if (outletId === null) throw notFound("Koreksi absensi");
  const scoped = outletScoped(context, outletId);
  return withTenant(db, scoped, async (tx) => {
    const row = await findCorrection(
      tx,
      scoped.tenant.tenantId,
      correctionId,
      true,
    );
    if (!row) throw notFound("Koreksi absensi");
    if (row.status !== "pending")
      return row.status as AttendanceCorrectionStatus;
    if (!row.approvalChainId) return "pending";
    const outcome = await getApprovalChainOutcome(tx, {
      chainId: row.approvalChainId,
      sourceModule: HRIS_ATTENDANCE_SOURCE_MODULE,
    });
    if (outcome === "pending") return "pending";

    // The last human decision of the chain. A matrix expiry or system cancel
    // has none: the contract needs an actor with every decision, so the
    // requester is recorded there; the audit row names the system.
    const [last] = await tx
      .select({
        decidedBy: approvalRequests.decidedBy,
        decidedAt: approvalRequests.decidedAt,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.chainId, row.approvalChainId),
          isNotNull(approvalRequests.decidedAt),
        ),
      )
      .orderBy(desc(approvalRequests.level))
      .limit(1);
    const systemEnded = outcome === "expired" || outcome === "cancelled";
    const decidedBy = !systemEnded && last?.decidedBy ? last.decidedBy : null;
    const decidedAt = !systemEnded && last?.decidedAt ? last.decidedAt : now;

    let status: AttendanceCorrectionStatus = "rejected";
    let cause: string | undefined;
    if (outcome === "approved") {
      // legend-x0avw: take the employee lock before the leave check, so a
      // correction that loses the race to a leave approval sees that leave and
      // ends rejected instead of failing later in applyApproved.
      await lockEmployeeLeaveAttendance(tx, row.tenantId, row.employeeId);
      const { dates, timeZone, logDate } = await correctionDates(tx, row);
      if (!(await deciderReachesEmployee(tx, scoped, row, decidedBy, now))) {
        // Approved through the general inbox (skips the decision gate's reach
        // check) by an approver who is not this employee's supervisor or HR:
        // never write the log. No decider on an approved chain fails closed.
        cause = "not_supervisor";
      } else if (
        await isPayrollClosed(tx, row.tenantId, row.employeeId, dates)
      ) {
        // Approved, but the period closed while the chain was open: no log.
        cause = "payroll_locked";
      } else if (
        (
          await findApprovedLeaveOnDate(
            tx,
            row.tenantId,
            row.employeeId,
            logDate ?? localDateOf(row.requestedOccurredAt, timeZone),
          )
        ).length > 0
      ) {
        // Approved through the general inbox (skips the decision gate) or a
        // leave was approved after the gate: the day is paid as leave, so no
        // log. Ending rejected beats applyApproved throwing 409 and leaving
        // the chain approved behind a pending correction.
        cause = "leave_approved";
      } else {
        const approved = await applyApproved(
          tx,
          row,
          decidedBy ?? row.requestedBy,
          decidedAt,
          now,
        );
        await auditCorrection(
          tx,
          scoped,
          approved.decidedBy ?? approved.requestedBy,
          now,
          approved,
          "hris.attendance_correction.approved",
        );
        return "approved";
      }
    }
    const [rejected] = await tx
      .update(attendanceCorrections)
      .set({
        status,
        decidedBy: userIdSchema.parse(decidedBy ?? row.requestedBy),
        decidedAt,
        updatedAt: now,
      })
      .where(eq(attendanceCorrections.id, row.id))
      .returning();
    if (!rejected)
      throw new Error("Attendance correction update returned no row");
    status = rejected.status;
    await recordAudit(
      tx,
      scoped,
      {
        ...hrisAuditEntry(scoped, decidedBy ?? row.requestedBy, now, {
          outletId: rejected.outletId,
          action: "hris.attendance_correction.rejected",
          objectType: HRIS_ATTENDANCE_OBJECT_TYPE,
          objectId: rejected.id,
          after: cause ? { status, cause } : { status },
        }),
        // System end (expired, system cancel, closed period) has no human actor.
        ...(decidedBy && cause === undefined
          ? {}
          : { actorType: "system" as const, actorId: null }),
      },
      ATTENDANCE_AUDIT_SAFE_FIELDS,
    );
    return status;
  });
}
