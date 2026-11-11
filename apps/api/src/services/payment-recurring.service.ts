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
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import { customerProfiles } from "../db/schema/crm-member";
import {
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

/** `YYYY-MM-DD` plus one plan interval: a week is 7 days, a month is one
 * calendar month with the day clamped to the month end (Jan 31 -> Feb 28),
 * like Postgres `date + interval '1 month'`. */
function addInterval(date: string, interval: RecurringPlanInterval): string {
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

/** Marks a start whose outcome at the gateway is unconfirmed. Guarded: only a
 * row that never got a provider id moves, and a failed write is logged, never
 * allowed to hide the original error. */
async function markStartNeedsReconcile(
  context: ScopedTenantContext,
  subscriptionId: string,
  reason: "PROVIDER_ERROR" | "DUPLICATE_AT_PROVIDER" | "PLAN_MISMATCH",
): Promise<void> {
  try {
    await withTenant(db, context, (tx) =>
      tx
        .update(paymentRecurringSubscriptions)
        .set({
          status: "needs_reconcile",
          reconcileReason: reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentRecurringSubscriptions.tenantId, context.tenant.tenantId),
            eq(paymentRecurringSubscriptions.id, subscriptionId),
            isNull(paymentRecurringSubscriptions.providerSubscriptionId),
            inArray(paymentRecurringSubscriptions.status, [
              "provisioning",
              "needs_reconcile",
            ]),
          ),
        ),
    );
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
  const { plan, customerFound, existing } = await withTenant(
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
      return {
        plan: found ?? null,
        customerFound: customer !== undefined,
        existing: replay ?? null,
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
  } else {
    if (plan.status !== "active")
      throw new CoreError("CONFLICT", "Paket sudah tidak aktif.");
    if (!customerFound) throw notFound("Pelanggan");
  }

  // Before anything is stored: a disabled integration leaves no row behind.
  const client = await clientLoader(deps)(
    context,
    plan.outletId,
    plan.gatewayIntegrationId,
    "bill",
  );

  const intent =
    existing ??
    (await withTenant(db, context, async (tx) => {
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
      if (
        !raced ||
        raced.planId !== plan.id ||
        raced.customerProfileId !== input.customerProfileId
      )
        throw KEY_REUSED();
      return raced;
    }));
  if (intent.providerSubscriptionId !== null)
    return { subscription: intent, firstInvoiceUrl: null };

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
    await markStartNeedsReconcile(context, intent.id, "PLAN_MISMATCH");
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
    // Not updated: a concurrent retry finished it first; return what is stored.
    return updated ?? loadSubscription(tx, context, intent.id);
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

/** True while the subscription is `active` and today (Asia/Jakarta) is inside
 * the current period or inside the paid next period; the start is inclusive,
 * the end exclusive. Every other status (pending, past_due, paused, cancelled,
 * provisioning, needs_reconcile) never has access. */
export function subscriptionHasAccess(
  subscription: Pick<
    PaymentRecurringSubscription,
    | "status"
    | "currentPeriodStart"
    | "currentPeriodEnd"
    | "nextPeriodStart"
    | "nextPeriodEnd"
  >,
  now: Date,
): boolean {
  if (subscription.status !== "active") return false;
  const today = businessDateOf(now);
  const inside = (start: string | null, end: string | null) =>
    start !== null && end !== null && start <= today && today < end;
  return (
    inside(subscription.currentPeriodStart, subscription.currentPeriodEnd) ||
    inside(subscription.nextPeriodStart, subscription.nextPeriodEnd)
  );
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
  if (action === "pause" && !["active", "past_due"].includes(current.status))
    throw new CoreError("CONFLICT", "Hanya langganan aktif yang dapat dijeda.");
  if (action === "resume" && current.status !== "paused")
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
    const patch: Partial<typeof paymentRecurringSubscriptions.$inferInsert> = {
      updatedAt: now,
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
    return action === "resume"
      ? withDuePromotion(tx, tenantId, updated, now)
      : updated;
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
    await appendNotificationEvent(
      tx,
      context,
      subscriptionInvoiceCreatedEvent,
      {
        aggregateId: inserted.id,
        outletId: subscription.outletId,
        actorUserId: null,
        payload: {
          subscriptionInvoiceId: inserted.id,
          subscriptionId: subscription.id,
          customerProfileId: subscription.customerProfileId,
          planName: plan.name,
          amountIdr: inserted.amountIdr,
          periodStart: inserted.periodStart,
          periodEnd: inserted.periodEnd,
          hostedUrl: inserted.hostedUrl,
        },
        now,
      },
    );
  else if (storedReason)
    logger.warn(
      { subscriptionInvoiceId: inserted.id, reviewReason: storedReason },
      "Recurring invoice stored for review, customer not notified",
    );
  return { outcome: "processed", code: storedReason };
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
    if (stored.paidAt === null)
      await tx
        .update(subscriptionInvoices)
        .set({
          paidAt: invoice.paid_at ? new Date(invoice.paid_at) : now,
          updatedAt: now,
        })
        .where(
          and(
            eq(subscriptionInvoices.tenantId, tenantId),
            eq(subscriptionInvoices.id, stored.id),
          ),
        );
    return { outcome: "processed", code: stored.reviewReason };
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
    if (covered !== null && stored.periodEnd <= covered)
      return { outcome: "processed", code: null };
    await tx
      .update(paymentRecurringSubscriptions)
      .set({
        nextPeriodStart: stored.periodStart,
        nextPeriodEnd: stored.periodEnd,
        updatedAt: now,
      })
      .where(
        and(
          eq(paymentRecurringSubscriptions.tenantId, tenantId),
          eq(paymentRecurringSubscriptions.id, subscription.id),
          live,
        ),
      );
    return { outcome: "processed", code: null };
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
  if (!advances) return { outcome: "processed", code: null };
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
  return { outcome: "processed", code: null };
}
