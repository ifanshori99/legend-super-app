// Formatters for the security screens. Dates use one fixed locale and the
// outlet time zone (PRD: business dates in the outlet's time zone), so the
// server render and the browser render agree during hydration.
export const OUTLET_TIME_ZONE = "Asia/Jakarta";

const dateTimeFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: OUTLET_TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: OUTLET_TIME_ZONE,
});

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: OUTLET_TIME_ZONE,
});

/** "2026-11-01T04:50:00.000Z" → "1 Nov 2026, 11.50". */
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}

/** "2026-11-01T04:50:00.000Z" → "11.50". */
export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** "2026-11-01T04:50:00.000Z" → "1 Nov 2026". */
export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}
