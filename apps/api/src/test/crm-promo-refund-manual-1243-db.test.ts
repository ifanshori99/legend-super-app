// Card 1243 (legend-xhl5j, 1219 P3): a manual discount stacked on a promo
// counts when a refund decides whether the guest still keeps a discount
// (`uncoveredIdr`). `paid_idr` carries only the promo, so without the manual
// part a voucher came back although the guest kept 2.5k of discount.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PromoCustomer, PromoLine } from "@starter/shared/crm";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  redeemPromotions,
  type RedeemPromotionsInput,
} from "../services/crm-promo-engine";
import {
  recomputeAfterPartialRefund,
  recordPartialRefundPayout,
} from "../services/crm-promo-refund";
import { seedPromoCustomer } from "./crm-promo-test-helpers";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdPromotions: string[] = [];

const outletScope = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletA] },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>) {
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

const hash = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");
const code = () =>
  `T${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;

/** A voucher-only nominal-off promotion that needs `item` on the bill. */
async function seedVoucherPromotion(
  item: string,
  voucherCode: string,
  amountIdr = 30_000,
) {
  const promotionId = randomUUID();
  createdPromotions.push(promotionId);
  const voucherId = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at,
          conditions, benefit, stack_group, stackable, priority)
       VALUES ($1, $2, $3, '', 'active', $4, true, now() - interval '1 hour', $5, $6, $7, true, 0)`,
      [
        promotionId,
        tenantId,
        `1219 ${promotionId.slice(0, 8)}`,
        hash(code()),
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
        ]),
        JSON.stringify({ kind: "nominal_off", amountIdr }),
        `g${promotionId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, $3, NULL, $4, 'manual', NULL, now() - interval '1 hour', NULL)`,
      [voucherId, tenantId, promotionId, hash(voucherCode)],
    );
  });
  return { promotionId, voucherId };
}

const priced = (item: string, unit: number): PromoLine => ({
  menuItemId: item,
  quantity: 1,
  unitPriceIdr: idr(unit),
  lineTotalIdr: idr(unit),
});

const redeem = (
  lines: PromoLine[],
  overrides: Partial<RedeemPromotionsInput> = {},
) => {
  const context = outletScope();
  const input: RedeemPromotionsInput = {
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
  return withTenant(db, context, async (tx) => ({
    orderId: input.orderId,
    result: await redeemPromotions(tx, context, input),
  }));
};

const partialRefund = (
  orderId: string,
  keptLines: PromoLine[],
  manualDiscountIdr?: number,
) => {
  const context = outletScope();
  return withTenant(db, context, (tx) =>
    recomputeAfterPartialRefund(tx, context, {
      orderId,
      keptLines,
      reason: "Refund sebagian: menu salah",
      actorUserId: null,
      at: new Date(),
      ...(manualDiscountIdr === undefined ? {} : { manualDiscountIdr }),
    }),
  );
};

async function state(promotionId: string, voucherId: string, customer: string) {
  const { rows } = await asOwner((client) =>
    client.query(
      `SELECT p.uses_total, p.spent_idr, v.status AS voucher_status,
              (SELECT uses FROM promotion_customer_usage u
                WHERE u.tenant_id = p.tenant_id AND u.promotion_id = p.id
                  AND u.customer_profile_id = $3) AS customer_uses
         FROM promotions p, vouchers v
        WHERE p.tenant_id = $1 AND p.id = $2 AND v.id = $4`,
      [tenantId, promotionId, customer, voucherId],
    ),
  );
  return {
    uses: Number(rows[0].uses_total),
    spent: Number(rows[0].spent_idr),
    voucher: rows[0].voucher_status as string,
    customerUses: Number(rows[0].customer_uses),
  };
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (createdPromotions.length > 0)
    await asOwner((client) =>
      client.query(
        "UPDATE promotions SET status = 'ended' WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdPromotions],
      ),
    );
  await owner.end();
});

/** A 25k, B 75k, 20k voucher promo needing A, 30k manual discount: paid 50k. */
async function stackedSale() {
  const itemA = randomUUID();
  const itemB = randomUUID();
  const voucherCode = code();
  const { promotionId, voucherId } = await seedVoucherPromotion(
    itemA,
    voucherCode,
    20_000,
  );
  const customer: PromoCustomer = await asOwner((client) =>
    seedPromoCustomer(client, tenantId, randomUUID()),
  );
  const { orderId, result } = await redeem(
    [priced(itemA, 25_000), priced(itemB, 75_000)],
    { voucherCode, customer },
  );
  expect(result.totalDiscountIdr).toBe(20_000);
  return {
    itemA,
    itemB,
    orderId,
    promotionId,
    voucherId,
    customer,
    voucherCode,
  };
}

describe("1243 refund of a promo sale that also carries a manual discount", () => {
  it("partial refund: keeps the voucher while the guest keeps part of the discount", async () => {
    const sale = await stackedSale();
    // Refund A (25k): the promo is withdrawn. B (75k) carries 22.5k of the
    // 30k manual discount, so it costs 52.5k but the guest paid 50k.
    const adjusted = await partialRefund(
      sale.orderId,
      [priced(sale.itemB, 75_000)],
      30_000,
    );
    expect(adjusted).toMatchObject({
      adjusted: true,
      withdrawnDiscountIdr: 20_000,
      uncoveredIdr: 2_500,
      voucherIds: [],
    });
    expect(
      await state(
        sale.promotionId,
        sale.voucherId,
        sale.customer.customerProfileId,
      ),
    ).toEqual({ uses: 1, spent: 17_500, voucher: "redeemed", customerUses: 1 });
    await expect(
      redeem([priced(sale.itemA, 25_000), priced(sale.itemB, 75_000)], {
        voucherCode: sale.voucherCode,
      }),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });
  });

  it("without the manual discount in the input the old reading holds (voucher returns)", async () => {
    const sale = await stackedSale();
    const adjusted = await partialRefund(sale.orderId, [
      priced(sale.itemB, 75_000),
    ]);
    expect(adjusted).toMatchObject({ adjusted: true, uncoveredIdr: 0 });
    expect(
      await state(
        sale.promotionId,
        sale.voucherId,
        sale.customer.customerProfileId,
      ),
    ).toMatchObject({ uses: 0, voucher: "issued" });
  });

  it("a small manual discount leaves nothing uncovered: the voucher returns", async () => {
    const sale = await stackedSale();
    // 5k manual: B carries 3.75k of it; B costs 71.25k, the guest paid 75k.
    const adjusted = await partialRefund(
      sale.orderId,
      [priced(sale.itemB, 75_000)],
      5_000,
    );
    expect(adjusted).toMatchObject({ adjusted: true, uncoveredIdr: 0 });
    expect(
      await state(
        sale.promotionId,
        sale.voucherId,
        sale.customer.customerProfileId,
      ),
    ).toMatchObject({ uses: 0, spent: 0, voucher: "issued" });
  });

  it("full return: nothing is kept, so the voucher returns even with a manual discount", async () => {
    const sale = await stackedSale();
    const adjusted = await partialRefund(sale.orderId, [], 30_000);
    expect(adjusted).toMatchObject({ adjusted: true, uncoveredIdr: 0 });
    expect(
      await state(
        sale.promotionId,
        sale.voucherId,
        sale.customer.customerProfileId,
      ),
    ).toMatchObject({ uses: 0, spent: 0, voucher: "issued" });
  });

  it("refuses a negative or fractional manual discount (422)", async () => {
    const sale = await stackedSale();
    await expect(
      partialRefund(sale.orderId, [priced(sale.itemB, 75_000)], -1),
    ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
  });
});
