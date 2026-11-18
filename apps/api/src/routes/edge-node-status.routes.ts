// Back-office "Status edge" list (beads legend-ph62j, legend-eo3lc; design
// docs/design/edge-status-cloud.md section 3). Cloud only: mount at
// /api/edge-node-status.
//
//   GET /?outletId=   active edge nodes with link state and open alerts
//
// Needs `report.operational.view`: on ?outletId= that outlet, otherwise the
// outlets the caller's grant reaches (tenant-wide or the union of their
// outlets). Signed-in, trusted origin, tenant from the domain (TEN-02),
// back-office surface (AUTH-05).
import { Router } from "express";
import { edgeNodeStatusQuerySchema } from "@starter/shared/edge/node-status";
import { requireAuth } from "../middleware/auth.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { listEdgeNodeStatus } from "../services/edge-node-status.service.ts";

export const edgeNodeStatusRouter = Router();

edgeNodeStatusRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

const viewListedOutlet = requireOutletPermission(
  "report.operational.view",
  (req) => String(req.query.outletId ?? ""),
);
const viewReachableOutlets = requireMenuPermission("report.operational.view");

edgeNodeStatusRouter.get(
  "/",
  (req, res, next) =>
    (req.query.outletId === undefined
      ? viewReachableOutlets
      : viewListedOutlet)(req, res, next),
  async (req, res) => {
    const query = edgeNodeStatusQuerySchema.parse(req.query);
    res.json(await listEdgeNodeStatus(getScopedTenantContext(req), query));
  },
);
