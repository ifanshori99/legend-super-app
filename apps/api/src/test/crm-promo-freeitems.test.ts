// Free-item promotions free the cheapest eligible units first, and the free
// units named on a redemption always match the discount actually given (PRD
// §3.21 "Promo Engine", ORD-03; bead legend-w3zf, coordinator decision). Pure
// core, no database: `crm-promo-engine.ts` persists `evaluation.freeItems`
// from this result unchanged.
import { describe, expect, it } from "vitest";
import {
  applyPromotions,
  evaluatePromotion,
  type PromoEvaluationInput,
  type PromoLine,
  type Promotion,
  type PromotionEvaluation,
} from "@starter/shared/crm";
import { idr } from "@starter/shared/core";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ITEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ITEM_B = "aaaaaaaa-0000-4000-8000-000000000002";
const ITEM_C = "aaaaaaaa-0000-4000-8000-000000000003";
const AT = "2026-11-02T09:00:00.000Z";

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

/** "Buy `buy` of `items`, get `free` of `items` free" (same eligible set). */
function buyGetFree(
  items: string[],
  buy: number,
  free: number,
  extra: Partial<Promotion> = {},
): Promotion {
  return promo({
    conditions: [
      { kind: "item_quantity", menuItemIds: items, minQuantity: buy },
    ],
    benefit: {
      kind: "free_items",
      menuItemIds: items,
      quantityPerMultiple: free,
    },
    ...extra,
  });
}

function line(
  menuItemId: string,
  quantity: number,
  unitPrice: number,
  lineTotal = quantity * unitPrice,
): PromoLine {
  return {
    menuItemId,
    quantity,
    unitPriceIdr: idr(unitPrice),
    lineTotalIdr: idr(lineTotal),
  };
}

function bill(
  lines: PromoLine[],
  subtotal = lines.reduce((sum, entry) => sum + entry.lineTotalIdr, 0),
): PromoEvaluationInput {
  return {
    at: AT,
    channel: "dine_in",
    localDayOfWeek: 1,
    localTime: "16:00",
    subtotalIdr: idr(subtotal),
    lines,
    customer: null,
    voucherPromotionId: null,
  };
}

/** Value of the named free units, one line per item in these tests. */
function freeValue(evaluation: PromotionEvaluation, lines: PromoLine[]) {
  if (!evaluation.applied) return 0;
  return evaluation.freeItems.reduce((sum, item) => {
    const source = lines.find((entry) => entry.menuItemId === item.menuItemId);
    if (!source) throw new Error("free item without a line");
    return (
      sum +
      item.quantity *
        Math.min(
          source.unitPriceIdr,
          Math.floor(source.lineTotalIdr / source.quantity),
        )
    );
  }, 0);
}

const stackable = {
  mode: "stackable",
  maxStacked: 5,
  allowSameGroup: false,
} as const;

describe("legend-w3zf free-item promotions free the cheapest eligible units first", () => {
  it("[W3ZF-1] buy 1 get 1 on a mixed-price set frees the cheaper item, whatever the line order", () => {
    const promotion = buyGetFree([ITEM_A, ITEM_B], 1, 1);
    const lines = [line(ITEM_A, 1, 30_000), line(ITEM_B, 1, 20_000)];
    for (const order of [lines, [...lines].reverse()])
      expect(evaluatePromotion(promotion, bill(order))).toMatchObject({
        applied: true,
        discountIdr: 20_000,
        freeItems: [{ menuItemId: ITEM_B, quantity: 1 }],
      });
  });

  it("[W3ZF-1] an allowance spanning lines takes the cheapest units in ascending order", () => {
    // 5 units, buy 1 get 1 → 2 free: B (20.000) then C (25.000), never A.
    const promotion = buyGetFree([ITEM_A, ITEM_B, ITEM_C], 1, 1);
    const lines = [
      line(ITEM_A, 3, 30_000),
      line(ITEM_C, 1, 25_000),
      line(ITEM_B, 1, 20_000),
    ];
    expect(evaluatePromotion(promotion, bill(lines))).toMatchObject({
      applied: true,
      discountIdr: 45_000,
      freeItems: [
        { menuItemId: ITEM_B, quantity: 1 },
        { menuItemId: ITEM_C, quantity: 1 },
      ],
    });
  });

  it("[W3ZF-1] B1G1 on the same item still needs X + Y units", () => {
    const promotion = buyGetFree([ITEM_A], 1, 1);
    expect(
      evaluatePromotion(promotion, bill([line(ITEM_A, 1, 30_000)])),
    ).toMatchObject({ applied: false, reason: "no_matching_items" });
    expect(
      evaluatePromotion(promotion, bill([line(ITEM_A, 3, 30_000)])),
    ).toMatchObject({
      applied: true,
      discountIdr: 30_000,
      freeItems: [{ menuItemId: ITEM_A, quantity: 1 }],
    });
  });

  it("[W3ZF-2] equal unit values break ties by menu item id, independent of line order", () => {
    const promotion = buyGetFree([ITEM_A, ITEM_B, ITEM_C], 1, 1);
    const lines = [
      line(ITEM_C, 1, 25_000),
      line(ITEM_B, 1, 25_000),
      line(ITEM_A, 2, 25_000),
    ];
    const permutations = [
      lines,
      [...lines].reverse(),
      [lines[1], lines[2], lines[0]] as PromoLine[],
    ];
    const results = permutations.map((order) =>
      evaluatePromotion(promotion, bill(order)),
    );
    // 4 units → 2 free, both from ITEM_A (lowest id at the shared price).
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      applied: true,
      discountIdr: 50_000,
      freeItems: [{ menuItemId: ITEM_A, quantity: 2 }],
    });
  });

  it("[W3ZF-2] two lines of one item are reported as a single free entry", () => {
    const promotion = buyGetFree([ITEM_A], 1, 1);
    const lines = [line(ITEM_A, 2, 30_000), line(ITEM_A, 2, 30_000)];
    expect(evaluatePromotion(promotion, bill(lines))).toMatchObject({
      applied: true,
      discountIdr: 60_000,
      freeItems: [{ menuItemId: ITEM_A, quantity: 2 }],
    });
  });

  it("[W3ZF-3] an item-level-discounted line is valued at its line value, so it can be the cheapest", () => {
    // A lists at 30.000 but carries a member price: 2 units for 40.000 → 20.000
    // each, cheaper than B at 25.000, so the free unit is an A worth 20.000.
    const promotion = buyGetFree([ITEM_A, ITEM_B], 1, 1);
    const lines = [line(ITEM_B, 1, 25_000), line(ITEM_A, 2, 30_000, 40_000)];
    expect(evaluatePromotion(promotion, bill(lines))).toMatchObject({
      applied: true,
      discountIdr: 20_000,
      freeItems: [{ menuItemId: ITEM_A, quantity: 1 }],
    });
  });

  it("[W3ZF-3] a discounted unit value rounds down and never exceeds the line", () => {
    const promotion = buyGetFree([ITEM_A], 1, 1);
    const lines = [line(ITEM_A, 3, 30_000, 50_000)]; // 16.666,67 → 16.666
    const result = evaluatePromotion(promotion, bill(lines));
    expect(result).toMatchObject({
      applied: true,
      discountIdr: 16_666,
      freeItems: [{ menuItemId: ITEM_A, quantity: 1 }],
    });
  });
});

describe("legend-w3zf comped (Rp0) units never consume the free slot", () => {
  const buyCoffeeGetCake = () =>
    promo({
      conditions: [
        { kind: "item_quantity", menuItemIds: [ITEM_A], minQuantity: 1 },
      ],
      benefit: {
        kind: "free_items",
        menuItemIds: [ITEM_B],
        quantityPerMultiple: 1,
      },
    });

  it("[W3ZF-6] a comped free item is skipped, so the slot frees the paid unit instead", () => {
    // Buy one coffee (A), get one cake (B). The guest has a comped cake
    // (line total 0) and a paid cake: the paid one is the benefit.
    const promotion = buyCoffeeGetCake();
    const lines = [
      line(ITEM_A, 1, 30_000),
      line(ITEM_B, 1, 0),
      line(ITEM_B, 1, 20_000),
    ];
    for (const order of [lines, [...lines].reverse()])
      expect(evaluatePromotion(promotion, bill(order))).toMatchObject({
        applied: true,
        discountIdr: 20_000,
        freeItems: [{ menuItemId: ITEM_B, quantity: 1 }],
      });
  });

  it("[W3ZF-6] a bill whose only eligible unit is comped grants no phantom free item", () => {
    const promotion = buyCoffeeGetCake();
    const lines = [line(ITEM_A, 1, 30_000), line(ITEM_B, 1, 0)];
    expect(evaluatePromotion(promotion, bill(lines))).toMatchObject({
      applied: false,
      reason: "no_matching_items",
    });
  });
});

describe("legend-w3zf a capped free-item discount names only the units it paid for", () => {
  it("[W3ZF-4] a direct cap frees the cheapest whole units that fit; freeItems matches the discount", () => {
    const promotion = buyGetFree([ITEM_A, ITEM_B], 1, 3);
    const lines = [line(ITEM_A, 3, 30_000), line(ITEM_B, 1, 20_000)];
    // 4 units, buy 1 get 3 → 3 free wanted (B + 2 A = 80.000); only 55.000
    // is discountable: B (20.000) + one A (30.000) = 50.000 fits, a second A
    // does not, so the discount is 50.000, not a clamped 55.000.
    const result = evaluatePromotion(promotion, bill(lines), undefined, {
      discountableIdr: idr(55_000),
    });
    expect(result).toMatchObject({
      applied: true,
      discountIdr: 50_000,
      freeItems: [
        { menuItemId: ITEM_B, quantity: 1 },
        { menuItemId: ITEM_A, quantity: 1 },
      ],
    });
    expect(freeValue(result, lines)).toBe(50_000);
  });

  it("[W3ZF-4] a cap below the cheapest unit frees nothing instead of a phantom item", () => {
    const promotion = buyGetFree([ITEM_A], 1, 1);
    const result = evaluatePromotion(
      promotion,
      bill([line(ITEM_A, 2, 30_000)]),
      undefined,
      { discountableIdr: idr(29_999) },
    );
    expect(result).toMatchObject({ applied: false, reason: "not_selected" });
  });

  it("[W3ZF-4] stackable mode: the second item-level promotion's freeItems shrinks to the remaining amount", () => {
    // Bill 3 × A 30.000 + 1 × B 20.000 = 110.000.
    // P1 (priority 5) buy 1 get 1: B + A = 50.000 → 60.000 left.
    // P2 (priority 0) buy 1 get 3: wants B + A + A = 80.000, only B + A fit.
    const lines = [line(ITEM_A, 3, 30_000), line(ITEM_B, 1, 20_000)];
    const first = buyGetFree([ITEM_A, ITEM_B], 1, 1, { priority: 5 });
    const second = buyGetFree([ITEM_A, ITEM_B], 1, 3, { priority: 0 });
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const result = applyPromotions(order, bill(lines), [], stackable);
      const byId = new Map(
        result.evaluations.map((entry) => [entry.promotionId, entry]),
      );
      const p1 = byId.get(first.id) as PromotionEvaluation;
      const p2 = byId.get(second.id) as PromotionEvaluation;
      expect(p1).toMatchObject({ applied: true, discountIdr: 50_000 });
      expect(p2).toMatchObject({
        applied: true,
        discountIdr: 50_000,
        freeItems: [
          { menuItemId: ITEM_B, quantity: 1 },
          { menuItemId: ITEM_A, quantity: 1 },
        ],
      });
      for (const entry of [p1, p2])
        if (entry.applied)
          expect(freeValue(entry, lines)).toBe(entry.discountIdr);
      expect(result.totalDiscountIdr).toBe(100_000);
    }
  });

  it("[W3ZF-5] stacked free items never push the bill below zero and never overstate freeItems", () => {
    const lines = [
      line(ITEM_A, 4, 30_000),
      line(ITEM_B, 2, 20_000, 30_000),
      line(ITEM_C, 1, 5_000),
    ];
    const subtotal = 155_000;
    const promotions = [
      buyGetFree([ITEM_A, ITEM_B, ITEM_C], 1, 1, { priority: 3 }),
      buyGetFree([ITEM_A, ITEM_B, ITEM_C], 1, 2, { priority: 2 }),
      buyGetFree([ITEM_A], 1, 3, { priority: 1 }),
      promo({
        priority: 0,
        benefit: { kind: "nominal_off", amountIdr: idr(500_000) },
      }),
    ];
    for (const order of [promotions, [...promotions].reverse()]) {
      const result = applyPromotions(
        order,
        bill(lines, subtotal),
        [],
        stackable,
      );
      let sum = 0;
      for (const entry of result.evaluations) {
        if (!entry.applied) continue;
        expect(entry.discountIdr).toBeGreaterThanOrEqual(0);
        if (entry.freeItems.length > 0)
          expect(freeValue(entry, lines)).toBe(entry.discountIdr);
        sum += entry.discountIdr;
      }
      expect(result.totalDiscountIdr).toBe(sum);
      expect(subtotal - result.totalDiscountIdr).toBeGreaterThanOrEqual(0);
    }
  });
});
