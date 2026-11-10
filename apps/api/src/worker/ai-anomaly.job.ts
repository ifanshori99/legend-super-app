// AI-09 anomaly sweep (WS-12 wave 3, part A; bead legend-lely). Runs from the
// worker tick per tenant (wired by the lead). For each open outlet it
// evaluates the PREVIOUS business date of that outlet's clock once; the
// in-memory marker only saves work, the unique key (tenant, outlet, date,
// kind) keeps a re-run (restart, second worker) from duplicating alerts or
// notifications. A failing outlet never blocks the others.
import { and, eq, sql } from "drizzle-orm";
import {
  addBusinessDays,
  assertTrustedScopedContext,
  businessDateOf,
  type BusinessDate,
  type BusinessDayClock,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { detectAnomalies } from "../services/ai-anomaly.service.ts";
import { outletBusinessDayClock } from "../services/outlet-clock.ts";

/** Minimum time between two sweeps of one tenant. */
export const AI_INSIGHT_JOB_INTERVAL_MS = 15 * 60_000;

export type AiInsightJobResult = {
  outlets: number;
  failedOutlets: number;
  created: number;
};

/** Open outlets of the tenant with their business-day clock. */
export async function jobOutletClocks(
  context: ScopedTenantContext,
): Promise<{ outletId: string; clock: BusinessDayClock }[]> {
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select({
        id: outlets.id,
        timezone: outlets.timezone,
        businessDayCutoff: outlets.businessDayCutoff,
      })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          sql`${outlets.status} <> 'closed'`,
        ),
      )
      .orderBy(outlets.id),
  );
  return rows.map((row) => ({
    outletId: String(row.id),
    clock: outletBusinessDayClock({
      timezone: row.timezone,
      businessDayCutoff: row.businessDayCutoff,
    }),
  }));
}

/** Open outlets of the tenant with the business date that just closed. */
export async function previousBusinessDates(
  context: ScopedTenantContext,
  now: Date,
): Promise<{ outletId: string; businessDate: BusinessDate }[]> {
  return (await jobOutletClocks(context)).map(({ outletId, clock }) => ({
    outletId,
    businessDate: addBusinessDays(businessDateOf(now, clock), -1),
  }));
}

const lastRunByTenant = new Map<string, number>();
const doneByOutlet = new Map<string, string>();

export async function runAiAnomalyJob(
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
  const targets = await previousBusinessDates(context, now);
  const result: AiInsightJobResult = {
    outlets: targets.length,
    failedOutlets: 0,
    created: 0,
  };
  for (const target of targets) {
    const key = `${tenantId}:${target.outletId}`;
    if (!options.force && doneByOutlet.get(key) === target.businessDate)
      continue;
    try {
      const outcome = await detectAnomalies(context, target, now);
      result.created += outcome.created;
      doneByOutlet.set(key, target.businessDate);
    } catch {
      result.failedOutlets += 1;
      console.error("AI anomaly evaluation failed for an outlet");
    }
  }
  return result;
}

/** Test hook: forget the throttle state. */
export function resetAiAnomalyJobThrottle(): void {
  lastRunByTenant.clear();
  doneByOutlet.clear();
}
