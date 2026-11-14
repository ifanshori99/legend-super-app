// Edge -> cloud `stock.moved` applier and the applier registry (bead
// legend-s4r6, brief 90 section H). The cloud link store receives an edge
// `stock.moved`, the registry dispatches it to edge/stock-moved-applier.ts,
// which writes the edge's ledger row on the cloud and re-emits `stock.moved`
// on the cloud outbox (GL bridge) without queueing anything back to the edge.
// Fixtures: one disposable tenant with two outlets, created by the migration
// owner and removed in afterAll.
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  registeredEdgeEventClassifier,
  resetEdgeApplierRegistryForTests,
} from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  classifyEdgeEvent,
  EdgeApplierUnavailableError,
  EdgeEventUnclassifiedError,
  edgeEventApplier,
  type EdgeApplyMeta,
} from "../edge/ports.ts";
import {
  applyEdgeStockMoved,
  registerStockMovedEdgeApplier,
} from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { createBuiltinWorkerTransport } from "../worker/transport.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
let locationA: string;
let locationB: string;
let itemId: string;
let node: AuthenticatedEdgeNode;

const scopeOf = (outletIds: string[] | "tenant"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    outletIds === "tenant"
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );

async function createFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Stok Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `stok-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `stok-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  for (const [id, code] of [
    [outletA, "STK-01"],
    [outletB, "STK-02"],
  ])
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brand, entity, code],
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
  const location = async (outletId: string) =>
    (
      await owner.query<{ id: string }>(
        "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang', 'warehouse') RETURNING id",
        [tenantId, outletId],
      )
    ).rows[0]!.id;
  locationA = await location(outletA);
  locationB = await location(outletB);
}

let clock = Date.parse("2026-11-09T08:00:00.000Z");
/** An edge `stock.moved` exactly as inventory.service.ts emits it. */
function stockMoved(
  overrides: {
    tenantId?: string;
    outletId?: string;
    locationId?: string;
    ledgerEntryId?: string;
    quantity?: string;
    movementType?: string;
    sourceType?: string;
    sourceId?: string;
  } = {},
): { event: EventEnvelope; ledgerEntryId: string } {
  clock += 1_000;
  const ledgerEntryId = overrides.ledgerEntryId ?? createUlid(clock);
  const occurredAt = new Date(clock).toISOString();
  const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(clock),
    tenantId: overrides.tenantId ?? tenantId,
    outletId: overrides.outletId ?? outletA,
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
      locationId: overrides.locationId ?? locationA,
      movementType: overrides.movementType ?? "sale",
      quantity: overrides.quantity ?? "-2.0000",
      // Not the cloud's average cost: the edge's own value must be kept.
      unitCostIdr: "1234.5678",
      batchId: null,
      sourceType: overrides.sourceType ?? "order",
      sourceId: overrides.sourceId ?? createUlid(clock),
      occurredAt,
    },
  }) as EventEnvelope;
  return { event, ledgerEntryId };
}

function store() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

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

const meta = (context = node.context): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context,
});

async function ledgerRows(ledgerEntryId: string) {
  const { rows } = await owner.query<{
    quantity: string;
    unit_cost_idr: string;
    occurred_at: Date;
  }>(
    "SELECT quantity::text, unit_cost_idr::text, occurred_at FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, ulidToUuid(ledgerEntryId)],
  );
  return rows;
}

async function outboxRows(ledgerEntryId: string) {
  const { rows } = await owner.query<{
    destination: string;
    direction: string | null;
    event: EventEnvelope;
  }>(
    "SELECT destination, direction, event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2::uuid",
    [tenantId, ulidToUuid(ledgerEntryId)],
  );
  return rows;
}

async function refusedConflicts(eventId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid AND reason = 'applier_refused'",
    [tenantId, ulidToUuid(eventId)],
  );
  return rows[0]!.n;
}

async function conflictReasons(eventId: string) {
  const { rows } = await owner.query<{ reason: string }>(
    "SELECT reason FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenantId, ulidToUuid(eventId)],
  );
  return rows.map((row) => row.reason);
}

async function balanceOf(locationId: string) {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantId, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

async function cloudToEdgeQueue() {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM edge_outbound_queue WHERE tenant_id = $1 AND direction = 'cloud_to_edge'",
    [tenantId],
  );
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
    label: "Utama Stok",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
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
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-s4r6 edge -> cloud stock.moved", () => {
  it("applies once: the edge's ledger row, the balance and one cloud outbox event", async () => {
    const { event, ledgerEntryId } = stockMoved();
    const queueBefore = await cloudToEdgeQueue();
    await deliver([event]);

    const ledger = await ledgerRows(ledgerEntryId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.quantity).toBe("-2.0000");
    expect(ledger[0]!.unit_cost_idr).toBe("1234.5678");
    expect(ledger[0]!.occurred_at.toISOString()).toBe(event.occurredAt);
    expect(await balanceOf(locationA)).toBe("-2.0000");

    const outbox = await outboxRows(ledgerEntryId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.destination).toBe("cloud-sync");
    expect(outbox[0]!.direction).toBeNull();
    expect(outbox[0]!.event.name).toBe("stock.moved");
    expect(outbox[0]!.event.idempotencyKey).toBe(
      `stock.moved:${ledgerEntryId}`,
    );
    expect(await cloudToEdgeQueue()).toBe(queueBefore);
  });

  it("a replay changes nothing (link re-delivery and a direct second apply)", async () => {
    const { event, ledgerEntryId } = stockMoved();
    await deliver([event]);
    const balance = await balanceOf(locationA);
    await deliver([event]);
    await withTenant(db, node.context, (tx) =>
      applyEdgeStockMoved(tx, event, meta()),
    );
    expect(await ledgerRows(ledgerEntryId)).toHaveLength(1);
    expect(await outboxRows(ledgerEntryId)).toHaveLength(1);
    expect(await balanceOf(locationA)).toBe(balance);
  });

  it("refuses a different movement that reuses a recorded ledger id", async () => {
    const { event, ledgerEntryId } = stockMoved();
    await deliver([event]);
    const balance = await balanceOf(locationA);
    const { event: colliding } = stockMoved({
      ledgerEntryId,
      quantity: "-5.0000",
    });
    await expect(
      withTenant(db, node.context, (tx) =>
        applyEdgeStockMoved(tx, colliding, meta()),
      ),
    ).rejects.toThrow();
    // Through the link the same aggregate sequence is already taken, so the
    // sequencer records a reviewable conflict before the applier runs.
    await deliver([colliding]);
    expect(await conflictReasons(colliding.id)).toHaveLength(1);
    const ledger = await ledgerRows(ledgerEntryId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.quantity).toBe("-2.0000");
    expect(await outboxRows(ledgerEntryId)).toHaveLength(1);
    expect(await balanceOf(locationA)).toBe(balance);
  });

  it("refuses a stock source an edge never produces (goods receipt)", async () => {
    const { event, ledgerEntryId } = stockMoved({
      movementType: "receipt",
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      quantity: "3.0000",
    });
    await expect(
      withTenant(db, node.context, (tx) =>
        applyEdgeStockMoved(tx, event, meta()),
      ),
    ).rejects.toMatchObject({ status: 422 });
    // Through the link the refusal becomes a reviewable conflict.
    await deliver([event]);
    expect(await refusedConflicts(event.id)).toBe(1);
    expect(await ledgerRows(ledgerEntryId)).toHaveLength(0);
  });

  it("refuses rows for a source document that another outlet already posted", async () => {
    const sourceId = createUlid(clock);
    // A cloud row of outlet B for the same order document.
    await owner.query(
      `INSERT INTO stock_ledger (id, tenant_id, outlet_id, location_id, inventory_item_id, movement_type,
         quantity, unit_cost_idr, batch_id, source_type, source_id, occurred_at)
       VALUES ($1::uuid, $2, $3, $4, $5, 'sale', -1, 1000, NULL, 'order', $6::uuid, now())`,
      [
        ulidToUuid(createUlid(clock + 1)),
        tenantId,
        outletB,
        locationB,
        itemId,
        ulidToUuid(sourceId),
      ],
    );
    const { event, ledgerEntryId } = stockMoved({ sourceId });
    await expect(
      withTenant(db, node.context, (tx) =>
        applyEdgeStockMoved(tx, event, meta()),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await ledgerRows(ledgerEntryId)).toHaveLength(0);
    expect(await outboxRows(ledgerEntryId)).toHaveLength(0);
    // The same document on the node's own outlet is fine (more lines).
    const first = stockMoved({ sourceId: createUlid(clock + 2) });
    const second = stockMoved({
      sourceId: first.event.payload.sourceId as string,
    });
    await deliver([first.event, second.event]);
    expect(await ledgerRows(first.ledgerEntryId)).toHaveLength(1);
    expect(await ledgerRows(second.ledgerEntryId)).toHaveLength(1);
  });

  it("refuses an event of another tenant", async () => {
    const { event, ledgerEntryId } = stockMoved({ tenantId: randomUUID() });
    await expect(
      withTenant(db, node.context, (tx) =>
        applyEdgeStockMoved(tx, event, meta()),
      ),
    ).rejects.toThrow();
    expect(await ledgerRows(ledgerEntryId)).toHaveLength(0);
  });

  it("refuses an event of an outlet outside the node scope", async () => {
    const { event, ledgerEntryId } = stockMoved({
      outletId: outletB,
      locationId: locationB,
    });
    await expect(
      withTenant(db, node.context, (tx) =>
        applyEdgeStockMoved(tx, event, meta()),
      ),
    ).rejects.toThrow();
    // Even with a tenant-wide context, the node's own outlet decides.
    const tenantWide = scopeOf("tenant");
    await expect(
      withTenant(db, tenantWide, (tx) =>
        applyEdgeStockMoved(tx, event, meta(tenantWide)),
      ),
    ).rejects.toThrow();
    // And the link itself refuses it before any applier runs.
    await expect(deliver([event])).rejects.toThrow();
    expect(await ledgerRows(ledgerEntryId)).toHaveLength(0);
    expect(await balanceOf(locationB)).toBeNull();
  });

  it("an unknown event type stays refused and unclassified", async () => {
    clock += 1_000;
    const unknown: EventEnvelope = {
      id: createUlid(clock),
      tenantId: tenantId as EventEnvelope["tenantId"],
      outletId: outletA as EventEnvelope["outletId"],
      name: "order.item_added",
      version: 1,
      aggregateType: "order",
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: new Date(clock).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `stok-unknown-${clock}`,
      payloadSchemaRef: "order.item_added.v1",
      payload: {},
    };
    expect(registeredEdgeEventClassifier(unknown)).toBeNull();
    expect(() => classifyEdgeEvent(unknown)).toThrow(
      EdgeEventUnclassifiedError,
    );
    await expect(
      withTenant(db, node.context, (tx) =>
        edgeEventApplier("edge_to_cloud").apply(tx, unknown, meta()),
      ),
    ).rejects.toBeInstanceOf(EdgeApplierUnavailableError);
    const link = store();
    const before = await link.lastReceivedInbound();
    await expect(deliver([unknown])).rejects.toThrow();
    expect(await link.lastReceivedInbound()).toBe(before);
  });

  it("the cloud transport keeps the re-emitted event local: nothing is queued cloud_to_edge", async () => {
    const { event, ledgerEntryId } = stockMoved();
    await deliver([event]);
    const [row] = await outboxRows(ledgerEntryId);
    const queueBefore = await cloudToEdgeQueue();
    const transport = createBuiltinWorkerTransport({
      database: db,
      env: { EDGE_MODE: "false" },
    });
    await withTenant(db, node.context, (tx) =>
      transport.deliverEvent(node.context, row!.event, "key", tx, {
        destination: row!.destination,
        direction: row!.direction,
        peerId: null,
      }),
    );
    expect(await cloudToEdgeQueue()).toBe(queueBefore);
  });

  it("registering twice keeps one dispatcher", async () => {
    registerStockMovedEdgeApplier();
    const dispatcher = edgeEventApplier("edge_to_cloud");
    registerStockMovedEdgeApplier();
    expect(edgeEventApplier("edge_to_cloud")).toBe(dispatcher);
  });
});
