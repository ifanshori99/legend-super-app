// Edge sync data rules at the database (beads legend-wg5t, legend-zinn):
// the classifier fails closed, a suspended tenant or closed outlet drops the
// link at connect and at re-check, and edge_to_cloud events are deduplicated
// across the nodes of a tenant. Fixtures: two disposable tenants of this
// suite, created by the migration owner and removed in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  classifyEdgeEvent,
  EdgeEventUnclassifiedError,
  setEdgeEventClassifier,
  type EdgeEventApplier,
} from "../edge/ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  isEdgeNodeActive,
  registerEdgeNode,
} from "../services/edge-node.service.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();

type Fixture = { tenantId: string; outletId: string };
const one: Fixture = { tenantId: randomUUID(), outletId: randomUUID() };
const two: Fixture = { tenantId: randomUUID(), outletId: randomUUID() };

const outletScope = (fixture: Fixture): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: fixture.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(fixture.outletId)] },
  );

async function createFixture(fixture: Fixture) {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    // Copy a valid plan/limits row (like accounting-core.test.ts): platform
    // suites running in parallel parse every tenant through tenantSchema, so a
    // minimal tenant would break them (422 on /api/platform/tenants).
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Edge Uji', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      fixture.tenantId,
      `edge-uji-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, fixture.tenantId, `edge-uji-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, fixture.tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'UJI-01', 'Outlet Uji', 'Jl. Uji', '{}', 'active')`,
    [fixture.outletId, fixture.tenantId, brand, entity],
  );
}

async function setStatus(
  table: "tenants" | "outlets",
  id: string,
  status: string,
) {
  await owner.query(`UPDATE ${table} SET status = $2 WHERE id = $1`, [
    id,
    status,
  ]);
}

let clock = Date.parse("2026-11-08T12:00:00.000Z");
function orderEvent(
  fixture: Fixture,
  aggregateId: string,
  sequence: number,
  id?: string,
): EventEnvelope {
  clock += 1;
  return {
    id: id ?? createUlid(clock),
    tenantId: fixture.tenantId as EventEnvelope["tenantId"],
    outletId: fixture.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `edg-hard-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  };
}

async function inboundCount(
  tenantId: string,
  eventId?: string,
  outcome?: string,
) {
  const result = await owner.query(
    `SELECT count(*)::int AS n FROM edge_inbound_events WHERE tenant_id = $1 AND ($2::text IS NULL OR event_id::text = $2) AND ($3::text IS NULL OR outcome = $3)`,
    [tenantId, eventId ? ulidToUuid(eventId) : null, outcome ?? null],
  );
  return result.rows[0].n as number;
}

const classifyTransaction = () => "transaction_event" as const;
function recordingApplier(applied: string[]): EdgeEventApplier<EdgeTx> {
  return {
    async apply(_tx, event) {
      applied.push(event.id);
    },
  };
}

let primary1: Awaited<ReturnType<typeof registerEdgeNode>>;
let standby1: Awaited<ReturnType<typeof registerEdgeNode>>;
let primary2: Awaited<ReturnType<typeof registerEdgeNode>>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture(one);
  await createFixture(two);
  primary1 = await registerEdgeNode(outletScope(one), actor, {
    outletId: one.outletId,
    role: "primary",
    label: "Utama 1",
  });
  standby1 = await registerEdgeNode(outletScope(one), actor, {
    outletId: one.outletId,
    role: "standby",
    label: "Cadangan 1",
  });
  primary2 = await registerEdgeNode(outletScope(two), actor, {
    outletId: two.outletId,
    role: "primary",
    label: "Utama 2",
  });
});

afterAll(async () => {
  setEdgeEventClassifier(null);
  setAuditWriter(null);
  // Edge rows are append-only / never deleted (triggers), and the disposable
  // database is superuser-owned: replica mode skips triggers and FK checks so
  // later suites listing tenants never see these fixtures.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
        [one.tenantId, two.tenantId],
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1)", [
      [one.tenantId, two.tenantId],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
});

describe("legend-wg5t fail-closed classifier", () => {
  it("default classifier throws EdgeEventUnclassifiedError without the payload", () => {
    setEdgeEventClassifier(null);
    const event = orderEvent(one, randomUUID(), 1);
    expect(() => classifyEdgeEvent(event)).toThrow(EdgeEventUnclassifiedError);
    expect(() => classifyEdgeEvent(event)).toThrow(/order/);
    setEdgeEventClassifier(() => "master_data");
    expect(classifyEdgeEvent(event)).toBe("master_data");
    setEdgeEventClassifier(null);
    expect(() => classifyEdgeEvent(event)).toThrow(EdgeEventUnclassifiedError);
  });

  it("an unclassified batch rolls back: nothing applied, recorded or acked", async () => {
    setEdgeEventClassifier(null);
    const node = await authenticateEdgeCredential(primary1.credential);
    const applied: string[] = [];
    const base = {
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "edge_to_cloud" as const,
      applier: recordingApplier(applied),
    };
    const event = orderEvent(one, randomUUID(), 1);
    const batch = {
      fromSeq: 0,
      toSeq: 1,
      events: [{ linkSeq: 1, event }],
    };
    // Default port, and an explicit classifier that returns null.
    for (const store of [
      createDbLinkStore(base),
      createDbLinkStore({ ...base, classify: () => null }),
    ]) {
      await expect(store.applyInbound(batch)).rejects.toThrow(
        EdgeEventUnclassifiedError,
      );
      expect(await store.lastReceivedInbound()).toBe(0);
    }
    expect(applied).toEqual([]);
    expect(await inboundCount(one.tenantId, event.id)).toBe(0);
    // Once a classifier is installed the same batch goes through.
    await createDbLinkStore({
      ...base,
      classify: classifyTransaction,
    }).applyInbound(batch);
    expect(applied).toEqual([event.id]);
  });
});

describe("legend-wg5t tenant and outlet status", () => {
  it("a suspended tenant is inactive and cannot authenticate; others are unaffected", async () => {
    const node1 = await authenticateEdgeCredential(primary1.credential);
    const node2 = await authenticateEdgeCredential(primary2.credential);
    expect(node1).not.toBeNull();
    expect(node2).not.toBeNull();
    await setStatus("tenants", one.tenantId, "suspended");
    try {
      expect(await isEdgeNodeActive(node1!)).toBe(false);
      expect(await authenticateEdgeCredential(primary1.credential)).toBeNull();
      expect(await isEdgeNodeActive(node2!)).toBe(true);
      expect(
        await authenticateEdgeCredential(primary2.credential),
      ).not.toBeNull();
    } finally {
      await setStatus("tenants", one.tenantId, "active");
    }
    expect(await isEdgeNodeActive(node1!)).toBe(true);
    expect(
      await authenticateEdgeCredential(primary1.credential),
    ).not.toBeNull();
  });

  it("a closed outlet is inactive and cannot authenticate; others are unaffected", async () => {
    const node1 = await authenticateEdgeCredential(primary1.credential);
    const node2 = await authenticateEdgeCredential(primary2.credential);
    await setStatus("outlets", one.outletId, "closed");
    try {
      expect(await isEdgeNodeActive(node1!)).toBe(false);
      expect(await authenticateEdgeCredential(primary1.credential)).toBeNull();
      expect(await authenticateEdgeCredential(standby1.credential)).toBeNull();
      expect(await isEdgeNodeActive(node2!)).toBe(true);
      expect(
        await authenticateEdgeCredential(primary2.credential),
      ).not.toBeNull();
    } finally {
      await setStatus("outlets", one.outletId, "active");
    }
    expect(await isEdgeNodeActive(node1!)).toBe(true);
    // preopening still connects: only `closed` blocks the link.
    await setStatus("outlets", one.outletId, "preopening");
    try {
      expect(await isEdgeNodeActive(node1!)).toBe(true);
    } finally {
      await setStatus("outlets", one.outletId, "active");
    }
  });
});

describe("legend-wg5t cross-node dedupe", () => {
  async function storesFor(
    credential: string,
    outboundDirection: "edge_to_cloud" | "cloud_to_edge",
    applied: string[],
  ) {
    const node = await authenticateEdgeCredential(credential);
    return createDbLinkStore({
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection,
      applier: recordingApplier(applied),
      classify: classifyTransaction,
    });
  }

  it("edge_to_cloud: the same event id from primary then standby applies once", async () => {
    const applied: string[] = [];
    const fromPrimary = await storesFor(
      primary1.credential,
      "cloud_to_edge",
      applied,
    );
    const fromStandby = await storesFor(
      standby1.credential,
      "cloud_to_edge",
      applied,
    );
    const event = orderEvent(one, randomUUID(), 1);
    await fromPrimary.applyInbound({
      fromSeq: 0,
      toSeq: 1,
      events: [{ linkSeq: 1, event }],
    });
    // The standby took over with the primary's outbox and resends the event.
    await fromStandby.applyInbound({
      fromSeq: 0,
      toSeq: 1,
      events: [{ linkSeq: 1, event }],
    });
    expect(applied).toEqual([event.id]);
    expect(await inboundCount(one.tenantId, event.id, "applied")).toBe(1);
    // The skipped duplicate still leaves a receipt for its link slot, so the
    // restore proof (legend-tmar2) sees no hole.
    expect(await inboundCount(one.tenantId, event.id, "superseded")).toBe(1);
    // Skipped, but the standby's cursor still moves so its queue drains.
    expect(await fromStandby.lastReceivedInbound()).toBe(1);
  });

  it("edge_to_cloud: a concurrent duplicate cannot be recorded twice and the retry skips it", async () => {
    const applied: string[] = [];
    const fromPrimary = await storesFor(
      primary1.credential,
      "cloud_to_edge",
      applied,
    );
    const fromStandby = await storesFor(
      standby1.credential,
      "cloud_to_edge",
      applied,
    );
    const event = orderEvent(one, randomUUID(), 1);
    const batch = (from: number) => ({
      fromSeq: from,
      toSeq: from + 1,
      events: [{ linkSeq: from + 1, event }],
    });
    const results = await Promise.allSettled([
      fromPrimary.applyInbound(batch(await fromPrimary.lastReceivedInbound())),
      fromStandby.applyInbound(batch(await fromStandby.lastReceivedInbound())),
    ]);
    // The loser rolled back (registry primary key) or ran after the winner and
    // skipped; the sender retries whichever failed.
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      const store = index === 0 ? fromPrimary : fromStandby;
      await store.applyInbound(batch(await store.lastReceivedInbound()));
    }
    expect(applied).toEqual([event.id]);
    expect(await inboundCount(one.tenantId, event.id, "applied")).toBe(1);
  });

  it("edge_to_cloud: a duplicate racing an uncommitted registry row fails on the primary key, then the retry skips it", async () => {
    // Forces the interleaving the test above may not hit: the primary's
    // registry row is written but not committed when the standby checks
    // "seen", so the standby's own registry insert must block and then fail.
    const applied: string[] = [];
    const fromStandby = await storesFor(
      standby1.credential,
      "cloud_to_edge",
      applied,
    );
    const event = orderEvent(one, randomUUID(), 1);
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `INSERT INTO edge_received_events (tenant_id, outlet_id, event_id, first_edge_node_id) VALUES ($1, $2, $3, $4)`,
        [
          one.tenantId,
          one.outletId,
          ulidToUuid(event.id),
          primary1.edgeNode.id,
        ],
      );
      const from = await fromStandby.lastReceivedInbound();
      const racing = fromStandby.applyInbound({
        fromSeq: from,
        toSeq: from + 1,
        events: [{ linkSeq: from + 1, event }],
      });
      racing.catch(() => undefined);
      // Commit only once the standby is waiting on the primary-key lock.
      const deadline = Date.now() + 5000;
      for (;;) {
        const waiting = await owner.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'INSERT INTO edge_received_events%'`,
        );
        if (waiting.rows.length > 0) break;
        if (Date.now() > deadline)
          throw new Error("standby never blocked on the registry");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query("COMMIT");
      const failure: unknown = await racing.then(
        () => null,
        (error: unknown) => error,
      );
      const code =
        (failure as { code?: string; cause?: { code?: string } })?.cause
          ?.code ?? (failure as { code?: string })?.code;
      expect(code).toBe("23505");
    } finally {
      holder.release();
    }
    expect(await inboundCount(one.tenantId, event.id)).toBe(0);
    // The sender retries the same batch: now "seen", skipped, cursor moves.
    const from = await fromStandby.lastReceivedInbound();
    await fromStandby.applyInbound({
      fromSeq: from,
      toSeq: from + 1,
      events: [{ linkSeq: from + 1, event }],
    });
    expect(await inboundCount(one.tenantId, event.id, "applied")).toBe(0);
    expect(await inboundCount(one.tenantId, event.id, "superseded")).toBe(1);
    expect(await fromStandby.lastReceivedInbound()).toBe(from + 1);
  });

  const receiptRow = (
    nodeId: string,
    direction: string,
    eventId: string,
    fixture: Fixture = one,
  ) =>
    owner.query(
      `INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome)
       VALUES ($1, $2, $3, $4, $5, 1, 'order', $6, 1, 'transaction_event', 'applied')`,
      [
        fixture.tenantId,
        fixture.outletId,
        nodeId,
        direction,
        eventId,
        randomUUID(),
      ],
    );
  const registryRow = (
    nodeId: string,
    eventId: string,
    fixture: Fixture = one,
  ) =>
    owner.query(
      `INSERT INTO edge_received_events (tenant_id, outlet_id, event_id, first_edge_node_id) VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.outletId, eventId, nodeId],
    );

  it("the registry primary key refuses a second (tenant, event) row", async () => {
    const node = await authenticateEdgeCredential(primary1.credential);
    const standby = await authenticateEdgeCredential(standby1.credential);
    const shared = randomUUID();
    await registryRow(node!.scope.edgeNodeId, shared);
    await expect(
      registryRow(standby!.scope.edgeNodeId, shared),
    ).rejects.toThrow(/edge_received_events_tenant_id_event_id_pk/);
  });

  it("receipts of one event on two nodes are allowed in edge_inbound_events (old data shape)", async () => {
    const node = await authenticateEdgeCredential(primary1.credential);
    const standby = await authenticateEdgeCredential(standby1.credential);
    const shared = randomUUID();
    // Pre-0065 data holds both receipts; no unique index may refuse them.
    await receiptRow(node!.scope.edgeNodeId, "edge_to_cloud", shared);
    await receiptRow(standby!.scope.edgeNodeId, "edge_to_cloud", shared);
    await receiptRow(node!.scope.edgeNodeId, "cloud_to_edge", shared);
    await receiptRow(standby!.scope.edgeNodeId, "cloud_to_edge", shared);
    const count = await owner.query(
      `SELECT count(*)::int AS n FROM edge_inbound_events WHERE tenant_id = $1 AND event_id = $2`,
      [one.tenantId, shared],
    );
    expect(count.rows[0].n).toBe(4);
  });

  it("registry rows are append-only: UPDATE and DELETE are refused", async () => {
    const node = await authenticateEdgeCredential(primary1.credential);
    const eventId = randomUUID();
    await registryRow(node!.scope.edgeNodeId, eventId);
    await expect(
      owner.query(
        `UPDATE edge_received_events SET received_at = now() WHERE tenant_id = $1 AND event_id = $2`,
        [one.tenantId, eventId],
      ),
    ).rejects.toThrow();
    await expect(
      owner.query(
        `DELETE FROM edge_received_events WHERE tenant_id = $1 AND event_id = $2`,
        [one.tenantId, eventId],
      ),
    ).rejects.toThrow();
    const still = await owner.query(
      `SELECT count(*)::int AS n FROM edge_received_events WHERE tenant_id = $1 AND event_id = $2`,
      [one.tenantId, eventId],
    );
    expect(still.rows[0].n).toBe(1);
  });

  it("another tenant can reuse an event id in the registry", async () => {
    const node = await authenticateEdgeCredential(primary1.credential);
    const other = await authenticateEdgeCredential(primary2.credential);
    const shared = randomUUID();
    await registryRow(node!.scope.edgeNodeId, shared);
    await registryRow(other!.scope.edgeNodeId, shared, two);
  });

  it("cloud_to_edge stays per node, and another tenant may reuse an event id", async () => {
    const applied1: string[] = [];
    const applied2: string[] = [];
    const nodeA = await storesFor(
      primary1.credential,
      "edge_to_cloud",
      applied1,
    );
    const nodeB = await storesFor(
      standby1.credential,
      "edge_to_cloud",
      applied1,
    );
    const otherTenant = await storesFor(
      primary2.credential,
      "cloud_to_edge",
      applied2,
    );
    const event = orderEvent(one, randomUUID(), 1);
    // Earlier tests already moved some cursors: continue from each node's own.
    for (const store of [nodeA, nodeB]) {
      const from = await store.lastReceivedInbound();
      await store.applyInbound({
        fromSeq: from,
        toSeq: from + 1,
        events: [{ linkSeq: from + 1, event }],
      });
    }
    expect(applied1).toEqual([event.id, event.id]);
    expect(await inboundCount(one.tenantId, event.id)).toBe(2);
    // Same id in a different tenant (events carry their tenant): unaffected.
    const foreign = orderEvent(two, randomUUID(), 1, event.id);
    await otherTenant.applyInbound({
      fromSeq: 0,
      toSeq: 1,
      events: [{ linkSeq: 1, event: foreign }],
    });
    expect(applied2).toEqual([event.id]);
    expect(await inboundCount(two.tenantId, event.id)).toBe(1);
  });
});
