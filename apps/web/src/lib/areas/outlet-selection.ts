// Which outlet a staff screen works in (legend-2aqp). The outlets come from
// GET /api/me/access (`AreaAccess.outlets`, only the ones assigned to the
// account); the person's pick is remembered in localStorage. Pure logic here so
// it is unit-tested; the shell wires it to React and the browser.
import type { MyOutlet } from "@starter/shared/access";
import type { AreaAccess } from "./access.ts";
import { AREAS } from "./definitions.ts";
import { evaluateArea } from "./guard.ts";
import type { AreaNavEntry } from "./nav.ts";

/** localStorage key of the last outlet the person picked. */
export const SELECTED_OUTLET_STORAGE_KEY = "legend-selected-outlet";

/** 0 = account has no outlet, 1 = no picker needed, many = show the picker. */
export type OutletChoice = "none" | "single" | "multiple";

export function outletChoice(outlets: readonly MyOutlet[]): OutletChoice {
  if (outlets.length === 0) return "none";
  return outlets.length === 1 ? "single" : "multiple";
}

/**
 * True when a Kelola screen at `pathname` works in the selected outlet (it
 * reads `useTenantContext().outlet`). The management shell shows the picker
 * only on these paths: elsewhere it would be a control that changes nothing, or
 * a second picker next to a screen's own (legend-sp41n). A screen opts in with
 * `outletScopedPaths` on its nav entry (`features/<ws>-<name>/nav.ts`), not
 * with a shared list.
 */
export function kelolaUsesOutletContext(
  pathname: string,
  entries: readonly AreaNavEntry[],
): boolean {
  return entries.some(
    (entry) =>
      entry.area === "kelola" &&
      entry.outletScopedPaths?.some(
        (path) => pathname === path || pathname.startsWith(`${path}/`),
      ),
  );
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

/**
 * True while the saved pick has not been read yet (`undefined`) and there is a
 * real choice between outlets. The first render has no localStorage, so it
 * would work in the first outlet; the shell holds the screen until the pick is
 * read. One outlet or none: nothing to wait for.
 */
export function outletPickPending(
  outlets: readonly MyOutlet[],
  savedId: string | null | undefined,
): boolean {
  return outlets.length > 1 && savedId === undefined;
}

/**
 * Where an account without an outlet goes next: Kelola when it can open that
 * area (it holds a management permission; a pending second factor counts, the
 * gate screen then asks for it), otherwise back to the home page.
 */
export function noOutletNext(access: AreaAccess): "kelola" | "home" {
  const { status } = evaluateArea(AREAS.kelola, access);
  return status === "allowed" || status === "mfa_required" ? "kelola" : "home";
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
