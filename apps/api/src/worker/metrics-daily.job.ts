// WS-11 metrics_daily sweep (bead legend-5wzoc; design §2.5). Runs from the
// worker tick per tenant. Per open outlet it refreshes today and the last
// `METRICS_DAILY_REFRESH_DAYS` business dates (late and offline data moves
// recent days). The service takes a per (tenant, outlet, date) advisory lock
// and writes only changed rows, so a restart or a second worker is harmless.
// A failing outlet or family never blocks the others.
//
// Catch-up pass: a day a reader still holds (`pendingDay`, e.g. a delivery
// order in flight) can outlive the window. Each sweep also refreshes, for
// those readers only, older outlet-dates (up to `METRICS_DAILY_CATCH_UP_DAYS`
// back) that still hold their `estimate` rows, so the day turns final and its
// value follows once the hold ends.
import { sql } from "drizzle-orm";
import {
  addBusinessDays,
  assertTrustedScopedContext,
  businessDateOf,
  businessDateSchema,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  METRICS_DAILY_SETTLE_MS,
  refreshMetricsDaily,
  type MetricsDailyOptions,
} from "../services/metrics-daily.service.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { dailyReaders } from "../services/metric-sources/index.ts";
import { jobOutletClocks } from "./ai-anomaly.job.ts";

export { METRICS_DAILY_SETTLE_MS };

/** Minimum time between two sweeps of one tenant. */
export const METRICS_DAILY_INTERVAL_MS = 15 * 60_000;
/** Business dates before today that each sweep refreshes. */
export const METRICS_DAILY_REFRESH_DAYS = 7;
/** Oldest business date (days before today) the catch-up pass revisits. */
export const METRICS_DAILY_CATCH_UP_DAYS = 90;

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

/**
 * Outlet-dates older than the refresh window, at most
 * `METRICS_DAILY_CATCH_UP_DAYS` back, that still hold `estimate` rows of
 * `codes` (the codes of readers with a `pendingDay` hold), oldest first.
 */
export async function metricsDailyCatchUpTargets(
  context: ScopedTenantContext,
  now: Date,
  codes: readonly string[],
): Promise<{ outletId: string; businessDate: BusinessDate }[]> {
  if (codes.length === 0) return [];
  const targets: { outletId: string; businessDate: BusinessDate }[] = [];
  for (const { outletId, clock } of await jobOutletClocks(context)) {
    const today = businessDateOf(now, clock);
    const rows = await withTenant(db, context, (tx) =>
      tx.execute(sql`
        SELECT DISTINCT metric_date::text AS business_date
          FROM metrics_daily
         WHERE tenant_id = ${context.tenant.tenantId}
           AND outlet_id = ${outletId}
           AND finality = 'estimate'
           AND metric_date >= ${addBusinessDays(today, -METRICS_DAILY_CATCH_UP_DAYS)}
           AND metric_date < ${addBusinessDays(today, -METRICS_DAILY_REFRESH_DAYS)}
           AND metric_code IN (${sql.join(
             codes.map((code) => sql`${code}`),
             sql`, `,
           )})
         ORDER BY 1`),
    );
    for (const row of rows.rows)
      targets.push({
        outletId,
        businessDate: businessDateSchema.parse(String(row.business_date)),
      });
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
  const readers = options.readers ?? dailyReaders();
  const heldReaders = readers.filter(({ reader }) => reader.pendingDay);
  const targets: {
    outletId: string;
    businessDate: BusinessDate;
    options: MetricsDailyOptions;
  }[] = [
    ...(
      await metricsDailyCatchUpTargets(
        context,
        now,
        heldReaders.flatMap(({ reader }) => reader.metricCodes),
      )
    ).map((target) => ({ ...target, options: { readers: heldReaders } })),
    ...(await metricsDailyTargets(context, now)).map((target) => ({
      ...target,
      options: { readers },
    })),
  ];
  const result: MetricsDailyJobResult = {
    outlets: new Set(targets.map((target) => target.outletId)).size,
    failedOutlets: 0,
    written: 0,
    deleted: 0,
  };
  const failed = new Set<string>();
  for (const target of targets) {
    try {
      const outcome = await refreshMetricsDaily(
        context,
        { outletId: target.outletId, businessDate: target.businessDate },
        now,
        target.options,
      );
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
