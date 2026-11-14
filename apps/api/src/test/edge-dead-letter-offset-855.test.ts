// legend-fgd9b (855): after a rebind of the edge database (the cloud keeps
// sync_cursors.peer_seq_offset != 0 for the edge_to_cloud direction), the
// receipt that a dead-letter notice leaves for the dead event must land in the
// SAME inbound slot as every other receipt: edge link slot + peer_seq_offset.
// It used to use the raw edge link slot, so it collided with / landed among the
// receipts of the previous instance and the slots no longer matched the edge
// numbering that the restore proof digests.
//
// Written from docs/briefs/855-edge-slot-dan-sisa.md and the existing
// edge-link-deadletter / edge-link-restore-proof-db tests, not from the
// implementation.
//
// Assumptions:
// - A rebind state is reached the way the real link leaves it: three events of
//   the old instance were received (received_in_seq = 3), then the cursor holds
//   the new instance and peer_seq_offset = 3. The cursor is updated directly
//   (owner connection, same two steps the DB trigger allows: adopt the old
//   instance, then switch instance with a higher offset) to keep this a DB test
//   without a WebSocket; the store is opened with edgeInstanceId = new instance.
// - Edge numbering restarts at 1 for the new instance: edge slot k is stored in
//   edge_inbound_events.link_seq = k + 3.
// - The dead-letter receipt is the edge_inbound_events row whose event_id is
//   the DEAD event (the forged-notice test of edge-link-deadletter shows no
//   such row exists when the notice is refused).
import { randomUUID } from "node:crypto";
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
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { applyEdgeLinkDeadLettered } from "../edge/link-dead-letter-applier.ts";
import type { EdgeEventApplier } from "../edge/ports.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const OVERSIZE = 5 * 1024 * 1024;
const OFFSET = 3;

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const outletIds: string[] = [];
const scopeOf = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

let clock = Date.parse("2026-11-15T09:00:00.000Z");
function makeEvent(
  outletId: string,
  aggregateId: string,
  sequence: number,
  filler = 10,
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
    idempotencyKey: `dl855-${clock}-${sequence}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: { filler: "x".repeat(filler), marker: `m${sequence}` },
  };
}

function deadLetterNotice(
  outletId: string,
  dead: EventEnvelope,
  linkSeq: number,
): EventEnvelope {
  clock += 1;
  return edgeLinkDeadLetteredEvent.envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId,
    name: EDGE_LINK_DEAD_LETTERED_EVENT,
    version: 1,
    aggregateType: "edge_link",
    aggregateId: dead.id,
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
      linkSeq,
      bytes: OVERSIZE,
      reason: "frame_too_large",
    },
  }) as EventEnvelope;
}

/** A fresh outlet of the seeded tenant with its own primary node. */
async function freshPrimary(label: string) {
  const outletId = randomUUID();
  outletIds.push(outletId);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji dead letter offset', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `DO${outletId.slice(0, 8)}`.toUpperCase(), outlets[0].id],
  );
  const registered = await registerEdgeNode(scopeOf(outletId), actor, {
    outletId,
    role: "primary",
    label,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return { outletId, node, nodeId: registered.edgeNode.id };
}

/** The cloud's side of the node, with only the dead-letter applier. */
function cloudStore(node: AuthenticatedEdgeNode, edgeInstanceId?: string) {
  const applier: EdgeEventApplier<EdgeTx> = {
    async apply(tx, event, meta) {
      if (event.name === EDGE_LINK_DEAD_LETTERED_EVENT)
        await applyEdgeLinkDeadLettered(tx, event, meta);
    },
  };
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
    applier,
    classify: () => "transaction_event" as const,
    ...(edgeInstanceId ? { edgeInstanceId } : {}),
  });
}

/** Deliver events whose edge slots follow the store's current inbound cursor. */
async function deliver(
  store: ReturnType<typeof cloudStore>,
  events: EventEnvelope[],
) {
  const fromSeq = await store.lastReceivedInbound();
  await store.applyInbound({
    fromSeq,
    toSeq: fromSeq + events.length,
    events: events.map((event, i) => ({ linkSeq: fromSeq + i + 1, event })),
  });
  return fromSeq;
}

type Receipt = { link_seq: number; event_id: string; outcome: string };
async function receipts(nodeId: string): Promise<Receipt[]> {
  const { rows } = await owner.query<Receipt>(
    `SELECT link_seq::int AS link_seq, event_id::text AS event_id, outcome
       FROM edge_inbound_events
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
      ORDER BY link_seq, event_id`,
    [tenantId, nodeId],
  );
  return rows;
}

async function conflictReasons(nodeId: string) {
  const { rows } = await owner.query<{ reason: string }>(
    `SELECT reason FROM edge_sync_conflicts WHERE tenant_id = $1 AND edge_node_id = $2`,
    [tenantId, nodeId],
  );
  return rows.map((row) => row.reason).sort();
}

async function cursor(nodeId: string) {
  const { rows } = await owner.query<{
    received_in_seq: number;
    peer_seq_offset: number;
  }>(
    `SELECT received_in_seq::int AS received_in_seq, peer_seq_offset::int AS peer_seq_offset
       FROM sync_cursors
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
    [tenantId, nodeId],
  );
  return rows[0];
}

/**
 * Old instance delivered `warm` events (edge slots 1..3), then the node was
 * rebound to instance `instanceId`: edge numbering restarts, offset = 3.
 */
async function rebind(
  fx: Awaited<ReturnType<typeof freshPrimary>>,
  instanceId: string,
) {
  const old = cloudStore(fx.node);
  const warm = [1, 2, 3].map(() => makeEvent(fx.outletId, randomUUID(), 1));
  await deliver(old, warm);
  // The cursor adopts the old instance (offset 0), then the rebuilt database
  // (a new instance, numbering from 0) is bound with the three received slots
  // as offset. The trigger only allows this order (adopt, then rebase).
  const setInstance = (id: string, offset?: number) =>
    owner.query(
      `UPDATE sync_cursors SET peer_instance_id = $3${offset === undefined ? "" : ", peer_seq_offset = $4"}
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
      [tenantId, fx.nodeId, id, ...(offset === undefined ? [] : [offset])],
    );
  await setInstance(randomUUID());
  await setInstance(instanceId, OFFSET);
  expect(await cursor(fx.nodeId)).toMatchObject({
    received_in_seq: OFFSET,
    peer_seq_offset: OFFSET,
  });
  const store = cloudStore(fx.node, instanceId);
  expect(await store.lastReceivedInbound()).toBe(0);
  return { warm, store };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

describe("legend-fgd9b dead-letter receipt uses the offset-translated slot", () => {
  it("legend-fgd9b control: without a rebind (offset 0) the dead event's receipt sits at the plain edge slot", async () => {
    const fx = await freshPrimary("Dead letter offset 0");
    const store = cloudStore(fx.node);
    const aggregateId = randomUUID();
    const first = makeEvent(fx.outletId, aggregateId, 1);
    const dead = makeEvent(fx.outletId, aggregateId, 2, OVERSIZE);
    const third = makeEvent(fx.outletId, aggregateId, 3);
    const notice = deadLetterNotice(fx.outletId, dead, 2);
    await deliver(store, [first, notice, third]);

    const rows = await receipts(fx.nodeId);
    expect(
      rows.find((row) => row.event_id === ulidToUuid(dead.id))?.link_seq,
    ).toBe(2);
    expect(
      rows.find((row) => row.event_id === ulidToUuid(third.id))?.outcome,
    ).toBe("applied");
  });

  it("legend-fgd9b after a rebind the dead event's receipt is at edge slot + peer_seq_offset, in line with the receipts around it", async () => {
    const fx = await freshPrimary("Dead letter offset 3");
    const { warm, store } = await rebind(fx, randomUUID());
    const aggregateId = randomUUID();
    const first = makeEvent(fx.outletId, aggregateId, 1);
    const dead = makeEvent(fx.outletId, aggregateId, 2, OVERSIZE);
    const third = makeEvent(fx.outletId, aggregateId, 3);
    // New instance, edge slots 1..3: first, the notice standing in the dead
    // event's slot (2), the next event of the aggregate.
    const notice = deadLetterNotice(fx.outletId, dead, 2);
    expect(await deliver(store, [first, notice, third])).toBe(0);

    const rows = await receipts(fx.nodeId);
    const slotOf = (event: EventEnvelope) =>
      rows.find((row) => row.event_id === ulidToUuid(event.id))?.link_seq;

    // Old instance receipts stay in slots 1..3.
    expect(warm.map(slotOf)).toEqual([1, 2, 3]);
    // New instance: edge slot k is stored at k + OFFSET, same as its neighbours.
    expect(slotOf(first)).toBe(1 + OFFSET);
    expect(slotOf(dead)).toBe(2 + OFFSET);
    expect(slotOf(third)).toBe(3 + OFFSET);
    // One counted receipt per slot, no slot shared between instances. The
    // dead event's receipt shares slot 2 + OFFSET with the notice that stands
    // in that slot by design (it is not counted: the dead event is not in
    // edge_received_events, legend-tmar2 R3).
    const slots = rows
      .filter((row) => row.event_id !== ulidToUuid(dead.id))
      .map((row) => row.link_seq);
    expect(new Set(slots).size).toBe(slots.length);
    // The dead sequence counts as used: the third event is applied, no gap.
    expect(
      rows.find((row) => row.event_id === ulidToUuid(third.id))?.outcome,
    ).toBe("applied");
    // The cursor moved past the three new slots.
    expect(await store.lastReceivedInbound()).toBe(3);
    expect((await cursor(fx.nodeId))?.received_in_seq).toBe(3 + OFFSET);
    // Only the dead event itself is a conflict; nothing else.
    expect(await conflictReasons(fx.nodeId)).toEqual([
      "link_event_dead_lettered",
    ]);
  });
});
