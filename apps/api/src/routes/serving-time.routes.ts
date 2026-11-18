// Serving-time estimate route (bead legend-gyc; contract @starter/shared/kitchen
// endpoints.ts: estimateServingTime; PRD v1.7 §3 F12, KDS-05).
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId", servingTimeRouter)`.
// The prefix is shared with other outlet routers, so the auth middleware is
// attached per route, never with `router.use`.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext, then
//   `order.view` on the path outlet: the estimate is read by the POS and order
//   screens, which all hold it; it exposes no kitchen configuration.
// - Params and query are parsed with the strict contract schemas; the tenant
//   comes from the server-minted context, never the request.

import { Router } from "express";
import { estimateServingTime } from "@starter/shared/kitchen";
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
import * as estimate from "../services/kds-estimate.service.ts";

export const servingTimeRouter = Router({ mergeParams: true });

const guard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  requireOutletPermission("order.view", (req) => String(req.params.outletId)),
];

servingTimeRouter.get("/serving-time-estimate", ...guard, async (req, res) => {
  const { outletId } = estimateServingTime.params.parse(req.params);
  const query = estimateServingTime.query.parse(req.query);
  res.json({
    data: await estimate.estimateServingTime(
      getScopedTenantContext(req),
      outletId,
      query,
      new Date(),
    ),
  });
});
