// legend-3k41y, option C (CTO decision): stale `catalog_record` rows of a node
// whose outlet brand moved are dead-lettered and the rows behind them are
// renumbered down, so the cloud_to_edge queue stays gap-free (link_seq 1..n,
// no hole). Hiding the rows at read time left a hole, and the link pump throws
// "Outbound queue is not contiguous" on a hole. Written from the brief and the
// queue/dead-letter table contract (migrations), not from the implementation.
//
// Rules under test:
//  - Node blocked by the publisher (brand moved): its pending catalog_record
//    rows move to edge_link_dead_letters in the same transaction (no queue
//    read needed), the rows behind them are renumbered down, and
//    sync_cursors.next_out_seq follows.
//  - Brand changed with NO blocked_at (publisher never ran; raw UPDATE, no
//    service hook): the read-time safety net still dead-letters + renumbers,
//    it never just hides rows.
//  - Outlet-scoped events (QR order, Wi-Fi quota, panic alert) are never
//    dead-lettered, keep their order, and keep flowing.
//  - Rows at or below the edge-acked seq never change number and are never
//    dead-lettered.
//  - A real cloud link peer on the db link store does not throw.
//
// Assumptions:
//  - Queue before the move (the node is offline): qr_order (seq 1), the
//    published catalog_record events (seq 2..1+c, c >= 1), wifi_quota, panic.
//    c is read from the queue, not hard-coded.
//  - The dead-letter `reason` text is not fixed by the brief ("e.g.
//    brand_moved"): it only has to be a non-empty string.
//  - Dead-letter rows are read with the owner pool (bypasses RLS).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { createLinkPeer } from "../edge/link-peer.ts";
import { decodeFrame, encodeFrame } from "../edge/protocol.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";
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

/** The queue tables key events by uuid; envelopes carry a ULID (or the uuid). */
const uuidOf = (id: string) =>
  id.includes("-") ? id : ulidToUuid(id as never);

type Authenticated = NonNullable<
  Awaited<ReturnType<typeof authenticateEdgeCredential>>
>;

async function provision(world: World, outletId: string) {
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId,
    role: "primary",
    label: "Brand move catalog dead letter",
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

const outletScope = (world: World, outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function enqueueForNode(
  world: World,
  node: Authenticated,
  name: string,
  aggregateType: string,
) {
  const event: EventEnvelope = {
    id: createUlid() as EventEnvelope["id"],
    tenantId: world.tenantId as EventEnvelope["tenantId"],
    outletId: world.outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType,
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `catalog-dl-${randomUUID()}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {},
  };
  await withTenant(db, node.context, (tx) =>
    enqueueEdgeEvent(tx, node.context, {
      edgeNodeId: node.scope.edgeNodeId,
      direction: "cloud_to_edge",
      kind: "transaction_event",
      event,
    }),
  );
  return event;
}

/** A panic alert of the outlet, resolved by the cloud: the real service queues it. */
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
  link_seq: string;
  event_id: string;
  aggregate_type: string;
  status: string;
};

async function queueRows(nodeId: string): Promise<QueueRow[]> {
  const res = await owner.query<QueueRow>(
    `SELECT link_seq::text, event_id, aggregate_type, status FROM edge_outbound_queue
      WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows;
}

async function deadLetterRows(nodeId: string) {
  const res = await owner.query<{
    event_id: string;
    link_seq: string;
    aggregate_type: string;
    reason: string;
    event: { id: string; aggregateType: string };
  }>(
    `SELECT event_id, link_seq::text, aggregate_type, reason, event FROM edge_link_dead_letters
      WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows;
}

async function nextOutSeq(nodeId: string) {
  const res = await owner.query<{ next_out_seq: string }>(
    `SELECT next_out_seq::text FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
    [nodeId],
  );
  return Number(res.rows[0]?.next_out_seq);
}

/**
 * Outlet A (brand A) with an offline node. Queue: qr (1), catalog (2..1+c),
 * wifi, panic. Then the outlet moves to brand B. With `block`, the publisher
 * runs and blocks the node; without, nothing but the raw UPDATE happened.
 */
async function offlineBrandMove(options: { block: boolean }) {
  const world = await createWorld();
  const brandB = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, world.tenantId, `brand-${brandB}`],
  );
  const node = await provision(world, world.outletA);
  const sibling = await provision(world, world.outletB);
  const nodeId = node.scope.edgeNodeId;

  const qr = await enqueueForNode(world, node, "qr_order.placed", "qr_order");
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand A before move')`,
    [randomUUID(), world.tenantId, world.brandId],
  );
  await settleCloud(owner);
  await publish(world, world.outletA, node);
  await publish(world, world.outletB, sibling);
  const wifi = await enqueueForNode(
    world,
    node,
    "wifi_quota.updated",
    "wifi_quota",
  );
  const alertId = await resolvePanicAlert(world);

  // Preconditions (not vacuous): catalog rows really sit between the outlet
  // events and the queue starts gap-free at 1.
  const before = await queueRows(nodeId);
  const catalog = before.filter((r) => r.aggregate_type === "catalog_record");
  expect(catalog.length).toBeGreaterThanOrEqual(1);
  expect(before.map((r) => Number(r.link_seq))).toEqual(
    before.map((_, i) => i + 1),
  );
  expect(before[0]!.event_id).toBe(uuidOf(qr.id));
  expect(before.length).toBe(catalog.length + 3);

  await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
    brandB,
    world.outletA,
  ]);
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand B')`,
    [randomUUID(), world.tenantId, brandB],
  );
  await settleCloud(owner);
  if (options.block) {
    await publish(world, world.outletA, node);
    const state = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [nodeId],
    );
    expect(state.rows.length).toBeGreaterThan(0);
    expect(state.rows.every((row) => row.blocked_at !== null)).toBe(true);
  }
  return {
    world,
    node,
    sibling,
    nodeId,
    qr,
    wifi,
    alertId,
    catalogIds: catalog.map((r) => r.event_id),
    outletEventCount: 3,
  };
}

/** The ids of what the cloud would send, with the link_seq it sends them at. */
async function readAll(node: Authenticated, afterSeq = 0) {
  const read = await cloudStore(node).readOutbound(afterSeq, 1000);
  return read.map((item) => ({ seq: item.linkSeq, id: uuidOf(item.event.id) }));
}

describe("legend-3k41y option C: stale catalog rows are dead-lettered and the queue renumbered", () => {
  it("legend-3k41y a blocked node's queue read has no hole: outlet events keep their order at seq 1..n", async () => {
    const f = await offlineBrandMove({ block: true });
    const read = await readAll(f.node);
    expect(read.map((r) => r.id)).toEqual([
      uuidOf(f.qr.id),
      uuidOf(f.wifi.id),
      expect.any(String),
    ]);
    expect(read.map((r) => r.seq)).toEqual([1, 2, 3]);
    // The panic event is the last one and is the resolved alert.
    const panic = (await cloudStore(f.node).readOutbound(2, 10))[0]!;
    expect(panic.linkSeq).toBe(3);
    expect(panic.event.aggregateId).toBe(f.alertId);
    // Reading from the middle also lands on the renumbered seqs.
    expect(await readAll(f.node, 1)).toEqual([
      { seq: 2, id: uuidOf(f.wifi.id) },
      { seq: 3, id: uuidOf(panic.event.id) },
    ]);
  }, 60_000);

  it("legend-3k41y blocking the node moves the catalog rows to the dead letters in the same transaction, before any queue read", async () => {
    const f = await offlineBrandMove({ block: true });
    // No readOutbound has run: the publisher's block did the work.
    const rows = await queueRows(f.nodeId);
    expect(rows.some((r) => r.aggregate_type === "catalog_record")).toBe(false);
    expect(rows.map((r) => Number(r.link_seq))).toEqual([1, 2, 3]);
    expect(await nextOutSeq(f.nodeId)).toBe(3);

    const dead = await deadLetterRows(f.nodeId);
    expect(dead.map((d) => d.event_id).sort()).toEqual(
      [...f.catalogIds].sort(),
    );
    for (const row of dead) {
      expect(row.aggregate_type).toBe("catalog_record");
      expect(uuidOf(row.event.id)).toBe(row.event_id);
      expect(row.event.aggregateType).toBe("catalog_record");
      expect(row.reason.length).toBeGreaterThan(0);
    }
    // Outlet-scoped events are never dead-lettered.
    const deadIds = dead.map((d) => d.event_id);
    for (const id of [uuidOf(f.qr.id), uuidOf(f.wifi.id)])
      expect(deadIds).not.toContain(id);
  }, 60_000);

  it("legend-3k41y a brand change without blocked_at is caught lazily: dead-lettered and renumbered, not just hidden", async () => {
    const f = await offlineBrandMove({ block: false });
    const state = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.nodeId],
    );
    expect(state.rows.every((row) => row.blocked_at === null)).toBe(true);

    const read = await readAll(f.node);
    expect(read.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(read.slice(0, 2).map((r) => r.id)).toEqual([
      uuidOf(f.qr.id),
      uuidOf(f.wifi.id),
    ]);
    for (const id of f.catalogIds)
      expect(read.map((r) => r.id)).not.toContain(id);

    // Not a hide: the rows left the queue and sit in the dead letters.
    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => Number(r.link_seq))).toEqual([1, 2, 3]);
    expect(await nextOutSeq(f.nodeId)).toBe(3);
    const dead = await deadLetterRows(f.nodeId);
    expect(dead.map((d) => d.event_id).sort()).toEqual(
      [...f.catalogIds].sort(),
    );
  }, 60_000);

  it("legend-3k41y the real cloud link pump does not throw on the renumbered queue and delivers outlet events in order", async () => {
    const f = await offlineBrandMove({ block: true });
    const frames: string[] = [];
    const closes: number[] = [];
    const errors: unknown[] = [];
    const peer = createLinkPeer({
      scope: {
        tenantId: f.world.tenantId,
        outletId: f.world.outletA,
        edgeNodeId: f.nodeId,
      },
      outboundDirection: "cloud_to_edge",
      store: cloudStore(f.node),
      version: "cloud",
      ackTimeoutMs: 60_000,
      transport: {
        send: (data) => frames.push(data),
        close: (code) => closes.push(code),
      },
      onError: (error) => errors.push(error),
    });
    try {
      peer.start();
      peer.receive(
        encodeFrame({ type: "hello", version: "edge", inboundCursor: "0" }),
      );
      await peer.idle();
      const delivered = frames
        .map((frame) => decodeFrame(frame))
        .flatMap((frame) =>
          frame?.type === "batch" ? frame.batch.events : [],
        );
      expect(errors).toEqual([]);
      expect(closes).toEqual([]);
      expect(delivered.map((e) => uuidOf(e.id)).slice(0, 2)).toEqual([
        uuidOf(f.qr.id),
        uuidOf(f.wifi.id),
      ]);
      expect(delivered).toHaveLength(3);
      for (const id of f.catalogIds)
        expect(delivered.map((e) => uuidOf(e.id))).not.toContain(id);
    } finally {
      peer.stop();
    }
  }, 60_000);

  it("legend-3k41y the pump also does not throw when the brand changed without blocked_at", async () => {
    const f = await offlineBrandMove({ block: false });
    const frames: string[] = [];
    const errors: unknown[] = [];
    const peer = createLinkPeer({
      scope: {
        tenantId: f.world.tenantId,
        outletId: f.world.outletA,
        edgeNodeId: f.nodeId,
      },
      outboundDirection: "cloud_to_edge",
      store: cloudStore(f.node),
      version: "cloud",
      ackTimeoutMs: 60_000,
      transport: { send: (data) => frames.push(data), close: () => undefined },
      onError: (error) => errors.push(error),
    });
    try {
      peer.start();
      peer.receive(
        encodeFrame({ type: "hello", version: "edge", inboundCursor: "0" }),
      );
      await peer.idle();
      const delivered = frames
        .map((frame) => decodeFrame(frame))
        .flatMap((frame) =>
          frame?.type === "batch" ? frame.batch.events : [],
        );
      expect(errors).toEqual([]);
      expect(delivered).toHaveLength(3);
      for (const id of f.catalogIds)
        expect(delivered.map((e) => uuidOf(e.id))).not.toContain(id);
    } finally {
      peer.stop();
    }
  }, 60_000);

  it("legend-3k41y acked events keep their number: only rows above the acked seq are dead-lettered or renumbered", async () => {
    const f = await offlineBrandMove({ block: false });
    // The edge acked the QR order (seq 1) and the first catalog event (seq 2)
    // before the move was noticed.
    await cloudStore(f.node).ackOutbound(2);

    const read = await readAll(f.node, 2);
    // Rows behind the acked prefix: remaining catalog gone, outlet events
    // renumbered down to start right after the acked seq.
    expect(read.map((r) => r.seq)).toEqual([3, 4]);
    expect(read[0]!.id).toBe(uuidOf(f.wifi.id));

    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => Number(r.link_seq))).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.event_id).toBe(uuidOf(f.qr.id));
    expect(rows[1]!.event_id).toBe(f.catalogIds[0]);
    expect(rows[1]!.aggregate_type).toBe("catalog_record");
    expect(rows[2]!.event_id).toBe(uuidOf(f.wifi.id));
    expect(await nextOutSeq(f.nodeId)).toBe(4);

    // The acked catalog event is not dead-lettered; only the pending ones are.
    const dead = await deadLetterRows(f.nodeId);
    expect(dead.map((d) => d.event_id).sort()).toEqual(
      f.catalogIds.slice(1).sort(),
    );
  }, 60_000);

  it("legend-3k41y reading again after the move changes nothing (idempotent)", async () => {
    const f = await offlineBrandMove({ block: true });
    const first = await readAll(f.node);
    await publish(f.world, f.world.outletA, f.node);
    const second = await readAll(f.node);
    expect(second).toEqual(first);
    expect(await queueRows(f.nodeId)).toHaveLength(3);
    const dead = await deadLetterRows(f.nodeId);
    expect(dead).toHaveLength(f.catalogIds.length);
  }, 60_000);

  it("legend-3k41y control: a sibling node on the old brand keeps its catalog rows and numbering", async () => {
    const f = await offlineBrandMove({ block: true });
    const rows = await queueRows(f.sibling.scope.edgeNodeId);
    expect(rows.some((r) => r.aggregate_type === "catalog_record")).toBe(true);
    expect(rows.map((r) => Number(r.link_seq))).toEqual(
      rows.map((_, i) => i + 1),
    );
    expect(await deadLetterRows(f.sibling.scope.edgeNodeId)).toEqual([]);
    const read = await readAll(f.sibling);
    expect(read.length).toBe(rows.length);
  }, 60_000);
});
