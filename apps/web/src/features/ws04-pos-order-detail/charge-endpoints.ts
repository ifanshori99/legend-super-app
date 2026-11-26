// Endpoints of the dearer-swap charge screen (legend-shabi, legend-f1mmf). The
// read, the card start and the supervisor's settle are shared contracts
// (@starter/shared/pos). `collect-at-pos` exists in the API
// (apps/api/src/routes/order-recovery-charge.routes.ts, request schema in
// @starter/shared/qr-order); its response is typed from the route's
// `{ charge: IssueChargeView, changeIdr }`.
import { defineEndpoint } from "@starter/shared/api";
import { uuidSchema, z } from "@starter/shared/core";
import type {
  PosIssueChargeDetail,
  PosIssueChargeEdcSale,
} from "@starter/shared/pos";
import {
  collectChargeAtPosInputSchema,
  guestPaymentSchema,
  orderIssueChargeStatusSchema,
} from "@starter/shared/qr-order";

export {
  getPosIssueCharge as getIssueCharge,
  resolvePosIssueChargeAttempt as resolveIssueChargeAttempt,
  startPosIssueChargeEdc as startIssueChargeEdc,
} from "@starter/shared/pos";

const chargeParams = z.strictObject({ chargeId: uuidSchema });

const idr = z.number().int().nonnegative();

/** `IssueChargeView` of apps/api/src/services/order-recovery-charge-staff.ts. */
export const issueChargeViewSchema = z.object({
  id: uuidSchema,
  orderId: z.string(),
  status: orderIssueChargeStatusSchema,
  differenceIdr: idr,
  amountIdr: idr,
  paidAt: z.string().nullable(),
});
export type IssueChargeView = z.infer<typeof issueChargeViewSchema>;

/** The server's read of the charge: both dishes, its code and its EDC sales. */
export type IssueChargeDetail = PosIssueChargeDetail;
export type ChargeEdcSale = PosIssueChargeEdcSale;

export const collectIssueChargeAtPos = defineEndpoint({
  method: "POST",
  path: "/api/order-issue-charges/:chargeId/collect-at-pos",
  params: chargeParams,
  body: collectChargeAtPosInputSchema,
  response: z.object({
    data: z.object({
      charge: issueChargeViewSchema,
      changeIdr: idr,
      /** QRIS only: the pending code the guest scans (legend-gt98h). */
      payment: guestPaymentSchema.optional(),
    }),
  }),
});
