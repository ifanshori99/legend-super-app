// Stock opname routes (PRD v1.7 §3 F16 "Stok Opname", INV-03; bead legend-j5x).
//
// Mount at `/api/inventory` next to `createInventoryOpsRouter()` (routes/index.ts).
// Paths and bodies come from `@starter/shared/inventory` (`inventoryEndpoints`).
//
// The tenant comes from the server-minted context (TEN-02). List and create
// carry the outlet in the query or body, so the role must cover it (TEN-03).
// Item routes only know the count id: they mint the caller's reachable scope
// for the route permission and the service re-checks it against the count's
// own outlet, so a blind count never leaks `systemQty` or variance to a
// counter (the sheet endpoints expose neither). Transitions pick the gate from
// the action: `approve`/`reject` need `inventory.adjustment.approve`, the rest
// `inventory.opname.count`; the service enforces the same split and the
// second-person rule.
//
// Express matches by segment count, but the `/sheet` routes are registered
// before the bare `/:stockCountId` routes anyway so a future wildcard can
// never swallow them.

import {
  createStockCountInputSchema,
  stockCountIdSchema,
  stockCountLineIdSchema,
  stockCountQuerySchema,
  transitionStockCountInputSchema,
  updateStockCountLineInputSchema,
} from "@starter/shared/inventory";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import {
  createStockCount,
  getStockCountDetail,
  getStockCountSheet,
  listStockCounts,
  transitionStockCount,
  updateStockCountLine,
  updateStockCountSheetLine,
} from "../services/inventory-count.service.ts";

const queryOutlet = (req: Request) => String(req.query.outletId);
/** Create route: the outlet comes from the (already parsed) JSON body. */
const bodyOutlet = (req: Request) =>
  String((req.body as { outletId?: unknown } | undefined)?.outletId);

const countParamsSchema = z.strictObject({ stockCountId: stockCountIdSchema });
const countLineParamsSchema = z.strictObject({
  stockCountId: stockCountIdSchema,
  lineId: stockCountLineIdSchema,
});

const viewCount = requireMenuPermission("inventory.stock.view");
const enterCount = requireMenuPermission("inventory.opname.count");
const approveCount = requireMenuPermission("inventory.adjustment.approve");

/** Runs a gate without forwarding: resolves when it passes, rejects otherwise. */
const passes = (gate: RequestHandler, req: Request, res: Response) =>
  new Promise<void>((resolve, reject) => {
    Promise.resolve(
      gate(req, res, (error?: unknown) =>
        error === undefined ? resolve() : reject(error),
      ),
    ).catch(reject);
  });

/**
 * Picks the permission gate from the (validated) transition action. `post`
 * only settles an approval already decided (e.g. in the approval inbox), so a
 * counter or an approver may trigger it; the service re-checks either way.
 */
const transitionGate: RequestHandler = async (req, res, next) => {
  const { action } = transitionStockCountInputSchema.parse(req.body);
  if (action === "post") {
    try {
      await passes(approveCount, req, res);
    } catch {
      await passes(enterCount, req, res);
    }
    next();
    return;
  }
  const gate =
    action === "approve" || action === "reject" ? approveCount : enterCount;
  return gate(req, res, next);
};

export function createInventoryCountRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  router.get(
    "/stock-counts",
    requireOutletPermission("inventory.stock.view", queryOutlet),
    async (req, res) => {
      const query = stockCountQuerySchema.parse(req.query);
      res.json(
        await listStockCounts(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          query,
        ),
      );
    },
  );

  router.post(
    "/stock-counts",
    jsonBody,
    requireOutletPermission("inventory.opname.count", bodyOutlet),
    async (req, res) => {
      const input = createStockCountInputSchema.parse(req.body);
      const count = await createStockCount(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: count });
    },
  );

  // Counter view of a count: no system quantity, cost or variance.
  router.get(
    "/stock-counts/:stockCountId/sheet",
    enterCount,
    async (req, res) => {
      const { stockCountId } = countParamsSchema.parse(req.params);
      res.json({
        data: await getStockCountSheet(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          stockCountId,
        ),
      });
    },
  );

  router.patch(
    "/stock-counts/:stockCountId/sheet/lines/:lineId",
    jsonBody,
    enterCount,
    async (req, res) => {
      const { stockCountId, lineId } = countLineParamsSchema.parse(req.params);
      const input = updateStockCountLineInputSchema.parse(req.body);
      res.json({
        data: await updateStockCountSheetLine(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          stockCountId,
          lineId,
          input,
        ),
      });
    },
  );

  router.patch(
    "/stock-counts/:stockCountId/lines/:lineId",
    jsonBody,
    enterCount,
    async (req, res) => {
      const { stockCountId, lineId } = countLineParamsSchema.parse(req.params);
      const input = updateStockCountLineInputSchema.parse(req.body);
      res.json({
        data: await updateStockCountLine(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          stockCountId,
          lineId,
          input,
        ),
      });
    },
  );

  router.post(
    "/stock-counts/:stockCountId/transitions",
    jsonBody,
    transitionGate,
    async (req, res) => {
      const { stockCountId } = countParamsSchema.parse(req.params);
      const input = transitionStockCountInputSchema.parse(req.body);
      res.json({
        data: await transitionStockCount(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          stockCountId,
          input,
          { mfaVerified: (await sessionMfaVerifiedAt(req)) !== null },
        ),
      });
    },
  );

  router.get("/stock-counts/:stockCountId", viewCount, async (req, res) => {
    const { stockCountId } = countParamsSchema.parse(req.params);
    res.json({
      data: await getStockCountDetail(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        stockCountId,
      ),
    });
  });

  return router;
}
