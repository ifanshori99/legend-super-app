// Loyalty program administration, point history and anomaly review for staff
// (legend-111j, docs/design/ws08-member-loyalty.md §8, §M5). Tenant-wide;
// the routes guard `crm.loyalty.manage`, `crm.customer.view` and
// `crm.loyalty.review` (TEN-03). Every function runs in `withTenant`, so RLS
// scopes rows to the tenant.
//
// One program per tenant. An absent row reads as the §8 defaults, inactive.
// `point_value_idr` is frozen by a database trigger at the first ledger row;
// the service refuses the change up front (409 POINT_VALUE_LOCKED) and maps
// the trigger error if a ledger row lands between the read and the write.
// `phone_lookup_daily_cap_per_cashier` has no contract field: PUT never
// changes it (database default 20).

import { and, asc, eq, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  defaultLoyaltyAntiFraud,
  defaultReferralRules,
  loyaltyProgramSchema,
  type LoyaltyAnomaly,
  type LoyaltyAnomalyKind,
  type LoyaltyProgram,
  type LoyaltyProgramWithTiers,
  type PointLedgerEntry,
  updateLoyaltyProgramInputSchema,
} from "@starter/shared/crm";
import type { z } from "@starter/shared/core";
import { db } from "../db";
import { customerProfiles, loyaltyPrograms } from "../db/schema/crm-member";
import {
  loyaltyEarnParked,
  pointEarnRecords,
  pointLedger,
} from "../db/schema/crm-ledger";
import { missionProgress, rewardRedemptions } from "../db/schema/crm-rewards";
import { vouchers } from "../db/schema/crm-promo";
import { loyaltyTiers } from "../db/schema/crm-tiers";
import {
  autoJournalParked,
  billSplits,
  loyaltyClaimPauses,
  domainEventOutbox,
  journalEntries,
  orders,
  outlets,
  paymentIntents,
  posOrderTenders,
  tenants,
} from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { crmHttpError } from "./crm-promo-engine";
import { listLoyaltyAnomalies as listAnomalyRows } from "./loyalty-anomaly.service";
import { toLoyaltyTier } from "./loyalty-tier.service";
import { listLedgerForProfile } from "./point-ledger.service";
import {
  LOYALTY_AUTO_JOURNAL_EVENTS,
  lockLoyaltyJournalEntity,
} from "./accounting-auto-journal-amounts";

type ProgramRow = typeof loyaltyPrograms.$inferSelect;
export type UpdateLoyaltyProgramInput = z.output<
  typeof updateLoyaltyProgramInputSchema
>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Audit field names kept unmasked: names, numbers and flags, no personal data. */
const AUDIT_SAFE_FIELDS = [
  "name",
  "earnSpendIdr",
  "earnPoints",
  "expiryMonths",
  "rollingMonths",
  "pointValueIdr",
  "dailyPointCapPerCustomer",
  "employeeSelfServeBan",
  "referralEnabled",
  "isActive",
  "legalEntityId",
] as const;

/** Id of the virtual program of a tenant that has not saved one yet. */
const NO_PROGRAM_ID = "00000000-0000-0000-0000-000000000000";

function toProgram(
  tenantId: string,
  row: ProgramRow | undefined,
): LoyaltyProgram {
  if (!row)
    return loyaltyProgramSchema.parse({
      id: NO_PROGRAM_ID,
      tenantId,
      legalEntityId: null,
      name: "Poin Member",
      earnRate: { spendIdr: 10_000, points: 1 },
      expiryMonths: 12,
      rollingMonths: 12,
      pointValueIdr: 100,
      referral: defaultReferralRules,
      antiFraud: defaultLoyaltyAntiFraud,
      isActive: false,
      updatedAt: new Date(0).toISOString(),
    });
  return loyaltyProgramSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
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
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function pointValueLocked(): HttpError {
  return new HttpError(
    409,
    "POINT_VALUE_LOCKED",
    "Nilai poin tidak bisa diubah setelah poin pertama tercatat.",
  );
}

/**
 * The database trigger refuses a changed `point_value_idr` after the lock:
 * SQLSTATE 55000, constraint `loyalty_programs_point_value_locked`.
 */
function isPointValueTriggerError(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    (candidate.code === "55000" &&
      candidate.constraint === "loyalty_programs_point_value_locked") ||
    isPointValueTriggerError(candidate.cause, depth + 1)
  );
}

export async function getLoyaltyProgram(
  context: ScopedTenantContext,
): Promise<LoyaltyProgramWithTiers> {
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.tenantId, context.tenant.tenantId))
      .limit(1);
    // legend-3zd1: the tier ladder, lowest rank first.
    const tiers = await tx
      .select()
      .from(loyaltyTiers)
      .where(eq(loyaltyTiers.tenantId, context.tenant.tenantId))
      .orderBy(asc(loyaltyTiers.rank), asc(loyaltyTiers.id));
    return {
      program: toProgram(context.tenant.tenantId, row),
      tiers: tiers.map(toLoyaltyTier),
    };
  });
}

/**
 * Upserts the program. `referral`, `antiFraud` and (when `isActive` is
 * undefined) `isActive` keep the stored value, or the default for a first save.
 */
export async function updateLoyaltyProgram(
  context: ScopedTenantContext,
  actorUserId: string,
  input: Omit<UpdateLoyaltyProgramInput, "isActive"> & { isActive?: boolean },
  now = new Date(),
): Promise<LoyaltyProgram> {
  const tenantId = context.tenant.tenantId;
  try {
    return await withTenant(db, context, async (tx) => {
      await lockLoyaltyJournalEntity(tx, tenantId);
      const [existing] = await tx
        .select()
        .from(loyaltyPrograms)
        .where(eq(loyaltyPrograms.tenantId, tenantId))
        .limit(1)
        .for("update");
      if (
        existing?.pointValueLockedAt &&
        existing.pointValueIdr !== input.pointValueIdr
      )
        throw pointValueLocked();
      const before = toProgram(tenantId, existing);
      const antiFraud = input.antiFraud ?? before.antiFraud;
      const legalEntityId =
        input.legalEntityId === undefined
          ? before.legalEntityId
          : input.legalEntityId;
      if (legalEntityId !== before.legalEntityId && legalEntityId !== null) {
        const [outlet] = await tx
          .select({ id: outlets.id })
          .from(outlets)
          .where(
            and(
              eq(outlets.tenantId, tenantId),
              eq(outlets.legalEntityId, legalEntityId),
            ),
          )
          .limit(1);
        if (!outlet)
          throw new HttpError(
            400,
            "LOYALTY_ENTITY_INVALID",
            "Entitas program harus memiliki outlet di tenant ini.",
          );
      }
      if (legalEntityId !== before.legalEntityId) {
        // Payment and order publishers lock their source rows before emitting
        // events. Prevent new tenant-FK inserts and lock existing sources;
        // contention refuses this settings update, not the payment.
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint
              .select({ id: tenants.id })
              .from(tenants)
              .where(eq(tenants.id, tenantId))
              .for("update", { noWait: true });
            await savepoint.execute(sql`
              SELECT ${orders.id} FROM ${orders}
              WHERE ${orders.tenantId} = ${tenantId}
              ORDER BY ${orders.id}
              FOR SHARE NOWAIT
            `);
            await savepoint.execute(sql`
              SELECT ${paymentIntents.id} FROM ${paymentIntents}
              WHERE ${paymentIntents.tenantId} = ${tenantId}
              ORDER BY ${paymentIntents.id}
              FOR SHARE NOWAIT
            `);
          });
        } catch (error) {
          let cause: unknown = error;
          for (
            let depth = 0;
            depth < 5 && cause && typeof cause === "object";
            depth += 1
          ) {
            const candidate = cause as { code?: unknown; cause?: unknown };
            if (candidate.code === "55P03")
              throw new HttpError(
                409,
                "LOYALTY_ENTITY_BUSY",
                "Entitas poin sedang diproses. Coba lagi.",
              );
            cause = candidate.cause;
          }
          throw error;
        }
        // These historical facts do not snapshot their entity. The advisory
        // lock also serializes earn and fulfilment; the program row lock
        // conflicts with the point-ledger value trigger before insertion.
        const history = await tx.execute(sql`
          SELECT
            EXISTS (SELECT 1 FROM ${pointLedger} WHERE ${pointLedger.tenantId} = ${tenantId}) OR
            EXISTS (SELECT 1 FROM ${pointEarnRecords} WHERE ${pointEarnRecords.tenantId} = ${tenantId}) OR
            EXISTS (SELECT 1 FROM ${missionProgress} WHERE ${missionProgress.tenantId} = ${tenantId}) OR
            EXISTS (SELECT 1 FROM ${rewardRedemptions} WHERE ${rewardRedemptions.tenantId} = ${tenantId}) OR
            EXISTS (SELECT 1 FROM ${vouchers} WHERE ${vouchers.tenantId} = ${tenantId} AND ${vouchers.source} = 'loyalty_reward') OR
            EXISTS (SELECT 1 FROM ${loyaltyEarnParked} WHERE ${loyaltyEarnParked.tenantId} = ${tenantId}) OR
            EXISTS (SELECT 1 FROM ${loyaltyClaimPauses}
              WHERE ${loyaltyClaimPauses.tenantId} = ${tenantId}
                AND (${loyaltyClaimPauses.state} IN ('busy', 'ambiguous') OR
                  (${loyaltyClaimPauses.state} = 'active' AND ${loyaltyClaimPauses.resumeDeadline} > ${now}))) OR
            EXISTS (
              SELECT 1 FROM ${domainEventOutbox}
              WHERE ${domainEventOutbox.tenantId} = ${tenantId}
                AND ${domainEventOutbox.destination} = 'cloud-sync'
                AND ${domainEventOutbox.status} <> 'delivered'
                AND (
                  ${domainEventOutbox.event}->>'name' IN (${sql.join(
                    LOYALTY_AUTO_JOURNAL_EVENTS.map((event) => sql`${event}`),
                    sql`, `,
                  )}) OR
                  (${domainEventOutbox.event}->>'name' = 'order.paid' AND EXISTS (
                    SELECT 1 FROM ${orders}
                    WHERE ${orders.tenantId} = ${tenantId}
                      AND ${orders.id} = ${domainEventOutbox.aggregateId}
                      AND ${orders.customerProfileId} IS NOT NULL
                  )) OR
                  (${domainEventOutbox.event}->>'name' = 'payment.paid' AND EXISTS (
                    SELECT 1 FROM ${paymentIntents}
                    WHERE ${paymentIntents.tenantId} = ${tenantId}
                      AND ${paymentIntents.id} = ${domainEventOutbox.aggregateId}
                      AND EXISTS (
                        SELECT 1 FROM ${orders}
                        WHERE ${orders.tenantId} = ${tenantId}
                          AND ${orders.customerProfileId} IS NOT NULL
                          AND (
                            ${paymentIntents.orderId} = ${orders.id} OR
                            ${paymentIntents.id} = ${orders.paymentIntentId} OR
                            ${paymentIntents.paymentLinkId} = ${orders.paymentLinkId} OR
                            EXISTS (SELECT 1 FROM ${billSplits}
                              WHERE ${billSplits.tenantId} = ${tenantId}
                                AND ${billSplits.id} = ${paymentIntents.billSplitId}
                                AND ${billSplits.orderId} = ${orders.id}) OR
                            EXISTS (SELECT 1 FROM ${posOrderTenders}
                              WHERE ${posOrderTenders.tenantId} = ${tenantId}
                                AND ${posOrderTenders.orderId} = ${orders.id}
                                AND (${posOrderTenders.paymentIntentId} = ${paymentIntents.id}
                                  OR ${posOrderTenders.paymentLinkId} = ${paymentIntents.paymentLinkId}))
                          )
                      )
                  ))
                )
            ) OR
            EXISTS (SELECT 1 FROM ${autoJournalParked} WHERE ${autoJournalParked.tenantId} = ${tenantId} AND ${autoJournalParked.eventName} IN (${sql.join(
              LOYALTY_AUTO_JOURNAL_EVENTS.map((event) => sql`${event}`),
              sql`, `,
            )})) OR
            EXISTS (
              SELECT 1 FROM ${orders}
              WHERE ${orders.tenantId} = ${tenantId}
                AND ${orders.tableSessionId} IS NOT NULL
                AND ${orders.customerProfileId} IS NULL
                AND ${orders.paymentMode} = 'pay_first'
                AND ${orders.status} <> 'voided'
                AND (
                  (${orders.claimTokenHash} IS NOT NULL AND ${orders.claimRedeemedAt} IS NULL AND ${orders.claimExpiresAt} > ${now}) OR
                  (${orders.status} IN ('awaiting_payment', 'sent', 'completed') AND ${orders.claimTokenHash} IS NULL AND NOT EXISTS (
                    SELECT 1 FROM ${billSplits} WHERE ${billSplits.tenantId} = ${tenantId} AND ${billSplits.orderId} = ${orders.id}
                  )) OR
                  EXISTS (
                    SELECT 1 FROM ${billSplits}
                    WHERE ${billSplits.tenantId} = ${tenantId} AND ${billSplits.orderId} = ${orders.id}
                      AND (${billSplits.status} = 'pending' OR
                        (${billSplits.status} = 'paid' AND ${billSplits.claimTokenHash} IS NULL) OR
                        (${billSplits.status} = 'paid' AND ${billSplits.claimRedeemedAt} IS NULL AND ${billSplits.claimExpiresAt} > ${now}))
                  )
                )
            )
            AS has_history
        `);
        if (history.rows[0]?.has_history !== false)
          throw new HttpError(
            409,
            "LOYALTY_ENTITY_LOCKED",
            "Entitas program tidak dapat diubah karena riwayat loyalty perlu direkonsiliasi.",
          );
        const entries = await tx
          .select({ legalEntityId: journalEntries.legalEntityId })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.tenantId, tenantId),
              eq(journalEntries.sourceType, "loyalty"),
            ),
          );
        if (entries.some((entry) => entry.legalEntityId !== legalEntityId))
          throw new HttpError(
            409,
            "LOYALTY_ENTITY_LOCKED",
            "Entitas liabilitas poin tidak dapat dipindahkan setelah jurnal terbit.",
          );
      }
      const values = {
        legalEntityId,
        name: input.name,
        earnSpendIdr: idr(input.earnRate.spendIdr),
        earnPoints: input.earnRate.points,
        expiryMonths: input.expiryMonths,
        rollingMonths: input.rollingMonths,
        pointValueIdr: idr(input.pointValueIdr),
        dailyPointCapPerCustomer: antiFraud.dailyPointCapPerCustomer,
        employeeSelfServeBan: antiFraud.employeeSelfServeBan,
        referral: input.referral ?? before.referral,
        isActive: input.isActive ?? before.isActive,
        updatedAt: now,
        updatedBy: actorUserId,
      };
      const [row] = await tx
        .insert(loyaltyPrograms)
        .values({ tenantId, ...values })
        .onConflictDoUpdate({
          target: loyaltyPrograms.tenantId,
          set: values,
        })
        .returning();
      if (!row) throw new Error("Loyalty program upsert returned no row");
      const program = toProgram(tenantId, row);
      const summary = (value: LoyaltyProgram | null) =>
        value === null
          ? null
          : {
              name: value.name,
              earnSpendIdr: value.earnRate.spendIdr,
              earnPoints: value.earnRate.points,
              expiryMonths: value.expiryMonths,
              rollingMonths: value.rollingMonths,
              pointValueIdr: value.pointValueIdr,
              dailyPointCapPerCustomer:
                value.antiFraud.dailyPointCapPerCustomer,
              employeeSelfServeBan: value.antiFraud.employeeSelfServeBan,
              referralEnabled: value.referral.enabled,
              isActive: value.isActive,
              legalEntityId: value.legalEntityId,
            };
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(now.getTime()),
          tenantId,
          outletId: null,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: existing
            ? "loyalty_program.updated"
            : "loyalty_program.created",
          objectType: "loyalty_program",
          objectId: row.id,
          reason: null,
          maskedChanges: {
            before: maskAuditChanges(
              existing ? summary(before) : null,
              AUDIT_SAFE_FIELDS,
            ),
            after: maskAuditChanges(summary(program), AUDIT_SAFE_FIELDS),
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: now.toISOString(),
        },
        AUDIT_SAFE_FIELDS,
      );
      return program;
    });
  } catch (error) {
    if (isPointValueTriggerError(error)) throw pointValueLocked();
    throw error;
  }
}

/** Point history of one customer for staff (newest first). */
export async function listCustomerPoints(
  context: ScopedTenantContext,
  customerProfileId: string,
  query: { cursor?: string; limit: number },
): Promise<Page<PointLedgerEntry>> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [profile] = await tx
      .select({ id: customerProfiles.id })
      .from(customerProfiles)
      .where(
        and(
          eq(customerProfiles.tenantId, tenantId),
          eq(customerProfiles.id, customerProfileId),
        ),
      )
      .limit(1);
    if (!profile) throw crmHttpError("CUSTOMER_NOT_FOUND");
    const { items, nextCursor } = await listLedgerForProfile(
      tx,
      tenantId,
      customerProfileId,
      query,
    );
    return { data: items, meta: { limit: query.limit, nextCursor } };
  });
}

export async function listLoyaltyAnomalies(
  context: ScopedTenantContext,
  query: { cursor?: string; limit: number; kind?: LoyaltyAnomalyKind },
): Promise<Page<LoyaltyAnomaly>> {
  return withTenant(db, context, async (tx) => {
    const { items, nextCursor } = await listAnomalyRows(
      tx,
      context.tenant.tenantId,
      query,
    );
    return {
      data: items,
      meta: { limit: query.limit, nextCursor },
    };
  });
}
