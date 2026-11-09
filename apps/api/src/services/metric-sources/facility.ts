// Metric sources of the "facility" family. Owned by this family's card (bead
// legend-60tsm F10): add sources and splits here, never in another file.
//
// Numeric (read from `access_tickets`, `facility_units`, `facilities` and
// `facility_incidents`, one outlet business day at a time): shower_sessions
// (shower facilities only), facility_overtime_sessions / _seconds and
// facility_incident_count. All four are sums, so the engine adds the stored
// days correctly. None is a money metric, so the ledger rule does not apply.
//
// Unavailable (`source_not_built`), each for a missing table, link or
// engine capability:
// - shower_occupancy_pct, unit_utilization_pct, facility_incident_response_
//   seconds: catalog aggregation is `average`, and the engine averages the
//   stored daily values without weights, which is wrong for a percent of used
//   over open minutes and for a mean response time. They need sum + count
//   codes (used minutes / open minutes, response seconds / answered
//   incidents) plus a `derived` ratio: a catalog change, see
//   docs/briefs/268b-requests-facility.md. `facility_units` has no archived
//   column (only `created_at`), so open minutes also need a unit lifecycle.
// - shower_revenue, facility_product_revenue, facility_product_sales: tickets
//   carry no price and the payment flow that sets `payment_intents.
//   access_ticket_id` is not built; subscriptions have no table. Both revenue
//   codes stay in `NON_GL_MONEY_METRICS` (shared file, unchanged).
// - active_subscriptions: no subscription table.
// - wifi_sessions, wifi_quota_used: `wifi_device_grants` is edge-local, empty
//   on the cloud and purged after 30 days; there is no quota table.
// - shower_sessions_with_fnb, shower_fnb_conversion_pct: no link from an
//   order to an access ticket.
// - facility_cleaning_count / _seconds: no cleaning task table (the ticket's
//   cleaning buffer is a plan, not a measured duration).
// - revpash, seat_occupancy_pct: the seat model of the WFC zone (pax or table
//   capacity, zone revenue) is not defined.

import { sql } from "drizzle-orm";
import { businessDayRange } from "@starter/shared/core";
import { outletBusinessDayClock } from "../outlet-clock";
import type {
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSource,
  MetricSourceFamilyModule,
  Tx,
} from "./types";

type Row = Record<string, unknown>;
type Dimension = NonNullable<DailyMetricValue["dimension"]>;

const facilityDimension = (value: string): Dimension => ({
  key: "facility",
  value,
});
const unitDimension = (value: string): Dimension => ({ key: "unit", value });

const count = (value: number) => ({ unit: "count" as const, value });
const seconds = (value: number) => ({ unit: "seconds" as const, value });

type FacilityUnit = { id: string; facilityId: string; type: string };

type Ticket = {
  unitId: string;
  facilityId: string;
  endsAt: number;
  endedAt: number | null;
};

type Day = {
  startMs: number;
  endMs: number;
  units: FacilityUnit[];
  tickets: Ticket[];
  incidents: { facilityId: string; unitId: string | null }[];
};

const num = (value: unknown): number => Number(value);

async function loadDay(
  tx: Tx,
  { tenantId, outletId, businessDate }: DailyComputeInput,
): Promise<Day> {
  const outlet = (
    await tx.execute(sql`
      SELECT timezone, business_day_cutoff FROM outlets
       WHERE tenant_id = ${tenantId} AND id = ${outletId}`)
  ).rows[0] as Row | undefined;
  if (!outlet) throw new Error("Outlet not found");
  const range = businessDayRange(
    businessDate,
    outletBusinessDayClock({
      timezone: String(outlet.timezone),
      businessDayCutoff: String(outlet.business_day_cutoff),
    }),
  );
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();

  const units = (
    await tx.execute(sql`
      SELECT u.id, u.facility_id, f.type
        FROM facility_units u
        JOIN facilities f ON f.tenant_id = u.tenant_id AND f.id = u.facility_id
       WHERE u.tenant_id = ${tenantId} AND u.outlet_id = ${outletId}
       ORDER BY u.id`)
  ).rows.map((row: Row): FacilityUnit => ({
    id: String(row.id),
    facilityId: String(row.facility_id),
    type: String(row.type),
  }));

  // Only tickets that ended inside the business day count: completed ones
  // for sessions and overtime.
  const tickets = (
    await tx.execute(sql`
      SELECT unit_id, facility_id,
             extract(epoch FROM ends_at) * 1000 AS ends_at,
             extract(epoch FROM ended_at) * 1000 AS ended_at
        FROM access_tickets
       WHERE tenant_id = ${tenantId} AND outlet_id = ${outletId}
         AND status = 'completed'
         AND coalesce(ended_at, ends_at) >= ${startIso}::timestamptz
         AND coalesce(ended_at, ends_at) < ${endIso}::timestamptz`)
  ).rows.map((row: Row): Ticket => ({
    unitId: String(row.unit_id),
    facilityId: String(row.facility_id),
    endsAt: num(row.ends_at),
    endedAt: row.ended_at === null ? null : num(row.ended_at),
  }));

  const incidents = (
    await tx.execute(sql`
      SELECT facility_id, unit_id
        FROM facility_incidents
       WHERE tenant_id = ${tenantId} AND outlet_id = ${outletId}
         AND triggered_at >= ${startIso}::timestamptz
         AND triggered_at < ${endIso}::timestamptz`)
  ).rows.map((row: Row) => ({
    facilityId: String(row.facility_id),
    unitId: row.unit_id === null ? null : String(row.unit_id),
  }));

  return {
    startMs: range.start.getTime(),
    endMs: range.end.getTime(),
    units,
    tickets,
    incidents,
  };
}

function showerSessions(day: Day): DailyMetricValue[] {
  const code = "shower_sessions";
  const shower = day.units.filter((unit) => unit.type === "shower");
  const showerIds = new Set(shower.map((unit) => unit.id));
  const perUnit = new Map(shower.map((unit) => [unit.id, 0]));
  const perFacility = new Map(shower.map((unit) => [unit.facilityId, 0]));
  let total = 0;
  for (const ticket of day.tickets) {
    if (!showerIds.has(ticket.unitId)) continue;
    total += 1;
    perUnit.set(ticket.unitId, (perUnit.get(ticket.unitId) ?? 0) + 1);
    perFacility.set(
      ticket.facilityId,
      (perFacility.get(ticket.facilityId) ?? 0) + 1,
    );
  }
  return [
    { metricCode: code, dimension: null, value: count(total) },
    ...[...perFacility].map(([id, n]) => ({
      metricCode: code,
      dimension: facilityDimension(id),
      value: count(n),
    })),
    ...[...perUnit].map(([id, n]) => ({
      metricCode: code,
      dimension: unitDimension(id),
      value: count(n),
    })),
  ];
}

function overtime(day: Day): DailyMetricValue[] {
  const sessionsCode = "facility_overtime_sessions";
  const secondsCode = "facility_overtime_seconds";
  type Acc = { sessions: number; seconds: number };
  const perUnit = new Map<string, Acc>(
    day.units.map((unit) => [unit.id, { sessions: 0, seconds: 0 }]),
  );
  const perFacility = new Map<string, Acc>(
    day.units.map((unit) => [unit.facilityId, { sessions: 0, seconds: 0 }]),
  );
  const total: Acc = { sessions: 0, seconds: 0 };
  for (const ticket of day.tickets) {
    if (ticket.endedAt === null || ticket.endedAt <= ticket.endsAt) continue;
    const over = Math.floor((ticket.endedAt - ticket.endsAt) / 1000);
    for (const acc of [
      total,
      perUnit.get(ticket.unitId),
      perFacility.get(ticket.facilityId),
    ]) {
      if (!acc) continue;
      acc.sessions += 1;
      acc.seconds += over;
    }
  }
  const rows = (dimension: Dimension | null, acc: Acc): DailyMetricValue[] => [
    { metricCode: sessionsCode, dimension, value: count(acc.sessions) },
    { metricCode: secondsCode, dimension, value: seconds(acc.seconds) },
  ];
  return [
    ...rows(null, total),
    ...[...perFacility].flatMap(([id, acc]) =>
      rows(facilityDimension(id), acc),
    ),
    ...[...perUnit].flatMap(([id, acc]) => rows(unitDimension(id), acc)),
  ];
}

function incidentCount(day: Day): DailyMetricValue[] {
  const code = "facility_incident_count";
  const perUnit = new Map(day.units.map((unit) => [unit.id, 0]));
  const perFacility = new Map(day.units.map((unit) => [unit.facilityId, 0]));
  for (const incident of day.incidents) {
    perFacility.set(
      incident.facilityId,
      (perFacility.get(incident.facilityId) ?? 0) + 1,
    );
    if (incident.unitId !== null)
      perUnit.set(incident.unitId, (perUnit.get(incident.unitId) ?? 0) + 1);
  }
  return [
    { metricCode: code, dimension: null, value: count(day.incidents.length) },
    ...[...perFacility].map(([id, n]) => ({
      metricCode: code,
      dimension: facilityDimension(id),
      value: count(n),
    })),
    ...[...perUnit].map(([id, n]) => ({
      metricCode: code,
      dimension: unitDimension(id),
      value: count(n),
    })),
  ];
}

const FACILITY_UNIT_CODES = [
  "shower_sessions",
  "facility_overtime_sessions",
  "facility_overtime_seconds",
  "facility_incident_count",
] as const;

/** Total, facility and unit rows of the four sums above. */
const facilityUnitReader: DailyMetricReader = {
  metricCodes: FACILITY_UNIT_CODES,
  dimensions: ["facility", "unit"],
  requiresDailyClose: false,
  async compute(input) {
    const day = await loadDay(input.tx, input);
    return [...showerSessions(day), ...overtime(day), ...incidentCount(day)];
  },
};

const UNAVAILABLE_CODES = [
  "shower_occupancy_pct",
  "unit_utilization_pct",
  "facility_incident_response_seconds",
  "shower_revenue",
  "facility_product_revenue",
  "facility_product_sales",
  "active_subscriptions",
  "wifi_sessions",
  "wifi_quota_used",
  "shower_sessions_with_fnb",
  "shower_fnb_conversion_pct",
  "facility_cleaning_count",
  "facility_cleaning_seconds",
  "revpash",
  "seat_occupancy_pct",
] as const;

export const facilitySources: MetricSourceFamilyModule = {
  family: "facility",
  sources: [
    ...FACILITY_UNIT_CODES.map((code): MetricSource => ({
      kind: "daily",
      code,
      reader: facilityUnitReader,
    })),
    ...UNAVAILABLE_CODES.map((code): MetricSource => ({
      kind: "unavailable",
      code,
      reason: "source_not_built",
    })),
  ],
  splits: [],
};
