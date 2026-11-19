// HRIS KPI routes (PRD v1.7 §3 F29 "KPI per jabatan"; bead legend-ovxw):
// definitions, review cycle, system actuals and submit. Paths, params, queries
// and bodies come from the WS-10 contract (`@starter/shared/hris`
// defineEndpoint objects); mounted at `/api/hris`, so each handler path is the
// contract path without that prefix. The paths here never overlap the other
// HRIS routers.
//
// Same gate model as hris-scheduling.routes.ts: requireHris() only decides
// "may this caller use the route at all" and mints the narrowest context
// (TEN-03); the service re-checks outlet reach and the per-record rule inside
// the tenant transaction. Writes run behind the back-office surface (AUTH-05,
// MFA when the role requires it). Reading reviews accepts either surface: an
// employee reads their own submitted reviews on the `hris` PWA surface.

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
  createKpiDefinition as createKpiDefinitionEndpoint,
  createKpiReview as createKpiReviewEndpoint,
  listKpiDefinitions as listKpiDefinitionsEndpoint,
  listKpiReviews as listKpiReviewsEndpoint,
  refreshKpiActuals as refreshKpiActualsEndpoint,
  submitKpiReview as submitKpiReviewEndpoint,
  updateKpiDefinition as updateKpiDefinitionEndpoint,
  updateKpiScores as updateKpiScoresEndpoint,
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
import * as kpiService from "../services/hris-kpi.service.ts";

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

const KPI_MANAGE: PermissionCode[] = ["hr.kpi.manage"];
const KPI_READ: PermissionCode[] = [
  "hr.kpi.manage",
  "hr.employee.view",
  "hr.employee.manage",
  "payroll.view",
];
const KPI_READ_OR_SELF: PermissionCode[] = [...KPI_READ, "self.profile.view"];

export function createHrisKpiRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const backOffice = requireBackOfficeSurface();
  const anySurface = requireAnySurface();
  const actor = (req: Request) => getAuth(req).user.id;

  router.get(
    "/kpi-definitions",
    backOffice,
    requireHris(KPI_READ),
    async (req, res) => {
      const query = listKpiDefinitionsEndpoint.query.parse(req.query);
      res.json(
        await kpiService.listKpiDefinitions(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/kpi-definitions",
    backOffice,
    jsonBody,
    requireHris(KPI_MANAGE),
    async (req, res) => {
      const body = createKpiDefinitionEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await kpiService.createKpiDefinition(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/kpi-definitions/:kpiDefinitionId",
    backOffice,
    jsonBody,
    requireHris(KPI_MANAGE),
    async (req, res) => {
      const { kpiDefinitionId } = updateKpiDefinitionEndpoint.params.parse(
        req.params,
      );
      const body = updateKpiDefinitionEndpoint.body.parse(req.body);
      res.json({
        data: await kpiService.updateKpiDefinition(
          hrisContext(req),
          actor(req),
          kpiDefinitionId,
          body,
        ),
      });
    },
  );

  router.get(
    "/kpi-reviews",
    anySurface,
    requireHris(KPI_READ_OR_SELF),
    async (req, res) => {
      const query = listKpiReviewsEndpoint.query.parse(req.query);
      res.json(
        await kpiService.listKpiReviews(hrisContext(req), actor(req), query),
      );
    },
  );

  router.post(
    "/kpi-reviews",
    backOffice,
    jsonBody,
    requireHris(KPI_MANAGE),
    async (req, res) => {
      const body = createKpiReviewEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await kpiService.createKpiReview(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/kpi-reviews/:reviewId/scores",
    backOffice,
    jsonBody,
    requireHris(KPI_MANAGE),
    async (req, res) => {
      const { reviewId } = updateKpiScoresEndpoint.params.parse(req.params);
      const body = updateKpiScoresEndpoint.body.parse(req.body);
      res.json({
        data: await kpiService.updateKpiScores(
          hrisContext(req),
          actor(req),
          reviewId,
          body,
        ),
      });
    },
  );

  router.post(
    "/kpi-reviews/:reviewId/refresh-actuals",
    backOffice,
    jsonBody,
    requireHris(KPI_MANAGE),
    async (req, res) => {
      const { reviewId } = refreshKpiActualsEndpoint.params.parse(req.params);
      refreshKpiActualsEndpoint.body.parse(req.body ?? {});
      res.json({
        data: await kpiService.refreshKpiActuals(
          hrisContext(req),
          actor(req),
          reviewId,
        ),
      });
    },
  );

  router.post(
    "/kpi-reviews/:reviewId/submit",
    backOffice,
    jsonBody,
    requireHris(KPI_MANAGE),
    async (req, res) => {
      const { reviewId } = submitKpiReviewEndpoint.params.parse(req.params);
      submitKpiReviewEndpoint.body.parse(req.body ?? {});
      res.json({
        data: await kpiService.submitKpiReview(
          hrisContext(req),
          actor(req),
          reviewId,
        ),
      });
    },
  );

  return router;
}

/** Mount at `/api/hris` (routes/index.ts). */
export const hrisKpiRouter = createHrisKpiRouter();
