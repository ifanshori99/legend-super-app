// HPP and closed outlets (bead legend-wa9k9). Decision: HPP work skips outlets
// with `outlets.status = 'closed'`, and reopening a closed outlet marks it
// HPP-stale, so a cost is never left older than the data it was built from
// ("jangan sampai rugi").
//
// Written from the decision of the card, in the style of
// hpp-recompute-fixes.test.ts:
// (a) `markHppStale` (services/hpp-invalidate.ts) marks closed outlets too (it
//     takes the state row lock, so a race with a reopening cannot lose a
//     change), as well as active and preopening ones;
// (b) the job tick (`runHppRecomputeJob` -> rebuild of stale outlets) leaves a
//     closed outlet alone, stale or never backfilled, and still rebuilds the
//     active ones;
// (c) recipe coverage (GET /api/inventory/recipe-coverage) does not count a
//     closed outlet: a menu item complete in every non-closed outlet is
//     "complete";
// (d) `restoreOutlet` (platform-org.service.ts) marks the reopened outlet stale
//     and one tick then shows data that changed while it was closed.
//
// Assumptions where the card is silent:
// - "Stale" is `hpp_outlet_state.stale_at IS NOT NULL`.
// - The incremental queue (`hpp_recompute_queue`) is not under test: tests
//   empty it for the closed outlet before the tick, so only the stale/never
//   backfilled rebuild path decides.
// - A closed outlet keeps the `menu_costs` rows it had when it closed; the
//   rule is "skip", not "delete".
// - `closed_at` = now and `status_before_close` = 'active' make an outlet
//   closed (the same columns restoreOutlet reads); the close itself is set by
//   an owner-pool UPDATE because the close flow is not under test.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  brandIdSchema,
  decimal4,
  outletIdSchema,
  tenantIdSchema,
  type BrandId,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { restoreOutletInputSchema } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { markHppStale } from "../services/hpp-invalidate.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { rebuildMenuCostsForOutlet } from "../services/hpp-recompute.service.ts";
import { restoreOutlet } from "../services/platform-org.service.ts";
import { runHppRecomputeJob } from "../worker/hpp-recompute.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const slugA = `hco${randomUUID().slice(0, 8)}`;
const host = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const short = () => randomUUID().slice(0, 6);

let ownerUserId: string;
let editor: ReturnType<typeof agent>;
let gramId: string;
let cupId: string;

/** Typed brand id: the helpers below take it, never a bare string. */
const asBrandId = (id: string): BrandId => brandIdSchema.parse(id);

type Brand = { id: BrandId; categoryId: string };
let defaultBrand: Brand;

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantA),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

// ------------------------------------------------------------ owner fixtures

/** Owner-side access sets the tenant local: RLS is FORCED on these tables. */
async function ownerTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantA],
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

async function q<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return ownerTx(async (client) => (await client.query<T>(sql, params)).rows);
}

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const rows = await q<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantA,
      `tenant-${slugA}`,
      `Tenant ${slugA}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify({
        ...(fixtures.tenant.limits as Record<string, unknown>),
        maxOutlets: 1000,
      }),
    ],
  );
  await q(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandA, tenantA, `brand-${slugA}`, `Brand ${slugA}`],
  );
  await q(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
}

/** Removes every row a tenant owns (the stock ledger is append-only), then it. */
async function purgeTenant(tenantId: string) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A brand of its own: coverage counts every outlet of a brand, so a test that
 * reads coverage needs a brand whose outlets it fully controls. */
async function newBrand(): Promise<Brand> {
  const id = randomUUID();
  await q(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [id, tenantA, `brand-${short()}`, `Brand ${short()}`],
  );
  const categoryId = randomUUID();
  await q(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Closed', 0)",
    [categoryId, tenantA, id],
  );
  return { id: asBrandId(id), categoryId };
}

type OutletStatus = "active" | "preopening" | "closed";
type Outlet = { id: string; location: string; brand: Brand };

async function setClosed(outletId: string) {
  await q(
    `UPDATE outlets SET status = 'closed', closed_at = now(), status_before_close = 'active'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantA, outletId],
  );
}

/** A fresh outlet with its own sale location, configured as the sale location. */
async function newOutlet(
  status: OutletStatus = "active",
  brand: Brand = defaultBrand,
): Promise<Outlet> {
  const id = randomUUID();
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, $8)`,
    [
      id,
      tenantA,
      brand.id,
      legalEntityA,
      `C${randomUUID().slice(0, 10)}`.toUpperCase(),
      `Outlet HCO ${short()}`,
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0]!.openingHours),
      // A closed outlet starts active so it can be stocked; closed afterwards.
      status === "closed" ? "active" : status,
    ],
  );
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, id, `Bar HCO ${short()}`],
  );
  await q(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)`,
    [tenantA, id, location],
  );
  if (status === "closed") await setClosed(id);
  return { id, location, brand };
}

async function insertItem(name: string, baseUomId: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, baseUomId],
  );
}

/** A goods receipt through the real service; it moves the average cost. */
async function receive(
  outlet: Outlet,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outlet.id) as OutletId,
    locationId: outlet.location,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  } as never);
}

async function insertRecipe(
  brand: Brand,
  name: string,
  lines: { id: string; qty: string; uom: string }[],
): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, '1.0000', $4, true, $5) RETURNING id`,
    [tenantA, brand.id, `${name} ${short()}`, cupId, ownerUserId],
  );
  for (const [index, line] of lines.entries())
    await q(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenantA, recipeId, index, line.id, line.qty, line.uom],
    );
  return recipeId;
}

async function insertMenuItem(
  brand: Brand,
  name: string,
  recipeId: string,
): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantA, brand.id, brand.categoryId, `${name} ${short()}`, recipeId],
  );
}

/**
 * A menu item of the outlet's brand: 18 g beans at Rp100 = Rp1.800 per cup,
 * stock received into the outlet. `editTo36g` makes it Rp3.600.
 */
async function buildKit(outlet: Outlet) {
  const beans = await insertItem("Biji Kopi", gramId);
  await receive(outlet, beans, "1000.0000", "100.0000");
  const recipe = await insertRecipe(outlet.brand, "Kopi", [
    { id: beans, qty: "18.0000", uom: gramId },
  ]);
  const menuItem = await insertMenuItem(outlet.brand, "Kopi", recipe);
  return { beans, recipe, menuItem };
}

/** Changes the recipe behind the kit (18 g -> 36 g: Rp1.800 -> Rp3.600). */
async function editTo36g(kit: { recipe: string; beans: string }) {
  await q(
    `UPDATE recipe_lines SET quantity = '36.0000'
      WHERE tenant_id = $1 AND recipe_id = $2 AND component_id = $3`,
    [tenantA, kit.recipe, kit.beans],
  );
}

// ------------------------------------------------------------------- readers

async function costRows(outlet: Outlet, menuItemId: string) {
  return q<{ cost: string | null; recipe_complete: boolean }>(
    `SELECT theoretical_cost_idr::text AS cost, recipe_complete
       FROM menu_costs
      WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3`,
    [tenantA, outlet.id, menuItemId],
  );
}

async function costOf(outlet: Outlet, menuItemId: string): Promise<string> {
  const rows = await costRows(outlet, menuItemId);
  expect(rows, "one menu_costs row for the menu item").toHaveLength(1);
  return rows[0]!.cost!;
}

/** `stale_at` of the outlet: null when it has no state row or is not stale. */
async function staleAt(outlet: Outlet): Promise<string | null> {
  const rows = await q<{ stale_at: string | null }>(
    `SELECT stale_at::text FROM hpp_outlet_state
      WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenantA, outlet.id],
  );
  return rows[0]?.stale_at ?? null;
}

async function clearState(outlet: Outlet) {
  await q(
    "DELETE FROM hpp_outlet_state WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantA, outlet.id],
  );
}

/** The state of an outlet whose data changed after its last rebuild. */
async function forceStale(outlet: Outlet) {
  await q(
    `INSERT INTO hpp_outlet_state (tenant_id, outlet_id, stale_at)
     VALUES ($1, $2, now())
     ON CONFLICT (tenant_id, outlet_id) DO UPDATE SET stale_at = now()`,
    [tenantA, outlet.id],
  );
}

async function clearQueue(outlet: Outlet) {
  await q(
    "DELETE FROM hpp_recompute_queue WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantA, outlet.id],
  );
}

/** Full first fill, then an empty queue: the state before a change. */
async function baseline(outlet: Outlet) {
  await rebuildMenuCostsForOutlet(
    tenantContext(),
    outletIdSchema.parse(outlet.id),
  );
  await clearQueue(outlet);
}

async function tick() {
  // `force` skips the 60 s per-tenant throttle (not under test here).
  await runHppRecomputeJob(tenantContext(), new Date(), { force: true });
}

async function mark(input: { brandId?: BrandId; outletId?: string }) {
  await withTenant(db, tenantContext(), (tx) =>
    markHppStale(tx, { tenantId: tenantIdSchema.parse(tenantA), ...input }),
  );
}

type CoverageRow = {
  menuItemId: string;
  variantId: string | null;
  status: string;
  theoreticalCostIdr: string | null;
};

async function coverageOf(brand: Brand, menuItemId: string) {
  const response = await editor
    .get(`/api/inventory/recipe-coverage?brandId=${brand.id}&limit=100`)
    .set(originHeader);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const rows = response.body.data as CoverageRow[];
  const row = rows.find(
    (candidate) =>
      candidate.menuItemId === menuItemId && candidate.variantId === null,
  );
  expect(row, "coverage row of the menu item").toBeDefined();
  return row!;
}

// --------------------------------------------------------------------- setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP Closed Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  cupId = await uom("cup");
  const categoryId = randomUUID();
  await q(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Closed', 0)",
    [categoryId, tenantA, brandA],
  );
  defaultBrand = { id: asBrandId(brandA), categoryId };

  // A tenant owner who reads coverage and edits recipes over HTTP.
  await q(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, host],
  );
  const template = ROLE_TEMPLATES.find((t) => t.key === "owner")!;
  const roleId = randomUUID();
  await q(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
    [
      roleId,
      tenantA,
      template.defaultName,
      template.key,
      JSON.stringify(template.permissions),
      template.mfaRequired,
      JSON.stringify(template.allowedScopeTypes),
    ],
  );
  editor = agent(createApp());
  await signUp(editor, "HPP Closed Editor");
  const session = await editor.get("/api/auth/get-session");
  const editorUserId = session.body.user.id as string;
  editor.set("Host", host);
  await q(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantA, editorUserId, roleId],
  );
});

afterAll(async () => {
  await purgeTenant(tenantA);
  await owner.end();
});

// ===========================================================================

describe("HPP-CLOSED-OUTLETS-A markHppStale marks closed outlets too", () => {
  it("HPP-CLOSED-OUTLETS-A-brand a brand-wide mark stales the active, the preopening and the closed outlet", async () => {
    const brand = await newBrand();
    const active = await newOutlet("active", brand);
    const preopening = await newOutlet("preopening", brand);
    const closed = await newOutlet("closed", brand);
    for (const outlet of [active, preopening, closed]) await clearState(outlet);

    await mark({ brandId: brand.id });

    expect(await staleAt(active), "active outlet is stale").not.toBeNull();
    expect(
      await staleAt(preopening),
      "preopening outlet is stale",
    ).not.toBeNull();
    expect(await staleAt(closed), "closed outlet is stale").not.toBeNull();
  });

  it("HPP-CLOSED-OUTLETS-A-outlet marking one closed outlet by id marks it, marking an active one by id works", async () => {
    const brand = await newBrand();
    const active = await newOutlet("active", brand);
    const closed = await newOutlet("closed", brand);
    for (const outlet of [active, closed]) await clearState(outlet);

    await mark({ outletId: closed.id });
    expect(await staleAt(closed), "closed outlet is stale").not.toBeNull();

    await mark({ outletId: active.id });
    expect(await staleAt(active), "active outlet is stale").not.toBeNull();
  });

  it("HPP-CLOSED-OUTLETS-A-tenant a tenant-wide mark (no brand, no outlet) marks the closed outlet too", async () => {
    const brand = await newBrand();
    const active = await newOutlet("active", brand);
    const closed = await newOutlet("closed", brand);
    for (const outlet of [active, closed]) await clearState(outlet);

    await mark({});

    expect(await staleAt(active), "active outlet is stale").not.toBeNull();
    expect(await staleAt(closed), "closed outlet is stale").not.toBeNull();
  });
});

describe("HPP-CLOSED-OUTLETS-B the job tick skips closed outlets", () => {
  it("HPP-CLOSED-OUTLETS-B-stale a stale closed outlet keeps its old cost and stays stale while the stale active outlet is rebuilt", async () => {
    const active = await newOutlet();
    const closed = await newOutlet();
    const kitActive = await buildKit(active);
    const kitClosed = await buildKit(closed);
    await baseline(active);
    await baseline(closed);
    expect(await costOf(active, kitActive.menuItem)).toBe("1800.0000");
    expect(await costOf(closed, kitClosed.menuItem)).toBe("1800.0000");

    await editTo36g(kitActive);
    await editTo36g(kitClosed);
    await forceStale(active);
    await forceStale(closed);
    await setClosed(closed.id);
    await clearQueue(closed);

    await tick();

    // Active: rebuilt. 36 x 100 = 3.600.
    expect(await costOf(active, kitActive.menuItem)).toBe("3600.0000");
    expect(await staleAt(active), "active outlet no longer stale").toBeNull();
    // Closed: untouched, still waiting for its reopening.
    expect(await costOf(closed, kitClosed.menuItem)).toBe("1800.0000");
    expect(
      await staleAt(closed),
      "closed outlet is still stale",
    ).not.toBeNull();
  });

  it("HPP-CLOSED-OUTLETS-B-never-backfilled a closed outlet without state row gets no menu_costs, the active one without state row is filled", async () => {
    const active = await newOutlet();
    const closed = await newOutlet();
    const kitActive = await buildKit(active);
    const kitClosed = await buildKit(closed);
    for (const outlet of [active, closed]) {
      await clearState(outlet);
      await clearQueue(outlet);
    }
    await setClosed(closed.id);

    await tick();

    expect(await costOf(active, kitActive.menuItem)).toBe("1800.0000");
    expect(
      await costRows(closed, kitClosed.menuItem),
      "no menu_costs row for the closed outlet",
    ).toEqual([]);
  });
});

describe("HPP-CLOSED-OUTLETS-C recipe coverage does not count closed outlets", () => {
  it("HPP-CLOSED-OUTLETS-C-complete a menu item complete in every non-closed outlet is complete although a closed outlet has no cost row", async () => {
    const brand = await newBrand();
    const active = await newOutlet("active", brand);
    const closed = await newOutlet("closed", brand);
    const kit = await buildKit(active);
    await baseline(active);
    expect(await costRows(closed, kit.menuItem)).toEqual([]);

    expect(await coverageOf(brand, kit.menuItem)).toMatchObject({
      status: "complete",
      theoreticalCostIdr: "1800.0000",
    });
  });

  it("HPP-CLOSED-OUTLETS-C-control an active outlet without cost row still makes the menu item incomplete (the closed rule is not 'always complete')", async () => {
    const brand = await newBrand();
    const active = await newOutlet("active", brand);
    await newOutlet("active", brand); // no cost row here
    const kit = await buildKit(active);
    await baseline(active);

    expect(await coverageOf(brand, kit.menuItem)).toMatchObject({
      status: "incomplete",
    });
  });
});

describe("HPP-CLOSED-OUTLETS-D reopening a closed outlet marks it HPP-stale", () => {
  const reason = "Outlet dibuka kembali setelah tutup sementara.";

  function reopen(outlet: Outlet) {
    return restoreOutlet(
      tenantA,
      outlet.id,
      restoreOutletInputSchema.parse({ reason }),
      ownerUserId,
    );
  }

  it("HPP-CLOSED-OUTLETS-D-stale restoring a closed outlet that was up to date marks it stale", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    expect(await staleAt(outlet), "up to date before closing").toBeNull();
    await setClosed(outlet.id);

    const restored = await reopen(outlet);

    expect(restored.status).toBe("active");
    expect(await staleAt(outlet), "stale after reopening").not.toBeNull();
    expect(await costOf(outlet, kit.menuItem)).toBe("1800.0000");
  });

  it("HPP-CLOSED-OUTLETS-D-edit-while-closed a recipe edited while the outlet was closed shows its new cost after reopening and one tick", async () => {
    const outlet = await newOutlet();
    const beans = await insertItem("Biji Kopi", gramId);
    await receive(outlet, beans, "1000.0000", "100.0000");
    const created = await editor
      .post("/api/inventory/recipes")
      .set(originHeader)
      .send({
        brandId: outlet.brand.id,
        name: `Kopi Tutup ${short()}`,
        outputItemId: null,
        yieldQuantity: "1.0000",
        yieldUomId: cupId,
        lines: [
          {
            componentType: "item",
            componentId: beans,
            quantity: "18.0000",
            uomId: gramId,
            wastePctBp: 0,
          },
        ],
        idempotencyKey: `recipe-${randomUUID()}`,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recipeId = created.body.data.recipe.id as string;
    const menuItem = await insertMenuItem(outlet.brand, "Kopi Tutup", recipeId);
    await baseline(outlet);
    expect(await costOf(outlet, menuItem)).toBe("1800.0000");
    await setClosed(outlet.id);

    const edited = await editor
      .post(`/api/inventory/recipes/${recipeId}/versions`)
      .set(originHeader)
      .send({
        lines: [
          {
            componentType: "item",
            componentId: beans,
            quantity: "36.0000",
            uomId: gramId,
            wastePctBp: 0,
          },
        ],
        changeNote: "Ubah resep saat outlet tutup",
        idempotencyKey: `recipe-version-${randomUUID()}`,
      });
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300);
    // The edit marks the closed outlet stale (A). Clear it so only the
    // reopening can make the outlet stale: no stale mark, no queue.
    await q(
      "UPDATE hpp_outlet_state SET stale_at = NULL WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantA, outlet.id],
    );
    await clearQueue(outlet);

    await reopen(outlet);
    await tick();

    // 36 x 100 = 3.600: the reopened outlet is never left at the old Rp1.800.
    expect(await costOf(outlet, menuItem)).toBe("3600.0000");
    expect(await staleAt(outlet), "rebuilt, no longer stale").toBeNull();
  });
});
