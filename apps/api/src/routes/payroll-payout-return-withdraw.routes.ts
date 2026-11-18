// Two-person withdrawal of an open return claim (legend-snwnn). Mounted at
// `/api/hris/payroll` next to the other payout routers.
// - GET  /disbursement-batches/:id/return-claims: the claims of a batch with
//   their open withdrawal proposal.
// - POST /payout-return-claims/:claimId/withdrawal: propose withdrawing an open
//   claim with a written reason (201 `{ withdrawalId }`).
// - POST /payout-return-withdrawals/:withdrawalId/approve: a different finance
//   person approves (200); the database refuses the proposer.
// All three sit behind `payroll.disburse.approve`; the two POSTs also re-ask the
// account password, like the unfreeze (the grant accepts the password only).

import { Router } from "express";
import {
  approvePayoutReturnWithdrawInputSchema,
  payoutReturnClaimBatchParamsSchema,
  payoutReturnClaimParamsSchema,
  payoutReturnWithdrawalParamsSchema,
  proposePayoutReturnWithdrawInputSchema,
} from "@starter/shared/validators/payroll-payout-return-withdraw";
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
import { requireTenantContext } from "../middleware/tenant.ts";
import { PAYOUT_STEP_UP_MAX_AGE_MINUTES } from "../services/payroll-payout-evidence.ts";
import { payoutGrantIssuerOf } from "../services/payroll-payout-grant.service.ts";
import {
  approvePayoutReturnWithdraw,
  listPayoutReturnClaims,
  proposePayoutReturnWithdraw,
} from "../services/payroll-payout-return-withdraw.service.ts";
import { payoutGuardErrorMapper } from "../services/payroll-payout.service.ts";

export const payrollPayoutReturnWithdrawRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
// Like the unfreeze: a fresh MFA challenge on a stolen session cookie must not
// withdraw a return claim, so the grant of kind return_withdraw accepts the
// password only.
const passwordStepUp = requireTenantStepUpPassword({ passwordOnly: true });

function actorOf(req: Parameters<typeof getScopedTenantContext>[0]) {
  const context = getScopedTenantContext(req);
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

payrollPayoutReturnWithdrawRouter.get(
  "/disbursement-batches/:id/return-claims",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  async (req, res) => {
    const { id } = payoutReturnClaimBatchParamsSchema.parse(req.params);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      listPayoutReturnClaims(tx, actor, id),
    );
    res.json({ data });
  },
);

payrollPayoutReturnWithdrawRouter.post(
  "/payout-return-claims/:claimId/withdrawal",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { claimId } = payoutReturnClaimParamsSchema.parse(req.params);
    const input = proposePayoutReturnWithdrawInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      proposePayoutReturnWithdraw(tx, actor, claimId, {
        reason: input.reason,
      }),
    );
    res.status(201).json({ data });
  },
);

payrollPayoutReturnWithdrawRouter.post(
  "/payout-return-withdrawals/:withdrawalId/approve",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { withdrawalId } = payoutReturnWithdrawalParamsSchema.parse(
      req.params,
    );
    approvePayoutReturnWithdrawInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      approvePayoutReturnWithdraw(tx, actor, withdrawalId),
    );
    res.json({ data });
  },
);

// A guard or deferred commit check refusal (23514) answers 409.
payrollPayoutReturnWithdrawRouter.use(payoutGuardErrorMapper);
