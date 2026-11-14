// Master snapshot version compatibility (legend-2uqcd, review P1-1).
//
// Release order is cloud first, edge later. An OLD edge accepts the literal
// snapshot version 1 only, so the cloud serves version 2 (adds `brandId` and
// `brands`) ONLY to an edge that asks with the header
// `x-edge-snapshot-version: 2`; without it the snapshot is exactly version 1,
// with no brand fields. A NEW edge asks for version 2 and still applies the
// version 1 an older cloud answers (that cloud ignores the unknown header).
//
//  - no header (or a header that is not 2)  => version 1, no brands, no brandId;
//  - header 2                               => version 2, every brand of the tenant;
//  - the edge applies version 1 (no error, brands untouched) and version 2;
//  - the edge sends the header, and accepts a v1 answer from a cloud ignoring it.
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
  EDGE_MASTER_SNAPSHOT_VERSION_HEADER,
  edgeMasterSnapshotSchema,
  type EdgeMasterSnapshot,
} from "@starter/shared/edge/master-sync";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { pool } from "../db/index.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import {
  applyEdgeMasterSnapshotInTransaction,
  fetchVerifiedMasterSnapshot,
} from "../edge/master-sync.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import {
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});

const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";
const CLOUD_URL = "wss://cloud.compat.test/api/edge-link";

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const brandA = randomUUID();
const brandB = randomUUID(); // brand of the edge's own outlet
const outletB = randomUUID();
const actor = randomUUID();

const mainOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
let edge: EdgeDatabase;
let node: { id: string; credential: string };
const app = createApp();

const scopeOf = (source: "session" | "device"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletB)] },
  );

async function seedCloud() {
  const q = (text: string, params: unknown[]) => mainOwner.query(text, params);
  const fixtureTenant = cafeLegendPlatformFixtures.tenant;
  await q(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [
      tenantId,
      `compat-${tenantId}`,
      "Tenant uji kompatibilitas",
      fixtureTenant.plan,
      fixtureTenant.status,
      fixtureTenant.deploymentMode,
      JSON.stringify(fixtureTenant.featureFlags),
      JSON.stringify(fixtureTenant.limits),
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
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1,$2,'PT Uji Kompat',false)`,
    [legalEntityId, tenantId],
  );
  await q(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1,$2,$3,$4,'CMP-B','Outlet merek B','Jl. Uji','{}','active')`,
    [outletB, tenantId, brandB, legalEntityId],
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

/** Edge back to what the bootstrap leaves: only its own brand. */
async function resetEdge() {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(`DELETE FROM brands WHERE id <> $1`, [brandB]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const bearer = () => `Bearer ${node.credential}`;
async function cloudMasters(header?: string) {
  const req = request(app).get(MASTERS_PATH).set("Authorization", bearer());
  return header === undefined
    ? req
    : req.set(EDGE_MASTER_SNAPSHOT_VERSION_HEADER, header);
}

async function applyOnEdge(snapshot: EdgeMasterSnapshot) {
  const claims = parseEdgeCredential(node.credential);
  expect(claims).not.toBeNull();
  return edge.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true), set_config('app.outlet_ids', ${JSON.stringify([outletB])}, true)`,
    );
    return applyEdgeMasterSnapshotInTransaction(tx as never, claims!, snapshot);
  });
}

const edgeBrandIds = async () =>
  (await edge.rows("SELECT id FROM brands ORDER BY id")).map((r) =>
    String(r.id),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  await seedCloud();
  const registered = await registerEdgeNode(scopeOf("session"), actor, {
    outletId: outletB,
    role: "standby",
    label: "Mini PC kompat",
  });
  node = { id: registered.edgeNode.id, credential: registered.credential };
  edge = await createEdgeDatabase({ tenantId, outletId: outletB });
  await copyToEdge("edge_nodes", node.id);
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

describe("legend-2uqcd P1-1 master snapshot version negotiation (cloud side)", () => {
  it("serves version 1 without brand fields to an edge that did not ask (an old edge)", async () => {
    for (const header of [undefined, "1", "0", "abc", ""]) {
      const response = await cloudMasters(header);
      expect(response.status).toBe(200);
      const snapshot = response.body.snapshot as Record<string, unknown>;
      expect(snapshot.version).toBe(1);
      expect(snapshot).not.toHaveProperty("brands");
      expect(snapshot).not.toHaveProperty("brandId");
      // Exactly the keys an old edge's strict schema accepts.
      expect(Object.keys(snapshot).sort()).toEqual(
        [
          "accountMappings",
          "chartOfAccounts",
          "issuedAt",
          "legalEntityId",
          "outletId",
          "stockLocations",
          "tenantId",
          "uoms",
          "version",
        ].sort(),
      );
      expect(edgeMasterSnapshotSchema.safeParse(snapshot).success).toBe(true);
    }
  });

  it("serves version 2 with every brand of the tenant and the outlet's brand to an edge that asks", async () => {
    const response = await cloudMasters("2");
    expect(response.status).toBe(200);
    const snapshot = response.body.snapshot as EdgeMasterSnapshot;
    expect(snapshot.version).toBe(2);
    expect(snapshot.brandId).toBe(brandB);
    expect((snapshot.brands ?? []).map((b) => b.id).sort()).toEqual(
      [brandA, brandB].sort(),
    );
    expect(edgeMasterSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // A version above the newest is answered with the newest.
    const newer = await cloudMasters("9");
    expect(newer.body.snapshot.version).toBe(2);
  });

  it("the contract refuses brand fields on version 1 and requires them on version 2", async () => {
    const v2 = (await cloudMasters("2")).body.snapshot as EdgeMasterSnapshot;
    const v1 = (await cloudMasters()).body.snapshot as EdgeMasterSnapshot;
    expect(
      edgeMasterSnapshotSchema.safeParse({ ...v1, brands: [] }).success,
    ).toBe(false);
    expect(
      edgeMasterSnapshotSchema.safeParse({ ...v1, brandId: brandB }).success,
    ).toBe(false);
    const noBrands: Record<string, unknown> = { ...v2 };
    delete noBrands.brands;
    expect(edgeMasterSnapshotSchema.safeParse(noBrands).success).toBe(false);
    const noBrandId: Record<string, unknown> = { ...v2 };
    delete noBrandId.brandId;
    expect(edgeMasterSnapshotSchema.safeParse(noBrandId).success).toBe(false);
  });
});

describe("legend-2uqcd P1-1 master snapshot version negotiation (edge side)", () => {
  it("the edge applies a version 1 snapshot: no error, no brand written or deleted", async () => {
    const v1 = edgeMasterSnapshotSchema.parse(
      (await cloudMasters()).body.snapshot,
    );
    expect(await edgeBrandIds()).toEqual([brandB]);
    const counts = await applyOnEdge(v1);
    expect(counts.brands).toBe(0);
    expect(await edgeBrandIds()).toEqual([brandB]);
  });

  it("the edge applies a version 2 snapshot: brand A arrives, brand B stays", async () => {
    const v2 = edgeMasterSnapshotSchema.parse(
      (await cloudMasters("2")).body.snapshot,
    );
    const counts = await applyOnEdge(v2);
    expect(counts.brands).toBe(2);
    expect(await edgeBrandIds()).toEqual([brandA, brandB].sort());
    // A later version 1 (older cloud) never removes the brands already there.
    await applyOnEdge(
      edgeMasterSnapshotSchema.parse((await cloudMasters()).body.snapshot),
    );
    expect(await edgeBrandIds()).toEqual([brandA, brandB].sort());
  });

  it("the edge asks for version 2 in the request header, and still accepts the version 1 of a cloud that ignores it", async () => {
    const seen: (string | null)[] = [];
    const viaApp = (honourHeader: boolean) =>
      (async (_url: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get(EDGE_MASTER_SNAPSHOT_VERSION_HEADER));
        const req = request(app)
          .get(MASTERS_PATH)
          .set("Authorization", headers.get("Authorization") ?? "");
        const asked = headers.get(EDGE_MASTER_SNAPSHOT_VERSION_HEADER);
        const res = await (honourHeader && asked !== null
          ? req.set(EDGE_MASTER_SNAPSHOT_VERSION_HEADER, asked)
          : req);
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;
    const config = { cloudUrl: CLOUD_URL, credential: node.credential };

    const current = await fetchVerifiedMasterSnapshot(config, {
      fetchImpl: viaApp(true),
    });
    expect(seen[0]).toBe("2");
    expect(current.version).toBe(2);

    const older = await fetchVerifiedMasterSnapshot(config, {
      fetchImpl: viaApp(false),
    });
    expect(older.version).toBe(1);
    await applyOnEdge(older);
  });
});
