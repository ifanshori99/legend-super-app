// Outlet-local formatting for the kitchen screens. A fixed locale and time zone
// keep the server render and the hydrated client identical (no time mismatch).
import { DEFAULT_LOCALE } from "@starter/shared/i18n";
import { KITCHEN_TIME_ZONE } from "./outlet.ts";

/** 10:52 — a clock time on today's board. */
export function formatOutletTime(
  iso: string,
  timeZone: string = KITCHEN_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

/** 7 November 2026, 23.59 — a promotion's end. */
export function formatOutletDate(iso: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: KITCHEN_TIME_ZONE,
  }).format(new Date(iso));
}
