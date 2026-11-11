// legend-fwe4l (Q17): after a swap, the refund of the replacement line is capped by
// the value of that line. Written FIRST: the cases below fail until the cap lands.
// Contract: docs/briefs/sub-fwe4l-swap-cap.md.
//
// UPDATED by legend-rat9r (founder W4 Q25, 11 Nov): Q25 REPLACES the fwe4l numbers
// for the kopi of this promo order. The swap voucher is min(list difference, value
// paid) and voucher + refunds of the item stay within the value paid. The kopi was
// paid 8.085 (KOPI_REFUND), so kopi -> air gives voucher 8.085 and the refund of the
// air line is 0 (no refund row, `nothing_left`; the promo ledger still moves by the
// kopi goods through the k0ub4 path), instead of the fwe4l 3.885 below. The fwe4l cap
// (the value of the replacement line) still applies where the voucher leaves room
// above that value: see the teh -> air cases. Contract: docs/briefs/sub-rat9r-voucher-cap.md.
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
/** Rp20.000 item: the swap voucher (5.000) leaves room under the kopi paid value. */
const midItem = randomUUID();
const MID_PRICE = 20_000;
const KOPI_PRICE = 25_000;
const TEH_PRICE = 12_000;
const ORDER_TOTAL = 42_735;
const KOPI_REFUND = 8_085;
const KOPI_PAYOUT = 7_000;
/** Refund of the air line in a plain order (no promo): 5.000 + 250 + 525. */
const PLAIN_B = 5_775;
/** What the guest paid for the kopi of a plain order: 25.000 + 5% service + 10% PBJT. */
const PLAIN_KOPI_PAID = 28_875;
/** Q25: the voucher is capped at the value the guest paid for the kopi. */
const KOPI_VOUCHER = KOPI_REFUND;
/** Room left under the paid value after the mid voucher (8.085 - 5.000). */
const MID_VOUCHER = KOPI_PRICE - MID_PRICE;
const MID_ROOM = KOPI_REFUND - MID_VOUCHER;

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
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Menu Tengah Swap', true, $5)`,
      [
        midItem,
        w.tenant.tenantId,
        w.tenant.brandId,
        w.ids.category,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), w.tenant.tenantId, w.ids.priceList, midItem, MID_PRICE],
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
async function swapKopiToAir(paid: PaidOrder, replacementItemId = airItem) {
  return swapLineTo(paid.line(w.ids.kopi).id, replacementItemId);
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

/**
 * The kopi refund (A) fails finally; the kopi line is reported again and swapped to
 * `air` (cheaper, credit below the voucher approval floor: no approval); the swap
 * kitchen event writes the replacement line. Returns A and the replacement line.
 */
async function kopiFailedThenSwapped(
  mode: "pay_first" | "open_bill",
  replacementItemId = airItem,
) {
  const paid = await paidPromoOrder(mode);
  const a = await filedRefund(paid.line(w.ids.kopi).id, KOPI_PRICE);
  await failFinally(a.refund.id, "provider_declined");
  return { paid, a, ...(await swapKopiToAir(paid, replacementItemId)) };
}

/**
 * Round 2: the kopi is reported and swapped to `air` DIRECTLY, with no refund of the
 * kopi before (no replay of A exists). Returns the replacement line.
 */
async function kopiSwappedDirectly(
  mode: "pay_first" | "open_bill",
  replacementItemId = airItem,
) {
  const paid = await paidPromoOrder(mode);
  return { paid, ...(await swapKopiToAir(paid, replacementItemId)) };
}

/**
 * Q25 + k0ub4: a refund cut to 0 files no row and leaves one audit
 * `order_issue.refund_blocked` with `blockedReason: "nothing_left"` as the marker.
 */
async function expectNothingLeft(issueId: string) {
  const blocked = await auditRows([issueId], "order_issue.refund_blocked");
  expect(blocked, "one nothing_left marker").toHaveLength(1);
  expect(
    (blocked[0]!.maskedChanges as { after: { blockedReason: string } }).after
      .blockedReason,
  ).toBe("nothing_left");
}

/** Sum of the refund rows of an issue (Q25: 0 when the paid value is spent). */
async function refundedTotal(issueId: string) {
  return (await issueRefunds(issueId)).reduce(
    (sum, row) => sum + row.amount_idr,
    0,
  );
}

/** Sum of the `order.refunded` amounts published for an issue. */
async function refundedEventTotal(orderId: string, issueId: string) {
  return (await refundedEvents(orderId))
    .filter((event) => event.refundId === issueId)
    .reduce((sum, event) => sum + event.amountIdr, 0);
}

describe("legend-fwe4l swap ke menu lebih murah setelah gagal final: refund dibatasi nilai lini pengganti", () => {
  it("pay-first promo (Q25): kopi A (8.085) gagal final, tukar ke air: voucher 8.085, refund B = 0 (bukan jumlah kopi), ledger tetap, tenant lain tidak tersentuh", async () => {
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

    // Q25 replaces the fwe4l 3.885: the voucher (list difference 20.000, cut to the
    // 8.085 paid) already holds the whole paid value, so B pays nothing.
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_VOUCHER]);
    expect(await refundedTotal(b.issueId), "refund rows of B").toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded of B",
    ).toBe(0);
    await expectNothingLeft(b.issueId);

    // The promo ledger keeps what A's filing wrote: no second payout.
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_PRICE,
    });

    // Voucher plus refund never exceed what the guest paid for the kopi.
    expect(KOPI_VOUCHER + (await refundedTotal(b.issueId))).toBeLessThanOrEqual(
      KOPI_REFUND,
    );

    expect(await ledgerOf(other.tenantId, paid.order.id)).toEqual({
      paid: 5_000,
      subtotal: 9_000,
    });
  });

  it("rantai (Q25): kopi A gagal final, tukar ke menu 20.000 (voucher 5.000), refund B = 3.085 gagal final, lalu C: tetap 3.085, bukan jumlah kopi (8.085)", async () => {
    // The air swap leaves no room for a refund any more, so the chain case runs on
    // the Rp20.000 item: room = 8.085 - 5.000 = 3.085, below A (8.085) and below the
    // line's own value, so the replay of A must not come back.
    const { paid, a, swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped("pay_first", midItem);
    expect(a.refund.amount_idr).toBe(KOPI_REFUND);
    const b = await filedRefund(replacementLineId, MID_PRICE);
    expect(b.refund.amount_idr).toBe(MID_ROOM);
    await failFinally(b.refund.id, "provider_declined");

    const c = await approvedRefund(replacementLineId, MID_PRICE);
    expect(c.issueId).not.toBe(b.issueId);
    await deliver(c.event);

    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(MID_ROOM);
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
    expect(vouchers).toEqual([MID_VOUCHER]);
    expect(vouchers[0]! + refunds[0]!.amount_idr).toBeLessThanOrEqual(
      KOPI_REFUND,
    );
  });

  it("open bill promo (Q25): kopi A gagal final, tukar ke air: voucher 8.085, refund B = 0, ledger tetap", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped("open_bill");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId), "refund rows of B").toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded of B",
    ).toBe(0);
    await expectNothingLeft(b.issueId);
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual(
      ledgerBefore,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_VOUCHER]);
  });

  it("fwe4l masih menggigit (Q25), order tanpa promo: kopi A (28.875) gagal final, tukar ke air: voucher 20.000, refund B = nilai lini air (5.775), bukan A; voucher + B <= 28.875", async () => {
    // Keeps the fwe4l cap covered. In the promo order every swap of a kopi/teh leaves
    // no room above the line's own value, so the case runs on a plain order (kopi +
    // roti, no promo): the kopi is paid 28.875 (25.000 + 5% service + 10% PBJT), the
    // voucher 20.000 leaves 8.875 of room, and the replay of A (28.875) must be cut
    // to the air line's own value 5.775 (the fwe4l cap), which is below the room.
    const placed = await placeLines("pay_first", [w.ids.kopi, w.ids.roti]);
    const payment = await w
      .as(placed.guest)
      .pay({ kind: "order", orderId: placed.order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
    const a = await filedRefund(placed.line(w.ids.kopi).id, KOPI_PRICE);
    expect(a.refund.amount_idr).toBe(PLAIN_KOPI_PAID);
    await failFinally(a.refund.id, "provider_declined");
    const { swapIssueId, replacementLineId } = await swapLineTo(
      placed.line(w.ids.kopi).id,
      airItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PRICE - AIR_PRICE]);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the air line").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(PLAIN_B);
    expect(KOPI_PRICE - AIR_PRICE + refunds[0]!.amount_idr).toBeLessThanOrEqual(
      PLAIN_KOPI_PAID,
    );
    expect(await auditRows([b.issueId], "order_issue.refund_blocked")).toEqual(
      [],
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
// UPDATED by legend-rat9r (Q25): the voucher is now cut to the 8.085 paid, so the air
// swap leaves B = 0 (no refund row) and the ledger still moves +7.000 through the k0ub4
// path. The "B stays at the fwe4l 3.885" assertions moved to the Rp20.000 item (room
// 3.085) for the chain case. The old reading below is kept for the history.
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

describe("legend-fwe4l putaran 2: swap langsung ke menu lebih murah lalu gagal (tanpa refund kopi sebelumnya)", () => {
  it("pay-first promo (Q25): voucher 8.085, B = 0 (tanpa baris refund), ledger +7.000 (pra-cap), penanda nothing_left", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiSwappedDirectly("pay_first");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId), "refund rows of B").toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded of B",
    ).toBe(0);
    await expectNothingLeft(b.issueId);

    // The kopi left the promo in full: the ledger counts its goods before the cap.
    const ledgerAfter = await ledgerOf(w.tenant.tenantId, paid.order.id);
    expect(ledgerAfter).not.toBeNull();
    expect(ledgerAfter!.paid - (ledgerBefore?.paid ?? 0)).toBe(KOPI_PAYOUT);

    expect(await voucherValues(swapIssueId)).toEqual([KOPI_VOUCHER]);
    expect(KOPI_VOUCHER + (await refundedTotal(b.issueId))).toBeLessThanOrEqual(
      KOPI_REFUND,
    );
  });

  it("open bill promo (Q25): voucher 8.085, B = 0, ledger +7.000 (pra-cap)", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiSwappedDirectly("open_bill");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId), "refund rows of B").toBe(0);
    await expectNothingLeft(b.issueId);
    const ledgerAfter = await ledgerOf(w.tenant.tenantId, paid.order.id);
    expect(ledgerAfter).not.toBeNull();
    expect(ledgerAfter!.paid - (ledgerBefore?.paid ?? 0)).toBe(KOPI_PAYOUT);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_VOUCHER]);
  });

  it("rantai (Q25): swap langsung ke menu 20.000, B (3.085) gagal final, lalu C untuk lini yang sama: B dan C = 3.085, ledger tidak bertambah lagi", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      midItem,
    );

    const b = await filedRefund(replacementLineId, MID_PRICE);
    expect(b.refund.amount_idr).toBe(MID_ROOM);
    const ledgerAfterB = await ledgerOf(w.tenant.tenantId, paid.order.id);
    await failFinally(b.refund.id, "provider_declined");

    const c = await approvedRefund(replacementLineId, MID_PRICE);
    expect(c.issueId).not.toBe(b.issueId);
    await deliver(c.event);

    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(MID_ROOM);
    expect(await auditRows([c.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    const events = await refundedEvents(paid.order.id);
    const third = events.find((event) => event.refundId === c.issueId)!;
    expect(third.amountIdr).toBe(MID_ROOM);
    expect(
      third.grossSalesIdr -
        third.discountIdr +
        third.serviceChargeIdr +
        third.pbjtIdr,
    ).toBe(MID_ROOM);
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual(
      ledgerAfterB,
    );
    expect(await voucherValues(swapIssueId)).toEqual([MID_VOUCHER]);
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

// Round 3 (architect re-check of 376d33a4).
//
// 1. A swap chain kopi -> teh -> air: the air line fails; the refund is capped by the
//    value of the air line (3.885), and the two swap vouchers (13.000 and 7.000) plus
//    the refund stay within the 25.000 paid for the kopi.
// 2. The kopi is swapped directly and B is filed (capped). A refund of ANOTHER line
//    (roti) after B is paid as if the kopi had left the promo in full: the ledger
//    holds the kopi goods BEFORE the cap (7.000), so the roti gets its own 20.790 (as
//    in T3 of order-recovery-refund-promo-final-failure.test.ts) with goods 18.000
//    and the ledger ends at 7.000 + 18.000 = 25.000: the kopi is not paid again.
// 3. The cap must not cut a replay whose root is the same line: B (air) fails
//    finally, a refund of another line (teh) is filed, then C for the air line
//    replays B and must be B exactly (amount and split). In this world the cap of the
//    air line recomputed with the teh refund as a prior line would be 3.884 (a Rp1
//    rounding step below B), which is the regression.
//
// Assumptions:
// - The teh refund between B and C is filed (amount not pinned: only that it exists
//   and is positive); what is pinned is B and C.
// - In the plain (no promo) variant the numbers are round, so the old behavior also
//   gives B = C; it is a regression guard, not a fail-first case.
const ROTI_PRICE = 18_000;
/** Roti refund after the kopi has left the promo (T3 of the promo final-failure tests). */
const ROTI_REFUND_AFTER_KOPI = 20_790;

describe("legend-fwe4l putaran 3: rantai swap, refund baris lain, replay tanpa pemotongan", () => {
  it("swap berantai kopi -> teh -> air lalu air gagal (Q25): voucher pertama 8.085, kedua tidak dimint, refund air 0, jumlah <= 8.085", async () => {
    const paid = await paidPromoOrder("pay_first");
    const first = await swapLineTo(paid.line(w.ids.kopi).id, w.ids.teh);
    const second = await swapLineTo(first.replacementLineId, airItem);
    // The first voucher is cut to the 8.085 paid for the kopi; the second swap finds
    // the paid value spent in the chain and mints nothing.
    expect(await voucherValues(first.swapIssueId)).toEqual([KOPI_VOUCHER]);
    expect(await voucherValues(second.swapIssueId)).toEqual([]);

    const b = await approvedRefund(second.replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId), "refund rows of the air line").toBe(
      0,
    );
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded of the air line",
    ).toBe(0);
    await expectNothingLeft(b.issueId);
    expect(KOPI_VOUCHER + (await refundedTotal(b.issueId))).toBeLessThanOrEqual(
      KOPI_REFUND,
    );
  });

  it("refund roti setelah B (swap langsung, Q25: B = 0): ledger pra-cap 7.000, roti dapat 20.790 sendiri (goods 18.000), ledger akhir 25.000, kopi tidak dibayar ulang", async () => {
    const { paid, replacementLineId } = await kopiSwappedDirectly("pay_first");
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);
    expect(await refundedTotal(b.issueId), "B pays nothing").toBe(0);
    const ledgerAfterB = await ledgerOf(w.tenant.tenantId, paid.order.id);
    expect(ledgerAfterB!.paid - (ledgerBefore?.paid ?? 0)).toBe(KOPI_PAYOUT);

    const roti = await filedRefund(paid.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);
    const ledgerAfterRoti = await ledgerOf(w.tenant.tenantId, paid.order.id);
    expect(ledgerAfterRoti!.paid - (ledgerBefore?.paid ?? 0)).toBe(
      KOPI_PAYOUT + ROTI_PRICE,
    );
    // B itself is unchanged.
    expect(await refundedTotal(b.issueId)).toBe(0);
    const events = await refundedEvents(paid.order.id);
    const rotiEvent = events.find((event) => event.refundId === roti.issueId)!;
    expect(rotiEvent.amountIdr).toBe(ROTI_REFUND_AFTER_KOPI);
  });

  it("replay setelah refund baris lain (swap langsung ke menu 20.000, promo): B gagal final, refund teh, lalu C = B persis (jumlah 3.085 dan split)", async () => {
    // Q25: on the air swap B is 0 and cannot be replayed, so the replay case runs on
    // the Rp20.000 item (room 3.085).
    const { paid, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      midItem,
    );
    const b = await filedRefund(replacementLineId, MID_PRICE);
    expect(b.refund.amount_idr).toBe(MID_ROOM);
    await failFinally(b.refund.id, "provider_declined");

    const teh = await filedRefund(paid.line(w.ids.teh).id, TEH_PRICE);
    expect(teh.refund.amount_idr).toBeGreaterThan(0);

    const c = await approvedRefund(replacementLineId, MID_PRICE);
    expect(c.issueId).not.toBe(b.issueId);
    await deliver(c.event);

    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(MID_ROOM);
    expect(await auditRows([c.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    const events = await refundedEvents(paid.order.id);
    const first = events.find((event) => event.refundId === b.issueId)!;
    const third = events.find((event) => event.refundId === c.issueId)!;
    expect(third.amountIdr).toBe(first.amountIdr);
    expect(third.grossSalesIdr).toBe(first.grossSalesIdr);
    expect(third.discountIdr).toBe(first.discountIdr);
    expect(third.serviceChargeIdr).toBe(first.serviceChargeIdr);
    expect(third.pbjtIdr).toBe(first.pbjtIdr);
  });

  it("replay tanpa promo setelah refund baris lain: B 5.775 gagal final, refund roti 20.790, lalu C = B persis (jumlah dan split)", async () => {
    const placed = await placeLines("pay_first", [w.ids.kopi, w.ids.roti]);
    const payment = await w
      .as(placed.guest)
      .pay({ kind: "order", orderId: placed.order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
    const { replacementLineId } = await swapKopiToAir({
      order: placed.order,
      line: placed.line,
    });

    const b = await filedRefund(replacementLineId, AIR_PRICE);
    expect(b.refund.amount_idr).toBe(PLAIN_B);
    await failFinally(b.refund.id, "provider_declined");

    const roti = await filedRefund(placed.line(w.ids.roti).id, ROTI_PRICE);
    expect(roti.refund.amount_idr).toBe(ROTI_REFUND_AFTER_KOPI);

    const c = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(c.event);
    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(PLAIN_B);

    const events = await refundedEvents(placed.order.id);
    const first = events.find((event) => event.refundId === b.issueId)!;
    const third = events.find((event) => event.refundId === c.issueId)!;
    expect(third.amountIdr).toBe(first.amountIdr);
    expect(third.grossSalesIdr).toBe(first.grossSalesIdr);
    expect(third.discountIdr).toBe(first.discountIdr);
    expect(third.serviceChargeIdr).toBe(first.serviceChargeIdr);
    expect(third.pbjtIdr).toBe(first.pbjtIdr);
  });
});
