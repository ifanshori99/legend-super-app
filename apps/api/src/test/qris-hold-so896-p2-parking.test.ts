// SO-896 architect review, two P2 findings (tingkat K uang).
//
// P2-1: the order-side funds guard (`failedOrderCodeWithOpenFundTx`) looked only
// at the links of the order and its parts. Money parked on the intent of a POS
// QR tender (after a manager force release the QR is voided, the hold closed,
// and the late verified payment is parked on the tender intent) was missed, so
// the guest could still get a new code, split the bill or pay a part. Every
// guest money path must answer 409 FUNDS_UNRESOLVED while the money is open.
//
// P2-3: a closed code whose money was parked by a webhook path (or by the amount
// mismatch hold) is dead for good, but it kept `provider_final_at` empty, so the
// replacement code stayed refused as ORDER_CODE_ACTIVE after the funds were
// resolved. Parking must also set `provider_final_at`.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so896-p2-parking.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  holdGatewayAmountMismatch,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import { failedOrderCodeWithOpenFundTx } from "../services/payment-failed-funds.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  holdFixture,
  payNotice,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { BILL_IDR, releaseKit } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const UNDERPAID_IDR = 10_000;

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so896-p2-parking");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Part = { id: string; amountIdr: number };

const splitBody = () => ({
  method: "equal",
  parts: 2,
  idempotencyKey: randomUUID(),
});

function payWhole(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

function payPart(guest: Guest, part: Part) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: part.id },
    method: "va",
    bankCode: "bmri",
    payerSecret: secretFor(part.id),
    idempotencyKey: randomUUID(),
  });
}

function expectFundsUnresolved(
  response: Awaited<ReturnType<HoldFixture["guestPost"]>>,
) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error.code).toBe("FUNDS_UNRESOLVED");
}

async function resolveFunds(intentId: string) {
  await owner.query(
    `UPDATE payment_unallocated_funds
        SET resolution='refund', resolved_by='test', resolved_at=now()
      WHERE tenant_id=$1 AND payment_intent_id=$2 AND resolved_at IS NULL`,
    [fx.tenant.tenantId, intentId],
  );
}

/** A captain-submitted POS bill whose QR tender was force released by a
 * manager; optionally the guest then pays the released code (parked on the
 * tender intent). */
async function releasedTender(options: { lateGuestPayment: boolean }) {
  const guest = await fx.newGuest();
  const draft = await fx.createDraft(guest.sessionId);
  const submitted = await fx.submit(draft.id);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const order = submitted.body.data as { id: string };
  const { qr } = await kit.forceRelease({ rawStatus: "01" }, order.id);
  if (options.lateGuestPayment) {
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      new Date(),
      qr.providerRef!,
    ).catch(() => null);
    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked.map((p) => [p.amountIdr, p.resolution])).toEqual([
      [BILL_IDR, null],
    ]);
  }
  // The POS API answers the order id as a UUID; the guard takes the ULID.
  const orderUuid = order.id.includes("-") ? order.id : ulidToUuid(order.id);
  return { order, orderUlid: uuidToUlid(orderUuid), qr };
}

/** The order-side guard every guest code, split and part runs. */
async function orderGuard(orderUlid: string) {
  const { rows } = await owner.query<{ payment_link_id: string | null }>(
    "SELECT payment_link_id FROM orders WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, ulidToUuid(orderUlid)],
  );
  return withTenant(db, fx.context, (tx) =>
    failedOrderCodeWithOpenFundTx(tx, fx.context.tenant.tenantId, {
      id: orderUlid,
      paymentLinkId: rows[0]!.payment_link_id,
    }),
  );
}

describe("P2-1 money parked on a POS tender intent is seen by the order-side guard", () => {
  // A guest code and a POS tender never share an order today (guest payment
  // needs a pay_first QR order; the tender path needs a pos_orders row), so
  // the guard is exercised directly: it is the single check of the whole-order
  // code (qr-order-payment), the split (bill-split) and the part code.
  it("1: a force released tender with a late payment parked on its intent -> the guard finds the fund; none once resolved", async () => {
    const { orderUlid, qr } = await releasedTender({
      lateGuestPayment: true,
    });

    expect(await orderGuard(orderUlid)).not.toBeNull();

    await resolveFunds(qr.intentId);
    expect(await orderGuard(orderUlid)).toBeNull();
  });

  it("control: a force released tender with no parked money -> no fund", async () => {
    const { orderUlid } = await releasedTender({ lateGuestPayment: false });
    expect(await orderGuard(orderUlid)).toBeNull();
  });

  it("2: a part cannot be paid while money is parked anywhere on the bill (here another part's expired code)", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const split = await fx.guestPost(guest, "/splits", splitBody());
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts = split.body.data.splits as Part[];
    const paid = await payPart(guest, parts[0]!);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const intentId = paid.body.data.id as string;
    const { rows } = await owner.query<{ expires_at: Date }>(
      "SELECT expires_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );
    fx.gateway.script(intentId, { status: "paid", amountIdr: UNDERPAID_IDR });
    await pollPendingGatewayIntents(
      fx.context,
      new Date(rows[0]!.expires_at.getTime() + 61_000),
      200,
    );
    expect(await unallocatedFunds(fx, intentId)).toHaveLength(1);

    expectFundsUnresolved(await payPart(guest, parts[1]!));

    await resolveFunds(intentId);
    const again = await payPart(guest, parts[1]!);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(order.id).toBeTruthy();
  });
});

describe("P2-3 parked money from the amount mismatch hold ends the code for good", () => {
  it("3: mismatch parks the money on an expired whole-order VA code; after the refund a replacement code is allowed", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const issued = await payWhole(guest, order.id, "va");
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const intentId = issued.body.data.id as string;
    const { rows } = await owner.query<{ provider_ref: string }>(
      "SELECT provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );

    // The code lapsed unconfirmed (superseded / timed out) before the money.
    await owner.query(
      "UPDATE payment_intents SET status='expired' WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );

    const held = await holdGatewayAmountMismatch(
      fx.context,
      intentId,
      {
        providerRef: rows[0]!.provider_ref,
        paidAmountIdr: UNDERPAID_IDR,
        source: "webhook",
      },
      new Date(),
    );
    expect(held.intentStatus).toBe("failed");
    expect(await unallocatedFunds(fx, intentId)).toHaveLength(1);
    expectFundsUnresolved(await payWhole(guest, order.id, "va"));

    await resolveFunds(intentId);
    const again = await payWhole(guest, order.id, "va");
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });
});
