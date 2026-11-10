// legend-fwe4l (Q17): after a swap, the refund of the replacement line is capped by
// the value of that line. Written FIRST: the cases below fail until the cap lands.
// Contract: docs/briefs/sub-fwe4l-swap-cap.md.
//
// Story (promo order kopi + teh + roti, "buy 2 of {kopi, teh}, get 1 roti free",
// order total 42.735, kopi refund 8.085 with goods payout 7.000, see the pti5r
// tests): the kopi refund fails finally (provider_declined); the kopi line is
// reported again and the supervisor swaps it to a CHEAPER item (air, Rp5.000); the
// swap credits the price difference as a voucher; the replacement line then fails
// and its refund (B) is filed. Today B replays A's 8.085, so the guest gets the
// kopi refund AND the voucher for the difference (double). It must be the normal
// value of the replacement line only.
//
// Assumptions where the brief is not exact:
// - "Normal value of the replacement line" = the pro-rata refund of a Rp5.000 line
//   of this order (recoveryRefundSplit without promo): about Rp3.9xx (the order's
//   promo discount is spread pro rata, plus 5% service and 10% PBJT). Pinned
//   exactly (SWAP_CAP = 3.885) and below A; it also keeps "refund B + voucher <=
//   value of the kopi paid" true.
// - "Value of the kopi paid" = the kopi item price Rp25.000 (the voucher is an item
//   price difference). With voucher 20.000, B <= 5.000 keeps the sum at or below it;
//   the old behavior gives 20.000 + 8.085 = 28.085.
// - Split consistency is read from `order.refunded` (pay-first only): amount =
//   gross - discount + service + pbjt, no part negative, no part above A's part.
// - The swap kitchen event is delivered by hand (it writes the replacement line),
//   like T6 of order-recovery-refund-codex422.test.ts; the replacement line id is
//   a UUID in the DB and a ULID for the API (`uuidToUlid`).
// - Open bill: the order is settled by a paid intent with evidence inserted
//   directly (as in the codex422 tests); amounts are read from the first filing.
//   It has no `order.refunded`.
// - The ledger of the promo order (`promotion_order_applications`) is the one A's
//   filing wrote; nothing after it (swap, B, C) may change it.
// - Tenant isolation: another tenant's application with the same order id keeps its
//   numbers; one assertion in the main case.

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
/**
 * The replacement line's own refund value: `recoveryRefundSplit` of the Rp5.000
 * air line with no promo share (service + tax, the order discount spread pro
 * rata as for any line). Exact, so a looser cap fails.
 */
const SWAP_CAP = 3_885;

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
               now() - interval '1 hour', NULL, $3, $4, 'g_fwe4l', true, 0, NULL, NULL, NULL)`,
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'fwe4l-test')`,
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

/** The apology vouchers minted for an issue (the swap credit). */
async function voucherValues(issueId: string): Promise<number[]> {
  const { rows } = await owner.query<{ value_idr: string }>(
    `SELECT v.value_idr FROM vouchers v
     JOIN apology_vouchers a ON a.voucher_id = v.id AND a.tenant_id = v.tenant_id
     WHERE a.tenant_id = $1 AND a.order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  return rows.map((row) => Number(row.value_idr));
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

/** Reports the kopi line and swaps it to `air`; the kitchen event writes the replacement line. */
async function swapKopiToAir(paid: PaidOrder) {
  const swapIssue = await w.report(paid.line(w.ids.kopi).id);
  expect(swapIssue.status, JSON.stringify(swapIssue.body)).toBe(201);
  const swapIssueId = swapIssue.body.data.id as string;
  const swapped = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${swapIssueId}/resolve`,
    { resolution: "swap", replacementItemId: airItem },
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

/**
 * The kopi refund (A) fails finally; the kopi line is reported again and swapped to
 * `air` (cheaper, credit below the voucher approval floor: no approval); the swap
 * kitchen event writes the replacement line. Returns A and the replacement line.
 */
async function kopiFailedThenSwapped(mode: "pay_first" | "open_bill") {
  const paid = await paidPromoOrder(mode);
  const a = await filedRefund(paid.line(w.ids.kopi).id, KOPI_PRICE);
  await failFinally(a.refund.id, "provider_declined");
  return { paid, a, ...(await swapKopiToAir(paid)) };
}

/**
 * Round 2: the kopi is reported and swapped to `air` DIRECTLY, with no refund of the
 * kopi before (no replay of A exists). Returns the replacement line.
 */
async function kopiSwappedDirectly(mode: "pay_first" | "open_bill") {
  const paid = await paidPromoOrder(mode);
  return { paid, ...(await swapKopiToAir(paid)) };
}

function expectCapped(amountIdr: number, aAmountIdr: number) {
  expect(
    aAmountIdr,
    "A is dearer than the cap, so the cap can bite",
  ).toBeGreaterThan(SWAP_CAP);
  expect(amountIdr).toBe(SWAP_CAP);
}

describe("legend-fwe4l swap ke menu lebih murah setelah gagal final: refund dibatasi nilai lini pengganti", () => {
  it("pay-first promo: refund B = nilai lini pengganti (bukan jumlah kopi), split konsisten, ledger tetap, voucher tidak ganda, tenant lain tidak tersentuh", async () => {
    const other = await createIsolatedTenant(
      `fwe4l-${randomUUID().slice(0, 6)}`,
    );
    const { paid, a, swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped("pay_first");
    // Another tenant's application for the same order id must stay as it is.
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
          toUuid(paid.order.id),
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
        ],
      ),
    );
    expect(a.refund.amount_idr).toBe(KOPI_REFUND);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the replacement line").toHaveLength(1);
    const amount = refunds[0]!.amount_idr;
    expectCapped(amount, a.refund.amount_idr);
    expect(await auditRows([b.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );

    // order.refunded of B: the split adds up and is a share of A's split.
    const events = await refundedEvents(paid.order.id);
    const first = events.find((event) => event.refundId === a.issueId)!;
    const second = events.find((event) => event.refundId === b.issueId)!;
    expect(second.amountIdr).toBe(amount);
    expect(
      second.grossSalesIdr -
        second.discountIdr +
        second.serviceChargeIdr +
        second.pbjtIdr,
    ).toBe(second.amountIdr);
    for (const field of [
      "grossSalesIdr",
      "discountIdr",
      "serviceChargeIdr",
      "pbjtIdr",
    ] as const) {
      expect(second[field], field).toBeGreaterThanOrEqual(0);
      expect(second[field], field).toBeLessThanOrEqual(first[field]);
    }

    // The promo ledger keeps what A's filing wrote: no second payout.
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_PRICE,
    });

    // The swap credit is a voucher; refund B plus the voucher never exceed what
    // the guest paid for the kopi (no double credit).
    const vouchers = await voucherValues(swapIssueId);
    expect(vouchers, "one swap voucher").toHaveLength(1);
    expect(vouchers[0]!).toBeGreaterThan(0);
    expect(vouchers[0]! + amount).toBeLessThanOrEqual(KOPI_PRICE);

    expect(await ledgerOf(other.tenantId, paid.order.id)).toEqual({
      paid: 5_000,
      subtotal: 9_000,
    });
  });

  it("rantai: refund B gagal final lalu lini pengganti dilaporkan lagi (C): tetap dibatasi, bukan jumlah kopi", async () => {
    const { paid, a, swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped("pay_first");
    const b = await filedRefund(replacementLineId, AIR_PRICE);
    expectCapped(b.refund.amount_idr, a.refund.amount_idr);
    await failFinally(b.refund.id, "provider_declined");

    const c = await approvedRefund(replacementLineId, AIR_PRICE);
    expect(c.issueId).not.toBe(b.issueId);
    await deliver(c.event);

    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expectCapped(refunds[0]!.amount_idr, a.refund.amount_idr);
    expect(refunds[0]!.amount_idr).toBeLessThanOrEqual(b.refund.amount_idr);
    expect(await auditRows([c.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    const events = await refundedEvents(paid.order.id);
    const third = events.find((event) => event.refundId === c.issueId)!;
    expect(third.amountIdr).toBe(refunds[0]!.amount_idr);
    expect(
      third.grossSalesIdr -
        third.discountIdr +
        third.serviceChargeIdr +
        third.pbjtIdr,
    ).toBe(third.amountIdr);
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_PRICE,
    });
    const vouchers = await voucherValues(swapIssueId);
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]! + refunds[0]!.amount_idr).toBeLessThanOrEqual(
      KOPI_PRICE,
    );
  });

  it("open bill promo: refund B dibatasi nilai lini pengganti, ledger tetap, voucher tidak ganda", async () => {
    const { paid, a, swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped("open_bill");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the replacement line").toHaveLength(1);
    expectCapped(refunds[0]!.amount_idr, a.refund.amount_idr);
    expect(await auditRows([b.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual(
      ledgerBefore,
    );
    const vouchers = await voucherValues(swapIssueId);
    expect(vouchers, "one swap voucher").toHaveLength(1);
    expect(vouchers[0]! + refunds[0]!.amount_idr).toBeLessThanOrEqual(
      KOPI_PRICE,
    );
  });
});

// Round 2 (architect finding F1 on 631344cf): the cap must also hold when the kopi
// is swapped DIRECTLY (no refund of the kopi before, so there is no replay of A and
// the amount is recomputed from the promo). Story: promo order kopi + teh + roti
// (total 42.735); the kopi is reported and swapped to air (Rp5.000) with a voucher
// of Rp20.000; the air line fails and the supervisor approves a manual refund (B,
// ORD-09 approval Rp5.000). Before the fix the recompute treats the kopi as failed
// and B is 8.085 (with the promo ledger +7.000): the guest holds 28.085 against 25.000
// paid for the kopi, and B is above its own approval.
//
// Assumptions:
// - B = SWAP_CAP (3.885) exactly, the same pinned value as round 1 (the Rp5.000
//   line pro rata, no promo share), and it fits the Rp5.000 approval.
// - Ledger: the promo ledger records the goods of the kopi BEFORE the cap (+7.000
//   paid) so refunds of other items after it stay right; the delta is read from
//   `refunded_paid_idr` before and after B (the subtotal column is not pinned).
// - Non-promo order (kopi + roti: no "2 of {kopi, teh}", 5% service, 10% PBJT on
//   subtotal 43.000): the air line is worth 5.000 + 250 + 525 = 5.775 and B
//   already is that today, so the cap must not touch it. The approval is 5.775:
//   an approval below the refund is blocked by ORD-09.
// - The audit `swapCapIdr` is not asserted: the brief gives no action name or field.
const PLAIN_B = 5_775;

describe("legend-fwe4l putaran 2: swap langsung ke menu lebih murah lalu gagal (tanpa refund kopi sebelumnya)", () => {
  it("pay-first promo: B = 3.885, voucher + B <= 25.000, ledger +7.000 (pra-cap), split konsisten, di bawah approval", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiSwappedDirectly("pay_first");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the replacement line").toHaveLength(1);
    const amount = refunds[0]!.amount_idr;
    expect(amount).toBe(SWAP_CAP);
    expect(amount, "within the ORD-09 approval").toBeLessThanOrEqual(AIR_PRICE);
    expect(await auditRows([b.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );

    const events = await refundedEvents(paid.order.id);
    const filed = events.find((event) => event.refundId === b.issueId)!;
    expect(filed.amountIdr).toBe(SWAP_CAP);
    expect(
      filed.grossSalesIdr -
        filed.discountIdr +
        filed.serviceChargeIdr +
        filed.pbjtIdr,
    ).toBe(SWAP_CAP);
    for (const field of [
      "grossSalesIdr",
      "discountIdr",
      "serviceChargeIdr",
      "pbjtIdr",
    ] as const)
      expect(filed[field], field).toBeGreaterThanOrEqual(0);

    // The kopi left the promo in full: the ledger counts its goods before the cap.
    const ledgerAfter = await ledgerOf(w.tenant.tenantId, paid.order.id);
    expect(ledgerAfter).not.toBeNull();
    expect(ledgerAfter!.paid - (ledgerBefore?.paid ?? 0)).toBe(KOPI_PAYOUT);

    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PRICE - AIR_PRICE]);
    expect(KOPI_PRICE - AIR_PRICE + amount).toBeLessThanOrEqual(KOPI_PRICE);
  });

  it("open bill promo: B = 3.885, voucher + B <= 25.000, ledger +7.000 (pra-cap)", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiSwappedDirectly("open_bill");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the replacement line").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(SWAP_CAP);
    expect(await auditRows([b.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    const ledgerAfter = await ledgerOf(w.tenant.tenantId, paid.order.id);
    expect(ledgerAfter).not.toBeNull();
    expect(ledgerAfter!.paid - (ledgerBefore?.paid ?? 0)).toBe(KOPI_PAYOUT);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PRICE - AIR_PRICE]);
  });

  it("rantai: swap langsung, B gagal final, lalu C untuk lini yang sama: B dan C = 3.885, ledger tidak bertambah lagi", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiSwappedDirectly("pay_first");

    const b = await filedRefund(replacementLineId, AIR_PRICE);
    expect(b.refund.amount_idr).toBe(SWAP_CAP);
    const ledgerAfterB = await ledgerOf(w.tenant.tenantId, paid.order.id);
    await failFinally(b.refund.id, "provider_declined");

    const c = await approvedRefund(replacementLineId, AIR_PRICE);
    expect(c.issueId).not.toBe(b.issueId);
    await deliver(c.event);

    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(SWAP_CAP);
    expect(await auditRows([c.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    const events = await refundedEvents(paid.order.id);
    const third = events.find((event) => event.refundId === c.issueId)!;
    expect(third.amountIdr).toBe(SWAP_CAP);
    expect(
      third.grossSalesIdr -
        third.discountIdr +
        third.serviceChargeIdr +
        third.pbjtIdr,
    ).toBe(SWAP_CAP);
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual(
      ledgerAfterB,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PRICE - AIR_PRICE]);
  });

  it("order tanpa promo: swap langsung lalu gagal -> B = nilai lini sendiri (5.775), tidak berubah", async () => {
    const placed = await placeLines("pay_first", [w.ids.kopi, w.ids.roti]);
    const payment = await w
      .as(placed.guest)
      .pay({ kind: "order", orderId: placed.order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
    const { swapIssueId, replacementLineId } = await swapKopiToAir({
      order: placed.order,
      line: placed.line,
    });

    // ORD-09: the approval equals the line total (Rp5.000); the refund adds
    // service and tax on top.
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the replacement line").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(PLAIN_B);
    expect(await auditRows([b.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PRICE - AIR_PRICE]);
  });
});
