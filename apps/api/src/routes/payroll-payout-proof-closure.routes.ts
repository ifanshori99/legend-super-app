// Close a stuck payout proof key, over HTTP (bead legend-6htrf, 905 card 3).
// Mounted at `/api/hris/payroll` next to the payout routers. A stuck key holds
// the global proof gate until two different finance people close it: one
// proposes (with a note), the other approves. Both need the approve
// permission, a recent second factor and (after an enrollment-only stamp) the
// account password, like resolve, return and overpaid. Closing never pays
// anything and never changes an item; the key stays bound for good.

import { Router, type Request } from "express";
import {
  approvePayoutProofClosureSchema,
  listPayoutStuckProofsQuerySchema,
  payoutProofClosureParamsSchema,
  proposePayoutProofClosureSchema,
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
import { PAYOUT_STEP_UP_MAX_AGE_MINUTES } from "../services/payroll-payout-evidence.ts";
import {
  approveProofClosure,
  listStuckProofs,
  proposeProofClosure,
} from "../services/payroll-payout-proof-closure.service.ts";

export const payrollPayoutProofClosureRouter = Router();

const stepUp = requireTenantStepUpMfa({
  maxAgeMinutes: PAYOUT_STEP_UP_MAX_AGE_MINUTES,
});
const passwordStepUp = requireTenantStepUpPassword();

function actorOf(req: Request) {
  const auth = getAuth(req);
  const context = getScopedTenantContext(req);
  return {
    context,
    actor: {
      tenantId: context.tenant.tenantId,
      userId: auth.user.id,
      sessionId: auth.session.id,
    },
  };
}

// The list only reads: no step-up, same permission as the steps it informs.
payrollPayoutProofClosureRouter.get(
  "/payout-proofs/stuck",
  requireAuth,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  async (req, res) => {
    const query = listPayoutStuckProofsQuerySchema.parse(req.query);
    const context = getScopedTenantContext(req);
    const page = await withTenant(db, context, (tx) =>
      listStuckProofs(tx, context.tenant.tenantId, query),
    );
    res.set("Cache-Control", "no-store").json({
      data: page.items,
      meta: { limit: query.limit, nextCursor: page.nextCursor },
    });
  },
);

payrollPayoutProofClosureRouter.post(
  "/payout-proofs/closures",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const input = proposePayoutProofClosureSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      proposeProofClosure(tx, actor, input),
    );
    res.json({ data });
  },
);

payrollPayoutProofClosureRouter.post(
  "/payout-proofs/closures/:id/approve",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireTenantPermission("payroll.disburse.approve"),
  stepUp,
  jsonBody,
  passwordStepUp,
  async (req, res) => {
    const { id } = payoutProofClosureParamsSchema.parse(req.params);
    approvePayoutProofClosureSchema.parse(req.body);
    const { context, actor } = actorOf(req);
    const data = await withTenant(db, context, (tx) =>
      approveProofClosure(tx, actor, id),
    );
    res.json({ data });
  },
);
