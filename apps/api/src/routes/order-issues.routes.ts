// Remake / comp / complaint log routes (bead legend-4b5; PRD v1.7 F41, KDS-07;
// contract @starter/shared/kitchen endpoints.ts `reportOrderIssue` and
// `listOrderIssues`).
//
// Mount (routes/index.ts): `apiRouter.use("/outlets/:outletId",
// orderIssuesRouter)`, so the contract paths
// `/api/outlets/:outletId/orders/:orderId/issues` and
// `/api/outlets/:outletId/order-issues` are served here.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext; the tenant comes
//   from the server-minted context (TEN-02), never the body.
// - requireStationScopePermission admits outlet- and station-scoped grants of
//   `kds.remake_comp.record`; the service re-asserts the station (or the
//   outlet) and narrows a station-only caller to its own stations.
// - Strict contract schemas parse params, query and body.

import { Router } from "express";
import { userIdSchema } from "@starter/shared/core";
import { listOrderIssues, reportOrderIssue } from "@starter/shared/kitchen";
import {
  actorOf,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { requireAuthAllowSharedDevice } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getStationScope,
  requireStationScopePermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as issues from "../services/order-issues.service.ts";

export const orderIssuesRouter = Router({ mergeParams: true });

// The prefix `/outlets/:outletId` is shared with other routers, so the
// middleware is mounted per route: an unrelated path falls through untouched.
const guard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  requireStationScopePermission("kds.remake_comp.record"),
];

orderIssuesRouter.post(
  "/orders/:orderId/issues",
  ...guard,
  jsonBody,
  async (req, res) => {
    const { outletId, orderId } = reportOrderIssue.params.parse(req.params);
    const body = reportOrderIssue.body.parse(req.body);
    res.status(201).json({
      data: await issues.reportOrderIssue(
        getStationScope(req).context,
        userIdSchema.parse(actorOf(req)),
        outletId,
        orderId,
        body,
        new Date(),
      ),
    });
  },
);

orderIssuesRouter.get("/order-issues", ...guard, async (req, res) => {
  const { outletId } = listOrderIssues.params.parse(req.params);
  const query = listOrderIssues.query.parse(req.query);
  res.json(
    await issues.listOrderIssues(
      getStationScope(req).context,
      userIdSchema.parse(actorOf(req)),
      outletId,
      query,
      new Date(),
    ),
  );
});
