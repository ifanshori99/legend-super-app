// Promo engine wired into order transactions through `orderPromoPort`
// (bead legend-souz; PRD v1.7 §3.21; LOY-03 race-safe redemption; ORD-03
// server pricing and calc order discount -> service -> tax, legend-559).
// Runs the real adapter against PostgreSQL with the restricted app role (RLS
// enforced), like crm-promo-db.test.ts: each `withTenant` call stands in for
// the QR/POS order transaction that inserts/locks the order row and then
// calls the port.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PromoLine } from "@starter/shared/crm";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  BANDUNG_REGION,
  PRIVATE_ROOM_ZONE_ID,
  cafeLegendTaxFixtures,
  calculateTax,
  taxCalculationInputSchema,
} from "@starter/shared/tax";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  ORDER_PROMO_RELEASE_REASONS,
  orderPromoPort,
  promoDiscountForTax,
  toPromoLines,
} from "../services/order-promo";
import type {
  OrderPromoInput,
  OrderPromoQuote,
} from "../services/order-promo-port";
import { orderPromoPartialRefundPort } from "../services/order-promo-refund";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const actor = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdPromotions: string[] = [];

const scopeFor = (tenant: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletA] },
  );
const context = () => scopeFor(tenantId);

/** Owner connection with the tenant settings FORCE RLS requires. */
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

type Seed = {
  benefit?: unknown;
  quotaTotal?: number | null;
  budgetIdr?: number | null;
};

/** An active promotion that applies only to bills holding its own item. */
async function seedPromotion(item: string, seed: Seed = {}) {
  const id = randomUUID();
  createdPromotions.push(id);
  await asOwner((client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, $3, '', 'active', NULL, false, now() - interval '1 hour', NULL, $4, $5, $6,
               true, 0, $7, NULL, $8)`,
      [
        id,
        tenantId,
        `Order promo test ${id.slice(0, 8)}`,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [item], minQuantity: 1 },
        ]),
        JSON.stringify(
          seed.benefit ?? {
            kind: "percent_off",
            percentBp: 1000,
            maxDiscountIdr: null,
          },
        ),
        `g${id.slice(0, 8)}`,
        seed.quotaTotal ?? null,
        seed.budgetIdr ?? null,
      ],
    ),
  );
  return id;
}

async function counters(id: string) {
  const result = await asOwner((client) =>
    client.query(
      "SELECT uses_total, spent_idr FROM promotions WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    ),
  );
  return {
    uses: Number(result.rows[0].uses_total),
    spent: Number(result.rows[0].spent_idr),
  };
}

async function applicationCount(orderId: string) {
  const result = await asOwner((client) =>
    client.query(
      "SELECT count(*)::int AS n FROM promotion_order_applications WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return result.rows[0].n as number;
}

async function redemptionDiscounts(orderId: string) {
  const result = await asOwner((client) =>
    client.query(
      "SELECT discount_idr FROM promotion_redemptions WHERE tenant_id = $1 AND order_id = $2 AND status = 'applied'",
      [tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return result.rows.map((row) => Number(row.discount_idr));
}

const priced = (item: string, unit: number, quantity = 1): PromoLine => ({
  menuItemId: item,
  quantity,
  unitPriceIdr: idr(unit),
  lineTotalIdr: idr(unit * quantity),
});

const orderInput = (lines: PromoLine[]): OrderPromoInput => ({
  outletId: outletA,
  channel: "dine_in",
  lines,
  customer: null,
  voucherCode: null,
  at: new Date(),
});

const quote = (lines: PromoLine[], scoped: ScopedTenantContext = context()) =>
  withTenant(db, scoped, (tx) =>
    orderPromoPort.quote(tx, scoped, orderInput(lines)),
  );

/** One order transaction: the order row is in place, then redeem runs. */
const redeem = (
  orderId: string,
  lines: PromoLine[],
  expected?: OrderPromoQuote,
  scoped: ScopedTenantContext = context(),
) =>
  withTenant(db, scoped, (tx) =>
    orderPromoPort.redeem(tx, scoped, {
      ...orderInput(lines),
      orderId,
      actorUserId: actor,
      ...(expected === undefined ? {} : { expected: expected.result }),
    }),
  );

const release = (
  orderId: string,
  reason: string = ORDER_PROMO_RELEASE_REASONS.paymentFailed,
  scoped: ScopedTenantContext = context(),
) =>
  withTenant(db, scoped, (tx) =>
    orderPromoPort.release(tx, scoped, {
      orderId,
      reason,
      actorUserId: null,
      at: new Date(),
    }),
  );

const errorCode = (reason: unknown) =>
  (reason as { code?: string } | undefined)?.code;

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

describe("legend-souz orderPromoPort redeem / release in the order transaction", () => {
  it("[LOY-03][ORD-03] QR pay-first roundtrip: quote, redeem at checkout with the accepted quote, release on payment failure gives quota and budget back", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, {
      quotaTotal: 5,
      budgetIdr: 1_000_000,
    });
    const lines = [priced(item, 50_000)];
    const accepted = await quote(lines);
    expect(accepted.totalDiscountIdr).toBe(5_000);
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });

    const orderId = createUlid();
    const redeemed = await redeem(orderId, lines, accepted);
    expect(redeemed.totalDiscountIdr).toBe(5_000);
    expect(redeemed.result.totalDiscountIdr).toBe(5_000);
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 5_000 });

    // A retried checkout of the same order counts once.
    expect(await redeem(orderId, lines, accepted)).toEqual(redeemed);
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 5_000 });

    expect(await release(orderId)).toEqual({
      released: true,
      releasedDiscountIdr: 5_000,
    });
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
  });

  it("[LOY-03] release is idempotent: a second release (payment expiry after failure) and a release of an order that never redeemed are no-ops", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    const lines = [priced(item, 80_000)];
    const orderId = createUlid();
    await redeem(orderId, lines);
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 8_000 });

    expect((await release(orderId)).released).toBe(true);
    expect(
      await release(orderId, ORDER_PROMO_RELEASE_REASONS.paymentExpired),
    ).toEqual({ released: false, releasedDiscountIdr: 0 });
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
    expect(await release(createUlid())).toEqual({
      released: false,
      releasedDiscountIdr: 0,
    });
    // A released order cannot be redeemed again: the QR retry needs a new order.
    await expect(redeem(orderId, lines)).rejects.toMatchObject({
      status: 409,
      code: "PROMO_APPLICATION_RELEASED",
    });
  });

  it("[LOY-03][ORD-03] an expected quote that no longer matches (rule edited after the quote) is refused and nothing is consumed", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    const lines = [priced(item, 60_000)];
    const accepted = await quote(lines);
    expect(accepted.totalDiscountIdr).toBe(6_000);
    await asOwner((client) =>
      client.query(
        `UPDATE promotions SET benefit = '{"kind":"percent_off","percentBp":2000,"maxDiscountIdr":null}'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, promotionId],
      ),
    );
    const orderId = createUlid();
    await expect(redeem(orderId, lines, accepted)).rejects.toMatchObject({
      status: 409,
      code: "PROMO_CHANGED",
    });
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
    expect(await applicationCount(orderId)).toBe(0);
    // A fresh quote shows the new price and redeems.
    const requote = await quote(lines);
    expect(requote.totalDiscountIdr).toBe(12_000);
    expect((await redeem(orderId, lines, requote)).totalDiscountIdr).toBe(
      12_000,
    );
  });

  it("[LOY-03] concurrent checkouts of the last quota with the same accepted quote: exactly one redeems, the rest get PROMO_QUOTA_EXHAUSTED", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, { quotaTotal: 1 });
    const lines = [priced(item, 40_000)];
    const accepted = await quote(lines);
    expect(accepted.totalDiscountIdr).toBe(4_000);
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => redeem(createUlid(), lines, accepted)),
    );
    const ok = settled.filter((entry) => entry.status === "fulfilled");
    const refused = settled.filter(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(4);
    for (const entry of refused)
      expect(errorCode(entry.reason)).toBe("PROMO_QUOTA_EXHAUSTED");
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 4_000 });
  });

  it("[LOY-03][TEN-02] another tenant's context cannot quote, redeem or release at this tenant's outlet", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item);
    const lines = [priced(item, 30_000)];
    const orderId = createUlid();
    await redeem(orderId, lines);
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 3_000 });

    const foreign = scopeFor(randomUUID());
    await expect(quote(lines, foreign)).rejects.toMatchObject({ status: 404 });
    await expect(
      redeem(createUlid(), lines, undefined, foreign),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await release(
        orderId,
        ORDER_PROMO_RELEASE_REASONS.paymentFailed,
        foreign,
      ),
    ).toEqual({ released: false, releasedDiscountIdr: 0 });
    // Nothing of tenant A moved.
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 3_000 });
    expect(await redemptionDiscounts(orderId)).toEqual([3_000]);
  });

  it("[ORD-03] lines that are not plain server-priced lines are refused before the engine runs", async () => {
    const item = randomUUID();
    await seedPromotion(item);
    const discounted: PromoLine = {
      menuItemId: item,
      quantity: 2,
      unitPriceIdr: idr(20_000),
      lineTotalIdr: idr(35_000),
    };
    await expect(quote([discounted])).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
    await expect(redeem(createUlid(), [])).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    });
  });
});

describe("legend-souz calc order and variants/modifiers", () => {
  it("[ORD-03] variant + modifier prices reach the promo engine: 10% of (Rp30.000 + Rp5.000) x 2", async () => {
    const item = randomUUID();
    await seedPromotion(item);
    const lines = toPromoLines([
      {
        menuItemId: item,
        quantity: 2,
        unitPriceIdr: idr(30_000),
        modifiersTotalIdr: idr(5_000),
      },
    ]);
    expect(lines).toEqual([priced(item, 35_000, 2)]);
    expect((await quote(lines)).totalDiscountIdr).toBe(7_000);
  });

  it("[ORD-03][LOY-03] the promo total feeds calculateTax orderDiscountIdr: discount -> service charge -> tax (legend-559)", async () => {
    const item = randomUUID();
    await seedPromotion(item);
    const lines = [priced(item, 100_000)];
    const promo = await quote(lines);
    const orderDiscountIdr = promoDiscountForTax(promo);
    expect(orderDiscountIdr).toBe(10_000);

    const tax = calculateTax(
      taxCalculationInputSchema.parse({
        outletId: cafeLegendTaxFixtures.privateRoomBill.outletId,
        businessDate: "2026-11-02",
        channel: "dine_in",
        zoneId: PRIVATE_ROOM_ZONE_ID,
        regionCode: BANDUNG_REGION,
        orderDiscountIdr,
        lines: lines.map((line, index) => ({
          lineId: `L${index + 1}`,
          itemId: line.menuItemId,
          categoryId: null,
          itemClass: "food_beverage",
          grossIdr: line.lineTotalIdr,
          discountIdr: 0,
          components: [],
        })),
      }),
      {
        taxRules: cafeLegendTaxFixtures.taxRules,
        serviceChargeRules: cafeLegendTaxFixtures.serviceChargeRules,
        settings: cafeLegendTaxFixtures.settings,
      },
    );
    // Discount first: net Rp90.000; service 5% of the net; PBJT 10% of
    // net + service (the fixture rule puts service in the tax base).
    expect(tax.grossIdr).toBe(100_000);
    expect(tax.discountIdr).toBe(10_000);
    expect(tax.baseIdr).toBe(90_000);
    expect(tax.serviceChargeIdr).toBe(4_500);
    expect(tax.taxIdr).toBe(9_450);
    expect(tax.totalIdr).toBe(103_950);
  });
});

describe("legend-souz partial refund returns the refunded items' discount share to the budget (owner Q41)", () => {
  it("[LOY-03] the refunded item's pro-rata share of the discount goes back to spent_idr and the ROI cost; a later void releases exactly the rest", async () => {
    const item = randomUUID();
    const promotionId = await seedPromotion(item, {
      benefit: { kind: "nominal_off", amountIdr: 20_000 },
      budgetIdr: 100_000,
    });
    const orderId = createUlid();
    const redeemed = await redeem(orderId, [priced(item, 15_000, 2)]);
    expect(redeemed.totalDiscountIdr).toBe(20_000);
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 20_000 });

    const scoped = context();
    const refund = () =>
      withTenant(db, scoped, (tx) =>
        orderPromoPartialRefundPort.recomputeAfterPartialRefund(tx, scoped, {
          orderId,
          keptLines: [priced(item, 15_000)],
          reason: "Refund sebagian: satu porsi batal",
          actorUserId: actor,
          at: new Date(),
        }),
      );
    // The promotion is still earned (one item kept): the kept item keeps its
    // pro-rata share of the discount (15.000/30.000 of Rp20.000 = Rp10.000)
    // and the refunded item's share goes back to the budget. The guest paid
    // Rp10.000; the kept item now costs Rp5.000, so Rp5.000 is due.
    expect(await refund()).toMatchObject({
      adjusted: true,
      withdrawnDiscountIdr: 0,
      totalDiscountIdr: 10_000,
      keptPayableIdr: 5_000,
      remainingPaidIdr: 10_000,
      refundDueIdr: 5_000,
    });
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 10_000 });
    expect(await redemptionDiscounts(orderId)).toEqual([10_000]);

    // Idempotent: the same refund again changes nothing.
    expect(await refund()).toMatchObject({
      adjusted: true,
      totalDiscountIdr: 10_000,
      refundDueIdr: 0,
    });
    expect(await counters(promotionId)).toEqual({ uses: 1, spent: 10_000 });

    expect(await release(orderId, "Void: pesanan dibatalkan")).toEqual({
      released: true,
      releasedDiscountIdr: 10_000,
    });
    expect(await counters(promotionId)).toEqual({ uses: 0, spent: 0 });
  });
});

// ---- Q19b (brief sub-115 "Q19b"): stack-ordered, per-line kept discount -------------------
// Rule per still-applied redemption row i: o_i = original discount, share_i = o_i x
// kept / subtotal (original basis), r_i = re-check of the kept lines in stack order
// (free items first, then bill-level promos / value vouchers on what is left),
// k_i = min(share_i, o_i, r_i). Each row and its promotion's spent_idr drop by their
// own cut o_i - k_i only. Invariant: sum(applied rows) == total_discount_idr.
//
// Assumptions:
// - Prices: coffee 30k, croissant 25k, juice 30k. BOGO = "buy 2 coffee, 1 croissant
//   free" (free_items, tier 0); the 10% promo is bill-level (tier 1) on what is left.
// - Bills are sized (juice added) so every pro-rata share is a whole rupiah.
// - The brief applies pro rata to every line, value vouchers included: a Rp10.000
//   voucher on a 200k bill with 30k of goods returned drops to 10k x 170/200 = 8.500
//   (the task text said "voucher stays 10k"; the brief wins). It is lowered only by
//   its own share, never by the BOGO's cut.
// - Stacking is a tenant setting (default exclusive); it is switched to "stackable"
//   for these tests and the previous setting is restored.

const sha256 = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");

async function withStacking<T>(run: () => Promise<T>): Promise<T> {
  const previous = await asOwner((client) =>
    client.query(
      "SELECT stacking_policy FROM promo_settings WHERE tenant_id = $1",
      [tenantId],
    ),
  );
  await asOwner((client) =>
    client.query(
      `INSERT INTO promo_settings (tenant_id, stacking_policy)
       VALUES ($1, '{"mode":"stackable","maxStacked":5,"allowSameGroup":false}')
       ON CONFLICT (tenant_id) DO UPDATE SET stacking_policy = EXCLUDED.stacking_policy`,
      [tenantId],
    ),
  );
  try {
    return await run();
  } finally {
    await asOwner((client) =>
      previous.rows[0]
        ? client.query(
            "UPDATE promo_settings SET stacking_policy = $2 WHERE tenant_id = $1",
            [tenantId, JSON.stringify(previous.rows[0].stacking_policy)],
          )
        : client.query("DELETE FROM promo_settings WHERE tenant_id = $1", [
            tenantId,
          ]),
    );
  }
}

async function seedBogo(coffee: string, croissant: string) {
  const id = randomUUID();
  createdPromotions.push(id);
  await asOwner((client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, $3, '', 'active', NULL, false, now() - interval '1 hour', NULL, $4, $5, $6,
               true, 0, NULL, NULL, 1000000)`,
      [
        id,
        tenantId,
        `Q19b BOGO ${id.slice(0, 8)}`,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [coffee], minQuantity: 2 },
        ]),
        JSON.stringify({
          kind: "free_items",
          menuItemIds: [croissant],
          quantityPerMultiple: 1,
        }),
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return id;
}

async function seedValueVoucher(valueIdr: number) {
  const id = randomUUID();
  const code = `V${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;
  await asOwner((client) =>
    client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, NULL, NULL, $3, 'manual', $4, now() - interval '1 hour', NULL)`,
      [id, tenantId, sha256(code), valueIdr],
    ),
  );
  return { voucherId: id, code };
}

async function appliedRows(orderId: string) {
  const result = await asOwner((client) =>
    client.query(
      `SELECT promotion_id, voucher_id, discount_idr FROM promotion_redemptions
        WHERE tenant_id = $1 AND order_id = $2 AND status = 'applied'`,
      [tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return result.rows.map((row) => ({
    promotionId: row.promotion_id as string | null,
    voucherId: row.voucher_id as string | null,
    discount: Number(row.discount_idr),
  }));
}

async function applicationDiscount(orderId: string) {
  const result = await asOwner((client) =>
    client.query(
      "SELECT total_discount_idr FROM promotion_order_applications WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return Number(result.rows[0].total_discount_idr);
}

/** Invariant: the applied redemption rows add up to the application discount. */
async function expectRowsMatchApplication(orderId: string) {
  const sum = (await appliedRows(orderId)).reduce(
    (total, row) => total + row.discount,
    0,
  );
  expect(sum).toBe(await applicationDiscount(orderId));
}

describe("legend-15by Q19b stack-ordered per-line kept discount at the refund port", () => {
  const items = () => ({
    coffee: randomUUID(),
    croissant: randomUUID(),
    juice: randomUUID(),
  });
  const bill = (
    m: ReturnType<typeof items>,
    coffee: number,
    croissant: number,
  ) => [
    priced(m.coffee, 30_000, coffee),
    priced(m.croissant, 25_000, croissant),
    priced(m.juice, 30_000),
  ];

  it("(b) BOGO + 10% stacked (200k: 50k free croissants + 10% of 150k = 15k, paid 135k): returning 2 coffee gives refundDue 30.500 and lowers each row by its own cut", async () => {
    await withStacking(async () => {
      const m = items();
      const bogo = await seedBogo(m.coffee, m.croissant);
      const percent = await seedPromotion(m.coffee, { budgetIdr: 1_000_000 });
      const orderId = createUlid();
      const redeemed = await redeem(orderId, bill(m, 4, 2));
      expect(redeemed.totalDiscountIdr).toBe(65_000);
      expect(await counters(bogo)).toEqual({ uses: 1, spent: 50_000 });
      expect(await counters(percent)).toEqual({ uses: 1, spent: 15_000 });
      await expectRowsMatchApplication(orderId);

      const scoped = context();
      const result = await withTenant(db, scoped, (tx) =>
        orderPromoPartialRefundPort.recomputeAfterPartialRefund(tx, scoped, {
          orderId,
          keptLines: bill(m, 2, 2),
          reason: "Refund sebagian: dua kopi batal",
          actorUserId: actor,
          at: new Date(),
        }),
      );
      // Kept 140k (0.7 of 200k). BOGO: o 50k, share 35k, r 25k -> k 25k.
      // 10%: o 15k, share 10.5k, r = 10% of (140k - 25k) = 11.5k -> k 10.5k.
      expect(result).toMatchObject({
        adjusted: true,
        totalDiscountIdr: 35_500,
        keptPayableIdr: 104_500,
        remainingPaidIdr: 135_000,
        refundDueIdr: 30_500,
      });
      const rows = await appliedRows(orderId);
      expect(rows.find((r) => r.promotionId === bogo)?.discount).toBe(25_000);
      expect(rows.find((r) => r.promotionId === percent)?.discount).toBe(
        10_500,
      );
      // Each promotion's budget drops by its own cut only (25k and 4.5k).
      expect(await counters(bogo)).toEqual({ uses: 1, spent: 25_000 });
      expect(await counters(percent)).toEqual({ uses: 1, spent: 10_500 });
      await expectRowsMatchApplication(orderId);
    });
  });

  it("(c) BOGO + Rp10.000 value voucher (200k: 50k free + 10k, paid 140k): returning 1 coffee lowers the BOGO by its own 25k cut and the voucher only by its own share", async () => {
    await withStacking(async () => {
      const m = items();
      const bogo = await seedBogo(m.coffee, m.croissant);
      const voucher = await seedValueVoucher(10_000);
      const orderId = createUlid();
      const redeemed = await withTenant(db, context(), (tx) =>
        orderPromoPort.redeem(tx, context(), {
          ...orderInput(bill(m, 4, 2)),
          voucherCode: voucher.code,
          orderId,
          actorUserId: actor,
        }),
      );
      expect(redeemed.totalDiscountIdr).toBe(60_000);
      expect(await counters(bogo)).toEqual({ uses: 1, spent: 50_000 });
      expect(
        (await appliedRows(orderId)).find(
          (r) => r.voucherId === voucher.voucherId,
        ),
      ).toMatchObject({ promotionId: null, discount: 10_000 });
      await expectRowsMatchApplication(orderId);

      const scoped = context();
      const result = await withTenant(db, scoped, (tx) =>
        orderPromoPartialRefundPort.recomputeAfterPartialRefund(tx, scoped, {
          orderId,
          keptLines: bill(m, 3, 2),
          reason: "Refund sebagian: satu kopi batal",
          actorUserId: actor,
          at: new Date(),
        }),
      );
      // Kept 170k (0.85 of 200k). BOGO: o 50k, share 42.5k, r 25k -> k 25k.
      // Voucher: o 10k, share 8.5k, r = min(10k, 170k - 25k) = 10k -> k 8.5k.
      expect(result).toMatchObject({
        adjusted: true,
        totalDiscountIdr: 33_500,
        keptPayableIdr: 136_500,
        remainingPaidIdr: 140_000,
        refundDueIdr: 3_500,
      });
      const rows = await appliedRows(orderId);
      expect(rows.find((r) => r.promotionId === bogo)?.discount).toBe(25_000);
      expect(rows.find((r) => r.voucherId === voucher.voucherId)).toMatchObject(
        {
          promotionId: null,
          discount: 8_500,
        },
      );
      // BOGO budget drops by its own cut only; the voucher has no promotion budget.
      expect(await counters(bogo)).toEqual({ uses: 1, spent: 25_000 });
      await expectRowsMatchApplication(orderId);
    });
  });

  it("(d) bundle + free item stacked (200k: 3 coffee + 1 tea, bundle coffee+tea 40k = 60k off, then 1 free coffee = 50k, paid 90k): returning 2 coffee leaves the free coffee no room, its row keeps 0", async () => {
    // Assumption: bundle_price lists DISTINCT items (menuItemIds, one unit of each), so
    // "2 coffee for 40k" is modelled as coffee + tea for 40k (unit prices 50k + 50k).
    // The free coffee is earned by one tea (free_items, 1 per tea). Both are tier 0;
    // the bundle has the higher priority, so it is applied first.
    await withStacking(async () => {
      const coffee = randomUUID();
      const tea = randomUUID();
      const seedStacked = async (
        conditions: unknown[],
        benefit: unknown,
        priority: number,
      ) => {
        const id = randomUUID();
        createdPromotions.push(id);
        await asOwner((client) =>
          client.query(
            `INSERT INTO promotions
               (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
                conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
                budget_idr)
             VALUES ($1, $2, $3, '', 'active', NULL, false, now() - interval '1 hour', NULL, $4, $5, $6,
                     true, $7, NULL, NULL, 1000000)`,
            [
              id,
              tenantId,
              `Q19b stacked ${id.slice(0, 8)}`,
              JSON.stringify(conditions),
              JSON.stringify(benefit),
              `g${id.slice(0, 8)}`,
              priority,
            ],
          ),
        );
        return id;
      };
      const bundle = await seedStacked(
        [{ kind: "bundle", menuItemIds: [coffee, tea] }],
        {
          kind: "bundle_price",
          menuItemIds: [coffee, tea],
          bundlePriceIdr: 40_000,
        },
        10,
      );
      const free = await seedStacked(
        [{ kind: "item_quantity", menuItemIds: [tea], minQuantity: 1 }],
        { kind: "free_items", menuItemIds: [coffee], quantityPerMultiple: 1 },
        0,
      );
      const lines = (coffees: number) => [
        priced(coffee, 50_000, coffees),
        priced(tea, 50_000),
      ];
      const orderId = createUlid();
      const redeemed = await redeem(orderId, lines(3));
      expect(redeemed.totalDiscountIdr).toBe(110_000);
      expect(await counters(bundle)).toEqual({ uses: 1, spent: 60_000 });
      expect(await counters(free)).toEqual({ uses: 1, spent: 50_000 });
      await expectRowsMatchApplication(orderId);

      const scoped = context();
      const result = await withTenant(db, scoped, (tx) =>
        orderPromoPartialRefundPort.recomputeAfterPartialRefund(tx, scoped, {
          orderId,
          keptLines: lines(1),
          reason: "Refund sebagian: dua kopi batal",
          actorUserId: actor,
          at: new Date(),
        }),
      );
      // Kept 100k (0.5 of 200k). Bundle: o 60k, share 30k, r 60k -> k 30k.
      // Free coffee: o 50k, share 25k; only 100k - 60k = 40k is left and one coffee
      // is 50k, so r 0 -> k 0.
      expect(result).toMatchObject({
        adjusted: true,
        totalDiscountIdr: 30_000,
        keptPayableIdr: 70_000,
        remainingPaidIdr: 90_000,
        refundDueIdr: 20_000,
      });
      const rows = await appliedRows(orderId);
      expect(rows.find((r) => r.promotionId === bundle)?.discount).toBe(30_000);
      expect(rows.find((r) => r.promotionId === free)?.discount ?? 0).toBe(0);
      expect(await counters(bundle)).toEqual({ uses: 1, spent: 30_000 });
      expect(await counters(free)).toMatchObject({ spent: 0 });
      await expectRowsMatchApplication(orderId);
    });
  });
});
