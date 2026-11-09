// Slot model for facility units (PRD v1.7 §3 F22 "Pemesanan", §6 K
// `access_tickets.slot`, FAC-02/FAC-06). One slot is three instants:
//
//   startsAt ────── session ────── endsAt ── cleaning buffer ── cleaningEndsAt
//
// The unit is occupied from `startsAt` to `cleaningEndsAt`. The Postgres
// exclusion constraint (btree_gist, bead legend-nm4f) is on the half-open
// `tstzrange` per (tenant, unit), so overlapping bookings are not expressible
// at the database either: two rows for one unit whose ranges intersect are
// rejected by the constraint. Half-open bounds are the only case that lets two
// back-to-back sessions exist: a slot that ends exactly when the next starts
// does not overlap (FAC-02). `slotRangeLiteral` is the single place that turns
// a slot into that range, so the API, the edge and the migration cannot
// disagree about the bound convention.
//
// Instants are ISO 8601 with offset (D-CORE-6); comparisons always use
// Date.parse, never string order, because offsets may differ.

import {
  z,
  isoDateTimeSchema,
  timeOfDaySchema,
  toIsoDateTime,
} from "../core/index.ts";
import { FacilityError } from "./errors.ts";

export const facilitySlotSchema = z
  .strictObject({
    /** Session start: the earliest instant the customer may open the unit. */
    startsAt: isoDateTimeSchema,
    /** Session end: the last instant of the booked session. */
    endsAt: isoDateTimeSchema,
    /** End of the cleaning buffer, i.e. when the unit is free again. */
    cleaningEndsAt: isoDateTimeSchema,
  })
  .superRefine((slot, ctx) => {
    const start = Date.parse(slot.startsAt);
    const end = Date.parse(slot.endsAt);
    const clean = Date.parse(slot.cleaningEndsAt);
    if (!(end > start))
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be after startsAt",
      });
    if (!(clean >= end))
      ctx.addIssue({
        code: "custom",
        path: ["cleaningEndsAt"],
        message: "cleaningEndsAt must not be before endsAt",
      });
  });
export type FacilitySlot = z.infer<typeof facilitySlotSchema>;

/** The only bound convention the contract, the API and the migration use. */
export const SLOT_RANGE_BOUNDS = "[)" as const;

/** Occupied range, half-open. Mirrors `tstzrange(lower, upper, '[)')`. */
export type SlotRange = {
  readonly lower: string;
  readonly upper: string;
  readonly bounds: typeof SLOT_RANGE_BOUNDS;
};

/** Minutes of a slot: the configured session plus its cleaning buffer. */
export const slotConfigSchema = z
  .strictObject({
    sessionMinutes: z.number().int().min(1).max(480),
    cleaningMinutes: z.number().int().min(0).max(240),
  })
  .refine((config) => config.sessionMinutes + config.cleaningMinutes <= 720, {
    message: "A slot may not exceed 12 hours including cleaning",
    path: ["cleaningMinutes"],
  });
export type SlotConfig = z.infer<typeof slotConfigSchema>;

/** The single place a slot becomes a database range (half-open, F22/FAC-02). */
export function slotOccupiedRange(slot: FacilitySlot): SlotRange {
  const parsed = facilitySlotSchema.parse(slot);
  return {
    lower: parsed.startsAt,
    upper: parsed.cleaningEndsAt,
    bounds: SLOT_RANGE_BOUNDS,
  };
}

/**
 * Postgres `tstzrange` text for a slot, quoted and half-open, e.g.
 * `["2026-11-01T23:00:00.000Z","2026-11-01T23:30:00.000Z")`. Use this literal
 * (or the two bounds) in the exclusion constraint and in `&&` lookups; never
 * rebuild the range by hand.
 */
export function slotRangeLiteral(slot: FacilitySlot): string {
  const range = slotOccupiedRange(slot);
  return `${range.bounds[0]}"${range.lower}","${range.upper}"${range.bounds[1]}`;
}

/** Half-open overlap: touching ranges (one ends when the other starts) do not overlap. */
export function slotsOverlap(a: FacilitySlot, b: FacilitySlot): boolean {
  const first = slotOccupiedRange(a);
  const second = slotOccupiedRange(b);
  return (
    Date.parse(first.lower) < Date.parse(second.upper) &&
    Date.parse(second.lower) < Date.parse(first.upper)
  );
}

/**
 * FAC-02: two tickets cannot occupy the same unit at overlapping times,
 * including the cleaning buffer. Throws SLOT_UNAVAILABLE; the database
 * exclusion constraint is the concurrency-safe backstop.
 */
export function assertNoSlotOverlap(
  candidate: FacilitySlot,
  taken: readonly FacilitySlot[],
): void {
  for (const slot of taken)
    if (slotsOverlap(candidate, slot))
      throw new FacilityError(
        "SLOT_UNAVAILABLE",
        "Slot ini sudah terisi. Silakan pilih slot lain.",
      );
}

/** Builds the slot that starts at `startsAt` for a facility configuration. */
export function slotFromStart(
  startsAt: Date | string,
  config: SlotConfig,
): FacilitySlot {
  const { sessionMinutes, cleaningMinutes } = slotConfigSchema.parse(config);
  const start =
    typeof startsAt === "string"
      ? new Date(isoDateTimeSchema.parse(startsAt))
      : startsAt;
  if (Number.isNaN(start.getTime())) throw new RangeError("Invalid slot start");
  const end = new Date(start.getTime() + sessionMinutes * 60_000);
  const clean = new Date(end.getTime() + cleaningMinutes * 60_000);
  return facilitySlotSchema.parse({
    startsAt: toIsoDateTime(start),
    endsAt: toIsoDateTime(end),
    cleaningEndsAt: toIsoDateTime(clean),
  });
}

/** Whole minutes between two instants, rounded up (0 for an instant or earlier). */
export function minutesBetween(from: Date | string, to: Date | string): number {
  const start = typeof from === "string" ? Date.parse(from) : from.getTime();
  const end = typeof to === "string" ? Date.parse(to) : to.getTime();
  if (Number.isNaN(start) || Number.isNaN(end))
    throw new RangeError("Invalid instant");
  return end <= start ? 0 : Math.ceil((end - start) / 60_000);
}

/** Local wall clock at an instant: weekday (0 = Sunday) and minutes since midnight. */
export const wallClockSchema = z.strictObject({
  dayOfWeek: z.number().int().min(0).max(6),
  minutesOfDay: z.number().int().min(0).max(1439),
});
export type WallClock = z.infer<typeof wallClockSchema>;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Wall clock of an instant in an outlet time zone. Intl handles the offset
 * (including DST zones), so no offset table or day arithmetic is needed here.
 */
export function wallClockAt(
  instant: Date | string,
  timeZone: string,
): WallClock {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid instant");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const dayOfWeek = WEEKDAYS.indexOf(
    part("weekday") as (typeof WEEKDAYS)[number],
  );
  const hours = Number(part("hour"));
  const minutes = Number(part("minute"));
  if (dayOfWeek < 0 || !Number.isInteger(hours) || !Number.isInteger(minutes))
    throw new RangeError(`Unknown time zone: ${timeZone}`);
  return wallClockSchema.parse({
    dayOfWeek,
    minutesOfDay: hours * 60 + minutes,
  });
}

/** `HH:mm` as minutes since midnight. */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = timeOfDaySchema.parse(time).split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Window end: `24:00` (end of day, exclusive) is accepted here only, so a
 * window can cover 23:59. Every other time-of-day field stays 00:00–23:59.
 */
export const END_OF_DAY = "24:00";

export const windowEndSchema = z.union([
  timeOfDaySchema,
  z.literal(END_OF_DAY),
]);

/** Window end as minutes since midnight; `24:00` is 1440. */
export function windowEndMinutes(time: string): number {
  return time === END_OF_DAY ? 1440 : minutesOfDay(time);
}

/** Opening hours per weekday (PRD §6 K `facilities.operating_hours`). */
export const facilityDayHoursSchema = z
  .strictObject({
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    opensAt: timeOfDaySchema,
    closesAt: timeOfDaySchema,
  })
  .refine((day) => minutesOfDay(day.closesAt) > minutesOfDay(day.opensAt), {
    path: ["closesAt"],
    message: "closesAt must be after opensAt (no overnight facility hours)",
  });
export const facilityHoursSchema = z
  .array(facilityDayHoursSchema)
  .min(1)
  .max(7);
export type FacilityDayHours = z.infer<typeof facilityDayHoursSchema>;

/** True when the instant falls inside the facility's operating hours for that weekday. */
export function isWithinOperatingHours(
  hours: readonly FacilityDayHours[],
  instant: Date | string,
  timeZone: string,
): boolean {
  const clock = wallClockAt(instant, timeZone);
  return hours.some(
    (day) =>
      day.daysOfWeek.includes(clock.dayOfWeek) &&
      clock.minutesOfDay >= minutesOfDay(day.opensAt) &&
      clock.minutesOfDay < minutesOfDay(day.closesAt),
  );
}

/**
 * The whole session (not the cleaning buffer) must fit inside operating hours:
 * a session that runs past closing could not be used. FAC-06 decides whether
 * the unit itself may be booked.
 */
export function slotFitsOperatingHours(
  slot: FacilitySlot,
  hours: readonly FacilityDayHours[],
  timeZone: string,
): boolean {
  const parsed = facilitySlotSchema.parse(slot);
  return (
    isWithinOperatingHours(hours, parsed.startsAt, timeZone) &&
    isWithinOperatingHours(
      hours,
      new Date(Date.parse(parsed.endsAt) - 1).toISOString(),
      timeZone,
    )
  );
}

/**
 * Wait estimate for the "masuk sekarang" flow (PRD §3 F22 Pemesanan): each
 * waiting guest ahead of the caller needs at most one session with the units
 * that are free right now. The BE service passes the live queue length; this
 * is the arithmetic the FE shows, so both agree.
 */
export function estimateWaitMinutes(
  waitingAhead: number,
  sessionMinutes: number,
  freeUnits = 1,
): number {
  if (!Number.isInteger(waitingAhead) || waitingAhead < 0)
    throw new RangeError(`Invalid queue length: ${waitingAhead}`);
  if (!Number.isInteger(sessionMinutes) || sessionMinutes <= 0)
    throw new RangeError(`Invalid session length: ${sessionMinutes}`);
  if (!Number.isInteger(freeUnits) || freeUnits <= 0)
    throw new RangeError(`Invalid free unit count: ${freeUnits}`);
  return Math.ceil(waitingAhead / freeUnits) * sessionMinutes;
}
