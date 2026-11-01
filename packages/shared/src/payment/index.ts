// PRD v1.7 §3.13 and §6.D. These are data contracts, not authorization,
// signature verification, server-side pricing or payment processing.
import {
  z,
  uuidSchema,
  ulidSchema,
  tenantIdSchema,
  outletIdSchema,
  idrSchema,
  isoDateTimeSchema,
  businessDateSchema,
  cafeLegendFixtures,
} from "../core/index.ts";
import {
  eventEnvelopeSchema,
  eventCatalogEntrySchema,
} from "../events/index.ts";

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };
const id = uuidSchema;
const ref = z.string().min(1).max(100);
const positiveIdr = idrSchema.refine((n) => n > 0);
const nonnegativeIdr = idrSchema.refine((n) => n >= 0);
const row = { id, ...scope };
export const paymentMethodSchema = z.enum([
  "qris",
  "card",
  "ewallet",
  "va",
  "paylater",
  "cash",
  "edc_card",
  "edc_qris",
  "points",
  "voucher",
]);
export const paymentStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "failed",
  "refunded",
  "partially_refunded",
]);
export const paymentConfirmationSourceSchema = z.enum([
  "verified_webhook",
  "gateway_status",
  "edc_ecr",
  "authorized_cash",
  "authorized_edc_standalone",
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type PaymentConfirmationSource = z.infer<
  typeof paymentConfirmationSourceSchema
>;
const transitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ["paid", "expired", "failed"],
  expired: ["paid"],
  failed: [],
  paid: ["partially_refunded", "refunded"],
  partially_refunded: ["refunded"],
  refunded: [],
};
/** Confirmation labels describe evidence to verify at the trusted service boundary. */
export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
  source?: string,
  method?: PaymentMethod,
): boolean {
  if (!transitions[from]?.includes(to)) return false;
  if (to !== "paid") return true;

  switch (source) {
    case "verified_webhook":
    case "gateway_status":
      return ["qris", "card", "ewallet", "va", "paylater"].some(
        (onlineMethod) => onlineMethod === method,
      );
    case "edc_ecr":
    case "authorized_edc_standalone":
      return method === "edc_card" || method === "edc_qris";
    case "authorized_cash":
      return method === "cash";
    default:
      return false;
  }
}
export const paymentIntentSchema = z.strictObject({
  ...row,
  orderId: ulidSchema.nullable(),
  billSplitId: id.nullable(),
  reservationId: id.nullable(),
  accessTicketId: ulidSchema.nullable(),
  subscriptionInvoiceId: id.nullable(),
  method: paymentMethodSchema,
  provider: ref,
  amountIdr: positiveIdr,
  feeIdr: nonnegativeIdr,
  idempotencyKey: ref,
  providerRef: ref.nullable(),
  status: paymentStatusSchema,
  flags: z.array(z.enum(["late_payment", "double_payment"])),
  edcTransactionId: id.nullable(),
  paidAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema,
});
export const paymentRoutingSchema = z.strictObject({
  ...row,
  method: paymentMethodSchema,
  provider: ref,
  fallbackProvider: ref.nullable(),
  enabled: z.boolean(),
});
export const refundSchema = z.strictObject({
  ...row,
  paymentIntentId: id,
  amountIdr: positiveIdr,
  reason: z.string().min(1).max(500),
  providerRef: ref.nullable(),
  status: z.enum(["pending", "approved", "completed", "failed"]),
  approvedBy: id.nullable(),
});
export const unallocatedFundsSchema = z.strictObject({
  ...row,
  paymentIntentId: id,
  amountIdr: positiveIdr,
  resolution: z.enum(["refund", "credit"]).nullable(),
  resolvedBy: id.nullable(),
});
export const settlementSchema = z.strictObject({
  ...row,
  provider: ref,
  periodStart: businessDateSchema,
  periodEnd: businessDateSchema,
  grossIdr: nonnegativeIdr,
  feeIdr: nonnegativeIdr,
  netIdr: nonnegativeIdr,
  bankStatementLineId: id.nullable(),
});
export const settlementLineSchema = z.strictObject({
  ...row,
  settlementId: id,
  paymentIntentId: id.nullable(),
  amountIdr: positiveIdr,
  matchStatus: z.enum(["unmatched", "matched", "mismatch"]),
});
export const reconciliationCaseSchema = z.strictObject({
  ...row,
  settlementId: id,
  settlementLineId: id.nullable(),
  reason: z.string().min(1).max(500),
  status: z.enum(["open", "resolved"]),
  resolvedBy: id.nullable(),
});
export const edcTerminalSchema = z.strictObject({
  ...row,
  bankCode: ref,
  terminalId: ref,
  merchantId: ref,
  model: ref,
  connection: z.enum(["lan", "usb", "bluetooth"]),
  ipAddress: z.string().nullable(),
  supportedMethods: z.array(z.enum(["card", "qris"])),
  assignedDeviceId: id.nullable(),
  status: z.enum(["active", "inactive"]),
});
export const edcTransactionSchema = z.strictObject({
  ...row,
  paymentIntentId: id,
  terminalId: id,
  requestRef: ref,
  type: z.enum(["sale", "void", "refund"]),
  method: z.enum(["card", "qris"]),
  amountIdr: positiveIdr,
  status: z.enum(["pending", "approved", "declined", "cancelled", "unknown"]),
  approvalCode: ref.nullable(),
  bankRef: ref.nullable(),
  cardType: ref.nullable(),
  issuer: ref.nullable(),
  maskedPan: ref.nullable(),
  batchNo: ref.nullable(),
  mode: z.enum(["ecr", "standalone"]),
  approvedBy: id.nullable(),
  respondedAt: isoDateTimeSchema.nullable(),
});
export const edcSettlementSchema = z.strictObject({
  ...row,
  terminalId: id,
  batchNo: ref,
  settledAt: isoDateTimeSchema,
  count: z.number().int().nonnegative().safe(),
  grossIdr: nonnegativeIdr,
  mdrIdr: nonnegativeIdr,
  netIdr: nonnegativeIdr,
  bankStatementLineId: id.nullable(),
  matchStatus: z.enum(["unmatched", "matched", "mismatch"]),
});
export const recurringBillingSchema = z.strictObject({
  ...row,
  provider: ref,
  planRef: ref,
  subscriptionRef: ref,
  invoiceRef: ref,
  paymentIntentId: id.nullable(),
  amountIdr: positiveIdr,
  dueDate: businessDateSchema,
  status: z.enum(["pending", "paid", "expired", "failed"]),
});
export const paymentEventNames = [
  "payment.paid",
  "payment.expired",
  "payment.failed",
  "payment.refunded",
  "settlement.imported",
] as const;
export const paymentEventCatalogEntries = paymentEventNames.map((name) =>
  eventCatalogEntrySchema.parse({
    name,
    aggregateType: name.split(".")[0],
    version: 1,
    payloadSchemaRef: `${name}.v1`,
    workstream: "WS-05",
  }),
);
export const paymentEventSchema = eventEnvelopeSchema.refine((event) =>
  (paymentEventNames as readonly string[]).includes(event.name),
);
export type PaymentIntent = z.infer<typeof paymentIntentSchema>;
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type PaymentRouting = z.infer<typeof paymentRoutingSchema>;
export type Refund = z.infer<typeof refundSchema>;
export type UnallocatedFunds = z.infer<typeof unallocatedFundsSchema>;
export type Settlement = z.infer<typeof settlementSchema>;
export type SettlementLine = z.infer<typeof settlementLineSchema>;
export type ReconciliationCase = z.infer<typeof reconciliationCaseSchema>;
export type EdcTerminal = z.infer<typeof edcTerminalSchema>;
export type EdcTransaction = z.infer<typeof edcTransactionSchema>;
export type EdcSettlement = z.infer<typeof edcSettlementSchema>;
export type RecurringBilling = z.infer<typeof recurringBillingSchema>;
export type PaymentEvent = z.infer<typeof paymentEventSchema>;

const scopeFixture = {
  tenantId: cafeLegendFixtures.tenant.id,
  outletId: cafeLegendFixtures.outlets[0].id,
};
const exampleId = "8a32e00d-7e43-45b6-9d01-7a92e605c104";
const exampleRow = { id: exampleId, ...scopeFixture };
export const intentFixture = {
  ...exampleRow,
  orderId: cafeLegendFixtures.orderId,
  billSplitId: null,
  reservationId: null,
  accessTicketId: null,
  subscriptionInvoiceId: null,
  method: "qris",
  provider: "doit",
  amountIdr: 125000,
  feeIdr: 875,
  idempotencyKey: "cafe-legend-order-001",
  providerRef: "DOIT-001",
  status: "pending",
  flags: [],
  edcTransactionId: null,
  paidAt: null,
  expiresAt: "2026-11-01T05:22:00.000Z",
};
export const refundFixture = {
  ...exampleRow,
  paymentIntentId: exampleId,
  amountIdr: 28000,
  reason: "Menu tidak tersedia",
  providerRef: null,
  status: "pending",
  approvedBy: null,
};
export const paymentFixtures = [
  [paymentIntentSchema, intentFixture],
  [
    paymentRoutingSchema,
    {
      ...exampleRow,
      method: "qris",
      provider: "doit",
      fallbackProvider: null,
      enabled: true,
    },
  ],
  [refundSchema, refundFixture],
  [
    unallocatedFundsSchema,
    {
      ...exampleRow,
      paymentIntentId: exampleId,
      amountIdr: 10000,
      resolution: null,
      resolvedBy: null,
    },
  ],
  [
    settlementSchema,
    {
      ...exampleRow,
      provider: "doit",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-01",
      grossIdr: 125000,
      feeIdr: 875,
      netIdr: 124125,
      bankStatementLineId: null,
    },
  ],
  [
    settlementLineSchema,
    {
      ...exampleRow,
      settlementId: exampleId,
      paymentIntentId: exampleId,
      amountIdr: 125000,
      matchStatus: "matched",
    },
  ],
  [
    reconciliationCaseSchema,
    {
      ...exampleRow,
      settlementId: exampleId,
      settlementLineId: exampleId,
      reason: "Selisih biaya",
      status: "open",
      resolvedBy: null,
    },
  ],
  [
    edcTerminalSchema,
    {
      ...exampleRow,
      bankCode: "bca",
      terminalId: "BCA-01",
      merchantId: "LEGEND-01",
      model: "ECR",
      connection: "lan",
      ipAddress: null,
      supportedMethods: ["card", "qris"],
      assignedDeviceId: null,
      status: "active",
    },
  ],
  [
    edcTransactionSchema,
    {
      ...exampleRow,
      paymentIntentId: exampleId,
      terminalId: exampleId,
      requestRef: "ECR-001",
      type: "sale",
      method: "card",
      amountIdr: 125000,
      status: "approved",
      approvalCode: "123456",
      bankRef: "BANK-001",
      cardType: "debit",
      issuer: "BCA",
      maskedPan: "****1234",
      batchNo: "B01",
      mode: "ecr",
      approvedBy: null,
      respondedAt: "2026-11-01T05:13:00.000Z",
    },
  ],
  [
    edcSettlementSchema,
    {
      ...exampleRow,
      terminalId: exampleId,
      batchNo: "B01",
      settledAt: "2026-11-01T15:00:00.000Z",
      count: 1,
      grossIdr: 125000,
      mdrIdr: 875,
      netIdr: 124125,
      bankStatementLineId: null,
      matchStatus: "unmatched",
    },
  ],
  [
    recurringBillingSchema,
    {
      ...exampleRow,
      provider: "doit",
      planRef: "SHOWER-MONTHLY",
      subscriptionRef: "SUB-001",
      invoiceRef: "INV-001",
      paymentIntentId: exampleId,
      amountIdr: 300000,
      dueDate: "2026-11-30",
      status: "pending",
    },
  ],
] as const;
