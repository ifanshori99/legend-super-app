// legend-771dl: an `order.paid` / `order.voided` parked from an edge node becomes
// a cloud sales record (orders, order_items, pos_orders, pos_order_items,
// pos_order_tenders, pos_order_voids) through the real link receive path. Written
// from docs/design/edge-order-ingest.md (the contract), never from the code.
//
// Assumptions where the design is silent (also reported):
//  - a new `order.paid` payload carries `lines`, `subtotalIdr`, `orderNumber`,
//    `pricesIncludeTax`, `paymentMode`, `isTraining`, and per tender optional
//    `receivedIdr` / `pointsUsed`; `order.voided` carries `requestedBy`. They are
//    built as plain objects (the shared schema learns the keys in the same change).
//  - a void refusal reason may carry a prefix (`void_refused:<code>`); the code is the part after it.
//  - the refusal reason is read from `edge_order_ingests.reason` (text code); a
//    refused void of an already ingested order is asserted on `reason` and on the
//    absence of a void row, not on `state`.
//  - a payload whose lines do not add up to `subtotalIdr` passes the schema, is
//    parked and refused by the ingest as `lines_mismatch` (review fix).
//  - a gateway tender (card, va, ewallet, qris) is refused as `tender_unsupported`;
//    cash, points, edc_card and edc_qris are ingested.
//  - retry (review fix): a ledger row refused with the SAME event and reason
//    `db_error:*` or `lock_failed` is cleared and retried when the event is applied
//    again; any other row (other event, other reason) is a no-op. The retry is driven
//    through applyEdgeDeferredEvent directly, because the link itself never
//    redelivers an event it already recorded. `lock_failed` cannot be induced
//    deterministically from outside and is not tested.
//  - edge ids of lines are not sent; the cloud keeps every sent line (also a
//    voided one) and only non-void lines count towards `subtotalIdr`.
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
import { env } from "../config/env.ts";
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
import {
  seedFacility,
  seedTicketProduct,
} from "./facility-entitlement-helpers.ts";
import { owner as memberOwner } from "./member-loyalty-helpers.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const otherTenantId = randomUUID();
const brandId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const taxRuleId = randomUUID();
const shiftId = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const deviceId = randomUUID();
let node: AuthenticatedEdgeNode;

const scopeOf = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

/** Owner query under the tenant's RLS scope (rows of every outlet). */
async function q<T extends object>(
  text: string,
  params: unknown[] = [],
  tenant: string = tenantId,
): Promise<T[]> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    const result = await client.query<T>(text, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function n(
  text: string,
  params: unknown[] = [],
  tenant: string = tenantId,
): Promise<number> {
  const rows = await q<{ n: number }>(text, params, tenant);
  return rows[0]!.n;
}

async function createFixture() {
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Order Ingest', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `order-ingest-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Order Ingest Lain', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      otherTenantId,
      `order-ingest-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brandId, tenantId, `order-ingest-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  for (const [id, code] of [
    [outletA, "ING-01"],
    [outletB, "ING-02"],
  ] as const)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [id, tenantId, brandId, entity, code],
    );
  await q(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
     VALUES ($1, $2, $3, 'Ingest Uji', 0)`,
    [categoryId, tenantId, brandId],
  );
  await q(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
    [menuItemId, tenantId, brandId, categoryId, randomUUID()],
  );
  // legend-uctlr: the PBJT rule the payload `taxes` rows point at
  // (tax_snapshots has a foreign key to it).
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, 'PBJT-ING', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
    [taxRuleId, tenantId, actor],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Kasir Ingest', $2)`,
    [cashierId, `${cashierId}@example.test`],
  );
  // A cloud shift that shares the id an edge payload may carry (drawer test).
  await q(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, '2034-01-02', 'open', now(), 100000, $6, $7)`,
    [
      shiftId,
      tenantId,
      outletA,
      randomUUID(),
      cashierId,
      randomUUID(),
      "a".repeat(64),
    ],
  );
}

let clock = Date.parse("2026-11-14T09:00:00.000Z");
let numberSeq = 0;
const nextNumber = () => `ING-${String(++numberSeq).padStart(5, "0")}`;

type Where = { tenant?: string; outlet?: string };
type Payload = Record<string, unknown>;

function envelope(
  name: string,
  aggregateId: string,
  sequence: number,
  payload: Payload,
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
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  };
}

const BUSINESS_DATE = "2034-01-02";

function lines(): Payload[] {
  return [
    {
      menuItemId,
      name: "Kopi Susu",
      quantity: 2,
      unitPriceIdr: 25000,
      modifiersTotalIdr: 0,
      lineTotalIdr: 50000,
      fireStatus: "fired",
      reservedBusinessDate: BUSINESS_DATE,
      status: "served",
    },
    {
      menuItemId,
      name: "Roti Bakar",
      quantity: 1,
      unitPriceIdr: 20000,
      modifiersTotalIdr: 5000,
      lineTotalIdr: 25000,
      fireStatus: "fired",
      reservedBusinessDate: BUSINESS_DATE,
      status: "served",
    },
    // A voided line: kept as a row, never counted in the subtotal.
    {
      menuItemId,
      name: "Teh Manis",
      quantity: 1,
      unitPriceIdr: 10000,
      modifiersTotalIdr: 0,
      lineTotalIdr: 10000,
      fireStatus: "fired",
      reservedBusinessDate: BUSINESS_DATE,
      status: "voided",
    },
  ];
}

const PAID_AT = "2034-01-02T03:04:05.000Z";

/** The `taxes` row of a sale: all of it is PBJT at 10% on `base`. */
function taxRows(base: number, taxIdr: number, priceIncludesTax = false) {
  return [
    {
      taxRuleId,
      code: "PBJT-ING",
      version: 1,
      taxType: "pbjt",
      rateBp: 1000,
      priceIncludesTax,
      grossIdr: base,
      taxBaseIdr: base,
      serviceChargeIdr: 0,
      taxIdr,
    },
  ];
}

/**
 * A new-contract edge `order.paid` payload: subtotal 75000 (non-void lines),
 * discount 5000, tax 7000 on top, total 77000 = cash 50000 + EDC 20000 + points 7000.
 */
function paidPayload(orderId: string, over: Payload = {}): Payload {
  return {
    orderId,
    outletId: outletA,
    businessDate: BUSINESS_DATE,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: nextNumber(),
    subtotalIdr: 75000,
    pricesIncludeTax: false,
    paymentMode: "pay_first",
    isTraining: false,
    grossSalesIdr: 75000,
    discountIdr: 5000,
    serviceChargeIdr: 0,
    pbjtIdr: 7000,
    taxes: taxRows(70000, 7000),
    roundingIdr: 0,
    totalIdr: 77000,
    paidCashIdr: 50000,
    paidGatewayIdr: 0,
    paidEdcIdr: 20000,
    paidPointsIdr: 7000,
    paidDepositIdr: 0,
    tenders: [
      { method: "cash", amountIdr: 50000, receivedIdr: 100000 },
      { method: "edc_card", amountIdr: 20000 },
      { method: "points", amountIdr: 7000, pointsUsed: 70 },
    ],
    shiftId: null,
    cashierId,
    deviceId,
    paidAt: PAID_AT,
    lines: lines(),
    ...over,
  };
}

/** The same sale as an event parked before the contract change (no lines). */
function legacyPayload(orderId: string): Payload {
  const rest = paidPayload(orderId);
  for (const key of [
    "lines",
    "subtotalIdr",
    "orderNumber",
    "pricesIncludeTax",
    "paymentMode",
    "isTraining",
  ])
    delete rest[key];
  return {
    ...rest,
    tenders: [
      { method: "cash", amountIdr: 50000 },
      { method: "edc_card", amountIdr: 20000 },
      { method: "points", amountIdr: 7000 },
    ],
  };
}

/** Tax-inclusive sale: subtotal 111000 includes 10000 tax; gross = subtotal - tax. */
function taxInclusivePayload(orderId: string, businessDate = BUSINESS_DATE) {
  return paidPayload(orderId, {
    businessDate,
    subtotalIdr: 111000,
    pricesIncludeTax: true,
    grossSalesIdr: 101000,
    discountIdr: 0,
    serviceChargeIdr: 0,
    pbjtIdr: 10000,
    taxes: taxRows(101000, 10000, true),
    totalIdr: 111000,
    paidCashIdr: 111000,
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    tenders: [{ method: "cash", amountIdr: 111000, receivedIdr: 120000 }],
    lines: [
      {
        ...lines()[0],
        name: "Paket Hemat",
        quantity: 1,
        unitPriceIdr: 111000,
        lineTotalIdr: 111000,
        reservedBusinessDate: businessDate,
      },
    ],
  });
}

function paidEvent(
  orderId: string,
  over: Payload = {},
  opts: {
    where?: Where;
    aggregateId?: string;
    payload?: Payload;
    sequence?: number;
  } = {},
): EventEnvelope {
  return envelope(
    "order.paid",
    opts.aggregateId ?? orderId,
    opts.sequence ?? 1,
    opts.payload ?? paidPayload(orderId, over),
    opts.where,
  );
}

function voidedEvent(
  orderId: string,
  sequence: number,
  over: Payload = {},
): EventEnvelope {
  return envelope("order.voided", orderId, sequence, {
    orderId,
    outletId: outletA,
    businessDate: BUSINESS_DATE,
    amountIdr: 77000,
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    requestedBy: cashierId,
    approvedBy: supervisorId,
    overrideId: createUlid(++clock),
    approvalRequestId: null,
    voidedFinalOrder: true,
    voidId: randomUUID(),
    receiptNumber: "POS1-000042",
    voidedAt: "2034-01-02T04:00:00.000Z",
    ...over,
  });
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

const dbId = (orderId: string) => ulidToUuid(orderId);

type OrderRow = {
  number: string;
  channel: string;
  service_type: string;
  status: string;
  payment_mode: string;
  prices_include_tax: boolean;
  business_date: string;
  subtotal: number;
  discount: number;
  service: number;
  tax: number;
  rounding: number;
  total: number;
  deposit: number;
  placed_at: string;
  outlet_id: string;
};

async function orderRows(orderId: string, tenant = tenantId) {
  return q<OrderRow>(
    `SELECT number, channel, service_type, status, payment_mode, prices_include_tax,
            business_date::text AS business_date, subtotal_idr::int AS subtotal,
            discount_idr::int AS discount, service_charge_idr::int AS service,
            tax_idr::int AS tax, rounding_idr::int AS rounding, total_idr::int AS total,
            deposit_applied_idr::int AS deposit,
            to_char(placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS placed_at,
            outlet_id
       FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant, dbId(orderId)],
    tenant,
  );
}

async function cloudOrders(orderId: string) {
  return n(
    "SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, dbId(orderId)],
  );
}

type IngestRow = { state: string; reason: string | null; outlet_id: string };
async function ingestOf(orderId: string): Promise<IngestRow | undefined> {
  const rows = await q<IngestRow>(
    `SELECT state, reason, outlet_id FROM edge_order_ingests
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
  return rows[0];
}

async function ingestRowCount(orderId: string) {
  return n(
    `SELECT count(*)::int AS n FROM edge_order_ingests
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
}

/** Parked rows of one edge event (the parked row is never undone by ingest). */
async function parkedRowsOf(event: EventEnvelope, tenant = tenantId) {
  return n(
    `SELECT count(*)::int AS n FROM edge_deferred_events
      WHERE tenant_id = $1 AND event_name = $2 AND aggregate_id = $3`,
    [tenant, event.name, event.aggregateId],
    tenant,
  );
}

async function childCounts(orderId: string) {
  const id = dbId(orderId);
  return {
    items: await n(
      "SELECT count(*)::int AS n FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, id],
    ),
    posItems: await n(
      "SELECT count(*)::int AS n FROM pos_order_items WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, id],
    ),
    tenders: await n(
      "SELECT count(*)::int AS n FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, id],
    ),
    posOrders: await n(
      "SELECT count(*)::int AS n FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, id],
    ),
  };
}

const NOTHING = { items: 0, posItems: 0, tenders: 0, posOrders: 0 };

async function voidRows(orderId: string) {
  return q<{
    id: string;
    receipt_number: string;
    requested_by: string;
    approved_by: string;
    amount: number;
    voided_at: string;
    override_id: string | null;
  }>(
    `SELECT id::text AS id, receipt_number, requested_by, approved_by,
            amount_idr::int AS amount,
            to_char(voided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS voided_at,
            override_id::text AS override_id
       FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenantId, dbId(orderId)],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(scopeOf([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Order Ingest",
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
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    for (const table of [
      "pos_daily_closes",
      "edge_order_ingests",
      "pos_order_voids",
      "pos_order_tenders",
      "pos_order_items",
      "order_items",
      "order_events",
      "pos_orders",
      "orders",
      "pos_shifts",
      "facility_products",
      "facilities",
      "menu_items",
      "menu_categories",
      "edge_deferred_events",
      "domain_event_outbox",
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
    await client.query('DELETE FROM "user" WHERE id = $1', [cashierId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
    await memberOwner.end();
  }
});

describe("legend-771dl order.paid becomes a cloud order", () => {
  it("a paid edge order with lines creates one completed cloud order with the payload's exact figures", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId);
    const payload = event.payload as Payload;
    await deliver([event]);

    const rows = await orderRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: payload.orderNumber,
      status: "completed",
      payment_mode: "pay_first",
      prices_include_tax: false,
      business_date: BUSINESS_DATE,
      service_type: "takeaway",
      subtotal: 75000,
      discount: 5000,
      service: 0,
      tax: 7000,
      rounding: 0,
      total: 77000,
      deposit: 0,
      placed_at: PAID_AT,
      outlet_id: outletA,
    });

    // order_items + pos_order_items from lines, one tender row per tender.
    expect(await childCounts(orderId)).toEqual({
      items: 3,
      posItems: 3,
      tenders: 3,
      posOrders: 1,
    });
    const items = await q<{
      name: string;
      quantity: number;
      unit: number;
      mods: number;
      total: number;
      fire_status: string;
      status: string;
      reserved: string;
    }>(
      `SELECT name, quantity, unit_price_idr::int AS unit, modifiers_total_idr::int AS mods,
              line_total_idr::int AS total, fire_status, status,
              reserved_business_date::text AS reserved
         FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid ORDER BY name`,
      [tenantId, dbId(orderId)],
    );
    expect(items).toEqual([
      {
        name: "Kopi Susu",
        quantity: 2,
        unit: 25000,
        mods: 0,
        total: 50000,
        fire_status: "fired",
        status: "served",
        reserved: BUSINESS_DATE,
      },
      {
        name: "Roti Bakar",
        quantity: 1,
        unit: 20000,
        mods: 5000,
        total: 25000,
        fire_status: "fired",
        status: "served",
        reserved: BUSINESS_DATE,
      },
      {
        name: "Teh Manis",
        quantity: 1,
        unit: 10000,
        mods: 0,
        total: 10000,
        fire_status: "fired",
        status: "voided",
        reserved: BUSINESS_DATE,
      },
    ]);

    const tenders = await q<{
      method: string;
      amount: number;
      received: number | null;
      change: number | null;
      points: number | null;
      status: string;
      shift_id: string | null;
      resolved_at: string | null;
    }>(
      `SELECT method, amount_idr::int AS amount, received_idr::int AS received,
              change_idr::int AS change, points_used AS points, status, shift_id::text AS shift_id,
              to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at
         FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2::uuid ORDER BY method`,
      [tenantId, dbId(orderId)],
    );
    expect(tenders).toEqual([
      {
        method: "cash",
        amount: 50000,
        received: 100000,
        change: 50000,
        points: null,
        status: "captured",
        shift_id: null,
        resolved_at: PAID_AT,
      },
      {
        method: "edc_card",
        amount: 20000,
        received: null,
        change: null,
        points: null,
        status: "captured",
        shift_id: null,
        resolved_at: PAID_AT,
      },
      {
        method: "points",
        amount: 7000,
        received: null,
        change: null,
        points: 70,
        status: "captured",
        shift_id: null,
        resolved_at: PAID_AT,
      },
    ]);

    const pos = await q<{
      device_id: string | null;
      cashier_id: string | null;
      is_training: boolean;
      completed: boolean;
    }>(
      `SELECT device_id::text AS device_id, cashier_id, is_training,
              completed_at IS NOT NULL AS completed
         FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenantId, dbId(orderId)],
    );
    expect(pos).toEqual([
      {
        device_id: deviceId,
        cashier_id: cashierId,
        is_training: false,
        completed: true,
      },
    ]);

    expect(await ingestOf(orderId)).toMatchObject({
      state: "ingested",
      outlet_id: outletA,
    });
    // The parked event stays in place next to the cloud order.
    expect(await parkedRowsOf(event)).toBe(1);
  });

  it("the UUID form of the order id is the same order as the ULID form", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, {}, { aggregateId: dbId(orderId) });
    await deliver([event]);

    expect(await cloudOrders(orderId)).toBe(1);
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
    // Replay under the ULID form is still the same order: no second row.
    await deliver([event]);
    expect(await cloudOrders(orderId)).toBe(1);
    expect(await ingestRowCount(orderId)).toBe(1);
  });

  it("a tax-inclusive sale keeps the subtotal the guest saw (gross is not the subtotal)", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      paidEvent(orderId, {}, { payload: taxInclusivePayload(orderId) }),
    ]);

    const rows = await orderRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "completed",
      prices_include_tax: true,
      subtotal: 111000,
      tax: 10000,
      total: 111000,
    });
    expect((await childCounts(orderId)).tenders).toBe(1);
  });

  it("a reservation deposit is stored as deposit applied and the tenders settle the rest", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      paidEvent(orderId, {
        paidDepositIdr: 10000,
        paidEdcIdr: 10000,
        tenders: [
          { method: "cash", amountIdr: 50000, receivedIdr: 50000 },
          { method: "edc_card", amountIdr: 10000 },
          { method: "points", amountIdr: 7000, pointsUsed: 70 },
        ],
      }),
    ]);

    const rows = await orderRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ total: 77000, deposit: 10000 });
    const sum = await n(
      "SELECT sum(amount_idr)::int AS n FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, dbId(orderId)],
    );
    expect(sum + rows[0]!.deposit).toBe(rows[0]!.total);
  });

  it("a training sale is stored and stamped as training, not refused", async () => {
    const orderId = createUlid(++clock);
    await deliver([paidEvent(orderId, { isTraining: true })]);

    expect(await cloudOrders(orderId)).toBe(1);
    const pos = await q<{ is_training: boolean }>(
      "SELECT is_training FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, dbId(orderId)],
    );
    expect(pos).toEqual([{ is_training: true }]);
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
  });

  it("replaying the same event, in the same batch or later batches, adds no rows", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId);
    await deliver([event, event]);
    const first = await childCounts(orderId);
    expect(first).toEqual({ items: 3, posItems: 3, tenders: 3, posOrders: 1 });

    await deliver([event]);
    await deliver([event, event]);

    expect(await cloudOrders(orderId)).toBe(1);
    expect(await childCounts(orderId)).toEqual(first);
    expect(await ingestRowCount(orderId)).toBe(1);
    expect(await parkedRowsOf(event)).toBe(1);
  });
});

describe("legend-771dl cloud sales equal the edge totals", () => {
  it("the cloud sum of completed sales of a mixed set equals the payload totals, nothing is computed", async () => {
    const date = "2034-03-01";
    const orders = [
      { id: createUlid(++clock), payload: undefined as Payload | undefined },
      { id: createUlid(++clock), payload: undefined as Payload | undefined },
      { id: createUlid(++clock), payload: undefined as Payload | undefined },
    ];
    const events = [
      paidEvent(orders[0]!.id, {
        businessDate: date,
        lines: lines().map((line) => ({ ...line, reservedBusinessDate: date })),
      }),
      paidEvent(
        orders[1]!.id,
        {},
        { payload: taxInclusivePayload(orders[1]!.id, date) },
      ),
      paidEvent(orders[2]!.id, {
        businessDate: date,
        isTraining: true,
        lines: lines().map((line) => ({ ...line, reservedBusinessDate: date })),
      }),
    ];
    await deliver(events);
    // One more batch of replays must not change a sum.
    await deliver(events);

    const expected = (training: boolean) =>
      events
        .filter((event) => (event.payload as Payload).isTraining === training)
        .reduce(
          (sum, event) => sum + Number((event.payload as Payload).totalIdr),
          0,
        );
    const cloud = async (training: boolean) =>
      n(
        `SELECT coalesce(sum(o.total_idr), 0)::int AS n
           FROM orders o JOIN pos_orders p ON p.tenant_id = o.tenant_id AND p.order_id = o.id
          WHERE o.tenant_id = $1 AND o.status = 'completed' AND o.business_date = $2
            AND p.is_training = $3`,
        [tenantId, date, training],
      );
    expect(await cloud(false)).toBe(expected(false));
    expect(await cloud(true)).toBe(expected(true));
    expect(expected(false)).toBe(77000 + 111000);

    // Tender money adds up to the same sales.
    const tendered = await n(
      `SELECT coalesce(sum(t.amount_idr), 0)::int AS n
         FROM pos_order_tenders t JOIN orders o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
        WHERE o.tenant_id = $1 AND o.business_date = $2`,
      [tenantId, date],
    );
    expect(tendered).toBe(expected(false) + expected(true));
  });
});

describe("legend-771dl refusals keep the parked event and never stall the link", () => {
  it("a legacy payload (no lines, no subtotal) is parked, creates no cloud order and does not throw", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, {}, { payload: legacyPayload(orderId) });

    await deliver([event]);

    expect(await parkedRowsOf(event)).toBe(1);
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "legacy_payload",
    });
  });

  it("an event whose aggregate id is another order creates no order and writes no ledger row (only parked)", async () => {
    const orderId = createUlid(++clock);
    const otherId = createUlid(++clock);
    const ledgerBefore = await n(
      "SELECT count(*)::int AS n FROM edge_order_ingests WHERE tenant_id = $1",
      [tenantId],
    );
    const event = paidEvent(orderId, {}, { aggregateId: otherId });

    await deliver([event]);

    expect(await parkedRowsOf(event)).toBe(1);
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await cloudOrders(otherId)).toBe(0);
    // legend-771dl review: a mismatch is only logged, never recorded, so it
    // cannot occupy the ledger slot of either order.
    expect(await ingestOf(orderId)).toBeUndefined();
    expect(await ingestOf(otherId)).toBeUndefined();
    expect(
      await n(
        "SELECT count(*)::int AS n FROM edge_order_ingests WHERE tenant_id = $1",
        [tenantId],
      ),
    ).toBe(ledgerBefore);
  });

  it("a mismatched event does not poison the ledger: a valid paid event for either order is still ingested", async () => {
    const orderId = createUlid(++clock);
    const otherId = createUlid(++clock);
    await deliver([paidEvent(orderId, {}, { aggregateId: otherId })]);

    const forOrder = paidEvent(orderId);
    // The aggregate `otherId` already carries sequence 1 (the mismatched event).
    const forOther = paidEvent(otherId, {}, { sequence: 2 });
    await deliver([forOrder, forOther]);

    expect(await cloudOrders(orderId)).toBe(1);
    expect(await cloudOrders(otherId)).toBe(1);
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
    expect(await ingestOf(otherId)).toMatchObject({ state: "ingested" });
  });

  it("lines that do not add up to the subtotal are parked and refused as lines_mismatch", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, {
      subtotalIdr: 76000,
      grossSalesIdr: 76000,
      totalIdr: 78000,
      paidCashIdr: 51000,
      tenders: [
        { method: "cash", amountIdr: 51000, receivedIdr: 100000 },
        { method: "edc_card", amountIdr: 20000 },
        { method: "points", amountIdr: 7000, pointsUsed: 70 },
      ],
    });

    // The schema no longer checks the line sum: the event is accepted and
    // parked, and the ingest refuses it (no "either way" any more).
    await deliver([event]);

    expect(await parkedRowsOf(event)).toBe(1);
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "lines_mismatch",
    });
  });

  it("1269 F0: a sale of a closed shower's menu item stays parked (shower_closed), a voided line or an open shower does not", async () => {
    const showerItem = randomUUID();
    await q(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Tiket Shower', true, $5)`,
      [showerItem, tenantId, brandId, categoryId, randomUUID()],
    );
    await seedTicketProduct(tenantId, {
      facilityId: await seedFacility({ tenantId, outletA }),
      outletId: outletA,
      menuItemId: showerItem,
    });
    const flag = env as unknown as { FACILITY_SHOWER_ENABLED?: boolean };
    const was = flag.FACILITY_SHOWER_ENABLED;
    const [first, second, voided] = lines();
    const sold = createUlid(++clock);
    const voidedOnly = createUlid(++clock);
    const opened = createUlid(++clock);
    const soldLines = [first, { ...second, menuItemId: showerItem }, voided];
    const event = paidEvent(sold, { lines: soldLines });
    try {
      flag.FACILITY_SHOWER_ENABLED = false;
      await deliver([
        event,
        paidEvent(voidedOnly, {
          lines: [first, second, { ...voided, menuItemId: showerItem }],
        }),
      ]);
      flag.FACILITY_SHOWER_ENABLED = true;
      await deliver([paidEvent(opened, { lines: soldLines })]);
    } finally {
      flag.FACILITY_SHOWER_ENABLED = was;
    }
    expect(await parkedRowsOf(event)).toBe(1);
    expect(await cloudOrders(sold)).toBe(0);
    expect(await childCounts(sold)).toEqual(NOTHING);
    expect(await ingestOf(sold)).toMatchObject({
      state: "refused",
      reason: "shower_closed",
    });
    expect(await cloudOrders(voidedOnly)).toBe(1);
    expect(await cloudOrders(opened)).toBe(1);
  });

  it("an order that already exists in the cloud is left as it is and refused as order_exists", async () => {
    const orderId = createUlid(++clock);
    await q(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
                           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
                           total_idr, status, business_date, placed_at)
       VALUES ($1::uuid, $2, $3, 'EXIST-0001', 'qr', 'takeaway', 'pay_first',
               1000, 0, 0, 0, 0, 1000, 'completed', $4, now())`,
      [dbId(orderId), tenantId, outletA, BUSINESS_DATE],
    );
    const event = paidEvent(orderId);

    await deliver([event]);

    const rows = await orderRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: "EXIST-0001", total: 1000 });
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await parkedRowsOf(event)).toBe(1);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "order_exists",
    });
  });

  it("a QR-channel order paid on the edge is refused as channel_unsupported", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, { channel: "qr" });

    await deliver([event]);

    expect(await cloudOrders(orderId)).toBe(0);
    expect(await parkedRowsOf(event)).toBe(1);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "channel_unsupported",
    });
  });

  it("a database error while writing (duplicate order number) is recorded as db_error and the rest of the batch still applies", async () => {
    const clashing = "CLASH-0001";
    await q(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
                           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
                           total_idr, status, business_date, placed_at)
       VALUES ($1::uuid, $2, $3, $4, 'qr', 'takeaway', 'pay_first',
               1000, 0, 0, 0, 0, 1000, 'completed', $5, now())`,
      [randomUUID(), tenantId, outletA, clashing, BUSINESS_DATE],
    );
    const bad = createUlid(++clock);
    const good = createUlid(++clock);
    const badEvent = paidEvent(bad, { orderNumber: clashing });
    const goodEvent = paidEvent(good);

    await deliver([badEvent, goodEvent]);

    expect(await parkedRowsOf(badEvent)).toBe(1);
    expect(await parkedRowsOf(goodEvent)).toBe(1);
    expect(await cloudOrders(bad)).toBe(0);
    expect(await childCounts(bad)).toEqual(NOTHING);
    const refused = await ingestOf(bad);
    expect(refused?.state).toBe("refused");
    expect(refused?.reason).toMatch(/^db_error:/);
    expect(await cloudOrders(good)).toBe(1);
    expect(await ingestOf(good)).toMatchObject({ state: "ingested" });
  });

  it("a line whose menu item the cloud does not know is refused, not thrown, and parks the event", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, {
      lines: lines().map((line) => ({ ...line, menuItemId: randomUUID() })),
    });

    await deliver([event]);

    expect(await parkedRowsOf(event)).toBe(1);
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await ingestOf(orderId)).toMatchObject({ state: "refused" });
  });
});

describe("legend-771dl order.voided", () => {
  async function paidOrder() {
    const orderId = createUlid(++clock);
    await deliver([paidEvent(orderId)]);
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
    return orderId;
  }

  it("a void of an ingested sale writes exactly one void record; a replay is a no-op", async () => {
    const orderId = await paidOrder();
    const voidId = randomUUID();
    const overrideId = createUlid(++clock);
    const event = voidedEvent(orderId, 2, { voidId, overrideId });

    await deliver([event]);
    await deliver([event]);
    await deliver([event, event]);

    const rows = await voidRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: voidId,
      receipt_number: "POS1-000042",
      requested_by: cashierId,
      approved_by: supervisorId,
      amount: 77000,
      voided_at: "2034-01-02T04:00:00.000Z",
      override_id: ulidToUuid(overrideId),
    });
    expect(await ingestOf(orderId)).toMatchObject({ state: "voided" });
    // The cloud sale itself is not rewritten: it stays a completed order.
    expect((await orderRows(orderId))[0]).toMatchObject({
      status: "completed",
      total: 77000,
    });
    expect(await parkedRowsOf(event)).toBe(1);
  });

  it("a void whose amount differs from the order total is refused and writes nothing", async () => {
    const orderId = await paidOrder();
    const event = voidedEvent(orderId, 2, { amountIdr: 50000 });

    await deliver([event]);

    expect(await voidRows(orderId)).toHaveLength(0);
    expect(await ingestOf(orderId)).toMatchObject({
      reason: expect.stringMatching(/(^|:)void_amount_mismatch$/),
    });
    expect(await parkedRowsOf(event)).toBe(1);
    expect((await orderRows(orderId))[0]).toMatchObject({
      status: "completed",
    });
  });

  it("a void of a sale funded partly by a reservation deposit is refused and writes nothing", async () => {
    // legend-j772n review P3: the void row would reverse the whole total while
    // the DP part is not a tender; a full gateway refund could pay it twice.
    const orderId = createUlid(++clock);
    await deliver([
      paidEvent(orderId, {
        paidDepositIdr: 10000,
        paidEdcIdr: 10000,
        tenders: [
          { method: "cash", amountIdr: 50000, receivedIdr: 50000 },
          { method: "edc_card", amountIdr: 10000 },
          { method: "points", amountIdr: 7000, pointsUsed: 70 },
        ],
      }),
    ]);
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
    const event = voidedEvent(orderId, 2, {
      voidId: randomUUID(),
      overrideId: createUlid(++clock),
    });

    await deliver([event]);

    expect(await voidRows(orderId)).toHaveLength(0);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "ingested",
      reason: expect.stringMatching(/(^|:)void_deposit_applied$/),
    });
    expect(await parkedRowsOf(event)).toBe(1);
    expect((await orderRows(orderId))[0]).toMatchObject({
      status: "completed",
    });
  });

  it("a void without an approver is refused as void_actor_missing", async () => {
    const orderId = await paidOrder();
    const event = voidedEvent(orderId, 2, {
      approvedBy: null,
      overrideId: null,
      approvalRequestId: null,
    });

    await deliver([event]);

    expect(await voidRows(orderId)).toHaveLength(0);
    expect(await ingestOf(orderId)).toMatchObject({
      reason: expect.stringMatching(/(^|:)void_actor_missing$/),
    });
    expect(await parkedRowsOf(event)).toBe(1);
  });

  it("a second, different void of the same sale is refused as already_voided", async () => {
    const orderId = await paidOrder();
    const firstVoid = randomUUID();
    await deliver([voidedEvent(orderId, 2, { voidId: firstVoid })]);

    const second = voidedEvent(orderId, 3, { voidId: randomUUID() });
    await deliver([second]);

    const rows = await voidRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(firstVoid);
    expect(await ingestOf(orderId)).toMatchObject({
      reason: expect.stringMatching(/(^|:)already_voided$/),
    });
    // both voids of the aggregate stay parked (first and second)
    expect(await parkedRowsOf(second)).toBe(2);
  });

  it("a void of an order that was never paid (not final) is recorded as cancelled and creates nothing", async () => {
    const orderId = createUlid(++clock);
    const event = voidedEvent(orderId, 1, {
      voidedFinalOrder: false,
      voidId: null,
      receiptNumber: null,
      amountIdr: 0,
      approvedBy: null,
      overrideId: null,
      approvalRequestId: null,
    });

    await deliver([event]);

    expect(await ingestOf(orderId)).toMatchObject({ state: "cancelled" });
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await voidRows(orderId)).toHaveLength(0);
    expect(await parkedRowsOf(event)).toBe(1);
  });

  it("a final void of an order the cloud never ingested is refused and creates no order or void", async () => {
    const orderId = createUlid(++clock);
    const event = voidedEvent(orderId, 1);

    await deliver([event]).catch(() => undefined);

    expect(await cloudOrders(orderId)).toBe(0);
    expect(await voidRows(orderId)).toHaveLength(0);
    const row = await ingestOf(orderId);
    expect(row?.state).not.toBe("voided");
    expect(row?.state).not.toBe("ingested");
  });

  it("a void of a refused (legacy) sale writes no void record", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      paidEvent(orderId, {}, { payload: legacyPayload(orderId) }),
    ]);
    const event = voidedEvent(orderId, 2);

    await deliver([event]);

    expect(await voidRows(orderId)).toHaveLength(0);
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await parkedRowsOf(event)).toBe(1);
  });
});

describe("legend-771dl isolation", () => {
  it("an event stamped for another outlet or tenant creates no order and leaves the node's orders alone", async () => {
    const own = createUlid(++clock);
    await deliver([paidEvent(own)]);
    const ownBefore = await orderRows(own);

    const otherOutlet = createUlid(++clock);
    const otherTenant = createUlid(++clock);
    await deliver([
      paidEvent(
        otherOutlet,
        { outletId: outletB },
        { where: { outlet: outletB } },
      ),
    ]).catch(() => undefined);
    await deliver([
      paidEvent(otherTenant, {}, { where: { tenant: otherTenantId } }),
    ]).catch(() => undefined);

    expect(await cloudOrders(otherOutlet)).toBe(0);
    expect(await orderRows(otherTenant, otherTenantId)).toHaveLength(0);
    expect(await cloudOrders(otherTenant)).toBe(0);
    expect(
      await n(
        "SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1",
        [otherTenantId],
        otherTenantId,
      ),
    ).toBe(0);
    expect(await orderRows(own)).toEqual(ownBefore);
    expect(await cloudOrders(own)).toBe(1);
  });
});

describe("legend-771dl no side effects of a cloud sale", () => {
  const counts = async () => ({
    outbox: await n(
      "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1",
      [tenantId],
    ),
    ledger: await n(
      "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1",
      [tenantId],
    ),
    deductions: await n(
      "SELECT count(*)::int AS n FROM recipe_deductions WHERE tenant_id = $1",
      [tenantId],
    ),
    journals: await n(
      "SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1",
      [tenantId],
    ),
    receipts: await n(
      "SELECT count(*)::int AS n FROM pos_receipts WHERE tenant_id = $1",
      [tenantId],
    ),
    shifts: await n(
      "SELECT count(*)::int AS n FROM pos_shifts WHERE tenant_id = $1",
      [tenantId],
    ),
  });

  it("ingesting a sale and its void writes no outbox, stock, journal, receipt or shift row", async () => {
    const before = await counts();
    const orderId = createUlid(++clock);
    await deliver([paidEvent(orderId), voidedEvent(orderId, 2)]);
    expect(await cloudOrders(orderId)).toBe(1);
    expect(await voidRows(orderId)).toHaveLength(1);

    expect(await counts()).toEqual(before);
  });

  it("a cash tender gets no drawer even when a cloud shift with the payload's shift id exists", async () => {
    const shiftBefore = await q<{ cash_sales: number }>(
      "SELECT cash_sales_idr::int AS cash_sales FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
      [tenantId, shiftId],
    );
    expect(shiftBefore).toHaveLength(1);
    const orderId = createUlid(++clock);

    await deliver([paidEvent(orderId, { shiftId })]);

    expect(await cloudOrders(orderId)).toBe(1);
    const tenders = await q<{ shift_id: string | null }>(
      "SELECT shift_id::text AS shift_id FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, dbId(orderId)],
    );
    expect(tenders).toHaveLength(3);
    for (const tender of tenders) expect(tender.shift_id).toBeNull();
    // The shift id stays as a plain value on the order; the drawer is untouched.
    const pos = await q<{ shift_id: string | null }>(
      "SELECT shift_id::text AS shift_id FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, dbId(orderId)],
    );
    expect(pos).toEqual([{ shift_id: shiftId }]);
    const shiftAfter = await q<{ cash_sales: number }>(
      "SELECT cash_sales_idr::int AS cash_sales FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
      [tenantId, shiftId],
    );
    expect(shiftAfter).toEqual(shiftBefore);
  });
});

describe("legend-771dl gateway tenders are refused", () => {
  const gateway = (method: string): Payload => ({
    paidCashIdr: 0,
    paidGatewayIdr: 77000,
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    tenders: [{ method, amountIdr: 77000 }],
  });

  for (const method of ["qris", "card", "va", "ewallet"])
    it(`a ${method} tender is refused as tender_unsupported and creates no order`, async () => {
      const orderId = createUlid(++clock);
      const event = paidEvent(orderId, gateway(method));

      await deliver([event]);

      expect(await parkedRowsOf(event)).toBe(1);
      expect(await cloudOrders(orderId)).toBe(0);
      expect(await childCounts(orderId)).toEqual(NOTHING);
      expect(await ingestOf(orderId)).toMatchObject({
        state: "refused",
        reason: "tender_unsupported",
      });
    });

  it("an edc_qris tender (an EDC machine, not a gateway) is ingested", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      paidEvent(orderId, {
        paidCashIdr: 0,
        paidEdcIdr: 77000,
        paidPointsIdr: 0,
        tenders: [{ method: "edc_qris", amountIdr: 77000 }],
      }),
    ]);

    expect(await cloudOrders(orderId)).toBe(1);
    expect(await ingestOf(orderId)).toMatchObject({ state: "ingested" });
    const methods = await q<{ method: string }>(
      "SELECT method FROM pos_order_tenders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenantId, dbId(orderId)],
    );
    expect(methods).toEqual([{ method: "edc_qris" }]);
  });

  it("one gateway tender among cash tenders refuses the whole order", async () => {
    const orderId = createUlid(++clock);
    await deliver([
      paidEvent(orderId, {
        paidCashIdr: 50000,
        paidGatewayIdr: 27000,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
        tenders: [
          { method: "cash", amountIdr: 50000, receivedIdr: 50000 },
          { method: "qris", amountIdr: 27000 },
        ],
      }),
    ]);

    expect(await cloudOrders(orderId)).toBe(0);
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "tender_unsupported",
    });
  });
});

describe("legend-771dl a refused ingest is retried only for the same event and a retryable reason", () => {
  /**
   * The edge resends an event the cloud already holds (e.g. its ack was lost and
   * the cloud's receipt rows were cleared): drop the cloud's receipt of it, then
   * deliver it again. The parked row stays, so the hook sees a replay.
   */
  async function redeliver(event: EventEnvelope) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      for (const table of [
        "edge_link_slots",
        "edge_inbound_events",
        "edge_received_events",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND event_id = $2::uuid`,
          [tenantId, ulidToUuid(event.id)],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await deliver([event]);
  }

  const ledgerEvent = async (orderId: string) =>
    (
      await q<{ paid: string }>(
        `SELECT paid_event_id::text AS paid FROM edge_order_ingests
          WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [tenantId, dbId(orderId)],
      )
    )[0]?.paid;

  it("a db_error:23505 refusal is final (legend-132mw): a replay of the same event does not retry it", async () => {
    const clashing = "RETRY-0001";
    const clashId = randomUUID();
    // 'sent' (not final) so the number can be changed afterwards.
    await q(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
                           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
                           total_idr, status, business_date, placed_at)
       VALUES ($1::uuid, $2, $3, $4, 'qr', 'takeaway', 'pay_first',
               1000, 0, 0, 0, 0, 1000, 'sent', $5, now())`,
      [clashId, tenantId, outletA, clashing, BUSINESS_DATE],
    );
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, { orderNumber: clashing });

    await deliver([event]);
    expect((await ingestOf(orderId))?.reason).toBe("db_error:23505");
    expect(await cloudOrders(orderId)).toBe(0);

    await q(
      "UPDATE orders SET number = 'RETRY-MOVED' WHERE tenant_id = $1 AND id = $2::uuid",
      [tenantId, clashId],
    );
    await redeliver(event);

    // The transient set is lock_failed and 40P01/55P03/40001 only; the
    // redrive sweep is covered by edge-order-redrive.test.ts.
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "db_error:23505",
    });
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await childCounts(orderId)).toEqual(NOTHING);
    expect(await ingestRowCount(orderId)).toBe(1);
    expect(await parkedRowsOf(event)).toBe(1);
  });

  it("a non-retryable refusal (legacy_payload) stays refused on replay of the same event", async () => {
    const orderId = createUlid(++clock);
    const event = paidEvent(orderId, {}, { payload: legacyPayload(orderId) });

    await deliver([event]);
    await redeliver(event);

    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "legacy_payload",
    });
    expect(await cloudOrders(orderId)).toBe(0);
    expect(await ingestRowCount(orderId)).toBe(1);
  });

  it("a different event for an already refused order is a no-op: the first event keeps the ledger row", async () => {
    const orderId = createUlid(++clock);
    const first = paidEvent(orderId, {}, { payload: legacyPayload(orderId) });
    await deliver([first]);
    const keptEvent = await ledgerEvent(orderId);
    expect(keptEvent).toBe(ulidToUuid(first.id));

    // A well-formed event with another id for the same order (next sequence).
    await deliver([paidEvent(orderId, {}, { sequence: 2 })]);

    expect(await cloudOrders(orderId)).toBe(0);
    expect(await ingestOf(orderId)).toMatchObject({
      state: "refused",
      reason: "legacy_payload",
    });
    expect(await ledgerEvent(orderId)).toBe(keptEvent);
  });

  it("a different event for an ingested order is a no-op: no second order or ledger change", async () => {
    const orderId = createUlid(++clock);
    const first = paidEvent(orderId);
    await deliver([first]);
    expect(await cloudOrders(orderId)).toBe(1);

    await deliver([paidEvent(orderId, {}, { sequence: 2 })]);

    expect(await cloudOrders(orderId)).toBe(1);
    expect(await ledgerEvent(orderId)).toBe(ulidToUuid(first.id));
    expect(await ingestRowCount(orderId)).toBe(1);
  });
});

describe("legend-771dl an ingested order has no payment ledger rows", () => {
  it("no payment intent or link exists for an ingested order, so refund recovery and late-payment paths have nothing to touch", async () => {
    const orderId = createUlid(++clock);
    await deliver([paidEvent(orderId)]);
    expect(await cloudOrders(orderId)).toBe(1);

    expect(
      await n(
        "SELECT count(*)::int AS n FROM payment_intents WHERE tenant_id = $1 AND order_id = $2::uuid",
        [tenantId, dbId(orderId)],
      ),
    ).toBe(0);
    expect(
      await n(
        "SELECT count(*)::int AS n FROM payment_links WHERE tenant_id = $1",
        [tenantId],
      ),
    ).toBe(0);
    const tenders = await q<{
      payment_intent_id: string | null;
      payment_link_id: string | null;
    }>(
      `SELECT payment_intent_id::text, payment_link_id::text FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenantId, dbId(orderId)],
    );
    for (const tender of tenders) {
      expect(tender.payment_intent_id).toBeNull();
      expect(tender.payment_link_id).toBeNull();
    }
  });
});

// legend-k0i8 (1248, founder Q24): the cloud may close a day while the edge is
// down; edge orders that arrive afterwards must not vanish or edit that frozen
// day. Observed behaviour: the order is ingested as a normal completed cloud
// order on its own business date, the stored day close (totals + recap) stays
// byte-for-byte what it was, and no second close row appears. 1269 E3
// (legend-k0i8): the sale is posted to the next open business day, flagged on
// its ingest ledger row (edge-shift-day-applier.test.ts covers the audit).
describe("legend-k0i8 edge order ingested after the cloud closed its day", () => {
  it("is kept as a cloud order and leaves the frozen day close untouched", async () => {
    const closeId = randomUUID();
    await q(
      `INSERT INTO pos_daily_closes
         (id, tenant_id, outlet_id, business_date, order_count, total_sales_idr,
          total_refunds_idr, total_voids_idr, total_variance_idr,
          inventory_deduction_applied, recap, closed_by, closed_at,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, false, '{"frozen":true}'::jsonb,
               $5, now(), $6, $7)`,
      [
        closeId,
        tenantId,
        outletA,
        BUSINESS_DATE,
        cashierId,
        randomUUID(),
        "f".repeat(64),
      ],
    );
    const frozenSql = `SELECT order_count, total_sales_idr::int AS total,
        recap::text AS recap, closed_at::text AS closed_at
      FROM pos_daily_closes WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`;
    const before = await q(frozenSql, [tenantId, outletA, BUSINESS_DATE]);

    const orderId = createUlid(++clock);
    const event = paidEvent(orderId);
    await deliver([event]);

    // Not lost: one completed cloud order on the next open business date,
    // ledgered as ingested and flagged late, and the raw event is parked.
    const rows = await orderRows(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "completed",
      business_date: "2034-01-03",
      outlet_id: outletA,
    });
    const [late] = await q<{ original: string; late: string }>(
      `SELECT original_business_date::text AS original, late_business_date::text AS late
         FROM edge_order_ingests WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, dbId(orderId)],
    );
    expect(late).toEqual({ original: BUSINESS_DATE, late: "2034-01-03" });
    expect((await ingestOf(orderId))?.state).toBe("ingested");
    expect(await parkedRowsOf(event)).toBe(1);

    // Not edited: the frozen close is identical and still the only one.
    expect(await q(frozenSql, [tenantId, outletA, BUSINESS_DATE])).toEqual(
      before,
    );
    expect(before).toHaveLength(1);
  });
});
