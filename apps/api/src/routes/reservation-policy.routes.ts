// Reservation policy admin routes (PRD v1.7 §3.22 "DP & Kebijakan"; bead
// legend-u0q8). Contract: `getReservationPolicy` / `putReservationPolicy` in
// `@starter/shared/reservation`. Mount at the API root; paths are absolute.
//
// requireAuth + requireTrustedOrigin + requireTenantContext, then the outlet
// permission of the path's outlet (TEN-03): `reservation.view` to read,
// `reservation.manage` to save. The service re-checks both inside the tenant
// transaction.
import { Router, type Request } from "express";
import {
  getReservationPolicy as getEndpoint,
  putReservationPolicy as putEndpoint,
} from "@starter/shared/reservation";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getReservationPolicyOverview,
  putReservationPolicy,
} from "../services/reservation-policy.service.ts";

export const reservationPolicyRouter = Router();

const outletOf = (req: Request) => String(req.params.outletId ?? "");
const view = requireOutletPermission("reservation.view", outletOf);
const manage = requireOutletPermission("reservation.manage", outletOf);
const staff = [requireAuth, requireTrustedOrigin, requireTenantContext];

reservationPolicyRouter.get(
  "/outlets/:outletId/reservation-policy",
  ...staff,
  view,
  async (req, res) => {
    const { outletId } = getEndpoint.params.parse(req.params);
    res.json({
      data: await getReservationPolicyOverview(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
      ),
    });
  },
);

reservationPolicyRouter.put(
  "/outlets/:outletId/reservation-policy",
  ...staff,
  jsonBody,
  manage,
  async (req, res) => {
    const { outletId } = putEndpoint.params.parse(req.params);
    res.json({
      data: await putReservationPolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        outletId,
        putEndpoint.body.parse(req.body),
      ),
    });
  },
);
