// Cafe Legend tax fixtures (FE mock mode + contract tests). PRD facts: Kota
// Bandung, PBJT makanan dan/atau minuman 10% (Perda Kota Bandung No. 1/2024,
// D13). Illustrative, not owner-confirmed: the 5% Private Room service charge,
// the facility rule (its rate waits for the tax consultant, A20 — it is data
// the admin changes from the panel, R21) and every amount below.
//
// Owner decision (2026-11-01): menu prices exclude tax and service charge, so
// the tenant settings default and every menu rule below are `exclusive`
// (priceIncludesTax false) and checkout adds both. Inclusive prices are an
// opt-in configuration, exercised only by the contract tests.

import { cafeLegendFixtures } from "../core/index.ts";
import { cafeLegendMenuFixtures } from "../menu/fixtures.ts";
import {
  pbjtMonthlyRecapSchema,
  serviceChargeRuleSchema,
  taxCalculationInputSchema,
  taxRuleSchema,
  taxSettingsSchema,
} from "./schemas.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outlet = outlets[0];
const item = (name: string) => {
  const found = cafeLegendMenuFixtures.items.find((i) => i.name === name);
  if (!found) throw new Error(`Missing menu fixture ${name}`);
  return found;
};
const tid = (n: number) =>
  `7a000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const finance = "5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const published = {
  status: "published" as const,
  publishedAt: "2026-10-25T03:00:00.000Z",
  publishedBy: finance,
  createdAt: "2026-10-24T09:00:00.000Z",
};
/** Kota Bandung (BPS 3273, Jawa Barat). */
export const BANDUNG_REGION = "ID-JB-3273";
/** Private Room zone of Cafe Legend Bandung; matches the WS-03 floor fixture
 * (`cafeLegendQrOrderFixtures.zones`, "Private Room Nusantara"). */
export const PRIVATE_ROOM_ZONE_ID = "00000000-0000-4000-8000-000000000102";
/** Facility service items (WS-09). */
export const SHOWER_ITEM_ID = tid(910);
export const BREAKFAST_PACKAGE_ITEM_ID = tid(911);

const taxRules = [
  {
    id: tid(1),
    tenantId: tenant.id,
    outletId: null,
    code: "PBJT-FNB",
    name: "PBJT Makanan dan Minuman",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: BANDUNG_REGION,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: true,
    isActive: true,
    version: 1,
    effectiveFrom: "2026-11-01",
    ...published,
  },
  {
    id: tid(2),
    tenantId: tenant.id,
    outletId: null,
    code: "PBJT-FASILITAS",
    name: "Pajak layanan fasilitas",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: BANDUNG_REGION,
    channels: [],
    appliesTo: { itemClasses: ["facility"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: false,
    isActive: true,
    version: 1,
    effectiveFrom: "2026-11-01",
    ...published,
  },
  {
    id: tid(3),
    tenantId: tenant.id,
    outletId: null,
    code: "PBJT-FNB",
    name: "PBJT Makanan dan Minuman (draf revisi)",
    taxType: "pbjt",
    rateBp: 1000,
    regionCode: BANDUNG_REGION,
    channels: [],
    appliesTo: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
    priceIncludesTax: false,
    includeServiceInBase: true,
    isActive: true,
    version: 2,
    effectiveFrom: "2027-01-01",
    status: "draft",
    publishedAt: null,
    publishedBy: null,
    createdAt: "2026-10-30T09:00:00.000Z",
  },
].map((rule) => taxRuleSchema.parse(rule));

const serviceChargeRules = [
  {
    id: tid(20),
    tenantId: tenant.id,
    outletId: outlet.id,
    code: "SC-PRIVATE-ROOM",
    name: "Service charge Private Room",
    rateBp: 500,
    zoneId: PRIVATE_ROOM_ZONE_ID,
    orderTypes: ["dine_in"],
    itemClasses: ["food_beverage"],
    isActive: true,
    version: 1,
    effectiveFrom: "2026-11-01",
    ...published,
  },
].map((rule) => serviceChargeRuleSchema.parse(rule));

const settings = [
  {
    id: tid(40),
    tenantId: tenant.id,
    outletId: null,
    calculationOrder: "discount_service_tax",
    pricesIncludeTax: false,
    serviceRoundingMode: "half_up",
    taxRoundingMode: "half_up",
    inclusiveBaseRoundingMode: "half_up",
    billRounding: null,
    packageAllocation: "fixed_bp",
    version: 1,
    effectiveFrom: "2026-11-01",
    ...published,
  },
].map((row) => taxSettingsSchema.parse(row));

const kopi = item("Kopi Susu Aren");
const nasi = item("Nasi Goreng Kampung");
const croissant = item("Croissant Mentega");

/** Private Room bill: two drinks, a main, and Paket Sarapan + Shower. */
const privateRoomBill = taxCalculationInputSchema.parse({
  outletId: outlet.id,
  businessDate: "2026-11-02",
  channel: "dine_in",
  zoneId: PRIVATE_ROOM_ZONE_ID,
  regionCode: BANDUNG_REGION,
  orderDiscountIdr: 10_000,
  lines: [
    {
      lineId: "L1",
      itemId: kopi.id,
      categoryId: kopi.categoryId,
      itemClass: "food_beverage",
      grossIdr: 56_000,
      discountIdr: 0,
      components: [],
    },
    {
      lineId: "L2",
      itemId: nasi.id,
      categoryId: nasi.categoryId,
      itemClass: "food_beverage",
      grossIdr: 45_000,
      discountIdr: 5_000,
      components: [],
    },
    {
      lineId: "L3",
      itemId: BREAKFAST_PACKAGE_ITEM_ID,
      categoryId: null,
      itemClass: "food_beverage",
      grossIdr: 85_000,
      discountIdr: 0,
      components: [
        {
          componentId: tid(950),
          itemId: croissant.id,
          categoryId: croissant.categoryId,
          itemClass: "food_beverage",
          allocationBp: 4000,
          standalonePriceIdr: 30_000,
        },
        {
          componentId: tid(951),
          itemId: SHOWER_ITEM_ID,
          categoryId: null,
          itemClass: "facility",
          allocationBp: 6000,
          standalonePriceIdr: 60_000,
        },
      ],
    },
  ],
});

const pbjtRecap = pbjtMonthlyRecapSchema.parse({
  tenantId: tenant.id,
  outletId: outlet.id,
  period: "2026-11",
  regionCode: BANDUNG_REGION,
  generatedAt: "2026-12-01T01:00:00.000Z",
  rows: [
    {
      taxRuleCode: "PBJT-FNB",
      rateBp: 1000,
      priceIncludesTax: false,
      transactionCount: 4_812,
      grossSalesIdr: 412_350_000,
      taxBaseIdr: 398_120_000,
      serviceChargeIdr: 6_240_000,
      taxIdr: 39_812_000,
    },
    {
      taxRuleCode: "PBJT-FASILITAS",
      rateBp: 1000,
      priceIncludesTax: false,
      transactionCount: 386,
      grossSalesIdr: 21_840_000,
      taxBaseIdr: 21_840_000,
      serviceChargeIdr: 0,
      taxIdr: 2_184_000,
    },
  ],
  totalTaxBaseIdr: 419_960_000,
  totalTaxIdr: 41_996_000,
});

export const cafeLegendTaxFixtures = {
  taxRules,
  serviceChargeRules,
  settings,
  privateRoomBill,
  pbjtRecap,
  financeUserId: finance,
};
