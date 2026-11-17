// Two-person clearance of a false payout reconciliation flag (legend-xbagc).
// Mounted at `/api/hris/payroll` next to the other payout routers.
// - GET  /payout-recon-flags: every flag with the state of its clearance.
// - POST /payout-recon-flags/:flagId/clearance: propose clearing a flag with a
//   written reason (201 `{ clearanceId }`).
// - POST /payout-recon-clearances/:clearanceId/approve: a different finance
//   person approves (200); the database refuses the proposer.
// All three sit behind `payroll.disburse.approve`; the two POSTs also re-ask the
// account password, like the unfreeze (the grant accepts the password only).

import { Router } from "express";
import {
  approvePayoutReconClearanceInputSchema,
  payoutReconClearanceParamsSchema,
  payoutReconFlagParamsSchema,
  proposePayoutReconClearanceInputSchema,
} from "@starter/shared/validators/payroll-payout-recon-clearance";
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
  approvePayoutReconClearance,
  listPayoutReconFlags,
  proposePayoutReconClearance,
} from "../services/payroll-payout-recon-clearance.service.ts";
import { payoutGuardErrorMapper } from "../services/payroll-payout.service.ts";

export const payrollPayoutReconClearanceRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
// Like the unfreeze: a fresh MFA challenge on a stolen session cookie must not
// close a flag, so the grant of kind recon_clear accepts the password only.
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

payrollPayoutReconClearanceRouter.get(
  "/payout-recon-flags",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  async (req, res) => {
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      listPayoutReconFlags(tx, actor),
    );
    res.json({ data });
  },
);

payrollPayoutReconClearanceRouter.post(
  "/payout-recon-flags/:flagId/clearance",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { flagId } = payoutReconFlagParamsSchema.parse(req.params);
    const input = proposePayoutReconClearanceInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      proposePayoutReconClearance(tx, actor, flagId, { reason: input.reason }),
    );
    res.status(201).json({ data });
  },
);

payrollPayoutReconClearanceRouter.post(
  "/payout-recon-clearances/:clearanceId/approve",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { clearanceId } = payoutReconClearanceParamsSchema.parse(req.params);
    approvePayoutReconClearanceInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      approvePayoutReconClearance(tx, actor, clearanceId),
    );
    res.json({ data });
  },
);

// A guard or deferred commit check refusal (23514) answers 409.
payrollPayoutReconClearanceRouter.use(payoutGuardErrorMapper);
