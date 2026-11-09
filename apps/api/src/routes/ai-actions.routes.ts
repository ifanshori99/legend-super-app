// AI action request routes (PRD v1.7 §3 Fitur 38/39, AIG-03; bead legend-zw9r,
// part W). Contract: `@starter/shared/ai` endpoints.ts (listMyActionRequests,
// getActionRequest). Mounted at `/api/ai`; each path drops that prefix. Every
// route needs `ai.ask`. The list is the caller's own requests; the detail also
// answers an approval-inbox viewer whose reach covers the request (the service
// decides). Another user's request is a 404, never a 403.
import { Router } from "express";
import {
  getActionRequestByApproval as getActionRequestByApprovalEndpoint,
  getActionRequest as getActionRequestEndpoint,
  listMyActionRequests as listMyActionRequestsEndpoint,
} from "@starter/shared/ai";
import { requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getAccessSnapshot,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  getActionRequestReview,
  getActionRequestView,
  listMyActionRequests,
} from "../services/ai-action-request.service.ts";

export function createAiActionsRouter(): Router {
  const router = Router();
  const gate = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    requireMenuPermission("ai.ask"),
  ];

  router.get("/action-requests", ...gate, async (req, res) => {
    const query = listMyActionRequestsEndpoint.query.parse(req.query);
    const page = await listMyActionRequests(getAccessSnapshot(req), query);
    res.json(listMyActionRequestsEndpoint.response.parse(page));
  });

  // Registered before `/:actionRequestId` so "by-approval" is never an id.
  router.get(
    "/action-requests/by-approval/:approvalRequestId",
    ...gate,
    async (req, res) => {
      const params = getActionRequestByApprovalEndpoint.params.parse(
        req.params,
      );
      res.json({
        data: await getActionRequestReview(
          getAccessSnapshot(req),
          params.approvalRequestId,
        ),
      });
    },
  );

  router.get("/action-requests/:actionRequestId", ...gate, async (req, res) => {
    const params = getActionRequestEndpoint.params.parse(req.params);
    res.json({
      data: await getActionRequestView(
        getAccessSnapshot(req),
        params.actionRequestId,
      ),
    });
  });

  return router;
}

export const aiActionsRouter = createAiActionsRouter();
