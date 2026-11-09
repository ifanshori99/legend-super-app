// Delivery channel domain events, registered on the WS-08 line of the WS-00
// catalog and bound with defineDomainEvent (contracts.md "One catalog, typed
// payloads"). The platform itself never publishes tenant events: the service
// wrapping the `DeliveryChannel` adapter emits these (the adapter-level
// `delivery_channel.action_executed` event stays WS-00's).
//
// Payloads carry ids, statuses and money; the raw platform payload stays on the
// row (hashed here) and is never republished.

import { z, idrSchema } from "../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import type { EventCatalogEntry } from "../events/index.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import {
  deliveryChannelOrderIdSchema,
  deliveryOrderSourceSchema,
  deliveryOrderStatusSchema,
  deliveryPlatformSchema,
} from "./schemas.ts";

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const reference = z.string().min(1).max(100);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const deliveryEventNames = [
  "delivery_order.received",
  "delivery_order.status_changed",
  "delivery_order.updated",
  "delivery_order.settled",
] as const;
export type DeliveryEventName = (typeof deliveryEventNames)[number];

export const deliveryOrderReceivedPayloadSchema = z.strictObject({
  deliveryChannelOrderId: deliveryChannelOrderIdSchema,
  platform: deliveryPlatformSchema,
  /** Unique per platform (PRD §6.G). */
  externalOrderId: reference,
  /** Internal order once injected to the KDS; null at receipt. */
  orderId: orderIdSchema.nullable(),
  source: deliveryOrderSourceSchema,
  /** As reported by the platform or entered by the cashier. */
  grossIdr: nonnegativeIdr,
  commissionIdr: nonnegativeIdr,
  payloadHash: sha256HexSchema,
});
export type DeliveryOrderReceivedPayload = z.infer<
  typeof deliveryOrderReceivedPayloadSchema
>;

export const deliveryOrderStatusChangedPayloadSchema = z.strictObject({
  deliveryChannelOrderId: deliveryChannelOrderIdSchema,
  platform: deliveryPlatformSchema,
  externalOrderId: reference,
  orderId: orderIdSchema.nullable(),
  from: deliveryOrderStatusSchema,
  to: deliveryOrderStatusSchema,
  /** Adapter action the service pushed for this step; null when none. */
  action: z.enum(["accept_order", "update_order", "cancel_order"]).nullable(),
});
export type DeliveryOrderStatusChangedPayload = z.infer<
  typeof deliveryOrderStatusChangedPayloadSchema
>;

/**
 * The platform changed an order already injected to the KDS: money and note
 * are applied, the cooked lines are not; `linesChanged` asks staff to review.
 */
export const deliveryOrderUpdatedPayloadSchema = z.strictObject({
  deliveryChannelOrderId: deliveryChannelOrderIdSchema,
  platform: deliveryPlatformSchema,
  externalOrderId: reference,
  orderId: orderIdSchema.nullable(),
  grossBeforeIdr: nonnegativeIdr,
  grossIdr: nonnegativeIdr,
  commissionBeforeIdr: nonnegativeIdr,
  commissionIdr: nonnegativeIdr,
  payloadHash: sha256HexSchema,
  linesChanged: z.boolean(),
});
export type DeliveryOrderUpdatedPayload = z.infer<
  typeof deliveryOrderUpdatedPayloadSchema
>;

export const deliveryOrderSettledPayloadSchema = z.strictObject({
  deliveryChannelOrderId: deliveryChannelOrderIdSchema,
  platform: deliveryPlatformSchema,
  externalOrderId: reference,
  grossIdr: nonnegativeIdr,
  commissionIdr: nonnegativeIdr,
  settledNetIdr: nonnegativeIdr,
  /** Signed: settled net minus the internal net. 0 when it matched. */
  varianceIdr: idrSchema,
});
export type DeliveryOrderSettledPayload = z.infer<
  typeof deliveryOrderSettledPayloadSchema
>;

const payloadSchemas: Record<
  DeliveryEventName,
  z.ZodType<Record<string, unknown>>
> = {
  "delivery_order.received": deliveryOrderReceivedPayloadSchema,
  "delivery_order.status_changed": deliveryOrderStatusChangedPayloadSchema,
  "delivery_order.updated": deliveryOrderUpdatedPayloadSchema,
  "delivery_order.settled": deliveryOrderSettledPayloadSchema,
};

export const deliveryEvents = Object.fromEntries(
  deliveryEventNames.map((name) => [
    name,
    defineDomainEvent({ name, payload: payloadSchemas[name] }),
  ]),
) as Record<DeliveryEventName, ReturnType<typeof defineDomainEvent>>;

export function deliveryEventPayloadSchema(name: string): z.ZodType | null {
  return Object.hasOwn(deliveryEvents, name)
    ? deliveryEvents[name as DeliveryEventName].payloadSchema
    : null;
}

export const deliveryEventCatalogEntries: readonly EventCatalogEntry[] =
  deliveryEventNames.map((name) => deliveryEvents[name].entry);

export const deliveryEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (deliveryEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a delivery channel event" },
  )
  .refine(
    (event) =>
      deliveryEvents[event.name as DeliveryEventName]?.envelopeSchema.safeParse(
        event,
      ).success === true,
    {
      path: ["payload"],
      message: "Delivery event name and payload must match a registered schema",
    },
  );
