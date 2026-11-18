// legend-kai: edge-side running ledger of what the edge sent (event count and
// rupiah per event name), written in the same transaction as the enqueue.
// Written from the card brief (docs of the design), not from the implementation.
//
// Fail-first: services/edge-txn-ledger.service.ts and the edge_txn_ledger table
// do not exist yet, so this file fails at import (missing module) before the
// implementation lands.
//
// Assumptions (the brief does not pin them down):
// - transactionAmountIdr fails closed (throws) on a missing, null, NaN,
//   non-integer or negative value, and reads the key per event name:
//   order.submitted/order.paid -> totalIdr, order.voided/order.refunded -> amountIdr.
//   An "unsafe" integer above 2^53 as a JS number is not tested (not exact anyway);
//   exactness above 2^53 is proven through the bigint ledger column + string digest
//   (two events of 9e15 each sum to 1.8e16 > 2^53).
// - digest.throughLinkSeq is the link_seq of the last event the edge assigned
//   (the cursor head), so it equals the link_seq enqueueEdgeEvent returned last.
// - (architect review) Only the reconciled names count in the ledger and the
//   digest: order.submitted, order.paid, order.voided, order.refunded. Any other
//   transaction_event name (order.item_added, stock.moved, ...) is queued and
//   sent as usual but is not in the ledger. isReconciledEvent(name) takes the
//   event name string.
// - Round 2 (docs/briefs/470-edge-upsync-codex-fixes.md, contract in the card
//   brief): the digest also carries edgeInstanceId (edge_nodes.instance_id of the
//   node row; null -> CONFLICT 'Edge instance belum diinisialisasi.') and each
//   totals entry carries idHash, the decimal sum modulo 2^64 of
//   eventIdentityHash(event id) (first 8 bytes, big-endian, of sha256 of the
//   uppercase ULID text), kept in edge_txn_ledger.id_hash_sum numeric(20,0).
// - Rupiah range is 0..9223372036854775807. A JS number cannot hold 2^63-1
//   exactly (the literal rounds to 2^63 = max + 1), so money above 2^53 travels
//   as a canonical digit string ("9223372036854775807"); a JS number is accepted
//   only when it is a safe integer. The exact max is also reached through the
//   cumulative ledger (a digit string plus 1023). Above the range: CoreError VALIDATION_ERROR 'Nilai rupiah melebihi batas.'
//   before anything is queued; cumulative overflow of a ledger row: CoreError
//   CONFLICT 'Total ledger melebihi batas bigint.' with nothing queued.
// - legend-4vwaj: edge_txn_ledger_events (tenant_id, outlet_id, edge_node_id,
//   event_id uuid, recorded_at) remembers every counted event id, so a re-enqueue
//   of the same event after the queue row was pruned does not count twice. Events
//   sent before the baseline are not in it (known limit, not tested).
// - enqueue of a master_data event on edge_to_cloud is not exercised (it may be
//   refused by the queue itself); non-counting kinds are covered with
//   cloud_to_edge master_data and cloud_to_edge transaction_event.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
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
import { createDbLinkStore } from "../edge/db-link-store.ts";
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
  buildEdgeTxnDigest,
  eventIdentityHash,
  isReconciledEvent,
  transactionAmountIdr,
} from "../services/edge-txn-ledger.service.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const actor = randomUUID();
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;

const contextOf = (
  tenantId: string,
  outletIds: string[],
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function asAppRole<T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type World = {
  node: AuthenticatedEdgeNode;
  outletId: string;
  tenant: IsolatedTenant;
  instanceId: string;
};

const MAX_BIGINT = 9223372036854775807n;
const TWO_64 = 18446744073709551616n;

/** The edge's own instance id lives on its node row (the registered row starts without one). */
async function setInstanceId(
  tenantId: string,
  edgeNodeId: string,
  instanceId: string | null,
) {
  const apply = (replica: boolean) =>
    asOwnerTenant(tenantId, async (client) => {
      if (replica)
        await client.query("SET LOCAL session_replication_role = replica");
      const result = await client.query(
        "UPDATE edge_nodes SET instance_id = $3 WHERE tenant_id = $1 AND id = $2",
        [tenantId, edgeNodeId, instanceId],
      );
      if (result.rowCount !== 1) throw new Error("edge node row not found");
    });
  await apply(false).catch(() => apply(true));
}

/** Expected digest totals, computed here from the events (independent of the service). */
function totalsOf(events: EventEnvelope[]) {
  const sums = new Map<
    string,
    { count: number; amount: bigint; idHash: bigint }
  >();
  for (const event of events) {
    if (!isReconciledEvent(event.name)) continue;
    const current = sums.get(event.name) ?? {
      count: 0,
      amount: 0n,
      idHash: 0n,
    };
    sums.set(event.name, {
      count: current.count + 1,
      amount: current.amount + transactionAmountIdr(event),
      idHash: (current.idHash + eventIdentityHash(event.id)) % TWO_64,
    });
  }
  return Object.fromEntries(
    [...sums].map(([name, sum]) => [
      name,
      {
        count: sum.count,
        amountIdr: sum.amount.toString(),
        idHash: sum.idHash.toString(),
      },
    ]),
  );
}

/** A fresh outlet with its own primary edge node, so each test starts at zero. */
async function newWorld(tenant: IsolatedTenant): Promise<World> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Ledger', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `L-${randomUUID().slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  const registered = await registerEdgeNode(
    contextOf(tenant.tenantId, [outletId]),
    actor,
    { outletId, role: "primary", label: "Utama Ledger" },
  );
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  const instanceId = randomUUID();
  await setInstanceId(tenant.tenantId, node.scope.edgeNodeId, instanceId);
  return { node, outletId, tenant, instanceId };
}

let clock = Date.parse("2026-11-10T08:00:00.000Z");
function envelope(
  world: World,
  name: string,
  payload: Record<string, unknown>,
  overrides: { aggregateId?: string; sequence?: number } = {},
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: world.tenant.tenantId as EventEnvelope["tenantId"],
    outletId: world.outletId as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.split(".")[0]!,
    aggregateId: overrides.aggregateId ?? randomUUID(),
    sequence: overrides.sequence ?? 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:ledger-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload,
  } as EventEnvelope;
}

function enqueue(
  world: World,
  event: EventEnvelope,
  options: {
    direction?: "edge_to_cloud" | "cloud_to_edge";
    kind?: "transaction_event" | "master_data";
  } = {},
) {
  const context = world.node.context;
  return withTenant(db, context, (tx) =>
    enqueueEdgeEvent(tx, context, {
      edgeNodeId: world.node.scope.edgeNodeId,
      direction: options.direction ?? "edge_to_cloud",
      kind: options.kind ?? "transaction_event",
      event,
    }),
  );
}

function digestOf(world: World) {
  return withTenant(db, world.node.context, (tx) =>
    buildEdgeTxnDigest(tx, world.node.scope),
  );
}

const ledgerRows = (world: World) =>
  asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `SELECT event_name, event_count::text AS event_count, amount_idr::text AS amount_idr,
              id_hash_sum::text AS id_hash_sum
         FROM edge_txn_ledger WHERE tenant_id = $1 AND edge_node_id = $2
        ORDER BY event_name`,
      [world.tenant.tenantId, world.node.scope.edgeNodeId],
    ),
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  tenantA = await createIsolatedTenant(`etl-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`etl-b-${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  setAuditWriter(null);
  // Edge rows are append-only, so the isolated tenants stay in the disposable
  // database; give them a valid creator so the platform tenant list parses them.
  for (const tenant of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-kai transactionAmountIdr (pure, integer rupiah in bigint)", () => {
  const sample = (name: string, payload: Record<string, unknown>) =>
    ({
      id: createUlid(Date.parse("2026-11-10T07:00:00.000Z")),
      tenantId: randomUUID(),
      outletId: randomUUID(),
      name,
      version: 1,
      aggregateType: "order",
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: "2026-11-10T07:00:00.000Z",
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `pure-${name}`,
      payloadSchemaRef: `${name}.v1`,
      payload,
    }) as unknown as EventEnvelope;

  it.each([
    ["order.submitted", { totalIdr: 150000 }, 150000n],
    ["order.paid", { totalIdr: 90000 }, 90000n],
    ["order.voided", { amountIdr: 45000 }, 45000n],
    ["order.refunded", { amountIdr: 12500 }, 12500n],
    ["order.paid", { totalIdr: 0 }, 0n],
  ])("%s %j counts %s rupiah", (name, payload, expected) => {
    const amount = transactionAmountIdr(sample(name, payload));
    expect(typeof amount).toBe("bigint");
    expect(amount).toBe(expected);
  });

  it("keeps a large amount exact as bigint (9e15 rupiah, near 2^53)", () => {
    const amount = transactionAmountIdr(
      sample("order.paid", { totalIdr: 9_000_000_000_000_000 }),
    );
    expect(amount).toBe(9_000_000_000_000_000n);
    expect(amount + amount).toBe(18_000_000_000_000_000n);
  });

  it("counts zero for every other event name, even with money-looking keys", () => {
    for (const name of [
      "order.item_added",
      "stock.moved",
      "order.cancelled",
      "attendance.clocked",
    ])
      expect(
        transactionAmountIdr(sample(name, { totalIdr: 777, amountIdr: 888 })),
      ).toBe(0n);
  });

  it.each([
    ["order.paid", {}],
    ["order.paid", { totalIdr: null }],
    ["order.paid", { totalIdr: 1000.5 }],
    ["order.paid", { totalIdr: Number.NaN }],
    ["order.paid", { totalIdr: Number.POSITIVE_INFINITY }],
    ["order.paid", { totalIdr: -1 }],
    ["order.submitted", { totalIdr: -500 }],
    ["order.voided", { amountIdr: 12.25 }],
    ["order.refunded", { amountIdr: -1 }],
    // The wrong key for the event name is a missing value, not a fallback.
    ["order.paid", { amountIdr: 1000 }],
    ["order.refunded", { totalIdr: 1000 }],
  ])("%s %j fails closed", (name, payload) => {
    expect(() => transactionAmountIdr(sample(name, payload))).toThrow();
  });
});

describe("legend-kai isReconciledEvent", () => {
  it("is true for exactly the four money event names", () => {
    for (const name of [
      "order.submitted",
      "order.paid",
      "order.voided",
      "order.refunded",
    ])
      expect(isReconciledEvent(name)).toBe(true);
    for (const name of [
      "order.item_added",
      "stock.moved",
      "order.cancelled",
      "order.paid.v2",
      "ORDER.PAID",
      "toString",
      "__proto__",
      "constructor",
      "",
    ])
      expect(isReconciledEvent(name)).toBe(false);
  });
});

describe("legend-kai edge_txn_ledger written with the enqueue", () => {
  it("one transaction_event updates the ledger once and the digest reads it", async () => {
    const world = await newWorld(tenantA);
    const paid = envelope(world, "order.paid", { totalIdr: 125000 });
    const queued = await enqueue(world, paid);
    expect(queued.duplicate).toBe(false);

    const expected = totalsOf([paid]);
    const rows = await ledgerRows(world);
    expect(rows.rows).toEqual([
      {
        event_name: "order.paid",
        event_count: "1",
        amount_idr: "125000",
        id_hash_sum: expected["order.paid"]!.idHash,
      },
    ]);
    const digest = await digestOf(world);
    expect(digest.edgeNodeId).toBe(world.node.scope.edgeNodeId);
    expect(digest.edgeInstanceId).toBe(world.instanceId);
    expect(digest.throughLinkSeq).toBe(queued.linkSeq);
    // No baseline row on a node whose ledger was live from the start: from = 0.
    expect(digest.fromLinkSeq).toBe(0);
    expect(digest.totals).toEqual(expected);
  });

  it("sums count and rupiah per event name across events and aggregates", async () => {
    const world = await newWorld(tenantA);
    const aggregate = randomUUID();
    const other = randomUUID();
    const sent = [
      envelope(
        world,
        "order.submitted",
        { totalIdr: 100000 },
        { aggregateId: aggregate, sequence: 1 },
      ),
      envelope(
        world,
        "order.paid",
        { totalIdr: 100000 },
        { aggregateId: aggregate, sequence: 2 },
      ),
      envelope(
        world,
        "order.refunded",
        { amountIdr: 30000 },
        { aggregateId: aggregate, sequence: 3 },
      ),
      envelope(
        world,
        "order.paid",
        { totalIdr: 55500 },
        { aggregateId: other, sequence: 1 },
      ),
      envelope(
        world,
        "order.refunded",
        { amountIdr: 5500 },
        { aggregateId: other, sequence: 2 },
      ),
    ];
    let last = { linkSeq: 0, duplicate: false };
    for (const event of sent) last = await enqueue(world, event);
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(last.linkSeq);
    const expected = totalsOf(sent);
    expect(expected).toMatchObject({
      "order.submitted": { count: 1, amountIdr: "100000" },
      "order.paid": { count: 2, amountIdr: "155500" },
      "order.refunded": { count: 2, amountIdr: "35500" },
    });
    expect(digest.totals).toEqual(expected);
  });

  it("only the reconciled names count: other transaction events are queued but not in the ledger", async () => {
    const world = await newWorld(tenantA);
    const paidEvent = envelope(world, "order.paid", { totalIdr: 15000 });
    const paid = await enqueue(world, paidEvent);
    const added = await enqueue(
      world,
      envelope(world, "order.item_added", { totalIdr: 999, amountIdr: 888 }),
    );
    const moved = await enqueue(
      world,
      envelope(world, "stock.moved", { totalIdr: 777, amountIdr: 666 }),
    );
    // They are real queued events with their own link_seq...
    expect(added.duplicate).toBe(false);
    expect(moved.linkSeq).toBe(paid.linkSeq + 2);
    const backlog = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(3);
    // ...but the ledger and the digest only know the reconciled name.
    expect((await ledgerRows(world)).rows).toEqual([
      {
        event_name: "order.paid",
        event_count: "1",
        amount_idr: "15000",
        id_hash_sum: totalsOf([paidEvent])["order.paid"]!.idHash,
      },
    ]);
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(moved.linkSeq);
    expect(digest.totals).toEqual(totalsOf([paidEvent]));
  });

  it("a duplicate enqueue of the same event id does not count twice", async () => {
    const world = await newWorld(tenantA);
    const paid = envelope(world, "order.paid", { totalIdr: 70000 });
    const first = await enqueue(world, paid);
    const again = await enqueue(world, paid);
    expect(again).toEqual({ linkSeq: first.linkSeq, duplicate: true });
    expect((await digestOf(world)).totals).toEqual(totalsOf([paid]));
    expect((await ledgerRows(world)).rows).toHaveLength(1);
  });

  it("a rejected enqueue (sequence gap) leaves the ledger untouched", async () => {
    const world = await newWorld(tenantA);
    const aggregate = randomUUID();
    const first = envelope(
      world,
      "order.paid",
      { totalIdr: 10000 },
      { aggregateId: aggregate, sequence: 1 },
    );
    await enqueue(world, first);
    await expect(
      enqueue(
        world,
        envelope(
          world,
          "order.paid",
          { totalIdr: 99999 },
          { aggregateId: aggregate, sequence: 7 },
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await digestOf(world)).totals).toEqual(totalsOf([first]));
  });

  it("fails closed: an event with an invalid amount is not queued and not counted", async () => {
    const world = await newWorld(tenantA);
    const first = envelope(world, "order.paid", { totalIdr: 10000 });
    await enqueue(world, first);
    const before = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    for (const bad of [{}, { totalIdr: -5 }, { totalIdr: 1.5 }])
      await expect(
        enqueue(world, envelope(world, "order.paid", bad)),
      ).rejects.toThrow();
    const after = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(after.pending).toBe(before.pending);
    expect((await digestOf(world)).totals).toEqual(totalsOf([first]));
  });

  it("cloud_to_edge events and non-transaction kinds are not counted", async () => {
    const world = await newWorld(tenantA);
    await enqueue(world, envelope(world, "order.paid", { totalIdr: 123456 }), {
      direction: "cloud_to_edge",
      kind: "transaction_event",
    });
    await enqueue(world, envelope(world, "order.paid", { totalIdr: 654321 }), {
      direction: "cloud_to_edge",
      kind: "master_data",
    });
    expect((await ledgerRows(world)).rows).toEqual([]);
    expect((await digestOf(world)).totals).toEqual({});
  });

  it("amounts above 2^53 stay exact: the digest carries them as a decimal string", async () => {
    const world = await newWorld(tenantA);
    const sent = [
      envelope(world, "order.paid", { totalIdr: 9_000_000_000_000_000 }),
      envelope(world, "order.paid", { totalIdr: 9_000_000_000_000_000 }),
    ];
    for (const event of sent) await enqueue(world, event);
    const digest = await digestOf(world);
    expect(digest.totals["order.paid"]).toEqual({
      count: 2,
      amountIdr: "18000000000000000",
      idHash: totalsOf(sent)["order.paid"]!.idHash,
    });
    expect((await ledgerRows(world)).rows[0]).toMatchObject({
      amount_idr: "18000000000000000",
    });
  });

  it("the ledger outlives the acknowledged queue rows", async () => {
    const world = await newWorld(tenantA);
    const eventA = envelope(world, "order.paid", { totalIdr: 20000 });
    const eventB = envelope(world, "order.paid", { totalIdr: 30000 });
    const a = await enqueue(world, eventA);
    const b = await enqueue(world, eventB);
    const store = createDbLinkStore({
      database: db,
      context: world.node.context,
      node: world.node.scope,
      outboundDirection: "edge_to_cloud",
    });
    await store.ackOutbound(b.linkSeq);
    expect(a.linkSeq).toBeLessThan(b.linkSeq);
    const backlog = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(0);
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(b.linkSeq);
    expect(digest.totals).toEqual(totalsOf([eventA, eventB]));
  });

  it("two edge nodes keep separate ledgers", async () => {
    const one = await newWorld(tenantA);
    const two = await newWorld(tenantA);
    const oneEvents = [envelope(one, "order.paid", { totalIdr: 1000 })];
    const twoEvents = [
      envelope(two, "order.paid", { totalIdr: 2000 }),
      envelope(two, "order.paid", { totalIdr: 3000 }),
    ];
    for (const event of oneEvents) await enqueue(one, event);
    for (const event of twoEvents) await enqueue(two, event);
    expect((await digestOf(one)).totals).toEqual(totalsOf(oneEvents));
    expect((await digestOf(two)).totals).toEqual(totalsOf(twoEvents));
    expect((await digestOf(two)).totals["order.paid"]).toMatchObject({
      count: 2,
      amountIdr: "5000",
    });
  });
});

describe("legend-kai digest edge instance id (epoch)", () => {
  it("the digest carries the edge_nodes.instance_id of its own node", async () => {
    const one = await newWorld(tenantA);
    const two = await newWorld(tenantA);
    expect(one.instanceId).not.toBe(two.instanceId);
    expect((await digestOf(one)).edgeInstanceId).toBe(one.instanceId);
    expect((await digestOf(two)).edgeInstanceId).toBe(two.instanceId);
  });

  it("fails closed with a clear error while the edge instance is not initialised", async () => {
    const world = await newWorld(tenantA);
    await enqueue(world, envelope(world, "order.paid", { totalIdr: 1000 }));
    await setInstanceId(
      world.tenant.tenantId,
      world.node.scope.edgeNodeId,
      null,
    );
    await expect(digestOf(world)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Edge instance belum diinisialisasi.",
    });
  });
});

describe("legend-kai event identity hash (order-independent digest of event ids)", () => {
  const first8 = (id: string) =>
    createHash("sha256").update(id, "utf8").digest().subarray(0, 8);

  it("eventIdentityHash is the first 8 bytes (big-endian, unsigned) of sha256 of the uppercase ULID", () => {
    for (let i = 0; i < 20; i++) {
      const id = createUlid(Date.parse("2026-11-10T07:00:00.000Z") + i * 7919);
      expect(id).toBe(id.toUpperCase());
      const hash = eventIdentityHash(id);
      expect(typeof hash).toBe("bigint");
      expect(hash).toBe(first8(id).readBigUInt64BE());
      expect(hash >= 0n && hash < TWO_64).toBe(true);
    }
    // A fixed id pins the byte order (big-endian, not little-endian).
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(eventIdentityHash(id)).toBe(first8(id).readBigUInt64BE());
    expect(eventIdentityHash(id)).not.toBe(first8(id).readBigUInt64LE());
  });

  it("different event ids hash differently and the same id always the same", () => {
    const a = createUlid(Date.parse("2026-11-10T07:00:00.000Z"));
    const b = createUlid(Date.parse("2026-11-10T07:00:00.000Z"));
    expect(a).not.toBe(b);
    expect(eventIdentityHash(a)).toBe(eventIdentityHash(a));
    expect(eventIdentityHash(a)).not.toBe(eventIdentityHash(b));
  });

  it("the ledger keeps the sum of the hashes per event name modulo 2^64 (wraps)", async () => {
    const world = await newWorld(tenantA);
    const sent: EventEnvelope[] = [];
    for (let i = 0; i < 14; i++)
      sent.push(envelope(world, "order.paid", { totalIdr: 1000 + i }));
    for (const event of sent) await enqueue(world, event);
    const rawSum = sent.reduce((sum, e) => sum + eventIdentityHash(e.id), 0n);
    // 14 uniform 64-bit values sum to about 7 x 2^64: the wrap-around is exercised.
    expect(rawSum).toBeGreaterThanOrEqual(TWO_64);
    const expected = (rawSum % TWO_64).toString();
    expect((await ledgerRows(world)).rows).toEqual([
      {
        event_name: "order.paid",
        event_count: "14",
        amount_idr: String(sent.length * 1000 + (13 * 14) / 2),
        id_hash_sum: expected,
      },
    ]);
    const entry = (await digestOf(world)).totals["order.paid"]!;
    expect(entry.idHash).toBe(expected);
    expect(BigInt(entry.idHash)).toBeLessThan(TWO_64);
  });

  it("different events with the same count and the same rupiah give a different digest hash", async () => {
    const one = await newWorld(tenantA);
    const two = await newWorld(tenantA);
    for (const world of [one, two])
      for (let i = 0; i < 3; i++)
        await enqueue(world, envelope(world, "order.paid", { totalIdr: 5000 }));
    const d1 = (await digestOf(one)).totals["order.paid"]!;
    const d2 = (await digestOf(two)).totals["order.paid"]!;
    expect(d1.count).toBe(d2.count);
    expect(d1.amountIdr).toBe(d2.amountIdr);
    expect(d1.idHash).not.toBe(d2.idHash);
  });
});

describe("legend-kai bigint bounds (0..9223372036854775807)", () => {
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return null;
  };
  const sample = (name: string, payload: Record<string, unknown>) =>
    ({
      id: createUlid(Date.parse("2026-11-10T07:00:00.000Z")),
      tenantId: randomUUID(),
      outletId: randomUUID(),
      name,
      version: 1,
      aggregateType: "order",
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: "2026-11-10T07:00:00.000Z",
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `bound-${name}`,
      payloadSchemaRef: `${name}.v1`,
      payload,
    }) as unknown as EventEnvelope;
  // Money above 2^53 travels as a canonical digit string in the payload.
  const MAX_STRING = "9223372036854775807";
  const NEAR_MAX_STRING = "9223372036854774784"; // 2^63 - 1024

  it("transactionAmountIdr accepts the largest rupiah value as a digit string", () => {
    expect(
      transactionAmountIdr(sample("order.paid", { totalIdr: MAX_STRING })),
    ).toBe(MAX_BIGINT);
    expect(
      transactionAmountIdr(
        sample("order.refunded", { amountIdr: NEAR_MAX_STRING }),
      ),
    ).toBe(9223372036854774784n);
  });

  it.each([
    ["order.paid", "totalIdr", "9223372036854775808"], // max + 1
    ["order.voided", "amountIdr", "99999999999999999999"],
  ])(
    "%s with %s digit string %s is refused with a clear validation error",
    (name, key, value) => {
      expect(
        thrown(() => transactionAmountIdr(sample(name, { [key]: value }))),
      ).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Nilai rupiah melebihi batas.",
      });
    },
  );

  it.each([
    ["order.paid", "totalIdr", 2 ** 63], // = max + 1 exactly
    ["order.submitted", "totalIdr", 1e19],
    ["order.voided", "amountIdr", 1e30],
    ["order.refunded", "amountIdr", Number.MAX_VALUE],
  ])(
    "%s with %s %s is refused with a clear validation error",
    (name, key, value) => {
      expect(
        thrown(() => transactionAmountIdr(sample(name, { [key]: value }))),
      ).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Nilai rupiah melebihi batas.",
      });
    },
  );

  it("enqueue refuses an amount above the range before queueing anything", async () => {
    const world = await newWorld(tenantA);
    const first = envelope(world, "order.paid", { totalIdr: 10000 });
    const queued = await enqueue(world, first);
    const backlogBefore = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    const ledgerBefore = (await ledgerRows(world)).rows;
    for (const value of [2 ** 63, 1e19, 1e30, "9223372036854775808"])
      await expect(
        enqueue(world, envelope(world, "order.paid", { totalIdr: value })),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Nilai rupiah melebihi batas.",
      });
    await expect(
      enqueue(world, envelope(world, "order.refunded", { amountIdr: 1e25 })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Nothing queued, no link_seq burned, ledger untouched.
    const backlogAfter = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(backlogAfter.pending).toBe(backlogBefore.pending);
    expect((await ledgerRows(world)).rows).toEqual(ledgerBefore);
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(queued.linkSeq);
    expect(digest.totals).toEqual(totalsOf([first]));
  });

  it("the ledger accepts a total of exactly 9223372036854775807 and refuses one more rupiah with a clear error", async () => {
    const world = await newWorld(tenantA);
    // Sent as digit strings: a JS number cannot carry money above 2^53.
    const nearMax = envelope(world, "order.paid", {
      totalIdr: NEAR_MAX_STRING,
    });
    const topUp = envelope(world, "order.paid", { totalIdr: 1023 });
    await enqueue(world, nearMax);
    const reached = await enqueue(world, topUp);
    const digest = await digestOf(world);
    expect(digest.totals["order.paid"]).toMatchObject({
      count: 2,
      amountIdr: MAX_BIGINT.toString(),
    });
    expect(digest.totals["order.paid"]).toEqual(
      totalsOf([nearMax, topUp])["order.paid"],
    );
    const ledgerBefore = (await ledgerRows(world)).rows;
    const backlogBefore = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );

    // One rupiah more would overflow the bigint column: a clear refusal, and the
    // event is neither queued nor counted (same transaction).
    await expect(
      enqueue(world, envelope(world, "order.paid", { totalIdr: 1 })),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Total ledger melebihi batas bigint.",
    });
    expect((await ledgerRows(world)).rows).toEqual(ledgerBefore);
    const backlogAfter = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(backlogAfter.pending).toBe(backlogBefore.pending);
    expect((await digestOf(world)).throughLinkSeq).toBe(reached.linkSeq);
    // Another event name has its own row and is still accepted.
    const refunded = await enqueue(
      world,
      envelope(world, "order.refunded", { amountIdr: 5 }),
    );
    expect(refunded.linkSeq).toBe(reached.linkSeq + 1);
  });
});

describe("legend-4vwaj the ledger counts each event id once, even after the queue is pruned", () => {
  const eventRows = (world: World) =>
    asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query(
        `SELECT event_id::text AS event_id FROM edge_txn_ledger_events
          WHERE tenant_id = $1 AND edge_node_id = $2 ORDER BY event_id`,
        [world.tenant.tenantId, world.node.scope.edgeNodeId],
      ),
    );

  /** Acknowledge everything the edge queued and delete the acknowledged rows (the prune). */
  async function pruneQueue(world: World, upToLinkSeq: number) {
    const store = createDbLinkStore({
      database: db,
      context: world.node.context,
      node: world.node.scope,
      outboundDirection: "edge_to_cloud",
    });
    await store.ackOutbound(upToLinkSeq);
    await asOwnerTenant(world.tenant.tenantId, (client) =>
      client.query(
        "DELETE FROM edge_outbound_queue WHERE edge_node_id = $1 AND status = 'acked'",
        [world.node.scope.edgeNodeId],
      ),
    );
  }

  it("enqueue event E, prune the acked queue row, enqueue E again: count, rupiah and hash do not change", async () => {
    const world = await newWorld(tenantA);
    const paid = envelope(world, "order.paid", { totalIdr: 88000 });
    const other = envelope(world, "order.paid", { totalIdr: 12000 });
    await enqueue(world, paid);
    const last = await enqueue(world, other);
    await pruneQueue(world, last.linkSeq);
    const backlog = await edgeQueueBacklog(
      db,
      world.node.context,
      world.node.scope.edgeNodeId,
      "edge_to_cloud",
    );
    expect(backlog.pending).toBe(0);
    const before = (await ledgerRows(world)).rows;
    expect(before).toEqual([
      expect.objectContaining({ event_count: "2", amount_idr: "100000" }),
    ]);

    // The same event again (a replayed outbox, an app retry): not counted twice.
    await enqueue(world, paid).catch(() => undefined);
    await enqueue(world, paid).catch(() => undefined);

    expect((await ledgerRows(world)).rows).toEqual(before);
    expect((await digestOf(world)).totals).toEqual(totalsOf([paid, other]));
  });

  it("remembers every counted event id, once, in edge_txn_ledger_events", async () => {
    const world = await newWorld(tenantA);
    const paid = envelope(world, "order.paid", { totalIdr: 1000 });
    const refunded = envelope(world, "order.refunded", { amountIdr: 400 });
    await enqueue(world, paid);
    await enqueue(world, refunded);
    await enqueue(world, paid); // plain duplicate
    expect((await eventRows(world)).rows.map((r) => r.event_id).sort()).toEqual(
      [ulidToUuid(paid.id), ulidToUuid(refunded.id)].sort(),
    );
  });

  it("a rejected enqueue (invalid amount) does not remember its event id", async () => {
    const world = await newWorld(tenantA);
    const bad = envelope(world, "order.paid", { totalIdr: -5 });
    await expect(enqueue(world, bad)).rejects.toThrow();
    expect((await eventRows(world)).rows).toEqual([]);
    // The corrected event with the same id would still count (it never counted).
    const fixed = { ...bad, payload: { totalIdr: 5 } } as EventEnvelope;
    await enqueue(world, fixed);
    expect((await digestOf(world)).totals).toEqual(totalsOf([fixed]));
  });

  it("TEN-01 another tenant and another outlet read no event-id rows; no cross-tenant write", async () => {
    const world = await newWorld(tenantA);
    const paid = envelope(world, "order.paid", { totalIdr: 42000 });
    await enqueue(world, paid);
    const own = await asAppRole(
      { tenant: tenantA.tenantId, outlets: JSON.stringify([world.outletId]) },
      (client) =>
        client.query(
          "SELECT event_id::text AS event_id FROM edge_txn_ledger_events WHERE edge_node_id = $1",
          [world.node.scope.edgeNodeId],
        ),
    );
    expect(own.rows).toEqual([{ event_id: ulidToUuid(paid.id) }]);
    for (const settings of [
      { tenant: tenantB.tenantId, outlets: "*" },
      { tenant: tenantA.tenantId, outlets: JSON.stringify([tenantA.outletId]) },
    ])
      expect(
        (
          await asAppRole(settings, (client) =>
            client.query(
              "SELECT 1 FROM edge_txn_ledger_events WHERE edge_node_id = $1",
              [world.node.scope.edgeNodeId],
            ),
          )
        ).rows,
      ).toEqual([]);
    await expect(
      asAppRole({ tenant: tenantB.tenantId, outlets: "*" }, (client) =>
        client.query(
          `INSERT INTO edge_txn_ledger_events (tenant_id, outlet_id, edge_node_id, event_id)
           VALUES ($1, $2, $3, $4)`,
          [
            tenantA.tenantId,
            world.outletId,
            world.node.scope.edgeNodeId,
            ulidToUuid(createUlid(Date.parse("2026-11-10T07:30:00.000Z"))),
          ],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("legend-kai edge_txn_ledger isolation and integrity", () => {
  it("TEN-01 another tenant and another outlet read no ledger rows", async () => {
    const world = await newWorld(tenantA);
    await enqueue(world, envelope(world, "order.paid", { totalIdr: 42000 }));

    const own = await asAppRole(
      { tenant: tenantA.tenantId, outlets: JSON.stringify([world.outletId]) },
      (client) =>
        client.query(
          "SELECT event_name FROM edge_txn_ledger WHERE edge_node_id = $1",
          [world.node.scope.edgeNodeId],
        ),
    );
    expect(own.rows).toEqual([{ event_name: "order.paid" }]);

    const otherTenant = await asAppRole(
      { tenant: tenantB.tenantId, outlets: "*" },
      (client) =>
        client.query("SELECT 1 FROM edge_txn_ledger WHERE edge_node_id = $1", [
          world.node.scope.edgeNodeId,
        ]),
    );
    expect(otherTenant.rows).toEqual([]);

    const otherOutlet = await asAppRole(
      { tenant: tenantA.tenantId, outlets: JSON.stringify([tenantA.outletId]) },
      (client) =>
        client.query("SELECT 1 FROM edge_txn_ledger WHERE edge_node_id = $1", [
          world.node.scope.edgeNodeId,
        ]),
    );
    expect(otherOutlet.rows).toEqual([]);
  });

  it("another tenant cannot write a ledger row for this node", async () => {
    const world = await newWorld(tenantA);
    await expect(
      asAppRole({ tenant: tenantB.tenantId, outlets: "*" }, (client) =>
        client.query(
          `INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr, last_link_seq)
           VALUES ($1, $2, $3, 'order.paid', 1, 1, 1)`,
          [tenantA.tenantId, world.outletId, world.node.scope.edgeNodeId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses negative counts and negative rupiah at the database", async () => {
    const world = await newWorld(tenantA);
    for (const [count, amount] of [
      [-1, 0],
      [1, -1],
    ])
      await expect(
        asOwnerTenant(tenantA.tenantId, (client) =>
          client.query(
            `INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr, last_link_seq)
             VALUES ($1, $2, $3, 'order.paid', $4, $5, 1)`,
            [
              tenantA.tenantId,
              world.outletId,
              world.node.scope.edgeNodeId,
              count,
              amount,
            ],
          ),
        ),
      ).rejects.toThrow(/check constraint|violates/i);
  });

  it("refuses an identity hash sum outside 0..2^64-1 at the database", async () => {
    const world = await newWorld(tenantA);
    for (const hash of ["-1", TWO_64.toString()])
      await expect(
        asOwnerTenant(tenantA.tenantId, (client) =>
          client.query(
            `INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr, id_hash_sum, last_link_seq)
             VALUES ($1, $2, $3, 'order.paid', 1, 1, $4, 1)`,
            [
              tenantA.tenantId,
              world.outletId,
              world.node.scope.edgeNodeId,
              hash,
            ],
          ),
        ),
      ).rejects.toThrow(/check constraint|violates/i);
    // The largest legal value is accepted.
    await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query(
        `INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr, id_hash_sum, last_link_seq)
         VALUES ($1, $2, $3, 'order.paid', 1, 1, $4, 1)`,
        [
          tenantA.tenantId,
          world.outletId,
          world.node.scope.edgeNodeId,
          (TWO_64 - 1n).toString(),
        ],
      ),
    );
  });
});
