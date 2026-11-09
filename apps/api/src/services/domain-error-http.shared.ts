// One translator from the inventory and purchasing domain errors to HttpError
// (legend-ul4s). Status and safe message come from the shared contract
// (docs/plan/contracts.md, "Inventory and purchasing error statuses"); the
// thrown message is never forwarded because it carries ids and amounts.

import {
  InventoryError,
  PurchasingError,
  inventoryErrorHttpStatus,
  inventoryErrorMessages,
  purchasingErrorHttpStatus,
  purchasingErrorMessages,
} from "@starter/shared/inventory";
import { HttpError } from "../lib/http-error.ts";

/** InventoryError / PurchasingError become HttpError; anything else passes through. */
export function translateDomainError(error: unknown): unknown {
  if (error instanceof InventoryError)
    return new HttpError(
      inventoryErrorHttpStatus[error.code],
      error.code,
      inventoryErrorMessages[error.code],
    );
  if (error instanceof PurchasingError)
    return new HttpError(
      purchasingErrorHttpStatus[error.code],
      error.code,
      purchasingErrorMessages[error.code],
    );
  return error;
}
