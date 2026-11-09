// Pay components (PRD v1.7 §3 D.30 "Komponen Gaji": gaji pokok, tunjangan
// tetap dan tidak tetap, uang makan dan transport, insentif, lembur, potongan
// keterlambatan, kasbon, dan komponen lain yang dibuat admin, dengan sifat kena
// pajak dan dasar BPJS yang dapat diatur; §6 H `pay_components` /
// `employee_pay_components`).
//
// Per-employee amounts are salary data (HR-03): `employee_pay_components.
// amount_encrypted` is encrypted at rest and only payroll roles read it. The
// DTO below is served only behind `payroll.view`.

import {
  z,
  tenantIdSchema,
  idrSchema,
  businessDateSchema,
  isoDateTimeSchema,
  clientInputSchema,
  idempotencyKeySchema,
} from "../../core/index.ts";
import { employeeIdSchema } from "../ids.ts";
import { employeePayComponentIdSchema, payComponentIdSchema } from "./ids.ts";

/** earning adds to gross; deduction reduces net. */
export const payComponentKindSchema = z.enum(["earning", "deduction"]);
export type PayComponentKind = z.infer<typeof payComponentKindSchema>;

/**
 * Category drives which engine step fills the line. `custom_*` are admin-made
 * components; the others are system components the engine computes or reads.
 */
export const PAY_COMPONENT_CATEGORIES = [
  "base_salary",
  "fixed_allowance",
  "variable_allowance",
  "meal_allowance",
  "transport_allowance",
  "incentive",
  "overtime",
  "service_charge",
  "thr",
  "bonus",
  "reimbursement",
  "tax_allowance",
  "late_deduction",
  "loan_installment",
  "bpjs_employee",
  "pph21",
  "pph21_receivable",
  "custom_earning",
  "custom_deduction",
] as const;
export const payComponentCategorySchema = z.enum(PAY_COMPONENT_CATEGORIES);
export type PayComponentCategory = z.infer<typeof payComponentCategorySchema>;

const DEDUCTION_CATEGORIES: ReadonlySet<PayComponentCategory> = new Set([
  "late_deduction",
  "loan_installment",
  "bpjs_employee",
  "pph21",
  "pph21_receivable",
  "custom_deduction",
]);

export function payComponentKindOf(
  category: PayComponentCategory,
): PayComponentKind {
  return DEDUCTION_CATEGORIES.has(category) ? "deduction" : "earning";
}

/**
 * PPh 21 scheme per component (PRD §3 D.30 PPh 21 "skema gross, gross-up,
 * atau net per komponen"): gross = withheld from the employee; gross_up = the
 * employer adds a tax allowance equal to the tax; net = the employer bears the
 * tax without an allowance line.
 */
export const taxSchemeSchema = z.enum(["gross", "gross_up", "net"]);
export type TaxScheme = z.infer<typeof taxSchemeSchema>;

/** fixed = same each period (employee amount); variable = from inputs. */
export const payComponentRecurrenceSchema = z.enum(["fixed", "variable"]);
export type PayComponentRecurrence = z.infer<
  typeof payComponentRecurrenceSchema
>;

const code = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{1,29}$/,
    "Component codes are 2-30 chars: A-Z, 0-9 and _",
  );

const payComponentFields = {
  code,
  name: z.string().trim().min(1).max(100),
  category: payComponentCategorySchema,
  recurrence: payComponentRecurrenceSchema,
  /** Counts toward PPh 21 gross (penghasilan bruto). */
  taxable: z.boolean(),
  taxScheme: taxSchemeSchema,
  /** Counts toward the BPJS contribution wage (dasar BPJS). */
  bpjsBase: z.boolean(),
  /** Counts toward the overtime monthly base. */
  overtimeBase: z.boolean(),
  /** Counts toward the THR wage. */
  thrBase: z.boolean(),
  displayOrder: z.number().int().min(0).max(999),
};

function checkComponentFlags(
  value: {
    category: PayComponentCategory;
    taxable: boolean;
    bpjsBase: boolean;
    overtimeBase: boolean;
    thrBase: boolean;
  },
  ctx: z.RefinementCtx,
) {
  if (payComponentKindOf(value.category) === "deduction") {
    // Deductions never form a wage base; tax/BPJS lines are outputs.
    for (const flag of [
      "taxable",
      "bpjsBase",
      "overtimeBase",
      "thrBase",
    ] as const)
      if (value[flag])
        ctx.addIssue({
          code: "custom",
          path: [flag],
          message: "Deductions cannot be taxable or part of a wage base",
        });
  }
  if (value.category === "reimbursement" && value.taxable)
    ctx.addIssue({
      code: "custom",
      path: ["taxable"],
      message:
        "Reimbursement repays an expense and is not income (PRD §3 D.31)",
    });
}

/** PRD §6 H `pay_components`: code, name, type, taxable, bpjs_base. */
export const payComponentSchema = z
  .strictObject({
    id: payComponentIdSchema,
    tenantId: tenantIdSchema,
    ...payComponentFields,
    kind: payComponentKindSchema,
    /** System components cannot be deleted or change category. */
    isSystem: z.boolean(),
    isActive: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((value, ctx) => {
    checkComponentFlags(value, ctx);
    if (value.kind !== payComponentKindOf(value.category))
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: "kind must follow the category",
      });
  });
export type PayComponent = z.infer<typeof payComponentSchema>;

export const createPayComponentInputSchema = clientInputSchema({
  ...payComponentFields,
  idempotencyKey: idempotencyKeySchema,
}).superRefine(checkComponentFlags);

/** Edits name/flags/order; code and category are fixed once created. */
export const updatePayComponentInputSchema = clientInputSchema({
  name: payComponentFields.name.optional(),
  taxable: z.boolean().optional(),
  taxScheme: taxSchemeSchema.optional(),
  bpjsBase: z.boolean().optional(),
  overtimeBase: z.boolean().optional(),
  thrBase: z.boolean().optional(),
  displayOrder: payComponentFields.displayOrder.optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePayComponentInput = z.infer<
  typeof updatePayComponentInputSchema
>;
export type CreatePayComponentInput = z.infer<
  typeof createPayComponentInputSchema
>;

/**
 * PRD §6 H `employee_pay_components`: employee_id, component_id,
 * amount_encrypted, effective_from. Amount per period for fixed components
 * (e.g. monthly base salary, daily rate for daily workers). Salary data:
 * payroll roles only (HR-03).
 */
export const employeePayComponentSchema = z
  .strictObject({
    id: employeePayComponentIdSchema,
    tenantId: tenantIdSchema,
    employeeId: employeeIdSchema,
    componentId: payComponentIdSchema,
    amountIdr: idrSchema.refine((v) => v >= 0, "Amount must not be negative"),
    effectiveFrom: businessDateSchema,
    /** Inclusive last day; null = open-ended. */
    effectiveTo: businessDateSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .refine((v) => v.effectiveTo === null || v.effectiveTo >= v.effectiveFrom, {
    path: ["effectiveTo"],
    message: "effectiveTo cannot precede effectiveFrom",
  });
export type EmployeePayComponent = z.infer<typeof employeePayComponentSchema>;

/** Sets an amount from a date; the server closes the previous row. */
export const setEmployeePayComponentInputSchema = clientInputSchema({
  componentId: payComponentIdSchema,
  amountIdr: idrSchema.refine((v) => v >= 0, "Amount must not be negative"),
  effectiveFrom: businessDateSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type SetEmployeePayComponentInput = z.infer<
  typeof setEmployeePayComponentInputSchema
>;
