// Purchase request and purchase order routes (PRD v1.7 §3.18, §4 Alur I; bead
// legend-9yz slice D). Mount at `/api/inventory` (the engineer wires it in
// routes/index.ts). Paths and bodies come from `@starter/shared/inventory`
// (`createPurchaseRequest`, `postPurchaseOrderTransition`, ...).
//
// The tenant comes from the server-minted context (TEN-02). Outlet reads take
// `outletId` from the query and creates from the body; the role must cover it
// (TEN-03). Id-only routes mint the caller's reachable scope for the action's
// permission; the service re-checks the permission against the document's own
// outlet and RLS hides other outlets (404). Reads accept any purchasing
// permission; writes need the action's permission (fail closed).

import {
  createPurchaseOrderInputSchema,
  createPurchaseRequestInputSchema,
  purchaseOrderIdSchema,
  purchaseOrderQuerySchema,
  purchaseRequestIdSchema,
  purchaseRequestQuerySchema,
  transitionPurchaseOrderInputSchema,
  transitionPurchaseRequestInputSchema,
  updatePurchaseOrderInputSchema,
} from "@starter/shared/inventory";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  purchaseOrderActionPermission,
  transitionPurchaseOrderStatus,
  updatePurchaseOrder,
} from "../services/purchasing-order.service.ts";
import { PURCHASING_READ_PERMISSIONS } from "../services/purchasing-flow.shared.ts";
import { getPurchaseOrderPdfPreview } from "../services/purchasing-send.service.ts";
import {
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  purchaseRequestActionPermission,
  transitionPurchaseRequestStatus,
} from "../services/purchasing-request.service.ts";

const queryOutlet = (req: Request) => String(req.query.outletId);
/** Create routes: the outlet comes from the (already parsed) JSON body. */
const bodyOutlet = (req: Request) =>
  String((req.body as { outletId?: unknown } | undefined)?.outletId);

/**
 * Runs `gate` and reports whether it let the request through; a permission
 * denial is `false`, any other failure (bad outlet id, ...) propagates.
 */
async function passes(
  gate: RequestHandler,
  req: Request,
  res: Response,
): Promise<boolean> {
  let allowed = false;
  try {
    await gate(req, res, () => {
      allowed = true;
    });
  } catch (error) {
    if (!(error instanceof AccessError) || error.code !== "PERMISSION_DENIED")
      throw error;
  }
  return allowed;
}

/** Allows a caller holding any of `gates`; denies by default. */
function anyOf(gates: readonly RequestHandler[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    for (const gate of gates) if (await passes(gate, req, res)) return next();
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot view purchasing in this outlet.",
    );
  };
}

/**
 * Id-only reads: the caller may hold different purchasing permissions at
 * different outlets, so every permission is tried and the reach of all that
 * pass is merged (tenant-wide if any is). No permission passing is a denial.
 * The merged context is kept in `res.locals`; the service still re-checks a
 * purchasing permission at the document's own outlet.
 */
function readScopeByPermissions(
  permissions: readonly PermissionCode[],
): RequestHandler {
  const gates = permissions.map((permission) =>
    requireMenuPermission(permission),
  );
  return async (req: Request, res: Response, next: NextFunction) => {
    const reaches: ScopedTenantContext[] = [];
    for (const gate of gates)
      if (await passes(gate, req, res))
        reaches.push(getScopedTenantContext(req));
    if (reaches.length === 0)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot view purchasing in this tenant.",
      );
    const outletIds = new Set<string>();
    let tenantWide = false;
    for (const reach of reaches) {
      if (reach.outletScope.kind === "tenant") tenantWide = true;
      else for (const id of reach.outletScope.outletIds) outletIds.add(id);
    }
    res.locals.purchasingReadContext = establishScopedTenantContext(
      getTenantContext(req),
      tenantWide
        ? { kind: "tenant" }
        : {
            kind: "outlets",
            outletIds: [...outletIds].map((id) => outletIdSchema.parse(id)),
          },
    );
    next();
  };
}

const readContext = (res: Response) =>
  res.locals.purchasingReadContext as ScopedTenantContext;

/**
 * Picks the gate from the already parsed JSON body. One permission uses the
 * plain menu gate. Several (close / cancel: the creator's create permission or
 * an approver's `purchasing.order.approve`) merge the reach of every one that
 * passes into `res.locals.purchasingReadContext`; the service stays
 * authoritative (creator or approver at the document's outlet).
 */
function menuGateFor(
  permissionsOf: (body: unknown) => readonly PermissionCode[],
): RequestHandler {
  return (req, res, next) => {
    const permissions = permissionsOf(req.body);
    if (permissions.length === 1)
      return requireMenuPermission(permissions[0]!)(req, res, next);
    return readScopeByPermissions(permissions)(req, res, next);
  };
}

/** Context of a transition: merged reach when several permissions were tried. */
const transitionContext = (req: Request, res: Response): ScopedTenantContext =>
  (res.locals.purchasingReadContext as ScopedTenantContext | undefined) ??
  getScopedTenantContext(req);

export function createPurchasingOrderRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const readOutlet = anyOf(
    PURCHASING_READ_PERMISSIONS.map((permission) =>
      requireOutletPermission(permission, queryOutlet),
    ),
  );
  const readById = readScopeByPermissions(PURCHASING_READ_PERMISSIONS);

  // ------------------------------------------------------ purchase requests

  router.get("/purchase-requests", readOutlet, async (req, res) => {
    const query = purchaseRequestQuerySchema.parse(req.query);
    res.json(
      await listPurchaseRequests(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/purchase-requests",
    jsonBody,
    requireOutletPermission("purchasing.request.create", bodyOutlet),
    async (req, res) => {
      const input = createPurchaseRequestInputSchema.parse(req.body);
      const detail = await createPurchaseRequest(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: detail });
    },
  );

  router.get(
    "/purchase-requests/:purchaseRequestId",
    readById,
    async (req, res) => {
      const id = purchaseRequestIdSchema.parse(req.params.purchaseRequestId);
      res.json({
        data: await getPurchaseRequest(
          readContext(res),
          getAuth(req).user.id,
          id,
        ),
      });
    },
  );

  router.post(
    "/purchase-requests/:purchaseRequestId/transitions",
    jsonBody,
    menuGateFor((body) => {
      const { action } = transitionPurchaseRequestInputSchema.parse(body);
      return action === "cancel"
        ? [purchaseRequestActionPermission(action), "purchasing.order.approve"]
        : [purchaseRequestActionPermission(action)];
    }),
    async (req, res) => {
      const id = purchaseRequestIdSchema.parse(req.params.purchaseRequestId);
      const input = transitionPurchaseRequestInputSchema.parse(req.body);
      res.json({
        data: await transitionPurchaseRequestStatus(
          transitionContext(req, res),
          getAuth(req).user.id,
          id,
          input,
        ),
      });
    },
  );

  // -------------------------------------------------------- purchase orders

  router.get("/purchase-orders", readOutlet, async (req, res) => {
    const query = purchaseOrderQuerySchema.parse(req.query);
    res.json(
      await listPurchaseOrders(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/purchase-orders",
    jsonBody,
    requireOutletPermission("purchasing.order.create", bodyOutlet),
    async (req, res) => {
      const input = createPurchaseOrderInputSchema.parse(req.body);
      const detail = await createPurchaseOrder(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: detail });
    },
  );

  router.get(
    "/purchase-orders/:purchaseOrderId",
    readById,
    async (req, res) => {
      const id = purchaseOrderIdSchema.parse(req.params.purchaseOrderId);
      res.json({
        data: await getPurchaseOrder(
          readContext(res),
          getAuth(req).user.id,
          id,
        ),
      });
    },
  );

  router.get(
    "/purchase-orders/:purchaseOrderId/preview.pdf",
    readById,
    async (req, res) => {
      const id = purchaseOrderIdSchema.parse(req.params.purchaseOrderId);
      const file = await getPurchaseOrderPdfPreview(
        readContext(res),
        getAuth(req).user.id,
        id,
      );
      res
        .status(200)
        .type("application/pdf")
        .setHeader("Content-Disposition", `inline; filename="${file.filename}"`)
        .setHeader("Cache-Control", "private, no-store")
        .setHeader("Referrer-Policy", "no-referrer")
        .setHeader("X-Content-Type-Options", "nosniff")
        .send(file.pdf);
    },
  );

  router.patch(
    "/purchase-orders/:purchaseOrderId",
    jsonBody,
    requireMenuPermission("purchasing.order.create"),
    async (req, res) => {
      const id = purchaseOrderIdSchema.parse(req.params.purchaseOrderId);
      const input = updatePurchaseOrderInputSchema.parse(req.body);
      res.json({
        data: await updatePurchaseOrder(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          id,
          input,
        ),
      });
    },
  );

  router.post(
    "/purchase-orders/:purchaseOrderId/transitions",
    jsonBody,
    menuGateFor((body) => {
      const { action } = transitionPurchaseOrderInputSchema.parse(body);
      return action === "close" || action === "cancel"
        ? [purchaseOrderActionPermission(action), "purchasing.order.approve"]
        : [purchaseOrderActionPermission(action)];
    }),
    async (req, res) => {
      const id = purchaseOrderIdSchema.parse(req.params.purchaseOrderId);
      const input = transitionPurchaseOrderInputSchema.parse(req.body);
      res.json({
        data: await transitionPurchaseOrderStatus(
          transitionContext(req, res),
          getAuth(req).user.id,
          id,
          input,
        ),
      });
    },
  );

  return router;
}
