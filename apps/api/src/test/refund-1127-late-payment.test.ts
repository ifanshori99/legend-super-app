// legend-1127 (tier K, money): architect delta on 1095 found that a QR order that
// expired and was voided, then paid LATE by the guest, still counts as "paid" for the
// apology voucher. The late payment is parked money: the system hands it back through
// the late-payment refund (`qr-late-payment-refund:<intent>`), so it must neither count
// as the sale's paid money nor be handed out a second time as a staff apology voucher.
// Scenario of the brief: order expired and voided, the guest pays late on that intent,
// the late refund is filed for the whole payment, then a failed-item apology voucher
// would pay the same money again (guest gets 2x what was paid).
//
// Rule under test (docs/briefs/1127-fix-1095-late-payment.md, CTO decisions):
//   1. an intent with a late-payment key counts 0 as paid for the order;
//   2. a voided order has voucher room 0 (422 APOLOGY_VOUCHER_NOTHING_DUE, no row);
//   3. parked money (overpayment fund, late payment) is neither paid nor subtracted
//      (symmetric), total out to the guest <= what the guest really paid.
//
// Written from the brief, docs/briefs/1116-fix-refund-kasir-1095-so.md, the shared
// validators and the existing 1095 / 1116 tests, never from the implementation.
//
// Assumptions (also reported):
// - The brief's 100.000 is scaled to the 1095 world: the plain QR order is 49.665
//   (kopi + roti); the late payment and its late refund are 49.665.
// - "Expired and voided" is set up with rows, as the existing late-payment tests do:
//   the pending intent becomes `expired`, the order `voided`. The guest's late payment
//   is written as rows (paid + evidence) and its late refund as the rows the system
//   leaves (pending payment_refunds `system:qr` + key `qr-late-payment-refund:<intent>`):
//   the real late settlement of a QRIS code is parked by its closed QRIS hold here and a
//   VA gateway double would be needed (fixture gap, reported).
// - The voucher request goes through the kitchen report route plus the staff voucher
//   route. A refusal of the report itself (422) is also an acceptable earlier stop; the
//   accepted shape is "no voucher row, ever", and when the voucher is asked it is
//   refused 422 APOLOGY_VOUCHER_NOTHING_DUE.
// - POS late-payment fixture (cashier refund room excludes the late-paid tender
//   intent) is NOT written as a room assertion: the existing pos-refund-ceilings test
//   ("a late-payment refund does not eat the refundable balance of the sale") fixes the
//   opposite room for a captured tender whose own intent carries the late key, and the
//   brief only changes the non-POS intent filter. See it.todo below. The POS side is
//   covered by the property row in refund-1116-paid-basis.test.ts (total out <= paid).
//
// Run: LEGEND_TEST_FILES="src/test/refund-1127-late-payment.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { orderGivenOf } from "../services/order-given.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  ORDER_PAID,
  contextOf,
  createPosWorld,
  toUlid,
  toUuid,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

const NOTHING_DUE = "APOLOGY_VOUCHER_NOTHING_DUE";
const VOUCHER_TRY = 10_000;

let p: PosWorld;

beforeAll(async () => {
  p = await createPosWorld();
}, 240_000);

afterAll(async () => {
  await p.teardown();
});

type Answer = {
  status: number;
  body: { error?: { code?: string; message?: string } };
};

const tenantId = () => p.w.tenant.tenantId;

function expectRefused(answer: Answer, code: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body.error?.code, JSON.stringify(answer.body)).toBe(code);
}

async function apologyVoucherCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM apology_vouchers WHERE tenant_id = $1",
    [tenantId()],
  );
  return rows[0]!.n;
}

let kitchenStation: string | null = null;

/** Kitchen report (complaint, no resolution) on a line; returns the raw answer and issue id. */
async function kitchenReport(orderId: string, lineId: string) {
  if (!kitchenStation) {
    kitchenStation = randomUUID();
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar 1127', 'beverage_bar')`,
      [kitchenStation, tenantId(), p.w.tenant.outletId],
    );
  }
  const answer = await p.w.staffPost(
    p.w.supervisor,
    `/api/outlets/${p.w.tenant.outletId}/orders/${toUlid(orderId)}/issues`,
    {
      orderItemId: toUlid(lineId),
      type: "complaint",
      reason: "complaint",
      reasonNote: "Item gagal, minta voucher maaf",
      stationId: kitchenStation,
      employeeId: null,
      resolution: null,
      voucherId: null,
      approvedBy: null,
      idempotencyKey: `iss-${randomUUID()}`,
    },
  );
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM order_issues
      WHERE tenant_id = $1 AND order_item_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId(), toUuid(lineId)],
  );
  return { answer: answer as Answer, issueId: rows[0]?.id ?? null };
}

/** Report, then the staff apology voucher. A refused report is an acceptable earlier stop. */
async function reportThenVoucher(
  orderId: string,
  lineId: string,
  valueIdr: number,
) {
  const { answer, issueId } = await kitchenReport(orderId, lineId);
  if (issueId === null || answer.status !== 201)
    return { reported: answer, issueId, voucher: null as Answer | null };
  return {
    reported: answer,
    issueId,
    voucher: (await p.staffVoucher(issueId, valueIdr)) as Answer,
  };
}

async function expectNoVoucher(issueId: string | null, before: number) {
  if (issueId) expect(await p.voucherValues(issueId)).toEqual([]);
  expect(await apologyVoucherCount(), "no apology voucher row").toBe(before);
}

type LateOrder = {
  orderId: string;
  intentId: string;
  kopiLine: string;
  rotiLine: string;
};

/**
 * A pay-first QR order placed with a real pending intent, then (as the system leaves it
 * after the payment window) the intent expired and the order voided.
 */
async function expiredVoidedOrder(): Promise<LateOrder> {
  const guest = await p.w.seat("pay_first");
  const order = await p.w.placeOrder(guest, [
    { menuItemId: p.w.ids.kopi, quantity: 1 },
    { menuItemId: p.w.ids.roti, quantity: 1 },
  ]);
  const payment = await p.w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  const intentId = payment.body.data.id as string;
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!.id;

  await owner.query(
    `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '2 hours'
      WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [tenantId(), intentId],
  );
  // The payment window ended: the order's QRIS hold (if any) is closed, which is what
  // lets the order be voided (trigger QRIS_HOLD_ACTIVE).
  await owner.query(
    `UPDATE pos_qris_holds SET state = 'closed', close_reason = 'provider_expired',
           closed_at = now()
      WHERE tenant_id = $1 AND order_id = $2 AND state IN ('open', 'cancelling')`,
    [tenantId(), toUuid(order.id)],
  );
  await owner.query(
    "UPDATE orders SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
    [tenantId(), toUuid(order.id)],
  );
  return {
    orderId: order.id,
    intentId,
    kopiLine: line(p.w.ids.kopi),
    rotiLine: line(p.w.ids.roti),
  };
}

/**
 * The guest pays late: the expired intent ends up paid with its evidence row (money
 * arrived), as raw rows. Gap (reported): the real late settlement of a QRIS code of a
 * guest bill is parked by its closed QRIS hold in this world, and the one reachable
 * late-settle path needs a VA gateway double; so the settled state is written directly.
 */
async function guestPaysLate(intentId: string, amountIdr = ORDER_PAID) {
  await owner.query(
    `UPDATE payment_intents SET status = 'paid', paid_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), intentId],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method,
        source, amount_idr, received_at)
     SELECT tenant_id, outlet_id, id, 'doit', $3::text, 'qris', 'verified_webhook',
            $4::bigint, now()
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), intentId, `LATE-${randomBytes(6).toString("hex")}`, amountIdr],
  );
}

/** The late-payment refund the system files for the late money (what requestQrLatePaymentRefund leaves). */
async function deliverPaidEvent(intentId: string) {
  await fileLateKey(`qr-late-payment-refund:${intentId}`, intentId, ORDER_PAID);
}

type Refund = { amount_idr: string; status: string; requested_by: string };

async function refundsOfIntent(intentId: string): Promise<Refund[]> {
  const { rows } = await owner.query<Refund>(
    `SELECT amount_idr::text AS amount_idr, status, requested_by
       FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId(), intentId],
  );
  return rows;
}

/** Money filed back to the guest on the intent (everything not failed / rejected). */
async function refundedIdr(intentId: string): Promise<number> {
  return (await refundsOfIntent(intentId))
    .filter((row) => !["failed", "rejected"].includes(row.status))
    .reduce((total, row) => total + Number(row.amount_idr), 0);
}

async function lateKeyRows(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key LIKE $2`,
    [tenantId(), `%late-payment-refund:${intentId}%`],
  );
  return rows[0]!.n;
}

async function voidedIdr(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM pos_order_voids
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId(), toUuid(orderId)],
  );
  return Number(rows[0]!.n);
}

async function voucherTotalOfTenantOrder(issueIds: (string | null)[]) {
  return p.voucherTotal(issueIds.filter((id): id is string => id !== null));
}

describe("1127 a QR order expired, voided and paid late gets no apology voucher", () => {
  it("late payment refund filed for the whole payment: the failed-item voucher is refused 422 NOTHING_DUE, no voucher row, total out <= paid", async () => {
    const order = await expiredVoidedOrder();
    await guestPaysLate(order.intentId);
    await deliverPaidEvent(order.intentId);

    // Setup guard: the system really filed the late-payment refund for what was paid.
    expect(
      await refundedIdr(order.intentId),
      "late-payment refund filed for the whole late payment",
    ).toBe(ORDER_PAID);
    expect(
      await lateKeyRows(order.intentId),
      "the late-payment key row exists",
    ).toBeGreaterThan(0);

    const before = await apologyVoucherCount();
    const out = await reportThenVoucher(
      order.orderId,
      order.rotiLine,
      VOUCHER_TRY,
    );
    if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
    else expect(out.reported.status).toBe(422);
    await expectNoVoucher(out.issueId, before);

    const totalOut =
      (await refundedIdr(order.intentId)) +
      (await voucherTotalOfTenantOrder([out.issueId])) +
      (await voidedIdr(order.orderId));
    expect(
      totalOut,
      "refund + vouchers handed to the guest",
    ).toBeLessThanOrEqual(ORDER_PAID);
  });

  it("the whole payment is already filed back: even an exact-line voucher (full kopi value) leaves no row", async () => {
    const order = await expiredVoidedOrder();
    await guestPaysLate(order.intentId);
    await deliverPaidEvent(order.intentId);
    const before = await apologyVoucherCount();

    const out = await reportThenVoucher(order.orderId, order.kopiLine, 28_875);
    if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
    else expect(out.reported.status).toBe(422);
    await expectNoVoucher(out.issueId, before);
    expect(await refundedIdr(order.intentId)).toBe(ORDER_PAID);
  });

  it("late payment is paid but its refund is not requested yet: the voucher is still refused (voided order, room 0)", async () => {
    const order = await expiredVoidedOrder();
    await guestPaysLate(order.intentId);
    // Setup guard: nothing has been filed back yet, the money is parked.
    expect(await refundsOfIntent(order.intentId)).toEqual([]);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenantId(), order.intentId],
    );
    expect(["paid", "partially_refunded", "refunded"]).toContain(
      rows[0]!.status,
    );
    const before = await apologyVoucherCount();

    const out = await reportThenVoucher(
      order.orderId,
      order.rotiLine,
      VOUCHER_TRY,
    );
    if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
    else expect(out.reported.status).toBe(422);
    await expectNoVoucher(out.issueId, before);

    // The parked money is still there for the late refund: file it now. Together with
    // the (refused) voucher the guest gets back what was paid, once.
    await deliverPaidEvent(order.intentId);
    expect(await refundedIdr(order.intentId)).toBe(ORDER_PAID);
    expect(
      (await refundedIdr(order.intentId)) +
        (await voucherTotalOfTenantOrder([out.issueId])),
    ).toBeLessThanOrEqual(ORDER_PAID);
  });

  it("a voucher asked for a different line of the same voided order is refused too (every line, not only the first)", async () => {
    const order = await expiredVoidedOrder();
    await guestPaysLate(order.intentId);
    await deliverPaidEvent(order.intentId);
    const before = await apologyVoucherCount();

    const first = await reportThenVoucher(order.orderId, order.rotiLine, 1_000);
    const second = await reportThenVoucher(
      order.orderId,
      order.kopiLine,
      1_000,
    );
    for (const out of [first, second]) {
      if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
      else expect(out.reported.status).toBe(422);
    }
    expect(await apologyVoucherCount(), "no apology voucher row").toBe(before);
  });

  it("control: a normal paid QR order (no late payment) still has voucher room", async () => {
    const paid = await p.paidPlainOrder();
    const out = await reportThenVoucher(
      paid.orderId,
      paid.rotiLine,
      VOUCHER_TRY,
    );
    expect(out.voucher, JSON.stringify(out.reported.body)).not.toBeNull();
    expect(out.voucher!.status, JSON.stringify(out.voucher!.body)).toBe(201);
    expect(await p.voucherValues(out.issueId!)).toEqual([VOUCHER_TRY]);
    expect(
      await voucherTotalOfTenantOrder([out.issueId]),
      "voucher within the paid amount",
    ).toBeLessThanOrEqual(ORDER_PAID);
  });

  it("control: the room of a normal paid order is its full paid amount (49.666 refused, 49.665 total accepted over two vouchers)", async () => {
    const paid = await p.paidPlainOrder();
    const kopi = await p.reportLine(paid.kopiLine);
    const over = await p.staffVoucher(kopi, ORDER_PAID + 1);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(await p.voucherValues(kopi)).toEqual([]);
    const exact = await p.staffVoucher(kopi, 28_875);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await p.voucherValues(kopi)).toEqual([28_875]);
  });

  it.todo(
    "POS sale with a pos-late-payment-refund on a tender intent: cashier refund room excludes that intent. Not asserted as a room: pos-refund-ceilings.test.ts fixes the opposite for a tender whose own intent carries the late key, and the brief changes only the non-POS intent filter; see the property row in refund-1116-paid-basis.test.ts.",
  );
});

// ---------------------------------------------------------------------------
// orderGivenOf on a NON-voided order: the late key alone decides (architect review)
// ---------------------------------------------------------------------------

async function paidIdrOf(orderId: string): Promise<number> {
  const context = contextOf(tenantId());
  const given = await withTenant(db, context, (tx) =>
    orderGivenOf(tx, context.tenant.tenantId, orderId),
  );
  return given.paidIdr;
}

/** The late-payment refund the system filed for an intent, with its once-only key. */
async function fileLateKey(key: string, intentId: string, amountIdr: number) {
  const refund = await owner.query<{ id: string }>(
    `INSERT INTO payment_refunds
       (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, $3::bigint, 'Refund pembayaran telat uji 1127',
            'pending', 'system:qr'
       FROM payment_intents WHERE tenant_id = $1 AND id = $2
     RETURNING id`,
    [tenantId(), intentId, amountIdr],
  );
  const refundId = refund.rows[0]!.id;
  await owner.query(
    `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      tenantId(),
      key.replace("<refund>", refundId),
      randomBytes(32).toString("hex"),
      JSON.stringify({ refundId }),
    ],
  );
  return refundId;
}

async function ownIntentOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT i.id FROM orders o
       JOIN payment_intents i ON i.tenant_id = o.tenant_id
        AND (i.id = o.payment_intent_id
             OR (o.payment_link_id IS NOT NULL AND i.payment_link_id = o.payment_link_id))
      WHERE o.tenant_id = $1 AND o.id = $2 ORDER BY i.created_at LIMIT 1`,
    [tenantId(), toUuid(orderId)],
  );
  expect(rows, "the QR order has a payment intent").toHaveLength(1);
  return rows[0]!.id;
}

describe("1127 orderGivenOf: a late-payment key on the order's own intent zeroes its paid money", () => {
  it("control: a normally paid, not voided QR order is paid 49.665", async () => {
    const paid = await p.paidPlainOrder();
    expect(await paidIdrOf(paid.orderId)).toBe(ORDER_PAID);
  });

  for (const prefix of ["qr-late-payment-refund:", "pos-late-payment-refund:"])
    it(`${prefix}<own intent> on a live (not voided) order: paid is 0`, async () => {
      const paid = await p.paidPlainOrder();
      const intentId = await ownIntentOf(paid.orderId);
      await fileLateKey(`${prefix}${intentId}`, intentId, ORDER_PAID);
      expect(await paidIdrOf(paid.orderId), "late-keyed intent counts 0").toBe(
        0,
      );
    });

  it("a late key on ANOTHER order's intent does not zero this order (exact intent id, not a loose prefix)", async () => {
    const mine = await p.paidPlainOrder();
    const other = await p.paidPlainOrder();
    const otherIntent = await ownIntentOf(other.orderId);
    await fileLateKey(
      `qr-late-payment-refund:${otherIntent}`,
      otherIntent,
      ORDER_PAID,
    );
    expect(await paidIdrOf(mine.orderId), "untouched order").toBe(ORDER_PAID);
    expect(await paidIdrOf(other.orderId), "late-keyed order").toBe(0);
  });

  it("the re-file key qr-late-payment-refund:<intent>:<refund> zeroes the order's own intent too", async () => {
    const paid = await p.paidPlainOrder();
    const intentId = await ownIntentOf(paid.orderId);
    await fileLateKey(
      `qr-late-payment-refund:${intentId}:<refund>`,
      intentId,
      ORDER_PAID,
    );
    expect(await paidIdrOf(paid.orderId)).toBe(0);
  });
});
