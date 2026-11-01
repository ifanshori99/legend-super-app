// Pure logic of the QR menu journey (beads legend-2m4, legend-8sh): filters,
// item option rules, guest session storage, order status. Acceptance IDs:
// ORD-01, ORD-04, ORD-05. PRD v1.7 §3 F10.
import assert from "node:assert/strict";
import { test } from "node:test";
import { qrMenuFixtures } from "../packages/shared/src/qr-order/index.ts";
import {
  EMPTY_FILTER,
  countItems,
  filterMenu,
  isFiltering,
  menuLabels,
  normalizeSearch,
} from "../apps/web/src/features/ws03-qr-order/lib/menu-filter.ts";
import {
  emptySelection,
  hasPriceRange,
  previewLineTotal,
  toggleModifier,
  validateSelection,
} from "../apps/web/src/features/ws03-qr-order/lib/item-options.ts";
import {
  clearGuestSession,
  deviceHash,
  readGuestSession,
  sessionTokenFor,
  writeGuestSession,
} from "../apps/web/src/features/ws03-qr-order/lib/guest-session.ts";
import {
  guestItemStatus,
  minutesUntil,
  orderProgress,
} from "../apps/web/src/features/ws03-qr-order/lib/status.ts";

const menu = qrMenuFixtures.indoor;
const byName = (name) => menu.items.find((item) => item.name === name);

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    size: () => data.size,
  };
}

test("ORD-01 search ignores case and accents and matches name or description", () => {
  assert.equal(normalizeSearch("  Café   LATTÉ "), "cafe latte");
  const names = (q) =>
    filterMenu(menu, { ...EMPTY_FILTER, q }).flatMap((s) =>
      s.items.map((i) => i.name),
    );
  assert.ok(names("CAPPUCCINO").includes("Cappuccino"));
  assert.ok(names("gula aren").includes("Kopi Susu Aren"));
  assert.deepEqual(names("zzzz-tidak-ada"), []);
  assert.equal(isFiltering(EMPTY_FILTER), false);
  assert.equal(isFiltering({ ...EMPTY_FILTER, q: " " }), false);
  assert.equal(isFiltering({ ...EMPTY_FILTER, q: "a" }), true);
});

test("ORD-01 category and label filters combine and a label filter needs every label", () => {
  const all = filterMenu(menu, EMPTY_FILTER);
  assert.equal(all.length, menu.categories.length);
  assert.equal(countItems(all), menu.items.length);
  const kopi = menu.categories.find((c) => c.name === "Kopi");
  const only = filterMenu(menu, { ...EMPTY_FILTER, category: kopi.id });
  assert.equal(only.length, 1);
  assert.equal(only[0].category.id, kopi.id);
  const spicy = filterMenu(menu, {
    ...EMPTY_FILTER,
    labels: ["pedas"],
  }).flatMap((s) => s.items);
  assert.ok(spicy.length > 0 && spicy.every((i) => i.labels.includes("pedas")));
  const both = filterMenu(menu, {
    ...EMPTY_FILTER,
    labels: ["pedas", "terlaris"],
  }).flatMap((s) => s.items);
  assert.ok(
    both.every(
      (i) => i.labels.includes("pedas") && i.labels.includes("terlaris"),
    ),
  );
  assert.ok(both.length < spicy.length);
  assert.ok(menuLabels(menu).includes("terlaris"));
});

test("ORD-05 sold-out items stay listed but sink below orderable ones", () => {
  for (const section of filterMenu(menu, EMPTY_FILTER)) {
    const firstSoldOut = section.items.findIndex(
      (i) => i.status === "sold_out",
    );
    if (firstSoldOut === -1) continue;
    assert.ok(
      section.items.slice(firstSoldOut).every((i) => i.status === "sold_out"),
    );
  }
  const dapur = filterMenu(menu, { ...EMPTY_FILTER, q: "sup buntut" });
  assert.equal(dapur[0].items[0].status, "sold_out");
});

test("ORD-01 a required variant and min/max modifier rules gate the add button", () => {
  const item = menu.items.find(
    (i) =>
      i.variants.length > 0 && i.modifierGroups.some((g) => g.minSelect > 0),
  );
  const sugar = item.modifierGroups.find((g) => g.minSelect > 0);
  const empty = validateSelection(item, emptySelection());
  assert.ok(empty.some((e) => e.code === "variant_required"));
  assert.ok(
    empty.some((e) => e.code === "modifier_min" && e.groupId === sugar.id),
  );
  let selection = { ...emptySelection(), variantId: item.variants[0].id };
  selection = toggleModifier(item, selection, sugar.id, sugar.modifiers[0].id);
  assert.deepEqual(validateSelection(item, selection), []);
  // A single-choice group swaps the choice instead of exceeding the maximum.
  selection = toggleModifier(item, selection, sugar.id, sugar.modifiers[1].id);
  assert.deepEqual(
    selection.modifierIds.filter((id) =>
      sugar.modifiers.some((m) => m.id === id),
    ),
    [sugar.modifiers[1].id],
  );
  // Tapping the chosen one again clears it, and the minimum fails again.
  selection = toggleModifier(item, selection, sugar.id, sugar.modifiers[1].id);
  assert.ok(
    validateSelection(item, selection).some((e) => e.code === "modifier_min"),
  );
});

test("ORD-01 a multi-choice group ignores a tap past its maximum", () => {
  const item = menu.items.find((i) =>
    i.modifierGroups.some((g) => g.maxSelect > 1),
  );
  const group = item.modifierGroups.find((g) => g.maxSelect > 1);
  const open = group.modifiers.filter((m) => !m.soldOut);
  let selection = {
    ...emptySelection(),
    variantId: item.variants[0]?.id ?? null,
  };
  const sugar = item.modifierGroups.find((g) => g.minSelect > 0 && g !== group);
  if (sugar)
    selection = toggleModifier(
      item,
      selection,
      sugar.id,
      sugar.modifiers[0].id,
    );
  for (const modifier of open)
    selection = toggleModifier(item, selection, group.id, modifier.id);
  const chosen = selection.modifierIds.filter((id) =>
    group.modifiers.some((m) => m.id === id),
  );
  assert.equal(chosen.length, Math.min(group.maxSelect, open.length));
  assert.deepEqual(validateSelection(item, selection), []);
});

test("ORD-05 a sold-out item or modifier is never a valid selection", () => {
  const soldOut = menu.items.find((i) => i.status === "sold_out");
  assert.ok(
    validateSelection(soldOut, emptySelection()).some(
      (e) => e.code === "item_sold_out",
    ),
  );
  const item = menu.items.find((i) =>
    i.modifierGroups.some((g) => g.modifiers.some((m) => m.soldOut)),
  );
  const group = item.modifierGroups.find((g) =>
    g.modifiers.some((m) => m.soldOut),
  );
  const modifier = group.modifiers.find((m) => m.soldOut);
  const selection = {
    ...emptySelection(),
    variantId: item.variants[0]?.id ?? null,
    modifierIds: [modifier.id],
  };
  assert.ok(
    validateSelection(item, selection).some(
      (e) => e.code === "modifier_sold_out",
    ),
  );
});

test("ORD-03 the price preview adds variant, modifiers and quantity but is only a preview", () => {
  const item = menu.items.find(
    (i) =>
      i.variants.length > 1 && i.modifierGroups.some((g) => g.maxSelect > 1),
  );
  const topping = item.modifierGroups
    .find((g) => g.maxSelect > 1)
    .modifiers.find((m) => m.priceIdr > 0 && !m.soldOut);
  const variant = item.variants[1];
  const selection = {
    ...emptySelection(),
    variantId: variant.id,
    modifierIds: [topping.id],
    quantity: 3,
  };
  assert.equal(
    previewLineTotal(item, selection),
    (variant.priceIdr + topping.priceIdr) * 3,
  );
  assert.equal(
    hasPriceRange(item),
    new Set(item.variants.map((v) => v.priceIdr)).size > 1,
  );
  assert.equal(
    validateSelection(item, { ...selection, quantity: 100 }).some(
      (e) => e.code === "quantity_invalid",
    ),
    true,
  );
  assert.equal(
    validateSelection(item, { ...selection, note: "x".repeat(201) }).some(
      (e) => e.code === "note_too_long",
    ),
    true,
  );
  assert.ok(byName("Espresso"));
});

test("ORD-04 the guest credential is per QR token, expires, and is dropped when cleared", () => {
  const storage = memoryStorage();
  const stored = {
    qrToken: "v1.token",
    sessionId: "s1",
    sessionToken: "st_abc",
    sessionTokenExpiresAt: new Date(2_000_000).toISOString(),
    participantId: null,
    pax: 2,
    outcome: "opened",
  };
  writeGuestSession(storage, stored);
  assert.equal(
    readGuestSession(storage, "v1.token", 1_000_000)?.sessionId,
    "s1",
  );
  assert.equal(readGuestSession(storage, "v1.other", 1_000_000), null);
  assert.equal(sessionTokenFor(storage, "s1", 1_000_000), "st_abc");
  assert.equal(sessionTokenFor(storage, "s2", 1_000_000), null);
  // Past its hard expiry the credential is gone and the table QR opens a new session.
  assert.equal(readGuestSession(storage, "v1.token", 3_000_000), null);
  assert.equal(sessionTokenFor(storage, "s1", 3_000_000), null);
  assert.equal(storage.size(), 0);
  writeGuestSession(storage, stored);
  clearGuestSession(storage, "v1.token");
  assert.equal(readGuestSession(storage, "v1.token", 1_000_000), null);
  assert.equal(sessionTokenFor(storage, "s1", 1_000_000), null);
});

test("ORD-04 a corrupt stored session is treated as no session", () => {
  const storage = memoryStorage();
  storage.setItem("legend-qr-session:v1.token", "{not json");
  assert.equal(readGuestSession(storage, "v1.token", 1), null);
  storage.setItem(
    "legend-qr-session:v1.token",
    JSON.stringify({ sessionId: 1 }),
  );
  assert.equal(readGuestSession(storage, "v1.token", 1), null);
});

test("ORD-01 the device hash is stable across reloads and well formed", () => {
  const storage = memoryStorage();
  const first = deviceHash(
    storage,
    () => "ABCDEF12-3456-4789-8abc-def012345678",
  );
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(
    deviceHash(storage, () => "00000000-0000-4000-8000-000000000000"),
    first,
  );
  storage.setItem("legend-qr-device", "garbage");
  assert.notEqual(
    deviceHash(storage, () => "11111111-2222-4333-8444-555555555555"),
    "garbage",
  );
});

test("ORD-01 item status maps to the four guest steps and the order is done when all are delivered", () => {
  assert.deepEqual(
    ["queued", "in_progress", "ready", "served", "voided"].map(guestItemStatus),
    ["received", "preparing", "ready", "delivered", "voided"],
  );
  const order = (...s) => ({ items: s.map((status) => ({ status })) });
  assert.equal(orderProgress(order("served", "served")).done, true);
  assert.equal(orderProgress(order("served", "voided")).total, 1);
  const mixed = orderProgress(
    order("queued", "in_progress", "ready", "served"),
  );
  assert.deepEqual(
    [mixed.received, mixed.preparing, mixed.ready, mixed.delivered, mixed.done],
    [1, 1, 1, 1, false],
  );
  assert.equal(orderProgress(order()).done, false);
  assert.equal(minutesUntil(null, 0), null);
  assert.equal(
    minutesUntil(
      "2026-11-01T05:10:00.000Z",
      Date.parse("2026-11-01T05:12:00.000Z"),
    ),
    0,
  );
  assert.equal(
    minutesUntil(
      "2026-11-01T05:10:30.000Z",
      Date.parse("2026-11-01T05:10:00.000Z"),
    ),
    1,
  );
});
