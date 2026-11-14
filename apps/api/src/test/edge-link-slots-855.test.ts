// legend-pz641 (855): table edge_link_slots, one row per link slot held by a
// COUNTED receipt, so the restore proof reads an index range instead of
// scanning every receipt of the node.
//
// Written from docs/briefs/855-edge-slot-dan-sisa.md (section legend-pz641) and
// the existing 854 db tests, not from the implementation.
//
// Assumptions (the brief is silent on exact shapes):
// - Columns of edge_link_slots: tenant_id, outlet_id, edge_node_id, direction,
//   link_seq (stored number = edge number + peer_seq_offset), event_id,
//   created_at; PK (tenant_id, edge_node_id, direction, link_seq).
// - The cloud store (outboundDirection cloud_to_edge) holds its inbound slots
//   in direction 'edge_to_cloud'.
// - applyInbound registers an applied event in edge_received_events, so with a
//   no-op applier an applied event still counts (the brief: "applyInbound
//   (applied and already_received superseded)" write the slot).
// - A slot held by ANOTHER event during applyInbound: the receipt is still
//   written, the slot keeps its holder, and logger.warn is called once or more.
// - RESTORE_PROOF_MAX_SLOTS is 100_000 (the brief); inboundProof over a wider
//   range returns the prefix of the first 100_000 slots (to = from + 100_000).
// - The backfill is the INSERT INTO edge_link_slots statement(s) of the
//   migration file drizzle/0440_*.sql; the test runs them as written against
//   the test database (as the table owner) and only looks at its own node.
// - Seeded slot-only nodes (no receipts) are enough for the proof tests: the
//   brief says inboundProof reads edge_link_slots only.
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { restoreProofOf } from "../edge/protocol.ts";
import { logger } from "../lib/logger.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const drizzleFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);
const OVERSIZE = 5 * 1024 * 1024;
const E2C = "edge_to_cloud";
const C2E = "cloud_to_edge";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const nodeIds: string[] = [];
const scopeOf = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

let clock = Date.parse("2026-11-15T10:00:00.000Z");
function makeEvent(outletId: string, sequence = 1, filler = 10): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `sl855-${clock}-${sequence}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: { filler: "x".repeat(filler), marker: `secret-marker-${clock}` },
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

type Fx = Awaited<ReturnType<typeof freshPrimary>>;

/** A fresh outlet of the seeded tenant with its own primary node. */
async function freshPrimary(label: string) {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji slot 855', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `SL${outletId.slice(0, 8)}`.toUpperCase(), outlets[0].id],
  );
  const registered = await registerEdgeNode(scopeOf(outletId), actor, {
    outletId,
    role: "primary",
    label,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  nodeIds.push(registered.edgeNode.id);
  return { outletId, node, nodeId: registered.edgeNode.id };
}

/** The cloud's side of a node: a no-op applier plus the dead-letter applier. */
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

type Slot = { link_seq: number; event_id: string };
async function slotsOf(nodeId: string, direction = E2C): Promise<Slot[]> {
  const { rows } = await owner.query<Slot>(
    `SELECT link_seq::int AS link_seq, event_id::text AS event_id
       FROM edge_link_slots
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = $3
      ORDER BY link_seq`,
    [tenantId, nodeId, direction],
  );
  return rows;
}

type Receipt = { link_seq: number; event_id: string; outcome: string };
async function receiptsOf(nodeId: string, direction = E2C): Promise<Receipt[]> {
  const { rows } = await owner.query<Receipt>(
    `SELECT link_seq::int AS link_seq, event_id::text AS event_id, outcome
       FROM edge_inbound_events
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = $3
      ORDER BY link_seq, event_id`,
    [tenantId, nodeId, direction],
  );
  return rows;
}

/** Run maintenance SQL with triggers/FKs off (append-only tables, holes). */
async function asReplica(run: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const dropSlot = (fx: Fx, linkSeq: number) =>
  asReplica(async (c) => {
    await c.query(
      `DELETE FROM edge_link_slots WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND link_seq = $3`,
      [tenantId, fx.nodeId, linkSeq],
    );
  });

const dropReceipt = (fx: Fx, linkSeq: number) =>
  asReplica(async (c) => {
    await c.query(
      `DELETE FROM edge_inbound_events WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND link_seq = $3`,
      [tenantId, fx.nodeId, linkSeq],
    );
  });

/** Register an event in edge_received_events (as if another path applied it). */
async function registerEvent(fx: Fx, event: EventEnvelope) {
  await owner.query(
    `INSERT INTO edge_received_events (tenant_id, outlet_id, event_id, first_edge_node_id)
     VALUES ($1, $2, $3::uuid, $4)`,
    [tenantId, fx.outletId, ulidToUuid(event.id), fx.nodeId],
  );
}

const uuidOf = (event: EventEnvelope) => ulidToUuid(event.id);
const idsOf = (events: EventEnvelope[]) => events.map(uuidOf);

/** Independent of restoreProofOf: sha256 over lowercase event ids + "\n". */
const digestOf = (ids: readonly string[]) => ({
  count: ids.length,
  sha256: createHash("sha256")
    .update(ids.map((id) => `${id.toLowerCase()}\n`).join(""))
    .digest("hex"),
});

/** Three events applied through applyInbound (edge slots 1..3, offset 0). */
async function threeApplied(label: string) {
  const fx = await freshPrimary(label);
  const store = cloudStore(fx.node);
  const events = [1, 2, 3].map(() => makeEvent(fx.outletId));
  await deliver(store, events);
  return { fx, store, events };
}

/** Seed `count` slot rows (edge_to_cloud, slots 1..count) with generated ids. */
async function seedSlots(fx: Fx, count: number, direction = E2C) {
  await owner.query(
    `INSERT INTO edge_link_slots (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, g, md5($3::text || $4::text || ':' || g::text)::uuid
       FROM generate_series(1, $5::bigint) AS g`,
    [tenantId, fx.outletId, fx.nodeId, direction, count],
  );
}

async function seededIds(fx: Fx, from: number, to: number) {
  const { rows } = await owner.query<{ event_id: string }>(
    `SELECT event_id::text AS event_id FROM edge_link_slots
      WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
        AND link_seq > $3 AND link_seq <= $4
      ORDER BY link_seq`,
    [tenantId, fx.nodeId, from, to],
  );
  return rows.map((row) => row.event_id);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  try {
    if (nodeIds.length > 0)
      await asReplica(async (c) => {
        for (const table of ["edge_link_slots", "edge_inbound_events"])
          await c.query(
            `DELETE FROM ${table} WHERE tenant_id = $1 AND edge_node_id = ANY($2::uuid[])`,
            [tenantId, nodeIds],
          );
        await c.query(
          `DELETE FROM edge_received_events WHERE tenant_id = $1 AND first_edge_node_id = ANY($2::uuid[])`,
          [tenantId, nodeIds],
        );
      });
  } finally {
    await owner.end();
  }
});

describe("legend-pz641 slots are written by applyInbound and reconcileReplay", () => {
  it("legend-pz641 applyInbound: applied events hold their slots (edge number + offset 0), and the proof equals the plain digest of those events", async () => {
    const { fx, store, events } = await threeApplied("Slot applied");
    expect(await slotsOf(fx.nodeId)).toEqual(
      events.map((event, i) => ({ link_seq: i + 1, event_id: uuidOf(event) })),
    );
    expect(await slotsOf(fx.nodeId, C2E)).toEqual([]);
    // Same answer as the digest formula over the registered events.
    expect(await store.inboundProof!(0, 3)).toEqual({
      to: 3,
      ...restoreProofOf(idsOf(events)),
    });
    expect(restoreProofOf(idsOf(events))).toEqual(digestOf(idsOf(events)));
  });

  it("legend-pz641 applyInbound: after a rebind the slot is the stored number (edge number + peer_seq_offset)", async () => {
    const fx = await freshPrimary("Slot offset");
    // The old instance is bound first (the cursor guard only lets the offset
    // change when a NEW peer instance replaces a recorded one).
    const oldInstance = randomUUID();
    const old = cloudStore(fx.node, oldInstance);
    const warm = [1, 2, 3].map(() => makeEvent(fx.outletId));
    await deliver(old, warm);
    await owner.query(
      `UPDATE sync_cursors SET peer_instance_id = $3
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'
          AND peer_instance_id IS NULL`,
      [tenantId, fx.nodeId, oldInstance],
    );
    const instanceId = randomUUID();
    await owner.query(
      `UPDATE sync_cursors SET peer_instance_id = $3, peer_seq_offset = 3
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
      [tenantId, fx.nodeId, instanceId],
    );
    const fresh = [1, 2].map(() => makeEvent(fx.outletId));
    await deliver(cloudStore(fx.node, instanceId), fresh);
    expect(await slotsOf(fx.nodeId)).toEqual([
      ...warm.map((e, i) => ({ link_seq: i + 1, event_id: uuidOf(e) })),
      ...fresh.map((e, i) => ({ link_seq: i + 4, event_id: uuidOf(e) })),
    ]);
  });

  it("legend-pz641 applyInbound already_received: an event registered earlier gets a 'superseded' receipt AND its slot", async () => {
    const fx = await freshPrimary("Slot already received");
    const store = cloudStore(fx.node);
    const known = makeEvent(fx.outletId);
    const fresh = makeEvent(fx.outletId);
    await registerEvent(fx, known); // received before through another path
    await deliver(store, [known, fresh]);

    const receipts = await receiptsOf(fx.nodeId);
    expect(receipts.find((r) => r.event_id === uuidOf(known))).toMatchObject({
      link_seq: 1,
      outcome: "superseded",
    });
    expect(await slotsOf(fx.nodeId)).toEqual([
      { link_seq: 1, event_id: uuidOf(known) },
      { link_seq: 2, event_id: uuidOf(fresh) },
    ]);
  });

  it("legend-pz641 applyInbound: a dead-letter receipt (unregistered event) writes NO slot; its neighbours do", async () => {
    const fx = await freshPrimary("Slot dead letter");
    const store = cloudStore(fx.node);
    const first = makeEvent(fx.outletId, 1);
    const dead = makeEvent(fx.outletId, 2, OVERSIZE);
    const third = makeEvent(fx.outletId, 3);
    await deliver(store, [
      first,
      deadLetterNotice(fx.outletId, dead, 2),
      third,
    ]);

    // The brief's premise: the receipt of the dead event exists ...
    expect(
      (await receiptsOf(fx.nodeId)).some((r) => r.event_id === uuidOf(dead)),
    ).toBe(true);
    // ... but it holds no slot.
    const slots = await slotsOf(fx.nodeId);
    expect(slots.some((s) => s.event_id === uuidOf(dead))).toBe(false);
    expect(slots.find((s) => s.link_seq === 1)?.event_id).toBe(uuidOf(first));
    expect(slots.find((s) => s.link_seq === 3)?.event_id).toBe(uuidOf(third));
  });

  it("legend-pz641 applyInbound: a slot already held by ANOTHER event is kept, the receipt is still written, and a warning is logged without payload data", async () => {
    const fx = await freshPrimary("Slot held");
    const store = cloudStore(fx.node);
    const stranger = randomUUID();
    await owner.query(
      `INSERT INTO edge_link_slots (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id)
       VALUES ($1, $2, $3, 'edge_to_cloud', 1, $4::uuid)`,
      [tenantId, fx.outletId, fx.nodeId, stranger],
    );
    const event = makeEvent(fx.outletId);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await deliver(store, [event]);
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls
        .map((call) => inspect(call, { depth: 4 }))
        .join("\n");
      expect(logged).not.toContain(String(event.payload.marker));
    } finally {
      warn.mockRestore();
    }
    expect(await slotsOf(fx.nodeId)).toEqual([
      { link_seq: 1, event_id: stranger },
    ]);
    expect(
      (await receiptsOf(fx.nodeId)).find((r) => r.event_id === uuidOf(event)),
    ).toMatchObject({ link_seq: 1, outcome: "applied" });
  });

  it("legend-pz641 reconcileReplay: a hole (no receipt, no slot) for a registered event gets a 'superseded' receipt and the slot; the proof is complete again", async () => {
    const { fx, store, events } = await threeApplied("Slot replay hole");
    await dropReceipt(fx, 2);
    await dropSlot(fx, 2);
    expect(await store.inboundProof!(0, 3)).toEqual({
      to: 1,
      ...restoreProofOf(idsOf([events[0]!])),
    });

    await store.reconcileReplay!({
      events: [
        { linkSeq: 2, event: events[1]! },
        { linkSeq: 3, event: events[2]! },
      ],
    });
    expect(
      (await receiptsOf(fx.nodeId)).find((r) => r.link_seq === 2),
    ).toMatchObject({ event_id: uuidOf(events[1]!), outcome: "superseded" });
    expect(await slotsOf(fx.nodeId)).toEqual(
      events.map((e, i) => ({ link_seq: i + 1, event_id: uuidOf(e) })),
    );
    expect(await store.inboundProof!(0, 3)).toEqual({
      to: 3,
      ...restoreProofOf(idsOf(events)),
    });
  });

  it("legend-pz641 reconcileReplay: a receipt that exists without a slot (never backfilled) gets its slot", async () => {
    const { fx, store, events } = await threeApplied("Slot replay fill");
    await dropSlot(fx, 2);
    const before = await receiptsOf(fx.nodeId);
    await store.reconcileReplay!({
      events: [{ linkSeq: 2, event: events[1]! }],
    });
    expect(await slotsOf(fx.nodeId)).toEqual(
      events.map((e, i) => ({ link_seq: i + 1, event_id: uuidOf(e) })),
    );
    expect(await receiptsOf(fx.nodeId)).toEqual(before); // receipt untouched
    expect(await store.inboundProof!(0, 3)).toEqual({
      to: 3,
      ...restoreProofOf(idsOf(events)),
    });
  });

  it("legend-pz641 reconcileReplay: a slot held by another event is refused, nothing is written", async () => {
    const { fx, store, events } = await threeApplied("Slot replay refused");
    // Slot 2 is held by event 3 (and has no receipt of its own).
    await dropReceipt(fx, 2);
    await asReplica(async (c) => {
      await c.query(
        `UPDATE edge_link_slots SET event_id = $3::uuid
          WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud' AND link_seq = 2`,
        [tenantId, fx.nodeId, uuidOf(events[2]!)],
      );
    });
    const receiptsBefore = await receiptsOf(fx.nodeId);
    const slotsBefore = await slotsOf(fx.nodeId);
    await expect(
      store.reconcileReplay!({ events: [{ linkSeq: 2, event: events[1]! }] }),
    ).rejects.toThrow(/Restore proof.*replayed slot 2/i);
    expect(await receiptsOf(fx.nodeId)).toEqual(receiptsBefore);
    expect(await slotsOf(fx.nodeId)).toEqual(slotsBefore);
  });
});

describe("legend-pz641 inboundProof reads the slot table", () => {
  it("legend-pz641 proof is read from slots only: a slot hole stops the prefix even though the receipt exists", async () => {
    const { fx, store, events } = await threeApplied("Proof slots only");
    await dropSlot(fx, 2);
    expect(await store.inboundProof!(0, 3)).toEqual({
      to: 1,
      ...restoreProofOf(idsOf([events[0]!])),
    });
    // Hole right after `from`: an empty proof with to = from.
    expect(await store.inboundProof!(1, 3)).toEqual({
      to: 1,
      ...restoreProofOf([]),
    });
    // Starting after the hole, slot 3 is provable again.
    expect(await store.inboundProof!(2, 3)).toEqual({
      to: 3,
      ...restoreProofOf(idsOf([events[2]!])),
    });
    expect(await store.inboundProof!(3, 2)).toBeNull();
  });

  it("legend-pz641 proof over 25000 slots (above the old 20000 cap) covers the whole range, with the plain digest", async () => {
    const fx = await freshPrimary("Proof 25000");
    await seedSlots(fx, 25_000);
    await seedSlots(fx, 40, C2E); // other direction: must not leak in
    const store = cloudStore(fx.node);
    const all = await seededIds(fx, 0, 25_000);
    expect(all).toHaveLength(25_000);

    const proof = await store.inboundProof!(0, 25_000);
    expect(proof).toEqual({ to: 25_000, ...digestOf(all) });
    expect(proof).toEqual({ to: 25_000, ...restoreProofOf(all) });
    // A sub-range beyond the old cap offset.
    expect(await store.inboundProof!(5_000, 24_000)).toEqual({
      to: 24_000,
      ...digestOf(all.slice(5_000, 24_000)),
    });
  }, 120_000);

  it("legend-pz641 a hole inside 25000 slots gives the prefix before it, not null and not the whole range", async () => {
    const fx = await freshPrimary("Proof hole");
    await seedSlots(fx, 25_000);
    const store = cloudStore(fx.node);
    const all = await seededIds(fx, 0, 25_000);
    await dropSlot(fx, 21_000); // beyond the old cap

    expect(await store.inboundProof!(0, 25_000)).toEqual({
      to: 20_999,
      ...digestOf(all.slice(0, 20_999)),
    });
    // Hole right after `from`: an empty proof with to = from.
    expect(await store.inboundProof!(20_999, 25_000)).toEqual({
      to: 20_999,
      ...restoreProofOf([]),
    });
    // Starting at the hole, the slots after it are provable again.
    expect(await store.inboundProof!(21_000, 25_000)).toEqual({
      to: 25_000,
      ...digestOf(all.slice(21_000, 25_000)),
    });
  }, 120_000);

  it("legend-pz641 the new cap: a range wider than 100000 slots proves the first 100000, the next round continues", async () => {
    const fx = await freshPrimary("Proof cap");
    await seedSlots(fx, 100_050);
    const store = cloudStore(fx.node);
    const all = await seededIds(fx, 0, 100_050);

    const first = await store.inboundProof!(0, 120_000);
    expect(first).toEqual({ to: 100_000, ...digestOf(all.slice(0, 100_000)) });
    const next = await store.inboundProof!(100_000, 120_000);
    expect(next).toEqual({
      to: 100_050,
      ...digestOf(all.slice(100_000)),
    });
  }, 180_000);
});

describe("legend-pz641 backfill of the slot migration", () => {
  /** The statements of drizzle/0440_*.sql that write edge_link_slots. */
  function backfillStatements(): string[] {
    const files = readdirSync(drizzleFolder).filter((f) =>
      /^0440_.*\.sql$/.test(f),
    );
    expect(files, "migration 0376 for edge_link_slots exists").toHaveLength(1);
    const sqlText = readFileSync(join(drizzleFolder, files[0]!), "utf8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) =>
        /INSERT\s+INTO\s+(?:"?public"?\.)?"?edge_link_slots"?/i.test(s),
      );
    expect(
      statements.length,
      "the migration backfills the table",
    ).toBeGreaterThan(0);
    return statements;
  }

  async function runBackfill() {
    const statements = backfillStatements();
    await asReplica(async (c) => {
      for (const statement of statements) await c.query(statement);
    });
  }

  async function insertReceipt(
    fx: Fx,
    direction: string,
    linkSeq: number,
    eventId: string,
  ) {
    await owner.query(
      `INSERT INTO edge_inbound_events (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, kind, outcome)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, 'order', $7, 1, 'transaction_event', 'applied')`,
      [
        tenantId,
        fx.outletId,
        fx.nodeId,
        direction,
        eventId,
        linkSeq,
        randomUUID(),
      ],
    );
  }

  it("legend-pz641 backfill counts only counted receipts, skips multi-receipt slots, keeps existing slots, and is idempotent", async () => {
    const fx = await freshPrimary("Slot backfill");
    const registered = () => {
      const id = randomUUID();
      return owner
        .query(
          `INSERT INTO edge_received_events (tenant_id, outlet_id, event_id, first_edge_node_id) VALUES ($1, $2, $3::uuid, $4)`,
          [tenantId, fx.outletId, id, fx.nodeId],
        )
        .then(() => id);
    };

    // Slot 1: one registered receipt -> backfilled.
    const e1 = await registered();
    await insertReceipt(fx, E2C, 1, e1);
    // Slot 2: only an unregistered (dead-letter) receipt -> no slot.
    const deadId = randomUUID();
    await insertReceipt(fx, E2C, 2, deadId);
    // Slot 3: two registered receipts -> skipped (ambiguous).
    const e3a = await registered();
    const e3b = await registered();
    await insertReceipt(fx, E2C, 3, e3a);
    await insertReceipt(fx, E2C, 3, e3b);
    // Slot 4: one registered + one unregistered receipt -> exactly one counted.
    const e4 = await registered();
    await insertReceipt(fx, E2C, 4, e4);
    await insertReceipt(fx, E2C, 4, randomUUID());
    // Slot 5: a counted receipt, but the slot already exists with another holder.
    const e5 = await registered();
    await insertReceipt(fx, E2C, 5, e5);
    const holder = randomUUID();
    await owner.query(
      `INSERT INTO edge_link_slots (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id)
       VALUES ($1, $2, $3, 'edge_to_cloud', 5, $4::uuid)`,
      [tenantId, fx.outletId, fx.nodeId, holder],
    );
    // cloud_to_edge: counted always, even when the event is not registered.
    const c1 = randomUUID();
    await insertReceipt(fx, C2E, 1, c1);

    await runBackfill();
    const afterFirst = {
      e2c: await slotsOf(fx.nodeId),
      c2e: await slotsOf(fx.nodeId, C2E),
    };
    expect(afterFirst.e2c).toEqual([
      { link_seq: 1, event_id: e1 },
      { link_seq: 4, event_id: e4 },
      { link_seq: 5, event_id: holder },
    ]);
    expect(afterFirst.c2e).toEqual([{ link_seq: 1, event_id: c1 }]);

    // Idempotent: a second (and third) run changes nothing and does not fail.
    await runBackfill();
    await runBackfill();
    expect({
      e2c: await slotsOf(fx.nodeId),
      c2e: await slotsOf(fx.nodeId, C2E),
    }).toEqual(afterFirst);

    // A receipt written between runs is picked up by the next run only.
    const e6 = await registered();
    await insertReceipt(fx, E2C, 6, e6);
    await runBackfill();
    expect((await slotsOf(fx.nodeId)).map((s) => s.link_seq)).toEqual([
      1, 4, 5, 6,
    ]);
  }, 60_000);
});
