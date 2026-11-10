// Staff feedback queue (legend-ts50, docs/briefs/290d; contract `listFeedback`,
// `updateFeedback`). Paths are absolute under /api, so the router is mounted
// without a prefix. `requireMenuPermission` mints tenant-wide or outlet-reach
// scope for `crm.feedback.manage`; outlet RLS keeps an outlet manager inside
// their own outlet.

import { Router } from "express";
import {
  listFeedback as listFeedbackEndpoint,
  updateFeedback as updateFeedbackEndpoint,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as feedbackService from "../services/feedback.service";

export const feedbackRouter = Router();

const staffGuard = [
  requireTenantContext,
  requireAuth,
  requireTrustedOrigin,
  requireMenuPermission("crm.feedback.manage"),
];

feedbackRouter.get("/feedback", ...staffGuard, async (req, res) => {
  const query = listFeedbackEndpoint.query.parse(req.query);
  res.json(
    await feedbackService.listFeedback(getScopedTenantContext(req), query),
  );
});

feedbackRouter.patch(
  "/feedback/:feedbackId",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { feedbackId } = updateFeedbackEndpoint.params.parse(req.params);
    const input = updateFeedbackEndpoint.body.parse(req.body);
    res.json({
      data: await feedbackService.updateFeedback(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        feedbackId,
        input.action,
        input.handledNote,
      ),
    });
  },
);
