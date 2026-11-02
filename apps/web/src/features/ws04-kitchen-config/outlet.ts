import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the kitchen back-office screens configure.
 *
 * The outlet context (session/device, TEN-02) has not landed yet, so the app
 * runs one outlet: the one the API mock fixtures describe
 * (`cafeLegendFixtures.outlets[0]`), the same constant the live kitchen
 * screens use (features/ws04-expo/outlet.ts). The outlet id travels in the
 * path only; the API still verifies the caller's scope for it. When the
 * outlet context bead lands, this constant is the only thing that changes.
 */
export const KITCHEN_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/** Outlet time zone for report times (business dates are the outlet's). */
export const KITCHEN_TIME_ZONE = "Asia/Jakarta";

/** First business date the Cafe Legend fixtures describe (mock mode). */
export const FIXTURE_BUSINESS_DATE = "2026-11-01";
