// Employee payslips and the payslip PIN (bead legend-2ap3, PRD v1.7 §3 D.30
// "Slip Gaji"; contract `@starter/shared/hris/payroll` endpoints.ts). Mounted at
// `/api/hris`, so each handler path is the contract path without that prefix:
//   GET  /me/payslips                          own history, no amounts
//   POST /me/payslips/:payslipId/view          open one with the PIN
//   GET/PUT /me/payslip-pin                    status, first set / change
//   POST /me/payslip-pin/reset-otp(/verify)    WhatsApp one-time code reset
//   POST /employees/:employeeId/payslip-pin/reset   HR (payroll.run) clears it
// The self routes resolve the employee from the session, never from input
// (HR-01); the services re-check `self.payslip.view` inside the transaction.
//
// Middleware is attached per path prefix (not `router.use` for everything), so
// a request for any other `/hris` path falls through to the next router
// untouched.
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
  listMyPayslips as listMyPayslipsEndpoint,
  requestMyPayslipPinResetOtp as requestOtpEndpoint,
  resetEmployeePayslipPin as resetEndpoint,
  setMyPayslipPin as setPinEndpoint,
  verifyMyPayslipPinResetOtp as verifyOtpEndpoint,
  viewMyPayslip as viewMyPayslipEndpoint,
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
import * as payslips from "../services/hris-payslip.service";
import * as pins from "../services/payslip-pin.service";
import { loadTenantAccess } from "../services/permission-resolver";

const selfContexts = new WeakMap<Request, ScopedTenantContext>();

/**
 * `self.payslip.view` is granted at outlet scope for staff, so mint the
 * narrowest context the caller reaches (TEN-03). Same logic as
 * routes/payroll-loans.routes.ts requireSelf.
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
        now: new Date(),
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
    // Salary and PIN responses are never cached.
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

function selfContext(req: Request): ScopedTenantContext {
  const context = selfContexts.get(req);
  if (!context) throw new Error("selfContext() used without requireSelf()");
  return context;
}

export type HrisPayslipRouterDeps = {
  /** Private-bucket URL signer for the payslip PDF; default mints no URL. */
  readonly fileSigner?: HrisFileSigner;
  /** WhatsApp code delivery; default none, so the reset code answers 503. */
  readonly otpSender?: pins.PayslipPinOtpSender | null;
};

export function createHrisPayslipRouter(
  deps: HrisPayslipRouterDeps = {},
): Router {
  const signer = deps.fileSigner ?? noHrisFileSigner;
  const otpSender = deps.otpSender ?? null;
  const router = Router();
  const base: RequestHandler[] = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
  ];
  const self = requireSelf("self.payslip.view");
  const actor = (req: Request) => getAuth(req).user.id;

  router.use(["/me/payslips", "/me/payslip-pin"], ...base);
  router.use("/employees/:employeeId/payslip-pin", ...base);

  router.get("/me/payslips", self, async (req, res) => {
    const query = listMyPayslipsEndpoint.query.parse(req.query);
    res.json(
      await payslips.listMyPayslips(selfContext(req), actor(req), query),
    );
  });

  router.post(
    "/me/payslips/:payslipId/view",
    self,
    jsonBody,
    async (req, res) => {
      const { payslipId } = viewMyPayslipEndpoint.params.parse(req.params);
      const body = viewMyPayslipEndpoint.body.parse(req.body);
      res.json({
        data: await payslips.viewMyPayslip(
          selfContext(req),
          actor(req),
          payslipId,
          body,
          signer,
        ),
      });
    },
  );

  router.get("/me/payslip-pin", self, async (req, res) => {
    res.json({
      data: await pins.getMyPayslipPinStatus(selfContext(req), actor(req)),
    });
  });

  router.put("/me/payslip-pin", self, jsonBody, async (req, res) => {
    const body = setPinEndpoint.body.parse(req.body);
    res.json({
      data: await pins.setMyPayslipPin(selfContext(req), actor(req), body),
    });
  });

  router.post("/me/payslip-pin/reset-otp", self, jsonBody, async (req, res) => {
    const body = requestOtpEndpoint.body.parse(req.body);
    res.json({
      data: await pins.requestPayslipPinResetOtp(
        selfContext(req),
        actor(req),
        body,
        otpSender,
      ),
    });
  });

  router.post(
    "/me/payslip-pin/reset-otp/verify",
    self,
    jsonBody,
    async (req, res) => {
      const body = verifyOtpEndpoint.body.parse(req.body);
      res.json({
        data: await pins.verifyPayslipPinResetOtp(
          selfContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/employees/:employeeId/payslip-pin/reset",
    requireTenantPermission("payroll.run"),
    jsonBody,
    async (req, res) => {
      const { employeeId } = resetEndpoint.params.parse(req.params);
      const body = resetEndpoint.body.parse(req.body);
      res.json({
        data: await pins.resetEmployeePayslipPin(
          getScopedTenantContext(req),
          actor(req),
          employeeId,
          body,
        ),
      });
    },
  );

  return router;
}

/** Default instance: no PDF signer and no OTP sender (the lead wires both). */
export const hrisPayslipRouter = createHrisPayslipRouter();
