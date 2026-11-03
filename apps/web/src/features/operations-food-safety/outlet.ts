// The outlet these screens work in. The outlet context (session/device, TEN-02)
// has not landed, so the app runs the outlet the shared fixtures describe
// (`cafeLegendFixtures.outlets[0]`); the id travels in a query only and the
// API still verifies the caller's outlet scope. When the outlet context bead
// lands, this constant is the only thing that changes here. Same documented
// interim as features/ws06-inventory/outlet.ts and ws04-kitchen-config/outlet.ts.
import { outletIdSchema } from "@starter/shared/core";

export const FOOD_SAFETY_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/** List page size: the ops screens work with one outlet's day, not a catalog. */
export const FOOD_SAFETY_LIST_LIMIT = 100;
