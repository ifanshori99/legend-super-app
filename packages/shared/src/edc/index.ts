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

export const edcBankSchema = z.enum(["bca", "mandiri", "bni", "bjb", "bri"]);
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

/** Card scheme labels the agent stores. Anything else (including a card
 * number a terminal put in this field) becomes `UNKNOWN`. */
export const EDC_CARD_TYPES = [
  "VISA",
  "MASTERCARD",
  "JCB",
  "AMEX",
  "UNIONPAY",
  "GPN",
  "QRIS",
  "DEBIT",
  "CREDIT",
  "UNKNOWN",
] as const;
export type EdcCardType = (typeof EDC_CARD_TYPES)[number];

function normaliseCardType(raw: string): EdcCardType {
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (EDC_CARD_TYPES as readonly string[]).includes(key)
    ? (key as EdcCardType)
    : "UNKNOWN";
}
const cardTypeSchema = z.string().transform(normaliseCardType);

/** Reference-style field (RRN, invoice, batch): any value that holds 13 or
 * more digits (the length of a card number), alone or with letters around it,
 * is dropped rather than stored or returned. The digits may be split by
 * spaces, tabs or dashes, repeated or mixed (`4111  1111 - 1111`): rows
 * written before the provider boundary filter can hold that form. */
const panLikeReference = /\d(?:[ \t-]*\d){12,}/;
const dropPanLike = (value: string | null): string | null =>
  value !== null && panLikeReference.test(value) ? null : value;
/** 13-19 digits in a row. Used on values that only ever hold letters and
 * digits once stored (the write path keeps reference fields alphanumeric and
 * migrations 0135/0141 removed older split forms). Deliberately contiguous:
 * a split form would also flag our own order numbers (`P261109-12345678` is
 * 14 digits across the dash). */
const panLengthDigits = /\d{13,19}/;
export const hasPanLengthDigits = (value: string): boolean =>
  panLengthDigits.test(value);
function referenceField(max: number) {
  return z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9]{1,${max}}$`))
    .nullable()
    .default(null)
    .transform(dropPanLike);
}

/** A run of 12+ digits (split by whitespace of any kind, dashes, slashes or
 * underscores, repeated or mixed) looks like a card number: the terminal's free
 * text is masked before it is stored. `\s` covers newline, CRLF and NBSP
 * (legend-deu7r). Only this free-text rule widened: the migration scrubs
 * (0135/0141/0143) and the leftover rules below keep the narrow class.
 * A date such as `2026/11/09 12:30:45` stays (colon ends the run, 10 digits). */
const cardNumberLike = /\d(?:[\s/_-]*\d){11,}/g;
/** Card digits the old single-separator scrub (0135, the write path before
 * legend-tjwb) left next to a mask: joined by a separator run it could not
 * cross (anything but exactly one space or dash), and more than the receipt
 * rule shows (7+ before = past the first 6, 5+ after = past the last 4).
 * Same rule as migration 0141; shorter groups such as a response code after
 * the mask (`[disamarkan] - 51`) stay. */
const leftoverBeforeMask =
  /\d(?:[ \t-]*\d){6,}(?:[ \t-]{2,}|\t)\[disamarkan\]/g;
const leftoverAfterMask = /\[disamarkan\](?:[ \t-]{2,}|\t)\d(?:[ \t-]*\d){4,}/g;
/** The old write path masked with the single-separator pattern, then cut the
 * message to 200 UTF-16 units. A cut through a card the old pattern missed
 * left part of it at the very end, below the thresholds above (legend-lg45).
 * Only a stored message exactly 200 units long gets these end-of-text rules,
 * on read (the current write path masks before it cuts, so it leaves no such
 * remnant). Migration 0143 and apps/api/scripts/edc-pan-scrub-tail.sql hold the
 * narrow form of these rules, migration 0170 (legend-0lrkl, legend-stetb) the
 * wide form below:
 * - digits after a whole mask, joined by a separator the old pattern could
 *   not cross (`… [disamarkan] - 111`);
 * - a run of 7+ digits that holds or ends in such a separator, optionally
 *   followed by a cut mask (`… 4111  1111  11`, `… 7777777  [disa`). A run
 *   right after a digit and `.` or `,` (the rest of an amount) is skipped.
 * A separator the old pattern could not cross is a run of two or more
 * separators, or a single one that is not a space or a dash: tab, line break,
 * NBSP and the other `\s` characters, slash, underscore (legend-stetb, same
 * class as `cardNumberLike`). Accepted effect, at exactly 200 units only: a
 * number of 7+ digits at the very end that is joined by, or ends in, such a
 * separator is masked even when it is not a card (`2026/11/09`,
 * `INV/2026/11/0001`, `TRX_20261109_01`, `Telp 021/7654321`, a thousands
 * group joined by NBSP). The rule cannot tell it from a cut card
 * (`4111/1111/11`); card safety wins. */
const oldWriteLimit = 200;
const tailAfterMask =
  /\[disamarkan\](?:[\s/_-]{2,}|[^\S ]|[/_])\d(?:[\s/_-]*\d)*[\s/_-]*$/;
const tailCardRun =
  /(?<!\d|\d[.,])\d(?=(?:[\s/_-]*\d){6})(?=[\d\s/_-]*?(?:[\s/_-]{2,}|[^\S ]|[/_]))(?:[\s/_-]*\d)*[\s/_-]*(?:\[(?:d(?:i(?:s(?:a(?:m(?:a(?:r(?:k(?:a(?:n)?)?)?)?)?)?)?)?)?)?)?$/;
const maskCardNumbers = (text: string): string =>
  text
    .replace(cardNumberLike, "[disamarkan]")
    .replace(leftoverBeforeMask, "[disamarkan]")
    .replace(leftoverAfterMask, "[disamarkan]");
const maskStoredMessage = (text: string): string => {
  const masked = maskCardNumbers(text);
  if (text.length !== oldWriteLimit) return masked;
  const tail = masked
    .replace(tailAfterMask, "[disamarkan]")
    .replace(tailCardRun, "[disamarkan]");
  // The mask can be longer than the run it replaces; cut by code points like
  // the SQL left(…, 200), so both give the same text (varchar(200)).
  return Array.from(tail).slice(0, oldWriteLimit).join("");
};
const safeMessage = z
  .string()
  .transform((text) => maskCardNumbers(text).slice(0, 200));

/** Details a terminal returns with a final answer. All optional: a decline
 * or cancel usually has none of them. Never a full PAN or track data. */
export const ecrResultDetailsSchema = z.strictObject({
  approvalCode: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}$/)
    .nullable()
    .default(null),
  /** Retrieval reference number from the host. */
  rrn: referenceField(24),
  cardType: cardTypeSchema.nullable().default(null),
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
  invoiceNo: referenceField(20),
  batchNo: referenceField(20),
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
 * that it cannot still be in transit; otherwise it stays `unknown`.
 *
 * Adapter contract: a provider whose protocol echoes the request trace
 * (every `by_trace` provider does) MUST put that trace on a `not_found` too.
 * The agent never settles on a `not_found` without the trace or with another
 * trace: the row stays `unknown`. A `not_found` also MUST carry `batchNo`, the terminal's
 * current open batch. A bank settlement closes the batch and hides its
 * transactions from a by-trace inquiry, so the agent trusts `not_found`
 * (records `failed`) only when `batchNo` is present and equals the batch known
 * when the sale was dispatched; a different or missing batch stays `unknown`
 * and flagged for reconciliation. */
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
 * - `sale` must write the sale frame to the wire synchronously when it is
 *   called: no await, connect or open before the write (open the link
 *   beforehand). The agent's cancel bypass relies on it: a cancel that
 *   finds the sale call already started assumes the sale frame is on the
 *   wire, so it can never overtake it.
 * - An inquiry `not_found` must carry the terminal's current open `batchNo`
 *   (see `ecrInquiryResultSchema`).
 * - Echo `trace` and the amount in results whenever the protocol carries
 *   them; return `invoiceNo` / `batchNo` for void and settlement. */
export interface EdcProvider {
  readonly bank: EdcBank;
  readonly capabilities: EdcProviderCapabilities;
  /** Sends a sale and waits for the customer. The sale frame must be written
   * to the wire synchronously when this is called (no await, connect or open
   * before the write). Resolves only with a definitive answer; throws
   * `EcrTransportError` otherwise. */
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
  // Rows written before the response boundary filtered card data may still
  // hold a card number here: the same allowlist and PAN filter apply on read.
  approvalCode: z.string().nullable().transform(dropPanLike),
  rrn: z.string().nullable().transform(dropPanLike),
  cardType: z
    .string()
    .nullable()
    .transform((v) => (v === null ? null : normaliseCardType(v))),
  maskedPan: maskedPanSchema.nullable(),
  responseCode: z.string().nullable(),
  message: z
    .string()
    .nullable()
    .transform((v) => (v === null ? null : maskStoredMessage(v))),
  invoiceNo: z.string().nullable().transform(dropPanLike),
  batchNo: z.string().nullable().transform(dropPanLike),
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

/** How a flagged (`needs_reconciliation`) ECR sale ended, as decided by a
 * person with evidence: the charge did not happen, or it did. */
export const edcReconciliationOutcomeSchema = z.enum(["declined", "approved"]);
export type EdcReconciliationOutcome = z.infer<
  typeof edcReconciliationOutcomeSchema
>;

/** Where the person learned the terminal's real answer. */
export const edcReconciliationEvidenceSourceSchema = z.enum([
  "inquiry",
  "terminal_receipt",
  "bank_statement",
]);
export type EdcReconciliationEvidenceSource = z.infer<
  typeof edcReconciliationEvidenceSourceSchema
>;

const noCardNumber = (value: string) => !hasPanLengthDigits(value);

export const edcReconciliationEvidenceSchema = z.strictObject({
  source: edcReconciliationEvidenceSourceSchema,
  /** Written reason; never a card number. */
  note: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(noCardNumber, "Catatan tidak boleh memuat nomor kartu"),
  approvalCode: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}$/)
    .optional(),
  rrn: z
    .string()
    .regex(/^[A-Za-z0-9]{1,24}$/)
    .refine(noCardNumber, "RRN tidak boleh menyerupai nomor kartu")
    .optional(),
  /** The amount printed on the terminal receipt or bank evidence. Required
   * for `approved` (see the body rule) so a charge whose real amount differs
   * from the request is never booked; ignored for `declined`. */
  chargedAmountIdr: idrSchema
    .refine((n) => n > 0, "Nominal harus positif")
    .optional(),
});
export type EdcReconciliationEvidence = z.infer<
  typeof edcReconciliationEvidenceSchema
>;

/** POST /api/payments/admin/edc/transactions/:id/reconciliation body. */
export const resolveEdcReconciliationBodySchema = z
  .strictObject({
    outcome: edcReconciliationOutcomeSchema,
    evidence: edcReconciliationEvidenceSchema,
  })
  .refine(
    (body) =>
      body.outcome !== "approved" ||
      body.evidence.chargedAmountIdr !== undefined,
    {
      path: ["evidence", "chargedAmountIdr"],
      message: "Nominal yang tercetak di bukti terminal wajib diisi",
    },
  );
export type ResolveEdcReconciliationBody = z.infer<
  typeof resolveEdcReconciliationBodySchema
>;

export const resolveEdcReconciliationParamsSchema = z.strictObject({
  id: uuidSchema,
});

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
  /** The terminal has an unfinished EDC transaction, so its bank, TID, MID,
   * connection or IP cannot change (admin edit refused; the message starts
   * with this key for the UI). */
  EDC_TERMINAL_BUSY: "CONFLICT",
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
  EDC_TERMINAL_BUSY:
    "EDC_TERMINAL_BUSY: Terminal masih punya transaksi EDC yang belum selesai. Selesaikan atau rekonsiliasi dulu sebelum mengubah TID, MID, bank, koneksi, atau IP.",
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
