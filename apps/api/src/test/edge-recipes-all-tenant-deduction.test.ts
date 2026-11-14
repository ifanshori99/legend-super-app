// End to end ON THE EDGE after recipes of every brand reach it (bead
// legend-2uqcd). Written from the brief and the shared contracts, modelled on
// recipe-line-location-routing.test.ts (INV-02 deduction, HPP) and
// recipe-deduction-repost.test.ts (legend-q55i re-post), not from the
// implementation.
//
//  (d) an item of brand B sold with a modifier whose recipe belongs to brand A:
//      the item's own recipe AND the modifier's recipe are both deducted, and
//      the HPP is filled (item + modifier cost).
//  (e) the modifier's recipe is not on the edge yet: the deduction is skipped
//      (nothing posted); once the recipe is synced, re-posting deducts exactly
//      once and a second re-post changes nothing.
//
// Databases: the GLOBAL database of this file (`db`) is the EDGE (migrated in
// edge mode, helpers/edge-database.ts); a second database plays the cloud and
// is read through listCatalogRecordsSince(cloudDb, ...). Both are created
// before any app module opens its pool (vi.hoisted).
//
// Assumptions (the brief does not pin them down):
//  - The brand row of brand A reaches the edge through the master snapshot
//    (covered in edge-recipes-all-tenant.test.ts); here it is copied directly.
//  - A modifier whose recipe is missing on the edge makes the WHOLE deduction
//    of that sale `skipped` and posts nothing (a half-posted sale would break
//    "HPP = sum of the deductions"); the skip reason is not asserted.
//  - `repostSkippedDeductions` reports `reposted` as a number (or a list: its
//    length is used).
//  - Unit costs: beans Rp100/g, syrup Rp80/ml; the base recipe uses 18 g beans,
//    the modifier recipe 15 ml syrup; so one unit costs 18*100 + 15*80 = 3000.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  cafeLegendAccessFixtures,
  ROLE_TEMPLATES,
} from "@starter/shared/access";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
  type CATALOG_SYNC_STREAMS,
} from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db, pool } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { computeLineCostSnapshots } from "../services/order-cost-snapshot.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { repostSkippedDeductions } from "../services/recipe-deduction-repost.service.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";

const dbs = await vi.hoisted(async () => {
  const { createEdgeDatabase } = await import("./helpers/edge-database.ts");
  const { cafeLegendPlatformFixtures: platform } =
    await import("@starter/shared/platform");
  const { cafeLegendAccessFixtures: access } =
    await import("@starter/shared/access");
  const original = {
    STARTER_TEST_DATABASE_URL: process.env.STARTER_TEST_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
  };
  const input = {
    tenantId: platform.tenant.id,
    outletId: access.outletIds.bandung,
  };
  const cloud = await createEdgeDatabase(input);
  const edge = await createEdgeDatabase(input);
  process.env.STARTER_TEST_DATABASE_URL = edge.ownerUrl;
  process.env.DATABASE_URL = edge.appUrl;
  process.env.APP_DATABASE_URL = edge.appUrl;
  return { cloud, edge, original };
});
const { cloud, edge } = dbs;

type Stream = (typeof CATALOG_SYNC_STREAMS)[number];

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendAccessFixtures.outletIds.bandung;
const brandA = randomUUID(); // owns the modifier recipe
let brandB = ""; // brand of the edge's own outlet (owns the item)
let legalEntityId = "";
const actor = randomUUID();
const id = () => randomUUID();
const ids = {
  user: id(),
  gram: id(),
  ml: id(),
  cup: id(),
  beans: id(),
  syrup: id(),
  category: id(),
  baseRecipe: id(), // brand B
  syrupRecipe: id(), // brand A
  baseLine: id(),
  syrupLine: id(),
  item: id(),
  group: id(),
  modifier: id(),
};
let barId = "";
let nodeId = "";
const ORDER_TOTAL = 50_000;
const iso = () => new Date().toISOString();

const tenantContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
const sessionContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const deviceContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "device" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

let dayCounter = 0;
const nextDate = () => {
  dayCounter += 1;
  return new Date(Date.UTC(2031, 0, 1 + dayCounter)).toISOString().slice(0, 10);
};

// -------------------------------------------------------------- cloud seed

async function one<T>(pg: Pool, text: string, params: unknown[]): Promise<T> {
  return (await pg.query<{ id: T }>(text, params)).rows[0]!.id;
}

async function copyRow(from: Pool, to: Pool, table: string, rowId: string) {
  const found = await from.query(
    `SELECT row_to_json(t) AS row FROM ${table} t WHERE id = $1`,
    [rowId],
  );
  const client = await to.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO ${table} SELECT * FROM json_populate_record(NULL::${table}, $1::json) ON CONFLICT DO NOTHING`,
      [JSON.stringify(found.rows[0].row)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedCloud() {
  const q = (text: string, params: unknown[]) =>
    cloud.owner.query(text, params);
  const outlet = (
    await q("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
      outletId,
    ])
  ).rows[0];
  brandB = outlet.brand_id;
  legalEntityId = outlet.legal_entity_id;
  await q(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,'merek-a','Merek A')`,
    [brandA, tenantId],
  );
  await q(`INSERT INTO "user" (id, name, email) VALUES ($1,'Penulis',$2)`, [
    ids.user,
    `${ids.user}@dedukasi.example.test`,
  ]);
  for (const [uom, code] of [
    [ids.gram, "g"],
    [ids.ml, "ml"],
    [ids.cup, "cup"],
  ] as const)
    await q(
      `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1,$2,$3,$3)`,
      [uom, tenantId, code],
    );
  for (const [item, name, uom] of [
    [ids.beans, "Biji kopi", ids.gram],
    [ids.syrup, "Sirup", ids.ml],
  ] as const)
    await q(
      `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1,$2,$3,'Bahan Baku','raw_material',$4,true)`,
      [item, tenantId, name, uom],
    );
  for (const [recipe, brand, name] of [
    [ids.baseRecipe, brandB, "Resep dasar latte"],
    [ids.syrupRecipe, brandA, "Resep tambah sirup"],
  ] as const)
    await q(
      `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
       VALUES ($1,$2,$3,$4,NULL,'1.0000',$5,true,$6)`,
      [recipe, tenantId, brand, name, ids.cup, ids.user],
    );
  for (const [line, recipe, item, qty, uom] of [
    [ids.baseLine, ids.baseRecipe, ids.beans, "18.0000", ids.gram],
    [ids.syrupLine, ids.syrupRecipe, ids.syrup, "15.0000", ids.ml],
  ] as const)
    await q(
      `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1,$2,$3,0,'item',$4,$5,$6,0)`,
      [line, tenantId, recipe, item, qty, uom],
    );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kopi',0)`,
    [ids.category, tenantId, brandB],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, recipe_id, is_active)
     VALUES ($1,$2,$3,$4,'Latte merek B',$5,true)`,
    [ids.item, tenantId, brandB, ids.category, ids.baseRecipe],
  );
  await q(
    `INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select) VALUES ($1,$2,'Tambahan',0,10)`,
    [ids.group, tenantId],
  );
  await q(
    `INSERT INTO modifiers (id, tenant_id, group_id, name, recipe_id) VALUES ($1,$2,$3,'Sirup',$4)`,
    [ids.modifier, tenantId, ids.group, ids.syrupRecipe],
  );
}

/** One cloud page through the real service (credential of the edge's outlet). */
async function cloudPage(stream: Stream, since: string | null) {
  await settleCloud(cloud.owner);
  const query = catalogSyncQuerySchema.parse({
    stream,
    limit: 100,
    protocolVersion: CATALOG_PROTOCOL_VERSION,
    ...(since === null ? {} : { since }),
  });
  const page = (await listCatalogRecordsSince(cloud.database as never, {
    tenantId: tenantId as never,
    outletId: outletId as never,
    query,
  })) as unknown as Record<string, unknown>;
  return { protocolVersion: CATALOG_PROTOCOL_VERSION, stream, ...page };
}

async function pull() {
  const result = (await pullCatalog({
    database: db,
    context: deviceContext(),
    edgeNodeId: nodeId,
    fetchPage: cloudPage,
  } as never)) as { streams: Record<string, { error?: unknown } | undefined> };
  return result;
}

// ---------------------------------------------------------- edge fixtures

async function receive(itemId: string, quantity: string, unitCost: string) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outletId) as OutletId,
    locationId: barId,
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

async function setUpEdgeInventory() {
  const q = (text: string, params: unknown[]) => edge.owner.query(text, params);
  barId = await one<string>(
    edge.owner,
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1,$2,'Bar','bar') RETURNING id",
    [tenantId, outletId],
  );
  await q(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1,$2,'real_time',$3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time', sale_location_id = EXCLUDED.sale_location_id`,
    [tenantId, outletId, barId],
  );
  for (const [role, code, name, type, group] of [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  ] as const) {
    const accountId = await one<string>(
      edge.owner,
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [tenantId, legalEntityId, code, name, type, group],
    );
    await q(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id) VALUES ($1,$2,$3,$4)`,
      [tenantId, legalEntityId, role, accountId],
    );
  }
  for (const year of [2026, 2027, 2031])
    for (let month = 1; month <= 12; month += 1)
      await q(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
        [tenantId, legalEntityId, `${year}-${String(month).padStart(2, "0")}`],
      );
  // The actor of the re-post: an owner at tenant scope.
  const template = ROLE_TEMPLATES.find((t) => t.key === "owner")!;
  const roleId = await one<string>(
    edge.owner,
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1,$2,$3,true,$4,$5,$6,$7) RETURNING id`,
    [
      randomUUID(),
      tenantId,
      template.defaultName,
      template.key,
      JSON.stringify(template.permissions),
      template.mfaRequired,
      JSON.stringify(template.allowedScopeTypes),
    ],
  );
  await q(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1,$2,$3,'tenant',NULL, now() - interval '1 minute', $2)`,
    [tenantId, ids.user, roleId],
  );
}

async function asEdgeTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await edge.owner.connect();
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

/** A paid order of `quantity` lattes with the syrup modifier, as the POS leaves it. */
async function seedOrder(quantity: number, businessDate: string) {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await asEdgeTenant(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1,$2,$3,$4,'pos','takeaway','pay_first',$6,0,0,0,0,$6,'completed',$5,now())`,
      [
        uuid,
        tenantId,
        outletId,
        `EDG-${randomUUID().slice(0, 12)}`,
        businessDate,
        ORDER_TOTAL,
      ],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1,$2,$3,$4,$5,NULL,'Latte',$6,0,0,0,$7::jsonb,'fired','served',$8)`,
      [
        randomUUID(),
        tenantId,
        outletId,
        uuid,
        ids.item,
        quantity,
        JSON.stringify([
          {
            modifierId: ids.modifier,
            groupId: ids.group,
            name: "Sirup",
            priceIdr: 0,
          },
        ]),
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training) VALUES ($1,$2,$3,'pos',false)`,
      [uuid, tenantId, outletId],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1,$2,$3,'cash','manual',$4,$4,0,'captured',now(),now())`,
      [tenantId, outletId, uuid, ORDER_TOTAL],
    );
  });
  return { ulid, uuid };
}

function paidEvent(orderUlid: string, businessDate: string): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId,
    outletId,
    name: "order.paid",
    version: 1,
    aggregateType: "order",
    aggregateId: orderUlid,
    sequence: 1,
    occurredAt: iso(),
    actor: { type: "system" },
    idempotencyKey: `order.paid:${orderUlid}`,
    payloadSchemaRef: "order.paid.v1",
    payload: orderPaidPayloadSchema.parse({
      orderId: orderUlid,
      outletId,
      businessDate,
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: ORDER_TOTAL,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: ORDER_TOTAL,
      paidCashIdr: ORDER_TOTAL,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: ORDER_TOTAL }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: iso(),
    }),
  });
}

async function sell(quantity: number) {
  const businessDate = nextDate();
  const order = await seedOrder(quantity, businessDate);
  const context = tenantContext();
  await withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(
      context,
      paidEvent(order.ulid, businessDate),
      tx,
    ),
  );
  return { order, businessDate };
}

// ---------------------------------------------------------------- readers

const onHand = async (itemId: string) =>
  (
    await edge.owner.query(
      "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
      [tenantId, barId, itemId],
    )
  ).rows[0]?.quantity as string | undefined;

async function deductionOf(order: { ulid: string; uuid: string }) {
  return (
    await edge.owner.query(
      `SELECT kind, status, skip_reason, cost_idr::text AS cost_idr FROM recipe_deductions
        WHERE tenant_id = $1 AND (source_id = $2 OR source_id = $3) ORDER BY created_at, id`,
      [tenantId, order.ulid, order.uuid],
    )
  ).rows;
}

/** Sum of |quantity| of the order's ledger rows per inventory item. */
async function ledgerByItem(order: { uuid: string }) {
  const { rows } = await edge.owner.query(
    `SELECT inventory_item_id AS item, sum(abs(quantity))::text AS qty FROM stock_ledger
      WHERE tenant_id = $1 AND source_id = $2 AND movement_type <> 'return' GROUP BY 1`,
    [tenantId, order.uuid],
  );
  return Object.fromEntries(
    rows.map((r) => [r.item as string, r.qty as string]),
  );
}

async function ledgerCost(order: { uuid: string }) {
  const { rows } = await edge.owner.query(
    `SELECT coalesce(sum(abs(quantity) * unit_cost_idr), 0)::text AS cost FROM stock_ledger
      WHERE tenant_id = $1 AND source_id = $2 AND movement_type <> 'return'`,
    [tenantId, order.uuid],
  );
  return Math.round(Number(rows[0]!.cost));
}

async function hppOf(quantity: number) {
  const context = tenantContext();
  const [snapshot] = await withTenant(db, context, (tx) =>
    computeLineCostSnapshots(
      tx,
      context,
      outletIdSchema.parse(outletId) as OutletId,
      [
        {
          menuItemId: ids.item,
          variantId: null,
          modifierIds: [ids.modifier],
          quantity,
        },
      ] as unknown as Parameters<typeof computeLineCostSnapshots>[3],
    ),
  );
  return snapshot;
}

const countOf = (value: unknown) =>
  Array.isArray(value) ? value.length : Number(value);

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await seedCloud();
  // What the edge already has before the catalog pull: brand A (master
  // snapshot), the units and the author of the recipes.
  await copyRow(cloud.owner, edge.owner, "brands", brandA);
  await copyRow(cloud.owner, edge.owner, `"user"`, ids.user);
  for (const uom of [ids.gram, ids.ml, ids.cup])
    await copyRow(cloud.owner, edge.owner, "uoms", uom);
  nodeId = (
    await registerEdgeNode(deviceContext(), actor, {
      outletId,
      role: "standby",
      label: "Mini PC dedukasi",
    })
  ).edgeNode.id;
  const result = await pull();
  for (const stream of [
    "inventory_items",
    "recipes",
    "menu_items",
    "modifiers",
  ])
    expect(result.streams[stream]?.error, stream).toBeFalsy();
  await setUpEdgeInventory();
  await receive(ids.beans, "1000.0000", "100.0000");
  await receive(ids.syrup, "1000.0000", "80.0000");
}, 300_000);

afterAll(async () => {
  setAuditWriter(null);
  await pool.end();
  await edge.cleanup();
  await cloud.cleanup();
  for (const [key, value] of Object.entries(dbs.original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ------------------------------------------------------------------ tests

describe("legend-2uqcd (d) a brand B item with a brand A modifier recipe on the edge", () => {
  it("legend-2uqcd-d the edge holds the recipes of both brands", async () => {
    const rows = await edge.rows(
      "SELECT id, brand_id FROM recipes ORDER BY id",
    );
    expect(rows.map((r) => r.id).sort()).toEqual(
      [ids.baseRecipe, ids.syrupRecipe].sort(),
    );
    expect(rows.find((r) => r.id === ids.syrupRecipe)!.brand_id).toBe(brandA);
  });

  it("legend-2uqcd-d the base ingredient and the modifier ingredient are both deducted, and the HPP is filled", async () => {
    const beansBefore = Number(await onHand(ids.beans));
    const syrupBefore = Number(await onHand(ids.syrup));
    // 18 g x Rp100 + 15 ml x Rp80 = Rp3.000 per unit; 2 units = Rp6.000.
    expect(await hppOf(2)).toBe(6_000);

    const { order } = await sell(2);
    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "posted", cost_idr: "6000" },
    ]);
    expect(Number(await onHand(ids.beans))).toBe(beansBefore - 36);
    expect(Number(await onHand(ids.syrup))).toBe(syrupBefore - 30);
    expect(await ledgerByItem(order)).toEqual({
      [ids.beans]: "36.0000",
      [ids.syrup]: "30.0000",
    });
    expect(await ledgerCost(order)).toBe(6_000);
  });
});

describe("legend-2uqcd (e) the modifier recipe is not on the edge yet", () => {
  it("legend-2uqcd-e the deduction is skipped, and after the sync a re-post deducts exactly once", async () => {
    // The recipe of brand A is not on the edge yet (modifiers have no foreign
    // key to recipes there, so the modifier row itself stays).
    await edge.owner.query("DELETE FROM recipe_lines WHERE recipe_id = $1", [
      ids.syrupRecipe,
    ]);
    await edge.owner.query("DELETE FROM recipes WHERE id = $1", [
      ids.syrupRecipe,
    ]);
    const beansBefore = await onHand(ids.beans);
    const syrupBefore = await onHand(ids.syrup);

    const { order, businessDate } = await sell(1);
    const skipped = await deductionOf(order);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ kind: "sale", status: "skipped" });
    expect(await ledgerByItem(order)).toEqual({});
    expect(await onHand(ids.beans)).toBe(beansBefore);
    expect(await onHand(ids.syrup)).toBe(syrupBefore);

    // The cloud changes the recipe (new stamp) and the edge pulls it again.
    await cloud.owner.query(
      "UPDATE recipes SET name = name || ' (sinkron)' WHERE id = $1",
      [ids.syrupRecipe],
    );
    const synced = await pull();
    expect(synced.streams.recipes?.error).toBeFalsy();
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id = $1", [
        ids.syrupRecipe,
      ]),
    ).toHaveLength(1);

    const repost = await repostSkippedDeductions(sessionContext(), ids.user, {
      outletId,
      businessDate,
    });
    expect(countOf((repost as { reposted: unknown }).reposted)).toBe(1);
    expect(await deductionOf(order)).toMatchObject([
      { kind: "sale", status: "posted", cost_idr: "3000" },
    ]);
    expect(await ledgerByItem(order)).toEqual({
      [ids.beans]: "18.0000",
      [ids.syrup]: "15.0000",
    });
    expect(Number(await onHand(ids.beans))).toBe(Number(beansBefore) - 18);
    expect(Number(await onHand(ids.syrup))).toBe(Number(syrupBefore) - 15);

    // A second re-post posts nothing more.
    const again = await repostSkippedDeductions(sessionContext(), ids.user, {
      outletId,
      businessDate,
    });
    expect(countOf((again as { reposted: unknown }).reposted)).toBe(0);
    expect(await ledgerByItem(order)).toEqual({
      [ids.beans]: "18.0000",
      [ids.syrup]: "15.0000",
    });
    expect(Number(await onHand(ids.syrup))).toBe(Number(syrupBefore) - 15);
  });
});
