// Mock handlers for outlet settings (`VITE_API_MOCK=true`), so the screen
// works with no API (docs/frontend.md "Typed endpoints and mock mode").
//
// One owner per endpoint (bead legend-jzud): `GET /api/org/outlets` belongs to
// features/ws07-accounting/mock.ts and is NOT registered again here; this file
// owns only `PATCH /api/org/outlets/:outletId`, which no other feature
// registers. That list handler reads `cafeLegendPlatformFixtures.outlets`
// lazily, so a save is written back into the same fixture rows; a reload then
// still shows the new cutoff (sessionStorage keeps the save for this tab).
//
// legend-5kop: the sessionStorage snapshot lives in outlet-store.ts, which the
// app-level tenant resolver reads too, and a cutoff change appends an audit
// event to the audit log mock (features/ws11-audit/mock.ts, the store the
// /audit screen lists). Importing that module is safe: the mock transport
// loads every feature's mock.ts eagerly anyway, so this only shares the one
// registered list handler and its mutable store.
import {
  cafeLegendPlatformFixtures,
  orgEndpoints,
  type Outlet,
} from "@starter/shared/platform";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { appendMockAuditEvent } from "../ws11-audit/mock.ts";
import { readSavedOutlets, writeSavedOutlets } from "./outlet-store.ts";

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
  const rows = (readSavedOutlets() ?? pristine).map((outlet) => ({
    ...outlet,
  }));
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
  writeSavedOutlets(next);
  // PRD v1.7 §3 "Pengaturan" / contracts.md D-CORE-7: a cutoff change is an
  // audited settings change. The audit trail screen lists this store, so the
  // event is visible on /audit without leaving the SPA.
  if (updated.businessDayCutoff !== current.businessDayCutoff) {
    appendMockAuditEvent({
      action: "outlet.business_day_cutoff.updated",
      objectType: "outlet",
      objectId: updated.id,
      outletId: updated.id,
      before: { businessDayCutoff: current.businessDayCutoff },
      after: { businessDayCutoff: updated.businessDayCutoff },
    });
  }
  return { data: updated };
});
