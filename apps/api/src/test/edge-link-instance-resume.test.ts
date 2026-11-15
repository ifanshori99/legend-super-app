// Edge link resume per edge database instance (bead legend-nd3cu, tier K).
// Written from the sub-brief (docs/briefs/sub-edge-link-instance-resume.md,
// "Final design" and "Part T"), not from the implementation.
//
// Situation: the cloud keeps one `sync_cursors` row per (node, direction). When
// an edge database is rebuilt (same node id, new `edge_nodes.instance_id`),
// the cloud still holds the old cursors while the new edge restarts its link
// numbering at 0. Before this change the link was refused with 1008 ("Peer
// cursor is ahead") on every reconnect, and once the new edge had queued as
// many events as the cloud had received, its events were acked as duplicates
// and never applied. With the change the cloud rebases the numbering of the
// new instance (`peer_seq_offset`) and the link resumes.
//
// Real WebSocket link: `createEdgeLinkServer` (cloud) with the Postgres
// `createDbLinkStore` and the real appliers, and `createEdgeLinkClient`
// (edge) with an in-memory LinkStore that stands in for the edge database
// (same rules as the MemoryStore of edge-link.test.ts).
//
// Assumptions (the brief is the spec):
// - Close codes are observed by spying on `ws`'s `WebSocket.prototype.close`
//   (both peers live in this process): 1008 is LINK_CLOSE.protocol.
// - Phase 1 of the scenarios sends the three real `staff_pin.set` events of one
//   staff member (cloud received_in_seq = 3) and two cloud_to_edge events that
//   the first edge acks (acked_out_seq = 2); a third cloud_to_edge event is
//   queued while the edge is disconnected (pending, next_out_seq = 3).
// - Cursor values after the rebase follow the "Final design": edge_to_cloud
//   offset = received_in_seq before the rebuild (3), cloud_to_edge offset =
//   acked_out_seq before the rebuild (2); `peer_instance_id` = the new instance.
// - Trigger (scenario D): an offset change is allowed only when the instance
//   goes from a non-null value to a different non-null value, so null -> I
//   with a non-zero offset is refused. Refusals are asserted as "the update
//   throws and the row is unchanged", not by message.
// - Rev 2 of the design: a link whose instance differs from the bound one is
//   rebased only when the edge's hello cursor is 0 (rebuilt database); with a
//   cursor > 0 (restored/cloned database, or an old instance after a rebase) it
//   is refused with 1008 and nothing changes. A row bound to an instance also
//   refuses a link with no instance header.
// - Hello order (H): `ws.send` is spied on and hello frames are identified by
//   their `version` ("edge" / "cloud"). The edge's hello is held back by
//   gating the edge store's first `lastReceivedInbound` call, so "the cloud
//   has not sent its hello yet" is checked after a short quiet period.
// - An edge that sends no instance header is an old edge (`peer_instance_id`
//   stays NULL, offset 0) and keeps the old fail-closed behaviour.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import WebSocket from "ws";
import {
  afterAll,
  beforeAll,
  afterEach,
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
import { withTenant } from "../db/tenant.ts";
import { registerAccessEdgeApplier } from "../edge/access-applier.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
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
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  authenticateEdgeCredential,
  isEdgeNodeActive,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const actor = randomUUID();
const createdUsers: string[] = [];
const createdTenants: string[] = [];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PINS = ["482916", "730418", "915273"] as const;

/** Edge database instances (`edge_nodes.instance_id`) used by the tests. */
const I1 = randomUUID();
const I2 = randomUUID();
const J = randomUUID();

const LINK_PROTOCOL_CLOSE = 1008;

// ------------------------------------------------------------- fixtures

type Fx = {
  tenantId: string;
  outletId: string;
  roleId: string;
  tenant: ReturnType<typeof establishTenantContext>;
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
      `resume-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
      `Tenant ${label}`,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `resume-${randomBytes(3).toString("hex")}`],
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
      `RSM-${randomBytes(3).toString("hex").toUpperCase()}`,
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
    label: `Resume ${label}`,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return {
    tenantId,
    outletId,
    roleId,
    tenant,
    node,
    credential: registered.credential,
  };
}

async function newUser(fx: Fx): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Resume', $2, true, false)`,
    [id, `resume-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [fx.tenantId, id, fx.roleId, fx.outletId],
  );
  return id;
}

type PinRow = {
  pin_hash: string;
  generation_edge_node_id: string | null;
  generation_edge_instance_id: string | null;
  generation_edge_sequence: string | null;
};

async function pinRow(fx: Fx, userId: string): Promise<PinRow> {
  const { rows } = await owner.query<PinRow>(
    `SELECT pin_hash, generation_edge_node_id, generation_edge_instance_id,
            generation_edge_sequence::text AS generation_edge_sequence
       FROM staff_pins WHERE tenant_id = $1 AND user_id = $2`,
    [fx.tenantId, userId],
  );
  return rows[0]!;
}

type SetMaterial = { pinHash: string; salt: string; setAt: string };
const materialOf = (event: EventEnvelope) =>
  (event.payload as { material: SetMaterial }).material;

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

/**
 * A staff member whose cloud row is an old cloud pin (3 hours old, no edge
 * provenance), plus three real edge `staff_pin.set` events with three
 * different materials (same recipe as edge-pin-instance.test.ts).
 */
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
    [fx.tenantId, "0".repeat(64), new Date(now - 3 * HOUR), userId],
  );
  return { userId, now, s1, s2, s3 };
}

/**
 * A set as a rebuilt edge (own sequence counter, new database) would send it:
 * the staff member and aggregate of `shape`, the material of `materialFrom`,
 * a new event id, an explicit sequence and an explicit key (`setAt`).
 */
function relabel(
  shape: EventEnvelope,
  materialFrom: EventEnvelope,
  input: { sequence: number; setAtMs: number },
): EventEnvelope {
  return {
    ...shape,
    id: createUlid(Date.now()) as EventEnvelope["id"],
    sequence: input.sequence,
    occurredAt: new Date(input.setAtMs).toISOString(),
    payload: {
      ...(shape.payload as object),
      material: {
        ...materialOf(materialFrom),
        setAt: new Date(input.setAtMs).toISOString(),
      },
    } as EventEnvelope["payload"],
  };
}

let clock = Date.now();
/** A cloud -> edge event (no secrets, own aggregate, sequence 1). */
function orderEvent(fx: Fx): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: fx.tenantId as EventEnvelope["tenantId"],
    outletId: fx.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `resume-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  };
}

function enqueueToEdge(fx: Fx, event: EventEnvelope) {
  return withTenant(db, fx.node.context, (tx) =>
    enqueueEdgeEvent(tx, fx.node.context, {
      edgeNodeId: fx.node.scope.edgeNodeId,
      direction: "cloud_to_edge",
      kind: "transaction_event",
      event,
    }),
  );
}

// -------------------------------------------------- the edge database (memory)

/**
 * The edge database of one instance. Follows the rules of the Postgres store:
 * a cumulative ack cannot pass the queue head, and a received batch must start
 * exactly at the inbound cursor.
 */
class EdgeStore implements LinkStore {
  queue: QueuedEdgeEvent[] = [];
  acked = 0;
  received = 0;
  /** Every cloud -> edge event applied here, in order, with its link seq. */
  deliveries: QueuedEdgeEvent[] = [];
  /** While set, the first hello cursor read (the edge's hello) waits for it. */
  private helloGate: Promise<void> | null = null;
  holdHello() {
    let release!: () => void;
    this.helloGate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      release();
      this.helloGate = null;
    };
  }
  constructor(events: readonly EventEnvelope[] = []) {
    for (const event of events) this.push(event);
  }
  push(event: EventEnvelope) {
    this.queue.push({ linkSeq: this.queue.length + 1, event });
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
    if (upto > this.queue.length) throw new Error("ack beyond the queue");
    this.acked = Math.max(this.acked, upto);
  }
  async lastReceivedInbound() {
    if (this.helloGate) await this.helloGate;
    return this.received;
  }
  async applyInbound(input: {
    fromSeq: number;
    toSeq: number;
    events: readonly QueuedEdgeEvent[];
  }) {
    if (input.fromSeq !== this.received) throw new Error("cursor moved");
    this.deliveries.push(...input.events);
    this.received = input.toSeq;
  }
}

// ------------------------------------------------------------ cloud link

let httpServer: Server;
let linkServer: ReturnType<typeof createEdgeLinkServer>;
let url = "";
let closeSpy: MockInstance<WebSocket["close"]>;
let sendSpy: MockInstance<WebSocket["send"]>;
const liveClients: { stop(): Promise<void> }[] = [];

/** Index into the recorded `ws.close` calls; pass it to `closesSince`. */
const mark = () => closeSpy.mock.calls.length;
const closesSince = (from: number) =>
  closeSpy.mock.calls
    .slice(from)
    .map(([code, reason]) => ({ code, reason: String(reason ?? "") }));
/** Hello frames sent by either peer since `from`, as "edge" / "cloud". */
const sendMark = () => sendSpy.mock.calls.length;
const helloSendersSince = (from: number) =>
  sendSpy.mock.calls.slice(from).flatMap(([data]) => {
    try {
      const frame = JSON.parse(String(data)) as {
        type?: string;
        version?: string;
      };
      return frame.type === "hello" ? [String(frame.version)] : [];
    } catch {
      return [];
    }
  });
const protocolClosesSince = (from: number) =>
  closesSince(from).filter((c) => c.code === LINK_PROTOCOL_CLOSE);

function startEdge(
  fx: Fx,
  store: EdgeStore,
  instanceId?: string,
  onClose?: (code: number, reason: string) => void,
) {
  const client = createEdgeLinkClient({
    url,
    credential: fx.credential,
    instanceId,
    onClose,
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

// --------------------------------------------------------------- cursors

type CursorRow = {
  direction: string;
  next_out_seq: number;
  acked_out_seq: number;
  received_in_seq: number;
  peer_instance_id: string | null;
  peer_seq_offset: number;
};

async function cursorRows(fx: Fx) {
  const { rows } = await owner.query<CursorRow>(
    `SELECT direction, next_out_seq::int AS next_out_seq,
            acked_out_seq::int AS acked_out_seq,
            received_in_seq::int AS received_in_seq,
            peer_instance_id, peer_seq_offset::int AS peer_seq_offset
       FROM sync_cursors WHERE tenant_id = $1 AND edge_node_id = $2`,
    [fx.tenantId, fx.node.scope.edgeNodeId],
  );
  const byDirection = new Map(rows.map((row) => [row.direction, row]));
  return {
    e2c: byDirection.get("edge_to_cloud"),
    c2e: byDirection.get("cloud_to_edge"),
  };
}

/** Every column of the tenant's cursor rows (isolation check). */
async function allCursorColumns(fx: Fx) {
  const { rows } = await owner.query(
    `SELECT * FROM sync_cursors WHERE tenant_id = $1 ORDER BY edge_node_id, direction`,
    [fx.tenantId],
  );
  return rows;
}

async function inboundReceipts(fx: Fx, event: EventEnvelope) {
  const { rows } = await owner.query<{ outcome: string }>(
    `SELECT outcome FROM edge_inbound_events
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
        AND event_id = $3::uuid`,
    [fx.tenantId, fx.node.scope.edgeNodeId, ulidToUuid(event.id)],
  );
  return rows.map((row) => row.outcome);
}

// ------------------------------------------------------------- scenarios

/**
 * Phase 1: an edge database (instance `instanceId`, or none for an old edge)
 * sends the three `staff_pin.set` events (cloud received_in_seq = 3) and acks
 * two cloud_to_edge events; then the edge disconnects and a third cloud_to_edge
 * event is queued (pending, never delivered to this database).
 */
async function phaseOne(fx: Fx, instanceId: string | undefined) {
  const staff = await staffWithSets(fx);
  const delivered = [orderEvent(fx), orderEvent(fx)];
  for (const event of delivered) await enqueueToEdge(fx, event);

  const edge1 = new EdgeStore([staff.s1, staff.s2, staff.s3]);
  const client = startEdge(fx, edge1, instanceId);
  await eventually(async () => {
    const { e2c, c2e } = await cursorRows(fx);
    return (
      e2c?.received_in_seq === 3 &&
      c2e?.acked_out_seq === 2 &&
      edge1.acked === 3 &&
      edge1.received === 2
    );
  }, "phase 1: the first edge database is in sync");
  await stopEdge(fx, client);

  const pending = orderEvent(fx);
  await enqueueToEdge(fx, pending);
  return { ...staff, delivered, pending, edge1 };
}

/** Phase 2 of the rebuild: a fresh database (all cursors 0, instance I2). */
function rebuiltEdge(fx: Fx, staff: Awaited<ReturnType<typeof phaseOne>>) {
  // New event id, sequence 1 (own counter), newer key, material of another set.
  const newSet = relabel(staff.s2, staff.s2, {
    sequence: 1,
    setAtMs: staff.now - 5 * MINUTE,
  });
  const edge2 = new EdgeStore([newSet]);
  return { newSet, edge2 };
}

/**
 * Runs phase 2 of the rebuild to the end (fresh database, instance I2) and
 * disconnects again. Afterwards the cloud is bound to I2.
 */
async function rebaseToI2(fx: Fx, staff: Awaited<ReturnType<typeof phaseOne>>) {
  const { newSet, edge2 } = rebuiltEdge(fx, staff);
  const from = mark();
  const client = startEdge(fx, edge2, I2);
  await eventually(
    async () =>
      protocolClosesSince(from).length > 0 ||
      (edge2.acked === 1 &&
        edge2.received === 1 &&
        (await cursorRows(fx)).c2e?.acked_out_seq === 3),
    "the rebuilt edge database is in sync (or the link was refused)",
  );
  expect(protocolClosesSince(from)).toEqual([]);
  await stopEdge(fx, client);
  expect((await cursorRows(fx)).e2c).toMatchObject({
    peer_instance_id: I2,
    peer_seq_offset: 3,
  });
  return { newSet, edge2 };
}

/** Connects `store` and waits for the first 1008, then disconnects. */
async function connectUntilRefused(
  fx: Fx,
  store: EdgeStore,
  instanceId: string | undefined,
) {
  const from = mark();
  const client = startEdge(fx, store, instanceId);
  await eventually(
    () => protocolClosesSince(from).length > 0,
    "the link is refused with 1008",
    4000, // well under the 5 s ack timeout: a refusal must not hang
  );
  await stopEdge(fx, client);
  return from;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => {} });
  // Registration order of registerEdgeLink (runtime.ts).
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerAccessEdgeApplier();
  registerEdgeDeferredFallback();

  closeSpy = vi.spyOn(WebSocket.prototype, "close");
  sendSpy = vi.spyOn(WebSocket.prototype, "send");

  httpServer = createServer();
  linkServer = createEdgeLinkServer<AuthenticatedEdgeNode & EdgeLinkIdentity>(
    httpServer,
    {
      version: "cloud",
      ackTimeoutMs: 5000,
      authenticate: (token) => authenticateEdgeCredential(token),
      isActive: (identity) => isEdgeNodeActive(identity),
      // Same wiring as registerEdgeLink (runtime.ts).
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
  sendSpy?.mockRestore();
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
        "edge_link_slots",
        "edge_inbound_events",
        "edge_received_events",
        "edge_sync_conflicts",
        "edge_deferred_events",
        "edge_outbound_queue",
        "sync_cursors",
        "edge_nodes",
        "audit_logs",
        "staff_pins", // before "user"
        "role_assignments", // before "user"
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

// ------------------------------------------------------------------ tests

describe("legend-nd3cu the cloud resumes the link of a rebuilt edge database", () => {
  it("A rebuilt database (same node, new instance): the new PIN set is applied once, the pending cloud event arrives once, nothing is replayed, no 1008", async () => {
    const fx = await seedTenant("Rebuild A");
    const staff = await phaseOne(fx, I1);

    // The cloud adopted the first instance and holds the old numbering.
    const before = await cursorRows(fx);
    expect(before.e2c).toMatchObject({
      received_in_seq: 3,
      peer_instance_id: I1,
      peer_seq_offset: 0,
    });
    expect(before.c2e).toMatchObject({
      next_out_seq: 3,
      acked_out_seq: 2,
      peer_instance_id: I1,
      peer_seq_offset: 0,
    });
    const afterPhaseOne = await pinRow(fx, staff.userId);
    expect(afterPhaseOne.pin_hash).toBe(materialOf(staff.s3).pinHash);
    expect(afterPhaseOne.generation_edge_instance_id).toBe(I1);

    // Phase 2: the edge database is rebuilt (fresh store, new instance).
    const { newSet, edge2 } = rebuiltEdge(fx, staff);
    const from = mark();
    startEdge(fx, edge2, I2);
    const done = async () => {
      const { e2c, c2e } = await cursorRows(fx);
      return (
        edge2.acked === 1 &&
        edge2.received === 1 &&
        e2c?.received_in_seq === 4 &&
        c2e?.acked_out_seq === 3
      );
    };
    // A refused link (the bug) must fail on the 1008, not on a timeout.
    await eventually(
      async () => protocolClosesSince(from).length > 0 || (await done()),
      "phase 2: the rebuilt edge database is in sync (or the link was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);

    // The new PIN set was applied: new generation, new hash, exactly once.
    const pin = await pinRow(fx, staff.userId);
    expect(pin.pin_hash).toBe(materialOf(staff.s2).pinHash);
    expect(pin.generation_edge_node_id).toBe(fx.node.scope.edgeNodeId);
    expect(pin.generation_edge_instance_id).toBe(I2);
    expect(pin.generation_edge_sequence).toBe("1");
    expect(await inboundReceipts(fx, newSet)).toEqual(["applied"]);
    expect(edge2.acked).toBe(1);

    // Cloud -> edge: only the pending event, once, in the new numbering.
    // Nothing at or below the old ack (the two delivered events) is replayed.
    expect(edge2.deliveries.map((d) => [d.linkSeq, d.event.id])).toEqual([
      [1, staff.pending.id],
    ]);
    const replayed = new Set(staff.delivered.map((e) => e.id));
    expect(edge2.deliveries.some((d) => replayed.has(d.event.id))).toBe(false);

    // The cloud rebased both directions to the new instance.
    const after = await cursorRows(fx);
    expect(after.e2c).toMatchObject({
      received_in_seq: 4,
      peer_instance_id: I2,
      peer_seq_offset: 3,
    });
    expect(after.c2e).toMatchObject({
      next_out_seq: 3,
      acked_out_seq: 3,
      peer_instance_id: I2,
      peer_seq_offset: 2,
    });
  });

  it("A a reconnect of the rebuilt instance resumes without a second rebase or a duplicate apply", async () => {
    const fx = await seedTenant("Rebuild A reconnect");
    const staff = await phaseOne(fx, I1);
    const { newSet, edge2 } = rebuiltEdge(fx, staff);

    const from = mark();
    const first = startEdge(fx, edge2, I2);
    await eventually(
      async () =>
        protocolClosesSince(from).length > 0 ||
        (edge2.acked === 1 &&
          edge2.received === 1 &&
          (await cursorRows(fx)).c2e?.acked_out_seq === 3),
      "phase 2: the rebuilt edge database is in sync (or the link was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);
    await stopEdge(fx, first);

    // Same database (same store, same instance) reconnects. A further set
    // (sequence 2, same instance) and a further cloud event are sent after it.
    const second = startEdge(fx, edge2, I2);
    const nextSet = relabel(staff.s1, staff.s1, {
      sequence: 2,
      setAtMs: staff.now - 3 * MINUTE,
    });
    const nextCloud = orderEvent(fx);
    await eventually(
      async () =>
        protocolClosesSince(from).length > 0 ||
        second.state().cloudLink === "connected",
      "the rebuilt edge database reconnects",
    );
    edge2.push(nextSet);
    second.notify();
    await enqueueToEdge(fx, nextCloud);
    linkServer.notify(fx.node.scope.edgeNodeId);
    await eventually(
      async () =>
        protocolClosesSince(from).length > 0 ||
        (edge2.acked === 2 &&
          edge2.received === 2 &&
          (await cursorRows(fx)).c2e?.acked_out_seq === 4),
      "the reconnected link carries the next events (or the link was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);

    // No second rebase: the offsets are the ones of the first rebuild.
    const rows = await cursorRows(fx);
    expect(rows.e2c).toMatchObject({
      received_in_seq: 5,
      peer_instance_id: I2,
      peer_seq_offset: 3,
    });
    expect(rows.c2e).toMatchObject({
      next_out_seq: 4,
      acked_out_seq: 4,
      peer_instance_id: I2,
      peer_seq_offset: 2,
    });
    // Each event applied once, each cloud event delivered once.
    expect(await inboundReceipts(fx, newSet)).toEqual(["applied"]);
    expect(await inboundReceipts(fx, nextSet)).toEqual(["applied"]);
    expect(edge2.deliveries.map((d) => [d.linkSeq, d.event.id])).toEqual([
      [1, staff.pending.id],
      [2, nextCloud.id],
    ]);
    expect((await pinRow(fx, staff.userId)).pin_hash).toBe(
      materialOf(staff.s1).pinHash,
    );
  });

  it("B old edge without an instance header: the link is still refused with 1008 (peer cursor ahead), nothing is applied or acked, the cursors stay unrebased", async () => {
    const fx = await seedTenant("Old edge B");
    const staff = await phaseOne(fx, undefined);

    const before = await cursorRows(fx);
    expect(before.e2c).toMatchObject({
      received_in_seq: 3,
      peer_instance_id: null,
      peer_seq_offset: 0,
    });
    expect(before.c2e).toMatchObject({
      next_out_seq: 3,
      acked_out_seq: 2,
      peer_instance_id: null,
      peer_seq_offset: 0,
    });
    const pinBefore = await pinRow(fx, staff.userId);

    // A fresh database that again sends no instance.
    const { newSet, edge2 } = rebuiltEdge(fx, staff);
    const from = mark();
    const client = startEdge(fx, edge2, undefined);
    await eventually(
      () => protocolClosesSince(from).length > 0,
      "the link is refused with 1008",
    );
    await stopEdge(fx, client);

    expect(
      protocolClosesSince(from).some((c) =>
        /Peer cursor is ahead/.test(c.reason),
      ),
    ).toBe(true);
    expect(edge2.acked).toBe(0);
    expect(edge2.deliveries).toEqual([]);
    expect(await inboundReceipts(fx, newSet)).toEqual([]);
    expect(await pinRow(fx, staff.userId)).toEqual(pinBefore);

    const after = await cursorRows(fx);
    expect(after.e2c).toEqual(before.e2c);
    expect(after.c2e).toEqual(before.c2e);
  });

  it("C another tenant's node keeps every cursor column while a node is rebuilt", async () => {
    const bystander = await seedTenant("Bystander C");
    const bystanderStaff = await phaseOne(bystander, J);
    const bystanderCursors = await allCursorColumns(bystander);
    const bystanderPin = await pinRow(bystander, bystanderStaff.userId);
    expect(bystanderCursors).toHaveLength(2);

    const fx = await seedTenant("Rebuild C");
    const staff = await phaseOne(fx, I1);
    const { newSet, edge2 } = rebuiltEdge(fx, staff);
    const from = mark();
    startEdge(fx, edge2, I2);
    await eventually(
      async () =>
        protocolClosesSince(from).length > 0 ||
        (edge2.acked === 1 &&
          edge2.received === 1 &&
          (await cursorRows(fx)).c2e?.acked_out_seq === 3),
      "the rebuilt edge database is in sync (or the link was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);
    expect(await inboundReceipts(fx, newSet)).toEqual(["applied"]);

    expect(await allCursorColumns(bystander)).toEqual(bystanderCursors);
    expect(await pinRow(bystander, bystanderStaff.userId)).toEqual(
      bystanderPin,
    );
  });
});

describe("legend-nd3cu a bound database refuses links of another instance", () => {
  it("E after the rebase to I2, the old instance I1 with a cursor > 0 is refused with 1008: cursors unchanged, nothing acked or applied", async () => {
    const fx = await seedTenant("Stale instance E");
    const staff = await phaseOne(fx, I1);
    await rebaseToI2(fx, staff);

    // The old database (I1: cursors 3 / 2 > 0) has one more set to send, and
    // the cloud has one more event for the node.
    const staleSet = relabel(staff.s3, staff.s3, {
      sequence: 4,
      setAtMs: staff.now - 1 * MINUTE,
    });
    staff.edge1.push(staleSet);
    await enqueueToEdge(fx, orderEvent(fx));
    expect(staff.edge1.received).toBeGreaterThan(0);
    expect(staff.edge1.acked).toBeGreaterThan(0);

    const cursorsBefore = await allCursorColumns(fx);
    const pinBefore = await pinRow(fx, staff.userId);
    const ackedBefore = staff.edge1.acked;
    const deliveriesBefore = [...staff.edge1.deliveries];

    const from = await connectUntilRefused(fx, staff.edge1, I1);
    expect(protocolClosesSince(from).length).toBeGreaterThan(0);

    expect(await allCursorColumns(fx)).toEqual(cursorsBefore);
    expect(await pinRow(fx, staff.userId)).toEqual(pinBefore);
    expect(await inboundReceipts(fx, staleSet)).toEqual([]);
    expect(staff.edge1.acked).toBe(ackedBefore);
    expect(staff.edge1.deliveries).toEqual(deliveriesBefore);
  });

  it("F an edge without an instance header is refused with 1008 once the node is bound, nothing changes (bound by the first link, and bound by a rebase)", async () => {
    const fx = await seedTenant("No header F");
    const staff = await phaseOne(fx, I1);

    const check = async (label: string) => {
      const set = relabel(staff.s1, staff.s1, {
        sequence: 1,
        setAtMs: staff.now - 2 * MINUTE,
      });
      const store = new EdgeStore([set]);
      const cursorsBefore = await allCursorColumns(fx);
      const pinBefore = await pinRow(fx, staff.userId);
      const from = await connectUntilRefused(fx, store, undefined);
      expect(protocolClosesSince(from).length, label).toBeGreaterThan(0);
      expect(await allCursorColumns(fx), label).toEqual(cursorsBefore);
      expect(await pinRow(fx, staff.userId), label).toEqual(pinBefore);
      expect(await inboundReceipts(fx, set), label).toEqual([]);
      expect(store.acked, label).toBe(0);
      expect(store.deliveries, label).toEqual([]);
    };

    // Bound to I1 by the first link (a fresh database without header, cursor 0).
    await check("bound to I1");
    // Bound to I2 by a rebase.
    await rebaseToI2(fx, staff);
    await check("bound to I2");
  });

  it("G the refusal of a stale instance closes the socket and frees the node: the current instance connects right after and carries new events", async () => {
    const fx = await seedTenant("Refusal closes G");
    const staff = await phaseOne(fx, I1);
    const { newSet, edge2 } = await rebaseToI2(fx, staff);

    // Refused within the bound (1008 reached the peers, not the ack timeout).
    const from = await connectUntilRefused(fx, staff.edge1, I1);
    const closes = protocolClosesSince(from);
    expect(closes.length).toBeGreaterThan(0);
    await eventually(
      () => !linkServer.isConnected(fx.node.scope.edgeNodeId),
      "the cloud no longer holds the refused link",
    );
    expect(staff.edge1.acked).toBe(3);

    // The node is not stuck: I2 connects and a new set flows end to end.
    const nextSet = relabel(staff.s1, staff.s1, {
      sequence: 2,
      setAtMs: staff.now - 3 * MINUTE,
    });
    edge2.push(nextSet);
    const second = mark();
    startEdge(fx, edge2, I2);
    await eventually(
      async () =>
        protocolClosesSince(second).length > 0 ||
        (edge2.acked === 2 &&
          (await cursorRows(fx)).e2c?.received_in_seq === 5),
      "the current instance is in sync after the refusal (or was refused)",
    );
    expect(protocolClosesSince(second)).toEqual([]);
    expect(await inboundReceipts(fx, nextSet)).toEqual(["applied"]);
    expect(await inboundReceipts(fx, newSet)).toEqual(["applied"]);
    expect((await cursorRows(fx)).e2c).toMatchObject({
      peer_instance_id: I2,
      peer_seq_offset: 3,
    });
  });

  it("I unbound rows: an instance whose cloud_to_edge cursor is ahead is refused (rows stay unbound), the real instance with a valid cursor connects and binds", async () => {
    const fx = await seedTenant("Unbound ahead I");
    // An old edge (no header) leaves both rows unbound: next_out_seq 3 (N),
    // acked 2, received_in_seq 3.
    const staff = await phaseOne(fx, undefined);
    const before = await cursorRows(fx);
    expect(before.c2e).toMatchObject({
      next_out_seq: 3,
      peer_instance_id: null,
      peer_seq_offset: 0,
    });
    expect(before.e2c).toMatchObject({
      peer_instance_id: null,
      peer_seq_offset: 0,
    });
    const cursorsBefore = await allCursorColumns(fx);

    // I1 claims to have received 5 > N cloud events. Its own queue matches the
    // cloud's inbound cursor (3), so only the cloud_to_edge side is ahead.
    const stale = new EdgeStore([staff.s1, staff.s2, staff.s3]);
    stale.received = 5;
    const from = await connectUntilRefused(fx, stale, I1);
    expect(protocolClosesSince(from).some((c) => /ahead/i.test(c.reason))).toBe(
      true,
    );
    expect(stale.acked).toBe(0);
    expect(stale.deliveries).toEqual([]);
    expect(await allCursorColumns(fx)).toEqual(cursorsBefore);
    const refused = await cursorRows(fx);
    for (const row of [refused.e2c, refused.c2e])
      expect(row).toMatchObject({ peer_instance_id: null, peer_seq_offset: 0 });

    // The real instance I2 (valid cursor: received 2 <= N) connects and binds.
    const real = new EdgeStore([staff.s1, staff.s2, staff.s3]);
    real.received = 2;
    const second = mark();
    startEdge(fx, real, I2);
    await eventually(
      async () =>
        protocolClosesSince(second).length > 0 ||
        (real.received === 3 &&
          (await cursorRows(fx)).c2e?.acked_out_seq === 3),
      "the real instance is in sync (or was refused)",
    );
    expect(protocolClosesSince(second)).toEqual([]);
    expect(real.deliveries.map((d) => d.event.id)).toEqual([staff.pending.id]);
    const bound = await cursorRows(fx);
    for (const row of [bound.e2c, bound.c2e])
      expect(row).toMatchObject({ peer_instance_id: I2, peer_seq_offset: 0 });
    expect(bound.e2c?.received_in_seq).toBe(3);
  });
});

describe("legend-nd3cu hello order of the cloud", () => {
  it("H with an instance header the cloud sends its hello only after the edge hello", async () => {
    const fx = await seedTenant("Hello order H");
    const store = new EdgeStore();
    const release = store.holdHello();
    try {
      const from = sendMark();
      const client = startEdge(fx, store, I1);
      await eventually(
        () => client.state().cloudLink === "connected",
        "the edge socket is open",
      );
      // The edge hello is held back; the cloud must not hello on its own.
      await sleep(300);
      expect(helloSendersSince(from)).toEqual([]);

      release();
      await eventually(
        () => helloSendersSince(from).length >= 2,
        "both hellos were sent",
      );
      expect(helloSendersSince(from)).toEqual(["edge", "cloud"]);
      await eventually(
        async () => (await cursorRows(fx)).e2c?.peer_instance_id === I1,
        "the cloud bound the node to the instance",
      );
    } finally {
      release();
    }
  });

  it("H without an instance header (old edge) the cloud sends its hello at once, without waiting for the edge hello", async () => {
    const fx = await seedTenant("Hello order H old");
    const store = new EdgeStore();
    const release = store.holdHello();
    try {
      const from = sendMark();
      startEdge(fx, store, undefined);
      await eventually(
        () => helloSendersSince(from).includes("cloud"),
        "the cloud hello arrives while the edge hello is still held",
      );
      expect(helloSendersSince(from)).toEqual(["cloud"]);

      release();
      await eventually(
        () => helloSendersSince(from).length >= 2,
        "the edge hello follows",
      );
      expect(helloSendersSince(from)).toEqual(["cloud", "edge"]);
      expect((await cursorRows(fx)).e2c?.peer_instance_id ?? null).toBeNull();
    } finally {
      release();
    }
  });
});

describe("legend-nd3cu sync_cursors trigger guards the peer instance and offset", () => {
  async function cursorFixture(direction: "edge_to_cloud" | "cloud_to_edge") {
    const fx = await seedTenant(`Trigger ${direction}`);
    const key: unknown[] = [fx.tenantId, fx.node.scope.edgeNodeId, direction];
    await owner.query(
      `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [fx.tenantId, fx.outletId, fx.node.scope.edgeNodeId, direction],
    );
    // Cursors only move forward: raise them to 10 / 8 / 8.
    await owner.query(
      `UPDATE sync_cursors SET next_out_seq = 10, acked_out_seq = 8, received_in_seq = 8
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = $3`,
      key,
    );
    const update = (set: string, ...values: unknown[]) =>
      owner.query(
        `UPDATE sync_cursors SET ${set}
          WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = $3`,
        [...key, ...values],
      );
    const row = async () => {
      const { rows } = await owner.query(
        `SELECT next_out_seq::int AS next_out_seq, acked_out_seq::int AS acked_out_seq,
                received_in_seq::int AS received_in_seq, peer_instance_id,
                peer_seq_offset::int AS peer_seq_offset
           FROM sync_cursors WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = $3`,
        key,
      );
      return rows[0];
    };
    return { update, row };
  }

  it("D refuses an offset change under the same instance, an offset decrease, an instance reset to NULL and a cursor decrease", async () => {
    const { update, row } = await cursorFixture("edge_to_cloud");
    expect(await row()).toMatchObject({
      peer_instance_id: null,
      peer_seq_offset: 0,
    });

    // Unknown -> instance may only adopt: it cannot also carry an offset.
    await expect(
      update("peer_instance_id = $4, peer_seq_offset = 3", J),
    ).rejects.toThrow();
    expect(await row()).toMatchObject({
      peer_instance_id: null,
      peer_seq_offset: 0,
    });

    // Control: adopting the instance with offset 0 is allowed.
    await update("peer_instance_id = $4", J);
    expect(await row()).toMatchObject({
      peer_instance_id: J,
      peer_seq_offset: 0,
    });

    // The offset does not change while the instance stays the same.
    await expect(update("peer_seq_offset = 3")).rejects.toThrow();
    expect(await row()).toMatchObject({
      peer_instance_id: J,
      peer_seq_offset: 0,
    });

    // Control: J -> I with a higher offset is allowed.
    await update("peer_instance_id = $4, peer_seq_offset = 5", I1);
    const rebased = await row();
    expect(rebased).toMatchObject({ peer_instance_id: I1, peer_seq_offset: 5 });

    // Same instance, any offset change (up or down) is refused.
    await expect(update("peer_seq_offset = 6")).rejects.toThrow();
    await expect(update("peer_seq_offset = 0")).rejects.toThrow();

    // A different instance cannot bring the offset back down.
    await expect(
      update("peer_instance_id = $4, peer_seq_offset = 2", I2),
    ).rejects.toThrow();

    // The instance never goes back to NULL.
    await expect(update("peer_instance_id = NULL")).rejects.toThrow();
    await expect(
      update("peer_instance_id = NULL, peer_seq_offset = 0"),
    ).rejects.toThrow();

    // Cursors still cannot decrease (each on its own).
    await expect(update("received_in_seq = 7")).rejects.toThrow();
    await expect(update("acked_out_seq = 7")).rejects.toThrow();
    await expect(update("next_out_seq = 9")).rejects.toThrow();

    // Every refusal left the row as it was.
    expect(await row()).toEqual(rebased);
  });

  it("D allows an instance change with a higher or equal offset and forward cursor moves", async () => {
    const { update, row } = await cursorFixture("cloud_to_edge");

    await update("peer_instance_id = $4", J);
    // J -> I with a higher offset (the rebase).
    await update("peer_instance_id = $4, peer_seq_offset = 4", I1);
    expect(await row()).toMatchObject({
      peer_instance_id: I1,
      peer_seq_offset: 4,
    });

    // I -> K with the offset unchanged (the trigger allows it; the cloud only
    // does this for a rebuilt database and refuses a cursor > 0 earlier).
    await update("peer_instance_id = $4", I2);
    expect(await row()).toMatchObject({
      peer_instance_id: I2,
      peer_seq_offset: 4,
    });

    // Forward cursor moves under the same instance and offset.
    await update("next_out_seq = 12, acked_out_seq = 9, received_in_seq = 9");
    expect(await row()).toMatchObject({
      next_out_seq: 12,
      acked_out_seq: 9,
      received_in_seq: 9,
      peer_instance_id: I2,
      peer_seq_offset: 4,
    });
  });
});

describe("legend-a9iby the cloud refuses an edge database that went back in time", () => {
  /**
   * The restored database's own events after the backup: new event ids under
   * link numbers the cloud already received from the old state.
   */
  function afterRestore(staff: Awaited<ReturnType<typeof phaseOne>>) {
    return [
      relabel(staff.s2, staff.s2, {
        sequence: 2,
        setAtMs: staff.now - 4 * MINUTE,
      }),
      relabel(staff.s3, staff.s3, {
        sequence: 3,
        setAtMs: staff.now - 3 * MINUTE,
      }),
      relabel(staff.s1, staff.s1, {
        sequence: 4,
        setAtMs: staff.now - 2 * MINUTE,
      }),
    ];
  }

  async function expectRefusedUnchanged(
    fx: Fx,
    restored: EdgeStore,
    instanceId: string,
    created: readonly EventEnvelope[],
  ) {
    const cursorsBefore = await allCursorColumns(fx);
    const ackedBefore = restored.acked;
    const seenByEdge: { code: number; reason: string }[] = [];
    const from = mark();
    const client = startEdge(fx, restored, instanceId, (code, reason) =>
      seenByEdge.push({ code, reason }),
    );
    await eventually(
      () => seenByEdge.length > 0,
      "the edge sees the 1008 refusal",
      4000,
    );
    await stopEdge(fx, client);
    expect(
      protocolClosesSince(from).some((c) =>
        /older than the cloud's link cursor/i.test(c.reason),
      ),
    ).toBe(true);
    // The edge client hands the reason to the runtime, which logs it.
    expect(seenByEdge[0]).toEqual({
      code: LINK_PROTOCOL_CLOSE,
      reason:
        "Edge database is older than the cloud's link cursor (restored or cloned); refusing to resume",
    });
    // Nothing written on the cloud, nothing acked on the edge: the events the
    // restored database created stay queued there for a manual reconcile.
    expect(await allCursorColumns(fx)).toEqual(cursorsBefore);
    expect(restored.acked).toBe(ackedBefore);
    expect(restored.deliveries).toEqual([]);
    for (const event of created)
      expect(await inboundReceipts(fx, event)).toEqual([]);
  }

  it("J a restore of the same instance (behind the cloud's cloud_to_edge ack) with new events is refused with 1008: nothing acked as sent, cursors unchanged", async () => {
    const fx = await seedTenant("Restored same instance J");
    // Bound to I1: cloud received_in_seq 3 (edge_to_cloud), acked 2
    // (cloud_to_edge), a third cloud event pending.
    const staff = await phaseOne(fx, I1);
    // The backup was taken after s1 was acked and the first cloud event
    // applied. The restored database then creates three events: link 2..4.
    const created = afterRestore(staff);
    const restored = new EdgeStore([staff.s1, ...created]);
    restored.acked = 1;
    restored.received = 1;
    await expectRefusedUnchanged(fx, restored, I1, created);
    expect((await cursorRows(fx)).c2e).toMatchObject({
      peer_instance_id: I1,
      peer_seq_offset: 0,
      acked_out_seq: 2,
    });
  });

  it("J the refusal counts the rebase offset: a restore of the rebased instance I2 behind its numbering is refused, its live database still resumes", async () => {
    const fx = await seedTenant("Restored rebased J");
    const staff = await phaseOne(fx, I1);
    // I2 numbering on cloud_to_edge: acked 3 - offset 2 = 1 (the pending event).
    const { edge2 } = await rebaseToI2(fx, staff);
    expect((await cursorRows(fx)).c2e).toMatchObject({
      peer_instance_id: I2,
      peer_seq_offset: 2,
      acked_out_seq: 3,
    });
    const created = [
      relabel(staff.s3, staff.s3, {
        sequence: 2,
        setAtMs: staff.now - 2 * MINUTE,
      }),
    ];
    const restored = new EdgeStore([...edge2.queue.map((q) => q.event)]);
    restored.push(created[0]!);
    restored.acked = 1;
    restored.received = 0;
    await expectRefusedUnchanged(fx, restored, I2, created);

    // The live I2 database (received 1 = acked 3 - offset 2) is not refused.
    const second = mark();
    const client = startEdge(fx, edge2, I2);
    await eventually(
      () => linkServer.isConnected(fx.node.scope.edgeNodeId),
      "the live instance connects",
    );
    await sleep(300);
    expect(protocolClosesSince(second)).toEqual([]);
    await stopEdge(fx, client);
  });

  it("J unbound rows: an instance-bearing edge whose cloud_to_edge cursor is behind the cloud's ack is refused and the rows stay unbound", async () => {
    const fx = await seedTenant("Restored unbound J");
    // An old edge (no header) leaves both rows unbound with acked 2.
    const staff = await phaseOne(fx, undefined);
    const created = afterRestore(staff);
    const restored = new EdgeStore([staff.s1, ...created]);
    restored.acked = 1;
    restored.received = 1;
    await expectRefusedUnchanged(fx, restored, I1, created);
    const rows = await cursorRows(fx);
    for (const row of [rows.e2c, rows.c2e])
      expect(row).toMatchObject({ peer_instance_id: null, peer_seq_offset: 0 });
  });
});
