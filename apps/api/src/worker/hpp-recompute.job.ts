// HPP recompute job (bead legend-2qq; PRD v1.7 §17 "HPP Menu": menu cost
// follows an ingredient price change within 5 minutes). Drains the tenant's
// `hpp_recompute_queue` from the worker relay tick; the interval is far below
// the 5 minute SLA. Failures never block the relay: the claimed rows roll back
// with the failed batch and stay queued for the next run.

import {
  assertTrustedScopedContext,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  runHppRecompute,
  type HppRecomputeResult,
} from "../services/hpp-recompute.service.ts";

/** Minimum time between two runs for one tenant. */
export const HPP_RECOMPUTE_JOB_INTERVAL_MS = 60_000;

const lastRunByTenant = new Map<string, number>();

export async function runHppRecomputeJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<HppRecomputeResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < HPP_RECOMPUTE_JOB_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  return runHppRecompute(context, { now });
}

/** Test hook: forget the throttle state. */
export function resetHppRecomputeJobThrottle(): void {
  lastRunByTenant.clear();
}
