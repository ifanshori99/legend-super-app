// legend-1116 (tier K, money): second opinion 1114 found two P1 holes in the one
// source that decides how much of an order may still be handed back
// (`order-given`, used by the cashier refund, the apology voucher and the void):
//
//   P1-a  a QR / open-bill order that was never paid counts as paid (its bill value),
//         so a kitchen report plus a staff apology voucher hands out money for a sale
//         that brought none.
//   P1-b  money that already left through the payment provider (a provider refund
//         recorded in payment_provider_refunds, a refund of ours through the gateway,
//         a provider-refunded flag without an amount) does not reduce what is left.
//
// Rule under test (CTO decisions in docs/briefs/1116-fix-refund-kasir-1095-so.md):
//   paid = only money that really arrived (payment intent paid / partially_refunded /
//          refunded with paid_at, or a captured POS tender); pending, expired, failed
//          or no intent = 0; doubt = 0;
//   room = paid - everything already out (cashier refunds, ORD-09, vouchers, void,
//          provider refunds, our gateway refunds); a provider-refunded flag with no
//          definite amount makes that payment count 0;
//   total out to the guest <= paid, across every path.
//
// Written from docs/briefs/1116-fix-refund-kasir-1095-so.md, the second opinion
// docs/qa/second-opinion-refund-kasir-1095-1114.md and docs/briefs/sub-1095.md
// (section "Ronde 1116"), the shared validators and the existing 1095 / 980 / 1013 /
// 1016 / mz15j tests, never from the implementation.
//
// Assumptions (also reported):
// - The numbers of the brief (paid 100.000, provider refund 100.000 / 40.000) are
//   scaled to the 1095 world: the plain QR order is paid 49.665. Full provider refund
//   = 49.665; "partial" = 30.000 (room 19.665, not 60.000 of 100.000).
// - The provider refund is recorded with `recordProviderRefundInTx` (the function the
//   webhook calls), exactly like accounting-provider-refund-net-1013 and
//   payment-overpay-provider-refund-1016; `force: true` skips the in-flight "retry"
//   window. The payment reference is the intent's own provider_ref, or the evidence
//   reference when that does not bind; the outcome must be "recorded" (setup guard).
// - "Open refund hold" (refund_recon_holds) is not on this branch: it.todo only.
// - Gateway refund of ours = a payment_refunds row on the order's intent, status
//   pending / approved / completed (counts), failed (does not count), no
//   order_issue_id, no link to a POS refund. Raw rows, like payment-refund-qr-net-
//   provider-1031. An ORD-09 refund (order_issue_id set) is already counted by its
//   own lane and must be counted once, not twice (over-restriction guard).
// - A staff voucher above the room is refused 422 APOLOGY_VOUCHER_OVER_ROOM, with no
//   room 422 APOLOGY_VOUCHER_NOTHING_DUE (refund-1095-voucher-room). The exact room is
//   accepted (201).
// - QR kitchen report with resolution null that is refused before the voucher (a paid
//   guard on the report route) is also acceptable: the test then asserts that no
//   voucher exists. The accepted shape is "no voucher row, ever".
// - POS side: a POS sale paid by a captured QRIS tender whose payment_intent_id is
//   the QR intent. Cashier refund / void refusal is asserted as "not ok, no row";
//   the control refund within the room is asserted as ok.
// - Property test: external money (provider refund, gateway refund of ours) happens
//   first (the provider is not asked); the guarded paths (staff voucher, cashier
//   refund, cloud void) then run in every order. Total out = cashier refunds + vouchers
//   + void amounts + provider refunds + the raw gateway refunds the test inserted
//   (the gateway request a QRIS cashier refund files is the same money as the cashier
//   refund and is not added again).
//
// Run: LEGEND_TEST_FILES="src/test/refund-1116-paid-basis.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { CART_TOTAL } from "./order-recovery-helpers.ts";
import {
  KOPI_PAID,
  ORDER_PAID,
  ROTI_PAID,
  ROTI_PRICE,
  contextOf,
  createPosWorld,
  sum,
  toUlid,
  toUuid,
  type PaidOrder,
  type PosWorld,
} from "./refund-1095-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

const NOTHING_DUE = "APOLOGY_VOUCHER_NOTHING_DUE";
const OVER_ROOM = "APOLOGY_VOUCHER_OVER_ROOM";

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

function expectRefused(answer: Answer, code: string) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(422);
  expect(answer.body.error?.code, JSON.stringify(answer.body)).toBe(code);
}

function expectIssued(answer: Answer) {
  expect(answer.status, JSON.stringify(answer.body)).toBe(201);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const tenantId = () => p.w.tenant.tenantId;

async function apologyVoucherCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM apology_vouchers WHERE tenant_id = $1",
    [tenantId()],
  );
  return rows[0]!.n;
}

let kitchenStation: string | null = null;

/**
 * The kitchen / floor report route (POST /api/outlets/:outlet/orders/:order/issues)
 * with a complaint and NO resolution: it only needs an existing order and line, it has
 * no paid guard (second opinion 1114). Returns the raw answer and the stored issue id.
 */
async function kitchenReport(orderId: string, lineId: string) {
  if (!kitchenStation) {
    kitchenStation = randomUUID();
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Bar 1116', 'beverage_bar')`,
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
      reasonNote: "Pelanggan kecewa, minta voucher maaf",
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
  return { answer, issueId: rows[0]?.id ?? null };
}

/**
 * Kitchen report, then the staff apology voucher of `valueIdr` on that issue. When the
 * report itself is refused (an acceptable earlier stop), `voucher` is null.
 */
async function reportThenVoucher(
  orderId: string,
  lineId: string,
  valueIdr: number,
) {
  const { answer, issueId } = await kitchenReport(orderId, lineId);
  if (issueId === null || answer.status !== 201)
    return { reported: answer as Answer, issueId, voucher: null };
  return {
    reported: answer as Answer,
    issueId,
    voucher: (await p.staffVoucher(issueId, valueIdr)) as Answer,
  };
}

/** A voucher must never exist after a refusal, whichever step refused it. */
async function expectNoVoucher(issueId: string | null, before: number) {
  if (issueId) expect(await p.voucherValues(issueId)).toEqual([]);
  expect(await apologyVoucherCount(), "no apology voucher row").toBe(before);
}

type Intent = { id: string; providerRef: string | null };

async function intentOf(orderId: string): Promise<Intent> {
  const byOrder = await owner.query<{ id: string; provider_ref: string }>(
    `SELECT id, provider_ref FROM payment_intents
      WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at LIMIT 1`,
    [tenantId(), toUuid(orderId)],
  );
  if (byOrder.rows[0])
    return {
      id: byOrder.rows[0].id,
      providerRef: byOrder.rows[0].provider_ref,
    };
  const pinned = await owner.query<{ id: string; provider_ref: string }>(
    `SELECT i.id, i.provider_ref FROM orders o
       JOIN payment_intents i ON i.tenant_id = o.tenant_id AND i.id = o.payment_intent_id
      WHERE o.tenant_id = $1 AND o.id = $2`,
    [tenantId(), toUuid(orderId)],
  );
  expect(pinned.rows, "the QR order has a payment intent").toHaveLength(1);
  return { id: pinned.rows[0]!.id, providerRef: pinned.rows[0]!.provider_ref };
}

/** The POS sale of a QR order: a captured QRIS tender that names the QR intent. */
async function becomePosQrisSale(paid: PaidOrder, intentId: string) {
  const uuid = toUuid(paid.orderId);
  await owner.query(
    "UPDATE orders SET channel = 'pos', status = 'completed' WHERE tenant_id = $1 AND id = $2",
    [tenantId(), uuid],
  );
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
     VALUES ($1, $2, $3, 'pos', now())`,
    [uuid, tenantId(), paid.outletId],
  );
  await owner.query(
    `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
        amount_idr, received_idr, change_idr, status, requested_at, resolved_at,
        payment_intent_id)
     VALUES ($1, $2, $3, 'qris', 'doit', $4, NULL, NULL, 'captured',
             now() - interval '1 minute', now(), $5)`,
    [tenantId(), paid.outletId, uuid, ORDER_PAID, intentId],
  );
}

type Recorded = Awaited<ReturnType<typeof recordProviderRefundInTx>>;

/**
 * The provider returned `amountIdr` of the QR payment on its own, through the real
 * recorder (the webhook's function). Must end `recorded`.
 */
async function recordProviderRefund(
  intent: Intent,
  amountIdr: number,
  providerRefundId = `rf_${randomUUID().slice(0, 12)}`,
): Promise<Recorded> {
  const evidence = await owner.query<{ provider_ref: string }>(
    `SELECT provider_ref FROM payment_evidence
      WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY received_at`,
    [tenantId(), intent.id],
  );
  const refs = [
    ...(intent.providerRef ? [intent.providerRef] : []),
    ...evidence.rows.map((row) => row.provider_ref),
  ];
  const context = contextOf(tenantId());
  let last: Recorded | null = null;
  for (const providerPaymentRef of refs) {
    last = await withTenant(db, context, (tx) =>
      recordProviderRefundInTx(
        tx,
        context,
        {
          provider: "doit",
          providerRefundId,
          providerPaymentRef,
          amountIdr,
          source: "payment_webhook",
          expectedIntentId: intent.id,
          force: true,
        },
        new Date(),
      ),
    );
    if (last.status === "recorded" || last.status === "duplicate") return last;
  }
  throw new Error(
    `provider refund was not recorded (last: ${last?.status ?? "no reference"})`,
  );
}

async function providerRefundedIdr(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId(), intentId],
  );
  return Number(rows[0]!.n);
}

type GatewayStatus = "pending" | "approved" | "completed" | "failed";

/** A refund of ours through the gateway on the intent (no order issue, no POS link). */
async function gatewayRefund(
  intentId: string,
  amountIdr: number,
  status: GatewayStatus,
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_refunds
       (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, provider_ref)
     SELECT tenant_id, outlet_id, id, $3, 'Refund gateway uji 1116', $4,
            'refund-1116-test',
            CASE WHEN $4 IN ('approved', 'completed') THEN 'refund-1116-approver' END,
            CASE WHEN $4 IN ('approved', 'completed') THEN now() END,
            CASE WHEN $4 = 'completed' THEN $5 END
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId(),
      intentId,
      amountIdr,
      status,
      `gw-${randomBytes(6).toString("hex")}`,
    ],
  );
}

async function flagProviderRefunded(
  intentId: string,
  column: "provider_refunded_at" | "provider_refunded_after_paid_at",
) {
  await owner.query(
    `UPDATE payment_intents SET ${column} = now() WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), intentId],
  );
}

async function voidedIdr(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM pos_order_voids
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId(), toUuid(orderId)],
  );
  return Number(rows[0]!.n);
}

// ---------------------------------------------------------------------------
// 1116-P1a: unpaid QR / open bill is not paid
// ---------------------------------------------------------------------------

const BILL_VOUCHER = 10_000;

/**
 * An open-bill order (sent, bill not settled) that may hold a payment intent in
 * `status` (null = no intent at all). Rows are inserted as the cashier flow leaves
 * them (see order-recovery-paid-intent, mz15j): the guest cannot pay an unsettled
 * open bill through the API.
 */
async function openBill(intent: { status: string; amountIdr?: number } | null) {
  const made = await p.w.openBillOrder();
  const orderUuid = ulidToUuid(made.order.id);
  const { rows } = await owner.query<{ outlet_id: string }>(
    "SELECT outlet_id FROM orders WHERE tenant_id = $1 AND id = $2",
    [tenantId(), orderUuid],
  );
  const outletId = rows[0]!.outlet_id;
  const kopi = made.order.items.find(
    (item) => item.menuItemId === p.w.ids.kopi,
  )!;
  if (intent === null)
    return { ...made, kopi, intentId: null as string | null, outletId };
  const amountIdr = intent.amountIdr ?? CART_TOTAL;
  const settled = ["paid", "partially_refunded", "refunded"].includes(
    intent.status,
  );
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, '1116-test')`,
    [
      linkId,
      tenantId(),
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `P1116-${linkId.slice(0, 8)}`,
      CART_TOTAL,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, $8,
             '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
             now() + interval '1 hour', ${settled ? "now()" : "NULL"})`,
    [
      intentId,
      tenantId(),
      outletId,
      linkId,
      orderUuid,
      amountIdr,
      `p1116-${intentId}`,
      intent.status,
    ],
  );
  await owner.query(
    "UPDATE orders SET payment_intent_id = $3 WHERE tenant_id = $1 AND id = $2",
    [tenantId(), orderUuid, intentId],
  );
  return { ...made, kopi, intentId: intentId as string | null, outletId };
}

/** The verified webhook settles the intent (a real confirmation, with evidence). */
async function settleVerified(intentId: string, amountIdr: number) {
  await confirmPayment(contextOf(tenantId()), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId(), intentId],
  );
  expect(rows[0]!.status, "the verified payment settled the intent").toBe(
    "paid",
  );
}

describe("1116-P1a an order nobody paid cannot get an apology voucher", () => {
  it("open bill with no payment at all: kitchen report, then staff voucher -> 422 NOTHING_DUE, no voucher row", async () => {
    const bill = await openBill(null);
    const before = await apologyVoucherCount();

    const out = await reportThenVoucher(
      bill.order.id,
      bill.roti.id,
      BILL_VOUCHER,
    );
    if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
    else expect(out.reported.status).toBe(422);
    await expectNoVoucher(out.issueId, before);
  });

  for (const status of ["pending", "expired", "failed"]) {
    it(`open bill whose QR payment is ${status}: voucher refused NOTHING_DUE, no voucher row`, async () => {
      const bill = await openBill({ status });
      const before = await apologyVoucherCount();

      const out = await reportThenVoucher(
        bill.order.id,
        bill.roti.id,
        BILL_VOUCHER,
      );
      if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
      else expect(out.reported.status).toBe(422);
      await expectNoVoucher(out.issueId, before);
    });
  }

  it("pay-first QR order placed but not paid (a real pending intent): voucher refused NOTHING_DUE", async () => {
    const guest = await p.w.seat("pay_first");
    const order = await p.w.placeOrder(guest, [
      { menuItemId: p.w.ids.kopi, quantity: 1 },
      { menuItemId: p.w.ids.roti, quantity: 1 },
    ]);
    const payment = await p.w
      .as(guest)
      .pay({ kind: "order", orderId: order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const roti = order.items.find((item) => item.menuItemId === p.w.ids.roti)!;
    const before = await apologyVoucherCount();

    const out = await reportThenVoucher(order.id, roti.id, BILL_VOUCHER);
    if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
    else expect(out.reported.status).toBe(422);
    await expectNoVoucher(out.issueId, before);
  });

  it("control: the same open-bill issue is refused while unpaid and accepted after the verified payment", async () => {
    const bill = await openBill({ status: "pending" });
    const before = await apologyVoucherCount();

    const unpaid = await reportThenVoucher(
      bill.order.id,
      bill.roti.id,
      BILL_VOUCHER,
    );
    expect(unpaid.issueId, "the report is stored").not.toBeNull();
    expect(unpaid.voucher, "the voucher request was made").not.toBeNull();
    expectRefused(unpaid.voucher!, NOTHING_DUE);
    await expectNoVoucher(unpaid.issueId, before);

    await settleVerified(bill.intentId!, CART_TOTAL);

    const paid = await p.staffVoucher(unpaid.issueId!, BILL_VOUCHER);
    expectIssued(paid);
    expect(await p.voucherValues(unpaid.issueId!)).toEqual([BILL_VOUCHER]);
  });

  it("control: a paid pay-first QR order still gets its apology voucher through the kitchen route", async () => {
    const paid = await p.paidPlainOrder();
    const out = await reportThenVoucher(
      paid.orderId,
      paid.rotiLine,
      BILL_VOUCHER,
    );
    expect(out.voucher, JSON.stringify(out.reported.body)).not.toBeNull();
    expectIssued(out.voucher!);
    expect(await p.voucherValues(out.issueId!)).toEqual([BILL_VOUCHER]);
  });

  it("paid basis is the money that arrived: a 30.000 payment on a 90.090 bill leaves room 30.000 (30.001 refused OVER_ROOM, 30.000 accepted)", async () => {
    const bill = await openBill({ status: "paid", amountIdr: 30_000 });
    const { issueId } = await kitchenReport(bill.order.id, bill.kopi.id);
    expect(issueId, "the report is stored").not.toBeNull();

    const over = await p.staffVoucher(issueId!, 30_001);
    expectRefused(over, OVER_ROOM);
    expect(await p.voucherValues(issueId!)).toEqual([]);

    const exact = await p.staffVoucher(issueId!, 30_000);
    expectIssued(exact);
    expect(await p.voucherValues(issueId!)).toEqual([30_000]);
  });
});

// ---------------------------------------------------------------------------
// 1116-P1b: money that left through the provider reduces the room
// ---------------------------------------------------------------------------

type Kind = "qr" | "pos";

async function paidOrderOfKind(kind: Kind) {
  const paid = await p.paidPlainOrder();
  const intent = await intentOf(paid.orderId);
  if (kind === "pos") await becomePosQrisSale(paid, intent.id);
  return { paid, intent };
}

async function expectRoom(paid: PaidOrder, roomIdr: number, lineId: string) {
  const issueId = await p.reportLine(lineId);
  const over = await p.staffVoucher(issueId, roomIdr + 1);
  expectRefused(over, OVER_ROOM);
  expect(String(over.body.error?.message)).toMatch(
    new RegExp(String(roomIdr).replace(/(\d)(?=(\d{3})+$)/g, "$1[.,]?")),
  );
  expect(await p.voucherValues(issueId), "refused, not cut").toEqual([]);
  const exact = await p.staffVoucher(issueId, roomIdr);
  expectIssued(exact);
  expect(await p.voucherValues(issueId)).toEqual([roomIdr]);
  return issueId;
}

for (const kind of ["qr", "pos"] as const) {
  describe(`1116-P1b provider money on a ${kind === "qr" ? "QR order" : "POS sale paid by QRIS"}`, () => {
    it("the provider refunded the whole payment (recorded by its recorder): voucher refused NOTHING_DUE", async () => {
      const { paid, intent } = await paidOrderOfKind(kind);
      expect((await recordProviderRefund(intent, ORDER_PAID)).status).toBe(
        "recorded",
      );
      expect(await providerRefundedIdr(intent.id)).toBe(ORDER_PAID);

      const { issueId, issued } = await p.apologyVoucherRequest(
        paid.rotiLine,
        10_000,
      );
      expectRefused(issued, NOTHING_DUE);
      expect(await p.voucherValues(issueId)).toEqual([]);
    });

    it("the provider refunded the whole payment: the kitchen-route report plus staff voucher is refused too (the SO scenario)", async () => {
      const { paid, intent } = await paidOrderOfKind(kind);
      await recordProviderRefund(intent, ORDER_PAID);
      const before = await apologyVoucherCount();

      const out = await reportThenVoucher(
        paid.orderId,
        paid.rotiLine,
        ROTI_PAID,
      );
      if (out.voucher) expectRefused(out.voucher, NOTHING_DUE);
      else expect(out.reported.status).toBe(422);
      await expectNoVoucher(out.issueId, before);
    });

    it("the provider refunded 30.000: the voucher is capped at the rest 19.665 (19.666 refused OVER_ROOM, 19.665 accepted)", async () => {
      const { paid, intent } = await paidOrderOfKind(kind);
      await recordProviderRefund(intent, 30_000);
      const issueId = await expectRoom(
        paid,
        ORDER_PAID - 30_000,
        paid.kopiLine,
      );
      expect(
        await p.voucherTotal([issueId]),
        "voucher + provider refund = paid",
      ).toBe(ORDER_PAID - 30_000);
    });

    it("the same provider refund delivered twice counts once (room stays 19.665)", async () => {
      const { paid, intent } = await paidOrderOfKind(kind);
      const providerRefundId = `rf_${randomUUID().slice(0, 12)}`;
      expect(
        (await recordProviderRefund(intent, 30_000, providerRefundId)).status,
      ).toBe("recorded");
      expect(
        (await recordProviderRefund(intent, 30_000, providerRefundId)).status,
      ).toBe("duplicate");
      expect(await providerRefundedIdr(intent.id)).toBe(30_000);
      await expectRoom(paid, ORDER_PAID - 30_000, paid.kopiLine);
    });

    for (const status of ["pending", "approved", "completed"] as const) {
      it(`a ${status} refund of ours through the gateway (30.000) reduces the room to 19.665`, async () => {
        const { paid, intent } = await paidOrderOfKind(kind);
        await gatewayRefund(intent.id, 30_000, status);
        await expectRoom(paid, ORDER_PAID - 30_000, paid.kopiLine);
      });
    }

    it("a failed refund of ours through the gateway frees nothing it did not take: the room is the whole kopi line", async () => {
      const { paid, intent } = await paidOrderOfKind(kind);
      await gatewayRefund(intent.id, 30_000, "failed");
      const issueId = await p.reportLine(paid.kopiLine);
      expectIssued(await p.staffVoucher(issueId, KOPI_PAID));
      expect(await p.voucherValues(issueId)).toEqual([KOPI_PAID]);
    });

    it("provider refund and gateway refund together (20.000 + 15.000) leave 14.665", async () => {
      const { paid, intent } = await paidOrderOfKind(kind);
      await recordProviderRefund(intent, 20_000);
      await gatewayRefund(intent.id, 15_000, "pending");
      await expectRoom(paid, ORDER_PAID - 35_000, paid.kopiLine);
    });

    for (const column of [
      "provider_refunded_at",
      "provider_refunded_after_paid_at",
    ] as const) {
      it(`${column} set with no definite amount: that payment counts 0, voucher refused NOTHING_DUE`, async () => {
        const { paid, intent } = await paidOrderOfKind(kind);
        expect(await providerRefundedIdr(intent.id)).toBe(0);
        await flagProviderRefunded(intent.id, column);

        const { issueId, issued } = await p.apologyVoucherRequest(
          paid.rotiLine,
          10_000,
        );
        expectRefused(issued, NOTHING_DUE);
        expect(await p.voucherValues(issueId)).toEqual([]);
      });
    }

    it.todo(
      "an open refund hold (refund_recon_holds) on the payment also reduces the room: not on this branch (ws/1072 only), follow-up bead for the merge train",
    );
  });
}

describe("1116-P1b ORD-09 refund is counted once (no double counting with the gateway refund row)", () => {
  it("ORD-09 refund of the roti (20.790) leaves the whole kopi line 28.875, not less", async () => {
    const paid = await p.paidPlainOrder();
    const ord09 = await p.recoveryRefundFor(
      paid.rotiLine,
      ROTI_PRICE,
      ROTI_PAID,
    );
    const issueId = await p.reportLine(paid.kopiLine);
    expectIssued(await p.staffVoucher(issueId, KOPI_PAID));
    expect(await p.voucherValues(issueId)).toEqual([KOPI_PAID]);
    expect(await p.returnedTotal(paid.orderId, [ord09, issueId])).toBe(
      ORDER_PAID,
    );
  });
});

describe("1116-P1b cashier refund and void on a POS sale paid by QRIS", () => {
  it("control: without any provider money, a cashier refund of 1.000 is accepted", async () => {
    const { paid } = await paidOrderOfKind("pos");
    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 1_000),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([1_000]);
  });

  it("the provider refunded the whole payment: the cashier refund room is 0, nothing is refunded", async () => {
    const { paid, intent } = await paidOrderOfKind("pos");
    await recordProviderRefund(intent, ORDER_PAID);

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 1_000),
    );
    expect(outcome.ok, "a cashier refund of money already refunded").toBe(
      false,
    );
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
  });

  it("the provider refunded 30.000: a cashier refund of 19.666 is refused, 19.665 is accepted", async () => {
    const { paid, intent } = await paidOrderOfKind("pos");
    await recordProviderRefund(intent, 30_000);

    const over = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID - 30_000 + 1),
    );
    expect(over.ok, "above the money still held").toBe(false);
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);

    const exact = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID - 30_000),
    );
    expect(exact.ok, JSON.stringify(exact)).toBe(true);
    expect(await p.posRefundRows(paid.orderId)).toEqual([ORDER_PAID - 30_000]);
  });

  it("a refund of ours through the gateway (30.000) also limits the cashier refund to 19.665", async () => {
    const { paid, intent } = await paidOrderOfKind("pos");
    await gatewayRefund(intent.id, 30_000, "pending");

    const over = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, ORDER_PAID - 30_000 + 1),
    );
    expect(over.ok, "above the money still held").toBe(false);
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
  });

  it("the provider refunded 30.000: the void of the whole sale (49.665) is refused", async () => {
    const { paid, intent } = await paidOrderOfKind("pos");
    await recordProviderRefund(intent, 30_000);

    const voided = await p.cloudVoid(paid.orderId);
    expect(
      voided.ok,
      "void would hand back money the provider already did",
    ).toBe(false);
    expect(await p.voidCount(paid.orderId)).toBe(0);
    expect(await voidedIdr(paid.orderId)).toBe(0);
  });

  // Decision 1116: a cloud void of a sale whose QRIS payment already had provider money
  // out (provider refund, gateway refund not made by a POS refund, or the
  // provider-refunded flag) is refused 409 VOID_PROVIDER_REFUNDED.
  const providerMoney: [string, (intent: Intent) => Promise<void>][] = [
    [
      "a provider refund",
      async (i) => void (await recordProviderRefund(i, 5_000)),
    ],
    ["a gateway refund of ours", (i) => gatewayRefund(i.id, 5_000, "pending")],
    [
      "the provider-refunded flag",
      (i) => flagProviderRefunded(i.id, "provider_refunded_after_paid_at"),
    ],
  ];
  for (const [name, apply] of providerMoney)
    it(`void of the sale is refused 409 VOID_PROVIDER_REFUNDED after ${name}`, async () => {
      const { paid, intent } = await paidOrderOfKind("pos");
      await apply(intent);

      const voided = await p.cloudVoid(paid.orderId);
      expect(voided.ok, "void refused").toBe(false);
      if (!voided.ok) {
        expect(voided.error.status, JSON.stringify(voided.error)).toBe(409);
        expect(voided.error.code, JSON.stringify(voided.error)).toBe(
          "VOID_PROVIDER_REFUNDED",
        );
      }
      expect(await p.voidCount(paid.orderId)).toBe(0);
    });

  it("provider-refunded flag with no amount: the cashier refund is refused", async () => {
    const { paid, intent } = await paidOrderOfKind("pos");
    await flagProviderRefunded(intent.id, "provider_refunded_after_paid_at");

    const outcome = await p.posRefund(
      paid.orderId,
      await p.refundInput(paid.orderId, 1_000),
    );
    expect(outcome.ok, "no definite amount: fail closed").toBe(false);
    expect(await p.posRefundRows(paid.orderId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1116 property: every path together never pays out more than was paid
// ---------------------------------------------------------------------------

type External = {
  name: string;
  providerIdr?: number;
  gatewayIdr?: number;
  flag?: boolean;
};

/** Money that already left (or may have left) through the provider, before any guarded path runs. */
const EXTERNALS: External[] = [
  { name: "nothing external" },
  { name: "provider 25.000", providerIdr: 25_000 },
  {
    name: "provider 25.000 + gateway 15.000",
    providerIdr: 25_000,
    gatewayIdr: 15_000,
  },
  {
    name: "gateway 30.000 + provider 19.665 (all of it)",
    providerIdr: 19_665,
    gatewayIdr: 30_000,
  },
  { name: "provider 49.665 (all of it)", providerIdr: ORDER_PAID },
  { name: "provider-refunded flag, no amount", flag: true },
];

type Guarded = "voucher" | "cashier" | "void";
const VOUCHER_TRY = 20_000;
const CASHIER_TRY = 20_000;

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

describe("1116 property: refund + provider refund + voucher + void <= verified paid", () => {
  for (const external of EXTERNALS)
    for (const order of permutations<Guarded>(["voucher", "cashier", "void"]))
      it(`${external.name}, then ${order.join(" -> ")}: total out <= ${ORDER_PAID}`, async () => {
        const { paid, intent } = await paidOrderOfKind("pos");
        let externalIdr = 0;
        if (external.providerIdr) {
          await recordProviderRefund(intent, external.providerIdr);
          externalIdr += await providerRefundedIdr(intent.id);
        }
        if (external.gatewayIdr) {
          await gatewayRefund(intent.id, external.gatewayIdr, "pending");
          externalIdr += external.gatewayIdr;
        }
        if (external.flag)
          await flagProviderRefunded(
            intent.id,
            "provider_refunded_after_paid_at",
          );

        const issueIds: string[] = [];
        let accepted = 0;
        for (const step of order) {
          if (step === "voucher") {
            const { issueId, issued } = await p.apologyVoucherRequest(
              paid.kopiLine,
              VOUCHER_TRY,
            );
            issueIds.push(issueId);
            if (issued.status === 201) accepted += 1;
          } else if (step === "cashier") {
            const outcome = await p.posRefund(
              paid.orderId,
              await p.refundInput(paid.orderId, CASHIER_TRY),
            );
            if (outcome.ok) accepted += 1;
          } else {
            const outcome = await p.cloudVoid(paid.orderId);
            if (outcome.ok) accepted += 1;
          }
        }

        const totalOut =
          sum(await p.posRefundRows(paid.orderId)) +
          (await p.voucherTotal(issueIds)) +
          (await voidedIdr(paid.orderId)) +
          externalIdr;
        expect(
          totalOut,
          "cashier refunds + vouchers + void + provider refund + gateway refund",
        ).toBeLessThanOrEqual(ORDER_PAID);

        // Harness liveness: with no external money the guarded paths do run.
        if (external.name === "nothing external")
          expect(accepted, "something was paid out").toBeGreaterThan(0);
      });
});
