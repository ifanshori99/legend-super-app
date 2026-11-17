// DOIT wire format (bead legend-b9i; PRD v1.7 §3.13 F13, PAY-02/03/06).
//
// From the official docs (https://doit.id/docs/en/, llms.txt) and the adapter
// already running in production for 119connect:
//   - Base URL https://pay.doit.id for sandbox and live alike; the API key's
//     prefix (pb_test_ / pb_live_) picks the environment.
//   - Authorization: Bearer <key>. Every POST carries Idempotency-Key; a
//     replayed key answers the original result with HTTP 200.
//   - GET  /v1/methods          -> { environment, amount, data: [{ code, label, rail, bank, ..., within_limits }] }
//   - POST /v1/payments         -> payment object (201, 200 on replay)
//   - GET  /v1/payments/{id}    -> payment object
//   - Webhook header `PayBridge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw bytes)>`
//   - Webhook body   { id: "evt_…", type, created_at, data: <payment object> }
//
// Nothing here logs or throws a response body, header or secret (PAY-06).

import { createHmac, timingSafeEqual } from "node:crypto";
import { CoreError, isoDateTimeSchema } from "@starter/shared/core";
import {
  paymentChannelSchema,
  paymentInstructionsSchema,
  type PaymentChannel,
  type PaymentInstructions,
} from "@starter/shared/payment";
import type {
  PaymentResult,
  ProviderPaymentStatus,
} from "@starter/shared/adapters";
import { z } from "zod";
import type {
  GatewayMethodAvailability,
  GatewayPaymentMethod,
  GatewayPaymentStatus,
} from "./payment-gateway";
import type { GatewayRefundResult } from "./payment-refund-gateway";

/** The one DOIT host, sandbox and live (the key prefix picks the
 * environment). */
export const DOIT_BASE_URL = "https://pay.doit.id";
/** Header DOIT signs webhooks with. */
export const DOIT_SIGNATURE_HEADER = "PayBridge-Signature";
/**
 * Accepted age of a webhook signature timestamp. The docs set no window and a
 * retry keeps its schedule for up to 24 hours (1m…24h, then a portal replay),
 * so the past bound is the retry schedule plus an hour; a timestamp more than
 * five minutes ahead of this server is refused. Replays are stopped by the
 * event id dedupe, not by this window.
 */
export const DOIT_SIGNATURE_TOLERANCE = {
  pastSeconds: 25 * 3600,
  futureSeconds: 5 * 60,
} as const;

/** Every event type the docs list. Only the payment events move an intent;
 * the others (and any type not listed) are stored and ignored. */
export const DOIT_WEBHOOK_EVENT_TYPES = [
  "payment.paid",
  "payment.expired",
  "invoice.created",
  "payment.proof_uploaded",
  "refund.succeeded",
  "refund.failed",
  "webhook.test",
] as const;
export const DOIT_PAYMENT_EVENT_TYPES = [
  "payment.paid",
  "payment.expired",
  // 952 round 2: only records that the provider gave the money back.
  "payment.refunded",
] as const;
export type DoitPaymentEventType = (typeof DOIT_PAYMENT_EVENT_TYPES)[number];

export function isDoitPaymentEvent(type: string): type is DoitPaymentEventType {
  return (DOIT_PAYMENT_EVENT_TYPES as readonly string[]).includes(type);
}

/** VA bank codes DOIT accepts for rail=va (docs "Payment methods"; BCA and
 * BNC VA are listed but not available, so they are not accepted here). */
export const DOIT_VA_BANKS = [
  "bmri",
  "bsyi",
  "bnia",
  "brin",
  "cimb",
  "permata",
  "maybank",
  "danamon",
] as const;
/** Destination banks for rail=transfer (Account Mutation). */
export const DOIT_TRANSFER_BANKS = ["bca", "mandiri", "bni", "bsi"] as const;

const amountSchema = z.number().int().nonnegative();
const timestampSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp");
const optionalText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null);

/** Payment statuses, exactly the five the docs define. */
export const doitPaymentStatusSchema = z.enum([
  "pending",
  "paid",
  "refunded",
  "expired",
  "failed",
]);
export type DoitPaymentStatus = z.infer<typeof doitPaymentStatusSchema>;

/** Payment object returned by create/get and embedded in webhook events.
 * Unknown extra fields are dropped, never echoed. There is no paid amount:
 * `paid` means DOIT collected `total_amount`, of which `amount` is what the
 * bill is credited. `rail` and `qr_content` turn null when a dynamic QR
 * lapses (about ten minutes) while the payment stays pending.
 *
 * Only what moves money is strict (id, reference, status, amount, and
 * total_amount, which the create path checks). Display and timing fields
 * degrade to null when absent or malformed, so a settled payment whose
 * expiry or QR was dropped still parses instead of being refused for good;
 * the create path requires `expires_at` itself. */
export const doitPaymentSchema = z.object({
  id: z.string().min(1).max(100),
  reference: z.string().min(1).max(128),
  status: doitPaymentStatusSchema,
  amount: amountSchema,
  rail: optionalText(20),
  qr_content: z
    .string()
    .max(2048)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  va_number: z
    .string()
    .max(40)
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  va_bank: optionalText(40),
  hosted_url: optionalText(512),
  fee_amount: amountSchema.nullish().transform((value) => value ?? null),
  fee_payer: optionalText(20),
  total_amount: amountSchema.nullish().transform((value) => value ?? null),
  expires_at: timestampSchema
    .nullish()
    .catch(null)
    .transform((value) => value ?? null),
  // Needs an explicit offset: a zoneless time would be read in the server's
  // zone and could shift the settlement by hours, so it becomes null.
  // Strict ISO with a zone (a zoneless time would be read in server time); a
  // space between date and time is accepted as `T`.
  paid_at: z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:)/, "$1T$2")
          : value,
      isoDateTimeSchema.nullish(),
    )
    .catch(null)
    .transform((value) => value ?? null),
  flags: z
    .array(z.string().max(40))
    .max(20)
    .nullish()
    .catch(null)
    .transform((value) => value ?? []),
});
export type DoitPayment = z.infer<typeof doitPaymentSchema>;

export const doitPaymentMethodsSchema = z.object({
  data: z
    .array(
      z.object({
        code: z.string().min(1).max(40),
        label: optionalText(60),
        rail: z.string().min(1).max(20),
        bank: optionalText(40),
        within_limits: z.boolean().nullish(),
      }),
    )
    .max(500),
});

/** Webhook envelope with any `data`: `webhook.test` and other non-payment
 * events need not carry a payment object. */
export const doitWebhookEnvelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(60),
  created_at: timestampSchema,
  data: z.unknown(),
});

/** Webhook body of a payment event: the envelope around a payment object. */
export const doitWebhookEventSchema = doitWebhookEnvelopeSchema.extend({
  data: doitPaymentSchema,
});
export type DoitWebhookEvent = z.infer<typeof doitWebhookEventSchema>;

// -- Methods ----------------------------------------------------------------

/** Methods this adapter can create a payment for. Bank transfer (rail
 * transfer) is not among them: the payment object carries no destination
 * account, holder or unique code (only DOIT's hosted page shows them), so the
 * guest instructions cannot be built. DOIT has no e-wallet or card rail. */
export const DOIT_CREATABLE_METHODS = [
  "qris",
  "va",
] as const satisfies readonly GatewayPaymentMethod[];
export type DoitCreatableMethod = (typeof DOIT_CREATABLE_METHODS)[number];

const RAIL_METHOD: Record<string, GatewayPaymentMethod> = {
  qris: "qris",
  va: "va",
  transfer: "bank_transfer",
};

/** Group the provider's rows per method; unknown rails (and VA banks DOIT
 * does not serve) are ignored. A row outside its amount limits is disabled.
 * Bank transfer is reported but never enabled (see DOIT_CREATABLE_METHODS). */
export function mapDoitMethods(
  rows: z.infer<typeof doitPaymentMethodsSchema>["data"],
): GatewayMethodAvailability[] {
  const grouped = new Map<
    GatewayPaymentMethod,
    { enabled: boolean; channels: Map<string, PaymentChannel> }
  >();
  for (const row of rows) {
    const method = RAIL_METHOD[row.rail];
    if (!method) continue;
    const entry = grouped.get(method) ?? {
      enabled: false,
      channels: new Map<string, PaymentChannel>(),
    };
    grouped.set(method, entry);
    if (row.within_limits === false) continue;
    if (method === "qris") {
      entry.enabled = true;
      continue;
    }
    if (
      method !== "va" ||
      !row.bank ||
      !(DOIT_VA_BANKS as readonly string[]).includes(row.bank)
    )
      continue;
    const channel = paymentChannelSchema.safeParse({
      code: row.bank,
      name: row.label ?? row.bank.toUpperCase(),
    });
    if (!channel.success) continue;
    entry.enabled = true;
    if (!entry.channels.has(channel.data.code))
      entry.channels.set(channel.data.code, channel.data);
  }
  return [...grouped].map(([method, entry]) => {
    const creatable = (DOIT_CREATABLE_METHODS as readonly string[]).includes(
      method,
    );
    return {
      method,
      enabled: creatable && entry.enabled,
      channels: creatable ? [...entry.channels.values()] : [],
    };
  });
}

// -- Payment object -> port types -------------------------------------------

/**
 * Status the lifecycle receives. `refunded` is a terminal answer: the money went
 * back to the payer, so the code can never settle the bill. It is reported as
 * `failed` with no amount (legend-3wpf), never `pending` (which kept the code
 * polled and ended as a false `gateway_unconfirmed` timeout) and never `paid`
 * (which would credit the bill again). The books are not touched automatically
 * and the raw status stays `refunded`. For a paid payment the amount is
 * `amount`, the figure the bill is credited (`total_amount` adds the unique code
 * or a customer-borne fee); the lifecycle compares it with the intent and flags
 * a mismatch.
 */
export function doitPaymentToGatewayStatus(
  payment: DoitPayment,
): GatewayPaymentStatus {
  if (payment.status === "refunded")
    return {
      status: "failed",
      rawStatus: payment.status,
      providerRef: payment.id,
      amountIdr: null,
      paidAt: null,
    };
  const paid = payment.status === "paid";
  return {
    status: payment.status,
    rawStatus: payment.status,
    providerRef: payment.id,
    amountIdr: paid ? payment.amount : null,
    // `paid_at` already parsed as a timestamp; normalized to ISO for the
    // lifecycle's confirmation schema.
    paidAt:
      paid && payment.paid_at !== null
        ? new Date(payment.paid_at).toISOString()
        : null,
  };
}

/**
 * DOIT status -> the provider contract's status. All five DOIT statuses are
 * listed; `refunded` stays `refunded` (unlike the lifecycle mapping above).
 * Anything else is a provider fault and throws, so an unknown value can never
 * become `paid`.
 */
export function doitPaymentToProviderStatus(
  status: DoitPaymentStatus,
): ProviderPaymentStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "paid":
      return "paid";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      throw malformedProviderAnswer();
  }
}

/** Provider-contract result for a DOIT payment: our reference, DOIT's id. */
export function doitPaymentToProviderResult(
  payment: DoitPayment,
): PaymentResult {
  return {
    reference: payment.reference,
    providerReference: payment.id,
    status: doitPaymentToProviderStatus(payment.status),
  };
}

/** Guest instructions for a just-created payment. Any missing or malformed
 * field is a provider fault: no partial data. `channel` is the VA bank the
 * guest picked, as listed by `mapDoitMethods`. */
export function doitPaymentToInstructions(
  payment: DoitPayment,
  method: DoitCreatableMethod,
  channel: PaymentChannel | null,
): PaymentInstructions {
  const candidate =
    method === "qris"
      ? { method, qrPayload: payment.qr_content, issuer: null }
      : {
          method,
          channelCode: payment.va_bank ?? channel?.code,
          channelName: channel?.name,
          virtualAccountNumber: payment.va_number,
        };
  const parsed = paymentInstructionsSchema.safeParse(candidate);
  if (!parsed.success) throw malformedProviderAnswer();
  if (parsed.data.method === "va" && parsed.data.channelCode !== channel?.code)
    throw malformedProviderAnswer();
  return parsed.data;
}

export function malformedProviderAnswer(): CoreError {
  return new CoreError(
    "SERVICE_UNAVAILABLE",
    "Gateway pembayaran memberi jawaban yang tidak dikenali. Bayar di kasir.",
  );
}

// -- Refund -----------------------------------------------------------------
//
// The docs (https://doit.id/docs/en/#refund) give the request and the error
// codes but not the refund object, a GET refund endpoint or the refund webhook
// data. So every shape that is not recognised is an UNKNOWN outcome (a throw),
// never a success or a failure.

export type DoitRefundEvidence = {
  id?: string;
  paymentId?: string;
  amountIdr?: number;
  status?: string;
};

const EVIDENCE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const EVIDENCE_STATUS = /^[a-z_]{1,32}$/;

/** Bounded ids out of a refund answer: what ops need to find it at DOIT. */
export function doitRefundEvidence(
  body: Record<string, unknown>,
): DoitRefundEvidence {
  const evidence: DoitRefundEvidence = {};
  if (typeof body.id === "string" && EVIDENCE_ID.test(body.id))
    evidence.id = body.id;
  if (typeof body.payment_id === "string" && EVIDENCE_ID.test(body.payment_id))
    evidence.paymentId = body.payment_id;
  const amount =
    body.amount === undefined ? undefined : refundAmount(body.amount);
  if (amount !== undefined) evidence.amountIdr = amount;
  if (typeof body.status === "string" && EVIDENCE_STATUS.test(body.status))
    evidence.status = body.status;
  return evidence;
}

/** Unknown refund outcome. Carries our own code (read by the refund service
 * as the payout error), never provider text; stays a 503 `CoreError`. */
export class DoitRefundUnknownError extends CoreError {
  /** Ids-only facts of the provider answer (legend-r7g2), for the audit. */
  readonly providerEvidence?: DoitRefundEvidence;
  constructor(refundCode: string, providerEvidence?: DoitRefundEvidence) {
    super(
      "SERVICE_UNAVAILABLE",
      "Gateway pembayaran memberi jawaban refund yang tidak dikenali.",
    );
    (this as { code: string }).code = refundCode;
    if (providerEvidence) this.providerEvidence = providerEvidence;
  }
}

/** Largest error body read to find the DOIT error code. */
export const DOIT_ERROR_BODY_MAX_BYTES = 4096;

const doitErrorBodySchema = z.object({
  error: z.object({
    code: z
      .string()
      .max(64)
      .regex(/^[a-z_]+$/),
  }),
});

/** `{ error: { code } }` -> the code; anything else (bad JSON, bad code) null. */
export function parseDoitErrorCode(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = doitErrorBodySchema.safeParse(value);
  return parsed.success ? parsed.data.error.code : null;
}

/** Definitive refund declines: HTTP status -> DOIT error code. */
const DOIT_REFUND_DECLINES: Readonly<Record<number, string>> = {
  409: "payment_not_refundable",
  400: "invalid_refund_amount",
  502: "provider_refund_failed",
};

/** Our decline code for a first-send answer that DOIT definitively refused,
 * else null (unknown outcome). */
export function doitRefundDeclineCode(
  status: number,
  doitCode: string | null,
): string | null {
  if (doitCode === null || DOIT_REFUND_DECLINES[status] !== doitCode)
    return null;
  return `DOIT_${doitCode.toUpperCase()}`;
}

const REFUND_SUCCEEDED_STATUSES = [
  "succeeded",
  "success",
  "completed",
  "refunded",
];
const REFUND_PENDING_STATUSES = ["pending", "processing", "requested"];

const CANONICAL_INTEGER = /^(0|[1-9][0-9]{0,15})$/;

/** A canonical non-negative integer string ("4000") as a number; any other
 * string (decimals, signs, padding, unsafe size) is undefined (legend-0yd1). */
export function parseDoitIntegerString(value: string): number | undefined {
  if (!CANONICAL_INTEGER.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** A refund amount as DOIT sends it: a number on create (201), a canonical
 * integer string on an idempotent replay (200, legend-0yd1). Anything else
 * (decimals, signs, padding, other types) is unreadable: undefined. */
function refundAmount(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  return typeof value === "string" ? parseDoitIntegerString(value) : undefined;
}

/** Reading of the 2xx answer of `POST …/refunds`. Extra fields (`reason`,
 * `provider_ref`, `created_at`) are ignored.
 *
 * legend-r7g2 (Codex 117 Run A): an answer counts only when it proves it is
 * about THIS request. A payment object must be our payment (id and
 * `reference` = our intent). A refund object (DOIT sandbox: 201 `{id: "rf_…",
 * payment_id, amount, status, reason}`, the 200 replay adds `idempotency_key`)
 * must name our payment in `payment_id` and our amount; `idempotency_key` and
 * `reference`, when sent, must be ours. Anything else is an UNKNOWN outcome
 * (`DOIT_REFUND_IDENTITY_MISMATCH` or `DOIT_REFUND_UNRECOGNIZED`): never a
 * success or a failure, and the payout sweep stops after its attempt cap. */
export function parseDoitRefundAnswer(
  payload: unknown,
  expected: {
    paymentProviderRef: string;
    paymentIntentId: string;
    amountIdr: number;
    /** The `Idempotency-Key` header of the request (`refund:<refundId>`). */
    idempotencyKey: string;
  },
): GatewayRefundResult {
  const unrecognized = () =>
    new DoitRefundUnknownError("DOIT_REFUND_UNRECOGNIZED");
  // Ids only from the foreign answer, for the ops audit (never provider text).
  const mismatch = () =>
    new DoitRefundUnknownError(
      "DOIT_REFUND_IDENTITY_MISMATCH",
      doitRefundEvidence(body),
    );
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw unrecognized();
  const body = payload as Record<string, unknown>;
  const { id, status, reference, object } = body;
  if (typeof id !== "string" || id === "" || id.length > 100)
    throw unrecognized();
  if (object !== undefined && object !== "payment" && object !== "refund")
    throw unrecognized();
  const amount =
    body.amount === undefined ? undefined : refundAmount(body.amount);
  if (body.amount !== undefined && amount === undefined) throw unrecognized();
  if (amount !== undefined && amount !== expected.amountIdr) throw mismatch();
  // The payment object (the refund moved it to `refunded`).
  if (
    object === "payment" ||
    (object === undefined && id === expected.paymentProviderRef)
  ) {
    if (id !== expected.paymentProviderRef) throw mismatch();
    if (reference !== expected.paymentIntentId) throw mismatch();
    if (status === "refunded" && amount === expected.amountIdr)
      return { status: "succeeded", providerRef: id };
    throw unrecognized();
  }
  // A refund object: it must name our payment, our amount and (when sent)
  // our idempotency key and intent.
  if (id === expected.paymentProviderRef) throw mismatch();
  if (body.payment_id !== expected.paymentProviderRef) throw mismatch();
  if (amount === undefined) throw mismatch();
  if (
    body.idempotency_key !== undefined &&
    body.idempotency_key !== expected.idempotencyKey
  )
    throw mismatch();
  if (reference !== undefined && reference !== expected.paymentIntentId)
    throw mismatch();
  if (typeof status !== "string") throw unrecognized();
  if (REFUND_SUCCEEDED_STATUSES.includes(status))
    return { status: "succeeded", providerRef: id };
  if (REFUND_PENDING_STATUSES.includes(status))
    return { status: "pending", providerRef: id };
  if (status === "failed")
    return { status: "failed", providerRef: id, code: "DOIT_REFUND_FAILED" };
  throw unrecognized();
}

// -- Webhook signature ------------------------------------------------------

function signature(secret: string, timestamp: string, rawBody: Buffer): Buffer {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
}

/** Header value DOIT would send; used by tests. */
export function signDoitWebhook(
  rawBody: Buffer,
  secret: string,
  now: Date,
): string {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return `t=${timestamp},v1=${signature(secret, timestamp, rawBody).toString("hex")}`;
}

/**
 * Verify `PayBridge-Signature` over the raw request bytes against every
 * candidate secret (rotation: several integrations or an old and a new
 * secret). False on a missing or malformed header, a timestamp older than 25
 * hours or more than 5 minutes ahead of `now`, or no secret matching
 * (constant-time compare of equal-length digests).
 */
export function verifyDoitSignature(input: {
  rawBody: Buffer;
  header: string | undefined;
  secrets: readonly string[];
  now: Date;
  /** Accepted timestamp age; defaults to `DOIT_SIGNATURE_TOLERANCE`. The
   * platform sets it per gateway (sub-302 D19). */
  tolerance?: { pastSeconds: number; futureSeconds: number };
}): boolean {
  const { rawBody, header, secrets, now } = input;
  const tolerance = input.tolerance ?? DOIT_SIGNATURE_TOLERANCE;
  if (!header || header.length > 512) return false;
  let timestamp: string | null = null;
  const candidates: Buffer[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return false;
      timestamp = value;
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/i.test(value)) return false;
      candidates.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamp === null || candidates.length === 0) return false;
  const age = now.getTime() / 1000 - Number(timestamp);
  if (!(age <= tolerance.pastSeconds) || !(-age <= tolerance.futureSeconds))
    return false;

  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = signature(secret, timestamp, rawBody);
    for (const candidate of candidates)
      if (
        candidate.length === expected.length &&
        timingSafeEqual(expected, candidate)
      )
        matched = true;
  }
  return matched;
}
