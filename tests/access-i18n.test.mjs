// Access catalog text contract (bead legend-svza): every access error code,
// permission code, permission module and role template resolves to Indonesian
// text through the real translator. The translator walks nested objects, so
// these tests prove the dotted paths actually resolve (not just that a key
// exists in the source object). Loaded with plain Node ESM like the other root
// contract tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ACCESS_ERROR_CODES,
  PERMISSION_CATALOG,
  ROLE_TEMPLATE_KEYS,
} from "../packages/shared/src/access/index.ts";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";

const t = createTranslator();

function assertCatalogText(key) {
  assert.ok(MESSAGE_KEYS.includes(key), `${key} is not a catalog key`);
  const value = t(key);
  assert.notEqual(value, key, `${key} does not resolve`);
  assert.ok(value.trim().length > 0, `${key} is empty`);
}

describe("access catalog text (legend-svza)", () => {
  test("every ACCESS_ERROR_CODE has a user-facing Indonesian message", () => {
    assert.equal(ACCESS_ERROR_CODES.length, 14);
    for (const code of ACCESS_ERROR_CODES) {
      assertCatalogText(`access.error.${code}`);
      assert.notEqual(t(`access.error.${code}`), code, `${code} is raw text`);
    }
  });

  test("every PERMISSION_CATALOG code has an Indonesian label", () => {
    assert.ok(PERMISSION_CATALOG.length >= 140);
    for (const { code } of PERMISSION_CATALOG)
      assertCatalogText(`access.permission.${code}`);
  });

  test("every permission module has an Indonesian name", () => {
    const modules = new Set(PERMISSION_CATALOG.map((entry) => entry.module));
    for (const module of modules) assertCatalogText(`access.module.${module}`);
  });

  test("every role template has a one-line purpose hint", () => {
    assert.equal(ROLE_TEMPLATE_KEYS.length, 18);
    for (const key of ROLE_TEMPLATE_KEYS)
      assertCatalogText(`access.templateHint.${key}`);
  });

  test("the existing access.perm.* keys still resolve to the same labels", () => {
    for (const { code } of PERMISSION_CATALOG)
      assert.equal(t(`access.perm.${code}`), t(`access.permission.${code}`));
  });
});
