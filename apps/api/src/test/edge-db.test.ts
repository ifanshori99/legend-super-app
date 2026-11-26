// EDG-01 foundation at the database (bead legend-2pi): the edge registry and
// link tables under forced tenant + outlet RLS, the credential check, terminal
// revocation, the durable offline queue and the Postgres link store. Writes go
// through the services as the restricted legend_app login; raw checks run as
// legend_app with explicit settings, fixtures as the migration owner.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { createLinkPeer, type LinkStore } from "../edge/link-peer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  isEdgeNodeActive,
  listEdgeNodes,
  registerEdgeNode,
  revokeEdgeNode,
} from "../services/edge-node.service.ts";
import {
  edgeQueueBacklog,
  enqueueEdgeEvent,
} from "../services/edge-queue.service.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const otherTenant = randomUUID();
const actor = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

const tenantBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const outletScope = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(tenantBase(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asAppRole<T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Migration owner with the tenant settings, in case FORCE RLS applies to it. */
async function asOwner(text: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let clock = Date.parse("2026-11-03T12:00:00.000Z");
function orderEvent(
  outletId: string,
  aggregateId: string,
  sequence: number,
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
    idempotencyKey: `edg-test-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  };
}

let primaryId = "";
let primaryCredential = "";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  const registered = await registerEdgeNode(outletScope(outletA), actor, {
    outletId: outletA,
    role: "primary",
    label: "Mini PC utama",
  });
  primaryId = registered.edgeNode.id;
  primaryCredential = registered.credential;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

describe("EDG-01 edge registry", () => {
  it("TEN-02 EDG-01 edge tables have forced restrictive tenant and outlet policies", async () => {
    const names = [
      "edge_catalog_publisher_cursors",
      "edge_inbound_events",
      "edge_link_dead_letters",
      "edge_link_slots",
      "edge_nodes",
      "edge_order_ingests",
      "edge_outbound_queue",
      "edge_pos_ingests",
      "edge_printer_delete_versions",
      "edge_receipt_skips",
      "edge_sync_conflicts",
      "outlet_failover_windows",
      "sync_cursors",
    ];
    const result = await owner.query(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [names],
    );
    expect(result.rows).toEqual(
      names.map((name) => ({
        name,
        enabled: true,
        forced: true,
        tenant: true,
        outlet: true,
      })),
    );
  });

  it("EDG-01 stores only a digest and authenticates the credential once", async () => {
    const stored = await asOwner(
      "SELECT credential_hash FROM edge_nodes WHERE id = $1",
      [primaryId],
    );
    expect(primaryCredential).not.toContain(stored.rows[0].credential_hash);
    const node = await authenticateEdgeCredential(primaryCredential);
    expect(node?.scope).toEqual({
      tenantId,
      outletId: outletA,
      edgeNodeId: primaryId,
    });
    expect(
      await authenticateEdgeCredential(`${primaryCredential.slice(0, -2)}AA`),
    ).toBeNull();
    expect(
      await authenticateEdgeCredential(
        primaryCredential.replace(outletA, outletB),
      ),
    ).toBeNull();
  });

  it("EDG-01 one active primary per outlet", async () => {
    await expect(
      registerEdgeNode(outletScope(outletA), actor, {
        outletId: outletA,
        role: "primary",
        label: "Duplikat",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("EDG-03 EDG-01 revocation is terminal and refuses the credential", async () => {
    const standby = await registerEdgeNode(outletScope(outletA), actor, {
      outletId: outletA,
      role: "standby",
      label: "Mini PC cadangan",
    });
    const node = await authenticateEdgeCredential(standby.credential);
    expect(node).not.toBeNull();
    const revoked = await revokeEdgeNode(outletScope(outletA), actor, {
      edgeNodeId: standby.edgeNode.id,
      reason: "Unit rusak",
    });
    expect(revoked.status).toBe("revoked");
    expect(await authenticateEdgeCredential(standby.credential)).toBeNull();
    expect(await isEdgeNodeActive(node!)).toBe(false);
    await expect(
      asOwner(
        "UPDATE edge_nodes SET status = 'active', revoked_at = NULL WHERE id = $1",
        [standby.edgeNode.id],
      ),
    ).rejects.toThrow(/cannot be reactivated/);
    await expect(
      asOwner("DELETE FROM edge_nodes WHERE id = $1", [standby.edgeNode.id]),
    ).rejects.toThrow(/never deleted/);
  });

  it("TEN-01 EDG-01 another tenant and another outlet see no edge rows", async () => {
    const other = await asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
      c.query("SELECT id FROM edge_nodes"),
    );
    expect(other.rows).toEqual([]);
    const outletOnlyB = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      (c) => c.query("SELECT id FROM edge_nodes WHERE id = $1", [primaryId]),
    );
    expect(outletOnlyB.rows).toEqual([]);
    expect(await listEdgeNodes(outletScope(outletB))).toEqual([]);
    await expect(
      asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
        c.query(
          `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction)
           VALUES ($1, $2, $3, 'edge_to_cloud')`,
          [tenantId, outletA, primaryId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      registerEdgeNode(outletScope(outletB), actor, {
        outletId: outletA,
        role: "standby",
        label: "Bukan outlet saya",
      }),
    ).rejects.toThrow();
  });
});

describe("EDG-01 offline queue and Postgres link store", () => {
  const order = randomUUID();

  it("EDG-01 queue assigns gap-free link sequences, is idempotent and ordered per aggregate", async () => {
    const context = outletScope(outletA);
    const first = orderEvent(outletA, order, 1);
    const result = await withTenant(db, context, async (tx) => {
      const a = await enqueueEdgeEvent(tx, context, {
        edgeNodeId: primaryId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: first,
      });
      const again = await enqueueEdgeEvent(tx, context, {
        edgeNodeId: primaryId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: first,
      });
      const b = await enqueueEdgeEvent(tx, context, {
        edgeNodeId: primaryId,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: orderEvent(outletA, order, 2),
      });
      return { a, again, b };
    });
    expect(result.a).toEqual({ linkSeq: 1, duplicate: false });
    expect(result.again).toEqual({ linkSeq: 1, duplicate: true });
    expect(result.b.linkSeq).toBe(2);
    await expect(
      withTenant(db, context, (tx) =>
        enqueueEdgeEvent(tx, context, {
          edgeNodeId: primaryId,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event: orderEvent(outletA, order, 5),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      withTenant(db, context, (tx) =>
        enqueueEdgeEvent(tx, context, {
          edgeNodeId: primaryId,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event: orderEvent(outletB, randomUUID(), 1),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      asOwner(
        "UPDATE edge_outbound_queue SET event = '{}'::jsonb WHERE edge_node_id = $1",
        [primaryId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      asOwner("DELETE FROM edge_outbound_queue WHERE edge_node_id = $1", [
        primaryId,
      ]),
    ).rejects.toThrow(/cannot be deleted/);
    const backlog = await edgeQueueBacklog(
      db,
      context,
      primaryId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(2);
  });

  it("EDG-01 drains the durable queue to the peer and records the acknowledgement", async () => {
    const node = await authenticateEdgeCredential(primaryCredential);
    const edgeStore = createDbLinkStore({
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "edge_to_cloud",
    });
    // The cloud side in memory: it applies everything it is sent, in order.
    const received: EventEnvelope[] = [];
    let cursor = 0;
    const cloudStore: LinkStore = {
      outboundHead: async () => 0,
      lastAckedOutbound: async () => 0,
      readOutbound: async () => [],
      ackOutbound: async () => {},
      lastReceivedInbound: async () => cursor,
      applyInbound: async ({ fromSeq, toSeq, events }) => {
        if (fromSeq !== cursor) throw new Error("moved");
        received.push(...events.map((e) => e.event));
        cursor = toSeq;
      },
    };
    const wire = (target: () => ReturnType<typeof createLinkPeer>) => ({
      send: (data: string) => queueMicrotask(() => target().receive(data)),
      close: () => {},
    });
    const edgePeer: ReturnType<typeof createLinkPeer> = createLinkPeer({
      scope: node!.scope,
      outboundDirection: "edge_to_cloud",
      store: edgeStore,
      version: "edge",
      transport: wire(() => cloudPeer),
    });
    const cloudPeer: ReturnType<typeof createLinkPeer> = createLinkPeer({
      scope: node!.scope,
      outboundDirection: "cloud_to_edge",
      store: cloudStore,
      version: "cloud",
      transport: wire(() => edgePeer),
    });
    edgePeer.start();
    cloudPeer.start();
    const end = Date.now() + 5000;
    while ((await edgeStore.lastAckedOutbound()) < 2 && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 20));
    edgePeer.stop();
    cloudPeer.stop();
    expect(received.map((e) => e.sequence)).toEqual([1, 2]);
    const backlog = await edgeQueueBacklog(
      db,
      outletScope(outletA),
      primaryId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(0);
    expect(backlog.lastAckedAt).not.toBeNull();
    const row = await asOwner(
      "SELECT last_sync_cursor FROM edge_nodes WHERE id = $1",
      [primaryId],
    );
    expect(row.rows[0].last_sync_cursor).toBe("2");
  });

  it("EDG-01 applies inbound atomically: no applier means nothing recorded, then idempotent apply and conflict log", async () => {
    const node = await authenticateEdgeCredential(primaryCredential);
    const applied: string[] = [];
    const base = {
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "edge_to_cloud" as const,
      // The default classifier fails closed (legend-wg5t); install one so
      // this test still reaches the unwired applier.
      classify: () => "transaction_event" as const,
    };
    const refusing = createDbLinkStore(base); // default applier: fail closed
    const aggregate = randomUUID();
    const one = orderEvent(outletA, aggregate, 1);
    const two = orderEvent(outletA, aggregate, 2);
    await expect(
      refusing.applyInbound({
        fromSeq: 0,
        toSeq: 1,
        events: [{ linkSeq: 1, event: one }],
      }),
    ).rejects.toThrow(/No cloud_to_edge applier/);
    expect(await refusing.lastReceivedInbound()).toBe(0);

    const store = createDbLinkStore({
      ...base,
      applier: {
        async apply(_tx, event) {
          applied.push(event.id);
        },
      },
    });
    await store.applyInbound({
      fromSeq: 0,
      toSeq: 2,
      events: [
        { linkSeq: 1, event: one },
        { linkSeq: 2, event: two },
      ],
    });
    // A different event reusing sequence 2 (collision) and a resent one.
    const collision = orderEvent(outletA, aggregate, 2);
    await store.applyInbound({
      fromSeq: 2,
      toSeq: 4,
      events: [
        { linkSeq: 3, event: two },
        { linkSeq: 4, event: collision },
      ],
    });
    expect(applied).toEqual([one.id, two.id]);
    expect(await store.lastReceivedInbound()).toBe(4);
    await expect(
      store.applyInbound({
        fromSeq: 1,
        toSeq: 2,
        events: [{ linkSeq: 2, event: two }],
      }),
    ).rejects.toThrow(/cursor moved/);
    const conflicts = await asOwner(
      "SELECT reason, resolution, event->>'id' AS id FROM edge_sync_conflicts WHERE edge_node_id = $1",
      [primaryId],
    );
    expect(conflicts.rows).toEqual([
      {
        reason: "sequence_collision",
        resolution: "append_only",
        id: collision.id,
      },
    ]);
    await expect(
      asOwner("DELETE FROM edge_sync_conflicts WHERE edge_node_id = $1", [
        primaryId,
      ]),
    ).rejects.toThrow(/append-only/);
    const hidden = await asAppRole({ tenant: otherTenant, outlets: "*" }, (c) =>
      c.query(
        "SELECT 1 FROM edge_inbound_events UNION ALL SELECT 1 FROM edge_sync_conflicts",
      ),
    );
    expect(hidden.rows).toEqual([]);
  });

  it("legend-o839h puts the sending edge instance id in the apply meta (null when unknown)", async () => {
    const node = await authenticateEdgeCredential(primaryCredential);
    const instanceId = randomUUID();
    const metas: (string | null | undefined)[] = [];
    const make = (edgeInstanceId?: string | null) =>
      createDbLinkStore({
        database: db,
        context: node!.context,
        node: node!.scope,
        outboundDirection: "edge_to_cloud",
        edgeInstanceId,
        classify: () => "transaction_event" as const,
        applier: {
          async apply(_tx, _event, meta) {
            metas.push(meta.edgeInstanceId);
          },
        },
      });
    const aggregate = randomUUID();
    const first = await make(instanceId).lastReceivedInbound();
    await make(instanceId).applyInbound({
      fromSeq: first,
      toSeq: first + 1,
      events: [
        { linkSeq: first + 1, event: orderEvent(outletA, aggregate, 1) },
      ],
    });
    await make().applyInbound({
      fromSeq: first + 1,
      toSeq: first + 2,
      events: [
        { linkSeq: first + 2, event: orderEvent(outletA, aggregate, 2) },
      ],
    });
    expect(metas).toEqual([instanceId, null]);
  });
});
