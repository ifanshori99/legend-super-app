// HTTP contracts for facility access and WFC (PRD v1.7 §3 F22/F23/F39).
// The API validates with these objects and the web app's typed client + mock
// runtime read the same ones (docs/frontend.md "Typed endpoints and mock mode"),
// so the FE beads can build against fixtures before the API exists.
//
// Paths: `/api/facility/...` for facility access, `/api/wifi/...` for the guest
// Wi-Fi portal. Authorization lives in the service layer, never in the path.

import {
  z,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  accessTicketCredentialSchema,
  accessTicketSchema,
  accessTicketViewSchema,
  cancellationResolutionSchema,
  cleaningTaskSchema,
  facilityAddonSchema,
  facilityAvailabilitySchema,
  facilityAreaSchema,
  facilityConfigSchema,
  facilityIncidentSchema,
  facilityProductSchema,
  facilityQueueEntrySchema,
  facilitySchema,
  facilitySubscriptionSchema,
  facilitySubscriptionViewSchema,
  facilityUnitBoardRowSchema,
  facilityUnitSchema,
  entitlementLedgerEntrySchema,
  entitlementRuleSchema,
  subscriptionInvoiceSchema,
  subscriptionPlanSchema,
  wifiPolicySchema,
  wifiQuotaViewSchema,
  wifiSessionSchema,
  facilityListItemSchema,
} from "./schemas.ts";
import {
  bookAccessTicketSchema,
  cancelAccessTicketSchema,
  completeCleaningTaskSchema,
  createCleaningTaskSchema,
  createFacilityAddonSchema,
  createFacilityAreaSchema,
  createFacilityProductSchema,
  createFacilitySchema,
  createFacilityUnitSchema,
  createSubscriptionPlanSchema,
  customerEntitlementsParamsSchema,
  customerEntitlementsQuerySchema,
  facilityConfigQuerySchema,
  facilityUnitsQuerySchema,
  joinFacilityQueueSchema,
  leaveFacilityQueueParamsSchema,
  listAccessTicketsQuerySchema,
  listAvailabilityQuerySchema,
  putEntitlementRuleSchema,
  putWifiPolicySchema,
  raiseFacilityIncidentSchema,
  refreshWifiQuotaSchema,
  respondFacilityIncidentSchema,
  staffIssueEntitlementSchema,
  staffSellTicketSchema,
  startCleaningTaskSchema,
  startSubscriptionSchema,
  startWifiSessionSchema,
  subscriptionParamsSchema,
  updateFacilityAddonSchema,
  updateFacilityAreaSchema,
  updateFacilityProductSchema,
  updateFacilitySchema,
  updateFacilityUnitConfigSchema,
  updateFacilityUnitSchema,
  updateSubscriptionPlanSchema,
  updateSubscriptionSchema,
  wifiPolicyParamsSchema,
  wifiPolicyQuerySchema,
  wifiSessionParamsSchema,
} from "./inputs.ts";
import {
  accessTicketIdSchema,
  cleaningTaskIdSchema,
  entitlementRuleIdSchema,
  facilityAddonIdSchema,
  facilityAreaIdSchema,
  facilityIdSchema,
  facilityIncidentIdSchema,
  facilityProductIdSchema,
  facilityUnitIdSchema,
  subscriptionPlanIdSchema,
} from "./ids.ts";
import { posTicketSaleSchema } from "../pos/ticket.ts";
import {
  currentEntitlementsSchema,
  facilityCustomerEndpoints,
  publicSubscriptionPlanSchema,
} from "./customer.ts";

const ticketIdParams = z.strictObject({ ticketId: accessTicketIdSchema });
const unitIdParams = z.strictObject({ unitId: facilityUnitIdSchema });
const taskIdParams = z.strictObject({ taskId: cleaningTaskIdSchema });
const incidentIdParams = z.strictObject({
  incidentId: facilityIncidentIdSchema,
});
const planIdParams = z.strictObject({ planId: subscriptionPlanIdSchema });
const areaIdParams = z.strictObject({ areaId: facilityAreaIdSchema });
const productIdParams = z.strictObject({ productId: facilityProductIdSchema });
const addonIdParams = z.strictObject({ addonId: facilityAddonIdSchema });
const ruleIdParams = z.strictObject({ ruleId: entitlementRuleIdSchema });

/**
 * The PIN and QR token are returned here, once. Fetching the ticket again
 * returns `accessTicketViewSchema`, which never repeats them.
 */
const issuedTicketSchema = z.strictObject({
  ticket: accessTicketSchema,
  credential: accessTicketCredentialSchema,
});

// ---- Customer: availability, booking, ticket, queue, subscriptions ----------

export const getFacilityAvailability = defineEndpoint({
  method: "GET",
  path: "/api/facility/availability",
  query: listAvailabilityQuerySchema,
  response: dataResponseSchema(facilityAvailabilitySchema),
});

export const bookAccessTicket = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets",
  body: bookAccessTicketSchema,
  response: dataResponseSchema(issuedTicketSchema),
});

/** POS / offline edge sale: the cashier names the customer (FAC-03). */
export const sellAccessTicketAtPos = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/pos",
  body: staffSellTicketSchema,
  // 936 D: the sale opens a POS bill and holds the slot; the ticket is issued
  // only when the bill is paid, and its door credential comes from
  // `issuePosTicketCredential` (@starter/shared/pos/ticket).
  response: dataResponseSchema(posTicketSaleSchema),
});

/**
 * Door check (936 second-opinion fix, group T): the cloud validator of the QR
 * token or PIN a paid ticket was given (`issuePosTicketCredential`). Exactly
 * one of two shapes: the QR token alone, or the ticket id with its 6-digit PIN.
 * A good credential opens the ticket (`issued` becomes `in_use`, the first
 * open is recorded once; a repeat check answers 200 again). EVERY credential
 * failure answers one uniform 403 `DOOR_CREDENTIAL_INVALID` so a caller cannot
 * tell which part was wrong: unknown token, wrong PIN, a rotated or revoked
 * pair (refund, void), outside the credential window, a ticket that is not
 * paid or in use, a ticket of another tenant. A refused check changes nothing.
 */
export const doorCheckAccessTicketBodySchema = z.union([
  z.strictObject({ qrToken: z.string().min(1).max(512) }),
  z.strictObject({
    ticketId: accessTicketIdSchema,
    pin: z.string().regex(/^\d{6}$/, "The door PIN is exactly 6 digits"),
  }),
]);
export type DoorCheckAccessTicketBody = z.infer<
  typeof doorCheckAccessTicketBodySchema
>;

export const doorCheckAccessTicket = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/door-check",
  body: doorCheckAccessTicketBodySchema,
  response: dataResponseSchema(z.strictObject({ ticket: accessTicketSchema })),
});

export const listAccessTickets = defineEndpoint({
  method: "GET",
  path: "/api/facility/tickets",
  query: listAccessTicketsQuerySchema,
  response: cursorPageSchema(accessTicketViewSchema),
});

export const getAccessTicket = defineEndpoint({
  method: "GET",
  path: "/api/facility/tickets/:ticketId",
  params: ticketIdParams,
  response: dataResponseSchema(accessTicketViewSchema),
});

export const cancelAccessTicket = defineEndpoint({
  method: "POST",
  path: "/api/facility/tickets/:ticketId/cancel",
  params: ticketIdParams,
  body: cancelAccessTicketSchema,
  response: dataResponseSchema(
    z.strictObject({
      ticket: accessTicketSchema,
      resolution: cancellationResolutionSchema,
      /** Fee kept by the house for a partial refund (0 otherwise). */
      feeIdr: idrSchema.refine((value) => value >= 0),
    }),
  ),
});

export const joinFacilityQueue = defineEndpoint({
  method: "POST",
  path: "/api/facility/queue",
  body: joinFacilityQueueSchema,
  response: dataResponseSchema(facilityQueueEntrySchema),
});

/** The caller's own place in the queue; null when not queued. */
export const getCurrentFacilityQueueEntry = defineEndpoint({
  method: "GET",
  path: "/api/facility/queue/current",
  query: z.strictObject({ facilityId: facilityIdSchema }),
  response: dataResponseSchema(facilityQueueEntrySchema.nullable()),
});

export const leaveFacilityQueue = defineEndpoint({
  method: "DELETE",
  path: "/api/facility/queue/:entryId",
  params: leaveFacilityQueueParamsSchema,
});

export const listSubscriptionPlans = defineEndpoint({
  method: "GET",
  path: "/api/facility/subscription-plans",
  query: z.strictObject({ facilityId: facilityIdSchema }),
  response: dataResponseSchema(
    z.strictObject({ plans: z.array(publicSubscriptionPlanSchema) }),
  ),
});

export const getCurrentFacilitySubscription = defineEndpoint({
  method: "GET",
  path: "/api/facility/subscriptions/current",
  response: dataResponseSchema(facilitySubscriptionViewSchema.nullable()),
});

export const startFacilitySubscription = defineEndpoint({
  method: "POST",
  path: "/api/facility/subscriptions",
  body: startSubscriptionSchema,
  response: dataResponseSchema(
    z.strictObject({
      subscription: facilitySubscriptionSchema,
      invoice: subscriptionInvoiceSchema,
    }),
  ),
});

export const updateFacilitySubscription = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/subscriptions/:subscriptionId",
  params: subscriptionParamsSchema,
  body: updateSubscriptionSchema,
  response: dataResponseSchema(facilitySubscriptionSchema),
});

// ---- Staff: status board, cleaning, incidents ------------------------------

export const getFacilityUnitBoard = defineEndpoint({
  method: "GET",
  path: "/api/facility/units",
  query: facilityUnitsQuerySchema,
  response: dataResponseSchema(
    z.strictObject({
      rows: z.array(facilityUnitBoardRowSchema),
      serverTime: isoDateTimeSchema,
    }),
  ),
});

export const createCleaningTask = defineEndpoint({
  method: "POST",
  path: "/api/facility/cleaning-tasks",
  body: createCleaningTaskSchema,
  response: dataResponseSchema(cleaningTaskSchema),
});

export const startCleaningTask = defineEndpoint({
  method: "POST",
  path: "/api/facility/cleaning-tasks/:taskId/start",
  params: taskIdParams,
  body: startCleaningTaskSchema,
  response: dataResponseSchema(cleaningTaskSchema),
});

export const completeCleaningTask = defineEndpoint({
  method: "POST",
  path: "/api/facility/cleaning-tasks/:taskId/complete",
  params: taskIdParams,
  body: completeCleaningTaskSchema,
  response: dataResponseSchema(
    z.strictObject({
      task: cleaningTaskSchema,
      unit: facilityUnitSchema,
    }),
  ),
});

export const updateFacilityUnit = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/units/:unitId",
  params: unitIdParams,
  body: updateFacilityUnitSchema,
  response: dataResponseSchema(facilityUnitSchema),
});

export const raiseFacilityIncident = defineEndpoint({
  method: "POST",
  path: "/api/facility/incidents",
  body: raiseFacilityIncidentSchema,
  response: dataResponseSchema(facilityIncidentSchema),
});

export const respondFacilityIncident = defineEndpoint({
  method: "POST",
  path: "/api/facility/incidents/:incidentId/respond",
  params: incidentIdParams,
  body: respondFacilityIncidentSchema,
  response: dataResponseSchema(facilityIncidentSchema),
});

/**
 * The incident log read (bead legend-1oi9). The contract could raise and
 * respond to an incident but not list what was recorded, and the staff
 * emergency screen must show the log (PRD §3 F25 "Keselamatan"). The API
 * implementation is a follow-up bead; mock mode serves the fixtures.
 */
export const listFacilityIncidents = defineEndpoint({
  method: "GET",
  path: "/api/facility/incidents",
  query: cursorPageQuerySchema.extend({ facilityId: facilityIdSchema }),
  response: cursorPageSchema(facilityIncidentSchema),
});

// ---- Guest Wi-Fi ------------------------------------------------------------

export const getWifiPolicyForZone = defineEndpoint({
  method: "GET",
  path: "/api/wifi/policy",
  query: wifiPolicyQuerySchema,
  response: dataResponseSchema(wifiPolicySchema),
});

export const startWifiSession = defineEndpoint({
  method: "POST",
  path: "/api/wifi/sessions",
  body: startWifiSessionSchema,
  response: dataResponseSchema(wifiQuotaViewSchema),
});

export const getCurrentWifiSession = defineEndpoint({
  method: "GET",
  path: "/api/wifi/sessions/current",
  response: dataResponseSchema(wifiQuotaViewSchema.nullable()),
});

/**
 * Recompute the daily allowance after a payment lands (FAC-12, <= 1 minute).
 * The server recomputes spend from the account's settled payments; the body
 * schema is a strict empty object so a client cannot supply its own spend.
 */
export const refreshWifiQuota = defineEndpoint({
  method: "POST",
  path: "/api/wifi/sessions/current/refresh",
  body: refreshWifiQuotaSchema,
  response: dataResponseSchema(wifiQuotaViewSchema),
});

export const endWifiSession = defineEndpoint({
  method: "POST",
  path: "/api/wifi/sessions/:sessionId/end",
  params: wifiSessionParamsSchema,
  response: dataResponseSchema(wifiSessionSchema),
});

// ---- Admin configuration (bead legend-er32) --------------------------------

/**
 * The tenant's facilities, for the config index (bead legend-er32). The
 * contract had no list read: a config screen cannot invent a facility id, and
 * the hierarchy is facility → area → unit (PRD §3 F25 "Model Generik").
 * The API implementation is a follow-up bead; mock mode serves the fixtures.
 */
export const listFacilities = defineEndpoint({
  method: "GET",
  path: "/api/facility/facilities",
  query: cursorPageQuerySchema,
  response: cursorPageSchema(facilityListItemSchema),
});

export const getFacilityConfig = defineEndpoint({
  method: "GET",
  path: "/api/facility/config",
  query: facilityConfigQuerySchema,
  response: dataResponseSchema(facilityConfigSchema),
});

/** Creates a facility of an outlet, so no data needs seeding by SQL (legend-nngz). */
export const createFacility = defineEndpoint({
  method: "POST",
  path: "/api/facility/facilities",
  body: createFacilitySchema,
  response: dataResponseSchema(facilitySchema),
});

export const updateFacility = defineEndpoint({
  method: "PUT",
  path: "/api/facility/facilities/:facilityId",
  params: z.strictObject({ facilityId: facilityIdSchema }),
  body: updateFacilitySchema,
  response: dataResponseSchema(facilitySchema),
});

export const createFacilityArea = defineEndpoint({
  method: "POST",
  path: "/api/facility/areas",
  body: createFacilityAreaSchema,
  response: dataResponseSchema(facilityAreaSchema),
});

export const updateFacilityArea = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/areas/:areaId",
  params: areaIdParams,
  body: updateFacilityAreaSchema,
  response: dataResponseSchema(facilityAreaSchema),
});

/** Creates one bookable unit (booth); `PATCH /units/:unitId` changes its state. */
export const createFacilityUnit = defineEndpoint({
  method: "POST",
  path: "/api/facility/units",
  body: createFacilityUnitSchema,
  response: dataResponseSchema(facilityUnitSchema),
});

/** Edits how a unit is configured; `PATCH /units/:unitId` only moves its state. */
export const updateFacilityUnitConfig = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/units/:unitId/config",
  params: unitIdParams,
  body: updateFacilityUnitConfigSchema,
  response: dataResponseSchema(facilityUnitSchema),
});

export const createFacilityProduct = defineEndpoint({
  method: "POST",
  path: "/api/facility/products",
  body: createFacilityProductSchema,
  response: dataResponseSchema(facilityProductSchema),
});

export const updateFacilityProduct = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/products/:productId",
  params: productIdParams,
  body: updateFacilityProductSchema,
  response: dataResponseSchema(facilityProductSchema),
});

export const createFacilityAddon = defineEndpoint({
  method: "POST",
  path: "/api/facility/addons",
  body: createFacilityAddonSchema,
  response: dataResponseSchema(facilityAddonSchema),
});

export const updateFacilityAddon = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/addons/:addonId",
  params: addonIdParams,
  body: updateFacilityAddonSchema,
  response: dataResponseSchema(facilityAddonSchema),
});

/** PUT replaces one entitlement rule (condition required, fixed per type). */
export const putEntitlementRule = defineEndpoint({
  method: "PUT",
  path: "/api/facility/entitlement-rules/:ruleId",
  params: ruleIdParams,
  body: putEntitlementRuleSchema,
  response: dataResponseSchema(entitlementRuleSchema),
});

export const createSubscriptionPlanEndpoint = defineEndpoint({
  method: "POST",
  path: "/api/facility/subscription-plans",
  body: createSubscriptionPlanSchema,
  response: dataResponseSchema(subscriptionPlanSchema),
});

export const updateSubscriptionPlan = defineEndpoint({
  method: "PATCH",
  path: "/api/facility/subscription-plans/:planId",
  params: planIdParams,
  body: updateSubscriptionPlanSchema,
  response: dataResponseSchema(subscriptionPlanSchema),
});

/** Replaces the Wi-Fi policy of a zone; applies on the next request (FAC-14). */
export const putWifiPolicy = defineEndpoint({
  method: "PUT",
  path: "/api/wifi/policies/:policyId",
  params: wifiPolicyParamsSchema,
  body: putWifiPolicySchema,
  response: dataResponseSchema(wifiPolicySchema),
});

// ---- Staff: entitlements (legend-fjk5, FAC-04) ------------------------------

/** Staff read of a customer's balance and redeemable grants at a facility. */
export const getCustomerEntitlements = defineEndpoint({
  method: "GET",
  path: "/api/facility/customers/:customerProfileId/entitlements",
  params: customerEntitlementsParamsSchema,
  query: customerEntitlementsQuerySchema,
  response: dataResponseSchema(currentEntitlementsSchema),
});

/** `duplicate` = the same `requestId` was already issued (idempotent retry). */
export const staffIssuedEntitlementSchema = z.strictObject({
  status: z.enum(["issued", "duplicate"]),
  entry: entitlementLedgerEntrySchema,
});

export const staffIssueEntitlement = defineEndpoint({
  method: "POST",
  path: "/api/facility/entitlements/staff-issue",
  body: staffIssueEntitlementSchema,
  response: dataResponseSchema(staffIssuedEntitlementSchema),
});

/** Every facility endpoint, for the mock runtime and future route generation. */
export const facilityEndpoints = [
  getFacilityAvailability,
  bookAccessTicket,
  sellAccessTicketAtPos,
  doorCheckAccessTicket,
  listAccessTickets,
  getAccessTicket,
  cancelAccessTicket,
  joinFacilityQueue,
  getCurrentFacilityQueueEntry,
  leaveFacilityQueue,
  listSubscriptionPlans,
  getCurrentFacilitySubscription,
  startFacilitySubscription,
  updateFacilitySubscription,
  getFacilityUnitBoard,
  createCleaningTask,
  startCleaningTask,
  completeCleaningTask,
  updateFacilityUnit,
  raiseFacilityIncident,
  respondFacilityIncident,
  listFacilityIncidents,
  getWifiPolicyForZone,
  startWifiSession,
  getCurrentWifiSession,
  refreshWifiQuota,
  endWifiSession,
  listFacilities,
  getFacilityConfig,
  createFacility,
  updateFacility,
  createFacilityArea,
  updateFacilityArea,
  createFacilityUnit,
  updateFacilityUnitConfig,
  createFacilityProduct,
  updateFacilityProduct,
  createFacilityAddon,
  updateFacilityAddon,
  putEntitlementRule,
  createSubscriptionPlanEndpoint,
  updateSubscriptionPlan,
  putWifiPolicy,
  getCustomerEntitlements,
  staffIssueEntitlement,
  ...facilityCustomerEndpoints,
] as const;
