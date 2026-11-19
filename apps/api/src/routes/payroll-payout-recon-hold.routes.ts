// Two-person release of a hold of a payout reconciliation flag that could not be
// written (legend-6o7pc). Mounted at `/api/hris/payroll` next to the other payout
// routers.
// - GET  /payout-recon-holds: every hold with its state and release.
// - POST /payout-recon-holds/:holdId/release: propose releasing a hold with a
//   written reason (201 `{ releaseId }`).
// - POST /payout-recon-hold-releases/:releaseId/approve: a different finance
//   person approves (200); the database refuses the proposer, a hold a flag took
//   over and evidence that is not clean.
// All three sit behind `payroll.disburse.approve`; the two POSTs also re-ask the
// account password, like the clearance (the grant accepts the password only).

import { Router } from "express";
import {
  approvePayoutReconHoldReleaseInputSchema,
  payoutReconHoldReleaseParamsSchema,
  payoutReconHoldParamsSchema,
  proposePayoutReconHoldReleaseInputSchema,
} from "@starter/shared/validators/payroll-payout-recon-hold";
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
  approvePayoutReconHoldRelease,
  listPayoutReconHolds,
  proposePayoutReconHoldRelease,
} from "../services/payroll-payout-recon-hold.service.ts";
import { payoutGuardErrorMapper } from "../services/payroll-payout.service.ts";

export const payrollPayoutReconHoldRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
// Like the unfreeze: a fresh MFA challenge on a stolen session cookie must not
// release a hold, so the grant of kind hold_release accepts the password only.
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

payrollPayoutReconHoldRouter.get(
  "/payout-recon-holds",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  async (req, res) => {
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      listPayoutReconHolds(tx, actor),
    );
    res.json({ data });
  },
);

payrollPayoutReconHoldRouter.post(
  "/payout-recon-holds/:holdId/release",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { holdId } = payoutReconHoldParamsSchema.parse(req.params);
    const input = proposePayoutReconHoldReleaseInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      proposePayoutReconHoldRelease(tx, actor, holdId, {
        reason: input.reason,
      }),
    );
    res.status(201).json({ data });
  },
);

payrollPayoutReconHoldRouter.post(
  "/payout-recon-hold-releases/:releaseId/approve",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { releaseId } = payoutReconHoldReleaseParamsSchema.parse(req.params);
    approvePayoutReconHoldReleaseInputSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      approvePayoutReconHoldRelease(tx, actor, releaseId),
    );
    res.json({ data });
  },
);

// A guard or deferred commit check refusal (23514) answers 409.
payrollPayoutReconHoldRouter.use(payoutGuardErrorMapper);
