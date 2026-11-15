// SO-896 (legend-o6q8i): the POS tender path refuses a new cash or QR tender
// while ANY intent of the bill still holds the guest's money parked open.
// After a manager force release the QR tender is voided and the hold closed,
// so the old checks (active hold, captured tenders) see a free bill; a late
// verified payment is then parked (not applied) and the guest has paid once
// already. Another tender before the money is refunded or credited would be a
// second payment. 409 FUNDS_UNRESOLVED until the funds are resolved.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  payNotice,
  readBill,
  requestQris,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { BILL_IDR, releaseKit } from "./qris-hold-so885-d-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so896-pos-open-funds");
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
});

function expectUnresolved(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(JSON.stringify(response.body)).toContain("FUNDS_UNRESOLVED");
}

async function cash(orderId: string) {
  const bill = await readBill(fx, orderId);
  return fx.tender(orderId, bill.status, "cash", BILL_IDR);
}

describe("SO-896 POS tender with the guest's released QR money parked open", () => {
  it("force release, late paid webhook parked: cash and a new QR are refused; once resolved both are accepted", async () => {
    const { orderId, qr } = await kit.forceRelease({ rawStatus: "01" });
    // The guest pays the released code after all: parked, never applied.
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
    expect(await capturedIdr(fx, orderId)).toBe(0);
    expect((await tenderStatuses(fx, orderId)).map((t) => t.status)).toEqual([
      "voided",
    ]);

    expectUnresolved(await cash(orderId));
    expectUnresolved(await requestQris(fx, orderId));
    expect(
      (await tenderStatuses(fx, orderId)).map((t) => t.status),
      "no tender was added",
    ).toEqual(["voided"]);

    // The money is refunded / credited: the bill can be paid again.
    await owner.query(
      `UPDATE payment_unallocated_funds
          SET resolution='refund', resolved_by='test', resolved_at=now()
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    );
    const paid = await cash(orderId);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await capturedIdr(fx, orderId)).toBe(BILL_IDR);
  });

  it("the QR route is accepted after resolution as well", async () => {
    const { orderId, qr } = await kit.forceRelease({ rawStatus: "01" });
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      new Date(),
      qr.providerRef!,
    ).catch(() => null);
    expectUnresolved(await requestQris(fx, orderId));
    await owner.query(
      `UPDATE payment_unallocated_funds
          SET resolution='refund', resolved_by='test', resolved_at=now()
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    );
    const reopened = await requestQris(fx, orderId);
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(201);
  });

  it("control: a force released bill with no parked money still takes cash", async () => {
    const { orderId } = await kit.forceRelease({ rawStatus: "01" });
    const paid = await cash(orderId);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  });
});
