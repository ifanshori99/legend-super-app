// HRIS employee scheduling routes (PRD v1.7 §3 F26 "Penjadwalan Karyawan",
// HR-05; bead legend-jstx): shift templates, compliance policy, draft roster,
// weekly publication and shift swaps/covers. Paths, params, queries and bodies
// come from the WS-10 contract (`@starter/shared/hris` defineEndpoint objects);
// mounted at `/api/hris`, so each handler path is the contract path without
// that prefix. The paths here never overlap the other HRIS routers.
//
// Same gate model as hris-leave.routes.ts: requireHris() only decides "may this
// caller use the route at all" and mints the narrowest context (TEN-03); the
// services re-check outlet reach, ownership and the per-action permission
// inside the tenant transaction. Manager routes (templates, policy, roster,
// publish, decide) run behind the back-office surface (AUTH-05, MFA when the
// role requires it). Routes an employee uses on the PWA (own schedule, request
// and cancel a swap) accept either surface: back office first, the `hris`
// employee surface otherwise.

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
  cancelShiftAssignment as cancelShiftAssignmentEndpoint,
  cancelShiftSwapRequest as cancelShiftSwapRequestEndpoint,
  copyRosterWeek as copyRosterWeekEndpoint,
  createShiftAssignment as createShiftAssignmentEndpoint,
  createShiftSwapRequest as createShiftSwapRequestEndpoint,
  createShiftTemplate as createShiftTemplateEndpoint,
  decideShiftSwapRequest as decideShiftSwapRequestEndpoint,
  getRoster as getRosterEndpoint,
  getShiftCompliancePolicy as getShiftCompliancePolicyEndpoint,
  listShiftAssignments as listShiftAssignmentsEndpoint,
  listShiftSwapRequests as listShiftSwapRequestsEndpoint,
  listShiftSwapCandidates as listShiftSwapCandidatesEndpoint,
  respondShiftSwapRequest as respondShiftSwapRequestEndpoint,
  listShiftTemplates as listShiftTemplatesEndpoint,
  publishRoster as publishRosterEndpoint,
  updateShiftAssignment as updateShiftAssignmentEndpoint,
  updateShiftCompliancePolicy as updateShiftCompliancePolicyEndpoint,
  updateShiftTemplate as updateShiftTemplateEndpoint,
} from "@starter/shared/hris";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireIdentitySurface } from "../middleware/identity.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import { loadTenantAccess } from "../services/permission-resolver.ts";
import { loadSurfaceAccessFacts } from "../services/surface-access.service.ts";
import * as rosterService from "../services/hris-scheduling-roster.service.ts";
import * as setupService from "../services/hris-scheduling-setup.service.ts";
import * as swapService from "../services/hris-scheduling-swap.service.ts";

const contexts = new WeakMap<Request, ScopedTenantContext>();

function hrisContext(req: Request): ScopedTenantContext {
  const context = contexts.get(req);
  if (!context) throw new Error("hrisContext() used without requireHris()");
  return context;
}

/**
 * Admits the caller when they hold any of `codes` with some reach, and mints
 * the union-reach context. Deny by default: no reach → PERMISSION_DENIED.
 * Same gate as hris.routes.ts (kept local: that file is not shared surface).
 */
function requireHris(codes: readonly PermissionCode[]): RequestHandler {
  return async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const tenant = getTenantContext(req);
    let context: ScopedTenantContext | null = null;
    for (const code of codes) {
      context = snapshot.contextFor(code, { type: "tenant" });
      if (context) break;
    }
    if (!context && codes.some((code) => snapshot.permissions.includes(code))) {
      const userId = userIdSchema.parse(getAuth(req).user.id);
      const data = await loadTenantAccess(
        establishScopedTenantContext(tenant, { kind: "tenant" }),
        userId,
      );
      const outletIds = new Set<OutletId>();
      let tenantWide = false;
      for (const code of codes) {
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
        if (reach === null) continue;
        if (reach.kind === "tenant") tenantWide = true;
        else
          for (const id of reach.outletIds)
            outletIds.add(outletIdSchema.parse(id.toLowerCase()));
      }
      if (tenantWide)
        context = establishScopedTenantContext(tenant, { kind: "tenant" });
      else if (outletIds.size > 0)
        context = establishScopedTenantContext(tenant, {
          kind: "outlets",
          outletIds: [...outletIds],
        });
    }
    if (!context)
      throw new AccessError(
        "PERMISSION_DENIED",
        "Your account cannot perform this action in this tenant.",
      );
    contexts.set(req, context);
    res.setHeader("Cache-Control", "private, no-store");
    next();
  };
}

/** Employee PWA surface: session checks, no back-office MFA rule. */
function requireHrisSurface(): RequestHandler {
  return (req, res, next) => {
    const tenant = getTenantContext(req);
    return requireIdentitySurface("hris", {
      resolveAccessFacts: (input) =>
        loadSurfaceAccessFacts({ ...input, tenantId: tenant.tenantId }),
    })(req, res, next);
  };
}

/** Runs a middleware to completion, turning `next(err)` and rejections into a throw. */
function runMiddleware(
  handler: RequestHandler,
  req: Request,
  res: Response,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const next: NextFunction = (error?: unknown) =>
      error === undefined ? resolve() : reject(error);
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

/**
 * Back-office first (managers and HR keep the MFA rule); a caller who has no
 * back-office surface falls through to the employee PWA surface. Only
 * PERMISSION_DENIED falls through: MFA_REQUIRED and 401 still stop the request.
 */
function requireAnySurface(): RequestHandler {
  const backOffice = requireBackOfficeSurface();
  const employee = requireHrisSurface();
  return async (req, res, next) => {
    try {
      await runMiddleware(backOffice, req, res);
    } catch (error) {
      if (!(error instanceof AccessError && error.code === "PERMISSION_DENIED"))
        throw error;
      await runMiddleware(employee, req, res);
    }
    next();
  };
}

const SCHEDULE_MANAGE: PermissionCode[] = ["hr.schedule.manage"];
const SCHEDULE_READ_OR_SELF: PermissionCode[] = [
  "hr.schedule.manage",
  "self.schedule.view",
];
const SWAP_REQUEST: PermissionCode[] = ["self.shift_swap.request"];
const SWAP_DECIDE: PermissionCode[] = ["hr.shift_swap.approve"];
const SWAP_READ: PermissionCode[] = [
  "hr.schedule.manage",
  "hr.shift_swap.approve",
  "self.shift_swap.request",
];

export function createHrisSchedulingRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const backOffice = requireBackOfficeSurface();
  const anySurface = requireAnySurface();
  const actor = (req: Request) => getAuth(req).user.id;

  // ---- Shift templates ---------------------------------------------------

  router.get(
    "/shift-templates",
    backOffice,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const query = listShiftTemplatesEndpoint.query.parse(req.query);
      res.json(
        await setupService.listShiftTemplates(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/shift-templates",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const body = createShiftTemplateEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await setupService.createShiftTemplate(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/shift-templates/:templateId",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const { templateId } = updateShiftTemplateEndpoint.params.parse(
        req.params,
      );
      const body = updateShiftTemplateEndpoint.body.parse(req.body);
      res.json({
        data: await setupService.updateShiftTemplate(
          hrisContext(req),
          actor(req),
          templateId,
          body,
        ),
      });
    },
  );

  // ---- Compliance policy -------------------------------------------------

  router.get(
    "/shift-compliance-policy",
    backOffice,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const query = getShiftCompliancePolicyEndpoint.query.parse(req.query);
      res.json({
        data: await setupService.getShiftCompliancePolicy(
          hrisContext(req),
          actor(req),
          query,
        ),
      });
    },
  );

  router.put(
    "/shift-compliance-policy",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const body = updateShiftCompliancePolicyEndpoint.body.parse(req.body);
      res.json({
        data: await setupService.updateShiftCompliancePolicy(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  // ---- Shift assignments -------------------------------------------------

  router.get(
    "/shifts",
    anySurface,
    requireHris(SCHEDULE_READ_OR_SELF),
    async (req, res) => {
      const query = listShiftAssignmentsEndpoint.query.parse(req.query);
      res.json(
        await rosterService.listShiftAssignments(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/shifts",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const body = createShiftAssignmentEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await rosterService.createShiftAssignment(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/shifts/:assignmentId",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const { assignmentId } = updateShiftAssignmentEndpoint.params.parse(
        req.params,
      );
      const body = updateShiftAssignmentEndpoint.body.parse(req.body);
      res.json({
        data: await rosterService.updateShiftAssignment(
          hrisContext(req),
          actor(req),
          assignmentId,
          body,
        ),
      });
    },
  );

  router.post(
    "/shifts/:assignmentId/cancel",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const { assignmentId } = cancelShiftAssignmentEndpoint.params.parse(
        req.params,
      );
      cancelShiftAssignmentEndpoint.body.parse(req.body);
      res.json({
        data: await rosterService.cancelShiftAssignment(
          hrisContext(req),
          actor(req),
          assignmentId,
        ),
      });
    },
  );

  // ---- Roster ------------------------------------------------------------

  router.get(
    "/rosters",
    backOffice,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const query = getRosterEndpoint.query.parse(req.query);
      res.json({
        data: await rosterService.getRoster(
          hrisContext(req),
          actor(req),
          query,
        ),
      });
    },
  );

  router.post(
    "/rosters/copy",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const body = copyRosterWeekEndpoint.body.parse(req.body);
      res.json({
        data: await rosterService.copyRosterWeek(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/rosters/publish",
    backOffice,
    jsonBody,
    requireHris(SCHEDULE_MANAGE),
    async (req, res) => {
      const body = publishRosterEndpoint.body.parse(req.body);
      res.json({
        data: await rosterService.publishRoster(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  // ---- Shift swaps and covers -------------------------------------------

  router.get(
    "/shift-swaps",
    anySurface,
    requireHris(SWAP_READ),
    async (req, res) => {
      const query = listShiftSwapRequestsEndpoint.query.parse(req.query);
      res.json(
        await swapService.listShiftSwapRequests(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/shift-swaps",
    anySurface,
    jsonBody,
    requireHris(SWAP_REQUEST),
    async (req, res) => {
      const body = createShiftSwapRequestEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await swapService.createShiftSwapRequest(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.get(
    "/shift-swaps/candidates",
    anySurface,
    requireHris(SWAP_REQUEST),
    async (req, res) => {
      const query = listShiftSwapCandidatesEndpoint.query.parse(req.query);
      res.json(
        await swapService.listShiftSwapCandidates(
          hrisContext(req),
          actor(req),
          query.outletId,
          query.fromAssignmentId,
        ),
      );
    },
  );

  router.post(
    "/shift-swaps/:swapId/peer-response",
    anySurface,
    jsonBody,
    requireHris(SWAP_REQUEST),
    async (req, res) => {
      const { swapId } = respondShiftSwapRequestEndpoint.params.parse(
        req.params,
      );
      const body = respondShiftSwapRequestEndpoint.body.parse(req.body);
      res.json({
        data: await swapService.respondShiftSwapRequest(
          hrisContext(req),
          actor(req),
          swapId,
          body,
        ),
      });
    },
  );

  router.post(
    "/shift-swaps/:swapId/decision",
    backOffice,
    jsonBody,
    requireHris(SWAP_DECIDE),
    async (req, res) => {
      const { swapId } = decideShiftSwapRequestEndpoint.params.parse(
        req.params,
      );
      const body = decideShiftSwapRequestEndpoint.body.parse(req.body);
      res.json({
        data: await swapService.decideShiftSwapRequest(
          hrisContext(req),
          actor(req),
          swapId,
          body,
        ),
      });
    },
  );

  router.post(
    "/shift-swaps/:swapId/cancel",
    anySurface,
    jsonBody,
    requireHris(SWAP_REQUEST),
    async (req, res) => {
      const { swapId } = cancelShiftSwapRequestEndpoint.params.parse(
        req.params,
      );
      const body = cancelShiftSwapRequestEndpoint.body.parse(req.body);
      res.json({
        data: await swapService.cancelShiftSwapRequest(
          hrisContext(req),
          actor(req),
          swapId,
          body,
        ),
      });
    },
  );

  return router;
}

/** Mount at `/api/hris` (routes/index.ts, right after `hrisLeaveRouter`). */
export const hrisSchedulingRouter = createHrisSchedulingRouter();
