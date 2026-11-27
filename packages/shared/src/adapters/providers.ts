// Provider boundaries are transport-independent. Production implementations must
// verify signatures (see webhook.ts) and resolve trusted tenant context before
// calling these APIs. Every method takes a server-minted ScopedTenantContext;
// the tenantId/outletId inside a request must equal the context's, they never
// widen it. Mutating calls are idempotent: repeating the same request returns
// the first result, reusing a key or reference with a different request fails
// with IDEMPOTENCY_KEY_REUSED. Amounts are whole rupiah (D-CORE-2).
import {
  z,
  idrSchema,
  idempotencyKeySchema,
  outletIdSchema,
  tenantIdSchema,
  isoDateTimeSchema,
} from "../core/index.ts";
import type { ScopedTenantContext } from "../core/index.ts";
import {
  phoneDigitsSchema,
  publicHttpsUrlSchema,
  singleLineSchema,
  storageKeySchema,
} from "./safety.ts";
import type { VerifiedWebhook, WebhookVerificationInput } from "./webhook.ts";

const reference = z.string().min(1).max(255);
/** Outlet-bound operations (cash desk, device, room). */
const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };
/** Operations that may be tenant-wide (`outletId: null`); that needs a
 * tenant-wide OutletScope, an outlet-scoped caller is refused. */
const tenantScope = {
  tenantId: tenantIdSchema,
  outletId: outletIdSchema.nullable(),
};
const amount = idrSchema.refine((n) => n > 0, "Amount must be positive");
const json = z.record(z.string(), z.json());

export const scopedReferenceSchema = z.strictObject({ ...scope, reference });
export const storageLookupSchema = z.strictObject({
  ...tenantScope,
  reference,
  key: storageKeySchema,
  visibility: z.enum(["public", "private"]).optional(),
});
/** Header-safe download name: no quotes, separators, whitespace, CR/LF or non-ASCII. */
export const storageDownloadFileNameSchema = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Unsafe download file name");
export const storageSignedLookupSchema = storageLookupSchema.extend({
  expiresInSeconds: z.number().int().min(1).max(3600),
  /** When set, the signed response carries `Content-Disposition: attachment`. */
  downloadFileName: storageDownloadFileNameSchema.optional(),
});

/** PRD §5 payment cycle: pending -> paid | expired | failed -> refunded;
 * `cancelled` is a cancelled attempt (EDC, voided intent). */
export const providerPaymentStatusSchema = z.enum([
  "pending",
  "paid",
  "expired",
  "failed",
  "cancelled",
  "refunded",
]);
export const paymentRequestSchema = z.strictObject({
  ...scope,
  reference,
  idempotencyKey: idempotencyKeySchema,
  amountIdr: amount,
  method: z.enum(["qris", "virtual_account", "bank_transfer"]),
});
export const paymentRefundRequestSchema = z.strictObject({
  ...scope,
  /** The payment's reference. */
  reference,
  idempotencyKey: idempotencyKeySchema,
  amountIdr: amount,
});
export const paymentResultSchema = z.strictObject({
  reference,
  providerReference: reference,
  status: providerPaymentStatusSchema,
});
export const edcRequestSchema = z.strictObject({
  ...scope,
  reference,
  amountIdr: amount,
  bank: z.enum(["bca", "mandiri", "bni", "bjb", "bri"]),
  method: z.enum(["card", "qris"]),
});
export const edcResultSchema = paymentResultSchema;
export const wifiRequestSchema = z.strictObject({
  ...scope,
  reference,
  deviceId: reference,
  durationSeconds: z.number().int().positive().safe(),
  bandwidthKbps: z.number().int().positive().safe(),
  walledGarden: z.array(z.string().min(1).max(253)).max(100),
});
export const wifiResultSchema = z.strictObject({
  reference,
  authorized: z.boolean(),
});
/** A message already authenticated by `MessagingProvider.verifyWebhook` and
 * routed to a tenant by the receiving number (`phoneNumberId`). The signature
 * header is never part of this object. */
export const inboundMessageSchema = z.strictObject({
  ...scope,
  /** Provider message id (`X-Kirim-Event-Id`): process each at most once. */
  eventId: reference,
  phoneNumberId: reference,
  sender: phoneDigitsSchema,
  /** WhatsApp text limit is 4096 characters. */
  text: z.string().max(4096),
});
/** `duplicate: true` means this message id was already processed: do not
 * create a session or challenge again (AUTH-02). */
export const inboundMessageResultSchema = z.strictObject({
  message: inboundMessageSchema,
  duplicate: z.boolean(),
});
export const messageRequestSchema = z.strictObject({
  ...scope,
  reference,
  recipient: phoneDigitsSchema,
  text: z.string().min(1).max(4096),
});
export const deliveryRequestSchema = z.strictObject({
  ...scope,
  reference,
  channel: z.enum(["gofood", "grabfood", "shopeefood"]),
  action: z.enum([
    "sync_menu",
    "open",
    "close",
    "sold_out",
    "accept_order",
    "update_order",
    "cancel_order",
  ]),
  payload: json,
});
/** `credential` is a secret (door code): never log, audit or put it in an event
 * payload; results and errors do not echo it. */
export const lockRequestSchema = z
  .strictObject({
    ...scope,
    reference,
    lockId: reference,
    credential: reference,
    validFrom: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
  })
  .refine((v) => Date.parse(v.validUntil) > Date.parse(v.validFrom), {
    message: "validUntil must be after validFrom",
    path: ["validUntil"],
  });
export const storageRequestSchema = z.strictObject({
  ...tenantScope,
  reference,
  key: storageKeySchema,
  contentType: reference,
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
  visibility: z.enum(["public", "private"]).optional(),
});
export const emailRequestSchema = z.strictObject({
  ...tenantScope,
  reference,
  to: z.email(),
  subject: singleLineSchema,
  body: z.string(),
});
export const pushRequestSchema = z.strictObject({
  ...tenantScope,
  reference,
  endpoint: publicHttpsUrlSchema,
  title: z.string().min(1),
  body: z.string(),
});
export const llmConfigSchema = z.strictObject({
  baseUrl: publicHttpsUrlSchema,
  apiKey: z.string().min(1),
  model: reference,
});
/** Safe to log or return to a client: the key is replaced. */
export function redactLlmConfig(config: LlmConfig) {
  return { baseUrl: config.baseUrl, model: config.model, apiKey: "[REDACTED]" };
}
export const llmRequestSchema = z.strictObject({
  ...tenantScope,
  reference,
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
});
export const llmResultSchema = z.strictObject({
  reference,
  content: z.string(),
  /** For ai_jobs cost accounting; null when the endpoint reports none. */
  usage: z
    .strictObject({
      promptTokens: z.number().int().nonnegative().safe(),
      completionTokens: z.number().int().nonnegative().safe(),
    })
    .nullable()
    .default(null),
});
export const operationResultSchema = z.strictObject({
  reference,
  accepted: z.boolean(),
});
export type ScopedReference = z.infer<typeof scopedReferenceSchema>;
export type StorageLookup = z.infer<typeof storageLookupSchema>;
export type StorageSignedLookup = z.infer<typeof storageSignedLookupSchema>;
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;
export type PaymentRefundRequest = z.infer<typeof paymentRefundRequestSchema>;
export type PaymentResult = z.infer<typeof paymentResultSchema>;
export type ProviderPaymentStatus = z.infer<typeof providerPaymentStatusSchema>;
export type EdcRequest = z.infer<typeof edcRequestSchema>;
export type EdcResult = z.infer<typeof edcResultSchema>;
export type WifiRequest = z.infer<typeof wifiRequestSchema>;
export type WifiResult = z.infer<typeof wifiResultSchema>;
export type InboundMessage = z.infer<typeof inboundMessageSchema>;
export type InboundMessageResult = z.infer<typeof inboundMessageResultSchema>;
export type MessageRequest = z.infer<typeof messageRequestSchema>;
export type DeliveryRequest = z.infer<typeof deliveryRequestSchema>;
export type LockRequest = z.infer<typeof lockRequestSchema>;
export type StorageRequest = z.infer<typeof storageRequestSchema>;
export type EmailRequest = z.infer<typeof emailRequestSchema>;
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type LlmRequest = z.infer<typeof llmRequestSchema>;
export type LlmResult = z.infer<typeof llmResultSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;

export interface PaymentProvider {
  /** Idempotent per (tenant, idempotencyKey). */
  createPayment(
    context: ScopedTenantContext,
    input: PaymentRequest,
  ): Promise<PaymentResult>;
  /** Source of truth for scheduled status checks (webhooks can be late). */
  getPayment(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<PaymentResult>;
  /** Only a paid payment, up to its amount. */
  refund(
    context: ScopedTenantContext,
    input: PaymentRefundRequest,
  ): Promise<PaymentResult>;
}
/** Cloud-side boundary used by fakes and agent RPC fixtures. The edge EDC agent
 * and per-bank ECR adapters use `EdcProvider` from `@starter/shared/edc`. */
export interface EdcProvider {
  transact(context: ScopedTenantContext, input: EdcRequest): Promise<EdcResult>;
  /** Only a pending transaction. */
  cancel(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<EdcResult>;
  status(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<EdcResult>;
}
/** Venue Wi-Fi controller boundary (edge Wi-Fi agent, bead legend-hsk).
 * - `reference` is one grant. The same reference with the same request replays;
 *   a different request fails `IDEMPOTENCY_KEY_REUSED`; a revoked reference
 *   never authorizes again (`authorized: false`).
 * - A new `authorize` for a `deviceId` that already holds a grant replaces that
 *   device's rate and duration without a gap (RADIUS CoA or a controller API
 *   update). The adapter must guarantee this: a speed change never cuts the
 *   device.
 * - `revoke` of a reference that was superseded on its device is a no-op for
 *   the device.
 * - `durationSeconds` lapsing at the controller is a cut. Callers renew before
 *   it lapses.
 * - `walledGarden` is the pre-auth allowlist (hosts). Adapters that can set it
 *   at the controller also implement the optional `WifiWalledGardenSync`
 *   capability (`@starter/shared/edge`). */
export interface WifiProvider {
  authorize(
    context: ScopedTenantContext,
    input: WifiRequest,
  ): Promise<WifiResult>;
  revoke(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<WifiResult>;
}
export interface MessagingProvider {
  /** AUTH-02 (KirimDev, owner-approved): authenticates a webhook delivery from
   * `X-Kirim-Signature` (HMAC-SHA256 over "<t>.<raw body>", 300 s window) before
   * any parsing or tenant routing. Throws UNAUTHORIZED on failure. The caller
   * then routes by receiving number, dedupes on `eventId`, and calls `receive`. */
  verifyWebhook(
    input: Omit<WebhookVerificationInput, "secrets">,
  ): Promise<VerifiedWebhook>;
  /** Idempotent per (tenant, eventId). Never sends an automatic reply. */
  receive(
    context: ScopedTenantContext,
    input: InboundMessage,
  ): Promise<InboundMessageResult>;
  /** Idempotent per (tenant, outlet, reference). */
  send(
    context: ScopedTenantContext,
    input: MessageRequest,
  ): Promise<OperationResult>;
}
export interface DeliveryChannel {
  execute(
    context: ScopedTenantContext,
    input: DeliveryRequest,
  ): Promise<OperationResult>;
}
export interface LockProvider {
  issue(
    context: ScopedTenantContext,
    input: LockRequest,
  ): Promise<OperationResult>;
  revoke(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<OperationResult>;
}
export interface ObjectStorage {
  put(
    context: ScopedTenantContext,
    input: StorageRequest,
  ): Promise<OperationResult>;
  get(
    context: ScopedTenantContext,
    input: StorageLookup,
  ): Promise<StorageRequest>;
  delete(context: ScopedTenantContext, input: StorageLookup): Promise<void>;
  signedGetUrl(
    context: ScopedTenantContext,
    input: StorageSignedLookup,
  ): Promise<string>;
  publicUrl(
    context: ScopedTenantContext,
    input: StorageLookup,
  ): Promise<string>;
}
export interface EmailProvider {
  send(
    context: ScopedTenantContext,
    input: EmailRequest,
  ): Promise<OperationResult>;
}
export interface PushProvider {
  send(
    context: ScopedTenantContext,
    input: PushRequest,
  ): Promise<OperationResult>;
}
export interface LlmProvider {
  complete(context: ScopedTenantContext, input: LlmRequest): Promise<LlmResult>;
}
