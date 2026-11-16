// Branded ids of the payroll contract (PRD v1.7 §6 H payroll tables, bead
// legend-zjwa). Every payroll aggregate is a UUID: none of them is an
// offline-synced operational event (D-CORE-1).

import { uuidIdSchema } from "../../core/index.ts";
import type { z } from "zod";

export const payrollPolicyIdSchema = uuidIdSchema<"PayrollPolicyId">();
export const payComponentIdSchema = uuidIdSchema<"PayComponentId">();
export const employeePayComponentIdSchema =
  uuidIdSchema<"EmployeePayComponentId">();
/** One row of PRD §6 H `statutory_rates` = one version of one table. */
export const statutoryTableVersionIdSchema =
  uuidIdSchema<"StatutoryTableVersionId">();
export const thrScheduleIdSchema = uuidIdSchema<"ThrScheduleId">();
export const payrollRunIdSchema = uuidIdSchema<"PayrollRunId">();
export const payslipIdSchema = uuidIdSchema<"PayslipId">();
export const bankTransferFileIdSchema = uuidIdSchema<"BankTransferFileId">();
export const payrollTaxExportIdSchema = uuidIdSchema<"PayrollTaxExportId">();
export const serviceChargePoolIdSchema = uuidIdSchema<"ServiceChargePoolId">();
export const serviceChargeAllocationIdSchema =
  uuidIdSchema<"ServiceChargeAllocationId">();
export const employeeLoanIdSchema = uuidIdSchema<"EmployeeLoanId">();
export const reimbursementCategoryIdSchema =
  uuidIdSchema<"ReimbursementCategoryId">();
export const reimbursementIdSchema = uuidIdSchema<"ReimbursementId">();
/** One row of `payroll_payout_approval_log` (legend-7gghu). */
export const payoutApprovalLogIdSchema = uuidIdSchema<"PayoutApprovalLogId">();
/** One row of `payroll_payout_batch_disputes` (legend-l2zru). */
export const payoutBatchDisputeIdSchema =
  uuidIdSchema<"PayoutBatchDisputeId">();
/** One row of `payroll_payout_batch_unfreezes` (legend-l2zru). */
export const payoutBatchUnfreezeIdSchema =
  uuidIdSchema<"PayoutBatchUnfreezeId">();

export type PayrollPolicyId = z.infer<typeof payrollPolicyIdSchema>;
export type PayComponentId = z.infer<typeof payComponentIdSchema>;
export type EmployeePayComponentId = z.infer<
  typeof employeePayComponentIdSchema
>;
export type StatutoryTableVersionId = z.infer<
  typeof statutoryTableVersionIdSchema
>;
export type ThrScheduleId = z.infer<typeof thrScheduleIdSchema>;
export type PayrollRunId = z.infer<typeof payrollRunIdSchema>;
export type PayoutApprovalLogId = z.infer<typeof payoutApprovalLogIdSchema>;
export type PayoutBatchDisputeId = z.infer<typeof payoutBatchDisputeIdSchema>;
export type PayoutBatchUnfreezeId = z.infer<typeof payoutBatchUnfreezeIdSchema>;
export type PayslipId = z.infer<typeof payslipIdSchema>;
export type BankTransferFileId = z.infer<typeof bankTransferFileIdSchema>;
export type PayrollTaxExportId = z.infer<typeof payrollTaxExportIdSchema>;
export type ServiceChargePoolId = z.infer<typeof serviceChargePoolIdSchema>;
export type ServiceChargeAllocationId = z.infer<
  typeof serviceChargeAllocationIdSchema
>;
export type EmployeeLoanId = z.infer<typeof employeeLoanIdSchema>;
export type ReimbursementCategoryId = z.infer<
  typeof reimbursementCategoryIdSchema
>;
export type ReimbursementId = z.infer<typeof reimbursementIdSchema>;
