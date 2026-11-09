// WS-11 metrics_daily sweep (bead legend-5wzoc; design §2.5). Runs from the
// worker tick per tenant. Per open outlet it refreshes today and the last
// `METRICS_DAILY_REFRESH_DAYS` business dates (late and offline data moves
// recent days). The service takes a per (tenant, outlet, date) advisory lock
// and writes only changed rows, so a restart or a second worker is harmless.
// A failing outlet or family never blocks the others.
import {
  addBusinessDays,
  assertTrustedScopedContext,
  businessDateOf,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  METRICS_DAILY_SETTLE_MS,
  refreshMetricsDaily,
  type MetricsDailyOptions,
} from "../services/metrics-daily.service.ts";
import { jobOutletClocks } from "./ai-anomaly.job.ts";

export { METRICS_DAILY_SETTLE_MS };

/** Minimum time between two sweeps of one tenant. */
export const METRICS_DAILY_INTERVAL_MS = 15 * 60_000;
/** Business dates before today that each sweep refreshes. */
export const METRICS_DAILY_REFRESH_DAYS = 7;

export type MetricsDailyJobResult = {
  outlets: number;
  failedOutlets: number;
  written: number;
  deleted: number;
};

const lastRunByTenant = new Map<string, number>();

/** Today and the refresh window of every open outlet, oldest first. */
export async function metricsDailyTargets(
  context: ScopedTenantContext,
  now: Date,
): Promise<{ outletId: string; businessDate: BusinessDate }[]> {
  const targets: { outletId: string; businessDate: BusinessDate }[] = [];
  for (const { outletId, clock } of await jobOutletClocks(context)) {
    const today = businessDateOf(now, clock);
    for (let back = METRICS_DAILY_REFRESH_DAYS; back >= 0; back -= 1)
      targets.push({ outletId, businessDate: addBusinessDays(today, -back) });
  }
  return targets;
}

export async function runMetricsDailyJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } & MetricsDailyOptions = {},
): Promise<MetricsDailyJobResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < METRICS_DAILY_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const targets = await metricsDailyTargets(context, now);
  const result: MetricsDailyJobResult = {
    outlets: new Set(targets.map((target) => target.outletId)).size,
    failedOutlets: 0,
    written: 0,
    deleted: 0,
  };
  const failed = new Set<string>();
  for (const target of targets) {
    try {
      const outcome = await refreshMetricsDaily(context, target, now, options);
      result.written += outcome.written;
      result.deleted += outcome.deleted;
      if (outcome.failedFamilies.length > 0) failed.add(target.outletId);
    } catch {
      failed.add(target.outletId);
      console.error("Metrics daily refresh failed for an outlet");
    }
  }
  result.failedOutlets = failed.size;
  return result;
}

/** Test hook: forget the throttle state. */
export function resetMetricsDailyJobThrottle(): void {
  lastRunByTenant.clear();
}
