// legend-94q2l (T1, pure): `recoveryRefundSplit`, the refund amount of one failed
// order line (ORD-09, manual refund). Contract: docs/briefs/94q2l-impl-brief.md.
//
// Pro-rata rule (CTO decision): s = lineTotalIdr / subtotalIdr; gross, discount,
// service and PBJT of the order are each multiplied by s and rounded half-up.
// wanted = gross - discount + service + pbjt (the order's cash rounding is not
// part of it). room = max(0, (total - depositApplied) - released);
// amount = min(wanted, room); shortfall = wanted - amount. A cut amount scales
// discount, service and PBJT by amount / wanted (half-up) and gross is the rest,
// so gross - discount + service + pbjt = amount and no component is negative.
//
// Assumptions where the brief is silent:
// - Inclusive-price orders (pricesIncludeTax) use `orderRevenueSplit` gross
//   (subtotal - service - tax), as the brief says "dari orderRevenueSplit".
// - A line total above the subtotal is not tested (undefined by the brief).
// - Half-up on a positive value: floor(x + 1/2); ties go up.

import { describe, expect, it } from "vitest";
import { recoveryRefundSplit } from "../services/order-recovery-refund-amount.ts";

type OrderInput = Parameters<typeof recoveryRefundSplit>[0]["order"];

/** An order row whose amounts satisfy the identity of its tax mode. */
function makeOrder(input: {
  subtotal: number;
  discount?: number;
  service?: number;
  tax?: number;
  rounding?: number;
  deposit?: number;
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
    depositAppliedIdr: input.deposit ?? 0,
  };
}

/** Brief example: subtotal 100.000, service 5% = 5.000, PBJT 10% = 10.500. */
const BRIEF_ORDER = makeOrder({
  subtotal: 100_000,
  service: 5_000,
  tax: 10_500,
});

const ZERO = {
  wantedIdr: 0,
  amountIdr: 0,
  shortfallIdr: 0,
  grossSalesIdr: 0,
  discountIdr: 0,
  serviceChargeIdr: 0,
  pbjtIdr: 0,
};

describe("legend-94q2l recoveryRefundSplit: pro-rata tanpa pemotongan", () => {
  it("contoh brief: baris 40.000 dari 100.000 -> gross 40.000, service 2.000, pbjt 4.200, wanted 46.200", () => {
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        releasedIdr: 0,
      }),
    ).toEqual({
      wantedIdr: 46_200,
      amountIdr: 46_200,
      shortfallIdr: 0,
      grossSalesIdr: 40_000,
      discountIdr: 0,
      serviceChargeIdr: 2_000,
      pbjtIdr: 4_200,
    });
  });

  it("baris sama dengan subtotal: wanted = total order, tanpa selisih pembulatan", () => {
    const result = recoveryRefundSplit({
      order: BRIEF_ORDER,
      lineTotalIdr: 100_000,
      releasedIdr: 0,
    });
    expect(result).toMatchObject({
      wantedIdr: 115_500,
      amountIdr: 115_500,
      shortfallIdr: 0,
      grossSalesIdr: 100_000,
      serviceChargeIdr: 5_000,
      pbjtIdr: 10_500,
    });
  });

  it("pembulatan kas order tidak ikut wanted, tetapi ikut room", () => {
    // total = 115.550 (rounding +50): the whole order refunds 115.500, not 115.550.
    const order = makeOrder({
      subtotal: 100_000,
      service: 5_000,
      tax: 10_500,
      rounding: 50,
    });
    expect(order.totalIdr).toBe(115_550);
    expect(
      recoveryRefundSplit({ order, lineTotalIdr: 100_000, releasedIdr: 0 }),
    ).toMatchObject({
      wantedIdr: 115_500,
      amountIdr: 115_500,
      shortfallIdr: 0,
    });
    // Room counts the cash rounding: 115.550 - 115.500 released leaves 50,
    // which does not matter for a line whose wanted is smaller.
    expect(
      recoveryRefundSplit({
        order,
        lineTotalIdr: 100_000,
        releasedIdr: 115_500,
      }),
    ).toMatchObject({
      wantedIdr: 115_500,
      amountIdr: 50,
      shortfallIdr: 115_450,
    });
  });

  it("diskon order ikut pro-rata: gross, diskon, service dan pbjt dikali s", () => {
    // 100.000 - 10.000 = 90.000; service 5% = 4.500; PBJT 10% of 94.500 = 9.450.
    const order = makeOrder({
      subtotal: 100_000,
      discount: 10_000,
      service: 4_500,
      tax: 9_450,
    });
    expect(order.totalIdr).toBe(103_950);
    expect(
      recoveryRefundSplit({ order, lineTotalIdr: 50_000, releasedIdr: 0 }),
    ).toEqual({
      wantedIdr: 51_975,
      amountIdr: 51_975,
      shortfallIdr: 0,
      grossSalesIdr: 50_000,
      discountIdr: 5_000,
      serviceChargeIdr: 2_250,
      pbjtIdr: 4_725,
    });
  });

  it("harga inklusif pajak: gross = subtotal - service - pajak, wanted = harga baris", () => {
    // Inclusive: total = subtotal = 100.000; gross base 100.000 - 5.000 - 9.091 = 85.909.
    const order = makeOrder({
      subtotal: 100_000,
      service: 5_000,
      tax: 9_091,
      inclusive: true,
    });
    expect(order.totalIdr).toBe(100_000);
    expect(
      recoveryRefundSplit({ order, lineTotalIdr: 40_000, releasedIdr: 0 }),
    ).toEqual({
      wantedIdr: 40_000,
      amountIdr: 40_000,
      shortfallIdr: 0,
      grossSalesIdr: 34_364, // 34.363,6 half-up
      discountIdr: 0,
      serviceChargeIdr: 2_000,
      pbjtIdr: 3_636, // 3.636,4 half-up
    });
  });
});

describe("legend-94q2l recoveryRefundSplit: pembulatan half-up", () => {
  it("tepat setengah dibulatkan ke atas, di bawah setengah ke bawah", () => {
    // s = 1000 / 6000 = 1/6. service 3 -> 0,5 -> 1; service 2 -> 0,333 -> 0.
    const tie = recoveryRefundSplit({
      order: makeOrder({ subtotal: 6_000, service: 3 }),
      lineTotalIdr: 1_000,
      releasedIdr: 0,
    });
    expect(tie).toMatchObject({
      serviceChargeIdr: 1,
      grossSalesIdr: 1_000,
      wantedIdr: 1_001,
    });
    const below = recoveryRefundSplit({
      order: makeOrder({ subtotal: 6_000, service: 2 }),
      lineTotalIdr: 1_000,
      releasedIdr: 0,
    });
    expect(below).toMatchObject({ serviceChargeIdr: 0, wantedIdr: 1_000 });
  });

  it("pbjt 9 x 1/6 = 1,5 menjadi 2", () => {
    const result = recoveryRefundSplit({
      order: makeOrder({ subtotal: 6_000, tax: 9 }),
      lineTotalIdr: 1_000,
      releasedIdr: 0,
    });
    expect(result).toMatchObject({ pbjtIdr: 2, wantedIdr: 1_002 });
  });

  it("angka besar (perkalian melewati 2^53) tetap tepat", () => {
    // Done with BigInt in the contract: component * line overflows a double.
    const subtotal = 9_000_000_000_001;
    const service = 450_000_000_000;
    const tax = 945_000_000_001;
    const line = 4_000_000_000_003;
    const half = (value: number) =>
      Number(
        (2n * BigInt(value) * BigInt(line) + BigInt(subtotal)) /
          (2n * BigInt(subtotal)),
      );
    const result = recoveryRefundSplit({
      order: makeOrder({ subtotal, service, tax }),
      lineTotalIdr: line,
      releasedIdr: 0,
    });
    expect(result.grossSalesIdr).toBe(half(subtotal));
    expect(result.serviceChargeIdr).toBe(half(service));
    expect(result.pbjtIdr).toBe(half(tax));
    expect(result.wantedIdr).toBe(half(subtotal) + half(service) + half(tax));
    expect(result.amountIdr).toBe(result.wantedIdr);
  });
});

describe("legend-94q2l recoveryRefundSplit: room, selisih dan pemotongan", () => {
  it("room dipotong oleh yang sudah dilepas issue lain: amount = room, selisih dicatat, komponen diskalakan", () => {
    // room = 115.500 - 100.000 = 15.500; wanted 46.200; k = 15.500 / 46.200.
    const result = recoveryRefundSplit({
      order: BRIEF_ORDER,
      lineTotalIdr: 40_000,
      releasedIdr: 100_000,
    });
    expect(result).toEqual({
      wantedIdr: 46_200,
      amountIdr: 15_500,
      shortfallIdr: 30_700,
      grossSalesIdr: 13_420, // 15.500 - 671 - 1.409
      discountIdr: 0,
      serviceChargeIdr: 671, // 670,996 half-up
      pbjtIdr: 1_409, // 1.409,09 half-up
    });
  });

  it("pemotongan dengan diskon: diskon ikut diskalakan, gross adalah sisa", () => {
    // room = 103.950 - 73.950 = 30.000; wanted 51.975.
    const order = makeOrder({
      subtotal: 100_000,
      discount: 10_000,
      service: 4_500,
      tax: 9_450,
    });
    const result = recoveryRefundSplit({
      order,
      lineTotalIdr: 50_000,
      releasedIdr: 73_950,
    });
    expect(result).toEqual({
      wantedIdr: 51_975,
      amountIdr: 30_000,
      shortfallIdr: 21_975,
      grossSalesIdr: 28_860, // 30.000 + 2.886 - 1.299 - 2.727
      discountIdr: 2_886,
      serviceChargeIdr: 1_299,
      pbjtIdr: 2_727,
    });
  });

  it("uang muka (DP) yang dipakai order mengurangi room", () => {
    const order = makeOrder({
      subtotal: 100_000,
      service: 5_000,
      tax: 10_500,
      deposit: 20_000,
    });
    const result = recoveryRefundSplit({
      order,
      lineTotalIdr: 100_000,
      releasedIdr: 0,
    });
    expect(result.wantedIdr).toBe(115_500);
    expect(result.amountIdr).toBe(95_500);
    expect(result.shortfallIdr).toBe(20_000);
    expect(
      result.grossSalesIdr -
        result.discountIdr +
        result.serviceChargeIdr +
        result.pbjtIdr,
    ).toBe(95_500);
  });

  it("room habis (dilepas >= sisa): amount 0, semua komponen 0, selisih = wanted", () => {
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        releasedIdr: 115_500,
      }),
    ).toEqual({ ...ZERO, wantedIdr: 46_200, shortfallIdr: 46_200 });
  });

  it("dilepas melebihi total: room tidak negatif (amount 0, bukan minus)", () => {
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        releasedIdr: 999_999,
      }),
    ).toEqual({ ...ZERO, wantedIdr: 46_200, shortfallIdr: 46_200 });
  });

  it("room tepat sama dengan wanted: tidak ada selisih dan tidak ada pemotongan", () => {
    // room = 115.500 - 69.300 = 46.200 = wanted.
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        releasedIdr: 69_300,
      }),
    ).toEqual({
      wantedIdr: 46_200,
      amountIdr: 46_200,
      shortfallIdr: 0,
      grossSalesIdr: 40_000,
      discountIdr: 0,
      serviceChargeIdr: 2_000,
      pbjtIdr: 4_200,
    });
  });
});

describe("legend-94q2l recoveryRefundSplit: masukan kosong", () => {
  it("subtotal 0: semua 0", () => {
    const order = makeOrder({ subtotal: 0 });
    expect(
      recoveryRefundSplit({ order, lineTotalIdr: 10_000, releasedIdr: 0 }),
    ).toEqual(ZERO);
  });

  it("lineTotal 0 atau negatif: semua 0", () => {
    for (const lineTotalIdr of [0, -1, -40_000])
      expect(
        recoveryRefundSplit({
          order: BRIEF_ORDER,
          lineTotalIdr,
          releasedIdr: 0,
        }),
      ).toEqual(ZERO);
  });
});

describe("legend-94q2l recoveryRefundSplit: sifat untuk banyak order acak", () => {
  // Deterministic pseudo-random numbers so a failure is reproducible.
  function lcg(seed: number) {
    let state = seed >>> 0;
    return (max: number) => {
      // mulberry32: a small, well-mixed 32-bit generator.
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
      return Math.floor(unit * (max + 1));
    };
  }

  it("identitas split = amount, tanpa komponen negatif, amount = min(wanted, room), wanted sesuai half-up", () => {
    const next = lcg(94_002);
    for (let index = 0; index < 400; index += 1) {
      const subtotal = 10_000 + next(4_990_000);
      const discount = next(Math.floor(subtotal / 3));
      const service = next(Math.floor(subtotal / 10));
      const tax = next(Math.floor(subtotal / 8));
      const rounding = next(98) - 49;
      const inclusive = next(1) === 1;
      const order = makeOrder({
        subtotal,
        discount,
        service,
        tax,
        rounding,
        inclusive,
        // An inclusive order must keep subtotal >= service + tax (gross >= 0).
      });
      if (inclusive && service + tax > subtotal) continue;
      const deposit = next(Math.floor(order.totalIdr / 3));
      const orderWithDeposit = { ...order, depositAppliedIdr: deposit };
      const line = 1_000 + next(subtotal - 1_000);
      const released = next(Math.floor(order.totalIdr * 1.2));
      const label = JSON.stringify({ orderWithDeposit, line, released });

      const result = recoveryRefundSplit({
        order: orderWithDeposit,
        lineTotalIdr: line,
        releasedIdr: released,
      });

      const half = (value: number) =>
        Number(
          (2n * BigInt(value) * BigInt(line) + BigInt(subtotal)) /
            (2n * BigInt(subtotal)),
        );
      const grossBase = inclusive ? subtotal - service - tax : subtotal;
      const expectedWanted =
        half(grossBase) - half(discount) + half(service) + half(tax);
      const room = Math.max(0, order.totalIdr - deposit - released);

      expect(result.wantedIdr, label).toBe(expectedWanted);
      expect(result.amountIdr, label).toBe(Math.min(expectedWanted, room));
      expect(result.amountIdr + result.shortfallIdr, label).toBe(
        result.wantedIdr,
      );
      for (const value of Object.values(result)) {
        expect(Number.isInteger(value), label).toBe(true);
        expect(value, label).toBeGreaterThanOrEqual(0);
      }
      expect(
        result.grossSalesIdr -
          result.discountIdr +
          result.serviceChargeIdr +
          result.pbjtIdr,
        label,
      ).toBe(result.amountIdr);
    }
  });
});
