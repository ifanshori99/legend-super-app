import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the tax screens configure and report on.
 *
 * The tenant/outlet context (legend-ri1p) has not landed yet, so the app runs
 * one outlet: the one the API mock fixtures describe. The report endpoint
 * needs an explicit outletId (its path is tenant-scoped); the API still
 * verifies the caller's outlet scope (TEN-02). When the outlet context bead
 * lands, this constant is the only thing that changes here — the same
 * pattern as features/ws04-expo/outlet.ts.
 */
export const TAX_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);
