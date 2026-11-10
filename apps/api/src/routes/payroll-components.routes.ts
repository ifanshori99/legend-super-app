// Pay component routes (bead legend-gfcr; contract `@starter/shared/hris/
// payroll` endpoints.ts). `payrollComponentsRouter` is mounted at
// `/api/hris/payroll/components`, `payrollEmployeeComponentsRouter` at
// `/api/hris/payroll/employees` (the per-employee amounts live under
// `/:employeeId/components`). Tenant comes from the server-minted context,
// never the request (TEN-02). Reading needs `payroll.view`, writing
// `payroll.run`; the service re-checks both inside the tenant transaction.
// Employee amounts are salary data (HR-03).

import { Router } from "express";
import {
  createPayComponent,
  listEmployeePayComponents,
  listPayComponents,
  setEmployeePayComponent,
  updatePayComponent,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as components from "../services/payroll-components.service";

export const payrollComponentsRouter = Router();
export const payrollEmployeeComponentsRouter = Router();

for (const router of [payrollComponentsRouter, payrollEmployeeComponentsRouter])
  router.use(requireAuth, requireTrustedOrigin, requireTenantContext);

payrollComponentsRouter.get(
  "/",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    res.json(
      await components.listPayComponents(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        listPayComponents.query.parse(req.query),
      ),
    );
  },
);

payrollComponentsRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const component = await components.createPayComponent(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      createPayComponent.body.parse(req.body),
    );
    res.status(201).json({ data: component });
  },
);

payrollComponentsRouter.patch(
  "/:componentId",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { componentId } = updatePayComponent.params.parse(req.params);
    const component = await components.updatePayComponent(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      componentId,
      updatePayComponent.body.parse(req.body),
    );
    res.json({ data: component });
  },
);

payrollEmployeeComponentsRouter.get(
  "/:employeeId/components",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    const { employeeId } = listEmployeePayComponents.params.parse(req.params);
    res.json(
      await components.listEmployeePayComponents(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        employeeId,
        listEmployeePayComponents.query.parse(req.query),
      ),
    );
  },
);

payrollEmployeeComponentsRouter.put(
  "/:employeeId/components",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { employeeId } = setEmployeePayComponent.params.parse(req.params);
    const row = await components.setEmployeePayComponent(
      getScopedTenantContext(req),
      getAuth(req).user.id,
      employeeId,
      setEmployeePayComponent.body.parse(req.body),
    );
    res.json({ data: row });
  },
);
