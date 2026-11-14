// legend-y5d2r QRIS-DP: the customer display contract shows only the amount
// still payable after reservation credit and captured tenders. Total is gross
// invoice value, never the amount to charge a second time.
import { describe, expect, it } from "vitest";
import { customerDisplayStateSchema, posFixtureIds } from "@starter/shared/pos";

function display(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: posFixtureIds.tenantId,
    outletId: posFixtureIds.outletId,
    terminalDeviceId: posFixtureIds.devices.pos1,
    displayDeviceId: posFixtureIds.devices.display,
    state: "awaiting_payment",
    promotions: [],
    pairingCode: null,
    orderId: posFixtureIds.orders.cashDineIn,
    orderNumber: "POS-0001",
    lines: [
      {
        name: "Pesanan",
        quantity: 1,
        unitPriceIdr: 100_000,
        lineTotalIdr: 100_000,
        note: null,
      },
    ],
    subtotalIdr: 100_000,
    discountIdr: 0,
    serviceChargeIdr: 0,
    taxIdr: 0,
    roundingIdr: 0,
    totalIdr: 100_000,
    qris: null,
    tenders: [],
    changeIdr: null,
    version: 1,
    updatedAt: "2026-11-12T03:00:00.000Z",
    ...overrides,
  };
}
const tender = (amountIdr: number) => ({
  method: "cash",
  amountIdr,
  reference: null,
});
const qris = (amountIdr: number) => ({
  provider: "doit",
  amountIdr,
  payload: "00020101021226TESTCUSTOMERDISPLAY",
  expiresAt: "2026-11-12T03:10:00.000Z",
});

describe("legend-y5d2r customer display remaining invoice", () => {
  it("QRIS-DP-01 accepts only remaining amount after DP and captured tenders", () => {
    const parsed = customerDisplayStateSchema.safeParse(
      display({
        depositAppliedIdr: 20_000,
        remainingIdr: 50_000,
        tenders: [tender(30_000)],
        qris: qris(50_000),
      }),
    );
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(
      true,
    );
  });
  it("QRIS-DP-02 refuses gross invoice QRIS after part was already paid", () => {
    expect(
      customerDisplayStateSchema.safeParse(
        display({ tenders: [tender(30_000)], qris: qris(100_000) }),
      ).success,
    ).toBe(false);
  });
  it("QRIS-DP-03 accepts a fully DP-funded paid invoice without another tender", () => {
    const parsed = customerDisplayStateSchema.safeParse(
      display({ state: "paid", depositAppliedIdr: 100_000, remainingIdr: 0 }),
    );
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(
      true,
    );
  });
  it("QRIS-DP-04 refuses paid state until all invoice value is covered", () => {
    expect(
      customerDisplayStateSchema.safeParse(
        display({ state: "paid", tenders: [tender(1)] }),
      ).success,
    ).toBe(false);
  });
  it("QRIS-DP-05 refuses captured payment beyond the invoice value", () => {
    expect(
      customerDisplayStateSchema.safeParse(
        display({ state: "paid", tenders: [tender(100_001)] }),
      ).success,
    ).toBe(false);
  });
  it("QRIS-DP-06 keeps a full QRIS valid when there is no DP or captured payment", () => {
    expect(
      customerDisplayStateSchema.safeParse(display({ qris: qris(100_000) }))
        .success,
    ).toBe(true);
  });
  it("QRIS-DP-07 derives legacy remaining balance and rejects a forged remainder", () => {
    const parsed = customerDisplayStateSchema.parse(
      display({ qris: qris(100_000) }),
    );
    expect(parsed).toMatchObject({
      depositAppliedIdr: 0,
      remainingIdr: 100_000,
    });
    expect(
      customerDisplayStateSchema.safeParse(
        display({ depositAppliedIdr: 20_000, remainingIdr: 1 }),
      ).success,
    ).toBe(false);
  });
  it("QRIS-DP-08 rejects negative or excessive DP and double-counted coverage", () => {
    for (const overrides of [
      { depositAppliedIdr: -1 },
      { depositAppliedIdr: 100_001 },
      { depositAppliedIdr: 70_000, tenders: [tender(30_001)] },
    ])
      expect(
        customerDisplayStateSchema.safeParse(display(overrides)).success,
      ).toBe(false);
  });
});
