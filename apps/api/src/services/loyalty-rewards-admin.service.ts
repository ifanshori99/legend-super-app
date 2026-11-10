// Reward catalog administration for staff (legend-m4p5,
// docs/design/ws08-member-loyalty.md §M5). Tenant-wide: the routes guard
// `crm.loyalty.manage`, and every function runs in `withTenant` so RLS scopes
// rows to the tenant. Redemption and stock are owned by
// `reward-redemption.service.ts`; this file never touches stock counters of a
// redemption, it only edits the catalog row.

import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import {
  createUlid,
  type ScopedTenantContext,
  type z,
} from "@starter/shared/core";
import {
  createRewardInputSchema,
  rewardSchema,
  updateRewardInputSchema,
  type Reward,
} from "@starter/shared/crm";
import { db } from "../db";
import { rewardRedemptions, rewards } from "../db/schema/crm-rewards";
import { menuItems } from "../db/schema/menu";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";

type RewardRow = typeof rewards.$inferSelect;
export type CreateRewardInput = z.output<typeof createRewardInputSchema>;
export type UpdateRewardInput = z.output<typeof updateRewardInputSchema>;
type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Audit field names kept unmasked: names, numbers and flags, no personal data. */
// `name` is left out: the audit schema rejects raw values of name-like keys.
const AUDIT_SAFE_FIELDS = [
  "type",
  "pointsCost",
  "stock",
  "menuItemId",
  "voucherValueIdr",
  "isActive",
  "sortOrder",
  "perCustomerLimit",
  "redemptionValidDays",
] as const;

const DEFAULT_REDEMPTION_VALID_DAYS = 30;
const CURSOR_PATTERN =
  /^(-?\d{1,10}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function toReward(row: RewardRow): Reward {
  return rewardSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    type: row.type,
    pointsCost: row.pointsCost,
    stock: row.stock,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    menuItemId: row.menuItemId,
    voucherValueIdr: row.voucherValueIdr,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    perCustomerLimit: row.perCustomerLimit,
    redemptionValidDays: row.redemptionValidDays,
  });
}

function auditSummary(reward: Reward | null) {
  if (reward === null) return null;
  return {
    type: reward.type,
    pointsCost: reward.pointsCost,
    stock: reward.stock,
    menuItemId: reward.menuItemId,
    voucherValueIdr: reward.voucherValueIdr,
    isActive: reward.isActive,
    sortOrder: reward.sortOrder,
    perCustomerLimit: reward.perCustomerLimit,
    redemptionValidDays: reward.redemptionValidDays,
  };
}

function invalid(message: string): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", message);
}

/** The named menu item must exist in the tenant (the FK would 500 otherwise). */
async function assertMenuItem(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  tenantId: string,
  menuItemId: string | null,
): Promise<void> {
  if (menuItemId === null) return;
  const [item] = await tx
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.tenantId, tenantId), eq(menuItems.id, menuItemId)))
    .limit(1);
  if (!item) throw invalid("Menu item tidak ditemukan.");
}

async function audit(
  tx: Parameters<typeof recordAudit>[0],
  context: ScopedTenantContext,
  actorUserId: string,
  action: "reward.created" | "reward.updated",
  before: Reward | null,
  after: Reward,
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
      objectType: "reward",
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

/** Catalog for staff, `sortOrder` then id; the cursor is `sortOrder:id`. */
export async function listRewards(
  context: ScopedTenantContext,
  query: { cursor?: string; limit: number; active?: "true" | "false" },
): Promise<Page<Reward>> {
  const tenantId = context.tenant.tenantId;
  const conditions: SQL[] = [eq(rewards.tenantId, tenantId)];
  if (query.active !== undefined)
    conditions.push(eq(rewards.isActive, query.active === "true"));
  if (query.cursor !== undefined) {
    const match = CURSOR_PATTERN.exec(query.cursor);
    if (!match) throw invalid("Cursor tidak valid.");
    const sortOrder = Number(match[1]);
    const id = match[2] as string;
    const after = or(
      gt(rewards.sortOrder, sortOrder),
      and(eq(rewards.sortOrder, sortOrder), gt(rewards.id, id)),
    );
    if (after) conditions.push(after);
  }
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(rewards)
      .where(and(...conditions))
      .orderBy(asc(rewards.sortOrder), asc(rewards.id))
      .limit(query.limit + 1);
    const pageRows = rows.slice(0, query.limit);
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toReward),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? `${last.sortOrder}:${last.id}`
            : null,
      },
    };
  });
}

export async function createReward(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateRewardInput,
  now = new Date(),
): Promise<Reward> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    await assertMenuItem(tx, tenantId, input.menuItemId);
    const [row] = await tx
      .insert(rewards)
      .values({
        tenantId,
        name: input.name,
        description: input.description,
        type: input.type,
        pointsCost: input.pointsCost,
        stock: input.stock,
        validFrom: new Date(input.validFrom),
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        menuItemId: input.menuItemId,
        voucherValueIdr: input.voucherValueIdr,
        isActive: input.isActive,
        sortOrder: input.sortOrder,
        perCustomerLimit: input.perCustomerLimit ?? null,
        redemptionValidDays:
          input.redemptionValidDays ?? DEFAULT_REDEMPTION_VALID_DAYS,
        createdBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Reward insert returned no row");
    const reward = toReward(row);
    await audit(tx, context, actorUserId, "reward.created", null, reward, now);
    return reward;
  });
}

export async function updateReward(
  context: ScopedTenantContext,
  actorUserId: string,
  rewardId: string,
  patch: UpdateRewardInput,
  now = new Date(),
): Promise<Reward> {
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(rewards)
      .where(and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId)))
      .limit(1)
      .for("update");
    if (!existing)
      throw new HttpError(404, "NOT_FOUND", "Hadiah tidak ditemukan.");
    const before = toReward(existing);
    // Validate the merged result so a type change cannot leave a stale
    // menu item or voucher value behind (contract `rewardSchema`).
    const merged = rewardSchema.safeParse({
      ...before,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ),
    });
    if (!merged.success)
      throw invalid(merged.error.issues[0]?.message ?? "Data tidak valid.");
    const next = merged.data;
    if (
      next.type !== existing.type ||
      next.menuItemId !== existing.menuItemId ||
      next.voucherValueIdr !== existing.voucherValueIdr
    ) {
      const [pending] = await tx
        .select({ id: rewardRedemptions.id })
        .from(rewardRedemptions)
        .where(
          and(
            eq(rewardRedemptions.tenantId, tenantId),
            eq(rewardRedemptions.rewardId, rewardId),
            eq(rewardRedemptions.status, "pending"),
          ),
        )
        .limit(1);
      if (pending)
        throw new HttpError(
          409,
          "REWARD_HAS_PENDING_REDEMPTIONS",
          "Hadiah masih punya penukaran yang belum selesai.",
        );
    }
    await assertMenuItem(tx, tenantId, next.menuItemId);
    const [row] = await tx
      .update(rewards)
      .set({
        name: next.name,
        description: next.description,
        type: next.type,
        pointsCost: next.pointsCost,
        stock: next.stock,
        validFrom: new Date(next.validFrom),
        validUntil: next.validUntil ? new Date(next.validUntil) : null,
        menuItemId: next.menuItemId,
        voucherValueIdr: next.voucherValueIdr,
        isActive: next.isActive,
        sortOrder: next.sortOrder,
        perCustomerLimit: next.perCustomerLimit,
        redemptionValidDays: next.redemptionValidDays,
        updatedAt: now,
      })
      .where(and(eq(rewards.tenantId, tenantId), eq(rewards.id, rewardId)))
      .returning();
    if (!row) throw new Error("Reward update returned no row");
    const reward = toReward(row);
    await audit(
      tx,
      context,
      actorUserId,
      "reward.updated",
      before,
      reward,
      now,
    );
    return reward;
  });
}
