// legend-5g9sn (founder rule Q25, 11 Nov 2026): the POS refund (`refundPosOrder`)
// counts the vouchers and the recovery refunds of the same order. Voucher (swap
// difference + staff apology tied to the order or an issue) + POS refund + recovery
// refund never exceed what the guest paid. Written FIRST: every case that mixes a
// voucher or a recovery refund with a POS refund fails until the cap lands.
// Brief: docs/briefs/sub-rat9r-followups.md (card 2, stream C).
//
// World: the plain QR order of the recovery tests (kopi 25.000 + roti 18.000, no promo,
// 5% service + 10% PBJT, factor 1,155): kopi paid 28.875, roti paid 20.790, order paid
// 49.665. Recovery steps (swap, apology voucher, recovery refund) run first, while the
// order is still a QR order; then the order becomes a completed POS sale (channel
// 'pos', pos_orders row, one captured cash tender of the paid amount) and the cashier
// refunds it with `refundPosOrder` called directly, as pos-refund-gateway-autofile
// does, with a raw approved supervisor-PIN override.
//
// Expected behaviour chosen (the spec text does not pin it):
// - Level: an amount-only refund is order level, so the room is
//   paid(order) - sum(vouchers of the order) - sum(live refunds of the order).
//   A refund that names `items` is line level: the room is that line's paid value
//   minus the vouchers and live refunds of that line. Both are bounded by the
//   order-level room too. (The founder rule says "item/order".)
// - Over the room: the refund is CUT to the room and paid (`min(asked, room)`), as the
//   promo partial refund already does (pos-refund-promo-db.test.ts, "payout =
//   min(amountIdr, due)"), not refused with 422. Cutting keeps the cashier flow
//   working and never pays more than allowed. Room 0: nothing is paid; whether that is
//   a refusal or a zero row is not pinned, so only "no refund row above zero" is
//   asserted.
// - The money invariant is asserted on every case: vouchers + POS refunds + live
//   recovery refunds <= paid.
// - Idempotency: the same refund input (same idempotencyKey and override) sent twice
//   pays once; the second call returns without a second refund row (it may return the
//   stored result or any success; the exact shape is not pinned).
// - Tenant isolation: the refund addressed to our order from another tenant's scope is
//   refused or finds nothing, and writes no row; our own room is untouched.
// - Setup: the cash tender and the status 'completed' are written directly, because the
//   QR order never went through the POS till.

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
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderRecoveryRefundEvent } from "../services/order-recovery-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { agent, signUp } from "./helpers.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

// Each case builds a paid order through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

let w: World;
/** Rp5.000 item in no promotion: a cheaper replacement for the kopi (list difference 20.000). */
const airItem = randomUUID();
const AIR_PRICE = 5_000;
const KOPI_PAID = 28_875;
const ROTI_PAID = 20_790;
/** ORD-09 approval amount is the list price of the line; the refund filed is the paid value. */
const ROTI_PRICE = 18_000;
/** Paid for the whole plain order (kopi + roti, 43.000 goods x 1,155). */
const ORDER_PAID = 49_665;
/** Swap voucher kopi -> air without promo: the list difference, below the paid value. */
const SWAP_VOUCHER = 20_000;
/** The till of the cashier: the POS refund of a cash sale needs an open shift. */
const TILL_DEVICE = randomUUID();
let cashierId = "";
const REASON = "Pelanggan menolak ganti menu dan voucher";

beforeAll(async () => {
  w = await createWorld();
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId && deviceId === TILL_DEVICE
      ? w.tenant.outletId
      : null,
  );
  // The recovery staff cannot operate a till: the cashier is a separate member.
  const cashierRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Batas Voucher', false, NULL, $3, false, '["tenant"]')`,
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
  await signUp(cashierClient, "Kasir Batas Voucher");
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
    {
      userId: userIdSchema.parse(cashierId),
      deviceId: TILL_DEVICE,
    },
    outletIdSchema.parse(w.tenant.outletId),
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
  );
  await owner.query(
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
  await owner.query(
    `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), w.tenant.tenantId, w.ids.priceList, airItem, AIR_PRICE],
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

// ---- Recovery side (QR order, as in order-recovery-swap-voucher-paid-cap) ------------

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
  orderId: string;
  outletId: string;
  kopiLine: string;
  rotiLine: string;
};

/** A PAID plain order (kopi + roti, no promo): paid 49.665. */
async function paidPlainOrder(): Promise<PaidOrder> {
  const guest = await w.seat("pay_first");
  let version = 0;
  for (const menuItemId of [w.ids.kopi, w.ids.roti]) {
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
  expect(rows[0]!.total_idr, "plain order total").toBe(ORDER_PAID);
  const payment = await w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, ORDER_PAID)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;
  return {
    orderId: order.id,
    outletId: rows[0]!.outlet_id,
    kopiLine: line(w.ids.kopi),
    rotiLine: line(w.ids.roti),
  };
}

async function reportLine(lineId: string) {
  const reported = await w.report(lineId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return reported.body.data.id as string;
}

/** Kopi swapped to the air item: the swap voucher (20.000) is minted. Returns the issue. */
async function swapKopiToAir(paid: PaidOrder) {
  const issueId = await reportLine(paid.kopiLine);
  const swapped = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "swap", replacementItemId: airItem },
  );
  expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
  const resolved = await w.outboxRows("order_issue.resolved", issueId);
  expect(resolved).toHaveLength(1);
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverSwapKitchenEvent(context, resolved[0]!.event, tx),
  );
  expect(await voucherValues(issueId), "swap voucher").toEqual([SWAP_VOUCHER]);
  return issueId;
}

/** Staff apology voucher of `valueIdr` tied to a fresh issue of `lineId`. */
async function apologyVoucherFor(lineId: string, valueIdr: number) {
  const issueId = await reportLine(lineId);
  const issued = await w.staffPost(w.supervisor, "/api/apology-vouchers", {
    valueIdr,
    reason: "Item gagal, mohon maaf",
    orderIssueId: issueId,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    { resolution: "voucher", voucherId: issued.body.data.id as string },
  );
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  expect(await voucherValues(issueId), "apology voucher").toEqual([valueIdr]);
  return issueId;
}

/** A recovery refund (ORD-09) of `amountIdr` for `lineId`, filed and live. Returns the issue. */
async function recoveryRefundFor(
  lineId: string,
  approvedIdr: number,
  amountIdr: number,
) {
  const issueId = await reportLine(lineId);
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
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows).toHaveLength(1);
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, rows[0]!.event, tx),
  );
  expect(await recoveryRefundTotal([issueId]), "recovery refund filed").toBe(
    amountIdr,
  );
  return issueId;
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

async function voucherTotal(issueIds: string[]) {
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

// ---- POS side ---------------------------------------------------------------------------

/** The paid QR order becomes a completed POS sale paid in cash (setup, written directly). */
async function becomePosSale(paid: PaidOrder, paidIdr = ORDER_PAID) {
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
  await owner.query(
    `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
        amount_idr, received_idr, change_idr, status, requested_at, resolved_at)
     VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured',
             now() - interval '1 minute', now())`,
    [w.tenant.tenantId, paid.outletId, uuid, paidIdr],
  );
}

type RefundInput = Parameters<typeof refundPosOrder>[4];

/** A POS refund input with an approved supervisor-PIN override; reuse one to replay. */
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
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
    ],
  );
  return {
    reason: "quality_complaint",
    reasonNote: "Refund POS uji batas voucher",
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
  input: RefundInput,
  tenantId = w.tenant.tenantId,
) {
  try {
    const result = await refundPosOrder(
      contextOf(tenantId),
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

/** The money rule of the founder: nobody is paid more than the guest paid. */
async function expectWithinPaid(
  orderId: string,
  issueIds: string[],
  paidIdr = ORDER_PAID,
) {
  const total =
    (await voucherTotal(issueIds)) +
    (await recoveryRefundTotal(issueIds)) +
    sum(await posRefundRows(orderId));
  expect(total, "voucher + recovery refund + POS refund").toBeLessThanOrEqual(
    paidIdr,
  );
}

describe("legend-5g9sn 1: voucher tukar lalu refund POS: voucher + refund <= dibayar", () => {
  it("voucher tukar 20.000, refund POS seluruh order (49.665): refund dipotong jadi 29.665", async () => {
    const paid = await paidPlainOrder();
    const swapIssue = await swapKopiToAir(paid);
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - SWAP_VOUCHER,
    ]);
    await expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("voucher tukar 20.000, refund POS sebagian 10.000 (di bawah sisa): dibayar penuh 10.000", async () => {
    const paid = await paidPlainOrder();
    const swapIssue = await swapKopiToAir(paid);
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, 10_000),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([10_000]);
    await expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("dua refund POS berurutan 20.000 lalu 20.000: yang kedua dipotong ke sisa 9.665", async () => {
    const paid = await paidPlainOrder();
    const swapIssue = await swapKopiToAir(paid);
    await becomePosSale(paid);

    const first = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, 20_000),
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const second = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, 20_000),
    );
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([
      20_000,
      ORDER_PAID - SWAP_VOUCHER - 20_000,
    ]);
    await expectWithinPaid(paid.orderId, [swapIssue]);
  });
});

describe("legend-5g9sn 2: voucher maaf staf lalu refund POS penuh: dipotong", () => {
  it("voucher maaf 20.000 untuk kopi, refund POS seluruh order: refund 29.665", async () => {
    const paid = await paidPlainOrder();
    const apology = await apologyVoucherFor(paid.kopiLine, 20_000);
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([ORDER_PAID - 20_000]);
    await expectWithinPaid(paid.orderId, [apology]);
  });

  it("voucher maaf menghabiskan seluruh dibayar (kopi 28.875 + roti 20.790): refund POS tidak membayar apa pun", async () => {
    const paid = await paidPlainOrder();
    const issues = [
      await apologyVoucherFor(paid.kopiLine, KOPI_PAID),
      await apologyVoucherFor(paid.rotiLine, ROTI_PAID),
    ];
    expect(await voucherTotal(issues)).toBe(ORDER_PAID);
    await becomePosSale(paid);

    // Refused or zero: either way no refund row above zero.
    await posRefund(paid.orderId, await refundInput(paid.orderId, ORDER_PAID));
    expect(sum(await posRefundRows(paid.orderId))).toBe(0);
    await expectWithinPaid(paid.orderId, issues);
  });

  it("refund POS satu baris (kopi) setelah voucher maaf 20.000 untuk kopi: refund <= 8.875 (28.875 - 20.000)", async () => {
    const paid = await paidPlainOrder();
    const apology = await apologyVoucherFor(paid.kopiLine, 20_000);
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, KOPI_PAID, [
        { itemId: paid.kopiLine, quantity: 1 },
      ]),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([KOPI_PAID - 20_000]);
    await expectWithinPaid(paid.orderId, [apology]);
  });
});

describe("legend-5g9sn 3: refund recovery sudah dibuat lalu refund POS: tidak dobel", () => {
  it("refund recovery roti 20.790, refund POS seluruh order: refund POS 28.875 (49.665 - 20.790)", async () => {
    const paid = await paidPlainOrder();
    const recovery = await recoveryRefundFor(
      paid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    );
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([ORDER_PAID - ROTI_PAID]);
    expect(await recoveryRefundTotal([recovery])).toBe(ROTI_PAID);
    await expectWithinPaid(paid.orderId, [recovery]);
  });

  it("refund recovery roti 20.790 + voucher maaf 20.000 (kopi), refund POS seluruh order: refund POS 8.875", async () => {
    const paid = await paidPlainOrder();
    const recovery = await recoveryRefundFor(
      paid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    );
    const apology = await apologyVoucherFor(paid.kopiLine, 20_000);
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - ROTI_PAID - 20_000,
    ]);
    await expectWithinPaid(paid.orderId, [recovery, apology]);
  });
});

describe("legend-5g9sn 4: tanpa voucher refund POS tidak berubah (regresi)", () => {
  it("refund POS seluruh order tanpa voucher: dibayar penuh 49.665", async () => {
    const paid = await paidPlainOrder();
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([ORDER_PAID]);
  });

  it("refund POS sebagian 10.000 tanpa voucher: dibayar 10.000", async () => {
    const paid = await paidPlainOrder();
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, 10_000),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([10_000]);
  });

  it("voucher maaf pada order LAIN tidak mengurangi sisa order ini", async () => {
    const other = await paidPlainOrder();
    await apologyVoucherFor(other.kopiLine, 20_000);
    const paid = await paidPlainOrder();
    await becomePosSale(paid);

    const outcome = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([ORDER_PAID]);
  });
});

describe("legend-5g9sn 5: isolasi tenant", () => {
  it("refund POS dari tenant lain atas order kita: ditolak atau tidak ketemu, tidak ada baris refund, sisa kita utuh", async () => {
    const paid = await paidPlainOrder();
    const swapIssue = await swapKopiToAir(paid);
    await becomePosSale(paid);
    const other = await createIsolatedTenant(`pvc-${randomUUID().slice(0, 6)}`);

    const input = await refundInput(paid.orderId, 10_000);
    const foreign = await posRefund(paid.orderId, input, other.tenantId);
    expect(foreign.ok, "another tenant cannot refund our order").toBe(false);
    expect(await posRefundRows(paid.orderId)).toEqual([]);

    // Our own tenant is not affected by the attempt: the cap still holds exactly.
    const own = await posRefund(
      paid.orderId,
      await refundInput(paid.orderId, ORDER_PAID),
    );
    expect(own.ok, JSON.stringify(own)).toBe(true);
    expect(await posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - SWAP_VOUCHER,
    ]);
    await expectWithinPaid(paid.orderId, [swapIssue]);
  });
});

describe("legend-5g9sn 6: ulang permintaan yang sama (idempoten)", () => {
  it("refund POS yang sama dikirim dua kali: dibayar sekali, voucher + refund <= dibayar", async () => {
    const paid = await paidPlainOrder();
    const swapIssue = await swapKopiToAir(paid);
    await becomePosSale(paid);

    const input = await refundInput(paid.orderId, ORDER_PAID);
    const first = await posRefund(paid.orderId, input);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const retry = await posRefund(paid.orderId, input);
    expect(retry.ok, JSON.stringify(retry)).toBe(true);

    expect(await posRefundRows(paid.orderId)).toEqual([
      ORDER_PAID - SWAP_VOUCHER,
    ]);
    await expectWithinPaid(paid.orderId, [swapIssue]);
  });

  it("dua pengiriman bersamaan dengan kunci yang sama: satu baris refund", async () => {
    const paid = await paidPlainOrder();
    const swapIssue = await swapKopiToAir(paid);
    await becomePosSale(paid);

    const input = await refundInput(paid.orderId, ORDER_PAID);
    await Promise.all([
      posRefund(paid.orderId, input),
      posRefund(paid.orderId, input),
    ]);
    expect(sum(await posRefundRows(paid.orderId))).toBe(
      ORDER_PAID - SWAP_VOUCHER,
    );
    await expectWithinPaid(paid.orderId, [swapIssue]);
  });
});
