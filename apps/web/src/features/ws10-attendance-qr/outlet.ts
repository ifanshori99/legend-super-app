// The outlet this attendance display and review screen operate on.
//
// The outlet context (session/device, TEN-02) has not landed yet, so the app
// runs one outlet: the shared fixtures' Bandung outlet. This mirrors
// `features/ws06-inventory/outlet.ts`; the id only travels in the query, and
// the API still verifies the caller's outlet scope (TEN-03). When the outlet
// context bead lands, these three constants are the only thing to change here.
import { DEFAULT_TIME_ZONE, outletIdSchema } from "@starter/shared/core";

export const ATTENDANCE_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/** Display name of the same fixture outlet (Cafe Legend Bandung). */
export const ATTENDANCE_OUTLET_NAME = "Cafe Legend Bandung";

/** Outlet time zone for business dates and the QR timestamps (D-CORE-6). */
export const ATTENDANCE_TIME_ZONE = DEFAULT_TIME_ZONE;
