// legend-k0ub4: a swap on a COMPLETED order writes a replacement line worth Rp0 (the
// old line keeps its value). When that replacement line fails and its manual refund
// is approved, the refund is capped by the line value (0) and ends in
// `refund_blocked nothing_left`. On a promo order the failure recompute takes the
// kopi out of the promo, but the goods of the kopi (Rp7.000 paid, Rp25.000 subtotal)
// must reach the promo ledger (`promotion_order_applications.refunded_paid_idr`),
// otherwise a later refund of another line (roti) pays that share too and the outlet
// pays more than it took. Written FIRST: the ledger cases below fail until the fix.
// Contract: docs/briefs/sub-k0ub4-zero-replacement.md (rule: nobody is paid more).
//
// Story (same promo order as the pti5r and fwe4l tests: kopi + teh + roti, "buy 2 of
// {kopi, teh}, get 1 roti free", order total 42.735): the order is completed, the kopi
// is swapped to air (replacement line Rp0, voucher Rp20.000 not under test), the air
// line fails, the manual refund (ORD-09 approval) is delivered.
//
// Assumptions where the brief is not exact:
// - A manual refund of a Rp0 line cannot be approved through the API: ORD-09 wants
//   the approval to equal the line total (0) and the event payload refuses amount 0
//   (both 422). The test grants the approval (Rp5.000, the catalog price of air)
//   while the line is temporarily priced at Rp5.000 and puts the line back to Rp0
//   before the event is delivered to the consumer.
// - "Refund roti equals the refund when the kopi is refunded normally": the reference
//   is the pti5r world (kopi refund 8.085 with goods 7.000, then roti 20.790 with
//   goods 18.000, ledger 25.000). Both numbers are pinned, and the two worlds are
//   also compared to each other in the same test.
// - "Remaining funds after the promo share of the origin item" = order total 42.735
//   minus the kopi refund a normal kopi refund would pay (8.085) = 34.650; the roti
//   refund after the nothing_left must stay within it.
// - The ledger is pinned only on `refunded_paid_idr` (goods 7.000, then 25.000); the
//   subtotal column is not pinned.
// - Idempotency: the nothing_left event delivered twice leaves the ledger and the
//   audit (one `refund_blocked` row) as after the first delivery.
// - Without promo nothing changes: nothing_left, no ledger row, roti 20.790.
// - Tenant isolation: another tenant's application with the same order id keeps its
//   numbers (one assertion in the main case).

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
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
import { confirmPayment } from "../services/payment.service.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
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
/** Rp5.000 item in no promotion: the cheaper replacement of the kopi. */
const airItem = randomUUID();
const AIR_PRICE = 5_000;
const KOPI_PRICE = 25_000;
const ORDER_TOTAL = 42_735;
const KOPI_REFUND = 8_085;
const KOPI_PAYOUT = 7_000;
const ROTI_PRICE = 18_000;
/** Roti refund after the kopi has left the promo (T3 of the promo final-failure tests). */
const ROTI_REFUND_AFTER_KOPI = 20_790;
const ROTI_PAYOUT = 18_000;

beforeAll(async () => {
  w = await createWorld();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    // Auto promotion (no code): buy 2 of {kopi, teh}, get 1 roti free.
    await client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, 'Beli 2 minuman gratis roti', '', 'active', NULL, false,
               now() - interval '1 hour', NULL, $3, $4, 'g_k0ub4', true, 0, NULL, NULL, NULL)`,
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
       VALUES ($1, $2, $3, $4, 'Air Mineral Swap', true, $5)`,
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
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), w.tenant.tenantId, w.ids.priceList, airItem, AIR_PRICE],
    );
  });
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";

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

type PaidOrder = {
  order: { id: string; items: { id: string; menuItemId: string }[] };
  total: number;
  line: (menuItemId: string) => { id: string; menuItemId: string };
};

/** Seats a guest, adds one of each item, checks out. */
async function placeLines(
  mode: "pay_first" | "open_bill",
  menuItemIds: string[],
) {
  const guest = await w.seat(mode);
  if (mode === "open_bill") {
    // The first order of an open-bill session waits for a waiter's confirmation.
    const confirmed = await w.floorStaff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(w.headers)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
  }
  let version = 0;
  for (const menuItemId of menuItemIds) {
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
  const order = placed.body.data.order as PaidOrder["order"];
  const { rows } = await owner.query<{ outlet_id: string; total_idr: number }>(
    "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(order.id)],
  );
  return {
    guest,
    order,
    outletId: rows[0]!.outlet_id,
    total: rows[0]!.total_idr,
    line: (menuItemId: string) =>
      order.items.find((item) => item.menuItemId === menuItemId)!,
  };
}

/**
 * A PAID promo order kopi + teh + roti. Pay-first: the guest pays through the API
 * and the verified webhook settles it. Open bill: the bill is settled by a paid
 * intent with evidence (rows inserted directly, as the cashier flow leaves it).
 */
async function paidPromoOrder(
  mode: "pay_first" | "open_bill",
): Promise<PaidOrder> {
  const placed = await placeLines(mode, [w.ids.kopi, w.ids.teh, w.ids.roti]);
  if (mode === "pay_first") {
    expect(placed.total, "promo order total").toBe(ORDER_TOTAL);
    const payment = await w
      .as(placed.guest)
      .pay({ kind: "order", orderId: placed.order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
    return placed;
  }
  const orderId = toUuid(placed.order.id);
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'k0ub4-test')`,
    [
      linkId,
      w.tenant.tenantId,
      placed.outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `OB-${linkId.slice(0, 8)}`,
      placed.total,
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
      placed.outletId,
      linkId,
      orderId,
      placed.total,
      `ob-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      w.tenant.tenantId,
      placed.outletId,
      intentId,
      `evidence-${intentId}`,
      placed.total,
    ],
  );
  await owner.query(
    "UPDATE orders SET payment_intent_id = $3 WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId, intentId],
  );
  return placed;
}

/** Resolves an open issue `manual_refund` with an approved approval; returns the event. */
async function resolveForRefund(issueId: string, amountIdr: number) {
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
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.event;
}

/** Reports one line as failed and resolves it with an approved ORD-09 refund. */
async function approvedRefund(itemId: string, amountIdr: number) {
  const reported = await w.report(itemId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  const issueId = reported.body.data.id as string;
  return { issueId, event: await resolveForRefund(issueId, amountIdr) };
}

type RefundRow = { id: string; amount_idr: number; status: string };

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
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

async function refundedEvents(orderId: string) {
  return (await w.outboxRows("order.refunded", orderId)).map((row) =>
    orderRefundedPayloadSchema.parse(row.event.payload),
  );
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

async function failFinally(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
  await runHook(refundId);
}

/** Files the refund of one line and returns the issue and its single refund row. */
async function filedRefund(itemId: string, amountIdr: number) {
  const made = await approvedRefund(itemId, amountIdr);
  await deliver(made.event);
  const refunds = await issueRefunds(made.issueId);
  expect(refunds, "first filing makes one refund").toHaveLength(1);
  return { ...made, refund: refunds[0]! };
}

/** Reports one line and swaps it to `replacementItemId`; the kitchen event writes the replacement line. */
async function swapLineTo(lineId: string, replacementItemId: string) {
  const swapIssue = await w.report(lineId);
  expect(swapIssue.status, JSON.stringify(swapIssue.body)).toBe(201);
  const swapIssueId = swapIssue.body.data.id as string;
  const swapped = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${swapIssueId}/resolve`,
    { resolution: "swap", replacementItemId },
  );
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  const resolved = await w.outboxRows("order_issue.resolved", swapIssueId);
  expect(resolved).toHaveLength(1);
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, resolved[0]!.event, tx),
  );
  const { rows } = await owner.query<{ id: string | null }>(
    "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, swapIssueId],
  );
  expect(rows[0]!.id, "replacement line written").not.toBeNull();
  return { swapIssueId, replacementLineId: uuidToUlid(rows[0]!.id!) };
}

/** Pays an order of `menuItemIds` (pay-first) through the HTTP flow. */
async function paidOrderOf(menuItemIds: string[]) {
  const placed = await placeLines("pay_first", menuItemIds);
  const payment = await w
    .as(placed.guest)
    .pay({ kind: "order", orderId: placed.order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
  return placed;
}

/**
 * A COMPLETED order whose kopi is swapped to air: the replacement line is worth Rp0
 * and the kopi line keeps its value. The replacement line fails and its manual refund
 * (see below) is approved; the returned event is NOT delivered.
 */
async function completedZeroReplacement(
  menuItemIds: string[],
  options: {
    mode?: "pay_first" | "open_bill";
    replacement?: string;
    kopiFailedFirst?: boolean;
  } = {},
) {
  const placed =
    options.mode === "open_bill"
      ? await paidPromoOrder("open_bill")
      : await paidOrderOf(menuItemIds);
  const orderUuid = toUuid(placed.order.id);
  if (options.kopiFailedFirst) {
    const a = await filedRefund(placed.line(w.ids.kopi).id, KOPI_PRICE);
    await failFinally(a.refund.id, "provider_declined");
  }
  await owner.query(
    "UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderUuid],
  );
  const { replacementLineId } = await swapLineTo(
    placed.line(w.ids.kopi).id,
    options.replacement ?? airItem,
  );
  const { rows } = await owner.query<{ total: number }>(
    `SELECT line_total_idr::int AS total FROM order_items
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(replacementLineId)],
  );
  expect(rows[0]!.total, "replacement line is worth Rp0").toBe(0);
  // ORD-09 refuses an approval that is not the line total, and the event payload
  // refuses amount 0, so a manual refund of a Rp0 line cannot be approved through the
  // API. The approval is therefore granted while the line carries the air price, and
  // the line is put back to Rp0 before the event reaches the consumer. A database
  // rule freezes the lines of a final order, so the two writes bypass triggers
  // (session_replication_role = replica), as other tests of this repo do.
  const lineValue = async (unit: number) => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE order_items SET unit_price_idr = $3::int, line_total_idr = $3::int * quantity
          WHERE tenant_id = $1 AND id = $2`,
        [w.tenant.tenantId, toUuid(replacementLineId), unit],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const reported = await w.report(replacementLineId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  const issueId = reported.body.data.id as string;
  await lineValue(AIR_PRICE);
  const event = await resolveForRefund(issueId, AIR_PRICE);
  await lineValue(0);
  const failed = { issueId, event };
  return { placed, replacementLineId, ...failed };
}

function expectBlockedOnce(blocked: Record<string, unknown>[]) {
  expect(blocked).toHaveLength(1);
  expect(JSON.stringify(blocked[0])).toContain("nothing_left");
}

describe("legend-k0ub4 order promo completed: kopi di-swap (pengganti Rp0) lalu pengganti gagal", () => {
  it("nothing_left mencatat goods kopi 7.000 ke ledger; refund roti sesudahnya = refund roti bila kopi direfund normal (20.790), total <= sisa dana; tenant lain tidak tersentuh", async () => {
    // Reference world: the kopi is refunded normally (8.085, goods 7.000), then roti.
    const refPaid = await paidPromoOrder("pay_first");
    const refKopi = await filedRefund(refPaid.line(w.ids.kopi).id, KOPI_PRICE);
    expect(refKopi.refund.amount_idr).toBe(KOPI_REFUND);
    const refRoti = await filedRefund(refPaid.line(w.ids.roti).id, ROTI_PRICE);
    expect(refRoti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect(await ledgerOf(w.tenant.tenantId, refPaid.order.id)).toMatchObject({
      paid: KOPI_PAYOUT + ROTI_PAYOUT,
    });

    // Swap world.
    const other = await createIsolatedTenant(
      `k0ub4-${randomUUID().slice(0, 6)}`,
    );
    const { placed, issueId, event } = await completedZeroReplacement([
      w.ids.kopi,
      w.ids.teh,
      w.ids.roti,
    ]);
    expect(placed.total, "promo order total").toBe(ORDER_TOTAL);
    await asOwnerTenant(other.tenantId, (client) =>
      client.query(
        `INSERT INTO promotion_order_applications
           (tenant_id, outlet_id, order_id, request_fingerprint, channel, subtotal_idr,
            total_discount_idr, paid_idr, refunded_paid_idr, refunded_subtotal_idr, result,
            status)
         VALUES ($1, $2, $3, $4, 'dine_in', 50000, 10000, 40000, 5000, 9000, '{}'::jsonb, 'applied')`,
        [
          other.tenantId,
          other.outletId,
          toUuid(placed.order.id),
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
        ],
      ),
    );

    await deliver(event);

    // The replacement line is worth nothing: no refund, blocked nothing_left.
    expect(await issueRefunds(issueId), "no refund for a Rp0 line").toEqual([]);
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect(await w.outboxRows("order.refunded", placed.order.id)).toHaveLength(
      0,
    );
    // The kopi left the promo: its goods are on the ledger (Rp7.000 paid).
    expect(
      (await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid,
      "ledger holds the goods of the kopi",
    ).toBe(KOPI_PAYOUT);

    // Roti afterwards: exactly what it is owed when the kopi was refunded normally.
    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect(roti.refund.amount_idr).toBe(refRoti.refund.amount_idr);
    const refunded = await refundedEvents(placed.order.id);
    expect(refunded, "only the roti refund was paid").toHaveLength(1);
    expect(refunded[0]).toMatchObject({
      refundId: roti.issueId,
      amountIdr: ROTI_REFUND_AFTER_KOPI,
    });
    // The kopi is not paid again: the ledger ends at kopi goods + roti goods.
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT + ROTI_PAYOUT,
    );
    // Total paid out stays within the funds left after the kopi's promo share.
    expect(ROTI_REFUND_AFTER_KOPI).toBeLessThanOrEqual(
      ORDER_TOTAL - KOPI_REFUND,
    );

    // Another tenant's application with the same order id keeps its numbers.
    expect(await ledgerOf(other.tenantId, placed.order.id)).toEqual({
      paid: 5_000,
      subtotal: 9_000,
    });
  });

  it("event nothing_left dikirim ulang: ledger tidak bertambah dua kali, audit tetap satu, refund roti tetap 20.790", async () => {
    const { placed, issueId, event } = await completedZeroReplacement([
      w.ids.kopi,
      w.ids.teh,
      w.ids.roti,
    ]);

    await deliver(event);
    const ledgerOnce = await ledgerOf(w.tenant.tenantId, placed.order.id);
    expect(ledgerOnce?.paid, "first delivery records the goods once").toBe(
      KOPI_PAYOUT,
    );

    await deliver(event);
    await deliver(event);
    expect(await ledgerOf(w.tenant.tenantId, placed.order.id)).toEqual(
      ledgerOnce,
    );
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect(await issueRefunds(issueId)).toEqual([]);

    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT + ROTI_PAYOUT,
    );
  });

  it("order tanpa promo dengan swap Rp0: tidak berubah (nothing_left, tanpa ledger, replay aman, roti 20.790)", async () => {
    const { placed, issueId, event } = await completedZeroReplacement([
      w.ids.kopi,
      w.ids.roti,
    ]);

    await deliver(event);
    expect(await issueRefunds(issueId)).toEqual([]);
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect(await ledgerOf(w.tenant.tenantId, placed.order.id)).toBeNull();

    await deliver(event);
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect(await ledgerOf(w.tenant.tenantId, placed.order.id)).toBeNull();

    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect(await ledgerOf(w.tenant.tenantId, placed.order.id)).toBeNull();
  });
});

describe("legend-k0ub4 temuan architect: ruang refund lebih kecil dari goods kopi", () => {
  // Assumption: "room smaller than the kopi goods" is made with the pattern of the
  // pti5r T8 test: another issue (teh, never resolved) holds a pending refund of
  // 38.000 on the order's intent, so the room is 42.735 - 38.000 = 4.735 < 7.000
  // (kopi goods). The hold is released (failed) before the roti refund, so the roti
  // refund is judged by the ledger alone.
  it("room 4.735 < goods kopi 7.000: nothing_left tetap mencatat goods penuh 7.000 (tidak dipotong ke room), lalu refund roti 20.790 tanpa porsi kopi, total <= sisa dana", async () => {
    const { placed, issueId, event } = await completedZeroReplacement([
      w.ids.kopi,
      w.ids.teh,
      w.ids.roti,
    ]);
    const { rows } = await owner.query<{ payment_intent_id: string }>(
      "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(placed.order.id)],
    );
    const holder = (await w.report(placed.line(w.ids.teh).id)).body.data
      .id as string;
    const holdId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, order_issue_id, amount_idr,
          reason, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 38000, 'Refund uji room', 'pending', 'user-uji')`,
      [
        holdId,
        w.tenant.tenantId,
        w.tenant.outletId,
        rows[0]!.payment_intent_id,
        holder,
      ],
    );

    await deliver(event);

    // Rp0 line: no refund, blocked nothing_left once, nothing paid out.
    expect(await issueRefunds(issueId)).toEqual([]);
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect(await w.outboxRows("order.refunded", placed.order.id)).toHaveLength(
      0,
    );
    // The room (4.735) is below the kopi goods, yet the ledger holds all of them.
    expect(await ledgerOf(w.tenant.tenantId, placed.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_PRICE,
    });

    // Release the hold, then refund the roti: its own share only (20.790).
    await owner.query(
      `UPDATE payment_refunds SET status = 'failed', failure_reason = 'provider_declined'
        WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, holdId],
    );
    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect(await ledgerOf(w.tenant.tenantId, placed.order.id)).toEqual({
      paid: KOPI_PAYOUT + ROTI_PAYOUT,
      subtotal: KOPI_PRICE + ROTI_PRICE,
    });
    const refunded = await refundedEvents(placed.order.id);
    expect(refunded).toHaveLength(1);
    expect(refunded[0]).toMatchObject({
      refundId: roti.issueId,
      amountIdr: ROTI_REFUND_AFTER_KOPI,
    });
    // Never more than the guest paid, and within what is left after the kopi share.
    expect(ROTI_REFUND_AFTER_KOPI).toBeLessThanOrEqual(
      ORDER_TOTAL - KOPI_REFUND,
    );
  });
});

describe("legend-k0ub4 varian: open bill dan kopi gagal final sebelum swap", () => {
  it("open bill promo completed: nothing_left, ledger 7.000, lalu roti 20.790 (ledger 25.000)", async () => {
    const { placed, issueId, event } = await completedZeroReplacement([], {
      mode: "open_bill",
    });
    await deliver(event);
    expect(await issueRefunds(issueId)).toEqual([]);
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT,
    );
    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT + ROTI_PAYOUT,
    );
  });

  it("kopi gagal final sebelum swap: nothing_left, ledger tetap 7.000 (tidak dobel), lalu roti 20.790", async () => {
    const { placed, issueId, event } = await completedZeroReplacement(
      [w.ids.kopi, w.ids.teh, w.ids.roti],
      { kopiFailedFirst: true },
    );
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT,
    );
    await deliver(event);
    expect(await issueRefunds(issueId)).toEqual([]);
    expectBlockedOnce(await auditRows([issueId], "order_issue.refund_blocked"));
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT,
    );
    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    expect((await ledgerOf(w.tenant.tenantId, placed.order.id))?.paid).toBe(
      KOPI_PAYOUT + ROTI_PAYOUT,
    );
  });
});
