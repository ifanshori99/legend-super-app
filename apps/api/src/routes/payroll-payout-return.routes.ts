// Return of a paid payout item over HTTP (bead legend-qxkm6; design
// docs/design/payroll-disbursement.md 7.8). Mounted at `/api/hris/payroll`
// next to the payout router. Money moves back into the ledger only behind the
// approve permission, a recent second factor, and (after an enrollment-only
// stamp) the account password, like confirm and resolve. Two different people,
// neither the batch requester, must call it for an item to become `returned`.

import { Router, type Request } from "express";
import {
  payoutBatchParamsSchema,
  returnManualItemsSchema,
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
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import {
  PAYOUT_STEP_UP_MAX_AGE_MINUTES,
  payoutEvidenceStoreOf,
} from "../services/payroll-payout-evidence.ts";
import { payoutGuardErrorMapper } from "../services/payroll-payout.service.ts";

export const payrollPayoutReturnRouter = Router();

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
    },
  };
}

payrollPayoutReturnRouter.post(
  "/disbursement-batches/:id/return",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = returnManualItemsSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      returnManualItems(
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

// 905: a guard or deferred commit check refusal (23514) answers 409.
payrollPayoutReturnRouter.use(payoutGuardErrorMapper);
