// Domain codes for the inventory contract (bead legend-p38, PRD v1.7 §16,
// §17, §6.E). The API maps them to HTTP responses the same way it maps core
// codes; the UI maps them to catalog text. Codes are UPPER_SNAKE_CASE and
// stable once shipped (docs/plan/contracts.md, D-CORE-4).

import { z } from "../core/index.ts";

export const INVENTORY_ERROR_CODES = [
  /** A recipe component graph loops back to a recipe already being costed. */
  "RECIPE_CYCLE",
  /** A referenced recipe does not exist in the cost book. */
  "RECIPE_NOT_FOUND",
  /** A nested recipe has no output item, so its unit cost cannot be derived. */
  "RECIPE_OUTPUT_MISSING",
  /** A recipe line points at an item or recipe that does not exist. */
  "RECIPE_COMPONENT_MISSING",
  /** An item has no moving-average unit cost yet, so HPP cannot be computed. */
  "UNIT_COST_MISSING",
  /** Two units of an item cannot be converted with the stored factors. */
  "UOM_CONVERSION_MISSING",
  /** The requested stock-count action is not allowed from its status. */
  "STOCK_COUNT_INVALID_TRANSITION",
  /** Approval was attempted before the count was submitted. */
  "STOCK_COUNT_NOT_PENDING_APPROVAL",
  /** PRD INV-03: the counter and the approver must be different people. */
  "STOCK_COUNT_SELF_APPROVAL",
  /** The requested production-order action is not allowed from its status. */
  "PRODUCTION_INVALID_TRANSITION",
] as const;

export const inventoryErrorCodeSchema = z.enum(INVENTORY_ERROR_CODES);
export type InventoryErrorCode = z.infer<typeof inventoryErrorCodeSchema>;

/** Thrown by the pure inventory helpers; services map `code` to a response. */
export class InventoryError extends Error {
  readonly code: InventoryErrorCode;

  constructor(code: InventoryErrorCode, message: string) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
  }
}
