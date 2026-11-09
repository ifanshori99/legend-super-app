// Inventory error catalog text contract (bead legend-tk7i): every inventory
// error code resolves to Indonesian text through the real translator, never the
// raw code. Mirrors tests/access-i18n.test.mjs. Loaded with plain Node ESM.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INVENTORY_ERROR_CODES } from "../packages/shared/src/inventory/errors.ts";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";

const t = createTranslator();

describe("inventory error catalog text (legend-tk7i)", () => {
  test("WASTE_MEDIA_NOT_FOUND is a registered inventory error code", () => {
    assert.ok(INVENTORY_ERROR_CODES.includes("WASTE_MEDIA_NOT_FOUND"));
  });

  test("every INVENTORY_ERROR_CODE has a user-facing Indonesian message", () => {
    assert.ok(INVENTORY_ERROR_CODES.length > 0);
    for (const code of INVENTORY_ERROR_CODES) {
      const key = `inventory.error.${code}`;
      assert.ok(MESSAGE_KEYS.includes(key), `${key} is not a catalog key`);
      const value = t(key);
      assert.notEqual(value, key, `${key} does not resolve`);
      assert.notEqual(value, code, `${code} is raw text`);
      assert.ok(value.trim().length > 0, `${key} is empty`);
    }
  });
});
