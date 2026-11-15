// legend-3k41y, CTO decision "placeholder instead of renumber": when the brand
// of a node's outlet moves, its pending `catalog_record` rows in the
// cloud_to_edge queue are neutralised IN PLACE. The full original event is
// copied to edge_link_dead_letters (reason 'brand_moved', link_seq = its slot)
// and the queue row keeps its link_seq but carries a no-op placeholder event.
// Nothing is renumbered, so the receiver's cursor (and any ack in flight)
// stays valid. Outlet-scoped events (panic) keep flowing at their own seq.
//
// Written from the brief and the queue / dead-letter table contract, not from
// the implementation. The placeholder event NAME is not decided, so tests
// assert behavior (same link_seq, delivered, applied, no throw, not stuck),
// never the name. The only fixed text is the dead-letter reason 'brand_moved'.
//
// Rules under test:
//  - Scenario A: the cloud sent catalog (seq 1..c) and panic (seq c+1) in one
//    batch; the edge applied only the catalog part (receiver cursor c). The
//    brand moves. On reconnect the panic is still delivered at seq c+1 and
//    applied; the catalog is not re-sent / re-applied as data.
//  - Scenario B: the edge applied everything (cursor c+1) and its ack(c+1) is
//    still in flight. After the move the ack does not throw and the next
//    hello is not refused ("Peer cursor is ahead"); a later panic flows.
//  - Replacement also happens for a brand change without blocked_at; acked
//    rows are untouched; running it again changes nothing; a sibling node on
//    the old brand is untouched.
//  - A fresh edge (cursor 0) accepts the placeholders at their slots: receipts
//    are recorded, the cursor advances, and no catalog data is written.
//
// Assumptions:
//  - Queue before the move (node offline): c >= 2 catalog_record rows
//    (seq 1..c) and then one resolved panic alert (seq c+1).
//  - The edge and the cloud share one database in tests (see edge-db.test.ts):
//    the edge receiver is a db link store with outboundDirection
//    "edge_to_cloud", the cloud sender one with "cloud_to_edge".
//  - Edge appliers come from the applier registry. `installEdgeAppliers()`
//    mirrors the cloud_to_edge appliers of the edge boot in edge/runtime.ts;
//    when the placeholder applier needs its own register call, add it THERE
//    (one line) as well as in the edge boot.
//  - An applied placeholder is recorded with receipt outcome 'applied'.
//  - Dead-letter rows and the queue are read with the owner pool (bypasses RLS).
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { createLinkPeer } from "../edge/link-peer.ts";
import { registerEdgeLinkPlaceholderApplier } from "../edge/link-dead-letter-applier.ts";
import { registerMasterDataEdgeApplier } from "../edge/master-data-applier.ts";
import { registerPanicAlertEdgeApplier } from "../edge/panic-alert-applier.ts";
import { decodeFrame } from "../edge/protocol.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
} from "../services/edge-node.service.ts";
import { resolveEmergencyAlert } from "../services/panic-alert-cloud.service.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  asTenant,
  createWorld,
  owner,
  type World,
} from "./member-loyalty-helpers.ts";

afterAll(async () => owner.end());

/** Mirror of the cloud_to_edge appliers of the edge boot (see Assumptions). */
function installEdgeAppliers() {
  resetEdgeApplierRegistryForTests();
  registerMasterDataEdgeApplier();
  registerPanicAlertEdgeApplier();
  registerEdgeLinkPlaceholderApplier();
}

beforeEach(() => installEdgeAppliers());
afterEach(() => resetEdgeApplierRegistryForTests());

type Authenticated = NonNullable<
  Awaited<ReturnType<typeof authenticateEdgeCredential>>
>;

async function provision(world: World, outletId: string) {
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId,
    role: "primary",
    label: "Brand move placeholder",
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Node authentication failed");
  return node;
}

const publish = (world: World, outletId: string, node: Authenticated) =>
  publishCatalogForNode(db, {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(outletId),
    edgeNodeId: node.scope.edgeNodeId,
    stream: "menu_categories",
  });

const cloudStore = (node: Authenticated) =>
  createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });

/** The edge receiver: applier from the registry (what the edge boot installs). */
const edgeStore = (node: Authenticated) =>
  createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
  });

/** An edge receiver that only records: "the edge applied these earlier". */
const recordingEdgeStore = (node: Authenticated) =>
  createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
    classify: () => "master_data" as const,
    applier: { async apply() {} },
  });

const outletScope = (world: World, outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** A panic alert of outlet A, resolved by the cloud: the real service queues it. */
async function resolvePanicAlert(world: World) {
  const deviceId = randomUUID();
  const alertId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', 'Perangkat uji', now())`,
      [deviceId, world.tenantId, world.outletA],
    );
    await client.query(
      `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                                 unit_code_snapshot, facility_name_snapshot, device_label_snapshot, received_at)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas uji', 'Tombol uji', now())`,
      [alertId, world.tenantId, world.outletA, deviceId, `evt-${alertId}`],
    );
  });
  await resolveEmergencyAlert(
    outletScope(world, world.outletA),
    world.outletA,
    alertId,
    randomUUID(),
    "Aman, tamu sudah dibantu",
  );
  return alertId;
}

type QueueRow = {
  link_seq: number;
  event_id: string;
  status: string;
  aggregate_type: string;
  event: EventEnvelope;
};

async function queueRows(nodeId: string): Promise<QueueRow[]> {
  const res = await owner.query(
    `SELECT link_seq::text, event_id::text, status, aggregate_type, event
       FROM edge_outbound_queue
      WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows.map((row) => ({ ...row, link_seq: Number(row.link_seq) }));
}

async function deadLetterRows(nodeId: string) {
  const res = await owner.query<{
    event_id: string;
    link_seq: string;
    reason: string;
    event: EventEnvelope;
  }>(
    `SELECT event_id::text, link_seq::text, reason, event FROM edge_link_dead_letters
      WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows.map((row) => ({ ...row, link_seq: Number(row.link_seq) }));
}

async function nextOutSeq(nodeId: string) {
  const res = await owner.query<{ next_out_seq: string }>(
    `SELECT next_out_seq::text FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
    [nodeId],
  );
  return Number(res.rows[0]?.next_out_seq);
}

/** What the edge recorded for what the cloud sent it, by link seq. */
async function edgeReceipts(nodeId: string) {
  const res = await owner.query<{
    link_seq: string;
    event_id: string;
    outcome: string;
  }>(
    `SELECT link_seq::text, event_id::text, outcome FROM edge_inbound_events
      WHERE edge_node_id = $1 ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows.map((row) => ({ ...row, link_seq: Number(row.link_seq) }));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const OLD_NAME = "Brand A before move";

/**
 * Outlet A (brand A) with an offline node and a sibling node on outlet B
 * (same brand A). Queue of the node: catalog rows 1..c, then a panic at c+1.
 * The outlet has NOT moved yet.
 */
async function setup() {
  const world = await createWorld();
  const brandB = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, world.tenantId, `brand-${brandB}`],
  );
  const node = await provision(world, world.outletA);
  const sibling = await provision(world, world.outletB);
  const nodeId = node.scope.edgeNodeId;
  const categoryIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, id] of categoryIds.entries())
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, $4)`,
      [id, world.tenantId, world.brandId, `${OLD_NAME} ${i}`],
    );
  await settleCloud(owner);
  await publish(world, world.outletA, node);
  await publish(world, world.outletB, sibling);
  const alertId = await resolvePanicAlert(world);

  // Preconditions (not vacuous): catalog first, panic last, gap-free.
  const before = await queueRows(nodeId);
  const catalog = before.filter((r) => r.aggregate_type === "catalog_record");
  const c = catalog.length;
  expect(c).toBeGreaterThanOrEqual(2);
  expect(before.map((r) => r.link_seq)).toEqual(range(1, c + 1));
  expect(catalog.map((r) => r.link_seq)).toEqual(range(1, c));
  expect(before[c]!.aggregate_type).not.toBe("catalog_record");
  expect(before[c]!.event.aggregateId).toBe(alertId);
  return {
    world,
    brandB,
    node,
    sibling,
    nodeId,
    alertId,
    categoryIds,
    before,
    /** Catalog rows are link_seq 1..c. */
    c,
    /** The panic row's slot. */
    panicSeq: c + 1,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The outlet moves to brand B; with `block` the publisher notices (blocked_at). */
async function moveBrand(f: Fixture, options: { block: boolean }) {
  await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
    f.brandB,
    f.world.outletA,
  ]);
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand B')`,
    [randomUUID(), f.world.tenantId, f.brandB],
  );
  await settleCloud(owner);
  if (options.block) {
    await publish(f.world, f.world.outletA, f.node);
    const state = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.nodeId],
    );
    expect(state.rows.length).toBeGreaterThan(0);
    expect(state.rows.every((row) => row.blocked_at !== null)).toBe(true);
  } else {
    const state = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.nodeId],
    );
    expect(state.rows.every((row) => row.blocked_at === null)).toBe(true);
  }
}

/** The cloud sends all it has (a batch on the wire); returns what it read. */
const cloudSends = (f: Fixture) => cloudStore(f.node).readOutbound(0, 1000);

/** The edge applied the first `upto` of what the cloud sent (recorded only). */
async function edgeAppliedFirst(
  f: Fixture,
  sent: Awaited<ReturnType<typeof cloudSends>>,
  upto: number,
) {
  const store = recordingEdgeStore(f.node);
  await store.applyInbound({
    fromSeq: 0,
    toSeq: upto,
    events: sent
      .slice(0, upto)
      .map((q) => ({ linkSeq: q.linkSeq, event: q.event })),
  });
  expect(await store.lastReceivedInbound()).toBe(upto);
}

/** The real link peer pair (cloud <-> edge) over an in-memory wire. */
function connect(f: Fixture) {
  const errors: unknown[] = [];
  const closes: number[] = [];
  const delivered: EventEnvelope[] = [];
  const cloud = cloudStore(f.node);
  const edge = edgeStore(f.node);
  const wireToEdge = {
    send: (data: string) => {
      const frame = decodeFrame(data);
      if (frame?.type === "batch") delivered.push(...frame.batch.events);
      queueMicrotask(() => edgePeer.receive(data));
    },
    close: (code: number) => closes.push(code),
  };
  const wireToCloud = {
    send: (data: string) => queueMicrotask(() => cloudPeer.receive(data)),
    close: (code: number) => closes.push(code),
  };
  const cloudPeer: ReturnType<typeof createLinkPeer> = createLinkPeer({
    scope: f.node.scope,
    outboundDirection: "cloud_to_edge",
    store: cloud,
    version: "cloud",
    ackTimeoutMs: 60_000,
    transport: wireToEdge,
    onError: (error) => errors.push(error),
  });
  const edgePeer: ReturnType<typeof createLinkPeer> = createLinkPeer({
    scope: f.node.scope,
    outboundDirection: "edge_to_cloud",
    store: edge,
    version: "edge",
    ackTimeoutMs: 60_000,
    transport: wireToCloud,
    onError: (error) => errors.push(error),
  });
  return {
    errors,
    closes,
    delivered,
    cloud,
    edge,
    start() {
      cloudPeer.start();
      edgePeer.start();
    },
    stop() {
      edgePeer.stop();
      cloudPeer.stop();
    },
    /** Waits until the cloud holds the edge's ack up to `seq`. */
    async untilAcked(seq: number) {
      await vi.waitFor(
        async () => {
          // Fail fast, with the reason, when the link reports an error.
          expect(errors.map(String)).toEqual([]);
          expect(closes).toEqual([]);
          expect(await cloud.lastAckedOutbound()).toBeGreaterThanOrEqual(seq);
        },
        { timeout: 20_000, interval: 50 },
      );
    },
  };
}

describe("legend-3k41y placeholder: scenario A, edge applied only the catalog part", () => {
  it("legend-3k41y control: without a brand move the reconnect delivers the panic at its seq and the edge applies it", async () => {
    const f = await setup();
    const sent = await cloudSends(f);
    await edgeAppliedFirst(f, sent, f.c);

    const link = connect(f);
    link.start();
    try {
      await link.untilAcked(f.panicSeq);
    } finally {
      link.stop();
    }
    expect(link.errors).toEqual([]);
    expect(link.closes).toEqual([]);
    expect(link.delivered.map((e) => e.id)).toEqual([f.before[f.c]!.event.id]);
    const receipts = await edgeReceipts(f.nodeId);
    expect(receipts.at(-1)).toMatchObject({
      link_seq: f.panicSeq,
      event_id: f.before[f.c]!.event_id,
      outcome: "applied",
    });
  }, 60_000);

  it.each([
    { label: "node blocked by the publisher", block: true },
    {
      label: "brand changed, publisher never ran (no blocked_at)",
      block: false,
    },
  ])(
    "legend-3k41y after the brand move ($label) the panic at c+1 is still delivered and applied, the catalog is not re-sent",
    async ({ block }) => {
      const f = await setup();
      const sent = await cloudSends(f);
      await edgeAppliedFirst(f, sent, f.c);
      await moveBrand(f, { block });

      const link = connect(f);
      link.start();
      try {
        await link.untilAcked(f.panicSeq);
      } finally {
        link.stop();
      }
      // The link did not throw, close or get stuck on the edge's cursor c.
      expect(link.errors).toEqual([]);
      expect(link.closes).toEqual([]);
      // Only the panic travelled: nothing of the catalog came again.
      expect(link.delivered.map((e) => e.id)).toEqual([
        f.before[f.c]!.event.id,
      ]);
      expect(
        link.delivered.some((e) => e.aggregateType === "catalog_record"),
      ).toBe(false);
      // Same link_seq, applied by the edge; the catalog receipts are the c
      // from before the move, none was recorded twice.
      const receipts = await edgeReceipts(f.nodeId);
      expect(receipts.map((r) => r.link_seq)).toEqual(range(1, f.panicSeq));
      expect(receipts.at(-1)).toMatchObject({
        link_seq: f.panicSeq,
        event_id: f.before[f.c]!.event_id,
        outcome: "applied",
      });
      expect(await link.edge.lastReceivedInbound()).toBe(f.panicSeq);
      expect(await link.cloud.lastAckedOutbound()).toBe(f.panicSeq);
      // No gap, no move: the cloud cursor still ends at the panic's slot and
      // the queue was neutralised in place (c placeholders + the panic).
      expect(await nextOutSeq(f.nodeId)).toBe(f.panicSeq);
      expect((await queueRows(f.nodeId)).map((r) => r.link_seq)).toEqual(
        range(1, f.panicSeq),
      );
      // Blocked: the publisher neutralised the still-pending catalog rows
      // before the reconnect, so their full events are in the dead letters.
      // Not blocked: the edge's hello acks slots 1..c before the first queue
      // read; acked rows are delivered and applied, they keep their event
      // (the receipts above are the evidence), so nothing is dead-lettered.
      expect((await deadLetterRows(f.nodeId)).map((d) => d.link_seq)).toEqual(
        block ? range(1, f.c) : [],
      );
    },
    60_000,
  );
});

describe("legend-3k41y placeholder: scenario B, the edge applied everything and its ack is in flight", () => {
  it("legend-3k41y control: without a brand move the late ack and the reconnect are fine", async () => {
    const f = await setup();
    const sent = await cloudSends(f);
    await edgeAppliedFirst(f, sent, f.panicSeq);
    await expect(
      cloudStore(f.node).ackOutbound(f.panicSeq),
    ).resolves.not.toThrow();

    const second = await resolvePanicAlert(f.world);
    const link = connect(f);
    link.start();
    try {
      await link.untilAcked(f.panicSeq + 1);
    } finally {
      link.stop();
    }
    expect(link.errors).toEqual([]);
    expect(link.closes).toEqual([]);
    expect(link.delivered.map((e) => e.aggregateId)).toEqual([second]);
  }, 60_000);

  it.each([
    { label: "node blocked by the publisher", block: true },
    {
      label: "brand changed, publisher never ran (no blocked_at)",
      block: false,
    },
  ])(
    "legend-3k41y after the brand move ($label) the late ack(c+1) does not throw and the next hello is not stuck",
    async ({ block }) => {
      const f = await setup();
      const sent = await cloudSends(f);
      await edgeAppliedFirst(f, sent, f.panicSeq);
      await moveBrand(f, { block });
      if (!block) {
        // The lazy path: a queue read notices the move.
        await cloudStore(f.node).readOutbound(0, 1000);
      }

      // The ack the edge sent before the move reaches the cloud now.
      const cloud = cloudStore(f.node);
      await expect(cloud.ackOutbound(f.panicSeq)).resolves.toBeUndefined();
      expect(await cloud.lastAckedOutbound()).toBe(f.panicSeq);
      expect(await cloud.outboundHead()).toBe(f.panicSeq);

      // Reconnect: the edge says "I hold c+1". Not "Peer cursor is ahead".
      // A later outlet event proves the link is alive, not just silent.
      const later = await resolvePanicAlert(f.world);
      const link = connect(f);
      link.start();
      try {
        await link.untilAcked(f.panicSeq + 1);
      } finally {
        link.stop();
      }
      expect(link.errors).toEqual([]);
      expect(link.closes).toEqual([]);
      // Nothing old came again; only the new panic, at the next slot.
      expect(link.delivered.map((e) => e.aggregateId)).toEqual([later]);
      const receipts = await edgeReceipts(f.nodeId);
      expect(receipts.at(-1)).toMatchObject({
        link_seq: f.panicSeq + 1,
        outcome: "applied",
      });
      expect(await link.edge.lastReceivedInbound()).toBe(f.panicSeq + 1);
    },
    60_000,
  );
});

describe("legend-3k41y placeholder: in-place replacement of the queue rows", () => {
  /** The rows of the catalog slots no longer hold a catalog event. */
  function expectNeutralised(f: Fixture, rows: QueueRow[], slots: number[]) {
    for (const seq of slots) {
      const row = rows.find((r) => r.link_seq === seq)!;
      expect(row, `queue row ${seq}`).toBeDefined();
      expect(row.event.aggregateType).not.toBe("catalog_record");
      expect(JSON.stringify(row.event)).not.toContain(OLD_NAME);
      // Same slot, same status as before: replaced, not acked or dropped.
      expect(row.status).toBe(f.before.find((b) => b.link_seq === seq)!.status);
    }
  }

  it.each([
    { label: "blocked by the publisher", block: true },
    { label: "no blocked_at (read-time catch)", block: false },
  ])(
    "legend-3k41y brand move ($label): every catalog slot keeps its link_seq with a placeholder, the full event is in the dead letters, nothing moves",
    async ({ block }) => {
      const f = await setup();
      await moveBrand(f, { block });
      // The lazy path replaces on the first queue read; the blocked path may
      // already have done it, reading again must be harmless.
      const read = await cloudStore(f.node).readOutbound(0, 1000);

      const rows = await queueRows(f.nodeId);
      expect(rows.map((r) => r.link_seq)).toEqual(range(1, f.panicSeq));
      expectNeutralised(f, rows, range(1, f.c));
      // The read serves the same slots, none of them a catalog event.
      expect(read.map((q) => q.linkSeq)).toEqual(range(1, f.panicSeq));
      expect(read.some((q) => q.event.aggregateType === "catalog_record")).toBe(
        false,
      );
      // The panic row is untouched.
      expect(rows[f.c]).toMatchObject({
        link_seq: f.panicSeq,
        event_id: f.before[f.c]!.event_id,
        event: f.before[f.c]!.event,
      });
      // No renumber, no cursor move.
      expect(await nextOutSeq(f.nodeId)).toBe(f.panicSeq);

      // The dead letters keep the whole original event at its own slot.
      const dead = await deadLetterRows(f.nodeId);
      expect(dead.map((d) => d.link_seq)).toEqual(range(1, f.c));
      for (const row of dead) {
        const original = f.before.find((b) => b.link_seq === row.link_seq)!;
        expect(row.reason).toBe("brand_moved");
        expect(row.event_id).toBe(original.event_id);
        expect(row.event).toEqual(original.event);
      }
    },
    60_000,
  );

  it("legend-3k41y rows the edge already acked keep their event and are not dead-lettered", async () => {
    const f = await setup();
    const cloud = cloudStore(f.node);
    await cloud.readOutbound(0, 1000);
    await cloud.ackOutbound(1);
    await moveBrand(f, { block: false });
    await cloud.readOutbound(0, 1000);

    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => r.link_seq)).toEqual(range(1, f.panicSeq));
    // Slot 1 was acked before the move: still its catalog event.
    expect(rows[0]).toMatchObject({
      event_id: f.before[0]!.event_id,
      aggregate_type: "catalog_record",
      event: f.before[0]!.event,
    });
    expectNeutralised(f, rows, range(2, f.c));
    const dead = await deadLetterRows(f.nodeId);
    expect(dead.map((d) => d.link_seq)).toEqual(range(2, f.c));
    expect(await cloud.lastAckedOutbound()).toBe(1);
  }, 60_000);

  it("legend-3k41y replacing again changes nothing: queue, dead letters and cursor stay the same", async () => {
    const f = await setup();
    await moveBrand(f, { block: true });
    const cloud = cloudStore(f.node);
    const first = await cloud.readOutbound(0, 1000);
    const rowsFirst = await queueRows(f.nodeId);
    const deadFirst = await deadLetterRows(f.nodeId);

    await publish(f.world, f.world.outletA, f.node);
    const second = await cloud.readOutbound(0, 1000);
    await cloud.readOutbound(0, 1000);

    expect(await queueRows(f.nodeId)).toEqual(rowsFirst);
    expect(await deadLetterRows(f.nodeId)).toEqual(deadFirst);
    expect(deadFirst).toHaveLength(f.c);
    expect(second.map((q) => q.linkSeq)).toEqual(first.map((q) => q.linkSeq));
    expect(second.map((q) => q.event.id)).toEqual(first.map((q) => q.event.id));
    expect(await nextOutSeq(f.nodeId)).toBe(f.panicSeq);
  }, 60_000);

  it("legend-3k41y control: a sibling node on the old brand keeps its catalog rows, events and numbering", async () => {
    const f = await setup();
    const siblingId = f.sibling.scope.edgeNodeId;
    const siblingBefore = await queueRows(siblingId);
    expect(
      siblingBefore.some((r) => r.aggregate_type === "catalog_record"),
    ).toBe(true);
    await moveBrand(f, { block: true });
    await cloudStore(f.node).readOutbound(0, 1000);

    expect(await queueRows(siblingId)).toEqual(siblingBefore);
    expect(await deadLetterRows(siblingId)).toEqual([]);
    const read = await cloudStore(f.sibling).readOutbound(0, 1000);
    expect(read.map((q) => q.event.id)).toEqual(
      siblingBefore.map((r) => r.event.id),
    );
  }, 60_000);
});

describe("legend-3k41y placeholder: a fresh edge accepts the placeholders without changing data", () => {
  async function categoryRows(world: World) {
    const res = await owner.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM menu_categories WHERE tenant_id = $1 ORDER BY id`,
      [world.tenantId],
    );
    return res.rows;
  }

  it("legend-3k41y a fresh edge (cursor 0) receives every slot over the real link, records receipts and does not write the stale catalog", async () => {
    const f = await setup();
    await moveBrand(f, { block: true });
    // The old brand A categories are gone from the cloud: an edge that applied
    // the stale catalog events as data would bring them back.
    await owner.query(
      `DELETE FROM menu_categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [f.world.tenantId, f.categoryIds],
    );
    const dataBefore = await categoryRows(f.world);

    const link = connect(f);
    link.start();
    try {
      await link.untilAcked(f.panicSeq);
    } finally {
      link.stop();
    }
    expect(link.errors).toEqual([]);
    expect(link.closes).toEqual([]);
    // Every slot arrived (placeholders included), none as a catalog event.
    expect(link.delivered).toHaveLength(f.panicSeq);
    expect(
      link.delivered.some((e) => e.aggregateType === "catalog_record"),
    ).toBe(false);
    expect(link.delivered.at(-1)!.id).toBe(f.before[f.c]!.event.id);
    // Receipts for every link_seq, recorded normally; the cursor advanced.
    const receipts = await edgeReceipts(f.nodeId);
    expect(receipts.map((r) => r.link_seq)).toEqual(range(1, f.panicSeq));
    expect(receipts.every((r) => r.outcome === "applied")).toBe(true);
    expect(await link.edge.lastReceivedInbound()).toBe(f.panicSeq);
    // No data change.
    expect(await categoryRows(f.world)).toEqual(dataBefore);
  }, 60_000);

  it("legend-3k41y control: the same stale catalog events of a node that did NOT move do write data on the edge", async () => {
    // Proves the data check above can see a write: the sibling node's queue
    // still holds the real brand A catalog events.
    const f = await setup();
    await moveBrand(f, { block: true });
    await owner.query(
      `DELETE FROM menu_categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [f.world.tenantId, f.categoryIds],
    );
    const before = await categoryRows(f.world);
    const sent = await cloudStore(f.sibling).readOutbound(0, 1000);
    expect(sent.length).toBeGreaterThan(0);
    await edgeStore(f.sibling).applyInbound({
      fromSeq: 0,
      toSeq: sent.length,
      events: sent.map((q) => ({ linkSeq: q.linkSeq, event: q.event })),
    });
    expect((await categoryRows(f.world)).length).toBeGreaterThan(before.length);
  }, 60_000);
});
