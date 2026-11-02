// Payroll endpoint contracts (PRD v1.7 §3 "Kontrak Bersama": contract first, FE
// and BE in parallel). One object per route; the typed client, FE mock mode and
// the API route validation read these. Bodies are `clientInputSchema`, so a
// client-supplied tenant id is rejected (TEN-02); every write carries an
// idempotency key the API binds to a request fingerprint.
//
// Permission per route (access/permissions.ts, PRD §3 Matriks Approval):
//   statutory tables, policies, components, THR      payroll.run (write), payroll.view (read)
//   employee pay components (salary, HR-03)          payroll.view / payroll.run
//   runs: create, simulate, return, approve_hr       payroll.run
//   runs: approve_final                              payroll.approve (≠ HR approver)
//   runs: lock                                       payroll.lock
//   runs: mark paid, bank file, tax export           payroll.lock
//   runs: reversal request                           payroll.run
//   runs: reversal decision                          payroll.cancel.approve (≠ requester)
//   service-charge pools                             payroll.run / payroll.approve
//   kasbon decide/disburse                           hr.loan.approve
//   reimbursement decide/pay                         hr.reimbursement.approve
//   /me/payslips                                     self.payslip.view + payslip PIN
//   /me/reimbursements                               self.reimbursement.request
//   /me/loans                                        own record (HR-01); see report

import {
  z,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  outletIdSchema,
  clientInputSchema,
  idempotencyKeySchema,
  businessDateSchema,
} from "../../core/index.ts";
import { defineEndpoint } from "../../api/endpoint.ts";
import { legalEntityIdSchema } from "../../accounting/ids.ts";
import { employeeIdSchema } from "../ids.ts";
import {
  createPayComponentInputSchema,
  employeePayComponentSchema,
  payComponentSchema,
  setEmployeePayComponentInputSchema,
  updatePayComponentInputSchema,
} from "./components.ts";
import {
  bankTransferFileIdSchema,
  employeeLoanIdSchema,
  payComponentIdSchema,
  payrollPolicyIdSchema,
  payrollRunIdSchema,
  payslipIdSchema,
  reimbursementIdSchema,
  serviceChargePoolIdSchema,
  statutoryTableVersionIdSchema,
} from "./ids.ts";
import {
  createEmployeeLoanInputSchema,
  employeeLoanSchema,
  employeeLoanStatusSchema,
} from "./loans.ts";
import {
  bankTransferFileSchema,
  bankTransferFormatSchema,
  myPayslipSummarySchema,
  payrollRunEmployeeResultSchema,
  payrollTaxExportKindSchema,
  payrollTaxExportSchema,
  payslipSchema,
  viewMyPayslipInputSchema,
} from "./payslips.ts";
import {
  createPayrollPolicyInputSchema,
  createThrScheduleInputSchema,
  payrollPolicySchema,
  thrScheduleSchema,
  updatePayrollPolicyInputSchema,
} from "./policies.ts";
import {
  createReimbursementCategoryInputSchema,
  createReimbursementInputSchema,
  reimbursementCategorySchema,
  reimbursementSchema,
  reimbursementStatusSchema,
} from "./reimbursements.ts";
import {
  createPayrollRunInputSchema,
  decidePayrollRunReversalInputSchema,
  payrollRunActionInputSchema,
  payrollRunSchema,
  payrollRunStatusSchema,
  requestPayrollRunReversalInputSchema,
} from "./run.ts";
import {
  createServiceChargePoolInputSchema,
  serviceChargeAllocationSchema,
  serviceChargePoolSchema,
  serviceChargePoolStatusSchema,
} from "./service-charge.ts";
import {
  statutoryTableDraftInputSchema,
  statutoryTableTypeSchema,
  statutoryTableVersionSchema,
} from "./statutory.ts";

const BASE = "/api/hris/payroll";
const write = { idempotencyKey: idempotencyKeySchema };
const runParams = z.strictObject({ payrollRunId: payrollRunIdSchema });

// ---- Statutory tables (PAYR-02, R20) -------------------------------------

export const listStatutoryTables = defineEndpoint({
  method: "GET",
  path: `${BASE}/statutory-tables`,
  query: cursorPageQuerySchema.extend({
    type: statutoryTableTypeSchema.optional(),
  }),
  response: cursorPageSchema(statutoryTableVersionSchema),
});

export const getStatutoryTable = defineEndpoint({
  method: "GET",
  path: `${BASE}/statutory-tables/:versionId`,
  params: z.strictObject({ versionId: statutoryTableVersionIdSchema }),
  response: dataResponseSchema(statutoryTableVersionSchema),
});

/** New draft version; the server assigns the next version number. */
export const createStatutoryTableDraft = defineEndpoint({
  method: "POST",
  path: `${BASE}/statutory-tables`,
  body: clientInputSchema({
    draft: statutoryTableDraftInputSchema,
    effectiveFrom: businessDateSchema,
    legalBasis: z.string().trim().min(1).max(200),
    ...write,
  }),
  response: dataResponseSchema(statutoryTableVersionSchema),
});

/** Drafts only (PAYROLL_STATUTORY_TABLE_IMMUTABLE otherwise). */
export const updateStatutoryTableDraft = defineEndpoint({
  method: "PUT",
  path: `${BASE}/statutory-tables/:versionId`,
  params: z.strictObject({ versionId: statutoryTableVersionIdSchema }),
  body: clientInputSchema({
    draft: statutoryTableDraftInputSchema,
    effectiveFrom: businessDateSchema,
    legalBasis: z.string().trim().min(1).max(200),
    ...write,
  }),
  response: dataResponseSchema(statutoryTableVersionSchema),
});

export const publishStatutoryTable = defineEndpoint({
  method: "POST",
  path: `${BASE}/statutory-tables/:versionId/publish`,
  params: z.strictObject({ versionId: statutoryTableVersionIdSchema }),
  body: clientInputSchema(write),
  response: dataResponseSchema(statutoryTableVersionSchema),
});

export const archiveStatutoryTable = defineEndpoint({
  method: "POST",
  path: `${BASE}/statutory-tables/:versionId/archive`,
  params: z.strictObject({ versionId: statutoryTableVersionIdSchema }),
  body: clientInputSchema(write),
  response: dataResponseSchema(statutoryTableVersionSchema),
});

// ---- Policies, components, THR schedules ---------------------------------

export const listPayrollPolicies = defineEndpoint({
  method: "GET",
  path: `${BASE}/policies`,
  query: cursorPageQuerySchema.extend({
    legalEntityId: legalEntityIdSchema.optional(),
  }),
  response: cursorPageSchema(payrollPolicySchema),
});

export const createPayrollPolicy = defineEndpoint({
  method: "POST",
  path: `${BASE}/policies`,
  body: createPayrollPolicyInputSchema,
  response: dataResponseSchema(payrollPolicySchema),
});

export const updatePayrollPolicy = defineEndpoint({
  method: "PATCH",
  path: `${BASE}/policies/:payrollPolicyId`,
  params: z.strictObject({ payrollPolicyId: payrollPolicyIdSchema }),
  body: updatePayrollPolicyInputSchema.extend(write),
  response: dataResponseSchema(payrollPolicySchema),
});

export const listPayComponents = defineEndpoint({
  method: "GET",
  path: `${BASE}/components`,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(payComponentSchema),
});

export const createPayComponent = defineEndpoint({
  method: "POST",
  path: `${BASE}/components`,
  body: createPayComponentInputSchema,
  response: dataResponseSchema(payComponentSchema),
});

export const updatePayComponent = defineEndpoint({
  method: "PATCH",
  path: `${BASE}/components/:componentId`,
  params: z.strictObject({ componentId: payComponentIdSchema }),
  body: updatePayComponentInputSchema.extend(write),
  response: dataResponseSchema(payComponentSchema),
});

/** HR-03: salary amounts; payroll.view only. */
export const listEmployeePayComponents = defineEndpoint({
  method: "GET",
  path: `${BASE}/employees/:employeeId/components`,
  params: z.strictObject({ employeeId: employeeIdSchema }),
  query: cursorPageQuerySchema,
  response: cursorPageSchema(employeePayComponentSchema),
});

export const setEmployeePayComponent = defineEndpoint({
  method: "PUT",
  path: `${BASE}/employees/:employeeId/components`,
  params: z.strictObject({ employeeId: employeeIdSchema }),
  body: setEmployeePayComponentInputSchema,
  response: dataResponseSchema(employeePayComponentSchema),
});

export const listThrSchedules = defineEndpoint({
  method: "GET",
  path: `${BASE}/thr-schedules`,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(thrScheduleSchema),
});

export const createThrSchedule = defineEndpoint({
  method: "POST",
  path: `${BASE}/thr-schedules`,
  body: createThrScheduleInputSchema,
  response: dataResponseSchema(thrScheduleSchema),
});

// ---- Payroll runs (PAYR-01, PAYR-04, PAYR-05) ---------------------------

export const listPayrollRuns = defineEndpoint({
  method: "GET",
  path: `${BASE}/runs`,
  query: cursorPageQuerySchema.extend({
    status: payrollRunStatusSchema.optional(),
    legalEntityId: legalEntityIdSchema.optional(),
  }),
  response: cursorPageSchema(payrollRunSchema),
});

export const getPayrollRun = defineEndpoint({
  method: "GET",
  path: `${BASE}/runs/:payrollRunId`,
  params: runParams,
  response: dataResponseSchema(payrollRunSchema),
});

export const createPayrollRun = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs`,
  body: createPayrollRunInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

/** Repeatable and side-effect free (PAYR-01). */
export const simulatePayrollRun = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/simulate`,
  params: runParams,
  body: payrollRunActionInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

/** Per-employee review with the change vs. the previous run (Alur K.2). */
export const listPayrollRunEmployeeResults = defineEndpoint({
  method: "GET",
  path: `${BASE}/runs/:payrollRunId/employees`,
  params: runParams,
  query: cursorPageQuerySchema.extend({ outletId: outletIdSchema.optional() }),
  response: cursorPageSchema(payrollRunEmployeeResultSchema),
});

export const returnPayrollRunToDraft = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/return-to-draft`,
  params: runParams,
  body: clientInputSchema({
    reason: z.string().trim().min(1).max(500),
    ...write,
  }),
  response: dataResponseSchema(payrollRunSchema),
});

export const approvePayrollRunHr = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/hr-approval`,
  params: runParams,
  body: payrollRunActionInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

export const approvePayrollRunFinal = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/final-approval`,
  params: runParams,
  body: payrollRunActionInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

export const lockPayrollRun = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/lock`,
  params: runParams,
  body: payrollRunActionInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

export const markPayrollRunPaid = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/mark-paid`,
  params: runParams,
  body: clientInputSchema({
    bankTransferFileId: bankTransferFileIdSchema.nullable(),
    ...write,
  }),
  response: dataResponseSchema(payrollRunSchema),
});

export const requestPayrollRunReversal = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/reversal`,
  params: runParams,
  body: requestPayrollRunReversalInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

export const decidePayrollRunReversal = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/reversal/decision`,
  params: runParams,
  body: decidePayrollRunReversalInputSchema,
  response: dataResponseSchema(payrollRunSchema),
});

/** Payslips of a locked run (HR view, payroll.view). */
export const listPayrollRunPayslips = defineEndpoint({
  method: "GET",
  path: `${BASE}/runs/:payrollRunId/payslips`,
  params: runParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(payslipSchema),
});

export const createBankTransferFile = defineEndpoint({
  method: "POST",
  path: `${BASE}/runs/:payrollRunId/bank-transfer-files`,
  params: runParams,
  body: clientInputSchema({ format: bankTransferFormatSchema, ...write }),
  response: dataResponseSchema(bankTransferFileSchema),
});

export const listBankTransferFiles = defineEndpoint({
  method: "GET",
  path: `${BASE}/runs/:payrollRunId/bank-transfer-files`,
  params: runParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(bankTransferFileSchema),
});

export const createPayrollTaxExport = defineEndpoint({
  method: "POST",
  path: `${BASE}/tax-exports`,
  body: clientInputSchema({
    legalEntityId: legalEntityIdSchema,
    kind: payrollTaxExportKindSchema,
    taxPeriod: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/),
    ...write,
  }),
  response: dataResponseSchema(payrollTaxExportSchema),
});

// ---- Service-charge pools ----------------------------------------------

export const listServiceChargePools = defineEndpoint({
  method: "GET",
  path: `${BASE}/service-charge-pools`,
  query: cursorPageQuerySchema.extend({
    outletId: outletIdSchema.optional(),
    status: serviceChargePoolStatusSchema.optional(),
  }),
  response: cursorPageSchema(serviceChargePoolSchema),
});

export const createServiceChargePool = defineEndpoint({
  method: "POST",
  path: `${BASE}/service-charge-pools`,
  body: createServiceChargePoolInputSchema,
  response: dataResponseSchema(serviceChargePoolSchema),
});

const poolParams = z.strictObject({ poolId: serviceChargePoolIdSchema });

export const calculateServiceChargePool = defineEndpoint({
  method: "POST",
  path: `${BASE}/service-charge-pools/:poolId/calculate`,
  params: poolParams,
  body: clientInputSchema(write),
  response: dataResponseSchema(serviceChargePoolSchema),
});

export const approveServiceChargePool = defineEndpoint({
  method: "POST",
  path: `${BASE}/service-charge-pools/:poolId/approve`,
  params: poolParams,
  body: clientInputSchema(write),
  response: dataResponseSchema(serviceChargePoolSchema),
});

export const listServiceChargeAllocations = defineEndpoint({
  method: "GET",
  path: `${BASE}/service-charge-pools/:poolId/allocations`,
  params: poolParams,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(serviceChargeAllocationSchema),
});

// ---- Kasbon & reimbursement (HR side) ---------------------------------

export const listEmployeeLoans = defineEndpoint({
  method: "GET",
  path: `${BASE}/loans`,
  query: cursorPageQuerySchema.extend({
    status: employeeLoanStatusSchema.optional(),
    employeeId: employeeIdSchema.optional(),
  }),
  response: cursorPageSchema(employeeLoanSchema),
});

export const decideEmployeeLoan = defineEndpoint({
  method: "POST",
  path: `${BASE}/loans/:employeeLoanId/decision`,
  params: z.strictObject({ employeeLoanId: employeeLoanIdSchema }),
  body: clientInputSchema({
    action: z.enum(["approve", "reject", "cancel"]),
    ...write,
  }),
  response: dataResponseSchema(employeeLoanSchema),
});

export const disburseEmployeeLoan = defineEndpoint({
  method: "POST",
  path: `${BASE}/loans/:employeeLoanId/disburse`,
  params: z.strictObject({ employeeLoanId: employeeLoanIdSchema }),
  body: clientInputSchema(write),
  response: dataResponseSchema(employeeLoanSchema),
});

export const listReimbursementCategories = defineEndpoint({
  method: "GET",
  path: `${BASE}/reimbursement-categories`,
  query: cursorPageQuerySchema,
  response: cursorPageSchema(reimbursementCategorySchema),
});

export const createReimbursementCategory = defineEndpoint({
  method: "POST",
  path: `${BASE}/reimbursement-categories`,
  body: createReimbursementCategoryInputSchema,
  response: dataResponseSchema(reimbursementCategorySchema),
});

export const listReimbursements = defineEndpoint({
  method: "GET",
  path: `${BASE}/reimbursements`,
  query: cursorPageQuerySchema.extend({
    status: reimbursementStatusSchema.optional(),
    employeeId: employeeIdSchema.optional(),
  }),
  response: cursorPageSchema(reimbursementSchema),
});

/** Approver may lower the amount (approvedAmountIdr), never raise it. */
export const decideReimbursement = defineEndpoint({
  method: "POST",
  path: `${BASE}/reimbursements/:reimbursementId/decision`,
  params: z.strictObject({ reimbursementId: reimbursementIdSchema }),
  body: clientInputSchema({
    action: z.enum(["approve", "reject"]),
    approvedAmountIdr:
      createReimbursementInputSchema.shape.amountIdr.nullable(),
    ...write,
  }),
  response: dataResponseSchema(reimbursementSchema),
});

/** Cash payout; payroll payouts are paid by the run lock. */
export const payReimbursementCash = defineEndpoint({
  method: "POST",
  path: `${BASE}/reimbursements/:reimbursementId/pay`,
  params: z.strictObject({ reimbursementId: reimbursementIdSchema }),
  body: clientInputSchema(write),
  response: dataResponseSchema(reimbursementSchema),
});

// ---- Employee self-service (F30 PWA; HR-01 own rows only) ------------

export const listMyPayslips = defineEndpoint({
  method: "GET",
  path: "/api/hris/me/payslips",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(myPayslipSummarySchema),
});

/** PIN in the body; sets viewedAt; PAYSLIP_PIN_INVALID / PAYSLIP_PIN_LOCKED. */
export const viewMyPayslip = defineEndpoint({
  method: "POST",
  path: "/api/hris/me/payslips/:payslipId/view",
  params: z.strictObject({ payslipId: payslipIdSchema }),
  body: viewMyPayslipInputSchema,
  response: dataResponseSchema(payslipSchema),
});

export const listMyLoans = defineEndpoint({
  method: "GET",
  path: "/api/hris/me/loans",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(employeeLoanSchema),
});

export const createMyLoan = defineEndpoint({
  method: "POST",
  path: "/api/hris/me/loans",
  body: createEmployeeLoanInputSchema,
  response: dataResponseSchema(employeeLoanSchema),
});

export const listMyReimbursements = defineEndpoint({
  method: "GET",
  path: "/api/hris/me/reimbursements",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(reimbursementSchema),
});

export const createMyReimbursement = defineEndpoint({
  method: "POST",
  path: "/api/hris/me/reimbursements",
  body: createReimbursementInputSchema,
  response: dataResponseSchema(reimbursementSchema),
});

export const payrollEndpoints = [
  listStatutoryTables,
  getStatutoryTable,
  createStatutoryTableDraft,
  updateStatutoryTableDraft,
  publishStatutoryTable,
  archiveStatutoryTable,
  listPayrollPolicies,
  createPayrollPolicy,
  updatePayrollPolicy,
  listPayComponents,
  createPayComponent,
  updatePayComponent,
  listEmployeePayComponents,
  setEmployeePayComponent,
  listThrSchedules,
  createThrSchedule,
  listPayrollRuns,
  getPayrollRun,
  createPayrollRun,
  simulatePayrollRun,
  listPayrollRunEmployeeResults,
  returnPayrollRunToDraft,
  approvePayrollRunHr,
  approvePayrollRunFinal,
  lockPayrollRun,
  markPayrollRunPaid,
  requestPayrollRunReversal,
  decidePayrollRunReversal,
  listPayrollRunPayslips,
  createBankTransferFile,
  listBankTransferFiles,
  createPayrollTaxExport,
  listServiceChargePools,
  createServiceChargePool,
  calculateServiceChargePool,
  approveServiceChargePool,
  listServiceChargeAllocations,
  listEmployeeLoans,
  decideEmployeeLoan,
  disburseEmployeeLoan,
  listReimbursementCategories,
  createReimbursementCategory,
  listReimbursements,
  decideReimbursement,
  payReimbursementCash,
  listMyPayslips,
  viewMyPayslip,
  listMyLoans,
  createMyLoan,
  listMyReimbursements,
  createMyReimbursement,
] as const;
