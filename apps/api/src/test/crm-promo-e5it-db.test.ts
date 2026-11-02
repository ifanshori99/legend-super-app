// Promo follow-ups against PostgreSQL (bead legend-e5it; PRD v1.7 §3.21,
// §3.25; owner decisions Q40/Q41; TEN-01..03). Runs the real engine ports
// with the restricted app role (RLS enforced):
// - E5IT-1/2: per-outlet promotion switch (promotion_outlets) + RLS;
// - E5IT-4..7: same-day cumulative minimum-spend facility reward (Q40);
// - E5IT-8/9: partial refund withdraws a promotion the bill no longer earns
//   and reduces the refund (Q41); a full void still releases;
// - E5IT-10: composite foreign keys on the new table.
//
// Isolation: files share the seeded tenant, so every promotion here applies
// only to bills holding its own random item, and every Q40 test uses its own
// customer.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateOf,
  createUlid,
  idr,
  outletIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
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
import {
  quotePromotions,
  redeemPromotions,
  releasePromotions,
  type RedeemPromotionsInput,
} from "../services/crm-promo-engine";
import { recomputeAfterPartialRefund } from "../services/crm-promo-refund";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const otherPromotion = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdPromotions: string[] = [];
let zoneA = "Asia/Jakarta";
/** Outlet business-day clock (Q39, default cutoff 04:00). */
const clockA = () => ({ timeZone: zoneA, cutoff: "04:00" });

const base = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

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

/** An active promotion that only applies to bills holding `item`. */
async function seedPromotion(
  item: string,
  seed: {
    benefit?: unknown;
    conditions?: unknown[];
    codeHash?: string | null;
  } = {},
) {
  const id = randomUUID();
  createdPromotions.push(id);
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority)
       VALUES ($1, $2, $3, '', 'active', $4, false, now() - interval '1 hour', NULL, $5, $6, $7, true, 0)`,
      [
        id,
        tenantId,
        `E5IT ${id.slice(0, 8)}`,
        seed.codeHash ?? null,
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
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return id;
}

/** Same-day min-spend facility reward: Rp100.000 on the day, member only. */
const facilityPromotion = (item: string, minSpend = 100_000) =>
  seedPromotion(item, {
    benefit: {
      kind: "facility_entitlement",
      facilityProductId: randomUUID(),
      quantity: 1,
    },
    conditions: [{ kind: "min_spend", amountIdr: minSpend }],
  });

async function counters(id: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query(
      "SELECT uses_total, spent_idr FROM promotions WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    ),
  );
  return { uses: Number(rows[0].uses_total), spent: Number(rows[0].spent_idr) };
}

async function liveRewards(promotionId: string, customerId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query(
      `SELECT id, source_order_id, business_date::text AS business_date FROM facility_rewards
        WHERE tenant_id = $1 AND promotion_id = $2 AND customer_profile_id = $3
          AND revoked_at IS NULL ORDER BY issued_at`,
      [tenantId, promotionId, customerId],
    ),
  );
  return rows as Array<{
    id: string;
    source_order_id: string;
    business_date: string;
  }>;
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

/** Noon (outlet zone) `days` ahead: a fixed point inside one business day. */
function noon(days: number): Date {
  const date = businessDateOf(
    new Date(Date.now() + days * 86_400_000),
    clockA(),
  );
  const probe = new Date(`${date}T12:00:00Z`);
  const offset =
    new Date(probe.toLocaleString("en-US", { timeZone: zoneA })).getTime() -
    new Date(probe.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(probe.getTime() - offset);
}

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
const quote = (
  lines: PromoLine[],
  outletId = outletA,
  customer: PromoCustomer | null = null,
) => {
  const context = outletScope(outletId);
  return withTenant(db, context, (tx) =>
    quotePromotions(tx, context, {
      outletId,
      channel: "dine_in",
      lines,
      customer,
      voucherCode: null,
      at: new Date(),
    }),
  );
};
const applied = (result: PromotionApplicationResult, promotionId: string) =>
  result.evaluations.find(
    (evaluation) =>
      evaluation.promotionId === promotionId && evaluation.applied,
  );
const partialRefund = (
  orderId: string,
  keptLines: PromoLine[],
  context = outletScope(outletA),
) =>
  withTenant(db, context, (tx) =>
    recomputeAfterPartialRefund(tx, context, {
      orderId,
      keptLines,
      reason: "Refund sebagian: menu salah",
      actorUserId: null,
      at: new Date(),
    }),
  );

async function switchOff(promotionId: string, outletId: string) {
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (tenant_id, promotion_id, outlet_id) DO UPDATE SET enabled = false`,
      [tenantId, promotionId, outletId],
    ),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const zone = await owner.query("SELECT timezone FROM outlets WHERE id = $1", [
    outletA,
  ]);
  zoneA = zone.rows[0]?.timezone ?? zoneA;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'E5IT tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `e5it-${otherTenant.slice(0, 8)}`, tenantId],
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
       VALUES ($1, $2, 'Other tenant', '', 'draft', false, now(), '[]',
               '{"kind":"percent_off","percentBp":1000,"maxDiscountIdr":null}', 'x', true, 0)`,
      [otherPromotion, otherTenant],
    );
  });
});

afterAll(async () => {
  await asOwner(tenantId, async (client) => {
    if (createdPromotions.length > 0) {
      await client.query(
        "DELETE FROM promotion_outlets WHERE tenant_id = $1 AND promotion_id = ANY($2)",
        [tenantId, createdPromotions],
      );
      await client.query(
        "UPDATE promotions SET status = 'ended' WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdPromotions],
      );
    }
  });
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM promotion_outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
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

// ------------------------------------------------- per-outlet switch

describe("E5IT per-outlet promotion switch (promotion_outlets)", () => {
  it("[E5IT-1] a promotion switched off at outlet A no longer applies there but still applies at outlet B (no row = all outlets)", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    const lines = [priced(item, 50_000)];
    expect(applied(await quote(lines, outletA), promotionId)).toBeTruthy();
    await switchOff(promotionId, outletA);
    const atA = await quote(lines, outletA);
    expect(atA.evaluations.some((e) => e.promotionId === promotionId)).toBe(
      false,
    );
    expect(atA.totalDiscountIdr).toBe(0);
    expect(applied(await quote(lines, outletB), promotionId)).toBeTruthy();
    // Redeem honours it too: nothing consumed at outlet A.
    const result = await redeem(redeemInput(lines));
    expect(result.totalDiscountIdr).toBe(0);
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
  });

  it("[E5IT-1] a promo code for a promotion switched off at the outlet is refused (VOUCHER_INVALID)", async () => {
    const item = randomUUID();
    const code = `E5${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    const { createHash } = await import("node:crypto");
    const promotionId = await seedPromotion(item, {
      codeHash: createHash("sha256").update(code, "utf8").digest("hex"),
    });
    await switchOff(promotionId, outletA);
    await expect(
      redeem(redeemInput([priced(item, 20_000)], { voucherCode: code })),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });
  });

  it("[E5IT-2] TEN-03: outlet B scope cannot read or write outlet A's switch rows", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    await switchOff(promotionId, outletA);
    const scopeB = outletScope(outletB);
    const seen = await withTenant(db, scopeB, (tx) =>
      tx.execute(
        sql`SELECT outlet_id FROM promotion_outlets WHERE promotion_id = ${promotionId}`,
      ),
    );
    expect(seen.rows).toHaveLength(0);
    await expect(
      withTenant(db, scopeB, (tx) =>
        tx.execute(sql`
          INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
          VALUES (${tenantId}, ${promotionId}, ${outletA}, true)
          ON CONFLICT (tenant_id, promotion_id, outlet_id) DO UPDATE SET enabled = true`),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
  });

  it("[E5IT-2] TEN-02: a switch row naming another tenant is refused by RLS", async () => {
    const context = outletScope(outletA);
    await expect(
      withTenant(db, context, (tx) =>
        tx.execute(sql`
          INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
          VALUES (${otherTenant}, ${otherPromotion}, ${otherOutlet}, false)`),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
  });

  it("[E5IT-10] composite FKs: a switch row cannot pair this tenant with another tenant's promotion or outlet", async () => {
    await expect(
      asOwner(tenantId, (client) =>
        client.query(
          `INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
           VALUES ($1, $2, $3, false)`,
          [tenantId, otherPromotion, outletA],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    await expect(
      asOwner(tenantId, (client) =>
        client.query(
          `INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
           VALUES ($1, $2, $3, false)`,
          [tenantId, promotionId, otherOutlet],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

// ------------------------------------- Q40 same-day cumulative min spend

describe("E5IT same-day cumulative minimum-spend facility reward (owner Q40, PRD §3.25)", () => {
  it("[E5IT-4] two bills of one member that cross the threshold together earn exactly one reward; a third bill earns none", async () => {
    const item = randomUUID();
    const promotionId = await facilityPromotion(item);
    const customer = member();
    const at = noon(2);
    const first = await redeem(
      redeemInput([priced(item, 60_000)], { customer, at }),
    );
    expect(applied(first, promotionId)).toBeUndefined();
    const second = redeem(
      redeemInput([priced(item, 50_000)], {
        customer,
        at: new Date(at.getTime() + 3_600_000),
      }),
    );
    expect(applied(await second, promotionId)).toBeTruthy();
    const third = await redeem(
      redeemInput([priced(item, 150_000)], {
        customer,
        at: new Date(at.getTime() + 7_200_000),
      }),
    );
    expect(applied(third, promotionId)).toBeUndefined();
    const rewards = await liveRewards(promotionId, customer.customerProfileId);
    expect(rewards).toHaveLength(1);
    expect(rewards[0]?.business_date).toBe(businessDateOf(at, clockA()));
  });

  it("[E5IT-5] anonymous bills are not cumulated: an anonymous bill does not count toward a member's day total", async () => {
    const item = randomUUID();
    const promotionId = await facilityPromotion(item);
    const customer = member();
    const at = noon(3);
    await redeem(redeemInput([priced(item, 60_000)], { customer: null, at }));
    await redeem(redeemInput([priced(item, 60_000)], { customer: null, at }));
    const memberBill = await redeem(
      redeemInput([priced(item, 50_000)], { customer, at }),
    );
    expect(applied(memberBill, promotionId)).toBeUndefined();
    expect(
      await liveRewards(promotionId, customer.customerProfileId),
    ).toHaveLength(0);
  });

  it("[E5IT-6] the next business day starts a new total and a new reward", async () => {
    const item = randomUUID();
    const promotionId = await facilityPromotion(item);
    const customer = member();
    const day1 = noon(4);
    const day2 = noon(5);
    await redeem(redeemInput([priced(item, 120_000)], { customer, at: day1 }));
    // 60k on day 2 does not reach 100k even though day 1 spent 120k.
    const small = await redeem(
      redeemInput([priced(item, 60_000)], { customer, at: day2 }),
    );
    expect(applied(small, promotionId)).toBeUndefined();
    const crossing = await redeem(
      redeemInput([priced(item, 40_000)], { customer, at: day2 }),
    );
    expect(applied(crossing, promotionId)).toBeTruthy();
    const rewards = await liveRewards(promotionId, customer.customerProfileId);
    expect(rewards.map((row) => row.business_date).sort()).toEqual(
      [businessDateOf(day1, clockA()), businessDateOf(day2, clockA())].sort(),
    );
  });

  it("[E5IT-7] concurrent bills of the same member issue the day's reward exactly once", async () => {
    const item = randomUUID();
    const promotionId = await facilityPromotion(item);
    const customer = member();
    const at = noon(6);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        redeem(redeemInput([priced(item, 110_000)], { customer, at })),
      ),
    );
    expect(
      results.filter((result) => applied(result, promotionId)),
    ).toHaveLength(1);
    expect(
      await liveRewards(promotionId, customer.customerProfileId),
    ).toHaveLength(1);
  });
});

// ------------------------------------------------ Q41 partial refund

describe("E5IT partial refund withdraws a promotion the bill no longer earns (owner Q41)", () => {
  it("[E5IT-8] a partial refund below the minimum withdraws the promo, reverses its counters and reduces the refund", async () => {
    const item = randomUUID();
    const other = randomUUID();
    const promotionId = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 20_000 },
      conditions: [{ kind: "min_spend", amountIdr: 100_000 }],
    });
    const customer = member();
    const input = redeemInput([priced(item, 80_000), priced(other, 40_000)], {
      customer,
    });
    const result = await redeem(input);
    expect(result.totalDiscountIdr).toBe(20_000);
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 20_000 });

    // Refund the 40k line: 80k left < 100k minimum.
    const adjusted = await partialRefund(input.orderId, [priced(item, 80_000)]);
    expect(adjusted).toMatchObject({
      adjusted: true,
      refundedSubtotalIdr: 40_000,
      withdrawnDiscountIdr: 20_000,
      refundDueIdr: 20_000,
      uncoveredIdr: 0,
      totalDiscountIdr: 0,
      withdrawn: [
        {
          promotionId,
          voucherId: null,
          discountIdr: 20_000,
          reason: "min_spend_not_met",
        },
      ],
    });
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT a.total_discount_idr, a.refunded_subtotal_idr, a.status,
                (SELECT status FROM promotion_redemptions r
                  WHERE r.tenant_id = a.tenant_id AND r.order_id = a.order_id) AS line_status,
                (SELECT uses FROM promotion_customer_usage u
                  WHERE u.tenant_id = a.tenant_id AND u.promotion_id = $3
                    AND u.customer_profile_id = $4) AS customer_uses,
                (SELECT count(*)::int FROM domain_event_outbox o
                  WHERE o.tenant_id = a.tenant_id AND o.event->>'name' = 'promo_application.adjusted'
                    AND o.event->>'aggregateId' = $2) AS events
           FROM promotion_order_applications a
          WHERE a.tenant_id = $1 AND a.order_id = $5`,
        [
          tenantId,
          input.orderId,
          promotionId,
          customer.customerProfileId,
          ulidToUuid(input.orderId),
        ],
      ),
    );
    expect(rows[0]).toMatchObject({
      total_discount_idr: "0",
      refunded_subtotal_idr: "40000",
      status: "applied",
      line_status: "released",
      customer_uses: 0,
      events: 1,
    });

    // Idempotent: the same refund again withdraws and refunds nothing more.
    expect(
      await partialRefund(input.orderId, [priced(item, 80_000)]),
    ).toMatchObject({
      adjusted: true,
      refundedSubtotalIdr: 0,
      withdrawnDiscountIdr: 0,
      withdrawn: [],
    });
  });

  it("[E5IT-9] a partial refund that keeps the bill above the minimum keeps the promo, and a later full void still releases it", async () => {
    const item = randomUUID();
    const other = randomUUID();
    const promotionId = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 10_000 },
      conditions: [{ kind: "min_spend", amountIdr: 50_000 }],
    });
    const input = redeemInput([priced(item, 80_000), priced(other, 40_000)]);
    await redeem(input);
    const adjusted = await partialRefund(input.orderId, [priced(item, 80_000)]);
    expect(adjusted).toMatchObject({
      adjusted: true,
      refundedSubtotalIdr: 40_000,
      withdrawnDiscountIdr: 0,
      refundDueIdr: 40_000,
      totalDiscountIdr: 10_000,
      withdrawn: [],
    });
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 10_000 });
    const context = outletScope(outletA);
    const released = await withTenant(db, context, (tx) =>
      releasePromotions(tx, context, {
        orderId: input.orderId,
        reason: "Void penuh",
        actorUserId: null,
        at: new Date(),
      }),
    );
    expect(released).toEqual({ released: true, releasedDiscountIdr: 10_000 });
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
    // A voided order cannot be partially refunded afterwards.
    await expect(
      partialRefund(input.orderId, [priced(item, 80_000)]),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("[E5IT-9] a partial refund that removes the item a promotion needs withdraws it; a withdrawn discount above the refund is reported as uncovered", async () => {
    const buy = randomUUID();
    const promotionId = await seedPromotion(buy, {
      benefit: { kind: "nominal_off", amountIdr: 30_000 },
    });
    const other = randomUUID();
    const input = redeemInput([priced(buy, 20_000), priced(other, 60_000)]);
    const result = await redeem(input);
    expect(applied(result, promotionId)).toBeTruthy();
    // Refund the 20k item the promotion needs: its item condition fails, and
    // its 30k discount is more than the 20k refunded.
    const adjusted = await partialRefund(input.orderId, [
      priced(other, 60_000),
    ]);
    expect(adjusted).toMatchObject({
      adjusted: true,
      refundedSubtotalIdr: 20_000,
      withdrawnDiscountIdr: 30_000,
      refundDueIdr: 0,
      uncoveredIdr: 10_000,
      withdrawn: [{ promotionId, reason: "item_mismatch" }],
    });
  });

  it("[E5IT-8] a partial refund that drops a member's day total below the minimum revokes the facility reward", async () => {
    const item = randomUUID();
    const other = randomUUID();
    const promotionId = await facilityPromotion(item);
    const customer = member();
    const at = noon(7);
    const input = redeemInput([priced(item, 90_000), priced(other, 30_000)], {
      customer,
      at,
    });
    expect(applied(await redeem(input), promotionId)).toBeTruthy();
    expect(
      await liveRewards(promotionId, customer.customerProfileId),
    ).toHaveLength(1);
    const adjusted = await partialRefund(input.orderId, [priced(item, 90_000)]);
    expect(adjusted).toMatchObject({
      adjusted: true,
      withdrawn: [{ promotionId, reason: "min_spend_not_met" }],
    });
    if (adjusted.adjusted) expect(adjusted.facilityRewardIds).toHaveLength(1);
    expect(
      await liveRewards(promotionId, customer.customerProfileId),
    ).toHaveLength(0);
    // The reduced bill (90k) still counts toward the day: 10k more earns it.
    const more = await redeem(
      redeemInput([priced(item, 10_000)], { customer, at }),
    );
    expect(applied(more, promotionId)).toBeTruthy();
  });

  it("[E5IT-8] outlet B scope cannot adjust outlet A's order; an order without promotions is a no-op", async () => {
    const item = randomUUID();
    await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 5_000 },
      conditions: [{ kind: "min_spend", amountIdr: 30_000 }],
    });
    const input = redeemInput([priced(item, 40_000)]);
    await redeem(input);
    expect(
      await partialRefund(
        input.orderId,
        [priced(item, 10_000)],
        outletScope(outletB),
      ),
    ).toEqual({ adjusted: false });
    expect(await partialRefund(createUlid(), [priced(item, 1_000)])).toEqual({
      adjusted: false,
    });
    // Kept lines worth more than the bill are refused.
    await expect(
      partialRefund(input.orderId, [priced(item, 50_000)]),
    ).rejects.toMatchObject({ status: 422 });
  });
});
