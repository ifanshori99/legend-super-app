// One strict salary arithmetic contract for historical sources, final writes,
// and authenticated envelope metadata during key rotation.
import { idrSchema, z } from "@starter/shared/core";
import {
  payComponentKindOf,
  payrollRunIdSchema,
  payslipLineSchema,
} from "@starter/shared/hris/payroll";

// Older gross-engine callers stored this exact sealed envelope directly on
// the payslip. Its row AAD and the tenant-scoped payslip/run foreign keys bind
// the missing metadata. Unknown/full metadata never gets stripped to fit it.
export const PAYROLL_ALLOCATION_REVISION_MAX = 2_147_483_647;

export const payrollGrossEnvelopeSchema = z
  .strictObject({
    grossIdr: idrSchema.refine((v) => v >= 0),
    deductionsIdr: idrSchema.refine((v) => v >= 0),
    netIdr: idrSchema.refine((v) => v >= 0),
    overtimeIdr: idrSchema.refine((v) => v >= 0),
    lines: z.array(payslipLineSchema),
    payrollRunId: payrollRunIdSchema.optional(),
    rapelAllocationRevision: z
      .number()
      .int()
      .min(0)
      .max(PAYROLL_ALLOCATION_REVISION_MAX)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const earning = value.lines
      .filter((line) => line.kind === "earning")
      .reduce((sum, line) => sum + BigInt(line.amountIdr), 0n);
    const deduction = value.lines
      .filter((line) => line.kind === "deduction")
      .reduce((sum, line) => sum + BigInt(line.amountIdr), 0n);
    const overtime = value.lines
      .filter((line) => line.category === "overtime" && line.kind === "earning")
      .reduce((sum, line) => sum + BigInt(line.amountIdr), 0n);
    if (
      earning !== BigInt(value.grossIdr) ||
      deduction !== BigInt(value.deductionsIdr) ||
      earning - deduction !== BigInt(value.netIdr) ||
      overtime !== BigInt(value.overtimeIdr) ||
      (value.rapelAllocationRevision !== undefined &&
        value.payrollRunId === undefined) ||
      value.lines.some(
        (line) =>
          line.kind !== payComponentKindOf(line.category) ||
          (line.kind === "deduction" && line.taxable),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Gross envelope arithmetic does not balance",
      });
  });
