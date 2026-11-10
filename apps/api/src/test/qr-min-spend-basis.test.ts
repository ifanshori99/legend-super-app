// Zone minimum spend basis (legend-v9fh, owner decision Q53): the minimum is
// measured on the bill value BEFORE tax (and service charge), also at an outlet
// whose prices include tax (harga nett). Exclusive outlets are unchanged.
// Pure functions, no database: `buildQuote` with an inclusive and an exclusive
// tax rule.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { idr, outletIdSchema } from "@starter/shared/core";
import type {
  ServiceChargeRule,
  TaxRule,
  TaxSettings,
} from "@starter/shared/tax";
import { buildQuote, type QrTaxConfig } from "../services/qr-order-pricing";

const tenantId = randomUUID();
const outletId = outletIdSchema.parse(randomUUID());
const context = { tenant: { tenantId } } as unknown as ScopedTenantContext;
const categoryId = randomUUID();
const menuItemId = randomUUID();
const ruleId = randomUUID();

const taxRuleWith = (priceIncludesTax: boolean) =>
  ({
    id: ruleId,
    tenantId,
    outletId: null,
    code: "PB1",
    name: "PB1 10%",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: null,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax,
    includeServiceInBase: true,
    isActive: true,
    version: 1,
    effectiveFrom: "2026-01-01",
    status: "published",
    publishedAt: null,
    publishedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as TaxRule;
const serviceRule = {
  id: randomUUID(),
  tenantId,
  outletId,
  code: "SVC-OUTLET",
  name: "Service outlet",
  rateBp: 500,
  zoneId: null,
  orderTypes: [],
  itemClasses: ["food_beverage"],
  isActive: true,
  version: 1,
  effectiveFrom: "2026-01-01",
  status: "published",
  publishedAt: null,
  publishedBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as ServiceChargeRule;
const settings = {
  id: randomUUID(),
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
  status: "published",
} as unknown as TaxSettings;
const configWith = (priceIncludesTax: boolean): QrTaxConfig => ({
  taxRules: [taxRuleWith(priceIncludesTax)],
  settings: [settings],
  serviceChargeRules: [serviceRule],
  ruleNames: new Map([[ruleId, "PB1 10%"]]),
});

function quoteWith(priceIncludesTax: boolean, minimumSpendIdr: number) {
  return buildQuote({
    context,
    sessionId: randomUUID(),
    cartVersion: 1,
    outletId,
    businessDate: "2026-11-02",
    zone: {
      id: randomUUID(),
      tenantId,
      outletId,
      serviceChargeBp: 0,
      minimumSpendIdr,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as never,
    lines: [
      {
        cartLineId: randomUUID(),
        menuItemId,
        categoryId,
        name: "Nasi",
        quantity: 1,
        unitPriceIdr: idr(100_000),
        modifiersTotalIdr: idr(0),
      },
    ],
    removedLines: [],
    priceChanges: [],
    promo: null,
    promoCode: null,
    taxConfig: configWith(priceIncludesTax),
    servingEstimate: null,
    now: new Date("2026-11-02T03:00:00.000Z"),
  }).quote;
}

describe("zone minimum spend basis (Q53)", () => {
  it("inclusive: the gross price no longer clears a minimum equal to it", () => {
    const quote = quoteWith(true, 100_000);
    expect(quote.pricesIncludeTaxAndService).toBe(true);
    expect(quote.subtotalIdr).toBe(100_000);
    const charges = quote.serviceCharge.amountIdr + quote.taxIdr;
    expect(charges).toBeGreaterThan(0);
    expect(quote.minimumSpend.shortfallIdr).toBe(charges);
  });

  it("inclusive: a pre-tax value exactly at the threshold clears it", () => {
    const probe = quoteWith(true, 0);
    const preTax =
      probe.subtotalIdr - probe.serviceCharge.amountIdr - probe.taxIdr;
    expect(quoteWith(true, preTax).minimumSpend.shortfallIdr).toBe(0);
    expect(quoteWith(true, preTax + 1).minimumSpend.shortfallIdr).toBe(1);
  });

  it("exclusive: unchanged, measured on subtotal minus discount", () => {
    const at = quoteWith(false, 100_000);
    expect(at.pricesIncludeTaxAndService).toBe(false);
    expect(at.minimumSpend.shortfallIdr).toBe(0);
    expect(quoteWith(false, 100_001).minimumSpend.shortfallIdr).toBe(1);
  });
});
