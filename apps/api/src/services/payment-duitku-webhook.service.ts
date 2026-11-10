// Duitku callback intake (sub-brief 302, Slice D; design D18, D20-D22).
//
// Duitku posts a form to `POST /api/webhooks/payments/duitku/:tenantId`. The
// signature covers only merchantCode, amount and merchantOrderId: `resultCode`
// is NOT signed, and there is no timestamp. So a verified callback proves the
// sender knows the key, never that the order was paid. Order of work:
//
// 1. bind the callback to an intent of this tenant (merchantOrderId is the
//    intent id) and verify the signature with the credentials of the
//    integration that minted it (current key, plus the previous one while in
//    its rotation grace);
// 2. STORE the callback in `gateway_webhook_events` (a retry of the same
//    event id is a no-op);
// 3. process: ignore `resultCode`, ask Duitku `transactionStatus` with the
//    minting credentials and act on that answer. Money moves only on a paid
//    answer whose reference is the intent's own, through `confirmPayment`, so
//    late payment, double payment and amount mismatch follow the same rules as
//    every other gateway (D20).
//
// Every failure before the signature is verified answers with the same
// UNAUTHORIZED error. A rejected delivery keeps only a counter row (hash, no
// payload). The form body, the signature and the API key are never logged.

import { createHash } from "node:crypto";
import {
  CoreError,
  tenantIdSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  gatewayWebhookEvents,
  paymentIntents,
  type GatewayWebhookEvent,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import {
  applyGatewayFailure,
  confirmPayment,
  PaymentConfirmationRejected,
  recordUnsettledGatewayFunds,
} from "./payment.service";
import { plausiblePaidAt } from "./payment-paid-at";
import {
  duitkuTransactionStatus,
  parseDuitkuCallback,
  verifyDuitkuCallback,
  type DuitkuCallbackFields,
  type DuitkuTransactionStatus,
} from "./payment-duitku-wire";
import { duitkuCredentialSet } from "./payment-duitku";
import {
  errorCodeOf,
  markRow,
  recordRejectedAttempt,
  tenantIsActive,
  tenantWideContext,
  WEBHOOK_RETRY_WINDOW_MS,
  WEBHOOK_UNKNOWN_REFERENCE_RETRY_MS,
  type WebhookResultStatus,
} from "./payment-webhook.service";
import { loadIntegrationCredentialsById } from "./platform-integration.service";

const PROVIDER = "duitku";
const SIGNATURE_MESSAGE = "Tanda tangan webhook tidak valid.";
const RESULT_CODES: ReadonlySet<string> = new Set(["00", "01", "02"]);
const MAX_FORM_FIELDS = 20;
const WEBHOOK_RETRY_MAX_BACKOFF_MINUTES = 60;

type PaymentIntentRow = typeof paymentIntents.$inferSelect;
type ProcessOutcome = "processed" | "ignored" | "failed";
type DuitkuFetch = typeof fetch;
/** Resolved at call time, so a test can stub the global. */
const globalFetch: DuitkuFetch = (...args) => fetch(...args);

function unauthorized(): CoreError {
  return new CoreError("UNAUTHORIZED", SIGNATURE_MESSAGE);
}

/** Form body -> flat string map. Null for a repeated key, too many fields or
 * a body that is not UTF-8 text: a repeated key would let two readers of the
 * same body disagree about which value was signed. */
function parseForm(rawBody: Buffer): Record<string, string> | null {
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let count = 0;
  for (const [key, value] of new URLSearchParams(rawBody.toString("utf8"))) {
    count += 1;
    if (count > MAX_FORM_FIELDS || key in fields) return null;
    fields[key] = value;
  }
  return count === 0 ? null : { ...fields };
}

function eventIdOf(fields: DuitkuCallbackFields): string {
  return `${fields.merchantOrderId}:${fields.reference ?? "-"}:${fields.resultCode}`;
}

async function loadIntent(
  context: ScopedTenantContext,
  intentId: string,
): Promise<PaymentIntentRow | null> {
  return withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
          eq(paymentIntents.provider, PROVIDER),
        ),
      )
      .limit(1);
    return found ?? null;
  });
}

async function loadRow(
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

/** The fields a stored row keeps (never the signature). */
function storedFields(payload: unknown): DuitkuCallbackFields | null {
  if (typeof payload !== "object" || payload === null) return null;
  // The signature is not stored; parse only needs a placeholder for it.
  return parseDuitkuCallback({
    ...(payload as Record<string, unknown>),
    signature: "stored",
  });
}

/**
 * Asks Duitku about the order with the credentials that minted it: current
 * first, then the previous generation while in grace (an order minted under
 * the previous merchant code is unknown to the current one, D18). An answer
 * about another Duitku payment (reference differs) never counts.
 */
async function askStatus(
  intent: PaymentIntentRow,
  credentials: ReturnType<typeof duitkuCredentialSet>,
  fetchImpl: DuitkuFetch,
): Promise<
  | { kind: "answer"; answer: DuitkuTransactionStatus }
  | { kind: "mismatch" }
  | { kind: "error"; error: unknown }
> {
  let result: { kind: "mismatch" } | { kind: "error"; error: unknown } = {
    kind: "error",
    error: new CoreError("SERVICE_UNAVAILABLE", "Duitku status unavailable."),
  };
  for (const creds of credentials) {
    try {
      const answer = await duitkuTransactionStatus({
        creds,
        merchantOrderId: intent.id,
        fetch: fetchImpl,
      });
      if (answer.reference !== intent.providerRef) {
        result = { kind: "mismatch" };
        continue;
      }
      return { kind: "answer", answer };
    } catch (error) {
      result = { kind: "error", error };
    }
  }
  return result;
}

/** A paid answer the lifecycle refused: an underpayment is parked as
 * unallocated funds (keyed by the provider reference, so a poll sees the same
 * row), any other refusal is only recorded on the row. */
async function handleRejectedConfirmation(
  context: ScopedTenantContext,
  intent: PaymentIntentRow,
  providerRef: string,
  paidAmountIdr: number,
  at: string,
  error: HttpError,
  now: Date,
): Promise<string> {
  const decision =
    error instanceof PaymentConfirmationRejected
      ? error.decisionCode
      : "CONFLICT";
  if (decision === "AMOUNT_MISMATCH")
    await recordUnsettledGatewayFunds(
      context,
      intent,
      {
        provider: PROVIDER,
        providerRef,
        source: "verified_webhook",
        paidAmountIdr,
        receivedAt: new Date(at),
      },
      now,
    );
  return `REJECTED_${decision}`;
}

/**
 * Applies one stored, verified callback. Used by the request and by the worker
 * retry. Gateway trouble (status call failed, still pending at Duitku) leaves
 * the row `failed` for the worker; only an unexpected error throws (503).
 */
async function processStoredCallback(
  context: ScopedTenantContext,
  row: GatewayWebhookEvent,
  now: Date,
  fetchImpl: DuitkuFetch,
): Promise<ProcessOutcome> {
  try {
    const fields = storedFields(row.payload);
    const intent = fields
      ? await loadIntent(context, fields.merchantOrderId)
      : null;
    if (!fields || !intent) {
      await markRow(
        context,
        row.id,
        {
          status: "ignored",
          lastErrorCode: "UNKNOWN_REFERENCE",
          processedAt: now,
        },
        now,
      );
      return "ignored";
    }
    if (intent.providerRef === null) {
      // The provider ref is stored after the create call: may just be early.
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
    const bound = { paymentIntentId: intent.id, outletId: intent.outletId };
    if (
      fields.reference !== undefined &&
      fields.reference !== intent.providerRef
    ) {
      await markRow(
        context,
        row.id,
        {
          status: "ignored",
          lastErrorCode: "REFERENCE_MISMATCH",
          processedAt: now,
          ...bound,
        },
        now,
      );
      return "ignored";
    }
    const loaded =
      intent.gatewayIntegrationId === null
        ? null
        : await loadIntegrationCredentialsById(
            context,
            PROVIDER,
            intent.gatewayIntegrationId,
          );
    const credentials = loaded ? duitkuCredentialSet(loaded, now) : [];
    if (credentials.length === 0) {
      await markRow(
        context,
        row.id,
        { status: "failed", lastErrorCode: "NO_CREDENTIALS", ...bound },
        now,
      );
      return "failed";
    }

    // resultCode is unsigned: the status answer is the only truth.
    const asked = await askStatus(intent, credentials, fetchImpl);
    if (asked.kind !== "answer") {
      const mismatch = asked.kind === "mismatch";
      await markRow(
        context,
        row.id,
        mismatch
          ? {
              status: "ignored",
              lastErrorCode: "REFERENCE_MISMATCH",
              processedAt: now,
              ...bound,
            }
          : {
              status: "failed",
              lastErrorCode: errorCodeOf(asked.error),
              ...bound,
            },
        now,
      );
      return mismatch ? "ignored" : "failed";
    }
    const { answer } = asked;
    let outcome: ProcessOutcome = "processed";
    let code: string | null = null;
    if (answer.status === "paid") {
      const at = plausiblePaidAt(null, intent.createdAt, now);
      try {
        await confirmPayment(
          context,
          intent.id,
          {
            source: "verified_webhook",
            method: intent.method,
            amountIdr: answer.amountIdr,
            providerRef: intent.providerRef,
            at,
          },
          { type: "system" },
          now,
        );
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409) throw error;
        outcome = "ignored";
        code = await handleRejectedConfirmation(
          context,
          intent,
          intent.providerRef,
          answer.amountIdr,
          at,
          error,
          now,
        );
      }
    } else if (answer.status === "pending") {
      // Duitku has not settled it (yet): retried by the worker.
      outcome = "failed";
      code = "PENDING_AT_PROVIDER";
    } else {
      await applyGatewayFailure(
        context,
        intent.id,
        now.getTime() >= intent.expiresAt.getTime() ? "expired" : "failed",
        now,
      );
    }
    await markRow(
      context,
      row.id,
      {
        status: outcome,
        lastErrorCode: code,
        processedAt: outcome === "failed" ? null : now,
        providerRef: intent.providerRef,
        ...bound,
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
    // Duitku retries on a 5xx; nothing about the cause leaves the server.
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
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
      // Verified rows dedupe by event id.
      .onConflictDoNothing({
        target: [
          gatewayWebhookEvents.tenantId,
          gatewayWebhookEvents.provider,
          gatewayWebhookEvents.eventId,
        ],
        where: sql`${gatewayWebhookEvents.signatureValid} AND ${gatewayWebhookEvents.eventId} IS NOT NULL`,
      })
      .returning();
    return inserted ?? null;
  });
}

/**
 * Receives one Duitku callback. Throws UNAUTHORIZED (one message, no oracle)
 * for every failure before the signature is verified: unknown or inactive
 * tenant, unreadable form, unknown order, wrong merchant, bad signature or
 * amount. A 503 means the callback could not be stored or processed and Duitku
 * should retry. Everything else is stored and answered with a status.
 */
export async function receiveDuitkuCallback(input: {
  tenantId: string;
  rawBody: Buffer;
  now?: Date;
  /** Test seam: the HTTP client for `transactionStatus`. */
  fetch?: DuitkuFetch;
}): Promise<{ status: WebhookResultStatus; eventId: string }> {
  const now = input.now ?? new Date();
  const parsedTenant = tenantIdSchema.safeParse(input.tenantId);
  if (!parsedTenant.success) throw unauthorized();
  const context = tenantWideContext(parsedTenant.data);
  if (!(await tenantIsActive(context))) throw unauthorized();

  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");
  const reject = async (): Promise<never> => {
    await recordRejectedAttempt(context, payloadHash, now, PROVIDER);
    throw unauthorized();
  };

  const form = parseForm(input.rawBody);
  const fields = form ? parseDuitkuCallback(form) : null;
  const intentId = uuidSchema.safeParse(fields?.merchantOrderId);
  if (!fields || !intentId.success || !RESULT_CODES.has(fields.resultCode))
    return reject();
  const intent = await loadIntent(context, intentId.data);
  if (!intent || intent.gatewayIntegrationId === null) return reject();
  const loaded = await loadIntegrationCredentialsById(
    context,
    PROVIDER,
    intent.gatewayIntegrationId,
  );
  const credentials = loaded ? duitkuCredentialSet(loaded, now) : [];
  if (credentials.length === 0) return reject();
  // `amount_mismatch` is not a rejection: the signature held, and the status
  // answer (never the callback amount) decides what the money is.
  const verdict = verifyDuitkuCallback({
    creds: credentials,
    fields,
    expectedAmountIdr: Number(intent.amountIdr),
  });
  if (!verdict.ok && verdict.reason !== "amount_mismatch") return reject();

  const eventId = eventIdOf(fields);
  // Never the signature: it is not needed again.
  const { signature: _signature, ...payload } = fields;
  void _signature;
  let row = await insertRow(context, {
    integrationId: intent.gatewayIntegrationId,
    outletId: intent.outletId,
    paymentIntentId: intent.id,
    signatureValid: true,
    eventId,
    eventType: `callback.${fields.resultCode}`,
    payloadHash,
    payload: payload as Record<string, unknown>,
    providerRef: fields.reference ?? null,
    status: "received",
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  if (!row) {
    row = await loadRow(context, eventId);
    if (!row) throw new Error("Webhook event conflicted without a winner");
    if (row.status === "processed" || row.status === "ignored")
      return { status: "duplicate", eventId };
    // `received` or `failed`: the earlier delivery never finished, retry it.
  }
  const outcome = await processStoredCallback(
    context,
    row,
    now,
    input.fetch ?? globalFetch,
  );
  return { status: outcome, eventId };
}

/**
 * Worker retry path: stored, verified callbacks still `received` or `failed`
 * whose backoff is due, for 24 h after receipt (same rule as DOIT's).
 */
export async function reprocessDuitkuWebhookEvents(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 100,
  fetchImpl?: DuitkuFetch,
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
  for (const row of rows) {
    try {
      const outcome = await processStoredCallback(
        context,
        row,
        now,
        fetchImpl ?? globalFetch,
      );
      if (outcome !== "failed") processed += 1;
    } catch {
      // Already recorded on the row; the next run retries.
    }
  }
  return { checked: rows.length, processed };
}
