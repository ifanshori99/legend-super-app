// The cashier's read of one dearer-swap charge (legend-f1mmf): what the till
// checks before taking the money and what is already out for it (its live or
// last gateway code, its EDC sales). Collected by `collect-at-pos`
// (@starter/shared/qr-order `collectChargeAtPosInputSchema`).

import {
  z,
  clientInputSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  userIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  edcReconciliationEvidenceSchema,
  edcTransactionSchema,
} from "../edc/index.ts";
import { staffPinInputSchema } from "../identity/inputs.ts";
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

/**
 * Starts a card sale for the charge on the outlet's terminal (edge only, 503
 * EDC_AGENT_NOT_READY elsewhere). The amount is the charge's and the reference
 * the charge id, never the client's. The same key replays the same sale.
 */
export const startPosIssueChargeEdc = defineEndpoint({
  method: "POST",
  path: "/api/order-issue-charges/:chargeId/edc",
  params: chargeParams,
  body: z.strictObject({
    terminalId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(edcTransactionSchema),
});

/**
 * What the supervisor states about a card sale whose answer is `unknown`
 * after checking the terminal: `failed` (the card was not charged), or `paid`
 * with the slip (RRN, approval code and the printed amount). Never assumed
 * paid without the slip.
 */
export const posIssueChargeEdcStatementSchema = z.enum(["failed", "paid"]);

export const posIssueChargeSlipSchema = z.strictObject({
  rrn: edcReconciliationEvidenceSchema.shape.rrn.unwrap(),
  approvalCode: edcReconciliationEvidenceSchema.shape.approvalCode.unwrap(),
  chargedAmountIdr:
    edcReconciliationEvidenceSchema.shape.chargedAmountIdr.unwrap(),
});

/**
 * - `recorded`: the attempt paid the charge (now or before); read the charge.
 * - `closed`: it did not, and it never will: a late arrival of the same key is
 *   refused, the terminal is not asked again.
 */
export const posIssueChargeAttemptOutcomeSchema = z.enum([
  "recorded",
  "closed",
]);
export type PosIssueChargeAttemptOutcome = z.infer<
  typeof posIssueChargeAttemptOutcomeSchema
>;

/** An unknown card sale without the supervisor's statement (409). */
export const ISSUE_CHARGE_EDC_STATEMENT_REQUIRED =
  "ISSUE_CHARGE_EDC_STATEMENT_REQUIRED" as const;
/** `paid` stated for an unknown card sale without its slip (409). */
export const ISSUE_CHARGE_SLIP_REQUIRED = "ISSUE_CHARGE_SLIP_REQUIRED" as const;

/**
 * A cash or card attempt of the charge whose answer never reached the till
 * (legend-f1mmf, 1268 W2 pattern). Another person who may approve it
 * (`void` for cash, `edc_standalone` for a card; a `paid` statement also
 * needs `payment.reconcile`) types their own PIN; the reason is audited. No
 * money is invented: a recorded attempt is read back, an approved card sale is
 * recorded once, an unrecorded attempt is closed for good.
 */
export const resolvePosIssueChargeAttempt = defineEndpoint({
  method: "POST",
  path: "/api/order-issue-charges/:chargeId/attempts/resolve",
  params: chargeParams,
  body: clientInputSchema({
    method: z.enum(["cash", "edc"]),
    /** The key the till sent with the attempt. */
    idempotencyKey: idempotencyKeySchema,
    edc: posIssueChargeEdcStatementSchema.optional(),
    slip: posIssueChargeSlipSchema.optional(),
    reason: z.string().trim().min(3).max(500),
    approverUserId: userIdSchema,
    pin: staffPinInputSchema,
  }).refine(
    (value) =>
      value.method === "edc" ||
      (value.edc === undefined && value.slip === undefined),
    { message: "Pernyataan kartu hanya untuk percobaan EDC.", path: ["edc"] },
  ),
  response: dataResponseSchema(
    z.strictObject({
      outcome: posIssueChargeAttemptOutcomeSchema,
      charge: posIssueChargeDetailSchema,
    }),
  ),
});
