// Missions and stamp cards (legend-m4p5, docs/design/ws08-member-loyalty.md
// §M6 step 8 and §3 0195). Three parts: the progress engine called by the
// earn consumer after the visit row (`advanceMissions`), the member read
// (`listMissionsForMember`) and the staff catalog (`listMissions`,
// `createMission`, `updateMission`).
//
// The consumer holds the profile lock; a progress row is then locked
// (`FOR UPDATE`) before any voucher row is written. Ledger rows go only
// through `postLedgerEntry`. Refunds and voids do not undo progress (m1).

import { randomInt, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  gt,
  type SQL,
} from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  idr,
  tenantIdSchema,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import {
  createMissionInputSchema,
  missionProgressSchema,
  missionSchema,
  updateMissionInputSchema,
  type Mission,
  type MissionPeriod,
  type MissionWithProgress,
} from "@starter/shared/crm";
import { db } from "../db";
import { memberTenantContext, type MemberScope } from "../db/member-scope.ts";
import { customerVisits } from "../db/schema/crm-ledger";
import { vouchers } from "../db/schema/crm-promo";
import { missionProgress, missions } from "../db/schema/crm-rewards";
import { orderItems } from "../db/schema/qr-order";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { hashPromoCode } from "./crm-promo-engine";
import type { Tx } from "./inventory-ops.shared.ts";
import type { EarnStepContext } from "./loyalty-earn-step-context.ts";
import { postLedgerEntry } from "./point-ledger.service";

type MissionRow = typeof missions.$inferSelect;
type ProgressRow = typeof missionProgress.$inferSelect;
export type CreateMissionInput = z.output<typeof createMissionInputSchema>;
export type UpdateMissionInput = z.output<typeof updateMissionInputSchema>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const CODE_ATTEMPTS = 3;
const DAY_MS = 86_400_000;
/** Outlets default to Asia/Jakarta (UTC+7, no DST): used where no order gives a business date. */
const DEFAULT_OFFSET_MS = 7 * 3_600_000;

/** Audit field names kept unmasked: numbers and flags, no personal data. */
// `name` is left out: the audit schema rejects raw values of name-like keys.
const AUDIT_SAFE_FIELDS = ["type", "isActive", "startsAt", "endsAt"] as const;

// ---- Pure helpers -----------------------------------------------------------

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

function utcOfBusinessDate(businessDate: string): Date {
  const [year, month, day] = businessDate.split("-").map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, day));
}

/** ISO 8601 week label, e.g. `2026-W46`. */
function isoWeekKey(businessDate: string): string {
  const date = utcOfBusinessDate(businessDate);
  const weekdayIndex = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekdayIndex + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekdayIndex = (firstThursday.getUTCDay() + 6) % 7;
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / DAY_MS -
        3 +
        firstWeekdayIndex) /
        7,
    );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * `2026-11`, `2026-W46` or `2026-11-01..2026-11-30`. Null when a date range
 * does not contain the business date (the mission does not apply that day).
 */
export function missionPeriodKey(
  period: MissionPeriod,
  businessDate: string,
): string | null {
  if (period.kind === "monthly") return businessDate.slice(0, 7);
  if (period.kind === "weekly") return isoWeekKey(businessDate);
  if (businessDate < period.start || businessDate > period.end) return null;
  return `${period.start}..${period.end}`;
}

function businessDateOfInstant(instant: Date): string {
  return new Date(instant.getTime() + DEFAULT_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function targetOf(mission: Mission): number {
  const rule = mission.rule;
  switch (rule.kind) {
    case "visit_count":
    case "weekday_visit":
      return rule.targetVisits;
    case "try_new_item":
      return rule.targetItems;
    case "stamp_card":
      return rule.stampsRequired;
  }
}

function newCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

// ---- Row mapping ------------------------------------------------------------

function toMission(row: MissionRow): Mission {
  return missionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description ?? "",
    type: row.type,
    rule: row.rule,
    reward: row.reward,
    period: row.period,
    isActive: row.isActive,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
  });
}

function toProgress(row: ProgressRow) {
  return missionProgressSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    missionId: row.missionId,
    customerProfileId: row.customerProfileId,
    progress: row.progress,
    target: row.target,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    rewardIssuedAt: row.rewardIssuedAt
      ? row.rewardIssuedAt.toISOString()
      : null,
  });
}

/** Missions of the tenant that are on and inside their validity window at `at`. */
function validAt(tenantId: string, at: Date): SQL {
  return and(
    eq(missions.tenantId, tenantIdSchema.parse(tenantId)),
    eq(missions.isActive, true),
    or(isNull(missions.startsAt), lte(missions.startsAt, at)),
    or(isNull(missions.endsAt), gt(missions.endsAt, at)),
  ) as SQL;
}

// ---- Progress engine (earn consumer step) -----------------------------------

/** Items of the order the member never ordered before (voided lines ignored). */
async function newItemCount(
  context: EarnStepContext,
  menuItemIds: string[],
): Promise<number> {
  const { tx, tenantId, profile, order } = context;
  const lines = await tx
    .selectDistinct({ menuItemId: orderItems.menuItemId })
    .from(orderItems)
    .where(
      and(
        eq(orderItems.tenantId, tenantIdSchema.parse(tenantId)),
        eq(orderItems.orderId, order.id),
        ne(orderItems.status, "voided"),
        menuItemIds.length > 0
          ? inArray(orderItems.menuItemId, menuItemIds)
          : undefined,
      ),
    );
  const candidates = lines.map((line) => line.menuItemId);
  if (candidates.length === 0) return 0;
  const earlier = await tx
    .selectDistinct({ menuItemId: orderItems.menuItemId })
    .from(orderItems)
    .innerJoin(
      customerVisits,
      and(
        eq(customerVisits.tenantId, orderItems.tenantId),
        eq(customerVisits.orderId, orderItems.orderId),
      ),
    )
    .where(
      and(
        eq(orderItems.tenantId, tenantIdSchema.parse(tenantId)),
        eq(customerVisits.customerProfileId, profile.id),
        ne(orderItems.orderId, order.id),
        ne(orderItems.status, "voided"),
        inArray(orderItems.menuItemId, candidates),
      ),
    );
  const seen = new Set(earlier.map((line) => line.menuItemId));
  return candidates.filter((id) => !seen.has(id)).length;
}

/** How far this visit moves a mission (0 when it does not apply). */
async function incrementOf(
  context: EarnStepContext,
  mission: Mission,
): Promise<number> {
  const rule = mission.rule;
  switch (rule.kind) {
    case "visit_count":
    case "stamp_card":
      return 1;
    case "weekday_visit":
      return rule.weekdays.includes(
        utcOfBusinessDate(context.order.businessDate).getUTCDay(),
      )
        ? 1
        : 0;
    case "try_new_item":
      return newItemCount(context, rule.menuItemIds);
  }
}

/** Inserts a value voucher with a fresh code; returns its id and code. */
async function issueMissionVoucher(
  tx: Tx,
  tenantId: string,
  profileId: string,
  valueIdr: number,
  validDays: number,
  now: Date,
): Promise<{ id: string; code: string }> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = newCode();
    const [row] = await tx
      .insert(vouchers)
      .values({
        tenantId: tenantIdSchema.parse(tenantId),
        promotionId: null,
        customerProfileId: profileId,
        codeHash: hashPromoCode(code),
        source: "loyalty_reward",
        status: "issued",
        valueIdr: idr(valueIdr),
        validFrom: now,
        validUntil: new Date(now.getTime() + validDays * DAY_MS),
        issuedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: vouchers.id });
    if (row) return { id: row.id, code };
  }
  throw new Error("Could not generate a unique mission voucher code");
}

/** Issues the reward of a completed mission once (`reward_issued_at` guard). */
async function issueReward(
  context: EarnStepContext,
  mission: Mission,
  progress: ProgressRow,
  now: Date,
): Promise<void> {
  const { tx, tenantId, profile, program, order } = context;
  const reward = mission.reward;
  if (reward.kind === "points") {
    await postLedgerEntry(
      tx,
      memberTenantContext(tenantId),
      {
        tenantId,
        customerProfileId: profile.id,
        outletId: order.outletId,
        type: "bonus",
        points: reward.points,
        sourceType: "mission",
        sourceId: progress.id,
        expiresAt: addMonthsUtc(order.paidAt, program.expiryMonths),
        businessDate: order.businessDate,
      },
      now,
    );
    await tx
      .update(missionProgress)
      .set({ rewardIssuedAt: now, updatedAt: now })
      .where(
        and(
          eq(missionProgress.tenantId, tenantIdSchema.parse(tenantId)),
          eq(missionProgress.id, progress.id),
        ),
      );
    return;
  }
  const voucher = await issueMissionVoucher(
    tx,
    tenantId,
    profile.id,
    reward.valueIdr,
    reward.validDays,
    now,
  );
  await tx
    .update(missionProgress)
    .set({
      rewardIssuedAt: now,
      voucherId: voucher.id,
      voucherCode: voucher.code,
      updatedAt: now,
    })
    .where(
      and(
        eq(missionProgress.tenantId, tenantIdSchema.parse(tenantId)),
        eq(missionProgress.id, progress.id),
      ),
    );
}

/**
 * Moves every mission this visit touches. Runs in the consumer's transaction
 * under the profile lock, after the visit row. Replaying the same order would
 * add its step twice, but the consumer stops at the earn record first; the
 * reward itself is idempotent (guard column plus the ledger dedupe key).
 */
export async function advanceMissions(
  context: EarnStepContext,
  now: Date = new Date(),
): Promise<void> {
  const { tx, tenantId, profile, order } = context;
  const tenant = tenantIdSchema.parse(tenantId);
  const rows = await tx
    .select()
    .from(missions)
    .where(validAt(tenantId, order.paidAt));
  for (const row of rows) {
    const mission = toMission(row);
    const periodKey = missionPeriodKey(mission.period, order.businessDate);
    if (periodKey === null) continue;
    const increment = await incrementOf(context, mission);
    const target = targetOf(mission);
    await tx
      .insert(missionProgress)
      .values({
        tenantId: tenant,
        missionId: mission.id,
        customerProfileId: profile.id,
        periodKey,
        target,
      })
      .onConflictDoNothing();
    const [progress] = await tx
      .select()
      .from(missionProgress)
      .where(
        and(
          eq(missionProgress.tenantId, tenant),
          eq(missionProgress.missionId, mission.id),
          eq(missionProgress.customerProfileId, profile.id),
          eq(missionProgress.periodKey, periodKey),
        ),
      )
      .for("update");
    if (!progress) throw new Error("Mission progress row missing after upsert");
    let current = progress;
    if (increment > 0 && progress.progress < progress.target) {
      const next = Math.min(progress.target, progress.progress + increment);
      const completedAt = next >= progress.target ? now : null;
      const [updated] = await tx
        .update(missionProgress)
        .set({ progress: next, completedAt, updatedAt: now })
        .where(
          and(
            eq(missionProgress.tenantId, tenant),
            eq(missionProgress.id, progress.id),
          ),
        )
        .returning();
      if (!updated) throw new Error("Mission progress update returned no row");
      current = updated;
    }
    if (current.completedAt !== null && current.rewardIssuedAt === null)
      await issueReward(context, mission, current, now);
  }
}

// ---- Member read ------------------------------------------------------------

/**
 * Active missions valid at `now` with the member's progress in the current
 * period (null before the first visit, or outside a date range). Runs in
 * `withMemberScope`, so RLS narrows progress rows to the member.
 */
export async function listMissionsForMember(
  tx: Tx,
  scope: MemberScope,
  now: Date,
): Promise<MissionWithProgress[]> {
  const rows = await tx
    .select()
    .from(missions)
    .where(validAt(scope.tenantId, now))
    .orderBy(missions.createdAt, missions.id);
  const profileId = scope.customerProfileId;
  if (profileId === null)
    throw new HttpError(403, "FORBIDDEN", "Akses ditolak.");
  if (rows.length === 0) return [];
  const businessDate = businessDateOfInstant(now);
  const progressRows = await tx
    .select()
    .from(missionProgress)
    .where(
      and(
        eq(missionProgress.tenantId, tenantIdSchema.parse(scope.tenantId)),
        eq(missionProgress.customerProfileId, profileId),
        inArray(
          missionProgress.missionId,
          rows.map((row) => row.id),
        ),
      ),
    );
  return rows.map((row) => {
    const mission = toMission(row);
    const periodKey = missionPeriodKey(mission.period, businessDate);
    const progress =
      periodKey === null
        ? undefined
        : progressRows.find(
            (item) => item.missionId === row.id && item.periodKey === periodKey,
          );
    return {
      mission,
      progress: progress ? toProgress(progress) : null,
      voucherCode: progress?.voucherCode ?? null,
    };
  });
}

/** Route-facing name used by `routes/member-rewards.routes.ts`. */
export const listMemberMissions = listMissionsForMember;

// ---- Staff catalog ----------------------------------------------------------

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

function auditSummary(mission: Mission | null) {
  if (mission === null) return null;
  return {
    name: mission.name,
    type: mission.type,
    isActive: mission.isActive,
    startsAt: mission.startsAt,
    endsAt: mission.endsAt,
  };
}

async function audit(
  tx: Parameters<typeof recordAudit>[0],
  context: ScopedTenantContext,
  actorUserId: string,
  action: "mission.created" | "mission.updated",
  before: Mission | null,
  after: Mission,
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
      objectType: "mission",
      objectId: after.id,
      reason: null,
      maskedChanges: {
        before: maskAuditChanges(auditSummary(before), AUDIT_SAFE_FIELDS),
        after: maskAuditChanges(auditSummary(after), AUDIT_SAFE_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    AUDIT_SAFE_FIELDS,
  );
}

/** Newest first; the cursor encodes `[createdAt, id]`. */
export async function listMissions(
  context: ScopedTenantContext,
  query: { cursor?: string; limit: number; active?: "true" | "false" },
): Promise<Page<Mission>> {
  const tenantId = context.tenant.tenantId;
  const conditions: SQL[] = [eq(missions.tenantId, tenantId)];
  if (query.active !== undefined)
    conditions.push(eq(missions.isActive, query.active === "true"));
  if (query.cursor !== undefined) {
    let keys: ReturnType<typeof decodeCursor>;
    try {
      keys = decodeCursor(query.cursor);
    } catch {
      throw invalid("Cursor tidak valid.");
    }
    const [createdAt, id] = keys;
    if (typeof createdAt !== "string" || typeof id !== "string")
      throw invalid("Cursor tidak valid.");
    const at = new Date(createdAt);
    if (Number.isNaN(at.getTime())) throw invalid("Cursor tidak valid.");
    const before = or(
      lt(missions.createdAt, at),
      and(eq(missions.createdAt, at), lt(missions.id, id)),
    );
    if (before) conditions.push(before);
  }
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(missions)
      .where(and(...conditions))
      .orderBy(desc(missions.createdAt), desc(missions.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toMission),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.createdAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function createMission(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateMissionInput,
  now = new Date(),
): Promise<Mission> {
  const tenantId = context.tenant.tenantId;
  const candidate = missionSchema.safeParse({
    ...input,
    id: randomUUID(),
    tenantId,
  });
  if (!candidate.success)
    throw invalid(candidate.error.issues[0]?.message ?? "Data tidak valid.");
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .insert(missions)
      .values({
        tenantId,
        name: input.name,
        description: input.description,
        type: input.type,
        rule: input.rule,
        reward: input.reward,
        period: input.period,
        isActive: input.isActive,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        createdBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Mission insert returned no row");
    const mission = toMission(row);
    await audit(
      tx,
      context,
      actorUserId,
      "mission.created",
      null,
      mission,
      now,
    );
    return mission;
  });
}

export async function updateMission(
  context: ScopedTenantContext,
  actorUserId: string,
  missionId: string,
  patch: UpdateMissionInput,
  now = new Date(),
): Promise<Mission> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(missions)
      .where(and(eq(missions.tenantId, tenantId), eq(missions.id, missionId)))
      .limit(1)
      .for("update");
    if (!existing)
      throw new HttpError(404, "NOT_FOUND", "Misi tidak ditemukan.");
    const before = toMission(existing);
    // Validate the merged result so a type change cannot leave a stale rule.
    const merged = missionSchema.safeParse({
      ...before,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    });
    if (!merged.success)
      throw invalid(merged.error.issues[0]?.message ?? "Data tidak valid.");
    const next = merged.data;
    const [row] = await tx
      .update(missions)
      .set({
        name: next.name,
        description: next.description,
        type: next.type,
        rule: next.rule,
        reward: next.reward,
        period: next.period,
        isActive: next.isActive,
        startsAt: next.startsAt ? new Date(next.startsAt) : null,
        endsAt: next.endsAt ? new Date(next.endsAt) : null,
        updatedAt: now,
      })
      .where(and(eq(missions.tenantId, tenantId), eq(missions.id, missionId)))
      .returning();
    if (!row) throw new Error("Mission update returned no row");
    const mission = toMission(row);
    await audit(
      tx,
      context,
      actorUserId,
      "mission.updated",
      before,
      mission,
      now,
    );
    return mission;
  });
}
