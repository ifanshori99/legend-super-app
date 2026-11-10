// Loyalty program, customer point history and anomaly review (legend-111j;
// contract `@starter/shared/crm` endpoints). Paths are absolute under /api
// (`/loyalty/program`, `/loyalty/anomalies`, `/customers/:id/points`), so the
// router is mounted without a prefix and guards each route itself (same shape
// as open-bill.routes.ts).
//
// Tenant-wide permissions only (TEN-02/03): the tenant comes from the
// server-minted context, never the request.

import { Router } from "express";
import {
  listCustomerPoints as listCustomerPointsEndpoint,
  listLoyaltyAnomalies as listLoyaltyAnomaliesEndpoint,
  updateLoyaltyProgramInputSchema,
} from "@starter/shared/crm";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as loyalty from "../services/loyalty-program.service";

export const loyaltyProgramRouter = Router();

const staffGuard = [requireAuth, requireTrustedOrigin, requireTenantContext];
const manage = requireTenantPermission("crm.loyalty.manage");
const review = requireTenantPermission("crm.loyalty.review");
const viewCustomer = requireTenantPermission("crm.customer.view");

loyaltyProgramRouter.get(
  "/loyalty/program",
  ...staffGuard,
  manage,
  async (req, res) => {
    res.json({
      data: await loyalty.getLoyaltyProgram(getScopedTenantContext(req)),
    });
  },
);

loyaltyProgramRouter.put(
  "/loyalty/program",
  ...staffGuard,
  manage,
  jsonBody,
  async (req, res) => {
    const input = updateLoyaltyProgramInputSchema.parse(req.body);
    // The contract defaults `isActive` to false; an omitted field must keep
    // the stored value instead of silently switching the program off.
    const isActiveSent =
      typeof req.body === "object" &&
      req.body !== null &&
      Object.hasOwn(req.body, "isActive");
    res.json({
      data: await loyalty.updateLoyaltyProgram(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        { ...input, isActive: isActiveSent ? input.isActive : undefined },
      ),
    });
  },
);

loyaltyProgramRouter.get(
  "/loyalty/anomalies",
  ...staffGuard,
  review,
  async (req, res) => {
    const query = listLoyaltyAnomaliesEndpoint.query.parse(req.query);
    res.json(
      await loyalty.listLoyaltyAnomalies(getScopedTenantContext(req), query),
    );
  },
);

loyaltyProgramRouter.get(
  "/customers/:customerProfileId/points",
  ...staffGuard,
  viewCustomer,
  async (req, res) => {
    const { customerProfileId } = listCustomerPointsEndpoint.params.parse(
      req.params,
    );
    const query = listCustomerPointsEndpoint.query.parse(req.query);
    res.json(
      await loyalty.listCustomerPoints(
        getScopedTenantContext(req),
        customerProfileId,
        query,
      ),
    );
  },
);
