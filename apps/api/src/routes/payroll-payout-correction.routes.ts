// Correct a failed item that did reach the employee after all, over HTTP (bead
// legend-mejr2; design docs/design/payroll-disbursement.md 5.2, 7.9). Mounted
// at `/api/hris/payroll` next to the payout router. The item only becomes
// `succeeded` (and its journal only reaches the ledger) behind the approve
// permission, a recent second factor, and (after an enrollment-only stamp) the
// account password, like return, resolve and overpaid. Two different people,
// neither the batch requester nor a resolver of the failure, must call it. It
// never pays anything.

import { Router, type Request } from "express";
import {
  correctFailedItemsSchema,
  payoutBatchParamsSchema,
  withdrawPayoutProposalSchema,
} from "@starter/shared/validators/payroll-payout";
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
import { payoutGrantIssuerOf } from "../services/payroll-payout-grant.service.ts";
import {
  PAYOUT_STEP_UP_MAX_AGE_MINUTES,
  payoutEvidenceStoreOf,
} from "../services/payroll-payout-evidence.ts";
import { correctFailedItems } from "../services/payroll-payout-correction.service.ts";
import { withdrawCorrectionProposal } from "../services/payroll-payout-proposal-withdraw.service.ts";
import { payoutGuardErrorMapper } from "../services/payroll-payout.service.ts";

export const payrollPayoutCorrectionRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
const passwordStepUp = requireTenantStepUpPassword();

function actorOf(req: Request) {
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

payrollPayoutCorrectionRouter.post(
  "/disbursement-batches/:id/correct-failed",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = correctFailedItemsSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      correctFailedItems(
        tx,
        actor,
        id,
        input,
        payoutEvidenceStoreOf(req, context),
      ),
    );
    res.json({ data });
  },
);

// Takes back an open step-one proposal (legend-xatux): the items stay `failed`,
// nothing is paid, and the proof cannot be used again. The proposer or another
// approver may call it, never the batch requester.
payrollPayoutCorrectionRouter.post(
  "/disbursement-batches/:id/correct-failed/withdraw",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = withdrawPayoutProposalSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      withdrawCorrectionProposal(tx, actor, id, input),
    );
    res.json({ data });
  },
);

// 905: a guard or deferred commit check refusal (23514) answers 409.
payrollPayoutCorrectionRouter.use(payoutGuardErrorMapper);
