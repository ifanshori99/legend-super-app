// Parked carts are raw cashier-owned snapshots, separate from payable orders.
// Resume only returns and consumes the snapshot; createPosOrder revalidates
// availability, modifiers and current prices when the cashier submits it.
import {
  z,
  clientInputSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { tableSessionIdSchema } from "../qr-order/schemas.ts";
import { orderChannelSchema, serviceTypeSchema } from "./schemas.ts";

export const posParkedOrderIdSchema = uuidIdSchema<"PosParkedOrderId">();

/** No price, total, owner or other authoritative order fields are accepted. */
export const posParkedOrderLineSchema = z.strictObject({
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable().optional(),
  modifierIds: z.array(uuidSchema).max(20),
  quantity: z.number().int().min(1).max(99),
  note: z.string().max(200).nullable().optional(),
  course: z.string().min(1).max(20).nullable().optional(),
  hold: z.boolean().optional(),
});

const snapshotFields = {
  channel: orderChannelSchema,
  serviceType: serviceTypeSchema,
  tableSessionId: tableSessionIdSchema.nullable().optional(),
  externalRef: z.string().min(1).max(100).nullable().optional(),
  items: z.array(posParkedOrderLineSchema).min(1).max(99),
};

export const posParkedOrderSnapshotSchema = z.strictObject(snapshotFields);
export type PosParkedOrderSnapshot = z.infer<
  typeof posParkedOrderSnapshotSchema
>;

export const posParkedOrderSchema = z.strictObject({
  id: posParkedOrderIdSchema,
  label: z.string().min(1).max(150),
  ...snapshotFields,
  parkedAt: isoDateTimeSchema,
});
export type PosParkedOrder = z.infer<typeof posParkedOrderSchema>;

const outletParams = z.strictObject({ outletId: outletIdSchema });
const parkedOrderParams = outletParams.extend({
  parkedOrderId: posParkedOrderIdSchema,
});

export const createPosParkedOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/parked-orders",
  params: outletParams,
  body: clientInputSchema({
    ...snapshotFields,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(posParkedOrderSchema),
});

export const listPosParkedOrders = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/parked-orders",
  params: outletParams,
  query: clientInputSchema({}),
  response: dataResponseSchema(z.array(posParkedOrderSchema)),
});

export const getPosParkedOrder = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/parked-orders/:parkedOrderId",
  params: parkedOrderParams,
  response: dataResponseSchema(posParkedOrderSchema),
});

/** Exactly one resume consumes a snapshot; later attempts return 404. */
export const resumePosParkedOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pos/parked-orders/:parkedOrderId/resume",
  params: parkedOrderParams,
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(posParkedOrderSchema),
});
