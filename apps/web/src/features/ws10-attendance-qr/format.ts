// Date and number formatting for the outlet screens. The outlet time zone is
// explicit so a screen shown on an outlet display agrees with the API's
// business date (D-CORE-6), and the locale is the catalog's id-ID.
import { formatNumber } from "@starter/shared/i18n";

const outletTime = (timeZone: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** 02:30:00 in the outlet time zone. */
export function formatOutletTime(iso: string, timeZone: string): string {
  return outletTime(timeZone).format(new Date(iso));
}

/**
 * A business date (`YYYY-MM-DD`) as a date, formatted in UTC so the date-only
 * value never shifts to the previous day (id-ID long form).
 */
export function formatBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "UTC",
    dateStyle: "long",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function formatMetres(value: number): string {
  return formatNumber(value);
}
