// Metric sources of the "facility" family. Owned by this family's card (bead
// legend-60tsm F10): add sources and splits here, never in another file.
//
// Numeric (read from `access_tickets`, `facility_units`, `facilities` and
// `facility_incidents`, one outlet business day at a time): shower_sessions
// (shower facilities only), facility_overtime_sessions / _seconds,
// facility_incident_count, facility_incident_response_total_seconds /
// _answered_count, and the used / available minutes of shower booths and of
// every unit. All are sums, so the engine adds the stored days correctly.
// None is a money metric, so the ledger rule does not apply.
//
// Derived (recomputed per bucket from two sums, never stored; brief 268b §1):
// shower_occupancy_pct, unit_utilization_pct and
// facility_incident_response_seconds.
//
// Minutes are counted per whole minute of the business day: a minute is
// available when the facility's `operating_hours` cover it and the unit
// already existed (`created_at`; there is no retirement column, so a removed
// unit is not detected), and used when it is available and an `in_use` or
// `completed` ticket of the unit covers it, from `starts_at` to `ended_at`
// (or, while the ticket has no end, up to the job's `now` capped at the day
// end; never its planned `ends_at`). A unit under maintenance still counts
// as available: its status has no history. Hours come from today's
// `facilities.operating_hours`, which has no effective date yet (follow-up
// card), so both minute readers set `keepFinal`: once a day is final, a later
// change of hours never rewrites it.
//
// An incident is answered when it has `responded_at`; it counts on the
// business day it was triggered. The response sums have their own reader
// that holds the day (`pendingDay`) while any incident of it is unanswered.
//
// Unavailable (`source_not_built`), each for a missing table, link or
// engine capability:
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
import { minutesOfDay, type FacilityDayHours } from "@starter/shared/facility";
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

type FacilityUnit = {
  id: string;
  facilityId: string;
  type: string;
  createdAt: number;
  hours: FacilityDayHours[];
};

type Ticket = {
  unitId: string;
  facilityId: string;
  endsAt: number;
  endedAt: number | null;
};

/** An `in_use` / `completed` ticket's occupied span, [from, to). */
type Usage = { unitId: string; from: number; to: number };

type Incident = {
  facilityId: string;
  unitId: string | null;
  /** Seconds from trigger to response; null while unanswered. */
  responseSeconds: number | null;
};

type Day = {
  startMs: number;
  endMs: number;
  timezone: string;
  units: FacilityUnit[];
  tickets: Ticket[];
  usages: Usage[];
  incidents: Incident[];
};

const num = (value: unknown): number => Number(value);

/** The outlet's business day as a UTC range, plus the outlet's timezone. */
async function dayRange(
  tx: Tx,
  { tenantId, outletId, businessDate }: DailyComputeInput,
) {
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
  return { ...range, timezone: String(outlet.timezone) };
}

async function loadDay(tx: Tx, input: DailyComputeInput): Promise<Day> {
  const { tenantId, outletId } = input;
  const range = await dayRange(tx, input);
  const startIso = range.start.toISOString();
  const endIso = range.end.toISOString();
  // A running ticket is used up to the job's clock, never past the day end.
  const runningTo = Math.min(input.now.getTime(), range.end.getTime());
  const nowIso = input.now.toISOString();

  const units = (
    await tx.execute(sql`
      SELECT u.id, u.facility_id, f.type, f.operating_hours,
             extract(epoch FROM u.created_at) * 1000 AS created_at
        FROM facility_units u
        JOIN facilities f ON f.tenant_id = u.tenant_id AND f.id = u.facility_id
       WHERE u.tenant_id = ${tenantId} AND u.outlet_id = ${outletId}
       ORDER BY u.id`)
  ).rows.map((row: Row): FacilityUnit => ({
    id: String(row.id),
    facilityId: String(row.facility_id),
    type: String(row.type),
    createdAt: num(row.created_at),
    hours: row.operating_hours as FacilityDayHours[],
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

  // Occupied spans of running and finished tickets that touch the day.
  const usages = (
    await tx.execute(sql`
      SELECT unit_id,
             extract(epoch FROM starts_at) * 1000 AS starts_at,
             extract(epoch FROM ended_at) * 1000 AS ended_at
        FROM access_tickets
       WHERE tenant_id = ${tenantId} AND outlet_id = ${outletId}
         AND status IN ('in_use', 'completed')
         AND starts_at < ${endIso}::timestamptz
         AND coalesce(ended_at, ${nowIso}::timestamptz) > ${startIso}::timestamptz`)
  ).rows.map((row: Row): Usage => ({
    unitId: String(row.unit_id),
    from: num(row.starts_at),
    to: row.ended_at === null ? runningTo : num(row.ended_at),
  }));

  const incidents = (
    await tx.execute(sql`
      SELECT facility_id, unit_id,
             floor(extract(epoch FROM responded_at - triggered_at)) AS response
        FROM facility_incidents
       WHERE tenant_id = ${tenantId} AND outlet_id = ${outletId}
         AND triggered_at >= ${startIso}::timestamptz
         AND triggered_at < ${endIso}::timestamptz`)
  ).rows.map((row: Row): Incident => ({
    facilityId: String(row.facility_id),
    unitId: row.unit_id === null ? null : String(row.unit_id),
    responseSeconds:
      row.response === null ? null : Math.max(0, num(row.response)),
  }));

  return {
    startMs: range.start.getTime(),
    endMs: range.end.getTime(),
    timezone: range.timezone,
    units,
    tickets,
    usages,
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

function incidentResponse(day: Day): DailyMetricValue[] {
  const secondsCode = "facility_incident_response_total_seconds";
  const answeredCode = "facility_incident_answered_count";
  type Acc = { seconds: number; answered: number };
  const zero = (): Acc => ({ seconds: 0, answered: 0 });
  const perUnit = new Map(day.units.map((unit) => [unit.id, zero()]));
  const perFacility = new Map(
    day.units.map((unit) => [unit.facilityId, zero()]),
  );
  const total = zero();
  for (const incident of day.incidents) {
    if (incident.responseSeconds === null) continue;
    if (!perFacility.has(incident.facilityId))
      perFacility.set(incident.facilityId, zero());
    const accs = [total, perFacility.get(incident.facilityId)];
    if (incident.unitId !== null) {
      if (!perUnit.has(incident.unitId)) perUnit.set(incident.unitId, zero());
      accs.push(perUnit.get(incident.unitId));
    }
    for (const acc of accs) {
      acc!.seconds += incident.responseSeconds;
      acc!.answered += 1;
    }
  }
  const rows = (dimension: Dimension | null, acc: Acc): DailyMetricValue[] => [
    { metricCode: secondsCode, dimension, value: seconds(acc.seconds) },
    { metricCode: answeredCode, dimension, value: count(acc.answered) },
  ];
  return [
    ...rows(null, total),
    ...[...perFacility].flatMap(([id, acc]) =>
      rows(facilityDimension(id), acc),
    ),
    ...[...perUnit].flatMap(([id, acc]) => rows(unitDimension(id), acc)),
  ];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Outlet wall clock (weekday, minute of day, `HH`) of each business-day minute. */
function minuteClocks(day: Day) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: day.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const clocks: { at: number; dow: number; minute: number; hour: string }[] =
    [];
  for (let at = day.startMs; at < day.endMs; at += 60_000) {
    const parts = format.formatToParts(new Date(at));
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    const hour = part("hour");
    clocks.push({
      at,
      dow: WEEKDAYS.indexOf(part("weekday") as (typeof WEEKDAYS)[number]),
      minute: Number(hour) * 60 + Number(part("minute")),
      hour,
    });
  }
  return clocks;
}

/**
 * Used and available minutes of the given units: total, facility, unit and
 * (when `byHour`) outlet-hour rows. Every unit and every open hour gets both
 * rows, zero included, so the derived percent always has its two inputs.
 */
function minuteRows(
  day: Day,
  units: readonly FacilityUnit[],
  codes: { used: string; available: string },
  byHour: boolean,
): DailyMetricValue[] {
  type Acc = { used: number; available: number };
  const zero = (): Acc => ({ used: 0, available: 0 });
  const total = zero();
  const perFacility = new Map(units.map((unit) => [unit.facilityId, zero()]));
  const perUnit = new Map(units.map((unit) => [unit.id, zero()]));
  const perHour = new Map<string, Acc>();
  const clocks = units.length === 0 ? [] : minuteClocks(day);
  for (const unit of units) {
    const windows = unit.hours.map((hours) => ({
      days: hours.daysOfWeek,
      opens: minutesOfDay(hours.opensAt),
      closes: minutesOfDay(hours.closesAt),
    }));
    const usages = day.usages.filter((usage) => usage.unitId === unit.id);
    for (const clock of clocks) {
      if (clock.at < unit.createdAt) continue;
      const open = windows.some(
        (window) =>
          window.days.includes(clock.dow) &&
          clock.minute >= window.opens &&
          clock.minute < window.closes,
      );
      if (!open) continue;
      const used = usages.some(
        (usage) => usage.from <= clock.at && clock.at < usage.to,
      );
      if (byHour && !perHour.has(clock.hour)) perHour.set(clock.hour, zero());
      for (const acc of [
        total,
        perFacility.get(unit.facilityId),
        perUnit.get(unit.id),
        byHour ? perHour.get(clock.hour) : undefined,
      ]) {
        if (!acc) continue;
        acc.available += 1;
        if (used) acc.used += 1;
      }
    }
  }
  const rows = (dimension: Dimension | null, acc: Acc): DailyMetricValue[] => [
    { metricCode: codes.used, dimension, value: count(acc.used) },
    { metricCode: codes.available, dimension, value: count(acc.available) },
  ];
  return [
    ...rows(null, total),
    ...[...perFacility].flatMap(([id, acc]) =>
      rows(facilityDimension(id), acc),
    ),
    ...[...perUnit].flatMap(([id, acc]) => rows(unitDimension(id), acc)),
    ...[...perHour].flatMap(([hour, acc]) =>
      rows({ key: "hour", value: hour }, acc),
    ),
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

const INCIDENT_RESPONSE_CODES = [
  "facility_incident_response_total_seconds",
  "facility_incident_answered_count",
] as const;

/**
 * Response seconds and answered count: total, facility and unit rows. Held
 * while an incident of the day is unanswered, since its answer still changes
 * both sums.
 */
const incidentResponseReader: DailyMetricReader = {
  metricCodes: INCIDENT_RESPONSE_CODES,
  dimensions: ["facility", "unit"],
  requiresDailyClose: false,
  async pendingDay(input) {
    const range = await dayRange(input.tx, input);
    const open = await input.tx.execute(sql`
      SELECT 1 FROM facility_incidents
       WHERE tenant_id = ${input.tenantId} AND outlet_id = ${input.outletId}
         AND triggered_at >= ${range.start.toISOString()}::timestamptz
         AND triggered_at < ${range.end.toISOString()}::timestamptz
         AND responded_at IS NULL
       LIMIT 1`);
    return open.rows.length > 0;
  },
  async compute(input) {
    return incidentResponse(await loadDay(input.tx, input));
  },
};

const SHOWER_MINUTE_CODES = [
  "shower_used_minutes",
  "shower_available_minutes",
] as const;

/** Used and open minutes of shower booths: total, facility and unit rows. */
const showerMinutesReader: DailyMetricReader = {
  metricCodes: SHOWER_MINUTE_CODES,
  dimensions: ["facility", "unit"],
  requiresDailyClose: false,
  keepFinal: true,
  async compute(input) {
    const day = await loadDay(input.tx, input);
    return minuteRows(
      day,
      day.units.filter((unit) => unit.type === "shower"),
      { used: "shower_used_minutes", available: "shower_available_minutes" },
      false,
    );
  },
};

const UNIT_MINUTE_CODES = [
  "unit_used_minutes",
  "unit_available_minutes",
] as const;

/** Used and open minutes of every unit: total, facility, unit and hour rows. */
const unitMinutesReader: DailyMetricReader = {
  metricCodes: UNIT_MINUTE_CODES,
  dimensions: ["facility", "unit", "hour"],
  requiresDailyClose: false,
  keepFinal: true,
  async compute(input) {
    const day = await loadDay(input.tx, input);
    return minuteRows(
      day,
      day.units,
      { used: "unit_used_minutes", available: "unit_available_minutes" },
      true,
    );
  },
};

const derived = (
  code: string,
  numerator: string,
  denominator: string,
  scale: 1 | 100,
): MetricSource => ({ kind: "derived", code, numerator, denominator, scale });

const UNAVAILABLE_CODES = [
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
    ...INCIDENT_RESPONSE_CODES.map((code): MetricSource => ({
      kind: "daily",
      code,
      reader: incidentResponseReader,
    })),
    ...SHOWER_MINUTE_CODES.map((code): MetricSource => ({
      kind: "daily",
      code,
      reader: showerMinutesReader,
    })),
    ...UNIT_MINUTE_CODES.map((code): MetricSource => ({
      kind: "daily",
      code,
      reader: unitMinutesReader,
    })),
    derived(
      "shower_occupancy_pct",
      "shower_used_minutes",
      "shower_available_minutes",
      100,
    ),
    derived(
      "unit_utilization_pct",
      "unit_used_minutes",
      "unit_available_minutes",
      100,
    ),
    derived(
      "facility_incident_response_seconds",
      "facility_incident_response_total_seconds",
      "facility_incident_answered_count",
      1,
    ),
    ...UNAVAILABLE_CODES.map((code): MetricSource => ({
      kind: "unavailable",
      code,
      reason: "source_not_built",
    })),
  ],
  splits: [],
};
