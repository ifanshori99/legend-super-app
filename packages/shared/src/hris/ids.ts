// Branded ids of the HRIS contract (PRD v1.7 §6 H).
// Every aggregate is UUID except `attendance_logs`, which PRD §6 H marks
// `ULID (PK)` because attendance is a time-ordered operational event that also
// syncs from an outlet edge node (§5 Sinkronisasi, F25 "Offline").
// The roster station is the menu domain's `StationId`; the access contract
// already declares that brand, so it is imported instead of declared twice.

import { ulidIdSchema, uuidIdSchema } from "../core/index.ts";
import { stationIdSchema } from "../access/ids.ts";
import type { z } from "zod";

export const employeeIdSchema = uuidIdSchema<"EmployeeId">();
export const orgUnitIdSchema = uuidIdSchema<"OrgUnitId">();
export const positionIdSchema = uuidIdSchema<"PositionId">();
export const positionGradeIdSchema = uuidIdSchema<"PositionGradeId">();
export const employmentContractIdSchema =
  uuidIdSchema<"EmploymentContractId">();
export const employeeDocumentIdSchema = uuidIdSchema<"EmployeeDocumentId">();
export const checklistTemplateIdSchema = uuidIdSchema<"ChecklistTemplateId">();
export const checklistTaskIdSchema = uuidIdSchema<"ChecklistTaskId">();
/** PRD §6 H `attendance_logs.id`: ULID (PK). */
export const attendanceLogIdSchema = ulidIdSchema<"AttendanceLogId">();
export const attendanceCorrectionIdSchema =
  uuidIdSchema<"AttendanceCorrectionId">();
export const shiftTemplateIdSchema = uuidIdSchema<"ShiftTemplateId">();
export const shiftAssignmentIdSchema = uuidIdSchema<"ShiftAssignmentId">();
export const shiftSwapRequestIdSchema = uuidIdSchema<"ShiftSwapRequestId">();
export const leaveTypeIdSchema = uuidIdSchema<"LeaveTypeId">();
export const leaveBalanceIdSchema = uuidIdSchema<"LeaveBalanceId">();
export const leaveRequestIdSchema = uuidIdSchema<"LeaveRequestId">();
export const holidayIdSchema = uuidIdSchema<"HolidayId">();
export const overtimeRequestIdSchema = uuidIdSchema<"OvertimeRequestId">();
export const kpiDefinitionIdSchema = uuidIdSchema<"KpiDefinitionId">();
export const kpiReviewIdSchema = uuidIdSchema<"KpiReviewId">();
export const sopDocumentIdSchema = uuidIdSchema<"SopDocumentId">();
export const sopAcknowledgementIdSchema =
  uuidIdSchema<"SopAcknowledgementId">();
export const trainingIdSchema = uuidIdSchema<"TrainingId">();
export const trainingQuestionIdSchema = uuidIdSchema<"TrainingQuestionId">();
export const trainingCompletionIdSchema =
  uuidIdSchema<"TrainingCompletionId">();
export const announcementIdSchema = uuidIdSchema<"AnnouncementId">();
export const announcementReceiptIdSchema =
  uuidIdSchema<"AnnouncementReceiptId">();

/** Station brand shared with menu/access (one type, declared there). */
export { stationIdSchema };

export type EmployeeId = z.infer<typeof employeeIdSchema>;
export type OrgUnitId = z.infer<typeof orgUnitIdSchema>;
export type PositionId = z.infer<typeof positionIdSchema>;
export type PositionGradeId = z.infer<typeof positionGradeIdSchema>;
export type EmploymentContractId = z.infer<typeof employmentContractIdSchema>;
export type EmployeeDocumentId = z.infer<typeof employeeDocumentIdSchema>;
export type ChecklistTemplateId = z.infer<typeof checklistTemplateIdSchema>;
export type ChecklistTaskId = z.infer<typeof checklistTaskIdSchema>;
export type AttendanceLogId = z.infer<typeof attendanceLogIdSchema>;
export type AttendanceCorrectionId = z.infer<
  typeof attendanceCorrectionIdSchema
>;
export type ShiftTemplateId = z.infer<typeof shiftTemplateIdSchema>;
export type ShiftAssignmentId = z.infer<typeof shiftAssignmentIdSchema>;
export type ShiftSwapRequestId = z.infer<typeof shiftSwapRequestIdSchema>;
export type LeaveTypeId = z.infer<typeof leaveTypeIdSchema>;
export type LeaveBalanceId = z.infer<typeof leaveBalanceIdSchema>;
export type LeaveRequestId = z.infer<typeof leaveRequestIdSchema>;
export type HolidayId = z.infer<typeof holidayIdSchema>;
export type OvertimeRequestId = z.infer<typeof overtimeRequestIdSchema>;
export type KpiDefinitionId = z.infer<typeof kpiDefinitionIdSchema>;
export type KpiReviewId = z.infer<typeof kpiReviewIdSchema>;
export type SopDocumentId = z.infer<typeof sopDocumentIdSchema>;
export type SopAcknowledgementId = z.infer<typeof sopAcknowledgementIdSchema>;
export type TrainingId = z.infer<typeof trainingIdSchema>;
export type TrainingQuestionId = z.infer<typeof trainingQuestionIdSchema>;
export type TrainingCompletionId = z.infer<typeof trainingCompletionIdSchema>;
export type AnnouncementId = z.infer<typeof announcementIdSchema>;
export type AnnouncementReceiptId = z.infer<typeof announcementReceiptIdSchema>;
