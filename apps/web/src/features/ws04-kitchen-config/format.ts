// Outlet-local formatting for the kitchen back-office screens. A fixed locale
// and time zone keep the server render and the hydrated client identical.
import { DEFAULT_LOCALE } from "@starter/shared/i18n";
import { KITCHEN_TIME_ZONE } from "./outlet.ts";

/** 10:52 — a clock time on a report row. */
export function formatOutletTime(iso: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: KITCHEN_TIME_ZONE,
  }).format(new Date(iso));
}

/** 1 Nov 2026, 11.52 — a log row keeps the date, not only the clock. */
export function formatOutletDateTime(iso: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: KITCHEN_TIME_ZONE,
  }).format(new Date(iso));
}

/** ISO business date (2026-11-01) → "1 Nov 2026". */
export function formatBusinessDate(date: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}
