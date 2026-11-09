// Metric sources of the "traffic-operations" family (WS-11 F2, bead
// legend-a82g9). Owned by this family's card: add sources and splits here,
// never in another file.
//
// Built (daily readers, one outlet-day each, total row always written, zero
// when nothing happened):
// - pax: guests of the table sessions opened on the business day, only
//   sessions that were seated (`open`, `bill_requested`, `closed`); a
//   `pending_confirmation` or `voided` session is not counted; split zone
//   and hour.
// - table_turnover: sessions closed on the day / tables not inactive now
//   (the table count has no history); split zone.
// - avg_dwell_minutes: mean minutes between opened_at and closed_at of the
//   sessions closed on the day; split zone.
// - waiter_call_count: `call_waiter` service requests created on the day,
//   cancelled ones excluded; split zone.
// - order_queue_count: kitchen tickets fired on the business day and not done
//   or cancelled at the end of the day (or now, on the open day); split
//   station. A ticket fired before the day started is not counted, so a
//   forgotten ticket never inflates the queue of later days.
// - avg_serving_time: mean seconds fired_at to done_at of the tickets done on
//   the day; split station and hour.
// - remake_count / comp_count: `recipe_deductions` of that kind on the
//   business date. One row is one issue: the row stores no menu quantity
//   (the event's quantity is not kept, and `recipe_deduction_lines` hold
//   ingredient quantities, none for a skipped row), so the count is of
//   issues, not items. The row carries no menu item or station, so no
//   station split is built (the engine answers `dimension_not_supported`).
//
// Not built, answered `unavailable` / `source_not_built` (there is no stored
// source for them in the schema today):
// - failed_item_count, apology_voucher_count: no order-issue table exists
//   (only the `order_issue.recorded` event feeds recipe deductions) and
//   `vouchers` carry no outlet.
// - device_offline_count: `devices.last_seen_at` is a live value with no
//   history, so a past day cannot be answered.
// - table_occupancy_pct: needs the outlet's open minutes per day.
// `returning_customers` belongs to the loyalty-crm card.
//
// Dimension values are ids: zone id, station id, hour "00".."23" in the
// outlet's time zone. Averages are stored per outlet-day; the engine takes
// the mean of those outlet-days (not weighted by volume). A day without
// activity stores 0 for `avg_serving_time` and `avg_dwell_minutes` (the
// total-row rule), so a multi-day mean over quiet days is pulled down: a
// weighted average needs stored numerator and denominator, which is a
// `ws11-shared` change (new bead), not built here.

import { sql } from "drizzle-orm";
import {
  businessDayRange,
  decimal4 as toDecimal4,
  type Decimal4,
} from "@starter/shared/core";
import { outletBusinessDayClock } from "../outlet-clock";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSource,
  MetricSourceFamilyModule,
} from "./types";

type Dimension = Exclude<
  NonNullable<DailyMetricValue["dimension"]>["key"],
  never
>;

type Window = { start: string; end: string; timezone: string };

async function windowOf(input: DailyComputeInput): Promise<Window> {
  const result = await input.tx.execute(sql`
    SELECT timezone, business_day_cutoff
      FROM outlets
     WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.outletId}::uuid`);
  const row = result.rows[0];
  if (!row) throw new Error("Outlet not found for the metric reader");
  const clock = outletBusinessDayClock({
    timezone: String(row.timezone),
    businessDayCutoff: String(row.business_day_cutoff),
  });
  const range = businessDayRange(input.businessDate, clock);
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    timezone: String(row.timezone),
  };
}

type Grouped = { value: string | null; amount: number };

function total(grouped: readonly Grouped[]): number {
  return grouped.reduce((sum, row) => sum + row.amount, 0);
}

function countValue(value: number): DailyMetricValue["value"] {
  return { unit: "count", value };
}

function rowsOf(
  metricCode: string,
  key: Dimension,
  grouped: readonly Grouped[],
  make: (amount: number) => DailyMetricValue["value"],
): DailyMetricValue[] {
  return grouped
    .filter((row) => row.value !== null)
    .map((row) => ({
      metricCode,
      dimension: { key, value: row.value! },
      value: make(row.amount),
    }));
}

async function grouped(
  input: DailyComputeInput,
  query: ReturnType<typeof sql>,
): Promise<Grouped[]> {
  const result = await input.tx.execute(query);
  return result.rows.map((row) => ({
    value: row.dim === null || row.dim === undefined ? null : String(row.dim),
    amount: Number(row.amount ?? 0),
  }));
}

// ---- pax -------------------------------------------------------------------

const paxReader: DailyMetricReader = {
  metricCodes: ["pax"],
  dimensions: ["zone", "hour"],
  requiresDailyClose: true,
  async compute(input) {
    const window = await windowOf(input);
    const base = sql`
      FROM table_sessions s
      JOIN tables t ON t.tenant_id = s.tenant_id AND t.id = s.table_id
     WHERE s.tenant_id = ${input.tenantId}::uuid
       AND s.outlet_id = ${input.outletId}::uuid
       AND s.status IN ('open', 'bill_requested', 'closed')
       AND s.opened_at >= ${window.start}::timestamptz
       AND s.opened_at < ${window.end}::timestamptz`;
    const byZone = await grouped(
      input,
      sql`SELECT t.zone_id::text AS dim, sum(s.pax) AS amount ${base} GROUP BY t.zone_id`,
    );
    const byHour = await grouped(
      input,
      sql`SELECT to_char(s.opened_at AT TIME ZONE ${window.timezone}, 'HH24') AS dim,
                 sum(s.pax) AS amount ${base} GROUP BY 1`,
    );
    return [
      { metricCode: "pax", dimension: null, value: countValue(total(byZone)) },
      ...rowsOf("pax", "zone", byZone, countValue),
      ...rowsOf("pax", "hour", byHour, countValue),
    ];
  },
};

// ---- floor: turnover, dwell time, waiter calls ----------------------------

/** Decimal4 of a ratio; zero denominator gives 0. */
function decimal4(numerator: number, denominator: number): Decimal4 {
  return toDecimal4(
    denominator === 0 ? "0.0000" : (numerator / denominator).toFixed(4),
  );
}

const floorReader: DailyMetricReader = {
  metricCodes: ["table_turnover", "avg_dwell_minutes", "waiter_call_count"],
  dimensions: ["zone"],
  requiresDailyClose: true,
  async compute(input) {
    const window = await windowOf(input);
    const tableCount = await grouped(
      input,
      sql`SELECT zone_id::text AS dim, count(*) AS amount
            FROM tables
           WHERE tenant_id = ${input.tenantId}::uuid
             AND outlet_id = ${input.outletId}::uuid
             AND status <> 'inactive'
           GROUP BY zone_id`,
    );
    const closed = await input.tx.execute(sql`
      SELECT t.zone_id::text AS dim, count(*) AS n,
             coalesce(sum(extract(epoch FROM s.closed_at - s.opened_at)), 0) AS secs
        FROM table_sessions s
        JOIN tables t ON t.tenant_id = s.tenant_id AND t.id = s.table_id
       WHERE s.tenant_id = ${input.tenantId}::uuid
         AND s.outlet_id = ${input.outletId}::uuid
         AND s.status = 'closed'
         AND s.closed_at >= ${window.start}::timestamptz
         AND s.closed_at < ${window.end}::timestamptz
       GROUP BY t.zone_id`);
    const sessions = new Map(
      closed.rows.map((row) => [
        String(row.dim),
        { n: Number(row.n), secs: Number(row.secs) },
      ]),
    );
    const tablesByZone = new Map(
      tableCount.map((row) => [row.value!, row.amount]),
    );
    const zones = new Set([...sessions.keys(), ...tablesByZone.keys()]);

    const closedTotal = [...sessions.values()].reduce((s, v) => s + v.n, 0);
    const secsTotal = [...sessions.values()].reduce((s, v) => s + v.secs, 0);
    const tablesTotal = total(tableCount);

    const calls = await grouped(
      input,
      sql`SELECT zone_id::text AS dim, count(*) AS amount
            FROM service_requests
           WHERE tenant_id = ${input.tenantId}::uuid
             AND outlet_id = ${input.outletId}::uuid
             AND type = 'call_waiter' AND status <> 'cancelled'
             AND created_at >= ${window.start}::timestamptz
             AND created_at < ${window.end}::timestamptz
           GROUP BY zone_id`,
    );

    const out: DailyMetricValue[] = [
      {
        metricCode: "table_turnover",
        dimension: null,
        value: {
          unit: "decimal",
          value: decimal4(closedTotal, tablesTotal),
        },
      },
      {
        metricCode: "avg_dwell_minutes",
        dimension: null,
        value: {
          unit: "decimal",
          value: decimal4(secsTotal / 60, closedTotal),
        },
      },
      {
        metricCode: "waiter_call_count",
        dimension: null,
        value: countValue(total(calls)),
      },
      ...rowsOf("waiter_call_count", "zone", calls, countValue),
    ];
    for (const zone of [...zones].sort()) {
      const stat = sessions.get(zone) ?? { n: 0, secs: 0 };
      out.push({
        metricCode: "table_turnover",
        dimension: { key: "zone", value: zone },
        value: {
          unit: "decimal",
          value: decimal4(stat.n, tablesByZone.get(zone) ?? 0),
        },
      });
      if (stat.n > 0)
        out.push({
          metricCode: "avg_dwell_minutes",
          dimension: { key: "zone", value: zone },
          value: { unit: "decimal", value: decimal4(stat.secs / 60, stat.n) },
        });
    }
    return out;
  },
};

// ---- kitchen: queue, serving time -----------------------------------------

const queueReader: DailyMetricReader = {
  metricCodes: ["order_queue_count"],
  dimensions: ["station"],
  requiresDailyClose: false,
  async compute(input) {
    const window = await windowOf(input);
    // The open day has no end yet: the snapshot is taken now.
    const result = await grouped(
      input,
      sql`SELECT station_id::text AS dim, count(*) AS amount
            FROM kitchen_tickets
           WHERE tenant_id = ${input.tenantId}::uuid
             AND outlet_id = ${input.outletId}::uuid
             AND fired_at >= ${window.start}::timestamptz
             AND fired_at < least(${window.end}::timestamptz, now())
             AND (done_at IS NULL OR done_at >= least(${window.end}::timestamptz, now()))
             AND (cancelled_at IS NULL OR cancelled_at >= least(${window.end}::timestamptz, now()))
           GROUP BY station_id`,
    );
    return [
      {
        metricCode: "order_queue_count",
        dimension: null,
        value: countValue(total(result)),
      },
      ...rowsOf("order_queue_count", "station", result, countValue),
    ];
  },
};

const servingReader: DailyMetricReader = {
  metricCodes: ["avg_serving_time"],
  dimensions: ["station", "hour"],
  requiresDailyClose: false,
  async compute(input) {
    const window = await windowOf(input);
    const base = sql`
      FROM kitchen_tickets
     WHERE tenant_id = ${input.tenantId}::uuid
       AND outlet_id = ${input.outletId}::uuid
       AND done_at IS NOT NULL AND cancelled_at IS NULL
       AND done_at >= ${window.start}::timestamptz
       AND done_at < ${window.end}::timestamptz`;
    const seconds = (value: number): DailyMetricValue["value"] => ({
      unit: "seconds",
      value: Math.round(value),
    });
    const avg = sql`avg(extract(epoch FROM done_at - fired_at))`;
    const overall = await grouped(
      input,
      sql`SELECT NULL::text AS dim, ${avg} AS amount ${base}`,
    );
    const byStation = await grouped(
      input,
      sql`SELECT station_id::text AS dim, ${avg} AS amount ${base} GROUP BY station_id`,
    );
    const byHour = await grouped(
      input,
      sql`SELECT to_char(done_at AT TIME ZONE ${window.timezone}, 'HH24') AS dim,
                 ${avg} AS amount ${base} GROUP BY 1`,
    );
    return [
      {
        metricCode: "avg_serving_time",
        dimension: null,
        value: seconds(overall[0]?.amount ?? 0),
      },
      ...rowsOf("avg_serving_time", "station", byStation, seconds),
      ...rowsOf("avg_serving_time", "hour", byHour, seconds),
    ];
  },
};

// ---- remake and comp -------------------------------------------------------

const issueReader: DailyMetricReader = {
  metricCodes: ["remake_count", "comp_count"],
  dimensions: [],
  requiresDailyClose: true,
  async compute(input) {
    const result = await input.tx.execute(sql`
      SELECT kind, count(*) AS n
        FROM recipe_deductions
       WHERE tenant_id = ${input.tenantId}::uuid
         AND outlet_id = ${input.outletId}::uuid
         AND business_date = ${input.businessDate}::date
         AND kind IN ('remake', 'comp')
       GROUP BY kind`);
    const byKind = new Map(
      result.rows.map((row) => [String(row.kind), Number(row.n)]),
    );
    return [
      {
        metricCode: "remake_count",
        dimension: null,
        value: countValue(byKind.get("remake") ?? 0),
      },
      {
        metricCode: "comp_count",
        dimension: null,
        value: countValue(byKind.get("comp") ?? 0),
      },
    ];
  },
};

function dailySources(reader: DailyMetricReader): MetricSource[] {
  return reader.metricCodes.map((code) => ({
    kind: "daily" as const,
    code,
    reader,
  }));
}

const unavailable = (code: string): MetricSource => ({
  kind: "unavailable",
  code,
  reason: "source_not_built",
});

export const trafficOperationsSources: MetricSourceFamilyModule = {
  family: "traffic-operations",
  sources: [
    ...dailySources(paxReader),
    ...dailySources(floorReader),
    ...dailySources(queueReader),
    ...dailySources(servingReader),
    ...dailySources(issueReader),
    unavailable("failed_item_count"),
    unavailable("apology_voucher_count"),
    unavailable("device_offline_count"),
    unavailable("table_occupancy_pct"),
  ],
  splits: [],
};
