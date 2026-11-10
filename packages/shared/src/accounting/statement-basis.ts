// Statement data basis (PRD v1.7 §3.19 Tutup Periode: "Angka resmi hanya
// diambil dari periode yang sudah ditutup; angka berjalan diberi label
// estimasi"). Every statement response says which basis its figures use and
// which months they cover, so the screen never has to guess.
//
// `closed_snapshot`: every month the figures depend on is a closed fiscal
// period, so the numbers are frozen at close. `live`: at least one month is
// still open (or has no fiscal period yet), so the numbers can still change.
//
// `statementBasisFor` is the single rule. The web feature and the (future)
// statement handlers in apps/api both call it; nothing here reads a database.

import { z } from "zod";
import { periodKeySchema } from "./period-key.ts";
import type { PeriodKey } from "./period-key.ts";

export const statementDataBasisSchema = z.enum(["closed_snapshot", "live"]);
export type StatementDataBasis = z.infer<typeof statementDataBasisSchema>;

/** Response fields every statement carries (spread into each strictObject). */
export const statementBasisShape = {
  basis: statementDataBasisSchema,
  /** Calendar months the figures cover, oldest first ("as of" = that one month). */
  periodKeys: z.array(periodKeySchema),
  /** The subset of `periodKeys` that is a closed fiscal period, oldest first. */
  closedPeriodKeys: z.array(periodKeySchema),
};

/**
 * Month keys ("2026-10") a date range touches, inclusive. Capped so a typo'd
 * year cannot loop for ever; null means invalid or capped (treated as live).
 */
const MAX_BASIS_MONTHS = 240;

export function monthsInRange(from: string, to: string): PeriodKey[] | null {
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  if (![year, month, endYear, endMonth].every(Number.isInteger)) return null;
  const months: PeriodKey[] = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    if (months.length >= MAX_BASIS_MONTHS) return null;
    months.push(
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`,
    );
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export type StatementBasisRange = {
  from: string;
  to: string;
  /**
   * Cumulative statements (trial balance, balance sheet, cash flow opening
   * cash, equity opening balances) also depend on every earlier month.
   */
  cumulative?: boolean;
};

export type StatementBasisResult = {
  basis: StatementDataBasis;
  periodKeys: PeriodKey[];
  closedPeriodKeys: PeriodKey[];
  /** Months in range still open or without a period row, plus earlier open ones when cumulative. */
  openPeriodKeys: PeriodKey[];
};

/**
 * `closed_snapshot` only when every month the figures depend on is closed. A
 * range with no valid month (bad or capped dates) is `live` with no keys.
 * The status comes from the fiscal-period rows; nothing is guessed.
 */
export function statementBasisFor(
  periods: readonly { period: string; status: string }[],
  range: StatementBasisRange,
): StatementBasisResult {
  const status = new Map(periods.map((row) => [row.period, row.status]));
  const months = monthsInRange(range.from, range.to);
  if (months === null || months.length === 0)
    return {
      basis: "live",
      periodKeys: [],
      closedPeriodKeys: [],
      openPeriodKeys: [],
    };
  const closed = months.filter((month) => status.get(month) === "closed");
  const open = months.filter((month) => status.get(month) !== "closed");
  if (range.cumulative) {
    const first = months[0]!;
    for (const row of periods)
      if (row.period < first && row.status !== "closed")
        open.push(row.period as PeriodKey);
    open.sort();
  }
  return {
    basis: open.length === 0 ? "closed_snapshot" : "live",
    periodKeys: months,
    closedPeriodKeys: closed,
    openPeriodKeys: open,
  };
}

/** The three response fields, ready to spread into a statement payload. */
export function statementBasisFields(
  periods: readonly { period: string; status: string }[],
  range: StatementBasisRange,
): Pick<StatementBasisResult, "basis" | "periodKeys" | "closedPeriodKeys"> {
  const { basis, periodKeys, closedPeriodKeys } = statementBasisFor(
    periods,
    range,
  );
  return { basis, periodKeys, closedPeriodKeys };
}

/**
 * Invariants of the basis fields against the statement's own date bounds
 * (use inside a statement's superRefine). `periodKeys` must be exactly the
 * months of [from, to] (as-of statements pass the same date twice).
 */
export function refineStatementBasis(
  report: {
    basis: StatementDataBasis;
    periodKeys: readonly string[];
    closedPeriodKeys: readonly string[];
  },
  range: { from: string; to: string },
  ctx: z.RefinementCtx,
): void {
  const expected = monthsInRange(range.from, range.to) ?? [];
  if (
    report.periodKeys.length !== expected.length ||
    report.periodKeys.some((key, index) => key !== expected[index])
  )
    ctx.addIssue({
      code: "custom",
      path: ["periodKeys"],
      message: "periodKeys must be the months of the statement range",
    });
  if (
    report.closedPeriodKeys.some((key) => !report.periodKeys.includes(key)) ||
    report.closedPeriodKeys.some(
      (key, index) => index > 0 && key <= report.closedPeriodKeys[index - 1]!,
    )
  )
    ctx.addIssue({
      code: "custom",
      path: ["closedPeriodKeys"],
      message: "closedPeriodKeys must be a sorted subset of periodKeys",
    });
  if (
    report.basis === "closed_snapshot" &&
    (report.periodKeys.length === 0 ||
      report.closedPeriodKeys.length !== report.periodKeys.length)
  )
    ctx.addIssue({
      code: "custom",
      path: ["basis"],
      message: "closed_snapshot needs every covered month closed",
    });
}
