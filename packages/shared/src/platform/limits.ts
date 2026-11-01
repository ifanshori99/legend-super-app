// Quotas & cost caps (PRD v1.7 §3 F4 "Kuota & Plafon", §6 A `tenants.limits`,
// §2 Batasan "Biaya operasional", A17, R18).
// - Count quotas: outlets, active employees (Legend default at least 30,
//   PRD D27), devices, AI requests per month. Reaching the quota refuses the
//   next create with QUOTA_EXCEEDED; existing rows are never removed.
// - Monthly cost caps for WhatsApp, AI and email (A17), in whole rupiah:
//   warning at 80% and automatic stop at 100% (R18). Core outlet operation
//   never depends on a capped feature.

import { idrSchema, z } from "../core/index.ts";
import type { Idr } from "../core/index.ts";

const count = z.number().int().min(0).max(1_000_000);
/** Whole rupiah, never negative (caps and monthly spend). */
const nonNegativeIdr = idrSchema.refine((value) => value >= 0, {
  message: "Amount cannot be negative",
});

/** `tenants.limits` JSONB. */
export const tenantLimitsSchema = z.strictObject({
  maxOutlets: count,
  maxActiveEmployees: count,
  maxDevices: count,
  /** "Kuota AI": Tanya AI / AI job requests per calendar month. */
  aiRequestsPerMonth: count,
  whatsappCostCapIdr: nonNegativeIdr,
  aiCostCapIdr: nonNegativeIdr,
  emailCostCapIdr: nonNegativeIdr,
});
export type TenantLimits = z.infer<typeof tenantLimitsSchema>;

/** PRD §3 F4 / D27: Legend needs at least 30 active employees by default. */
export const LEGEND_MIN_ACTIVE_EMPLOYEES = 30;

export const COUNT_QUOTAS = [
  "outlets",
  "active_employees",
  "devices",
  "ai_requests",
] as const;
export const countQuotaSchema = z.enum(COUNT_QUOTAS);
export type CountQuota = z.infer<typeof countQuotaSchema>;

export const COST_CAPS = ["whatsapp", "ai", "email"] as const;
export const costCapSchema = z.enum(COST_CAPS);
export type CostCap = z.infer<typeof costCapSchema>;

const quotaLimitKey = {
  outlets: "maxOutlets",
  active_employees: "maxActiveEmployees",
  devices: "maxDevices",
  ai_requests: "aiRequestsPerMonth",
} as const satisfies Record<CountQuota, keyof TenantLimits>;
const capLimitKey = {
  whatsapp: "whatsappCostCapIdr",
  ai: "aiCostCapIdr",
  email: "emailCostCapIdr",
} as const satisfies Record<CostCap, keyof TenantLimits>;

/** Current usage in one tenant. AI requests and costs are for `month`
 * (YYYY-MM, outlet time zone of the head office = Asia/Jakarta). */
export const tenantUsageSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  outlets: count,
  activeEmployees: count,
  devices: count,
  aiRequests: count,
  whatsappCostIdr: nonNegativeIdr,
  aiCostIdr: nonNegativeIdr,
  emailCostIdr: nonNegativeIdr,
});
export type TenantUsage = z.infer<typeof tenantUsageSchema>;

const quotaUsageKey = {
  outlets: "outlets",
  active_employees: "activeEmployees",
  devices: "devices",
  ai_requests: "aiRequests",
} as const satisfies Record<CountQuota, keyof TenantUsage>;
const capUsageKey = {
  whatsapp: "whatsappCostIdr",
  ai: "aiCostIdr",
  email: "emailCostIdr",
} as const satisfies Record<CostCap, keyof TenantUsage>;

/** Can `adding` more items be created under the quota? */
export function checkCountQuota(
  limits: TenantLimits,
  usage: TenantUsage,
  quota: CountQuota,
  adding = 1,
): { allowed: boolean; limit: number; used: number; remaining: number } {
  const limit = limits[quotaLimitKey[quota]];
  const used = usage[quotaUsageKey[quota]];
  const remaining = Math.max(0, limit - used);
  return {
    allowed: Number.isInteger(adding) && adding >= 0 && used + adding <= limit,
    limit,
    used,
    remaining,
  };
}

/** R18: alert at 80% of the cap, stop at 100%. */
export const COST_CAP_WARNING_BASIS_POINTS = 8_000;

export const costCapStateSchema = z.enum(["ok", "warning", "stopped"]);
export type CostCapState = z.infer<typeof costCapStateSchema>;

/**
 * State of one monthly cost cap. A cap of 0 means the feature is off (PRD §2:
 * WhatsApp replies are off by default), so it is always `stopped`. Integer
 * arithmetic only (bigint spent * 10000 vs cap * 8000), no floating point.
 */
export function evaluateCostCap(
  limits: TenantLimits,
  usage: TenantUsage,
  cap: CostCap,
): { state: CostCapState; capIdr: Idr; spentIdr: Idr; remainingIdr: Idr } {
  const capIdr = limits[capLimitKey[cap]];
  const spentIdr = usage[capUsageKey[cap]];
  const remainingIdr = Math.max(0, capIdr - spentIdr) as Idr;
  let state: CostCapState = "ok";
  if (capIdr === 0 || spentIdr >= capIdr) state = "stopped";
  else if (
    BigInt(spentIdr) * 10_000n >=
    BigInt(capIdr) * BigInt(COST_CAP_WARNING_BASIS_POINTS)
  )
    state = "warning";
  return { state, capIdr, spentIdr, remainingIdr };
}

/** May a capped feature spend `costIdr` more this month? Spending that would
 * cross the cap is refused up front (COST_CAP_REACHED). */
export function canSpend(
  limits: TenantLimits,
  usage: TenantUsage,
  cap: CostCap,
  costIdr: Idr,
): boolean {
  const { capIdr, spentIdr } = evaluateCostCap(limits, usage, cap);
  return (
    Number.isSafeInteger(costIdr) &&
    costIdr >= 0 &&
    BigInt(spentIdr) + BigInt(costIdr) <= BigInt(capIdr)
  );
}
