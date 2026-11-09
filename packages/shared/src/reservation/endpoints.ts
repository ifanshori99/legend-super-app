// Typed endpoint contracts for reservations, the waitlist and event pre-orders,
// used by the website and staff apps (typed client + mock mode) and later by
// the API's route validation. Paths are absolute; every `:param` has a schema.
//
// Authorization is not part of the endpoint object:
// - `/api/public/…` routes are the brand website: tenant comes from the host
//   (D-CORE-3), no staff session, and the body cannot carry a tenant or money.
// - Staff routes require an outlet-scoped session and the RBAC permission of
//   the action (RSV-01 table assignment, RSV-02 seating, RSV-03 cancellation).

import {
  cursorPageSchema,
  cursorPageQuerySchema,
  dataResponseSchema,
  outletIdSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  assignReservationTablesInputSchema,
  cancelReservationInputSchema,
  createReservationInputSchema,
  joinWaitlistInputSchema,
  joinWaitlistResultSchema,
  listReservationsQuerySchema,
  markNoShowInputSchema,
  placePreOrderInputSchema,
  putReservationPolicyInputSchema,
  reservationAvailabilityQuerySchema,
  reservationAvailabilitySchema,
  reservationCloseResultSchema,
  reservationCreatedSchema,
  reservationDepositLinkSchema,
  reservationDetailSchema,
  reservationIdSchema,
  reservationPackageSchema,
  reservationPolicyOverviewSchema,
  reservationPolicySchema,
  reservationPreOrderSchema,
  reservationSchema,
  resendDepositLinkInputSchema,
  resolveWaitlistEntryInputSchema,
  resolveWaitlistEntryResultSchema,
  seatReservationInputSchema,
  seatReservationResultSchema,
  waitlistEntryIdSchema,
  waitlistEntrySchema,
  waitlistStatusSchema,
} from "./schemas.ts";

const outletParams = z.strictObject({ outletId: outletIdSchema });
const reservationParams = z.strictObject({
  outletId: outletIdSchema,
  reservationId: reservationIdSchema,
});
const waitlistParams = z.strictObject({
  outletId: outletIdSchema,
  entryId: waitlistEntryIdSchema,
});

// ---- Public website (§3.22 "Reservasi Online", §3.24) ---------------------

/** Free tables per candidate start time for the guest's date and party size. */
export const getReservationAvailability = defineEndpoint({
  method: "GET",
  path: "/api/public/outlets/:outletId/reservation-availability",
  params: outletParams,
  query: reservationAvailabilityQuerySchema,
  response: dataResponseSchema(reservationAvailabilitySchema),
});

/** Book a table; the response carries the DP payment link when the snapshot needs one. */
export const createReservation = defineEndpoint({
  method: "POST",
  path: "/api/public/outlets/:outletId/reservations",
  params: outletParams,
  body: createReservationInputSchema,
  response: dataResponseSchema(reservationCreatedSchema),
});

/** Active event pre-order packages, shown on the reservation form. */
export const listPublicReservationPackages = defineEndpoint({
  method: "GET",
  path: "/api/public/outlets/:outletId/reservation-packages",
  params: outletParams,
  response: dataResponseSchema(z.array(reservationPackageSchema)),
});

/** Walk-in joins the waitlist from the website or the outlet's queue QR. */
export const joinWaitlist = defineEndpoint({
  method: "POST",
  path: "/api/public/outlets/:outletId/waitlist",
  params: outletParams,
  body: joinWaitlistInputSchema,
  response: dataResponseSchema(joinWaitlistResultSchema),
});

// ---- Staff: reservations (§3.22) ------------------------------------------

/** Reservations for one business date (or all upcoming), cursor paged. */
export const listReservations = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/reservations",
  params: outletParams,
  query: listReservationsQuerySchema,
  response: cursorPageSchema(reservationSchema),
});

export const getReservation = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/reservations/:reservationId",
  params: reservationParams,
  response: dataResponseSchema(reservationDetailSchema),
});

/** RSV-01: assign tables on the floor plan; the server rejects overlaps. */
export const assignReservationTables = defineEndpoint({
  method: "PATCH",
  path: "/api/outlets/:outletId/reservations/:reservationId/tables",
  params: reservationParams,
  body: assignReservationTablesInputSchema,
  response: dataResponseSchema(reservationSchema),
});

/** RSV-02: seat the party and allocate the paid DP to the opened table session. */
export const seatReservation = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservations/:reservationId/seat",
  params: reservationParams,
  body: seatReservationInputSchema,
  response: dataResponseSchema(seatReservationResultSchema),
});

/** RSV-03: cancel before arrival; the snapshot decides the DP refund. */
export const cancelReservation = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservations/:reservationId/cancel",
  params: reservationParams,
  body: cancelReservationInputSchema,
  response: dataResponseSchema(reservationCloseResultSchema),
});

/** RSV-03: the guest never arrived; the snapshot decides the DP outcome. */
export const markReservationNoShow = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservations/:reservationId/no-show",
  params: reservationParams,
  body: markNoShowInputSchema,
  response: dataResponseSchema(reservationCloseResultSchema),
});

/**
 * RSV-02: staff resend the DP payment link of a `pending_deposit` booking while
 * the frozen payment window is open. The stored link is reused while valid,
 * otherwise a new one is opened. The `paymentPath` is a guest credential.
 */
export const resendReservationDepositLink = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservations/:reservationId/deposit-link",
  params: reservationParams,
  body: resendDepositLinkInputSchema,
  response: dataResponseSchema(reservationDepositLinkSchema),
});

/** §3.22 "Pre-order Event": attach or replace the group's menu package. */
export const placeReservationPreOrder = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservations/:reservationId/preorder",
  params: reservationParams,
  body: placePreOrderInputSchema,
  response: dataResponseSchema(reservationPreOrderSchema),
});

/** Staff view of the package catalogue (public listing is the website route). */
export const listReservationPackages = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/reservation-packages",
  params: outletParams,
  response: dataResponseSchema(z.array(reservationPackageSchema)),
});

// ---- Staff: waitlist (§3.22 "Waitlist Walk-in") ---------------------------

export const listWaitlistQuerySchema = cursorPageQuerySchema.extend({
  status: waitlistStatusSchema.optional(),
});
export type ListWaitlistQuery = z.infer<typeof listWaitlistQuerySchema>;

export const listWaitlist = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/waitlist",
  params: outletParams,
  query: listWaitlistQuerySchema,
  response: cursorPageSchema(waitlistEntrySchema),
});

/** Call the next guest (the FE raises the browser notification). */
export const callWaitlistEntry = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/waitlist/:entryId/call",
  params: waitlistParams,
  response: dataResponseSchema(waitlistEntrySchema),
});

/** Seat the party on a table (opens a session) or release the entry. */
export const resolveWaitlistEntry = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/waitlist/:entryId/resolve",
  params: waitlistParams,
  body: resolveWaitlistEntryInputSchema,
  response: dataResponseSchema(resolveWaitlistEntryResultSchema),
});

// ---- Staff: DP & cancellation policy (§3.22 "DP & Kebijakan") -------------

/** Active policy plus the retired versions of the outlet. */
export const getReservationPolicy = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/reservation-policy",
  params: outletParams,
  response: dataResponseSchema(reservationPolicyOverviewSchema),
});

/** Saves a NEW version and retires the old one; bookings keep their snapshot. */
export const putReservationPolicy = defineEndpoint({
  method: "PUT",
  path: "/api/outlets/:outletId/reservation-policy",
  params: outletParams,
  body: putReservationPolicyInputSchema,
  response: dataResponseSchema(reservationPolicySchema),
});
