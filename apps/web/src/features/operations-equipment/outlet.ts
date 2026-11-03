// The outlet these screens work in. The outlet context (session/device, TEN-02)
// has not landed, so the app runs the outlet the shared fixtures describe
// (`cafeLegendFixtures.outlets[0]`); the id travels in a query only and the
// API still verifies the caller's outlet scope. Same documented interim as
// features/operations-food-safety/outlet.ts and ws06-inventory/outlet.ts.
//
// The fallback also keeps `?mock=empty` honest: an empty outlet list means the
// fixture has no outlet rows, not that the page itself failed.
import { cafeLegendFixtures, outletIdSchema } from "@starter/shared/core";

export const EQUIPMENT_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

export const EQUIPMENT_FALLBACK_OUTLET = cafeLegendFixtures.outlets[0];
