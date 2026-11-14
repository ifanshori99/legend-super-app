// legend-tmar2 / 854 (docs/briefs/854-edge-proof-fail-closed.md, "Test gagal-dulu"
// c and d): the cloud db link store against real Postgres.
//
// c. A receipt hole at slot s: inboundProof returns the proven PREFIX
//    (to = s-1) instead of null; a replayed batch carrying the event that is
//    registered for slot s writes a 'superseded' receipt and is acked; the next
//    inboundProof covers the slot completely.
// d. A replayed batch carrying a NEW (unregistered) event in a slot <= the
//    cloud cursor is refused with a LinkProtocolError; no ack, no receipt.
//
// Assumptions:
// - inboundProof returns { to, count, sha256 }; k = 0 gives to = from and the
//   digest of the empty list; null only when to < from (design point 2).
// - reconcileReplay input events are in EDGE numbering (design point 6); the
//   store adds the peer offset itself. These runs use no rebase (offset 0).
// - A refusal reason mentions "Restore proof" and the slot (design point 6).
// - End to end the real ws link is used with the same in-memory edge database
//   as edge-link-restore-proof-db.test.ts (rows stay after an ack).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { Pool } from "pg";
import WebSocket from "ws";
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
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { registerAccessEdgeApplier } from "../edge/access-applier.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { logger } from "../lib/logger.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import type { LinkStore, QueuedEdgeEvent } from "../edge/link-peer.ts";
import {
  createEdgeLinkServer,
  type EdgeLinkIdentity,
} from "../edge/link-server.ts";
import { restoreProofOf } from "../edge/protocol.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  authenticateEdgeCredential,
  isEdgeNodeActive,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const createdUsers: string[] = [];
const createdTenants: string[] = [];

const MINUTE = 60_000;
const PINS = ["482916", "730418", "915273"] as const;
const I1 = randomUUID();
const LINK_PROTOCOL_CLOSE = 1008;

type Proof = { count: number; sha256: string };
const uuidOf = (event: EventEnvelope) => ulidToUuid(event.id);
const proofOfEvents = (events: readonly EventEnvelope[]): Proof =>
  restoreProofOf(events.map(uuidOf));

type Fx = {
  tenantId: string;
  outletId: string;
  roleId: string;
  tenant: ReturnType<typeof establishTenantContext>;
  scope: ScopedTenantContext;
  node: AuthenticatedEdgeNode;
  credential: string;
};

async function seedTenant(label: string): Promise<Fx> {
  const tenantId = randomUUID();
  const outletId = randomUUID();
  const roleId = randomUUID();
  const brand = randomUUID();
  const entity = randomUUID();
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  const scope: ScopedTenantContext = establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
  createdTenants.push(tenantId);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $5, plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `r854-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
      `Tenant ${label}`,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `r854-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
    [
      outletId,
      tenantId,
      brand,
      entity,
      `R85-${randomBytes(3).toString("hex").toUpperCase()}`,
    ],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'cashier'`,
    [roleId, tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  if (role.rowCount !== 1) throw new Error("No cashier role template");
  const registered = await registerEdgeNode(scope, actor, {
    outletId,
    role: "primary",
    label: `R854 ${label}`,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return {
    tenantId,
    outletId,
    roleId,
    tenant,
    scope,
    node,
    credential: registered.credential,
  };
}

async function newUser(fx: Fx): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf R854', $2, true, false)`,
    [id, `r854-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [fx.tenantId, id, fx.roleId, fx.outletId],
  );
  return id;
}

async function asEdge<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
}

/** Three real edge `staff_pin.set` events of one staff member. */
async function staffWithSets(fx: Fx) {
  const userId = await newUser(fx);
  const now = Date.now();
  for (const [index, pin] of PINS.entries())
    await asEdge(() =>
      setStaffPin(
        fx.tenant,
        userId,
        { outletId: fx.outletId, userId },
        { pin },
        { now: new Date(now - (30 - index) * MINUTE) },
      ),
    );
  const { rows } = await owner.query<{ event: EventEnvelope }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'staff_pin'
        AND event->>'name' = 'staff_pin.set' AND event->'payload'->>'userId' = $2
      ORDER BY sequence`,
    [fx.tenantId, userId],
  );
  const [s1, s2, s3] = rows.map((row) => row.event);
  if (!s1 || !s2 || !s3) throw new Error("Expected three set events");
  await owner.query(
    `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3,
            generation_edge_node_id = NULL, generation_edge_sequence = NULL,
            generation_edge_instance_id = NULL,
            failed_attempts = 0, locked_until = NULL
      WHERE tenant_id = $1 AND user_id = $4`,
    [fx.tenantId, "0".repeat(64), new Date(now - 3 * 60 * MINUTE), userId],
  );
  return { userId, s1, s2, s3 };
}

let clock = Date.now();
/** An event the cloud has never seen (unsent panic alert on the edge). */
function panicEvent(fx: Fx): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: fx.tenantId as EventEnvelope["tenantId"],
    outletId: fx.outletId as EventEnvelope["outletId"],
    name: "panic.alert_raised",
    version: 1,
    aggregateType: "panic",
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `r854-${clock}`,
    payloadSchemaRef: "panic.alert_raised.v1",
    payload: {},
  };
}

/** The edge database: rows stay after an ack (only the status flips). */
class EdgeStore implements LinkStore {
  queue: QueuedEdgeEvent[] = [];
  status: ("pending" | "acked")[] = [];
  acked: number;
  received: number;
  ackCalls: number[] = [];
  constructor(
    events: readonly EventEnvelope[],
    state: { acked: number; received: number },
  ) {
    events.forEach((event, index) => {
      this.queue.push({ linkSeq: index + 1, event });
      this.status.push(index < state.acked ? "acked" : "pending");
    });
    this.acked = state.acked;
    this.received = state.received;
  }
  async outboundHead() {
    return this.queue.length;
  }
  async lastAckedOutbound() {
    return this.acked;
  }
  async readOutbound(after: number, limit: number) {
    return this.queue.filter((q) => q.linkSeq > after).slice(0, limit);
  }
  async ackOutbound(upto: number) {
    this.ackCalls.push(upto);
    if (upto > this.queue.length) throw new Error("ack beyond the queue");
    this.acked = Math.max(this.acked, upto);
    for (let i = 0; i < this.queue.length; i++)
      if (this.queue[i]!.linkSeq <= upto) this.status[i] = "acked";
  }
  async lastReceivedInbound() {
    return this.received;
  }
  async applyInbound(input: {
    fromSeq: number;
    toSeq: number;
    events: readonly QueuedEdgeEvent[];
  }) {
    if (input.fromSeq !== this.received) throw new Error("cursor moved");
    this.received = input.toSeq;
  }
  async outboundProof(fromSeq: number, toSeq: number): Promise<Proof> {
    return restoreProofOf(
      this.queue
        .filter((q) => q.linkSeq > fromSeq && q.linkSeq <= toSeq)
        .map((q) => uuidOf(q.event)),
    );
  }
  pendingSlots() {
    return this.queue
      .filter((_, i) => this.status[i] === "pending")
      .map((q) => q.linkSeq);
  }
}

let httpServer: Server;
let linkServer: ReturnType<typeof createEdgeLinkServer>;
let url = "";
let closeSpy: MockInstance<WebSocket["close"]>;
const liveClients: { stop(): Promise<void> }[] = [];

const mark = () => closeSpy.mock.calls.length;
const protocolClosesSince = (from: number) =>
  closeSpy.mock.calls
    .slice(from)
    .map(([code, reason]) => ({ code, reason: String(reason ?? "") }))
    .filter((c) => c.code === LINK_PROTOCOL_CLOSE);

function startEdge(fx: Fx, store: EdgeStore, instanceId: string) {
  const client = createEdgeLinkClient({
    url,
    credential: fx.credential,
    instanceId,
    scope: fx.node.scope,
    store,
    version: "edge",
    random: () => 0,
    ackTimeoutMs: 5000,
  });
  liveClients.push(client);
  return client;
}

async function stopEdge(fx: Fx, client: { stop(): Promise<void> }) {
  await client.stop();
  await eventually(
    () => !linkServer.isConnected(fx.node.scope.edgeNodeId),
    "the cloud sees the edge disconnected",
  );
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 20_000,
) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const cloudStore = (fx: Fx, edgeInstanceId: string) =>
  createDbLinkStore({
    database: db,
    context: fx.node.context,
    node: fx.node.scope,
    edgeInstanceId,
    outboundDirection: "cloud_to_edge",
  });

async function receiptRows(fx: Fx) {
  const { rows } = await owner.query<{
    link_seq: string;
    outcome: string;
    event_id: string;
  }>(
    `SELECT link_seq::text AS link_seq, outcome, event_id::text AS event_id
       FROM edge_inbound_events
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
      ORDER BY link_seq`,
    [fx.tenantId, fx.node.scope.edgeNodeId],
  );
  return rows;
}

async function receivedInSeq(fx: Fx) {
  const { rows } = await owner.query<{ received_in_seq: number }>(
    `SELECT received_in_seq::int AS received_in_seq FROM sync_cursors
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
    [fx.tenantId, fx.node.scope.edgeNodeId],
  );
  return rows[0]?.received_in_seq;
}

/** Remove the receipt of one slot (a hole in the cloud history). */
async function dropReceipt(fx: Fx, linkSeq: number) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM edge_inbound_events WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND link_seq = $3`,
      [fx.tenantId, fx.node.scope.edgeNodeId, linkSeq],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Three real staff_pin.set events delivered (cloud received_in_seq = 3). */
async function threeDelivered(label: string) {
  const fx = await seedTenant(label);
  const staff = await staffWithSets(fx);
  const edge = new EdgeStore([staff.s1, staff.s2, staff.s3], {
    acked: 0,
    received: 0,
  });
  const client = startEdge(fx, edge, I1);
  await eventually(
    async () => edge.acked === 3 && (await receivedInSeq(fx)) === 3,
    "three sets delivered",
  );
  await stopEdge(fx, client);
  expect((await receiptRows(fx)).map((r) => r.link_seq)).toEqual([
    "1",
    "2",
    "3",
  ]);
  return { fx, staff };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => {} });
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerAccessEdgeApplier();
  registerEdgeDeferredFallback();

  closeSpy = vi.spyOn(WebSocket.prototype, "close");

  httpServer = createServer();
  linkServer = createEdgeLinkServer<AuthenticatedEdgeNode & EdgeLinkIdentity>(
    httpServer,
    {
      version: "cloud",
      ackTimeoutMs: 5000,
      authenticate: (token) => authenticateEdgeCredential(token),
      isActive: (identity) => isEdgeNodeActive(identity),
      storeFor: (identity) =>
        createDbLinkStore({
          database: db,
          context: identity.context,
          node: identity.scope,
          edgeInstanceId: identity.edgeInstanceId,
          outboundDirection: "cloud_to_edge",
        }),
    },
  );
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api/edge-link`;
});

afterEach(async () => {
  delete process.env.EDGE_MODE;
  while (liveClients.length > 0) await liveClients.pop()!.stop();
});

afterAll(async () => {
  closeSpy?.mockRestore();
  await linkServer?.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const tenantId of createdTenants) {
      for (const table of [
        "domain_event_outbox",
        "edge_inbound_events",
        "edge_received_events",
        "edge_sync_conflicts",
        "edge_deferred_events",
        "edge_outbound_queue",
        "sync_cursors",
        "edge_nodes",
        "audit_logs",
        "staff_pins",
        "role_assignments",
        "roles",
        "outlets",
        "legal_entities",
        "brands",
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenantId,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    }
    if (createdUsers.length > 0)
      await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
        createdUsers,
      ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-tmar2 854 c. a receipt hole gives a proven prefix, replay closes the hole", () => {
  it("c. inboundProof returns the prefix before the hole (to = s-1), not null", async () => {
    const { fx, staff } = await threeDelivered("854 prefix");
    const cloud = cloudStore(fx, I1);
    const empty = restoreProofOf([]);
    // Complete range: the whole range, to = N.
    expect(await cloud.inboundProof!(0, 3)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s1, staff.s2, staff.s3]),
    });

    await dropReceipt(fx, 2); // hole at slot 2
    expect(await cloud.inboundProof!(0, 3)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });
    // Hole right after `from`: an empty proof, to = from.
    expect(await cloud.inboundProof!(1, 3)).toEqual({ to: 1, ...empty });
    // A range ending before the hole is still fully provable.
    expect(await cloud.inboundProof!(0, 1)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });
    // Starting after the hole, slot 3 is provable again.
    expect(await cloud.inboundProof!(2, 3)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s3]),
    });
    // Beyond the receipts held: the prefix of what exists, not null.
    expect(await cloud.inboundProof!(0, 20_001)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });
    // Only a reversed range cannot be proven.
    expect(await cloud.inboundProof!(3, 2)).toBeNull();
  });

  it("c. reconcileReplay writes a 'superseded' receipt for a registered event in the hole; the next inboundProof is complete", async () => {
    const { fx, staff } = await threeDelivered("854 reconcile");
    const cloud = cloudStore(fx, I1);
    await dropReceipt(fx, 2);
    expect((await receiptRows(fx)).map((r) => r.link_seq)).toEqual(["1", "3"]);

    await cloud.reconcileReplay!({
      events: [
        { linkSeq: 2, event: staff.s2 },
        { linkSeq: 3, event: staff.s3 },
      ],
    });
    const rows = await receiptRows(fx);
    expect(rows.map((r) => r.link_seq)).toEqual(["1", "2", "3"]);
    expect(rows.find((r) => r.link_seq === "2")).toMatchObject({
      outcome: "superseded",
      event_id: uuidOf(staff.s2),
    });
    // The other receipts are untouched; the cursor did not move.
    expect(rows.find((r) => r.link_seq === "3")!.event_id).toBe(
      uuidOf(staff.s3),
    );
    expect(await receivedInSeq(fx)).toBe(3);
    // Next round: the whole range is provable.
    expect(await cloud.inboundProof!(0, 3)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s1, staff.s2, staff.s3]),
    });
    // Replaying the same slots again is a no-op (ON CONFLICT DO NOTHING).
    await cloud.reconcileReplay!({
      events: [{ linkSeq: 2, event: staff.s2 }],
    });
    expect((await receiptRows(fx)).map((r) => r.link_seq)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("c. end to end: a restored edge with an empty proof resends, the hole closes, everything is acked without a refusal", async () => {
    const { fx, staff } = await threeDelivered("854 e2e heal");
    await dropReceipt(fx, 2);
    // Restored database: same events, acked 1 (the backup was taken then).
    const restored = new EdgeStore([staff.s1, staff.s2, staff.s3], {
      acked: 1,
      received: 0,
    });
    const from = mark();
    startEdge(fx, restored, I1);
    await eventually(
      () => protocolClosesSince(from).length > 0 || restored.acked === 3,
      "the edge acked slot 3 (or was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);
    expect(restored.acked).toBe(3);
    // Nothing was acked before the hole was closed: the first ack is the
    // resent range, never a jump past slot 1 on the hello alone.
    expect(restored.ackCalls[0]).toBeGreaterThan(1);
    const rows = await receiptRows(fx);
    expect(rows.map((r) => r.link_seq)).toEqual(["1", "2", "3"]);
    expect(rows.find((r) => r.link_seq === "2")!.outcome).toBe("superseded");
    expect(await receivedInSeq(fx)).toBe(3);
  });
});

describe("legend-tmar2 854 d. a replayed new event is refused, never acked", () => {
  it("d. reconcileReplay throws for an unregistered event in a hole and writes no receipt", async () => {
    const { fx, staff } = await threeDelivered("854 reconcile new");
    const cloud = cloudStore(fx, I1);
    await dropReceipt(fx, 2);
    const intruder = panicEvent(fx);
    await expect(
      cloud.reconcileReplay!({
        events: [
          { linkSeq: 2, event: intruder },
          { linkSeq: 3, event: staff.s3 },
        ],
      }),
    ).rejects.toThrow(/Restore proof.*replayed slot 2.*different event/i);
    // One transaction: no receipt for the hole, none for the intruder.
    expect((await receiptRows(fx)).map((r) => r.link_seq)).toEqual(["1", "3"]);
    expect(
      (await receiptRows(fx)).some((r) => r.event_id === uuidOf(intruder)),
    ).toBe(false);
    expect(await receivedInSeq(fx)).toBe(3);
  });

  it("d. reconcileReplay throws when a slot holds a receipt of ANOTHER event; nothing is written", async () => {
    const { fx, staff } = await threeDelivered("854 reconcile other");
    const cloud = cloudStore(fx, I1);
    const before = await receiptRows(fx);
    await expect(
      cloud.reconcileReplay!({
        events: [
          { linkSeq: 1, event: staff.s1 },
          { linkSeq: 2, event: staff.s3 }, // slot 2 holds s2
        ],
      }),
    ).rejects.toThrow(/Restore proof.*replayed slot 2/i);
    expect(await receiptRows(fx)).toEqual(before);
  });

  it("d. reconcileReplay refuses a registered event replayed into a slot that holds another event's receipt", async () => {
    // s2 is registered, but slot 3 holds the receipt of s3.
    const { fx, staff } = await threeDelivered("854 reconcile moved");
    const cloud = cloudStore(fx, I1);
    await expect(
      cloud.reconcileReplay!({
        events: [{ linkSeq: 3, event: staff.s2 }],
      }),
    ).rejects.toThrow(/Restore proof.*replayed slot 3/i);
  });

  it("d. end to end: a new panic alert in the hole slot is not acked, no receipt, the link is refused", async () => {
    const { fx, staff } = await threeDelivered("854 e2e panic");
    await dropReceipt(fx, 2);
    const panic = panicEvent(fx);
    const restored = new EdgeStore([staff.s1, panic, staff.s3], {
      acked: 1,
      received: 0,
    });
    const from = mark();
    const client = startEdge(fx, restored, I1);
    await eventually(
      () => protocolClosesSince(from).length > 0,
      "the replay of the hole slot is refused with 1008",
      5000,
    );
    await stopEdge(fx, client);
    expect(
      protocolClosesSince(from).some((c) => /restore proof/i.test(c.reason)),
    ).toBe(true);
    // Never acked without being sent and accepted: the panic stays pending.
    expect(restored.ackCalls).toEqual([]);
    expect(restored.acked).toBe(1);
    expect(restored.pendingSlots()).toEqual([2, 3]);
    expect(restored.queue[1]!.event.id).toBe(panic.id);
    const rows = await receiptRows(fx);
    expect(rows.map((r) => r.link_seq)).toEqual(["1", "3"]);
    expect(rows.some((r) => r.event_id === uuidOf(panic))).toBe(false);
    expect(await receivedInSeq(fx)).toBe(3);
  });
});

// 854 Revisi 2 (R2.2, R2.3). Assumptions: a receipt whose event is NOT in
// edge_received_events (dead letter) does not hold its slot, like in
// inboundProof (rule R3); the primary key of edge_inbound_events is
// (tenant, node, direction, event_id), so a slot may hold several receipts and
// the same event cannot get a second receipt. A swallowed ON CONFLICT is logged
// with logger.warn whose text mentions "conflict" (the brief: "(conflict)
// dicatat ... hitungan di pesan").
describe("legend-tmar2 854 R2.2 an unregistered receipt does not hold the slot", () => {
  /** A dead-letter style receipt: in edge_inbound_events, not in edge_received_events. */
  async function insertUnregisteredReceipt(fx: Fx, linkSeq: number) {
    await owner.query(
      `INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome)
       VALUES ($1, $2, $3, 'edge_to_cloud', $4::uuid, $5, 'order', $6, 1, 'transaction_event', 'applied')`,
      [
        fx.tenantId,
        fx.outletId,
        fx.node.scope.edgeNodeId,
        randomUUID(),
        linkSeq,
        randomUUID(),
      ],
    );
  }

  it("R2.2 reconcileReplay: the registered event replayed into a slot that only holds an unregistered receipt gets a 'superseded' receipt; the next proof is complete", async () => {
    const { fx, staff } = await threeDelivered("854 r2.2 reconcile");
    const cloud = cloudStore(fx, I1);
    await dropReceipt(fx, 2);
    await insertUnregisteredReceipt(fx, 2);
    // The unregistered receipt does not count: the proof stops before slot 2.
    expect(await cloud.inboundProof!(0, 3)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });

    await cloud.reconcileReplay!({
      events: [
        { linkSeq: 2, event: staff.s2 },
        { linkSeq: 3, event: staff.s3 },
      ],
    });
    const rows = await receiptRows(fx);
    expect(
      rows.find((r) => r.link_seq === "2" && r.event_id === uuidOf(staff.s2)),
    ).toMatchObject({ outcome: "superseded" });
    expect(await cloud.inboundProof!(0, 3)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s1, staff.s2, staff.s3]),
    });
  });

  it("R2.2 end to end: a restored edge heals a hole that holds an unregistered receipt, everything is acked without a refusal", async () => {
    const { fx, staff } = await threeDelivered("854 r2.2 e2e");
    await dropReceipt(fx, 2);
    await insertUnregisteredReceipt(fx, 2);
    const restored = new EdgeStore([staff.s1, staff.s2, staff.s3], {
      acked: 1,
      received: 0,
    });
    const from = mark();
    startEdge(fx, restored, I1);
    await eventually(
      () => protocolClosesSince(from).length > 0 || restored.acked === 3,
      "the edge acked slot 3 (or was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);
    expect(restored.acked).toBe(3);
    const rows = await receiptRows(fx);
    expect(
      rows.find((r) => r.link_seq === "2" && r.event_id === uuidOf(staff.s2)),
    ).toMatchObject({ outcome: "superseded" });
  });
});

describe("legend-tmar2 854 R2.3 a swallowed ON CONFLICT is logged", () => {
  /** Move the receipt of one event to another slot (the event keeps its receipt, the old slot is a hole). */
  async function moveReceipt(fx: Fx, eventUuid: string, linkSeq: number) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE edge_inbound_events SET link_seq = $4
          WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND event_id = $3::uuid`,
        [fx.tenantId, fx.node.scope.edgeNodeId, eventUuid, linkSeq],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const logged = (warn: MockInstance) =>
    warn.mock.calls.map((call) => inspect(call, { depth: 4 })).join("\n");

  it("R2.3 the event already has a receipt in another slot: the insert is a no-op and logger.warn records the conflict", async () => {
    const { fx, staff } = await threeDelivered("854 r2.3 conflict");
    const cloud = cloudStore(fx, I1);
    await moveReceipt(fx, uuidOf(staff.s2), 5); // slot 2 is a hole, s2 has a receipt at 5
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      // Whether it then accepts or refuses is not pinned; the conflict must be logged.
      await cloud.reconcileReplay!({
        events: [{ linkSeq: 2, event: staff.s2 }],
      }).catch(() => undefined);
      expect(logged(warn)).toMatch(/conflict/i);
      // No secrets: the log never carries the event payload or the credential.
      expect(logged(warn)).not.toContain(fx.credential);
    } finally {
      warn.mockRestore();
    }
  });

  it("R2.3 a normal heal (insert succeeds) logs no conflict", async () => {
    const { fx, staff } = await threeDelivered("854 r2.3 clean");
    const cloud = cloudStore(fx, I1);
    await dropReceipt(fx, 2);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await cloud.reconcileReplay!({
        events: [{ linkSeq: 2, event: staff.s2 }],
      });
      expect(logged(warn)).not.toMatch(/conflict/i);
    } finally {
      warn.mockRestore();
    }
  });
});
