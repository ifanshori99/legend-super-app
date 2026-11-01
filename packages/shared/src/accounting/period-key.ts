// Fiscal period keys: one calendar month per period, "YYYY-MM" (PRD v1.7
// §3.19 "Tutup bulan"; §6 F `fiscal_periods.period`). Business dates are
// already in the outlet/entity time zone (D-CORE-6), so a period is a plain
// string prefix of the date and compares lexicographically.

import { z } from "zod";
import { businessDateSchema } from "../core/index.ts";
import type { BusinessDate } from "../core/index.ts";

export const periodKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period is YYYY-MM");
export type PeriodKey = z.infer<typeof periodKeySchema>;

/** "2026-11-15" → "2026-11". */
export function periodOf(date: string): PeriodKey {
  businessDateSchema.parse(date);
  return date.slice(0, 7);
}

export function nextPeriod(period: string): PeriodKey {
  const [year, month] = periodKeySchema.parse(period).split("-").map(Number);
  return month === 12
    ? `${String(year + 1).padStart(4, "0")}-01`
    : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): PeriodKey {
  const [year, month] = periodKeySchema.parse(period).split("-").map(Number);
  return month === 1
    ? `${String(year - 1).padStart(4, "0")}-12`
    : `${String(year).padStart(4, "0")}-${String(month - 1).padStart(2, "0")}`;
}

/** First and last business date of the period. */
export function periodBounds(period: string): {
  start: BusinessDate;
  end: BusinessDate;
} {
  const [year, month] = periodKeySchema.parse(period).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${period}-01` as BusinessDate,
    end: `${period}-${String(lastDay).padStart(2, "0")}` as BusinessDate,
  };
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const toUtc = (date: string) => {
    const [y, m, d] = businessDateSchema.parse(date).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(to) - toUtc(from)) / 86_400_000);
}

/** Adds whole days to a business date. */
export function addDays(date: string, days: number): BusinessDate {
  const [y, m, d] = businessDateSchema.parse(date).split("-").map(Number);
  const result = new Date(Date.UTC(y, m - 1, d + days));
  return result.toISOString().slice(0, 10) as BusinessDate;
}
