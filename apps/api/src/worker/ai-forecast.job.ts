// AI-07 forecast job (WS-12 wave 3, bead legend-hkd4). Once per business day
// per outlet it writes the rule-v1 forecast for the next 7 business days. An
// outlet is skipped when it already has a forecast row generated today (outlet
// business date); yesterday's rows never block today's run, which adds the
// newest day. An outlet without history has no rows and reruns, so a relay tick that runs it often costs one cheap
// read. Runs per tenant with the worker's system context (wired by the lead);
// one failing outlet never blocks the others or the relay.
import {
  assertTrustedScopedContext,
  businessDateOf,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { and, eq, inArray, max } from "drizzle-orm";
import { db } from "../db/index.ts";
import { forecasts } from "../db/schema/ai-insights.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { generateForecasts } from "../services/ai-forecast.service.ts";
import { addDays } from "../services/ai-forecast.shared.ts";
import { listJobOutletIds } from "../services/inventory-ops.shared.ts";

/** Minimum time between two runs for one tenant. */
export const AI_FORECAST_JOB_INTERVAL_MS = 10 * 60_000;
export const AI_FORECAST_JOB_DAYS = 7;

export type AiForecastJobResult = {
  outlets: number;
  generatedOutlets: number;
  skippedOutlets: number;
  failedOutlets: number;
  rows: number;
};

const lastRunByTenant = new Map<string, number>();

export async function runAiForecastJob(
  context: ScopedTenantContext,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): Promise<AiForecastJobResult | null> {
  assertTrustedScopedContext(context);
  const tenantId = context.tenant.tenantId;
  const last = lastRunByTenant.get(tenantId);
  if (
    !options.force &&
    last !== undefined &&
    now.getTime() - last < AI_FORECAST_JOB_INTERVAL_MS
  )
    return null;
  lastRunByTenant.set(tenantId, now.getTime());

  const clocks = await withTenant(db, context, async (tx) => {
    const ids = await listJobOutletIds(tx, context);
    if (ids.length === 0) return [];
    return tx
      .select({
        id: outlets.id,
        timeZone: outlets.timezone,
        cutoff: outlets.businessDayCutoff,
      })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), inArray(outlets.id, ids)));
  });
  const result: AiForecastJobResult = {
    outlets: clocks.length,
    generatedOutlets: 0,
    skippedOutlets: 0,
    failedOutlets: 0,
    rows: 0,
  };
  for (const outlet of clocks) {
    try {
      const clock = { timeZone: outlet.timeZone, cutoff: outlet.cutoff };
      const today = businessDateOf(now, clock);
      const tomorrow = addDays(today, 1);
      const [latest] = await withTenant(db, context, (tx) =>
        tx
          .select({ at: max(forecasts.generatedAt) })
          .from(forecasts)
          .where(
            and(
              eq(forecasts.tenantId, tenantId),
              eq(forecasts.outletId, outlet.id),
            ),
          ),
      );
      if (latest?.at && businessDateOf(latest.at, clock) === today) {
        result.skippedOutlets += 1;
        continue;
      }
      result.rows += await generateForecasts(context, {
        outletId: outlet.id,
        fromDate: tomorrow,
        days: AI_FORECAST_JOB_DAYS,
      });
      result.generatedOutlets += 1;
    } catch {
      result.failedOutlets += 1;
      console.error("AI forecast generation failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetAiForecastJobThrottle(): void {
  lastRunByTenant.clear();
}
