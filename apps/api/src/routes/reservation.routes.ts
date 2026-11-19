// Reservation routes (PRD v1.7 §3.22; RSV-01..03; bead legend-t8bz). Paths,
// params, bodies and queries come from the WS-08 contract
// (`@starter/shared/reservation` defineEndpoint objects).
//
// Mount at the API root: `apiRouter.use(reservationRouter)`. The contract paths
// are absolute (`/outlets/:outletId/reservations…` and
// `/public/outlets/:outletId/…` under /api), and each route carries its own
// middleware, so public and staff routes can share one router.
//
// - Public (website): tenant from the host (TEN-02), no session; the outlet in
//   the path is checked against that tenant in the service.
// - Staff: requireAuthAllowSharedDevice + requireTrustedOrigin + requireTenantContext, then
//   `reservation.view` / `reservation.manage` on the path's outlet (TEN-03).
// - Every mutation needs the `Idempotency-Key` header (8-100 characters). The
//   body goes to the strict contract parse untouched, so a body
//   `idempotencyKey` is refused as an unknown key (bead legend-5jqa).
// - The public booking POST has its own write rate limit (per IP, per tenant)
//   and a cap per guest contact, apart from the read limiter app.ts mounts on
//   /api/public/outlets (middleware/public-rate-limit.ts).
//
// Waitlist, pre-order and package endpoints belong to legend-y9o7.
import { Router, type Request } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { idempotencyKeySchema } from "@starter/shared/core";
import {
  applyReservationCustomerCreditInputSchema,
  reservationCreditParamsSchema,
  reservationDepositRemainderSchema,
  assignReservationTables as assignEndpoint,
  cancelReservation as cancelEndpoint,
  createReservation as createEndpoint,
  getReservation as getEndpoint,
  getReservationAvailability as availabilityEndpoint,
  listReservations as listEndpoint,
  markReservationNoShow as noShowEndpoint,
  resendReservationDepositLink as resendDepositLinkEndpoint,
  seatReservation as seatEndpoint,
} from "@starter/shared/reservation";
import { HttpError } from "../lib/http-error.ts";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
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
  assignReservationTables,
  createReservation,
  getAvailability,
} from "../services/reservation-booking.ts";
import { resendReservationDepositLink } from "../services/reservation-deposit-resend.ts";
import {
  cancelReservation,
  getReservation,
  listReservations,
  markReservationNoShow,
  seatReservation,
} from "../services/reservation-lifecycle.ts";

import {
  applyReservationCustomerCredit,
  getReservationDepositRemainders,
} from "../services/reservation-deposit-remainder.ts";

export const reservationRouter = Router();

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const view = requireOutletPermission("reservation.view", outletOf);
const manage = requireOutletPermission("reservation.manage", outletOf);
const bookingLimits = createPublicBookingLimits();
// Shared-device cashier PIN: the actor (and audit) is the PIN cashier, not the
// session owner. On every staff route, so a shared tablet can list, read and
// act on reservations; a regular device is unchanged (actorOf = session owner).
// requireAuthAllowSharedDevice lets a shared-tablet session reach the PIN guard
// (plain requireAuth would refuse it before the cashier can identify).
const sharedStaff = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
];

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

// ------------------------------------------------------------- public

const publicContext = (req: Request) =>
  establishScopedTenantContext(getTenantContext(req), { kind: "tenant" });

reservationRouter.get(
  "/public/outlets/:outletId/reservation-availability",
  requireTenantContext,
  async (req, res) => {
    const { outletId } = availabilityEndpoint.params.parse(req.params);
    const query = availabilityEndpoint.query.parse(req.query);
    res.json({
      data: await getAvailability(publicContext(req), outletId, query),
    });
  },
);

reservationRouter.post(
  "/public/outlets/:outletId/reservations",
  requireTenantContext,
  bookingLimits.perRequest,
  jsonBody,
  bookingLimits.perContact,
  async (req, res) => {
    const { outletId } = createEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    const input = createEndpoint.body.parse(body);
    const created = await createReservation(
      publicContext(req),
      outletId,
      input,
      key,
    );
    res.status(201).json({ data: created });
  },
);

// -------------------------------------------------------------- staff

reservationRouter.get(
  "/outlets/:outletId/reservations",
  ...sharedStaff,
  view,
  async (req, res) => {
    const { outletId } = listEndpoint.params.parse(req.params);
    const query = listEndpoint.query.parse(req.query);
    res.json(
      await listReservations(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        query,
      ),
    );
  },
);

reservationRouter.get(
  "/outlets/:outletId/reservations/:reservationId",
  ...sharedStaff,
  view,
  async (req, res) => {
    const { outletId, reservationId } = getEndpoint.params.parse(req.params);
    res.json({
      data: await getReservation(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        reservationId,
      ),
    });
  },
);

reservationRouter.patch(
  "/outlets/:outletId/reservations/:reservationId/tables",
  ...sharedStaff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = assignEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await assignReservationTables(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        reservationId,
        assignEndpoint.body.parse(body),
        key,
      ),
    });
  },
);

reservationRouter.post(
  "/outlets/:outletId/reservations/:reservationId/seat",
  ...sharedStaff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = seatEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await seatReservation(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        reservationId,
        seatEndpoint.body.parse(body),
        key,
      ),
    });
  },
);

reservationRouter.post(
  "/outlets/:outletId/reservations/:reservationId/cancel",
  ...sharedStaff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = cancelEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await cancelReservation(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        reservationId,
        cancelEndpoint.body.parse(body),
        key,
      ),
    });
  },
);

reservationRouter.post(
  "/outlets/:outletId/reservations/:reservationId/deposit-link",
  ...sharedStaff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = resendDepositLinkEndpoint.params.parse(
      req.params,
    );
    const { key, body } = takeIdempotencyKey(req);
    resendDepositLinkEndpoint.body.parse(body);
    res.json({
      data: await resendReservationDepositLink(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        reservationId,
        key,
      ),
    });
  },
);

reservationRouter.post(
  "/outlets/:outletId/reservations/:reservationId/no-show",
  ...sharedStaff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = noShowEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await markReservationNoShow(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        reservationId,
        noShowEndpoint.body.parse(body),
        key,
      ),
    });
  },
);

reservationRouter.post(
  "/outlets/:outletId/reservation-customer-credit/apply",
  ...sharedStaff,
  manage,
  jsonBody,
  async (req, res) => {
    const { outletId } = reservationCreditParamsSchema.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    const input = applyReservationCustomerCreditInputSchema.parse(body);
    res.json({
      data: await applyReservationCustomerCredit(
        getScopedTenantContext(req),
        actorOf(req),
        outletId,
        input,
        key,
      ),
    });
  },
);

reservationRouter.get(
  "/outlets/:outletId/reservations/:reservationId/deposit-remainder",
  ...sharedStaff,
  view,
  async (req, res) => {
    const { outletId, reservationId } = getEndpoint.params.parse(req.params);
    res.json({
      data: reservationDepositRemainderSchema
        .array()
        .parse(
          await getReservationDepositRemainders(
            getScopedTenantContext(req),
            actorOf(req),
            outletId,
            reservationId,
          ),
        ),
    });
  },
);
