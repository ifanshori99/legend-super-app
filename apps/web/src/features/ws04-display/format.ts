// Outlet-local formatting for the customer display. A fixed locale and time
// zone keep the server render and the hydrated client identical.
import { DEFAULT_LOCALE } from "@starter/shared/i18n";
import { POS_TIME_ZONE } from "./outlet.ts";

/** 10:52 — the outlet clock time of an instant. */
export function formatOutletTime(iso: string): string {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: POS_TIME_ZONE,
  }).format(new Date(iso));
}
