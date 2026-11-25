// Facility subscription quota (bead legend-9f1p3; PRD v1.7 §3 F25 "Langganan
// Bulanan" + recurring billing grace). Turns a paid DOIT subscription into
// entitlement grants. Money rules ("jangan sampai rugi", doubt = limit):
//
// - One quota per plan interval (a "slice") per subscription, across ALL
//   facilities: dedup and lock are per (subscription, slice), never per
//   facility, so moving the facility plan from A to B inside a slice never gives
//   a second quota. A slice is `[S, S + interval)` where S is the paid period
//   start plus whole intervals, S <= today. The grant key never holds the plan
//   id or the facility.
// - Paid slice: one grant (G2) of `quota - used` sessions, where `used` is what
//   the customer already drew from the grace grants (G1) of the same slice. It
//   expires at the end of the slice (Jakarta midnight).
// - Grace (the access check says `inGrace`): issued PER DAY. Each grace day
//   gets one grant of `maxPerDay ?? 1` sessions that is valid that day only
//   (expires at the next Jakarta midnight), capped so the grace grants of the
//   slice never add up to more than the quota. Days that were skipped are not
//   back-filled. This is the limiting reading of the founder W5 rule (a grace
//   day cannot give more than a day of use); the founder may still change it.
// - Late payment: under the locks the unused rest of every G1 is cancelled and
//   G2 gets `quota - used`, so a slice never holds more than its quota.
// - Revoke: when the subscription is not `active` any more (paused, cancelled,
//   past_due, ...) or the grace no longer covers today, the unused part of the
//   live grace grants is cancelled (one `cancel` row per grant, on the grant's
//   own facility). Used sessions and paid grants stay. The status is read under
//   the subscription lock.
// - No access (grace 0 past the end, past grace, past_due, paused, cancelled,
//   pending, needs_reconcile) writes nothing; old grants stop at `expires_at`.
// - The grace days are read per outlet, in the same transaction, through
//   `readRecurringGraceDays` (never a hard-coded 3).
// - The facility plan is found only by (tenant, outlet, provider plan id): it
//   must be exactly one active row with the same interval (month) as the
//   recurring plan. None, two, or another interval = nothing is granted.
//
// Every write goes through `issueEntitlement` (idempotent per source ref) and
// `cancelEntitlementsForSource`, serialised per subscription (advisory lock)
// and per customer by `lockCustomer`, so a repeat or racing run changes nothing.
import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ScopedTenantContext, TenantId } from "@starter/shared/core";
import { RECURRING_GRACE_DAYS_MAX } from "@starter/shared/payment/recurring";
import { db } from "../db";
import { facilitySubscriptionPlans } from "../db/schema/facility.ts";
import { entitlementLedger } from "../db/schema/facility-entitlement.ts";
import {
  paymentRecurringPlans,
  paymentRecurringSubscriptions,
} from "../db/schema/payment-recurring";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import {
  cancelEntitlementsForSource,
  issueEntitlement,
  lockCustomer,
  type LedgerRow,
} from "./facility-entitlement.service.ts";
import {
  addInterval,
  businessDayStart,
  readRecurringGraceDays,
  subscriptionAccessPeriod,
} from "./payment-recurring.service";
import type { Tx } from "./facility-shared.ts";
import { facilityTicketsEnabled } from "./facility-tickets-gate.ts";

/** Upper bound of intervals walked inside one paid window (a bad row must not loop). */
const MAX_SLICES = 240;

const CANCEL_REASON = "Dibayar, sisa tenggang dipindah ke kuota periode";
const REVOKE_REASON =
  "Langganan tidak aktif atau tenggang berakhir, sisa dicabut";
const GRACE_REASON =
  "Masa tenggang setelah periode berbayar (aturan founder W5)";

/** Deterministic UUID-v5-shaped source ref (the ledger holds UUID or ULID, max 40). */
function sourceRefOf(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  const variant = ((parseInt(digest.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/** `YYYY-MM-DD` plus whole days. */
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** Business date (Asia/Jakarta) of an instant, `YYYY-MM-DD`. */
function jakartaDate(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export type SubscriptionQuotaSyncResult = {
  issued: LedgerRow[];
  cancelled: number;
};

const NOTHING: SubscriptionQuotaSyncResult = { issued: [], cancelled: 0 };

/** Serialises every writer of one subscription's quota, whatever the facility. */
async function lockSubscription(
  tx: Tx,
  context: ScopedTenantContext,
  subscriptionId: string,
): Promise<void> {
  const key = `subscription-quota:${context.tenant.tenantId}:${subscriptionId}`;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/** Source ref of the grace grant of one grace day (no facility in the key). */
function graceDayRef(
  subscriptionId: string,
  sliceStart: string,
  day: string,
): string {
  return sourceRefOf(
    `subscription-grace:${subscriptionId}:${sliceStart}:${day}`,
  );
}

/** Every grace-day ref a slice starting at `sliceStart` can hold. */
function graceRefsOf(subscriptionId: string, sliceStart: string): string[] {
  const refs: string[] = [];
  for (let i = 0; i < RECURRING_GRACE_DAYS_MAX; i++)
    refs.push(graceDayRef(subscriptionId, sliceStart, addDays(sliceStart, i)));
  return refs;
}

type GraceGrant = {
  id: string;
  sourceRef: string;
  sessions: number;
  expiresAt: Date | null;
};

/** The grace grants of a slice in any facility of the subscription's customer. */
async function graceGrantsOf(
  tx: Tx,
  tenantId: TenantId,
  subscriptionId: string,
  customerProfileId: string,
  sliceStart: string,
): Promise<GraceGrant[]> {
  const l = entitlementLedger;
  return tx
    .select({
      id: l.id,
      sourceRef: l.sourceRef,
      sessions: l.sessions,
      expiresAt: l.expiresAt,
    })
    .from(l)
    .where(
      and(
        eq(l.tenantId, tenantId),
        eq(l.customerProfileId, customerProfileId),
        eq(l.type, "grant"),
        eq(l.sourceType, "subscription"),
        inArray(l.sourceRef, graceRefsOf(subscriptionId, sliceStart)),
      ),
    );
}

/**
 * Cancels the unused part of the grace grants that are still valid at `now`.
 * Called when there is no access: the grace stops with the access. Takes NO
 * advisory lock: a caller that already holds the subscription row lock (pause,
 * cancel) calls it in the same transaction; the sync takes the advisory lock
 * first. Lock order everywhere: advisory lock, subscription row, customer.
 */
export async function revokeSubscriptionGrace(
  tx: Tx,
  context: ScopedTenantContext,
  sub: {
    id: string;
    customerProfileId: string;
    currentPeriodEnd: string | null;
  },
  now: Date,
): Promise<SubscriptionQuotaSyncResult> {
  // The grace slice starts at the old period end (see `subscriptionAccessPeriod`).
  if (!sub.currentPeriodEnd) return NOTHING;
  const grants = await graceGrantsOf(
    tx,
    context.tenant.tenantId,
    sub.id,
    sub.customerProfileId,
    sub.currentPeriodEnd,
  );
  let cancelled = 0;
  for (const grant of grants) {
    if (!grant.expiresAt || grant.expiresAt <= now) continue;
    const closed = await cancelEntitlementsForSource(tx, context, {
      sourceRef: grant.sourceRef,
      sourceTypes: ["subscription"],
      reason: REVOKE_REASON,
      occurredAt: now,
    });
    cancelled += closed.entries.length;
  }
  return { issued: [], cancelled };
}

/**
 * Brings the quota grants of one subscription up to date for `now` (see the
 * header). Idempotent: a second call with the same state writes nothing.
 * `cancelled` is the number of grace grants closed by a late payment.
 */
export async function syncSubscriptionQuota(
  tx: Tx,
  context: ScopedTenantContext,
  input: { subscriptionId: string; now: Date },
): Promise<SubscriptionQuotaSyncResult> {
  const tenantId = context.tenant.tenantId;
  // Lock order: the advisory lock, then the subscription row (`FOR UPDATE`),
  // then the customer lock. The status is read under the row lock: a pause or
  // cancel that holds the row finishes first, so the worker never acts on a
  // stale `active`.
  await lockSubscription(tx, context, input.subscriptionId);
  const s = paymentRecurringSubscriptions;
  const [sub] = await tx
    .select()
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.id, input.subscriptionId)))
    .limit(1)
    .for("update");
  if (!sub) return NOTHING;
  if (sub.status !== "active")
    return revokeSubscriptionGrace(tx, context, sub, input.now);

  // Read under the lock, in the same transaction, from this outlet's setting.
  const graceDays = await readRecurringGraceDays(tx, tenantId, sub.outletId);
  const period = subscriptionAccessPeriod(sub, input.now, graceDays);
  if (!period) return revokeSubscriptionGrace(tx, context, sub, input.now);

  // 1269 F0: no new subscription quota while facility tickets are off. The
  // grace revoke above still runs, so an old grant can be closed.
  if (!facilityTicketsEnabled()) return NOTHING;

  const p = paymentRecurringPlans;
  const [plan] = await tx
    .select()
    .from(p)
    .where(and(eq(p.tenantId, tenantId), eq(p.id, sub.planId)))
    .limit(1);
  if (!plan || plan.interval !== "month") return NOTHING;

  const f = facilitySubscriptionPlans;
  const facilityPlans = await tx
    .select()
    .from(f)
    .where(
      and(
        eq(f.tenantId, tenantId),
        eq(f.outletId, sub.outletId),
        eq(f.providerPlanId, plan.providerPlanId),
      ),
    )
    .limit(2);
  const facilityPlan = facilityPlans.length === 1 ? facilityPlans[0] : null;
  if (
    !facilityPlan ||
    !facilityPlan.isActive ||
    facilityPlan.interval !== "month"
  )
    return NOTHING;
  // Money: the customer pays the recurring plan amount. A facility plan with a
  // different price must not grant its quota (doubt = grant nothing).
  if (facilityPlan.priceIdr !== plan.amountIdr) {
    logger.warn(
      {
        subscriptionId: sub.id,
        facilityPlanId: facilityPlan.id,
        recurringPlanId: plan.id,
      },
      "Facility plan price differs from the recurring plan amount, no quota granted",
    );
    return NOTHING;
  }

  await lockCustomer(
    tx,
    context,
    sub.customerProfileId,
    facilityPlan.facilityId,
  );

  // Slice start: the grace slice starts at the old period end; inside a paid
  // window it is the latest start (period start + whole intervals) <= today.
  const today = jakartaDate(input.now);
  let sliceStart = period.start;
  if (!period.inGrace) {
    for (let i = 0; i < MAX_SLICES; i++) {
      const next = addInterval(sliceStart, plan.interval);
      if (next > today) break;
      sliceStart = next;
    }
  }
  if (sliceStart > today) return NOTHING;

  const quota = facilityPlan.quotaPerPeriod;
  const paidRef = sourceRefOf(`subscription:${sub.id}:${sliceStart}`);
  const base = {
    facilityId: facilityPlan.facilityId,
    customerProfileId: sub.customerProfileId,
    source: "subscription" as const,
    ruleId: null,
    conditionsMet: true,
    occurredAt: input.now,
  };
  // Dedup across facilities: a grant of this slice in ANY facility counts.
  const [paid] = await tx
    .select({ id: entitlementLedger.id })
    .from(entitlementLedger)
    .where(ledgerGrantOf(tenantId, base.customerProfileId, paidRef))
    .limit(1);
  const graceGrants = await graceGrantsOf(
    tx,
    tenantId,
    sub.id,
    sub.customerProfileId,
    sliceStart,
  );

  if (period.inGrace) {
    // A paid grant of this slice already holds the quota: no grace on top.
    if (paid) return NOTHING;
    const todayRef = graceDayRef(sub.id, sliceStart, today);
    if (graceGrants.some((grant) => grant.sourceRef === todayRef))
      return NOTHING;
    const granted = graceGrants.reduce((sum, grant) => sum + grant.sessions, 0);
    const sessions = Math.min(facilityPlan.maxPerDay ?? 1, quota - granted);
    if (sessions < 1) return NOTHING;
    const result = await issueEntitlement(tx, context, {
      ...base,
      sourceRef: todayRef,
      sessions,
      // Valid on this grace day only.
      expiresAt: businessDayStart(addDays(today, 1)),
      // Grace is granted by the founder W5 rule after a paid period; the
      // contract check wants a paid subscription source.
      paid: true,
      reason: GRACE_REASON,
    });
    return {
      issued: result.status === "issued" ? [result.entry] : [],
      cancelled: 0,
    };
  }

  // A grant of this slice already exists (maybe in another facility).
  if (paid) return NOTHING;

  // Paid slice: close what is left of the grace grants, then grant the rest of
  // the quota. Total of the slice = quota, never more.
  let cancelled = 0;
  for (const ref of new Set(graceGrants.map((grant) => grant.sourceRef))) {
    const closed = await cancelEntitlementsForSource(tx, context, {
      sourceRef: ref,
      sourceTypes: ["subscription"],
      reason: CANCEL_REASON,
      occurredAt: input.now,
    });
    cancelled += closed.entries.length;
  }
  let used = 0;
  if (graceGrants.length > 0) {
    const [drawn] = await tx
      .select({
        used: sql<number>`COALESCE(SUM(${entitlementLedger.sessions}), 0)::int`,
      })
      .from(entitlementLedger)
      .where(
        and(
          eq(entitlementLedger.tenantId, tenantId),
          eq(entitlementLedger.type, "redeem"),
          inArray(
            entitlementLedger.grantEntryId,
            graceGrants.map((grant) => grant.id),
          ),
        ),
      );
    used = Number(drawn?.used ?? 0);
  }
  const sessions = quota - used;
  if (sessions < 1) return { issued: [], cancelled };
  const result = await issueEntitlement(tx, context, {
    ...base,
    sourceRef: paidRef,
    sessions,
    expiresAt: businessDayStart(addInterval(sliceStart, plan.interval)),
    paid: true,
    reason: `Kuota langganan ${sliceStart}`,
  });
  return {
    issued: result.status === "issued" ? [result.entry] : [],
    cancelled,
  };
}

function ledgerGrantOf(
  tenantId: TenantId,
  customerProfileId: string,
  sourceRef: string,
) {
  const l = entitlementLedger;
  return and(
    eq(l.tenantId, tenantId),
    eq(l.customerProfileId, customerProfileId),
    eq(l.type, "grant"),
    eq(l.sourceType, "subscription"),
    eq(l.sourceRef, sourceRef),
  );
}

/**
 * Worker sweep: syncs every `active` subscription of the tenant (and every
 * other one whose customer still holds a live subscription grant), each in its
 * own transaction (a lock is held only for one subscription, so the sweep
 * cannot deadlock with a pause) and one bad row rolls back alone. Returns the number of
 * subscriptions whose ledger changed.
 */
export async function syncSubscriptionQuotas(
  context: ScopedTenantContext,
  now: Date,
): Promise<number> {
  const s = paymentRecurringSubscriptions;
  const rows = await withTenant(db, context, async (tx) =>
    tx
      .select({ id: s.id })
      .from(s)
      .where(
        and(
          eq(s.tenantId, context.tenant.tenantId),
          // Active rows get their quota; any other row with a live grant of
          // its customer is visited so its unused grace is revoked.
          or(
            eq(s.status, "active"),
            sql`EXISTS (SELECT 1 FROM entitlement_ledger l WHERE l.tenant_id = ${s.tenantId} AND l.customer_profile_id = ${s.customerProfileId} AND l.type = 'grant' AND l.source_type = 'subscription' AND l.expires_at > ${now})`,
          ),
        ),
      ),
  );
  let changed = 0;
  for (const row of rows) {
    try {
      const result = await withTenant(db, context, (tx) =>
        syncSubscriptionQuota(tx, context, {
          subscriptionId: row.id,
          now,
        }),
      );
      if (result.issued.length > 0 || result.cancelled > 0) changed += 1;
    } catch (error) {
      logger.warn(
        {
          job: "payment_gateway_poll",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Subscription quota sync failed",
      );
    }
  }
  return changed;
}
