// Payroll run create, simulate, approvals, return-to-draft and lock (beads
// legend-c2yca, legend-q5dx4, legend-ele0u, legend-vepv0; design
// docs/briefs/sub-payroll-followups-design.md §2). Contract: hris/payroll
// endpoints.ts `createPayrollRun`, `simulatePayrollRun`, `approvePayrollRunHr`,
// `approvePayrollRunFinal`, `returnPayrollRunToDraft`, `lockPayrollRun`
// (strict bodies: any calculation sent by the client is a 400). The guards sit on each route, not `router.use`, so the bank transfer
// file paths under `/runs/:payrollRunId/...` fall through to the export router
// untouched.

import { Router } from "express";
import {
  approvePayrollRunFinal,
  approvePayrollRunHr,
  createPayrollRun,
  lockPayrollRun,
  returnPayrollRunToDraft,
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
  approvePayrollRunFinalInTransaction,
  approvePayrollRunHrInTransaction,
  createPayrollRunInTransaction,
  returnPayrollRunToDraftInTransaction,
} from "../services/payroll-run-lifecycle.service.ts";
import {
  loadPayrollRunDto,
  lockPayrollRunInTransaction,
} from "../services/payroll-run-lock.service.ts";
import {
  simulatePayrollRunInTransaction,
  withExcludedFormerEmployees,
} from "../services/payroll-run-simulate.service.ts";

export const payrollRunsRouter = Router();

payrollRunsRouter.post(
  "/",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { idempotencyKey, ...input } = createPayrollRun.body.parse(req.body);
    const context = getScopedTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    const data = await withTenant(db, context, (tx) =>
      idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.run.create",
        { actorUserId, ...input },
        () => createPayrollRunInTransaction(tx, context, actorUserId, input),
      ),
    );
    res.json({ data });
  },
);

payrollRunsRouter.post(
  "/:payrollRunId/hr-approval",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.approve"),
  jsonBody,
  async (req, res) => {
    const { payrollRunId } = approvePayrollRunHr.params.parse(req.params);
    const { idempotencyKey, expectedSimulationCount } =
      approvePayrollRunHr.body.parse(req.body);
    const context = getScopedTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    const data = await withTenant(db, context, (tx) =>
      idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.run.approve_hr",
        { actorUserId, payrollRunId, expectedSimulationCount },
        () =>
          approvePayrollRunHrInTransaction(
            tx,
            context,
            actorUserId,
            payrollRunId,
            expectedSimulationCount,
          ),
      ),
    );
    res.json({ data });
  },
);

payrollRunsRouter.post(
  "/:payrollRunId/final-approval",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.approve"),
  jsonBody,
  async (req, res) => {
    const { payrollRunId } = approvePayrollRunFinal.params.parse(req.params);
    const { idempotencyKey } = approvePayrollRunFinal.body.parse(req.body);
    const context = getScopedTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    const data = await withTenant(db, context, (tx) =>
      idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.run.approve_final",
        { actorUserId, payrollRunId },
        () =>
          approvePayrollRunFinalInTransaction(
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
  "/:payrollRunId/return-to-draft",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.run"),
  jsonBody,
  async (req, res) => {
    const { payrollRunId } = returnPayrollRunToDraft.params.parse(req.params);
    const { idempotencyKey, reason } = returnPayrollRunToDraft.body.parse(
      req.body,
    );
    const context = getScopedTenantContext(req);
    const actorUserId = getAuth(req).user.id;
    const data = await withTenant(db, context, (tx) =>
      idempotentHrisWrite(
        tx,
        context,
        idempotencyKey,
        "payroll.run.return_to_draft",
        { actorUserId, payrollRunId, reason },
        () =>
          returnPayrollRunToDraftInTransaction(
            tx,
            context,
            actorUserId,
            payrollRunId,
            reason,
          ),
      ),
    );
    res.json({ data });
  },
);

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
          return withExcludedFormerEmployees(
            tx,
            context.tenant.tenantId,
            await loadPayrollRunDto(tx, context.tenant.tenantId, payrollRunId),
          );
        },
      ),
    );
    res.json({ data });
  },
);
