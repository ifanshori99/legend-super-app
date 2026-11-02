// Property tests for the pure tax engine (PRD v1.7 §3.14 F11 "Opsi
// Perhitungan" — rounding; ORD-06 split totals; bead legend-559). The engine
// lives in packages/shared/src/tax/calculate.ts and is what QR, POS, website
// and facility all run, so these invariants are checked over randomised bills,
// rates and rounding modes: no combination may lose or invent a rupiah.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as tax from "../packages/shared/src/tax/index.ts";

/** Deterministic LCG so a failure is reproducible from the seed in its name. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const uuid = (n) => `9f000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ROUNDING = ["half_up", "half_even", "down", "ceil"];
const published = {
  status: "published",
  publishedAt: "2026-10-25T03:00:00.000Z",
  publishedBy: "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  createdAt: "2026-10-24T09:00:00.000Z",
};
const outletId = uuid(1);
const businessDate = "2026-11-02";
const tenantId = "3f8b7c1e-2d4a-4e6b-9c0d-1a2b3c4d5e6f";

const rule = (n, overrides) =>
  tax.taxRuleSchema.parse({
    id: uuid(100 + n),
    tenantId,
    outletId: null,
    code: `PBJT-P${n}`,
    name: `Rule ${n}`,
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: null,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: true,
    isActive: true,
    version: 1,
    effectiveFrom: "2026-01-01",
    ...published,
    ...overrides,
  });

const serviceRule = (n, rateBp) =>
  tax.serviceChargeRuleSchema.parse({
    id: uuid(200 + n),
    tenantId,
    outletId,
    code: `SC-P${n}`,
    name: `Service ${n}`,
    rateBp,
    zoneId: null,
    orderTypes: [],
    itemClasses: ["food_beverage"],
    isActive: true,
    version: 1,
    effectiveFrom: "2026-01-01",
    ...published,
  });

const settings = (overrides) =>
  tax.taxSettingsSchema.parse({
    id: uuid(300),
    tenantId,
    outletId: null,
    calculationOrder: "discount_service_tax",
    pricesIncludeTax: false,
    serviceRoundingMode: "half_up",
    taxRoundingMode: "half_up",
    inclusiveBaseRoundingMode: "half_up",
    billRounding: null,
    packageAllocation: "fixed_bp",
    version: 1,
    effectiveFrom: "2026-01-01",
    ...published,
    ...overrides,
  });

function bill(next) {
  const count = 1 + Math.floor(next() * 5);
  const lines = Array.from({ length: count }, (_, index) => {
    const grossIdr = Math.floor(next() * 500_000) + 1;
    return {
      lineId: `L${index + 1}`,
      itemId: uuid(500 + index),
      categoryId: null,
      itemClass: "food_beverage",
      grossIdr,
      discountIdr: Math.floor(next() * grossIdr * 0.3),
      components: [],
    };
  });
  const net = lines.reduce(
    (sum, line) => sum + line.grossIdr - line.discountIdr,
    0,
  );
  return tax.taxCalculationInputSchema.parse({
    outletId,
    businessDate,
    channel: "dine_in",
    zoneId: null,
    regionCode: null,
    lines,
    orderDiscountIdr: Math.floor(next() * net * 0.2),
  });
}

test("F11 property: random exclusive bills keep every rupiah (1000 bills)", () => {
  for (let seed = 1; seed <= 1000; seed += 1) {
    const next = random(seed);
    const input = bill(next);
    const config = {
      taxRules: [
        rule(1, {
          rateBp: Math.floor(next() * 1001),
          includeServiceInBase: next() < 0.5,
        }),
      ],
      serviceChargeRules: [serviceRule(1, Math.floor(next() * 1001))],
      settings: [
        settings({
          serviceRoundingMode: ROUNDING[Math.floor(next() * ROUNDING.length)],
          taxRoundingMode: ROUNDING[Math.floor(next() * ROUNDING.length)],
          billRounding:
            next() < 0.3
              ? {
                  incrementIdr: [100, 500, 1000][Math.floor(next() * 3)],
                  mode: "half_up",
                }
              : null,
        }),
      ],
    };
    const result = tax.calculateTax(input, config);
    tax.taxCalculationResultSchema.parse(result);
    const sum = (values) => values.reduce((total, value) => total + value, 0);
    for (const line of result.lines) {
      assert.equal(
        line.baseIdr + line.serviceChargeIdr + line.taxIdr,
        line.totalIdr,
        `seed ${seed}: line parts must sum to its total`,
      );
      assert.ok(
        line.discountIdr >= 0 && line.discountIdr <= line.grossIdr,
        `seed ${seed}: discount stays inside the line`,
      );
      // Exclusive prices: the sales base is the discounted gross.
      assert.equal(
        line.baseIdr,
        line.grossIdr - line.discountIdr,
        `seed ${seed}: base equals the discounted gross`,
      );
      assert.ok(
        line.serviceChargeIdr >= 0 && line.taxIdr >= 0,
        `seed ${seed}: no negative part`,
      );
    }
    assert.equal(
      sum(result.lines.map((line) => line.totalIdr)) + result.roundingIdr,
      result.totalIdr,
      `seed ${seed}: rounded total equals the sum of line totals`,
    );
    assert.equal(
      result.taxIdr,
      sum(result.taxes.map((row) => row.taxIdr)),
      `seed ${seed}: summary tax equals the sum of tax rows`,
    );
    assert.equal(
      result.serviceChargeIdr,
      sum(result.lines.map((line) => line.serviceChargeIdr)),
      `seed ${seed}: service total equals the sum of line service`,
    );
    assert.equal(
      result.baseIdr,
      sum(result.lines.map((line) => line.baseIdr)),
      `seed ${seed}: base total equals the sum of line bases`,
    );
    assert.equal(result.grossIdr - result.discountIdr, result.baseIdr);
    assert.deepEqual(
      tax.calculateTax(input, config),
      result,
      `seed ${seed}: calculation is deterministic`,
    );
  }
});

test("F11 property: inclusive prices back out exactly, whatever the rounding (500 bills)", () => {
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  for (let seed = 1; seed <= 500; seed += 1) {
    const next = random(seed * 7919);
    const input = bill(next);
    const config = {
      taxRules: [
        rule(2, {
          rateBp: Math.floor(next() * 1001),
          priceIncludesTax: true,
          includeServiceInBase: next() < 0.5,
        }),
      ],
      serviceChargeRules: [serviceRule(2, Math.floor(next() * 1001))],
      settings: [
        settings({
          pricesIncludeTax: true,
          serviceRoundingMode: ROUNDING[Math.floor(next() * ROUNDING.length)],
          taxRoundingMode: ROUNDING[Math.floor(next() * ROUNDING.length)],
          inclusiveBaseRoundingMode:
            ROUNDING[Math.floor(next() * ROUNDING.length)],
        }),
      ],
    };
    const result = tax.calculateTax(input, config);
    tax.taxCalculationResultSchema.parse(result);
    for (const line of result.lines) {
      assert.equal(
        line.baseIdr + line.serviceChargeIdr + line.taxIdr,
        line.totalIdr,
        `seed ${seed}: inclusive parts sum to the price exactly`,
      );
      // The group price is exact; allocating the three parts across lines can
      // move one rupiah between neighbours (largest remainder), never the bill.
      assert.ok(
        Math.abs(line.totalIdr - (line.grossIdr - line.discountIdr)) <= 1,
        `seed ${seed}: an all-in line is not raised by tax`,
      );
      assert.ok(
        line.baseIdr >= 0 && line.serviceChargeIdr >= 0 && line.taxIdr >= 0,
        `seed ${seed}: backing out never goes negative`,
      );
    }
    assert.equal(
      result.totalIdr,
      result.grossIdr - result.discountIdr,
      `seed ${seed}: bill total equals the menu amount`,
    );
    assert.equal(
      sum(result.lines.map((line) => line.taxIdr)),
      result.taxIdr,
      `seed ${seed}: tax rows reconcile`,
    );
  }
});

test("A20 property: mixed packages allocate the line price exactly (300 bills)", () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = random(seed * 104_729);
    const grossIdr = Math.floor(next() * 900_000) + 2;
    const shares = [1000 + Math.floor(next() * 4000)];
    shares.push(10_000 - shares[0]);
    const input = tax.taxCalculationInputSchema.parse({
      outletId,
      businessDate,
      channel: "dine_in",
      zoneId: null,
      regionCode: null,
      orderDiscountIdr: 0,
      lines: [
        {
          lineId: "PKG",
          itemId: uuid(900),
          categoryId: null,
          itemClass: "food_beverage",
          grossIdr,
          discountIdr: 0,
          components: [
            {
              componentId: uuid(901),
              itemId: uuid(902),
              categoryId: null,
              itemClass: "food_beverage",
              allocationBp: shares[0],
              standalonePriceIdr: null,
            },
            {
              componentId: uuid(903),
              itemId: uuid(904),
              categoryId: null,
              itemClass: "food_beverage",
              allocationBp: shares[1],
              standalonePriceIdr: null,
            },
          ],
        },
      ],
    });
    const result = tax.calculateTax(input, {
      taxRules: [
        rule(3, {
          rateBp: Math.floor(next() * 1001),
          includeServiceInBase: false,
        }),
      ],
      serviceChargeRules: [],
      settings: [settings({ packageAllocation: "fixed_bp" })],
    });
    const components = result.lines.filter((line) => line.componentId !== null);
    assert.equal(components.length, 2, `seed ${seed}: both components taxed`);
    assert.equal(
      components.reduce((total, line) => total + line.grossIdr, 0),
      grossIdr,
      `seed ${seed}: components allocate the package price exactly`,
    );
    for (const line of components)
      assert.equal(
        line.baseIdr + line.serviceChargeIdr + line.taxIdr,
        line.totalIdr,
        `seed ${seed}: component parts sum to its total`,
      );
  }
});
