// legend-bz9h (F25/F39): WFC bundles ("Pagi Produktif") against PostgreSQL with
// the restricted app role (RLS enforced). Money rules under test:
// M1 price comes from the database, M2 refund <= paid and idempotent, M3 bundle
// price is a discount only and the allocation adds up to the rupiah, M4
// entitlements only after paid, revoked on refund, issue idempotent.
// Round 3 (spec bz9h-spec3): a purchase is funded ONLY by a captured POS tender
// (pos_order_tenders: same tenant + outlet, status captured, amount >= price) of
// a non-training POS order that has a non-voided line for the bundle's
// `menu_item_id`. payment_intents prove nothing (nothing links an intent to its
// use). A bundle without menu_item_id cannot be sold. One capture (alias-safe,
// case-insensitive) funds one sale, and one order line funds at most `quantity`
// sales. The bundle price floor is 50% of the component list total and is
// re-checked at purchase against the CURRENT list prices.
//
// Assumptions: a bundle without menu_item_id is refused with 409 and either
// PAYMENT_NOT_CAPTURED or BUNDLE_NOT_SELLABLE (the spec names both). The seat
// reservation / day pass half of "one tender funds one sale" lives in
// wfc-seat.test.ts; here two bundles stand in for it.
import { randomBytes, randomUUID } from "node:crypto";
import { ulidToUuid } from "@starter/shared/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  WFC_BUNDLE_MIN_PRICE_BP,
  bundleMinPriceIdr,
} from "@starter/shared/wfc";
import { createApp } from "../app.ts";
import {
  createWfcBundle,
  listWfcBundles,
  purchaseWfcBundle,
  refundWfcBundle,
} from "../services/wfc-bundle.service.ts";
import {
  DATE,
  asTenant,
  createWorld,
  markTraining,
  owner,
  seedOrder,
  seedProfile,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  entitlementsOf,
  ledgerRows,
  NOW,
  outletContext,
  rejectionCode,
  seedFacility,
  seedMenuItems,
} from "./facility-entitlement-helpers.ts";
import { agent, setRole, signUp } from "./helpers.ts";

/** Fixture order-line unit price: above every WFC price, so a line never undercuts the sale. */
const LINE_UNIT_IDR = 1_000_000;

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
  /** Menu item the bundle is sold as at the POS (bundles.menu_item_id). */
  menuItemId: string;
};

/** "Pagi Produktif" parts: a shower single (15.000) and a WFC day pass (50.000). */
async function seed(): Promise<Seeded> {
  const world = await createWorld();
  const actor = await manager(world);
  const showerFacility = await seedFacility(world);
  const wfcFacility = await seedFacility(world);
  const showerProduct = await seedProduct(world, showerFacility, 15_000);
  const dayPassProduct = await seedProduct(world, wfcFacility, 50_000);
  const [menuItemId] = await seedMenuItems(world, 1);
  return {
    world,
    actor,
    showerFacility,
    wfcFacility,
    showerProduct,
    dayPassProduct,
    menuItemId: menuItemId!,
  };
}

const key = () => `wfc-bundle-${randomUUID()}`;

/** `menuItemId: null` leaves the bundle without a POS menu item (not sellable). */
function pagiProduktif(
  s: Seeded,
  priceIdr = 55_000,
  menuItemId: string | null = s.menuItemId,
) {
  return {
    name: "Pagi Produktif",
    priceIdr: priceIdr as never,
    ...(menuItemId === null ? {} : { menuItemId }),
    items: [
      { facilityId: s.showerFacility, productId: s.showerProduct, quantity: 1 },
      { facilityId: s.wfcFacility, productId: s.dayPassProduct, quantity: 1 },
    ],
    idempotencyKey: key(),
  };
}

const createBundle = (
  s: Seeded,
  priceIdr = 55_000,
  menuItemId: string | null = s.menuItemId,
) =>
  createWfcBundle(
    s.world.context,
    s.actor,
    pagiProduktif(s, priceIdr, menuItemId),
    NOW,
  );

type Rejection = { status?: number; code?: string; message?: string };

async function rejection(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    return error as Rejection;
  }
  throw new Error("Expected the call to be rejected, but it succeeded");
}

/** A real customer profile of the tenant (the purchase has a composite FK to it). */
async function newCustomer(s: Seeded, world: World = s.world): Promise<string> {
  return (await seedProfile(world.tenantId)).id;
}

type TenderOptions = {
  world?: World;
  outletId?: string;
  status?: "captured" | "authorized";
  /** Menu item of the order line (default: the bundle's menu item). */
  menuItemId?: string;
  lineStatus?: "served" | "voided";
  /** Quantity of the order line (default 1). */
  quantity?: number;
  /** Reuse an existing order (split tenders on one line): no new line. */
  orderUlid?: string;
  /** Order is a training sale. */
  training?: boolean;
};

/**
 * Seeds the proof of payment: a captured POS tender on a POS order that has one
 * line for the bundle menu item. Returns the tender id, its reference and the
 * order.
 */
async function seedTender(
  s: Seeded,
  amountIdr: number,
  options: TenderOptions = {},
): Promise<{ id: string; reference: string; orderUlid: string }> {
  const world = options.world ?? s.world;
  const outletId = options.outletId ?? world.outletA;
  let orderUlid = options.orderUlid;
  if (!orderUlid) {
    orderUlid = await seedOrder(world.tenantId, { outletId, profileId: null });
    // A foreign tenant has its own menu; the bundle menu item is not theirs.
    const menuItemId =
      options.menuItemId ??
      (options.world ? (await seedMenuItems(world, 1))[0]! : s.menuItemId);
    const quantity = options.quantity ?? 1;
    await asTenant(world.tenantId, (client) =>
      client.query(
        `INSERT INTO order_items
           (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
            unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
            reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, 'Menu uji', $6, 1000000, 0, $7, 'fired', $8, $9)`,
        [
          randomUUID(),
          world.tenantId,
          outletId,
          ulidToUuid(orderUlid!),
          menuItemId,
          quantity,
          LINE_UNIT_IDR * quantity,
          options.lineStatus ?? "served",
          DATE,
        ],
      ),
    );
    if (options.training) await markTraining(world.tenantId, orderUlid);
  }
  const reference = `tnd-${randomUUID().slice(0, 30)}`;
  const status = options.status ?? "captured";
  const id = await asTenant(world.tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, reference)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, $5::text, now(), CASE WHEN $5::text = 'authorized' THEN NULL ELSE now() END, $6)
       RETURNING id`,
      [
        world.tenantId,
        outletId,
        ulidToUuid(orderUlid!),
        amountIdr,
        status,
        reference,
      ],
    );
    return rows[0].id as string;
  });
  return { id, reference, orderUlid };
}

/**
 * Seeds a paid, unlinked payment_intents row the way the payment module leaves
 * it after a capture. It proves nothing: nothing links an intent to its use.
 */
async function seedIntent(
  s: Seeded,
  amountIdr: number,
): Promise<{ id: string; ref: string }> {
  const linkId = randomUUID();
  const id = randomUUID();
  const ref = `cap-${randomUUID()}`;
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      s.world.tenantId,
      s.world.outletA,
      randomBytes(32).toString("hex"),
      `WFB-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(),
             '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7)`,
    [
      id,
      s.world.tenantId,
      s.world.outletA,
      linkId,
      amountIdr,
      `wfb-${id}`,
      ref,
    ],
  );
  return { id, ref };
}

/** Raw purchase with an explicit payment ref (no paidIdr: the amount comes from the capture). */
const purchase = (
  s: Seeded,
  bundleId: string,
  customerProfileId: string,
  paymentRef: string,
) =>
  purchaseWfcBundle(
    s.world.context,
    s.actor,
    { bundleId, customerProfileId, paymentRef },
    NOW,
  );

/** Captures `capturedIdr` on a POS tender first (default: the exact Pagi Produktif price), then buys. */
async function buy(
  s: Seeded,
  bundleId: string,
  customerProfileId: string,
  capturedIdr = 55_000,
) {
  const tender = await seedTender(s, capturedIdr);
  return purchase(s, bundleId, customerProfileId, tender.id);
}

const purchaseRowCount = async (s: Seeded) =>
  (
    await asTenant(s.world.tenantId, (client) =>
      client.query("SELECT 1 FROM wfc_bundle_purchases WHERE tenant_id = $1", [
        s.world.tenantId,
      ]),
    )
  ).rows.length;

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

  it("[M3] the bundle price floor is 50% of the component list total, rounded up", async () => {
    const s = await seed();
    expect(WFC_BUNDLE_MIN_PRICE_BP).toBe(5_000);
    // List total 65.000: floor 32.500.
    expect(await rejectionCode(createBundle(s, 32_499))).toBe(
      "BUNDLE_PRICE_BELOW_FLOOR",
    );
    expect(await rejectionCode(createBundle(s, 1))).toBe(
      "BUNDLE_PRICE_BELOW_FLOOR",
    );
    expect(
      await listWfcBundles(s.world.context, s.actor, {
        outletId: s.world.outletA,
      }),
    ).toHaveLength(0);
    expect((await createBundle(s, 32_500)).priceIdr).toBe(32_500);

    // List total 10.001: floor ceil(5.000,5) = 5.001.
    const odd = await seedProduct(s.world, s.showerFacility, 5_001);
    const even = await seedProduct(s.world, s.wfcFacility, 5_000);
    const oddBundle = (priceIdr: number) =>
      createWfcBundle(
        s.world.context,
        s.actor,
        {
          name: "Odd floor",
          priceIdr: priceIdr as never,
          items: [
            { facilityId: s.showerFacility, productId: odd, quantity: 1 },
            { facilityId: s.wfcFacility, productId: even, quantity: 1 },
          ],
          idempotencyKey: key(),
        },
        NOW,
      );
    expect(await rejectionCode(oddBundle(5_000))).toBe(
      "BUNDLE_PRICE_BELOW_FLOOR",
    );
    expect((await oddBundle(5_001)).priceIdr).toBe(5_001);
  });

  it("[L1] the floor math is exact for huge prices (no overflow)", async () => {
    expect(bundleMinPriceIdr(65_000)).toBe(32_500);
    expect(bundleMinPriceIdr(10_001)).toBe(5_001);
    // ceil(total / 2) at the edge of the safe integer range.
    expect(bundleMinPriceIdr(Number.MAX_SAFE_INTEGER)).toBe(
      4_503_599_627_370_496,
    );
    expect(bundleMinPriceIdr(Number.MAX_SAFE_INTEGER - 1)).toBe(
      4_503_599_627_370_495,
    );
    expect(bundleMinPriceIdr(2 ** 52 + 1)).toBe(2 ** 51 + 1);

    // The same through the service: two components summing to MAX_SAFE_INTEGER.
    const s = await seed();
    const left = await seedProduct(
      s.world,
      s.showerFacility,
      4_503_599_627_370_495,
    );
    const right = await seedProduct(
      s.world,
      s.wfcFacility,
      4_503_599_627_370_496,
    );
    const huge = (priceIdr: number) =>
      createWfcBundle(
        s.world.context,
        s.actor,
        {
          name: "Huge",
          priceIdr: priceIdr as never,
          menuItemId: s.menuItemId,
          items: [
            { facilityId: s.showerFacility, productId: left, quantity: 1 },
            { facilityId: s.wfcFacility, productId: right, quantity: 1 },
          ],
          idempotencyKey: key(),
        },
        NOW,
      );
    expect(await rejectionCode(huge(4_503_599_627_370_495))).toBe(
      "BUNDLE_PRICE_BELOW_FLOOR",
    );
    expect((await huge(4_503_599_627_370_496)).priceIdr).toBe(
      4_503_599_627_370_496,
    );
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

  it("[M1] a purchase without a matching captured tender is refused with PAYMENT_NOT_CAPTURED and issues nothing", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);

    const other = await createWorld();
    const otherTenant = await seedTender(s, 55_000, { world: other });
    const otherOutlet = await seedTender(s, 55_000, {
      outletId: s.world.outletB,
    });
    const authorized = await seedTender(s, 55_000, { status: "authorized" });
    const tooSmall = await seedTender(s, 54_999);
    const refs = [
      "tnd-does-not-exist",
      randomUUID(),
      otherTenant.id,
      otherOutlet.id,
      authorized.id,
      authorized.reference,
      tooSmall.id,
      tooSmall.reference,
    ];
    for (const ref of refs)
      expect(await rejectionCode(purchase(s, bundle.id, customer, ref))).toBe(
        "PAYMENT_NOT_CAPTURED",
      );
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    expect(await purchaseRowCount(s)).toBe(0);
  });

  it("[M1] a paid payment_intents row proves nothing, even when no link column is set", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const intent = await seedIntent(s, 55_000);
    for (const ref of [intent.ref, intent.id])
      expect(await rejectionCode(purchase(s, bundle.id, customer, ref))).toBe(
        "PAYMENT_NOT_CAPTURED",
      );
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    expect(await purchaseRowCount(s)).toBe(0);
  });

  it("[M1] a tender of an order that did not buy the bundle menu item (a food order) is refused", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const [foodMenuItem] = await seedMenuItems(s.world, 1);
    const food = await seedTender(s, 55_000, { menuItemId: foodMenuItem! });
    for (const ref of [food.id, food.reference])
      expect(await rejectionCode(purchase(s, bundle.id, customer, ref))).toBe(
        "PAYMENT_NOT_CAPTURED",
      );
    expect(await purchaseRowCount(s)).toBe(0);
  });

  it("[M1] a tender whose only line for the menu item is voided, or whose order is a training sale, is refused", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const voided = await seedTender(s, 55_000, { lineStatus: "voided" });
    const training = await seedTender(s, 55_000, { training: true });
    for (const ref of [voided.id, training.id])
      expect(await rejectionCode(purchase(s, bundle.id, customer, ref))).toBe(
        "PAYMENT_NOT_CAPTURED",
      );
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    expect(await purchaseRowCount(s)).toBe(0);
  });

  it("[M1] a bundle without menu_item_id cannot be purchased, even with a valid captured tender", async () => {
    const s = await seed();
    // Creating it without a menu item is allowed (the field is optional).
    const bundle = await createBundle(s, 55_000, null);
    const customer = await newCustomer(s);
    const tender = await seedTender(s, 55_000);
    const failure = await rejection(
      purchase(s, bundle.id, customer, tender.id),
    );
    expect(failure.status).toBe(409);
    expect(["PAYMENT_NOT_CAPTURED", "BUNDLE_NOT_SELLABLE"]).toContain(
      failure.code,
    );
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    expect(await purchaseRowCount(s)).toBe(0);
  });

  it("[M1] a purchase is funded by a captured tender matched by id or by reference", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const byReference = await seedTender(s, 55_000);
    const byId = await seedTender(s, 55_000);
    const first = await purchase(
      s,
      bundle.id,
      await newCustomer(s),
      byReference.reference,
    );
    const second = await purchase(s, bundle.id, await newCustomer(s), byId.id);
    expect(first.status).toBe("paid");
    expect(second.status).toBe("paid");
    expect(second.id).not.toBe(first.id);
  });

  it("[M2] the price floor is re-checked at purchase against the current component list prices", async () => {
    const s = await seed();
    // Priced at 55.000 against a 65.000 list total (floor 32.500).
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const tender = await seedTender(s, 55_000);
    const setDayPassPrice = (priceIdr: number) =>
      asTenant(s.world.tenantId, (client) =>
        client.query(
          "UPDATE facility_products SET price_idr = $1 WHERE tenant_id = $2 AND id = $3",
          [priceIdr, s.world.tenantId, s.dayPassProduct],
        ),
      );

    // List total 110.001 -> floor 55.001 > 55.000: refused, nothing issued.
    await setDayPassPrice(95_001);
    expect(
      await rejectionCode(purchase(s, bundle.id, customer, tender.id)),
    ).toBe("BUNDLE_PRICE_BELOW_FLOOR");
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    expect(await purchaseRowCount(s)).toBe(0);

    // List total 110.000 -> floor exactly 55.000: sold, and the refused attempt
    // did not burn the tender.
    await setDayPassPrice(95_000);
    const bought = await purchase(s, bundle.id, customer, tender.id);
    expect(bought.status).toBe("paid");
    expect(bought.pricePaidIdr).toBe(55_000);
  });

  it("[M1] the stored paid amount is the bundle price, never the captured amount; overpayment is not refundable", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const bought = await buy(s, bundle.id, customer, 100_000);
    expect(bought.pricePaidIdr).toBe(55_000);
    expect(
      bought.allocations.reduce((sum, row) => sum + row.allocatedIdr, 0),
    ).toBe(55_000);
    const stored = await asTenant(s.world.tenantId, (client) =>
      client.query(
        "SELECT price_paid_idr FROM wfc_bundle_purchases WHERE tenant_id = $1 AND id = $2",
        [s.world.tenantId, bought.id],
      ),
    );
    expect(Number(stored.rows[0].price_paid_idr)).toBe(55_000);
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
  });

  it("[M3][M4] a purchase allocates the exact price and issues one package grant per item", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const bought = await buy(s, bundle.id, customer);
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
        menuItemId: s.menuItemId,
        items: [
          { facilityId: s.showerFacility, productId: odd, quantity: 1 },
          { facilityId: s.wfcFacility, productId: even, quantity: 1 },
        ],
        idempotencyKey: key(),
      },
      NOW,
    );
    const bought = await buy(s, bundle.id, await newCustomer(s), 9_999);
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
        menuItemId: s.menuItemId,
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
    const customer = await newCustomer(s);
    await buy(s, bundle.id, customer, 220_000);
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
    const customer = await newCustomer(s);
    const { id: ref } = await seedTender(s, 55_000);
    const first = await purchase(s, bundle.id, customer, ref);
    const again = await purchase(s, bundle.id, customer, ref);
    expect(again.id).toBe(first.id);
    expect(again.status).toBe("paid");
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(2);
    expect(await purchaseRowCount(s)).toBe(1);
  });

  it("[M4] concurrent purchases with one payment ref create one sale and one set of grants", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const { id: ref } = await seedTender(s, 55_000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => purchase(s, bundle.id, customer, ref)),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(2);
    expect(await purchaseRowCount(s)).toBe(1);
  });

  it("[M4] one capture funds one sale: another customer or another bundle with the same tender is PAYMENT_ALREADY_USED", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const second = await createBundle(s, 65_000);
    const customer = await newCustomer(s);
    // Captured 65.000 so the amount alone would cover both bundles.
    const tender = await seedTender(s, 65_000);
    const first = await purchase(s, bundle.id, customer, tender.id);
    expect(
      await rejectionCode(
        purchase(s, bundle.id, await newCustomer(s), tender.id),
      ),
    ).toBe("PAYMENT_ALREADY_USED");
    expect(
      await rejectionCode(purchase(s, second.id, customer, tender.id)),
    ).toBe("PAYMENT_ALREADY_USED");
    // The same tender addressed by its reference is the same capture.
    expect(
      await rejectionCode(
        purchase(s, bundle.id, await newCustomer(s), tender.reference),
      ),
    ).toBe("PAYMENT_ALREADY_USED");
    expect(await purchaseRowCount(s)).toBe(1);
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(2);
    expect(first.status).toBe("paid");
  });

  it("[M4] an uppercase and a lowercase spelling of the payment ref are one capture and one sale", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const tender = await seedTender(s, 55_000);
    const lower = tender.id.toLowerCase();
    const upper = tender.id.toUpperCase();
    expect(upper).not.toBe(lower);

    const first = await purchase(s, bundle.id, customer, lower);
    // Same customer, other spelling: the first sale is replayed.
    const again = await purchase(s, bundle.id, customer, upper);
    expect(again.id).toBe(first.id);
    // Another customer, other spelling: the capture is used.
    expect(
      await rejectionCode(purchase(s, bundle.id, await newCustomer(s), upper)),
    ).toBe("PAYMENT_ALREADY_USED");
    expect(await purchaseRowCount(s)).toBe(1);
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(2);

    // Racing both spellings still makes one sale.
    const raced = await seedTender(s, 55_000);
    const other = await newCustomer(s);
    const results = await Promise.all(
      [raced.id.toLowerCase(), raced.id.toUpperCase()].flatMap((ref) =>
        Array.from({ length: 3 }, () => purchase(s, bundle.id, other, ref)),
      ),
    );
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await purchaseRowCount(s)).toBe(2);
  });

  it("[M4] the tender id and the tender reference are the same payment: the first purchase is replayed", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const tender = await seedTender(s, 55_000);

    const first = await purchase(s, bundle.id, customer, tender.id);
    const again = await purchase(s, bundle.id, customer, tender.reference);
    expect(again.id).toBe(first.id);
    expect(await purchaseRowCount(s)).toBe(1);
    // Another customer under the other alias: the capture is used.
    expect(
      await rejectionCode(
        purchase(s, bundle.id, await newCustomer(s), tender.reference),
      ),
    ).toBe("PAYMENT_ALREADY_USED");
  });

  it("[M4] one order line funds at most its quantity in sales, even with several tenders", async () => {
    const s = await seed();
    const bundle = await createBundle(s);

    // Qty 1 line, two split tenders each covering the price: only one sale.
    const single = await seedTender(s, 55_000);
    const splitTender = await seedTender(s, 55_000, {
      orderUlid: single.orderUlid,
    });
    expect(
      (await purchase(s, bundle.id, await newCustomer(s), single.id)).status,
    ).toBe("paid");
    expect(
      await rejectionCode(
        purchase(s, bundle.id, await newCustomer(s), splitTender.id),
      ),
    ).toBe("PAYMENT_ALREADY_USED");
    expect(await purchaseRowCount(s)).toBe(1);

    // Qty 2 line: two sales, the third tender is refused.
    const double = await seedTender(s, 55_000, { quantity: 2 });
    const doubleB = await seedTender(s, 55_000, {
      orderUlid: double.orderUlid,
    });
    const doubleC = await seedTender(s, 55_000, {
      orderUlid: double.orderUlid,
    });
    await purchase(s, bundle.id, await newCustomer(s), double.id);
    await purchase(s, bundle.id, await newCustomer(s), doubleB.id);
    expect(
      await rejectionCode(
        purchase(s, bundle.id, await newCustomer(s), doubleC.id),
      ),
    ).toBe("PAYMENT_ALREADY_USED");
    expect(await purchaseRowCount(s)).toBe(3);
  });

  it("[M2][M4] a refund pays at most what was paid, revokes the grants and a second refund is a no-op", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const bought = await buy(s, bundle.id, customer);

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
    const customer = await newCustomer(s);
    const bought = await buy(s, bundle.id, customer);
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
    const bought = await buy(s, bundle.id, await newCustomer(s));
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

  it("[M1] purchaseWfcBundle rejects a paidIdr key and any extra key at the service boundary", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const customer = await newCustomer(s);
    const { id: ref } = await seedTender(s, 55_000);
    // Staff cannot type the paid amount any more: the strict schema refuses it.
    for (const paidIdr of [55_000, -55_000, 1])
      await expect(
        purchaseWfcBundle(
          s.world.context,
          s.actor,
          {
            bundleId: bundle.id,
            customerProfileId: customer,
            paidIdr,
            paymentRef: ref,
          } as never,
          NOW,
        ),
      ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      purchaseWfcBundle(
        s.world.context,
        s.actor,
        {
          bundleId: bundle.id,
          customerProfileId: customer,
          paymentRef: ref,
          extra: 1,
        } as never,
        NOW,
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(
      await ledgerRows(s.world.tenantId, { customerProfileId: customer }),
    ).toHaveLength(0);
    expect(await purchaseRowCount(s)).toBe(0);
  });

  it("[M4] a purchase for a customer profile that does not exist in the tenant is a 404 Pelanggan and issues nothing", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const otherWorld = await createWorld();
    const foreignCustomer = await newCustomer(s, otherWorld);
    const tender = await seedTender(s, 55_000);
    // Composite FK (tenant_id, customer_profile_id): an unknown id and another
    // tenant's profile are both a 404 notFound("Pelanggan"), not a 500.
    for (const customerProfileId of [randomUUID(), foreignCustomer]) {
      const failure = await rejection(
        purchase(s, bundle.id, customerProfileId, tender.id),
      );
      expect(failure.status).toBe(404);
      expect(failure.code).toBe("NOT_FOUND");
      expect(failure.message).toContain("Pelanggan");
    }
    expect(await purchaseRowCount(s)).toBe(0);
    expect(
      await ledgerRows(s.world.tenantId, {
        customerProfileId: foreignCustomer,
      }),
    ).toHaveLength(0);
    // The failed attempts did not burn the capture: a real customer can still use it.
    const bought = await purchase(
      s,
      bundle.id,
      await newCustomer(s),
      tender.id,
    );
    expect(bought.status).toBe("paid");
  });

  it("[M4] wfc_bundle_purchases.customer_profile_id has a composite FK to customer_profiles", async () => {
    const { rows } = await owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'wfc_bundle_purchases'::regclass AND contype = 'f'`,
    );
    expect(
      rows.some((row) =>
        /FOREIGN KEY \(tenant_id, customer_profile_id\) REFERENCES customer_profiles\(tenant_id, id\)/.test(
          row.def,
        ),
      ),
    ).toBe(true);
  });

  it("[M2] refundWfcBundle rejects a negative refundIdr and an extra key at the service boundary", async () => {
    const s = await seed();
    const bundle = await createBundle(s);
    const bought = await buy(s, bundle.id, await newCustomer(s));
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
    const bought = await buy(s, bundle.id, await newCustomer(s));
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
    const nobodyRef = (await seedTender(s, 55_000)).id;
    const operatorRef = (await seedTender(s, 55_000)).id;

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
            customerProfileId: await newCustomer(s),
            paymentRef: nobodyRef,
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
        customerProfileId: await newCustomer(s),
        paymentRef: operatorRef,
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
    const bought = await buy(s, bundle.id, await newCustomer(s));

    const other = await createWorld();
    const otherActor = await manager(other);
    // Valid captures in each foreign context so only the bundle lookup can refuse.
    const otherRef = (await seedTender(s, 55_000, { world: other })).id;
    const otherCustomer = await newCustomer(s, other);
    const outletBRef = (
      await seedTender(s, 55_000, { outletId: s.world.outletB })
    ).id;
    expect(
      await rejectionCode(
        purchaseWfcBundle(
          other.context,
          otherActor,
          {
            bundleId: bundle.id,
            customerProfileId: otherCustomer,
            paymentRef: otherRef,
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
            customerProfileId: await newCustomer(s),
            paymentRef: outletBRef,
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
