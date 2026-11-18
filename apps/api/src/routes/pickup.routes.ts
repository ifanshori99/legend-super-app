// Pickup display routes (bead legend-mzhr0; contract @starter/shared/kitchen
// endpoints.ts: getPickupDisplay, callPickupNumber, markPickupPickedUp).
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId", pickupRouter)`.
// The prefix is shared with other outlet routers, so the auth middleware is
// attached per route, never with `router.use`, or it would run for every
// unmatched path under /outlets/:outletId.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext, then
//   `kds.expo.operate` on the path outlet (the same grant as expo).
// - Params are parsed with the strict contract schemas; the tenant comes from
//   the server-minted context, never the request.

import { Router } from "express";
import {
  callPickupNumber,
  getPickupDisplay,
  markPickupPickedUp,
} from "@starter/shared/kitchen";
import {
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as pickup from "../services/pickup.service.ts";

export const pickupRouter = Router({ mergeParams: true });

const guard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  requireOutletPermission("kds.expo.operate", (req) =>
    String(req.params.outletId),
  ),
];

pickupRouter.get("/pickup-display", ...guard, async (req, res) => {
  const { outletId } = getPickupDisplay.params.parse(req.params);
  res.json({
    data: await pickup.readPickupDisplay(
      getScopedTenantContext(req),
      outletId,
      new Date(),
    ),
  });
});

pickupRouter.post("/pickup-calls/:callId/call", ...guard, async (req, res) => {
  const { outletId, callId } = callPickupNumber.params.parse(req.params);
  res.json({
    data: await pickup.applyPickupAction(
      getScopedTenantContext(req),
      outletId,
      callId,
      "call",
      new Date(),
    ),
  });
});

pickupRouter.post(
  "/pickup-calls/:callId/picked-up",
  ...guard,
  async (req, res) => {
    const { outletId, callId } = markPickupPickedUp.params.parse(req.params);
    res.json({
      data: await pickup.applyPickupAction(
        getScopedTenantContext(req),
        outletId,
        callId,
        "pickup",
        new Date(),
      ),
    });
  },
);
