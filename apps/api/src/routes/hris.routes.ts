// HRIS master-data routes (PRD v1.7 §3 F26; HR-01, HR-03, HR-04; bead
// legend-qe1z). Paths, params, queries and bodies come from the WS-10
// contract (`@starter/shared/hris` defineEndpoint objects); this router is
// mounted at `/api/hris`, so each handler path is the contract path without
// that prefix.
//
// Tenant comes from the server-minted context (TEN-02). The gate below only
// decides "may this caller use the route at all" and mints the narrowest
// context that covers it: tenant-wide if any accepted code is held
// tenant-wide, otherwise the union of the outlets those codes reach (TEN-03).
// The services re-check every record inside the tenant transaction (HR-01:
// someone else's row answers 404; HR-03: PII visibility per viewer).
//
// AUTH-05: back-office routes run behind requireBackOfficeSurface (MFA when
// the caller's role requires it). `/me` is the employee PWA (`hris` surface):
// it gets the session checks without the back-office MFA rule.

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
  createEmployee as createEmployeeEndpoint,
  createEmployeeDocument as createEmployeeDocumentEndpoint,
  createEmploymentContract as createEmploymentContractEndpoint,
  createOrgUnit as createOrgUnitEndpoint,
  createPositionGrade as createPositionGradeEndpoint,
  createPosition as createPositionEndpoint,
  getEmployee as getEmployeeEndpoint,
  getEmployeePii as getEmployeePiiEndpoint,
  getEmploymentContract as getEmploymentContractEndpoint,
  listEmployeeDocuments as listEmployeeDocumentsEndpoint,
  listEmployees as listEmployeesEndpoint,
  listEmploymentContracts as listEmploymentContractsEndpoint,
  listOrgUnits as listOrgUnitsEndpoint,
  listPositionGrades as listPositionGradesEndpoint,
  listPositions as listPositionsEndpoint,
  updateEmployeePii as updateEmployeePiiEndpoint,
  changeEmployeeManagerEndpoint,
  setEmployeeLegalEntityEndpoint,
} from "@starter/shared/hris";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireIdentitySurface } from "../middleware/identity.ts";
import { requireBackOfficeSurface } from "../middleware/identity-surface.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import { supportSessionOf } from "../middleware/support-session.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import { loadTenantAccess } from "../services/permission-resolver.ts";
import { loadSurfaceAccessFacts } from "../services/surface-access.service.ts";
import * as employeesService from "../services/hris-employee.service.ts";
import { changeEmployeeManager } from "../services/hris-employee-manager.service.ts";
import { setEmployeeLegalEntity } from "../services/hris-employee-legal-entity.service.ts";
import * as attendanceService from "../services/hris-attendance.service.ts";
import * as orgService from "../services/hris-org.service.ts";
import {
  createEmployeeDocument,
  createEmploymentContract,
  getEmploymentContract,
  listEmployeeDocuments,
  listEmploymentContracts,
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

const READ: PermissionCode[] = [
  "hr.employee.view",
  "hr.employee.manage",
  "payroll.view",
];
const READ_OR_SELF: PermissionCode[] = [...READ, "self.profile.view"];
const MANAGE: PermissionCode[] = ["hr.employee.manage"];
// The service decides who may change a manager: HR, or a brand-scoped GM.
const MANAGER_CHANGE: PermissionCode[] = [
  "hr.employee.manage",
  "hr.attendance.manage",
];

export type HrisRouterDeps = {
  /** Private-bucket URL signer (core-storage); default mints no URL. */
  readonly fileSigner?: HrisFileSigner;
};

export function createHrisRouter(deps: HrisRouterDeps = {}): Router {
  const signer = deps.fileSigner ?? noHrisFileSigner;
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

  const backOffice = requireBackOfficeSurface();
  const actor = (req: Request) => getAuth(req).user.id;

  // HR-01: the caller's own row; no employee id in the request.
  router.get(
    "/me",
    requireHrisSurface(),
    requireHris(["self.profile.view"]),
    async (req, res) => {
      res.json({
        data: await employeesService.getMyHrisProfile(
          hrisContext(req),
          actor(req),
        ),
      });
    },
  );

  // F25: the caller's outlet attendance policy for the clock-in screen.
  router.get(
    "/me/attendance-policy",
    requireHrisSurface(),
    requireHris(["self.attendance.clock"]),
    async (req, res) => {
      res.json({
        data: await attendanceService.getMyAttendancePolicy(
          hrisContext(req),
          actor(req),
        ),
      });
    },
  );

  router.post(
    "/employees",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createEmployeeEndpoint.body.parse(req.body);
      const data = await employeesService.createEmployee(
        hrisContext(req),
        actor(req),
        body,
      );
      res.location(`/api/hris/employees/${data.id}`).status(201).json({ data });
    },
  );

  router.post(
    "/org-units",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createOrgUnitEndpoint.body.parse(req.body);
      const data = await orgService.createOrgUnit(
        hrisContext(req),
        actor(req),
        body,
      );
      res.status(201).json({ data });
    },
  );

  router.post(
    "/position-grades",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createPositionGradeEndpoint.body.parse(req.body);
      const data = await orgService.createPositionGrade(
        hrisContext(req),
        actor(req),
        body,
      );
      res.status(201).json({ data });
    },
  );

  router.post(
    "/positions",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createPositionEndpoint.body.parse(req.body);
      const data = await orgService.createPosition(
        hrisContext(req),
        actor(req),
        body,
      );
      res.status(201).json({ data });
    },
  );

  router.post(
    "/employment-contracts",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const body = createEmploymentContractEndpoint.body.parse(req.body);
      const data = await createEmploymentContract(
        hrisContext(req),
        actor(req),
        body,
      );
      res
        .location(`/api/hris/employment-contracts/${data.id}`)
        .status(201)
        .json({ data });
    },
  );

  router.post(
    "/employees/:employeeId/documents",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { employeeId } = createEmployeeDocumentEndpoint.params.parse(
        req.params,
      );
      const body = createEmployeeDocumentEndpoint.body.parse(req.body);
      const data = await createEmployeeDocument(hrisContext(req), actor(req), {
        ...body,
        employeeId,
      });
      res.status(201).json({ data });
    },
  );

  router.get("/employees", backOffice, requireHris(READ), async (req, res) => {
    const query = listEmployeesEndpoint.query.parse(req.query);
    res.json(
      await employeesService.listEmployees(hrisContext(req), actor(req), query),
    );
  });

  router.get(
    "/employees/:employeeId",
    backOffice,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const { employeeId } = getEmployeeEndpoint.params.parse(req.params);
      const employee = await employeesService.getEmployee(
        hrisContext(req),
        actor(req),
        employeeId,
      );
      const support = await supportSessionOf(req);
      res.json({
        data: {
          ...employee,
          canChangeManager:
            employee.canChangeManager && support?.accessMode !== "read_only",
        },
      });
    },
  );

  // HR-03: the only route that returns (masked) PII.
  router.get(
    "/employees/:employeeId/pii",
    backOffice,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const { employeeId } = getEmployeePiiEndpoint.params.parse(req.params);
      res.json({
        data: await employeesService.getEmployeePii(
          hrisContext(req),
          actor(req),
          employeeId,
        ),
      });
    },
  );

  router.patch(
    "/employees/:employeeId/manager",
    backOffice,
    jsonBody,
    requireHris(MANAGER_CHANGE),
    async (req, res) => {
      const { employeeId } = changeEmployeeManagerEndpoint.params.parse(
        req.params,
      );
      const body = changeEmployeeManagerEndpoint.body.parse(req.body);
      res.json({
        data: await changeEmployeeManager(
          hrisContext(req),
          actor(req),
          employeeId,
          body,
        ),
      });
    },
  );

  router.put(
    "/employees/:employeeId/legal-entity",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { employeeId } = setEmployeeLegalEntityEndpoint.params.parse(
        req.params,
      );
      const body = setEmployeeLegalEntityEndpoint.body.parse(req.body);
      res.json({
        data: await setEmployeeLegalEntity(
          hrisContext(req),
          actor(req),
          employeeId,
          body,
        ),
      });
    },
  );

  router.put(
    "/employees/:employeeId/pii",
    backOffice,
    jsonBody,
    requireHris(MANAGE),
    async (req, res) => {
      const { employeeId } = updateEmployeePiiEndpoint.params.parse(req.params);
      const body = updateEmployeePiiEndpoint.body.parse(req.body);
      res.json({
        data: await employeesService.updateEmployeePii(
          hrisContext(req),
          actor(req),
          employeeId,
          body,
        ),
      });
    },
  );

  router.get(
    "/employees/:employeeId/documents",
    backOffice,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const { employeeId } = listEmployeeDocumentsEndpoint.params!.parse(
        req.params,
      );
      const query = listEmployeeDocumentsEndpoint.query.parse(req.query);
      res.json(
        await listEmployeeDocuments(
          hrisContext(req),
          actor(req),
          employeeId,
          query,
          signer,
        ),
      );
    },
  );

  router.get("/org-units", backOffice, requireHris(READ), async (req, res) => {
    const query = listOrgUnitsEndpoint.query.parse(req.query);
    res.json(
      await orgService.listOrgUnits(hrisContext(req), actor(req), query),
    );
  });

  router.get(
    "/position-grades",
    backOffice,
    requireHris(READ),
    async (req, res) => {
      const query = listPositionGradesEndpoint.query.parse(req.query);
      res.json(
        await orgService.listPositionGrades(
          hrisContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.get("/positions", backOffice, requireHris(READ), async (req, res) => {
    const query = listPositionsEndpoint.query.parse(req.query);
    res.json(
      await orgService.listPositions(hrisContext(req), actor(req), query),
    );
  });

  router.get(
    "/employment-contracts",
    backOffice,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const query = listEmploymentContractsEndpoint.query.parse(req.query);
      res.json(
        await listEmploymentContracts(
          hrisContext(req),
          actor(req),
          query,
          signer,
        ),
      );
    },
  );

  router.get(
    "/employment-contracts/:contractId",
    backOffice,
    requireHris(READ_OR_SELF),
    async (req, res) => {
      const { contractId } = getEmploymentContractEndpoint.params.parse(
        req.params,
      );
      res.json({
        data: await getEmploymentContract(
          hrisContext(req),
          actor(req),
          contractId,
          signer,
        ),
      });
    },
  );

  return router;
}

/** Signer-less instance (tests). createApp mounts `createHrisRouter` with the
 * storage signer in routes/storage-api.routes.ts (legend-2ect). */
export const hrisRouter = createHrisRouter();
