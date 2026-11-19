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
// Only `payment.paid` and `payment.expired` move an intent (`payment.refunded`
// only records the refund time); `refund.succeeded`
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
  idr,
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
  paymentProviderRefunds,
  paymentRecurringSubscriptions,
  paymentRefunds,
  paymentUnallocatedFunds,
  refundReconHolds,
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
  markProviderRefunded,
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
  readProviderInitiatedRefund,
  type DoitRefundFacts,
  type DoitRefundWebhookEvent,
} from "./payment-doit-refund-webhook";
import {
  applyRefundProviderUpdate,
  SETTLED_OUTSIDE_PROVIDER,
} from "./payment-refund.service";
import { refundProviderSwitchedOff } from "./payment-refund-gateway";
import { holdFactCoversSql } from "./refund-hold-coverage";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "./refund-hold-reasons";
import {
  fileOwnRefundSurplusHoldInTx,
  fileTransactionConflictHoldInTx,
  recordProviderRefundInTx,
  type ProviderRefundIdKind,
} from "./payment-provider-partial-refund";
import { lockDepositIntentsExclusive } from "./reservation-deposit-credit";
import {
  alertProviderRefundSwitchedOff,
  alertProviderRefundTransactionConflict,
  alertProviderRefundUnbound,
  alertProviderRefundUnmatched,
  alertProviderRefundUnmatchedUnmapped,
  alertRefundReferenceMismatch,
} from "./payment-provider-refunded-alert";
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
  isDoitRefundSuccessStatus,
  readDoitRefundedStatusFacts,
  verifyDoitSignature,
  type DoitRefundedStatusFacts,
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
 * rows), deduplicated, each with the integration that owns it. `complete` is
 * false when an active integration failed to load: the result still serves
 * this request but must not be cached, or the skipped integration would stay
 * unable to verify webhooks for the whole TTL after it is repaired. */
async function loadWebhookSecrets(
  context: ScopedTenantContext,
): Promise<{ entries: WebhookSecretEntry[]; complete: boolean }> {
  const { data } = await listIntegrations(context);
  const secrets = new Map<string, WebhookSecretEntry>();
  let complete = true;
  for (const row of data) {
    if (row.provider !== PROVIDER || row.status !== "active") continue;
    // One active integration with unreadable credentials must not break the
    // others: it is skipped (class name only, never the error message, which
    // could carry secret material).
    let loaded: Awaited<ReturnType<typeof loadIntegrationCredentialsById>>;
    try {
      loaded = await loadIntegrationCredentialsById(context, PROVIDER, row.id);
    } catch (error) {
      complete = false;
      logger.warn(
        {
          tenantId: context.tenant.tenantId,
          integrationId: row.id,
          errName: error instanceof Error ? error.name : "UnknownError",
        },
        "doit webhook: integration credentials unreadable, skipped",
      );
      continue;
    }
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
  return { entries: [...secrets.values()], complete };
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
 * credential store each time. An empty or incomplete result
 * (an active integration failed to load) is never cached. */
async function cachedWebhookSecrets(
  context: ScopedTenantContext,
  now: Date,
): Promise<WebhookSecretEntry[]> {
  const key = context.tenant.tenantId;
  const hit = secretCache.get(key);
  if (hit && hit.expiresAt > Date.now())
    return hit.entries.filter((entry) => inGrace(entry, now));
  const generation = secretCacheGeneration;
  const { entries, complete } = await loadWebhookSecrets(context);
  // A clear ran while loading: serve this request, cache nothing.
  if (generation !== secretCacheGeneration)
    return entries.filter((entry) => inGrace(entry, now));
  if (entries.length > 0 && complete)
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
 * never will. legend-wourt: a provider ref that is not the intent's own is
 * accepted only when it is recorded evidence of that very intent (an additional
 * transaction of the same bill, verified); the evidence comes back as
 * `boundEvidence` and the caller processes only its refund. */
async function findBoundIntent(
  context: ScopedTenantContext,
  event: DoitWebhookEvent,
): Promise<
  | {
      kind: "found";
      intent: PaymentIntentRow;
      boundEvidence?: { id: string; amountIdr: number };
    }
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
  if (intent.providerRef !== event.data.id) {
    const evidence = await withTenant(db, context, async (tx) => {
      const [found] = await tx
        .select({
          id: paymentEvidence.id,
          amountIdr: paymentEvidence.amountIdr,
        })
        .from(paymentEvidence)
        .where(
          and(
            eq(paymentEvidence.tenantId, context.tenant.tenantId),
            eq(paymentEvidence.provider, PROVIDER),
            eq(paymentEvidence.providerRef, event.data.id),
            eq(paymentEvidence.paymentIntentId, intent.id),
            inArray(paymentEvidence.source, [
              "verified_webhook",
              "gateway_status",
            ]),
          ),
        )
        .limit(1);
      return found ?? null;
    });
    if (!evidence) return { kind: "mismatch" };
    return {
      kind: "found",
      intent,
      boundEvidence: { id: evidence.id, amountIdr: Number(evidence.amountIdr) },
    };
  }
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

/** Result of applying a provider refund: `bound` (recorded, a duplicate, our
 * own echo, or flagged), `retry` (one of our own refunds for that payment is
 * in flight, so the refund cannot be told apart yet: nothing was written) or
 * `unbound` (not a payment of this tenant, or of another integration) or
 * `mismatch` (the event names an intent reference that is not the intent the
 * payment binds to, legend-6jdy1: terminal, nothing written). */
type RefundApplyResult = "bound" | "retry" | "unbound" | "mismatch";

/** Intent a provider payment reference binds to, by the helper's rule: the
 * evidence of that reference (its intent wins on a conflict), else the intent
 * whose own provider ref it is. Tenant scoped, a short read with no lock; two
 * candidates are a doubt, so none. `evidenceAmountIdr` is set when the
 * reference is recorded evidence. */
async function findRefundCandidate(
  context: ScopedTenantContext,
  providerRef: string,
): Promise<{
  intent: PaymentIntentRow;
  evidenceAmountIdr: number | null;
} | null> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [evidence] = await tx
      .select({
        intentId: paymentEvidence.paymentIntentId,
        amountIdr: paymentEvidence.amountIdr,
      })
      .from(paymentEvidence)
      .where(
        and(
          eq(paymentEvidence.tenantId, tenantId),
          eq(paymentEvidence.provider, PROVIDER),
          eq(paymentEvidence.providerRef, providerRef),
        ),
      )
      .limit(1);
    const intents = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          eq(paymentIntents.provider, PROVIDER),
          evidence
            ? eq(paymentIntents.id, evidence.intentId)
            : eq(paymentIntents.providerRef, providerRef),
        ),
      )
      .limit(2);
    if (intents.length !== 1) return null;
    return {
      intent: intents[0]!,
      evidenceAmountIdr: evidence ? Number(evidence.amountIdr) : null,
    };
  });
}

/** 1077 R1: the hold key of an unreadable matched success. `refund_recon_holds
 * .provider_refund_id` is varchar(100) and the parser accepts ids up to 100
 * characters, so `invalid:<id>` can overflow and roll the hold back (the
 * webhook then fails and nothing stops the money). Up to the column limit the
 * key stays `invalid:<id>` (keys already stored keep their identity); a longer
 * one is `invalid-h:` plus the SHA-256 of the full id (74 characters, never
 * truncated, so different ids stay different). The prefixes differ at the
 * eighth character, so a hashed key never equals a plain one. */
const REFUND_HOLD_ID_MAX = 100;
function invalidReportHoldRefundId(rawId: string): string {
  const plain = `invalid:${rawId}`;
  if (plain.length <= REFUND_HOLD_ID_MAX) return plain;
  return `invalid-h:${createHash("sha256").update(rawId).digest("hex")}`;
}

const REFERENCE_MISMATCH_HOLD_REASON =
  "Refund penyedia menyebut pembayaran lain dari pembayaran yang dikembalikan (REFERENCE_MISMATCH)";

/** legend-9s33i (1025 C): a signed refund event whose reference names another
 * intent than the one owning its payment id is not dropped without a trace:
 * an open recon hold on the intent that owns the payment id (blocks its
 * refunds and payouts until finance matches it) and one supervisor alert,
 * sent by the winner of the insert (unique per stored event, so a replay, a
 * worker retry and a concurrent delivery add neither). Still no refund row, no
 * stamp, no journal. */
async function holdRefundReferenceMismatch(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  intent: PaymentIntentRow,
  refund: {
    providerRefundId: string | null;
    amountIdr: number;
    /** The provider payment id the event names (stored on the hold, so
     * finance counts the refund against that transaction). */
    providerPaymentRef?: string | null;
    /** Status the refund carries: only a succeeded one (or one that names no
     * status, on a `refund.succeeded` event) is held. */
    refundStatus?: string;
    /** Our refund whose key the event matched (R). Used when the event names
     * no refund id: the hold then has a fixed key (R, the owner intent and the
     * named payment id), not the stored event id, so two envelopes of the same
     * report make one hold (1101 F6). */
    matchedRefundId?: string;
  },
  now: Date,
): Promise<void> {
  if (
    refund.refundStatus !== undefined &&
    !isDoitRefundSuccessStatus(refund.refundStatus)
  )
    return;
  // 1101 F6: own domain, so it never meets an event id or another hold key.
  // Generation 1 is the key itself; generation g >= 2 adds "\0gen\0<g>" (I7,
  // below). A hash stands for the whole family of the key.
  const fixedKeyDomain =
    refund.providerRefundId === null && refund.matchedRefundId
      ? `refund_recon_hold.mismatch_no_refund_id\0${context.tenant.tenantId}\0${intent.id.toLowerCase()}\0${refund.providerPaymentRef ?? ""}\0${refund.matchedRefundId.toLowerCase()}`
      : null;
  const hashedEventId = (input: string): string => {
    const hex = createHash("sha256").update(input).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  // 1108 P2: a hold an earlier build stored for THIS stored event (key = the
  // event id) is the first generation of the family: the retry of that event
  // raises it and never files a second, countable hold under the new key.
  // Found under the locks below.
  let legacyFirst = false;
  let legacyHeldAmount: number | null = null;
  const generationEventId = (generation: number): string =>
    fixedKeyDomain === null || (legacyFirst && generation === 1)
      ? row.id
      : hashedEventId(
          generation === 1
            ? fixedKeyDomain
            : `${fixedKeyDomain}\0gen\0${generation}`,
        );
  let eventKey = generationEventId(1);
  await withTenant(db, context, async (tx) => {
    // legend-xmtih: the hold limits the DP credit of the intent, so it is made
    // under the same locks as a provider refund (the intent row, then the
    // deposit-intent locks exclusive): a credit apply holding them shared
    // commits first, or the hold is already visible to the apply that follows.
    await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      )
      .for("update");
    await lockDepositIntentsExclusive(tx, context.tenant.tenantId, intent.id);
    if (fixedKeyDomain !== null) {
      const [legacy] = await tx
        .select({ id: refundReconHolds.id })
        .from(refundReconHolds)
        .where(
          and(
            eq(refundReconHolds.tenantId, context.tenant.tenantId),
            eq(refundReconHolds.paymentIntentId, intent.id),
            eq(refundReconHolds.webhookEventId, row.id),
            isNull(refundReconHolds.providerRefundId),
          ),
        )
        .limit(1);
      legacyFirst = legacy !== undefined;
      eventKey = generationEventId(1);
      if (!legacyFirst) {
        // 1108 P2: another envelope (E') of the same report, after an upgrade:
        // an earlier build already holds the report under ITS event id (a stored
        // event of this tenant, not a hash key). A second countable mismatch
        // hold would let finance book one report twice, so the new first
        // generation is filed as a CONFLICT hold (finance cannot count it) for
        // the larger of the two amounts. A retry of E itself found its own old
        // hold above.
        const legacyHolds = await tx
          .select({ amountIdr: refundReconHolds.amountIdr })
          .from(refundReconHolds)
          .where(
            and(
              eq(refundReconHolds.tenantId, context.tenant.tenantId),
              eq(refundReconHolds.paymentIntentId, intent.id),
              isNull(refundReconHolds.providerRefundId),
              isNull(refundReconHolds.providerRefundIdKind),
              eq(refundReconHolds.reason, REFERENCE_MISMATCH_HOLD_REASON),
              sql`coalesce(${refundReconHolds.providerPaymentRef}, '') = ${refund.providerPaymentRef ?? ""}`,
              inArray(
                refundReconHolds.webhookEventId,
                tx
                  .select({ id: gatewayWebhookEvents.id })
                  .from(gatewayWebhookEvents)
                  .where(
                    eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
                  ),
              ),
            ),
          )
          .for("update");
        if (legacyHolds.length > 0)
          legacyHeldAmount = Math.max(
            ...legacyHolds.map((hold) => Number(hold.amountIdr)),
          );
      }
    }
    const [held] = await tx
      .insert(refundReconHolds)
      .values({
        tenantId: context.tenant.tenantId,
        paymentIntentId: intent.id,
        webhookEventId: eventKey,
        providerRefundId: refund.providerRefundId,
        // The id a refund event names is the provider's own (1035).
        providerRefundIdKind:
          refund.providerRefundId === null ? null : "provider",
        amountIdr: idr(Math.max(refund.amountIdr, legacyHeldAmount ?? 0)),
        providerPaymentRef: refund.providerPaymentRef ?? null,
        reason:
          legacyHeldAmount === null
            ? REFERENCE_MISMATCH_HOLD_REASON
            : HOLD_TRANSACTION_CONFLICT_REASON,
        flaggedAt: now,
      })
      // Per stored event, and per provider refund id of the intent: a replay,
      // a worker retry or the provider resending the refund adds no second hold.
      .onConflictDoNothing()
      .returning({ id: refundReconHolds.id });
    if (!held) {
      // 1090 P1-1: the same report again (same stored event) or another report
      // of the same provider refund id and transaction. An OPEN hold of that
      // identity is never lowered, and it is raised to the larger amount: a
      // later report that names the whole payment (amount unreadable, 1077 R2)
      // must not be swallowed by a smaller hold, or the deposit credit (which
      // is limited by the open hold amount) would still spend the difference.
      // Done under the intent row and deposit-intent locks taken above. A
      // hold finance already resolved is not touched.
      const raised = await tx
        .update(refundReconHolds)
        .set({
          amountIdr: sql`greatest(${refundReconHolds.amountIdr}, ${refund.amountIdr})`,
        })
        .where(
          and(
            eq(refundReconHolds.tenantId, context.tenant.tenantId),
            eq(refundReconHolds.paymentIntentId, intent.id),
            isNull(refundReconHolds.resolvedAt),
            sql`${refundReconHolds.amountIdr} < ${refund.amountIdr}`,
            refund.providerRefundId === null
              ? eq(refundReconHolds.webhookEventId, eventKey)
              : or(
                  eq(refundReconHolds.webhookEventId, eventKey),
                  and(
                    eq(refundReconHolds.providerRefundIdKind, "provider"),
                    eq(
                      refundReconHolds.providerRefundId,
                      refund.providerRefundId,
                    ),
                    sql`coalesce(${refundReconHolds.providerPaymentRef}, '') = ${refund.providerPaymentRef ?? ""}`,
                  ),
                ),
          ),
        )
        .returning({ id: refundReconHolds.id });
      if (raised.length === 0) {
        // Nothing open to raise. A hold of this provider refund id that finance
        // already resolved is not reopened, but a larger report of the same
        // identity is new evidence (the deposit credit and refunds of the
        // transaction were open again): it goes through the one rule of the
        // conflict door (1072 I7), which opens a hold for the full reported
        // amount when it is above the largest ever held for the key.
        if (refund.providerRefundId === null) {
          // 1101 I7: a no-id hold with the fixed key. A hold finance already
          // resolved is not reopened, but a report above the largest amount
          // ever held for the key (every generation, open or resolved) is new
          // evidence: an open generation is raised, else a new generation is
          // filed (CONFLICT reason, full amount: finance cannot count it, so
          // it never books twice). A replay (same or smaller) adds nothing.
          if (fixedKeyDomain === null) return;
          const family = await tx
            .select({
              id: refundReconHolds.id,
              webhookEventId: refundReconHolds.webhookEventId,
              amountIdr: refundReconHolds.amountIdr,
              resolvedAt: refundReconHolds.resolvedAt,
            })
            .from(refundReconHolds)
            .where(
              and(
                eq(refundReconHolds.tenantId, context.tenant.tenantId),
                eq(refundReconHolds.paymentIntentId, intent.id),
                isNull(refundReconHolds.providerRefundId),
                sql`coalesce(${refundReconHolds.providerPaymentRef}, '') = ${refund.providerPaymentRef ?? ""}`,
              ),
            )
            .for("update");
          const generationOf = new Map<string, number>();
          for (
            let generation = 1;
            generation <= family.length + 1;
            generation++
          )
            generationOf.set(generationEventId(generation), generation);
          const mine = family.filter((hold) =>
            generationOf.has(hold.webhookEventId),
          );
          const maxHeld = Math.max(
            0,
            ...mine.map((hold) => Number(hold.amountIdr)),
          );
          if (refund.amountIdr <= maxHeld) return;
          const alertGeneration = (generation: number) =>
            alertProviderRefundTransactionConflict(
              tx,
              context,
              {
                intentId: intent.id,
                outletId: intent.outletId,
                dedupKey: `${refund.providerPaymentRef ?? ""}\0${eventKey}\0${generation}`,
                amountIdr: refund.amountIdr,
              },
              now,
            );
          const openHold = mine.find((hold) => hold.resolvedAt === null);
          if (openHold) {
            const raisedOpen = await tx
              .update(refundReconHolds)
              .set({
                amountIdr: sql`greatest(${refundReconHolds.amountIdr}, ${refund.amountIdr})`,
                reason: HOLD_TRANSACTION_CONFLICT_REASON,
              })
              .where(
                and(
                  eq(refundReconHolds.id, openHold.id),
                  isNull(refundReconHolds.resolvedAt),
                ),
              )
              .returning({ id: refundReconHolds.id });
            if (raisedOpen.length > 0)
              await alertGeneration(
                generationOf.get(openHold.webhookEventId) ?? 1,
              );
            return;
          }
          const used = new Set(mine.map((hold) => hold.webhookEventId));
          let generation = 1;
          while (used.has(generationEventId(generation))) generation++;
          const [added] = await tx
            .insert(refundReconHolds)
            .values({
              tenantId: context.tenant.tenantId,
              paymentIntentId: intent.id,
              webhookEventId: generationEventId(generation),
              providerRefundId: null,
              providerRefundIdKind: null,
              amountIdr: idr(refund.amountIdr),
              providerPaymentRef: refund.providerPaymentRef ?? null,
              reason: HOLD_TRANSACTION_CONFLICT_REASON,
              flaggedAt: now,
            })
            .onConflictDoNothing()
            .returning({ id: refundReconHolds.id });
          if (added) await alertGeneration(generation);
          return;
        }
        const sameKey = and(
          eq(refundReconHolds.tenantId, context.tenant.tenantId),
          eq(refundReconHolds.paymentIntentId, intent.id),
          eq(refundReconHolds.providerRefundIdKind, "provider"),
          eq(refundReconHolds.providerRefundId, refund.providerRefundId),
          sql`coalesce(${refundReconHolds.providerPaymentRef}, '') = ${refund.providerPaymentRef ?? ""}`,
        );
        const [open] = await tx
          .select({ id: refundReconHolds.id })
          .from(refundReconHolds)
          .where(and(sameKey, isNull(refundReconHolds.resolvedAt)))
          .limit(1);
        if (open) return;
        const [resolved] = await tx
          .select({ id: refundReconHolds.id })
          .from(refundReconHolds)
          .where(and(sameKey, isNotNull(refundReconHolds.resolvedAt)))
          .limit(1);
        if (!resolved) return;
        await fileTransactionConflictHoldInTx(
          tx,
          context,
          {
            intentId: intent.id,
            outletId: intent.outletId,
            providerRefundId: refund.providerRefundId,
            providerRefundIdKind: "provider",
            providerPaymentRef: refund.providerPaymentRef ?? null,
            amountIdr: refund.amountIdr,
          },
          now,
        );
        return;
      }
    }
    await alertRefundReferenceMismatch(
      tx,
      context,
      {
        intentId: intent.id,
        outletId: intent.outletId,
        providerRefundId: refund.providerRefundId,
        amountIdr: refund.amountIdr,
      },
      eventKey,
      now,
    );
  });
}

/** 1101 (CTO decision 1, Q45; 1108 P1-1 covers every kind and outcome):
 * while the DOIT refund switch is off, a signed success or failure on a
 * matched refund (its key, its refund id, one finance settled by hand, or the
 * payment object; valid or invalid payload) is not told apart from an echo,
 * and no made-up or alias id is guessed. One CONFLICT hold per stored event,
 * with no refund id, for the full value (`amountIdr`): only finance's
 * `not_this_intent` closes it. No fact, no journal, no refund, no stamp. The
 * stored event id is the key: a replay or a worker retry adds none (an open
 * hold of the event is only raised). Same locks as every hold that limits the
 * deposit credit: the intent row, then the deposit-intent locks exclusive.
 * 1126: the same hold (and key rule) serves a signed success no refund of ours
 * matches (`variant: "unmatched"`); only the finance alert text differs. */
async function holdSwitchedOffRefundSuccess(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  intent: PaymentIntentRow,
  hold: {
    providerPaymentRef: string | null;
    amountIdr: number;
    /** 1126 (`unmatched` only): the provider refund id the event names. The
     * hold then goes through the one conflict-hold helper
     * (`fileTransactionConflictHoldInTx`): once per intent, refund id and
     * payment, raised and surplus generations as for every other door. Without
     * it the key is the stored event id. */
    providerRefundId?: string | null;
    /** 1126 (`unmatched` with a refund id): the amount the event reports
     * readably. Only a fact of this very intent, refund id and transaction
     * that covers it makes the report a replay (no hold). */
    reportedAmountIdr?: number;
    /** 1139 P1-2: the intent was mapped by the event's `reference` only. The
     * mapping is read again under the intent lock: the intent must still be
     * this provider's, with this provider ref and the integration that was
     * checked against the signature. Else `stale`: no hold. */
    mappedByReference?: boolean;
    /** 1139 P1-1 (`unmatched` only): first processing, inside the retry
     * window. The hold is filed now but finance is not told yet: the refund
     * may still match one of ours and close it. The pass after the window
     * tells finance (the alert id is stable, so a replay adds none). */
    deferAlert?: boolean;
    /** 1144 (SO ronde 16 P2-1, switch off): the provider refund id the report
     * names. Finance is told ONE alert per (tenant, integration, intent,
     * refund id), whatever the alert type and retry (see `stableRefund`). */
    alertRefundId?: string | null;
  },
  now: Date,
  variant: "switched_off" | "unmatched" = "switched_off",
): Promise<"filed" | "skipped" | "stale"> {
  return await withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select({
        provider: paymentIntents.provider,
        providerRef: paymentIntents.providerRef,
        gatewayIntegrationId: paymentIntents.gatewayIntegrationId,
      })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      )
      .for("update");
    if (
      hold.mappedByReference &&
      (!locked ||
        locked.provider !== PROVIDER ||
        locked.providerRef === null ||
        locked.providerRef !== hold.providerPaymentRef ||
        locked.gatewayIntegrationId !== intent.gatewayIntegrationId)
    )
      return "stale";
    await lockDepositIntentsExclusive(tx, context.tenant.tenantId, intent.id);
    // 1126: an unmatched success that names a provider refund id. A fact of
    // THIS intent, this refund id and this transaction that covers the readable
    // reported amount is the replay of money booked once: no hold. Anything
    // else (the id booked on another intent or transaction, a smaller fact, an
    // unreadable amount) is held, through the one conflict-hold helper (1045
    // A4, 1055 G2, 1108 P1-2): once per (intent, refund id, transaction), an
    // open hold raised to the conflict reason and the larger amount, a
    // resolved one opens a surplus generation. Finance is told here, only when
    // a hold was filed or changed.
    if (variant === "unmatched" && hold.providerRefundId) {
      const refundId = hold.providerRefundId;
      if (hold.reportedAmountIdr !== undefined) {
        const [covering] = await tx
          .select({ id: paymentProviderRefunds.id })
          .from(paymentProviderRefunds)
          .where(
            and(
              eq(paymentProviderRefunds.tenantId, context.tenant.tenantId),
              eq(paymentProviderRefunds.paymentIntentId, intent.id),
              eq(paymentProviderRefunds.provider, PROVIDER),
              eq(paymentProviderRefunds.refundIdKind, "provider"),
              eq(paymentProviderRefunds.providerRefundId, refundId),
              eq(
                paymentProviderRefunds.providerPaymentRef,
                hold.providerPaymentRef ?? "",
              ),
              sql`${paymentProviderRefunds.amountIdr} >= ${hold.reportedAmountIdr}`,
            ),
          )
          .limit(1);
        if (covering) return "skipped";
      }
      await fileTransactionConflictHoldInTx(
        tx,
        context,
        {
          intentId: intent.id,
          outletId: intent.outletId,
          providerRefundId: refundId,
          providerRefundIdKind: "provider",
          providerPaymentRef: hold.providerPaymentRef,
          amountIdr: hold.amountIdr,
          silent: true,
        },
        now,
      );
      // Inside the retry window finance is not told yet (`deferAlert`); after
      // it, every pass tells finance (a stable alert id: replays add none).
      if (!hold.deferAlert)
        await alertProviderRefundUnmatched(
          tx,
          context,
          {
            intentId: intent.id,
            outletId: intent.outletId,
            dedupKey: `${hold.providerPaymentRef ?? ""}\0unmatched\0${refundId}\0${hold.amountIdr}`,
            amountIdr: hold.amountIdr,
          },
          now,
        );
      return "filed";
    }
    // Key of the hold: the stored event id. When that id is already used by a
    // hold of another intent (the table is unique per tenant and event), a
    // fixed fallback key of this event and intent is used: never a silent
    // return without a hold of this intent (fail closed).
    const fallbackKey = createHash("sha256")
      .update(
        `refund_recon_hold.${variant}\0${context.tenant.tenantId}\0${intent.id.toLowerCase()}\0${row.id}`,
      )
      .digest("hex");
    const keys = [
      row.id,
      `${fallbackKey.slice(0, 8)}-${fallbackKey.slice(8, 12)}-${fallbackKey.slice(12, 16)}-${fallbackKey.slice(16, 20)}-${fallbackKey.slice(20, 32)}`,
    ];
    for (const key of keys) {
      const [held] = await tx
        .insert(refundReconHolds)
        .values({
          tenantId: context.tenant.tenantId,
          paymentIntentId: intent.id,
          webhookEventId: key,
          providerRefundId: null,
          providerRefundIdKind: null,
          amountIdr: idr(hold.amountIdr),
          providerPaymentRef: hold.providerPaymentRef,
          reason: HOLD_TRANSACTION_CONFLICT_REASON,
          flaggedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: refundReconHolds.id });
      const alertFiled = async () => {
        if (hold.deferAlert) return;
        await (
          variant === "unmatched"
            ? alertProviderRefundUnmatched
            : alertProviderRefundSwitchedOff
        )(
          tx,
          context,
          {
            intentId: intent.id,
            outletId: intent.outletId,
            dedupKey: `${hold.providerPaymentRef ?? ""}\0${variant}\0${key}`,
            amountIdr: hold.amountIdr,
            ...(hold.alertRefundId
              ? {
                  stableRefund: {
                    integrationId:
                      locked?.gatewayIntegrationId ??
                      intent.gatewayIntegrationId ??
                      null,
                    refundId: hold.alertRefundId,
                  },
                }
              : {}),
          },
          now,
        );
      };
      if (held) {
        await alertFiled();
        return "filed";
      }
      // The key is taken. A hold of THIS intent under it is the hold of this
      // event: never lowered, raised to the larger value and to the conflict
      // reason; one finance already resolved is not reopened.
      const [mine] = await tx
        .select({ id: refundReconHolds.id })
        .from(refundReconHolds)
        .where(
          and(
            eq(refundReconHolds.tenantId, context.tenant.tenantId),
            eq(refundReconHolds.paymentIntentId, intent.id),
            eq(refundReconHolds.webhookEventId, key),
          ),
        )
        .limit(1);
      if (!mine) continue;
      await tx
        .update(refundReconHolds)
        .set({
          amountIdr: sql`greatest(${refundReconHolds.amountIdr}, ${hold.amountIdr})`,
          reason: HOLD_TRANSACTION_CONFLICT_REASON,
        })
        .where(
          and(
            eq(refundReconHolds.id, mine.id),
            isNull(refundReconHolds.resolvedAt),
          ),
        );
      // 1139: the hold of an earlier pass (silent inside the retry window) is
      // announced by the pass after it; the alert id is stable. Only for a hold
      // still open: one finance already closed is not announced again.
      if (variant === "unmatched") {
        const [open] = await tx
          .select({ id: refundReconHolds.id })
          .from(refundReconHolds)
          .where(
            and(
              eq(refundReconHolds.id, mine.id),
              isNull(refundReconHolds.resolvedAt),
            ),
          )
          .limit(1);
        if (open) await alertFiled();
      }
      return "filed";
    }
    throw new Error("Refund hold of a switched-off provider was not filed");
  });
}

const UNMATCHED_NO_MONEY_STATUSES = [
  "pending",
  "processing",
  "requested",
  "failed",
];

/** 1126: a signed refund success that matches no refund of Legend must not end
 * without a hold (a refund made in the provider's dashboard otherwise leaves
 * the refund room untouched and a manual refund pays twice). The payment the
 * event names is mapped to ONE intent: by the intent the caller already proved
 * (`known`: the refund's own intent whose updater said 404), else by
 * `findRefundCandidate` on the named payment id (null on none or two intents,
 * and a flat id that differs from the payment object's id is no mapping), and
 * the signature must be that intent's own integration. Mapped: one CONFLICT
 * hold (per stored event, or per intent, refund id and transaction when the
 * event names a provider refund id) for the full reported value (an amount the event does
 * not give readably holds the whole payment: restrictive). No fact, no
 * journal, no refund. Not mapped: no hold, one finance alert per event and a
 * structured warning (`unmatched_unmapped_payment`). Callers gate on a
 * succeeded status and the end of the retry window where one applies. */
async function holdUnmatchedRefundSuccess(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  facts: DoitRefundFacts,
  verifiedSecret: string | undefined,
  now: Date,
  known?: PaymentIntentRow,
  /** 1139 P1-1: first processing, inside the retry window. A payment that
   * cannot be mapped yet is only logged (the pass after the window alerts). */
  inRetryWindow = false,
  /** The readable provider-initiated refund of the event (refund id, payment
   * id, amount), when `readProviderInitiatedRefund` reads one: after the
   * window it is recorded as a fact (or held as a reference mismatch) by
   * `recordRefundFor`. */
  providerRefund: {
    refundId: string;
    paymentId: string;
    amountIdr: number;
  } | null = null,
): Promise<"held" | "unmapped" | "skipped"> {
  // Only a KNOWN pending or failed status moved no money and is skipped; a
  // success status, no status, and any status we do not know are held
  // (restrictive: an unknown spelling may still be money back to the payer).
  if (
    facts.refundStatus !== undefined &&
    UNMATCHED_NO_MONEY_STATUSES.includes(facts.refundStatus)
  )
    return "skipped";
  // 1126: `namedPaymentId` is the id of a payment object that could not be
  // read as a whole; it maps the event for the hold only.
  const readPaymentId = facts.payment?.id ?? facts.namedPaymentId;
  const conflictingIds =
    facts.paymentId !== undefined &&
    readPaymentId !== undefined &&
    facts.paymentId !== readPaymentId;
  const namedPaymentId = conflictingIds
    ? undefined
    : (facts.paymentId ?? readPaymentId);
  let candidate = namedPaymentId
    ? await findRefundCandidate(context, namedPaymentId)
    : null;
  // 1139 P1-2: the `reference` (the Legend intent id) is a fallback mapping,
  // only when the event names no payment id at all: a payment id always wins
  // (a conflicting reference is only alerted below). 1144: a payment id that is
  // named but dropped (conflicting, unreadable) is NOT absent: no mapping by
  // reference, so no third intent is touched (unmapped: finance is told). The intent must be of the
  // receiving tenant (found by the tenant-scoped read), this provider's, with an
  // own provider ref (a payment exists, not checked as paid), and map back to
  // itself by that ref (one intent).
  let mappedByReference: string | undefined;
  if (
    !known &&
    facts.paymentId === undefined &&
    readPaymentId === undefined &&
    !facts.paymentIdUnusable &&
    facts.reference !== undefined
  ) {
    const reference = uuidSchema.safeParse(facts.reference);
    const referenced = reference.success
      ? await withTenant(db, context, async (tx) => {
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
        })
      : null;
    if (
      referenced &&
      referenced.provider === PROVIDER &&
      referenced.providerRef !== null
    ) {
      const viaRef = await findRefundCandidate(context, referenced.providerRef);
      if (viaRef && viaRef.intent.id === referenced.id) {
        candidate = viaRef;
        mappedByReference = referenced.providerRef;
      }
    }
  }
  let owner: {
    intent: PaymentIntentRow;
    evidenceAmountIdr: number | null;
  } | null = null;
  if (known) {
    owner = {
      intent: known,
      evidenceAmountIdr:
        candidate && candidate.intent.id === known.id
          ? candidate.evidenceAmountIdr
          : null,
    };
  } else if (
    candidate &&
    candidate.intent.provider === PROVIDER &&
    (await signedByIntentIntegration(
      context,
      candidate.intent,
      row,
      verifiedSecret,
      now,
    ))
  ) {
    owner = candidate;
  }
  // 1139: inside the window an event that `recordRefundFor` would hold as a
  // reference mismatch after it (a readable refund whose reference names
  // another intent than the payment id's) is held NOW by that very path: the
  // same countable mismatch hold and alert, only earlier, never a second
  // conflict hold next to it.
  if (inRetryWindow && providerRefund && owner && !known) {
    const references = [
      ...(facts.reference !== undefined ? [facts.reference] : []),
      ...(facts.payment ? [facts.payment.reference] : []),
    ];
    if (references.some((reference) => reference !== owner.intent.id)) {
      await holdRefundReferenceMismatch(
        context,
        row,
        owner.intent,
        {
          providerRefundId: providerRefund.refundId,
          amountIdr: providerRefund.amountIdr,
          providerPaymentRef: providerRefund.paymentId,
          refundStatus: facts.refundStatus,
        },
        now,
      );
      return "held";
    }
  }
  const full = owner
    ? Math.max(Number(owner.intent.amountIdr), owner.evidenceAmountIdr ?? 0)
    : 0;
  const reported =
    facts.amountIdr !== undefined &&
    Number.isFinite(facts.amountIdr) &&
    facts.amountIdr > 0
      ? facts.amountIdr
      : undefined;
  // The reported value when readable, else the whole payment; a mapped owner
  // whose whole payment reads as zero is still held for the reported value.
  const heldAmount = reported ?? (Number.isFinite(full) ? full : 0);
  if (!owner || heldAmount <= 0) {
    logger.warn(
      { webhookEventId: row.id, code: "unmatched_unmapped_payment" },
      "Unmatched DOIT refund.succeeded names no single Legend payment; no hold, finance told",
    );
    if (inRetryWindow) return "unmapped";
    await withTenant(db, context, (tx) =>
      alertProviderRefundUnmatchedUnmapped(
        tx,
        context,
        { webhookEventId: row.id },
        now,
      ),
    );
    return "unmapped";
  }
  const filed = await holdSwitchedOffRefundSuccess(
    context,
    row,
    owner.intent,
    {
      providerPaymentRef:
        namedPaymentId ?? mappedByReference ?? owner.intent.providerRef ?? null,
      providerRefundId: facts.refundId ?? null,
      ...(reported !== undefined ? { reportedAmountIdr: reported } : {}),
      ...(mappedByReference !== undefined ? { mappedByReference: true } : {}),
      ...(inRetryWindow ? { deferAlert: true } : {}),
      amountIdr: heldAmount,
    },
    now,
    "unmatched",
  );
  if (filed === "stale") {
    // The reference mapping did not survive the recheck under the intent lock.
    logger.warn(
      { webhookEventId: row.id, code: "unmatched_reference_mapping_stale" },
      "Unmatched DOIT refund.succeeded: the intent named by the reference changed; no hold",
    );
    if (!inRetryWindow)
      await withTenant(db, context, (tx) =>
        alertProviderRefundUnmatchedUnmapped(
          tx,
          context,
          { webhookEventId: row.id },
          now,
        ),
      );
    return "unmapped";
  }
  // 1139 P1-2: the payment id won over a reference that names another intent:
  // held on the payment's intent as always, and finance is told of the doubt.
  if (
    filed === "filed" &&
    mappedByReference === undefined &&
    facts.reference !== undefined &&
    facts.reference.toLowerCase() !== owner.intent.id.toLowerCase()
  )
    await withTenant(db, context, (tx) =>
      alertRefundReferenceMismatch(
        tx,
        context,
        {
          intentId: owner.intent.id,
          outletId: owner.intent.outletId,
          providerRefundId: facts.refundId ?? null,
          amountIdr: heldAmount,
        },
        row.id,
        now,
      ),
    );
  if (filed === "skipped") {
    logger.warn(
      { webhookEventId: row.id, code: "unmatched_refund_id_already_recorded" },
      "Unmatched DOIT refund.succeeded names a refund id already booked; no hold",
    );
    return "skipped";
  }
  return "held";
}

/** 1139: the hold of a first pass is silent (finance is told by the pass after
 * the retry window). A pass that ends without filing the hold again (our refund
 * matched but did not cover it, the refund booked no fact, or the recorder asked
 * for a retry) must still announce a hold that is STILL OPEN: one finance alert,
 * with the id the ordinary hold path uses (refund id and amount, else the hold
 * key), so a later pass or the ordinary path adds none. Only open conflict holds
 * of this payment that belong to this event (its stored id) or this provider
 * refund id. Called under the caller's transaction and intent lock. */
async function announceOpenFirstPassHolds(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  context: ScopedTenantContext,
  intent: { id: string; outletId: string },
  key: {
    eventRowId: string | null;
    providerRefundId: string | null;
    paymentRef: string;
  },
  now: Date,
): Promise<void> {
  const owned = [
    ...(key.eventRowId !== null
      ? [eq(refundReconHolds.webhookEventId, key.eventRowId)]
      : []),
    ...(key.providerRefundId !== null
      ? [
          and(
            eq(refundReconHolds.providerRefundIdKind, "provider"),
            eq(refundReconHolds.providerRefundId, key.providerRefundId),
          ),
        ]
      : []),
  ];
  if (owned.length === 0) return;
  // A payment the provider refunded in full is flagged (958) and finance was
  // told then: that flag already stops every refund and payout of it.
  const [flag] = await tx
    .select({
      providerRefundedAt: paymentIntents.providerRefundedAt,
      providerRefundedAfterPaidAt: paymentIntents.providerRefundedAfterPaidAt,
      gatewayIntegrationId: paymentIntents.gatewayIntegrationId,
    })
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.tenantId, context.tenant.tenantId),
        eq(paymentIntents.id, intent.id),
      ),
    )
    .limit(1);
  if (flag?.providerRefundedAt || flag?.providerRefundedAfterPaidAt) return;
  // 1144 (SO ronde 16 P2-1): with the switch off the same report is also told
  // by the switched-off alert; both share one stable id per refund id.
  const switchedOff = refundProviderSwitchedOff(PROVIDER);
  const open = await tx
    .select({
      amountIdr: refundReconHolds.amountIdr,
      providerRefundId: refundReconHolds.providerRefundId,
      webhookEventId: refundReconHolds.webhookEventId,
    })
    .from(refundReconHolds)
    .where(
      and(
        eq(refundReconHolds.tenantId, context.tenant.tenantId),
        eq(refundReconHolds.paymentIntentId, intent.id),
        isNull(refundReconHolds.resolvedAt),
        eq(refundReconHolds.reason, HOLD_TRANSACTION_CONFLICT_REASON),
        eq(refundReconHolds.providerPaymentRef, key.paymentRef),
        or(...owned),
      ),
    );
  for (const hold of open)
    await alertProviderRefundUnmatched(
      tx,
      context,
      {
        intentId: intent.id,
        outletId: intent.outletId,
        dedupKey:
          hold.providerRefundId !== null
            ? `${key.paymentRef}\0unmatched\0${hold.providerRefundId}\0${Number(hold.amountIdr)}`
            : `${key.paymentRef}\0unmatched\0${hold.webhookEventId}`,
        amountIdr: Number(hold.amountIdr),
        ...(switchedOff && hold.providerRefundId !== null
          ? {
              stableRefund: {
                integrationId: flag?.gatewayIntegrationId ?? null,
                refundId: hold.providerRefundId,
              },
            }
          : {}),
      },
      now,
    );
}

/** 1139: the recorder asked for a retry after the window: the hold of the first
 * pass (if still open) is announced now, not on a later pass that may never
 * come. */
async function announceFirstPassHoldOfRefund(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  refund: { refundId: string; paymentId: string },
  now: Date,
): Promise<void> {
  const candidate = await findRefundCandidate(context, refund.paymentId);
  if (!candidate) return;
  await withTenant(db, context, (tx) =>
    announceOpenFirstPassHolds(
      tx,
      context,
      candidate.intent,
      {
        eventRowId: row.id,
        providerRefundId: refund.refundId,
        paymentRef: refund.paymentId,
      },
      now,
    ),
  );
}

/** 1144: the retry of a first-pass hold ended on a path that closes nothing (the
 * event matched a refund of ours, but the updater refused it, the payment named
 * is another transaction's, or the DOIT refund switch is off). A hold of that
 * first pass still open is announced now (one finance alert, the stable id of
 * `announceOpenFirstPassHolds`), under the intent and deposit-intent locks. */
async function announceFirstPassHoldOfIntent(
  context: ScopedTenantContext,
  intent: { id: string; outletId: string },
  key: {
    eventRowId: string | null;
    providerRefundId: string | null;
    paymentRef: string | null | undefined;
  },
  now: Date,
): Promise<void> {
  const { paymentRef } = key;
  if (!paymentRef) return;
  await withTenant(db, context, async (tx) => {
    await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      )
      .for("update");
    await lockDepositIntentsExclusive(tx, context.tenant.tenantId, intent.id);
    await announceOpenFirstPassHolds(
      tx,
      context,
      intent,
      { ...key, paymentRef },
      now,
    );
  });
}

/** 1139 P1-1: the event was held on first processing (no refund of ours
 * matched yet) and a retry now matches our refund R, which counts the money on
 * its own. The hold of this event (its stored event id, or its provider refund
 * id on this intent) for THE SAME payment (`paymentRef`) is closed so the money
 * is not counted twice. Closed as `not_this_intent`, with a note that says R
 * counts it: a conflict hold is never counted as a provider refund (no
 * `same_as_counted` identity, which would block later facts of the payment).
 * Restrictive: only an open conflict hold of that payment worth no more than
 * R's amount is closed; a larger one (an unreadable amount held the whole
 * payment) stays for finance, and so does any hold when the payment is not
 * known. */
async function closeUnmatchedHoldOfMatchedRefund(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  refund: { amountIdr: number | string },
  intent: PaymentIntentRow,
  providerRefundId: string | null,
  paymentRef: string | null,
  now: Date,
): Promise<void> {
  if (paymentRef === null) return;
  await withTenant(db, context, async (tx) => {
    await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      )
      .for("update");
    await lockDepositIntentsExclusive(tx, context.tenant.tenantId, intent.id);
    await tx
      .update(refundReconHolds)
      .set({
        resolvedAt: now,
        resolution: "not_this_intent",
        resolutionNote:
          "Otomatis: laporan ini ternyata refund Legend yang sudah dihitung; bukan refund tambahan",
      })
      .where(
        and(
          eq(refundReconHolds.tenantId, context.tenant.tenantId),
          eq(refundReconHolds.paymentIntentId, intent.id),
          isNull(refundReconHolds.resolvedAt),
          eq(refundReconHolds.reason, HOLD_TRANSACTION_CONFLICT_REASON),
          sql`${refundReconHolds.amountIdr} <= ${Number(refund.amountIdr)}`,
          eq(refundReconHolds.providerPaymentRef, paymentRef),
          providerRefundId === null
            ? eq(refundReconHolds.webhookEventId, row.id)
            : or(
                eq(refundReconHolds.webhookEventId, row.id),
                and(
                  eq(refundReconHolds.providerRefundIdKind, "provider"),
                  eq(refundReconHolds.providerRefundId, providerRefundId),
                ),
              ),
        ),
      );
    // Not closed (larger than R, or another transaction): finance is told.
    await announceOpenFirstPassHolds(
      tx,
      context,
      intent,
      { eventRowId: row.id, providerRefundId, paymentRef },
      now,
    );
  });
}

/** 1139 P2-1: a first-pass hold (conflict reason, key intent + refund id X +
 * payment P) outlives the fact of X that `recordRefundFor` books after the
 * retry window, though the fact limits later refunds on its own. Closed as
 * `counted_against_intent` once the facts on record for that key cover the
 * hold's value (`holdFactCoversSql`, one atomic statement under the intent
 * and deposit-intent locks); a fact below the hold leaves it open. The intent
 * is the one `recordRefundFor` bound (same candidate rule, signature checked
 * there). */
async function closeFirstPassHoldCoveredByFact(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  refund: { refundId: string; paymentId: string },
  now: Date,
): Promise<void> {
  const candidate = await findRefundCandidate(context, refund.paymentId);
  if (!candidate) return;
  const { intent } = candidate;
  await withTenant(db, context, async (tx) => {
    await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intent.id),
        ),
      )
      .for("update");
    await lockDepositIntentsExclusive(tx, context.tenant.tenantId, intent.id);
    await tx
      .update(refundReconHolds)
      .set({
        resolvedAt: now,
        resolution: "counted_against_intent",
        resolutionNote:
          "Otomatis: refund penyedia sudah dicatat sebagai fakta dan membatasi refund berikutnya",
      })
      .where(
        and(
          eq(refundReconHolds.tenantId, context.tenant.tenantId),
          eq(refundReconHolds.paymentIntentId, intent.id),
          isNull(refundReconHolds.resolvedAt),
          eq(refundReconHolds.reason, HOLD_TRANSACTION_CONFLICT_REASON),
          eq(refundReconHolds.providerRefundIdKind, "provider"),
          eq(refundReconHolds.providerRefundId, refund.refundId),
          eq(refundReconHolds.providerPaymentRef, refund.paymentId),
          holdFactCoversSql(context.tenant.tenantId, refundReconHolds.id),
        ),
      );
    // Not covered (no fact booked, or a smaller one): still open, finance is told.
    await announceOpenFirstPassHolds(
      tx,
      context,
      intent,
      {
        eventRowId: row.id,
        providerRefundId: refund.refundId,
        paymentRef: refund.paymentId,
      },
      now,
    );
  });
}

/** Records a provider refund through the shared helper, in two phases: a
 * short read finds the candidate intent (`findRefundCandidate`), the integration
 * that verified the signature must be the one that minted it
 * (`signedByIntentIntegration`, run with no transaction open), and only then
 * the helper runs in its own transaction with `expectedIntentId`, so it
 * records for that intent or nothing (legend-30hfs R2). `retry` (one of our own
 * refunds for that payment is in flight, so the refund cannot be told apart
 * yet, nothing written) is returned only inside the retry window; after it
 * the refund is recorded again with `force: true` (counted, restrictive when
 * in doubt); a `retry` that survives `force` gets one fresh two-phase pass
 * and is otherwise returned as `retry` (the row stays `failed`). */
async function recordRefundFor(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  input: {
    providerRefundId: string;
    refundIdKind: ProviderRefundIdKind;
    providerPaymentRef: string;
    amountIdr: number;
    source: "refund_webhook" | "payment_webhook";
    /** Intent references the event carries explicitly (refund and payment
     * object). Each must equal the candidate intent's id, else `mismatch`
     * before anything is recorded (legend-6jdy1). */
    expectedReferences?: readonly string[];
    /** Status the event's refund carries (a mismatch is held only when it
     * succeeded, legend-9s33i). */
    refundStatus?: string;
  },
  now: Date,
  verifiedSecret?: string,
): Promise<RefundApplyResult> {
  const { expectedReferences, refundStatus, ...recorded } = input;
  const windowOver = () =>
    now.getTime() - row.receivedAt.getTime() >=
    WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
  const attempt = async (): Promise<
    "retry" | "unbound" | "bound" | "mismatch"
  > => {
    const candidate = await findRefundCandidate(
      context,
      input.providerPaymentRef,
    );
    if (
      !candidate ||
      !(await signedByIntentIntegration(
        context,
        candidate.intent,
        row,
        verifiedSecret,
        now,
      ))
    )
      return "unbound";
    if (
      expectedReferences?.some((reference) => reference !== candidate.intent.id)
    ) {
      await holdRefundReferenceMismatch(
        context,
        row,
        candidate.intent,
        {
          providerRefundId:
            input.refundIdKind === "provider" ? input.providerRefundId : null,
          amountIdr: input.amountIdr,
          providerPaymentRef: input.providerPaymentRef,
          refundStatus,
        },
        now,
      );
      return "mismatch";
    }
    const run = async (force: boolean) =>
      (
        await withTenant(db, context, async (tx) =>
          recordProviderRefundInTx(
            tx,
            context,
            {
              provider: PROVIDER,
              ...recorded,
              expectedIntentId: candidate.intent.id,
              ...(force ? { force: true } : {}),
            },
            now,
          ),
        )
      ).status;
    let status = await run(false);
    if (status === "retry" && windowOver()) status = await run(true);
    if (status === "retry") return "retry";
    return status === "unbound" ? "unbound" : "bound";
  };
  const first = await attempt();
  // `retry` even with `force` (the evidence moved to another intent after the
  // read): one more full pass with a fresh candidate. Still `retry` stays
  // `retry`; the caller keeps the row `failed`, never `ignored`.
  return first === "retry" && windowOver() ? attempt() : first;
}

/** A refund of the payment `paymentId` we cannot size: treated as a refund of
 * all of it. The intent's own transaction takes the 958 flag (blocks
 * allocation, refund and payout of the money recorded for it); an additional
 * transaction (evidence only) is recorded as refunded for its full amount.
 * The signing integration must be the one that minted the intent
 * (`signedByIntentIntegration`). */
async function flagRefundInDoubt(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  paymentId: string,
  now: Date,
  verifiedSecret?: string,
): Promise<RefundApplyResult> {
  const candidate = await findRefundCandidate(context, paymentId);
  if (!candidate) return "unbound";
  if (candidate.intent.providerRef === paymentId) {
    // Same rule as every other event: the integration that signed must be the
    // one that minted the intent (an older intent falls back to its outlet's).
    if (
      !(await signedByIntentIntegration(
        context,
        candidate.intent,
        row,
        verifiedSecret,
        now,
      ))
    )
      return "unbound";
    // A refund of ours still in flight: not told apart yet, nothing recorded
    // (`retry` only inside the window, after it `force` counts it).
    const marked = await markProviderRefunded(
      context,
      candidate.intent.id,
      now,
      "payment_webhook",
      now.getTime() - row.receivedAt.getTime() >=
        WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS,
    );
    return marked === "retry" ? "retry" : "bound";
  }
  if (candidate.evidenceAmountIdr !== null && candidate.evidenceAmountIdr > 0)
    return recordRefundFor(
      context,
      row,
      {
        providerRefundId: paymentId,
        refundIdKind: "synthetic_full",
        providerPaymentRef: paymentId,
        amountIdr: candidate.evidenceAmountIdr,
        source: "payment_webhook",
      },
      now,
      verifiedSecret,
    );
  return "unbound";
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
    if (bound.kind === "found" && bound.boundEvidence) {
      // legend-wourt: an additional transaction of the bill. Only its refund is
      // applied (recorded as a provider refund of that evidence, a parked fund
      // is flagged); every other status of it stays ignored.
      const extra = bound.boundEvidence;
      const applied: RefundApplyResult =
        status === "refunded" && extra.amountIdr > 0
          ? await recordRefundFor(
              context,
              row,
              {
                providerRefundId: event.data.id,
                refundIdKind: "synthetic_full",
                providerPaymentRef: event.data.id,
                amountIdr: extra.amountIdr,
                source: "payment_webhook",
              },
              now,
              verifiedSecret,
            )
          : "unbound";
      if (applied === "retry") {
        // One of our own refunds for that payment is in flight: not told apart
        // yet. Kept `failed` and retried by the worker; after the retry window
        // `recordRefundFor` has already recorded it with `force`.
        await markRow(
          context,
          row.id,
          { status: "failed", lastErrorCode: "UNKNOWN_REFERENCE" },
          now,
        );
        return "failed";
      }
      const recorded = applied === "bound";
      // A refund of the extra the recorder could not write is never silent.
      if (applied === "unbound" && status === "refunded" && extra.amountIdr > 0)
        await withTenant(db, context, (tx) =>
          alertProviderRefundUnbound(
            tx,
            context,
            {
              intentId: intent.id,
              outletId: intent.outletId,
              providerPaymentRef: event.data.id,
            },
            now,
          ),
        );
      await markRow(
        context,
        row.id,
        recorded
          ? {
              status: "processed",
              lastErrorCode: null,
              processedAt: now,
              paymentIntentId: intent.id,
              outletId: intent.outletId,
              providerRef: event.data.id,
            }
          : {
              status: "ignored",
              lastErrorCode: "REFERENCE_MISMATCH",
              processedAt: now,
            },
        now,
      );
      return recorded ? "processed" : "ignored";
    }
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
    } else if (status === "refunded") {
      // 952 round 2: the money went back to the payer. Only the refund time is
      // recorded (the status is untouched, a paid intent is never stamped), so
      // a late `paid` message cannot settle it. The refund itself is not booked
      // automatically. legend-7uqbs: money we already recorded (parked funds, a
      // settled bill) is flagged, audited and alerted once inside this call, so
      // staff cannot refund it a second time; the row below still ends
      // processed. A refund of ours still in flight (nothing recorded yet)
      // keeps the row `failed`, so the worker retries it.
      const marked = await markProviderRefunded(
        context,
        intent.id,
        now,
        "payment_webhook",
        now.getTime() - row.receivedAt.getTime() >=
          WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS,
      );
      if (marked === "retry") {
        outcome = "failed";
        code = "UNKNOWN_REFERENCE";
      }
    }
    // `pending` changes nothing.
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
    const unmatched = async (
      foreign = false,
      knownIntent?: PaymentIntentRow,
    ): Promise<ProcessOutcome> => {
      const retryable =
        now.getTime() - row.receivedAt.getTime() <
        WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
      // legend-30hfs: no refund of ours after the retry window, so the refund
      // is the provider's own (money went back to the payer): record it against
      // the payment it names. An unknown payment or the echo of our own refund
      // keeps the ignored answer below.
      // CTO decision (1135), also with DOIT_REFUNDS_ENABLED off: a signed
      // report that fully matches (refund id, amount, readable payment id,
      // after the retry window) is still recorded as a fact. The money has
      // already left at the provider, and the fact only limits later refunds.
      // Anything that does not fully match is held, never booked.
      const providerRefund = foreign
        ? readProviderInitiatedRefund(event.type, facts)
        : null;
      if (!retryable && providerRefund) {
        const applied = await recordRefundFor(
          context,
          row,
          {
            providerRefundId: providerRefund.refundId,
            refundIdKind: "provider",
            providerPaymentRef: providerRefund.paymentId,
            amountIdr: providerRefund.amountIdr,
            source: "refund_webhook",
            refundStatus: facts.refundStatus,
            expectedReferences: [
              ...(facts.reference !== undefined ? [facts.reference] : []),
              ...(facts.payment ? [facts.payment.reference] : []),
            ],
          },
          now,
          verifiedSecret,
        );
        if (applied === "mismatch")
          return await ignoredWith("REFERENCE_MISMATCH");
        if (applied === "retry") {
          // Unresolved even with `force`: kept `failed` (the worker retries),
          // never ignored. A hold of the first pass still open is announced
          // now (1139), not on a pass that may never come.
          await announceFirstPassHoldOfRefund(
            context,
            row,
            providerRefund,
            now,
          );
          await markRow(
            context,
            row.id,
            { status: "failed", lastErrorCode: "REFUND_UNMATCHED" },
            now,
          );
          return "failed";
        }
        if (applied === "bound") {
          // 1139 P2-1: the fact of X now limits the refunds of the payment, so
          // the hold of the first pass (same refund id and payment) is closed
          // when that fact covers its value.
          await closeFirstPassHoldCoveredByFact(
            context,
            row,
            providerRefund,
            now,
          );
          await markRow(
            context,
            row.id,
            {
              status: "processed",
              lastErrorCode: null,
              processedAt: now,
              providerRef: providerRefund.refundId,
            },
            now,
          );
          return "processed";
        }
      }
      if (status === "succeeded") {
        // 1126: never ignored without a hold. 1139 P1-1: also on first
        // processing, inside the retry window: the refund may still be storing
        // its provider ref, but until it does the provider's money must already
        // limit the refund room. The hold key is stable (refund id, else the
        // stored event), so every retry only raises it, and a later match of
        // our refund closes it (`closeUnmatchedHoldOfMatchedRefund`). The hold
        // is filed before the row is marked (idempotent by event).
        await holdUnmatchedRefundSuccess(
          context,
          row,
          facts,
          verifiedSecret,
          now,
          knownIntent,
          retryable,
          providerRefund,
        );
        if (!retryable)
          logger.warn(
            { webhookEventId: row.id },
            "Unmatched DOIT refund.succeeded ignored; check the provider for a refund Legend does not know (paid twice?)",
          );
      }
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
    if (target.kind === "none") return await unmatched(true);
    if (target.kind === "ambiguous") {
      // 1126: two refunds match: the event is a conflict, and a success that
      // names a mappable payment is held too (restrictive).
      if (status === "succeeded")
        await holdUnmatchedRefundSuccess(
          context,
          row,
          facts,
          verifiedSecret,
          now,
        );
      return await ignoredWith("REJECTED_CONFLICT");
    }

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
      // legend-9s33i: hold the intent that owns the payment id the event
      // names (when the signature is that intent's own); nothing is refunded.
      const namedPaymentId = facts.paymentId ?? facts.payment?.id;
      const owner = namedPaymentId
        ? await findRefundCandidate(context, namedPaymentId)
        : null;
      // Only a refund.succeeded event is held (refund.failed never is).
      if (
        status === "succeeded" &&
        owner &&
        (await signedByIntentIntegration(
          context,
          owner.intent,
          row,
          verifiedSecret,
          now,
        ))
      )
        await holdRefundReferenceMismatch(
          context,
          row,
          owner.intent,
          {
            providerRefundId: facts.refundId ?? null,
            // 1077 R2: an amount the event does not give readably holds the
            // whole payment of the transaction that owns the named payment id
            // (restrictive), never the amount of the refund another
            // transaction's key matched.
            amountIdr:
              facts.amountIdr ??
              Math.max(
                Number(owner.intent.amountIdr),
                owner.evidenceAmountIdr ?? 0,
              ),
            providerPaymentRef: namedPaymentId ?? null,
            refundStatus: facts.refundStatus,
            matchedRefundId: refund.id,
          },
          now,
        );
      // 1144: the first-pass hold of this event (minute 0) on the owner of
      // the named payment is still open: finance is told once.
      if (status === "succeeded" && owner && namedPaymentId)
        await announceFirstPassHoldOfIntent(
          context,
          owner.intent,
          {
            eventRowId: facts.refundId ? null : row.id,
            providerRefundId: facts.refundId ?? null,
            paymentRef: namedPaymentId,
          },
          now,
        );
      return await ignoredWith("REFERENCE_MISMATCH");
    }

    // 1101 (Q45), 1108 P1-1: automatic DOIT refunds are off, so a signed
    // event on a matched refund (success or failure, every match kind, payment
    // object included, valid or invalid payload) is never judged here: no
    // echo, made-up id or alias logic, no updater, recorder or status change
    // of the refund, only one conflict hold for the full value. One gate
    // before the invalid, updater and recorder paths, no exemption per branch.
    if (refundProviderSwitchedOff(PROVIDER)) {
      const switchedOffPaymentRef =
        facts.paymentId ??
        facts.payment?.id ??
        (await refundSourcePayment(context, refund, intent))?.providerRef ??
        intent.providerRef ??
        null;
      const evidence = switchedOffPaymentRef
        ? ((await findRefundCandidate(context, switchedOffPaymentRef))
            ?.evidenceAmountIdr ?? 0)
        : 0;
      await holdSwitchedOffRefundSuccess(
        context,
        row,
        intent,
        {
          providerPaymentRef: switchedOffPaymentRef,
          amountIdr: Math.max(Number(intent.amountIdr), evidence),
          alertRefundId: facts.refundId ?? null,
        },
        now,
      );
      // 1144: the first-pass hold of this refund id (minute 0) is raised by the
      // hold above or stays as it was; finance is told once, never closed here.
      if (status === "succeeded")
        await announceFirstPassHoldOfIntent(
          context,
          intent,
          {
            eventRowId: null,
            providerRefundId: facts.refundId ?? null,
            paymentRef: switchedOffPaymentRef,
          },
          now,
        );
      return await ignoredWith("REJECTED_CONFLICT");
    }

    // legend-2ol8g: an amount or payment_id that is there but unreadable (or
    // missing on the flat shape) must never settle: no amount or payment check
    // would run for it.
    if (facts.invalid) {
      // 1072 I8: a signed success matched to this refund that is no proven
      // echo (unreadable or missing amount or payment id) is held for the
      // refund's full amount, before anything is audited or ignored. The
      // payment id may be unreadable, so the transaction comes from the
      // refund's own source payment. The payment-object fallback is exempt
      // here (switch on only; with the switch off the gate above holds it).
      if (status === "succeeded" && match.kind !== "payment_object") {
        const paymentRef =
          (await refundSourcePayment(context, refund, intent))?.providerRef ??
          intent.providerRef;
        await withTenant(db, context, async (tx) =>
          fileOwnRefundSurplusHoldInTx(
            tx,
            context,
            {
              intentId: intent.id,
              outletId: intent.outletId,
              // Own key: the stand-in amount was never reported, so it must
              // not count as evidence already held for the real key (I7
              // `maxHeld`) and swallow a later readable report (1075 P1).
              // 1090 P1-2: made-up id, own kind (never a provider id).
              // 1090 P2: no refund id in the event: the identity is the
              // refund's own key, fixed, not a `providerRef` that a later
              // success fills in (a replay must find the same hold). Holds an
              // earlier build stored under that `providerRef` still count.
              providerRefundId: invalidReportHoldRefundId(
                facts.refundId ?? `refund:${refund.id}`,
              ),
              invalidReport: true,
              providerPaymentRef: paymentRef,
              amountIdr: Number(intent.amountIdr),
            },
            now,
          ),
        );
      }
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
    // 1072 I6: a refused success that is no proven echo is held in the very
    // transaction that holds the refund's locks (the updater commits it, then
    // throws the 409). The payment ref is read before, on its own connection.
    const holdPaymentRef =
      status === "succeeded" && match.kind !== "payment_object"
        ? (facts.paymentId ??
          facts.payment?.id ??
          (await refundSourcePayment(context, refund, intent))?.providerRef ??
          intent.providerRef)
        : null;
    // 1144: the updater refused a SMALLER amount of a refund already sent to
    // the provider (an echo, no surplus hold): R counts that money.
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
        async (tx, refusal) => {
          // One rule (I2, I9): a smaller reported amount stays an echo only of
          // a refund already sent to the provider; anything else refused here
          // is no echo of this refund.
          if (status !== "succeeded" || match.kind === "payment_object") return;
          if (
            refusal.kind === "amount_mismatch" &&
            refusal.sentToProvider &&
            facts.amountIdr !== undefined &&
            facts.amountIdr < Number(refusal.refund.amountIdr)
          ) {
            // 1144 round 2: no surplus hold for the echo itself; the hold of
            // minute 0 stays open here (see the refusal below).
            return;
          }
          await fileOwnRefundSurplusHoldInTx(
            tx,
            context,
            {
              intentId: refusal.intent.id,
              outletId: refusal.intent.outletId,
              // 1090 P2: fixed identity when the event names no refund id
              // (see the unreadable-report hold above).
              providerRefundId: facts.refundId ?? `refund:${refusal.refund.id}`,
              providerPaymentRef: holdPaymentRef,
              amountIdr: facts.amountIdr ?? Number(refusal.intent.amountIdr),
            },
            now,
          );
        },
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
        // 1144 round 2: the hold of the first pass (minute 0) is left as it
        // was, also for a smaller echo of our SENT refund R that is still
        // `approved`: R may yet fail, and then the provider may have paid the
        // echo on top. It is closed only when R itself ends successful (the
        // success of R below, `closeUnmatchedHoldOfMatchedRefund`). A hold
        // still open is announced once (same rule as 1139).
        if (status === "succeeded" && match.kind !== "payment_object")
          await announceFirstPassHoldOfIntent(
            context,
            intent,
            {
              eventRowId: row.id,
              providerRefundId: facts.refundId ?? null,
              paymentRef: holdPaymentRef,
            },
            now,
          );
        return await ignoredWith("REJECTED_CONFLICT");
      }
      if (error instanceof HttpError && error.status === 404)
        return await unmatched(false, intent);
      throw error;
    }
    if (status === "succeeded")
      await closeUnmatchedHoldOfMatchedRefund(
        context,
        row,
        refund,
        intent,
        facts.refundId ?? providerRef ?? null,
        facts.paymentId ??
          facts.payment?.id ??
          (await refundSourcePayment(context, refund, intent))?.providerRef ??
          intent.providerRef,
        now,
      );
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

/** Bounded `data` kept for a stored `payment.refunded` status object: only the
 * facts below, never the raw body. Re-reads to the same facts on a retry. */
function refundedStatusData(
  facts: DoitRefundedStatusFacts,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (facts.paymentId) data.payment_id = facts.paymentId;
  if (facts.refundId) data.refund_id = facts.refundId;
  if (facts.amountIdr !== undefined) data.amount = facts.amountIdr;
  return data;
}

/** Facts of a stored `payment.refunded` payload (its bounded `data`). */
function storedRefundedStatusFacts(payload: unknown): DoitRefundedStatusFacts {
  return readDoitRefundedStatusFacts(
    typeof payload === "object" && payload !== null
      ? (payload as { data?: unknown }).data
      : undefined,
  );
}

/**
 * legend-30hfs: `payment.refunded` whose `data` is a status object (a partial
 * refund notice), applied from its bounded facts. With a refund id, a payment
 * id and a positive amount the refund is recorded against the payment it names
 * (deduped by refund id, the echo of our own refund not counted). When the
 * payment binds to an intent but the refund id or amount is missing, the refund
 * may be the whole payment: treated as a full refund in doubt (the 958 flag,
 * which blocks allocation, refund and payout of the recorded money). A payment
 * we cannot bind keeps the old `ignored` answer. Nothing else is moved here.
 */
async function processRefundedStatusEvent(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  facts: DoitRefundedStatusFacts,
  now: Date,
  verifiedSecret?: string,
): Promise<ProcessOutcome> {
  try {
    const ignoredNotPayment = async (): Promise<ProcessOutcome> => {
      await markRow(
        context,
        row.id,
        {
          status: "ignored",
          lastErrorCode: "REFUND_PAYLOAD_NOT_PAYMENT",
          processedAt: now,
        },
        now,
      );
      return "ignored";
    };
    const { paymentId, refundId, amountIdr } = facts;
    if (!paymentId) return await ignoredNotPayment();
    const retryable =
      now.getTime() - row.receivedAt.getTime() <
      WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS;
    let applied: RefundApplyResult;
    if (refundId && amountIdr !== undefined && amountIdr > 0) {
      applied = await recordRefundFor(
        context,
        row,
        {
          providerRefundId: refundId,
          refundIdKind: "provider",
          providerPaymentRef: paymentId,
          amountIdr,
          source: "payment_webhook",
        },
        now,
        verifiedSecret,
      );
    } else
      applied = await flagRefundInDoubt(
        context,
        row,
        paymentId,
        now,
        verifiedSecret,
      );
    // A payment not bound yet may just be early, and an in-flight own refund
    // may settle: kept `failed` (retried by the worker) inside the window
    // (`retry` only comes back inside it, see `recordRefundFor`). `unbound`
    // then ends ignored.
    if (applied === "retry" || (applied === "unbound" && retryable)) {
      await markRow(
        context,
        row.id,
        { status: "failed", lastErrorCode: "UNKNOWN_REFERENCE" },
        now,
      );
      return "failed";
    }
    if (applied === "unbound") return await ignoredNotPayment();
    await markRow(
      context,
      row.id,
      {
        status: "processed",
        lastErrorCode: null,
        processedAt: now,
        providerRef: (refundId ?? paymentId).slice(0, 100),
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

/** `payment.refunded` whose `data` is not a payment object (no `id` and
 * `reference`, e.g. a partial-refund status object). It only ever records that
 * the provider gave money back and moves nothing here, so it is stored
 * `ignored` (200) instead of MALFORMED (a 5xx DOIT would resend forever). A
 * payment object that merely fails the strict schema stays MALFORMED. */
function isRefundedNonPaymentEvent(type: string, body: unknown): boolean {
  if (type !== "payment.refunded") return false;
  const data =
    typeof body === "object" && body !== null
      ? (body as { data?: unknown }).data
      : undefined;
  if (typeof data !== "object" || data === null) return true;
  const { id, reference } = data as { id?: unknown; reference?: unknown };
  return typeof id !== "string" || typeof reference !== "string";
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
  if (
    !parsedEvent &&
    envelope.success &&
    isRefundedNonPaymentEvent(envelope.data.type, json)
  ) {
    // `data` is not a payment: only the bounded refund facts are kept (never
    // the raw body). A readable payment id is processed; without one the row
    // stays ignored as before.
    const { id, type, created_at } = envelope.data;
    const facts = readDoitRefundedStatusFacts(
      (json as { data?: unknown }).data,
    );
    const stored = await insertRow(context, {
      integrationId: verified.integrationId,
      signatureValid: true,
      eventId: id,
      eventType: type,
      payloadHash,
      payload: { id, type, created_at, data: refundedStatusData(facts) },
      providerRef: facts.refundId ?? facts.paymentId ?? null,
      status: facts.paymentId ? "received" : "ignored",
      ...(facts.paymentId
        ? {}
        : { lastErrorCode: "REFUND_PAYLOAD_NOT_PAYMENT", processedAt: now }),
      receivedAt: now,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    });
    let refundedRow = stored;
    let toApply = facts;
    if (!refundedRow) {
      // A retry of the same event id: finished rows are a duplicate, an
      // unfinished one (`received` or `failed`) is processed from what it
      // stored.
      refundedRow = await loadVerifiedRow(context, verified.integrationId, id);
      if (!refundedRow)
        throw new Error("Webhook event conflicted without a winner");
      if (
        refundedRow.status === "processed" ||
        refundedRow.status === "ignored"
      )
        return { status: "duplicate", eventId: id };
      if (refundedRow.payload !== null)
        toApply = storedRefundedStatusFacts(refundedRow.payload);
    }
    if (!facts.paymentId && stored) return { status: "ignored", eventId: id };
    const outcome = await processRefundedStatusEvent(
      context,
      refundedRow,
      toApply,
      now,
      verified.secret,
    );
    return { status: outcome, eventId: id };
  }
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
        if (isRefundedNonPaymentEvent(event.type, row.payload)) {
          const outcome = await processRefundedStatusEvent(
            context,
            row,
            storedRefundedStatusFacts(row.payload),
            now,
            verified.secret,
          );
          return { status: outcome, eventId: event.id };
        }
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
      // legend-30hfs: a stored `payment.refunded` status object is applied from
      // its bounded facts; anything else unreadable stays MALFORMED.
      if (isRefundedNonPaymentEvent(row.eventType ?? "", row.payload)) {
        try {
          const outcome = await processRefundedStatusEvent(
            context,
            row,
            storedRefundedStatusFacts(row.payload),
            now,
            secrets.find((entry) => entry.integrationId === row.integrationId)
              ?.secret,
          );
          if (outcome !== "failed") processed += 1;
        } catch {
          // Already recorded on the row; the next run retries.
        }
        continue;
      }
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
