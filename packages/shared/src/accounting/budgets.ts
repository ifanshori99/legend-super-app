// Budgets (PRD v1.7 §3.19 "Anggaran [P0] — Anggaran per akun dan outlet dengan
// laporan realisasi"; §6 F `budgets`: legal_entity_id, outlet_id, account_id,
// period, amount_idr).

import { z } from "zod";
import {
  divideRounded,
  idrSchema,
  outletIdSchema,
  tenantIdSchema,
} from "../core/index.ts";
import type { Idr, RoundingMode } from "../core/index.ts";
import { accountIdSchema, budgetIdSchema, legalEntityIdSchema } from "./ids.ts";
import { periodKeySchema } from "./period-key.ts";

const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Amount must be >= 0");

export const budgetSchema = z.strictObject({
  id: budgetIdSchema,
  tenantId: tenantIdSchema,
  legalEntityId: legalEntityIdSchema,
  /** null = whole legal entity. */
  outletId: outletIdSchema.nullable(),
  accountId: accountIdSchema,
  period: periodKeySchema,
  amountIdr: nonNegativeIdr,
});
export type Budget = z.infer<typeof budgetSchema>;

/** Bulk upsert, unique per (legal entity, outlet, account, period). */
export const upsertBudgetsInputSchema = z.strictObject({
  legalEntityId: legalEntityIdSchema,
  rows: z
    .array(
      z.strictObject({
        outletId: outletIdSchema.nullable(),
        accountId: accountIdSchema,
        period: periodKeySchema,
        amountIdr: nonNegativeIdr,
      }),
    )
    .min(1)
    .max(500)
    .refine((rows) => {
      const keys = rows.map(
        (row) => `${row.outletId}|${row.accountId}|${row.period}`,
      );
      return new Set(keys).size === keys.length;
    }, "One row per outlet, account and period"),
});

/** Rounding of the variance percentage (display only, never posted). */
export const BUDGET_VARIANCE_ROUNDING: RoundingMode = "half_up";

export const budgetVsActualRowSchema = z.strictObject({
  accountId: accountIdSchema,
  accountCode: z.string(),
  accountName: z.string(),
  outletId: outletIdSchema.nullable(),
  budgetIdr: nonNegativeIdr,
  /** Natural-sign actual (revenue as credit, expense as debit). */
  actualIdr: idrSchema,
  varianceIdr: idrSchema,
  /** variance / budget in basis points; null when the budget is 0. */
  varianceBp: z.number().int().nullable(),
});
export type BudgetVsActualRow = z.infer<typeof budgetVsActualRowSchema>;

/** variance = actual − budget; percentage in bp rounded half_up. */
export function budgetVariance(
  budgetIdr: number,
  actualIdr: number,
): { varianceIdr: Idr; varianceBp: number | null } {
  const varianceIdr = (actualIdr - budgetIdr) as Idr;
  const varianceBp =
    budgetIdr === 0
      ? null
      : Number(
          divideRounded(
            BigInt(varianceIdr) * 10_000n,
            BigInt(budgetIdr),
            BUDGET_VARIANCE_ROUNDING,
          ),
        );
  return { varianceIdr, varianceBp };
}
