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
  /** Blind count: full detail (system qty, variance) is hidden from this viewer (403). */
  "STOCK_COUNT_BLIND_HIDDEN",
  /** Blind count: lines must be edited through the sheet endpoint (409). */
  "STOCK_COUNT_BLIND_USE_SHEET",
  /** The location already has an open (not posted/cancelled) count (409). */
  "STOCK_COUNT_LOCATION_BUSY",
  /** Submit needs every line counted (422). */
  "STOCK_COUNT_LINES_INCOMPLETE",
  /** No approval policy routed the count to an approver; fails closed (409). */
  "STOCK_COUNT_APPROVAL_UNROUTED",
  /** Lines changed after the approval request was opened (409). */
  "STOCK_COUNT_VERSION_MISMATCH",
  /** Lines can only be edited while the count is in `counting` (409). */
  "STOCK_COUNT_NOT_EDITABLE",
  /** A positive count difference has no unit cost to value it (422). */
  "STOCK_COUNT_COST_MISSING",
  /** Someone who approved or rejected this count cannot enter a line (403). */
  "STOCK_COUNT_DECIDER_CANNOT_COUNT",
  /** The approval deadline passed; approve is refused until it is settled (409). */
  "STOCK_COUNT_APPROVAL_EXPIRED",
  /** The requested production-order action is not allowed from its status. */
  "PRODUCTION_INVALID_TRANSITION",
  /** A stock-out would take the location below zero on hand (F16/F17). */
  "INSUFFICIENT_STOCK",
  /** Production could not resolve a single kitchen location for the outlet. */
  "PRODUCTION_LOCATION_UNRESOLVED",
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
