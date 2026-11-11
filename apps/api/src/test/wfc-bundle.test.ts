// legend-bz9h (F25/F39): WFC bundles ("Pagi Produktif") against PostgreSQL with
// the restricted app role (RLS enforced). Money rules under test:
// M1 price comes from the database, M2 refund <= paid and idempotent, M3 bundle
// price is a discount only and the allocation adds up to the rupiah, M4
// entitlements only after paid, revoked on refund, issue idempotent.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  createWfcBundle,
  listWfcBundles,
  purchaseWfcBundle,
  refundWfcBundle,
} from "../services/wfc-bundle.service.ts";
import {
  asTenant,
  createWorld,
  owner,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  entitlementsOf,
  ledgerRows,
  NOW,
  outletContext,
  rejectionCode,
  seedFacility,
} from "./facility-entitlement-helpers.ts";
import { agent, setRole, signUp } from "./helpers.ts";

const app = createApp();

afterAll(async () => {
  await owner.end();
});

/** A real account holding a custom tenant-scope role with exactly `permissions`. */
async function staffWith(world: World, permissions: string[]): Promise<string> {
  const client = agent(app);
  const email = await signUp(client, "Staf Paket WFC");
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [
      roleId,
      world.tenantId,
      `Peran ${roleId.slice(0, 6)}`,
      JSON.stringify(permissions),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [world.tenantId, userId, roleId],
  );
  return userId;
}

const manager = (world: World) =>
  staffWith(world, ["facility.config.manage", "facility.booth.operate"]);

async function seedProduct(
  world: World,
  facilityId: string,
  priceIdr: number,
  sessions = 1,
): Promise<string> {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active)
       VALUES ($1, $2, $3, $4, $5, 'single', $6, $7, true)`,
      [
        id,
        world.tenantId,
        world.outletA,
        facilityId,
        `Produk ${id.slice(0, 6)}`,
        priceIdr,
        sessions,
      ],
    ),
  );
  return id;
}

async function seedPlan(
  world: World,
  facilityId: string,
  priceIdr: number,
  quota: number,
): Promise<string> {
  const id = randomUUID();
  await asTenant(world.tenantId, (client) =>
    client.query(
      `INSERT INTO facility_subscription_plans (id, tenant_id, outlet_id, facility_id, name, price_idr, quota_per_period, interval, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'month', true)`,
      [
        id,
        world.tenantId,
        world.outletA,
        facilityId,
        `Langganan ${id.slice(0, 6)}`,
        priceIdr,
        quota,
      ],
    ),
  );
  return id;
}

type Seeded = {
  world: World;
  actor: string;
  showerFacility: string;
  wfcFacility: string;
  showerProduct: string;
  dayPassProduct: string;
};

/** "Pagi Produktif" parts: a shower single (15.000) and a WFC day pass (50.000). */
async function seed(): Promise<Seeded> {
  const world = await createWorld();
  const actor = await manager(world);
  const showerFacility = await seedFacility(world);
  const wfcFacility = await seedFacility(world);
  const showerProduct = await seedProduct(world, showerFacility, 15_000);
  const dayPassProduct = await seedProduct(world, wfcFacility, 50_000);
  return {
    world,
    actor,
    showerFacility,
    wfcFacility,
    showerProduct,
    dayPassProduct,
  };
}

const key = () => `wfc-bundle-${randomUUID()}`;

function pagiProduktif(s: Seeded, priceIdr = 55_000) {
  return {
    name: "Pagi Produktif",
    priceIdr: priceIdr as never,
    items: [
      { facilityId: s.showerFacility, productId: s.showerProduct, quantity: 1 },
      { facilityId: s.wfcFacility, productId: s.dayPassProduct, quantity: 1 },
    ],
    idempotencyKey: key(),
  };
}

const createBundle = (s: Seeded, priceIdr = 55_000) =>
  createWfcBundle(s.world.context, s.actor, pagiProduktif(s, priceIdr), NOW);

const purchase = (
  s: Seeded,
  bundleId: string,
  customerProfileId: string,
  paidIdr: number,
  paymentRef = `pay-${randomUUID()}`,
) =>
  purchaseWfcBundle(
    s.world.context,
    s.actor,
    { bundleId, customerProfileId, paidIdr: paidIdr as never, paymentRef },
    NOW,
  );

describe("[legend-bz9h] WFC bundles", () => {
  it("[M3] creates Pagi Produktif as a discount of the component list prices", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    expect(bundle.name).toBe("Pagi Produktif");
    expect(bundle.priceIdr).toBe(55_000);
    expect(bundle.status).toBe("active");
    expect(bundle.items).toHaveLength(2);
    // Exactly the list total (no discount) is still allowed.
    expect((await createBundle(s, 65_000)).priceIdr).toBe(65_000);
    const listed = await listWfcBundles(s.world.context, s.actor, {
      outletId: s.world.outletA,
    });
    expect(listed.map((row) => row.id)).toContain(bundle.id);
  });

  it("[M3] rejects a price above the list total or not above zero", async () => {
    const s = await seed();
    expect(await rejectionCode(createBundle(s, 65_001))).toBe(
      "BUNDLE_PRICE_INVALID",
    );
    // Not above zero is refused by the strict schema before the service runs.
    await expect(createBundle(s, 0)).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(createBundle(s, -1)).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(
      await listWfcBundles(s.world.context, s.actor, {
        outletId: s.world.outletA,
      }),
    ).toHaveLength(0);
  });

  it("create replays by idempotency key and rejects the key with another payload", async () => {
    const s = await seed();
    const input = pagiProduktif(s);
    const first = await createWfcBundle(s.world.context, s.actor, input, NOW);
    const again = await createWfcBundle(s.world.context, s.actor, input, NOW);
    expect(again.id).toBe(first.id);
    expect(
      await rejectionCode(
        createWfcBundle(
          s.world.context,
          s.actor,
          { ...input, priceIdr: 50_000 as never },
          NOW,
        ),
      ),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("[M1] rejects a payment that differs from the stored price and issues nothing", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = randomUUID();
    for (const paid of [54_999, 55_001, 1])
      expect(await rejectionCode(purchase(s, bundle.id, customer, paid))).toBe(
        "PAID_AMOUNT_MISMATCH",
      );
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    const { rows } = await asTenant(s.world.tenantId, (client) =>
      client.query("SELECT 1 FROM wfc_bundle_purchases WHERE tenant_id = $1", [
        s.world.tenantId,
      ]),
    );
    expect(rows).toHaveLength(0);
  });

  it("[M3][M4] a purchase allocates the exact price and issues one package grant per item", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = randomUUID();
    const bought = await purchase(s, bundle.id, customer, 55_000);
    expect(bought.status).toBe("paid");
    expect(bought.pricePaidIdr).toBe(55_000);
    expect(bought.allocations).toHaveLength(2);
    expect(
      bought.allocations.reduce((sum, row) => sum + row.allocatedIdr, 0),
    ).toBe(55_000);

    const grants = (
      await ledgerRows(s.world.tenantId, { customerProfileId: customer })
    ).filter((row) => row.type === "grant");
    expect(grants).toHaveLength(2);
    expect(grants.every((row) => row.source_type === "package")).toBe(true);
    expect(grants.map((row) => row.source_ref).sort()).toEqual(
      bought.allocations.map((row) => row.id).sort(),
    );
    expect(grants.map((row) => row.facility_id).sort()).toEqual(
      [s.showerFacility, s.wfcFacility].sort(),
    );
    expect(grants.every((row) => row.sessions === 1)).toBe(true);
  });

  it("[M3] allocation is pro-rata with largest remainder, no rupiah lost or created", async () => {
    const s = await seed();
    const odd = await seedProduct(s.world, s.showerFacility, 5_001);
    const even = await seedProduct(s.world, s.wfcFacility, 5_000);
    const bundle = await createWfcBundle(
      s.world.context,
      s.actor,
      {
        name: "Odd",
        priceIdr: 9_999 as never,
        items: [
          { facilityId: s.showerFacility, productId: odd, quantity: 1 },
          { facilityId: s.wfcFacility, productId: even, quantity: 1 },
        ],
        idempotencyKey: key(),
      },
      NOW,
    );
    const bought = await purchase(s, bundle.id, randomUUID(), 9_999);
    expect(
      bought.allocations.reduce((sum, row) => sum + row.allocatedIdr, 0),
    ).toBe(9_999);
    // 9.999 x 5.001 / 10.001 = 4.999,99.. and 9.999 x 5.000 / 10.001 = 4.999,0..
    expect(bought.allocations.map((row) => row.allocatedIdr).sort()).toEqual([
      4_999, 5_000,
    ]);
  });

  it("[M4] a plan item grants the plan quota; quantity multiplies the sessions", async () => {
    const s = await seed();
    const plan = await seedPlan(s.world, s.wfcFacility, 200_000, 10);
    const bundle = await createWfcBundle(
      s.world.context,
      s.actor,
      {
        name: "Langganan + mandi",
        priceIdr: 220_000 as never,
        items: [
          { facilityId: s.wfcFacility, planId: plan, quantity: 1 },
          {
            facilityId: s.showerFacility,
            productId: s.showerProduct,
            quantity: 2,
          },
        ],
        idempotencyKey: key(),
      },
      NOW,
    );
    const customer = randomUUID();
    await purchase(s, bundle.id, customer, 220_000);
    const grants = (
      await ledgerRows(s.world.tenantId, { customerProfileId: customer })
    ).filter((row) => row.type === "grant");
    expect(grants.map((row) => row.sessions).sort((a, b) => a - b)).toEqual([
      2, 10,
    ]);
  });

  it("[M4] replaying the payment ref returns the same purchase and issues nothing again", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = randomUUID();
    const first = await purchase(s, bundle.id, customer, 55_000, "pay-fixed-1");
    const again = await purchase(s, bundle.id, customer, 55_000, "pay-fixed-1");
    expect(again.id).toBe(first.id);
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(2);
    expect(
      await rejectionCode(
        purchase(s, bundle.id, randomUUID(), 55_000, "pay-fixed-1"),
      ),
    ).toBe("PAYMENT_REF_REUSED");
  });

  it("[M2][M4] a refund pays at most what was paid, revokes the grants and a second refund is a no-op", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = randomUUID();
    const bought = await purchase(s, bundle.id, customer, 55_000);

    expect(
      await rejectionCode(
        refundWfcBundle(
          s.world.context,
          s.actor,
          { purchaseId: bought.id, refundIdr: 55_001 as never },
          NOW,
        ),
      ),
    ).toBe("REFUND_EXCEEDS_REFUNDABLE");

    const refunded = await refundWfcBundle(
      s.world.context,
      s.actor,
      { purchaseId: bought.id, refundIdr: 55_000 as never },
      NOW,
    );
    expect(refunded.status).toBe("refunded");
    expect(refunded.refundedIdr).toBe(55_000);
    const afterFirst = await ledgerRows(s.world.tenantId, {
      customerProfileId: customer,
    });
    expect(afterFirst.filter((row) => row.type === "cancel")).toHaveLength(2);

    const second = await refundWfcBundle(
      s.world.context,
      s.actor,
      { purchaseId: bought.id, refundIdr: 55_000 as never },
      NOW,
    );
    expect(second.refundedIdr).toBe(55_000);
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(afterFirst.length);
    const stored = await asTenant(s.world.tenantId, (client) =>
      client.query(
        "SELECT refunded_idr FROM wfc_bundle_purchases WHERE tenant_id = $1 AND id = $2",
        [s.world.tenantId, bought.id],
      ),
    );
    expect(Number(stored.rows[0].refunded_idr)).toBe(55_000);
  });

  it("[M2] redeemed value is not refunded and only unredeemed entitlements are revoked", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = randomUUID();
    const bought = await purchase(s, bundle.id, customer, 55_000);
    const showerItem = bundle.items.find(
      (item) => item.facilityId === s.showerFacility,
    )!;
    const showerAllocation = bought.allocations.find(
      (row) => row.itemId === showerItem.id,
    )!;

    await entitlementsOf(s.world).redeem({
      facilityId: s.showerFacility,
      customerProfileId: customer,
    });

    const refundable = 55_000 - showerAllocation.allocatedIdr;
    expect(
      await rejectionCode(
        refundWfcBundle(
          s.world.context,
          s.actor,
          { purchaseId: bought.id, refundIdr: (refundable + 1) as never },
          NOW,
        ),
      ),
    ).toBe("REFUND_EXCEEDS_REFUNDABLE");

    const refunded = await refundWfcBundle(
      s.world.context,
      s.actor,
      { purchaseId: bought.id, refundIdr: refundable as never },
      NOW,
    );
    expect(refunded.refundedIdr).toBe(refundable);

    const rows = await ledgerRows(s.world.tenantId, {
      customerProfileId: customer,
    });
    const cancels = rows.filter((row) => row.type === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.facility_id).toBe(s.wfcFacility);
    expect(rows.filter((row) => row.type === "redeem")).toHaveLength(1);
  });

  it("[M2] a refund cannot be zero or negative", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const bought = await purchase(s, bundle.id, randomUUID(), 55_000);
    for (const refundIdr of [0, -5])
      await expect(
        refundWfcBundle(
          s.world.context,
          s.actor,
          { purchaseId: bought.id, refundIdr: refundIdr as never },
          NOW,
        ),
      ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("[M3] createWfcBundle rejects a negative price and an extra key at the service boundary", async () => {
    const s = await seed();
    await expect(
      createWfcBundle(
        s.world.context,
        s.actor,
        { ...pagiProduktif(s), priceIdr: -55_000 as never },
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      createWfcBundle(
        s.world.context,
        s.actor,
        { ...pagiProduktif(s), extra: 1 } as never,
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      await listWfcBundles(s.world.context, s.actor, {
        outletId: s.world.outletA,
      }),
    ).toHaveLength(0);
  });

  it("[M1] purchaseWfcBundle rejects a negative paidIdr and an extra key at the service boundary", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = randomUUID();
    await expect(
      purchase(s, bundle.id, customer, -55_000),
    ).rejects.toMatchObject({
      name: "ZodError",
    });
    await expect(
      purchaseWfcBundle(
        s.world.context,
        s.actor,
        {
          bundleId: bundle.id,
          customerProfileId: customer,
          paidIdr: 55_000 as never,
          paymentRef: `pay-${randomUUID()}`,
          extra: 1,
        } as never,
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
  });

  it("[M2] refundWfcBundle rejects a negative refundIdr and an extra key at the service boundary", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const bought = await purchase(s, bundle.id, randomUUID(), 55_000);
    await expect(
      refundWfcBundle(
        s.world.context,
        s.actor,
        { purchaseId: bought.id, refundIdr: -1_000 as never },
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      refundWfcBundle(
        s.world.context,
        s.actor,
        { purchaseId: bought.id, refundIdr: 1_000 as never, extra: 1 } as never,
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("[M2] a grant past its expiry is not refundable", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const bought = await purchase(s, bundle.id, randomUUID(), 55_000);
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(
      await rejectionCode(
        refundWfcBundle(
          s.world.context,
          s.actor,
          { purchaseId: bought.id, refundIdr: 1 as never },
          later,
        ),
      ),
    ).toBe("REFUND_EXCEEDS_REFUNDABLE");
  });

  it("[TEN-03] permissions: create and refund need config, purchase needs operate", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const nobody = await staffWith(s.world, []);
    const operator = await staffWith(s.world, ["facility.booth.operate"]);

    expect(
      await rejectionCode(
        createWfcBundle(s.world.context, nobody, pagiProduktif(s), NOW),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await rejectionCode(
        purchaseWfcBundle(
          s.world.context,
          nobody,
          {
            bundleId: bundle.id,
            customerProfileId: randomUUID(),
            paidIdr: 55_000 as never,
            paymentRef: "p-no",
          },
          NOW,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await rejectionCode(
        createWfcBundle(s.world.context, operator, pagiProduktif(s), NOW),
      ),
    ).toBe("FORBIDDEN");

    const bought = await purchaseWfcBundle(
      s.world.context,
      operator,
      {
        bundleId: bundle.id,
        customerProfileId: randomUUID(),
        paidIdr: 55_000 as never,
        paymentRef: "p-op",
      },
      NOW,
    );
    expect(bought.status).toBe("paid");
    expect(
      await rejectionCode(
        refundWfcBundle(
          s.world.context,
          operator,
          { purchaseId: bought.id, refundIdr: 1 as never },
          NOW,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("[TEN-01][TEN-03] another tenant or another outlet cannot see, buy or refund", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const bought = await purchase(s, bundle.id, randomUUID(), 55_000);

    const other = await createWorld();
    const otherActor = await manager(other);
    expect(
      await rejectionCode(
        purchaseWfcBundle(
          other.context,
          otherActor,
          {
            bundleId: bundle.id,
            customerProfileId: randomUUID(),
            paidIdr: 55_000 as never,
            paymentRef: "p-x",
          },
          NOW,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await rejectionCode(
        refundWfcBundle(
          other.context,
          otherActor,
          { purchaseId: bought.id, refundIdr: 1 as never },
          NOW,
        ),
      ),
    ).toBe("NOT_FOUND");

    const outletB = outletContext(s.world.tenantId, s.world.outletB);
    expect(
      await rejectionCode(
        purchaseWfcBundle(
          outletB,
          s.actor,
          {
            bundleId: bundle.id,
            customerProfileId: randomUUID(),
            paidIdr: 55_000 as never,
            paymentRef: "p-b",
          },
          NOW,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await rejectionCode(
        refundWfcBundle(
          outletB,
          s.actor,
          { purchaseId: bought.id, refundIdr: 1 as never },
          NOW,
        ),
      ),
    ).toBe("NOT_FOUND");
  });
});
