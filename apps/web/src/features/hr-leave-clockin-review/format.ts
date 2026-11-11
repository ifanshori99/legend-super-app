// Clock formatting for the leave clock-in review screens. Hour and minute only
// (08.02), in the outlet time zone, so it agrees with the business date the
// API uses (D-CORE-6); the id-ID locale matches the catalog.
const clock = (timeZone: string) =>
  new Intl.DateTimeFormat("id-ID", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** 08.02 in the outlet time zone. */
export function formatClockMinutes(iso: string, timeZone: string): string {
  return clock(timeZone).format(new Date(iso));
}

const dateFormat = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", ...options });

/**
 * The two ends of a leave period (`YYYY-MM-DD`), shortened where they share a
 * month or year: "25" / "27 Oktober 2026", "30 Oktober" / "2 November 2026".
 * Joined by the catalog's "sampai", they read "25 sampai 27 Oktober 2026".
 */
export function compactDateRange(
  startDate: string,
  endDate: string,
): { start: string; end: string } {
  const utc = (date: string) => {
    const [year, month, day] = date.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  };
  const from = utc(startDate);
  const to = utc(endDate);
  const full = dateFormat({ dateStyle: "long" });
  if (from.getUTCFullYear() !== to.getUTCFullYear())
    return { start: full.format(from), end: full.format(to) };
  if (from.getUTCMonth() !== to.getUTCMonth())
    return {
      start: dateFormat({ day: "numeric", month: "long" }).format(from),
      end: full.format(to),
    };
  return {
    start: dateFormat({ day: "numeric" }).format(from),
    end: full.format(to),
  };
}
