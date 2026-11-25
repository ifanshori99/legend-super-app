// Catalog down-sync by `sync_txid` (beads legend-0mus6 findings 1-5, legend-24318;
// design docs/briefs/24318-design.md "Desain sync_txid", "Temuan 2-5"). Written
// from the design and the shared contract, not from the implementation.
//
// Two databases: the main test database is the CLOUD, a second one
// (helpers/edge-database.ts) is the EDGE. A fresh set of cloud rows is seeded
// for a private outlet O1.
//
// Apply rule: a local row is replaced ONLY when incoming syncTxid > stored
// (updatedAt plays no part).
//
// Assumptions (the design is silent), each easy to change:
//  - A tombstoned (soft-deleted) price list must leave NO price rows on the
//    edge that a lookup could still read (money rule: a dead price never leaks).
//  - When a live row arrives that collides with another LIVE local row on a
//    unique key (price list outlet+channel+date, station outlet+name), the
//    cloud wins: the other local row is soft-deleted, the new one is live.
//  - `pullCatalog` has no page cap option; the backlog test uses 1,150 pages of
//    one record, which is more pages than any sane per-pull cap (the design
//    speaks of 100,000 rows / 100 per page = 1,000 pages) and accepts up to
//    three pulls, but never a page fetched twice.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  CATALOG_LINK_STREAMS,
  CATALOG_SYNC_STREAMS,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { applyCatalogRecords } from "../services/edge-catalog-apply.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { scriptedCatalogCloud, settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Stream = (typeof CATALOG_LINK_STREAMS)[number];
type Rec = Record<string, unknown>;
type Page = {
  stream: Stream;
  records: Rec[];
  nextCursor: string | null;
  hasMore: boolean;
};
type PullResult = {
  streams: Record<string, { error?: unknown } | undefined>;
};

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const id = () => randomUUID();

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

let O1 = "";
let brandId = "";
let uomId = "";
let userId = "";
let edge: EdgeDatabase;
let node: { id: string; credential: string };

const ids = {
  stn1: id(),
  stnX: id(),
  stnY: id(),
  inv1: id(),
  catA: id(),
  itemA: id(),
  itemB: id(),
  plA: id(),
  pliA: id(),
  // price list key clash (finding 3)
  plX: id(),
  pliX: id(),
  plY: id(),
  pliY: id(),
  // durable parent repair (finding 4)
  parent: id(),
  child: id(),
};

/** Rows this file owns, per stream, for filtering the shared fixture tenant. */
const MINE: Record<Stream, string[]> = {
  stations: [ids.stn1, ids.stnX, ids.stnY],
  printers: [],
  inventory_items: [ids.inv1],
  menu_categories: [ids.catA],
  modifier_groups: [],
  modifiers: [],
  menu_items: [ids.itemA, ids.itemB],
  item_variants: [],
  menu_item_modifier_groups: [],
  price_lists: [ids.plA, ids.plX, ids.plY],
  recipes: [],
  promotions: [],
  vouchers: [],
};
const ORDER: Stream[] = [...CATALOG_LINK_STREAMS];
const isMine = (stream: Stream, rec: Rec) =>
  MINE[stream].includes(String(rec.id));

// ---------------------------------------------------------------- helpers

const scopeOf = (
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function cloudPage(
  stream: Stream,
  opts: { since?: string; limit?: number; noSettle?: boolean },
): Promise<Page> {
  if (!opts.noSettle) await settleCloud(mainOwner);
  const query = catalogSyncQuerySchema.parse({
    stream,
    limit: opts.limit ?? 100,
    ...(opts.since === undefined ? {} : { since: opts.since }),
  });
  return listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: O1 as never,
    query,
  }) as unknown as Promise<Page>;
}

async function walk(
  stream: Stream,
  opts: { since?: string; limit?: number; noSettle?: boolean } = {},
) {
  const records: Rec[] = [];
  const pages: Page[] = [];
  let since = opts.since;
  for (let n = 0; n < 2000; n += 1) {
    const page = await cloudPage(stream, { ...opts, since });
    pages.push(page);
    records.push(...page.records);
    if (!page.hasMore) break;
    since = page.nextCursor as string;
  }
  return { records, pages };
}

const exportMine = async (): Promise<Record<Stream, Rec[]>> => {
  const out = {} as Record<Stream, Rec[]>;
  for (const stream of ORDER)
    out[stream] = (await walk(stream)).records.filter((r) => isMine(stream, r));
  return out;
};
const exportOne = async (stream: Stream, rowId: string): Promise<Rec> => {
  const found = (await walk(stream)).records.find((r) => r.id === rowId);
  if (!found) throw new Error(`${stream} ${rowId} is not exported`);
  return found;
};

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

/** Everything except price lists and recipes (parents of what the tests apply). */
async function applyParents(data: Record<Stream, Rec[]>) {
  for (const stream of ORDER.filter(
    (s) => s !== "price_lists" && s !== "recipes",
  ))
    await edgeApply(stream, data[stream]);
}

async function pull(cloud: {
  fetchPage: (s: string, since: string | null) => Promise<unknown>;
}): Promise<PullResult | Error> {
  try {
    return (await pullCatalog({
      database: edge.database,
      context: scopeOf("device", O1),
      edgeNodeId: node.id,
      fetchPage: cloud.fetchPage,
    } as never)) as PullResult;
  } catch (error) {
    return error as Error;
  }
}
async function pullOk(cloud: Parameters<typeof pull>[0]): Promise<PullResult> {
  const result = await pull(cloud);
  expect(result).not.toBeInstanceOf(Error);
  return result as PullResult;
}

const checkpoints = () =>
  edge.rows(
    "SELECT stream, watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1",
    [node.id],
  );

const edgePrice = async (rowId: string): Promise<string | undefined> =>
  (
    await edge.rows(
      "SELECT price_idr::text AS price FROM price_list_items WHERE id = $1",
      [rowId],
    )
  )[0]?.price as string | undefined;
const liveEdgeLists = async (listIds: string[]) =>
  (
    await edge.rows(
      "SELECT id FROM price_lists WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id",
      [listIds],
    )
  )
    .map((r) => String(r.id))
    .sort();
const edgeItemsOfList = async (listId: string) =>
  (
    await edge.rows(
      "SELECT id, price_idr::text AS price FROM price_list_items WHERE price_list_id = $1",
      [listId],
    )
  ).map((r) => `${r.id}=${r.price}`);
const liveEdgeStations = async (name: string) =>
  (
    await edge.rows(
      "SELECT id FROM stations WHERE name = $1 AND deleted_at IS NULL",
      [name],
    )
  ).map((r) => String(r.id));

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

const EDGE_TABLES_CHILD_FIRST = [
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
    for (const table of EDGE_TABLES_CHILD_FIRST)
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

const q = (text: string, params: unknown[] = []) =>
  mainOwner.query(text, params);

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  O1 = await cloneMainOutlet(
    mainOwner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji txid",
  );
  brandId = (await q("SELECT brand_id FROM outlets WHERE id = $1", [O1]))
    .rows[0].brand_id;
  uomId = (
    await q(
      `INSERT INTO uoms (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [tenantId, `t${id().slice(0, 8)}`],
    )
  ).rows[0].id;
  userId = (await q(`SELECT id FROM "user" ORDER BY id LIMIT 1`)).rows[0].id;

  await q(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1,$2,$3,$4,'coffee_bar')`,
    [ids.stn1, tenantId, O1, `Bar ${ids.stn1.slice(0, 6)}`],
  );
  await q(
    `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
     VALUES ($1,$2,$3,'Bahan','raw_material',$4)`,
    [ids.inv1, tenantId, `Bahan ${ids.inv1.slice(0, 6)}`, uomId],
  );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Kategori txid',0)`,
    [ids.catA, tenantId, brandId],
  );
  for (const itemId of [ids.itemA, ids.itemB])
    await q(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [itemId, tenantId, brandId, ids.catA, `Menu txid ${itemId.slice(0, 6)}`],
    );
  await q(
    `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ($1,$2,$3,'dine_in','2026-04-01')`,
    [ids.plA, tenantId, O1],
  );
  await q(
    `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
     VALUES ($1,$2,$3,$4,NULL,20000)`,
    [ids.pliA, tenantId, ids.plA, ids.itemA],
  );

  const registered = await registerEdgeNode(scopeOf("session", O1), actor, {
    outletId: O1,
    role: "standby",
    label: "Mini PC uji txid",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
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
  await edge?.cleanup();
  try {
    await q(
      "DELETE FROM price_list_items WHERE price_list_id = ANY($1::uuid[])",
      [[ids.plA, ids.plX, ids.plY]],
    );
    await q("DELETE FROM price_lists WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM menu_items WHERE id = ANY($1::uuid[])", [
      [ids.itemA, ids.itemB],
    ]);
    await q("DELETE FROM menu_categories WHERE id = $1", [ids.catA]);
    await q("DELETE FROM stations WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM inventory_items WHERE id = $1", [ids.inv1]);
    await q("DELETE FROM uoms WHERE id = $1", [uomId]);
    await q("DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM edge_nodes WHERE outlet_id = $1", [O1]);
    await q("DELETE FROM outlets WHERE id = $1", [O1]);
  } catch {
    // Best effort: private ids on a private outlet.
  }
  await mainOwner.end();
});

// ------------------------------------------------ cloud: the sync_txid column

// The printers stream reads the cloud table `edge_printers` (legend-fbf4v).
const STREAM_TABLES = CATALOG_SYNC_STREAMS.map((stream) =>
  stream === "printers" ? "edge_printers" : stream,
);

describe("0mus6 cloud sync_txid column and trigger", () => {
  it("every stream table has a NOT NULL bigint sync_txid column and an index on (tenant_id, sync_txid, ...)", async () => {
    for (const table of STREAM_TABLES) {
      const column = (
        await q(
          `SELECT data_type, is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'sync_txid'`,
          [table],
        )
      ).rows[0];
      expect(column, table).toMatchObject({
        data_type: "bigint",
        is_nullable: "NO",
      });
      const indexes = (
        await q(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1",
          [table],
        )
      ).rows.map((r) => String(r.indexdef));
      expect(
        indexes.some((def) =>
          // edge_printers is outlet-scoped: (tenant_id, outlet_id, sync_txid, id).
          (table === "edge_printers"
            ? /\(tenant_id, outlet_id, sync_txid[,)]/
            : /\(tenant_id, sync_txid[,)]/
          ).test(def),
        ),
        `${table} index on sync_txid`,
      ).toBe(true);
    }
  });

  /** Runs statements in one cloud transaction; answers the results and its txid. */
  async function inOneTx<T>(
    run: (c: import("pg").PoolClient) => Promise<T>,
    skip = false,
  ): Promise<{ result: T; txid: string }> {
    const client = await mainOwner.connect();
    try {
      await client.query("BEGIN");
      if (skip)
        await client.query(
          "SELECT set_config('legend.skip_sync_txid', 'on', true)",
        );
      const result = await run(client);
      const txid = (
        await client.query("SELECT pg_current_xact_id()::text AS x")
      ).rows[0].x as string;
      await client.query("COMMIT");
      return { result, txid };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const probeId = id();
  const probeId2 = id();
  const probeStation = id();
  afterAll(async () => {
    await q("DELETE FROM menu_categories WHERE id = ANY($1::uuid[])", [
      [probeId, probeId2],
    ]).catch(() => undefined);
    await q("DELETE FROM stations WHERE id = $1", [probeStation]).catch(
      () => undefined,
    );
  });

  it("an insert gets the transaction's id as sync_txid, whatever the statement says; rows of one transaction share it", async () => {
    const { result, txid } = await inOneTx(async (c) => {
      const a = await c.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, sync_txid)
         VALUES ($1,$2,$3,'Probe 1',0,1) RETURNING sync_txid::text AS t`,
        [probeId, tenantId, brandId],
      );
      const b = await c.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1,$2,$3,'Probe 2',0) RETURNING sync_txid::text AS t`,
        [probeId2, tenantId, brandId],
      );
      return [a.rows[0].t as string, b.rows[0].t as string];
    });
    expect(result[0]).toBe(txid);
    expect(result[1]).toBe(txid);
  });

  it("an update moves sync_txid forward to the updating transaction", async () => {
    const before = BigInt(
      (
        await q(
          "SELECT sync_txid::text AS t FROM menu_categories WHERE id = $1",
          [probeId],
        )
      ).rows[0].t,
    );
    const { result, txid } = await inOneTx(
      async (c) =>
        (
          await c.query(
            "UPDATE menu_categories SET name = 'Probe ubah' WHERE id = $1 RETURNING sync_txid::text AS t",
            [probeId],
          )
        ).rows[0].t as string,
    );
    expect(result).toBe(txid);
    expect(BigInt(result)).toBeGreaterThan(before);
  });

  it("the new tables (stations) carry the trigger too", async () => {
    const { result, txid } = await inOneTx(
      async (c) =>
        (
          await c.query(
            `INSERT INTO stations (id, tenant_id, outlet_id, name, type, sync_txid)
           VALUES ($1,$2,$3,'Probe stasiun','pastry',7) RETURNING sync_txid::text AS t`,
            [probeStation, tenantId, O1],
          )
        ).rows[0].t as string,
    );
    expect(result).toBe(txid);
  });

  it("with legend.skip_sync_txid = on (local to the transaction) the written value stays; the next normal write overrides it again", async () => {
    const { result } = await inOneTx(
      async (c) =>
        (
          await c.query(
            "UPDATE menu_categories SET name = 'Probe tetap', sync_txid = 12345 WHERE id = $1 RETURNING sync_txid::text AS t",
            [probeId],
          )
        ).rows[0].t as string,
      true,
    );
    expect(result).toBe("12345");
    const after = await inOneTx(
      async (c) =>
        (
          await c.query(
            "UPDATE menu_categories SET name = 'Probe normal', sync_txid = 12345 WHERE id = $1 RETURNING sync_txid::text AS t",
            [probeId],
          )
        ).rows[0].t as string,
    );
    expect(after.result).toBe(after.txid);
    expect(after.result).not.toBe("12345");
  });
});

// ------------------------------------- findings 1 + 2: concurrent transactions

describe("0mus6 cloud export: a row of an older open transaction is never skipped", () => {
  it("rows committed after a still-open older transaction are held back, and a client that paged up to the boundary receives BOTH rows afterwards, older txid first", async () => {
    const aId = id();
    const bId = id();
    const writer = await mainOwner.connect();
    let ended = false;
    try {
      await writer.query("BEGIN");
      await writer.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Transaksi lama',0)`,
        [aId, tenantId, brandId],
      );
      // Committed AFTER the writer started, BEFORE it commits.
      await q(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Commit duluan',0)`,
        [bId, tenantId, brandId],
      );
      const first = await walk("menu_categories", { noSettle: true });
      const seenIds = first.records.map((r) => r.id);
      expect(seenIds).not.toContain(aId);
      expect(seenIds).not.toContain(bId);
      const cursor = first.pages.at(-1)!.nextCursor ?? undefined;

      await writer.query("COMMIT");
      ended = true;
      const rest = await walk("menu_categories", { since: cursor });
      const restIds = rest.records.map((r) => String(r.id));
      expect(restIds).toContain(aId);
      expect(restIds).toContain(bId);
      expect(restIds.indexOf(aId)).toBeLessThan(restIds.indexOf(bId));
      const txids = Object.fromEntries(
        rest.records.map((r) => [String(r.id), BigInt(String(r.syncTxid))]),
      );
      expect(txids[aId]! < txids[bId]!).toBe(true);
    } finally {
      if (!ended) await writer.query("ROLLBACK");
      writer.release();
      await q("DELETE FROM menu_categories WHERE id = ANY($1::uuid[])", [
        [aId, bId],
      ]);
    }
  });

  it("an update made by an older open transaction is not lost to a later commit either (both versions reach the client in txid order)", async () => {
    const rowId = id();
    await q(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'V0',0)`,
      [rowId, tenantId, brandId],
    );
    const writer = await mainOwner.connect();
    let ended = false;
    try {
      await settleCloud(mainOwner);
      const firstWalk = await walk("menu_categories");
      expect(firstWalk.records.map((r) => r.id)).toContain(rowId);
      const cursor = firstWalk.pages.at(-1)!.nextCursor ?? undefined;

      await writer.query("BEGIN");
      await writer.query(
        "UPDATE menu_categories SET name = 'V1 lama' WHERE id = $1",
        [rowId],
      );
      // A newer, committed write to ANOTHER row while the update is open.
      const otherId = id();
      await q(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1,$2,$3,'Lain',0)`,
        [otherId, tenantId, brandId],
      );
      const during = await walk("menu_categories", {
        since: cursor,
        noSettle: true,
      });
      expect(during.records.map((r) => r.id)).not.toContain(otherId);
      expect(during.records.map((r) => r.id)).not.toContain(rowId);
      await writer.query("COMMIT");
      ended = true;
      const after = await walk("menu_categories", { since: cursor });
      const byId = new Map(after.records.map((r) => [String(r.id), r]));
      expect(byId.get(rowId)?.name).toBe("V1 lama");
      expect(byId.has(otherId)).toBe(true);
      await q("DELETE FROM menu_categories WHERE id = $1", [otherId]);
    } finally {
      if (!ended) await writer.query("ROLLBACK");
      writer.release();
      await q("DELETE FROM menu_categories WHERE id = $1", [rowId]);
    }
  });
});

// ----------------------------------------------- finding 2: edge apply by txid

describe("0mus6 edge apply: only a higher sync_txid replaces a local row", () => {
  const older = (rec: Rec, by = 1n) => ({
    ...rec,
    syncTxid: String(BigInt(String(rec.syncTxid)) - by),
  });
  const newer = (rec: Rec, by = 1n) => ({
    ...rec,
    syncTxid: String(BigInt(String(rec.syncTxid)) + by),
  });
  const nameOnEdge = async (table: string, rowId: string) =>
    (await edge.rows(`SELECT name FROM ${table} WHERE id = $1`, [rowId]))[0]
      ?.name;

  it("an older page that arrives after a newer one never overwrites it (any order, repeated)", async () => {
    const data = await exportMine();
    const cat = data.menu_categories[0]!;
    const fresh = { ...cat, name: "Versi baru" };
    const old = { ...older(cat, 5n), name: "Versi lama" };
    await edgeApply("menu_categories", [fresh]);
    await edgeApply("menu_categories", [old]);
    // A page never repeats a record (apply refuses that), so repeat the pages.
    await edgeApply("menu_categories", [old]);
    await edgeApply("menu_categories", [fresh]);
    await edgeApply("menu_categories", [old]);
    expect(await nameOnEdge("menu_categories", ids.catA)).toBe("Versi baru");

    // And the other order: old first, then new wins.
    await resetEdge();
    await edgeApply("menu_categories", [old]);
    expect(await nameOnEdge("menu_categories", ids.catA)).toBe("Versi lama");
    await edgeApply("menu_categories", [fresh]);
    expect(await nameOnEdge("menu_categories", ids.catA)).toBe("Versi baru");
  });

  it("a price cannot go back: the older price list (lower txid) never replaces the newer one, even with a newer updatedAt", async () => {
    const data = await exportMine();
    await applyParents(data);
    const list = await exportOne("price_lists", ids.plA);
    // The old copy even claims the newest updatedAt: only txid orders versions.
    const withPrice = (rec: Rec, price: number, stamp?: string) => ({
      ...rec,
      ...(stamp ? { updatedAt: stamp } : {}),
      items: (rec.items as Rec[]).map((i) => ({
        ...i,
        priceIdr: price,
        ...(stamp ? { updatedAt: stamp } : {}),
      })),
    });
    const fresh = withPrice(newer(list, 10n), 25_000);
    const old = withPrice(list, 20_000, "2099-01-01T00:00:00.000Z");
    await edgeApply("price_lists", [fresh]);
    await edgeApply("price_lists", [old]);
    expect(await edgePrice(ids.pliA)).toBe("25000");
    await edgeApply("price_lists", [fresh]);
    await edgeApply("price_lists", [old]);
    expect(await edgePrice(ids.pliA)).toBe("25000");
    // The newer one replaces the stored price when it really is newer.
    await edgeApply("price_lists", [withPrice(newer(list, 20n), 27_500)]);
    expect(await edgePrice(ids.pliA)).toBe("27500");
  });

  it("two applies racing in either start order end on the newer price, whole list intact", async () => {
    const data = await exportMine();
    await applyParents(data);
    const list = await exportOne("price_lists", ids.plA);
    const priced = (rec: Rec, price: number) => ({
      ...rec,
      items: (rec.items as Rec[]).map((i) => ({ ...i, priceIdr: price })),
    });
    const fresh = priced(newer(list, 10n), 25_000);
    const old = priced(list, 20_000);
    for (let round = 0; round < 8; round += 1) {
      await edge.owner.query("DELETE FROM price_list_items");
      await edge.owner.query("DELETE FROM price_lists");
      await Promise.all(
        round % 2 === 0
          ? [edgeApply("price_lists", [old]), edgeApply("price_lists", [fresh])]
          : [
              edgeApply("price_lists", [fresh]),
              edgeApply("price_lists", [old]),
            ],
      );
      expect(await edgePrice(ids.pliA)).toBe("25000");
      expect(await edgeItemsOfList(ids.plA)).toHaveLength(1);
    }
  });

  it("a tombstone with a higher txid is not undone by an older live copy", async () => {
    const data = await exportMine();
    const stn = data.stations.find((r) => r.id === ids.stn1)!;
    const tomb = { ...newer(stn, 3n), deletedAt: "2026-06-01T00:00:00.000Z" };
    await edgeApply("stations", [tomb]);
    await edgeApply("stations", [stn]);
    const row = (
      await edge.rows("SELECT deleted_at FROM stations WHERE id = $1", [
        ids.stn1,
      ])
    )[0];
    expect(row === undefined || row.deleted_at !== null).toBe(true);
  });

  it("the edge keeps the txid the cloud sent (its own trigger does not rewrite it)", async () => {
    const data = await exportMine();
    const cat = newer(data.menu_categories[0]!, 1_000_000n);
    await edgeApply("menu_categories", [cat]);
    expect(
      (
        await edge.rows(
          "SELECT sync_txid::text AS t FROM menu_categories WHERE id = $1",
          [ids.catA],
        )
      )[0]!.t,
    ).toBe(String(cat.syncTxid));
  });
});

// ------------------------------------------- finding 3: unique live price key

describe("0mus6 unique live keys: a deleted row and its same-key successor", () => {
  const KEY = { channel: "reservation", date: "2026-05-05" };

  /** A is live, then deleted; B takes the same (outlet, channel, date). */
  async function priceListClash() {
    await q(
      "DELETE FROM price_list_items WHERE price_list_id = ANY($1::uuid[])",
      [[ids.plX, ids.plY]],
    );
    await q("DELETE FROM price_lists WHERE id = ANY($1::uuid[])", [
      [ids.plX, ids.plY],
    ]);
    await q(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ($1,$2,$3,$4,$5)`,
      [ids.plX, tenantId, O1, KEY.channel, KEY.date],
    );
    await q(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
       VALUES ($1,$2,$3,$4,NULL,10000)`,
      [ids.pliX, tenantId, ids.plX, ids.itemA],
    );
    const aLive = await exportOne("price_lists", ids.plX);

    await q(
      "UPDATE price_list_items SET deleted_at = now(), updated_at = now() WHERE id = $1",
      [ids.pliX],
    );
    await q(
      "UPDATE price_lists SET deleted_at = now(), updated_at = now() WHERE id = $1",
      [ids.plX],
    );
    await q(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ($1,$2,$3,$4,$5)`,
      [ids.plY, tenantId, O1, KEY.channel, KEY.date],
    );
    await q(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
       VALUES ($1,$2,$3,$4,NULL,12000)`,
      [ids.pliY, tenantId, ids.plY, ids.itemA],
    );
    const aDead = await exportOne("price_lists", ids.plX);
    const b = await exportOne("price_lists", ids.plY);
    expect(aLive.deletedAt).toBeNull();
    expect(aDead.deletedAt).not.toBeNull();
    expect(b.deletedAt).toBeNull();
    return { aLive, aDead, b };
  }

  async function expectBWins() {
    expect(await liveEdgeLists([ids.plX, ids.plY])).toEqual([ids.plY]);
    expect(await edgePrice(ids.pliY)).toBe("12000");
    // The dead list's price must not stay readable (money rule).
    expect(await edgeItemsOfList(ids.plX)).toEqual([]);
  }

  it("in one page the tombstone is applied before the live row, so the new list lands (B listed before A's tombstone)", async () => {
    const { aLive, aDead, b } = await priceListClash();
    await applyParents(await exportMine());
    await edgeApply("price_lists", [aLive]);
    await edgeApply("price_lists", [b, aDead]);
    await expectBWins();
  });

  it("across pages: B arrives while A is still live locally and A's tombstone comes later; B is live, A is not", async () => {
    const { aLive, aDead, b } = await priceListClash();
    await applyParents(await exportMine());
    await edgeApply("price_lists", [aLive]);
    await edgeApply("price_lists", [b]);
    expect(await liveEdgeLists([ids.plX, ids.plY])).toEqual([ids.plY]);
    await edgeApply("price_lists", [aDead]);
    await expectBWins();
    // Repeating everything changes nothing.
    await edgeApply("price_lists", [aLive]);
    await edgeApply("price_lists", [b, aDead]);
    await expectBWins();
  });

  it("through the puller, with B on an earlier page than A's tombstone: no stuck stream, the checkpoint moves, B is the live list", async () => {
    const { aLive, aDead, b } = await priceListClash();
    const data = await exportMine();
    await applyParents(data);
    await edgeApply("price_lists", [aLive]);
    const cloud = scriptedCatalogCloud(
      { ...data, price_lists: [b, aDead] } as unknown as Record<string, Rec[]>,
      1,
    );
    const result = await pullOk(cloud);
    expect(result.streams.price_lists?.error).toBeFalsy();
    expect((await checkpoints()).map((r) => String(r.stream))).toContain(
      "catalog:price_lists",
    );
    await expectBWins();
  });

  it("stations: a deleted station and a new one with the same name (unique live per outlet) - the new one is live", async () => {
    const name = `Bar ganti ${ids.stnX.slice(0, 6)}`;
    await q("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
      [ids.stnX, ids.stnY],
    ]);
    await q(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1,$2,$3,$4,'hot_kitchen')`,
      [ids.stnX, tenantId, O1, name],
    );
    const xLive = await exportOne("stations", ids.stnX);
    await q(
      "UPDATE stations SET deleted_at = now(), updated_at = now() WHERE id = $1",
      [ids.stnX],
    );
    await q(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1,$2,$3,$4,'hot_kitchen')`,
      [ids.stnY, tenantId, O1, name],
    );
    const xDead = await exportOne("stations", ids.stnX);
    const y = await exportOne("stations", ids.stnY);

    await edgeApply("stations", [xLive]);
    expect(await liveEdgeStations(name)).toEqual([ids.stnX]);
    await edgeApply("stations", [y]);
    expect(await liveEdgeStations(name)).toEqual([ids.stnY]);
    await edgeApply("stations", [xDead]);
    expect(await liveEdgeStations(name)).toEqual([ids.stnY]);
    await edgeApply("stations", [xLive]);
    await edgeApply("stations", [y]);
    await edgeApply("stations", [xDead]);
    expect(await liveEdgeStations(name)).toEqual([ids.stnY]);
  });
});

// -------------------------------------- finding 4: durable category parent fix

describe("0mus6 category parent repair survives a restart", () => {
  it("a child page applied before its parent exists gets its parent once the parent arrives in a later pull (a new puller run, nothing kept in memory)", async () => {
    const data = await exportMine();
    const tpl = data.menu_categories[0]!;
    const parent = { ...tpl, id: ids.parent, name: "Induk", parentId: null };
    const child = {
      ...tpl,
      id: ids.child,
      name: "Anak",
      parentId: ids.parent,
      syncTxid: String(BigInt(String(tpl.syncTxid)) + 1n),
    };
    // Child on page 1, parent on page 2; the connection dies before page 2.
    const feed = {
      ...data,
      menu_categories: [child, parent],
    } as unknown as Record<string, Rec[]>;
    const cloud = scriptedCatalogCloud(feed, 1);
    cloud.breakAt("menu_categories", 2);
    const first = await pullOk(cloud);
    expect(first.streams.menu_categories?.error).toBeTruthy();
    expect(
      (
        await edge.rows("SELECT parent_id FROM menu_categories WHERE id = $1", [
          ids.child,
        ])
      )[0]!.parent_id,
    ).toBeNull();

    // "Restart": a brand-new pullCatalog call is the only thing that remains.
    cloud.heal();
    const second = await pullOk(cloud);
    expect(second.streams.menu_categories?.error).toBeFalsy();
    const rows = await edge.rows(
      "SELECT id, parent_id FROM menu_categories WHERE id = ANY($1::uuid[])",
      [[ids.child, ids.parent]],
    );
    const parentOf = Object.fromEntries(
      rows.map((r) => [String(r.id), r.parent_id]),
    );
    expect(parentOf[ids.parent]).toBeNull();
    expect(parentOf[ids.child]).toBe(ids.parent);
  });
});

// ------------------------------------------------ finding 5: huge backlog

describe("0mus6 a backlog longer than one pull", () => {
  it("1,150 one-record pages are all applied; no page is fetched twice, each page moves the checkpoint forward", async () => {
    const data = await exportMine();
    const tpl = data.menu_categories[0]!;
    const base = BigInt(String(tpl.syncTxid)) + 100n;
    const total = 1_150;
    const backlog: Rec[] = [];
    for (let n = 0; n < total; n += 1)
      backlog.push({
        ...tpl,
        id: id(),
        name: `Antrean ${n}`,
        parentId: null,
        syncTxid: String(base + BigInt(n)),
      });
    const feed = {
      ...data,
      menu_categories: backlog,
    } as unknown as Record<string, Rec[]>;
    const cloud = scriptedCatalogCloud(feed, 1);
    const have = async () =>
      Number(
        (
          await edge.rows(
            "SELECT count(*)::int AS n FROM menu_categories WHERE name LIKE 'Antrean %'",
          )
        )[0]!.n,
      );

    let pulls = 0;
    while (pulls < 3 && (await have()) < total) {
      pulls += 1;
      const result = await pullOk(cloud);
      // A pull that stops early reports it or just ends: either way the next
      // pull must continue from the checkpoint, never from page 1 again.
      void result;
    }
    expect(await have()).toBe(total);

    const sinceValues = cloud.calls
      .filter((c) => c.stream === "menu_categories")
      .map((c) => c.since);
    expect(sinceValues.filter((s) => s === null)).toHaveLength(1);
    const cursors = sinceValues.filter((s): s is string => s !== null);
    expect(new Set(cursors).size).toBe(cursors.length);
    const stored = (await checkpoints()).find(
      (r) => r.stream === "catalog:menu_categories",
    );
    expect(decodeCursor(String(stored?.watermark))[0]).toBe("cat2");
  }, 240_000);
});

// ------------------------------------------ old checkpoints are not an error

describe("0mus6 a cat1 (time) checkpoint on an upgraded edge", () => {
  it("is ignored: the pull starts from the beginning and ends with cat2 checkpoints, without an error", async () => {
    const data = await exportMine();
    const cloud = scriptedCatalogCloud(
      data as unknown as Record<string, Rec[]>,
      100,
    );
    await pullOk(cloud);
    await edge.owner.query(
      "UPDATE edge_pull_checkpoints SET watermark = $2 WHERE edge_node_id = $1 AND stream LIKE 'catalog:%'",
      [node.id, encodeCursor(["cat1", "2025-06-01T00:00:00.000000Z", id()])],
    );
    const before = cloud.calls.length;
    const result = await pullOk(cloud);
    for (const stream of ORDER)
      expect(result.streams[stream]?.error, stream).toBeFalsy();
    for (const stream of ORDER)
      expect(
        cloud.calls.slice(before).find((c) => c.stream === stream)?.since,
        stream,
      ).toBeNull();
    // Streams that had no record keep an empty checkpoint: only streams that
    // carried data have a cursor to inspect.
    const withData = ORDER.filter((s) => data[s].length > 0).map(
      (s) => `catalog:${s}`,
    );
    const rows = (await checkpoints()).filter((r) =>
      withData.includes(String(r.stream)),
    );
    expect(rows.length).toBe(withData.length);
    for (const row of rows)
      expect(decodeCursor(String(row.watermark))[0]).toBe("cat2");
  });
});
