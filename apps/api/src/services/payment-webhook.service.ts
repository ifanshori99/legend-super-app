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
// agree, otherwise the row is `ignored` and nothing settles. Failures before
// the signature is verified all answer with the same UNAUTHORIZED error.

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
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  gatewayWebhookEvents,
  paymentEvidence,
  paymentIntents,
  paymentUnallocatedFunds,
  tenants,
  type GatewayWebhookEvent,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { applyGatewayFailure, confirmPayment } from "./payment.service";
import { decidePaymentConfirmation } from "./payment-lifecycle";
import {
  doitWebhookEventSchema,
  verifyDoitSignature,
} from "./payment-doit-wire";
import {
  listIntegrations,
  loadActiveIntegrationCredentials,
} from "./platform-integration.service";

const PROVIDER = "doit";
const SIGNATURE_MESSAGE = "Tanda tangan webhook tidak valid.";
/** Worker retry backoff: `min(2^attempts, 60)` minutes after the last
 * attempt, for events received within this window. Older rows that are still
 * `failed` stay `failed` for manual review. */
export const WEBHOOK_RETRY_WINDOW_MS = 24 * 3_600_000;
const WEBHOOK_RETRY_MAX_BACKOFF_MINUTES = 60;
/** An event for a reference we do not know yet may just be early (the intent
 * stores its provider ref after the create call): retried this long. */
export const WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS = 15 * 60_000;
const SECRET_CACHE_TTL_MS = 60_000;

export type WebhookResultStatus =
  "processed" | "duplicate" | "ignored" | "failed";

type DoitWebhookEvent = ReturnType<typeof doitWebhookEventSchema.parse>;
type ProcessOutcome = "processed" | "ignored" | "failed";
type PaymentIntentRow = typeof paymentIntents.$inferSelect;
type WebhookSecretEntry = { secret: string; integrationId: string };
type RowConflict = "event" | "rejected_hash";

function unauthorized(): CoreError {
  return new CoreError("UNAUTHORIZED", SIGNATURE_MESSAGE);
}

function tenantWideContext(tenantId: string): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "webhook",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

/** Error code only; a message could carry provider data (PAY-06). */
function errorCodeOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ? code
    : "INTERNAL_ERROR";
}

async function tenantIsActive(context: ScopedTenantContext): Promise<boolean> {
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
  const secrets = new Map<string, string>();
  for (const outletId of outletIds) {
    const loaded = await loadActiveIntegrationCredentials(
      context,
      PROVIDER,
      outletId,
    );
    if (!loaded) continue;
    const secret = loaded.credentials.webhookSecret;
    if (typeof secret === "string" && secret.length > 0 && !secrets.has(secret))
      secrets.set(secret, loaded.integration.id);
  }
  return [...secrets].map(([secret, integrationId]) => ({
    secret,
    integrationId,
  }));
}

const secretCache = new Map<
  string,
  { entries: WebhookSecretEntry[]; expiresAt: number }
>();

/** Tests rotate or add secrets between calls; production relies on the TTL. */
export function clearDoitWebhookSecretCache(): void {
  secretCache.clear();
}

/** Secrets cached 60 s per tenant so an unsigned flood does not hit the
 * credential store each time. An empty result is never cached. */
async function cachedWebhookSecrets(
  context: ScopedTenantContext,
): Promise<WebhookSecretEntry[]> {
  const key = context.tenant.tenantId;
  const hit = secretCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.entries;
  const entries = await loadWebhookSecrets(context);
  if (entries.length > 0)
    secretCache.set(key, {
      entries,
      expiresAt: Date.now() + SECRET_CACHE_TTL_MS,
    });
  else secretCache.delete(key);
  return entries;
}

function readableEventId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 && id.length <= 200
    ? id
    : null;
}

function readPaidAt(event: DoitWebhookEvent): string {
  const paidAt = (event.data as { paid_at?: unknown }).paid_at;
  for (const candidate of [paidAt, event.created_at]) {
    const parsed = isoDateTimeSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return new Date().toISOString();
}

/**
 * Amount the intent was settled for. The intent amount when the provider paid
 * exactly it, or, for a bank transfer, when it paid the transfer total and the
 * difference is exactly the unique code (3-6 digits, equal to the one stored
 * on the intent): the code is absorbed, not owed by the bill. Any other paid
 * amount is reported raw so the lifecycle flags the mismatch. `null` fails
 * closed.
 */
function settledAmount(
  event: DoitWebhookEvent,
  intent: PaymentIntentRow,
): number | null {
  const paid = event.data.paid_amount;
  if (paid === null || paid === undefined || !(paid > 0)) return null;
  const billed = Number(intent.amountIdr);
  if (paid === billed) return billed;
  const { transfer_amount: transfer, unique_code: code } = event.data;
  if (
    intent.method === "bank_transfer" &&
    typeof transfer === "number" &&
    paid === transfer &&
    typeof code === "string" &&
    /^\d{3,6}$/.test(code) &&
    transfer - billed === Number(code)
  ) {
    const stored = (intent.instructions as { uniqueCode?: unknown }).uniqueCode;
    if (
      stored === undefined ||
      stored === null ||
      Number(stored) === Number(code)
    )
      return billed;
  }
  return paid;
}

async function markRow(
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

/** The integration that verified the signature must be the one that owns the
 * outlet of the intent (outlet row wins over tenant row). */
async function signedByIntentIntegration(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  row: GatewayWebhookEvent,
  verifiedSecret: string | undefined,
): Promise<boolean> {
  const loaded = await loadActiveIntegrationCredentials(
    context,
    PROVIDER,
    intent.outletId,
  );
  if (!loaded) return false;
  if (row.integrationId !== null && loaded.integration.id === row.integrationId)
    return true;
  const secret = loaded.credentials.webhookSecret;
  return (
    verifiedSecret !== undefined &&
    typeof secret === "string" &&
    secret === verifiedSecret
  );
}

/**
 * Money arrived that cannot settle the intent: the intent is already closed as
 * failed (nothing revives it, lifecycle rule) or the paid amount does not match
 * the bill (AMOUNT_MISMATCH). The funds are recorded once, keyed by the
 * provider transaction, as unallocated funds for the existing refund or credit
 * review. Reason: `overpayment` when more than the bill was paid, otherwise
 * `double_payment` (the closest existing value: money that cannot be
 * allocated to this bill). The payment evidence row makes a replay a no-op.
 */
async function recordUnsettledFunds(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  event: DoitWebhookEvent,
  now: Date,
): Promise<void> {
  const paid = event.data.paid_amount;
  if (paid === null || paid === undefined || !(paid > 0)) return;
  const receivedAt = new Date(readPaidAt(event));
  const reason =
    paid > Number(intent.amountIdr) ? "overpayment" : "double_payment";
  await withTenant(db, context, async (tx) => {
    const [inserted] = await tx
      .insert(paymentEvidence)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId,
        paymentIntentId: intent.id,
        provider: PROVIDER,
        providerRef: event.data.id,
        method: intent.method,
        source: "verified_webhook",
        amountIdr: idr(paid),
        receivedAt,
      })
      .onConflictDoNothing({
        target: [
          paymentEvidence.tenantId,
          paymentEvidence.provider,
          paymentEvidence.providerRef,
        ],
      })
      .returning({ id: paymentEvidence.id });
    if (!inserted) return;
    await tx.insert(paymentUnallocatedFunds).values({
      tenantId: context.tenant.tenantId,
      outletId: intent.outletId,
      paymentIntentId: intent.id,
      amountIdr: idr(paid),
      reason,
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: intent.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "payment.closed_intent_funds_flagged",
        objectType: "payment_intent",
        objectId: intent.id,
        reason: null,
        maskedChanges: {
          before: { status: intent.status },
          after: {
            status: intent.status,
            unallocatedIdr: paid,
            providerRef: event.data.id,
          },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: now.toISOString(),
      },
      ["status", "unallocatedIdr", "providerRef"],
    );
  });
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
  // Money that arrived but cannot settle is never dropped.
  if (
    fresh.status === "failed" ||
    (decision.kind === "reject" && decision.code === "AMOUNT_MISMATCH")
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
async function processStoredEvent(
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
      event.data.amount !== Number(intent.amountIdr) ||
      !(await signedByIntentIntegration(context, intent, row, verifiedSecret))
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
      const amountIdr = settledAmount(event, intent);
      if (amountIdr === null) {
        // Fail closed: no paid amount proves nothing about the money. Kept
        // `failed` (visible for manual review, retried by the worker) because
        // DOIT may resend the event with an amount.
        outcome = "failed";
        code = "AMOUNT_MISSING";
      } else {
        const at = readPaidAt(event);
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
    } else if (status === "failed" || status === "cancelled") {
      await applyGatewayFailure(context, intent.id, "failed", now);
    }
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

async function insertRow(
  context: ScopedTenantContext,
  values: Omit<
    typeof gatewayWebhookEvents.$inferInsert,
    "tenantId" | "provider"
  >,
  conflict: RowConflict = "event",
): Promise<GatewayWebhookEvent | null> {
  return withTenant(db, context, async (tx) => {
    const [inserted] = await tx
      .insert(gatewayWebhookEvents)
      .values({
        ...values,
        tenantId: context.tenant.tenantId,
        provider: PROVIDER,
      })
      // Verified rows dedupe by provider event id; rejected rows (no event
      // id) by payload hash, so replayed garbage stores one row only.
      .onConflictDoNothing(
        conflict === "event"
          ? {
              target: [
                gatewayWebhookEvents.tenantId,
                gatewayWebhookEvents.provider,
                gatewayWebhookEvents.eventId,
              ],
              where: sql`${gatewayWebhookEvents.signatureValid} AND ${gatewayWebhookEvents.eventId} IS NOT NULL`,
            }
          : {
              target: [
                gatewayWebhookEvents.tenantId,
                gatewayWebhookEvents.payloadHash,
              ],
              where: sql`NOT ${gatewayWebhookEvents.signatureValid}`,
            },
      )
      .returning();
    return inserted ?? null;
  });
}

async function loadVerifiedRow(
  context: ScopedTenantContext,
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
 * tenant without a DOIT secret, bad signature), VALIDATION_ERROR for a
 * verified but malformed payload and a 500 when processing failed (the stored
 * row is retried; DOIT retries as well).
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

  const entries = await cachedWebhookSecrets(context);
  if (entries.length === 0) throw unauthorized();

  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  const verified = entries.find((entry) =>
    verifyDoitSignature({
      rawBody: input.rawBody,
      header: input.signatureHeader,
      secrets: [entry.secret],
      now,
    }),
  );
  if (!verified) {
    await insertRow(
      context,
      {
        signatureValid: false,
        status: "rejected",
        payloadHash,
        eventId: null,
        payload: null,
        receivedAt: now,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      },
      "rejected_hash",
    );
    throw unauthorized();
  }

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody.toString("utf8"));
  } catch {
    json = undefined;
  }
  const parsed = doitWebhookEventSchema.safeParse(json);
  if (!parsed.success) {
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
    throw new CoreError("VALIDATION_ERROR", "Payload webhook tidak valid.");
  }
  const event = parsed.data;

  // STORE FIRST: a retry of the same event id hits the unique index.
  let row = await insertRow(context, {
    integrationId: verified.integrationId,
    signatureValid: true,
    eventId: event.id,
    eventType: event.type.slice(0, 60),
    payloadHash,
    // The schema-validated event, never the raw JSON with unknown fields.
    payload: event as unknown as Record<string, unknown>,
    providerRef: event.data.id.slice(0, 100),
    status: "received",
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  if (!row) {
    row = await loadVerifiedRow(context, event.id);
    if (!row) throw new Error("Webhook event conflicted without a winner");
    if (row.status === "processed" || row.status === "ignored")
      return { status: "duplicate", eventId: event.id };
    // `received` or `failed`: the earlier delivery never finished, retry it.
  }
  const outcome = await processStoredEvent(
    context,
    row,
    event,
    now,
    verified.secret,
  );
  return { status: outcome, eventId: event.id };
}

/**
 * Worker retry path: stored, verified events that stayed `received` or
 * `failed` (the request died or processing failed) whose backoff is due, for
 * 24 h after receipt. Per-event failures are skipped; the next run retries.
 */
export async function reprocessStoredWebhookEvents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
): Promise<{ checked: number; processed: number }> {
  const windowStart = new Date(now.getTime() - WEBHOOK_RETRY_WINDOW_MS);
  // Next attempt is due `min(2^attempts, 60)` minutes after the last one.
  const backoff = sql`least(power(2, least(${gatewayWebhookEvents.attempts}, 6)), ${WEBHOOK_RETRY_MAX_BACKOFF_MINUTES}) * interval '1 minute'`;
  const rows = await withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(gatewayWebhookEvents)
      .where(
        and(
          eq(gatewayWebhookEvents.tenantId, context.tenant.tenantId),
          eq(gatewayWebhookEvents.provider, PROVIDER),
          eq(gatewayWebhookEvents.signatureValid, true),
          inArray(gatewayWebhookEvents.status, ["received", "failed"]),
          isNotNull(gatewayWebhookEvents.payload),
          gt(gatewayWebhookEvents.receivedAt, windowStart),
          sql`${gatewayWebhookEvents.updatedAt} + ${backoff} <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(gatewayWebhookEvents.receivedAt))
      .limit(limit),
  );
  let processed = 0;
  const secrets = rows.length > 0 ? await cachedWebhookSecrets(context) : [];
  for (const row of rows) {
    const parsed = doitWebhookEventSchema.safeParse(row.payload);
    if (!parsed.success) {
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
        parsed.data,
        now,
        verifiedSecret,
      );
      if (outcome !== "failed") processed += 1;
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
