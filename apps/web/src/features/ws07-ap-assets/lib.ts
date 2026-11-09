// Pure helpers of the AP/AR, fixed-asset and budget screens (bead legend-m4zn;
// PRD v1.7 §3.19 "Utang & Piutang", "Aset Tetap", "Anggaran").
//
// No React and no DOM at import time, and only bare package imports, so
// tests/ws07-ap-assets.test.mjs loads this file with Node type stripping.
// Accounting rules stay in @starter/shared/accounting: the bucket labels and
// indexes come from agingBucketLabels/agingBucketIndex, the straight-line
// schedule from straightLineSchedule, the variance from budgetVariance. This
// file only shapes what the screens render and aggregates amounts for display.

import {
  budgetVariance,
  disposalResultIdr,
  type AgingReport,
  type BudgetVsActualRow,
  type DepreciationRun,
  type FixedAsset,
} from "@starter/shared/accounting";
import { formatNumber } from "@starter/shared/i18n";

// ---- Aging (Utang & Piutang) ----------------------------------------------

export type AgingRow = AgingReport["rows"][number];

export type AgingBucketDescriptor =
  | { index: number; label: string; kind: "current" }
  | { index: number; label: string; kind: "range"; from: number; to: number }
  | { index: number; label: string; kind: "over"; days: number };

/**
 * The contract labels a bucket "current", "1-30", … and ">90". The screen needs
 * the numbers back to translate the label; order is the report order, so the
 * column index always matches agingBucketIndex.
 */
export function agingBucketDescriptors(
  labels: readonly string[],
): AgingBucketDescriptor[] {
  return labels.map((label, index) => {
    if (label === "current") return { index, label, kind: "current" };
    if (label.startsWith(">")) {
      const days = Number(label.slice(1));
      return { index, label, kind: "over", days };
    }
    const [from, to] = label.split("-").map(Number);
    return { index, label, kind: "range", from, to };
  });
}

export type AgingSummary = {
  totalIdr: number;
  currentIdr: number;
  overdueIdr: number;
  counterpartyCount: number;
  /** Counterparties with a non-zero amount in each bucket, same order. */
  bucketCounts: number[];
};

export function agingSummary(report: AgingReport): AgingSummary {
  const currentIdr = report.bucketTotals[0] ?? 0;
  const overdueIdr = report.bucketTotals
    .slice(1)
    .reduce((sum, value) => sum + value, 0);
  return {
    totalIdr: report.totalIdr,
    currentIdr,
    overdueIdr,
    counterpartyCount: report.rows.length,
    bucketCounts: agingBucketCounts(report.rows),
  };
}

export function agingBucketCounts(rows: readonly AgingRow[]): number[] {
  const width = rows[0]?.buckets.length ?? 0;
  const counts = Array.from({ length: width }, () => 0);
  for (const row of rows)
    row.buckets.forEach((value, index) => {
      if (value > 0) counts[index] = (counts[index] ?? 0) + 1;
    });
  return counts;
}

export function agingRowOverdueIdr(row: AgingRow): number {
  return row.buckets.slice(1).reduce((sum, value) => sum + value, 0);
}

export type AgingFilters = {
  /** Counterparty name search; blank matches everything. */
  query: string;
  overdueOnly: boolean;
};

/** Search and "overdue only" narrow what the table shows, not the report. */
export function filterAgingRows(
  rows: readonly AgingRow[],
  filters: AgingFilters,
): AgingRow[] {
  const needle = filters.query.trim().toLocaleLowerCase("id-ID");
  return rows.filter((row) => {
    if (
      needle !== "" &&
      !row.counterpartyName.toLocaleLowerCase("id-ID").includes(needle)
    )
      return false;
    if (filters.overdueOnly && agingRowOverdueIdr(row) === 0) return false;
    return true;
  });
}

/** Totals row of the visible rows, so a filter never lies about the total. */
export function agingRowsTotals(rows: readonly AgingRow[]): {
  buckets: number[];
  totalIdr: number;
} {
  const width = rows[0]?.buckets.length ?? 0;
  const buckets = Array.from({ length: width }, () => 0);
  for (const row of rows)
    row.buckets.forEach((value, index) => {
      buckets[index] = (buckets[index] ?? 0) + value;
    });
  return {
    buckets,
    totalIdr: buckets.reduce((sum, value) => sum + value, 0),
  };
}

// ---- Fixed assets ---------------------------------------------------------

export type AssetStatus = FixedAsset["status"];

/**
 * The contract identifies an asset by a UUID and carries no human code (PRD §6
 * `fixed_assets` lists name, dates, cost, life and method only). The register
 * still needs a stable short label, so it is derived from the id suffix for
 * display; it is never sent back to the API.
 */
export function assetCode(asset: Pick<FixedAsset, "id">): string {
  return `AST-${asset.id.replace(/-/g, "").slice(-6).toUpperCase()}`;
}

export function assetBookValueIdr(
  asset: Pick<FixedAsset, "bookValueIdr">,
): number {
  return asset.bookValueIdr;
}

export type AssetTotals = {
  acquisitionIdr: number;
  accumulatedIdr: number;
  bookValueIdr: number;
  activeCount: number;
  totalCount: number;
};

export function assetTotals(assets: readonly FixedAsset[]): AssetTotals {
  return assets.reduce<AssetTotals>(
    (totals, asset) => ({
      acquisitionIdr: totals.acquisitionIdr + asset.costIdr,
      accumulatedIdr: totals.accumulatedIdr + asset.accumulatedDepreciationIdr,
      bookValueIdr: totals.bookValueIdr + assetBookValueIdr(asset),
      activeCount: totals.activeCount + (asset.status === "active" ? 1 : 0),
      totalCount: totals.totalCount + 1,
    }),
    {
      acquisitionIdr: 0,
      accumulatedIdr: 0,
      bookValueIdr: 0,
      activeCount: 0,
      totalCount: 0,
    },
  );
}

export type AssetStatusFilter = "all" | AssetStatus;

export type AssetFilters = {
  query: string;
  status: AssetStatusFilter;
};

export function filterAssets(
  assets: readonly FixedAsset[],
  filters: AssetFilters,
): FixedAsset[] {
  const needle = filters.query.trim().toLocaleLowerCase("id-ID");
  return assets.filter((asset) => {
    if (filters.status !== "all" && asset.status !== filters.status)
      return false;
    if (needle === "") return true;
    return (
      asset.name.toLocaleLowerCase("id-ID").includes(needle) ||
      assetCode(asset).toLocaleLowerCase("id-ID").includes(needle)
    );
  });
}

/** Gain (+) or loss (−) before the disposal is booked; null when disposed. */
export function disposalPreviewIdr(
  asset: Pick<FixedAsset, "costIdr" | "accumulatedDepreciationIdr" | "status">,
  proceedsIdr: number,
): number | null {
  try {
    return disposalResultIdr(asset, proceedsIdr);
  } catch {
    return null;
  }
}

/** Gain (+) or loss (−) of an already disposed asset, for the detail sheet. */
export function disposedResultIdr(
  asset: Pick<FixedAsset, "disposalResultIdr">,
): number | null {
  return asset.disposalResultIdr;
}

/** A run with an amount posts exactly one journal (contract invariant). */
export function depreciationRunPosted(
  run: Pick<DepreciationRun, "journalEntryId">,
): boolean {
  return run.journalEntryId !== null;
}

// ---- Budgets --------------------------------------------------------------

export type VarianceState = "under" | "on" | "over";

export function varianceState(varianceIdr: number): VarianceState {
  if (varianceIdr > 0) return "over";
  if (varianceIdr < 0) return "under";
  return "on";
}

/**
 * Basis points → "−12,5%" / "+3,0%" (id-ID, one decimal). The contract rounds
 * the basis points half_up (BUDGET_VARIANCE_ROUNDING); this only formats the
 * already-rounded display figure and never changes a stored amount.
 */
export function formatVarianceBp(varianceBp: number | null): string | null {
  if (varianceBp === null) return null;
  const percent = Math.round((varianceBp / 100) * 10) / 10;
  const figure = formatNumber(Math.abs(percent), { fractionDigits: 1 });
  if (percent > 0) return `+${figure}%`;
  if (percent < 0) return `−${figure}%`;
  return `${figure}%`;
}

export type BudgetTotals = {
  budgetIdr: number;
  actualIdr: number;
  varianceIdr: number;
  varianceBp: number | null;
};

/** Footer totals; the percentage is rounded through the contract helper. */
export function budgetTotals(
  rows: readonly Pick<BudgetVsActualRow, "budgetIdr" | "actualIdr">[],
): BudgetTotals {
  const budgetIdr = rows.reduce((sum, row) => sum + row.budgetIdr, 0);
  const actualIdr = rows.reduce((sum, row) => sum + row.actualIdr, 0);
  const variance = budgetVariance(budgetIdr, actualIdr);
  return {
    budgetIdr,
    actualIdr,
    varianceIdr: variance.varianceIdr,
    varianceBp: variance.varianceBp,
  };
}

/**
 * Parses a rupiah field: "1.520.000" and "1520000" both become 1520000.
 * Returns null for anything that is not whole rupiah (empty is 0).
 */
export function parseAmountInput(value: string): number | null {
  const digits = value.replace(/[.\s]/g, "");
  if (digits === "") return 0;
  if (!/^\d+$/.test(digits)) return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) ? amount : null;
}
