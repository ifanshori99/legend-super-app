// legend-svqew: immutable, approved corrections paid by a later payroll run.
import {
  z,
  businessDateSchema,
  clientInputSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  uuidIdSchema,
} from "../../core/index.ts";
import { employeeIdSchema } from "../ids.ts";
import {
  payComponentIdSchema,
  payrollRunIdSchema,
  payslipIdSchema,
} from "./ids.ts";

export const payrollRapelIdSchema = uuidIdSchema<"PayrollRapelId">();
export const payrollRapelStatusSchema = z.enum([
  "pending",
  "hr_approved",
  "approved",
  "allocated",
  "cancelled",
]);

export const createPayrollRapelInputSchema = clientInputSchema({
  employeeId: employeeIdSchema,
  componentId: payComponentIdSchema,
  effectiveFrom: businessDateSchema,
  newAmountIdr: idrSchema.refine((v) => v > 0, "Must be positive"),
  idempotencyKey: idempotencyKeySchema,
});
export const approvePayrollRapelInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});
export const allocatePayrollRapelInputSchema = clientInputSchema({
  payrollRunId: payrollRunIdSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const payrollRapelSchema = z.strictObject({
  id: payrollRapelIdSchema,
  tenantId: tenantIdSchema,
  employeeId: employeeIdSchema,
  componentId: payComponentIdSchema,
  effectiveFrom: businessDateSchema,
  prospectiveFrom: businessDateSchema,
  newAmountIdr: idrSchema,
  totalIdr: idrSchema.refine((v) => v > 0, "Must be positive"),
  status: payrollRapelStatusSchema,
  requestedBy: userIdSchema,
  approvedByHr: userIdSchema.nullable(),
  approvedByFinance: userIdSchema.nullable(),
  payrollRunId: payrollRunIdSchema.nullable(),
  reservedPayslipId: payslipIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
  items: z
    .array(
      z.strictObject({
        sourceRunId: payrollRunIdSchema,
        periodStart: businessDateSchema,
        periodEnd: businessDateSchema,
        amountIdr: idrSchema.refine((v) => v > 0, "Must be positive"),
      }),
    )
    .min(1),
});
export type PayrollRapel = z.infer<typeof payrollRapelSchema>;
export type CreatePayrollRapelInput = z.infer<
  typeof createPayrollRapelInputSchema
>;
export type ApprovePayrollRapelInput = z.infer<
  typeof approvePayrollRapelInputSchema
>;
export type AllocatePayrollRapelInput = z.infer<
  typeof allocatePayrollRapelInputSchema
>;
