// AI-13 roster inputs (WS-12 wave 3, bead legend-hkd4): the headcount a day
// needs per hour, derived from the AI-07 forecast. These are INPUTS for the
// manager's schedule, never a roster: skills and preferences are a gap (no
// skills/roster table yet).
//
// headcount = ceil(forecast covers / coversPerStaff), at least 1 in every hour
// that has forecast orders. With no stored forecast for the date the same
// rule-v1 numbers are computed on the fly and `basis` is `rule_baseline`.
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  defaultCoversPerStaff,
  rosterInputSchema,
  type RosterInput,
} from "@starter/shared/ai";
import { db } from "../db/index.ts";
import { forecasts } from "../db/schema/ai-insights.ts";
import { withTenant } from "../db/tenant.ts";
import {
  computeRuleForecast,
  type ForecastCell,
} from "./ai-forecast.service.ts";
import { requireOutletContext } from "./ai-forecast.shared.ts";
import type { AccessSnapshot } from "./permission-resolver.ts";

export async function getRosterInputs(
  access: AccessSnapshot,
  query: { outletId: string; date: string; coversPerStaff?: number },
): Promise<RosterInput> {
  const context = requireOutletContext(
    access,
    ["hr.schedule.manage"],
    query.outletId,
  );
  const coversPerStaff = query.coversPerStaff ?? defaultCoversPerStaff;
  const tenantId = access.tenant.tenantId;

  const { cells, basis } = await withTenant(db, context, async (tx) => {
    const stored = await tx
      .select({
        hour: forecasts.hour,
        metricCode: forecasts.metricCode,
        value: forecasts.value,
      })
      .from(forecasts)
      .where(
        and(
          eq(forecasts.tenantId, tenantId),
          eq(forecasts.outletId, query.outletId),
          eq(forecasts.targetDate, query.date),
          inArray(forecasts.metricCode, ["orders", "covers"]),
        ),
      )
      .orderBy(asc(forecasts.hour));
    if (stored.length > 0)
      return {
        basis: "forecast" as const,
        cells: stored.map(
          (row): Pick<ForecastCell, "hour" | "metricCode" | "value"> => ({
            hour: row.hour,
            metricCode: row.metricCode as ForecastCell["metricCode"],
            value: Number(row.value),
          }),
        ),
      };
    return {
      basis: "rule_baseline" as const,
      cells: await computeRuleForecast(
        tx,
        tenantId,
        query.outletId,
        query.date,
        1,
      ),
    };
  });

  const byHour = new Map<number, { covers: number; orders: number }>();
  for (const cell of cells) {
    if (cell.metricCode !== "covers" && cell.metricCode !== "orders") continue;
    const entry = byHour.get(cell.hour) ?? { covers: 0, orders: 0 };
    if (cell.metricCode === "covers") entry.covers = cell.value;
    else entry.orders = cell.value;
    byHour.set(cell.hour, entry);
  }
  const hours = [...byHour.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, entry]) => ({
      hour,
      forecastCovers: entry.covers,
      forecastOrders: entry.orders,
      suggestedHeadcount:
        entry.orders > 0 || entry.covers > 0
          ? Math.max(1, Math.ceil(entry.covers / coversPerStaff))
          : 0,
    }));
  return rosterInputSchema.parse({
    outletId: query.outletId,
    date: query.date,
    hours,
    coversPerStaff,
    basis,
  });
}
