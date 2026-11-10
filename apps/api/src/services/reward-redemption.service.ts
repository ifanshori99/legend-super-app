// Reward catalog reads and redemptions (legend-m4p5, docs/design/ws08-member-
// loyalty.md §M5, docs/briefs/sub-290c-slices.md "Slice R").
//
// Lock order everywhere: `withProfileLock` first, then `rewards ... FOR
// UPDATE`, then redemption and voucher rows. Points move only through
// `postLedgerEntry`; `points_balance` is never touched here. The profile id of
// a member call comes only from `scope.customerProfileId`.

import { randomInt, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  crmErrorMessages,
  rewardRedemptionCheck,
  type CrmErrorCode,
  type Reward,
  type RewardRedemption,
  type RewardRejectionReason,
  type RewardType,
} from "@starter/shared/crm";
import { withProfileLock, type MemberScope } from "../db/member-scope";
import { vouchers } from "../db/schema/crm-promo";
import { rewardRedemptions, rewards } from "../db/schema/crm-rewards";
import { orders } from "../db/schema/qr-order";
import { HttpError } from "../lib/http-error";
import { hashPromoCode } from "./crm-promo-engine";
import { postLedgerEntry } from "./point-ledger.service";
import type { Tx } from "./permission-resolver";

type RewardRow = typeof rewards.$inferSelect;
type RedemptionRow = typeof rewardRedemptions.$inferSelect;
type RedemptionWithType = RedemptionRow & { rewardType: RewardType };
type RewardRedemptionDto = RewardRedemption;
type Page = { cursor?: string; limit: number };

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const CODE_ATTEMPTS = 3;
const DAY_MS = 86_400_000;
const EXPIRY_BATCH = 200;

const REJECTION_CODE: Record<RewardRejectionReason, CrmErrorCode> = {
  reward_inactive: "REWARD_EXPIRED",
  not_started: "REWARD_EXPIRED",
  expired: "REWARD_EXPIRED",
  out_of_stock: "REWARD_OUT_OF_STOCK",
  insufficient_points: "POINTS_INSUFFICIENT",
  limit_reached: "REDEMPTION_LIMIT_REACHED",
};

const crmError = (code: CrmErrorCode, status: number): HttpError =>
  new HttpError(status, code, crmErrorMessages[code]);

const notFound = (): HttpError =>
  new HttpError(404, "NOT_FOUND", "Data tidak ditemukan.");

function badCursor(): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", "Kursor tidak valid.");
}

/** Unique violation (23505), directly or wrapped by drizzle; returns the
 * constraint name ("" when the driver gave none), null for other errors. */
function uniqueViolationConstraint(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return typeof candidate.constraint === "string" ? candidate.constraint : "";
  return uniqueViolationConstraint(candidate.cause, depth + 1);
}

function newRedemptionCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function toRedemptionDto(row: RedemptionWithType): RewardRedemptionDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    rewardId: row.rewardId,
    customerProfileId: row.customerProfileId,
    orderId: row.orderId,
    pointsSpent: row.pointsSpent,
    status: row.status,
    redemptionCode: row.redemptionCode,
    rewardType: row.rewardType,
    expiresAt: row.expiresAt.toISOString(),
    voucherId: row.voucherId,
    fulfilledOutletId: row.fulfilledOutletId,
    idempotencyKey: row.idempotencyKey,
    redeemedAt: row.redeemedAt.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  } as RewardRedemptionDto;
}

function toRewardDto(row: RewardRow): Reward {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    type: row.type,
    pointsCost: row.pointsCost,
    stock: row.stock,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    menuItemId: row.menuItemId,
    voucherValueIdr: row.voucherValueIdr,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    perCustomerLimit: row.perCustomerLimit,
    redemptionValidDays: row.redemptionValidDays,
  } as Reward;
}

async function findRedemptionByKey(
  tx: Tx,
  tenantId: string,
  profileId: string,
  idempotencyKey: string,
): Promise<RedemptionWithType | null> {
  const [row] = await tx
    .select({ redemption: rewardRedemptions, rewardType: rewards.type })
    .from(rewardRedemptions)
    .innerJoin(
      rewards,
      and(
        eq(rewards.tenantId, rewardRedemptions.tenantId),
        eq(rewards.id, rewardRedemptions.rewardId),
      ),
    )
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantIdSchema.parse(tenantId)),
        eq(rewardRedemptions.customerProfileId, profileId),
        eq(rewardRedemptions.idempotencyKey, idempotencyKey),
      ),
    );
  return row ? { ...row.redemption, rewardType: row.rewardType } : null;
}

async function lockReward(
  tx: Tx,
  tenantId: string,
  rewardId: string,
): Promise<RewardRow | null> {
  const [row] = await tx
    .select()
    .from(rewards)
    .where(
      and(
        eq(rewards.tenantId, tenantIdSchema.parse(tenantId)),
        eq(rewards.id, rewardId),
      ),
    )
    .for("update");
  return row ?? null;
}

async function lockRedemption(
  tx: Tx,
  tenantId: string,
  redemptionId: string,
): Promise<RedemptionRow | null> {
  const [row] = await tx
    .select()
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantIdSchema.parse(tenantId)),
        eq(rewardRedemptions.id, redemptionId),
      ),
    )
    .for("update");
  return row ?? null;
}

export async function listActiveRewards(
  tx: Tx,
  tenantId: string,
  page: Page,
): Promise<{ items: Reward[]; nextCursor: string | null }> {
  let after: { sortOrder: number; id: string } | null = null;
  if (page.cursor !== undefined) {
    const match = /^(-?\d{1,10})\|([0-9a-f-]{36})$/.exec(page.cursor);
    if (!match) throw badCursor();
    after = { sortOrder: Number(match[1]), id: match[2] as string };
  }
  const rows = await tx
    .select()
    .from(rewards)
    .where(
      and(
        eq(rewards.tenantId, tenantIdSchema.parse(tenantId)),
        eq(rewards.isActive, true),
        sql`${rewards.validFrom} <= now()`,
        sql`(${rewards.validUntil} IS NULL OR ${rewards.validUntil} > now())`,
        after === null
          ? undefined
          : sql`(${rewards.sortOrder}, ${rewards.id}) > (${after.sortOrder}, ${after.id}::uuid)`,
      ),
    )
    .orderBy(asc(rewards.sortOrder), asc(rewards.id))
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toRewardDto),
    nextCursor:
      rows.length > page.limit && last ? `${last.sortOrder}|${last.id}` : null,
  };
}

export async function listMemberRedemptions(
  tx: Tx,
  scope: MemberScope,
  page: Page,
): Promise<{ items: RewardRedemptionDto[]; nextCursor: string | null }> {
  const profileId = scope.customerProfileId;
  if (profileId === null) throw crmError("CUSTOMER_NOT_FOUND", 404);
  let after: { at: Date; id: string } | null = null;
  if (page.cursor !== undefined) {
    const match = /^(\d{1,15})\|([0-9a-f-]{36})$/.exec(page.cursor);
    if (!match) throw badCursor();
    after = { at: new Date(Number(match[1])), id: match[2] as string };
  }
  const rows = await tx
    .select({ redemption: rewardRedemptions, rewardType: rewards.type })
    .from(rewardRedemptions)
    .innerJoin(
      rewards,
      and(
        eq(rewards.tenantId, rewardRedemptions.tenantId),
        eq(rewards.id, rewardRedemptions.rewardId),
      ),
    )
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantIdSchema.parse(scope.tenantId)),
        eq(rewardRedemptions.customerProfileId, profileId),
        after === null
          ? undefined
          : sql`(${rewardRedemptions.redeemedAt}, ${rewardRedemptions.id}) < (${after.at.toISOString()}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(desc(rewardRedemptions.redeemedAt), desc(rewardRedemptions.id))
    .limit(page.limit + 1);
  const pageRows = rows.slice(0, page.limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map((row) =>
      toRedemptionDto({ ...row.redemption, rewardType: row.rewardType }),
    ),
    nextCursor:
      rows.length > page.limit && last
        ? `${last.redemption.redeemedAt.getTime()}|${last.redemption.id}`
        : null,
  };
}

export async function redeemReward(
  tx: Tx,
  scope: MemberScope,
  rewardId: string,
  idempotencyKey: string,
  now: Date,
): Promise<RewardRedemptionDto> {
  const profileId = scope.customerProfileId;
  if (profileId === null) throw crmError("CUSTOMER_NOT_FOUND", 404);
  const tenantId = tenantIdSchema.parse(scope.tenantId);
  const profile = await withProfileLock(tx, tenantId, profileId);

  const replay = await findRedemptionByKey(
    tx,
    tenantId,
    profileId,
    idempotencyKey,
  );
  if (replay) return toRedemptionDto(replay);

  const reward = await lockReward(tx, tenantId, rewardId);
  if (!reward) throw notFound();

  const [counted] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantId),
        eq(rewardRedemptions.customerProfileId, profileId),
        eq(rewardRedemptions.rewardId, reward.id),
        inArray(rewardRedemptions.status, ["pending", "fulfilled"]),
      ),
    );
  const decision = rewardRedemptionCheck({
    isActive: reward.isActive,
    stock: reward.stock,
    validFrom: reward.validFrom.toISOString(),
    validUntil: reward.validUntil?.toISOString() ?? null,
    pointsCost: reward.pointsCost,
    pointsBalance: Number(profile.pointsBalance),
    existingRedemptions: Number(counted?.count ?? 0),
    perCustomerLimit: reward.perCustomerLimit,
    at: now.toISOString(),
  });
  if (!decision.ok) throw crmError(REJECTION_CODE[decision.reason], 409);

  if (reward.stock !== null)
    await tx
      .update(rewards)
      .set({ stock: sql`${rewards.stock} - 1`, updatedAt: now })
      .where(and(eq(rewards.tenantId, tenantId), eq(rewards.id, reward.id)));

  const redemptionId = randomUUID();
  const expiresAt = new Date(
    now.getTime() + reward.redemptionValidDays * DAY_MS,
  );
  let inserted: RedemptionRow | null = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS && !inserted; attempt += 1) {
    const code = newRedemptionCode();
    try {
      // A savepoint keeps a code collision from aborting the transaction.
      inserted = await tx.transaction(async (savepoint) => {
        let voucherId: string | null = null;
        if (reward.type === "voucher") {
          const [voucher] = await savepoint
            .insert(vouchers)
            .values({
              tenantId,
              promotionId: null,
              customerProfileId: profileId,
              codeHash: hashPromoCode(code),
              source: "loyalty_reward",
              status: "issued",
              valueIdr: reward.voucherValueIdr,
              validFrom: now,
              validUntil: expiresAt,
              issuedAt: now,
            })
            .returning({ id: vouchers.id });
          voucherId = voucher?.id ?? null;
        }
        const [row] = await savepoint
          .insert(rewardRedemptions)
          .values({
            id: redemptionId,
            tenantId,
            rewardId: reward.id,
            customerProfileId: profileId,
            pointsSpent: reward.pointsCost,
            status: "pending",
            redemptionCode: code,
            idempotencyKey,
            redeemedAt: now,
            expiresAt,
            voucherId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        return row ?? null;
      });
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === null) throw error;
      if (constraint === "reward_redemptions_idempotency_key") {
        const raced = await findRedemptionByKey(
          tx,
          tenantId,
          profileId,
          idempotencyKey,
        );
        if (raced) return toRedemptionDto(raced);
      }
      // Otherwise the code collided: retry with a new one.
    }
  }
  if (!inserted)
    throw new HttpError(
      503,
      "REDEMPTION_CODE_UNAVAILABLE",
      "Kode penukaran belum bisa dibuat. Coba lagi.",
    );

  const { entry } = await postLedgerEntry(
    tx,
    scope.context,
    {
      tenantId,
      customerProfileId: profileId,
      type: "redeem",
      points: -reward.pointsCost,
      sourceType: "reward_redemption",
      sourceId: inserted.id,
      expiresAt: null,
      createdBy: scope.userId,
      event: { rewardId: reward.id },
    },
    now,
  );
  const [withLedger] = await tx
    .update(rewardRedemptions)
    .set({ ledgerEntryId: entry.id, updatedAt: now })
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantId),
        eq(rewardRedemptions.id, inserted.id),
      ),
    )
    .returning();
  return toRedemptionDto({
    ...(withLedger ?? inserted),
    rewardType: reward.type,
  });
}

/** Gives the points back and the stock; `reason` names the cause. */
async function restoreRedemption(
  tx: Tx,
  context: ScopedTenantContext,
  redemption: RedemptionRow,
  reward: RewardRow,
  status: "cancelled" | "expired",
  actorUserId: string | null,
  now: Date,
): Promise<RedemptionRow> {
  const { entry } = await postLedgerEntry(
    tx,
    context,
    {
      tenantId: redemption.tenantId,
      customerProfileId: redemption.customerProfileId,
      type: "adjust",
      points: redemption.pointsSpent,
      sourceType: "adjustment",
      sourceId: redemption.id,
      reversesEntryId: redemption.ledgerEntryId,
      expiresAt: null,
      reason:
        status === "cancelled" ? "redemption_cancelled" : "redemption_expired",
      createdBy: actorUserId,
    },
    now,
  );
  if (reward.stock !== null)
    await tx
      .update(rewards)
      .set({ stock: sql`${rewards.stock} + 1`, updatedAt: now })
      .where(
        and(eq(rewards.tenantId, reward.tenantId), eq(rewards.id, reward.id)),
      );
  const [row] = await tx
    .update(rewardRedemptions)
    .set({
      status,
      cancelledAt: status === "cancelled" ? now : null,
      restoreEntryId: entry.id,
      updatedAt: now,
    })
    .where(
      and(
        eq(rewardRedemptions.tenantId, redemption.tenantId),
        eq(rewardRedemptions.id, redemption.id),
      ),
    )
    .returning();
  if (!row) throw new Error("Redemption vanished while closing");
  return row;
}

/** Marks the voucher of a redemption cancelled; false when it was not
 * `issued` any more (used, expired or already cancelled). */
async function cancelVoucher(
  tx: Tx,
  redemption: RedemptionRow,
  reason: "redemption_cancelled" | "redemption_expired",
): Promise<boolean> {
  if (redemption.voucherId === null) return true;
  const rows = await tx
    .update(vouchers)
    .set({ status: "cancelled", cancelledReason: reason })
    .where(
      and(
        eq(vouchers.tenantId, redemption.tenantId),
        eq(vouchers.id, redemption.voucherId),
        eq(vouchers.status, "issued"),
      ),
    )
    .returning({ id: vouchers.id });
  return rows.length > 0;
}

export async function cancelRedemption(
  tx: Tx,
  scope: MemberScope,
  redemptionId: string,
  now: Date,
): Promise<RewardRedemptionDto> {
  const profileId = scope.customerProfileId;
  if (profileId === null) throw crmError("CUSTOMER_NOT_FOUND", 404);
  const tenantId = tenantIdSchema.parse(scope.tenantId);
  await withProfileLock(tx, tenantId, profileId);

  // Plain read first: the lock order needs the reward before the redemption.
  const [probe] = await tx
    .select({
      rewardId: rewardRedemptions.rewardId,
      customerProfileId: rewardRedemptions.customerProfileId,
    })
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantId),
        eq(rewardRedemptions.id, redemptionId),
      ),
    );
  if (!probe || probe.customerProfileId !== profileId) throw notFound();
  const reward = await lockReward(tx, tenantId, probe.rewardId);
  if (!reward) throw notFound();
  const redemption = await lockRedemption(tx, tenantId, redemptionId);
  if (!redemption || redemption.customerProfileId !== profileId)
    throw notFound();
  if (redemption.status !== "pending")
    throw crmError("REDEMPTION_NOT_CANCELLABLE", 409);
  // Zero rows throws, so the transaction rolls back and nothing is posted.
  if (!(await cancelVoucher(tx, redemption, "redemption_cancelled")))
    throw crmError("REDEMPTION_NOT_CANCELLABLE", 409);
  const closed = await restoreRedemption(
    tx,
    scope.context,
    redemption,
    reward,
    "cancelled",
    scope.userId,
    now,
  );
  return toRedemptionDto({ ...closed, rewardType: reward.type });
}

export async function fulfilRedemption(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  input: { redemptionCode: string; outletId: string; orderId?: string },
  now: Date,
): Promise<RewardRedemptionDto> {
  const tenantId = context.tenant.tenantId;
  const code = input.redemptionCode.trim().toUpperCase();
  const [probe] = await tx
    .select({
      id: rewardRedemptions.id,
      customerProfileId: rewardRedemptions.customerProfileId,
    })
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantId),
        eq(rewardRedemptions.redemptionCode, code),
      ),
    );
  if (!probe) throw notFound();
  await withProfileLock(tx, tenantId, probe.customerProfileId);
  const redemption = await lockRedemption(tx, tenantId, probe.id);
  if (!redemption) throw notFound();
  if (redemption.status !== "pending") throw crmError("VOUCHER_INVALID", 422);
  const [reward] = await tx
    .select()
    .from(rewards)
    .where(
      and(eq(rewards.tenantId, tenantId), eq(rewards.id, redemption.rewardId)),
    );
  if (!reward) throw notFound();

  let orderId: string | null = input.orderId ?? null;
  // The redemption decides, not the reward's current type (an edited reward
  // must not change how an open redemption settles).
  if (redemption.voucherId !== null) {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, redemption.voucherId),
        ),
      )
      .for("update");
    if (!voucher || voucher.status !== "redeemed")
      throw crmError("VOUCHER_INVALID", 422);
    orderId = voucher.redeemedOrderId;
  } else {
    if (redemption.expiresAt.getTime() <= now.getTime())
      throw crmError("REWARD_EXPIRED", 409);
    if (orderId !== null) {
      const [order] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
      if (!order) throw notFound();
    }
  }
  const [row] = await tx
    .update(rewardRedemptions)
    .set({
      status: "fulfilled",
      fulfilledAt: now,
      fulfilledOutletId: outletIdSchema.parse(input.outletId),
      fulfilledBy: actorUserId,
      orderId,
      updatedAt: now,
    })
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantId),
        eq(rewardRedemptions.id, redemption.id),
      ),
    )
    .returning();
  if (!row) throw notFound();
  return toRedemptionDto({ ...row, rewardType: reward.type });
}

/** Ids of pending redemptions past `expires_at`, oldest first. `exclude`
 * holds ids that already failed in this run, so they do not starve the rest. */
export async function listDueRedemptionIds(
  tx: Tx,
  tenantId: string,
  now: Date,
  limit: number = EXPIRY_BATCH,
  exclude: readonly string[] = [],
): Promise<string[]> {
  const conditions = [
    eq(rewardRedemptions.tenantId, tenantIdSchema.parse(tenantId)),
    eq(rewardRedemptions.status, "pending"),
    lte(rewardRedemptions.expiresAt, now),
  ];
  if (exclude.length > 0)
    conditions.push(notInArray(rewardRedemptions.id, [...exclude]));
  const due = await tx
    .select({ id: rewardRedemptions.id })
    .from(rewardRedemptions)
    .where(and(...conditions))
    .orderBy(asc(rewardRedemptions.expiresAt), asc(rewardRedemptions.id))
    .limit(limit);
  return due.map((row) => row.id);
}

/** Settles one pending redemption past `expires_at`, in the caller's own
 * transaction. A voucher already used at the till counts as fulfilled;
 * otherwise points, stock and voucher go back. `skipped` when it was settled
 * by someone else or is not due. Branches on the redemption's voucher, never
 * on the reward's current type. */
export async function expireRedemption(
  tx: Tx,
  context: ScopedTenantContext,
  redemptionId: string,
  now: Date,
): Promise<"expired" | "fulfilled" | "skipped"> {
  const tenantId = context.tenant.tenantId;
  const [probe] = await tx
    .select({
      customerProfileId: rewardRedemptions.customerProfileId,
      rewardId: rewardRedemptions.rewardId,
    })
    .from(rewardRedemptions)
    .where(
      and(
        eq(rewardRedemptions.tenantId, tenantId),
        eq(rewardRedemptions.id, redemptionId),
      ),
    );
  if (!probe) return "skipped";
  await withProfileLock(tx, tenantId, probe.customerProfileId);
  const reward = await lockReward(tx, tenantId, probe.rewardId);
  if (!reward) return "skipped";
  const redemption = await lockRedemption(tx, tenantId, redemptionId);
  if (
    !redemption ||
    redemption.status !== "pending" ||
    redemption.expiresAt.getTime() > now.getTime()
  )
    return "skipped";
  if (redemption.voucherId !== null) {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.tenantId, tenantId),
          eq(vouchers.id, redemption.voucherId),
        ),
      )
      .for("update");
    if (voucher?.status === "redeemed") {
      await tx
        .update(rewardRedemptions)
        .set({
          status: "fulfilled",
          fulfilledAt: voucher.redeemedAt ?? now,
          orderId: voucher.redeemedOrderId,
          updatedAt: now,
        })
        .where(
          and(
            eq(rewardRedemptions.tenantId, tenantId),
            eq(rewardRedemptions.id, redemption.id),
          ),
        );
      return "fulfilled";
    }
  }
  await cancelVoucher(tx, redemption, "redemption_expired");
  await restoreRedemption(
    tx,
    context,
    redemption,
    reward,
    "expired",
    null,
    now,
  );
  return "expired";
}
