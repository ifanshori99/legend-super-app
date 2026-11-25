// Endpoints of the dearer-swap charge screen (legend-shabi) that have no
// shared contract yet. `collect-at-pos` exists in the API
// (apps/api/src/routes/order-recovery-charge.routes.ts, request schema in
// @starter/shared/qr-order); the response is typed from the route's
// `{ charge: IssueChargeView, changeIdr }`. The charge read has no API route
// yet (contract gap, mock mode only).
import { defineEndpoint } from "@starter/shared/api";
import { uuidSchema, z } from "@starter/shared/core";
import { posEdcAttemptSchema } from "@starter/shared/pos";
import {
  collectChargeAtPosInputSchema,
  guestPaymentSchema,
  orderIssueChargeStatusSchema,
} from "@starter/shared/qr-order";

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

const swapLineSchema = z.object({
  name: z.string(),
  quantity: z.number().int().min(1),
  lineTotalIdr: idr,
});

/**
 * One EDC sale whose reference is this charge: the server's list, never typed
 * by the cashier. Every status is listed (a pending or unknown one locks the
 * charge, legend-t93l8).
 */
const chargeEdcSaleSchema = posEdcAttemptSchema.extend({
  needsReconciliation: z.boolean(),
});
export type ChargeEdcSale = z.infer<typeof chargeEdcSaleSchema>;

/**
 * GAP: what the cashier needs to check before taking the money (both dishes,
 * the order) and what is already out for the charge: its latest code and its
 * EDC sales. No API route yet; mock mode only.
 */
export const issueChargeDetailSchema = issueChargeViewSchema.extend({
  orderNumber: z.string(),
  tableLabel: z.string().nullable(),
  original: swapLineSchema,
  replacement: swapLineSchema,
  payment: guestPaymentSchema.nullable(),
  edcSales: z.array(chargeEdcSaleSchema),
});
export type IssueChargeDetail = z.infer<typeof issueChargeDetailSchema>;

export const getIssueCharge = defineEndpoint({
  method: "GET",
  path: "/api/order-issue-charges/:chargeId",
  params: chargeParams,
  response: z.object({ data: issueChargeDetailSchema }),
});

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
