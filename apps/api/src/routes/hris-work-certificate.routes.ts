// HRIS work certificate routes (WS-10 lifecycle, brief 299). Mounted at
// `/api/hris`, so each handler path drops that prefix.
//
// HR only, through the back office (MFA when the role requires it). A leaver
// has no access any more, so the certificate is handed over by HR; there is no
// employee route. The service decides who may read which row: a row outside
// the caller's reach answers 404, never a hint it exists.

import { Router, type Request } from "express";
import { z } from "zod";
import type { PermissionCode } from "@starter/shared/access";
import { offboardingIdSchema } from "@starter/shared/hris";
import { requireAuth } from "../middleware/auth.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as certificateService from "../services/hris-work-certificate.service.ts";
import {
  hrisLearningActor,
  hrisLearningContext,
  requireBackOfficeSurface,
  requireHrisLearning,
} from "./hris-sop-gate.ts";

const MANAGE: PermissionCode[] = ["hr.employee.manage"];

const params = z.strictObject({ offboardingId: offboardingIdSchema });

export function createHrisWorkCertificateRouter(): Router {
  const router = Router();
  const base = [
    requireAuth,
    requireTrustedOrigin,
    requireTenantContext,
    requireBackOfficeSurface(),
  ];
  const actor = (req: Request) => hrisLearningActor(req);

  router.get(
    "/offboardings/:offboardingId/work-certificate",
    ...base,
    requireHrisLearning(MANAGE),
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
    requireHrisLearning(MANAGE),
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
