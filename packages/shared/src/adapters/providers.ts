// Provider boundaries are transport-independent. Production implementations must
// verify signatures and resolve trusted tenant context before calling these APIs.
import {
  z,
  idrSchema,
  outletIdSchema,
  tenantIdSchema,
  isoDateTimeSchema,
  assertTrustedScopedContext,
  assertOutletInScope,
} from "../core/index.ts";
import type { ScopedTenantContext } from "../core/index.ts";

const reference = z.string().min(1).max(255);
const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };
const amount = idrSchema.refine((n) => n > 0, "Amount must be positive");
export const scopedReferenceSchema = z.strictObject({ ...scope, reference });
export const storageLookupSchema = scopedReferenceSchema.extend({
  key: reference,
});
export const paymentRequestSchema = z.strictObject({
  ...scope,
  reference,
  idempotencyKey: reference,
  amountIdr: amount,
  method: z.enum(["qris", "virtual_account", "bank_transfer"]),
});
export const paymentResultSchema = z.strictObject({
  reference,
  providerReference: reference,
  status: z.enum(["pending", "paid", "failed", "cancelled"]),
});
export const edcRequestSchema = z.strictObject({
  ...scope,
  reference,
  amountIdr: amount,
  bank: z.enum(["bca", "mandiri", "bni", "bjb"]),
  method: z.enum(["card", "qris"]),
});
export const edcResultSchema = paymentResultSchema;
export const wifiRequestSchema = z.strictObject({
  ...scope,
  reference,
  deviceId: reference,
  durationSeconds: z.number().int().positive(),
  bandwidthKbps: z.number().int().positive(),
  walledGarden: z.array(z.string().min(1)),
});
export const wifiResultSchema = z.strictObject({
  reference,
  authorized: z.boolean(),
});
export const inboundMessageSchema = z.strictObject({
  ...scope,
  eventId: reference,
  phoneNumberId: reference,
  sender: reference,
  text: z.string(),
  signatureHeader: z.literal("X-Kirim-Signature"),
});
export const messageRequestSchema = z.strictObject({
  ...scope,
  reference,
  recipient: reference,
  text: z.string().min(1),
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
  payload: z.record(z.string(), z.unknown()),
});
export const lockRequestSchema = z
  .strictObject({
    ...scope,
    reference,
    lockId: reference,
    credential: reference,
    validFrom: isoDateTimeSchema,
    validUntil: isoDateTimeSchema,
  })
  .refine((v) => Date.parse(v.validUntil) > Date.parse(v.validFrom));
export const storageRequestSchema = z.strictObject({
  ...scope,
  reference,
  key: reference,
  contentType: reference,
  content: z.string(),
});
export const emailRequestSchema = z.strictObject({
  ...scope,
  reference,
  to: z.email(),
  subject: z.string().min(1),
  body: z.string(),
});
export const pushRequestSchema = z.strictObject({
  ...scope,
  reference,
  endpoint: z.url(),
  title: z.string().min(1),
  body: z.string(),
});
export const llmConfigSchema = z.strictObject({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  model: reference,
});
export const llmRequestSchema = z.strictObject({
  ...scope,
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
});
export const operationResultSchema = z.strictObject({
  reference,
  accepted: z.boolean(),
});
export type ScopedReference = z.infer<typeof scopedReferenceSchema>;
export type StorageLookup = z.infer<typeof storageLookupSchema>;
export type PaymentRequest = z.infer<typeof paymentRequestSchema>;
export type PaymentResult = z.infer<typeof paymentResultSchema>;
export type EdcRequest = z.infer<typeof edcRequestSchema>;
export type EdcResult = z.infer<typeof edcResultSchema>;
export type WifiRequest = z.infer<typeof wifiRequestSchema>;
export type WifiResult = z.infer<typeof wifiResultSchema>;
export type InboundMessage = z.infer<typeof inboundMessageSchema>;
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
  createPayment(
    context: ScopedTenantContext,
    input: PaymentRequest,
  ): Promise<PaymentResult>;
}
export interface EdcProvider {
  transact(context: ScopedTenantContext, input: EdcRequest): Promise<EdcResult>;
  cancel(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<EdcResult>;
  status(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<EdcResult>;
}
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
  receive(
    context: ScopedTenantContext,
    input: InboundMessage,
  ): Promise<InboundMessage>;
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
function check(
  context: ScopedTenantContext,
  input: {
    tenantId: z.infer<typeof tenantIdSchema>;
    outletId: z.infer<typeof outletIdSchema>;
  },
) {
  assertTrustedScopedContext(context);
  if (context.tenant.tenantId !== input.tenantId)
    throw new TypeError("Tenant mismatch");
  assertOutletInScope(context.outletScope, input.outletId);
}
export class FakePaymentProvider implements PaymentProvider {
  async createPayment(c: ScopedTenantContext, input: PaymentRequest) {
    const v = paymentRequestSchema.parse(input);
    check(c, v);
    return paymentResultSchema.parse({
      reference: v.reference,
      providerReference: `fake-${v.reference}`,
      status: "pending",
    });
  }
}
function scopedKey(input: ScopedReference) {
  return JSON.stringify([input.tenantId, input.outletId, input.reference]);
}
export class FakeEdcProvider implements EdcProvider {
  private results = new Map<string, EdcResult>();
  async transact(c: ScopedTenantContext, input: EdcRequest) {
    const v = edcRequestSchema.parse(input);
    check(c, v);
    const key = scopedKey(v);
    const result =
      this.results.get(key) ??
      edcResultSchema.parse({
        reference: v.reference,
        providerReference: `fake-${v.reference}`,
        status: "pending",
      });
    this.results.set(key, result);
    return result;
  }
  async status(c: ScopedTenantContext, input: ScopedReference) {
    const v = scopedReferenceSchema.parse(input);
    check(c, v);
    const result = this.results.get(scopedKey(v));
    if (!result) throw new Error("EDC transaction not found");
    return result;
  }
  async cancel(c: ScopedTenantContext, input: ScopedReference) {
    const v = scopedReferenceSchema.parse(input);
    const result = await this.status(c, v);
    const cancelled = edcResultSchema.parse({ ...result, status: "cancelled" });
    this.results.set(scopedKey(v), cancelled);
    return cancelled;
  }
}
export class FakeWifiProvider implements WifiProvider {
  async authorize(c: ScopedTenantContext, input: WifiRequest) {
    const v = wifiRequestSchema.parse(input);
    check(c, v);
    return wifiResultSchema.parse({ reference: v.reference, authorized: true });
  }
  async revoke(c: ScopedTenantContext, input: ScopedReference) {
    const v = scopedReferenceSchema.parse(input);
    check(c, v);
    return wifiResultSchema.parse({
      reference: v.reference,
      authorized: false,
    });
  }
}
export class FakeMessagingProvider implements MessagingProvider {
  sent: MessageRequest[] = [];
  async receive(c: ScopedTenantContext, input: InboundMessage) {
    const v = inboundMessageSchema.parse(input);
    check(c, v);
    return v;
  }
  async send(c: ScopedTenantContext, input: MessageRequest) {
    const v = messageRequestSchema.parse(input);
    check(c, v);
    this.sent.push(v);
    return operationResultSchema.parse({
      reference: v.reference,
      accepted: true,
    });
  }
}
export class FakeDeliveryChannel implements DeliveryChannel {
  async execute(c: ScopedTenantContext, input: DeliveryRequest) {
    const v = deliveryRequestSchema.parse(input);
    check(c, v);
    return operationResultSchema.parse({
      reference: v.reference,
      accepted: true,
    });
  }
}
export class FakeLockProvider implements LockProvider {
  async issue(c: ScopedTenantContext, input: LockRequest) {
    const v = lockRequestSchema.parse(input);
    check(c, v);
    return operationResultSchema.parse({
      reference: v.reference,
      accepted: true,
    });
  }
}
export class FakeObjectStorage implements ObjectStorage {
  private objects = new Map<string, StorageRequest>();
  async put(c: ScopedTenantContext, input: StorageRequest) {
    const v = storageRequestSchema.parse(input);
    check(c, v);
    this.objects.set(JSON.stringify([v.tenantId, v.outletId, v.key]), v);
    return operationResultSchema.parse({
      reference: v.reference,
      accepted: true,
    });
  }
  async get(c: ScopedTenantContext, input: StorageLookup) {
    const v = storageLookupSchema.parse(input);
    check(c, v);
    const result = this.objects.get(
      JSON.stringify([v.tenantId, v.outletId, v.key]),
    );
    if (!result) throw new Error("Object not found");
    return storageRequestSchema.parse(result);
  }
}
export class FakeEmailProvider implements EmailProvider {
  async send(c: ScopedTenantContext, input: EmailRequest) {
    const v = emailRequestSchema.parse(input);
    check(c, v);
    return operationResultSchema.parse({
      reference: v.reference,
      accepted: true,
    });
  }
}
export class FakePushProvider implements PushProvider {
  async send(c: ScopedTenantContext, input: PushRequest) {
    const v = pushRequestSchema.parse(input);
    check(c, v);
    return operationResultSchema.parse({
      reference: v.reference,
      accepted: true,
    });
  }
}
export class FakeLlmProvider implements LlmProvider {
  async complete(c: ScopedTenantContext, input: LlmRequest) {
    const v = llmRequestSchema.parse(input);
    check(c, v);
    return llmResultSchema.parse({
      reference: v.reference,
      content: "Respons contoh Cafe Legend",
    });
  }
}
