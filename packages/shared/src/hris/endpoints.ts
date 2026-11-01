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
  isoDateTimeSchema,
  businessDateSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  employeeIdSchema,
  orgUnitIdSchema,
  positionIdSchema,
  employmentContractIdSchema,
  leaveTypeIdSchema,
  shiftAssignmentIdSchema,
  shiftSwapRequestIdSchema,
  leaveRequestIdSchema,
  overtimeRequestIdSchema,
  kpiReviewIdSchema,
  sopDocumentIdSchema,
  trainingIdSchema,
  announcementIdSchema,
  stationIdSchema,
} from "./ids.ts";
import {
  employeeSchema,
  employeePiiSchema,
  employeeDocumentSchema,
  employmentContractSchema,
  employmentContractStatusSchema,
  orgUnitSchema,
  positionSchema,
  positionGradeSchema,
  employeeStatusSchema,
  updateEmployeePiiInputSchema,
} from "./organization.ts";
import {
  checklistTaskSchema,
  checklistKindSchema,
  checklistTaskStatusSchema,
} from "./checklists.ts";
import {
  attendanceCorrectionSchema,
  attendanceCorrectionStatusSchema,
  attendanceLogSchema,
  attendanceMethodSchema,
  attendanceQrTokenSchema,
  attendanceTypeSchema,
} from "./attendance.ts";
import {
  rosterPublicationSchema,
  shiftAssignmentSchema,
  shiftSwapRequestSchema,
} from "./scheduling.ts";
import {
  holidaySchema,
  leaveBalanceSchema,
  leaveRequestSchema,
  leaveRequestStatusSchema,
  overtimeRequestSchema,
} from "./leave.ts";
import {
  announcementReceiptSchema,
  announcementSchema,
  kpiReviewSchema,
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

export const getEmployee = defineEndpoint({
  method: "GET",
  path: "/api/hris/employees/:employeeId",
  params: employeeIdParams,
  response: dataResponseSchema(employeeSchema),
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

export const listOrgUnits = defineEndpoint({
  method: "GET",
  path: "/api/hris/org-units",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(orgUnitSchema),
});

export const listPositionGrades = defineEndpoint({
  method: "GET",
  path: "/api/hris/position-grades",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(positionGradeSchema),
});

export const listPositions = defineEndpoint({
  method: "GET",
  path: "/api/hris/positions",
  query: cursorPageQuerySchema.extend({
    orgUnitId: orgUnitIdSchema.optional(),
  }),
  response: cursorPageSchema(positionSchema),
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

// ---- Attendance ----------------------------------------------------------

export const clockAttendance = defineEndpoint({
  method: "POST",
  path: "/api/hris/attendance/clock",
  body: clientInputSchema({
    type: attendanceTypeSchema,
    method: attendanceMethodSchema,
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
    attendanceLogId: z.uuid().nullable(),
    requestedType: attendanceTypeSchema,
    requestedOccurredAt: isoDateTimeSchema,
    reason: z.string().min(1).max(500),
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

// ---- Roster, shifts, swaps ---------------------------------------------

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

export const decideShiftSwapRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/shift-swaps/:swapId/decision",
  params: z.strictObject({ swapId: shiftSwapRequestIdSchema }),
  body: clientInputSchema({
    action: z.enum(["approve", "approve_with_override", "reject"]),
    overrideReason: z.string().min(1).max(500).nullable(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(shiftSwapRequestSchema),
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
    idempotencyKey: idempotencyKeySchema,
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

export const listHolidays = defineEndpoint({
  method: "GET",
  path: "/api/hris/holidays",
  query: cursorPageQuerySchema.extend({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  }),
  response: cursorPageSchema(holidaySchema),
});

export const createOvertimeRequest = defineEndpoint({
  method: "POST",
  path: "/api/hris/overtime-requests",
  body: clientInputSchema({
    outletId: outletIdSchema,
    date: businessDateSchema,
    minutes: z.number().int().min(1).max(720),
    reason: z.string().min(1).max(500),
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
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(overtimeRequestSchema),
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
  listEmployees,
  getEmployee,
  getEmployeePii,
  updateEmployeePii,
  listOrgUnits,
  listPositionGrades,
  listPositions,
  listEmploymentContracts,
  getEmploymentContract,
  listEmployeeDocuments,
  listChecklistTasks,
  clockAttendance,
  listAttendanceLogs,
  getAttendanceQr,
  requestAttendanceCorrection,
  listAttendanceCorrections,
  listShiftAssignments,
  publishRoster,
  createShiftSwapRequest,
  decideShiftSwapRequest,
  listLeaveRequests,
  createLeaveRequest,
  decideLeaveRequest,
  listLeaveBalances,
  listHolidays,
  createOvertimeRequest,
  decideOvertimeRequest,
  listKpiReviews,
  listSopDocuments,
  acknowledgeSopDocument,
  listTrainings,
  completeTraining,
  listAnnouncements,
  markAnnouncementRead,
] as const;
