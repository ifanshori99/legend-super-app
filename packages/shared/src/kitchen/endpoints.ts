// Kitchen endpoint contracts (bead legend-acz). The web app's typed client and
// mock mode read these objects, and the API validates with the same ones
// (docs/frontend.md, "Typed endpoints and mock mode"; PRD v1.7 §3 "Kontrak
// Bersama"). Outlet scoping comes from the verified session/device, never from
// the body (TEN-02): requests carry `outletId` only in the path, and every
// request schema is built with `clientInputSchema`.

import {
  z,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  businessDateSchema,
  outletIdSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { channelSchema } from "../menu/schemas.ts";
import {
  allDayCountSchema,
  capacityRuleInputSchema,
  capacityRuleSchema,
  createOrderIssueInputSchema,
  expoBoardSchema,
  expoTicketSchema,
  kitchenItemActionSchema,
  kitchenTicketDetailSchema,
  kitchenTicketIdSchema,
  kitchenTicketItemIdSchema,
  kitchenTicketItemSchema,
  orderIdSchema,
  orderIssueSchema,
  orderIssueTypeSchema,
  pacingSnapshotSchema,
  pickupCallSchema,
  pickupDisplaySchema,
  servingTimeEstimateSchema,
  servingTimeGroupSchema,
  servingTimeSummarySchema,
  stationBoardSchema,
  stationConfigSchema,
  stationIdSchema,
} from "./schemas.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const stationParams = z.strictObject({
  outletId: outletIdSchema,
  stationId: stationIdSchema,
});
const ticketParams = z.strictObject({
  outletId: outletIdSchema,
  ticketId: kitchenTicketIdSchema,
});
const orderParams = z.strictObject({
  outletId: outletIdSchema,
  orderId: orderIdSchema,
});

/** Kitchen config: the KDS tabs in display order (F12). */
export const listKitchenStations = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations",
  params: outletParams,
  response: dataResponseSchema(z.array(stationConfigSchema)),
});

/** One KDS station tab: open tickets, all-day count, current pacing (F12). */
export const getKitchenBoard = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/board",
  params: stationParams,
  response: dataResponseSchema(stationBoardSchema),
});

/** "Aksi Tiket": start, bump, recall, void. */
export const startKitchenTicket = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId/start",
  params: ticketParams,
  response: dataResponseSchema(kitchenTicketDetailSchema),
});

export const bumpKitchenTicket = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId/bump",
  params: ticketParams,
  response: dataResponseSchema(kitchenTicketDetailSchema),
});

export const recallKitchenTicket = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId/recall",
  params: ticketParams,
  body: clientInputSchema({ reason: z.string().min(1).max(200) }),
  response: dataResponseSchema(kitchenTicketDetailSchema),
});

export const voidKitchenTicket = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId/void",
  params: ticketParams,
  body: clientInputSchema({ reason: z.string().min(1).max(200) }),
  response: dataResponseSchema(kitchenTicketDetailSchema),
});

/** F12 "Aksi Tiket": priority is set from the ticket card, not by starting it. */
export const setKitchenTicketPriority = defineEndpoint({
  method: "PATCH",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId/priority",
  params: ticketParams,
  body: clientInputSchema({ priority: z.number().int().min(0).max(9) }),
  response: dataResponseSchema(kitchenTicketDetailSchema),
});

/** Per item status on the KDS ("status per item", F12). */
export const updateKitchenTicketItem = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/kitchen/ticket-items/:itemId/status",
  params: z.strictObject({
    outletId: outletIdSchema,
    itemId: kitchenTicketItemIdSchema,
  }),
  body: clientInputSchema({ action: kitchenItemActionSchema }),
  response: dataResponseSchema(kitchenTicketItemSchema),
});

/** All-Day Count for batch production (F12). */
export const getAllDayCount = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/all-day",
  params: stationParams,
  response: dataResponseSchema(allDayCountSchema),
});

/** Expo board: every order across stations, per table (F12). */
export const getExpoBoard = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/expo",
  params: outletParams,
  response: dataResponseSchema(expoBoardSchema),
});

/** Expo runner assignment (F12). */
export const assignExpoRunner = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/expo/:orderId/runner",
  params: orderParams,
  body: clientInputSchema({ runnerId: userIdSchema }),
  response: dataResponseSchema(expoTicketSchema),
});

/** Pickup display: called numbers for takeaway and delivery channels (F12). */
export const getPickupDisplay = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pickup-display",
  params: outletParams,
  response: dataResponseSchema(pickupDisplaySchema),
});

/** "Panggil": show and announce a pickup number. */
export const callPickupNumber = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pickup-calls/:callId/call",
  params: z.strictObject({
    outletId: outletIdSchema,
    callId: uuidSchema,
  }),
  response: dataResponseSchema(pickupCallSchema),
});

/** Current pacing per station (F12, KDS-05). */
export const getPacing = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/pacing",
  params: outletParams,
  response: dataResponseSchema(pacingSnapshotSchema),
});

/** Kitchen config replaces one station's capacity rules in one call. */
export const updateCapacityRules = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/capacity-rules",
  params: stationParams,
  body: clientInputSchema({
    rules: z.array(capacityRuleInputSchema).min(1).max(24),
  }),
  response: dataResponseSchema(z.array(capacityRuleSchema)),
});

/**
 * Real-time serving-time estimate for the QR order / POS checkout (PRD §3 F11
 * "Estimasi Waktu Saji", F12; KDS-05 refresh, KDS-06 accuracy).
 */
export const estimateServingTime = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/serving-time-estimate",
  params: outletParams,
  query: clientInputSchema({
    channel: channelSchema,
    loadPoints: z.coerce.number().int().nonnegative().max(10_000).default(0),
  }),
  response: dataResponseSchema(servingTimeEstimateSchema),
});

/** Serving-time analytics by station, hour, employee or item (F12). */
export const getServingTimeSummary = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/serving-time-summary",
  params: outletParams,
  query: clientInputSchema({
    group: servingTimeGroupSchema,
    from: businessDateSchema,
    to: businessDateSchema,
  }).refine((query) => query.from <= query.to, {
    path: ["to"],
    message: "The period ends on or after it starts",
  }),
  response: dataResponseSchema(z.array(servingTimeSummarySchema)),
});

/** KDS-07 / F41: record a remake, comp, unfulfillable line or complaint. */
export const reportOrderIssue = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/orders/:orderId/issues",
  params: orderParams,
  body: createOrderIssueInputSchema,
  response: dataResponseSchema(orderIssueSchema),
});

/** Remake/comp log for the kitchen analytics screen. */
export const listOrderIssues = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/order-issues",
  params: outletParams,
  query: cursorPageQuerySchema.extend({
    type: orderIssueTypeSchema.optional(),
    stationId: stationIdSchema.optional(),
  }),
  response: cursorPageSchema(orderIssueSchema),
});
