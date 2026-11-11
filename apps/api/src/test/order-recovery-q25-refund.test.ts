// legend-hhm5m items 3, 4, 5 (Codex 461 findings on the recovery refund consumer,
// stream B of docs/briefs/sub-rat9r-followups.md). Written FIRST, from the brief
// docs/briefs/461-refund-codex-fixes.md and the founder Q25 rule (voucher + refund
// <= what the guest paid; when in doubt, cap). The cases fail until the fixes land.
// The service code was NOT read; scenarios use only the API, the DB rows the other
// order-recovery tests already read, and outbox events.
//
// Item 3 (open bill + promo): another issue's pending refund reserves the whole
// payment, so refund A (kopi) is cut to Rp0, but A's goods share must still be booked
// on the promo ledger (`promotion_order_applications`). When that other reservation
// then fails and the room reopens, refund B (roti) must not be bigger than on an
// identical order where A paid normally, the ledger must not end above that order's
// ledger, and all live refunds of the payment stay within what was paid.
//
// Item 4 (filing order): A is filed, its approval expires (`approval_expired`), the
// refund is refiled (A2) and A2 is `rejected`. Whatever the clock does (A2 older than
// the expired first row, or the same `created_at` with a lower or a higher id), the
// rejected refund stays the latest of the chain: reporting the line again answers
// `nothing_left`, no refund row, no money owed. Plus: two filings of one order made
// at the same time get different, ordered `filingSeq` numbers (lock).
//
// Item 5 (tax rounding slot): three Rp1.003 lines (PBJT of the whole order is not the
// sum of the PBJT of the lines, so the cumulative split moves one rupiah between
// slots). Line 1 final-fails, the other two are filed (its slot moves), then line 1 is
// reported again. The replay must repeat the failed refund's split component by
// component (never take over the slot of another filing), the reversal request of the
// failed refund must be for exactly its amount, and per component the refunds still
// standing (every `order.refunded` minus the ones reversed) must not exceed the
// components of an identical order that was fully refunded the normal way.
//
// Assumptions where the brief is not exact:
// - Item 3 "A is Rp0": the other reservation is a pending refund row of the whole
//   payment total on the teh issue, forced by SQL (the API cannot make a competing
//   refund; same technique as order-recovery-refund-promo-final-failure.test.ts T8).
//   "Reservation fails": that row is set `failed` / `provider_declined` by SQL, the
//   failure hook is not run for it (it belongs to an issue that was never resolved).
//   A's booked share is asserted as "> 0"; its exact value is not fixed by the brief.
//   The baseline (identical order, no reservation) fixes the upper bound for B and the
//   ledger; the brief's 180rb example is a bigger order, the shape is the same.
// - Item 4 "monotonic": the clock skew and the tie are forced by SQL on
//   `payment_refunds.created_at` (and `id`) after the filings, under
//   `session_replication_role = replica`, as order-recovery-refund-filing-order.test.ts
//   does. The reject happens BEFORE the id is rewritten (its approval chain is keyed by
//   the refund id). The concurrency case reads the `filingSeq` key of the
//   `order-recovery-refund:<issueId>` idempotency response (named by that test file).
//   The refund approval policy is inserted in the LAST describe only (it opens
//   approval chains for every refund of the tenant).
// - Item 5 journal: "PBJT Rp2 must not be reversed as Rp3 in the journal" is checked at
//   the event level (the reversal request payload and the `order.refunded` components),
//   not on a posted journal: the journal reverses what those events say, and building a
//   chart of accounts through the API is outside this file. "All order.refunded <=
//   original" is read as the refunds that still stand (reversed ones are netted out),
//   because a reversed refund and its replay both exist as events.

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
import { originHeader } from "./helpers.ts";
import { db } from "../db/index.ts";
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
import { owner } from "./floor-test-helpers.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { and, eq } from "drizzle-orm";

// Each case builds paid orders through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 180_000 });

let w: World;
const freeRotiPromotion = randomUUID();
/** Rp1.003 items (rounding), a Rp20.000 item; all in no promotion. */
const bulatA = randomUUID();
const bulatB = randomUUID();
const bulatC = randomUUID();
const besar = randomUUID();
const BULAT_PRICE = 1_003;
const BESAR_PRICE = 20_000;
const KOPI_PRICE = 25_000;
const ROTI_PRICE = 18_000;

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
               now() - interval '1 hour', NULL, $3, $4, 'g_q25refund', true, 0, NULL, NULL, NULL)`,
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
      [bulatA, "Kue Bulat A", BULAT_PRICE],
      [bulatB, "Kue Bulat B", BULAT_PRICE],
      [bulatC, "Kue Bulat C", BULAT_PRICE],
      [besar, "Nasi Besar", BESAR_PRICE],
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
const HOUR_MS = 3_600_000;

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
  const order = placed.body.data.order as {
    id: string;
    items: { id: string; menuItemId: string }[];
  };
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
 * A PAID order of the given items. Pay-first: the guest pays through the API and
 * the verified webhook settles it. Open bill: the bill is settled by a paid intent
 * with evidence (rows inserted directly, as the cashier flow leaves it; the guest
 * cannot pay an open bill through the API).
 */
async function paidOrder(
  mode: "pay_first" | "open_bill",
  menuItemIds: string[],
) {
  const placed = await placeLines(mode, menuItemIds);
  if (mode === "pay_first") {
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'hhm5m-test')`,
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

type RefundRow = {
  id: string;
  amount_idr: number;
  status: string;
  failure_reason: string | null;
  created_at: Date;
};

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, amount_idr::int AS amount_idr, status, failure_reason, created_at
       FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = $2 ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

const sumOf = (rows: { amount_idr: number }[]) =>
  rows.reduce((total, row) => total + row.amount_idr, 0);

/** Files the refund of one line and returns the issue and its single refund row. */
async function filedRefund(itemId: string, amountIdr: number) {
  const made = await approvedRefund(itemId, amountIdr);
  await deliver(made.event);
  const refunds = await issueRefunds(made.issueId);
  expect(refunds, "first filing makes one refund").toHaveLength(1);
  return { ...made, refund: refunds[0]! };
}

/** Money still owed through these issues: every refund that is not `failed`. */
async function liveRefundTotal(issueIds: string[]): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::int AS total FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = ANY($2::uuid[]) AND status <> 'failed'`,
    [w.tenant.tenantId, issueIds],
  );
  return rows[0]!.total;
}

/** Every refund of the payment that is not `failed` (all issues, even unknown ones). */
async function liveRefundsOfIntent(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::int AS total FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.total;
}

async function intentOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_intent_id: string | null }>(
    "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(orderId)],
  );
  expect(rows[0]!.payment_intent_id, "order has an intent").not.toBeNull();
  return rows[0]!.payment_intent_id!;
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
  orderId: string,
): Promise<{ paid: number; subtotal: number }> {
  const { rows } = await owner.query<{
    refunded_paid_idr: number;
    refunded_subtotal_idr: number;
  }>(
    `SELECT refunded_paid_idr::int, refunded_subtotal_idr::int
       FROM promotion_order_applications
      WHERE tenant_id = $1 AND order_id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  expect(rows, "promo application row").toHaveLength(1);
  return {
    paid: rows[0]!.refunded_paid_idr,
    subtotal: rows[0]!.refunded_subtotal_idr,
  };
}

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

/** Reports the line again and delivers the approved refund. */
async function reportAgain(itemId: string, amountIdr: number) {
  const again = await approvedRefund(itemId, amountIdr);
  await deliver(again.event);
  return again;
}

// ---- hhm5m 3: open bill promo, the reservation of another refund ----------------

const PROMO_MENU = () => [w.ids.kopi, w.ids.teh, w.ids.roti];

/**
 * Another issue (never resolved) holds a pending refund of `amountIdr` on the order's
 * payment; returns the refund id so a test can end that reservation later.
 */
async function holdRoom(
  orderId: string,
  otherItemId: string,
  amountIdr: number,
): Promise<string> {
  const intentId = await intentOf(orderId);
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
      intentId,
      holder,
      amountIdr,
    ],
  );
  return refundId;
}

/**
 * The same open-bill promo order with no competing reservation: kopi refunded the
 * normal way, then roti. What B (roti) and the ledger look like when A paid.
 */
async function baselineOpenBillPromo() {
  const paid = await paidOrder("open_bill", PROMO_MENU());
  const a = await filedRefund(paid.line(w.ids.kopi).id, KOPI_PRICE);
  const ledgerAfterA = await ledgerOf(paid.order.id);
  const b = await reportAgain(paid.line(w.ids.roti).id, ROTI_PRICE);
  const bRows = await issueRefunds(b.issueId);
  return {
    total: paid.total,
    aAmount: a.refund.amount_idr,
    bAmount: sumOf(bRows),
    ledgerAfterA,
    ledgerAfterB: await ledgerOf(paid.order.id),
  };
}

describe("legend-hhm5m 3 open bill promo: refund A Rp0 karena reservasi lain tetap dicatat di ledger promo", () => {
  it("A = Rp0 mencatat bagiannya di ledger; reservasi lain gagal, refund B tidak melebihi order pembanding dan total refund <= dibayar", async () => {
    const base = await baselineOpenBillPromo();
    expect(base.aAmount, "baseline A pays money").toBeGreaterThan(0);
    expect(base.bAmount, "baseline B pays money").toBeGreaterThan(0);
    expect(
      base.ledgerAfterA.paid,
      "baseline A books a goods share",
    ).toBeGreaterThan(0);

    const paid = await paidOrder("open_bill", PROMO_MENU());
    const intentId = await intentOf(paid.order.id);
    // The teh issue holds the whole payment: A (kopi) has no room at all.
    const holderRefundId = await holdRoom(
      paid.order.id,
      paid.line(w.ids.teh).id,
      paid.total,
    );

    const a = await reportAgain(paid.line(w.ids.kopi).id, KOPI_PRICE);

    expect(
      await issueRefunds(a.issueId),
      "A is cut to Rp0: no refund row",
    ).toEqual([]);
    const ledgerAfterA = await ledgerOf(paid.order.id);
    expect(
      ledgerAfterA.paid,
      "A's goods share is booked on the promo ledger although A pays Rp0",
    ).toBeGreaterThan(0);
    expect(ledgerAfterA.subtotal).toBeGreaterThan(0);

    // The other reservation fails: the room opens again.
    await setFailed(holderRefundId, "provider_declined");

    const b = await reportAgain(paid.line(w.ids.roti).id, ROTI_PRICE);
    const bAmount = sumOf(await issueRefunds(b.issueId));

    // Money invariants: nobody is paid more than on the order where A paid normally.
    expect(
      bAmount,
      "B never more than on the baseline order",
    ).toBeLessThanOrEqual(base.bAmount);
    expect(
      await liveRefundsOfIntent(intentId),
      "refunds <= paid",
    ).toBeLessThanOrEqual(paid.total);
    expect(
      (await liveRefundTotal([a.issueId, b.issueId])) + 0,
      "A + B <= what the baseline paid for both",
    ).toBeLessThanOrEqual(base.aAmount + base.bAmount);
    const ledgerAfterB = await ledgerOf(paid.order.id);
    expect(ledgerAfterB.paid).toBeGreaterThanOrEqual(ledgerAfterA.paid);
    expect(ledgerAfterB.paid, "ledger paid <= baseline").toBeLessThanOrEqual(
      base.ledgerAfterB.paid,
    );
    expect(
      ledgerAfterB.subtotal,
      "ledger subtotal <= baseline",
    ).toBeLessThanOrEqual(base.ledgerAfterB.subtotal);
  });
});

// ---- hhm5m 5: replay and the tax rounding slot -----------------------------------

const SPLIT_FIELDS = [
  "amountIdr",
  "grossSalesIdr",
  "discountIdr",
  "serviceChargeIdr",
  "pbjtIdr",
] as const;
type Split = Record<(typeof SPLIT_FIELDS)[number], number>;

const emptySplit = (): Split => ({
  amountIdr: 0,
  grossSalesIdr: 0,
  discountIdr: 0,
  serviceChargeIdr: 0,
  pbjtIdr: 0,
});

function addSplit(total: Split, part: Split): Split {
  const next = { ...total };
  for (const field of SPLIT_FIELDS) next[field] += part[field];
  return next;
}

/** Sum of the `order.refunded` splits whose issue was NOT reversed. */
async function standingSplit(orderId: string, issueIds: string[]) {
  const reversed = new Set<string>();
  for (const issueId of issueIds)
    if (
      (await w.outboxRows("order_issue.refund_reversal_requested", issueId))
        .length > 0
    )
      reversed.add(issueId);
  return (await refundedEvents(orderId))
    .filter((event) => !reversed.has(event.refundId))
    .reduce((total, event) => addSplit(total, event), emptySplit());
}

describe("legend-hhm5m 5 replay tidak memakai ulang slot pembulatan pajak", () => {
  // Rp1.003 x3: PBJT of the whole order (316) is not 3 x 105, so one of the three
  // slots carries an extra rupiah. Each case fails a DIFFERENT line (slot 1, 2 or 3)
  // after all three were filed, then reports it again.
  it.each([0, 1, 2])(
    "baris ke-%i gagal final lalu dilaporkan ulang: replay mengulang split asal komponen demi komponen; pembalikan sebesar refund asal; komponen yang berdiri <= komponen order",
    async (failedIndex) => {
      const items = [bulatA, bulatB, bulatC];
      // Reference: an identical order refunded line by line the normal way. Its sum
      // per component is the most a full refund of this order may ever reach.
      const reference = await paidOrder("pay_first", items);
      const referenceIssues: string[] = [];
      for (const itemId of items)
        referenceIssues.push(
          (await filedRefund(reference.line(itemId).id, BULAT_PRICE)).issueId,
        );
      const original = await standingSplit(reference.order.id, referenceIssues);
      expect(original.amountIdr, "reference <= paid").toBeLessThanOrEqual(
        reference.total,
      );
      expect(original.pbjtIdr, "reference books PBJT").toBeGreaterThan(0);

      const paid = await paidOrder("pay_first", items);
      expect(paid.total).toBe(reference.total);
      const filed = [];
      for (const itemId of items)
        filed.push(await filedRefund(paid.line(itemId).id, BULAT_PRICE));
      const failed = filed[failedIndex]!;
      await failFinally(failed.refund.id, "provider_declined");
      const again = await reportAgain(
        paid.line(items[failedIndex]!).id,
        BULAT_PRICE,
      );

      const events = await refundedEvents(paid.order.id);
      const first = events.find((event) => event.refundId === failed.issueId)!;
      const replay = events.find((event) => event.refundId === again.issueId)!;
      expect(first, "the failed refund booked order.refunded").toBeDefined();
      expect(replay, "the replay booked order.refunded").toBeDefined();

      // The replay refunds exactly what failed, split included (PBJT too).
      for (const field of SPLIT_FIELDS)
        expect(replay[field], `replay ${field}`).toBe(first[field]);
      expect(sumOf(await issueRefunds(again.issueId))).toBe(
        failed.refund.amount_idr,
      );

      // The reversal request undoes exactly the amount of the failed refund.
      const reversals = await w.outboxRows(
        "order_issue.refund_reversal_requested",
        failed.issueId,
      );
      expect(reversals).toHaveLength(1);
      expect(
        (reversals[0]!.event.payload as { amountIdr: number }).amountIdr,
      ).toBe(first.amountIdr);

      // What still stands never exceeds the original components, one by one.
      const issueIds = [...filed.map((entry) => entry.issueId), again.issueId];
      const standing = await standingSplit(paid.order.id, issueIds);
      for (const field of SPLIT_FIELDS)
        expect(standing[field], `standing ${field}`).toBeLessThanOrEqual(
          original[field],
        );
      expect(
        standing.amountIdr,
        "standing refunds <= paid",
      ).toBeLessThanOrEqual(paid.total);
      expect(await liveRefundTotal(issueIds)).toBeLessThanOrEqual(paid.total);
    },
  );

  // The slot MOVES: line i final-fails BEFORE the later lines are filed, so the next
  // line takes line i's cumulative slot; then line i replays. With slots 105/106/105
  // failing line 1 lets line 2 take the 106 slot and the replay ask 106 again: 317 of
  // a 316 PBJT. Checked on the `order.refunded` components the journal posts as is
  // (the journal fixture of order-recovery-refund-final-failure.test.ts is a seeded
  // tenant with synthetic events, not this consumer's events).
  it.each([0, 1])(
    "baris ke-%i gagal final sebelum baris berikut diajukan (slot dipakai baris lain): PBJT dan komponen yang berdiri tidak melebihi order",
    async (failedIndex) => {
      const items = [bulatA, bulatB, bulatC];
      const reference = await paidOrder("pay_first", items);
      const referenceIssues: string[] = [];
      for (const itemId of items)
        referenceIssues.push(
          (await filedRefund(reference.line(itemId).id, BULAT_PRICE)).issueId,
        );
      const original = await standingSplit(reference.order.id, referenceIssues);
      expect(original.pbjtIdr, "reference books PBJT").toBeGreaterThan(0);

      const paid = await paidOrder("pay_first", items);
      expect(paid.total).toBe(reference.total);
      const filed = [];
      for (const itemId of items.slice(0, failedIndex + 1))
        filed.push(await filedRefund(paid.line(itemId).id, BULAT_PRICE));
      const failed = filed[failedIndex]!;
      await failFinally(failed.refund.id, "provider_declined");
      for (const itemId of items.slice(failedIndex + 1))
        filed.push(await filedRefund(paid.line(itemId).id, BULAT_PRICE));
      const again = await reportAgain(
        paid.line(items[failedIndex]!).id,
        BULAT_PRICE,
      );
      const replay = (await refundedEvents(paid.order.id)).find(
        (event) => event.refundId === again.issueId,
      );
      expect(replay, "the replay booked order.refunded").toBeDefined();
      expect(
        sumOf(await issueRefunds(again.issueId)),
        "replay never above the failed refund",
      ).toBeLessThanOrEqual(failed.refund.amount_idr);

      const issueIds = [...filed.map((entry) => entry.issueId), again.issueId];
      const standing = await standingSplit(paid.order.id, issueIds);
      for (const field of SPLIT_FIELDS)
        expect(standing[field], `standing ${field}`).toBeLessThanOrEqual(
          original[field],
        );
      expect(await liveRefundTotal(issueIds)).toBeLessThanOrEqual(paid.total);
    },
  );
});

// ---- hhm5m 4: the order of filings follows the refile relation -------------------
// LAST describe: it inserts a refund approval policy for the tenant (refunds then
// open approval chains, which is how `approval_expired` and a refile are made).

/**
 * Rewrites columns of a refund row by SQL, like a host clock that stepped back.
 * `replica` mode keeps immutability triggers and FK checks out of the way.
 */
async function forceRefund(
  refundId: string,
  set: { createdAt?: Date; newId?: string },
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenant.tenantId],
    );
    if (set.createdAt)
      await client.query(
        "UPDATE payment_refunds SET created_at = $3 WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, refundId, set.createdAt],
      );
    if (set.newId)
      await client.query(
        "UPDATE payment_refunds SET id = $3 WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, refundId, set.newId],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Ends the refund `failed` as an expired or rejected approval chain does. */
async function failChain(
  refundId: string,
  how: "approval_expired" | "rejected",
) {
  if (how === "approval_expired")
    await owner.query(
      "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
      [w.tenant.tenantId, refundId],
    );
  else
    await owner.query(
      `UPDATE approval_requests
          SET status = 'rejected', decided_by = $3, decided_at = now(), reason = 'Ditolak uji hhm5m'
        WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [w.tenant.tenantId, refundId, w.approverUserId],
    );
  const settled = await settleRefundFromChain(
    contextOf(w.tenant.tenantId),
    refundId,
  );
  expect(settled.status).toBe("failed");
  expect(settled.failureReason).toBe(how);
}

/** A filed, its approval expired, the refile A2 rejected: the line owes nothing. */
async function expiredThenRejected(mode: "pay_first" | "open_bill") {
  const paid = await paidOrder(mode, [bulatA, besar]);
  const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
  await failChain(a.refund.id, "approval_expired");
  const rows = await issueRefunds(a.issueId);
  expect(rows, "the expired refund was refiled").toHaveLength(2);
  const first = rows.find((row) => row.id === a.refund.id)!;
  const refiled = rows.find((row) => row.id !== a.refund.id)!;
  expect(first.status).toBe("failed");
  expect(refiled.status, "the refile is live").not.toBe("failed");
  await failChain(refiled.id, "rejected");
  return { paid, a, first, refiled };
}

async function expectNothingOwed(
  paid: { order: { id: string }; line: (id: string) => { id: string } },
  a: { issueId: string },
  mode: "pay_first" | "open_bill",
) {
  const c = await reportAgain(paid.line(bulatA).id, BULAT_PRICE);
  expect(await issueRefunds(c.issueId), "no refund is opened").toEqual([]);
  const blocked = await auditRows([c.issueId], "order_issue.refund_blocked");
  expect(blocked).toHaveLength(1);
  expect(JSON.stringify(blocked[0])).toContain("nothing_left");
  expect(await liveRefundTotal([a.issueId, c.issueId])).toBe(0);
  if (mode === "pay_first")
    expect(
      (await refundedEvents(paid.order.id)).map((event) => event.refundId),
      "no order.refunded for the new report",
    ).not.toContain(c.issueId);
}

describe("legend-hhm5m 4 urutan refile: refund yang ditolak tidak dibuka kembali", () => {
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', 0, $2, 1)`,
      [w.tenant.tenantId, w.ids.supervisorRole],
    );
  });

  it.each(["pay_first", "open_bill"] as const)(
    "%s, jam mundur: refile A2 (ditolak) lebih tua dari refund A1 (kedaluwarsa); lapor ulang tetap nothing_left",
    async (mode) => {
      const { paid, a, first } = await expiredThenRejected(mode);
      const refiled = (await issueRefunds(a.issueId)).find(
        (row) => row.id !== first.id,
      )!;
      await forceRefund(refiled.id, {
        createdAt: new Date(first.created_at.getTime() - HOUR_MS),
      });

      await expectNothingOwed(paid, a, mode);
    },
  );

  it.each([
    ["id refile di bawah id refund pertama", "00000000"],
    ["id refile di atas id refund pertama", "ffffffff"],
  ])(
    "created_at sama persis, %s: lapor ulang tetap nothing_left",
    async (_, prefix) => {
      const { paid, a, first } = await expiredThenRejected("pay_first");
      const refiled = (await issueRefunds(a.issueId)).find(
        (row) => row.id !== first.id,
      )!;
      const newId = `${prefix}${randomUUID().slice(8)}`;
      await forceRefund(refiled.id, { createdAt: first.created_at, newId });
      const rows = await issueRefunds(a.issueId);
      expect(rows.map((row) => row.created_at.getTime())).toEqual([
        first.created_at.getTime(),
        first.created_at.getTime(),
      ]);
      expect(rows.map((row) => row.id)).toContain(newId);

      await expectNothingOwed(paid, a, "pay_first");
    },
  );

  it("dua pengajuan serentak pada satu pesanan mendapat nomor urut filing berbeda dan berurutan (di bawah lock)", async () => {
    const paid = await paidOrder("pay_first", [bulatA, bulatB, besar]);
    const first = await approvedRefund(paid.line(bulatA).id, BULAT_PRICE);
    const second = await approvedRefund(paid.line(bulatB).id, BULAT_PRICE);

    const settled = await Promise.allSettled([
      deliver(first.event),
      deliver(second.event),
    ]);
    expect(settled.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);

    const seqs = [
      (await filingResponse(first.issueId)).filingSeq,
      (await filingResponse(second.issueId)).filingSeq,
    ];
    expect(seqs.every((seq) => typeof seq === "number")).toBe(true);
    expect(new Set(seqs).size, "distinct filing numbers").toBe(2);
    // Each issue got exactly its own refund, and nothing is owed twice.
    expect(await issueRefunds(first.issueId)).toHaveLength(1);
    expect(await issueRefunds(second.issueId)).toHaveLength(1);
    expect(
      await liveRefundTotal([first.issueId, second.issueId]),
    ).toBeLessThanOrEqual(paid.total);
  });
});
