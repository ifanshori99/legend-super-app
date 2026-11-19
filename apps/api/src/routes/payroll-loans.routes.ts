// Kasbon (employee loan) routes (bead legend-gfcr slice D, PRD v1.7 §3 D.31;
// contract `@starter/shared/hris/payroll` endpoints.ts). Two routers:
//   payrollLoansRouter    mounted at `/api/hris/payroll/loans` (HR side)
//   payrollMyLoansRouter  mounted at `/api/hris/me/loans` (own rows, HR-01)
// The tenant comes from the server-minted context (TEN-02). The HR list takes
// `payroll.view` or `hr.loan.approve`; deciding and disbursing `hr.loan.approve`.
// The self routes need `self.loan.request` (legend-krvk7; 403 without it) and
// resolve the employee from the session, never from input. The services
// re-check every right inside the tenant transaction.
//
// Mount both before `/hris`, whose router applies its own middleware to
// everything under its prefix.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  AccessError,
  outletReachOf,
  type PermissionCode,
} from "@starter/shared/access";
import {
  outletIdSchema,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  createMyLoan,
  decideEmployeeLoan,
  disburseEmployeeLoan,
  listEmployeeLoans,
  listMyLoans,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  loadRequestAccess,
  requireTenantPermission,
} from "../middleware/permissions";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { loadTenantAccess } from "../services/permission-resolver";
import * as loans from "../services/payroll-loans.service";

const selfContexts = new WeakMap<Request, ScopedTenantContext>();

/** Tenant-wide right for the first of `codes` the caller holds. */
function requireAnyTenantPermission(
  codes: readonly PermissionCode[],
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const snapshot = await loadRequestAccess(req);
    for (const code of codes) {
      if (snapshot.contextFor(code, { type: "tenant" })) {
        // Mint the context through the same single-code gate.
        return requireTenantPermission(code)(req, res, next);
      }
    }
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this tenant.",
    );
  };
}

/**
 * `self.loan.request` is granted at outlet scope for staff, so a tenant-wide
 * target does not fit: mint the narrowest context the caller reaches (TEN-03).
 * Same logic as the HRIS gate (routes/hris-leave.routes.ts requireHris).
 */
function requireSelf(code: PermissionCode): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const snapshot = await loadRequestAccess(req);
    const tenant = getTenantContext(req);
    let context: ScopedTenantContext | null = snapshot.contextFor(code, {
      type: "tenant",
    });
    if (!context && snapshot.permissions.includes(code)) {
      const userId = userIdSchema.parse(getAuth(req).user.id);
      const data = await loadTenantAccess(
        establishScopedTenantContext(tenant, { kind: "tenant" }),
        userId,
      );
      const reach = outletReachOf({
        principal: {
          tenantId: tenant.tenantId,
          userId,
          assignments: data.assignments,
        },
        roles: data.roles,
        org: data.org,
        now: data.clock ?? new Date(),
        permission: code,
      });
      if (reach?.kind === "tenant")
        context = establishScopedTenantContext(tenant, { kind: "tenant" });
      else if (reach && reach.outletIds.length > 0)
        context = establishScopedTenantContext(tenant, {
          kind: "outlets",
          outletIds: reach.outletIds.map((id): OutletId =>
            outletIdSchema.parse(id.toLowerCase()),
          ),
        });
    }
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this tenant.",
      );
    selfContexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

function selfContext(req: Request): ScopedTenantContext {
  const context = selfContexts.get(req);
  if (!context) throw new Error("selfContext() used without requireSelf()");
  return context;
}

// ---- HR side ----------------------------------------------------------

export const payrollLoansRouter = Router();

payrollLoansRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

payrollLoansRouter.get(
  "/",
  requireAnyTenantPermission(["payroll.view", "hr.loan.approve"]),
  async (req, res) => {
    const query = listEmployeeLoans.query.parse(req.query);
    res.json(
      await loans.listEmployeeLoans(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

payrollLoansRouter.post(
  "/:employeeLoanId/decision",
  requireTenantPermission("hr.loan.approve"),
  jsonBody,
  async (req, res) => {
    const { employeeLoanId } = decideEmployeeLoan.params.parse(req.params);
    const body = decideEmployeeLoan.body.parse(req.body);
    res.json({
      data: await loans.decideEmployeeLoan(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        employeeLoanId,
        body,
      ),
    });
  },
);

payrollLoansRouter.post(
  "/:employeeLoanId/disburse",
  requireTenantPermission("hr.loan.approve"),
  jsonBody,
  async (req, res) => {
    const { employeeLoanId } = disburseEmployeeLoan.params.parse(req.params);
    const body = disburseEmployeeLoan.body.parse(req.body);
    res.json({
      data: await loans.disburseEmployeeLoan(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        employeeLoanId,
        body,
      ),
    });
  },
);

// ---- Employee self-service ----------------------------------------------

export const payrollMyLoansRouter = Router();

payrollMyLoansRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

payrollMyLoansRouter.get(
  "/",
  requireSelf("self.loan.request"),
  async (req, res) => {
    const query = listMyLoans.query.parse(req.query);
    res.json(
      await loans.listMyLoans(selfContext(req), getAuth(req).user.id, query),
    );
  },
);

payrollMyLoansRouter.post(
  "/",
  requireSelf("self.loan.request"),
  jsonBody,
  async (req, res) => {
    const body = createMyLoan.body.parse(req.body);
    res.status(201).json({
      data: await loans.createMyLoan(
        selfContext(req),
        getAuth(req).user.id,
        body,
      ),
    });
  },
);
