// legend-ba8p: database integrity at the CRM/facility boundary. Valid parents
// are seeded first, so rejection must be a composite FK violation, not RLS or
// a missing promotion/facility prerequisite.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedFacility } from "./facility-entitlement-helpers.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedProfile,
  type World,
} from "./member-loyalty-helpers.ts";

let world: World;
let other: World;
let promotionId: string;
let profileId: string;
let foreignProfileId: string;
let productId: string;
let otherOutletProductId: string;
let foreignProductId: string;

async function product(w: World, outletId: string): Promise<string> {
  const facilityId = await seedFacility(w, outletId);
  const id = randomUUID();
  await asTenant(w.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products
         (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
       VALUES ($1, $2, $3, $4, 'Promo shower', 'single', 10000, 1)`,
      [id, w.tenantId, outletId, facilityId],
    ),
  );
  return id;
}

const usage = (customerProfileId: string) =>
  asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO promotion_customer_usage
         (tenant_id, promotion_id, customer_profile_id, uses)
       VALUES ($1, $2, $3, 1)`,
      [world.tenantId, promotionId, customerProfileId],
    ),
  );

const reward = (customerProfileId: string, facilityProductId: string) =>
  asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_rewards
         (tenant_id, outlet_id, promotion_id, customer_profile_id,
          facility_product_id, quantity, source_order_id)
       VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
      [
        world.tenantId,
        world.outletA,
        promotionId,
        customerProfileId,
        facilityProductId,
        randomUUID(),
      ],
    ),
  );

beforeAll(async () => {
  world = await createWorld();
  other = await createWorld();
  profileId = (await seedProfile(world.tenantId)).id;
  foreignProfileId = (await seedProfile(other.tenantId)).id;
  productId = await product(world, world.outletA);
  otherOutletProductId = await product(world, world.outletB);
  foreignProductId = await product(other, other.outletA);
  promotionId = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, voucher_required, starts_at,
          conditions, benefit, stack_group, stackable, priority)
       VALUES ($1, $2, 'FK promo', '', 'active', false, now(), '[]',
               '{"kind":"nominal_off","amountIdr":1000}', 'fk_test', false, 0)`,
      [promotionId, world.tenantId],
    ),
  );
});

afterAll(async () => {
  await owner.end();
});

describe("legend-ba8p composite customer and facility references", () => {
  it("BA8P-FK-01 usage accepts its own customer, rejects another tenant and an unknown customer", async () => {
    await expect(usage(profileId)).resolves.toMatchObject({ rowCount: 1 });
    for (const invalid of [foreignProfileId, randomUUID()]) {
      await expect(usage(invalid)).rejects.toMatchObject({
        code: "23503",
        constraint: "promotion_customer_usage_profile_fk",
      });
    }
    const result = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT customer_profile_id FROM promotion_customer_usage WHERE tenant_id = $1 AND promotion_id = $2",
        [world.tenantId, promotionId],
      ),
    );
    expect(result.rows).toEqual([{ customer_profile_id: profileId }]);
  });

  it("BA8P-FK-02 a valid reward is issued only to a customer in the promotion tenant", async () => {
    await expect(reward(profileId, productId)).resolves.toMatchObject({
      rowCount: 1,
    });
    for (const invalid of [foreignProfileId, randomUUID()]) {
      await expect(reward(invalid, productId)).rejects.toMatchObject({
        code: "23503",
        constraint: "facility_rewards_profile_fk",
      });
    }
  });

  it("BA8P-FK-03 another outlet or tenant cannot supply a reward product and no extra reward is issued", async () => {
    const before = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM facility_rewards WHERE tenant_id = $1 AND promotion_id = $2",
        [world.tenantId, promotionId],
      ),
    );
    for (const invalid of [
      otherOutletProductId,
      foreignProductId,
      randomUUID(),
    ]) {
      await expect(reward(profileId, invalid)).rejects.toMatchObject({
        code: "23503",
        constraint: "facility_rewards_product_fk",
      });
    }
    const after = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS count FROM facility_rewards WHERE tenant_id = $1 AND promotion_id = $2",
        [world.tenantId, promotionId],
      ),
    );
    expect(after.rows).toEqual(before.rows);
  });
});
