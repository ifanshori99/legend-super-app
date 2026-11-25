// Promo engine DB adapter against PostgreSQL (PRD v1.7 §3.21; LOY-03 atomic
// voucher/promo redemption under concurrency; TEN-01/02/03 isolation; bead
// legend-7x4g). Runs the real ports the POS/QR/website checkouts call inside
// their order transaction: redeemPromotions / releasePromotions /
// quotePromotions, with the restricted app role (RLS enforced).
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, idr, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type {
  PromoCustomer,
  PromoLine,
  PromotionApplicationResult,
} from "@starter/shared/crm";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { env } from "../config/env";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { getPromotionRoi } from "../services/crm-promo.service";
import {
  quotePromotions,
  redeemPromotions,
  releasePromotions,
  type RedeemPromotionsInput,
} from "../services/crm-promo-engine";
import { orderPromoPartialRefundPort } from "../services/order-promo-refund";
import { seedProfile } from "./member-loyalty-helpers";

import {
  seedPromoCustomer,
  seedPromoFacilityProduct,
} from "./crm-promo-test-helpers";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const otherPromotion = randomUUID();
const actor = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdPromotions: string[] = [];

const base = (tenant = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = () =>
  establishScopedTenantContext(base(), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const hash = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");
const code = () =>
  `T${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;

type PromotionSeed = {
  benefit?: unknown;
  conditions?: unknown[];
  quotaTotal?: number | null;
  quotaPerCustomer?: number | null;
  budgetIdr?: number | null;
  codeHash?: string | null;
  voucherRequired?: boolean;
  priority?: number;
  stackGroup?: string;
};

/**
 * An active promotion that only applies to bills holding its own item, so
 * tests (and other files sharing the seeded tenant) never see each other's.
 */
async function seedPromotion(item: string, seed: PromotionSeed = {}) {
  const id = randomUUID();
  createdPromotions.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, $3, '', 'active', $4, $5, now() - interval '1 hour', NULL, $6, $7, $8, true,
               $9, $10, $11, $12)`,
      [
        id,
        tenantId,
        `DB test ${id.slice(0, 8)}`,
        seed.codeHash ?? null,
        seed.voucherRequired ?? false,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
          ...(seed.conditions ?? []),
        ]),
        JSON.stringify(
          seed.benefit ?? {
            kind: "percent_off",
            percentBp: 1000,
            maxDiscountIdr: null,
          },
        ),
        seed.stackGroup ?? `g${id.slice(0, 8)}`,
        seed.priority ?? 0,
        seed.quotaTotal ?? null,
        seed.quotaPerCustomer ?? null,
        seed.budgetIdr ?? null,
      ],
    ),
  );
  return id;
}

async function seedVoucher(input: {
  code: string;
  promotionId: string | null;
  valueIdr?: number | null;
  customerProfileId?: string | null;
}) {
  const id = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, now() - interval '1 hour', NULL)`,
      [
        id,
        tenantId,
        input.promotionId,
        input.customerProfileId ?? null,
        hash(input.code),
        input.valueIdr ?? null,
      ],
    ),
  );
  return id;
}

async function promotionCounters(id: string) {
  const rows = await asOwner(tenantId, (client) =>
    client.query(
      "SELECT uses_total, spent_idr FROM promotions WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    ),
  );
  return {
    uses: Number(rows.rows[0].uses_total),
    spent: Number(rows.rows[0].spent_idr),
  };
}

const priced = (item: string, unit: number, quantity = 1): PromoLine => ({
  menuItemId: item,
  quantity,
  unitPriceIdr: idr(unit),
  lineTotalIdr: idr(unit * quantity),
});

const member = (id = randomUUID()): Promise<PromoCustomer> =>
  asOwner(tenantId, (client) => seedPromoCustomer(client, tenantId, id));

function redeemInput(
  lines: PromoLine[],
  overrides: Partial<RedeemPromotionsInput> = {},
): RedeemPromotionsInput {
  return {
    orderId: createUlid(),
    outletId: outletA,
    channel: "dine_in",
    lines,
    customer: null,
    voucherCode: null,
    at: new Date(),
    actorUserId: null,
    ...overrides,
  };
}

const redeem = (input: RedeemPromotionsInput, context = outletScope(outletA)) =>
  withTenant(db, context, (tx) => redeemPromotions(tx, context, input));
const release = (orderId: string, context = outletScope(outletA)) =>
  withTenant(db, context, (tx) =>
    releasePromotions(tx, context, {
      orderId,
      reason: "Void: salah input",
      actorUserId: actor,
      at: new Date(),
    }),
  );
const discountOf = (result: PromotionApplicationResult, promotionId: string) =>
  result.evaluations.find(
    (evaluation) =>
      evaluation.promotionId === promotionId && evaluation.applied,
  );
const errorCode = (reason: unknown) =>
  (reason as { code?: string } | undefined)?.code;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // Copy the seeded tenant's plan/flags/limits: the platform tenant list
  // validates every row against tenantSchema, so a minimal tenant would break
  // an unrelated suite (same approach as accounting-core.test.ts).
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Promo RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `promo-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
    await client.query(
      `INSERT INTO promotions (id, tenant_id, name, description, status, voucher_required, starts_at,
                               conditions, benefit, stack_group, stackable, priority)
       VALUES ($1, $2, 'Other tenant 90%', '', 'active', false, now() - interval '1 hour', '[]',
               '{"kind":"percent_off","percentBp":9000,"maxDiscountIdr":null}', 'x', true, 99)`,
      [otherPromotion, otherTenant],
    );
  });
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    if (createdPromotions.length > 0)
      await client.query(
        "UPDATE promotions SET status = 'ended' WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdPromotions],
      );
    await client.query("DELETE FROM promo_settings WHERE tenant_id = $1", [
      tenantId,
    ]);
  });
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM promotions WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [
      otherTenant,
    ]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
});

describe("LOY-03 race-safe quota, budget and voucher redemption", () => {
  it("loyalty reward vouchers cannot discount another legal entity's outlet", async () => {
    const isolatedTenant = randomUUID();
    const brand = randomUUID();
    const entityA = randomUUID();
    const entityB = randomUUID();
    const outletEntityA = outletIdSchema.parse(randomUUID());
    const outletEntityB = outletIdSchema.parse(randomUUID());
    const voucherId = randomUUID();
    const voucherCode = code();
    const rewardId = randomUUID();
    const missionId = randomUUID();
    const missionVoucherId = randomUUID();
    const missionVoucherCode = code();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Loyalty voucher entity test', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [
        isolatedTenant,
        `voucher-entity-${isolatedTenant.slice(0, 8)}`,
        tenantId,
      ],
    );
    const customer = await asOwner(isolatedTenant, async (client) => {
      await client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
        [brand, isolatedTenant],
      );
      await client.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
         VALUES ($1, $3, 'Entity A', false), ($2, $3, 'Entity B', false)`,
        [entityA, entityB, isolatedTenant],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $3, $4, $5, 'EA', 'Outlet A', 'Jl. A', 'Asia/Jakarta', '{}', 'active'),
                ($2, $3, $4, $6, 'EB', 'Outlet B', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
        [outletEntityA, outletEntityB, isolatedTenant, brand, entityA, entityB],
      );
      await client.query(
        `INSERT INTO loyalty_programs (tenant_id, legal_entity_id, is_active)
         VALUES ($1, $2, true)`,
        [isolatedTenant, entityA],
      );
      const member = await seedPromoCustomer(client, isolatedTenant);
      await client.query(
        `INSERT INTO vouchers (id, tenant_id, customer_profile_id, code_hash, source, value_idr, valid_from)
         VALUES ($1, $2, $3, $4, 'loyalty_reward', 20000, now() - interval '1 hour')`,
        [
          voucherId,
          isolatedTenant,
          member.customerProfileId,
          hash(voucherCode),
        ],
      );
      await client.query(
        `INSERT INTO rewards (id, tenant_id, name, type, points_cost, valid_from, voucher_value_idr)
         VALUES ($1, $2, 'Voucher poin', 'voucher', 10, now() - interval '1 hour', 20000)`,
        [rewardId, isolatedTenant],
      );
      await client.query(
        `INSERT INTO reward_redemptions
           (tenant_id, reward_id, customer_profile_id, points_spent, redemption_code, idempotency_key, expires_at, voucher_id)
         VALUES ($1, $2, $3, 10, $4, $5, now() + interval '30 days', $6)`,
        [
          isolatedTenant,
          rewardId,
          member.customerProfileId,
          voucherCode,
          `reward-${voucherId}`,
          voucherId,
        ],
      );
      // Mission vouchers share the source string but are not point redemptions.
      await client.query(
        `INSERT INTO vouchers (id, tenant_id, customer_profile_id, code_hash, source, value_idr, valid_from)
         VALUES ($1, $2, $3, $4, 'loyalty_reward', 15000, now() - interval '1 hour')`,
        [
          missionVoucherId,
          isolatedTenant,
          member.customerProfileId,
          hash(missionVoucherCode),
        ],
      );
      await client.query(
        `INSERT INTO missions (id, tenant_id, name, type, rule, reward, period)
         VALUES ($1, $2, 'Misi kunjungan', 'visit_count', $3::jsonb, $4::jsonb, $5::jsonb)`,
        [
          missionId,
          isolatedTenant,
          JSON.stringify({ kind: "visit_count", targetVisits: 1 }),
          JSON.stringify({ kind: "voucher", valueIdr: 15000, validDays: 30 }),
          JSON.stringify({ kind: "monthly" }),
        ],
      );
      await client.query(
        `INSERT INTO mission_progress
           (tenant_id, mission_id, customer_profile_id, period_key, progress, target, completed_at, reward_issued_at, voucher_id, voucher_code)
         VALUES ($1, $2, $3, '2026-10', 1, 1, now(), now(), $4, $5)`,
        [
          isolatedTenant,
          missionId,
          member.customerProfileId,
          missionVoucherId,
          missionVoucherCode,
        ],
      );
      return member;
    });
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: isolatedTenant,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const input = redeemInput([priced(randomUUID(), 50_000)], {
      customer,
      voucherCode,
      outletId: outletEntityB,
    });

    await expect(
      withTenant(db, context, (tx) => redeemPromotions(tx, context, input)),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });
    const rejected = await asOwner(isolatedTenant, async (client) => ({
      voucher: (
        await client.query("SELECT status FROM vouchers WHERE id = $1", [
          voucherId,
        ])
      ).rows[0],
      redemptions: (
        await client.query(
          "SELECT count(*)::int AS count FROM promotion_redemptions WHERE voucher_id = $1",
          [voucherId],
        )
      ).rows[0],
    }));
    expect(rejected.voucher.status).toBe("issued");
    expect(rejected.redemptions.count).toBe(0);

    // Another transaction holds the journal's entity lock. Checkout must
    // fail promptly, not wait while holding an order's tenant FK lock.
    const lockHolder = await owner.connect();
    try {
      await lockHolder.query("BEGIN");
      await lockHolder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`loyalty-entity:${isolatedTenant}`],
      );
      await expect(
        withTenant(db, context, async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
          return redeemPromotions(tx, context, {
            ...input,
            orderId: createUlid(),
            outletId: outletEntityA,
          });
        }),
      ).rejects.toMatchObject({ code: "LOYALTY_ENTITY_BUSY" });
    } finally {
      await lockHolder.query("ROLLBACK");
      lockHolder.release();
    }
    expect(
      (
        await asOwner(isolatedTenant, (client) =>
          client.query("SELECT status FROM vouchers WHERE id = $1", [
            voucherId,
          ]),
        )
      ).rows[0].status,
    ).toBe("issued");

    const accepted = await withTenant(db, context, (tx) =>
      redeemPromotions(tx, context, {
        ...input,
        orderId: createUlid(),
        outletId: outletEntityA,
      }),
    );
    expect(accepted.totalDiscountIdr).toBe(20_000);

    const missionInput = {
      ...input,
      orderId: createUlid(),
      voucherCode: missionVoucherCode,
    };
    await expect(
      withTenant(db, context, (tx) =>
        redeemPromotions(tx, context, missionInput),
      ),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });
    const missionRejected = await asOwner(isolatedTenant, async (client) => ({
      voucher: (
        await client.query("SELECT status FROM vouchers WHERE id = $1", [
          missionVoucherId,
        ])
      ).rows[0],
      redemptions: (
        await client.query(
          "SELECT count(*)::int AS count FROM promotion_redemptions WHERE voucher_id = $1",
          [missionVoucherId],
        )
      ).rows[0],
    }));
    expect(missionRejected.voucher.status).toBe("issued");
    expect(missionRejected.redemptions.count).toBe(0);

    const correctMissionInput = { ...missionInput, outletId: outletEntityA };
    const missionAccepted = await withTenant(db, context, (tx) =>
      redeemPromotions(tx, context, correctMissionInput),
    );
    expect(missionAccepted.totalDiscountIdr).toBe(15_000);
    const missionRetry = await withTenant(db, context, (tx) =>
      redeemPromotions(tx, context, correctMissionInput),
    );
    expect(missionRetry.totalDiscountIdr).toBe(15_000);
    const missionRows = await asOwner(isolatedTenant, (client) =>
      client.query(
        "SELECT status, discount_idr FROM promotion_redemptions WHERE tenant_id = $1 AND voucher_id = $2",
        [isolatedTenant, missionVoucherId],
      ),
    );
    expect(missionRows.rows).toEqual([
      { status: "applied", discount_idr: "15000" },
    ]);
    await expect(
      withTenant(db, context, (tx) =>
        redeemPromotions(tx, context, {
          ...correctMissionInput,
          orderId: createUlid(),
        }),
      ),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });

    // Legacy programs without an explicit entity can still redeem when all
    // outlets belong to the same entity, including after lock contention.
    const legacyVoucherId = randomUUID();
    const legacyCode = code();
    await asOwner(isolatedTenant, async (client) => {
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = NULL WHERE tenant_id = $1",
        [isolatedTenant],
      );
      await client.query(
        "UPDATE outlets SET legal_entity_id = $1 WHERE id = $2",
        [entityA, outletEntityB],
      );
      await client.query(
        `INSERT INTO vouchers (id, tenant_id, customer_profile_id, code_hash, source, value_idr, valid_from)
         VALUES ($1, $2, $3, $4, 'loyalty_reward', 20000, now() - interval '1 hour')`,
        [
          legacyVoucherId,
          isolatedTenant,
          customer.customerProfileId,
          hash(legacyCode),
        ],
      );
      await client.query(
        `INSERT INTO reward_redemptions
           (tenant_id, reward_id, customer_profile_id, points_spent, redemption_code, idempotency_key, expires_at, voucher_id)
         VALUES ($1, $2, $3, 10, $4, $5, now() + interval '30 days', $6)`,
        [
          isolatedTenant,
          rewardId,
          customer.customerProfileId,
          legacyCode,
          `reward-${legacyVoucherId}`,
          legacyVoucherId,
        ],
      );
    });
    const legacyInput = {
      ...input,
      orderId: createUlid(),
      outletId: outletEntityA,
      voucherCode: legacyCode,
    };
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM tenants WHERE id = $1 FOR KEY SHARE", [
        isolatedTenant,
      ]);
      await expect(
        withTenant(db, context, (tx) =>
          redeemPromotions(tx, context, legacyInput),
        ),
      ).rejects.toMatchObject({ code: "LOYALTY_ENTITY_BUSY" });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const outletHolder = await owner.connect();
    try {
      await outletHolder.query("BEGIN");
      await outletHolder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [isolatedTenant],
      );
      await outletHolder.query(
        "SELECT id FROM outlets WHERE id = $1 FOR UPDATE",
        [outletEntityB],
      );
      await expect(
        withTenant(db, context, (tx) =>
          redeemPromotions(tx, context, legacyInput),
        ),
      ).rejects.toMatchObject({ code: "LOYALTY_ENTITY_BUSY" });
    } finally {
      await outletHolder.query("ROLLBACK");
      outletHolder.release();
    }
    expect(
      (
        await asOwner(isolatedTenant, (client) =>
          client.query("SELECT status FROM vouchers WHERE id = $1", [
            legacyVoucherId,
          ]),
        )
      ).rows[0].status,
    ).toBe("issued");
    const legacyResult = await withTenant(db, context, (tx) =>
      redeemPromotions(tx, context, legacyInput),
    );
    expect(legacyResult.totalDiscountIdr).toBe(20_000);
    const legacyReplay = await withTenant(db, context, (tx) =>
      redeemPromotions(tx, context, legacyInput),
    );
    expect(legacyReplay.totalDiscountIdr).toBe(20_000);
    expect(
      Number(
        (
          await asOwner(isolatedTenant, (client) =>
            client.query(
              "SELECT count(*) AS count FROM promotion_redemptions WHERE voucher_id = $1",
              [legacyVoucherId],
            ),
          )
        ).rows[0].count,
      ),
    ).toBe(1);
  });
  it("[LOY-03] global quota 1 under 6 concurrent orders: exactly one gets the promotion", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, { quotaTotal: 1 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        redeem(redeemInput([priced(item, 50_000)])),
      ),
    );
    const winners = results.filter((result) => discountOf(result, promotionId));
    expect(winners).toHaveLength(1);
    expect(winners[0]?.totalDiscountIdr).toBe(5_000);
    expect(await promotionCounters(promotionId)).toEqual({
      uses: 1,
      spent: 5_000,
    });
  });

  it("[LOY-03] with the accepted quote, the losers are refused PROMO_QUOTA_EXHAUSTED instead of paying a different price", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, { quotaTotal: 2 });
    const lines = [priced(item, 40_000)];
    const context = outletScope(outletA);
    const quote = await withTenant(db, context, (tx) =>
      quotePromotions(tx, context, {
        outletId: outletA,
        channel: "dine_in",
        lines,
        customer: null,
        voucherCode: null,
        at: new Date(),
      }),
    );
    expect(quote.totalDiscountIdr).toBe(4_000);
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        redeem(redeemInput(lines, { expected: quote })),
      ),
    );
    const ok = settled.filter((entry) => entry.status === "fulfilled");
    const refused = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    expect(ok).toHaveLength(2);
    expect(refused).toHaveLength(3);
    for (const entry of refused)
      expect(errorCode(entry.reason)).toBe("PROMO_QUOTA_EXHAUSTED");
    expect((await promotionCounters(promotionId)).uses).toBe(2);
  });

  it("[LOY-03] budget Rp25.000 with Rp10.000 off under 5 concurrent orders: two fit, spent never passes the budget", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 10_000 },
      budgetIdr: 25_000,
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        redeem(redeemInput([priced(item, 60_000)])),
      ),
    );
    expect(
      results.filter((result) => discountOf(result, promotionId)),
    ).toHaveLength(2);
    expect(await promotionCounters(promotionId)).toEqual({
      uses: 2,
      spent: 20_000,
    });
  });

  it("[LOY-03] per-customer quota 1: the same customer wins once under concurrency, another customer still can", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, { quotaPerCustomer: 1 });
    const sari = await member();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        redeem(redeemInput([priced(item, 30_000)], { customer: sari })),
      ),
    );
    expect(
      results.filter((result) => discountOf(result, promotionId)),
    ).toHaveLength(1);
    const other = await redeem(
      redeemInput([priced(item, 30_000)], { customer: await member() }),
    );
    expect(discountOf(other, promotionId)).toBeTruthy();
    const anonymous = await redeem(redeemInput([priced(item, 30_000)]));
    expect(discountOf(anonymous, promotionId)).toBeFalsy();
  });

  it("[LOY-03] a single-use voucher redeemed by 5 concurrent orders: exactly one succeeds, the rest get VOUCHER_INVALID", async () => {
    const item = randomUUID();
    const voucherCode = code();
    const promotionId = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 15_000 },
      voucherRequired: true,
      codeHash: hash(code()),
    });
    const voucherId = await seedVoucher({ code: voucherCode, promotionId });
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        redeem(redeemInput([priced(item, 50_000)], { voucherCode })),
      ),
    );
    const ok = settled.filter(
      (entry): entry is PromiseFulfilledResult<PromotionApplicationResult> =>
        entry.status === "fulfilled",
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]?.value.totalDiscountIdr).toBe(15_000);
    for (const entry of settled)
      if (entry.status === "rejected")
        expect(errorCode(entry.reason)).toBe("VOUCHER_INVALID");
    const voucher = await asOwner(tenantId, (client) =>
      client.query("SELECT status FROM vouchers WHERE id = $1", [voucherId]),
    );
    expect(voucher.rows[0].status).toBe("redeemed");
  });

  it("[LOY-03] a multi-use promo code obeys its quota", async () => {
    const item = randomUUID();
    const promoCode = code();
    const promotionId = await seedPromotion(item, {
      voucherRequired: true,
      codeHash: hash(promoCode),
      quotaTotal: 2,
    });
    const results = [];
    for (let index = 0; index < 3; index += 1)
      results.push(
        await redeem(
          redeemInput([priced(item, 20_000)], { voucherCode: promoCode }),
        ),
      );
    expect(
      results.map((result) => Boolean(discountOf(result, promotionId))),
    ).toEqual([true, true, false]);
    // Without the code it never applies.
    const plain = await redeem(redeemInput([priced(item, 20_000)]));
    expect(discountOf(plain, promotionId)).toBeFalsy();
  });

  it("[LOY-03] the database refuses an over-redemption even without the service lock (CHECK backstop)", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, {
      quotaTotal: 1,
      budgetIdr: 1_000,
    });
    await expect(
      asOwner(tenantId, (client) =>
        client.query(
          "UPDATE promotions SET uses_total = 2 WHERE tenant_id = $1 AND id = $2",
          [tenantId, promotionId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asOwner(tenantId, (client) =>
        client.query(
          "UPDATE promotions SET spent_idr = 1001 WHERE tenant_id = $1 AND id = $2",
          [tenantId, promotionId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("Idempotent redeem and release on void", () => {
  it("a retried redeem returns the stored result and counts once; a different request for the same order is refused", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    const input = redeemInput([priced(item, 70_000)]);
    const first = await redeem(input);
    const retry = await redeem({ ...input, at: new Date(Date.now() + 5_000) });
    expect(retry).toEqual(first);
    expect((await promotionCounters(promotionId)).uses).toBe(1);
    await expect(
      redeem({ ...input, lines: [priced(item, 70_000, 2)] }),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("release on void gives back quota, budget, the customer's use, the voucher and the facility reward, once", async () => {
    const item = randomUUID();
    const facilityProductId = await asOwner(tenantId, (client) =>
      seedPromoFacilityProduct(client, tenantId, outletA),
    );
    const voucherCode = code();
    const sari = await member();
    const percentId = await seedPromotion(item, {
      quotaTotal: 5,
      quotaPerCustomer: 1,
      budgetIdr: 1_000_000,
    });
    const voucherPromotion = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 5_000 },
      voucherRequired: true,
      codeHash: hash(code()),
    });
    const facilityPromotion = await seedPromotion(item, {
      conditions: [{ kind: "min_spend", amountIdr: 100_000 }],
      benefit: {
        kind: "facility_entitlement",
        facilityProductId,
        quantity: 1,
      },
    });
    const voucherId = await seedVoucher({
      code: voucherCode,
      promotionId: voucherPromotion,
    });
    await asOwner(tenantId, (client) =>
      client.query(
        `INSERT INTO promo_settings (tenant_id, stacking_policy)
         VALUES ($1, '{"mode":"stackable","maxStacked":5,"allowSameGroup":true}')
         ON CONFLICT (tenant_id) DO UPDATE SET stacking_policy = EXCLUDED.stacking_policy`,
        [tenantId],
      ),
    );
    try {
      const input = redeemInput([priced(item, 120_000)], {
        customer: sari,
        voucherCode,
        actorUserId: actor,
      });
      const result = await redeem(input);
      expect(discountOf(result, percentId)).toBeTruthy();
      expect(discountOf(result, voucherPromotion)).toBeTruthy();
      expect(discountOf(result, facilityPromotion)).toBeTruthy();
      const before = await promotionCounters(percentId);
      expect(before.uses).toBe(1);

      const rewards = await asOwner(tenantId, (client) =>
        client.query(
          "SELECT id, expires_at, revoked_at FROM facility_rewards WHERE tenant_id = $1 AND promotion_id = $2",
          [tenantId, facilityPromotion],
        ),
      );
      expect(rewards.rows).toHaveLength(1);
      expect(rewards.rows[0].expires_at).not.toBeNull();

      const released = await release(input.orderId);
      expect(released.released).toBe(true);
      expect(released.releasedDiscountIdr).toBe(result.totalDiscountIdr);
      expect(await promotionCounters(percentId)).toEqual({ uses: 0, spent: 0 });
      const state = await asOwner(tenantId, async (client) => ({
        voucher: (
          await client.query(
            "SELECT status, redeemed_order_id FROM vouchers WHERE id = $1",
            [voucherId],
          )
        ).rows[0],
        usage: (
          await client.query(
            "SELECT uses FROM promotion_customer_usage WHERE tenant_id = $1 AND promotion_id = $2 AND customer_profile_id = $3",
            [tenantId, percentId, sari.customerProfileId],
          )
        ).rows[0],
        reward: (
          await client.query(
            "SELECT revoked_at FROM facility_rewards WHERE tenant_id = $1 AND promotion_id = $2",
            [tenantId, facilityPromotion],
          )
        ).rows[0],
        events: (
          await client.query(
            "SELECT event->>'name' AS name FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'aggregateId' = $2 ORDER BY sequence",
            [tenantId, input.orderId],
          )
        ).rows.map((row) => row.name),
        audit: (
          await client.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'promo_application.released' AND event->>'objectId' = $2",
            [tenantId, input.orderId],
          )
        ).rows[0].n,
      }));
      expect(state.voucher).toEqual({
        status: "issued",
        redeemed_order_id: null,
      });
      expect(state.usage.uses).toBe(0);
      expect(state.reward.revoked_at).not.toBeNull();
      expect(state.events).toEqual([
        "promo_application.redeemed",
        "promo_application.released",
      ]);
      expect(state.audit).toBe(1);

      // Idempotent: a second release changes nothing; a replayed redeem of the
      // voided order is refused; the voucher is usable again by a new order.
      expect(await release(input.orderId)).toEqual({
        released: false,
        releasedDiscountIdr: 0,
      });
      expect(await promotionCounters(percentId)).toEqual({ uses: 0, spent: 0 });
      await expect(redeem(input)).rejects.toMatchObject({
        code: "PROMO_APPLICATION_RELEASED",
      });
      const again = await redeem({ ...input, orderId: createUlid() });
      expect(discountOf(again, voucherPromotion)).toBeTruthy();
    } finally {
      await asOwner(tenantId, (client) =>
        client.query("DELETE FROM promo_settings WHERE tenant_id = $1", [
          tenantId,
        ]),
      );
    }
  });

  it("releasing an order that never redeemed anything is a no-op", async () => {
    expect(await release(createUlid())).toEqual({
      released: false,
      releasedDiscountIdr: 0,
    });
  });

  it("a value voucher (no promotion) discounts its value, capped at the bill, and is single-use", async () => {
    const voucherCode = code();
    const voucherId = await seedVoucher({
      code: voucherCode,
      promotionId: null,
      valueIdr: 20_000,
    });
    const item = randomUUID();
    const result = await redeem(
      redeemInput([priced(item, 12_000)], { voucherCode }),
    );
    expect(result.totalDiscountIdr).toBe(12_000);
    const rows = await asOwner(tenantId, (client) =>
      client.query(
        "SELECT promotion_id, voucher_id, discount_idr FROM promotion_redemptions WHERE tenant_id = $1 AND voucher_id = $2",
        [tenantId, voucherId],
      ),
    );
    expect(rows.rows).toEqual([
      { promotion_id: null, voucher_id: voucherId, discount_idr: "12000" },
    ]);
    await expect(
      redeem(redeemInput([priced(item, 12_000)], { voucherCode })),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });
  });

  it("a customer-bound voucher is refused for another customer", async () => {
    const voucherCode = code();
    // legend-m4p5: vouchers.customer_profile_id now references a real profile.
    const holder = await seedProfile(tenantId);
    await seedVoucher({
      code: voucherCode,
      promotionId: null,
      valueIdr: 5_000,
      customerProfileId: holder.id,
    });
    await expect(
      redeem(
        redeemInput([priced(randomUUID(), 50_000)], {
          voucherCode,
          customer: await member(),
        }),
      ),
    ).rejects.toMatchObject({ status: 422, code: "VOUCHER_INVALID" });
  });
});

describe("1269 F0 a shower reward is refused while the shower is off", () => {
  it("a facility reward promotion does not apply and writes no reward; a code for it is refused", async () => {
    const item = randomUUID();
    const facilityProductId = await asOwner(tenantId, (client) =>
      seedPromoFacilityProduct(client, tenantId, outletA),
    );
    const sari = await member();
    const code0 = code();
    const plain = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 1_000 },
    });
    const facilityBenefit = {
      kind: "facility_entitlement",
      facilityProductId,
      quantity: 1,
    };
    const rewardPromotion = await seedPromotion(item, {
      benefit: facilityBenefit,
    });
    const codePromotion = await seedPromotion(item, {
      benefit: facilityBenefit,
      voucherRequired: true,
      codeHash: hash(code0),
    });
    const flag = env as unknown as { FACILITY_SHOWER_ENABLED?: boolean };
    const was = flag.FACILITY_SHOWER_ENABLED;
    flag.FACILITY_SHOWER_ENABLED = false;
    try {
      const rewardsOf = async (promotionId: string) =>
        (
          await asOwner(tenantId, (client) =>
            client.query(
              "SELECT id FROM facility_rewards WHERE tenant_id = $1 AND promotion_id = $2",
              [tenantId, promotionId],
            ),
          )
        ).rows.length;
      const result = await redeem(
        redeemInput([priced(item, 50_000)], { customer: sari }),
      );
      expect(discountOf(result, plain)).toBeTruthy();
      expect(discountOf(result, rewardPromotion)).toBeUndefined();
      expect(await rewardsOf(rewardPromotion)).toBe(0);

      await expect(
        redeem(
          redeemInput([priced(item, 50_000)], {
            customer: sari,
            voucherCode: code0,
          }),
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: "FACILITY_SHOWER_DISABLED",
      });
      expect(await rewardsOf(codePromotion)).toBe(0);

      // A coworking (paid WFC) reward is not closed: it still applies.
      const wfcItem = randomUUID();
      const wfcProduct = await asOwner(tenantId, (client) =>
        seedPromoFacilityProduct(client, tenantId, outletA, "coworking"),
      );
      const wfcPromotion = await seedPromotion(wfcItem, {
        benefit: {
          kind: "facility_entitlement",
          facilityProductId: wfcProduct,
          quantity: 1,
        },
      });
      const wfc = await redeem(
        redeemInput([priced(wfcItem, 50_000)], { customer: sari }),
      );
      expect(discountOf(wfc, wfcPromotion)).toBeTruthy();
      expect(await rewardsOf(wfcPromotion)).toBe(1);

      // With the switch on, the shower reward applies again.
      flag.FACILITY_SHOWER_ENABLED = true;
      const showerItem = randomUUID();
      const onPromotion = await seedPromotion(showerItem, {
        benefit: facilityBenefit,
      });
      const on = await redeem(
        redeemInput([priced(showerItem, 50_000)], { customer: sari }),
      );
      expect(discountOf(on, onPromotion)).toBeTruthy();
      expect(await rewardsOf(onPromotion)).toBe(1);
    } finally {
      flag.FACILITY_SHOWER_ENABLED = was;
    }
  });
});

describe("§3.21 ROI Promo inputs", () => {
  it("[§3.21] ROI counts kept orders only, and a partial refund removes the refunded goods from revenue", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    await redeem(redeemInput([priced(item, 100_000)]));
    const partial = redeemInput([priced(item, 25_000, 2)]);
    await redeem(partial);
    const voided = redeemInput([priced(item, 80_000)]);
    await redeem(voided);
    await release(voided.orderId);
    // Owner Q41: refund one of the two portions; the promotion still applies.
    // Founder rule (9 Nov 2026): the refunded portion gives back its price
    // minus its pro-rata share of the discount (25k - 2.5k), and that share
    // goes back to the promotion (cost 10k + 2.5k). The order port (the one
    // the refund module injects) lowers the redemption line by that share.
    const scoped = outletScope(outletA);
    expect(
      await withTenant(db, scoped, (tx) =>
        orderPromoPartialRefundPort.recomputeAfterPartialRefund(tx, scoped, {
          orderId: partial.orderId,
          keptLines: [priced(item, 25_000)],
          reason: "Refund sebagian: satu porsi batal",
          actorUserId: null,
          at: new Date(),
        }),
      ),
    ).toMatchObject({
      adjusted: true,
      refundedSubtotalIdr: 25_000,
      withdrawnDiscountIdr: 0,
      refundDueIdr: 22_500,
      totalDiscountIdr: 2_500,
    });
    // A Marketing user with promo.manage over the tenant reads the report.
    const marketer = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Promo ROI', $2)`,
      [marketer, `${marketer}@example.test`],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
       WHERE tenant_id = $1 AND template_key = 'owner'`,
      [tenantId, marketer],
    );
    try {
      expect(
        await getPromotionRoi(tenantScope(), marketer, promotionId),
      ).toEqual({
        promotionId,
        transactions: 2,
        discountCostIdr: 12_500,
        revenueIdr: 112_500,
        netMarginIdr: 100_000,
        roiBp: 80_000,
      });
    } finally {
      await owner.query("DELETE FROM role_assignments WHERE user_id = $1", [
        marketer,
      ]);
      await owner.query('DELETE FROM "user" WHERE id = $1', [marketer]);
    }
  });
});

describe("TEN-01..03 isolation", () => {
  it("[TEN-01] another tenant's promotion never reaches this tenant's bill or reads", async () => {
    const context = tenantScope();
    const quote = await withTenant(db, context, (tx) =>
      quotePromotions(tx, context, {
        outletId: outletA,
        channel: "dine_in",
        lines: [priced(randomUUID(), 100_000)],
        customer: null,
        voucherCode: null,
        at: new Date(),
      }),
    );
    expect(
      quote.evaluations.some((entry) => entry.promotionId === otherPromotion),
    ).toBe(false);
    const visible = await withTenant(db, context, (tx) =>
      tx.execute(sql`SELECT id FROM promotions WHERE id = ${otherPromotion}`),
    );
    expect(visible.rows).toHaveLength(0);
  });

  it("[TEN-02] a write naming another tenant is refused by RLS", async () => {
    const context = tenantScope();
    await expect(
      withTenant(db, context, (tx) =>
        tx.execute(sql`
          INSERT INTO vouchers (tenant_id, code_hash, source, value_idr, valid_from)
          VALUES (${otherTenant}, ${hash(code())}, 'manual', 1000, now())`),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
  });

  it("[TEN-03] outlet scope B cannot see or write outlet A's redemptions", async () => {
    const item = randomUUID();
    await seedPromotion(item);
    const input = redeemInput([priced(item, 10_000)]);
    await redeem(input);
    const scopeB = outletScope(outletB);
    const seen = await withTenant(db, scopeB, (tx) =>
      tx.execute(
        sql`SELECT order_id FROM promotion_order_applications WHERE outlet_id = ${outletA}`,
      ),
    );
    expect(seen.rows).toHaveLength(0);
    // Redeeming at outlet A with a context that only reaches outlet B fails closed.
    await expect(
      redeem(redeemInput([priced(item, 10_000)]), scopeB),
    ).rejects.toMatchObject({ status: 404 });
    // And releasing A's order from scope B finds nothing to release.
    expect(await release(input.orderId, scopeB)).toEqual({
      released: false,
      releasedDiscountIdr: 0,
    });
  });
});
