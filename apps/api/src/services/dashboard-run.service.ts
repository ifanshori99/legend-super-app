// Dashboard layout, tile values and queue rows (WS-11 F11, bead legend-flb8f,
// absorbs legend-1ye3 and legend-5bjh; PRD v1.7 §3.34-3.36, DASH-01..03,
// SH-01, SH-02). Endpoints are in `@starter/shared/dashboard`
// (`getDashboardEndpoint`, `getDashboardValuesEndpoint`,
// `getDashboardQueueRowsEndpoint`, `getDashboardFacilityScopeEndpoint`).
//
// - A tile never computes a figure: the values read the same `evaluateMetrics`
//   engine the report run reads (DASH-02), so a tile and its source report
//   cannot disagree.
// - `/values` IS the batch endpoint. One request answers every metric tile of a
//   dashboard from ONE snapshot transaction. Tiles are grouped by the period
//   they resolve to and each group is one `evaluateMetrics` call (one ledger
//   read plus one `metrics_daily` read for all of its metric codes), instead of
//   one report run per tile.
// - Who sees a tile: `tileAdmitted` (tile permissions, the tile's source report
//   and every cited metric's source report must be open to the caller, the same
//   rule as `reportPermittedFor`). A shareholder is admitted through
//   `report.aggregate.view` (viewer `aggregate`), never through
//   `dashboard.management.view` (legend-5bjh).
// - The caller resolves the context and viewer (routes/dashboards.routes.ts);
//   the request carries no tenant (TEN-02) and requested outlets are
//   intersected with the scope (TEN-03, `outletIdsForQuery`).
// - Values are cached for a few seconds per tenant, dashboard, viewer, outlet
//   scope, tile set and query, so the 60 s refresh of many open tabs reads the
//   database once. The key starts with the tenant id: no key is shared across
//   tenants.

import { and, asc, count, eq, inArray, type SQL } from "drizzle-orm";
import {
  businessDateOf,
  DEFAULT_BUSINESS_DAY_CLOCK,
  outletIdsForQuery,
  type BusinessDate,
  type OutletQueryFilter,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  dashboardFacilityScopeSchema,
  dashboardLayoutSchema,
  dashboardQueueRowsSchema,
  dashboardValuesSchema,
  DASHBOARD_CATALOG,
  DASHBOARD_TITLES,
  dashboardTilesFor,
  reportAcceptsAggregateView,
  reportByCode,
  reportMetricByCode,
  reportPermittedFor,
  type DashboardAvailability,
  type DashboardFacilityScope,
  type DashboardKind,
  type DashboardLayout,
  type DashboardQueueRows,
  type DashboardRowQueue,
  type DashboardTile,
  type DashboardValues,
  type DashboardValuesQuery,
  type ManagementRole,
  type MetricDashboardTile,
  type ReportDefinition,
  type ReportPeriodPreset,
} from "@starter/shared/dashboard";
import {
  METRIC_UNAVAILABLE_MESSAGES,
  type MetricFinality,
  type MetricPeriod,
  type MetricValue,
} from "@starter/shared/metrics";
import { db } from "../db";
import {
  facilities,
  facilityUnits,
  kitchenTicketItems,
  kitchenTickets,
  orders,
  outlets,
  serviceRequests,
  stations,
  tables,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
  type MetricViewer,
} from "./metrics-query.service";
import { outletBusinessDayClock } from "./outlet-clock";

export type DashboardRunOptions = {
  /** Clock for "today" and `generatedAt` (tests); defaults to now. */
  now?: Date;
};

// ---- Who sees what ----------------------------------------------------------

/** The catalog reports whose permissions admit a tile (source report + metrics). */
function reportsOfTile(tile: DashboardTile): ReportDefinition[] {
  const found = new Map<string, ReportDefinition>();
  const add = (code: string | null | undefined) => {
    const report = code ? reportByCode(code) : undefined;
    if (report !== undefined) found.set(report.code, report);
  };
  if (tile.kind === "metric") {
    add(tile.reportCode);
    for (const metricCode of tile.metricCodes)
      add(reportMetricByCode.get(metricCode)?.sourceReport.reportCode);
  } else if (tile.kind === "queue" || tile.kind === "link") {
    add(tile.reportCode);
  }
  return [...found.values()];
}

/** Tile permissions plus the permissions of every report behind the tile. */
export function tileAdmitted(
  tile: DashboardTile,
  permissions: readonly string[],
): boolean {
  if (!tile.requiredPermissions.every((code) => permissions.includes(code)))
    return false;
  return reportsOfTile(tile).every((report) =>
    reportPermittedFor(report, permissions),
  );
}

/**
 * Tiles of one dashboard the held permissions open, in catalog order. A
 * `managerRole` narrows the management home to that role's tiles plus the
 * shared ones (`dashboardTilesFor`); without it every management tile stays.
 */
export function admittedTiles(
  dashboard: DashboardKind,
  permissions: readonly string[],
  managerRole?: ManagementRole,
): DashboardTile[] {
  const forRole =
    dashboard === "management" && managerRole !== undefined
      ? new Set(dashboardTilesFor(dashboard, managerRole))
      : undefined;
  return DASHBOARD_CATALOG.filter(
    (tile) =>
      tile.dashboard === dashboard &&
      (forRole === undefined || forRole.has(tile)) &&
      tileAdmitted(tile, permissions),
  );
}

/**
 * One report per distinct way of being admitted, for the viewer/scope
 * resolution: reports with the same required permissions and the same
 * aggregate rule open for the same callers over the same outlets.
 */
export function viewerReportsOf(
  tiles: readonly DashboardTile[],
): ReportDefinition[] {
  const byShape = new Map<string, ReportDefinition>();
  for (const tile of tiles)
    for (const report of reportsOfTile(tile)) {
      const shape = `${[...report.requiredPermissions].sort().join(",")}|${reportAcceptsAggregateView(report)}`;
      if (!byShape.has(shape)) byShape.set(shape, report);
    }
  return [...byShape.values()];
}

/** The first admitted queue tile of a queue; what admits a queue-rows read. */
export function queueTileFor(
  queue: DashboardRowQueue,
  permissions: readonly string[],
): DashboardTile | undefined {
  return DASHBOARD_CATALOG.find(
    (tile) =>
      tile.kind === "queue" &&
      tile.queue === queue &&
      permissions.includes(`dashboard.${tile.dashboard}.view`) &&
      tileAdmitted(tile, permissions),
  );
}

// ---- Periods ----------------------------------------------------------------

type DateRange = { start: BusinessDate; end: BusinessDate };

function toUtc(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function iso(date: Date): BusinessDate {
  return date.toISOString().slice(0, 10) as BusinessDate;
}

function addDays(value: string, days: number): BusinessDate {
  const date = toUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

const monthStart = (year: number, monthIndex: number) =>
  iso(new Date(Date.UTC(year, monthIndex, 1)));
const monthEnd = (year: number, monthIndex: number) =>
  iso(new Date(Date.UTC(year, monthIndex + 1, 0)));

/**
 * The range a preset covers on the outlet business date (weeks start on
 * Monday). Same calendar math as the report viewer; the server owns "today".
 */
export function resolvePresetRange(
  preset: Exclude<ReportPeriodPreset, "custom">,
  businessDate: BusinessDate,
): DateRange {
  const today = toUtc(businessDate);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const weekStart = addDays(businessDate, -((today.getUTCDay() + 6) % 7));
  const quarterFirstMonth = Math.floor(month / 3) * 3;
  switch (preset) {
    case "today":
      return { start: businessDate, end: businessDate };
    case "yesterday": {
      const day = addDays(businessDate, -1);
      return { start: day, end: day };
    }
    case "this_week":
      return { start: weekStart, end: businessDate };
    case "last_week":
      return { start: addDays(weekStart, -7), end: addDays(weekStart, -1) };
    case "this_month":
      return { start: monthStart(year, month), end: businessDate };
    case "last_month":
      return {
        start: monthStart(year, month - 1),
        end: monthEnd(year, month - 1),
      };
    case "this_quarter":
      return { start: monthStart(year, quarterFirstMonth), end: businessDate };
    case "last_quarter":
      return {
        start: monthStart(year, quarterFirstMonth - 3),
        end: monthEnd(year, quarterFirstMonth - 1),
      };
    case "this_year":
    case "year_to_date":
      return { start: monthStart(year, 0), end: businessDate };
  }
}

function tileRange(
  tile: MetricDashboardTile,
  query: DashboardValuesQuery,
  businessDate: BusinessDate,
): DateRange {
  const preset = query.period ?? tile.period;
  if (preset === "custom") {
    if (query.startDate === undefined || query.endDate === undefined)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Periode kustom butuh startDate dan endDate.",
      );
    return { start: query.startDate, end: query.endDate };
  }
  return resolvePresetRange(preset, businessDate);
}

function monthsOf(range: DateRange): string[] {
  const months: string[] = [];
  let year = Number(range.start.slice(0, 4));
  let month = Number(range.start.slice(5, 7));
  const last = range.end.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= last) return months;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

// ---- Layout -----------------------------------------------------------------

function outletCondition(
  column: Parameters<typeof inArray>[0],
  filter: OutletQueryFilter,
): SQL | undefined {
  return filter.kind === "outlets"
    ? inArray(column, filter.outletIds)
    : undefined;
}

type OutletClockRow = { timezone: string; businessDayCutoff: string };

/**
 * "Today" of a dashboard: the business date in each outlet's own time zone and
 * cutoff. Outlets in different zones (or with different cutoffs) can be on
 * different business dates at the same instant; the dashboard takes the
 * EARLIEST one, so a period is never called closed before every outlet read
 * has finished that day. No outlet read: the default clock.
 */
function dashboardToday(
  rows: readonly OutletClockRow[],
  now: Date,
): BusinessDate {
  const dates = rows.map((row) =>
    businessDateOf(now, outletBusinessDayClock(row)),
  );
  return dates.length === 0
    ? businessDateOf(now, DEFAULT_BUSINESS_DAY_CLOCK)
    : dates.reduce((earliest, date) => (date < earliest ? date : earliest));
}

/** Outlets (zone + cutoff) the caller reads, inside the tenant. */
async function outletClockRows(
  context: ScopedTenantContext,
  filter: OutletQueryFilter,
): Promise<OutletClockRow[]> {
  return withTenant(db, context, (tx) =>
    tx
      .select({
        timezone: outlets.timezone,
        businessDayCutoff: outlets.businessDayCutoff,
      })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          outletCondition(outlets.id, filter),
        ),
      ),
  );
}

/** Layout of one dashboard for the caller: admitted tiles and the outlets read. */
export async function getDashboardLayout(
  context: ScopedTenantContext,
  input: {
    dashboard: DashboardKind;
    tiles: readonly DashboardTile[];
    outletIds?: readonly string[] | undefined;
  },
  options: DashboardRunOptions = {},
): Promise<DashboardLayout> {
  const now = options.now ?? new Date();
  const filter = outletIdsForQuery(context.outletScope, input.outletIds);
  const outletRows = await withTenant(db, context, (tx) =>
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
          outletCondition(outlets.id, filter),
        ),
      )
      .orderBy(asc(outlets.code))
      .limit(100),
  );
  if (outletRows.length === 0 || input.tiles.length === 0)
    throw new HttpError(
      403,
      "REPORT_NOT_PERMITTED",
      "Tidak ada data dashboard yang bisa dibuka untuk akun ini.",
    );
  const businessDate = dashboardToday(outletRows, now);
  return dashboardLayoutSchema.parse({
    dashboard: input.dashboard,
    title: DASHBOARD_TITLES[input.dashboard],
    businessDate,
    availableOutlets: outletRows.map((row) => row.id),
    tiles: input.tiles,
    generatedAt: now.toISOString(),
    monitoringPeriod: {
      startDate: businessDate,
      endDate: businessDate,
      bucket: "day",
      status: "open",
      accountingPeriodClosed: false,
    },
  });
}

// ---- Values (batch) ---------------------------------------------------------

/** The target metric a tile figure is held against (PRD §3.34). */
const TARGET_METRIC: Readonly<Record<string, string>> = {
  net_sales: "sales_target",
};

const CACHE_MAX_ENTRIES = 200;
let cacheTtlMs = 15_000;
const valuesCache = new Map<
  string,
  { expiresAt: number; value: DashboardValues }
>();

/** Tests tune or switch the values cache off (0). */
export function setDashboardCacheTtlMs(ms: number): void {
  cacheTtlMs = ms;
  valuesCache.clear();
}

export function clearDashboardCache(): void {
  valuesCache.clear();
}

function cacheKeyOf(
  context: ScopedTenantContext,
  input: {
    dashboard: DashboardKind;
    viewer: MetricViewer;
    tiles: readonly MetricDashboardTile[];
    query: DashboardValuesQuery;
  },
  filter: OutletQueryFilter,
  businessDate: BusinessDate,
): string {
  return JSON.stringify([
    context.tenant.tenantId,
    input.dashboard,
    input.viewer,
    filter.kind === "all" ? "all" : [...filter.outletIds].sort(),
    input.tiles.map((tile) => tile.key),
    input.query.period ?? null,
    input.query.startDate ?? null,
    input.query.endDate ?? null,
    businessDate,
  ]);
}

function pointOf(evaluated: EvaluatedMetrics, metricCode: string) {
  const series = evaluated.series.find(
    (candidate) =>
      candidate.metricCode === metricCode && candidate.dimensions.length === 0,
  );
  return series?.points[0];
}

/**
 * Values of every metric tile in `input.tiles`: one snapshot transaction, one
 * `evaluateMetrics` call per distinct period (all codes of the group at once).
 */
export async function getDashboardValues(
  context: ScopedTenantContext,
  input: {
    dashboard: DashboardKind;
    viewer: MetricViewer;
    tiles: readonly DashboardTile[];
    query: DashboardValuesQuery;
  },
  options: DashboardRunOptions = {},
): Promise<DashboardValues> {
  const now = options.now ?? new Date();
  const filter = outletIdsForQuery(context.outletScope, input.query.outletIds);
  const today = dashboardToday(await outletClockRows(context, filter), now);
  const metricTiles = input.tiles.filter(
    (tile): tile is MetricDashboardTile => tile.kind === "metric",
  );
  const key = cacheKeyOf(
    context,
    { ...input, tiles: metricTiles },
    filter,
    today,
  );
  const hit = cacheTtlMs > 0 ? valuesCache.get(key) : undefined;
  if (hit !== undefined && hit.expiresAt > Date.now()) return hit.value;

  const groups = new Map<
    string,
    { range: DateRange; tiles: MetricDashboardTile[] }
  >();
  for (const tile of metricTiles) {
    const range = tileRange(tile, input.query, today);
    const groupKey = `${range.start}|${range.end}`;
    const group = groups.get(groupKey) ?? { range, tiles: [] };
    group.tiles.push(tile);
    groups.set(groupKey, group);
  }

  const resolved = await withTenantSnapshot(context, async (tx) => {
    const done: {
      range: DateRange;
      tiles: MetricDashboardTile[];
      evaluated: EvaluatedMetrics;
    }[] = [];
    for (const group of groups.values()) {
      const metricCodes = [
        ...new Set(group.tiles.flatMap((tile) => tile.metricCodes)),
      ];
      done.push({
        ...group,
        evaluated: await evaluateMetrics(
          tx,
          context,
          {
            metricCodes,
            period: group.range,
            bucket: "total",
            outletFilter: filter,
            groupBy: [],
            filters: [],
            comparePrevious: true,
            viewer: input.viewer,
          },
          now,
          { today },
        ),
      });
    }
    return done;
  });

  const tiles: DashboardValues["tiles"] = [];
  for (const { range, tiles: groupTiles, evaluated } of resolved) {
    const closedMonths = new Set(
      evaluated.accountingPeriods
        .filter((period) => period.closed)
        .map((period) => period.period),
    );
    const periodClosed = range.end < today;
    const accountingPeriodClosed =
      periodClosed && monthsOf(range).every((month) => closedMonths.has(month));
    const period: MetricPeriod = {
      startDate: range.start,
      endDate: range.end,
      bucket: "total",
      status: periodClosed ? "closed" : "open",
      accountingPeriodClosed,
    };
    const unavailable = new Set(
      evaluated.availability
        .filter((entry) => entry.status === "unavailable")
        .map((entry) => entry.metricCode),
    );
    const valueOf = (code: string): MetricValue | null =>
      unavailable.has(code) ? null : (pointOf(evaluated, code)?.value ?? null);

    const reasonOf = new Map(
      evaluated.availability.flatMap((entry) =>
        entry.status === "unavailable"
          ? [[entry.metricCode, entry.reason]]
          : [],
      ),
    );

    for (const tile of groupTiles) {
      // A tile is unavailable only when none of its metrics has a source.
      const reasons = tile.metricCodes.map((code) => reasonOf.get(code));
      const firstReason = reasons[0];
      const availability: DashboardAvailability =
        firstReason !== undefined &&
        reasons.every((reason) => reason !== undefined)
          ? {
              status: "unavailable",
              reason: firstReason,
              message: METRIC_UNAVAILABLE_MESSAGES[firstReason],
            }
          : { status: "available" };
      tiles.push({
        tileKey: tile.key,
        period,
        availability,
        values: tile.metricCodes.map((code) => {
          const point = pointOf(evaluated, code);
          const value = valueOf(code);
          const targetCode = TARGET_METRIC[code];
          const target =
            tile.comparison === "target" &&
            targetCode !== undefined &&
            tile.metricCodes.includes(targetCode)
              ? valueOf(targetCode)
              : null;
          // SH-02, I2: only a closed period is final; money and closed-period
          // tiles also wait for the books. No data is never final.
          const final =
            value !== null &&
            periodClosed &&
            (accountingPeriodClosed ||
              (value.unit !== "idr" && !tile.closedPeriodOnly));
          const finality: MetricFinality =
            final && point?.finality === "final" ? "final" : "estimate";
          return {
            metricCode: code,
            value,
            target:
              target !== null && target.unit === value?.unit ? target : null,
            comparison:
              tile.comparison === "previous_period" && value !== null
                ? (point?.comparison ?? null)
                : null,
            finality,
          };
        }),
      });
    }
  }
  // Catalog order, whatever the period groups were.
  const order = new Map(metricTiles.map((tile, index) => [tile.key, index]));
  tiles.sort(
    (a, b) => (order.get(a.tileKey) ?? 0) - (order.get(b.tileKey) ?? 0),
  );

  const values = dashboardValuesSchema.parse({
    dashboard: input.dashboard,
    businessDate: today,
    outlets: resolved[0]?.evaluated.outletFilter ?? filter,
    tiles,
    generatedAt: now.toISOString(),
  });
  if (cacheTtlMs > 0) {
    if (valuesCache.size >= CACHE_MAX_ENTRIES) valuesCache.clear();
    valuesCache.set(key, { expiresAt: Date.now() + cacheTtlMs, value: values });
  }
  return values;
}

// ---- Queue rows -------------------------------------------------------------

const ACTIVE_KITCHEN_STATUSES = ["new", "in_progress", "recalled"];
const OPEN_CALL_STATUSES = ["pending", "acknowledged"] as const;

const secondsSince = (from: Date, now: Date) =>
  Math.min(
    31_536_000,
    Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000)),
  );

/** Rows behind one queue tile. Rows hold no customer or employee identity. */
export async function getDashboardQueueRows(
  context: ScopedTenantContext,
  input: {
    queue: DashboardRowQueue;
    outletIds?: readonly string[] | undefined;
    limit: number;
  },
  options: DashboardRunOptions = {},
): Promise<DashboardQueueRows> {
  const now = options.now ?? new Date();
  const tenantId = context.tenant.tenantId;
  const filter = outletIdsForQuery(context.outletScope, input.outletIds);
  const generatedAt = now.toISOString();
  const page = input.limit + 1;

  if (input.queue === "kitchen_queue") {
    const rows = await withTenant(db, context, (tx) =>
      tx
        .select({
          outletId: kitchenTickets.outletId,
          ticketId: kitchenTickets.id,
          orderLabel: orders.number,
          stationName: stations.name,
          status: kitchenTickets.status,
          itemCount: count(kitchenTicketItems.id),
          createdAt: kitchenTickets.firedAt,
        })
        .from(kitchenTickets)
        .innerJoin(
          orders,
          and(
            eq(orders.tenantId, kitchenTickets.tenantId),
            eq(orders.id, kitchenTickets.orderId),
          ),
        )
        .innerJoin(
          stations,
          and(
            eq(stations.tenantId, kitchenTickets.tenantId),
            eq(stations.id, kitchenTickets.stationId),
          ),
        )
        .leftJoin(
          kitchenTicketItems,
          and(
            eq(kitchenTicketItems.tenantId, kitchenTickets.tenantId),
            eq(kitchenTicketItems.ticketId, kitchenTickets.id),
          ),
        )
        .where(
          and(
            eq(kitchenTickets.tenantId, tenantId),
            inArray(kitchenTickets.status, ACTIVE_KITCHEN_STATUSES),
            outletCondition(kitchenTickets.outletId, filter),
          ),
        )
        .groupBy(kitchenTickets.id, orders.number, stations.name)
        .orderBy(asc(kitchenTickets.firedAt), asc(kitchenTickets.id))
        .limit(page),
    );
    return dashboardQueueRowsSchema.parse({
      queue: "kitchen_queue",
      rows: rows.slice(0, input.limit).map((row) => ({
        outletId: row.outletId,
        ticketId: row.ticketId,
        orderLabel: row.orderLabel,
        stationName: row.stationName,
        status: row.status,
        itemCount: Math.max(1, Number(row.itemCount)),
        createdAt: row.createdAt.toISOString(),
        waitingSeconds: secondsSince(row.createdAt, now),
      })),
      hasMore: rows.length > input.limit,
      generatedAt,
    });
  }

  if (input.queue === "waiter_calls") {
    const rows = await withTenant(db, context, (tx) =>
      tx
        .select({
          outletId: serviceRequests.outletId,
          callId: serviceRequests.id,
          tableLabel: tables.code,
          reason: serviceRequests.reason,
          status: serviceRequests.status,
          calledAt: serviceRequests.createdAt,
        })
        .from(serviceRequests)
        .innerJoin(
          tables,
          and(
            eq(tables.tenantId, serviceRequests.tenantId),
            eq(tables.id, serviceRequests.tableId),
          ),
        )
        .where(
          and(
            eq(serviceRequests.tenantId, tenantId),
            eq(serviceRequests.type, "call_waiter"),
            inArray(serviceRequests.status, [...OPEN_CALL_STATUSES]),
            outletCondition(serviceRequests.outletId, filter),
          ),
        )
        .orderBy(asc(serviceRequests.createdAt), asc(serviceRequests.id))
        .limit(page),
    );
    return dashboardQueueRowsSchema.parse({
      queue: "waiter_calls",
      rows: rows.slice(0, input.limit).map((row) => ({
        outletId: row.outletId,
        callId: row.callId,
        tableLabel: row.tableLabel,
        reason: row.reason,
        status: row.status === "pending" ? "open" : "acknowledged",
        calledAt: row.calledAt.toISOString(),
        waitingSeconds: secondsSince(row.calledAt, now),
      })),
      hasMore: rows.length > input.limit,
      generatedAt,
    });
  }

  if (input.queue === "facility_units") {
    const rows = await withTenant(db, context, (tx) =>
      tx
        .select({
          outletId: facilities.outletId,
          facilityId: facilities.id,
          facilityName: facilities.name,
          facilityType: facilities.type,
          status: facilityUnits.status,
          units: count(facilityUnits.id),
        })
        .from(facilities)
        .leftJoin(
          facilityUnits,
          and(
            eq(facilityUnits.tenantId, facilities.tenantId),
            eq(facilityUnits.facilityId, facilities.id),
          ),
        )
        .where(
          and(
            eq(facilities.tenantId, tenantId),
            outletCondition(facilities.outletId, filter),
          ),
        )
        .groupBy(
          facilities.id,
          facilities.outletId,
          facilities.name,
          facilities.type,
          facilityUnits.status,
        )
        .orderBy(asc(facilities.name), asc(facilities.id)),
    );
    const byFacility = new Map<
      string,
      {
        outletId: string;
        facilityId: string;
        facilityName: string;
        facilityType: string;
        unitCounts: Record<string, number>;
      }
    >();
    for (const row of rows) {
      const entry = byFacility.get(row.facilityId) ?? {
        outletId: row.outletId,
        facilityId: row.facilityId,
        facilityName: row.facilityName,
        facilityType: row.facilityType,
        unitCounts: {
          available: 0,
          in_use: 0,
          needs_cleaning: 0,
          cleaning: 0,
          maintenance: 0,
        },
      };
      if (row.status !== null) entry.unitCounts[row.status] = Number(row.units);
      byFacility.set(row.facilityId, entry);
    }
    const all = [...byFacility.values()];
    return dashboardQueueRowsSchema.parse({
      queue: "facility_units",
      rows: all.slice(0, input.limit),
      hasMore: all.length > input.limit,
      generatedAt,
    });
  }

  // `reviews`: no review table exists yet, so there is nothing true to show.
  // An empty list alone would read as "no reviews", so the payload says the
  // source is not built (availability) instead of failing the tile.
  return dashboardQueueRowsSchema.parse({
    queue: "reviews",
    rows: [],
    hasMore: false,
    generatedAt,
    availability: {
      status: "unavailable",
      reason: "source_not_built",
      message: METRIC_UNAVAILABLE_MESSAGES.source_not_built,
    },
  });
}

/** Facility ids per outlet in the caller's scope. */
export async function getDashboardFacilityScope(
  context: ScopedTenantContext,
  input: { outletIds?: readonly string[] | undefined },
): Promise<DashboardFacilityScope> {
  const filter = outletIdsForQuery(context.outletScope, input.outletIds);
  const tenantId = context.tenant.tenantId;
  const { outletRows, facilityRows } = await withTenant(
    db,
    context,
    async (tx) => ({
      outletRows: await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, tenantId),
            outletCondition(outlets.id, filter),
          ),
        )
        .orderBy(asc(outlets.code))
        .limit(100),
      facilityRows: await tx
        .select({ id: facilities.id, outletId: facilities.outletId })
        .from(facilities)
        .where(
          and(
            eq(facilities.tenantId, tenantId),
            outletCondition(facilities.outletId, filter),
          ),
        )
        .orderBy(asc(facilities.name), asc(facilities.id)),
    }),
  );
  return dashboardFacilityScopeSchema.parse({
    outlets: outletRows.map((outlet) => ({
      outletId: outlet.id,
      facilityIds: facilityRows
        .filter((facility) => facility.outletId === outlet.id)
        .map((facility) => facility.id)
        .slice(0, 50),
    })),
  });
}
