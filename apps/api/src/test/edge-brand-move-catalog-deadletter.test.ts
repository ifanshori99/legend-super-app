// legend-3k41y, placeholder semantics (CTO decision, replaces option C
// "renumber"): stale `catalog_record` rows of a node whose outlet brand moved
// are neutralised IN PLACE. The full original event goes to
// edge_link_dead_letters (reason 'brand_moved', link_seq = its slot) and the
// queue row keeps its link_seq but carries a no-op placeholder event. Nothing
// is renumbered, next_out_seq does not move, and no hole appears, so the link
// pump never throws "Outbound queue is not contiguous" and the edge's cursor
// stays valid. Written from the brief and the queue/dead-letter table
// contract (migrations), not from the implementation.
//
// Rules under test:
//  - Node blocked by the publisher (brand moved): its pending catalog_record
//    rows are replaced in place in the same transaction (no queue read
//    needed); the dead letters hold the full original event at the same slot.
//  - Brand changed with NO blocked_at (publisher never ran; raw UPDATE, no
//    service hook): the read-time safety net replaces the rows the same way,
//    it never just hides them.
//  - Outlet-scoped events (QR order, Wi-Fi quota, panic alert) are never
//    replaced or dead-lettered, keep their order, their link_seq, and keep
//    flowing.
//  - Rows at or below the edge-acked seq are never replaced or dead-lettered.
//  - A real cloud link peer on the db link store does not throw and delivers
//    every slot at its own link_seq.
//
// Assumptions:
//  - Queue before the move (the node is offline): qr_order (seq 1), the
//    published catalog_record events (seq 2..1+c, c >= 1), wifi_quota, panic.
//    c is read from the queue, not hard-coded.
//  - The placeholder event type name is not fixed: tests assert that the slot
//    no longer holds a catalog_record event (aggregateType) and does not leak
//    the old record content, never the placeholder's name.
//  - The dead-letter `reason` is 'brand_moved' (fixed by the brief).
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
  event: EventEnvelope;
};

async function queueRows(nodeId: string): Promise<QueueRow[]> {
  const res = await owner.query<QueueRow>(
    `SELECT link_seq::text, event_id, aggregate_type, status, event FROM edge_outbound_queue
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
    event: EventEnvelope;
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
  // Three categories so that c >= 2 (the acked-prefix test needs a pending one).
  for (let i = 0; i < 3; i += 1)
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), world.tenantId, world.brandId, `Brand A before move ${i}`],
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
  expect(catalog.length).toBeGreaterThanOrEqual(2);
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
    /** The queue exactly as it was before the move (events included). */
    before,
  };
}

/** The ids of what the cloud would send, with the link_seq it sends them at. */
async function readAll(node: Authenticated, afterSeq = 0) {
  const read = await cloudStore(node).readOutbound(afterSeq, 1000);
  return read.map((item) => ({ seq: item.linkSeq, id: uuidOf(item.event.id) }));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => from + k);

/** A slot no longer carries a catalog event (placeholder or outlet event). */
const isCatalog = (event: { aggregateType: string }) =>
  event.aggregateType === "catalog_record";

/** The first catalog slot is seq 2; the outlet events are qr (1), wifi, panic. */
function slots(f: Awaited<ReturnType<typeof offlineBrandMove>>) {
  const c = f.catalogIds.length;
  return {
    c,
    catalog: range(2, 1 + c),
    wifi: 2 + c,
    panic: 3 + c,
    n: c + 3,
  };
}

/** Catalog slots hold a placeholder: same seq, same status, no old content. */
function expectCatalogNeutralised(
  f: Awaited<ReturnType<typeof offlineBrandMove>>,
  rows: QueueRow[],
  seqs: number[],
) {
  for (const seq of seqs) {
    const row = rows.find((r) => Number(r.link_seq) === seq);
    expect(row, `queue row ${seq}`).toBeDefined();
    expect(row!.event.aggregateType).not.toBe("catalog_record");
    expect(JSON.stringify(row!.event)).not.toContain("Brand A before move");
    expect(row!.status).toBe(
      f.before.find((b) => Number(b.link_seq) === seq)!.status,
    );
  }
}

/** The dead letters hold the full original event at the slot it had. */
async function expectDeadLettersHoldOriginals(
  f: Awaited<ReturnType<typeof offlineBrandMove>>,
  seqs: number[],
) {
  const dead = await deadLetterRows(f.nodeId);
  expect(dead.map((d) => Number(d.link_seq))).toEqual(seqs);
  for (const row of dead) {
    const original = f.before.find(
      (b) => Number(b.link_seq) === Number(row.link_seq),
    )!;
    expect(row.reason).toBe("brand_moved");
    expect(row.aggregate_type).toBe("catalog_record");
    expect(row.event_id).toBe(original.event_id);
    expect(row.event).toEqual(original.event);
  }
  // Outlet-scoped events are never dead-lettered.
  const deadIds = dead.map((d) => d.event_id);
  for (const id of [uuidOf(f.qr.id), uuidOf(f.wifi.id)])
    expect(deadIds).not.toContain(id);
}

/** qr, wifi and panic rows are exactly as queued: same slot, same event. */
function expectOutletEventsUntouched(
  f: Awaited<ReturnType<typeof offlineBrandMove>>,
  rows: QueueRow[],
  options: { status: boolean } = { status: true },
) {
  const { wifi, panic } = slots(f);
  for (const seq of [1, wifi, panic]) {
    const row = rows.find((r) => Number(r.link_seq) === seq)!;
    const original = f.before.find((b) => Number(b.link_seq) === seq)!;
    expect(row.event_id).toBe(original.event_id);
    expect(row.event).toEqual(original.event);
    if (options.status) expect(row.status).toBe(original.status);
  }
}

describe("legend-3k41y placeholder: stale catalog rows are neutralised in place, nothing is renumbered", () => {
  it("legend-3k41y a blocked node's queue read keeps every slot: outlet events at their own seq, catalog slots are placeholders", async () => {
    const f = await offlineBrandMove({ block: true });
    const s = slots(f);
    const read = await cloudStore(f.node).readOutbound(0, 1000);
    // Same numbering as before the move: 1..n, no hole.
    expect(read.map((q) => q.linkSeq)).toEqual(range(1, s.n));
    expect(read.some((q) => isCatalog(q.event))).toBe(false);
    // The outlet events sit where they always did.
    expect(uuidOf(read[0]!.event.id)).toBe(uuidOf(f.qr.id));
    expect(uuidOf(read[s.wifi - 1]!.event.id)).toBe(uuidOf(f.wifi.id));
    const panic = read[s.panic - 1]!;
    expect(panic.linkSeq).toBe(s.panic);
    expect(panic.event.aggregateId).toBe(f.alertId);
    // Reading from the middle lands on the same seqs.
    const tail = await cloudStore(f.node).readOutbound(s.wifi - 1, 10);
    expect(tail.map((q) => q.linkSeq)).toEqual([s.wifi, s.panic]);
    expect(uuidOf(tail[0]!.event.id)).toBe(uuidOf(f.wifi.id));
  }, 60_000);

  it("legend-3k41y blocking the node replaces the catalog rows in place in the same transaction, before any queue read", async () => {
    const f = await offlineBrandMove({ block: true });
    const s = slots(f);
    // No readOutbound has run: the publisher's block did the work.
    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => Number(r.link_seq))).toEqual(range(1, s.n));
    expectCatalogNeutralised(f, rows, s.catalog);
    expectOutletEventsUntouched(f, rows);
    // No renumber: the queue cursor did not move.
    expect(await nextOutSeq(f.nodeId)).toBe(s.n);
    await expectDeadLettersHoldOriginals(f, s.catalog);
  }, 60_000);

  it("legend-3k41y a brand change without blocked_at is caught lazily by the queue read: replaced in place, not just hidden", async () => {
    const f = await offlineBrandMove({ block: false });
    const s = slots(f);
    const state = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.nodeId],
    );
    expect(state.rows.every((row) => row.blocked_at === null)).toBe(true);

    const read = await cloudStore(f.node).readOutbound(0, 1000);
    expect(read.map((q) => q.linkSeq)).toEqual(range(1, s.n));
    expect(read.some((q) => isCatalog(q.event))).toBe(false);
    expect(uuidOf(read[0]!.event.id)).toBe(uuidOf(f.qr.id));
    expect(uuidOf(read[s.wifi - 1]!.event.id)).toBe(uuidOf(f.wifi.id));

    // Not a hide: the stored rows were replaced and the originals saved.
    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => Number(r.link_seq))).toEqual(range(1, s.n));
    expectCatalogNeutralised(f, rows, s.catalog);
    expectOutletEventsUntouched(f, rows);
    expect(await nextOutSeq(f.nodeId)).toBe(s.n);
    await expectDeadLettersHoldOriginals(f, s.catalog);
  }, 60_000);

  it("legend-3k41y the real cloud link pump does not throw and delivers every slot, outlet events in order", async () => {
    const f = await offlineBrandMove({ block: true });
    const s = slots(f);
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
      // Every slot goes out, in slot order, none of them a catalog event.
      expect(delivered).toHaveLength(s.n);
      expect(delivered.some((e) => isCatalog(e))).toBe(false);
      expect(uuidOf(delivered[0]!.id)).toBe(uuidOf(f.qr.id));
      expect(uuidOf(delivered[s.wifi - 1]!.id)).toBe(uuidOf(f.wifi.id));
      expect(delivered[s.panic - 1]!.aggregateId).toBe(f.alertId);
    } finally {
      peer.stop();
    }
  }, 60_000);

  it("legend-3k41y the pump also does not throw when the brand changed without blocked_at", async () => {
    const f = await offlineBrandMove({ block: false });
    const s = slots(f);
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
      expect(delivered).toHaveLength(s.n);
      expect(delivered.some((e) => isCatalog(e))).toBe(false);
      expect(delivered[s.panic - 1]!.aggregateId).toBe(f.alertId);
    } finally {
      peer.stop();
    }
  }, 60_000);

  it("legend-3k41y acked events keep their event: only pending catalog rows above the acked seq are replaced or dead-lettered", async () => {
    const f = await offlineBrandMove({ block: false });
    const s = slots(f);
    // The edge acked the QR order (seq 1) and the first catalog event (seq 2)
    // before the move was noticed.
    await cloudStore(f.node).ackOutbound(2);

    const read = await cloudStore(f.node).readOutbound(2, 1000);
    // Everything above the acked prefix keeps its own seq.
    expect(read.map((q) => q.linkSeq)).toEqual(range(3, s.n));
    expect(read.some((q) => isCatalog(q.event))).toBe(false);
    expect(uuidOf(read[s.wifi - 3]!.event.id)).toBe(uuidOf(f.wifi.id));

    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => Number(r.link_seq))).toEqual(range(1, s.n));
    expect(rows[0]!.event_id).toBe(uuidOf(f.qr.id));
    // The acked catalog event is still the real one.
    expect(rows[1]).toMatchObject({
      event_id: f.catalogIds[0],
      aggregate_type: "catalog_record",
    });
    expect(rows[1]!.event).toEqual(f.before[1]!.event);
    expectCatalogNeutralised(f, rows, s.catalog.slice(1));
    expectOutletEventsUntouched(f, rows, { status: false });
    expect(await nextOutSeq(f.nodeId)).toBe(s.n);

    // Only the pending ones are dead-lettered.
    await expectDeadLettersHoldOriginals(f, s.catalog.slice(1));
  }, 60_000);

  it("legend-3k41y reading again after the move changes nothing (idempotent)", async () => {
    const f = await offlineBrandMove({ block: true });
    const s = slots(f);
    const first = await readAll(f.node);
    const rowsFirst = await queueRows(f.nodeId);
    const deadFirst = await deadLetterRows(f.nodeId);
    await publish(f.world, f.world.outletA, f.node);
    const second = await readAll(f.node);
    expect(second).toEqual(first);
    expect(await queueRows(f.nodeId)).toEqual(rowsFirst);
    expect(await deadLetterRows(f.nodeId)).toEqual(deadFirst);
    expect(deadFirst).toHaveLength(f.catalogIds.length);
    expect(first.map((r) => r.seq)).toEqual(range(1, s.n));
    expect(await nextOutSeq(f.nodeId)).toBe(s.n);
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
    const sent = await cloudStore(f.sibling).readOutbound(0, 1000);
    expect(sent.every((q) => isCatalog(q.event))).toBe(true);
  }, 60_000);
});
