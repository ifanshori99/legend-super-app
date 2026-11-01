import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the kitchen screens operate.
 *
 * The outlet context (session/device, TEN-02) has not landed yet, so the app
 * runs one outlet: the one the API mock fixtures describe
 * (`cafeLegendFixtures.outlets[0]`). The outlet id travels in the path only;
 * the API still verifies the caller's scope for it. When the outlet context
 * bead lands, this constant is the only thing that changes here.
 */
export const KITCHEN_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/**
 * Outlet time zone for the times on these screens (business dates and clock
 * times are the outlet's, not the browser's). The outlet context supplies the
 * real zone later; this matches the shell's default until then.
 */
export const KITCHEN_TIME_ZONE = "Asia/Jakarta";
