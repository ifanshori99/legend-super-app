// #818 P1-2/P1-3 contracts: stripped snapshot headers must recover through
// query negotiation, and signed brand pages must preserve all other masters.
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  brandIdSchema,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { CATALOG_PROTOCOL_VERSION } from "@starter/shared/edge";
import { edgeMasterSnapshotResponseSchema } from "@starter/shared/edge/master-sync";
import { uomIdSchema } from "@starter/shared/inventory";
import { createApp } from "../app.ts";
import { db, pool } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { bootstrapEdgeNodeIfNeeded } from "../edge/bootstrap.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import {
  startCatalogGate,
  type CatalogGateHandle,
} from "../edge/catalog-gate.ts";
import { CRITICAL_CATALOG_STREAMS } from "../edge/catalog-freshness.ts";
import {
  assertCatalogSalesAllowed,
  getSalesGateState,
  installSalesGateProvider,
  setSalesGateEdgeModeForTests,
} from "../edge/sales-gate.ts";
import {
  startEdgeMasterSyncLoop,
  syncEdgeMasters,
} from "../edge/master-sync.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import {
  edgeBootstrapSignatureMatches,
  signEdgeBootstrapBundle,
} from "../services/edge-bootstrap.service.ts";
import {
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import {
  provisionOutletStockLocations,
  provisionStandardUoms,
} from "../services/inventory-provisioning.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";
import { createWorld, owner } from "./member-loyalty-helpers.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});
const app = createApp();
const MASTERS = "/api/edge-sync/bootstrap/masters";
const CATALOG = "/api/edge-sync/catalog";
type Fixture = Awaited<ReturnType<typeof seed>>;
let small: Fixture;
let large: Fixture;
let foreignBrand: string;
const edges: EdgeDatabase[] = [];
const gates: CatalogGateHandle[] = [];
const DAY = 24 * 60 * 60_000;

async function seed(count: number, recipeBrandOverride?: string) {
  const world = await createWorld();
  const extra = Array.from({ length: count - 2 }, () => randomUUID());
  const lastBrand = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  // The two fixtures are separate tenants, so use a different high UUID.
  const recipeBrand =
    recipeBrandOverride ??
    (count === 2 ? "ffffffff-ffff-4fff-bfff-fffffffffffe" : lastBrand);
  const others = [...extra, recipeBrand];
  await owner.query(
    "INSERT INTO brands (id,tenant_id,slug,name) SELECT id,$1,'b-'||id::text,'Brand '||id::text FROM unnest($2::uuid[]) AS id",
    [world.tenantId, others],
  );
  const entity = (
    await owner.query<{ legal_entity_id: string }>(
      "SELECT legal_entity_id FROM outlets WHERE id=$1",
      [world.outletA],
    )
  ).rows[0]!.legal_entity_id;
  await withTenant(db, world.context, async (tx) => {
    await provisionStandardUoms(tx, world.context, null);
    await provisionOutletStockLocations(tx, world.context, world.outletA, null);
    await provisionStandardChart(tx, world.context, entity, null);
  });
  const uom = (
    await owner.query<{ id: string }>(
      "SELECT id FROM uoms WHERE tenant_id=$1 ORDER BY id LIMIT 1",
      [world.tenantId],
    )
  ).rows[0]!.id;
  const author = (
    await owner.query<{ id: string }>(
      'SELECT id FROM "user" ORDER BY id LIMIT 1',
    )
  ).rows[0]!.id;
  const crossRecipe = randomUUID();
  const ownRecipe = randomUUID();
  const category = randomUUID();
  const item = randomUUID();
  const variant = randomUUID();
  for (const [recipe, brand] of [
    [crossRecipe, recipeBrand],
    [ownRecipe, world.brandId],
  ]) {
    await owner.query(
      "INSERT INTO recipes (id,tenant_id,brand_id,name,output_item_id,yield_quantity,yield_uom_id,is_active,updated_by) VALUES ($1,$2,$3,$4,NULL,'1.0000',$5,true,$6)",
      [recipe, world.tenantId, brand, `Recipe ${recipe}`, uom, author],
    );
    await settleCloud(owner);
  }
  await owner.query(
    "INSERT INTO menu_categories (id,tenant_id,brand_id,name) VALUES ($1,$2,$3,'Own menu')",
    [category, world.tenantId, world.brandId],
  );
  await owner.query(
    "INSERT INTO menu_items (id,tenant_id,brand_id,category_id,name,is_active,recipe_id) VALUES ($1,$2,$3,$4,'Cross brand recipe item',true,$5)",
    [item, world.tenantId, world.brandId, category, crossRecipe],
  );
  await owner.query(
    "INSERT INTO item_variants (id,tenant_id,menu_item_id,name,recipe_id) VALUES ($1,$2,$3,'Large',$4)",
    [variant, world.tenantId, item, crossRecipe],
  );
  await settleCloud(owner);
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: `Second opinion ${count}`,
  });
  const parsed = parseEdgeRuntimeConfig({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: "wss://cloud.second-opinion.test/api/edge-link",
    EDGE_NODE_CREDENTIAL: registered.credential,
    EDGE_NODE_ROLE: "primary",
  });
  if (!parsed.ok) throw new Error(parsed.problems.join(", "));
  if (!parsed.config.edgeMode)
    throw new Error("Edge fixture requires edge mode");
  return {
    world,
    others,
    recipeBrand,
    crossRecipe,
    ownRecipe,
    item,
    variant,
    credential: registered.credential,
    nodeId: registered.edgeNode.id,
    config: parsed.config,
  };
}

async function makeEdge(f: Fixture) {
  const edge = await createEdgeDatabase({
    tenantId: f.world.tenantId,
    outletId: f.world.outletA,
  });
  edges.push(edge);
  await copyNode(f, edge);
  return edge;
}

async function copyNode(f: Fixture, edge: EdgeDatabase) {
  const row = (
    await owner.query(
      "SELECT row_to_json(n) AS row FROM edge_nodes n WHERE id=$1",
      [f.nodeId],
    )
  ).rows[0]!.row;
  await edge.owner.query(
    "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes,$1::json) ON CONFLICT DO NOTHING",
    [JSON.stringify(row)],
  );
}

function masters(
  f: Fixture,
  query: Record<string, string | number> = {},
  header = "2",
) {
  return request(app)
    .get(MASTERS)
    .set("Authorization", `Bearer ${f.credential}`)
    .set("x-edge-snapshot-version", header)
    .query(query);
}

function proxy(f: Fixture, mode: "strip-header" | "current" | "old") {
  const catalogVersions: number[] = [];
  const masterVersions: number[] = [];
  let rounds = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const headers = new Headers(init?.headers);
    const req = request(app)
      .get(url.pathname)
      .set(
        "Authorization",
        headers.get("Authorization") ?? `Bearer ${f.credential}`,
      );
    const query = Object.fromEntries(url.searchParams);
    if (url.pathname === MASTERS) {
      if (mode !== "old") req.query(query);
      if (mode === "current")
        req.set(
          "x-edge-snapshot-version",
          headers.get("x-edge-snapshot-version") ?? "",
        );
    } else if (url.pathname === CATALOG) {
      catalogVersions.push(Number(query.protocolVersion));
      req.query(mode === "old" ? { ...query, protocolVersion: 2 } : query);
    } else {
      req.query(query);
    }
    const res = await req;
    if (url.pathname === MASTERS && res.status === 200)
      masterVersions.push(Number(res.body.snapshot.version));
    if (url.pathname === CATALOG && query.stream === "vouchers") rounds++;
    return Response.json(res.body, { status: res.status });
  };
  return { fetchImpl, catalogVersions, masterVersions, rounds: () => rounds };
}

async function runRounds(
  f: Fixture,
  edge: EdgeDatabase,
  via: ReturnType<typeof proxy>,
  rounds = 2,
) {
  const initialRounds = via.rounds();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const worker = startEdgeMasterSyncLoop({
    database: edge.database,
    config: f.config,
    intervalMs: 60_000,
    catalogOnStart: false,
    options: { fetchImpl: via.fetchImpl },
  });
  try {
    for (
      let expected = initialRounds + 1;
      expected <= initialRounds + rounds;
      expected++
    ) {
      // Last-page HTTP completion precedes its commit and the loop becoming
      // idle. Retry interval ticks until an idle loop accepts the next one.
      await vi.waitFor(
        async () => {
          if (via.rounds() < expected)
            await vi.advanceTimersByTimeAsync(60_000);
          expect(via.rounds()).toBeGreaterThanOrEqual(expected);
        },
        { timeout: 15_000, interval: 30 },
      );
    }
  } finally {
    await worker.stop();
    vi.useRealTimers();
  }
}

function hasErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function salesRig(f: Fixture, edge: EdgeDatabase) {
  const startedAt = new Date("2026-11-15T00:00:00.000Z");
  let elapsed = 0;
  const wall = () => new Date(startedAt.getTime() + elapsed);
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(f.world.tenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(f.world.outletA)] },
  );
  const gate = await startCatalogGate({
    context,
    scope: {
      tenantId: f.world.tenantId,
      outletId: f.world.outletA,
      edgeNodeId: f.nodeId,
    },
    database: edge.database,
    overrides: { load: async () => null, close: async () => undefined },
    seed: async (freshness) => {
      for (const stream of CRITICAL_CATALOG_STREAMS)
        freshness.seedLastSuccess(stream, startedAt);
    },
    persistMs: 10 * DAY,
    wall,
    mono: () => 10_000 + elapsed,
  });
  gates.push(gate);
  setSalesGateEdgeModeForTests(() => true);
  expect(getSalesGateState().blocked).toBe(false);
  return {
    gate,
    wall,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

async function failedMasterRound(
  f: Fixture,
  edge: EdgeDatabase,
  via: ReturnType<typeof proxy>,
  fetchImpl: typeof fetch,
  gate: CatalogGateHandle,
) {
  const failures: unknown[] = [];
  const finished = () =>
    CRITICAL_CATALOG_STREAMS.every(
      (stream) =>
        gate.freshness.snapshot().streams[stream]?.lastSuccessAt?.getTime() ===
        gate.clock.now().getTime(),
    ) || failures.some((error) => hasErrorCode(error, "MASTERS_INCOMPLETE"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const worker = startEdgeMasterSyncLoop({
    database: edge.database,
    config: f.config,
    intervalMs: 60_000,
    catalogOnStart: false,
    options: { fetchImpl },
    catalog: { freshness: gate.freshness },
    onError: (error) => failures.push(error),
  });
  try {
    await vi.waitFor(
      async () => {
        if (!finished()) await vi.advanceTimersByTimeAsync(60_000);
        expect(finished()).toBe(true);
      },
      { timeout: 20_000, interval: 30 },
    );
  } finally {
    await worker.stop();
    vi.useRealTimers();
  }
  return failures;
}

function expectFreshSales(rig: Awaited<ReturnType<typeof salesRig>>) {
  for (const stream of CRITICAL_CATALOG_STREAMS) {
    expect
      .soft(rig.gate.freshness.snapshot().streams[stream]?.lastSuccessAt)
      .toEqual(rig.wall());
  }
  expect
    .soft(getSalesGateState())
    .toMatchObject({ blocked: false, stale24h: false });
  expect.soft(() => assertCatalogSalesAllowed()).not.toThrow();
}

beforeAll(async () => {
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  small = await seed(2);
  large = await seed(201);
  foreignBrand = (await createWorld()).brandId;
}, 240_000);
afterEach(async () => {
  for (const gate of gates.splice(0)) await gate.stop();
  setSalesGateEdgeModeForTests(null);
  installSalesGateProvider(null);
  for (const edge of edges.splice(0)) await edge.cleanup();
});
afterAll(async () => {
  setEdgeCredentialVerifier(null);
  await owner.end();
  await pool.end();
  await cloud.cleanup();
});

describe("#818 P1-3 signed master brand pagination", () => {
  it("serves exactly 200 and then 201 brands without losing non-brand masters or crossing tenants", async () => {
    const removed = large.others[0]!;
    await owner.query("DELETE FROM brands WHERE id=$1", [removed]);
    try {
      const boundary = await masters(large, {
        snapshotVersion: 2,
        brandPage: 1,
      });
      expect(boundary.status).toBe(200);
      expect(boundary.body.snapshot.brands).toHaveLength(200);
      expect(boundary.body.snapshot.nextBrandCursor).toBeUndefined();
    } finally {
      await owner.query(
        "INSERT INTO brands (id,tenant_id,slug,name) VALUES ($1,$2,$3,'Restored boundary brand')",
        [removed, large.world.tenantId, `b-${removed}`],
      );
    }
    const ids = new Set<string>();
    const cursors: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const response = await masters(large, {
        snapshotVersion: 2,
        brandPage: 1,
        ...(cursor ? { brandCursor: cursor } : {}),
      });
      expect(response.status).toBe(200);
      const snapshot = response.body.snapshot;
      expect(snapshot.version).toBe(2);
      expect(snapshot.brands.length).toBeLessThanOrEqual(200);
      expect(
        snapshot.brands.map((brand: { id: string }) => brand.id),
      ).toContain(large.world.brandId);
      expect(snapshot.uoms.length).toBeGreaterThan(0);
      expect(snapshot.stockLocations.length).toBeGreaterThan(0);
      expect(snapshot.chartOfAccounts.length).toBeGreaterThan(0);
      expect(snapshot.accountMappings.length).toBeGreaterThan(0);
      const claims = parseEdgeCredential(large.credential)!;
      expect(
        edgeBootstrapSignatureMatches(
          snapshot,
          response.body.signature,
          claims.hash,
        ),
      ).toBe(true);
      for (const brand of snapshot.brands) {
        expect(brand.tenantId).toBe(large.world.tenantId);
        ids.add(brand.id);
      }
      cursor = snapshot.nextBrandCursor;
      if (!cursor) break;
      expect(cursors).not.toContain(cursor);
      cursors.push(cursor);
    }
    expect(cursors.length).toBeGreaterThan(0);
    expect(ids.size).toBe(201);
    expect(ids.has(large.recipeBrand)).toBe(true);
    expect(ids.has(foreignBrand)).toBe(false);
  });

  it("keeps complete non-brand masters in a signed v1 fallback for header-only edges above 200 brands", async () => {
    const response = await masters(large);
    expect(response.status).toBe(200);
    expect(response.body.snapshot.version).toBe(1);
    expect(response.body.snapshot).not.toHaveProperty("brands");
    expect(response.body.snapshot.uoms.length).toBeGreaterThan(0);
    expect(response.body.snapshot.chartOfAccounts.length).toBeGreaterThan(0);
  });

  it("rejects a valid cursor belonging to another tenant", async () => {
    const response = await masters(large, {
      snapshotVersion: 2,
      brandPage: 1,
      brandCursor: foreignBrand,
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(foreignBrand);
  });

  it("rejects malformed, duplicate and unscoped page queries, plus own or missing cursors", async () => {
    for (const query of [
      "snapshotVersion=2&brandPage=1&brandCursor=invalid",
      "snapshotVersion=2&snapshotVersion=1&brandPage=1",
      `snapshotVersion=2&brandCursor=${foreignBrand}`,
      "snapshotVersion=1&brandPage=1",
      "snapshotVersion=2&brandPage=1&unknown=1",
    ]) {
      const response = await request(app)
        .get(`${MASTERS}?${query}`)
        .set("Authorization", `Bearer ${large.credential}`);
      expect(response.status, query).toBe(422);
    }
    for (const cursor of [large.world.brandId, randomUUID()]) {
      const response = await masters(large, {
        snapshotVersion: 2,
        brandPage: 1,
        brandCursor: cursor,
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("#818 P1-2 master/catalog capability pairing", () => {
  it("recovers from a proxy stripping only the snapshot header through master A, recipe A, menu and variant", async () => {
    const edge = await makeEdge(small);
    const via = proxy(small, "strip-header");
    await runRounds(small, edge, via);
    expect(via.masterVersions).toContain(2);
    expect(via.catalogVersions).toContain(CATALOG_PROTOCOL_VERSION);
    expect(
      await edge.rows("SELECT id FROM brands WHERE id=$1", [small.recipeBrand]),
    ).toHaveLength(1);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [
        small.crossRecipe,
      ]),
    ).toHaveLength(1);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [
        small.item,
      ]),
    ).toEqual([{ recipe_id: small.crossRecipe }]);
    expect(
      await edge.rows("SELECT recipe_id FROM item_variants WHERE id=$1", [
        small.variant,
      ]),
    ).toEqual([{ recipe_id: small.crossRecipe }]);
    expect(
      await edge.rows(
        "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id=$1 AND stream='catalog:recipes' AND watermark IS NOT NULL",
        [small.nodeId],
      ),
    ).toHaveLength(1);
  }, 90_000);

  it("pairs an old cloud's master v1 with catalog v2", async () => {
    const edge = await makeEdge(small);
    const via = proxy(small, "old");
    await runRounds(small, edge, via);
    expect(via.masterVersions.every((version) => version === 1)).toBe(true);
    expect(via.catalogVersions.length).toBeGreaterThan(0);
    expect(via.catalogVersions.every((version) => version === 2)).toBe(true);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [small.ownRecipe]),
    ).toHaveLength(1);
  }, 90_000);

  it("rewinds only the recipe cursor after a v1/v2 edge upgrades to complete master v2/catalog v3", async () => {
    const edge = await makeEdge(small);
    const old = proxy(small, "old");
    await runRounds(small, edge, old);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [
        small.crossRecipe,
      ]),
    ).toEqual([]);
    const oldCursor = (
      await edge.rows(
        "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id=$1 AND stream='catalog:recipes'",
        [small.nodeId],
      )
    )[0]?.watermark;
    expect(oldCursor).toBeTruthy();
    const freshAt = "2026-11-15T00:00:00.000Z";
    await edge.owner.query(
      "UPDATE edge_pull_checkpoints SET last_success_at=$2 WHERE edge_node_id=$1 AND stream='catalog:recipes'",
      [small.nodeId, freshAt],
    );
    const otherBefore = await edge.rows(
      "SELECT watermark,last_success_at FROM edge_pull_checkpoints WHERE edge_node_id=$1 AND stream='catalog:menu_categories'",
      [small.nodeId],
    );
    const current = proxy(small, "strip-header");
    await syncEdgeMasters(
      small.config,
      { fetchImpl: current.fetchImpl },
      edge.database,
    );
    expect(
      await edge.rows(
        "SELECT watermark,last_success_at FROM edge_pull_checkpoints WHERE edge_node_id=$1 AND stream='catalog:recipes'",
        [small.nodeId],
      ),
    ).toEqual([{ watermark: null, last_success_at: new Date(freshAt) }]);
    expect(
      await edge.rows(
        "SELECT watermark,last_success_at FROM edge_pull_checkpoints WHERE edge_node_id=$1 AND stream='catalog:menu_categories'",
        [small.nodeId],
      ),
    ).toEqual(otherBefore);
    await runRounds(small, edge, current);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [
        small.crossRecipe,
      ]),
    ).toHaveLength(1);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [
        small.item,
      ]),
    ).toEqual([{ recipe_id: small.crossRecipe }]);
    expect(
      await edge.rows("SELECT recipe_id FROM item_variants WHERE id=$1", [
        small.variant,
      ]),
    ).toEqual([{ recipe_id: small.crossRecipe }]);
  }, 90_000);

  it("recovers all 201 brands and the last brand recipe on an existing B-only edge", async () => {
    const edge = await makeEdge(large);
    const via = proxy(large, "strip-header");
    await runRounds(large, edge, via);
    expect(
      await edge.rows("SELECT id FROM brands WHERE tenant_id=$1", [
        large.world.tenantId,
      ]),
    ).toHaveLength(201);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [
        large.crossRecipe,
      ]),
    ).toHaveLength(1);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [
        large.item,
      ]),
    ).toEqual([{ recipe_id: large.crossRecipe }]);
    expect(
      await edge.rows("SELECT recipe_id FROM item_variants WHERE id=$1", [
        large.variant,
      ]),
    ).toEqual([{ recipe_id: large.crossRecipe }]);
    expect(
      await edge.rows("SELECT id FROM brands WHERE id=$1", [foreignBrand]),
    ).toEqual([]);
  }, 90_000);

  it("bootstraps a fresh edge with 201 brands, then applies the last brand recipe and its menu links", async () => {
    const edge = await makeEdge(large);
    const client = await edge.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role=replica");
      for (const table of [
        "edge_nodes",
        "outlets",
        "brands",
        "legal_entities",
        "tenants",
      ])
        await client.query(`DELETE FROM ${table}`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const via = proxy(large, "strip-header");
    await bootstrapEdgeNodeIfNeeded(
      large.config,
      { fetchImpl: via.fetchImpl },
      edge.database,
    );
    expect(
      await edge.rows("SELECT id FROM brands WHERE tenant_id=$1", [
        large.world.tenantId,
      ]),
    ).toHaveLength(201);
    expect((await edge.rows("SELECT id FROM uoms")).length).toBeGreaterThan(0);
    expect(
      (await edge.rows("SELECT id FROM chart_of_accounts")).length,
    ).toBeGreaterThan(0);
    await copyNode(large, edge);
    await runRounds(large, edge, via);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [
        large.item,
      ]),
    ).toEqual([{ recipe_id: large.crossRecipe }]);
    expect(
      await edge.rows("SELECT recipe_id FROM item_variants WHERE id=$1", [
        large.variant,
      ]),
    ).toEqual([{ recipe_id: large.crossRecipe }]);
  }, 90_000);

  it("#834 a failed later master page keeps catalog v2 and sales available, then widens on recovery", async () => {
    const f = await seed(201, "ffffffff-ffff-4fff-bfff-fffffffffffc");
    await owner.query("UPDATE menu_items SET recipe_id=$2 WHERE id=$1", [
      f.item,
      f.ownRecipe,
    ]);
    await owner.query("UPDATE item_variants SET recipe_id=$2 WHERE id=$1", [
      f.variant,
      f.ownRecipe,
    ]);
    await settleCloud(owner);
    const edge = await makeEdge(f);
    const via = proxy(f, "strip-header");
    const rig = await salesRig(f, edge);
    let continuationAttempts = 0;
    const failing: typeof fetch = (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname === MASTERS && url.searchParams.has("brandCursor")) {
        continuationAttempts++;
        return Promise.resolve(
          Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 }),
        );
      }
      return via.fetchImpl(input, init);
    };
    await expect(
      syncEdgeMasters(f.config, { fetchImpl: failing }, edge.database),
    ).rejects.toThrow();
    expect(continuationAttempts).toBeGreaterThan(0);
    expect((await edge.rows("SELECT id FROM uoms")).length).toBeGreaterThan(0);
    expect(
      (await edge.rows("SELECT id FROM chart_of_accounts")).length,
    ).toBeGreaterThan(0);
    expect(
      await edge.rows("SELECT id FROM brands WHERE tenant_id=$1", [
        f.world.tenantId,
      ]),
    ).toHaveLength(200);
    rig.advance(DAY + 1);
    await failedMasterRound(f, edge, via, failing, rig.gate);
    expect.soft(via.catalogVersions.length).toBeGreaterThan(0);
    expect
      .soft(via.catalogVersions.every((version) => version === 2))
      .toBe(true);
    expectFreshSales(rig);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [f.crossRecipe]),
    ).toEqual([]);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [f.item]),
    ).toEqual([{ recipe_id: f.ownRecipe }]);
    expect(
      await edge.rows(
        "SELECT watermark FROM edge_pull_checkpoints WHERE edge_node_id=$1 AND stream='catalog:recipes' AND watermark IS NOT NULL",
        [f.nodeId],
      ),
    ).toHaveLength(1);
    await owner.query("UPDATE menu_items SET recipe_id=$2 WHERE id=$1", [
      f.item,
      f.crossRecipe,
    ]);
    await owner.query("UPDATE item_variants SET recipe_id=$2 WHERE id=$1", [
      f.variant,
      f.crossRecipe,
    ]);
    await settleCloud(owner);
    via.catalogVersions.splice(0);
    await runRounds(f, edge, via);
    expect(
      via.catalogVersions.every(
        (version) => version === CATALOG_PROTOCOL_VERSION,
      ),
    ).toBe(true);
    expect(
      await edge.rows("SELECT id FROM brands WHERE tenant_id=$1", [
        f.world.tenantId,
      ]),
    ).toHaveLength(201);
    expect(
      await edge.rows("SELECT id FROM recipes WHERE id=$1", [f.crossRecipe]),
    ).toHaveLength(1);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [f.item]),
    ).toEqual([{ recipe_id: f.crossRecipe }]);
    expect(
      await edge.rows("SELECT recipe_id FROM item_variants WHERE id=$1", [
        f.variant,
      ]),
    ).toEqual([{ recipe_id: f.crossRecipe }]);
  }, 90_000);

  it("#834 repeated LOCAL_CONFLICT after a prior v2 success downgrades to catalog v2 without aging sales closed", async () => {
    const f = await seed(2, "ffffffff-ffff-4fff-bfff-fffffffffffb");
    const edge = await makeEdge(f);
    const via = proxy(f, "strip-header");
    await runRounds(f, edge, via, 1);
    expect(via.catalogVersions).toContain(CATALOG_PROTOCOL_VERSION);
    via.catalogVersions.splice(0);
    const rig = await salesRig(f, edge);
    const claims = parseEdgeCredential(f.credential);
    if (!claims) throw new Error("Missing fixture credential");
    const conflicting: typeof fetch = async (input, init) => {
      const response = await via.fetchImpl(input, init);
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname !== MASTERS || !response.ok) return response;
      const body = edgeMasterSnapshotResponseSchema.parse(
        await response.json(),
      );
      const firstUom = body.snapshot.uoms[0];
      if (!firstUom) throw new Error("Missing fixture UOM");
      firstUom.id = uomIdSchema.parse(randomUUID());
      return Response.json({
        snapshot: body.snapshot,
        signature: signEdgeBootstrapBundle(body.snapshot, claims.hash),
      });
    };
    const failures: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      rig.advance(DAY / 2);
      failures.push(
        ...(await failedMasterRound(f, edge, via, conflicting, rig.gate)),
      );
    }
    expect(
      failures.filter((error) => hasErrorCode(error, "LOCAL_CONFLICT")),
    ).toHaveLength(3);
    expect.soft(via.catalogVersions.length).toBeGreaterThan(0);
    expect
      .soft(via.catalogVersions.every((version) => version === 2))
      .toBe(true);
    expectFreshSales(rig);
    expect(
      await edge.rows("SELECT recipe_id FROM menu_items WHERE id=$1", [f.item]),
    ).toEqual([{ recipe_id: f.crossRecipe }]);
    via.catalogVersions.splice(0);
    await runRounds(f, edge, via, 1);
    expect(via.catalogVersions).toContain(CATALOG_PROTOCOL_VERSION);
  }, 120_000);

  it("verifies the signed continuation cursor before following it", async () => {
    const isolated = await seed(201, randomUUID());
    const edge = await makeEdge(isolated);
    const via = proxy(isolated, "strip-header");
    let snapshotStatus = 0;
    let calls = 0;
    let signedCursor: unknown;
    const tampered: typeof fetch = async (input, init) => {
      calls++;
      const response = await via.fetchImpl(input, init);
      snapshotStatus = response.status;
      if (!response.ok) return response;
      const body = edgeMasterSnapshotResponseSchema.parse(
        await response.json(),
      );
      signedCursor = body.snapshot?.nextBrandCursor;
      if (typeof signedCursor !== "string") return Response.json(body);
      body.snapshot.nextBrandCursor = brandIdSchema.parse(foreignBrand);
      return Response.json(body);
    };
    const result = await syncEdgeMasters(
      isolated.config,
      {
        fetchImpl: tampered,
      },
      edge.database,
    ).catch((error: unknown) => error);
    expect(snapshotStatus).toBe(200);
    expect(signedCursor).toBeTypeOf("string");
    expect(result).toMatchObject({ code: "BAD_SIGNATURE" });
    expect(calls).toBe(1);
    expect(
      await edge.rows("SELECT id FROM brands WHERE tenant_id=$1", [
        isolated.world.tenantId,
      ]),
    ).toEqual([{ id: isolated.world.brandId }]);
  }, 90_000);
});
