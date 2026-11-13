// An edge->cloud POS order must never be re-emitted onto the cloud outbox
// (bead legend-078n, two guards). Recipe stock deduction already ran on the
// edge where order.paid was emitted, and its stock.moved already reached the
// cloud. The cloud worker feeds EVERY outbox event to
// deliverRecipeDeductionEvent, so a re-emitted order.paid would deduct twice.
//
//   Guard A (emit): while an edge->cloud handler runs, appendOutbox refuses an
//     `order` aggregate event and order_issue.recorded / day.closed.
//   Guard B (consume): deliverRecipeDeductionEvent is a no-op for an order that
//     was parked from an edge (row in edge_deferred_events).
//
// Written from the brief, not from the implementation.
//
// Assumptions (the brief does not pin them down):
// - "Refused" in guard A means the handler's appendOutbox call rejects, so the
//   dispatcher call rejects (message not pinned). Through the link, whether the
//   batch rolls back or becomes an applier_refused conflict is not pinned
//   either; the test accepts both and asserts the effects: no cloud outbox
//   row, no recipe_deductions row, and a later batch still applies.
// - A cloud-native order (no edge_deferred_events row) deducts exactly once and
//   a second delivery is idempotent (control for guard B).
// - Events outside the guarded set (cashier_shift.*) may still be appended by
//   an edge handler (guard A must not over-block), and the same order.paid
//   append outside an edge apply is allowed (cloud-native emit).
// - The link's parked-event aggregate id is the order's ULID (event.aggregateId)
//   and the cloud `orders.id` is ulidToUuid of it, as in recipe-deduction tests.
//   A legacy edge may park the UUID form instead; guard B must match both.
// - Guard B only suppresses for a parked `order.paid` (only an edge-paid order
//   was deducted on the edge). A parked non-paid event (order.refunded) must
//   not suppress a cloud-native order, and a cloud void still reverses a
//   cloud-made sale deduction. An edge-parked paid order's void/order issue
//   never writes a deduction, tombstone or stock movement.
// - The guard A refusal message is pinned to /while applying an edge event/.
// - A UUID-form parked aggregate id cannot go through the link (ulidToUuid is
//   not an RFC-valid UUID, so the envelope schema rejects it as aggregateId);
//   that test inserts the parked row directly into edge_deferred_events.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  inventoryEvents,
  orderIssueRecordedPayloadSchema,
} from "@starter/shared/inventory";
import {
  orderPaidPayloadSchema,
  orderRefundedPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeEventHandler,
  resetEdgeApplierRegistryForTests,
} from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { appendOutbox } from "../services/core-outbox.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const brandId = randomUUID();
const legalEntityId = randomUUID();
const outletA = randomUUID();
const slug = `nrx${randomUUID().slice(0, 8)}`;
const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();

let node: AuthenticatedEdgeNode;
let ownerUserId: string;
let gramId: string;
let mlId: string;
let portionId: string;
let categoryId: string;

const tenantWide = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );

const outletScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
  );

let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2033, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

async function one<T>(query: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(query, params);
  return rows[0]!.id;
}

async function countOf(query: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(query, params);
  return rows[0]!.n;
}

// ------------------------------------------------------------------ fixtures

async function createTenantRows() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantId,
      `tenant-${slug}`,
      `Tenant ${slug}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify(fixtures.tenant.limits),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandId, tenantId, `brand-${slug}`, `Brand ${slug}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityId, tenantId, `Entity ${slug}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      outletA,
      tenantId,
      brandId,
      legalEntityId,
      `N${slug.slice(3)}`.toUpperCase(),
      `Outlet ${slug}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
}

async function dropTenantRows() {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of rows)
      await client.query(`DELETE FROM "${table_name}" WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query('DELETE FROM "user" WHERE id = $1', [ownerUserId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertItem(name: string, baseUomId: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, baseUomId],
  );
}

async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(tenantWide(), {
    outletId: outletIdSchema.parse(outletA) as OutletId,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  } as never);
}

/**
 * A fresh stock location of outlet A with 1.000 g beans (Rp100/g) and 10.000 ml
 * milk (Rp20/ml), a Latte recipe (18 g beans + 200 ml milk), and the outlet's
 * real-time sale location pointed at it.
 */
async function buildKit() {
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantId, outletA, `Bar NoReemit ${short()}`],
  );
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(location, beans, "1000.0000", "100.0000");
  await receive(location, milk, "10000.0000", "20.0000");
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time',
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantId, outletA, location],
  );
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantId, brandId, `Resep ${short()}`, portionId, ownerUserId],
  );
  for (const [index, line] of [
    { id: beans, qty: "18.0000", uom: gramId },
    { id: milk, qty: "200.0000", uom: mlId },
  ].entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenantId, recipe, index, line.id, line.qty, line.uom],
    );
  const latte = await one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantId, brandId, categoryId, `Menu ${short()}`, recipe, randomUUID()],
  );
  return { location, beans, milk, latte };
}
type Kit = Awaited<ReturnType<typeof buildKit>>;

/** A paid order of `quantity` lattes as the cloud holds it (id = ulidToUuid). */
async function seedOrder(
  businessDate: string,
  menuItemId: string,
  quantity: number,
) {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0, 'completed', $5, now())`,
    [uuid, tenantId, outletA, `NRX-${randomUUID().slice(0, 12)}`, businessDate],
  );
  await owner.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
        quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
        fire_status, status, reserved_business_date)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Item', $6, 0, 0, 0, '[]'::jsonb, 'fired', 'served', $7)`,
    [randomUUID(), tenantId, outletA, uuid, menuItemId, quantity, businessDate],
  );
  return { ulid, uuid };
}

// -------------------------------------------------------------------- events

function envelope(input: {
  name: string;
  aggregateType: string;
  aggregateId: string;
  sequence?: number;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}): EventEnvelope {
  const id = createUlid();
  return eventEnvelopeSchema.parse({
    id,
    tenantId,
    outletId: outletA,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: input.sequence ?? 1,
    occurredAt: iso(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: input.idempotencyKey ?? `${input.name}:${id}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paidEvent(orderUlid: string, businessDate: string): EventEnvelope {
  return envelope({
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    payload: orderPaidPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
      businessDate,
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: 50000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: 50000,
      paidCashIdr: 50000,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: 50000 }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: iso(),
    }),
  });
}

/** A linked void of a completed sale (valid against orderVoidedPayloadSchema). */
function voidedEvent(orderUlid: string, businessDate: string): EventEnvelope {
  return envelope({
    name: "order.voided",
    aggregateType: "order",
    aggregateId: orderUlid,
    sequence: 2,
    payload: orderVoidedPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
      businessDate,
      amountIdr: 50000,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: ownerUserId,
      overrideId: null,
      approvalRequestId: null,
      voidedFinalOrder: true,
      voidId: randomUUID(),
      receiptNumber: "POS1-000001",
      voidedAt: iso(),
    }),
  });
}

/** A partial-free refund of the whole 50.000 cash sale. */
function refundedEvent(orderUlid: string, businessDate: string): EventEnvelope {
  return envelope({
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: orderUlid,
    payload: orderRefundedPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
      businessDate,
      refundId: randomUUID(),
      amountIdr: 50000,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: ownerUserId,
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: 50000,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      refundCashIdr: 50000,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "cash", amountIdr: 50000 }],
      refundedAt: iso(),
    }),
  });
}

/** A kitchen remake of one latte of the order. */
function issueEvent(
  orderUlid: string,
  businessDate: string,
  menuItemId: string,
): EventEnvelope {
  const issueId = randomUUID();
  return envelope({
    name: "order_issue.recorded",
    aggregateType: "order_issue",
    aggregateId: issueId,
    idempotencyKey: `order_issue.recorded:${issueId}`,
    payload: orderIssueRecordedPayloadSchema.parse({
      issueId,
      orderId: orderUlid,
      orderItemId: randomUUID(),
      outletId: outletA,
      businessDate,
      type: "remake",
      reason: "quality",
      stationId: null,
      recordedBy: ownerUserId,
      menuItemId,
      variantId: null,
      modifierIds: [],
      quantity: 1,
      occurredAt: iso(),
    }),
  });
}

/** An edge `stock.moved` as inventory.service.ts emits it (outlet A). */
function stockMoved(locationId: string, itemId: string) {
  const ledgerEntryId = createUlid();
  const occurredAt = iso();
  const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(),
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
      locationId,
      movementType: "sale",
      quantity: "-2.0000",
      unitCostIdr: "1234.5678",
      batchId: null,
      sourceType: "order",
      sourceId: createUlid(),
      occurredAt,
    },
  }) as EventEnvelope;
  return { event, ledgerEntryId };
}

// ------------------------------------------------------------------- the link

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

const meta = (): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context: node.context,
});

/** The registered edge->cloud dispatcher, directly (as the link calls it). */
function applyDirect(event: EventEnvelope) {
  return withTenant(db, node.context, (tx) =>
    edgeEventApplier("edge_to_cloud").apply(tx, event, meta()),
  );
}

/** As the cloud worker does: inside the consumption (tenant) transaction. */
function consume(event: EventEnvelope) {
  const context = tenantWide();
  return withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(context, event, tx),
  );
}

/**
 * A buggy applier: for each name, applying the event re-emits it onto the
 * cloud outbox, which is what guard A must refuse. Replaces the default
 * registry (the deferred applier owns order.* names).
 */
function registerReemittingApplier(names: string[], aggregateTypes: string[]) {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  for (const aggregateType of new Set(aggregateTypes))
    registerEdgeAggregateKind(aggregateType, "transaction_event");
  for (const name of names)
    registerEdgeEventHandler("edge_to_cloud", name, async (tx, event, m) => {
      await appendOutbox(tx as never, m.context, {
        id: createUlid(),
        event,
        destination: "reemit-test",
        direction: null,
        peerId: null,
      });
    });
}

// ------------------------------------------------------------------- readers

const cloudOutboxCount = () =>
  countOf(
    "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1",
    [tenantId],
  );
const outboxRowsOf = (eventId: string) =>
  countOf(
    "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'id' = $2",
    [tenantId, eventId],
  );
const deductionCount = () =>
  countOf(
    "SELECT count(*)::int AS n FROM recipe_deductions WHERE tenant_id = $1",
    [tenantId],
  );
const deductionsOfOrder = (order: { ulid: string; uuid: string }) =>
  countOf(
    `SELECT count(*)::int AS n FROM recipe_deductions
      WHERE tenant_id = $1 AND source_id = ANY($2::text[])`,
    [tenantId, [order.ulid, order.uuid]],
  );
/** [kind, status] of every recipe_deductions row of the order, oldest first. */
async function deductionStates(order: { ulid: string; uuid: string }) {
  const { rows } = await owner.query<{ kind: string; status: string }>(
    `SELECT kind, status FROM recipe_deductions
      WHERE tenant_id = $1 AND source_id = ANY($2::text[])
      ORDER BY created_at, id`,
    [tenantId, [order.ulid, order.uuid]],
  );
  return rows.map((row) => `${row.kind}:${row.status}`);
}
const parkedRows = (eventId: string) =>
  countOf(
    "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenantId, ulidToUuid(eventId)],
  );
const ledgerRowsOfLedgerEntry = (ledgerEntryId: string) =>
  countOf(
    "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, ulidToUuid(ledgerEntryId)],
  );

async function onHand(kit: Kit, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantId, kit.location, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

async function ledgerRowsAt(kit: Kit, itemId: string): Promise<number> {
  return countOf(
    `SELECT count(*)::int AS n FROM stock_ledger
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [tenantId, kit.location, itemId],
  );
}

/** [beans on hand, milk on hand, beans ledger rows, milk ledger rows]. */
async function stockOf(kit: Kit) {
  return [
    await onHand(kit, kit.beans),
    await onHand(kit, kit.milk),
    await ledgerRowsAt(kit, kit.beans),
    await ledgerRowsAt(kit, kit.milk),
  ];
}

// --------------------------------------------------------------------- setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createTenantRows();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "NoReemit Owner", `${ownerUserId}@example.com`],
  );
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantId, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  portionId = await uom("porsi");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'NoReemit Uji', 0)",
    [categoryId, tenantId, brandId],
  );
  const registered = await registerEdgeNode(outletScope(), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama NoReemit",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  await dropTenantRows();
  await owner.end();
});

// --------------------------------------------------------------------- tests

describe("legend-078n guard A: an edge->cloud applier cannot re-emit order events", () => {
  const guarded = [
    "order.paid",
    "order.voided",
    "order.refunded",
    "order_issue.recorded",
    "day.closed",
  ];

  for (const name of guarded)
    it(`refuses a handler's appendOutbox of ${name}; nothing lands on the cloud outbox or deducts`, async () => {
      registerReemittingApplier([name], [name.split(".")[0]!]);
      const kit = await buildKit();
      const order = await seedOrder(nextDate(), kit.latte, 2);
      const event =
        name === "order.paid"
          ? paidEvent(order.ulid, nextDate())
          : envelope({
              name,
              aggregateType: name.split(".")[0]!,
              aggregateId: order.ulid,
              payload: { orderId: order.ulid },
            });
      const outboxBefore = await cloudOutboxCount();
      const deductionsBefore = await deductionCount();
      const stockBefore = await stockOf(kit);

      await expect(applyDirect(event)).rejects.toThrow(
        /while applying an edge event/,
      );

      expect(await outboxRowsOf(event.id)).toBe(0);
      expect(await cloudOutboxCount()).toBe(outboxBefore);
      expect(await deductionCount()).toBe(deductionsBefore);
      expect(await stockOf(kit)).toEqual(stockBefore);
    });

  it("through the link: the re-emitting order.paid leaves no outbox row, no deduction, and the link is not stalled", async () => {
    registerReemittingApplier(["order.paid"], ["order"]);
    const kit = await buildKit();
    const order = await seedOrder(nextDate(), kit.latte, 2);
    const paid = paidEvent(order.ulid, nextDate());
    const outboxBefore = await cloudOutboxCount();
    const deductionsBefore = await deductionCount();
    const stockBefore = await stockOf(kit);

    // Rolled back (rejects) or recorded as an applier_refused conflict are both
    // acceptable (see assumptions); the effects below must hold either way.
    await deliver([paid]).catch(() => undefined);

    expect(await outboxRowsOf(paid.id)).toBe(0);
    expect(await cloudOutboxCount()).toBe(outboxBefore);
    expect(await deductionCount()).toBe(deductionsBefore);
    expect(await stockOf(kit)).toEqual(stockBefore);

    // Not stalled: a fresh valid event on the same link still applies.
    const { event: moved, ledgerEntryId } = stockMoved(kit.location, kit.beans);
    const link = store();
    const before = await link.lastReceivedInbound();
    await deliver([moved]);
    expect(await link.lastReceivedInbound()).toBe(before + 1);
    expect(await ledgerRowsOfLedgerEntry(ledgerEntryId)).toBe(1);
  });

  it("does not over-block: a handler may still append an event outside the guarded set", async () => {
    resetEdgeApplierRegistryForTests();
    registerStockMovedEdgeApplier();
    const eventName = "cashier_shift.opened";
    registerEdgeAggregateKind("cashier_shift", "transaction_event");
    registerEdgeEventHandler(
      "edge_to_cloud",
      eventName,
      async (tx, event, m) => {
        await appendOutbox(tx as never, m.context, {
          id: createUlid(),
          event,
          destination: "reemit-test",
          direction: null,
          peerId: null,
        });
      },
    );
    const event = envelope({
      name: eventName,
      aggregateType: "cashier_shift",
      aggregateId: createUlid(),
      payload: { shiftId: createUlid() },
    });
    await applyDirect(event);
    expect(await outboxRowsOf(event.id)).toBe(1);
  });

  it("does not break cloud-native emits: order.paid appended outside an edge apply still lands", async () => {
    const order = createUlid();
    const event = paidEvent(order, nextDate());
    await withTenant(db, tenantWide(), (tx) =>
      appendOutbox(tx, tenantWide(), {
        id: createUlid(),
        event,
        destination: "reemit-test",
        direction: null,
        peerId: null,
      }),
    );
    expect(await outboxRowsOf(event.id)).toBe(1);
  });
});

describe("legend-078n guard B: the recipe consumer skips an order parked from an edge", () => {
  it("a re-emitted order.paid for a parked order creates no deduction and no stock movement", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    const parked = paidEvent(order.ulid, businessDate);
    await deliver([parked]);
    expect(await parkedRows(parked.id)).toBe(1);
    const deductionsBefore = await deductionCount();
    const stockBefore = await stockOf(kit);

    // A buggy applier re-emitted the order: a second envelope, same order id.
    await consume(paidEvent(order.ulid, businessDate));

    expect(await deductionsOfOrder(order)).toBe(0);
    expect(await deductionCount()).toBe(deductionsBefore);
    expect(await stockOf(kit)).toEqual(stockBefore);
  });

  it("a parked order whose aggregate id is the UUID form (legacy edge) is matched for a ULID order.paid", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    // A legacy edge parked the UUID form of the order id: insert that row
    // directly, as applyEdgeDeferredEvent would have written it.
    const parked = paidEvent(order.ulid, businessDate);
    await owner.query(
      `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id, aggregate_sequence, event_name, parked_reason, envelope)
       VALUES ($1, $2, $3, $4::uuid, 'order', $5, 1, 'order.paid', 'deferred', $6::jsonb)`,
      [
        tenantId,
        outletA,
        node.scope.edgeNodeId,
        ulidToUuid(parked.id),
        order.uuid,
        JSON.stringify(parked),
      ],
    );
    expect(await parkedRows(parked.id)).toBe(1);
    const deductionsBefore = await deductionCount();
    const stockBefore = await stockOf(kit);

    await consume(paidEvent(order.ulid, businessDate));

    expect(await deductionsOfOrder(order)).toBe(0);
    expect(await deductionCount()).toBe(deductionsBefore);
    expect(await stockOf(kit)).toEqual(stockBefore);
  });

  it("a void of a parked (edge-paid) order writes no reversal, no tombstone and no stock movement", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    await deliver([paidEvent(order.ulid, businessDate)]);
    const deductionsBefore = await deductionCount();
    const stockBefore = await stockOf(kit);

    await consume(voidedEvent(order.ulid, businessDate));

    expect(await deductionStates(order)).toEqual([]);
    expect(await deductionCount()).toBe(deductionsBefore);
    expect(await stockOf(kit)).toEqual(stockBefore);
  });

  it("an order_issue.recorded of a parked order creates no deduction and no stock movement", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    await deliver([paidEvent(order.ulid, businessDate)]);
    const deductionsBefore = await deductionCount();
    const stockBefore = await stockOf(kit);

    await consume(issueEvent(order.ulid, businessDate, kit.latte));

    expect(await deductionCount()).toBe(deductionsBefore);
    expect(await stockOf(kit)).toEqual(stockBefore);
  });

  it("a parked non-paid edge event (order.refunded) does not suppress the cloud's own deduction: its final void still reverses it", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    const stockStart = await stockOf(kit);

    // Cloud-native sale deduction first, then an edge refund is parked.
    await consume(paidEvent(order.ulid, businessDate));
    expect(await deductionStates(order)).toEqual(["sale:posted"]);
    const refunded = refundedEvent(order.ulid, businessDate);
    await deliver([refunded]);
    expect(await parkedRows(refunded.id)).toBe(1);

    await consume(voidedEvent(order.ulid, businessDate));

    expect(await deductionStates(order)).toEqual(["sale:reversed"]);
    // Beans and milk are back on hand; the ledger holds the sale and its return.
    const [beans, milk, beanRows, milkRows] = await stockOf(kit);
    expect(beans).toBe(stockStart[0]);
    expect(milk).toBe(stockStart[1]);
    expect(beanRows).toBe(Number(stockStart[2]) + 2);
    expect(milkRows).toBe(Number(stockStart[3]) + 2);
  });

  it("failover: the cloud deducted order X, then an edge order.paid for X is parked; the cloud final void still reverses exactly once", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    const stockStart = await stockOf(kit);

    // The cloud order.paid is consumed BEFORE the park, so guard B does not
    // skip it: one sale deduction.
    await consume(paidEvent(order.ulid, businessDate));
    expect(await deductionStates(order)).toEqual(["sale:posted"]);
    const edgePaid = paidEvent(order.ulid, businessDate);
    await deliver([edgePaid]);
    expect(await parkedRows(edgePaid.id)).toBe(1);

    // The order is now parked, yet the cloud holds its own sale deduction: the
    // void must still reverse it (once).
    await consume(voidedEvent(order.ulid, businessDate));

    expect(await deductionStates(order)).toEqual(["sale:reversed"]);
    const [beans, milk, beanRows, milkRows] = await stockOf(kit);
    expect(beans).toBe(stockStart[0]);
    expect(milk).toBe(stockStart[1]);
    expect(beanRows).toBe(Number(stockStart[2]) + 2);
    expect(milkRows).toBe(Number(stockStart[3]) + 2);
  });
});

describe("legend-078n replay: edge orders never deduct on the cloud", () => {
  it("the same batch twice, and a void after the pay: one parked row per event, no outbox row, no deduction", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    const paid = paidEvent(order.ulid, businessDate);
    const voided = voidedEvent(order.ulid, businessDate);
    const outboxBefore = await cloudOutboxCount();
    const deductionsBefore = await deductionCount();
    const stockBefore = await stockOf(kit);

    await deliver([paid, voided]);
    await deliver([paid, voided]); // link replay of the identical batch

    for (const event of [paid, voided]) {
      expect(await parkedRows(event.id), event.name).toBe(1);
      expect(await outboxRowsOf(event.id), event.name).toBe(0);
    }
    expect(await cloudOutboxCount()).toBe(outboxBefore);
    expect(await deductionsOfOrder(order)).toBe(0);
    expect(await deductionCount()).toBe(deductionsBefore);
    expect(await stockOf(kit)).toEqual(stockBefore);

    // Even a (buggy) re-emitted order.paid stays a no-op after the replays.
    await consume(paidEvent(order.ulid, businessDate));
    expect(await deductionsOfOrder(order)).toBe(0);
    expect(await stockOf(kit)).toEqual(stockBefore);
  });
});

describe("legend-078n control: a cloud-native order still deducts once", () => {
  it("an order not parked from an edge deducts once; a second delivery is idempotent", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(businessDate, kit.latte, 2);
    const paid = paidEvent(order.ulid, businessDate);
    const [beansBefore, milkBefore, beanRowsBefore, milkRowsBefore] =
      await stockOf(kit);

    await consume(paid);

    expect(await deductionsOfOrder(order)).toBe(1);
    // 2 lattes x (18 g beans, 200 ml milk).
    expect(await stockOf(kit)).toEqual([
      String(Number(beansBefore) - 36) + ".0000",
      String(Number(milkBefore) - 400) + ".0000",
      Number(beanRowsBefore) + 1,
      Number(milkRowsBefore) + 1,
    ]);
    const afterFirst = await stockOf(kit);

    await consume(paid);

    expect(await deductionsOfOrder(order)).toBe(1);
    expect(await stockOf(kit)).toEqual(afterFirst);
  });
});
