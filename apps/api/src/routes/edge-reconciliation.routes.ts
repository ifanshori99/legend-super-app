// Edge up-sync reconciliation (bead legend-kai). Cloud only: mounted at
// /api/edge-nodes next to the node registry.
//
//   POST /:edgeNodeId/reconciliation   body = edge digest; compares it with
//                                      what the cloud received and appends
//                                      one run row (report only, 200)
//   GET  /:edgeNodeId/reconciliation?limit=   past runs, newest first
//
// POST also accepts the node's Bearer credential for the periodic edge job;
// its tenant, outlet and node come only from that credential. Operators need
// `device.registry.manage` on the node's own outlet (read from the node row,
// never from the client); unknown, foreign or out-of-reach nodes are the same
// 404, like the other /edge-nodes/:id routes. Operator requests require a
// session, trusted origin, domain tenant (TEN-02), and back-office surface
// (AUTH-05). GET remains operator-only.
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { AccessError } from "@starter/shared/access";
import { CoreError } from "@starter/shared/core";
import {
  edgeReconciliationListQuerySchema,
  edgeReconciliationParamsSchema,
} from "@starter/shared/edge/reconciliation";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  findTenantContext,
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  authenticateEdgeCredential,
  findEdgeNodeOutletId,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  listEdgeReconciliationRuns,
  parseEdgeTxnDigest,
  reconcileEdgeTransactions,
} from "../services/edge-reconciliation.service.ts";
import { edgeCredentialFromAuthorization } from "../services/staff-pin-sync.ts";

const notFound = () => new CoreError("NOT_FOUND", "Edge node tidak ditemukan.");
const nodeOutlets = new WeakMap<Request, string>();

/** Permission on the outlet of the node in the path (as edge-nodes.routes.ts). */
const requireNodeManage: RequestHandler = (() => {
  const check = requireOutletPermission("device.registry.manage", (req) => {
    const outletId = nodeOutlets.get(req);
    if (!outletId) throw notFound();
    return outletId;
  });
  return async (req: Request, res: Response, next: NextFunction) => {
    const { edgeNodeId } = edgeReconciliationParamsSchema.parse(req.params);
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
})();

export const edgeReconciliationRouter = Router();

const edgeCallers = new WeakMap<Request, AuthenticatedEdgeNode>();

// Credential authentication runs before parsing the digest. A presented
// invalid credential never falls back to an operator's session cookie.
edgeReconciliationRouter.post(
  "/:edgeNodeId/reconciliation",
  async (req, _res, next) => {
    const authorization = req.get("Authorization");
    if (authorization === undefined) {
      next("route");
      return;
    }
    const credential = edgeCredentialFromAuthorization(authorization);
    const node =
      credential === null ? null : await authenticateEdgeCredential(credential);
    if (node === null)
      throw new CoreError("UNAUTHORIZED", "Kredensial edge node tidak valid.");
    const resolved = findTenantContext(req);
    if (
      resolved !== undefined &&
      resolved.tenantId.toLowerCase() !== node.scope.tenantId.toLowerCase()
    )
      throw new HttpError(
        403,
        "TENANT_MISMATCH",
        "Tenant does not match this domain.",
      );
    const { edgeNodeId } = edgeReconciliationParamsSchema.parse(req.params);
    if (edgeNodeId !== node.scope.edgeNodeId) throw notFound();
    edgeCallers.set(req, node);
    next();
  },
  jsonBody,
  async (req, res) => {
    const node = edgeCallers.get(req);
    if (!node)
      throw new CoreError("UNAUTHORIZED", "Kredensial edge node tidak valid.");
    const digest = parseEdgeTxnDigest(req.body);
    if (digest.edgeNodeId !== node.scope.edgeNodeId)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Digest bukan milik edge node ini.",
      );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await reconcileEdgeTransactions(db, node.context, {
        edgeNodeId: node.scope.edgeNodeId,
        digest,
      }),
    });
  },
);

edgeReconciliationRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireBackOfficeSurface(),
);

edgeReconciliationRouter.post(
  "/:edgeNodeId/reconciliation",
  jsonBody,
  requireNodeManage,
  async (req, res) => {
    const { edgeNodeId } = edgeReconciliationParamsSchema.parse(req.params);
    const digest = parseEdgeTxnDigest(req.body);
    if (digest.edgeNodeId !== edgeNodeId)
      throw new CoreError(
        "VALIDATION_ERROR",
        "Digest bukan milik edge node ini.",
      );
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await reconcileEdgeTransactions(db, getScopedTenantContext(req), {
        edgeNodeId,
        digest,
        checkedBy: getAuth(req).user.id,
      }),
    });
  },
);

edgeReconciliationRouter.get(
  "/:edgeNodeId/reconciliation",
  requireNodeManage,
  async (req, res) => {
    const { edgeNodeId } = edgeReconciliationParamsSchema.parse(req.params);
    const { limit } = edgeReconciliationListQuerySchema.parse(req.query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await listEdgeReconciliationRuns(db, getScopedTenantContext(req), {
        edgeNodeId,
        limit,
      }),
    });
  },
);
