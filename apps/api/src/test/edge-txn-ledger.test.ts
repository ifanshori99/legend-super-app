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
// - enqueue of a master_data event on edge_to_cloud is not exercised (it may be
//   refused by the queue itself); non-counting kinds are covered with
//   cloud_to_edge master_data and cloud_to_edge transaction_event.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
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
};

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
  return { node, outletId, tenant };
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
      `SELECT event_name, event_count::text AS event_count, amount_idr::text AS amount_idr
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

    const rows = await ledgerRows(world);
    expect(rows.rows).toEqual([
      { event_name: "order.paid", event_count: "1", amount_idr: "125000" },
    ]);
    const digest = await digestOf(world);
    expect(digest.edgeNodeId).toBe(world.node.scope.edgeNodeId);
    expect(digest.throughLinkSeq).toBe(queued.linkSeq);
    // No baseline row on a node whose ledger was live from the start: from = 0.
    expect(digest.fromLinkSeq).toBe(0);
    expect(digest.totals).toEqual({
      "order.paid": { count: 1, amountIdr: "125000" },
    });
  });

  it("sums count and rupiah per event name across events and aggregates", async () => {
    const world = await newWorld(tenantA);
    const aggregate = randomUUID();
    await enqueue(
      world,
      envelope(
        world,
        "order.submitted",
        { totalIdr: 100000 },
        { aggregateId: aggregate, sequence: 1 },
      ),
    );
    await enqueue(
      world,
      envelope(
        world,
        "order.paid",
        { totalIdr: 100000 },
        { aggregateId: aggregate, sequence: 2 },
      ),
    );
    await enqueue(
      world,
      envelope(
        world,
        "order.refunded",
        { amountIdr: 30000 },
        { aggregateId: aggregate, sequence: 3 },
      ),
    );
    const other = randomUUID();
    await enqueue(
      world,
      envelope(
        world,
        "order.paid",
        { totalIdr: 55500 },
        { aggregateId: other, sequence: 1 },
      ),
    );
    const last = await enqueue(
      world,
      envelope(
        world,
        "order.refunded",
        { amountIdr: 5500 },
        { aggregateId: other, sequence: 2 },
      ),
    );
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(last.linkSeq);
    expect(digest.totals).toEqual({
      "order.submitted": { count: 1, amountIdr: "100000" },
      "order.paid": { count: 2, amountIdr: "155500" },
      "order.refunded": { count: 2, amountIdr: "35500" },
    });
  });

  it("only the reconciled names count: other transaction events are queued but not in the ledger", async () => {
    const world = await newWorld(tenantA);
    const paid = await enqueue(
      world,
      envelope(world, "order.paid", { totalIdr: 15000 }),
    );
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
      { event_name: "order.paid", event_count: "1", amount_idr: "15000" },
    ]);
    const digest = await digestOf(world);
    expect(digest.throughLinkSeq).toBe(moved.linkSeq);
    expect(digest.totals).toEqual({
      "order.paid": { count: 1, amountIdr: "15000" },
    });
  });

  it("a duplicate enqueue of the same event id does not count twice", async () => {
    const world = await newWorld(tenantA);
    const paid = envelope(world, "order.paid", { totalIdr: 70000 });
    const first = await enqueue(world, paid);
    const again = await enqueue(world, paid);
    expect(again).toEqual({ linkSeq: first.linkSeq, duplicate: true });
    expect((await digestOf(world)).totals).toEqual({
      "order.paid": { count: 1, amountIdr: "70000" },
    });
    expect((await ledgerRows(world)).rows).toHaveLength(1);
  });

  it("a rejected enqueue (sequence gap) leaves the ledger untouched", async () => {
    const world = await newWorld(tenantA);
    const aggregate = randomUUID();
    await enqueue(
      world,
      envelope(
        world,
        "order.paid",
        { totalIdr: 10000 },
        { aggregateId: aggregate, sequence: 1 },
      ),
    );
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
    expect((await digestOf(world)).totals).toEqual({
      "order.paid": { count: 1, amountIdr: "10000" },
    });
  });

  it("fails closed: an event with an invalid amount is not queued and not counted", async () => {
    const world = await newWorld(tenantA);
    await enqueue(world, envelope(world, "order.paid", { totalIdr: 10000 }));
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
    expect((await digestOf(world)).totals).toEqual({
      "order.paid": { count: 1, amountIdr: "10000" },
    });
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
    await enqueue(
      world,
      envelope(world, "order.paid", { totalIdr: 9_000_000_000_000_000 }),
    );
    await enqueue(
      world,
      envelope(world, "order.paid", { totalIdr: 9_000_000_000_000_000 }),
    );
    const digest = await digestOf(world);
    expect(digest.totals["order.paid"]).toEqual({
      count: 2,
      amountIdr: "18000000000000000",
    });
    expect((await ledgerRows(world)).rows[0]).toMatchObject({
      amount_idr: "18000000000000000",
    });
  });

  it("the ledger outlives the acknowledged queue rows", async () => {
    const world = await newWorld(tenantA);
    const a = await enqueue(
      world,
      envelope(world, "order.paid", { totalIdr: 20000 }),
    );
    const b = await enqueue(
      world,
      envelope(world, "order.paid", { totalIdr: 30000 }),
    );
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
    expect(digest.totals).toEqual({
      "order.paid": { count: 2, amountIdr: "50000" },
    });
  });

  it("two edge nodes keep separate ledgers", async () => {
    const one = await newWorld(tenantA);
    const two = await newWorld(tenantA);
    await enqueue(one, envelope(one, "order.paid", { totalIdr: 1000 }));
    await enqueue(two, envelope(two, "order.paid", { totalIdr: 2000 }));
    await enqueue(two, envelope(two, "order.paid", { totalIdr: 3000 }));
    expect((await digestOf(one)).totals).toEqual({
      "order.paid": { count: 1, amountIdr: "1000" },
    });
    expect((await digestOf(two)).totals).toEqual({
      "order.paid": { count: 2, amountIdr: "5000" },
    });
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
          `INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr)
           VALUES ($1, $2, $3, 'order.paid', 1, 1)`,
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
            `INSERT INTO edge_txn_ledger (tenant_id, outlet_id, edge_node_id, event_name, event_count, amount_idr)
             VALUES ($1, $2, $3, 'order.paid', $4, $5)`,
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
});
