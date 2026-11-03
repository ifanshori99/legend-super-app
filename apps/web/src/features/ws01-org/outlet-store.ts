// Browser persistence for the outlet settings mock (bead legend-1mi5,
// follow-up legend-5kop). `PATCH /api/org/outlets/:outletId` writes the edited
// rows to sessionStorage so a reload keeps the save; the app-level tenant
// resolver (lib/mock/tenant-context.ts) reads the same snapshot so the outlet
// clock on every route follows the cutoff the settings screen saved.
//
// No `window` at module scope and every read is guarded: the SSR server has no
// sessionStorage and must keep the fixture default, and the shell reads the
// snapshot only after mount (a render that read it on the server and in the
// browser would hydrate with different HTML).
import { outletSchema, type Outlet } from "@starter/shared/platform";

/** The sessionStorage key holding the rows the outlet screen saved. */
export const ORG_OUTLET_STORE_KEY = "legend-org-outlets-mock:v1";

/**
 * Dispatched on `window` after a successful save. A `storage` event only fires
 * in other documents, so the tab that saved needs this to refresh its shells.
 */
export const ORG_OUTLET_STORE_EVENT = "legend:org-outlets-updated";

/** sessionStorage in the browser only; the SSR server keeps the seed. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Saves from this tab, validated so a stale snapshot cannot break the mock. */
export function readSavedOutlets(): Outlet[] | null {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(ORG_OUTLET_STORE_KEY);
    if (!raw) return null;
    const parsed = outletSchema.array().safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    storage.removeItem(ORG_OUTLET_STORE_KEY);
    return null;
  } catch {
    return null;
  }
}

/** The saved row for one outlet, or null when this tab has no save for it. */
export function readSavedOutlet(outletId: string): Outlet | null {
  return readSavedOutlets()?.find((outlet) => outlet.id === outletId) ?? null;
}

export function writeSavedOutlets(outlets: readonly Outlet[]): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(ORG_OUTLET_STORE_KEY, JSON.stringify(outlets));
  } catch {
    // Quota or private mode: the mock still works without reload memory.
    return;
  }
  // Tell mounted shells (the settings screen saves from this document).
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(ORG_OUTLET_STORE_EVENT));
}
