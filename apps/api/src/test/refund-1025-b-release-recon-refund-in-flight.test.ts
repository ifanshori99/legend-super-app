// legend-gjt5q (brief 1025 card B, architect round 2): the QRIS release
// reconciliation worker (SO-885 D) reads the provider's answer for a force
// released QR. When the provider answers `refunded` while a refund of OUR side
// is still in flight on the intent, the full-refund write is held back
// (refund_in_flight). The worker must not lose what it learned meanwhile:
//  - extra payments of the intent (other provider transactions recorded as
//    evidence) are still parked as unallocated funds,
//  - the reconciliation row is NOT closed: it stays open (the money is not
//    settled yet), so it keeps being checked,
//  - no payment_provider_refunds row is written yet and our refund is left
//    as it is.
// Written from the SO-885 D fixtures (qris-hold-so885-d-helpers.ts), not from
// the implementation. Assumptions: "still open" = reconciliation row status
// `open` / not resolved; "parked" = a payment_unallocated_funds row for the
// extra evidence; the exact warning alert text is not asserted.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025-b-release-recon-refund-in-flight.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  refundsOfIntent,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import {
  hoursAfter,
  reconRows,
  releaseKit,
  runRecon,
} from "./qris-hold-so885-d-helpers.ts";
import {
  setPaymentGateway,
  type GatewayPaymentStatus,
} from "../services/payment-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const EXTRA_IDR = 20_000;
const OURS_IDR = 10_000;

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
const refundedRefs = new Set<string>();
/** Extra provider transactions the provider lists with the code's status. */
const extrasByRef = new Map<
  string,
  NonNullable<GatewayPaymentStatus["extraPayments"]>
>();

beforeAll(async () => {
  fx = await holdFixture("refund-1025-b-release-recon");
  const read = fx.gateway.getStatus.bind(fx.gateway);
  fx.gateway.getStatus = async (input) => {
    const extras = extrasByRef.get(input.providerRef);
    const base: GatewayPaymentStatus = refundedRefs.has(input.providerRef)
      ? {
          status: "failed",
          rawStatus: "refunded",
          providerRef: input.providerRef,
          amountIdr: null,
        }
      : await read(input);
    return extras ? { ...base, extraPayments: extras } : base;
  };
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
});
afterAll(async () => {
  refundedRefs.clear();
  extrasByRef.clear();
  resetHoldPorts();
  await owner.end();
});

async function providerRefundRows(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

describe("1025-B-R refund in flight when the release reconciliation reads `refunded`", () => {
  it("1025-B-R1 extra payments are still parked, the row stays open, no provider refund row, our refund untouched", async () => {
    const { qr, releasedAt } = await kit.forceRelease({ rawStatus: "01" });
    const [open] = await reconRows(fx, qr.intentId);
    expect(open?.status).toBe("open");

    // The provider lists an extra transaction of the code with its status
    // (the way parkExtraPayments learns about it).
    extrasByRef.set(qr.providerRef!, [
      { providerRef: `EXTRA-${randomUUID()}`, amountIdr: EXTRA_IDR },
    ]);
    expect(await unallocatedFunds(fx, qr.intentId), "not parked yet").toEqual(
      [],
    );
    // A refund of ours is approved and being sent (attempted, no final answer).
    await owner.query(
      `INSERT INTO payment_refunds
         (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
          requested_by, approved_by, decided_at, provider_ref, payout_attempts)
       VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana', 'approved', 'requester', 'approver', now(), NULL, 1)`,
      [
        randomUUID(),
        fx.tenant.tenantId,
        fx.tenant.outletId,
        qr.intentId,
        OURS_IDR,
      ],
    );
    const refundsBefore = await refundsOfIntent(fx, qr.intentId);

    // The provider now says the code was refunded.
    refundedRefs.add(qr.providerRef!);
    await runRecon(fx, hoursAfter(releasedAt, 2));
    await runRecon(fx, hoursAfter(releasedAt, 3));

    const funds = await unallocatedFunds(fx, qr.intentId);
    expect(
      funds.map((f) => f.amountIdr),
      "the extra payment is parked, once",
    ).toEqual([EXTRA_IDR]);
    const [row] = await reconRows(fx, qr.intentId);
    expect(row?.status, "reconciliation stays open").toBe("open");
    expect(row?.resolved_at).toBeNull();
    expect(
      await providerRefundRows(qr.intentId),
      "the full-refund write waits for our refund",
    ).toBe(0);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual(refundsBefore);
  });
});
