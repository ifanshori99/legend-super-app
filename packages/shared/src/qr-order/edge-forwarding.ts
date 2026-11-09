// Cloud -> edge forwarding of QR orders (WS-02, PRD v1.7 §3 F5 "Pesanan
// Pelanggan dari Cloud"). When the outlet runs an edge node and its link is
// up, the cloud queues one `qr_order.placed` transaction event per placed
// order on the cloud_to_edge stream; the edge upserts the order and its lines
// into its local tables so the kitchen works from the edge.
//
// The event is its own aggregate (`qr_order`, one event, sequence 1) so it
// never collides with the cloud's `order` stream (`order.placed` outbox event).
// The event id IS the order id (a ULID), so queueing twice is a no-op.
import { z, uuidSchema, idrSchema, isoDateTimeSchema } from "../core/index.ts";

export const QR_ORDER_FORWARD_AGGREGATE = "qr_order" as const;
export const QR_ORDER_PLACED_EDGE_EVENT = "qr_order.placed" as const;
export const QR_ORDER_PLACED_EDGE_VERSION = 1 as const;
export const QR_ORDER_PLACED_EDGE_SCHEMA_REF = "qr_order.placed.v1" as const;

const money = idrSchema;
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const qrOrderEdgeItemSchema = z.strictObject({
  id: z.string().min(1).max(40),
  menuItemId: uuidSchema,
  variantId: uuidSchema.nullable(),
  name: z.string().min(1).max(150),
  quantity: z.number().int().min(1).max(99),
  unitPriceIdr: money,
  modifiersTotalIdr: money,
  lineTotalIdr: money,
  modifiers: z.array(z.json()),
  note: z.string().max(200).nullable(),
  course: z.string().max(20).nullable(),
  fireStatus: z.enum(["held", "fired"]),
  status: z.enum(["queued", "in_progress", "ready", "served", "voided"]),
  reservedBusinessDate: dateOnly,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type QrOrderEdgeItem = z.infer<typeof qrOrderEdgeItemSchema>;

export const qrOrderEdgeOrderSchema = z.strictObject({
  id: z.string().min(1).max(40),
  number: z.string().min(1).max(30),
  channel: z.literal("qr"),
  serviceType: z.enum(["dine_in", "takeaway", "delivery"]),
  tableSessionId: uuidSchema.nullable(),
  paymentMode: z.enum(["pay_first", "open_bill"]),
  subtotalIdr: money,
  discountIdr: money,
  serviceChargeIdr: money,
  taxIdr: money,
  roundingIdr: money,
  totalIdr: money,
  depositAppliedIdr: money,
  status: z.enum(["draft", "awaiting_payment", "sent", "completed", "voided"]),
  businessDate: dateOnly,
  taxResult: z.json().nullable(),
  note: z.string().max(200).nullable(),
  placedAt: isoDateTimeSchema,
  firedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type QrOrderEdgeOrder = z.infer<typeof qrOrderEdgeOrderSchema>;

/** Payload of `qr_order.placed`: the order and every line the edge needs. */
export const qrOrderPlacedEdgePayloadSchema = z.strictObject({
  order: qrOrderEdgeOrderSchema,
  items: z.array(qrOrderEdgeItemSchema).min(1),
});
export type QrOrderPlacedEdgePayload = z.infer<
  typeof qrOrderPlacedEdgePayloadSchema
>;
