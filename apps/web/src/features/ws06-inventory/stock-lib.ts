// Pure helpers for the stock-control screens (bead legend-vxj; PRD v1.7 §16
// "Inventori & Gudang", INV-01, AI-08). No React, no `@/` alias: the contract
// tests load this file with plain Node ESM.
//
// The invariants themselves live in the contract (@starter/shared/inventory):
// `parStatus`, `effectiveParLevel`, `batchExpiryStatus`, `fefoSort`, and
// `extendCostIdr` are imported, never reimplemented here. This file only
// joins fixture rows for the tables and derives what the screens display.

import {
  extendCostIdr,
  formatDecimal4,
  idr,
  parseDecimal4,
  sumIdr,
} from "@starter/shared/core";
import type { BusinessDate, Decimal4, Idr } from "@starter/shared/core";
import {
  STOCK_MOVEMENT_DIRECTION,
  batchExpiryStatus,
  effectiveParLevel,
  fefoSort,
  parStatus,
  stockBalanceKey,
} from "@starter/shared/inventory";
import type {
  InventoryItem,
  ParLevel,
  ParStatus,
  StockBalance,
  StockBatch,
  StockBatchExpiryStatus,
  StockLedgerEntry,
  StockLocation,
  Uom,
} from "@starter/shared/inventory";
import { INVENTORY_TIME_ZONE } from "./outlet.ts";

/** One page of a cursor list; the contract caps `limit` at 100. */
export const STOCK_LIST_LIMIT = 100;
/** Rows per page inside a loaded list (DataTableShell pagination). */
export const PAGE_SIZE = 20;

/**
 * Expiry warning window. The contract takes it from tenant configuration
 * (`batchExpiryStatus` doc), which has no settings endpoint yet; the screens
 * use a constant until that lands (reported as a follow-up).
 */
export const EXPIRY_WARN_DAYS = 7;

// ---- Number and date formatting ------------------------------------------

const quantityFormat = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 4,
});

/** "22.2000" → "22,2"; keeps up to four decimals and drops trailing zeros. */
export function formatQuantity(value: Decimal4 | string): string {
  return quantityFormat.format(Number(value));
}

/** "+12" / "−3,5": the stock-card sign (PRD §6.E quantity sign convention). */
export function formatSignedQuantity(value: Decimal4 | string): string {
  const scaled = parseDecimal4(value);
  const absolute = scaled < 0n ? -scaled : scaled;
  return `${scaled < 0n ? "−" : "+"}${formatQuantity(
    formatDecimal4(absolute),
  )}`;
}

/** "2026-11-01" → "1 Nov 2026", locale-stable (id-ID, UTC). */
export function formatBusinessDate(value: BusinessDate | string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Timestamp in the outlet time zone (D-CORE-6), e.g. "1 Nov 2026, 07.05". */
export function formatDateTime(
  value: string,
  timeZone: string = INVENTORY_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(value));
}

/** The outlet's business date (D-CORE-6), "2026-11-01". */
export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = INVENTORY_TIME_ZONE,
): BusinessDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
  }).format(now) as BusinessDate;
}

/** "2026-11-01" + 3 → "2026-11-04" (calendar days, no time zone drift). */
export function addDays(value: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10) as BusinessDate;
}

/** Whole days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(
  from: BusinessDate | string,
  to: BusinessDate | string,
): number {
  const parse = (value: string): number => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** Business date of an instant in the outlet time zone, for ledger filters. */
export function businessDateOf(
  instant: string,
  timeZone: string = INVENTORY_TIME_ZONE,
): BusinessDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
  }).format(new Date(instant)) as BusinessDate;
}

// ---- Stock card (ledger) --------------------------------------------------

export type LedgerRow = {
  entry: StockLedgerEntry;
  item: InventoryItem | undefined;
  location: StockLocation | undefined;
  batch: StockBatch | undefined;
  unit: string;
};

export function ledgerRows(input: {
  ledger: readonly StockLedgerEntry[];
  items: readonly InventoryItem[];
  locations: readonly StockLocation[];
  batches: readonly StockBatch[];
  uoms: readonly Uom[];
}): LedgerRow[] {
  const items = new Map(input.items.map((row) => [row.id, row]));
  const locations = new Map(input.locations.map((row) => [row.id, row]));
  const batches = new Map(input.batches.map((row) => [row.id, row]));
  const uoms = new Map(input.uoms.map((row) => [row.id, row.code]));
  return input.ledger.map((entry) => {
    const item = items.get(entry.inventoryItemId);
    return {
      entry,
      item,
      location: locations.get(entry.locationId),
      batch: entry.batchId ? batches.get(entry.batchId) : undefined,
      unit: item ? (uoms.get(item.baseUomId) ?? "") : "",
    };
  });
}

/** "in" / "out" for the row; `adjustment` and `return` follow the sign. */
export function movementDirection(
  entry: Pick<StockLedgerEntry, "movementType" | "quantity">,
): "in" | "out" {
  const direction = STOCK_MOVEMENT_DIRECTION[entry.movementType];
  if (direction === "either")
    return parseDecimal4(entry.quantity) < 0n ? "out" : "in";
  return direction;
}

/** Neural key for one source document, used by the stock-card source filter. */
export function sourceKey(
  entry: Pick<StockLedgerEntry, "sourceType" | "sourceId">,
): string {
  return `${entry.sourceType}:${entry.sourceId}`;
}

/** Whole-rupiah value of one ledger line (quantity × unit cost). */
export function ledgerLineValueIdr(
  entry: Pick<StockLedgerEntry, "quantity" | "unitCostIdr">,
): Idr {
  return extendCostIdr(entry.quantity, entry.unitCostIdr, "half_up");
}

/**
 * Last 8 characters of a document id, for dense table cells. Fixture UUIDs
 * and time-ordered ULIDs share their leading characters, so the tail is what
 * tells two documents apart.
 */
export function shortId(value: string): string {
  return `…${value.slice(-8)}`;
}

// ---- Balances per location and par levels ---------------------------------

export type BalanceRow = {
  key: string;
  balance: StockBalance;
  item: InventoryItem | undefined;
  location: StockLocation | undefined;
  unit: string;
  valueIdr: Idr;
  /** Effective par: the location override wins over the item defaults. */
  parMin: Decimal4 | null;
  parMax: Decimal4 | null;
  status: ParStatus | null;
};

export function balanceRows(input: {
  balances: readonly StockBalance[];
  parLevels: readonly ParLevel[];
  items: readonly InventoryItem[];
  locations: readonly StockLocation[];
  uoms: readonly Uom[];
}): BalanceRow[] {
  const items = new Map(input.items.map((row) => [row.id, row]));
  const locations = new Map(input.locations.map((row) => [row.id, row]));
  const uoms = new Map(input.uoms.map((row) => [row.id, row.code]));
  const overrides = new Map(
    input.parLevels.map((row) => [
      stockBalanceKey(row.locationId, row.inventoryItemId),
      row,
    ]),
  );
  return input.balances
    .map((balance) => {
      const item = items.get(balance.inventoryItemId);
      const override = overrides.get(
        stockBalanceKey(balance.locationId, balance.inventoryItemId),
      );
      const par = item ? effectiveParLevel(item, override) : null;
      return {
        key: stockBalanceKey(balance.locationId, balance.inventoryItemId),
        balance,
        item,
        location: locations.get(balance.locationId),
        unit: item ? (uoms.get(item.baseUomId) ?? "") : "",
        valueIdr: extendCostIdr(
          balance.quantity,
          balance.avgCostIdr,
          "half_up",
        ),
        parMin: par?.parMin ?? null,
        parMax: par?.parMax ?? null,
        status: par ? parStatus(balance.quantity, par) : null,
      };
    })
    .sort(
      (a, b) =>
        (a.item?.name ?? "").localeCompare(b.item?.name ?? "", "id-ID") ||
        (a.location?.name ?? "").localeCompare(b.location?.name ?? "", "id-ID"),
    );
}

export type ParRow = {
  key: string;
  item: InventoryItem;
  location: StockLocation | undefined;
  unit: string;
  onHand: Decimal4;
  parMin: Decimal4;
  parMax: Decimal4;
  status: ParStatus;
  valueIdr: Idr;
  /** True when the pair has its own par_levels row (item defaults otherwise). */
  explicit: boolean;
};

/**
 * Every par-level pair the screens can compare: explicit `par_levels` rows
 * plus item-level defaults for locations that actually hold the item. An
 * item default alone does not make every location "below par" — a location
 * that never stores milk is not short of milk — so the item default joins
 * only pairs that have a balance row.
 */
export function parRows(input: {
  balances: readonly StockBalance[];
  parLevels: readonly ParLevel[];
  items: readonly InventoryItem[];
  locations: readonly StockLocation[];
  uoms: readonly Uom[];
}): ParRow[] {
  const items = new Map<string, InventoryItem>(
    input.items.map((row) => [row.id, row]),
  );
  const locations = new Map<string, StockLocation>(
    input.locations.map((row) => [row.id, row]),
  );
  const uoms = new Map<string, string>(
    input.uoms.map((row) => [row.id, row.code]),
  );
  const balances = new Map<string, StockBalance>(
    input.balances.map((row) => [
      stockBalanceKey(row.locationId, row.inventoryItemId),
      row,
    ]),
  );
  const rows: ParRow[] = [];
  const explicitPairs = new Set<string>();

  const push = (par: {
    item: InventoryItem;
    locationId: string;
    parMin: Decimal4;
    parMax: Decimal4;
    explicit: boolean;
  }): void => {
    const key = stockBalanceKey(par.locationId, par.item.id);
    const balance = balances.get(key);
    const onHand = balance?.quantity ?? ("0.0000" as Decimal4);
    rows.push({
      key,
      item: par.item,
      location: locations.get(par.locationId),
      unit: uoms.get(par.item.baseUomId) ?? "",
      onHand,
      parMin: par.parMin,
      parMax: par.parMax,
      status: parStatus(onHand, par),
      valueIdr: balance
        ? extendCostIdr(balance.quantity, balance.avgCostIdr, "half_up")
        : idr(0),
      explicit: par.explicit,
    });
  };

  for (const level of input.parLevels) {
    const item = items.get(level.inventoryItemId);
    if (!item) continue;
    explicitPairs.add(stockBalanceKey(level.locationId, item.id));
    push({
      item,
      locationId: level.locationId,
      parMin: level.parMin,
      parMax: level.parMax,
      explicit: true,
    });
  }

  for (const balance of input.balances) {
    if (
      explicitPairs.has(
        stockBalanceKey(balance.locationId, balance.inventoryItemId),
      )
    )
      continue;
    const item = items.get(balance.inventoryItemId);
    if (!item) continue;
    const par = effectiveParLevel(item);
    if (!par) continue;
    push({
      item,
      locationId: balance.locationId,
      parMin: par.parMin,
      parMax: par.parMax,
      explicit: false,
    });
  }

  return rows.sort(
    (a, b) =>
      a.item.name.localeCompare(b.item.name, "id-ID") ||
      (a.location?.name ?? "").localeCompare(b.location?.name ?? "", "id-ID"),
  );
}

/** Below-minimum pairs, most critical first (lowest on-hand / parMin). */
export function criticalRows(rows: readonly ParRow[]): ParRow[] {
  return rows
    .filter((row) => row.status === "below_min")
    .sort(
      (a, b) =>
        Number(a.onHand) / Math.max(Number(a.parMin), 1) -
        Number(b.onHand) / Math.max(Number(b.parMin), 1),
    );
}

export function totalStockValueIdr(rows: readonly BalanceRow[]): Idr {
  return sumIdr(rows.map((row) => row.valueIdr));
}

// ---- Purchase suggestions (AI-08) -----------------------------------------

export type PurchaseSuggestion = {
  key: string;
  item: InventoryItem;
  location: StockLocation | undefined;
  unit: string;
  onHand: Decimal4;
  parMin: Decimal4;
  parMax: Decimal4;
  /** Refill to parMax: the par-level basis AI-08 starts from (PRD §16). */
  suggestedQty: Decimal4;
};

/**
 * Purchase suggestions from the par-level basis: a pair below parMin buys
 * `parMax - onHand`. AI-08 (PRD §16 "Saran Pembelian") adds forecast-based
 * quantities later; until that service lands this deterministic par-level
 * basis is what the screen shows, and the card says so.
 */
export function purchaseSuggestions(
  rows: readonly ParRow[],
): PurchaseSuggestion[] {
  return criticalRows(rows).map((row) => ({
    key: row.key,
    item: row.item,
    location: row.location,
    unit: row.unit,
    onHand: row.onHand,
    parMin: row.parMin,
    parMax: row.parMax,
    suggestedQty: formatDecimal4(
      parseDecimal4(row.parMax) - parseDecimal4(row.onHand),
    ),
  }));
}

/**
 * Purchase request lines from selected suggestions. A PR is outlet-level (PRD
 * §4 Alur I: kitchen lead → Purchase Request), so one item short in two
 * locations becomes one line with the summed quantity, not two lines the
 * buyer cannot tell apart. Order follows the first suggestion of each item.
 */
export function purchaseRequestLines(
  suggestions: readonly Pick<PurchaseSuggestion, "item" | "suggestedQty">[],
): { inventoryItemId: string; quantity: Decimal4; uomId: string }[] {
  const lines = new Map<
    string,
    { inventoryItemId: string; scaled: bigint; uomId: string }
  >();
  for (const row of suggestions) {
    const key = `${row.item.id}:${row.item.baseUomId}`;
    const line = lines.get(key) ?? {
      inventoryItemId: row.item.id,
      scaled: 0n,
      uomId: row.item.baseUomId,
    };
    line.scaled += parseDecimal4(row.suggestedQty);
    lines.set(key, line);
  }
  return [...lines.values()].map((line) => ({
    inventoryItemId: line.inventoryItemId,
    quantity: formatDecimal4(line.scaled),
    uomId: line.uomId,
  }));
}

// ---- Batches and expiry (FEFO) --------------------------------------------

export type ExpiryRow = {
  batch: StockBatch;
  item: InventoryItem | undefined;
  location: StockLocation | undefined;
  unit: string;
  status: StockBatchExpiryStatus;
  /** Days until expiry; null when the batch carries no expiry date. */
  days: number | null;
  /** 1-based FEFO rank over every batch, optional expiry last (PRD §16). */
  fefoRank: number;
};

export function expiryRows(
  input: {
    batches: readonly StockBatch[];
    items: readonly InventoryItem[];
    locations: readonly StockLocation[];
    uoms: readonly Uom[];
  },
  asOf: BusinessDate,
  warnDays: number = EXPIRY_WARN_DAYS,
): ExpiryRow[] {
  const items = new Map(input.items.map((row) => [row.id, row]));
  const locations = new Map(input.locations.map((row) => [row.id, row]));
  const uoms = new Map(input.uoms.map((row) => [row.id, row.code]));
  return fefoSort(input.batches).map((batch, index) => {
    const item = items.get(batch.inventoryItemId);
    return {
      batch,
      item,
      location: locations.get(batch.locationId),
      unit: item ? (uoms.get(item.baseUomId) ?? "") : "",
      status: batchExpiryStatus(batch, asOf, warnDays),
      days: batch.expiresOn ? daysBetween(asOf, batch.expiresOn) : null,
      fefoRank: index + 1,
    };
  });
}

/** Batches that need attention (expired or inside the warning window). */
export function attentionBatches(rows: readonly ExpiryRow[]): ExpiryRow[] {
  return rows.filter(
    (row) => row.status === "expired" || row.status === "expiring_soon",
  );
}

/** "Use first" list: the three closest expiries, regardless of status. */
export function closestExpiryBatches(
  rows: readonly ExpiryRow[],
  count = 3,
): ExpiryRow[] {
  return rows.filter((row) => row.batch.expiresOn !== null).slice(0, count);
}

// ---- Listing --------------------------------------------------------------

export function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID");
}

export function matchesQuery(haystack: string, query: string): boolean {
  const needle = normalizeQuery(query);
  return needle === "" || normalizeQuery(haystack).includes(needle);
}

/** Client-side page over a fully loaded list; 1-based, clamped. */
export function listPage<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = PAGE_SIZE,
): { rows: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    page: safePage,
    totalPages,
  };
}

/**
 * Route loaders skip the SSR prefetch when the URL asks for a mock scenario
 * (?mock=empty|slow|error|offline): the scenario lives in the browser, so a
 * server-prefetched page would otherwise never show the state.
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
