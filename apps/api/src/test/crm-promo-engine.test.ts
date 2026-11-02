// Promo engine pure core, table-driven (PRD v1.7 §3.21 "Promo Engine"; owner
// decision Q20 sequential stacking; ORD-03; LOY-03 inputs; legend-559 calc
// order; bead legend-7x4g). No database: these are the decisions every
// checkout (POS, QR, website) runs through `crm-promo-engine.ts`.
import { describe, expect, it } from "vitest";
import {
  applyPromotions,
  defaultPromoStackingPolicy,
  evaluatePromotion,
  outletLocalClock,
  type PromoEvaluationInput,
  type PromoStackingPolicy,
  type Promotion,
} from "@starter/shared/crm";
import { idr } from "@starter/shared/core";
import { calculateTax, cafeLegendTaxFixtures } from "@starter/shared/tax";
import { endOfBusinessDay } from "../services/crm-promo-engine";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "aaaaaaaa-0000-4000-8000-000000000002";
const ITEM_C = "aaaaaaaa-0000-4000-8000-000000000003";
const CUSTOMER = "cccccccc-0000-4000-8000-000000000001";
const TIER_GOLD = "dddddddd-0000-4000-8000-000000000001";
const FACILITY = "eeeeeeee-0000-4000-8000-000000000001";
const AT = "2026-11-02T09:00:00.000Z"; // Monday 16:00 in Asia/Jakarta

let sequence = 0;
function promo(overrides: Partial<Promotion> = {}): Promotion {
  sequence += 1;
  return {
    id: `bbbbbbbb-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    tenantId: TENANT,
    name: `Promo ${sequence}`,
    description: "",
    status: "active",
    codeHash: null,
    voucherRequired: false,
    startsAt: "2026-11-01T00:00:00.000Z",
    endsAt: null,
    conditions: [],
    benefit: { kind: "percent_off", percentBp: 1000, maxDiscountIdr: null },
    stackGroup: `g${sequence}`,
    stackable: true,
    priority: 0,
    quotaTotal: null,
    quotaPerCustomer: null,
    budgetIdr: null,
    spentIdr: idr(0),
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  } as Promotion;
}

function bill(
  subtotal: number,
  overrides: Partial<PromoEvaluationInput> = {},
): PromoEvaluationInput {
  return {
    at: AT,
    channel: "dine_in",
    localDayOfWeek: 1,
    localTime: "16:00",
    subtotalIdr: idr(subtotal),
    lines: [
      {
        menuItemId: ITEM_A,
        quantity: 1,
        unitPriceIdr: idr(subtotal),
        lineTotalIdr: idr(subtotal),
      },
    ],
    customer: null,
    voucherPromotionId: null,
    ...overrides,
  };
}

const member = {
  customerProfileId: CUSTOMER,
  tierId: TIER_GOLD,
  isMember: true,
};
const stackable = (maxStacked = 5, allowSameGroup = false) =>
  ({ mode: "stackable", maxStacked, allowSameGroup }) as PromoStackingPolicy;
const percent = (bp: number, extra: Partial<Promotion> = {}) =>
  promo({
    benefit: { kind: "percent_off", percentBp: bp, maxDiscountIdr: null },
    ...extra,
  });
const appliedAmounts = (result: ReturnType<typeof applyPromotions>) =>
  Object.fromEntries(
    result.evaluations.map((evaluation) => [
      evaluation.promotionId,
      evaluation.applied ? evaluation.discountIdr : evaluation.reason,
    ]),
  );

describe("Q20 stacked percentages apply sequentially on the remaining amount", () => {
  it.each([
    // [label, first bp (higher priority), second bp, subtotal, first, second, total]
    [
      "owner example 10% then 20% of Rp100.000",
      1000,
      2000,
      100_000,
      10_000,
      18_000,
      28_000,
    ],
    [
      "owner example reversed priority 20% then 10%",
      2000,
      1000,
      100_000,
      20_000,
      8_000,
      28_000,
    ],
    ["rounding half up once per step", 1000, 1500, 33_335, 3_334, 4_500, 7_834],
    [
      "50% then 50% leaves a quarter",
      5000,
      5000,
      99_999,
      50_000,
      25_000,
      75_000,
    ],
    [
      "100% then anything gives nothing more",
      10_000,
      1000,
      80_000,
      80_000,
      0,
      80_000,
    ],
  ])(
    "[Q20] %s",
    (_label, firstBp, secondBp, subtotal, first, second, total) => {
      const a = percent(firstBp, { priority: 20 });
      const b = percent(secondBp, { priority: 10 });
      const result = applyPromotions([b, a], bill(subtotal), [], stackable());
      expect(result.totalDiscountIdr).toBe(total);
      const amounts = appliedAmounts(result);
      expect(amounts[a.id]).toBe(first);
      expect(amounts[b.id]).toBe(second === 0 ? "not_selected" : second);
    },
  );

  it("[Q20] nominal then percent: the percent runs on what is left", () => {
    const nominal = promo({
      priority: 20,
      benefit: { kind: "nominal_off", amountIdr: idr(20_000) },
    });
    const tenPercent = percent(1000, { priority: 10 });
    const result = applyPromotions(
      [nominal, tenPercent],
      bill(100_000),
      [],
      stackable(),
    );
    expect(appliedAmounts(result)).toEqual({
      [nominal.id]: 20_000,
      [tenPercent.id]: 8_000,
    });
    expect(result.totalDiscountIdr).toBe(28_000);
  });

  it("[Q20] eligibility still reads the full bill: min spend is not re-checked on the remainder", () => {
    const first = percent(5000, { priority: 20 });
    const minSpend = percent(1000, {
      priority: 10,
      conditions: [{ kind: "min_spend", amountIdr: idr(100_000) }],
    });
    const result = applyPromotions(
      [first, minSpend],
      bill(100_000),
      [],
      stackable(),
    );
    expect(result.totalDiscountIdr).toBe(55_000);
  });
});

describe("§3.21 stacking policy (aturan tumpang tindih)", () => {
  it("default policy is exclusive: the best single discount wins", () => {
    const small = percent(1000);
    const big = percent(2500);
    const result = applyPromotions(
      [small, big],
      bill(100_000),
      [],
      defaultPromoStackingPolicy,
    );
    expect(result.totalDiscountIdr).toBe(25_000);
    expect(appliedAmounts(result)[small.id]).toBe("not_selected");
  });

  it("exclusive tie breaks on priority, then id, deterministically", () => {
    const low = percent(1000, { priority: 1 });
    const high = percent(1000, { priority: 9 });
    for (const order of [
      [low, high],
      [high, low],
    ]) {
      const result = applyPromotions(order, bill(50_000), [], {
        mode: "exclusive",
        maxStacked: 1,
        allowSameGroup: false,
      });
      expect(appliedAmounts(result)[high.id]).toBe(5_000);
      expect(appliedAmounts(result)[low.id]).toBe("not_selected");
    }
  });

  it.each([
    ["maxStacked limits the stack", stackable(1), 1],
    ["same group blocked by default", stackable(5, false), 1],
    ["same group allowed when the policy says so", stackable(5, true), 2],
  ])("%s", (_label, policy, expectedApplied) => {
    const a = percent(1000, { priority: 2, stackGroup: "happy" });
    const b = percent(1000, { priority: 1, stackGroup: "happy" });
    const result = applyPromotions([a, b], bill(100_000), [], policy);
    expect(result.evaluations.filter((entry) => entry.applied)).toHaveLength(
      expectedApplied,
    );
  });

  it("a non-stackable promotion never joins a stack, and one that leads stands alone", () => {
    const leader = percent(1000, { priority: 9, stackable: false });
    const other = percent(1000, { priority: 1 });
    const alone = applyPromotions(
      [leader, other],
      bill(100_000),
      [],
      stackable(),
    );
    expect(appliedAmounts(alone)).toEqual({
      [leader.id]: 10_000,
      [other.id]: "not_stackable",
    });
    const late = percent(1000, { priority: 0, stackable: false });
    const joined = applyPromotions(
      [other, late],
      bill(100_000),
      [],
      stackable(),
    );
    expect(appliedAmounts(joined)[late.id]).toBe("not_stackable");
  });

  it("the stack never discounts more than the bill", () => {
    const promotions = [
      promo({
        priority: 3,
        benefit: { kind: "nominal_off", amountIdr: idr(70_000) },
      }),
      promo({
        priority: 2,
        benefit: { kind: "nominal_off", amountIdr: idr(70_000) },
      }),
      percent(5000, { priority: 1 }),
    ];
    const result = applyPromotions(promotions, bill(100_000), [], stackable());
    expect(result.totalDiscountIdr).toBe(100_000);
  });

  it("is deterministic: every input order gives the same result", () => {
    const promotions = [
      percent(1000, { priority: 5 }),
      percent(1500, { priority: 5 }),
      promo({
        priority: 1,
        benefit: { kind: "nominal_off", amountIdr: idr(7_777) },
      }),
      percent(3000, { priority: 0, stackGroup: "x" }),
    ];
    const baseline = applyPromotions(
      promotions,
      bill(123_457),
      [],
      stackable(),
    );
    for (let shift = 1; shift < promotions.length; shift += 1) {
      const rotated = [
        ...promotions.slice(shift),
        ...promotions.slice(0, shift),
      ];
      const result = applyPromotions(rotated, bill(123_457), [], stackable());
      expect(result.totalDiscountIdr).toBe(baseline.totalDiscountIdr);
      expect(appliedAmounts(result)).toEqual(appliedAmounts(baseline));
    }
  });
});

describe("§3.21 quota, budget and validity", () => {
  it.each([
    [
      "global quota left",
      { quotaTotal: 3 },
      { totalUses: 2, customerUses: 0 },
      true,
      null,
    ],
    [
      "global quota exhausted",
      { quotaTotal: 3 },
      { totalUses: 3, customerUses: 0 },
      false,
      "quota_exhausted",
    ],
    [
      "per-customer quota left",
      { quotaPerCustomer: 2 },
      { totalUses: 9, customerUses: 1 },
      true,
      null,
    ],
    [
      "per-customer quota exhausted",
      { quotaPerCustomer: 2 },
      { totalUses: 9, customerUses: 2 },
      false,
      "quota_exhausted",
    ],
  ] as const)("%s", (_label, caps, usage, applied, reason) => {
    const promotion = percent(1000, caps);
    const result = evaluatePromotion(
      promotion,
      bill(50_000, { customer: member }),
      { promotionId: promotion.id, ...usage },
    );
    expect(result.applied).toBe(applied);
    if (!result.applied) expect(result.reason).toBe(reason);
  });

  it("an anonymous bill cannot use a per-customer-limited promotion (fails closed)", () => {
    const promotion = percent(1000, { quotaPerCustomer: 1 });
    expect(evaluatePromotion(promotion, bill(50_000))).toMatchObject({
      applied: false,
      reason: "member_only",
    });
  });

  it.each([
    ["budget fits exactly", 10_000, 95_000, true],
    ["budget one rupiah short", 10_000, 95_001, false],
  ])("%s", (_label, discount, spent, applied) => {
    const promotion = promo({
      benefit: { kind: "nominal_off", amountIdr: idr(discount) },
      budgetIdr: idr(105_000),
      spentIdr: idr(spent),
    });
    const result = evaluatePromotion(promotion, bill(50_000));
    expect(result.applied).toBe(applied);
    if (!result.applied) expect(result.reason).toBe("budget_exhausted");
  });

  it.each([
    ["one ms before start", "2026-11-01T23:59:59.999Z", "not_started"],
    ["exactly at start", "2026-11-02T00:00:00.000Z", null],
    ["one ms before end", "2026-11-02T09:59:59.999Z", null],
    ["exactly at end (end is exclusive)", "2026-11-02T10:00:00.000Z", "ended"],
  ])("validity window: %s", (_label, at, reason) => {
    const promotion = percent(1000, {
      startsAt: "2026-11-02T00:00:00.000Z",
      endsAt: "2026-11-02T10:00:00.000Z",
    });
    const result = evaluatePromotion(promotion, bill(10_000, { at }));
    if (reason === null) expect(result.applied).toBe(true);
    else expect(result).toMatchObject({ applied: false, reason });
  });

  it.each(["draft", "paused", "ended"] as const)(
    "a %s promotion never applies",
    (status) => {
      expect(
        evaluatePromotion(percent(1000, { status }), bill(10_000)),
      ).toMatchObject({ applied: false, reason: status });
    },
  );

  it("a voucher-required promotion applies only with its validated voucher", () => {
    const promotion = percent(2500, {
      voucherRequired: true,
      codeHash: "a".repeat(64),
    });
    expect(evaluatePromotion(promotion, bill(40_000)).applied).toBe(false);
    expect(
      evaluatePromotion(
        promotion,
        bill(40_000, { voucherPromotionId: promotion.id }),
      ),
    ).toMatchObject({ applied: true, discountIdr: 10_000 });
  });
});

describe("§3.21 rule DSL", () => {
  const threeLines = (overrides: Partial<PromoEvaluationInput> = {}) =>
    bill(0, {
      subtotalIdr: idr(28_000 * 3 + 24_000 + 30_000),
      lines: [
        {
          menuItemId: ITEM_A,
          quantity: 3,
          unitPriceIdr: idr(28_000),
          lineTotalIdr: idr(84_000),
        },
        {
          menuItemId: ITEM_B,
          quantity: 1,
          unitPriceIdr: idr(24_000),
          lineTotalIdr: idr(24_000),
        },
        {
          menuItemId: ITEM_C,
          quantity: 1,
          unitPriceIdr: idr(30_000),
          lineTotalIdr: idr(30_000),
        },
      ],
      ...overrides,
    });

  it.each([
    [
      "percent with a cap",
      promo({
        benefit: {
          kind: "percent_off",
          percentBp: 2000,
          maxDiscountIdr: idr(20_000),
        },
      }),
      20_000,
    ],
    [
      "buy 2 A get 1 B free",
      promo({
        conditions: [
          { kind: "item_quantity", menuItemIds: [ITEM_A], minQuantity: 2 },
        ],
        benefit: {
          kind: "free_items",
          menuItemIds: [ITEM_B],
          quantityPerMultiple: 1,
        },
      }),
      24_000,
    ],
    [
      "bundle A + B for Rp45.000 (one complete bundle)",
      promo({
        conditions: [{ kind: "bundle", menuItemIds: [ITEM_A, ITEM_B] }],
        benefit: {
          kind: "bundle_price",
          menuItemIds: [ITEM_A, ITEM_B],
          bundlePriceIdr: idr(45_000),
        },
      }),
      7_000,
    ],
    [
      "nominal capped at the bill",
      promo({ benefit: { kind: "nominal_off", amountIdr: idr(500_000) } }),
      138_000,
    ],
  ])("%s", (_label, promotion, discount) => {
    expect(evaluatePromotion(promotion, threeLines())).toMatchObject({
      applied: true,
      discountIdr: discount,
    });
  });

  it.each([
    [
      "channel",
      [{ kind: "channel", channels: ["gofood"] }],
      {},
      "channel_mismatch",
    ],
    ["member only", [{ kind: "member", tierIds: [] }], {}, "member_only"],
    [
      "tier",
      [{ kind: "member", tierIds: ["dddddddd-0000-4000-8000-000000000009"] }],
      { customer: member },
      "tier_mismatch",
    ],
    [
      "min spend",
      [{ kind: "min_spend", amountIdr: idr(200_000) }],
      {},
      "min_spend_not_met",
    ],
    [
      "happy hour outside the window",
      [{ kind: "time_window", daysOfWeek: [1], start: "17:00", end: "19:00" }],
      {},
      "time_window_mismatch",
    ],
    [
      "happy hour on another day",
      [{ kind: "time_window", daysOfWeek: [6], start: "15:00", end: "19:00" }],
      {},
      "time_window_mismatch",
    ],
  ] as const)(
    "condition %s rejects",
    (_label, conditions, overrides, reason) => {
      const promotion = percent(1000, {
        conditions: conditions as unknown as Promotion["conditions"],
      });
      expect(evaluatePromotion(promotion, threeLines(overrides))).toMatchObject(
        {
          applied: false,
          reason,
        },
      );
    },
  );

  it.each([
    ["22:30 Monday", 1, "22:30", true],
    ["01:59 Tuesday (after midnight)", 2, "01:59", true],
    ["02:00 Tuesday (inclusive end)", 2, "02:00", true],
    ["02:01 Tuesday", 2, "02:01", false],
    ["21:59 Monday", 1, "21:59", false],
  ])("overnight happy hour 22:00-02:00: %s", (_label, day, time, applied) => {
    const promotion = percent(1000, {
      conditions: [
        {
          kind: "time_window",
          daysOfWeek: [1, 2],
          start: "22:00",
          end: "02:00",
        },
      ],
    });
    expect(
      evaluatePromotion(
        promotion,
        threeLines({ localDayOfWeek: day, localTime: time }),
      ).applied,
    ).toBe(applied);
  });

  it("§3.25 min-spend facility reward needs an identified customer", () => {
    const promotion = promo({
      conditions: [{ kind: "min_spend", amountIdr: idr(100_000) }],
      benefit: {
        kind: "facility_entitlement",
        facilityProductId: FACILITY,
        quantity: 1,
      },
    });
    expect(evaluatePromotion(promotion, threeLines())).toMatchObject({
      applied: false,
      reason: "member_only",
    });
    expect(
      evaluatePromotion(promotion, threeLines({ customer: member })),
    ).toMatchObject({
      applied: true,
      discountIdr: 0,
      facilityEntitlement: { facilityProductId: FACILITY, quantity: 1 },
    });
  });
});

describe("Outlet time zone (validity in outlet business time)", () => {
  it.each([
    ["Jakarta evening", "2026-11-02T15:30:00.000Z", "Asia/Jakarta", 1, "22:30"],
    [
      "Jakarta after midnight is the next day",
      "2026-11-02T17:30:00.000Z",
      "Asia/Jakarta",
      2,
      "00:30",
    ],
    [
      "Makassar is one hour ahead",
      "2026-11-02T15:30:00.000Z",
      "Asia/Makassar",
      1,
      "23:30",
    ],
    [
      "Jayapura crosses midnight first",
      "2026-11-02T15:30:00.000Z",
      "Asia/Jayapura",
      2,
      "00:30",
    ],
  ])("%s", (_label, at, zone, day, time) => {
    expect(outletLocalClock(at, zone)).toEqual({
      localDayOfWeek: day,
      localTime: time,
    });
  });

  it.each([
    [
      "Jakarta afternoon",
      "2026-11-02T09:00:00.000Z",
      "Asia/Jakarta",
      "2026-11-02T17:00:00.000Z",
    ],
    [
      "Jakarta just after local midnight",
      "2026-11-02T17:00:00.000Z",
      "Asia/Jakarta",
      "2026-11-03T17:00:00.000Z",
    ],
    [
      "Makassar",
      "2026-11-02T09:00:00.000Z",
      "Asia/Makassar",
      "2026-11-02T16:00:00.000Z",
    ],
  ])(
    "§3.25 facility reward expires at the end of the outlet business day: %s",
    (_label, at, zone, end) => {
      expect(endOfBusinessDay(new Date(at), zone).toISOString()).toBe(end);
    },
  );
});

describe("legend-559 calc order: promo discount comes before service charge and tax", () => {
  it("[ORD-03] the engine's total feeds the tax engine as the order discount (prices exclude tax and service)", () => {
    const taxBill = cafeLegendTaxFixtures.privateRoomBill;
    const lines = taxBill.lines.map((line) => ({
      menuItemId: line.itemId,
      quantity: 1,
      unitPriceIdr: idr(line.grossIdr - line.discountIdr),
      lineTotalIdr: idr(line.grossIdr - line.discountIdr),
    }));
    const subtotal = lines.reduce((sum, line) => sum + line.lineTotalIdr, 0);
    const first = percent(1000, { priority: 2 });
    const second = percent(2000, { priority: 1 });
    const promoResult = applyPromotions(
      [first, second],
      bill(subtotal, {
        subtotalIdr: idr(subtotal),
        lines,
      }),
      [],
      stackable(),
    );
    const config = {
      taxRules: cafeLegendTaxFixtures.taxRules,
      serviceChargeRules: cafeLegendTaxFixtures.serviceChargeRules,
      settings: cafeLegendTaxFixtures.settings,
    };
    const withoutPromo = calculateTax(
      { ...taxBill, orderDiscountIdr: idr(0) },
      config,
    );
    const withPromo = calculateTax(
      { ...taxBill, orderDiscountIdr: promoResult.totalDiscountIdr },
      config,
    );
    // Sequential: 10% then 20% of the remainder = 28% of the bill.
    expect(promoResult.totalDiscountIdr).toBe(
      Math.round(subtotal * 0.1) +
        Math.round((subtotal - Math.round(subtotal * 0.1)) * 0.2),
    );
    expect(withPromo.baseIdr).toBe(
      withoutPromo.baseIdr - promoResult.totalDiscountIdr,
    );
    expect(withPromo.serviceChargeIdr).toBeLessThan(
      withoutPromo.serviceChargeIdr,
    );
    expect(withPromo.taxIdr).toBeLessThan(withoutPromo.taxIdr);
    expect(withPromo.totalIdr).toBe(
      withPromo.baseIdr +
        withPromo.serviceChargeIdr +
        withPromo.taxIdr +
        withPromo.roundingIdr,
    );
  });
});

describe("Money invariants over generated bills", () => {
  // Small deterministic PRNG so failures reproduce.
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
  }

  it("discounts are whole rupiah, never negative, never above the bill, and add up", () => {
    const random = rng(7_4_2026);
    for (let round = 0; round < 300; round += 1) {
      const subtotal = 1 + Math.floor(random() * 2_000_000);
      const promotions = Array.from(
        { length: 1 + Math.floor(random() * 5) },
        () =>
          random() < 0.5
            ? percent(1 + Math.floor(random() * 10_000), {
                priority: Math.floor(random() * 5),
                stackGroup:
                  random() < 0.3
                    ? "same"
                    : `g${round}${Math.floor(random() * 1e6)}`,
              })
            : promo({
                priority: Math.floor(random() * 5),
                benefit: {
                  kind: "nominal_off",
                  amountIdr: idr(1 + Math.floor(random() * 300_000)),
                },
              }),
      );
      const policy = random() < 0.5 ? defaultPromoStackingPolicy : stackable(3);
      const result = applyPromotions(promotions, bill(subtotal), [], policy);
      let sum = 0;
      for (const evaluation of result.evaluations)
        if (evaluation.applied) {
          expect(Number.isSafeInteger(evaluation.discountIdr)).toBe(true);
          expect(evaluation.discountIdr).toBeGreaterThanOrEqual(0);
          sum += evaluation.discountIdr;
        }
      expect(result.totalDiscountIdr).toBe(sum);
      expect(result.totalDiscountIdr).toBeLessThanOrEqual(subtotal);
      expect(
        applyPromotions([...promotions].reverse(), bill(subtotal), [], policy)
          .totalDiscountIdr,
      ).toBe(result.totalDiscountIdr);
    }
  });
});
