// Tenant kasbon limits (bead legend-hjaot). Mounted at
// `/api/hris/payroll/loan-policy` (contract: hris/payroll endpoints.ts in
// packages/shared). Tenant comes from the server-minted context, never the
// request (TEN-02). Reading needs `payroll.view`, replacing the policy
// `payroll.run`, both tenant-wide; the service re-checks them inside the
// tenant transaction. One policy per tenant: no POST, PATCH or DELETE.

import { Router } from "express";
import { setLoanPolicy as setLoanPolicyEndpoint } from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as policy from "../services/payroll-loan-policy.service";

export const payrollLoanPolicyRouter = Router();

payrollLoanPolicyRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
);

payrollLoanPolicyRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    res.json({
      data: await policy.getLoanPolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
      ),
    });
  },
);

payrollLoanPolicyRouter.put(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const body = setLoanPolicyEndpoint.body.parse(req.body);
    res.json({
      data: await policy.setLoanPolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      ),
    });
  },
);
