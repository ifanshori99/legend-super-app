import assert from "node:assert/strict";
import { test } from "node:test";
import * as menu from "../packages/shared/src/menu/index.ts";

test("menu fixtures parse and contain a varied usable catalog", () => {
  const f = menu.cafeLegendMenuFixtures;
  menu.menuFixtureSchema.parse(f);
  assert.ok(f.items.length >= 60);
  assert.ok(new Set(f.items.map((i) => i.categoryId)).size >= 4);
  assert.equal(new Set(f.items.map((i) => i.id)).size, f.items.length);
});

test("modifier bounds and combo allocations reject invalid values", () => {
  const f = menu.cafeLegendMenuFixtures;
  assert.equal(
    menu.modifierGroupSchema.safeParse({
      ...f.modifierGroups[0],
      minSelect: 3,
      maxSelect: 2,
    }).success,
    false,
  );
  assert.equal(
    menu.comboSchema.safeParse({
      ...f.combos[0],
      components: f.combos[0].components.map((c) => ({
        ...c,
        revenueAllocationBp: 100,
      })),
    }).success,
    false,
  );
});

test("prices and outlet availability validate money, dates and limits", () => {
  const f = menu.cafeLegendMenuFixtures;
  assert.equal(
    menu.priceListItemSchema.safeParse({
      ...f.priceListItems[0],
      priceIdr: 1.5,
    }).success,
    false,
  );
  assert.equal(
    menu.availabilitySchema.safeParse({ ...f.availability[0], dailyLimit: -1 })
      .success,
    false,
  );
  assert.equal(
    menu.priceListSchema.safeParse({
      ...f.priceLists[0],
      effectiveFrom: "2026-02-30",
    }).success,
    false,
  );
});

test("86 transitions permit sell out and restore only", () => {
  assert.equal(
    menu.transitionAvailability("available", "sell_out"),
    "sold_out",
  );
  assert.equal(menu.transitionAvailability("sold_out", "restore"), "available");
  assert.throws(() => menu.transitionAvailability("available", "restore"));
  assert.throws(() => menu.transitionAvailability("sold_out", "sell_out"));
});

test("menu event definitions match event catalog entry convention", () => {
  assert.deepEqual(
    menu.menuEventCatalog.map((e) => e.name),
    ["menu.updated", "item.sold_out", "item.restored"],
  );
  for (const event of menu.menuEventCatalog)
    assert.equal(event.workstream, "WS-03");
});
