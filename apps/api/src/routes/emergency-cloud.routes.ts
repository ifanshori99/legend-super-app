// Emergency button, cloud manager routes (bead legend-bod.5; design
// docs/design/edge-emergency.md D-07, D-11). Mount (routes/index.ts):
// `apiRouter.use("/outlets/:outletId/emergency-alerts", emergencyCloudRouter)`;
// the router merges params. The outlet comes from the path, never the body.
//
//   GET  /api/outlets/:outletId/emergency-alerts?limit=       facility.emergency.respond
//   POST /api/outlets/:outletId/emergency-alerts/:alertId/ack      facility.emergency.respond
//   POST /api/outlets/:outletId/emergency-alerts/:alertId/resolve  facility.emergency.resolve
//        body { note }
//
// Cloud only: the edge allowlist (edge/mode.ts) refuses all of them with 404
// CLOUD_ONLY_ROUTE. Staff session + trusted origin + tenant, like the other
// outlet routers; the permission must reach the path's outlet (403 otherwise).
import { Router } from "express";
import { outletIdSchema, z } from "@starter/shared/core";
import {
  panicAckBodySchema,
  panicAlertIdSchema,
  panicResolveBodySchema,
} from "@starter/shared/facility";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as alerts from "../services/panic-alert-cloud.service.ts";
import { refuseWhenEdgeServesOutlet } from "../services/panic-edge-ownership.ts";

export const emergencyCloudRouter = Router({ mergeParams: true });

emergencyCloudRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

const MAX_LIST = 100;
const outletParams = z.strictObject({ outletId: outletIdSchema });
const alertParams = z.strictObject({
  outletId: outletIdSchema,
  alertId: panicAlertIdSchema,
});
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_LIST).default(50),
});

const pathOutlet = (req: { params: Record<string, unknown> }) =>
  String(req.params.outletId ?? "");
const respond = requireOutletPermission(
  "facility.emergency.respond",
  pathOutlet,
);
const resolve = requireOutletPermission(
  "facility.emergency.resolve",
  pathOutlet,
);

emergencyCloudRouter.get("/", respond, async (req, res) => {
  const { outletId } = outletParams.parse(req.params);
  const { limit } = listQuery.parse(req.query);
  res.json({
    data: await alerts.listEmergencyAlerts(
      getScopedTenantContext(req),
      outletId,
      limit,
    ),
  });
});

emergencyCloudRouter.post(
  "/:alertId/ack",
  respond,
  jsonBody,
  async (req, res) => {
    const { outletId, alertId } = alertParams.parse(req.params);
    panicAckBodySchema.parse(req.body);
    // An outlet with an active edge node is acknowledged on the edge; the
    // cloud ack would not reach its sockets. Resolve stays allowed (D-11).
    await refuseWhenEdgeServesOutlet(
      getScopedTenantContext(req).tenant,
      outletId,
    );
    res.json({
      data: await alerts.acknowledgeEmergencyAlert(
        getScopedTenantContext(req),
        outletId,
        alertId,
        getAuth(req).user.id,
      ),
    });
  },
);

emergencyCloudRouter.post(
  "/:alertId/resolve",
  resolve,
  jsonBody,
  async (req, res) => {
    const { outletId, alertId } = alertParams.parse(req.params);
    const { note } = panicResolveBodySchema.parse(req.body);
    res.json({
      data: await alerts.resolveEmergencyAlert(
        getScopedTenantContext(req),
        outletId,
        alertId,
        getAuth(req).user.id,
        note,
      ),
    });
  },
);
