// legend-ijv8: breakfast ordered from the access ticket (alur Z) and held until
// `slot.endsAt - fireOffsetMinutes`.
// Contract (brief): pure `breakfastFireAt(slotEndsAt, fireOffsetMinutes)` in
// features/facility/flow.ts returning an ISO string; a mock for
// GET  /api/facility/tickets/:ticketId/breakfast-menu  and
// POST /api/facility/tickets/:ticketId/breakfast-orders (contract now in
// @starter/shared/facility, bead oa0qk: pay first, then fire; founder Q43).
// Validation: at least one line, and a delivery choice (table with a table id,
// or pickup).
//
// ASSUMPTIONS (spec silent): the menu answer is `{ items, tables,
// fireOffsetMinutes, order }`; an order body is `{ lines: [{ menuItemId,
// quantity }], delivery: { mode: "table", tableId } | { mode: "pickup" },
// idempotencyKey }`; the first seeded ticket (issued) can order breakfast.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { cafeLegendFacilityFixtures as fx } from "../packages/shared/src/facility/index.ts";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import { setScenario } from "../apps/web/src/lib/mock/control.ts";
import { breakfastFireAt } from "../apps/web/src/features/facility/flow.ts";
import { settleBreakfastPaymentInMock } from "../apps/web/src/features/facility/mock.ts";

const ticketId = fx.tickets[0].id;
const request = (method, path, body) => dispatchMock({ method, path, body });
const menu = async () =>
  (await request("GET", `/api/facility/tickets/${ticketId}/breakfast-menu`))
    .data;
const order = (body) =>
  request("POST", `/api/facility/tickets/${ticketId}/breakfast-orders`, {
    idempotencyKey: `ijv8-${Math.random().toString(36).slice(2)}-abcdef`,
    ...body,
  });
const bad = (error) => error.status === 400 || error.status === 422;

beforeEach(() => resetMocks());

describe("breakfastFireAt (legend-ijv8)", () => {
  test("is the session end minus the offset, as an ISO string", () => {
    assert.equal(
      breakfastFireAt("2026-11-12T01:00:00.000Z", 5),
      "2026-11-12T00:55:00.000Z",
    );
    assert.equal(
      breakfastFireAt("2026-11-12T01:00:00.000Z", 0),
      "2026-11-12T01:00:00.000Z",
    );
  });

  test("crosses midnight and accepts an offset-bearing input", () => {
    assert.equal(
      breakfastFireAt("2026-11-12T00:02:00.000Z", 5),
      "2026-11-11T23:57:00.000Z",
    );
    assert.equal(
      breakfastFireAt("2026-11-12T08:00:00.000+07:00", 10),
      "2026-11-12T00:50:00.000Z",
    );
  });
});

describe("breakfast from the ticket mock (legend-ijv8)", () => {
  test("the menu lists dishes with a price and the kitchen offset", async () => {
    const data = await menu();
    assert.ok(data.items.length >= 1);
    for (const item of data.items) {
      assert.ok(item.name);
      assert.ok(Number.isInteger(item.priceIdr) && item.priceIdr >= 0);
    }
    assert.ok(Number.isInteger(data.fireOffsetMinutes));
    assert.equal(data.order, null);
  });

  test("the empty scenario has no dishes", async () => {
    setScenario("empty");
    assert.deepEqual((await menu()).items, []);
  });

  test("a pickup order awaits payment and fires at slot end minus the offset", async () => {
    const data = await menu();
    const dish = data.items[0];
    const placed = (
      await order({
        lines: [{ menuItemId: dish.id, quantity: 2 }],
        delivery: { mode: "pickup" },
      })
    ).data;
    const view = (await request("GET", `/api/facility/tickets/${ticketId}`))
      .data;
    const endsAt = (view.ticket ?? view).slot.endsAt;
    assert.equal(
      placed.fireAt,
      breakfastFireAt(endsAt, data.fireOffsetMinutes),
    );
    assert.equal(placed.subtotalIdr, dish.priceIdr * 2);
    assert.equal(placed.delivery.mode, "pickup");
    assert.equal(placed.status, "awaiting_payment");
    assert.equal(placed.totalIdr, placed.subtotalIdr);
    assert.equal(placed.paidAt, null);
    assert.equal(placed.firedAt, null);
    // A reload shows the order instead of the empty form.
    assert.equal((await menu()).order.id, placed.id);
  });

  test("a table order keeps the chosen table", async () => {
    const data = await menu();
    assert.ok(data.tables.length >= 1);
    const placed = (
      await order({
        lines: [{ menuItemId: data.items[0].id, quantity: 1 }],
        delivery: { mode: "table", tableId: data.tables[0].id },
      })
    ).data;
    assert.deepEqual(placed.delivery, {
      mode: "table",
      tableId: data.tables[0].id,
    });
  });

  test("an order needs at least one line", async () => {
    await assert.rejects(
      order({ lines: [], delivery: { mode: "pickup" } }),
      bad,
    );
  });

  test("an order needs a delivery choice, and a table delivery needs a table", async () => {
    const dish = (await menu()).items[0];
    const lines = [{ menuItemId: dish.id, quantity: 1 }];
    await assert.rejects(order({ lines }), bad);
    await assert.rejects(order({ lines, delivery: { mode: "table" } }), bad);
  });

  test("a quantity below one is refused", async () => {
    const dish = (await menu()).items[0];
    await assert.rejects(
      order({
        lines: [{ menuItemId: dish.id, quantity: 0 }],
        delivery: { mode: "pickup" },
      }),
      bad,
    );
  });
});

describe("breakfast pay-first (legend-oa0qk)", () => {
  const payPath = (orderId, action = "pay") =>
    `/api/facility/tickets/${ticketId}/breakfast-orders/${orderId}/${action}`;
  const key = () => ({
    idempotencyKey: `oa0qk-${Math.random().toString(36).slice(2)}-abcdef`,
  });
  const place = async () => {
    const dish = (await menu()).items[0];
    return (
      await order({
        lines: [{ menuItemId: dish.id, quantity: 1 }],
        delivery: { mode: "pickup" },
      })
    ).data;
  };

  test("paying reuses one payment link and never marks the order paid", async () => {
    const placed = await place();
    const first = (await request("POST", payPath(placed.id), key())).data;
    const second = (await request("POST", payPath(placed.id), key())).data;
    assert.ok(first.paymentToken);
    assert.equal(second.paymentToken, first.paymentToken);
    assert.equal(first.order.status, "awaiting_payment");
    assert.equal((await menu()).order.status, "awaiting_payment");
  });

  test("a settled payment makes the order paid once, with no new link", async () => {
    const placed = await place();
    await request("POST", payPath(placed.id), key());
    const paid = settleBreakfastPaymentInMock(ticketId);
    assert.ok(["paid", "fired"].includes(paid.status));
    assert.ok(paid.paidAt);
    const again = settleBreakfastPaymentInMock(ticketId);
    assert.equal(again.paidAt, paid.paidAt);
    const afterPay = (await request("POST", payPath(placed.id), key())).data;
    assert.equal(afterPay.paymentToken, null);
  });

  test("cancelling an unpaid order refunds nothing, a paid one at most the total", async () => {
    const unpaid = await place();
    const cancelled = (
      await request("POST", payPath(unpaid.id, "cancel"), key())
    ).data;
    assert.equal(cancelled.order.status, "cancelled");
    assert.equal(cancelled.refundIdr, 0);
    await assert.rejects(
      request("POST", payPath(unpaid.id), key()),
      (e) => e.status === 409,
    );
    const paidOrder = await place();
    settleBreakfastPaymentInMock(ticketId);
    const refunded = (
      await request("POST", payPath(paidOrder.id, "cancel"), key())
    ).data;
    assert.ok(refunded.refundIdr <= paidOrder.totalIdr);
    const repeat = (
      await request("POST", payPath(paidOrder.id, "cancel"), key())
    ).data;
    assert.equal(repeat.refundIdr, 0);
  });

  test("the same key with another payload is refused", async () => {
    const dish = (await menu()).items[0];
    const idempotencyKey = "oa0qk-same-key-abcdef";
    await order({
      idempotencyKey,
      lines: [{ menuItemId: dish.id, quantity: 1 }],
      delivery: { mode: "pickup" },
    });
    await assert.rejects(
      order({
        idempotencyKey,
        lines: [{ menuItemId: dish.id, quantity: 2 }],
        delivery: { mode: "pickup" },
      }),
      (e) => e.status === 409,
    );
  });
});
