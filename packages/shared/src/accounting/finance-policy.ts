// Tenant finance policy (legend-pxcs; PRD v1.7 §3.19, ACC-04 matching date
// tolerance, ACC-05 "batas hari" for cash left undeposited). One policy per
// tenant. The knobs reuse the schemas that already validate them in banking.ts,
// so a stored policy always satisfies the matching and alert functions.

import { z } from "../core/index.ts";
import {
  cashDepositPolicySchema,
  matchingPolicySchema,
  reconciliationPolicySchema,
} from "./banking.ts";

/**
 * Defaults when a tenant has no stored policy (PRD: 2 days / 2 days; legend-fnxl.9:
 * reconciliation cases are due after 7 days).
 */
export const DEFAULT_FINANCE_POLICY = Object.freeze({
  cashDepositPolicy: Object.freeze({ maxDaysUndeposited: 2 }),
  matchingPolicy: Object.freeze({ dateToleranceDays: 2 }),
  reconciliationPolicy: Object.freeze({ caseDueDays: 7 }),
});

/** Wire shape of GET/PUT `/finance-policy`; strict, no tenant id (TEN-02). */
export const financePolicySchema = z.strictObject({
  cashDepositPolicy: cashDepositPolicySchema,
  matchingPolicy: matchingPolicySchema,
  reconciliationPolicy: reconciliationPolicySchema,
});
export type FinancePolicy = z.infer<typeof financePolicySchema>;

/** PUT replaces the whole policy, so the body is the policy itself. */
export const putFinancePolicyInputSchema = financePolicySchema;
export type PutFinancePolicyInput = FinancePolicy;
