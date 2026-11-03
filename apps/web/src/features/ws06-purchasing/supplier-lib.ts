// Pure helpers for the supplier screens (bead legend-xjb; PRD v1.7 §3 F18
// "Supplier"). No React and no `@/` alias: the contract tests can load this
// file with plain Node ESM. Business invariants stay in the contract
// (`supplierPriceOnDate`, `supplierPriceHistory`, `supplierPriceChangeBp`);
// this file only derives what the screens display.
import {
  divideRounded,
  formatDecimal4,
  idr,
  parseDecimal4,
} from "@starter/shared/core";
import type { BusinessDate, Decimal4, Idr } from "@starter/shared/core";
import { supplierPriceChangeBp } from "@starter/shared/inventory";
import type {
  Supplier,
  SupplierCatalogItem,
  SupplierPerformance,
} from "@starter/shared/inventory";
import {
  businessDateToday,
  formatBusinessDate,
  formatDateTime,
  formatQuantity,
  isMockScenarioRequest,
  listPage,
  matchesQuery,
} from "../ws06-inventory/stock-lib.ts";

export {
  businessDateToday,
  formatBusinessDate,
  formatDateTime,
  formatQuantity,
  isMockScenarioRequest,
  listPage,
  matchesQuery,
};

/** One page of a cursor list; the contract caps `limit` at 100. */
export const SUPPLIER_LIST_LIMIT = 100;
/** Rows per page inside a loaded supplier list (DataTableShell pagination). */
export const SUPPLIER_PAGE_SIZE = 10;

const DECIMAL4_SCALE = 10_000n;

/**
 * `supplier_prices.price_idr` is NUMERIC(14,4): per-unit rupiah. <Money>
 * renders whole rupiah, so round the scaled value the same way the API does.
 */
export function decimal4Idr(value: Decimal4 | string): Idr {
  return idr(
    Number(divideRounded(parseDecimal4(value), DECIMAL4_SCALE, "half_up")),
  );
}

/** "185000" / "185000.5" → canonical decimal4, or null when it is not one. */
export function parsePriceInput(value: string): Decimal4 | null {
  try {
    return formatDecimal4(parseDecimal4(value.trim()));
  } catch {
    return null;
  }
}

/** 10000 bp → "100", 1667 bp → "16,67", null → null. */
export function formatBpPercent(bp: number | null): string | null {
  if (bp === null) return null;
  return new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(bp / 100);
}

/** The running month in the outlet time zone, for the performance report. */
export function currentMonthRange(today: BusinessDate = businessDateToday()): {
  fromDate: BusinessDate;
  toDate: BusinessDate;
} {
  const [year, month] = today.split("-").map(Number);
  const monthText = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    fromDate: `${year}-${monthText}-01` as BusinessDate,
    toDate:
      `${year}-${monthText}-${String(lastDay).padStart(2, "0")}` as BusinessDate,
  };
}

/** Unique inventory items in the catalog rows (the list column count). */
export function catalogItemIds(
  catalog: readonly SupplierCatalogItem[],
): string[] {
  return [...new Set(catalog.map((row) => row.inventoryItemId))];
}

/**
 * The catalog table shows one row per inventory item: the price in force.
 * Older rows are history (PRD §6.E `supplier_prices`, superseded from their
 * `effectiveFrom`), so they belong to the price-history table only.
 */
export function latestCatalogRows(
  catalog: readonly SupplierCatalogItem[],
): SupplierCatalogItem[] {
  const latest = new Map<string, SupplierCatalogItem>();
  for (const row of catalog) {
    const current = latest.get(row.inventoryItemId);
    if (
      !current ||
      current.effectiveFrom < row.effectiveFrom ||
      (current.effectiveFrom === row.effectiveFrom &&
        current.createdAt < row.createdAt)
    )
      latest.set(row.inventoryItemId, row);
  }
  return [...latest.values()];
}

export type PriceHistoryRow = {
  key: string;
  row: SupplierCatalogItem;
  /** The row this price superseded, null for the first recorded price. */
  previous: SupplierCatalogItem | null;
  /** Signed change in basis points; null when there is no baseline. */
  deltaBp: number | null;
};

/**
 * Joins one price history per inventory item into the table rows. Each input
 * list is newest first (contract `supplierPriceHistory`); rows are re-sorted
 * by effective date across items.
 */
export function priceHistoryRows(
  histories: readonly (readonly SupplierCatalogItem[])[],
): PriceHistoryRow[] {
  return histories
    .flatMap((history) =>
      history.map((row, index) => {
        const previous = history[index + 1] ?? null;
        return {
          key: row.id,
          row,
          previous,
          deltaBp: previous
            ? supplierPriceChangeBp(previous.priceIdr, row.priceIdr, "half_up")
            : null,
        };
      }),
    )
    .sort((left, right) => {
      if (left.row.effectiveFrom !== right.row.effectiveFrom)
        return left.row.effectiveFrom < right.row.effectiveFrom ? 1 : -1;
      return left.row.createdAt < right.row.createdAt ? 1 : -1;
    });
}

const RATING_KEYS = {
  1: "inventorySuppliers.rating.1",
  2: "inventorySuppliers.rating.2",
  3: "inventorySuppliers.rating.3",
  4: "inventorySuppliers.rating.4",
  5: "inventorySuppliers.rating.5",
} as const;

export type RatingKey =
  | (typeof RATING_KEYS)[keyof typeof RATING_KEYS]
  | "inventorySuppliers.rating.none";

/** Catalog label for a 1-5 manual rating; null means "not rated yet". */
export function ratingLabelKey(rating: number | null): RatingKey {
  if (rating === null) return "inventorySuppliers.rating.none";
  const safe = Math.min(5, Math.max(1, rating));
  return RATING_KEYS[safe as keyof typeof RATING_KEYS];
}

/** Status tone for the rating pill: text carries the meaning, colour supports. */
export function ratingTone(
  rating: number | null,
): "success" | "warning" | "danger" {
  if (rating === null) return "warning";
  if (rating >= 4) return "success";
  if (rating === 3) return "warning";
  return "danger";
}

/** Case-insensitive search over the supplier's own fields. */
export function matchesSupplier(supplier: Supplier, query: string): boolean {
  return [
    supplier.name,
    supplier.legalName ?? "",
    supplier.contactName ?? "",
    supplier.phone ?? "",
    supplier.email ?? "",
  ].some((value) => matchesQuery(value, query));
}

/** True when the performance report has no deliveries to derive metrics from. */
export function performanceIsEmpty(performance: SupplierPerformance): boolean {
  return performance.deliveriesTotal === 0;
}
