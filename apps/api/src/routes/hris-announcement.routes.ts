// HRIS internal announcement routes (PRD v1.7 §3 F32; bead legend-7df1).
// Paths, params, queries and bodies come from the shared contract (endpoints.ts
// for the employee side, learning.ts for the manager side); this router is
// mounted at `/api/hris`, so each handler path drops that prefix.
//
// Middleware is applied per route: the router shares the `/api/hris` prefix
// with other routers, so unmatched paths must fall through untouched.
//
// Surfaces (AUTH-05): manager routes run behind the back-office gate (MFA when
// the role requires it); employee routes use the `hris` surface. The feed is
// shared, so it picks the back-office gate when the caller holds the manage
// code.

import { Router, type Request, type RequestHandler } from "express";
import type { PermissionCode } from "@starter/shared/access";
import {
  createAnnouncement as createAnnouncementEndpoint,
  listAnnouncementReceipts as listAnnouncementReceiptsEndpoint,
  listAnnouncements as listAnnouncementsEndpoint,
  markAnnouncementRead as markAnnouncementReadEndpoint,
} from "@starter/shared/hris";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { loadRequestAccess } from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as announcementService from "../services/hris-announcement.service.ts";
import {
  hrisLearningActor,
  hrisLearningContext,
  requireBackOfficeSurface,
  requireHrisLearning,
  requireHrisLearningSurface,
} from "./hris-sop-gate.ts";

const MANAGE: PermissionCode[] = ["hr.sop.manage"];
const SELF: PermissionCode[] = ["self.sop.read"];
const FEED: PermissionCode[] = ["self.sop.read", "hr.sop.manage"];

const base = [requireAuth, requireTrustedOrigin, requireTenantContext];

export function createHrisAnnouncementRouter(): Router {
  const router = Router();
  const backOffice = requireBackOfficeSurface();
  const employeeSurface = requireHrisLearningSurface();
  const actor = (req: Request) => hrisLearningActor(req);

  // A manager reads the feed through the back office, everyone else through
  // the employee surface.
  const feedSurface: RequestHandler = async (req, res, next) => {
    const snapshot = await loadRequestAccess(req);
    const surface = snapshot.permissions.includes("hr.sop.manage")
      ? backOffice
      : employeeSurface;
    return surface(req, res, next);
  };

  router.get(
    "/announcements",
    ...base,
    feedSurface,
    requireHrisLearning(FEED),
    async (req, res) => {
      const query = listAnnouncementsEndpoint.query.parse(req.query);
      res.json(
        await announcementService.listAnnouncements(
          hrisLearningContext(req),
          actor(req),
          query,
        ),
      );
    },
  );

  router.post(
    "/announcements",
    ...base,
    backOffice,
    jsonBody,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const body = createAnnouncementEndpoint.body.parse(req.body);
      res.json({
        data: await announcementService.createAnnouncement(
          hrisLearningContext(req),
          actor(req),
          body,
        ),
      });
    },
  );

  router.post(
    "/announcements/:announcementId/receipts",
    ...base,
    employeeSurface,
    jsonBody,
    requireHrisLearning(SELF),
    async (req, res) => {
      const { announcementId } = markAnnouncementReadEndpoint.params.parse(
        req.params,
      );
      const body = markAnnouncementReadEndpoint.body.parse(req.body);
      res.json({
        data: await announcementService.markAnnouncementRead(
          hrisLearningContext(req),
          actor(req),
          announcementId,
          body,
        ),
      });
    },
  );

  router.get(
    "/announcements/:announcementId/receipts",
    ...base,
    backOffice,
    requireHrisLearning(MANAGE),
    async (req, res) => {
      const { announcementId } = listAnnouncementReceiptsEndpoint.params.parse(
        req.params,
      );
      const query = listAnnouncementReceiptsEndpoint.query.parse(req.query);
      res.json(
        await announcementService.listAnnouncementReceipts(
          hrisLearningContext(req),
          actor(req),
          announcementId,
          query,
        ),
      );
    },
  );

  return router;
}

export const hrisAnnouncementRouter = createHrisAnnouncementRouter();
