// legend-h1dyy (Codex finding 1, service wiring): a failed-item manual refund
// (ORD-09, `deliverOrderRecoveryRefundEvent`) on a QR pay-first order with a
// live promotion is re-priced by the promo port (founder Q41/Q19), not by the
// plain pro-rata share. A returned free item pays Rp0; a returned item that
// drops the bill below the promo condition pays what the guest paid minus what
// the kept goods now cost.
//
// World (order-recovery-helpers): service 5%, PBJT 10% on goods + service,
// exclusive prices. Promotion "buy 2 of {kopi, teh}, get 1 roti free" (auto,
// no code). Order: kopi 25.000 + teh 12.000 + roti 18.000 = subtotal 55.000,
// discount 18.000 (roti free), net 37.000, service 1.850, PBJT 3.885,
// total 42.735.
// - Roti (free) refund: the promo keeps nothing on the kept lines, the guest
//   is owed Rp0 -> no refund, `refund_blocked nothing_left`, the redemption
//   is cut to 0 (old pro-rata opened 13.986).
// - Kopi refund: the promo is withdrawn (1 buy item left); kept goods teh +
//   roti = 30.000, paid 37.000 -> goods due 7.000; service and PBJT of that
//   slice (350 + 735) -> refund 8.085, gross 25.000, discount 18.000 (old
//   pro-rata opened 19.425). The promo ledger records 7.000 paid back.
// Review of 99c11968 (CTO decision): a failed item was never delivered,
// whatever happened to its refund, so the kept lines leave out the item of
// every manual_refund issue of the order; a rejected refund keeps its promo
// payout (the approver decided the money is not owed).
// - H2: roti nothing_left, then kopi: kept teh only -> goods due 25.000,
//   service 1.250, PBJT 2.625 -> 28.875 (not 8.085 with roti still kept).
// - H3: kopi refunded (8.085, ledger 7.000) and rejected, then roti: no 422;
//   kept teh -> goods due 18.000, slice [7.000, 25.000) -> 900 + 1.890 ->
//   20.790; the kopi's 7.000 is not paid again.
// - H4 (own promo: 5.000 off from 50.000, total 57.750): roti swapped to teh,
//   then kopi: kept lines are the checkout lines teh + roti (not teh + the
//   replacement teh) -> goods due 20.000, service 1.000, PBJT 2.100 -> 23.100.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { orderRefundedPayloadSchema } from "@starter/shared/pos";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverOrderRecoveryRefundEvent,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;
const freeRotiPromotion = randomUUID();

beforeAll(async () => {
  w = await createWorld();
  // Auto promotion (no code): buy 2 of {kopi, teh}, get 1 roti free.
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, 'Beli 2 minuman gratis roti', '', 'active', NULL, false,
               now() - interval '1 hour', NULL, $3, $4, 'g_h1dyy', true, 0, NULL, NULL, NULL)`,
      [
        freeRotiPromotion,
        w.tenant.tenantId,
        JSON.stringify([
          {
            kind: "item_quantity",
            menuItemIds: [w.ids.kopi, w.ids.teh],
            minQuantity: 2,
          },
        ]),
        JSON.stringify({
          kind: "free_items",
          menuItemIds: [w.ids.roti],
          quantityPerMultiple: 1,
        }),
      ],
    ),
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const ORDER_TOTAL = 42_735;

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
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
}

/** The verified webhook settles the intent; its payment.paid reaches the order. */
async function payVerified(intentId: string, amountIdr: number) {
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event, event.id, tx),
  );
}

/** A paid pay-first order kopi + teh + roti with the live promo applied. */
async function paidPromoOrder(
  expected: { discount_idr: number; total_idr: number } = {
    discount_idr: 18_000,
    total_idr: ORDER_TOTAL,
  },
) {
  const guest = await w.seat();
  let version = 0;
  for (const menuItemId of [w.ids.kopi, w.ids.teh, w.ids.roti]) {
    const added = await w
      .as(guest)
      .add({ menuItemId, quantity: 1, expectedCartVersion: version });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    version = added.body.data.cart.version as number;
  }
  const placed = await w.as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const order = placed.body.data.order as {
    id: string;
    items: { id: string; menuItemId: string }[];
  };
  const { rows } = await owner.query<{
    subtotal_idr: number;
    discount_idr: number;
    total_idr: number;
  }>(
    `SELECT subtotal_idr::int, discount_idr::int, total_idr::int
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(order.id)],
  );
  expect(rows[0], "promo order amounts").toEqual({
    subtotal_idr: 55_000,
    ...expected,
  });
  const payment = await w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, expected.total_idr)).toBe(
    true,
  );
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!;
  return {
    order,
    kopi: line(w.ids.kopi),
    roti: line(w.ids.roti),
  };
}

/** Reports one line as failed and resolves it with an approved ORD-09 refund. */
async function approvedRefund(itemId: string, amountIdr: number) {
  const reported = await w.report(itemId);
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: REASON,
    },
  );
  expect(resolved.status).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows).toHaveLength(1);
  return { issueId, event: rows[0]!.event };
}

async function issueRefunds(issueId: string) {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: number;
    status: string;
  }>(
    `SELECT id, amount_idr::int AS amount_idr, status FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = $2 ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

async function auditRows(issueId: string, action: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [w.tenant.tenantId, action, issueId],
  );
  return rows.map((row) => row.event);
}

async function application(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    refunded_subtotal_idr: number;
    refunded_paid_idr: number;
    total_discount_idr: number;
  }>(
    `SELECT status, refunded_subtotal_idr::int, refunded_paid_idr::int,
            total_discount_idr::int
       FROM promotion_order_applications WHERE tenant_id = $1 AND order_id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  expect(rows, "promo application").toHaveLength(1);
  return rows[0]!;
}

async function redemptionDiscounts(orderId: string) {
  const { rows } = await owner.query<{ discount_idr: number; status: string }>(
    `SELECT discount_idr::int, status FROM promotion_redemptions
      WHERE tenant_id = $1 AND order_id = $2 ORDER BY id`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows;
}

async function idempotencyResponse(issueId: string) {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  return rows[0]?.response ?? null;
}

/** Sets the refund `failed` for `reason` by SQL, then runs the hook as `failRefund` does. */
async function failAndRunHook(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    await refileRecoveryRefundAfterFailure(tx, context, row!, new Date());
  });
}

describe("legend-h1dyy refund item gagal pada pesanan QR berpromo", () => {
  it("roti gratis gagal: tidak ada refund (nothing_left), promo dihitung ulang dan ditarik", async () => {
    const paid = await paidPromoOrder();
    const { issueId, event } = await approvedRefund(paid.roti.id, 18_000);

    await deliver(event);

    expect(await issueRefunds(issueId), "no refund for a free item").toEqual(
      [],
    );
    expect(await w.outboxRows("order.refunded", paid.order.id)).toHaveLength(0);
    const blocked = await auditRows(issueId, "order_issue.refund_blocked");
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked[0])).toContain("nothing_left");
    // The promo recompute stays committed: the free item really failed.
    expect(await application(paid.order.id)).toMatchObject({
      status: "applied",
      refunded_subtotal_idr: 18_000,
      refunded_paid_idr: 0,
      total_discount_idr: 0,
    });
    // The kept bill has no roti left to give away: the promotion is withdrawn
    // (its redemption is no longer applied), nothing applied stays on it.
    const redemptions = await redemptionDiscounts(paid.order.id);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.status).not.toBe("applied");

    // A replayed event changes nothing.
    await deliver(event);
    expect(await issueRefunds(issueId)).toEqual([]);
    expect(await auditRows(issueId, "order_issue.refund_blocked")).toHaveLength(
      1,
    );
  });

  it("H3 kopi gagal: promo ditarik, refund 8.085 (bukan pro-rata 19.425), payout promo 7.000; ditolak lalu roti gagal: 20.790 dipotong ke bagian barisnya 13.986", async () => {
    const paid = await paidPromoOrder();
    const kopi = await approvedRefund(paid.kopi.id, 25_000);

    await deliver(kopi.event);

    const refunds = await issueRefunds(kopi.issueId);
    expect(refunds.map((row) => row.amount_idr)).toEqual([8_085]);
    const refunded = await w.outboxRows("order.refunded", paid.order.id);
    expect(refunded).toHaveLength(1);
    const payload = orderRefundedPayloadSchema.parse(
      refunded[0]!.event.payload,
    );
    expect(payload).toMatchObject({
      refundId: kopi.issueId,
      amountIdr: 8_085,
      grossSalesIdr: 25_000,
      discountIdr: 18_000,
      serviceChargeIdr: 350,
      pbjtIdr: 735,
    });
    expect(await application(paid.order.id)).toMatchObject({
      refunded_subtotal_idr: 25_000,
      refunded_paid_idr: 7_000,
      total_discount_idr: 0,
    });
    expect(await idempotencyResponse(kopi.issueId)).toMatchObject({
      promoRecordedIdr: 7_000,
    });

    // Rejected: the approver decided the money is not owed, so the promo
    // ledger keeps the 7.000 (a later refund must not pay it).
    await failAndRunHook(refunds[0]!.id, "rejected");
    expect((await application(paid.order.id)).refunded_paid_idr).toBe(7_000);

    // Like a system voucher (legend-wpn5v): the roti recompute is 20.790 but
    // its share of the bill is 18.000 x 42.735 / 55.000 = 13.986, so the
    // consumer files exactly the share and audits the cut (6.804).
    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(roti.event);
    expect(
      (await issueRefunds(roti.issueId)).map((row) => row.amount_idr),
    ).toEqual([13_986]);
    const cut = await auditRows(roti.issueId, "order_issue.refund_shortfall");
    expect(cut).toHaveLength(1);
    expect(JSON.stringify(cut[0])).toContain("roomCutIdr");
    expect(await auditRows(roti.issueId, "order_issue.refund_blocked")).toEqual(
      [],
    );
  });

  it("H2 roti gratis gagal (nothing_left), lalu kopi gagal: roti tidak dihitung tetap dimiliki -> 28.875 dipotong ke bagian kopi 19.425", async () => {
    const paid = await paidPromoOrder();
    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(roti.event);
    expect(await issueRefunds(roti.issueId)).toEqual([]);

    // With the roti kept out the kopi recompute is 28.875, over the kopi's
    // share 25.000 x 42.735 / 55.000 = 19.425: capped at the share (legend-wpn5v).
    const kopi = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(kopi.event);
    expect(
      (await issueRefunds(kopi.issueId)).map((row) => row.amount_idr),
    ).toEqual([19_425]);
    const cut = await auditRows(kopi.issueId, "order_issue.refund_shortfall");
    expect(cut).toHaveLength(1);
    expect(JSON.stringify(cut[0])).toContain("roomCutIdr");
    const refunded = await w.outboxRows("order.refunded", paid.order.id);
    expect(refunded).toHaveLength(1);
    expect(
      orderRefundedPayloadSchema.parse(refunded[0]!.event.payload).amountIdr,
    ).toBe(19_425);
  });
});

describe("legend-h1dyy dua item gagal diselesaikan sebelum event mana pun berjalan", () => {
  it("kopi lalu roti: event kopi merefund barisnya saja (8.085), event roti 20.790 dipotong ke bagian barisnya 13.986; total 22.071", async () => {
    const paid = await paidPromoOrder();
    // Both resolved before either refund event runs.
    const kopi = await approvedRefund(paid.kopi.id, 25_000);
    const roti = await approvedRefund(paid.roti.id, 18_000);

    // The roti issue is not processed yet: its item stays kept, so the kopi
    // refund pays only the kopi (goods 7.000).
    await deliver(kopi.event);
    expect(
      (await issueRefunds(kopi.issueId)).map((row) => row.amount_idr),
    ).toEqual([8_085]);
    expect((await application(paid.order.id)).refunded_paid_idr).toBe(7_000);

    // The roti event then recomputes 20.790 (kept teh only, goods 18.000), over
    // the roti's share 13.986: capped at the share (legend-wpn5v).
    await deliver(roti.event);
    expect(
      (await issueRefunds(roti.issueId)).map((row) => row.amount_idr),
    ).toEqual([13_986]);
    const refunded = (await w.outboxRows("order.refunded", paid.order.id)).map(
      (row) => orderRefundedPayloadSchema.parse(row.event.payload),
    );
    expect(refunded.reduce((sum, row) => sum + row.amountIdr, 0)).toBe(22_071);
  });
});

describe("legend-xhl5j (1243) refund item gagal: diskon manual pada pesanan QR diblokir", () => {
  it("diskon manual 20.000 (dibaca dari data order): tidak ada refund, audit diblokir manual_discount, promo tidak disentuh", async () => {
    const paid = await paidPromoOrder();
    // The manual discount sits on the order's own rows (read by the server).
    await asOwnerTenant(w.tenant.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO pos_order_discounts (id, tenant_id, outlet_id, order_id, source, kind, amount_idr,
                                          reason, reason_note, applied_by)
         VALUES ($1, $2, $3, $4, 'manual', 'amount', 20000, 'loyal', 'pelanggan setia', 'kasir-a')`,
        [
          randomUUID(),
          w.tenant.tenantId,
          w.tenant.outletId,
          toUuid(paid.order.id),
        ],
      );
    });
    const kopi = await approvedRefund(paid.kopi.id, 25_000);

    await deliver(kopi.event);

    expect(await issueRefunds(kopi.issueId), "no refund row").toEqual([]);
    expect(await w.outboxRows("order.refunded", paid.order.id)).toHaveLength(0);
    const blocked = await auditRows(kopi.issueId, "order_issue.refund_blocked");
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked[0])).toContain("manual_discount");
    // The recompute never ran: the promo stands as checkout left it.
    expect(await application(paid.order.id)).toMatchObject({
      status: "applied",
      refunded_subtotal_idr: 0,
      refunded_paid_idr: 0,
    });
    expect(await redemptionDiscounts(paid.order.id)).toEqual([
      expect.objectContaining({ status: "applied" }),
    ]);
  });
});

describe("legend-h1dyy H4 baris swap: kept lines dari baris checkout", () => {
  beforeAll(async () => {
    // Only this promotion is live here: 5.000 off from a 50.000 bill.
    await asOwnerTenant(w.tenant.tenantId, async (client) => {
      await client.query(
        "UPDATE promotions SET status = 'paused' WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, freeRotiPromotion],
      );
      await client.query(
        `INSERT INTO promotions
           (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
            conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
            budget_idr)
         VALUES ($1, $2, 'Potongan 5.000 min 50.000', '', 'active', NULL, false,
                 now() - interval '1 hour', NULL, $3, $4, 'g_h1dyy_min', true, 0, NULL, NULL, NULL)`,
        [
          randomUUID(),
          w.tenant.tenantId,
          JSON.stringify([{ kind: "min_spend", amountIdr: 50_000 }]),
          JSON.stringify({ kind: "nominal_off", amountIdr: 5_000 }),
        ],
      );
    });
  });

  it("roti ditukar teh, lalu kopi gagal: refund 23.100 (barang 20.000), bukan 26.000 dari teh pengganti", async () => {
    // 55.000 - 5.000 = 50.000; service 2.500; PBJT 5.250; total 57.750.
    const paid = await paidPromoOrder({
      discount_idr: 5_000,
      total_idr: 57_750,
    });
    const reported = await w.report(paid.roti.id);
    expect(reported.status).toBe(201);
    const swapIssue = reported.body.data.id as string;
    const swapped = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${swapIssue}/resolve`,
      { resolution: "swap", replacementItemId: w.ids.teh },
    );
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const resolved = await w.outboxRows("order_issue.resolved", swapIssue);
    expect(resolved).toHaveLength(1);
    const context = contextOf(w.tenant.tenantId);
    await withTenant(db, context, (tx) =>
      deliverSwapKitchenEvent(context, resolved[0]!.event, tx),
    );
    const { rows: replaced } = await owner.query<{ id: string | null }>(
      "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, swapIssue],
    );
    expect(replaced[0]!.id, "replacement line written").not.toBeNull();

    const kopi = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(kopi.event);
    expect(
      (await issueRefunds(kopi.issueId)).map((row) => row.amount_idr),
    ).toEqual([23_100]);
    const refunded = await w.outboxRows("order.refunded", paid.order.id);
    expect(
      orderRefundedPayloadSchema.parse(refunded[0]!.event.payload),
    ).toMatchObject({
      amountIdr: 23_100,
      grossSalesIdr: 25_000,
      discountIdr: 5_000,
      serviceChargeIdr: 1_000,
      pbjtIdr: 2_100,
    });
    expect((await application(paid.order.id)).refunded_paid_idr).toBe(20_000);
  });
});
