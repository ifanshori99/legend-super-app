// legend-tmar2 (848 design, docs/briefs/848-design.md): restore proof against
// real Postgres. Written from the design, not from the implementation.
//
// (1) db-link-store `outboundProof` / `inboundProof` cover the range (A, N] in
//     EDGE numbering, also when the cloud rebased the node (peer_seq_offset != 0).
// (2) A standby that re-sends event ids the cloud already took from the
//     primary (a skip, not an apply, on edge_to_cloud) still gets one receipt
//     per link slot, so the cloud digest matches the edge digest.
// (3) Real WebSocket link: an edge database restored with different events in
//     the slots (acked, N] is refused, nothing is acked, the events stay
//     pending (a panic alert there must never be marked acked unsent).
//
// Assumptions:
// - Digest rule (design point 2): SHA-256 over `uuidLowercase + "\n"` per event
//   in ascending link order; `restoreProofOf` from protocol.ts is the oracle.
//   The empty range gives `restoreProofOf([])` (count 0).
// - The edge database of the ws scenarios is an in-memory LinkStore that keeps
//   a status per slot (ackOutbound only flips the status; rows stay), like the
//   Postgres edge store; its `outboundProof` reads the slots in (from, to].
// - The edge store test of (1) runs in its own tenant without a rebase (an edge
//   database has no peer offset of its own).
// - The mismatch refusal is a 1008 close whose reason mentions "restore proof"
//   (design point 5: LinkProtocolError "Restore proof mismatch ...").
// - The standby is a second node of the same outlet (role "standby"); its
//   receipts are read through the cloud db store of that node.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
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
const S1 = randomUUID();

const LINK_PROTOCOL_CLOSE = 1008;

type Proof = { count: number; sha256: string };
const uuidOf = (event: EventEnvelope) => ulidToUuid(event.id);
const proofOfEvents = (events: readonly EventEnvelope[]): Proof =>
  restoreProofOf(events.map(uuidOf));
/** inboundProof result shape (854): the proven prefix ends at `to`. */
const proofTo = (to: number, proof: Proof) => ({ to, ...proof });

// ------------------------------------------------------------- fixtures

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
      `rproof-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
      `Tenant ${label}`,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `rproof-${randomBytes(3).toString("hex")}`],
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
      `RPF-${randomBytes(3).toString("hex").toUpperCase()}`,
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
    label: `Proof ${label}`,
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

/** A second node of the same outlet (role standby), own credential. */
async function addStandby(fx: Fx): Promise<Fx> {
  const registered = await registerEdgeNode(fx.scope, actor, {
    outletId: fx.outletId,
    role: "standby",
    label: "Proof standby",
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Standby node did not authenticate");
  return { ...fx, node, credential: registered.credential };
}

async function newUser(fx: Fx): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Proof', $2, true, false)`,
    [id, `rproof-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [fx.tenantId, id, fx.roleId, fx.outletId],
  );
  return id;
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

/** Three real edge `staff_pin.set` events of one staff member (as in edge-link-instance-resume). */
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

/** A set with a new event id, explicit sequence and key (`setAt`). */
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
/** An event with no secrets, own aggregate, sequence 1. */
function plainEvent(fx: Fx, name = "order.item_added"): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: fx.tenantId as EventEnvelope["tenantId"],
    outletId: fx.outletId as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.split(".")[0] ?? "order",
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `rproof-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {},
  };
}

function enqueue(
  fx: Fx,
  direction: "cloud_to_edge" | "edge_to_cloud",
  event: EventEnvelope,
) {
  return withTenant(db, fx.node.context, (tx) =>
    enqueueEdgeEvent(tx, fx.node.context, {
      edgeNodeId: fx.node.scope.edgeNodeId,
      direction,
      kind: "transaction_event",
      event,
    }),
  );
}

// -------------------------------------------------- the edge database (memory)

/**
 * The edge database of one instance. Rows stay after an ack (only the status
 * flips), a cumulative ack cannot pass the queue head, a received batch starts
 * at the inbound cursor.
 */
class EdgeStore implements LinkStore {
  queue: QueuedEdgeEvent[] = [];
  status: ("pending" | "acked")[] = [];
  acked = 0;
  received = 0;
  ackCalls: number[] = [];
  deliveries: QueuedEdgeEvent[] = [];
  constructor(events: readonly EventEnvelope[] = []) {
    for (const event of events) this.push(event);
  }
  push(event: EventEnvelope) {
    this.queue.push({ linkSeq: this.queue.length + 1, event });
    this.status.push("pending");
  }
  /** A database that was backed up with the first `acked` slots acked. */
  static restored(
    events: readonly EventEnvelope[],
    state: { acked: number; received: number },
  ) {
    const store = new EdgeStore(events);
    store.acked = state.acked;
    store.received = state.received;
    for (let i = 0; i < state.acked; i++) store.status[i] = "acked";
    return store;
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
    this.deliveries.push(...input.events);
    this.received = input.toSeq;
  }
  /** Edge numbering, rows present in (from, to], ascending link_seq. */
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

// ------------------------------------------------------------ cloud link

let httpServer: Server;
let linkServer: ReturnType<typeof createEdgeLinkServer>;
let url = "";
let closeSpy: MockInstance<WebSocket["close"]>;
const liveClients: { stop(): Promise<void> }[] = [];

const mark = () => closeSpy.mock.calls.length;
const closesSince = (from: number) =>
  closeSpy.mock.calls
    .slice(from)
    .map(([code, reason]) => ({ code, reason: String(reason ?? "") }));
const protocolClosesSince = (from: number) =>
  closesSince(from).filter((c) => c.code === LINK_PROTOCOL_CLOSE);

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

const cloudStore = (
  fx: Fx,
  edgeInstanceId: string,
  outboundDirection: "cloud_to_edge" | "edge_to_cloud" = "cloud_to_edge",
) =>
  createDbLinkStore({
    database: db,
    context: fx.node.context,
    node: fx.node.scope,
    edgeInstanceId,
    outboundDirection,
  });

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
    [fx.tenantId, fx.node.scope.edgeNodeId, uuidOf(event)],
  );
  return rows.map((row) => row.outcome);
}

// ------------------------------------------------------------- scenarios

/**
 * An edge database (instance `instanceId`) sends the three real
 * `staff_pin.set` events (cloud received_in_seq = 3) and acks two cloud_to_edge
 * events; then it disconnects and a third cloud_to_edge event is queued.
 */
async function phaseOne(fx: Fx, instanceId: string) {
  const staff = await staffWithSets(fx);
  const delivered = [plainEvent(fx), plainEvent(fx)];
  for (const event of delivered) await enqueue(fx, "cloud_to_edge", event);

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

  const pending = plainEvent(fx);
  await enqueue(fx, "cloud_to_edge", pending);
  return { ...staff, delivered, pending, edge1 };
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

describe("legend-tmar2 db-link-store proofs cover (A, N] in edge numbering", () => {
  it("1 inboundProof and outboundProof match the range after a rebase (peer_seq_offset != 0)", async () => {
    const fx = await seedTenant("Proof offset 1");
    const staff = await phaseOne(fx, I1);

    // Rebuilt edge database (instance I2, own numbering from 0): rebase.
    const newSet = relabel(staff.s2, staff.s2, {
      sequence: 1,
      setAtMs: staff.now - 5 * MINUTE,
    });
    const edge2 = new EdgeStore([newSet]);
    const first = startEdge(fx, edge2, I2);
    await eventually(
      async () =>
        edge2.acked === 1 &&
        edge2.received === 1 &&
        (await cursorRows(fx)).c2e?.acked_out_seq === 3,
      "the rebuilt edge database is in sync",
    );
    await stopEdge(fx, first);

    // More traffic in the new numbering: three sets (edge slots 2..4) and one
    // more cloud event (edge slot 2 on cloud_to_edge).
    const more = [
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
    for (const event of more) edge2.push(event);
    const nextCloud = plainEvent(fx);
    await enqueue(fx, "cloud_to_edge", nextCloud);
    const second = startEdge(fx, edge2, I2);
    await eventually(async () => {
      const { e2c, c2e } = await cursorRows(fx);
      return (
        edge2.acked === 4 &&
        edge2.received === 2 &&
        e2c?.received_in_seq === 7 &&
        c2e?.acked_out_seq === 4
      );
    }, "the rebuilt edge database carries the next events");
    await stopEdge(fx, second);
    const cursors = await cursorRows(fx);
    expect(cursors.e2c).toMatchObject({
      peer_instance_id: I2,
      peer_seq_offset: 3,
    });
    expect(cursors.c2e).toMatchObject({
      peer_instance_id: I2,
      peer_seq_offset: 2,
    });

    const cloud = cloudStore(fx, I2);
    const edgeEvents = [newSet, ...more]; // edge slots 1..4
    // Cloud receipts (edge numbering, offset 3 hidden inside the store).
    expect(await cloud.inboundProof!(0, 4)).toEqual(
      proofTo(4, proofOfEvents(edgeEvents)),
    );
    expect(await cloud.inboundProof!(1, 4)).toEqual(
      proofTo(4, proofOfEvents(edgeEvents.slice(1))),
    );
    expect(await cloud.inboundProof!(2, 3)).toEqual(
      proofTo(3, proofOfEvents([edgeEvents[2]!])),
    );
    // The first slot is the new instance's event, not the old instance's s1.
    expect(await cloud.inboundProof!(0, 1)).toEqual(
      proofTo(1, proofOfEvents([newSet])),
    );
    expect(await cloud.inboundProof!(0, 1)).not.toEqual(
      proofTo(1, proofOfEvents([staff.s1])),
    );
    expect(await cloud.inboundProof!(4, 4)).toEqual(
      proofTo(4, restoreProofOf([])),
    );
    // Same range, same digest as the edge computes from its own queue.
    expect(await cloud.inboundProof!(1, 4)).toEqual(
      proofTo(4, await edge2.outboundProof(1, 4)),
    );

    // Cloud outbound queue (cloud_to_edge, offset 2): edge slot 1 = the event
    // that was pending at the rebuild, slot 2 = nextCloud.
    expect(await cloud.outboundProof!(0, 2)).toEqual(
      proofOfEvents([staff.pending, nextCloud]),
    );
    expect(await cloud.outboundProof!(1, 2)).toEqual(
      proofOfEvents([nextCloud]),
    );
    expect(await cloud.outboundProof!(0, 1)).toEqual(
      proofOfEvents([staff.pending]),
    );
  });

  it("1 the edge store outboundProof reads (A, N] from edge_outbound_queue and keeps acked rows", async () => {
    const fx = await seedTenant("Proof edge store 1");
    const events = [1, 2, 3, 4].map(() => plainEvent(fx));
    for (const event of events) await enqueue(fx, "edge_to_cloud", event);

    const edge = createDbLinkStore({
      database: db,
      context: fx.node.context,
      node: fx.node.scope,
      outboundDirection: "edge_to_cloud",
    });
    expect(await edge.outboundHead()).toBe(4);
    await edge.ackOutbound(2);
    expect(await edge.lastAckedOutbound()).toBe(2);

    // An ack only changes the status: acked slots still count in the proof.
    expect(await edge.outboundProof!(0, 4)).toEqual(proofOfEvents(events));
    expect(await edge.outboundProof!(2, 4)).toEqual(
      proofOfEvents(events.slice(2)),
    );
    expect(await edge.outboundProof!(1, 3)).toEqual(
      proofOfEvents(events.slice(1, 3)),
    );
    expect(await edge.outboundProof!(4, 4)).toEqual(restoreProofOf([]));
    // Order matters: a different slot content gives a different digest.
    expect(await edge.outboundProof!(1, 3)).not.toEqual(
      proofOfEvents([events[2]!, events[1]!]),
    );
  });
});

describe("legend-tmar2 standby receipts keep one slot per sent event", () => {
  it("2 events the cloud already took from the primary (skipped, not applied) still get a receipt per slot: inboundProof count == N-A and matches the edge digest", async () => {
    const fx = await seedTenant("Proof standby 2");
    const staff = await staffWithSets(fx);

    // The primary delivers the three sets first.
    const primary = new EdgeStore([staff.s1, staff.s2, staff.s3]);
    const primaryClient = startEdge(fx, primary, I1);
    await eventually(
      async () =>
        primary.acked === 3 &&
        (await cursorRows(fx)).e2c?.received_in_seq === 3,
      "the primary is in sync",
    );
    await stopEdge(fx, primaryClient);

    // The standby later re-sends the same event ids (own node, own slots).
    const standby = await addStandby(fx);
    const store = new EdgeStore([staff.s1]);
    const first = startEdge(standby, store, S1);
    await eventually(
      async () =>
        store.acked === 1 &&
        (await cursorRows(standby)).e2c?.received_in_seq === 1,
      "the standby delivered slot 1",
    );
    await stopEdge(standby, first);
    store.push(staff.s2);
    store.push(staff.s3);
    const from = mark();
    const second = startEdge(standby, store, S1);
    await eventually(
      async () =>
        protocolClosesSince(from).length > 0 ||
        (store.acked === 3 &&
          (await cursorRows(standby)).e2c?.received_in_seq === 3),
      "the standby delivered slots 2..3 (or was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);
    await stopEdge(standby, second);

    const { rows } = await owner.query<{ outcome: string; link_seq: string }>(
      `SELECT outcome, link_seq::text AS link_seq FROM edge_inbound_events
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
        ORDER BY link_seq`,
      [fx.tenantId, standby.node.scope.edgeNodeId],
    );
    // One receipt per slot (link 1..3), none of them lost or conflicting. The
    // stored outcome of a skipped duplicate is not asserted: the table only
    // knows applied / superseded / conflict.
    expect(rows.map((r) => r.link_seq)).toEqual(["1", "2", "3"]);
    expect(rows.map((r) => r.outcome)).not.toContain("conflict");

    // The cloud digest of the standby counts every slot and equals the edge's.
    const cloud = cloudStore(standby, S1);
    const a = 1;
    const n = 3;
    const proof = await cloud.inboundProof!(a, n);
    expect(proof?.count).toBe(n - a);
    expect(proof).toEqual(proofTo(n, await store.outboundProof(a, n)));
    expect(proof).toEqual(proofTo(n, proofOfEvents([staff.s2, staff.s3])));
    expect(await cloud.inboundProof!(0, n)).toEqual(
      proofTo(n, proofOfEvents([staff.s1, staff.s2, staff.s3])),
    );
  });
});

describe("legend-tmar2 inboundProof returns the longest proven prefix when the cloud cannot prove the whole range (revisi 1 R2, R3; 854 c.)", () => {
  /** A dead-letter style receipt: in edge_inbound_events, not in edge_received_events. */
  async function insertDeadLetterReceipt(fx: Fx, linkSeq: number) {
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

  async function threeDelivered(label: string) {
    const fx = await seedTenant(label);
    const staff = await staffWithSets(fx);
    const edge = new EdgeStore([staff.s1, staff.s2, staff.s3]);
    const client = startEdge(fx, edge, I1);
    await eventually(
      async () =>
        edge.acked === 3 && (await cursorRows(fx)).e2c?.received_in_seq === 3,
      "three sets delivered",
    );
    await stopEdge(fx, client);
    return { fx, staff };
  }

  it("a dead-letter receipt (not in edge_received_events) is not counted: the digest still equals the edge's", async () => {
    const { fx, staff } = await threeDelivered("Proof dead letter");
    const cloud = cloudStore(fx, I1);
    const events = [staff.s1, staff.s2, staff.s3];
    expect(await cloud.inboundProof!(0, 3)).toEqual(
      proofTo(3, proofOfEvents(events)),
    );

    // A receipt for a dead-lettered event in slot 2, next to the real one.
    await insertDeadLetterReceipt(fx, 2);
    expect(await cloud.inboundProof!(0, 3)).toEqual(
      proofTo(3, proofOfEvents(events)),
    );
    expect(await cloud.inboundProof!(1, 2)).toEqual(
      proofTo(2, proofOfEvents([staff.s2])),
    );
  });

  it("a slot with only a dead-letter receipt is a hole: the proof stops before it", async () => {
    const { fx, staff } = await threeDelivered("Proof dead letter hole");
    const cloud = cloudStore(fx, I1);
    // Slot 4 exists as a receipt, but only of a dead-lettered event.
    await insertDeadLetterReceipt(fx, 4);
    expect(await cloud.inboundProof!(3, 4)).toEqual({
      to: 3,
      ...restoreProofOf([]),
    });
    expect(await cloud.inboundProof!(0, 4)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s1, staff.s2, staff.s3]),
    });
  });

  it("a hole in the range (missing receipt) gives the prefix before it; the intact ranges still prove", async () => {
    const { fx, staff } = await threeDelivered("Proof hole");
    const cloud = cloudStore(fx, I1);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `DELETE FROM edge_inbound_events WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND link_seq = 2`,
        [fx.tenantId, fx.node.scope.edgeNodeId],
      );
      await client.query(
        `DELETE FROM edge_link_slots WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND link_seq = 2`,
        [fx.tenantId, fx.node.scope.edgeNodeId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(await cloud.inboundProof!(0, 3)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });
    expect(await cloud.inboundProof!(0, 2)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });
    expect(await cloud.inboundProof!(1, 3)).toEqual({
      to: 1,
      ...restoreProofOf([]),
    });
    expect(await cloud.inboundProof!(2, 3)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s3]),
    });
    expect(await cloud.inboundProof!(0, 1)).toEqual({
      to: 1,
      ...proofOfEvents([staff.s1]),
    });
  });

  it("a range past the receipts held (beyond N) gives the prefix of what exists, to = N", async () => {
    const { fx, staff } = await threeDelivered("Proof beyond");
    expect(await cloudStore(fx, I1).inboundProof!(0, 4)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s1, staff.s2, staff.s3]),
    });
  });

  it("a range wider than 20000 slots gives the prefix of what exists; only a reversed range is null", async () => {
    const { fx, staff } = await threeDelivered("Proof wide");
    const cloud = cloudStore(fx, I1);
    expect(await cloud.inboundProof!(0, 20_001)).toEqual({
      to: 3,
      ...proofOfEvents([staff.s1, staff.s2, staff.s3]),
    });
    expect(await cloud.inboundProof!(3, 2)).toBeNull();
  });
});

describe("legend-tmar2 end to end: a restored edge database is not acked blindly", () => {
  it("3 different events in slots (acked, N]: the link is refused, nothing is acked, the panic event stays pending", async () => {
    const fx = await seedTenant("Proof restore 3");
    // Cloud: received_in_seq N = 3 from I1, c2e acked 2.
    const staff = await phaseOne(fx, I1);

    // The backup was taken after slot 1 (acked = 1, received = 2). The
    // restored database then created a panic alert and another event in slots
    // 2 and 3: the head (3) reaches N (3), but the content is not what the
    // cloud received.
    const panic = plainEvent(fx, "panic.alert_raised");
    const other = plainEvent(fx);
    const restored = EdgeStore.restored([staff.s1, panic, other], {
      acked: 1,
      received: 2,
    });
    // The digests differ over (1, 3]: the cloud holds s2 and s3 there.
    expect(await cloudStore(fx, I1).inboundProof!(1, 3)).toEqual(
      proofTo(3, proofOfEvents([staff.s2, staff.s3])),
    );
    expect((await restored.outboundProof(1, 3)).sha256).not.toEqual(
      (await cloudStore(fx, I1).inboundProof!(1, 3))?.sha256,
    );
    const cursorsBefore = await allCursorColumns(fx);

    const from = mark();
    const client = startEdge(fx, restored, I1);
    await eventually(
      () => protocolClosesSince(from).length > 0,
      "the link is refused with 1008",
      4000, // a refusal must not hang until the 5 s ack timeout
    );
    await stopEdge(fx, client);

    expect(
      protocolClosesSince(from).some((c) => /restore proof/i.test(c.reason)),
    ).toBe(true);
    // No ack of the unproven slots, so the panic alert is still pending.
    expect(restored.ackCalls).toEqual([]);
    expect(restored.acked).toBe(1);
    expect(restored.pendingSlots()).toEqual([2, 3]);
    expect(restored.queue[1]!.event.id).toBe(panic.id);
    // Nothing changed on the cloud and the new events were never received.
    expect(await allCursorColumns(fx)).toEqual(cursorsBefore);
    expect(await inboundReceipts(fx, panic)).toEqual([]);
    expect(await inboundReceipts(fx, other)).toEqual([]);
  });

  it("3 control: a restored database with the same events in (acked, N] is acked normally", async () => {
    const fx = await seedTenant("Proof restore 3 control");
    const staff = await phaseOne(fx, I1);
    const restored = EdgeStore.restored([staff.s1, staff.s2, staff.s3], {
      acked: 1,
      received: 2,
    });

    const from = mark();
    startEdge(fx, restored, I1);
    await eventually(
      () => protocolClosesSince(from).length > 0 || restored.acked === 3,
      "the matching range is acked (or the link was refused)",
    );
    expect(protocolClosesSince(from)).toEqual([]);
    expect(restored.acked).toBe(3);
    expect(restored.pendingSlots()).toEqual([]);
    // The cloud cursor did not move: it already had all three.
    expect((await cursorRows(fx)).e2c).toMatchObject({
      received_in_seq: 3,
      peer_instance_id: I1,
      peer_seq_offset: 0,
    });
    await sleep(100);
  });
});
