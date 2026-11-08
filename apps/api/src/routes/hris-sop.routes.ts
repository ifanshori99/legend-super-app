// HRIS SOP library routes (PRD v1.7 §3 F32; bead legend-7df1). Paths, params,
// queries and bodies come from the contract (`@starter/shared/hris`
// defineEndpoint objects in endpoints.ts and learning.ts); the router is
// mounted at `/api/hris`, so each handler path drops that prefix.
//
// Gates sit on each route (never router-wide): this router shares the mount
// point with the training and announcement routers and must not swallow their
// paths. The services re-check reach and visibility on every record.
// Employee reads and the acknowledgement use the `hris` identity surface;
// create/publish/status are back-office.

import { Router } from "express";
import type { PermissionCode } from "@starter/shared/access";
import {
  acknowledgeSopDocument as acknowledgeSopDocumentEndpoint,
  createSopDocument as createSopDocumentEndpoint,
  listSopAcknowledgementStatus as listStatusEndpoint,
  listSopDocuments as listSopDocumentsEndpoint,
  listSopDocumentVersions as listVersionsEndpoint,
  publishSopVersion as publishSopVersionEndpoint,
} from "@starter/shared/hris";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as sopService from "../services/hris-sop.service.ts";
import {
  hrisLearningActor,
  hrisLearningContext,
  requireBackOfficeSurface,
  requireHrisLearning,
  requireHrisLearningSurface,
} from "./hris-sop-gate.ts";

const MANAGE: PermissionCode[] = ["hr.sop.manage"];
const READ: PermissionCode[] = ["hr.sop.manage", "self.sop.read"];
const SELF: PermissionCode[] = ["self.sop.read"];

export function createHrisSopRouter(): Router {
  const router = Router();
  const common = [requireAuth, requireTrustedOrigin, requireTenantContext];
  const backOffice = requireBackOfficeSurface();
  const employee = requireHrisLearningSurface();

  router.get(
    "/sop-documents",
    ...common,
    employee,
    requireHrisLearning(READ),
    async (req, res) => {
      const query = listSopDocumentsEndpoint.query.parse(req.query);
      res.json(
        await sopService.listSopDocuments(
          hrisLearningContext(req),
          hrisLearningActor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/sop-documents",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const body = createSopDocumentEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await sopService.createSopDocument(
          hrisLearningContext(req),
          hrisLearningActor(req),
          body,
        ),
      });
    },
  );

  router.get(
    "/sop-documents/:sopDocumentId/versions",
    ...common,
    backOffice,
    requireHrisLearning(READ),
    async (req, res) => {
      const { sopDocumentId } = listVersionsEndpoint.params!.parse(req.params);
      res.json({
        data: await sopService.listSopDocumentVersions(
          hrisLearningContext(req),
          hrisLearningActor(req),
          sopDocumentId,
        ),
      });
    },
  );

  router.post(
    "/sop-documents/:sopDocumentId/versions",
    ...common,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { sopDocumentId } = publishSopVersionEndpoint.params!.parse(
        req.params,
      );
      const body = publishSopVersionEndpoint.body.parse(req.body);
      res.status(201).json({
        data: await sopService.publishSopVersion(
          hrisLearningContext(req),
          hrisLearningActor(req),
          sopDocumentId,
          body,
        ),
      });
    },
  );

  router.get(
    "/sop-documents/:sopDocumentId/acknowledgement-status",
    ...common,
    backOffice,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { sopDocumentId } = listStatusEndpoint.params!.parse(req.params);
      const query = listStatusEndpoint.query.parse(req.query);
      res.json(
        await sopService.listSopAcknowledgementStatus(
          hrisLearningContext(req),
          hrisLearningActor(req),
          sopDocumentId,
          query,
        ),
      );
    },
  );

  router.post(
    "/sop-documents/:sopDocumentId/acknowledgements",
    ...common,
    employee,
    jsonBody,
    requireHrisLearning(SELF),
    async (req, res) => {
      const { sopDocumentId } = acknowledgeSopDocumentEndpoint.params!.parse(
        req.params,
      );
      const body = acknowledgeSopDocumentEndpoint.body.parse(req.body);
      res.json({
        data: await sopService.acknowledgeSopDocument(
          hrisLearningContext(req),
          hrisLearningActor(req),
          sopDocumentId,
          body,
        ),
      });
    },
  );

  return router;
}

export const hrisSopRouter = createHrisSopRouter();
