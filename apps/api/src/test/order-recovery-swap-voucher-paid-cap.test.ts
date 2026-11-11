// legend-rat9r (founder W4 Q25, 11 Nov): the swap voucher and every refund of the
// swapped item are bounded by what the guest PAID for that item (after promo and
// discount, with service and PBJT), not by the list price. Written FIRST: the cases
// that touch the promo order fail until the cap lands. Contract:
// docs/briefs/sub-rat9r-voucher-cap.md.
//
// Founder example (promo order kopi + teh + roti, "buy 2 of {kopi, teh}, get 1 roti
// free", order total 42.735): the kopi is paid 8.085 (goods 7.000 x 1,155). It is
// swapped to air (Rp5.000); the list difference would give a voucher of 20.000. Right:
// voucher 8.085 and refund 0 for the replacement line (the guest already holds the
// whole paid value as a voucher).
//
// Working formula of the brief (assumed, pinned as numbers below):
//   paid     = 8.085 for the kopi of the promo order (28.875 without promo:
//              25.000 + 5% service 1.250 + 10% PBJT 2.625)
//   voucher  = min(list difference, paid)
//   refund   = capped at paid - voucher - live refunds of that item
//
// Assumptions where the brief is not exact:
// - "Refund 0" is read as: the replacement line has no refund above zero. Whether the
//   system files no row, a zero row, or only blocks it with an audit is not pinned,
//   so the assertions use the SUM of the refund rows and of the `order.refunded`
//   amounts for the issue (both must be 0).
// - Room-left case: an item of Rp20.000 (list difference 5.000) leaves
//   paid - voucher = 8.085 - 5.000 = 3.085; the refund of that replacement line must
//   be exactly 3.085 (its own value, about 23k in this order, would not bite).
//   Without promo the same swap voucher is 5.000 and the refund of the Rp20.000 line
//   is its own value 23.100 (20.000 + 1.000 service + 2.100 PBJT): paid 28.875 leaves
//   23.875, so nothing changes.
// - A refund that "failed finally" is not live: it does not reduce the room.
// - Replay at refund 0 (founder example): the replacement line can be reported again
//   after a refund that came out at 0, and its second filing is 0 as well.
// - A dearer swap (Rp35.000, price_correction approval Rp10.000) gives no voucher.
// - Idempotency: the swap voucher is minted by the resolve call; resolving the same
//   issue again (status not pinned) and delivering the swap kitchen event again must
//   leave one voucher. Refund events delivered again (also at once) leave one refund.
// - Tenant isolation: another tenant's application with the same order id keeps its
//   numbers, it gets no voucher and no refund, and a staff request addressed to that
//   tenant's host cannot resolve our issue (a 4xx, no voucher).

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
/** Rp5.000 item in no promotion: the founder's cheaper replacement. */
const airItem = randomUUID();
/** Rp20.000 item: a swap that leaves room under the paid value. */
const midItem = randomUUID();
/** Rp35.000 item: a dearer swap. */
const premiumItem = randomUUID();
const AIR_PRICE = 5_000;
const MID_PRICE = 20_000;
const PREMIUM_PRICE = 35_000;
const KOPI_PRICE = 25_000;
const ORDER_TOTAL = 42_735;
/** What the guest paid for the kopi of the promo order (goods 7.000 x 1,155). */
const KOPI_PAID = 8_085;
const KOPI_PAYOUT = 7_000;
/** List-price difference kopi -> air: the OLD voucher (founder: wrong). */
const LIST_DIFF_AIR = KOPI_PRICE - AIR_PRICE;
/** List-price difference kopi -> mid. Below KOPI_PAID, so the voucher stays whole. */
const LIST_DIFF_MID = KOPI_PRICE - MID_PRICE;
/** Room left under the paid value after the mid voucher: the refund cap. */
const MID_ROOM = KOPI_PAID - LIST_DIFF_MID;
/** Plain order (kopi + roti, no promo): paid for the kopi, and the refund of the air line. */
const PLAIN_KOPI_PAID = 28_875;
const PLAIN_AIR_REFUND = 5_775;
const PLAIN_MID_REFUND = 23_100;

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
               now() - interval '1 hour', NULL, $3, $4, 'g_rat9r', true, 0, NULL, NULL, NULL)`,
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
    for (const [id, name, price] of [
      [airItem, "Air Mineral Swap", AIR_PRICE],
      [midItem, "Menu Tengah Swap", MID_PRICE],
      [premiumItem, "Menu Premium Swap", PREMIUM_PRICE],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          id,
          w.tenant.tenantId,
          w.tenant.brandId,
          w.ids.category,
          name,
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), w.tenant.tenantId, w.ids.priceList, id, price],
      );
    }
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
  guest: Parameters<World["as"]>[0];
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
  expect(placed.total, "promo order total").toBe(ORDER_TOTAL);
  const orderId = toUuid(placed.order.id);
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'rat9r-test')`,
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

/** A PAID plain order (kopi + roti): no promo applies. */
async function paidPlainOrder(): Promise<PaidOrder> {
  const placed = await placeLines("pay_first", [w.ids.kopi, w.ids.roti]);
  const payment = await w
    .as(placed.guest)
    .pay({ kind: "order", orderId: placed.order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
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

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Total of the refund rows of an issue (0 when no row was filed). */
async function refundedTotal(issueId: string) {
  return sum((await issueRefunds(issueId)).map((row) => row.amount_idr));
}

async function refundedEvents(orderId: string) {
  return (await w.outboxRows("order.refunded", orderId)).map((row) =>
    orderRefundedPayloadSchema.parse(row.event.payload),
  );
}

/** Total of the `order.refunded` amounts of an issue (0 when none was published). */
async function refundedEventTotal(orderId: string, issueId: string) {
  return sum(
    (await refundedEvents(orderId))
      .filter((event) => event.refundId === issueId)
      .map((event) => event.amountIdr),
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

/** Reports a line (unfulfillable) and returns the issue id. */
async function reportLine(lineId: string) {
  const reported = await w.report(lineId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return reported.body.data.id as string;
}

/** Resolves the issue with a swap to `replacementItemId`. */
function resolveSwap(
  issueId: string,
  replacementItemId: string,
  approvalRequestId?: string,
) {
  return w.staffPost(w.supervisor, `/api/order-issues/${issueId}/resolve`, {
    resolution: "swap",
    replacementItemId,
    ...(approvalRequestId === undefined ? {} : { approvalRequestId }),
  });
}

/** Delivers the swap kitchen event of a resolved swap (writes the replacement line). */
async function deliverSwapKitchen(issueId: string) {
  const resolved = await w.outboxRows("order_issue.resolved", issueId);
  expect(resolved).toHaveLength(1);
  const event = resolved[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
  return event;
}

async function replacementLineOf(issueId: string) {
  const { rows } = await owner.query<{ id: string | null }>(
    "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows[0]!.id, "replacement line written").not.toBeNull();
  return uuidToUlid(rows[0]!.id!);
}

/** Reports one line and swaps it to `replacementItemId` (cheaper: no approval below the floor). */
async function swapLineTo(lineId: string, replacementItemId: string) {
  const swapIssueId = await reportLine(lineId);
  const swapped = await resolveSwap(swapIssueId, replacementItemId);
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  const event = await deliverSwapKitchen(swapIssueId);
  return {
    swapIssueId,
    swapEvent: event,
    replacementLineId: await replacementLineOf(swapIssueId),
  };
}

/** The kopi is swapped DIRECTLY (no refund of the kopi before). */
async function kopiSwappedDirectly(
  mode: "pay_first" | "open_bill",
  replacementItemId: string,
) {
  const paid = await paidPromoOrder(mode);
  return {
    paid,
    ...(await swapLineTo(paid.line(w.ids.kopi).id, replacementItemId)),
  };
}

/**
 * The kopi refund (A, 8.085) fails finally; the kopi is reported again and swapped to
 * `replacementItemId`. Returns A and the replacement line.
 */
async function kopiFailedThenSwapped(replacementItemId: string) {
  const paid = await paidPromoOrder("pay_first");
  const a = await filedRefund(paid.line(w.ids.kopi).id, KOPI_PRICE);
  expect(a.refund.amount_idr, "A is the kopi paid value").toBe(KOPI_PAID);
  await failFinally(a.refund.id, "provider_declined");
  return {
    paid,
    a,
    ...(await swapLineTo(paid.line(w.ids.kopi).id, replacementItemId)),
  };
}

/** order.refunded split of an issue adds up and has no negative part. */
async function expectSplitConsistent(orderId: string, issueId: string) {
  const event = (await refundedEvents(orderId)).find(
    (row) => row.refundId === issueId,
  )!;
  expect(event, "order.refunded published").toBeDefined();
  expect(
    event.grossSalesIdr -
      event.discountIdr +
      event.serviceChargeIdr +
      event.pbjtIdr,
  ).toBe(event.amountIdr);
  for (const field of [
    "grossSalesIdr",
    "discountIdr",
    "serviceChargeIdr",
    "pbjtIdr",
  ] as const)
    expect(event[field], field).toBeGreaterThanOrEqual(0);
}

describe("legend-rat9r 1: swap ke menu lebih murah di order promo, voucher <= nilai dibayar", () => {
  it("contoh founder pay-first: kopi dibayar 8.085 ditukar ke air (selisih daftar 20.000): voucher 8.085", async () => {
    expect(LIST_DIFF_AIR, "the old voucher is above the paid value").toBe(
      20_000,
    );
    const { swapIssueId } = await kopiSwappedDirectly("pay_first", airItem);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
  });

  it("contoh founder open bill: voucher 8.085", async () => {
    const { swapIssueId } = await kopiSwappedDirectly("open_bill", airItem);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
  });

  it("selisih daftar di bawah nilai dibayar (menu 20.000, selisih 5.000): voucher tetap 5.000", async () => {
    const { swapIssueId } = await kopiSwappedDirectly("pay_first", midItem);
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_MID]);
  });
});

describe("legend-rat9r 2: tukar + voucher, lalu item pengganti gagal: refund <= nilai dibayar - voucher", () => {
  it("contoh founder pay-first (swap langsung): voucher 8.085, refund pengganti 0, tidak ada refund baru dan ledger promo tetap", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      airItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
    const ledgerBefore = await ledgerOf(w.tenant.tenantId, paid.order.id);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId), "refund rows").toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded",
    ).toBe(0);
    const ledgerAfter = await ledgerOf(w.tenant.tenantId, paid.order.id);
    // The promo ledger moves by the kopi goods at most (never a second payout).
    expect(
      (ledgerAfter?.paid ?? 0) - (ledgerBefore?.paid ?? 0),
    ).toBeLessThanOrEqual(KOPI_PAYOUT);
    // Voucher plus refund never exceed what the guest paid for the kopi.
    expect(
      (await voucherValues(swapIssueId))[0]! + (await refundedTotal(b.issueId)),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("contoh founder open bill (swap langsung): refund pengganti 0", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "open_bill",
      airItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);
    expect(await refundedTotal(b.issueId), "refund rows").toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded",
    ).toBe(0);
  });

  it("refund kopi (A, 8.085) gagal final lalu tukar ke air: voucher 8.085 dan refund pengganti 0", async () => {
    const { paid, swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped(airItem);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);

    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId), "refund rows").toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "order.refunded",
    ).toBe(0);
  });

  it("ada sisa (menu 20.000, voucher 5.000): refund pengganti tepat 3.085, split konsisten, voucher + refund = 8.085", async () => {
    expect(MID_ROOM).toBe(3_085);
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      midItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_MID]);

    const b = await approvedRefund(replacementLineId, MID_PRICE);
    await deliver(b.event);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund for the replacement line").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(MID_ROOM);
    await expectSplitConsistent(paid.order.id, b.issueId);
    expect(LIST_DIFF_MID + refunds[0]!.amount_idr).toBe(KOPI_PAID);
  });

  it("refund kopi (A) gagal final lalu tukar ke menu 20.000: refund pengganti tepat 3.085", async () => {
    const { swapIssueId, replacementLineId } =
      await kopiFailedThenSwapped(midItem);
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_MID]);

    const b = await approvedRefund(replacementLineId, MID_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId)).toBe(MID_ROOM);
  });
});

describe("legend-rat9r 3: refund pengganti gagal final dan dilaporkan ulang (replay): tetap <= sisa", () => {
  it("menu 20.000: refund B (3.085) gagal final, lapor ulang (C): C tetap 3.085, bukan lebih, voucher tetap satu", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      midItem,
    );
    const b = await filedRefund(replacementLineId, MID_PRICE);
    expect(b.refund.amount_idr).toBe(MID_ROOM);
    await failFinally(b.refund.id, "provider_declined");

    const c = await approvedRefund(replacementLineId, MID_PRICE);
    expect(c.issueId).not.toBe(b.issueId);
    await deliver(c.event);

    const refunds = await issueRefunds(c.issueId);
    expect(refunds, "one refund for the third filing").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(MID_ROOM);
    await expectSplitConsistent(paid.order.id, c.issueId);
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_MID]);
    // Only one live refund of the line: B failed, C is within the room.
    expect(LIST_DIFF_MID + refunds[0]!.amount_idr).toBeLessThanOrEqual(
      KOPI_PAID,
    );
  });

  it("contoh founder: refund pengganti 0 (nothing_left), lapor ulang lalu resolve ditolak 409 CONFLICT, tidak ada refund baru", async () => {
    const { paid, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      airItem,
    );
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);
    expect(await refundedTotal(b.issueId)).toBe(0);

    // Q25 + k0ub4: a refund that came out at 0 closes the line (nothing is left to
    // pay). Reporting it again is accepted but the issue is already resolved, so a new
    // refund approval is refused as a conflict. Right: no money is left.
    const again = await w.report(replacementLineId);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    const approvalId = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: again.body.data.id as string,
      amountIdr: AIR_PRICE,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${again.body.data.id as string}/resolve`,
      {
        resolution: "manual_refund",
        approvalRequestId: approvalId,
        reason: REASON,
      },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(409);
    expect(resolved.body.error.code).toBe("CONFLICT");
    expect(await refundedTotal(b.issueId)).toBe(0);
    expect(
      await refundedEventTotal(paid.order.id, b.issueId),
      "no new refund event",
    ).toBe(0);
  });
});

describe("legend-rat9r 4: order tanpa promo, voucher dan refund tidak berubah (regresi)", () => {
  it("kopi 25.000 ke air: voucher 20.000, refund air 5.775, jumlah <= nilai dibayar 28.875", async () => {
    const placed = await paidPlainOrder();
    const { swapIssueId, replacementLineId } = await swapLineTo(
      placed.line(w.ids.kopi).id,
      airItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_AIR]);

    // ORD-09: the approval equals the line total (Rp5.000); the refund adds
    // service and tax on top.
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await issueRefunds(b.issueId)).toHaveLength(1);
    expect(await refundedTotal(b.issueId)).toBe(PLAIN_AIR_REFUND);
    expect(LIST_DIFF_AIR + PLAIN_AIR_REFUND).toBeLessThanOrEqual(
      PLAIN_KOPI_PAID,
    );
    await expectSplitConsistent(placed.order.id, b.issueId);
  });

  it("kopi ke menu 20.000: voucher 5.000, refund menu 23.100 (nilainya sendiri, di bawah sisa 23.875)", async () => {
    const placed = await paidPlainOrder();
    const { swapIssueId, replacementLineId } = await swapLineTo(
      placed.line(w.ids.kopi).id,
      midItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_MID]);

    // ORD-09: the approval equals the line total (Rp20.000), as in the air case.
    const b = await approvedRefund(replacementLineId, MID_PRICE);
    await deliver(b.event);

    expect(await refundedTotal(b.issueId)).toBe(PLAIN_MID_REFUND);
    expect(LIST_DIFF_MID + PLAIN_MID_REFUND).toBeLessThanOrEqual(
      PLAIN_KOPI_PAID,
    );
  });
});

describe("legend-rat9r 5: tukar ke item lebih mahal, tanpa voucher (aturan lama)", () => {
  it("kopi 25.000 ke menu 35.000 dengan approval koreksi harga: swap selesai, tidak ada voucher", async () => {
    const paid = await paidPromoOrder("pay_first");
    const issueId = await reportLine(paid.line(w.ids.kopi).id);
    const approvalId = await w.insertApproval({
      actionType: "price_correction",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PREMIUM_PRICE - KOPI_PRICE,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });

    const swapped = await resolveSwap(issueId, premiumItem, approvalId);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    await deliverSwapKitchen(issueId);

    expect(await replacementLineOf(issueId)).toBeTruthy();
    expect(
      await voucherValues(issueId),
      "no voucher for a dearer swap",
    ).toEqual([]);
  });
});

describe("legend-rat9r 6: kirim ulang dan idempoten", () => {
  it("resolve dan event swap kitchen diulang: tetap satu voucher dan satu lini pengganti", async () => {
    const paid = await paidPromoOrder("pay_first");
    const issueId = await reportLine(paid.line(w.ids.kopi).id);
    const first = await resolveSwap(issueId, airItem);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const event = await deliverSwapKitchen(issueId);
    const lineId = await replacementLineOf(issueId);

    // Same event again, then a second resolve of the same issue (status not pinned).
    const context = contextOf(w.tenant.tenantId);
    await withTenant(db, context, (tx) =>
      deliverSwapKitchenEvent(context, event, tx),
    );
    await resolveSwap(issueId, airItem);

    expect(await voucherValues(issueId)).toEqual([KOPI_PAID]);
    expect(await replacementLineOf(issueId)).toBe(lineId);
  });

  it("event refund do-ble, berurutan dan serentak (menu 20.000): satu refund 3.085, satu order.refunded, ledger tetap", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      midItem,
    );
    const b = await approvedRefund(replacementLineId, MID_PRICE);

    await deliver(b.event);
    const ledgerAfterFirst = await ledgerOf(w.tenant.tenantId, paid.order.id);
    await deliver(b.event);
    await Promise.all([deliver(b.event), deliver(b.event)]);

    const refunds = await issueRefunds(b.issueId);
    expect(refunds, "one refund after replays").toHaveLength(1);
    expect(refunds[0]!.amount_idr).toBe(MID_ROOM);
    expect(
      (await refundedEvents(paid.order.id)).filter(
        (event) => event.refundId === b.issueId,
      ),
      "one order.refunded",
    ).toHaveLength(1);
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual(
      ledgerAfterFirst,
    );
    expect(await voucherValues(swapIssueId)).toEqual([LIST_DIFF_MID]);
    expect(
      LIST_DIFF_MID + (await refundedTotal(b.issueId)),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("contoh founder, event refund diulang: refund tetap 0 dan voucher satu", async () => {
    const { swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      airItem,
    );
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);
    await deliver(b.event);
    await Promise.all([deliver(b.event), deliver(b.event)]);

    expect(await refundedTotal(b.issueId)).toBe(0);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
  });
});

describe("legend-rat9r 7: isolasi tenant", () => {
  it("tenant lain dengan order id sama tidak tersentuh dan staf host lain tidak bisa menukar", async () => {
    const other = await createIsolatedTenant(
      `rat9r-${randomUUID().slice(0, 6)}`,
    );
    const paid = await paidPromoOrder("pay_first");
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

    const issueId = await reportLine(paid.line(w.ids.kopi).id);
    // The supervisor holds no role in the other tenant: its host cannot resolve.
    const foreign = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: airItem },
      other.hostname,
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(foreign.status).toBeLessThan(500);
    expect(await voucherValues(issueId), "foreign host mints nothing").toEqual(
      [],
    );

    // The right tenant resolves it; the voucher is the capped one.
    const swapped = await resolveSwap(issueId, airItem);
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    await deliverSwapKitchen(issueId);
    const replacementLineId = await replacementLineOf(issueId);
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);

    expect(await voucherValues(issueId)).toEqual([KOPI_PAID]);
    expect(await refundedTotal(b.issueId)).toBe(0);
    expect(await ledgerOf(other.tenantId, paid.order.id)).toEqual({
      paid: 5_000,
      subtotal: 9_000,
    });
    const { rows } = await owner.query<{ vouchers: string; refunds: string }>(
      `SELECT (SELECT count(*) FROM vouchers WHERE tenant_id = $1) AS vouchers,
              (SELECT count(*) FROM payment_refunds WHERE tenant_id = $1) AS refunds`,
      [other.tenantId],
    );
    expect(Number(rows[0]!.vouchers), "other tenant vouchers").toBe(0);
    expect(Number(rows[0]!.refunds), "other tenant refunds").toBe(0);
  });
});

describe("legend-rat9r 8: setelah voucher, refund teh tidak membayar uang kopi", () => {
  /** Teh of the promo order paid back on its own: goods 12.000 x 1,155. */
  const TEH_PAID = 13_860;
  const TEH_PRICE = 12_000;

  it("kopi ditukar ke air (voucher 8.085), air gagal (refund 0), lalu teh gagal: refund teh 13.860, bukan bagian kopi", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      airItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
    const b = await approvedRefund(replacementLineId, AIR_PRICE);
    await deliver(b.event);
    expect(await refundedTotal(b.issueId)).toBe(0);
    // The Rp0 air refund still booked the kopi goods on the promo ledger.
    expect((await ledgerOf(w.tenant.tenantId, paid.order.id))?.paid).toBe(
      KOPI_PAYOUT,
    );

    const teh = await approvedRefund(paid.line(w.ids.teh).id, TEH_PRICE);
    await deliver(teh.event);

    // Without the kopi on the ledger the teh would take 19.000 goods (21.945).
    expect(await refundedTotal(teh.issueId)).toBe(TEH_PAID);
    await expectSplitConsistent(paid.order.id, teh.issueId);
    expect(
      KOPI_PAID +
        (await refundedTotal(b.issueId)) +
        (await refundedTotal(teh.issueId)),
    ).toBeLessThanOrEqual(KOPI_PAID + TEH_PAID);
  });
});

describe("legend-rat9r 9: setelah voucher selisih, tamu memilih voucher untuk lini pengganti: ditolak", () => {
  it("contoh founder: kopi ditukar ke air (voucher 8.085), lini air dilaporkan dan tamu memilih voucher: 422, tidak ada voucher baru, total voucher tetap [8.085]", async () => {
    const { paid, swapIssueId, replacementLineId } = await kopiSwappedDirectly(
      "pay_first",
      airItem,
    );
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);

    // The air line fails; the guest is offered the voucher but the whole paid value
    // is already held as a voucher, so a second credit would pay the kopi twice.
    const airIssueId = await reportLine(replacementLineId);
    const chosen = await w
      .as(paid.guest)
      .choose(airIssueId, { choice: "voucher" });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(422);

    expect(await voucherValues(airIssueId), "no new voucher").toEqual([]);
    expect(await voucherValues(swapIssueId)).toEqual([KOPI_PAID]);
    const { rows } = await owner.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM apology_vouchers a
        WHERE a.tenant_id = $1 AND a.order_issue_id = ANY($2::uuid[])`,
      [w.tenant.tenantId, [swapIssueId, airIssueId]],
    );
    expect(Number(rows[0]!.total), "vouchers of the chain").toBe(1);
  });
});
