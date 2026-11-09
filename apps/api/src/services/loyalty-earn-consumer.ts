// Loyalty earn consumer (legend-111j, docs/design/ws08-member-loyalty.md §M6).
// Cloud only, wired in worker-main.ts right after the auto-journal consumer.
// Runs inside the outbox consumption transaction, one savepoint per event:
//
// - `order.paid`: the member attached to the order (`orders.customer_profile_id`)
//   earns points on the eligible spend, under the profile lock, through
//   `point-ledger.service.ts` only. The earn record (unique per order) is the
//   replay guard: an existing record stops the event.
// - `order.refunded` / `order.voided` (final order): reverse the earn
//   proportionally (refund, rounds against the member) or fully (void),
//   clamped to the balance; the unreversed rest is kept as a shortfall.
// - `payment.refunded` is not handled: it carries no order id. A QR order has
//   no refund path today (§1); a later card must emit `order.refunded`.
//
// A deterministic bad payload is ignored (the sale itself is journaled
// elsewhere); any other error propagates so the relay retries the event. A
// deadlock between two profile locks (referral step) is retried here, in a
// fresh savepoint.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businessDateSchema,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { pointsForSpend, type LoyaltyProgram } from "@starter/shared/crm";
import type { EventEnvelope } from "@starter/shared/events";
import { withProfileLock } from "../db/member-scope.ts";
import {
  customerProfiles,
  customerVisits,
  loyaltyAnomalies,
  loyaltyPrograms,
  orders,
  pointEarnRecords,
  userIdentities,
} from "../db/schema/index.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import { recordLoyaltyAnomaly } from "./loyalty-anomaly.service.ts";
import { afterVisit as missionAfterVisit } from "./loyalty-earn-mission-step.ts";
import { afterVisit as referralAfterVisit } from "./loyalty-earn-referral-step.ts";
import type {
  EarnProfileRow,
  EarnProgramRow,
  EarnRecordRow,
  EarnStepContext,
} from "./loyalty-earn-step-context.ts";
import { tierMultiplierBp } from "./loyalty-earn-tier-step.ts";
import { loyaltyConsentActive } from "./member-profile.service.ts";
import { postLedgerEntry } from "./point-ledger.service.ts";

const EARN_EVENTS = new Set(["order.paid", "order.refunded", "order.voided"]);
/** Attempts of one event when a profile lock deadlocks. */
const DEADLOCK_ATTEMPTS = 3;

const amount = z.number().int().nonnegative().safe();
const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
const id = z.string().min(1).max(64);
const time = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp");

const orderPaidSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  channel: z.string().min(1).max(20),
  grossSalesIdr: amount,
  discountIdr: amount,
  paidPointsIdr: amount,
  cashierId: z.string().min(1).nullable().default(null),
  paidAt: time,
});

const orderRefundedSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  refundId: id,
  grossSalesIdr: amount,
  discountIdr: amount,
  refundPointsIdr: amount,
});

const orderVoidedSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  voidId: id.nullable(),
  voidedFinalOrder: z.boolean(),
});

type Scope = { context: ScopedTenantContext; tenantId: string; now: Date };

export async function deliverLoyaltyEarnEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<void> {
  if (!EARN_EVENTS.has(event.name)) return;
  if (event.tenantId !== context.tenant.tenantId) return;
  const scope: Scope = { context, tenantId: context.tenant.tenantId, now };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await tx.transaction((savepoint) =>
        handleEvent(savepoint, scope, event.name, event.payload),
      );
      return;
    } catch (error) {
      if (!isDeadlock(error) || attempt >= DEADLOCK_ATTEMPTS) throw error;
    }
  }
}

function isDeadlock(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause
    ?.code;
  return code === "40P01" || causeCode === "40P01";
}

async function handleEvent(
  tx: Tx,
  scope: Scope,
  name: string,
  payload: unknown,
): Promise<void> {
  if (name === "order.paid") {
    const parsed = orderPaidSchema.safeParse(payload);
    if (parsed.success) await earnForPaidOrder(tx, scope, parsed.data);
    return;
  }
  if (name === "order.refunded") {
    const parsed = orderRefundedSchema.safeParse(payload);
    if (!parsed.success) return;
    const data = parsed.data;
    await reverseForOrder(tx, scope, {
      orderId: data.orderId,
      outletId: data.outletId,
      businessDate: data.businessDate,
      sourceType: "refund",
      sourceId: data.refundId,
      refundEligibleIdr: Math.max(
        0,
        data.grossSalesIdr - data.discountIdr - data.refundPointsIdr,
      ),
    });
    return;
  }
  if (name === "order.voided") {
    const parsed = orderVoidedSchema.safeParse(payload);
    if (!parsed.success) return;
    const data = parsed.data;
    if (!data.voidedFinalOrder || data.voidId === null) return;
    await reverseForOrder(tx, scope, {
      orderId: data.orderId,
      outletId: data.outletId,
      businessDate: data.businessDate,
      sourceType: "void",
      sourceId: data.voidId,
      refundEligibleIdr: null,
    });
  }
}

function addMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** The contract program shape `pointsForSpend` reads, built from the row. */
function programDtoOf(row: EarnProgramRow): LoyaltyProgram {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    earnRate: { spendIdr: row.earnSpendIdr, points: row.earnPoints },
    expiryMonths: row.expiryMonths,
    rollingMonths: row.rollingMonths,
    pointValueIdr: row.pointValueIdr,
    referral: row.referral,
    antiFraud: {
      dailyPointCapPerCustomer: row.dailyPointCapPerCustomer,
      employeeSelfServeBan: row.employeeSelfServeBan,
    },
    updatedAt: row.updatedAt.toISOString(),
  } as LoyaltyProgram;
}

async function lockedProfile(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<EarnProfileRow | null> {
  await withProfileLock(tx, tenantId, profileId);
  // Typed re-read under the lock the call above took.
  const [profile] = await tx
    .select()
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId as never),
        eq(customerProfiles.id, profileId),
      ),
    )
    .limit(1);
  return profile ?? null;
}

async function settleRecord(
  tx: Tx,
  scope: Scope,
  record: EarnRecordRow,
  patch: Partial<typeof pointEarnRecords.$inferInsert>,
): Promise<EarnRecordRow> {
  const [row] = await tx
    .update(pointEarnRecords)
    .set({ ...patch, updatedAt: scope.now })
    .where(
      and(
        eq(pointEarnRecords.tenantId, scope.tenantId as never),
        eq(pointEarnRecords.id, record.id),
      ),
    )
    .returning();
  return row ?? record;
}

/** Staff behind the sale: the cashier and the user who attached the member. */
async function isSelfServe(
  tx: Tx,
  profile: EarnProfileRow,
  staffIds: readonly string[],
): Promise<boolean> {
  if (staffIds.length === 0) return false;
  if (profile.userId && staffIds.includes(profile.userId)) return true;
  if (!profile.whatsappHash) return false;
  const [hit] = await tx
    .select({ id: userIdentities.id })
    .from(userIdentities)
    .where(
      and(
        inArray(userIdentities.userId, [...staffIds]),
        eq(userIdentities.type, "whatsapp"),
        isNotNull(userIdentities.verifiedAt),
        eq(userIdentities.valueHash, profile.whatsappHash),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

async function earnForPaidOrder(
  tx: Tx,
  scope: Scope,
  paid: z.infer<typeof orderPaidSchema>,
): Promise<void> {
  const { tenantId, context, now } = scope;
  const [order] = await tx
    .select({
      customerProfileId: orders.customerProfileId,
      customerAttachedBy: orders.customerAttachedBy,
    })
    .from(orders)
    .where(
      and(eq(orders.tenantId, tenantId as never), eq(orders.id, paid.orderId)),
    )
    .limit(1);
  if (!order?.customerProfileId) return;

  const profile = await lockedProfile(tx, tenantId, order.customerProfileId);
  if (!profile) return;
  const paidAt = new Date(paid.paidAt);
  const eligibleSpend = Math.max(
    0,
    paid.grossSalesIdr - paid.discountIdr - paid.paidPointsIdr,
  );

  const [created] = await tx
    .insert(pointEarnRecords)
    .values({
      tenantId: tenantId as never,
      outletId: paid.outletId as never,
      orderId: paid.orderId,
      channel: paid.channel,
      customerProfileId: profile.id,
      state: "skipped",
      businessDate: paid.businessDate,
      paidAt,
      eligibleSpendIdr: idr(eligibleSpend),
    })
    .onConflictDoNothing()
    .returning();
  // An existing record means this event was already consumed: replay.
  if (!created) return;
  let record = created;

  const [programRow] = await tx
    .select()
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantId as never))
    .limit(1);
  if (!programRow || !programRow.isActive) {
    await settleRecord(tx, scope, record, {
      state: "skipped",
      outcomeReason: "skipped_program_inactive",
    });
    return;
  }

  const member =
    profile.membershipStatus === "active" &&
    profile.whatsappVerifiedAt !== null &&
    (await loyaltyConsentActive(tx, tenantId, profile.id, paidAt));
  if (!member) {
    await settleRecord(tx, scope, record, {
      state: "blocked",
      outcomeReason: "blocked_not_member",
    });
    return;
  }

  const staffIds = [paid.cashierId, order.customerAttachedBy].filter(
    (value): value is string => value !== null,
  );
  const selfServe =
    programRow.employeeSelfServeBan &&
    (await isSelfServe(tx, profile, staffIds));

  const stepContext: EarnStepContext = {
    tx,
    tenantId,
    profile,
    program: programRow,
    order: {
      id: paid.orderId,
      outletId: paid.outletId,
      channel: paid.channel,
      businessDate: paid.businessDate,
      paidAt,
      eligibleSpendIdr: eligibleSpend,
    },
    record,
  };

  if (selfServe) {
    record = await settleRecord(tx, scope, record, {
      state: "blocked",
      outcomeReason: "blocked_self_serve",
    });
    await recordLoyaltyAnomaly(tx, {
      tenantId,
      kind: "self_serve_blocked",
      outletId: paid.outletId,
      customerProfileId: profile.id,
      orderId: paid.orderId,
      businessDate: paid.businessDate,
      details: { eligibleSpendIdr: eligibleSpend },
    });
  } else {
    const multiplier = await tierMultiplierBp(stepContext);
    const points = pointsForSpend(
      programDtoOf(programRow),
      eligibleSpend,
      multiplier,
    );
    const cap = programRow.dailyPointCapPerCustomer;
    let booked = points;
    if (cap !== null) {
      const [day] = await tx
        .select({
          total: sql<string>`COALESCE(SUM(${pointEarnRecords.bookedPoints}), 0)`,
        })
        .from(pointEarnRecords)
        .where(
          and(
            eq(pointEarnRecords.tenantId, tenantId as never),
            eq(pointEarnRecords.customerProfileId, profile.id),
            eq(pointEarnRecords.businessDate, paid.businessDate),
          ),
        );
      booked = Math.min(points, Math.max(0, cap - Number(day?.total ?? 0)));
    }
    const cut = points - booked;
    if (cut > 0)
      await recordLoyaltyAnomaly(tx, {
        tenantId,
        kind: "daily_cap_hit",
        outletId: paid.outletId,
        customerProfileId: profile.id,
        orderId: paid.orderId,
        businessDate: paid.businessDate,
        details: { computedPoints: points, cappedPoints: cut, cap },
      });
    let earnEntryId: string | null = null;
    if (booked > 0) {
      const posted = await postLedgerEntry(
        tx,
        context,
        {
          tenantId,
          customerProfileId: profile.id,
          outletId: paid.outletId,
          type: "earn",
          points: booked,
          sourceType: "order",
          sourceId: paid.orderId,
          expiresAt: addMonthsUtc(paidAt, programRow.expiryMonths),
          businessDate: paid.businessDate,
        },
        now,
      );
      earnEntryId = posted.entry.id;
    }
    record = await settleRecord(tx, scope, record, {
      state: booked > 0 ? "booked" : points > 0 ? "capped" : "booked",
      outcomeReason:
        booked > 0 ? null : points > 0 ? "capped_daily" : "zero_points",
      computedPoints: points,
      cappedPoints: cut,
      bookedPoints: booked,
      earnEntryId,
    });
  }

  // The visit counts for a blocked self-serve and a capped order too.
  await tx
    .insert(customerVisits)
    .values({
      tenantId: tenantId as never,
      outletId: paid.outletId as never,
      customerProfileId: profile.id,
      orderId: paid.orderId,
      businessDate: paid.businessDate,
      visitedAt: paidAt,
      spendIdr: idr(eligibleSpend),
    })
    .onConflictDoNothing();
  const paidAtSql = sql`${paidAt.toISOString()}::timestamptz`;
  await tx
    .update(customerProfiles)
    .set({
      visitsCount: sql`${customerProfiles.visitsCount} + 1`,
      lifetimeSpendIdr: sql`${customerProfiles.lifetimeSpendIdr} + ${eligibleSpend}`,
      firstVisitAt: sql`COALESCE(${customerProfiles.firstVisitAt}, ${paidAtSql})`,
      lastVisitAt: sql`GREATEST(COALESCE(${customerProfiles.lastVisitAt}, ${paidAtSql}), ${paidAtSql})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId as never),
        eq(customerProfiles.id, profile.id),
      ),
    );

  const afterContext = { ...stepContext, record };
  await missionAfterVisit(afterContext);
  await referralAfterVisit(afterContext);
}

type ReverseInput = {
  orderId: string;
  outletId: string;
  businessDate: string;
  sourceType: "refund" | "void";
  sourceId: string;
  /** Eligible part of this refund; null = a void, the whole order. */
  refundEligibleIdr: number | null;
};

async function reverseForOrder(
  tx: Tx,
  scope: Scope,
  input: ReverseInput,
): Promise<void> {
  const { tenantId, context, now } = scope;
  const recordWhere = and(
    eq(pointEarnRecords.tenantId, tenantId as never),
    eq(pointEarnRecords.orderId, input.orderId),
  );
  const [unlocked] = await tx
    .select({ profileId: pointEarnRecords.customerProfileId })
    .from(pointEarnRecords)
    .where(recordWhere)
    .limit(1);
  if (!unlocked) return;
  const profile = await lockedProfile(tx, tenantId, unlocked.profileId);
  if (!profile) return;
  // The record is mutated only under the profile lock: read it again here.
  const [record] = await tx
    .select()
    .from(pointEarnRecords)
    .where(recordWhere)
    .limit(1);
  if (!record || record.state !== "booked") return;

  // Replay guard for a refund or void that posted no ledger row: its
  // shortfall anomaly names the source.
  const [seen] = await tx
    .select({ id: loyaltyAnomalies.id })
    .from(loyaltyAnomalies)
    .where(
      and(
        eq(loyaltyAnomalies.tenantId, tenantId as never),
        eq(loyaltyAnomalies.kind, "refund_after_redeem"),
        eq(loyaltyAnomalies.orderId, input.orderId),
        sql`${loyaltyAnomalies.details}->>'sourceId' = ${input.sourceId}`,
      ),
    )
    .limit(1);
  if (seen) return;

  const eligible = Number(record.eligibleSpendIdr);
  const booked = Number(record.bookedPoints);
  const refunded =
    input.refundEligibleIdr === null
      ? eligible
      : Math.min(
          eligible,
          Number(record.refundedEligibleIdr) + input.refundEligibleIdr,
        );
  // Cumulative target, rounded up against the member (full refund = all).
  const target =
    eligible === 0
      ? 0
      : Math.min(
          booked,
          Number(
            (BigInt(booked) * BigInt(refunded) + BigInt(eligible) - 1n) /
              BigInt(eligible),
          ),
        );
  const delta = target - record.reversedPoints;
  const posted = Math.min(Math.max(0, delta), profile.pointsBalance);

  if (posted > 0 && record.earnEntryId) {
    const result = await postLedgerEntry(
      tx,
      context,
      {
        tenantId,
        customerProfileId: profile.id,
        outletId: input.outletId,
        type: "reverse",
        points: -posted,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        reversesEntryId: record.earnEntryId,
        businessDate: input.businessDate,
      },
      now,
    );
    // Same refund or void already posted: nothing more to do.
    if (!result.inserted) return;
  }
  const reversed = record.reversedPoints + posted;
  const shortfall = Math.max(0, target - reversed);
  await settleRecord(tx, scope, record, {
    refundedEligibleIdr: idr(refunded),
    reversedPoints: reversed,
    reversalShortfallPoints: shortfall,
    state: reversed === booked ? "reversed" : "booked",
  });
  if (delta > posted)
    await recordLoyaltyAnomaly(tx, {
      tenantId,
      kind: "refund_after_redeem",
      outletId: input.outletId,
      customerProfileId: profile.id,
      orderId: input.orderId,
      businessDate: input.businessDate,
      details: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        deltaPoints: delta,
        postedPoints: posted,
        shortfallPoints: delta - posted,
      },
    });
}
