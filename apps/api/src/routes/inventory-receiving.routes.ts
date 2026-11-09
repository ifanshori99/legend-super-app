// Goods receipt routes (PRD v1.7 §3.18, §4 Alur I step 3; INV-05; bead
// legend-o1o4s). Mount at `/api/inventory` (routes/index.ts). Paths and bodies
// come from `@starter/shared/inventory` (`createGoodsReceipt`, ...).
//
// The tenant comes from the server-minted context (TEN-02). Reads take
// `outletId` from the query, the create from the body; the role must cover it
// (TEN-03). Writes need `inventory.stock.receive`; reads accept it or any
// purchasing read permission (fail closed). Id-only reads merge the reach of
// every permission that passes; the service re-checks the permission against
// the receipt's own outlet and RLS hides other outlets (404).

import {
  createGoodsReceiptInputSchema,
  goodsReceiptIdSchema,
  goodsReceiptQuerySchema,
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
  createGoodsReceipt,
  getGoodsReceipt,
  GOODS_RECEIPT_READ_PERMISSIONS,
  listGoodsReceipts,
} from "../services/inventory-receiving.service.ts";

const queryOutlet = (req: Request) => String(req.query.outletId);
/** Create route: the outlet comes from the (already parsed) JSON body. */
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
      "Your account cannot view goods receipts in this outlet.",
    );
  };
}

/**
 * Id-only reads: every permission is tried and the reach of all that pass is
 * merged (tenant-wide if any is). No permission passing is a denial. The merged
 * context is kept in `res.locals`; the service re-checks a read permission at
 * the receipt's own outlet.
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
        "Your account cannot view goods receipts in this tenant.",
      );
    const outletIds = new Set<string>();
    let tenantWide = false;
    for (const reach of reaches) {
      if (reach.outletScope.kind === "tenant") tenantWide = true;
      else for (const id of reach.outletScope.outletIds) outletIds.add(id);
    }
    res.locals.goodsReceiptReadContext = establishScopedTenantContext(
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
  res.locals.goodsReceiptReadContext as ScopedTenantContext;

export function createInventoryReceivingRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const readOutlet = anyOf(
    GOODS_RECEIPT_READ_PERMISSIONS.map((permission) =>
      requireOutletPermission(permission, queryOutlet),
    ),
  );
  const readById = readScopeByPermissions(GOODS_RECEIPT_READ_PERMISSIONS);

  router.get("/goods-receipts", readOutlet, async (req, res) => {
    const query = goodsReceiptQuerySchema.parse(req.query);
    res.json(
      await listGoodsReceipts(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/goods-receipts",
    jsonBody,
    requireOutletPermission("inventory.stock.receive", bodyOutlet),
    async (req, res) => {
      const input = createGoodsReceiptInputSchema.parse(req.body);
      const detail = await createGoodsReceipt(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: detail });
    },
  );

  router.get("/goods-receipts/:goodsReceiptId", readById, async (req, res) => {
    const id = goodsReceiptIdSchema.parse(req.params.goodsReceiptId);
    res.json({
      data: await getGoodsReceipt(readContext(res), getAuth(req).user.id, id),
    });
  });

  return router;
}
