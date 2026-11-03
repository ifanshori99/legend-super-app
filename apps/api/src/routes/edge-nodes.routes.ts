// Cloud edge node registry (bead legend-2pi; PRD v1.7 §3 F5 "Server Lokal",
// R10 primary + standby, EDG-03). Mount at /api/edge-nodes on the cloud; the
// edge route guard refuses it on an edge node (cloud only).
//
//   GET  /?outletId=          device.registry.manage on the outlet
//   POST /                    device.registry.manage on body.outletId; 201
//                             with the link credential, shown ONCE
//   POST /:edgeNodeId/revoke  device.registry.revoke on body.outletId;
//                             terminal, closes the node's link
//
// Signed-in, trusted origin, tenant from the domain (TEN-02), back-office
// surface (AUTH-05). Inputs are strict; tenant ids are never accepted.
import { Router } from "express";
import { z } from "zod";
import { outletIdSchema, uuidSchema } from "@starter/shared/core";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  listEdgeNodes,
  registerEdgeNode,
  revokeEdgeNode,
} from "../services/edge-node.service.ts";

export const listEdgeNodesQuerySchema = z.strictObject({
  outletId: outletIdSchema,
});
export const registerEdgeNodeSchema = z.strictObject({
  outletId: outletIdSchema,
  role: z.enum(["primary", "standby"]),
  label: z.string().trim().min(1).max(255),
});
export const revokeEdgeNodeSchema = z.strictObject({
  outletId: outletIdSchema,
  reason: z.string().trim().min(1).max(500),
});
const edgeNodeParamsSchema = z.strictObject({ edgeNodeId: uuidSchema });

/** Reads the outlet for the permission check; Zod rejects bad input (422). */
const bodyOutlet = (req: { body?: unknown }) =>
  outletIdSchema.parse(
    (req.body as { outletId?: unknown } | undefined)?.outletId,
  );

export const edgeNodesRouter = Router();

edgeNodesRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

edgeNodesRouter.get(
  "/",
  requireOutletPermission(
    "device.registry.manage",
    (req) => listEdgeNodesQuerySchema.parse(req.query).outletId,
  ),
  async (req, res) => {
    const { outletId } = listEdgeNodesQuerySchema.parse(req.query);
    res.json({
      data: await listEdgeNodes(getScopedTenantContext(req), { outletId }),
    });
  },
);

edgeNodesRouter.post(
  "/",
  jsonBody,
  requireOutletPermission("device.registry.manage", bodyOutlet),
  async (req, res) => {
    const input = registerEdgeNodeSchema.parse(req.body);
    const result = await registerEdgeNode(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      input,
    );
    res.setHeader("Cache-Control", "private, no-store");
    res
      .status(201)
      .location(`/api/edge-nodes/${encodeURIComponent(result.edgeNode.id)}`)
      .json({ data: result });
  },
);

edgeNodesRouter.post(
  "/:edgeNodeId/revoke",
  jsonBody,
  requireOutletPermission("device.registry.revoke", bodyOutlet),
  async (req, res) => {
    const { edgeNodeId } = edgeNodeParamsSchema.parse(req.params);
    const input = revokeEdgeNodeSchema.parse(req.body);
    res.json({
      data: await revokeEdgeNode(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { edgeNodeId, reason: input.reason },
      ),
    });
  },
);
