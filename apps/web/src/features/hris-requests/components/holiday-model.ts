// Pure logic of the employee holiday calendar (bead legend-ydf2): groups a
// year's holidays by month and formats day/weekday labels. No React, no device
// time zone (business dates are calendar dates).
import type { Holiday } from "@starter/shared/hris";

export type HolidayRow = {
  id: string;
  date: string;
  /** Day of month, "17". */
  day: string;
  /** Weekday name, "Senin". */
  weekday: string;
  name: string;
  type: Holiday["type"];
  /** True when the holiday applies to one outlet only. */
  singleOutlet: boolean;
};

export type HolidayMonth = {
  /** "2026-11". */
  key: string;
  /** "November". */
  label: string;
  rows: HolidayRow[];
};

const MONTH_NAME = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  timeZone: "UTC",
});
const WEEKDAY_NAME = new Intl.DateTimeFormat("id-ID", {
  weekday: "long",
  timeZone: "UTC",
});

function parse(date: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  )
    return null;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/** First and last business date of a calendar year, for `useHolidays`. */
export function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Holidays of one year, oldest month first, rows by date then name. Rows
 * outside `year` are dropped so a wide server answer cannot leak into the view.
 */
export function groupHolidaysByMonth(
  holidays: readonly Holiday[],
  year: number,
): HolidayMonth[] {
  const months = new Map<string, HolidayMonth>();
  const sorted = [...holidays].sort(
    (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
  );
  for (const holiday of sorted) {
    const parsed = parse(holiday.date);
    if (!parsed || parsed.getUTCFullYear() !== year) continue;
    const key = holiday.date.slice(0, 7);
    let month = months.get(key);
    if (!month) {
      month = { key, label: MONTH_NAME.format(parsed), rows: [] };
      months.set(key, month);
    }
    month.rows.push({
      id: holiday.id,
      date: holiday.date,
      day: String(parsed.getUTCDate()),
      weekday: WEEKDAY_NAME.format(parsed),
      name: holiday.name,
      type: holiday.type,
      singleOutlet: holiday.outletId !== null,
    });
  }
  return [...months.values()];
}

export function countHolidayRows(months: readonly HolidayMonth[]): number {
  return months.reduce((sum, month) => sum + month.rows.length, 0);
}
