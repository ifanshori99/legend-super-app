// POS order mock engine (sub-539-u1, legend-59v / legend-76t): the in-memory
// "server" behind VITE_API_MOCK for the kasir catalog/orders/parked drafts and
// the captain tables, table orders and service calls. Written from
// docs/briefs/sub-539-u1.md only (fail-first, no implementation).
// Money rules: order subtotal is the integer sum of unit x quantity (+ modifier
// deltas); a hold never changes the subtotal; firing only flips status; adding
// to a table session adds exactly the added amount; parking creates no order.
//
// The brief fixes the hooks and fixtures but not the engine's method names, so
// every engine call goes through `api()` below, which assumes the kasir pattern
// (features/ws04-pos-kasir/mock-engine.ts): `createPosOrderEngine({ clock,
// readSeed, scenario })` exported from mock-engine.ts, synchronous methods named
// after the hooks, errors thrown as ApiError. If D names things differently,
// change ONLY the adapter.
//
// Assumptions where the brief is silent:
// - CartLine.unitPriceIdr is the base price; modifier deltas are added on top.
// - Empty `lines` is rejected with ApiError EMPTY_ORDER (422); an unknown id with
//   ApiError NOT_FOUND. The engine takes positional ids (fireLines(orderId,
//   lineIds), resumeDraft(id), ...) and an idempotency key on submitOrder and
//   addToTable (the hooks create it); the adapter below supplies a fresh one.
// - `?demo=gagal` fails reads in the request wrapper `runPosOrderMock(...,
//   "query")`, not in the synchronous engine, so it is tested through that.
// - Resolving a call clears the table's open-call flag (hasOpenCall).
// - `?demo=memuat` (query never settles) is a hook-level behaviour and not
//   covered here; the engine is synchronous.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import {
  createPosOrderEngine,
  runPosOrderMock,
} from "../apps/web/src/features/ws04-pos-order/mock-engine.ts";

let keySeq = 0;
const freshKey = () => `key-${(keySeq += 1)}`;

function api(seed = null) {
  const time = { now: 1_700_000_000_000 };
  const e = createPosOrderEngine({
    clock: () => time.now,
    readSeed: () => seed,
  });
  return {
    time,
    catalog: () => e.catalog(),
    connectivity: () => e.connectivity(),
    nextCallNumber: () => e.nextCallNumber(),
    submitOrder: (input) =>
      e.submitOrder({ idempotencyKey: freshKey(), ...input }),
    fireLines: (input) => e.fireLines(input.orderId, input.lineIds),
    parked: () => e.parkedDrafts(),
    park: (input) => e.parkDraft(input),
    resume: (input) => e.resumeDraft(input.id),
    tables: () => e.captainTables(),
    tableOrder: (tableId) => e.tableOrder(tableId),
    addToTable: (input) =>
      e.addToTable({ idempotencyKey: freshKey(), ...input }),
    fireTableLines: (input) => e.fireTableLines(input.tableId, input.lineIds),
    calls: () => e.serviceCalls(),
    acknowledge: (input) => e.acknowledgeCall(input.id),
    resolve: (input) => e.resolveCall(input.id),
  };
}

const code = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    return error.code;
  }
  assert.fail("expected an ApiError");
};

// ---- helpers --------------------------------------------------------------

let seq = 0;
function line(
  item,
  quantity,
  { hold = false, modifiers = [], note = "" } = {},
) {
  seq += 1;
  return {
    lineId: `line-${seq}`,
    menuItemId: item.id,
    variantId: null,
    variantName: null,
    name: item.name,
    unitPriceIdr: item.priceIdr,
    quantity,
    modifiers,
    note,
    course: item.course,
    hold,
  };
}
const unit = (l) =>
  l.unitPriceIdr + l.modifiers.reduce((sum, m) => sum + m.priceDeltaIdr, 0);
const sum = (lines) => lines.reduce((s, l) => s + unit(l) * l.quantity, 0);

/** Orderable items without a required modifier group, cheapest-first stable. */
function plainItems(catalog) {
  return catalog.items.filter(
    (i) => !i.soldOut && !i.modifierGroups.some((g) => g.required),
  );
}

// ---- catalog fixtures -----------------------------------------------------

test("catalog: categories Makanan, Minuman and Camilan; live; consistent items", () => {
  const catalog = api().catalog();
  assert.deepEqual(
    catalog.categories.map((c) => c.name),
    ["Makanan", "Minuman", "Camilan"],
  );
  assert.equal(catalog.source, "live");
  assert.ok(!Number.isNaN(Date.parse(catalog.updatedAt)));
  assert.ok(catalog.items.length >= 6);
  for (const item of catalog.items) {
    const category = catalog.categories.find((c) => c.id === item.categoryId);
    assert.ok(category, `item ${item.name} has an unknown category`);
    assert.equal(item.categoryName, category.name);
    assert.ok(Number.isInteger(item.priceIdr) && item.priceIdr > 0);
    assert.ok(item.course.label.length > 0);
    for (const group of item.modifierGroups)
      for (const option of group.options)
        assert.ok(Number.isInteger(option.priceDeltaIdr));
  }
  assert.equal(
    new Set(catalog.items.map((i) => i.id)).size,
    catalog.items.length,
  );
});

test("catalog: one sold-out item and one item with the required 'Tingkat pedas' group", () => {
  const { items } = api().catalog();
  assert.ok(
    items.some((i) => i.soldOut),
    "a sold-out item",
  );
  const spicy = items.find((i) =>
    i.modifierGroups.some((g) => g.name === "Tingkat pedas"),
  );
  assert.ok(spicy, "an item with Tingkat pedas");
  const group = spicy.modifierGroups.find((g) => g.name === "Tingkat pedas");
  assert.equal(group.required, true);
  assert.deepEqual(
    group.options.map((o) => o.name),
    ["Tidak pedas", "Pedas sedang", "Pedas"],
  );
  assert.ok(items.some((i) => !i.soldOut && i.modifierGroups.length === 0));
});

test("connectivity: online by default, edge only with cached catalog (14.08) for ?demo=offline", () => {
  const normal = api();
  assert.equal(normal.connectivity().mode, "online");
  assert.equal(normal.catalog().source, "live");

  const offline = api("offline");
  const connectivity = offline.connectivity();
  assert.equal(connectivity.mode, "edge_only");
  assert.ok(connectivity.catalogUpdatedAt);
  assert.ok(!Number.isNaN(Date.parse(connectivity.catalogUpdatedAt)));
  const catalog = offline.catalog();
  assert.equal(catalog.source, "cached");
  assert.ok(catalog.items.length > 0, "cached catalog still has items");
});

test("?demo=kosong: empty catalog, tables and service calls", () => {
  const empty = api("kosong");
  const catalog = empty.catalog();
  assert.deepEqual(catalog.items, []);
  assert.deepEqual(catalog.categories, []);
  assert.deepEqual(empty.tables(), []);
  assert.deepEqual(empty.calls(), []);
});

test("?demo=gagal: the queries fail with an ApiError the UI can retry", async () => {
  // The seed is read from the page URL, so give the module a fake page.
  globalThis.window = { location: { search: "?demo=gagal" } };
  try {
    for (const read of [
      (e) => e.catalog(),
      (e) => e.captainTables(),
      (e) => e.serviceCalls(),
    ]) {
      await assert.rejects(runPosOrderMock(read, "query"), (error) => {
        assert.ok(error instanceof ApiError, String(error));
        assert.equal(error.status, 500);
        return true;
      });
    }
  } finally {
    delete globalThis.window;
  }
});

// ---- kasir: call number, submit, fire ---------------------------------------

test("nextCallNumber starts at A-12 and reading it does not consume it", () => {
  const engine = api();
  assert.equal(engine.nextCallNumber(), "A-12");
  assert.equal(engine.nextCallNumber(), "A-12");
});

test("submitOrder: sent lines, held lines, and a subtotal that ignores the hold", () => {
  const engine = api();
  const [a, b, c] = plainItems(engine.catalog());
  const lines = [line(a, 2), line(b, 1, { hold: true }), line(c, 3)];
  const order = engine.submitOrder({
    channel: "takeaway",
    tableSessionId: null,
    ojol: null,
    lines,
  });
  assert.equal(order.channel, "takeaway");
  assert.equal(order.tableLabel, null);
  assert.equal(order.lines.length, 3);
  assert.deepEqual(
    order.lines.map((l) => l.status),
    ["sent", "held", "sent"],
  );
  assert.ok(Number.isInteger(order.subtotalIdr));
  // The held line is still owed: the total is all three lines.
  assert.equal(order.subtotalIdr, sum(lines));
  assert.ok(order.orderId.length > 0);
  assert.ok(order.number.length > 0);
  // The kitchen status field replaces `hold` on order lines.
  for (const l of order.lines) assert.equal("hold" in l, false);
});

test("submitOrder: a takeaway order gets a call number and the counter moves on", () => {
  const engine = api();
  const [a] = plainItems(engine.catalog());
  const first = engine.submitOrder({
    channel: "takeaway",
    tableSessionId: null,
    ojol: null,
    lines: [line(a, 1)],
  });
  assert.equal(first.callNumber, "A-12");
  assert.equal(engine.nextCallNumber(), "A-13");
  const second = engine.submitOrder({
    channel: "takeaway",
    tableSessionId: null,
    ojol: null,
    lines: [line(a, 1)],
  });
  assert.equal(second.callNumber, "A-13");
  assert.notEqual(second.orderId, first.orderId);
});

// An order goes onto an open table session (the table's label is derived).
function seatedTable(engine) {
  const table = engine.tables().find((t) => t.sessionId);
  assert.ok(table, "the demo has a seated table");
  return table;
}

test("submitOrder: dine-in keeps the table label", () => {
  const engine = api();
  const [a] = plainItems(engine.catalog());
  const order = engine.submitOrder({
    channel: "dine_in",
    tableSessionId: seatedTable(engine).sessionId,
    ojol: null,
    lines: [line(a, 1)],
  });
  assert.equal(order.channel, "dine_in");
  assert.equal(order.tableLabel, seatedTable(engine).label);
});

test("submitOrder: a modifier delta is part of the line price in the subtotal", () => {
  const engine = api();
  const catalog = engine.catalog();
  const spicy = catalog.items.find((i) =>
    i.modifierGroups.some((g) => g.name === "Tingkat pedas"),
  );
  const group = spicy.modifierGroups.find((g) => g.name === "Tingkat pedas");
  const option = group.options[1];
  const lines = [
    line(spicy, 2, {
      modifiers: [
        {
          groupId: group.id,
          optionId: option.id,
          name: option.name,
          priceDeltaIdr: option.priceDeltaIdr,
        },
      ],
    }),
  ];
  const order = engine.submitOrder({
    channel: "takeaway",
    tableSessionId: null,
    ojol: null,
    lines,
  });
  assert.equal(order.subtotalIdr, 2 * (spicy.priceIdr + option.priceDeltaIdr));
  assert.equal(order.lines[0].modifiers[0].optionId, option.id);
});

test("submitOrder: an ojol order carries the platform channel", () => {
  const engine = api();
  const [a] = plainItems(engine.catalog());
  const order = engine.submitOrder({
    channel: "ojol_manual",
    tableSessionId: null,
    ojol: { platform: "gofood", externalRef: "GF-123456" },
    lines: [line(a, 1)],
  });
  assert.equal(order.channel, "ojol_manual");
});

test("submitOrder rejects an empty cart", () => {
  const engine = api();
  assert.equal(
    code(() =>
      engine.submitOrder({
        channel: "takeaway",
        tableSessionId: null,
        ojol: null,
        lines: [],
      }),
    ),
    "EMPTY_ORDER",
  );
});

test("fireLines: only the chosen held lines become sent; the subtotal does not move", () => {
  const engine = api();
  const [a, b, c] = plainItems(engine.catalog());
  const lines = [
    line(a, 1, { hold: true }),
    line(b, 2, { hold: true }),
    line(c, 1),
  ];
  const order = engine.submitOrder({
    channel: "dine_in",
    tableSessionId: seatedTable(engine).sessionId,
    ojol: null,
    lines,
  });
  const heldFirst = order.lines[0].lineId;
  const fired = engine.fireLines({
    orderId: order.orderId,
    lineIds: [heldFirst],
  });
  assert.equal(fired.orderId, order.orderId);
  assert.deepEqual(
    fired.lines.map((l) => l.status),
    ["sent", "held", "sent"],
  );
  assert.equal(fired.subtotalIdr, order.subtotalIdr);
  assert.equal(fired.subtotalIdr, sum(lines));
  // Firing the rest, and firing an already sent line again, stays consistent.
  const all = engine.fireLines({
    orderId: order.orderId,
    lineIds: fired.lines.map((l) => l.lineId),
  });
  assert.ok(all.lines.every((l) => l.status === "sent"));
  assert.equal(all.subtotalIdr, order.subtotalIdr);
});

test("fireLines on an unknown order is NOT_FOUND", () => {
  assert.equal(
    code(() => api().fireLines({ orderId: "does-not-exist", lineIds: ["x"] })),
    "NOT_FOUND",
  );
});

// ---- kasir: parked drafts ---------------------------------------------------

test("parked drafts start empty, park keeps lines and subtotal, resume removes", () => {
  const engine = api();
  assert.deepEqual(engine.parked(), []);
  const [a, b] = plainItems(engine.catalog());
  const lines = [line(a, 2), line(b, 1, { hold: true })];
  const parked = engine.park({ channel: "takeaway", lines });
  assert.ok(parked.id.length > 0);
  assert.ok(parked.label.length > 0);
  assert.equal(parked.channel, "takeaway");
  assert.deepEqual(parked.lines, lines);
  assert.equal(parked.subtotalIdr, sum(lines));
  assert.equal(parked.parkedAt, new Date(engine.time.now).toISOString());
  assert.deepEqual(
    engine.parked().map((d) => d.id),
    [parked.id],
  );

  const resumed = engine.resume({ id: parked.id });
  assert.equal(resumed.id, parked.id);
  assert.deepEqual(resumed.lines, lines);
  assert.equal(resumed.subtotalIdr, sum(lines));
  assert.deepEqual(engine.parked(), []);
  // A draft can be resumed once only: never doubles an order.
  assert.equal(
    code(() => engine.resume({ id: parked.id })),
    "NOT_FOUND",
  );
});

test("parking is not an order: no call number is used", () => {
  const engine = api();
  const [a] = plainItems(engine.catalog());
  engine.park({ channel: "takeaway", lines: [line(a, 1)] });
  assert.equal(engine.nextCallNumber(), "A-12");
});

test("two parked drafts are kept apart; resuming one leaves the other", () => {
  const engine = api();
  const [a, b] = plainItems(engine.catalog());
  const first = engine.park({ channel: "takeaway", lines: [line(a, 1)] });
  const second = engine.park({ channel: "dine_in", lines: [line(b, 4)] });
  assert.notEqual(first.id, second.id);
  assert.equal(engine.parked().length, 2);
  engine.resume({ id: first.id });
  assert.deepEqual(
    engine.parked().map((d) => d.id),
    [second.id],
  );
  assert.equal(engine.parked()[0].subtotalIdr, 4 * b.priceIdr);
});

test("parkDraft rejects an empty cart", () => {
  assert.equal(
    code(() => api().park({ channel: "takeaway", lines: [] })),
    "EMPTY_ORDER",
  );
});

// ---- captain: tables --------------------------------------------------------

test("captain tables: A01 to A08 with the demo states", () => {
  const tables = api().tables();
  assert.deepEqual(
    tables.map((t) => t.label),
    ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08"],
  );
  assert.equal(new Set(tables.map((t) => t.id)).size, 8);
  const a01 = tables.find((t) => t.label === "A01");
  assert.equal(a01.status, "occupied");
  assert.equal(a01.guestCount, 4);
  assert.equal(a01.qrSessionActive, true);
  assert.ok(a01.sessionId);
  const a02 = tables.find((t) => t.label === "A02");
  assert.equal(a02.status, "empty");
  assert.equal(a02.seats, 4);
  assert.equal(a02.guestCount, 0);
  assert.equal(a02.qrSessionActive, false);
  assert.equal(a02.sessionId, null);
  assert.equal(tables.find((t) => t.label === "A03").hasOpenCall, true);
  assert.equal(tables.find((t) => t.label === "A02").hasOpenCall, false);
  for (const t of tables) assert.ok(t.zone.length > 0);
});

test("tableOrder: an empty table has no order, an unknown table is NOT_FOUND", () => {
  const engine = api();
  const a02 = engine.tables().find((t) => t.label === "A02");
  const view = engine.tableOrder(a02.id);
  assert.equal(view.table.id, a02.id);
  assert.equal(view.order, null);
  assert.equal(
    code(() => engine.tableOrder("no-such-table")),
    "NOT_FOUND",
  );
});

test("addToTable on the running QR session adds exactly the added amount", () => {
  const engine = api();
  const a01 = engine.tables().find((t) => t.label === "A01");
  const before = engine.tableOrder(a01.id);
  assert.equal(before.table.sessionId, a01.sessionId);
  const beforeLines = before.order?.lines.length ?? 0;
  const beforeSubtotal = before.order?.subtotalIdr ?? 0;
  const [a, b] = plainItems(engine.catalog());
  const added = [line(a, 2), line(b, 1, { hold: true })];
  const after = engine.addToTable({ tableId: a01.id, lines: added });
  assert.equal(after.table.id, a01.id);
  // The same QR session keeps running; no second session is opened.
  assert.equal(after.table.sessionId, a01.sessionId);
  assert.equal(after.order.lines.length, beforeLines + 2);
  assert.equal(after.order.subtotalIdr, beforeSubtotal + sum(added));
  assert.ok(Number.isInteger(after.order.subtotalIdr));
  const newLines = after.order.lines.slice(-2);
  assert.deepEqual(
    newLines.map((l) => l.status),
    ["sent", "held"],
  );
  // What was added is what a re-read shows (no drift between views).
  const reread = engine.tableOrder(a01.id);
  assert.equal(reread.order.subtotalIdr, after.order.subtotalIdr);
  assert.equal(reread.order.lines.length, after.order.lines.length);
});

test("addToTable on an empty table creates the order", () => {
  const engine = api();
  const a02 = engine.tables().find((t) => t.label === "A02");
  const [a] = plainItems(engine.catalog());
  const added = [line(a, 3)];
  const view = engine.addToTable({ tableId: a02.id, lines: added });
  assert.ok(view.order);
  assert.equal(view.order.tableLabel, "A02");
  assert.equal(view.order.subtotalIdr, sum(added));
  assert.equal(view.order.lines.length, 1);
  assert.equal(engine.tableOrder(a02.id).order.subtotalIdr, sum(added));
});

test("addToTable rejects an empty cart and an unknown table", () => {
  const engine = api();
  const a01 = engine.tables().find((t) => t.label === "A01");
  const [a] = plainItems(engine.catalog());
  assert.equal(
    code(() => engine.addToTable({ tableId: a01.id, lines: [] })),
    "EMPTY_ORDER",
  );
  assert.equal(
    code(() =>
      engine.addToTable({ tableId: "no-such-table", lines: [line(a, 1)] }),
    ),
    "NOT_FOUND",
  );
});

test("fireTableLines sends held lines without changing the table total", () => {
  const engine = api();
  const a02 = engine.tables().find((t) => t.label === "A02");
  const [a, b] = plainItems(engine.catalog());
  const added = [line(a, 1, { hold: true }), line(b, 2, { hold: true })];
  const view = engine.addToTable({ tableId: a02.id, lines: added });
  assert.ok(view.order.lines.every((l) => l.status === "held"));
  const total = view.order.subtotalIdr;
  assert.equal(total, sum(added));
  const fired = engine.fireTableLines({
    tableId: a02.id,
    lineIds: [view.order.lines[0].lineId],
  });
  assert.deepEqual(
    fired.order.lines.map((l) => l.status),
    ["sent", "held"],
  );
  assert.equal(fired.order.subtotalIdr, total);
  const rest = engine.fireTableLines({
    tableId: a02.id,
    lineIds: fired.order.lines.map((l) => l.lineId),
  });
  assert.ok(rest.order.lines.every((l) => l.status === "sent"));
  assert.equal(rest.order.subtotalIdr, total);
  assert.equal(
    code(() =>
      engine.fireTableLines({ tableId: "no-such-table", lineIds: ["x"] }),
    ),
    "NOT_FOUND",
  );
});

// ---- captain: service calls -------------------------------------------------

test("service calls: A03 asks for cutlery, new", () => {
  const engine = api();
  const calls = engine.calls();
  const a03 = engine.tables().find((t) => t.label === "A03");
  const call = calls.find((c) => c.tableId === a03.id);
  assert.ok(call, "a call from A03");
  assert.equal(call.tableLabel, "A03");
  assert.equal(call.type, "call_waiter");
  assert.equal(call.reason, "Minta alat makan");
  assert.equal(call.status, "new");
  assert.ok(!Number.isNaN(Date.parse(call.createdAt)));
});

test("acknowledge then resolve moves the call through its statuses", () => {
  const engine = api();
  const [call] = engine.calls();
  const acknowledged = engine.acknowledge({ id: call.id });
  assert.equal(acknowledged.id, call.id);
  assert.equal(acknowledged.status, "acknowledged");
  assert.equal(
    engine.calls().find((c) => c.id === call.id)?.status ?? "acknowledged",
    "acknowledged",
  );
  const resolved = engine.resolve({ id: call.id });
  assert.equal(resolved.id, call.id);
  assert.equal(resolved.status, "resolved");
  // A resolved call is no longer open on the table.
  const open = engine.calls().find((c) => c.id === call.id);
  assert.ok(!open || open.status === "resolved");
  assert.equal(
    engine.tables().find((t) => t.id === call.tableId).hasOpenCall,
    false,
  );
});

test("acknowledge and resolve an unknown call is NOT_FOUND", () => {
  const engine = api();
  assert.equal(
    code(() => engine.acknowledge({ id: "nope" })),
    "NOT_FOUND",
  );
  assert.equal(
    code(() => engine.resolve({ id: "nope" })),
    "NOT_FOUND",
  );
});

// ---- fix 1: duplicates, parking sold-out items, no ghost orders -------------

const modifierOf = (group, option) => ({
  groupId: group.id,
  optionId: option.id,
  name: option.name,
  priceDeltaIdr: option.priceDeltaIdr,
});

function itemWithExtras(catalog) {
  const item = catalog.items.find((i) =>
    i.modifierGroups.some((g) => !g.required && g.max >= 2),
  );
  const group = item.modifierGroups.find((g) => !g.required && g.max >= 2);
  const required = item.modifierGroups.filter((g) => g.required);
  return {
    item,
    group,
    base: required.map((g) => modifierOf(g, g.options[0])),
  };
}

test("a repeated option in one group is refused by order, park and addToTable", () => {
  const engine = api();
  const { item, group, base } = itemWithExtras(engine.catalog());
  const twice = [
    ...base,
    modifierOf(group, group.options[0]),
    modifierOf(group, group.options[0]),
  ];
  const lines = [line(item, 1, { modifiers: twice })];
  assert.equal(
    code(() =>
      engine.submitOrder({
        channel: "takeaway",
        tableSessionId: null,
        ojol: null,
        lines,
      }),
    ),
    "INVALID_MODIFIER",
  );
  assert.equal(
    code(() => engine.park({ channel: "takeaway", lines })),
    "INVALID_MODIFIER",
  );
  const a02 = engine.tables().find((t) => t.label === "A02");
  assert.equal(
    code(() => engine.addToTable({ tableId: a02.id, lines })),
    "INVALID_MODIFIER",
  );
  // Two different options of the group are fine.
  const ok = [
    line(item, 1, {
      modifiers: [
        ...base,
        modifierOf(group, group.options[0]),
        modifierOf(group, group.options[1]),
      ],
    }),
  ];
  assert.ok(
    engine.submitOrder({
      channel: "takeaway",
      tableSessionId: null,
      ojol: null,
      lines: ok,
    }),
  );
});

test("parkDraft keeps a sold-out item aside; the order still refuses it", () => {
  const engine = api();
  const soldOut = engine.catalog().items.find((i) => i.soldOut);
  const lines = [line(soldOut, 1)];
  const parked = engine.park({ channel: "takeaway", lines });
  assert.equal(parked.lines.length, 1);
  assert.equal(parked.lines[0].menuItemId, soldOut.id);
  assert.equal(engine.parked().length, 1);
  assert.equal(
    code(() =>
      engine.submitOrder({
        channel: "takeaway",
        tableSessionId: null,
        ojol: null,
        lines: engine.resume({ id: parked.id }).lines,
      }),
    ),
    "ITEM_SOLD_OUT",
  );
});

test("parkDraft still checks the shape: unknown item and bad quantity are refused", () => {
  const engine = api();
  const [a] = plainItems(engine.catalog());
  assert.equal(
    code(() =>
      engine.park({
        channel: "takeaway",
        lines: [{ ...line(a, 1), menuItemId: "no-such-item" }],
      }),
    ),
    "ITEM_UNAVAILABLE",
  );
  assert.equal(
    code(() => engine.park({ channel: "takeaway", lines: [line(a, 0)] })),
    "INVALID_QUANTITY",
  );
  assert.deepEqual(engine.parked(), []);
});

test("addToTable refuses a sold-out item without opening an order or the table", () => {
  const engine = api();
  const a02 = engine.tables().find((t) => t.label === "A02");
  const soldOut = engine.catalog().items.find((i) => i.soldOut);
  assert.equal(
    code(() =>
      engine.addToTable({ tableId: a02.id, lines: [line(soldOut, 1)] }),
    ),
    "ITEM_SOLD_OUT",
  );
  const view = engine.tableOrder(a02.id);
  assert.equal(view.order, null);
  assert.equal(view.table.status, "empty");
  // The next real order is the first one: no number was burned by the refusal.
  const [a] = plainItems(engine.catalog());
  const first = engine.addToTable({ tableId: a02.id, lines: [line(a, 1)] });
  const nextNumber = Number(first.order.number.replace("POS-", ""));
  const direct = api().submitOrder({
    channel: "takeaway",
    tableSessionId: null,
    ojol: null,
    lines: [line(a, 1)],
  });
  assert.equal(nextNumber, Number(direct.number.replace("POS-", "")));
});

test("addToTable over the line limit leaves no order behind", () => {
  const engine = api();
  const a02 = engine.tables().find((t) => t.label === "A02");
  const [a] = plainItems(engine.catalog());
  const many = Array.from({ length: 100 }, () => line(a, 1));
  assert.equal(
    code(() => engine.addToTable({ tableId: a02.id, lines: many })),
    "TOO_MANY_LINES",
  );
  assert.equal(engine.tableOrder(a02.id).order, null);
  assert.equal(engine.tableOrder(a02.id).table.status, "empty");
});
