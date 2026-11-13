// Payroll run simulate and lock (beads legend-c2yca, legend-q5dx4,
// legend-ele0u; design docs/briefs/sub-payroll-followups-design.md §2).
// Contract: hris/payroll endpoints.ts `simulatePayrollRun`, `lockPayrollRun`
// (strict `{ idempotencyKey }` bodies: any calculation sent by the client is a
// 400). The guards sit on each route, not `router.use`, so the bank transfer
// file paths under `/runs/:payrollRunId/...` fall through to the export router
// untouched.

import { Router } from "express";
import {
  lockPayrollRun,
  simulatePayrollRun,
} from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { idempotentHrisWrite } from "../services/hris-employee.service.ts";
import {
  loadPayrollRunDto,
  lockPayrollRunInTransaction,
} from "../services/payroll-run-lock.service.ts";
import { simulatePayrollRunInTransaction } from "../services/payroll-run-simulate.service.ts";

export const payrollRunsRouter = Router();

payrollRunsRouter.post(
  "/:payrollRunId/simulate",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { payrollRunId } = simulatePayrollRun.params.parse(req.params);
    const { idempotencyKey } = simulatePayrollRun.body.parse(req.body);
    const context = getScopedTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    const data = await withTenant(db, context, (tx) =>
      idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.run.simulate",
        { actorUserId, payrollRunId },
        () =>
          simulatePayrollRunInTransaction(
            tx,
            context,
            actorUserId,
            payrollRunId,
          ),
      ),
    );
    res.json({ data });
  },
);

payrollRunsRouter.post(
  "/:payrollRunId/lock",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.lock"),
  jsonBody,
  async (req, res) => {
    const { payrollRunId } = lockPayrollRun.params.parse(req.params);
    const { idempotencyKey } = lockPayrollRun.body.parse(req.body);
    const context = getScopedTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    const data = await withTenant(db, context, (tx) =>
      idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.run.lock",
        { actorUserId, payrollRunId },
        async () => {
          await lockPayrollRunInTransaction(tx, context, actorUserId, {
            payrollRunId,
          });
          return loadPayrollRunDto(tx, context.tenant.tenantId, payrollRunId);
        },
      ),
    );
    res.json({ data });
  },
);
