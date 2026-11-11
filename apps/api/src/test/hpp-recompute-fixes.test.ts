// HPP recompute fixes (bead legend-2qq; findings 1, 2, 3 and 5 of the review;
// cards legend-husxd, legend-i8ou8). Rule "jangan sampai rugi": a menu cost is
// never left at an older, lower value than the data it was built from, and no
// queued change is ever lost.
//
// Written from the design (scratchpad hpp-fix-design.md), not the code:
// - Finding 1: every write of `menu_costs` of an outlet (incremental batch and
//   full rebuild) takes the row lock of `hpp_outlet_state` for that outlet
//   BEFORE it reads costs/prices/recipes. So an older result can never
//   overwrite a newer one. Proven by holding that row lock in another
//   transaction, committing a data change while the recompute waits, and
//   checking that the final cost reflects the change.
// - Finding 2: an outlet without state row (never backfilled) or with
//   `stale_at` set gets a full rebuild in the job tick, whatever the queue
//   holds.
// - Finding 3: every write path that changes a `menu_costs` input marks the
//   outlet(s) stale in the same transaction (`markHppStale` in
//   services/hpp-invalidate.ts); ONE job tick then shows the new cost.
// - Finding 5: queue rows are claimed with a lease (`lease_until`, `attempts`);
//   compute + write + ack share one transaction; the ack only deletes the row
//   the worker claimed (`enqueued_at` unchanged).
//
// Assumptions where the design is silent:
// - Same names and signatures as hpp-recompute.test.ts (`enqueueHppRecompute`,
//   `rebuildMenuCostsForOutlet`, `runHppRecomputeJob(context, now, {force})`).
// - Menu writes go through the real HTTP routes (tenant owner, host header)
//   where a route exists; variants and outlets through the real services
//   `updateVariant` and `createOutlet` (permission is checked from the actor id).
// - `hpp_outlet_state` columns: tenant_id, outlet_id, stale_at, rebuilt_at.
//   `hpp_recompute_queue` gets lease_until (timestamptz NULL) and attempts.
// - A failing tick may reject or resolve (failures are logged); tests only
//   check the persistent state afterwards.
// - A poison row (attempts >= 5) is handled within two ticks: the outlet is
//   fully rebuilt and the row leaves the queue.
// - Where the lock is missing (current code: no `hpp_outlet_state` table) the
//   lock helper degrades to a plain transaction, so the finding 1 tests fail
//   on the wrong final cost instead of on a missing table.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  decimal4,
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { markHppStale } from "../services/hpp-invalidate.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { updateVariant } from "../services/menu.service.ts";
import { createOutlet } from "../services/org.service.ts";
import {
  enqueueHppRecompute,
  rebuildMenuCostsForOutlet,
} from "../services/hpp-recompute.service.ts";
import { runHppRecomputeJob } from "../worker/hpp-recompute.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const slugA = `hpf${randomUUID().slice(0, 8)}`;
const host = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});
const short = () => randomUUID().slice(0, 6);

let ownerUserId: string;
let editorUserId: string;
let editor: ReturnType<typeof agent>;
let gramId: string;
let mlId: string;
let cupId: string;
let portionId: string;
let categoryId: string;

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
async function ownerTx<T>(
  run: (client: PoolClient) => Promise<T>,
  tenantId: string = tenantA,
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
      // The test creates many outlets; the plan limit is not under test.
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

type Outlet = { id: string; location: string };

/** A fresh outlet with its own sale location, configured as the sale location. */
async function newOutlet(): Promise<Outlet> {
  const id = randomUUID();
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      id,
      tenantA,
      brandA,
      legalEntityA,
      `H${randomUUID().slice(0, 10)}`.toUpperCase(),
      `Outlet HPF ${short()}`,
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0]!.openingHours),
    ],
  );
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, id, `Bar HPF ${short()}`],
  );
  await q(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)`,
    [tenantA, id, location],
  );
  return { id, location };
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

type RecipeLineSeed = { id: string; qty: string; uom: string };

async function insertRecipe(input: {
  name: string;
  yieldUomId: string;
  lines: RecipeLineSeed[];
}): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, '1.0000', $4, true, $5) RETURNING id`,
    [
      tenantA,
      brandA,
      `${input.name} ${short()}`,
      input.yieldUomId,
      ownerUserId,
    ],
  );
  for (const [index, line] of input.lines.entries())
    await q(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenantA, recipeId, index, line.id, line.qty, line.uom],
    );
  return recipeId;
}

async function insertMenuItem(
  name: string,
  recipeId: string | null,
): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantA, brandA, categoryId, `${name} ${short()}`, recipeId],
  );
}

async function insertVariant(
  menuItemId: string,
  name: string,
  recipeId: string | null,
): Promise<string> {
  return one<string>(
    "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, menuItemId, `${name} ${short()}`, recipeId],
  );
}

/** A dine_in price list of the outlet with one price; returns the list id. */
async function setPrice(
  outlet: Outlet,
  menuItemId: string,
  priceIdr: number,
): Promise<string> {
  const listId = randomUUID();
  await q(
    `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
     VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
    [listId, tenantA, outlet.id],
  );
  await q(
    `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), tenantA, listId, menuItemId, priceIdr],
  );
  return listId;
}

/**
 * A Latte (18 g beans at Rp100 + 200 ml milk at Rp20 = Rp5.800 per cup) with
 * its stock received into the outlet's sale location.
 */
async function buildKit(outlet: Outlet) {
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(outlet, beans, "1000.0000", "100.0000");
  await receive(outlet, milk, "10000.0000", "20.0000");
  const recipe = await insertRecipe({
    name: "Latte",
    yieldUomId: cupId,
    lines: [
      { id: beans, qty: "18.0000", uom: gramId },
      { id: milk, qty: "200.0000", uom: mlId },
    ],
  });
  const menuItem = await insertMenuItem("Latte", recipe);
  return { beans, milk, recipe, menuItem };
}

/** A recipe of the kit's beans only: 18 g x Rp100 = Rp1.800. */
async function beansOnlyRecipe(kit: { beans: string }): Promise<string> {
  return insertRecipe({
    name: "Latte Kecil",
    yieldUomId: cupId,
    lines: [{ id: kit.beans, qty: "18.0000", uom: gramId }],
  });
}

// ------------------------------------------------------------------- readers

type CostRow = {
  menu_item_id: string;
  variant_id: string | null;
  recipe_id: string | null;
  recipe_complete: boolean;
  cost: string | null;
  price: string;
  gross_margin_bp: number | null;
};

const costColumns = `menu_item_id::text, variant_id::text, recipe_id::text, recipe_complete,
            theoretical_cost_idr::text AS cost, price_idr::text AS price, gross_margin_bp`;

async function costRows(
  outlet: Outlet,
  menuItemId: string,
): Promise<CostRow[]> {
  return q<CostRow>(
    `SELECT ${costColumns}
       FROM menu_costs
      WHERE tenant_id = $1 AND outlet_id = $2 AND menu_item_id = $3
      ORDER BY variant_id NULLS FIRST`,
    [tenantA, outlet.id, menuItemId],
  );
}

/** The one row of the menu item itself (no variant, no modifier). */
async function costOf(outlet: Outlet, menuItemId: string): Promise<CostRow> {
  const rows = (await costRows(outlet, menuItemId)).filter(
    (row) => row.variant_id === null,
  );
  expect(rows, "one menu_costs row for the menu item").toHaveLength(1);
  return rows[0]!;
}

async function costOfVariant(
  outlet: Outlet,
  menuItemId: string,
  variantId: string,
): Promise<CostRow> {
  const rows = (await costRows(outlet, menuItemId)).filter(
    (row) => row.variant_id === variantId,
  );
  expect(rows, "one menu_costs row for the variant").toHaveLength(1);
  return rows[0]!;
}

async function costOfModifier(
  outlet: Outlet,
  modifierId: string,
): Promise<CostRow> {
  const rows = await q<CostRow>(
    `SELECT ${costColumns}
       FROM menu_costs
      WHERE tenant_id = $1 AND outlet_id = $2 AND modifier_id = $3`,
    [tenantA, outlet.id, modifierId],
  );
  expect(rows, "one menu_costs row for the modifier").toHaveLength(1);
  return rows[0]!;
}

async function queueOf(outlet: Outlet): Promise<string[]> {
  const rows = await q<{ item_id: string }>(
    "SELECT item_id::text FROM hpp_recompute_queue WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY item_id",
    [tenantA, outlet.id],
  );
  return rows.map((row) => row.item_id);
}

type QueueRow = {
  lease_until: string | null;
  attempts: number;
  enqueued_at: string;
};

async function queueRow(outlet: Outlet, itemId: string): Promise<QueueRow> {
  const rows = await q<QueueRow>(
    `SELECT lease_until::text, attempts, enqueued_at::text
       FROM hpp_recompute_queue
      WHERE tenant_id = $1 AND outlet_id = $2 AND item_id = $3`,
    [tenantA, outlet.id, itemId],
  );
  expect(rows, "the queue row of the item").toHaveLength(1);
  return rows[0]!;
}

async function clearQueue(outlet: Outlet) {
  await q(
    "DELETE FROM hpp_recompute_queue WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantA, outlet.id],
  );
}

async function enqueue(outlet: Outlet, itemIds: string[]) {
  await withTenant(db, tenantContext(), (tx) =>
    enqueueHppRecompute(tx, {
      tenantId: tenantIdSchema.parse(tenantA),
      outletId: outletIdSchema.parse(outlet.id),
      itemIds,
    } as never),
  );
}

/** Full first fill, then an empty queue: the state before an incremental change. */
async function baseline(outlet: Outlet) {
  await rebuildMenuCostsForOutlet(
    tenantContext(),
    outletIdSchema.parse(outlet.id),
  );
  await clearQueue(outlet);
}

async function tick() {
  // `force` skips the 60 s per-tenant throttle so back-to-back ticks in one
  // test all run (the throttle itself is not under test here).
  await runHppRecomputeJob(tenantContext(), new Date(), { force: true });
}

async function expireLease(outlet: Outlet) {
  await q(
    `UPDATE hpp_recompute_queue SET lease_until = now() - interval '1 minute'
      WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenantA, outlet.id],
  );
}

// ------------------------------------------------------ lock and wait helpers

/** Polls until `check` is true or the deadline passes; returns the last result. */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

/** True while some backend waits on a lock held by backend `pid`. */
async function blockedBy(pid: number): Promise<boolean> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
    [pid],
  );
  return rows[0]!.n > 0;
}

/**
 * An open owner transaction that holds the `hpp_outlet_state` row lock of the
 * outlet (the lock every menu_costs writer must take first). Data statements
 * run through `exec` stay uncommitted until `commit`. `finish` always ends the
 * transaction and releases the connection.
 */
async function holdOutletLock(outlet: Outlet) {
  const client = await owner.connect();
  let open = true;
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantA],
  );
  const pid = (
    await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
  ).rows[0]!.pid;
  await client.query("SAVEPOINT take_lock");
  try {
    await client.query(
      `INSERT INTO hpp_outlet_state (tenant_id, outlet_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [tenantA, outlet.id],
    );
    await client.query(
      `SELECT 1 FROM hpp_outlet_state WHERE tenant_id = $1 AND outlet_id = $2 FOR UPDATE`,
      [tenantA, outlet.id],
    );
  } catch (error) {
    // 42P01 undefined_table: the code under test has no state table yet.
    if ((error as { code?: string }).code !== "42P01") throw error;
    await client.query("ROLLBACK TO SAVEPOINT take_lock");
  }
  return {
    pid,
    exec: (sql: string, params: unknown[] = []) => client.query(sql, params),
    async commit() {
      if (!open) return;
      open = false;
      await client.query("COMMIT");
    },
    async finish() {
      if (open) {
        open = false;
        await client.query("ROLLBACK").catch(() => undefined);
      }
      client.release();
    },
  };
}

// --------------------------------------------------------------------- setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP Fixes Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  portionId = await uom("porsi");
  categoryId = randomUUID();
  await q(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Fix', 0)",
    [categoryId, tenantA, brandA],
  );

  // A tenant owner who edits menus, prices and settings over HTTP.
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
  await signUp(editor, "HPP Fixes Editor");
  const session = await editor.get("/api/auth/get-session");
  editorUserId = session.body.user.id as string;
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

describe("HPP-RECOMPUTE-FIX-1 an older recompute never overwrites a newer one", () => {
  it("HPP-RECOMPUTE-FIX-1-rebuild a full rebuild waits for the outlet lock and then shows data committed meanwhile", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    expect((await costOf(outlet, kit.menuItem)).cost).toBe("5800.0000");

    const lock = await holdOutletLock(outlet);
    let rebuild: Promise<unknown> = Promise.resolve();
    try {
      rebuild = rebuildMenuCostsForOutlet(
        tenantContext(),
        outletIdSchema.parse(outlet.id),
      );
      // The rebuild is now either waiting for the lock (correct) or already
      // done with the old data (the bug): bounded wait, then change the data.
      await waitFor(() => blockedBy(lock.pid));
      await lock.exec(
        `UPDATE recipe_lines SET quantity = '36.0000'
          WHERE tenant_id = $1 AND recipe_id = $2 AND component_id = $3`,
        [tenantA, kit.recipe, kit.beans],
      );
      await lock.commit();
    } finally {
      await lock.finish();
      await rebuild.catch(() => undefined);
    }
    await rebuild;

    // 36 x 100 + 200 x 20 = 7.600: the newer data won, not the older read.
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "7600.0000",
    });
  });

  it("HPP-RECOMPUTE-FIX-1-incremental an incremental batch waits for the outlet lock and then shows data committed meanwhile", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200

    const lock = await holdOutletLock(outlet);
    let running: Promise<unknown> = Promise.resolve();
    try {
      running = tick();
      await waitFor(() => blockedBy(lock.pid));
      await lock.exec(
        `UPDATE recipe_lines SET quantity = '36.0000'
          WHERE tenant_id = $1 AND recipe_id = $2 AND component_id = $3`,
        [tenantA, kit.recipe, kit.beans],
      );
      await lock.commit();
    } finally {
      await lock.finish();
      await running.catch(() => undefined);
    }
    await running;

    // 36 x 200 + 200 x 20 = 11.200
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "11200.0000",
    });
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-FIX-1-overlap overlapping ticks and rebuilds end on the newest cost with one row per menu item", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200

    await Promise.all([
      tick(),
      tick(),
      rebuildMenuCostsForOutlet(
        tenantContext(),
        outletIdSchema.parse(outlet.id),
      ),
    ]);
    await tick();

    const rows = await costRows(outlet, kit.menuItem);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cost: "7600.0000", recipe_complete: true });
    expect(await queueOf(outlet)).toEqual([]);
  });
});

describe("HPP-RECOMPUTE-FIX-2 an outlet that was never backfilled is fully filled whatever the queue holds", () => {
  it("HPP-RECOMPUTE-FIX-2-first-fill-queue the queue holds one item of menu A: menus B and C of the outlet are still filled in the same tick", async () => {
    const outlet = await newOutlet();
    const kitA = await buildKit(outlet);
    const kitB = await buildKit(outlet);
    const kitC = await buildKit(outlet);
    await clearQueue(outlet);
    await enqueue(outlet, [kitA.beans]); // only menu A's item is queued
    expect(await costRows(outlet, kitB.menuItem)).toEqual([]);

    await tick();

    for (const kit of [kitA, kitB, kitC])
      expect(await costOf(outlet, kit.menuItem)).toMatchObject({
        recipe_id: kit.recipe,
        recipe_complete: true,
        cost: "5800.0000",
      });
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-FIX-2-two-outlets two never-backfilled outlets are both filled by one tick although only one of them has a queued item", async () => {
    const first = await newOutlet();
    const second = await newOutlet();
    const kitFirst = await buildKit(first);
    const kitSecond = await buildKit(second);
    await clearQueue(first);
    await clearQueue(second);
    await enqueue(first, [kitFirst.milk]);

    await tick();

    expect((await costOf(first, kitFirst.menuItem)).cost).toBe("5800.0000");
    expect((await costOf(second, kitSecond.menuItem)).cost).toBe("5800.0000");
    // The other outlet's menu is not mixed in: its kit is tenant-wide, but the
    // cost is computed from that outlet's own stock.
    expect(await queueOf(first)).toEqual([]);
    expect(await queueOf(second)).toEqual([]);
  });
});

describe("HPP-RECOMPUTE-FIX-3 every change of a cost input shows in menu_costs after one tick", () => {
  it("HPP-RECOMPUTE-FIX-3-menu-item changing the recipe link of a menu item (menu.service updateItem) is reflected after one tick", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    const smaller = await beansOnlyRecipe(kit);
    await baseline(outlet);
    expect((await costOf(outlet, kit.menuItem)).cost).toBe("5800.0000");

    const response = await editor
      .patch(`/api/menu/items/${kit.menuItem}`)
      .set(originHeader)
      .send({ recipeId: smaller });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await tick();

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_id: smaller,
      recipe_complete: true,
      cost: "1800.0000",
    });
  });

  it("HPP-RECOMPUTE-FIX-3-variant changing the recipe link of a variant (menu.service updateVariant) is reflected after one tick", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    const large = await insertRecipe({
      name: "Latte Large",
      yieldUomId: cupId,
      lines: [
        { id: kit.beans, qty: "18.0000", uom: gramId },
        { id: kit.milk, qty: "300.0000", uom: mlId },
      ],
    });
    const smaller = await beansOnlyRecipe(kit);
    const variantId = await insertVariant(kit.menuItem, "Large", large);
    await baseline(outlet);
    // 18 x 100 + 300 x 20 = 7.800
    expect((await costOfVariant(outlet, kit.menuItem, variantId)).cost).toBe(
      "7800.0000",
    );

    await updateVariant(tenantContext(), editorUserId, variantId, {
      recipeId: smaller,
    });
    await tick();

    expect(await costOfVariant(outlet, kit.menuItem, variantId)).toMatchObject({
      recipe_id: smaller,
      recipe_complete: true,
      cost: "1800.0000",
    });
  });

  it("HPP-RECOMPUTE-FIX-3-modifier changing the recipe link of a modifier (menu.service updateModifier) is reflected after one tick", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    const extra = await insertItem("Sirup Tambahan", mlId);
    await receive(outlet, extra, "1000.0000", "50.0000");
    const groupId = await one<string>(
      "INSERT INTO modifier_groups (tenant_id, name, min_select, max_select) VALUES ($1, $2, 0, 5) RETURNING id",
      [tenantA, `Tambahan ${short()}`],
    );
    // 10 ml x Rp50 = Rp500 now; 100 ml of the kit's milk x Rp20 = Rp2.000 later.
    const first = await insertRecipe({
      name: "Resep Tambahan",
      yieldUomId: portionId,
      lines: [{ id: extra, qty: "10.0000", uom: mlId }],
    });
    const second = await insertRecipe({
      name: "Resep Tambahan Susu",
      yieldUomId: portionId,
      lines: [{ id: kit.milk, qty: "100.0000", uom: mlId }],
    });
    const modifierId = await one<string>(
      "INSERT INTO modifiers (tenant_id, group_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [tenantA, groupId, `Tambah ${short()}`, first],
    );
    await q(
      `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [tenantA, kit.menuItem, groupId],
    );
    await baseline(outlet);
    expect((await costOfModifier(outlet, modifierId)).cost).toBe("500.0000");

    const response = await editor
      .patch(`/api/menu/modifiers/${modifierId}`)
      .set(originHeader)
      .send({ recipeId: second });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await tick();

    expect(await costOfModifier(outlet, modifierId)).toMatchObject({
      recipe_id: second,
      recipe_complete: true,
      cost: "2000.0000",
    });
  });

  it("HPP-RECOMPUTE-FIX-3-price-list changing prices of a price list (menu-pricing setPriceListItems) moves price and margin after one tick", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    const listId = await setPrice(outlet, kit.menuItem, 25_000);
    await baseline(outlet);
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      price: "25000",
      gross_margin_bp: 7_680,
    });

    const response = await editor
      .put(`/api/menu/price-lists/${listId}/items`)
      .set(originHeader)
      .send({
        items: [{ itemId: kit.menuItem, variantId: null, priceIdr: 29_000 }],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    await tick();

    // (29.000 - 5.800) x 10.000 / 29.000 = 8.000 bp
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      price: "29000",
      cost: "5800.0000",
      gross_margin_bp: 8_000,
    });
  });

  it("HPP-RECOMPUTE-FIX-3-sale-location changing the sale location of the outlet deduction settings re-costs the menu from that location after one tick", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    // A second location with dearer beans: 18 x 500 + 200 x 20 = 13.000.
    const other = await one<string>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
      [tenantA, outlet.id, `Gudang HPF ${short()}`],
    );
    await receive(
      { id: outlet.id, location: other },
      kit.beans,
      "1000.0000",
      "500.0000",
    );
    await receive(
      { id: outlet.id, location: other },
      kit.milk,
      "10000.0000",
      "20.0000",
    );
    await baseline(outlet);
    expect((await costOf(outlet, kit.menuItem)).cost).toBe("5800.0000");

    const response = await editor
      .put(`/api/inventory/outlets/${outlet.id}/deduction-settings`)
      .set(originHeader)
      .send({ recipeDeductionMode: "real_time", saleLocationId: other });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await tick();

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "13000.0000",
    });
  });

  it("HPP-RECOMPUTE-FIX-3-new-outlet a new outlet (org.service createOutlet) has menu_costs rows after one tick even when the queue is busy", async () => {
    // Another outlet keeps the tenant's queue non-empty.
    const busy = await newOutlet();
    const kit = await buildKit(busy);
    await baseline(busy);
    await enqueue(busy, [kit.beans]);

    const created = await createOutlet(
      tenantContext(),
      {
        brandId: brandA,
        legalEntityId: legalEntityA,
        code: `HP${randomUUID().slice(0, 8)}`.toUpperCase(),
        name: `Outlet Baru ${short()}`,
        address: "Jl. Baru 1",
        regionId: null,
        geofence: null,
        timeZone: "Asia/Jakarta",
        businessDayCutoff: "04:00",
        openingHours: cafeLegendPlatformFixtures.outlets[0]!.openingHours,
      } as never,
      editorUserId,
    );
    // Assumption: the job only costs outlets that trade; a new outlet starts as
    // "preopening", so it is opened here before the tick.
    await q(
      "UPDATE outlets SET status = 'active' WHERE tenant_id = $1 AND id = $2",
      [tenantA, created.id],
    );
    const fresh: Outlet = { id: created.id, location: "" };
    expect(await costRows(fresh, kit.menuItem)).toEqual([]);

    await tick();

    // The new outlet has no stock, so the cost is unknown (never 0), but the
    // menu item is listed with its recipe.
    expect(await costOf(fresh, kit.menuItem)).toMatchObject({
      recipe_id: kit.recipe,
      recipe_complete: false,
      cost: null,
    });
  });
});

describe("HPP-RECOMPUTE-FIX-5 leased claim: a queued change is never lost", () => {
  it("HPP-RECOMPUTE-FIX-5-lease a row claimed by a dead worker survives and is reprocessed once its lease expired", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200
    expect(await queueOf(outlet)).toEqual([kit.beans]);
    // The worker claimed the row (lease set, attempt counted), then died.
    await q(
      `UPDATE hpp_recompute_queue SET lease_until = now() + interval '10 minutes', attempts = 1
        WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenantA, outlet.id],
    );

    await tick();
    // Under a live lease nobody else works on the row, and it is not dropped.
    expect(await queueOf(outlet)).toEqual([kit.beans]);
    expect((await costOf(outlet, kit.menuItem)).cost).toBe("5800.0000");

    await expireLease(outlet);
    await tick();

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "7600.0000",
    });
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-FIX-5-failure a failed compute leaves the item queued with an attempt counted, and a later tick completes it", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200

    // Every write of menu_costs of this outlet fails until the trigger is gone.
    const name = `hpp_fail_${short()}`;
    await owner.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'hpp test boom'; END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON menu_costs
         FOR EACH ROW WHEN (NEW.outlet_id = '${outlet.id}')
         EXECUTE FUNCTION ${name}()`,
    );
    try {
      await tick().catch(() => undefined);
      expect(await queueOf(outlet)).toEqual([kit.beans]);
      expect(
        (await queueRow(outlet, kit.beans)).attempts,
      ).toBeGreaterThanOrEqual(1);
      expect((await costOf(outlet, kit.menuItem)).cost).toBe("5800.0000");
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${name} ON menu_costs`);
      await owner.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }

    await expireLease(outlet);
    await tick();

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "7600.0000",
    });
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-FIX-5-reenqueue queueing an item again during its lease releases the lease so the change is picked up", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200
    await q(
      `UPDATE hpp_recompute_queue SET lease_until = now() + interval '10 minutes', attempts = 1
        WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenantA, outlet.id],
    );
    const before = await queueRow(outlet, kit.beans);

    await enqueue(outlet, [kit.beans]);

    const after = await queueRow(outlet, kit.beans);
    expect(after.lease_until).toBeNull();
    const [later] = await q<{ later: boolean }>(
      "SELECT $1::timestamptz > $2::timestamptz AS later",
      [after.enqueued_at, before.enqueued_at],
    );
    expect(later!.later, "enqueued_at moved forward").toBe(true);

    await tick();
    expect((await costOf(outlet, kit.menuItem)).cost).toBe("7600.0000");
    expect(await queueOf(outlet)).toEqual([]);
  });

  it("HPP-RECOMPUTE-FIX-5-reenqueue-race an item queued again while a worker computes it stays queued and is processed by the next tick", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200

    const lock = await holdOutletLock(outlet);
    let running: Promise<unknown> = Promise.resolve();
    try {
      running = tick();
      // The worker has claimed the row (lease set) and is computing, waiting
      // on the outlet lock held above.
      const claimed = await waitFor(async () => {
        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM hpp_recompute_queue
            WHERE tenant_id = $1 AND outlet_id = $2 AND lease_until IS NOT NULL`,
          [tenantA, outlet.id],
        );
        return rows[0]!.n > 0;
      });
      expect(claimed, "the worker claimed the row").toBe(true);

      await enqueue(outlet, [kit.beans]); // a newer change arrives mid-compute
      await lock.commit();
    } finally {
      await lock.finish();
      await running.catch(() => undefined);
    }
    await running;

    // The ack of the first worker must not delete the newer queue row.
    expect(await queueOf(outlet)).toEqual([kit.beans]);
    expect((await queueRow(outlet, kit.beans)).lease_until).toBeNull();

    await tick();
    expect(await queueOf(outlet)).toEqual([]);
    expect((await costOf(outlet, kit.menuItem)).cost).toBe("7600.0000");
  });

  it("HPP-RECOMPUTE-FIX-5-poison a row that failed 5 times does not loop forever: the outlet is rebuilt and the row leaves the queue within two ticks", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200
    await q(
      `UPDATE hpp_recompute_queue SET lease_until = now() - interval '1 minute', attempts = 5
        WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenantA, outlet.id],
    );

    await tick();
    await tick();

    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "7600.0000",
    });
    expect(await queueOf(outlet)).toEqual([]);
  });
});

// ===========================================================================
// Review round 2 (bead legend-2qq): A1 ack deadlock, A2 attempts reset,
// A3 outlet-scoped actor marks the whole brand stale, B3 future price lists.
//
// Assumptions where the design is silent:
// - A1: the stock transaction is simulated by a second owner connection that
//   row-locks the queue rows (ordered by item_id, as a stock upsert does) and
//   re-queues them without committing. The worker's ack must SKIP rows it
//   cannot lock (they were re-queued, so they must survive); it must never
//   wait for them. "Waiting" is detected with a bounded race, not a sleep.
// - A2: "treated as poison" is observed on `hpp_outlet_state`: a poison row
//   makes the outlet stale/rebuilt (design: stale_at set or rebuilt_at moved).
// - A3: `markHppStale` runs in a transaction whose outlets-scoped context
//   (outlet RLS: app.outlet_ids limited to ONE of the brand's outlets) cannot
//   see the other outlets; the whole menu write path is not exercised because
//   a scoped actor is refused by `assertOutletInScope` before it gets there.
// - B3: the price list effective date is a calendar date; "tomorrow" and the
//   moved clock are taken in the outlet time zone (Asia/Jakarta, no DST) and
//   the clock is set to noon of that day so UTC and local date agree.
// ===========================================================================

/** Calendar date (YYYY-MM-DD) in Asia/Jakarta, `days` after today. */
function jakartaDate(days: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
  }).format(new Date(Date.now() + days * 86_400_000));
}

type OutletState = { stale_at: string | null; rebuilt_at: string | null };

async function outletState(outlet: Outlet): Promise<OutletState | undefined> {
  const rows = await q<OutletState>(
    `SELECT stale_at::text, rebuilt_at::text FROM hpp_outlet_state
      WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenantA, outlet.id],
  );
  return rows[0];
}

/**
 * Second connection standing in for a stock transaction: row-locks the queue
 * rows of the items (sorted) and re-queues them, uncommitted.
 */
async function holdRequeue(outlet: Outlet, itemIds: string[]) {
  const client = await owner.connect();
  let open = true;
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantA],
  );
  await client.query(
    `SELECT item_id FROM hpp_recompute_queue
      WHERE tenant_id = $1 AND outlet_id = $2 AND item_id::text = ANY($3::text[])
      ORDER BY item_id FOR UPDATE`,
    [tenantA, outlet.id, itemIds],
  );
  await client.query(
    `UPDATE hpp_recompute_queue
        SET enqueued_at = clock_timestamp(), lease_until = NULL, attempts = 0
      WHERE tenant_id = $1 AND outlet_id = $2 AND item_id::text = ANY($3::text[])`,
    [tenantA, outlet.id, itemIds],
  );
  return {
    async commit() {
      if (!open) return;
      open = false;
      await client.query("COMMIT");
    },
    async finish() {
      if (open) {
        open = false;
        await client.query("ROLLBACK").catch(() => undefined);
      }
      client.release();
    },
  };
}

describe("HPP-RECOMPUTE-FIX-A1 the worker ack never waits on queue rows a stock transaction holds", () => {
  it("HPP-RECOMPUTE-FIX-A1-ack-skips-locked ack of 2 items while a stock transaction holds and re-queues both: no wait, no deadlock, re-queued items survive", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // beans avg 200
    await receive(outlet, kit.milk, "10000.0000", "40.0000"); // milk avg 30
    const both = [kit.beans, kit.milk].sort();
    expect(await queueOf(outlet)).toEqual(both);

    const lock = await holdOutletLock(outlet);
    let stock: Awaited<ReturnType<typeof holdRequeue>> | undefined;
    let running: Promise<unknown> = Promise.resolve();
    let outcome: unknown = "not started";
    try {
      running = tick();
      // The worker has claimed both rows and computes (waits on the outlet lock).
      const claimed = await waitFor(async () => {
        const rows = await q<{ n: number }>(
          `SELECT count(*)::int AS n FROM hpp_recompute_queue
            WHERE tenant_id = $1 AND outlet_id = $2 AND lease_until IS NOT NULL`,
          [tenantA, outlet.id],
        );
        return rows[0]!.n === 2;
      });
      expect(claimed, "the worker claimed both rows").toBe(true);

      // A stock transaction re-queues the same 2 items and is still open.
      stock = await holdRequeue(outlet, both);
      await lock.commit(); // the worker now computes, writes and acks

      outcome = await Promise.race([
        running.then(
          () => "done",
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 10_000)),
      ]);
    } finally {
      await stock?.commit().catch(() => undefined);
      await stock?.finish();
      await lock.finish();
      await running.catch(() => undefined);
    }

    expect(
      outcome,
      "the ack waited for rows locked by a stock transaction instead of skipping them",
    ).not.toBe("waiting");
    if (outcome instanceof Error)
      expect(outcome.message).not.toMatch(/deadlock/i);

    // The re-queued items were not deleted by the older worker's ack.
    expect(await queueOf(outlet)).toEqual(both);
    for (const itemId of both)
      expect((await queueRow(outlet, itemId)).lease_until).toBeNull();

    await tick();
    expect(await queueOf(outlet)).toEqual([]);
    // 18 x 200 + 200 x 30 = 9.600
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "9600.0000",
    });
  });
});

describe("HPP-RECOMPUTE-FIX-A2 re-queueing during a lease resets the attempt count", () => {
  it("HPP-RECOMPUTE-FIX-A2-attempts-reset an item re-queued 6 times while leased is processed normally, not as a poison row", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await baseline(outlet);
    const before = await outletState(outlet);
    expect(before?.rebuilt_at, "baseline rebuilt the outlet").toBeTruthy();
    await receive(outlet, kit.beans, "1000.0000", "300.0000"); // avg 200

    for (let round = 1; round <= 6; round += 1) {
      // A worker claims the row (lease set, attempt counted) ...
      await q(
        `UPDATE hpp_recompute_queue SET lease_until = now() + interval '10 minutes', attempts = attempts + 1
          WHERE tenant_id = $1 AND outlet_id = $2 AND item_id = $3`,
        [tenantA, outlet.id, kit.beans],
      );
      // ... and a newer change arrives: the item starts over.
      await enqueue(outlet, [kit.beans]);
      const row = await queueRow(outlet, kit.beans);
      expect(row.attempts, `attempts after re-queue ${round}`).toBe(0);
      expect(row.lease_until).toBeNull();
    }

    await tick();

    // Normal incremental processing: the cost is current, the queue is empty,
    // and the outlet was NOT fully rebuilt/marked stale as a poison reaction.
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      recipe_complete: true,
      cost: "7600.0000",
    });
    expect(await queueOf(outlet)).toEqual([]);
    const after = await outletState(outlet);
    expect(after?.stale_at).toBeNull();
    expect(after?.rebuilt_at).toBe(before!.rebuilt_at);
  });
});

describe("HPP-RECOMPUTE-FIX-A3 an outlet-scoped actor still marks every outlet of the brand stale", () => {
  it("HPP-RECOMPUTE-FIX-A3-scoped-actor markHppStale under a context limited to one outlet marks BOTH outlets of the brand stale without throwing", async () => {
    const first = await newOutlet();
    const second = await newOutlet();
    for (const outlet of [first, second]) {
      await rebuildMenuCostsForOutlet(
        tenantContext(),
        outletIdSchema.parse(outlet.id),
      );
      expect((await outletState(outlet))?.stale_at).toBeNull();
    }

    const limited = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantA),
        brandId: null,
        source: "domain",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(first.id)] },
    );
    // Outlet RLS limits this transaction to `first`: the second outlet is
    // invisible to a plain write, so only the SECURITY DEFINER function can
    // mark it.
    await withTenant(db, limited, (tx) =>
      markHppStale(tx, {
        tenantId: tenantIdSchema.parse(tenantA),
        brandId: brandA,
      }),
    );

    // Verified as owner (no RLS filter on what the scoped actor could see).
    for (const outlet of [first, second])
      expect((await outletState(outlet))?.stale_at).not.toBeNull();
  });
});

describe("HPP-RECOMPUTE-FIX-B3 a price list that starts tomorrow takes effect when the clock gets there", () => {
  it("HPP-RECOMPUTE-FIX-B3-future-price-list price and margin follow a dine_in price list with effective_from tomorrow once one tick runs with the clock moved, with no other write", async () => {
    const outlet = await newOutlet();
    const kit = await buildKit(outlet);
    await setPrice(outlet, kit.menuItem, 25_000); // effective since 2026-01-01
    const futureList = randomUUID();
    await q(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', $4)`,
      [futureList, tenantA, outlet.id, jakartaDate(1)],
    );
    await q(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 29000)`,
      [randomUUID(), tenantA, futureList, kit.menuItem],
    );

    await rebuildMenuCostsForOutlet(
      tenantContext(),
      outletIdSchema.parse(outlet.id),
    );
    await clearQueue(outlet);
    // Today the old price still holds (the future list is not effective yet).
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      price: "25000",
      gross_margin_bp: 7_680,
    });
    await tick();
    expect((await costOf(outlet, kit.menuItem)).price).toBe("25000");

    // The clock reaches the effective date; nothing is written meanwhile.
    const tomorrowNoon = new Date(`${jakartaDate(1)}T12:00:00+07:00`);
    await runHppRecomputeJob(tenantContext(), tomorrowNoon, { force: true });

    // (29.000 - 5.800) x 10.000 / 29.000 = 8.000 bp
    expect(await costOf(outlet, kit.menuItem)).toMatchObject({
      price: "29000",
      cost: "5800.0000",
      gross_margin_bp: 8_000,
    });
  });
});
