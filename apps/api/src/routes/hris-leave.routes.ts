// HRIS leave, balances, accrual, carry-over, holidays and overtime routes
// (PRD v1.7 §3 F29 "Cuti, Izin & Lembur"; bead legend-hggk). Paths, params,
// queries and bodies come from the WS-10 contract (`@starter/shared/hris`
// defineEndpoint objects); mounted at `/api/hris` next to hrisRouter, so each
// handler path is the contract path without that prefix. The paths here never
// overlap hrisRouter's.
//
// Same gate model as hris.routes.ts: requireHris() only decides "may this
// caller use the route at all" and mints the narrowest context (TEN-03); the
// services re-check ownership, outlet reach and the per-action permission
// inside the tenant transaction. HR admin routes run behind the back-office
// surface (AUTH-05, MFA when the role requires it). Routes an employee uses on
// the PWA (request leave/overtime, read own balances, holidays, cancel) accept
// either surface: back office first, the `hris` employee surface otherwise.
//
// Decision routes derive `mfaVerified` from the session like the approval
// inbox does (`sessionMfaVerifiedAt`); the services apply the same rules as
// `/api/approvals/:id/decisions`.

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import multer from "multer";
import type { ObjectStorage } from "@starter/shared/adapters";
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
  createHoliday as createHolidayEndpoint,
  createLeaveRequest as createLeaveRequestEndpoint,
  createLeaveType as createLeaveTypeEndpoint,
  createOvertimeFormula as createOvertimeFormulaEndpoint,
  createOvertimeRequest as createOvertimeRequestEndpoint,
  decideLeaveRequest as decideLeaveRequestEndpoint,
  decideOvertimeRequest as decideOvertimeRequestEndpoint,
  deleteHoliday as deleteHolidayEndpoint,
  expireLeaveCarryOver as expireLeaveCarryOverEndpoint,
  listHolidays as listHolidaysEndpoint,
  listLeaveBalances as listLeaveBalancesEndpoint,
  listLeaveRequests as listLeaveRequestsEndpoint,
  listLeaveTypes as listLeaveTypesEndpoint,
  listOvertimeFormulas as listOvertimeFormulasEndpoint,
  listOvertimeRequests as listOvertimeRequestsEndpoint,
  publishOvertimeFormula as publishOvertimeFormulaEndpoint,
  runLeaveAccrual as runLeaveAccrualEndpoint,
  runLeaveCarryOver as runLeaveCarryOverEndpoint,
  updateHoliday as updateHolidayEndpoint,
  updateLeaveSettings as updateLeaveSettingsEndpoint,
  updateLeaveType as updateLeaveTypeEndpoint,
  uploadLeaveAttachment as uploadLeaveAttachmentEndpoint,
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
import { sessionMfaVerifiedAt } from "../lib/mfa.ts";
import { loadTenantAccess } from "../services/permission-resolver.ts";
import { loadSurfaceAccessFacts } from "../services/surface-access.service.ts";
import {
  noHrisFileSigner,
  type HrisFileSigner,
} from "../services/hris-contract.service.ts";
import * as holidayService from "../services/hris-holiday.service.ts";
import * as collectiveService from "../services/hris-leave-collective.service.ts";
import * as leaveService from "../services/hris-leave.service.ts";
import * as leaveRequestService from "../services/hris-leave-request.service.ts";
import { uploadLeaveAttachment } from "../services/hris-leave-attachment.service.ts";
import type { MalwareScanner } from "../services/core-image.ts";
import { HttpError } from "../lib/http-error.ts";
import * as overtimeService from "../services/hris-overtime.service.ts";

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

const READ: PermissionCode[] = [
  "hr.employee.view",
  "hr.employee.manage",
  "payroll.view",
];
const MANAGE: PermissionCode[] = ["hr.employee.manage"];
const LEAVE_READ_OR_SELF: PermissionCode[] = [
  ...READ,
  "hr.leave.approve",
  "self.leave.request",
];
const LEAVE_DECIDE: PermissionCode[] = [
  "hr.leave.approve",
  "hr.employee.manage",
  "self.leave.request",
];
// No dedicated `self.overtime.*` code exists: any employee with a profile (or
// the clock-in PWA) may file overtime for their own row; the service enforces
// own-employee.
const OVERTIME_READ_OR_SELF: PermissionCode[] = [
  ...READ,
  "hr.overtime.approve",
  "self.profile.view",
  "self.attendance.clock",
];
const OVERTIME_DECIDE: PermissionCode[] = [
  "hr.overtime.approve",
  "hr.employee.manage",
  "self.profile.view",
  "self.attendance.clock",
];
const HOLIDAY_READ: PermissionCode[] = [
  ...READ,
  "hr.leave.approve",
  "hr.overtime.approve",
  "self.profile.view",
  "self.leave.request",
];

export type HrisLeaveRouterDeps = {
  /** Private-bucket URL signer (core-storage); default mints no URL. */
  readonly fileSigner?: HrisFileSigner;
  readonly storage?: ObjectStorage | null;
  readonly scanner?: MalwareScanner | null;
};

export function createHrisLeaveRouter(deps: HrisLeaveRouterDeps = {}): Router {
  const signer = deps.fileSigner ?? noHrisFileSigner;
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const backOffice = requireBackOfficeSurface();
  const anySurface = requireAnySurface();
  const actor = (req: Request) => getAuth(req).user.id;
  const mfa = async (req: Request) => ({
    mfaVerified: (await sessionMfaVerifiedAt(req)) !== null,
  });

  // ---- Leave types -------------------------------------------------------

  const multipart = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  }).single("file");
  const parseAttachment: RequestHandler = (req, res, next) => {
    if (!req.is("multipart/form-data"))
      return next(
        new HttpError(
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Send multipart form data.",
        ),
      );
    multipart(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError)
        return next(
          new HttpError(
            error.code === "LIMIT_FILE_SIZE" ? 413 : 422,
            error.code === "LIMIT_FILE_SIZE"
              ? "PAYLOAD_TOO_LARGE"
              : "VALIDATION_ERROR",
            "Invalid upload.",
          ),
        );
      if (error)
        return next(
          new HttpError(422, "VALIDATION_ERROR", "Invalid multipart upload."),
        );
      next();
    });
  };
  router.post(
    uploadLeaveAttachmentEndpoint.path.replace(/^\/api\/hris/, ""),
    anySurface,
    requireHris(["self.leave.request"]),
    (req, _res, next) => {
      if (!deps.storage || !deps.scanner)
        return next(
          new HttpError(503, "SERVICE_UNAVAILABLE", "Upload unavailable."),
        );
      next();
    },
    parseAttachment,
    async (req, res) => {
      if (!req.file)
        throw new HttpError(422, "VALIDATION_ERROR", "A file is required.");
      const data = await uploadLeaveAttachment(
        hrisContext(req),
        actor(req),
        req.file.buffer,
        { storage: deps.storage!, scanner: deps.scanner! },
      );
      res.status(201).json({ data });
    },
  );

  router.get(
    "/leave/types",
    anySurface,
    requireHris(LEAVE_READ_OR_SELF),
    async (req, res) => {
      const query = listLeaveTypesEndpoint.query.parse(req.query);
      res.json(
        await leaveService.listLeaveTypes(hrisContext(req), actor(req), query),
      );
    },
  );

  router.post(
    "/leave/types",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createLeaveTypeEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await leaveService.createLeaveType(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/leave/types/:leaveTypeId",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { leaveTypeId } = updateLeaveTypeEndpoint.params.parse(req.params);
      const body = updateLeaveTypeEndpoint.body.parse(req.body);
      res.json({
        data: await leaveService.updateLeaveType(
          hrisContext(req),
          actor(req),
          leaveTypeId,
          body,
        ),
      });
    },
  );

  // ---- Balances, accrual, carry-over ------------------------------------

  router.get(
    "/leave/balances",
    anySurface,
    requireHris(LEAVE_READ_OR_SELF),
    async (req, res) => {
      const query = listLeaveBalancesEndpoint.query.parse(req.query);
      res.json(
        await leaveService.listLeaveBalances(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/leave/accruals/run",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = runLeaveAccrualEndpoint.body.parse(req.body);
      res.json({
        data: await leaveService.runLeaveAccrual(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/leave/carry-over/run",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = runLeaveCarryOverEndpoint.body.parse(req.body);
      res.json({
        data: await leaveService.runLeaveCarryOver(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/leave/carry-over/expire",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = expireLeaveCarryOverEndpoint.body.parse(req.body);
      res.json({
        data: await leaveService.expireLeaveCarryOver(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  // ---- Leave settings (collective leave, founder decision Q7) ------------

  router.get(
    "/leave/settings",
    backOffice,
    requireHris(MANAGE),
    async (req, res) => {
      res.json({
        data: await collectiveService.getLeaveSettings(
          hrisContext(req),
          actor(req),
        ),
      });
    },
  );

  router.put(
    "/leave/settings",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = updateLeaveSettingsEndpoint.body.parse(req.body);
      res.json({
        data: await collectiveService.updateLeaveSettings(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  // ---- Leave requests ----------------------------------------------------

  router.get(
    "/leave/requests",
    anySurface,
    requireHris(LEAVE_READ_OR_SELF),
    async (req, res) => {
      const query = listLeaveRequestsEndpoint.query.parse(req.query);
      res.json(
        await leaveRequestService.listLeaveRequests(
          hrisContext(req),
          actor(req),
          query,
          signer,
        ),
      );
    },
  );

  router.post(
    "/leave/requests",
    anySurface,
    jsonBody,
    requireHris(["self.leave.request"]),
    async (req, res) => {
      const body = createLeaveRequestEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await leaveRequestService.createLeaveRequest(
          hrisContext(req),
          actor(req),
          body,
          new Date(),
          signer,
        ),
      });
    },
  );

  router.post(
    "/leave/requests/:leaveRequestId/decision",
    anySurface,
    jsonBody,
    requireHris(LEAVE_DECIDE),
    async (req, res) => {
      const { leaveRequestId } = decideLeaveRequestEndpoint.params.parse(
        req.params,
      );
      const body = decideLeaveRequestEndpoint.body.parse(req.body);
      res.json({
        data: await leaveRequestService.decideLeaveRequest(
          hrisContext(req),
          actor(req),
          leaveRequestId,
          body,
          await mfa(req),
          new Date(),
          signer,
        ),
      });
    },
  );

  // ---- Holidays ----------------------------------------------------------

  router.get(
    "/holidays",
    anySurface,
    requireHris(HOLIDAY_READ),
    async (req, res) => {
      const query = listHolidaysEndpoint.query.parse(req.query);
      res.json(
        await holidayService.listHolidays(hrisContext(req), actor(req), query),
      );
    },
  );

  router.post(
    "/holidays",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createHolidayEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await holidayService.createHoliday(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.patch(
    "/holidays/:holidayId",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { holidayId } = updateHolidayEndpoint.params.parse(req.params);
      const body = updateHolidayEndpoint.body.parse(req.body);
      res.json({
        data: await holidayService.updateHoliday(
          hrisContext(req),
          actor(req),
          holidayId,
          body,
        ),
      });
    },
  );

  router.delete(
    "/holidays/:holidayId",
    backOffice,
    requireHris(MANAGE),
    async (req, res) => {
      const { holidayId } = deleteHolidayEndpoint.params.parse(req.params);
      await holidayService.deleteHoliday(
        hrisContext(req),
        actor(req),
        holidayId,
      );
      res.json({ data: { id: holidayId } });
    },
  );

  // ---- Overtime ----------------------------------------------------------

  router.get(
    "/overtime-requests",
    anySurface,
    requireHris(OVERTIME_READ_OR_SELF),
    async (req, res) => {
      const query = listOvertimeRequestsEndpoint.query.parse(req.query);
      res.json(
        await overtimeService.listOvertimeRequests(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/overtime-requests",
    anySurface,
    jsonBody,
    requireHris([
      "hr.employee.manage",
      "self.profile.view",
      "self.attendance.clock",
    ]),
    async (req, res) => {
      const body = createOvertimeRequestEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await overtimeService.createOvertimeRequest(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/overtime-requests/:overtimeRequestId/decision",
    anySurface,
    jsonBody,
    requireHris(OVERTIME_DECIDE),
    async (req, res) => {
      const { overtimeRequestId } = decideOvertimeRequestEndpoint.params.parse(
        req.params,
      );
      const body = decideOvertimeRequestEndpoint.body.parse(req.body);
      res.json({
        data: await overtimeService.decideOvertimeRequest(
          hrisContext(req),
          actor(req),
          overtimeRequestId,
          body,
          await mfa(req),
        ),
      });
    },
  );

  // ---- Overtime formulas ("rumus lembur") --------------------------------

  router.get(
    "/overtime-formulas",
    backOffice,
    requireHris([...READ, "hr.overtime.approve"]),
    async (req, res) => {
      const query = listOvertimeFormulasEndpoint.query.parse(req.query);
      res.json(
        await overtimeService.listOvertimeFormulas(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/overtime-formulas",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createOvertimeFormulaEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await overtimeService.createOvertimeFormula(
          hrisContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/overtime-formulas/:overtimeFormulaId/publish",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { overtimeFormulaId } = publishOvertimeFormulaEndpoint.params.parse(
        req.params,
      );
      res.json({
        data: await overtimeService.publishOvertimeFormula(
          hrisContext(req),
          actor(req),
          overtimeFormulaId,
          publishOvertimeFormulaEndpoint.body.parse(req.body),
        ),
      });
    },
  );

  return router;
}

/** Signer-less instance (tests). createApp mounts `createHrisLeaveRouter`
 * with the storage signer in routes/storage-api.routes.ts (legend-2ect). */
export const hrisLeaveRouter = createHrisLeaveRouter();
