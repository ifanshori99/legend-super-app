// legend-vet9d (part A): shared contract of the DP buckets in the end-of-day
// recap. DP is a liability, never a tender: the recap carries it in
// depositApplied / depositRefunded beside the tender rows.
// Run: LEGEND_TEST_FILES="src/test/pos-vet9d-recap-contract.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import {
  POS_TENDER_METHODS,
  cafeLegendPosFixtures,
  endOfDayBlindRecapSchema,
  endOfDayRecapSchema,
} from "@starter/shared/pos";

type Raw = Record<string, unknown>;

const base = (): Raw =>
  structuredClone(cafeLegendPosFixtures.endOfDay) as unknown as Raw;
const devicesOf = (raw: Raw) => raw.devices as Raw[];

/** Device 0 sells 50_000 of its 306_400 with DP: tender net drops by 50_000. */
const withDeposit = (): Raw => {
  const raw = base();
  devicesOf(raw)[0].depositAppliedIdr = 50_000;
  devicesOf(raw)[0].depositRefundedIdr = 20_000;
  raw.totalDepositAppliedIdr = 50_000;
  raw.totalDepositRefundedIdr = 20_000;
  // cash captured 187_500 -> 137_500: net 110_100 -> 60_100
  const cash = (raw.tenders as Raw[])[0];
  cash.capturedIdr = 137_500;
  cash.netIdr = 60_100;
  return raw;
};

const blindOf = (raw: Raw): Raw => ({
  ...raw,
  devices: devicesOf(raw).map((device, index) => ({
    ...device,
    cashVarianceIdr: index === 0 ? null : device.cashVarianceIdr,
    expiredCashOutIdr: index === 0 ? null : 0,
  })),
  tenders: POS_TENDER_METHODS.map((method) => ({
    method,
    capturedIdr: null,
    refundedIdr: null,
    netIdr: null,
  })),
  totalVarianceIdr: null,
  totalExpiredCashOutIdr: null,
  drawerFiguresHidden: true,
});

describe("legend-vet9d recap contract: DP buckets", () => {
  it("an old payload without the DP fields parses as 0", () => {
    const old = base();
    for (const device of devicesOf(old)) {
      delete device.depositAppliedIdr;
      delete device.depositRefundedIdr;
    }
    delete old.totalDepositAppliedIdr;
    delete old.totalDepositRefundedIdr;
    const recap = endOfDayRecapSchema.parse(old);
    expect(recap.totalDepositAppliedIdr).toBe(0);
    expect(recap.totalDepositRefundedIdr).toBe(0);
    for (const device of recap.devices) {
      expect(device.depositAppliedIdr).toBe(0);
      expect(device.depositRefundedIdr).toBe(0);
    }
  });

  it("the fixture parses with the DP fields at 0", () => {
    const recap = endOfDayRecapSchema.parse(base());
    expect(recap.totalDepositAppliedIdr).toBe(0);
    expect(recap.totalDepositRefundedIdr).toBe(0);
  });

  it("a device DP above its total rejects", () => {
    const raw = base();
    devicesOf(raw)[1].depositAppliedIdr = 1; // device 1 total is 0
    raw.totalDepositAppliedIdr = 1;
    expect(endOfDayRecapSchema.safeParse(raw).success).toBe(false);
  });

  it("totals that differ from the device sums reject", () => {
    const applied = withDeposit();
    applied.totalDepositAppliedIdr = 40_000;
    expect(endOfDayRecapSchema.safeParse(applied).success).toBe(false);
    const refunded = withDeposit();
    refunded.totalDepositRefundedIdr = 0;
    expect(endOfDayRecapSchema.safeParse(refunded).success).toBe(false);
  });

  it("the tender identity balances with DP: net = sales - DP - refunds - voids", () => {
    const recap = endOfDayRecapSchema.parse(withDeposit());
    expect(recap.totalDepositAppliedIdr).toBe(50_000);
    expect(recap.totalDepositRefundedIdr).toBe(20_000);
    // The DP refund bucket is not part of the tender identity.
    expect(recap.totalRefundsIdr).toBe(31_900);
  });

  it("DP applied without the matching tender drop rejects", () => {
    const raw = withDeposit();
    const cash = (raw.tenders as Raw[])[0];
    cash.capturedIdr = 187_500;
    cash.netIdr = 110_100;
    expect(endOfDayRecapSchema.safeParse(raw).success).toBe(false);
  });

  it("the blind recap parses with the DP fields and keeps them visible", () => {
    const blind = endOfDayBlindRecapSchema.parse(blindOf(withDeposit()));
    expect(blind.totalDepositAppliedIdr).toBe(50_000);
    expect(blind.totalDepositRefundedIdr).toBe(20_000);
    expect(blind.devices[0].depositAppliedIdr).toBe(50_000);
  });

  it("a blind payload without the DP fields parses as 0", () => {
    const old = blindOf(base());
    for (const device of old.devices as Raw[]) {
      delete device.depositAppliedIdr;
      delete device.depositRefundedIdr;
    }
    delete old.totalDepositAppliedIdr;
    delete old.totalDepositRefundedIdr;
    const blind = endOfDayBlindRecapSchema.parse(old);
    expect(blind.totalDepositAppliedIdr).toBe(0);
    expect(blind.totalDepositRefundedIdr).toBe(0);
  });

  it("a blind recap whose DP totals differ from its devices rejects", () => {
    const raw = blindOf(withDeposit());
    raw.totalDepositAppliedIdr = 10;
    expect(endOfDayBlindRecapSchema.safeParse(raw).success).toBe(false);
  });
});
