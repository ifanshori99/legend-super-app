// Attendance (PRD v1.7 §3 Kelompok D 27 "Absensi", §6 H `attendance_logs`;
// F25, HR-02).
//
// - `attendance_logs.id` is a ULID (PRD §6 H): attendance is a time-ordered
//   operational event that an outlet edge node records offline and syncs later
//   (F25 "Offline"), so one device's stream stays ordered (§5).
// - The rotating outlet QR changes every 30 seconds (F25); `AttendanceQrToken`
//   carries its validity window.
// - HR-02: a clock-in outside the geofence or from an unbound device is
//   rejected or flagged according to `AttendancePolicy`; required selfie
//   missing is always rejected. Supervisors review flagged selfies by sampling
//   (F25), never by face recognition.
// - Selfie bytes live in a private bucket; the wire carries only a short-lived
//   signed `photoUrl`, never the storage key.

import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  isoDateTimeSchema,
  businessDateSchema,
  CoreError,
} from "../core/index.ts";
import {
  employeeIdSchema,
  attendanceLogIdSchema,
  attendanceCorrectionIdSchema,
  shiftAssignmentIdSchema,
} from "./ids.ts";

export const attendanceTypeSchema = z.enum([
  "in",
  "out",
  "break_start",
  "break_end",
]);
export type AttendanceType = z.infer<typeof attendanceTypeSchema>;

export const attendanceMethodSchema = z.enum([
  "selfie_geo",
  "rotating_qr",
  "manual_correction",
]);
export type AttendanceMethod = z.infer<typeof attendanceMethodSchema>;

export const attendanceValiditySchema = z.enum([
  "valid",
  "flagged",
  "rejected",
]);
export type AttendanceValidity = z.infer<typeof attendanceValiditySchema>;

const deviceHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Device hashes are lowercase SHA-256 hex");

/** PRD §6 H `attendance_logs` row. */
export const attendanceLogSchema = z.strictObject({
  id: attendanceLogIdSchema,
  tenantId: tenantIdSchema,
  employeeId: employeeIdSchema,
  outletId: outletIdSchema,
  type: attendanceTypeSchema,
  method: attendanceMethodSchema,
  occurredAt: isoDateTimeSchema,
  /** Metres from the outlet point; null for QR or manual correction. */
  geoDistanceM: z.number().int().nonnegative().safe().nullable(),
  /** Per-device binding hash (F25 "pengikatan perangkat"), never the device id. */
  deviceIdHash: deviceHash.nullable(),
  /** Signed, short-lived URL of the private selfie; null when none is attached. */
  photoUrl: z.string().min(1).max(2048).nullable(),
  validity: attendanceValiditySchema,
  shiftAssignmentId: shiftAssignmentIdSchema.nullable(),
});
export type AttendanceLog = z.infer<typeof attendanceLogSchema>;

/**
 * Attendance configuration. Every value is tenant configuration (PRD F25
 * "sesuai kebijakan"); nothing here is a coded assumption.
 */
export const attendancePolicySchema = z.strictObject({
  geofenceRadiusM: z.number().int().min(10).max(5_000),
  outsideGeofenceAction: z.enum(["reject", "flag"]),
  unboundDeviceAction: z.enum(["reject", "flag"]),
  requireSelfie: z.boolean(),
  requireDeviceBinding: z.boolean(),
  allowRotatingQr: z.boolean(),
  /** PRD `attendance_logs.photo_key` "dihapus sesuai masa simpan". */
  selfieRetentionDays: z.number().int().min(0).max(365),
});
export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;

/** QR rotation period fixed by F25: the outlet screen refreshes every 30 s. */
export const ATTENDANCE_QR_ROTATION_SECONDS = 30;

/** Nonce an outlet display shows for 30 seconds (F25 "QR Outlet Berotasi"). */
export const attendanceQrTokenSchema = z
  .strictObject({
    outletId: outletIdSchema,
    token: z.string().min(16).max(128),
    issuedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    rotationSeconds: z.literal(ATTENDANCE_QR_ROTATION_SECONDS),
  })
  .superRefine((qr, ctx) => {
    if (
      Date.parse(qr.expiresAt) - Date.parse(qr.issuedAt) !==
      ATTENDANCE_QR_ROTATION_SECONDS * 1_000
    )
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "The QR token must live exactly 30 seconds",
      });
  });
export type AttendanceQrToken = z.infer<typeof attendanceQrTokenSchema>;

/** True while the printed QR is still the one on the outlet screen. */
export function isAttendanceQrValid(
  qr: Pick<AttendanceQrToken, "issuedAt" | "expiresAt">,
  now: Date,
): boolean {
  const time = now.getTime();
  return Date.parse(qr.issuedAt) <= time && time <= Date.parse(qr.expiresAt);
}

/** Reasons an attendance submission is flagged or rejected (HR-02). */
export const attendanceFlagReasonSchema = z.enum([
  "outside_geofence",
  "device_not_bound",
  "selfie_missing",
  "rotating_qr_disabled",
  "qr_token_invalid",
]);
export type AttendanceFlagReason = z.infer<typeof attendanceFlagReasonSchema>;

export type AttendanceDecision = {
  readonly validity: AttendanceValidity;
  readonly reasons: readonly AttendanceFlagReason[];
};

/**
 * HR-02: decide the validity of a clock-in from the tenant policy. Selfie
 * missing (when required) and a disabled QR method are hard rejections;
 * geofence and device binding follow the configured action.
 */
export function evaluateAttendanceSubmission(input: {
  policy: AttendancePolicy;
  method: AttendanceMethod;
  geoDistanceM: number | null;
  deviceBound: boolean;
  selfieProvided: boolean;
  qrValid?: boolean;
}): AttendanceDecision {
  const reasons: AttendanceFlagReason[] = [];
  let rejected = false;
  if (input.policy.requireSelfie && !input.selfieProvided) {
    reasons.push("selfie_missing");
    rejected = true;
  }
  if (input.method === "rotating_qr") {
    if (!input.policy.allowRotatingQr) {
      reasons.push("rotating_qr_disabled");
      rejected = true;
    }
    if (input.qrValid === false) {
      reasons.push("qr_token_invalid");
      rejected = true;
    }
  }
  if (
    input.method === "selfie_geo" &&
    input.geoDistanceM !== null &&
    input.geoDistanceM > input.policy.geofenceRadiusM
  ) {
    reasons.push("outside_geofence");
    if (input.policy.outsideGeofenceAction === "reject") rejected = true;
  }
  if (input.policy.requireDeviceBinding && !input.deviceBound) {
    reasons.push("device_not_bound");
    if (input.policy.unboundDeviceAction === "reject") rejected = true;
  }
  if (rejected) return { validity: "rejected", reasons };
  if (reasons.length > 0) return { validity: "flagged", reasons };
  return { validity: "valid", reasons };
}

const validityTransitions: Partial<
  Record<
    AttendanceValidity,
    Partial<Record<"flag" | "accept" | "reject", AttendanceValidity>>
  >
> = {
  valid: { flag: "flagged", reject: "rejected" },
  flagged: { accept: "valid", reject: "rejected" },
};
export type AttendanceReviewAction = "flag" | "accept" | "reject";

/**
 * Supervisor sampling review (F25): accept a flagged log, flag a valid one
 * (late evidence), or reject either. A rejected log is terminal.
 */
export function transitionAttendanceValidity(
  validity: AttendanceValidity,
  action: AttendanceReviewAction,
): AttendanceValidity {
  const next = validityTransitions[validity]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi validitas absensi tidak valid: ${validity} → ${action}.`,
    );
  return next;
}

export const attendanceCorrectionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);
export type AttendanceCorrectionStatus = z.infer<
  typeof attendanceCorrectionStatusSchema
>;

/**
 * PRD F25 "Koreksi Absensi": the employee proposes a corrected log with a
 * reason and the supervisor decides. `attendanceLogId` is null when the log is
 * missing entirely.
 */
export const attendanceCorrectionSchema = z
  .strictObject({
    id: attendanceCorrectionIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    employeeId: employeeIdSchema,
    attendanceLogId: attendanceLogIdSchema.nullable(),
    requestedType: attendanceTypeSchema,
    requestedOccurredAt: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
    status: attendanceCorrectionStatusSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: uuidSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((correction, ctx) => {
    if ((correction.decidedBy === null) !== (correction.decidedAt === null))
      ctx.addIssue({
        code: "custom",
        message: "A correction decision needs both actor and time",
      });
    if (correction.status !== "pending" && correction.decidedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A decided correction needs a decision time",
      });
    if (correction.status === "pending" && correction.decidedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A pending correction has no decision time",
      });
  });
export type AttendanceCorrection = z.infer<typeof attendanceCorrectionSchema>;

const correctionTransitions: Partial<
  Record<
    AttendanceCorrectionStatus,
    Partial<Record<"approve" | "reject", AttendanceCorrectionStatus>>
  >
> = {
  pending: { approve: "approved", reject: "rejected" },
};
export type AttendanceCorrectionAction = "approve" | "reject";

/** Correction request lifecycle; a decision is final. */
export function transitionAttendanceCorrection(
  status: AttendanceCorrectionStatus,
  action: AttendanceCorrectionAction,
): AttendanceCorrectionStatus {
  const next = correctionTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi koreksi absensi tidak valid: ${status} → ${action}.`,
    );
  return next;
}

/**
 * The business date an attendance log belongs to, for rosters and payroll
 * cut-off. The caller passes the outlet time zone (core `businessDateOf`); this
 * helper only names the rule so every screen agrees on it.
 */
export const attendanceBusinessDateSchema = businessDateSchema;
