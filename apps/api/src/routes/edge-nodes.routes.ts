// Cloud edge node registry (bead legend-2pi; PRD v1.7 §3 F5 "Server Lokal",
// R10 primary + standby, EDG-03). Mount at /api/edge-nodes on the cloud; the
// edge route guard refuses it on an edge node (cloud only).
//
//   GET  /?outletId=          device.registry.manage on the outlet
//   POST /                    device.registry.manage on body.outletId; 201
//                             with the link credential, shown ONCE; 403
//                             FEATURE_DISABLED unless EDGE_NODES_ENABLED (K0)
//   POST /:edgeNodeId/revoke  device.registry.revoke on body.outletId;
//                             terminal, closes the node's link
//   POST /:edgeNodeId/rotate-credential
//                             device.registry.revoke on the node's own
//                             outlet (resolved from the row, like the device
//                             routes; no body needed); the new credential,
//                             shown ONCE (no-store); the old one works until
//                             the grace period ends
//
// Signed-in, trusted origin, tenant from the domain (TEN-02), back-office
// surface (AUTH-05). Inputs are strict; tenant ids are never accepted.
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { AccessError } from "@starter/shared/access";
import { z } from "zod";
import { CoreError, outletIdSchema, uuidSchema } from "@starter/shared/core";
import { env } from "../config/env.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
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
  findEdgeNodeOutletId,
  listEdgeNodes,
  registerEdgeNode,
  revokeEdgeNode,
  rotateEdgeNodeCredential,
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
/**
 * `outletId` optional (the outlet comes from the node; a given one must
 * match). `graceHours` 0..EDGE_CREDENTIAL_ROTATION_GRACE_HOURS (the service
 * enforces the upper bound); `force` rotates inside an open grace.
 */
export const rotateEdgeNodeCredentialSchema = z.strictObject({
  outletId: outletIdSchema.optional(),
  graceHours: z.number().int().min(0).max(720).optional(),
  force: z.boolean().optional(),
});
const edgeNodeParamsSchema = z.strictObject({ edgeNodeId: uuidSchema });

/** Reads the outlet for the permission check; Zod rejects bad input (422). */
const bodyOutlet = (req: { body?: unknown }) =>
  outletIdSchema.parse(
    (req.body as { outletId?: unknown } | undefined)?.outletId,
  );

/** K0: enrolling is off unless EDGE_NODES_ENABLED (cloud-only release). */
const requireEdgeEnrollEnabled: RequestHandler = (_req, _res, next) => {
  if (!env.EDGE_NODES_ENABLED)
    throw new CoreError(
      "FEATURE_DISABLED",
      "Pendaftaran server outlet belum diaktifkan.",
    );
  next();
};

const notFound = () => new CoreError("NOT_FOUND", "Edge node tidak ditemukan.");
const nodeOutlets = new WeakMap<Request, string>();

/**
 * Permission on the outlet of the edge node named in the path (same pattern
 * as routes/device.routes.ts). Everything that is not "you may act on this
 * node" is the same 404.
 */
function requireEdgeNodePermission(
  permission: "device.registry.revoke",
): RequestHandler {
  const check = requireOutletPermission(permission, (req) => {
    const outletId = nodeOutlets.get(req);
    if (!outletId) throw notFound();
    return outletId;
  });
  return async (req: Request, res: Response, next: NextFunction) => {
    const { edgeNodeId } = edgeNodeParamsSchema.parse(req.params);
    const outletId = await findEdgeNodeOutletId(
      getTenantContext(req),
      edgeNodeId,
    );
    if (!outletId) throw notFound();
    nodeOutlets.set(req, outletId);
    try {
      await check(req, res, () => undefined);
    } catch (error) {
      if (error instanceof AccessError && error.code === "PERMISSION_DENIED")
        throw notFound();
      throw error;
    }
    next();
  };
}

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
  requireEdgeEnrollEnabled,
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

edgeNodesRouter.post(
  "/:edgeNodeId/rotate-credential",
  jsonBody,
  requireEdgeNodePermission("device.registry.revoke"),
  async (req, res) => {
    const { edgeNodeId } = edgeNodeParamsSchema.parse(req.params);
    const input = rotateEdgeNodeCredentialSchema.parse(req.body ?? {});
    if (input.outletId && input.outletId !== nodeOutlets.get(req))
      throw notFound();
    const result = await rotateEdgeNodeCredential(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      edgeNodeId,
      new Date(),
      { graceHours: input.graceHours, force: input.force },
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ data: result });
  },
);
