import assert from "node:assert/strict";
import { test } from "node:test";
import * as core from "../packages/shared/src/core/index.ts";
import * as inventory from "../packages/shared/src/inventory/index.ts";
import * as lib from "../apps/web/src/features/ws06-inventory/stock-lib.ts";

// Acceptance tests for the WS-06 stock-control screens (legend-vxj; PRD v1.7
// §16 "Inventori & Gudang", INV-01, AI-08). The joins and derivations under
// test are the ones the screens render; contract invariants are imported.

const fixtures = inventory.cafeLegendInventoryFixtures;
const { balances, parLevels, items, locations, uoms, batches, ledger } =
  fixtures;

const parInput = { balances, parLevels, items, locations, uoms };

test("legend-vxj · INV-01 ledger rows keep the append-only source and value", () => {
  const rows = lib.ledgerRows({ ledger, items, locations, batches, uoms });
  assert.equal(rows.length, ledger.length);
  const row = rows[0];
  assert.ok(row.item);
  assert.ok(row.location);
  assert.equal(row.unit, "kg");

  // Quantity sign is the movement direction (PRD §6.E); value is quantity x
  // unit cost in whole rupiah.
  assert.equal(
    lib.movementDirection(row.entry),
    row.entry.movementType === "sale" ? "out" : "in",
  );
  assert.equal(
    lib.ledgerLineValueIdr(row.entry),
    core.extendCostIdr(row.entry.quantity, row.entry.unitCostIdr, "half_up"),
  );
  assert.equal(
    lib.formatSignedQuantity(row.entry.quantity).startsWith("+"),
    true,
  );

  // The contract has no ledger update: zero rows and wrong directions fail.
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...row.entry,
      quantity: "0.0000",
    }).success,
    false,
  );
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...row.entry,
      movementType: "sale",
      quantity: "2.0000",
    }).success,
    false,
  );
  assert.equal("updateStockLedgerEntry" in inventory, false);
});

test("legend-vxj · F16 par levels use the location override and stocked pairs", () => {
  const rows = lib.parRows(parInput);
  // Two explicit par_levels rows plus the item default at the two locations
  // that actually hold the item (a default alone does not make every location
  // below par).
  assert.equal(rows.length, 4);

  const kopi = rows.find((row) => row.item.id === fixtures.items[0].id);
  assert.equal(kopi?.explicit, true);
  assert.equal(kopi?.status, "below_min");
  assert.equal(kopi?.location?.name, "Gudang Utama");

  const susu = rows.filter((row) => row.item.name === "Susu UHT Full Cream");
  assert.equal(susu.length, 2);
  assert.deepEqual(susu.map((row) => row.location?.name).sort(), [
    "Bar",
    "Chiller Bar",
  ]);
  assert.equal(
    susu.every((row) => row.status === "below_min"),
    true,
  );

  const cup = rows.find((row) => row.item.name === "Cup 16oz");
  assert.equal(cup?.status, "within");
});

test("legend-vxj · F16 critical alerts order below-min pairs by severity", () => {
  const alerts = lib.criticalRows(lib.parRows(parInput));
  assert.equal(alerts.length, 3);
  assert.deepEqual(
    alerts.map((row) => [row.item.name, row.location?.name]),
    [
      ["Susu UHT Full Cream", "Bar"],
      ["Susu UHT Full Cream", "Chiller Bar"],
      ["Kopi Arabika Gayo", "Gudang Utama"],
    ],
  );
});

test("legend-vxj · AI-08 purchase suggestions refill each pair to par max", () => {
  const suggestions = lib.purchaseSuggestions(lib.parRows(parInput));
  assert.equal(suggestions.length, 3);
  assert.deepEqual(
    suggestions.map((row) => [row.item.name, row.suggestedQty]),
    [
      ["Susu UHT Full Cream", "51.9000"],
      ["Susu UHT Full Cream", "46.0000"],
      ["Kopi Arabika Gayo", "22.2000"],
    ],
  );
  // Every suggestion is a positive Decimal4 the draft PR can submit.
  for (const row of suggestions) {
    assert.equal(
      inventory.positiveDecimal4Schema.safeParse(row.suggestedQty).success,
      true,
    );
  }
});

test("legend-vxj · F16 expiry applies the warning window and FEFO order", () => {
  const rows = lib.expiryRows(
    { batches, items, locations, uoms },
    "2026-11-02",
    7,
  );
  assert.deepEqual(
    rows.map((row) => [row.fefoRank, row.batch.batchCode, row.status]),
    [
      [1, "SUSU-1101-A", "expiring_soon"],
      [2, "AYAM-1101", "expiring_soon"],
      [3, "SUSU-1101-B", "expiring_soon"],
      [4, "CB-1101", "expiring_soon"],
      [5, "KEJU-1101", "fresh"],
      [6, "ROAST-1101", "no_expiry"],
    ],
  );
  assert.deepEqual(
    lib.attentionBatches(rows).map((row) => row.batch.batchCode),
    ["SUSU-1101-A", "AYAM-1101", "SUSU-1101-B", "CB-1101"],
  );
  assert.equal(lib.closestExpiryBatches(rows).length, 3);

  // A past expiry date is expired, not merely "soon".
  const expired = lib.expiryRows(
    { batches, items, locations, uoms },
    "2026-11-09",
    7,
  );
  assert.equal(
    expired.find((row) => row.batch.batchCode === "SUSU-1101-A")?.status,
    "expired",
  );
});

test("legend-vxj · F16 balances value stock with the location moving average", () => {
  const rows = lib.balanceRows(parInput);
  assert.equal(rows.length, balances.length);
  for (const row of rows) {
    assert.equal(
      row.valueIdr,
      core.extendCostIdr(
        row.balance.quantity,
        row.balance.avgCostIdr,
        "half_up",
      ),
    );
  }
  assert.equal(
    lib.totalStockValueIdr(rows),
    rows.reduce((total, row) => total + row.valueIdr, 0),
  );
});

test("legend-vxj · F16 Q39 business dates and quantities follow the catalog format", () => {
  // 04:30 WIB on 2 Nov is business date 2 Nov; 00:30 WIB is still 1 Nov (Q39).
  assert.equal(
    lib.businessDateToday(new Date("2026-11-01T21:30:00.000Z"), "Asia/Jakarta"),
    "2026-11-02",
  );
  assert.equal(
    lib.businessDateToday(new Date("2026-11-01T17:30:00.000Z"), "Asia/Jakarta"),
    "2026-11-01",
  );
  assert.equal(lib.businessDateOf("2026-11-01T17:30:00.000Z"), "2026-11-01");
  assert.equal(lib.addDays("2026-11-01", 3), "2026-11-04");
  assert.equal(lib.daysBetween("2026-11-01", "2026-11-08"), 7);
  assert.equal(lib.daysBetween("2026-11-08", "2026-11-01"), -7);
  assert.equal(lib.formatQuantity("22.2000"), "22,2");
  assert.equal(lib.formatSignedQuantity("-3.5000"), "−3,5");
  assert.equal(lib.formatBusinessDate("2026-11-01"), "1 Nov 2026");

  const page = lib.listPage(
    Array.from({ length: 25 }, (_, i) => i),
    99,
    20,
  );
  assert.equal(page.page, 2);
  assert.equal(page.rows.length, 5);
});

test("legend-vxj · AI-08 PR lines merge one item short in two locations", () => {
  const milk = { id: "item-milk", baseUomId: "uom-l" };
  const coffee = { id: "item-coffee", baseUomId: "uom-kg" };
  assert.deepEqual(
    lib.purchaseRequestLines([
      { item: milk, suggestedQty: "51.9000" },
      { item: coffee, suggestedQty: "22.2000" },
      { item: milk, suggestedQty: "46.0000" },
    ]),
    [
      { inventoryItemId: "item-milk", quantity: "97.9000", uomId: "uom-l" },
      { inventoryItemId: "item-coffee", quantity: "22.2000", uomId: "uom-kg" },
    ],
  );
});
