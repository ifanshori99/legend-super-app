import assert from "node:assert/strict";
import { test } from "node:test";
import * as menu from "../packages/shared/src/menu/index.ts";
import * as lib from "../apps/web/src/features/ws03-menu/lib.ts";

// Acceptance tests for the menu back office (legend-xx9, legend-dpe).
// Test names carry the bead and the PRD v1.7 §8 clause they cover, because
// these beads list PRD sections instead of numbered acceptance ids.

const fixtures = menu.cafeLegendMenuFixtures;
const item = fixtures.items[0];
const category = fixtures.categories[0];
const availabilityRow = fixtures.availability[0];

test("legend-xx9 · F8 Struktur Menu: item status joins the active flag and 86", () => {
  assert.equal(lib.itemStatus({ isActive: true }, undefined), "available");
  assert.equal(lib.itemStatus({ isActive: false }, undefined), "inactive");
  assert.equal(
    lib.itemStatus({ isActive: true }, { status: "sold_out" }),
    "sold_out",
  );
  // 86 beats the active flag: the item is operational-unavailable right now.
  assert.equal(
    lib.itemStatus({ isActive: false }, { status: "sold_out" }),
    "sold_out",
  );
});

test("legend-xx9 · F8 Konten Menu: admin item shape carries the resolved photo URL", () => {
  const admin = menu.menuItemAdminSchema.parse({
    ...item,
    mediaUrl: "https://cdn.example.test/menu/espresso.jpg",
  });
  assert.equal(admin.mediaId, item.mediaId);
  assert.match(admin.mediaUrl, /^https:\/\//);
  assert.equal(
    menu.menuItemAdminSchema.safeParse({ ...item, mediaUrl: 42 }).success,
    false,
  );
});

test("legend-xx9 · F8 Konten Menu: image upload input bounds type and size", () => {
  const valid = {
    fileName: "espresso.jpg",
    contentType: "image/jpeg",
    dataBase64: "AAAA",
    width: 1200,
    height: 800,
  };
  assert.equal(menu.menuImageUploadInputSchema.safeParse(valid).success, true);
  assert.equal(
    menu.menuImageUploadInputSchema.safeParse({
      ...valid,
      contentType: "image/gif",
    }).success,
    false,
  );
  assert.equal(
    menu.menuImageUploadInputSchema.safeParse({
      ...valid,
      dataBase64: "not base64!!",
    }).success,
    false,
  );
});

test("legend-xx9 · F8 Struktur Menu: display order moves a row and renumbers the list", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(lib.reorderIds(ids, "d", "b"), ["a", "d", "b", "c"]);
  assert.equal(lib.reorderIds(ids, "a", "a"), null);
  assert.equal(lib.reorderIds(ids, "a", "zzz"), null);

  const rows = [
    { id: "a", sortOrder: 0 },
    { id: "b", sortOrder: 1 },
    { id: "c", sortOrder: 2 },
  ];
  const ordered = lib.applyDisplayOrder(
    rows,
    ["c", "a", "b"],
    (row) => row.id,
    (row, sortOrder) => ({ ...row, sortOrder }),
  );
  assert.deepEqual(
    ordered.map((row) => row.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    ordered.map((row) => row.sortOrder),
    [0, 1, 2],
  );
  assert.equal(lib.nextSortOrder(rows), 3);
});

test("legend-xx9 · F8 Struktur Menu: item rows join category, availability and price", () => {
  const rows = lib.itemRows({
    items: [menu.menuItemAdminSchema.parse({ ...item, mediaUrl: null })],
    categories: [category],
    availability: [availabilityRow],
    priceListItems: fixtures.priceListItems.filter(
      (row) => row.itemId === item.id && row.variantId === null,
    ),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category?.name, "Kopi");
  assert.equal(rows[0].status, availabilityRow.status);
  assert.equal(typeof rows[0].priceIdr, "number");

  const filtered = lib.filterItemRows(rows, { search: "espresso" });
  assert.equal(filtered.length, 1);
  assert.equal(lib.filterItemRows(rows, { search: "zzz" }).length, 0);
});

test("legend-xx9 · F8 Struktur Menu: item list query defaults to display order", () => {
  const query = menu.itemListQuerySchema.parse({});
  assert.equal(query.sort, "display");
  assert.equal(query.limit, 25);
  assert.equal(
    menu.itemListQuerySchema.safeParse({ sort: "price" }).success,
    false,
  );
});

test("legend-dpe · F8 Harga per Kanal: latest effective list on or before today wins", () => {
  const lists = [
    { channel: "dine_in", effectiveFrom: "2026-01-01" },
    { channel: "dine_in", effectiveFrom: "2026-11-01" },
    { channel: "dine_in", effectiveFrom: "2027-01-01" },
    { channel: "takeaway", effectiveFrom: "2026-12-01" },
  ];
  assert.equal(
    lib.effectivePriceList(lists, "dine_in", "2026-11-01")?.effectiveFrom,
    "2026-11-01",
  );
  assert.equal(
    lib.effectivePriceList(lists, "dine_in", "2026-10-31")?.effectiveFrom,
    "2026-01-01",
  );
  assert.equal(
    lib.effectivePriceList(lists, "takeaway", "2026-11-01"),
    undefined,
  );
});

test("legend-dpe · F8 Harga per Kanal: the price grid rejects fractional rupiah", () => {
  assert.equal(
    menu.setPriceListItemsInputSchema.safeParse({
      items: [{ itemId: item.id, priceIdr: 25000 }],
    }).success,
    true,
  );
  assert.equal(
    menu.setPriceListItemsInputSchema.safeParse({
      items: [{ itemId: item.id, priceIdr: 25000.5 }],
    }).success,
    false,
  );
  assert.equal(
    menu.setPriceListItemsInputSchema.safeParse({
      items: [{ itemId: item.id, priceIdr: -1 }],
    }).success,
    false,
  );
});

test("legend-dpe · F8 Paket & Combo: revenue allocation must total exactly 100%", () => {
  const components = [
    {
      menuItemId: fixtures.items[0].id,
      options: [],
      revenueAllocationBp: 6000,
    },
    {
      menuItemId: fixtures.items[45].id,
      options: [],
      revenueAllocationBp: 4000,
    },
  ];
  assert.equal(lib.allocationIsValid(components), true);
  assert.equal(lib.totalAllocationBp(components), 10000);
  assert.equal(
    lib.allocationIsValid([
      { ...components[0], revenueAllocationBp: 6000 },
      { ...components[1], revenueAllocationBp: 3999 },
    ]),
    false,
  );
  assert.equal(lib.percentToBp(60), 6000);
  assert.equal(lib.percentToBp(33.33), 3333);
  assert.equal(lib.percentToBp(140), 10000);
  assert.equal(lib.bpToPercent(3333), 33.33);
  assert.equal(
    menu.createComboInputSchema.safeParse({
      comboItemId: fixtures.items.at(-1).id,
      components: [{ ...components[0], revenueAllocationBp: 10000 }],
    }).success,
    true,
  );
  assert.equal(
    menu.updateComboInputSchema.safeParse({
      components: [{ ...components[0], revenueAllocationBp: 5000 }],
    }).success,
    false,
  );
});

test("legend-dpe · F8 Ketersediaan: schedules and daily limits validate", () => {
  const schedule = {
    daysOfWeek: [0, 1, 2],
    start: "08:00",
    end: "11:00",
  };
  assert.equal(
    menu.updateAvailabilityInputSchema.safeParse({
      schedule: [schedule],
      dailyLimit: 20,
    }).success,
    true,
  );
  assert.equal(
    menu.updateAvailabilityInputSchema.safeParse({
      schedule: [{ ...schedule, daysOfWeek: [] }],
    }).success,
    false,
  );
  assert.equal(
    menu.updateAvailabilityInputSchema.safeParse({ dailyLimit: -1 }).success,
    false,
  );
  assert.equal(
    menu.updateAvailabilityInputSchema.safeParse({ dailyLimit: null }).success,
    true,
  );

  const labels = {
    noSchedule: "Tanpa jadwal",
    everyDay: "Setiap hari",
    days: {
      0: "Min",
      1: "Sen",
      2: "Sel",
      3: "Rab",
      4: "Kam",
      5: "Jum",
      6: "Sab",
    },
  };
  assert.equal(lib.describeSchedule([], labels), "Tanpa jadwal");
  assert.equal(
    lib.describeSchedule([schedule], labels),
    "Min, Sen, Sel · 08:00–11:00",
  );
  assert.match(
    lib.describeSchedule(
      [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "12:00" }],
      labels,
    ),
    /^Setiap hari/,
  );
});

test("legend-dpe · F8 Ketersediaan: 86 only moves between available and sold out", () => {
  assert.equal(
    menu.transitionAvailability("available", "sell_out"),
    "sold_out",
  );
  assert.equal(menu.transitionAvailability("sold_out", "restore"), "available");
  assert.throws(() => menu.transitionAvailability("available", "restore"));
  assert.throws(() => menu.transitionAvailability("sold_out", "sell_out"));

  // A retried broadcast must carry the same idempotency key (PRD §8: the 86
  // status is broadcast to every sales channel).
  assert.equal(
    menu.availabilityActionInputSchema.safeParse({ action: "sell_out" })
      .success,
    false,
  );
  assert.equal(
    menu.availabilityActionInputSchema.safeParse({
      action: "sell_out",
      idempotencyKey: "8f1b5e0a-6d6a-4f0f-9a0e-1d2c3b4a5e6f",
    }).success,
    true,
  );
});

test("legend-dpe · F8 Routing Stasiun: items and modifiers point at a station", () => {
  for (const row of fixtures.items)
    assert.ok(row.stationId === null || typeof row.stationId === "string");
  const stationIds = new Set(fixtures.stations.map((station) => station.id));
  for (const row of fixtures.items)
    if (row.stationId) assert.ok(stationIds.has(row.stationId));
  assert.equal(
    menu.createStationInputSchema.safeParse({
      name: "Bar Kopi 2",
      type: "coffee_bar",
    }).success,
    true,
  );
  assert.equal(
    menu.createStationInputSchema.safeParse({
      name: "Bar Kopi 2",
      type: "unknown_bar",
    }).success,
    false,
  );
});

test("TEN-02: menu writes reject a client-supplied tenantId", () => {
  const valid = {
    categoryId: category.id,
    name: "Kopi Susu Baru",
  };
  assert.equal(menu.createItemInputSchema.safeParse(valid).success, true);
  assert.equal(
    menu.createItemInputSchema.safeParse({
      ...valid,
      tenantId: category.tenantId,
    }).success,
    false,
  );
  assert.equal(
    menu.createCategoryInputSchema.safeParse({
      name: "Baru",
      tenantId: category.tenantId,
    }).success,
    false,
  );
});

test("legend-xx9 · F8 Konten Menu: modifier groups enforce min <= max", () => {
  assert.equal(
    menu.createModifierGroupInputSchema.safeParse({
      name: "Tingkat gula",
      minSelect: 1,
      maxSelect: 1,
    }).success,
    true,
  );
  assert.equal(
    menu.createModifierGroupInputSchema.safeParse({
      name: "Tingkat gula",
      minSelect: 3,
      maxSelect: 2,
    }).success,
    false,
  );
  assert.equal(
    menu.updateModifierGroupInputSchema.safeParse({
      minSelect: 3,
      maxSelect: 2,
    }).success,
    false,
    "an update that sends both bounds is checked too",
  );
  assert.equal(
    menu.updateModifierGroupInputSchema.safeParse({ maxSelect: 2 }).success,
    true,
  );
  assert.equal(
    menu.createModifierInputSchema.safeParse({ name: "Normal" }).success,
    true,
  );
  assert.equal(
    menu.createModifierInputSchema.safeParse({
      name: "Extra shot",
      priceIdr: 0.5,
    }).success,
    false,
  );
});

test("legend-xx9 · F8 Struktur Menu: display-order bodies need a known id list", () => {
  assert.equal(
    menu.reorderInputSchema.safeParse({ orderedIds: [item.id] }).success,
    true,
  );
  assert.equal(
    menu.reorderInputSchema.safeParse({ orderedIds: [] }).success,
    false,
  );
  assert.equal(
    menu.reorderInputSchema.safeParse({ orderedIds: ["not-a-uuid"] }).success,
    false,
  );
  assert.equal(
    menu.setItemModifierGroupsInputSchema.safeParse({ groupIds: [] }).success,
    true,
  );
});
