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
  attendanceDeviceIdSchema,
  attendanceDutyMealIdSchema,
  leaveRequestIdSchema,
  leaveTypeIdSchema,
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
  /** Clock at the outlet's own device, recorded by the edge node (design hris-edge-replication 6.2). */
  "outlet_device",
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
  /** Server-side token check; required (true) for `rotating_qr`. */
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
    // Fail closed: a QR clock-in without a positive token check is invalid.
    if (input.qrValid !== true) {
      reasons.push("qr_token_invalid");
      rejected = true;
    }
  }
  // Missing coordinates on a geofenced method count as outside the fence, so
  // switching GPS off cannot bypass the configured action.
  if (
    input.method === "selfie_geo" &&
    (input.geoDistanceM === null ||
      input.geoDistanceM > input.policy.geofenceRadiusM)
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
 * cut-off. The caller passes the outlet time zone (core `localDateOf`: the
 * roster is a wall-clock schedule, so no Q39 business-day cutoff applies);
 * this helper only names the rule so every screen agrees on it.
 */
export const attendanceBusinessDateSchema = businessDateSchema;

// ---- Device binding, policy, sampling review, duty meals (WS-10) ----------
// Additive contracts: nothing above changes. The raw device hash is never
// returned (only the label), so a leaked list cannot be replayed as a binding.

export const attendanceDeviceStatusSchema = z.enum(["active", "revoked"]);
export type AttendanceDeviceStatus = z.infer<
  typeof attendanceDeviceStatusSchema
>;

/** F25 "pengikatan perangkat": one active device per employee. */
export const attendanceDeviceSchema = z
  .strictObject({
    id: attendanceDeviceIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    label: z.string().min(1).max(100),
    status: attendanceDeviceStatusSchema,
    boundAt: isoDateTimeSchema,
    revokedAt: isoDateTimeSchema.nullable(),
    revokedBy: uuidSchema.nullable(),
  })
  .superRefine((device, ctx) => {
    if (device.status === "active" && device.revokedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "An active device has no revocation time",
      });
    if (device.status === "revoked" && device.revokedAt === null)
      ctx.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "A revoked device needs a revocation time",
      });
  });
export type AttendanceDevice = z.infer<typeof attendanceDeviceSchema>;

/**
 * Supervisor sampling configuration (F25): flagged logs always enter the
 * queue when `flaggedAlways`; a deterministic share `rate` of the other valid
 * logs is sampled on top.
 */
export const attendanceSamplingConfigSchema = z.strictObject({
  rate: z.number().min(0).max(1),
  flaggedAlways: z.boolean(),
  minPerSupervisorPerWeek: z.number().int().min(0).max(1_000),
});
export type AttendanceSamplingConfig = z.infer<
  typeof attendanceSamplingConfigSchema
>;

/**
 * Policy as seen for one outlet. `outletId` null is the tenant default; an
 * outlet row overrides it, and `inherited` says the value shown is the tenant
 * default because the outlet has no override.
 */
export const attendancePolicyViewSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema.nullable(),
  inherited: z.boolean(),
  policy: attendancePolicySchema,
  sampling: attendanceSamplingConfigSchema,
  updatedAt: isoDateTimeSchema,
});
export type AttendancePolicyView = z.infer<typeof attendancePolicyViewSchema>;

/**
 * The part of the effective policy a staff member sees on the clock-in screen
 * (GET /api/hris/me/attendance-policy). No retention days, sampling or ids.
 */
export const myAttendancePolicySchema = attendancePolicySchema.omit({
  selfieRetentionDays: true,
});
export type MyAttendancePolicy = z.infer<typeof myAttendancePolicySchema>;

/**
 * Flag reasons the server may attach to a stored log. A superset of
 * `attendanceFlagReasonSchema`, kept separate so existing exhaustive
 * consumers of the older enum stay valid.
 */
export const attendanceStoredFlagReasonSchema = z.enum([
  ...attendanceFlagReasonSchema.options,
  "offline_time_skew",
  "offline_unverified",
  "edge_roster_stale",
  "employee_inactive",
  "selfie_unlinked",
  "leave_approved",
]);
export type AttendanceStoredFlagReason = z.infer<
  typeof attendanceStoredFlagReasonSchema
>;

export const attendanceReviewStatusSchema = z.enum([
  "none",
  "pending",
  "accepted",
  "rejected",
]);
export type AttendanceReviewStatus = z.infer<
  typeof attendanceReviewStatusSchema
>;

export const attendanceReviewSourceSchema = z.enum(["flagged", "sampled"]);
export type AttendanceReviewSource = z.infer<
  typeof attendanceReviewSourceSchema
>;

/**
 * `keep_leave` / `cancel_leave` decide a clock-in on a day of approved leave
 * (flag reason `leave_approved`): keep the leave (the day stays paid as leave)
 * or cancel it (the day is paid as worked). They are not validity transitions
 * of `transitionAttendanceValidity`.
 */
export const attendanceReviewActionSchema = z.enum([
  "flag",
  "accept",
  "reject",
  "keep_leave",
  "cancel_leave",
]);

/** What made a log a leave case. */
export const attendanceCaseKindSchema = z.enum([
  "clock_in_on_leave",
  "leave_approved_later",
  "manual_correction",
]);
export type AttendanceCaseKind = z.infer<typeof attendanceCaseKindSchema>;

/**
 * The leave behind a leave case, copied when HR first sees the case: it keeps
 * naming the original leave and period after a cancel splits or shrinks it.
 */
export const attendanceLeaveSnapshotSchema = z.strictObject({
  leaveRequestId: leaveRequestIdSchema,
  leaveTypeId: leaveTypeIdSchema,
  leaveTypeName: z.string().min(1).max(100),
  startDate: businessDateSchema,
  endDate: businessDateSchema,
});
export type AttendanceLeaveSnapshot = z.infer<
  typeof attendanceLeaveSnapshotSchema
>;

/** One entry of the supervisor review queue. */
export const attendanceReviewItemSchema = z.strictObject({
  log: attendanceLogSchema,
  source: attendanceReviewSourceSchema,
  flagReasons: z.array(attendanceStoredFlagReasonSchema).max(10),
  reviewStatus: attendanceReviewStatusSchema,
  reviewedBy: uuidSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  /** Full name of the log's employee. */
  employeeName: z.string().max(200),
  /** Outlet-local calendar day of the log. */
  businessDate: businessDateSchema,
  /** The employee's latest clock-out of that business date; null while none. */
  clockOutAt: isoDateTimeSchema.nullable(),
  /** Set for a leave case, null otherwise. */
  caseKind: attendanceCaseKindSchema.nullable(),
  /** hr.attendance.manage here and hr.leave.approve at the leave's outlet, still undecided. */
  canCancelLeave: z.boolean(),
  /** Null when the log is no leave case. */
  leave: attendanceLeaveSnapshotSchema.nullable(),
  /** The action that decided the item; null while pending. */
  decisionAction: attendanceReviewActionSchema.nullable(),
});
export type AttendanceReviewItem = z.infer<typeof attendanceReviewItemSchema>;

/** Duty meal ("makan dinas") taken during a shift; stock deduction is a separate consumer. */
export const attendanceDutyMealSchema = z.strictObject({
  id: attendanceDutyMealIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  employeeId: employeeIdSchema,
  shiftAssignmentId: shiftAssignmentIdSchema.nullable(),
  businessDate: attendanceBusinessDateSchema,
  mealCount: z.number().int().min(1).max(10),
  recordedBy: uuidSchema,
  recordedAt: isoDateTimeSchema,
});
export type AttendanceDutyMeal = z.infer<typeof attendanceDutyMealSchema>;

/** Result of rotating an outlet QR secret; the old display stops validating. */
export const attendanceQrRotationSchema = z.strictObject({
  outletId: outletIdSchema,
  rotatedAt: isoDateTimeSchema,
});
export type AttendanceQrRotation = z.infer<typeof attendanceQrRotationSchema>;
