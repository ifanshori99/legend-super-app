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
  dataResponseSchema,
  idempotencyKeySchema,
  timeZoneSchema,
  cafeLegendFixtures,
} from "../core/index.ts";
import {
  eventEnvelopeSchema,
  eventCatalogEntrySchema,
} from "../events/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";

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
  // PRD §3.13 "Metode DOIT": transfer to the merchant's own account,
  // confirmed from the bank mutation by the unique code.
  "bank_transfer",
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
  // legend-b0au: a verified gateway settlement may still land after the intent
  // failed (the guest paid the code the gateway had reported failed); the
  // source check below keeps every other source refused.
  failed: ["paid"],
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
  // Only the gateway can prove money arrived for an intent it reported failed.
  if (
    from === "failed" &&
    source !== "verified_webhook" &&
    source !== "gateway_status"
  )
    return false;

  switch (source) {
    case "verified_webhook":
    case "gateway_status":
      return [
        "qris",
        "card",
        "ewallet",
        "va",
        "bank_transfer",
        "paylater",
      ].some((onlineMethod) => onlineMethod === method);
    case "edc_ecr":
    case "authorized_edc_standalone":
      return method === "edc_card" || method === "edc_qris";
    case "authorized_cash":
      return method === "cash";
    default:
      return false;
  }
}
const settledPaymentStatuses: readonly PaymentStatus[] = [
  "paid",
  "partially_refunded",
  "refunded",
];
export const paymentIntentSchema = z
  .strictObject({
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
  })
  // A settled intent always records when it was paid; an unpaid one never does.
  .refine(
    (intent) =>
      settledPaymentStatuses.includes(intent.status) ===
      (intent.paidAt !== null),
    { path: ["paidAt"], message: "paidAt must be set exactly when paid" },
  );
export const paymentRoutingSchema = z.strictObject({
  ...row,
  // PRD §3.13: null is the tenant-wide default; an outlet row overrides it.
  outletId: outletIdSchema.nullable(),
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
  // PAY-04: why the money is held, and the approval that closed it.
  reason: z.enum(["overpayment", "double_payment"]),
  resolution: z.enum(["refund", "credit"]).nullable(),
  resolvedBy: id.nullable(),
  approvalRef: ref.nullable(),
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
  ipAddress: z.union([z.ipv4(), z.ipv6()]).nullable(),
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
  // PCI DSS: at most the first 6 and last 4 digits may be stored, never a full PAN.
  maskedPan: z
    .string()
    .regex(/^(?:\d{6})?[*Xx]{2,}\d{4}$/)
    .max(23)
    .nullable(),
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
  "payment.provider_refunded",
  "payment.funds_unallocated",
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
/**
 * Gateway money recorded as unallocated funds with no `payment.paid` beside it
 * (PAY-04): money on a failed/expired/cancelled intent, or a second payment on
 * an already settled intent. Overpayment on the settling confirmation is not
 * emitted here: its `payment.paid.receivedIdr` already counts it. Aggregate is
 * the unallocated-funds row; WS-07 books Dr gateway_clearing / Cr
 * customer_deposit on `receivedAt`.
 */
export const paymentFundsUnallocatedEventPayloadSchema = z.strictObject({
  unallocatedFundId: id,
  intentId: id,
  method: paymentMethodSchema,
  provider: ref,
  receivedIdr: positiveIdr,
  receivedAt: isoDateTimeSchema,
  reason: z.enum(["overpayment", "double_payment"]),
});
export type PaymentFundsUnallocatedEventPayload = z.infer<
  typeof paymentFundsUnallocatedEventPayloadSchema
>;
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
      reason: "overpayment",
      resolution: null,
      resolvedBy: null,
      approvalRef: null,
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

// ---- Customer payment link (PRD §3.13, D24; bead legend-2w5) --------------
//
// The guest pays from the table or from a payment link (D24: recurring billing
// sends a payment link). The link token is the guest credential: unguessable,
// single-purpose and short-lived, never the tenant id (TEN-02). Amounts are
// whole rupiah decided by the server (PAY-01). The browser never settles a
// payment (PAY-02): `status` only ever comes from the gateway webhook, a
// server-side status check, an ECR result or an authorized staff action, so a
// redirect back with "success" changes nothing here.

export const paymentLinkTokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "Payment link tokens use URL-safe characters");
export const paymentGatewayStatusSchema = z.enum([
  "available",
  "degraded",
  "down",
]);
/** Provider-supplied bank or channel, e.g. { code: "bca", name: "BCA" }. */
export const paymentChannelSchema = z.strictObject({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(60),
});
/**
 * The online methods a guest can pick. The list comes from the provider and
 * routing configuration, never hard-coded in the screen (PRD §3.13
 * "Metode DOIT": the active method list is read from DOIT's endpoint).
 */
export const customerPaymentMethodCodeSchema = z.enum([
  "qris",
  "va",
  "bank_transfer",
]);
/**
 * Methods an intent can carry. The payment-link method picker keeps the three
 * above; e-wallet and card are issued only through the QR guest flow
 * (legend-kt3t1) until the picker offers them.
 */
export const customerPaymentIntentMethodCodeSchema = z.enum([
  "qris",
  "va",
  "bank_transfer",
  "ewallet",
  "card",
]);
export type CustomerPaymentIntentMethodCode = z.infer<
  typeof customerPaymentIntentMethodCodeSchema
>;
export const customerPaymentMethodSchema = z
  .strictObject({
    method: customerPaymentMethodCodeSchema,
    enabled: z.boolean(),
    unavailableReason: z.enum(["gateway_down", "routing_disabled"]).nullable(),
    channels: z.array(paymentChannelSchema),
  })
  .superRefine((method, ctx) => {
    if (method.enabled === (method.unavailableReason !== null))
      ctx.addIssue({
        code: "custom",
        path: ["unavailableReason"],
        message: "A disabled method must say why; an enabled one must not",
      });
  });

/** What the guest needs on screen to complete one payment, per method. */
export const qrisPaymentInstructionsSchema = z.strictObject({
  method: z.literal("qris"),
  /** EMVCo payload the screen renders as a QR; never a provider secret. */
  qrPayload: z.string().min(1).max(2048),
  /** Acquirer/issuer label supplied by the provider, if any. */
  issuer: z.string().min(1).max(40).nullable(),
});
export const vaPaymentInstructionsSchema = z.strictObject({
  method: z.literal("va"),
  channelCode: z.string().min(1).max(40),
  channelName: z.string().min(1).max(60),
  virtualAccountNumber: z.string().regex(/^\d{8,20}$/),
});
export const bankTransferPaymentInstructionsSchema = z.strictObject({
  method: z.literal("bank_transfer"),
  channelCode: z.string().min(1).max(40),
  channelName: z.string().min(1).max(60),
  accountNumber: z.string().regex(/^\d{6,20}$/),
  accountHolder: z.string().min(1).max(80),
  /** Last digits that identify the transfer in the bank mutation. */
  uniqueCode: z.string().regex(/^\d{3,6}$/),
  /** Amount plus the unique code; the guest transfers exactly this. */
  transferTotalIdr: positiveIdr,
});
/** Hosted payment page the guest is sent to (e-wallet app or card page). */
const paymentUrlSchema = z
  .string()
  .max(2000)
  .regex(/^https:\/\/\S+$/, "The payment page must be an https URL");
export const ewalletPaymentInstructionsSchema = z.strictObject({
  method: z.literal("ewallet"),
  channelCode: z.string().min(1).max(40),
  channelName: z.string().min(1).max(60),
  paymentUrl: paymentUrlSchema,
});
export const cardPaymentInstructionsSchema = z.strictObject({
  method: z.literal("card"),
  channelCode: z.string().min(1).max(40),
  channelName: z.string().min(1).max(60),
  paymentUrl: paymentUrlSchema,
});
export const paymentInstructionsSchema = z.discriminatedUnion("method", [
  qrisPaymentInstructionsSchema,
  vaPaymentInstructionsSchema,
  bankTransferPaymentInstructionsSchema,
  ewalletPaymentInstructionsSchema,
  cardPaymentInstructionsSchema,
]);

/**
 * Payment view of a bill: the reference, where the guest is, and the totals
 * the guest pays. Line items stay in the order domain; this is the snapshot
 * the payment service prices (PRD: prices exclude tax and service charge,
 * both added at checkout — owner decision 12).
 */
export const customerPaymentBillSchema = z
  .strictObject({
    /** Bill or invoice number shown to the guest and the cashier. */
    reference: z.string().min(1).max(40),
    /** "Meja A03"; null for a link that is not tied to a table. */
    tableLabel: z.string().min(1).max(40).nullable(),
    pax: z.number().int().min(1).max(30).nullable(),
    totals: z.strictObject({
      subtotalIdr: nonnegativeIdr,
      discountIdr: nonnegativeIdr,
      serviceChargeIdr: nonnegativeIdr,
      taxIdr: nonnegativeIdr,
      roundingIdr: idrSchema,
      totalIdr: nonnegativeIdr,
      paidIdr: nonnegativeIdr,
      outstandingIdr: nonnegativeIdr,
    }),
  })
  .superRefine((bill, ctx) => {
    const add = (
      path: (string | number)[],
      message: string,
      invalid: boolean,
    ) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    const totals = bill.totals;
    add(
      ["tableLabel"],
      "A table bill carries the table label and the guest count together",
      (bill.tableLabel === null) !== (bill.pax === null),
    );
    add(
      ["totals", "totalIdr"],
      "Total must equal subtotal − discount + service + tax + rounding",
      totals.totalIdr !==
        totals.subtotalIdr -
          totals.discountIdr +
          totals.serviceChargeIdr +
          totals.taxIdr +
          totals.roundingIdr,
    );
    add(
      ["totals", "paidIdr"],
      "Paid must not exceed the total",
      totals.paidIdr > totals.totalIdr,
    );
    add(
      ["totals", "outstandingIdr"],
      "Outstanding must equal total − paid",
      totals.outstandingIdr !== totals.totalIdr - totals.paidIdr,
    );
  });

/** One payable intent as the guest sees it. */
export const customerPaymentIntentSchema = z
  .strictObject({
    id,
    method: customerPaymentIntentMethodCodeSchema,
    status: paymentStatusSchema,
    amountIdr: positiveIdr,
    expiresAt: isoDateTimeSchema,
    paidAt: isoDateTimeSchema.nullable(),
    /** PRD "Siklus Pembayaran": a payment that lands after expiry is accepted and flagged. */
    paidAfterExpiry: z.boolean(),
    instructions: paymentInstructionsSchema,
  })
  .superRefine((intent, ctx) => {
    const settled = settledPaymentStatuses.includes(intent.status);
    if (settled !== (intent.paidAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "paidAt must be set exactly when the intent is settled",
      });
    if (intent.instructions.method !== intent.method)
      ctx.addIssue({
        code: "custom",
        path: ["instructions", "method"],
        message: "Instructions must match the intent method",
      });
    if (intent.instructions.method === "bank_transfer") {
      const transfer = intent.instructions;
      if (
        transfer.transferTotalIdr !==
        intent.amountIdr + Number(transfer.uniqueCode)
      )
        ctx.addIssue({
          code: "custom",
          path: ["instructions", "transferTotalIdr"],
          message:
            "The transfer amount must be the bill amount plus the unique code",
        });
    }
  });

/** Everything the payment screen needs on first render. */
export const paymentLinkViewSchema = z.strictObject({
  /** Echo of the link credential the caller already holds; lets the screen verify it. */
  token: paymentLinkTokenSchema,
  bill: customerPaymentBillSchema,
  methods: z.array(customerPaymentMethodSchema),
  gateway: z.strictObject({ status: paymentGatewayStatusSchema }),
  /** The current payable intent (or the last settled one on a paid link). */
  activeIntent: customerPaymentIntentSchema.nullable(),
  /** Where "Back" and "Selesai" go, e.g. the table session; app-local path. */
  returnPath: z
    .string()
    .max(300)
    .regex(/^\/(?!\/)/, "Return paths are app-local")
    .nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  /** Server clock so a countdown is not fooled by a wrong device clock. */
  serverTime: isoDateTimeSchema,
  /** Outlet business time zone for displaying times (contracts: outlet zone). */
  timeZone: timeZoneSchema,
});
export const createPaymentIntentInputSchema = z
  .strictObject({
    method: customerPaymentIntentMethodCodeSchema,
    /** Bank/channel code for `va`, `bank_transfer` and `ewallet`; null for QRIS and card. */
    channelCode: z.string().min(1).max(40).nullable(),
    idempotencyKey: idempotencyKeySchema,
    /** Optional earlier expiry (e.g. the QR guest session ends sooner); the
     * server caps it at the method's default lifetime. */
    expiresAt: isoDateTimeSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const needsChannel = input.method !== "qris" && input.method !== "card";
    if (needsChannel !== (input.channelCode !== null))
      ctx.addIssue({
        code: "custom",
        path: ["channelCode"],
        message: needsChannel
          ? "Choose a bank or channel for this method"
          : "QRIS and card do not take a channel",
      });
  });
/** PRD §3.13 "Failover": the guest is told to pay at the cashier and the supervisor is notified. */
export const payAtCashierAcknowledgementSchema = z.strictObject({
  requestedAt: isoDateTimeSchema,
});

export type PaymentGatewayStatus = z.infer<typeof paymentGatewayStatusSchema>;
export type PaymentChannel = z.infer<typeof paymentChannelSchema>;
export type CustomerPaymentMethodCode = z.infer<
  typeof customerPaymentMethodCodeSchema
>;
export type CustomerPaymentMethod = z.infer<typeof customerPaymentMethodSchema>;
export type PaymentInstructions = z.infer<typeof paymentInstructionsSchema>;
export type CustomerPaymentBill = z.infer<typeof customerPaymentBillSchema>;
export type CustomerPaymentIntent = z.infer<typeof customerPaymentIntentSchema>;
export type PaymentLinkView = z.infer<typeof paymentLinkViewSchema>;
export type CreatePaymentIntentInput = z.infer<
  typeof createPaymentIntentInputSchema
>;
export type PayAtCashierAcknowledgement = z.infer<
  typeof payAtCashierAcknowledgementSchema
>;

const BASE = "/api/payments/links";
const linkParams = z.strictObject({ token: paymentLinkTokenSchema });
const intentParams = z.strictObject({
  token: paymentLinkTokenSchema,
  intentId: id,
});

export const getPaymentLink = defineEndpoint({
  method: "GET",
  path: `${BASE}/:token`,
  params: linkParams,
  response: dataResponseSchema(paymentLinkViewSchema),
});
/**
 * Creating an intent supersedes the link's previous pending intent, so one
 * bill never shows two live codes. A late payment on a superseded code is
 * still accepted and flagged (PRD §3.13 "Siklus Pembayaran"). Same
 * idempotency key + different method/channel → IDEMPOTENCY_KEY_REUSED (409).
 */
export const createPaymentIntent = defineEndpoint({
  method: "POST",
  path: `${BASE}/:token/intents`,
  params: linkParams,
  body: createPaymentIntentInputSchema,
  response: dataResponseSchema(customerPaymentIntentSchema),
});
/** Polled by the screen; the API asks the provider for the source of truth (PAY-02). */
export const getPaymentIntent = defineEndpoint({
  method: "GET",
  path: `${BASE}/:token/intents/:intentId`,
  params: intentParams,
  response: dataResponseSchema(customerPaymentIntentSchema),
});
/**
 * QRIS lives about 10 minutes (PRD "QRIS Dinamis"). Refreshing returns the
 * current payable code; when the previous intent already expired the API may
 * mint a new one, so the guest never has to reload the page.
 */
export const refreshPaymentIntent = defineEndpoint({
  method: "POST",
  path: `${BASE}/:token/intents/:intentId/refresh`,
  params: intentParams,
  response: dataResponseSchema(customerPaymentIntentSchema),
});
export const requestPayAtCashier = defineEndpoint({
  method: "POST",
  path: `${BASE}/:token/pay-at-cashier`,
  params: linkParams,
  response: dataResponseSchema(payAtCashierAcknowledgementSchema),
});

// Fixtures: one bill for table A03 at Cafe Legend, priced exclusive of the
// 5% service charge and 10% PBJT (owner decision 12).
const billTotals = {
  subtotalIdr: 125000,
  discountIdr: 0,
  serviceChargeIdr: 6250,
  taxIdr: 13125,
  roundingIdr: 0,
  totalIdr: 144375,
  paidIdr: 0,
  outstandingIdr: 144375,
};
const paidBillTotals = {
  ...billTotals,
  paidIdr: 144375,
  outstandingIdr: 0,
};
const billFixture = {
  reference: "A03-0412",
  tableLabel: "A03",
  pax: 3,
  totals: billTotals,
};
const paidIntentAt = "2026-11-01T05:13:00.000Z";
const pendingExpiry = "2026-11-01T05:22:00.000Z";
const qrisPayload =
  "00020101021226660014ID.CO.DOIT.WWW01189360091400000000000215MERCHANT000000000000000005204581453033605802ID5914Cafe Legend6007Jakarta6304ABCD";
const tableReturnPath = `/t/v1.${"A".repeat(40)}.${"B".repeat(43)}`;

export const qrisPendingIntentFixture = {
  id: "8a32e00d-7e43-45b6-9d01-7a92e605c104",
  method: "qris",
  status: "pending",
  amountIdr: 144375,
  expiresAt: pendingExpiry,
  paidAt: null,
  paidAfterExpiry: false,
  instructions: {
    method: "qris",
    qrPayload: qrisPayload,
    issuer: "QRIS",
  } as const,
};
export const vaPendingIntentFixture = {
  ...qrisPendingIntentFixture,
  id: "5b1f2a3c-9d84-4e6f-8a71-0c3d5e7f9a21",
  method: "va",
  instructions: {
    method: "va",
    channelCode: "bca",
    channelName: "BCA",
    virtualAccountNumber: "8808123456789012",
  },
};
export const bankTransferPendingIntentFixture = {
  ...qrisPendingIntentFixture,
  id: "3e7d6c5b-4a39-4281-8076-6f5e4d3c2b1a",
  method: "bank_transfer",
  instructions: {
    method: "bank_transfer",
    channelCode: "bca",
    channelName: "BCA",
    accountNumber: "1234567890",
    accountHolder: "Cafe Legend",
    uniqueCode: "347",
    transferTotalIdr: 144722,
  } as const,
};
export const paidQrisIntentFixture = {
  ...qrisPendingIntentFixture,
  id: "7c6d5e4f-3a2b-4c1d-9e8f-7a6b5c4d3e2f",
  status: "paid",
  // Paid after the code expired; PRD "Siklus Pembayaran" accepts and flags it.
  expiresAt: "2026-11-01T04:52:00.000Z",
  paidAt: paidIntentAt,
  paidAfterExpiry: true,
};
export const expiredQrisIntentFixture = {
  ...qrisPendingIntentFixture,
  id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  status: "expired",
  expiresAt: "2026-11-01T04:52:00.000Z",
};
export const failedVaIntentFixture = {
  ...vaPendingIntentFixture,
  id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
  status: "failed",
  expiresAt: "2026-11-01T04:52:00.000Z",
};

export const customerPaymentMethodsFixture = [
  { method: "qris", enabled: true, unavailableReason: null, channels: [] },
  {
    method: "va",
    enabled: true,
    unavailableReason: null,
    channels: [
      { code: "bca", name: "BCA" },
      { code: "mandiri", name: "Mandiri" },
      { code: "bni", name: "BNI" },
    ],
  },
  {
    method: "bank_transfer",
    enabled: true,
    unavailableReason: null,
    channels: [{ code: "bca", name: "BCA" }],
  },
] as const;
const downMethods = customerPaymentMethodsFixture.map((method) => ({
  ...method,
  enabled: false,
  unavailableReason: "gateway_down" as const,
}));
const linkViewBase = {
  methods: [...customerPaymentMethodsFixture],
  gateway: { status: "available" as const },
  activeIntent: null,
  returnPath: tableReturnPath,
  expiresAt: null,
  serverTime: "2026-11-01T05:10:00.000Z",
  timeZone: "Asia/Jakarta",
};
/** Link the guest lands on before choosing a method. */
export const paymentLinkViewFixture = {
  token: "pl_pending_7b6d4c8fa1d3e5b7c9f0a2d4",
  ...linkViewBase,
  bill: billFixture,
};
export const paymentLinkQrisPendingFixture = {
  token: "pl_qris_4c8fa1d3e5b7c9f0a2d47b6d4c8fa1d3",
  ...linkViewBase,
  bill: billFixture,
  activeIntent: qrisPendingIntentFixture,
};
export const paymentLinkVaPendingFixture = {
  token: "pl_va_5e9fb2c4d6a8e0f1a3b5c7d9e1f3a5b7",
  ...linkViewBase,
  bill: billFixture,
  activeIntent: vaPendingIntentFixture,
};
export const paymentLinkBankTransferFixture = {
  token: "pl_transfer_6f0ac3d5e7b9a1c2d4e6f8a0b2c4d6e8",
  ...linkViewBase,
  bill: billFixture,
  activeIntent: bankTransferPendingIntentFixture,
};
export const paymentLinkPaidFixture = {
  token: "pl_paid_1a2b3c4d5e6f70819a2b3c4d5e6f7081",
  ...linkViewBase,
  bill: { ...billFixture, totals: paidBillTotals },
  activeIntent: paidQrisIntentFixture,
};
export const paymentLinkExpiredFixture = {
  token: "pl_expired_2b3c4d5e6f70819a2b3c4d5e6f7081a2",
  ...linkViewBase,
  bill: billFixture,
  activeIntent: expiredQrisIntentFixture,
};
export const paymentLinkFailedFixture = {
  token: "pl_failed_3c4d5e6f70819a2b3c4d5e6f7081a2b3",
  ...linkViewBase,
  bill: billFixture,
  activeIntent: failedVaIntentFixture,
};
/** PRD "Failover": the online gateway is down, so the page points to the cashier. */
export const paymentLinkGatewayDownFixture = {
  token: "pl_down_4d5e6f70819a2b3c4d5e6f7081a2b3c4",
  ...linkViewBase,
  methods: downMethods,
  gateway: { status: "down" as const },
  bill: billFixture,
};
/** A settled bill: nothing left to pay (the screen's honest empty state). */
export const paymentLinkSettledFixture = {
  token: "pl_settled_5e6f70819a2b3c4d5e6f7081a2b3c4d5",
  ...linkViewBase,
  methods: [],
  bill: { ...billFixture, totals: paidBillTotals },
};

/** Pairs parsed by the contract test; fixtures cannot drift from the schema. */
export const paymentLinkFixtures = [
  [paymentLinkViewSchema, paymentLinkViewFixture],
  [paymentLinkViewSchema, paymentLinkQrisPendingFixture],
  [paymentLinkViewSchema, paymentLinkVaPendingFixture],
  [paymentLinkViewSchema, paymentLinkBankTransferFixture],
  [paymentLinkViewSchema, paymentLinkPaidFixture],
  [paymentLinkViewSchema, paymentLinkExpiredFixture],
  [paymentLinkViewSchema, paymentLinkFailedFixture],
  [paymentLinkViewSchema, paymentLinkGatewayDownFixture],
  [paymentLinkViewSchema, paymentLinkSettledFixture],
] as const;
export const customerPaymentIntentFixtures = [
  [customerPaymentIntentSchema, qrisPendingIntentFixture],
  [customerPaymentIntentSchema, vaPendingIntentFixture],
  [customerPaymentIntentSchema, bankTransferPendingIntentFixture],
  [customerPaymentIntentSchema, paidQrisIntentFixture],
  [customerPaymentIntentSchema, expiredQrisIntentFixture],
  [customerPaymentIntentSchema, failedVaIntentFixture],
] as const;
export * from "./refund-events.ts";

export * from "./settlement-events.ts";
