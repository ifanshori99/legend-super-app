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
// - `order_issue.refund_reversal_requested` (legend-h1dyy, ORD-09): the
//   payment module rejected a QR pay-first recovery refund, so the points and
//   eligible spend its `order.refunded` (refundId = issue id) took are given
//   back once (`adjust` row, record and profile counters restored).
// - `payment.refunded` is not handled: it carries no order id. A QR order has
//   no refund path today (§1); a later card must emit `order.refunded`.
//
// A deterministic bad payload is ignored (the sale itself is journaled
// elsewhere); any other error propagates so the relay retries the event. A
// deadlock between two profile locks (referral step) is retried here, in a
// fresh savepoint.

import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businessDateSchema,
  idr,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { pointsForSpend, type LoyaltyProgram } from "@starter/shared/crm";
import type { EventEnvelope } from "@starter/shared/events";
import { withProfileLock } from "../db/member-scope.ts";
import {
  billSplits,
  customerProfiles,
  customerVisits,
  domainEventOutbox,
  loyaltyAnomalies,
  loyaltyEarnParked,
  loyaltyPrograms,
  orders,
  pointEarnRecords,
  pointLedger,
  userIdentities,
} from "../db/schema/index.ts";
import { isTrainingOrder } from "./device-training.ts";
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
import { lockOrderForClaimReversal } from "./table-claim-lock.ts";
import { checkLoyaltyOutletEntity } from "./loyalty-entity-guard.ts";

const REFUND_REVERSAL_EVENT = "order_issue.refund_reversal_requested";
const EARN_EVENTS = new Set([
  "order.paid",
  "order.refunded",
  "order.voided",
  REFUND_REVERSAL_EVENT,
]);
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

/** legend-h1dyy: payload of order_issue.refund_reversal_requested. */
const refundReversalSchema = z.object({
  orderId: ulid,
  orderIssueId: z.string().uuid(),
  refundId: z.string().uuid(),
  amountIdr: amount,
  rejectedAt: time,
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
  const parsed =
    event.name === "order.paid"
      ? orderPaidSchema.safeParse(event.payload)
      : event.name === "order.refunded"
        ? orderRefundedSchema.safeParse(event.payload)
        : event.name === "order.voided"
          ? orderVoidedSchema.safeParse(event.payload)
          : refundReversalSchema.safeParse(event.payload);
  if (!parsed.success) return;
  const tenantId = context.tenant.tenantId;
  const orderId = parsed.data.orderId;
  const [order] = await tx
    .select({
      outletId: orders.outletId,
      customerProfileId: orders.customerProfileId,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  if (!order) return;
  if (!order.customerProfileId && event.name === "order.paid") return;
  if (!order.customerProfileId) {
    return handleWithRetry(tx, { context, tenantId, now }, event);
  }
  const existingEarn = async () => {
    const [record] = await tx
      .select({ id: pointEarnRecords.id })
      .from(pointEarnRecords)
      .where(
        and(
          eq(pointEarnRecords.tenantId, tenantId),
          eq(pointEarnRecords.orderId, orderId),
        ),
      )
      .limit(1);
    return record;
  };
  // Never defer a reversal of points already credited. The existing handler
  // also takes back claims under its established order/profile lock.
  if (event.name !== "order.paid" && (await existingEarn()))
    return handleWithRetry(tx, { context, tenantId, now }, event);

  const verdict = await checkLoyaltyOutletEntity(tx, tenantId, [
    order.outletId,
  ]);
  // Lock contention is transient. Retrying the outbox event preserves the
  // customer's right without permanently parking an otherwise eligible earn.
  if (verdict === "busy")
    throw new Error("Loyalty entity busy; retry loyalty event");
  if (event.name !== "order.paid" && (await existingEarn()))
    return handleWithRetry(tx, { context, tenantId, now }, event);
  const [parked] = await tx
    .select({ eventId: loyaltyEarnParked.eventId })
    .from(loyaltyEarnParked)
    .where(
      and(
        eq(loyaltyEarnParked.tenantId, tenantId),
        eq(loyaltyEarnParked.orderId, orderId),
      ),
    )
    .limit(1);
  if (event.name !== "order.paid") {
    // Preserve the ordinary claim reversal even when this order's earn has
    // not arrived, then retain the event for that pending earn as well.
    await handleWithRetry(tx, { context, tenantId, now }, event);
  }
  if (event.name !== "order.paid" || parked || verdict !== "ok") {
    await tx
      .insert(loyaltyEarnParked)
      .values({
        tenantId,
        eventId: event.id,
        orderId,
        eventName: event.name,
        payload: parsed.data,
        reason: parked
          ? "prior_event_parked"
          : event.name !== "order.paid"
            ? "awaiting_paid"
            : verdict,
      })
      .onConflictDoNothing();
    return;
  }
  return handleWithRetry(tx, { context, tenantId, now }, event);
}

async function handleWithRetry(
  tx: Tx,
  scope: Scope,
  event: EventEnvelope,
): Promise<void> {
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
    return;
  }
  if (name === REFUND_REVERSAL_EVENT) {
    const parsed = refundReversalSchema.safeParse(payload);
    if (parsed.success) await restoreRejectedRefund(tx, scope, parsed.data);
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
  if (await isTrainingOrder(tx, tenantId as never, paid.orderId)) return;
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
      // legend-n1mp: points claimed at a table count against the same cap;
      // those ledger rows have no earn record, so nothing is counted twice.
      const [claimed] = await tx
        .select({
          total: sql<string>`COALESCE(SUM(${pointLedger.points}), 0)`,
        })
        .from(pointLedger)
        .where(
          and(
            eq(pointLedger.tenantId, tenantId as never),
            eq(pointLedger.customerProfileId, profile.id),
            eq(pointLedger.type, "earn"),
            eq(pointLedger.sourceType, "table_claim"),
            eq(pointLedger.businessDate, paid.businessDate),
          ),
        );
      const usedToday = Number(day?.total ?? 0) + Number(claimed?.total ?? 0);
      booked = Math.min(points, Math.max(0, cap - usedToday));
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

/**
 * The reverse row of one claim row needs its own dedupe key (one refund or
 * void can reverse several claim rows) and the points event wants a UUID:
 * a name-based (v5-shaped) UUID of both ids, stable across replays.
 */
function claimReverseSourceId(sourceId: string, claimSourceId: string): string {
  const hex = createHash("sha256")
    .update(`table_claim_reversal:${sourceId}:${claimSourceId}`)
    .digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * legend-n1mp: takes back the points guests claimed at a table for this order
 * (`table_claim` earn rows: source_id is the order id for a whole bill, a
 * bill_splits id for a split part). Same shape as the normal earn reversal:
 * a `reverse` row naming the earn, clamped to the balance, a shortfall
 * anomaly for the rest. A void reverses all; a refund reverses the share of
 * the order's eligible amount it refunds. Each claim row gets its own reverse
 * source id (a hash of the refund or void id and the claim source id), so a replay is a no-op.
 */
async function reverseTableClaims(
  tx: Tx,
  scope: Scope,
  input: ReverseInput,
): Promise<void> {
  const { tenantId, context, now } = scope;
  // legend-ec6fa: wait for the open claims of this order (they hold the same
  // lock shared) so their earn rows are visible below. Order lock first, the
  // profile lock (lockedProfile) after: the claim takes them in that order too.
  await lockOrderForClaimReversal(tx, tenantId, input.orderId);
  const [order] = await tx
    .select({
      // Gross sales minus discount, the base the claim earned on (tax-inclusive
      // prices already hold the service charge and tax: order-revenue.ts).
      eligible: sql<string>`GREATEST(0, CASE WHEN ${orders.pricesIncludeTax}
        THEN ${orders.subtotalIdr} - ${orders.serviceChargeIdr} - ${orders.taxIdr}
        ELSE ${orders.subtotalIdr} END - ${orders.discountIdr})`,
    })
    .from(orders)
    .where(
      and(eq(orders.tenantId, tenantId as never), eq(orders.id, input.orderId)),
    )
    .limit(1);
  if (!order) return;
  const splits = await tx
    .select({ id: billSplits.id })
    .from(billSplits)
    .where(
      and(
        eq(billSplits.tenantId, tenantId as never),
        eq(billSplits.orderId, input.orderId),
      ),
    );
  const sourceIds = [
    input.orderId,
    ulidToUuid(input.orderId),
    ...splits.map((split) => split.id),
  ];
  const claims = await tx
    .select()
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenantId as never),
        eq(pointLedger.type, "earn"),
        eq(pointLedger.sourceType, "table_claim"),
        inArray(pointLedger.sourceId, sourceIds),
      ),
    )
    .orderBy(pointLedger.postingSeq);
  const eligible = Number(order.eligible);
  for (const claim of claims) {
    if (claim.sourceId === null) continue;
    const profile = await lockedProfile(tx, tenantId, claim.customerProfileId);
    if (!profile) continue;
    const reverseSourceId = claimReverseSourceId(
      input.sourceId,
      claim.sourceId,
    );
    const [done] = await tx
      .select({ id: pointLedger.id })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenantId as never),
          eq(pointLedger.type, "reverse"),
          eq(pointLedger.sourceType, input.sourceType),
          eq(pointLedger.sourceId, reverseSourceId),
        ),
      )
      .limit(1);
    if (done) continue;
    const [seen] = await tx
      .select({ id: loyaltyAnomalies.id })
      .from(loyaltyAnomalies)
      .where(
        and(
          eq(loyaltyAnomalies.tenantId, tenantId as never),
          eq(loyaltyAnomalies.kind, "refund_after_redeem"),
          eq(loyaltyAnomalies.orderId, input.orderId),
          sql`${loyaltyAnomalies.details}->>'sourceId' = ${reverseSourceId}`,
        ),
      )
      .limit(1);
    if (seen) continue;
    const [taken] = await tx
      .select({
        total: sql<string>`COALESCE(-SUM(${pointLedger.points}), 0)`,
      })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.tenantId, tenantId as never),
          eq(pointLedger.type, "reverse"),
          eq(pointLedger.reversesEntryId, claim.id),
        ),
      );
    const remaining = Math.max(0, claim.points - Number(taken?.total ?? 0));
    const share =
      input.refundEligibleIdr === null || eligible <= 0
        ? remaining
        : Math.min(
            remaining,
            Number(
              (BigInt(claim.points) * BigInt(input.refundEligibleIdr) +
                BigInt(eligible) -
                1n) /
                BigInt(eligible),
            ),
          );
    if (share <= 0) continue;
    const posted = Math.min(share, profile.pointsBalance);
    if (posted > 0)
      await postLedgerEntry(
        tx,
        context,
        {
          tenantId,
          customerProfileId: profile.id,
          outletId: input.outletId,
          type: "reverse",
          points: -posted,
          sourceType: input.sourceType,
          sourceId: reverseSourceId,
          reversesEntryId: claim.id,
          businessDate: input.businessDate,
        },
        now,
      );
    if (share > posted)
      await recordLoyaltyAnomaly(tx, {
        tenantId,
        kind: "refund_after_redeem",
        outletId: input.outletId,
        customerProfileId: profile.id,
        orderId: input.orderId,
        businessDate: input.businessDate,
        details: {
          sourceType: input.sourceType,
          sourceId: reverseSourceId,
          deltaPoints: share,
          postedPoints: posted,
          shortfallPoints: share - posted,
        },
      });
  }
}

async function reverseForOrder(
  tx: Tx,
  scope: Scope,
  input: ReverseInput,
): Promise<void> {
  const { tenantId, context, now } = scope;
  if (await isTrainingOrder(tx, tenantId as never, input.orderId)) return;
  // legend-n1mp: a table claim has ledger rows only, no earn record.
  await reverseTableClaims(tx, scope, input);
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
  if (!record) return;
  // legend-wa4hp: the counters follow every record whose visit was counted:
  // booked, capped, a blocked self-serve order and a record an earlier partial
  // refund reversed. Only a booked record has points to reverse.
  const visitCounted =
    record.state === "booked" ||
    record.state === "capped" ||
    record.state === "reversed" ||
    (record.state === "blocked" &&
      record.outcomeReason === "blocked_self_serve");
  if (!visitCounted) return;
  const reversePoints = record.state === "booked";
  // legend-wa4hp: replay guard for a refund or void already applied.
  if (record.appliedReversalIds.includes(input.sourceId)) return;

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
  const previousRefunded = Number(record.refundedEligibleIdr);
  const refunded =
    input.refundEligibleIdr === null
      ? eligible
      : Math.min(eligible, previousRefunded + input.refundEligibleIdr);
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
  const delta = reversePoints ? target - record.reversedPoints : 0;
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
  await settleRecord(
    tx,
    scope,
    record,
    reversePoints
      ? {
          refundedEligibleIdr: idr(refunded),
          reversedPoints: reversed,
          reversalShortfallPoints: shortfall,
          state: reversed === booked ? "reversed" : "booked",
          appliedReversalIds: [...record.appliedReversalIds, input.sourceId],
        }
      : {
          refundedEligibleIdr: idr(refunded),
          appliedReversalIds: [...record.appliedReversalIds, input.sourceId],
        },
  );

  // legend-wa4hp: a void or refund also lowers the visit count and spend.
  const spendDelta = refunded - previousRefunded;
  const visitRemovedBefore = eligible > 0 && previousRefunded >= eligible;
  const removesVisit =
    !visitRemovedBefore &&
    (input.refundEligibleIdr === null ||
      (eligible > 0 && refunded >= eligible));
  if (spendDelta > 0 || removesVisit) {
    await tx
      .update(customerProfiles)
      .set({
        lifetimeSpendIdr: sql`GREATEST(0, ${customerProfiles.lifetimeSpendIdr} - ${spendDelta})`,
        ...(removesVisit
          ? {
              visitsCount: sql`GREATEST(0, ${customerProfiles.visitsCount} - 1)`,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId as never),
          eq(customerProfiles.id, profile.id),
        ),
      );
  }
  const visitWhere = and(
    eq(customerVisits.tenantId, tenantId as never),
    eq(customerVisits.orderId, input.orderId),
  );
  if (removesVisit) {
    await tx.delete(customerVisits).where(visitWhere);
  } else if (spendDelta > 0) {
    await tx
      .update(customerVisits)
      .set({
        spendIdr: sql`GREATEST(0, ${customerVisits.spendIdr} - ${spendDelta})`,
      })
      .where(visitWhere);
  }
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

/**
 * legend-h1dyy (ORD-09): a rejected recovery refund gives back what its
 * `order.refunded` (sourceId = issue id) took: the reversed points (an
 * `adjust` row, deduped on its source id), the refunded eligible spend on the
 * record, the lifetime spend and the visit spend. Once per issue: the record
 * keeps both `<issueId>` (an `order.refunded` replay stays a no-op) and
 * `reject:<issueId>`.
 */
async function restoreRejectedRefund(
  tx: Tx,
  scope: Scope,
  input: z.infer<typeof refundReversalSchema>,
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
  const [record] = await tx
    .select()
    .from(pointEarnRecords)
    .where(recordWhere)
    .limit(1);
  if (!record) return;
  const issueId = input.orderIssueId;
  const rejectId = `reject:${issueId}`;
  if (record.appliedReversalIds.includes(rejectId)) return;
  // The rejection came before its `order.refunded`: mark both ids so the late
  // refund is a no-op (reverseForOrder's replay guard), nothing to give back.
  if (!record.appliedReversalIds.includes(issueId)) {
    await settleRecord(tx, scope, record, {
      appliedReversalIds: [...record.appliedReversalIds, issueId, rejectId],
    });
    return;
  }
  const appliedReversalIds = [...record.appliedReversalIds, rejectId];

  // The stored refunds and voids of this order, to replay what each applied.
  const storedEvents = await tx
    .select({
      name: sql<string>`${domainEventOutbox.event}->>'name'`,
      payload: sql<unknown>`${domainEventOutbox.event}->'payload'`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId as never),
        eq(domainEventOutbox.aggregateType, "order"),
        sql`${domainEventOutbox.event}->>'name' IN ('order.refunded', 'order.voided')`,
        sql`${domainEventOutbox.event}->'payload'->>'orderId' = ${input.orderId}`,
      ),
    );
  const refundEligibleById = new Map<string, number>();
  const voidIds = new Set<string>();
  for (const row of storedEvents) {
    if (row.name === "order.refunded") {
      const parsed = orderRefundedSchema.safeParse(row.payload);
      if (parsed.success)
        refundEligibleById.set(
          parsed.data.refundId,
          Math.max(
            0,
            parsed.data.grossSalesIdr -
              parsed.data.discountIdr -
              parsed.data.refundPointsIdr,
          ),
        );
    } else {
      const parsed = orderVoidedSchema.safeParse(row.payload);
      if (parsed.success && parsed.data.voidId !== null)
        voidIds.add(parsed.data.voidId);
    }
  }
  // A void of the order reversed everything: the rejection of one refund gives
  // nothing back (points, spend, visit); it is only marked as handled.
  if (record.appliedReversalIds.some((sourceId) => voidIds.has(sourceId))) {
    await settleRecord(tx, scope, record, { appliedReversalIds });
    return;
  }

  // Replay the applied refunds in order with reverseForOrder's cumulative
  // clamp (min(eligible, previous + refund)); an earlier rejection takes its
  // applied amount back out. A refund with no stored event counts 0.
  const eligible = Number(record.eligibleSpendIdr);
  const appliedById = new Map<string, number>();
  let cumulative = 0;
  for (const sourceId of record.appliedReversalIds) {
    if (sourceId.startsWith("reject:")) {
      cumulative -= appliedById.get(sourceId.slice("reject:".length)) ?? 0;
      continue;
    }
    const asked = refundEligibleById.get(sourceId) ?? 0;
    const next = Math.min(eligible, cumulative + asked);
    appliedById.set(sourceId, next - cumulative);
    cumulative = next;
  }
  const previousRefunded = Number(record.refundedEligibleIdr);
  const restored = Math.min(appliedById.get(issueId) ?? 0, previousRefunded);

  // The points the refund reversed (none when it was clamped to 0).
  const [reversal] = await tx
    .select({ points: pointLedger.points })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.tenantId, tenantId as never),
        eq(pointLedger.customerProfileId, profile.id),
        eq(pointLedger.type, "reverse"),
        eq(pointLedger.sourceType, "refund"),
        eq(pointLedger.sourceId, issueId),
      ),
    )
    .limit(1);
  const credited = Math.min(
    reversal ? -Number(reversal.points) : 0,
    record.reversedPoints,
  );
  if (credited > 0) {
    let expiresAt: Date | null = null;
    if (record.earnEntryId) {
      const [earn] = await tx
        .select({ expiresAt: pointLedger.expiresAt })
        .from(pointLedger)
        .where(
          and(
            eq(pointLedger.tenantId, tenantId as never),
            eq(pointLedger.id, record.earnEntryId),
          ),
        )
        .limit(1);
      expiresAt = earn?.expiresAt ?? null;
    }
    await postLedgerEntry(
      tx,
      context,
      {
        tenantId,
        customerProfileId: profile.id,
        outletId: record.outletId,
        type: "adjust",
        points: credited,
        sourceType: "adjustment",
        // The points.adjusted event takes a uuid/ulid source id only: the
        // issue id (unique per adjustment, like a redemption id) dedupes it.
        sourceId: issueId,
        expiresAt,
        reason: "Refund item gagal ditolak (ORD-09)",
      },
      now,
    );
  }

  const booked = Number(record.bookedPoints);
  const refundedAfter = previousRefunded - restored;
  const reversed = record.reversedPoints - credited;
  const hasPoints = record.state === "booked" || record.state === "reversed";
  // Same cumulative target as reverseForOrder, rounded up against the member.
  const target =
    eligible === 0
      ? 0
      : Math.min(
          booked,
          Number(
            (BigInt(booked) * BigInt(refundedAfter) + BigInt(eligible) - 1n) /
              BigInt(eligible),
          ),
        );
  await settleRecord(
    tx,
    scope,
    record,
    hasPoints
      ? {
          refundedEligibleIdr: idr(refundedAfter),
          reversedPoints: reversed,
          reversalShortfallPoints: Math.max(0, target - reversed),
          state: reversed === booked && booked > 0 ? "reversed" : "booked",
          appliedReversalIds,
        }
      : { refundedEligibleIdr: idr(refundedAfter), appliedReversalIds },
  );

  // A refund that reached the full eligible spend deleted the visit row and
  // lowered visits_count (reverseForOrder). Bring the visit back when the
  // rejection leaves the order partly paid again, so a later full refund
  // lowers visits_count once, not twice.
  const restoresVisit =
    eligible > 0 && previousRefunded >= eligible && refundedAfter < eligible;
  if (restored > 0 || restoresVisit) {
    await tx
      .update(customerProfiles)
      .set({
        lifetimeSpendIdr: sql`${customerProfiles.lifetimeSpendIdr} + ${restored}`,
        ...(restoresVisit
          ? { visitsCount: sql`${customerProfiles.visitsCount} + 1` }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId as never),
          eq(customerProfiles.id, profile.id),
        ),
      );
  }
  if (restoresVisit) {
    // Outlet, business date and visit time come from the earn record (the
    // values the original insert used). itemCount: the original insert in
    // earnForPaidOrder leaves the column default (0), so it is not set here.
    await tx
      .insert(customerVisits)
      .values({
        tenantId: tenantId as never,
        outletId: record.outletId as never,
        customerProfileId: profile.id,
        orderId: input.orderId,
        businessDate: record.businessDate,
        visitedAt: record.paidAt,
        spendIdr: idr(eligible - refundedAfter),
      })
      .onConflictDoNothing();
  } else if (restored > 0) {
    await tx
      .update(customerVisits)
      .set({ spendIdr: sql`${customerVisits.spendIdr} + ${restored}` })
      .where(
        and(
          eq(customerVisits.tenantId, tenantId as never),
          eq(customerVisits.orderId, input.orderId),
        ),
      );
  }
}
