// Pure helpers for the floor editor: plan geometry, the zone opening-hours
// editor and the zone/table form values. No React and no `@/` alias, so
// tests/floor-editor.test.mjs can import this file with plain Node ESM.
// Business rules live in the contract (@starter/shared/qr-order); this file
// only shapes what the screens show and validate.

import type { MessageKey } from "@starter/shared/i18n";
import type {
  FloorZone,
  Table,
  TableLayout,
  TablePlacement,
  ZoneHours,
} from "@starter/shared/qr-order";

/** Plan surface in plan units; the fixtures place tables inside 640 × 360. */
export const PLAN_WIDTH = 640;
export const PLAN_HEIGHT = 360;

/** Tables snap to this step, so a hand-placed floor plan stays tidy. */
export const GRID = 10;

/** Day indexes in display order: Monday first (PRD WFC "hari kerja"). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Short day names by contract day number: 0 = Sunday. */
export const DAY_LABEL_KEYS: readonly MessageKey[] = [
  "floorEditor.day.sun",
  "floorEditor.day.mon",
  "floorEditor.day.tue",
  "floorEditor.day.wed",
  "floorEditor.day.thu",
  "floorEditor.day.fri",
  "floorEditor.day.sat",
];

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function snapToGrid(value: number, step = GRID): number {
  return Math.round(value / step) * step;
}

/** Rounds a position to the plan grid; sizes are left alone. */
export function snapLayout(layout: TableLayout): TableLayout {
  return { ...layout, x: snapToGrid(layout.x), y: snapToGrid(layout.y) };
}

/** Keeps a table inside the plan: no negative positions, no overflow. */
export function clampLayout(
  layout: TableLayout,
  plan = { width: PLAN_WIDTH, height: PLAN_HEIGHT },
): TableLayout {
  const width = clampNumber(layout.width, GRID, plan.width);
  const height = clampNumber(layout.height, GRID, plan.height);
  return {
    ...layout,
    x: clampNumber(layout.x, 0, plan.width - width),
    y: clampNumber(layout.y, 0, plan.height - height),
    width,
    height,
  };
}

/** Moves a table by a delta in plan units, snapped and clamped to the plan. */
export function moveLayout(
  layout: TableLayout,
  dx: number,
  dy: number,
  plan = { width: PLAN_WIDTH, height: PLAN_HEIGHT },
): TableLayout {
  return clampLayout(
    snapLayout({ ...layout, x: layout.x + dx, y: layout.y + dy }),
    plan,
  );
}

/** Turns a rectangular table a quarter: same footprint, swapped sides. */
export function rotateLayout(layout: TableLayout): TableLayout {
  return clampLayout({ ...layout, width: layout.height, height: layout.width });
}

export function layoutsEqual(a: TableLayout, b: TableLayout): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.rotation === b.rotation &&
    a.shape === b.shape
  );
}

/** The tables whose draft layout differs from the saved one. */
export function changedPlacements(
  drafts: Readonly<Record<string, TableLayout>>,
  tables: readonly Table[],
): TablePlacement[] {
  const placements: TablePlacement[] = [];
  for (const table of tables) {
    const draft = drafts[table.id];
    if (draft && !layoutsEqual(draft, table.layout))
      placements.push({ tableId: table.id, layout: draft });
  }
  return placements;
}

/** First free slot for a new table: top-left to bottom-right, one grid step. */
export function findFreeSpot(
  tables: readonly Table[],
  size: { width: number; height: number },
  plan = { width: PLAN_WIDTH, height: PLAN_HEIGHT },
): { x: number; y: number } {
  const overlaps = (x: number, y: number) =>
    tables.some(
      (table) =>
        x < table.layout.x + table.layout.width &&
        x + size.width > table.layout.x &&
        y < table.layout.y + table.layout.height &&
        y + size.height > table.layout.y,
    );
  for (let y = 0; y + size.height <= plan.height; y += GRID)
    for (let x = 0; x + size.width <= plan.width; x += GRID)
      if (!overlaps(x, y)) return { x, y };
  // The plan is full: stack the table at the origin rather than refuse the add.
  return { x: 0, y: 0 };
}

/** Zone prefix for a suggested table number: A, B, … for zone 0, 1, …. */
export function zoneCodePrefix(zoneIndex: number): string {
  return String.fromCharCode(65 + clampNumber(zoneIndex, 0, 25));
}

/** Next table number in a zone, e.g. A01, A02 — the manager may edit it. */
export function suggestTableCode(
  tablesInZone: readonly Pick<Table, "code">[],
  zoneIndex: number,
): string {
  const prefix = zoneCodePrefix(zoneIndex);
  let highest = 0;
  for (const table of tablesInZone) {
    const match = /^[A-Z]-?(\d{1,3})$/.exec(table.code);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}${String(highest + 1).padStart(2, "0")}`;
}

export function tablesOfZone(
  tables: readonly Table[],
  zoneId: string | null,
): Table[] {
  return zoneId === null
    ? [...tables]
    : tables.filter((table) => table.zoneId === zoneId);
}

export function sortZones(zones: readonly FloorZone[]): FloorZone[] {
  return [...zones].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "id-ID"),
  );
}

/** Case-insensitive match on the table number, for the QR sheet's search. */
export function matchesTableQuery(
  table: Pick<Table, "code">,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  return (
    needle === "" || table.code.toLocaleLowerCase("id-ID").includes(needle)
  );
}

/** Service charge display: 500 bp is 5%. */
export function percentOfBasisPoints(bp: number): number {
  return Math.round(bp) / 100;
}

export function basisPointsOfPercent(percent: number): number {
  return Math.round(clampNumber(percent, 0, 100) * 100);
}

/** Digits a rupiah field holds; anything else (dots, spaces) is ignored. */
export function digitsOf(text: string): string {
  return text.replace(/\D/g, "").slice(0, 12);
}

/** Whole rupiah from a typed amount: "500.000" → 500000, "" → 0. */
export function rupiahOf(text: string): number {
  const digits = digitsOf(text);
  return digits === "" ? 0 : Number(digits);
}

/** Groups typed rupiah in Indonesian style: 500000 → "500.000". */
export function formatRupiahInput(amount: number): string {
  return String(Math.max(0, Math.trunc(amount))).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ".",
  );
}

/** "08:00" → "08.00" (Indonesian time style, no colon). */
export function formatTimeOfDay(value: string): string {
  return value.replace(":", ".");
}

// ---- Opening hours editor -------------------------------------------------

/** One editor row per day; `daysOfWeek` in the contract is 0 = Sunday. */
export type DayHours = { open: boolean; start: string; end: string };

const DEFAULT_START = "08:00";
const DEFAULT_END = "22:00";

/** Expands the contract's windows into seven editable day rows. */
export function fromZoneHours(hours: readonly ZoneHours[]): DayHours[] {
  return Array.from({ length: 7 }, (_, day) => {
    const window = hours.find((entry) => entry.daysOfWeek.includes(day));
    return window
      ? { open: true, start: window.start, end: window.end }
      : { open: false, start: DEFAULT_START, end: DEFAULT_END };
  });
}

/**
 * Groups the day rows back into windows: consecutive days that open and close
 * at the same time become one `daysOfWeek` entry, which is the shape the
 * contract stores (PRD §3 F9 "jam operasional").
 */
export function toZoneHours(days: readonly DayHours[]): ZoneHours[] {
  const windows: ZoneHours[] = [];
  for (const dayIndex of [0, 1, 2, 3, 4, 5, 6]) {
    const day = days[dayIndex];
    if (!day?.open) continue;
    const neighbour = windows.find(
      (window) =>
        window.start === day.start &&
        window.end === day.end &&
        window.daysOfWeek.includes((dayIndex + 6) % 7),
    );
    if (neighbour) neighbour.daysOfWeek.push(dayIndex);
    else
      windows.push({
        daysOfWeek: [dayIndex],
        start: day.start,
        end: day.end,
      });
  }
  return windows;
}

/** True when at least one day is open; the contract needs one window. */
export function hasOpenDay(days: readonly DayHours[]): boolean {
  return days.some((day) => day.open);
}

/**
 * One-line summary for the zone list, e.g. "Setiap hari 08.00–22.00" or
 * "Sen, Sel 08.00–18.00 · +1 jadwal". Day names come from the catalog so no
 * text lives here.
 */
export function describeZoneHours(
  hours: readonly ZoneHours[],
  labels: { days: readonly string[]; everyDay: string; more: string },
): string {
  if (hours.length === 0) return "";
  const [first] = hours;
  const days =
    first.daysOfWeek.length === 7
      ? labels.everyDay
      : [...first.daysOfWeek]
          .sort((a, b) => a - b)
          .map((day) => labels.days[day])
          .join(", ");
  const range = `${formatTimeOfDay(first.start)}–${formatTimeOfDay(first.end)}`;
  const more =
    hours.length > 1
      ? ` · ${labels.more.replace("{count}", String(hours.length - 1))}`
      : "";
  return `${days} ${range}${more}`;
}
