import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the payroll screens read service-charge pools for.
 *
 * The outlet context (session/device, TEN-02) has not landed yet, so the app
 * runs one outlet: the one the shared fixtures describe. The id travels in a
 * query only; the API still verifies the caller's outlet scope (TEN-03). When
 * the outlet context bead lands, this constant is the only thing that changes
 * here — the same pattern as features/ws06-inventory/outlet.ts.
 */
export const PAYROLL_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);

/** Outlet time zone for audit timestamps (D-CORE-6). */
export const PAYROLL_TIME_ZONE = "Asia/Jakarta";
