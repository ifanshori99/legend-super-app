// Date and time rules for DTOs (PRD §6: TIMESTAMPTZ, shown in Asia/Jakarta).
// - Instants (created_at, paid_at, occurred_at): ISO 8601 with an offset. The
//   server always emits UTC with milliseconds ("2026-11-01T13:00:00.000Z");
//   clients may send any offset. A string without an offset is rejected.
// - Business dates (business day, payroll period, report date): "YYYY-MM-DD",
//   never an instant. An instant's business date is the local calendar date
//   of (instant − outlet business_day_cutoff) in the outlet time zone (owner
//   Q39, default 04:00): use `businessDateOf` / `businessDayRange`. Wall-clock
//   schedules (opening hours, reservation day, shift roster) use the plain
//   calendar date, `localDateOf`.
// - Times of day (opening hours, shift start): "HH:mm", outlet-local.
// - Time zone: IANA name per outlet (outlets.timezone), default Asia/Jakarta.
// The server derives business dates; clients never compute them from local
// device time.

import { z } from "zod";

export const DEFAULT_TIME_ZONE = "Asia/Jakarta";

export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const businessDateSchema = z.iso.date();
export const timeOfDaySchema = z.iso.time({ precision: -1 });
export const timeZoneSchema = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Unknown IANA time zone");

export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type BusinessDate = z.infer<typeof businessDateSchema>;
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/** Serializes an instant the way the API emits it (UTC, milliseconds). */
export function toIsoDateTime(instant: Date): IsoDateTime {
  return instant.toISOString();
}

const DAY_MS = 86_400_000;

/**
 * Owner Q39 (2026-11-03): each outlet sets when its business day starts
 * (`outlets.business_day_cutoff`, default 04:00), so sales at 01:30 after a
 * late Friday close still belong to Friday. Allowed 00:00..11:59: the cutoff
 * is the small hours after closing, never the afternoon.
 */
export const DEFAULT_BUSINESS_DAY_CUTOFF = "04:00";
export const businessDayCutoffSchema = timeOfDaySchema.refine(
  (value) => value < "12:00",
  "Business day cutoff must be between 00:00 and 11:59",
);
export type BusinessDayCutoff = z.infer<typeof businessDayCutoffSchema>;

/** The two outlet settings a business date needs. */
export type BusinessDayClock = {
  readonly timeZone: string;
  readonly cutoff: string;
};
/** Asia/Jakarta, 04:00: for screens and fixtures that have no outlet yet. */
export const DEFAULT_BUSINESS_DAY_CLOCK: BusinessDayClock = Object.freeze({
  timeZone: DEFAULT_TIME_ZONE,
  cutoff: DEFAULT_BUSINESS_DAY_CUTOFF,
});

function toInstant(instant: Date | string): Date {
  const date =
    typeof instant === "string"
      ? new Date(isoDateTimeSchema.parse(instant))
      : instant;
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  return date;
}

function cutoffMinutes(cutoff: string): number {
  const match = /^([01]\d):([0-5]\d)$/.exec(cutoff);
  if (!match) throw new RangeError(`Invalid business day cutoff: ${cutoff}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  bc: boolean;
};

function wallClockOf(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    // en-US years are era-based: 1 BC is year "1" with era "BC".
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
    bc: part("era") !== "AD",
  };
}

function formatDate(year: number, month: number, day: number): BusinessDate {
  if (!Number.isInteger(year) || year < 1 || year > 9999)
    throw new RangeError("Business date outside 0001-01-01..9999-12-31");
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** UTC epoch ms of a proleptic-Gregorian wall time (years 1..9999 safe). */
function utcMs(
  year: number,
  month: number,
  day: number,
  minutes = 0,
  seconds = 0,
): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, minutes, seconds, 0);
  return date.getTime();
}

function parseDate(date: string): [number, number, number] {
  const value = businessDateSchema.parse(date);
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return [year, month, day];
}

/** "2026-11-01" + 1 = "2026-11-02" (pure calendar arithmetic, no zone). */
export function addBusinessDays(
  date: BusinessDate,
  days: number,
): BusinessDate {
  const [year, month, day] = parseDate(date);
  const shifted = new Date(utcMs(year, month, day) + days * DAY_MS);
  return formatDate(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
  );
}

/**
 * Calendar date of an instant in a time zone, with NO business-day cutoff.
 * For wall-clock schedules only (reservation day, shift roster, facility slot
 * day, opening hours): anything that sums or limits a day's trade uses
 * `businessDateOf` instead. Supported range: dates 0001-01-01 to 9999-12-31
 * in that time zone; anything outside it, or an invalid Date, throws
 * RangeError.
 */
export function localDateOf(
  instant: Date | string,
  timeZone: string = DEFAULT_TIME_ZONE,
): BusinessDate {
  const clock = wallClockOf(toInstant(instant), timeZone);
  if (clock.bc)
    throw new RangeError("Business date outside 0001-01-01..9999-12-31");
  return formatDate(clock.year, clock.month, clock.day);
}

/**
 * The outlet business date of an instant (owner Q39): the local calendar date
 * of (instant − cutoff) in the outlet time zone. With cutoff 04:00 in WIB,
 * 03:59 on 2 Nov is business date 1 Nov and 04:00 starts 2 Nov. Compared on
 * the local wall clock, so a DST zone still flips exactly at the cutoff.
 * Every daily counter, daily limit, report day, posting date and "today"
 * shown to staff goes through this helper.
 */
export function businessDateOf(
  instant: Date | string,
  clock: BusinessDayClock,
): BusinessDate {
  const cutoff = cutoffMinutes(clock.cutoff);
  const wall = wallClockOf(toInstant(instant), clock.timeZone);
  if (wall.bc)
    throw new RangeError("Business date outside 0001-01-01..9999-12-31");
  const date = formatDate(wall.year, wall.month, wall.day);
  return wall.hour * 60 + wall.minute < cutoff
    ? addBusinessDays(date, -1)
    : date;
}

/** Wall-clock offset (ms) of a time zone at an instant (WIB = +7 h). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const wall = wallClockOf(new Date(instant), timeZone);
  const year = wall.bc ? 1 - wall.year : wall.year;
  const local = utcMs(
    year,
    wall.month,
    wall.day,
    wall.hour * 60 + wall.minute,
    wall.second,
  );
  return local - Math.floor(instant / 1000) * 1000;
}

/** The instant a local wall time (date + minutes after midnight) happens. */
function zonedInstant(
  date: BusinessDate,
  minutes: number,
  timeZone: string,
): Date {
  const [year, month, day] = parseDate(date);
  const wall = utcMs(year, month, day, minutes);
  // Two passes settle the offset even across a DST change.
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

/**
 * Half-open instant range [start, end) of one outlet business date: start is
 * the cutoff on that local date, end the cutoff on the next. An instant `t`
 * is inside exactly when `businessDateOf(t, clock) === date`, so SQL filters
 * use `occurred_at >= start AND occurred_at < end`.
 */
export function businessDayRange(
  date: BusinessDate,
  clock: BusinessDayClock,
): { start: Date; end: Date } {
  const cutoff = cutoffMinutes(clock.cutoff);
  return {
    start: zonedInstant(date, cutoff, clock.timeZone),
    end: zonedInstant(addBusinessDays(date, 1), cutoff, clock.timeZone),
  };
}
