// Cafe Legend mock data for the core conventions (FE mock mode + contract
// tests). Facts from PRD v1.7: first tenant Cafe Legend in Kota Bandung,
// operated by PT Sultan Solusi Nusantara, default PBJT 10%. Ids are fixed so
// fixtures in other domain contracts can reference them. The second outlet and
// the menu lines are illustrative sample data, not PRD facts.
// Full tenant / brand / outlet DTOs belong to the platform contract
// (bead legend-q88); the *Ref schemas here are the minimal references that
// every module embeds.

import { z } from "zod";
import { apiErrorBody } from "./errors.ts";
import {
  brandIdSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidIdSchema,
} from "./ids.ts";
import { decimal4Schema, idrSchema } from "./money.ts";
import { encodeCursor } from "./pagination.ts";
import {
  DEFAULT_BUSINESS_DAY_CUTOFF,
  DEFAULT_TIME_ZONE,
  businessDayCutoffSchema,
  timeZoneSchema,
} from "./time.ts";

export const tenantRefSchema = z.object({
  id: tenantIdSchema,
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string().min(1).max(150),
});
export const brandRefSchema = z.object({
  id: brandIdSchema,
  tenantId: tenantIdSchema,
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string().min(1).max(150),
});
export const outletRefSchema = z.object({
  id: outletIdSchema,
  tenantId: tenantIdSchema,
  brandId: brandIdSchema,
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(150),
  timeZone: timeZoneSchema,
  /** Owner Q39 business-day start; older producers omit it (default 04:00). */
  businessDayCutoff: businessDayCutoffSchema.default(
    DEFAULT_BUSINESS_DAY_CUTOFF,
  ),
  status: z.enum(["preopening", "active", "closed"]),
});
export type TenantRef = z.infer<typeof tenantRefSchema>;
export type BrandRef = z.infer<typeof brandRefSchema>;
export type OutletRef = z.infer<typeof outletRefSchema>;

/**
 * Illustrates the wire conventions on one row: ULID id, *Idr whole rupiah,
 * Decimal4 quantity, camelCase keys. The real order-line contract is WS-04's
 * (bead legend-4yp).
 */
export const moneyLineFixtureSchema = z.strictObject({
  id: ulidIdSchema<"OrderItemId">(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitPriceIdr: idrSchema,
  lineTotalIdr: idrSchema,
  coffeeGrams: decimal4Schema.nullable(),
});

const tenant = tenantRefSchema.parse({
  id: "0b6f1c2e-7d4a-4c1e-9a3b-2f5d8e1a4c70",
  slug: "cafe-legend",
  name: "Cafe Legend",
});
const brand = brandRefSchema.parse({
  id: "3c9e5a71-2b84-4f6d-8e10-5a7b9c2d4e61",
  tenantId: tenant.id,
  slug: "cafe-legend",
  name: "Cafe Legend",
});
const outlets = [
  outletRefSchema.parse({
    id: "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13",
    tenantId: tenant.id,
    brandId: brand.id,
    code: "BDG-01",
    name: "Cafe Legend Bandung",
    timeZone: DEFAULT_TIME_ZONE,
    status: "active",
  }),
  outletRefSchema.parse({
    id: "9e4b7c21-5d6f-4a8b-b3c0-1f2e3d4c5b6a",
    tenantId: tenant.id,
    brandId: brand.id,
    code: "BDG-02",
    name: "Cafe Legend Bandung 2 (contoh)",
    timeZone: DEFAULT_TIME_ZONE,
    status: "preopening",
  }),
] as const;

const orderLines = [
  {
    id: "01JBQ7Z8K3M4N5P6Q7R8S9T0VW",
    name: "Kopi Susu Legend",
    quantity: 2,
    unitPriceIdr: 28_000,
    lineTotalIdr: 56_000,
    coffeeGrams: "18.0000",
  },
  {
    id: "01JBQ7Z8K3M4N5P6Q7R8S9T0VX",
    name: "Nasi Goreng Kampung",
    quantity: 1,
    unitPriceIdr: 45_000,
    lineTotalIdr: 45_000,
    coffeeGrams: null,
  },
  {
    id: "01JBQ7Z8K3M4N5P6Q7R8S9T0VY",
    name: "Pisang Goreng Keju",
    quantity: 1,
    unitPriceIdr: 24_000,
    lineTotalIdr: 24_000,
    coffeeGrams: null,
  },
].map((line) => moneyLineFixtureSchema.parse(line));

export const cafeLegendFixtures = {
  tenant,
  brand,
  legalEntityName: "PT Sultan Solusi Nusantara",
  outlets,
  /** A cashier assigned to the Bandung outlet only. */
  cashierScope: { kind: "outlets" as const, outletIds: [outlets[0].id] },
  orderId: "01JBQ7Z8K0A1B2C3D4E5F6G7H8",
  orderLinesPage: {
    data: orderLines,
    meta: {
      limit: 25,
      nextCursor: encodeCursor([
        "2026-11-01T05:12:00.000Z",
        "01JBQ7Z8K3M4N5P6Q7R8S9T0VY",
      ]),
    },
  },
  errors: {
    outletOutOfScope: apiErrorBody(
      "OUTLET_OUT_OF_SCOPE",
      "Anda tidak memiliki akses ke outlet ini.",
      {
        requestId: "req_01JBQ7Z8K0",
      },
    ),
  },
};
