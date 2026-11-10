// pc51h: GET /api/table-sessions/:sessionId/bill must answer 200 after a staff swap
// of a failed item has been delivered (the `order_issue.resolved` consumer
// added a replacement line and voided the old one). Red test: the bill
// currently answers 422 after the swap.
//
// Assumptions where the brief is silent:
// - The sessionId in the path is the table session id of the seated guest
//   (`guest.sessionId` from `seat()`), the same id used by the guest cart/order
//   routes; the bearer token is `guest.token`.
// - "Pricier replacement" = kopi (25.000) for a failed roti (18.000), with an
//   approved `price_correction` approval as in order-recovery-swap-kitchen.
// - Bill totals mean `body.data.totals.subtotalIdr/totalIdr`; they must equal
//   the order's subtotal_idr/total_idr from before the swap (the swap adds no
//   extra charge and no refund to the bill).
// - Stations are wired like order-recovery-swap-kitchen.test.ts so the real
//   consumer runs the same path.
// - Fix (option A): the bill order DTO carries `swapReplacementIdr` = the
//   line_total of the replacement line (order_issues.replacement_order_item_id),
//   and sum(ALL item lineTotalIdr) - swapReplacementIdr == subtotalIdr.
// - Move guard (legend-pc51h review 1): moving ONLY the replacement line of a
//   delivered same-price swap through POST /api/table-sessions/:id/move-items
//   (staff = w.floorStaff, destination = another seated session of the same
//   tenant) answers 409 CONFLICT and leaves the order and the source bill
//   untouched. A swap needs a PAID order (open-bill orders cannot be reported),
//   and a paid order carries payment_link_id/payment_intent_id, which the move
//   refuses with an earlier CONFLICT. So the test clears those columns via SQL
//   after the swap to make the new guard the only possible refusal. Same
//   price keeps sum(live items) == order subtotal, which the earlier "cannot
//   be split" CONFLICT also requires.
// - Negative case: corrupting orders.subtotal_idr (+1, and total_idr +1 because
//   the DB check orders_total_check forbids subtotal alone) on an order without
//   a swap still answers 422 (the bill is not served for an inconsistent order).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { agent } from "./helpers.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const stations = { hot: randomUUID(), bar: randomUUID() };

beforeAll(async () => {
  w = await createWorld();
  for (const [id, name, type] of [
    [stations.hot, "Dapur Bill Uji", "hot_kitchen"],
    [stations.bar, "Bar Bill Uji", "beverage_bar"],
  ] as const)
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [id, w.tenant.tenantId, w.tenant.outletId, name, type],
    );
  for (const [menuItemId, stationId, stationType] of [
    [w.ids.roti, stations.hot, "hot_kitchen"],
    [w.ids.kopi, stations.bar, "beverage_bar"],
    [w.ids.teh, stations.bar, "beverage_bar"],
    // rotiLain: deliberately no station.
  ] as const)
    await owner.query(
      `UPDATE menu_items SET station_id = $3, station_type = $4
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, menuItemId, stationId, stationType],
    );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

// ---- helpers ---------------------------------------------------------------

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

async function deliver(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
}

async function resolvedEvent(issueId: string): Promise<EventEnvelope> {
  const rows = await w.outboxRows("order_issue.resolved", issueId);
  expect(rows, "order_issue.resolved event in the outbox").toHaveLength(1);
  return rows[0]!.event;
}

async function orderMoney(orderId: string) {
  const { rows } = await owner.query<{
    subtotal_idr: number;
    total_idr: number;
  }>(
    `SELECT subtotal_idr::int AS subtotal_idr, total_idr::int AS total_idr
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows[0]!;
}

/** A paid order whose roti failed and was swapped by the supervisor. */
async function staffSwap(
  replacementItemId: string,
  options: { pricier?: boolean } = {},
) {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const approvalRequestId = options.pricier
    ? await w.insertApproval({
        actionType: "price_correction",
        objectType: "order_issue",
        objectId: issueId,
        amountIdr: PRICES.kopi - PRICES.roti,
        status: "approved",
        requestedBy: w.floorStaff.userId,
      })
    : undefined;
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId,
      ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
    },
  );
  expect(resolved.status).toBe(200);
  return { ...paid, issueId, event: await resolvedEvent(issueId) };
}

async function replacementLineTotalOf(issueId: string) {
  const { rows } = await owner.query<{ line_total_idr: number }>(
    `SELECT oi.line_total_idr::int AS line_total_idr
     FROM order_issues i
     JOIN order_items oi
       ON oi.tenant_id = i.tenant_id AND oi.id = i.replacement_order_item_id
     WHERE i.tenant_id = $1 AND i.id = $2`,
    [w.tenant.tenantId, toUuid(issueId)],
  );
  expect(rows, "replacement line of the swapped issue").toHaveLength(1);
  return rows[0]!.line_total_idr;
}

async function orderIdsOfSession(sessionId: string) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM orders WHERE tenant_id = $1 AND table_session_id = $2
     ORDER BY id`,
    [w.tenant.tenantId, sessionId],
  );
  return rows.map((row) => row.id);
}

/** "item id -> order id" pairs of every line currently in the order. */
async function itemOrderIds(orderId: string) {
  const { rows } = await owner.query<{ id: string; order_id: string }>(
    `SELECT id, order_id FROM order_items
     WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows;
}

function getBill(sessionId: string, token: string) {
  return agent(w.app)
    .get(`/api/table-sessions/${sessionId}/bill`)
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${token}`);
}

async function expectBillAfterSwap(replacementItemId: string, pricier = false) {
  const { order, guest, event, issueId } = await staffSwap(replacementItemId, {
    pricier,
  });
  const moneyBefore = await orderMoney(order.id);

  await deliver(event);

  const bill = await getBill(guest.sessionId, guest.token);
  // Print the exact body on failure (the 422 message is the point of this test).
  expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  const totals = bill.body.data.totals;
  expect(totals.subtotalIdr).toBe(moneyBefore.subtotal_idr);
  expect(totals.totalIdr).toBe(moneyBefore.total_idr);

  const billOrder = bill.body.data.orders[0];
  const replacementLineTotal = await replacementLineTotalOf(issueId);
  expect(billOrder.swapReplacementIdr).toBe(replacementLineTotal);
  const itemSum = (billOrder.items as { lineTotalIdr: number }[]).reduce(
    (sum, item) => sum + item.lineTotalIdr,
    0,
  );
  expect(itemSum - billOrder.swapReplacementIdr).toBe(totals.subtotalIdr);
}

// ---- tests -----------------------------------------------------------------

describe("pc51h tagihan setelah swap staf", () => {
  it("pengganti lebih mahal: tagihan 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectBillAfterSwap(w.ids.kopi, true);
  });

  it("pengganti lebih murah: tagihan 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectBillAfterSwap(w.ids.teh);
  });

  it("pengganti harga sama: tagihan 200, subtotal dan total sama seperti sebelum swap", async () => {
    await expectBillAfterSwap(w.ids.rotiLain);
  });

  it("order tanpa swap dengan subtotal salah (+1): tagihan tidak 200 (422)", async () => {
    const { order, guest } = await w.paidOrder();
    await owner.query(
      // total_idr moves with the subtotal only to satisfy the DB check
      // constraint orders_total_check; the item sum no longer matches.
      `UPDATE orders SET subtotal_idr = subtotal_idr + 1, total_idr = total_idr + 1
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, toUuid(order.id)],
    );

    const bill = await getBill(guest.sessionId, guest.token);
    expect(bill.status, JSON.stringify(bill.body)).not.toBe(200);
    expect(bill.status).toBe(422);
  });

  it("memindah lini pengganti swap sendirian: 409 CONFLICT, order asal tidak berubah, tagihan meja asal tetap 200", async () => {
    const open = await w.paidOrder();
    const issueId = (await w.report(open.roti.id)).body.data.id as string;
    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.rotiLain },
    );
    expect(resolved.status).toBe(200);
    await deliver(await resolvedEvent(issueId));

    const { rows: replacement } = await owner.query<{ id: string }>(
      `SELECT replacement_order_item_id AS id FROM order_issues
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, toUuid(issueId)],
    );
    const replacementId = uuidToUlid(replacement[0]!.id);
    // A paid order always carries a payment link/intent, and the move refuses
    // that with its own earlier CONFLICT. Clear them so ONLY the replacement
    // line guard can refuse this move (the test must go red without it).
    await owner.query(
      `UPDATE orders
       SET payment_link_id = NULL, payment_link_token_sealed = NULL,
           payment_intent_id = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, toUuid(open.order.id)],
    );
    const moneyBefore = await orderMoney(open.order.id);
    const orderIdsBefore = await orderIdsOfSession(open.guest.sessionId);
    const itemOrdersBefore = await itemOrderIds(open.order.id);

    const destination = await w.seat();
    const moved = await w.staffPost(
      w.floorStaff,
      `/api/table-sessions/${open.guest.sessionId}/move-items`,
      { toSessionId: destination.sessionId, orderItemIds: [replacementId] },
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);

    expect(await orderMoney(open.order.id)).toEqual(moneyBefore);
    expect(await orderIdsOfSession(open.guest.sessionId)).toEqual(
      orderIdsBefore,
    );
    expect(await orderIdsOfSession(destination.sessionId)).toEqual([]);
    expect(await itemOrderIds(open.order.id)).toEqual(itemOrdersBefore);

    const bill = await getBill(open.guest.sessionId, open.guest.token);
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
  });
});
