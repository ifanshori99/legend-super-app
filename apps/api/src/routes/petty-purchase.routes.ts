// Petty purchase routes (PRD v1.7 §3.18 Pembelian Sederhana; bead legend-65mgw).
// Mount at `/api/inventory` (routes/index.ts). Paths and bodies come from
// `@starter/shared/inventory` (`createPettyPurchase`, ...).
//
// The tenant comes from the server-minted context (TEN-02). Reads take
// `outletId` from the query, writes from the body; the role must cover it
// (TEN-03). Recording needs `purchasing.petty.record`; the spend list also
// opens to `accounting.reconcile`. The limit policy is read with the recorder
// or the policy permission and written with `purchasing.petty_policy.manage`
// (tenant-wide for the default row, outlet-wide for an outlet row). Id-only
// reads merge the reach of every permission that passes; the service
// re-checks the permission against the row's own outlet and RLS hides other
// outlets (404).

import {
  createPettyPurchaseInputSchema,
  pettyPurchaseIdSchema,
  pettyPurchasePolicyQuerySchema,
  pettyPurchaseQuerySchema,
  upsertPettyPurchasePolicyInputSchema,
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
  requireTenantPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import {
  createPettyPurchase,
  getPettyPurchase,
  getPettyPurchasePolicy,
  listPettyPurchases,
  PETTY_POLICY_READ_PERMISSIONS,
  PETTY_PURCHASE_READ_PERMISSIONS,
  putPettyPurchasePolicy,
} from "../services/petty-purchase.service.ts";

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
      "Your account cannot view petty purchases in this outlet.",
    );
  };
}

/**
 * Id-only reads: every permission is tried and the reach of all that pass is
 * merged (tenant-wide if any is). No permission passing is a denial. The merged
 * context is kept in `res.locals`; the service re-checks a read permission at
 * the purchase's own outlet.
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
        "Your account cannot view petty purchases in this tenant.",
      );
    const outletIds = new Set<string>();
    let tenantWide = false;
    for (const reach of reaches) {
      if (reach.outletScope.kind === "tenant") tenantWide = true;
      else for (const id of reach.outletScope.outletIds) outletIds.add(id);
    }
    res.locals.pettyPurchaseReadContext = establishScopedTenantContext(
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
  res.locals.pettyPurchaseReadContext as ScopedTenantContext;

/**
 * Policy write: a null outlet is the tenant default and needs the permission
 * tenant-wide; an outlet row needs it at that outlet.
 */
const policyWriteGate: RequestHandler = (req, res, next) => {
  const outletId = (req.body as { outletId?: unknown } | undefined)?.outletId;
  const gate =
    outletId === null
      ? requireTenantPermission("purchasing.petty_policy.manage")
      : requireOutletPermission("purchasing.petty_policy.manage", bodyOutlet);
  return gate(req, res, next);
};

export function createPettyPurchaseRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const readOutlet = anyOf(
    PETTY_PURCHASE_READ_PERMISSIONS.map((permission) =>
      requireOutletPermission(permission, queryOutlet),
    ),
  );
  const readPolicyOutlet = anyOf(
    PETTY_POLICY_READ_PERMISSIONS.map((permission) =>
      requireOutletPermission(permission, queryOutlet),
    ),
  );
  const readById = readScopeByPermissions(PETTY_PURCHASE_READ_PERMISSIONS);

  router.get("/petty-purchases", readOutlet, async (req, res) => {
    const query = pettyPurchaseQuerySchema.parse(req.query);
    res.json(
      await listPettyPurchases(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/petty-purchases",
    jsonBody,
    requireOutletPermission("purchasing.petty.record", bodyOutlet),
    async (req, res) => {
      const input = createPettyPurchaseInputSchema.parse(req.body);
      const purchase = await createPettyPurchase(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: purchase });
    },
  );

  router.get(
    "/petty-purchases/:pettyPurchaseId",
    readById,
    async (req, res) => {
      const id = pettyPurchaseIdSchema.parse(req.params.pettyPurchaseId);
      res.json({
        data: await getPettyPurchase(
          readContext(res),
          getAuth(req).user.id,
          id,
        ),
      });
    },
  );

  router.get("/petty-purchase-policy", readPolicyOutlet, async (req, res) => {
    const query = pettyPurchasePolicyQuerySchema.parse(req.query);
    res.json({
      data: await getPettyPurchasePolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    });
  });

  router.put(
    "/petty-purchase-policy",
    jsonBody,
    policyWriteGate,
    async (req, res) => {
      const input = upsertPettyPurchasePolicyInputSchema.parse(req.body);
      res.json({
        data: await putPettyPurchasePolicy(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          input,
        ),
      });
    },
  );

  return router;
}
