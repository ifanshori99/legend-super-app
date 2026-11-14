// HPP of POS sales -> stock movements -> GL, and its reversal (bead
// legend-9w46; PRD v1.7 §3 F16 "Resep / BOM & Pemotongan Otomatis", INV-02;
// POS-04 corrections; ACC-01 journals; INV-03 stock value).
//
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates (with the accounting module, a chart of accounts and open fiscal
// periods) and removes again. The recipe consumer runs through `withTenant`
// exactly as the worker delivers a cloud-sync event; the `stock.moved` events
// of the ledger rows it writes are read back from the outbox and delivered to
// the inventory GL bridge. Void and refund events are synthetic envelopes
// (the real POS correction needs approvals and shifts); case (a) is also
// driven through the real POS complete path.
//
// Only a final void reverses stock (CTO decision 2026-11-09): a refund, full or
// partial, is money-only because the food was consumed.
//
// Assumptions where the spec is silent:
// - A reversal is a ledger row `return` / source `order` / source id = the
//   order, +quantity at the ORIGINAL unit cost of the sale line; the GL
//   journal of it is Dr inventory / Cr cogs (the sale journal mirrored).
// - Synthetic orders are seeded with total = tender = Rp50.000, as the
//   `order.paid` payload carries.
// - A void reverses at most once; a later void of an already reversed order
//   changes nothing (reason and source id are kept).
// - A reversal consumed before `order.paid` leaves a line-less `sale` row in
//   status `reversed` (key `sale:order:<orderId>`); the late `order.paid`
//   then draws nothing.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  idr,
  outletIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
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
  orderIssueRecordedPayloadSchema,
  type OrderIssueType,
} from "@starter/shared/inventory";
import {
  dayClosedPayloadSchema,
  orderPaidPayloadSchema,
  orderRefundedPayloadSchema,
  orderVoidedPayloadSchema,
  type PosReceipt,
} from "@starter/shared/pos";
import {
  cafeLegendPlatformFixtures,
  DEVICE_TOKEN_HEADER,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { deliverInventoryGlEvent } from "../services/inventory-gl-consumer.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `hpp${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;
const deviceId = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
let app: Express;
const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();

// Cost of one plain cup in the kit below: 18 g x Rp100 + 200 ml x Rp20.
const CUP_COST = 5800;
const ORDER_TOTAL = 50000;

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

// Each test sells on its own far-future business date so that a `day.closed`
// in one test can never touch another test's pending rows.
let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2031, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

let ownerUserId: string;
let gramId: string;
let mlId: string;
let cupId: string;
let categoryId: string;

/** Owner-side writes to POS tables set the tenant local (RLS is FORCED). */
async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantA],
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

// ------------------------------------------------------------ owner fixtures

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function insertItem(name: string, baseUomId: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, baseUomId],
  );
}

async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(tenantContext(), {
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

async function configureOutlet(
  mode: "real_time" | "close_of_day",
  saleLocationId: string,
) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode,
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantA, outletA, mode, saleLocationId],
  );
}

type Kit = Awaited<ReturnType<typeof buildKit>>;

/**
 * A fresh sale location holding 1.000 g beans (Rp100/g) and 10.000 ml milk
 * (Rp20/ml), and a Latte (18 g beans + 200 ml milk, Rp5.800 per cup). The
 * outlet is configured for `mode` and this location.
 */
async function buildKit(mode: "real_time" | "close_of_day" = "real_time") {
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, outletA, `Bar HPP ${short()}`],
  );
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(location, beans, "1000.0000", "100.0000");
  await receive(location, milk, "10000.0000", "20.0000");
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantA, brandA, `Latte ${short()}`, cupId, ownerUserId],
  );
  for (const [index, [item, qty, uom]] of (
    [
      [beans, "18.0000", gramId],
      [milk, "200.0000", mlId],
    ] as const
  ).entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenantA, recipe, index, item, qty, uom],
    );
  const menuItem = await one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantA, brandA, categoryId, `Latte ${short()}`, recipe, randomUUID()],
  );
  await configureOutlet(mode, location);
  return { location, beans, milk, menuItem };
}

/**
 * A paid order as the POS leaves it: `orders` + one line, plus the POS rows
 * (`pos_orders`, one captured cash tender) the refund rule reads its paid
 * total from. Total = tender = Rp50.000.
 */
async function seedOrder(
  menuItemId: string,
  businessDate: string,
  quantity = 2,
): Promise<{ ulid: string; uuid: string }> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $6, 0, 0, 0, 0, $6,
               'completed', $5, now())`,
      [
        uuid,
        tenantA,
        outletA,
        `HPP-${randomUUID().slice(0, 12)}`,
        businessDate,
        ORDER_TOTAL,
      ],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', $6, 0, 0, 0, '[]'::jsonb,
               'fired', 'served', $7)`,
      [
        randomUUID(),
        tenantA,
        outletA,
        uuid,
        menuItemId,
        quantity,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [uuid, tenantA, outletA],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
      [tenantA, outletA, uuid, ORDER_TOTAL],
    );
  });
  return { ulid, uuid };
}

/** A `pos_order_refunds` row, as the real refund writes it before its event. */
async function insertRefund(orderUuid: string, amountIdr: number) {
  const refundId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO pos_order_refunds (id, tenant_id, outlet_id, order_id, amount_idr, reason, reason_note,
          lines, requested_by, approved_by, approval_request_id, refunded_at)
       VALUES ($1, $2, $3, $4, $5, 'customer_cancelled', 'Pelanggan batal', $6::jsonb,
               'kasir-uji', 'supervisor-uji', $7, now())`,
      [
        refundId,
        tenantA,
        outletA,
        orderUuid,
        amountIdr,
        JSON.stringify([{ method: "cash", amountIdr, reference: null }]),
        randomUUID(),
      ],
    );
  });
  return refundId;
}

// ------------------------------------------------------------------- events

function envelope(input: {
  name: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantA,
    outletId: outletA,
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: iso(),
    actor: { type: "system" },
    idempotencyKey: input.idempotencyKey,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload,
  });
}

function paidEvent(orderUlid: string, businessDate: string) {
  return envelope({
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    idempotencyKey: `order.paid:${orderUlid}`,
    payload: orderPaidPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
      businessDate,
      channel: "qr",
      serviceType: "takeaway",
      grossSalesIdr: ORDER_TOTAL,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      roundingIdr: 0,
      totalIdr: ORDER_TOTAL,
      paidCashIdr: ORDER_TOTAL,
      paidGatewayIdr: 0,
      paidEdcIdr: 0,
      paidPointsIdr: 0,
      tenders: [{ method: "cash", amountIdr: ORDER_TOTAL }],
      shiftId: null,
      cashierId: null,
      deviceId: null,
      paidAt: iso(),
    }),
  });
}

/** `final: true` is a linked void of a completed sale (carries a voidId). */
function voidedEvent(
  orderUlid: string,
  businessDate: string,
  options: { final: boolean; voidId?: string },
) {
  const voidId = options.final ? (options.voidId ?? randomUUID()) : null;
  return {
    voidId,
    event: envelope({
      name: "order.voided",
      aggregateType: "order",
      aggregateId: orderUlid,
      idempotencyKey: `order.voided:${voidId ?? orderUlid}`,
      payload: orderVoidedPayloadSchema.parse({
        orderId: orderUlid,
        outletId: outletA,
        businessDate,
        amountIdr: ORDER_TOTAL,
        reason: "customer_cancelled",
        reasonNote: "Pelanggan batal",
        approvedBy: ownerUserId,
        overrideId: null,
        approvalRequestId: null,
        voidedFinalOrder: options.final,
        voidId,
        receiptNumber: options.final ? "POS1-000001" : null,
        voidedAt: iso(),
      }),
    }),
  };
}

function refundedEvent(
  orderUlid: string,
  businessDate: string,
  refundId: string,
  amountIdr: number,
) {
  return envelope({
    name: "order.refunded",
    aggregateType: "order",
    aggregateId: orderUlid,
    idempotencyKey: `order.refunded:${refundId}`,
    payload: orderRefundedPayloadSchema.parse({
      orderId: orderUlid,
      outletId: outletA,
      businessDate,
      refundId,
      amountIdr,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      approvedBy: ownerUserId,
      overrideId: null,
      approvalRequestId: null,
      grossSalesIdr: amountIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      pbjtIdr: 0,
      refundCashIdr: amountIdr,
      refundGatewayIdr: 0,
      refundEdcIdr: 0,
      refundPointsIdr: 0,
      lines: [{ method: "cash", amountIdr }],
      refundedAt: iso(),
    }),
  });
}

function dayClosedEvent(businessDate: string) {
  return envelope({
    name: "day.closed",
    aggregateType: "day",
    aggregateId: createUlid(),
    idempotencyKey: `day.closed:${randomUUID()}`,
    payload: dayClosedPayloadSchema.parse({
      outletId: outletA,
      businessDate,
      orderCount: 1,
      totalSalesIdr: ORDER_TOTAL,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
      totalVarianceIdr: 0,
      inventoryDeductionApplied: false,
      accountingSyncStatus: "pending",
      closedBy: ownerUserId,
      closedAt: iso(),
    }),
  });
}

function issueEvent(input: {
  issueId: string;
  orderUlid: string;
  businessDate: string;
  type: OrderIssueType;
  menuItemId: string;
}) {
  return envelope({
    name: "order_issue.recorded",
    aggregateType: "order_issue",
    aggregateId: input.issueId,
    idempotencyKey: `order_issue.recorded:${input.issueId}`,
    payload: orderIssueRecordedPayloadSchema.parse({
      issueId: input.issueId,
      orderId: input.orderUlid,
      orderItemId: randomUUID(),
      outletId: outletA,
      businessDate: input.businessDate,
      type: input.type,
      reason: "quality",
      stationId: null,
      recordedBy: ownerUserId,
      menuItemId: input.menuItemId,
      variantId: null,
      modifierIds: [],
      quantity: 1,
      occurredAt: iso(),
    }),
  });
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(event: EventEnvelope) {
  const context = tenantContext();
  return withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(context, event, tx),
  );
}

// ------------------------------------------------------------------ readers

type Deduction = {
  id: string;
  kind: string;
  status: string;
  source_id: string;
  cost_idr: string | null;
  posted_at: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  reversal_source_id: string | null;
  reversal_failed_at: string | null;
  /** Unix seconds of reversal_failed_at, for ordering checks. */
  reversal_failed_epoch: number | null;
  lines: {
    inventory_item_id: string;
    quantity: string;
    unit_cost_idr: string | null;
  }[];
};

async function deductionsOf(...sourceIds: string[]): Promise<Deduction[]> {
  const { rows } = await owner.query<Omit<Deduction, "lines">>(
    `SELECT id, kind, status, source_id, cost_idr::text AS cost_idr, posted_at::text AS posted_at,
            reversed_at::text AS reversed_at, reversal_reason, reversal_source_id,
            reversal_failed_at::text AS reversal_failed_at,
            extract(epoch FROM reversal_failed_at)::float8 AS reversal_failed_epoch
     FROM recipe_deductions WHERE tenant_id = $1
       AND (source_id = ANY($2::text[]) OR idempotency_key = ANY($3::text[]))
     ORDER BY created_at, id`,
    [tenantA, sourceIds, sourceIds.map((id) => `order_issue:${id}`)],
  );
  const result: Deduction[] = [];
  for (const row of rows) {
    const lines = await owner.query<Deduction["lines"][number]>(
      `SELECT inventory_item_id, quantity::text AS quantity, unit_cost_idr::text AS unit_cost_idr
       FROM recipe_deduction_lines WHERE tenant_id = $1 AND deduction_id = $2`,
      [tenantA, row.id],
    );
    result.push({ ...row, lines: lines.rows });
  }
  return result;
}

async function saleDeductionOf(order: { ulid: string; uuid: string }) {
  const sales = (await deductionsOf(order.ulid, order.uuid)).filter(
    (row) => row.kind === "sale",
  );
  expect(sales.length, "sale deductions of the order").toBeLessThanOrEqual(1);
  return sales[0];
}

type LedgerRow = {
  id: string;
  movement_type: string;
  source_type: string;
  quantity: string;
  unit_cost_idr: string;
  inventory_item_id: string;
};

/** Every ledger row whose source is this order, oldest first. */
async function orderLedger(order: { uuid: string }): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT id::text AS id, movement_type, source_type, quantity::text AS quantity,
            unit_cost_idr::text AS unit_cost_idr, inventory_item_id
     FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2
     ORDER BY posting_seq`,
    [tenantA, order.uuid],
  );
  return rows;
}

const byType = (rows: LedgerRow[], type: string) =>
  rows
    .filter((row) => row.movement_type === type)
    .sort((a, b) => a.inventory_item_id.localeCompare(b.inventory_item_id));

async function onHand(locationId: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

async function sell(kit: Kit, quantity = 2) {
  const businessDate = nextDate();
  const order = await seedOrder(kit.menuItem, businessDate, quantity);
  await deliver(paidEvent(order.ulid, businessDate));
  return { order, businessDate };
}

// ----------------------------------------------------------------------- GL

type GlAccountRole = "cogs" | "inventory";
const accounts = {} as Record<GlAccountRole, string>;

/** The real `stock.moved` envelope the ledger row wrote to the outbox. */
async function stockMovedEvent(ledgerEntryId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
        AND event->'payload'->>'ledgerEntryId' = $2`,
    [tenantA, uuidToUlid(ledgerEntryId)],
  );
  expect(rows, `stock.moved outbox row of ${ledgerEntryId}`).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** Delivers the `stock.moved` event of each given ledger row to the GL bridge. */
async function deliverToGl(rows: LedgerRow[]) {
  for (const row of rows) {
    const event = await stockMovedEvent(row.id);
    const context = tenantContext();
    await withTenant(db, context, (tx) =>
      deliverInventoryGlEvent(context, event, tx),
    );
  }
}

type Journal = {
  id: string;
  lines: { role: string; debit: number; credit: number }[];
};

/** Journals by DB creation time (not causal order), with lines sorted by role. */
async function journalsOf(orderUlid: string): Promise<Journal[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_id = $3
      ORDER BY created_at, id`,
    [tenantA, legalEntityA, orderUlid],
  );
  const roleOf = new Map(
    (Object.entries(accounts) as [GlAccountRole, string][]).map(([r, id]) => [
      id,
      r,
    ]),
  );
  const journals: Journal[] = [];
  for (const row of rows) {
    const lines = await owner.query<{
      account_id: string;
      debit_idr: string;
      credit_idr: string;
    }>(
      `SELECT account_id, debit_idr::text AS debit_idr, credit_idr::text AS credit_idr
         FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
      [tenantA, row.id],
    );
    journals.push({
      id: row.id,
      lines: lines.rows
        .map((line) => ({
          role: roleOf.get(line.account_id) ?? "other",
          debit: Number(line.debit_idr),
          credit: Number(line.credit_idr),
        }))
        .sort((a, b) => a.role.localeCompare(b.role)),
    });
  }
  return journals;
}

const hppJournal = (cost: number) => [
  { role: "cogs", debit: cost, credit: 0 },
  { role: "inventory", debit: 0, credit: cost },
];
/** The same lines with debit and credit swapped (the mirror journal). */
const swapped = (lines: Journal["lines"]) =>
  lines.map((line) => ({
    role: line.role,
    debit: line.credit,
    credit: line.debit,
  }));
const reversalJournal = (cost: number) => [
  { role: "cogs", debit: 0, credit: cost },
  { role: "inventory", debit: cost, credit: 0 },
];

// -------------------------------------------------------------------- setup

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantA,
      `tenant-${slugA}`,
      `Tenant ${slugA}`,
      JSON.stringify({
        modules: ["pos", "inventory", "accounting", "qr_order"],
        integrationProviders: [],
      }),
      JSON.stringify(fixtures.tenant.limits),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [brandA, tenantA, `brand-${slugA}`, `Brand ${slugA}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [legalEntityA, tenantA, `Entity ${slugA}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      outletA,
      tenantA,
      brandA,
      legalEntityA,
      `H${slugA.slice(3)}`.toUpperCase(),
      `Outlet ${slugA}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, hostA],
  );
  // Chart of accounts with the two posting roles HPP uses, periods open.
  for (const [role, code, name, type, group] of [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  ] as const) {
    accounts[role] = await one<string>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantA, legalEntityA, code, name, type, group],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantA, legalEntityA, role, accounts[role]],
    );
  }
  for (const year of [2026, 2027, 2031])
    for (let month = 1; month <= 12; month += 1)
      await owner.query(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
        [tenantA, legalEntityA, `${year}-${String(month).padStart(2, "0")}`],
      );
}

/** Removes everything this file created in its own tenant (see recipe-bom). */
async function dropOwnTenant() {
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
        tenantA,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantA]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP POS Owner", `${ownerUserId}@example.com`],
  );
  const uom = async (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Uji', 0)",
    [categoryId, tenantA, brandA],
  );
});

beforeEach(async () => {
  // Pending rows from an earlier test must not be posted by this test's
  // `day.closed`.
  await owner.query(
    "DELETE FROM recipe_deductions WHERE tenant_id = $1 AND status = 'pending'",
    [tenantA],
  );
});

afterAll(async () => {
  await dropOwnTenant();
  await owner.end();
});

// ===========================================================================

describe("HPP of a paid order (a, b)", () => {
  it("HPP-POS-a a paid order writes sale/order ledger rows at -qty and posts Dr cogs / Cr inventory = cost", async () => {
    const kit = await buildKit();
    const { order } = await sell(kit);

    const deduction = await saleDeductionOf(order);
    expect(deduction).toMatchObject({
      status: "posted",
      cost_idr: String(2 * CUP_COST),
    });

    const ledger = await orderLedger(order);
    expect(ledger).toHaveLength(2);
    const sales = byType(ledger, "sale");
    expect(sales).toHaveLength(2);
    for (const row of sales) expect(row.source_type).toBe("order");
    const beans = sales.find((row) => row.inventory_item_id === kit.beans)!;
    const milk = sales.find((row) => row.inventory_item_id === kit.milk)!;
    expect(Number(beans.quantity)).toBe(-36);
    expect(Number(milk.quantity)).toBe(-400);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");

    await deliverToGl(ledger);
    const journals = await journalsOf(order.ulid);
    expect(journals).toHaveLength(1);
    // 36 x 100 + 400 x 20 = 11.600
    expect(journals[0]!.lines).toEqual(hppJournal(2 * CUP_COST));
  });

  it("HPP-POS-b order.paid delivered twice makes one deduction, one ledger set and one journal", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate);
    const event = paidEvent(order.ulid, businessDate);
    await deliver(event);
    await deliver(event);

    expect(
      (await deductionsOf(order.ulid, order.uuid)).filter(
        (row) => row.kind === "sale",
      ),
    ).toHaveLength(1);
    const ledger = await orderLedger(order);
    expect(ledger).toHaveLength(2);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");

    // The same stock.moved events delivered twice still make one journal.
    await deliverToGl(ledger);
    await deliverToGl(ledger);
    const journals = await journalsOf(order.ulid);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.lines).toEqual(hppJournal(2 * CUP_COST));
  });
});

describe("HPP through the real POS complete path (a)", () => {
  const cashierRole = randomUUID();
  const priceList = randomUUID();
  let cashier: { client: ReturnType<typeof agent>; userId: string };
  let posMenuItem: string;
  let posKit: Kit;

  function receiptPort(): PosReceiptPort {
    const byOrder = new Map<string, PosReceipt>();
    let next = 0;
    return {
      async issueForSale(_tx, context, input) {
        const existing = byOrder.get(input.orderId);
        if (existing) return existing;
        next += 1;
        const receipt = {
          id: randomUUID(),
          tenantId: context.tenant.tenantId,
          outletId: input.outletId,
          orderId: input.orderId,
          deviceId: input.deviceId ?? deviceId,
          number: `POS1-${String(next).padStart(6, "0")}`,
          sequenceNumber: next,
          status: "issued",
          issuedAt: input.at.toISOString(),
          voidedAt: null,
          voidReason: null,
          voidedBy: null,
          reprintCount: 0,
        } as unknown as PosReceipt;
        byOrder.set(input.orderId, receipt);
        return receipt;
      },
      async findForOrder(_tx, _context, orderId) {
        return byOrder.get(orderId) ?? null;
      },
      async voidForOrder() {
        return null;
      },
    };
  }

  beforeAll(async () => {
    setPosReceiptPort(receiptPort());
    setDeviceOutletResolver(async (input) =>
      input.tenantId === tenantA && input.deviceId === deviceId
        ? outletA
        : null,
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Kasir HPP', false, NULL, $3, false, '["tenant"]')`,
      [
        cashierRole,
        tenantA,
        JSON.stringify([
          "order.view",
          "pos.sale.create",
          "pos.payment.accept",
          "shift.cash.operate",
        ]),
      ],
    );
    const client = agent(app);
    await signUp(client, "Kasir HPP");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantA, userId, cashierRole],
    );
    cashier = { client, userId };
    await registerTestDevice(owner, {
      tenantId: tenantA,
      outletId: outletA,
      deviceId,
    });
    await openPosShift(
      tenantContext(),
      { userId: userIdSchema.parse(userId), deviceId },
      outletIdSchema.parse(outletA),
      { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
    );
    posKit = await buildKit();
    posMenuItem = posKit.menuItem;
    await asOwnerTenant(async (c) => {
      await c.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [priceList, tenantA, outletA],
      );
      await c.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, 25000)`,
        [randomUUID(), tenantA, priceList, posMenuItem],
      );
      await c.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                 'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), tenantA, ownerUserId],
      );
      await c.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'PBJT-HPP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                 '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), tenantA, ownerUserId],
      );
    });
  });

  afterAll(() => {
    setPosReceiptPort(null);
    setDeviceOutletResolver(null);
  });

  function pos(path: string, body: Record<string, unknown>) {
    return cashier.client
      .post(`/api/outlets/${encodeURIComponent(outletA)}/pos/orders${path}`)
      .set({ Host: hostA })
      .set(originHeader)
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt: Math.floor(Date.now() / 1000),
          tenantId: tenantA,
          brandId: null,
          deviceId,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });
  }

  it("HPP-POS-a a cashier completes a 2-cup sale; the sale draws the stock and the HPP journal equals the cost", async () => {
    await configureOutlet("real_time", posKit.location);
    const created = await pos("", {
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: posMenuItem, quantity: 2, modifierIds: [] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    let status = created.body.data.status as string;
    if (status === "draft") {
      const submitted = await pos(`/${orderId}/submit`, {
        expectedStatus: status,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }
    const totalIdr = created.body.data.totalIdr as number;
    const paid = await pos(`/${orderId}/tenders`, {
      method: "cash",
      receivedIdr: totalIdr,
      expectedStatus: status,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const completed = await pos(`/${orderId}/complete`, {
      expectedStatus: paid.body.data.order.status as string,
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    // The worker consumes the order.paid event the POS wrote to the outbox.
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
          AND event->'payload'->>'orderId' = $2`,
      [tenantA, orderId],
    );
    expect(rows).toHaveLength(1);
    await deliver(eventEnvelopeSchema.parse(rows[0]!.event));

    const order = { ulid: orderId, uuid: ulidToUuid(orderId) };
    const deduction = await saleDeductionOf(order);
    expect(deduction).toMatchObject({
      status: "posted",
      cost_idr: String(2 * CUP_COST),
    });
    const ledger = await orderLedger(order);
    expect(byType(ledger, "sale")).toHaveLength(2);
    expect(await onHand(posKit.location, posKit.beans)).toBe("964.0000");

    await deliverToGl(ledger);
    const journals = await journalsOf(orderId);
    expect(journals).toHaveLength(1);
    expect(journals[0]!.lines).toEqual(hppJournal(2 * CUP_COST));
  }, 30_000);

  it("legend-7l2bq an inactive recipe location leaves the POS sale payable and completed, with no partial stock deduction", async () => {
    const healthy = await buildKit();
    const inactive = await buildKit();
    await owner.query(
      `UPDATE recipe_lines SET deduction_location_id = $1
        WHERE tenant_id = $2 AND recipe_id = (
          SELECT recipe_id FROM menu_items WHERE tenant_id = $2 AND id = $3
        )`,
      [inactive.location, tenantA, inactive.menuItem],
    );
    await owner.query(
      "UPDATE stock_locations SET is_active = false WHERE tenant_id = $1 AND id = $2",
      [tenantA, inactive.location],
    );
    await configureOutlet("real_time", healthy.location);
    await asOwnerTenant(async (client) => {
      for (const menuItem of [healthy.menuItem, inactive.menuItem])
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, 25000)`,
          [randomUUID(), tenantA, priceList, menuItem],
        );
    });

    const created = await pos("", {
      channel: "pos",
      serviceType: "takeaway",
      items: [healthy.menuItem, inactive.menuItem].map((menuItemId) => ({
        menuItemId,
        quantity: 1,
        modifierIds: [],
      })),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    let status = created.body.data.status as string;
    if (status === "draft") {
      const submitted = await pos(`/${orderId}/submit`, {
        expectedStatus: status,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }
    const paid = await pos(`/${orderId}/tenders`, {
      method: "cash",
      receivedIdr: created.body.data.totalIdr as number,
      expectedStatus: status,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const completed = await pos(`/${orderId}/complete`, {
      expectedStatus: paid.body.data.order.status as string,
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const order = { ulid: orderId, uuid: ulidToUuid(orderId) };
    const { rows: snapshots } = await owner.query<{
      menu_item_id: string;
      cost: string | null;
    }>(
      `SELECT menu_item_id, cost_snapshot_idr::text AS cost FROM order_items
        WHERE tenant_id = $1 AND order_id = $2 ORDER BY menu_item_id`,
      [tenantA, order.uuid],
    );
    expect(snapshots).toEqual(
      expect.arrayContaining([
        { menu_item_id: healthy.menuItem, cost: String(CUP_COST) },
        { menu_item_id: inactive.menuItem, cost: null },
      ]),
    );
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
          AND event->'payload'->>'orderId' = $2`,
      [tenantA, orderId],
    );
    expect(rows).toHaveLength(1);
    const event = eventEnvelopeSchema.parse(rows[0]!.event);
    await deliver(event);
    await deliver(event);

    expect(await saleDeductionOf(order)).toMatchObject({ status: "skipped" });
    expect(await deductionsOf(order.ulid, order.uuid)).toHaveLength(1);
    expect(await orderLedger(order)).toEqual([]);
    expect(await journalsOf(orderId)).toEqual([]);
    for (const kit of [healthy, inactive]) {
      expect(await onHand(kit.location, kit.beans)).toBe("1000.0000");
      expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");
    }
    const { rows: persisted } = await owner.query<{ status: string }>(
      "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
      [tenantA, order.uuid],
    );
    expect(persisted).toEqual([{ status: "completed" }]);
  }, 30_000);
});

describe("HPP reversal on a final void; refunds never reverse (c, d)", () => {
  it("HPP-POS-c a final void returns the stock at the ORIGINAL cost and its journal mirrors the HPP journal; a replay and a later full refund change nothing", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit);
    const saleLedger = await orderLedger(order);
    await deliverToGl(saleLedger);
    const hpp = (await journalsOf(order.ulid))[0]!;

    // The average cost of beans changes after the sale: 1.000 g more at Rp300.
    await receive(kit.location, kit.beans, "1000.0000", "300.0000");
    expect(await onHand(kit.location, kit.beans)).toBe("1964.0000");

    const { event, voidId } = voidedEvent(order.ulid, businessDate, {
      final: true,
    });
    await deliver(event);

    const afterVoid = await orderLedger(order);
    const returns = byType(afterVoid, "return");
    expect(returns).toHaveLength(2);
    for (const row of returns) expect(row.source_type).toBe("order");
    const beansBack = returns.find(
      (row) => row.inventory_item_id === kit.beans,
    )!;
    const milkBack = returns.find((row) => row.inventory_item_id === kit.milk)!;
    expect(Number(beansBack.quantity)).toBe(36);
    expect(Number(milkBack.quantity)).toBe(400);
    // The sale's cost, not today's average (beans are worth ~Rp200/g now).
    expect(Number(beansBack.unit_cost_idr)).toBe(100);
    expect(Number(milkBack.unit_cost_idr)).toBe(20);
    expect(await onHand(kit.location, kit.beans)).toBe("2000.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");

    const reversed = await saleDeductionOf(order);
    expect(reversed).toMatchObject({
      status: "reversed",
      reversal_reason: "void",
      reversal_source_id: voidId,
    });
    expect(reversed!.reversed_at).not.toBeNull();
    expect(reversed!.posted_at).not.toBeNull();

    // The GL reversal offsets the HPP journal exactly.
    await deliverToGl(returns);
    const journals = await journalsOf(order.ulid);
    expect(journals).toHaveLength(2);
    const original = journals.find((journal) => journal.id === hpp.id);
    const returned = journals.find((journal) => journal.id !== hpp.id)!;
    expect(original).toEqual(hpp);
    expect(returned.lines).toEqual(reversalJournal(2 * CUP_COST));
    // Line by line: every HPP line mirrored, so the two journals net to zero
    // per account.
    expect(returned.lines).toEqual(swapped(hpp.lines));
    for (const role of ["cogs", "inventory"]) {
      const net = [hpp, returned]
        .flatMap((journal) => journal.lines)
        .filter((line) => line.role === role)
        .reduce((sum, line) => sum + line.debit - line.credit, 0);
      expect(net, `net ${role} of HPP + reversal`).toBe(0);
    }

    // Replay of the same void: nothing more.
    await deliver(event);
    expect(await orderLedger(order)).toHaveLength(4);
    expect(await onHand(kit.location, kit.beans)).toBe("2000.0000");

    // A second void record and a full refund after the void: nothing more,
    // and the first reversal (reason, source) stays.
    await deliver(voidedEvent(order.ulid, businessDate, { final: true }).event);
    const refundId = await insertRefund(order.uuid, ORDER_TOTAL);
    await deliver(
      refundedEvent(order.ulid, businessDate, refundId, ORDER_TOTAL),
    );
    const after = await orderLedger(order);
    expect(after).toHaveLength(4);
    expect(byType(after, "return")).toHaveLength(2);
    expect(await onHand(kit.location, kit.beans)).toBe("2000.0000");
    expect(await saleDeductionOf(order)).toMatchObject({
      status: "reversed",
      reversal_reason: "void",
      reversal_source_id: voidId,
    });
    await deliverToGl(after);
    expect(await journalsOf(order.ulid)).toHaveLength(2);
  });

  it("HPP-POS-d partial and full refund never move stock or post a reversal journal; the deduction stays posted", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit);
    const saleLedger = await orderLedger(order);
    await deliverToGl(saleLedger);
    const hpp = (await journalsOf(order.ulid))[0]!;

    const partialId = await insertRefund(order.uuid, 20000);
    const partial = refundedEvent(order.ulid, businessDate, partialId, 20000);
    await deliver(partial);
    expect(await saleDeductionOf(order)).toMatchObject({ status: "posted" });
    expect(byType(await orderLedger(order), "return")).toHaveLength(0);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");

    // The rest of the order is refunded: cumulative 50.000 = the paid total.
    const restId = await insertRefund(order.uuid, 30000);
    const rest = refundedEvent(order.ulid, businessDate, restId, 30000);
    await deliver(rest);
    expect(await saleDeductionOf(order)).toMatchObject({
      status: "posted",
      reversal_reason: null,
      reversal_source_id: null,
    });
    const after = await orderLedger(order);
    expect(after).toHaveLength(saleLedger.length);
    expect(byType(after, "return")).toHaveLength(0);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");

    // Replaying either refund event changes nothing, and no reversal journal.
    await deliver(partial);
    await deliver(rest);
    expect(await orderLedger(order)).toHaveLength(saleLedger.length);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    await deliverToGl(await orderLedger(order));
    expect(await journalsOf(order.ulid)).toEqual([hpp]);
  });
});

describe("HPP reversal edge cases (e, f, g, h)", () => {
  it("HPP-POS-e close_of_day: a void before the day closes marks the pending deduction reversed; day.closed posts nothing for it", async () => {
    const kit = await buildKit("close_of_day");
    const { order, businessDate } = await sell(kit);
    expect(await saleDeductionOf(order)).toMatchObject({ status: "pending" });
    expect(await orderLedger(order)).toHaveLength(0);

    const { voidId, event } = voidedEvent(order.ulid, businessDate, {
      final: true,
    });
    await deliver(event);
    const reversed = await saleDeductionOf(order);
    expect(reversed).toMatchObject({
      status: "reversed",
      reversal_reason: "void",
      reversal_source_id: voidId,
      posted_at: null,
    });
    // No stock ever left, so no return row is written.
    expect(await orderLedger(order)).toHaveLength(0);

    await deliver(dayClosedEvent(businessDate));
    expect(await saleDeductionOf(order)).toMatchObject({ status: "reversed" });
    expect(await orderLedger(order)).toHaveLength(0);
    expect(await onHand(kit.location, kit.beans)).toBe("1000.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");
  });

  it("HPP-POS-f a void consumed before order.paid leaves a reversed tombstone, and the late order.paid draws nothing", async () => {
    const kit = await buildKit();
    const businessDate = nextDate();
    const order = await seedOrder(kit.menuItem, businessDate);

    const { voidId, event } = voidedEvent(order.ulid, businessDate, {
      final: true,
    });
    await deliver(event);
    const tombstone = await saleDeductionOf(order);
    expect(tombstone).toMatchObject({
      kind: "sale",
      status: "reversed",
      reversal_reason: "void",
      reversal_source_id: voidId,
    });
    expect(tombstone!.lines).toHaveLength(0);
    expect(await orderLedger(order)).toHaveLength(0);

    const paid = paidEvent(order.ulid, businessDate);
    await deliver(paid);
    await deliver(paid);
    expect(
      (await deductionsOf(order.ulid, order.uuid)).filter(
        (row) => row.kind === "sale",
      ),
    ).toHaveLength(1);
    expect(await saleDeductionOf(order)).toMatchObject({
      status: "reversed",
      reversal_source_id: voidId,
    });
    expect((await saleDeductionOf(order))!.lines).toHaveLength(0);
    expect(await orderLedger(order)).toHaveLength(0);
    expect(await onHand(kit.location, kit.beans)).toBe("1000.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");
  });

  it("HPP-POS-g a pre-payment void (voidedFinalOrder false) changes no stock, on a paid order or on one never paid", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit);
    const before = await saleDeductionOf(order);
    await deliver(
      voidedEvent(order.ulid, businessDate, { final: false }).event,
    );
    expect(await saleDeductionOf(order)).toEqual(before);
    expect(byType(await orderLedger(order), "return")).toHaveLength(0);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");

    // An unpaid order voided before payment: no deduction, no tombstone.
    const otherDate = nextDate();
    const unpaid = await seedOrder(kit.menuItem, otherDate);
    await deliver(voidedEvent(unpaid.ulid, otherDate, { final: false }).event);
    expect(await deductionsOf(unpaid.ulid, unpaid.uuid)).toHaveLength(0);
    expect(await orderLedger(unpaid)).toHaveLength(0);
  });

  it("HPP-POS-h a void reverses only the sale: the remake and comp deductions of the order stay posted", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit);
    const remakeIssue = randomUUID();
    const compIssue = randomUUID();
    for (const [issueId, type] of [
      [remakeIssue, "remake"],
      [compIssue, "comp"],
    ] as const)
      await deliver(
        issueEvent({
          issueId,
          orderUlid: order.ulid,
          businessDate,
          type,
          menuItemId: kit.menuItem,
        }),
      );
    const [remakeBefore] = await deductionsOf(remakeIssue);
    const [compBefore] = await deductionsOf(compIssue);
    expect(remakeBefore).toMatchObject({ kind: "remake", status: "posted" });
    expect(compBefore).toMatchObject({ kind: "comp", status: "posted" });
    // 2 cups sold + 1 remake + 1 comp = 4 x 18 g beans drawn.
    expect(await onHand(kit.location, kit.beans)).toBe("928.0000");

    await deliver(voidedEvent(order.ulid, businessDate, { final: true }).event);
    expect(await saleDeductionOf(order)).toMatchObject({ status: "reversed" });
    expect((await deductionsOf(remakeIssue))[0]).toEqual(remakeBefore);
    expect((await deductionsOf(compIssue))[0]).toEqual(compBefore);
    // Only the sale's 2 cups (36 g) come back; the remake and comp stay out.
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");
  });
});

describe("HPP reversal refused and retried at day close (i)", () => {
  /**
   * A foreign ledger row that already owns the idempotency key of the beans
   * return, with another request fingerprint: the stock service refuses the
   * return ("key used for a different stock posting", HTTP status 409).
   * Returns its id.
   */
  async function blockBeansReturn(
    kit: Kit,
    deductionId: string,
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO stock_ledger (id, tenant_id, outlet_id, location_id, inventory_item_id,
          movement_type, quantity, unit_cost_idr, source_type, source_id,
          idempotency_key, request_fingerprint, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'receipt', 1, 1, 'goods_receipt', $6, $7, 'not-the-same-request', now())`,
      [
        id,
        tenantA,
        outletA,
        kit.location,
        kit.beans,
        randomUUID(),
        `recipe-reversal:${deductionId}:${kit.beans}`,
      ],
    );
    return id;
  }

  async function unblock(ledgerId: string) {
    // stock_ledger is append-only (trigger); the test superuser removes the
    // planted blocker with user triggers off for this transaction only.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM stock_ledger WHERE tenant_id = $1 AND id = $2",
        [tenantA, ledgerId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // Assumption: a switched-off location or item does not make the stock
  // service refuse a movement (both tried), and the stored location of a line
  // cannot be pointed elsewhere (foreign key). The reachable refusal is an
  // idempotency-key clash (status 409) on the beans return. Whatever refuses
  // the return, the consumer must not throw (the aggregate must not block):
  // the reversal is parked on the still-posted deduction, and the next
  // day.closed of the outlet retries it once the cause is fixed.
  it("HPP-POS-i a void whose return is refused parks the reversal on the posted deduction; day.closed posts it at the original cost once the cause is fixed", async () => {
    const kit = await buildKit();
    const { order, businessDate } = await sell(kit);
    const saleLedger = await orderLedger(order);
    await deliverToGl(saleLedger);
    const hpp = (await journalsOf(order.ulid))[0]!;
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");

    // The cause: the beans return key is taken by a different posting.
    const poison = await blockBeansReturn(
      kit,
      (await saleDeductionOf(order))!.id,
    );
    const { event, voidId } = voidedEvent(order.ulid, businessDate, {
      final: true,
    });
    await deliver(event); // must not throw

    const parked = await saleDeductionOf(order);
    expect(parked).toMatchObject({
      status: "posted",
      reversal_reason: "void",
      reversal_source_id: voidId,
      reversed_at: null,
    });
    expect(parked!.reversal_failed_at).not.toBeNull();
    expect(parked!.posted_at).not.toBeNull();
    // No return row, stock unchanged.
    expect(byType(await orderLedger(order), "return")).toHaveLength(0);
    expect(await orderLedger(order)).toHaveLength(2);
    expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");

    // A day.closed while the cause is still there: the retry fails again and
    // only bumps reversal_failed_at; reason and source stay the first ones.
    await deliver(dayClosedEvent(businessDate)); // must not throw
    const stillParked = await saleDeductionOf(order);
    expect(stillParked).toMatchObject({
      status: "posted",
      reversal_reason: "void",
      reversal_source_id: voidId,
      reversed_at: null,
    });
    expect(stillParked!.reversal_failed_epoch).not.toBeNull();
    expect(stillParked!.reversal_failed_epoch!).toBeGreaterThanOrEqual(
      parked!.reversal_failed_epoch!,
    );
    expect(byType(await orderLedger(order), "return")).toHaveLength(0);

    // The cause is fixed; meanwhile the beans average moved (1.000 g at Rp300).
    await unblock(poison);
    await receive(kit.location, kit.beans, "1000.0000", "300.0000");
    await deliver(dayClosedEvent(businessDate));

    const returns = byType(await orderLedger(order), "return");
    expect(returns).toHaveLength(2);
    for (const row of returns) expect(row.source_type).toBe("order");
    const beansBack = returns.find(
      (row) => row.inventory_item_id === kit.beans,
    )!;
    const milkBack = returns.find((row) => row.inventory_item_id === kit.milk)!;
    expect(Number(beansBack.quantity)).toBe(36);
    expect(Number(milkBack.quantity)).toBe(400);
    expect(Number(beansBack.unit_cost_idr)).toBe(100);
    expect(Number(milkBack.unit_cost_idr)).toBe(20);
    expect(await onHand(kit.location, kit.beans)).toBe("2000.0000");
    expect(await onHand(kit.location, kit.milk)).toBe("10000.0000");

    const reversed = await saleDeductionOf(order);
    expect(reversed).toMatchObject({
      status: "reversed",
      reversal_reason: "void",
      reversal_source_id: voidId,
      reversal_failed_at: null,
    });
    expect(reversed!.reversed_at).not.toBeNull();

    // The GL journal of the late return mirrors the HPP journal exactly.
    await deliverToGl(returns);
    const journals = await journalsOf(order.ulid);
    expect(journals).toHaveLength(2);
    const original = journals.find((journal) => journal.id === hpp.id);
    const returned = journals.find((journal) => journal.id !== hpp.id)!;
    expect(original).toEqual(hpp);
    expect(returned.lines).toEqual(swapped(hpp.lines));
    expect(returned.lines).toEqual(reversalJournal(2 * CUP_COST));

    // Another day.closed and a replay of the void change nothing.
    await deliver(dayClosedEvent(businessDate));
    await deliver(event);
    expect(byType(await orderLedger(order), "return")).toHaveLength(2);
    expect(await onHand(kit.location, kit.beans)).toBe("2000.0000");
    expect(await saleDeductionOf(order)).toMatchObject({
      status: "reversed",
      reversal_failed_at: null,
    });
  }, 30_000);
});

// legend-fbms / legend-9pz9: the recipe deduction rides on `order.paid`. Since
// design A every POS completion emits it, also a fully comped one (total 0, no
// tenders), and a QR pay-first order emits it when it fires. Assumptions: the
// deduction key `sale:order:<orderId>` keeps each order to exactly one
// deduction however often the event is delivered; a QR order has no pos_orders
// row and no tender rows (the order's lines are what is deducted).
describe("HPP of a total-0 POS order and of a QR order (legend-fbms, legend-9pz9)", () => {
  async function seedOrderOfKind(
    menuItemId: string,
    businessDate: string,
    kind: { channel: "pos" | "qr"; totalIdr: number },
  ): Promise<{ ulid: string; uuid: string }> {
    const ulid = createUlid();
    const uuid = ulidToUuid(ulid);
    await asOwnerTenant(async (client) => {
      await client.query(
        `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
            subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
            status, business_date, placed_at, fired_at)
         VALUES ($1, $2, $3, $4, $7, 'takeaway', 'pay_first', $6, 0, 0, 0, 0, $6,
                 $8, $5, now(), $9)`,
        [
          uuid,
          tenantA,
          outletA,
          `HPP-${randomUUID().slice(0, 12)}`,
          businessDate,
          kind.totalIdr,
          kind.channel,
          kind.channel === "qr" ? "sent" : "completed",
          kind.channel === "qr" ? new Date().toISOString() : null,
        ],
      );
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
            quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
            fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', 2, 0, 0, 0, '[]'::jsonb,
                 'fired', 'served', $6)`,
        [randomUUID(), tenantA, outletA, uuid, menuItemId, businessDate],
      );
      if (kind.channel === "pos")
        await client.query(
          `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
           VALUES ($1, $2, $3, 'pos')`,
          [uuid, tenantA, outletA],
        );
    });
    return { ulid, uuid };
  }

  function paidEventOf(
    orderUlid: string,
    businessDate: string,
    kind: "pos-comp" | "qr",
  ) {
    const qr = kind === "qr";
    return envelope({
      name: "order.paid",
      aggregateType: "order",
      aggregateId: orderUlid,
      idempotencyKey: `order.paid:${orderUlid}`,
      payload: orderPaidPayloadSchema.parse({
        orderId: orderUlid,
        outletId: outletA,
        businessDate,
        channel: qr ? "qr" : "pos",
        serviceType: "takeaway",
        grossSalesIdr: qr ? ORDER_TOTAL : 20_000,
        // The comp: the whole gross is discounted, the total is 0.
        discountIdr: qr ? 0 : 20_000,
        serviceChargeIdr: 0,
        pbjtIdr: 0,
        roundingIdr: 0,
        totalIdr: qr ? ORDER_TOTAL : 0,
        paidCashIdr: 0,
        paidGatewayIdr: qr ? ORDER_TOTAL : 0,
        paidEdcIdr: 0,
        paidPointsIdr: 0,
        paidDepositIdr: 0,
        tenders: qr ? [{ method: "qris", amountIdr: ORDER_TOTAL }] : [],
        shiftId: null,
        cashierId: null,
        deviceId: null,
        paidAt: iso(),
      }),
    });
  }

  for (const kind of ["pos-comp", "qr"] as const)
    it(`HPP-QR-${kind} order.paid of ${kind === "qr" ? "a QR pay-first order" : "a total-0 POS order"} delivered twice makes one deduction and one ledger set`, async () => {
      const kit = await buildKit();
      const businessDate = nextDate();
      const order = await seedOrderOfKind(kit.menuItem, businessDate, {
        channel: kind === "qr" ? "qr" : "pos",
        totalIdr: kind === "qr" ? ORDER_TOTAL : 0,
      });
      const event = paidEventOf(order.ulid, businessDate, kind);
      await deliver(event);
      await deliver(event);

      expect(
        (await deductionsOf(order.ulid, order.uuid)).filter(
          (row) => row.kind === "sale",
        ),
      ).toHaveLength(1);
      expect(await orderLedger(order)).toHaveLength(2);
      // 2 cups x (18 g beans, 200 ml milk)
      expect(await onHand(kit.location, kit.beans)).toBe("964.0000");
      expect(await onHand(kit.location, kit.milk)).toBe("9600.0000");
    });
});
