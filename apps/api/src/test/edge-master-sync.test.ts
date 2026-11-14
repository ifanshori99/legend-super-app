// Edge master sync (bead legend-9ppw): uoms, stock locations, chart of
// accounts and account mappings travel from the cloud to an edge node with
// identical ids, so the edge's `stock.moved` events are accepted by the cloud.
// Written from the brief, not from the implementation.
//
// Cloud and edge share one test database. The "cloud" is the real route
// (GET /api/edge-sync/bootstrap/masters) used to capture signed responses; an
// "edge that does not have the rows yet" is made by deleting local rows before
// the edge code runs, which then "fetches" the captured response through a
// fetch spy (same technique as edge-bootstrap.test.ts). A "master change on
// the cloud" is a response captured after the change, with the shared database
// then put back to the stale state the edge still has.
//
// Assumptions (brief ambiguities):
//  - Response: `{ snapshot, signature }` at the top level; the snapshot has
//    `version` 1, `issuedAt`, `tenantId`, `outletId`, `legalEntityId`, `uoms`,
//    `stockLocations`, `chartOfAccounts`, `accountMappings` (camelCase rows).
//  - signature = hex HMAC-SHA256 over the snapshot, key = the node credential's
//    digest, i.e. signEdgeBootstrapBundle(snapshot, parseEdgeCredential(c).hash).
//  - A tampered snapshot is refused with an EdgeMasterSyncError whose code is
//    BAD_SIGNATURE (integrity), or BAD_SNAPSHOT / SCOPE_MISMATCH (a correctly
//    re-signed but out-of-scope snapshot). Either is accepted in those cases.
//  - A failed required master sync on a fresh edge surfaces as an EdgeBootError
//    whose message contains "MASTERS".
//  - The edge writes nothing when it refuses a snapshot.
import { randomBytes, randomUUID } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  CoreError,
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import type { EdgeMasterSnapshot } from "@starter/shared/edge/master-sync";
import {
  inventoryEvents,
  STANDARD_STOCK_LOCATIONS,
} from "@starter/shared/inventory";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { bootstrapEdgeNodeIfNeeded } from "../edge/bootstrap.ts";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import {
  applyEdgeMasterSnapshot,
  startEdgeMasterSyncLoop,
  syncEdgeMasters,
} from "../edge/master-sync.ts";
import { EdgeBootError } from "../edge/runtime.ts";
import { applyEdgeStockMoved } from "../edge/stock-moved-applier.ts";
import { logger } from "../lib/logger.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { edgeBootstrapRouter } from "../routes/edge-bootstrap.routes.ts";
import {
  edgeBootstrapSignatureMatches,
  signEdgeBootstrapBundle,
} from "../services/edge-bootstrap.service.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import {
  provisionOutletStockLocations,
  provisionStandardUoms,
} from "../services/inventory-provisioning.service.ts";
import { buildEdgeMasterSnapshot } from "../services/edge-master-sync.service.ts";
import {
  setEdgeCredentialVerifier,
  verifyEdgeCredential,
} from "../services/staff-pin-sync.ts";

const CLOUD_LINK_URL = "wss://cloud.master.test/api/edge-link";
const BOOTSTRAP_PATH = "/api/edge-sync/bootstrap";
const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const app = createApp();

type Fixture = {
  tenantId: string;
  brandId: string;
  entityA: string;
  entityB: string;
  outletA: string;
  outletB: string;
  credential: string;
  edgeNodeId: string;
};
const fixtures: Fixture[] = [];

const tenantScope = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

const outletScope = (tenantId: string, outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/**
 * A tenant with two outlets of two legal entities (A, B), masters provisioned
 * for both through the real provisioning services, and an edge node on A.
 */
async function createFixture(label: string): Promise<Fixture> {
  const fixture: Fixture = {
    tenantId: randomUUID(),
    brandId: randomUUID(),
    entityA: randomUUID(),
    entityB: randomUUID(),
    outletA: randomUUID(),
    outletB: randomUUID(),
    credential: "",
    edgeNodeId: "",
  };
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $5, plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      fixture.tenantId,
      `edge-masters-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
      `Tenant Master ${label}`,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Master')`,
    [
      fixture.brandId,
      fixture.tenantId,
      `edge-masters-${randomBytes(3).toString("hex")}`,
    ],
  );
  for (const [id, name] of [
    [fixture.entityA, "PT Master A"],
    [fixture.entityB, "PT Master B"],
  ] as const)
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [id, fixture.tenantId, name],
    );
  for (const [id, code, entity] of [
    [fixture.outletA, "MST-A", fixture.entityA],
    [fixture.outletB, "MST-B", fixture.entityB],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, fixture.tenantId, fixture.brandId, entity, code],
    );
  const scope = tenantScope(fixture.tenantId);
  await withTenant(db, scope, async (tx) => {
    await provisionStandardUoms(tx, scope, null);
    for (const outletId of [fixture.outletA, fixture.outletB])
      await provisionOutletStockLocations(tx, scope, outletId, null);
    for (const entityId of [fixture.entityA, fixture.entityB])
      await provisionStandardChart(tx, scope, entityId, null);
  });
  const registered = await registerEdgeNode(
    outletScope(fixture.tenantId, fixture.outletA),
    actor,
    { outletId: fixture.outletA, role: "primary", label: `Node ${label}` },
  );
  fixture.credential = registered.credential;
  fixture.edgeNodeId = registered.edgeNode.id;
  fixtures.push(fixture);
  return fixture;
}

const ALL_TABLES = [
  "domain_event_outbox",
  "stock_balances",
  "stock_ledger",
  "inventory_items",
  "account_mappings",
  "chart_of_accounts",
  "stock_locations",
  "uoms",
  "edge_link_slots",
  "edge_inbound_events",
  "edge_received_events",
  "edge_sync_conflicts",
  "edge_outbound_queue",
  "sync_cursors",
  "edge_pull_checkpoints",
  "edge_nodes",
  "audit_logs",
  "outlets",
  "legal_entities",
  "brands",
];
const MASTER_TABLES = [
  "account_mappings",
  "chart_of_accounts",
  "stock_locations",
  "uoms",
];

async function deleteRows(
  tables: string[],
  tenantIds: string[],
  tenantRow = false,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of tables)
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
        tenantIds,
      ]);
    if (tenantRow)
      await client.query("DELETE FROM tenants WHERE id = ANY($1)", [tenantIds]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** The edge as it was before it ever booted: no rows of this tenant at all. */
const purgeAll = (f: Fixture) => deleteRows(ALL_TABLES, [f.tenantId], true);
/** A node bootstrapped before this bead: tenant and outlet, but no masters. */
const purgeMasters = (f: Fixture) => deleteRows(MASTER_TABLES, [f.tenantId]);

// ---- helpers ---------------------------------------------------------------

const keyOf = (credential: string) => parseEdgeCredential(credential)!.hash;
const signed = (snapshot: unknown, f: Fixture) => ({
  snapshot,
  signature: signEdgeBootstrapBundle(snapshot, keyOf(f.credential)),
});

type Signed = { snapshot: EdgeMasterSnapshot; signature: string };

const bearer = (f: Fixture) => `Bearer ${f.credential}`;
async function cloudMasters(f: Fixture) {
  return request(app).get(MASTERS_PATH).set("Authorization", bearer(f));
}
async function captureMasters(f: Fixture): Promise<Signed> {
  const response = await cloudMasters(f);
  expect(response.status).toBe(200);
  return response.body as Signed;
}

function config(f: Fixture) {
  const parsed = parseEdgeRuntimeConfig({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: CLOUD_LINK_URL,
    EDGE_NODE_CREDENTIAL: f.credential,
    EDGE_NODE_ROLE: "primary",
  });
  if (!parsed.ok) throw new Error(parsed.problems.join(", "));
  return parsed.config as Parameters<typeof syncEdgeMasters>[0];
}

type FetchMock = MockInstance<typeof fetch>;
type Answer = () => Promise<Response> | Response;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const urlOf = (input: unknown) =>
  new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url,
  );
const headerOf = (init: RequestInit | undefined, name: string) => {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers))
    return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return (
    Object.entries(headers as Record<string, string>).find(
      ([k]) => k.toLowerCase() === name.toLowerCase(),
    )?.[1] ?? null
  );
};

/** Answers the masters and/or bootstrap endpoint; anything else is an error. */
function spyCloud(answers: { masters?: Answer; bundle?: Answer }): FetchMock {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: unknown) => {
      const { pathname } = urlOf(input);
      if (pathname.endsWith(MASTERS_PATH) && answers.masters)
        return answers.masters();
      if (pathname.endsWith(BOOTSTRAP_PATH) && answers.bundle)
        return answers.bundle();
      throw new Error(`unexpected fetch ${pathname}`);
    });
}
const mastersCalls = (spy: FetchMock) =>
  spy.mock.calls.filter(([input]) =>
    urlOf(input).pathname.endsWith(MASTERS_PATH),
  );

const byKey =
  <T>(key: (row: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b));

/** Comparable projection of the master rows of one tenant's outlet A. */
type MasterView = {
  uoms: { id: string; code: string; name: string }[];
  stockLocations: {
    id: string;
    name: string;
    type: string;
    isActive: boolean;
  }[];
  accounts: {
    id: string;
    code: string;
    name: string;
    type: string;
    reportGroup: string;
    parentId: string | null;
    isActive: boolean;
  }[];
  mappings: { role: string; accountId: string }[];
};

function viewOf(snapshot: EdgeMasterSnapshot): MasterView {
  return {
    uoms: snapshot.uoms
      .map(({ id, code, name }) => ({ id, code, name }))
      .sort(byKey((r) => r.id)),
    stockLocations: snapshot.stockLocations
      .map(({ id, name, type, isActive }) => ({ id, name, type, isActive }))
      .sort(byKey((r) => r.id)),
    accounts: snapshot.chartOfAccounts
      .map(({ id, code, name, type, reportGroup, parentId, isActive }) => ({
        id,
        code,
        name,
        type,
        reportGroup,
        parentId,
        isActive,
      }))
      .sort(byKey((r) => r.id)),
    mappings: snapshot.accountMappings
      .map(({ role, accountId }) => ({ role, accountId }))
      .sort(byKey((r) => r.role)),
  };
}

async function dbView(
  f: Fixture,
  outletId = f.outletA,
  entityId = f.entityA,
): Promise<MasterView> {
  const q = async <R extends Record<string, unknown>>(
    text: string,
    params: unknown[],
  ) => (await owner.query<R>(text, params)).rows;
  const uoms = await q<{ id: string; code: string; name: string }>(
    "SELECT id, code, name FROM uoms WHERE tenant_id = $1",
    [f.tenantId],
  );
  const locations = await q<{
    id: string;
    name: string;
    type: string;
    is_active: boolean;
  }>(
    "SELECT id, name, type, is_active FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2",
    [f.tenantId, outletId],
  );
  const accounts = await q<{
    id: string;
    code: string;
    name: string;
    type: string;
    report_group: string;
    parent_id: string | null;
    is_active: boolean;
  }>(
    `SELECT id, code, name, type, report_group, parent_id, is_active
       FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [f.tenantId, entityId],
  );
  const mappings = await q<{ role: string; account_id: string }>(
    "SELECT role, account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
    [f.tenantId, entityId],
  );
  return {
    uoms: uoms.sort(byKey((r) => r.id)),
    stockLocations: locations
      .map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        isActive: r.is_active,
      }))
      .sort(byKey((r) => r.id)),
    accounts: accounts
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        reportGroup: r.report_group,
        parentId: r.parent_id,
        isActive: r.is_active,
      }))
      .sort(byKey((r) => r.id)),
    mappings: mappings
      .map((r) => ({ role: r.role, accountId: r.account_id }))
      .sort(byKey((r) => r.role)),
  };
}

const count = async (text: string, params: unknown[]) =>
  (await owner.query<{ n: number }>(text, params)).rows[0]!.n;

/** The error code of a rejected promise, or undefined when it resolved. */
async function failureCode(promise: Promise<unknown>) {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// ---- fixtures --------------------------------------------------------------

let main: Fixture; // cloud endpoint, change, isolation, stock posting
let fresh: Fixture; // bootstrap and "present" paths (purged freely)
let other: Fixture; // another tenant: the source of foreign rows
let capturedFresh: { bundle: unknown; masters: Signed };
let capturedOther: Signed;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  main = await createFixture("Main");
  fresh = await createFixture("Fresh");
  other = await createFixture("Other");
  const bundle = await request(app)
    .get(BOOTSTRAP_PATH)
    .set("Authorization", bearer(fresh));
  expect(bundle.status).toBe(200);
  capturedFresh = { bundle: bundle.body, masters: await captureMasters(fresh) };
  capturedOther = await captureMasters(other);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  await deleteRows(
    ALL_TABLES,
    fixtures.map((f) => f.tenantId),
    true,
  );
  await owner.end();
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 1 cloud masters endpoint", () => {
  it("answers a node with a private, uncached snapshot of its own uoms, outlet locations and entity chart", async () => {
    const response = await cloudMasters(main);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/private/);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    const { snapshot } = response.body as Signed;
    expect(snapshot.version).toBe(1);
    expect(Number.isNaN(Date.parse(snapshot.issuedAt))).toBe(false);
    expect(snapshot.tenantId).toBe(main.tenantId);
    expect(snapshot.outletId).toBe(main.outletA);
    expect(snapshot.legalEntityId).toBe(main.entityA);

    // A's six standard locations, none of B's.
    expect(snapshot.stockLocations).toHaveLength(
      STANDARD_STOCK_LOCATIONS.length,
    );
    expect(STANDARD_STOCK_LOCATIONS).toHaveLength(6);
    expect(
      snapshot.stockLocations.every((l) => l.outletId === main.outletA),
    ).toBe(true);

    // The snapshot is exactly what the database holds for A, with real ids.
    expect(viewOf(snapshot)).toEqual(await dbView(main));
    expect(snapshot.uoms.length).toBeGreaterThan(0);
    expect(snapshot.chartOfAccounts.length).toBeGreaterThan(0);
    expect(snapshot.accountMappings.length).toBeGreaterThan(0);
  });

  it("holds nothing of outlet B, its entity or another tenant, and no secrets", async () => {
    const response = await cloudMasters(main);
    const text = JSON.stringify((response.body as Signed).snapshot);
    const bLocations = await owner.query<{ id: string }>(
      "SELECT id FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2",
      [main.tenantId, main.outletB],
    );
    const bAccounts = await owner.query<{ id: string }>(
      "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
      [main.tenantId, main.entityB],
    );
    expect(bLocations.rows.length).toBeGreaterThan(0);
    expect(bAccounts.rows.length).toBeGreaterThan(0);
    for (const foreign of [
      main.outletB,
      main.entityB,
      other.tenantId,
      other.outletA,
      ...bLocations.rows.map((row) => row.id),
      ...bAccounts.rows.map((row) => row.id),
    ])
      expect(text).not.toContain(foreign);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(main.credential);
    expect(raw).not.toContain(keyOf(main.credential));
    expect(raw.toLowerCase()).not.toMatch(/credential|secret/);
  });

  it("signs the snapshot with a key only this node and the cloud can derive", async () => {
    const { snapshot, signature } = await captureMasters(main);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(
      edgeBootstrapSignatureMatches(
        snapshot,
        signature,
        keyOf(main.credential),
      ),
    ).toBe(true);
    // Another node's key does not verify it; neither does an altered snapshot.
    expect(
      edgeBootstrapSignatureMatches(
        snapshot,
        signature,
        keyOf(other.credential),
      ),
    ).toBe(false);
    const altered = structuredClone(snapshot);
    altered.stockLocations[0]!.name = "Dibajak";
    expect(
      edgeBootstrapSignatureMatches(altered, signature, keyOf(main.credential)),
    ).toBe(false);
  });

  it("each node receives its own tenant's masters", async () => {
    const { snapshot } = capturedOther;
    expect(snapshot.tenantId).toBe(other.tenantId);
    expect(snapshot.outletId).toBe(other.outletA);
    expect(JSON.stringify(snapshot)).not.toContain(main.tenantId);
  });

  it("refuses callers without a valid edge credential with 401", async () => {
    expect((await request(app).get(MASTERS_PATH)).status).toBe(401);
    const wrong = main.credential.slice(0, -2) + "AA";
    const forged = await request(app)
      .get(MASTERS_PATH)
      .set("Authorization", `Bearer ${wrong}`);
    expect(forged.status).toBe(401);
    const swapped = await request(app)
      .get(MASTERS_PATH)
      .set(
        "Authorization",
        `Bearer ${main.credential.replace(main.outletA, main.outletB)}`,
      );
    expect(swapped.status).toBe(401);
    expect(JSON.stringify(forged.body)).not.toContain(main.tenantId);
  });

  it("refuses a request whose domain belongs to another tenant with 403 TENANT_MISMATCH", async () => {
    let domainTenant: string | null = null;
    const domainApp = express();
    domainApp.use(
      tenantContext({
        required: false,
        resolveDomain: async () =>
          domainTenant ? { tenantId: domainTenant, brandId: null } : null,
        verifyCredential: async () => null,
      }),
    );
    domainApp.use("/api/edge-sync/bootstrap", edgeBootstrapRouter);
    domainApp.use(errorHandler);

    // Same domain tenant as the credential: served.
    domainTenant = main.tenantId;
    const same = await request(domainApp)
      .get(MASTERS_PATH)
      .set("Authorization", bearer(main));
    expect(same.status).toBe(200);

    domainTenant = other.tenantId;
    const mismatch = await request(domainApp)
      .get(MASTERS_PATH)
      .set("Authorization", bearer(main));
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe("TENANT_MISMATCH");
    expect(JSON.stringify(mismatch.body)).not.toContain("stockLocations");
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 2 fresh edge bootstrap", () => {
  const serve = () =>
    spyCloud({
      bundle: () => json(capturedFresh.bundle),
      masters: () => json(capturedFresh.masters),
    });

  it("seeds locations, uoms, accounts and mappings with the cloud's ids, and nothing of outlet B", async () => {
    await purgeAll(fresh);
    expect(await dbView(fresh)).toEqual({
      uoms: [],
      stockLocations: [],
      accounts: [],
      mappings: [],
    });
    const spy = serve();
    expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("bootstrapped");

    const calls = mastersCalls(spy);
    expect(calls).toHaveLength(1);
    const url = urlOf(calls[0]![0]);
    expect(url.host).toBe("cloud.master.test");
    expect(url.pathname).toBe(MASTERS_PATH);
    expect(headerOf(calls[0]![1], "authorization")).toBe(bearer(fresh));

    const { snapshot } = capturedFresh.masters;
    const local = await dbView(fresh);
    expect(local).toEqual(viewOf(snapshot));
    expect(local.stockLocations).toHaveLength(STANDARD_STOCK_LOCATIONS.length);
    expect(local.uoms.length).toBeGreaterThan(0);
    expect(local.accounts.length).toBeGreaterThan(0);
    expect(local.mappings.length).toBeGreaterThan(0);
    // Outlet B's locations and entity B's chart were never in the snapshot.
    expect(await dbView(fresh, fresh.outletB, fresh.entityB)).toMatchObject({
      stockLocations: [],
      accounts: [],
      mappings: [],
    });
  });

  const localRows = async (f: Fixture) =>
    (await count("SELECT count(*)::int AS n FROM tenants WHERE id = $1", [
      f.tenantId,
    ])) +
    (await count(
      "SELECT count(*)::int AS n FROM outlets WHERE tenant_id = $1",
      [f.tenantId],
    )) +
    (await count(
      "SELECT count(*)::int AS n FROM legal_entities WHERE tenant_id = $1",
      [f.tenantId],
    )) +
    (await count("SELECT count(*)::int AS n FROM brands WHERE tenant_id = $1", [
      f.tenantId,
    ])) +
    (await count(
      "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1",
      [f.tenantId],
    )) +
    (await count("SELECT count(*)::int AS n FROM uoms WHERE tenant_id = $1", [
      f.tenantId,
    ]));

  // Masters answered with a scope that does not match the bundle's outlet:
  // correctly signed, well formed, but another legal entity.
  const foreignEntityMasters = () =>
    signed(
      JSON.parse(
        JSON.stringify(capturedFresh.masters.snapshot).replaceAll(
          fresh.entityA,
          randomUUID(),
        ),
      ),
      fresh,
    );

  it("stays down with an EdgeBootError naming MASTERS when the masters cannot be fetched or applied, and writes NOTHING", async () => {
    for (const masters of [
      () => json({ error: { code: "INTERNAL" } }, 500),
      () => json({ unexpected: true }),
      () => json({ ...capturedFresh.masters, signature: "0".repeat(64) }),
      () => json(foreignEntityMasters()),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      await purgeAll(fresh);
      spyCloud({ bundle: () => json(capturedFresh.bundle), masters });
      const failure = await bootstrapEdgeNodeIfNeeded(config(fresh)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(EdgeBootError);
      const message = (failure as Error).message;
      expect(message).toContain("MASTERS");
      expect(message).not.toContain(fresh.credential);
      expect(message).not.toContain(keyOf(fresh.credential));
      // Atomic: no tenant, outlet, brand, entity or master row was written.
      expect(await localRows(fresh)).toBe(0);
      vi.restoreAllMocks();
    }
  });

  it("names LOCAL_CONFLICT and writes nothing when a local outlet with the same code but another id blocks the insert", async () => {
    await purgeAll(fresh);
    // The edge already holds the tenant, brand and entity, and an outlet with
    // the bundle's outlet code under a different id.
    const blockingOutlet = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Tenant Konflik', plan, 'active', deployment_mode, feature_flags, limits, $3
         FROM tenants WHERE id = $4`,
      [
        fresh.tenantId,
        `edge-masters-${randomBytes(4).toString("hex")}`,
        actor,
        cafeLegendPlatformFixtures.tenant.id,
      ],
    );
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand Master')`,
      [
        fresh.brandId,
        fresh.tenantId,
        `edge-masters-${randomBytes(3).toString("hex")}`,
      ],
    );
    await owner.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Master A', false)`,
      [fresh.entityA, fresh.tenantId],
    );
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'MST-A', 'Outlet Penghalang', 'Jl. Uji', '{}', 'active')`,
      [blockingOutlet, fresh.tenantId, fresh.brandId, fresh.entityA],
    );

    spyCloud({
      bundle: () => json(capturedFresh.bundle),
      masters: () => json(capturedFresh.masters),
    });
    const failure = await bootstrapEdgeNodeIfNeeded(config(fresh)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EdgeBootError);
    const message = (failure as Error).message;
    expect(message).toContain("LOCAL_CONFLICT");
    expect(message).not.toContain("MASTERS");
    expect(message).not.toContain(fresh.credential);
    // Nothing of the bundle or the masters was written; the blocker is intact.
    const outletIds = (
      await owner.query<{ id: string }>(
        "SELECT id FROM outlets WHERE tenant_id = $1",
        [fresh.tenantId],
      )
    ).rows.map((row) => row.id);
    expect(outletIds).toEqual([blockingOutlet]);
    for (const table of MASTER_TABLES)
      expect(
        await count(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
          [fresh.tenantId],
        ),
      ).toBe(0);
  });

  it("after a failed masters step the next boot is fresh again and succeeds", async () => {
    await purgeAll(fresh);
    spyCloud({
      bundle: () => json(capturedFresh.bundle),
      masters: () => json({ error: { code: "INTERNAL" } }, 500),
    });
    await expect(bootstrapEdgeNodeIfNeeded(config(fresh))).rejects.toThrow(
      EdgeBootError,
    );
    expect(await localRows(fresh)).toBe(0);
    vi.restoreAllMocks();

    const spy = serve();
    expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("bootstrapped");
    // Fresh again: the bundle was fetched again, not skipped as "present".
    expect(
      spy.mock.calls.filter(([input]) =>
        urlOf(input).pathname.endsWith(BOOTSTRAP_PATH),
      ),
    ).toHaveLength(1);
    expect(mastersCalls(spy)).toHaveLength(1);
    expect(await dbView(fresh)).toEqual(viewOf(capturedFresh.masters.snapshot));
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 3 master change on the cloud", () => {
  it("applies a renamed location, a new location and a remapped role, and a re-run changes nothing", async () => {
    const before = await dbView(main);
    const bar = before.stockLocations.find((l) => l.type === "bar")!;
    const mapping = before.mappings[0]!;
    const otherAccount = before.accounts.find(
      (a) => a.id !== mapping.accountId,
    )!;
    const bBefore = await dbView(main, main.outletB, main.entityB);

    // Cloud changes ...
    await owner.query("UPDATE stock_locations SET name = $2 WHERE id = $1", [
      bar.id,
      "Bar Utama Baru",
    ]);
    const added = await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang Cadangan', 'warehouse') RETURNING id",
      [main.tenantId, main.outletA],
    );
    await owner.query(
      "UPDATE account_mappings SET account_id = $4 WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [main.tenantId, main.entityA, mapping.role, otherAccount.id],
    );
    // ... captured as the cloud's answer ...
    const changed = await captureMasters(main);
    const after = viewOf(changed.snapshot);
    expect(changed.snapshot.stockLocations).toHaveLength(
      STANDARD_STOCK_LOCATIONS.length + 1,
    );
    // ... and the shared database put back to the stale state the edge has.
    await owner.query("UPDATE stock_locations SET name = $2 WHERE id = $1", [
      bar.id,
      bar.name,
    ]);
    await owner.query("DELETE FROM stock_locations WHERE id = $1", [
      added.rows[0]!.id,
    ]);
    await owner.query(
      "UPDATE account_mappings SET account_id = $4 WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [main.tenantId, main.entityA, mapping.role, mapping.accountId],
    );
    expect(await dbView(main)).toEqual(before);

    const spy = spyCloud({ masters: () => json(changed) });
    const counts = await syncEdgeMasters(config(main));
    expect(counts).toEqual({
      uoms: changed.snapshot.uoms.length,
      stockLocations: STANDARD_STOCK_LOCATIONS.length + 1,
      accounts: changed.snapshot.chartOfAccounts.length,
      mappings: changed.snapshot.accountMappings.length,
      droppedMappings: 0,
    });
    const synced = await dbView(main);
    expect(synced).toEqual(after);
    expect(synced.stockLocations.find((l) => l.id === bar.id)!.name).toBe(
      "Bar Utama Baru",
    );
    expect(synced.stockLocations.map((l) => l.id)).toContain(added.rows[0]!.id);
    expect(
      synced.mappings.find((m) => m.role === mapping.role)!.accountId,
    ).toBe(otherAccount.id);
    // Outlet B and entity B are untouched.
    expect(await dbView(main, main.outletB, main.entityB)).toEqual(bBefore);

    // Idempotent: the same snapshot again changes nothing.
    const rows = await count(
      "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1",
      [main.tenantId],
    );
    expect(await syncEdgeMasters(config(main))).toEqual(counts);
    expect(await dbView(main)).toEqual(after);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1",
        [main.tenantId],
      ),
    ).toBe(rows);
    expect(mastersCalls(spy)).toHaveLength(2);
  });

  it("never deletes a local master that the snapshot no longer lists", async () => {
    const current = await captureMasters(main);
    const victim = current.snapshot.stockLocations[0]!;
    const shorter = structuredClone(current.snapshot);
    shorter.stockLocations = shorter.stockLocations.slice(1);
    spyCloud({ masters: () => json(signed(shorter, main)) });
    await syncEdgeMasters(config(main));
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_locations WHERE id = $1",
        [victim.id],
      ),
    ).toBe(1);
  });

  it("deletes a mapping role the cloud no longer has, and only that one", async () => {
    const before = await dbView(main);
    const mapping = before.mappings[0]!;
    const bBefore = await dbView(main, main.outletB, main.entityB);
    // Cloud removes the role; the answer is captured; the database goes back
    // to the stale state the edge has.
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [main.tenantId, main.entityA, mapping.role],
    );
    const changed = await captureMasters(main);
    await owner.query(
      "INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id) VALUES ($1, $2, $3, $4)",
      [main.tenantId, main.entityA, mapping.role, mapping.accountId],
    );
    expect(changed.snapshot.accountMappings.map((m) => m.role)).not.toContain(
      mapping.role,
    );
    expect(await dbView(main)).toEqual(before);

    try {
      spyCloud({ masters: () => json(changed) });
      await syncEdgeMasters(config(main));
      const after = await dbView(main);
      expect(after.mappings.map((m) => m.role)).not.toContain(mapping.role);
      expect(after.mappings).toHaveLength(before.mappings.length - 1);
      // The account itself, the rest of the chart and entity B stay.
      expect(after.accounts).toEqual(before.accounts);
      expect(await dbView(main, main.outletB, main.entityB)).toEqual(bBefore);
    } finally {
      // Put the role back for the tests that follow.
      vi.restoreAllMocks();
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [main.tenantId, main.entityA, mapping.role, mapping.accountId],
      );
    }
    expect(await dbView(main)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// legend-dhbt1: a newer cloud may map a posting role this edge build does not
// know yet. The edge drops that mapping (logged and counted) and applies the
// rest of the snapshot; it must not refuse the whole snapshot.
describe("legend-dhbt1 mapping role unknown to this edge build", () => {
  const UNKNOWN_ROLE = "future_posting_role_from_newer_cloud";

  /** Puts the entity's mappings back as `before` had them. */
  async function restoreMappings(before: MasterView) {
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
      [main.tenantId, main.entityA],
    );
    for (const m of before.mappings)
      await owner.query(
        "INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id) VALUES ($1, $2, $3, $4)",
        [main.tenantId, main.entityA, m.role, m.accountId],
      );
  }

  it("drops the unknown role, logs and counts it, and still applies locations, accounts and known roles", async () => {
    const before = await dbView(main);
    const bBefore = await dbView(main, main.outletB, main.entityB);
    const current = await captureMasters(main);
    const bar = current.snapshot.stockLocations.find((l) => l.type === "bar")!;
    const known = current.snapshot.accountMappings[0]!;
    const otherAccount = current.snapshot.chartOfAccounts.find(
      (a) => a.id !== known.accountId,
    )!;

    // The newer cloud renames a location, remaps a known role and adds a role
    // this build has never heard of.
    const newer = structuredClone(current.snapshot);
    newer.stockLocations = newer.stockLocations.map((l) =>
      l.id === bar.id ? { ...l, name: "Bar Toleran" } : l,
    );
    newer.accountMappings = [
      ...newer.accountMappings.map((m) =>
        m.role === known.role ? { ...m, accountId: otherAccount.id } : m,
      ),
      {
        tenantId: known.tenantId,
        legalEntityId: known.legalEntityId,
        role: UNKNOWN_ROLE,
        accountId: otherAccount.id,
      },
    ];

    const warn = vi.spyOn(logger, "warn");
    try {
      spyCloud({ masters: () => json(signed(newer, main)) });
      const counts = await syncEdgeMasters(config(main));
      expect(counts).toEqual({
        uoms: newer.uoms.length,
        stockLocations: newer.stockLocations.length,
        accounts: newer.chartOfAccounts.length,
        mappings: current.snapshot.accountMappings.length,
        droppedMappings: 1,
      });

      const after = await dbView(main);
      expect(after.stockLocations.find((l) => l.id === bar.id)!.name).toBe(
        "Bar Toleran",
      );
      expect(after.uoms).toEqual(before.uoms);
      expect(after.accounts).toEqual(before.accounts);
      // Known roles: all kept, the remapped one applied; the unknown one absent.
      expect(after.mappings.map((m) => m.role)).not.toContain(UNKNOWN_ROLE);
      expect(after.mappings.map((m) => m.role)).toEqual(
        before.mappings.map((m) => m.role),
      );
      expect(after.mappings.find((m) => m.role === known.role)!.accountId).toBe(
        otherAccount.id,
      );
      expect(await dbView(main, main.outletB, main.entityB)).toEqual(bBefore);

      // Logged with the role names and the count, nothing else of the payload.
      const dropped = warn.mock.calls.filter(
        ([fields]) =>
          typeof fields === "object" &&
          fields !== null &&
          "droppedRoles" in fields,
      );
      expect(dropped).toHaveLength(1);
      expect(dropped[0]![0]).toEqual({
        droppedMappings: 1,
        droppedRoles: [UNKNOWN_ROLE],
      });
    } finally {
      vi.restoreAllMocks();
      // Put the shared database back for the tests that follow.
      await owner.query("UPDATE stock_locations SET name = $2 WHERE id = $1", [
        bar.id,
        bar.name,
      ]);
      await owner.query(
        "UPDATE account_mappings SET account_id = $4 WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
        [main.tenantId, main.entityA, known.role, known.accountId],
      );
      await owner.query(
        "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
        [main.tenantId, main.entityA, UNKNOWN_ROLE],
      );
    }
    expect(await dbView(main)).toEqual(before);
  });

  it("a snapshot whose only extra is an unknown role changes nothing locally", async () => {
    const before = await dbView(main);
    const current = await captureMasters(main);
    const newer = structuredClone(current.snapshot);
    const known = newer.accountMappings[0]!;
    newer.accountMappings.push({ ...known, role: UNKNOWN_ROLE });
    try {
      spyCloud({ masters: () => json(signed(newer, main)) });
      const counts = await syncEdgeMasters(config(main));
      expect(counts.mappings).toBe(current.snapshot.accountMappings.length);
      expect(counts.droppedMappings).toBe(1);
      expect(await dbView(main)).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      await restoreMappings(before);
    }
    expect(await dbView(main)).toEqual(before);
  });

  it("a snapshot whose roles are all unknown keeps no local mapping: the cloud's known set is empty", async () => {
    const before = await dbView(main);
    expect(before.mappings.length).toBeGreaterThan(0);
    const current = await captureMasters(main);
    const newer = structuredClone(current.snapshot);
    newer.accountMappings = newer.accountMappings.map((m, i) => ({
      ...m,
      role: `future_role_${i}`,
    }));
    try {
      spyCloud({ masters: () => json(signed(newer, main)) });
      const counts = await syncEdgeMasters(config(main));
      expect(counts.mappings).toBe(0);
      expect(counts.droppedMappings).toBe(newer.accountMappings.length);
      const after = await dbView(main);
      expect(after.mappings).toEqual([]);
      // Only mappings go: the chart, locations and uoms stay.
      expect({ ...after, mappings: before.mappings }).toEqual(before);
    } finally {
      vi.restoreAllMocks();
      await restoreMappings(before);
    }
    expect(await dbView(main)).toEqual(before);
  });

  it("the wire role is a bounded string: empty, over 40 characters or a duplicate role is still BAD_SNAPSHOT", async () => {
    const before = await dbView(main);
    const current = await captureMasters(main);
    const known = current.snapshot.accountMappings[0]!;
    for (const extra of [
      { ...known, role: "" },
      { ...known, role: "r".repeat(41) },
      { ...known },
    ]) {
      const bad = structuredClone(current.snapshot);
      bad.accountMappings.push(extra);
      vi.restoreAllMocks();
      spyCloud({ masters: () => json(signed(bad, main)) });
      expect(await failureCode(syncEdgeMasters(config(main)))).toBe(
        "BAD_SNAPSHOT",
      );
    }
    expect(await dbView(main)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 4 edge stock posting against synced locations", () => {
  let node: Awaited<ReturnType<typeof authenticateEdgeCredential>>;
  let itemId: string;
  let clock = Date.parse("2026-11-09T08:00:00.000Z");

  beforeAll(async () => {
    node = await authenticateEdgeCredential(main.credential);
    if (!node) throw new Error("Edge node did not authenticate");
    const uom = await owner.query<{ id: string }>(
      "SELECT id FROM uoms WHERE tenant_id = $1 ORDER BY code LIMIT 1",
      [main.tenantId],
    );
    const item = await owner.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, 'Kopi Master', 'Bahan Baku', 'raw_material', $2, false) RETURNING id`,
      [main.tenantId, uom.rows[0]!.id],
    );
    itemId = item.rows[0]!.id;
  });

  /** An edge `stock.moved` exactly as inventory.service.ts emits it. */
  function stockMoved(outletId: string, locationId: string) {
    clock += 1_000;
    const ledgerEntryId = createUlid(clock);
    const occurredAt = new Date(clock).toISOString();
    const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
      id: createUlid(clock),
      tenantId: main.tenantId,
      outletId,
      name: "stock.moved",
      version: 1,
      aggregateType: "stock",
      aggregateId: ledgerEntryId,
      sequence: 1,
      occurredAt,
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `stock.moved:${ledgerEntryId}`,
      payloadSchemaRef: "stock.moved.v1",
      payload: {
        ledgerEntryId,
        inventoryItemId: itemId,
        locationId,
        movementType: "sale",
        quantity: "-1.0000",
        unitCostIdr: "1000.0000",
        batchId: null,
        sourceType: "order",
        sourceId: createUlid(clock),
        occurredAt,
      },
    }) as EventEnvelope;
    return { event, ledgerEntryId };
  }

  const post = (event: EventEnvelope) =>
    withTenant(db, node!.context, (tx) =>
      applyEdgeStockMoved(tx, event, {
        edgeNodeId: node!.scope.edgeNodeId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        context: node!.context,
      }),
    );

  const ledgerCount = (ledgerEntryId: string) =>
    count(
      "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
      [main.tenantId, ulidToUuid(ledgerEntryId)],
    );

  it("accepts a movement on a location the edge got from the sync, and refuses outlet B's or an unknown one", async () => {
    const current = await captureMasters(main);
    spyCloud({ masters: () => json(current) });
    await syncEdgeMasters(config(main));
    const synced = current.snapshot.stockLocations[0]!;

    const accepted = stockMoved(main.outletA, synced.id);
    await post(accepted.event);
    expect(await ledgerCount(accepted.ledgerEntryId)).toBe(1);

    const bLocation = await owner.query<{ id: string }>(
      "SELECT id FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 LIMIT 1",
      [main.tenantId, main.outletB],
    );
    for (const locationId of [bLocation.rows[0]!.id, randomUUID()]) {
      const refused = stockMoved(main.outletA, locationId);
      await expect(post(refused.event)).rejects.toThrow();
      expect(await ledgerCount(refused.ledgerEntryId)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 5 isolation", () => {
  const SCOPE_CODES = /^(BAD_SNAPSHOT|SCOPE_MISMATCH)$/;

  async function expectRefusedAndUnchanged(
    body: unknown,
    expected: RegExp | string,
  ) {
    const mainBefore = await dbView(main);
    const mainBBefore = await dbView(main, main.outletB, main.entityB);
    const otherBefore = await dbView(other);
    spyCloud({ masters: () => json(body) });
    const code = await failureCode(syncEdgeMasters(config(main)));
    vi.restoreAllMocks();
    if (typeof expected === "string") expect(code).toBe(expected);
    else expect(code).toMatch(expected);
    expect(await dbView(main)).toEqual(mainBefore);
    expect(await dbView(main, main.outletB, main.entityB)).toEqual(mainBBefore);
    expect(await dbView(other)).toEqual(otherBefore);
  }

  it("refuses a correctly signed snapshot that carries a location of outlet B", async () => {
    const { snapshot } = await captureMasters(main);
    const row = (
      await owner.query<{
        id: string;
        name: string;
        type: string;
        is_active: boolean;
        created_at: Date;
      }>(
        "SELECT id, name, type, is_active, created_at FROM stock_locations WHERE tenant_id = $1 AND outlet_id = $2 LIMIT 1",
        [main.tenantId, main.outletB],
      )
    ).rows[0]!;
    const tampered = structuredClone(snapshot);
    // Branded ids: the row is built from plain strings on purpose.
    tampered.stockLocations.push({
      id: row.id,
      tenantId: main.tenantId,
      outletId: main.outletB,
      name: row.name,
      type: row.type,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
    } as never);
    await expectRefusedAndUnchanged(signed(tampered, main), SCOPE_CODES);
  });

  it("refuses a correctly signed snapshot that carries a row of another tenant", async () => {
    const { snapshot } = await captureMasters(main);
    const foreign = capturedOther.snapshot;
    const withUom = structuredClone(snapshot);
    withUom.uoms.push(foreign.uoms[0]!);
    await expectRefusedAndUnchanged(signed(withUom, main), SCOPE_CODES);

    const withLocation = structuredClone(snapshot);
    withLocation.stockLocations.push(foreign.stockLocations[0]!);
    await expectRefusedAndUnchanged(signed(withLocation, main), SCOPE_CODES);

    // The other tenant's whole snapshot, signed with this node's own key.
    await expectRefusedAndUnchanged(signed(foreign, main), SCOPE_CODES);
  });

  it("refuses a snapshot of a foreign legal entity, as one row or as the whole chart", async () => {
    const { snapshot } = await captureMasters(main);
    const bView = await dbView(main, main.outletB, main.entityB);
    const bAccounts = (
      await owner.query<{
        id: string;
        created_at: Date;
        updated_at: Date;
      }>(
        "SELECT id, created_at, updated_at FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
        [main.tenantId, main.entityB],
      )
    ).rows;
    const stamps = new Map(bAccounts.map((r) => [r.id, r]));
    const bRows = bView.accounts.map((a) => ({
      ...a,
      type: a.type as never,
      reportGroup: a.reportGroup as never,
      tenantId: main.tenantId,
      legalEntityId: main.entityB,
      createdAt: stamps.get(a.id)!.created_at.toISOString(),
      updatedAt: stamps.get(a.id)!.updated_at.toISOString(),
    }));

    // One foreign account in A's snapshot.
    const oneRow = structuredClone(snapshot);
    oneRow.chartOfAccounts.push(bRows[0]! as never);
    await expectRefusedAndUnchanged(signed(oneRow, main), SCOPE_CODES);

    // The whole snapshot re-pointed at entity B and B's chart and mappings.
    const wholeChart: EdgeMasterSnapshot = {
      ...structuredClone(snapshot),
      legalEntityId: main.entityB as never,
      chartOfAccounts: bRows as never,
      accountMappings: bView.mappings.map((m) => ({
        tenantId: main.tenantId,
        legalEntityId: main.entityB,
        role: m.role,
        accountId: m.accountId,
      })) as never,
    };
    await expectRefusedAndUnchanged(signed(wholeChart, main), SCOPE_CODES);
  });

  it("refuses a snapshot that fails its signature check", async () => {
    const good = await captureMasters(main);
    const tampered = structuredClone(good);
    tampered.snapshot.stockLocations[0]!.name = "Dibajak";
    await expectRefusedAndUnchanged(tampered, "BAD_SIGNATURE");
    // Another node's key, and a missing signature.
    await expectRefusedAndUnchanged(
      {
        snapshot: good.snapshot,
        signature: signed(good.snapshot, other).signature,
      },
      "BAD_SIGNATURE",
    );
    await expectRefusedAndUnchanged(
      { snapshot: good.snapshot, signature: "" },
      "BAD_SIGNATURE",
    );
  });

  it("refuses a natural-key collision under another id with LOCAL_CONFLICT and writes nothing", async () => {
    const { snapshot } = await captureMasters(main);
    const before = await dbView(main);
    const replaceId = (value: EdgeMasterSnapshot, from: string, to: string) =>
      JSON.parse(
        JSON.stringify(value).replaceAll(from, to),
      ) as EdgeMasterSnapshot;
    /** Changes that must NOT land when the collision aborts the apply. */
    const withOtherChanges = (value: EdgeMasterSnapshot) => {
      value.stockLocations[0]!.name = "Tidak Boleh Masuk";
      value.stockLocations.push({
        ...value.stockLocations[1]!,
        id: randomUUID() as never,
        name: "Lokasi Baru Tidak Boleh Masuk",
      });
      return value;
    };

    // A uom with the same (tenant, code) but a different id.
    const uomCollision = withOtherChanges(
      replaceId(snapshot, snapshot.uoms[0]!.id, randomUUID()),
    );
    await expectRefusedAndUnchanged(
      signed(uomCollision, main),
      "LOCAL_CONFLICT",
    );

    // Two accounts whose codes are swapped against the local chart: both ids
    // are in the snapshot, so neither is a fork, and each code is held locally
    // under the other id. (An account with a code under a snapshot-unknown id
    // is a replaceable fork since legend-ht6fu, see its describe below.)
    const parents = new Set(snapshot.chartOfAccounts.map((a) => a.parentId));
    const [first, second] = snapshot.chartOfAccounts.filter(
      (a) => !parents.has(a.id),
    );
    const swapped = withOtherChanges(structuredClone(snapshot));
    for (const row of swapped.chartOfAccounts) {
      if (row.id === first!.id) row.code = second!.code;
      else if (row.id === second!.id) row.code = first!.code;
    }
    await expectRefusedAndUnchanged(signed(swapped, main), "LOCAL_CONFLICT");
    expect(await dbView(main)).toEqual(before);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1 AND name LIKE '%Tidak Boleh Masuk%'",
        [main.tenantId],
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 6 node that was bootstrapped before the master sync", () => {
  /** Tenant and outlet present locally, but no masters at all. */
  async function presentWithoutMasters() {
    await purgeAll(fresh);
    spyCloud({
      bundle: () => json(capturedFresh.bundle),
      masters: () => json(capturedFresh.masters),
    });
    await bootstrapEdgeNodeIfNeeded(config(fresh));
    vi.restoreAllMocks();
    await purgeMasters(fresh);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1",
        [fresh.tenantId],
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM outlets WHERE id = $1", [
        fresh.outletA,
      ]),
    ).toBe(1);
  }

  it("with no local locations: boots as present and fetches the masters once", async () => {
    await presentWithoutMasters();
    const spy = spyCloud({ masters: () => json(capturedFresh.masters) });
    expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("present");
    expect(mastersCalls(spy)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1); // no bundle fetch
    expect(await dbView(fresh)).toEqual(viewOf(capturedFresh.masters.snapshot));
  });

  it("with no local locations and an unreachable or invalid cloud: still boots as present, writes nothing", async () => {
    await presentWithoutMasters();
    for (const masters of [
      () => json({ error: { code: "INTERNAL" } }, 500),
      () => json({ ...capturedFresh.masters, signature: "0".repeat(64) }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      const spy = spyCloud({ masters });
      expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("present");
      expect(mastersCalls(spy)).toHaveLength(1);
      vi.restoreAllMocks();
    }
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1",
        [fresh.tenantId],
      ),
    ).toBe(0);
  });

  it("with local locations: makes no network call at all", async () => {
    await presentWithoutMasters();
    spyCloud({ masters: () => json(capturedFresh.masters) });
    await bootstrapEdgeNodeIfNeeded(config(fresh)); // restores the locations
    vi.restoreAllMocks();

    const spy = spyCloud({
      masters: () => {
        throw new Error("must not be called");
      },
      bundle: () => {
        throw new Error("must not be called");
      },
    });
    expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("present");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 6b present path: masters missing means no uoms OR no locations", () => {
  async function bootAllThenDeleteUoms() {
    await purgeAll(fresh);
    spyCloud({
      bundle: () => json(capturedFresh.bundle),
      masters: () => json(capturedFresh.masters),
    });
    await bootstrapEdgeNodeIfNeeded(config(fresh));
    vi.restoreAllMocks();
    await deleteRows(["uoms"], [fresh.tenantId]);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_locations WHERE tenant_id = $1",
        [fresh.tenantId],
      ),
    ).toBeGreaterThan(0);
    expect(
      await count("SELECT count(*)::int AS n FROM uoms WHERE tenant_id = $1", [
        fresh.tenantId,
      ]),
    ).toBe(0);
  }

  it("locations present but no uoms: boots as present and fetches the masters once", async () => {
    await bootAllThenDeleteUoms();
    const spy = spyCloud({ masters: () => json(capturedFresh.masters) });
    expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("present");
    expect(mastersCalls(spy)).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1); // no bundle fetch
    expect(await dbView(fresh)).toEqual(viewOf(capturedFresh.masters.snapshot));
  });

  it("locations present but no uoms and the cloud failing: still boots as present", async () => {
    await bootAllThenDeleteUoms();
    for (const masters of [
      () => json({ error: { code: "INTERNAL" } }, 500),
      () => json({ error: { code: "UNAUTHORIZED" } }, 401),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ ...capturedFresh.masters, signature: "0".repeat(64) }),
    ]) {
      const spy = spyCloud({ masters });
      expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("present");
      expect(mastersCalls(spy)).toHaveLength(1);
      vi.restoreAllMocks();
    }
    expect(
      await count("SELECT count(*)::int AS n FROM uoms WHERE tenant_id = $1", [
        fresh.tenantId,
      ]),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 7 periodic sync loop", () => {
  const loopConfig = () => config(main);

  it("refuses an interval below 60 seconds or not a finite number with a RangeError", () => {
    for (const intervalMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      1,
      59_999,
    ])
      expect(() =>
        startEdgeMasterSyncLoop({ config: loopConfig(), intervalMs }),
      ).toThrow(RangeError);
  });

  it("starts at 60 seconds, makes no call before the first tick, and stops cleanly", async () => {
    const spy = spyCloud({
      masters: () => {
        throw new Error("must not be called");
      },
    });
    const loop = startEdgeMasterSyncLoop({
      config: loopConfig(),
      intervalMs: 60_000,
    });
    await loop.stop();
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("legend-9ppw 8 cloud endpoint over its size cap", () => {
  it("answers 409 CONFLICT, not 500, when an outlet has more locations than the snapshot allows", async () => {
    const big = await createFixture("Big");
    // The snapshot holds at most 200 locations per outlet.
    await owner.query(
      `INSERT INTO stock_locations (tenant_id, outlet_id, name, type)
       SELECT $1, $2, 'Lokasi ' || n, 'warehouse' FROM generate_series(1, 250) AS n`,
      [big.tenantId, big.outletA],
    );
    const response = await cloudMasters(big);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(response.body)).not.toContain(big.credential);
    // Other nodes are unaffected.
    expect((await cloudMasters(main)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// legend-8izz: master writes go through guardDataImport("edge.bootstrap"),
// like the bootstrap bundle. The guard is the deployment policy (real data
// only in production); "real" outside production makes it refuse.
describe("legend-8izz master sync behind the data import guard", () => {
  const KINDS = ["uoms", "stockLocations", "accounts", "mappings"] as const;

  function blockImports() {
    vi.stubEnv("DEPLOYMENT_MODE", "staging");
    vi.stubEnv("DATA_CLASSIFICATION", "real");
  }

  async function expectNoMasters() {
    const view = await dbView(fresh);
    for (const kind of KINDS) expect(view[kind], kind).toEqual([]);
  }

  /** Tenant and outlet present locally, no masters of any kind. */
  async function presentWithoutMasters() {
    await purgeAll(fresh);
    spyCloud({
      bundle: () => json(capturedFresh.bundle),
      masters: () => json(capturedFresh.masters),
    });
    await bootstrapEdgeNodeIfNeeded(config(fresh));
    vi.restoreAllMocks();
    await purgeMasters(fresh);
    await expectNoMasters();
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("syncEdgeMasters refuses with DATA_IMPORT_BLOCKED before any cloud call and writes none of the four kinds", async () => {
    await presentWithoutMasters();
    blockImports();
    const spy = spyCloud({ masters: () => json(capturedFresh.masters) });
    expect(await failureCode(syncEdgeMasters(config(fresh)))).toBe(
      "DATA_IMPORT_BLOCKED",
    );
    expect(spy).not.toHaveBeenCalled();
    await expectNoMasters();
  });

  it("a direct apply of a valid snapshot is refused too, and writes none of the four kinds", async () => {
    await presentWithoutMasters();
    blockImports();
    const claims = parseEdgeCredential(fresh.credential)!;
    expect(
      await failureCode(
        applyEdgeMasterSnapshot(claims, capturedFresh.masters.snapshot),
      ),
    ).toBe("DATA_IMPORT_BLOCKED");
    await expectNoMasters();
  });

  it("a present node boots as present, without a masters call, and writes none of the four kinds", async () => {
    await presentWithoutMasters();
    blockImports();
    const spy = spyCloud({ masters: () => json(capturedFresh.masters) });
    expect(await bootstrapEdgeNodeIfNeeded(config(fresh))).toBe("present");
    expect(mastersCalls(spy)).toHaveLength(0);
    await expectNoMasters();
  });

  it("accepts and writes all four kinds when the guard allows", async () => {
    await presentWithoutMasters();
    spyCloud({ masters: () => json(capturedFresh.masters) });
    await syncEdgeMasters(config(fresh));
    const view = await dbView(fresh);
    for (const kind of KINDS)
      expect(view[kind].length, kind).toBeGreaterThan(0);
    expect(view).toEqual(viewOf(capturedFresh.masters.snapshot));
  });
});

// ---------------------------------------------------------------------------
// Codex 124: a database failure while reading the masters must not reach the
// error handler as a raw DrizzleQueryError (its message holds the SQL and the
// bound tenant/outlet/node ids, and res.err would log it).
describe("Codex 124 masters read failure is a fixed 503 without the raw error", () => {
  const SENTINEL = "SENTINEL_SQL_c124";

  function rawDbError(f: Fixture) {
    const cause = Object.assign(
      new Error(`canceling statement due to statement timeout ${SENTINEL}`),
      { code: "57014" },
    );
    return new DrizzleQueryError(
      `select "id" from "uoms" where "tenant_id" = $1 /* ${SENTINEL} */`,
      [f.tenantId, f.outletA, f.edgeNodeId],
      cause,
    );
  }

  // The request opens other transactions first (tenant resolution, credential
  // check); the masters read is the handler's last one. Let `passCount`
  // through and fail the next.
  function failMastersRead(error: unknown, passCount: number) {
    const original = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction");
    for (let i = 0; i < passCount; i += 1) spy.mockImplementationOnce(original);
    spy.mockRejectedValueOnce(error);
    return spy;
  }

  function assertClean(text: string, f: Fixture) {
    for (const secret of [
      SENTINEL,
      f.tenantId,
      f.outletA,
      f.edgeNodeId,
      f.credential,
      "Failed query",
      "uoms",
    ])
      expect(text, secret).not.toContain(secret);
  }

  it("the service throws SERVICE_UNAVAILABLE with no cause, SQL or ids, and logs only class and SQLSTATE", async () => {
    const verified = await verifyEdgeCredential(main.credential);
    expect(verified).not.toBeNull();
    const warn = vi.spyOn(logger, "warn");
    const spy = failMastersRead(rawDbError(main), 0);
    let thrown: unknown;
    try {
      await buildEdgeMasterSnapshot(verified!, main.credential);
    } catch (error) {
      thrown = error;
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(CoreError);
    const error = thrown as CoreError & { cause?: unknown };
    expect(error.code).toBe("SERVICE_UNAVAILABLE");
    expect(error.cause).toBeUndefined();
    assertClean(
      [
        error.message,
        error.stack ?? "",
        JSON.stringify(error),
        JSON.stringify(
          Object.getOwnPropertyNames(error).map((k) => (error as never)[k]),
        ),
      ].join("\n"),
      main,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      errorClass: "DrizzleQueryError",
      sqlState: "57014",
    });
    assertClean(JSON.stringify(warn.mock.calls), main);
  });

  it("the route answers 503 with a fixed body and the next request works", async () => {
    const probe = vi.spyOn(db, "transaction");
    expect((await cloudMasters(main)).status).toBe(200);
    const perRequest = probe.mock.calls.length;
    probe.mockRestore();
    expect(perRequest).toBeGreaterThan(0);
    const spy = failMastersRead(rawDbError(main), perRequest - 1);
    const response = await cloudMasters(main);
    expect(spy).toHaveBeenCalledTimes(perRequest);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    assertClean(JSON.stringify(response.body), main);
    spy.mockRestore();
    expect((await cloudMasters(main)).status).toBe(200);
  });

  it("a non-database error is not turned into a 503", async () => {
    const verified = await verifyEdgeCredential(main.credential);
    const bug = new Error("Unsafe database role for tenant access");
    failMastersRead(bug, 0);
    await expect(
      buildEdgeMasterSnapshot(verified!, main.credential),
    ).rejects.toBe(bug);
  });
});

// ---------------------------------------------------------------------------
// legend-ht6fu: a local migration (0147) or a local template backfill gave the
// edge accounts under ids the cloud does not know. A local account outside the
// snapshot whose code the snapshot holds under another id is a fork and is
// replaced by the cloud's row when nothing references it. Anything else
// outside the snapshot, or a referenced fork, stays refused.
// ---------------------------------------------------------------------------
describe("legend-ht6fu edge chart forked from the cloud's ids", () => {
  const FORKED_CODES = ["1204", "6110", "6111"];

  /** The cloud's snapshot with `codes` carrying other ids than the edge's. */
  async function cloudWithOtherIds(f: Fixture, codes = FORKED_CODES) {
    const { snapshot } = await captureMasters(f);
    let text = JSON.stringify(snapshot);
    const localIds = new Map<string, string>();
    for (const code of codes) {
      const account = snapshot.chartOfAccounts.find((a) => a.code === code)!;
      expect(account).toBeDefined();
      localIds.set(code, account.id);
      text = text.replaceAll(account.id, randomUUID());
    }
    return { forged: JSON.parse(text) as EdgeMasterSnapshot, localIds };
  }

  async function expectRefusedUnchanged(f: Fixture, body: unknown) {
    const before = await dbView(f);
    spyCloud({ masters: () => json(body) });
    const code = await failureCode(syncEdgeMasters(config(f)));
    vi.restoreAllMocks();
    expect(code).toBe("LOCAL_CONFLICT");
    expect(await dbView(f)).toEqual(before);
  }

  const dropRows = (f: Fixture, tables: string[]) =>
    deleteRows(tables, [f.tenantId]);

  it("replaces the unreferenced forked accounts and their mappings with the cloud's rows", async () => {
    const f = await createFixture("Fork");
    const { forged, localIds } = await cloudWithOtherIds(f);
    expect(forged.accountMappings.length).toBeGreaterThanOrEqual(3);
    spyCloud({ masters: () => json(signed(forged, f)) });
    await syncEdgeMasters(config(f));
    vi.restoreAllMocks();

    const after = await dbView(f);
    expect(after).toEqual(viewOf(forged));
    for (const code of FORKED_CODES) {
      const cloudId = forged.chartOfAccounts.find((a) => a.code === code)!.id;
      expect(
        after.accounts.filter((a) => a.code === code).map((a) => a.id),
      ).toEqual([cloudId]);
      expect(after.accounts.map((a) => a.id)).not.toContain(localIds.get(code));
    }
  });

  it("replay: a local account whose code no snapshot account has is never deleted", async () => {
    const f = await createFixture("Replay");
    const { snapshot: older } = await captureMasters(f);
    // A real cloud account the replayed older snapshot predates.
    await owner.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, '7777', 'Akun Baru Cloud', 'asset', 'current_asset')`,
      [f.tenantId, f.entityA],
    );
    await expectRefusedUnchanged(f, signed(older, f));
    // An empty chart in the snapshot holds no code either.
    const empty = structuredClone(older);
    empty.chartOfAccounts = [];
    empty.accountMappings = [];
    await expectRefusedUnchanged(f, signed(empty, f));
  });

  describe("a fork that other rows still reference stays refused, nothing written", () => {
    it("budgets", async () => {
      const f = await createFixture("ForkBudget");
      const { forged, localIds } = await cloudWithOtherIds(f);
      await owner.query(
        `INSERT INTO budgets (tenant_id, legal_entity_id, account_id, period, amount_idr)
         VALUES ($1, $2, $3, '2026-01', 1000)`,
        [f.tenantId, f.entityA, localIds.get("6110")],
      );
      try {
        await expectRefusedUnchanged(f, signed(forged, f));
      } finally {
        await dropRows(f, ["budgets"]);
      }
    });

    it("journal_lines", async () => {
      const f = await createFixture("ForkJournal");
      const { forged, localIds } = await cloudWithOtherIds(f);
      const other = forged.chartOfAccounts.find((a) => a.code === "1101")!;
      const period = randomUUID();
      const entry = randomUUID();
      await owner.query(
        `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period) VALUES ($1, $2, $3, '2026-11')`,
        [period, f.tenantId, f.entityA],
      );
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO journal_entries (id, tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type, description, idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, '2026-11-05', $4, 'manual', 'Fork uji', $5, $6)`,
          [
            entry,
            f.tenantId,
            f.entityA,
            period,
            `fork-${randomUUID()}`,
            "a".repeat(64),
          ],
        );
        await client.query(
          `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
           VALUES ($1, $2, $3, 1, 100, 0), ($1, $2, $4, 2, 0, 100)`,
          [f.tenantId, entry, localIds.get("6110"), other.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      try {
        await expectRefusedUnchanged(f, signed(forged, f));
      } finally {
        await dropRows(f, [
          "journal_lines",
          "journal_entries",
          "fiscal_periods",
        ]);
      }
    });

    it("fiscal_period_snapshot_lines", async () => {
      const f = await createFixture("ForkPeriod");
      const { forged, localIds } = await cloudWithOtherIds(f);
      const period = randomUUID();
      const snapshotId = randomUUID();
      await owner.query(
        `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period) VALUES ($1, $2, $3, '2026-11')`,
        [period, f.tenantId, f.entityA],
      );
      await owner.query(
        `INSERT INTO fiscal_period_snapshots (id, tenant_id, legal_entity_id, fiscal_period_id, period, version, taken_by, taken_at)
         VALUES ($1, $2, $3, $4, '2026-11', 1, 'uji', now())`,
        [snapshotId, f.tenantId, f.entityA, period],
      );
      await owner.query(
        `INSERT INTO fiscal_period_snapshot_lines (tenant_id, snapshot_id, account_id, debit_idr, credit_idr)
         VALUES ($1, $2, $3, 100, 0)`,
        [f.tenantId, snapshotId, localIds.get("6110")],
      );
      try {
        await expectRefusedUnchanged(f, signed(forged, f));
      } finally {
        await dropRows(f, [
          "fiscal_period_snapshot_lines",
          "fiscal_period_snapshots",
          "fiscal_periods",
        ]);
      }
    });
  });

  it("an in-snapshot local child of a forked parent ends under the cloud parent", async () => {
    const f = await createFixture("ForkChild");
    const { snapshot } = await captureMasters(f);
    const parent = snapshot.chartOfAccounts.find((a) =>
      snapshot.chartOfAccounts.some((c) => c.parentId === a.id),
    )!;
    const children = snapshot.chartOfAccounts
      .filter((c) => c.parentId === parent.id)
      .map((c) => c.id);
    // The cloud holds this parent under another id; its children keep theirs
    // and still point at the local parent here.
    const cloudParent = randomUUID();
    const forged = JSON.parse(
      JSON.stringify(snapshot).replaceAll(parent.id, cloudParent),
    ) as EdgeMasterSnapshot;
    spyCloud({ masters: () => json(signed(forged, f)) });
    await syncEdgeMasters(config(f));
    vi.restoreAllMocks();

    const after = await dbView(f);
    expect(after).toEqual(viewOf(forged));
    expect(after.accounts.map((a) => a.id)).not.toContain(parent.id);
    for (const id of children)
      expect(after.accounts.find((a) => a.id === id)!.parentId).toBe(
        cloudParent,
      );
  });
});
