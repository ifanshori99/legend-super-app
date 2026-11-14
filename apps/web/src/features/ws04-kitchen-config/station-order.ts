// Pure helpers of the station config editor (bead legend-sonf): row building,
// reordering, dirty check and the save body. Loaded by Node tests with type
// stripping, so no runtime imports and no aliases.
import type { StationConfig } from "@starter/shared/kitchen";

/** One editable row: the KDS tab config plus the menu station's name. */
export type StationRow = {
  stationId: string;
  /** Menu station name; null while the menu contract does not know it. */
  name: string | null;
  /** Menu station type, e.g. `coffee_bar`; drives the row description. */
  type: string | null;
  isActive: boolean;
  autoPrintFallback: boolean;
};

export type StationRowFlag = "isActive" | "autoPrintFallback";
export type MoveDirection = "up" | "down";

/** The body of `updateKitchenStations` (@starter/shared/kitchen). */
export type StationUpdate = {
  stationId: string;
  displayOrder: number;
  isActive: boolean;
  autoPrintFallback: boolean;
};

/** Rows in KDS tab order (`displayOrder`, then stationId for a stable tie). */
export function buildStationRows(
  configs: readonly Pick<
    StationConfig,
    "stationId" | "displayOrder" | "isActive" | "autoPrintFallback"
  >[],
  menuStations: readonly { id: string; name: string; type: string }[],
): StationRow[] {
  const menuById = new Map(
    menuStations.map((station) => [station.id, station]),
  );
  return [...configs]
    .sort(
      (a, b) =>
        a.displayOrder - b.displayOrder ||
        a.stationId.localeCompare(b.stationId),
    )
    .map((config) => {
      const menu = menuById.get(config.stationId);
      return {
        stationId: config.stationId,
        name: menu?.name ?? null,
        type: menu?.type ?? null,
        isActive: config.isActive,
        autoPrintFallback: config.autoPrintFallback,
      };
    });
}

/** Swaps the row with its neighbour; out of range returns the rows as they are. */
export function moveStation(
  rows: readonly StationRow[],
  index: number,
  direction: MoveDirection,
): StationRow[] {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length)
    return [...rows];
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function setStationFlag(
  rows: readonly StationRow[],
  stationId: string,
  flag: StationRowFlag,
  value: boolean,
): StationRow[] {
  return rows.map((row) =>
    row.stationId === stationId ? { ...row, [flag]: value } : row,
  );
}

/** True when the draft differs from the saved rows in order or in a flag. */
export function stationsDirty(
  saved: readonly StationRow[],
  draft: readonly StationRow[],
): boolean {
  if (saved.length !== draft.length) return true;
  return draft.some((row, index) => {
    const before = saved[index];
    return (
      before.stationId !== row.stationId ||
      before.isActive !== row.isActive ||
      before.autoPrintFallback !== row.autoPrintFallback
    );
  });
}

/** Every station with its new position: the endpoint replaces the whole order. */
export function toStationUpdates(rows: readonly StationRow[]): StationUpdate[] {
  return rows.map((row, displayOrder) => ({
    stationId: row.stationId,
    displayOrder,
    isActive: row.isActive,
    autoPrintFallback: row.autoPrintFallback,
  }));
}

/** `01`..`NN` rank label. */
export function rankLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}
