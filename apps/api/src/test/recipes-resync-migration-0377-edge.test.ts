// Migration 0375_recipes_resync_edges.sql, EDGE branch (bead legend-2uqcd, W2).
// An edge that pulled before the upgrade lost recipe_id links to recipes of
// another brand (0374 on the edge) and the 0262 trigger gave those rows a LOCAL
// sync_txid, which the catalog apply compares with the cloud's (skips a record
// when stored >= record). The edge branch sets sync_txid = 0 on recipes,
// menu_items and item_variants and clears the watermark of their three
// checkpoints, so the next pull restores the links. Cloud = private database
// (helpers/catalog-database.ts), edge = a second database with edge migrations.
// The cloud branch is covered by recipes-resync-migration-0377.test.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
  type CATALOG_SYNC_STREAMS,
} from "@starter/shared/edge";
import {
  EDGE_MASTER_SNAPSHOT_VERSION,
  EDGE_MASTER_SNAPSHOT_VERSION_HEADER,
  type EdgeMasterSnapshot,
} from "@starter/shared/edge/master-sync";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db, pool } from "../db/index.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import { applyEdgeMasterSnapshotInTransaction } from "../edge/master-sync.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import {
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});

type Rec = Record<string, unknown>;
type Stream = (typeof CATALOG_SYNC_STREAMS)[number];

const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";
const FAR_AHEAD = "4000000000000"; // a local txid far above any cloud one
const THREE_STREAMS = ["recipes", "menu_items", "item_variants"] as const;

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const brandA = randomUUID(); // owns the recipe
const brandB = randomUUID(); // brand of the edge outlet and of the item
const outletB = randomUUID();
const actor = randomUUID();
const ids = {
  recipe: randomUUID(),
  category: randomUUID(),
  item: randomUUID(),
  variant: randomUUID(),
  override: randomUUID(),
};

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
let edge: EdgeDatabase;
let node: { id: string; credential: string };
let uomId = "";
let userId = "";
const app = createApp();

const at = (minute: number) => new Date(Date.UTC(2025, 5, 1, 0, minute));
const scopeOf = (source: "session" | "device"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletB)] },
  );

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../drizzle/0375_recipes_resync_edges.sql",
  ),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

// ---------------------------------------------------------------- cloud

async function seedCloud() {
  const q = (text: string, params: unknown[]) => mainOwner.query(text, params);
  const t = cafeLegendPlatformFixtures.tenant;
  await q(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1,$2,'Tenant uji 0377 edge',$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      tenantId,
      `mig0377e-${tenantId}`,
      t.plan,
      t.status,
      t.deploymentMode,
      JSON.stringify(t.featureFlags),
      JSON.stringify(t.limits),
      actor,
    ],
  );
  for (const [brand, slug] of [
    [brandA, "merek-a"],
    [brandB, "merek-b"],
  ] as const)
    await q(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,$3,$4)`,
      [brand, tenantId, slug, `Merek ${slug}`],
    );
  await q(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1,$2,'PT Uji 0377',false)`,
    [legalEntityId, tenantId],
  );
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1,$2,$3,$4,'M377-B','Outlet merek B','Jl. Uji','{}','active')`,
    [outletB, tenantId, brandB, legalEntityId],
  );
  uomId = (
    await q(
      `INSERT INTO uoms (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [tenantId, `u${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  userId = (await q(`SELECT id FROM "user" ORDER BY id LIMIT 1`, [])).rows[0]
    .id;
  // The recipe is of brand A; the menu item and its variant are of brand B.
  await q(
    `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
     VALUES ($1,$2,$3,'Resep merek A',NULL,'1.0000',$4,true,$5,$6)`,
    [ids.recipe, tenantId, brandA, uomId, userId, at(1)],
  );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order, updated_at) VALUES ($1,$2,$3,'Kategori B',0,$4)`,
    [ids.category, tenantId, brandB, at(2)],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, recipe_id, updated_at)
     VALUES ($1,$2,$3,$4,'Menu merek B',true,$5,$6)`,
    [ids.item, tenantId, brandB, ids.category, ids.recipe, at(3)],
  );
  await q(
    `INSERT INTO item_variants (id, tenant_id, menu_item_id, name, recipe_id, updated_at)
     VALUES ($1,$2,$3,'Besar',$4,$5)`,
    [ids.variant, tenantId, ids.item, ids.recipe, at(4)],
  );
}

async function cloudPage(stream: Stream, since: string | null) {
  await settleCloud(mainOwner);
  const query = catalogSyncQuerySchema.parse({
    stream,
    limit: 100,
    protocolVersion: CATALOG_PROTOCOL_VERSION,
    ...(since === null ? {} : { since }),
  });
  const page = (await listCatalogRecordsSince(db, {
    tenantId: tenantId as never,
    outletId: outletB as never,
    query,
  })) as unknown as {
    records: Rec[];
    nextCursor: string | null;
    hasMore: boolean;
  };
  return { protocolVersion: CATALOG_PROTOCOL_VERSION, stream, ...page };
}

// ----------------------------------------------------------------- edge

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

async function applySnapshotOnEdge() {
  const response = await request(app)
    .get(MASTERS_PATH)
    .set("Authorization", `Bearer ${node.credential}`)
    .set(
      EDGE_MASTER_SNAPSHOT_VERSION_HEADER,
      String(EDGE_MASTER_SNAPSHOT_VERSION),
    );
  expect(response.status).toBe(200);
  const claims = parseEdgeCredential(node.credential);
  expect(claims).not.toBeNull();
  await edge.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', ${JSON.stringify([outletB])}, true)`,
    );
    return applyEdgeMasterSnapshotInTransaction(
      tx as never,
      claims!,
      response.body.snapshot as EdgeMasterSnapshot,
    );
  });
}

async function pull() {
  return (await pullCatalog({
    database: edge.database,
    context: scopeOf("device"),
    edgeNodeId: node.id,
    fetchPage: cloudPage,
  } as never)) as { streams: Record<string, { error?: unknown } | undefined> };
}

/** The SQL of 0377 as the migrator runs it on an edge database. */
async function runMigrationOnEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('legend.edge_mode', 'on', true)");
    for (const statement of migrationSql) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Edge as an upgraded one looks BEFORE 0377: 0374 nulled the cross-brand links
 * and the 0262 trigger gave the rows a local sync_txid (`txid`).
 */
async function makeEdgePre0377(txid: string) {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('legend.skip_sync_txid','on',true)");
    await client.query(
      "UPDATE menu_items SET recipe_id = NULL, sync_txid = $1 WHERE id = $2",
      [txid, ids.item],
    );
    await client.query(
      "UPDATE item_variants SET recipe_id = NULL, sync_txid = $1 WHERE id = $2",
      [txid, ids.variant],
    );
    await client.query("UPDATE recipes SET sync_txid = $1 WHERE id = $2", [
      txid,
      ids.recipe,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const links = async () => ({
  item: (
    await edge.rows("SELECT recipe_id FROM menu_items WHERE id = $1", [
      ids.item,
    ])
  )[0]?.recipe_id,
  variant: (
    await edge.rows("SELECT recipe_id FROM item_variants WHERE id = $1", [
      ids.variant,
    ])
  )[0]?.recipe_id,
});
const checkpoints = async () =>
  edge.rows(
    `SELECT stream, watermark, last_success_at FROM edge_pull_checkpoints
      WHERE edge_node_id = $1 ORDER BY stream`,
    [node.id],
  );

async function resetEdgeCatalog() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_catalog_sale_overrides",
      "item_variants",
      "menu_items",
      "menu_categories",
      "recipe_lines",
      "recipes",
      "edge_pull_checkpoints",
    ])
      await client.query(`DELETE FROM ${table}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  await seedCloud();
  const registered = await registerEdgeNode(scopeOf("session"), actor, {
    outletId: outletB,
    role: "standby",
    label: "Mini PC 0377",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  edge = await createEdgeDatabase({ tenantId, outletId: outletB });
  await copyToEdge("edge_nodes", node.id);
  await copyToEdge("uoms", uomId);
  await copyToEdge(`"user"`, userId);
  await applySnapshotOnEdge();
}, 240_000);

beforeEach(async () => {
  await resetEdgeCatalog();
});

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  await edge?.cleanup();
  await mainOwner.end();
  await pool.end();
  await cloud.cleanup();
});

// ---------------------------------------------------------------- tests

describe("legend-2uqcd migration 0377 on an edge database", () => {
  for (const [label, txid] of [
    ["local sync_txid far above the cloud's", FAR_AHEAD],
    ["local sync_txid of 1 (below the cloud's)", "1"],
  ] as const)
    it(`restores recipe_id of the menu item and the variant after the next pull (${label})`, async () => {
      const first = await pull();
      for (const stream of THREE_STREAMS)
        expect(first.streams[stream]?.error).toBeFalsy();
      expect(await links()).toEqual({ item: ids.recipe, variant: ids.recipe });

      await makeEdgePre0377(txid);
      expect(await links()).toEqual({ item: null, variant: null });

      // Control: before 0377 a pull brings nothing (the checkpoint is current),
      // so the cross-brand link stays lost.
      await pull();
      expect(await links()).toEqual({ item: null, variant: null });

      await runMigrationOnEdge();
      const stamps = await edge.rows(
        `SELECT (SELECT sync_txid::text FROM recipes WHERE id = $1) AS r,
                (SELECT sync_txid::text FROM menu_items WHERE id = $2) AS m,
                (SELECT sync_txid::text FROM item_variants WHERE id = $3) AS v`,
        [ids.recipe, ids.item, ids.variant],
      );
      expect(stamps[0]).toEqual({ r: "0", m: "0", v: "0" });

      const again = await pull();
      for (const stream of THREE_STREAMS)
        expect(again.streams[stream]?.error).toBeFalsy();
      expect(await links()).toEqual({ item: ids.recipe, variant: ids.recipe });
    });

  it("clears only the watermark of the three streams and keeps the rows and last_success_at (the 24 h freshness gate is not reset)", async () => {
    await pull();
    const before = await checkpoints();
    const streamsBefore = before.map((r) => String(r.stream));
    expect(streamsBefore).toEqual(
      expect.arrayContaining([
        "catalog:recipes",
        "catalog:menu_items",
        "catalog:item_variants",
        "catalog:menu_categories",
      ]),
    );
    const categoryTxid = (
      await edge.rows("SELECT sync_txid::text AS t FROM menu_categories")
    )[0]!.t;

    await runMigrationOnEdge();
    const after = await checkpoints();
    expect(after.map((r) => String(r.stream))).toEqual(streamsBefore);
    for (const row of after) {
      const old = before.find((b) => b.stream === row.stream)!;
      expect(row.last_success_at).toEqual(old.last_success_at);
      if (THREE_STREAMS.some((s) => `catalog:${s}` === String(row.stream)))
        expect(row.watermark).toBeNull();
      else expect(row.watermark).toBe(old.watermark);
    }
    // Other streams keep their stamps.
    expect(
      (await edge.rows("SELECT sync_txid::text AS t FROM menu_categories"))[0]!
        .t,
    ).toBe(categoryTxid);
  });

  it("leaves the owner's stale-catalog sales override and the menu rows untouched, and later local writes are stamped again", async () => {
    await pull();
    await edge.rows(
      `INSERT INTO edge_catalog_sale_overrides (id, tenant_id, outlet_id, edge_node_id, granted_by, granted_at, until_at, reason)
       VALUES ($1,$2,$3,$4,$5,now(),$6,'uji migrasi 0377')`,
      [
        ids.override,
        tenantId,
        outletB,
        node.id,
        userId,
        new Date(Date.now() + 3_600_000),
      ],
    );
    const snapshot = async () => ({
      override: await edge.rows(
        "SELECT * FROM edge_catalog_sale_overrides WHERE id = $1",
        [ids.override],
      ),
      items: await edge.rows(
        "SELECT id, name, recipe_id, is_active FROM menu_items ORDER BY id",
      ),
    });
    const before = await snapshot();
    expect(before.override).toHaveLength(1);
    await runMigrationOnEdge();
    expect(await snapshot()).toEqual(before);

    // skip_sync_txid is switched off again (drizzle runs all pending
    // migrations in one transaction; later ones must be stamped normally).
    const client = await edge.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('legend.edge_mode','on',true)");
      for (const statement of migrationSql) await client.query(statement);
      const flag = await client.query(
        "SELECT coalesce(current_setting('legend.skip_sync_txid', true), '') AS v",
      );
      expect(flag.rows[0].v).not.toBe("on");
      await client.query("UPDATE menu_items SET name = name WHERE id = $1", [
        ids.item,
      ]);
      const stamp = await client.query(
        "SELECT sync_txid::text AS t FROM menu_items WHERE id = $1",
        [ids.item],
      );
      expect(stamp.rows[0].t).not.toBe("0");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
});
