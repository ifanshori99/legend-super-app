// POS order cart logic (sub-539-u1, legend-59v / legend-76t): the pure cart
// functions behind the kasir and captain carts. Money rules: subtotal is an
// integer rupiah, unit = base price + sum of modifier deltas, merging lines
// never changes the total, a hold never changes the total, quantity is 1..99.
// Written from docs/briefs/sub-539-u1.md only (fail-first, no implementation).
//
// Why a .mjs under tests/ and not features/ws04-pos-order/*.test.ts with vitest:
// apps/web has no vitest, and `pnpm test` only runs node:test files in tests/
// (scripts/test.mjs). Same pattern as ws04-pos-kasir-mock-engine.test.mjs.
//
// Assumptions where the brief is silent:
// - CartLine.unitPriceIdr is the BASE price (item.priceIdr); cartTotals adds
//   the modifier deltas ("unit = priceIdr + sum priceDeltaIdr").
// - heldCount counts held LINES (tested only with quantity 1 held lines).
// - validateModifiers: a group with required=true needs at least max(min, 1)
//   selected options of that group; missingGroupIds keep the group order.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addLine,
  cartTotals,
  removeLine,
  setQuantity,
  toggleHold,
  validateModifiers,
} from "../apps/web/src/features/ws04-pos-order/cart-logic.ts";

const course1 = { id: "course-1", label: "Course 1", order: 1 };
const drinks = { id: "course-drink", label: "Minuman", order: 3 };

const opt = (id, name, priceDeltaIdr = 0) => ({ id, name, priceDeltaIdr });
const pedasGroup = {
  id: "g-pedas",
  name: "Tingkat pedas",
  required: true,
  min: 1,
  max: 1,
  options: [
    opt("o-tidak", "Tidak pedas"),
    opt("o-sedang", "Pedas sedang"),
    opt("o-pedas", "Pedas", 2_000),
  ],
};
const extraGroup = {
  id: "g-extra",
  name: "Tambahan",
  required: false,
  min: 0,
  max: 3,
  options: [opt("o-telur", "Telur", 5_000), opt("o-keju", "Keju", 4_000)],
};

function menuItem(id, priceIdr, extra = {}) {
  return {
    id,
    name: `Menu ${id}`,
    categoryId: "cat-makanan",
    categoryName: "Makanan",
    priceIdr,
    imageUrl: null,
    soldOut: false,
    code: null,
    course: course1,
    modifierGroups: [],
    variants: [],
    ...extra,
  };
}
const nasi = menuItem("nasi", 35_000);
const es = menuItem("es", 18_000, { course: drinks, categoryName: "Minuman" });
const mie = menuItem("mie", 30_000, {
  modifierGroups: [pedasGroup, extraGroup],
});

const sel = (group, option) => ({
  groupId: group.id,
  optionId: option.id,
  name: option.name,
  priceDeltaIdr: option.priceDeltaIdr,
});
const plain = { modifiers: [], note: "", quantity: 1 };

test("addLine creates a draft line from the item (course, name, price, not held)", () => {
  const lines = addLine([], nasi, {
    ...plain,
    quantity: 2,
    note: "tanpa bawang",
  });
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.equal(typeof line.lineId, "string");
  assert.ok(line.lineId.length > 0);
  assert.equal(line.menuItemId, "nasi");
  assert.equal(line.name, nasi.name);
  assert.equal(line.unitPriceIdr, 35_000);
  assert.equal(line.quantity, 2);
  assert.equal(line.note, "tanpa bawang");
  assert.deepEqual(line.course, course1);
  assert.deepEqual(line.modifiers, []);
  assert.equal(line.hold, false);
});

test("addLine does not mutate the input array", () => {
  const before = addLine([], nasi, plain);
  const snapshot = JSON.stringify(before);
  const after = addLine(before, es, plain);
  assert.notEqual(after, before);
  assert.equal(JSON.stringify(before), snapshot);
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});

test("addLine merges into one line when item, modifiers and note are the same", () => {
  const mods = [sel(pedasGroup, pedasGroup.options[1])];
  let lines = addLine([], mie, { modifiers: mods, note: "cepat", quantity: 2 });
  lines = addLine(lines, mie, { modifiers: mods, note: "cepat", quantity: 1 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 3);
  // Merging must not change what is owed: 3 x Rp30.000.
  assert.equal(cartTotals(lines).subtotalIdr, 90_000);
});

test("addLine keeps separate lines for a different item, modifier or note", () => {
  let lines = addLine([], mie, {
    modifiers: [sel(pedasGroup, pedasGroup.options[0])],
    note: "",
    quantity: 1,
  });
  lines = addLine(lines, mie, {
    modifiers: [sel(pedasGroup, pedasGroup.options[2])],
    note: "",
    quantity: 1,
  });
  lines = addLine(lines, mie, {
    modifiers: [sel(pedasGroup, pedasGroup.options[0])],
    note: "tanpa daun bawang",
    quantity: 1,
  });
  lines = addLine(lines, nasi, plain);
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines.map((l) => l.lineId)).size, 4);
});

test("setQuantity updates one line and leaves the others alone", () => {
  let lines = addLine(addLine([], nasi, plain), es, plain);
  const [a, b] = lines;
  const next = setQuantity(lines, a.lineId, 5);
  assert.equal(next.find((l) => l.lineId === a.lineId).quantity, 5);
  assert.equal(next.find((l) => l.lineId === b.lineId).quantity, 1);
  assert.equal(lines.find((l) => l.lineId === a.lineId).quantity, 1);
});

test("setQuantity of zero or below removes the line", () => {
  const lines = addLine(addLine([], nasi, plain), es, plain);
  const [a, b] = lines;
  const zero = setQuantity(lines, a.lineId, 0);
  assert.deepEqual(
    zero.map((l) => l.lineId),
    [b.lineId],
  );
  const negative = setQuantity(lines, b.lineId, -3);
  assert.deepEqual(
    negative.map((l) => l.lineId),
    [a.lineId],
  );
});

test("setQuantity ignores NaN and a fraction: the line stays as it is", () => {
  const lines = addLine(addLine([], nasi, plain), es, plain);
  const id = lines[0].lineId;
  const withThree = setQuantity(lines, id, 3);
  assert.deepEqual(setQuantity(withThree, id, Number.NaN), withThree);
  assert.deepEqual(setQuantity(withThree, id, 2.5), withThree);
  assert.deepEqual(
    setQuantity(withThree, id, Number.POSITIVE_INFINITY),
    withThree,
  );
  assert.equal(setQuantity(withThree, id, Number.NaN).length, 2);
});

test("setQuantity caps at 99", () => {
  const lines = addLine([], nasi, plain);
  const id = lines[0].lineId;
  assert.equal(setQuantity(lines, id, 99)[0].quantity, 99);
  assert.equal(setQuantity(lines, id, 100)[0].quantity, 99);
  assert.equal(setQuantity(lines, id, 5_000)[0].quantity, 99);
  assert.equal(
    cartTotals(setQuantity(lines, id, 5_000)).subtotalIdr,
    99 * 35_000,
  );
});

test("setQuantity, removeLine and toggleHold ignore an unknown line id", () => {
  const lines = addLine([], nasi, plain);
  assert.deepEqual(setQuantity(lines, "nope", 4), lines);
  assert.deepEqual(removeLine(lines, "nope"), lines);
  assert.deepEqual(toggleHold(lines, "nope"), lines);
});

test("removeLine drops only the chosen line", () => {
  const lines = addLine(addLine([], nasi, plain), es, plain);
  const next = removeLine(lines, lines[0].lineId);
  assert.equal(next.length, 1);
  assert.equal(next[0].menuItemId, "es");
  assert.equal(lines.length, 2);
  assert.deepEqual(removeLine(next, next[0].lineId), []);
});

test("toggleHold flips one line and flips back", () => {
  const lines = addLine(addLine([], nasi, plain), es, plain);
  const [a, b] = lines;
  const held = toggleHold(lines, a.lineId);
  assert.equal(held.find((l) => l.lineId === a.lineId).hold, true);
  assert.equal(held.find((l) => l.lineId === b.lineId).hold, false);
  const back = toggleHold(held, a.lineId);
  assert.equal(back.find((l) => l.lineId === a.lineId).hold, false);
  assert.equal(lines.find((l) => l.lineId === a.lineId).hold, false);
});

test("cartTotals of an empty cart is all zero", () => {
  assert.deepEqual(cartTotals([]), {
    itemCount: 0,
    subtotalIdr: 0,
    heldCount: 0,
  });
});

test("cartTotals: unit is base price plus modifier deltas, times quantity", () => {
  // Mie Rp30.000 + Pedas (+2.000) + Telur (+5.000) = Rp37.000 each, x2 = 74.000.
  let lines = addLine([], mie, {
    modifiers: [
      sel(pedasGroup, pedasGroup.options[2]),
      sel(extraGroup, extraGroup.options[0]),
    ],
    note: "",
    quantity: 2,
  });
  // Es Rp18.000 x3 = 54.000.
  lines = addLine(lines, es, { ...plain, quantity: 3 });
  const totals = cartTotals(lines);
  assert.equal(totals.subtotalIdr, 74_000 + 54_000);
  assert.equal(totals.itemCount, 5);
  assert.equal(totals.heldCount, 0);
});

test("cartTotals is always an integer rupiah and sums exactly", () => {
  const lines = addLine(
    addLine(addLine([], nasi, { ...plain, quantity: 99 }), es, {
      ...plain,
      quantity: 99,
    }),
    mie,
    {
      modifiers: [sel(pedasGroup, pedasGroup.options[2])],
      note: "",
      quantity: 99,
    },
  );
  const { subtotalIdr, itemCount } = cartTotals(lines);
  assert.ok(Number.isInteger(subtotalIdr));
  assert.equal(itemCount, 297);
  assert.equal(subtotalIdr, 99 * 35_000 + 99 * 18_000 + 99 * 32_000);
});

test("cartTotals: a hold changes neither the subtotal nor the item count", () => {
  let lines = addLine([], nasi, { ...plain, quantity: 2 });
  lines = addLine(lines, es, plain);
  const before = cartTotals(lines);
  assert.equal(before.subtotalIdr, 88_000);
  const held = toggleHold(lines, lines[1].lineId);
  const after = cartTotals(held);
  assert.equal(after.subtotalIdr, before.subtotalIdr);
  assert.equal(after.itemCount, before.itemCount);
  assert.equal(after.heldCount, 1);
  // A held line with quantity 3 still counts in full.
  const bigHold = toggleHold(
    setQuantity(lines, lines[0].lineId, 3),
    lines[0].lineId,
  );
  assert.equal(cartTotals(bigHold).subtotalIdr, 3 * 35_000 + 18_000);
  assert.equal(cartTotals(bigHold).itemCount, 4);
});

test("cartTotals follows quantity changes and removal", () => {
  let lines = addLine(addLine([], nasi, plain), es, plain);
  lines = setQuantity(lines, lines[0].lineId, 4);
  assert.equal(cartTotals(lines).subtotalIdr, 4 * 35_000 + 18_000);
  lines = removeLine(lines, lines[0].lineId);
  assert.deepEqual(cartTotals(lines), {
    itemCount: 1,
    subtotalIdr: 18_000,
    heldCount: 0,
  });
});

test("validateModifiers is ok for an item with no modifier groups", () => {
  assert.deepEqual(validateModifiers(nasi, []), { ok: true });
});

test("validateModifiers reports a missing required group", () => {
  assert.deepEqual(validateModifiers(mie, []), {
    ok: false,
    missingGroupIds: ["g-pedas"],
  });
  // An optional group's choice does not satisfy the required one.
  assert.deepEqual(
    validateModifiers(mie, [sel(extraGroup, extraGroup.options[0])]),
    {
      ok: false,
      missingGroupIds: ["g-pedas"],
    },
  );
});

test("validateModifiers passes once the required group has a choice", () => {
  assert.deepEqual(
    validateModifiers(mie, [sel(pedasGroup, pedasGroup.options[0])]),
    {
      ok: true,
    },
  );
  assert.deepEqual(
    validateModifiers(mie, [
      sel(pedasGroup, pedasGroup.options[1]),
      sel(extraGroup, extraGroup.options[1]),
    ]),
    { ok: true },
  );
});

test("validateModifiers lists every missing required group, in group order", () => {
  const sauce = {
    id: "g-saus",
    name: "Saus",
    required: true,
    min: 1,
    max: 1,
    options: [opt("o-bbq", "BBQ"), opt("o-mayo", "Mayo")],
  };
  const item = menuItem("burger", 45_000, {
    modifierGroups: [pedasGroup, extraGroup, sauce],
  });
  assert.deepEqual(validateModifiers(item, []), {
    ok: false,
    missingGroupIds: ["g-pedas", "g-saus"],
  });
  assert.deepEqual(validateModifiers(item, [sel(sauce, sauce.options[0])]), {
    ok: false,
    missingGroupIds: ["g-pedas"],
  });
});

test("validateModifiers needs the group's minimum when it is above one", () => {
  const toppings = {
    id: "g-top",
    name: "Topping",
    required: true,
    min: 2,
    max: 3,
    options: [opt("t1", "A"), opt("t2", "B"), opt("t3", "C")],
  };
  const item = menuItem("pizza", 60_000, { modifierGroups: [toppings] });
  assert.deepEqual(
    validateModifiers(item, [sel(toppings, toppings.options[0])]),
    {
      ok: false,
      missingGroupIds: ["g-top"],
    },
  );
  assert.deepEqual(
    validateModifiers(item, [
      sel(toppings, toppings.options[0]),
      sel(toppings, toppings.options[1]),
    ]),
    { ok: true },
  );
});

test("addLine does not merge into a held line: the fresh one goes to the kitchen now", () => {
  const first = addLine([], nasi, plain);
  const held = toggleHold(first, first[0].lineId);
  const next = addLine(held, nasi, plain);
  assert.equal(next.length, 2);
  assert.equal(next[0].hold, true);
  assert.equal(next[0].quantity, 1);
  assert.equal(next[1].hold, false);
  assert.equal(next[1].quantity, 1);
  // A second fresh add still merges into the not-held line.
  const again = addLine(next, nasi, plain);
  assert.equal(again.length, 2);
  assert.equal(again[1].quantity, 2);
  assert.equal(again[0].quantity, 1);
});

test("validateModifiers rejects the same option twice in one group", () => {
  const item = menuItem("geprek", 30_000, { modifierGroups: [extraGroup] });
  const telur = sel(extraGroup, extraGroup.options[0]);
  const keju = sel(extraGroup, extraGroup.options[1]);
  assert.deepEqual(validateModifiers(item, [telur, keju]), { ok: true });
  assert.deepEqual(validateModifiers(item, [telur, telur]), {
    ok: false,
    missingGroupIds: ["g-extra"],
  });
});
