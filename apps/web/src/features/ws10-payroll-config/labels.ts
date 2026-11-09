// Catalog keys for every payroll-configuration enum the screens render. The
// values are data from the contract; the text is always the catalog's
// (DESIGN.md "Do"). Imported by components and by the pure helpers in lib.ts.
import type { MessageKey } from "@starter/shared/i18n";
import type { EmploymentType } from "@starter/shared/hris";
import type {
  PayComponentCategory,
  PayComponentKind,
  PayComponentRecurrence,
  TaxScheme,
} from "@starter/shared/hris/payroll";

export const EMPLOYMENT_TYPE_KEYS: Record<EmploymentType, MessageKey> = {
  pkwtt: "payrollConfig.employmentTypes.pkwtt",
  pkwt: "payrollConfig.employmentTypes.pkwt",
  daily: "payrollConfig.employmentTypes.daily",
  intern: "payrollConfig.employmentTypes.intern",
};

export const PAY_COMPONENT_CATEGORY_KEYS: Record<
  PayComponentCategory,
  MessageKey
> = {
  base_salary: "payrollConfig.categories.base_salary",
  fixed_allowance: "payrollConfig.categories.fixed_allowance",
  variable_allowance: "payrollConfig.categories.variable_allowance",
  meal_allowance: "payrollConfig.categories.meal_allowance",
  transport_allowance: "payrollConfig.categories.transport_allowance",
  incentive: "payrollConfig.categories.incentive",
  overtime: "payrollConfig.categories.overtime",
  service_charge: "payrollConfig.categories.service_charge",
  thr: "payrollConfig.categories.thr",
  bonus: "payrollConfig.categories.bonus",
  reimbursement: "payrollConfig.categories.reimbursement",
  tax_allowance: "payrollConfig.categories.tax_allowance",
  late_deduction: "payrollConfig.categories.late_deduction",
  loan_installment: "payrollConfig.categories.loan_installment",
  bpjs_employee: "payrollConfig.categories.bpjs_employee",
  pph21: "payrollConfig.categories.pph21",
  pph21_receivable: "payrollConfig.categories.pph21_receivable",
  custom_earning: "payrollConfig.categories.custom_earning",
  custom_deduction: "payrollConfig.categories.custom_deduction",
};

export const PAY_COMPONENT_KIND_KEYS: Record<PayComponentKind, MessageKey> = {
  earning: "payrollConfig.components.kind.earning",
  deduction: "payrollConfig.components.kind.deduction",
};

export const PAY_COMPONENT_RECURRENCE_KEYS: Record<
  PayComponentRecurrence,
  MessageKey
> = {
  fixed: "payrollConfig.components.recurrence.fixed",
  variable: "payrollConfig.components.recurrence.variable",
};

export const TAX_SCHEME_KEYS: Record<TaxScheme, MessageKey> = {
  gross: "payrollConfig.taxScheme.gross",
  gross_up: "payrollConfig.taxScheme.gross_up",
  net: "payrollConfig.taxScheme.net",
};

/** Categories in contract order, for the category picker. */
export const PAY_COMPONENT_CATEGORIES: readonly PayComponentCategory[] = [
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
];

export const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  "pkwtt",
  "pkwt",
  "daily",
  "intern",
];
