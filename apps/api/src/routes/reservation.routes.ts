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
// - Staff: requireAuth + requireTrustedOrigin + requireTenantContext, then
//   `reservation.view` / `reservation.manage` on the path's outlet (TEN-03).
// - Every mutation needs an idempotency key: `Idempotency-Key` header (or an
//   `idempotencyKey` body field, stripped before the strict contract parse).
//
// Waitlist, pre-order and package endpoints belong to legend-y9o7.
import { Router, type Request } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { idempotencyKeySchema } from "@starter/shared/core";
import {
  assignReservationTables as assignEndpoint,
  cancelReservation as cancelEndpoint,
  createReservation as createEndpoint,
  getReservation as getEndpoint,
  getReservationAvailability as availabilityEndpoint,
  listReservations as listEndpoint,
  markReservationNoShow as noShowEndpoint,
  seatReservation as seatEndpoint,
} from "@starter/shared/reservation";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  assignReservationTables,
  createReservation,
  getAvailability,
} from "../services/reservation-booking.ts";
import {
  cancelReservation,
  getReservation,
  listReservations,
  markReservationNoShow,
  seatReservation,
} from "../services/reservation-lifecycle.ts";

export const reservationRouter = Router();

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const view = requireOutletPermission("reservation.view", outletOf);
const manage = requireOutletPermission("reservation.manage", outletOf);
const staff = [requireAuth, requireTrustedOrigin, requireTenantContext];

/** Header first, then a body field; the body field never reaches the contract. */
function takeIdempotencyKey(req: Request): {
  key: string;
  body: Record<string, unknown>;
} {
  const raw =
    typeof req.body === "object" && req.body !== null
      ? { ...(req.body as Record<string, unknown>) }
      : {};
  const fromBody = raw.idempotencyKey;
  delete raw.idempotencyKey;
  const candidate = req.header("idempotency-key") ?? fromBody;
  const parsed = idempotencyKeySchema.safeParse(candidate);
  if (!parsed.success)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Idempotency-Key wajib diisi (8-100 karakter).",
    );
  return { key: parsed.data, body: raw };
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
  jsonBody,
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
  ...staff,
  view,
  async (req, res) => {
    const { outletId } = listEndpoint.params.parse(req.params);
    const query = listEndpoint.query.parse(req.query);
    res.json(
      await listReservations(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        query,
      ),
    );
  },
);

reservationRouter.get(
  "/outlets/:outletId/reservations/:reservationId",
  ...staff,
  view,
  async (req, res) => {
    const { outletId, reservationId } = getEndpoint.params.parse(req.params);
    res.json({
      data: await getReservation(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        reservationId,
      ),
    });
  },
);

reservationRouter.patch(
  "/outlets/:outletId/reservations/:reservationId/tables",
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = assignEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await assignReservationTables(
        getScopedTenantContext(req),
        getAuth(req).user.id,
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
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = seatEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await seatReservation(
        getScopedTenantContext(req),
        getAuth(req).user.id,
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
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = cancelEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await cancelReservation(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        reservationId,
        cancelEndpoint.body.parse(body),
        key,
      ),
    });
  },
);

reservationRouter.post(
  "/outlets/:outletId/reservations/:reservationId/no-show",
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId, reservationId } = noShowEndpoint.params.parse(req.params);
    const { key, body } = takeIdempotencyKey(req);
    res.json({
      data: await markReservationNoShow(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        reservationId,
        noShowEndpoint.body.parse(body),
        key,
      ),
    });
  },
);
