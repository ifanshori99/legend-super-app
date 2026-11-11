// Facility subscription quota (bead legend-9f1p3; PRD v1.7 §3 F25 "Langganan
// Bulanan" + recurring billing grace). Turns a paid DOIT subscription into
// entitlement grants. Money rules ("jangan sampai rugi", doubt = limit):
//
// - One quota per plan interval (a "slice") per subscription per facility. A
//   slice is `[S, S + interval)` where S is the paid period start plus whole
//   intervals, S <= today. The grant key never holds the plan id, so a plan
//   change inside a slice never grants a second quota.
// - Paid slice: one grant (G2) of `quota - used` sessions, where `used` is what
//   the customer already drew from the grace grant (G1) of the same slice. It
//   expires at the end of the slice (Jakarta midnight).
// - Grace (the access check says `inGrace`): one grant (G1) of
//   `min(quota, graceDays * (maxPerDay ?? 1))` sessions that expires at the end
//   of the grace days. The cap is the limiting reading of the founder W5 rule
//   (a grace day cannot give more than a day of use); it is a business rule the
//   founder may still change.
// - Late payment: under the customer lock the unused rest of G1 is cancelled and
//   G2 gets `quota - used`, so a slice never holds more than its quota.
// - No access (grace 0 past the end, past grace, past_due, paused, cancelled,
//   pending, needs_reconcile) writes nothing; old grants stop at `expires_at`.
// - The grace days are read per outlet, in the same transaction, through
//   `readRecurringGraceDays` (never a hard-coded 3).
// - The facility plan is found only by (tenant, outlet, provider plan id): it
//   must be exactly one active row with the same interval (month) as the
//   recurring plan. None, two, or another interval = nothing is granted.
//
// Every write goes through `issueEntitlement` (idempotent per source ref) and
// `cancelEntitlementsForSource`, serialised per customer by `lockCustomer`, so a
// repeat or racing run changes nothing.
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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

/** Upper bound of intervals walked inside one paid window (a bad row must not loop). */
const MAX_SLICES = 240;

const CANCEL_REASON = "Dibayar, sisa tenggang dipindah ke kuota periode";
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
  const s = paymentRecurringSubscriptions;
  const [sub] = await tx
    .select()
    .from(s)
    .where(and(eq(s.tenantId, tenantId), eq(s.id, input.subscriptionId)))
    .limit(1);
  if (!sub || sub.status !== "active") return NOTHING;

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
  // Read after the lock, in the same transaction, from this outlet's setting.
  const graceDays = await readRecurringGraceDays(tx, tenantId, sub.outletId);
  const period = subscriptionAccessPeriod(sub, input.now, graceDays);
  if (!period) return NOTHING;

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
  const graceRef = sourceRefOf(`subscription-grace:${sub.id}:${sliceStart}`);
  const paidRef = sourceRefOf(`subscription:${sub.id}:${sliceStart}`);
  const base = {
    facilityId: facilityPlan.facilityId,
    customerProfileId: sub.customerProfileId,
    source: "subscription" as const,
    ruleId: null,
    conditionsMet: true,
    occurredAt: input.now,
  };

  if (period.inGrace) {
    // A paid grant of this slice already holds the quota: no grace on top.
    const [paid] = await tx
      .select({ id: entitlementLedger.id })
      .from(entitlementLedger)
      .where(ledgerGrantOf(tenantId, base, paidRef))
      .limit(1);
    if (paid) return NOTHING;
    const days = Math.min(graceDays, RECURRING_GRACE_DAYS_MAX);
    const sessions = Math.min(quota, days * (facilityPlan.maxPerDay ?? 1));
    if (sessions < 1) return NOTHING;
    const result = await issueEntitlement(tx, context, {
      ...base,
      sourceRef: graceRef,
      sessions,
      expiresAt: businessDayStart(addDays(sliceStart, days)),
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

  // Paid slice: close what is left of the grace grant, then grant the rest of
  // the quota. Total of the slice = quota, never more.
  const closed = await cancelEntitlementsForSource(tx, context, {
    sourceRef: graceRef,
    sourceTypes: ["subscription"],
    reason: CANCEL_REASON,
    occurredAt: input.now,
  });
  const [used] = await tx
    .select({ used: sql<number>`COALESCE(SUM(d.sessions), 0)::int` })
    .from(sql`entitlement_ledger g`)
    .innerJoin(
      sql`entitlement_ledger d`,
      sql`d.tenant_id = g.tenant_id AND d.grant_entry_id = g.id AND d.type = 'redeem'`,
    )
    .where(
      sql`g.tenant_id = ${tenantId} AND g.type = 'grant' AND g.source_type = 'subscription' AND g.source_ref = ${graceRef} AND g.customer_profile_id = ${sub.customerProfileId}`,
    );
  const sessions = quota - Number(used?.used ?? 0);
  if (sessions < 1) return { issued: [], cancelled: closed.entries.length };
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
    cancelled: closed.entries.length,
  };
}

function ledgerGrantOf(
  tenantId: TenantId,
  base: { facilityId: string; customerProfileId: string },
  sourceRef: string,
) {
  const l = entitlementLedger;
  return and(
    eq(l.tenantId, tenantId),
    eq(l.facilityId, base.facilityId),
    eq(l.customerProfileId, base.customerProfileId),
    eq(l.type, "grant"),
    eq(l.sourceType, "subscription"),
    eq(l.sourceRef, sourceRef),
  );
}

/**
 * Worker sweep: syncs every `active` subscription of the tenant, each in its
 * own savepoint so one bad row rolls back alone. Returns the number of
 * subscriptions whose ledger changed.
 */
export async function syncSubscriptionQuotas(
  context: ScopedTenantContext,
  now: Date,
): Promise<number> {
  const s = paymentRecurringSubscriptions;
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({ id: s.id })
      .from(s)
      .where(
        and(eq(s.tenantId, context.tenant.tenantId), eq(s.status, "active")),
      );
    let changed = 0;
    for (const row of rows) {
      try {
        const result = await tx.transaction((savepoint) =>
          syncSubscriptionQuota(savepoint as unknown as Tx, context, {
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
  });
}
