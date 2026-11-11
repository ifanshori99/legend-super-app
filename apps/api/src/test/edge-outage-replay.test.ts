// legend-kai: a 4 hour internet outage replayed through the real Postgres link
// stores, then reconciled. Written from the card brief, not from the implementation.
//
// Two tests, run in order on one shared scenario:
//   1. "link replay" is a CHARACTERIZATION of the existing link: it needs no
//      ledger and uses only modules that exist today, so it is expected to PASS
//      before the implementation (no loss, no duplicate, per-aggregate order,
//      resume from the hello cursor, 0 conflicts, queue drained and acked).
//   2. "ledger reconciliation" DEPENDS on the new work (edge_txn_ledger written
//      at enqueue, buildEdgeTxnDigest, reconcileEdgeTransactions). It imports
//      those modules dynamically so test 1 can still run and pass first; test 2
//      fails pre-implementation with a missing module, not a setup error.
//
// Assumptions:
// - "Fake clock advanced 4h": the events carry occurredAt / ULID timestamps
//   spread across 4 hours; nothing waits on the wall clock.
// - The edge and the cloud share one disposable database, which the cloud's
//   sequence check does not tolerate while the edge queue rows are still there
//   (in production they are separate databases). So the harness reads the edge
//   outbox once, acks + deletes the edge queue rows, and drives the replay in
//   batches through the real cloud link store and the POS deferred applier,
//   with simulated link drops: (a) a first batch applied and the link dies
//   before the ack; (b) resume from the hello cursor with a resent batch; (c) a
//   batch lost on the wire and resent; (d) a duplicated batch, which must be
//   refused without changing anything.
// - The scenario's per-aggregate lifecycle (submitted, paid, then a mix of
//   refunded/voided/paid) is not business-meaningful; only the gap-free
//   per-aggregate sequence and the rupiah amounts matter here.
// - Persisted edge_totals / cloud_totals have the shape of digest.totals.
// - Round 2: the digest carries edgeInstanceId (edge_nodes.instance_id; the harness
//   gives the node row an instance id) and each totals entry an idHash (decimal sum
//   of eventIdentityHash(event id) modulo 2^64, computed here from the events). The
//   cloud's active epoch is sync_cursors.peer_instance_id; what the real link does
//   on hello is emulated by adopting the edge instance (NULL -> id) after the link
//   replay, before the reconciliation. A digest of any other instance is 'stale'.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  edgeQueueBacklog,
  enqueueEdgeEvent,
} from "../services/edge-queue.service.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const actor = randomUUID();
const AGGREGATES = 24;
const PER_AGGREGATE = 9; // 24 x 9 = 216 events
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const LIFECYCLE = [
  "order.submitted",
  "order.paid",
  "order.refunded",
  "order.voided",
  "order.refunded",
  "order.paid",
  "order.refunded",
  "order.voided",
  "order.paid",
] as const;
const TWO_64 = 18446744073709551616n;
const BIG = 9_000_000_000_000_000; // two of these exceed 2^53 when summed

let tenant: IsolatedTenant;
let outletId: string;
let node: AuthenticatedEdgeNode;
let events: EventEnvelope[] = [];
const instanceId = randomUUID();
let expectedTotals: Record<string, { count: number; amountIdr: string }> = {};

const contextOf = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** The 4h outage: round-robin across aggregates, ids and times spread over 4h. */
function buildOutage(): void {
  const aggregates = Array.from({ length: AGGREGATES }, () => randomUUID());
  const total = AGGREGATES * PER_AGGREGATE;
  const start = Date.parse("2026-11-10T01:00:00.000Z");
  const step = Math.floor(FOUR_HOURS_MS / total);
  const sums = new Map<string, { count: number; amount: bigint }>();
  events = [];
  for (let seq = 1; seq <= PER_AGGREGATE; seq++)
    for (let a = 0; a < AGGREGATES; a++) {
      const index = events.length;
      const at = start + index * step;
      const name = LIFECYCLE[seq - 1]!;
      let amount = 10_000 + ((a * 7 + seq * 13) % 40) * 500;
      if (seq === 2 && a < 2) amount = BIG;
      const key =
        name === "order.voided" || name === "order.refunded"
          ? "amountIdr"
          : "totalIdr";
      events.push({
        id: createUlid(at),
        tenantId: tenant.tenantId as EventEnvelope["tenantId"],
        outletId: outletId as EventEnvelope["outletId"],
        name,
        version: 1,
        aggregateType: "order",
        aggregateId: aggregates[a]!,
        sequence: seq,
        occurredAt: new Date(at).toISOString(),
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `${name}:outage-${at}`,
        payloadSchemaRef: `${name}.v1`,
        // receiptNumber mirrors the order fixture of edge-order-deferred.test.ts.
        payload: { [key]: amount, receiptNumber: `LG-${at}` },
      } as EventEnvelope);
      const sum = sums.get(name) ?? { count: 0, amount: 0n };
      sums.set(name, {
        count: sum.count + 1,
        amount: sum.amount + BigInt(amount),
      });
    }
  expectedTotals = Object.fromEntries(
    [...sums].map(([name, sum]) => [
      name,
      { count: sum.count, amountIdr: sum.amount.toString() },
    ]),
  );
}

function stores() {
  const base = { database: db, context: node.context, node: node.scope };
  return {
    edge: createDbLinkStore({ ...base, outboundDirection: "edge_to_cloud" }),
    cloud: createDbLinkStore({ ...base, outboundDirection: "cloud_to_edge" }),
  };
}

async function one<T>(query: string, params: unknown[]): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    const result = await client.query(query, params);
    await client.query("COMMIT");
    return result.rows as T;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Owner-side write in the tenant context; falls back to replica role if a guard trigger refuses it. */
async function ownerWrite(
  sql: string,
  params: unknown[],
  expectedRows?: number,
) {
  const apply = async (replica: boolean) => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      if (replica)
        await client.query("SET LOCAL session_replication_role = replica");
      const result = await client.query(sql, params);
      if (expectedRows !== undefined && result.rowCount !== expectedRows)
        throw new Error(`expected ${expectedRows} row(s) from: ${sql}`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  await apply(false).catch(() => apply(true));
}

/** Never a duplicate, at any point of the replay. */
async function expectNoDuplicates() {
  const [row] = await one<
    Array<{
      deferred: number;
      distinct_deferred: number;
      received: number;
      distinct_received: number;
    }>
  >(
    `SELECT (SELECT count(*)::int FROM edge_deferred_events WHERE tenant_id = $1) AS deferred,
            (SELECT count(DISTINCT event_id)::int FROM edge_deferred_events WHERE tenant_id = $1) AS distinct_deferred,
            (SELECT count(*)::int FROM edge_received_events WHERE tenant_id = $1) AS received,
            (SELECT count(DISTINCT event_id)::int FROM edge_received_events WHERE tenant_id = $1) AS distinct_received`,
    [tenant.tenantId],
  );
  expect(row!.deferred).toBe(row!.distinct_deferred);
  expect(row!.received).toBe(row!.distinct_received);
  expect(row!.deferred).toBeLessThanOrEqual(events.length);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  resetEdgeApplierRegistryForTests();
  registerPosDeferredEdgeApplier();
  registerEdgeDeferredFallback();
  tenant = await createIsolatedTenant(`eor-${randomUUID().slice(0, 6)}`);
  outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'OUTAGE-1', 'Outlet Outage', 'Jl. Uji 4', 'Asia/Jakarta', $5, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const registered = await registerEdgeNode(contextOf(), actor, {
    outletId,
    role: "primary",
    label: "Utama Outage",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
  await ownerWrite(
    "UPDATE edge_nodes SET instance_id = $2 WHERE id = $1",
    [node.scope.edgeNodeId, instanceId],
    1,
  );
  buildOutage();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-kai 4h outage replay", () => {
  it("link replay: no loss, no duplicate, per-aggregate order, resume from the hello cursor (characterization, passes before the ledger)", async () => {
    // The scenario really is large and 4 hours long.
    expect(events.length).toBeGreaterThanOrEqual(200);
    expect(
      new Set(events.map((e) => e.aggregateId)).size,
    ).toBeGreaterThanOrEqual(20);
    const spanMs =
      Date.parse(events.at(-1)!.occurredAt) - Date.parse(events[0]!.occurredAt);
    expect(spanMs).toBeGreaterThanOrEqual(FOUR_HOURS_MS - 5 * 60 * 1000);

    // Internet is down: the edge keeps selling and queues locally, in order.
    const context = node.context;
    for (const event of events)
      await withTenant(db, context, (tx) =>
        enqueueEdgeEvent(tx, context, {
          edgeNodeId: node.scope.edgeNodeId,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event,
        }),
      );
    const { edge, cloud } = stores();
    expect(await edge.outboundHead()).toBe(events.length);
    expect(await edge.lastAckedOutbound()).toBe(0);
    expect(await cloud.lastReceivedInbound()).toBe(0);

    // Single-database harness: in production the edge and the cloud are separate
    // databases. Here the edge queue rows would make the cloud's sequence check
    // see every applied event as a collision, so read the whole edge outbox once
    // and then ack + delete the edge queue rows (sync_cursors stay as they are).
    // The link is then driven batch by batch through the cloud store, which is
    // what the real peer does on the wire.
    const outbox = await edge.readOutbound(0, events.length);
    expect(outbox.map((q) => q.linkSeq)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    await one(
      "UPDATE edge_outbound_queue SET status = 'acked', acked_at = now() WHERE edge_node_id = $1 AND status <> 'acked'",
      [node.scope.edgeNodeId],
    );
    await one("DELETE FROM edge_outbound_queue WHERE edge_node_id = $1", [
      node.scope.edgeNodeId,
    ]);
    const batch = (from: number, to: number) => ({
      fromSeq: from,
      toSeq: to,
      events: outbox.filter((q) => q.linkSeq > from && q.linkSeq <= to),
    });

    // Drop 1: the link comes back, a first batch reaches the cloud and the link
    // dies before the ack. The edge still believes nothing was delivered.
    await cloud.applyInbound(batch(0, 60));
    expect(await cloud.lastReceivedInbound()).toBe(60);
    expect(await edge.lastAckedOutbound()).toBe(0);
    await expectNoDuplicates();

    // Reconnect: the hello cursor says the cloud holds 60. The next batch
    // (61..140) arrives and its ack is lost again, so the edge resends 61..140.
    const resumeAt = await cloud.lastReceivedInbound();
    expect(resumeAt).toBe(60);
    await cloud.applyInbound(batch(resumeAt, 140));
    expect(await cloud.lastReceivedInbound()).toBe(140);
    expect(await edge.lastAckedOutbound()).toBe(0);
    await expectNoDuplicates();
    // The duplicate of an already-applied batch changes nothing.
    await expect(cloud.applyInbound(batch(resumeAt, 140))).rejects.toThrow();
    expect(await cloud.lastReceivedInbound()).toBe(140);
    await expectNoDuplicates();

    // A batch lost on the wire (141..200 never arrives): the cursor stays at 140,
    // the edge resends from the hello cursor, and the batch is applied once.
    expect(await cloud.lastReceivedInbound()).toBe(140);
    await cloud.applyInbound(batch(140, 200));
    // ...and is then delivered a second time (a duplicated frame).
    await expect(cloud.applyInbound(batch(140, 200))).rejects.toThrow();
    expect(await cloud.lastReceivedInbound()).toBe(200);
    await expectNoDuplicates();

    // Final batch drains to the end; the cloud's ack finally reaches the edge.
    await cloud.applyInbound(batch(200, events.length));
    await edge.ackOutbound(events.length);

    // Every event applied exactly once.
    await expectNoDuplicates();
    // Diagnostic first: a refused event would be received but never parked.
    expect(
      await one<Array<{ c: unknown }>>(
        "SELECT to_jsonb(c) - 'envelope' AS c FROM edge_sync_conflicts c WHERE tenant_id = $1 LIMIT 3",
        [tenant.tenantId],
      ),
    ).toEqual([]);
    const ids = events.map((e) => ulidToUuid(e.id));
    const [counts] = await one<
      Array<{ received: number; deferred: number; inbound: number }>
    >(
      `SELECT (SELECT count(*)::int FROM edge_received_events WHERE tenant_id = $1 AND event_id = ANY($2::uuid[])) AS received,
              (SELECT count(*)::int FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = ANY($2::uuid[])) AS deferred,
              (SELECT count(*)::int FROM edge_inbound_events WHERE tenant_id = $1 AND edge_node_id = $3) AS inbound`,
      [tenant.tenantId, ids, node.scope.edgeNodeId],
    );
    expect(counts).toEqual({
      received: events.length,
      deferred: events.length,
      inbound: events.length,
    });

    // link_seq is gap-free and monotonic, and cloud arrival keeps the edge order.
    const arrival = await one<
      Array<{
        link_seq: string;
        event_id: string;
        aggregate_id: string;
        aggregate_sequence: string;
      }>
    >(
      `SELECT i.link_seq::text AS link_seq, d.event_id::text AS event_id,
              d.aggregate_id::text AS aggregate_id, d.aggregate_sequence::text AS aggregate_sequence
         FROM edge_inbound_events i
         JOIN edge_deferred_events d ON d.tenant_id = i.tenant_id AND d.event_id = i.event_id
        WHERE i.tenant_id = $1 AND i.edge_node_id = $2
        ORDER BY i.link_seq`,
      [tenant.tenantId, node.scope.edgeNodeId],
    );
    expect(arrival.map((row) => Number(row.link_seq))).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    expect(arrival.map((row) => row.event_id)).toEqual(ids);
    const last = new Map<string, number>();
    for (const row of arrival) {
      const sequence = Number(row.aggregate_sequence);
      expect(sequence).toBeGreaterThan(last.get(row.aggregate_id) ?? 0);
      last.set(row.aggregate_id, sequence);
    }
    expect(last.size).toBe(AGGREGATES);
    for (const value of last.values()) expect(value).toBe(PER_AGGREGATE);

    // No conflicts, cursors at the end, the edge queue drained and acknowledged.
    const [conflicts] = await one<Array<{ n: number }>>(
      "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    expect(conflicts!.n).toBe(0);
    expect(await cloud.lastReceivedInbound()).toBe(events.length);
    expect(await edge.lastAckedOutbound()).toBe(events.length);
    const backlog = await edgeQueueBacklog(
      db,
      context,
      node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(0);
  }, 120_000);

  it("ledger reconciliation: edge digest equals the cloud totals to the rupiah (depends on the ledger)", async () => {
    const { buildEdgeTxnDigest, eventIdentityHash } =
      await import("../services/edge-txn-ledger.service.ts");
    const { reconcileEdgeTransactions } =
      await import("../services/edge-reconciliation.service.ts");
    // Totals computed here from the generated events, independent of the service.
    expect(expectedTotals["order.paid"]!.amountIdr).toBe(
      [...events]
        .filter((e) => e.name === "order.paid")
        .reduce(
          (sum, e) =>
            sum + BigInt((e.payload as { totalIdr: number }).totalIdr),
          0n,
        )
        .toString(),
    );
    expect(BigInt(expectedTotals["order.paid"]!.amountIdr)).toBeGreaterThan(
      2n ** 53n,
    );

    // The cloud's active epoch: what the link adopts on hello (NULL -> instance id).
    await ownerWrite(
      `UPDATE sync_cursors SET peer_instance_id = $2
        WHERE edge_node_id = $1 AND direction = 'edge_to_cloud' AND peer_instance_id IS NULL`,
      [node.scope.edgeNodeId, instanceId],
    );

    // Identity sums computed here from the generated events (independent of the service).
    const idHashes = new Map<string, bigint>();
    for (const event of events)
      idHashes.set(
        event.name,
        ((idHashes.get(event.name) ?? 0n) + eventIdentityHash(event.id)) %
          TWO_64,
      );
    const expectedWithIdentity = Object.fromEntries(
      Object.entries(expectedTotals).map(([name, total]) => [
        name,
        { ...total, idHash: idHashes.get(name)!.toString() },
      ]),
    );

    const digest = await withTenant(db, node.context, (tx) =>
      buildEdgeTxnDigest(tx, node.scope),
    );
    expect(digest.edgeNodeId).toBe(node.scope.edgeNodeId);
    expect(digest.edgeInstanceId).toBe(instanceId);
    expect(digest.fromLinkSeq).toBe(0);
    expect(digest.throughLinkSeq).toBe(events.length);
    expect(digest.totals).toEqual(expectedWithIdentity);

    const run = await reconcileEdgeTransactions(db, contextOf(), {
      edgeNodeId: node.scope.edgeNodeId,
      digest,
    } as Parameters<typeof reconcileEdgeTransactions>[2]);
    expect(run.status).toBe("ok");

    const [row] = await one<
      Array<{
        status: string;
        edge_totals: unknown;
        cloud_totals: unknown;
        diffs: unknown;
        from_link_seq: string;
        through_link_seq: string;
        edge_instance_id: string;
      }>
    >(
      `SELECT status, edge_totals, cloud_totals, diffs, from_link_seq::text AS from_link_seq,
              through_link_seq::text AS through_link_seq, edge_instance_id::text AS edge_instance_id
         FROM edge_reconciliation_runs
        WHERE tenant_id = $1 AND edge_node_id = $2 ORDER BY checked_at, id`,
      [tenant.tenantId, node.scope.edgeNodeId],
    );
    expect(row!.status).toBe("ok");
    expect(row!.edge_totals).toEqual(expectedWithIdentity);
    expect(row!.cloud_totals).toEqual(row!.edge_totals);
    expect(row!.diffs).toEqual([]);
    expect(row).toMatchObject({
      from_link_seq: "0",
      through_link_seq: String(events.length),
      edge_instance_id: instanceId,
    });

    // Not vacuous: one rupiah of drift on the edge side is caught...
    const paid = digest.totals["order.paid"]!;
    const drifted = {
      ...digest,
      totals: {
        ...digest.totals,
        "order.paid": {
          ...paid,
          amountIdr: (BigInt(paid.amountIdr) + 1n).toString(),
        },
      },
    };
    const drift = await reconcileEdgeTransactions(db, contextOf(), {
      edgeNodeId: node.scope.edgeNodeId,
      digest: drifted,
    } as Parameters<typeof reconcileEdgeTransactions>[2]);
    expect(drift.status).toBe("mismatch");

    // ...so is a different set of events with the same count and rupiah (identity)...
    const swapped = await reconcileEdgeTransactions(db, contextOf(), {
      edgeNodeId: node.scope.edgeNodeId,
      digest: {
        ...digest,
        totals: {
          ...digest.totals,
          "order.paid": {
            ...paid,
            idHash: ((BigInt(paid.idHash) + 1n) % TWO_64).toString(),
          },
        },
      },
    } as Parameters<typeof reconcileEdgeTransactions>[2]);
    expect(swapped.status).toBe("mismatch");

    // ...and a digest of another edge instance is stale, never compared.
    const foreign = await reconcileEdgeTransactions(db, contextOf(), {
      edgeNodeId: node.scope.edgeNodeId,
      digest: { ...digest, edgeInstanceId: randomUUID() },
    } as Parameters<typeof reconcileEdgeTransactions>[2]);
    expect(foreign.status).toBe("stale");
  }, 60_000);
});
