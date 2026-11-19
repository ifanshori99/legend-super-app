// HRIS offboarding routes (PRD v1.7 F24 "Offboarding"; bead legend-ovxw):
// start, edit, cancel, exit clearance (revoke access), complete, and the final
// settlement summary. Contract: `@starter/shared/hris` endpoints; mounted at
// `/api/hris`, so each handler path drops that prefix.
//
// Back office only (MFA when the role requires it). The gate admits a caller
// holding the code with some reach; the services re-check the employee's home
// outlet inside the tenant transaction and answer 404 for a record outside
// the caller's reach.

import { Router } from "express";
import type { PermissionCode } from "@starter/shared/access";
import {
  cancelOffboarding as cancelOffboardingEndpoint,
  completeOffboarding as completeOffboardingEndpoint,
  createOffboarding as createOffboardingEndpoint,
  getOffboarding as getOffboardingEndpoint,
  getOffboardingSettlement as getOffboardingSettlementEndpoint,
  revokeOffboardingAccess as revokeOffboardingAccessEndpoint,
  updateOffboarding as updateOffboardingEndpoint,
} from "@starter/shared/hris";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as offboardingService from "../services/hris-offboarding.service.ts";
import * as settlementService from "../services/hris-settlement.service.ts";
import {
  hrisLearningActor,
  hrisLearningContext,
  requireBackOfficeSurface,
  requireHrisLearning,
} from "./hris-sop-gate.ts";

const MANAGE: PermissionCode[] = ["hr.employee.manage"];
const MANAGE_OR_PAYROLL: PermissionCode[] = [
  "hr.employee.manage",
  "payroll.view",
];

export function createHrisOffboardingRouter(): Router {
  const router = Router();
  const common = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    requireBackOfficeSurface(),
  ];

  router.post(
    "/employees/:employeeId/offboarding",
    ...common,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { employeeId } = createOffboardingEndpoint.params.parse(req.params);
      const body = createOffboardingEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await offboardingService.createOffboarding(
          hrisLearningContext(req),
          hrisLearningActor(req),
          employeeId,
          body,
        ),
      });
    },
  );

  router.get(
    "/offboardings/:offboardingId",
    ...common,
    requireHrisLearning(MANAGE_OR_PAYROLL),
    async (req, res) => {
      const { offboardingId } = getOffboardingEndpoint.params.parse(req.params);
      res.json({
        data: await offboardingService.getOffboarding(
          hrisLearningContext(req),
          hrisLearningActor(req),
          offboardingId,
        ),
      });
    },
  );

  router.patch(
    "/offboardings/:offboardingId",
    ...common,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { offboardingId } = updateOffboardingEndpoint.params.parse(
        req.params,
      );
      const body = updateOffboardingEndpoint.body.parse(req.body);
      res.json({
        data: await offboardingService.updateOffboarding(
          hrisLearningContext(req),
          hrisLearningActor(req),
          offboardingId,
          body,
        ),
      });
    },
  );

  router.post(
    "/offboardings/:offboardingId/cancel",
    ...common,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { offboardingId } = cancelOffboardingEndpoint.params.parse(
        req.params,
      );
      const body = cancelOffboardingEndpoint.body.parse(req.body);
      res.json({
        data: await offboardingService.cancelOffboarding(
          hrisLearningContext(req),
          hrisLearningActor(req),
          offboardingId,
          body,
        ),
      });
    },
  );

  router.post(
    "/offboardings/:offboardingId/revoke-access",
    ...common,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { offboardingId } = revokeOffboardingAccessEndpoint.params.parse(
        req.params,
      );
      revokeOffboardingAccessEndpoint.body.parse(req.body ?? {});
      // A leaver with a tenant-scoped role also needs tenant-wide
      // access.role.assign; the service decides once it sees the roles. This
      // snapshot is only an upper bound: the service re-checks the permission
      // inside its transaction, after the tenant lock, with the session's
      // second factor passed on here.
      const snapshot = await loadRequestAccess(req);
      const canAssignRoles =
        snapshot.contextFor("access.role.assign", { type: "tenant" }) !== null;
      res.json({
        data: await offboardingService.revokeOffboardingAccess(
          hrisLearningContext(req),
          hrisLearningActor(req),
          offboardingId,
          canAssignRoles,
          snapshot.mfaVerified,
        ),
      });
    },
  );

  router.post(
    "/offboardings/:offboardingId/complete",
    ...common,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { offboardingId } = completeOffboardingEndpoint.params.parse(
        req.params,
      );
      completeOffboardingEndpoint.body.parse(req.body ?? {});
      res.json({
        data: await offboardingService.completeOffboarding(
          hrisLearningContext(req),
          hrisLearningActor(req),
          offboardingId,
        ),
      });
    },
  );

  router.get(
    "/offboardings/:offboardingId/settlement",
    ...common,
    requireHrisLearning(MANAGE_OR_PAYROLL),
    async (req, res) => {
      const { offboardingId } = getOffboardingSettlementEndpoint.params.parse(
        req.params,
      );
      res.json({
        data: await settlementService.getFinalSettlement(
          hrisLearningContext(req),
          hrisLearningActor(req),
          offboardingId,
        ),
      });
    },
  );

  return router;
}

export const hrisOffboardingRouter = createHrisOffboardingRouter();
