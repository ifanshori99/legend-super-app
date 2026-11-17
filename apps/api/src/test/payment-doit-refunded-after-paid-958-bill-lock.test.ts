// legend-7uqbs, architect r1 P1-2 (brief 958): a parked fund the provider
// already refunded must not lock the POS bill forever. The money went back to
// the guest, staff cannot resolve it (409 PROVIDER_REFUNDED, no payout path),
// so if it counted as "open funds" no cash, QRIS, points or new code would ever
// be accepted on the bill again.
//
// Written from the architect finding and the SO-896 contract (a parked, open
// fund blocks a new tender with 409 FUNDS_UNRESOLVED), not from the
// implementation. Failing first: today the flagged fund still blocks.
//
// Assumptions:
//  - "Provider refunded" is simulated with direct DB state: the fund's own
//    flag column `payment_unallocated_funds.provider_refunded_at` (named in
//    the finding) set to now(). Nothing else changes (resolution stays null).
//  - Accepted means the same 201 the SO-896 tests get after a resolution.
//  - (P2-b, live code) a guest's FAILED-and-final VA code with a parked fund
//    that the provider refunded must not make the order look like it still has
//    a live/open code: a new guest payment code is accepted (201). Setup: VA
//    code issued, applyGatewayFailure(failed), a different-amount payment is
//    parked through holdGatewayAmountMismatch (pattern of
//    qris-hold-so896-poll-failed.test.ts), the code is made final
//    (provider_final_at), then the fund is flagged by direct DB state. The
//    unflagged control is refused with 409 FUNDS_UNRESOLVED.
//  - Control (passes before the fix): a parked fund that is NOT flagged still
//    blocks both cash and a new QRIS with 409 FUNDS_UNRESOLVED.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-doit-refunded-after-paid-958-bill-lock.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyGatewayFailure,
  holdGatewayAmountMismatch,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  payNotice,
  readBill,
  requestQris,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { BILL_IDR, releaseKit } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("doit-refunded-after-paid-958-bill-lock");
  enableVaBank(fx.gateway);
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function cash(orderId: string) {
  const bill = await readBill(fx, orderId);
  return fx.tender(orderId, bill.status, "cash", BILL_IDR);
}

/** Force release, then the guest's released code is paid late: money parked. */
async function billWithParkedFund() {
  const { orderId, qr } = await kit.forceRelease({ rawStatus: "01" });
  await payNotice(fx, qr.intentId, BILL_IDR, new Date(), qr.providerRef!).catch(
    () => null,
  );
  const parked = await unallocatedFunds(fx, qr.intentId);
  expect(parked.map((p) => [p.amountIdr, p.resolution])).toEqual([
    [BILL_IDR, null],
  ]);
  return { orderId, qr };
}

async function providerRefundedFund(intentId: string) {
  await owner.query(
    `UPDATE payment_unallocated_funds
        SET provider_refunded_at = now()
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [fx.tenant.tenantId, intentId],
  );
}

function expectUnresolved(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(JSON.stringify(response.body)).toContain("FUNDS_UNRESOLVED");
}

describe("958-p1-2 a parked fund the provider already refunded does not lock the POS bill", () => {
  it("958-p1-2 cash is accepted on a bill whose parked fund the provider refunded", async () => {
    const { orderId, qr } = await billWithParkedFund();
    await providerRefundedFund(qr.intentId);
    const paid = await cash(orderId);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await capturedIdr(fx, orderId)).toBe(BILL_IDR);
  });

  it("958-p1-2 a new QRIS code is accepted on a bill whose parked fund the provider refunded", async () => {
    const { orderId, qr } = await billWithParkedFund();
    await providerRefundedFund(qr.intentId);
    const reopened = await requestQris(fx, orderId);
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(201);
  });

  it("958-p1-2 control: an unflagged parked fund still blocks cash and a new QRIS (409 FUNDS_UNRESOLVED)", async () => {
    const { orderId } = await billWithParkedFund();
    expectUnresolved(await cash(orderId));
    expectUnresolved(await requestQris(fx, orderId));
    expect(await capturedIdr(fx, orderId)).toBe(0);
  });

  it("958-p1-2 a flagged fund beside an unflagged open fund of the same bill still blocks (only the refunded money is released)", async () => {
    const { orderId, qr } = await billWithParkedFund();
    // A second, different payment of the same code parks too (other provider
    // reference, other amount), through the same service path as p2-b.
    await holdGatewayAmountMismatch(
      fx.context,
      qr.intentId,
      {
        providerRef: `OTHER-${qr.providerRef}-${randomUUID().slice(0, 8)}`,
        paidAmountIdr: 10_000,
        source: "webhook",
      },
      new Date(),
    );
    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked.length, "two funds parked").toBeGreaterThanOrEqual(2);
    expect(parked.every((fund) => fund.resolution === null)).toBe(true);
    await owner.query(
      `UPDATE payment_unallocated_funds SET provider_refunded_at = now()
        WHERE id = (SELECT id FROM payment_unallocated_funds
                     WHERE tenant_id = $1 AND payment_intent_id = $2
                     ORDER BY created_at, id LIMIT 1)`,
      [fx.tenant.tenantId, qr.intentId],
    );
    expectUnresolved(await cash(orderId));
    expect(await capturedIdr(fx, orderId), "nothing captured").toBe(0);
  });
});

describe("958-p2-b a failed code with a provider-refunded parked fund does not block a new guest code", () => {
  async function failedVaCodeWithParkedFund() {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const created = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const { rows } = await owner.query<{ provider_ref: string }>(
      "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, intentId],
    );
    // The code failed, then a payment of another amount arrived: parked
    // (working pattern of qris-hold-so896-poll-failed.test.ts).
    await applyGatewayFailure(
      fx.context,
      intentId,
      "failed",
      new Date(),
      undefined,
    );
    const held = await holdGatewayAmountMismatch(
      fx.context,
      intentId,
      {
        providerRef: `${rows[0]!.provider_ref}-paid-${randomUUID().slice(0, 8)}`,
        paidAmountIdr: 10_000,
        source: "webhook",
      },
      new Date(),
    );
    expect(held.intentStatus).toBe("failed");
    const parked = await unallocatedFunds(fx, intentId);
    expect(parked, "late money parked").toHaveLength(1);
    expect(parked[0]!.resolution).toBeNull();
    // The provider declared the code dead: only the parked money can block.
    await owner.query(
      `UPDATE payment_intents SET provider_final_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [fx.tenant.tenantId, intentId],
    );
    return { guest, order, intentId };
  }

  const newCodeFor = (
    guest: Awaited<ReturnType<typeof fx.newGuest>>,
    orderId: string,
  ) =>
    fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });

  it("958-p2-b control: an unflagged parked fund on a failed code still refuses a new guest code (409)", async () => {
    const { guest, order } = await failedVaCodeWithParkedFund();
    const refused = await newCodeFor(guest, order.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("FUNDS_UNRESOLVED");
  });

  it("958-p2-b a provider-refunded parked fund on a failed code does not make the order look open: a new guest code is accepted", async () => {
    const { guest, order, intentId } = await failedVaCodeWithParkedFund();
    await providerRefundedFund(intentId);
    const accepted = await newCodeFor(guest, order.id);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });
});
