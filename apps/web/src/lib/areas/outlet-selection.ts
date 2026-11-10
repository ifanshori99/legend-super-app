// Which outlet a staff screen works in (legend-2aqp). The outlets come from
// GET /api/me/access (`AreaAccess.outlets`, only the ones assigned to the
// account); the person's pick is remembered in localStorage. Pure logic here so
// it is unit-tested; the shell wires it to React and the browser.
import type { MyOutlet } from "@starter/shared/access";

/** localStorage key of the last outlet the person picked. */
export const SELECTED_OUTLET_STORAGE_KEY = "legend-selected-outlet";

/** 0 = account has no outlet, 1 = no picker needed, many = show the picker. */
export type OutletChoice = "none" | "single" | "multiple";

export function outletChoice(outlets: readonly MyOutlet[]): OutletChoice {
  if (outlets.length === 0) return "none";
  return outlets.length === 1 ? "single" : "multiple";
}

/**
 * The outlet to work in: the saved one when it is still in the assigned list,
 * otherwise the first assigned outlet (the API sorts by name). A stale or
 * tampered saved id never selects an outlet outside the list. Null when the
 * account has no outlet.
 */
export function resolveSelectedOutlet(
  outlets: readonly MyOutlet[],
  savedId: string | null | undefined,
): MyOutlet | null {
  if (outlets.length === 0) return null;
  return outlets.find((outlet) => outlet.id === savedId) ?? outlets[0];
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The saved outlet id, or null (no storage, blocked storage, nothing saved). */
export function readSavedOutletId(
  storage: StorageLike | null = browserStorage(),
): string | null {
  try {
    return storage?.getItem(SELECTED_OUTLET_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the pick; a blocked or full storage just means no memory. */
export function saveOutletId(
  outletId: string,
  storage: StorageLike | null = browserStorage(),
): void {
  try {
    storage?.setItem(SELECTED_OUTLET_STORAGE_KEY, outletId);
  } catch {
    // The pick still applies for this visit.
  }
}
