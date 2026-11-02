// Opening-hours and date formatting for the public website (PRD v1.7 §3.24
// "Beranda": jam buka; "SEO Lokal": opening hours in JSON-LD).
//
// Pure and deterministic: no `new Date()` without an explicit input, and every
// calendar format runs in UTC, so the server render and the browser render
// produce the same string (the rule format.ts follows for money).
import type { PublicOpeningHours } from "@starter/shared/website";

/** Day labels indexed by `Date#getDay` (0 = Sunday), from the text catalog. */
export type DayLabels = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** "08:00" → "08.00", the Indonesian clock style the website shows. */
export function formatTimeOfDay(value: string): string {
  return value.replace(":", ".");
}

/** "08:00"–"23:00" → "08.00–23.00". */
export function formatHoursRange(hours: {
  opens: string;
  closes: string;
}): string {
  return `${formatTimeOfDay(hours.opens)}–${formatTimeOfDay(hours.closes)}`;
}

export type OpeningHoursGroup = {
  /** Days in display order (Monday first, Sunday last). */
  days: number[];
  opens: string;
  closes: string;
};

/** Monday-first reading order; the contract keeps 0 = Sunday. */
const displayOrder = (day: number) => (day + 6) % 7;

/**
 * Groups the contract's day lists by identical range, in Monday-first order, so
 * seven single-day rows collapse into one line. Duplicate days keep the first
 * range.
 */
export function groupOpeningHours(
  hours: readonly PublicOpeningHours[],
): OpeningHoursGroup[] {
  const groups = new Map<string, OpeningHoursGroup>();
  const seen = new Set<number>();
  for (const entry of hours)
    for (const day of entry.daysOfWeek) {
      if (seen.has(day)) continue;
      seen.add(day);
      const key = `${entry.opens}-${entry.closes}`;
      const group = groups.get(key) ?? {
        days: [],
        opens: entry.opens,
        closes: entry.closes,
      };
      group.days.push(day);
      groups.set(key, group);
    }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      days: group.days.sort((a, b) => displayOrder(a) - displayOrder(b)),
    }))
    .sort((left, right) => displayOrder(left.days[0]) - displayOrder(right.days[0]));
}

/** True when the days form one unbroken run in Monday-first order. */
function isRun(days: readonly number[]): boolean {
  return days.every(
    (day, index) =>
      index === 0 || displayOrder(day) === displayOrder(days[index - 1]) + 1,
  );
}

/**
 * One readable line per distinct range: "Setiap hari, 08.00–23.00",
 * "Senin–Jumat, 08.00–22.00", "Sabtu, Minggu, 09.00–23.00".
 */
export function openingHoursLines(
  hours: readonly PublicOpeningHours[],
  labels: { days: DayLabels; everyDay: string },
): string[] {
  return groupOpeningHours(hours).map((group) => {
    const range = formatHoursRange(group);
    if (group.days.length === 7) return `${labels.everyDay}, ${range}`;
    const days = isRun(group.days)
      ? `${labels.days[group.days[0]]}–${labels.days[group.days[group.days.length - 1]]}`
      : group.days.map((day) => labels.days[day]).join(", ");
    return `${days}, ${range}`;
  });
}

const dayMonthYear = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-12-31" (business date) → "31 Desember 2026". Invalid input → "". */
export function formatBusinessDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? "" : dayMonthYear.format(date);
}

/** ISO timestamp → "1 November 2026" in UTC (SSR and client agree). */
export function formatIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dayMonthYear.format(date);
}

/**
 * The business date ("YYYY-MM-DD") of `now` in the outlet's time zone. The
 * website needs it to refuse a reservation request for a day that passed
 * (PRD: business dates follow the outlet time zone).
 */
export function businessDateInZone(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, the shape the form and the API use.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
