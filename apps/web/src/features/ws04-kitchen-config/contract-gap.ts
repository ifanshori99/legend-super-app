// CONTRACT GAP (bead legend-sonf). The kitchen contract can read the KDS tabs
// (`listKitchenStations`) but has no endpoint to change them. The station
// config editor needs one call that replaces the order and the two flags of
// every station of the outlet at once, so a reorder is never half saved.
// Proposed contract (shared schemas reused, `stationConfigSchema` response):
//   PUT /api/outlets/:outletId/kitchen/stations
//   body { stations: [{ stationId, displayOrder, isActive, autoPrintFallback }] }
// A follow-up contract bead should move it into @starter/shared/kitchen with
// the permission `kds.station.manage`. Outside mock mode the API has no such
// route, so the editor reads the stations but is read-only and says saving is
// "belum tersedia"; it sends no request and never fakes success
// (KITCHEN_STATIONS_UPDATE_AVAILABLE).
import { API_MOCK } from "@/lib/api/mock-flag";
import { defineEndpoint } from "@starter/shared/api";
import { dataResponseSchema, outletIdSchema, z } from "@starter/shared/core";
import { stationConfigSchema } from "@starter/shared/kitchen";

export const updateKitchenStationsBodySchema = z.strictObject({
  stations: z
    .array(
      z.strictObject({
        stationId: stationConfigSchema.shape.stationId,
        displayOrder: stationConfigSchema.shape.displayOrder,
        isActive: stationConfigSchema.shape.isActive,
        autoPrintFallback: stationConfigSchema.shape.autoPrintFallback,
      }),
    )
    .min(1)
    .max(100),
});

export const updateKitchenStations = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/kitchen/stations",
  params: z.strictObject({ outletId: outletIdSchema }),
  body: updateKitchenStationsBodySchema,
  response: dataResponseSchema(z.array(stationConfigSchema)),
});

/** True only where something answers updateKitchenStations (the mock). */
export const KITCHEN_STATIONS_UPDATE_AVAILABLE: boolean = API_MOCK;
