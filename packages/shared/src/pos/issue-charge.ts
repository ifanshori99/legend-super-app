// The cashier's read of one dearer-swap charge (legend-f1mmf): what the till
// checks before taking the money and what is already out for it (its live or
// last gateway code, its EDC sales). Collected by `collect-at-pos`
// (@starter/shared/qr-order `collectChargeAtPosInputSchema`).

import {
  z,
  dataResponseSchema,
  isoDateTimeSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { guestPaymentSchema } from "../qr-order/guest.ts";
import { orderIssueChargeStatusSchema } from "../qr-order/schemas.ts";
import { posEdcAttemptSchema } from "./schemas.ts";

const idr = z.number().int().nonnegative();

const swapLineSchema = z.strictObject({
  name: z.string(),
  quantity: z.number().int().min(1),
  lineTotalIdr: idr,
});

/**
 * One EDC sale whose reference is this charge, newest first: the server's
 * list, never typed by the cashier. Every status is listed (a pending or
 * unknown one locks the charge).
 */
export const posIssueChargeEdcSaleSchema = posEdcAttemptSchema.extend({
  needsReconciliation: z.boolean(),
});
export type PosIssueChargeEdcSale = z.infer<typeof posIssueChargeEdcSaleSchema>;

export const posIssueChargeDetailSchema = z.strictObject({
  id: uuidSchema,
  orderId: z.string(),
  status: orderIssueChargeStatusSchema,
  differenceIdr: idr,
  amountIdr: idr,
  paidAt: isoDateTimeSchema.nullable(),
  orderNumber: z.string(),
  tableLabel: z.string().nullable(),
  original: swapLineSchema,
  replacement: swapLineSchema,
  /**
   * The code that can still take money (a paid one first, then a pending
   * one), else the last one the till asked for. A code past its expiry stays
   * `pending` until its margin passed and the provider holds no money for it.
   */
  payment: guestPaymentSchema.nullable(),
  edcSales: z.array(posIssueChargeEdcSaleSchema),
});
export type PosIssueChargeDetail = z.infer<typeof posIssueChargeDetailSchema>;

const chargeParams = z.strictObject({ chargeId: uuidSchema });

/** 404 for a charge of another tenant or of an outlet the caller cannot pay at. */
export const getPosIssueCharge = defineEndpoint({
  method: "GET",
  path: "/api/order-issue-charges/:chargeId",
  params: chargeParams,
  response: dataResponseSchema(posIssueChargeDetailSchema),
});
