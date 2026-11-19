// Pure helpers for the HPP and food-cost reports (bead legend-5pe; PRD v1.7
// §17 "Resep, Produksi & HPP", F17 "HPP Menu, Food Cost, Menu Engineering,
// Kelengkapan Resep"). No React and no `@/` alias.
//
// Every figure on the screens comes from the four report endpoints. This file
// only formats them: Decimal4 costs to whole rupiah, integer basis points to
// percent, business dates for the period controls, and menu ids to the menu
// catalog's names.

import {
  divideRounded,
  parseDecimal4,
  type BusinessDate,
  type Decimal4,
} from "@starter/shared/core";
import { formatNumber } from "@starter/shared/i18n";
import type {
  FoodCostComparison,
  MenuCost,
  MenuEngineeringClass,
  MenuEngineeringRow,
  RecipeCoverageRow,
  RecipeCoverageStatus,
} from "@starter/shared/inventory";
import {
  addDays,
  businessDateToday,
  formatBusinessDate,
  shortId,
} from "./stock-lib.ts";

/** One page of a cursor list; the contract caps `limit` at 100. */
export const HPP_LIST_LIMIT = 100;

/** Default report window: the last 30 business days, ending today. */
export const DEFAULT_PERIOD_DAYS = 30;

export type HppPeriod = {
  fromDate: BusinessDate;
  toDate: BusinessDate;
};

/**
 * The period selector's initial value: 30 business dates ending today at the
 * outlet (D-CORE-6). A business date has no time zone drift of its own.
 */
export function defaultPeriod(now: Date = new Date()): HppPeriod {
  const toDate = businessDateToday(now);
  return {
    fromDate: addDays(toDate, -(DEFAULT_PERIOD_DAYS - 1)),
    toDate,
  };
}

/** "5 Okt 2026 – 3 Nov 2026", the period line under a figure. */
export function periodLabel(period: HppPeriod): string {
  return `${formatBusinessDate(period.fromDate)} – ${formatBusinessDate(
    period.toDate,
  )}`;
}

// ---- Numbers -------------------------------------------------------------

/**
 * A NUMERIC(14,4) cost string in whole rupiah. Costs are stored with four
 * decimals; the report renders whole rupiah with the documented half-up mode,
 * the same mode the fixtures used to build the row (PRD §17).
 */
export function costIdrOf(value: Decimal4): bigint {
  return divideRounded(parseDecimal4(value), 10_000n, "half_up");
}

/**
 * Integer basis points as a percent label: 6606 → "66,06%". Basis points are
 * exact integers, so two decimals carry every digit the endpoint sent. A
 * negative value keeps the typographic minus used by money.
 */
export function formatBasisPoints(value: number): string {
  return `${formatNumber(value / 100, { fractionDigits: 2 }).replace(
    "-",
    "−",
  )}%`;
}

// ---- Menu catalog joins --------------------------------------------------

const MENU_NAMES = new Map<string, string>();

/**
 * Feeds the menu id -> name lookup. Only the HPP mock (hpp-mock.ts) calls it,
 * so the sample menu names stay out of the production bundle.
 */
export function registerMenuNames(
  items: readonly { id: string; name: string }[],
): void {
  for (const item of items) MENU_NAMES.set(item.id, item.name);
}

/**
 * Menu name for a report row. Report rows carry `menuItemId` only, so the
 * name comes from the menu catalog; an unknown id shows its tail instead of a
 * fabricated title.
 */
export function menuNameOf(menuItemId: string): string {
  return MENU_NAMES.get(menuItemId) ?? shortId(menuItemId);
}

/** Menu rows sorted by their visible name, the order the tables use. */
export function sortMenuCosts(rows: readonly MenuCost[]): MenuCost[] {
  return [...rows].sort((a, b) =>
    menuNameOf(a.menuItemId).localeCompare(menuNameOf(b.menuItemId), "id-ID"),
  );
}

export function sortMenuEngineering(
  rows: readonly MenuEngineeringRow[],
): MenuEngineeringRow[] {
  return [...rows].sort((a, b) =>
    menuNameOf(a.menuItemId).localeCompare(menuNameOf(b.menuItemId), "id-ID"),
  );
}

export function sortRecipeCoverage(
  rows: readonly RecipeCoverageRow[],
): RecipeCoverageRow[] {
  return [...rows].sort((a, b) =>
    menuNameOf(a.menuItemId).localeCompare(menuNameOf(b.menuItemId), "id-ID"),
  );
}

// ---- Food cost -----------------------------------------------------------

/**
 * Food-cost comparisons newest first (by start, then end date). The summary
 * strip and the chart both read the first row, so they always agree.
 */
export function sortFoodCost(
  rows: readonly FoodCostComparison[],
): FoodCostComparison[] {
  return [...rows].sort(
    (a, b) =>
      b.fromDate.localeCompare(a.fromDate) || b.toDate.localeCompare(a.toDate),
  );
}

/**
 * The label for a comparison row's own period. A row covers the closed range
 * the server computed, which may differ from the selector window that merely
 * overlaps it, so figures are always labelled with the row's dates.
 */
export function foodCostPeriodLabel(row: FoodCostComparison): string {
  return periodLabel({ fromDate: row.fromDate, toDate: row.toDate });
}

// ---- Menu engineering ----------------------------------------------------

/**
 * Counts per classification. The matrix is the report's own classification;
 * the screen counts the rows it received, it never reclassifies them
 * (PRD §17 "Menu Engineering": classification comes from the server).
 */
export function engineeringCounts(
  rows: readonly MenuEngineeringRow[],
): Record<MenuEngineeringClass, number> {
  const counts: Record<MenuEngineeringClass, number> = {
    star: 0,
    plowhorse: 0,
    puzzle: 0,
    dog: 0,
  };
  for (const row of rows) counts[row.classification] += 1;
  return counts;
}

// ---- Recipe coverage -----------------------------------------------------

export const COVERAGE_STATUSES = [
  "complete",
  "incomplete",
  "no_recipe",
] as const satisfies readonly RecipeCoverageStatus[];

export function coverageCounts(
  rows: readonly RecipeCoverageRow[],
): Record<RecipeCoverageStatus, number> {
  const counts: Record<RecipeCoverageStatus, number> = {
    complete: 0,
    incomplete: 0,
    no_recipe: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** True when there is at least one row and every menu has a complete recipe. */
export function allRecipesComplete(
  rows: readonly RecipeCoverageRow[],
): boolean {
  return rows.length > 0 && rows.every((row) => row.status === "complete");
}
