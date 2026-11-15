// Every edge receives ALL recipes of its tenant (bead legend-2uqcd; brief
// "800 Resep tenant ke semua edge"), not only the recipes of its own brand.
// Written from the brief and the shared contracts
// (packages/shared/src/edge/catalog-sync.ts, master-sync.ts), not from the
// implementation.
//
//  (a) the `recipes` catalog stream for the credential of an outlet of brand B
//      also serves the recipes of brand A, nested recipes included, and never
//      a recipe of another tenant;
//  (b) the master snapshot (version 2) carries `brands`: every brand of the
//      tenant, none of another tenant;
//  (c) after that snapshot the edge applies the recipes of brand A and the
//      `catalog:recipes` checkpoint moves. Without the snapshot a recipe of an
//      unknown brand is a transient problem (retry later): the stream reports an
//      error and the checkpoint does not move.
//
// Assumptions (the brief does not pin them down):
//  - `snapshot.brands[].id` is the brand id (same row as the bootstrap brand);
//    `snapshot.version` is 2.
//  - A recipe of a brand the edge does not know yet is reported by the puller in
//    `result.streams.recipes.error` (truthy) and stores no checkpoint for it
//    (same as other missing references); the exact error code is not asserted.
//  - The cloud is a private database (helpers/catalog-database.ts) with a
//    private tenant; the edge is a second database (helpers/edge-database.ts).
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
import type { EdgeMasterSnapshot } from "@starter/shared/edge/master-sync";
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

type Stream = (typeof CATALOG_SYNC_STREAMS)[number];
type Rec = Record<string, unknown>;

const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const legalEntityId = randomUUID();
const brandA = randomUUID(); // has the recipes the edge of brand B must get
const brandB = randomUUID(); // brand of the edge's own outlet
const otherBrand = randomUUID();
const outletB = randomUUID();
const actor = randomUUID();
const id = () => randomUUID();
const ids = {
  recA: id(),
  recSubA: id(), // sub-recipe of brand A
  recNestedA: id(), // brand A recipe that has recSubA as a line
  recB: id(),
  recOther: id(),
  lineNested: id(),
  lineSub: id(),
  lineA: id(),
  lineB: id(),
  lineOther: id(),
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

// ---------------------------------------------------------------- cloud

async function insertRecipe(
  recipeId: string,
  brand: string,
  tenant: string,
  name: string,
  minute: number,
) {
  await mainOwner.query(
    `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,NULL,'1.0000',$5,true,$6,$7)`,
    [
      recipeId,
      tenant,
      brand,
      `${name} ${recipeId.slice(0, 6)}`,
      uomId,
      userId,
      at(minute),
    ],
  );
}

async function insertLine(
  lineId: string,
  recipeId: string,
  tenant: string,
  type: "item" | "recipe",
  componentId: string,
) {
  await mainOwner.query(
    `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
     VALUES ($1,$2,$3,0,$4,$5,'2.0000',$6,0)`,
    [lineId, tenant, recipeId, type, componentId, uomId],
  );
}

async function seedCloud() {
  const q = (text: string, params: unknown[]) => mainOwner.query(text, params);
  const fixtureTenant = cafeLegendPlatformFixtures.tenant;
  for (const [tenant, label] of [
    [tenantId, "Tenant uji resep"],
    [otherTenantId, "Tenant lain"],
  ] as const)
    await q(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [
        tenant,
        `resep-${tenant}`,
        label,
        fixtureTenant.plan,
        fixtureTenant.status,
        fixtureTenant.deploymentMode,
        JSON.stringify(fixtureTenant.featureFlags),
        JSON.stringify(fixtureTenant.limits),
        actor,
      ],
    );
  for (const [brand, tenant, slug] of [
    [brandA, tenantId, "merek-a"],
    [brandB, tenantId, "merek-b"],
    [otherBrand, otherTenantId, "merek-lain"],
  ] as const)
    await q(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1,$2,$3,$4)`,
      [brand, tenant, slug, `Merek ${slug}`],
    );
  await q(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1,$2,'PT Uji Resep',false)`,
    [legalEntityId, tenantId],
  );
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1,$2,$3,$4,'RSP-B','Outlet merek B','Jl. Uji','{}','active')`,
    [outletB, tenantId, brandB, legalEntityId],
  );
  uomId = (
    await q(
      `INSERT INTO uoms (tenant_id, code, name) VALUES ($1,$2,$2) RETURNING id`,
      [tenantId, `u${id().slice(0, 8)}`],
    )
  ).rows[0].id;
  userId = (await q(`SELECT id FROM "user" ORDER BY id LIMIT 1`, [])).rows[0]
    .id;

  await insertRecipe(ids.recA, brandA, tenantId, "Resep A", 10);
  await insertRecipe(ids.recSubA, brandA, tenantId, "Sub resep A", 11);
  await insertRecipe(ids.recNestedA, brandA, tenantId, "Resep bersarang A", 12);
  await insertRecipe(ids.recB, brandB, tenantId, "Resep B", 13);
  // A recipe of ANOTHER tenant must never travel (its brand is not ours).
  await q(`INSERT INTO uoms (tenant_id, code, name) VALUES ($1,'uo','uo')`, [
    otherTenantId,
  ]);
  const otherUom = (
    await q(`SELECT id FROM uoms WHERE tenant_id = $1`, [otherTenantId])
  ).rows[0].id;
  await q(
    `INSERT INTO recipes (id, tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by, updated_at)
     VALUES ($1,$2,$3,'Resep tenant lain',NULL,'1.0000',$4,true,$5,$6)`,
    [ids.recOther, otherTenantId, otherBrand, otherUom, userId, at(14)],
  );
  await insertLine(ids.lineA, ids.recA, tenantId, "item", id());
  await insertLine(ids.lineSub, ids.recSubA, tenantId, "item", id());
  await insertLine(
    ids.lineNested,
    ids.recNestedA,
    tenantId,
    "recipe",
    ids.recSubA,
  );
  await insertLine(ids.lineB, ids.recB, tenantId, "item", id());
  await q(
    `INSERT INTO recipe_lines (id, tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
     VALUES ($1,$2,$3,0,'item',$4,'1.0000',$5,0)`,
    [ids.lineOther, otherTenantId, ids.recOther, id(), otherUom],
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

/** Edge back to what the bootstrap leaves: only its own brand, no catalog. */
async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of ["recipe_lines", "recipes", "edge_pull_checkpoints"])
      await client.query(`DELETE FROM ${table}`);
    await client.query(`DELETE FROM brands WHERE id <> $1`, [brandB]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** One cloud page through the real service (the credential is outlet B's). */
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

async function walkRecipes(): Promise<Rec[]> {
  const records: Rec[] = [];
  let since: string | null = null;
  for (let n = 0; n < 50; n += 1) {
    const page = await cloudPage("recipes", since);
    records.push(...page.records);
    if (!page.hasMore) break;
    since = page.nextCursor;
  }
  return records;
}

const idsOf = (records: Rec[]) => records.map((r) => String(r.id));

// ----------------------------------------------------------------- edge

async function masterSnapshot(): Promise<EdgeMasterSnapshot> {
  const response = await request(app)
    .get(MASTERS_PATH)
    .set("Authorization", `Bearer ${node.credential}`)
    .set("x-edge-snapshot-version", "2");
  expect(response.status).toBe(200);
  return response.body.snapshot as EdgeMasterSnapshot;
}

async function applySnapshotOnEdge(snapshot: EdgeMasterSnapshot) {
  const claims = parseEdgeCredential(node.credential);
  expect(claims).not.toBeNull();
  return edge.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', ${JSON.stringify([outletB])}, true)`,
    );
    return applyEdgeMasterSnapshotInTransaction(tx as never, claims!, snapshot);
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

const recipeCheckpoint = async () =>
  (
    await edge.rows(
      "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = 'catalog:recipes'",
      [node.id],
    )
  )[0]?.watermark as string | undefined;
const edgeRecipeIds = async () =>
  (await edge.rows("SELECT id FROM recipes ORDER BY id")).map((r) =>
    String(r.id),
  );
const edgeBrandIds = async () =>
  (await edge.rows("SELECT id FROM brands ORDER BY id")).map((r) =>
    String(r.id),
  );

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
    label: "Mini PC merek B",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  edge = await createEdgeDatabase({ tenantId, outletId: outletB });
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
  await mainOwner.end();
  await pool.end();
  await cloud.cleanup();
});

// ---------------------------------------------------------------- tests

describe("legend-2uqcd (a) the recipes stream serves every recipe of the tenant", () => {
  it("legend-2uqcd-a the credential of an outlet of brand B gets the recipes of brand A, nested ones included, and the lines travel with them", async () => {
    const records = await walkRecipes();
    const got = idsOf(records);
    expect(got).toContain(ids.recB);
    expect(got).toContain(ids.recA);
    expect(got).toContain(ids.recSubA);
    expect(got).toContain(ids.recNestedA);
    const brandOf = (recipeId: string) =>
      records.find((r) => r.id === recipeId)?.brandId;
    expect(brandOf(ids.recA)).toBe(brandA);
    expect(brandOf(ids.recB)).toBe(brandB);
    // The nested recipe arrives as a whole document with its one line.
    const nested = records.find((r) => r.id === ids.recNestedA) as Rec;
    expect(idsOf(nested.lines as Rec[])).toEqual([ids.lineNested]);
  });

  it("legend-2uqcd-a never a recipe of another tenant", async () => {
    const got = idsOf(await walkRecipes());
    expect(got).not.toContain(ids.recOther);
    for (const rec of await walkRecipes()) expect(rec.tenantId).toBe(tenantId);
  });
});

describe("legend-2uqcd (b) the master snapshot carries every brand of the tenant", () => {
  it("legend-2uqcd-b snapshot version 2 lists the brands of the tenant (both brands), none of another tenant", async () => {
    const snapshot = await masterSnapshot();
    expect(snapshot.version).toBe(2);
    const brands = (
      snapshot as unknown as { brands: { id: string; tenantId: string }[] }
    ).brands;
    expect(brands.map((b) => b.id).sort()).toEqual([brandA, brandB].sort());
    for (const brand of brands) expect(brand.tenantId).toBe(tenantId);
  });
});

describe("legend-2uqcd (c) the edge applies the recipes of the other brand", () => {
  it("legend-2uqcd-c after the master snapshot the edge stores brand A recipes (nested too), their lines, and the recipes checkpoint moves", async () => {
    await applySnapshotOnEdge(await masterSnapshot());
    expect(await edgeBrandIds()).toEqual([brandA, brandB].sort());

    const result = await pull();
    expect(result.streams.recipes?.error).toBeFalsy();
    expect(await edgeRecipeIds()).toEqual(
      [ids.recA, ids.recSubA, ids.recNestedA, ids.recB].sort(),
    );
    expect(await edgeRecipeIds()).not.toContain(ids.recOther);
    const lines = await edge.rows(
      "SELECT id, component_id FROM recipe_lines WHERE recipe_id = $1",
      [ids.recNestedA],
    );
    expect(lines.map((l) => l.id)).toEqual([ids.lineNested]);
    expect(lines[0]!.component_id).toBe(ids.recSubA);
    const first = await recipeCheckpoint();
    expect(first).toBeTruthy();

    // A later change of a brand A recipe moves the checkpoint again.
    await mainOwner.query(
      `UPDATE recipes SET name = name || ' ubah' WHERE id = $1`,
      [ids.recA],
    );
    const again = await pull();
    expect(again.streams.recipes?.error).toBeFalsy();
    const second = await recipeCheckpoint();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(
      (
        await edge.rows("SELECT name FROM recipes WHERE id = $1", [ids.recA])
      )[0]!.name,
    ).toMatch(/ubah$/);
  });

  it("legend-2uqcd-c a recipe of a brand the edge does not know yet is retried later: error reported, nothing stored, checkpoint stays; after the snapshot it applies", async () => {
    const result = await pull();
    expect(result.streams.recipes?.error).toBeTruthy();
    expect(await recipeCheckpoint()).toBeUndefined();
    expect(await edgeRecipeIds()).toEqual([]);

    await applySnapshotOnEdge(await masterSnapshot());
    const healed = await pull();
    expect(healed.streams.recipes?.error).toBeFalsy();
    expect(await edgeRecipeIds()).toContain(ids.recA);
    expect(await recipeCheckpoint()).toBeTruthy();
  });
});
