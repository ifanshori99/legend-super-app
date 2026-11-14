// Edge -> cloud POS `order.*` events are parked, not applied (bead legend-9fhs,
// tier K offline sync). Before the fix the cloud had no classifier for the
// `order` aggregate, so one `order.paid` rolled back the whole receive batch,
// the cursor never advanced and the edge->cloud link stalled for good (also
// blocking `stock.moved`, so no HPP from edge outlets). Now the cloud stores
// the full envelope once in `edge_deferred_events` and applies nothing else
// (no outbox row, no stock, no GL) until a later POS-order applier backfills
// from that table (legend-078n).
//
// Assumptions (the brief does not pin them down):
// - `edge_deferred_events.event_id` is the envelope id in uuid form
//   (ulidToUuid(event.id)), like the other edge tables.
// - The link itself refuses an event whose outlet is not the node's outlet
//   before any applier runs (existing behaviour, same for stock.moved), so a
//   wrong-outlet event cannot become an `applier_refused` conflict through the
//   link; the 4xx refusal is asserted on the registered handler directly.
// - A refusal is a 4xx error (CoreError) from the registered handler; through
//   the link it must become an `applier_refused` conflict, not a stall.
// - (Round 2) The generic fallback parks any edge->cloud event of an aggregate
//   without an explicit handler with parked_reason='unclassified'; explicit WS-04
//   registrations (order.*) park with 'deferred'. The cloud_to_edge "unchanged"
//   check goes through the registered cloud_to_edge dispatcher (the classifier's
//   direction parameter is not pinned by the brief): an unknown aggregate must
//   never be parked, whatever the legacy fallback does with it.
// Fixtures: two disposable tenants (A with two outlets, B with one), removed in
// afterAll. Same fixture style as edge-stock-moved-applier.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
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
import { eventCatalog, type EventEnvelope } from "@starter/shared/events";
import { inventoryEvents } from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  registeredEdgeEventClassifier,
  resetEdgeApplierRegistryForTests,
} from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerAccessEdgeApplier } from "../edge/access-applier.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
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
const otherTenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const otherTenantOutlet = randomUUID();
let locationA: string;
let itemId: string;
let node: AuthenticatedEdgeNode;

// Every `order.*` name in the shared catalog, never hand-listed.
const orderEventNames = eventCatalog
  .filter((entry) => entry.name.startsWith("order."))
  .map((entry) => entry.name);

const scopeOf = (
  tenant: string,
  outletIds: string[] | "tenant",
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    outletIds === "tenant"
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );

async function createTenant(
  id: string,
  outlets: [string, string][],
): Promise<void> {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Order Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      id,
      `order-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, id, `order-edge-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, id],
  );
  for (const [outletId, code] of outlets)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [outletId, id, brand, entity, code],
    );
}

async function createFixture() {
  await createTenant(tenantId, [
    [outletA, "ORD-01"],
    [outletB, "ORD-02"],
  ]);
  await createTenant(otherTenantId, [[otherTenantOutlet, "ORD-X1"]]);
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
}

let clock = Date.parse("2026-11-09T09:00:00.000Z");

/** An edge POS `order.*` event as the edge outbox forwards it. */
function orderEvent(
  overrides: {
    name?: string;
    tenantId?: string;
    outletId?: string | null;
    aggregateId?: string;
    sequence?: number;
  } = {},
): EventEnvelope {
  clock += 1_000;
  const name = overrides.name ?? "order.paid";
  return {
    id: createUlid(clock),
    tenantId: (overrides.tenantId ?? tenantId) as EventEnvelope["tenantId"],
    outletId: (overrides.outletId === undefined
      ? outletA
      : overrides.outletId) as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.split(".")[0]!,
    aggregateId: overrides.aggregateId ?? createUlid(clock),
    sequence: overrides.sequence ?? 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:order-deferred-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: { totalIdr: 90000, receiptNumber: `LG-${clock}` },
  };
}

/** An edge `stock.moved` exactly as inventory.service.ts emits it. */
function stockMoved(): { event: EventEnvelope; ledgerEntryId: string } {
  clock += 1_000;
  const ledgerEntryId = createUlid(clock);
  const occurredAt = new Date(clock).toISOString();
  const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId: outletA,
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
      locationId: locationA,
      movementType: "sale",
      quantity: "-2.0000",
      unitCostIdr: "1234.5678",
      batchId: null,
      sourceType: "order",
      sourceId: createUlid(clock),
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

/** Runs the registered edge->cloud dispatcher directly; resolves to the
 *  refusal's HTTP status, or null when it applied. */
async function applyDirect(
  event: EventEnvelope,
  context = node.context,
): Promise<number | null> {
  try {
    await withTenant(db, context, (tx) =>
      edgeEventApplier("edge_to_cloud").apply(tx, event, meta(context)),
    );
    return null;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : -1;
  }
}

async function deferredRows(eventId: string) {
  const { rows } = await owner.query<{
    tenant_id: string;
    outlet_id: string;
    edge_node_id: string;
    event_id: string;
    aggregate_type: string;
    event_name: string;
    parked_reason: string;
    envelope: EventEnvelope;
  }>(
    "SELECT tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, event_name, parked_reason, envelope FROM edge_deferred_events WHERE event_id = $1::uuid",
    [ulidToUuid(eventId)],
  );
  return rows;
}

async function count(query: string, params: unknown[]) {
  const { rows } = await owner.query<{ n: number }>(query, params);
  return rows[0]!.n;
}

const cloudOutboxCount = () =>
  count(
    "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1",
    [tenantId],
  );
const ledgerCount = () =>
  count("SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1", [
    tenantId,
  ]);
const ledgerRows = (ledgerEntryId: string) =>
  count(
    "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, ulidToUuid(ledgerEntryId)],
  );
const orderOutboxRows = (eventId: string) =>
  count(
    "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'id' = $2",
    [tenantId, eventId],
  );
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(
    scopeOf(tenantId, [outletA]),
    actor,
    { outletId: outletA, role: "primary", label: "Utama Order" },
  );
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerAccessEdgeApplier(); // legend-kyie (was parked deferred, legend-eadm)
  registerEdgeDeferredFallback(); // after the explicit registrations, as runtime.ts does
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const id of [tenantId, otherTenantId]) {
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
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
      await client.query("DELETE FROM tenants WHERE id = $1", [id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-9fhs edge order.* events are deferred, never stall the link", () => {
  it("a) order.paid followed by stock.moved: both apply, cursor advances, ledger row exists", async () => {
    const paid = orderEvent();
    const { event: moved, ledgerEntryId } = stockMoved();
    const link = store();
    const before = await link.lastReceivedInbound();

    // Before the fix this rejects with EdgeEventUnclassifiedError and the
    // whole batch rolls back (the stall).
    await deliver([paid, moved]);

    expect(await link.lastReceivedInbound()).toBe(before + 2);
    expect(await ledgerRows(ledgerEntryId)).toBe(1);
    expect(await deferredRows(paid.id)).toHaveLength(1);
  });

  it("registers every catalog order.* event under the order aggregate", () => {
    expect(orderEventNames).toContain("order.paid");
    expect(orderEventNames.length).toBeGreaterThan(1);
    expect(registeredEdgeEventClassifier(orderEvent())).toBe(
      "transaction_event",
    );
  });

  it("b) stores the order.paid envelope once, and a resend changes nothing", async () => {
    const paid = orderEvent();
    await deliver([paid]);
    const [row] = await deferredRows(paid.id);
    expect(row).toMatchObject({
      tenant_id: tenantId,
      outlet_id: outletA,
      edge_node_id: node.scope.edgeNodeId,
      aggregate_type: "order",
      event_name: "order.paid",
      parked_reason: "deferred",
    });
    expect(row!.event_id).toBe(ulidToUuid(paid.id));
    expect(row!.envelope).toMatchObject({
      id: paid.id,
      name: "order.paid",
      tenantId,
      outletId: outletA,
      aggregateType: "order",
      aggregateId: paid.aggregateId,
      sequence: 1,
      payload: paid.payload,
    });

    const outboxBefore = await cloudOutboxCount();
    const ledgerBefore = await ledgerCount();
    await deliver([paid]); // link re-delivery
    expect(await applyDirect(paid)).toBeNull(); // direct second apply: no-op
    expect(await deferredRows(paid.id)).toHaveLength(1);
    expect(await cloudOutboxCount()).toBe(outboxBefore);
    expect(await ledgerCount()).toBe(ledgerBefore);
  });

  it("b) every catalog order.* event is accepted and parked", async () => {
    for (const name of orderEventNames) {
      const event = orderEvent({ name });
      expect(await applyDirect(event), name).toBeNull();
      expect((await deferredRows(event.id)).map((r) => r.event_name)).toEqual([
        name,
      ]);
      expect(
        (await deferredRows(event.id)).map((r) => r.parked_reason),
        name,
      ).toEqual(["deferred"]);
    }
  });

  it("b) other POS (WS-04) events are parked too: cashier_shift.opened and day.closed", async () => {
    const shift = orderEvent({ name: "cashier_shift.opened" });
    const day = orderEvent({ name: "day.closed" });
    const { event: moved, ledgerEntryId } = stockMoved();
    const link = store();
    const before = await link.lastReceivedInbound();
    await deliver([shift, day, moved]);
    expect(await link.lastReceivedInbound()).toBe(before + 3);
    for (const event of [shift, day]) {
      const rows = await deferredRows(event.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_name: event.name,
        aggregate_type: event.aggregateType,
      });
      expect(await orderOutboxRows(event.id)).toBe(0);
    }
    expect(await ledgerRows(ledgerEntryId)).toBe(1);
  });

  it("c) an order event creates no cloud outbox row and no stock ledger row", async () => {
    const outboxBefore = await cloudOutboxCount();
    const ledgerBefore = await ledgerCount();
    const paid = orderEvent();
    await deliver([paid]);
    expect(await deferredRows(paid.id)).toHaveLength(1);
    expect(await orderOutboxRows(paid.id)).toBe(0);
    expect(await cloudOutboxCount()).toBe(outboxBefore);
    expect(await ledgerCount()).toBe(ledgerBefore);
  });

  it("d) an event of another tenant is refused with a 4xx and stores nothing", async () => {
    const foreign = orderEvent({
      tenantId: otherTenantId,
      outletId: otherTenantOutlet,
    });
    const status = await applyDirect(foreign);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    expect(await deferredRows(foreign.id)).toHaveLength(0);
  });

  it("d) an event of another outlet is refused with a 4xx, even for a tenant-wide context", async () => {
    const foreign = orderEvent({ outletId: outletB });
    const status = await applyDirect(foreign);
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
    const wide = await applyDirect(foreign, scopeOf(tenantId, "tenant"));
    expect(wide).toBeGreaterThanOrEqual(400);
    expect(wide).toBeLessThan(500);
    expect(await deferredRows(foreign.id)).toHaveLength(0);
  });

  it("d) through the link a wrong-outlet order event is refused before parking, and the next valid batch still applies", async () => {
    const foreign = orderEvent({ outletId: outletB });
    const link = store();
    const before = await link.lastReceivedInbound();
    await expect(deliver([foreign])).rejects.toThrow();
    expect(await deferredRows(foreign.id)).toHaveLength(0);
    expect(await link.lastReceivedInbound()).toBe(before);

    const paid = orderEvent();
    const { event: moved, ledgerEntryId } = stockMoved();
    await deliver([paid, moved]);
    expect(await link.lastReceivedInbound()).toBe(before + 2);
    expect(await deferredRows(paid.id)).toHaveLength(1);
    expect(await ledgerRows(ledgerEntryId)).toBe(1);
  });

  it("e) edge_deferred_events is isolated per tenant by RLS", async () => {
    const mine = orderEvent();
    await deliver([mine]);
    // A row of the other tenant: a copy of mine, written by the migration
    // owner with FK checks off (column types stay the table's own).
    const theirsId = createUlid(clock + 1);
    const seed = await owner.connect();
    try {
      await seed.query("BEGIN");
      await seed.query("SET LOCAL session_replication_role = replica");
      await seed.query(
        `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id, aggregate_sequence, event_name, parked_reason, envelope)
         SELECT $1::uuid, $2::uuid, edge_node_id, $3::uuid, aggregate_type, aggregate_id, aggregate_sequence, event_name, parked_reason, envelope
           FROM edge_deferred_events WHERE event_id = $4::uuid`,
        [
          otherTenantId,
          otherTenantOutlet,
          ulidToUuid(theirsId),
          ulidToUuid(mine.id),
        ],
      );
      await seed.query("COMMIT");
    } catch (error) {
      await seed.query("ROLLBACK");
      throw error;
    } finally {
      seed.release();
    }
    const theirs = { id: theirsId };

    const seen = async (context: ScopedTenantContext) =>
      withTenant(db, context, async (tx) => {
        const result = await tx.execute(
          sql`SELECT event_id, tenant_id FROM edge_deferred_events`,
        );
        return result.rows as { event_id: string; tenant_id: string }[];
      });

    const asA = await seen(scopeOf(tenantId, "tenant"));
    expect(asA.map((r) => r.event_id)).toContain(ulidToUuid(mine.id));
    expect(asA.map((r) => r.event_id)).not.toContain(ulidToUuid(theirs.id));
    expect(asA.every((r) => r.tenant_id === tenantId)).toBe(true);

    const asB = await seen(scopeOf(otherTenantId, "tenant"));
    expect(asB.map((r) => r.event_id)).not.toContain(ulidToUuid(mine.id));
    expect(asB.every((r) => r.tenant_id === otherTenantId)).toBe(true);

    // The app role cannot write a row for another tenant.
    await expect(
      withTenant(db, scopeOf(tenantId, "tenant"), (tx) =>
        tx.execute(sql`
          INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id, aggregate_sequence, event_name, parked_reason, envelope)
          SELECT ${otherTenantId}::uuid, ${otherTenantOutlet}::uuid, edge_node_id, ${ulidToUuid(createUlid(clock + 2))}::uuid, aggregate_type, aggregate_id, aggregate_sequence, event_name, parked_reason, envelope
            FROM edge_deferred_events WHERE event_id = ${ulidToUuid(mine.id)}::uuid`),
      ),
    ).rejects.toThrow();
  });

  // ---- Round 2: generic edge->cloud fallback --------------------------------
  const fallbackNames = ["table_session.opened", "zz_unknown.recorded"];

  for (const name of fallbackNames) {
    it(`r2) ${name} is parked as unclassified, the cursor advances and the next stock.moved applies`, async () => {
      const unknown = orderEvent({ name });
      const { event: moved, ledgerEntryId } = stockMoved();
      const link = store();
      const before = await link.lastReceivedInbound();
      const ledgerBefore = await ledgerCount();

      await deliver([unknown, moved]);

      expect(await link.lastReceivedInbound()).toBe(before + 2);
      const rows = await deferredRows(unknown.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: tenantId,
        outlet_id: outletA,
        edge_node_id: node.scope.edgeNodeId,
        aggregate_type: unknown.aggregateType,
        event_name: name,
        parked_reason: "unclassified",
      });
      expect(rows[0]!.envelope).toMatchObject({ id: unknown.id, name });
      expect(await ledgerRows(ledgerEntryId)).toBe(1);
      // Parking applies nothing: only the stock.moved ledger row is new, and
      // the parked event never reaches the cloud outbox (stock.moved's own
      // outbox row is expected, so the total is not compared).
      expect(await ledgerCount()).toBe(ledgerBefore + 1);
      expect(await orderOutboxRows(unknown.id)).toBe(0);
    });
  }

  it("r2) a resend of an unclassified event keeps one row and its reason", async () => {
    const unknown = orderEvent({ name: "table_session.opened" });
    await deliver([unknown]);
    const outboxBefore = await cloudOutboxCount();
    await deliver([unknown]);
    expect(await applyDirect(unknown)).toBeNull();
    const rows = await deferredRows(unknown.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parked_reason).toBe("unclassified");
    expect(await cloudOutboxCount()).toBe(outboxBefore);
  });

  it("r2) explicit WS-04 rows stay 'deferred' next to unclassified rows in one batch", async () => {
    const paid = orderEvent();
    const override = orderEvent({ name: "zz_unknown.recorded" });
    const link = store();
    const before = await link.lastReceivedInbound();
    await deliver([paid, override]);
    expect(await link.lastReceivedInbound()).toBe(before + 2);
    expect((await deferredRows(paid.id))[0]!.parked_reason).toBe("deferred");
    expect((await deferredRows(override.id))[0]!.parked_reason).toBe(
      "unclassified",
    );
  });

  it("r2) an explicit handler (stock.moved) still wins over the fallback", async () => {
    const { event: moved, ledgerEntryId } = stockMoved();
    await deliver([moved]);
    expect(await ledgerRows(ledgerEntryId)).toBe(1);
    expect(await deferredRows(moved.id)).toHaveLength(0);
  });

  // Handler-level only: through the link an outlet-less event is already
  // refused by the edge queue and by db-link-store's node-scope check.
  it("r2) fallback refusals are 4xx: other tenant, other outlet, no outlet", async () => {
    const name = "table_session.opened";
    const cases = {
      "other tenant": orderEvent({
        name,
        tenantId: otherTenantId,
        outletId: otherTenantOutlet,
      }),
      "other outlet": orderEvent({ name, outletId: outletB }),
      "no outlet": orderEvent({ name, outletId: null }),
    };
    for (const [label, event] of Object.entries(cases)) {
      const status = await applyDirect(event);
      expect(status, label).toBeGreaterThanOrEqual(400);
      expect(status, label).toBeLessThan(500);
      expect(await deferredRows(event.id), label).toHaveLength(0);
    }
  });

  it("r2) cloud_to_edge is unchanged: an unknown aggregate is never parked", async () => {
    const unknown = orderEvent({ name: "table_session.opened" });
    try {
      await withTenant(db, node.context, (tx) =>
        edgeEventApplier("cloud_to_edge").apply(tx, unknown, {
          ...meta(),
          direction: "cloud_to_edge",
        }),
      );
    } catch {
      // The legacy fallback may refuse it; only the absence of a parked row
      // is part of the contract here.
    }
    expect(await deferredRows(unknown.id)).toHaveLength(0);
    // The default kind is edge_to_cloud only; other directions stay fail closed.
    expect(registeredEdgeEventClassifier(unknown, "cloud_to_edge")).toBeNull();
    expect(registeredEdgeEventClassifier(unknown)).toBeNull();
    expect(registeredEdgeEventClassifier(unknown, "edge_to_cloud")).toBe(
      "transaction_event",
    );
  });
});
