// Back-office contracts for payment orchestration (PRD v1.7 §3 F13):
// gateway routing per tenant/outlet, EDC terminals and the cashier default
// method, refunds with approval, unallocated funds (PAY-04) and settlement
// reconciliation cases (EDC-06). The tenant always comes from the trusted
// session context (TEN-02); every list is cursor-paginated (D-CORE-5).
//
// Data contracts only: signature verification, provider credentials (PAY-06)
// and the WS-01 approval decision itself stay at the service boundary.

import {
  z,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  idrSchema,
  isoDateTimeSchema,
  businessDateSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
  cafeLegendFixtures,
} from "../core/index.ts";
import { refundEscalationReasonSchema } from "./refund-events.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  edcTransactionSchema,
  edcTransactionStatusSchema,
  resolveEdcReconciliationBodySchema,
  resolveEdcReconciliationParamsSchema,
} from "../edc/index.ts";
import {
  edcTerminalSchema,
  paymentMethodSchema,
  refundSchema,
  unallocatedFundsSchema,
} from "./index.ts";

const ref = z.string().min(1).max(100);
const nonnegativeIdr = idrSchema.refine((n) => n >= 0);
const positiveIdr = idrSchema.refine((n) => n > 0);
const noteSchema = z.string().min(4).max(500);
const ADMIN = "/api/payments/admin";

/** Online methods a gateway can route. Cash, EDC and points never route here. */
export const routedPaymentMethodSchema = z.enum([
  "qris",
  "card",
  "ewallet",
  "va",
  "bank_transfer",
  "paylater",
]);
export type RoutedPaymentMethod = z.infer<typeof routedPaymentMethodSchema>;

/** PRD §3.13: methods come from the provider's endpoint, never hard-coded. */
export const paymentProviderSchema = z.strictObject({
  code: ref,
  name: ref,
  kind: z.enum(["gateway", "manual"]),
  enabled: z.boolean(),
});
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

/** `outletId: null` = the tenant-wide default; a row overrides it per outlet. */
export const paymentRouteSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: uuidSchema.nullable(),
  method: routedPaymentMethodSchema,
  provider: ref,
  fallbackProvider: ref.nullable(),
  enabled: z.boolean(),
  updatedAt: isoDateTimeSchema,
});
export type PaymentRoute = z.infer<typeof paymentRouteSchema>;

const outletOptionSchema = z.strictObject({
  id: outletIdSchema,
  name: ref,
});
export type PaymentOutletOption = z.infer<typeof outletOptionSchema>;

/** The routing screen: the selected scope's routes plus what it can choose. */
export const paymentRoutingViewSchema = z.strictObject({
  scope: z.enum(["tenant", "outlet"]),
  outletId: outletIdSchema.nullable(),
  outletName: ref.nullable(),
  outlets: z.array(outletOptionSchema),
  providers: z.array(paymentProviderSchema),
  routes: z.array(paymentRouteSchema),
});
export type PaymentRoutingView = z.infer<typeof paymentRoutingViewSchema>;

export const updatePaymentRouteInputSchema = clientInputSchema({
  outletId: outletIdSchema.nullable(),
  provider: ref,
  fallbackProvider: ref.nullable(),
  enabled: z.boolean(),
});
export type UpdatePaymentRouteInput = z.infer<
  typeof updatePaymentRouteInputSchema
>;

// ---- EDC terminals (EDC-01..07) -----------------------------------------

/** EDC row plus the outlet name the table shows; the id stays the record id. */
export const edcTerminalViewSchema = z.strictObject({
  ...edcTerminalSchema.shape,
  /** The four banks the PRD integrates (BCA, Mandiri, BNI, BJB). */
  bankCode: z.enum(["bca", "mandiri", "bni", "bjb"]),
  outletName: ref,
});
export type EdcTerminalView = z.infer<typeof edcTerminalViewSchema>;

const edcTerminalFields = {
  outletId: outletIdSchema,
  bankCode: z.enum(["bca", "mandiri", "bni", "bjb"]),
  terminalId: ref,
  merchantId: ref,
  model: ref,
  connection: z.enum(["lan", "usb", "bluetooth"]),
  ipAddress: z.union([z.ipv4(), z.ipv6()]).nullable(),
  supportedMethods: z.array(z.enum(["card", "qris"])).min(1),
};
export const createEdcTerminalInputSchema = clientInputSchema({
  ...edcTerminalFields,
  status: z.enum(["active", "inactive"]),
});
export type CreateEdcTerminalInput = z.infer<
  typeof createEdcTerminalInputSchema
>;

export const updateEdcTerminalInputSchema = clientInputSchema({
  bankCode: edcTerminalFields.bankCode.optional(),
  terminalId: edcTerminalFields.terminalId.optional(),
  merchantId: edcTerminalFields.merchantId.optional(),
  model: edcTerminalFields.model.optional(),
  connection: edcTerminalFields.connection.optional(),
  ipAddress: edcTerminalFields.ipAddress.optional(),
  supportedMethods: edcTerminalFields.supportedMethods.optional(),
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateEdcTerminalInput = z.infer<
  typeof updateEdcTerminalInputSchema
>;

/** PRD "Routing kasir": QRIS via one bank's EDC or via DOIT, terminal per cashier. */
export const cashierDefaultMethodSchema = z.enum([
  "edc_card",
  "edc_qris",
  "qris_doit",
]);
export type CashierDefaultMethod = z.infer<typeof cashierDefaultMethodSchema>;

export const edcCashierDefaultSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  cashierId: uuidSchema,
  cashierName: ref,
  terminalId: uuidSchema.nullable(),
  defaultMethod: cashierDefaultMethodSchema,
  updatedAt: isoDateTimeSchema,
});
export type EdcCashierDefault = z.infer<typeof edcCashierDefaultSchema>;

/** Cashier defaults split by outlet; terminals travel along for the label. */
export const edcCashierDefaultsViewSchema = z.strictObject({
  outletId: outletIdSchema,
  outletName: ref,
  terminals: z.array(edcTerminalViewSchema),
  cashiers: z.array(edcCashierDefaultSchema),
});
export type EdcCashierDefaultsView = z.infer<
  typeof edcCashierDefaultsViewSchema
>;

export const updateEdcCashierDefaultInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  terminalId: uuidSchema.nullable(),
  defaultMethod: cashierDefaultMethodSchema,
});
export type UpdateEdcCashierDefaultInput = z.infer<
  typeof updateEdcCashierDefaultInputSchema
>;

/**
 * One flagged (or stuck `unknown`) ECR sale in the reconciliation queue, with
 * the labels the screen needs. Proposed contract (legend-khi8n): the list
 * endpoint below has no backend yet; a separate card builds it.
 */
export const edcReconciliationQueueItemSchema = z.strictObject({
  transaction: edcTransactionSchema,
  outletName: ref,
  cashierName: ref.nullable(),
  /** "EDC-SNP-02 · BCA" */
  terminalLabel: ref,
  /** Bill the sale was for, e.g. "INV-1511-084". */
  billNumber: ref.nullable(),
  /** What is still unpaid on the bill; null when the bill is unknown. */
  remainingIdr: idrSchema.nullable(),
  /** Set while the terminal is still processing the sale (adapter call open). */
  saleWireOpenAt: isoDateTimeSchema.nullable(),
});
export type EdcReconciliationQueueItem = z.infer<
  typeof edcReconciliationQueueItemSchema
>;

// ---- Refunds (PRD "Refund": full/partial, gateway or manual + approval) --

export const refundStatusSchema = z.enum([
  "pending",
  "approved",
  "completed",
  "failed",
]);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

/** Why a refund ended `failed` (null for legacy failed rows). */
export const refundFailureReasonSchema = z.enum([
  "rejected",
  "approval_expired",
  "provider_declined",
  "cap_exceeded",
  "source_document",
  "approver_unauthorized",
]);
export type RefundFailureReason = z.infer<typeof refundFailureReasonSchema>;

/**
 * Non-human requesters: a module that files the refund request by rule (e.g.
 * the reservation DP refund decided from the policy snapshot, PRD §3.22). The
 * approval still needs a person with `payment.reconcile` (never the system).
 */
export const systemRefundActorSchema = z.enum([
  "system:reservation",
  "system:pos",
  "system:qr",
  "system:recovery",
  "system:facility",
]);
export type SystemRefundActor = z.infer<typeof systemRefundActorSchema>;
/** Display names for system requesters (no `user` row exists for them). */
export const systemRefundActorNames: Record<SystemRefundActor, string> = {
  "system:reservation": "Sistem (reservasi)",
  "system:pos": "Sistem (kasir)",
  "system:qr": "Sistem (pesanan QR)",
  "system:recovery": "Sistem (pemulihan pesanan)",
  "system:facility": "Sistem (sarapan fasilitas)",
};

export const refundViewSchema = z.strictObject({
  ...refundSchema.shape,
  paymentReference: ref,
  method: paymentMethodSchema,
  paidAmountIdr: positiveIdr,
  outletName: ref,
  /** Staff who asked for the refund; the approver must be someone else (PRD §3 "Matriks Approval"). */
  requestedBy: z.union([uuidSchema, systemRefundActorSchema]),
  requestedByName: ref,
  /**
   * Server-computed for the signed-in viewer: pending, the approval matrix lets
   * this viewer decide, and the viewer is not the requester. The UI only shows
   * the approve action when true; the API re-checks (APPROVER_IS_REQUESTER).
   */
  viewerCanApprove: z.boolean(),
  approvedByName: ref.nullable(),
  /** The approval request (chain) that governs this refund; null for legacy rows. */
  approvalRequestId: uuidSchema.nullable().optional(),
  note: z.string().max(500).nullable(),
  createdAt: isoDateTimeSchema,
  decidedAt: isoDateTimeSchema.nullable(),
  failureReason: refundFailureReasonSchema.nullable().optional(),
  /** Provider payout tries so far; an `approved` refund with a last error is awaiting retry. */
  payoutAttempts: z.number().int().nonnegative().optional(),
  lastPayoutError: z.string().max(100).nullable().optional(),
  /** Set once when the refund waited past the tenant threshold; never changes money state. */
  escalatedAt: isoDateTimeSchema.nullable().optional(),
  escalationReason: refundEscalationReasonSchema.nullable().optional(),
  completedAt: isoDateTimeSchema.nullable().optional(),
});
export type RefundView = z.infer<typeof refundViewSchema>;

/**
 * Refund writes are idempotent by (tenant, idempotencyKey) (contracts.md
 * "Idempotent mutations"): a retry or double click returns the first result,
 * the same key with a different body fails IDEMPOTENCY_KEY_REUSED (409).
 */
export const createRefundInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  paymentIntentId: uuidSchema,
  amountIdr: positiveIdr,
  reason: z.string().min(1).max(500),
  note: z.string().max(500).optional(),
});
export type CreateRefundInput = z.infer<typeof createRefundInputSchema>;

/**
 * A settled payment the refund screen may pick; the server checks the rest.
 * `refundedAmountIdr` counts every refund that is not `failed` (pending ones
 * reserve their amount), so paid = refunded + refundable and two pending
 * refunds can never exceed what was paid.
 */
export const refundablePaymentSchema = z
  .strictObject({
    paymentIntentId: uuidSchema,
    reference: ref,
    outletId: outletIdSchema,
    outletName: ref,
    method: paymentMethodSchema,
    paidAmountIdr: positiveIdr,
    refundedAmountIdr: nonnegativeIdr,
    refundableAmountIdr: nonnegativeIdr,
    paidAt: isoDateTimeSchema,
  })
  .refine(
    (p) => p.refundedAmountIdr + p.refundableAmountIdr === p.paidAmountIdr,
    {
      path: ["refundableAmountIdr"],
      message: "paid must equal refunded + refundable",
    },
  );
export type RefundablePayment = z.infer<typeof refundablePaymentSchema>;

export const listRefundablePayments = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/refunds/refundable`,
  query: z.strictObject({ outletId: outletIdSchema.optional() }),
  response: dataResponseSchema(
    z.strictObject({ payments: z.array(refundablePaymentSchema) }),
  ),
});

export const approveRefundInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  note: z.string().max(500).optional(),
});
export type ApproveRefundInput = z.infer<typeof approveRefundInputSchema>;

export const rejectRefundInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  reason: z.string().trim().min(3).max(500),
});
export type RejectRefundInput = z.infer<typeof rejectRefundInputSchema>;

export const retryRefundPayoutInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  sourceEvidenceId: uuidSchema.optional(),
});
export type RetryRefundPayoutInput = z.infer<
  typeof retryRefundPayoutInputSchema
>;

/** Ops note on a quarantine action: 3 to 500 code points once trimmed. */
const quarantineNoteSchema = z
  .string()
  .trim()
  .refine((note) => {
    const length = Array.from(note).length;
    return length >= 3 && length <= 500;
  }, "Note must be 3 to 500 characters.");

/** Body of a quarantine release or re-open (legend-e8z5). */
export const quarantinedRefundActionInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  note: quarantineNoteSchema,
});
export type QuarantinedRefundActionInput = z.infer<
  typeof quarantinedRefundActionInputSchema
>;

/** Where finance paid a refund by hand (legend-xd2q). */
export const manualRefundSettlementChannelSchema = z.enum([
  "bank_transfer",
  "cash",
  "ewallet",
  "provider_dashboard",
  "other",
]);
export type ManualRefundSettlementChannel = z.infer<
  typeof manualRefundSettlementChannelSchema
>;

/**
 * Body of a manual refund settlement (legend-xd2q): finance paid the customer
 * by hand and no provider payout is ever sent. `externalReference` is the
 * transfer or receipt reference of that payment, never the customer's account
 * number: it is stored in the audit trail as is.
 */
export const manualRefundSettlementInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  paidAt: isoDateTimeSchema,
  channel: manualRefundSettlementChannelSchema,
  externalReference: z
    .string()
    .trim()
    .min(3)
    .max(100)
    .refine(
      // eslint-disable-next-line no-control-regex
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Reference must not contain control characters.",
    ),
  amountIdr: positiveIdr,
  note: quarantineNoteSchema,
});
export type ManualRefundSettlementInput = z.infer<
  typeof manualRefundSettlementInputSchema
>;

// ---- Unallocated funds (PAY-04) -----------------------------------------

export const unallocatedStatusSchema = z.enum(["open", "resolved"]);
export type UnallocatedStatus = z.infer<typeof unallocatedStatusSchema>;

export const unallocatedFundViewSchema = z
  .strictObject({
    ...unallocatedFundsSchema.shape,
    paymentReference: ref,
    method: paymentMethodSchema,
    paidAmountIdr: positiveIdr,
    billTotalIdr: positiveIdr,
    outletName: ref,
    status: unallocatedStatusSchema,
    detectedAt: isoDateTimeSchema,
    resolvedByName: ref.nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
    note: z.string().max(500).nullable(),
  })
  // PAY-04: a fund holds money that arrived but was not applied to the bill
  // (overpaid, double-paid or underpaid). A bill may carry several funds, one
  // per provider evidence (legend-knev); the server refuses a bill whose funds
  // do not add up to exactly what arrived minus what was applied.
  .refine((f) => f.amountIdr <= f.paidAmountIdr, {
    path: ["amountIdr"],
    message: "amount must not exceed the amount paid",
  });
export type UnallocatedFundView = z.infer<typeof unallocatedFundViewSchema>;

/** Money moves (refund or credit), so the write carries an idempotency key. */
export const resolveUnallocatedFundInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
  resolution: z.enum(["refund", "credit"]),
  note: noteSchema,
});
export type ResolveUnallocatedFundInput = z.infer<
  typeof resolveUnallocatedFundInputSchema
>;

// ---- Settlement reconciliation (EDC-06) ---------------------------------

export const reconciliationSourceSchema = z.enum(["gateway", "edc"]);
export type ReconciliationSource = z.infer<typeof reconciliationSourceSchema>;

/**
 * Funds of a written-off case arrived in a later settlement import. Nothing is
 * reversed automatically: finance must review the correction (legend-oan3p).
 * When the late amount differs from the sale, `mismatchCaseId` points to the
 * mismatch case of the same line: finance must decide the correction and that
 * case together so the loss is never booked twice.
 */
export const reconciliationLateFundsSchema = z.strictObject({
  correctionId: uuidSchema,
  settlementId: uuidSchema,
  settlementLineId: uuidSchema,
  mismatchCaseId: uuidSchema.nullable(),
  receivedIdr: nonnegativeIdr,
  detectedAt: isoDateTimeSchema,
  correctionStatus: z.enum(["open", "pending_approval", "resolved"]),
});
export type ReconciliationLateFunds = z.infer<
  typeof reconciliationLateFundsSchema
>;

export const reconciliationCaseViewSchema = z
  .strictObject({
    id: uuidSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    settlementId: uuidSchema,
    settlementLineId: uuidSchema.nullable(),
    source: reconciliationSourceSchema,
    /** "doit" or "edc_<bank>" — the settlement report the line came from. */
    provider: ref,
    reference: ref,
    periodStart: businessDateSchema,
    periodEnd: businessDateSchema,
    expectedIdr: nonnegativeIdr,
    receivedIdr: nonnegativeIdr,
    /** received − expected; negative means less money arrived than booked. */
    varianceIdr: idrSchema,
    reason: z.string().min(1).max(500),
    /**
     * `pending_approval`: closing was requested and waits for an approver who
     * is not the requester; the case closes only when that approval passes.
     * `matched`: a later settlement report listed the sale, so the "missing"
     * case closed by itself (no write-off, no approval needed).
     */
    status: z.enum(["open", "pending_approval", "matched", "resolved"]),
    /** Who asked to close the case (set once closing was requested). */
    requestedBy: uuidSchema.nullable(),
    requestedByName: ref.nullable(),
    /** The approval request (chain) behind the closing; null while open. */
    approvalRequestId: uuidSchema.nullable(),
    /** Final approver, set only when the case is resolved. */
    approvedBy: uuidSchema.nullable(),
    approvedByName: ref.nullable(),
    resolvedByName: ref.nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
    note: z.string().max(500).nullable(),
    /** Set when funds of this written-off case arrived later; null otherwise. */
    lateFunds: reconciliationLateFundsSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .refine((c) => c.receivedIdr - c.expectedIdr === c.varianceIdr, {
    path: ["varianceIdr"],
    message: "variance must equal received − expected",
  });
export type ReconciliationCaseView = z.infer<
  typeof reconciliationCaseViewSchema
>;

/** Review of funds that arrived after a case was written off (legend-oan3p). */
export const reconciliationCorrectionViewSchema = z.strictObject({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  caseId: uuidSchema,
  settlementId: uuidSchema,
  settlementLineId: uuidSchema,
  /**
   * Mismatch case of the same line (late amount differs from the sale); null
   * when it matched exactly. Finance must decide this correction and that case
   * together so the loss is never booked twice.
   */
  mismatchCaseId: uuidSchema.nullable(),
  source: reconciliationSourceSchema,
  reference: ref,
  /** What the write-off removed from the books. */
  writtenOffIdr: nonnegativeIdr,
  /** What the later settlement line actually received. */
  receivedIdr: nonnegativeIdr,
  /**
   * `pending_approval`: a decision was requested and waits for an approver who
   * is not the requester; the correction closes only when that approval passes.
   */
  status: z.enum(["open", "pending_approval", "resolved"]),
  decision: z.enum(["reverse_write_off", "keep_write_off"]).nullable(),
  requestedBy: uuidSchema.nullable(),
  requestedByName: ref.nullable(),
  approvalRequestId: uuidSchema.nullable(),
  approvedBy: uuidSchema.nullable(),
  approvedByName: ref.nullable(),
  resolvedByName: ref.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  note: z.string().max(500).nullable(),
  createdAt: isoDateTimeSchema,
});
export type ReconciliationCorrectionView = z.infer<
  typeof reconciliationCorrectionViewSchema
>;

export const reconciliationSummarySchema = z.strictObject({
  matchedLines: z.number().int().nonnegative(),
  unmatchedLines: z.number().int().nonnegative(),
  mismatchLines: z.number().int().nonnegative(),
  openCases: z.number().int().nonnegative(),
  resolvedThisMonth: z.number().int().nonnegative(),
  varianceIdr: idrSchema,
});
export type ReconciliationSummary = z.infer<typeof reconciliationSummarySchema>;

export const resolveReconciliationCaseInputSchema = clientInputSchema({
  note: noteSchema,
});
export type ResolveReconciliationCaseInput = z.infer<
  typeof resolveReconciliationCaseInputSchema
>;

export const resolveReconciliationCorrectionInputSchema = clientInputSchema({
  decision: z.enum(["reverse_write_off", "keep_write_off"]),
  note: noteSchema,
});
export type ResolveReconciliationCorrectionInput = z.infer<
  typeof resolveReconciliationCorrectionInputSchema
>;

// Settlement import (legend-jlqi). Reconciliation only reads and records
// differences: an import never creates a payout, refund or journal posting.

export const settlementLineInputSchema = z.strictObject({
  reference: ref,
  amountIdr: positiveIdr,
  feeIdr: nonnegativeIdr,
});
export type SettlementLineInput = z.infer<typeof settlementLineInputSchema>;

const edcSettlementProviderPattern = /^edc_(bca|mandiri|bni|bjb)$/;

export const importSettlementInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  source: reconciliationSourceSchema,
  /** "doit"/"duitku" for a gateway, "edc_<bank>" for an EDC batch report. */
  provider: ref,
  /** The report id; with source and provider it identifies the report. */
  reference: ref,
  /** EDC only: the terminal the batch was settled for. */
  terminalId: uuidSchema.optional(),
  /** EDC only: the batch number printed on the settlement report. */
  batchNo: z.string().min(1).max(20).optional(),
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  grossIdr: nonnegativeIdr,
  feeIdr: nonnegativeIdr,
  netIdr: nonnegativeIdr,
  lines: z.array(settlementLineInputSchema).min(1).max(1000),
}).superRefine((s, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const lineGross = s.lines.reduce((sum, l) => sum + l.amountIdr, 0);
  const lineFee = s.lines.reduce((sum, l) => sum + l.feeIdr, 0);
  if (s.grossIdr !== lineGross)
    issue(["grossIdr"], "gross must equal the sum of the line amounts");
  if (s.feeIdr !== lineFee)
    issue(["feeIdr"], "fee must equal the sum of the line fees");
  if (s.netIdr !== s.grossIdr - s.feeIdr)
    issue(["netIdr"], "net must equal gross minus fee");
  if (s.periodEnd < s.periodStart)
    issue(["periodEnd"], "period end must not be before period start");
  else if (
    (Date.parse(`${s.periodEnd}T00:00:00Z`) -
      Date.parse(`${s.periodStart}T00:00:00Z`)) /
      86_400_000 >
    30
  )
    issue(["periodEnd"], "a settlement period is at most 31 days");
  const seen = new Set<string>();
  s.lines.forEach((line, i) => {
    if (seen.has(line.reference))
      issue(["lines", i, "reference"], "line references must be unique");
    seen.add(line.reference);
  });
  if (s.source === "edc") {
    if (!edcSettlementProviderPattern.test(s.provider))
      issue(["provider"], "an EDC settlement provider is edc_<bank>");
    if (s.terminalId === undefined)
      issue(["terminalId"], "an EDC settlement needs the terminal");
    if (s.batchNo === undefined)
      issue(["batchNo"], "an EDC settlement needs the batch number");
  } else {
    if (s.terminalId !== undefined)
      issue(["terminalId"], "a gateway settlement has no terminal");
    if (s.batchNo !== undefined)
      issue(["batchNo"], "a gateway settlement has no batch number");
  }
});
export type ImportSettlementInput = z.infer<typeof importSettlementInputSchema>;

/** What the import recorded. `replayed`: the same report was imported before. */
export const settlementImportViewSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  source: reconciliationSourceSchema,
  provider: ref,
  reference: ref,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  grossIdr: nonnegativeIdr,
  feeIdr: nonnegativeIdr,
  netIdr: nonnegativeIdr,
  lineCount: z.number().int().nonnegative(),
  matchedLines: z.number().int().nonnegative(),
  mismatchLines: z.number().int().nonnegative(),
  unmatchedLines: z.number().int().nonnegative(),
  casesCreated: z.number().int().nonnegative(),
  replayed: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type SettlementImportView = z.infer<typeof settlementImportViewSchema>;

// ---- Endpoints ----------------------------------------------------------
// All routes are staff-only (outlet session + RBAC: payment.transaction.view,
// payment.reconcile, payment.edc.manage); the API re-checks every request.

const routeParams = z.strictObject({ method: routedPaymentMethodSchema });
const terminalParams = z.strictObject({ terminalId: uuidSchema });
const cashierParams = z.strictObject({ cashierId: uuidSchema });
const refundParams = z.strictObject({ refundId: uuidSchema });
const fundParams = z.strictObject({ fundId: uuidSchema });
const caseParams = z.strictObject({ caseId: uuidSchema });
const outletFilter = { outletId: outletIdSchema.optional() } as const;

/** GET the routing of the tenant (no outlet) or one outlet's overrides. */
export const getPaymentRouting = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/routing`,
  query: z.strictObject({ outletId: outletIdSchema.optional() }),
  response: dataResponseSchema(paymentRoutingViewSchema),
});
/** PRD "Routing per Metode": change routing per tenant or outlet, no redeploy. */
export const updatePaymentRoute = defineEndpoint({
  method: "PUT",
  path: `${ADMIN}/routing/:method`,
  params: routeParams,
  body: updatePaymentRouteInputSchema,
  response: dataResponseSchema(paymentRouteSchema),
});

export const listEdcTerminals = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/edc/terminals`,
  query: cursorPageQuerySchema.extend(outletFilter),
  response: cursorPageSchema(edcTerminalViewSchema),
});
export const createEdcTerminal = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/edc/terminals`,
  body: createEdcTerminalInputSchema,
  response: dataResponseSchema(edcTerminalViewSchema),
});
export const updateEdcTerminal = defineEndpoint({
  method: "PATCH",
  path: `${ADMIN}/edc/terminals/:terminalId`,
  params: terminalParams,
  body: updateEdcTerminalInputSchema,
  response: dataResponseSchema(edcTerminalViewSchema),
});

/** One outlet's cashiers with their default tender; terminals travel along. */
export const getEdcCashierDefaults = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/edc/cashier-defaults`,
  query: z.strictObject({ outletId: outletIdSchema }),
  response: dataResponseSchema(edcCashierDefaultsViewSchema),
});
export const updateEdcCashierDefault = defineEndpoint({
  method: "PUT",
  path: `${ADMIN}/edc/cashier-defaults/:cashierId`,
  params: cashierParams,
  body: updateEdcCashierDefaultInputSchema,
  response: dataResponseSchema(edcCashierDefaultSchema),
});

/**
 * Queue of ECR sales waiting for a person (payment.reconcile). Proposed
 * contract (legend-khi8n): backend not built yet, the web mock serves it.
 */
export const listEdcReconciliationQueue = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/edc/reconciliation-queue`,
  query: cursorPageQuerySchema.extend({
    ...outletFilter,
    status: edcTransactionStatusSchema.optional(),
    q: z.string().trim().max(100).optional(),
  }),
  response: cursorPageSchema(edcReconciliationQueueItemSchema),
});
/**
 * Clears one flagged sale after the terminal was checked (legend-x9zmq). It
 * does not book a payment: the cashier's ECR tender stays the only record.
 */
export const resolveEdcReconciliation = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/edc/transactions/:id/reconciliation`,
  params: resolveEdcReconciliationParamsSchema,
  body: resolveEdcReconciliationBodySchema,
  response: dataResponseSchema(edcTransactionSchema),
});

export const listRefunds = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/refunds`,
  query: cursorPageQuerySchema.extend({
    ...outletFilter,
    status: refundStatusSchema.optional(),
    escalated: z.enum(["true", "false"]).optional(),
  }),
  response: cursorPageSchema(refundViewSchema),
});
/**
 * PRD "Refund": any refund above zero needs approval, so the new refund starts
 * `pending` and only `approveRefund` executes it. The server checks the amount
 * against the paid amount; the client amount is a request, never authority.
 */
export const createRefund = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds`,
  body: createRefundInputSchema,
  response: dataResponseSchema(refundViewSchema),
});
/**
 * Runs the refund through the approval matrix (every level needs a distinct
 * approver, never the requester). Once approved the provider payout starts;
 * the refund becomes `completed` only on provider success. A payout whose
 * outcome is unknown stays `approved` and is retried with the same key.
 */
export const approveRefund = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds/:refundId/approve`,
  params: refundParams,
  body: approveRefundInputSchema,
  response: dataResponseSchema(refundViewSchema),
});
/** Rejects a `pending` refund: it ends `failed` (`rejected`) and frees the reserved amount. */
export const rejectRefund = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds/:refundId/reject`,
  params: refundParams,
  body: rejectRefundInputSchema,
  response: dataResponseSchema(refundViewSchema),
});
/** Retries the provider payout of an `approved` refund (same provider idempotency key). */
export const retryRefundPayout = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds/:refundId/retry`,
  params: refundParams,
  body: retryRefundPayoutInputSchema,
  response: dataResponseSchema(refundViewSchema),
});
/**
 * Ops action on a never-sent quarantined refund (`approved`,
 * PAYOUT_QUARANTINED, no attempt, no poll, no provider ref): it ends `failed`
 * (`approver_unauthorized`), which frees the reserved amount. Needs
 * payment.reconcile plus pos.refund.approve at the outlet, never the
 * requester, MFA when a role requires it. 409 REFUND_NOT_QUARANTINED, or
 * REFUND_PAYOUT_MAYBE_SENT when an attempt may have reached the provider.
 * Never use it after paying the customer by hand at the provider.
 */
export const releaseQuarantinedRefund = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds/:refundId/quarantine/release`,
  params: refundParams,
  body: quarantinedRefundActionInputSchema,
  response: dataResponseSchema(refundViewSchema),
});
/**
 * Same actor, preconditions and answers as releaseQuarantinedRefund, but the
 * refund returns to `pending` without its approval (the old chain stays as
 * history): approveRefund / rejectRefund then decide it again.
 */
export const reopenQuarantinedRefund = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds/:refundId/quarantine/reopen`,
  params: refundParams,
  body: quarantinedRefundActionInputSchema,
  response: dataResponseSchema(refundViewSchema),
});
/**
 * Closes an `approved` refund finance paid by hand (legend-xd2q): it ends
 * `completed` with no provider payout, ever. Only a refund that never reached
 * the provider (no provider ref, no poll; any attempt count or payout flag).
 * Same actor as the quarantine actions (payment.reconcile plus
 * pos.refund.approve at the outlet, never the requester, dashboard MFA). 409
 * REFUND_NOT_SETTLEABLE, REFUND_AT_PROVIDER, REFUND_PAYOUT_IN_FLIGHT or
 * SETTLEMENT_AMOUNT_MISMATCH; 422 when paidAt is before the refund or in the
 * future. A later provider success on it is recorded as a conflict.
 */
export const settleRefundManually = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/refunds/:refundId/settle-manually`,
  params: refundParams,
  body: manualRefundSettlementInputSchema,
  response: dataResponseSchema(refundViewSchema),
});

export const listUnallocatedFunds = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/unallocated-funds`,
  query: cursorPageQuerySchema.extend({
    ...outletFilter,
    status: unallocatedStatusSchema.optional(),
  }),
  response: cursorPageSchema(unallocatedFundViewSchema),
});
/** PAY-04: a double payment or overpayment is resolved by refund or credit. */
export const resolveUnallocatedFund = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/unallocated-funds/:fundId/resolve`,
  params: fundParams,
  body: resolveUnallocatedFundInputSchema,
  response: dataResponseSchema(unallocatedFundViewSchema),
});

export const listReconciliationCases = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/reconciliation/cases`,
  query: cursorPageQuerySchema.extend({
    ...outletFilter,
    status: z
      .enum(["open", "pending_approval", "matched", "resolved"])
      .optional(),
    source: reconciliationSourceSchema.optional(),
  }),
  response: cursorPageSchema(reconciliationCaseViewSchema),
});
export const getReconciliationSummary = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/reconciliation/summary`,
  query: z.strictObject({ outletId: outletIdSchema.optional() }),
  response: dataResponseSchema(reconciliationSummarySchema),
});
/** EDC-06: a settlement report is matched to POS; each difference is a case. */
export const importSettlement = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/reconciliation/settlements`,
  body: importSettlementInputSchema,
  response: dataResponseSchema(settlementImportViewSchema),
});
/** EDC-06: every settlement difference is a case resolved with a written note. */
export const resolveReconciliationCase = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/reconciliation/cases/:caseId/resolve`,
  params: caseParams,
  body: resolveReconciliationCaseInputSchema,
  response: dataResponseSchema(reconciliationCaseViewSchema),
});
/** Late funds of a written-off case: finance reviews, nothing is reversed automatically. */
export const listReconciliationCorrections = defineEndpoint({
  method: "GET",
  path: `${ADMIN}/reconciliation/corrections`,
  query: cursorPageQuerySchema.extend({
    ...outletFilter,
    status: z.enum(["open", "pending_approval", "resolved"]).optional(),
  }),
  response: cursorPageSchema(reconciliationCorrectionViewSchema),
});
export const resolveReconciliationCorrection = defineEndpoint({
  method: "POST",
  path: `${ADMIN}/reconciliation/corrections/:correctionId/resolve`,
  params: z.strictObject({ correctionId: uuidSchema }),
  body: resolveReconciliationCorrectionInputSchema,
  response: dataResponseSchema(reconciliationCorrectionViewSchema),
});

// ---- Fixtures: Cafe Legend Bandung, one business day --------------------

const tenantId = cafeLegendFixtures.tenant.id;
const bandung = cafeLegendFixtures.outlets[0];
const bandung2 = cafeLegendFixtures.outlets[1];
const bandungId = bandung.id;
const updatedAt = "2026-11-01T03:10:00.000Z";

const providerFixtures = [
  { code: "doit", name: "DOIT", kind: "gateway", enabled: true },
  { code: "duitku", name: "Duitku", kind: "gateway", enabled: false },
] as const;

const routeFixtures = [
  {
    id: "a1b2c3d4-0001-4a01-8b01-000000000001",
    method: "qris",
    provider: "doit",
    fallbackProvider: null,
    enabled: true,
  },
  {
    id: "a1b2c3d4-0002-4a02-8b02-000000000002",
    method: "va",
    provider: "doit",
    fallbackProvider: null,
    enabled: true,
  },
  {
    id: "a1b2c3d4-0003-4a03-8b03-000000000003",
    method: "ewallet",
    provider: "doit",
    fallbackProvider: null,
    enabled: true,
  },
  {
    id: "a1b2c3d4-0004-4a04-8b04-000000000004",
    method: "card",
    provider: "doit",
    fallbackProvider: null,
    enabled: true,
  },
  {
    id: "a1b2c3d4-0005-4a05-8b05-000000000005",
    method: "bank_transfer",
    provider: "doit",
    fallbackProvider: null,
    enabled: true,
  },
  {
    id: "a1b2c3d4-0006-4a06-8b06-000000000006",
    method: "paylater",
    provider: "doit",
    fallbackProvider: null,
    enabled: false,
  },
].map((route) =>
  paymentRouteSchema.parse({
    ...route,
    tenantId,
    outletId: null,
    updatedAt,
  }),
);

/**
 * One outlet override: the tenant keeps paylater off, Bandung turns it on.
 * A fallback gateway appears only after a second gateway is active (PRD
 * "Failover"), so the fixture never invents one.
 */
const outletRouteFixture = paymentRouteSchema.parse({
  id: "a1b2c3d4-0101-4b01-8c01-000000000101",
  tenantId,
  outletId: bandungId,
  method: "paylater",
  provider: "doit",
  fallbackProvider: null,
  enabled: true,
  updatedAt,
});

export const paymentRoutingFixture = paymentRoutingViewSchema.parse({
  scope: "tenant",
  outletId: null,
  outletName: null,
  outlets: cafeLegendFixtures.outlets.map((outlet) => ({
    id: outlet.id,
    name: outlet.name,
  })),
  providers: [...providerFixtures],
  routes: routeFixtures,
});

export const paymentRoutingOutletFixture = paymentRoutingViewSchema.parse({
  ...paymentRoutingFixture,
  scope: "outlet",
  outletId: bandungId,
  outletName: bandung.name,
  routes: [
    ...routeFixtures.filter((route) => route.method !== "paylater"),
    outletRouteFixture,
  ],
});

const terminalFixtures = [
  {
    id: "b2c3d4e5-0001-4b01-9c01-000000000001",
    outletId: bandungId,
    bankCode: "bca",
    terminalId: "TID-8841201",
    merchantId: "MID-9011842",
    model: "Ingenico Move 2500",
    connection: "lan",
    ipAddress: "10.20.4.31",
    supportedMethods: ["card", "qris"],
    assignedDeviceId: null,
    status: "active",
  },
  {
    id: "b2c3d4e5-0002-4b02-9c02-000000000002",
    outletId: bandungId,
    bankCode: "mandiri",
    terminalId: "TID-7712094",
    merchantId: "MID-5510287",
    model: "Verifone VX520",
    connection: "usb",
    ipAddress: null,
    supportedMethods: ["card", "qris"],
    assignedDeviceId: null,
    status: "active",
  },
  {
    id: "b2c3d4e5-0003-4b03-9c03-000000000003",
    outletId: bandungId,
    bankCode: "bni",
    terminalId: "TID-6620481",
    merchantId: "MID-4401938",
    model: "Ingenico Desk 3500",
    connection: "lan",
    ipAddress: "10.20.4.33",
    supportedMethods: ["card", "qris"],
    assignedDeviceId: null,
    status: "inactive",
  },
].map((terminal) =>
  edcTerminalViewSchema.parse({
    ...terminal,
    tenantId,
    outletName: bandung.name,
  }),
);

const cashierFixtures = [
  {
    id: "c3d4e5f6-0001-4c01-8d01-000000000001",
    cashierId: "d4e5f6a7-0001-4d01-8e01-000000000001",
    cashierName: "Rina Kasir",
    terminalId: terminalFixtures[0].id,
    defaultMethod: "edc_card",
  },
  {
    id: "c3d4e5f6-0002-4c02-8d02-000000000002",
    cashierId: "d4e5f6a7-0002-4d02-8e02-000000000002",
    cashierName: "Dodi Kasir",
    terminalId: terminalFixtures[1].id,
    defaultMethod: "edc_qris",
  },
  {
    id: "c3d4e5f6-0003-4c03-8d03-000000000003",
    cashierId: "d4e5f6a7-0003-4d03-8e03-000000000003",
    cashierName: "Sari Kasir",
    terminalId: null,
    defaultMethod: "qris_doit",
  },
].map((cashier) =>
  edcCashierDefaultSchema.parse({
    ...cashier,
    tenantId,
    outletId: bandungId,
    updatedAt,
  }),
);

export const edcCashierDefaultsFixture = edcCashierDefaultsViewSchema.parse({
  outletId: bandungId,
  outletName: bandung.name,
  terminals: terminalFixtures,
  cashiers: cashierFixtures,
});

const refundFixtures = [
  {
    id: "e5f6a7b8-0001-4e01-8f01-000000000001",
    paymentIntentId: "8a32e00d-7e43-45b6-9d01-7a92e605c104",
    paymentReference: "A03-0412",
    method: "qris",
    paidAmountIdr: 144_375,
    amountIdr: 50_000,
    reason: "Pesanan dibatalkan setelah dibayar.",
    status: "pending",
    requestedBy: "d4e5f6a7-0001-4d01-8e01-000000000001",
    requestedByName: "Rina Kasir",
    viewerCanApprove: true,
    approvedBy: null,
    approvedByName: null,
    providerRef: null,
    note: "Tamu menunggu lebih dari 30 menit.",
    createdAt: "2026-11-01T04:20:00.000Z",
    decidedAt: null,
  },
  {
    id: "e5f6a7b8-0002-4e02-8f02-000000000002",
    paymentIntentId: "7c6d5e4f-3a2b-4c1d-9e8f-7a6b5c4d3e2f",
    paymentReference: "B02-0355",
    method: "va",
    paidAmountIdr: 286_000,
    amountIdr: 286_000,
    reason: "Double payment: tamu membayar dua kali.",
    status: "completed",
    requestedBy: "d4e5f6a7-0002-4d02-8e02-000000000002",
    requestedByName: "Dodi Kasir",
    viewerCanApprove: false,
    approvedBy: "b1a2c3d4-0001-4a01-8b01-00000000a001",
    approvedByName: "Budi Supervisor",
    providerRef: "RF-20261101-0031",
    note: null,
    createdAt: "2026-11-01T03:05:00.000Z",
    decidedAt: "2026-11-01T03:12:00.000Z",
  },
  {
    id: "e5f6a7b8-0003-4e03-8f03-000000000003",
    paymentIntentId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    paymentReference: "A01-0390",
    method: "ewallet",
    paidAmountIdr: 75_000,
    amountIdr: 75_000,
    reason: "Menu tidak tersedia setelah pembayaran.",
    status: "failed",
    requestedBy: "d4e5f6a7-0003-4d03-8e03-000000000003",
    requestedByName: "Sari Kasir",
    viewerCanApprove: false,
    approvedBy: "b1a2c3d4-0001-4a01-8b01-00000000a001",
    approvedByName: "Budi Supervisor",
    providerRef: null,
    note: "Provider menolak refund; diproses manual oleh finance.",
    createdAt: "2026-10-31T12:40:00.000Z",
    decidedAt: "2026-10-31T12:48:00.000Z",
  },
].map((refund) =>
  refundViewSchema.parse({
    ...refund,
    tenantId,
    outletId: bandungId,
    outletName: bandung.name,
  }),
);

const unallocatedFixtures = [
  {
    id: "f6a7b8c9-0001-4f01-8a01-000000000001",
    paymentIntentId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    paymentReference: "A05-0421",
    method: "qris",
    paidAmountIdr: 288_750,
    billTotalIdr: 144_375,
    amountIdr: 144_375,
    reason: "overpayment",
    approvalRef: null,
    resolution: null,
    resolvedBy: null,
    resolvedByName: null,
    resolvedAt: null,
    status: "open",
    note: null,
    detectedAt: "2026-11-01T05:31:00.000Z",
  },
  {
    id: "f6a7b8c9-0002-4f02-8a02-000000000002",
    paymentIntentId: "5b1f2a3c-9d84-4e6f-8a71-0c3d5e7f9a21",
    paymentReference: "B01-0342",
    method: "va",
    paidAmountIdr: 200_000,
    billTotalIdr: 182_500,
    amountIdr: 17_500,
    reason: "overpayment",
    approvalRef: "APR-0342",
    resolution: "credit",
    resolvedBy: "d4e5f6a7-0002-4d02-8e02-000000000002",
    resolvedByName: "Dodi Kasir",
    resolvedAt: "2026-10-31T09:15:00.000Z",
    status: "resolved",
    note: "Kelebihan dititipkan sebagai kredit tamu pada kunjungan berikutnya.",
    detectedAt: "2026-10-31T08:58:00.000Z",
  },
].map((fund) =>
  unallocatedFundViewSchema.parse({
    ...fund,
    tenantId,
    outletId: bandungId,
    outletName: bandung.name,
  }),
);

/** Paid payments the refund dialog can pick, newest first. */
const refundableFixtures = [
  {
    paymentIntentId: "8a32e00d-7e43-45b6-9d01-7a92e605c104",
    reference: "A03-0412",
    outletId: bandungId,
    outletName: bandung.name,
    method: "qris",
    paidAmountIdr: 144_375,
    // The pending 50.000 refund above reserves its amount.
    refundedAmountIdr: 50_000,
    refundableAmountIdr: 94_375,
    paidAt: "2026-11-01T05:13:00.000Z",
  },
  // B02-0355 was refunded in full (completed above), so it is not offered.
  {
    paymentIntentId: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
    reference: "A01-0390",
    outletId: bandungId,
    outletName: bandung.name,
    method: "ewallet",
    paidAmountIdr: 75_000,
    // The 75.000 refund failed, so nothing is reserved; the guest is still owed.
    refundedAmountIdr: 0,
    refundableAmountIdr: 75_000,
    paidAt: "2026-10-31T11:55:00.000Z",
  },
].map((payment) => refundablePaymentSchema.parse(payment));

const caseFixtures = [
  {
    id: "a7b8c9d0-0001-4a01-8b01-000000000001",
    settlementId: "b8c9d0e1-0001-4b01-9c01-000000000001",
    settlementLineId: "c9d0e1f2-0001-4c01-8d01-000000000001",
    source: "edc",
    provider: "edc_bca",
    reference: "BCA batch 2026-11-01 / TID-8841201",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-01",
    expectedIdr: 4_197_500,
    receivedIdr: 4_145_000,
    varianceIdr: -52_500,
    reason: "MDR dipotong dua kali pada settlement bank.",
    status: "open",
    requestedBy: null,
    requestedByName: null,
    approvalRequestId: null,
    approvedBy: null,
    approvedByName: null,
    resolvedByName: null,
    resolvedAt: null,
    note: null,
    lateFunds: null,
    createdAt: "2026-11-01T05:40:00.000Z",
  },
  {
    id: "a7b8c9d0-0002-4a02-8b02-000000000002",
    settlementId: "b8c9d0e1-0002-4b02-9c02-000000000002",
    settlementLineId: null,
    source: "edc",
    provider: "edc_mandiri",
    reference: "Mandiri batch 2026-11-01 / standalone",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-01",
    expectedIdr: 285_000,
    receivedIdr: 0,
    varianceIdr: -285_000,
    reason: "Transaksi EDC mode standalone belum muncul di settlement.",
    status: "open",
    requestedBy: null,
    requestedByName: null,
    approvalRequestId: null,
    approvedBy: null,
    approvedByName: null,
    resolvedByName: null,
    resolvedAt: null,
    note: null,
    lateFunds: null,
    createdAt: "2026-11-01T05:42:00.000Z",
  },
  {
    id: "a7b8c9d0-0003-4a03-8b03-000000000003",
    settlementId: "b8c9d0e1-0003-4b03-9c03-000000000003",
    settlementLineId: "c9d0e1f2-0003-4c03-8d03-000000000003",
    source: "gateway",
    provider: "doit",
    reference: "DOIT settlement 2026-10-31",
    periodStart: "2026-10-31",
    periodEnd: "2026-10-31",
    expectedIdr: 892_500,
    receivedIdr: 878_000,
    varianceIdr: -14_500,
    reason: "Biaya layanan gateway lebih besar dari perkiraan.",
    status: "resolved",
    requestedBy: "d4e5f6a7-0002-4d02-8e02-000000000002",
    requestedByName: "Dodi Kasir",
    approvalRequestId: "a1b2c3d4-0003-4a03-8b03-0000000000a3",
    approvedBy: "b1a2c3d4-0001-4a01-8b01-00000000a001",
    approvedByName: "Budi Supervisor",
    resolvedByName: "Dodi Kasir",
    resolvedAt: "2026-11-01T02:20:00.000Z",
    note: "Selisih dibukukan sebagai biaya layanan periode Oktober.",
    lateFunds: null,
    createdAt: "2026-11-01T01:05:00.000Z",
  },
].map((entry) =>
  reconciliationCaseViewSchema.parse({
    ...entry,
    tenantId,
    outletId: bandungId,
  }),
);

const correctionFixtures = [
  {
    id: "e1f2a3b4-0001-4e01-8f01-000000000001",
    caseId: "a7b8c9d0-0002-4a02-8b02-000000000002",
    settlementId: "b8c9d0e1-0004-4b04-9c04-000000000004",
    settlementLineId: "c9d0e1f2-0004-4c04-8d04-000000000004",
    mismatchCaseId: null,
    source: "edc",
    reference: "Mandiri batch 2026-11-03 / standalone",
    writtenOffIdr: 285_000,
    receivedIdr: 285_000,
    status: "open",
    decision: null,
    requestedBy: null,
    requestedByName: null,
    approvalRequestId: null,
    approvedBy: null,
    approvedByName: null,
    resolvedByName: null,
    resolvedAt: null,
    note: null,
    createdAt: "2026-11-03T05:42:00.000Z",
  },
].map((entry) =>
  reconciliationCorrectionViewSchema.parse({
    ...entry,
    tenantId,
    outletId: bandungId,
  }),
);

export const reconciliationSummaryFixture = reconciliationSummarySchema.parse({
  matchedLines: 128,
  unmatchedLines: 2,
  mismatchLines: 3,
  openCases: 2,
  resolvedThisMonth: 1,
  varianceIdr: -352_000,
});

/** Pairs parsed by the contract test; fixtures cannot drift from the schema. */
export const paymentAdminFixtures = [
  [paymentRoutingViewSchema, paymentRoutingFixture],
  [paymentRoutingViewSchema, paymentRoutingOutletFixture],
  [edcTerminalViewSchema, terminalFixtures[0]],
  [edcCashierDefaultsViewSchema, edcCashierDefaultsFixture],
  [refundViewSchema, refundFixtures[0]],
  [refundViewSchema, refundFixtures[1]],
  [unallocatedFundViewSchema, unallocatedFixtures[0]],
  [unallocatedFundViewSchema, unallocatedFixtures[1]],
  [reconciliationCaseViewSchema, caseFixtures[0]],
  [reconciliationCorrectionViewSchema, correctionFixtures[0]],
  [reconciliationSummarySchema, reconciliationSummaryFixture],
] as const;

/** Seeds for the mock mode store; the screens work without a backend. */
export const cafeLegendPaymentAdminFixtures = {
  tenantId,
  outlets: [bandung, bandung2],
  providers: [...providerFixtures],
  routes: routeFixtures,
  outletRoute: outletRouteFixture,
  terminals: terminalFixtures,
  cashiers: cashierFixtures,
  refunds: refundFixtures,
  refundablePayments: refundableFixtures,
  unallocatedFunds: unallocatedFixtures,
  reconciliationCases: caseFixtures,
  reconciliationCorrections: correctionFixtures,
  reconciliationSummary: reconciliationSummaryFixture,
} as const;
