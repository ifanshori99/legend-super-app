// EDC agent on the edge node (bead legend-apt; PRD v1.7 §3 F5 "EDC Agent",
// §3 F10a EDC multi-bank, §4 Alur W, §7 ECR via LAN, criteria EDC-02/03/05).
//
// Two boundaries live here:
//
// 1. `EdcProvider`: one adapter per bank (BCA, Mandiri, BNI, BJB) that speaks
//    that bank's ECR protocol to a terminal on the outlet LAN. Bank adapters
//    (bead legend-vpx) and the ECR simulator implement it. A provider is a
//    dumb transport: it is NOT idempotent and never touches the database or
//    publishes events. When it cannot learn the terminal's answer (timeout,
//    socket closed, garbage frame) it throws `EcrTransportError`: the caller
//    then records the transaction as `unknown`, never as failed.
//
// 2. The EDC agent service (apps/api/src/edge/edc): what POS calls (bead
//    legend-m0k). It owns the durable `edc_transactions` ledger, idempotency,
//    the per-terminal queue and the rule "status inquiry before retry"
//    (EDC-03): a transaction whose outcome is unknown is inquired at the
//    terminal before any new sale for the same POS reference is sent, so a
//    customer is never charged twice.
//
// Amounts are whole rupiah (D-CORE-2), never floats. The POS only ever sees
// status, approval code, card type and masked PAN (PRD §3 F5): a full PAN or
// track data is refused by `maskedPanSchema`.
import {
  z,
  uuidSchema,
  tenantIdSchema,
  outletIdSchema,
  idrSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  CoreError,
} from "../core/index.ts";
import type { CoreErrorCode, Idr } from "../core/index.ts";

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

export const edcBankSchema = z.enum(["bca", "mandiri", "bni", "bjb"]);
export const edcMethodSchema = z.enum(["card", "qris"]);
export const edcConnectionSchema = z.enum(["lan", "usb", "bluetooth"]);

/**
 * Ledger status of one EDC transaction (one ECR sale attempt).
 * - `pending`: the sale was sent and the agent is waiting for the terminal.
 * - `unknown`: the terminal's answer was lost (timeout, disconnect, agent
 *   restart mid-sale). The customer MAY have been charged: inquire, never
 *   treat as failed and never resend the sale (EDC-03).
 * - `approved`: the bank approved; the only status that may mark a bill paid.
 * - `declined`: the bank or terminal refused (card declined, wrong PIN).
 * - `cancelled`: cancelled at the terminal before the customer paid.
 * - `failed`: definitively not charged without a bank decision, e.g. the
 *   inquiry says the terminal never received the sale.
 * Final statuses never change (`approved` is reversed only by a void, which
 * is a separate transaction owned by the POS payment flow).
 */
export const edcTransactionStatusSchema = z.enum([
  "pending",
  "unknown",
  "approved",
  "declined",
  "cancelled",
  "failed",
]);
export type EdcTransactionStatus = z.infer<typeof edcTransactionStatusSchema>;

export const edcFinalStatuses = [
  "approved",
  "declined",
  "cancelled",
  "failed",
] as const satisfies readonly EdcTransactionStatus[];
export type EdcFinalStatus = (typeof edcFinalStatuses)[number];

export function isEdcFinalStatus(
  status: EdcTransactionStatus,
): status is EdcFinalStatus {
  return (edcFinalStatuses as readonly string[]).includes(status);
}

/** Allowed ledger moves. Finals are terminal; `unknown` is resolved only by
 * an inquiry or cancel answer from the terminal. */
export const edcTransactionTransitions: Readonly<
  Record<EdcTransactionStatus, readonly EdcTransactionStatus[]>
> = {
  pending: ["unknown", "approved", "declined", "cancelled", "failed"],
  unknown: ["approved", "declined", "cancelled", "failed"],
  approved: [],
  declined: [],
  cancelled: [],
  failed: [],
};

export function canTransitionEdc(
  from: EdcTransactionStatus,
  to: EdcTransactionStatus,
): boolean {
  return edcTransactionTransitions[from].includes(to);
}

/** Masked PAN as printed on a receipt: at most the first 6 and last 4 digits
 * visible, the rest masked with `*` or `X` (PCI DSS display rule). */
export const maskedPanSchema = z
  .string()
  .max(23)
  .regex(
    /^(?:\d{6}|\d{0,4})[*Xx]{2,}\d{4}$/,
    "Masked PAN shows at most the first 6 and last 4 digits",
  );

/** ECR trace / invoice number the agent assigns per terminal; the key for
 * inquiry and cancel at the terminal. */
export const ecrTraceSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9]+$/, "ECR trace uses letters and digits");

const shortText = z.string().min(1).max(32);

/** A run of 12+ digits (optionally split by spaces or dashes) looks like a
 * card number: the terminal's free text is masked before it is stored. */
const cardNumberLike = /\d(?:[ -]?\d){11,}/g;
const safeMessage = z
  .string()
  .transform((text) =>
    text.replace(cardNumberLike, "[disamarkan]").slice(0, 200),
  );

/** Details a terminal returns with a final answer. All optional: a decline
 * or cancel usually has none of them. Never a full PAN or track data. */
export const ecrResultDetailsSchema = z.strictObject({
  approvalCode: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}$/)
    .nullable()
    .default(null),
  /** Retrieval reference number from the host. */
  rrn: z
    .string()
    .regex(/^[A-Za-z0-9]{1,24}$/)
    .nullable()
    .default(null),
  cardType: shortText.nullable().default(null),
  maskedPan: maskedPanSchema.nullable().default(null),
  /** Bank/terminal response code, e.g. "00", "51". */
  responseCode: z
    .string()
    .regex(/^[A-Za-z0-9]{1,8}$/)
    .nullable()
    .default(null),
  /** Human text from the terminal; digit runs that look like a card number
   * are masked, and it is cut to 200 characters. */
  message: safeMessage.nullable().default(null),
  /** Terminal invoice number and batch number (void and settlement need
   * them; many terminals reset the invoice number per batch). */
  invoiceNo: z
    .string()
    .regex(/^[A-Za-z0-9]{1,20}$/)
    .nullable()
    .default(null),
  batchNo: z
    .string()
    .regex(/^[A-Za-z0-9]{1,20}$/)
    .nullable()
    .default(null),
  /** The trace the terminal answered for. When present it must equal the
   * request's trace, otherwise the answer belongs to another exchange. */
  trace: ecrTraceSchema.nullable().default(null),
});
export type EcrResultDetails = z.infer<typeof ecrResultDetailsSchema>;

/** Answer to a sale or cancel: always definitive. Indefinite answers are
 * thrown as `EcrTransportError`. */
export const ecrResultSchema = ecrResultDetailsSchema.extend({
  outcome: z.enum(["approved", "declined", "cancelled"]),
  /** Amount the terminal reports. An approval counts only when this equals
   * the request (EDC-01); an approval without an amount is recorded as
   * `unknown`, so adapters must report it. */
  amountIdr: idrSchema.nullable().default(null),
});
export type EcrResult = z.infer<typeof ecrResultSchema>;

/** Answer to a status inquiry. `in_progress`: the terminal is still waiting
 * for the customer. `not_found`: the terminal has no record of the trace.
 * The agent trusts `not_found` (records `failed`) only from a provider whose
 * `capabilities.inquiry` is `by_trace`, and only once the sale is old enough
 * that it cannot still be in transit; otherwise it stays `unknown`. */
export const ecrInquiryResultSchema = ecrResultDetailsSchema.extend({
  outcome: z.enum([
    "approved",
    "declined",
    "cancelled",
    "in_progress",
    "not_found",
  ]),
  amountIdr: idrSchema.nullable().default(null),
});
export type EcrInquiryResult = z.infer<typeof ecrInquiryResultSchema>;

/** The terminal a provider talks to, resolved by the agent from
 * `payment_edc_terminals`. Credentials (keys, passwords) are never part of
 * it: a bank adapter reads its own secrets from the edge config. */
export type EcrTerminal = {
  readonly tenantId: string;
  readonly outletId: string;
  /** `payment_edc_terminals.id`. */
  readonly id: string;
  readonly bank: EdcBank;
  /** Bank terminal id (TID). */
  readonly terminalId: string;
  /** Bank merchant id (MID). */
  readonly merchantId: string;
  readonly connection: EdcConnection;
  readonly ipAddress: string | null;
};

export type EcrSaleRequest = {
  readonly terminal: EcrTerminal;
  readonly trace: string;
  readonly amountIdr: Idr;
  readonly method: EdcMethod;
  /** POS reference printed on the terminal slip when supported. */
  readonly reference: string;
  /** Aborted by the agent when its timeout expires. */
  readonly signal: AbortSignal;
};

export type EcrTraceRequest = {
  readonly terminal: EcrTerminal;
  readonly trace: string;
  readonly signal: AbortSignal;
};

/** What a bank's ECR protocol can do. Many terminals cannot cancel a sale
 * that waits for the customer, and some answer an inquiry only for the last
 * transaction. */
export type EdcProviderCapabilities = {
  /** `by_trace`: inquiry for any trace of the current batch. `last_only`:
   * only the last transaction (the answer must echo `trace` to count).
   * `none`: no inquiry; an unknown outcome is resolved at the terminal by
   * the cashier and reconciled. */
  readonly inquiry: "by_trace" | "last_only" | "none";
  /** `cancel` may run while `sale` for the same terminal is still waiting. */
  readonly cancelInProgress: boolean;
};

/** One adapter per bank (PRD §3 F5: "Adapter per bank (EdcProvider)").
 *
 * Rules for adapters:
 * - Honor `signal`: on abort, stop waiting AND reset the link (close the
 *   socket / flush the port) so a late reply can never be read as the answer
 *   to the next exchange. The agent keeps the terminal locked until the
 *   adapter's promise settles.
 * - `cancel` for a trace the terminal never saw throws `EcrTransportError`;
 *   it never resolves `cancelled`.
 * - `cancel` runs concurrently with `sale` only when
 *   `capabilities.cancelInProgress` is true.
 * - Echo `trace` and the amount in results whenever the protocol carries
 *   them; return `invoiceNo` / `batchNo` for void and settlement. */
export interface EdcProvider {
  readonly bank: EdcBank;
  readonly capabilities: EdcProviderCapabilities;
  /** Sends a sale and waits for the customer. Resolves only with a
   * definitive answer; throws `EcrTransportError` otherwise. */
  sale(request: EcrSaleRequest): Promise<EcrResult>;
  /** Cancels the sale `trace` while the terminal still waits for the
   * customer. If the sale already finished, resolves with that final
   * outcome instead (e.g. `approved`): never claims a cancel it did not do. */
  cancel(request: EcrTraceRequest): Promise<EcrResult>;
  /** Status inquiry for `trace`. Safe to repeat; never charges. */
  inquiry(request: EcrTraceRequest): Promise<EcrInquiryResult>;
  /** Voids the APPROVED sale `trace` (same batch, before settlement) so the
   * customer is not charged. Resolves `cancelled` once the terminal voided
   * it; an already voided sale resolves `cancelled` again (safe to repeat).
   * Throws `EcrTransportError` when the outcome is unknown or the terminal
   * has no approved sale for the trace; it never resolves `cancelled` for a
   * sale it did not void. */
  void(request: EcrTraceRequest): Promise<EcrResult>;
}

/** The provider could not learn the terminal's answer. The outcome is
 * UNKNOWN: the customer may or may not have been charged. */
export class EcrTransportError extends Error {
  readonly kind: "timeout" | "disconnected" | "protocol";
  constructor(kind: EcrTransportError["kind"], message: string) {
    super(message);
    this.name = "EcrTransportError";
    this.kind = kind;
  }
}

/** POS -> agent: start a payment on one terminal (Alur W step 3). The amount
 * comes from the server-side bill, never typed by the cashier (EDC-01). */
export const edcPaymentRequestSchema = z.strictObject({
  ...scope,
  /** `payment_edc_terminals.id`. */
  terminalId: uuidSchema,
  /** POS reference (bill / payment intent). A new attempt for the same
   * reference is allowed only after earlier attempts are final and not
   * approved. */
  reference: z.string().min(1).max(100),
  /** Unique per tenant. Repeating it returns the same transaction (and
   * inquires it when unresolved) instead of sending a second sale. */
  idempotencyKey: idempotencyKeySchema,
  amountIdr: idrSchema.refine((n) => n > 0, "Amount must be positive"),
  method: edcMethodSchema,
});
export type EdcPaymentRequest = z.infer<typeof edcPaymentRequestSchema>;

export const edcTransactionRefSchema = z.strictObject({
  ...scope,
  transactionId: uuidSchema,
});
export type EdcTransactionRef = z.infer<typeof edcTransactionRefSchema>;

/** The ledger row as the POS sees it. */
export const edcTransactionSchema = z.strictObject({
  id: uuidSchema,
  ...scope,
  terminalId: uuidSchema,
  bank: edcBankSchema,
  reference: z.string().min(1).max(100),
  idempotencyKey: idempotencyKeySchema,
  amountIdr: idrSchema,
  method: edcMethodSchema,
  status: edcTransactionStatusSchema,
  trace: ecrTraceSchema,
  approvalCode: z.string().nullable(),
  rrn: z.string().nullable(),
  cardType: z.string().nullable(),
  maskedPan: maskedPanSchema.nullable(),
  responseCode: z.string().nullable(),
  message: z.string().nullable(),
  invoiceNo: z.string().nullable(),
  batchNo: z.string().nullable(),
  /** Set when the terminal approved a second sale for a reference that
   * already had an approved one (customer charged twice): needs a void and
   * reconciliation, never a silent drop. */
  needsReconciliation: z.boolean(),
  /** When the sale was handed to the terminal; null = never sent. */
  dispatchedAt: isoDateTimeSchema.nullable(),
  inquiryCount: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});
export type EdcTransaction = z.infer<typeof edcTransactionSchema>;

export type EdcBank = z.infer<typeof edcBankSchema>;
export type EdcMethod = z.infer<typeof edcMethodSchema>;
export type EdcConnection = z.infer<typeof edcConnectionSchema>;

/** Domain reasons, carried on a CoreError so the API error handler maps them
 * like any core code; `reason` is the stable key for the UI. */
export const edcErrorReasons = {
  /** No provider registered for the terminal's bank. */
  EDC_PROVIDER_UNKNOWN: "SERVICE_UNAVAILABLE",
  /** Terminal missing, inactive, other outlet, or method not supported. */
  EDC_TERMINAL_UNAVAILABLE: "CONFLICT",
  /** An earlier attempt for this reference is still unknown after inquiry:
   * check the terminal or reconcile before retrying (EDC-03). */
  EDC_STATUS_UNKNOWN: "CONFLICT",
  /** An earlier attempt for this reference was approved late (after it was
   * cancelled or failed) and still needs a void and reconciliation. */
  EDC_NEEDS_RECONCILIATION: "CONFLICT",
  /** An earlier attempt for this reference was approved: do not charge again. */
  EDC_ALREADY_APPROVED: "CONFLICT",
  /** The terminal reported an amount other than the request (EDC-01). */
  EDC_AMOUNT_MISMATCH: "CONFLICT",
  /** Cancel asked for a transaction that is already final. */
  EDC_NOT_CANCELLABLE: "CONFLICT",
  /** The bank's terminal cannot cancel a sale in progress from the POS:
   * cancel on the terminal, then inquire. */
  EDC_CANCEL_UNSUPPORTED: "CONFLICT",
  /** The agent for this outlet is not started, or another process holds it. */
  EDC_AGENT_NOT_READY: "SERVICE_UNAVAILABLE",
} as const satisfies Record<string, CoreErrorCode>;
export type EdcErrorReason = keyof typeof edcErrorReasons;

const edcErrorMessages: Record<EdcErrorReason, string> = {
  EDC_PROVIDER_UNKNOWN: "Bank EDC ini belum didukung di outlet ini.",
  EDC_TERMINAL_UNAVAILABLE: "Terminal EDC tidak tersedia untuk pembayaran ini.",
  EDC_STATUS_UNKNOWN:
    "Status transaksi EDC sebelumnya belum diketahui. Cek terminal sebelum mencoba lagi.",
  EDC_NEEDS_RECONCILIATION:
    "Ada pembayaran EDC untuk tagihan ini yang perlu direkonsiliasi dan di-void sebelum mencoba lagi.",
  EDC_ALREADY_APPROVED: "Pembayaran EDC untuk tagihan ini sudah disetujui.",
  EDC_AMOUNT_MISMATCH: "Nominal di terminal EDC tidak sama dengan tagihan.",
  EDC_NOT_CANCELLABLE:
    "Transaksi EDC ini sudah selesai dan tidak dapat dibatalkan.",
  EDC_CANCEL_UNSUPPORTED:
    "Terminal ini tidak dapat dibatalkan dari kasir. Batalkan di terminal EDC, lalu cek status.",
  EDC_AGENT_NOT_READY: "Layanan EDC di outlet ini belum siap.",
};

export class EdcError extends CoreError {
  readonly reason: EdcErrorReason;
  constructor(reason: EdcErrorReason, message?: string) {
    super(edcErrorReasons[reason], message ?? edcErrorMessages[reason]);
    this.name = "EdcError";
    this.reason = reason;
  }
}
export * from "./events.ts";
