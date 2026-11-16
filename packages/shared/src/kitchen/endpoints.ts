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
  channelPauseSchema,
  manualChannelPauseInputSchema,
  menuLoadInputSchema,
  menuLoadSchema,
  createOrderIssueInputSchema,
  expoBoardSchema,
  expoRunnerSchema,
  expoTicketSchema,
  kitchenItemActionSchema,
  kitchenTicketDetailSchema,
  kitchenTicketIdSchema,
  kitchenTicketItemIdSchema,
  kitchenTicketItemSchema,
  orderIdSchema,
  orderIssueSchema,
  orderIssueViewSchema,
  orderIssueTypeSchema,
  pacingSnapshotSchema,
  pickupCallSchema,
  pickupDisplaySchema,
  servingTimeEstimateSchema,
  servingTimeGroupSchema,
  servingTimeSummarySchema,
  stationBoardSchema,
  stationCapacityRuleSchema,
  stationConfigSchema,
  stationIdSchema,
  stationLabelSchema,
  stationSummarySchema,
} from "./schemas.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const stationParams = z.strictObject({
  outletId: outletIdSchema,
  stationId: stationIdSchema,
});

/** Visible KDS screens send this every five seconds to their local edge node. */
export const recordKitchenStationHeartbeat = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/heartbeat",
  params: stationParams,
  body: z.strictObject({}),
  response: dataResponseSchema(z.strictObject({ recorded: z.boolean() })),
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

/**
 * One station's new tab settings in a `updateKitchenStations` save. A save may
 * name only some stations of the outlet: the others keep their settings.
 */
export const updateKitchenStationInputSchema = z.strictObject({
  stationId: stationConfigSchema.shape.stationId,
  displayOrder: stationConfigSchema.shape.displayOrder,
  isActive: stationConfigSchema.shape.isActive,
  autoPrintFallback: stationConfigSchema.shape.autoPrintFallback,
});

export const updateKitchenStationsBodySchema = z
  .strictObject({
    stations: z.array(updateKitchenStationInputSchema).min(1).max(100),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of body.stations.entries()) {
      if (seen.has(entry.stationId))
        ctx.addIssue({
          code: "custom",
          path: ["stations", index, "stationId"],
          message: "Stasiun yang sama tidak boleh disebut dua kali.",
        });
      seen.add(entry.stationId);
    }
  });

/**
 * Kitchen config: save the KDS tab order and the two flags in one call, so a
 * reorder is never half saved (`kds.station.manage`). The answer is the whole
 * outlet in display order. A station id twice, a station of another outlet or
 * tenant, or a result with no active station is refused (legend-bopi2).
 */
export const updateKitchenStations = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/kitchen/stations",
  params: outletParams,
  body: updateKitchenStationsBodySchema,
  response: dataResponseSchema(z.array(stationConfigSchema)),
});

/**
 * Station labels for the KDS switch and timer (legend-gt7f). Needs only
 * `kds.ticket.process`, so a cook reads the name and target time without
 * `menu.item.view`. Lists the active stations the caller reaches, by name.
 */
export const listKitchenStationLabels = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/station-labels",
  params: outletParams,
  response: dataResponseSchema(z.array(stationLabelSchema)),
});

/**
 * A cook reads the capacity rules of one station they reach (legend-gt7f).
 * Slim rows: the config screen's `listCapacityRules` keeps the full rows and
 * `kds.station.manage`. Ordered by window, then rule.
 */
export const getStationCapacityRules = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/capacity-rules",
  params: stationParams,
  response: dataResponseSchema(z.array(stationCapacityRuleSchema)),
});

/** One KDS station tab: open tickets, all-day count, current pacing (F12). */
export const getKitchenBoard = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/board",
  params: stationParams,
  response: dataResponseSchema(stationBoardSchema),
});

/**
 * KDS station switch: open-ticket count per station in one small payload, so
 * the tablet does not poll every station's board (legend-tsp5).
 */
export const getKitchenStationSummary = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/station-summary",
  params: outletParams,
  response: dataResponseSchema(stationSummarySchema),
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

/**
 * Expo runner assignment (F12). Once the order is delivered, naming a
 * different runner fails 409 EXPO_ORDER_DELIVERED; naming the same runner is a
 * repeat (200, unchanged). Before delivery, reassigning replaces the runner.
 */
export const assignExpoRunner = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/expo/:orderId/runner",
  params: orderParams,
  body: clientInputSchema({ runnerId: userIdSchema }),
  response: dataResponseSchema(expoTicketSchema),
});

/**
 * "Diantar": the runner marks the order delivered from their phone (PRD §4
 * flow D step 4, flow G step 3; bead legend-usw3). No body: the server stamps
 * `deliveredAt` and the acting user from the session. Allowed when the ticket
 * is complete and has a runner (`expoDeliveryBlock`); otherwise 409
 * EXPO_ORDER_NOT_COMPLETE or EXPO_RUNNER_NOT_ASSIGNED. Idempotent: repeating
 * answers 200 with the ticket unchanged and the first `deliveredAt`.
 */
export const markExpoOrderDelivered = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/expo/:orderId/delivered",
  params: orderParams,
  response: dataResponseSchema(expoTicketSchema),
});

/**
 * The staff the expo screen may pick as runner (F12 "menugaskan runner").
 * `assignExpoRunner` takes a `userId`; this projection supplies the choices
 * with their names. Read-only — which roles may run is roster configuration
 * (bead legend-zvz).
 */
export const listExpoRunners = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/expo/runners",
  params: outletParams,
  response: dataResponseSchema(z.array(expoRunnerSchema)),
});

/** Pickup display: called numbers for takeaway and delivery channels (F12). */
export const getPickupDisplay = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/pickup-display",
  params: outletParams,
  response: dataResponseSchema(pickupDisplaySchema),
});

/**
 * "Panggil": show and announce a pickup number (assigned -> called). Calling a
 * called number re-announces it and keeps the first `calledAt`; a picked-up
 * number fails 409 PICKUP_CALL_CLOSED.
 */
export const callPickupNumber = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pickup-calls/:callId/call",
  params: z.strictObject({
    outletId: outletIdSchema,
    callId: uuidSchema,
  }),
  response: dataResponseSchema(pickupCallSchema),
});

/**
 * "Diambil": the customer or delivery driver collected the order, closing the
 * number (called -> picked_up; bead legend-usw3). No body: the server stamps
 * `pickedUpAt`. `PICKUP_CALL_TRANSITIONS` is the rule: from `assigned` it
 * fails 409 PICKUP_CALL_NOT_CALLED; repeating on `picked_up` answers 200 with
 * the call unchanged and the first `pickedUpAt`.
 */
export const markPickupPickedUp = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/pickup-calls/:callId/picked-up",
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

/**
 * Kitchen config reads the capacity rules before replacing them (bead
 * legend-uq2). `updateCapacityRules` replaces a station's whole list, so the
 * screen needs the current rows to edit without dropping a window.
 */
export const listCapacityRules = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/capacity-rules",
  params: outletParams,
  response: dataResponseSchema(z.array(capacityRuleSchema)),
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
 * legend-7svpq: menu load admin. `listMenuLoads` reads the load of every menu
 * line of the outlet; `setMenuLoads` upserts lines (same values = no change,
 * no audit); `deleteMenuLoad` removes one line and answers `removed: false`
 * when it was already gone.
 */
export const listMenuLoads = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/menu-loads",
  params: outletParams,
  response: dataResponseSchema(z.array(menuLoadSchema)),
});

export const setMenuLoads = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/kitchen/menu-loads",
  params: outletParams,
  body: clientInputSchema({
    loads: z.array(menuLoadInputSchema).min(1).max(100),
  }),
  response: dataResponseSchema(z.array(menuLoadSchema)),
});

export const deleteMenuLoad = defineEndpoint({
  method: "DELETE",
  path: "/api/outlets/:outletId/kitchen/menu-loads/:loadId",
  params: z.strictObject({ outletId: outletIdSchema, loadId: uuidSchema }),
  response: dataResponseSchema(
    z.strictObject({ id: uuidSchema, removed: z.boolean() }),
  ),
});

/**
 * legend-7svpq: live channel pauses of the outlet, automatic and manual (the
 * `reason` tells them apart). Only a `manual` pause can be set or lifted here.
 */
export const listChannelPauses = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/channel-pauses",
  params: outletParams,
  response: dataResponseSchema(z.array(channelPauseSchema)),
});

/**
 * Pauses a menu line manually. One live manual pause per line: a repeated PUT
 * replaces its channels and end time.
 */
export const setManualChannelPause = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/kitchen/channel-pauses",
  params: outletParams,
  body: clientInputSchema(manualChannelPauseInputSchema.shape),
  response: dataResponseSchema(channelPauseSchema),
});

/** Lifts a manual pause. An automatic pause answers 404; a lifted one `released: false`. */
export const releaseManualChannelPause = defineEndpoint({
  method: "DELETE",
  path: "/api/outlets/:outletId/kitchen/channel-pauses/:pauseId",
  params: z.strictObject({ outletId: outletIdSchema, pauseId: uuidSchema }),
  response: dataResponseSchema(
    z.strictObject({ id: uuidSchema, released: z.boolean() }),
  ),
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
    // Same period keys as every report route (metrics METRIC_REPORT_QUERY_KEYS).
    startDate: businessDateSchema,
    endDate: businessDateSchema,
  }).refine((query) => query.startDate <= query.endDate, {
    path: ["endDate"],
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

/**
 * Remake/comp log for the kitchen analytics screen. Rows carry the order label,
 * item name and staff names (legend-0eq7), so the UI shows no id.
 */
export const listOrderIssues = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/order-issues",
  params: outletParams,
  query: cursorPageQuerySchema.extend({
    type: orderIssueTypeSchema.optional(),
    stationId: stationIdSchema.optional(),
  }),
  response: cursorPageSchema(orderIssueViewSchema),
});
