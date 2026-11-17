// DOIT webhook intake (bead legend-b9i; PRD v1.7 §3 F13, PAY-02/03/06).
//
// Order of work: verify the signature over the raw bytes, STORE the event in
// `gateway_webhook_events`, then process it. The stored row is what makes a
// provider retry a no-op (unique per provider event id) and what the worker
// reprocesses when this request died half way. The payload status is the
// truth, never the arrival order: `confirmPayment` settles a paid event even
// after an expired one, and `applyGatewayFailure` never downgrades a paid
// intent. A rejected delivery keeps only the payload hash (PAY-06).
//
// A verified event is also bound to the intent it names: provider ref, intent
// id (`data.reference`), amount and the integration that signed it must all
// agree, otherwise the row is `ignored` and nothing settles; a paid `amount`
// that differs from the intent goes the AMOUNT_MISMATCH way (money parked).
// Only `payment.paid` and `payment.expired` move an intent; `refund.succeeded`
// and `refund.failed` close an approved refund (see processRefundEvent);
// `invoice.created` and `invoice.paid` go to the recurring billing service
// (payment-recurring.service.ts); any other event type (`webhook.test`, ...)
// is stored `ignored`.
// Failures before the signature is verified all answer with the same
// UNAUTHORIZED error.

import { createHash } from "node:crypto";
import {
  CoreError,
  createUlid,
  isoDateTimeSchema,
  tenantIdSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db";
import {
  gatewayWebhookEvents,
  paymentIntents,
  paymentEvidence,
  paymentRecurringSubscriptions,
  paymentRefunds,
  paymentUnallocatedFunds,
  tenants,
  type GatewayWebhookEvent,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import { recordAudit } from "./core-audit";
import {
  applyGatewayFailure,
  confirmPayment,
  markGatewayReconciled,
  recordUnsettledGatewayFunds,
} from "./payment.service";
import { decidePaymentConfirmation } from "./payment-lifecycle";
import { plausiblePaidAt } from "./payment-paid-at";
import {
  doitRefundWebhookEventSchema,
  isDoitRefundEvent,
  matchDoitRefundEvent,
  pickRefundCandidate,
  readDoitRefundFacts,
  type DoitRefundFacts,
  type DoitRefundWebhookEvent,
} from "./payment-doit-refund-webhook";
import {
  applyRefundProviderUpdate,
  SETTLED_OUTSIDE_PROVIDER,
} from "./payment-refund.service";
import { gatewayWebhookTolerance } from "./platform-payment-gateway.service";
import { processDoitInvoiceEvent } from "./payment-recurring.service";
import {
  DOIT_RECURRING_EVENT_TYPES,
  isDoitRecurringEvent,
  parseDoitInvoiceEvent,
  type DoitInvoiceEvent,
} from "./payment-doit-recurring-wire";
import {
  doitWebhookEnvelopeSchema,
  doitWebhookEventSchema,
  isDoitPaymentEvent,
  verifyDoitSignature,
} from "./payment-doit-wire";
import {
  listIntegrations,
  loadActiveIntegrationCredentials,
  loadIntegrationCredentialsById,
} from "./platform-integration.service";

const PROVIDER = "doit";
const SIGNATURE_MESSAGE = "Tanda tangan webhook tidak valid.";
/** Worker retry backoff: `min(2^attempts, 60)` minutes after the last
 * attempt, for events received within this window. Older rows that are still
 * `failed` stay `failed` for manual review. */
export const WEBHOOK_RETRY_WINDOW_MS = 24 * 3_600_000;
/** A `received` event not finished after this long is picked up by the sweep
 * even beyond the retry window. */
export const WEBHOOK_STUCK_RECEIVED_MS = 5 * 60_000;
const WEBHOOK_RETRY_MAX_BACKOFF_MINUTES = 60;
/** An event for a reference we do not know yet may just be early (the intent
 * stores its provider ref after the create call): retried this long. */
export const WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS = 15 * 60_000;
const SECRET_CACHE_TTL_MS = 60_000;
/** Audit snapshot keys of a refund event signed by the wrong integration. */
const REFUND_MISMATCH_AUDIT_FIELDS = [
  "eventId",
  "refundId",
  "integrationId",
] as const;
/** Audit snapshot keys of a refund event with unreadable facts (ids only). */
const REFUND_FACTS_AUDIT_FIELDS = ["eventId", "refundId", "invalid"] as const;

/** `parked`: stored durably, waiting for its local subscription (answered
 * 200: the sweep processes it once the subscription exists). */
export type WebhookResultStatus =
  "processed" | "duplicate" | "ignored" | "failed" | "parked";

type DoitWebhookEvent = ReturnType<typeof doitWebhookEventSchema.parse>;
type ProcessOutcome = "processed" | "ignored" | "failed" | "parked";
/** A verified event after parsing: payment events carry a payment object,
 * refund events only the facts of `readDoitRefundFacts`. */
type ParsedEvent =
  | { kind: "payment"; event: DoitWebhookEvent }
  | { kind: "refund"; event: DoitRefundWebhookEvent }
  | { kind: "invoice"; event: DoitInvoiceEvent };
type PaymentIntentRow = typeof paymentIntents.$inferSelect;
/** `until` (epoch ms) is set on a previous-generation secret (D17-D18): it
 * verifies only while `now < until`. Checked at use time, not at load time, so
 * a cached entry never outlives its grace. */
type WebhookSecretEntry = {
  secret: string;
  integrationId: string;
  until?: number;
};

/** Previous webhook secret of a sealed DOIT credential set, while it is still
 * in its rotation grace (D18); null otherwise. */
function previousWebhookSecretOf(
  credentials: Record<string, string>,
  integrationId: string,
): WebhookSecretEntry | null {
  const secret = credentials.previousWebhookSecret;
  const until = Date.parse(credentials.previousValidUntil ?? "");
  return typeof secret === "string" &&
    secret.length > 0 &&
    Number.isFinite(until)
    ? { secret, integrationId, until }
    : null;
}

const inGrace = (entry: WebhookSecretEntry, now: Date): boolean =>
  entry.until === undefined || now.getTime() < entry.until;

function unauthorized(): CoreError {
  return new CoreError("UNAUTHORIZED", SIGNATURE_MESSAGE);
}

export function tenantWideContext(tenantId: string): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "webhook",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

/** Error code only; a message could carry provider data (PAY-06). */
export function errorCodeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : "INTERNAL_ERROR";
}

export async function tenantIsActive(
  context: ScopedTenantContext,
): Promise<boolean> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, context.tenant.tenantId))
      .limit(1);
    return row?.status === "active";
  });
}

/** Webhook secret of every active DOIT integration (tenant row and outlet
 * rows), deduplicated, each with the integration that owns it. */
async function loadWebhookSecrets(
  context: ScopedTenantContext,
): Promise<WebhookSecretEntry[]> {
  const { data } = await listIntegrations(context);
  const outletIds = new Set<string | null>();
  for (const row of data)
    if (row.provider === PROVIDER && row.status === "active")
      outletIds.add(row.outletId);
  const secrets = new Map<string, WebhookSecretEntry>();
  for (const outletId of outletIds) {
    const loaded = await loadActiveIntegrationCredentials(
      context,
      PROVIDER,
      outletId,
    );
    if (!loaded) continue;
    const secret = loaded.credentials.webhookSecret;
    if (typeof secret === "string" && secret.length > 0 && !secrets.has(secret))
      secrets.set(secret, { secret, integrationId: loaded.integration.id });
    const previous = previousWebhookSecretOf(
      loaded.credentials,
      loaded.integration.id,
    );
    if (previous && !secrets.has(previous.secret))
      secrets.set(previous.secret, previous);
  }
  return [...secrets.values()];
}

const secretCache = new Map<
  string,
  { entries: WebhookSecretEntry[]; expiresAt: number }
>();
/** Bumped by every clear. A load that started before a clear (it may have
 * read the secrets before the integration change committed) must not put its
 * stale result back into the cache, so it stores only if this is unchanged. */
let secretCacheGeneration = 0;

/** Drops the cached secrets of one tenant (no argument: every tenant). Called
 * when an integration changes so a rotated or disabled secret takes effect at
 * once instead of after the TTL; tests also use it between calls. The clear
 * is per process: another process (the worker, a second API instance) keeps
 * its copy until its 60 s TTL runs out. */
export function clearDoitWebhookSecretCache(tenantId?: string): void {
  secretCacheGeneration += 1;
  if (tenantId === undefined) secretCache.clear();
  else secretCache.delete(tenantId);
}

/** Secrets cached 60 s per tenant so an unsigned flood does not hit the
 * credential store each time. An empty result is never cached. */
async function cachedWebhookSecrets(
  context: ScopedTenantContext,
  now: Date,
): Promise<WebhookSecretEntry[]> {
  const key = context.tenant.tenantId;
  const hit = secretCache.get(key);
  if (hit && hit.expiresAt > Date.now())
    return hit.entries.filter((entry) => inGrace(entry, now));
  const generation = secretCacheGeneration;
  const entries = await loadWebhookSecrets(context);
  // A clear ran while loading: serve this request, cache nothing.
  if (generation !== secretCacheGeneration)
    return entries.filter((entry) => inGrace(entry, now));
  if (entries.length > 0)
    secretCache.set(key, {
      entries,
      expiresAt: Date.now() + SECRET_CACHE_TTL_MS,
    });
  else secretCache.delete(key);
  return entries.filter((entry) => inGrace(entry, now));
}

/**
 * Refund-only event (no payment reference): the integration that minted the
 * payment of the refund it names, by idempotency key (`refund:<uuid>`) or by
 * the refund id DOIT gave earlier. Tenant scoped; unknown, ambiguous or
 * foreign refunds give null. The body only picks which secret to try.
 */
async function refundMintingIntegrationId(
  context: ScopedTenantContext,
  json: unknown,
): Promise<string | null> {
  if (typeof json !== "object" || json === null) return null;
  const { type, data } = json as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !isDoitRefundEvent(type)) return null;
  const match = matchDoitRefundEvent(type, readDoitRefundFacts(data));
  if (match.kind !== "key" && match.kind !== "refund_id") return null;
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ integrationId: paymentIntents.gatewayIntegrationId })
      .from(paymentRefunds)
      .innerJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, paymentRefunds.tenantId),
          eq(paymentIntents.id, paymentRefunds.paymentIntentId),
        ),
      )
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentIntents.provider, PROVIDER),
          match.kind === "key"
            ? eq(paymentRefunds.id, match.refundId)
            : eq(paymentRefunds.providerRef, match.providerRef),
        ),
      )
      .limit(2);
    return rows.length === 1 ? (rows[0]!.integrationId ?? null) : null;
  });
}

/**
 * Secret of the integration that minted the intent a delivery names, when that
 * row is no longer among the active ones (disabled since): a payment already
 * in flight on it must still be verifiable. The body is not trusted here; it
 * only picks which stored secret to try, and the signature still decides.
 */
async function mintingIntegrationSecret(
  context: ScopedTenantContext,
  json: unknown,
  tried: readonly WebhookSecretEntry[],
  now: Date,
): Promise<WebhookSecretEntry[]> {
  const data =
    typeof json === "object" && json !== null
      ? (json as { data?: unknown }).data
      : undefined;
  const reference = uuidSchema.safeParse(
    typeof data === "object" && data !== null
      ? (data as { reference?: unknown }).reference
      : undefined,
  );
  let integrationId: string | null;
  if (reference.success) {
    integrationId = await withTenant(db, context, async (tx) => {
      const [found] = await tx
        .select({ integrationId: paymentIntents.gatewayIntegrationId })
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, context.tenant.tenantId),
            eq(paymentIntents.id, reference.data),
            eq(paymentIntents.provider, PROVIDER),
          ),
        )
        .limit(1);
      return found?.integrationId ?? null;
    });
  } else {
    integrationId = await refundMintingIntegrationId(context, json);
  }
  if (
    integrationId === null ||
    tried.some((entry) => entry.integrationId === integrationId)
  )
    return [];
  const loaded = await loadIntegrationCredentialsById(
    context,
    PROVIDER,
    integrationId,
    { forStoredIntent: true },
  );
  if (!loaded) return [];
  const secret = loaded.credentials.webhookSecret;
  const entries: WebhookSecretEntry[] = [];
  if (typeof secret === "string" && secret.length > 0)
    entries.push({ secret, integrationId });
  const previous = previousWebhookSecretOf(loaded.credentials, integrationId);
  if (previous && inGrace(previous, now)) entries.push(previous);
  return entries;
}

/** `data.invoice.subscription_id` of a body, when it is a plain string. */
function invoiceSubscriptionIdOf(json: unknown): string | null {
  const data =
    typeof json === "object" && json !== null
      ? (json as { data?: unknown }).data
      : undefined;
  const invoice =
    typeof data === "object" && data !== null
      ? (data as { invoice?: unknown }).invoice
      : undefined;
  const id =
    typeof invoice === "object" && invoice !== null
      ? (invoice as { subscription_id?: unknown }).subscription_id
      : undefined;
  return typeof id === "string" && id.length > 0 && id.length <= 200
    ? id
    : null;
}

/**
 * Recurring billing twin of `mintingIntegrationSecret`: secret of the
 * integration a subscription is bound to, whatever its status (disabled
 * since, or the provider withdrawn from the plan): a renewal already billed
 * there must still be verifiable. The body is not trusted here; it only picks
 * which stored secret to try (tenant scoped, no lock), the signature decides.
 */
async function subscriptionIntegrationSecret(
  context: ScopedTenantContext,
  json: unknown,
  tried: readonly WebhookSecretEntry[],
  now: Date,
): Promise<WebhookSecretEntry[]> {
  const subscriptionId = invoiceSubscriptionIdOf(json);
  if (subscriptionId === null) return [];
  const integrationId = await withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select({
        integrationId: paymentRecurringSubscriptions.gatewayIntegrationId,
      })
      .from(paymentRecurringSubscriptions)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, context.tenant.tenantId),
          eq(
            paymentRecurringSubscriptions.providerSubscriptionId,
            subscriptionId,
          ),
        ),
      )
      .limit(1);
    return found?.integrationId ?? null;
  });
  if (
    integrationId === null ||
    tried.some((entry) => entry.integrationId === integrationId)
  )
    return [];
  const loaded = await loadIntegrationCredentialsById(
    context,
    PROVIDER,
    integrationId,
    { forStoredIntent: true },
  );
  if (!loaded) return [];
  const secret = loaded.credentials.webhookSecret;
  const entries: WebhookSecretEntry[] = [];
  if (typeof secret === "string" && secret.length > 0)
    entries.push({ secret, integrationId });
  const previous = previousWebhookSecretOf(loaded.credentials, integrationId);
  if (previous && inGrace(previous, now)) entries.push(previous);
  return entries;
}

/**
 * Verification binding of a recurring invoice event, stored with the row at
 * receipt: the integration that matched plus every other integration of the
 * tenant (any status) whose current or in-grace previous webhook secret is the
 * very secret that verified the event (two integrations may share a secret).
 * The worker accepts the event for any of them later without re-verifying, so
 * a rotation between receipt and processing cannot strand a paid renewal.
 */
async function verifiedIntegrationIdsOf(
  context: ScopedTenantContext,
  verified: WebhookSecretEntry,
  now: Date,
): Promise<string[]> {
  const ids = new Set<string>([verified.integrationId]);
  const { data } = await listIntegrations(context);
  for (const row of data) {
    if (row.provider !== PROVIDER || ids.has(row.id)) continue;
    let loaded: Awaited<ReturnType<typeof loadIntegrationCredentialsById>>;
    try {
      loaded = await loadIntegrationCredentialsById(context, PROVIDER, row.id, {
        forStoredIntent: true,
      });
    } catch {
      // Unreadable keys: this integration is skipped, never a failed webhook.
      continue;
    }
    if (!loaded) continue;
    const secret = loaded.credentials.webhookSecret;
    const previous = previousWebhookSecretOf(loaded.credentials, row.id);
    if (
      (typeof secret === "string" && secret === verified.secret) ||
      (previous !== null &&
        inGrace(previous, now) &&
        previous.secret === verified.secret)
    )
      ids.add(row.id);
  }
  return [...ids];
}

function readableEventId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 200
    ? id
    : null;
}

/** Provider payment time; falls back to the injected `now` (never the wall
 * clock) so an old retry is not mistaken for a late payment. */
function readPaidAt(
  event: DoitWebhookEvent,
  createdAt: Date | null,
  now: Date,
): string {
  for (const candidate of [event.data.paid_at, event.created_at]) {
    const parsed = isoDateTimeSchema.safeParse(candidate);
    if (parsed.success) return plausiblePaidAt(parsed.data, createdAt, now);
  }
  return now.toISOString();
}

/**
 * Amount a paid event credits the bill: DOIT's `amount` (`total_amount` adds
 * the transfer unique code or a customer-borne fee and is not the bill's).
 * The lifecycle compares it with the intent and flags a mismatch. `null`
 * (zero) fails closed.
 */
function settledAmount(event: DoitWebhookEvent): number | null {
  const paid = event.data.amount;
  return paid > 0 ? paid : null;
}

export async function markRow(
  context: ScopedTenantContext,
  rowId: string,
  patch: Partial<typeof gatewayWebhookEvents.$inferInsert>,
  now: Date,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await tx
      .update(gatewayWebhookEvents)
      .set({
        ...patch,
        attempts: sql`${gatewayWebhookEvents.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
          eq(gatewayWebhookEvents.id, rowId),
        ),
      );
  });
}

/** Intent the event names: provider ref and `data.reference` (the intent id)
 * must both match. `unknown` may still resolve later (early event); `mismatch`
 * never will. */
async function findBoundIntent(
  context: ScopedTenantContext,
  event: DoitWebhookEvent,
): Promise<
  | { kind: "found"; intent: PaymentIntentRow }
  | { kind: "unknown" }
  | { kind: "mismatch" }
> {
  const reference = uuidSchema.safeParse(event.data.reference);
  if (!reference.success) return { kind: "mismatch" };
  const intent = await withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, reference.data),
        ),
      )
      .limit(1);
    return found ?? null;
  });
  if (!intent) return { kind: "unknown" };
  if (intent.provider !== PROVIDER) return { kind: "mismatch" };
  if (intent.providerRef === null) return { kind: "unknown" };
  if (intent.providerRef !== event.data.id) return { kind: "mismatch" };
  return { kind: "found", intent };
}

/** The integration that verified the signature must be the one that minted
 * the intent (`gateway_integration_id`), even when an outlet row has been
 * added or that row disabled since. Older intents without it fall back to the
 * integration that owns the intent's outlet now (outlet row wins over tenant
 * row). */
async function signedByIntentIntegration(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  row: GatewayWebhookEvent,
  verifiedSecret: string | undefined,
  now: Date,
): Promise<boolean> {
  const minted = intent.gatewayIntegrationId;
  if (minted !== null && row.integrationId === minted) return true;
  const loaded =
    minted !== null
      ? await loadIntegrationCredentialsById(context, PROVIDER, minted, {
          forStoredIntent: true,
        })
      : await loadActiveIntegrationCredentials(
          context,
          PROVIDER,
          intent.outletId,
        );
  if (!loaded) return false;
  if (row.integrationId !== null && loaded.integration.id === row.integrationId)
    return true;
  if (verifiedSecret === undefined) return false;
  const secret = loaded.credentials.webhookSecret;
  if (typeof secret === "string" && secret === verifiedSecret) return true;
  // The secret that signed may be the previous generation, still in grace.
  const previous = previousWebhookSecretOf(
    loaded.credentials,
    loaded.integration.id,
  );
  return (
    previous !== null &&
    inGrace(previous, now) &&
    previous.secret === verifiedSecret
  );
}

/**
 * Money arrived that cannot settle the intent (closed as failed, or
 * AMOUNT_MISMATCH): parked once as unallocated funds, keyed by the provider
 * transaction. The shared core lives in `recordUnsettledGatewayFunds`, which
 * the polling fallback uses too, so webhook and poll write one row.
 */
async function recordUnsettledFunds(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  event: DoitWebhookEvent,
  now: Date,
): Promise<void> {
  const paid = settledAmount(event);
  if (paid === null) return;
  const onRecord = await recordUnsettledGatewayFunds(
    context,
    intent,
    {
      provider: PROVIDER,
      providerRef: event.data.id,
      source: "verified_webhook",
      paidAmountIdr: paid,
      receivedAt: new Date(readPaidAt(event, intent.createdAt, now)),
    },
    now,
  );
  // SO-896 P2-3: parked money ends the closed code (the poll does the same).
  // SO-896 P1-2: only when the money is on record (written or found).
  if (onRecord) await markGatewayReconciled(context, intent, now);
}

/** A 409 from `confirmPayment` is a deterministic lifecycle decision, never
 * transient: classify it (code only) so the row is `ignored`, not retried. */
async function handleRejectedConfirmation(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  event: DoitWebhookEvent,
  confirmation: {
    method: PaymentIntentRow["method"];
    amountIdr: number;
    at: string;
  },
  now: Date,
): Promise<string> {
  const fresh = await withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      )
      .limit(1);
    return found ?? intent;
  });
  const decision = decidePaymentConfirmation(
    {
      status: fresh.status,
      method: fresh.method,
      amountIdr: fresh.amountIdr,
      providerRef: fresh.providerRef,
      expiresAt: fresh.expiresAt.toISOString(),
      flags: fresh.flags,
    },
    {
      source: "verified_webhook",
      method: confirmation.method,
      amountIdr: confirmation.amountIdr,
      providerRef: event.data.id,
      at: confirmation.at,
    },
  );
  const code =
    decision.kind === "reject"
      ? `REJECTED_${decision.code}`
      : "REJECTED_CONFLICT";
  // Money that arrived but cannot settle is never dropped, except for a code
  // the provider answered `refunded` (952 P1): that money already went back to
  // the payer, so no evidence, unallocated funds or event is written for it.
  if (
    fresh.providerRefundedAt === null &&
    (fresh.status === "failed" ||
      (decision.kind === "reject" && decision.code === "AMOUNT_MISMATCH"))
  )
    await recordUnsettledFunds(context, fresh, event, now);
  return code;
}

/**
 * Applies one stored, verified event. Settlement, expiry and failure all go
 * through the payment service, so every rule (evidence dedupe, late payment,
 * no downgrade of a paid intent) lives in one place. `verifiedSecret` is the
 * webhook secret that verified this delivery, when known.
 */
async function processPaymentEvent(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  event: DoitWebhookEvent,
  now: Date,
  verifiedSecret?: string,
): Promise<ProcessOutcome> {
  try {
    const bound = await findBoundIntent(context, event);
    if (bound.kind === "unknown") {
      const retryable =
        now.getTime() - row.receivedAt.getTime() <
        WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
      await markRow(
        context,
        row.id,
        retryable
          ? { status: "failed", lastErrorCode: "UNKNOWN_REFERENCE" }
          : {
              status: "ignored",
              lastErrorCode: "UNKNOWN_REFERENCE",
              processedAt: now,
            },
        now,
      );
      return retryable ? "failed" : "ignored";
    }
    const intent = bound.kind === "found" ? bound.intent : null;
    if (
      !intent ||
      !(await signedByIntentIntegration(
        context,
        intent,
        row,
        verifiedSecret,
        now,
      ))
    ) {
      await markRow(
        context,
        row.id,
        {
          status: "ignored",
          lastErrorCode: "REFERENCE_MISMATCH",
          processedAt: now,
        },
        now,
      );
      return "ignored";
    }
    let outcome: ProcessOutcome = "processed";
    let code: string | null = null;
    const status = event.data.status;
    if (status === "paid") {
      const amountIdr = settledAmount(event);
      if (amountIdr === null) {
        // Fail closed: a zero amount proves nothing about the money. Kept
        // `failed` (visible for manual review, retried by the worker) and
        // answered with a 5xx by the route so DOIT resends the event.
        outcome = "failed";
        code = "AMOUNT_MISSING";
      } else {
        const at = readPaidAt(event, intent.createdAt, now);
        try {
          await confirmPayment(
            context,
            intent.id,
            {
              source: "verified_webhook",
              method: intent.method,
              amountIdr,
              providerRef: event.data.id,
              at,
            },
            { type: "system" },
            now,
          );
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 409)
            throw error;
          outcome = "ignored";
          code = await handleRejectedConfirmation(
            context,
            intent,
            event,
            { method: intent.method, amountIdr, at },
            now,
          );
        }
      }
    } else if (status === "expired") {
      await applyGatewayFailure(context, intent.id, "expired", now);
    } else if (status === "failed") {
      await applyGatewayFailure(context, intent.id, "failed", now);
    }
    // `pending` and `refunded` change nothing (a refund is not booked
    // automatically).
    await markRow(
      context,
      row.id,
      {
        status: outcome,
        lastErrorCode: code,
        processedAt: outcome === "failed" ? null : now,
        paymentIntentId: intent.id,
        outletId: intent.outletId,
        providerRef: event.data.id,
      },
      now,
    );
    return outcome;
  } catch (error) {
    await markRow(
      context,
      row.id,
      { status: "failed", lastErrorCode: errorCodeOf(error) },
      now,
    ).catch(() => {});
    // DOIT retries on a 5xx; nothing about the cause leaves the server.
    throw new HttpError(
      500,
      "INTERNAL_ERROR",
      "Webhook belum dapat diproses. Coba lagi.",
    );
  }
}

// ---------------------------------------------------------- refund events

type RefundTarget =
  | {
      kind: "found";
      refund: typeof paymentRefunds.$inferSelect;
      intent: PaymentIntentRow;
    }
  | { kind: "none" }
  | { kind: "ambiguous" };

/** Refund (and the intent it refunds) the event names, by the first matching
 * path of `matchDoitRefundEvent`. `none` may still resolve later (the
 * provider ref is stored after the payout call); `ambiguous` never will. */
async function findRefundTarget(
  context: ScopedTenantContext,
  match: ReturnType<typeof matchDoitRefundEvent>,
): Promise<RefundTarget> {
  if (match.kind === "none") return { kind: "none" };
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx): Promise<RefundTarget> => {
    const joined = () =>
      tx
        .select({ refund: paymentRefunds, intent: paymentIntents })
        .from(paymentRefunds)
        .innerJoin(
          paymentIntents,
          and(
            eq(paymentIntents.tenantId, paymentRefunds.tenantId),
            eq(paymentIntents.id, paymentRefunds.paymentIntentId),
          ),
        );
    if (match.kind === "key" || match.kind === "refund_id") {
      const rows = await joined()
        .where(
          and(
            eq(paymentRefunds.tenantId, tenantId),
            match.kind === "key"
              ? eq(paymentRefunds.id, match.refundId)
              : eq(paymentRefunds.providerRef, match.providerRef),
          ),
        )
        .limit(2);
      if (rows.length > 1) return { kind: "ambiguous" };
      return rows[0] ? { kind: "found", ...rows[0] } : { kind: "none" };
    }
    // Payment object: the refunds of the intent that payment belongs to.
    const reference = uuidSchema.safeParse(match.payment.reference);
    if (!reference.success) return { kind: "none" };
    const rows = await joined().where(
      and(
        eq(paymentRefunds.tenantId, tenantId),
        eq(paymentIntents.id, reference.data),
        eq(paymentIntents.provider, PROVIDER),
        eq(paymentIntents.providerRef, match.payment.id),
      ),
    );
    const candidate = pickRefundCandidate(
      rows.map(({ refund }) => ({
        id: refund.id,
        status: refund.status,
        amountIdr: refund.amountIdr,
        unallocatedFundId: refund.unallocatedFundId,
      })),
      match.payment.amount,
    );
    const chosen = rows.find(({ refund }) => refund.id === candidate?.id);
    return chosen ? { kind: "found", ...chosen } : { kind: "none" };
  });
}

/**
 * legend-xd2q: a `refund.succeeded` that names no known refund may be for a
 * refund finance settled by hand (no provider ref, so the `refund_id` and
 * payment-object paths cannot find it): the customer would be paid twice. Only
 * through the payment the event names (its payment object, or the flat
 * `payment_id` DOIT really sends, legend-0yd1), and only when the intent's one
 * live (not `failed`) refund is a `completed` refund marked
 * SETTLED_OUTSIDE_PROVIDER (another live refund may be the one the event is
 * about); it is then reported as a provider conflict, never changed.
 * legend-kl46s: a fund refund is looked up through its fund's evidence payment.
 */
async function findSettledOutsideTarget(
  context: ScopedTenantContext,
  facts: DoitRefundFacts,
): Promise<RefundTarget> {
  const { payment, paymentId } = facts;
  // Both named and not the same payment: never a guess.
  if (payment && paymentId !== undefined && payment.id !== paymentId)
    return { kind: "none" };
  const providerRef = payment?.id ?? paymentId;
  if (providerRef === undefined) return { kind: "none" };
  let intentId: string | undefined;
  if (payment) {
    const reference = uuidSchema.safeParse(payment.reference);
    if (!reference.success) return { kind: "none" };
    intentId = reference.data;
  }
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx): Promise<RefundTarget> => {
    // legend-kl46s: the payment the refund pays back is the intent's own for an
    // ordinary refund, the fund's evidence payment for a fund refund (never the
    // intent's own: an event naming p1 must not reach a fund refund paid from p2).
    const rows = await tx
      .select({ refund: paymentRefunds, intent: paymentIntents })
      .from(paymentRefunds)
      .innerJoin(
        paymentIntents,
        and(
          eq(paymentIntents.tenantId, paymentRefunds.tenantId),
          eq(paymentIntents.id, paymentRefunds.paymentIntentId),
        ),
      )
      .leftJoin(
        paymentUnallocatedFunds,
        and(
          eq(paymentUnallocatedFunds.tenantId, paymentRefunds.tenantId),
          eq(paymentUnallocatedFunds.id, paymentRefunds.unallocatedFundId),
        ),
      )
      .leftJoin(
        paymentEvidence,
        and(
          eq(paymentEvidence.tenantId, paymentUnallocatedFunds.tenantId),
          eq(paymentEvidence.id, paymentUnallocatedFunds.evidenceId),
        ),
      )
      .where(
        and(
          eq(paymentRefunds.tenantId, tenantId),
          intentId === undefined ? undefined : eq(paymentIntents.id, intentId),
          eq(paymentIntents.provider, PROVIDER),
          ne(paymentRefunds.status, "failed"),
          or(
            and(
              isNull(paymentRefunds.unallocatedFundId),
              eq(paymentIntents.providerRef, providerRef),
            ),
            and(
              isNotNull(paymentRefunds.unallocatedFundId),
              eq(paymentEvidence.provider, PROVIDER),
              eq(paymentEvidence.providerRef, providerRef),
            ),
          ),
        ),
      )
      .limit(2);
    const [only] = rows;
    return rows.length === 1 &&
      only!.refund.status === "completed" &&
      only!.refund.lastPayoutError === SETTLED_OUTSIDE_PROVIDER
      ? { kind: "found", ...only! }
      : { kind: "none" };
  });
}

/** Provider payment the refund pays back, when known: the fund's evidence for
 * a fund refund (its money may come from another payment than the intent's
 * own), otherwise the intent's provider ref. `unknown` never rejects. */
async function refundSourcePayment(
  context: ScopedTenantContext,
  refund: typeof paymentRefunds.$inferSelect,
  intent: PaymentIntentRow,
): Promise<{ provider: string; providerRef: string } | null> {
  if (!refund.unallocatedFundId)
    return intent.providerRef === null
      ? null
      : { provider: intent.provider, providerRef: intent.providerRef };
  return withTenant(db, context, async (tx) => {
    const [evidence] = await tx
      .select({
        provider: paymentEvidence.provider,
        providerRef: paymentEvidence.providerRef,
      })
      .from(paymentUnallocatedFunds)
      .innerJoin(
        paymentEvidence,
        and(
          eq(paymentEvidence.tenantId, paymentUnallocatedFunds.tenantId),
          eq(paymentEvidence.id, paymentUnallocatedFunds.evidenceId),
        ),
      )
      .where(
        and(
          eq(paymentUnallocatedFunds.tenantId, context.tenant.tenantId),
          eq(paymentUnallocatedFunds.id, refund.unallocatedFundId!),
        ),
      )
      .limit(1);
    return evidence ?? null;
  });
}

/** The payment the event names (its payment object or flat `payment_id`,
 * when it carries one) must be the payment the refund pays back: the intent's
 * reference always, the provider payment id when known (see
 * `refundSourcePayment`). */
async function paymentMatchesRefund(
  context: ScopedTenantContext,
  facts: DoitRefundFacts,
  refund: typeof paymentRefunds.$inferSelect,
  intent: PaymentIntentRow,
): Promise<boolean> {
  const named = [facts.payment?.id, facts.paymentId].filter(
    (id): id is string => id !== undefined,
  );
  // legend-r7g2: a refund object's own `reference` must name this intent too.
  if (facts.reference !== undefined && facts.reference !== intent.id)
    return false;
  if (named.length === 0) return true;
  if (facts.payment && facts.payment.reference !== intent.id) return false;
  const source = await refundSourcePayment(context, refund, intent);
  return (
    source === null ||
    (source.provider === PROVIDER &&
      named.every((id) => id === source.providerRef))
  );
}

/** Audit of a refund event refused because another integration signed it.
 * Ids only: no payload, no secret. */
async function recordRefundIntegrationMismatch(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  refundId: string,
  intentIntegrationId: string | null,
  now: Date,
): Promise<void> {
  logger.warn(
    { module: "payment-webhook", tenantId: context.tenant.tenantId },
    "DOIT refund webhook signed by another integration",
  );
  await withTenant(db, context, async (tx) => {
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.webhook.refund_integration_mismatch",
        objectType: "gateway_webhook_event",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: {
            eventId: row.eventId,
            refundId,
            integrationId: intentIntegrationId,
          },
          after: {
            eventId: row.eventId,
            refundId,
            integrationId: row.integrationId,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      REFUND_MISMATCH_AUDIT_FIELDS,
    );
  });
}

/** legend-2ol8g: audit of a refund event that was not applied because a fact
 * it carries is unreadable (`invalid`: "amount" / "payment_id") or the amount
 * differs from the refund's ("amount_mismatch"). Ids only: no payload. */
async function recordRefundFactsInvalid(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  refundId: string,
  invalid: readonly string[],
  now: Date,
): Promise<void> {
  logger.warn(
    {
      module: "payment-webhook",
      tenantId: context.tenant.tenantId,
      webhookEventId: row.id,
      invalid,
    },
    "DOIT refund webhook not applied: refund facts invalid",
  );
  await withTenant(db, context, async (tx) => {
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.webhook.refund_facts_invalid",
        objectType: "gateway_webhook_event",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: { eventId: row.eventId, refundId },
          after: { eventId: row.eventId, refundId, invalid: [...invalid] },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      REFUND_FACTS_AUDIT_FIELDS,
    );
  });
}

/**
 * Applies a stored, verified `refund.succeeded` / `refund.failed`. The provider
 * result is authoritative (`applyRefundProviderUpdate` also closes a
 * quarantined refund and never touches the quarantine logic), but only for a
 * refund whose intent was minted by the integration that verified the
 * signature. No match: retried for 15 minutes (the refund may not carry its
 * provider ref yet), then ignored as REFUND_UNMATCHED.
 */
async function processRefundEvent(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  event: DoitRefundWebhookEvent,
  now: Date,
  verifiedSecret?: string,
): Promise<ProcessOutcome> {
  try {
    const facts = readDoitRefundFacts(event.data);
    const status = event.type === "refund.succeeded" ? "succeeded" : "failed";
    const match = matchDoitRefundEvent(event.type, facts);
    let target = await findRefundTarget(context, match);
    // A success no refund matches may hit one finance settled by hand. By
    // refund id (or key) only after the retry window: until then the refund
    // the event names may still be storing its provider ref.
    const retryWindowOver =
      now.getTime() - row.receivedAt.getTime() >=
      WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
    const settledOutside =
      target.kind === "none" &&
      status === "succeeded" &&
      (facts.payment || facts.paymentId) &&
      (match.kind === "payment_object" || retryWindowOver)
        ? await findSettledOutsideTarget(context, facts)
        : null;
    if (settledOutside?.kind === "found") target = settledOutside;
    const viaSettled = settledOutside?.kind === "found";
    const unmatched = async (): Promise<ProcessOutcome> => {
      const retryable =
        now.getTime() - row.receivedAt.getTime() <
        WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
      if (!retryable && status === "succeeded")
        logger.warn(
          { webhookEventId: row.id },
          "Unmatched DOIT refund.succeeded ignored; check the provider for a refund Legend does not know (paid twice?)",
        );
      await markRow(
        context,
        row.id,
        retryable
          ? { status: "failed", lastErrorCode: "REFUND_UNMATCHED" }
          : {
              status: "ignored",
              lastErrorCode: "REFUND_UNMATCHED",
              processedAt: now,
            },
        now,
      );
      return retryable ? "failed" : "ignored";
    };
    const ignoredWith = async (code: string): Promise<ProcessOutcome> => {
      await markRow(
        context,
        row.id,
        { status: "ignored", lastErrorCode: code, processedAt: now },
        now,
      );
      return "ignored";
    };
    if (target.kind === "none") return await unmatched();
    if (target.kind === "ambiguous")
      return await ignoredWith("REJECTED_CONFLICT");

    const { refund, intent } = target;
    if (
      intent.provider !== PROVIDER ||
      !(await paymentMatchesRefund(context, facts, refund, intent)) ||
      !(await signedByIntentIntegration(
        context,
        intent,
        row,
        verifiedSecret,
        now,
      ))
    ) {
      await recordRefundIntegrationMismatch(
        context,
        row,
        refund.id,
        intent.gatewayIntegrationId,
        now,
      );
      return await ignoredWith("REFERENCE_MISMATCH");
    }

    // legend-2ol8g: an amount or payment_id that is there but unreadable (or
    // missing on the flat shape) must never settle: no amount or payment check
    // would run for it.
    if (facts.invalid) {
      await recordRefundFactsInvalid(
        context,
        row,
        refund.id,
        facts.invalid,
        now,
      );
      // A success on a refund finance settled by hand still means paying twice,
      // whatever its amount: the updater records the provider conflict on the
      // refund and refuses (a completed refund never changes state there).
      if (
        status === "succeeded" &&
        refund.status === "completed" &&
        refund.lastPayoutError === SETTLED_OUTSIDE_PROVIDER
      ) {
        try {
          await applyRefundProviderUpdate(
            context,
            { idempotencyKey: `refund:${refund.id}`, status },
            now,
          );
        } catch (error) {
          if (!(
            error instanceof HttpError &&
            (error.status === 409 || error.status === 404)
          ))
            throw error;
        }
      }
      return await ignoredWith("REFUND_FACTS_INVALID");
    }

    // legend-r7g2 (Codex 117 Run B): a payment object names the payment, not
    // the refund. A refund that already holds its own provider ref (`rf_…`
    // from the send) keeps it; the payment id is only a fallback when the
    // refund has none, so the updater never sees a false ref conflict.
    const providerRef =
      match.kind === "payment_object"
        ? (refund.providerRef ?? match.payment.id)
        : facts.refundId;
    try {
      await applyRefundProviderUpdate(
        context,
        {
          ...(match.kind === "refund_id" && !viaSettled
            ? {}
            : { idempotencyKey: `refund:${refund.id}` }),
          ...(providerRef ? { providerRef } : {}),
          status,
          ...(status === "failed" && facts.failureCode
            ? { code: facts.failureCode }
            : {}),
          ...(match.kind !== "payment_object" && facts.amountIdr !== undefined
            ? { amountIdr: facts.amountIdr }
            : {}),
        },
        now,
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        // legend-2ol8g: a readable amount that is not the refund's.
        if (
          match.kind !== "payment_object" &&
          facts.amountIdr !== undefined &&
          facts.amountIdr !== refund.amountIdr
        )
          await recordRefundFactsInvalid(
            context,
            row,
            refund.id,
            ["amount_mismatch"],
            now,
          );
        return await ignoredWith("REJECTED_CONFLICT");
      }
      if (error instanceof HttpError && error.status === 404)
        return await unmatched();
      throw error;
    }
    await markRow(
      context,
      row.id,
      {
        status: "processed",
        lastErrorCode: null,
        processedAt: now,
        paymentIntentId: intent.id,
        outletId: intent.outletId,
        providerRef: providerRef ?? refund.providerRef,
      },
      now,
    );
    return "processed";
  } catch (error) {
    await markRow(
      context,
      row.id,
      { status: "failed", lastErrorCode: errorCodeOf(error) },
      now,
    ).catch(() => {});
    throw new HttpError(
      500,
      "INTERNAL_ERROR",
      "Webhook belum dapat diproses. Coba lagi.",
    );
  }
}

/** An invoice event of recurring billing names a subscription. One without
 * `data.invoice.subscription_id` is not ours and keeps the old path (stored,
 * ignored, 200); one that names it but is otherwise malformed is MALFORMED. */
function isRecurringInvoiceEvent(type: string, body: unknown): boolean {
  if (!isDoitRecurringEvent(type)) return false;
  const data =
    typeof body === "object" && body !== null
      ? (body as { data?: unknown }).data
      : undefined;
  const invoice =
    typeof data === "object" && data !== null
      ? (data as { invoice?: unknown }).invoice
      : undefined;
  return (
    typeof invoice === "object" &&
    invoice !== null &&
    typeof (invoice as { subscription_id?: unknown }).subscription_id ===
      "string"
  );
}

/** Parses the body of a verified event by its type. Null: not readable. */
function parseEventBody(type: string, body: unknown): ParsedEvent | null {
  if (isDoitRecurringEvent(type)) {
    const invoice = parseDoitInvoiceEvent(body);
    return invoice ? { kind: "invoice", event: invoice } : null;
  }
  if (isDoitRefundEvent(type)) {
    const refund = doitRefundWebhookEventSchema.safeParse(body);
    return refund.success ? { kind: "refund", event: refund.data } : null;
  }
  const payment = doitWebhookEventSchema.safeParse(body);
  return payment.success ? { kind: "payment", event: payment.data } : null;
}

/** Same, for a stored payload (the type is read from the payload itself). */
function parseStoredEvent(payload: unknown): ParsedEvent | null {
  const type =
    typeof payload === "object" && payload !== null
      ? (payload as { type?: unknown }).type
      : undefined;
  return typeof type === "string" ? parseEventBody(type, payload) : null;
}

/** Provider reference to keep on the stored row (a refund event may name none). */
function eventProviderRef(parsed: ParsedEvent): string | null {
  let ref: string | undefined;
  if (parsed.kind === "payment") ref = parsed.event.data.id;
  else if (parsed.kind === "invoice") ref = parsed.event.data.invoice.id;
  else {
    const facts = readDoitRefundFacts(parsed.event.data);
    ref = facts.refundId ?? facts.payment?.id;
  }
  return ref === undefined ? null : ref.slice(0, 100);
}

async function processStoredEvent(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  parsed: ParsedEvent,
  now: Date,
  verifiedSecret?: string,
): Promise<ProcessOutcome> {
  if (parsed.kind === "invoice")
    return processInvoiceEvent(context, row, parsed.event, now);
  return parsed.kind === "refund"
    ? processRefundEvent(context, row, parsed.event, now, verifiedSecret)
    : processPaymentEvent(context, row, parsed.event, now, verifiedSecret);
}

/** Recurring billing `invoice.created` / `invoice.paid` (bead 6c6). An event
 * for a subscription or invoice not known yet may just be early, so it is
 * retried like an unknown payment reference; after that a paid event for an
 * unseen invoice is kept for review and the rest is ignored. */
async function processInvoiceEvent(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  event: DoitInvoiceEvent,
  now: Date,
): Promise<ProcessOutcome> {
  try {
    const early =
      now.getTime() - row.receivedAt.getTime() <
      WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
    const result = await processDoitInvoiceEvent(context, event, now, {
      sourceEventId: row.id,
      storeUnseenPaidForReview: !early,
      // The integration whose secret verified this event (stored first).
      verifiedIntegrationId: row.integrationId,
      // The binding stored at receipt (every integration holding the verifying
      // secret). Never re-verified against the current secrets: a rotation
      // after receipt must not strand an event that was verified.
      acceptedIntegrationIds:
        row.verifiedIntegrationIds ??
        (row.integrationId === null ? [] : [row.integrationId]),
    });
    if (result.outcome === "unknown_subscription") {
      // Parked, never ignored: kept `failed` so it is processed once the
      // local subscription exists (see `reprocessParkedRecurringEvents`).
      await markRow(
        context,
        row.id,
        { status: "failed", lastErrorCode: "UNKNOWN_SUBSCRIPTION" },
        now,
      );
      return "parked";
    }
    if (result.outcome === "unknown_invoice") {
      await markRow(
        context,
        row.id,
        early
          ? { status: "failed", lastErrorCode: "UNKNOWN_INVOICE" }
          : {
              status: "ignored",
              lastErrorCode: "UNKNOWN_INVOICE",
              processedAt: now,
            },
        now,
      );
      return early ? "failed" : "ignored";
    }
    const ignored = result.outcome === "ignored";
    await markRow(
      context,
      row.id,
      {
        status: ignored ? "ignored" : "processed",
        lastErrorCode: result.code,
        processedAt: now,
      },
      now,
    );
    return ignored ? "ignored" : "processed";
  } catch (error) {
    await markRow(
      context,
      row.id,
      { status: "failed", lastErrorCode: errorCodeOf(error) },
      now,
    ).catch(() => {});
    throw new HttpError(
      500,
      "INTERNAL_ERROR",
      "Webhook belum dapat diproses. Coba lagi.",
    );
  }
}

async function insertRow(
  context: ScopedTenantContext,
  values: Omit<
    typeof gatewayWebhookEvents.$inferInsert,
    "tenantId" | "provider"
  >,
): Promise<GatewayWebhookEvent | null> {
  return withTenant(db, context, async (tx) => {
    const [inserted] = await tx
      .insert(gatewayWebhookEvents)
      .values({
        ...values,
        tenantId: context.tenant.tenantId,
        provider: PROVIDER,
      })
      // Verified rows dedupe by provider event id.
      .onConflictDoNothing({
        target: [
          gatewayWebhookEvents.tenantId,
          gatewayWebhookEvents.provider,
          gatewayWebhookEvents.integrationId,
          gatewayWebhookEvents.eventId,
        ],
        where: sql`${gatewayWebhookEvents.signatureValid} AND ${gatewayWebhookEvents.eventId} IS NOT NULL`,
      })
      .returning();
    return inserted ?? null;
  });
}

/**
 * Audit trail of deliveries whose signature did not verify. One counter row
 * per tenant per minute (not one per distinct body), so an unsigned flood
 * cannot bloat the table. The body is never stored; its hash only goes to the
 * log. The row reuses the unique index on (tenant, payload_hash) for rows
 * that are not signature-valid.
 */
export async function recordRejectedAttempt(
  context: ScopedTenantContext,
  bodyHash: string,
  now: Date,
  provider: string = PROVIDER,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const bucketHash = createHash("sha256")
    .update(
      provider === PROVIDER
        ? `rejected:${tenantId}:${bucket.toISOString()}`
        : `rejected:${provider}:${tenantId}:${bucket.toISOString()}`,
    )
    .digest("hex");
  logger.warn(
    { module: "payment-webhook", provider, tenantId, payloadHash: bodyHash },
    `${provider} webhook signature rejected`,
  );
  await withTenant(db, context, async (tx) => {
    await tx
      .insert(gatewayWebhookEvents)
      .values({
        tenantId,
        provider,
        signatureValid: false,
        status: "rejected",
        lastErrorCode: "SIGNATURE_INVALID",
        payloadHash: bucketHash,
        eventId: null,
        payload: null,
        receivedAt: now,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          gatewayWebhookEvents.tenantId,
          gatewayWebhookEvents.payloadHash,
        ],
        targetWhere: sql`NOT ${gatewayWebhookEvents.signatureValid}`,
        set: {
          attempts: sql`${gatewayWebhookEvents.attempts} + 1`,
          updatedAt: now,
        },
      });
  });
}

async function loadVerifiedRow(
  context: ScopedTenantContext,
  integrationId: string,
  eventId: string,
): Promise<GatewayWebhookEvent | null> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(gatewayWebhookEvents)
      .where(
        and(
          eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
          eq(gatewayWebhookEvents.provider, PROVIDER),
          eq(gatewayWebhookEvents.integrationId, integrationId),
          eq(gatewayWebhookEvents.eventId, eventId),
          eq(gatewayWebhookEvents.signatureValid, true),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Receives one DOIT webhook. Throws UNAUTHORIZED (one message, no oracle) for
 * every failure before the signature is verified (unknown or inactive tenant,
 * tenant without a DOIT secret, bad signature) and a 500 when a verified
 * payload cannot be parsed or processing failed (DOIT retries on a 5xx; a
 * stored, parsed row is retried by the worker as well).
 */
export async function receiveDoitWebhook(input: {
  tenantId: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  now?: Date;
}): Promise<{ status: WebhookResultStatus; eventId: string }> {
  const now = input.now ?? new Date();
  const parsedTenant = tenantIdSchema.safeParse(input.tenantId);
  if (!parsedTenant.success) throw unauthorized();
  const context = tenantWideContext(parsedTenant.data);
  if (!(await tenantIsActive(context))) throw unauthorized();

  const entries = await cachedWebhookSecrets(context, now);
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  let json: unknown;
  try {
    json = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    json = undefined;
  }
  // Per-gateway timestamp window (D19), set by the platform admin.
  const window = await gatewayWebhookTolerance(PROVIDER);
  const tolerance = {
    pastSeconds: window.pastMs / 1000,
    futureSeconds: window.futureMs / 1000,
  };
  const signedWith = (entry: WebhookSecretEntry) =>
    verifyDoitSignature({
      rawBody: input.rawBody,
      header: input.signatureHeader,
      secrets: [entry.secret],
      now,
      tolerance,
    });
  let verified = entries.find(signedWith);
  if (!verified) {
    // Money in flight on an integration disabled since it minted the intent.
    const minting =
      input.signatureHeader === undefined
        ? []
        : await mintingIntegrationSecret(context, json, entries, now);
    verified = minting.find(signedWith);
  }
  if (
    !verified &&
    input.signatureHeader !== undefined &&
    typeof json === "object" &&
    json !== null &&
    typeof (json as { type?: unknown }).type === "string" &&
    isRecurringInvoiceEvent((json as { type: string }).type, json)
  ) {
    // A renewal of a subscription whose integration was disabled (or its
    // provider withdrawn) since: verify with the integration it is bound to.
    const bound = await subscriptionIntegrationSecret(
      context,
      json,
      entries,
      now,
    );
    verified = bound.find(signedWith);
  }
  if (!verified) {
    // A tenant without any DOIT secret has nothing to audit against.
    if (entries.length > 0)
      await recordRejectedAttempt(context, payloadHash, now);
    throw unauthorized();
  }
  const envelope = doitWebhookEnvelopeSchema.safeParse(json);
  if (
    envelope.success &&
    !isDoitPaymentEvent(envelope.data.type) &&
    !isDoitRefundEvent(envelope.data.type) &&
    !isRecurringInvoiceEvent(envelope.data.type, json)
  ) {
    // Not a payment, refund or recurring invoice event: stored (deduped by event id) and ignored, 200.
    const { id, type, created_at } = envelope.data;
    const stored = await insertRow(context, {
      integrationId: verified.integrationId,
      signatureValid: true,
      eventId: id,
      eventType: type,
      payloadHash,
      // Envelope only: `data` of other event types is not validated.
      payload: { id, type, created_at },
      status: "ignored",
      lastErrorCode: "EVENT_TYPE_IGNORED",
      processedAt: now,
      receivedAt: now,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { status: stored ? "ignored" : "duplicate", eventId: id };
  }
  const parsedEvent = envelope.success
    ? parseEventBody(envelope.data.type, json)
    : null;
  if (!parsedEvent) {
    await insertRow(context, {
      integrationId: verified.integrationId,
      signatureValid: true,
      status: "failed",
      lastErrorCode: "MALFORMED",
      payloadHash,
      eventId: readableEventId(json),
      payload: null,
      receivedAt: now,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    // Signed by DOIT but not readable here (a field we are too strict
    // about): a 5xx makes DOIT resend it, so a fixed parser still gets the
    // event within DOIT's retry window instead of the money being dropped.
    throw new HttpError(
      500,
      "INTERNAL_ERROR",
      "Webhook belum dapat diproses. Coba lagi.",
    );
  }
  const event = parsedEvent.event;

  // Recurring invoice events keep who verified them (see
  // `verifiedIntegrationIdsOf`); other event kinds leave the column null.
  const verifiedIntegrationIds =
    parsedEvent.kind === "invoice" && envelope.success
      ? await verifiedIntegrationIdsOf(context, verified, now)
      : undefined;
  // STORE FIRST: a retry of the same event id hits the unique index.
  let row = await insertRow(context, {
    integrationId: verified.integrationId,
    ...(verifiedIntegrationIds ? { verifiedIntegrationIds } : {}),
    signatureValid: true,
    eventId: event.id,
    eventType: event.type.slice(0, 60),
    payloadHash,
    // The schema-validated event, never the raw JSON with unknown fields.
    payload: event as unknown as Record<string, unknown>,
    providerRef: eventProviderRef(parsedEvent),
    status: "received",
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  // The event to process: the new body only for a fresh row (or a stored
  // MALFORMED one it just filled); a retried row is processed from what it
  // stored.
  let toProcess: ParsedEvent = parsedEvent;
  if (!row) {
    row = await loadVerifiedRow(context, verified.integrationId, event.id);
    if (!row) throw new Error("Webhook event conflicted without a winner");
    // loadVerifiedRow filters by this integration, so the row is its own: an
    // event id of another integration never matches here (the unique key is
    // per integration) and cannot be replayed, completed or settled by it.
    if (row.status === "processed" || row.status === "ignored")
      return { status: "duplicate", eventId: event.id };
    // `received` or `failed`: the earlier delivery never finished, retry it.
    let useStored = true;
    if (row.payload === null) {
      // An earlier delivery of this integration could not be parsed: keep the
      // parsed event now so the worker can retry this row too. Only a row
      // that is still empty and owned by this integration is filled.
      const stored = row;
      const [filled] = await withTenant(db, context, async (tx) =>
        tx
          .update(gatewayWebhookEvents)
          .set({
            payload: event as unknown as Record<string, unknown>,
            eventType: event.type.slice(0, 60),
            providerRef: eventProviderRef(parsedEvent),
            ...(verifiedIntegrationIds ? { verifiedIntegrationIds } : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
              eq(gatewayWebhookEvents.id, stored.id),
              isNull(gatewayWebhookEvents.payload),
              eq(gatewayWebhookEvents.integrationId, verified.integrationId),
            ),
          )
          .returning({ id: gatewayWebhookEvents.id }),
      );
      if (filled) useStored = false;
      else {
        // A concurrent delivery filled it first: continue with what it stored.
        const fresh = await loadVerifiedRow(
          context,
          verified.integrationId,
          event.id,
        );
        if (!fresh || fresh.payload === null)
          throw new Error("Webhook event could not be completed");
        row = fresh;
        if (row.status === "processed" || row.status === "ignored")
          return { status: "duplicate", eventId: event.id };
      }
    }
    if (useStored) {
      // Never the replacement body: the stored payload is what was verified
      // and stored first (the payload hash may differ, the stored one wins).
      const storedEvent = parseStoredEvent(row.payload);
      if (!storedEvent) {
        await markRow(
          context,
          row.id,
          { status: "failed", lastErrorCode: "MALFORMED" },
          now,
        );
        throw new HttpError(
          500,
          "INTERNAL_ERROR",
          "Webhook belum dapat diproses. Coba lagi.",
        );
      }
      toProcess = storedEvent;
    }
  }
  const outcome = await processStoredEvent(
    context,
    row,
    toProcess,
    now,
    verified.secret,
  );
  return { status: outcome, eventId: event.id };
}

/**
 * Retry-due predicate shared by the select and the per-row claim. `failed`
 * rows follow the backoff for 24 h after receipt. `received` rows are never on
 * the backoff (attempts=0 would make them due after 1 minute, while the
 * request may still be processing): they are due only once stuck for
 * WEBHOOK_STUCK_RECEIVED_MS, even past the 24 h window, so a recurring invoice
 * event is never stranded. Idempotent via the dedupe.
 */
function webhookRetryDue(context: ScopedTenantContext, now: Date) {
  const windowStart = new Date(now.getTime() - WEBHOOK_RETRY_WINDOW_MS);
  // Next attempt is due `min(2^attempts, 60)` minutes after the last one.
  const backoff = sql`least(power(2, least(${gatewayWebhookEvents.attempts}, 6)), ${WEBHOOK_RETRY_MAX_BACKOFF_MINUTES}) * interval '1 minute'`;
  return and(
    eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
    eq(gatewayWebhookEvents.provider, PROVIDER),
    eq(gatewayWebhookEvents.signatureValid, true),
    isNotNull(gatewayWebhookEvents.payload),
    or(
      and(
        eq(gatewayWebhookEvents.status, "failed"),
        gt(gatewayWebhookEvents.receivedAt, windowStart),
        sql`${gatewayWebhookEvents.updatedAt} + ${backoff} <= ${now.toISOString()}::timestamptz`,
      ),
      and(
        eq(gatewayWebhookEvents.status, "received"),
        lt(
          gatewayWebhookEvents.updatedAt,
          new Date(now.getTime() - WEBHOOK_STUCK_RECEIVED_MS),
        ),
      ),
    ),
  );
}

/**
 * Worker retry path: stored, verified events that stayed `received` (stuck
 * past WEBHOOK_STUCK_RECEIVED_MS) or `failed` (backoff due, 24 h after
 * receipt). Each row is claimed atomically before processing so two workers
 * never process the same event. Per-event failures are skipped; the next run
 * retries.
 */
export async function reprocessStoredWebhookEvents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
): Promise<{ checked: number; processed: number }> {
  const rows = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(gatewayWebhookEvents)
      .where(webhookRetryDue(context, now))
      .orderBy(asc(gatewayWebhookEvents.receivedAt))
      .limit(limit),
  );
  let processed = 0;
  const secrets =
    rows.length > 0 ? await cachedWebhookSecrets(context, now) : [];
  for (const row of rows) {
    // Atomic claim: bump updated_at only while the row is still due, so the
    // due predicate turns false for every other worker. Attempts stay as is.
    const claimed = await withTenant(db, context, async (tx) =>
      tx
        .update(gatewayWebhookEvents)
        .set({ updatedAt: now })
        .where(
          and(
            webhookRetryDue(context, now),
            eq(gatewayWebhookEvents.id, row.id),
          ),
        )
        .returning({ id: gatewayWebhookEvents.id }),
    );
    if (claimed.length === 0) continue;
    const parsed = parseStoredEvent(row.payload);
    if (!parsed) {
      await markRow(
        context,
        row.id,
        { status: "failed", lastErrorCode: "MALFORMED" },
        now,
      ).catch(() => {});
      continue;
    }
    try {
      const verifiedSecret = secrets.find(
        (entry) => entry.integrationId === row.integrationId,
      )?.secret;
      const outcome = await processStoredEvent(
        context,
        row,
        parsed,
        now,
        verifiedSecret,
      );
      if (outcome !== "failed" && outcome !== "parked") processed += 1;
    } catch {
      // Already recorded on the row; the next run retries.
    }
  }
  return { checked: rows.length, processed };
}

/**
 * Recurring invoice events that are still `failed`: parked because no local
 * subscription matched yet (UNKNOWN_SUBSCRIPTION), or hit by any later error.
 * No error-code filter, so a later error cannot orphan a parked event. They
 * stay without a time limit and are processed once the subscription exists:
 * by the worker sweep (with backoff, skipped once the subscription exists), or right after a start when
 * `providerSubscriptionId` names the new subscription (the backoff is skipped
 * then). `invoice.created` runs before `invoice.paid`, then oldest first.
 * Processed with the binding stored at receipt, like every other invoice
 * event. A per-event error leaves the row `failed` (processInvoiceEvent
 * records it) and is skipped; the next sweep retries.
 */
export async function reprocessParkedRecurringEvents(
  context: ScopedTenantContext,
  now: Date = new Date(),
  opts: { providerSubscriptionId?: string; limit?: number } = {},
): Promise<{ checked: number; processed: number }> {
  const backoff = sql`least(power(2, least(${gatewayWebhookEvents.attempts}, 6)), ${WEBHOOK_RETRY_MAX_BACKOFF_MINUTES}) * interval '1 minute'`;
  const conditions = [
    eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
    eq(gatewayWebhookEvents.provider, PROVIDER),
    eq(gatewayWebhookEvents.signatureValid, true),
    eq(gatewayWebhookEvents.status, "failed"),
    inArray(gatewayWebhookEvents.eventType, [...DOIT_RECURRING_EVENT_TYPES]),
    isNotNull(gatewayWebhookEvents.payload),
    // An unreadable body stays unreadable: not retried forever here.
    sql`coalesce(${gatewayWebhookEvents.lastErrorCode}, '') <> 'MALFORMED'`,
  ];
  if (opts.providerSubscriptionId !== undefined)
    conditions.push(
      sql`${gatewayWebhookEvents.payload}->'data'->'invoice'->>'subscription_id' = ${opts.providerSubscriptionId}`,
    );
  else
    // Backoff is skipped once the subscription the event names exists
    // locally: it is processed on the next sweep, not minutes later, so
    // created-before-paid holds across sweeps.
    conditions.push(
      sql`(${gatewayWebhookEvents.updatedAt} + ${backoff} <= ${now.toISOString()}::timestamptz or exists (select 1 from ${paymentRecurringSubscriptions} where ${paymentRecurringSubscriptions.tenantId} = ${context.tenant.tenantId} and ${paymentRecurringSubscriptions.providerSubscriptionId} = ${gatewayWebhookEvents.payload}->'data'->'invoice'->>'subscription_id'))`,
    );
  const rows = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(gatewayWebhookEvents)
      .where(and(...conditions))
      // `invoice.created` first so a renewal's invoice exists before its paid
      // event is applied; then oldest first.
      .orderBy(
        sql`case when ${gatewayWebhookEvents.eventType} = 'invoice.created' then 0 else 1 end`,
        asc(gatewayWebhookEvents.receivedAt),
      )
      .limit(opts.limit ?? 100),
  );
  let processed = 0;
  for (const row of rows) {
    const parsed = parseStoredEvent(row.payload);
    if (!parsed || parsed.kind !== "invoice") {
      await markRow(
        context,
        row.id,
        { status: "failed", lastErrorCode: "MALFORMED" },
        now,
      ).catch(() => {});
      continue;
    }
    try {
      const outcome = await processInvoiceEvent(
        context,
        row,
        parsed.event,
        now,
      );
      if (outcome !== "failed" && outcome !== "parked") processed += 1;
    } catch {
      // Already recorded on the row; the next run retries.
    }
  }
  return { checked: rows.length, processed };
}

/**
 * Rejected deliveries keep only a hash for audit (PAY-06); drop them after
 * `olderThanDays`. Verified rows are kept.
 */
export async function purgeRejectedWebhookEvents(
  context: ScopedTenantContext,
  now = new Date(),
  olderThanDays = 30,
): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
  const rows = await withTenant(db, context, async (tx) =>
    tx
      .delete(gatewayWebhookEvents)
      .where(
        and(
          eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
          eq(gatewayWebhookEvents.status, "rejected"),
          eq(gatewayWebhookEvents.signatureValid, false),
          lt(gatewayWebhookEvents.receivedAt, cutoff),
        ),
      )
      .returning({ id: gatewayWebhookEvents.id }),
  );
  return { deleted: rows.length };
}
