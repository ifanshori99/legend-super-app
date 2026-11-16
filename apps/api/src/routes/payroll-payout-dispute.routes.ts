// "Not me", batch freeze and unfreeze over HTTP (legend-l2zru; design
// docs/briefs/918/design-l2zru.md "API"). Mounted at `/api/hris/payroll` next to
// the payout router.
// - GET  /payout-approval-log/:logId: the page the receipt notification links
//   to. Only the actor of the log row gets it; anyone else answers 404.
// - POST /payout-approval-log/:logId/disown: freezes the batch of that row. No
//   payroll permission and no second-factor age on purpose: a person whose role
//   or factor an attacker removed can still say "not me". The account password,
//   always verified, is the proof, and the grant is bound to the reason.
// - POST /disbursement-batches/:id/unfreeze: releases every open dispute of the
//   batch behind `payroll.disburse.approve`; the database also demands an
//   owner or finance role who took no part in the batch.

import { Router, type Request } from "express";
import {
  disownPayoutApprovalInputSchema,
  payoutApprovalLogParamsSchema,
  unfreezePayoutBatchInputSchema,
} from "@starter/shared/hris/payroll/payout";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { payoutBatchParamsSchema } from "@starter/shared/validators/payroll-payout";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import {
  requireTenantStepUpMfa,
  requireTenantStepUpPassword,
} from "../middleware/identity.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireTenantPermission,
} from "../middleware/permissions.ts";
import {
  getTenantContext,
  requireTenantContext,
} from "../middleware/tenant.ts";
import { PAYOUT_STEP_UP_MAX_AGE_MINUTES } from "../services/payroll-payout-evidence.ts";
import {
  disownPayoutApproval,
  getPayoutApprovalLog,
  unfreezeDisbursementBatch,
} from "../services/payroll-payout-dispute.service.ts";
import { payoutGrantIssuerOf } from "../services/payroll-payout-grant.service.ts";
import { payoutGuardErrorMapper } from "../services/payroll-payout.service.ts";

export const payrollPayoutDisputeRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
const passwordStepUp = requireTenantStepUpPassword();
// Disown: no MFA age and no challenge shortcut. The account password is always
// verified, so an approver whose role or second factor an attacker removed can
// still say "not me" (the grant of kind disown accepts the password only).
const disownPasswordStepUp = requireTenantStepUpPassword({
  passwordOnly: true,
});

/**
 * The caller. `scoped` is true behind `requireTenantPermission` (unfreeze). The
 * log page and the disown ask for no payroll permission, so they run in the
 * tenant of the request with the tenant-wide scope, like the payout service.
 */
function actorOf(req: Request, scoped = false) {
  const context = scoped
    ? getScopedTenantContext(req)
    : establishScopedTenantContext(getTenantContext(req), { kind: "tenant" });
  return {
    context,
    actor: {
      tenantId: context.tenant.tenantId,
      userId: getAuth(req).user.id,
      sessionId: getAuth(req).session.id,
      grants: payoutGrantIssuerOf(req),
    },
  };
}

payrollPayoutDisputeRouter.get(
  "/payout-approval-log/:logId",
  requireAuth,
  requireTenantContext,
  async (req, res) => {
    const { logId } = payoutApprovalLogParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      getPayoutApprovalLog(tx, actor, logId),
    );
    res.json({ data });
  },
);

payrollPayoutDisputeRouter.post(
  "/payout-approval-log/:logId/disown",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  jsonBody,
  disownPasswordStepUp,
  async (req, res) => {
    const { logId } = payoutApprovalLogParamsSchema.parse(req.params);
    const input = disownPayoutApprovalInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      disownPayoutApproval(tx, actor, logId, { reason: input.reason }),
    );
    res.json({ data });
  },
);

payrollPayoutDisputeRouter.post(
  "/disbursement-batches/:id/unfreeze",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = unfreezePayoutBatchInputSchema.parse(req.body);
    const { context, actor } = actorOf(req, true);
    const data = await withTenant(db, context, (tx) =>
      unfreezeDisbursementBatch(tx, actor, id, { reason: input.reason }),
    );
    res.json({ data });
  },
);

// A guard or deferred commit check refusal (23514, e.g. PAYOUT-79) answers 409.
payrollPayoutDisputeRouter.use(payoutGuardErrorMapper);
