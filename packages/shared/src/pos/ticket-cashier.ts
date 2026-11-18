// Cashier reads for the facility ticket sale (1096, legend-hpgyw card 1): the
// customer search, the ticket catalog and the free slots of one area. Each read
// names the outlet in the path and needs `pos.sale.create` on it, so a cashier
// without CRM or facility-admin rights can sell a ticket.
//
// Privacy: the customer search returns only the profile id and name (no phone,
// email or other CRM field). Money: the catalog price is the server's product
// price; the sale charges the same price or refuses (TICKET_PRICE_MISMATCH).

import {
  z,
  businessDateSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  facilityAreaIdSchema,
  facilityIdSchema,
  facilityProductIdSchema,
  facilityUnitIdSchema,
} from "../facility/ids.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });

/** Shortest search term: shorter terms would list the whole customer base. */
export const POS_TICKET_CUSTOMER_QUERY_MIN = 3;
/** Most customers one search returns. */
export const POS_TICKET_CUSTOMER_LIMIT = 10;

/** One customer the cashier may pick: id and name only. */
export const posTicketCustomerSchema = z.strictObject({
  id: uuidSchema,
  name: z.string(),
});
export type PosTicketCustomer = z.infer<typeof posTicketCustomerSchema>;

export const searchPosTicketCustomersQuerySchema = z.strictObject({
  q: z.string().trim().min(POS_TICKET_CUSTOMER_QUERY_MIN).max(120),
});

/**
 * GET /api/outlets/:outletId/pos/tickets/customers?q=: active customers of
 * this tenant whose name contains `q` (merged and closed profiles are left
 * out), at most 10, ordered by name.
 */
export const searchPosTicketCustomers = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/tickets/customers",
  params: outletParams,
  query: searchPosTicketCustomersQuerySchema,
  response: dataResponseSchema(
    z.strictObject({
      customers: z
        .array(posTicketCustomerSchema)
        .max(POS_TICKET_CUSTOMER_LIMIT),
    }),
  ),
});

/** One ticket product the cashier can sell at this outlet. */
export const posTicketProductSchema = z.strictObject({
  id: facilityProductIdSchema,
  facilityId: facilityIdSchema,
  facilityName: z.string(),
  name: z.string(),
  /** The product's price (whole rupiah); the sale charges exactly this. */
  priceIdr: z.number().int().nonnegative(),
  sessions: z.number().int().min(1),
  areas: z.array(
    z.strictObject({ id: facilityAreaIdSchema, name: z.string() }),
  ),
  units: z.array(
    z.strictObject({
      id: facilityUnitIdSchema,
      areaId: facilityAreaIdSchema,
      code: z.string(),
    }),
  ),
});
export type PosTicketProduct = z.infer<typeof posTicketProductSchema>;

/**
 * GET /api/outlets/:outletId/pos/tickets/products: the active single-ticket
 * products of this outlet's facilities that have a POS menu item (a ticket is
 * an ordinary bill line). Plans and products without a menu item are left out.
 */
export const listPosTicketProducts = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/tickets/products",
  params: outletParams,
  response: dataResponseSchema(
    z.strictObject({ products: z.array(posTicketProductSchema) }),
  ),
});

export const listPosTicketSlotsQuerySchema = z.strictObject({
  facilityId: facilityIdSchema,
  areaId: facilityAreaIdSchema,
  /** Business date in the outlet time zone. */
  date: businessDateSchema,
});

/** A start time with at least one free, bookable unit in the area. */
export const posTicketSlotSchema = z.strictObject({
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
});
export type PosTicketSlot = z.infer<typeof posTicketSlotSchema>;

/**
 * GET /api/outlets/:outletId/pos/tickets/slots?facilityId&areaId&date: the
 * free start times of one area of a facility of this outlet, ordered by start.
 * Only free slots are returned: no unit status, hold or queue data.
 */
export const listPosTicketSlots = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pos/tickets/slots",
  params: outletParams,
  query: listPosTicketSlotsQuerySchema,
  response: dataResponseSchema(
    z.strictObject({
      facilityId: facilityIdSchema,
      areaId: facilityAreaIdSchema,
      businessDate: businessDateSchema,
      slots: z.array(posTicketSlotSchema),
    }),
  ),
});
