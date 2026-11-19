// Staff close of a dearer-swap charge (legend-i83ls S4): waive or expire, and
// the cashier's cash collection at the till (legend-800h1).
//
// Mount (routes/index.ts): `apiRouter.use(orderRecoveryChargeRouter)`; the
// router carries the full paths.
//
// - requireAuth + requireTrustedOrigin + requireTenantContext +
//   requireMenuPermission("order.recovery.handle"); the service re-checks the
//   outlet of the concrete charge. The tenant comes from the server-minted
//   context, never the body. Approving a manual refund needs
//   `pos.refund.approve` instead; rejecting needs either permission.
// - Strict schemas parse params and body; the reason is mandatory.

import { Router, type RequestHandler } from "express";
import type { PermissionCode } from "@starter/shared/access";
import { userIdSchema, uuidSchema, z } from "@starter/shared/core";
import { collectChargeAtPosInputSchema } from "@starter/shared/qr-order";
import {
  actorOf,
  refuseActingStaffOtherOutlet,
  requireActingStaffOnSharedDevice,
  resolveActingStaff,
} from "../middleware/acting-staff.ts";
import { chargeOutletOf } from "../middleware/acting-staff-outlet.ts";
import {
  getAuth,
  requireAuth,
  requireAuthAllowSharedDevice,
} from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import { collectChargeAtPos } from "../services/order-recovery-charge-pos.ts";
import {
  approveChargeManualRefund,
  rejectChargeManualRefund,
  requestChargeManualRefund,
} from "../services/order-recovery-charge-manual-refund.ts";
import { refundIssueCharge } from "../services/order-recovery-charge-refund.ts";
import {
  closeIssueCharge,
  type IssueChargeCloseAction,
} from "../services/order-recovery-charge-staff.ts";
import { currentDeviceIdOf } from "./device-id.ts";

export const orderRecoveryChargeRouter = Router();

const staffGuard = [
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  // The path carries no outlet: a token of another outlet may not touch the charge.
  refuseActingStaffOtherOutlet(chargeOutletOf),
  requireMenuPermission("order.recovery.handle"),
];

// Approve and reject of a manual refund are decided by the person who holds
// `pos.refund.approve` (the second pair of eyes), not by whoever handles
// order recovery; the service re-checks the outlet and the requester rule.
const approveGuard = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireMenuPermission("pos.refund.approve"),
];

// Reject: the requester (order.recovery.handle) or an approver
// (pos.refund.approve); the service tells which of the two the caller is.
const rejectGuard = [
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  requireAnyMenuPermission("order.recovery.handle", "pos.refund.approve"),
];

/** Passes when the caller holds at least one of the permissions (else the last denial). */
function requireAnyMenuPermission(
  ...permissions: readonly PermissionCode[]
): RequestHandler {
  return async (req, res, next) => {
    let denied: unknown;
    for (const permission of permissions) {
      let passed = false;
      try {
        await requireMenuPermission(permission)(req, res, () => {
          passed = true;
        });
      } catch (error) {
        denied = error;
        continue;
      }
      if (passed) return next();
    }
    throw denied;
  };
}

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
          userIdSchema.parse(actorOf(req)),
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
        userIdSchema.parse(actorOf(req)),
        chargeId,
        input,
        new Date(),
      ),
    });
  },
);

// Manual refund of a charge paid at the till in cash or by EDC (legend-mrwtp):
// a request that reserves its amount, then another person approves it (cash
// leaves the chosen open shift) or the request is rejected.
const manualRefundParams = z.strictObject({ id: uuidSchema });
const manualReason = z.string().trim().min(3).max(300);
const manualRefundBody = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("cash"),
    amountIdr: z.number().int().positive().max(1_000_000_000),
    reason: manualReason,
  }),
  z.strictObject({
    method: z.literal("edc"),
    amountIdr: z.number().int().positive().max(1_000_000_000),
    reason: manualReason,
    reference: z.string().trim().min(3).max(100),
  }),
]);
orderRecoveryChargeRouter.post(
  "/order-issue-charges/:chargeId/manual-refund",
  ...staffGuard,
  jsonBody,
  async (req, res) => {
    const { chargeId } = params.parse(req.params);
    const input = manualRefundBody.parse(req.body);
    res.json({
      data: await requestChargeManualRefund(
        getScopedTenantContext(req),
        userIdSchema.parse(actorOf(req)),
        chargeId,
        input,
        new Date(),
      ),
    });
  },
);
orderRecoveryChargeRouter.post(
  "/order-issue-charge-manual-refunds/:id/approve",
  ...approveGuard,
  jsonBody,
  async (req, res) => {
    const { id } = manualRefundParams.parse(req.params);
    const input = z
      .strictObject({ shiftId: uuidSchema.optional() })
      .parse(req.body);
    res.json({
      data: await approveChargeManualRefund(
        getScopedTenantContext(req),
        userIdSchema.parse(getAuth(req).user.id),
        id,
        input,
        new Date(),
      ),
    });
  },
);
orderRecoveryChargeRouter.post(
  "/order-issue-charge-manual-refunds/:id/reject",
  ...rejectGuard,
  jsonBody,
  async (req, res) => {
    const { id } = manualRefundParams.parse(req.params);
    const input = z.strictObject({ reason: manualReason }).parse(req.body);
    res.json({
      data: await rejectChargeManualRefund(
        getScopedTenantContext(req),
        userIdSchema.parse(getAuth(req).user.id),
        id,
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
  requireAuthAllowSharedDevice,
  requireTrustedOrigin,
  requireTenantContext,
  resolveActingStaff,
  requireActingStaffOnSharedDevice,
  refuseActingStaffOtherOutlet(chargeOutletOf),
  requireMenuPermission("pos.payment.accept"),
  jsonBody,
  async (req, res) => {
    const { chargeId } = params.parse(req.params);
    const input = collectChargeAtPosInputSchema.parse(req.body);
    res.json({
      data: await collectChargeAtPos(
        getScopedTenantContext(req),
        {
          userId: userIdSchema.parse(actorOf(req)),
          deviceId: await currentDeviceIdOf(req),
        },
        chargeId,
        input,
        new Date(),
      ),
    });
  },
);
