// Supplier invoice, hold/release and purchasing policy routes (ws/purchasing-apar;
// design docs/briefs/ws-purchasing-apar-design.md §7). Mount at `/api/inventory`
// (routes/index.ts). Paths and bodies come from `@starter/shared/inventory`.
//
// The tenant comes from the server-minted context (TEN-02). Outlet routes take
// `outletId` from the query or the body and the role must cover it (TEN-03).
// Id-only routes pass a menu gate (the reach of the permission) and the service
// re-checks the permission at the invoice's own outlet; RLS hides other outlets
// and tenants (404). Release needs finance (`accounting.supplier_payment.process`)
// and the service refuses the recorder. The policy is tenant-wide: anyone who
// matches invoices or pays suppliers may read it, only finance may change it.

import {
  createSupplierInvoiceInputSchema,
  decideSupplierInvoiceInputSchema,
  recordSupplierInvoiceMatchInputSchema,
  requestSupplierInvoicePaymentInputSchema,
  retrySupplierPaymentSettlementInputSchema,
  supplierInvoiceIdSchema,
  supplierPaymentIdSchema,
  supplierInvoiceQuerySchema,
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
  createSupplierInvoice,
  getSupplierInvoice,
  listSupplierInvoices,
  rejectSupplierInvoice,
  rematchSupplierInvoice,
  releaseSupplierInvoice,
  SUPPLIER_INVOICE_READ_PERMISSIONS,
} from "../services/purchasing-invoice.service.ts";
import {
  listSupplierInvoicePayments,
  requestSupplierInvoicePayment,
  retrySupplierPaymentSettlement,
} from "../services/purchasing-supplier-payment.service.ts";
import {
  getPurchasingPolicy,
  putPurchasingPolicy,
} from "../services/purchasing-policy.service.ts";

const MATCH_PERMISSION: PermissionCode = "purchasing.invoice.match";
const RELEASE_PERMISSION: PermissionCode =
  "accounting.supplier_payment.process";

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
      "Your account cannot view supplier invoices in this outlet.",
    );
  };
}

/**
 * Id-only routes and the tenant policy read: every permission is tried and the
 * reach of all that pass is merged (tenant-wide if any is). No permission
 * passing is a denial. The merged context is kept in `res.locals`.
 */
function scopeByPermissions(
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
        "Your account cannot use supplier invoices in this tenant.",
      );
    const outletIds = new Set<string>();
    let tenantWide = false;
    for (const reach of reaches) {
      if (reach.outletScope.kind === "tenant") tenantWide = true;
      else for (const id of reach.outletScope.outletIds) outletIds.add(id);
    }
    res.locals.supplierInvoiceContext = establishScopedTenantContext(
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

const mergedContext = (res: Response) =>
  res.locals.supplierInvoiceContext as ScopedTenantContext;

const invoiceId = (req: Request) =>
  supplierInvoiceIdSchema.parse(req.params.supplierInvoiceId);

export function createPurchasingInvoiceRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const readOutlet = anyOf(
    SUPPLIER_INVOICE_READ_PERMISSIONS.map((permission) =>
      requireOutletPermission(permission, queryOutlet),
    ),
  );
  const readScope = scopeByPermissions(SUPPLIER_INVOICE_READ_PERMISSIONS);

  router.get("/supplier-invoices", readOutlet, async (req, res) => {
    const query = supplierInvoiceQuerySchema.parse(req.query);
    res.json(
      await listSupplierInvoices(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  });

  router.post(
    "/supplier-invoices",
    jsonBody,
    requireOutletPermission(MATCH_PERMISSION, bodyOutlet),
    async (req, res) => {
      const input = createSupplierInvoiceInputSchema.parse(req.body);
      const detail = await createSupplierInvoice(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      );
      res.status(201).json({ data: detail });
    },
  );

  router.get(
    "/supplier-invoices/:supplierInvoiceId",
    readScope,
    async (req, res) => {
      res.json({
        data: await getSupplierInvoice(
          mergedContext(res),
          getAuth(req).user.id,
          invoiceId(req),
        ),
      });
    },
  );

  router.post(
    "/supplier-invoices/:supplierInvoiceId/match",
    jsonBody,
    requireMenuPermission(MATCH_PERMISSION),
    async (req, res) => {
      const input = recordSupplierInvoiceMatchInputSchema.parse(req.body);
      res.json({
        data: await rematchSupplierInvoice(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          invoiceId(req),
          input,
        ),
      });
    },
  );

  router.post(
    "/supplier-invoices/:supplierInvoiceId/release",
    jsonBody,
    requireMenuPermission(RELEASE_PERMISSION),
    async (req, res) => {
      const input = decideSupplierInvoiceInputSchema.parse(req.body);
      res.json({
        data: await releaseSupplierInvoice(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          invoiceId(req),
          input,
        ),
      });
    },
  );

  // Payment of one invoice through the approval matrix (legend-xxqz3). The
  // request needs finance at the invoice's own outlet (re-checked in the
  // service, RLS hides other outlets and tenants); the list is read-scoped.
  router.post(
    "/supplier-invoices/:supplierInvoiceId/payments",
    jsonBody,
    requireMenuPermission(RELEASE_PERMISSION),
    async (req, res) => {
      const input = requestSupplierInvoicePaymentInputSchema.parse(req.body);
      const payment = await requestSupplierInvoicePayment(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        invoiceId(req),
        input,
      );
      res.status(201).json({ data: payment });
    },
  );

  router.get(
    "/supplier-invoices/:supplierInvoiceId/payments",
    scopeByPermissions([
      RELEASE_PERMISSION,
      ...SUPPLIER_INVOICE_READ_PERMISSIONS,
    ]),
    async (req, res) => {
      res.json(
        await listSupplierInvoicePayments(
          mergedContext(res),
          getAuth(req).user.id,
          invoiceId(req),
        ),
      );
    },
  );

  // Retry of a parked payment (approved chain, cash 1102 was short;
  // legend-5qqb9). Same permission as the request; the service re-checks it at
  // the payment's own outlet and settles through the approval settlement.
  router.post(
    "/supplier-payments/:supplierPaymentId/retry-settlement",
    jsonBody,
    requireMenuPermission(RELEASE_PERMISSION),
    async (req, res) => {
      retrySupplierPaymentSettlementInputSchema.parse(req.body);
      res.json({
        data: await retrySupplierPaymentSettlement(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          supplierPaymentIdSchema.parse(req.params.supplierPaymentId),
        ),
      });
    },
  );

  router.post(
    "/supplier-invoices/:supplierInvoiceId/reject",
    jsonBody,
    readScope,
    async (req, res) => {
      const input = decideSupplierInvoiceInputSchema.parse(req.body);
      res.json({
        data: await rejectSupplierInvoice(
          mergedContext(res),
          getAuth(req).user.id,
          invoiceId(req),
          input,
        ),
      });
    },
  );

  router.get("/purchasing-policy", readScope, async (_req, res) => {
    res.json({ data: await getPurchasingPolicy(mergedContext(res)) });
  });

  router.put(
    "/purchasing-policy",
    jsonBody,
    requireTenantPermission(RELEASE_PERMISSION),
    async (req, res) => {
      res.json({
        data: await putPurchasingPolicy(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          req.body,
        ),
      });
    },
  );

  return router;
}
