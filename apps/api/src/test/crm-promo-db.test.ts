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

const member = (id = randomUUID()): PromoCustomer => ({
  customerProfileId: id,
  tierId: null,
  isMember: true,
});

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
    const sari = member();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        redeem(redeemInput([priced(item, 30_000)], { customer: sari })),
      ),
    );
    expect(
      results.filter((result) => discountOf(result, promotionId)),
    ).toHaveLength(1);
    const other = await redeem(
      redeemInput([priced(item, 30_000)], { customer: member() }),
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
    const facilityProductId = randomUUID();
    const voucherCode = code();
    const sari = member();
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
    await seedVoucher({
      code: voucherCode,
      promotionId: null,
      valueIdr: 5_000,
      customerProfileId: randomUUID(),
    });
    await expect(
      redeem(
        redeemInput([priced(randomUUID(), 50_000)], {
          voucherCode,
          customer: member(),
        }),
      ),
    ).rejects.toMatchObject({ status: 422, code: "VOUCHER_INVALID" });
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
