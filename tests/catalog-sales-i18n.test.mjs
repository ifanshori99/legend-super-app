// Catalog sales hold text contract (bead legend-10nex): every catalogSales key
// resolves to Indonesian text through the real translator, placeholders
// interpolate, and no key comes back raw. Loaded with plain Node ESM like the
// other root contract tests.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MESSAGE_KEYS,
  createTranslator,
} from "../packages/shared/src/i18n/index.ts";
import { catalogSalesMessages } from "../packages/shared/src/i18n/messages/ws02-catalog-sales.ts";

const t = createTranslator();
const keys = Object.keys(catalogSalesMessages).map((k) => `catalogSales.${k}`);

describe("catalog sales text (legend-10nex)", () => {
  test("every catalogSales key is registered and resolves", () => {
    assert.ok(keys.length === 25);
    for (const key of keys) {
      assert.ok(MESSAGE_KEYS.includes(key), `${key} is not a catalog key`);
      const value = t(key);
      assert.notEqual(value, key, `${key} does not resolve`);
      assert.ok(value.trim().length > 0, `${key} is empty`);
    }
  });

  test("placeholders interpolate and leave no raw braces", () => {
    assert.equal(
      t("catalogSales.sinceLine", { time: "08:15" }),
      "Terakhir tersinkron sejak 08:15.",
    );
    assert.equal(
      t("catalogSales.overrideTitle", { until: "17:00" }),
      "Penjualan diizinkan owner sampai 17:00",
    );
    assert.match(t("catalogSales.reasonTooShort", { min: 3 }), /minimal 3 /);
    assert.match(
      t("catalogSales.reasonTooLong", { max: 500 }),
      /maksimal 500 /,
    );
  });

  test("only the known placeholders appear in the source text", () => {
    const allowed = new Set(["time", "until", "min", "max"]);
    for (const [key, text] of Object.entries(catalogSalesMessages))
      for (const match of text.matchAll(/\{(\w+)\}/g))
        assert.ok(allowed.has(match[1]), `${key} has {${match[1]}}`);
  });

  test("the unreadable-database and promo-off copy is in place", () => {
    assert.equal(
      t("catalogSales.unavailableTitle"),
      "Penjualan ditahan: database lokal edge belum bisa dibaca",
    );
    assert.equal(
      t("catalogSales.unavailableHint"),
      "Hubungi teknisi. Penjualan dibuka lagi otomatis setelah sistem pulih.",
    );
    assert.match(
      t("catalogSales.promoOffNotice"),
      /^Promo dan voucher dimatikan/,
    );
    assert.ok(t("catalogSales.clockRegressedTitle").length > 0);
  });
});
