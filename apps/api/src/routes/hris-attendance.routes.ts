// HRIS attendance routes (PRD v1.7 §3 Kelompok D 27 "Absensi", F25, HR-02;
// bead legend-wh71): clock, logs, outlet QR (get / rotate) and device binding.
// Paths, params, queries and bodies come from the WS-10 contract
// (`@starter/shared/hris` defineEndpoint objects); mounted at `/api/hris`, so
// each handler path is the contract path without that prefix. Policy, review
// and duty meals live in hris-attendance-admin.routes.ts, corrections in
// hris-attendance-correction.routes.ts.
//
// Same gate model as hris-kpi.routes.ts: requireHris() only decides "may this
// caller use the route at all" and mints the narrowest context (TEN-03); the
// service re-checks outlet reach and the per-record rule inside the tenant
// transaction. Employee routes (clock, bind, own logs) accept either surface;
// QR, rotation and HR device reset run behind the back-office surface.

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
  apiErrorBody,
  outletIdSchema,
  userIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  bindAttendanceDevice as bindAttendanceDeviceEndpoint,
  clockAttendance as clockAttendanceEndpoint,
  getAttendanceQr as getAttendanceQrEndpoint,
  listAttendanceDevices as listAttendanceDevicesEndpoint,
  listAttendanceLogs as listAttendanceLogsEndpoint,
  revokeAttendanceDevice as revokeAttendanceDeviceEndpoint,
  rotateAttendanceQrSecret as rotateAttendanceQrSecretEndpoint,
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
import * as attendanceService from "../services/hris-attendance.service.ts";
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "../services/hris-contract.service.ts";

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
          now: new Date(),
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

const CLOCK: PermissionCode[] = ["self.attendance.clock"];
const MANAGE: PermissionCode[] = ["hr.attendance.manage"];
const READ_OR_SELF: PermissionCode[] = [...MANAGE, ...CLOCK];

export type HrisAttendanceRouterDeps = {
  /** Private-bucket URL signer (core-storage); default mints no URL. */
  readonly fileSigner?: HrisFileSigner;
};

export function createHrisAttendanceRouter(
  deps: HrisAttendanceRouterDeps = {},
): Router {
  const signer = deps.fileSigner ?? noHrisFileSigner;
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const backOffice = requireBackOfficeSurface();
  const anySurface = requireAnySurface();
  const actor = (req: Request) => getAuth(req).user.id;

  router.post(
    "/attendance/clock",
    anySurface,
    jsonBody,
    requireHris(CLOCK),
    async (req, res) => {
      const body = clockAttendanceEndpoint.body.parse(req.body);
      const result = await attendanceService.clockAttendance(
        hrisContext(req),
        actor(req),
        body,
        new Date(),
        signer,
      );
      // A rejected attempt is stored for HR but is not a clock event: 422 with
      // the reasons, never a log the employee could mistake for a valid one.
      if (result.log.validity === "rejected") {
        res.status(422).json(
          apiErrorBody("ATTENDANCE_REJECTED", "Absensi ditolak.", {
            details: result.flagReasons.map((reason) => ({
              field: "reasons",
              message: reason,
            })),
          }),
        );
        return;
      }
      res.status(201).json({ data: result.log });
    },
  );

  router.get(
    "/attendance/logs",
    anySurface,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const query = listAttendanceLogsEndpoint.query.parse(req.query);
      res.json(
        await attendanceService.listAttendanceLogs(
          hrisContext(req),
          actor(req),
          query,
          new Date(),
          signer,
        ),
      );
    },
  );

  router.get(
    "/attendance/qr",
    backOffice,
    requireHris(MANAGE),
    async (req, res) => {
      const query = getAttendanceQrEndpoint.query.parse(req.query);
      res.json({
        data: await attendanceService.getAttendanceQr(
          hrisContext(req),
          actor(req),
          query,
        ),
      });
    },
  );

  router.post(
    "/attendance/qr/rotate",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = rotateAttendanceQrSecretEndpoint.body.parse(req.body);
      res.json({
        data: await attendanceService.rotateAttendanceQrSecret(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/attendance/devices/bind",
    anySurface,
    jsonBody,
    requireHris(CLOCK),
    async (req, res) => {
      const body = bindAttendanceDeviceEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await attendanceService.bindAttendanceDevice(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.get(
    "/attendance/devices",
    anySurface,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const query = listAttendanceDevicesEndpoint.query.parse(req.query);
      res.json(
        await attendanceService.listAttendanceDevices(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/attendance/devices/:deviceId/revoke",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { deviceId } = revokeAttendanceDeviceEndpoint.params.parse(
        req.params,
      );
      const body = revokeAttendanceDeviceEndpoint.body.parse(req.body);
      res.json({
        data: await attendanceService.revokeAttendanceDevice(
          hrisContext(req),
          actor(req),
          deviceId,
          body,
        ),
      });
    },
  );

  return router;
}

/** Mount at `/api/hris` (routes/index.ts). */
export const hrisAttendanceRouter = createHrisAttendanceRouter();
