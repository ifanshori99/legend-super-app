// HRIS endpoint contracts (PRD v1.7 §3 "Kontrak Bersama": contract first, FE and
// BE in parallel). One object per route; the typed client, FE mock mode and the
// API route validation all read these. Bodies are `clientInputSchema`, so a
// client-supplied tenant id is rejected (TEN-02) and every key is strict.
//
// Every list uses cursor pagination (docs/plan/contracts.md D-CORE-5). The PII
// endpoint is separate from the employee endpoint so the list/detail screens
// need no PII permission; HR-03 is enforced on that one route.

import {
  z,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  outletIdSchema,
  outletRefSchema,
  isoDateTimeSchema,
  businessDateSchema,
  uuidSchema,
} from "../core/index.ts";
import { taxSchemeSchema } from "./payroll/components.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  employeeIdSchema,
  attendanceCorrectionIdSchema,
  attendanceDeviceIdSchema,
  attendanceLogIdSchema,
  orgUnitIdSchema,
  positionIdSchema,
  employmentContractIdSchema,
  leaveTypeIdSchema,
  shiftAssignmentIdSchema,
  shiftSwapRequestIdSchema,
  shiftTemplateIdSchema,
  leaveRequestIdSchema,
  overtimeRequestIdSchema,
  overtimeFormulaIdSchema,
  holidayIdSchema,
  kpiDefinitionIdSchema,
  kpiReviewIdSchema,
  checklistTemplateIdSchema,
  checklistTaskIdSchema,
  offboardingIdSchema,
  sopDocumentIdSchema,
  trainingIdSchema,
  announcementIdSchema,
  stationIdSchema,
} from "./ids.ts";
import {
  employeeSchema,
  employeeProfileSchema,
  employeeShape,
  employeeDocumentTypeSchema,
  employmentTypeSchema,
  employeePiiSchema,
  employeeDocumentSchema,
  employmentContractSchema,
  employmentContractStatusSchema,
  orgUnitSchema,
  positionSchema,
  positionGradeSchema,
  employeeStatusSchema,
  updateEmployeePiiInputSchema,
  changeEmployeeManagerInputSchema,
} from "./organization.ts";
import {
  checklistTaskActionInputSchema,
  checklistTaskActionSchema,
  checklistTaskSchema,
  checklistTemplateSchema,
  checklistKindSchema,
  checklistTaskStatusSchema,
  createChecklistTemplateInputSchema,
  updateChecklistTemplateInputSchema,
} from "./checklists.ts";
import {
  cancelOffboardingInputSchema,
  createOffboardingInputSchema,
  finalSettlementSummarySchema,
  offboardingSchema,
  updateOffboardingInputSchema,
  workCertificateSchema,
} from "./lifecycle.ts";
import {
  attendanceCorrectionSchema,
  attendanceCorrectionStatusSchema,
  attendanceDeviceSchema,
  attendanceDeviceStatusSchema,
  attendanceDutyMealSchema,
  attendancePolicySchema,
  attendancePolicyViewSchema,
  attendanceQrRotationSchema,
  myAttendancePolicySchema,
  attendanceReviewActionSchema,
  attendanceReviewItemSchema,
  attendanceReviewStatusSchema,
  attendanceStoredFlagReasonSchema,
  attendanceSamplingConfigSchema,
  attendanceLogSchema,
  attendanceMethodSchema,
  attendanceQrTokenSchema,
  attendanceTypeSchema,
} from "./attendance.ts";
import {
  refineShiftCompliancePolicyLimits,
  rosterPublicationSchema,
  rosterViewSchema,
  shiftAssignmentSchema,
  shiftCompliancePolicyBaseSchema,
  shiftCompliancePolicyViewSchema,
  shiftSwapAssignmentSchema,
  shiftSwapRequestSchema,
  shiftSwapStatusSchema,
  shiftTemplateSchema,
  shiftTemplateSegmentsSchema,
} from "./scheduling.ts";
import {
  holidaySchema,
  holidayTypeSchema,
  leaveAccrualRunResultSchema,
  leaveBalanceSchema,
  leaveRequestSchema,
  leaveRequestStatusSchema,
  leaveSettingsInputSchema,
  leaveSettingsSchema,
  leaveTypeInputSchema,
  leaveTypeSchema,
  overtimeFormulaSchema,
  overtimeRequestSchema,
  overtimeRequestStatusSchema,
  overtimeRestDayTypeSchema,
} from "./leave.ts";
import {
  overtimeDayTypeSchema,
  overtimeParametersSchema,
} from "./payroll/statutory.ts";
import {
  announcementReceiptSchema,
  announcementSchema,
  createKpiDefinitionInputSchema,
  createKpiReviewInputSchema,
  kpiDefinitionSchema,
  kpiReviewSchema,
  kpiSourceSchema,
  updateKpiDefinitionInputSchema,
  updateKpiScoresInputSchema,
  sopAcknowledgementSchema,
  sopDocumentSchema,
  trainingCompletionSchema,
  trainingSchema,
} from "./performance.ts";

const employeeIdParams = z.strictObject({ employeeId: employeeIdSchema });

// ---- Employees, organisation, contracts, documents -----------------------

export const listEmployees = defineEndpoint({
  method: "GET",
  path: "/api/hris/employees",
  query: cursorPageQuerySchema.extend({
    status: employeeStatusSchema.optional(),
    outletId: outletIdSchema.optional(),
    positionId: positionIdSchema.optional(),
  }),
  response: cursorPageSchema(employeeSchema),
});

/** HR-04: seat quota and the target outlet are checked by the server. */
export const createEmployee = defineEndpoint({
  method: "POST",
  path: "/api/hris/employees",
  body: clientInputSchema({
    userId: employeeShape.userId,
    legalEntityId: employeeShape.legalEntityId,
    employeeNo: employeeShape.employeeNo,
    fullName: employeeShape.fullName,
    positionId: employeeShape.positionId,
    orgUnitId: employeeShape.orgUnitId,
    managerId: employeeShape.managerId,
    homeOutletId: employeeShape.homeOutletId,
    employmentType: employeeShape.employmentType,
    joinDate: employeeShape.joinDate,
    endDate: employeeShape.endDate,
    ptkpStatus: employeeShape.ptkpStatus,
    status: z.enum(["onboarding", "active"]),
    pii: updateEmployeePiiInputSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((employee, ctx) => {
    if (employee.endDate !== null && employee.endDate < employee.joinDate)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot precede join date",
      });
  }),
  response: dataResponseSchema(employeeSchema),
});

export const getEmployee = defineEndpoint({
  method: "GET",
  path: "/api/hris/employees/:employeeId",
  params: employeeIdParams,
  response: dataResponseSchema(employeeProfileSchema),
});

/** HR-03: the only route that returns (masked) employee PII. */
export const getEmployeePii = defineEndpoint({
  method: "GET",
  path: "/api/hris/employees/:employeeId/pii",
  params: employeeIdParams,
  response: dataResponseSchema(employeePiiSchema),
});

export const updateEmployeePii = defineEndpoint({
  method: "PUT",
  path: "/api/hris/employees/:employeeId/pii",
  params: employeeIdParams,
  body: updateEmployeePiiInputSchema.extend({
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(employeePiiSchema),
});

export const changeEmployeeManagerEndpoint = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/employees/:employeeId/manager",
  params: employeeIdParams,
  body: changeEmployeeManagerInputSchema.extend({
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(employeeSchema),
});

/**
 * Sets the employer legal entity of an employee that has none (legend-d5n4j).
 * Once set it cannot change here: a different value is 409
 * EMPLOYEE_LEGAL_ENTITY_ALREADY_SET, the same value is a no-op.
 */
export const setEmployeeLegalEntityEndpoint = defineEndpoint({
  method: "PUT",
  path: "/api/hris/employees/:employeeId/legal-entity",
  params: employeeIdParams,
  body: z.strictObject({
    legalEntityId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(employeeSchema),
});

export const listOrgUnits = defineEndpoint({
  method: "GET",
  path: "/api/hris/org-units",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(orgUnitSchema),
});

export const createOrgUnit = defineEndpoint({
  method: "POST",
  path: "/api/hris/org-units",
  body: clientInputSchema({
    parentId: orgUnitSchema.shape.parentId,
    code: orgUnitSchema.shape.code,
    name: orgUnitSchema.shape.name,
    isActive: z.boolean().optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(orgUnitSchema),
});

export const listPositionGrades = defineEndpoint({
  method: "GET",
  path: "/api/hris/position-grades",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(positionGradeSchema),
});

export const createPositionGrade = defineEndpoint({
  method: "POST",
  path: "/api/hris/position-grades",
  body: clientInputSchema({
    code: positionGradeSchema.shape.code,
    name: positionGradeSchema.shape.name,
    level: positionGradeSchema.shape.level,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(positionGradeSchema),
});

export const listPositions = defineEndpoint({
  method: "GET",
  path: "/api/hris/positions",
  query: cursorPageQuerySchema.extend({
    orgUnitId: orgUnitIdSchema.optional(),
  }),
  response: cursorPageSchema(positionSchema),
});

export const createPosition = defineEndpoint({
  method: "POST",
  path: "/api/hris/positions",
  body: clientInputSchema({
    name: positionSchema.shape.name,
    gradeId: positionSchema.shape.gradeId,
    orgUnitId: positionSchema.shape.orgUnitId,
    serviceChargePoints: positionSchema.shape.serviceChargePoints,
    isActive: z.boolean().optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(positionSchema),
});

export const createEmploymentContract = defineEndpoint({
  method: "POST",
  path: "/api/hris/employment-contracts",
  body: clientInputSchema({
    employeeId: employeeIdSchema,
    type: employmentTypeSchema,
    taxScheme: taxSchemeSchema,
    startDate: businessDateSchema,
    endDate: businessDateSchema.nullable(),
    renewedFromId: employmentContractIdSchema.nullable(),
    salarySnapshotIdr: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    fileObjectId: uuidSchema.nullable(),
    reminderDaysBefore: z.number().int().min(1).max(180),
    status: employmentContractStatusSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((contract, ctx) => {
    if (contract.endDate !== null && contract.endDate < contract.startDate)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "Contract end date cannot precede its start date",
      });
    if (contract.type === "pkwt" && contract.endDate === null)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "A PKWT contract requires an end date",
      });
    if (contract.type === "pkwtt" && contract.endDate !== null)
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "A PKWTT contract is permanent and has no end date",
      });
  }),
  response: dataResponseSchema(employmentContractSchema),
});

export const createEmployeeDocument = defineEndpoint({
  method: "POST",
  path: "/api/hris/employees/:employeeId/documents",
  params: employeeIdParams,
  body: clientInputSchema({
    type: employeeDocumentTypeSchema,
    storageObjectId: uuidSchema,
    expiresOn: businessDateSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(employeeDocumentSchema),
});

export const listEmploymentContracts = defineEndpoint({
  method: "GET",
  path: "/api/hris/employment-contracts",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    status: employmentContractStatusSchema.optional(),
    /** Contracts ending on or before this date (expiry reminder screen). */
    expiringBefore: businessDateSchema.optional(),
  }),
  response: cursorPageSchema(employmentContractSchema),
});

export const getEmploymentContract = defineEndpoint({
  method: "GET",
  path: "/api/hris/employment-contracts/:contractId",
  params: z.strictObject({ contractId: employmentContractIdSchema }),
  response: dataResponseSchema(employmentContractSchema),
});

// ---- Employee PWA (self-scoped) ------------------------------------------

/**
 * The caller's own employee row and the outlet the PWA acts for. HR-01: no
 * employee id in the input — the API resolves it from the signed-in session,
 * so one employee can never read another's profile through this route. The
 * outlet comes along because the Beranda names "today" in the outlet's time
 * zone (core `localDateOf`), exactly like the attendance service.
 *
 * Added by the employee PWA bead (legend-nv3y); the HRIS API bead wires it.
 */
export const myHrisProfileSchema = z.strictObject({
  employee: employeeSchema,
  outlet: outletRefSchema,
});
export type MyHrisProfile = z.infer<typeof myHrisProfileSchema>;

export const getMyHrisProfile = defineEndpoint({
  method: "GET",
  path: "/api/hris/me",
  response: dataResponseSchema(myHrisProfileSchema),
});

export const listEmployeeDocuments = defineEndpoint({
  method: "GET",
  path: "/api/hris/employees/:employeeId/documents",
  params: employeeIdParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(employeeDocumentSchema),
});

// ---- Onboarding / offboarding -------------------------------------------

export const listChecklistTasks = defineEndpoint({
  method: "GET",
  path: "/api/hris/employees/:employeeId/checklist-tasks",
  params: employeeIdParams,
  query: cursorPageQuerySchema.extend({
    kind: checklistKindSchema.optional(),
    status: checklistTaskStatusSchema.optional(),
  }),
  response: cursorPageSchema(checklistTaskSchema),
});

export const listChecklistTemplates = defineEndpoint({
  method: "GET",
  path: "/api/hris/checklist-templates",
  query: cursorPageQuerySchema.extend({
    kind: checklistKindSchema.optional(),
    positionId: positionIdSchema.optional(),
    isActive: z.enum(["true", "false"]).optional(),
  }),
  response: cursorPageSchema(checklistTemplateSchema),
});

/** Writing a template needs tenant-wide reach (a template is not per outlet). */
export const createChecklistTemplate = defineEndpoint({
  method: "POST",
  path: "/api/hris/checklist-templates",
  body: createChecklistTemplateInputSchema,
  response: dataResponseSchema(checklistTemplateSchema),
});

export const updateChecklistTemplate = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/checklist-templates/:templateId",
  params: z.strictObject({ templateId: checklistTemplateIdSchema }),
  body: updateChecklistTemplateInputSchema,
  response: dataResponseSchema(checklistTemplateSchema),
});

/**
 * Creates the onboarding tasks from the active template of the employee's
 * position (else the default one). A repeat call returns the existing tasks.
 */
export const startEmployeeOnboarding = defineEndpoint({
  method: "POST",
  path: "/api/hris/employees/:employeeId/onboarding",
  params: employeeIdParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(z.array(checklistTaskSchema)),
});

const checklistTaskIdParams = z.strictObject({ taskId: checklistTaskIdSchema });

export const actOnChecklistTask = defineEndpoint({
  method: "POST",
  path: "/api/hris/checklist-tasks/:taskId/actions",
  params: checklistTaskIdParams,
  body: checklistTaskActionInputSchema,
  response: dataResponseSchema(checklistTaskSchema),
});

export const listChecklistTaskActions = defineEndpoint({
  method: "GET",
  path: "/api/hris/checklist-tasks/:taskId/actions",
  params: checklistTaskIdParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(checklistTaskActionSchema),
});

const offboardingIdParams = z.strictObject({
  offboardingId: offboardingIdSchema,
});

export const createOffboarding = defineEndpoint({
  method: "POST",
  path: "/api/hris/employees/:employeeId/offboarding",
  params: employeeIdParams,
  body: createOffboardingInputSchema,
  response: dataResponseSchema(offboardingSchema),
});

export const getOffboarding = defineEndpoint({
  method: "GET",
  path: "/api/hris/offboardings/:offboardingId",
  params: offboardingIdParams,
  response: dataResponseSchema(offboardingSchema),
});

export const updateOffboarding = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/offboardings/:offboardingId",
  params: offboardingIdParams,
  body: updateOffboardingInputSchema,
  response: dataResponseSchema(offboardingSchema),
});

export const cancelOffboarding = defineEndpoint({
  method: "POST",
  path: "/api/hris/offboardings/:offboardingId/cancel",
  params: offboardingIdParams,
  body: cancelOffboardingInputSchema,
  response: dataResponseSchema(offboardingSchema),
});

/** Cuts access (roles, sessions, devices, PIN, future shifts); idempotent. */
export const revokeOffboardingAccess = defineEndpoint({
  method: "POST",
  path: "/api/hris/offboardings/:offboardingId/revoke-access",
  params: offboardingIdParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(offboardingSchema),
});

export const completeOffboarding = defineEndpoint({
  method: "POST",
  path: "/api/hris/offboardings/:offboardingId/complete",
  params: offboardingIdParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(offboardingSchema),
});

export const getOffboardingSettlement = defineEndpoint({
  method: "GET",
  path: "/api/hris/offboardings/:offboardingId/settlement",
  params: offboardingIdParams,
  response: dataResponseSchema(finalSettlementSummarySchema),
});

/** The first call assigns the certificate number; repeats return the same. */
export const getWorkCertificate = defineEndpoint({
  method: "GET",
  path: "/api/hris/offboardings/:offboardingId/work-certificate",
  params: offboardingIdParams,
  response: dataResponseSchema(workCertificateSchema),
});

/** Same data as `getWorkCertificate`, answered as `application/pdf` bytes. */
export const getWorkCertificatePdf = defineEndpoint({
  method: "GET",
  path: "/api/hris/offboardings/:offboardingId/work-certificate.pdf",
  params: offboardingIdParams,
});

// ---- Attendance ----------------------------------------------------------

export const clockAttendance = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/clock",
  body: clientInputSchema({
    type: attendanceTypeSchema,
    method: attendanceMethodSchema,
    /**
     * Device clock at capture. The server records its own receipt time as the
     * attendance time for online submissions and validates the QR window
     * against it; `occurredAt` is only trusted for an offline-queued
     * submission, which the service flags when it differs from receipt time.
     */
    occurredAt: isoDateTimeSchema,
    /** Raw coordinates; the server computes the distance and never returns them. */
    location: z
      .strictObject({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        accuracyM: z.number().nonnegative().max(5_000).nullable(),
      })
      .nullable(),
    deviceIdHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    /** Pre-signed upload reference for the selfie (private bucket). */
    photoUploadRef: z.string().min(1).max(200).nullable(),
    /** Scanned outlet QR nonce, when the method is `rotating_qr`. */
    qrToken: z.string().min(16).max(128).nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceLogSchema),
});

/**
 * Error codes of the outlet screen clock (legend-u7g9w), with their HTTP
 * status. The PIN proof codes (PIN_PROOF_INVALID 401, PIN_PROOF_USED 409,
 * PIN_DEVICE_THROTTLED 429) live with the identity errors.
 */
export const OUTLET_CLOCK_ERROR_CODES = {
  ATTENDANCE_NOT_ALLOWED: "ATTENDANCE_NOT_ALLOWED",
  SELFIE_NOT_FROM_PROOF: "SELFIE_NOT_FROM_PROOF",
  ATTENDANCE_METHOD_USE_OUTLET_CLOCK: "ATTENDANCE_METHOD_USE_OUTLET_CLOCK",
} as const;
export type OutletClockErrorCode = keyof typeof OUTLET_CLOCK_ERROR_CODES;

export const OUTLET_CLOCK_ERROR_STATUS = {
  ATTENDANCE_NOT_ALLOWED: 403,
  SELFIE_NOT_FROM_PROOF: 400,
  ATTENDANCE_METHOD_USE_OUTLET_CLOCK: 400,
} as const satisfies Record<OutletClockErrorCode, number>;

/**
 * The outlet attendance screen clocks a staff member who just proved their PIN.
 * No session: `X-Device-Token` names the registered device and `X-Pin-Proof`
 * the one-time proof from `POST /api/staff-pins/verify` (purpose
 * `attendance_clock`). The employee comes from the proof, never the body.
 * 201 for a new log, 200 when the idempotency key replays the proof holder's log.
 */
export const outletClockAttendance = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/outlet-clock",
  body: clientInputSchema({
    type: attendanceTypeSchema,
    occurredAt: isoDateTimeSchema,
    /** Selfie uploaded with the same proof (private bucket). */
    photoUploadRef: z.string().min(1).max(200).nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceLogSchema),
});

export const listAttendanceLogs = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/logs",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    outletId: outletIdSchema.optional(),
    businessDate: businessDateSchema.optional(),
  }),
  response: cursorPageSchema(attendanceLogSchema),
});

/** Outlet display polls this for the current 30-second QR (F25). */
export const getAttendanceQr = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/qr",
  query: z.strictObject({ outletId: outletIdSchema }),
  response: dataResponseSchema(attendanceQrTokenSchema),
});

export const requestAttendanceCorrection = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/corrections",
  body: clientInputSchema({
    outletId: outletIdSchema,
    // The log id is a ULID (PRD §6 H `attendance_logs.id`), not a UUID.
    attendanceLogId: attendanceLogIdSchema.nullable(),
    requestedType: attendanceTypeSchema,
    requestedOccurredAt: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
    /**
     * Optional guard (legend-2boxs): the employee the client believes it acts
     * for. The server rejects the request when it differs from the session
     * user's own employee id.
     */
    expectedEmployeeId: employeeIdSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceCorrectionSchema),
});

export const listAttendanceCorrections = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/corrections",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    status: attendanceCorrectionStatusSchema.optional(),
  }),
  response: cursorPageSchema(attendanceCorrectionSchema),
});

// Device binding, policy, sampling review, duty meals (WS-10). Additive.

const attendanceDeviceIdParams = z.strictObject({
  deviceId: attendanceDeviceIdSchema,
});
const attendanceLogIdParams = z.strictObject({ logId: attendanceLogIdSchema });
const attendanceCorrectionIdParams = z.strictObject({
  correctionId: attendanceCorrectionIdSchema,
});

/** The employee binds their own phone; the employee comes from the session. */
export const bindAttendanceDevice = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/devices/bind",
  body: clientInputSchema({
    deviceIdHash: z.string().regex(/^[0-9a-f]{64}$/),
    label: z.string().min(1).max(100),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceDeviceSchema),
});

/**
 * A supervisor or HR binds the phone for an employee in their reach
 * (legend-bf20): same rules as the employee's own bind (one active device).
 */
export const bindAttendanceDeviceBySupervisor = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/devices/bind-by-supervisor",
  body: clientInputSchema({
    employeeId: employeeIdSchema,
    deviceIdHash: z.string().regex(/^[0-9a-f]{64}$/),
    label: z.string().min(1).max(100),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceDeviceSchema),
});

export const listAttendanceDevices = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/devices",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    status: attendanceDeviceStatusSchema.optional(),
  }),
  response: cursorPageSchema(attendanceDeviceSchema),
});

/** HR reset (hr.attendance.manage); the employee can bind a new device after. */
export const revokeAttendanceDevice = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/devices/:deviceId/revoke",
  params: attendanceDeviceIdParams,
  body: clientInputSchema({
    reason: z.string().min(1).max(500).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceDeviceSchema),
});

/** Without `outletId`, the tenant default; with one, the outlet view. */
export const getAttendancePolicy = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/policy",
  query: z.strictObject({ outletId: outletIdSchema.optional() }),
  response: dataResponseSchema(attendancePolicyViewSchema),
});

/** The caller's own outlet policy, clock-in fields only (self.attendance.clock). */
export const getMyAttendancePolicy = defineEndpoint({
  method: "GET",
  path: "/api/hris/me/attendance-policy",
  response: dataResponseSchema(myAttendancePolicySchema),
});

/** `outletId` null writes the tenant default; otherwise an outlet override. */
export const updateAttendancePolicy = defineEndpoint({
  method: "PUT",
  path: "/api/hris/attendance/policy",
  body: clientInputSchema({
    outletId: outletIdSchema.nullable(),
    policy: attendancePolicySchema,
    sampling: attendanceSamplingConfigSchema,
  }),
  response: dataResponseSchema(attendancePolicyViewSchema),
});

/** Flagged logs plus the deterministic random sample (F25 supervisor review). */
export const listAttendanceReviewQueue = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/review-queue",
  query: cursorPageQuerySchema.extend({
    outletId: outletIdSchema.optional(),
    businessDate: businessDateSchema.optional(),
    reviewStatus: attendanceReviewStatusSchema.optional(),
    /** Only logs carrying this flag reason (server-side; scope unchanged). */
    flagReason: attendanceStoredFlagReasonSchema.optional(),
    /** Only this log (public ULID); scope unchanged. Any review status unless given. */
    logId: attendanceLogIdSchema.optional(),
  }),
  response: cursorPageSchema(attendanceReviewItemSchema),
});

export const decideAttendanceReview = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/logs/:logId/review",
  params: attendanceLogIdParams,
  body: clientInputSchema({
    action: attendanceReviewActionSchema,
    note: z.string().min(1).max(500).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceReviewItemSchema),
});

/** hr.attendance_correction.approve; approving creates a manual_correction log. */
export const decideAttendanceCorrection = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/corrections/:correctionId/decision",
  params: attendanceCorrectionIdParams,
  body: clientInputSchema({
    action: z.enum(["approve", "reject"]),
    note: z.string().min(1).max(500).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceCorrectionSchema),
});

export const recordAttendanceDutyMeal = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/duty-meals",
  body: clientInputSchema({
    outletId: outletIdSchema,
    employeeId: employeeIdSchema,
    shiftAssignmentId: shiftAssignmentIdSchema.nullable(),
    businessDate: businessDateSchema,
    mealCount: z.number().int().min(1).max(10),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceDutyMealSchema),
});

export const listAttendanceDutyMeals = defineEndpoint({
  method: "GET",
  path: "/api/hris/attendance/duty-meals",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    outletId: outletIdSchema.optional(),
    businessDate: businessDateSchema.optional(),
  }),
  response: cursorPageSchema(attendanceDutyMealSchema),
});

/** Manual rotation of the outlet QR secret; invalidates the current display. */
export const rotateAttendanceQrSecret = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/qr/rotate",
  body: clientInputSchema({
    outletId: outletIdSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(attendanceQrRotationSchema),
});

// ---- Roster, shifts, swaps ---------------------------------------------

const queryBooleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const listShiftTemplates = defineEndpoint({
  method: "GET",
  path: "/api/hris/shift-templates",
  query: cursorPageQuerySchema.extend({
    outletId: outletIdSchema.optional(),
    includeInactive: queryBooleanSchema.optional(),
  }),
  response: cursorPageSchema(shiftTemplateSchema),
});

export const createShiftTemplate = defineEndpoint({
  method: "POST",
  path: "/api/hris/shift-templates",
  body: clientInputSchema({
    outletId: outletIdSchema,
    name: shiftTemplateSchema.shape.name,
    segments: shiftTemplateSegmentsSchema,
    breakMinutes: shiftTemplateSchema.shape.breakMinutes,
    stationId: stationIdSchema.nullable(),
    positionId: positionIdSchema.nullable(),
  }),
  response: dataResponseSchema(shiftTemplateSchema),
});

export const updateShiftTemplate = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/shift-templates/:templateId",
  params: z.strictObject({ templateId: shiftTemplateIdSchema }),
  body: z
    .strictObject({
      name: shiftTemplateSchema.shape.name,
      segments: shiftTemplateSegmentsSchema,
      breakMinutes: shiftTemplateSchema.shape.breakMinutes,
      stationId: stationIdSchema.nullable(),
      positionId: positionIdSchema.nullable(),
      isActive: z.boolean(),
    })
    .partial()
    .refine((body) => Object.keys(body).length > 0, {
      message: "Provide at least one field to update",
    }),
  response: dataResponseSchema(shiftTemplateSchema),
});

export const getShiftCompliancePolicy = defineEndpoint({
  method: "GET",
  path: "/api/hris/shift-compliance-policy",
  query: z.strictObject({ outletId: outletIdSchema.optional() }),
  response: dataResponseSchema(shiftCompliancePolicyViewSchema),
});

export const updateShiftCompliancePolicy = defineEndpoint({
  method: "PUT",
  path: "/api/hris/shift-compliance-policy",
  body: shiftCompliancePolicyBaseSchema
    .omit({ tenantId: true })
    .superRefine(refineShiftCompliancePolicyLimits),
  response: dataResponseSchema(shiftCompliancePolicyViewSchema),
});

export const createShiftAssignment = defineEndpoint({
  method: "POST",
  path: "/api/hris/shifts",
  body: clientInputSchema({
    outletId: outletIdSchema,
    employeeId: employeeIdSchema,
    businessDate: businessDateSchema,
    shiftTemplateId: shiftTemplateIdSchema,
    stationId: stationIdSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(shiftAssignmentSchema),
});

export const updateShiftAssignment = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/shifts/:assignmentId",
  params: z.strictObject({ assignmentId: shiftAssignmentIdSchema }),
  body: z
    .strictObject({
      employeeId: employeeIdSchema,
      shiftTemplateId: shiftTemplateIdSchema,
      stationId: stationIdSchema.nullable(),
      businessDate: businessDateSchema,
    })
    .partial()
    .refine((body) => Object.keys(body).length > 0, {
      message: "Provide at least one field to update",
    }),
  response: dataResponseSchema(shiftAssignmentSchema),
});

export const cancelShiftAssignment = defineEndpoint({
  method: "POST",
  path: "/api/hris/shifts/:assignmentId/cancel",
  params: z.strictObject({ assignmentId: shiftAssignmentIdSchema }),
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(shiftAssignmentSchema),
});

export const copyRosterWeek = defineEndpoint({
  method: "POST",
  path: "/api/hris/rosters/copy",
  body: clientInputSchema({
    outletId: outletIdSchema,
    fromWeekStart: businessDateSchema,
    toWeekStart: businessDateSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(rosterViewSchema),
});

export const getRoster = defineEndpoint({
  method: "GET",
  path: "/api/hris/rosters",
  query: z.strictObject({
    outletId: outletIdSchema,
    weekStart: businessDateSchema,
  }),
  response: dataResponseSchema(rosterViewSchema),
});

export const listShiftAssignments = defineEndpoint({
  method: "GET",
  path: "/api/hris/shifts",
  query: cursorPageQuerySchema.extend({
    outletId: outletIdSchema.optional(),
    employeeId: employeeIdSchema.optional(),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  }),
  response: cursorPageSchema(shiftAssignmentSchema),
});

export const publishRoster = defineEndpoint({
  method: "POST",
  path: "/api/hris/rosters/publish",
  body: clientInputSchema({
    outletId: outletIdSchema,
    weekStart: businessDateSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(rosterPublicationSchema),
});

export const createShiftSwapRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/shift-swaps",
  body: clientInputSchema({
    outletId: outletIdSchema,
    fromAssignmentId: shiftAssignmentIdSchema,
    toEmployeeId: employeeIdSchema,
    /** Set for a true swap; omit/null for a cover. */
    toAssignmentId: shiftAssignmentIdSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(shiftSwapRequestSchema),
});

export const listShiftSwapRequests = defineEndpoint({
  method: "GET",
  path: "/api/hris/shift-swaps",
  query: cursorPageQuerySchema.extend({
    outletId: outletIdSchema.optional(),
    status: shiftSwapStatusSchema.optional(),
    mine: queryBooleanSchema.optional(),
  }),
  response: cursorPageSchema(shiftSwapRequestSchema),
});

export const cancelShiftSwapRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/shift-swaps/:swapId/cancel",
  params: z.strictObject({ swapId: shiftSwapRequestIdSchema }),
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(shiftSwapRequestSchema),
});

export const decideShiftSwapRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/shift-swaps/:swapId/decision",
  params: z.strictObject({ swapId: shiftSwapRequestIdSchema }),
  body: clientInputSchema({
    action: z.enum(["approve", "approve_with_override", "reject"]),
    overrideReason: z.string().min(1).max(500).nullable(),
    rejectionReason: z.string().trim().min(1).max(500).nullable().optional(),
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((body, ctx) => {
    if (body.action === "reject" && !body.rejectionReason)
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "Rejection reason is required",
      });
    if (body.action !== "reject" && body.rejectionReason)
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "Only rejection has a rejection reason",
      });
  }),
  response: dataResponseSchema(shiftSwapRequestSchema),
});

export const respondShiftSwapRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/shift-swaps/:swapId/peer-response",
  params: z.strictObject({ swapId: shiftSwapRequestIdSchema }),
  body: clientInputSchema({
    action: z.enum(["accept", "reject"]),
    rejectionReason: z.string().trim().min(1).max(500).nullable().optional(),
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((body, ctx) => {
    if (body.action === "reject" && !body.rejectionReason)
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "Rejection reason is required",
      });
    if (body.action === "accept" && body.rejectionReason)
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "Only rejection has a rejection reason",
      });
  }),
  response: dataResponseSchema(shiftSwapRequestSchema),
});

export const listShiftSwapCandidates = defineEndpoint({
  method: "GET",
  path: "/api/hris/shift-swaps/candidates",
  query: z.strictObject({
    outletId: outletIdSchema,
    fromAssignmentId: shiftAssignmentIdSchema,
  }),
  response: z.strictObject({
    data: z.array(
      z.strictObject({
        id: employeeIdSchema,
        name: z.string(),
        assignments: z.array(shiftSwapAssignmentSchema),
      }),
    ),
  }),
});

// ---- Leave, balances, holidays, overtime --------------------------------

export const listLeaveRequests = defineEndpoint({
  method: "GET",
  path: "/api/hris/leave/requests",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    status: leaveRequestStatusSchema.optional(),
  }),
  response: cursorPageSchema(leaveRequestSchema),
});

export const createLeaveRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/requests",
  body: clientInputSchema({
    leaveTypeId: leaveTypeIdSchema,
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    reason: z.string().min(1).max(500).nullable(),
    /** Pre-signed upload reference for the attachment (medical certificate). */
    attachmentUploadRef: z.string().min(1).max(200).nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(leaveRequestSchema),
});

export const decideLeaveRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/requests/:leaveRequestId/decision",
  params: z.strictObject({ leaveRequestId: leaveRequestIdSchema }),
  body: clientInputSchema({
    action: z.enum(["approve", "reject", "cancel"]),
    rejectionReason: z.string().trim().min(3).max(500).optional(),
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((body, ctx) => {
    if (body.action === "reject" && !body.rejectionReason)
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "A rejection reason is required",
      });
  }),
  response: dataResponseSchema(leaveRequestSchema),
});

export const listLeaveBalances = defineEndpoint({
  method: "GET",
  path: "/api/hris/leave/balances",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  }),
  response: cursorPageSchema(leaveBalanceSchema),
});

export const listLeaveTypes = defineEndpoint({
  method: "GET",
  path: "/api/hris/leave/types",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(leaveTypeSchema),
});

export const createLeaveType = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/types",
  body: leaveTypeInputSchema.extend({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(leaveTypeSchema),
});

export const updateLeaveType = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/leave/types/:leaveTypeId",
  params: z.strictObject({ leaveTypeId: leaveTypeIdSchema }),
  body: leaveTypeInputSchema
    .omit({ code: true })
    .partial()
    .extend({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(leaveTypeSchema),
});

export const runLeaveAccrual = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/accruals/run",
  body: clientInputSchema({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
  }),
  response: dataResponseSchema(leaveAccrualRunResultSchema),
});

export const runLeaveCarryOver = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/carry-over/run",
  body: clientInputSchema({
    fromYear: z.number().int().min(2000).max(2099),
  }),
  response: dataResponseSchema(leaveAccrualRunResultSchema),
});

export const expireLeaveCarryOver = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/carry-over/expire",
  body: clientInputSchema({ asOf: businessDateSchema }),
  response: dataResponseSchema(leaveAccrualRunResultSchema),
});

/** Collective-leave policy (founder decision Q7); HR manage, tenant-wide. */
export const getLeaveSettings = defineEndpoint({
  method: "GET",
  path: "/api/hris/leave/settings",
  response: dataResponseSchema(leaveSettingsSchema),
});

export const updateLeaveSettings = defineEndpoint({
  method: "PUT",
  path: "/api/hris/leave/settings",
  body: clientInputSchema({
    ...leaveSettingsInputSchema.shape,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(leaveSettingsSchema),
});

export const listHolidays = defineEndpoint({
  method: "GET",
  path: "/api/hris/holidays",
  query: cursorPageQuerySchema.extend({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  }),
  response: cursorPageSchema(holidaySchema),
});

export const createHoliday = defineEndpoint({
  method: "POST",
  path: "/api/hris/holidays",
  body: clientInputSchema({
    date: businessDateSchema,
    name: z.string().min(1).max(150),
    type: holidayTypeSchema,
    /** null = the whole tenant. */
    outletId: outletIdSchema.nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(holidaySchema),
});

export const updateHoliday = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/holidays/:holidayId",
  params: z.strictObject({ holidayId: holidayIdSchema }),
  body: clientInputSchema({
    date: businessDateSchema.optional(),
    name: z.string().min(1).max(150).optional(),
    type: holidayTypeSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(holidaySchema),
});

export const deleteHoliday = defineEndpoint({
  method: "DELETE",
  path: "/api/hris/holidays/:holidayId",
  params: z.strictObject({ holidayId: holidayIdSchema }),
  response: dataResponseSchema(z.strictObject({ id: holidayIdSchema })),
});

export const listOvertimeRequests = defineEndpoint({
  method: "GET",
  path: "/api/hris/overtime-requests",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    status: overtimeRequestStatusSchema.optional(),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  }),
  response: cursorPageSchema(overtimeRequestSchema),
});

export const createOvertimeRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/overtime-requests",
  body: clientInputSchema({
    outletId: outletIdSchema,
    date: businessDateSchema,
    minutes: z.number().int().min(1).max(720),
    reason: z.string().min(1).max(500),
    /** Employee's rest day; a holiday on `date` overrides it server side. */
    dayType: overtimeDayTypeSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(overtimeRequestSchema),
});

export const decideOvertimeRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/overtime-requests/:overtimeRequestId/decision",
  params: z.strictObject({ overtimeRequestId: overtimeRequestIdSchema }),
  body: clientInputSchema({
    action: z.enum(["approve", "reject", "cancel"]),
    rejectionReason: z.string().trim().min(3).max(500).optional(),
    idempotencyKey: idempotencyKeySchema,
  }).superRefine((body, ctx) => {
    if (body.action === "reject" && !body.rejectionReason)
      ctx.addIssue({
        code: "custom",
        path: ["rejectionReason"],
        message: "A rejection reason is required",
      });
  }),
  response: dataResponseSchema(overtimeRequestSchema),
});

export const listOvertimeFormulas = defineEndpoint({
  method: "GET",
  path: "/api/hris/overtime-formulas",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(overtimeFormulaSchema),
});

export const createOvertimeFormula = defineEndpoint({
  method: "POST",
  path: "/api/hris/overtime-formulas",
  body: clientInputSchema({
    effectiveFrom: businessDateSchema,
    parameters: overtimeParametersSchema,
    restDayType: overtimeRestDayTypeSchema,
    legalBasis: z.string().min(1).max(200),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(overtimeFormulaSchema),
});

export const publishOvertimeFormula = defineEndpoint({
  method: "POST",
  path: "/api/hris/overtime-formulas/:overtimeFormulaId/publish",
  params: z.strictObject({ overtimeFormulaId: overtimeFormulaIdSchema }),
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(overtimeFormulaSchema),
});

// ---- KPI, SOP, training, announcements ---------------------------------

export const listKpiReviews = defineEndpoint({
  method: "GET",
  path: "/api/hris/kpi-reviews",
  query: cursorPageQuerySchema.extend({
    employeeId: employeeIdSchema.optional(),
    periodYear: z.coerce.number().int().min(2000).max(2100).optional(),
    reviewId: kpiReviewIdSchema.optional(),
  }),
  response: cursorPageSchema(kpiReviewSchema),
});

export const listKpiDefinitions = defineEndpoint({
  method: "GET",
  path: "/api/hris/kpi-definitions",
  query: cursorPageQuerySchema.extend({
    positionId: positionIdSchema.optional(),
    source: kpiSourceSchema.optional(),
    isActive: z.enum(["true", "false"]).optional(),
  }),
  response: cursorPageSchema(kpiDefinitionSchema),
});

/** A system KPI must name a metric of the catalog that has an employee split. */
export const createKpiDefinition = defineEndpoint({
  method: "POST",
  path: "/api/hris/kpi-definitions",
  body: createKpiDefinitionInputSchema,
  response: dataResponseSchema(kpiDefinitionSchema),
});

export const updateKpiDefinition = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/kpi-definitions/:kpiDefinitionId",
  params: z.strictObject({ kpiDefinitionId: kpiDefinitionIdSchema }),
  body: updateKpiDefinitionInputSchema,
  response: dataResponseSchema(kpiDefinitionSchema),
});

/** Opens a draft review and computes the system actuals for the period. */
export const createKpiReview = defineEndpoint({
  method: "POST",
  path: "/api/hris/kpi-reviews",
  body: createKpiReviewInputSchema,
  response: dataResponseSchema(kpiReviewSchema),
});

const kpiReviewIdParams = z.strictObject({ reviewId: kpiReviewIdSchema });

export const updateKpiScores = defineEndpoint({
  method: "PATCH",
  path: "/api/hris/kpi-reviews/:reviewId/scores",
  params: kpiReviewIdParams,
  body: updateKpiScoresInputSchema,
  response: dataResponseSchema(kpiReviewSchema),
});

/** Recomputes the system actuals of a draft review; a submitted one is frozen. */
export const refreshKpiActuals = defineEndpoint({
  method: "POST",
  path: "/api/hris/kpi-reviews/:reviewId/refresh-actuals",
  params: kpiReviewIdParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(kpiReviewSchema),
});

export const submitKpiReview = defineEndpoint({
  method: "POST",
  path: "/api/hris/kpi-reviews/:reviewId/submit",
  params: kpiReviewIdParams,
  body: clientInputSchema({}),
  response: dataResponseSchema(kpiReviewSchema),
});

export const listSopDocuments = defineEndpoint({
  method: "GET",
  path: "/api/hris/sop-documents",
  query: cursorPageQuerySchema.extend({
    stationId: stationIdSchema.optional(),
    positionId: positionIdSchema.optional(),
  }),
  response: cursorPageSchema(sopDocumentSchema),
});

export const acknowledgeSopDocument = defineEndpoint({
  method: "POST",
  path: "/api/hris/sop-documents/:sopDocumentId/acknowledgements",
  params: z.strictObject({ sopDocumentId: sopDocumentIdSchema }),
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(sopAcknowledgementSchema),
});

export const listTrainings = defineEndpoint({
  method: "GET",
  path: "/api/hris/trainings",
  query: cursorPageQuerySchema.extend({
    stationId: stationIdSchema.optional(),
    positionId: positionIdSchema.optional(),
  }),
  response: cursorPageSchema(trainingSchema),
});

export const completeTraining = defineEndpoint({
  method: "POST",
  path: "/api/hris/trainings/:trainingId/completions",
  params: z.strictObject({ trainingId: trainingIdSchema }),
  body: clientInputSchema({
    answers: z
      .array(
        z.strictObject({
          questionId: z.uuid().toLowerCase(),
          optionIndex: z.number().int().nonnegative().max(5),
        }),
      )
      .min(1)
      .max(100),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(trainingCompletionSchema),
});

export const listAnnouncements = defineEndpoint({
  method: "GET",
  path: "/api/hris/announcements",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(announcementSchema),
});

export const markAnnouncementRead = defineEndpoint({
  method: "POST",
  path: "/api/hris/announcements/:announcementId/receipts",
  params: z.strictObject({ announcementId: announcementIdSchema }),
  body: clientInputSchema({
    /** True = the employee also confirms the announcement (tanda terima). */
    acknowledged: z.boolean(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(announcementReceiptSchema),
});

/** Every endpoint of the domain, for route registration and client generation. */
export const hrisEndpoints = [
  createEmployee,
  createOrgUnit,
  createPositionGrade,
  createPosition,
  createEmploymentContract,
  createEmployeeDocument,
  listEmployees,
  getEmployee,
  getEmployeePii,
  updateEmployeePii,
  changeEmployeeManagerEndpoint,
  setEmployeeLegalEntityEndpoint,
  getMyHrisProfile,
  listOrgUnits,
  listPositionGrades,
  listPositions,
  listEmploymentContracts,
  getEmploymentContract,
  listEmployeeDocuments,
  listChecklistTasks,
  listChecklistTemplates,
  createChecklistTemplate,
  updateChecklistTemplate,
  startEmployeeOnboarding,
  actOnChecklistTask,
  listChecklistTaskActions,
  createOffboarding,
  getOffboarding,
  updateOffboarding,
  cancelOffboarding,
  revokeOffboardingAccess,
  completeOffboarding,
  getOffboardingSettlement,
  getWorkCertificate,
  getWorkCertificatePdf,
  clockAttendance,
  listAttendanceLogs,
  getAttendanceQr,
  requestAttendanceCorrection,
  listAttendanceCorrections,
  listShiftTemplates,
  createShiftTemplate,
  updateShiftTemplate,
  getShiftCompliancePolicy,
  updateShiftCompliancePolicy,
  createShiftAssignment,
  updateShiftAssignment,
  cancelShiftAssignment,
  copyRosterWeek,
  getRoster,
  listShiftAssignments,
  publishRoster,
  listShiftSwapRequests,
  cancelShiftSwapRequest,
  createShiftSwapRequest,
  decideShiftSwapRequest,
  respondShiftSwapRequest,
  listShiftSwapCandidates,
  listLeaveRequests,
  createLeaveRequest,
  decideLeaveRequest,
  listLeaveBalances,
  listLeaveTypes,
  createLeaveType,
  updateLeaveType,
  runLeaveAccrual,
  runLeaveCarryOver,
  expireLeaveCarryOver,
  getLeaveSettings,
  updateLeaveSettings,
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  listOvertimeRequests,
  createOvertimeRequest,
  decideOvertimeRequest,
  listOvertimeFormulas,
  createOvertimeFormula,
  publishOvertimeFormula,
  listKpiReviews,
  listKpiDefinitions,
  createKpiDefinition,
  updateKpiDefinition,
  createKpiReview,
  updateKpiScores,
  refreshKpiActuals,
  submitKpiReview,
  listSopDocuments,
  acknowledgeSopDocument,
  listTrainings,
  completeTraining,
  listAnnouncements,
  markAnnouncementRead,
] as const;
