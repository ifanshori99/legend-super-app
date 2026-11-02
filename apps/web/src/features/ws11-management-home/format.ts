// Deterministic date text for the management home: business dates are
// calendar dates (no time zone conversion) and clock times render in the
// outlet time zone, so the SSR HTML and the hydrated page always match.
// The outlet time zone moves into the outlet context when that bead lands
// (follow-up of legend-fbu); until then it is the same constant the facility
// and member screens use.

export const OUTLET_TIME_ZONE = "Asia/Jakarta";

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
] as const;

/** `2026-11-01` → `1 Nov 2026`. Unknown input is returned unchanged. */
export function formatBusinessDate(businessDate: string): string {
  const [year, month, day] = businessDate.split("-").map(Number);
  if (!year || !month || !day || month > 12) return businessDate;
  return `${day} ${MONTHS_SHORT[month - 1]} ${year}`;
}

/** `2026-11-01T22:45:00.000Z` → `05.45` in the outlet time zone. */
export function formatClock(instant: string, timeZone = OUTLET_TIME_ZONE) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
}
