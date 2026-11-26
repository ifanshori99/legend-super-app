// Edge -> cloud failover windows (1271 F3; services/edge-failover.service.ts).
// Mount at /api/edge-failover on the cloud (the edge route guard answers
// CLOUD_ONLY_ROUTE on an edge node: the window is opened where the edge is not).
//
//   GET  /windows?outletId=            the outlet's latest window or null
//   POST /windows                      open a window; 201 (200 on a replay)
//   GET  /windows/:windowId            one window (finishes an acked return)
//   POST /windows/:windowId/cancel     cancel (no failover order or shift yet)
//   POST /windows/:windowId/return     start (or retry) the return to the edge
//
// Signed-in, trusted origin, tenant from the domain (TEN-02). Every route
// needs `pos.failover.manage` on the outlet (for a window: the outlet of the
// row, read on the server; anything else is the same 404). The service checks
// the permission again inside its transaction.
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { AccessError } from "@starter/shared/access";
import { CoreError, outletIdSchema, uuidSchema, z } from "@starter/shared/core";
import {
  activateFailoverWindowInputSchema,
  cancelFailoverWindowInputSchema,
  startFailoverReturnInputSchema,
} from "@starter/shared/edge";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
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
  activateFailoverWindow,
  cancelFailoverWindow,
  failoverWindowOutletId,
  getFailoverWindow,
  latestFailoverWindow,
  startFailoverReturn,
} from "../services/edge-failover.service.ts";

const PERMISSION = "pos.failover.manage";
const outletQuerySchema = z.strictObject({ outletId: outletIdSchema });
const windowParamsSchema = z.strictObject({ windowId: uuidSchema });
const notFound = () =>
  new CoreError("NOT_FOUND", "Jendela mode cloud tidak ditemukan.");
const windowOutlets = new WeakMap<Request, string>();

/** Permission on the outlet of the window named in the path; else 404. */
function requireWindowPermission(): RequestHandler {
  const check = requireOutletPermission(PERMISSION, (req) => {
    const outletId = windowOutlets.get(req);
    if (!outletId) throw notFound();
    return outletId;
  });
  return async (req: Request, res: Response, next: NextFunction) => {
    const { windowId } = windowParamsSchema.parse(req.params);
    const outletId = await failoverWindowOutletId(
      getTenantContext(req).tenantId,
      windowId,
    );
    if (!outletId) throw notFound();
    windowOutlets.set(req, outletId);
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

const caller = (req: Request) => ({ userId: getAuth(req).user.id });

export const edgeFailoverRouter = Router();

edgeFailoverRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

edgeFailoverRouter.get(
  "/windows",
  requireOutletPermission(
    PERMISSION,
    (req) => outletQuerySchema.parse(req.query).outletId,
  ),
  async (req, res) => {
    const { outletId } = outletQuerySchema.parse(req.query);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await latestFailoverWindow(
        getScopedTenantContext(req),
        caller(req),
        outletId,
      ),
    });
  },
);

edgeFailoverRouter.post(
  "/windows",
  jsonBody,
  requireOutletPermission(PERMISSION, (req) =>
    outletIdSchema.parse(
      (req.body as { outletId?: unknown } | undefined)?.outletId,
    ),
  ),
  async (req, res) => {
    const input = activateFailoverWindowInputSchema.parse(req.body);
    const { window, replayed } = await activateFailoverWindow(
      getScopedTenantContext(req),
      caller(req),
      input,
    );
    res
      .status(replayed ? 200 : 201)
      .location(`/api/edge-failover/windows/${encodeURIComponent(window.id)}`)
      .json({ data: window });
  },
);

edgeFailoverRouter.get(
  "/windows/:windowId",
  requireWindowPermission(),
  async (req, res) => {
    const { windowId } = windowParamsSchema.parse(req.params);
    res.setHeader("Cache-Control", "private, no-store");
    res.json({
      data: await getFailoverWindow(
        getScopedTenantContext(req),
        caller(req),
        windowId,
      ),
    });
  },
);

edgeFailoverRouter.post(
  "/windows/:windowId/cancel",
  jsonBody,
  requireWindowPermission(),
  async (req, res) => {
    const { windowId } = windowParamsSchema.parse(req.params);
    const input = cancelFailoverWindowInputSchema.parse(req.body);
    res.json({
      data: await cancelFailoverWindow(
        getScopedTenantContext(req),
        caller(req),
        windowId,
        input,
      ),
    });
  },
);

edgeFailoverRouter.post(
  "/windows/:windowId/return",
  jsonBody,
  requireWindowPermission(),
  async (req, res) => {
    const { windowId } = windowParamsSchema.parse(req.params);
    const input = startFailoverReturnInputSchema.parse(req.body);
    res.json({
      data: await startFailoverReturn(
        getScopedTenantContext(req),
        caller(req),
        windowId,
        input,
      ),
    });
  },
);
