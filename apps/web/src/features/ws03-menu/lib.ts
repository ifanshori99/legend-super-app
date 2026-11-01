// Pure helpers for the menu back office: joins, filters and display order.
// No React, no `@/` alias, so tests/menu-backoffice.test.mjs can import this
// file with plain Node ESM. Business rules live in the contract
// (@starter/shared/menu) — this only shapes what the screens show.

import type {
  Availability,
  Category,
  Combo,
  MenuItemAdmin,
  PriceList,
  PriceListItem,
} from "@starter/shared/menu";

export type ItemStatus = "available" | "sold_out" | "inactive";

export type ItemRow = {
  item: MenuItemAdmin;
  category: Category | undefined;
  availability: Availability | undefined;
  status: ItemStatus;
  /** Dine-in price of this item without variant, when a price list has one. */
  priceIdr: number | undefined;
};

export type ItemFilters = {
  search?: string;
  categoryId?: string;
  stationId?: string;
  status?: ItemStatus;
};

export function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID");
}

export function matchesQuery(haystack: string, query: string): boolean {
  const needle = normalizeQuery(query);
  return needle === "" || normalizeQuery(haystack).includes(needle);
}

/** A sold-out item outranks the active flag: 86 is the operational state. */
export function itemStatus(
  item: Pick<MenuItemAdmin, "isActive">,
  availability: Pick<Availability, "status"> | undefined,
): ItemStatus {
  if (availability?.status === "sold_out") return "sold_out";
  return item.isActive ? "available" : "inactive";
}

export function availabilityByItem(
  rows: readonly Availability[],
): Map<string, Availability> {
  return new Map(rows.map((row) => [row.menuItemId, row]));
}

/** Prices for items without a variant, keyed by item id. */
export function priceByItem(
  rows: readonly PriceListItem[],
): Map<string, number> {
  return new Map(
    rows
      .filter((row) => row.variantId === null)
      .map((row) => [row.itemId, row.priceIdr]),
  );
}

/**
 * The price list that applies to a channel on a business date: the latest
 * `effectiveFrom` that is on or before the date (PRD §8 "tanggal efektif").
 */
export function effectivePriceList(
  lists: readonly PriceList[],
  channel: PriceList["channel"],
  businessDate: string,
): PriceList | undefined {
  return lists
    .filter((list) => list.channel === channel)
    .filter((list) => list.effectiveFrom <= businessDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .at(-1);
}

export function itemRows(input: {
  items: readonly MenuItemAdmin[];
  categories: readonly Category[];
  availability: readonly Availability[];
  priceListItems: readonly PriceListItem[];
}): ItemRow[] {
  const categories = new Map(input.categories.map((row) => [row.id, row]));
  const availability = availabilityByItem(input.availability);
  const prices = priceByItem(input.priceListItems);
  return input.items.map((item) => {
    const row = availability.get(item.id);
    return {
      item,
      category: categories.get(item.categoryId),
      availability: row,
      status: itemStatus(item, row),
      priceIdr: prices.get(item.id),
    };
  });
}

export function filterItemRows(
  rows: readonly ItemRow[],
  filters: ItemFilters,
): ItemRow[] {
  return rows.filter(({ item, status }) => {
    if (filters.categoryId && item.categoryId !== filters.categoryId)
      return false;
    if (filters.stationId && item.stationId !== filters.stationId) return false;
    if (filters.status && status !== filters.status) return false;
    if (filters.search && !matchesQuery(item.name, filters.search))
      return false;
    return true;
  });
}

export type ItemSort = "display" | "name" | "category";

/** Stable sort; display order falls back to the item's own sortOrder. */
export function sortItemRows(
  rows: readonly ItemRow[],
  sort: ItemSort,
): ItemRow[] {
  const copy = [...rows];
  if (sort === "name")
    return copy.sort((a, b) => a.item.name.localeCompare(b.item.name, "id-ID"));
  if (sort === "category")
    return copy.sort((a, b) => {
      const left = a.category?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const right = b.category?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return (
        left - right ||
        a.item.sortOrder - b.item.sortOrder ||
        a.item.name.localeCompare(b.item.name, "id-ID")
      );
    });
  return copy.sort(
    (a, b) =>
      a.item.sortOrder - b.item.sortOrder ||
      a.item.name.localeCompare(b.item.name, "id-ID"),
  );
}

/** Moves `fromId` before `toId`; returns null when the move is a no-op. */
export function reorderIds(
  ids: readonly string[],
  fromId: string,
  toId: string,
): string[] | null {
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, fromId);
  return next;
}

/** Reorders one record and renumbers sortOrder for the whole list (0..n-1). */
export function applyDisplayOrder<T>(
  rows: readonly T[],
  orderedIds: readonly string[],
  idOf: (row: T) => string,
  setSortOrder: (row: T, sortOrder: number) => T,
): T[] {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  return rows
    .map((row) => {
      const index = position.get(idOf(row));
      return index === undefined ? row : setSortOrder(row, index);
    })
    .sort(
      (a, b) => (position.get(idOf(a)) ?? 0) - (position.get(idOf(b)) ?? 0),
    );
}

type ComboComponent = Combo["components"][number];

export function totalAllocationBp(
  components: readonly ComboComponent[],
): number {
  return components.reduce(
    (sum, component) => sum + component.revenueAllocationBp,
    0,
  );
}

/** PRD §8 "alokasi pendapatan per item": the split must total exactly 100%. */
export function allocationIsValid(
  components: readonly ComboComponent[],
): boolean {
  return totalAllocationBp(components) === 10_000;
}

/** Next display position at the end of a sibling list. */
export function nextSortOrder(rows: readonly { sortOrder: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
}

/** Newest effective date first, so the price list screen reads top-down. */
export function sortPriceLists(lists: readonly PriceList[]): PriceList[] {
  return [...lists].sort(
    (a, b) =>
      a.channel.localeCompare(b.channel) ||
      b.effectiveFrom.localeCompare(a.effectiveFrom),
  );
}

export function scheduleDaysCsv(days: readonly number[]): string {
  return [...days].sort((a, b) => a - b).join(",");
}

/**
 * The outlet's business date (PRD: business dates in the outlet time zone).
 * The outlet context bead supplies the outlet's own zone; until then the
 * screens use the app default (same constant as the shell clock).
 */
export const DEFAULT_OUTLET_TIME_ZONE = "Asia/Jakarta";

export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = DEFAULT_OUTLET_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** "2026-11-01" → "1 Nov 2026" for table cells (locale-stable, id-ID). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Schedule rows → "Sen, Sel · 08:00–11:00" / "Tanpa jadwal". */
export function describeSchedule(
  schedule: readonly { daysOfWeek: number[]; start: string; end: string }[],
  labels: {
    noSchedule: string;
    everyDay: string;
    days: Record<number, string>;
  },
): string {
  if (schedule.length === 0) return labels.noSchedule;
  return schedule
    .map((row) => {
      const days =
        row.daysOfWeek.length === 7
          ? labels.everyDay
          : [...row.daysOfWeek]
              .sort((a, b) => a - b)
              .map((day) => labels.days[day] ?? String(day))
              .join(", ");
      return `${days} · ${row.start}–${row.end}`;
    })
    .join(" · ");
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

/** 0–100 percent input → basis points, clamped to the 0–10000 range. */
export function percentToBp(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.round(Math.min(100, Math.max(0, percent)) * 100);
}

export function bpToPercent(bp: number): number {
  return Math.round((bp / 100) * 100) / 100;
}
