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
// - T9 (round 4) open-bill promo order (no `order.refunded`, no split): kopi
//   final-fails, kopi reported again: refunds the failed amount, not nothing_left;
//   ledger unchanged.
// - T10 (round 4) chain A -> B (replay cut by room) -> B final-fails -> C: C asks the
//   ROOT's (A's) full amount, capped by the room at that time (shortfall audited).
//   Variant on the open-bill order (T10 open bill): same chain, no split and no
//   order.refunded; C's stored replayOfIssueId is A.
// - T11 (round 4) `refile_limit` (3 expired approval chains) is a final failure too:
//   re-report replays. Its describe is LAST in the file because it inserts a
//   refund approval policy for the tenant (needed to open approval chains).
// - `unknown` is in the final-reason list (FINAL_REASONS), so T2 covers it.
//
// Assumptions where the brief is not exact:
// - `refile_limit` is exercised in T11 only: it needs the approval chain machinery
//   (approval policy + `settleRefundFromChain`, as order-recovery-refund-final-failure
//   .test.ts does); the other reasons use `setFailed`.
// - T9: the open-bill checkout applies the same auto promotion as pay-first
//   (the promo application exists), and the first filing records a payout on the
//   ledger; exact amounts are read from the first filing, not hard-coded.
// - T10: the replay of an earlier replay follows back to the root: C's amount is
//   A's 8.085 capped by the room, stored `replayOfIssueId` is A's issue (root).
// - T10 open bill: A's amount and the order total are read from the DB; rooms are
//   set relative to A's amount (B: half of it; C: A's amount +1.000 or -1.000).
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
import { originHeader } from "./helpers.ts";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverOrderRecoveryRefundEvent,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
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
const FINAL_REASONS = [
  "provider_declined",
  "cap_exceeded",
  "source_document",
  "unknown",
];

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

// "unknown" is how the hook reads a NULL failure_reason (`?? "unknown"`); the
// column's check constraint does not accept the literal.
async function setFailed(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = NULLIF($3, 'unknown'), decided_at = now()
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

// ---- round 4 ----------------------------------------------------------------

async function filingResponse(
  issueId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  expect(rows, "filing idempotency row").toHaveLength(1);
  return rows[0]!.response;
}

/**
 * Another issue (never resolved) holds a pending refund of `amountIdr` on the
 * order's intent; returns the refund id so a test can change the room later.
 */
async function holdRoom(
  orderId: string,
  otherItemId: string,
  amountIdr: number,
): Promise<string> {
  const { rows } = await owner.query<{ payment_intent_id: string }>(
    "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(orderId)],
  );
  const holder = (await w.report(otherItemId)).body.data.id as string;
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, order_issue_id, amount_idr,
        reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'Refund uji room', 'pending', 'user-uji')`,
    [
      refundId,
      w.tenant.tenantId,
      w.tenant.outletId,
      rows[0]!.payment_intent_id,
      holder,
      amountIdr,
    ],
  );
  return refundId;
}

/**
 * A paid OPEN-BILL order kopi + teh + roti with the live promo applied. The bill
 * is settled by a paid intent with evidence (rows inserted directly, as the
 * cashier flow leaves it; the guest cannot pay an open bill through the API).
 */
async function paidPromoOpenBill() {
  const guest = await w.seat("open_bill");
  // The first order of an open-bill session waits for a waiter's confirmation.
  const confirmed = await w.floorStaff.client
    .post(`/api/table-sessions/${guest.sessionId}/confirm`)
    .set(w.headers)
    .set(originHeader);
  expect(confirmed.status).toBe(200);
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
  const orderId = toUuid(order.id);
  const { rows } = await owner.query<{ outlet_id: string; total_idr: number }>(
    "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId],
  );
  const { outlet_id: outletId, total_idr: total } = rows[0]!;
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'pti5r-test')`,
    [
      linkId,
      w.tenant.tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `OB-${linkId.slice(0, 8)}`,
      total,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
             '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
             now() + interval '1 hour', now())`,
    [
      intentId,
      w.tenant.tenantId,
      outletId,
      linkId,
      orderId,
      total,
      `ob-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [w.tenant.tenantId, outletId, intentId, `evidence-${intentId}`, total],
  );
  await owner.query(
    "UPDATE orders SET payment_intent_id = $3 WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId, intentId],
  );
  return {
    order,
    kopi: order.items.find((item) => item.menuItemId === w.ids.kopi)!,
  };
}

describe("legend-pti5r T9 pesanan open bill dengan promo", () => {
  it.each(FINAL_REASONS)(
    "%s: kopi dilaporkan ulang direfund sebesar refund yang gagal (bukan nothing_left); ledger tidak berubah",
    async (reason) => {
      const paid = await paidPromoOpenBill();
      const first = await approvedRefund(paid.kopi.id, 25_000);
      await deliver(first.event);
      const firstRefunds = await issueRefunds(first.issueId);
      expect(firstRefunds).toHaveLength(1);
      const wanted = firstRefunds[0]!.amount_idr;
      expect(wanted, "first filing refunds money").toBeGreaterThan(0);
      const ledgerAfterFirst = await ledger(paid.order.id);
      expect(ledgerAfterFirst.paid, "payout recorded").toBeGreaterThan(0);

      await failFinally(firstRefunds[0]!.id, reason);
      expect(await ledger(paid.order.id)).toEqual(ledgerAfterFirst);

      const again = await approvedRefund(paid.kopi.id, 25_000);
      expect(again.issueId).not.toBe(first.issueId);
      await deliver(again.event);

      expect(
        (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
      ).toEqual([wanted]);
      expect(
        await auditRows([again.issueId], "order_issue.refund_blocked"),
      ).toEqual([]);
      // Open bill files no split and no order.refunded, replay or not.
      expect(await refundedEvents(paid.order.id)).toHaveLength(0);
      expect(await ledger(paid.order.id)).toEqual(ledgerAfterFirst);
      expect(await filingPayout(again.issueId)).toBe(0);
    },
  );
});

describe("legend-pti5r T10 rantai A -> B (dipotong room) -> B gagal final -> C", () => {
  it.each([
    // Room for C = 42.735 - holder.
    { holder: 34_000, expected: KOPI_REFUND, capped: false }, // room 8.735
    { holder: 36_000, expected: 6_735, capped: true }, // room 6.735
  ])(
    "holder $holder: C meminta jumlah A (root) penuh dibatasi room saat itu = $expected",
    async ({ holder, expected, capped }) => {
      const { paid, kopi: a, refundId } = await kopiRefundFiled();
      await failFinally(refundId, "provider_declined");
      // Another issue holds 38.000: room 4.735 for B.
      const holderRefundId = await holdRoom(paid.order.id, paid.teh.id, 38_000);

      const b = await approvedRefund(paid.kopi.id, 25_000);
      await deliver(b.event);
      const bRefunds = await issueRefunds(b.issueId);
      expect(bRefunds.map((row) => row.amount_idr)).toEqual([4_735]);
      expect(await filingResponse(b.issueId)).toMatchObject({
        replayOfIssueId: a.issueId,
      });

      // B fails finally too; meanwhile the other issue's hold shrinks.
      await failFinally(bRefunds[0]!.id, "provider_declined");
      await owner.query(
        `UPDATE payment_refunds SET amount_idr = $3 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, holderRefundId, holder],
      );

      const c = await approvedRefund(paid.kopi.id, 25_000);
      await deliver(c.event);

      expect(
        (await issueRefunds(c.issueId)).map((row) => row.amount_idr),
      ).toEqual([expected]);
      expect(
        await auditRows([c.issueId], "order_issue.refund_blocked"),
      ).toEqual([]);
      const shortfall = await auditRows(
        [c.issueId],
        "order_issue.refund_shortfall",
      );
      if (capped) {
        expect(shortfall).toHaveLength(1);
        expect(JSON.stringify(shortfall[0])).toContain(
          `${KOPI_REFUND - expected}`,
        );
      } else {
        expect(shortfall).toEqual([]);
      }
      const events = await refundedEvents(paid.order.id);
      const original = events.find((event) => event.refundId === a.issueId)!;
      const last = events.find((event) => event.refundId === c.issueId)!;
      expect(last.amountIdr).toBe(expected);
      if (capped) {
        expect(last.grossSalesIdr).toBeLessThan(original.grossSalesIdr);
      } else {
        for (const field of [
          "amountIdr",
          "grossSalesIdr",
          "discountIdr",
          "serviceChargeIdr",
          "pbjtIdr",
        ] as const) {
          expect(last[field], field).toBe(original[field]);
        }
      }
      expect(
        last.grossSalesIdr -
          last.discountIdr +
          last.serviceChargeIdr +
          last.pbjtIdr,
      ).toBe(expected);
      // The root is stored, not the intermediate replay.
      expect(await filingResponse(c.issueId)).toMatchObject({
        replayOfIssueId: a.issueId,
      });
      expect(await ledger(paid.order.id)).toEqual({
        paid: KOPI_PAYOUT,
        subtotal: KOPI_SUBTOTAL,
      });
    },
  );
});

describe("legend-pti5r T10 varian open bill: rantai A -> B (dipotong room) -> B gagal final -> C", () => {
  // Amounts are read from the first filing and the order total, not hard-coded:
  // the open-bill figures are not fixed by the brief. Room offsets are relative
  // to A's amount (`wanted`).
  it.each([
    { name: "room cukup", capDelta: 1_000, capped: false },
    { name: "room terpotong lagi", capDelta: -1_000, capped: true },
  ])(
    "$name: C meminta jumlah A (root) penuh dibatasi room saat itu; replayOfIssueId = A",
    async ({ capDelta, capped }) => {
      const paid = await paidPromoOpenBill();
      const teh = paid.order.items.find(
        (item) => item.menuItemId === w.ids.teh,
      )!;
      const { rows: totals } = await owner.query<{ total_idr: number }>(
        "SELECT total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, toUuid(paid.order.id)],
      );
      const total = totals[0]!.total_idr;

      // A: first filing refunds `wanted`, then fails finally.
      const a = await approvedRefund(paid.kopi.id, 25_000);
      await deliver(a.event);
      const aRefunds = await issueRefunds(a.issueId);
      expect(aRefunds).toHaveLength(1);
      const wanted = aRefunds[0]!.amount_idr;
      // Needed so that B's cut (wanted / 2) is below both rooms for C.
      expect(wanted, "first filing refunds money").toBeGreaterThan(2_000);
      const ledgerAfterFirst = await ledger(paid.order.id);
      expect(ledgerAfterFirst.paid, "payout recorded").toBeGreaterThan(0);
      await failFinally(aRefunds[0]!.id, "provider_declined");

      // B: another issue holds the rest of the intent, leaving a room of
      // `cutB` < wanted, so B's replay is cut by room.
      const cutB = Math.floor(wanted / 2);
      const holderRefundId = await holdRoom(
        paid.order.id,
        teh.id,
        total - cutB,
      );
      const b = await approvedRefund(paid.kopi.id, 25_000);
      await deliver(b.event);
      const bRefunds = await issueRefunds(b.issueId);
      expect(bRefunds.map((row) => row.amount_idr)).toEqual([cutB]);
      expect(await filingResponse(b.issueId)).toMatchObject({
        replayOfIssueId: a.issueId,
      });

      // B fails finally too; meanwhile the other issue's hold changes the room.
      await failFinally(bRefunds[0]!.id, "provider_declined");
      const roomForC = wanted + capDelta;
      const expected = Math.min(wanted, roomForC);
      await owner.query(
        `UPDATE payment_refunds SET amount_idr = $3 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, holderRefundId, total - roomForC],
      );

      const c = await approvedRefund(paid.kopi.id, 25_000);
      expect(c.issueId).not.toBe(b.issueId);
      await deliver(c.event);

      // C asks the root's full amount (not B's cut), capped by the room now.
      expect(
        (await issueRefunds(c.issueId)).map((row) => row.amount_idr),
      ).toEqual([expected]);
      expect(
        await auditRows([c.issueId], "order_issue.refund_blocked"),
      ).toEqual([]);
      const shortfall = await auditRows(
        [c.issueId],
        "order_issue.refund_shortfall",
      );
      if (capped) {
        expect(shortfall).toHaveLength(1);
        expect(JSON.stringify(shortfall[0])).toContain(`${wanted - expected}`);
      } else {
        expect(shortfall).toEqual([]);
      }
      // The root is stored, not the intermediate replay.
      expect(await filingResponse(c.issueId)).toMatchObject({
        replayOfIssueId: a.issueId,
      });
      // Open bill files no split and no order.refunded, replay or not.
      expect(await refundedEvents(paid.order.id)).toHaveLength(0);
      expect(await ledger(paid.order.id)).toEqual(ledgerAfterFirst);
      expect(await filingPayout(b.issueId)).toBe(0);
      expect(await filingPayout(c.issueId)).toBe(0);
    },
  );
});

// LAST describe of the file: it adds a refund approval policy for the tenant so
// refunds open approval chains (expiring a chain fails the refund; the third
// failure is `refile_limit`).
describe("legend-pti5r T11 refile_limit adalah gagal final", () => {
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', 0, $2, 1)`,
      [w.tenant.tenantId, w.ids.supervisorRole],
    );
  });

  it("tiga kali approval kedaluwarsa: kopi dilaporkan ulang direfund jumlah yang sama; ledger tidak berubah", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled();
    const context = contextOf(w.tenant.tenantId);
    let currentId = refundId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await owner.query(
        "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
        [w.tenant.tenantId, currentId],
      );
      const settled = await settleRefundFromChain(context, currentId);
      expect(settled.status).toBe("failed");
      const refunds = await issueRefunds(kopi.issueId);
      // Failures 1 and 2 re-file; the third is final (no fourth refund).
      expect(refunds, `refunds after failure ${attempt}`).toHaveLength(
        Math.min(attempt + 1, 3),
      );
      if (attempt < 3)
        currentId = refunds.find((row) => row.status === "pending")!.id;
    }
    const refunds = await issueRefunds(kopi.issueId);
    expect(refunds.every((row) => row.status === "failed")).toBe(true);
    const failedAmount = refunds[2]!.amount_idr;
    const { rows: stamped } = await owner.query<{
      refund_rejected_at: Date | null;
    }>(
      "SELECT refund_rejected_at FROM order_issues WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, kopi.issueId],
    );
    expect(stamped[0]!.refund_rejected_at).not.toBeNull();
    const before = await ledger(paid.order.id);

    const again = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(again.event);

    expect(
      (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
    ).toEqual([failedAmount]);
    expect(
      await auditRows([again.issueId], "order_issue.refund_blocked"),
    ).toEqual([]);
    expect(await ledger(paid.order.id)).toEqual(before);
    expect(await filingPayout(again.issueId)).toBe(0);
  });
});
