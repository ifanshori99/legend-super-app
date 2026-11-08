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
import { CoreError } from "@starter/shared/core";
import {
  paymentChannelSchema,
  paymentInstructionsSchema,
  type PaymentChannel,
  type PaymentInstructions,
} from "@starter/shared/payment";
import { z } from "zod";
import type {
  GatewayMethodAvailability,
  GatewayPaymentMethod,
  GatewayPaymentStatus,
} from "./payment-gateway";

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
  paid_at: timestampSchema
    .nullish()
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
 * Status the lifecycle receives. `refunded` changes nothing here, so it is
 * reported as `pending` with no amount (money went back; the books are not
 * touched automatically). For a paid payment the amount is `amount`, the
 * figure the bill is credited (`total_amount` adds the unique code or a
 * customer-borne fee); the lifecycle compares it with the intent and flags a
 * mismatch.
 */
export function doitPaymentToGatewayStatus(
  payment: DoitPayment,
): GatewayPaymentStatus {
  if (payment.status === "refunded")
    return { status: "pending", providerRef: payment.id, amountIdr: null };
  return {
    status: payment.status,
    providerRef: payment.id,
    amountIdr: payment.status === "paid" ? payment.amount : null,
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
}): boolean {
  const { rawBody, header, secrets, now } = input;
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
  if (
    !(age <= DOIT_SIGNATURE_TOLERANCE.pastSeconds) ||
    !(-age <= DOIT_SIGNATURE_TOLERANCE.futureSeconds)
  )
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
