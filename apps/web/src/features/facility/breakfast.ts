// Breakfast order from the access ticket (PRD §3 F22 "Sarapan Siap Saat Keluar
// Shower", alur Z, FAC-10): the order is held and fired `fireOffsetMinutes`
// before the session ends.
//
// TODO(kontrak): the ticket-linked breakfast endpoints do not exist in
// `@starter/shared/facility` yet (the shared schema only has the stored
// `facility_linked_order`). They are defined here with the same shape the
// shared contracts use (`defineEndpoint` + zod) so the screen, the mock and the
// future API agree. Move them to the shared contract when the backend bead
// ships, then delete this block. Node-safe: relative imports end in .ts.
import { defineEndpoint } from "@starter/shared/api";
import {
  dataResponseSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  z,
} from "@starter/shared/core";

const ticketParams = z.strictObject({ ticketId: z.string().min(1).max(64) });

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

export const breakfastOrderStatusSchema = z.enum(["held", "fired"]);

export const breakfastOrderSchema = z.strictObject({
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
  fireOffsetMinutes: z.number().int().min(0).max(240),
  /** `slot.endsAt - fireOffsetMinutes`, recomputed when the session changes. */
  fireAt: isoDateTimeSchema,
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
 * POST /api/facility/tickets/:ticketId/breakfast-orders — 409 when the ticket
 * already has an order, 422 when the ticket can no longer hold one.
 */
export const createBreakfastOrder = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/:ticketId/breakfast-orders",
  params: ticketParams,
  body: createBreakfastOrderSchema,
  response: dataResponseSchema(breakfastOrderSchema),
});
