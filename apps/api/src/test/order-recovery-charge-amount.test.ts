// legend-i83ls (S1, pure): `recoveryChargeSplit` and `lineShareSplit`, the
// amount a guest owes for a dearer swap. Contract: scratchpad design-B.md.
//
// Rule: service and PBJT of an order are computed on `subtotal - discount`, so
// the effective rate is `service / base` and `pbjt / base` with
// `base = subtotal - discount`. The price difference D pays that rate in full
// (CTO default: the order's discount does not cut D): service = D * service /
// base, pbjt = D * pbjt / base, half up (BigInt). base <= 0 (full discount):
// service = pbjt = 0. No deposit, no clamp to the subtotal.
// - Exclusive prices: gross = D, amount = D + service + pbjt.
// - Inclusive prices (pricesIncludeTax): D already holds the taxes, so amount =
//   D and gross = D - service - pbjt; a negative gross (rounding) is taken from
//   PBJT first, then from service. amount = gross + service + pbjt, exactly.
// - A non-positive D or subtotal is all zero (differenceIdr clamps to 0).

import { describe, expect, it } from "vitest";
import { OrderRevenueMismatch } from "../services/order-revenue.ts";
import {
  lineShareSplit,
  recoveryChargeSplit,
  recoveryRefundSplit,
} from "../services/order-recovery-refund-amount.ts";

type OrderInput = Parameters<typeof recoveryChargeSplit>[0]["order"];

/** An order row whose amounts satisfy the identity of its tax mode. */
function makeOrder(input: {
  subtotal: number;
  discount?: number;
  service?: number;
  tax?: number;
  rounding?: number;
  inclusive?: boolean;
}): OrderInput {
  const discount = input.discount ?? 0;
  const service = input.service ?? 0;
  const tax = input.tax ?? 0;
  const rounding = input.rounding ?? 0;
  const inclusive = input.inclusive ?? false;
  return {
    subtotalIdr: input.subtotal,
    discountIdr: discount,
    serviceChargeIdr: service,
    taxIdr: tax,
    roundingIdr: rounding,
    totalIdr: inclusive
      ? input.subtotal - discount + rounding
      : input.subtotal - discount + service + tax + rounding,
    pricesIncludeTax: inclusive,
  };
}

/** Subtotal 100.000, service 5% = 5.000, PBJT 10.500. */
const BASE_ORDER = makeOrder({
  subtotal: 100_000,
  service: 5_000,
  tax: 10_500,
});

const ZERO = {
  differenceIdr: 0,
  grossSalesIdr: 0,
  serviceChargeIdr: 0,
  pbjtIdr: 0,
  amountIdr: 0,
};

describe("legend-i83ls recoveryChargeSplit: selisih + service + PBJT pro rata", () => {
  it("selisih 7.000 dari 100.000 -> gross 7.000, service 350, pbjt 735, amount 8.085", () => {
    expect(
      recoveryChargeSplit({ order: BASE_ORDER, differenceIdr: 7_000 }),
    ).toEqual({
      differenceIdr: 7_000,
      grossSalesIdr: 7_000,
      serviceChargeIdr: 350,
      pbjtIdr: 735,
      amountIdr: 8_085,
    });
  });

  it("amount = gross + service + pbjt tepat, tanpa pembulatan kas order", () => {
    const order = makeOrder({
      subtotal: 100_000,
      service: 5_000,
      tax: 10_500,
      rounding: 500,
    });
    const split = recoveryChargeSplit({ order, differenceIdr: 10_000 });
    expect(split.amountIdr).toBe(11_550);
    expect(split.amountIdr).toBe(
      split.grossSalesIdr + split.serviceChargeIdr + split.pbjtIdr,
    );
  });

  it("pembulatan half-up: service 0,5 -> 1 dan pbjt 1,05 -> 1 (selisih 10 dari 30.000)", () => {
    const order = makeOrder({ subtotal: 30_000, service: 1_500, tax: 3_150 });
    expect(recoveryChargeSplit({ order, differenceIdr: 10 })).toEqual({
      differenceIdr: 10,
      grossSalesIdr: 10,
      serviceChargeIdr: 1,
      pbjtIdr: 1,
      amountIdr: 12,
    });
  });

  it("pembulatan half-up: di bawah setengah dibulatkan turun (selisih 1 dari 30.000 -> amount 1)", () => {
    const order = makeOrder({ subtotal: 30_000, service: 1_500, tax: 3_150 });
    expect(recoveryChargeSplit({ order, differenceIdr: 1 })).toMatchObject({
      grossSalesIdr: 1,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      amountIdr: 1,
    });
  });

  it("diskon 50%: tarif efektif dipakai penuh (service dan pbjt dari subtotal - diskon)", () => {
    // base 50.000, service 2.500 (5%), PBJT 5.250 (10,5%): same effective rates.
    const half = makeOrder({
      subtotal: 100_000,
      discount: 50_000,
      service: 2_500,
      tax: 5_250,
    });
    expect(recoveryChargeSplit({ order: half, differenceIdr: 7_000 })).toEqual({
      differenceIdr: 7_000,
      grossSalesIdr: 7_000,
      serviceChargeIdr: 350,
      pbjtIdr: 735,
      amountIdr: 8_085,
    });
  });

  it("diskon 10%: service dan pbjt dibagi dengan subtotal - diskon, half up", () => {
    // base 90.000: service 4.500, PBJT 9.450; D 7.000 -> 350 and 735.
    const order = makeOrder({
      subtotal: 100_000,
      discount: 10_000,
      service: 4_500,
      tax: 9_450,
    });
    expect(recoveryChargeSplit({ order, differenceIdr: 7_000 })).toEqual({
      differenceIdr: 7_000,
      grossSalesIdr: 7_000,
      serviceChargeIdr: 350,
      pbjtIdr: 735,
      amountIdr: 8_085,
    });
  });

  it("diskon penuh (base 0): service dan pbjt nol, amount = selisih", () => {
    const order = makeOrder({
      subtotal: 100_000,
      discount: 100_000,
      service: 5_000,
      tax: 10_500,
    });
    expect(recoveryChargeSplit({ order, differenceIdr: 7_000 })).toEqual({
      differenceIdr: 7_000,
      grossSalesIdr: 7_000,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      amountIdr: 7_000,
    });
  });

  it("diskon penuh tanpa service dan pajak: amount = selisih", () => {
    const order = makeOrder({ subtotal: 100_000, discount: 100_000 });
    expect(recoveryChargeSplit({ order, differenceIdr: 7_000 })).toMatchObject({
      grossSalesIdr: 7_000,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      amountIdr: 7_000,
    });
  });

  it("tanpa tarif service dan pajak: amount = selisih", () => {
    const order = makeOrder({ subtotal: 50_000 });
    expect(recoveryChargeSplit({ order, differenceIdr: 4_000 })).toEqual({
      differenceIdr: 4_000,
      grossSalesIdr: 4_000,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      amountIdr: 4_000,
    });
  });

  it("harga inklusif: selisih sudah memuat service dan pajak, amount = selisih", () => {
    // Subtotal 111.500 holds service 5.000 and PBJT 10.500: gross sales 96.000.
    const order = makeOrder({
      subtotal: 111_500,
      service: 5_000,
      tax: 10_500,
      inclusive: true,
    });
    expect(recoveryChargeSplit({ order, differenceIdr: 11_150 })).toEqual({
      differenceIdr: 11_150,
      grossSalesIdr: 9_600,
      serviceChargeIdr: 500,
      pbjtIdr: 1_050,
      amountIdr: 11_150,
    });
  });

  it("harga inklusif berdiskon: amount = selisih, pajak dari subtotal - diskon", () => {
    // Subtotal 111.500, discount 11.500: base 100.000 holds service 5.000 and
    // PBJT 10.500 (total 100.000).
    const order = makeOrder({
      subtotal: 111_500,
      discount: 11_500,
      service: 5_000,
      tax: 10_500,
      inclusive: true,
    });
    expect(recoveryChargeSplit({ order, differenceIdr: 10_000 })).toEqual({
      differenceIdr: 10_000,
      grossSalesIdr: 8_450,
      serviceChargeIdr: 500,
      pbjtIdr: 1_050,
      amountIdr: 10_000,
    });
  });

  it("harga inklusif: gross tidak negatif, kelebihan diambil dari pbjt dulu lalu service", () => {
    // base 2 holds service 1 and PBJT 1; D 1 rounds both up to 1 (sum 2 > D).
    const order = makeOrder({
      subtotal: 2,
      service: 1,
      tax: 1,
      inclusive: true,
    });
    expect(recoveryChargeSplit({ order, differenceIdr: 1 })).toEqual({
      differenceIdr: 1,
      grossSalesIdr: 0,
      serviceChargeIdr: 1,
      pbjtIdr: 0,
      amountIdr: 1,
    });
  });

  it("harga inklusif diskon penuh: amount = selisih, gross = selisih", () => {
    const order = makeOrder({
      subtotal: 111_500,
      discount: 111_500,
      service: 5_000,
      tax: 10_500,
      inclusive: true,
    });
    expect(recoveryChargeSplit({ order, differenceIdr: 5_000 })).toEqual({
      differenceIdr: 5_000,
      grossSalesIdr: 5_000,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      amountIdr: 5_000,
    });
  });

  it("selisih di atas subtotal berdiskon: tarif efektif penuh, tanpa clamp", () => {
    const half = makeOrder({
      subtotal: 100_000,
      discount: 50_000,
      service: 2_500,
      tax: 5_250,
    });
    expect(
      recoveryChargeSplit({ order: half, differenceIdr: 200_000 }),
    ).toEqual({
      differenceIdr: 200_000,
      grossSalesIdr: 200_000,
      serviceChargeIdr: 10_000,
      pbjtIdr: 21_000,
      amountIdr: 231_000,
    });
  });

  it("selisih di atas subtotal tidak dipotong ke subtotal", () => {
    expect(
      recoveryChargeSplit({ order: BASE_ORDER, differenceIdr: 200_000 }),
    ).toEqual({
      differenceIdr: 200_000,
      grossSalesIdr: 200_000,
      serviceChargeIdr: 10_000,
      pbjtIdr: 21_000,
      amountIdr: 231_000,
    });
  });

  it("identitas amount = gross + service + pbjt dan tanpa komponen negatif untuk banyak selisih", () => {
    const order = makeOrder({ subtotal: 78_000, service: 3_900, tax: 8_190 });
    for (const difference of [
      1, 2, 3, 7, 99, 100, 333, 1_000, 6_999, 7_000, 12_345, 77_999, 78_000,
      123_457,
    ]) {
      const split = recoveryChargeSplit({ order, differenceIdr: difference });
      expect(split.amountIdr).toBe(
        split.grossSalesIdr + split.serviceChargeIdr + split.pbjtIdr,
      );
      expect(split.grossSalesIdr).toBe(difference);
      expect(split.serviceChargeIdr).toBeGreaterThanOrEqual(0);
      expect(split.pbjtIdr).toBeGreaterThanOrEqual(0);
    }
  });

  it("tanpa float: nilai besar tetap tepat", () => {
    const order = makeOrder({
      subtotal: 9_007_199_254_740_000,
      service: 450_359_962_737_000,
      tax: 945_755_921_747_700,
    });
    const split = recoveryChargeSplit({
      order,
      differenceIdr: 9_007_199_254_740,
    });
    // s = 1/1000 exactly.
    expect(split).toEqual({
      differenceIdr: 9_007_199_254_740,
      grossSalesIdr: 9_007_199_254_740,
      serviceChargeIdr: 450_359_962_737,
      pbjtIdr: 945_755_921_748,
      amountIdr: 10_403_315_139_225,
    });
  });
});

describe("legend-i83ls recoveryChargeSplit: nol dan order rusak", () => {
  it("selisih 0 atau negatif -> semua nol", () => {
    expect(
      recoveryChargeSplit({ order: BASE_ORDER, differenceIdr: 0 }),
    ).toEqual(ZERO);
    expect(
      recoveryChargeSplit({ order: BASE_ORDER, differenceIdr: -5_000 }),
    ).toEqual(ZERO);
  });

  it("subtotal 0 -> semua nol, order tidak dibaca", () => {
    const order = makeOrder({ subtotal: 0 });
    expect(recoveryChargeSplit({ order, differenceIdr: 7_000 })).toEqual({
      ...ZERO,
      differenceIdr: 7_000,
    });
  });

  it("order yang gagal identitas pajaknya melempar OrderRevenueMismatch", () => {
    const broken = { ...BASE_ORDER, totalIdr: BASE_ORDER.totalIdr + 1 };
    expect(() =>
      recoveryChargeSplit({ order: broken, differenceIdr: 7_000 }),
    ).toThrow(OrderRevenueMismatch);
  });
});

describe("legend-i83ls lineShareSplit", () => {
  it("memotong dasar ke subtotal (satu baris tidak lebih berat dari ordernya)", () => {
    expect(lineShareSplit(BASE_ORDER, 200_000)).toEqual({
      grossSalesIdr: 100_000,
      discountIdr: 0,
      serviceChargeIdr: 5_000,
      pbjtIdr: 10_500,
    });
  });

  it("membawa porsi diskon order (dipakai refund)", () => {
    const order = makeOrder({
      subtotal: 100_000,
      discount: 10_000,
      service: 5_000,
      tax: 10_500,
    });
    expect(lineShareSplit(order, 40_000)).toEqual({
      grossSalesIdr: 40_000,
      discountIdr: 4_000,
      serviceChargeIdr: 2_000,
      pbjtIdr: 4_200,
    });
  });

  it("dasar atau subtotal tidak positif -> nol tanpa membaca identitas order", () => {
    const zero = {
      grossSalesIdr: 0,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
    };
    const broken = { ...BASE_ORDER, totalIdr: 1 };
    expect(lineShareSplit(broken, 0)).toEqual(zero);
    expect(lineShareSplit(makeOrder({ subtotal: 0 }), 5_000)).toEqual(zero);
  });

  it("refund tidak berubah: baris 40.000 dari 100.000 -> wanted 46.200", () => {
    expect(
      recoveryRefundSplit({
        order: { ...BASE_ORDER, depositAppliedIdr: 0 },
        lineTotalIdr: 40_000,
        releasedIdr: 0,
      }),
    ).toMatchObject({ wantedIdr: 46_200, amountIdr: 46_200, shortfallIdr: 0 });
  });
});
