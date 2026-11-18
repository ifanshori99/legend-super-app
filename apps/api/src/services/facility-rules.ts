// Pure rules of the facility services (no database): FAC-06 unit state rules
// and the outlet time zone arithmetic of the slot grid (bead legend-nm4f).
import type { FacilityUnitStatus } from "@starter/shared/facility";

// ---- Unit rules (FAC-06) -------------------------------------------------------

/** Statuses that block a hold regardless of the slot asked for (FAC-06). */
const BLOCKING_UNIT_STATUSES: readonly FacilityUnitStatus[] = [
  "needs_cleaning",
  "cleaning",
  "maintenance",
];

/** DTO `bookable`: false when the unit needs cleaning or is under maintenance. */
export function unitIsBookable(
  status: FacilityUnitStatus,
  retiredAt: Date | null = null,
): boolean {
  // A retired unit (legend-etawy) is never offered, whatever its state.
  if (retiredAt !== null) return false;
  return !BLOCKING_UNIT_STATUSES.includes(status);
}

/** A unit in use today can still take a LATER slot, never "right now". */
export function unitAcceptsSlot(
  status: FacilityUnitStatus,
  slotStartsAt: Date,
  now: Date,
  retiredAt: Date | null = null,
): boolean {
  if (!unitIsBookable(status, retiredAt)) return false;
  return status !== "in_use" || slotStartsAt.getTime() > now.getTime();
}

// ---- Time zone arithmetic ----------------------------------------------------

function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The instant at which the outlet wall clock reads `date` + `minutesOfDay`. */
export function zonedInstant(
  date: string,
  minutesOfDay: number,
  timeZone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, 0, 0) + minutesOfDay * 60_000;
  let guess = wall;
  for (let i = 0; i < 3; i += 1) guess = wall - offsetMs(guess, timeZone);
  return new Date(guess);
}
