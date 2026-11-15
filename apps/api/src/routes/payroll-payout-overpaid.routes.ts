// Record a transfer that turned out paid twice, over HTTP (bead legend-v6gtp;
// design docs/design/payroll-disbursement.md 5.2, 7.9). Mounted at
// `/api/hris/payroll` next to the payout router. The employee receivable only
// reaches the ledger behind the approve permission, a recent second factor, and
// (after an enrollment-only stamp) the account password, like return and
// resolve. Two different people, neither the batch requester, must call it for
// an item to become `overpaid`. It never pays anything.

import { Router, type Request } from "express";
import {
  payoutBatchParamsSchema,
  recordOverpaidItemsSchema,
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
import {
  PAYOUT_STEP_UP_MAX_AGE_MINUTES,
  payoutEvidenceStoreOf,
} from "../services/payroll-payout-evidence.ts";
import { recordOverpaidItems } from "../services/payroll-payout-overpaid-route.service.ts";

export const payrollPayoutOverpaidRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
const passwordStepUp = requireTenantStepUpPassword();

function actorOf(req: Request) {
  const context = getScopedTenantContext(req);
  return {
    context,
    actor: { tenantId: context.tenant.tenantId, userId: getAuth(req).user.id },
  };
}

payrollPayoutOverpaidRouter.post(
  "/disbursement-batches/:id/overpaid",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutBatchParamsSchema.parse(req.params);
    const input = recordOverpaidItemsSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      recordOverpaidItems(
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
