// Member feedback (legend-ts50, docs/briefs/290d). Mounted under /api/member
// by the route index. Same chain as `member.routes.ts`: the profile always
// comes from the session scope; this module imports no `withTenant`.

import { Router } from "express";
import { submitFeedback as submitFeedbackEndpoint } from "@starter/shared/crm";
import { requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { getMemberScope, requireMember } from "../middleware/member.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { submitFeedback } from "../services/feedback.service.ts";

export const memberFeedbackRouter = Router();

const base = [requireTenantContext, requireAuth, requireTrustedOrigin];

memberFeedbackRouter.post(
  "/feedback",
  ...base,
  jsonBody,
  requireMember(),
  async (req, res) => {
    const input = submitFeedbackEndpoint.body.parse(req.body);
    res
      .status(201)
      .json({ data: await submitFeedback(getMemberScope(req), input) });
  },
);
