// Shared fixtures for the legend-m4p5 reward / redemption tests
// (member-rewards.test.ts and the mission tests). Not a test file.
//
// Seeding is raw SQL as the migration owner inside a tenant-GUC transaction
// (`asTenant`); the code under test runs as legend_app through `withTenant` /
// `withMemberScope`. Column names follow slice S of docs/briefs/sub-290c-slices.md.
// Points are granted through `postLedgerEntry` (the only ledger writer), never by
// touching `points_balance`.

import { randomUUID } from "node:crypto";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  memberTenantContext,
  withMemberScope,
  withProfileLock,
  type MemberScope,
} from "../db/member-scope.ts";
import { postLedgerEntry } from "../services/point-ledger.service.ts";
import {
  cancelRedemption,
  redeemReward,
} from "../services/reward-redemption.service.ts";
import { asTenant, NOW, type Profile } from "./member-loyalty-helpers.ts";

/** Far future so a real-clock HTTP call never meets an expired grant. */
export const GRANT_EXPIRY = new Date("2030-01-01T00:00:00Z");

export function scopeOf(tenantId: string, profile: Profile): MemberScope {
  return {
    context: memberTenantContext(tenantId),
    tenantId,
    userId: profile.userId,
    customerProfileId: profile.id,
    status: "active",
  };
}

/** Grants `points` to a profile with an `earn` row (as the app role). */
export async function grantPoints(
  tenantId: string,
  profileId: string,
  points: number,
  expiresAt: Date = GRANT_EXPIRY,
): Promise<void> {
  const context = memberTenantContext(tenantId);
  await withTenant(db, context, async (tx) => {
    await withProfileLock(tx, tenantId, profileId);
    await postLedgerEntry(
      tx,
      context,
      {
        tenantId,
        customerProfileId: profileId,
        type: "earn",
        points,
        sourceType: "order",
        sourceId: createUlid(),
        expiresAt,
      },
      NOW,
    );
  });
}

export async function brandOf(tenantId: string): Promise<string> {
  const { rows } = await asTenant(tenantId, (client) =>
    client.query<{ id: string }>(
      "SELECT id FROM brands WHERE tenant_id = $1 ORDER BY created_at LIMIT 1",
      [tenantId],
    ),
  );
  return rows[0]!.id;
}

/** A menu item (and a category) for the tenant's first brand. */
export async function seedMenuItem(tenantId: string): Promise<string> {
  const brandId = await brandOf(tenantId);
  const categoryId = randomUUID();
  const itemId = randomUUID();
  await asTenant(tenantId, async (client) => {
    await client.query(
      "INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Hadiah')",
      [categoryId, tenantId, brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Hadiah', true, $5)`,
      [itemId, tenantId, brandId, categoryId, randomUUID()],
    );
  });
  return itemId;
}

export type RewardOptions = {
  name?: string;
  type?: "free_item" | "item_upgrade" | "voucher";
  pointsCost?: number;
  /** null = unlimited. */
  stock?: number | null;
  validFrom?: string;
  validUntil?: string | null;
  isActive?: boolean;
  voucherValueIdr?: number;
  perCustomerLimit?: number | null;
  redemptionValidDays?: number;
  menuItemId?: string;
};

/** A reward row; item types get a menu item, voucher type a value. */
export async function seedReward(
  tenantId: string,
  options: RewardOptions = {},
): Promise<string> {
  const id = randomUUID();
  const type = options.type ?? "free_item";
  const isVoucher = type === "voucher";
  const menuItemId = isVoucher
    ? null
    : (options.menuItemId ?? (await seedMenuItem(tenantId)));
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO rewards
         (id, tenant_id, name, description, type, points_cost, stock, valid_from, valid_until,
          menu_item_id, voucher_value_idr, is_active, sort_order, per_customer_limit, redemption_valid_days)
       VALUES ($1, $2, $3, '', $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13)`,
      [
        id,
        tenantId,
        options.name ?? `Hadiah ${id.slice(0, 6)}`,
        type,
        options.pointsCost ?? 50,
        options.stock === undefined ? null : options.stock,
        options.validFrom ?? "2026-01-01T00:00:00Z",
        options.validUntil ?? null,
        menuItemId,
        isVoucher ? (options.voucherValueIdr ?? 25_000) : null,
        options.isActive ?? true,
        options.perCustomerLimit ?? null,
        options.redemptionValidDays ?? 30,
      ],
    ),
  );
  return id;
}

export type RewardRow = { stock: number | null; points_cost: number };

export async function rewardOf(
  tenantId: string,
  rewardId: string,
): Promise<RewardRow> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<RewardRow>(
      "SELECT stock, points_cost FROM rewards WHERE tenant_id = $1 AND id = $2",
      [tenantId, rewardId],
    );
    return rows[0]!;
  });
}

export type RedemptionRow = {
  id: string;
  reward_id: string;
  customer_profile_id: string;
  status: string;
  points_spent: number;
  redemption_code: string;
  idempotency_key: string;
  order_id: string | null;
  voucher_id: string | null;
  ledger_entry_id: string | null;
  restore_entry_id: string | null;
  fulfilled_at: Date | null;
  cancelled_at: Date | null;
  expires_at: Date;
};

export async function redemptionsOf(
  tenantId: string,
  profileId: string,
): Promise<RedemptionRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<RedemptionRow>(
      `SELECT id, reward_id, customer_profile_id, status, points_spent, redemption_code, idempotency_key,
              order_id, voucher_id, ledger_entry_id, restore_entry_id, fulfilled_at, cancelled_at, expires_at
         FROM reward_redemptions WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY created_at, id`,
      [tenantId, profileId],
    );
    return rows;
  });
}

export async function redemptionRow(
  tenantId: string,
  redemptionId: string,
): Promise<RedemptionRow> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<RedemptionRow>(
      `SELECT id, reward_id, customer_profile_id, status, points_spent, redemption_code, idempotency_key,
              order_id, voucher_id, ledger_entry_id, restore_entry_id, fulfilled_at, cancelled_at, expires_at
         FROM reward_redemptions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, redemptionId],
    );
    return rows[0]!;
  });
}

export type LedgerDetail = {
  id: string;
  type: string;
  points: number;
  source_type: string;
  source_id: string | null;
  reverses_entry_id: string | null;
  reason: string | null;
  expires_at: Date | null;
};

export async function ledgerDetail(
  tenantId: string,
  profileId: string,
): Promise<LedgerDetail[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<LedgerDetail>(
      `SELECT id, type, points::int AS points, source_type, source_id, reverses_entry_id, reason, expires_at
         FROM point_ledger WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY posting_seq`,
      [tenantId, profileId],
    );
    return rows;
  });
}

export type VoucherRow = {
  id: string;
  customer_profile_id: string | null;
  promotion_id: string | null;
  source: string;
  status: string;
  value_idr: string | null;
  code_hash: string;
  valid_until: Date | null;
  redeemed_order_id: string | null;
};

export async function vouchersOf(
  tenantId: string,
  profileId: string,
): Promise<VoucherRow[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<VoucherRow>(
      `SELECT id, customer_profile_id, promotion_id, source, status, value_idr::text, code_hash,
              valid_until, redeemed_order_id
         FROM vouchers WHERE tenant_id = $1 AND customer_profile_id = $2 ORDER BY issued_at, id`,
      [tenantId, profileId],
    );
    return rows;
  });
}

/** Marks a voucher as used on an order, the way the POS voucher flow does. */
export async function markVoucherRedeemed(
  tenantId: string,
  voucherId: string,
  orderUlid: string,
  redeemedAt: string,
): Promise<void> {
  await asTenant(tenantId, (client) =>
    client.query(
      `UPDATE vouchers SET status = 'redeemed', redeemed_at = $3, redeemed_order_id = $4
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, voucherId, redeemedAt, ulidToUuid(orderUlid)],
    ),
  );
}

/** Outbox events by name for a profile (payload.customerProfileId). */
export async function eventsOf(
  tenantId: string,
  name: string,
  profileId: string,
): Promise<{ payload: Record<string, unknown> }[]> {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ payload: Record<string, unknown> }>(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'customerProfileId' = $3
        ORDER BY created_at`,
      [tenantId, name, profileId],
    );
    return rows;
  });
}

// ---- service calls, each in its own member transaction ------------------------

export function redeemAs(
  scope: MemberScope,
  rewardId: string,
  idempotencyKey: string,
  now: Date = NOW,
) {
  return withMemberScope(db, scope, (tx) =>
    redeemReward(tx, scope, rewardId, idempotencyKey, now),
  );
}

export function cancelAs(
  scope: MemberScope,
  redemptionId: string,
  now: Date = NOW,
) {
  return withMemberScope(db, scope, (tx) =>
    cancelRedemption(tx, scope, redemptionId, now),
  );
}

/** Error code of an HttpError (or the raw message when it is another error). */
export async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error("Expected the call to fail, but it succeeded");
}

export const key = () => `idem-${randomUUID()}`;
