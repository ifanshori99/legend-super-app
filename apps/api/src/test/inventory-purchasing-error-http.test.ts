// legend-ul4s: one shared HTTP mapping for every InventoryError and
// PurchasingError code (docs/plan/contracts.md, "Inventory and purchasing error
// statuses"). Pure unit test: no database.

import {
  INVENTORY_ERROR_CODES,
  InventoryError,
  PURCHASING_ERROR_CODES,
  PurchasingError,
  inventoryErrorHttpStatus,
  inventoryErrorMessages,
  purchasingErrorHttpStatus,
  purchasingErrorMessages,
} from "@starter/shared/inventory";
import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import { translateDomainError } from "../services/domain-error-http.shared.ts";
import {
  translateCountError,
  countError,
} from "../services/inventory-count.shared.ts";
import { translateInventoryError } from "../services/inventory-ops.shared.ts";
import { translatePurchasingError } from "../services/purchasing-flow.shared.ts";

// The 409/403/422 table of the stock-count codes as shipped before the shared
// mapping; it must not move.
const COUNT_TABLE = {
  STOCK_COUNT_INVALID_TRANSITION: 409,
  STOCK_COUNT_NOT_PENDING_APPROVAL: 409,
  STOCK_COUNT_SELF_APPROVAL: 403,
  STOCK_COUNT_BLIND_HIDDEN: 403,
  STOCK_COUNT_BLIND_USE_SHEET: 409,
  STOCK_COUNT_LOCATION_BUSY: 409,
  STOCK_COUNT_LINES_INCOMPLETE: 422,
  STOCK_COUNT_APPROVAL_UNROUTED: 409,
  STOCK_COUNT_VERSION_MISMATCH: 409,
  STOCK_COUNT_NOT_EDITABLE: 409,
  STOCK_COUNT_COST_MISSING: 422,
  STOCK_COUNT_DECIDER_CANNOT_COUNT: 403,
  STOCK_COUNT_VIEWER_CANNOT_COUNT: 403,
  STOCK_COUNT_APPROVAL_EXPIRED: 409,
} as const;

const INTERNAL_TEXT =
  "internal-detail 0190f3c2-1111-7222-8333-444455556666 SELECT * FROM stock_ledger";

describe("inventory and purchasing error HTTP mapping (legend-ul4s)", () => {
  it("every InventoryError code has a valid status and a safe message", () => {
    for (const code of INVENTORY_ERROR_CODES) {
      expect([403, 404, 409, 422]).toContain(inventoryErrorHttpStatus[code]);
      expect(inventoryErrorMessages[code].length).toBeGreaterThan(0);
    }
    expect(Object.keys(inventoryErrorHttpStatus).sort()).toEqual(
      [...INVENTORY_ERROR_CODES].sort(),
    );
  });

  it("every PurchasingError code has a valid status and a safe message", () => {
    for (const code of PURCHASING_ERROR_CODES) {
      expect([403, 404, 409, 422]).toContain(purchasingErrorHttpStatus[code]);
      expect(purchasingErrorMessages[code].length).toBeGreaterThan(0);
    }
    expect(Object.keys(purchasingErrorHttpStatus).sort()).toEqual(
      [...PURCHASING_ERROR_CODES].sort(),
    );
  });

  it("translateDomainError answers the contract status and code, with a fixed message", () => {
    for (const code of INVENTORY_ERROR_CODES) {
      const result = translateDomainError(
        new InventoryError(code, INTERNAL_TEXT),
      );
      expect(result).toBeInstanceOf(HttpError);
      const http = result as HttpError;
      expect(http.status).toBe(inventoryErrorHttpStatus[code]);
      expect(http.code).toBe(code);
      expect(http.message).toBe(inventoryErrorMessages[code]);
      expect(http.message).not.toContain("internal-detail");
      expect(http.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(http.message).not.toMatch(/select/i);
    }
    for (const code of PURCHASING_ERROR_CODES) {
      const result = translateDomainError(
        new PurchasingError(code, INTERNAL_TEXT),
      );
      expect(result).toBeInstanceOf(HttpError);
      const http = result as HttpError;
      expect(http.status).toBe(purchasingErrorHttpStatus[code]);
      expect(http.code).toBe(code);
      expect(http.message).toBe(purchasingErrorMessages[code]);
      expect(http.message).not.toContain("internal-detail");
      expect(http.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });

  it("no fixed message carries a placeholder or an id", () => {
    for (const message of [
      ...Object.values(inventoryErrorMessages),
      ...Object.values(purchasingErrorMessages),
    ]) {
      expect(message).not.toMatch(/\$\{|undefined|\bnull\b/);
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });

  it("keeps the stock-count status table exactly", () => {
    for (const [code, status] of Object.entries(COUNT_TABLE))
      expect(
        inventoryErrorHttpStatus[code as keyof typeof inventoryErrorHttpStatus],
      ).toBe(status);
    for (const [code, status] of Object.entries(COUNT_TABLE)) {
      const http = translateCountError(
        new InventoryError(code as keyof typeof COUNT_TABLE, INTERNAL_TEXT),
      ) as HttpError;
      expect(http.status).toBe(status);
      expect(http.code).toBe(code);
    }
    // countError keeps the caller's message (built in the service, not a leak).
    const built = countError("STOCK_COUNT_NOT_EDITABLE", "Count is posted.");
    expect([built.status, built.message]).toEqual([409, "Count is posted."]);
  });

  it("keeps the other inventory statuses and fixes the documented ones", () => {
    expect(inventoryErrorHttpStatus.PRODUCTION_INVALID_TRANSITION).toBe(409);
    expect(inventoryErrorHttpStatus.RECIPE_NOT_FOUND).toBe(404);
    expect(inventoryErrorHttpStatus.INSUFFICIENT_STOCK).toBe(409);
    for (const code of [
      "RECIPE_CYCLE",
      "RECIPE_OUTPUT_MISSING",
      "RECIPE_COMPONENT_MISSING",
      "UNIT_COST_MISSING",
      "UOM_CONVERSION_MISSING",
      "PRODUCTION_LOCATION_UNRESOLVED",
    ] as const)
      expect(inventoryErrorHttpStatus[code]).toBe(422);
  });

  it("the three old translators delegate to the shared mapping", () => {
    const purchasing = translatePurchasingError(
      new PurchasingError("SUPPLIER_INACTIVE", INTERNAL_TEXT),
    ) as HttpError;
    expect([purchasing.status, purchasing.code]).toEqual([
      409,
      "SUPPLIER_INACTIVE",
    ]);
    expect(purchasing.message).toBe(purchasingErrorMessages.SUPPLIER_INACTIVE);
    const inventory = translateInventoryError(
      new InventoryError("RECIPE_NOT_FOUND", INTERNAL_TEXT),
    ) as HttpError;
    expect([inventory.status, inventory.code]).toEqual([
      404,
      "RECIPE_NOT_FOUND",
    ]);
    expect(inventory.message).not.toContain("internal-detail");
  });

  it("passes non-domain errors through unchanged", () => {
    const plain = new Error("boom");
    const http = new HttpError(418, "TEAPOT", "short and stout");
    const range = new RangeError("too big");
    for (const error of [plain, http, range, "text", null, undefined, 42]) {
      expect(translateDomainError(error)).toBe(error);
      expect(translateInventoryError(error)).toBe(error);
      expect(translatePurchasingError(error)).toBe(error);
      expect(translateCountError(error)).toBe(error);
    }
  });
});
