// Built-in worker transport (bead legend-18qw): cloud local sink, edge queueing
// through the existing link queue, fail-closed routing and gap recording.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { mintEdgeCredential } from "../edge/credential.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { createBuiltinWorkerTransport } from "../worker/transport.ts";

const gapRecorder = vi.hoisted(() =>
  vi.fn(async () => ({ requestCount: 1, counted: true })),
);
vi.mock("../services/core-outbox-gaps.ts", () => ({
  recordOutboxGapRequest: gapRecorder,
}));

// A dedicated tenant and outlet: the edge suites already hold the fixture
// outlets' one active primary node (the unique index allows one per outlet),
// and other suites count the fixture tenant's outlets.
const tenantId = randomUUID();
const brandId = randomUUID();
const legalEntityId = randomUUID();
const outletA = randomUUID();
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
});

const jobContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const outletContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
  );

let clock = Date.parse("2026-11-08T08:00:00.000Z");
function orderEvent(
  outletId: string | null,
  sequence: number,
  aggregateId: string = randomUUID(),
): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `wt-test-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  };
}

const route = (overrides: Partial<Record<string, string | null>> = {}) => ({
  destination: "cloud-sync",
  direction: null,
  peerId: null,
  ...overrides,
});
const cloudEnv = {};
const edgeEnv = (token: string) => ({
  DEPLOYMENT_MODE: "development",
  EDGE_MODE: "true",
  EDGE_CLOUD_URL: "ws://localhost:4000/api/edge-link",
  EDGE_NODE_CREDENTIAL: token,
});
// Cloud-mode paths never touch the database or the transaction.
const unusedTx = undefined as never;
const unusedDb = undefined as never;

let edgeNodeId = "";
let edgeToken = "";

beforeAll(async () => {
  setAuditWriter(coreAuditWriter);
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Worker transport tenant', 'lengkap', 'active', 'shared', '{"modules":[]}', $3, $4)`,
    [
      tenantId,
      `uji-wt-${tenantId.slice(0, 8)}`,
      JSON.stringify({
        maxOutlets: 5,
        maxActiveEmployees: 30,
        maxDevices: 10,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      actor,
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand WT')",
    [brandId, tenantId, `uji-wt-brand-${tenantId.slice(0, 8)}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Worker Transport', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'WT-A', 'Outlet WT', 'Jl. Uji', '{}')`,
    [outletA, tenantId, brandId, legalEntityId],
  );
  const registered = await registerEdgeNode(outletContext(), actor, {
    outletId: outletA,
    role: "primary",
    label: "Transport test",
  });
  edgeNodeId = registered.edgeNode.id;
  edgeToken = registered.credential;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

describe("legend-18qw worker transport (cloud)", () => {
  const transport = createBuiltinWorkerTransport({
    database: unusedDb,
    env: cloudEnv,
  });

  it("legend-18qw cloud cloud-sync is a local sink", async () => {
    await expect(
      transport.deliverEvent(
        jobContext(),
        orderEvent(outletA, 1),
        "key",
        unusedTx,
        route(),
      ),
    ).resolves.toBeUndefined();
  });

  it("legend-18qw cloud unknown destination fails closed", async () => {
    await expect(
      transport.deliverEvent(
        jobContext(),
        orderEvent(outletA, 1),
        "key",
        unusedTx,
        route({ destination: "somewhere-else" }),
      ),
    ).rejects.toThrow("Unsupported outbox destination");
  });

  it("legend-18qw cloud non-null direction fails closed", async () => {
    await expect(
      transport.deliverEvent(
        jobContext(),
        orderEvent(outletA, 1),
        "key",
        unusedTx,
        route({ direction: "cloud_to_edge" }),
      ),
    ).rejects.toThrow("Unsupported outbox direction");
  });

  it("legend-18qw requestMissing records the gap through the gap service", async () => {
    const gap = {
      destination: "cloud-sync",
      aggregateType: "order",
      aggregateId: randomUUID(),
      missingSequence: 3,
    };
    const context = jobContext();
    await transport.requestMissing(context, gap);
    expect(gapRecorder).toHaveBeenCalledWith(unusedDb, context, gap);
  });
});

describe("legend-18qw worker transport (edge)", () => {
  it("legend-18qw edge rejects malformed edge env at factory time", () => {
    expect(() =>
      createBuiltinWorkerTransport({
        database: unusedDb,
        env: { DEPLOYMENT_MODE: "development", EDGE_MODE: "true" },
      }),
    ).toThrow(/EDGE_CLOUD_URL.*EDGE_NODE_CREDENTIAL/);
  });

  it("legend-18qw edge cloud-sync queues once and idempotently", async () => {
    const transport = createBuiltinWorkerTransport({
      database: db,
      env: edgeEnv(edgeToken),
    });
    const context = jobContext();
    const event = orderEvent(outletA, 1);
    for (let attempt = 0; attempt < 2; attempt += 1)
      await withTenant(db, context, (tx) =>
        transport.deliverEvent(context, event, event.id, tx, route()),
      );
    const rows = await withTenant(db, context, (tx) =>
      tx.execute(
        sql`SELECT direction, kind FROM edge_outbound_queue WHERE edge_node_id = ${edgeNodeId}::uuid AND event_id = ${ulidToUuid(event.id)}::uuid`,
      ),
    );
    expect(rows.rows).toEqual([
      { direction: "edge_to_cloud", kind: "transaction_event" },
    ]);
  });

  it("legend-18qw edge tenant-wide event throws", async () => {
    const transport = createBuiltinWorkerTransport({
      database: db,
      env: edgeEnv(edgeToken),
    });
    const context = jobContext();
    await expect(
      withTenant(db, context, (tx) =>
        transport.deliverEvent(
          context,
          orderEvent(null, 1),
          "key",
          tx,
          route(),
        ),
      ),
    ).rejects.toThrow("Edge sync requires an outlet-scoped event");
  });

  it("legend-18qw edge refuses events of another tenant than the credential", async () => {
    const other = mintEdgeCredential({
      tenantId: randomUUID(),
      outletId: outletA,
      edgeNodeId: randomUUID(),
    });
    const transport = createBuiltinWorkerTransport({
      database: db,
      env: edgeEnv(other.token),
    });
    const context = jobContext();
    await expect(
      withTenant(db, context, (tx) =>
        transport.deliverEvent(
          context,
          orderEvent(outletA, 1),
          "key",
          tx,
          route(),
        ),
      ),
    ).rejects.toThrow("Event tenant does not match the edge credential");
  });

  it("legend-18qw edge non-sync destination throws", async () => {
    const transport = createBuiltinWorkerTransport({
      database: unusedDb,
      env: edgeEnv(edgeToken),
    });
    await expect(
      transport.deliverEvent(
        jobContext(),
        orderEvent(outletA, 1),
        "key",
        unusedTx,
        route({ destination: "push" }),
      ),
    ).rejects.toThrow("Unsupported outbox destination");
  });
});
