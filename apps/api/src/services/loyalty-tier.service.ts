// Loyalty tiers: ladder administration for staff and the rolling evaluation of
// one member (legend-3zd1, docs/design/ws08-member-loyalty.md §M6). A tier
// qualifies on spend OR visits inside the program's rolling window (PRD §3.20,
// `evaluateTier` in `@starter/shared/crm`); the highest qualifying rank wins.
//
// `evaluateProfileTier` runs in the caller's transaction under the profile
// lock. A change updates `customer_profiles.tier_id`, appends
// `customer_tier_history` and the `tier.changed` outbox event in that same
// transaction; no change only stamps `tier_evaluated_at`. Tiers are never
// deleted, only deactivated.

import { and, asc, count, eq, gt, gte, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  createLoyaltyTierInputSchema,
  crmEvents,
  evaluateTier,
  loyaltyTierSchema,
  updateLoyaltyTierInputSchema,
  type LoyaltyTier,
} from "@starter/shared/crm";
import { maskAuditChanges } from "@starter/shared/audit";
import type { z } from "@starter/shared/core";
import { db } from "../db";
import { domainEventOutbox } from "../db/schema/core-events";
import { customerVisits } from "../db/schema/crm-ledger";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member";
import { customerTierHistory, loyaltyTiers } from "../db/schema/crm-tiers";
import { withProfileLock } from "../db/member-scope";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { appendOutbox } from "./core-outbox";
import { recordAudit } from "./core-audit";
import type { Tx } from "./inventory-ops.shared.ts";

type TierRow = typeof loyaltyTiers.$inferSelect;
export type CreateLoyaltyTierInput = z.output<
  typeof createLoyaltyTierInputSchema
>;
export type UpdateLoyaltyTierInput = z.output<
  typeof updateLoyaltyTierInputSchema
>;

const EVENT_DESTINATION = "cloud-sync";

/** Audit field names kept unmasked: numbers and flags, no personal data. */
// `name` is left out: the audit schema rejects raw values of name-like keys.
const AUDIT_SAFE_FIELDS = [
  "rank",
  "thresholdSpendIdr",
  "thresholdVisits",
  "pointsMultiplierBp",
  "birthdayRewardPoints",
  "isActive",
] as const;

export function toLoyaltyTier(row: TierRow): LoyaltyTier {
  return loyaltyTierSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    rank: row.rank,
    thresholdSpendIdr: row.thresholdSpendIdr,
    thresholdVisits: row.thresholdVisits,
    benefits: row.benefits,
    isActive: row.isActive,
  });
}

function auditSummary(tier: LoyaltyTier | null) {
  if (tier === null) return null;
  // The audit schema rejects an unmasked sensitive-looking key ("birthday...").
  // Mask here; `recordAudit` masks again with the same safe list.
  return maskAuditChanges(
    {
      rank: tier.rank,
      thresholdSpendIdr: tier.thresholdSpendIdr,
      thresholdVisits: tier.thresholdVisits,
      pointsMultiplierBp: tier.benefits.pointsMultiplierBp,
      birthdayRewardPoints: tier.benefits.birthdayRewardPoints,
      isActive: tier.isActive,
    },
    AUDIT_SAFE_FIELDS,
  );
}

function rankTaken(): HttpError {
  return new HttpError(
    409,
    "TIER_RANK_TAKEN",
    "Peringkat tier sudah dipakai tier lain.",
  );
}

/** Unique violation (SQLSTATE 23505) of `(tenant_id, rank)`; the only unique key a body can hit. */
function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || isUniqueViolation(candidate.cause, depth + 1)
  );
}

async function audit(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  action: "loyalty_tier.created" | "loyalty_tier.updated",
  before: LoyaltyTier | null,
  after: LoyaltyTier,
  now: Date,
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actorUserId,
      deviceId: null,
      action,
      objectType: "loyalty_tier",
      objectId: after.id,
      reason: null,
      maskedChanges: {
        before: auditSummary(before),
        after: auditSummary(after),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

/** The ladder, lowest rank first, inactive tiers included. */
export async function listTiers(
  context: ScopedTenantContext,
): Promise<LoyaltyTier[]> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(loyaltyTiers)
      .where(eq(loyaltyTiers.tenantId, context.tenant.tenantId))
      .orderBy(asc(loyaltyTiers.rank), asc(loyaltyTiers.id));
    return rows.map(toLoyaltyTier);
  });
}

export async function createTier(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateLoyaltyTierInput,
  now = new Date(),
): Promise<LoyaltyTier> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const [row] = await tx
        .insert(loyaltyTiers)
        .values({
          tenantId,
          name: input.name,
          rank: input.rank,
          thresholdSpendIdr: idr(input.thresholdSpendIdr),
          thresholdVisits: input.thresholdVisits,
          benefits: input.benefits,
          isActive: input.isActive,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("Loyalty tier insert returned no row");
      const tier = toLoyaltyTier(row);
      await audit(
        tx,
        context,
        actorUserId,
        "loyalty_tier.created",
        null,
        tier,
        now,
      );
      return tier;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw rankTaken();
    throw error;
  }
}

export async function updateTier(
  context: ScopedTenantContext,
  actorUserId: string,
  tierId: string,
  input: UpdateLoyaltyTierInput,
  now = new Date(),
): Promise<LoyaltyTier> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      const [existing] = await tx
        .select()
        .from(loyaltyTiers)
        .where(
          and(eq(loyaltyTiers.tenantId, tenantId), eq(loyaltyTiers.id, tierId)),
        )
        .limit(1)
        .for("update");
      if (!existing)
        throw new HttpError(404, "TIER_NOT_FOUND", "Tier tidak ditemukan.");
      const before = toLoyaltyTier(existing);
      const [row] = await tx
        .update(loyaltyTiers)
        .set({
          name: input.name ?? existing.name,
          rank: input.rank ?? existing.rank,
          thresholdSpendIdr:
            input.thresholdSpendIdr === undefined
              ? existing.thresholdSpendIdr
              : idr(input.thresholdSpendIdr),
          thresholdVisits: input.thresholdVisits ?? existing.thresholdVisits,
          benefits: input.benefits ?? existing.benefits,
          isActive: input.isActive ?? existing.isActive,
          updatedAt: now,
        })
        .where(
          and(eq(loyaltyTiers.tenantId, tenantId), eq(loyaltyTiers.id, tierId)),
        )
        .returning();
      if (!row) throw new Error("Loyalty tier update returned no row");
      const tier = toLoyaltyTier(row);
      await audit(
        tx,
        context,
        actorUserId,
        "loyalty_tier.updated",
        before,
        tier,
        now,
      );
      return tier;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw rankTaken();
    throw error;
  }
}

/** Calendar months back from `date` (UTC), clamped to the shorter month's end. */
function subtractMonthsUtc(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

async function nextTierSequence(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantIdSchema.parse(tenantId)),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, "tier"),
        eq(domainEventOutbox.aggregateId, profileId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/**
 * Evaluates the profile's tier against the rolling window and applies a
 * change. Returns true when the tier changed (including from or to none).
 * The caller's transaction is a tenant transaction; the profile is locked
 * here. A tenant without a loyalty program changes nothing.
 */
export async function evaluateProfileTier(
  tx: Tx,
  context: ScopedTenantContext,
  profileId: string,
  now: Date,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const profile = await withProfileLock(tx, tenantId, profileId);
  const [program] = await tx
    .select({ rollingMonths: loyaltyPrograms.rollingMonths })
    .from(loyaltyPrograms)
    .where(eq(loyaltyPrograms.tenantId, tenantId))
    .limit(1);
  if (!program) return false;

  const tierRows = await tx
    .select()
    .from(loyaltyTiers)
    .where(
      and(eq(loyaltyTiers.tenantId, tenantId), eq(loyaltyTiers.isActive, true)),
    );
  const since = subtractMonthsUtc(now, program.rollingMonths);
  const [stats] = await tx
    .select({
      spend: sql<string>`coalesce(sum(${customerVisits.spendIdr}), 0)`,
      visits: count(),
    })
    .from(customerVisits)
    .where(
      and(
        eq(customerVisits.tenantId, tenantId),
        eq(customerVisits.customerProfileId, profileId),
        gte(customerVisits.visitedAt, since),
      ),
    );
  const rollingSpendIdr = idr(Number(stats?.spend ?? 0));
  const rollingVisits = Number(stats?.visits ?? 0);

  const next = evaluateTier(tierRows.map(toLoyaltyTier), {
    rollingSpendIdr,
    rollingVisits,
  });
  const nextTierId = next?.id ?? null;
  const fromTierId = profile.tierId ?? null;
  if (nextTierId === fromTierId) {
    await tx
      .update(customerProfiles)
      .set({ tierEvaluatedAt: now })
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.id, profileId),
        ),
      );
    return false;
  }

  await tx
    .update(customerProfiles)
    .set({ tierId: nextTierId, tierEvaluatedAt: now })
    .where(
      and(
        eq(customerProfiles.tenantId, tenantId),
        eq(customerProfiles.id, profileId),
      ),
    );
  const [history] = await tx
    .insert(customerTierHistory)
    .values({
      tenantId,
      customerProfileId: profileId,
      fromTierId,
      toTierId: nextTierId,
      reason: "evaluation",
      rollingSpendIdr,
      rollingVisits,
      createdAt: now,
    })
    .returning({ id: customerTierHistory.id });
  if (!history) throw new Error("Tier history insert returned no row");

  const definition = crmEvents["tier.changed"];
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: profileId,
    sequence: await nextTierSequence(tx, tenantId, profileId),
    occurredAt: now.toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${definition.name}:${history.id}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      customerProfileId: profileId,
      fromTierId,
      toTierId: nextTierId,
      reason: "evaluation",
      rollingSpendIdr,
      rollingVisits,
      changedAt: now.toISOString(),
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
  return true;
}

/** Active members in id order after `afterId`, for the sweep's keyset pages. */
export async function listTierCandidateProfileIds(
  tx: Tx,
  tenantId: string,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await tx
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(
      and(
        eq(customerProfiles.tenantId, tenantIdSchema.parse(tenantId)),
        eq(customerProfiles.membershipStatus, "active"),
        afterId === null ? undefined : gt(customerProfiles.id, afterId),
      ),
    )
    .orderBy(asc(customerProfiles.id))
    .limit(limit);
  return rows.map((row) => row.id);
}
