// DOIT recurring billing service (bead 6c6; PRD recurring billing).
//
// Money rules ("jangan sampai rugi"):
//   - The plan price is server truth (`payment_recurring_plans.amount_idr`).
//     An invoice whose amount (or plan) differs is stored as `needs_review`
//     with an error code, never notified and never able to activate.
//   - A subscription turns `active` ONLY from a verified `invoice.paid` event
//     whose payload status is `paid`, whose amount equals the stored invoice
//     and the plan price, and whose stored invoice was `open`. Never from
//     `invoice.created`, never from an API call of this file.
//   - Money that arrives where no access may be granted (cancelled or paused
//     subscription, void/expired invoice, amount mismatch) is kept visible as
//     `needs_review`; it never reactivates anything.
//   - Replays are harmless: invoice rows are unique per provider invoice id and
//     per open/paid period, `notified_at` is set once in the same transaction
//     as the outbox row, and a paid replay never advances the period twice.
//   - The invoice period must match the plan interval and continue the
//     subscription (PERIOD_MISMATCH); a second invoice for a period already
//     open/paid is kept as `needs_review` (DUPLICATE_PERIOD), never dropped.
//   - Only the integration that created the plan may speak for its
//     subscriptions (`gateway_integration_id`, INTEGRATION_MISMATCH).
//   - A start is stored (`provisioning`) before DOIT is called and retried with
//     the same reference; an unconfirmed outcome is `needs_reconcile`. Neither
//     status notifies or activates. A pause/resume/cancel answer that does not
//     confirm the action is `needs_reconcile` too, never success.
//   - A paid period that starts later than today waits in `next_period_*` and
//     replaces the current one on its start date (`promoteDueSubscriptionPeriods`);
//     `subscriptionHasAccess` checks both bounds of the period that covers today.
//   - Grace (per outlet, default 3, 0..30): an `active` row keeps access for
//     the grace days after its paid period; that use counts toward the NEXT
//     period (`subscriptionAccessPeriod`), never extra quota, never past the
//     grace days. The overdue worker reads the same per-outlet value. The
//     access check takes the grace days as a required argument (no default):
//     a caller must read the outlet value (`readRecurringGraceDays`), so a
//     hard-coded 3 can never grant access an outlet with grace 0 refused.
//
// Webhook signature and store-first dedupe live in payment-webhook.service.ts;
// `processDoitInvoiceEvent` only applies an already verified event. The
// tenant comes from the webhook URL, the subscription is found by
// (tenant, provider subscription id): an unknown one creates nothing.
// Permission checks are the route's job (`requireOutletPermission`); the
// outlet scope of the context is enforced here.

import { randomUUID } from "node:crypto";
import {
  CoreError,
  assertOutletInScope,
  idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { subscriptionInvoiceCreatedEvent } from "@starter/shared/notification";
import {
  RECURRING_GRACE_DAYS_MAX,
  RECURRING_GRACE_DAYS_MIN,
} from "@starter/shared/payment/recurring";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db";
import { customerProfiles } from "../db/schema/crm-member";
import {
  paymentRecurringOutletSettings,
  paymentRecurringPlans,
  paymentRecurringSubscriptions,
  subscriptionInvoices,
  type PaymentRecurringPlan,
  type PaymentRecurringSubscription,
  type RecurringPlanInterval,
  type RecurringPlanStatus,
  type RecurringSubscriptionStatus,
  type SubscriptionInvoice,
} from "../db/schema/payment-recurring";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import { revokeSubscriptionGrace } from "./facility-subscription-quota";
import { appendNotificationEvent } from "./notification-events";
import {
  createDoitRecurringClient,
  type DoitRecurringClient,
} from "./payment-doit-recurring";
import {
  doitSubscriptionActionConfirmed,
  type DoitInvoiceEvent,
  type DoitRecurringSubscription,
} from "./payment-doit-recurring-wire";
import {
  loadActiveIntegrationCredentials,
  loadIntegrationCredentialsById,
} from "./platform-integration.service";
import type { Tx } from "./permission-resolver";

const PROVIDER = "doit";
const JAKARTA_OFFSET_MS = 7 * 3_600_000;

/** What the client is for. `bill` (a new plan, start, resume) can make DOIT
 * charge: the integration must be `active`, otherwise its webhook secret is
 * not loaded and every payment event would be refused. `stop` (pause, cancel)
 * only ends billing: any integration status, and a provider withdrawn from the
 * tenant plan still works (the tenant must always be able to stop a charge). */
export type RecurringClientPurpose = "bill" | "stop";

/** `integrationId` set: the client of exactly that integration (an existing
 * plan or subscription stays on the account that created it). Null: the
 * outlet's active integration (a new plan). */
export type RecurringClientLoader = (
  context: ScopedTenantContext,
  outletId: string,
  integrationId?: string | null,
  purpose?: RecurringClientPurpose,
) => Promise<DoitRecurringClient>;

/** Test seam: a fake DOIT client instead of the stored credentials. */
export type RecurringDeps = { clientFor?: RecurringClientLoader };

/** Integration id behind each client built from the stored credentials. */
const clientIntegrationIds = new WeakMap<DoitRecurringClient, string>();

async function defaultClientFor(
  context: ScopedTenantContext,
  outletId: string,
  integrationId?: string | null,
  purpose: RecurringClientPurpose = "bill",
): Promise<DoitRecurringClient> {
  // Kill switch (legend-ww562): the HTTP route gates it too, but a job or
  // consumer calls the service directly. Every DOIT call goes through here.
  if (!env.DOIT_RECURRING_ENABLED)
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Penagihan berulang sedang dinonaktifkan.",
    );
  const loaded = integrationId
    ? await loadIntegrationCredentialsById(
        context,
        PROVIDER,
        integrationId,
        purpose === "stop" ? { forStoredIntent: true } : {},
      )
    : await loadActiveIntegrationCredentials(context, PROVIDER, outletId);
  const apiKey = loaded?.credentials.apiKey;
  if (!loaded || !apiKey)
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Penagihan berulang belum dikonfigurasi.",
    );
  // A disabled or draft integration would let DOIT charge while its webhook
  // secret is not loaded: refuse before any call (stop calls are exempt).
  if (purpose === "bill" && loaded.integration.status !== "active")
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Integrasi penagihan berulang tidak aktif.",
    );
  const baseUrl = loaded.integration.config.baseUrl;
  const client = createDoitRecurringClient({
    apiKey,
    baseUrl: typeof baseUrl === "string" ? baseUrl : null,
    integrationId: loaded.integration.id,
  });
  clientIntegrationIds.set(client, loaded.integration.id);
  return client;
}

/** The integration a plan is created on. A client from the test seam carries
 * no id: the active integration of the outlet is read instead. */
async function integrationIdOf(
  context: ScopedTenantContext,
  outletId: string,
  client: DoitRecurringClient,
): Promise<string> {
  const known = clientIntegrationIds.get(client);
  if (known) return known;
  const loaded = await loadActiveIntegrationCredentials(
    context,
    PROVIDER,
    outletId,
  );
  if (!loaded)
    throw new CoreError(
      "SERVICE_UNAVAILABLE",
      "Penagihan berulang belum dikonfigurasi.",
    );
  return loaded.integration.id;
}

const clientLoader = (deps?: RecurringDeps): RecurringClientLoader =>
  deps?.clientFor ?? defaultClientFor;

function notFound(what: string): CoreError {
  return new CoreError("NOT_FOUND", `${what} tidak ditemukan.`);
}

/** Business date (Asia/Jakarta) of an instant, `YYYY-MM-DD`. */
function businessDateOf(now: Date): string {
  return new Date(now.getTime() + JAKARTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Instant at which the business date `YYYY-MM-DD` (Asia/Jakarta) starts. */
export function businessDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+07:00`);
}

/** `YYYY-MM-DD` plus one plan interval: a week is 7 days, a month is one
 * calendar month with the day clamped to the month end (Jan 31 -> Feb 28),
 * like Postgres `date + interval '1 month'`. */
export function addInterval(
  date: string,
  interval: RecurringPlanInterval,
): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  if (interval === "week")
    return new Date(Date.UTC(year, month - 1, day + 7))
      .toISOString()
      .slice(0, 10);
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)))
    .toISOString()
    .slice(0, 10);
}

/** PERIOD_MISMATCH when the period is not exactly one plan interval, or does
 * not start where the paid period of the subscription ends. */
function periodMismatch(
  plan: PaymentRecurringPlan,
  subscription: PaymentRecurringSubscription,
  periodStart: string,
  periodEnd: string,
): boolean {
  if (periodEnd !== addInterval(periodStart, plan.interval)) return true;
  // A paid period waiting for its start date is the end of what is covered.
  const boundary = subscription.nextPeriodEnd ?? subscription.currentPeriodEnd;
  return boundary !== null && periodStart !== boundary;
}

// -- Plans --------------------------------------------------------------------

export type CreateRecurringPlanInput = {
  outletId: string;
  name: string;
  /** Whole rupiah, above zero. */
  amountIdr: number;
  interval: RecurringPlanInterval;
  /** Idempotency key of the caller (header); also keys the DOIT call. */
  idempotencyKey: string;
};

/** Creates the plan at DOIT first, then stores it. The price DOIT reports must
 * equal the requested one, otherwise nothing is stored. */
export async function createRecurringPlan(
  context: ScopedTenantContext,
  input: CreateRecurringPlanInput,
  deps?: RecurringDeps,
): Promise<PaymentRecurringPlan> {
  assertOutletInScope(context.outletScope, input.outletId);
  if (!Number.isSafeInteger(input.amountIdr) || input.amountIdr <= 0)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Harga paket harus lebih dari nol.",
    );
  const name = input.name.trim();
  if (name.length === 0 || name.length > 120)
    throw new CoreError("VALIDATION_ERROR", "Nama paket tidak valid.");

  const client = await clientLoader(deps)(context, input.outletId);
  const provider = await client.createPlan(
    { name, amountIdr: input.amountIdr, interval: input.interval },
    `plan:${context.tenant.tenantId}:${input.idempotencyKey}`,
  );
  if (
    provider.amount !== input.amountIdr ||
    provider.interval !== input.interval
  )
    throw new CoreError(
      "CONFLICT",
      "Paket di gateway tidak sesuai dengan permintaan.",
    );

  const gatewayIntegrationId = await integrationIdOf(
    context,
    input.outletId,
    client,
  );

  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [inserted] = await tx
      .insert(paymentRecurringPlans)
      .values({
        tenantId,
        outletId: input.outletId as OutletId,
        provider: PROVIDER,
        providerPlanId: provider.id,
        gatewayIntegrationId,
        name,
        amountIdr: idr(input.amountIdr),
        interval: input.interval,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // Same provider plan id again (a retried request): return what is stored,
    // but only when it says the same thing.
    const [existing] = await tx
      .select()
      .from(paymentRecurringPlans)
      .where(
        and(
          eq(paymentRecurringPlans.tenantId, tenantId),
          eq(paymentRecurringPlans.provider, PROVIDER),
          eq(paymentRecurringPlans.providerPlanId, provider.id),
        ),
      );
    if (
      !existing ||
      existing.outletId !== input.outletId ||
      existing.gatewayIntegrationId !== gatewayIntegrationId ||
      existing.amountIdr !== input.amountIdr ||
      existing.interval !== input.interval
    )
      throw new CoreError("CONFLICT", "Paket sudah ada dengan data berbeda.");
    return existing;
  });
}

export async function listRecurringPlans(
  context: ScopedTenantContext,
  filter: { outletId?: string; status?: RecurringPlanStatus } = {},
): Promise<PaymentRecurringPlan[]> {
  if (filter.outletId)
    assertOutletInScope(context.outletScope, filter.outletId);
  return withTenant(db, context, async (tx) =>
    tx
      .select()
      .from(paymentRecurringPlans)
      .where(
        and(
          eq(paymentRecurringPlans.tenantId, context.tenant.tenantId),
          filter.outletId
            ? eq(paymentRecurringPlans.outletId, filter.outletId as OutletId)
            : undefined,
          filter.status
            ? eq(paymentRecurringPlans.status, filter.status)
            : undefined,
        ),
      )
      .orderBy(asc(paymentRecurringPlans.name), asc(paymentRecurringPlans.id)),
  );
}

// -- Subscriptions --------------------------------------------------------------

export type StartSubscriptionInput = {
  planId: string;
  customerProfileId: string;
  idempotencyKey: string;
};

const KEY_REUSED = (): CoreError =>
  new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "Kunci permintaan sudah dipakai untuk permintaan lain.",
  );

/** Unique violation (SQLSTATE 23505), also when the driver error is wrapped. */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1)
  );
}

/** A start older than this is never retried automatically: DOIT's idempotency
 * window may be over and a retry could create a second subscription. */
const START_RETRY_WINDOW_MS = 24 * 3_600_000;

/** Extra time past the retry window before the reconcile tool treats an
 * expired start as abandoned: a start retry that is still running at the edge
 * of the window must not race a reconcile that cancels it. */
const EXPIRED_INTENT_RECONCILE_GRACE_MS = 10 * 60_000;

/** Marks a start whose outcome at the gateway is unconfirmed. Guarded: only a
 * row that never got a provider id moves, and a failed write is logged, never
 * allowed to hide the original error. `providerSubscriptionId` (a plan
 * mismatch: DOIT did create a subscription) is stored with it so the row can
 * still be paused or cancelled; an id another local row owns is not stored. */
async function markStartNeedsReconcile(
  context: ScopedTenantContext,
  subscriptionId: string,
  reason:
    | "PROVIDER_ERROR"
    | "DUPLICATE_AT_PROVIDER"
    | "PLAN_MISMATCH"
    | "INTENT_EXPIRED",
  providerSubscriptionId?: string,
): Promise<void> {
  try {
    await withTenant(db, context, async (tx) => {
      const tenantId = context.tenant.tenantId;
      let storeProviderId = false;
      if (providerSubscriptionId) {
        const [taken] = await tx
          .select({ id: paymentRecurringSubscriptions.id })
          .from(paymentRecurringSubscriptions)
          .where(
            and(
              eq(paymentRecurringSubscriptions.tenantId, tenantId),
              eq(
                paymentRecurringSubscriptions.providerSubscriptionId,
                providerSubscriptionId,
              ),
              ne(paymentRecurringSubscriptions.id, subscriptionId),
            ),
          );
        storeProviderId = taken === undefined;
      }
      await tx
        .update(paymentRecurringSubscriptions)
        .set({
          status: "needs_reconcile",
          reconcileReason: reason,
          ...(storeProviderId ? { providerSubscriptionId } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(paymentRecurringSubscriptions.id, subscriptionId),
            isNull(paymentRecurringSubscriptions.providerSubscriptionId),
            inArray(paymentRecurringSubscriptions.status, [
              "provisioning",
              "needs_reconcile",
            ]),
          ),
        );
    });
  } catch (error) {
    logger.error(
      {
        subscriptionId,
        reason,
        errName: error instanceof Error ? error.name : "unknown",
      },
      "Could not mark recurring start for reconciliation",
    );
  }
}

const cancelledIntent = (): CoreError =>
  new CoreError(
    "CONFLICT",
    "Permintaan langganan ini sudah dibatalkan. Buat permintaan baru dengan kunci baru.",
  );

/** Creates the subscription at DOIT and stores it `pending_first_payment`.
 * It becomes active only when the first invoice is paid (verified webhook).
 * `firstInvoiceUrl` is DOIT's link when it already knows it (not on a replay of
 * a start that already finished).
 *
 * The intent is stored (`provisioning`, caller key, row id) BEFORE the DOIT
 * call and the row id is the DOIT `reference`: a lost answer, a timeout or a
 * 409 leaves a `needs_reconcile` row, and a retry with the same key resends
 * the same reference and key, so exactly one subscription and one local row
 * exist. Such a row never notifies and never activates. */
export async function startSubscription(
  context: ScopedTenantContext,
  input: StartSubscriptionInput,
  deps?: RecurringDeps,
): Promise<{
  subscription: PaymentRecurringSubscription;
  firstInvoiceUrl: string | null;
}> {
  const tenantId = context.tenant.tenantId;
  const { plan, customerFound, existing, unresolved } = await withTenant(
    db,
    context,
    async (tx) => {
      const [found] = await tx
        .select()
        .from(paymentRecurringPlans)
        .where(
          and(
            eq(paymentRecurringPlans.tenantId, tenantId),
            eq(paymentRecurringPlans.id, input.planId),
          ),
        );
      // The customer must be a live profile of this tenant (not merged away).
      const [customer] = await tx
        .select({ id: customerProfiles.id })
        .from(customerProfiles)
        .where(
          and(
            eq(customerProfiles.tenantId, tenantId),
            eq(customerProfiles.id, input.customerProfileId),
            isNull(customerProfiles.mergedIntoProfileId),
          ),
        );
      const [replay] = await tx
        .select()
        .from(paymentRecurringSubscriptions)
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(
              paymentRecurringSubscriptions.startIdempotencyKey,
              input.idempotencyKey,
            ),
          ),
        );
      // Another key for the same plan and customer while a start is still
      // unresolved at the gateway: the older one may already hold a provider
      // subscription, so a second one is never created next to it.
      let unresolved = false;
      if (!replay && found) {
        const [other] = await tx
          .select({ id: paymentRecurringSubscriptions.id })
          .from(paymentRecurringSubscriptions)
          .where(
            and(
              eq(paymentRecurringSubscriptions.tenantId, tenantId),
              eq(paymentRecurringSubscriptions.planId, found.id),
              eq(
                paymentRecurringSubscriptions.customerProfileId,
                input.customerProfileId,
              ),
              unresolvedSubscription(),
            ),
          )
          .limit(1);
        unresolved = other !== undefined;
      }
      return {
        plan: found ?? null,
        customerFound: customer !== undefined,
        existing: replay ?? null,
        unresolved,
      };
    },
  );
  if (!plan) throw notFound("Paket");
  assertOutletInScope(context.outletScope, plan.outletId);
  if (existing) {
    // Same key, other request: never answer with someone else's subscription.
    if (
      existing.planId !== plan.id ||
      existing.customerProfileId !== input.customerProfileId
    )
      throw KEY_REUSED();
    // Finished earlier: an idempotent replay, DOIT is not called again.
    if (existing.providerSubscriptionId !== null)
      return { subscription: existing, firstInvoiceUrl: null };
    // DOIT confirmed it never created this intent and it was cancelled: it is
    // never retried (a retry could create a subscription no row points to).
    if (existing.status === "cancelled") throw cancelledIntent();
    // An unconfirmed start older than DOIT's idempotency window is not retried
    // (a second subscription could be created): park it for reconciliation.
    if (Date.now() - existing.createdAt.getTime() > START_RETRY_WINDOW_MS) {
      await markStartNeedsReconcile(context, existing.id, "INTENT_EXPIRED");
      throw new CoreError(
        "CONFLICT",
        "Permintaan langganan ini sudah terlalu lama untuk diulang otomatis. Status di gateway perlu dicek manual.",
      );
    }
  } else {
    if (plan.status !== "active")
      throw new CoreError("CONFLICT", "Paket sudah tidak aktif.");
    if (!customerFound) throw notFound("Pelanggan");
    if (unresolved)
      throw new CoreError(
        "CONFLICT",
        "Ada langganan yang belum terkonfirmasi di gateway. Coba lagi dengan kunci yang sama.",
      );
  }

  // A retry of a stored intent only has to learn and tie the provider
  // subscription (so it can be stopped), which works for any integration
  // status; a new intent still needs an active integration. Either way it is
  // checked before anything is stored: a disabled integration leaves no row.
  const client = await clientLoader(deps)(
    context,
    plan.outletId,
    plan.gatewayIntegrationId,
    existing ? "stop" : "bill",
  );

  const intent =
    existing ??
    (await withTenant(db, context, async (tx) => {
      // Brief 488 item 1: one start at a time per customer + plan, taken
      // BEFORE the intent is stored and so before DOIT is called. The loser
      // waits here, then sees the winner's intent (or its pending / active
      // row) and is refused, so DOIT is never asked for a second subscription.
      // The unique partial index on live rows is the last line of defence.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`recurring-start:${tenantId}:${plan.id}:${input.customerProfileId}`}, 0))`,
      );
      const [sameKey] = await tx
        .select()
        .from(paymentRecurringSubscriptions)
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(
              paymentRecurringSubscriptions.startIdempotencyKey,
              input.idempotencyKey,
            ),
          ),
        );
      if (sameKey) {
        if (
          sameKey.planId !== plan.id ||
          sameKey.customerProfileId !== input.customerProfileId
        )
          throw KEY_REUSED();
        return sameKey;
      }
      const [blocking] = await tx
        .select({ id: paymentRecurringSubscriptions.id })
        .from(paymentRecurringSubscriptions)
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(paymentRecurringSubscriptions.planId, plan.id),
            eq(
              paymentRecurringSubscriptions.customerProfileId,
              input.customerProfileId,
            ),
            or(
              // The customer already holds this plan (also paused or past
              // due: resuming or paying it would make a second live row).
              inArray(paymentRecurringSubscriptions.status, [
                "pending_first_payment",
                "active",
                "past_due",
                "paused",
              ]),
              unresolvedSubscription(),
            ),
          ),
        )
        .limit(1);
      if (blocking)
        throw new CoreError(
          "CONFLICT",
          "Pelanggan ini sudah memiliki langganan untuk paket ini atau sedang diproses.",
        );
      const [inserted] = await tx
        .insert(paymentRecurringSubscriptions)
        .values({
          id: randomUUID(),
          tenantId,
          outletId: plan.outletId,
          planId: plan.id,
          gatewayIntegrationId: plan.gatewayIntegrationId,
          customerProfileId: input.customerProfileId,
          providerSubscriptionId: null,
          startIdempotencyKey: input.idempotencyKey,
          status: "provisioning",
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return inserted;
      // A concurrent request with the same key stored the intent first.
      const [raced] = await tx
        .select()
        .from(paymentRecurringSubscriptions)
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(
              paymentRecurringSubscriptions.startIdempotencyKey,
              input.idempotencyKey,
            ),
          ),
        );
      // No row with this key: the conflict was the unresolved customer + plan
      // index (another start slipped in), not a reused key.
      if (!raced)
        throw new CoreError(
          "CONFLICT",
          "Pelanggan ini sudah memiliki langganan untuk paket ini atau sedang diproses.",
        );
      if (
        raced.planId !== plan.id ||
        raced.customerProfileId !== input.customerProfileId
      )
        throw KEY_REUSED();
      return raced;
    }));
  if (intent.providerSubscriptionId !== null)
    return { subscription: intent, firstInvoiceUrl: null };
  // Lost a race with a reconcile that cancelled the same intent.
  if (intent.status === "cancelled") throw cancelledIntent();

  let provider: DoitRecurringSubscription;
  try {
    provider = await client.createSubscription(
      { providerPlanId: plan.providerPlanId, reference: intent.id },
      `subscription:${tenantId}:${input.idempotencyKey}`,
    );
  } catch (error) {
    // Whatever happened (timeout, lost answer, 409, bad answer), DOIT may or
    // may not hold the subscription: keep the row, never guess.
    const duplicate =
      error instanceof CoreError && error.code === "IDEMPOTENCY_KEY_REUSED";
    await markStartNeedsReconcile(
      context,
      intent.id,
      duplicate ? "DUPLICATE_AT_PROVIDER" : "PROVIDER_ERROR",
    );
    throw duplicate
      ? new CoreError(
          "CONFLICT",
          "Status langganan di gateway belum dapat dipastikan. Ulangi dengan kunci permintaan yang sama; aman diulang.",
        )
      : new CoreError(
          "SERVICE_UNAVAILABLE",
          "Status langganan di gateway belum dapat dipastikan. Ulangi dengan kunci permintaan yang sama; aman diulang.",
        );
  }
  if (provider.plan_id !== plan.providerPlanId) {
    await markStartNeedsReconcile(
      context,
      intent.id,
      "PLAN_MISMATCH",
      provider.id,
    );
    throw new CoreError(
      "CONFLICT",
      "Langganan di gateway tidak sesuai dengan paket. Status di gateway belum dapat dipastikan.",
    );
  }

  const subscription = await withTenant(db, context, async (tx) => {
    // DOIT answered with an id another local row already owns: not ours.
    const [taken] = await tx
      .select({ id: paymentRecurringSubscriptions.id })
      .from(paymentRecurringSubscriptions)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.providerSubscriptionId, provider.id),
          ne(paymentRecurringSubscriptions.id, intent.id),
        ),
      );
    if (taken) return null;
    const [updated] = await tx
      .update(paymentRecurringSubscriptions)
      .set({
        providerSubscriptionId: provider.id,
        status: "pending_first_payment",
        reconcileReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, intent.id),
          isNull(paymentRecurringSubscriptions.providerSubscriptionId),
          inArray(paymentRecurringSubscriptions.status, [
            "provisioning",
            "needs_reconcile",
          ]),
        ),
      )
      .returning();
    if (updated) return updated;
    // Not updated: a concurrent retry finished it first (same DOIT id), or a
    // reconcile moved the row (cancelled / needs_reconcile) while DOIT was
    // called. Only a row that holds this DOIT id is ours to return.
    const stored = await loadSubscription(tx, context, intent.id);
    if (stored.providerSubscriptionId === provider.id) return stored;
    logger.error(
      { subscriptionId: intent.id, providerSubscriptionId: provider.id },
      "Recurring start finished at DOIT but the local row no longer accepts it",
    );
    throw new CoreError(
      "CONFLICT",
      "Permintaan langganan ini sudah diubah saat diproses di gateway. Status di gateway perlu dicek manual.",
    );
  });
  if (!subscription) {
    await markStartNeedsReconcile(context, intent.id, "DUPLICATE_AT_PROVIDER");
    throw new CoreError(
      "CONFLICT",
      "Langganan di gateway sudah terhubung ke catatan lain. Status di gateway belum dapat dipastikan.",
    );
  }
  return { subscription, firstInvoiceUrl: provider.first_invoice_url };
}

async function loadSubscription(
  tx: Tx,
  context: ScopedTenantContext,
  subscriptionId: string,
): Promise<PaymentRecurringSubscription> {
  const [found] = await tx
    .select()
    .from(paymentRecurringSubscriptions)
    .where(
      and(
        eq(paymentRecurringSubscriptions.tenantId, context.tenant.tenantId),
        eq(paymentRecurringSubscriptions.id, subscriptionId),
      ),
    );
  if (!found) throw notFound("Langganan");
  assertOutletInScope(context.outletScope, found.outletId);
  return found;
}

// -- Next period: access and promotion -------------------------------------------

/** Default grace (founder W5, PRD): days after the end of the paid period an
 * `active` subscription keeps access while the next invoice is unpaid, and
 * the days an open invoice may stay unpaid before the row turns `past_due`.
 * Each outlet may set its own value (0..30) in
 * `payment_recurring_outlet_settings`; no row = this default. */
export const RECURRING_GRACE_DAYS = 3;

/** Grace days used by the access check: a whole number in 0..30. Anything
 * else (NaN, negative, fraction) gives no grace, more than 30 is capped, so a
 * bad value can never extend access. */
function safeGraceDays(graceDays: number): number {
  if (!Number.isInteger(graceDays) || graceDays <= 0) return 0;
  return Math.min(graceDays, RECURRING_GRACE_DAYS_MAX);
}

type AccessFields = Pick<
  PaymentRecurringSubscription,
  | "status"
  | "currentPeriodStart"
  | "currentPeriodEnd"
  | "nextPeriodStart"
  | "nextPeriodEnd"
>;

export type SubscriptionAccessPeriod = {
  start: string;
  /** Null while in grace with no paid next period yet. */
  end: string | null;
  inGrace: boolean;
};

/** The period whose quota today's use counts toward, or null without access.
 * Only `active` rows have access. Inside the current or the paid next period
 * (start inclusive, end exclusive): that period. Inside the grace days
 * (`current_period_end <= today < current_period_end + graceDays`, with the
 * next period not started yet): the NEXT period, starting at
 * `current_period_end`, so grace use counts toward the new period's quota,
 * never toward the old one and never toward extra quota. Grace 0 = access
 * stops at the end of the paid period. Every other status (pending, past_due,
 * paused, cancelled, provisioning, needs_reconcile) has no access. */
export function subscriptionAccessPeriod(
  subscription: AccessFields,
  now: Date,
  graceDays: number,
): SubscriptionAccessPeriod | null {
  if (subscription.status !== "active") return null;
  const today = businessDateOf(now);
  const inside = (start: string | null, end: string | null) =>
    start !== null && end !== null && start <= today && today < end;
  const {
    currentPeriodStart,
    currentPeriodEnd,
    nextPeriodStart,
    nextPeriodEnd,
  } = subscription;
  if (inside(currentPeriodStart, currentPeriodEnd))
    return {
      start: currentPeriodStart as string,
      end: currentPeriodEnd,
      inGrace: false,
    };
  if (inside(nextPeriodStart, nextPeriodEnd))
    return {
      start: nextPeriodStart as string,
      end: nextPeriodEnd,
      inGrace: false,
    };
  const grace = safeGraceDays(graceDays);
  if (
    grace > 0 &&
    currentPeriodEnd !== null &&
    currentPeriodEnd <= today &&
    today < addDaysToDate(currentPeriodEnd, grace) &&
    // A next period that has already started and not covered today has ended:
    // no grace after it (ragu = batasi).
    (nextPeriodStart === null || today < nextPeriodStart)
  )
    return {
      start: currentPeriodEnd,
      end: nextPeriodEnd ?? null,
      inGrace: true,
    };
  return null;
}

/** True when `subscriptionAccessPeriod` gives a period (see there). */
export function subscriptionHasAccess(
  subscription: AccessFields,
  now: Date,
  graceDays: number,
): boolean {
  return subscriptionAccessPeriod(subscription, now, graceDays) !== null;
}

/** Grace days of an outlet; no stored row = RECURRING_GRACE_DAYS. */
export async function getRecurringGraceDays(
  context: ScopedTenantContext,
  outletId: string,
): Promise<number> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, (tx) =>
    readRecurringGraceDays(tx, context.tenant.tenantId, outletId),
  );
}

/** Grace days of an outlet inside an open transaction (no row = default). */
export async function readRecurringGraceDays(
  tx: Tx,
  tenantId: TenantId,
  outletId: string,
): Promise<number> {
  const s = paymentRecurringOutletSettings;
  const [row] = await tx
    .select({ graceDays: s.graceDays })
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.outletId, outletId as OutletId)));
  return row ? row.graceDays : RECURRING_GRACE_DAYS;
}

/** Stores the grace days of an outlet (whole number 0..30, else
 * VALIDATION_ERROR). Upsert; returns the stored value. */
export async function setRecurringGraceDays(
  context: ScopedTenantContext,
  outletId: string,
  graceDays: number,
): Promise<number> {
  assertOutletInScope(context.outletScope, outletId);
  if (
    !Number.isInteger(graceDays) ||
    graceDays < RECURRING_GRACE_DAYS_MIN ||
    graceDays > RECURRING_GRACE_DAYS_MAX
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      `Masa tenggang harus bilangan bulat ${RECURRING_GRACE_DAYS_MIN} sampai ${RECURRING_GRACE_DAYS_MAX} hari.`,
    );
  const s = paymentRecurringOutletSettings;
  return withTenant(db, context, async (tx) => {
    const now = new Date();
    const [stored] = await tx
      .insert(s)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: outletId as OutletId,
        graceDays,
      })
      .onConflictDoUpdate({
        target: [s.tenantId, s.outletId],
        set: { graceDays, updatedAt: now },
      })
      .returning({ graceDays: s.graceDays });
    if (!stored) throw notFound("Pengaturan outlet");
    return stored.graceDays;
  });
}

/** `YYYY-MM-DD` plus whole days. */
function addDaysToDate(date: string, days: number): string {
  return subtractDays(date, -days);
}

/** One UPDATE: for live rows whose next period has started, the next period
 * becomes the current one and the next slot is cleared. The row turns (or
 * stays) `active` when that period covers today, `activatedAt` is set on the
 * first time. Paused, cancelled, provisioning and needs_reconcile rows are
 * never touched. `subscriptionId` narrows it to one row. */
async function promoteDueRows(
  tx: Tx,
  tenantId: TenantId,
  now: Date,
  subscriptionId?: string,
): Promise<PaymentRecurringSubscription[]> {
  const t = paymentRecurringSubscriptions;
  const today = sql`${businessDateOf(now)}::date`;
  const covers = sql`(${t.nextPeriodStart} <= ${today} AND ${t.nextPeriodEnd} > ${today})`;
  return tx
    .update(t)
    .set({
      currentPeriodStart: sql`${t.nextPeriodStart}`,
      currentPeriodEnd: sql`${t.nextPeriodEnd}`,
      nextPeriodStart: null,
      nextPeriodEnd: null,
      status: sql`CASE WHEN ${covers} THEN 'active' ELSE ${t.status} END`,
      activatedAt: sql`CASE WHEN ${covers} AND ${t.activatedAt} IS NULL THEN ${now.toISOString()}::timestamptz ELSE ${t.activatedAt} END`,
      updatedAt: now,
    })
    .where(
      and(
        eq(t.tenantId, tenantId),
        subscriptionId ? eq(t.id, subscriptionId) : undefined,
        inArray(t.status, LIVE_SUBSCRIPTION),
        sql`${t.nextPeriodStart} IS NOT NULL AND ${t.nextPeriodStart} <= ${today}`,
      ),
    )
    .returning();
}

/** Promotes the next period of every live subscription whose start date has
 * come (the worker calls it; reads and invoice events also promote lazily). */
export async function promoteDueSubscriptionPeriods(
  context: ScopedTenantContext,
  now: Date,
): Promise<{ promoted: number }> {
  const rows = await withTenant(db, context, (tx) =>
    promoteDueRows(tx, context.tenant.tenantId, now),
  );
  return { promoted: rows.length };
}

/** `YYYY-MM-DD` minus whole days. */
function subtractDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day - days))
    .toISOString()
    .slice(0, 10);
}

/** `active` -> `past_due` for subscriptions with an `open` invoice for a period
 * beyond everything paid (`next_period_end`, else `current_period_end`) whose
 * start date plus the grace of the subscription's outlet has passed (grace g:
 * due D stays `active` through D+g, `past_due` from D+g+1; no settings row =
 * RECURRING_GRACE_DAYS). Idempotent: a second run finds nothing
 * left to change. Rows are locked first and the condition is checked again in
 * a new statement, so a payment that commits meanwhile is never overwritten.
 * Returns the number of rows changed. A later verified `invoice.paid` turns the
 * row `active` again (same period rules, no extra period). */
export async function markOverdueSubscriptionsPastDue(
  context: ScopedTenantContext,
  now: Date,
): Promise<number> {
  const t = paymentRecurringSubscriptions;
  const i = subscriptionInvoices;
  const tenantId = context.tenant.tenantId;
  const s = paymentRecurringOutletSettings;
  const today = businessDateOf(now);
  // Per-outlet grace read in the same statement (also in the re-check under
  // the row lock). date - integer = date.
  const graceDays = sql`COALESCE((SELECT ${s.graceDays} FROM ${s} WHERE ${s.tenantId} = ${t.tenantId} AND ${s.outletId} = ${t.outletId}), ${RECURRING_GRACE_DAYS})`;
  const overdue = and(
    eq(t.tenantId, tenantId),
    eq(t.status, "active"),
    sql`EXISTS (SELECT 1 FROM ${i} WHERE ${i.tenantId} = ${t.tenantId} AND ${i.subscriptionId} = ${t.id} AND ${i.status} = 'open' AND ${i.periodStart} >= COALESCE(${t.nextPeriodEnd}, ${t.currentPeriodEnd}) AND ${i.periodStart} < ${today}::date - ${graceDays}::integer)`,
  );
  // One transaction per subscription (legend-6qu47): a row lock and the grace
  // revoke (customer lock) are held for one subscription only, so the sweep
  // never blocks a pause or a payment on the others, and one bad row rolls
  // back alone.
  const candidates = await withTenant(db, context, (tx) =>
    tx.select({ id: t.id }).from(t).where(overdue),
  );
  let changedCount = 0;
  for (const candidate of candidates) {
    try {
      changedCount += await withTenant(db, context, async (tx) => {
        const locked = await tx
          .select({ id: t.id })
          .from(t)
          .where(and(overdue, eq(t.id, candidate.id)))
          .for("update");
        if (locked.length === 0) return 0;
        const changed = await tx
          .update(t)
          .set({ status: "past_due", updatedAt: now })
          .where(and(overdue, eq(t.id, candidate.id)))
          .returning({
            id: t.id,
            customerProfileId: t.customerProfileId,
            currentPeriodEnd: t.currentPeriodEnd,
          });
        // `past_due` is no access: the unused grace of the row goes with it.
        for (const row of changed)
          await revokeSubscriptionGrace(tx, context, row, now);
        return changed.length;
      });
    } catch (error) {
      logger.warn(
        {
          job: "payment_gateway_poll",
          subscriptionId: candidate.id,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Subscription past-due marking failed for one row",
      );
    }
  }
  return changedCount;
}

/** The row itself, or its promoted version when its next period is due. */
async function withDuePromotion(
  tx: Tx,
  tenantId: TenantId,
  row: PaymentRecurringSubscription,
  now: Date,
): Promise<PaymentRecurringSubscription> {
  if (row.nextPeriodStart === null || row.nextPeriodStart > businessDateOf(now))
    return row;
  const [promoted] = await promoteDueRows(tx, tenantId, now, row.id);
  return promoted ?? row;
}

export async function getSubscription(
  context: ScopedTenantContext,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<PaymentRecurringSubscription> {
  return withTenant(db, context, async (tx) =>
    withDuePromotion(
      tx,
      context.tenant.tenantId,
      await loadSubscription(tx, context, subscriptionId),
      now,
    ),
  );
}

export async function listSubscriptionInvoices(
  context: ScopedTenantContext,
  subscriptionId: string,
): Promise<SubscriptionInvoice[]> {
  return withTenant(db, context, async (tx) => {
    await loadSubscription(tx, context, subscriptionId);
    return tx
      .select()
      .from(subscriptionInvoices)
      .where(
        and(
          eq(subscriptionInvoices.tenantId, context.tenant.tenantId),
          eq(subscriptionInvoices.subscriptionId, subscriptionId),
        ),
      )
      .orderBy(
        desc(subscriptionInvoices.periodStart),
        desc(subscriptionInvoices.id),
      );
  });
}

/** A row whose state at the gateway is not settled: every `provisioning` or
 * `needs_reconcile` row, with or without a DOIT id (any reason, PLAN_MISMATCH
 * too), because DOIT may still charge for it. It blocks a new start and a
 * resume of another row of the same customer and plan until it is resolved
 * (cancelled, or synced by the reconcile tool). Matches the unique partial
 * index `payment_recurring_subscriptions_unresolved_customer_plan_key`. */
function unresolvedSubscription() {
  const t = paymentRecurringSubscriptions;
  return inArray(t.status, ["provisioning", "needs_reconcile"]);
}

type SubscriptionAction = "pause" | "resume" | "cancel";

/** Provider call first, then ONE locked local decision (`SELECT ... FOR
 * UPDATE`, then update). A provider failure changes nothing. DOIT has already
 * paused/cancelled when the local write runs, so the local row follows, with
 * one rule: a cancelled row never goes back to paused (cancel always wins, in
 * either order of two concurrent calls). An answer that is not about this
 * subscription or not in the expected status is never success: the row becomes
 * `needs_reconcile` (RESPONSE_MISMATCH) and the call fails. */
async function changeSubscription(
  context: ScopedTenantContext,
  subscriptionId: string,
  action: SubscriptionAction,
  now: Date,
  deps?: RecurringDeps,
): Promise<PaymentRecurringSubscription> {
  const tenantId = context.tenant.tenantId;
  const current = await getSubscription(context, subscriptionId, now);

  // Idempotent no-ops: the state already is the requested one.
  if (action === "cancel" && current.status === "cancelled") return current;
  if (action === "pause" && current.status === "paused") return current;
  if (current.status === "cancelled")
    throw new CoreError("CONFLICT", "Langganan sudah dibatalkan.");
  // A mismatch row that holds a DOIT id can still be paused/resumed/cancelled:
  // DOIT may be charging for it, so the tenant must be able to act on it.
  // Exception: a PLAN_MISMATCH row (DOIT holds another plan) may only be
  // cancelled. Resuming it would clear the marker and every invoice would still
  // land in `needs_review`, so the guest would pay without ever getting access.
  const reconcilable =
    current.status === "needs_reconcile" &&
    current.providerSubscriptionId !== null &&
    (action === "cancel" || current.reconcileReason !== "PLAN_MISMATCH");
  if (
    action === "pause" &&
    !reconcilable &&
    !["active", "past_due"].includes(current.status)
  )
    throw new CoreError("CONFLICT", "Hanya langganan aktif yang dapat dijeda.");
  if (action === "resume" && !reconcilable && current.status !== "paused")
    throw new CoreError(
      "CONFLICT",
      "Hanya langganan yang dijeda yang dapat dilanjutkan.",
    );
  // Without a provider id there is nothing to call (a start still unconfirmed).
  const providerSubscriptionId = current.providerSubscriptionId;
  if (providerSubscriptionId === null)
    throw new CoreError(
      "CONFLICT",
      "Status langganan di gateway belum dapat dipastikan.",
    );

  // A resume makes DOIT charge again: refuse while another live or unresolved
  // subscription of the same customer and plan exists (two would be paid).
  if (action === "resume") {
    const t = paymentRecurringSubscriptions;
    const [other] = await withTenant(db, context, (tx) =>
      tx
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.tenantId, tenantId),
            eq(t.planId, current.planId),
            eq(t.customerProfileId, current.customerProfileId),
            ne(t.id, current.id),
            or(
              inArray(t.status, [
                "pending_first_payment",
                "active",
                "past_due",
              ]),
              unresolvedSubscription(),
            ),
          ),
        )
        .limit(1),
    );
    if (other)
      throw new CoreError(
        "CONFLICT",
        "Pelanggan ini sudah memiliki langganan lain yang aktif untuk paket ini. Batalkan salah satunya lebih dulu.",
      );
  }

  // Only a resume can make DOIT charge again; pause and cancel must work even
  // when the integration is disabled or the provider left the tenant plan.
  const client = await clientLoader(deps)(
    context,
    current.outletId,
    current.gatewayIntegrationId,
    action === "resume" ? "bill" : "stop",
  );
  const key = `${action}:${current.id}:${current.updatedAt.toISOString()}`;
  const call =
    action === "pause"
      ? client.pauseSubscription
      : action === "resume"
        ? client.resumeSubscription
        : client.cancelSubscription;
  const answer = await call(providerSubscriptionId, key);

  if (
    !doitSubscriptionActionConfirmed(action, answer, providerSubscriptionId)
  ) {
    try {
      await withTenant(db, context, (tx) =>
        tx
          .update(paymentRecurringSubscriptions)
          .set({
            status: "needs_reconcile",
            reconcileReason: "RESPONSE_MISMATCH",
            updatedAt: now,
          })
          .where(
            and(
              eq(paymentRecurringSubscriptions.tenantId, tenantId),
              eq(paymentRecurringSubscriptions.id, current.id),
              // A concurrent cancel that already won stays cancelled.
              ne(paymentRecurringSubscriptions.status, "cancelled"),
            ),
          ),
      );
    } catch (error) {
      // Another unresolved row already holds the (customer, plan) slot: this
      // row cannot be parked, so it keeps its status and a person must look.
      if (!isUniqueViolation(error)) throw error;
      logger.warn(
        { subscriptionId: current.id, action },
        "Could not park an unconfirmed subscription action: unresolved row exists",
      );
      throw new CoreError(
        "CONFLICT",
        "Status di gateway belum dapat dipastikan dan pelanggan ini punya langganan lain yang belum diselesaikan. Periksa langganan di gateway.",
      );
    }
    logger.warn(
      { subscriptionId: current.id, action },
      "DOIT answer to a subscription action did not confirm it",
    );
    throw new CoreError(
      "CONFLICT",
      "Status di gateway belum dapat dipastikan. Periksa langganan di gateway lalu coba lagi.",
    );
  }

  return withTenant(db, context, async (tx) => {
    const [locked] = await tx
      .select()
      .from(paymentRecurringSubscriptions)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, current.id),
        ),
      )
      .for("update");
    if (!locked) throw notFound("Langganan");
    assertOutletInScope(context.outletScope, locked.outletId);

    if (action === "resume") {
      // The decision was made on this status; anything else moved it.
      if (locked.status !== current.status)
        throw new CoreError(
          "CONFLICT",
          "Status langganan sudah berubah. Muat ulang lalu coba lagi.",
        );
    } else {
      // Never move a cancelled row back to paused; already there: no-op.
      if (locked.status === "cancelled") return locked;
      if (action === "pause" && locked.status === "paused") return locked;
    }

    // Resume never grants access by itself: it returns to `active` only while
    // the period of an earlier verified payment still runs, otherwise to
    // `past_due` until the next verified invoice.paid (or the promotion of a
    // paid next period that has started).
    // A confirmed answer on a `needs_reconcile` row applies the normal status
    // rule and clears the reconcile reason.
    const patch: Partial<typeof paymentRecurringSubscriptions.$inferInsert> = {
      updatedAt: now,
      reconcileReason: null,
    };
    if (action === "pause") {
      patch.status = "paused";
      patch.pausedAt = now;
    } else if (action === "cancel") {
      patch.status = "cancelled";
      patch.cancelledAt = now;
    } else {
      patch.status =
        locked.activatedAt !== null &&
        locked.currentPeriodEnd !== null &&
        locked.currentPeriodEnd > businessDateOf(now)
          ? "active"
          : locked.activatedAt === null &&
              locked.currentPeriodEnd === null &&
              current.status === "needs_reconcile"
            ? // Never paid: wait for the first verified payment, no access.
              "pending_first_payment"
            : "past_due";
      patch.pausedAt = null;
    }
    const [updated] = await tx
      .update(paymentRecurringSubscriptions)
      .set(patch)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, locked.id),
          action === "pause"
            ? ne(paymentRecurringSubscriptions.status, "cancelled")
            : undefined,
        ),
      )
      .returning();
    if (!updated) throw notFound("Langganan");
    // Pause/cancel stop the access: the unused grace goes in the same
    // transaction, under the row lock held here (no advisory lock: the sync
    // takes it before the row, so this order cannot deadlock with it).
    if (action !== "resume")
      await revokeSubscriptionGrace(tx, context, updated, now);
    return action === "resume"
      ? withDuePromotion(tx, tenantId, updated, now)
      : updated;
  }).catch((error: unknown) => {
    // A resume back to pending / active meets the live (customer, plan) index
    // when a new start already holds that slot: refuse, do not leak a 23505.
    if (action === "resume" && isUniqueViolation(error))
      throw new CoreError(
        "CONFLICT",
        "Pelanggan ini sudah memiliki langganan lain yang aktif untuk paket ini. Batalkan salah satunya lebih dulu.",
      );
    throw error;
  });
}

export const pauseSubscription = (
  context: ScopedTenantContext,
  subscriptionId: string,
  now: Date = new Date(),
  deps?: RecurringDeps,
) => changeSubscription(context, subscriptionId, "pause", now, deps);

export const resumeSubscription = (
  context: ScopedTenantContext,
  subscriptionId: string,
  now: Date = new Date(),
  deps?: RecurringDeps,
) => changeSubscription(context, subscriptionId, "resume", now, deps);

export const cancelSubscription = (
  context: ScopedTenantContext,
  subscriptionId: string,
  now: Date = new Date(),
  deps?: RecurringDeps,
) => changeSubscription(context, subscriptionId, "cancel", now, deps);

// -- Reconcile tools (legend-yqne1, legend-lch2o) --------------------------------
//
// Read-only towards DOIT (GET only, never create/pause/resume/cancel). They move
// a `needs_reconcile` row to what DOIT says, but never to `active`: only a
// verified invoice.paid webhook activates. Any doubt (error, another id or
// plan, an unknown status, more than one match) leaves the row as it is.

export type ReconcileResult = {
  subscription: PaymentRecurringSubscription;
  /** True when the row left `needs_reconcile`. */
  resolved: boolean;
};

const reconcileConflict = () =>
  new CoreError(
    "CONFLICT",
    "Langganan ini tidak perlu direkonsiliasi atau statusnya sudah berubah. Muat ulang lalu coba lagi.",
  );

/** How a DOIT status maps locally (ASSUMED statuses, like the rest of the
 * client). `null`: unknown, the row stays `needs_reconcile`. */
function doitStatusKind(
  status: string,
): "cancelled" | "paused" | "live" | null {
  const value = status.trim().toLowerCase();
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "paused") return "paused";
  if (["pending", "active", "past_due"].includes(value)) return "live";
  return null;
}

async function lockSubscription(
  tx: Tx,
  context: ScopedTenantContext,
  subscriptionId: string,
): Promise<PaymentRecurringSubscription> {
  const [locked] = await tx
    .select()
    .from(paymentRecurringSubscriptions)
    .where(
      and(
        eq(paymentRecurringSubscriptions.tenantId, context.tenant.tenantId),
        eq(paymentRecurringSubscriptions.id, subscriptionId),
      ),
    )
    .for("update");
  if (!locked) throw notFound("Langganan");
  assertOutletInScope(context.outletScope, locked.outletId);
  return locked;
}

/** Local plan row's DOIT plan id, for the plan check against a DOIT answer. */
async function providerPlanIdOf(
  tx: Tx,
  tenantId: TenantId,
  planId: string,
): Promise<string> {
  const [plan] = await tx
    .select({ providerPlanId: paymentRecurringPlans.providerPlanId })
    .from(paymentRecurringPlans)
    .where(
      and(
        eq(paymentRecurringPlans.tenantId, tenantId),
        eq(paymentRecurringPlans.id, planId),
      ),
    );
  if (!plan) throw notFound("Paket");
  return plan.providerPlanId;
}

/** A row that left `needs_reconcile` and meets the live (customer, plan) index
 * because a new start holds that slot: refuse, do not leak a 23505. */
function reconcileUniqueConflict(error: unknown): never {
  if (isUniqueViolation(error))
    throw new CoreError(
      "CONFLICT",
      "Pelanggan ini sudah memiliki langganan lain yang aktif untuk paket ini. Batalkan salah satunya lebih dulu.",
    );
  throw error;
}

/** `needs_reconcile` row WITH a DOIT id (any reason): asks DOIT for the
 * subscription and follows its status. The answer must carry the same id and
 * the plan's DOIT plan id, otherwise the row stays (a plan mismatch is marked
 * PLAN_MISMATCH). A PLAN_MISMATCH row only ever becomes `cancelled`. A DOIT
 * failure rejects and changes nothing. */
export async function resolveNeedsReconcileSubscription(
  context: ScopedTenantContext,
  subscriptionId: string,
  now: Date = new Date(),
  deps?: RecurringDeps,
): Promise<ReconcileResult> {
  const tenantId = context.tenant.tenantId;
  const { current, providerPlanId } = await withTenant(
    db,
    context,
    async (tx) => {
      const row = await loadSubscription(tx, context, subscriptionId);
      if (
        row.status !== "needs_reconcile" ||
        row.providerSubscriptionId === null
      )
        throw reconcileConflict();
      return {
        current: row,
        providerPlanId: await providerPlanIdOf(tx, tenantId, row.planId),
      };
    },
  );
  const providerSubscriptionId = current.providerSubscriptionId;
  if (providerSubscriptionId === null) throw reconcileConflict();

  // Read-only: any integration status works, like a stop call.
  const client = await clientLoader(deps)(
    context,
    current.outletId,
    current.gatewayIntegrationId,
    "stop",
  );
  const answer = await client.getSubscription(providerSubscriptionId);
  const kind = doitStatusKind(answer.status);

  return withTenant(db, context, async (tx): Promise<ReconcileResult> => {
    const locked = await lockSubscription(tx, context, current.id);
    // The decision was made on this state; anything else moved it.
    if (
      locked.status !== "needs_reconcile" ||
      locked.providerSubscriptionId !== providerSubscriptionId
    )
      throw reconcileConflict();
    const stay = { subscription: locked, resolved: false };

    // Not this subscription: nothing can be said about the row.
    if (answer.id !== providerSubscriptionId) return stay;
    if (answer.plan_id !== providerPlanId) {
      if (locked.reconcileReason === "PLAN_MISMATCH") return stay;
      const [marked] = await tx
        .update(paymentRecurringSubscriptions)
        .set({ reconcileReason: "PLAN_MISMATCH", updatedAt: now })
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(paymentRecurringSubscriptions.id, locked.id),
          ),
        )
        .returning();
      return { subscription: marked ?? locked, resolved: false };
    }
    if (kind === null) return stay;
    // DOIT holds another plan for this row: only a cancel is a safe way out.
    if (locked.reconcileReason === "PLAN_MISMATCH" && kind !== "cancelled")
      return stay;

    const patch: Partial<typeof paymentRecurringSubscriptions.$inferInsert> = {
      updatedAt: now,
      reconcileReason: null,
    };
    if (kind === "cancelled") {
      patch.status = "cancelled";
      patch.cancelledAt = now;
    } else if (kind === "paused") {
      patch.status = "paused";
      patch.pausedAt = now;
    } else {
      // Never `active` without a verified payment: only a period of an earlier
      // paid invoice that still runs gives `active`.
      patch.status =
        locked.activatedAt !== null &&
        locked.currentPeriodEnd !== null &&
        locked.currentPeriodEnd > businessDateOf(now)
          ? "active"
          : locked.activatedAt === null && locked.currentPeriodEnd === null
            ? "pending_first_payment"
            : "past_due";
    }
    const [updated] = await tx
      .update(paymentRecurringSubscriptions)
      .set(patch)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, locked.id),
          eq(paymentRecurringSubscriptions.status, "needs_reconcile"),
        ),
      )
      .returning();
    if (!updated) throw reconcileConflict();
    if (kind !== "live")
      await revokeSubscriptionGrace(tx, context, updated, now);
    return { subscription: updated, resolved: true };
  }).catch(reconcileUniqueConflict);
}

/** A start intent older than the retry window (`needs_reconcile`
 * INTENT_EXPIRED, no DOIT id; a fresher one may still be in flight and belongs
 * to the automatic retry). Looks DOIT up by the row id (the `reference` of the
 * start): nothing found = the intent is cancelled, one match of the same plan
 * continues as `pending_first_payment`, another plan is PLAN_MISMATCH. More
 * than one match, an unknown status or a DOIT failure leave the row blocked.
 * Never creates anything at DOIT. */
export async function reconcileExpiredStartIntent(
  context: ScopedTenantContext,
  subscriptionId: string,
  now: Date = new Date(),
  deps?: RecurringDeps,
): Promise<ReconcileResult> {
  const tenantId = context.tenant.tenantId;
  const isExpiredIntent = (row: PaymentRecurringSubscription) =>
    row.status === "needs_reconcile" &&
    row.reconcileReason === "INTENT_EXPIRED" &&
    row.providerSubscriptionId === null &&
    now.getTime() - row.createdAt.getTime() >
      START_RETRY_WINDOW_MS + EXPIRED_INTENT_RECONCILE_GRACE_MS;
  const { current, providerPlanId } = await withTenant(
    db,
    context,
    async (tx) => {
      const row = await loadSubscription(tx, context, subscriptionId);
      if (!isExpiredIntent(row)) throw reconcileConflict();
      return {
        current: row,
        providerPlanId: await providerPlanIdOf(tx, tenantId, row.planId),
      };
    },
  );

  const client = await clientLoader(deps)(
    context,
    current.outletId,
    current.gatewayIntegrationId,
    "stop",
  );
  const found = await client.findSubscriptionByReference(current.id);

  return withTenant(db, context, async (tx): Promise<ReconcileResult> => {
    const locked = await lockSubscription(tx, context, current.id);
    if (!isExpiredIntent(locked)) throw reconcileConflict();
    const stay = { subscription: locked, resolved: false };
    // More than one match is ambiguous: a person must look at DOIT.
    if (found.length > 1)
      throw new CoreError(
        "CONFLICT",
        "DOIT mengembalikan lebih dari satu langganan untuk permintaan ini. Periksa di gateway.",
      );

    const patch: Partial<typeof paymentRecurringSubscriptions.$inferInsert> = {
      updatedAt: now,
    };
    const match = found[0];
    if (match === undefined) {
      // DOIT confirmed it has none (a lookup error never reaches here).
      patch.status = "cancelled";
      patch.cancelledAt = now;
      patch.reconcileReason = null;
    } else {
      // A lookup result that does not echo this row's id as its reference is
      // not proven to be ours: the row stays, no DOIT id is bound.
      if (match.reference !== locked.id) return stay;
      const [taken] = await tx
        .select({ id: paymentRecurringSubscriptions.id })
        .from(paymentRecurringSubscriptions)
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, tenantId),
            eq(paymentRecurringSubscriptions.providerSubscriptionId, match.id),
            ne(paymentRecurringSubscriptions.id, locked.id),
          ),
        );
      if (taken) return stay;
      const kind = doitStatusKind(match.status);
      patch.providerSubscriptionId = match.id;
      if (match.plan_id !== providerPlanId) {
        patch.reconcileReason = "PLAN_MISMATCH";
      } else if (kind === "cancelled") {
        patch.status = "cancelled";
        patch.cancelledAt = now;
        patch.reconcileReason = null;
      } else if (kind === "live") {
        // Never `active`: a verified invoice.paid does that.
        patch.status = "pending_first_payment";
        patch.reconcileReason = null;
      } else {
        // Paused or unknown: keep the DOIT id so the row can be resolved or
        // cancelled, but it stays blocked.
        patch.reconcileReason = "RESPONSE_MISMATCH";
      }
    }
    const [updated] = await tx
      .update(paymentRecurringSubscriptions)
      .set(patch)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, locked.id),
          eq(paymentRecurringSubscriptions.status, "needs_reconcile"),
        ),
      )
      .returning();
    if (!updated) throw reconcileConflict();
    return {
      subscription: updated,
      resolved: updated.status !== "needs_reconcile",
    };
  }).catch(reconcileUniqueConflict);
}

// -- Webhook: invoice.created / invoice.paid -------------------------------------

/**
 * `processed`: applied (or a harmless replay). `ignored`: deterministic
 * refusal, `code` says why, nothing changed. `unknown_subscription` and
 * `unknown_invoice`: nothing is known yet; the webhook layer retries a while
 * (the event may be early) and then ignores or, for a paid invoice, passes
 * `storeUnseenPaidForReview` to keep the money visible.
 */
export type InvoiceEventResult =
  | { outcome: "processed"; code: string | null }
  | { outcome: "ignored"; code: string }
  | { outcome: "unknown_subscription" }
  | { outcome: "unknown_invoice" };

export type InvoiceEventOptions = {
  /** gateway_webhook_events row id of this delivery (kept on a new invoice). */
  sourceEventId?: string;
  /** invoice.paid for an invoice never seen: store it `needs_review`
   * (INVOICE_NOT_SEEN) instead of answering `unknown_invoice`. */
  storeUnseenPaidForReview?: boolean;
  /** Id of the integration whose webhook secret verified the event. */
  verifiedIntegrationId?: string | null;
  /** Further integrations that hold the secret which verified the event (a
   * shared or rotated secret), worked out by the webhook layer BEFORE this
   * transaction: this function does no lookup of its own under the row lock.
   * The event is accepted when `verifiedIntegrationId` or any of these is the
   * integration the subscription was created on; otherwise INTEGRATION_MISMATCH
   * and nothing changes (fails closed). */
  acceptedIntegrationIds?: string[];
};

const LIVE_SUBSCRIPTION: RecurringSubscriptionStatus[] = [
  "pending_first_payment",
  "active",
  "past_due",
];

/** Applies one verified invoice event in a single transaction. */
export async function processDoitInvoiceEvent(
  context: ScopedTenantContext,
  event: DoitInvoiceEvent,
  now: Date,
  options: InvoiceEventOptions = {},
): Promise<InvoiceEventResult> {
  const tenantId = context.tenant.tenantId;
  const invoice = event.data.invoice;
  return withTenant(db, context, async (tx): Promise<InvoiceEventResult> => {
    const [locked] = await tx
      .select()
      .from(paymentRecurringSubscriptions)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(
            paymentRecurringSubscriptions.providerSubscriptionId,
            invoice.subscription_id,
          ),
        ),
      )
      .for("update");
    // A row without a provider id (provisioning) never matches here.
    if (!locked) return { outcome: "unknown_subscription" };
    const bound = locked.gatewayIntegrationId.toLowerCase();
    const accepted = [
      options.verifiedIntegrationId,
      ...(options.acceptedIntegrationIds ?? []),
    ].some((id) => !!id && id.toLowerCase() === bound);
    if (!accepted) return { outcome: "ignored", code: "INTEGRATION_MISMATCH" };
    const [plan] = await tx
      .select()
      .from(paymentRecurringPlans)
      .where(
        and(
          eq(paymentRecurringPlans.tenantId, tenantId),
          eq(paymentRecurringPlans.id, locked.planId),
        ),
      );
    if (!plan) return { outcome: "ignored", code: "PLAN_MISSING" };
    // A paid next period whose start date has come moves in first, so the
    // continuity check below sees the real state of the subscription.
    const subscription = await withDuePromotion(tx, tenantId, locked, now);

    // Server truth: the plan, not the payload, says what an invoice costs.
    const reviewReason =
      invoice.plan_id !== plan.providerPlanId
        ? "PLAN_MISMATCH"
        : invoice.amount !== plan.amountIdr
          ? "AMOUNT_MISMATCH"
          : periodMismatch(
                plan,
                subscription,
                invoice.period_start,
                invoice.period_end,
              )
            ? "PERIOD_MISMATCH"
            : null;

    if (event.type === "invoice.created")
      return applyInvoiceCreated(tx, context, {
        event,
        subscription,
        plan,
        reviewReason,
        now,
        sourceEventId: options.sourceEventId ?? null,
      });
    return applyInvoicePaid(tx, {
      context,
      event,
      subscription,
      plan,
      reviewReason,
      now,
      sourceEventId: options.sourceEventId ?? null,
      storeUnseen: options.storeUnseenPaidForReview === true,
    });
  });
}

async function findInvoice(
  tx: Tx,
  tenantId: TenantId,
  providerInvoiceId: string,
  lock: boolean,
): Promise<SubscriptionInvoice | null> {
  const query = tx
    .select()
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.tenantId, tenantId),
        eq(subscriptionInvoices.providerInvoiceId, providerInvoiceId),
      ),
    );
  const rows = lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

/** Another invoice already open or paid for this period of the subscription
 * (the partial unique index allows only one). */
async function periodTaken(
  tx: Tx,
  tenantId: TenantId,
  subscriptionId: string,
  periodStart: string,
): Promise<boolean> {
  const [found] = await tx
    .select({ id: subscriptionInvoices.id })
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.tenantId, tenantId),
        eq(subscriptionInvoices.subscriptionId, subscriptionId),
        eq(subscriptionInvoices.periodStart, periodStart),
        inArray(subscriptionInvoices.status, ["open", "paid"]),
      ),
    );
  return found !== undefined;
}

/** Review reason of an invoice parked behind an unpaid previous period. */
const AWAITING_PREVIOUS_PERIOD = "AWAITING_PREVIOUS_PERIOD";

/** True when the invoice is a valid period of the plan that starts exactly
 * where an unpaid invoice of the subscription (open, or itself parked) ends:
 * it is next in line, not wrong. Anything else stays PERIOD_MISMATCH. */
async function awaitsPreviousPeriod(
  tx: Tx,
  tenantId: TenantId,
  plan: PaymentRecurringPlan,
  subscription: PaymentRecurringSubscription,
  invoice: DoitInvoiceEvent["data"]["invoice"],
): Promise<boolean> {
  if (invoice.period_end !== addInterval(invoice.period_start, plan.interval))
    return false;
  const boundary = subscription.nextPeriodEnd ?? subscription.currentPeriodEnd;
  if (boundary === null || invoice.period_start <= boundary) return false;
  const [previous] = await tx
    .select({ id: subscriptionInvoices.id })
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.tenantId, tenantId),
        eq(subscriptionInvoices.subscriptionId, subscription.id),
        eq(subscriptionInvoices.periodEnd, invoice.period_start),
        or(
          eq(subscriptionInvoices.status, "open"),
          and(
            eq(subscriptionInvoices.status, "needs_review"),
            eq(subscriptionInvoices.reviewReason, AWAITING_PREVIOUS_PERIOD),
          ),
        ),
      ),
    )
    .limit(1);
  return previous !== undefined;
}

async function notifyInvoiceCreated(
  tx: Tx,
  context: ScopedTenantContext,
  subscription: PaymentRecurringSubscription,
  plan: PaymentRecurringPlan,
  invoice: SubscriptionInvoice,
  now: Date,
): Promise<void> {
  await appendNotificationEvent(tx, context, subscriptionInvoiceCreatedEvent, {
    aggregateId: invoice.id,
    outletId: subscription.outletId,
    actorUserId: null,
    payload: {
      subscriptionInvoiceId: invoice.id,
      subscriptionId: subscription.id,
      customerProfileId: subscription.customerProfileId,
      planName: plan.name,
      amountIdr: invoice.amountIdr,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      hostedUrl: invoice.hostedUrl,
    },
    now,
  });
}

async function applyInvoiceCreated(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    event: DoitInvoiceEvent;
    subscription: PaymentRecurringSubscription;
    plan: PaymentRecurringPlan;
    reviewReason: string | null;
    now: Date;
    sourceEventId: string | null;
  },
): Promise<InvoiceEventResult> {
  const tenantId = context.tenant.tenantId;
  const { subscription, plan, reviewReason, now } = input;
  const invoice = input.event.data.invoice;

  // Replay: the stored row wins, nothing is notified or changed again.
  if (await findInvoice(tx, tenantId, invoice.id, false))
    return { outcome: "processed", code: "DUPLICATE" };

  // `invoice.created` never proves payment: a `paid` payload is stored open
  // and only an `invoice.paid` event can settle it.
  let status: "open" | "void" | "expired" | "needs_review" = reviewReason
    ? "needs_review"
    : invoice.status === "void" || invoice.status === "expired"
      ? invoice.status
      : "open";
  let storedReason = reviewReason;
  // Brief 488 item 8: a period that follows an unpaid one is parked, not
  // refused for good; it is re-evaluated once the previous period is paid.
  if (
    reviewReason === "PERIOD_MISMATCH" &&
    (await awaitsPreviousPeriod(tx, tenantId, plan, subscription, invoice))
  )
    storedReason = AWAITING_PREVIOUS_PERIOD;
  // A second invoice for a period already open/paid is never dropped: kept
  // for review, not notified, never able to activate.
  if (
    status === "open" &&
    (await periodTaken(tx, tenantId, subscription.id, invoice.period_start))
  ) {
    status = "needs_review";
    storedReason = "DUPLICATE_PERIOD";
  }
  const notify =
    status === "open" && LIVE_SUBSCRIPTION.includes(subscription.status);

  const [inserted] = await tx
    .insert(subscriptionInvoices)
    .values({
      tenantId,
      outletId: subscription.outletId,
      subscriptionId: subscription.id,
      providerInvoiceId: invoice.id,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
      amountIdr: idr(invoice.amount),
      hostedUrl: invoice.hosted_url,
      status,
      reviewReason: storedReason,
      notifiedAt: notify ? now : null,
      sourceEventId: input.sourceEventId,
    })
    // Only a replay can still conflict here (unique provider invoice id); the
    // subscription row is locked, so the period check above cannot race.
    .onConflictDoNothing()
    .returning();
  if (!inserted) return { outcome: "processed", code: "DUPLICATE" };

  if (notify)
    await notifyInvoiceCreated(tx, context, subscription, plan, inserted, now);
  else if (storedReason)
    logger.warn(
      { subscriptionInvoiceId: inserted.id, reviewReason: storedReason },
      "Recurring invoice stored for review, customer not notified",
    );
  return { outcome: "processed", code: storedReason };
}

/** Terminal review reason for a paid payload on a parked invoice, or null when
 * the parked invoice may still be released. PERIOD_MISMATCH is expected (the
 * period lies beyond the unpaid previous one); anything else is wrong. */
function parkedPaymentTerminalReason(
  input: {
    event: DoitInvoiceEvent;
    subscription: PaymentRecurringSubscription;
    reviewReason: string | null;
  },
  stored: SubscriptionInvoice,
): string | null {
  const invoice = input.event.data.invoice;
  if (input.reviewReason && input.reviewReason !== "PERIOD_MISMATCH")
    return input.reviewReason;
  if (invoice.amount !== stored.amountIdr) return "AMOUNT_MISMATCH";
  if (
    invoice.period_start !== stored.periodStart ||
    invoice.period_end !== stored.periodEnd
  )
    return "PERIOD_MISMATCH";
  const status = input.subscription.status;
  if (status === "cancelled") return "SUBSCRIPTION_CANCELLED";
  if (status === "paused") return "SUBSCRIPTION_PAUSED";
  if (status === "needs_reconcile" || status === "provisioning")
    return "SUBSCRIPTION_NEEDS_RECONCILE";
  return null;
}

async function applyInvoicePaid(
  tx: Tx,
  input: {
    context: ScopedTenantContext;
    event: DoitInvoiceEvent;
    subscription: PaymentRecurringSubscription;
    plan: PaymentRecurringPlan;
    reviewReason: string | null;
    now: Date;
    sourceEventId: string | null;
    storeUnseen: boolean;
  },
): Promise<InvoiceEventResult> {
  const tenantId = input.context.tenant.tenantId;
  const { subscription, plan, now } = input;
  const invoice = input.event.data.invoice;

  // The payload itself must say paid. Checked before anything is looked up or
  // stored: an `invoice.paid` event whose invoice is still open (also one never
  // seen) proves no payment and leaves no row behind.
  if (invoice.status !== "paid")
    return { outcome: "ignored", code: "PAYLOAD_NOT_PAID" };

  const stored = await findInvoice(tx, tenantId, invoice.id, true);
  if (!stored) {
    if (!input.storeUnseen) return { outcome: "unknown_invoice" };
    // Money arrived for an invoice never seen: keep it visible, grant nothing.
    const unseenReason = (await periodTaken(
      tx,
      tenantId,
      subscription.id,
      invoice.period_start,
    ))
      ? "DUPLICATE_PERIOD"
      : "INVOICE_NOT_SEEN";
    const [inserted] = await tx
      .insert(subscriptionInvoices)
      .values({
        tenantId,
        outletId: subscription.outletId,
        subscriptionId: subscription.id,
        providerInvoiceId: invoice.id,
        periodStart: invoice.period_start,
        periodEnd: invoice.period_end,
        amountIdr: idr(invoice.amount),
        hostedUrl: invoice.hosted_url,
        status: "needs_review",
        reviewReason: unseenReason,
        // The payload says paid: record when, like every other paid path.
        paidAt: invoice.paid_at ? new Date(invoice.paid_at) : now,
        sourceEventId: input.sourceEventId,
      })
      .onConflictDoNothing()
      .returning({ id: subscriptionInvoices.id });
    if (!inserted) return { outcome: "processed", code: "DUPLICATE" };
    logger.warn(
      { subscriptionInvoiceId: inserted.id, reviewReason: unseenReason },
      "Paid recurring invoice never seen before, stored for review",
    );
    return { outcome: "processed", code: unseenReason };
  }

  if (stored.subscriptionId !== subscription.id)
    return { outcome: "ignored", code: "SUBSCRIPTION_MISMATCH" };
  // Replay of an applied payment, or an invoice already under review.
  if (stored.status === "paid")
    return { outcome: "processed", code: "DUPLICATE" };
  // Already under review: the money is real, so record when it was paid, but
  // the invoice stays `needs_review` and nothing is activated.
  if (stored.status === "needs_review") {
    // A parked invoice (AWAITING_PREVIOUS_PERIOD) is released later and then
    // gets access. The payment must therefore be checked now: when the paid
    // payload is wrong or the subscription cannot take it, the invoice becomes
    // terminal (no access, ever) instead of waiting to be released.
    const terminal =
      stored.reviewReason === AWAITING_PREVIOUS_PERIOD
        ? parkedPaymentTerminalReason(input, stored)
        : null;
    if (stored.paidAt === null || terminal)
      await tx
        .update(subscriptionInvoices)
        .set({
          ...(terminal ? { reviewReason: terminal } : {}),
          paidAt:
            stored.paidAt ??
            (invoice.paid_at ? new Date(invoice.paid_at) : now),
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptionInvoices.tenantId, tenantId),
            eq(subscriptionInvoices.id, stored.id),
          ),
        );
    if (terminal)
      logger.warn(
        { subscriptionInvoiceId: stored.id, reviewReason: terminal },
        "Paid parked recurring invoice is not valid, no access granted",
      );
    return { outcome: "processed", code: terminal ?? stored.reviewReason };
  }

  // Money arrived, access may not be granted: flag it, change nothing else.
  const review =
    input.reviewReason ??
    (invoice.amount !== stored.amountIdr ? "AMOUNT_MISMATCH" : null) ??
    // The stored period is what would be granted: it must still fit the plan
    // and the subscription, and the payload must not claim another one.
    (invoice.period_start !== stored.periodStart ||
    invoice.period_end !== stored.periodEnd ||
    periodMismatch(plan, subscription, stored.periodStart, stored.periodEnd)
      ? "PERIOD_MISMATCH"
      : null) ??
    (stored.status === "void"
      ? "PAID_AFTER_VOID"
      : stored.status === "expired"
        ? "PAID_AFTER_EXPIRED"
        : null) ??
    (subscription.status === "cancelled"
      ? "SUBSCRIPTION_CANCELLED"
      : subscription.status === "paused"
        ? "SUBSCRIPTION_PAUSED"
        : subscription.status === "provisioning" ||
            subscription.status === "needs_reconcile"
          ? "SUBSCRIPTION_NEEDS_RECONCILE"
          : null);
  if (review) {
    await tx
      .update(subscriptionInvoices)
      .set({
        status: "needs_review",
        reviewReason: review,
        paidAt: invoice.paid_at ? new Date(invoice.paid_at) : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(subscriptionInvoices.tenantId, tenantId),
          eq(subscriptionInvoices.id, stored.id),
        ),
      );
    logger.warn(
      { subscriptionInvoiceId: stored.id, reviewReason: review },
      "Paid recurring invoice needs review, no access granted",
    );
    return { outcome: "processed", code: review };
  }

  // stored.status === "open" here (every other status returned above).
  await tx
    .update(subscriptionInvoices)
    .set({
      status: "paid",
      paidAt: invoice.paid_at ? new Date(invoice.paid_at) : now,
      updatedAt: now,
    })
    .where(
      and(
        eq(subscriptionInvoices.tenantId, tenantId),
        eq(subscriptionInvoices.id, stored.id),
        eq(subscriptionInvoices.status, "open"),
      ),
    );

  await settlePaidPeriod(tx, tenantId, subscription, stored, now);
  await releaseParkedInvoices(tx, input.context, plan, subscription.id, now);
  return { outcome: "processed", code: null };
}

/** Moves the subscription to the period of an invoice just marked paid. Only
 * for a period beyond what is already covered; access never comes from
 * anything else. */
async function settlePaidPeriod(
  tx: Tx,
  tenantId: TenantId,
  subscription: PaymentRecurringSubscription,
  stored: Pick<SubscriptionInvoice, "periodStart" | "periodEnd">,
  now: Date,
): Promise<void> {
  const first = subscription.status === "pending_first_payment";
  const today = businessDateOf(now);
  const live = or(
    eq(paymentRecurringSubscriptions.status, "pending_first_payment"),
    eq(paymentRecurringSubscriptions.status, "active"),
    eq(paymentRecurringSubscriptions.status, "past_due"),
  );
  // A period that starts later than today never changes what is current: it
  // waits in the next slot until its start date (promotion). Only for a row
  // that has a current period or is still waiting for its first payment.
  if (
    stored.periodStart > today &&
    (subscription.currentPeriodEnd !== null || first)
  ) {
    // Only a period beyond everything already covered or waiting is stored.
    const covered = subscription.nextPeriodEnd ?? subscription.currentPeriodEnd;
    if (covered !== null && stored.periodEnd <= covered) return;
    // A second early period joins the first one: the waiting window keeps its
    // start and its end moves to the new period's end, but only when the new
    // period starts exactly where the covered range ends. Otherwise the stored
    // window is left as it is (never replaced, never widened by a gap).
    const continuous = covered === null || stored.periodStart === covered;
    await tx
      .update(paymentRecurringSubscriptions)
      .set({
        nextPeriodStart: subscription.nextPeriodStart ?? stored.periodStart,
        nextPeriodEnd: continuous
          ? stored.periodEnd
          : subscription.nextPeriodEnd,
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, subscription.id),
          live,
        ),
      );
    return;
  }

  // The period only moves forward: a late or replayed older invoice never
  // shortens it.
  const advances =
    subscription.currentPeriodEnd === null ||
    stored.periodEnd > subscription.currentPeriodEnd;
  // Access is granted only for a period that moves forward and has not
  // already ended (the end date is exclusive: start + one interval);
  // otherwise the invoice is just marked paid.
  const grants = advances && stored.periodEnd > today;
  if (!advances) return;
  await tx
    .update(paymentRecurringSubscriptions)
    .set({
      ...(grants ? { status: "active" as const } : {}),
      ...(grants && first ? { activatedAt: now } : {}),
      currentPeriodStart: stored.periodStart,
      currentPeriodEnd: stored.periodEnd,
      updatedAt: now,
    })
    .where(
      and(
        eq(paymentRecurringSubscriptions.tenantId, tenantId),
        eq(paymentRecurringSubscriptions.id, subscription.id),
        live,
      ),
    );
}

/** Re-evaluates the invoices parked behind the period that was just paid
 * (brief 488 item 8). The one that now directly follows the covered range
 * becomes `open` and the customer is notified, as for any new invoice; if the
 * customer already paid it (money arrived while it was parked) it is settled
 * like any paid invoice and the next one is looked at. An unpaid invoice stops
 * the walk: nothing after it moves, and no access comes from an unpaid
 * invoice. Runs under the subscription row lock of the webhook transaction. */
async function releaseParkedInvoices(
  tx: Tx,
  context: ScopedTenantContext,
  plan: PaymentRecurringPlan,
  subscriptionId: string,
  now: Date,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  // Bounded: one pass per parked period, never an endless loop.
  for (let step = 0; step < 24; step += 1) {
    const [row] = await tx
      .select()
      .from(paymentRecurringSubscriptions)
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, subscriptionId),
        ),
      );
    if (!row || !LIVE_SUBSCRIPTION.includes(row.status)) return;
    const subscription = await withDuePromotion(tx, tenantId, row, now);
    const boundary =
      subscription.nextPeriodEnd ?? subscription.currentPeriodEnd;
    if (boundary === null) return;
    const [parked] = await tx
      .select()
      .from(subscriptionInvoices)
      .where(
        and(
          eq(subscriptionInvoices.tenantId, tenantId),
          eq(subscriptionInvoices.subscriptionId, subscriptionId),
          eq(subscriptionInvoices.status, "needs_review"),
          eq(subscriptionInvoices.reviewReason, AWAITING_PREVIOUS_PERIOD),
          eq(subscriptionInvoices.periodStart, boundary),
        ),
      )
      .limit(1)
      .for("update");
    if (!parked) return;

    // Still the server truth: the plan price and the plan interval.
    const stillValid =
      parked.amountIdr === plan.amountIdr &&
      parked.periodEnd === addInterval(parked.periodStart, plan.interval);
    const taken =
      stillValid &&
      (await periodTaken(tx, tenantId, subscriptionId, parked.periodStart));
    if (!stillValid || taken) {
      await tx
        .update(subscriptionInvoices)
        .set({
          reviewReason: stillValid ? "DUPLICATE_PERIOD" : "AMOUNT_MISMATCH",
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptionInvoices.tenantId, tenantId),
            eq(subscriptionInvoices.id, parked.id),
          ),
        );
      return;
    }

    const paid = parked.paidAt !== null;
    const [released] = await tx
      .update(subscriptionInvoices)
      .set({
        status: paid ? "paid" : "open",
        reviewReason: null,
        notifiedAt: paid ? parked.notifiedAt : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(subscriptionInvoices.tenantId, tenantId),
          eq(subscriptionInvoices.id, parked.id),
          eq(subscriptionInvoices.status, "needs_review"),
        ),
      )
      .returning();
    if (!released) return;
    if (!paid) {
      await notifyInvoiceCreated(
        tx,
        context,
        subscription,
        plan,
        released,
        now,
      );
      return;
    }
    await settlePaidPeriod(tx, tenantId, subscription, released, now);
  }
}
