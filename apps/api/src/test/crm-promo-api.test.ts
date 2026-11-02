// Promo engine admin, checkout preview, vouchers and ROI API (PRD v1.7 §3.21;
// LOY-03; ORD-03; TEN-01..03; Q20; bead legend-7x4g). HTTP tests run the real
// Express app, Better Auth, the RBAC resolver and PostgreSQL against the
// seeded Cafe Legend tenant.
//
// Isolation: files share the tenant, so every active promotion here is
// conditioned on a menu item created by this file (or needs its own voucher
// code), and afterAll ends them and restores the default stacking policy.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outlet, secondOutlet] = cafeLegendPlatformFixtures.outlets;
const brandId = cafeLegendFixtures.brand.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const createdUsers: string[] = [];
const createdPromotions: string[] = [];
const createdItems: string[] = [];
const categoryId = randomUUID();
const priceListId = randomUUID();

/** Owner-side writes need the tenant local setting because RLS is FORCED. */
async function asTenant<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A menu item sold on the outlet's takeaway list, or unpriced when null. */
async function seedItem(priceIdr: number | null): Promise<string> {
  const itemId = randomUUID();
  createdItems.push(itemId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Menu Uji Promo', true, $5)`,
      [itemId, tenant.id, brandId, categoryId, randomUUID()],
    );
    if (priceIdr !== null)
      await db.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.id, priceListId, itemId, priceIdr],
      );
  });
  return itemId;
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

/** The seeded Owner template: every tenant permission except platform tools. */
async function ownerClient() {
  const { client, userId } = await signedInClient("Promo Owner");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, userId],
  );
  return { client, userId };
}

/** A custom role with exactly the given catalog codes. */
async function grantRole(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant.id,
      `Promo test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.id,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return roleId;
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const randomCode = () =>
  `PROMO${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

const startsAt = () => new Date(Date.now() - 3_600_000).toISOString();

function promoBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Promo Uji",
    description: "",
    status: "draft",
    codeHash: null,
    voucherRequired: false,
    startsAt: startsAt(),
    endsAt: null,
    conditions: [],
    benefit: { kind: "percent_off", percentBp: 1000, maxDiscountIdr: null },
    stackGroup: "uji",
    stackable: true,
    priority: 0,
    quotaTotal: null,
    quotaPerCustomer: null,
    budgetIdr: null,
    ...overrides,
  };
}

/** An active promotion scoped to one test-owned item (never touches others). */
function itemPromoBody(
  itemId: string,
  overrides: Record<string, unknown> = {},
) {
  return promoBody({
    status: "active",
    conditions: [
      { kind: "item_quantity", menuItemIds: [itemId], minQuantity: 1 },
    ],
    ...overrides,
  });
}

type Client_ = Awaited<ReturnType<typeof ownerClient>>["client"];

async function createPromotion(
  client: Client_,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await client
    .post("/api/promotions")
    .set(originHeader)
    .send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const id = response.body.data.id as string;
  createdPromotions.push(id);
  return id;
}

const evaluate = (
  client: Client_,
  body: Record<string, unknown>,
  outletId: string = outlet.id,
) =>
  client
    .post(`/api/promotions/evaluate?outletId=${outletId}`)
    .set(originHeader)
    .send(body);

beforeAll(async () => {
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Kategori Uji Promo', 0)`,
      [categoryId, tenant.id, brandId],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2020-01-01')`,
      [priceListId, tenant.id, outlet.id],
    );
  });
});

afterAll(async () => {
  if (createdPromotions.length > 0)
    await owner.query(
      "UPDATE promotions SET status = 'ended' WHERE id = ANY($1)",
      [createdPromotions],
    );
  await owner.query("DELETE FROM promo_settings WHERE tenant_id = $1", [
    tenant.id,
  ]);
  await asTenant(async (db) => {
    await db.query(
      "DELETE FROM price_list_items WHERE tenant_id = $1 AND price_list_id = $2",
      [tenant.id, priceListId],
    );
    await db.query("DELETE FROM price_lists WHERE tenant_id = $1 AND id = $2", [
      tenant.id,
      priceListId,
    ]);
    await db.query(
      "DELETE FROM menu_items WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdItems],
    );
    await db.query(
      "DELETE FROM menu_categories WHERE tenant_id = $1 AND id = $2",
      [tenant.id, categoryId],
    );
  });
  if (createdUsers.length > 0) {
    await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
      createdUsers,
    ]);
    await owner.query(
      "DELETE FROM roles WHERE name LIKE 'Promo test %' AND tenant_id = $1",
      [tenant.id],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  }
  await owner.end();
});

describe("Promo API authorization and tenant isolation", () => {
  it("[TEN-01] answers 401 to anonymous requests", async () => {
    const anonymous = agent(app);
    expect((await anonymous.get("/api/promotions")).status).toBe(401);
    expect(
      (
        await anonymous
          .post(`/api/promotions/evaluate?outletId=${outlet.id}`)
          .set(originHeader)
          .send({ channel: "takeaway", lines: [], voucherCode: null })
      ).status,
    ).toBe(401);
  });

  it("[TEN-03] refuses promo administration without promo.manage", async () => {
    const cashier = await signedInClient("Kasir Promo");
    await grantRole(cashier.userId, ["order.create"], { type: "tenant" });
    const { client } = cashier;
    const id = randomUUID();

    expect((await client.get("/api/promotions")).status).toBe(403);
    expect(
      (
        await client.post("/api/vouchers").set(originHeader).send({
          promotionId: null,
          customerProfileId: null,
          source: "manual",
          valueIdr: 1000,
          validFrom: startsAt(),
          validUntil: null,
        })
      ).status,
    ).toBe(403);
    expect((await client.get(`/api/promotions/${id}/roi`)).status).toBe(403);
    expect((await client.get("/api/promotions/stacking-policy")).status).toBe(
      403,
    );
    expect(
      (
        await client
          .put("/api/promotions/stacking-policy")
          .set(originHeader)
          .send({ mode: "exclusive", maxStacked: 1, allowSameGroup: false })
      ).status,
    ).toBe(403);
  });

  it("[TEN-02] rejects a tenantId or any unknown field in the body", async () => {
    const { client } = await ownerClient();
    const withTenant = await client
      .post("/api/promotions")
      .set(originHeader)
      .send(promoBody({ tenantId: tenant.id }));
    expect(withTenant.status).toBe(422);

    const unknown = await client
      .post("/api/promotions")
      .set(originHeader)
      .send(promoBody({ surprise: true }));
    expect(unknown.status).toBe(422);
  });

  it("[TEN-03] checks order.create on the outlet named by outletId", async () => {
    const itemId = await seedItem(50_000);
    const waiter = await signedInClient("Kasir Satu Outlet");
    await grantRole(waiter.userId, ["order.create"], {
      type: "outlet",
      id: outlet.id,
    });
    const body = {
      channel: "takeaway",
      lines: [{ menuItemId: itemId, quantity: 1 }],
      voucherCode: null,
    };

    const other = await evaluate(waiter.client, body, secondOutlet.id);
    expect(other.status).toBe(403);
    const own = await evaluate(waiter.client, body, outlet.id);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.totalDiscountIdr).toBe(0);

    const garbage = await evaluate(waiter.client, body, "not-a-uuid");
    expect(garbage.status).toBeGreaterThanOrEqual(400);
    expect(garbage.status).toBeLessThan(500);
    const missing = await waiter.client
      .post("/api/promotions/evaluate")
      .set(originHeader)
      .send(body);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
  });
});

describe("Promotion administration", () => {
  it("[§3.21] creates, lists, updates and ends a promotion", async () => {
    const { client } = await ownerClient();
    const itemId = randomUUID();
    const id = await createPromotion(
      client,
      promoBody({
        name: "Promo Admin",
        conditions: [
          { kind: "item_quantity", menuItemIds: [itemId], minQuantity: 1 },
        ],
      }),
    );

    const list = await client.get("/api/promotions?limit=100");
    expect(list.status).toBe(200);
    const listed = (list.body.data as { id: string; name: string }[]).find(
      (row) => row.id === id,
    );
    expect(listed?.name).toBe("Promo Admin");

    const patched = await client
      .patch(`/api/promotions/${id}`)
      .set(originHeader)
      .send({ name: "Promo Admin Baru", status: "active" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.data.name).toBe("Promo Admin Baru");
    expect(patched.body.data.status).toBe("active");

    const empty = await client
      .patch(`/api/promotions/${id}`)
      .set(originHeader)
      .send({});
    expect(empty.status).toBe(422);

    const ended = await client
      .patch(`/api/promotions/${id}`)
      .set(originHeader)
      .send({ status: "ended" });
    expect(ended.status).toBe(200);
    expect(ended.body.data.status).toBe("ended");

    const reactivated = await client
      .patch(`/api/promotions/${id}`)
      .set(originHeader)
      .send({ status: "active" });
    expect(reactivated.status).toBe(409);
    expect(reactivated.body.error.code).toBe("PROMO_ENDED");
  });

  it("[§3.21] refuses a free_items benefit without an item_quantity condition", async () => {
    const { client } = await ownerClient();
    const response = await client
      .post("/api/promotions")
      .set(originHeader)
      .send(
        promoBody({
          benefit: {
            kind: "free_items",
            menuItemIds: [randomUUID()],
            quantityPerMultiple: 1,
          },
          conditions: [],
        }),
      );
    expect(response.status).toBe(422);
  });

  it("[§3.21 ROI] reports an empty ROI and 404 for an unknown promotion", async () => {
    const { client } = await ownerClient();
    const id = await createPromotion(
      client,
      promoBody({
        name: "Promo ROI",
        conditions: [
          {
            kind: "item_quantity",
            menuItemIds: [randomUUID()],
            minQuantity: 1,
          },
        ],
      }),
    );
    const roi = await client.get(`/api/promotions/${id}/roi`);
    expect(roi.status).toBe(200);
    expect(roi.body.data).toEqual({
      promotionId: id,
      transactions: 0,
      discountCostIdr: 0,
      revenueIdr: 0,
      netMarginIdr: 0,
      roiBp: null,
    });

    const unknown = await client.get(`/api/promotions/${randomUUID()}/roi`);
    expect(unknown.status).toBe(404);
  });

  it("[Q20] serves and validates the stacking policy", async () => {
    const { client } = await ownerClient();
    const initial = await client.get("/api/promotions/stacking-policy");
    expect(initial.status).toBe(200);
    expect(initial.body.data).toEqual({
      mode: "exclusive",
      maxStacked: 1,
      allowSameGroup: false,
    });
    const invalid = await client
      .put("/api/promotions/stacking-policy")
      .set(originHeader)
      .send({ mode: "exclusive", maxStacked: 2, allowSameGroup: false });
    expect(invalid.status).toBe(422);
  });
});

describe("Promo evaluation at checkout", () => {
  it("[ORD-03] prices lines from the server price list", async () => {
    const { client } = await ownerClient();
    const itemId = await seedItem(50_000);
    await createPromotion(client, itemPromoBody(itemId, { name: "Diskon 10" }));

    const response = await evaluate(client, {
      channel: "takeaway",
      lines: [{ menuItemId: itemId, quantity: 2 }],
      voucherCode: null,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.totalDiscountIdr).toBe(10_000);

    const forged = await evaluate(client, {
      channel: "takeaway",
      lines: [{ menuItemId: itemId, quantity: 2, unitPriceIdr: 1 }],
      voucherCode: null,
    });
    expect(forged.status).toBe(422);
  });

  it("[ORD-03] refuses an item without a price on the channel list", async () => {
    const { client } = await ownerClient();
    const unpriced = await seedItem(null);
    const response = await evaluate(client, {
      channel: "takeaway",
      lines: [{ menuItemId: unpriced, quantity: 1 }],
      voucherCode: null,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("ITEM_NOT_PRICED");
  });

  it("[Q20] compounds stacked percentages sequentially", async () => {
    const { client } = await ownerClient();
    const itemId = await seedItem(50_000);
    const policy = await client
      .put("/api/promotions/stacking-policy")
      .set(originHeader)
      .send({ mode: "stackable", maxStacked: 2, allowSameGroup: false });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    try {
      await createPromotion(
        client,
        itemPromoBody(itemId, {
          name: "Sepuluh Persen",
          stackGroup: "a",
          stackable: true,
          priority: 20,
          benefit: {
            kind: "percent_off",
            percentBp: 1000,
            maxDiscountIdr: null,
          },
        }),
      );
      await createPromotion(
        client,
        itemPromoBody(itemId, {
          name: "Dua Puluh Persen",
          stackGroup: "b",
          stackable: true,
          priority: 10,
          benefit: {
            kind: "percent_off",
            percentBp: 2000,
            maxDiscountIdr: null,
          },
        }),
      );
      const response = await evaluate(client, {
        channel: "takeaway",
        lines: [{ menuItemId: itemId, quantity: 2 }],
        voucherCode: null,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // 100.000 - 10% = 90.000, then 20% of 90.000 = 18.000: 28.000 in all.
      expect(response.body.data.totalDiscountIdr).toBe(28_000);
    } finally {
      await owner.query("DELETE FROM promo_settings WHERE tenant_id = $1", [
        tenant.id,
      ]);
    }
  });
});

describe("Vouchers", () => {
  it("[LOY-03] issues, lists, validates and applies a promotion voucher", async () => {
    const { client } = await ownerClient();
    const itemId = await seedItem(50_000);
    const promoCode = randomCode();
    const promotionId = await createPromotion(
      client,
      promoBody({
        name: "Promo Voucher",
        status: "active",
        voucherRequired: true,
        codeHash: sha256(promoCode),
        benefit: { kind: "nominal_off", amountIdr: 15_000 },
        conditions: [
          { kind: "item_quantity", menuItemIds: [itemId], minQuantity: 1 },
        ],
      }),
    );

    const issued = await client.post("/api/vouchers").set(originHeader).send({
      promotionId,
      customerProfileId: null,
      source: "manual",
      valueIdr: null,
      validFrom: startsAt(),
      validUntil: null,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const code = issued.body.data.code as string;
    expect(code).toMatch(/^[A-Z0-9]{6,32}$/);
    expect(issued.body.data.voucher.promotionId).toBe(promotionId);
    expect(issued.body.data.voucher).not.toHaveProperty("codeHash");

    const list = await client.get("/api/vouchers?limit=100");
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { id: string }[]).some(
        (row) => row.id === issued.body.data.voucher.id,
      ),
    ).toBe(true);
    for (const row of list.body.data as Record<string, unknown>[])
      expect(row).not.toHaveProperty("codeHash");

    const validated = await client
      .post(`/api/vouchers/validate?outletId=${outlet.id}`)
      .set(originHeader)
      .send({ code, subtotalIdr: 100_000, channel: "takeaway" });
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    expect(validated.body.data).toMatchObject({
      valid: true,
      voucherId: issued.body.data.voucher.id,
      promotionId,
      discountPreviewIdr: 15_000,
    });

    const applied = await evaluate(client, {
      channel: "takeaway",
      lines: [{ menuItemId: itemId, quantity: 2 }],
      voucherCode: code,
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const evaluation = (
      applied.body.data.evaluations as {
        promotionId: string;
        applied: boolean;
      }[]
    ).find((entry) => entry.promotionId === promotionId);
    expect(evaluation?.applied).toBe(true);
    expect(applied.body.data.totalDiscountIdr).toBeGreaterThanOrEqual(15_000);

    const withoutCode = await evaluate(client, {
      channel: "takeaway",
      lines: [{ menuItemId: itemId, quantity: 2 }],
      voucherCode: null,
    });
    expect(withoutCode.status).toBe(200);
    expect(withoutCode.body.data.totalDiscountIdr).toBe(0);
  });

  it("[LOY-03] rejects an unknown code on validate and evaluate", async () => {
    const { client } = await ownerClient();
    const itemId = await seedItem(50_000);
    const unknown =
      "ZZZZ" + randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();

    const validated = await client
      .post(`/api/vouchers/validate?outletId=${outlet.id}`)
      .set(originHeader)
      .send({ code: unknown, subtotalIdr: 100_000, channel: "takeaway" });
    expect(validated.status).toBe(200);
    expect(validated.body.data).toEqual({ valid: false, reason: "not_found" });

    const evaluated = await evaluate(client, {
      channel: "takeaway",
      lines: [{ menuItemId: itemId, quantity: 1 }],
      voucherCode: unknown,
    });
    expect(evaluated.status).toBe(422);
    expect(evaluated.body.error.code).toBe("VOUCHER_INVALID");
  });

  it("[LOY-03] previews a value voucher capped at the subtotal", async () => {
    const { client } = await ownerClient();
    const issue = (valueIdr: number | null) =>
      client.post("/api/vouchers").set(originHeader).send({
        promotionId: null,
        customerProfileId: null,
        source: "apology",
        valueIdr,
        validFrom: startsAt(),
        validUntil: null,
      });

    const issued = await issue(20_000);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const code = issued.body.data.code as string;
    const preview = (subtotalIdr: number) =>
      client
        .post(`/api/vouchers/validate?outletId=${outlet.id}`)
        .set(originHeader)
        .send({ code, subtotalIdr, channel: "takeaway" });

    const large = await preview(100_000);
    expect(large.body.data).toMatchObject({
      valid: true,
      promotionId: null,
      discountPreviewIdr: 20_000,
    });
    const small = await preview(12_000);
    expect(small.body.data.discountPreviewIdr).toBe(12_000);

    const empty = await issue(null);
    expect(empty.status).toBe(422);
  });
});
