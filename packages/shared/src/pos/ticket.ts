// Facility ticket sold at the cashier (936, legend-hpgyw part D). A ticket is an
// ordinary line on a POS bill: the sale holds the slot and creates the bill, the
// ticket is issued only when the order is paid (completePosOrder), and a void or
// refund of the line cancels or refunds the ticket. The sale body is the
// existing `staffSellTicketSchema`; this file adds what the sale returns, the
// tickets of an order and the one-time door credential + print.
//
// Money rules: the line price is the POS price list's price for the product's
// menu item (the client sends no price); the credential never comes with the
// sale, only after the ticket is paid.

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { accessTicketIdSchema } from "../facility/ids.ts";
import {
  accessTicketCredentialSchema,
  accessTicketSchema,
} from "../facility/schemas.ts";
import { orderIdSchema } from "../kitchen/schemas.ts";
import { orderItemIdSchema } from "../qr-order/schemas.ts";
import { posOrderDetailSchema } from "./schemas.ts";

/** Where the ticket stands against its bill line. */
export const posTicketLineStatusSchema = z.enum([
  /** Slot held, bill not paid: no ticket is usable. */
  "pending",
  /** Bill paid: the ticket is issued. */
  "issued",
  /** Order voided before payment: hold released. */
  "cancelled",
  /** Paid, then voided or refunded: ticket refunded, slot released. */
  "refunded",
]);
export type PosTicketLineStatus = z.infer<typeof posTicketLineStatusSchema>;

/**
 * Names the cashier screen shows for a ticket (read-only lookup; empty string
 * when the row behind an id is gone).
 */
export const posOrderTicketDisplaySchema = z.strictObject({
  productName: z.string(),
  facilityName: z.string(),
  areaName: z.string(),
  unitCode: z.string().nullable(),
  customerName: z.string(),
});
export type PosOrderTicketDisplay = z.infer<typeof posOrderTicketDisplaySchema>;

/** One ticket and the bill line that pays for it. */
export const posOrderTicketSchema = z.strictObject({
  ticket: accessTicketSchema,
  display: posOrderTicketDisplaySchema,
  orderItemId: orderItemIdSchema,
  lineStatus: posTicketLineStatusSchema,
  /** The line total the guest pays (server price, whole rupiah). */
  lineTotalIdr: z.number().int().nonnegative(),
});
export type PosOrderTicket = z.infer<typeof posOrderTicketSchema>;

/**
 * POST /api/facility/tickets/pos response: the bill with the ticket line, and
 * the ticket in `pending_payment`. Replaying the same idempotency key returns
 * the same order and ticket (one hold, one bill).
 */
export const posTicketSaleSchema = z.strictObject({
  ticket: accessTicketSchema,
  order: posOrderDetailSchema,
});
export type PosTicketSale = z.infer<typeof posTicketSaleSchema>;

const orderTicketsParams = z.strictObject({ orderId: orderIdSchema });
const orderTicketParams = z.strictObject({
  orderId: orderIdSchema,
  ticketId: accessTicketIdSchema,
});

/** GET /api/pos/orders/:orderId/tickets: the tickets on one bill. */
export const listPosOrderTickets = defineEndpoint({
  method: "GET",
  path: "/api/pos/orders/:orderId/tickets",
  params: orderTicketsParams,
  response: dataResponseSchema(
    z.strictObject({ tickets: z.array(posOrderTicketSchema) }),
  ),
});

/**
 * Where the print went. Null fields: the API runs in the cloud (no Print
 * Agent), so the cashier shows the credential on screen instead.
 */
export const posTicketPrintSchema = z.strictObject({
  printedAt: isoDateTimeSchema.nullable(),
  printerName: z.string().nullable(),
  reprint: z.boolean(),
});
export type PosTicketPrint = z.infer<typeof posTicketPrintSchema>;

export const issuePosTicketCredentialBodySchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

/**
 * POST /api/pos/orders/:orderId/tickets/:ticketId/credential: mints a fresh QR
 * token and PIN (the previous pair stops working), prints the ticket through
 * the Print Agent when on the edge, and returns the credential ONCE. Only a
 * paid (`issued`) ticket gets one. The server keeps digests only, so a replay
 * of the same key cannot show the credential again (409
 * TICKET_CREDENTIAL_SHOWN): the cashier reprints with a new key.
 */
export const issuePosTicketCredential = defineEndpoint({
  method: "POST",
  path: "/api/pos/orders/:orderId/tickets/:ticketId/credential",
  params: orderTicketParams,
  body: issuePosTicketCredentialBodySchema,
  response: dataResponseSchema(
    z.strictObject({
      credential: accessTicketCredentialSchema,
      print: posTicketPrintSchema,
    }),
  ),
});
