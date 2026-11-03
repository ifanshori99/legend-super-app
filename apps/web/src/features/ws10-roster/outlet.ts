// One outlet for the roster back office until the outlet context (session /
// device, TEN-02) lands. Same constant as the other management screens
// (`cafeLegendFixtures.outlets[0]`); the id travels in a query only and the API
// still verifies the caller's outlet scope (TEN-03).
import { outletIdSchema } from "@starter/shared/core";

export const ROSTER_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/**
 * Outlet time zone for building draft shift instants from template wall-clock
 * times (D-CORE-6). Asia/Jakarta has no daylight saving, so a fixed +07:00
 * offset is safe for the local draft until the outlet context supplies the
 * real zone; the server derives `businessDate` for published rows itself.
 */
export const ROSTER_TIME_ZONE = "Asia/Jakarta";
export const ROSTER_UTC_OFFSET = "+07:00";
