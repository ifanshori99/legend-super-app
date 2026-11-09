// HRIS work certificate routes (WS-10 lifecycle, brief 299). Mounted at
// `/api/hris`, so each handler path drops that prefix.
//
// HR reads through the back office (MFA when the role requires it); the
// employee reads their own certificate through the `hris` surface. The surface
// follows the manage code, like the announcement feed. The service decides who
// may read which row: someone else's row answers 404, never a hint it exists.

import { Router, type Request, type RequestHandler } from "express";
import { z } from "zod";
import type { PermissionCode } from "@starter/shared/access";
import { offboardingIdSchema } from "@starter/shared/hris";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import * as certificateService from "../services/hris-work-certificate.service.ts";
import {
  hrisLearningActor,
  hrisLearningContext,
  requireBackOfficeSurface,
  requireHrisLearning,
  requireHrisLearningSurface,
  resolveHrisLearningContext,
} from "./hris-sop-gate.ts";

const MANAGE: PermissionCode[] = ["hr.employee.manage"];
const MANAGE_OR_SELF: PermissionCode[] = [
  "hr.employee.manage",
  "self.profile.view",
];

const params = z.strictObject({ offboardingId: offboardingIdSchema });

export function createHrisWorkCertificateRouter(): Router {
  const router = Router();
  const base = [requireAuth, requireTrustedOrigin, requireTenantContext];
  const backOffice = requireBackOfficeSurface();
  const employeeSurface = requireHrisLearningSurface();
  const actor = (req: Request) => hrisLearningActor(req);

  const surface: RequestHandler = async (req, res, next) => {
    const manage = await resolveHrisLearningContext(
      await loadRequestAccess(req),
      getTenantContext(req),
      getAuth(req).user.id,
      MANAGE,
    );
    return (manage ? backOffice : employeeSurface)(req, res, next);
  };

  router.get(
    "/offboardings/:offboardingId/work-certificate",
    ...base,
    surface,
    requireHrisLearning(MANAGE_OR_SELF),
    async (req, res) => {
      const { offboardingId } = params.parse(req.params);
      res.json({
        data: await certificateService.getWorkCertificate(
          hrisLearningContext(req),
          actor(req),
          offboardingId,
        ),
      });
    },
  );

  router.get(
    "/offboardings/:offboardingId/work-certificate.pdf",
    ...base,
    surface,
    requireHrisLearning(MANAGE_OR_SELF),
    async (req, res) => {
      const { offboardingId } = params.parse(req.params);
      const file = await certificateService.getWorkCertificatePdf(
        hrisLearningContext(req),
        actor(req),
        offboardingId,
      );
      res
        .status(200)
        .type("application/pdf")
        .setHeader("Content-Disposition", `inline; filename="${file.filename}"`)
        .setHeader("X-Content-Type-Options", "nosniff")
        .send(file.pdf);
    },
  );

  return router;
}

export const hrisWorkCertificateRouter = createHrisWorkCertificateRouter();
