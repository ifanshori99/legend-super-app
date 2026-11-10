// Payroll policy and THR schedule routes (bead legend-gfcr, PRD v1.7 §3 D.30).
// `payrollPolicyRouter` is mounted at `/api/hris/payroll/policies` and
// `payrollThrRouter` at `/api/hris/payroll/thr-schedules` (contract: hris/payroll
// endpoints.ts in packages/shared). Tenant comes from the server-minted
// context, never the request (TEN-02). Reading needs `payroll.view`, writing
// `payroll.run`, both tenant-wide; the service re-checks them inside the
// tenant transaction.

import { Router } from "express";
import {
  createPayrollPolicy,
  createThrSchedule,
  listPayrollPolicies,
  listThrSchedules,
  updatePayrollPolicy,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as policies from "../services/payroll-policy.service";

export const payrollPolicyRouter = Router();
export const payrollThrRouter = Router();

for (const router of [payrollPolicyRouter, payrollThrRouter])
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

payrollPolicyRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const query = listPayrollPolicies.query.parse(req.query);
    res.json(
      await policies.listPayrollPolicies(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

payrollPolicyRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const body = createPayrollPolicy.body.parse(req.body);
    res.status(201).json({
      data: await policies.createPayrollPolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      ),
    });
  },
);

payrollPolicyRouter.patch(
  "/:payrollPolicyId",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const params = updatePayrollPolicy.params.parse(req.params);
    const body = updatePayrollPolicy.body.parse(req.body);
    res.json({
      data: await policies.updatePayrollPolicy(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        params.payrollPolicyId,
        body,
      ),
    });
  },
);

payrollThrRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const query = listThrSchedules.query.parse(req.query);
    res.json(
      await policies.listThrSchedules(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        query,
      ),
    );
  },
);

payrollThrRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const body = createThrSchedule.body.parse(req.body);
    res.status(201).json({
      data: await policies.createThrSchedule(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        body,
      ),
    });
  },
);
