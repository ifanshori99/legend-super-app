// HRIS attendance administration routes (PRD v1.7 §3 F25, HR-02; bead
// legend-wh71): policy and sampling config, supervisor review queue and
// decision, duty meals. Paths, params, queries and bodies come from the WS-10
// contract (`@starter/shared/hris` defineEndpoint objects); mounted at
// `/api/hris`, so each handler path is the contract path without that prefix.
//
// Same gate model as hris-kpi.routes.ts: requireHris() only decides "may this
// caller use the route at all" and mints the narrowest context (TEN-03); the
// service re-checks outlet reach inside the tenant transaction. Everything
// here is back-office (AUTH-05, MFA when the role requires it).

import { Router, type Request, type RequestHandler } from "express";
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
  decideAttendanceReview as decideAttendanceReviewEndpoint,
  getAttendancePolicy as getAttendancePolicyEndpoint,
  listAttendanceDutyMeals as listAttendanceDutyMealsEndpoint,
  listAttendanceReviewQueue as listAttendanceReviewQueueEndpoint,
  recordAttendanceDutyMeal as recordAttendanceDutyMealEndpoint,
  updateAttendancePolicy as updateAttendancePolicyEndpoint,
} from "@starter/shared/hris";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import { loadTenantAccess } from "../services/permission-resolver.ts";
import * as adminService from "../services/hris-attendance-admin.service.ts";

const contexts = new WeakMap<Request, ScopedTenantContext>();

function hrisContext(req: Request): ScopedTenantContext {
  const context = contexts.get(req);
  if (!context) throw new Error("hrisContext() used without requireHris()");
  return context;
}

/**
 * Admits the caller when they hold any of `codes` with some reach, and mints
 * the union-reach context. Deny by default: no reach → PERMISSION_DENIED.
 * Same gate as hris-kpi.routes.ts (kept local: that file is not shared surface).
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

export type HrisAttendanceAdminRouterOptions = {
  /** Signs the private selfie of a review item; defaults to no photo URL. */
  readonly signPhoto?: adminService.AttendancePhotoSigner;
};

export function createHrisAttendanceAdminRouter(
  options: HrisAttendanceAdminRouterOptions = {},
): Router {
  const signPhoto = options.signPhoto ?? adminService.noAttendancePhotoSigner;
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const backOffice = requireBackOfficeSurface();
  const actor = (req: Request) => getAuth(req).user.id;

  router.get(
    "/attendance/policy",
    backOffice,
    requireHris(adminService.ATTENDANCE_MANAGE_CODES),
    async (req, res) => {
      const query = getAttendancePolicyEndpoint.query.parse(req.query);
      res.json(
        await adminService.getAttendancePolicy(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.put(
    "/attendance/policy",
    backOffice,
    jsonBody,
    requireHris(adminService.ATTENDANCE_MANAGE_CODES),
    async (req, res) => {
      const body = updateAttendancePolicyEndpoint.body.parse(req.body);
      res.json(
        await adminService.updateAttendancePolicy(
          hrisContext(req),
          actor(req),
          body,
        ),
      );
    },
  );

  router.get(
    "/attendance/review-queue",
    backOffice,
    requireHris(adminService.ATTENDANCE_SUPERVISOR_CODES),
    async (req, res) => {
      const query = listAttendanceReviewQueueEndpoint.query.parse(req.query);
      res.json(
        await adminService.listAttendanceReviewQueue(
          hrisContext(req),
          actor(req),
          query,
          signPhoto,
        ),
      );
    },
  );

  router.post(
    "/attendance/logs/:logId/review",
    backOffice,
    jsonBody,
    requireHris(adminService.ATTENDANCE_SUPERVISOR_CODES),
    async (req, res) => {
      const { logId } = decideAttendanceReviewEndpoint.params.parse(req.params);
      const body = decideAttendanceReviewEndpoint.body.parse(req.body);
      res.json(
        await adminService.decideAttendanceReview(
          hrisContext(req),
          actor(req),
          logId,
          body,
          signPhoto,
        ),
      );
    },
  );

  router.post(
    "/attendance/duty-meals",
    backOffice,
    jsonBody,
    requireHris(adminService.ATTENDANCE_SUPERVISOR_CODES),
    async (req, res) => {
      const body = recordAttendanceDutyMealEndpoint.body.parse(req.body);
      const { data, created } = await adminService.recordAttendanceDutyMeal(
        hrisContext(req),
        actor(req),
        body,
      );
      res.status(created ? 201 : 200).json({ data });
    },
  );

  router.get(
    "/attendance/duty-meals",
    backOffice,
    requireHris(adminService.ATTENDANCE_SUPERVISOR_CODES),
    async (req, res) => {
      const query = listAttendanceDutyMealsEndpoint.query.parse(req.query);
      res.json(
        await adminService.listAttendanceDutyMeals(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  return router;
}

/** Mount at `/api/hris` (routes/index.ts). */
export const hrisAttendanceAdminRouter = createHrisAttendanceAdminRouter();
