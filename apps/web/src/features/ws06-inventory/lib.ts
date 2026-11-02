// Pure helpers of the inventory back office: display formatting, list
// filtering and the derived views (categories, location stock) that the
// contract does not model as entities. No React, no fetching.
import {
  formatDecimal4,
  idr,
  parseDecimal4,
  type Decimal4,
  type Idr,
} from "@starter/shared/core";
import {
  stockBalanceValueIdr,
  type InventoryItem,
  type InventoryItemAlternate,
  type InventoryItemType,
  type StockBalance,
  type StockLocation,
  type StockTransfer,
  type Uom,
} from "@starter/shared/inventory";
import { INVENTORY_TIME_ZONE } from "./outlet";

/** The back office lists whole catalogs; screens filter and page in memory. */
export const LIST_LIMIT = 100;

/**
 * Decimal4 text for display in the outlet's words: trailing zeros dropped and
 * id-ID separators ("2.0000" → "2", "1234.5000" → "1.234,5"). No float
 * round-trip, so a long quantity never loses digits.
 */
export function formatQuantity(quantity: string): string {
  const [rawWhole = "0", rawFraction = ""] = quantity.split(".");
  const negative = rawWhole.startsWith("-");
  const whole = negative ? rawWhole.slice(1) : rawWhole;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = rawFraction.replace(/0+$/, "");
  return `${negative ? "−" : ""}${grouped}${fraction ? `,${fraction}` : ""}`;
}

/** A Decimal4 value with its unit, e.g. "2 kg". */
export function formatWithUnit(quantity: string, uomCode: string): string {
  return `${formatQuantity(quantity)} ${uomCode}`;
}

/** Unit code for an id, or an em dash when the catalog row is gone. */
export function uomCode(uoms: readonly Uom[], uomId: string): string {
  return uoms.find((uom) => uom.id === uomId)?.code ?? "—";
}

export function itemName(
  items: readonly InventoryItem[],
  itemId: string,
): string {
  return items.find((item) => item.id === itemId)?.name ?? "—";
}

/**
 * Form text → canonical Decimal4. Accepts the comma decimal separator and
 * grouping ("1.234,5"); a lone dot is a decimal point ("2.5"). Returns null
 * for anything the contract would reject (more than 4 decimals, not a
 * number). Empty input is null, so an optional par value can be cleared.
 */
export function decimalFromInput(value: string): Decimal4 | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const prepared = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;
  if (!/^-?\d+(\.\d{1,4})?$/.test(prepared)) return null;
  try {
    return formatDecimal4(parseDecimal4(prepared));
  } catch {
    return null;
  }
}

/** Form text → a positive Decimal4 quantity, or null when it is not one. */
export function quantityFromInput(value: string): Decimal4 | null {
  const parsed = decimalFromInput(value);
  if (parsed === null) return null;
  return parseDecimal4(parsed) > 0n ? parsed : null;
}

export type ItemFilters = {
  search?: string;
  category?: string;
  type?: InventoryItemType;
};

export function filterItems(
  items: readonly InventoryItem[],
  filters: ItemFilters,
): InventoryItem[] {
  const search = filters.search?.trim().toLocaleLowerCase("id-ID") ?? "";
  return items
    .filter(
      (item) =>
        filters.category === undefined || item.category === filters.category,
    )
    .filter((item) => filters.type === undefined || item.type === filters.type)
    .filter(
      (item) =>
        search === "" ||
        item.name.toLocaleLowerCase("id-ID").includes(search) ||
        item.category.toLocaleLowerCase("id-ID").includes(search),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "id-ID"));
}

/** Categories are a dimension of the item, not their own entity (PRD §16). */
export type CategorySummary = {
  category: string;
  itemCount: number;
  perishableCount: number;
  baseUnits: string[];
};

export function categorySummaries(
  items: readonly InventoryItem[],
  uoms: readonly Uom[],
): CategorySummary[] {
  const rows = new Map<
    string,
    { itemCount: number; perishableCount: number; units: Set<string> }
  >();
  for (const item of items) {
    const row = rows.get(item.category) ?? {
      itemCount: 0,
      perishableCount: 0,
      units: new Set<string>(),
    };
    row.itemCount += 1;
    if (item.isPerishable) row.perishableCount += 1;
    row.units.add(uomCode(uoms, item.baseUomId));
    rows.set(item.category, row);
  }
  return [...rows.entries()]
    .map(([category, row]) => ({
      category,
      itemCount: row.itemCount,
      perishableCount: row.perishableCount,
      baseUnits: [...row.units].sort((a, b) => a.localeCompare(b, "id-ID")),
    }))
    .sort((a, b) => a.category.localeCompare(b.category, "id-ID"));
}

/** Stock on hand per location, derived from the balances (never stored). */
export type LocationStock = {
  location: StockLocation;
  itemCount: number;
  valueIdr: Idr;
};

export function locationStock(
  locations: readonly StockLocation[],
  balances: readonly StockBalance[],
): LocationStock[] {
  return locations.map((location) => {
    const rows = balances.filter(
      (balance) =>
        balance.locationId === location.id &&
        parseDecimal4(balance.quantity) > 0n,
    );
    return {
      location,
      itemCount: new Set(rows.map((row) => row.inventoryItemId)).size,
      valueIdr: rows.reduce<Idr>(
        (sum, row) => idr(sum + stockBalanceValueIdr(row, "half_up")),
        idr(0),
      ),
    };
  });
}

/** Alternates of one item, lowest priority first (PRD §16 "bahan alternatif"). */
export function alternatesFor(
  alternates: readonly InventoryItemAlternate[],
  inventoryItemId: string,
): InventoryItemAlternate[] {
  return alternates
    .filter((row) => row.inventoryItemId === inventoryItemId)
    .sort((a, b) => a.priority - b.priority);
}

/** Transfer time in the outlet's zone (D-CORE-6), stable across SSR/browser. */
export function formatTransferTime(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: INVENTORY_TIME_ZONE,
  }).format(new Date(iso));
}

/** One transfer's total quantity, for the compact list row. */
export function transferQuantity(
  transfer: StockTransfer,
  unitOf: (itemId: string) => string,
): string {
  if (transfer.lines.length === 1) {
    const line = transfer.lines[0];
    return formatWithUnit(line.quantity, unitOf(line.inventoryItemId));
  }
  return transfer.lines
    .map((line) => formatWithUnit(line.quantity, unitOf(line.inventoryItemId)))
    .join(" · ");
}

/** Page count for an in-memory list. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** One page of an in-memory list, clamped to the last page that exists. */
export function listPage<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = pageCount(rows.length, pageSize);
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    rows: rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    page: safePage,
    totalPages,
  };
}

/** Loading/empty/error screenshots: ?mock=<scenario> must skip SSR loaders. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
