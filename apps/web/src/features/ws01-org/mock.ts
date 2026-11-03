// Mock handlers for outlet settings (`VITE_API_MOCK=true`), so the screen
// works with no API (docs/frontend.md "Typed endpoints and mock mode").
//
// One owner per endpoint (bead legend-jzud): `GET /api/org/outlets` belongs to
// features/ws07-accounting/mock.ts and is NOT registered again here; this file
// owns only `PATCH /api/org/outlets/:outletId`, which no other feature
// registers. That list handler reads `cafeLegendPlatformFixtures.outlets`
// lazily, so a save is written back into the same fixture rows; a reload then
// still shows the new cutoff (sessionStorage keeps the save for this tab).
import {
  cafeLegendPlatformFixtures,
  orgEndpoints,
  outletSchema,
  type Outlet,
} from "@starter/shared/platform";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const STORAGE_KEY = "legend-org-outlets-mock:v1";

/** sessionStorage in the browser only; the SSR server keeps the seed. */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Saves from this tab, validated so a stale snapshot cannot break the mock. */
function readSaved(): Outlet[] | null {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = outletSchema.array().safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    storage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

function writeSaved(outlets: readonly Outlet[]): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(outlets));
  } catch {
    // Quota or private mode: the mock still works without reload memory.
  }
}

/** The pristine rows, captured before any save mutates the shared fixtures. */
const pristine: Outlet[] = cafeLegendPlatformFixtures.outlets.map((outlet) => ({
  ...outlet,
}));

/**
 * The accounting list mock serves `cafeLegendPlatformFixtures.outlets`; write
 * the saved rows back there so both endpoints show the same outlet.
 */
function syncFixtures(outlets: readonly Outlet[]): void {
  for (const outlet of outlets) {
    const row = cafeLegendPlatformFixtures.outlets.find(
      (candidate) => candidate.id === outlet.id,
    );
    if (row) Object.assign(row, outlet);
  }
}

function seed(): Outlet[] {
  const rows = (readSaved() ?? pristine).map((outlet) => ({ ...outlet }));
  syncFixtures(rows);
  return rows;
}

// createMockStore also re-seeds on resetMocks(), which restores the fixtures
// (and re-applies this tab's saved rows, like a reload would).
const store = createMockStore<Outlet[]>(seed);

registerMock(orgEndpoints.updateOutlet, ({ params, body }) => {
  const rows = store.get();
  const index = rows.findIndex((outlet) => outlet.id === params.outletId);
  if (index === -1)
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  const current = rows[index];

  const updated: Outlet = {
    ...current,
    name: body.name ?? current.name,
    address: body.address ?? current.address,
    businessDayCutoff: body.businessDayCutoff ?? current.businessDayCutoff,
    legalEntityId: body.legalEntityId ?? current.legalEntityId,
    regionId: body.regionId !== undefined ? body.regionId : current.regionId,
    geofence: body.geofence !== undefined ? body.geofence : current.geofence,
    openingHours: body.openingHours ?? current.openingHours,
  };
  const next = rows.map((outlet, rowIndex) =>
    rowIndex === index ? updated : outlet,
  );
  store.set(next);
  syncFixtures([updated]);
  writeSaved(next);
  return { data: updated };
});
