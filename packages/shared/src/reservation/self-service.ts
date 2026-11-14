// Guest self-service for a reservation through a signed link (PRD v1.7 §3.22
// "DP & Kebijakan" and "Pengingat", RSV-03: a cancellation follows the policy
// snapshot taken at booking).
//
// The link token is a bearer secret: the guest sends it in the
// `x-reservation-link-token` header, never in a URL path or query, so it stays
// out of access logs. The web link carries it in the URL fragment, which
// browsers never send to a server. The server stores only its SHA-256 hex.
// A bad format, unknown, other-tenant, expired or revoked token all answer the
// same 404 `RESERVATION_LINK_INVALID`.
//
// The guest view never carries contact data, table ids or staff ids.

import {
  cursorPageSchema,
  dataResponseSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  timeZoneSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  reservationDepositOutcomeSchema,
  reservationIdSchema,
  reservationPolicySnapshotSchema,
  reservationSchema,
  reservationStatusSchema,
} from "./schemas.ts";

const nonnegativeIdr = idrSchema.refine((value) => value >= 0);

// ---- Link token -----------------------------------------------------------

/** HTTP header that carries the link token. */
export const RESERVATION_LINK_TOKEN_HEADER = "x-reservation-link-token";

/** The link stays valid this many hours after `reservedFor`. */
export const GUEST_LINK_GRACE_HOURS = 24;

/** 32 random bytes, base64url without padding: exactly 43 characters. */
export const reservationLinkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/);

// ---- Reschedule requests --------------------------------------------------

export const RESCHEDULE_REQUEST_STATUSES = [
  "pending",
  "approved",
  "declined",
  "withdrawn",
] as const;
export const rescheduleRequestStatusSchema = z.enum(
  RESCHEDULE_REQUEST_STATUSES,
);
export type RescheduleRequestStatus = z.infer<
  typeof rescheduleRequestStatusSchema
>;

export const rescheduleRequestIdSchema = uuidSchema;

/** A guest's ask to move the booking; staff approve it later. */
export const reservationRescheduleRequestSchema = z.strictObject({
  id: rescheduleRequestIdSchema,
  reservationId: reservationIdSchema,
  outletId: outletIdSchema,
  requestedFor: isoDateTimeSchema,
  partySize: z.number().int().min(1).max(50).nullable(),
  note: z.string().max(300).nullable(),
  status: rescheduleRequestStatusSchema,
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
});
export type ReservationRescheduleRequest = z.infer<
  typeof reservationRescheduleRequestSchema
>;

// ---- Guest view -----------------------------------------------------------

/** What the guest sees behind the link: no contact data, tables or staff ids. */
export const guestReservationViewSchema = z.strictObject({
  reservationId: reservationIdSchema,
  outletId: outletIdSchema,
  outletName: z.string().min(1),
  guestName: z.string().min(1),
  partySize: z.number().int().min(1),
  /** IANA zone of the outlet (`outlets.timezone`); the UI shows times in it. */
  timeZone: timeZoneSchema,
  reservedFor: isoDateTimeSchema,
  status: reservationStatusSchema,
  note: z.string().nullable(),
  /** The snapshot taken at booking; the cancel outcome follows it (RSV-03). */
  policy: reservationPolicySnapshotSchema,
  deposit: z.strictObject({
    amountIdr: nonnegativeIdr,
    paidIdr: nonnegativeIdr,
    refundIdr: nonnegativeIdr.nullable(),
    forfeitedIdr: nonnegativeIdr.nullable(),
    refundStatus: z.string().nullable(),
  }),
  cancellation: z.strictObject({
    allowed: z.boolean(),
    /**
     * `reservedFor` minus `freeCancellationHours`; always set, even when the
     * reservation is no longer cancellable.
     */
    freeUntil: isoDateTimeSchema.nullable(),
    /** What happens to the DP if the guest cancels now; null when not allowed. */
    preview: reservationDepositOutcomeSchema.nullable(),
  }),
  /** The latest pending request, else null. */
  rescheduleRequest: reservationRescheduleRequestSchema.nullable(),
  /**
   * The latest request staff already decided (newest `resolvedAt`), else null.
   * Separate from `rescheduleRequest`, which stays pending-only.
   */
  rescheduleDecision: z
    .strictObject({
      outcome: z.enum(["approved", "declined"]),
      decidedAt: isoDateTimeSchema,
      requestedFor: isoDateTimeSchema,
      partySize: z.number().int().min(1).max(50).nullable(),
      /**
       * The booking time that was replaced; set only when approved, null when
       * declined and on requests approved before it was stored. The decline
       * reason is never sent to the guest (it may hold internal notes).
       */
      previousReservedFor: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  linkExpiresAt: isoDateTimeSchema,
});
export type GuestReservationView = z.infer<typeof guestReservationViewSchema>;

// ---- Guest actions --------------------------------------------------------

export const guestCancelInputSchema = z.strictObject({
  reason: z.string().min(1).max(300).optional(),
});
export type GuestCancelInput = z.infer<typeof guestCancelInputSchema>;

export const guestCancelResultSchema = z.strictObject({
  view: guestReservationViewSchema,
  depositOutcome: reservationDepositOutcomeSchema,
  /** True when the reservation was already cancelled; no new refund is made. */
  alreadyCancelled: z.boolean(),
});
export type GuestCancelResult = z.infer<typeof guestCancelResultSchema>;

export const guestRescheduleInputSchema = z.strictObject({
  requestedFor: isoDateTimeSchema,
  partySize: z.number().int().min(1).max(50).optional(),
  note: z.string().max(300).optional(),
});
export type GuestRescheduleInput = z.infer<typeof guestRescheduleInputSchema>;

export const guestRescheduleResultSchema = z.strictObject({
  view: guestReservationViewSchema,
  request: reservationRescheduleRequestSchema,
});
export type GuestRescheduleResult = z.infer<typeof guestRescheduleResultSchema>;

// ---- Staff ----------------------------------------------------------------

/** Returned once, at issue time; only the hash is stored. */
export const issueGuestLinkResultSchema = z.strictObject({
  token: reservationLinkTokenSchema,
  expiresAt: isoDateTimeSchema,
});
export type IssueGuestLinkResult = z.infer<typeof issueGuestLinkResultSchema>;

export const listRescheduleRequestsQuerySchema = z.strictObject({
  status: rescheduleRequestStatusSchema.optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListRescheduleRequestsQuery = z.infer<
  typeof listRescheduleRequestsQuerySchema
>;

/** Staff approve a request as is: the guest's time (and party size) apply. */
export const approveRescheduleInputSchema = z.strictObject({});
export type ApproveRescheduleInput = z.infer<
  typeof approveRescheduleInputSchema
>;

export const declineRescheduleInputSchema = z.strictObject({
  reason: z.string().min(1).max(300).optional(),
});
export type DeclineRescheduleInput = z.infer<
  typeof declineRescheduleInputSchema
>;

/** The resolved request and the reservation as it stands afterwards. */
export const resolveRescheduleResultSchema = z.strictObject({
  request: reservationRescheduleRequestSchema,
  reservation: reservationSchema,
});
export type ResolveRescheduleResult = z.infer<
  typeof resolveRescheduleResultSchema
>;

// ---- Endpoints ------------------------------------------------------------
// Public routes read the token from `x-reservation-link-token`; the tenant
// comes from the host (D-CORE-3). Staff routes need an outlet-scoped session.

const reservationParams = z.strictObject({
  outletId: outletIdSchema,
  reservationId: reservationIdSchema,
});
const outletParams = z.strictObject({ outletId: outletIdSchema });

export const getGuestReservation = defineEndpoint({
  method: "GET",
  path: "/api/public/reservation-link",
  response: dataResponseSchema(guestReservationViewSchema),
});

/** RSV-03: the outcome follows the snapshot taken at booking. */
export const cancelGuestReservation = defineEndpoint({
  method: "POST",
  path: "/api/public/reservation-link/cancel",
  body: guestCancelInputSchema,
  response: dataResponseSchema(guestCancelResultSchema),
});

/** Records a request only; staff decide, and the booking is unchanged. */
export const requestGuestReschedule = defineEndpoint({
  method: "POST",
  path: "/api/public/reservation-link/reschedule",
  body: guestRescheduleInputSchema,
  response: dataResponseSchema(guestRescheduleResultSchema),
});

/** Issues a new link and revokes the previous active one. */
export const issueReservationGuestLink = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservations/:reservationId/guest-link",
  params: reservationParams,
  response: dataResponseSchema(issueGuestLinkResultSchema),
});

export const revokeReservationGuestLink = defineEndpoint({
  method: "DELETE",
  path: "/api/outlets/:outletId/reservations/:reservationId/guest-link",
  params: reservationParams,
});

export const listRescheduleRequests = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/reservation-reschedule-requests",
  params: outletParams,
  query: listRescheduleRequestsQuerySchema,
  response: cursorPageSchema(reservationRescheduleRequestSchema),
});

const rescheduleRequestParams = z.strictObject({
  outletId: outletIdSchema,
  requestId: rescheduleRequestIdSchema,
});

/**
 * Moves the booking (and its table holds) to the requested time. A taken table
 * is RESERVATION_SLOT_TAKEN and the request stays pending. Repeating it on an
 * approved request returns the same result.
 */
export const approveRescheduleRequest = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservation-reschedule-requests/:requestId/approve",
  params: rescheduleRequestParams,
  body: approveRescheduleInputSchema,
  response: dataResponseSchema(resolveRescheduleResultSchema),
});

/** Closes the request; the booking stays as it was. */
export const declineRescheduleRequest = defineEndpoint({
  method: "POST",
  path: "/api/outlets/:outletId/reservation-reschedule-requests/:requestId/decline",
  params: rescheduleRequestParams,
  body: declineRescheduleInputSchema,
  response: dataResponseSchema(resolveRescheduleResultSchema),
});
