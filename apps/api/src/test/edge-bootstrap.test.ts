// Edge bootstrap bundle (bead legend-khu5; brief sub-ws02-edge section D).
// Written from the brief, not from the implementation.
//
// Cloud and edge share one test database, so the "cloud" side is the real
// route (GET /api/edge-sync/bootstrap) used once to capture each node's
// bundle, and an empty edge is made by deleting the node's tenant rows before
// the edge code runs (the edge then "fetches" the captured response through a
// fetch spy, the way edge-registry-pull.test.ts does).
//
// Assumptions (brief ambiguities):
//  - Response: { bundle, signature } at the top level or under `data`; the
//    bundle has `version`, `issuedAt`, `tenant`, `legalEntity`, `outlet` and
//    the brand(s) as `brand` (one) or `brands` (array). Each has an `id`.
//  - signature = hex HMAC-SHA256 over canonical JSON (keys sorted at every
//    depth, no whitespace) of the bundle, key = the node's credential hash
//    (parseEdgeCredential(token).hash, hex-decoded to its 32 bytes).
//  - The edge reaches the cloud over the https form of EDGE_CLOUD_URL (wss ->
//    https) with the global fetch and `Authorization: Bearer <credential>`.
//  - bootstrapEdgeNodeIfNeeded takes the `config` produced by
//    parseEdgeRuntimeConfig(...).config and throws EdgeBootError (exported from
//    ../edge/runtime.ts) on network, HTTP, JSON, signature or claim failures.
//  - "Seeding then ensureLocalEdgeNode succeeds" is observed through
//    startEdgeRuntime: it resolves and the local edge_nodes row exists.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { bootstrapEdgeNodeIfNeeded } from "../edge/bootstrap.ts";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import {
  EdgeBootError,
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  startEdgeRuntime,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  edgeBootstrapSignatureMatches,
  signEdgeBootstrapBundle,
} from "../services/edge-bootstrap.service.ts";
import {
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { simulateEdgeModifierRecipeFk } from "./helpers/edge-database.ts";

const CLOUD_LINK_URL = "wss://cloud.bootstrap.test/api/edge-link";
const BOOTSTRAP_PATH = "/api/edge-sync/bootstrap";
const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";
const RECORDS_PATH = "/api/edge-sync/device-records";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const app = createApp();

type Fixture = {
  tenantId: string;
  outletId: string;
  brandId: string;
  entityId: string;
  /** Same tenant, never referenced by the node's outlet. */
  siblingOutletId: string;
  strayBrandId: string;
  credential: string;
  edgeNodeId: string;
};
const fixtures: Fixture[] = [];

const scopeOf = (fixture: Fixture): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: fixture.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(fixture.outletId)] },
  );

async function createFixture(): Promise<Fixture> {
  const fixture = {
    tenantId: randomUUID(),
    outletId: randomUUID(),
    brandId: randomUUID(),
    entityId: randomUUID(),
    siblingOutletId: randomUUID(),
    strayBrandId: randomUUID(),
    credential: "",
    edgeNodeId: "",
  } satisfies Fixture;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Bootstrap Uji', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      fixture.tenantId,
      `edge-boot-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  for (const [id, name] of [
    [fixture.brandId, "Brand Node"],
    [fixture.strayBrandId, "Brand Lain"],
  ] as const)
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
      [
        id,
        fixture.tenantId,
        `edge-boot-${randomBytes(3).toString("hex")}`,
        name,
      ],
    );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Bootstrap Uji', false)`,
    [fixture.entityId, fixture.tenantId],
  );
  for (const [id, code, name, brand] of [
    [fixture.outletId, "BOOT-01", "Outlet Bootstrap", fixture.brandId],
    [
      fixture.siblingOutletId,
      "BOOT-02",
      "Outlet Saudara",
      fixture.strayBrandId,
    ],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', '{}', 'active')`,
      [id, fixture.tenantId, brand, fixture.entityId, code, name],
    );
  // One local uom and one stock location: a node with both is "already
  // synced", so the present path makes no network call (legend-9ppw).
  await owner.query(
    `INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'gr', 'gram')`,
    [fixture.tenantId],
  );
  await owner.query(
    `INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang Uji', 'warehouse')`,
    [fixture.tenantId, fixture.outletId],
  );
  const registered = await registerEdgeNode(scopeOf(fixture), actor, {
    outletId: fixture.outletId,
    role: "primary",
    label: "Node bootstrap",
  });
  fixture.credential = registered.credential;
  fixture.edgeNodeId = registered.edgeNode.id;
  fixtures.push(fixture);
  return fixture;
}

const TABLES = [
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
  "outlets",
  "legal_entities",
  "brands",
];

/** Removes every row of these tenants, as an edge that never had them. */
async function purge(...targets: Fixture[]) {
  const ids = targets.map((fixture) => fixture.tenantId);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of TABLES)
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
        ids,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1)", [ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const rowCount = async (table: string, column: string, id: string) =>
  (
    await owner.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
      [id],
    )
  ).rows[0].n as number;

const hasTenantRows = async (fixture: Fixture) =>
  (await rowCount("tenants", "id", fixture.tenantId)) +
  (await rowCount("outlets", "tenant_id", fixture.tenantId));

// ---- bundle helpers --------------------------------------------------------

type Bundle = Record<string, unknown> & {
  tenant: Record<string, unknown>;
  outlet: Record<string, unknown>;
  legalEntity: Record<string, unknown>;
  issuedAt: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

const keyOf = (credential: string) => parseEdgeCredential(credential)!.hash;
// The digest is 64 hex characters = a 32-byte key; the HMAC uses the bytes.
const sign = (bundle: unknown, credential: string) =>
  createHmac("sha256", Buffer.from(keyOf(credential), "hex"))
    .update(canonical(bundle))
    .digest("hex");

type Signed = { bundle: Bundle; signature: string };
const unwrap = (body: unknown): Signed =>
  ((body as { data?: Signed } | undefined)?.data ?? body) as Signed;

const brandsOf = (bundle: Bundle): { id: string }[] =>
  (bundle.brands as { id: string }[] | undefined) ??
  (bundle.brand ? [bundle.brand as { id: string }] : []);

async function cloudBundle(fixture: Fixture) {
  const response = await request(app)
    .get(BOOTSTRAP_PATH)
    .set("Authorization", `Bearer ${fixture.credential}`);
  return response;
}

function config(fixture: Fixture) {
  const parsed = parseEdgeRuntimeConfig({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: CLOUD_LINK_URL,
    EDGE_NODE_CREDENTIAL: fixture.credential,
    EDGE_NODE_ROLE: "primary",
  });
  if (!parsed.ok) throw new Error(parsed.problems.join(", "));
  return parsed.config as Parameters<typeof bootstrapEdgeNodeIfNeeded>[0];
}

const bootEnv = (fixture: Fixture) => ({
  EDGE_MODE: "true",
  EDGE_CLOUD_URL: CLOUD_LINK_URL,
  EDGE_NODE_CREDENTIAL: fixture.credential,
  EDGE_NODE_ROLE: "primary",
});

// ---- fetch spy -------------------------------------------------------------

type FetchMock = MockInstance<typeof fetch>;
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

/**
 * Answers the bootstrap endpoint with `answer`; the masters endpoint (bead
 * legend-9ppw) with the node's own captured snapshot, picked by the bearer
 * credential; the registry pull with an empty page.
 */
function spyCloud(answer: () => Promise<Response> | Response): FetchMock {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: unknown, init?: RequestInit) => {
      const { pathname } = urlOf(input);
      if (pathname.endsWith(MASTERS_PATH)) {
        const credential = String(headerOf(init, "authorization")).replace(
          /^Bearer /,
          "",
        );
        const masters = capturedMasters.get(credential);
        if (!masters) throw new Error("no captured masters for this node");
        return json(masters);
      }
      if (pathname.endsWith(BOOTSTRAP_PATH)) return answer();
      if (pathname.endsWith(RECORDS_PATH))
        return json({
          data: [],
          meta: { limit: 100, nextCursor: null, watermark: null },
        });
      throw new Error(`unexpected fetch ${pathname}`);
    });
}
const bootstrapCalls = (spy: FetchMock) =>
  spy.mock.calls.filter(([input]) =>
    urlOf(input).pathname.endsWith(BOOTSTRAP_PATH),
  );

// ---- fixtures --------------------------------------------------------------

let nodeA: Fixture; // edge under test, purged locally after capture
let nodeB: Fixture; // another tenant, purged locally after capture
let nodeC: Fixture; // stays seeded: the already-bootstrapped edge
let restoreModifierRecipeFk: () => Promise<void>;
let capturedA: { bundle: Bundle; signature: string };
let capturedB: { bundle: Bundle; signature: string };
/** Cloud's signed masters snapshot per node credential. */
const capturedMasters = new Map<string, unknown>();
const cloudState = getEdgeRuntimeState();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  // The shared test database is cloud-style; startEdgeRuntime refuses it with
  // modifiers_recipe_fk, so simulate an edge database.
  restoreModifierRecipeFk = await simulateEdgeModifierRecipeFk(owner);
  nodeA = await createFixture();
  nodeB = await createFixture();
  nodeC = await createFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  setEdgeRuntimeStateForTests(cloudState);
});

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  await purge(...fixtures);
  await restoreModifierRecipeFk();
  await owner.end();
});

// ---------------------------------------------------------------------------
describe("legend-khu5 cloud bootstrap endpoint", () => {
  it("answers a node with a private, uncached, signed bundle of its own tenant and outlet only", async () => {
    const response = await cloudBundle(nodeA);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/private/);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    const { bundle, signature } = unwrap(response.body);
    expect(bundle.version).toBe(1);
    expect(Number.isNaN(Date.parse(bundle.issuedAt))).toBe(false);
    expect(bundle.tenant.id).toBe(nodeA.tenantId);
    expect(bundle.legalEntity.id).toBe(nodeA.entityId);
    expect(bundle.outlet.id).toBe(nodeA.outletId);
    expect(brandsOf(bundle).map((brand) => brand.id)).toEqual([nodeA.brandId]);
    expect(typeof signature).toBe("string");
    capturedA = { bundle, signature };
  });

  it("holds no other tenant, outlet or brand and no secrets", async () => {
    const response = await cloudBundle(nodeA);
    const text = JSON.stringify(unwrap(response.body).bundle);
    for (const foreign of [
      nodeB.tenantId,
      nodeB.outletId,
      nodeB.brandId,
      nodeA.siblingOutletId, // same tenant, another outlet
      nodeA.strayBrandId, // same tenant, brand the outlet does not use
      cafeLegendPlatformFixtures.tenant.id,
    ])
      expect(text).not.toContain(foreign);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(nodeA.credential);
    expect(raw).not.toContain(keyOf(nodeA.credential));
    expect(raw.toLowerCase()).not.toMatch(/credential|secret/);
  });

  it("signs the canonical bundle with a key only the node and the cloud can derive", async () => {
    const { bundle, signature } = unwrap((await cloudBundle(nodeA)).body);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toBe(sign(bundle, nodeA.credential));
    expect(signature).toBe(
      signEdgeBootstrapBundle(bundle, keyOf(nodeA.credential)),
    );
    expect(
      edgeBootstrapSignatureMatches(bundle, signature, keyOf(nodeA.credential)),
    ).toBe(true);
    // Another node's key does not verify it.
    expect(signature).not.toBe(sign(bundle, nodeB.credential));
  });

  it("each node receives its own tenant's bundle", async () => {
    const { bundle } = unwrap((await cloudBundle(nodeB)).body);
    expect(bundle.tenant.id).toBe(nodeB.tenantId);
    expect(bundle.outlet.id).toBe(nodeB.outletId);
    expect(JSON.stringify(bundle)).not.toContain(nodeA.tenantId);
    capturedB = unwrap((await cloudBundle(nodeB)).body);
  });

  it("refuses callers without a valid edge credential", async () => {
    expect((await request(app).get(BOOTSTRAP_PATH)).status).toBe(401);
    const wrong = nodeA.credential.slice(0, -2) + "AA";
    const forged = await request(app)
      .get(BOOTSTRAP_PATH)
      .set("Authorization", `Bearer ${wrong}`);
    expect(forged.status).toBe(401);
    const swapped = await request(app)
      .get(BOOTSTRAP_PATH)
      .set(
        "Authorization",
        `Bearer ${nodeA.credential.replace(nodeA.outletId, nodeB.outletId)}`,
      );
    expect(swapped.status).toBe(401);
    expect(JSON.stringify(forged.body)).not.toContain(nodeA.tenantId);
  });
});

// ---------------------------------------------------------------------------
describe("legend-khu5 edge bootstrapEdgeNodeIfNeeded", () => {
  it("does nothing, and fetches nothing, when the tenant and outlet already exist locally", async () => {
    const spy = spyCloud(() => {
      throw new Error("must not be called");
    });
    await bootstrapEdgeNodeIfNeeded(config(nodeC));
    expect(spy).not.toHaveBeenCalled();
  });

  describe("on an empty edge", () => {
    // Capture first (rows still exist), then forget them locally.
    beforeAll(async () => {
      capturedA = unwrap((await cloudBundle(nodeA)).body);
      capturedB = unwrap((await cloudBundle(nodeB)).body);
      for (const node of [nodeA, nodeB])
        capturedMasters.set(
          node.credential,
          (
            await request(app)
              .get(MASTERS_PATH)
              .set("Authorization", `Bearer ${node.credential}`)
              // Version 2 (every brand) is served only to an edge that asks.
              .set("x-edge-snapshot-version", "2")
          ).body,
        );
      await purge(nodeA, nodeB);
    });
    afterEach(async () => {
      await purge(nodeA, nodeB);
    });

    it("fetches the bundle with the node credential, verifies it and seeds exactly its rows", async () => {
      const spy = spyCloud(() => json(capturedA));
      expect(await hasTenantRows(nodeA)).toBe(0);
      await bootstrapEdgeNodeIfNeeded(config(nodeA));

      const calls = bootstrapCalls(spy);
      expect(calls).toHaveLength(1);
      const url = urlOf(calls[0]![0]);
      expect(url.host).toBe("cloud.bootstrap.test");
      expect(url.pathname).toBe(BOOTSTRAP_PATH);
      expect(headerOf(calls[0]![1], "authorization")).toBe(
        `Bearer ${nodeA.credential}`,
      );

      expect(await rowCount("tenants", "id", nodeA.tenantId)).toBe(1);
      expect(await rowCount("legal_entities", "id", nodeA.entityId)).toBe(1);
      expect(await rowCount("brands", "id", nodeA.brandId)).toBe(1);
      expect(await rowCount("outlets", "id", nodeA.outletId)).toBe(1);
      // Nothing that was not in the bundle.
      expect(await rowCount("outlets", "id", nodeA.siblingOutletId)).toBe(0);
      // legend-2uqcd: the masters sync that follows the bundle brings every
      // brand of the tenant (recipes of other brands need their brand row), so
      // the stray brand of the same tenant is present; the bundle itself still
      // carries only the outlet's brand.
      expect(await rowCount("brands", "id", nodeA.strayBrandId)).toBe(1);
      expect(await hasTenantRows(nodeB)).toBe(0);
      const outlet = await owner.query(
        "SELECT name, brand_id, legal_entity_id FROM outlets WHERE id = $1",
        [nodeA.outletId],
      );
      expect(outlet.rows[0]).toEqual({
        name: "Outlet Bootstrap",
        brand_id: nodeA.brandId,
        legal_entity_id: nodeA.entityId,
      });
    });

    it("is a no-op the second time: no fetch, no duplicate rows", async () => {
      const spy = spyCloud(() => json(capturedA));
      await bootstrapEdgeNodeIfNeeded(config(nodeA));
      await bootstrapEdgeNodeIfNeeded(config(nodeA));
      expect(bootstrapCalls(spy)).toHaveLength(1);
      expect(await rowCount("tenants", "id", nodeA.tenantId)).toBe(1);
      expect(await rowCount("outlets", "id", nodeA.outletId)).toBe(1);
    });

    it("refuses a tampered bundle and seeds nothing", async () => {
      const tampered = structuredClone(capturedA);
      tampered.bundle.outlet.name = "Outlet Dibajak";
      spyCloud(() => json(tampered));
      await expect(bootstrapEdgeNodeIfNeeded(config(nodeA))).rejects.toThrow(
        EdgeBootError,
      );
      expect(await hasTenantRows(nodeA)).toBe(0);
    });

    it("refuses a wrong or malformed signature and seeds nothing", async () => {
      const flipped = capturedA.signature.replace(
        /^./,
        capturedA.signature[0] === "0" ? "1" : "0",
      );
      for (const signature of [
        flipped,
        "",
        "not-hex",
        sign(capturedA.bundle, nodeB.credential), // another node's key
      ]) {
        spyCloud(() => json({ bundle: capturedA.bundle, signature }));
        await expect(bootstrapEdgeNodeIfNeeded(config(nodeA))).rejects.toThrow(
          EdgeBootError,
        );
        vi.restoreAllMocks();
      }
      expect(await hasTenantRows(nodeA)).toBe(0);
    });

    it("refuses a correctly signed bundle of another tenant, whichever way round", async () => {
      // Node B's key signs tenant A's bundle, and the reverse.
      const aForB = {
        bundle: capturedA.bundle,
        signature: sign(capturedA.bundle, nodeB.credential),
      };
      const bForA = {
        bundle: capturedB.bundle,
        signature: sign(capturedB.bundle, nodeA.credential),
      };
      spyCloud(() => json(aForB));
      await expect(bootstrapEdgeNodeIfNeeded(config(nodeB))).rejects.toThrow(
        EdgeBootError,
      );
      vi.restoreAllMocks();
      spyCloud(() => json(bForA));
      await expect(bootstrapEdgeNodeIfNeeded(config(nodeA))).rejects.toThrow(
        EdgeBootError,
      );
      expect(await hasTenantRows(nodeA)).toBe(0);
      expect(await hasTenantRows(nodeB)).toBe(0);
    });

    it("refuses a correctly signed bundle for the right tenant but another outlet", async () => {
      const bundle = structuredClone(capturedA.bundle);
      bundle.outlet.id = nodeA.siblingOutletId;
      spyCloud(() =>
        json({ bundle, signature: sign(bundle, nodeA.credential) }),
      );
      await expect(bootstrapEdgeNodeIfNeeded(config(nodeA))).rejects.toThrow(
        EdgeBootError,
      );
      expect(await hasTenantRows(nodeA)).toBe(0);
    });

    it("fails clearly, without leaking the credential, when the cloud is unreachable or answers badly", async () => {
      const answers: (() => Promise<Response> | Response)[] = [
        () => {
          throw new TypeError("fetch failed");
        },
        () => json({ error: { code: "UNAUTHORIZED" } }, 401),
        () => json({ error: { code: "INTERNAL" } }, 500),
        () =>
          new Response("<html>bukan json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
        () => json({ unexpected: true }),
      ];
      for (const answer of answers) {
        spyCloud(answer);
        const failure = await bootstrapEdgeNodeIfNeeded(config(nodeA)).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(EdgeBootError);
        const message = (failure as Error).message;
        expect(message.length).toBeGreaterThan(10);
        expect(message).not.toContain(nodeA.credential);
        expect(message).not.toContain(keyOf(nodeA.credential));
        vi.restoreAllMocks();
      }
      expect(await hasTenantRows(nodeA)).toBe(0);
    });

    it("after seeding, startEdgeRuntime registers the local edge node and comes up", async () => {
      spyCloud(() => json(capturedA));
      expect(await rowCount("edge_nodes", "id", nodeA.edgeNodeId)).toBe(0);
      const handle = (await startEdgeRuntime(
        bootEnv(nodeA) as never,
      )) as unknown as { stop(): Promise<void> };
      try {
        expect(handle).toBeTruthy();
        expect(await rowCount("tenants", "id", nodeA.tenantId)).toBe(1);
        expect(await rowCount("outlets", "id", nodeA.outletId)).toBe(1);
        expect(await rowCount("edge_nodes", "id", nodeA.edgeNodeId)).toBe(1);
      } finally {
        await handle.stop();
      }
    });

    it("startEdgeRuntime stays down with an EdgeBootError when the bundle cannot be verified", async () => {
      const tampered = structuredClone(capturedA);
      tampered.bundle.tenant.name = "Dibajak";
      spyCloud(() => json(tampered));
      await expect(startEdgeRuntime(bootEnv(nodeA) as never)).rejects.toThrow(
        EdgeBootError,
      );
      expect(await hasTenantRows(nodeA)).toBe(0);
    });
  });
});
