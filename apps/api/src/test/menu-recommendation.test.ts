// AI-01 menu recommendation API (legend-ptd). Written from the brief contract
// and packages/shared/src/menu/recommendation.ts, not from the service.
//
// Real Express app + Better Auth + RBAC + PostgreSQL. Every scenario builds its
// own outlet (clone of the isolated tenant's outlet, timezone Asia/Jakarta,
// UTC+7) with its own items, price list, recipes and orders, so counts never
// bleed between tests.
//
// Assumptions (spec silent):
// - Routes: GET/PUT /api/menu/recommendation-rules?outletId=..., GET
//   /api/menu/recommendations?outletId=...&anchorItemIds[]=...
//   (bracket form so a single anchor still parses as an array).
// - Success body is { data: ... } like sibling routes; payload() also accepts
//   a bare body.
// - Sell price = price_list_items of the outlet's dine_in price list in force.
// - HPP per portion = the real recipe cost (recipe_lines x ingredient average
//   cost at the outlet's sale location; one portion), never
//   recipes.theoretical_cost_idr (a decoy column nothing fills). The fixtures
//   seed a recipe, recipe_lines and stock_balances.avg_cost_idr (Rp1/g, so
//   quantity in grams = cost in rupiah). Unknown cost (no recipe, or an
//   ingredient without cost) drops the item.
// - "Out of stock" = item_availability.status 'sold_out' for the outlet, or
//   sold_out_until in the future, or a daily_limit reached by
//   menu_item_daily_usage today, or a schedule that excludes the moment.
// - Margin is computed on the net price when the outlet's prices include tax
//   (tax_settings.prices_include_tax): net = floor(price * 10000 / (10000 +
//   rate_bp)); margin = (net - cost) / net.
// - Privacy: memberId history needs crm.customer.view and an open member
//   (status other than closed); marginBps needs recipe.cost.view (else null);
//   score is the rank only: n, n-1, ..., 1 in list order (assumption: the
//   brief says "1..n turun"). A caller without the permission is not refused:
//   the member / margin data is just left out.
// - Popular list: an item's total is the sum of menu_item_daily_usage.quantity
//   within the lookback; totals below minPairSupport are dropped.
// - Lookback is counted back from now (orders are seeded far from the edge).
// - PUT itemRules is exercised only as "set these rules".
// - Wrong tenant/outlet: 403 or 404 (both hide the data).
// - Ids are UUIDs (coordinator correction), not ULIDs.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";
import { signUp } from "./helpers.ts";

const RULES = "/api/menu/recommendation-rules";
const RECS = "/api/menu/recommendations";

let app: Express;
let world: IsolatedTenant;
let admin: Staff; // tenant scope, menu.item.view + manage + crm.customer.view + recipe.cost.view
let cashier: Staff; // menu.item.view only (kasir/waiter)
let crmViewer: Staff; // + crm.customer.view, no recipe.cost.view
let costViewer: Staff; // + recipe.cost.view, no crm.customer.view
let foreign: IsolatedTenant;
let foreignAdmin: Staff;
let counter = 0;
let actingUserId = ""; // recipes.updated_by is a FK to a real user

type Json = Record<string, any>;
const payload = (res: { body: Json }): Json => res.body.data ?? res.body;

async function asTenant<T>(
  tenantId: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
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

/** Staff of `tenant` holding exactly `permissions` (tenant or outlet scope). */
async function staffWith(
  tenant: IsolatedTenant,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; outletId: string } = {
    type: "tenant",
  },
): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, "Rekomendasi Uji");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [
      roleId,
      tenant.tenantId,
      `Rek ${roleId.slice(0, 6)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId, email };
}

type ItemSpec = {
  price: number;
  /** HPP per portion; null = no recipe (cost unknown). */
  cost: number | null;
  active?: boolean;
  soldOut?: boolean;
  /** Recipe whose only ingredient has no average cost: cost unknown. */
  costless?: boolean;
  /** Wrong value in the unused recipes.theoretical_cost_idr column. */
  decoy?: number;
  availability?: {
    schedule?: unknown[];
    dailyLimit?: number;
    /** Quantity already sold today (menu_item_daily_usage). */
    usedToday?: number;
    soldOutUntil?: string;
  };
};
type Scenario = {
  tenant: IsolatedTenant;
  outletId: string;
  items: Record<string, string>;
  names: Record<string, string>;
};

let categoryByTenant = new Map<string, string>();
let uomByTenant = new Map<string, string>();
type Ingredients = { gram: string; costed: string; costless: string };
let ingredientsByTenant = new Map<string, Ingredients>();

async function ensureCatalog(tenant: IsolatedTenant) {
  if (categoryByTenant.has(tenant.tenantId)) return;
  const category = randomUUID();
  const uom = randomUUID();
  const gram = randomUUID();
  const costed = randomUUID();
  const costless = randomUUID();
  await asTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Rekomendasi')`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'cup', 'cup')`,
      [uom, tenant.tenantId],
    );
    await client.query(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'gr', 'gram')`,
      [gram, tenant.tenantId],
    );
    for (const [id, name] of [
      [costed, "Bahan berbiaya"],
      [costless, "Bahan tanpa biaya"],
    ])
      await client.query(
        `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id, is_perishable)
         VALUES ($1, $2, $3, 'Bahan Baku', 'raw_material', $4, true)`,
        [id, tenant.tenantId, `${name} ${id!.slice(0, 6)}`, gram],
      );
  });
  categoryByTenant.set(tenant.tenantId, category);
  uomByTenant.set(tenant.tenantId, uom);
  ingredientsByTenant.set(tenant.tenantId, { gram, costed, costless });
}

/** Jakarta (UTC+7) calendar date of an instant, YYYY-MM-DD. */
const jakartaDate = (offsetDays = 0, from = Date.now()) =>
  new Date(from + 7 * 3_600_000 + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

async function makeOutlet(tenant: IsolatedTenant): Promise<string> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Rekomendasi', address, 'Asia/Jakarta', opening_hours, status
     FROM outlets WHERE id = $3`,
    [outletId, `R-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  return outletId;
}

async function scenario(
  tenant: IsolatedTenant,
  specs: Record<string, ItemSpec>,
): Promise<Scenario> {
  await ensureCatalog(tenant);
  const category = categoryByTenant.get(tenant.tenantId)!;
  const uom = uomByTenant.get(tenant.tenantId)!;
  const outletId = await makeOutlet(tenant);
  const items: Record<string, string> = {};
  const names: Record<string, string> = {};
  const priceList = randomUUID();
  const ingredients = ingredientsByTenant.get(tenant.tenantId)!;
  await asTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2020-01-01')`,
      [priceList, tenant.tenantId, outletId],
    );
    // Sale location holding the ingredients: Rp1 per gram, or no cost at all.
    const location = randomUUID();
    await client.query(
      `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar', 'bar')`,
      [location, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
       VALUES ($1, $2, 'real_time', $3)`,
      [tenant.tenantId, outletId, location],
    );
    for (const [item, cost] of [
      [ingredients.costed, "1.0000"],
      [ingredients.costless, "0.0000"],
    ])
      await client.query(
        `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
         VALUES ($1, $2, $3, $4, '100000.0000', $5)`,
        [tenant.tenantId, outletId, location, item, cost],
      );
    for (const [key, spec] of Object.entries(specs)) {
      const id = randomUUID();
      let recipeId: string | null = null;
      if (spec.cost !== null || spec.costless) {
        recipeId = randomUUID();
        await client.query(
          `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, theoretical_cost_idr)
           VALUES ($1, $2, $3, $4, NULL, 1, $5, true, $6, $7)`,
          [
            recipeId,
            tenant.tenantId,
            tenant.brandId,
            `Resep ${key} ${recipeId.slice(0, 6)}`,
            uom,
            actingUserId,
            spec.decoy ?? 0,
          ],
        );
        await client.query(
          `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
           VALUES ($1, $2, 0, 'item', $3, $4, $5, 0)`,
          [
            tenant.tenantId,
            recipeId,
            spec.costless ? ingredients.costless : ingredients.costed,
            `${spec.costless ? 100 : spec.cost}.0000`,
            ingredients.gram,
          ],
        );
      }
      const name = `Menu ${key} ${id.slice(0, 6)}`;
      names[key] = name;
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, recipe_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          category,
          name,
          recipeId,
          spec.active ?? true,
        ],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, priceList, id, spec.price],
      );
      const availability = spec.availability;
      if (spec.soldOut || availability)
        await client.query(
          `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, sold_out_until, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            tenant.tenantId,
            outletId,
            id,
            JSON.stringify(availability?.schedule ?? []),
            availability?.dailyLimit ?? null,
            availability?.soldOutUntil ?? null,
            // soldOutUntil only means something on an 86'd row.
            spec.soldOut || availability?.soldOutUntil
              ? "sold_out"
              : "available",
          ],
        );
      if (availability?.usedToday !== undefined)
        // Jakarta yesterday/today/tomorrow: whichever business date the
        // outlet reads as "today", the counter is the same.
        for (const day of [-1, 0, 1])
          await client.query(
            `INSERT INTO menu_item_daily_usage (id, tenant_id, outlet_id, menu_item_id, business_date, quantity)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              randomUUID(),
              tenant.tenantId,
              outletId,
              id,
              jakartaDate(day),
              availability.usedToday,
            ],
          );
      items[key] = id;
    }
  });
  return { tenant, outletId, items, names };
}

async function seedProfile(
  tenantId: string,
  status: "pending_verification" | "closed" = "pending_verification",
): Promise<string> {
  const id = randomUUID();
  await asTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO customer_profiles (id, tenant_id, user_id, name, membership_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, randomUUID(), `Member ${id.slice(0, 6)}`, status],
    ),
  );
  return id;
}

/** One completed order holding one portion of each listed item. */
async function order(
  s: Scenario,
  keys: string[],
  opts: { daysAgo?: number; member?: string } = {},
) {
  const id = randomUUID();
  counter += 1;
  const price = 10_000 * keys.length;
  const placedAt = new Date(Date.now() - (opts.daysAgo ?? 2) * 86_400_000);
  const date = placedAt.toISOString().slice(0, 10);
  await asTenant(s.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at${opts.member ? ", customer_profile_id, customer_attached_via, customer_attached_at" : ""})
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5, 'completed', $6, $7${opts.member ? ", $8, 'pwa_session', now()" : ""})`,
      [
        id,
        s.tenant.tenantId,
        s.outletId,
        `RC${counter}-${id.slice(0, 6)}`,
        price,
        date,
        placedAt.toISOString(),
        ...(opts.member ? [opts.member] : []),
      ],
    );
    for (const key of keys)
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
           unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, 'Menu', 1, 10000, 0, 10000, 'fired', 'served', $6)`,
        [randomUUID(), s.tenant.tenantId, s.outletId, id, s.items[key], date],
      );
  });
}

async function orders(s: Scenario, keys: string[], times: number, opts = {}) {
  for (let i = 0; i < times; i += 1) await order(s, keys, opts);
}

async function popular(s: Scenario, key: string, quantity: number) {
  await asTenant(s.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO menu_item_daily_usage (id, tenant_id, outlet_id, menu_item_id, business_date, quantity)
       VALUES ($1, $2, $3, $4, (now() - interval '2 days')::date, $5)`,
      [randomUUID(), s.tenant.tenantId, s.outletId, s.items[key], quantity],
    ),
  );
}

const host = (t: IsolatedTenant) => t.hostname;

function putRules(
  who: Staff,
  t: IsolatedTenant,
  outletId: string,
  body: unknown,
) {
  return who.client
    .put(`${RULES}?outletId=${outletId}`)
    .set(originHeader)
    .set("Host", host(t))
    .send(body as object);
}
function getRules(who: Staff, t: IsolatedTenant, outletId: string) {
  return who.client.get(`${RULES}?outletId=${outletId}`).set("Host", host(t));
}
function recommend(
  who: Staff,
  s: { tenant: IsolatedTenant; outletId: string },
  q: { anchors?: string[]; member?: string; at?: string; extra?: string } = {},
) {
  const parts = [`outletId=${s.outletId}`];
  for (const a of q.anchors ?? []) parts.push(`anchorItemIds[]=${a}`);
  if (q.member) parts.push(`memberId=${q.member}`);
  if (q.at) parts.push(`at=${encodeURIComponent(q.at)}`);
  if (q.extra) parts.push(q.extra);
  return who.client
    .get(`${RECS}?${parts.join("&")}`)
    .set("Host", host(s.tenant));
}

async function ok(res: { status: number; body: Json }): Promise<Json> {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return payload(res);
}

const ids = (body: Json) => (body.items as Json[]).map((i) => i.menuItemId);

/** Jakarta (UTC+7) wall clock hour today, as an ISO instant. */
function at(localHour: number, localMinute = 0): string {
  const base = new Date();
  const utc = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    localHour - 7,
    localMinute,
  );
  return new Date(utc).toISOString();
}

beforeAll(async () => {
  app = createApp();
  world = await createIsolatedTenant(`rec-${randomUUID().slice(0, 6)}`);
  foreign = await createIsolatedTenant(`rex-${randomUUID().slice(0, 6)}`);
  // admin also holds the two data permissions the old assertions rely on
  // (member history and margin); the new tests below pin what happens
  // without them.
  admin = await staffWith(world, [
    "menu.item.view",
    "menu.item.manage",
    "crm.customer.view",
    "recipe.cost.view",
  ]);
  cashier = await staffWith(world, ["menu.item.view"]);
  crmViewer = await staffWith(world, ["menu.item.view", "crm.customer.view"]);
  costViewer = await staffWith(world, ["menu.item.view", "recipe.cost.view"]);
  foreignAdmin = await staffWith(foreign, [
    "menu.item.view",
    "menu.item.manage",
  ]);
  actingUserId = admin.userId;
  void staffOfIsolatedTenant;
});

afterAll(async () => {
  await owner.end();
});

describe("AI-01 recommendation rules", () => {
  it("returns the documented defaults when nothing is saved", async () => {
    const s = await scenario(world, {});
    const body = await ok(await getRules(admin, world, s.outletId));
    expect(body).toMatchObject({
      outletId: s.outletId,
      minMarginBps: 2000,
      excludeOutOfStock: true,
      maxSuggestions: 5,
      minPairSupport: 3,
      lookbackDays: 90,
      memberHistoryEnabled: true,
      enabled: true,
      itemRules: [],
    });
  });

  it("saves a partial update, keeps the other fields, and reads it back", async () => {
    const s = await scenario(world, { A: { price: 10_000, cost: 1000 } });
    const saved = await putRules(admin, world, s.outletId, {
      minMarginBps: 3500,
      maxSuggestions: 3,
      itemRules: [
        { menuItemId: s.items.A, blocked: true, hourFrom: 9, hourTo: 17 },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const again = await putRules(admin, world, s.outletId, {
      enabled: false,
    });
    expect(again.status).toBe(200);
    const read = await ok(await getRules(admin, world, s.outletId));
    expect(read).toMatchObject({
      minMarginBps: 3500,
      maxSuggestions: 3,
      enabled: false,
      minPairSupport: 3,
      lookbackDays: 90,
    });
    expect(read.itemRules).toEqual([
      { menuItemId: s.items.A, blocked: true, hourFrom: 9, hourTo: 17 },
    ]);
  });

  it("rules of one outlet do not change another outlet of the same tenant", async () => {
    const one = await scenario(world, {});
    const two = await scenario(world, {});
    await putRules(admin, world, one.outletId, { minMarginBps: 9000 });
    const read = await ok(await getRules(admin, world, two.outletId));
    expect(read.minMarginBps).toBe(2000);
  });

  it("rejects invalid rules with 422 and stores nothing", async () => {
    const s = await scenario(world, { A: { price: 10_000, cost: 1000 } });
    const foreignItem = (await scenario(foreign, { Z: { price: 1, cost: 1 } }))
      .items.Z;
    for (const body of [
      { minMarginBps: -1 },
      { minMarginBps: 10_001 },
      { maxSuggestions: 0 },
      { maxSuggestions: 21 },
      { minPairSupport: 1 },
      { lookbackDays: 6 },
      { lookbackDays: 366 },
      { enabled: "yes" },
      { unknownField: 1 },
      { outletId: s.outletId },
      {
        itemRules: [
          { menuItemId: s.items.A, blocked: false, hourFrom: 9, hourTo: null },
        ],
      },
      {
        itemRules: [
          { menuItemId: s.items.A, blocked: false, hourFrom: 24, hourTo: 3 },
        ],
      },
      {
        itemRules: [
          {
            menuItemId: "bukan-uuid",
            blocked: false,
            hourFrom: null,
            hourTo: null,
          },
        ],
      },
    ]) {
      const res = await putRules(admin, world, s.outletId, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    // An item of another tenant cannot be ruled here (422 or 404).
    const cross = await putRules(admin, world, s.outletId, {
      itemRules: [
        {
          menuItemId: foreignItem,
          blocked: true,
          hourFrom: null,
          hourTo: null,
        },
      ],
    });
    expect([404, 422]).toContain(cross.status);
    const read = await ok(await getRules(admin, world, s.outletId));
    expect(read).toMatchObject({ minMarginBps: 2000, maxSuggestions: 5 });
    expect(read.itemRules).toEqual([]);
  });

  it("anonymous is 401; no menu permission is 403; viewer reads but cannot write", async () => {
    const s = await scenario(world, {});
    expect(
      (
        await agent(app)
          .get(`${RULES}?outletId=${s.outletId}`)
          .set("Host", host(world))
      ).status,
    ).toBe(401);
    const nobody = await staffWith(world, ["floor.table.view"]);
    expect((await getRules(nobody, world, s.outletId)).status).toBe(403);
    expect(
      (await putRules(nobody, world, s.outletId, { enabled: false })).status,
    ).toBe(403);
    expect((await recommend(nobody, s)).status).toBe(403);
    const viewer = await staffWith(world, ["menu.item.view"]);
    expect((await getRules(viewer, world, s.outletId)).status).toBe(200);
    expect((await recommend(viewer, s)).status).toBe(200);
    expect(
      (await putRules(viewer, world, s.outletId, { enabled: false })).status,
    ).toBe(403);
  });

  it("a viewer scoped to one outlet is refused on another outlet (403)", async () => {
    const mine = await scenario(world, {});
    const other = await scenario(world, {});
    const scoped = await staffWith(world, ["menu.item.view"], {
      type: "outlet",
      outletId: mine.outletId,
    });
    expect((await getRules(scoped, world, mine.outletId)).status).toBe(200);
    expect((await getRules(scoped, world, other.outletId)).status).toBe(403);
    expect((await recommend(scoped, other)).status).toBe(403);
  });
});

describe("AI-01 recommendations: pairs, margin, support", () => {
  const base: Record<string, ItemSpec> = {
    A: { price: 20_000, cost: 5000 }, // anchor
    B: { price: 20_000, cost: 8000 }, // 6000 bps
    C: { price: 20_000, cost: 8000 }, // only 2 orders: below support
    D: { price: 10_000, cost: 9000 }, // 1000 bps: below 2000
    E: { price: 20_000, cost: null }, // HPP unknown
    F: { price: 10_000, cost: 8000 }, // exactly 2000 bps
  };

  async function seedPairs() {
    const s = await scenario(world, base);
    await orders(s, ["A", "B"], 4);
    await orders(s, ["A", "C"], 2);
    await orders(s, ["A", "D"], 5);
    await orders(s, ["A", "E"], 5);
    await orders(s, ["A", "F"], 3);
    return s;
  }

  it("recommends pairs by co-occurrence, drops low margin, unknown HPP and thin pairs", async () => {
    const s = await seedPairs();
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body.source).toBe("cooccurrence");
    // B (4 orders) before F (3 orders, margin exactly at the 2000 floor).
    expect(ids(body)).toEqual([s.items.B, s.items.F]);
    expect(body.items[0]).toEqual({
      menuItemId: s.items.B,
      name: s.names.B,
      priceIdr: 20_000,
      marginBps: 6000,
      reason: "pair",
      score: expect.any(Number),
    });
    expect(body.items[0].score).toBeGreaterThanOrEqual(body.items[1].score);
    expect(body.items[1].marginBps).toBe(2000);
    for (const item of body.items)
      expect(item.marginBps).toBeGreaterThanOrEqual(2000);
  });

  it("never recommends an anchor item", async () => {
    const s = await seedPairs();
    const body = await ok(
      await recommend(admin, s, { anchors: [s.items.A, s.items.B] }),
    );
    expect(ids(body)).not.toContain(s.items.A);
    expect(ids(body)).not.toContain(s.items.B);
  });

  it("minPairSupport is enforced: lower admits thin pairs, higher drops all", async () => {
    const s = await seedPairs();
    await putRules(admin, world, s.outletId, { minPairSupport: 2 });
    let body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toContain(s.items.C);
    await putRules(admin, world, s.outletId, { minPairSupport: 5 });
    body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).not.toContain(s.items.B); // 4 orders < 5
    expect(ids(body)).not.toContain(s.items.C);
  });

  it("minMarginBps is enforced; unknown HPP is dropped even at 0", async () => {
    const s = await seedPairs();
    await putRules(admin, world, s.outletId, { minMarginBps: 7000 });
    let body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).not.toContain(s.items.B); // 6000 < 7000
    await putRules(admin, world, s.outletId, { minMarginBps: 0 });
    body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toContain(s.items.D);
    expect(ids(body)).not.toContain(s.items.E);
  });

  it("maxSuggestions caps the list, best score first", async () => {
    const s = await seedPairs();
    await putRules(admin, world, s.outletId, {
      minMarginBps: 0,
      maxSuggestions: 2,
    });
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body.items).toHaveLength(2);
    // D has 5 orders, B 4, F 3: top two are D and B.
    expect(ids(body)).toEqual([s.items.D, s.items.B]);
  });

  it("orders older than lookbackDays do not count", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 3, { daysAgo: 30 });
    let body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.B]);
    await putRules(admin, world, s.outletId, { lookbackDays: 7 });
    body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body).toEqual({ items: [], source: "none" });
  });

  it("pairs seen only in another outlet do not leak in", async () => {
    const a = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(a, ["A", "B"], 5);
    // Same tenant, other outlet, same item ids: use a second outlet clone.
    const otherOutlet = await makeOutlet(world);
    const view = { tenant: world, outletId: otherOutlet };
    const body = await ok(
      await recommend(admin, view, { anchors: [a.items.A] }),
    );
    expect(body).toEqual({ items: [], source: "none" });
  });
});

describe("AI-01 recommendations: availability, block and hour rules", () => {
  it("drops inactive and sold-out items; excludeOutOfStock=false admits sold-out", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000, soldOut: true },
      C: { price: 20_000, cost: 5000, active: false },
      D: { price: 20_000, cost: 5000 },
    });
    for (const k of ["B", "C", "D"]) await orders(s, ["A", k], 3);
    let body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.D]);
    await putRules(admin, world, s.outletId, { excludeOutOfStock: false });
    body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toContain(s.items.B);
    expect(ids(body)).not.toContain(s.items.C); // inactive stays out
  });

  it("a blocked item is never recommended", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
      C: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 4);
    await orders(s, ["A", "C"], 3);
    await putRules(admin, world, s.outletId, {
      itemRules: [
        { menuItemId: s.items.B, blocked: true, hourFrom: null, hourTo: null },
      ],
    });
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.C]);
  });

  async function windowed(from: number, to: number) {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 3);
    await putRules(admin, world, s.outletId, {
      itemRules: [
        { menuItemId: s.items.B, blocked: false, hourFrom: from, hourTo: to },
      ],
    });
    return s;
  }
  const hasB = async (s: Scenario, local: string) =>
    ids(
      await ok(await recommend(admin, s, { anchors: [s.items.A], at: local })),
    ).includes(s.items.B);

  it("hour window [from,to) uses the outlet-local hour", async () => {
    const s = await windowed(9, 11);
    expect(await hasB(s, at(10))).toBe(true);
    expect(await hasB(s, at(9, 0))).toBe(true); // from is inclusive
    expect(await hasB(s, at(11, 0))).toBe(false); // to is exclusive
    expect(await hasB(s, at(12))).toBe(false);
    expect(await hasB(s, at(3))).toBe(false);
  });

  it("hour window may cross midnight", async () => {
    const s = await windowed(22, 2);
    expect(await hasB(s, at(23, 30))).toBe(true);
    expect(await hasB(s, at(0, 30))).toBe(true);
    expect(await hasB(s, at(1, 59))).toBe(true);
    expect(await hasB(s, at(2, 0))).toBe(false);
    expect(await hasB(s, at(12))).toBe(false);
    expect(await hasB(s, at(21, 59))).toBe(false);
  });

  it("no hours set means all day", async () => {
    const s = await windowed(9, 11);
    await putRules(admin, world, s.outletId, {
      itemRules: [
        { menuItemId: s.items.B, blocked: false, hourFrom: null, hourTo: null },
      ],
    });
    expect(await hasB(s, at(3))).toBe(true);
    expect(await hasB(s, at(15))).toBe(true);
  });
});

describe("AI-01 recommendations: fallbacks and switch", () => {
  it("falls back to popular items that pass the rules when no pair exists", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      P1: { price: 20_000, cost: 5000 },
      P2: { price: 20_000, cost: 5000 },
      P3: { price: 10_000, cost: 9500 }, // 500 bps: excluded
      P4: { price: 20_000, cost: null }, // HPP unknown: excluded
    });
    await popular(s, "P1", 10);
    await popular(s, "P2", 5);
    await popular(s, "P3", 50);
    await popular(s, "P4", 40);
    await popular(s, "A", 60);
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body.source).toBe("popular_fallback");
    expect(ids(body)).toEqual([s.items.P1, s.items.P2]);
    for (const item of body.items) expect(item.reason).toBe("popular");
  });

  it("popular fallback works without anchors", async () => {
    const s = await scenario(world, { P1: { price: 20_000, cost: 5000 } });
    await popular(s, "P1", 3);
    const body = await ok(await recommend(admin, s));
    expect(body.source).toBe("popular_fallback");
    expect(ids(body)).toEqual([s.items.P1]);
  });

  it("returns { items: [], source: 'none' } when nothing qualifies", async () => {
    const s = await scenario(world, { A: { price: 20_000, cost: 5000 } });
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body).toEqual({ items: [], source: "none" });
  });

  it("enabled=false returns none even when pairs exist", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 5);
    await popular(s, "B", 9);
    await putRules(admin, world, s.outletId, { enabled: false });
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body).toEqual({ items: [], source: "none" });
  });
});

describe("AI-01 recommendations: member history and privacy", () => {
  it("adds what this member ordered here; other members' history never shows", async () => {
    const s = await scenario(world, {
      H: { price: 20_000, cost: 5000 }, // member's favourite
      Q: { price: 20_000, cost: 5000 }, // someone else's favourite
      L: { price: 10_000, cost: 9500 }, // member ordered it, margin too low
    });
    const mine = await seedProfile(world.tenantId);
    const other = await seedProfile(world.tenantId);
    await orders(s, ["H"], 2, { member: mine });
    await orders(s, ["L"], 2, { member: mine });
    await orders(s, ["Q"], 2, { member: other });
    const res = await recommend(admin, s, { member: mine });
    const body = await ok(res);
    expect(body.source).toBe("member_history");
    expect(ids(body)).toEqual([s.items.H]);
    expect(body.items[0].reason).toBe("member_history");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(other);
    expect(text).not.toContain(s.items.Q);
  });

  it("member history off: the member's orders are ignored", async () => {
    const s = await scenario(world, { H: { price: 20_000, cost: 5000 } });
    const mine = await seedProfile(world.tenantId);
    await orders(s, ["H"], 2, { member: mine });
    await putRules(admin, world, s.outletId, { memberHistoryEnabled: false });
    const body = await ok(await recommend(admin, s, { member: mine }));
    expect(body).toEqual({ items: [], source: "none" });
  });

  it("a member of another tenant is refused or ignored, never used", async () => {
    const s = await scenario(world, { H: { price: 20_000, cost: 5000 } });
    const stranger = await seedProfile(foreign.tenantId);
    // Baseline: the endpoint itself works for this outlet (not a missing route).
    await ok(await recommend(admin, s));
    const res = await recommend(admin, s, { member: stranger });
    expect([200, 403, 404, 422]).toContain(res.status);
    if (res.status === 200) {
      const body = payload(res);
      expect(body).toEqual({ items: [], source: "none" });
    }
  });

  it("the response carries only the documented item fields, no member data", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    const member = await seedProfile(world.tenantId);
    await orders(s, ["A", "B"], 3, { member });
    const res = await recommend(admin, s, { anchors: [s.items.A] });
    const body = await ok(res);
    expect(Object.keys(body).sort()).toEqual(["items", "source"]);
    for (const item of body.items)
      expect(Object.keys(item).sort()).toEqual([
        "marginBps",
        "menuItemId",
        "name",
        "priceIdr",
        "reason",
        "score",
      ]);
    expect(JSON.stringify(res.body)).not.toContain(member);
  });

  it("a recommendation is only a suggestion: prices and orders stay untouched", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 3);
    const snapshot = () =>
      asTenant(world.tenantId, async (client) => ({
        prices: (
          await client.query(
            `SELECT i.item_id, i.price_idr FROM price_list_items i
               JOIN price_lists l ON l.id = i.price_list_id AND l.tenant_id = i.tenant_id
              WHERE l.outlet_id = $1 ORDER BY i.item_id`,
            [s.outletId],
          )
        ).rows,
        orders: (
          await client.query(
            `SELECT id, total_idr, discount_idr FROM orders WHERE outlet_id = $1 ORDER BY id`,
            [s.outletId],
          )
        ).rows,
      }));
    const before = await snapshot();
    await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(await snapshot()).toEqual(before);
  });
});

describe("AI-01 recommendations: input validation and isolation", () => {
  it("rejects bad queries with 422", async () => {
    const s = await scenario(world, { A: { price: 20_000, cost: 5000 } });
    const eleven = Array.from({ length: 11 }, () => randomUUID());
    for (const extra of [
      "memberId=bukan-uuid",
      "anchorItemIds[]=bukan-uuid",
      "at=kemarin",
      "unknown=1",
      ...[eleven.map((i) => `anchorItemIds[]=${i}`).join("&")],
    ]) {
      const res = await recommend(admin, s, { extra });
      expect(res.status, extra).toBe(422);
    }
    const noOutlet = await admin.client.get(RECS).set("Host", host(world));
    expect(noOutlet.status).toBe(422);
  });

  it("anonymous gets 401", async () => {
    const s = await scenario(world, {});
    const res = await agent(app)
      .get(`${RECS}?outletId=${s.outletId}`)
      .set("Host", host(world));
    expect(res.status).toBe(401);
  });

  it("another tenant cannot read or write this outlet's rules or recommendations", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 3);
    await putRules(admin, world, s.outletId, { minMarginBps: 4321 });
    for (const res of [
      await getRules(foreignAdmin, foreign, s.outletId),
      await putRules(foreignAdmin, foreign, s.outletId, { enabled: false }),
      await recommend(
        foreignAdmin,
        { tenant: foreign, outletId: s.outletId },
        {
          anchors: [s.items.A],
        },
      ),
      // right credentials, wrong host: tenant of the host decides
      await getRules(admin, foreign, s.outletId),
    ])
      expect([401, 403, 404]).toContain(res.status);
    const read = await ok(await getRules(admin, world, s.outletId));
    expect(read.minMarginBps).toBe(4321);
    expect(read.enabled).toBe(true);
  });

  it("an anchor item of another tenant never pulls its data in", async () => {
    const mine = await scenario(world, { B: { price: 20_000, cost: 5000 } });
    const theirs = await scenario(foreign, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
    });
    await orders(theirs, ["A", "B"], 5);
    await ok(await recommend(admin, mine)); // baseline: endpoint exists
    const res = await recommend(admin, mine, { anchors: [theirs.items.A] });
    expect([200, 404, 422]).toContain(res.status);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(theirs.items.B);
    if (res.status === 200)
      expect(payload(res)).toEqual({ items: [], source: "none" });
  });
});

// ---------------------------------------------------------------------------
// Review round 1 (architect): privacy of member history and margin, real HPP,
// tax-inclusive margin, real availability, popular support.
// ---------------------------------------------------------------------------

const sorted = (list: string[]) => [...list].sort();

/** Outlet whose menu prices include `rateBp` tax (published settings + rule). */
async function includeTax(s: Scenario, rateBp = 1000) {
  await asTenant(s.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, $3, 'discount_service_tax', true, 'half_up', 'half_up', 'down', NULL,
               'fixed_bp', 1, '2020-01-01', 'published', now(), $4)`,
      [randomUUID(), s.tenant.tenantId, s.outletId, actingUserId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, $3, $4, 'PBJT inklusif', 'pbjt', $5, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               true, false, true, 1, '2020-01-01', 'published', now(), $6)`,
      [
        randomUUID(),
        s.tenant.tenantId,
        s.outletId,
        `PBJT-${randomUUID().slice(0, 6)}`,
        rateBp,
        actingUserId,
      ],
    );
  });
}

describe("AI-01 member history needs customer view permission", () => {
  async function memberWorld() {
    const s = await scenario(world, {
      H: { price: 20_000, cost: 5000 }, // member's favourite
      P: { price: 20_000, cost: 5000 }, // popular here
    });
    await popular(s, "P", 9);
    const member = await seedProfile(world.tenantId);
    await orders(s, ["H"], 2, { member });
    return { s, member };
  }

  it("cashier (menu.item.view only) with memberId: history ignored, same result as without", async () => {
    const { s, member } = await memberWorld();
    const without = await ok(await recommend(cashier, s));
    const withMember = await ok(await recommend(cashier, s, { member }));
    expect(ids(without)).toEqual([s.items.P]);
    expect(withMember).toEqual(without);
    expect((withMember.items as Json[]).map((i) => i.reason)).not.toContain(
      "member_history",
    );
    expect(ids(withMember)).not.toContain(s.items.H);
  });

  it("cashier with memberId and nothing else to show gets none, not an error", async () => {
    const s = await scenario(world, { H: { price: 20_000, cost: 5000 } });
    const member = await seedProfile(world.tenantId);
    await orders(s, ["H"], 2, { member });
    const body = await ok(await recommend(cashier, s, { member }));
    expect(body).toEqual({ items: [], source: "none" });
  });

  it("a role with crm.customer.view uses the member's history", async () => {
    const { s, member } = await memberWorld();
    const body = await ok(await recommend(crmViewer, s, { member }));
    const mine = (body.items as Json[]).find((i) => i.menuItemId === s.items.H);
    expect(mine, JSON.stringify(body)).toBeDefined();
    expect(mine!.reason).toBe("member_history");
  });

  it("a closed member is ignored even for a role with crm.customer.view", async () => {
    const s = await scenario(world, {
      H: { price: 20_000, cost: 5000 },
      P: { price: 20_000, cost: 5000 },
    });
    await popular(s, "P", 9);
    const member = await seedProfile(world.tenantId, "closed");
    await orders(s, ["H"], 2, { member });
    const without = await ok(await recommend(crmViewer, s));
    const body = await ok(await recommend(crmViewer, s, { member }));
    expect(body).toEqual(without);
    expect(ids(body)).not.toContain(s.items.H);
    expect((body.items as Json[]).map((i) => i.reason)).not.toContain(
      "member_history",
    );
  });
});

describe("AI-01 score is a rank, not a count", () => {
  it("scores are n..1 in list order, not order counts", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
      C: { price: 20_000, cost: 5000 },
      D: { price: 20_000, cost: 5000 },
    });
    await orders(s, ["A", "B"], 7);
    await orders(s, ["A", "C"], 5);
    await orders(s, ["A", "D"], 3);
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.B, s.items.C, s.items.D]);
    // Raw counts would be 7, 5, 3.
    expect((body.items as Json[]).map((i) => i.score)).toEqual([3, 2, 1]);
  });

  it("the popular list is ranked the same way, not by quantity sold", async () => {
    const s = await scenario(world, {
      P1: { price: 20_000, cost: 5000 },
      P2: { price: 20_000, cost: 5000 },
    });
    await popular(s, "P1", 40);
    await popular(s, "P2", 11);
    const body = await ok(await recommend(admin, s));
    expect(ids(body)).toEqual([s.items.P1, s.items.P2]);
    expect((body.items as Json[]).map((i) => i.score)).toEqual([2, 1]);
  });
});

describe("AI-01 margin is only shown with recipe.cost.view", () => {
  async function pairWorld() {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 8000 },
      D: { price: 10_000, cost: 9000 }, // below the margin floor
    });
    await orders(s, ["A", "B"], 4);
    await orders(s, ["A", "D"], 4);
    return s;
  }

  it("without recipe.cost.view marginBps is null, but the margin floor still filters", async () => {
    const s = await pairWorld();
    for (const who of [cashier, crmViewer]) {
      const body = await ok(await recommend(who, s, { anchors: [s.items.A] }));
      expect(ids(body)).toEqual([s.items.B]); // D (1000 bps) is still dropped
      expect(body.items[0].marginBps).toBeNull();
      expect(body.items[0]).toMatchObject({
        menuItemId: s.items.B,
        priceIdr: 20_000,
        reason: "pair",
      });
    }
  });

  it("with recipe.cost.view marginBps carries the number", async () => {
    const s = await pairWorld();
    for (const who of [costViewer, admin]) {
      const body = await ok(await recommend(who, s, { anchors: [s.items.A] }));
      expect(ids(body)).toEqual([s.items.B]);
      expect(body.items[0].marginBps).toBe(6000);
    }
  });

  it("popular items hide the margin the same way", async () => {
    const s = await scenario(world, { P1: { price: 20_000, cost: 5000 } });
    await popular(s, "P1", 5);
    const hidden = await ok(await recommend(cashier, s));
    expect(hidden.items[0].marginBps).toBeNull();
    const shown = await ok(await recommend(costViewer, s));
    expect(shown.items[0].marginBps).toBe(7500);
  });
});

describe("AI-01 HPP comes from the real recipe cost", () => {
  it("margin uses recipe lines x ingredient cost per portion, not recipes.theoretical_cost_idr", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      // real cost 8000 (margin 6000); the decoy column claims 19000.
      B: { price: 20_000, cost: 8000, decoy: 19_000 },
      // real cost 19000 (margin 500, below floor); the decoy claims 1000.
      D: { price: 20_000, cost: 19_000, decoy: 1000 },
    });
    await orders(s, ["A", "B"], 4);
    await orders(s, ["A", "D"], 4);
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.B]);
    expect(body.items[0].marginBps).toBe(6000);
  });

  it("a recipe whose ingredient has no cost, or no recipe at all, is dropped even with a decoy cost", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      B: { price: 20_000, cost: 5000 },
      NoCost: { price: 20_000, cost: null, costless: true, decoy: 1000 },
      NoRecipe: { price: 20_000, cost: null },
    });
    await putRules(admin, world, s.outletId, { minMarginBps: 0 });
    await orders(s, ["A", "B"], 4);
    await orders(s, ["A", "NoCost"], 5);
    await orders(s, ["A", "NoRecipe"], 5);
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.B]);
  });

  it("popular items are costed the same way", async () => {
    const s = await scenario(world, {
      P1: { price: 20_000, cost: 5000 },
      P2: { price: 20_000, cost: 19_000, decoy: 0 }, // real margin 500
      P3: { price: 20_000, cost: null, costless: true, decoy: 0 },
    });
    await popular(s, "P1", 5);
    await popular(s, "P2", 9);
    await popular(s, "P3", 9);
    const body = await ok(await recommend(admin, s));
    expect(ids(body)).toEqual([s.items.P1]);
    expect(body.items[0].marginBps).toBe(7500);
  });
});

describe("AI-01 margin on tax-inclusive prices uses the net price", () => {
  it("11.000 incl. 10% tax with HPP 8.000 is 20% margin, so a 25% floor drops it", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      X: { price: 11_000, cost: 8000 },
    });
    await includeTax(s);
    await orders(s, ["A", "X"], 3);
    let body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.X]); // default floor 2000: exactly at it
    expect(body.items[0].marginBps).toBe(2000); // not 2727
    await putRules(admin, world, s.outletId, { minMarginBps: 2500 });
    body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(body).toEqual({ items: [], source: "none" });
  });

  it("the same prices without tax inclusion keep the gross margin (control)", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      X: { price: 11_000, cost: 8000 },
    });
    await orders(s, ["A", "X"], 3);
    await putRules(admin, world, s.outletId, { minMarginBps: 2500 });
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.X]);
    expect(body.items[0].marginBps).toBe(2727);
  });

  it("the net price is rounded down: 10.950 incl. 10% is 9.954 net", async () => {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      Y: { price: 10_950, cost: 7960 },
    });
    await includeTax(s);
    await orders(s, ["A", "Y"], 3);
    const body = await ok(await recommend(admin, s, { anchors: [s.items.A] }));
    expect(ids(body)).toEqual([s.items.Y]);
    // (9954 - 7960) / 9954 = 20.03%; a half-up net of 9955 would give 2004.
    expect(body.items[0].marginBps).toBe(2003);
  });

  it("popular items use the net price too", async () => {
    const s = await scenario(world, { X: { price: 11_000, cost: 8000 } });
    await includeTax(s);
    await popular(s, "X", 5);
    await putRules(admin, world, s.outletId, { minMarginBps: 2500 });
    const body = await ok(await recommend(admin, s));
    expect(body).toEqual({ items: [], source: "none" });
  });
});

describe("AI-01 availability follows the menu rules", () => {
  const ALL_DAY = [
    { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
  ];
  /** A half hour window twelve hours away from the current Jakarta hour. */
  function farWindow() {
    const hour = (new Date(Date.now() + 7 * 3_600_000).getUTCHours() + 12) % 24;
    const pad = (n: number) => String(n).padStart(2, "0");
    return [
      {
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        start: `${pad(hour)}:00`,
        end: `${pad(hour)}:30`,
      },
    ];
  }
  const inFuture = () => new Date(Date.now() + 3 * 3_600_000).toISOString();
  const inPast = () => new Date(Date.now() - 3 * 3_600_000).toISOString();

  async function pairsOf(specs: Record<string, ItemSpec>) {
    const s = await scenario(world, {
      A: { price: 20_000, cost: 5000 },
      ...specs,
    });
    for (const key of Object.keys(specs)) await orders(s, ["A", key], 3);
    return s;
  }
  const recs = async (s: Scenario) =>
    ids(await ok(await recommend(admin, s, { anchors: [s.items.A] })));

  it("an item outside its menu schedule is dropped; one inside it stays", async () => {
    const s = await pairsOf({
      Out: {
        price: 20_000,
        cost: 5000,
        availability: { schedule: farWindow() },
      },
      In: { price: 20_000, cost: 5000, availability: { schedule: ALL_DAY } },
    });
    expect(await recs(s)).toEqual([s.items.In]);
  });

  it("an item whose daily limit is used up today is dropped; one with room stays", async () => {
    const s = await pairsOf({
      Full: {
        price: 20_000,
        cost: 5000,
        availability: { dailyLimit: 5, usedToday: 5 },
      },
      Room: {
        price: 20_000,
        cost: 5000,
        availability: { dailyLimit: 5, usedToday: 4 },
      },
    });
    expect(await recs(s)).toEqual([s.items.Room]);
  });

  it("an item sold out until a later time is dropped; once that time passed it is back", async () => {
    const s = await pairsOf({
      Later: {
        price: 20_000,
        cost: 5000,
        availability: { soldOutUntil: inFuture() },
      },
      Back: {
        price: 20_000,
        cost: 5000,
        availability: { soldOutUntil: inPast() },
      },
    });
    expect(await recs(s)).toEqual([s.items.Back]);
  });

  it("all three at once leave only the sellable item", async () => {
    const s = await pairsOf({
      Out: {
        price: 20_000,
        cost: 5000,
        availability: { schedule: farWindow() },
      },
      Full: {
        price: 20_000,
        cost: 5000,
        availability: { dailyLimit: 2, usedToday: 3 },
      },
      Later: {
        price: 20_000,
        cost: 5000,
        availability: { soldOutUntil: inFuture() },
      },
      Ok: { price: 20_000, cost: 5000 },
    });
    expect(sorted(await recs(s))).toEqual([s.items.Ok]);
  });
});

describe("AI-01 popular list respects minPairSupport", () => {
  async function popularWorld() {
    const s = await scenario(world, {
      P1: { price: 20_000, cost: 5000 },
      P2: { price: 20_000, cost: 5000 },
      P3: { price: 20_000, cost: 5000 },
    });
    await popular(s, "P1", 2); // below the default support of 3
    await popular(s, "P2", 3); // exactly at it
    await popular(s, "P3", 10);
    return s;
  }

  it("an item with fewer orders than minPairSupport is dropped", async () => {
    const s = await popularWorld();
    const body = await ok(await recommend(admin, s));
    expect(body.source).toBe("popular_fallback");
    expect(ids(body)).toEqual([s.items.P3, s.items.P2]);
  });

  it("the threshold follows the rule: lower admits thin items, higher drops more", async () => {
    const s = await popularWorld();
    await putRules(admin, world, s.outletId, { minPairSupport: 2 });
    expect(ids(await ok(await recommend(admin, s)))).toEqual([
      s.items.P3,
      s.items.P2,
      s.items.P1,
    ]);
    await putRules(admin, world, s.outletId, { minPairSupport: 5 });
    expect(ids(await ok(await recommend(admin, s)))).toEqual([s.items.P3]);
    await putRules(admin, world, s.outletId, { minPairSupport: 11 });
    expect(await ok(await recommend(admin, s))).toEqual({
      items: [],
      source: "none",
    });
  });
});
