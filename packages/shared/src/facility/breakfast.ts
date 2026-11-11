// Breakfast order from the access ticket (PRD §3 F22 "Sarapan Siap Saat Keluar
// Shower", alur Z, FAC-10; founder Q43): the guest PAYS first, then the paid
// order waits until `fireOffsetMinutes` before the session ends and only then
// goes to the kitchen/KDS. An unpaid order never reaches the kitchen. Moved
// here from the web app (bead oa0qk); the API, the web app and the mock all
// import this one contract.
import { defineEndpoint } from "../api/index.ts";
import {
  dataResponseSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  z,
} from "../core/index.ts";

const orderParams = z.strictObject({
  ticketId: z.string().min(1).max(64),
  orderId: z.string().min(1).max(64),
});

const ticketParams = z.strictObject({ ticketId: z.string().min(1).max(64) });
const firingParams = z.strictObject({ orderId: z.string().min(1).max(64) });

/** Most portions of one dish in a single breakfast order. */
export const BREAKFAST_MAX_QUANTITY = 20;

export const breakfastMenuItemSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  priceIdr: idrSchema.refine((value) => value >= 0),
});
export type BreakfastMenuItem = z.infer<typeof breakfastMenuItemSchema>;

/** A table the kitchen can serve; `label` is what the guest reads ("Meja 08"). */
export const breakfastTableSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(60),
});
export type BreakfastTable = z.infer<typeof breakfastTableSchema>;

export const breakfastDeliverySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("table"),
    tableId: z.string().min(1).max(64),
  }),
  z.strictObject({ mode: z.literal("pickup") }),
]);
export type BreakfastDelivery = z.infer<typeof breakfastDeliverySchema>;

/**
 * `awaiting_payment`: created, not paid yet (never in the kitchen).
 * `paid`: paid in full, waiting for `fireAt` (the old "held").
 * `fired`: sent to the kitchen. `cancelled`: voided (refunded when it was paid).
 */
export const breakfastOrderStatusSchema = z.enum([
  "awaiting_payment",
  "paid",
  "fired",
  "cancelled",
]);
export type BreakfastOrderStatus = z.infer<typeof breakfastOrderStatusSchema>;

export const breakfastOrderSchema = z.strictObject({
  /** The order id (ULID). */
  id: z.string().min(1).max(64),
  ticketId: z.string().min(1).max(64),
  status: breakfastOrderStatusSchema,
  lines: z
    .array(
      z.strictObject({
        menuItemId: z.string().min(1).max(64),
        name: z.string().min(1).max(120),
        quantity: z.number().int().min(1).max(BREAKFAST_MAX_QUANTITY),
        unitPriceIdr: idrSchema.refine((value) => value >= 0),
      }),
    )
    .min(1),
  delivery: breakfastDeliverySchema,
  /** Computed by the server from its own prices, never taken from the client. */
  subtotalIdr: idrSchema.refine((value) => value >= 0),
  /** What the guest pays (server-computed; equals the subtotal today). */
  totalIdr: idrSchema.refine((value) => value >= 0),
  fireOffsetMinutes: z.number().int().min(0).max(240),
  /** `slot.endsAt - fireOffsetMinutes`, recomputed when the session changes. */
  fireAt: isoDateTimeSchema,
  /** Set once the payment is verified; null while `awaiting_payment`. */
  paidAt: isoDateTimeSchema.nullable(),
  /** Set when the kitchen received the order; null before. */
  firedAt: isoDateTimeSchema.nullable(),
});
export type BreakfastOrder = z.infer<typeof breakfastOrderSchema>;

export const breakfastMenuSchema = z.strictObject({
  items: z.array(breakfastMenuItemSchema),
  tables: z.array(breakfastTableSchema),
  /** Kitchen prep time: how long before the session ends the order fires. */
  fireOffsetMinutes: z.number().int().min(0).max(240),
  /** The ticket's existing order, so a reload shows it instead of the form. */
  order: breakfastOrderSchema.nullable(),
});
export type BreakfastMenu = z.infer<typeof breakfastMenuSchema>;

export const createBreakfastOrderSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        menuItemId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(BREAKFAST_MAX_QUANTITY),
      }),
    )
    .min(1),
  delivery: breakfastDeliverySchema,
  idempotencyKey: idempotencyKeySchema,
});
export type CreateBreakfastOrderBody = z.input<
  typeof createBreakfastOrderSchema
>;

/** GET /api/facility/tickets/:ticketId/breakfast-menu */
export const getBreakfastMenu = defineEndpoint({
  method: "GET",
  path: "/api/facility/tickets/:ticketId/breakfast-menu",
  params: ticketParams,
  response: dataResponseSchema(breakfastMenuSchema),
});

/**
 * POST /api/facility/tickets/:ticketId/breakfast-orders — creates an order in
 * `awaiting_payment`. 409 BREAKFAST_ORDER_EXISTS when the ticket already has a
 * live order, 422 BREAKFAST_UNAVAILABLE when the ticket can no longer hold one,
 * 409 IDEMPOTENCY_KEY_REUSED when the key was used with another payload.
 */
export const createBreakfastOrder = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/:ticketId/breakfast-orders",
  params: ticketParams,
  body: createBreakfastOrderSchema,
  response: dataResponseSchema(breakfastOrderSchema),
});

export const breakfastPaymentSchema = z.strictObject({
  order: breakfastOrderSchema,
  /**
   * Payment-link token (`pl_...`) for `/bayar/$token`; null when the order is
   * already paid. The link is created once and reused.
   */
  paymentToken: z.string().min(1).max(128).nullable(),
});
export type BreakfastPayment = z.infer<typeof breakfastPaymentSchema>;

export const breakfastCancelResultSchema = z.strictObject({
  order: breakfastOrderSchema,
  /** Refunded to the guest, never more than was paid (0 when unpaid). */
  refundIdr: idrSchema.refine((value) => value >= 0),
});
export type BreakfastCancelResult = z.infer<typeof breakfastCancelResultSchema>;

export const payBreakfastOrderBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});
export type PayBreakfastOrderBody = z.input<typeof payBreakfastOrderBodySchema>;

export const cancelBreakfastOrderBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});
export type CancelBreakfastOrderBody = z.input<
  typeof cancelBreakfastOrderBodySchema
>;

export const fireBreakfastOrderBodySchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
});
export type FireBreakfastOrderBody = z.input<
  typeof fireBreakfastOrderBodySchema
>;

/**
 * POST /api/facility/tickets/:ticketId/breakfast-orders/:orderId/pay (member)
 * — returns the payment link token. The "paid" mark comes only from the
 * verified payment event, never from this call.
 */
export const payBreakfastOrder = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/:ticketId/breakfast-orders/:orderId/pay",
  params: orderParams,
  body: payBreakfastOrderBodySchema,
  response: dataResponseSchema(breakfastPaymentSchema),
});

/**
 * POST /api/facility/tickets/:ticketId/breakfast-orders/:orderId/cancel
 * (member) — 409 BREAKFAST_ALREADY_FIRED once the kitchen has it; a paid order
 * is refunded at most what was paid.
 */
export const cancelBreakfastOrder = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/:ticketId/breakfast-orders/:orderId/cancel",
  params: orderParams,
  body: cancelBreakfastOrderBodySchema,
  response: dataResponseSchema(breakfastCancelResultSchema),
});

/**
 * POST /api/facility/breakfast-orders/:orderId/fire (staff,
 * `facility.booth.operate`) — send to the kitchen now. 409 BREAKFAST_NOT_PAID
 * when the order is not paid; a fired order answers with itself (idempotent).
 */
export const fireBreakfastOrder = defineEndpoint({
  method: "POST",
  path: "/api/facility/breakfast-orders/:orderId/fire",
  params: firingParams,
  body: fireBreakfastOrderBodySchema,
  response: dataResponseSchema(breakfastOrderSchema),
});
