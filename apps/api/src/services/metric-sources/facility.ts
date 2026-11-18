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
// as available: its status has no history. Hours of a day are the version of
// `facility_operating_hours_versions` with the latest `effective_from` at or
// before that day (legend-4us1a), falling back to `facilities.operating_hours`
// when no version exists. Both minute readers still set `keepFinal`: once a
// day is final, it is never rewritten.
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
//
// WFC zones (bead legend-p4q10): zones with `floor_zones.is_wfc`, one `zone`
// dimension row per zone plus a total. Stored sums: seat_available_minutes
// (seats = capacity of the zone's tables that are not inactive, times the
// open minutes of the business date), seat_used_minutes (pax of each
// non-voided table session times its minutes inside the open window, a
// session still open at `now` counts up to `now`; capped at the available
// minutes) and wfc_net_sales (completed orders by `business_date` through
// order -> table session -> table -> zone, without tax and service charge:
// a tax-inclusive order backs both out of its gross subtotal; the order net
// is the dashboard's net_sales one, subtotal - discount - refunds, so revpash
// never overstates). Open window: the zone's `hours` for the weekday of the date,
// or the outlet's opening hours when the zone has none; a zone with no seats
// or no open minutes writes no row (absent, never a divide by zero).
// Derived: seat_occupancy_pct = used / available * 100 and revpash = net
// sales / available seat-minutes * 60 (rupiah per seat-hour).

import { sql } from "drizzle-orm";
import { businessDayRange, idr } from "@starter/shared/core";
import { minutesOfDay, type FacilityDayHours } from "@starter/shared/facility";
import { outletBusinessDayClock } from "../outlet-clock";
import { NOT_TRAINING_SQL, ORDER_NET_SQL, REFUNDS_JOIN } from "./sales";
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
      SELECT u.id, u.facility_id, f.type,
             coalesce(
               (SELECT v.operating_hours
                  FROM facility_operating_hours_versions v
                 WHERE v.tenant_id = f.tenant_id AND v.facility_id = f.id
                   AND v.effective_from <= ${input.businessDate}::date
                 ORDER BY v.effective_from DESC
                 LIMIT 1),
               f.operating_hours) AS operating_hours,
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

// ---- WFC zones: seat minutes and net sales (bead legend-p4q10) --------------

type ClockWindow = { start: number; end: number };
type ZoneHoursRow = { daysOfWeek: number[]; start: string; end: string };
type OutletDayHours = { opens: string; closes: string } | null;

const OUTLET_DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Minutes after local midnight; a close before the open runs past midnight, equal is no window. */
function clockWindow(start: string, end: string): ClockWindow | null {
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  if (from === to) return null;
  return { start: from, end: to > from ? to : to + 1440 };
}

/** Open windows of a zone on a weekday (0 = Sunday); no zone hours means the outlet's. */
function zoneWindows(
  hours: readonly ZoneHoursRow[],
  outletHours: Record<string, OutletDayHours>,
  weekday: number,
): ClockWindow[] {
  const outletDay = outletHours[OUTLET_DAY_KEYS[weekday]!] ?? null;
  const windows =
    hours.length > 0
      ? hours
          .filter((entry) => entry.daysOfWeek.includes(weekday))
          .map((entry) => clockWindow(entry.start, entry.end))
      : [
          outletDay === null
            ? null
            : clockWindow(outletDay.opens, outletDay.closes),
        ];
  return windows.filter((window): window is ClockWindow => window !== null);
}

type WfcZoneDay = {
  zoneId: string;
  availableMinutes: number;
  usedMinutes: number;
  netSalesIdr: number;
};

async function loadWfcDay(
  tx: Tx,
  input: DailyComputeInput,
): Promise<WfcZoneDay[]> {
  const { tenantId, outletId, businessDate } = input;
  const outlet = (
    await tx.execute(sql`
      SELECT timezone, opening_hours FROM outlets
       WHERE tenant_id = ${tenantId} AND id = ${outletId}`)
  ).rows[0] as Row | undefined;
  if (!outlet) throw new Error("Outlet not found");
  // Local midnight of the date (a zero cutoff); windows are offsets from it.
  const midnight = businessDayRange(businessDate, {
    timeZone: String(outlet.timezone),
    cutoff: "00:00",
  }).start.getTime();
  const weekday = new Date(`${businessDate}T00:00:00Z`).getUTCDay();
  const outletHours = outlet.opening_hours as Record<string, OutletDayHours>;

  const zones = (
    await tx.execute(sql`
      SELECT z.id, z.hours,
             coalesce(sum(t.capacity) FILTER (WHERE t.status <> 'inactive'), 0) AS seats
        FROM floor_zones z
        LEFT JOIN tables t ON t.tenant_id = z.tenant_id AND t.zone_id = z.id
       WHERE z.tenant_id = ${tenantId} AND z.outlet_id = ${outletId} AND z.is_wfc
       GROUP BY z.id, z.hours
       ORDER BY z.id`)
  ).rows as Row[];

  const open = new Map<
    string,
    { seats: number; windows: { from: number; to: number }[] }
  >();
  for (const zone of zones) {
    const seats = num(zone.seats);
    const windows = zoneWindows(
      zone.hours as ZoneHoursRow[],
      outletHours,
      weekday,
    ).map((window) => ({
      from: midnight + window.start * 60_000,
      to: midnight + window.end * 60_000,
    }));
    if (seats > 0 && windows.length > 0)
      open.set(String(zone.id), { seats, windows });
  }
  if (open.size === 0) return [];

  // Sessions that may touch a window (windows end before midnight + 2 days).
  const rangeStart = new Date(midnight).toISOString();
  const rangeEnd = new Date(midnight + 2 * 1440 * 60_000).toISOString();
  const nowMs = input.now.getTime();
  const sessions = (
    await tx.execute(sql`
      SELECT t.zone_id, ts.pax,
             extract(epoch FROM ts.opened_at) * 1000 AS opened_at,
             extract(epoch FROM ts.closed_at) * 1000 AS closed_at
        FROM table_sessions ts
        JOIN tables t ON t.tenant_id = ts.tenant_id AND t.id = ts.table_id
        JOIN floor_zones z ON z.tenant_id = t.tenant_id AND z.id = t.zone_id
       WHERE ts.tenant_id = ${tenantId} AND ts.outlet_id = ${outletId}
         AND z.is_wfc
         AND ts.status NOT IN ('voided', 'pending_confirmation')
         AND ts.opened_at < ${rangeEnd}::timestamptz
         AND coalesce(ts.closed_at, ${input.now.toISOString()}::timestamptz) > ${rangeStart}::timestamptz`)
  ).rows as Row[];
  const usedMs = new Map<string, number>();
  for (const session of sessions) {
    const zone = open.get(String(session.zone_id));
    if (!zone) continue;
    const from = num(session.opened_at);
    const to = session.closed_at === null ? nowMs : num(session.closed_at);
    for (const window of zone.windows) {
      const overlap = Math.min(to, window.to) - Math.max(from, window.from);
      if (overlap > 0)
        usedMs.set(
          String(session.zone_id),
          (usedMs.get(String(session.zone_id)) ?? 0) +
            num(session.pax) * overlap,
        );
    }
  }

  const sales = (
    await tx.execute(sql`
      SELECT t.zone_id,
             sum(CASE WHEN o.prices_include_tax
                      THEN ${ORDER_NET_SQL} - o.tax_idr - o.service_charge_idr
                      ELSE ${ORDER_NET_SQL} END) AS net
        FROM orders o
        ${REFUNDS_JOIN}
        JOIN table_sessions ts ON ts.tenant_id = o.tenant_id AND ts.id = o.table_session_id
        JOIN tables t ON t.tenant_id = ts.tenant_id AND t.id = ts.table_id
        JOIN floor_zones z ON z.tenant_id = t.tenant_id AND z.id = t.zone_id
       WHERE o.tenant_id = ${tenantId} AND o.outlet_id = ${outletId}
         AND o.status = 'completed'
         AND ${NOT_TRAINING_SQL}
         AND o.business_date = ${businessDate}::date
         AND z.is_wfc
       GROUP BY t.zone_id`)
  ).rows as Row[];
  const net = new Map(sales.map((row) => [String(row.zone_id), num(row.net)]));

  return [...open].map(([zoneId, zone]) => {
    const availableMinutes =
      zone.seats *
      zone.windows.reduce((sum, w) => sum + (w.to - w.from) / 60_000, 0);
    return {
      zoneId,
      availableMinutes,
      usedMinutes: Math.min(
        availableMinutes,
        Math.round((usedMs.get(zoneId) ?? 0) / 60_000),
      ),
      netSalesIdr: net.get(zoneId) ?? 0,
    };
  });
}

const WFC_SEAT_CODES = [
  "seat_available_minutes",
  "seat_used_minutes",
  "wfc_net_sales",
] as const;

/** Seat minutes and net sales of each WFC zone with seats and open hours, plus the outlet total. */
const wfcSeatReader: DailyMetricReader = {
  metricCodes: WFC_SEAT_CODES,
  dimensions: ["zone"],
  requiresDailyClose: false,
  keepFinal: true,
  async compute(input) {
    const zones = await loadWfcDay(input.tx, input);
    const rows = (
      dimension: Dimension | null,
      available: number,
      used: number,
      sales: number,
    ): DailyMetricValue[] => [
      {
        metricCode: "seat_available_minutes",
        dimension,
        value: count(available),
      },
      { metricCode: "seat_used_minutes", dimension, value: count(used) },
      {
        metricCode: "wfc_net_sales",
        dimension,
        value: { unit: "idr", valueIdr: idr(sales) },
      },
    ];
    const sum = (pick: (zone: WfcZoneDay) => number) =>
      zones.reduce((total, zone) => total + pick(zone), 0);
    return [
      ...rows(
        null,
        sum((zone) => zone.availableMinutes),
        sum((zone) => zone.usedMinutes),
        sum((zone) => zone.netSalesIdr),
      ),
      ...zones.flatMap((zone) =>
        rows(
          { key: "zone", value: zone.zoneId },
          zone.availableMinutes,
          zone.usedMinutes,
          zone.netSalesIdr,
        ),
      ),
    ];
  },
};

const derived = (
  code: string,
  numerator: string,
  denominator: string,
  scale: 1 | 60 | 100,
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
    ...WFC_SEAT_CODES.map((code): MetricSource => ({
      kind: "daily",
      code,
      reader: wfcSeatReader,
    })),
    derived(
      "seat_occupancy_pct",
      "seat_used_minutes",
      "seat_available_minutes",
      100,
    ),
    derived("revpash", "wfc_net_sales", "seat_available_minutes", 60),
    ...UNAVAILABLE_CODES.map((code): MetricSource => ({
      kind: "unavailable",
      code,
      reason: "source_not_built",
    })),
  ],
  splits: [],
};
