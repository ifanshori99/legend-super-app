// Card 1219 (SO 1216 H-P2, H-P3): a partial refund that withdraws a promotion
// while the guest still keeps part of its discount (`uncoveredIdr > 0`) must
// not hand the voucher, the quota or the customer's usage back, and lowers
// `spent_idr` only by the part of the discount actually taken back. An
// application without a stored `paid_idr` cannot be refunded (admin fix).
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

/** A voucher-only 30k-off promotion that needs `item` on the bill. */
async function seedVoucherPromotion(item: string, voucherCode: string) {
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
        JSON.stringify({ kind: "nominal_off", amountIdr: 30_000 }),
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

const partialRefund = (orderId: string, keptLines: PromoLine[]) => {
  const context = outletScope();
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

describe("1219 partial refund that leaves part of the discount uncovered", () => {
  it("keeps the single-use voucher, the quota and the customer's usage; spent drops only by the discount taken back", async () => {
    const buy = randomUUID();
    const other = randomUUID();
    const voucherCode = code();
    const { promotionId, voucherId } = await seedVoucherPromotion(
      buy,
      voucherCode,
    );
    const customer: PromoCustomer = await asOwner((client) =>
      seedPromoCustomer(client, tenantId, randomUUID()),
    );
    const { orderId, result } = await redeem(
      [priced(buy, 20_000), priced(other, 60_000)],
      { voucherCode, customer },
    );
    expect(result.totalDiscountIdr).toBe(30_000);
    expect(
      await state(promotionId, voucherId, customer.customerProfileId),
    ).toEqual({ uses: 1, spent: 30_000, voucher: "redeemed", customerUses: 1 });

    // Refund the 20k item the promotion needs: paid 50k, kept goods 60k at
    // full price, so 10k of the withdrawn 30k stays with the guest.
    const adjusted = await partialRefund(orderId, [priced(other, 60_000)]);
    expect(adjusted).toMatchObject({
      adjusted: true,
      withdrawnDiscountIdr: 30_000,
      refundDueIdr: 0,
      uncoveredIdr: 10_000,
      withdrawn: [{ promotionId, voucherId }],
      voucherIds: [],
    });
    expect(
      await state(promotionId, voucherId, customer.customerProfileId),
    ).toEqual({ uses: 1, spent: 10_000, voucher: "redeemed", customerUses: 1 });

    // The voucher was not handed back: a second bill cannot use it.
    await expect(
      redeem([priced(buy, 20_000), priced(other, 60_000)], { voucherCode }),
    ).rejects.toMatchObject({ code: "VOUCHER_INVALID" });
  });

  it("refuses a promo refund on an application without a stored paid amount (409)", async () => {
    const buy = randomUUID();
    const other = randomUUID();
    const voucherCode = code();
    await seedVoucherPromotion(buy, voucherCode);
    const { orderId } = await redeem(
      [priced(buy, 20_000), priced(other, 60_000)],
      { voucherCode },
    );
    await asOwner((client) =>
      client.query(
        `UPDATE promotion_order_applications SET paid_idr = NULL
          WHERE tenant_id = $1 AND order_id = $2`,
        [tenantId, ulidToUuid(orderId)],
      ),
    );
    await expect(
      partialRefund(orderId, [priced(other, 60_000)]),
    ).rejects.toMatchObject({ status: 409, code: "PROMO_REFUND_PAID_UNKNOWN" });
    const context = outletScope();
    await expect(
      withTenant(db, context, (tx) =>
        recordPartialRefundPayout(tx, context, {
          orderId,
          payoutIdr: 10_000,
          at: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "PROMO_REFUND_PAID_UNKNOWN" });
  });
});
