// Approval inbox API (bead legend-y5q; PRD v1.7 §3 F7 "Kotak Approval",
// AUTH-06, MCP-04). Paths and schemas are exactly the identity contract:
// listApprovalRequests, createApprovalRequest, getApprovalRequest,
// decideApprovalRequest (@starter/shared/identity/endpoints).
//
// Thin routes: identity, trusted origin, tenant (from the domain/credential,
// TEN-02) and the back-office AUTH-05 gate run first. Permission and outlet
// scope are decided in the service per request row, because one inbox spans
// tenant-wide requests (payroll) and outlet requests (refund) and an outlet
// manager must reach only its own outlets — a tenant-only permission gate
// would lock outlet approvers out, an outlet gate cannot know the row's outlet
// before it is read. Rows outside the caller's reach are invisible to RLS.
//
// Retries: POST bodies may carry an `Idempotency-Key` header, bound to the
// request fingerprint (IDEMPOTENCY_KEY_REUSED for a different body).

import { Router, type Request } from "express";
import { idempotencyKeySchema } from "@starter/shared/core";
import {
  approvalDecisionInputSchema,
  approvalInboxQuerySchema,
  approvalRequestParamsSchema,
  createApprovalRequestSchema,
} from "@starter/shared/identity";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireBackOfficeSurface } from "../middleware/identity-surface";
import { requireTrustedOrigin } from "../middleware/origin";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { sessionMfaVerifiedAt } from "../lib/mfa";
import {
  createApprovalRequestFromInbox,
  decideApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
} from "../services/platform-approval.service";

function idempotencyKeyOf(req: Request): string | null {
  const raw = req.get("Idempotency-Key");
  return raw === undefined ? null : idempotencyKeySchema.parse(raw);
}

export const approvalRouter = Router();

approvalRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

approvalRouter.get("/", async (req, res) => {
  const query = approvalInboxQuerySchema.parse(req.query);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(
    await listApprovalRequests(
      getTenantContext(req),
      getAuth(req).user.id,
      query,
    ),
  );
});

approvalRouter.post("/", jsonBody, async (req, res) => {
  const input = createApprovalRequestSchema.parse(req.body);
  const { request, replayed } = await createApprovalRequestFromInbox(
    getTenantContext(req),
    getAuth(req).user.id,
    input,
    { idempotencyKey: idempotencyKeyOf(req) },
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.status(replayed ? 200 : 201).json({ data: request });
});

approvalRouter.get("/:requestId", async (req, res) => {
  const { requestId } = approvalRequestParamsSchema.parse(req.params);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await getApprovalRequest(
      getTenantContext(req),
      getAuth(req).user.id,
      requestId,
    ),
  });
});

approvalRouter.post("/:requestId/decisions", jsonBody, async (req, res) => {
  const { requestId } = approvalRequestParamsSchema.parse(req.params);
  const input = approvalDecisionInputSchema.parse(req.body);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({
    data: await decideApprovalRequest(
      getTenantContext(req),
      getAuth(req).user.id,
      requestId,
      input,
      {
        mfaVerified: (await sessionMfaVerifiedAt(req)) !== null,
        idempotencyKey: idempotencyKeyOf(req),
      },
    ),
  });
});
