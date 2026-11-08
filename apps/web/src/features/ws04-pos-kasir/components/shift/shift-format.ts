// Outlet-local date and time text for the shift screens. A fixed locale and the
// outlet zone keep the server render and the hydrated client identical.
import { DEFAULT_LOCALE } from "@starter/shared/i18n";

/** "2026-11-08" -> "8 November 2026". */
export function formatShiftDate(businessDate: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${businessDate}T00:00:00.000Z`));
}

/** "11.15" in the outlet time zone. */
export function formatShiftTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

/** "8 November 2026 · 07.00" in the outlet time zone. */
export function formatShiftDateTime(iso: string, timeZone: string): string {
  const date = new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(new Date(iso));
  return `${date} · ${formatShiftTime(iso, timeZone)}`;
}

/** Whole hours and minutes between two instants; never negative. */
export function shiftDuration(
  openedAtIso: string,
  nowMs: number,
): { hours: number; minutes: number } {
  const totalMinutes = Math.max(
    0,
    Math.floor((nowMs - new Date(openedAtIso).getTime()) / 60_000),
  );
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
