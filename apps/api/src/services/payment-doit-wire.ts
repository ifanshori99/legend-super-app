// DOIT wire format (bead legend-b9i; PRD v1.7 §3.13 F13, PAY-02/03/06).
//
// ASSUMED WIRE FORMAT. Everything in this file (paths are in payment-doit.ts,
// shapes, header name and signature scheme) is an assumption until the DOIT
// sandbox documentation arrives (bead legend-s5c). It is kept in one place so
// that confirming or correcting it touches only this file and its tests:
//   - GET  /v1/payment-methods  -> { data: [{ method, channel_code, channel_name, enabled }] }
//   - POST /v1/payments         -> payment object
//   - GET  /v1/payments/{id}    -> payment object
//   - Webhook header `PayBridge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw bytes)>`
//   - Webhook body   { id, type, created_at, data: <payment object> }
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

/** Header DOIT signs webhooks with. */
export const DOIT_SIGNATURE_HEADER = "PayBridge-Signature";
/** Largest clock difference between DOIT and this server accepted on a webhook. */
export const DOIT_SIGNATURE_TOLERANCE_SECONDS = 300;

const amountSchema = z.number().int().nonnegative();
const timestampSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp");
const optionalText = (max: number) =>
  z.string().min(1).max(max).nullish().catch(null);

export const doitPaymentStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "failed",
  "cancelled",
]);
export type DoitPaymentStatus = z.infer<typeof doitPaymentStatusSchema>;

/** Payment object returned by create/get and embedded in webhook events.
 * Unknown extra fields are dropped, never echoed. */
export const doitPaymentSchema = z.object({
  id: z.string().min(1).max(100),
  reference: z.string().min(1).max(100),
  status: doitPaymentStatusSchema,
  amount: amountSchema,
  paid_amount: amountSchema.nullish().transform((value) => value ?? null),
  expires_at: timestampSchema,
  paid_at: timestampSchema.nullish().transform((value) => value ?? null),
  qr_string: z.string().max(2048).nullish(),
  va_number: z.string().max(40).nullish(),
  channel_code: z.string().max(40).nullish(),
  channel_name: z.string().max(60).nullish(),
  account_number: z.string().max(40).nullish(),
  account_name: z.string().max(80).nullish(),
  unique_code: z.string().max(10).nullish(),
  transfer_amount: amountSchema.nullish().transform((value) => value ?? null),
});
export type DoitPayment = z.infer<typeof doitPaymentSchema>;

export const doitPaymentMethodsSchema = z.object({
  data: z
    .array(
      z.object({
        method: z.string().min(1).max(40),
        channel_code: optionalText(40),
        channel_name: optionalText(60),
        enabled: z.boolean(),
      }),
    )
    .max(500),
});

/** Webhook body: the event envelope around a payment object. */
export const doitWebhookEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(60),
  created_at: timestampSchema,
  data: doitPaymentSchema,
});
export type DoitWebhookEvent = z.infer<typeof doitWebhookEventSchema>;

// -- Methods ----------------------------------------------------------------

const KNOWN_METHODS = {
  qris: "qris",
  virtual_account: "va",
  bank_transfer: "bank_transfer",
  ewallet: "ewallet",
  card: "card",
} as const satisfies Record<string, GatewayPaymentMethod>;

/** Methods this adapter can create a payment for. */
export const DOIT_CREATABLE_METHODS = [
  "qris",
  "va",
  "bank_transfer",
] as const satisfies readonly GatewayPaymentMethod[];

const WIRE_METHOD: Record<(typeof DOIT_CREATABLE_METHODS)[number], string> = {
  qris: "qris",
  va: "virtual_account",
  bank_transfer: "bank_transfer",
};

export function toDoitWireMethod(
  method: (typeof DOIT_CREATABLE_METHODS)[number],
): string {
  return WIRE_METHOD[method];
}

/** Group the provider's rows per method; unknown methods are ignored. This
 * adapter cannot create e-wallet or card payments, so those are reported as
 * disabled whatever DOIT says. */
export function mapDoitMethods(
  rows: z.infer<typeof doitPaymentMethodsSchema>["data"],
): GatewayMethodAvailability[] {
  const grouped = new Map<
    GatewayPaymentMethod,
    { enabled: boolean; channels: Map<string, PaymentChannel> }
  >();
  for (const row of rows) {
    const method = (KNOWN_METHODS as Record<string, GatewayPaymentMethod>)[
      row.method
    ];
    if (!method) continue;
    const entry = grouped.get(method) ?? {
      enabled: false,
      channels: new Map<string, PaymentChannel>(),
    };
    grouped.set(method, entry);
    if (!row.enabled) continue;
    entry.enabled = true;
    if (method === "qris" || !row.channel_code || !row.channel_name) continue;
    const channel = paymentChannelSchema.safeParse({
      code: row.channel_code,
      name: row.channel_name,
    });
    if (channel.success && !entry.channels.has(channel.data.code))
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

/** A bank transfer pays amount + unique code. The code is absorbed only when
 * it is a 3-6 digit code and the transfer total is exactly the amount plus
 * that code, and the figure paid is that total. */
export function absorbsUniqueCode(payment: DoitPayment): boolean {
  if (payment.transfer_amount === null || payment.unique_code == null)
    return false;
  if (!/^\d{3,6}$/.test(payment.unique_code)) return false;
  return (
    payment.transfer_amount - payment.amount === Number(payment.unique_code) &&
    payment.paid_amount === payment.transfer_amount
  );
}

/**
 * Status the lifecycle receives. `cancelled` is a failure. For a paid payment
 * the amount is the intent amount when DOIT collected exactly that (or, for a
 * bank transfer, the amount plus the unique code, which the bill does not
 * owe); any other figure is reported raw so the lifecycle flags the mismatch;
 * no figure at all is `null` (fail closed).
 */
export function doitPaymentToGatewayStatus(
  payment: DoitPayment,
): GatewayPaymentStatus {
  const status = payment.status === "cancelled" ? "failed" : payment.status;
  let amountIdr: number | null = null;
  if (status === "paid" && payment.paid_amount !== null) {
    amountIdr =
      payment.paid_amount === payment.amount || absorbsUniqueCode(payment)
        ? payment.amount
        : payment.paid_amount;
  }
  return { status, providerRef: payment.id, amountIdr };
}

/** Guest instructions for a just-created payment. Any missing or malformed
 * field is a provider fault: no partial data. */
export function doitPaymentToInstructions(
  payment: DoitPayment,
  method: (typeof DOIT_CREATABLE_METHODS)[number],
  channelCode: string | null,
): PaymentInstructions {
  const candidate =
    method === "qris"
      ? { method, qrPayload: payment.qr_string, issuer: null }
      : method === "va"
        ? {
            method,
            channelCode: payment.channel_code ?? channelCode,
            channelName: payment.channel_name,
            virtualAccountNumber: payment.va_number,
          }
        : {
            method,
            channelCode: payment.channel_code ?? channelCode,
            channelName: payment.channel_name,
            accountNumber: payment.account_number,
            accountHolder: payment.account_name,
            uniqueCode: payment.unique_code,
            transferTotalIdr: payment.transfer_amount,
          };
  const parsed = paymentInstructionsSchema.safeParse(candidate);
  if (!parsed.success) throw malformedProviderAnswer();
  if (
    parsed.data.method === "bank_transfer" &&
    parsed.data.transferTotalIdr !==
      payment.amount + Number(parsed.data.uniqueCode)
  )
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
 * secret). False on a missing or malformed header, a timestamp more than 300 s
 * away from `now`, or no secret matching (constant-time compare).
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
  const skew = Math.abs(now.getTime() / 1000 - Number(timestamp));
  if (!(skew <= DOIT_SIGNATURE_TOLERANCE_SECONDS)) return false;

  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = signature(secret, timestamp, rawBody);
    for (const candidate of candidates)
      if (timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched;
}
