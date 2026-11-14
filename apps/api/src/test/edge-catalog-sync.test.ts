// Catalog down-sync cloud -> edge (bead legend-97p; PRD v1.7 §3 F8 Master Menu
// & Harga, §3 F16 Resep & BOM, §5 "cloud wins"). Written from the brief
// (docs/briefs/97p-catalog-downsync.md) and the shared contract
// (packages/shared/src/edge/catalog-sync.ts), not from the implementation.
//
// Updated for beads legend-24318 / legend-0mus6 (docs/briefs/24318-design.md):
// the time cursor (updated_at + settle window + overlap) is replaced by the
// `sync_txid` contract. Tests prefixed "24318" are new or changed for it:
//  - 10 streams (stations and inventory_items first); every record carries
//    `syncTxid` (digits); cursors are `cat2`, a `cat1` cursor is refused.
//  - The cloud holds back rows at or above the oldest open transaction (this
//    replaces the settle window). Tests wait for that boundary with
//    `settleCloud` (helpers/catalog-cloud.ts) instead of sleeping.
//  - Edge apply replaces a local row ONLY when the incoming `syncTxid` is
//    GREATER than the stored one (`incoming > stored`); `updatedAt` plays no
//    part, so a copy with a lower txid loses even with a newer `updatedAt`.
//    A full pull (empty or cat1 checkpoint) first resets every local
//    `sync_txid` to 0 (resetCatalogSyncTxid), so cloud data always corrects a
//    local row that carries a big local txid. A local
//    row is made "older" in tests by writing `sync_txid` with
//    `legend.skip_sync_txid = on` (the edge trigger leaves it alone then).
//    Assumption: an EQUAL txid may be skipped or applied (not asserted).
//  - `recipes.updated_by` is nullable on the edge: an unknown user becomes
//    NULL and is counted in `nulledRefs`; the checkpoint moves.
//  - `station_id` / `output_item_id` that are not on the edge yet are NOT
//    nulled: apply refuses the page with CATALOG_MISSING_REF (a
//    CatalogMissingRefError, transient: the checkpoint stays). Assumption: its
//    `code` is "CATALOG_MISSING_REF", as for the old missing-ref error.
//  - A derived stream is skipped when its parent stream failed (menu_items and
//    modifiers when stations failed, recipes when inventory_items failed, and
//    menu_items and item_variants when recipes failed or were skipped,
//    legend-3kdd; modifiers do NOT wait for recipes, their recipe_id has no
//    foreign key on the edge): its
//    error mentions CATALOG_PARENT_FAILED, nothing is fetched for it and its
//    checkpoint does not move. Assumption: independent streams still run.
//  - The cloud sends `stationId` on menu_items / modifiers only when the
//    station belongs to the outlet of the credential, otherwise null.
//  - pullCatalog has no `overlapMs` any more; the scripted cloud hands out
//    real `cat2` cursors (helpers/catalog-cloud.ts).
//
// Two private databases per file: helpers/catalog-database.ts creates the CLOUD
// before app imports; helpers/edge-database.ts creates the EDGE (restricted
// login, RLS forced). Neither uses the shared test database for catalog writes.
// Cloud rows live under a private tenant on two private outlets (O1 = the
// outlet of the edge, O2 = a sibling). A second bare tenant B owns rows that
// must never leave for tenant A. A private tenant keeps tenant-wide catalog
// pages independent of the inventory accumulated by other test files.
//
// Assumptions (brief ambiguities), each isolated so a mismatch is a one-line fix:
//  - listCatalogRecordsSince(db, { tenantId, outletId, query }) uses the app
//    `db` pool and sets the tenant context itself. The settle window is
//    defaulted (no 3rd argument): seeded rows carry old `updated_at`, rows
//    stamped "now" prove the hold-back.
//  - applyCatalogRecords(tx, { tenantId, stream, records }) runs inside an edge
//    transaction; the test sets app.tenant_id / app.outlet_ids on that tx first.
//  - pullCatalog({ context, edgeNodeId, fetchPage, database, overlapMs }) with
//    `fetchPage(stream, since | null) => page JSON` (agreed with the
//    implementer). It rejects when a page fetch or apply fails; tests
//    tolerate either and assert only the stored state. Checkpoints sit in
//    `edge_pull_checkpoints` (stream `catalog:<stream>`); the stored watermark
//    equals the `nextCursor` of the last applied page. The scripted cloud
//    hands out opaque `<stream>:<n>` cursors, so it pulls with `overlapMs: 0`
//    (the default overlap rewind decodes real cursors); one test pulls with
//    the real export and the default overlap.
//  - "Cloud wins" over a differing local row: tested for a local row with an
//    older or equal `updated_at` (a strictly newer local stamp is ambiguous
//    against the "old record never overwrites new" rule, not asserted).
//  - Round 2 (docs/briefs/97p-fixes.md): there are 8 streams (no `recipe_lines`,
//    no `price_list_items`). A `recipes` record carries `lines` (every line,
//    each with id / quantity / wastePctBp / sortOrder like the old line
//    record); a `price_lists` record carries `items` (every active item with
//    id / itemId / variantId / priceIdr). Apply replaces the child set in one
//    transaction, guarded by the header's `updated_at <=`. The edge tables
//    `recipe_lines` and `price_list_items` still exist and are read directly.
//  - Missing refs: apply rejects a recipe with an unknown `updatedBy` with an
//    error whose `code` is CATALOG_MISSING_REF; the puller catches it per
//    stream and reports `result.streams[stream].error` (truthy), never moving
//    that stream's checkpoint. `output_item_id` / `station_id` unknown on the
//    edge become NULL; apply's return value has `nulledRefs` (array, number or
//    object: only "non-empty / > 0" is asserted).
//  - pullCatalog resolves with `{ streams: { [stream]: { error?: ... } } }`.
//  - modifier_groups / modifiers carry no brand in the shared schema, so they
//    are tenant-wide (asserted to reach both brands).
//  - A tombstone leaves the edge row absent or with deleted_at set.
//  - GET /api/edge-sync/catalog answers the bare page object (like device
//    records); a query with unknown keys (tenantId, outletId) is refused 400/422.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db, pool } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { applyCatalogRecords } from "../services/edge-catalog-apply.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import {
  registerEdgeNode,
  revokeEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { scriptedCatalogCloud, settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
  type Row,
} from "./helpers/edge-database.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});

type Stream = (typeof CATALOG_SYNC_STREAMS)[number];
/** Streams plus the two child tables that now travel inside their parent record. */
type Table = Stream | "price_list_items" | "recipe_lines";
type Rec = Record<string, unknown>;
type PullResult = {
  streams: Record<string, { error?: unknown } | undefined>;
};
type Page = {
  stream: Stream;
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const tenantB = randomUUID();
const brandB = randomUUID();
const actor = randomUUID();

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const O1: string = randomUUID();
let O2 = "";
let O3 = ""; // outlet of the second brand of the same tenant
const brandId = randomUUID();
const brand2 = randomUUID();
let edge: EdgeDatabase;
let node: { id: string; credential: string };
let revokedNode: { id: string; credential: string };
let uomId = "";
let userId = "";

const id = () => randomUUID();
const ids = {
  stn1: id(),
  stnO2: id(),
  stnGone: id(),
  inv1: id(),
  invOff: id(),
  itemStn: id(),
  plTomb: id(),
  pliTomb: id(),
  cat1: id(),
  cat2: id(),
  item1: id(),
  item2: id(),
  item3: id(),
  var1: id(),
  mg1: id(),
  mod1: id(),
  pl1: id(),
  pl2: id(),
  pli1: id(),
  pli2: id(),
  pli3: id(),
  pliChg: id(),
  pliBad: id(),
  pliO2: id(),
  rec1: id(),
  line1: id(),
  line2: id(),
  line3: id(),
  // Second brand of tenant A
  catBr2: id(),
  itemBr2: id(),
  varBr2: id(),
  recBr2: id(),
  // Tenant B
  catB: id(),
  itemB: id(),
  mgB: id(),
};
const PRICE = {
  pli1: 18_750,
  pli2: 21_250,
  pli3: 1_234_567,
  pliChg: 15_000,
  pliBad: 77_777,
  pliO2: 99_999,
};
const tieIds: string[] = [];
const created: { table: string; where: string; params: unknown[] }[] = [];

/** Rows seeded for O1, per stream (the join table is keyed by item + group). */
const MINE: Record<Table, string[]> = {
  stations: [ids.stn1],
  printers: [],
  inventory_items: [ids.inv1, ids.invOff],
  menu_categories: [ids.cat1, ids.cat2],
  menu_items: [ids.item1, ids.item2, ids.item3, ids.itemStn],
  item_variants: [ids.var1],
  modifier_groups: [ids.mg1],
  modifiers: [ids.mod1],
  menu_item_modifier_groups: [ids.item1],
  price_lists: [ids.pl1],
  price_list_items: [ids.pli1, ids.pli2, ids.pli3, ids.pliChg, ids.pliBad],
  recipes: [ids.rec1],
  recipe_lines: [ids.line1, ids.line2],
  promotions: [],
  vouchers: [],
};
const isMine = (stream: Stream, rec: Rec): boolean =>
  stream === "menu_item_modifier_groups"
    ? rec.menuItemId === ids.item1 && rec.groupId === ids.mg1
    : MINE[stream].includes(String(rec.id));

/** Stream order, parents first (the order the cloud and the puller use). */
const ORDER: Stream[] = [
  "stations",
  "printers",
  "inventory_items",
  "recipes",
  "menu_categories",
  "modifier_groups",
  "modifiers",
  "menu_items",
  "item_variants",
  "menu_item_modifier_groups",
  "price_lists",
  "promotions",
  "vouchers",
];
/** Every table to compare edge vs cloud, parents first. */
const TABLE_ORDER: Table[] = [
  "stations",
  "inventory_items",
  "recipes",
  "recipe_lines",
  "menu_categories",
  "modifier_groups",
  "modifiers",
  "menu_items",
  "item_variants",
  "menu_item_modifier_groups",
  "price_lists",
  "price_list_items",
];

// ---------------------------------------------------------------- helpers

const at = (minute: number) => new Date(Date.UTC(2025, 5, 1, 0, minute));

async function seedCloud() {
  const q = (text: string, params: unknown[]) => mainOwner.query(text, params);
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at) VALUES
       ($1,$3,$4,'Katalog A',0,$5), ($2,$3,$4,'Katalog B',1,$6)`,
    [ids.cat1, ids.cat2, tenantId, brandId, at(1), at(2)],
  );
  // Stations are outlet scoped: one for O1 (the edge), one for the sibling O2.
  await q(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type, target_seconds, updated_at) VALUES
       ($1,$3,$4,$6,'coffee_bar',180,$7), ($2,$3,$5,$6,'hot_kitchen',null,$7)`,
    [
      ids.stn1,
      ids.stnO2,
      tenantId,
      O1,
      O2,
      `Stasiun ${ids.stn1.slice(0, 6)}`,
      at(1),
    ],
  );
  for (const [n, itemId] of [
    [3, ids.item1],
    [4, ids.item2],
    [5, ids.item3],
  ] as const)
    await q(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, updated_at)
       VALUES ($1,$2,$3,$4,$5,true,$6)`,
      [
        itemId,
        tenantId,
        brandId,
        ids.cat1,
        `Menu ${n} ${itemId.slice(0, 6)}`,
        at(n),
      ],
    );
  await q(
    `INSERT INTO item_variants (id, tenant_id, menu_item_id, name, updated_at) VALUES ($1,$2,$3,'Large',$4)`,
    [ids.var1, tenantId, ids.item1, at(6)],
  );
  await q(
    `INSERT INTO modifier_groups (id, tenant_id, name, updated_at) VALUES ($1,$2,$3,$4)`,
    [ids.mg1, tenantId, `Topping ${ids.mg1.slice(0, 6)}`, at(7)],
  );
  await q(
    `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr, updated_at) VALUES ($1,$2,$3,'Boba',3500,$4)`,
    [ids.mod1, tenantId, ids.mg1, at(8)],
  );
  await q(
    `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order, updated_at) VALUES ($1,$2,$3,0,$4)`,
    [tenantId, ids.item1, ids.mg1, at(9)],
  );
  await q(
    `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from, updated_at) VALUES
       ($1,$3,$4,'dine_in','2026-01-01',$6), ($2,$3,$5,'dine_in','2026-01-01',$7)`,
    [ids.pl1, ids.pl2, tenantId, O1, O2, at(10), at(11)],
  );
  const price = (
    rowId: string,
    list: string,
    item: string,
    variant: string | null,
    amount: number,
    minute: number,
  ) =>
    q(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rowId, tenantId, list, item, variant, amount, at(minute)],
    );
  await price(ids.pli1, ids.pl1, ids.item1, null, PRICE.pli1, 12);
  await price(ids.pli2, ids.pl1, ids.item1, ids.var1, PRICE.pli2, 13);
  await price(ids.pli3, ids.pl1, ids.item2, null, PRICE.pli3, 14);
  await price(ids.pliO2, ids.pl2, ids.item1, null, PRICE.pliO2, 15);
  await price(ids.pliBad, ids.pl1, ids.item3, null, PRICE.pliBad, 16);
  // A second item for the price that the tests change later.
  const itemChg = id();
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6)`,
    [
      itemChg,
      tenantId,
      brandId,
      ids.cat2,
      `Harga ubah ${itemChg.slice(0, 6)}`,
      at(3),
    ],
  );
  MINE.menu_items.push(itemChg);
  await price(ids.pliChg, ids.pl1, itemChg, null, PRICE.pliChg, 17);
  // An item routed to the O1 station (the station travels first in the pull).
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, station_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,$7)`,
    [
      ids.itemStn,
      tenantId,
      brandId,
      ids.cat1,
      `Menu stasiun ${ids.itemStn.slice(0, 6)}`,
      ids.stn1,
      at(3),
    ],
  );

  uomId = (
    await q(
      `INSERT INTO uoms (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [tenantId, `u${id().slice(0, 8)}`],
    )
  ).rows[0].id;
  userId = (await q(`SELECT id FROM "user" ORDER BY id LIMIT 1`, [])).rows[0]
    .id;
  // Inventory items are tenant wide and have no deleted_at: one active, one
  // switched off (is_active = false), with exact NUMERIC pars.
  await q(
    `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id, is_perishable, is_active, par_min, par_max, updated_at)
     VALUES ($1,$3,$4,'Bahan','raw_material',$5,true,true,'1.2500','10.0000',$6),
            ($2,$3,$7,'Bahan','semi_finished',$5,false,false,NULL,NULL,$6)`,
    [
      ids.inv1,
      ids.invOff,
      tenantId,
      `Susu ${ids.inv1.slice(0, 6)}`,
      uomId,
      at(1),
      `Sirup ${ids.invOff.slice(0, 6)}`,
    ],
  );
  await q(
    `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,NULL,'1.0000',$5,true,$6,$7)`,
    [
      ids.rec1,
      tenantId,
      brandId,
      `Resep ${ids.rec1.slice(0, 6)}`,
      uomId,
      userId,
      at(18),
    ],
  );
  for (const [lineId, order, qty, waste] of [
    [ids.line1, 0, "2.5000", 150],
    [ids.line2, 1, "0.1250", 0],
  ] as const)
    await q(
      `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1,$2,$3,$4,'item',$5,$6,$7,$8)`,
      [lineId, tenantId, ids.rec1, order, id(), qty, uomId, waste],
    );

  // 105 categories that share ONE updated_at, older than everything else: the
  // first page (limit 100) must cut through the tie.
  for (let i = 0; i < 105; i += 1) tieIds.push(id());
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at)
     SELECT t.id, $2, $3, 'Seri ' || t.n, 0, '2020-01-01T00:00:00Z'
       FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, n)`,
    [tieIds, tenantId, brandId],
  );

  // Tenant B: must never reach tenant A.
  await q(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Katalog B', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantB, `katalog-b-${tenantB}`, actor],
  );
  await q(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,'uji','Uji')`,
    [brandB, tenantB],
  );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at) VALUES ($1,$2,$3,'Milik B',0,$4)`,
    [ids.catB, tenantB, brandB, at(1)],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, updated_at) VALUES ($1,$2,$3,$4,'Item B',true,$5)`,
    [ids.itemB, tenantB, brandB, ids.catB, at(2)],
  );
  await q(
    `INSERT INTO modifier_groups (id, tenant_id, name, updated_at) VALUES ($1,$2,'Grup B',$3)`,
    [ids.mgB, tenantB, at(3)],
  );
}

async function copyToEdge(table: string, rowId: string) {
  const found = await mainOwner.query(
    `SELECT row_to_json(t) AS row FROM ${table} t WHERE id = $1`,
    [rowId],
  );
  const client = await edge.owner.connect();
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

const CATALOG_TABLES_CHILD_FIRST = [
  "recipe_lines",
  "recipes",
  "inventory_items",
  "price_list_items",
  "price_lists",
  "menu_item_modifier_groups",
  "modifiers",
  "modifier_groups",
  "item_variants",
  "menu_items",
  "menu_categories",
  "stations",
];

async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of CATALOG_TABLES_CHILD_FIRST)
      await client.query(`DELETE FROM ${table}`);
    await client.query("DELETE FROM edge_pull_checkpoints");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The cloud's page for one stream, through the real service. */
async function cloudPage(
  stream: Stream,
  opts: {
    since?: string;
    limit?: number;
    outletId?: string;
    tenant?: string;
    /** Skip the wait for the commit-safe boundary (hold-back tests only). */
    noSettle?: boolean;
  },
): Promise<Page> {
  if (!opts.noSettle) await settleCloud(mainOwner);
  const query = catalogSyncQuerySchema.parse({
    stream,
    limit: opts.limit ?? 100,
    // The edge asks for the page version (an older edge would not).
    protocolVersion: CATALOG_PROTOCOL_VERSION,
    ...(opts.since === undefined ? {} : { since: opts.since }),
  });
  return listCatalogRecordsSince(db, {
    tenantId: (opts.tenant ?? tenantId) as never,
    outletId: (opts.outletId ?? O1) as never,
    query,
  }) as unknown as Promise<Page>;
}

/** Walks every page of a stream the way an edge would. */
async function walk(
  stream: Stream,
  opts: {
    limit?: number;
    outletId?: string;
    tenant?: string;
    noSettle?: boolean;
  } = {},
) {
  const records: Rec[] = [];
  const pages: Page[] = [];
  let since: string | undefined;
  for (let n = 0; n < 2000; n += 1) {
    const page = await cloudPage(stream, { ...opts, since });
    expect(page.stream).toBe(stream);
    pages.push(page);
    records.push(...page.records);
    if (!page.hasMore) break;
    expect(page.nextCursor).not.toBeNull();
    since = page.nextCursor as string;
  }
  return { records, pages };
}

/** Only the rows seeded by this file, as the real export serves them. */
async function exportMine(): Promise<Record<Stream, Rec[]>> {
  const out = {} as Record<Stream, Rec[]>;
  for (const stream of ORDER)
    out[stream] = (await walk(stream)).records.filter((r) => isMine(stream, r));
  return out;
}

function edgeApply(stream: Stream, records: Rec[]) {
  return edge.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', ${JSON.stringify([O1])}, true)`,
    );
    return applyCatalogRecords(tx as never, {
      tenantId: tenantId as never,
      stream,
      records: records as never,
    });
  });
}

/**
 * Writes local drift on the edge with the sync_txid trigger switched off, so a
 * test can set the stored `sync_txid` itself (as an edge apply does).
 */
async function edgeWriteKeepingTxid(statements: [string, unknown[]?][]) {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('legend.skip_sync_txid', 'on', true)",
    );
    for (const [text, params] of statements) await client.query(text, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function edgeApplyAll(data: Record<Stream, Rec[]>) {
  for (const stream of ORDER) await edgeApply(stream, data[stream]);
}

const WHERE_COLUMN: Record<Table, string> = {
  stations: "id",
  printers: "id",
  inventory_items: "id",
  menu_categories: "id",
  menu_items: "id",
  item_variants: "id",
  modifier_groups: "id",
  modifiers: "id",
  menu_item_modifier_groups: "menu_item_id",
  price_lists: "id",
  price_list_items: "id",
  recipes: "id",
  recipe_lines: "id",
  promotions: "id",
  vouchers: "id",
};

/** The stream `printers` lives in the table `edge_printers`. */
const physicalTable = (table: Table): string =>
  table === "printers" ? "edge_printers" : table;

/** Table rows for the seeded ids, without time stamps. */
async function tableRows(pool: Pool, table: Table): Promise<Row[]> {
  const rows = (
    await pool.query(
      `SELECT row_to_json(t) AS row FROM ${physicalTable(table)} t
        WHERE ${WHERE_COLUMN[table]} = ANY($1::uuid[]) ORDER BY t.${WHERE_COLUMN[table]}::text, t.tenant_id::text, (row_to_json(t)->>'group_id')`,
      [MINE[table]],
    )
  ).rows.map((r) => r.row as Row);
  const key = (r: Row) => `${String(r.id ?? "")}${String(r.group_id ?? "")}`;
  return rows
    .map((r) => {
      const copy = { ...r };
      delete copy.created_at;
      delete copy.updated_at;
      return copy;
    })
    .sort((a, b) => key(a).localeCompare(key(b)));
}

async function expectEdgeEqualsCloud() {
  for (const table of TABLE_ORDER) {
    const cloud = await tableRows(mainOwner, table);
    expect(cloud.length).toBeGreaterThan(0);
    expect(await tableRows(edge.owner, table)).toEqual(cloud);
  }
}

const edgeLines = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await edge.rows(
        "SELECT id, quantity::text AS q FROM recipe_lines WHERE recipe_id = $1 ORDER BY id",
        [ids.rec1],
      )
    ).map((r) => [String(r.id), String(r.q)]),
  );
const edgeRecipeStamp = async () =>
  (
    await edge.rows("SELECT updated_at::text AS u FROM recipes WHERE id = $1", [
      ids.rec1,
    ])
  )[0]?.u as string | undefined;
const edgeItemIdsOfList = async () =>
  (
    await edge.rows(
      "SELECT id FROM price_list_items WHERE price_list_id = $1 ORDER BY id",
      [ids.pl1],
    )
  ).map((r) => String(r.id));
const edgeListHeaders = async () =>
  (await edge.rows("SELECT id FROM price_lists WHERE id = $1", [ids.pl1]))
    .length;

const idsOf = (list: unknown): string[] =>
  (list as Rec[]).map((r) => String(r.id)).sort();
/** `nulledRefs` may be an array, a number or an object: count what it holds. */
const nulledCount = (result: unknown): number => {
  const v = (result as { nulledRefs?: unknown } | undefined)?.nulledRefs;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return Object.keys(v).length;
  return 0;
};

const edgePrice = async (rowId: string): Promise<string | undefined> =>
  (
    await edge.rows(
      "SELECT price_idr::text AS price FROM price_list_items WHERE id = $1",
      [rowId],
    )
  )[0]?.price as string | undefined;

const edgePriceRows = async () =>
  edge.rows(
    "SELECT id, price_idr::text AS price FROM price_list_items WHERE id = ANY($1::uuid[]) ORDER BY id",
    [MINE.price_list_items],
  );

const checkpoints = () =>
  edge.rows(
    "SELECT stream, watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1",
    [node.id],
  );

// A scripted cloud: serves the seeded rows (exactly what the real export
// returned) in pages of `pageSize` with real-shaped `cat2` cursors.
const scriptedCloud = (data: Record<Stream, Rec[]>, pageSize: number) =>
  scriptedCatalogCloud(data, pageSize) as unknown as {
    calls: { stream: Stream; since: string | null }[];
    fetchPage: (stream: Stream, since: string | null) => Promise<Page>;
    cursorAfter: (stream: string, position: number) => string;
    breakAt: (stream: Stream, fromCall: number) => void;
    heal: () => void;
  };

type Scripted = ReturnType<typeof scriptedCloud>;

/** pullCatalog, wired the way the runtime wires it. Tolerates a rejection. */
async function pull(cloud: Pick<Scripted, "fetchPage">): Promise<unknown> {
  try {
    return await pullCatalog({
      database: edge.database,
      context: edgeScope(O1),
      edgeNodeId: node.id,
      fetchPage: cloud.fetchPage,
    } as never);
  } catch (error) {
    return error;
  }
}

/** A pull that must complete (per-stream errors are inside the result). */
async function pullOk(cloud: Pick<Scripted, "fetchPage">): Promise<PullResult> {
  const result = await pull(cloud);
  expect(result).not.toBeInstanceOf(Error);
  return result as PullResult;
}

const cloudFingerprint = async () =>
  JSON.stringify(
    await Promise.all(
      TABLE_ORDER.map(async (table) =>
        (
          await mainOwner.query(
            `SELECT row_to_json(t) AS row FROM ${table} t WHERE ${WHERE_COLUMN[table]} = ANY($1::uuid[]) ORDER BY t.${WHERE_COLUMN[table]}::text, t.tenant_id::text, (row_to_json(t)->>'group_id')`,
            [MINE[table]],
          )
        ).rows.map((r) => r.row),
      ),
    ),
  );

const scopeOf = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
const cloudScope = (outletId: string) => scopeOf("session", outletId);
const edgeScope = (outletId: string) => scopeOf("device", outletId);

const app = createApp();
const bearer = (credential: string) => `Bearer ${credential}`;

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  // Inventory is tenant wide: unrelated files may leave more than one page
  // under the shared fixture tenant, so catalog expectations need their own tenant.
  const fixtureTenant = cafeLegendPlatformFixtures.tenant;
  await mainOwner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1,$2,'Tenant uji katalog',$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      tenantId,
      `katalog-a-${tenantId}`,
      fixtureTenant.plan,
      fixtureTenant.status,
      fixtureTenant.deploymentMode,
      JSON.stringify(fixtureTenant.featureFlags),
      JSON.stringify(fixtureTenant.limits),
      actor,
    ],
  );
  await mainOwner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,'uji','Uji')`,
    [brandId, tenantId],
  );
  await mainOwner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1,$2,'PT Uji Katalog',false)`,
    [legalEntityId, tenantId],
  );
  await mainOwner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1,$2,$3,$4,'CAT-01','Outlet uji katalog 1','Jl. Uji','{}','active')`,
    [O1, tenantId, brandId, legalEntityId],
  );
  O2 = await cloneMainOutlet(mainOwner, O1, "Outlet uji katalog 2");
  await seedCloud();

  // A second brand in the SAME tenant, with its own outlet and brand-owned rows.
  await mainOwner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,$3,'Merek dua')`,
    [brand2, tenantId, `uji-${brand2.slice(0, 8)}`],
  );
  O3 = await cloneMainOutlet(mainOwner, O1, "Outlet uji katalog 3");
  await mainOwner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
    brand2,
    O3,
  ]);
  await mainOwner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at) VALUES ($1,$2,$3,'Kategori merek dua',0,$4)`,
    [ids.catBr2, tenantId, brand2, at(50)],
  );
  await mainOwner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6)`,
    [
      ids.itemBr2,
      tenantId,
      brand2,
      ids.catBr2,
      `Menu merek dua ${ids.itemBr2.slice(0, 6)}`,
      at(51),
    ],
  );
  await mainOwner.query(
    `INSERT INTO item_variants (id, tenant_id, menu_item_id, name, updated_at) VALUES ($1,$2,$3,'Besar',$4)`,
    [ids.varBr2, tenantId, ids.itemBr2, at(52)],
  );
  await mainOwner.query(
    `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order, updated_at) VALUES ($1,$2,$3,0,$4)`,
    [tenantId, ids.itemBr2, ids.mg1, at(53)],
  );
  await mainOwner.query(
    `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,NULL,'1.0000',$5,true,$6,$7)`,
    [
      ids.recBr2,
      tenantId,
      brand2,
      `Resep merek dua ${ids.recBr2.slice(0, 6)}`,
      uomId,
      userId,
      at(54),
    ],
  );

  const registered = await registerEdgeNode(cloudScope(O1), actor, {
    outletId: O1,
    role: "standby",
    label: "Mini PC uji katalog",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  const toRevoke = await registerEdgeNode(cloudScope(O2), actor, {
    outletId: O2,
    role: "primary",
    label: "Mini PC dicabut",
  });
  revokedNode = {
    id: toRevoke.edgeNode.id,
    credential: toRevoke.credential,
  };
  await revokeEdgeNode(cloudScope(O2), actor, {
    edgeNodeId: revokedNode.id,
    reason: "Uji kredensial dicabut",
  });

  edge = await createEdgeDatabase({ tenantId, outletId: O1 });
  await copyToEdge("edge_nodes", node.id);
  await copyToEdge("uoms", uomId);
  await copyToEdge(`"user"`, userId);
}, 240_000);

beforeEach(async () => {
  await resetEdge();
});

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  await edge?.cleanup();
  try {
    for (const { table, where, params } of created.reverse())
      await mainOwner.query(`DELETE FROM ${table} WHERE ${where}`, params);
    const mine = (s: Table) => MINE[s];
    await mainOwner.query(
      "DELETE FROM recipe_lines WHERE id = ANY($1::uuid[]) OR recipe_id = ANY($2::uuid[])",
      [mine("recipe_lines"), [...mine("recipes"), ids.recBr2]],
    );
    await mainOwner.query("DELETE FROM recipes WHERE id = ANY($1::uuid[])", [
      [...mine("recipes"), ids.recBr2],
    ]);
    await mainOwner.query(
      "DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1",
      [ids.itemBr2],
    );
    await mainOwner.query("DELETE FROM item_variants WHERE id = $1", [
      ids.varBr2,
    ]);
    await mainOwner.query(
      "DELETE FROM price_list_items WHERE id = ANY($1::uuid[])",
      [[...mine("price_list_items"), ids.pliO2]],
    );
    await mainOwner.query(
      "DELETE FROM price_lists WHERE id = ANY($1::uuid[])",
      [[ids.pl1, ids.pl2]],
    );
    await mainOwner.query(
      "DELETE FROM menu_item_modifier_groups WHERE menu_item_id = $1",
      [ids.item1],
    );
    await mainOwner.query("DELETE FROM modifiers WHERE id = $1", [ids.mod1]);
    await mainOwner.query(
      "DELETE FROM modifier_groups WHERE id = ANY($1::uuid[])",
      [[ids.mg1, ids.mgB]],
    );
    await mainOwner.query("DELETE FROM item_variants WHERE id = $1", [
      ids.var1,
    ]);
    await mainOwner.query("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [
      [...mine("menu_items"), ids.itemB, ids.itemBr2],
    ]);
    await mainOwner.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
      [ids.stn1, ids.stnO2, ids.stnGone],
    ]);
    await mainOwner.query(
      "DELETE FROM inventory_items WHERE id = ANY($1::uuid[])",
      [[ids.inv1, ids.invOff]],
    );
    await mainOwner.query(
      "DELETE FROM menu_categories WHERE id = ANY($1::uuid[])",
      [[ids.cat1, ids.cat2, ids.catB, ids.catBr2, ...tieIds]],
    );
    await mainOwner.query("DELETE FROM uoms WHERE id = $1", [uomId]);
    await mainOwner.query(
      "DELETE FROM edge_pull_checkpoints WHERE outlet_id = ANY($1::uuid[])",
      [[O1, O2]],
    );
    await mainOwner.query(
      "DELETE FROM edge_nodes WHERE outlet_id = ANY($1::uuid[])",
      [[O1, O2]],
    );
    await mainOwner.query("DELETE FROM outlets WHERE id = ANY($1::uuid[])", [
      [O1, O2],
    ]);
    await mainOwner.query("DELETE FROM brands WHERE id = $1", [brandB]);
    await mainOwner.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await mainOwner.query("DELETE FROM outlets WHERE id = $1", [O3]);
    await mainOwner.query("DELETE FROM brands WHERE id = ANY($1::uuid[])", [
      [brandId, brand2],
    ]);
    await mainOwner.query("DELETE FROM legal_entities WHERE id = $1", [
      legalEntityId,
    ]);
    await mainOwner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  } catch {
    // Best effort: private ids and a private tenant, no other file reads them.
  }
  await mainOwner.end();
  await pool.end();
  await cloud.cleanup();
});

it("owns a separate cloud database for this catalog suite", async () => {
  const result = await mainOwner.query("SELECT current_database() AS name");
  const appResult = await pool.query("SELECT current_database() AS name");
  expect(result.rows[0].name).toBe(cloud.name);
  expect(appResult.rows[0].name).toBe(cloud.name);
  expect(`/${cloud.name}`).not.toBe(cloud.parentDatabaseName);
});

// ------------------------------------------------------- 1 cloud export

describe("97p cloud export: paging, tombstones, commit-safe boundary", () => {
  it("97p pages through a stream completely, without duplicates or gaps, when many rows share updated_at", async () => {
    const { records, pages } = await walk("menu_categories", { limit: 100 });
    const exported = records.map((r) => String(r.id));
    expect(new Set(exported).size).toBe(exported.length);
    for (const tie of tieIds) expect(exported).toContain(tie);
    for (const own of MINE.menu_categories) expect(exported).toContain(own);
    // 105 ties cannot fit one page of 100: the cut went through the tie.
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.records).toHaveLength(100);
    expect(pages[0]!.hasMore).toBe(true);
    expect(pages.at(-1)!.hasMore).toBe(false);
    // 24318: the order is (sync_txid, id). The 105 ties were written by ONE
    // statement, so they share one syncTxid and come out sorted by id.
    const byId = new Map(records.map((r) => [String(r.id), r]));
    const tieTxids = new Set(tieIds.map((t) => String(byId.get(t)!.syncTxid)));
    expect(tieTxids.size).toBe(1);
    const tiesInOrder = exported.filter((x) => tieIds.includes(x));
    expect(tiesInOrder).toEqual([...tieIds].sort());
    // Whole stream: syncTxid never goes down, and ties are broken by id.
    for (let i = 1; i < records.length; i += 1) {
      const a = records[i - 1]!;
      const b = records[i]!;
      const ta = BigInt(String(a.syncTxid));
      const tb = BigInt(String(b.syncTxid));
      expect(tb >= ta).toBe(true);
      if (ta === tb) expect(String(a.id) < String(b.id)).toBe(true);
    }
  });

  it("24318 every record carries syncTxid as digits, equal to the cloud row's sync_txid, and nextCursor is a cat2 cursor", async () => {
    const { records, pages } = await walk("menu_items", { limit: 2 });
    for (const rec of records) expect(String(rec.syncTxid)).toMatch(/^\d+$/);
    const cloudRows = (
      await mainOwner.query(
        "SELECT id, sync_txid::text AS t FROM menu_items WHERE id = ANY($1::uuid[])",
        [MINE.menu_items],
      )
    ).rows;
    for (const row of cloudRows) {
      const rec = records.find((r) => r.id === row.id)!;
      expect(rec.syncTxid).toBe(row.t);
    }
    for (const page of pages.filter((p) => p.records.length > 0)) {
      const keys = decodeCursor(page.nextCursor as string);
      expect(keys[0]).toBe("cat2");
      expect(String(keys[1])).toMatch(/^\d+$/);
      // The cursor position is the txid of the last record of the page.
      expect(String(keys[1])).toBe(String(page.records.at(-1)!.syncTxid));
    }
  });

  it("97p a tiny page size still yields every row exactly once", async () => {
    const { records } = await walk("menu_items", { limit: 1 });
    const exported = records.map((r) => String(r.id));
    expect(new Set(exported).size).toBe(exported.length);
    for (const own of MINE.menu_items) expect(exported).toContain(own);
  });

  it("24318/528 the 13 parent-first streams put promotions before vouchers and keep child documents inline", () => {
    expect([...CATALOG_SYNC_STREAMS]).toEqual(ORDER);
    expect(CATALOG_SYNC_STREAMS).not.toContain("recipe_lines");
    expect(CATALOG_SYNC_STREAMS).not.toContain("price_list_items");
  });

  it("97p every stream answers its own pages with schema-valid records", async () => {
    for (const stream of ORDER) {
      const page = await cloudPage(stream, { limit: 5 });
      expect(catalogSyncPageSchema.parse(page).stream).toBe(stream);
    }
  });

  it("97p a soft-deleted row travels as a tombstone", async () => {
    const tombId = id();
    created.push({ table: "menu_items", where: "id = $1", params: [tombId] });
    await mainOwner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,'Dihapus',false,$5,$5)`,
      [tombId, tenantId, brandId, ids.cat1, at(30)],
    );
    const { records } = await walk("menu_items");
    const found = records.find((r) => r.id === tombId);
    expect(found).toBeDefined();
    expect(found!.deletedAt).not.toBeNull();
  });

  it("24318 a row written by a transaction that is still open is held back, with every row committed after it, until that transaction ends", async () => {
    const youngId = id();
    const laterId = id();
    created.push(
      { table: "menu_categories", where: "id = $1", params: [youngId] },
      { table: "menu_categories", where: "id = $1", params: [laterId] },
    );
    const writer = await mainOwner.connect();
    let ended = false;
    try {
      await writer.query("BEGIN");
      await writer.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1,$2,$3,'Transaksi terbuka',0)`,
        [youngId, tenantId, brandId],
      );
      // Committed later than the open writer, so its txid is higher.
      await mainOwner.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1,$2,$3,'Commit lebih akhir',0)`,
        [laterId, tenantId, brandId],
      );
      const held = (
        await walk("menu_categories", { noSettle: true })
      ).records.map((r) => r.id);
      expect(held).not.toContain(youngId);
      expect(held).not.toContain(laterId);
      await writer.query("COMMIT");
      ended = true;
    } finally {
      if (!ended) await writer.query("ROLLBACK");
      writer.release();
    }
    const settled = (await walk("menu_categories")).records;
    const settledIds = settled.map((r) => r.id);
    expect(settledIds).toContain(youngId);
    expect(settledIds).toContain(laterId);
    // The older transaction comes out first.
    expect(settledIds.indexOf(youngId)).toBeLessThan(
      settledIds.indexOf(laterId),
    );
  });
});

// -------------------------------------------------------- 2 cursor errors

describe("97p broken cursor", () => {
  it("97p a garbage cursor is refused with a clear validation error", async () => {
    await expect(
      cloudPage("menu_items", { since: "bukan-cursor" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("24318 an old cat1 (time) cursor is refused with a clear validation error, in every stream shape", async () => {
    const old = encodeCursor(["cat1", "2025-06-01T00:00:00.000000Z", id()]);
    for (const stream of ["menu_items", "price_lists", "stations"] as const)
      await expect(cloudPage(stream, { since: old })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
  });

  it("24318 a cat2 cursor with a non-numeric txid is refused", async () => {
    const bad = encodeCursor(["cat2", "bukan-angka", id()]);
    await expect(cloudPage("menu_items", { since: bad })).rejects.toMatchObject(
      { code: "VALIDATION_ERROR" },
    );
  });

  it("97p a well-formed cursor of another shape is refused the same way", async () => {
    const foreign = encodeCursor(["dev1", "2025-06-01T00:00:00.000000Z", id()]);
    await expect(
      cloudPage("price_lists", { since: foreign }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

// ---------------------------------------------------------- query schema

describe("97p query contract", () => {
  it("97p accepts a stream with optional cursor and limit 1..100", () => {
    for (const stream of CATALOG_SYNC_STREAMS)
      expect(catalogSyncQuerySchema.safeParse({ stream }).success).toBe(true);
    expect(
      catalogSyncQuerySchema.safeParse({ stream: "menu_items", limit: 1 })
        .success,
    ).toBe(true);
    expect(
      catalogSyncQuerySchema.safeParse({ stream: "menu_items", limit: 100 })
        .success,
    ).toBe(true);
  });

  it("97p rejects an unknown stream, a limit outside 1..100 and unknown keys", () => {
    const bad = [
      { stream: "tax_rules" },
      { limit: 10 },
      { stream: "menu_items", limit: 0 },
      { stream: "menu_items", limit: 101 },
      { stream: "price_list_items" },
      { stream: "recipe_lines" },
      { stream: "menu_items", tenantId },
      { stream: "menu_items", outletId: O1 },
    ];
    for (const input of bad)
      expect(catalogSyncQuerySchema.safeParse(input).success).toBe(false);
  });
});

// --------------------------------------------------------- 3 apply on edge

describe("97p apply on the edge", () => {
  it("97p applying the cloud export gives the edge the same rows as the cloud", async () => {
    await edgeApplyAll(await exportMine());
    await expectEdgeEqualsCloud();
  });

  it("97p applying twice leaves the same state (idempotent)", async () => {
    const data = await exportMine();
    await edgeApplyAll(data);
    const first = await Promise.all(ORDER.map((s) => tableRows(edge.owner, s)));
    await edgeApplyAll(data);
    const second = await Promise.all(
      ORDER.map((s) => tableRows(edge.owner, s)),
    );
    expect(second).toEqual(first);
    await expectEdgeEqualsCloud();
  });

  it("24318 cloud wins over a different local row whose stored sync_txid is older", async () => {
    const data = await exportMine();
    await edgeApplyAll(data);
    // Local drift with an OLDER txid: different price, different name.
    await edgeWriteKeepingTxid([
      [`UPDATE price_list_items SET price_idr = 111 WHERE id = $1`, [ids.pli1]],
      [`UPDATE price_lists SET sync_txid = 1 WHERE id = $1`, [ids.pl1]],
      [
        `UPDATE menu_categories SET name = 'Lokal', sync_txid = 1 WHERE id = $1`,
        [ids.cat1],
      ],
    ]);
    await edgeApplyAll(data);
    expect(await edgePrice(ids.pli1)).toBe(String(PRICE.pli1));
    expect(await edgePrice(ids.pli2)).toBe(String(PRICE.pli2));
    await expectEdgeEqualsCloud();
  });

  it("24318 the edge stores the txid the cloud sent, not one of its own", async () => {
    const data = await exportMine();
    await edgeApplyAll(data);
    for (const stream of ORDER) {
      if (stream === "menu_item_modifier_groups") continue;
      for (const rec of data[stream]) {
        const edgeTxid = (
          await edge.rows(
            `SELECT sync_txid::text AS t FROM ${physicalTable(stream)} WHERE id = $1`,
            [String(rec.id)],
          )
        )[0]?.t;
        expect(edgeTxid).toBe(String(rec.syncTxid));
      }
    }
  });

  it("97p a tombstone makes the edge drop or hide its copy", async () => {
    const modId = id();
    created.push({ table: "modifiers", where: "id = $1", params: [modId] });
    await mainOwner.query(
      `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr, updated_at) VALUES ($1,$2,$3,'Es batu',500,$4)`,
      [modId, tenantId, ids.mg1, at(31)],
    );
    const exportMods = async () =>
      (await walk("modifiers")).records.filter(
        (r) => r.id === modId || r.id === ids.mod1,
      );
    await edgeApplyAll(await exportMine());
    await edgeApply("modifiers", await exportMods());
    expect(
      await edge.rows("SELECT id FROM modifiers WHERE id = $1", [modId]),
    ).toHaveLength(1);

    await mainOwner.query(
      `UPDATE modifiers SET deleted_at = $2, updated_at = $2 WHERE id = $1`,
      [modId, at(32)],
    );
    await edgeApply("modifiers", await exportMods());
    const rows = await edge.rows(
      "SELECT id, deleted_at FROM modifiers WHERE id = $1",
      [modId],
    );
    expect(rows.length === 0 || rows[0]!.deleted_at !== null).toBe(true);
    // The live sibling is untouched.
    expect(
      (
        await edge.rows("SELECT deleted_at FROM modifiers WHERE id = $1", [
          ids.mod1,
        ])
      )[0]?.deleted_at,
    ).toBeNull();
  });

  /** Puts the cloud recipe back to its seeded state (2 lines, old stamp). */
  const restoreCloudRecipe = async () => {
    await mainOwner.query("DELETE FROM recipe_lines WHERE recipe_id = $1", [
      ids.rec1,
    ]);
    await mainOwner.query(
      `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       SELECT l.id, $3, $4, l.n, 'item', gen_random_uuid(), l.qty::numeric, $5, l.waste
         FROM (VALUES ($1::uuid, 0, '2.5000', 150), ($2::uuid, 1, '0.1250', 0)) AS l(id, n, qty, waste)`,
      [ids.line1, ids.line2, tenantId, ids.rec1, uomId],
    );
    await mainOwner.query("UPDATE recipes SET updated_at = $2 WHERE id = $1", [
      ids.rec1,
      at(18),
    ]);
  };
  const bumpCloudRecipe = (minute: number) =>
    mainOwner.query("UPDATE recipes SET updated_at = $2 WHERE id = $1", [
      ids.rec1,
      at(minute),
    ]);
  const exportRecipe = async (): Promise<Rec> =>
    (await walk("recipes")).records.find((r) => r.id === ids.rec1)!;
  const edgeLineIds = async () => Object.keys(await edgeLines()).sort();

  it("97p a recipe record carries all its lines (full rows), not a list of ids", async () => {
    const recipe = await exportRecipe();
    expect(recipe).not.toHaveProperty("lineIds");
    const lines = recipe.lines as Rec[];
    expect(idsOf(lines)).toEqual([ids.line1, ids.line2].sort());
    const one = lines.find((l) => l.id === ids.line1)!;
    expect(one.quantity).toBe("2.5000");
    expect(one.wastePctBp).toBe(150);
    expect(lines.find((l) => l.id === ids.line2)!.quantity).toBe("0.1250");
  });

  it("97p a new recipe version replaces the whole line set: changed, removed and added lines, never a mix of two versions", async () => {
    await edgeApplyAll(await exportMine());
    expect(await edgeLines()).toEqual({
      [ids.line1]: "2.5000",
      [ids.line2]: "0.1250",
    });
    // Cloud edit: line1 changes, line2 is removed, line3 is new.
    await mainOwner.query("DELETE FROM recipe_lines WHERE id = $1", [
      ids.line2,
    ]);
    await mainOwner.query(
      "UPDATE recipe_lines SET quantity = '3.0000' WHERE id = $1",
      [ids.line1],
    );
    await mainOwner.query(
      `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1,$2,$3,2,'item',gen_random_uuid(),'0.5000',$4,0)`,
      [ids.line3, tenantId, ids.rec1, uomId],
    );
    await bumpCloudRecipe(35);
    try {
      const recipe = await exportRecipe();
      expect(idsOf(recipe.lines)).toEqual([ids.line1, ids.line3].sort());
      await edgeApply("recipes", [recipe]);
      expect(await edgeLines()).toEqual({
        [ids.line1]: "3.0000",
        [ids.line3]: "0.5000",
      });
    } finally {
      await restoreCloudRecipe();
    }
  });

  it("97p a recipe line removed in the cloud disappears on the edge", async () => {
    await edgeApplyAll(await exportMine());
    expect(await edgeLineIds()).toHaveLength(2);
    await mainOwner.query("DELETE FROM recipe_lines WHERE id = $1", [
      ids.line2,
    ]);
    await bumpCloudRecipe(33);
    try {
      const recipe = await exportRecipe();
      expect(idsOf(recipe.lines)).toEqual([ids.line1]);
      await edgeApply("recipes", [recipe]);
      expect(await edgeLineIds()).toEqual([ids.line1]);
    } finally {
      await restoreCloudRecipe();
    }
  });

  it("97p a recipe whose lines were all removed leaves no lines on the edge", async () => {
    await edgeApplyAll(await exportMine());
    expect(await edgeLineIds()).toHaveLength(2);
    await mainOwner.query("DELETE FROM recipe_lines WHERE recipe_id = $1", [
      ids.rec1,
    ]);
    await bumpCloudRecipe(34);
    try {
      const recipe = await exportRecipe();
      expect(recipe.lines).toEqual([]);
      await edgeApply("recipes", [recipe]);
      expect(await edgeLineIds()).toEqual([]);
      // The recipe itself stays.
      expect(
        await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.rec1]),
      ).toHaveLength(1);
    } finally {
      await restoreCloudRecipe();
    }
  });

  it("97p a recipe version that cannot be stored leaves the previous complete version (header and lines) untouched", async () => {
    await edgeApplyAll(await exportMine());
    const stampBefore = await edgeRecipeStamp();
    await mainOwner.query(
      "UPDATE recipe_lines SET quantity = '7.7777' WHERE id = $1",
      [ids.line2],
    );
    await mainOwner.query(
      "UPDATE recipe_lines SET quantity = '3.0000' WHERE id = $1",
      [ids.line1],
    );
    await bumpCloudRecipe(36);
    // The edge refuses one line, so the new version cannot be stored whole.
    await edge.owner.query(
      `ALTER TABLE recipe_lines ADD CONSTRAINT test_refuse_77777 CHECK (quantity <> 7.7777)`,
    );
    try {
      const recipe = await exportRecipe();
      await expect(edgeApply("recipes", [recipe])).rejects.toBeDefined();
      // Neither a new header nor half of the new lines.
      expect(await edgeLines()).toEqual({
        [ids.line1]: "2.5000",
        [ids.line2]: "0.1250",
      });
      expect(await edgeRecipeStamp()).toBe(stampBefore);
    } finally {
      await edge.owner.query(
        `ALTER TABLE recipe_lines DROP CONSTRAINT test_refuse_77777`,
      );
      await restoreCloudRecipe();
    }
  });

  it("97p lines of another recipe are not touched by a recipe apply", async () => {
    await edgeApplyAll(await exportMine());
    const other = id();
    await edge.owner.query(
      `INSERT INTO recipes (id, tenant_id, brand_id, name, yield_quantity, yield_uom_id, is_active, updated_by)
       VALUES ($1,$2,$3,'Resep lain','1.0000',$4,true,$5)`,
      [other, tenantId, brandId, uomId, userId],
    );
    const otherLine = id();
    await edge.owner.query(
      `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id)
       VALUES ($1,$2,$3,0,'item',$4,'1.0000',$5)`,
      [otherLine, tenantId, other, id(), uomId],
    );
    await edgeApply("recipes", [await exportRecipe()]);
    expect(
      await edge.rows("SELECT id FROM recipe_lines WHERE id = $1", [otherLine]),
    ).toHaveLength(1);
  });

  // ---- price lists always travel with their items

  const restoreCloudPriceList = async () => {
    await mainOwner.query(
      `UPDATE price_list_items SET deleted_at = NULL, updated_at = $2 WHERE id = $1`,
      [ids.pliBad, at(16)],
    );
    await mainOwner.query(
      "UPDATE price_lists SET updated_at = $2 WHERE id = $1",
      [ids.pl1, at(10)],
    );
  };
  const exportList = async (): Promise<Rec> =>
    (await walk("price_lists")).records.find((r) => r.id === ids.pl1)!;

  it("97p a price list record carries all its active items with exact prices", async () => {
    const list = await exportList();
    expect(list).not.toHaveProperty("itemIds");
    const items = list.items as Rec[];
    expect(idsOf(items)).toEqual([...MINE.price_list_items].sort());
    const byId = new Map(items.map((i) => [String(i.id), i]));
    expect(byId.get(ids.pli1)!.priceIdr).toBe(PRICE.pli1);
    expect(byId.get(ids.pli2)!.priceIdr).toBe(PRICE.pli2);
    expect(byId.get(ids.pli3)!.priceIdr).toBe(PRICE.pli3);
    expect(byId.get(ids.pli2)!.variantId).toBe(ids.var1);
    // Another outlet's item is not in this outlet's list.
    expect(byId.has(ids.pliO2)).toBe(false);
  });

  it("97p every exported price list holds exactly the active items the cloud has for it (a header without its items cannot happen)", async () => {
    const { records } = await walk("price_lists");
    expect(records.length).toBeGreaterThan(0);
    for (const list of records) {
      const cloud = (
        await mainOwner.query(
          `SELECT id FROM price_list_items WHERE price_list_id = $1 AND deleted_at IS NULL ORDER BY id`,
          [list.id],
        )
      ).rows.map((r) => String(r.id));
      expect(idsOf(list.items)).toEqual(cloud);
    }
  });

  it("97p an item removed in the cloud leaves the price list record and disappears on the edge", async () => {
    await edgeApplyAll(await exportMine());
    expect(await edgeItemIdsOfList()).toContain(ids.pliBad);
    await mainOwner.query(
      `UPDATE price_list_items SET deleted_at = $2, updated_at = $2 WHERE id = $1`,
      [ids.pliBad, at(37)],
    );
    // The cloud bumps the list's updated_at on every item change.
    await mainOwner.query(
      "UPDATE price_lists SET updated_at = $2 WHERE id = $1",
      [ids.pl1, at(37)],
    );
    try {
      const list = await exportList();
      expect(idsOf(list.items)).not.toContain(ids.pliBad);
      await edgeApply("price_lists", [list]);
      const left = await edgeItemIdsOfList();
      expect(left).not.toContain(ids.pliBad);
      expect(left).toEqual(
        MINE.price_list_items.filter((x) => x !== ids.pliBad).sort(),
      );
      expect(await edgeListHeaders()).toBe(1);
    } finally {
      await restoreCloudPriceList();
    }
  });

  it("97p a price list that cannot be stored whole is not stored at all: no header without its items", async () => {
    // The edge refuses one price, so one item of the list cannot be stored.
    await edge.owner.query(
      `ALTER TABLE price_list_items ADD CONSTRAINT test_refuse_77777 CHECK (price_idr <> 77777)`,
    );
    try {
      const data = await exportMine();
      for (const stream of ORDER.filter((s) => s !== "price_lists"))
        await edgeApply(stream, data[stream]);
      await expect(
        edgeApply("price_lists", data.price_lists),
      ).rejects.toBeDefined();
      expect(await edgeListHeaders()).toBe(0);
      expect(await edgeItemIdsOfList()).toEqual([]);
    } finally {
      await edge.owner.query(
        `ALTER TABLE price_list_items DROP CONSTRAINT test_refuse_77777`,
      );
    }
  });

  // ---- missing references

  it("24318 a recipe whose updated_by user is unknown on the edge is stored with a NULL updated_by and reported in nulledRefs (the page is not refused)", async () => {
    const data = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "recipes"))
      await edgeApply(stream, data[stream]);
    const bad = { ...data.recipes[0]!, updatedBy: `tak-ada-${id()}` };
    const result = await edgeApply("recipes", [bad]);
    expect(nulledCount(result)).toBeGreaterThan(0);
    const row = (
      await edge.rows("SELECT updated_by FROM recipes WHERE id = $1", [
        ids.rec1,
      ])
    )[0];
    expect(row).toBeDefined();
    expect(row!.updated_by).toBeNull();
    // The recipe arrives whole, lines included.
    expect(await edgeLineIds()).toHaveLength(2);
  });

  it("24318 a recipe output_item_id that is not on the edge is refused with CATALOG_MISSING_REF (transient) and nothing of the recipe is stored", async () => {
    const data = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "recipes"))
      await edgeApply(stream, data[stream]);
    const withOutput = { ...data.recipes[0]!, outputItemId: id() };
    await expect(edgeApply("recipes", [withOutput])).rejects.toMatchObject({
      code: "CATALOG_MISSING_REF",
    });
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.rec1]),
    ).toHaveLength(0);
    expect(await edgeLineIds()).toEqual([]);
  });

  it("24318 a recipe output_item_id and a menu item station_id that DID arrive are kept (stations and inventory_items are synced)", async () => {
    const data = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "recipes"))
      await edgeApply(stream, data[stream]);
    const result = await edgeApply("recipes", [
      { ...data.recipes[0]!, outputItemId: ids.inv1 },
    ]);
    expect(nulledCount(result)).toBe(0);
    expect(
      (
        await edge.rows("SELECT output_item_id FROM recipes WHERE id = $1", [
          ids.rec1,
        ])
      )[0]!.output_item_id,
    ).toBe(ids.inv1);
    expect(
      (
        await edge.rows("SELECT station_id FROM menu_items WHERE id = $1", [
          ids.itemStn,
        ])
      )[0]!.station_id,
    ).toBe(ids.stn1);
  });

  it("24318 a station_id that is not on the edge is refused with CATALOG_MISSING_REF (transient) on a menu item and on a modifier; nothing is stored", async () => {
    const data = await exportMine();
    await edgeApply("menu_categories", data.menu_categories);
    const item: Rec = { ...data.menu_items[0]!, stationId: id() };
    await expect(edgeApply("menu_items", [item])).rejects.toMatchObject({
      code: "CATALOG_MISSING_REF",
    });
    expect(
      await edge.rows("SELECT id FROM menu_items WHERE id = $1", [
        String(item.id),
      ]),
    ).toHaveLength(0);

    await edgeApply("modifier_groups", data.modifier_groups);
    const modifier: Rec = { ...data.modifiers[0]!, stationId: id() };
    await expect(edgeApply("modifiers", [modifier])).rejects.toMatchObject({
      code: "CATALOG_MISSING_REF",
    });
    expect(
      await edge.rows("SELECT id FROM modifiers WHERE id = $1", [
        String(modifier.id),
      ]),
    ).toHaveLength(0);
  });

  it("97p a category whose parent is not on the edge yet is stored with a NULL parent instead of failing", async () => {
    const data = await exportMine();
    const child = { ...data.menu_categories[0]!, id: id(), parentId: id() };
    await edgeApply("menu_categories", [child]);
    const row = (
      await edge.rows(
        "SELECT id, parent_id FROM menu_categories WHERE id = $1",
        [child.id],
      )
    )[0]!;
    expect(row.parent_id).toBeNull();
  });
});

// ------------------------------------------------ 4 and 5 resume and failure

describe("97p edge pull: resume and broken connection", () => {
  const checkpointStreams = async () =>
    (await checkpoints()).map((r) => String(r.stream));

  it("97p a full pull makes the edge equal the cloud and stores a checkpoint per stream", async () => {
    const cloud = scriptedCloud(await exportMine(), 100);
    const result = await pullOk(cloud);
    for (const stream of ORDER)
      expect(result.streams[stream]?.error).toBeFalsy();
    await expectEdgeEqualsCloud();
    const stored = await checkpointStreams();
    for (const stream of ORDER) expect(stored).toContain(`catalog:${stream}`);
    expect(stored).not.toContain("catalog:price_list_items");
    expect(stored).not.toContain("catalog:recipe_lines");
  });

  it("24318 pulling real cloud pages converges, is repeatable and keeps the stored cursors in the cat2 shape", async () => {
    const live = {
      fetchPage: async (stream: Stream, since: string | null) =>
        cloudPage(stream, {
          limit: 100,
          ...(since === null ? {} : { since }),
        }).then((page) => ({
          ...page,
          records: page.records.filter((r) => isMine(stream, r)),
        })),
    };
    await pullOk(live);
    await expectEdgeEqualsCloud();
    await pullOk(live);
    await expectEdgeEqualsCloud();
    expect(await edgePriceRows()).toHaveLength(MINE.price_list_items.length);
    expect(await edgeLineIds()).toHaveLength(MINE.recipe_lines.length);
    for (const row of await checkpoints()) {
      if (row.watermark === null) {
        // This legacy fixture owns no printer/promo/voucher documents; an
        // empty stream still has a successful checkpoint, with no cursor yet.
        expect([
          "catalog:printers",
          "catalog:promotions",
          "catalog:vouchers",
        ]).toContain(row.stream);
      } else expect(decodeCursor(String(row.watermark))[0]).toBe("cat2");
    }
  });

  it("24318 a checkpoint left by the old time cursor (cat1) is treated as none: the next pull starts from the beginning and converges", async () => {
    const data = await exportMine();
    const cloud = scriptedCloud(data, 100);
    await pullOk(cloud);
    await edge.owner.query(
      "UPDATE edge_pull_checkpoints SET watermark = $2 WHERE edge_node_id = $1 AND stream LIKE 'catalog:%'",
      [node.id, encodeCursor(["cat1", "2025-06-01T00:00:00.000000Z", id()])],
    );
    const before = cloud.calls.length;
    const result = await pullOk(cloud);
    for (const stream of ORDER)
      expect(result.streams[stream]?.error).toBeFalsy();
    const firstCallOf = (stream: Stream) =>
      cloud.calls.slice(before).find((c) => c.stream === stream);
    for (const stream of ORDER) expect(firstCallOf(stream)?.since).toBeNull();
    await expectEdgeEqualsCloud();
    for (const row of await checkpoints()) {
      if (row.watermark === null) {
        expect([
          "catalog:printers",
          "catalog:promotions",
          "catalog:vouchers",
        ]).toContain(row.stream);
      } else expect(decodeCursor(String(row.watermark))[0]).toBe("cat2");
    }
  });

  const edgeLineIds = async () => Object.keys(await edgeLines()).sort();
  const edgeItemRows = () =>
    edge.rows("SELECT id FROM menu_items WHERE id = ANY($1::uuid[])", [
      MINE.menu_items,
    ]);

  it("97p a cut after page 1 keeps checkpoint = page 1, and the next pull resumes from it", async () => {
    const data = await exportMine();
    const cloud = scriptedCloud(data, 2);
    cloud.breakAt("menu_items", 2);
    const first = await pullOk(cloud);
    expect(first.streams.menu_items?.error).toBeTruthy();

    const [one, two] = data.menu_items;
    const page1Cursor = cloud.cursorAfter("menu_items", 2);
    // Page 1 is applied, nothing of page 2 or later.
    expect((await edgeItemRows()).map((r) => String(r.id)).sort()).toEqual(
      [String(one!.id), String(two!.id)].sort(),
    );
    const stored = (await checkpoints()).find(
      (r) => r.stream === "catalog:menu_items",
    );
    expect(stored?.watermark).toBe(page1Cursor);

    const before = cloud.calls.length;
    cloud.heal();
    await pullOk(cloud);
    const resumed = cloud.calls
      .slice(before)
      .filter((c) => c.stream === "menu_items");
    expect(resumed[0]!.since).toBe(page1Cursor);

    // Final state == cloud, no duplicated rows, prices exact.
    await expectEdgeEqualsCloud();
    expect(await edgeItemRows()).toHaveLength(MINE.menu_items.length);
    const rows = await edgePriceRows();
    expect(rows).toHaveLength(MINE.price_list_items.length);
    expect(await edgePrice(ids.pli1)).toBe(String(PRICE.pli1));
    expect(await edgePrice(ids.pli3)).toBe(String(PRICE.pli3));
  });

  it("97p a failed apply rolls the whole price list back (header and items), does not move its checkpoint, and the other streams still run", async () => {
    const data = await exportMine();
    const cloud = scriptedCloud(data, 100);
    // The edge refuses one price, so the price list cannot be stored whole.
    await edge.owner.query(
      `ALTER TABLE price_list_items ADD CONSTRAINT test_refuse_77777 CHECK (price_idr <> 77777)`,
    );
    try {
      const result = await pullOk(cloud);
      expect(result.streams.price_lists?.error).toBeTruthy();
      // No half list: no valid sibling item and no header either.
      expect(await edgePriceRows()).toHaveLength(0);
      expect(await edgeListHeaders()).toBe(0);
      expect(await checkpointStreams()).not.toContain("catalog:price_lists");
      // Isolation: the recipes stream (after price_lists) was still pulled.
      expect(result.streams.recipes?.error).toBeFalsy();
      expect(
        await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.rec1]),
      ).toHaveLength(1);
      expect(await checkpointStreams()).toContain("catalog:recipes");
    } finally {
      await edge.owner.query(
        `ALTER TABLE price_list_items DROP CONSTRAINT test_refuse_77777`,
      );
    }
    // Once the edge accepts it, the next pull completes from where it stood.
    const healed = await pullOk(cloud);
    expect(healed.streams.price_lists?.error).toBeFalsy();
    await expectEdgeEqualsCloud();
    expect(await edgePrice(ids.pliBad)).toBe(String(PRICE.pliBad));
  });

  it("97p a broken connection stops only that stream: its checkpoint stays, the others complete, the next pull finishes it", async () => {
    const cloud = scriptedCloud(await exportMine(), 100);
    cloud.breakAt("modifiers", 1);
    const result = await pullOk(cloud);
    expect(result.streams.modifiers?.error).toBeTruthy();
    const stored = await checkpointStreams();
    expect(stored).not.toContain("catalog:modifiers");
    for (const stream of ORDER.filter((s) => s !== "modifiers")) {
      expect(result.streams[stream]?.error).toBeFalsy();
      expect(stored).toContain(`catalog:${stream}`);
    }
    expect(
      await edge.rows("SELECT id FROM modifiers WHERE id = $1", [ids.mod1]),
    ).toHaveLength(0);
    expect(await edgePriceRows()).toHaveLength(MINE.price_list_items.length);

    cloud.heal();
    await pullOk(cloud);
    await expectEdgeEqualsCloud();
    expect(await checkpointStreams()).toContain("catalog:modifiers");
  });

  it("24318 a recipe whose updated_by is unknown on the edge never sticks the stream: it is stored with NULL updated_by, the checkpoint moves and later pulls stay quiet", async () => {
    const data = await exportMine();
    data.recipes = [{ ...data.recipes[0]!, updatedBy: `tak-ada-${id()}` }];
    const cloud = scriptedCloud(data, 100);
    const result = await pullOk(cloud);
    expect(result.streams.recipes?.error).toBeFalsy();
    expect(await checkpointStreams()).toContain("catalog:recipes");
    const row = (
      await edge.rows("SELECT updated_by FROM recipes WHERE id = $1", [
        ids.rec1,
      ])
    )[0];
    expect(row?.updated_by).toBeNull();
    expect(await edgeLineIds()).toHaveLength(2);
    // Nothing left to retry: the next pull completes the same way.
    const again = await pullOk(cloud);
    expect(again.streams.recipes?.error).toBeFalsy();
  });

  it("24318 a recipe output_item_id that is not on the edge is transient: the recipes checkpoint stays, the other streams run, and once the item exists the recipe is stored", async () => {
    const data = await exportMine();
    const good = data.recipes;
    data.recipes = [{ ...good[0]!, outputItemId: id() }];
    const cloud = scriptedCloud(data, 100);
    const result = await pullOk(cloud);
    expect(result.streams.recipes?.error).toBeTruthy();
    expect(await checkpointStreams()).not.toContain("catalog:recipes");
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.rec1]),
    ).toHaveLength(0);
    // 0374: menu rows may point at recipes (composite FK), so they wait for
    // the recipes stream; a stream with no recipe link still runs.
    expect(result.streams.menu_items?.error).toMatchObject({
      code: "CATALOG_PARENT_FAILED",
    });
    expect(result.streams.menu_categories?.error).toBeFalsy();
    // The cloud now sends a reference the edge knows (inventory item arrived).
    data.recipes = [{ ...good[0]!, outputItemId: ids.inv1 }];
    const healed = await pullOk(cloud);
    expect(healed.streams.recipes?.error).toBeFalsy();
    expect(await checkpointStreams()).toContain("catalog:recipes");
    expect(
      (
        await edge.rows("SELECT output_item_id FROM recipes WHERE id = $1", [
          ids.rec1,
        ])
      )[0]!.output_item_id,
    ).toBe(ids.inv1);
  });

  const errorText = (error: unknown) =>
    error instanceof Error
      ? `${(error as { code?: string }).code ?? ""} ${error.name} ${error.message}`
      : JSON.stringify(error);

  it("24318 when stations fail, menu_items and modifiers are skipped (CATALOG_PARENT_FAILED, not fetched, checkpoints untouched) while independent streams still run", async () => {
    const cloud = scriptedCloud(await exportMine(), 100);
    cloud.breakAt("stations", 1);
    const result = await pullOk(cloud);
    expect(result.streams.stations?.error).toBeTruthy();
    for (const stream of ["menu_items", "modifiers"] as const) {
      expect(errorText(result.streams[stream]?.error), stream).toContain(
        "CATALOG_PARENT_FAILED",
      );
      expect(
        cloud.calls.some((c) => c.stream === stream),
        stream,
      ).toBe(false);
    }
    const stored = await checkpointStreams();
    for (const stream of ["stations", "menu_items", "modifiers"])
      expect(stored).not.toContain(`catalog:${stream}`);
    expect(stored).toContain("catalog:menu_categories");
    expect(stored).toContain("catalog:modifier_groups");
    expect(
      await edge.rows("SELECT id FROM menu_items WHERE id = ANY($1::uuid[])", [
        MINE.menu_items,
      ]),
    ).toHaveLength(0);

    // Stations recover: the next pull completes everything.
    cloud.heal();
    const healed = await pullOk(cloud);
    for (const stream of ORDER)
      expect(healed.streams[stream]?.error, stream).toBeFalsy();
    await expectEdgeEqualsCloud();
  });

  it("24318 when inventory_items fail, recipes are skipped (CATALOG_PARENT_FAILED, not fetched, checkpoint untouched)", async () => {
    const cloud = scriptedCloud(await exportMine(), 100);
    cloud.breakAt("inventory_items", 1);
    const result = await pullOk(cloud);
    expect(result.streams.inventory_items?.error).toBeTruthy();
    expect(errorText(result.streams.recipes?.error)).toContain(
      "CATALOG_PARENT_FAILED",
    );
    expect(cloud.calls.some((c) => c.stream === "recipes")).toBe(false);
    const stored = await checkpointStreams();
    expect(stored).not.toContain("catalog:recipes");
    expect(stored).not.toContain("catalog:inventory_items");
    // menu_items and item_variants point at recipes (legend-3kdd), so they are
    // skipped too. Modifiers carry a recipe id with NO foreign key on the edge
    // (the recipe may belong to another brand and never be delivered), so the
    // modifiers stream does not wait for recipes and still runs.
    for (const stream of ["menu_items", "item_variants"] as const) {
      expect(errorText(result.streams[stream]?.error), stream).toContain(
        "CATALOG_PARENT_FAILED",
      );
      expect(stored).not.toContain(`catalog:${stream}`);
    }
    expect(result.streams.modifiers?.error).toBeFalsy();
    expect(stored).toContain("catalog:modifiers");
    expect(result.streams.menu_categories?.error).toBeFalsy();
    expect(stored).toContain("catalog:menu_categories");

    cloud.heal();
    const healed = await pullOk(cloud);
    expect(healed.streams.recipes?.error).toBeFalsy();
    await expectEdgeEqualsCloud();
  });

  it("legend-3kdd a modifier whose recipe belongs to another brand and is not delivered to this edge still syncs: row stored with its recipe_id, checkpoint stored, never CATALOG_PARENT_FAILED", async () => {
    // Assumption: a modifier is tenant-wide, so its recipe may be a recipe of
    // another brand (ids.recBr2, brand2) that the edge of O1 (brand A) never
    // receives. The edge must not refuse the modifier for that.
    const data = await exportMine();
    expect(idsOf(data.recipes)).not.toContain(ids.recBr2);
    data.modifiers = [{ ...data.modifiers[0]!, recipeId: ids.recBr2 }];
    const cloud = scriptedCloud(data, 100);
    const result = await pullOk(cloud);
    expect(result.streams.recipes?.error).toBeFalsy();
    expect(result.streams.modifiers?.error).toBeFalsy();
    // The foreign recipe is not on the edge, yet the modifier points at it.
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.recBr2]),
    ).toHaveLength(0);
    const rows = await edge.rows(
      "SELECT id, recipe_id FROM modifiers WHERE id = $1",
      [ids.mod1],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipe_id).toBe(ids.recBr2);
    expect(await checkpointStreams()).toContain("catalog:modifiers");
  });

  it("legend-3kdd the edge database is migrated in edge mode: no modifiers_recipe_fk, but menu_items and item_variants keep theirs", async () => {
    const rows = await edge.rows(
      `SELECT conrelid::regclass::text AS tbl FROM pg_constraint
        WHERE conname IN ('menu_items_recipe_fk', 'item_variants_recipe_fk', 'modifiers_recipe_fk')
        ORDER BY 1`,
    );
    expect(rows.map((r) => String(r.tbl))).toEqual([
      "item_variants",
      "menu_items",
    ]);
  });

  it("legend-3kdd when the recipes stream fails, modifiers still run while menu_items and item_variants are skipped with CATALOG_PARENT_FAILED", async () => {
    const cloud = scriptedCloud(await exportMine(), 100);
    cloud.breakAt("recipes", 1);
    const result = await pullOk(cloud);
    expect(result.streams.recipes?.error).toBeTruthy();
    expect(errorText(result.streams.recipes?.error)).not.toContain(
      "CATALOG_PARENT_FAILED",
    );
    expect(result.streams.modifiers?.error).toBeFalsy();
    expect(cloud.calls.some((c) => c.stream === "modifiers")).toBe(true);
    for (const stream of ["menu_items", "item_variants"] as const) {
      expect(errorText(result.streams[stream]?.error), stream).toContain(
        "CATALOG_PARENT_FAILED",
      );
      expect(
        cloud.calls.some((c) => c.stream === stream),
        stream,
      ).toBe(false);
    }
    const stored = await checkpointStreams();
    expect(stored).toContain("catalog:modifiers");
    for (const stream of ["recipes", "menu_items", "item_variants"])
      expect(stored).not.toContain(`catalog:${stream}`);
    expect(
      await edge.rows("SELECT id FROM modifiers WHERE id = $1", [ids.mod1]),
    ).toHaveLength(1);
  });

  it("24318 a full pull resets local sync_txid first: an edge row with a huge local txid is corrected by the cloud's smaller txid (empty checkpoints and cat1 checkpoints)", async () => {
    const data = await exportMine();
    const cloud = scriptedCloud(data, 100);
    await pullOk(cloud);
    const huge = "9000000000000000000";
    const poison = () =>
      edgeWriteKeepingTxid([
        [
          `UPDATE menu_categories SET name = 'Lokal besar', sync_txid = ${huge} WHERE id = $1`,
          [ids.cat1],
        ],
        [
          `UPDATE price_list_items SET price_idr = 111 WHERE id = $1`,
          [ids.pli1],
        ],
        [`UPDATE price_lists SET sync_txid = ${huge} WHERE id = $1`, [ids.pl1]],
      ]);

    // (a) checkpoints gone: a full pull.
    await poison();
    await edge.owner.query("DELETE FROM edge_pull_checkpoints");
    await pullOk(cloud);
    await expectEdgeEqualsCloud();
    expect(await edgePrice(ids.pli1)).toBe(String(PRICE.pli1));

    // (b) a cat1 checkpoint counts as no checkpoint.
    await poison();
    await edge.owner.query(
      "UPDATE edge_pull_checkpoints SET watermark = $2 WHERE edge_node_id = $1 AND stream LIKE 'catalog:%'",
      [node.id, encodeCursor(["cat1", "2025-06-01T00:00:00.000000Z", id()])],
    );
    await pullOk(cloud);
    await expectEdgeEqualsCloud();
    expect(await edgePrice(ids.pli1)).toBe(String(PRICE.pli1));
  });

  it("24318 a full pull repairs references that an older edge had set to NULL (station_id, output_item_id)", async () => {
    // Cloud: the recipe names an output inventory item.
    await mainOwner.query(
      "UPDATE recipes SET output_item_id = $2, updated_at = $3 WHERE id = $1",
      [ids.rec1, ids.inv1, at(60)],
    );
    try {
      const cloud = scriptedCloud(await exportMine(), 100);
      await pullOk(cloud);
      await expectEdgeEqualsCloud();
      // An older edge had nulled both references.
      await edgeWriteKeepingTxid([
        [
          `UPDATE menu_items SET station_id = NULL WHERE id = $1`,
          [ids.itemStn],
        ],
        [`UPDATE recipes SET output_item_id = NULL WHERE id = $1`, [ids.rec1]],
      ]);
      await edge.owner.query("DELETE FROM edge_pull_checkpoints");
      await pullOk(scriptedCloud(await exportMine(), 100));
      expect(
        (
          await edge.rows("SELECT station_id FROM menu_items WHERE id = $1", [
            ids.itemStn,
          ])
        )[0]!.station_id,
      ).toBe(ids.stn1);
      expect(
        (
          await edge.rows("SELECT output_item_id FROM recipes WHERE id = $1", [
            ids.rec1,
          ])
        )[0]!.output_item_id,
      ).toBe(ids.inv1);
    } finally {
      await mainOwner.query(
        "UPDATE recipes SET output_item_id = NULL, updated_at = $2 WHERE id = $1",
        [ids.rec1, at(18)],
      );
    }
  });

  it("97p a category whose parent arrives later in the same pull gets its parent set by the repair pass; a parent that never arrives stays NULL without failing", async () => {
    const data = await exportMine();
    const template = data.menu_categories[0]!;
    const parent = { ...template, id: id(), name: "Induk uji", parentId: null };
    const child = {
      ...template,
      id: id(),
      name: "Anak uji",
      parentId: parent.id,
    };
    const orphan = {
      ...template,
      id: id(),
      name: "Yatim uji",
      parentId: id(),
    };
    // The child comes BEFORE its parent; one record per page.
    data.menu_categories = [child, orphan, parent, ...data.menu_categories];
    const cloud = scriptedCloud(data, 1);
    const result = await pullOk(cloud);
    expect(result.streams.menu_categories?.error).toBeFalsy();
    const rows = await edge.rows(
      "SELECT id, parent_id FROM menu_categories WHERE id = ANY($1::uuid[])",
      [[child.id, orphan.id, parent.id]],
    );
    const parentOf = Object.fromEntries(
      rows.map((r) => [String(r.id), r.parent_id]),
    );
    expect(parentOf[parent.id]).toBeNull();
    expect(parentOf[child.id]).toBe(parent.id);
    expect(parentOf[orphan.id]).toBeNull();
    expect(await checkpointStreams()).toContain("catalog:menu_categories");
    // The streams after categories were not held up.
    expect(await edgePriceRows()).toHaveLength(MINE.price_list_items.length);
  });

  it("97p a pull never changes the cloud catalog (read-only path)", async () => {
    const before = await cloudFingerprint();
    await pull(scriptedCloud(await exportMine(), 2));
    expect(await cloudFingerprint()).toBe(before);
  });
});

// ----------------------------------------------------------------- 6 money

describe("97p money: prices are copied exactly", () => {
  /** Cloud price change; like the cloud service, it bumps the list's updated_at. */
  const setCloudPrice = async (price: number, minute: number) => {
    await mainOwner.query(
      `UPDATE price_list_items SET price_idr = $2, updated_at = $3 WHERE id = $1`,
      [ids.pliChg, price, at(minute)],
    );
    await mainOwner.query(
      "UPDATE price_lists SET updated_at = $2 WHERE id = $1",
      [ids.pl1, at(minute)],
    );
  };
  const exportList = async (): Promise<Rec> =>
    (await walk("price_lists")).records.find((r) => r.id === ids.pl1)!;
  const priceInList = (list: Rec): unknown =>
    (list.items as Rec[]).find((i) => i.id === ids.pliChg)!.priceIdr;

  it("97p edge prices equal cloud prices to the rupiah, odd amounts included", async () => {
    await edgeApplyAll(await exportMine());
    expect(await edgePrice(ids.pli1)).toBe("18750");
    expect(await edgePrice(ids.pli2)).toBe("21250");
    expect(await edgePrice(ids.pli3)).toBe("1234567");
    expect(
      (
        await edge.rows(
          "SELECT price_idr::text AS p FROM modifiers WHERE id = $1",
          [ids.mod1],
        )
      )[0]?.p,
    ).toBe("3500");
    for (const row of await edgePriceRows()) {
      const cloud = (
        await mainOwner.query(
          "SELECT price_idr::text AS price FROM price_list_items WHERE id = $1",
          [row.id],
        )
      ).rows[0];
      expect(row.price).toBe(cloud.price);
    }
  });

  it("97p a changed price replaces the old one on the next pull", async () => {
    await edgeApplyAll(await exportMine());
    expect(await edgePrice(ids.pliChg)).toBe(String(PRICE.pliChg));
    await setCloudPrice(20000, 40);
    await edgeApplyAll(await exportMine());
    expect(await edgePrice(ids.pliChg)).toBe("20000");
  });

  it("97p an old price never overwrites a newer one (repeated page, reversed order, rewound cursor)", async () => {
    // Cloud price goes 20000 -> 25000; "old" and "new" are both real exports.
    await setCloudPrice(20000, 41);
    const old = await exportList();
    await setCloudPrice(25000, 42);
    const fresh = await exportList();
    expect(priceInList(old)).toBe(20000);
    expect(priceInList(fresh)).toBe(25000);
    const parents = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "price_lists"))
      await edgeApply(stream, parents[stream]);

    // new first, then the older one arrives late.
    await edgeApply("price_lists", [fresh]);
    await edgeApply("price_lists", [old]);
    expect(await edgePrice(ids.pliChg)).toBe("25000");
    // The same old page again and again.
    await edgeApply("price_lists", [old]);
    await edgeApply("price_lists", [fresh]);
    await edgeApply("price_lists", [old]);
    expect(await edgePrice(ids.pliChg)).toBe("25000");

    // A pull whose cursor is rewound re-serves old pages: same end state.
    const cloud = scriptedCloud({ ...parents, price_lists: [fresh, old] }, 1);
    await pull(cloud);
    expect(await edgePrice(ids.pliChg)).toBe("25000");
  });

  it("97p two pulls at the same time never let the old price win", async () => {
    await setCloudPrice(20000, 43);
    const old = await exportList();
    await setCloudPrice(25000, 44);
    const fresh = await exportList();
    const parents = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "price_lists"))
      await edgeApply(stream, parents[stream]);

    // Raw applies racing each other, both start orders, several rounds.
    for (let round = 0; round < 8; round += 1) {
      await edge.owner.query("DELETE FROM price_list_items");
      await edge.owner.query("DELETE FROM price_lists");
      const calls =
        round % 2 === 0
          ? [edgeApply("price_lists", [old]), edgeApply("price_lists", [fresh])]
          : [
              edgeApply("price_lists", [fresh]),
              edgeApply("price_lists", [old]),
            ];
      await Promise.all(calls);
      expect(await edgePrice(ids.pliChg)).toBe("25000");
      expect(await edgeListHeaders()).toBe(1);
      expect(await edgePriceRows()).toHaveLength(MINE.price_list_items.length);
    }

    // The same through two whole pulls running at once.
    await edge.owner.query("DELETE FROM price_list_items");
    await edge.owner.query("DELETE FROM price_lists");
    await Promise.all([
      pull(scriptedCloud({ ...parents, price_lists: [old] }, 100)),
      // Preserve the scripted cursor's old prefix: resuming at index 1 must
      // deliver the fresh version instead of skipping a replaced array slot.
      pull(scriptedCloud({ ...parents, price_lists: [old, fresh] }, 100)),
    ]);
    expect(await edgePrice(ids.pliChg)).toBe("25000");
    expect(await edgeListHeaders()).toBe(1);
  });

  it("97p prices stay exact after a resume and after a re-update", async () => {
    const data = await exportMine();
    const cloud = scriptedCloud(data, 2);
    cloud.breakAt("menu_items", 2);
    await pullOk(cloud);
    cloud.heal();
    await pullOk(cloud);
    for (const key of ["pli1", "pli2", "pli3", "pliBad"] as const)
      expect(await edgePrice(ids[key])).toBe(String(PRICE[key]));
    // Same data pulled again: nothing drifts.
    await pullOk(scriptedCloud(await exportMine(), 100));
    for (const key of ["pli1", "pli2", "pli3", "pliBad"] as const)
      expect(await edgePrice(ids[key])).toBe(String(PRICE[key]));
  });

  it("24318 a lower sync_txid never overwrites a higher one even when its updatedAt is newer (txid is the only order), and a strictly higher txid does replace the price", async () => {
    await setCloudPrice(20000, 45);
    const old = await exportList();
    await setCloudPrice(25000, 46);
    const fresh = await exportList();
    expect(BigInt(String(fresh.syncTxid))).toBeGreaterThan(
      BigInt(String(old.syncTxid)),
    );
    // A forged "old" page whose clock says it is the newest.
    const lowTxid: Rec = {
      ...old,
      updatedAt: "2099-01-01T00:00:00.000Z",
      items: (old.items as Rec[]).map((i) => ({
        ...i,
        updatedAt: "2099-01-01T00:00:00.000Z",
      })),
    };
    const parents = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "price_lists"))
      await edgeApply(stream, parents[stream]);
    await edgeApply("price_lists", [fresh]);
    await edgeApply("price_lists", [lowTxid]);
    expect(await edgePrice(ids.pliChg)).toBe("25000");
    // And a strictly higher txid does replace the stored price.
    const newer: Rec = {
      ...fresh,
      syncTxid: String(BigInt(String(fresh.syncTxid)) + 1n),
      items: (fresh.items as Rec[]).map((i) =>
        i.id === ids.pliChg ? { ...i, priceIdr: 26000 } : i,
      ),
    };
    await edgeApply("price_lists", [newer]);
    expect(await edgePrice(ids.pliChg)).toBe("26000");
  });

  /** A separate price list (gofood) with one priced item, removed again at the end. */
  const tombstoneFixture = async (price: number) => {
    // Each test starts from a clean cloud copy of this list.
    await mainOwner.query(
      "DELETE FROM price_list_items WHERE price_list_id = $1",
      [ids.plTomb],
    );
    await mainOwner.query("DELETE FROM price_lists WHERE id = $1", [
      ids.plTomb,
    ]);
    created.push(
      { table: "price_lists", where: "id = $1", params: [ids.plTomb] },
      {
        table: "price_list_items",
        where: "price_list_id = $1",
        params: [ids.plTomb],
      },
    );
    await mainOwner.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1,$2,$3,'gofood','2026-02-02')`,
      [ids.plTomb, tenantId, O1],
    );
    await mainOwner.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
       VALUES ($1,$2,$3,$4,NULL,$5)`,
      [ids.pliTomb, tenantId, ids.plTomb, ids.item1, price],
    );
  };
  const exportTombList = async (): Promise<Rec> =>
    (await walk("price_lists")).records.find((r) => r.id === ids.plTomb)!;

  it("24318 the price of a deleted price list does not leak: the tombstone leaves no price on the edge, and an older live copy never brings it back", async () => {
    // Assumption (spec silent): a tombstoned list must leave NO price rows on
    // the edge that a lookup could still read, whatever the tombstone's `items`.
    await tombstoneFixture(33_333);
    const live = await exportTombList();
    expect(live.deletedAt).toBeNull();
    expect((live.items as Rec[]).map((i) => i.priceIdr)).toEqual([33_333]);
    const parents = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "price_lists"))
      await edgeApply(stream, parents[stream]);
    await edgeApply("price_lists", [live]);
    expect(await edgePrice(ids.pliTomb)).toBe("33333");

    // Cloud deletes the list (the item row stays as it is).
    await mainOwner.query(
      "UPDATE price_lists SET deleted_at = now(), updated_at = now() WHERE id = $1",
      [ids.plTomb],
    );
    const tomb = await exportTombList();
    expect(tomb.deletedAt).not.toBeNull();
    expect(BigInt(String(tomb.syncTxid))).toBeGreaterThan(
      BigInt(String(live.syncTxid)),
    );
    await edgeApply("price_lists", [tomb]);
    expect(await edgePrice(ids.pliTomb)).toBeUndefined();
    const header = await edge.rows(
      "SELECT deleted_at FROM price_lists WHERE id = $1",
      [ids.plTomb],
    );
    expect(header.length === 0 || header[0]!.deleted_at !== null).toBe(true);

    // The old live page arrives late (repeat, reversed order): still no price.
    await edgeApply("price_lists", [live]);
    await edgeApply("price_lists", [tomb]);
    expect(await edgePrice(ids.pliTomb)).toBeUndefined();
    const again = await edge.rows(
      "SELECT deleted_at FROM price_lists WHERE id = $1",
      [ids.plTomb],
    );
    expect(again.length === 0 || again[0]!.deleted_at !== null).toBe(true);
  });

  it("24318 a price removed from a live list in the cloud is not in the record and is gone on the edge after the pull", async () => {
    await tombstoneFixture(44_444);
    const parents = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "price_lists"))
      await edgeApply(stream, parents[stream]);
    await edgeApply("price_lists", [await exportTombList()]);
    expect(await edgePrice(ids.pliTomb)).toBe("44444");
    await mainOwner.query(
      `UPDATE price_list_items SET deleted_at = now(), updated_at = now() WHERE id = $1`,
      [ids.pliTomb],
    );
    await mainOwner.query(
      "UPDATE price_lists SET updated_at = now() WHERE id = $1",
      [ids.plTomb],
    );
    const after = await exportTombList();
    expect((after.items as Rec[]).map((i) => i.id)).not.toContain(ids.pliTomb);
    await edgeApply("price_lists", [after]);
    expect(await edgePrice(ids.pliTomb)).toBeUndefined();
  });
});

// -------------------------------------------------- 6 tenant/outlet isolation

describe("97p isolation by tenant and outlet", () => {
  it("97p records of another tenant never come out, in any stream", async () => {
    const foreign = new Set<string>([ids.catB, ids.itemB, ids.mgB]);
    for (const stream of ORDER) {
      const { records } = await walk(stream);
      for (const rec of records) {
        expect(rec.tenantId).toBe(tenantId);
        expect(foreign.has(String(rec.id))).toBe(false);
      }
    }
  });

  it("97p the tenant comes from the credential scope: another tenant with this outlet gets nothing of tenant A", async () => {
    // Either refused (outlet not of that tenant) or empty of tenant A rows.
    const result = await walk("menu_items", { tenant: tenantB }).catch(
      (error: unknown) => error,
    );
    if (result instanceof Error) return;
    for (const rec of (result as { records: Rec[] }).records)
      expect(rec.tenantId).toBe(tenantB);
  });

  it("97p a price list of another outlet never reaches this outlet", async () => {
    const lists1 = (await walk("price_lists", { outletId: O1 })).records.map(
      (r) => r.id,
    );
    expect(lists1).toContain(ids.pl1);
    expect(lists1).not.toContain(ids.pl2);
    const list1 = (await walk("price_lists", { outletId: O1 })).records.find(
      (r) => r.id === ids.pl1,
    )!;
    const items1 = (list1.items as Rec[]).map((i) => i.id);
    expect(items1).toContain(ids.pli1);
    expect(items1).not.toContain(ids.pliO2);

    const lists2 = (await walk("price_lists", { outletId: O2 })).records.map(
      (r) => r.id,
    );
    expect(lists2).toContain(ids.pl2);
    expect(lists2).not.toContain(ids.pl1);
    const list2 = (await walk("price_lists", { outletId: O2 })).records.find(
      (r) => r.id === ids.pl2,
    )!;
    const items2 = (list2.items as Rec[]).map((i) => i.id);
    expect(items2).toContain(ids.pliO2);
    expect(items2).not.toContain(ids.pli1);
  });

  it("97p tenant-wide master data reaches both outlets", async () => {
    for (const outletId of [O1, O2]) {
      const items = (await walk("menu_items", { outletId })).records.map(
        (r) => r.id,
      );
      expect(items).toContain(ids.item1);
    }
  });
});

describe("97p brand filter: an outlet only gets the catalog of its own brand", () => {
  const exportedIds = async (stream: Stream, outletId: string) =>
    (await walk(stream, { outletId })).records.map((r) => String(r.id));

  it("97p an outlet of brand A never receives categories, items or recipes of brand B", async () => {
    for (const stream of [
      "menu_categories",
      "menu_items",
      "recipes",
    ] as const) {
      const { records } = await walk(stream, { outletId: O1 });
      expect(records.length).toBeGreaterThan(0);
      for (const rec of records) expect(rec.brandId).toBe(brandId);
    }
    expect(await exportedIds("menu_categories", O1)).not.toContain(ids.catBr2);
    expect(await exportedIds("menu_items", O1)).not.toContain(ids.itemBr2);
    expect(await exportedIds("recipes", O1)).not.toContain(ids.recBr2);
  });

  it("97p child rows of another brand's items (variants, modifier-group links) do not come through either", async () => {
    expect(await exportedIds("item_variants", O1)).not.toContain(ids.varBr2);
    expect(await exportedIds("item_variants", O1)).toContain(ids.var1);
    const links = (
      await walk("menu_item_modifier_groups", { outletId: O1 })
    ).records.map((r) => String(r.menuItemId));
    expect(links).not.toContain(ids.itemBr2);
    expect(links).toContain(ids.item1);
  });

  it("97p an outlet of brand B receives its own brand's catalog and none of brand A's", async () => {
    const cats = await exportedIds("menu_categories", O3);
    expect(cats).toContain(ids.catBr2);
    expect(cats).not.toContain(ids.cat1);
    const items = await exportedIds("menu_items", O3);
    expect(items).toContain(ids.itemBr2);
    expect(items).not.toContain(ids.item1);
    const recipes = await exportedIds("recipes", O3);
    expect(recipes).toContain(ids.recBr2);
    expect(recipes).not.toContain(ids.rec1);
    expect(await exportedIds("item_variants", O3)).toContain(ids.varBr2);
    expect(await exportedIds("item_variants", O3)).not.toContain(ids.var1);
    for (const stream of ["menu_categories", "menu_items", "recipes"] as const)
      for (const rec of (await walk(stream, { outletId: O3 })).records)
        expect(rec.brandId).toBe(brand2);
  });

  it("97p modifier groups carry no brand: both brands of the tenant get them", async () => {
    for (const outletId of [O1, O3])
      expect(await exportedIds("modifier_groups", outletId)).toContain(ids.mg1);
  });
});

// ------------------------------------------------ 24318 stations, inventory

describe("24318 stations and inventory_items streams", () => {
  const rows = async (stream: Stream, outletId = O1) =>
    (await walk(stream, { outletId })).records;

  it("a station reaches the edge of its own outlet only, with every column", async () => {
    const mine = (await rows("stations", O1)).find((r) => r.id === ids.stn1);
    expect(mine).toMatchObject({
      id: ids.stn1,
      tenantId,
      outletId: O1,
      type: "coffee_bar",
      printerDeviceId: null,
      targetSeconds: 180,
      deletedAt: null,
    });
    expect(String(mine!.syncTxid)).toMatch(/^\d+$/);
    expect((await rows("stations", O1)).map((r) => r.id)).not.toContain(
      ids.stnO2,
    );
    const other = (await rows("stations", O2)).map((r) => r.id);
    expect(other).toContain(ids.stnO2);
    expect(other).not.toContain(ids.stn1);
    for (const rec of await rows("stations", O1)) expect(rec.outletId).toBe(O1);
  });

  it("a soft-deleted station travels as a tombstone and the edge drops or hides it", async () => {
    created.push({
      table: "stations",
      where: "id = $1",
      params: [ids.stnGone],
    });
    await mainOwner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1,$2,$3,$4,'pastry')`,
      [ids.stnGone, tenantId, O1, `Stasiun hilang ${ids.stnGone.slice(0, 6)}`],
    );
    const live = (await rows("stations")).find((r) => r.id === ids.stnGone)!;
    expect(live.deletedAt).toBeNull();
    await edgeApply("stations", [live]);
    expect(
      await edge.rows("SELECT id FROM stations WHERE id = $1", [ids.stnGone]),
    ).toHaveLength(1);
    await mainOwner.query(
      "UPDATE stations SET deleted_at = now(), updated_at = now() WHERE id = $1",
      [ids.stnGone],
    );
    const tomb = (await rows("stations")).find((r) => r.id === ids.stnGone)!;
    expect(tomb.deletedAt).not.toBeNull();
    await edgeApply("stations", [tomb]);
    const left = await edge.rows(
      "SELECT deleted_at FROM stations WHERE id = $1",
      [ids.stnGone],
    );
    expect(left.length === 0 || left[0]!.deleted_at !== null).toBe(true);
  });

  it("inventory items are tenant wide: both outlets get them, with exact NUMERIC strings, the off switch and no idempotency key", async () => {
    for (const outletId of [O1, O2]) {
      const list = await rows("inventory_items", outletId);
      const inv = list.find((r) => r.id === ids.inv1)!;
      expect(inv).toBeDefined();
      expect(inv).toMatchObject({
        tenantId,
        baseUomId: uomId,
        isPerishable: true,
        isActive: true,
        parMin: "1.2500",
        parMax: "10.0000",
      });
      const off = list.find((r) => r.id === ids.invOff)!;
      expect(off).toMatchObject({
        isActive: false,
        parMin: null,
        parMax: null,
      });
      for (const rec of [inv, off]) {
        expect(rec).not.toHaveProperty("idempotencyKey");
        expect(rec).not.toHaveProperty("deletedAt");
        expect(String(rec.syncTxid)).toMatch(/^\d+$/);
      }
    }
  });

  it("a switched-off inventory item stays on the edge with isActive = false (no tombstone)", async () => {
    const data = await exportMine();
    await edgeApply("inventory_items", data.inventory_items);
    const row = (
      await edge.rows(
        "SELECT is_active, par_min::text AS par_min FROM inventory_items WHERE id = $1",
        [ids.invOff],
      )
    )[0];
    expect(row).toMatchObject({ is_active: false, par_min: null });
    const active = (
      await edge.rows(
        "SELECT par_min::text AS par_min, par_max::text AS par_max FROM inventory_items WHERE id = $1",
        [ids.inv1],
      )
    )[0];
    expect(active).toMatchObject({ par_min: "1.2500", par_max: "10.0000" });
  });

  it("an inventory item whose unit of measure is not on the edge yet is refused (transient): nothing stored, checkpoint stays, the other streams still run", async () => {
    const data = await exportMine();
    const unknownUom = id();
    await expect(
      edgeApply(
        "inventory_items",
        data.inventory_items.map((r) => ({ ...r, baseUomId: unknownUom })),
      ),
    ).rejects.toBeDefined();
    expect(
      await edge.rows("SELECT id FROM inventory_items WHERE id = $1", [
        ids.inv1,
      ]),
    ).toHaveLength(0);

    data.inventory_items = data.inventory_items.map((r) => ({
      ...r,
      baseUomId: unknownUom,
    }));
    const result = await pullOk(scriptedCloud(data, 100));
    expect(result.streams.inventory_items?.error).toBeTruthy();
    const stored = (await checkpoints()).map((r) => String(r.stream));
    expect(stored).not.toContain("catalog:inventory_items");
    // 0374: menu_items waits for recipes, which waits for inventory_items.
    expect(result.streams.menu_items?.error).toMatchObject({
      code: "CATALOG_PARENT_FAILED",
    });
    expect(result.streams.menu_categories?.error).toBeFalsy();
    expect(stored).toContain("catalog:menu_categories");
  });

  it("a station of another outlet never leaks: menu_items and modifiers carry stationId only for stations of the credential's outlet, otherwise null", async () => {
    const itemId = id();
    const modId = id();
    created.push(
      { table: "modifiers", where: "id = $1", params: [modId] },
      { table: "menu_items", where: "id = $1", params: [itemId] },
    );
    await mainOwner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, station_id)
       VALUES ($1,$2,$3,$4,$5,true,$6)`,
      [
        itemId,
        tenantId,
        brandId,
        ids.cat1,
        `Menu O2 ${itemId.slice(0, 6)}`,
        ids.stnO2,
      ],
    );
    await mainOwner.query(
      `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr, station_id)
       VALUES ($1,$2,$3,'Modifier O2',500,$4)`,
      [modId, tenantId, ids.mg1, ids.stnO2],
    );
    const asO1 = async (stream: Stream, rowId: string) =>
      (await rows(stream, O1)).find((r) => r.id === rowId)!;
    const asO2 = async (stream: Stream, rowId: string) =>
      (await rows(stream, O2)).find((r) => r.id === rowId)!;
    // O1's edge sees the rows but not O2's station.
    expect((await asO1("menu_items", itemId)).stationId).toBeNull();
    expect((await asO1("modifiers", modId)).stationId).toBeNull();
    // O2's own edge may see its station.
    expect((await asO2("menu_items", itemId)).stationId).toBe(ids.stnO2);
    expect((await asO2("modifiers", modId)).stationId).toBe(ids.stnO2);
    // The O1 station still travels on O1's item, and nothing of O2's station
    // id appears anywhere in O1's pages.
    expect((await asO1("menu_items", ids.itemStn)).stationId).toBe(ids.stn1);
    for (const stream of ["menu_items", "modifiers", "stations"] as const)
      expect(JSON.stringify(await rows(stream, O1))).not.toContain(ids.stnO2);
  });

  it("a station and an inventory item arrive through a full pull and equal the cloud", async () => {
    const result = await pullOk(scriptedCloud(await exportMine(), 100));
    expect(result.streams.stations?.error).toBeFalsy();
    expect(result.streams.inventory_items?.error).toBeFalsy();
    await expectEdgeEqualsCloud();
    expect(
      (
        await edge.rows("SELECT station_id FROM menu_items WHERE id = $1", [
          ids.itemStn,
        ])
      )[0]!.station_id,
    ).toBe(ids.stn1);
  });
});

// ------------------------------------------------------------------ 6 auth

describe("97p HTTP: GET /api/edge-sync/catalog", () => {
  const PATH = "/api/edge-sync/catalog";

  it("97p answers 401 without a credential, even for an invalid query", async () => {
    expect(
      (await request(app).get(PATH).query({ stream: "menu_items" })).status,
    ).toBe(401);
    expect(
      (await request(app).get(PATH).query({ stream: "nope", limit: 0 })).status,
    ).toBe(401);
  });

  it("97p answers 401 for a garbage credential", async () => {
    const res = await request(app)
      .get(PATH)
      .set("Authorization", bearer("bukan-kredensial"))
      .query({ stream: "menu_items" });
    expect(res.status).toBe(401);
  });

  it("97p answers 401 for a revoked edge credential, before reading the query", async () => {
    for (const query of [{ stream: "menu_items" }, { stream: "nope" }]) {
      const res = await request(app)
        .get(PATH)
        .set("Authorization", bearer(revokedNode.credential))
        .query(query);
      expect(res.status).toBe(401);
    }
  });

  it("97p serves a page to an active edge node", async () => {
    const res = await request(app)
      .get(PATH)
      .set("Authorization", bearer(node.credential))
      .query({ stream: "price_lists", limit: 2 });
    expect(res.status).toBe(200);
    const page = catalogSyncPageSchema.parse(res.body);
    expect(page.stream).toBe("price_lists");
    expect(page.records.length).toBeLessThanOrEqual(2);
    for (const rec of page.records) expect(rec.tenantId).toBe(tenantId);
    // Every price list arrives with its items.
    const mine = (res.body.records as Rec[]).find((r) => r.id === ids.pl1);
    expect(idsOf(mine?.items ?? [])).toEqual([...MINE.price_list_items].sort());
  });

  it("24318 serves the stations and inventory_items streams to an active edge node", async () => {
    const stations = await request(app)
      .get(PATH)
      .set("Authorization", bearer(node.credential))
      .query({ stream: "stations", limit: 100 });
    expect(stations.status).toBe(200);
    expect(catalogSyncPageSchema.parse(stations.body).stream).toBe("stations");
    const stationIds = (stations.body.records as Rec[]).map((r) => r.id);
    expect(stationIds).toContain(ids.stn1);
    expect(stationIds).not.toContain(ids.stnO2);

    const inventory = await request(app)
      .get(PATH)
      .set("Authorization", bearer(node.credential))
      .query({ stream: "inventory_items", limit: 100 });
    expect(inventory.status).toBe(200);
    expect(catalogSyncPageSchema.parse(inventory.body).stream).toBe(
      "inventory_items",
    );
    expect((inventory.body.records as Rec[]).map((r) => r.id)).toContain(
      ids.inv1,
    );
    expect(JSON.stringify(inventory.body)).not.toContain("idempotency");
  });

  it("24318 refuses an old cat1 cursor over HTTP with a 4xx", async () => {
    const res = await request(app)
      .get(PATH)
      .set("Authorization", bearer(node.credential))
      .query({
        stream: "menu_items",
        since: encodeCursor(["cat1", "2025-06-01T00:00:00.000000Z", id()]),
      });
    expect([400, 422]).toContain(res.status);
  });

  it("97p refuses an invalid stream or limit with a 4xx", async () => {
    for (const query of [
      { stream: "tax_rules" },
      { stream: "menu_items", limit: 101 },
      { stream: "menu_items", since: "bukan-cursor" },
      { stream: "price_list_items" },
      { stream: "recipe_lines" },
    ]) {
      const res = await request(app)
        .get(PATH)
        .set("Authorization", bearer(node.credential))
        .query(query);
      expect([400, 422]).toContain(res.status);
    }
  });

  it("97p ignores no tenant or outlet from the query: they are refused", async () => {
    for (const extra of [{ tenantId: tenantB }, { outletId: O2 }]) {
      const res = await request(app)
        .get(PATH)
        .set("Authorization", bearer(node.credential))
        .query({ stream: "menu_items", ...extra });
      expect([400, 422]).toContain(res.status);
      expect(JSON.stringify(res.body)).not.toContain(ids.itemB);
    }
  });

  it("97p the page of an outlet edge never holds another outlet's price list", async () => {
    const res = await request(app)
      .get(PATH)
      .set("Authorization", bearer(node.credential))
      .query({ stream: "price_lists", limit: 100 });
    expect(res.status).toBe(200);
    const listIds = (res.body.records as Rec[]).map((r) => r.id);
    expect(listIds).not.toContain(ids.pl2);
  });
});
