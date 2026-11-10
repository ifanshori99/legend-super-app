import { outletIdSchema } from "@starter/shared/core";

/**
 * The outlet the open-bill policy screen configures.
 *
 * The tenant/outlet context (legend-ri1p) has not landed yet, so the app runs
 * one outlet: the one the floor-board mock fixtures describe. When the outlet
 * context bead lands, this constant is the only thing that changes here: the
 * same pattern as features/ws05-tax/outlet.ts.
 */
export const OPEN_BILL_OUTLET_ID = outletIdSchema.parse(
  "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
);
