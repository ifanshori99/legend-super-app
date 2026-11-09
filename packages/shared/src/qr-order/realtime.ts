// QR guest realtime contract (beads legend-x4qy, legend-6ohy, legend-8pye).
// One schema for both ends: the API relay builds and validates the messages it
// pushes, and the web client parses the same shape. Only identifiers travel:
// no prices, no lines, no credentials. The client re-reads the session view
// under its own credential after each message.
//
// - Signals are the PostgreSQL NOTIFY payloads (server to relay only).
// - Messages are what the relay pushes to each guest socket.

import {
  z,
  tenantIdSchema,
  ulidSchema,
  uuidSchema,
} from "../core/index.ts";

/** Written on every cart write and checkout. */
export const qrCartSignalSchema = z.strictObject({
  tenantId: tenantIdSchema,
  sessionId: uuidSchema,
  version: z.number().int().nonnegative(),
});

/** Written when a verified payment fires an order or an unpaid one is voided. */
export const qrOrderSignalSchema = z.strictObject({
  tenantId: tenantIdSchema,
  sessionId: uuidSchema,
  orderId: ulidSchema,
  status: z.enum(["sent", "voided"]),
});

export const qrRealtimeSignalSchema = z.union([
  qrCartSignalSchema,
  qrOrderSignalSchema,
]);
export type QrRealtimeSignal = z.infer<typeof qrRealtimeSignalSchema>;

/** Message pushed to guests over the realtime socket. */
export const qrRealtimeMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cart.updated"),
    sessionId: uuidSchema,
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("order.updated"),
    sessionId: uuidSchema,
    orderId: z.string(),
    status: z.enum(["sent", "voided"]),
  }),
]);
export type QrRealtimeMessage = z.infer<typeof qrRealtimeMessageSchema>;
