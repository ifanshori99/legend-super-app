// Employee payslips and the payslip PIN (bead legend-2ap3, PRD v1.7 §3 D.30
// "Slip Gaji"; contract `@starter/shared/hris/payroll` endpoints.ts). Mounted at
// `/api/hris`, so each handler path is the contract path without that prefix:
//   GET  /me/payslips                          own history, no amounts
//   POST /me/payslips/:payslipId/view          open one with the PIN
//   GET/PUT /me/payslip-pin                    status, first set / change
//   POST /me/payslip-pin/reset-wa              open a proof: employee sends RESET PIN <code>
//   GET  /me/payslip-pin/reset-wa/:id          poll it
//   POST /me/payslip-pin/reset-wa/:id/pin      new PIN with the verified proof
//   POST /me/payslip-pin/reset-wa/:id/cancel
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
  cancelMyPayslipPinResetWa as cancelWaEndpoint,
  completeMyPayslipPinResetWa as completeWaEndpoint,
  getMyPayslipPinResetWa as getWaEndpoint,
  listMyPayslips as listMyPayslipsEndpoint,
  resetEmployeePayslipPin as resetEndpoint,
  setMyPayslipPin as setPinEndpoint,
  startMyPayslipPinResetWa as startWaEndpoint,
  viewMyPayslip as viewMyPayslipEndpoint,
} from "@starter/shared/hris/payroll";
import {
  PAYSLIP_PIN_PROOF_GRANT_MINUTES,
  WA_PROOF_TTL_MINUTES,
} from "@starter/shared/identity";
import {
  bindingDigestOf,
  ensureBindingNonce,
  PIN_RESET_BINDING,
  readBindingNonce,
  setBindingCookie,
} from "../lib/login-binding";
import { clientIpDigest } from "../lib/identity-digest";
import { whatsAppWebhookSecretsOf } from "../lib/whatsapp-webhook-secrets";
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

/** The proof lives 5 minutes, the PIN grant 10 more, plus a minute of slack. */
const RESET_BINDING_COOKIE_SECONDS =
  (WA_PROOF_TTL_MINUTES + PAYSLIP_PIN_PROOF_GRANT_MINUTES + 1) * 60;

/**
 * The asking browser: signed session plus the pin-reset binding cookie. A
 * request without the cookie gets a digest nothing matches, so it is refused
 * the same way as a wrong one.
 */
function resetBrowser(req: Request): pins.WaResetBrowser {
  const nonce = readBindingNonce(req, PIN_RESET_BINDING);
  return {
    sessionId: getAuth(req).session.id,
    bindingHash: bindingDigestOf(nonce ?? "", PIN_RESET_BINDING),
  };
}

export type HrisPayslipRouterDeps = {
  /** Private-bucket URL signer for the payslip PDF; default mints no URL. */
  readonly fileSigner?: HrisFileSigner;
};

export function createHrisPayslipRouter(
  deps: HrisPayslipRouterDeps = {},
): Router {
  const signer = deps.fileSigner ?? noHrisFileSigner;
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
          undefined,
          getAuth(req).session.id,
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

  // Not idempotentHrisWrite: a stored response would hold the code (D-WA6).
  router.post("/me/payslip-pin/reset-wa", self, jsonBody, async (req, res) => {
    startWaEndpoint.body.parse(req.body);
    const nonce = ensureBindingNonce(req, PIN_RESET_BINDING);
    const issued = await pins.requestPayslipPinResetWa(
      selfContext(req),
      actor(req),
      {
        sessionId: getAuth(req).session.id,
        bindingHash: bindingDigestOf(nonce, PIN_RESET_BINDING),
        ipHash: req.ip ? clientIpDigest(req.ip) : null,
        userAgent: req.get("user-agent") ?? null,
        webhookSecrets: whatsAppWebhookSecretsOf(req),
      },
    );
    setBindingCookie(
      res,
      nonce,
      RESET_BINDING_COOKIE_SECONDS,
      PIN_RESET_BINDING,
    );
    res.status(201).json({ data: issued });
  });

  router.get(
    "/me/payslip-pin/reset-wa/:challengeId",
    self,
    async (req, res) => {
      const { challengeId } = getWaEndpoint.params.parse(req.params);
      res.json({
        data: await pins.getPayslipPinResetWa(
          selfContext(req),
          actor(req),
          challengeId,
          resetBrowser(req),
        ),
      });
    },
  );

  router.post(
    "/me/payslip-pin/reset-wa/:challengeId/pin",
    self,
    jsonBody,
    async (req, res) => {
      const { challengeId } = completeWaEndpoint.params.parse(req.params);
      const body = completeWaEndpoint.body.parse(req.body);
      res.json({
        data: await pins.completePayslipPinResetWa(
          selfContext(req),
          actor(req),
          challengeId,
          resetBrowser(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/me/payslip-pin/reset-wa/:challengeId/cancel",
    self,
    jsonBody,
    async (req, res) => {
      const { challengeId } = cancelWaEndpoint.params.parse(req.params);
      cancelWaEndpoint.body.parse(req.body);
      await pins.cancelPayslipPinResetWa(
        selfContext(req),
        actor(req),
        challengeId,
        getAuth(req).session.id,
      );
      res.status(204).end();
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

/** Default instance: no PDF signer (the lead wires it). */
export const hrisPayslipRouter = createHrisPayslipRouter();
