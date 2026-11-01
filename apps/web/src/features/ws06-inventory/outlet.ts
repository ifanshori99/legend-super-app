import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the inventory back office operates.
 *
 * The outlet context (session/device, TEN-02) has not landed yet, so the app
 * runs one outlet: the one the shared fixtures describe. The id travels in a
 * query only; the API still verifies the caller's outlet scope (TEN-03). When
 * the outlet context bead lands, this constant is the only thing that changes.
 */
export const INVENTORY_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/**
 * Outlet time zone for business dates and stock-card times (D-CORE-6). The
 * outlet context supplies the real zone later; this matches the shell default.
 */
export const INVENTORY_TIME_ZONE = "Asia/Jakarta";
