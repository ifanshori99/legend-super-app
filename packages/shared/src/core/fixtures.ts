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
import { ulidIdSchema } from "./ids.ts";
import { decimal4Schema, idrSchema } from "./money.ts";
import { encodeCursor } from "./pagination.ts";
import { cafeLegendCoreSample } from "./sample.ts";

export * from "./refs.ts";

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

const { tenant, brand, outlets } = cafeLegendCoreSample;

export const cafeLegendFixtures = {
  tenant,
  brand,
  legalEntityName: cafeLegendCoreSample.legalEntityName,
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
