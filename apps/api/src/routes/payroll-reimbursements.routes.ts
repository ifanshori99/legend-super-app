// Reimbursement routes (bead legend-gfcr, PRD v1.7 §3 D.31; contract
// `@starter/shared/hris/payroll` endpoints.ts). Three routers:
//   payrollReimbursementCategoriesRouter  /api/hris/payroll/reimbursement-categories
//   payrollReimbursementsRouter           /api/hris/payroll/reimbursements
//   payrollMyReimbursementsRouter         /api/hris/me/reimbursements
// Tenant comes from the server-minted context, never the request (TEN-02).
// Back-office routes need a tenant-wide right (service re-checks it in the
// transaction). The /me routes mint the caller's own reach (an employee holds
// `self.reimbursement.request` on an outlet) and the service resolves the
// employee from the session (HR-01).

import {
  Router,
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
  createMyReimbursement,
  createReimbursementCategory,
  decideReimbursement,
  listMyReimbursements,
  listReimbursementCategories,
  listReimbursements,
  payReimbursementCash,
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
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "../services/hris-contract.service";
import * as service from "../services/payroll-reimbursements.service";
import { loadTenantAccess } from "../services/permission-resolver";

const gate = [requireAuth, requireTrustedOrigin, requireTenantContext] as const;

/** Tenant-wide right: payroll.view or the approver right (category list). */
const requireViewOrApprove: RequestHandler = async (req, res, next) => {
  const snapshot = await loadRequestAccess(req);
  const code: PermissionCode = snapshot.contextFor("payroll.view", {
    type: "tenant",
  })
    ? "payroll.view"
    : "hr.reimbursement.approve";
  return requireTenantPermission(code)(req, res, next);
};

const selfContexts = new WeakMap<Request, ScopedTenantContext>();
const selfContext = (req: Request): ScopedTenantContext => {
  const context = selfContexts.get(req);
  if (!context)
    throw new Error("selfContext() used without requireSelfReimbursement");
  return context;
};

/** Employee PWA gate: tenant-wide when held so, else the outlets it reaches. */
const requireSelfReimbursement: RequestHandler = async (req, res, next) => {
  const code: PermissionCode = "self.reimbursement.request";
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
  (res as Response).setHeader("Cache-Control", "private, no-store");
  next();
};

const actor = (req: Request) => getAuth(req).user.id;

export type PayrollReimbursementRouterDeps = {
  /** Private-bucket URL signer (core-storage); default mints no URL. */
  readonly fileSigner?: HrisFileSigner;
};

export function createPayrollReimbursementRouters(
  deps: PayrollReimbursementRouterDeps = {},
) {
  const signer = deps.fileSigner ?? noHrisFileSigner;
  // ---- Categories -----------------------------------------------------------

  const payrollReimbursementCategoriesRouter = Router();
  payrollReimbursementCategoriesRouter.use(...gate);

  payrollReimbursementCategoriesRouter.get(
    "/",
    requireViewOrApprove,
    async (req, res) => {
      const query = listReimbursementCategories.query.parse(req.query);
      res.json(
        await service.listReimbursementCategories(
          getScopedTenantContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  payrollReimbursementCategoriesRouter.post(
    "/",
    requireTenantPermission("payroll.run"),
    jsonBody,
    async (req, res) => {
      const body = createReimbursementCategory.body.parse(req.body);
      res.status(201).json({
        data: await service.createReimbursementCategory(
          getScopedTenantContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  // ---- Claims (HR side) -----------------------------------------------------

  const payrollReimbursementsRouter = Router();
  payrollReimbursementsRouter.use(...gate);

  payrollReimbursementsRouter.get(
    "/",
    requireTenantPermission("hr.reimbursement.approve"),
    async (req, res) => {
      const query = listReimbursements.query.parse(req.query);
      res.json(
        await service.listReimbursements(
          getScopedTenantContext(req),
          actor(req),
          query,
          signer,
        ),
      );
    },
  );

  payrollReimbursementsRouter.post(
    "/:reimbursementId/decision",
    requireTenantPermission("hr.reimbursement.approve"),
    jsonBody,
    async (req, res) => {
      const { reimbursementId } = decideReimbursement.params.parse(req.params);
      const body = decideReimbursement.body.parse(req.body);
      res.json({
        data: await service.decideReimbursement(
          getScopedTenantContext(req),
          actor(req),
          reimbursementId,
          body,
          new Date(),
          signer,
        ),
      });
    },
  );

  payrollReimbursementsRouter.post(
    "/:reimbursementId/pay",
    requireTenantPermission("hr.reimbursement.approve"),
    jsonBody,
    async (req, res) => {
      const { reimbursementId } = payReimbursementCash.params.parse(req.params);
      const { idempotencyKey } = payReimbursementCash.body.parse(req.body);
      res.json({
        data: await service.payReimbursementCash(
          getScopedTenantContext(req),
          actor(req),
          reimbursementId,
          idempotencyKey,
          new Date(),
          signer,
        ),
      });
    },
  );

  // ---- Employee self-service ------------------------------------------------

  const payrollMyReimbursementsRouter = Router();
  payrollMyReimbursementsRouter.use(...gate);

  payrollMyReimbursementsRouter.get(
    "/",
    requireSelfReimbursement,
    async (req, res) => {
      const query = listMyReimbursements.query.parse(req.query);
      res.json(
        await service.listMyReimbursements(
          selfContext(req),
          actor(req),
          query,
          signer,
        ),
      );
    },
  );

  payrollMyReimbursementsRouter.post(
    "/",
    requireSelfReimbursement,
    jsonBody,
    async (req, res) => {
      const body = createMyReimbursement.body.parse(req.body);
      res.status(201).json({
        data: await service.createMyReimbursement(
          selfContext(req),
          actor(req),
          body,
          new Date(),
          signer,
        ),
      });
    },
  );

  return {
    payrollReimbursementCategoriesRouter,
    payrollReimbursementsRouter,
    payrollMyReimbursementsRouter,
  };
}

export const {
  payrollReimbursementCategoriesRouter,
  payrollReimbursementsRouter,
  payrollMyReimbursementsRouter,
} = createPayrollReimbursementRouters();
