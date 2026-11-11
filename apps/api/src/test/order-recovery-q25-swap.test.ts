// legend-hhm5m 1+2, legend-eajpb, legend-pqm3t (founder W4 Q25, 11 Nov): voucher +
// refund per item <= what the guest PAID for that item. Money invariant in every
// case: no party is paid more than the guest paid, so the outlet never loses.
// Written FIRST from docs/briefs/sub-rat9r-followups.md (flow A) and
// docs/briefs/461-refund-codex-fixes.md items 1 and 2, and from the shared
// validators; most cases fail until the follow-up lands.
//
// Numbers (service 5%, PBJT 10% on goods + service, as in the other recovery tests):
// - Promo order kopi + teh + roti: the kopi is paid 8.085 (goods 7.000 x 1,155).
// - Plain item Rp100.000 alone: paid 115.500 (100.000 + 5.000 + 10.500). The dearer
//   swap to Rp200.000 owes an extra charge of 115.500 (difference 100.000 + service
//   + PBJT). Once the extra is paid the chain holds 92.400.
// - Plain kopi (no promo): paid 28.875.
//
// Assumptions where the brief is not exact:
// - Swap voucher formula stays `min(list difference, paid - chain vouchers - live
//   chain refunds)`, so A -> B (extra unpaid) -> C mints exactly 46.200
//   (list difference 60.000), and 60.000 once the extra is really paid (<= 92.400).
// - "System voucher" = the voucher the guest picks for a failed replacement line
//   (POST customer-choice {choice: "voucher"}); its value is the line value cut to
//   the room left. A staff apology voucher with `orderIssueId` is the other path.
// - "Paid value stored" is read from `order_issues.paid_value_idr` (migration 0235).
// - The swap-choice preview with the difference is `options.swap.items[].
//   differenceIdr` of GET /api/table-sessions/:id/order-issues (the guest list the
//   UI renders; negative = credited). GET /api/order-issues/:id/options carries the
//   voucher preview only (`voucher.valueIdr`), asserted too.
// - Staff apology voucher of 100.000 sits on the approval floor (VOUCHER_APPROVAL_
//   FLOOR_IDR). The cap must answer 422 BEFORE the approval question (not 409).
// - A second issue on a line that already has a live refund is forced by SQL
//   (the API would replay the first issue), as order-recovery-rereport.test.ts does.
//   A staff voucher on that second issue is bounded by what is left of the paid
//   value after the live refund (0): any value above the room is a 422.
// - A swap made before paid_value_idr existed (column set NULL by SQL): either the
//   paid value is computed from the order, or the voucher is refused (409/422).
//   Asserted as the invariant: chain vouchers + refunds <= paid, no 5xx.
// - A dearer swap in the promo order is price_correction approved for the
//   difference (as order-recovery-swap-voucher-paid-cap.test.ts does).

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
import { and, eq } from "drizzle-orm";
import { agent, originHeader } from "./helpers.ts";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
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
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

// Each case builds a paid order through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

let w: World;
const freeRotiPromotion = randomUUID();

const AIR_PRICE = 5_000;
const MID_PRICE = 20_000;
const PREMIUM_PRICE = 35_000;
const KOPI_PRICE = 25_000;
const KOPI_LAIN_PRICE = 25_000;
const ITEM_A_PRICE = 40_000;
const ITEM_B_PRICE = 80_000;
const ITEM_C_PRICE = 20_000;
/** Promo order kopi + teh + roti: order total and the kopi paid value. */
const ORDER_TOTAL = 42_735;
const KOPI_PAID = 8_085;
/** Swap kopi -> mid (list difference 5.000) leaves this room under the paid value. */
const MID_VOUCHER = KOPI_PRICE - MID_PRICE;
const MID_ROOM = KOPI_PAID - MID_VOUCHER;
/** Plain kopi order: paid for the kopi, and the list difference kopi -> air. */
const PLAIN_KOPI_PAID = 28_875;
const PLAIN_AIR_CREDIT = KOPI_PRICE - AIR_PRICE;
/** Plain Rp40.000 item A: what the guest paid, and the extra owed by the Rp80.000 swap to B. */
const ITEM_A_PAID = 46_200;
const ITEM_B_EXTRA_PAID = 46_200;
const REASON = "Pelanggan menolak ganti menu dan voucher";
const APOLOGY_REASON = "Item gagal, mohon maaf atas ketidaknyamanan";

const airItem = randomUUID();
const midItem = randomUUID();
const premiumItem = randomUUID();
const kopiLainItem = randomUUID();
const itemA = randomUUID();
const itemB = randomUUID();
const itemC = randomUUID();

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
               now() - interval '1 hour', NULL, $3, $4, 'g_q25swap', true, 0, NULL, NULL, NULL)`,
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
      [airItem, "Air Mineral Q25", AIR_PRICE],
      [midItem, "Menu Tengah Q25", MID_PRICE],
      [premiumItem, "Menu Premium Q25", PREMIUM_PRICE],
      [kopiLainItem, "Kopi Lain Q25", KOPI_LAIN_PRICE],
      [itemA, "Menu A Q25", ITEM_A_PRICE],
      [itemB, "Menu B Q25", ITEM_B_PRICE],
      [itemC, "Menu C Q25", ITEM_C_PRICE],
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
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// ---- order setup -----------------------------------------------------------------

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
  const event = await paidEvent(intentId);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event, event.id, tx),
  );
}

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

type PaidOrder = {
  guest: Guest;
  order: { id: string; items: { id: string; menuItemId: string }[] };
  total: number;
  line: (menuItemId: string) => { id: string; menuItemId: string };
};

/** A PAID pay-first order with one of each item (the verified webhook settles it). */
async function paidOrderOf(menuItemIds: string[]): Promise<PaidOrder> {
  const guest = await w.seat("pay_first");
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
  const { rows } = await owner.query<{ total_idr: number }>(
    "SELECT total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(order.id)],
  );
  const total = rows[0]!.total_idr;
  const payment = await w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, total)).toBe(true);
  return {
    guest,
    order,
    total,
    line: (menuItemId) =>
      order.items.find((item) => item.menuItemId === menuItemId)!,
  };
}

/** Promo order kopi + teh + roti: the kopi is paid 8.085. */
async function paidPromoOrder() {
  const paid = await paidOrderOf([w.ids.kopi, w.ids.teh, w.ids.roti]);
  expect(paid.total, "promo order total").toBe(ORDER_TOTAL);
  return paid;
}

/** Plain order kopi + roti (no promo): the kopi is paid 28.875. */
async function paidPlainOrder() {
  return paidOrderOf([w.ids.kopi, w.ids.roti]);
}

/** Plain order with only item A (Rp40.000): paid 46.200. */
async function paidItemAOrder() {
  const paid = await paidOrderOf([itemA]);
  expect(paid.total, "item A order total").toBe(ITEM_A_PAID);
  return paid;
}

// ---- issue, swap, refund, voucher helpers ------------------------------------------

async function reportLine(lineId: string) {
  const reported = await w.report(lineId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return reported.body.data.id as string;
}

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

async function resolvedEvent(issueId: string) {
  const resolved = await w.outboxRows("order_issue.resolved", issueId);
  expect(resolved).toHaveLength(1);
  return resolved[0]!.event;
}

/** Delivers the swap kitchen event of a resolved swap (writes the replacement line). */
async function deliverSwapKitchen(issueId: string) {
  const event = await resolvedEvent(issueId);
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

/** Reports a line and swaps it to a CHEAPER or equal item (no approval needed). */
async function swapLineTo(lineId: string, replacementItemId: string) {
  const swapIssueId = await reportLine(lineId);
  const swapped = await resolveSwap(swapIssueId, replacementItemId);
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  await deliverSwapKitchen(swapIssueId);
  return {
    swapIssueId,
    replacementLineId: await replacementLineOf(swapIssueId),
  };
}

/**
 * Reports a line and swaps it to a DEARER item (price_correction approved for the
 * difference). The kitchen event writes the replacement line and the charge event
 * opens the extra charge, as the worker does.
 */
async function swapLineDearer(
  lineId: string,
  replacementItemId: string,
  differenceIdr: number,
) {
  const swapIssueId = await reportLine(lineId);
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: swapIssueId,
    amountIdr: differenceIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const swapped = await resolveSwap(swapIssueId, replacementItemId, approvalId);
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  const event = await deliverSwapKitchen(swapIssueId);
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverIssueChargeEvent(context, event, tx),
  );
  return {
    swapIssueId,
    replacementLineId: await replacementLineOf(swapIssueId),
  };
}

/** The guest pays the extra charge of a dearer swap for real (verified webhook). */
async function payExtraCharge(guest: Guest, swapIssueId: string) {
  const { rows } = await owner.query<{ id: string; amount_idr: number }>(
    `SELECT id, amount_idr::int AS amount_idr FROM order_issue_charges
      WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, swapIssueId],
  );
  expect(rows, "one extra charge").toHaveLength(1);
  const charge = rows[0]!;
  const created = await agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${charge.id}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const intentId = created.body.data.id as string;
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: charge.amount_idr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const event = await paidEvent(intentId);
  const routed = await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx),
  );
  expect(routed).toEqual({ route: "issue_charge", outcome: "paid" });
  return charge.amount_idr;
}

/** The apology vouchers minted for an issue (swap credit, guest or staff voucher). */
async function voucherValues(issueId: string): Promise<number[]> {
  const { rows } = await owner.query<{ value_idr: string }>(
    `SELECT v.value_idr FROM vouchers v
     JOIN apology_vouchers a ON a.voucher_id = v.id AND a.tenant_id = v.tenant_id
     WHERE a.tenant_id = $1 AND a.order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  return rows.map((row) => Number(row.value_idr));
}

async function vouchersOf(issueIds: string[]) {
  return sum((await Promise.all(issueIds.map(voucherValues))).flat());
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

async function refundedTotal(issueId: string) {
  return sum((await issueRefunds(issueId)).map((row) => row.amount_idr));
}

async function deliver(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
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
  const issueId = await reportLine(itemId);
  return { issueId, event: await resolveForRefund(issueId, amountIdr) };
}

/** Files the refund of one line; returns the issue and its single refund row. */
async function filedRefund(itemId: string, amountIdr: number) {
  const made = await approvedRefund(itemId, amountIdr);
  await deliver(made.event);
  const refunds = await issueRefunds(made.issueId);
  expect(refunds, "first filing makes one refund").toHaveLength(1);
  return { ...made, refund: refunds[0]! };
}

async function paidValueOf(issueId: string): Promise<number | null> {
  const { rows } = await owner.query<{ paid_value_idr: number | null }>(
    "SELECT paid_value_idr::int AS paid_value_idr FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows, "issue row").toHaveLength(1);
  return rows[0]!.paid_value_idr;
}

/** A swap made before migration 0235: the stored paid value is gone. */
async function clearPaidValue(issueId: string) {
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE order_issues SET paid_value_idr = NULL WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, issueId],
    );
  });
  expect(await paidValueOf(issueId)).toBeNull();
}

/** Inserts a second, open issue for the line by SQL (the API would replay the first). */
async function forceOpenIssue(orderId: string, itemId: string) {
  const issueId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenant.tenantId],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, cost_idr, status, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Dipaksa lewat SQL',
         $6, 0, 'open', $7)`,
      [
        issueId,
        w.tenant.tenantId,
        w.tenant.outletId,
        toUuid(orderId),
        toUuid(itemId),
        w.supervisor.userId,
        `forced-${randomUUID()}`,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return issueId;
}

/** Staff apology voucher tied to an issue (POST /api/apology-vouchers). */
function apology(
  issueId: string,
  valueIdr: number,
  host: string = w.tenant.hostname,
) {
  return w.staffPost(
    w.supervisor,
    "/api/apology-vouchers",
    { valueIdr, reason: APOLOGY_REASON, orderIssueId: issueId },
    host,
  );
}

async function issueStatus(issueId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]!.status;
}

/** Runs the failure hook on a refund row (final failure frees the paid value again). */
async function failFinally(refundId: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = 'provider_declined', decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId],
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

type GuestIssueView = {
  id: string;
  options: {
    swap: {
      allowed: boolean;
      items: { menuItemId: string; priceIdr: number; differenceIdr: number }[];
    };
    voucher: { allowed: boolean; valueIdr: number };
  };
};

/** The swap-choice preview row the guest sees for one replacement item. */
async function previewOf(guest: Guest, issueId: string, menuItemId: string) {
  const list = await w.as(guest).issues();
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  const issue = (list.body.data as GuestIssueView[]).find(
    (row) => row.id === issueId,
  );
  expect(issue, "issue listed for the guest").toBeDefined();
  return issue!.options.swap.items.find(
    (item) => item.menuItemId === menuItemId,
  );
}

// =====================================================================================
// legend-hhm5m 1: chained swap, the extra of a dearer swap counts only once paid
// =====================================================================================

describe("legend-hhm5m 1: tukar berantai, tambahan belum dibayar tidak dihitung", () => {
  it("40rb -> 80rb (tambahan belum dibayar) -> 20rb: voucher kedua 46.200, bukan 60.000, dan jumlah voucher rantai <= nilai dibayar item asal", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA).id,
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
    );
    expect(
      await voucherValues(first.swapIssueId),
      "a dearer swap gives no voucher",
    ).toEqual([]);

    const second = await swapLineTo(first.replacementLineId, itemC);

    const secondVouchers = await voucherValues(second.swapIssueId);
    expect(secondVouchers, "never the 60.000 list difference").not.toContain(
      ITEM_B_PRICE - ITEM_C_PRICE,
    );
    expect(secondVouchers).toEqual([ITEM_A_PAID]);
    // Money invariant: the guest paid 46.200 for the item, nothing of the extra yet.
    expect(
      await vouchersOf([first.swapIssueId, second.swapIssueId]),
    ).toBeLessThanOrEqual(ITEM_A_PAID);
  });

  it("setelah rantai itu, refund lini 20rb tidak menambah: voucher + refund rantai tetap <= 46.200", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA).id,
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
    );
    const second = await swapLineTo(first.replacementLineId, itemC);

    const refund = await approvedRefund(second.replacementLineId, ITEM_C_PRICE);
    await deliver(refund.event);

    const total =
      (await vouchersOf([first.swapIssueId, second.swapIssueId])) +
      (await refundedTotal(refund.issueId)) +
      (await refundedTotal(first.swapIssueId)) +
      (await refundedTotal(second.swapIssueId));
    expect(total).toBeLessThanOrEqual(ITEM_A_PAID);
  });

  it("tambahan 46.200 sudah benar-benar dibayar: tukar ke 20rb boleh memakainya, voucher 60.000 <= 92.400", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA).id,
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
    );
    const extra = await payExtraCharge(paid.guest, first.swapIssueId);
    expect(extra, "the extra owed by the dearer swap").toBe(ITEM_B_EXTRA_PAID);

    const second = await swapLineTo(first.replacementLineId, itemC);

    // Once the extra is paid the chain holds 92.400: the full list difference fits.
    expect(await voucherValues(second.swapIssueId)).toEqual([
      ITEM_B_PRICE - ITEM_C_PRICE,
    ]);
    expect(
      await vouchersOf([first.swapIssueId, second.swapIssueId]),
    ).toBeLessThanOrEqual(ITEM_A_PAID + ITEM_B_EXTRA_PAID);
  });

  it("tukar lebih mahal menyimpan nilai dibayar item asal (46.200) di order_issues, tambahan tidak ikut", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA).id,
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
    );
    expect(await paidValueOf(first.swapIssueId)).toBe(ITEM_A_PAID);

    const second = await swapLineTo(first.replacementLineId, itemC);
    expect(
      await paidValueOf(second.swapIssueId),
      "the chain keeps the paid value of the original item",
    ).toBe(ITEM_A_PAID);
  });

  it("tanpa tambahan sama sekali (40rb ditukar langsung ke 20rb): voucher 20.000, tidak berubah", async () => {
    const paid = await paidItemAOrder();
    const only = await swapLineTo(paid.line(itemA).id, itemC);

    expect(await voucherValues(only.swapIssueId)).toEqual([
      ITEM_A_PRICE - ITEM_C_PRICE,
    ]);
    expect(await vouchersOf([only.swapIssueId])).toBeLessThanOrEqual(
      ITEM_A_PAID,
    );
  });
});

// =====================================================================================
// legend-hhm5m 2: the paid value is stored on EVERY swap; system voucher <= paid
// =====================================================================================

describe("legend-hhm5m 2: nilai dibayar tersimpan di semua tukar, voucher sistem <= dibayar", () => {
  it("tukar ke harga sama (kopi promo dibayar 8.085): tidak ada voucher selisih, tetapi nilai dibayar 8.085 tersimpan", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, kopiLainItem);

    expect(await voucherValues(swap.swapIssueId)).toEqual([]);
    expect(await paidValueOf(swap.swapIssueId)).toBe(KOPI_PAID);
  });

  it("tukar ke harga sama, pengganti gagal, tamu memilih voucher: voucher 8.085, bukan harga daftar 25.000", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, kopiLainItem);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    const options = await w.as(paid.guest).issueOptions(replacementIssueId);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.data.voucher).toEqual({
      allowed: true,
      valueIdr: KOPI_PAID,
    });

    const chosen = await w
      .as(paid.guest)
      .choose(replacementIssueId, { choice: "voucher" });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(await voucherValues(replacementIssueId)).toEqual([KOPI_PAID]);
    expect(
      await vouchersOf([swap.swapIssueId, replacementIssueId]),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("tukar ke harga sama, pengganti gagal, voucher maaf staf: di atas 8.085 ditolak 422, tepat 8.085 lolos", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, kopiLainItem);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    const over = await apology(replacementIssueId, KOPI_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(await voucherValues(replacementIssueId)).toEqual([]);
    expect(await issueStatus(replacementIssueId)).toBe("open");

    const exact = await apology(replacementIssueId, KOPI_PAID);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await voucherValues(replacementIssueId)).toEqual([KOPI_PAID]);
  });

  it("tukar lebih mahal pada item promo: nilai dibayar 8.085 tersimpan, pengganti gagal, voucher tamu <= 8.085", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineDearer(
      paid.line(w.ids.kopi).id,
      premiumItem,
      PREMIUM_PRICE - KOPI_PRICE,
    );
    expect(await paidValueOf(swap.swapIssueId)).toBe(KOPI_PAID);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    const chosen = await w
      .as(paid.guest)
      .choose(replacementIssueId, { choice: "voucher" });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    // The premium line is worth 35.000 but only 8.085 of the extra-less swap was paid.
    expect(await voucherValues(replacementIssueId)).toEqual([KOPI_PAID]);
  });

  it("tukar ke harga sama lalu pengganti gagal: refund pengganti ditambah voucher <= 8.085", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, kopiLainItem);
    const refund = await approvedRefund(
      swap.replacementLineId,
      KOPI_LAIN_PRICE,
    );
    await deliver(refund.event);

    expect(
      (await vouchersOf([swap.swapIssueId])) +
        (await refundedTotal(refund.issueId)),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("order tanpa promo, tukar ke harga sama, pengganti gagal: voucher tamu positif dan <= 28.875 (regresi)", async () => {
    const paid = await paidPlainOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, kopiLainItem);
    expect(await paidValueOf(swap.swapIssueId)).toBe(PLAIN_KOPI_PAID);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    const chosen = await w
      .as(paid.guest)
      .choose(replacementIssueId, { choice: "voucher" });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const [value] = await voucherValues(replacementIssueId);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(PLAIN_KOPI_PAID);
  });
});

// =====================================================================================
// legend-eajpb: staff apology voucher of a plain issue (no swap chain) is bounded
// =====================================================================================

describe("legend-eajpb: voucher maaf staf tanpa rantai tukar dibatasi nilai dibayar baris", () => {
  it("laporan biasa pada baris promo dibayar 8.085: voucher maaf 100.000 ditolak 422, tidak ada voucher, issue tetap open", async () => {
    const paid = await paidPromoOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const refused = await apology(issueId, 100_000);

    // The cap answers before the approval question (100.000 is on the approval floor).
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(await voucherValues(issueId)).toEqual([]);
    expect(await issueStatus(issueId)).toBe("open");
  });

  it("baris dibayar 8.085: 8.086 ditolak 422, tepat 8.085 lolos dan issue selesai dengan voucher itu", async () => {
    const paid = await paidPromoOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const over = await apology(issueId, KOPI_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(await voucherValues(issueId)).toEqual([]);

    const exact = await apology(issueId, KOPI_PAID);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await voucherValues(issueId)).toEqual([KOPI_PAID]);
    expect(await issueStatus(issueId)).toBe("resolved");
  });

  it("replay voucher yang sudah terbit (8.085, sisa kini 0) mengembalikan hasil tersimpan: id dan kode sama, tetap satu voucher", async () => {
    const paid = await paidPromoOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);
    const first = await apology(issueId, KOPI_PAID);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const replay = await apology(issueId, KOPI_PAID);

    // Not a 422 for "no room left": the stored voucher is returned as it was.
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.data.code).toBe(first.body.data.code);
    expect(await voucherValues(issueId)).toEqual([KOPI_PAID]);
  });

  it("refund manual sudah terbit (8.085) lalu laporan kedua pada baris sama: voucher maaf > sisa (0) ditolak 4xx, tanpa voucher", async () => {
    const paid = await paidPromoOrder();
    const kopiId = paid.line(w.ids.kopi).id;
    const first = await filedRefund(kopiId, KOPI_PRICE);
    expect(first.refund.amount_idr, "refund = paid value").toBe(KOPI_PAID);
    const secondIssueId = await forceOpenIssue(paid.order.id, kopiId);

    // Nothing is left (refund 8.085 = paid 8.085), so any voucher is refused: 422
    // (over the room) or 409 (the line is already settled), never a 5xx or a 2xx.
    for (const value of [1_000, 100_000]) {
      const refused = await apology(secondIssueId, value);
      expect([409, 422], JSON.stringify(refused.body)).toContain(
        refused.status,
      );
    }

    expect(await voucherValues(secondIssueId)).toEqual([]);
    // Money invariant: refund + vouchers of the line never pass what was paid.
    expect(
      (await refundedTotal(first.issueId)) +
        (await vouchersOf([first.issueId, secondIssueId])),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("refund manual gagal final (uang kembali ke sisa): laporan kedua boleh voucher sampai 8.085, tidak lebih", async () => {
    const paid = await paidPromoOrder();
    const kopiId = paid.line(w.ids.kopi).id;
    const first = await filedRefund(kopiId, KOPI_PRICE);
    await failFinally(first.refund.id);
    const secondIssueId = await forceOpenIssue(paid.order.id, kopiId);

    const over = await apology(secondIssueId, KOPI_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    const exact = await apology(secondIssueId, KOPI_PAID);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
  });

  it("voucher maaf pertama 5.000 pada baris promo, laporan kedua pada baris sama: 3.086 ditolak 4xx, total voucher <= 8.085", async () => {
    // Assumption: a voucher already issued for the line counts in the room of a later
    // issue on the same line (founder rule: voucher + refund per item <= paid). Only
    // the refusal above the room is pinned (409 or 422); a voucher up to the room
    // (3.085) may be accepted or refused as already settled, so it is not pinned.
    const paid = await paidPromoOrder();
    const kopiId = paid.line(w.ids.kopi).id;
    const firstIssueId = await reportLine(kopiId);
    const first = await apology(firstIssueId, MID_VOUCHER);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const secondIssueId = await forceOpenIssue(paid.order.id, kopiId);

    const over = await apology(secondIssueId, MID_ROOM + 1);
    expect([409, 422], JSON.stringify(over.body)).toContain(over.status);
    expect(await voucherValues(secondIssueId)).toEqual([]);
    expect(await vouchersOf([firstIssueId, secondIssueId])).toBeLessThanOrEqual(
      KOPI_PAID,
    );
  });

  it("order tanpa promo (kopi dibayar 28.875): 28.876 dan 100.000 ditolak 422, tepat 28.875 lolos", async () => {
    const paid = await paidPlainOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const over = await apology(issueId, PLAIN_KOPI_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    const big = await apology(issueId, 100_000);
    expect(big.status, JSON.stringify(big.body)).toBe(422);
    expect(await voucherValues(issueId)).toEqual([]);

    const exact = await apology(issueId, PLAIN_KOPI_PAID);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await voucherValues(issueId)).toEqual([PLAIN_KOPI_PAID]);
  });

  it("isolasi tenant: order id sama di tenant lain tidak mengubah batas, staf host lain tidak bisa menerbitkan, tenant lain tanpa voucher", async () => {
    const other = await createIsolatedTenant(
      `q25sw-${randomUUID().slice(0, 6)}`,
    );
    const paid = await paidPromoOrder();
    // Another tenant's application for the same order id must neither widen nor
    // narrow our cap, and must stay as it is.
    await asOwnerTenant(other.tenantId, (client) =>
      client.query(
        `INSERT INTO promotion_order_applications
           (tenant_id, outlet_id, order_id, request_fingerprint, channel, subtotal_idr,
            total_discount_idr, paid_idr, refunded_paid_idr, refunded_subtotal_idr, result,
            status)
         VALUES ($1, $2, $3, $4, 'dine_in', 500000, 10000, 490000, 5000, 9000, '{}'::jsonb, 'applied')`,
        [
          other.tenantId,
          other.outletId,
          toUuid(paid.order.id),
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
        ],
      ),
    );
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const foreign = await apology(issueId, 1_000, other.hostname);
    expect(foreign.status, JSON.stringify(foreign.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(foreign.status).toBeLessThan(500);
    expect(await voucherValues(issueId), "foreign host mints nothing").toEqual(
      [],
    );

    const over = await apology(issueId, KOPI_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    const exact = await apology(issueId, KOPI_PAID);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);

    const { rows } = await owner.query<{ vouchers: string; refunds: string }>(
      `SELECT (SELECT count(*) FROM vouchers WHERE tenant_id = $1) AS vouchers,
              (SELECT count(*) FROM payment_refunds WHERE tenant_id = $1) AS refunds`,
      [other.tenantId],
    );
    expect(Number(rows[0]!.vouchers), "other tenant vouchers").toBe(0);
    expect(Number(rows[0]!.refunds), "other tenant refunds").toBe(0);
  });
});

// =====================================================================================
// legend-pqm3t: swap-choice preview uses the paid value; legacy swaps without it
// =====================================================================================

describe("legend-pqm3t: pratinjau pilihan tukar memakai nilai dibayar, bukan harga daftar", () => {
  it("kopi promo dibayar 8.085: air 5.000 dikredit 8.085 (bukan 20.000), menu 20.000 dikredit 5.000", async () => {
    const paid = await paidPromoOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const air = await previewOf(paid.guest, issueId, airItem);
    const mid = await previewOf(paid.guest, issueId, midItem);

    expect(air, "air is offered").toBeDefined();
    expect(mid, "menu 20.000 is offered").toBeDefined();
    // Negative = credited to the guest: cut to the paid value, never the list 20.000.
    expect(air!.differenceIdr).toBe(-KOPI_PAID);
    expect(mid!.differenceIdr).toBe(-MID_VOUCHER);
  });

  it("pratinjau sama dengan voucher yang benar-benar terbit saat tamu menukar ke air", async () => {
    const paid = await paidPromoOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);
    const air = await previewOf(paid.guest, issueId, airItem);
    expect(air, "air is offered").toBeDefined();

    const chosen = await w.as(paid.guest).choose(issueId, {
      choice: "swap",
      replacementItemId: airItem,
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);

    expect(await voucherValues(issueId)).toEqual([-air!.differenceIdr]);
    expect(-air!.differenceIdr).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("rantai: kopi ditukar ke menu 20.000 (voucher 5.000), lini itu gagal: pratinjau air dikredit sisa 3.085, sama dengan voucher yang terbit", async () => {
    const paid = await paidPromoOrder();
    const first = await swapLineTo(paid.line(w.ids.kopi).id, midItem);
    expect(await voucherValues(first.swapIssueId)).toEqual([MID_VOUCHER]);
    const issueId = await reportLine(first.replacementLineId);

    const air = await previewOf(paid.guest, issueId, airItem);
    expect(air, "air is offered").toBeDefined();
    expect(air!.differenceIdr).toBe(-MID_ROOM);

    const chosen = await w.as(paid.guest).choose(issueId, {
      choice: "swap",
      replacementItemId: airItem,
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    expect(await voucherValues(issueId)).toEqual([MID_ROOM]);
    expect(await vouchersOf([first.swapIssueId, issueId])).toBeLessThanOrEqual(
      KOPI_PAID,
    );
  });

  it("order tanpa promo (kopi dibayar 28.875): air dikredit 20.000 seperti harga daftar (regresi)", async () => {
    const paid = await paidPlainOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const air = await previewOf(paid.guest, issueId, airItem);

    expect(air, "air is offered").toBeDefined();
    expect(air!.differenceIdr).toBe(-PLAIN_AIR_CREDIT);
  });

  it("item lebih mahal tetap muncul dengan selisih positif 10.000 yang harus dibayar tamu (bila ditawarkan)", async () => {
    const paid = await paidPromoOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi).id);

    const premium = await previewOf(paid.guest, issueId, premiumItem);

    // Assumption: a dearer item may or may not be offered to the guest; when it is,
    // the difference is the list difference (the guest pays more, no credit cap).
    if (premium !== undefined)
      expect(premium.differenceIdr).toBe(PREMIUM_PRICE - KOPI_PRICE);
  });
});

describe("legend-pqm3t: tukar lama tanpa paid_value_idr (sebelum migrasi 0235)", () => {
  it("kopi ditukar ke air (voucher 8.085), kolom dikosongkan, pengganti gagal: pratinjau voucher 0 dan pilihan voucher ditolak", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, airItem);
    expect(await voucherValues(swap.swapIssueId)).toEqual([KOPI_PAID]);
    await clearPaidValue(swap.swapIssueId);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    // The paid value is computed from the order (8.085 - 8.085 = 0 left), or the
    // choice is refused: either way the guest cannot take a second credit.
    const options = await w.as(paid.guest).issueOptions(replacementIssueId);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.data.voucher).toEqual({ allowed: false, valueIdr: 0 });

    const chosen = await w
      .as(paid.guest)
      .choose(replacementIssueId, { choice: "voucher" });
    expect([409, 422], JSON.stringify(chosen.body)).toContain(chosen.status);
    expect(await voucherValues(replacementIssueId)).toEqual([]);
    expect(
      await vouchersOf([swap.swapIssueId, replacementIssueId]),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("kopi ditukar ke menu 20.000 (voucher 5.000), kolom dikosongkan: voucher tamu untuk lini pengganti <= 3.085 atau ditolak, total <= 8.085", async () => {
    const paid = await paidPromoOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, midItem);
    expect(await voucherValues(swap.swapIssueId)).toEqual([MID_VOUCHER]);
    await clearPaidValue(swap.swapIssueId);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    const options = await w.as(paid.guest).issueOptions(replacementIssueId);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(options.body.data.voucher.valueIdr).toBeLessThanOrEqual(MID_ROOM);

    const chosen = await w
      .as(paid.guest)
      .choose(replacementIssueId, { choice: "voucher" });
    expect([200, 409, 422], JSON.stringify(chosen.body)).toContain(
      chosen.status,
    );
    expect(
      await vouchersOf([swap.swapIssueId, replacementIssueId]),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("kopi ditukar ke menu 20.000, kolom dikosongkan, lalu tukar kedua ke air: voucher kedua <= 3.085 atau ditolak, total <= 8.085", async () => {
    const paid = await paidPromoOrder();
    const first = await swapLineTo(paid.line(w.ids.kopi).id, midItem);
    await clearPaidValue(first.swapIssueId);
    const secondIssueId = await reportLine(first.replacementLineId);

    const swapped = await resolveSwap(secondIssueId, airItem);

    // Computed from the order (3.085 left) or refused/held for approval; never 15.000.
    expect(swapped.status, JSON.stringify(swapped.body)).toBeLessThan(500);
    if (swapped.status === 200) await deliverSwapKitchen(secondIssueId);
    expect(
      await vouchersOf([first.swapIssueId, secondIssueId]),
    ).toBeLessThanOrEqual(KOPI_PAID);
  });

  it("tukar lama tanpa kolom pada order tanpa promo (28.875): pratinjau dan voucher tidak melewati nilai dibayar", async () => {
    const paid = await paidPlainOrder();
    const swap = await swapLineTo(paid.line(w.ids.kopi).id, airItem);
    expect(await voucherValues(swap.swapIssueId)).toEqual([PLAIN_AIR_CREDIT]);
    await clearPaidValue(swap.swapIssueId);
    const replacementIssueId = await reportLine(swap.replacementLineId);

    const chosen = await w
      .as(paid.guest)
      .choose(replacementIssueId, { choice: "voucher" });

    expect([200, 409, 422], JSON.stringify(chosen.body)).toContain(
      chosen.status,
    );
    expect(
      await vouchersOf([swap.swapIssueId, replacementIssueId]),
    ).toBeLessThanOrEqual(PLAIN_KOPI_PAID);
  });
});
