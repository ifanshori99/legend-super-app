// Q25 architect review fixes (docs/briefs/sub-q25-arch-fixes.md, rows 1-5, 7, 8; founder
// rule 11 Nov 2026): ONE source of "already given" per original line and per order.
// Voucher (swap difference + apology), recovery refund and POS refund + paid extra
// charge are counted by every payment path, so no party is paid more than the guest
// paid and the outlet never loses. Written FIRST from the brief table and the shared
// numbers of order-recovery-q25-swap.test.ts and pos-refund-voucher-cap.test.ts; the
// service code was NOT read. Rows 1-5 are the three "rooms" (swap chain, POS order,
// POS line) that each saw only part of what was given.
//
// Numbers (service 5%, PBJT 10%, factor 1,155 as in the other Q25 tests):
// - Promo order kopi + teh + roti: the kopi is paid 8.085 (order total 42.735).
// - Plain order kopi + roti: kopi paid 28.875, roti paid 20.790, order paid 49.665;
//   the swap kopi -> air (Rp5.000) mints the list difference 20.000.
// - Plain item A Rp40.000 alone: paid 46.200; the dearer swap to B (Rp80.000) owes an
//   extra charge of 46.200.
//
// Assumptions where the brief is not exact:
// - A second report on a line that already has a resolved issue is forced by SQL
//   (`forceOpenIssue`, the API would replay the first issue), as the other Q25 tests do.
// - Over the room a refund is CUT to the room (not refused): refund rows are asserted
//   as amounts, and a refusal (409/422, never 5xx) is accepted where the room is 0.
// - Rows 2 and 3 report the issue while the order is still a QR order, then turn it
//   into a completed POS sale (channel 'pos', one captured cash tender), then refund
//   through `refundPosOrder` and resolve the swap afterwards. Where the room is 0 the
//   swap may mint Rp0 (no voucher row) or be refused with a 4xx; both keep the money.
// - Row 2 preview: `options.swap.items[].differenceIdr` of the guest issue list is
//   -credit for a cheaper item (as in the pqm3t cases of the swap test).
// - Row 4: the POS refund of a promo line names the line (`items`) and the amount asked
//   is the line's paid value; the room of the line is 8.085 minus the voucher given.
// - Row 5: the audit row of the POS refund (`pos_order.refunded`) carries
//   `maskedChanges.after.depositOwedIdr`. An apology voucher is NOT owed on the deposit
//   side, so the value must equal the one of an identical deposit order without any
//   voucher (the baseline: bill 49.665 = tender 29.665 + deposit 20.000, owed 20.000).
// - Row 7: "waived" is set by SQL as the staff route does (closeIssueCharge). Re-swapping
//   the replacement line to another item of the SAME list price owes nothing again.
// - Row 8: a dearer swap whose charge event was never delivered has no charge row; it
//   counts as waived: the replacement line can be swapped to a cheaper item, and the
//   vouchers stay within what the guest paid (46.200). The exact credit is not pinned
//   (waived list base would give 20.000); only 0 < voucher <= 46.200 is asserted.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderRecoveryRefundEvent } from "../services/order-recovery-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { agent, signUp } from "./helpers.ts";
import {
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

// Each case builds a paid order through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

let w: World;

const AIR_PRICE = 5_000;
const ITEM_A_PRICE = 40_000;
const ITEM_B_PRICE = 80_000;
const ITEM_C_PRICE = 20_000;
const KOPI_PRICE = 25_000;
const KOPI_PAID_PROMO = 8_085;
const PROMO_TOTAL = 42_735;
const KOPI_PAID = 28_875;
const ORDER_PAID = 49_665;
const SWAP_VOUCHER = 20_000;
const ITEM_A_PAID = 46_200;
const REASON = "Pelanggan menolak ganti menu dan voucher";
const APOLOGY_REASON = "Item gagal, mohon maaf atas ketidaknyamanan";

const airItem = randomUUID();
const itemA = randomUUID();
const itemB = randomUUID();
const itemB2 = randomUUID();
const itemC = randomUUID();
const freeRotiPromotion = randomUUID();

/** The till of the cashier: the POS refund of a cash sale needs an open shift. */
const TILL_DEVICE = randomUUID();
let cashierId = "";

beforeAll(async () => {
  w = await createWorld();
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId && deviceId === TILL_DEVICE
      ? w.tenant.outletId
      : null,
  );
  // Auto promotion (no code): buy 2 of {kopi, teh}, get 1 roti free.
  await owner.query(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
        conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
        budget_idr)
     VALUES ($1, $2, 'Beli 2 minuman gratis roti', '', 'active', NULL, false,
             now() - interval '1 hour', NULL, $3, $4, 'g_q25given', true, 0, NULL, NULL, NULL)`,
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
    [airItem, "Air Mineral Given", AIR_PRICE],
    [itemA, "Menu A Given", ITEM_A_PRICE],
    [itemB, "Menu B Given", ITEM_B_PRICE],
    [itemB2, "Menu B2 Given", ITEM_B_PRICE],
    [itemC, "Menu C Given", ITEM_C_PRICE],
  ] as const) {
    await owner.query(
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
    await owner.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), w.tenant.tenantId, w.ids.priceList, id, price],
    );
  }
  // The recovery staff cannot operate a till: the cashier is a separate member.
  const cashierRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Q25 Given', false, NULL, $3, false, '["tenant"]')`,
    [
      cashierRole,
      w.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.refund.request",
        "shift.cash.operate",
      ]),
    ],
  );
  const cashierClient = agent(w.app);
  await signUp(cashierClient, "Kasir Q25 Given");
  const session = await cashierClient.get("/api/auth/get-session");
  cashierId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, cashierId, cashierRole],
  );
  await openPosShift(
    contextOf(w.tenant.tenantId),
    { userId: userIdSchema.parse(cashierId), deviceId: TILL_DEVICE },
    outletIdSchema.parse(w.tenant.outletId),
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
  );
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
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id as never));
const toUlid = (id: string) => (UUID.test(id) ? uuidToUlid(id) : id);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// ---- order setup -----------------------------------------------------------------

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  return eventEnvelopeSchema.parse(rows[0]!.event);
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
  const event = await paidEvent(intentId);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event, event.id, tx),
  );
}

type PaidOrder = {
  guest: Guest;
  orderId: string;
  outletId: string;
  total: number;
  line: (menuItemId: string) => string;
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
  const order = placed.body.data.order as {
    id: string;
    items: { id: string; menuItemId: string }[];
  };
  const { rows } = await owner.query<{ outlet_id: string; total_idr: number }>(
    "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(order.id)],
  );
  const total = rows[0]!.total_idr;
  const payment = await w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, total)).toBe(true);
  return {
    guest,
    orderId: order.id,
    outletId: rows[0]!.outlet_id,
    total,
    line: (menuItemId) =>
      order.items.find((item) => item.menuItemId === menuItemId)!.id,
  };
}

/** Promo order kopi + teh + roti: the kopi is paid 8.085. */
async function paidPromoOrder() {
  const paid = await paidOrderOf([w.ids.kopi, w.ids.teh, w.ids.roti]);
  expect(paid.total, "promo order total").toBe(PROMO_TOTAL);
  return paid;
}

/** Plain order kopi + roti (no promo): kopi paid 28.875, roti 20.790. */
async function paidPlainOrder() {
  const paid = await paidOrderOf([w.ids.kopi, w.ids.roti]);
  expect(paid.total, "plain order total").toBe(ORDER_PAID);
  return paid;
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

/** Delivers the swap kitchen event of a resolved swap (writes the replacement line, mints the credit). */
async function deliverSwapKitchen(issueId: string) {
  const event = await resolvedEvent(issueId);
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, event, tx),
  );
  return event;
}

async function deliverCharge(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverIssueChargeEvent(context, event, tx),
  );
}

async function replacementLineOf(issueId: string) {
  const { rows } = await owner.query<{ id: string | null }>(
    "SELECT replacement_order_item_id AS id FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows[0]!.id, "replacement line written").not.toBeNull();
  return uuidToUlid(rows[0]!.id!);
}

/**
 * Resolves an open swap issue. A refusal is a 4xx (never 5xx): the credit is then 0.
 * When resolved, the kitchen event is delivered, which writes the credit voucher.
 */
async function trySwap(
  issueId: string,
  replacementItemId: string,
  options: { acceptRefusal: boolean },
) {
  const swapped = await resolveSwap(issueId, replacementItemId);
  if (options.acceptRefusal && swapped.status !== 200) {
    expect(swapped.status, JSON.stringify(swapped.body)).toBeLessThan(500);
    expect(swapped.status, JSON.stringify(swapped.body)).toBeGreaterThanOrEqual(
      400,
    );
    return { resolved: false as const, voucherIdr: 0 };
  }
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  await deliverSwapKitchen(issueId);
  return { resolved: true as const, voucherIdr: await vouchersOf([issueId]) };
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
 * difference). The kitchen event writes the replacement line. The charge event opens
 * the extra charge only when `openCharge` (row 8 leaves it undelivered: no charge row).
 */
async function swapLineDearer(
  lineId: string,
  replacementItemId: string,
  differenceIdr: number,
  options: { openCharge: boolean },
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
  if (options.openCharge) await deliverCharge(event);
  return {
    swapIssueId,
    replacementLineId: await replacementLineOf(swapIssueId),
  };
}

async function chargesOf(issueId: string) {
  const { rows } = await owner.query<{ id: string; status: string }>(
    `SELECT id, status FROM order_issue_charges
      WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

/** As the staff route does (closeIssueCharge): waived with reason and actor. */
async function waiveCharges(issueId: string) {
  await owner.query(
    `UPDATE order_issue_charges
        SET status = 'waived', closed_at = now(), closed_by = $3,
            close_reason = 'Tamu komplain lama menunggu'
      WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId, w.supervisor.userId],
  );
}

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

/** Live recovery refunds: a refund that failed or was rejected is not live. */
async function recoveryRefundTotal(issueIds: string[]) {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(sum(amount_idr), 0)::text AS total FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = ANY($2::uuid[])
        AND status NOT IN ('failed', 'rejected')`,
    [w.tenant.tenantId, issueIds.map(toUuid)],
  );
  return Number(rows[0]!.total);
}

/**
 * Resolves an open issue `manual_refund` with an approved approval. Returns the
 * `order_issue.manual_refund_approved` event, or null when the API refused (a 4xx; never 5xx).
 */
async function resolveManualRefund(issueId: string, approvedIdr: number) {
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: approvedIdr,
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
  expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(500);
  if (resolved.status !== 200) return null;
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.event;
}

/** The refund consumer files the refund of an approved manual refund (as the worker does). */
async function fileManualRefund(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
}

/** Resolves and files a manual refund; a refusal would make the case vacuous, so it fails. */
async function manualRefund(issueId: string, approvedIdr: number) {
  const event = await resolveManualRefund(issueId, approvedIdr);
  expect(event, "manual refund approved").not.toBeNull();
  await fileManualRefund(event!);
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

/** Staff apology voucher tied to an issue (POST /api/apology-vouchers); resolves the issue. */
async function apologyVoucherFor(issueId: string, valueIdr: number) {
  const issued = await w.staffPost(w.supervisor, "/api/apology-vouchers", {
    valueIdr,
    reason: APOLOGY_REASON,
    orderIssueId: issueId,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  expect(await voucherValues(issueId), "apology voucher").toEqual([valueIdr]);
}

/** Reports `lineId` and gives it an apology voucher of `valueIdr`. Returns the issue. */
async function apologyOnLine(lineId: string, valueIdr: number) {
  const issueId = await reportLine(lineId);
  await apologyVoucherFor(issueId, valueIdr);
  return issueId;
}

// ---- POS side ---------------------------------------------------------------------------

/** The paid QR order becomes a completed POS sale paid in cash (setup, written directly). */
async function becomePosSale(paid: PaidOrder, tenderIdr = paid.total) {
  const uuid = toUuid(paid.orderId);
  await owner.query(
    "UPDATE orders SET channel = 'pos', status = 'completed' WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, uuid],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
     VALUES ($1, $2, $3, 'pos', now())`,
    [uuid, w.tenant.tenantId, paid.outletId],
  );
  // Rp0 tender: a sale that was paid only from the deposit (no tender row).
  if (tenderIdr > 0)
    await owner.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
          amount_idr, received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured',
               now() - interval '1 minute', now())`,
      [w.tenant.tenantId, paid.outletId, uuid, tenderIdr],
    );
}

type RefundInput = Parameters<typeof refundPosOrder>[4];

/** A POS refund input with an approved supervisor-PIN override. */
async function refundInput(
  orderId: string,
  amountIdr: number,
  items?: { itemId: string; quantity: number }[],
) {
  const overrideId = toUlid(randomUUID());
  await owner.query(
    `INSERT INTO pos_overrides
       (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
        reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
     VALUES ($1, $2, $3, 'refund', 'supervisor_pin', 'approved', $4, $5,
             'Pelanggan salah pesan', $6, 'order', $7, $8, now(), now())`,
    [
      ulidToUuid(overrideId as never),
      w.tenant.tenantId,
      w.tenant.outletId,
      cashierId,
      w.supervisor.userId,
      amountIdr,
      toUlid(orderId),
      // The POS order consumer re-derives the fingerprint from the stored row
      // (legend-fjwxo), so a raw fixture row needs a real one.
      pinOverrideFixtureFingerprint({
        requestedBy: cashierId,
        outletId: w.tenant.outletId,
        action: "refund",
        valueIdr: amountIdr,
        reason: "Pelanggan salah pesan",
        objectType: "order",
        objectId: toUlid(orderId),
        approverUserId: w.supervisor.userId,
      }),
    ],
  );
  return {
    reason: "quality_complaint",
    reasonNote: "Refund POS uji ruang diberikan",
    amountIdr,
    ...(items ? { items } : {}),
    idempotencyKey: randomUUID(),
    approvedBy: w.supervisor.userId,
    overrideId,
  } as unknown as RefundInput;
}

/** Calls `refundPosOrder`; a refusal is returned, not thrown, so cases can pin the money only. */
async function posRefund(
  orderId: string,
  amountIdr: number,
  items?: { itemId: string; quantity: number }[],
) {
  const input = await refundInput(orderId, amountIdr, items);
  try {
    const result = await refundPosOrder(
      contextOf(w.tenant.tenantId),
      {
        userId: userIdSchema.parse(cashierId),
        deviceId: TILL_DEVICE,
        expectedVersion: null,
      },
      outletIdSchema.parse(w.tenant.outletId),
      toUlid(orderId) as never,
      input,
    );
    return { ok: true as const, result };
  } catch (error) {
    return { ok: false as const, error };
  }
}

async function posRefundRows(orderId: string) {
  const { rows } = await owner.query<{ amount_idr: string }>(
    `SELECT amount_idr FROM pos_order_refunds
      WHERE tenant_id = $1 AND order_id = $2 ORDER BY refunded_at, id`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows.map((row) => Number(row.amount_idr));
}

/** Money rule of the founder, per order: voucher + recovery refund + POS refund <= paid. */
async function expectOrderWithinPaid(
  orderId: string,
  issueIds: string[],
  paidIdr: number,
) {
  const total =
    (await vouchersOf(issueIds)) +
    (await recoveryRefundTotal(issueIds)) +
    sum(await posRefundRows(orderId));
  expect(total, "voucher + recovery refund + POS refund").toBeLessThanOrEqual(
    paidIdr,
  );
}

type GuestIssueView = {
  id: string;
  options: {
    swap: { items: { menuItemId: string; differenceIdr: number }[] };
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
// Row 1 (HIGH): a line without a swap: voucher, then a manual refund of the same line
// =====================================================================================

/**
 * The apology voucher of an issue exists but the issue is open again. Over the API a line
 * settled by a voucher refuses every other resolution (409), so the state "voucher given,
 * refund still to be filed" is reached the way a race or a partial failure leaves it: the
 * voucher is issued, then the issue row is put back to open by SQL.
 */
async function reopenIssue(issueId: string) {
  await owner.query(
    `UPDATE order_issues SET status = 'open', resolution = NULL, resolved_at = NULL
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, issueId],
  );
}

describe("Q25 given 1: voucher lalu refund manual pada baris yang sama (tanpa tukar)", () => {
  it("baris promo dibayar 8.085: voucher maaf 8.085 sudah terbit, refund manual baris sama dipotong ke sisa 0 (bukan 8.085 lagi)", async () => {
    const paid = await paidPromoOrder();
    const kopi = paid.line(w.ids.kopi);
    const issueA = await apologyOnLine(kopi, KOPI_PAID_PROMO);
    await reopenIssue(issueA);
    const issueB = await forceOpenIssue(paid.orderId, kopi);

    await manualRefund(issueB, KOPI_PRICE);

    expect(await recoveryRefundTotal([issueA, issueB]), "refund").toBe(0);
    expect(await vouchersOf([issueA, issueB])).toBe(KOPI_PAID_PROMO);
    await expectOrderWithinPaid(paid.orderId, [issueA, issueB], PROMO_TOTAL);
  });

  it("order tanpa promo, kopi dibayar 28.875: voucher maaf 20.000, refund manual baris sama = 8.875 (sisa baris), bukan 28.875", async () => {
    const paid = await paidPlainOrder();
    const kopi = paid.line(w.ids.kopi);
    const issueA = await apologyOnLine(kopi, SWAP_VOUCHER);
    await reopenIssue(issueA);
    const issueB = await forceOpenIssue(paid.orderId, kopi);

    await manualRefund(issueB, KOPI_PRICE);

    expect(await recoveryRefundTotal([issueB])).toBe(KOPI_PAID - SWAP_VOUCHER);
    expect(
      (await vouchersOf([issueA, issueB])) +
        (await recoveryRefundTotal([issueA, issueB])),
    ).toBeLessThanOrEqual(KOPI_PAID);
    await expectOrderWithinPaid(paid.orderId, [issueA, issueB], ORDER_PAID);
  });
});

// =====================================================================================
// Row 2 (HIGH): POS refund first, then a swap credit: the credit is cut to the order room
// =====================================================================================

describe("Q25 given 2: refund POS dulu, lalu voucher tukar dipotong ke ruang order", () => {
  it("refund POS penuh 49.665 lalu tukar kopi -> air: tidak ada voucher (ruang order 0)", async () => {
    const paid = await paidPlainOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi));
    await becomePosSale(paid);
    const refund = await posRefund(paid.orderId, ORDER_PAID);
    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([ORDER_PAID]);

    const swap = await trySwap(issueId, airItem, { acceptRefusal: true });

    expect(swap.voucherIdr, "credit above the order room").toBe(0);
    await expectOrderWithinPaid(paid.orderId, [issueId], ORDER_PAID);
  });

  it("refund POS 40.000 lalu tukar kopi -> air: voucher = ruang order 9.665, bukan selisih daftar 20.000", async () => {
    const paid = await paidPlainOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi));
    await becomePosSale(paid);
    const refund = await posRefund(paid.orderId, 40_000);
    expect(refund.ok, JSON.stringify(refund)).toBe(true);

    const swap = await trySwap(issueId, airItem, { acceptRefusal: false });

    expect(swap.voucherIdr).toBe(ORDER_PAID - 40_000);
    await expectOrderWithinPaid(paid.orderId, [issueId], ORDER_PAID);
  });

  it("pratinjau tamu memakai ruang yang sama: refund POS 40.000, air dikredit 9.665 (bukan 20.000)", async () => {
    const paid = await paidPlainOrder();
    const issueId = await reportLine(paid.line(w.ids.kopi));
    await becomePosSale(paid);
    const refund = await posRefund(paid.orderId, 40_000);
    expect(refund.ok, JSON.stringify(refund)).toBe(true);

    const preview = await previewOf(paid.guest, issueId, airItem);

    expect(preview, "air listed as a swap choice").toBeDefined();
    // Negative difference = credited to the guest.
    expect(preview!.differenceIdr).toBe(-(ORDER_PAID - 40_000));
  });
});

// =====================================================================================
// Row 3 (HIGH): a POS refund naming the line lowers the voucher room of that line
// =====================================================================================

describe("Q25 given 3: refund POS yang menyebut baris mengurangi ruang voucher baris itu", () => {
  it("refund POS baris kopi 18.875 lalu tukar kopi -> air: voucher = sisa baris 10.000, bukan 20.000", async () => {
    const paid = await paidPlainOrder();
    const kopi = paid.line(w.ids.kopi);
    const issueId = await reportLine(kopi);
    await becomePosSale(paid);
    const refund = await posRefund(paid.orderId, 18_875, [
      { itemId: kopi, quantity: 1 },
    ]);
    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([18_875]);

    const swap = await trySwap(issueId, airItem, { acceptRefusal: false });

    // Order room (30.790) is bigger than the line room (28.875 - 18.875 = 10.000).
    expect(swap.voucherIdr).toBe(KOPI_PAID - 18_875);
    await expectOrderWithinPaid(paid.orderId, [issueId], ORDER_PAID);
  });

  it("refund POS baris kopi penuh 28.875 lalu tukar kopi -> air: tidak ada voucher (sisa baris 0)", async () => {
    const paid = await paidPlainOrder();
    const kopi = paid.line(w.ids.kopi);
    const issueId = await reportLine(kopi);
    await becomePosSale(paid);
    const refund = await posRefund(paid.orderId, KOPI_PAID, [
      { itemId: kopi, quantity: 1 },
    ]);
    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([KOPI_PAID]);

    const swap = await trySwap(issueId, airItem, { acceptRefusal: true });

    expect(swap.voucherIdr).toBe(0);
    await expectOrderWithinPaid(paid.orderId, [issueId], ORDER_PAID);
  });
});

// =====================================================================================
// Row 4 (HIGH): the POS line cap also holds in a promo order
// =====================================================================================

describe("Q25 given 4: baris POS di order promo dijepit ke dibayar baris - voucher", () => {
  it("voucher maaf kopi 8.085 lalu refund POS baris kopi: tidak ada pembayaran lagi", async () => {
    const paid = await paidPromoOrder();
    const kopi = paid.line(w.ids.kopi);
    const issueId = await apologyOnLine(kopi, KOPI_PAID_PROMO);
    await becomePosSale(paid);

    // Refused (nothing due) or a Rp0 goods return: either way no money is paid.
    await posRefund(paid.orderId, KOPI_PAID_PROMO, [
      { itemId: kopi, quantity: 1 },
    ]);

    expect(sum(await posRefundRows(paid.orderId))).toBe(0);
    await expectOrderWithinPaid(paid.orderId, [issueId], PROMO_TOTAL);
  });

  it("voucher maaf kopi 5.000 lalu refund POS baris kopi: dibayar sisa 3.085, bukan 8.085", async () => {
    const paid = await paidPromoOrder();
    const kopi = paid.line(w.ids.kopi);
    const issueId = await apologyOnLine(kopi, 5_000);
    await becomePosSale(paid);

    const refund = await posRefund(paid.orderId, KOPI_PAID_PROMO, [
      { itemId: kopi, quantity: 1 },
    ]);

    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([
      KOPI_PAID_PROMO - 5_000,
    ]);
    await expectOrderWithinPaid(paid.orderId, [issueId], PROMO_TOTAL);
  });
});

// =====================================================================================
// Row 5 (MED): the deposit still owed does not include the part already given as voucher
// =====================================================================================

describe("Q25 given 5: depositOwedIdr tidak memasukkan bagian yang sudah jadi voucher", () => {
  const DEPOSIT = 20_000;
  const TENDER = PROMO_TOTAL - DEPOSIT;
  const VOUCHER = 5_000;

  /** A promo deposit POS sale (bill 42.735 = tender 22.735 + deposit 20.000), all lines returned. */
  async function depositRefund(voucherIdr: number) {
    const paid = await paidPromoOrder();
    const issues: string[] = [];
    if (voucherIdr > 0) {
      issues.push(await apologyOnLine(paid.line(w.ids.kopi), voucherIdr));
    }
    await becomePosSale(paid, TENDER);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE orders SET deposit_applied_idr = $3 WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, toUuid(paid.orderId), DEPOSIT],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // All lines are returned (bill 42.735) but the money asked is what the tender holds.
    const refund = await posRefund(paid.orderId, TENDER, [
      { itemId: paid.line(w.ids.kopi), quantity: 1 },
      { itemId: paid.line(w.ids.teh), quantity: 1 },
      { itemId: paid.line(w.ids.roti), quantity: 1 },
    ]);
    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    const audit = await owner.query<{ event: unknown }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'pos_order.refunded'`,
      [w.tenant.tenantId],
    );
    const afters = audit.rows
      .filter((row) => JSON.stringify(row.event).includes(toUlid(paid.orderId)))
      .map(
        (row) =>
          (
            row.event as {
              maskedChanges: { after: Record<string, unknown> };
            }
          ).maskedChanges.after,
      );
    expect(afters, JSON.stringify(afters)).toHaveLength(1);
    return {
      paid,
      issues,
      depositOwedIdr: afters[0]!.depositOwedIdr as number | undefined,
      payouts: await posRefundRows(paid.orderId),
    };
  }

  it("voucher 5.000 pada order promo deposit: refund POS dipotong ke 17.735, depositOwedIdr sama dengan order identik tanpa voucher", async () => {
    const baseline = await depositRefund(0);
    expect(baseline.payouts).toEqual([TENDER]);
    expect(baseline.depositOwedIdr, "deposit still owed, no voucher").toBe(
      DEPOSIT,
    );

    const withVoucher = await depositRefund(VOUCHER);

    expect(withVoucher.payouts).toEqual([TENDER - VOUCHER]);
    // A voucher is not money owed on the deposit side.
    expect(withVoucher.depositOwedIdr).toBe(baseline.depositOwedIdr);
    await expectOrderWithinPaid(
      withVoucher.paid.orderId,
      withVoucher.issues,
      TENDER,
    );
  });
});

// =====================================================================================
// Row 7 (LOW): a waived extra is not billed again by an equal-price re-swap
// =====================================================================================

describe("Q25 given 7: tukar ulang baris dengan extra di-waive ke harga daftar sama", () => {
  it("40rb -> 80rb (tagihan di-waive) -> tukar ke menu 80rb lain: berhasil, tanpa tagihan baru dan tanpa voucher", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA),
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
      { openCharge: true },
    );
    expect(
      await chargesOf(first.swapIssueId),
      "first extra charge",
    ).toHaveLength(1);
    await waiveCharges(first.swapIssueId);
    const secondIssueId = await reportLine(first.replacementLineId);

    const swapped = await resolveSwap(secondIssueId, itemB2);

    // Same list price as the line: nothing to pay again and nothing to credit.
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const event = await deliverSwapKitchen(secondIssueId);
    await deliverCharge(event);
    expect(
      await chargesOf(secondIssueId),
      "the waived extra is not billed again",
    ).toEqual([]);
    expect(await vouchersOf([first.swapIssueId, secondIssueId])).toBe(0);
  });
});

// =====================================================================================
// Row 8 (LOW): a dearer swap without a charge row does not block swaps forever
// =====================================================================================

describe("Q25 given 8: tukar lebih mahal tanpa baris tagihan diperlakukan sebagai waived", () => {
  it("40rb -> 80rb (event tagihan tidak pernah jalan) -> tukar ulang ke 20rb: berhasil, voucher > 0 dan <= 46.200", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA),
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
      { openCharge: false },
    );
    expect(
      await chargesOf(first.swapIssueId),
      "no charge row was written",
    ).toEqual([]);
    const secondIssueId = await reportLine(first.replacementLineId);

    const swapped = await resolveSwap(secondIssueId, itemC);

    // Not "selesaikan tagihan selisih dulu": there is no open charge to settle.
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    await deliverSwapKitchen(secondIssueId);
    const given = await vouchersOf([first.swapIssueId, secondIssueId]);
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThanOrEqual(ITEM_A_PAID);
  });

  it("setelah tukar ulang itu, refund manual baris pengganti tidak melewati sisa: voucher + refund <= 46.200", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA),
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
      { openCharge: false },
    );
    const second = await swapLineTo(first.replacementLineId, itemC);
    const thirdIssueId = await reportLine(second.replacementLineId);

    await manualRefund(thirdIssueId, ITEM_C_PRICE);

    const issues = [first.swapIssueId, second.swapIssueId, thirdIssueId];
    expect(
      (await vouchersOf(issues)) + (await recoveryRefundTotal(issues)),
    ).toBeLessThanOrEqual(ITEM_A_PAID);
  });
});

// =====================================================================================
// Row 10 (HIGH, ex-4): the due of a POS refund also drops what EARLIER refunds' lines gave
// =====================================================================================

describe("Q25 given 10: refund POS kedua tidak membayar ulang voucher baris yang sudah direfund", () => {
  // The roti is paid 20.790 (not free: the promo discount sits on the kopi).
  const ROTI_PAID = 20_790;

  it("voucher kopi 5.000, refund POS kopi (3.085), lalu refund yang hanya menyebut roti: dibayar paling banyak 20.790, teh yang disimpan tidak tersentuh", async () => {
    const paid = await paidPromoOrder();
    const kopi = paid.line(w.ids.kopi);
    const teh = paid.line(w.ids.teh);
    const roti = paid.line(w.ids.roti);
    const issueId = await apologyOnLine(kopi, 5_000);
    await becomePosSale(paid);
    const first = await posRefund(paid.orderId, KOPI_PAID_PROMO, [
      { itemId: kopi, quantity: 1 },
    ]);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([
      KOPI_PAID_PROMO - 5_000,
    ]);

    // Asks more than anything due: the payout is cut to what the roti cost.
    const second = await posRefund(paid.orderId, 30_000, [
      { itemId: roti, quantity: 1 },
    ]);

    expect(second.ok, JSON.stringify(second)).toBe(true);
    const rows = await posRefundRows(paid.orderId);
    expect(rows, "the 5.000 voucher of the kopi is not paid again").toEqual([
      KOPI_PAID_PROMO - 5_000,
      ROTI_PAID,
    ]);
    // Only the kopi and the roti were returned: voucher + refunds <= what they cost.
    expect(
      (await vouchersOf([issueId])) + sum(rows),
      "voucher + POS refunds of the returned lines",
    ).toBeLessThanOrEqual(KOPI_PAID_PROMO + ROTI_PAID);
    const { rows: refundRows } = await owner.query<{ items: unknown }>(
      `SELECT items FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2`,
      [w.tenant.tenantId, toUuid(paid.orderId)],
    );
    expect(
      JSON.stringify(refundRows),
      "the kept tea is not refunded",
    ).not.toContain(toUlid(teh));
    await expectOrderWithinPaid(paid.orderId, [issueId], PROMO_TOTAL);
  });
});

// =====================================================================================
// Row 11 (MED, ex-5): depositOwedIdr is measured on the due AFTER the voucher
// =====================================================================================

describe("Q25 given 11: depositOwedIdr memakai due yang sudah dikurangi voucher", () => {
  it("order promo dibayar penuh dari deposit, voucher kopi 5.000, refund POS kopi: depositOwedIdr = 3.085, bukan 8.085", async () => {
    const paid = await paidPromoOrder();
    const kopi = paid.line(w.ids.kopi);
    await apologyOnLine(kopi, 5_000);
    // No tender at all: the whole bill sits on the deposit (the tender is used up).
    await becomePosSale(paid, 0);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE orders SET deposit_applied_idr = $3 WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, toUuid(paid.orderId), PROMO_TOTAL],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const refund = await posRefund(paid.orderId, KOPI_PAID_PROMO, [
      { itemId: kopi, quantity: 1 },
    ]);

    expect(refund.ok, JSON.stringify(refund)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([0]);
    const audit = await owner.query<{ event: unknown }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'pos_order.refunded'`,
      [w.tenant.tenantId],
    );
    const afters = audit.rows
      .filter((row) => JSON.stringify(row.event).includes(toUlid(paid.orderId)))
      .map(
        (row) =>
          (
            row.event as {
              maskedChanges: { after: Record<string, unknown> };
            }
          ).maskedChanges.after,
      );
    expect(afters, JSON.stringify(afters)).toHaveLength(1);
    // 8.085 (the kopi) less the 5.000 already given as voucher.
    expect(afters[0]!.depositOwedIdr).toBe(KOPI_PAID_PROMO - 5_000);
  });
});

// =====================================================================================
// Row 12 (LOW): a late charge event cannot open a charge for an already re-swapped line
// =====================================================================================

describe("Q25 given 12: event tagihan terlambat setelah tukar ulang", () => {
  it("40rb -> 80rb (event tagihan belum jalan) -> tukar ulang ke 20rb -> event tagihan pertama datang: tidak ada tagihan terbuka", async () => {
    const paid = await paidItemAOrder();
    const first = await swapLineDearer(
      paid.line(itemA),
      itemB,
      ITEM_B_PRICE - ITEM_A_PRICE,
      { openCharge: false },
    );
    const firstEvent = await resolvedEvent(first.swapIssueId);
    expect(await chargesOf(first.swapIssueId)).toEqual([]);
    await swapLineTo(first.replacementLineId, itemC);

    await deliverCharge(firstEvent);

    const open = (await chargesOf(first.swapIssueId)).filter(
      (row) => row.status === "open" || row.status === "routed_pos",
    );
    expect(open, "no open charge for the already swapped line").toEqual([]);
  });
});
