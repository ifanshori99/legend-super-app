// HRIS attendance: clock, logs, outlet QR and device binding (PRD v1.7 §3
// Kelompok D 27 "Absensi", F25, HR-02; bead legend-wh71). Routes:
// routes/hris-attendance.routes.ts. Pure rules: hris-attendance-logic.ts.
//
// - The attendance time of an online submission is the server receipt time;
//   the client `occurredAt` is trusted only for an offline (edge) event and is
//   flagged `offline_time_skew` when it is too far from receipt.
// - Raw coordinates are used once to compute the distance to the outlet
//   geofence and are never stored or returned.
// - A rejected attempt is stored (validity `rejected`) so HR can see it. It
//   never counts toward worked hours: no late / early / overtime minutes.
// - Resubmitting the same `client_event_id` returns the stored row; reusing it
//   for another employee or type is IDEMPOTENCY_KEY_REUSED.
// - `photo_key` is the id of the private `core_storage_objects` selfie
//   (purpose `selfie`, linked as source kind `attendance`); the wire only ever
//   carries a short-lived signed URL minted by the injected signer.
// - The outlet QR seed is created on the first read of that outlet's QR; the
//   token itself is never stored.
// - Device binding: one active device per employee, and a device that is
//   active for another employee cannot be bound (buddy punching).

import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  CoreError,
  businessDateSchema,
  createUlid,
  encodeCursor,
  isOutletInScope,
  localDateOf,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantId,
  type z,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  ATTENDANCE_QR_ROTATION_SECONDS,
  addBusinessDays,
  attendanceDeviceSchema,
  attendanceLogged,
  attendanceLogSchema,
  attendancePolicySchema,
  attendancePolicyViewSchema,
  attendanceQrRotationSchema,
  attendanceQrTokenSchema,
  attendanceSamplingConfigSchema,
  evaluateAttendanceSubmission,
  type AttendanceDevice,
  type AttendanceFlagReason,
  type AttendanceLog,
  type AttendanceMethod,
  type AttendancePolicy,
  type AttendancePolicyView,
  type AttendanceQrRotation,
  type AttendanceQrToken,
  type AttendanceSamplingConfig,
  type AttendanceStoredFlagReason,
  type AttendanceType,
  type ShiftAssignment,
  type bindAttendanceDevice as bindAttendanceDeviceEndpoint,
  type clockAttendance as clockAttendanceEndpoint,
  type getAttendanceQr as getAttendanceQrEndpoint,
  type listAttendanceDevices as listAttendanceDevicesEndpoint,
  type listAttendanceLogs as listAttendanceLogsEndpoint,
  type revokeAttendanceDevice as revokeAttendanceDeviceEndpoint,
  type rotateAttendanceQrSecret as rotateAttendanceQrSecretEndpoint,
} from "@starter/shared/hris";
import { storagePurposePolicy } from "@starter/shared/storage";
import { db } from "../db/index.ts";
import { coreStorageObjects } from "../db/schema/core-storage.ts";
import { employees } from "../db/schema/hris.ts";
import {
  attendanceDevices,
  attendanceLogs,
  attendancePolicies,
  attendanceQrSecrets,
} from "../db/schema/hris-attendance.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { linkStorageObjectSource } from "./core-storage.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  HRIS_AUDIT_SAFE_FIELDS,
  cursorPair,
  forbidden,
  hrisAuditEntry,
  loadHrisAccess,
  notFound,
  uniqueViolation,
  type HrisAccess,
  type HrisReach,
  type Tx,
} from "./hris-access.ts";
import {
  computeWorkTiming,
  geofenceDistance,
} from "./hris-attendance-logic.ts";
import {
  edgeTableQrKeySource,
  issueQrToken,
  seedQrKeySource,
  validateQr,
  type QrKeySource,
} from "./hris-attendance-qr.ts";
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "./hris-contract.service.ts";
import {
  loadOutletTimeZone,
  loadWeekAssignments,
} from "./hris-scheduling-common.ts";

export const HRIS_ATTENDANCE_MANAGE_CODE = "hr.attendance.manage";
export const HRIS_ATTENDANCE_CLOCK_CODE = "self.attendance.clock";
const ATTENDANCE_MANAGE = [HRIS_ATTENDANCE_MANAGE_CODE] as const;
const ATTENDANCE_LOG_OBJECT_TYPE = "attendance_log";
const ATTENDANCE_DEVICE_OBJECT_TYPE = "attendance_device";
const ATTENDANCE_QR_OBJECT_TYPE = "attendance_qr_secret";
const ATTENDANCE_EVENT_DESTINATIONS = ["cloud-sync"] as const;

/** A shift matches a clock event from this long before its start to after its end. */
const SHIFT_MATCH_MARGIN_MS = 6 * 60 * 60_000;
/** An offline event dated later than this after receipt is a wrong device clock. */
const OFFLINE_FUTURE_SKEW_MS = 5 * 60_000;
/** An offline event older than this at receipt is flagged for review. */
const OFFLINE_MAX_AGE_MS = 24 * 60 * 60_000;
/** A selfie upload may be attached for this long after it was stored. */
const PHOTO_MAX_AGE_MS = 24 * 60 * 60_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LogRow = typeof attendanceLogs.$inferSelect;
type DeviceRow = typeof attendanceDevices.$inferSelect;
type ClockBody = z.output<typeof clockAttendanceEndpoint.body>;
type ListLogsQuery = z.output<typeof listAttendanceLogsEndpoint.query>;
type GetQrQuery = z.output<typeof getAttendanceQrEndpoint.query>;
type RotateQrBody = z.output<typeof rotateAttendanceQrSecretEndpoint.body>;
type BindDeviceBody = z.output<typeof bindAttendanceDeviceEndpoint.body>;
type ListDevicesQuery = z.output<typeof listAttendanceDevicesEndpoint.query>;
type RevokeDeviceBody = z.output<typeof revokeAttendanceDeviceEndpoint.body>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const lower = (value: string) => value.toLowerCase();

function validation(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

function outletScoped(
  context: ScopedTenantContext,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(context.tenant, {
    kind: "outlets",
    outletIds: [outletId],
  } as Parameters<typeof establishScopedTenantContext>[1]);
}

function reachIncludes(reach: HrisReach | null, outletId: string): boolean {
  if (reach === null) return false;
  return (
    reach.kind === "tenant" ||
    reach.outletIds.some((id) => id === lower(outletId))
  );
}

// ------------------------------------------------------------------ policy

/**
 * Policy used when a tenant has configured nothing (founder decision Q81):
 * a clock outside the geofence or from an unbound device is ACCEPTED as
 * "flagged" for supervisor review rather than rejected. The selfie stays
 * required. A policy the tenant saved is never changed by this default.
 */
export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicy = {
  geofenceRadiusM: 100,
  outsideGeofenceAction: "flag",
  unboundDeviceAction: "flag",
  requireSelfie: true,
  requireDeviceBinding: true,
  allowRotatingQr: true,
  selfieRetentionDays: 90,
};

export const DEFAULT_ATTENDANCE_SAMPLING: AttendanceSamplingConfig = {
  rate: 0.1,
  flaggedAlways: true,
  minPerSupervisorPerWeek: 5,
};

/**
 * Policy of one outlet: its own row, else the tenant default row, else the
 * built-in default. `outletId` null reads the tenant default itself. `inherited`
 * is true when an outlet view shows a value it does not own.
 */
export async function loadAttendancePolicy(
  tx: Tx,
  tenantId: TenantId,
  outletId: string | null,
): Promise<AttendancePolicyView> {
  const rows = await tx
    .select()
    .from(attendancePolicies)
    .where(
      and(
        eq(attendancePolicies.tenantId, tenantId),
        outletId === null
          ? sql`${attendancePolicies.outletId} IS NULL`
          : or(
              sql`${attendancePolicies.outletId} IS NULL`,
              eq(attendancePolicies.outletId, outletId),
            ),
      ),
    );
  const own =
    outletId === null
      ? rows.find((row) => row.outletId === null)
      : rows.find((row) => row.outletId !== null);
  const row = own ?? rows.find((entry) => entry.outletId === null);
  if (!row)
    return attendancePolicyViewSchema.parse({
      tenantId,
      outletId,
      inherited: outletId !== null,
      policy: DEFAULT_ATTENDANCE_POLICY,
      sampling: DEFAULT_ATTENDANCE_SAMPLING,
      updatedAt: new Date(0).toISOString(),
    });
  return attendancePolicyViewSchema.parse({
    tenantId,
    outletId,
    inherited: outletId !== null && own === undefined,
    policy: attendancePolicySchema.parse(row.policy),
    sampling: attendanceSamplingConfigSchema.parse(row.sampling),
    updatedAt: row.updatedAt.toISOString(),
  });
}

// ------------------------------------------------------------------- shift

const shiftEdges = (shift: Pick<ShiftAssignment, "segments">) => ({
  start: Math.min(...shift.segments.map((s) => Date.parse(s.startsAt))),
  end: Math.max(...shift.segments.map((s) => Date.parse(s.endsAt))),
});

/**
 * The shift an employee works around an instant: a published (or swapped)
 * assignment whose span, widened by 6 hours on both sides, contains `at`. The
 * closest span wins (0 when `at` is inside it), then the earlier start, so a
 * night shift still matches a clock-out after midnight. Null without a shift.
 */
export async function resolveEmployeeShift(
  tx: Tx,
  tenantId: TenantId,
  employeeId: string,
  at: Date,
  timeZone: string,
): Promise<ShiftAssignment | null> {
  const date = localDateOf(at, timeZone);
  const assignments = await loadWeekAssignments(
    tx,
    tenantId,
    { employeeIds: [employeeId] },
    addBusinessDays(date, -1),
    addBusinessDays(date, 1),
  );
  const time = at.getTime();
  let best: { shift: ShiftAssignment; distance: number; start: number } | null =
    null;
  for (const shift of assignments) {
    if (shift.status !== "published" && shift.status !== "swapped") continue;
    if (shift.segments.length === 0) continue;
    const { start, end } = shiftEdges(shift);
    const distance = time < start ? start - time : time > end ? time - end : 0;
    if (distance > SHIFT_MATCH_MARGIN_MS) continue;
    if (
      best === null ||
      distance < best.distance ||
      (distance === best.distance && start < best.start)
    )
      best = { shift, distance, start };
  }
  return best?.shift ?? null;
}

// ---------------------------------------------------------------- mappers

export function toAttendanceLog(
  row: LogRow,
  photoUrl: string | null = null,
  /** The device hash is the employee's own data: managers get null. */
  exposeDeviceHash = false,
): AttendanceLog {
  return attendanceLogSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    outletId: row.outletId,
    type: row.type,
    method: row.method,
    occurredAt: row.occurredAt.toISOString(),
    geoDistanceM: row.geoDistanceM,
    deviceIdHash: exposeDeviceHash ? row.deviceIdHash : null,
    photoUrl,
    validity: row.validity,
    shiftAssignmentId: row.shiftAssignmentId,
  });
}

export function toAttendanceDevice(row: DeviceRow): AttendanceDevice {
  return attendanceDeviceSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    label: row.label,
    status: row.status,
    boundAt: row.boundAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
  });
}

/**
 * The log DTO with a signed selfie URL when the injected signer mints one.
 * `canSee` is the caller's own rule (own log, or manage reach at the outlet);
 * each URL issued is audited with a sensitive-access reason.
 */
async function presentLog(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  canSee: boolean,
  isOwn: boolean,
  row: LogRow,
  signer: HrisFileSigner,
  now: Date,
): Promise<AttendanceLog> {
  if (row.photoKey === null || !canSee)
    return toAttendanceLog(row, null, isOwn);
  const url = await signer(context, row.photoKey, tx);
  if (url !== null)
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, actorUserId, now, {
        outletId: row.outletId,
        action: "hris.attendance.photo_url_issued",
        objectType: ATTENDANCE_LOG_OBJECT_TYPE,
        objectId: row.id,
        after: { status: row.validity },
        sensitiveReason: "Membuka selfie absensi.",
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
  return toAttendanceLog(row, url, isOwn);
}

// --------------------------------------------------------- recordAttendance

export type AttendanceScope = {
  readonly tenantId: TenantId;
  readonly outletId: string;
};

export type RecordAttendanceInput = {
  employeeId: string;
  type: AttendanceType;
  method: AttendanceMethod;
  /** Trusted only when `offline` is true; otherwise `receivedAt` is used. */
  occurredAt: Date;
  receivedAt: Date;
  location: {
    latitude: number;
    longitude: number;
    accuracyM: number | null;
  } | null;
  deviceIdHash: string | null;
  /** Id of the private selfie object (already validated by the caller). */
  photoKey: string | null;
  qrToken: string | null;
  clientEventId: string;
  offline: boolean;
};

/**
 * True on an edge node. The server answers before `startEdgeRuntime` flips
 * `edgeMode`, so the static `EDGE_MODE` setting counts too: an edge in its boot
 * window must never act as the cloud and create a QR seed (same fix as
 * legend-3yqy, pos-receipt.service.ts).
 */
function isEdgeMode(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

/**
 * Where QR day keys come from. The cloud derives them from the outlet seed; an
 * edge reads the keys the cloud sent (it never holds a seed).
 */
function qrKeySourceFor(tx: Tx, edgeMode = isEdgeMode()): QrKeySource {
  if (edgeMode) return edgeTableQrKeySource(tx);
  return seedQrKeySource(async (tenantId, outletId) => {
    const [secret] = await tx
      .select({ seed: attendanceQrSecrets.seed })
      .from(attendanceQrSecrets)
      .where(
        and(
          eq(attendanceQrSecrets.tenantId, tenantId as TenantId),
          eq(attendanceQrSecrets.outletId, outletId),
        ),
      )
      .limit(1);
    return secret?.seed ?? null;
  });
}

async function findLogByClientEvent(
  tx: Tx,
  tenantId: TenantId,
  clientEventId: string,
): Promise<LogRow | null> {
  const [row] = await tx
    .select()
    .from(attendanceLogs)
    .where(
      and(
        eq(attendanceLogs.tenantId, tenantId),
        eq(attendanceLogs.clientEventId, clientEventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function assertSameSubmission(row: LogRow, input: RecordAttendanceInput) {
  if (
    lower(row.employeeId) !== lower(input.employeeId) ||
    row.type !== input.type
  )
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key already used for a different request.",
    );
}

async function appendAttendanceLogged(
  tx: Tx,
  scope: AttendanceScope,
  row: LogRow,
  now: Date,
): Promise<void> {
  // Minted here from ids this service verified itself: callers (clock, edge
  // replay, correction consumer) hand over plain ids.
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: scope.tenantId,
      brandId: null,
      source: "job",
    }),
    { kind: "outlets", outletIds: [scope.outletId] } as Parameters<
      typeof establishScopedTenantContext
    >[1],
  );
  for (const destination of ATTENDANCE_EVENT_DESTINATIONS) {
    const event = attendanceLogged.envelopeSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: row.tenantId,
      outletId: row.outletId,
      name: attendanceLogged.name,
      version: attendanceLogged.version,
      aggregateType: attendanceLogged.entry.aggregateType,
      aggregateId: row.id,
      sequence: 1,
      occurredAt: row.occurredAt.toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${attendanceLogged.name}:${row.id}`,
      payloadSchemaRef: attendanceLogged.payloadSchemaRef,
      payload: {
        attendanceLogId: row.id,
        employeeId: row.employeeId,
        outletId: row.outletId,
        type: row.type,
        method: row.method,
        occurredAt: row.occurredAt.toISOString(),
        validity: row.validity,
        shiftAssignmentId: row.shiftAssignmentId,
      },
    });
    await appendOutbox(tx, context, {
      id: createUlid(now.getTime()),
      event,
      destination,
      direction: null,
      peerId: null,
    });
  }
}

/**
 * Evaluates one attendance submission against the outlet policy and stores
 * it. Runs on the caller's transaction, which must be scoped to `scope.outletId`.
 * Idempotent on (tenant, clientEventId). A rejected submission is stored with
 * validity `rejected` and returned; the route turns it into a 422.
 */
export async function recordAttendanceLog(
  tx: Tx,
  scope: AttendanceScope,
  input: RecordAttendanceInput,
): Promise<LogRow> {
  return (await storeAttendanceLog(tx, scope, input)).row;
}

/**
 * `recordAttendanceLog` that also says whether this call created the row
 * (false for a replay or a lost race), so the caller links the selfie once.
 */
async function storeAttendanceLog(
  tx: Tx,
  scope: AttendanceScope,
  input: RecordAttendanceInput,
): Promise<{ row: LogRow; created: boolean }> {
  const { tenantId, outletId } = scope;
  // A manual correction is written only by the correction approval, which
  // inserts its own log; no submission path may mint one.
  if (input.method === "manual_correction")
    throw validation("Metode koreksi manual tidak bisa dipakai untuk absen.");
  const replayed = await findLogByClientEvent(
    tx,
    tenantId,
    input.clientEventId,
  );
  if (replayed) {
    assertSameSubmission(replayed, input);
    return { row: replayed, created: false };
  }

  const [outlet] = await tx
    .select({ timezone: outlets.timezone, geofence: outlets.geofence })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet) throw notFound("Outlet");

  const effectiveAt = input.offline ? input.occurredAt : input.receivedAt;
  const { policy } = await loadAttendancePolicy(tx, tenantId, outletId);

  let decision: {
    validity: LogRow["validity"];
    reasons: AttendanceStoredFlagReason[];
  };
  let geoDistanceM: number | null = null;
  if (input.offline) {
    // Edge replay: the event carries none of the evidence the edge vetted
    // (device, QR, selfie, geofence), so it cannot be verified here. Store it
    // flagged for review; the client time is checked below.
    decision = { validity: "flagged", reasons: ["offline_unverified"] };
  } else {
    if (input.method === "selfie_geo" && input.location !== null) {
      const distance = geofenceDistance(input.location, outlet.geofence);
      geoDistanceM = distance?.distanceMeters ?? null;
    }
    let deviceBound = false;
    if (input.deviceIdHash !== null) {
      const [bound] = await tx
        .select({ id: attendanceDevices.id })
        .from(attendanceDevices)
        .where(
          and(
            eq(attendanceDevices.tenantId, tenantId),
            eq(attendanceDevices.employeeId, input.employeeId),
            eq(attendanceDevices.deviceIdHash, input.deviceIdHash),
            eq(attendanceDevices.status, "active"),
          ),
        )
        .limit(1);
      deviceBound = bound !== undefined;
    }
    let qrValid = false;
    if (input.method === "rotating_qr" && input.qrToken !== null) {
      // An edge never validates a QR itself (design §3.2, T4: it rejects
      // rotating_qr before this point): fail closed.
      qrValid = isEdgeMode()
        ? false
        : await validateQr(
            qrKeySourceFor(tx, false),
            tenantId,
            outletId,
            input.qrToken,
            effectiveAt.getTime(),
          );
    }
    const evaluated = evaluateAttendanceSubmission({
      policy,
      method: input.method,
      geoDistanceM,
      deviceBound,
      selfieProvided: input.photoKey !== null,
      qrValid,
    });
    decision = {
      validity: evaluated.validity,
      reasons: [...evaluated.reasons],
    };
  }
  if (input.offline) {
    const skew = input.receivedAt.getTime() - input.occurredAt.getTime();
    if (skew < -OFFLINE_FUTURE_SKEW_MS || skew > OFFLINE_MAX_AGE_MS) {
      decision.reasons.push("offline_time_skew");
      if (decision.validity === "valid") decision.validity = "flagged";
    }
  }

  const shift = await resolveEmployeeShift(
    tx,
    tenantId,
    input.employeeId,
    effectiveAt,
    outlet.timezone,
  );
  const counted =
    shift !== null &&
    decision.validity !== "rejected" &&
    (input.type === "in" || input.type === "out");
  const timing =
    shift !== null && counted
      ? computeWorkTiming({
          segments: shift.segments,
          clockInAt: input.type === "in" ? effectiveAt : null,
          clockOutAt: input.type === "out" ? effectiveAt : null,
          timeZone: outlet.timezone,
        })
      : null;

  const [inserted] = await tx
    .insert(attendanceLogs)
    .values({
      id: createUlid(effectiveAt.getTime()),
      tenantId,
      outletId,
      employeeId: input.employeeId,
      type: input.type,
      method: input.method,
      occurredAt: effectiveAt,
      receivedAt: input.receivedAt,
      geoDistanceM,
      deviceIdHash: input.deviceIdHash,
      photoKey: input.photoKey,
      validity: decision.validity,
      // The column type predates `offline_time_skew`; the stored value is the
      // contract's `attendanceStoredFlagReasonSchema`.
      flagReasons: decision.reasons as AttendanceFlagReason[],
      shiftAssignmentId: shift?.id ?? null,
      businessDate: businessDateSchema.parse(
        shift?.businessDate ?? localDateOf(effectiveAt, outlet.timezone),
      ),
      lateMinutes: timing?.lateMinutes ?? null,
      earlyLeaveMinutes: timing?.earlyLeaveMinutes ?? null,
      overtimeMinutes: timing?.overtimeMinutes ?? null,
      offline: input.offline,
      clientEventId: input.clientEventId,
      reviewStatus: decision.validity === "flagged" ? "pending" : "none",
    })
    .onConflictDoNothing({
      target: [attendanceLogs.tenantId, attendanceLogs.clientEventId],
    })
    .returning();
  if (!inserted) {
    // Two submissions of one event raced: the other one won.
    const winner = await findLogByClientEvent(
      tx,
      tenantId,
      input.clientEventId,
    );
    if (!winner) throw new Error("Attendance log insert returned no row");
    assertSameSubmission(winner, input);
    return { row: winner, created: false };
  }
  if (inserted.validity !== "rejected")
    await appendAttendanceLogged(tx, scope, inserted, input.receivedAt);
  return { row: inserted, created: true };
}

// ------------------------------------------------------------------- clock

export type ClockResult = {
  log: AttendanceLog;
  /** Why the log is flagged or rejected; empty for a valid log. */
  flagReasons: AttendanceStoredFlagReason[];
};

/**
 * The upload must be a fresh private `selfie` object at the log outlet that
 * the employee uploaded themself and nothing else references.
 */
async function assertSelfieUsable(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
  actorUserId: string,
  uploadRef: string,
  now: Date,
) {
  const invalid = () => validation("Selfie tidak ditemukan atau tidak valid.");
  if (!UUID_PATTERN.test(uploadRef)) throw invalid();
  const [object] = await tx
    .select({
      outletId: coreStorageObjects.outletId,
      purpose: coreStorageObjects.purpose,
      createdAt: coreStorageObjects.createdAt,
      ownerUserId: coreStorageObjects.ownerUserId,
      sourceId: coreStorageObjects.sourceId,
    })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, tenantId),
        eq(coreStorageObjects.id, uploadRef),
      ),
    )
    .limit(1);
  const policy = object
    ? (storagePurposePolicy as Record<string, { visibility: string }>)[
        object.purpose
      ]
    : undefined;
  if (
    !object ||
    object.purpose !== "selfie" ||
    policy?.visibility !== "private" ||
    object.outletId === null ||
    lower(object.outletId) !== lower(outletId) ||
    object.ownerUserId !== actorUserId ||
    object.sourceId !== null ||
    object.createdAt.getTime() < now.getTime() - PHOTO_MAX_AGE_MS
  )
    throw invalid();
}

/**
 * POST /api/hris/attendance/clock — the employee clocks themself. The log
 * outlet is the outlet of the shift they work now, else their home outlet.
 * Replaying the same idempotency key returns the stored log.
 */
export async function clockAttendance(
  context: ScopedTenantContext,
  actorUserId: string,
  body: ClockBody,
  now = new Date(),
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<ClockResult> {
  if (body.method === "manual_correction")
    throw validation("Metode koreksi manual tidak bisa dipakai untuk absen.");
  // outlet_device is made only by the outlet attendance screen on an edge
  // (design 2, 3.4). Its checks (device token, PIN session) are legend-j6cyb;
  // until they exist nobody may claim the method, or a phone could skip the
  // geofence, device and QR checks.
  if (body.method === "outlet_device")
    throw validation("Metode layar outlet belum tersedia untuk absen.");
  // Phase 1: who is clocking and where. The outlet is not known until the
  // shift is, and the write below needs a context scoped to it.
  const target = await withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const own = access.own;
    if (
      own === null ||
      !access.snapshot.permissions.includes(HRIS_ATTENDANCE_CLOCK_CODE)
    )
      throw forbidden();
    const tenantId = context.tenant.tenantId;
    const [employee] = await tx
      .select({ status: employees.status })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.id, own.id)))
      .limit(1);
    if (!employee) throw forbidden();
    if (employee.status !== "active" && employee.status !== "onboarding")
      throw validation("Karyawan tidak aktif; tidak bisa absen.");
    const timeZone = await loadOutletTimeZone(tx, tenantId, own.homeOutletId);
    if (timeZone === null) throw notFound("Outlet");
    const shift = await resolveEmployeeShift(
      tx,
      tenantId,
      own.id,
      now,
      timeZone,
    );
    return {
      employeeId: own.id,
      outletId: shift?.outletId ?? own.homeOutletId,
    };
  });

  const scoped = outletScoped(context, target.outletId);
  const tenantId = scoped.tenant.tenantId;
  return withTenant(db, scoped, async (tx) => {
    const present = (row: LogRow) =>
      presentLog(tx, scoped, actorUserId, true, true, row, signer, now);
    const replayed = await findLogByClientEvent(
      tx,
      tenantId,
      body.idempotencyKey,
    );
    if (replayed) {
      if (
        lower(replayed.employeeId) !== lower(target.employeeId) ||
        replayed.type !== body.type
      )
        throw new CoreError(
          "IDEMPOTENCY_KEY_REUSED",
          "Idempotency key already used for a different request.",
        );
      return {
        log: await present(replayed),
        flagReasons: storedReasons(replayed),
      };
    }
    if (body.photoUploadRef !== null)
      await assertSelfieUsable(
        tx,
        tenantId,
        target.outletId,
        actorUserId,
        body.photoUploadRef,
        now,
      );
    const { row, created } = await storeAttendanceLog(
      tx,
      { tenantId, outletId: target.outletId },
      {
        employeeId: target.employeeId,
        type: body.type,
        method: body.method,
        occurredAt: new Date(body.occurredAt),
        receivedAt: now,
        location: body.location,
        deviceIdHash: body.deviceIdHash,
        photoKey: body.photoUploadRef,
        qrToken: body.qrToken,
        clientEventId: body.idempotencyKey,
        offline: false,
      },
    );
    // Only the call that created the row links the selfie: a twin request that
    // lost the insert race returns the same log without linking again.
    if (
      created &&
      row.photoKey !== null &&
      row.photoKey === body.photoUploadRef
    )
      await linkStorageObjectSource(tx, {
        tenantId,
        objectId: row.photoKey,
        sourceKind: "attendance",
        sourceId: ulidToUuid(row.id),
        actorUserId,
        outletId: row.outletId,
      });
    return { log: await present(row), flagReasons: storedReasons(row) };
  });
}

function storedReasons(row: LogRow): AttendanceStoredFlagReason[] {
  return [...(row.flagReasons as AttendanceStoredFlagReason[])];
}

// -------------------------------------------------------------------- logs

/** GET /api/hris/attendance/logs — manage reach by outlet, plus the caller's own. */
export async function listAttendanceLogs(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListLogsQuery,
  now = new Date(),
  signer: HrisFileSigner = noHrisFileSigner,
): Promise<Page<AttendanceLog>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const visible: SQL[] = [];
    const manage = access.reach(ATTENDANCE_MANAGE);
    if (manage)
      visible.push(
        manage.kind === "tenant"
          ? sql`true`
          : inArray(attendanceLogs.outletId, [...manage.outletIds]),
      );
    const own = access.own;
    if (
      own !== null &&
      access.snapshot.permissions.includes(HRIS_ATTENDANCE_CLOCK_CODE)
    )
      visible.push(eq(attendanceLogs.employeeId, own.id));
    if (visible.length === 0) throw forbidden();

    const filters: SQL[] = [
      eq(attendanceLogs.tenantId, context.tenant.tenantId),
      or(...visible)!,
    ];
    if (query.employeeId)
      filters.push(eq(attendanceLogs.employeeId, query.employeeId));
    if (query.outletId)
      filters.push(eq(attendanceLogs.outletId, query.outletId));
    if (query.businessDate)
      filters.push(eq(attendanceLogs.businessDate, query.businessDate));
    if (query.cursor) {
      const [occurredAt, id] = cursorPair(query.cursor);
      const at = new Date(occurredAt);
      if (Number.isNaN(at.getTime())) throw validation("Check the cursor.");
      filters.push(
        or(
          lt(attendanceLogs.occurredAt, at),
          and(eq(attendanceLogs.occurredAt, at), lt(attendanceLogs.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(attendanceLogs)
      .where(and(...filters))
      .orderBy(desc(attendanceLogs.occurredAt), desc(attendanceLogs.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const data: AttendanceLog[] = [];
    for (const row of page) {
      const isOwn = own !== null && lower(own.id) === lower(row.employeeId);
      const canSee = isOwn || reachIncludes(manage, row.outletId);
      data.push(
        await presentLog(
          tx,
          context,
          actorUserId,
          canSee,
          isOwn,
          row,
          signer,
          now,
        ),
      );
    }
    return {
      data,
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.occurredAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

// ---------------------------------------------------------------------- QR

async function assertManagesOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  access: HrisAccess,
  outletId: string,
) {
  if (
    !reachIncludes(access.reach(ATTENDANCE_MANAGE), outletId) ||
    !isOutletInScope(context.outletScope, outletId)
  )
    throw forbidden();
  const [outlet] = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.id, outletId),
      ),
    )
    .limit(1);
  if (!outlet) throw notFound("Outlet");
}

/** Cloud only: creates the outlet seed on first use (no-op when it exists). */
async function ensureQrSeed(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: attendanceQrSecrets.id })
    .from(attendanceQrSecrets)
    .where(
      and(
        eq(attendanceQrSecrets.tenantId, tenantId),
        eq(attendanceQrSecrets.outletId, outletId),
      ),
    )
    .limit(1);
  if (existing) return;
  await tx
    .insert(attendanceQrSecrets)
    .values({ tenantId, outletId, seed: randomBytes(32) })
    .onConflictDoNothing({
      target: [attendanceQrSecrets.tenantId, attendanceQrSecrets.outletId],
    });
}

/** Test seams for the QR endpoints; production code passes nothing. */
export interface AttendanceQrOptions {
  /** Force edge or cloud behaviour (default: the runtime state). */
  edgeMode?: boolean;
  /** Replace the key source (default: seed on the cloud, edge key table on an edge). */
  keySource?: QrKeySource;
}

/**
 * GET /api/hris/attendance/qr — the outlet display polls the token of the
 * current 30 s window (v2, daily key). Needs `hr.attendance.manage` at the
 * outlet; an employee must never be able to read it. On the cloud the first
 * read creates the outlet seed. On an edge there is no seed and no lazy
 * generation: no key for today means 503 `QR_KEY_UNAVAILABLE`.
 */
export async function getAttendanceQr(
  context: ScopedTenantContext,
  actorUserId: string,
  query: GetQrQuery,
  now = new Date(),
  options: AttendanceQrOptions = {},
): Promise<AttendanceQrToken> {
  const edgeMode = options.edgeMode ?? isEdgeMode();
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    await assertManagesOutlet(tx, context, access, query.outletId);
    const tenantId = context.tenant.tenantId;
    // Cloud only: the first read creates the outlet seed. Never on an edge.
    if (!edgeMode) await ensureQrSeed(tx, tenantId, query.outletId);
    const source = options.keySource ?? qrKeySourceFor(tx, edgeMode);
    const { token, window } = await issueQrToken(
      source,
      tenantId,
      query.outletId,
      now.getTime(),
    );
    const issuedAt = window * ATTENDANCE_QR_ROTATION_SECONDS * 1_000;
    return attendanceQrTokenSchema.parse({
      outletId: query.outletId,
      token,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(
        issuedAt + ATTENDANCE_QR_ROTATION_SECONDS * 1_000,
      ).toISOString(),
      rotationSeconds: ATTENDANCE_QR_ROTATION_SECONDS,
    });
  });
}

/**
 * POST /api/hris/attendance/qr/rotate — replaces the outlet seed, which changes
 * every day key at once; the QR on the display and every printed copy stop
 * validating. Audited. Cloud only: on an edge it throws before touching the
 * table (the edge holds no seed).
 */
export async function rotateAttendanceQrSecret(
  context: ScopedTenantContext,
  actorUserId: string,
  body: RotateQrBody,
  now = new Date(),
  options: Pick<AttendanceQrOptions, "edgeMode"> = {},
): Promise<AttendanceQrRotation> {
  if (options.edgeMode ?? isEdgeMode())
    throw new HttpError(
      404,
      "CLOUD_ONLY_ROUTE",
      "The QR key can only be rotated on the cloud.",
    );
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    await assertManagesOutlet(tx, context, access, body.outletId);
    const tenantId = context.tenant.tenantId;
    await tx
      .insert(attendanceQrSecrets)
      .values({
        tenantId,
        outletId: body.outletId,
        seed: randomBytes(32),
        rotatedAt: now,
      })
      .onConflictDoUpdate({
        target: [attendanceQrSecrets.tenantId, attendanceQrSecrets.outletId],
        set: { seed: randomBytes(32), rotatedAt: now },
      });
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: body.outletId,
        action: "hris.attendance.qr_rotated",
        objectType: ATTENDANCE_QR_OBJECT_TYPE,
        objectId: body.outletId,
        after: { status: "rotated" },
      }),
      HRIS_AUDIT_SAFE_FIELDS,
    );
    return attendanceQrRotationSchema.parse({
      outletId: body.outletId,
      rotatedAt: now.toISOString(),
    });
  });
}

// ----------------------------------------------------------------- devices

const DEVICE_AUDIT_SAFE_FIELDS = [...HRIS_AUDIT_SAFE_FIELDS, "reason"] as const;

/**
 * POST /api/hris/attendance/devices/bind — the employee binds their own phone.
 * The same device again returns the stored binding (a revoked one is
 * reactivated); another active device is a 409 until HR resets it.
 */
export async function bindAttendanceDevice(
  context: ScopedTenantContext,
  actorUserId: string,
  body: BindDeviceBody,
  now = new Date(),
): Promise<AttendanceDevice> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const own = access.own;
    if (
      own === null ||
      !access.snapshot.permissions.includes(HRIS_ATTENDANCE_CLOCK_CODE)
    )
      throw forbidden();
    const tenantId = context.tenant.tenantId;
    // One bind at a time per employee: the active-device unique index would
    // otherwise surface as a 500 for two concurrent first binds.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`hris:attendance-device:${tenantId}:${own.id}`}, 0))`,
    );
    const rows = await tx
      .select()
      .from(attendanceDevices)
      .where(
        and(
          eq(attendanceDevices.tenantId, tenantId),
          or(
            eq(attendanceDevices.employeeId, own.id),
            and(
              eq(attendanceDevices.deviceIdHash, body.deviceIdHash),
              eq(attendanceDevices.status, "active"),
            ),
          ),
        ),
      );
    const mine = rows.filter((row) => lower(row.employeeId) === lower(own.id));
    const sameDevice = mine.find(
      (row) => row.deviceIdHash === body.deviceIdHash,
    );
    if (sameDevice?.status === "active") return toAttendanceDevice(sameDevice);
    if (rows.some((row) => lower(row.employeeId) !== lower(own.id)))
      throw conflict(
        "DEVICE_ALREADY_BOUND",
        "Perangkat ini sudah terikat ke karyawan lain.",
      );
    if (mine.some((row) => row.status === "active"))
      throw conflict(
        "DEVICE_ALREADY_BOUND",
        "Sudah ada perangkat terikat; minta HR mereset perangkat lama.",
      );
    const [saved] = sameDevice
      ? await tx
          .update(attendanceDevices)
          .set({
            status: "active",
            label: body.label,
            boundAt: now,
            revokedAt: null,
            revokedBy: null,
          })
          .where(
            and(
              eq(attendanceDevices.tenantId, tenantId),
              eq(attendanceDevices.id, sameDevice.id),
            ),
          )
          .returning()
      : await tx
          .insert(attendanceDevices)
          .values({
            tenantId,
            employeeId: own.id,
            deviceIdHash: body.deviceIdHash,
            label: body.label,
            boundAt: now,
          })
          .returning()
          .catch((error: unknown) => {
            if (
              uniqueViolation(error)?.constraint ===
              "attendance_devices_active_employee_key"
            )
              throw conflict(
                "DEVICE_ALREADY_BOUND",
                "Sudah ada perangkat terikat; minta HR mereset perangkat lama.",
              );
            throw error;
          });
    if (!saved) throw new Error("Attendance device save returned no row");
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: own.homeOutletId,
        action: "hris.attendance.device_bound",
        objectType: ATTENDANCE_DEVICE_OBJECT_TYPE,
        objectId: saved.id,
        after: { status: saved.status },
      }),
      DEVICE_AUDIT_SAFE_FIELDS,
    );
    return toAttendanceDevice(saved);
  });
}

/** GET /api/hris/attendance/devices — manage reach by home outlet, plus the caller's own. */
export async function listAttendanceDevices(
  context: ScopedTenantContext,
  actorUserId: string,
  query: ListDevicesQuery,
  now = new Date(),
): Promise<Page<AttendanceDevice>> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const visible: SQL[] = [];
    const manage = access.reach(ATTENDANCE_MANAGE);
    if (manage)
      visible.push(
        manage.kind === "tenant"
          ? sql`true`
          : inArray(employees.homeOutletId, [...manage.outletIds]),
      );
    const own = access.own;
    if (
      own !== null &&
      access.snapshot.permissions.includes(HRIS_ATTENDANCE_CLOCK_CODE)
    )
      visible.push(eq(attendanceDevices.employeeId, own.id));
    if (visible.length === 0) throw forbidden();

    const filters: SQL[] = [
      eq(attendanceDevices.tenantId, context.tenant.tenantId),
      or(...visible)!,
    ];
    if (query.employeeId)
      filters.push(eq(attendanceDevices.employeeId, query.employeeId));
    if (query.status) filters.push(eq(attendanceDevices.status, query.status));
    if (query.cursor) {
      const [boundAt, id] = cursorPair(query.cursor);
      const at = new Date(boundAt);
      if (Number.isNaN(at.getTime())) throw validation("Check the cursor.");
      filters.push(
        or(
          lt(attendanceDevices.boundAt, at),
          and(eq(attendanceDevices.boundAt, at), gt(attendanceDevices.id, id)),
        )!,
      );
    }
    const rows = await tx
      .select({ device: attendanceDevices })
      .from(attendanceDevices)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, attendanceDevices.tenantId),
          eq(employees.id, attendanceDevices.employeeId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(attendanceDevices.boundAt), asc(attendanceDevices.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit).map((row) => row.device);
    const last = page.at(-1);
    return {
      data: page.map(toAttendanceDevice),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.boundAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/**
 * POST /api/hris/attendance/devices/:deviceId/revoke — HR reset. Needs
 * `hr.attendance.manage` at the employee's home outlet (another outlet
 * answers 404). Revoking a revoked device returns it unchanged.
 */
export async function revokeAttendanceDevice(
  context: ScopedTenantContext,
  actorUserId: string,
  deviceId: string,
  body: RevokeDeviceBody,
  now = new Date(),
): Promise<AttendanceDevice> {
  return withTenant(db, context, async (tx) => {
    const access = await loadHrisAccess(tx, context, actorUserId, now);
    const tenantId = context.tenant.tenantId;
    const [found] = await tx
      .select({
        device: attendanceDevices,
        homeOutletId: employees.homeOutletId,
      })
      .from(attendanceDevices)
      .innerJoin(
        employees,
        and(
          eq(employees.tenantId, attendanceDevices.tenantId),
          eq(employees.id, attendanceDevices.employeeId),
        ),
      )
      .where(
        and(
          eq(attendanceDevices.tenantId, tenantId),
          eq(attendanceDevices.id, deviceId),
        ),
      )
      .for("update", { of: attendanceDevices })
      .limit(1);
    if (
      !found ||
      !reachIncludes(access.reach(ATTENDANCE_MANAGE), found.homeOutletId)
    )
      throw notFound("Perangkat absensi");
    if (found.device.status === "revoked")
      return toAttendanceDevice(found.device);
    const [revoked] = await tx
      .update(attendanceDevices)
      .set({
        status: "revoked",
        revokedAt: now,
        revokedBy: access.actorUserId,
      })
      .where(
        and(
          eq(attendanceDevices.tenantId, tenantId),
          eq(attendanceDevices.id, deviceId),
        ),
      )
      .returning();
    if (!revoked) throw new Error("Attendance device revoke returned no row");
    await recordAudit(
      tx,
      context,
      hrisAuditEntry(context, access.actorUserId, now, {
        outletId: found.homeOutletId,
        action: "hris.attendance.device_revoked",
        objectType: ATTENDANCE_DEVICE_OBJECT_TYPE,
        objectId: revoked.id,
        after: {
          status: "revoked",
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        },
      }),
      DEVICE_AUDIT_SAFE_FIELDS,
    );
    return toAttendanceDevice(revoked);
  });
}
