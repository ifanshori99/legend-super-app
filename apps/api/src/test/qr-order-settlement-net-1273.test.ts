// 1273 (Duitku second opinion, P2 + P3-1): the money a session's QR links put
// toward its bill is net of what the provider refunded on its own, never the
// gross `paid_idr` (same rule as legend-9yw78.12 in open-bill-control).
//
// - settlementOf (GET /bill and the ORD-10 close port): a link the provider
//   refunded in full leaves the bill unpaid, a part refund leaves exactly the
//   refunded amount outstanding, no refund stays paid, and a refund on another
//   session's link changes nothing here.
// - legend-7adhb: a captured POS tender that rides the order's own link is not
//   counted a second time next to the link's money in the open-bill exposure.
// Written before the fix, so it starts red.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { assertOpenBillWithinLimit } from "../services/open-bill-control.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createWorld,
  CART_TOTAL,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

function scopedContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function settlement(sessionId: string) {
  const context = scopedContext();
  return withTenant(db, context, (tx) =>
    qrOrderSettlementLookup({
      tx,
      tenantId: context.tenant.tenantId,
      sessionId,
    }),
  );
}

type Paid = Awaited<ReturnType<World["paidOrder"]>>;

/** The order's link and the intent that paid it. */
async function linkOf(paid: Paid) {
  const { rows } = await owner.query<{ link_id: string; intent_id: string }>(
    `SELECT o.payment_link_id AS link_id, i.id AS intent_id
       FROM orders o
       JOIN payment_intents i
         ON i.tenant_id = o.tenant_id AND i.payment_link_id = o.payment_link_id
      WHERE o.tenant_id = $1 AND o.id = $2`,
    [w.tenant.tenantId, ulidToUuid(paid.order.id)],
  );
  return { linkId: rows[0]!.link_id, intentId: rows[0]!.intent_id };
}

/** The provider refunded `amountIdr` of the intent on its own (brief 967). */
async function providerRefunded(intentId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
        provider_payment_ref, amount_idr, source)
     VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')`,
    [
      w.tenant.tenantId,
      w.tenant.outletId,
      intentId,
      `rf_${randomUUID().slice(0, 12)}`,
      `pay_${intentId.slice(0, 12)}`,
      amountIdr,
    ],
  );
}

const outstanding = (s: { billTotalIdr: number; paidIdr: number }) =>
  Math.max(0, s.billTotalIdr - s.paidIdr);

describe("settlement of a session whose link the provider refunded", () => {
  it("without a refund the bill stays paid", async () => {
    const paid = await w.paidOrder();
    const s = await settlement(paid.guest.sessionId);
    expect(s.paidIdr).toBe(CART_TOTAL);
    expect(outstanding(s)).toBe(0);
  });

  it("a full provider refund leaves the whole bill outstanding", async () => {
    const paid = await w.paidOrder();
    const { intentId } = await linkOf(paid);
    await providerRefunded(intentId, CART_TOTAL);
    const s = await settlement(paid.guest.sessionId);
    expect(outstanding(s)).toBe(CART_TOTAL);
  });

  it("a part refund leaves exactly the refunded amount outstanding", async () => {
    const paid = await w.paidOrder();
    const { intentId } = await linkOf(paid);
    await providerRefunded(intentId, 20_000);
    const s = await settlement(paid.guest.sessionId);
    expect(outstanding(s)).toBe(20_000);
  });

  it("GET /bill carries the net figure and closing the session is refused", async () => {
    const paid = await w.paidOrder();
    const { intentId } = await linkOf(paid);
    await providerRefunded(intentId, CART_TOTAL);
    const bill = await agent(w.app)
      .get(`/api/table-sessions/${paid.guest.sessionId}/bill`)
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${paid.guest.token}`)
      .set(originHeader);
    expect(bill.status).toBe(200);
    expect(bill.body.data.totals.paidIdr).toBe(0);
    const close = await w.staffPost(
      w.floorStaff,
      `/api/table-sessions/${paid.guest.sessionId}/close`,
      { tableCleaned: true, waiterConfirmedEmpty: false },
    );
    expect(close.status).toBe(409);
  });

  it("a refund on one session does not change another session", async () => {
    const refunded = await w.paidOrder();
    const other = await w.paidOrder();
    const { intentId } = await linkOf(refunded);
    await providerRefunded(intentId, CART_TOTAL);
    const s = await settlement(other.guest.sessionId);
    expect(s.paidIdr).toBe(CART_TOTAL);
    expect(outstanding(s)).toBe(0);
  });
});

describe("legend-7adhb: a tender on the order's own link is not counted twice", () => {
  it("open-bill exposure keeps the money the link no longer holds", async () => {
    const paid = await w.paidOrder();
    const { linkId, intentId } = await linkOf(paid);
    // The provider refunded 40.090: the link still nets 50.000. An old row
    // also holds a captured tender of 40.090 on the very same link.
    await providerRefunded(intentId, 40_090);
    // A tender needs a POS order (channel check), so the old row is a POS order.
    await owner.query(
      "UPDATE orders SET channel = 'pos' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(paid.order.id)],
    );
    await owner.query(
      `INSERT INTO pos_orders (tenant_id, order_id, outlet_id, channel)
       SELECT tenant_id, id, outlet_id, channel FROM orders
        WHERE tenant_id = $1 AND id = $2
       ON CONFLICT DO NOTHING`,
      [w.tenant.tenantId, ulidToUuid(paid.order.id)],
    );
    await owner.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_link_id,
          payment_link_token_sealed, amount_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'qris', 'duitku', $4, 'test-sealed', 40090, 'captured', now(), now())`,
      [w.tenant.tenantId, w.tenant.outletId, ulidToUuid(paid.order.id), linkId],
    );
    const { rows } = await owner.query<{
      table_id: string;
      zone_id: string;
    }>(
      `SELECT s.table_id, t.zone_id FROM table_sessions s
         JOIN tables t ON t.tenant_id = s.tenant_id AND t.id = s.table_id
        WHERE s.tenant_id = $1 AND s.id = $2`,
      [w.tenant.tenantId, paid.guest.sessionId],
    );
    const context = scopedContext();
    // Exposure is 40.090 (90.090 total less the 50.000 the link nets). Counting
    // the tender too would make it 0 and let this order pass the 3.000.000 cap.
    const attempt = withTenant(db, context, (tx) =>
      assertOpenBillWithinLimit(tx, context, {
        sessionId: paid.guest.sessionId,
        outletId: w.tenant.outletId,
        tableId: rows[0]!.table_id,
        zoneId: rows[0]!.zone_id,
        paymentMode: "open_bill",
        cartVersion: 1,
        orderTotalIdr: 3_000_000 - 40_090 + 1,
        now: new Date(),
      }),
    );
    await expect(attempt).rejects.toMatchObject({
      breach: { currentBillIdr: 40_090 },
    });
  });
});
