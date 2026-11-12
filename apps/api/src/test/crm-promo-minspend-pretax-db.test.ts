// Promo min_spend before tax and service (bead legend-u5tkd; owner Q53) against
// PostgreSQL, real engine ports with the restricted app role. At an outlet whose
// prices include tax the caller passes `minSpendSubtotalIdr` (the pre-promo bill
// before tax and service); the engine compares `min_spend` and the same-day
// total with it, while the discount and `paidIdr` keep the gross subtotal. A
// partial refund rechecks on the kept share of it. No field = the old rule.
//
// Isolation: every promotion applies only to bills holding its own random item
// and every same-day test uses its own member.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
  type RedeemPromotionsInput,
} from "../services/crm-promo-engine";
import {
  businessDayWindow,
  sameDaySpendIdr,
} from "../services/crm-promo-minspend";
import { recomputeAfterPartialRefund } from "../services/crm-promo-refund";

import {
  seedPromoCustomer,
  seedPromoFacilityProduct,
} from "./crm-promo-test-helpers";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdPromotions: string[] = [];
let zoneA = "Asia/Jakarta";
const clockA = () => ({ timeZone: zoneA, cutoff: "04:00" });

const base = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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
  benefit: unknown,
  conditions: unknown[],
) {
  const id = randomUUID();
  createdPromotions.push(id);
  await asOwner((client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority)
       VALUES ($1, $2, $3, '', 'active', NULL, false, now() - interval '1 hour', NULL, $4, $5, $6, true, 0)`,
      [
        id,
        tenantId,
        `U5TKD ${id.slice(0, 8)}`,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
          ...conditions,
        ]),
        JSON.stringify(benefit),
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return id;
}

const minSpendPromotion = (item: string, minSpend = 100_000) =>
  seedPromotion(item, { kind: "nominal_off", amountIdr: 10_000 }, [
    { kind: "min_spend", amountIdr: minSpend },
  ]);

const facilityPromotion = async (item: string, minSpend = 100_000) =>
  seedPromotion(
    item,
    {
      kind: "facility_entitlement",
      facilityProductId: await asOwner((client) =>
        seedPromoFacilityProduct(client, tenantId, outletA),
      ),
      quantity: 1,
    },
    [{ kind: "min_spend", amountIdr: minSpend }],
  );

const priced = (item: string, unit: number): PromoLine => ({
  menuItemId: item,
  quantity: 1,
  unitPriceIdr: idr(unit),
  lineTotalIdr: idr(unit),
});

const member = (id = randomUUID()): Promise<PromoCustomer> =>
  asOwner((client) => seedPromoCustomer(client, tenantId, id));

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
const quote = (lines: PromoLine[], minSpendSubtotalIdr?: number) => {
  const context = outletScope(outletA);
  return withTenant(db, context, (tx) =>
    quotePromotions(tx, context, {
      outletId: outletA,
      channel: "dine_in",
      lines,
      customer: null,
      voucherCode: null,
      at: new Date(),
      ...(minSpendSubtotalIdr === undefined
        ? {}
        : { minSpendSubtotalIdr: idr(minSpendSubtotalIdr) }),
    }),
  );
};
const applied = (result: PromotionApplicationResult, promotionId: string) =>
  result.evaluations.find(
    (evaluation) =>
      evaluation.promotionId === promotionId && evaluation.applied,
  );
const rejection = (result: PromotionApplicationResult, promotionId: string) =>
  result.evaluations.find(
    (evaluation) =>
      evaluation.promotionId === promotionId && !evaluation.applied,
  );
const partialRefund = (orderId: string, keptLines: PromoLine[]) => {
  const context = outletScope(outletA);
  return withTenant(db, context, (tx) =>
    recomputeAfterPartialRefund(tx, context, {
      orderId,
      keptLines,
      reason: "Refund sebagian: menu salah",
      actorUserId: null,
      at: new Date(),
    }),
  );
};

async function applicationRow(orderId: string) {
  const { rows } = await asOwner((client) =>
    client.query(
      `SELECT subtotal_idr, paid_idr, refunded_subtotal_idr,
              result->>'minSpendSubtotalIdr' AS min_spend_basis
         FROM promotion_order_applications
        WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, ulidToUuid(orderId)],
    ),
  );
  return rows[0] as {
    subtotal_idr: string;
    paid_idr: string;
    refunded_subtotal_idr: string;
    min_spend_basis: string | null;
  };
}

const daySpend = (customer: PromoCustomer, at: Date) => {
  const context = outletScope(outletA);
  return withTenant(db, context, (tx) =>
    sameDaySpendIdr(tx, context, {
      outletId: outletA,
      customerProfileId: customer.customerProfileId,
      window: businessDayWindow(at, clockA()),
    }),
  );
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const zone = await owner.query("SELECT timezone FROM outlets WHERE id = $1", [
    outletA,
  ]);
  zoneA = zone.rows[0]?.timezone ?? zoneA;
});

afterAll(async () => {
  await asOwner(async (client) => {
    if (createdPromotions.length > 0)
      await client.query(
        "UPDATE promotions SET status = 'ended' WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdPromotions],
      );
  });
  await owner.end();
});

describe("U5TKD min_spend before tax and service (owner Q53)", () => {
  it("[U5TKD-1] inclusive: a gross 100k bill whose pre-tax value is below the minimum does not qualify; a pre-tax 100k bill does; no basis keeps the old rule", async () => {
    const item = randomUUID();
    const promotionId = await minSpendPromotion(item, 100_000);
    const lines = [priced(item, 100_000)];

    const below = await quote(lines, 85_000);
    expect(applied(below, promotionId)).toBeUndefined();
    expect(rejection(below, promotionId)).toMatchObject({
      reason: "min_spend_not_met",
    });
    expect(below).not.toHaveProperty("minSpendSubtotalIdr");

    // Pre-tax exactly 100k: qualifies, and the discount is still on the gross.
    const exact = await quote([priced(item, 118_000)], 100_000);
    expect(applied(exact, promotionId)).toMatchObject({ discountIdr: 10_000 });

    // Exclusive / no tax context: gross is the basis, nothing changes.
    expect(applied(await quote(lines), promotionId)).toBeTruthy();
    expect(
      rejection(await quote([priced(item, 99_000)]), promotionId),
    ).toMatchObject({ reason: "min_spend_not_met" });
  });

  it("[U5TKD-2] redeem stores the basis in the application result only; quote, redeem and replay return the same result", async () => {
    const item = randomUUID();
    const promotionId = await minSpendPromotion(item, 100_000);
    const lines = [priced(item, 118_000)];
    const quoted = await quote(lines, 100_000);
    const input = redeemInput(lines, { minSpendSubtotalIdr: idr(100_000) });
    const redeemed = await redeem(input);
    expect(applied(redeemed, promotionId)).toBeTruthy();
    expect(redeemed).toEqual(quoted);
    expect(redeemed).not.toHaveProperty("minSpendSubtotalIdr");
    expect(await redeem(input)).toEqual(redeemed);

    // paidIdr stays gross: 118.000 - 10.000.
    expect(await applicationRow(input.orderId)).toMatchObject({
      subtotal_idr: "118000",
      paid_idr: "108000",
      min_spend_basis: "100000",
    });

    // A replay with another basis is a different request.
    await expect(
      redeem({ ...input, minSpendSubtotalIdr: idr(90_000) }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("[U5TKD-3] a bill without the basis stores none (old rows and exclusive outlets are unchanged)", async () => {
    const item = randomUUID();
    await minSpendPromotion(item, 100_000);
    const input = redeemInput([priced(item, 120_000)]);
    await redeem(input);
    expect((await applicationRow(input.orderId)).min_spend_basis).toBeNull();
  });

  it("[U5TKD-4] same-day total uses the pre-tax basis, proportionally after a refund; a row without the field keeps subtotal - refunded", async () => {
    const item = randomUUID();
    const other = randomUUID();
    const customer = await member();
    const at = noon(3);

    const withBasis = redeemInput(
      [priced(item, 80_000), priced(other, 40_000)],
      {
        customer,
        at,
        minSpendSubtotalIdr: idr(90_000),
      },
    );
    await redeem(withBasis);
    expect(await daySpend(customer, at)).toBe(90_000);

    // Refund the 40k line: kept gross 80k of 120k => floor(90000 x 80000 / 120000).
    await partialRefund(withBasis.orderId, [priced(item, 80_000)]);
    expect(await daySpend(customer, at)).toBe(60_000);

    // A row without the field adds subtotal - refunded (the old formula).
    const legacy = redeemInput([priced(other, 30_001)], { customer, at });
    await redeem(legacy);
    expect(await daySpend(customer, at)).toBe(60_000 + 30_001);
    await partialRefund(legacy.orderId, [priced(other, 10_001)]);
    expect(await daySpend(customer, at)).toBe(60_000 + 10_001);
  });

  it("[U5TKD-5] same-day facility reward: a gross 120k bill with a pre-tax 90k basis does not earn the reward alone; the next 20k bill does", async () => {
    const item = randomUUID();
    const promotionId = await facilityPromotion(item, 100_000);
    const customer = await member();
    const at = noon(4);
    const first = await redeem(
      redeemInput([priced(item, 120_000)], {
        customer,
        at,
        minSpendSubtotalIdr: idr(90_000),
      }),
    );
    expect(applied(first, promotionId)).toBeUndefined();
    // 90k earlier + a 20k pre-tax bill reaches 100k+; on the old gross rule the
    // first bill would already have earned it.
    const second = await redeem(
      redeemInput([priced(item, 20_000)], {
        customer,
        at: new Date(at.getTime() + 3_600_000),
        minSpendSubtotalIdr: idr(18_000),
      }),
    );
    expect(applied(second, promotionId)).toBeTruthy();
  });

  it("[U5TKD-6] refund recheck: the kept share of the pre-tax basis is compared, not the kept gross", async () => {
    const item = randomUUID();
    const other = randomUUID();
    const promotionId = await minSpendPromotion(item, 100_000);
    // Gross 130k, pre-tax 100k: qualifies.
    const input = redeemInput([priced(item, 80_000), priced(other, 50_000)], {
      minSpendSubtotalIdr: idr(100_000),
    });
    expect(applied(await redeem(input), promotionId)).toBeTruthy();

    // Keep gross 100k (refund 30k of `other`): basis floor(100000 x 100000 /
    // 130000) = 76.923 < 100k => withdrawn, although the kept gross is 100k.
    const adjusted = await partialRefund(input.orderId, [
      priced(item, 80_000),
      priced(other, 20_000),
    ]);
    expect(adjusted).toMatchObject({
      adjusted: true,
      refundedSubtotalIdr: 30_000,
      withdrawn: [{ promotionId, reason: "min_spend_not_met" }],
    });
  });

  it("[U5TKD-7] refund recheck without the basis keeps the old rule (kept gross 100k still qualifies)", async () => {
    const item = randomUUID();
    const other = randomUUID();
    const promotionId = await minSpendPromotion(item, 100_000);
    const input = redeemInput([priced(item, 80_000), priced(other, 50_000)]);
    expect(applied(await redeem(input), promotionId)).toBeTruthy();
    const adjusted = await partialRefund(input.orderId, [
      priced(item, 80_000),
      priced(other, 20_000),
    ]);
    expect(adjusted).toMatchObject({ adjusted: true, withdrawn: [] });
  });

  it("[U5TKD-8] a refund keeps the stored basis for the next recheck", async () => {
    const item = randomUUID();
    const other = randomUUID();
    await minSpendPromotion(item, 50_000);
    const input = redeemInput([priced(item, 80_000), priced(other, 40_000)], {
      minSpendSubtotalIdr: idr(100_000),
    });
    await redeem(input);
    await partialRefund(input.orderId, [priced(item, 80_000)]);
    expect((await applicationRow(input.orderId)).min_spend_basis).toBe(
      "100000",
    );
  });
});
