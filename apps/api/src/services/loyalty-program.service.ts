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

import { and, eq } from "drizzle-orm";
import {
  createUlid,
  idr,
  type ScopedTenantContext,
} from "@starter/shared/core";
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
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { crmHttpError } from "./crm-promo-engine";
import { listLoyaltyAnomalies as listAnomalyRows } from "./loyalty-anomaly.service";
import { listLedgerForProfile } from "./point-ledger.service";

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
    // Tiers arrive with legend-3zd1 (290e); none exist yet.
    return { program: toProgram(context.tenant.tenantId, row), tiers: [] };
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
      const values = {
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
            before: existing ? summary(before) : null,
            after: summary(program),
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
