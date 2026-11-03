import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the inventory back office operates.
 *
 * The outlet context (session/device, TEN-02) has not landed yet, so the app
 * runs one outlet: the one the shared fixtures describe
 * (`cafeLegendFixtures.outlets[0]`). The id travels in a query or path only;
 * the API still verifies the caller's outlet scope (TEN-03). When the outlet
 * context bead lands, this constant is the only thing that changes here.
 */
export const INVENTORY_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/**
 * Fallback outlet time zone for transfer times and business dates (D-CORE-6).
 * Screens read the real zone and the owner Q39 cutoff from `useOutletClock()`
 * (lib/tenant-context.tsx); this constant stays the documented default for
 * callers without an outlet, such as the mock handlers.
 */
export const INVENTORY_TIME_ZONE = "Asia/Jakarta";
