// Deterministic in-memory providers for FE mocks and BE tests. They follow the
// same rules a real adapter must: trusted context, tenant/outlet isolation and
// idempotent mutations. `simulate` methods stand in for the provider's own
// asynchronous outcome (webhook or status poll).
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
} from "../core/index.ts";
import type { ScopedTenantContext, z } from "../core/index.ts";
import {
  deliveryRequestSchema,
  edcRequestSchema,
  edcResultSchema,
  emailRequestSchema,
  inboundMessageResultSchema,
  inboundMessageSchema,
  llmRequestSchema,
  llmResultSchema,
  lockRequestSchema,
  messageRequestSchema,
  operationResultSchema,
  paymentRefundRequestSchema,
  paymentRequestSchema,
  paymentResultSchema,
  pushRequestSchema,
  scopedReferenceSchema,
  storageLookupSchema,
  storageRequestSchema,
  storageSignedLookupSchema,
  wifiRequestSchema,
  wifiResultSchema,
} from "./providers.ts";
import type {
  DeliveryChannel,
  EdcProvider,
  EdcRequest,
  EdcResult,
  EmailProvider,
  EmailRequest,
  InboundMessage,
  InboundMessageResult,
  LlmProvider,
  LlmRequest,
  LlmResult,
  LockProvider,
  LockRequest,
  MessageRequest,
  MessagingProvider,
  ObjectStorage,
  OperationResult,
  PaymentProvider,
  PaymentRefundRequest,
  PaymentRequest,
  PaymentResult,
  PushProvider,
  PushRequest,
  ScopedReference,
  StorageLookup,
  StorageRequest,
  StorageSignedLookup,
  WifiProvider,
  WifiRequest,
  WifiResult,
  DeliveryRequest,
} from "./providers.ts";
import { stableStringify } from "./safety.ts";
import { verifyKirimWebhook } from "./webhook.ts";
import type { VerifiedWebhook, WebhookVerificationInput } from "./webhook.ts";

/** Secret the fakes verify webhooks with unless told otherwise. */
export const FAKE_WEBHOOK_SECRET = "fake-kirim-webhook-secret";

type Scoped = { tenantId: string; outletId: string | null };

/** Parse first-class: trusted context, schema, then tenant and outlet checks. */
function accept<S extends z.ZodType<Scoped>>(
  context: ScopedTenantContext,
  schema: S,
  input: unknown,
): z.output<S> {
  assertTrustedScopedContext(context);
  const value = schema.parse(input);
  if (context.tenant.tenantId !== value.tenantId)
    throw new TypeError("Tenant mismatch");
  if (value.outletId === null) {
    if (context.outletScope.kind !== "tenant")
      throw new CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Anda tidak memiliki akses ke operasi tingkat tenant.",
      );
  } else assertOutletInScope(context.outletScope, value.outletId);
  return value;
}
const keyOf = (...parts: readonly unknown[]) => JSON.stringify(parts);
const refKey = (v: Scoped & { reference: string }) =>
  keyOf(v.tenantId, v.outletId, v.reference);
const notFound = (what: string) =>
  new CoreError("NOT_FOUND", `${what} tidak ditemukan.`);
const conflict = (message: string) => new CoreError("CONFLICT", message);
const reused = () =>
  new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "Kunci atau referensi yang sama dipakai dengan permintaan berbeda.",
  );

/** Replays the first result for an identical request; fails on a different one. */
class Idempotent<Result> {
  private entries = new Map<string, { fingerprint: string; result: Result }>();
  run(key: string, request: unknown, create: () => Result): Result {
    const fingerprint = stableStringify(request);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw reused();
      return existing.result;
    }
    const result = create();
    this.entries.set(key, { fingerprint, result });
    return result;
  }
}
function providerRef(prefix: string, reference: string) {
  return `${prefix}-${reference}`;
}

type Settled = "paid" | "failed" | "expired";

export class FakePaymentProvider implements PaymentProvider {
  private byKey = new Map<string, { fingerprint: string; ref: string }>();
  private payments = new Map<
    string,
    { amountIdr: number; result: PaymentResult }
  >();
  private refunds = new Idempotent<PaymentResult>();

  async createPayment(c: ScopedTenantContext, input: PaymentRequest) {
    const v = accept(c, paymentRequestSchema, input);
    const idemKey = keyOf(v.tenantId, v.idempotencyKey);
    const fingerprint = stableStringify(v);
    const prior = this.byKey.get(idemKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw reused();
      return (this.payments.get(prior.ref) as { result: PaymentResult }).result;
    }
    const ref = refKey(v);
    const current = this.payments.get(ref)?.result.status;
    if (current === "pending" || current === "paid" || current === "refunded")
      throw conflict("Pembayaran untuk referensi ini sudah ada.");
    const result = paymentResultSchema.parse({
      reference: v.reference,
      providerReference: providerRef(
        "fake",
        `${v.reference}-${this.byKey.size + 1}`,
      ),
      status: "pending",
    });
    this.payments.set(ref, { amountIdr: v.amountIdr, result });
    this.byKey.set(idemKey, { fingerprint, ref });
    return result;
  }
  async getPayment(c: ScopedTenantContext, input: ScopedReference) {
    const v = accept(c, scopedReferenceSchema, input);
    const found = this.payments.get(refKey(v));
    if (!found) throw notFound("Pembayaran");
    return found.result;
  }
  async refund(c: ScopedTenantContext, input: PaymentRefundRequest) {
    const v = accept(c, paymentRefundRequestSchema, input);
    return this.refunds.run(keyOf(v.tenantId, v.idempotencyKey), v, () => {
      const found = this.payments.get(refKey(v));
      if (!found) throw notFound("Pembayaran");
      if (found.result.status !== "paid")
        throw conflict("Hanya pembayaran lunas yang dapat direfund.");
      if (v.amountIdr > found.amountIdr)
        throw conflict("Nominal refund melebihi pembayaran.");
      found.result = paymentResultSchema.parse({
        ...found.result,
        status: "refunded",
      });
      return found.result;
    });
  }
  /** Test hook: the provider settles a pending payment. */
  simulate(ref: ScopedReference, status: Settled) {
    const found = this.payments.get(refKey(scopedReferenceSchema.parse(ref)));
    if (!found) throw notFound("Pembayaran");
    if (found.result.status !== "pending")
      throw new Error("Only a pending payment can be settled");
    found.result = paymentResultSchema.parse({ ...found.result, status });
    return found.result;
  }
}

export class FakeEdcProvider implements EdcProvider {
  private results = new Idempotent<EdcResult>();
  private current = new Map<string, EdcResult>();
  async transact(c: ScopedTenantContext, input: EdcRequest) {
    const v = accept(c, edcRequestSchema, input);
    const key = refKey(v);
    this.results.run(key, v, () => {
      const result = edcResultSchema.parse({
        reference: v.reference,
        providerReference: providerRef("fake", v.reference),
        status: "pending",
      });
      this.current.set(key, result);
      return result;
    });
    return this.current.get(key) as EdcResult;
  }
  async status(c: ScopedTenantContext, input: ScopedReference) {
    const v = accept(c, scopedReferenceSchema, input);
    const result = this.current.get(refKey(v));
    if (!result) throw notFound("Transaksi EDC");
    return result;
  }
  async cancel(c: ScopedTenantContext, input: ScopedReference) {
    const v = accept(c, scopedReferenceSchema, input);
    const result = await this.status(c, v);
    if (result.status === "cancelled") return result;
    if (result.status !== "pending")
      throw conflict("Hanya transaksi EDC yang tertunda dapat dibatalkan.");
    const cancelled = edcResultSchema.parse({ ...result, status: "cancelled" });
    this.current.set(refKey(v), cancelled);
    return cancelled;
  }
  /** Test hook: the terminal settles a pending transaction. */
  simulate(ref: ScopedReference, status: Settled) {
    const key = refKey(scopedReferenceSchema.parse(ref));
    const result = this.current.get(key);
    if (!result) throw notFound("Transaksi EDC");
    if (result.status !== "pending")
      throw new Error("Only a pending transaction can be settled");
    const next = edcResultSchema.parse({ ...result, status });
    this.current.set(key, next);
    return next;
  }
}

/** Authorization that can be revoked: state per reference. */
class Grants {
  private grants = new Map<string, { fingerprint: string; active: boolean }>();
  grant(key: string, request: unknown): boolean {
    const fingerprint = stableStringify(request);
    const existing = this.grants.get(key);
    if (!existing) {
      this.grants.set(key, { fingerprint, active: true });
      return true;
    }
    if (existing.fingerprint !== fingerprint) throw reused();
    return existing.active;
  }
  /** Returns false when the reference is unknown. */
  revoke(key: string): boolean {
    const existing = this.grants.get(key);
    if (!existing) return false;
    existing.active = false;
    return true;
  }
}

export class FakeWifiProvider implements WifiProvider {
  private grants = new Grants();
  async authorize(c: ScopedTenantContext, input: WifiRequest) {
    const v = accept(c, wifiRequestSchema, input);
    return wifiResultSchema.parse({
      reference: v.reference,
      authorized: this.grants.grant(refKey(v), v),
    });
  }
  /** Revoking an unknown voucher is a no-op: it is not authorized either way. */
  async revoke(
    c: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<WifiResult> {
    const v = accept(c, scopedReferenceSchema, input);
    this.grants.revoke(refKey(v));
    return wifiResultSchema.parse({
      reference: v.reference,
      authorized: false,
    });
  }
}

export class FakeMessagingProvider implements MessagingProvider {
  /** Messages actually sent; replays of the same reference add nothing. */
  sent: MessageRequest[] = [];
  private seen = new Set<string>();
  private outbound = new Idempotent<OperationResult>();
  private readonly secrets: readonly string[];
  constructor(secrets: readonly string[] = [FAKE_WEBHOOK_SECRET]) {
    this.secrets = secrets;
  }

  verifyWebhook(
    input: Omit<WebhookVerificationInput, "secrets">,
  ): Promise<VerifiedWebhook> {
    return verifyKirimWebhook({ ...input, secrets: this.secrets });
  }
  async receive(
    c: ScopedTenantContext,
    input: InboundMessage,
  ): Promise<InboundMessageResult> {
    const v = accept(c, inboundMessageSchema, input);
    const key = keyOf(v.tenantId, v.eventId);
    const duplicate = this.seen.has(key);
    this.seen.add(key);
    return inboundMessageResultSchema.parse({ message: v, duplicate });
  }
  async send(c: ScopedTenantContext, input: MessageRequest) {
    const v = accept(c, messageRequestSchema, input);
    return this.outbound.run(refKey(v), v, () => {
      this.sent.push(v);
      return operationResultSchema.parse({
        reference: v.reference,
        accepted: true,
      });
    });
  }
}

function accepted(reference: string) {
  return operationResultSchema.parse({ reference, accepted: true });
}

export class FakeDeliveryChannel implements DeliveryChannel {
  private ops = new Idempotent<OperationResult>();
  async execute(c: ScopedTenantContext, input: DeliveryRequest) {
    const v = accept(c, deliveryRequestSchema, input);
    return this.ops.run(refKey(v), v, () => accepted(v.reference));
  }
}

export class FakeLockProvider implements LockProvider {
  private grants = new Grants();
  async issue(c: ScopedTenantContext, input: LockRequest) {
    const v = accept(c, lockRequestSchema, input);
    this.grants.grant(refKey(v), v);
    return accepted(v.reference);
  }
  async revoke(c: ScopedTenantContext, input: ScopedReference) {
    const v = accept(c, scopedReferenceSchema, input);
    if (!this.grants.revoke(refKey(v))) throw notFound("Kredensial kunci");
    return accepted(v.reference);
  }
}

export class FakeObjectStorage implements ObjectStorage {
  private objects = new Map<string, StorageRequest>();
  private key(v: StorageLookup) {
    return keyOf(v.tenantId, v.outletId, v.visibility ?? "private", v.key);
  }
  /** `put` overwrites the object at the key; `reference` only labels the write. */
  async put(c: ScopedTenantContext, input: StorageRequest) {
    const v = accept(c, storageRequestSchema, input);
    const content =
      typeof v.content === "string" ? v.content : new Uint8Array(v.content);
    this.objects.set(this.key(v), { ...v, content });
    return accepted(v.reference);
  }
  async get(c: ScopedTenantContext, input: StorageLookup) {
    const v = accept(c, storageLookupSchema, input);
    const result = this.objects.get(this.key(v));
    if (!result) throw notFound("Objek");
    return {
      ...result,
      content:
        typeof result.content === "string"
          ? result.content
          : new Uint8Array(result.content),
    };
  }
  async delete(c: ScopedTenantContext, input: StorageLookup) {
    const v = accept(c, storageLookupSchema, input);
    this.objects.delete(this.key(v));
  }
  async signedGetUrl(c: ScopedTenantContext, input: StorageSignedLookup) {
    const v = accept(c, storageSignedLookupSchema, input);
    if (v.visibility === "public")
      throw new TypeError("Private object required");
    return `https://storage.invalid/private/${encodeURIComponent(this.key(v))}?expires=${v.expiresInSeconds}`;
  }
  async publicUrl(c: ScopedTenantContext, input: StorageLookup) {
    const v = accept(c, storageLookupSchema, input);
    if (v.visibility !== "public")
      throw new TypeError("Public object required");
    return `https://storage.invalid/public/${encodeURIComponent(this.key(v))}`;
  }
}

export class FakeEmailProvider implements EmailProvider {
  sent: EmailRequest[] = [];
  private ops = new Idempotent<OperationResult>();
  async send(c: ScopedTenantContext, input: EmailRequest) {
    const v = accept(c, emailRequestSchema, input);
    return this.ops.run(refKey(v), v, () => {
      this.sent.push(v);
      return accepted(v.reference);
    });
  }
}

export class FakePushProvider implements PushProvider {
  sent: PushRequest[] = [];
  private ops = new Idempotent<OperationResult>();
  async send(c: ScopedTenantContext, input: PushRequest) {
    const v = accept(c, pushRequestSchema, input);
    return this.ops.run(refKey(v), v, () => {
      this.sent.push(v);
      return accepted(v.reference);
    });
  }
}

export class FakeLlmProvider implements LlmProvider {
  private ops = new Idempotent<LlmResult>();
  async complete(c: ScopedTenantContext, input: LlmRequest) {
    const v = accept(c, llmRequestSchema, input);
    return this.ops.run(refKey(v), v, () =>
      llmResultSchema.parse({
        reference: v.reference,
        content: "Respons contoh Cafe Legend",
        usage: { promptTokens: 8, completionTokens: 6 },
      }),
    );
  }
}
