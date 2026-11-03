// Wake-up signals for the QR guest realtime relay (beads legend-x4qy,
// legend-6ohy; PRD v1.7 §3 F10 "Menu & Keranjang": the shared cart and the
// order status update live on every phone at the table).
//
// Same rule as notification-realtime.ts: only identifiers cross PostgreSQL
// NOTIFY (delivered at commit), never row contents, prices or credentials.
// The relay re-checks each socket's guest credential and the client re-reads
// the session view under its own credential.
//
// - Cart signal `{tenantId, sessionId, version}`: written by
//   qr-order.service.ts `publishCartChange` on every cart write and checkout.
// - Order signal `{tenantId, sessionId, orderId, status}`: written by the
//   payment consumers (qr-order-consumers.ts) when a verified payment fires
//   an order or an unpaid order is voided.

import { sql } from "drizzle-orm";
import {
  tenantIdSchema,
  ulidSchema,
  uuidSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { Tx } from "./menu-internals.ts";
import { QR_CART_WAKE_CHANNEL } from "./qr-order.service.ts";

export { QR_CART_WAKE_CHANNEL };

export const qrCartSignalSchema = z.strictObject({
  tenantId: tenantIdSchema,
  sessionId: uuidSchema,
  version: z.number().int().nonnegative(),
});

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

/** Queues an order wake-up in the caller's transaction (sent at commit). */
export async function notifyQrOrderChange(
  tx: Tx,
  context: ScopedTenantContext,
  input: { sessionId: string; orderId: string; status: "sent" | "voided" },
): Promise<void> {
  const signal = qrOrderSignalSchema.parse({
    tenantId: context.tenant.tenantId,
    ...input,
  });
  await tx.execute(
    sql`SELECT pg_notify(${QR_CART_WAKE_CHANNEL}, ${JSON.stringify(signal)})`,
  );
}
