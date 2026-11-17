// Customer reviews (legend-vqicf, docs/briefs/981-reviews.md), mounted at
// /api/reviews. Listing needs `review.respond`; manual entry and moderation need
// `crm.feedback.manage` (product decision: only roles that hold it moderate).
// `requireMenuPermission` mints tenant-wide or outlet-reach scope; outlet RLS
// keeps an outlet manager inside their own outlets.

import { Router } from "express";
import {
  createCustomerReviewInput,
  customerReviewIdParams,
  listCustomerReviewsQuery,
  moderateCustomerReviewInput,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as customerReviewService from "../services/customer-review.service";

export const customerReviewRouter = Router();

const baseGuard = [requireTenantContext, requireAuth, requireTrustedOrigin];
const readGuard = [...baseGuard, requireMenuPermission("review.respond")];
const manageGuard = [
  ...baseGuard,
  requireMenuPermission("crm.feedback.manage"),
];

customerReviewRouter.get("/", ...readGuard, async (req, res) => {
  const query = listCustomerReviewsQuery.parse(req.query);
  res.json(
    await customerReviewService.listCustomerReviews(
      getScopedTenantContext(req),
      query,
    ),
  );
});

customerReviewRouter.post("/", ...manageGuard, jsonBody, async (req, res) => {
  const input = createCustomerReviewInput.parse(req.body);
  res.status(201).json({
    data: await customerReviewService.createCustomerReview(
      getScopedTenantContext(req),
      input,
    ),
  });
});

customerReviewRouter.patch(
  "/:id/moderation",
  ...manageGuard,
  jsonBody,
  async (req, res) => {
    const { id } = customerReviewIdParams.parse(req.params);
    const input = moderateCustomerReviewInput.parse(req.body);
    res.json({
      data: await customerReviewService.moderateCustomerReview(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        id,
        input,
      ),
    });
  },
);
