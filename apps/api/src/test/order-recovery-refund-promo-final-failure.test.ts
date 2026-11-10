// legend-pti5r (round 3): a recovery refund (ORD-09) on a promo order that ends in
// a FINAL failure (`provider_declined`, `cap_exceeded`, `source_document`,
// `refile_limit`) leaves the promo ledger UNTOUCHED. The first filing put the goods
// payout on the promo ledger (`promotion_order_applications.refunded_paid_idr` and
// `refunded_subtotal_idr`); that payout stays reserved for that line, so no other
// issue can absorb it. A promo withdrawn by the first filing cannot be undone, so
// there is no give-back. When the SAME item is reported again after a non-`rejected`
// final failure, the new issue re-files the failed refund's amount and split
// (replay), with no promo recompute and no second payout. `rejected` is unchanged:
// a re-report answers `nothing_left` (legend-h1dyy).
//
// World = order-recovery-refund-promo.test.ts (promotion "buy 2 of {kopi, teh},
// get 1 roti free"; order total 42.735):
// - kopi refund: 8.085, goods payout (promoRecordedIdr) 7.000, subtotal 25.000;
// - after kopi, roti refund: 20.790, goods payout 18.000 (ledger total 25.000).
// The `air` fixture (Rp5.000, in no promo) is added to the order only for T1:
// order total 48.510, air refund 5.000 x 1.155 = 5.775.
//
// Cases:
// - T1 kopi final-fails, then a different item (air) is reported: it is refunded its
//   own amount (not nothing_left); the ledger still holds kopi's payout.
// - T2 kopi final-fails (each of provider_declined, cap_exceeded, source_document),
//   kopi is reported again: same refund amount and same `order.refunded` split as
//   the first filing; ledger unchanged (no second payout).
// - T3 kopi final-fails, then roti is reported: roti gets its own 20.790, not
//   kopi + roti.
// - T4 `rejected` keeps everything: re-report is still nothing_left. A non-final
//   `approval_expired` does not touch the ledger either.
// - T5 the failure hook run twice: ledger and outbox as after once.
// - T6 two issues on one order, one final-failed and one live: the live one and the
//   ledger are unaffected.
// - T7 tenant isolation: another tenant's application for the same order id is
//   unaffected.
// - T8 replay capped by the room of the intent: amount cut to the room, shortfall
//   audited, split scaled and still adds up.
//
// Assumptions where the brief is not exact:
// - `refile_limit` is not exercised: it needs the approval chain machinery
//   (covered by order-recovery-refund-final-failure.test.ts); the replay rule
//   depends only on the failed refund row, which `setFailed` reproduces.
// - T8: a final-failed refund of an issue stamped `refund_rejected_at` holds no
//   room (the money is not leaving), so room = intent total - other live issues'
//   refunds. Another issue's pending refund of 38.000 leaves 4.735.
// - T1: air's own payout may also be booked on the ledger (the check is >= kopi's).
// - Air's own amount (5.775) and a first-filing split replayed as is are derived
//   from the order-recovery-refund-promo world and the brief, not backend code.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

// Each case builds a paid order through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

let w: World;
const freeRotiPromotion = randomUUID();
/** Rp5.000 item that is in no promotion. */
const airItem = randomUUID();

beforeAll(async () => {
  w = await createWorld();
  // Auto promotion (no code): buy 2 of {kopi, teh}, get 1 roti free.
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, 'Beli 2 minuman gratis roti', '', 'active', NULL, false,
               now() - interval '1 hour', NULL, $3, $4, 'g_pti5r', true, 0, NULL, NULL, NULL)`,
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
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Air Mineral', true, $5)`,
      [
        airItem,
        w.tenant.tenantId,
        w.tenant.brandId,
        w.ids.category,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 5000)`,
      [randomUUID(), w.tenant.tenantId, w.ids.priceList, airItem],
    );
  });
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const ORDER_TOTAL = 42_735;
const ORDER_TOTAL_WITH_AIR = 48_510;
const KOPI_REFUND = 8_085;
const KOPI_PAYOUT = 7_000;
const KOPI_SUBTOTAL = 25_000;
const ROTI_REFUND_AFTER_KOPI = 20_790;
const ROTI_PAYOUT_AFTER_KOPI = 18_000;
const AIR_REFUND = 5_775;
const FINAL_REASONS = ["provider_declined", "cap_exceeded", "source_document"];

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

/** A paid pay-first order kopi + teh + roti (+ air) with the live promo applied. */
async function paidPromoOrder(options: { withAir?: boolean } = {}) {
  const guest = await w.seat();
  const menu = [w.ids.kopi, w.ids.teh, w.ids.roti];
  if (options.withAir) menu.push(airItem);
  let version = 0;
  for (const menuItemId of menu) {
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
  const expectedTotal = options.withAir ? ORDER_TOTAL_WITH_AIR : ORDER_TOTAL;
  const { rows } = await owner.query<{ total_idr: number }>(
    `SELECT total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(order.id)],
  );
  expect(rows[0]!.total_idr, "promo order total").toBe(expectedTotal);
  const payment = await w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, expectedTotal)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!;
  return {
    order,
    kopi: line(w.ids.kopi),
    teh: line(w.ids.teh),
    roti: line(w.ids.roti),
    air: options.withAir ? line(airItem) : null,
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

async function auditRows(objectIds: string[], action: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = ANY($3::text[])`,
    [w.tenant.tenantId, action, objectIds],
  );
  return rows.map((row) => row.event);
}

async function ledgerOf(
  tenantId: string,
  orderId: string,
): Promise<{ paid: number; subtotal: number } | null> {
  const { rows } = await owner.query<{
    refunded_paid_idr: number;
    refunded_subtotal_idr: number;
  }>(
    `SELECT refunded_paid_idr::int, refunded_subtotal_idr::int
       FROM promotion_order_applications
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId, toUuid(orderId)],
  );
  return rows[0]
    ? {
        paid: rows[0].refunded_paid_idr,
        subtotal: rows[0].refunded_subtotal_idr,
      }
    : null;
}

async function ledger(orderId: string) {
  const value = await ledgerOf(w.tenant.tenantId, orderId);
  expect(value, "promo application row").not.toBeNull();
  return value!;
}

async function filingPayout(issueId: string): Promise<number> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  return Number(rows[0]?.response?.promoRecordedIdr ?? 0);
}

async function refundedEvents(orderId: string) {
  return (await w.outboxRows("order.refunded", orderId)).map((row) =>
    orderRefundedPayloadSchema.parse(row.event.payload),
  );
}

async function reversalRequests(issueId: string) {
  return w.outboxRows("order_issue.refund_reversal_requested", issueId);
}

/** Runs the failure hook on a refund row as `failRefund` does. */
async function runHook(refundId: string) {
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

async function setFailed(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
}

async function failFinally(refundId: string, reason: string) {
  await setFailed(refundId, reason);
  await runHook(refundId);
}

/** Files the kopi refund of a fresh promo order (payout 7.000 on the ledger). */
async function kopiRefundFiled(options: { withAir?: boolean } = {}) {
  const paid = await paidPromoOrder(options);
  const kopi = await approvedRefund(paid.kopi.id, 25_000);
  await deliver(kopi.event);
  const refunds = await issueRefunds(kopi.issueId);
  expect(refunds.map((row) => row.amount_idr)).toEqual([KOPI_REFUND]);
  expect(await ledger(paid.order.id)).toEqual({
    paid: KOPI_PAYOUT,
    subtotal: KOPI_SUBTOTAL,
  });
  expect(await filingPayout(kopi.issueId)).toBe(KOPI_PAYOUT);
  return { paid, kopi, refundId: refunds[0]!.id };
}

function expectBlocked(blocked: Record<string, unknown>[]) {
  expect(blocked).toHaveLength(1);
  expect(JSON.stringify(blocked[0])).toContain("nothing_left");
}

describe("legend-pti5r T1 item lain setelah kopi gagal final", () => {
  it("air dilaporkan setelah kopi gagal final: direfund jumlahnya sendiri (bukan nothing_left); ledger tetap memegang payout kopi", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled({ withAir: true });

    await failFinally(refundId, "provider_declined");
    expect(await ledger(paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });

    const air = await approvedRefund(paid.air!.id, 5_000);
    await deliver(air.event);

    expect(
      (await issueRefunds(air.issueId)).map((row) => row.amount_idr),
    ).toEqual([AIR_REFUND]);
    expect(
      await auditRows([air.issueId], "order_issue.refund_blocked"),
    ).toEqual([]);
    // Kopi's payout stays reserved on the ledger; air books its own goods
    // payout (5.000) on top: 7.000 + 5.000.
    expect((await ledger(paid.order.id)).paid).toBe(KOPI_PAYOUT + 5_000);
    expect((await issueRefunds(kopi.issueId)).map((row) => row.status)).toEqual(
      ["failed"],
    );
  });
});

describe("legend-pti5r T2 kopi dilaporkan ulang setelah gagal final: replay", () => {
  it.each(FINAL_REASONS)(
    "%s: refund baru sama dengan filing pertama (jumlah dan split order.refunded); ledger tidak berubah",
    async (reason) => {
      const { paid, kopi, refundId } = await kopiRefundFiled();
      await failFinally(refundId, reason);
      expect(await ledger(paid.order.id)).toEqual({
        paid: KOPI_PAYOUT,
        subtotal: KOPI_SUBTOTAL,
      });

      // The guest still needs the money: the kitchen reports the line again.
      const again = await approvedRefund(paid.kopi.id, 25_000);
      expect(again.issueId).not.toBe(kopi.issueId);
      await deliver(again.event);

      const refunds = await issueRefunds(again.issueId);
      expect(refunds.map((row) => row.amount_idr)).toEqual([KOPI_REFUND]);
      expect(
        await auditRows([again.issueId], "order_issue.refund_blocked"),
      ).toEqual([]);
      const events = await refundedEvents(paid.order.id);
      expect(events).toHaveLength(2);
      expect(events[0]!.refundId).toBe(kopi.issueId);
      expect(events[1]!.refundId).toBe(again.issueId);
      expect(events[0]!.grossSalesIdr).toBe(25_000);
      expect(events[0]!.discountIdr).toBe(18_000);
      for (const field of [
        "amountIdr",
        "grossSalesIdr",
        "discountIdr",
        "serviceChargeIdr",
        "pbjtIdr",
      ] as const) {
        expect(events[1]![field], field).toBe(events[0]![field]);
      }
      // No second payout on the promo ledger, none recorded for the new issue.
      expect(await ledger(paid.order.id)).toEqual({
        paid: KOPI_PAYOUT,
        subtotal: KOPI_SUBTOTAL,
      });
      expect(await filingPayout(again.issueId)).toBe(0);
    },
  );

  it("filing ulang dikirim dua kali untuk issue baru: tetap satu refund dan satu order.refunded", async () => {
    const { paid, refundId } = await kopiRefundFiled();
    await failFinally(refundId, "provider_declined");
    const again = await approvedRefund(paid.kopi.id, 25_000);

    await deliver(again.event);
    await deliver(again.event);

    expect(await issueRefunds(again.issueId)).toHaveLength(1);
    expect(await refundedEvents(paid.order.id)).toHaveLength(2);
    expect((await ledger(paid.order.id)).paid).toBe(KOPI_PAYOUT);
  });
});

describe("legend-pti5r T3 roti setelah kopi gagal final", () => {
  it("roti mendapat jumlahnya sendiri 20.790 (urutan asli kopi lalu roti), bukan kopi + roti", async () => {
    const { paid, refundId } = await kopiRefundFiled();
    await failFinally(refundId, "provider_declined");

    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(roti.event);

    expect(
      (await issueRefunds(roti.issueId)).map((row) => row.amount_idr),
    ).toEqual([ROTI_REFUND_AFTER_KOPI]);
    expect(await filingPayout(roti.issueId)).toBe(ROTI_PAYOUT_AFTER_KOPI);
    expect((await ledger(paid.order.id)).paid).toBe(
      KOPI_PAYOUT + ROTI_PAYOUT_AFTER_KOPI,
    );
  });
});

describe("legend-pti5r T4 payout tetap bila uang tidak terutang", () => {
  it("rejected: ledger tidak berubah; lapor ulang tetap nothing_left", async () => {
    const { paid, refundId } = await kopiRefundFiled();

    await failFinally(refundId, "rejected");

    expect(await ledger(paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
    const again = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(again.event);
    expect(await issueRefunds(again.issueId)).toEqual([]);
    expectBlocked(
      await auditRows([again.issueId], "order_issue.refund_blocked"),
    );
    expect(await ledger(paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
  });

  it("approval_expired (diajukan ulang, bukan final): ledger tidak berubah", async () => {
    const { paid, refundId } = await kopiRefundFiled();

    await failFinally(refundId, "approval_expired");

    expect(await ledger(paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
  });
});

describe("legend-pti5r T5 idempotent", () => {
  it("hook dijalankan dua kali untuk refund gagal yang sama: ledger dan outbox sama seperti sekali", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled();
    await setFailed(refundId, "provider_declined");

    await runHook(refundId);
    const afterOnce = {
      ledger: await ledger(paid.order.id),
      refunded: (await refundedEvents(paid.order.id)).length,
      reversals: (await reversalRequests(kopi.issueId)).length,
      refunds: (await issueRefunds(kopi.issueId)).length,
    };
    await runHook(refundId);

    expect(afterOnce.ledger).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
    expect({
      ledger: await ledger(paid.order.id),
      refunded: (await refundedEvents(paid.order.id)).length,
      reversals: (await reversalRequests(kopi.issueId)).length,
      refunds: (await issueRefunds(kopi.issueId)).length,
    }).toEqual(afterOnce);
  });
});

describe("legend-pti5r T6 dua issue pada satu pesanan promo", () => {
  it("satu gagal final, satu masih berjalan: refund yang berjalan dan ledger tidak terpengaruh", async () => {
    const paid = await paidPromoOrder();
    const kopi = await approvedRefund(paid.kopi.id, 25_000);
    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(kopi.event);
    await deliver(roti.event);
    const kopiRefund = (await issueRefunds(kopi.issueId))[0]!;
    const rotiRefund = (await issueRefunds(roti.issueId))[0]!;
    expect(await filingPayout(kopi.issueId)).toBe(KOPI_PAYOUT);
    expect(await filingPayout(roti.issueId)).toBe(ROTI_PAYOUT_AFTER_KOPI);
    const before = await ledger(paid.order.id);
    expect(before.paid).toBe(KOPI_PAYOUT + ROTI_PAYOUT_AFTER_KOPI);

    await failFinally(kopiRefund.id, "provider_declined");

    expect(await ledger(paid.order.id)).toEqual(before);
    expect(
      (await issueRefunds(roti.issueId)).map((row) => [
        row.id,
        row.amount_idr,
        row.status,
      ]),
    ).toEqual([[rotiRefund.id, ROTI_REFUND_AFTER_KOPI, rotiRefund.status]]);
    expect(rotiRefund.status).not.toBe("failed");
    expect(await reversalRequests(roti.issueId)).toHaveLength(0);
  });
});

async function seedApplication(input: {
  tenantId: string;
  outletId: string;
  orderId: string;
  refundedPaidIdr: number;
  refundedSubtotalIdr: number;
}) {
  await asOwnerTenant(input.tenantId, (client) =>
    client.query(
      `INSERT INTO promotion_order_applications
         (tenant_id, outlet_id, order_id, request_fingerprint, channel, subtotal_idr,
          total_discount_idr, paid_idr, refunded_paid_idr, refunded_subtotal_idr, result,
          status)
       VALUES ($1, $2, $3, $4, 'dine_in', 50000, 10000, 40000, $5, $6, '{}'::jsonb, 'applied')`,
      [
        input.tenantId,
        input.outletId,
        toUuid(input.orderId),
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        input.refundedPaidIdr,
        input.refundedSubtotalIdr,
      ],
    ),
  );
}

describe("legend-pti5r T7 isolasi tenant", () => {
  it("kegagalan final di tenant A tidak menyentuh aplikasi promo tenant B untuk id pesanan yang sama", async () => {
    const other = await createIsolatedTenant(
      `pti5r-${randomUUID().slice(0, 6)}`,
    );
    const { paid, refundId } = await kopiRefundFiled();
    await seedApplication({
      tenantId: other.tenantId,
      outletId: other.outletId,
      orderId: paid.order.id,
      refundedPaidIdr: 5_000,
      refundedSubtotalIdr: 9_000,
    });

    await failFinally(refundId, "provider_declined");

    expect(await ledgerOf(other.tenantId, paid.order.id)).toEqual({
      paid: 5_000,
      subtotal: 9_000,
    });
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
  });
});

describe("legend-pti5r T8 replay dibatasi room intent", () => {
  it("room 4.735 < 8.085: refund dipotong ke room, selisih diaudit, split diskalakan dan tetap berjumlah sama", async () => {
    const { paid, refundId } = await kopiRefundFiled();
    await failFinally(refundId, "provider_declined");
    const { rows } = await owner.query<{ payment_intent_id: string }>(
      "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(paid.order.id)],
    );
    // Another issue (teh, never resolved) already holds a pending refund of
    // 38.000: room = 42.735 - 38.000 = 4.735 (the final-failed kopi holds none).
    const holder = (await w.report(paid.teh.id)).body.data.id as string;
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, order_issue_id, amount_idr,
          reason, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 38000, 'Refund uji room', 'pending', 'user-uji')`,
      [
        randomUUID(),
        w.tenant.tenantId,
        w.tenant.outletId,
        rows[0]!.payment_intent_id,
        holder,
      ],
    );

    const again = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(again.event);

    const refunds = await issueRefunds(again.issueId);
    expect(refunds.map((row) => row.amount_idr)).toEqual([4_735]);
    const shortfall = await auditRows(
      [again.issueId],
      "order_issue.refund_shortfall",
    );
    expect(shortfall).toHaveLength(1);
    expect(JSON.stringify(shortfall[0])).toContain(`${KOPI_REFUND - 4_735}`);
    expect(
      await auditRows([again.issueId], "order_issue.refund_blocked"),
    ).toEqual([]);
    const events = await refundedEvents(paid.order.id);
    const replay = events.find((event) => event.refundId === again.issueId)!;
    expect(replay.amountIdr).toBe(4_735);
    expect(replay.grossSalesIdr).toBeLessThan(25_000);
    expect(
      replay.grossSalesIdr -
        replay.discountIdr +
        replay.serviceChargeIdr +
        replay.pbjtIdr,
    ).toBe(4_735);
    expect(await ledger(paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
  });
});
