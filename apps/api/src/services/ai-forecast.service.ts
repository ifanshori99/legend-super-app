// AI-07 demand forecast, rule-based (WS-12 wave 3, bead legend-hkd4).
//
// Model `rule-v1`: for a target date and hour, the mean of the same weekday and
// hour over the last 8 weeks of orders. A history day counts only when the
// outlet took at least one order that day (a closed Monday is not a zero
// Monday), so an outlet with fewer than 8 weeks of history averages the weeks
// it has; no history at all writes no rows. Orders that are not voided count;
// sales are `total_idr`, orders are the row count and covers are the distinct
// table sessions plus every order without a session. The hour is the outlet's
// local hour of `placed_at`; the date is the order's business date.
//
// `generateForecasts` is the worker write (system context); `listForecasts` is
// the read behind GET /api/ai/forecasts (`report.sales.view`).
import { and, asc, eq, gte, lte, ne, sql } from "drizzle-orm";
import {
  forecastMetricCodes,
  forecastRowSchema,
  type ForecastMetricCode,
  type ForecastRow,
} from "@starter/shared/ai";
import type {
  OutletId,
  ScopedTenantContext,
  TenantId,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { forecasts } from "../db/schema/ai-insights.ts";
import { orders } from "../db/schema/qr-order.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import {
  addDays,
  requireOutletContext,
  weekdayOf,
} from "./ai-forecast.shared.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

export const FORECAST_MODEL_VERSION = "rule-v1" as const;
export const FORECAST_HISTORY_WEEKS = 8;
export const FORECAST_MAX_DAYS = 31;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ForecastCell = {
  targetDate: string;
  hour: number;
  metricCode: ForecastMetricCode;
  value: number;
};

type HourTotals = { sales: number; orders: number; covers: number };

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The rule-v1 cells for `days` days from `fromDate`, read from order history
 * before `fromDate`. Pure read: `getRosterInputs` reuses it as the baseline
 * when nothing has been generated yet.
 */
export async function computeRuleForecast(
  tx: Tx,
  tenantId: string,
  outletId: string,
  fromDate: string,
  days: number,
): Promise<ForecastCell[]> {
  const [outlet] = await tx
    .select({ timeZone: outlets.timezone })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)));
  if (!outlet) return [];

  const historyFrom = addDays(fromDate, -7 * FORECAST_HISTORY_WEEKS);
  const historyTo = addDays(fromDate, -1);
  const hourOf = sql<number>`extract(hour from ${orders.placedAt} at time zone ${outlet.timeZone}::text)::int`;
  const rows = await tx
    .select({
      date: orders.businessDate,
      hour: hourOf,
      sales: sql<string>`coalesce(sum(${orders.totalIdr}), 0)::text`,
      orders: sql<number>`count(*)::int`,
      sessions: sql<number>`count(distinct ${orders.tableSessionId})::int`,
      withoutSession: sql<number>`(count(*) filter (where ${orders.tableSessionId} is null))::int`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId as TenantId),
        eq(orders.outletId, outletId as OutletId),
        ne(orders.status, "voided"),
        gte(orders.businessDate, historyFrom),
        lte(orders.businessDate, historyTo),
      ),
    )
    .groupBy(sql`1`, sql`2`);

  const byDate = new Map<string, Map<number, HourTotals>>();
  for (const row of rows) {
    const hours = byDate.get(row.date) ?? new Map<number, HourTotals>();
    hours.set(Number(row.hour), {
      sales: Number(row.sales),
      orders: Number(row.orders),
      covers: Number(row.sessions) + Number(row.withoutSession),
    });
    byDate.set(row.date, hours);
  }

  const cells: ForecastCell[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const targetDate = addDays(fromDate, offset);
    const weekday = weekdayOf(targetDate);
    const samples: Map<number, HourTotals>[] = [];
    for (let back = 7 * FORECAST_HISTORY_WEEKS; back >= 1; back -= 1) {
      const date = addDays(fromDate, -back);
      const hours = byDate.get(date);
      if (hours && weekdayOf(date) === weekday) samples.push(hours);
    }
    if (samples.length === 0) continue;
    const activeHours = new Set(samples.flatMap((hours) => [...hours.keys()]));
    for (const hour of [...activeHours].sort((a, b) => a - b)) {
      const mean = { sales: 0, orders: 0, covers: 0 };
      for (const hours of samples) {
        const totals = hours.get(hour);
        if (!totals) continue;
        mean.sales += totals.sales;
        mean.orders += totals.orders;
        mean.covers += totals.covers;
      }
      const values: Record<ForecastMetricCode, number> = {
        sales_idr: mean.sales / samples.length,
        orders: mean.orders / samples.length,
        covers: mean.covers / samples.length,
      };
      for (const metricCode of forecastMetricCodes)
        cells.push({
          targetDate,
          hour,
          metricCode,
          value: round2(values[metricCode]),
        });
    }
  }
  return cells;
}

/**
 * Worker write: upserts the rule-v1 forecast for `days` days from `fromDate`
 * and returns the number of rows written. Idempotent on the unique key.
 */
export async function generateForecasts(
  context: ScopedTenantContext,
  input: { outletId: string; fromDate: string; days: number },
): Promise<number> {
  const days = Math.min(Math.max(Math.trunc(input.days), 1), FORECAST_MAX_DAYS);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const cells = await computeRuleForecast(
      tx,
      tenantId,
      input.outletId,
      input.fromDate,
      days,
    );
    // Drop the range first: an hour that left the 8-week window must not keep
    // its old forecast. The upsert below still guards a concurrent run.
    await tx
      .delete(forecasts)
      .where(
        and(
          eq(forecasts.tenantId, tenantId),
          eq(forecasts.outletId, input.outletId),
          gte(forecasts.targetDate, input.fromDate),
          lte(forecasts.targetDate, addDays(input.fromDate, days - 1)),
        ),
      );
    const generatedAt = new Date();
    const CHUNK = 500;
    for (let start = 0; start < cells.length; start += CHUNK) {
      await tx
        .insert(forecasts)
        .values(
          cells.slice(start, start + CHUNK).map((cell) => ({
            tenantId,
            outletId: input.outletId,
            targetDate: cell.targetDate,
            hour: cell.hour,
            metricCode: cell.metricCode,
            value: cell.value.toFixed(2),
            modelVersion: FORECAST_MODEL_VERSION,
            generatedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            forecasts.tenantId,
            forecasts.outletId,
            forecasts.targetDate,
            forecasts.hour,
            forecasts.metricCode,
          ],
          set: {
            value: sql`excluded.value`,
            modelVersion: sql`excluded.model_version`,
            generatedAt: sql`excluded.generated_at`,
          },
        });
    }
    return cells.length;
  });
}

export async function listForecasts(
  access: AccessSnapshot,
  query: {
    outletId: string;
    from: string;
    to: string;
    metricCode?: ForecastMetricCode | undefined;
  },
): Promise<ForecastRow[]> {
  const context = requireOutletContext(
    access,
    ["report.sales.view"],
    query.outletId,
  );
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(forecasts)
      .where(
        and(
          eq(forecasts.tenantId, access.tenant.tenantId),
          eq(forecasts.outletId, query.outletId),
          gte(forecasts.targetDate, query.from),
          lte(forecasts.targetDate, query.to),
          query.metricCode
            ? eq(forecasts.metricCode, query.metricCode)
            : undefined,
        ),
      )
      .orderBy(
        asc(forecasts.targetDate),
        asc(forecasts.hour),
        asc(forecasts.metricCode),
      ),
  );
  return rows.map((row) =>
    forecastRowSchema.parse({
      id: row.id,
      outletId: row.outletId,
      targetDate: row.targetDate,
      hour: row.hour,
      metricCode: row.metricCode,
      value: Number(row.value),
      modelVersion: row.modelVersion,
      generatedAt: row.generatedAt.toISOString(),
    }),
  );
}
