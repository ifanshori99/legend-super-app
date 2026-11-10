// legend-dbrw3: a training sale (pos_orders.is_training) prices a voucher but
// never consumes it, and a real sale still does.
import { createHash, randomUUID } from "node:crypto";
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
import type { PromoLine } from "@starter/shared/crm";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  redeemPromotions,
  type RedeemPromotionsInput,
} from "../services/crm-promo-engine";
import {
  asTenant,
  markTraining,
  owner,
  seedOrder,
} from "./member-loyalty-helpers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);

const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  {
    kind: "outlets",
    outletIds: [outletA],
  },
);

const hash = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");
const newCode = () =>
  `T${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;

/** A single-use value voucher (no promotion row). */
async function seedValueVoucher(code: string, valueIdr: number) {
  const id = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, NULL, NULL, $3, 'manual', $4, now() - interval '1 hour', NULL)`,
      [id, tenantId, hash(code), valueIdr],
    ),
  );
  return id;
}

async function voucherState(id: string) {
  return asTenant(tenantId, async (client) => {
    const { rows } = await client.query<{
      status: string;
      redeemed_order_id: string | null;
    }>(
      "SELECT status, redeemed_order_id FROM vouchers WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    );
    return rows[0]!;
  });
}

async function rowsFor(orderUlid: string) {
  return asTenant(tenantId, async (client) => {
    const apps = await client.query(
      "SELECT 1 FROM promotion_order_applications WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, ulidToUuid(orderUlid)],
    );
    const lines = await client.query(
      "SELECT 1 FROM promotion_redemptions WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, ulidToUuid(orderUlid)],
    );
    return { applications: apps.rowCount, redemptions: lines.rowCount };
  });
}

const line: PromoLine = {
  menuItemId: randomUUID(),
  quantity: 1,
  unitPriceIdr: idr(50_000),
  lineTotalIdr: idr(50_000),
};

function input(orderId: string, voucherCode: string): RedeemPromotionsInput {
  return {
    orderId,
    outletId: outletA,
    channel: "dine_in",
    lines: [line],
    customer: null,
    voucherCode,
    at: new Date(),
    actorUserId: null,
  };
}

const redeem = (i: RedeemPromotionsInput) =>
  withTenant(db, context, (tx) => redeemPromotions(tx, context, i));

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("LOY-03 voucher redeem on a training order (legend-dbrw3)", () => {
  it("LOY-03 a training order prices the voucher but leaves it issued and writes nothing", async () => {
    const code = newCode();
    const voucherId = await seedValueVoucher(code, 20_000);
    const orderUlid = await seedOrder(tenantId, {
      outletId: outletA,
      profileId: null,
      status: "draft",
    });
    await markTraining(tenantId, orderUlid);

    const result = await redeem(input(orderUlid, code));
    expect(result.totalDiscountIdr).toBe(20_000);
    expect(await voucherState(voucherId)).toEqual({
      status: "issued",
      redeemed_order_id: null,
    });
    expect(await rowsFor(orderUlid)).toEqual({
      applications: 0,
      redemptions: 0,
    });

    // The voucher is still good for a real sale.
    const real = createUlid();
    const done = await redeem(input(real, code));
    expect(done.totalDiscountIdr).toBe(20_000);
    expect((await voucherState(voucherId)).status).toBe("redeemed");
  });

  it("LOY-03 a real order still consumes the voucher", async () => {
    const code = newCode();
    const voucherId = await seedValueVoucher(code, 15_000);
    const orderUlid = await seedOrder(tenantId, {
      outletId: outletA,
      profileId: null,
      status: "draft",
    });
    await redeem(input(orderUlid, code));
    expect(await voucherState(voucherId)).toMatchObject({
      status: "redeemed",
      redeemed_order_id: ulidToUuid(orderUlid),
    });
    expect(await rowsFor(orderUlid)).toEqual({
      applications: 1,
      redemptions: 1,
    });
  });
});
