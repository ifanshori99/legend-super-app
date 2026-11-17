// Staff close of a dearer-swap charge (legend-i83ls S4): waive or expire, and
// the cashier's cash collection at the till (legend-800h1).
//
// Mount (routes/index.ts): `apiRouter.use(orderRecoveryChargeRouter)`; the
// router carries the full paths.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext +
//   requireMenuPermission("order.recovery.handle"); the service re-checks the
//   outlet of the concrete charge. The tenant comes from the server-minted
//   context, never the body.
// - Strict schemas parse params and body; the reason is mandatory.

import { Router } from "express";
import { userIdSchema, uuidSchema, z } from "@starter/shared/core";
import { collectChargeAtPosInputSchema } from "@starter/shared/qr-order";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { collectChargeAtPos } from "../services/order-recovery-charge-pos.ts";
import { refundIssueCharge } from "../services/order-recovery-charge-refund.ts";
import {
  closeIssueCharge,
  type IssueChargeCloseAction,
} from "../services/order-recovery-charge-staff.ts";
import { currentDeviceIdOf } from "./device-id.ts";

export const orderRecoveryChargeRouter = Router();

const staffGuard = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireMenuPermission("order.recovery.handle"),
];

const params = z.strictObject({ chargeId: uuidSchema });
const body = z.strictObject({ reason: z.string().trim().min(3).max(300) });

for (const action of [
  "waive",
  "expire",
] as const satisfies readonly IssueChargeCloseAction[])
  orderRecoveryChargeRouter.post(
    `/order-issue-charges/:chargeId/${action}`,
    ...staffGuard,
    jsonBody,
    async (req, res) => {
      const { chargeId } = params.parse(req.params);
      const input = body.parse(req.body);
      res.json({
        data: await closeIssueCharge(
          getScopedTenantContext(req),
          userIdSchema.parse(getAuth(req).user.id),
          chargeId,
          action,
          input,
          new Date(),
        ),
      });
    },
  );

// Staff refund of a PAID charge (legend-nsvu0): a request that adds up with the
// earlier ones, never past the paid charge; the payment module pays it out.
const refundBody = z.strictObject({
  amountIdr: z.number().int().positive().max(1_000_000_000),
  reason: z.string().trim().min(3).max(300),
});
orderRecoveryChargeRouter.post(
  "/order-issue-charges/:chargeId/refund",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { chargeId } = params.parse(req.params);
    const input = refundBody.parse(req.body);
    res.json({
      data: await refundIssueCharge(
        getScopedTenantContext(req),
        userIdSchema.parse(getAuth(req).user.id),
        chargeId,
        input,
        new Date(),
      ),
    });
  },
);

// The cashier takes the charge in cash at the till (legend-800h1): the same
// permission as a POS tender (`pos.payment.accept`, checked again on the
// charge's outlet by the service) and the signed device of the open shift.
orderRecoveryChargeRouter.post(
  "/order-issue-charges/:chargeId/collect-at-pos",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireMenuPermission("pos.payment.accept"),
  jsonBody,
  async (req, res) => {
    const { chargeId } = params.parse(req.params);
    const input = collectChargeAtPosInputSchema.parse(req.body);
    res.json({
      data: await collectChargeAtPos(
        getScopedTenantContext(req),
        {
          userId: userIdSchema.parse(getAuth(req).user.id),
          deviceId: await currentDeviceIdOf(req),
        },
        chargeId,
        input,
        new Date(),
      ),
    });
  },
);
