// Loyalty tier ladder for staff (legend-3zd1; contract `@starter/shared/crm`
// endpoints). Paths are absolute under /api (`/loyalty/tiers`), so the router
// is mounted without a prefix and guards each route itself (same shape as
// loyalty-program.routes.ts). Tiers are deactivated, never deleted.
//
// Tenant-wide permission only (TEN-02/03): the tenant comes from the
// server-minted context, never the request.

import { Router } from "express";
import {
  createLoyaltyTierInputSchema,
  updateLoyaltyTier as updateLoyaltyTierEndpoint,
  updateLoyaltyTierInputSchema,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as tiers from "../services/loyalty-tier.service";

export const loyaltyTiersRouter = Router();

const staffGuard = [requireAuth, requireTrustedOrigin, requireTenantContext];
const manage = requireTenantPermission("crm.loyalty.manage");

loyaltyTiersRouter.get(
  "/loyalty/tiers",
  ...staffGuard,
  manage,
  async (req, res) => {
    res.json({ data: await tiers.listTiers(getScopedTenantContext(req)) });
  },
);

loyaltyTiersRouter.post(
  "/loyalty/tiers",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const input = createLoyaltyTierInputSchema.parse(req.body);
    res.status(201).json({
      data: await tiers.createTier(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        input,
      ),
    });
  },
);

loyaltyTiersRouter.patch(
  "/loyalty/tiers/:tierId",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const { tierId } = updateLoyaltyTierEndpoint.params.parse(req.params);
    const input = updateLoyaltyTierInputSchema.parse(req.body);
    res.json({
      data: await tiers.updateTier(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        tierId,
        input,
      ),
    });
  },
);
