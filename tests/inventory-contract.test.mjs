// Inventory, recipe and HPP contract tests (bead legend-p38).
// PRD v1.7 §16 (Inventori & Gudang), §17 (Resep, Produksi & HPP), §6.E.
// Acceptance criteria: INV-01..INV-05 (contract level), TEN-02/TEN-03 for the
// endpoint input schemas.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as events from "../packages/shared/src/events/index.ts";
import * as inventory from "../packages/shared/src/inventory/index.ts";
import {
  decimal4,
  divideRounded,
  extendCostIdr,
  formatDecimal4,
  parseDecimal4,
} from "../packages/shared/src/core/index.ts";

const fixtures = inventory.cafeLegendInventoryFixtures;
const itemByName = (name) => {
  const found = fixtures.items.find((item) => item.name === name);
  assert.ok(found, `fixture item "${name}" is missing`);
  return found;
};
const recipeByName = (name) => {
  const found = fixtures.recipes.find((recipe) => recipe.name === name);
  assert.ok(found, `fixture recipe "${name}" is missing`);
  return found;
};
const uomId = (code) => {
  const found = fixtures.uoms.find((uom) => uom.code === code);
  assert.ok(found, `fixture uom "${code}" is missing`);
  return found.id;
};
const balanceFor = (inventoryItemId, locationId) =>
  fixtures.balances.find(
    (balance) =>
      balance.inventoryItemId === inventoryItemId &&
      balance.locationId === locationId,
  );

/** Weighted moving-average unit cost per item, from the folded balances. */
const weightedUnitCosts = () => {
  const costs = new Map();
  for (const item of fixtures.items) {
    let quantity = 0n;
    let value = 0n;
    for (const balance of fixtures.balances) {
      if (balance.inventoryItemId !== item.id) continue;
      const rowQuantity = parseDecimal4(balance.quantity);
      if (rowQuantity <= 0n) continue;
      quantity += rowQuantity;
      value += rowQuantity * parseDecimal4(balance.avgCostIdr);
    }
    costs.set(
      item.id,
      quantity === 0n
        ? formatDecimal4(0n)
        : formatDecimal4(divideRounded(value, quantity, "half_up")),
    );
  }
  return costs;
};

/** Cost book with semi-finished unit costs derived from their own recipes. */
const costBook = () => {
  const unitCosts = weightedUnitCosts();
  const book = {
    recipes: fixtures.recipes,
    recipeLines: fixtures.recipeLines,
    items: fixtures.items,
    conversions: fixtures.uomConversions,
    unitCosts,
  };
  for (const name of ["Sirup Gula Aren", "Cold Brew Concentrate"]) {
    const recipe = recipeByName(name);
    const cost = inventory.theoreticalRecipeCost(book, recipe.id, "half_up");
    unitCosts.set(recipe.outputItemId, cost.unitCostIdr);
  }
  return book;
};

test("INV-01 stock fixtures parse and the ledger derives every balance (PRD §16 Kartu Stok, §6.E)", () => {
  inventory.inventoryFixtureSchema.parse(fixtures);
  assert.ok(fixtures.items.length >= 20);
  assert.ok(fixtures.locations.length >= 6);
  assert.equal(
    new Set(fixtures.items.map((item) => item.id)).size,
    fixtures.items.length,
  );
  assert.equal(
    new Set(fixtures.ledger.map((entry) => entry.movementType)).size,
    inventory.STOCK_MOVEMENT_TYPES.length,
  );

  const folded = inventory.foldStockLedger(fixtures.ledger, "half_up");
  const key = (balance) => `${balance.locationId}:${balance.inventoryItemId}`;
  const derived = new Map(folded.map((balance) => [key(balance), balance]));
  assert.equal(folded.length, fixtures.balances.length);
  for (const balance of fixtures.balances) {
    const row = derived.get(key(balance));
    assert.ok(row, `missing derived balance ${key(balance)}`);
    assert.equal(row.quantity, balance.quantity);
    assert.equal(row.avgCostIdr, balance.avgCostIdr);
  }

  const posted = fixtures.stockCounts.find(
    (count) => count.status === "posted",
  );
  const adjustments = fixtures.ledger.filter(
    (entry) => entry.movementType === "adjustment",
  );
  assert.ok(adjustments.length >= 1);
  for (const adjustment of adjustments) {
    assert.equal(adjustment.sourceType, "stock_count");
    assert.equal(adjustment.sourceId, posted.id);
  }
  // Append-only: the contract offers no ledger update schema or endpoint.
  assert.equal(inventory.updateStockLedgerEntryInputSchema, undefined);
  assert.equal(
    fixtures.ledger.some(
      (entry) =>
        entry.movementType === "adjustment" &&
        entry.sourceType !== "stock_count",
    ),
    false,
  );
});

test("INV-01 ledger sign and source pair rules reject illegal rows (PRD §6.E stock_ledger)", () => {
  const receipt = fixtures.ledger.find(
    (entry) => entry.movementType === "receipt",
  );
  const posted = fixtures.stockCounts.find(
    (count) => count.status === "posted",
  );

  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...receipt,
      quantity: "-1.0000",
    }).success,
    false,
  );
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...receipt,
      movementType: "sale",
      quantity: "1.0000",
      sourceType: "order",
    }).success,
    false,
  );
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...receipt,
      movementType: "adjustment",
      quantity: "-0.1000",
      sourceType: "order",
    }).success,
    false,
  );
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...receipt,
      quantity: "0.0000",
    }).success,
    false,
  );
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...receipt,
      movementType: "adjustment",
      quantity: "-0.1000",
      sourceType: "stock_count",
      sourceId: posted.id,
    }).success,
    true,
  );
  const purchaseReturn = fixtures.ledger.find(
    (entry) => entry.sourceType === "purchase_return",
  );
  assert.equal(
    inventory.stockLedgerEntrySchema.safeParse({
      ...purchaseReturn,
      quantity: "1.0000",
    }).success,
    true,
    "a restocked sales return is stock in",
  );
});

test("INV-02 UOM conversions walk both directions and short chains (PRD §16 Item & Satuan)", () => {
  const coffee = itemByName("Kopi Arabika Gayo");
  const coffeeConversions = fixtures.uomConversions.filter(
    (conversion) => conversion.inventoryItemId === coffee.id,
  );
  assert.equal(
    inventory.convertQuantity(
      decimal4("1.0000"),
      uomId("kg"),
      uomId("g"),
      coffeeConversions,
    ),
    "1000.0000",
  );
  assert.equal(
    inventory.convertQuantity(
      decimal4("1000.0000"),
      uomId("g"),
      uomId("kg"),
      coffeeConversions,
    ),
    "1.0000",
  );

  const cup = itemByName("Cup 16oz");
  const cupConversions = fixtures.uomConversions.filter(
    (conversion) => conversion.inventoryItemId === cup.id,
  );
  assert.equal(
    inventory.convertQuantity(
      decimal4("1.0000"),
      uomId("pack"),
      uomId("pcs"),
      cupConversions,
    ),
    "50.0000",
  );
  assert.equal(
    inventory.convertQuantity(
      decimal4("1.0000"),
      uomId("pcs"),
      uomId("pack"),
      cupConversions,
    ),
    "0.0200",
  );

  assert.throws(
    () =>
      inventory.convertQuantity(
        decimal4("1.0000"),
        uomId("kg"),
        uomId("ml"),
        coffeeConversions,
      ),
    (error) =>
      error instanceof inventory.InventoryError &&
      error.code === "UOM_CONVERSION_MISSING",
  );

  const tenantId = fixtures.items[0].tenantId;
  const synthetic = [
    [
      "00000000-0000-4000-8000-0000000000a1",
      "00000000-0000-4000-8000-0000000000a2",
      "2.0000",
    ],
    [
      "00000000-0000-4000-8000-0000000000a2",
      "00000000-0000-4000-8000-0000000000a3",
      "3.0000",
    ],
  ].map(([from, to, factor], index) =>
    inventory.uomConversionSchema.parse({
      id: `00000000-0000-4000-8000-0000000000b${index + 1}`,
      tenantId,
      inventoryItemId: coffee.id,
      fromUomId: from,
      toUomId: to,
      factor,
    }),
  );
  assert.equal(
    inventory.convertQuantity(
      decimal4("2.0000"),
      "00000000-0000-4000-8000-0000000000a1",
      "00000000-0000-4000-8000-0000000000a3",
      synthetic,
    ),
    "12.0000",
  );
});

test("INV-02 nested recipes cost every line and INV-04 follows ingredient cost (PRD §17 Resep Bertingkat, HPP Menu)", () => {
  const book = costBook();
  for (const recipe of fixtures.recipes) {
    const cost = inventory.theoreticalRecipeCost(book, recipe.id, "half_up");
    assert.equal(cost.unitCostIdr, recipe.theoreticalCostIdr, recipe.name);
    assert.ok(Number(cost.unitCostIdr) > 0, recipe.name);
  }

  const coffee = itemByName("Kopi Arabika Gayo");
  const kopiSusu = recipeByName("Kopi Susu Aren");
  const before = inventory.theoreticalRecipeCost(book, kopiSusu.id, "half_up");
  const expensive = new Map(book.unitCosts);
  expensive.set(
    coffee.id,
    formatDecimal4(parseDecimal4(book.unitCosts.get(coffee.id)) * 2n),
  );
  const after = inventory.theoreticalRecipeCost(
    { ...book, unitCosts: expensive },
    kopiSusu.id,
    "half_up",
  );
  assert.ok(
    Number(after.unitCostIdr) > Number(before.unitCostIdr),
    "a costlier ingredient must raise the theoretical HPP",
  );

  const coldBrew = recipeByName("Cold Brew Legendaris");
  const concentrate = recipeByName("Cold Brew Concentrate");
  const nested = inventory.theoreticalRecipeCost(book, coldBrew.id, "half_up");
  const direct = inventory.theoreticalRecipeCost(
    book,
    concentrate.id,
    "half_up",
  );
  assert.ok(nested.totalCostIdr > 0);
  assert.ok(
    Number(nested.unitCostIdr) < Number(direct.unitCostIdr) * 0.2,
    "60 ml of concentrate must cost far less than a full litre",
  );

  const cup = itemByName("Cup 16oz");
  const recipeA = inventory.recipeSchema.parse({
    ...kopiSusu,
    id: "00000000-0000-4000-8000-0000000000c1",
    name: "Cycle A",
    outputItemId: cup.id,
    yieldQuantity: "1.0000",
    yieldUomId: uomId("pcs"),
    theoreticalCostIdr: "0.0000",
  });
  const recipeB = inventory.recipeSchema.parse({
    ...recipeA,
    id: "00000000-0000-4000-8000-0000000000c2",
    name: "Cycle B",
  });
  const cycleLines = [
    ["00000000-0000-4000-8000-0000000000d1", recipeA.id, recipeB.id],
    ["00000000-0000-4000-8000-0000000000d2", recipeB.id, recipeA.id],
  ].map(([id, recipeId, componentId]) =>
    inventory.recipeLineSchema.parse({
      id,
      tenantId: kopiSusu.tenantId,
      recipeId,
      componentType: "recipe",
      componentId,
      quantity: "1.0000",
      uomId: uomId("pcs"),
      wastePctBp: 0,
    }),
  );
  assert.throws(
    () =>
      inventory.theoreticalRecipeCost(
        {
          recipes: [recipeA, recipeB],
          recipeLines: cycleLines,
          items: fixtures.items,
          conversions: fixtures.uomConversions,
          unitCosts: book.unitCosts,
        },
        recipeA.id,
        "half_up",
      ),
    (error) => error.code === "RECIPE_CYCLE",
  );

  const withoutOutput = inventory.recipeSchema.parse({
    ...recipeA,
    id: "00000000-0000-4000-8000-0000000000c3",
    name: "No output",
    outputItemId: null,
  });
  const wrapper = inventory.recipeSchema.parse({
    ...recipeA,
    id: "00000000-0000-4000-8000-0000000000c4",
    name: "Wrapper",
    outputItemId: null,
  });
  const wrapperLine = inventory.recipeLineSchema.parse({
    id: "00000000-0000-4000-8000-0000000000d3",
    tenantId: kopiSusu.tenantId,
    recipeId: wrapper.id,
    componentType: "recipe",
    componentId: withoutOutput.id,
    quantity: "1.0000",
    uomId: uomId("pcs"),
    wastePctBp: 0,
  });
  assert.throws(
    () =>
      inventory.theoreticalRecipeCost(
        {
          recipes: [withoutOutput, wrapper],
          recipeLines: [wrapperLine],
          items: fixtures.items,
          conversions: fixtures.uomConversions,
          unitCosts: book.unitCosts,
        },
        wrapper.id,
        "half_up",
      ),
    (error) => error.code === "RECIPE_OUTPUT_MISSING",
  );
});

test("INV-03 stock counts approve and post only through the state machine (PRD §16 Stok Opname)", () => {
  assert.equal(inventory.transitionStockCount("draft", "start"), "counting");
  assert.equal(
    inventory.transitionStockCount("counting", "submit"),
    "pending_approval",
  );
  assert.equal(
    inventory.transitionStockCount("pending_approval", "approve"),
    "approved",
  );
  assert.equal(inventory.transitionStockCount("approved", "post"), "posted");
  assert.equal(
    inventory.transitionStockCount("pending_approval", "reject"),
    "counting",
  );
  assert.equal(inventory.transitionStockCount("draft", "cancel"), "cancelled");
  assert.throws(
    () => inventory.transitionStockCount("draft", "post"),
    (error) => error.code === "STOCK_COUNT_INVALID_TRANSITION",
  );
  assert.throws(
    () => inventory.transitionStockCount("posted", "approve"),
    (error) => error.code === "STOCK_COUNT_INVALID_TRANSITION",
  );

  const pending = fixtures.stockCounts.find(
    (count) => count.status === "pending_approval",
  );
  assert.equal(pending.blind, true);
  assert.doesNotThrow(() =>
    inventory.assertStockCountApproval(
      pending,
      "00000000-0000-4000-8000-000000009999",
    ),
  );
  assert.throws(
    () => inventory.assertStockCountApproval(pending, pending.countedBy),
    (error) => error.code === "STOCK_COUNT_SELF_APPROVAL",
  );
  const approved = fixtures.stockCounts.find(
    (count) => count.status === "posted",
  );
  assert.notEqual(approved.approvedBy, approved.countedBy);
  assert.throws(
    () => inventory.assertStockCountApproval(approved, approved.countedBy),
    (error) => error.code === "STOCK_COUNT_NOT_PENDING_APPROVAL",
  );

  const line = fixtures.stockCountLines.find(
    (row) => row.stockCountId === pending.id,
  );
  assert.ok(line.varianceIdr < 0);
});

test("INV-04 menu HPP rows carry a coherent cost and gross margin (PRD §17 HPP Menu)", () => {
  for (const cost of fixtures.menuCosts) {
    if (!cost.recipeComplete) {
      assert.equal(cost.recipeId, null);
      assert.equal(cost.theoreticalCostIdr, null);
      assert.equal(cost.grossMarginBp, null);
      continue;
    }
    assert.ok(Number(cost.theoreticalCostIdr) > 0);
    assert.equal(
      cost.grossMarginBp,
      inventory.grossMarginBp(
        cost.priceIdr,
        cost.theoreticalCostIdr,
        "half_up",
      ),
    );
  }
  assert.ok(fixtures.menuCosts.some((cost) => cost.recipeComplete));
  assert.ok(fixtures.menuCosts.some((cost) => !cost.recipeComplete));

  const kopi = recipeByName("Kopi Susu Aren");
  assert.equal(
    inventory.recipeCostChangedEventPayloadSchema.safeParse({
      recipeId: kopi.id,
      version: kopi.version,
      previousTheoreticalCostIdr: "9800.0000",
      theoreticalCostIdr: kopi.theoreticalCostIdr,
      updatedAt: kopi.updatedAt,
    }).success,
    true,
  );
  assert.equal(
    inventory.recipeCostChangedEventPayloadSchema.safeParse({
      recipeId: kopi.id,
      version: kopi.version,
      previousTheoreticalCostIdr: null,
      theoreticalCostIdr: "-1.0000",
      updatedAt: kopi.updatedAt,
    }).success,
    false,
  );
});

test("INV-05 completed production posts the actual output and its cost (PRD §17 Produksi Batch)", () => {
  assert.equal(
    inventory.transitionProductionOrder("draft", "start"),
    "in_progress",
  );
  assert.equal(
    inventory.transitionProductionOrder("in_progress", "complete"),
    "completed",
  );
  assert.equal(
    inventory.transitionProductionOrder("in_progress", "cancel"),
    "cancelled",
  );
  assert.throws(
    () => inventory.transitionProductionOrder("draft", "complete"),
    (error) => error.code === "PRODUCTION_INVALID_TRANSITION",
  );
  assert.throws(
    () => inventory.transitionProductionOrder("completed", "cancel"),
    (error) => error.code === "PRODUCTION_INVALID_TRANSITION",
  );

  for (const order of fixtures.productionOrders) {
    assert.equal(order.status, "completed");
    const inflow = fixtures.ledger.find(
      (entry) =>
        entry.movementType === "production_in" && entry.sourceId === order.id,
    );
    assert.ok(inflow, `production_in for ${order.id}`);
    assert.equal(inflow.quantity, order.actualQty);
    assert.equal(
      extendCostIdr(inflow.quantity, inflow.unitCostIdr, "half_up"),
      order.costIdr,
    );
  }
  const completed = fixtures.productionOrders[0];
  assert.equal(
    inventory.productionOrderSchema.safeParse({
      ...completed,
      costIdr: null,
    }).success,
    false,
  );
  assert.equal(
    inventory.productionOrderSchema.safeParse({
      ...completed,
      completedAt: null,
    }).success,
    false,
  );
});

test("PRD §16 par levels: location override wins and critical stock is detectable", () => {
  const coffee = itemByName("Kopi Arabika Gayo");
  const coffeePar = fixtures.parLevels.find(
    (par) => par.inventoryItemId === coffee.id,
  );
  const coffeeBalance = balanceFor(coffee.id, coffeePar.locationId);
  assert.ok(coffeeBalance);
  assert.equal(
    inventory.parStatus(coffeeBalance.quantity, coffeePar),
    "below_min",
  );

  const milk = itemByName("Susu UHT Full Cream");
  assert.deepEqual(inventory.effectiveParLevel(milk), {
    parMin: "20.0000",
    parMax: "60.0000",
  });
  assert.deepEqual(
    inventory.effectiveParLevel(milk, {
      parMin: "24.0000",
      parMax: "72.0000",
    }),
    { parMin: "24.0000", parMax: "72.0000" },
  );
  assert.equal(
    inventory.parStatus("14.0000", inventory.effectiveParLevel(milk)),
    "below_min",
  );

  const cup = itemByName("Cup 16oz");
  const cupPar = fixtures.parLevels.find(
    (par) => par.inventoryItemId === cup.id,
  );
  const cupBalance = balanceFor(cup.id, cupPar.locationId);
  assert.equal(inventory.parStatus(cupBalance.quantity, cupPar), "within");
  assert.equal(inventory.effectiveParLevel(coffee), null);
});

test("PRD §16 batches warn before expiry and FEFO puts dairy first (Batch & Kedaluwarsa)", () => {
  const milkA = fixtures.batches.find(
    (batch) => batch.batchCode === "SUSU-1101-A",
  );
  const milkB = fixtures.batches.find(
    (batch) => batch.batchCode === "SUSU-1101-B",
  );
  const coffeeBatch = fixtures.batches.find(
    (batch) => batch.batchCode === "ROAST-1101",
  );
  assert.equal(
    inventory.batchExpiryStatus(milkA, "2026-11-01", 3),
    "expiring_soon",
  );
  assert.equal(
    inventory.batchExpiryStatus(
      { ...milkA, expiresOn: "2026-10-31" },
      "2026-11-01",
      3,
    ),
    "expired",
  );
  assert.equal(
    inventory.batchExpiryStatus({ ...milkA, expiresOn: null }, "2026-11-01", 3),
    "no_expiry",
  );
  assert.equal(inventory.batchExpiryStatus(milkB, "2026-11-01", 3), "fresh");
  assert.equal(
    inventory.batchExpiryStatus(
      { ...milkB, expiresOn: "2026-11-20" },
      "2026-11-01",
      3,
    ),
    "fresh",
  );
  assert.throws(
    () => inventory.batchExpiryStatus(milkA, "2026-11-01", -1),
    RangeError,
  );

  const ordered = inventory.fefoSort([milkB, coffeeBatch, milkA]);
  assert.deepEqual(
    ordered.map((batch) => batch.id),
    [milkA.id, milkB.id, coffeeBatch.id],
  );
});

test("PRD §17 food cost variance is explained and menu engineering classes are typed", () => {
  const [comparison] = fixtures.foodCostComparisons;
  assert.equal(
    comparison.varianceIdr,
    comparison.actualCostIdr - comparison.theoreticalCostIdr,
  );
  assert.equal(
    comparison.varianceIdr,
    comparison.wasteIdr +
      comparison.adjustmentIdr +
      comparison.offRecipeUsageIdr,
  );
  assert.equal(
    comparison.varianceBp,
    Math.round(
      (comparison.varianceIdr * 10_000) / comparison.theoreticalCostIdr,
    ),
  );

  for (const row of fixtures.menuEngineering) {
    assert.ok(inventory.menuEngineeringRowSchema.safeParse(row).success);
    const cost = fixtures.menuCosts.find(
      (rowCost) => rowCost.menuItemId === row.menuItemId,
    );
    assert.ok(cost?.recipeComplete);
    assert.equal(
      row.grossMarginIdr,
      cost.priceIdr - Math.round(Number(cost.theoreticalCostIdr)),
    );
  }
  assert.ok(
    fixtures.menuEngineering.some((row) => row.classification === "star"),
  );
  assert.ok(
    fixtures.menuEngineering.some((row) => row.classification === "dog"),
  );
});

test("WS-06 inventory events are registered once and their payloads validate (PRD §3 Kontrak Bersama)", () => {
  const names = inventory.inventoryEventCatalogEntries.map(
    (entry) => entry.name,
  );
  assert.deepEqual(names, [
    "stock.moved",
    "stock.critical",
    "recipe.cost_changed",
  ]);
  for (const entry of inventory.inventoryEventCatalogEntries) {
    assert.equal(entry.workstream, "WS-06");
    assert.equal(entry.version, 1);
    assert.equal(entry.payloadSchemaRef, `${entry.name}.v1`);
    assert.ok(
      events.eventCatalog.some((catalog) => catalog.name === entry.name),
      `${entry.name} is missing from the WS-00 catalog`,
    );
  }

  const receipt = fixtures.ledger.find(
    (entry) => entry.movementType === "receipt",
  );
  assert.equal(
    inventory.stockMovedEventPayloadSchema.safeParse({
      ledgerEntryId: receipt.id,
      inventoryItemId: receipt.inventoryItemId,
      locationId: receipt.locationId,
      movementType: receipt.movementType,
      quantity: receipt.quantity,
      unitCostIdr: receipt.unitCostIdr,
      batchId: receipt.batchId,
      sourceType: receipt.sourceType,
      sourceId: receipt.sourceId,
      occurredAt: receipt.occurredAt,
    }).success,
    true,
  );

  const coffeePar = fixtures.parLevels[0];
  assert.equal(
    inventory.stockCriticalEventPayloadSchema.safeParse({
      inventoryItemId: coffeePar.inventoryItemId,
      locationId: coffeePar.locationId,
      quantity: "7.8000",
      parMin: coffeePar.parMin,
      detectedAt: "2026-11-01T09:00:00.000Z",
    }).success,
    true,
  );

  const kopi = recipeByName("Kopi Susu Aren");
  const envelope = inventory.inventoryEventSchema.parse({
    ...events.eventFixture,
    name: "stock.moved",
    aggregateType: "stock",
    payloadSchemaRef: "stock.moved.v1",
  });
  assert.equal(envelope.name, "stock.moved");
  assert.equal(
    inventory.inventoryEventSchema.safeParse({
      ...events.eventFixture,
      name: "payment.paid",
      aggregateType: "payment",
    }).success,
    false,
  );

  assert.equal(
    inventory.recipeCostChangedEventPayloadSchema.safeParse({
      recipeId: kopi.id,
      version: kopi.version,
      previousTheoreticalCostIdr: kopi.theoreticalCostIdr,
      theoreticalCostIdr: kopi.theoreticalCostIdr,
      updatedAt: kopi.updatedAt,
    }).success,
    true,
  );
});

test("inventory endpoints are unique and write inputs reject tenant fields (TEN-02, TEN-03)", () => {
  const ids = inventory.inventoryEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of inventory.inventoryEndpoints) {
    assert.ok(endpoint.path.startsWith("/api/inventory/"), endpoint.path);
    const hasPathParam = endpoint.path
      .split("/")
      .some((part) => part.startsWith(":"));
    if (hasPathParam) assert.ok(endpoint.params, `${endpoint.id} params`);
  }

  const item = fixtures.items[0];
  const validItem = {
    name: "Bahan Baru",
    category: "Bahan Kering",
    type: "raw_material",
    baseUomId: uomId("kg"),
    isPerishable: false,
    idempotencyKey: "fixture-item-0001",
  };
  assert.equal(
    inventory.createInventoryItemInputSchema.safeParse(validItem).success,
    true,
  );
  assert.equal(
    inventory.createInventoryItemInputSchema.safeParse({
      ...validItem,
      tenantId: item.tenantId,
    }).success,
    false,
  );
  assert.equal(
    inventory.updateInventoryItemInputSchema.safeParse({
      name: "Nama Baru",
    }).success,
    false,
    "the optimistic lock timestamp is required",
  );

  const outletId = fixtures.locations[0].outletId;
  assert.equal(inventory.stockLedgerQuerySchema.safeParse({}).success, false);
  assert.equal(
    inventory.stockLedgerQuerySchema.safeParse({ outletId }).success,
    true,
  );

  assert.equal(
    inventory.transitionProductionOrderInputSchema.safeParse({
      action: "complete",
      idempotencyKey: "fixture-production-0001",
    }).success,
    false,
  );
  assert.equal(
    inventory.transitionProductionOrderInputSchema.safeParse({
      action: "complete",
      actualQty: "4.8000",
      idempotencyKey: "fixture-production-0001",
    }).success,
    true,
  );

  assert.equal(
    inventory.createRecipeInputSchema.safeParse({
      brandId: fixtures.recipes[0].brandId,
      name: "Resep Baru",
      yieldQuantity: "1.0000",
      yieldUomId: uomId("pcs"),
      lines: [
        {
          componentType: "item",
          componentId: item.id,
          quantity: "10.0000",
          uomId: uomId("g"),
          wastePctBp: 0,
        },
      ],
      idempotencyKey: "fixture-recipe-0001",
    }).success,
    true,
  );
});
