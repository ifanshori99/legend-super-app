// legend-pd9t: cost snapshot (HPP) of an edge `order.paid` parked on the cloud.
// The parked order.paid has no lines, so `edge_deferred_events.cost_snapshot_idr`
// is a CONVERGENT RECOMPUTE of Σ |quantity| x unit cost over the order's edge
// `stock.moved` sale rows, rounded once (an assignment, never an increment).
// Pinned here: any arrival order, separate batches, replays and retries end at
// the same value and never double; no stock row -> NULL; one order never feeds
// another; the cloud outbox stays empty (one edge event, one effect, no
// second deduction). Fixtures: one disposable tenant, removed in afterAll.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { inventoryEvents } from "@starter/shared/inventory";
import {
  orderPaidPayloadSchema,
  orderRefundedPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
// A second tenant, used only to prove a foreign-stamped event parks nothing.
const otherTenantId = randomUUID();
let locationA: string;
let locationB: string;
let itemId: string;
let node: AuthenticatedEdgeNode;

const scopeOf = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function createFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Order Cost', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `order-cost-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `order-cost-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'COST-01', 'COST-01', 'Jl. Uji', '{}', 'active')`,
    [outletA, tenantId, brand, entity],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'COST-02', 'COST-02', 'Jl. Uji 2', '{}', 'active')`,
    [outletB, tenantId, brand, entity],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Order Cost Lain', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      otherTenantId,
      `order-cost-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'gr', 'gram') RETURNING id",
    [tenantId],
  );
  const item = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, 'Kopi Bubuk', 'Bahan Baku', 'raw_material', $2, false) RETURNING id`,
    [tenantId, uom.rows[0]!.id],
  );
  itemId = item.rows[0]!.id;
  locationA = (
    await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang', 'warehouse') RETURNING id",
      [tenantId, outletA],
    )
  ).rows[0]!.id;
  locationB = (
    await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang B', 'warehouse') RETURNING id",
      [tenantId, outletB],
    )
  ).rows[0]!.id;
}

let clock = Date.parse("2026-11-13T09:00:00.000Z");

type Where = { tenant?: string; outlet?: string };

function orderEnvelope(
  name: string,
  orderId: string,
  sequence: number,
  payload: Record<string, unknown>,
  where: Where = {},
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: (where.tenant ?? tenantId) as EventEnvelope["tenantId"],
    outletId: (where.outlet ?? outletA) as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: "order",
    aggregateId: orderId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${orderId}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  };
}

/** An edge `order.paid` as the edge outbox forwards it (totals only, no lines). */
function orderPaid(orderId: string, where: Where = {}): EventEnvelope {
  return orderEnvelope(
    "order.paid",
    orderId,
    1,
    orderPaidPayloadSchema.parse({
      orderId,
      outletId: where.outlet ?? outletA,
      businessDate: "2034-01-02",
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: 90000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: 90000,
      paidCashIdr: 90000,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: 90000 }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: new Date(clock).toISOString(),
    }) as Record<string, unknown>,
    where,
  );
}

function orderVoided(orderId: string): EventEnvelope {
  return orderEnvelope(
    "order.voided",
    orderId,
    2,
    orderVoidedPayloadSchema.parse({
      orderId,
      outletId: outletA,
      businessDate: "2034-01-02",
      amountIdr: 90000,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder: true,
      voidId: randomUUID(),
      receiptNumber: "POS1-000001",
      voidedAt: new Date(clock).toISOString(),
    }) as Record<string, unknown>,
  );
}

function orderRefunded(orderId: string): EventEnvelope {
  return orderEnvelope(
    "order.refunded",
    orderId,
    3,
    orderRefundedPayloadSchema.parse({
      orderId,
      outletId: outletA,
      businessDate: "2034-01-02",
      refundId: randomUUID(),
      amountIdr: 90000,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: randomUUID(),
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: 90000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      refundCashIdr: 90000,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "cash", amountIdr: 90000 }],
      refundedAt: new Date(clock).toISOString(),
    }) as Record<string, unknown>,
  );
}

/** An order.paid whose payload violates the schema (never parkable). */
function brokenPaid(orderId: string): EventEnvelope {
  return orderEnvelope("order.paid", orderId, 1, { totalIdr: -1 });
}

/** One edge `stock.moved` row (one per ingredient) sourced by `orderId`. */
function stockMoved(
  orderId: string,
  quantity: string,
  unitCostIdr: string,
  movementType = "sale",
  where: { outlet: string; location: string } = {
    outlet: outletA,
    location: locationA,
  },
): EventEnvelope {
  clock += 1_000;
  const ledgerEntryId = createUlid(clock);
  const occurredAt = new Date(clock).toISOString();
  return inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId: where.outlet,
    name: "stock.moved",
    version: 1,
    aggregateType: "stock",
    aggregateId: ledgerEntryId,
    sequence: 1,
    occurredAt,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `stock.moved:${ledgerEntryId}`,
    payloadSchemaRef: "stock.moved.v1",
    payload: {
      ledgerEntryId,
      inventoryItemId: itemId,
      locationId: where.location,
      movementType,
      quantity,
      unitCostIdr,
      batchId: null,
      sourceType: "order",
      sourceId: orderId,
      occurredAt,
    },
  }) as EventEnvelope;
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

/** One receive batch through the real link (the apply transaction). */
async function deliver(events: EventEnvelope[]) {
  const link = store();
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

/** `cost_snapshot_idr` of the parked order.paid of `orderId`; undefined = no row. */
async function parkedCost(orderId: string): Promise<string | null | undefined> {
  const { rows } = await owner.query<{ cost: string | null }>(
    `SELECT cost_snapshot_idr::text AS cost FROM edge_deferred_events
      WHERE tenant_id = $1 AND event_name = 'order.paid' AND aggregate_id = $2`,
    [tenantId, orderId],
  );
  return rows.length === 0 ? undefined : rows[0]!.cost;
}

async function count(query: string, params: unknown[]) {
  const { rows } = await owner.query<{ n: number }>(query, params);
  return rows[0]!.n;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Order Cost",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerOrderEdgeApplier(); // after the POS registration, as runtime.ts does
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_deferred_events",
      "domain_event_outbox",
      "stock_balances",
      "stock_ledger",
      "stock_locations",
      "inventory_items",
      "uoms",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      [tenantId, otherTenantId],
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

// Two ingredient rows of 1000.6 each: 2001.2 rounded ONCE is 2001, whereas
// rounding per row would give 2002. One row alone is 1001 (1000.6 rounded).
const ROW = { quantity: "-1.0000", unitCostIdr: "1000.6000" };

describe("legend-pd9t order.paid cost snapshot converges from the stock rows", () => {
  it("order.paid first, then stock.moved rows in separate batches: assigned each time, rounded once", async () => {
    const orderId = createUlid(++clock);
    await deliver([orderPaid(orderId)]);
    expect(await parkedCost(orderId)).toBeNull(); // no stock row yet: never guessed

    await deliver([stockMoved(orderId, ROW.quantity, ROW.unitCostIdr)]);
    expect(await parkedCost(orderId)).toBe("1001");

    await deliver([stockMoved(orderId, ROW.quantity, ROW.unitCostIdr)]);
    expect(await parkedCost(orderId)).toBe("2001");
  });

  it("stock.moved rows first (even in the same batch), then order.paid: same value", async () => {
    const early = createUlid(++clock);
    await deliver([
      stockMoved(early, ROW.quantity, ROW.unitCostIdr),
      stockMoved(early, ROW.quantity, ROW.unitCostIdr),
    ]);
    expect(await parkedCost(early)).toBeUndefined(); // nothing parked yet
    await deliver([orderPaid(early)]);
    expect(await parkedCost(early)).toBe("2001");

    const sameBatch = createUlid(++clock);
    await deliver([
      orderPaid(sameBatch),
      stockMoved(sameBatch, ROW.quantity, ROW.unitCostIdr),
      stockMoved(sameBatch, ROW.quantity, ROW.unitCostIdr),
    ]);
    expect(await parkedCost(sameBatch)).toBe("2001");
  });

  it("a replay or resend of either event never doubles the cost", async () => {
    const orderId = createUlid(++clock);
    const paid = orderPaid(orderId);
    const rowA = stockMoved(orderId, ROW.quantity, ROW.unitCostIdr);
    const rowB = stockMoved(orderId, ROW.quantity, ROW.unitCostIdr);
    await deliver([paid, rowA, rowB]);
    expect(await parkedCost(orderId)).toBe("2001");

    await deliver([rowA]);
    await deliver([paid]);
    await deliver([rowB, paid, rowA]);
    expect(await parkedCost(orderId)).toBe("2001");
    // one edge event, one effect
    expect(
      await count(
        "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1 AND aggregate_id = $2",
        [tenantId, orderId],
      ),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2::uuid",
        [tenantId, ulidToUuid(orderId)],
      ),
    ).toBe(2);
  });

  it("an order with no stock rows stays NULL; another order's rows never feed it", async () => {
    const bare = createUlid(++clock);
    const other = createUlid(++clock);
    await deliver([
      orderPaid(bare),
      orderPaid(other),
      stockMoved(other, "-2.0000", "1234.5678"),
    ]);
    expect(await parkedCost(bare)).toBeNull();
    expect(await parkedCost(other)).toBe("2469"); // 2 x 1234.5678 = 2469.1356
  });

  it("only sale rows of the order count (a return row of the same source id is ignored)", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      orderPaid(orderId),
      stockMoved(orderId, "-2.0000", "1234.5678"),
      stockMoved(orderId, "1.0000", "1234.5678", "return"),
    ]);
    expect(await parkedCost(orderId)).toBe("2469");
  });

  // legend-8qm1d. An order that was voided gives its stock back as `return`
  // rows (positive quantity, same source id). The parked order.paid's cost must
  // net them: cost = max(0, sale cost - return cost), rounded once. Assumptions
  // where the card is silent: a fully returned order is "0" (rows exist, so not
  // NULL = unknown); the return is valued at its own row's unit cost; the
  // existing "return row is ignored" case above has no order.voided event, so
  // it stays valid (returns only count on a voided order).
  it("a voided order's return rows reduce the parked cost: 2 sold, 1 returned = 1 x 1234,5678 rounded to 1235", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      orderPaid(orderId),
      stockMoved(orderId, "-2.0000", "1234.5678"),
      orderVoided(orderId),
    ]);
    await deliver([stockMoved(orderId, "1.0000", "1234.5678", "return")]);
    expect(await parkedCost(orderId)).toBe("1235");
  });

  it("a voided order with everything returned parks 0, never negative and never NULL", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      orderPaid(orderId),
      stockMoved(orderId, "-2.0000", "1234.5678"),
      orderVoided(orderId),
    ]);
    await deliver([stockMoved(orderId, "2.0000", "1234.5678", "return")]);
    expect(await parkedCost(orderId)).toBe("0");
  });

  it("a return larger than the sale never pushes the cost below 0", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      orderPaid(orderId),
      stockMoved(orderId, "-1.0000", "1234.5678"),
      orderVoided(orderId),
    ]);
    await deliver([stockMoved(orderId, "5.0000", "1234.5678", "return")]);
    expect(await parkedCost(orderId)).toBe("0");
  });

  it("a replay of the same return row after the void never subtracts twice", async () => {
    const orderId = createUlid(++clock);
    const returned = stockMoved(orderId, "1.0000", "1234.5678", "return");
    await deliver([
      orderPaid(orderId),
      stockMoved(orderId, "-2.0000", "1234.5678"),
      orderVoided(orderId),
    ]);
    await deliver([returned]);
    await deliver([returned]);
    expect(await parkedCost(orderId)).toBe("1235");
  });

  it("applies nothing to the cloud outbox for order.paid (no second deduction)", async () => {
    const orderId = createUlid(++clock);
    const paid = orderPaid(orderId);
    await deliver([paid, stockMoved(orderId, ROW.quantity, ROW.unitCostIdr)]);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' = 'order.paid'",
        [tenantId],
      ),
    ).toBe(0);
  });

  it("registering twice keeps the one hook (idempotent)", () => {
    registerOrderEdgeApplier();
    expect(() => registerOrderEdgeApplier()).not.toThrow();
  });
});

// Shuffle with a fixed seed: the order is random-looking but the run is
// reproducible (no timing, no flake).
function shuffled<T>(items: T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const other = state % (index + 1);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

// The edge queues an aggregate's events in sequence order (queueOrderViolation)
// and the link applies a transaction event only as the next sequence of its
// aggregate (conflict.ts: a hole is a recorded sequence_gap, never parked). So
// the shuffle may interleave orders, stock rows and duplicates freely, but the
// order.* events of one order keep their sequence order: each order's slots in
// the shuffled list are refilled with that order's events sorted by sequence.
function keepAggregateOrder(events: EventEnvelope[]): EventEnvelope[] {
  const result = [...events];
  const slots = new Map<string, number[]>();
  events.forEach((event, index) => {
    if (event.aggregateType !== "order") return;
    slots.set(event.aggregateId, [
      ...(slots.get(event.aggregateId) ?? []),
      index,
    ]);
  });
  for (const positions of slots.values()) {
    const sorted = positions
      .map((position) => events[position]!)
      .sort((a, b) => a.sequence - b.sequence);
    positions.forEach((position, index) => {
      result[position] = sorted[index]!;
    });
  }
  return result;
}

const parkedRowsOf = (event: EventEnvelope, tenant = tenantId) =>
  count(
    "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenant, ulidToUuid(event.id)],
  );

describe("legend-pd9t random order, no re-emit, stock once", () => {
  it("random order with duplicates (seeded), one event per batch: every order converges to the same cost, every event parked once", async () => {
    const events: EventEnvelope[] = [];
    const orders: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const orderId = createUlid(++clock);
      orders.push(orderId);
      events.push(
        orderPaid(orderId),
        stockMoved(orderId, ROW.quantity, ROW.unitCostIdr),
        stockMoved(orderId, ROW.quantity, ROW.unitCostIdr),
        orderVoided(orderId),
        orderRefunded(orderId),
      );
    }

    for (const event of keepAggregateOrder(
      shuffled([...events, ...events, ...events], 20260513),
    ))
      await deliver([event]);

    for (const orderId of orders)
      expect(await parkedCost(orderId)).toBe("2001");
    for (const event of events.filter((e) => e.name.startsWith("order.")))
      expect(await parkedRowsOf(event), event.name).toBe(1);
  });

  it("paid, voided and refunded (twice) add no order.* row to the cloud outbox and none is refused", async () => {
    const orderId = createUlid(++clock);
    const events = [
      orderPaid(orderId),
      orderVoided(orderId),
      orderRefunded(orderId),
    ];

    // Guard A (legend-078n) rejects a handler that re-emits: both must resolve.
    await deliver(events);
    await deliver(events.map((event) => event));

    for (const event of events)
      expect(await parkedRowsOf(event), event.name).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'name' LIKE 'order.%'",
        [tenantId],
      ),
    ).toBe(0);
  });

  it("the sale rows deduct stock once however often replayed: ledger sum equals one delivery, no recipe deduction", async () => {
    const orderId = createUlid(++clock);
    const paid = orderPaid(orderId);
    const rowA = stockMoved(orderId, "-3.0000", "10.0000");
    const rowB = stockMoved(orderId, "-4.0000", "10.0000");
    const deductionsBefore = await count(
      "SELECT count(*)::int AS n FROM recipe_deductions WHERE tenant_id = $1",
      [tenantId],
    );

    await deliver([paid, rowA, rowB]);
    await deliver([rowA, paid]);
    await deliver([rowB, rowA, rowB]);

    const { rows } = await owner.query<{ total: string; n: number }>(
      `SELECT sum(quantity)::text AS total, count(*)::int AS n FROM stock_ledger
        WHERE tenant_id = $1 AND source_id = $2::uuid`,
      [tenantId, ulidToUuid(orderId)],
    );
    expect(rows[0]!.n).toBe(2);
    expect(Number(rows[0]!.total)).toBe(-7);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM recipe_deductions WHERE tenant_id = $1",
        [tenantId],
      ),
    ).toBe(deductionsBefore);
    expect(await parkedCost(orderId)).toBe("70");
  });
});

describe("legend-pd9t tenant and outlet isolation", () => {
  it("a sale row stamped for outlet B and sent by outlet A's node is refused or ignored: outlet A's cost and outlet B's ledger are unchanged", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      orderPaid(orderId),
      stockMoved(orderId, ROW.quantity, ROW.unitCostIdr),
    ]);
    expect(await parkedCost(orderId)).toBe("1001");
    const foreign = stockMoved(orderId, "-9.0000", "1000.0000", "sale", {
      outlet: outletB,
      location: locationB,
    });

    // Rejected or recorded as a conflict: both acceptable, the effects are not.
    await deliver([foreign]).catch(() => undefined);

    expect(await parkedCost(orderId)).toBe("1001");
    expect(
      await count(
        "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND location_id = $2",
        [tenantId, locationB],
      ),
    ).toBe(0);
  });

  it("an order.paid stamped for outlet B and sent by outlet A's node parks no cost under outlet B", async () => {
    const orderId = createUlid(++clock);
    const foreign = orderPaid(orderId, { outlet: outletB });

    await deliver([foreign]).catch(() => undefined);

    const { rows } = await owner.query<{ cost: string | null }>(
      `SELECT cost_snapshot_idr::text AS cost FROM edge_deferred_events
        WHERE tenant_id = $1 AND event_id = $2::uuid AND outlet_id = $3`,
      [tenantId, ulidToUuid(foreign.id), outletB],
    );
    expect(rows.every((row) => row.cost === null)).toBe(true);
  });

  it("an event stamped with another tenant id, sent by this tenant's node, parks nothing for that tenant", async () => {
    const orderId = createUlid(++clock);
    const foreign = orderPaid(orderId, { tenant: otherTenantId });

    await deliver([foreign]).catch(() => undefined);

    expect(await parkedRowsOf(foreign, otherTenantId)).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1",
        [otherTenantId],
      ),
    ).toBe(0);
  });
});

describe("legend-pd9t parked, then recovered", () => {
  it("a backlog delivered after an outage in one batch: none lost, each costed, the link cursor advances", async () => {
    const events: EventEnvelope[] = [];
    const orders: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const orderId = createUlid(++clock);
      orders.push(orderId);
      events.push(
        orderPaid(orderId),
        stockMoved(orderId, ROW.quantity, ROW.unitCostIdr),
      );
    }
    const link = store();
    const before = await link.lastReceivedInbound();

    await deliver(events);

    expect(await link.lastReceivedInbound()).toBe(before + events.length);
    for (const orderId of orders)
      expect(await parkedCost(orderId)).toBe("1001");
  });

  it("a batch that fails (invalid order.paid) loses no valid event: redelivery parks it once with its cost", async () => {
    const orderId = createUlid(++clock);
    const paid = orderPaid(orderId);
    const row = stockMoved(orderId, ROW.quantity, ROW.unitCostIdr);
    const broken = brokenPaid(createUlid(++clock));

    // Rolled back (rejects) or recorded as a conflict: both acceptable.
    await deliver([paid, row, broken]).catch(() => undefined);
    await deliver([paid, row]);

    expect(await parkedRowsOf(paid)).toBe(1);
    expect(await parkedCost(orderId)).toBe("1001");
    expect(await parkedRowsOf(broken)).toBe(0);
  });
});
