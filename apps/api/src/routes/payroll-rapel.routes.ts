import { Router } from "express";
import {
  allocatePayrollRapelInputSchema,
  approvePayrollRapelInputSchema,
  createPayrollRapelInputSchema,
  payrollRapelIdSchema,
} from "@starter/shared/hris/payroll";
import { getAuth, requireAuth } from "../middleware/auth";
import { jsonBody } from "../middleware/body";
import { requireTrustedOrigin } from "../middleware/origin";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions";
import { requireTenantContext } from "../middleware/tenant";
import * as rapel from "../services/payroll-rapel.service";

export const payrollRapelRouter = Router();
payrollRapelRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

payrollRapelRouter.post(
  "/",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    res.status(201).json({
      data: await rapel.createPayrollRapel(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        createPayrollRapelInputSchema.parse(req.body),
      ),
    });
  },
);
payrollRapelRouter.get(
  "/:rapelId",
  requireTenantPermission("payroll.view"),
  async (req, res) => {
    res.json({
      data: await rapel.getPayrollRapel(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        payrollRapelIdSchema.parse(req.params.rapelId),
      ),
    });
  },
);
for (const stage of ["hr", "finance"] as const) {
  payrollRapelRouter.post(
    `/:rapelId/approve-${stage}`,
    requireTenantPermission("payroll.approve"),
    jsonBody,
    async (req, res) => {
      res.json({
        data: await rapel.approvePayrollRapel(
          getScopedTenantContext(req),
          getAuth(req).user.id,
          payrollRapelIdSchema.parse(req.params.rapelId),
          stage,
          approvePayrollRapelInputSchema.parse(req.body),
        ),
      });
    },
  );
}
payrollRapelRouter.post(
  "/:rapelId/allocate",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    res.json({
      data: await rapel.allocatePayrollRapel(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        payrollRapelIdSchema.parse(req.params.rapelId),
        allocatePayrollRapelInputSchema.parse(req.body),
      ),
    });
  },
);
payrollRapelRouter.post(
  "/:rapelId/cancel",
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    res.json({
      data: await rapel.cancelPayrollRapel(
        getScopedTenantContext(req),
        getAuth(req).user.id,
        payrollRapelIdSchema.parse(req.params.rapelId),
        approvePayrollRapelInputSchema.parse(req.body),
      ),
    });
  },
);
