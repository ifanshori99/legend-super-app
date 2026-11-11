// Catalog down-sync cloud -> edge (bead legend-97p; PRD v1.7 §3 F8 Master Menu
// & Harga, §3 F16 Resep & BOM, §5 "cloud wins"). Written from the brief
// (docs/briefs/97p-catalog-downsync.md) and the shared contract
// (packages/shared/src/edge/catalog-sync.ts), not from the implementation.
//
// Two databases: the main test database is the CLOUD; a second database
// (helpers/edge-database.ts, restricted login, RLS forced) is the EDGE.
// Cloud rows live under the fixture tenant on two private outlets (O1 = the
// outlet of the edge, O2 = a sibling). A second bare tenant B owns rows that
// must never leave for tenant A. Other test files share the fixture tenant, so
// every cloud-vs-edge comparison is limited to the rows seeded here ("mine").
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
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
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
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
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
  type Row,
} from "./helpers/edge-database.ts";

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

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantB = randomUUID();
const brandB = randomUUID();
const actor = randomUUID();

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

let O1 = "";
let O2 = "";
let O3 = ""; // outlet of the second brand of the same tenant
let brandId = "";
const brand2 = randomUUID();
let edge: EdgeDatabase;
let node: { id: string; credential: string };
let revokedNode: { id: string; credential: string };
let uomId = "";
let userId = "";

const id = () => randomUUID();
const ids = {
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
  menu_categories: [ids.cat1, ids.cat2],
  menu_items: [ids.item1, ids.item2, ids.item3],
  item_variants: [ids.var1],
  modifier_groups: [ids.mg1],
  modifiers: [ids.mod1],
  menu_item_modifier_groups: [ids.item1],
  price_lists: [ids.pl1],
  price_list_items: [ids.pli1, ids.pli2, ids.pli3, ids.pliChg, ids.pliBad],
  recipes: [ids.rec1],
  recipe_lines: [ids.line1, ids.line2],
};
const isMine = (stream: Stream, rec: Rec): boolean =>
  stream === "menu_item_modifier_groups"
    ? rec.menuItemId === ids.item1 && rec.groupId === ids.mg1
    : MINE[stream].includes(String(rec.id));

/** Stream order, parents first (the order the cloud and the puller use). */
const ORDER: Stream[] = [
  "menu_categories",
  "modifier_groups",
  "modifiers",
  "menu_items",
  "item_variants",
  "menu_item_modifier_groups",
  "price_lists",
  "recipes",
];
/** Every table to compare edge vs cloud, parents first. */
const TABLE_ORDER: Table[] = [
  "menu_categories",
  "modifier_groups",
  "modifiers",
  "menu_items",
  "item_variants",
  "menu_item_modifier_groups",
  "price_lists",
  "price_list_items",
  "recipes",
  "recipe_lines",
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

  uomId = (
    await q(
      `INSERT INTO uoms (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [tenantId, `u${id().slice(0, 8)}`],
    )
  ).rows[0].id;
  userId = (await q(`SELECT id FROM "user" ORDER BY id LIMIT 1`, [])).rows[0]
    .id;
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
  "price_list_items",
  "price_lists",
  "menu_item_modifier_groups",
  "modifiers",
  "modifier_groups",
  "item_variants",
  "menu_items",
  "menu_categories",
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
function cloudPage(
  stream: Stream,
  opts: { since?: string; limit?: number; outletId?: string; tenant?: string },
): Promise<Page> {
  const query = catalogSyncQuerySchema.parse({
    stream,
    limit: opts.limit ?? 100,
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
  opts: { limit?: number; outletId?: string; tenant?: string } = {},
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

async function edgeApplyAll(data: Record<Stream, Rec[]>) {
  for (const stream of ORDER) await edgeApply(stream, data[stream]);
}

const WHERE_COLUMN: Record<Table, string> = {
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
};

/** Table rows for the seeded ids, without time stamps. */
async function tableRows(pool: Pool, table: Table): Promise<Row[]> {
  const rows = (
    await pool.query(
      `SELECT row_to_json(t) AS row FROM ${table} t
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
// returned) in pages of `pageSize` with opaque `<stream>:<n>` cursors.
function scriptedCloud(data: Record<Stream, Rec[]>, pageSize: number) {
  const calls: { stream: Stream; since: string | null }[] = [];
  const seen: Record<string, number> = {};
  let broken: { stream: Stream; fromCall: number } | null = null;
  const fetchPage = async (
    stream: Stream,
    since: string | null,
  ): Promise<Page> => {
    calls.push({ stream, since });
    seen[stream] = (seen[stream] ?? 0) + 1;
    if (broken && broken.stream === stream && seen[stream]! >= broken.fromCall)
      throw new Error("jaringan putus");
    const all = data[stream];
    const start = since === null ? 0 : Number(since.split(":")[1]);
    const records = all.slice(start, start + pageSize);
    const end = start + records.length;
    return {
      stream,
      records,
      nextCursor: records.length > 0 ? `${stream}:${end}` : since,
      hasMore: end < all.length,
    };
  };
  return {
    calls,
    fetchPage,
    breakAt: (stream: Stream, fromCall: number) => {
      broken = { stream, fromCall };
    },
    heal: () => {
      broken = null;
    },
  };
}

type Scripted = ReturnType<typeof scriptedCloud>;

/** pullCatalog, wired the way the runtime wires it. Tolerates a rejection. */
async function pull(
  cloud: Pick<Scripted, "fetchPage">,
  overlapMs: number | "default" = 0,
): Promise<unknown> {
  try {
    return await pullCatalog({
      database: edge.database,
      context: edgeScope(O1),
      edgeNodeId: node.id,
      fetchPage: cloud.fetchPage,
      ...(overlapMs === "default" ? {} : { overlapMs }),
    } as never);
  } catch (error) {
    return error;
  }
}

/** A pull that must complete (per-stream errors are inside the result). */
async function pullOk(
  cloud: Pick<Scripted, "fetchPage">,
  overlapMs: number | "default" = 0,
): Promise<PullResult> {
  const result = await pull(cloud, overlapMs);
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
  const bandung = cafeLegendAccessFixtures.outletIds.bandung;
  O1 = await cloneMainOutlet(mainOwner, bandung, "Outlet uji katalog 1");
  O2 = await cloneMainOutlet(mainOwner, bandung, "Outlet uji katalog 2");
  brandId = (
    await mainOwner.query("SELECT brand_id FROM outlets WHERE id = $1", [O1])
  ).rows[0].brand_id;
  await seedCloud();

  // A second brand in the SAME tenant, with its own outlet and brand-owned rows.
  await mainOwner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,$3,'Merek dua')`,
    [brand2, tenantId, `uji-${brand2.slice(0, 8)}`],
  );
  O3 = await cloneMainOutlet(mainOwner, bandung, "Outlet uji katalog 3");
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
    await mainOwner.query("DELETE FROM brands WHERE id = $1", [brand2]);
  } catch {
    // Best effort: private ids and a private tenant, no other file reads them.
  }
  await mainOwner.end();
});

// ------------------------------------------------------- 1 cloud export

describe("97p cloud export: paging, tombstones, settle window", () => {
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
    // The 105 ties come before every newer row, in a stable order.
    const firstHundredFive = exported.slice(0, 105);
    expect([...firstHundredFive].sort()).toEqual([...tieIds].sort());
  });

  it("97p a tiny page size still yields every row exactly once", async () => {
    const { records } = await walk("menu_items", { limit: 1 });
    const exported = records.map((r) => String(r.id));
    expect(new Set(exported).size).toBe(exported.length);
    for (const own of MINE.menu_items) expect(exported).toContain(own);
  });

  it("97p the stream list is the 8 parent-first streams (no recipe_lines, no price_list_items)", () => {
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

  it("97p a row younger than the settle window is held back until it settles", async () => {
    const youngId = id();
    created.push({
      table: "menu_categories",
      where: "id = $1",
      params: [youngId],
    });
    await mainOwner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at)
       VALUES ($1,$2,$3,'Baru saja',0, now())`,
      [youngId, tenantId, brandId],
    );
    const held = (await walk("menu_categories")).records.map((r) => r.id);
    expect(held).not.toContain(youngId);

    await mainOwner.query(
      `UPDATE menu_categories SET updated_at = now() - interval '1 minute' WHERE id = $1`,
      [youngId],
    );
    const settled = (await walk("menu_categories")).records.map((r) => r.id);
    expect(settled).toContain(youngId);
  });
});

// -------------------------------------------------------- 2 cursor errors

describe("97p broken cursor", () => {
  it("97p a garbage cursor is refused with a clear validation error", async () => {
    await expect(
      cloudPage("menu_items", { since: "bukan-cursor" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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

  it("97p cloud wins over a different local row (older or equal stamp)", async () => {
    const data = await exportMine();
    await edgeApplyAll(data);
    // Older local stamp, different price and name.
    await edge.owner.query(
      `UPDATE price_list_items SET price_idr = 111, updated_at = '2025-01-01T00:00:00Z' WHERE id = $1`,
      [ids.pli1],
    );
    await edge.owner.query(
      `UPDATE menu_categories SET name = 'Lokal', updated_at = '2025-01-01T00:00:00Z' WHERE id = $1`,
      [ids.cat1],
    );
    // Equal stamp, different price.
    const stamp = (
      data.price_lists.find((r) => r.id === ids.pl1)!.items as Rec[]
    ).find((r) => r.id === ids.pli2)!.updatedAt as string;
    await edge.owner.query(
      `UPDATE price_list_items SET price_idr = 222, updated_at = $2 WHERE id = $1`,
      [ids.pli2, stamp],
    );
    await edgeApplyAll(data);
    expect(await edgePrice(ids.pli1)).toBe(String(PRICE.pli1));
    expect(await edgePrice(ids.pli2)).toBe(String(PRICE.pli2));
    await expectEdgeEqualsCloud();
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

  it("97p a recipe whose updated_by user is unknown on the edge is refused with CATALOG_MISSING_REF and nothing of it is stored", async () => {
    const data = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "recipes"))
      await edgeApply(stream, data[stream]);
    const bad = { ...data.recipes[0]!, updatedBy: `tak-ada-${id()}` };
    await expect(edgeApply("recipes", [bad])).rejects.toMatchObject({
      code: "CATALOG_MISSING_REF",
    });
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.rec1]),
    ).toHaveLength(0);
    expect(await edgeLineIds()).toEqual([]);
  });

  it("97p a recipe output_item_id unknown on the edge becomes NULL (permanent) and is reported in nulledRefs", async () => {
    const data = await exportMine();
    for (const stream of ORDER.filter((s) => s !== "recipes"))
      await edgeApply(stream, data[stream]);
    const withOutput = { ...data.recipes[0]!, outputItemId: id() };
    const result = await edgeApply("recipes", [withOutput]);
    expect(nulledCount(result)).toBeGreaterThan(0);
    const row = (
      await edge.rows(
        "SELECT output_item_id, updated_by FROM recipes WHERE id = $1",
        [ids.rec1],
      )
    )[0]!;
    expect(row.output_item_id).toBeNull();
    expect(row.updated_by).toBe(userId);
    expect(await edgeLineIds()).toHaveLength(2);
  });

  it("97p a station_id unknown on the edge becomes NULL on a menu item instead of failing the page", async () => {
    // Assumption: stations are not synced, so the edge keeps the column NULL.
    const data = await exportMine();
    await edgeApply("menu_categories", data.menu_categories);
    const item: Rec = { ...data.menu_items[0]!, stationId: id() };
    const result = await edgeApply("menu_items", [item]);
    expect(nulledCount(result)).toBeGreaterThan(0);
    expect(
      (
        await edge.rows("SELECT station_id FROM menu_items WHERE id = $1", [
          String(item.id),
        ])
      )[0]!.station_id,
    ).toBeNull();
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

  it("97p pulling real cloud pages with the default overlap converges and is repeatable", async () => {
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
    await pullOk(live, "default");
    await expectEdgeEqualsCloud();
    await pullOk(live, "default");
    await expectEdgeEqualsCloud();
    expect(await edgePriceRows()).toHaveLength(MINE.price_list_items.length);
    expect(await edgeLineIds()).toHaveLength(MINE.recipe_lines.length);
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
    const page1Cursor = "menu_items:2";
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

  it("97p a recipe with an unknown updated_by is transient: that stream's checkpoint does not move, the other streams run, and it is stored once the reference can be resolved", async () => {
    const data = await exportMine();
    const good = data.recipes;
    data.recipes = [{ ...good[0]!, updatedBy: `tak-ada-${id()}` }];
    const cloud = scriptedCloud(data, 100);
    const result = await pullOk(cloud);
    expect(result.streams.recipes?.error).toBeTruthy();
    const stored = await checkpointStreams();
    expect(stored).not.toContain("catalog:recipes");
    for (const stream of ORDER.filter((s) => s !== "recipes"))
      expect(stored).toContain(`catalog:${stream}`);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id = $1", [ids.rec1]),
    ).toHaveLength(0);
    expect(await edgePriceRows()).toHaveLength(MINE.price_list_items.length);

    // The user is known now (the cloud record carries a user the edge has).
    data.recipes = good;
    const healed = await pullOk(cloud);
    expect(healed.streams.recipes?.error).toBeFalsy();
    expect(await checkpointStreams()).toContain("catalog:recipes");
    await expectEdgeEqualsCloud();
  });

  it("97p a recipe output_item_id unknown on the edge is nulled for good: the checkpoint moves and later pulls do not fail", async () => {
    const data = await exportMine();
    data.recipes = [{ ...data.recipes[0]!, outputItemId: id() }];
    const cloud = scriptedCloud(data, 100);
    const result = await pullOk(cloud);
    expect(result.streams.recipes?.error).toBeFalsy();
    expect(await checkpointStreams()).toContain("catalog:recipes");
    expect(
      (
        await edge.rows("SELECT output_item_id FROM recipes WHERE id = $1", [
          ids.rec1,
        ])
      )[0]!.output_item_id,
    ).toBeNull();
    const again = await pullOk(cloud);
    expect(again.streams.recipes?.error).toBeFalsy();
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
      pull(scriptedCloud({ ...parents, price_lists: [fresh] }, 100)),
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
