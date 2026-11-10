// AI-10 daily summary sweep (WS-12 wave 3, part A; bead legend-lely). Runs
// from the worker tick per tenant (wired by the lead). Per open outlet it
// handles the business dates of the refresh window (the last
// `DAILY_SUMMARY_REFRESH_DAYS` days) whose day has settled: day end (cutoff)
// + `DAILY_SUMMARY_SETTLE_MS`, so late and offline orders are in. The service
// writes a new day once (notified), refreshes a recent day only when its
// metrics moved, and takes a per (tenant, outlet, date) advisory lock, so a
// restart or a second worker never pays for or notifies the same day twice.
import {
  addBusinessDays,
  assertTrustedScopedContext,
  businessDateOf,
  businessDayRange,
  type BusinessDate,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  DAILY_SUMMARY_REFRESH_DAYS,
  DAILY_SUMMARY_SETTLE_MS,
  generateDailySummary,
} from "../services/ai-daily-summary.service.ts";
import {
  AI_INSIGHT_JOB_INTERVAL_MS,
  jobOutletClocks,
  type AiInsightJobResult,
} from "./ai-anomaly.job.ts";

const lastRunByTenant = new Map<string, number>();

/** Settled business dates of the refresh window, oldest first. */
export async function dailySummaryTargets(
  context: ScopedTenantContext,
  now: Date,
): Promise<{ outletId: string; businessDate: BusinessDate }[]> {
  const targets: { outletId: string; businessDate: BusinessDate }[] = [];
  for (const { outletId, clock } of await jobOutletClocks(context)) {
    const today = businessDateOf(now, clock);
    for (let back = DAILY_SUMMARY_REFRESH_DAYS; back >= 1; back -= 1) {
      const businessDate = addBusinessDays(today, -back);
      const settledAt =
        businessDayRange(businessDate, clock).end.getTime() +
        DAILY_SUMMARY_SETTLE_MS;
      if (now.getTime() >= settledAt) targets.push({ outletId, businessDate });
    }
  }
  return targets;
}

export async function runAiDailySummaryJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<AiInsightJobResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < AI_INSIGHT_JOB_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());
  const targets = await dailySummaryTargets(context, now);
  const outletIds = new Set(targets.map((target) => target.outletId));
  const result: AiInsightJobResult = {
    outlets: outletIds.size,
    failedOutlets: 0,
    created: 0,
  };
  const failed = new Set<string>();
  for (const target of targets) {
    try {
      const outcome = await generateDailySummary(
        context,
        { tenantId, ...target },
        now,
      );
      if (outcome.status === "created") result.created += 1;
    } catch {
      failed.add(target.outletId);
      console.error("AI daily summary failed for an outlet");
    }
  }
  result.failedOutlets = failed.size;
  return result;
}

/** Test hook: forget the throttle state. */
export function resetAiDailySummaryJobThrottle(): void {
  lastRunByTenant.clear();
}
