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
import {
  recoveryRefundReplaySplit,
  recoveryRefundSplit,
} from "../services/order-recovery-refund-amount.ts";

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
  goodsIdr: 0,
};

describe("legend-94q2l recoveryRefundSplit: pro-rata tanpa pemotongan", () => {
  it("contoh brief: baris 40.000 dari 100.000 -> gross 40.000, service 2.000, pbjt 4.200, wanted 46.200", () => {
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        priorLinesIdr: 0,
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
      goodsIdr: 40_000,
    });
  });

  it("baris sama dengan subtotal: wanted = total order, tanpa selisih pembulatan", () => {
    const result = recoveryRefundSplit({
      order: BRIEF_ORDER,
      lineTotalIdr: 100_000,
      priorLinesIdr: 0,
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
      recoveryRefundSplit({
        order,
        lineTotalIdr: 100_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
      }),
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
        priorLinesIdr: 0,
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
      recoveryRefundSplit({
        order,
        lineTotalIdr: 50_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
      }),
    ).toEqual({
      wantedIdr: 51_975,
      amountIdr: 51_975,
      shortfallIdr: 0,
      grossSalesIdr: 50_000,
      discountIdr: 5_000,
      serviceChargeIdr: 2_250,
      pbjtIdr: 4_725,
      goodsIdr: 45_000,
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
      recoveryRefundSplit({
        order,
        lineTotalIdr: 40_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
      }),
    ).toEqual({
      wantedIdr: 40_000,
      amountIdr: 40_000,
      shortfallIdr: 0,
      grossSalesIdr: 34_364, // 34.363,6 half-up
      discountIdr: 0,
      serviceChargeIdr: 2_000,
      pbjtIdr: 3_636, // 3.636,4 half-up
      goodsIdr: 40_000, // inclusive: the amount,
    });
  });
});

describe("legend-94q2l recoveryRefundSplit: pembulatan half-up", () => {
  it("tepat setengah dibulatkan ke atas, di bawah setengah ke bawah", () => {
    // s = 1000 / 6000 = 1/6. service 3 -> 0,5 -> 1; service 2 -> 0,333 -> 0.
    const tie = recoveryRefundSplit({
      order: makeOrder({ subtotal: 6_000, service: 3 }),
      lineTotalIdr: 1_000,
      priorLinesIdr: 0,
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
      priorLinesIdr: 0,
      releasedIdr: 0,
    });
    expect(below).toMatchObject({ serviceChargeIdr: 0, wantedIdr: 1_000 });
  });

  it("pbjt 9 x 1/6 = 1,5 menjadi 2", () => {
    const result = recoveryRefundSplit({
      order: makeOrder({ subtotal: 6_000, tax: 9 }),
      lineTotalIdr: 1_000,
      priorLinesIdr: 0,
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
      priorLinesIdr: 0,
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
      priorLinesIdr: 0,
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
      goodsIdr: 13_420,
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
      priorLinesIdr: 0,
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
      goodsIdr: 25_974,
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
      priorLinesIdr: 0,
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
        priorLinesIdr: 0,
        releasedIdr: 115_500,
      }),
    ).toEqual({ ...ZERO, wantedIdr: 46_200, shortfallIdr: 46_200 });
  });

  it("dilepas melebihi total: room tidak negatif (amount 0, bukan minus)", () => {
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        priorLinesIdr: 0,
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
        priorLinesIdr: 0,
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
      goodsIdr: 40_000,
    });
  });
});

describe("legend-94q2l recoveryRefundSplit: masukan kosong", () => {
  it("subtotal 0: semua 0", () => {
    const order = makeOrder({ subtotal: 0 });
    expect(
      recoveryRefundSplit({
        order,
        lineTotalIdr: 10_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
      }),
    ).toEqual(ZERO);
  });

  it("lineTotal 0 atau negatif: semua 0", () => {
    for (const lineTotalIdr of [0, -1, -40_000])
      expect(
        recoveryRefundSplit({
          order: BRIEF_ORDER,
          lineTotalIdr,
          priorLinesIdr: 0,
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
        priorLinesIdr: 0,
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

describe("legend-h1dyy recoveryRefundSplit: pembulatan kumulatif antar refund", () => {
  const identity = (result: ReturnType<typeof recoveryRefundSplit>) =>
    result.grossSalesIdr -
    result.discountIdr +
    result.serviceChargeIdr +
    result.pbjtIdr;

  it("contoh Codex: dua baris 50.005 dari 100.010, PBJT 10.001 -> 5.001 lalu 5.000 (jumlah 10.001, bukan 10.002)", () => {
    const order = makeOrder({ subtotal: 100_010, tax: 10_001 });
    const first = recoveryRefundSplit({
      order,
      lineTotalIdr: 50_005,
      priorLinesIdr: 0,
      releasedIdr: 0,
    });
    expect(first).toMatchObject({ grossSalesIdr: 50_005, pbjtIdr: 5_001 });
    expect(identity(first)).toBe(first.amountIdr);
    const second = recoveryRefundSplit({
      order,
      lineTotalIdr: 50_005,
      priorLinesIdr: 50_005,
      releasedIdr: first.amountIdr,
    });
    expect(second).toMatchObject({ grossSalesIdr: 50_005, pbjtIdr: 5_000 });
    expect(identity(second)).toBe(second.amountIdr);
    expect(first.pbjtIdr + second.pbjtIdr).toBe(10_001);
    expect(first.amountIdr + second.amountIdr).toBe(order.totalIdr);
  });

  it("tiga baris 10.000, service 1.000, PBJT 3.100: refund terakhir mengambil sisa, jumlah = komponen order", () => {
    const order = makeOrder({ subtotal: 30_000, service: 1_000, tax: 3_100 });
    let prior = 0;
    let released = 0;
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      const result = recoveryRefundSplit({
        order,
        lineTotalIdr: 10_000,
        priorLinesIdr: prior,
        releasedIdr: released,
      });
      expect(identity(result)).toBe(result.amountIdr);
      expect(result.shortfallIdr).toBe(0);
      results.push(result);
      prior += 10_000;
      released += result.amountIdr;
    }
    expect(results.map((result) => result.serviceChargeIdr)).toEqual([
      333, 334, 333,
    ]);
    expect(results.map((result) => result.pbjtIdr)).toEqual([
      1_033, 1_034, 1_033,
    ]);
    expect(results.map((result) => result.grossSalesIdr)).toEqual([
      10_000, 10_000, 10_000,
    ]);
    expect(released).toBe(order.totalIdr);
  });

  it("baris yang sudah lewat subtotal (prior + line > subtotal) tidak melebihi komponen order", () => {
    const order = makeOrder({ subtotal: 30_000, service: 1_000, tax: 3_100 });
    const result = recoveryRefundSplit({
      order,
      lineTotalIdr: 10_000,
      priorLinesIdr: 25_000,
      releasedIdr: 0,
    });
    // Only 5.000 of the subtotal is left: 1.000 - 833 = 167, 3.100 - 2.583 = 517.
    expect(result).toMatchObject({
      grossSalesIdr: 5_000,
      serviceChargeIdr: 167,
      pbjtIdr: 517,
      wantedIdr: 5_684,
    });
  });
});

describe("legend-h1dyy recoveryRefundSplit: promo dihitung ulang (CRM)", () => {
  /** 2 kopi 50.000 + croissant 20.000; promo makes the croissant free. */
  const PROMO_ORDER = makeOrder({ subtotal: 120_000, discount: 20_000 });

  it("croissant gratis gagal: promo tidak berubah, goodsDue 0 -> amount 0 (pro-rata lama 16.667)", () => {
    expect(PROMO_ORDER.totalIdr).toBe(100_000);
    expect(
      recoveryRefundSplit({
        order: PROMO_ORDER,
        lineTotalIdr: 20_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
        promo: {
          refundedSubtotalIdr: 20_000,
          goodsDueIdr: 0,
          remainingPaidIdr: 100_000,
        },
      }),
    ).toEqual(ZERO);
  });

  it("satu kopi gagal, promo ditarik: amount 30.000, gross 50.000, diskon 20.000", () => {
    expect(
      recoveryRefundSplit({
        order: PROMO_ORDER,
        lineTotalIdr: 50_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
        promo: {
          refundedSubtotalIdr: 50_000,
          goodsDueIdr: 30_000,
          remainingPaidIdr: 100_000,
        },
      }),
    ).toEqual({
      wantedIdr: 30_000,
      amountIdr: 30_000,
      shortfallIdr: 0,
      grossSalesIdr: 50_000,
      discountIdr: 20_000,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      goodsIdr: 30_000,
    });
  });

  it("eksklusif, service 5% + PBJT 10%: service/pbjt mengikuti uang barang, refund kedua mengambil sisa", () => {
    // Goods paid P = 100.000; service 5.000; PBJT 10% of 105.000 = 10.500.
    const order = makeOrder({
      subtotal: 120_000,
      discount: 20_000,
      service: 5_000,
      tax: 10_500,
    });
    expect(order.totalIdr).toBe(115_500);
    const first = recoveryRefundSplit({
      order,
      lineTotalIdr: 50_000,
      priorLinesIdr: 0,
      releasedIdr: 0,
      promo: {
        refundedSubtotalIdr: 50_000,
        goodsDueIdr: 30_000,
        remainingPaidIdr: 100_000,
      },
    });
    expect(first).toEqual({
      wantedIdr: 34_650,
      amountIdr: 34_650,
      shortfallIdr: 0,
      grossSalesIdr: 50_000,
      discountIdr: 20_000,
      serviceChargeIdr: 1_500,
      pbjtIdr: 3_150,
      goodsIdr: 30_000,
    });
    // The rest of the goods (70.000 paid) refunds later: it takes the rest.
    const second = recoveryRefundSplit({
      order,
      lineTotalIdr: 70_000,
      priorLinesIdr: 50_000,
      releasedIdr: first.amountIdr,
      promo: {
        refundedSubtotalIdr: 70_000,
        goodsDueIdr: 70_000,
        remainingPaidIdr: 70_000,
      },
    });
    expect(second).toMatchObject({
      amountIdr: 80_850,
      grossSalesIdr: 70_000,
      discountIdr: 0,
      serviceChargeIdr: 3_500,
      pbjtIdr: 7_350,
      goodsIdr: 70_000,
    });
    for (const result of [first, second])
      expect(
        result.grossSalesIdr -
          result.discountIdr +
          result.serviceChargeIdr +
          result.pbjtIdr,
      ).toBe(result.amountIdr);
    expect(first.amountIdr + second.amountIdr).toBe(order.totalIdr);
  });

  it("inklusif, PBJT 9.091: wanted = goodsDue, gross dari basis pendapatan (floor)", () => {
    const order = makeOrder({
      subtotal: 120_000,
      discount: 20_000,
      tax: 9_091,
      inclusive: true,
    });
    // pbjt round(9.091 * 30.000 / 100.000) = 2.727; net 27.273;
    // gross floor(50.000 * 110.909 / 120.000) = 46.212; discount 18.939.
    expect(
      recoveryRefundSplit({
        order,
        lineTotalIdr: 50_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
        promo: {
          refundedSubtotalIdr: 50_000,
          goodsDueIdr: 30_000,
          remainingPaidIdr: 100_000,
        },
      }),
    ).toEqual({
      wantedIdr: 30_000,
      amountIdr: 30_000,
      shortfallIdr: 0,
      grossSalesIdr: 46_212,
      discountIdr: 18_939,
      serviceChargeIdr: 0,
      pbjtIdr: 2_727,
      goodsIdr: 30_000, // inclusive: the amount,
    });
  });
});

describe("legend-h1dyy recoveryRefundSplit: goodsIdr untuk buku promo (refunded_paid_idr)", () => {
  // Review H1: the promo ledger counts what the guest paid for the goods on
  // the item-price basis. Inclusive prices hold the tax, so the goods money
  // is the whole amount, not gross - discount.
  it("inklusif 3 x 110.000, promo min-spend 10%, PBJT 10% inklusif: refund A 99.000 mencatat 99.000 (bukan 90.000)", () => {
    const order = makeOrder({
      subtotal: 330_000,
      discount: 33_000,
      tax: 27_000,
      inclusive: true,
    });
    const result = recoveryRefundSplit({
      order,
      lineTotalIdr: 110_000,
      priorLinesIdr: 0,
      releasedIdr: 0,
      promo: {
        refundedSubtotalIdr: 110_000,
        goodsDueIdr: 99_000,
        remainingPaidIdr: 297_000,
      },
    });
    expect(result.amountIdr).toBe(99_000);
    expect(result.goodsIdr).toBe(99_000);
  });

  it("eksklusif: goodsIdr = gross - diskon, juga setelah dipotong room", () => {
    const order = makeOrder({
      subtotal: 120_000,
      discount: 20_000,
      service: 5_000,
      tax: 10_500,
    });
    const promo = {
      refundedSubtotalIdr: 50_000,
      goodsDueIdr: 30_000,
      remainingPaidIdr: 100_000,
    };
    const full = recoveryRefundSplit({
      order,
      lineTotalIdr: 50_000,
      priorLinesIdr: 0,
      releasedIdr: 0,
      promo,
    });
    expect(full.goodsIdr).toBe(30_000);
    expect(full.goodsIdr).toBe(full.grossSalesIdr - full.discountIdr);
    const cut = recoveryRefundSplit({
      order,
      lineTotalIdr: 50_000,
      priorLinesIdr: 0,
      releasedIdr: order.totalIdr - order.depositAppliedIdr - 20_000,
      promo,
    });
    expect(cut.amountIdr).toBe(20_000);
    expect(cut.goodsIdr).toBe(cut.grossSalesIdr - cut.discountIdr);
    expect(cut.goodsIdr).toBeLessThan(full.goodsIdr);
  });

  it("inklusif dipotong room: goodsIdr = amount", () => {
    const order = makeOrder({
      subtotal: 330_000,
      discount: 33_000,
      tax: 27_000,
      inclusive: true,
    });
    const result = recoveryRefundSplit({
      order,
      lineTotalIdr: 110_000,
      priorLinesIdr: 0,
      releasedIdr: 297_000 - 50_000,
      promo: {
        refundedSubtotalIdr: 110_000,
        goodsDueIdr: 99_000,
        remainingPaidIdr: 297_000,
      },
    });
    expect(result.amountIdr).toBe(50_000);
    expect(result.goodsIdr).toBe(50_000);
  });
});

// legend-fwe4l (Q17): the replay of a failed refund is capped by the value of the
// replacement line (`capIdr`), so a swap to a cheaper item never pays the old
// item's money again next to the voucher for the difference. Contract:
// docs/briefs/sub-fwe4l-swap-cap.md. Cap below wanted: the amount asked is the
// cap and discount, service and PBJT scale by cap / wanted (gross is the rest),
// like a cut to the room; the room applies afterwards; `shortfallIdr` comes only
// from the room, never from the cap.
describe("legend-fwe4l recoveryRefundReplaySplit dengan capIdr", () => {
  // gross 20.000 - discount 12.000 + service 500 + PBJT 1.500 = wanted 10.000.
  const failed = {
    wantedIdr: 10_000,
    grossSalesIdr: 20_000,
    discountIdr: 12_000,
    serviceChargeIdr: 500,
    pbjtIdr: 1_500,
  };
  const roomy = { totalIdr: 100_000, depositAppliedIdr: 0 };

  it("cap di bawah wanted: jumlah = cap, bagian proporsional, shortfall 0", () => {
    const result = recoveryRefundReplaySplit({
      order: roomy,
      ...failed,
      releasedIdr: 0,
      capIdr: 5_000,
    });
    expect(result).toMatchObject({
      wantedIdr: 5_000,
      amountIdr: 5_000,
      shortfallIdr: 0,
      grossSalesIdr: 10_000,
      discountIdr: 6_000,
      serviceChargeIdr: 250,
      pbjtIdr: 750,
    });
  });

  it("cap yang tidak membagi rata: jumlah bagian tetap = jumlah, tidak ada bagian negatif, tiap bagian mendekati proporsi", () => {
    const result = recoveryRefundReplaySplit({
      order: roomy,
      ...failed,
      releasedIdr: 0,
      capIdr: 3_333,
    });
    expect(result.amountIdr).toBe(3_333);
    expect(result.wantedIdr).toBe(3_333);
    expect(result.shortfallIdr).toBe(0);
    expect(
      result.grossSalesIdr -
        result.discountIdr +
        result.serviceChargeIdr +
        result.pbjtIdr,
    ).toBe(3_333);
    for (const part of [
      result.grossSalesIdr,
      result.discountIdr,
      result.serviceChargeIdr,
      result.pbjtIdr,
    ])
      expect(part).toBeGreaterThanOrEqual(0);
    // discount 12.000, service 500, PBJT 1.500 scaled by 3.333 / 10.000.
    expect(Math.abs(result.discountIdr - 3_999.6)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.serviceChargeIdr - 166.65)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.pbjtIdr - 499.95)).toBeLessThanOrEqual(1);
  });

  it("cap sama dengan atau di atas wanted: hasil tidak berubah dari tanpa cap", () => {
    const without = recoveryRefundReplaySplit({
      order: roomy,
      ...failed,
      releasedIdr: 0,
    });
    expect(without.amountIdr).toBe(10_000);
    for (const capIdr of [10_000, 10_001, 500_000])
      expect(
        recoveryRefundReplaySplit({
          order: roomy,
          ...failed,
          releasedIdr: 0,
          capIdr,
        }),
      ).toEqual(without);
  });

  it("cap dan room: room yang lebih kecil menang; shortfall dihitung dari wanted setelah cap", () => {
    // room = 12.000 - 0 - 10.000 = 2.000, below the cap of 5.000.
    const result = recoveryRefundReplaySplit({
      order: { totalIdr: 12_000, depositAppliedIdr: 0 },
      ...failed,
      releasedIdr: 10_000,
      capIdr: 5_000,
    });
    expect(result).toMatchObject({
      wantedIdr: 5_000,
      amountIdr: 2_000,
      shortfallIdr: 3_000,
      grossSalesIdr: 4_000,
      discountIdr: 2_400,
      serviceChargeIdr: 100,
      pbjtIdr: 300,
    });
  });

  it("cap dan room: room yang lebih besar dari cap tidak mengubah apa pun (tanpa shortfall)", () => {
    const result = recoveryRefundReplaySplit({
      order: { totalIdr: 12_000, depositAppliedIdr: 0 },
      ...failed,
      releasedIdr: 4_000,
      capIdr: 5_000,
    });
    expect(result.amountIdr).toBe(5_000);
    expect(result.shortfallIdr).toBe(0);
  });
});

// legend-fwe4l round 2: `recoveryRefundSplit` takes the same `capIdr` (the refund of
// a replacement line after a swap, also when no failed refund is replayed). Same
// rules as the replay split: cap below wanted -> amount asked = cap, discount,
// service and PBJT scale by cap / wanted (half-up), gross is the rest; then the
// room applies; `shortfallIdr` comes only from the room. `goodsIdr` (the promo
// ledger's goods, recorded BEFORE the cap) is not pinned here: where the pre-cap
// goods is carried is the implementer's choice; the DB test checks the ledger.
describe("legend-fwe4l recoveryRefundSplit dengan capIdr", () => {
  const DISCOUNT_ORDER = makeOrder({
    subtotal: 100_000,
    discount: 10_000,
    service: 4_500,
    tax: 9_450,
  });

  it("cap di bawah wanted: jumlah = cap, bagian dikali cap / wanted, shortfall 0", () => {
    // Line 40.000 of the brief order: wanted 46.200 (gross 40.000, service 2.000,
    // PBJT 4.200); k = 23.100 / 46.200 = 1/2.
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
        capIdr: 23_100,
      }),
    ).toMatchObject({
      wantedIdr: 23_100,
      amountIdr: 23_100,
      shortfallIdr: 0,
      grossSalesIdr: 20_000,
      discountIdr: 0,
      serviceChargeIdr: 1_000,
      pbjtIdr: 2_100,
    });
  });

  it("cap dengan diskon order: diskon ikut diskalakan, gross adalah sisa", () => {
    // Line 50.000: gross 50.000, discount 5.000, service 2.250, PBJT 4.725,
    // wanted 51.975; k = 20.790 / 51.975 = 0,4.
    expect(
      recoveryRefundSplit({
        order: DISCOUNT_ORDER,
        lineTotalIdr: 50_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
        capIdr: 20_790,
      }),
    ).toMatchObject({
      wantedIdr: 20_790,
      amountIdr: 20_790,
      shortfallIdr: 0,
      grossSalesIdr: 20_000,
      discountIdr: 2_000,
      serviceChargeIdr: 900,
      pbjtIdr: 1_890,
    });
  });

  it("cap pada hitungan promo: wanted promo 34.650, cap 3.465 -> bagian dikali 1/10", () => {
    const order = makeOrder({
      subtotal: 120_000,
      discount: 20_000,
      service: 5_000,
      tax: 10_500,
    });
    expect(
      recoveryRefundSplit({
        order,
        lineTotalIdr: 50_000,
        priorLinesIdr: 0,
        releasedIdr: 0,
        promo: {
          refundedSubtotalIdr: 50_000,
          goodsDueIdr: 30_000,
          remainingPaidIdr: 100_000,
        },
        capIdr: 3_465,
      }),
    ).toMatchObject({
      wantedIdr: 3_465,
      amountIdr: 3_465,
      shortfallIdr: 0,
      grossSalesIdr: 5_000,
      discountIdr: 2_000,
      serviceChargeIdr: 150,
      pbjtIdr: 315,
    });
  });

  it("cap yang tidak membagi rata: jumlah bagian tetap = jumlah, tidak ada bagian negatif", () => {
    const result = recoveryRefundSplit({
      order: DISCOUNT_ORDER,
      lineTotalIdr: 50_000,
      priorLinesIdr: 0,
      releasedIdr: 0,
      capIdr: 12_345,
    });
    expect(result.amountIdr).toBe(12_345);
    expect(result.wantedIdr).toBe(12_345);
    expect(result.shortfallIdr).toBe(0);
    expect(
      result.grossSalesIdr -
        result.discountIdr +
        result.serviceChargeIdr +
        result.pbjtIdr,
    ).toBe(12_345);
    for (const part of [
      result.grossSalesIdr,
      result.discountIdr,
      result.serviceChargeIdr,
      result.pbjtIdr,
    ])
      expect(part).toBeGreaterThanOrEqual(0);
  });

  it("cap sama dengan atau di atas wanted: hasil tidak berubah dari tanpa cap", () => {
    const base = {
      order: BRIEF_ORDER,
      lineTotalIdr: 40_000,
      priorLinesIdr: 0,
      releasedIdr: 0,
    };
    const without = recoveryRefundSplit(base);
    expect(without.amountIdr).toBe(46_200);
    for (const capIdr of [46_200, 46_201, 500_000])
      expect(recoveryRefundSplit({ ...base, capIdr })).toEqual(without);
  });

  it("cap dan room: room yang lebih kecil menang; shortfall dihitung dari wanted setelah cap", () => {
    // room = 115.500 - 100.000 = 15.500 < cap 23.100: after the cap the cut is
    // 15.500 / 23.100 (service 1.000 -> 671, PBJT 2.100 -> 1.409, gross 13.420).
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        priorLinesIdr: 0,
        releasedIdr: 100_000,
        capIdr: 23_100,
      }),
    ).toMatchObject({
      wantedIdr: 23_100,
      amountIdr: 15_500,
      shortfallIdr: 7_600,
      grossSalesIdr: 13_420,
      discountIdr: 0,
      serviceChargeIdr: 671,
      pbjtIdr: 1_409,
    });
  });

  it("cap dan room: room yang lebih besar dari cap tidak mengubah apa pun (tanpa shortfall)", () => {
    // room = 115.500 - 50.000 = 65.500 > cap 23.100.
    expect(
      recoveryRefundSplit({
        order: BRIEF_ORDER,
        lineTotalIdr: 40_000,
        priorLinesIdr: 0,
        releasedIdr: 50_000,
        capIdr: 23_100,
      }),
    ).toMatchObject({
      wantedIdr: 23_100,
      amountIdr: 23_100,
      shortfallIdr: 0,
      grossSalesIdr: 20_000,
      serviceChargeIdr: 1_000,
      pbjtIdr: 2_100,
    });
  });
});
