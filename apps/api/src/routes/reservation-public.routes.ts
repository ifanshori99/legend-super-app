// Guest reservation self-service routes (PRD v1.7 §3.22, RSV-03; bead
// legend-o5gr). Paths, params, bodies and queries come from the WS-08 contract
// (`@starter/shared/reservation` self-service endpoints).
//
// Mount at the API root: `apiRouter.use(reservationPublicRouter)`. The contract
// paths are absolute, like reservation.routes.ts.
//
// - Public (guest, no session): tenant from the host (TEN-02). The bearer is
//   the signed-link token in the `x-reservation-link-token` HEADER, never the
//   URL path or query, so it stays out of access logs (the web link carries it
//   in the URL fragment). A missing, malformed, unknown, expired or revoked
//   token gets the same 404 RESERVATION_LINK_INVALID from the service.
// - Public writes need `Idempotency-Key`. They have their own per-IP limit
//   (separate from the booking POST's counters, no tenant bucket of its own;
//   the path is still under the shared public per-tenant limit) and a
//   per-link cap the service charges once the link resolves.
// - Staff: requireAuth + requireTrustedOrigin + requireTenantContext, then
//   `reservation.view` / `reservation.manage` on the path's outlet (TEN-03).
import { Router, type Request, type Response } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { idempotencyKeySchema } from "@starter/shared/core";
import {
  approveRescheduleRequest as approveRescheduleEndpoint,
  cancelGuestReservation as cancelGuestEndpoint,
  declineRescheduleRequest as declineRescheduleEndpoint,
  issueReservationGuestLink as issueLinkEndpoint,
  listRescheduleRequests as listRescheduleEndpoint,
  requestGuestReschedule as rescheduleGuestEndpoint,
  revokeReservationGuestLink as revokeLinkEndpoint,
  RESERVATION_LINK_TOKEN_HEADER,
} from "@starter/shared/reservation";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { createPublicBookingLimits } from "../middleware/public-rate-limit.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  GuestLinkRateLimitedError,
  cancelGuestReservation,
  getGuestReservation,
  issueGuestLinkForStaff,
  listRescheduleRequests,
  requestGuestReschedule,
  revokeGuestLinkForStaff,
} from "../services/reservation-public.ts";
import {
  approveRescheduleRequest,
  declineRescheduleRequest,
} from "../services/reservation-reschedule.ts";

export const reservationPublicRouter = Router();

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const view = requireOutletPermission("reservation.view", outletOf);
const manage = requireOutletPermission("reservation.manage", outletOf);
// Own instance: the guest self-service writes must not spend the booking POST's
// per-IP and per-tenant budget (and the other way round).
// This instance has no tenant bucket of its own, but that does not lift the
// tenant limit: the path stays in PUBLIC_RATE_LIMIT_PATHS
// (middleware/public-rate-limit.ts), so the shared per-IP and per-tenant limit
// still applies before the token is checked (decision: the shared limit is
// kept). A per-link cap is charged in the service once the link resolves.
const guestWriteLimits = createPublicBookingLimits({
  perTenant: Number.MAX_SAFE_INTEGER,
});
const staff = [requireAuth, requireTrustedOrigin, requireTenantContext];

/** The `Idempotency-Key` header only; the body is returned unchanged. */
function takeIdempotencyKey(req: Request): {
  key: string;
  body: unknown;
} {
  const parsed = idempotencyKeySchema.safeParse(req.header("idempotency-key"));
  if (!parsed.success)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib diisi (8-100 karakter).",
    );
  return { key: parsed.data, body: req.body };
}

// The raw header value (or ""): the service format-checks it and answers every
// bad token with the same 404, so a missing header leaks nothing either.
const linkToken = (req: Request) =>
  req.header(RESERVATION_LINK_TOKEN_HEADER) ?? "";

/** Sends `Retry-After` when the service rejects with the per-link cap. */
async function withRetryAfter<T>(res: Response, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof GuestLinkRateLimitedError) {
      res.setHeader("Retry-After", String(error.retryAfter));
      res.setHeader("Cache-Control", "no-store");
    }
    throw error;
  }
}

const publicContext = (req: Request) =>
  establishScopedTenantContext(getTenantContext(req), { kind: "tenant" });

// ------------------------------------------------------------- public

reservationPublicRouter.get(
  "/public/reservation-link",
  requireTenantContext,
  async (req, res) => {
    res.json({
      data: await getGuestReservation(publicContext(req), linkToken(req)),
    });
  },
);

reservationPublicRouter.post(
  "/public/reservation-link/cancel",
  requireTenantContext,
  guestWriteLimits.perRequest,
  jsonBody,
  async (req, res) => {
    const { key, body } = takeIdempotencyKey(req);
    const input = cancelGuestEndpoint.body.parse(body);
    res.json({
      data: await withRetryAfter(
        res,
        cancelGuestReservation(publicContext(req), linkToken(req), input, key),
      ),
    });
  },
);

reservationPublicRouter.post(
  "/public/reservation-link/reschedule",
  requireTenantContext,
  guestWriteLimits.perRequest,
  jsonBody,
  async (req, res) => {
    const { key, body } = takeIdempotencyKey(req);
    const input = rescheduleGuestEndpoint.body.parse(body);
    res.json({
      data: await withRetryAfter(
        res,
        requestGuestReschedule(publicContext(req), linkToken(req), input, key),
      ),
    });
  },
);

// -------------------------------------------------------------- staff

reservationPublicRouter.post(
  "/outlets/:outletId/reservations/:reservationId/guest-link",
  ...staff,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = issueLinkEndpoint.params.parse(
      req.params,
    );
    res.status(201).json({
      data: await issueGuestLinkForStaff(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        reservationId,
      ),
    });
  },
);

reservationPublicRouter.delete(
  "/outlets/:outletId/reservations/:reservationId/guest-link",
  ...staff,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = revokeLinkEndpoint.params.parse(
      req.params,
    );
    await revokeGuestLinkForStaff(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      outletId,
      reservationId,
    );
    res.status(204).end();
  },
);

reservationPublicRouter.get(
  "/outlets/:outletId/reservation-reschedule-requests",
  ...staff,
  view,
  async (req, res) => {
    const { outletId } = listRescheduleEndpoint.params.parse(req.params);
    const query = listRescheduleEndpoint.query.parse(req.query);
    res.json(
      await listRescheduleRequests(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        query,
      ),
    );
  },
);

reservationPublicRouter.post(
  "/outlets/:outletId/reservation-reschedule-requests/:requestId/approve",
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, requestId } = approveRescheduleEndpoint.params.parse(
      req.params,
    );
    approveRescheduleEndpoint.body.parse(req.body ?? {});
    res.json({
      data: await approveRescheduleRequest(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        requestId,
      ),
    });
  },
);

reservationPublicRouter.post(
  "/outlets/:outletId/reservation-reschedule-requests/:requestId/decline",
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, requestId } = declineRescheduleEndpoint.params.parse(
      req.params,
    );
    res.json({
      data: await declineRescheduleRequest(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        requestId,
        declineRescheduleEndpoint.body.parse(req.body ?? {}),
      ),
    });
  },
);
