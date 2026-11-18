// Attendance administration (PRD v1.7 §3 F25 "Absensi", HR-02; TEN-01..03;
// bead legend-wh71). Routes: routes/hris-attendance-admin.routes.ts.
//
// - Policy: one tenant default row (`outlet_id` null) plus optional per-outlet
//   override rows. The effective policy of an outlet is its own row, else the
//   tenant row, else the built-in fallback below (never written to the
//   database). Sampling config travels with the policy row.
// - Review queue: logs a supervisor should look at. Flagged logs enter when
//   the outlet's sampling config says `flaggedAlways`; valid selfie/QR logs
//   enter by a deterministic share (`sampleSelected`, stable per log id).
//   System-rejected attempts and manual corrections are not review items. A
//   reviewed log stays visible under its review status.
// - Review decision: `transitionAttendanceValidity` owns the legal moves.
//   Accepting a valid (sampled) log changes no validity, it only records the
//   review. A decision that already holds is returned as is (retry safe).
// - Leave clash (bead legend-9y6ri): a clock-in on a day of approved leave
//   (flagged `leave_approved`, or a valid `in` log whose leave was approved
//   later) is decided by `keep_leave` (leave stays, log becomes rejected so
//   payroll never counts it, review rejected) or `cancel_leave` (HR cancels
//   a one-day leave, used days return once, log valid, review accepted). Both
//   need `hr.attendance.manage`; cancel_leave also `hr.leave.approve`.
//   `accept` of an `in` log is refused while a leave still stands that day,
//   flag or not, so the day is never paid as leave and as work.
// - Duty meal: one record per employee, business date and shift. This slice
//   never touches stock; stock deduction by recipe is a separate consumer.
// - Access: `hr.attendance.manage` or `hr.attendance_correction.approve`
//   (supervisor) reach the review queue and duty meals within their outlets;
//   policy is `hr.attendance.manage` only, tenant default needs tenant-wide
//   reach.

import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  encodeCursor,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
  type z,
} from "@starter/shared/core";
import {
  attendanceDutyMealSchema,
  attendanceLogIdSchema,
  attendanceLogSchema,
  attendancePolicySchema,
  attendancePolicyViewSchema,
  attendanceReviewItemSchema,
  transitionAttendanceValidity,
  type AttendanceCaseKind,
  type AttendanceDutyMeal,
  type AttendancePolicy,
  type AttendancePolicyView,
  type AttendanceReviewItem,
  type decideAttendanceReview as decideAttendanceReviewEndpoint,
  type listAttendanceDutyMeals as listAttendanceDutyMealsEndpoint,
  type listAttendanceReviewQueue as listAttendanceReviewQueueEndpoint,
  type recordAttendanceDutyMeal as recordAttendanceDutyMealEndpoint,
  type updateAttendancePolicy as updateAttendancePolicyEndpoint,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import {
  attendanceDutyMeals,
  attendanceLogs,
  attendancePolicies,
  type AttendanceLeaveSnapshot,
  type AttendanceSamplingConfig,
} from "../db/schema/hris-attendance.ts";
import { employees } from "../db/schema/hris.ts";
import { shiftAssignments } from "../db/schema/hris-scheduling.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { sampleSelected } from "./hris-attendance-logic.ts";
import {
  cancelApprovedLeaveOnDateByHr,
  findApprovedLeaveOnDate,
} from "./hris-leave-request.service.ts";
import { lockEmployeeLeaveAttendance } from "./hris-leave-attendance-lock.ts";
import {
  redeductCollectiveLeaveForRejectedDay,
  reverseCollectiveLeaveForWorkedDay,
} from "./hris-leave-collective.service.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  isReachedEmployee,
  reachedEmployeeCondition,
  type HrisAccess,
  type HrisReach,
  type Tx,
} from "./hris-access.ts";

export const ATTENDANCE_MANAGE_CODES = [
  "hr.attendance.manage",
] as const satisfies readonly PermissionCode[];
/** Supervisors review sampled selfies and record duty meals at their outlets. */
export const ATTENDANCE_SUPERVISOR_CODES = [
  "hr.attendance.manage",
  "hr.attendance_correction.approve",
] as const satisfies readonly PermissionCode[];

const POLICY_OBJECT_TYPE = "attendance_policy";
const LOG_OBJECT_TYPE = "attendance_log";
const DUTY_MEAL_OBJECT_TYPE = "attendance_duty_meal";

// One fallback policy for clock-in and admin views (strict, HR-02): defined in
// the clock service so the two never disagree.
import {
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_ATTENDANCE_SAMPLING,
} from "./hris-attendance.service";

export { DEFAULT_ATTENDANCE_POLICY, DEFAULT_ATTENDANCE_SAMPLING };

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};
type LogRow = typeof attendanceLogs.$inferSelect;
type DutyMealRow = typeof attendanceDutyMeals.$inferSelect;
type UpdatePolicyBody = z.output<typeof updateAttendancePolicyEndpoint.body>;
type ReviewQueueQuery = z.output<
  typeof listAttendanceReviewQueueEndpoint.query
>;
type DecideReviewBody = z.output<typeof decideAttendanceReviewEndpoint.body>;
type RecordDutyMealBody = z.output<
  typeof recordAttendanceDutyMealEndpoint.body
>;
type DutyMealsQuery = z.output<typeof listAttendanceDutyMealsEndpoint.query>;

/**
 * Port to core-storage `signedStorageUrl` for a private selfie. Returns null
 * when no URL may or can be minted. Injected by the route bootstrap, like the
 * contract file signer of hris-contract.service.ts.
 */
export type AttendancePhotoSigner = (
  context: ScopedTenantContext,
  photoKey: string,
  /** The caller's tenant transaction: sign inside it, no extra connection. */
  tx?: Tx,
) => Promise<string | null>;
export const noAttendancePhotoSigner: AttendancePhotoSigner = async () => null;

const lower = (value: string) => value.toLowerCase();

function validation(message: string, code = "VALIDATION_ERROR"): HttpError {
  return new HttpError(422, code, message);
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function iso(value: Date): string {
  return value.toISOString();
}

function inReach(reach: HrisReach | null, outletId: string): boolean {
  if (reach === null) return false;
  return (
    reach.kind === "tenant" ||
    reach.outletIds.map(lower).includes(lower(outletId))
  );
}

// ------------------------------------------------------------------- policy

/**
 * Policy and sampling of one outlet: its own row, else the tenant row, else the
 * built-in fallback. `outletId` null asks for the tenant level only.
 */
export async function loadAttendancePolicy(
  tx: Tx,
  tenantId: TenantId,
  outletId: string | null,
): Promise<{
  policy: AttendancePolicy;
  sampling: AttendanceSamplingConfig;
  inherited: boolean;
  updatedAt: Date | null;
}> {
  const rows = await tx
    .select()
    .from(attendancePolicies)
    .where(
      and(
        eq(attendancePolicies.tenantId, tenantId),
        outletId === null
          ? isNull(attendancePolicies.outletId)
          : or(
              eq(attendancePolicies.outletId, outletId),
              isNull(attendancePolicies.outletId),
            ),
      ),
    );
  const own =
    outletId === null
      ? undefined
      : rows.find(
          (row) =>
            row.outletId !== null && lower(row.outletId) === lower(outletId),
        );
  const row = own ?? rows.find((candidate) => candidate.outletId === null);
  if (!row)
    return {
      policy: DEFAULT_ATTENDANCE_POLICY,
      sampling: DEFAULT_ATTENDANCE_SAMPLING,
      inherited: outletId !== null,
      updatedAt: null,
    };
  return {
    policy: attendancePolicySchema.parse(row.policy),
    sampling: row.sampling,
    inherited: outletId !== null && own === undefined,
    updatedAt: row.updatedAt,
  };
}

function toPolicyView(
  tenantId: string,
  outletId: string | null,
  loaded: Awaited<ReturnType<typeof loadAttendancePolicy>>,
): AttendancePolicyView {
  return attendancePolicyViewSchema.parse({
    tenantId,
    outletId,
    inherited: loaded.inherited,
    policy: loaded.policy,
    sampling: loaded.sampling,
    // No saved row yet: the fallback was never updated.
    updatedAt: iso(loaded.updatedAt ?? new Date(0)),
  });
}

async function assertOutletExists(
  tx: Tx,
  tenantId: string,
  outletId: string,
): Promise<void> {
  const [outlet] = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) throw notFound("Outlet");
}

/** GET /api/hris/attendance/policy */
export async function getAttendancePolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { outletId?: OutletId | undefined },
): Promise<{ data: AttendancePolicyView }> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const reach = access.reach(ATTENDANCE_MANAGE_CODES);
    if (reach === null) throw forbidden();
    const outletId = query.outletId ?? null;
    if (outletId !== null) {
      if (!inReach(reach, outletId)) throw forbidden();
      await assertOutletExists(tx, context.tenant.tenantId, outletId);
    }
    const loaded = await loadAttendancePolicy(
      tx,
      context.tenant.tenantId,
      outletId,
    );
    return {
      data: toPolicyView(context.tenant.tenantId, outletId, loaded),
    };
  });
}

/** PUT /api/hris/attendance/policy */
export async function updateAttendancePolicy(
  context: ScopedTenantContext,
  actorUserId: string,
  body: UpdatePolicyBody,
  now = new Date(),
): Promise<{ data: AttendancePolicyView }> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach(ATTENDANCE_MANAGE_CODES);
    if (reach === null) throw forbidden();
    const outletId = body.outletId;
    // The tenant default needs tenant-wide reach; an override needs that outlet.
    if (outletId === null ? reach.kind !== "tenant" : !inReach(reach, outletId))
      throw forbidden();
    if (outletId !== null)
      await assertOutletExists(tx, context.tenant.tenantId, outletId);
    const policy = attendancePolicySchema.parse(body.policy);
    const [row] = await tx
      .insert(attendancePolicies)
      .values({
        tenantId: context.tenant.tenantId,
        outletId,
        policy,
        sampling: body.sampling,
        updatedBy: access.actorUserId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [attendancePolicies.tenantId, attendancePolicies.outletId],
        set: {
          policy,
          sampling: body.sampling,
          updatedBy: access.actorUserId,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error("Attendance policy upsert returned no row");
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "attendance_policy.updated",
        objectType: POLICY_OBJECT_TYPE,
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: null,
          after: { fields: ["policy", "sampling"], status: "updated" },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      HRIS_AUDIT_SAFE_FIELDS,
    );
    const loaded = await loadAttendancePolicy(
      tx,
      context.tenant.tenantId,
      outletId,
    );
    return {
      data: toPolicyView(context.tenant.tenantId, outletId, loaded),
    };
  });
}

// ------------------------------------------------------------- review queue

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function toReviewItem(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  loaded: LogRow,
  signPhoto: AttendancePhotoSigner,
  now: Date,
): Promise<AttendanceReviewItem> {
  const row = await withLeaveCase(tx, loaded);
  const [employee] = await tx
    .select({ fullName: employees.fullName })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, row.tenantId),
        eq(employees.id, row.employeeId),
      ),
    )
    .limit(1);
  const [clockOut] = await tx
    .select({ occurredAt: attendanceLogs.occurredAt })
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, row.tenantId),
        eq(attendanceLogs.employeeId, row.employeeId),
        eq(attendanceLogs.businessDate, row.businessDate),
        eq(attendanceLogs.type, "out"),
        sql`${attendanceLogs.validity} <> 'rejected'`,
      ),
    )
    .orderBy(desc(attendanceLogs.occurredAt), desc(attendanceLogs.id))
    .limit(1);
  // The leave snapshot is only shown to a caller who holds hr.leave.approve
  // (the only hr.leave.* right) at the leave's own outlet; everyone else gets
  // leave null and no cancel right, so no leave type or id leaks.
  const snapshot =
    row.leaveSnapshot !== null &&
    access.snapshot.allows("hr.leave.approve", {
      type: "outlet",
      id: row.leaveSnapshot.leaveOutletId,
    })
      ? row.leaveSnapshot
      : null;
  // Cancelling needs attendance management at the clock-in outlet plus the
  // leave approval right at the leave's outlet (already proven by `snapshot`).
  const ownLog =
    access.own !== null && lower(access.own.id) === lower(row.employeeId);
  const canCancelLeave =
    !ownLog &&
    snapshot !== null &&
    row.reviewStatus === "pending" &&
    access.snapshot.allows("hr.attendance.manage", {
      type: "outlet",
      id: row.outletId,
    });
  // legend-whiwv: an edge event can name any selfie id. Never sign an object
  // that is linked to another log, or unlinked at another outlet than this
  // log's (same rule as the employee's own history).
  let photoUrl: string | null = null;
  if (row.photoKey !== null) {
    // A key that is not a UUID cannot name a storage row (the id column is a
    // uuid), so there is nothing to compare; skip the lookup instead of failing.
    const [photoObject] = !UUID_PATTERN.test(row.photoKey)
      ? []
      : await tx
          .select({
            sourceId: coreStorageObjects.sourceId,
            outletId: coreStorageObjects.outletId,
          })
          .from(coreStorageObjects)
          .where(
            and(
              eq(coreStorageObjects.tenantId, row.tenantId),
              eq(coreStorageObjects.id, row.photoKey),
            ),
          )
          .limit(1);
    const foreignPhoto =
      photoObject !== undefined &&
      (photoObject.sourceId === null
        ? photoObject.outletId !== row.outletId
        : photoObject.sourceId !== ulidToUuid(row.id));
    photoUrl = foreignPhoto ? null : await signPhoto(context, row.photoKey, tx);
  }
  // Each selfie URL handed to a reviewer is a sensitive-data access.
  if (photoUrl !== null)
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: row.outletId,
        action: "hris.attendance.photo_url_issued",
        objectType: LOG_OBJECT_TYPE,
        objectId: row.id,
        after: { status: row.validity },
        sensitiveReason: "Membuka selfie absensi.",
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
  // The device hash is the owner's own data; reviewers never see it.
  const flagged = row.validity === "flagged" || row.flagReasons.length > 0;
  return attendanceReviewItemSchema.parse({
    log: attendanceLogSchema.parse({
      id: row.id,
      tenantId: row.tenantId,
      employeeId: row.employeeId,
      outletId: row.outletId,
      type: row.type,
      method: row.method,
      occurredAt: iso(row.occurredAt),
      geoDistanceM: row.geoDistanceM,
      deviceIdHash: ownLog ? row.deviceIdHash : null,
      photoUrl,
      validity: row.validity,
      shiftAssignmentId: row.shiftAssignmentId,
    }),
    source: flagged ? "flagged" : "sampled",
    flagReasons: row.flagReasons,
    reviewStatus: row.reviewStatus,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt === null ? null : iso(row.reviewedAt),
    employeeName: employee?.fullName ?? "",
    businessDate: row.businessDate,
    clockOutAt: clockOut ? iso(clockOut.occurredAt) : null,
    caseKind: snapshot === null ? null : row.caseKind,
    canCancelLeave,
    leave:
      snapshot === null
        ? null
        : {
            leaveRequestId: snapshot.leaveRequestId,
            leaveTypeId: snapshot.leaveTypeId,
            leaveTypeName: snapshot.leaveTypeName,
            startDate: snapshot.startDate,
            endDate: snapshot.endDate,
          },
    decisionAction: row.decisionAction,
  });
}

/**
 * Copies the leave behind a pending leave case onto the log the first time HR
 * looks at it (or decides it), so the case keeps naming the original leave and
 * period after cancel_leave splits or cancels it. Reads through
 * app.leave_case_on (tenant bound, ignores the caller's outlet scope).
 * A log that is not a pending leave case (unless `deciding`), or already
 * holds a snapshot, is returned as is.
 */
async function withLeaveCase(
  tx: Tx,
  row: LogRow,
  /** A leave decision is being made: snapshot even a log nothing flagged. */
  deciding = false,
): Promise<LogRow> {
  if (row.leaveSnapshot !== null) return row;
  if (!deciding && (row.reviewStatus !== "pending" || !hasLeaveFlag(row)))
    return row;
  const found = await tx.execute(
    sql`SELECT leave_request_id, outlet_id, leave_type_id, leave_type_name, start_date::text AS start_date, end_date::text AS end_date, decided_at FROM app.leave_case_on(${row.tenantId}::uuid, ${row.employeeId}::uuid, ${row.businessDate}::date)`,
  );
  const leave = found.rows[0];
  if (leave === undefined) return row;
  const leaveSnapshot: AttendanceLeaveSnapshot = {
    leaveRequestId: String(leave.leave_request_id),
    leaveOutletId: String(leave.outlet_id),
    leaveTypeId: String(leave.leave_type_id),
    leaveTypeName: String(leave.leave_type_name),
    startDate: String(leave.start_date),
    endDate: String(leave.end_date),
  };
  const decidedAt =
    leave.decided_at === null || leave.decided_at === undefined
      ? null
      : new Date(leave.decided_at as string | Date);
  const caseKind: AttendanceCaseKind =
    row.method === "manual_correction"
      ? "manual_correction"
      : decidedAt !== null && decidedAt.getTime() > row.receivedAt.getTime()
        ? "leave_approved_later"
        : "clock_in_on_leave";
  const [updated] = await tx
    .update(attendanceLogs)
    .set({ leaveSnapshot, caseKind })
    .where(
      and(
        eq(attendanceLogs.tenantId, row.tenantId),
        eq(attendanceLogs.id, row.id),
      ),
    )
    .returning();
  return updated ?? row;
}

const SCAN_BATCH = 200;
const SCAN_MAX_ROWS = 4_000;

function decided(row: LogRow): boolean {
  return row.reviewStatus === "accepted" || row.reviewStatus === "rejected";
}

/** Whether an unreviewed log belongs in the queue under its outlet's sampling. */
function queued(
  row: LogRow,
  samplingOf: (outletId: string) => AttendanceSamplingConfig,
): boolean {
  const sampling = samplingOf(row.outletId);
  // A leave clash is always reviewed (the day would be paid twice), whatever
  // the outlet's flaggedAlways sampling says.
  if (row.validity === "flagged")
    return hasLeaveFlag(row) || sampling.flaggedAlways;
  if (row.validity === "valid") return sampleSelected(row.id, sampling.rate);
  return false;
}

/** GET /api/hris/attendance/review-queue */
export async function listAttendanceReviewQueue(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ReviewQueueQuery,
  signPhoto: AttendancePhotoSigner = noAttendancePhotoSigner,
): Promise<Page<AttendanceReviewItem>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const reach = access.reach(ATTENDANCE_SUPERVISOR_CODES);
    if (reach === null) throw forbidden();
    if (query.outletId !== undefined && !inReach(reach, query.outletId))
      throw forbidden();

    const policies = await tx
      .select()
      .from(attendancePolicies)
      .where(eq(attendancePolicies.tenantId, context.tenant.tenantId));
    const tenantSampling =
      policies.find((row) => row.outletId === null)?.sampling ??
      DEFAULT_ATTENDANCE_SAMPLING;
    const outletSampling = new Map(
      policies
        .filter((row) => row.outletId !== null)
        .map((row) => [lower(row.outletId!), row.sampling]),
    );
    const samplingOf = (outletId: string) =>
      outletSampling.get(lower(outletId)) ?? tenantSampling;

    const reviewed =
      query.reviewStatus === "accepted" || query.reviewStatus === "rejected";
    const filters: SQL[] = [
      eq(attendanceLogs.tenantId, context.tenant.tenantId),
    ];
    // A log asked for by id must still be queued unless already decided.
    const byId = query.logId !== undefined && query.reviewStatus === undefined;
    const openItems = and(
      inArray(attendanceLogs.reviewStatus, ["none", "pending"]),
      inArray(attendanceLogs.validity, ["flagged", "valid"]),
      // outlet_device (outlet attendance screen on an edge) is always flagged
      // and must reach the supervisor (Q87). manual_correction queues only
      // once flagged (leave approved after the correction, legend-7o3hd).
      or(
        inArray(attendanceLogs.method, [
          "selfie_geo",
          "rotating_qr",
          "outlet_device",
        ]),
        and(
          eq(attendanceLogs.method, "manual_correction"),
          eq(attendanceLogs.validity, "flagged"),
        ),
      )!,
    )!;
    if (reviewed) {
      filters.push(eq(attendanceLogs.reviewStatus, query.reviewStatus!));
    } else if (byId) {
      filters.push(
        or(
          inArray(attendanceLogs.reviewStatus, ["accepted", "rejected"]),
          openItems,
        )!,
      );
    } else if (query.reviewStatus) {
      filters.push(
        eq(attendanceLogs.reviewStatus, query.reviewStatus),
        openItems,
      );
    } else {
      // Open items only. A decided item is read through an explicit
      // reviewStatus or its logId.
      filters.push(openItems);
    }
    if (query.outletId !== undefined)
      filters.push(eq(attendanceLogs.outletId, query.outletId));
    else if (reach.kind === "outlets")
      filters.push(inArray(attendanceLogs.outletId, [...reach.outletIds]));
    // HR keeps its reach; a supervisor-only holder reviews only subordinates,
    // plus sees their own log (read only: nobody decides their own review).
    const reachedRows = reachedEmployeeCondition(
      tx,
      context.tenant.tenantId,
      access,
      ATTENDANCE_SUPERVISOR_CODES,
      attendanceLogs.outletId,
      attendanceLogs.employeeId,
    );
    filters.push(
      or(
        ...(reachedRows ? [reachedRows] : []),
        ...(access.own ? [eq(attendanceLogs.employeeId, access.own.id)] : []),
      ) ?? sql`false`,
    );
    if (query.businessDate !== undefined)
      filters.push(eq(attendanceLogs.businessDate, query.businessDate));
    if (query.logId !== undefined)
      filters.push(eq(attendanceLogs.id, query.logId));
    if (query.flagReason !== undefined)
      filters.push(
        sql`${attendanceLogs.flagReasons} @> ${JSON.stringify([query.flagReason])}::jsonb`,
      );

    let cursorFilter: SQL | undefined;
    if (query.cursor) {
      const [occurred, id] = cursorPair(query.cursor);
      const parsedId = attendanceLogIdSchema.safeParse(id);
      const at = new Date(occurred);
      if (!parsedId.success || Number.isNaN(at.getTime()))
        throw validation("Check the cursor.");
      cursorFilter = or(
        lt(attendanceLogs.occurredAt, at),
        and(
          eq(attendanceLogs.occurredAt, at),
          lt(attendanceLogs.id, parsedId.data),
        ),
      );
    }

    const selected: LogRow[] = [];
    let lastScanned: LogRow | undefined;
    let exhausted = false;
    let scanned = 0;
    let edge = cursorFilter;
    while (selected.length <= query.limit && scanned < SCAN_MAX_ROWS) {
      const batch = await tx
        .select()
        .from(attendanceLogs)
        .where(and(...filters, edge))
        .orderBy(desc(attendanceLogs.occurredAt), desc(attendanceLogs.id))
        .limit(SCAN_BATCH);
      for (const row of batch) {
        if (selected.length > query.limit) break;
        lastScanned = row;
        if (reviewed || (byId && decided(row)) || queued(row, samplingOf))
          selected.push(row);
      }
      scanned += batch.length;
      if (batch.length < SCAN_BATCH) {
        exhausted = true;
        break;
      }
      const last = batch[batch.length - 1]!;
      edge = or(
        lt(attendanceLogs.occurredAt, last.occurredAt),
        and(
          eq(attendanceLogs.occurredAt, last.occurredAt),
          lt(attendanceLogs.id, last.id),
        ),
      );
    }
    const page = selected.slice(0, query.limit);
    const hasMore = selected.length > query.limit;
    // More rows may follow when the page overflowed or the scan cap was hit.
    const cursorRow = hasMore
      ? page.at(-1)
      : exhausted
        ? undefined
        : lastScanned;
    // One at a time: the audit rows share the transaction.
    const data: AttendanceReviewItem[] = [];
    for (const row of page)
      data.push(
        await toReviewItem(tx, context, access, row, signPhoto, new Date()),
      );
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor: cursorRow
          ? encodeCursor([iso(cursorRow.occurredAt), cursorRow.id])
          : null,
      },
    };
  });
}

/** POST /api/hris/attendance/logs/:logId/review */
export async function decideAttendanceReview(
  context: ScopedTenantContext,
  actorUserId: string,
  logId: string,
  body: DecideReviewBody,
  signPhoto: AttendancePhotoSigner = noAttendancePhotoSigner,
  now = new Date(),
): Promise<{ data: AttendanceReviewItem }> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const reach = access.reach(ATTENDANCE_SUPERVISOR_CODES);
    if (reach === null) throw forbidden();
    // Lock order: employee lock, then the log row, then the balance and the
    // ledger. The log's employee is read without a lock to take the employee
    // lock first; the locked row is checked against it below.
    const [peek] = await tx
      .select({ employeeId: attendanceLogs.employeeId })
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.tenantId, context.tenant.tenantId),
          eq(attendanceLogs.id, logId),
        ),
      )
      .limit(1);
    if (peek)
      await lockEmployeeLeaveAttendance(
        tx,
        context.tenant.tenantId,
        peek.employeeId,
      );
    const [row] = await tx
      .select()
      .from(attendanceLogs)
      .where(
        and(
          eq(attendanceLogs.tenantId, context.tenant.tenantId),
          eq(attendanceLogs.id, logId),
        ),
      )
      .limit(1)
      .for("update");
    // Another outlet answers like a missing row.
    if (!row || !inReach(reach, row.outletId)) throw notFound("Absensi");
    // The row moved to another employee between the peek and the lock: the
    // lock held is the wrong one, so refuse instead of reversing under it.
    if (!peek || lower(peek.employeeId) !== lower(row.employeeId))
      throw conflict(
        "ATTENDANCE_REVIEW_CHANGED",
        "Absensi berubah saat diproses. Muat ulang lalu coba lagi.",
      );
    // Nobody reviews their own attendance, whatever their reach.
    if (access.own !== null && lower(access.own.id) === lower(row.employeeId))
      throw forbidden();
    // Another supervisor's employee answers like a missing row.
    if (
      !(await isReachedEmployee(
        tx,
        context.tenant.tenantId,
        access,
        ATTENDANCE_SUPERVISOR_CODES,
        row.outletId,
        row.employeeId,
      ))
    )
      throw notFound("Absensi");
    // A manual correction is decided through its approval chain, so only the
    // leave decisions (on a leave-flagged log) may review it.
    const isLeaveDecision =
      body.action === "keep_leave" || body.action === "cancel_leave";
    if (row.method === "manual_correction" && !isLeaveDecision)
      throw conflict(
        "ATTENDANCE_REVIEW_NOT_ALLOWED",
        "Koreksi manual sudah diputuskan lewat persetujuan dan tidak direview.",
      );
    // Deciding a leave clash is HR's call: attendance management, and for
    // cancel_leave also the leave approval right at the leave's outlet.
    if (body.action === "keep_leave" || body.action === "cancel_leave") {
      if (
        !access.snapshot.allows("hr.attendance.manage", {
          type: "outlet",
          id: row.outletId,
        })
      )
        throw forbidden();
      // cancel_leave: the leave approval right is checked per leave, at the
      // leave's own outlet, inside cancelApprovedLeaveOnDateByHr (403 rolls
      // the whole decision back). Same rule `canCancelLeave` shows the UI.
    }
    const holds = reviewAlreadyHolds(row, body.action);
    if (holds)
      return {
        data: await toReviewItem(tx, context, access, row, signPhoto, now),
      };

    // Leave clash (founder W8 Q21): HR picks which side is paid.
    let validity: LogRow["validity"];
    let reviewStatus: LogRow["reviewStatus"];
    let cancelledLeaveIds: string[] = [];
    // Read through app.approved_leaves_on: leave_requests RLS is per home
    // outlet, so the plain table would hide a leave filed at another outlet.
    const isInLog = row.type === "in";
    const leaves =
      body.action === "keep_leave" ||
      body.action === "cancel_leave" ||
      (body.action === "accept" && isInLog)
        ? await findApprovedLeaveOnDate(
            tx,
            context.tenant.tenantId,
            row.employeeId,
            row.businessDate,
          )
        : [];
    if (body.action === "keep_leave" || body.action === "cancel_leave") {
      // A leave decision needs the flag or a leave standing on an `in` log,
      // and a log that is still countable or waiting for review.
      const undecided =
        row.validity === "valid" ||
        (row.validity === "flagged" && row.reviewStatus === "pending");
      if (
        !undecided ||
        !(
          hasLeaveFlag(row) ||
          (isInLog && row.method !== "manual_correction" && leaves.length > 0)
        )
      )
        throw conflict(
          "ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED",
          "Keputusan cuti hanya untuk absensi masuk pada hari cuti disetujui yang belum diputuskan.",
        );
      // Copy the leave before cancel_leave splits or cancels it.
      await withLeaveCase(tx, row, true);
      if (body.action === "keep_leave") {
        // Keeping needs a leave still approved on that day, else the day
        // would be paid as neither leave nor work.
        if (leaves.length === 0)
          throw conflict(
            "ATTENDANCE_LEAVE_NOT_APPROVED",
            "Tidak ada cuti disetujui pada hari itu. Terima atau tolak absensi ini.",
          );
        // Leave stays: the log is rejected so payroll (validity <> rejected)
        // never counts the day as worked too.
        validity = transitionAttendanceValidity(row.validity, "reject");
        reviewStatus = "rejected";
      } else {
        // Refund, status change and its audit row share this transaction.
        cancelledLeaveIds = await cancelApprovedLeaveOnDateByHr(
          tx,
          context,
          access,
          { employeeId: row.employeeId, businessDate: row.businessDate },
          now,
        );
        validity =
          row.validity === "valid"
            ? row.validity
            : transitionAttendanceValidity(row.validity, "accept");
        reviewStatus = "accepted";
      }
    } else {
      // An `in` log cannot be accepted while a leave still stands that day,
      // flagged or not: that would pay the day twice (leave and work).
      if (body.action === "accept" && isInLog && leaves.length > 0)
        throw conflict(
          "ATTENDANCE_LEAVE_DECISION_REQUIRED",
          "Ada cuti disetujui pada hari itu. Pilih tetap cuti atau batalkan cuti.",
        );
      // The validity rule decides: accepting a valid log and any move on a
      // rejected log are a 409.
      validity = transitionAttendanceValidity(row.validity, body.action);
      reviewStatus =
        body.action === "flag"
          ? "pending"
          : body.action === "accept"
            ? "accepted"
            : "rejected";
    }
    const decided = reviewStatus !== "pending";
    const [updated] = await tx
      .update(attendanceLogs)
      .set({
        validity,
        reviewStatus,
        reviewedBy: decided ? access.actorUserId : null,
        reviewedAt: decided ? now : null,
        decisionAction: decided ? body.action : null,
      })
      .where(
        and(
          eq(attendanceLogs.tenantId, context.tenant.tenantId),
          eq(attendanceLogs.id, row.id),
        ),
      )
      .returning();
    if (!updated) throw new Error("Attendance review update returned no row");
    // An accepted `in` log counts as worked: give back a collective-leave
    // deduction for that day in this transaction (idempotent; none on reject).
    if (isInLog && reviewStatus === "accepted" && validity === "valid")
      await reverseCollectiveLeaveForWorkedDay(
        tx,
        context,
        actorUserId,
        row.employeeId,
        row.businessDate,
        now,
      );
    // An `in` log that is REJECTED takes a day it gave back out again (once,
    // terminal). Flagging back to pending writes nothing (founder Q42).
    if (isInLog && reviewStatus === "rejected")
      await redeductCollectiveLeaveForRejectedDay(
        tx,
        context,
        actorUserId,
        row.employeeId,
        row.businessDate,
        now,
      );
    await recordAudit(
      tx,
      context,
      {
        ...hrisAuditEntry(context, actorUserId, now, {
          outletId: row.outletId,
          action: `attendance_log.review_${body.action}`,
          objectType: LOG_OBJECT_TYPE,
          objectId: row.id,
          after: {
            fields: ["validity", "reviewStatus"],
            status: validity,
            ...(cancelledLeaveIds.length > 0 ? { cancelledLeaveIds } : {}),
          },
        }),
        reason: body.note ?? null,
      },
      [...HRIS_AUDIT_SAFE_FIELDS, "cancelledLeaveIds"],
    );
    return {
      data: await toReviewItem(tx, context, access, updated, signPhoto, now),
    };
  });
}

/** Flag reason of a clock-in on a day of approved leave (bead legend-9y6ri). */
const LEAVE_FLAG_REASON = "leave_approved";

function hasLeaveFlag(row: Pick<LogRow, "flagReasons">): boolean {
  return (row.flagReasons as readonly string[]).includes(LEAVE_FLAG_REASON);
}

/**
 * True when the requested decision is already the stored state (a retry).
 * A rejected log is final: a second reject is a 409, not a retry. A leave
 * decision holds only on a leave-flagged log: keep_leave leaves the log
 * rejected (review rejected), cancel_leave valid and accepted.
 */
function reviewAlreadyHolds(
  row: Pick<LogRow, "validity" | "reviewStatus" | "flagReasons">,
  action: DecideReviewBody["action"],
): boolean {
  if (action === "keep_leave")
    return (
      hasLeaveFlag(row) &&
      row.validity === "rejected" &&
      row.reviewStatus === "rejected"
    );
  if (action === "cancel_leave")
    return (
      hasLeaveFlag(row) &&
      row.validity === "valid" &&
      row.reviewStatus === "accepted"
    );
  if (action === "accept")
    return row.validity === "valid" && row.reviewStatus === "accepted";
  if (action === "reject") return false;
  return row.validity === "flagged" && row.reviewStatus === "pending";
}

// --------------------------------------------------------------- duty meals

function toDutyMeal(row: DutyMealRow): AttendanceDutyMeal {
  return attendanceDutyMealSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    employeeId: row.employeeId,
    shiftAssignmentId: row.shiftAssignmentId,
    businessDate: row.businessDate,
    mealCount: row.mealCount,
    recordedBy: row.recordedBy,
    recordedAt: iso(row.recordedAt),
  });
}

function sameDutyMeal(row: DutyMealRow, body: RecordDutyMealBody): boolean {
  return (
    lower(row.outletId) === lower(body.outletId) &&
    lower(row.employeeId) === lower(body.employeeId) &&
    (row.shiftAssignmentId === null
      ? body.shiftAssignmentId === null
      : body.shiftAssignmentId !== null &&
        lower(row.shiftAssignmentId) === lower(body.shiftAssignmentId)) &&
    row.businessDate === body.businessDate &&
    row.mealCount === body.mealCount
  );
}

async function assertDutyMealSubjects(
  tx: Tx,
  tenantId: TenantId,
  body: RecordDutyMealBody,
): Promise<void> {
  const [employee] = await tx
    .select({
      id: employees.id,
      status: employees.status,
      homeOutletId: employees.homeOutletId,
    })
    .from(employees)
    .where(
      and(eq(employees.tenantId, tenantId), eq(employees.id, body.employeeId)),
    )
    .limit(1);
  if (!employee) throw validation("Karyawan tidak ditemukan.");
  // Only an active employee eats on duty: an inactive or terminated one
  // answers like a missing row.
  if (employee.status !== "active") throw notFound("Karyawan");
  // legend-5bx8v: the employee must be on duty at the recorded outlet. "On
  // duty" is the strictest data we hold: the home outlet placement, or a
  // non-cancelled shift at that outlet on the meal's business date. Outlet
  // reach of the actor alone never makes an employee of another outlet eat
  // on this outlet's account.
  if (lower(employee.homeOutletId) !== lower(body.outletId)) {
    const [dutyShift] = await tx
      .select({ id: shiftAssignments.id })
      .from(shiftAssignments)
      .where(
        and(
          eq(shiftAssignments.tenantId, tenantId),
          eq(shiftAssignments.employeeId, body.employeeId),
          eq(shiftAssignments.outletId, body.outletId),
          eq(shiftAssignments.businessDate, body.businessDate),
          ne(shiftAssignments.status, "cancelled"),
        ),
      )
      .limit(1);
    if (!dutyShift)
      throw validation(
        "Karyawan tidak bertugas di outlet ini pada tanggal makan dinas.",
        "ATTENDANCE_DUTY_MEAL_EMPLOYEE_NOT_ON_DUTY",
      );
  }
  if (body.shiftAssignmentId === null) return;
  const [shift] = await tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.tenantId, tenantId),
        eq(shiftAssignments.id, body.shiftAssignmentId),
      ),
    )
    .limit(1);
  if (
    !shift ||
    shift.status === "cancelled" ||
    lower(shift.employeeId) !== lower(body.employeeId) ||
    lower(shift.outletId) !== lower(body.outletId) ||
    shift.businessDate !== body.businessDate
  )
    throw validation(
      "Shift tidak cocok dengan karyawan, outlet, dan tanggal makan dinas.",
      "ATTENDANCE_DUTY_MEAL_SHIFT_MISMATCH",
    );
}

/**
 * POST /api/hris/attendance/duty-meals. A retry with the same key and the same
 * content returns the stored record; the same key with other content, or a
 * second record for the same employee/day/shift, is a 409.
 */
export async function recordAttendanceDutyMeal(
  context: ScopedTenantContext,
  actorUserId: string,
  body: RecordDutyMealBody,
  now = new Date(),
): Promise<{ data: AttendanceDutyMeal; created: boolean }> {
  try {
    return await withTenant(db, context, async (tx) => {
      const access = await loadHrisAccess(tx, context, actorUserId, now);
      if (!inReach(access.reach(ATTENDANCE_SUPERVISOR_CODES), body.outletId))
        throw forbidden();
      const tenantId = context.tenant.tenantId;
      // Outlet reach is not enough: a supervisor records only for direct
      // reports. Checked before the idempotent replay so a replay cannot read
      // another employee's record. A non-subordinate answers like a missing row.
      if (
        !(await isReachedEmployee(
          tx,
          tenantId,
          access,
          ATTENDANCE_SUPERVISOR_CODES,
          body.outletId,
          body.employeeId,
        ))
      )
        throw notFound("Karyawan");
      const [existing] = await tx
        .select()
        .from(attendanceDutyMeals)
        .where(
          and(
            eq(attendanceDutyMeals.tenantId, tenantId),
            eq(attendanceDutyMeals.idempotencyKey, body.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (!sameDutyMeal(existing, body))
          throw conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "Kunci idempotensi ini sudah dipakai untuk catatan makan dinas lain.",
          );
        return { data: toDutyMeal(existing), created: false };
      }
      await assertOutletExists(tx, tenantId, body.outletId);
      await assertDutyMealSubjects(tx, tenantId, body);
      const [row] = await tx
        .insert(attendanceDutyMeals)
        .values({
          tenantId,
          outletId: body.outletId,
          employeeId: body.employeeId,
          shiftAssignmentId: body.shiftAssignmentId,
          businessDate: body.businessDate,
          mealCount: body.mealCount,
          recordedBy: access.actorUserId,
          recordedAt: now,
          idempotencyKey: body.idempotencyKey,
        })
        .returning();
      if (!row) throw new Error("Duty meal insert returned no row");
      await recordAudit(
        tx,
        context,
        hrisAuditEntry(context, actorUserId, now, {
          outletId: row.outletId,
          action: "attendance_duty_meal.recorded",
          objectType: DUTY_MEAL_OBJECT_TYPE,
          objectId: row.id,
          after: { fields: ["mealCount"], status: "recorded" },
        }),
        HRIS_AUDIT_SAFE_FIELDS,
      );
      return { data: toDutyMeal(row), created: true };
    });
  } catch (error) {
    if (uniqueViolation(error))
      throw conflict(
        "ATTENDANCE_DUTY_MEAL_DUPLICATE",
        "Makan dinas karyawan ini sudah dicatat untuk tanggal dan shift tersebut.",
      );
    throw error;
  }
}

/** GET /api/hris/attendance/duty-meals */
export async function listAttendanceDutyMeals(
  context: ScopedTenantContext,
  actorUserId: string,
  query: DutyMealsQuery,
): Promise<Page<AttendanceDutyMeal>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId);
    const reach = access.reach(ATTENDANCE_SUPERVISOR_CODES);
    if (reach === null) throw forbidden();
    if (query.outletId !== undefined && !inReach(reach, query.outletId))
      throw forbidden();
    const filters: SQL[] = [
      eq(attendanceDutyMeals.tenantId, context.tenant.tenantId),
    ];
    if (query.outletId !== undefined)
      filters.push(eq(attendanceDutyMeals.outletId, query.outletId));
    else if (reach.kind === "outlets")
      filters.push(inArray(attendanceDutyMeals.outletId, [...reach.outletIds]));
    // HR keeps its reach; a supervisor-only holder lists only direct reports.
    filters.push(
      reachedEmployeeCondition(
        tx,
        context.tenant.tenantId,
        access,
        ATTENDANCE_SUPERVISOR_CODES,
        attendanceDutyMeals.outletId,
        attendanceDutyMeals.employeeId,
      ) ?? sql`false`,
    );
    if (query.employeeId !== undefined)
      filters.push(eq(attendanceDutyMeals.employeeId, query.employeeId));
    if (query.businessDate !== undefined)
      filters.push(eq(attendanceDutyMeals.businessDate, query.businessDate));
    if (query.cursor) {
      const [date, id] = cursorPair(query.cursor);
      filters.push(
        or(
          lt(attendanceDutyMeals.businessDate, date),
          and(
            eq(attendanceDutyMeals.businessDate, date),
            lt(attendanceDutyMeals.id, id),
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(attendanceDutyMeals)
      .where(and(...filters))
      .orderBy(
        desc(attendanceDutyMeals.businessDate),
        desc(attendanceDutyMeals.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toDutyMeal),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.businessDate, last.id])
            : null,
      },
    };
  });
}
