// QR and POS price a zone the same way (WS-03 S4, architect finding 5): a zone
// with no service charge falls back to the outlet's published service charge
// rules in BOTH paths (they share `selectServiceChargeRules`). Pure functions,
// no database: the same config goes through `buildQuote` and `computePosBill`.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { idr, outletIdSchema } from "@starter/shared/core";
import type {
  ServiceChargeRule,
  TaxRule,
  TaxSettings,
} from "@starter/shared/tax";
import { computePosBill } from "../services/pos-order-pricing";
import { buildQuote, type QrTaxConfig } from "../services/qr-order-pricing";

const tenantId = randomUUID();
const outletId = outletIdSchema.parse(randomUUID());
const context = { tenant: { tenantId } } as unknown as ScopedTenantContext;
const categoryId = randomUUID();
const menuItemId = randomUUID();
const ruleId = randomUUID();

const taxRule = {
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
  priceIncludesTax: false,
  includeServiceInBase: true,
  isActive: true,
  version: 1,
  effectiveFrom: "2026-01-01",
  status: "published",
  publishedAt: null,
  publishedBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as TaxRule;
const outletServiceRule = {
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
const taxConfig: QrTaxConfig = {
  taxRules: [taxRule],
  settings: [settings],
  serviceChargeRules: [outletServiceRule],
  ruleNames: new Map([[ruleId, taxRule.name]]),
};

const zoneWith = (serviceChargeBp: number) =>
  ({
    id: randomUUID(),
    tenantId,
    outletId,
    serviceChargeBp,
    minimumSpendIdr: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }) as never;

function bothPaths(zone: ReturnType<typeof zoneWith>) {
  const now = new Date("2026-11-02T03:00:00.000Z");
  const qr = buildQuote({
    context,
    sessionId: randomUUID(),
    cartVersion: 1,
    outletId,
    businessDate: "2026-11-02",
    zone,
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
    taxConfig,
    servingEstimate: null,
    now,
  });
  const pos = computePosBill({
    context,
    outletId,
    businessDate: "2026-11-02",
    channel: "dine_in",
    zone,
    lines: [
      {
        lineId: randomUUID(),
        menuItemId,
        categoryId,
        quantity: 1,
        unitPriceIdr: 100_000,
        modifiersTotalIdr: 0,
      },
    ],
    orderDiscountIdr: 0,
    taxConfig,
  });
  return { qr: qr.quote, pos };
}

describe("QR = POS service charge selection", () => {
  it("a zone with no charge falls back to the outlet rule in both paths", () => {
    const { qr, pos } = bothPaths(zoneWith(0));
    expect(pos.serviceChargeIdr).toBe(5_000);
    expect(qr.serviceCharge.amountIdr).toBe(pos.serviceChargeIdr);
    expect(qr.serviceCharge.rateBp).toBe(500);
    expect(qr.taxIdr).toBe(pos.taxIdr);
    expect(qr.totalIdr).toBe(pos.totalIdr);
    expect(qr.totalIdr).toBe(115_500);
  });

  it("a zone with its own charge wins over the outlet rule in both paths", () => {
    const { qr, pos } = bothPaths(zoneWith(1000));
    expect(pos.serviceChargeIdr).toBe(10_000);
    expect(qr.serviceCharge.amountIdr).toBe(10_000);
    expect(qr.serviceCharge.rateBp).toBe(1000);
    expect(qr.totalIdr).toBe(pos.totalIdr);
  });
});
