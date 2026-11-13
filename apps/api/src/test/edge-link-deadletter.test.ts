// legend-btx4d: an event above the link frame cap must not stall the outbound
// queue (it did: the peer only called onError and stopped, so every event
// behind it waited forever). Target behavior from
// docs/briefs/659-n1fzg-btx4d.md:
//   - the oversized event is moved to a dead-letter store, kept whole
//     (payload, size, link seq, reason), recorded once;
//   - one ops alarm goes out;
//   - the cursor moves past it and the queue behind it is delivered.
//
// ASSUMED CONTRACT (the brief names no API; engineer may rename, then adjust
// this file):
//   LinkStore.deadLetterOutbound(entry) -- entry = { linkSeq, event, bytes,
//     reason: "frame_too_large" }. The store records the dead letter
//     idempotently per event, removes it from the queue and RENUMBERS the events
//     behind it down by one (decided by the coordinator, option B: none of
//     them was ever sent, so the receiver's contiguous cursor never sees a
//     gap and the cloud side is untouched). readOutbound() stays contiguous
//     and the queue backlog no longer counts the dead letter.
//   createLinkPeer({ onDeadLetter }) -- called once per newly dead-lettered
//     event with the same entry (the runtime turns it into the ops alarm).
//   createDbLinkStore(...).listDeadLetters() -- returns the recorded entries
//     (each with the full original event) for this node and direction.
// Part 1 is a pure unit test of the peer; part 2 runs the Postgres store.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EDGE_LINK_DEAD_LETTERED_EVENT,
  edgeLinkDeadLetteredEvent,
} from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { applyEdgeLinkDeadLettered } from "../edge/link-dead-letter-applier.ts";
import type { EdgeEventApplier } from "../edge/ports.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  createLinkPeer,
  type LinkStore,
  type QueuedEdgeEvent,
} from "../edge/link-peer.ts";
import {
  decodeFrame,
  encodeFrame,
  LINK_MAX_FRAME_BYTES,
} from "../edge/protocol.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
} from "../services/edge-node.service.ts";
import {
  edgeQueueBacklog,
  enqueueEdgeEvent,
} from "../services/edge-queue.service.ts";

const OVERSIZE = 5 * 1024 * 1024; // above LINK_BATCH_MAX_BYTES (3 MB) and the 4 MB frame

const unitScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

let clock = Date.parse("2026-11-14T11:00:00.000Z");
function makeEvent(
  scope: { tenantId: string; outletId: string },
  sequence: number,
  bytes: number,
): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: scope.tenantId as EventEnvelope["tenantId"],
    outletId: scope.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `dl-${clock}-${sequence}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: { filler: "x".repeat(bytes), marker: `m${sequence}` },
  };
}

type DeadLetterEntry = {
  linkSeq: number;
  event: EventEnvelope;
  bytes: number;
  reason: string;
};

/** In-memory outbound store that follows the dead-letter contract (renumbers). */
class MemoryStore {
  queue: QueuedEdgeEvent[];
  /** Keyed by the link seq the event had when it was dead-lettered. */
  readonly deadLetters = new Map<number, DeadLetterEntry>();
  acked = 0;
  constructor(events: EventEnvelope[]) {
    this.queue = events.map((event, i) => ({ linkSeq: i + 1, event }));
  }
  asStore(): LinkStore {
    return {
      outboundHead: async () => this.queue.length,
      lastAckedOutbound: async () => this.acked,
      readOutbound: async (after, limit) =>
        this.queue.filter((q) => q.linkSeq > after).slice(0, limit),
      ackOutbound: async (upto) => {
        this.acked = Math.max(this.acked, upto);
      },
      deadLetterOutbound: async (entry: DeadLetterEntry) => {
        const at = this.queue.findIndex((q) => q.event.id === entry.event.id);
        if (at < 0) return; // replay: already dead-lettered and gone
        if (!this.deadLetters.has(entry.linkSeq))
          this.deadLetters.set(entry.linkSeq, entry);
        this.queue = this.queue
          .filter((_, i) => i !== at)
          .map((q, i) => ({ ...q, linkSeq: i + 1 }));
      },
      lastReceivedInbound: async () => 0,
      applyInbound: async () => undefined,
    } as LinkStore;
  }
}

function startPeer(store: LinkStore) {
  const frames: string[] = [];
  const closes: number[] = [];
  const alarms: DeadLetterEntry[] = [];
  const peer = createLinkPeer({
    scope: unitScope,
    outboundDirection: "edge_to_cloud",
    store,
    version: "test",
    ackTimeoutMs: 60_000,
    transport: {
      send: (data) => frames.push(data),
      close: (code) => closes.push(code),
    },
    onError: () => undefined,
    onDeadLetter: (entry: DeadLetterEntry) => alarms.push(entry),
  } as Parameters<typeof createLinkPeer>[0]);
  const delivered = () =>
    frames
      .map((frame) => decodeFrame(frame))
      .flatMap((frame) => (frame?.type === "batch" ? frame.batch.events : []));
  /** Hello from the cloud, then ack every batch until `want` ids arrived. */
  async function drain(want: number) {
    peer.receive(
      encodeFrame({ type: "hello", version: "cloud", inboundCursor: "0" }),
    );
    await peer.idle();
    for (let guard = 0; guard < 50 && delivered().length < want; guard += 1) {
      const last = frames
        .map((frame) => decodeFrame(frame))
        .filter((frame) => frame?.type === "batch")
        .at(-1);
      if (!last || last.type !== "batch") break;
      const batch = last.batch;
      peer.receive(
        encodeFrame({
          type: "ack",
          ack: {
            tenantId: batch.tenantId,
            outletId: batch.outletId,
            batchId: batch.id,
            peerId: batch.peerId,
            direction: batch.direction,
            cursor: batch.toCursor,
            lastEventId: batch.events.at(-1)!.id,
            acknowledgedAt: new Date(clock).toISOString(),
          },
        }),
      );
      await peer.idle();
    }
  }
  return { peer, frames, closes, alarms, delivered, drain };
}

describe("legend-btx4d oversized event is dead-lettered by the link peer", () => {
  it("legend-btx4d an oversized event in the middle is dead-lettered once, events before and after are delivered in order", async () => {
    const before = makeEvent(unitScope, 1, 100);
    const big = makeEvent(unitScope, 1, OVERSIZE);
    const after1 = makeEvent(unitScope, 1, 100);
    const after2 = makeEvent(unitScope, 1, 100);
    const mem = new MemoryStore([before, big, after1, after2]);
    const h = startPeer(mem.asStore());
    await h.drain(3);
    expect(h.closes).toEqual([]);
    for (const frame of h.frames)
      expect(frame.length).toBeLessThanOrEqual(LINK_MAX_FRAME_BYTES);
    expect(h.delivered().map((e) => e.id)).toEqual([
      before.id,
      after1.id,
      after2.id,
    ]);
    // Recorded once, whole, with seq and size and a reason.
    expect([...mem.deadLetters.keys()]).toEqual([2]);
    const entry = mem.deadLetters.get(2)!;
    expect(entry.event).toEqual(big);
    expect(entry.bytes).toBeGreaterThan(OVERSIZE);
    expect(entry.reason).toBeTruthy();
    // One alarm.
    expect(h.alarms).toHaveLength(1);
    expect(h.alarms[0]!.event.id).toBe(big.id);
  });

  it("legend-btx4d an oversized event at the head does not hold the queue: the next event is delivered", async () => {
    const big = makeEvent(unitScope, 1, OVERSIZE);
    const small = makeEvent(unitScope, 1, 100);
    const h = startPeer(new MemoryStore([big, small]).asStore());
    await h.drain(1);
    expect(h.delivered().map((e) => e.id)).toEqual([small.id]);
    expect(h.alarms).toHaveLength(1);
  });

  it("legend-btx4d reconnect (second hello) and a restarted peer on the same store do not dead-letter or alarm again", async () => {
    const big = makeEvent(unitScope, 1, OVERSIZE);
    const small = makeEvent(unitScope, 1, 100);
    const mem = new MemoryStore([big, small]);
    const first = startPeer(mem.asStore());
    await first.drain(1);
    expect(first.alarms).toHaveLength(1);
    // Cloud reconnects and asks again from the start.
    first.peer.receive(
      encodeFrame({ type: "hello", version: "cloud", inboundCursor: "0" }),
    );
    await first.peer.idle();
    expect(first.alarms).toHaveLength(1);
    // Edge process restarts: new peer, same durable store.
    const second = startPeer(mem.asStore());
    await second.drain(1);
    expect(second.alarms).toHaveLength(0);
    expect(mem.deadLetters.size).toBe(1);
    expect(second.delivered().every((e) => e.id !== big.id)).toBe(true);
  });

  it("legend-btx4d a normal queue (nothing oversized) records no dead letter and no alarm", async () => {
    const events = [1, 2, 3].map((n) => makeEvent(unitScope, n, 100));
    const mem = new MemoryStore(events);
    const h = startPeer(mem.asStore());
    await h.drain(3);
    expect(h.delivered().map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(mem.deadLetters.size).toBe(0);
    expect(h.alarms).toHaveLength(0);
  });
});

// ---- Part 2: Postgres link store -----------------------------------------

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
// A private outlet of the seeded tenant: edge-db.test.ts expects the seeded
// outlets to hold no edge nodes, and an outlet has one active node per role.
let outletB = "";
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const outletScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletB)] },
  );

let credential = "";
let nodeId = "";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji dead letter', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletB, `DL${outletB.slice(0, 8)}`.toUpperCase(), outlets[0].id],
  );
  const registered = await registerEdgeNode(outletScope(), actor, {
    outletId: outletB,
    role: "standby",
    label: "Dead-letter uji",
  });
  nodeId = registered.edgeNode.id;
  credential = registered.credential;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

describe("legend-btx4d Postgres link store dead-letters an oversized event", () => {
  it("legend-btx4d dead letter keeps the original event readable, is recorded once on replay, the cursor moves and later events stay readable", async () => {
    const node = await authenticateEdgeCredential(credential);
    const store = createDbLinkStore({
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "edge_to_cloud",
      classify: () => "transaction_event" as const,
    }) as ReturnType<typeof createDbLinkStore> & {
      deadLetterOutbound: (entry: DeadLetterEntry) => Promise<void>;
      listDeadLetters: () => Promise<DeadLetterEntry[]>;
    };
    const context = outletScope();
    const aggregates = [randomUUID(), randomUUID()];
    const big = makeEvent({ tenantId, outletId: outletB }, 1, OVERSIZE);
    const small = makeEvent({ tenantId, outletId: outletB }, 1, 100);
    const seqs = await withTenant(db, context, async (tx) => {
      const out: number[] = [];
      for (const [i, event] of [big, small].entries()) {
        const queued = await enqueueEdgeEvent(tx, context, {
          edgeNodeId: nodeId,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event: { ...event, aggregateId: aggregates[i]! },
        });
        out.push(queued.linkSeq);
      }
      return out;
    });
    const [bigSeq, smallSeq] = seqs as [number, number];

    const entry: DeadLetterEntry = {
      linkSeq: bigSeq,
      event: { ...big, aggregateId: aggregates[0]! },
      bytes: JSON.stringify(big).length,
      reason: "frame_too_large",
    };
    await store.deadLetterOutbound(entry);
    // Replay (redelivery, restart): still exactly one record.
    await store.deadLetterOutbound(entry);

    const letters = await store.listDeadLetters();
    expect(letters).toHaveLength(1);
    expect(letters[0]!.linkSeq).toBe(bigSeq);
    expect(letters[0]!.reason).toBe("frame_too_large");
    expect(letters[0]!.bytes).toBe(entry.bytes);
    // The original event is intact, payload included.
    expect(letters[0]!.event.id).toBe(big.id);
    expect(letters[0]!.event.payload).toEqual(entry.event.payload);

    // The notice for the cloud (legend-btx4d review) takes the dead event's
    // slot, so nothing behind it moves: still contiguous from the cursor.
    const readable = await store.readOutbound(0, 10);
    expect(readable.map((q) => q.linkSeq)).toEqual([bigSeq, bigSeq + 1]);
    expect(smallSeq).toBe(bigSeq + 1);
    expect(readable[1]!.event.id).toBe(small.id);
    expect(await store.outboundHead()).toBe(bigSeq + 1);
    const notice = readable[0]!.event;
    expect(notice.name).toBe(EDGE_LINK_DEAD_LETTERED_EVENT);
    expect(
      edgeLinkDeadLetteredEvent.envelopeSchema.safeParse(notice).success,
    ).toBe(true);
    expect(notice.payload).toEqual({
      eventId: big.id,
      eventName: big.name,
      aggregateType: big.aggregateType,
      aggregateId: aggregates[0]!,
      aggregateSequence: 1,
      linkSeq: bigSeq,
      bytes: entry.bytes,
      reason: "frame_too_large",
    });
    expect(JSON.stringify(notice).length).toBeLessThan(2000);

    // Acking the delivered events leaves nothing pending: the cursor moved
    // past the dead letter instead of being held behind it.
    await store.ackOutbound(bigSeq + 1);
    const backlog = await edgeQueueBacklog(
      db,
      context,
      nodeId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(0);
    // A fresh store over the same database (process restart) sees the same.
    const reopened = createDbLinkStore({
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "edge_to_cloud",
      classify: () => "transaction_event" as const,
    }) as typeof store;
    expect(await reopened.listDeadLetters()).toHaveLength(1);
  });
});

// ---- legend-btx4d review: cloud trace, later events, trigger guard ----------

/** The primary of outlet B: its own cursors, apart from the standby above. */
async function primaryNode(label: string) {
  const registered = await registerEdgeNode(outletScope(), actor, {
    outletId: outletB,
    role: "primary",
    label,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return { nodeId: registered.edgeNode.id, node };
}

/** The standby registered in beforeAll. */
async function sharedNode() {
  const node = await authenticateEdgeCredential(credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return { nodeId, node };
}

function edgeStore(node: Awaited<ReturnType<typeof sharedNode>>["node"]) {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
    classify: () => "transaction_event" as const,
  });
}

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    return `${String(error)} ${String(cause ?? "")}`;
  }
  return "";
}

function enqueueEdgeEventFor(
  tx: Parameters<Parameters<typeof withTenant>[2]>[0],
  edgeNodeId: string,
  event: EventEnvelope,
) {
  return enqueueEdgeEvent(tx, outletScope(), {
    edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    event,
  });
}

/**
 * The cloud's side of the primary node of outlet B, with only the dead-letter
 * applier. One node serves every test (an outlet has one active primary), so
 * each test delivers from the node's current inbound cursor.
 */
let cloudSideOnce: ReturnType<typeof buildCloudSide> | null = null;
function cloudSide() {
  cloudSideOnce ??= buildCloudSide();
  return cloudSideOnce;
}
async function buildCloudSide() {
  const { nodeId: cloudNodeId, node } = await primaryNode("Cloud jejak");
  const applier: EdgeEventApplier<EdgeTx> = {
    async apply(tx, event, meta) {
      if (event.name === EDGE_LINK_DEAD_LETTERED_EVENT)
        await applyEdgeLinkDeadLettered(tx, event, meta);
    },
  };
  const store = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
    applier,
    classify: () => "transaction_event" as const,
  });
  const deliver = async (events: EventEnvelope[]) => {
    const fromSeq = await store.lastReceivedInbound();
    await store.applyInbound({
      fromSeq,
      toSeq: fromSeq + events.length,
      events: events.map((event, i) => ({ linkSeq: fromSeq + i + 1, event })),
    });
  };
  const rowsOf = (aggregateIds: string[]) =>
    withTenant(db, outletScope(), async (tx) => {
      const conflicts = await tx.execute(
        sql`SELECT reason, aggregate_id, aggregate_sequence, event_id FROM edge_sync_conflicts WHERE edge_node_id = ${cloudNodeId}::uuid`,
      );
      const receipts = await tx.execute(
        sql`SELECT event_id, aggregate_id, outcome FROM edge_inbound_events WHERE edge_node_id = ${cloudNodeId}::uuid ORDER BY link_seq`,
      );
      const inScope = (row: Record<string, unknown>) =>
        aggregateIds.includes(String(row.aggregate_id));
      return {
        conflicts: conflicts.rows.filter(inScope),
        receipts: receipts.rows.filter(inScope),
      };
    });
  return { store, nodeId: cloudNodeId, deliver, rowsOf };
}

function deadLetterNotice(
  dead: EventEnvelope,
  overrides: { aggregateId?: string } = {},
): EventEnvelope {
  clock += 1;
  return edgeLinkDeadLetteredEvent.envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId: outletB,
    name: EDGE_LINK_DEAD_LETTERED_EVENT,
    version: 1,
    aggregateType: "edge_link",
    aggregateId: overrides.aggregateId ?? dead.id,
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${EDGE_LINK_DEAD_LETTERED_EVENT}:${dead.id}`,
    payloadSchemaRef: `${EDGE_LINK_DEAD_LETTERED_EVENT}.v1`,
    payload: {
      eventId: dead.id,
      eventName: dead.name,
      aggregateType: dead.aggregateType,
      aggregateId: dead.aggregateId,
      aggregateSequence: dead.sequence,
      linkSeq: 2,
      bytes: OVERSIZE,
      reason: "frame_too_large",
    },
  }) as EventEnvelope;
}

describe("legend-btx4d review: the cloud keeps a trace of a dead-lettered sale", () => {
  // Round 2: the next event of the same aggregate is ALREADY pending behind
  // the dead one when it is dead-lettered. The notice must take the dead
  // event's own slot, so the cloud meets it before that next event.
  it("the notice takes the dead event's slot; the cloud records one conflict and the pending next sequence of the aggregate is applied, not a gap", async () => {
    const { node } = await sharedNode();
    const store = edgeStore(node);
    const context = outletScope();
    const scope = { tenantId, outletId: outletB };
    const aggregateId = randomUUID();
    const first = { ...makeEvent(scope, 1, 100), aggregateId };
    const dead = { ...makeEvent(scope, 2, OVERSIZE), aggregateId };
    const third = { ...makeEvent(scope, 3, 100), aggregateId };
    const queue = (event: EventEnvelope) =>
      withTenant(db, context, (tx) => enqueueEdgeEventFor(tx, nodeId, event));
    const firstQueued = await queue(first);
    await store.ackOutbound(firstQueued.linkSeq);
    const deadQueued = await queue(dead);
    const thirdQueued = await queue(third);
    await store.deadLetterOutbound({
      linkSeq: deadQueued.linkSeq,
      event: dead,
      bytes: JSON.stringify(dead).length,
      reason: "frame_too_large",
    });
    // Edge queue: the notice sits where the dead event was, the next event of
    // the aggregate behind it, nothing renumbered, the head did not move.
    const behind = await store.readOutbound(firstQueued.linkSeq, 10);
    expect(behind.map((q) => q.linkSeq)).toEqual([
      deadQueued.linkSeq,
      thirdQueued.linkSeq,
    ]);
    expect(behind.map((q) => q.event.name)).toEqual([
      EDGE_LINK_DEAD_LETTERED_EVENT,
      third.name,
    ]);
    expect(await store.outboundHead()).toBe(thirdQueued.linkSeq);

    const cloud = await cloudSide();
    await cloud.deliver([first, ...behind.map((q) => q.event)]);
    const rows = await cloud.rowsOf([aggregateId]);
    // Exactly one conflict, for the dead event, and none for a sequence gap.
    expect(rows.conflicts).toHaveLength(1);
    expect(rows.conflicts[0]).toMatchObject({
      reason: "link_event_dead_lettered",
      aggregate_id: aggregateId,
      aggregate_sequence: "2",
      event_id: ulidToUuid(dead.id),
    });
    expect(
      rows.receipts.find((row) => row.event_id === ulidToUuid(third.id))
        ?.outcome,
    ).toBe("applied");
  });

  it("a notice whose aggregate id is not the dead event id is refused as a conflict and the dead sequence is not counted as used", async () => {
    const scope = { tenantId, outletId: outletB };
    const aggregateId = randomUUID();
    const first = { ...makeEvent(scope, 1, 100), aggregateId };
    const dead = { ...makeEvent(scope, 2, OVERSIZE), aggregateId };
    const third = { ...makeEvent(scope, 3, 100), aggregateId };
    const forged = deadLetterNotice(dead, { aggregateId: createUlid() });
    const cloud = await cloudSide();
    await cloud.deliver([first, forged, third]);
    const rows = await cloud.rowsOf([aggregateId, forged.aggregateId]);
    // The forged notice is a refused-applier conflict, nothing marks the dead
    // event applied, so the third event is still a real gap.
    expect(rows.conflicts.map((c) => c.reason).sort()).toEqual([
      "applier_refused",
      "sequence_gap",
    ]);
    expect(
      rows.conflicts.find((c) => c.reason === "applier_refused")?.event_id,
    ).toBe(ulidToUuid(forged.id));
    expect(
      rows.receipts.some((row) => row.event_id === ulidToUuid(dead.id)),
    ).toBe(false);
    expect(
      rows.receipts.find((row) => row.event_id === ulidToUuid(third.id))
        ?.outcome,
    ).toBe("conflict");
  });
});

describe("legend-btx4d review: events behind a dead letter of the same aggregate", () => {
  it("the next sequence of the aggregate is still queued after its predecessor was dead-lettered", async () => {
    const { nodeId: id, node } = await sharedNode();
    const store = edgeStore(node);
    const context = outletScope();
    const scope = { tenantId, outletId: outletB };
    const aggregateId = randomUUID();
    const queue = (event: EventEnvelope) =>
      withTenant(db, context, (tx) =>
        enqueueEdgeEvent(tx, context, {
          edgeNodeId: id,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event: { ...event, aggregateId },
        }),
      );
    const one = makeEvent(scope, 1, 100);
    const big = makeEvent(scope, 2, OVERSIZE);
    const next = makeEvent(scope, 3, 100);
    const oneQueued = await queue(one);
    await store.ackOutbound(oneQueued.linkSeq);
    const bigQueued = await queue(big);
    await store.deadLetterOutbound({
      linkSeq: bigQueued.linkSeq,
      event: { ...big, aggregateId },
      bytes: JSON.stringify(big).length,
      reason: "frame_too_large",
    });
    await expect(queue(next)).resolves.toMatchObject({ duplicate: false });
  });
});

describe("legend-btx4d review: cloud to edge keeps the renumbering", () => {
  it("a dead-lettered cloud event is renumbered away: no notice, the rows behind move down by one and the head steps back", async () => {
    const cloud = await cloudSide();
    const context = outletScope();
    const scope = { tenantId, outletId: outletB };
    const events = [1, 2, 3].map((n) => makeEvent(scope, n, 100));
    const seqs: number[] = [];
    for (const event of events) {
      const queued = await withTenant(db, context, (tx) =>
        enqueueEdgeEvent(tx, context, {
          edgeNodeId: cloud.nodeId,
          direction: "cloud_to_edge",
          kind: "transaction_event",
          event: { ...event, aggregateId: randomUUID() },
        }),
      );
      seqs.push(queued.linkSeq);
    }
    const [first, second, third] = seqs as [number, number, number];
    const head = await cloud.store.outboundHead();
    await cloud.store.deadLetterOutbound({
      linkSeq: first,
      event: events[0]!,
      bytes: OVERSIZE,
      reason: "frame_too_large",
    });
    const behind = await cloud.store.readOutbound(first - 1, 10);
    expect(behind.map((q) => q.linkSeq)).toEqual([first, second]);
    expect(behind.map((q) => q.event.id)).toEqual([
      events[1]!.id,
      events[2]!.id,
    ]);
    expect(third).toBe(second + 1);
    expect(await cloud.store.outboundHead()).toBe(head - 1);
    expect(await cloud.store.listDeadLetters()).toHaveLength(1);
  });
});

describe("legend-btx4d review: the queue guard only allows the dead-letter renumbering", () => {
  it("a pending link_seq cannot jump anywhere, even while the dead-letter marker is on", async () => {
    const { nodeId: id } = await sharedNode();
    const context = outletScope();
    const scope = { tenantId, outletId: outletB };
    const seqs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const queued = await withTenant(db, context, (tx) =>
        enqueueEdgeEventFor(tx, id, makeEvent(scope, 1, 100)),
      );
      seqs.push(queued.linkSeq);
    }
    const last = seqs[2]!;
    const attempt = (target: string) =>
      rejection(
        withTenant(db, context, async (tx) => {
          await tx.execute(
            sql`SELECT set_config('app.edge_dead_letter', 'on', true)`,
          );
          await tx.execute(
            sql.raw(
              `UPDATE edge_outbound_queue SET link_seq = ${target} WHERE edge_node_id = '${id}'::uuid AND direction = 'edge_to_cloud' AND link_seq = ${last}`,
            ),
          );
        }),
      );
    // Forward, back by two, and into the parking zone off the exact step.
    expect(await attempt(`link_seq + 7`)).toContain("immutable");
    expect(await attempt(`link_seq - 2`)).toContain("immutable");
    expect(await attempt(`link_seq + 1000000000001`)).toContain("immutable");
  });
});
