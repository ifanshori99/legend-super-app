// legend-1042 W3b ("satu jalur refund", founder decision A): one order may carry
// only ONE of: a cashier refund (pos_order_refunds), a void (pos_order_voids,
// from the cloud POS or ingested from an edge node) or a live manual per-item
// refund (order_issues, resolution manual_refund, approval_request_id NULL, not
// cancelled, refund not rejected). Restrictive: when unsure, refuse. The guest
// must never receive more than the order took in.
//
// Written from the brief and the 980 fixtures (never from the implementation).
// Every pair {cashier refund, cloud void, edge void} x {manual refund} is checked
// in both orders and as a parallel race, plus edge replay, "never more than
// paid", and isolation (other order / other outlet / other tenant).
//
// Assumptions (also reported):
// - a refused manual refund answers HTTP 409; a refused cashier refund / cloud
//   void rejects with status 409 REFUND_MANUAL_REFUND_EXISTS (980 contract).
// - a refused edge void is a ledger refusal (no throw): no pos_order_voids row,
//   edge_order_ingests.reason mentions `manual_refund` (brief code
//   `manual_refund_exists`; matched loosely), state stays `ingested`.
// - the manual refund of a one-line order pays the whole line (= what was paid),
//   so "paid out" = POS refunds + void amount + Rp50.000 per live manual refund.
// - a parallel race ends with exactly ONE of the money paths recorded.
// - F2 (CTO decision): a manual refund of an edge-ingested sale (ledger state
//   ingested or voided) is refused 409 EDGE_ORDER_CORRECTION_BLOCKED, like the
//   cashier refund / cloud void. So a LIVE manual refund on an edge sale can no
//   longer be created through the route; tests that need one (to prove the
//   manual_refund_exists guard of the edge ingest and its race) seed the
//   order_issues row directly (`seedManualIssue`, the same columns the route
//   writes), or race a seed that takes the order row lock and checks for a void
//   like the route does (`seedManualUnlessVoided`). The code is matched loosely
//   in the JSON body (shape not specified).
//
// FAIL-FIRST: the tests that fail on the base are the ones that prove G1 (manual
// refund after a void is not refused) and G2 (edge void ignores a live manual
// refund, and does not lock the order row so the race is open). Every refusal
// test is paired with a control (the lone legit action succeeds), so a refusal
// can never pass because of an unrelated 4xx.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/single-refund-lane-1042.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPosOverrideSchema,
  posOverrideIdSchema,
  type PosOverrideView,
} from "@starter/shared/access/override";
import {
  createUlid,
  decimal4,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
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
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";

const short = () => randomUUID().slice(0, 6);
const PIN = "582914";
/** Every order: one line, no discount, service or tax, paid in cash. */
const PAID = 50_000;
const BUSINESS_DATE = "2034-01-02";

const ids = {
  recorderRole: randomUUID(),
  outletB: randomUUID(),
  barA: randomUUID(),
  category: randomUUID(),
  device: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let recorder: Member; // cashier + reporter of the manual refund
let supervisor: Member; // approver of every approval below
let menuItem: string;
let ownerRoleId: string;
let shiftBusinessDate = BUSINESS_DATE;
let node: AuthenticatedEdgeNode;
const actor = randomUUID();

type Order = {
  ulid: string;
  uuid: string;
  itemUlid: string;
  itemUuid: string;
};
type Where = { tenantId: string; outletId: string; realMenu: boolean };
const here = (): Where => ({
  tenantId: tenant.tenantId,
  outletId: tenant.outletId,
  realMenu: true,
});

function tenantCtx(forTenant: IsolatedTenant) {
  return establishTenantContext({
    tenantId: tenantIdSchema.parse(forTenant.tenantId),
    brandId: null,
    source: "session",
  });
}

function scope(): ScopedTenantContext {
  return establishScopedTenantContext(tenantCtx(tenant), { kind: "tenant" });
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

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function assign(userId: string, roleId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
}

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await assign(userId, roleId);
  return { client, userId };
}

async function insertRole(id: string, name: string, permissions: string[]) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [
      id,
      tenant.tenantId,
      name,
      JSON.stringify(permissions),
      JSON.stringify(["tenant", "outlet", "station"]),
    ],
  );
}

/** A menu item with a recipe and stock (the manual refund computes a cost). */
async function buildMenuItem(): Promise<string> {
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenant.tenantId, `${code}${short()}`.slice(0, 10)],
    );
  const gramId = await uom("g");
  const mlId = await uom("ml");
  const cupId = await uom("cup");
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Satu Jalur', 0)",
    [ids.category, tenant.tenantId, tenant.brandId],
  );
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenant.tenantId, tenant.outletId, `Bar ${short()}`],
  );
  const item = (name: string, uomId: string) =>
    one<string>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
      [tenant.tenantId, `${name} ${short()}`, uomId],
    );
  const beans = await item("Biji Kopi", gramId);
  const milk = await item("Susu", mlId);
  for (const [itemId, quantity, cost] of [
    [beans, "1000.0000", "100.0000"],
    [milk, "10000.0000", "20.0000"],
  ] as const)
    await recordStockMovement(scope(), {
      outletId: outletIdSchema.parse(tenant.outletId),
      locationId: location,
      inventoryItemId: itemId,
      movementType: "receipt",
      quantity: decimal4(quantity),
      unitCostIdr: decimal4(cost),
      batchId: null,
      sourceType: "goods_receipt",
      sourceId: randomUUID(),
      actor: { type: "system" },
    } as never);
  const recipe = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [
      tenant.tenantId,
      tenant.brandId,
      `Latte ${short()}`,
      cupId,
      recorder.userId,
    ],
  );
  for (const [index, [itemId, qty, uomId]] of (
    [
      [beans, "18.0000", gramId],
      [milk, "200.0000", mlId],
    ] as const
  ).entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenant.tenantId, recipe, index, itemId, qty, uomId],
    );
  const menu = await one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id, station_id, station_type)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, 'beverage_bar') RETURNING id`,
    [
      tenant.tenantId,
      tenant.brandId,
      ids.category,
      `Latte ${short()}`,
      recipe,
      randomUUID(),
      ids.barA,
    ],
  );
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time', sale_location_id = EXCLUDED.sale_location_id`,
    [tenant.tenantId, tenant.outletId, location],
  );
  return menu;
}

// ---------------------------------------------------------------- cloud sales

/** A completed cloud POS sale: one line of Rp50.000 paid in cash. */
async function cloudSale(where: Where = here()): Promise<Order> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const itemUuid = randomUUID();
  await asOwnerTenant(where.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', $6::date, now())`,
      [
        uuid,
        where.tenantId,
        where.outletId,
        `S1042-${ulid.slice(-20)}`,
        PAID,
        shiftBusinessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [uuid, where.tenantId, where.outletId],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         amount_idr, status, reference, requested_at, resolved_at, received_idr, change_idr)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, 'captured', $5, now(), now(), $4, 0)`,
      [where.tenantId, where.outletId, uuid, PAID, `REF-${ulid}`],
    );
    // A foreign tenant has no real menu item: skip that FK for this write only.
    if (!where.realMenu)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
         quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
         fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', 1, $6, 0, $6, '[]'::jsonb,
         'fired', 'served', $7::date)`,
      [
        itemUuid,
        where.tenantId,
        where.outletId,
        uuid,
        where.realMenu ? menuItem : randomUUID(),
        PAID,
        shiftBusinessDate,
      ],
    );
  });
  return { ulid, uuid, itemUuid, itemUlid: uuidToUlid(itemUuid) };
}

/** A live-looking manual refund written straight into the table (a control for isolation). */
async function seedManualIssue(
  order: Order,
  where: Where,
  state: "live" | "rejected" | "cancelled" | "ord09" = "live",
): Promise<void> {
  await asOwnerTenant(where.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, approved_by, cost_idr, status,
         idempotency_key, resolved_at, refund_rejected_at, approval_request_id)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
         'Roti habis, refund manual disetujui', $6, 'manual_refund', $7, 0, $8,
         $9, $10, $11, $12)`,
      [
        randomUUID(),
        where.tenantId,
        where.outletId,
        order.uuid,
        order.itemUuid,
        randomUUID(),
        randomUUID(),
        state === "cancelled" ? "cancelled" : "resolved",
        randomUUID(),
        state === "cancelled" ? null : new Date(),
        state === "rejected" ? new Date() : null,
        state === "ord09" ? randomUUID() : null,
      ],
    );
  });
}

/**
 * Race helper: a manual refund written like the route would, in one transaction:
 * lock the order row, refuse (return false) when a void already exists, else
 * insert the live manual_refund row. Pair with a parallel edge void.
 */
async function seedManualUnlessVoided(order: Order): Promise<boolean> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      "SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenant.tenantId, order.uuid],
    );
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2",
      [tenant.tenantId, order.uuid],
    );
    if (rows[0]!.n > 0) return false;
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, approved_by, cost_idr, status,
         idempotency_key, resolved_at, refund_rejected_at, approval_request_id)
       VALUES ($1, $2, $3, $4, $5, 'complaint', 'complaint',
         'Pelanggan kecewa, refund manual disetujui', $6, 'manual_refund', $7, 0, 'resolved',
         $8, now(), NULL, NULL)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        order.uuid,
        order.itemUuid,
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    );
    return true;
  });
}

// --------------------------------------------------------------------- approvals

/** Approval of the manual refund (ORD route): action refund on the order item. */
async function itemApproval(order: Order): Promise<PosOverrideView> {
  const { override } = await createPosOverride(
    tenantCtx(tenant),
    recorder.userId,
    createPosOverrideSchema.parse({
      outletId: tenant.outletId,
      action: "refund",
      valueIdr: PAID,
      reason: "Refund manual item gagal saji",
      objectType: "order_item",
      objectId: order.itemUlid,
      approval: {
        method: "supervisor_pin",
        approverUserId: supervisor.userId,
        pin: PIN,
      },
    }),
    { idempotencyKey: randomUUID() },
  );
  return override;
}

/** Approval of a cashier refund / cloud void: action on the whole order. */
async function orderApproval(
  order: Order,
  amountIdr: number,
  action: "refund" | "void",
) {
  const overrideId = createUlid();
  const reason = "Pengembalian satu jalur";
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
         requested_by, approved_by, reason, value_idr, object_type, object_id,
         request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'supervisor_pin', 'approved', $5, $6, $7, $8,
         'order', $9, $10, now(), now())`,
      [
        ulidToUuid(overrideId),
        tenant.tenantId,
        tenant.outletId,
        action,
        recorder.userId,
        supervisor.userId,
        reason,
        amountIdr,
        order.ulid,
        pinOverrideFixtureFingerprint({
          requestedBy: recorder.userId,
          outletId: tenant.outletId,
          action,
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: order.ulid,
          approverUserId: supervisor.userId,
        }),
      ],
    ),
  );
  return {
    overrideId: posOverrideIdSchema.parse(overrideId),
    approvedBy: userIdSchema.parse(supervisor.userId),
  };
}

// ---------------------------------------------------------------- the 4 actions

const caller = () => ({
  userId: userIdSchema.parse(recorder.userId),
  deviceId: ids.device,
  expectedVersion: null,
});

/** Cashier refund (service, as in the 980 POS test). */
async function posRefund(order: Order, amountIdr: number) {
  const verified = await orderApproval(order, amountIdr, "refund");
  return refundPosOrder(
    scope(),
    caller(),
    outletIdSchema.parse(tenant.outletId),
    order.ulid,
    {
      idempotencyKey: randomUUID(),
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Pengembalian satu jalur",
      ...verified,
    },
  );
}

/** Cloud cash void of the whole sale. */
async function cloudVoid(order: Order) {
  const verified = await orderApproval(order, PAID, "void");
  return voidPosOrderCorrection(
    scope(),
    caller(),
    outletIdSchema.parse(tenant.outletId),
    order.ulid,
    {
      idempotencyKey: randomUUID(),
      reason: "customer_cancelled",
      reasonNote: "Void satu jalur",
      ...verified,
    },
  );
}

/** Manual per-item refund through the real route, with its own approval. */
async function manualRefund(order: Order) {
  const approved = await itemApproval(order);
  return recorder.client
    .post(`/api/outlets/${tenant.outletId}/orders/${order.ulid}/issues`)
    .set(headers)
    .set(originHeader)
    .send({
      orderItemId: order.itemUlid,
      type: "complaint",
      reason: "complaint",
      reasonNote: "Pelanggan kecewa, refund manual disetujui",
      stationId: ids.barA,
      employeeId: null,
      resolution: "manual_refund",
      voucherId: null,
      approvedBy: supervisor.userId,
      overrideId: approved.id,
      idempotencyKey: `s1042-${randomUUID()}`,
    });
}

// ------------------------------------------------------------------- edge sales

let clock = Date.parse("2026-11-18T09:00:00.000Z");
let numberSeq = 0;

function envelope(
  name: string,
  orderUlid: string,
  sequence: number,
  payload: Record<string, unknown>,
  where: { outlet?: string; tenant?: string } = {},
): EventEnvelope {
  clock += 1_000;
  return {
    id: createUlid(clock),
    tenantId: (where.tenant ?? tenant.tenantId) as EventEnvelope["tenantId"],
    outletId: (where.outlet ?? tenant.outletId) as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: "order",
    aggregateId: orderUlid,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${orderUlid}:${sequence}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  };
}

function edgePaidEvent(orderUlid: string): EventEnvelope {
  numberSeq += 1;
  return envelope("order.paid", orderUlid, 1, {
    orderId: orderUlid,
    outletId: tenant.outletId,
    businessDate: BUSINESS_DATE,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: `E1042-${String(numberSeq).padStart(5, "0")}-${short()}`,
    subtotalIdr: PAID,
    pricesIncludeTax: false,
    paymentMode: "pay_first",
    isTraining: false,
    grossSalesIdr: PAID,
    discountIdr: 0,
    serviceChargeIdr: 0,
    pbjtIdr: 0,
    taxes: [],
    roundingIdr: 0,
    totalIdr: PAID,
    paidCashIdr: PAID,
    paidGatewayIdr: 0,
    paidEdcIdr: 0,
    paidPointsIdr: 0,
    paidDepositIdr: 0,
    tenders: [{ method: "cash", amountIdr: PAID, receivedIdr: PAID }],
    shiftId: null,
    cashierId: recorder.userId,
    deviceId: randomUUID(),
    paidAt: "2034-01-02T03:04:05.000Z",
    lines: [
      {
        menuItemId: menuItem,
        name: "Latte",
        quantity: 1,
        unitPriceIdr: PAID,
        modifiersTotalIdr: 0,
        lineTotalIdr: PAID,
        fireStatus: "fired",
        reservedBusinessDate: BUSINESS_DATE,
        status: "served",
      },
    ],
  });
}

function edgeVoidEvent(order: Order, sequence = 2): EventEnvelope {
  return envelope("order.voided", order.ulid, sequence, {
    orderId: order.ulid,
    outletId: tenant.outletId,
    businessDate: BUSINESS_DATE,
    amountIdr: PAID,
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    requestedBy: recorder.userId,
    approvedBy: supervisor.userId,
    overrideId: createUlid(++clock),
    approvalRequestId: null,
    voidedFinalOrder: true,
    voidId: randomUUID(),
    receiptNumber: `POS1-${String(++numberSeq).padStart(6, "0")}`,
    voidedAt: "2034-01-02T04:00:00.000Z",
  });
}

function linkStore() {
  return createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
}

/** One receive batch through the real link (the apply transaction). */
async function deliver(events: EventEnvelope[]) {
  const link = linkStore();
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

/** An order ingested from an edge node, as a completed cloud order. */
async function edgeSale(): Promise<Order> {
  const ulid = createUlid(++clock);
  await deliver([edgePaidEvent(ulid)]);
  const ingest = await ingestOf(ulid);
  expect(ingest).toMatchObject({ state: "ingested" });
  const itemUuid = await one<string>(
    "SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid LIMIT 1",
    [tenant.tenantId, ulidToUuid(ulid)],
  );
  return {
    ulid,
    uuid: ulidToUuid(ulid),
    itemUuid,
    itemUlid: uuidToUlid(itemUuid),
  };
}

// ------------------------------------------------------------------ DB observers

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

const refundsTotal = (order: Order) =>
  count(
    "SELECT coalesce(sum(amount_idr), 0)::int AS n FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
    [tenant.tenantId, order.uuid],
  );
const voidCount = (order: Order) =>
  count(
    "SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2",
    [tenant.tenantId, order.uuid],
  );
/** Manual refunds that count (route, not cancelled, refund not rejected). */
const manualCount = (order: Order) =>
  count(
    `SELECT count(*)::int AS n FROM order_issues
      WHERE tenant_id = $1 AND order_id = $2 AND resolution = 'manual_refund'
        AND approval_request_id IS NULL AND status <> 'cancelled'
        AND refund_rejected_at IS NULL`,
    [tenant.tenantId, order.uuid],
  );
const approvalUses = (order: Order) =>
  count(
    "SELECT count(*)::int AS n FROM pos_order_approval_uses WHERE tenant_id = $1 AND order_id = $2",
    [tenant.tenantId, order.uuid],
  );

async function ingestOf(orderUlid: string) {
  const { rows } = await owner.query<{ state: string; reason: string | null }>(
    "SELECT state, reason FROM edge_order_ingests WHERE tenant_id = $1 AND order_id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderUlid)],
  );
  return rows[0];
}

/** Money that left for the guest: POS refunds + void amount + manual line refunds. */
async function paidOut(order: Order): Promise<number> {
  return (
    (await refundsTotal(order)) +
    (await voidCount(order)) * PAID +
    (await manualCount(order)) * PAID
  );
}

async function onlyOnePath(order: Order) {
  const paths = [
    (await refundsTotal(order)) > 0,
    (await voidCount(order)) > 0,
    (await manualCount(order)) > 0,
  ].filter(Boolean);
  expect(paths).toHaveLength(1);
  expect(await paidOut(order)).toBeLessThanOrEqual(PAID);
}

const refusedManual = (status: number) => expect(status).toBe(409);
const REFUSED_BY_MANUAL = {
  status: 409,
  code: "REFUND_MANUAL_REFUND_EXISTS",
};

/** An action settled: true when it went through, false when it was refused. */
function settled(result: PromiseSettledResult<unknown>): boolean {
  if (result.status === "rejected") return false;
  const value = result.value as { status?: number } | null;
  return typeof value?.status === "number" ? value.status === 201 : true;
}

// ---------------------------------------------------------------------- set up

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`sr-${short()}`);
  tenantB = await createIsolatedTenant(`sq-${short()}`);
  headers = { Host: tenant.hostname };

  await insertRole(ids.recorderRole, "Kasir Satu Jalur", [
    "kds.remake_comp.record",
    "pos.refund.request",
    "pos.void.request",
    "pos.sale.create",
    "pos.payment.accept",
    "shift.cash.operate",
  ]);
  // Approval authority (ceiling per order) belongs to the role template, so the
  // approver holds the seeded `owner` template of this tenant (no ceiling), as
  // the 980 POS test does in the seeded tenant.
  await withTenant(db, scope(), (tx) =>
    seedTenantRoleTemplates(tx, tenant.tenantId),
  );
  ownerRoleId = await one<string>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenant.tenantId],
  );
  await owner.query(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar A', 'beverage_bar')`,
    [ids.barA, tenant.tenantId, tenant.outletId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Satu Jalur B', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $3 AND id = $4`,
    [
      ids.outletB,
      `SB-${short()}`.toUpperCase(),
      tenant.tenantId,
      tenant.outletId,
    ],
  );

  recorder = await member(ids.recorderRole, "Kasir Satu Jalur");
  supervisor = await member(ownerRoleId, "Supervisor Satu Jalur");
  await setStaffPin(
    tenantCtx(tenant),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  menuItem = await buildMenuItem();

  // A cash void or refund needs the cashier's open shift on a registered device
  // and, for a void, the sale's receipt (port double).
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  const shift = await openPosShift(
    scope(),
    { userId: userIdSchema.parse(recorder.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(10_000_000), idempotencyKey: randomUUID() },
  );
  shiftBusinessDate = await one<string>(
    "SELECT business_date::text AS id FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, shift.id],
  );
  setPosReceiptPort(memoryReceiptPort());

  setAuditWriter(coreAuditWriter);
  const registered = await registerEdgeNode(
    establishScopedTenantContext(tenantCtx(tenant), {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(tenant.outletId)],
    }),
    actor,
    {
      outletId: tenant.outletId,
      role: "primary",
      label: `Utama Satu Jalur ${randomBytes(2).toString("hex")}`,
    },
  );
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

afterAll(() => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
});

/** Issues a receipt for any order on demand, like the real allocator would have at sale time. */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  const issue = (orderId: string, outletId: string, at: Date) => {
    const existing = byOrder.get(orderId);
    if (existing) return existing;
    sequence += 1;
    const receipt = {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      outletId,
      orderId,
      deviceId: ids.device,
      number: `S1042-${String(sequence).padStart(6, "0")}`,
      sequenceNumber: sequence,
      status: "issued",
      issuedAt: at.toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    } as unknown as PosReceipt;
    byOrder.set(orderId, receipt);
    return receipt;
  };
  return {
    async issueForSale(_tx, _context, input) {
      return issue(input.orderId, input.outletId, input.at);
    },
    async findForOrder(_tx, _context, orderId) {
      return issue(orderId, tenant.outletId, new Date());
    },
    async voidForOrder(_tx, _context, input) {
      const found = issue(input.orderId, tenant.outletId, input.at);
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

// ============================================================================
// Controls: each lone action works, so a refusal below is not an unrelated 4xx.
// ============================================================================

describe("legend-1042 controls: each money path works on its own", () => {
  it("a lone manual refund of a cloud sale is accepted (201) and pays the line", async () => {
    const order = await cloudSale();
    expect((await manualRefund(order)).status).toBe(201);
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("a lone cashier refund is accepted", async () => {
    const order = await cloudSale();
    const result = await posRefund(order, 20_000);
    expect(Number(result.amountIdr)).toBe(20_000);
    expect(await refundsTotal(order)).toBe(20_000);
  });

  it("a lone cloud cash void is accepted", async () => {
    const order = await cloudSale();
    await cloudVoid(order);
    expect(await voidCount(order)).toBe(1);
  });

  it("a lone edge void of an ingested sale is recorded", async () => {
    const order = await edgeSale();
    await deliver([edgeVoidEvent(order)]);
    expect(await voidCount(order)).toBe(1);
    expect(await ingestOf(order.ulid)).toMatchObject({ state: "voided" });
  });

  it("a lone manual refund of an ingested edge sale is refused (409 EDGE_ORDER_CORRECTION_BLOCKED): nothing is paid", async () => {
    const order = await edgeSale();
    const res = await manualRefund(order);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body ?? {})).toMatch(
      /EDGE_ORDER_CORRECTION_BLOCKED/,
    );
    expect(await manualCount(order)).toBe(0);
    expect(await issueCount(order)).toBe(0);
    expect(await approvalUses(order)).toBe(0);
    expect(await paidOut(order)).toBe(0);
    expect(await ingestOf(order.ulid)).toMatchObject({ state: "ingested" });
  });

  it("the edge refusal also holds after the edge void (state voided): 409, still exactly one payout", async () => {
    const order = await edgeSale();
    await deliver([edgeVoidEvent(order)]);
    expect(await ingestOf(order.ulid)).toMatchObject({ state: "voided" });
    const res = await manualRefund(order);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body ?? {})).toMatch(
      /EDGE_ORDER_CORRECTION_BLOCKED/,
    );
    expect(await manualCount(order)).toBe(0);
    expect(await issueCount(order)).toBe(0);
    expect(await voidCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("a cloud (non-edge) sale is not blocked by the edge rule, even next to an edge sale in the same outlet", async () => {
    const edge = await edgeSale();
    const order = await cloudSale();
    const res = await manualRefund(order);
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body ?? {})).not.toMatch(
      /EDGE_ORDER_CORRECTION_BLOCKED/,
    );
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
    // the edge sale next to it stays refused and untouched
    expect((await manualRefund(edge)).status).toBe(409);
    expect(await paidOut(edge)).toBe(0);
  });
});

// ============================================================================
// Pair 1: cashier refund x manual refund
// ============================================================================

describe("legend-1042 cashier refund x manual refund", () => {
  it("manual refund first: the cashier refund is refused and nothing is spent", async () => {
    const order = await cloudSale();
    expect((await manualRefund(order)).status).toBe(201);
    // The manual refund spent its own approval; the refused refund spends none.
    const usesAfterManual = await approvalUses(order);
    await expect(posRefund(order, 10_000)).rejects.toMatchObject(
      REFUSED_BY_MANUAL,
    );
    expect(await refundsTotal(order)).toBe(0);
    expect(await approvalUses(order)).toBe(usesAfterManual);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("cashier refund first: the manual refund is refused (409) and its approval stays unspent", async () => {
    const order = await cloudSale();
    await posRefund(order, 10_000);
    const res = await manualRefund(order);
    refusedManual(res.status);
    expect(await manualCount(order)).toBe(0);
    expect(await refundsTotal(order)).toBe(10_000);
    expect(await paidOut(order)).toBeLessThanOrEqual(PAID);
  });

  it("in parallel exactly one of cashier refund and manual refund wins", async () => {
    const order = await cloudSale();
    const results = await Promise.allSettled([
      posRefund(order, 10_000),
      manualRefund(order),
    ]);
    expect(results.filter(settled)).toHaveLength(1);
    await onlyOnePath(order);
  });
});

// ============================================================================
// Pair 2: cloud void x manual refund
// ============================================================================

describe("legend-1042 cloud void x manual refund", () => {
  it("manual refund first: the cloud void is refused and nothing is voided", async () => {
    const order = await cloudSale();
    expect((await manualRefund(order)).status).toBe(201);
    const usesAfterManual = await approvalUses(order);
    await expect(cloudVoid(order)).rejects.toMatchObject(REFUSED_BY_MANUAL);
    expect(await voidCount(order)).toBe(0);
    expect(await approvalUses(order)).toBe(usesAfterManual);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("void first (G1): the manual refund is refused (409), no second payout", async () => {
    const order = await cloudSale();
    await cloudVoid(order);
    const res = await manualRefund(order);
    refusedManual(res.status);
    expect(await manualCount(order)).toBe(0);
    expect(await voidCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("in parallel exactly one of cloud void and manual refund wins", async () => {
    const order = await cloudSale();
    const results = await Promise.allSettled([
      cloudVoid(order),
      manualRefund(order),
    ]);
    expect(results.filter(settled)).toHaveLength(1);
    await onlyOnePath(order);
  });
});

// ============================================================================
// Pair 3: edge void x manual refund
// ============================================================================

describe("legend-1042 edge void x manual refund", () => {
  it("manual refund first (G2): the edge void is refused, writes no void row and leaves the ledger ingested", async () => {
    const order = await edgeSale();
    await seedManualIssue(order, here());
    const event = edgeVoidEvent(order);
    await deliver([event]).catch(() => undefined);
    expect(await voidCount(order)).toBe(0);
    expect(await ingestOf(order.ulid)).toMatchObject({
      state: "ingested",
      reason: expect.stringMatching(/manual_refund/),
    });
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("edge void first (G1): the manual refund is refused (409), no second payout", async () => {
    const order = await edgeSale();
    await deliver([edgeVoidEvent(order)]);
    expect(await voidCount(order)).toBe(1);
    const res = await manualRefund(order);
    refusedManual(res.status);
    expect(await manualCount(order)).toBe(0);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("in parallel exactly one of edge void and a manual refund (locked seed) wins (G2/G3)", async () => {
    const order = await edgeSale();
    const [, seeded] = await Promise.all([
      deliver([edgeVoidEvent(order)]).catch(() => undefined),
      seedManualUnlessVoided(order),
    ]);
    // `deliver` resolves with undefined whatever the ingest decided, so count
    // the winners in the ledger instead.
    expect(seeded ? 1 : 0).toBe((await manualCount(order)) > 0 ? 1 : 0);
    expect(seeded ? 0 : 1).toBe(await voidCount(order));
    await onlyOnePath(order);
  });

  it("in parallel the edge void wins over the route's manual refund, which is refused 409 (F2)", async () => {
    const order = await edgeSale();
    const [, res] = await Promise.all([
      deliver([edgeVoidEvent(order)]).catch(() => undefined),
      manualRefund(order),
    ]);
    expect(res.status).toBe(409);
    expect(await manualCount(order)).toBe(0);
    expect(await voidCount(order)).toBe(1);
    await onlyOnePath(order);
  });

  it("repeated parallel rounds never end with both a void and a manual refund (G3)", async () => {
    for (let round = 0; round < 3; round += 1) {
      const order = await edgeSale();
      await Promise.allSettled([
        deliver([edgeVoidEvent(order)]),
        seedManualUnlessVoided(order),
      ]);
      await onlyOnePath(order);
    }
  });
});

// ============================================================================
// Edge replay (G4)
// ============================================================================

describe("legend-1042 edge order.voided replay", () => {
  it("a replay of an applied void is a no-op: one void row, no manual refund", async () => {
    const order = await edgeSale();
    const event = edgeVoidEvent(order);
    await deliver([event]);
    await deliver([event]);
    await deliver([event, event]);
    expect(await voidCount(order)).toBe(1);
    expect(await manualCount(order)).toBe(0);
    expect(await ingestOf(order.ulid)).toMatchObject({ state: "voided" });
  });

  it("after a void, a manual refund attempt and a replay still leave exactly one payout", async () => {
    const order = await edgeSale();
    const event = edgeVoidEvent(order);
    await deliver([event]);
    refusedManual((await manualRefund(order)).status);
    await deliver([event]); // must not throw
    expect(await voidCount(order)).toBe(1);
    expect(await manualCount(order)).toBe(0);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("a void refused because of a manual refund stays refused on replay: no throw, no void row, one manual refund", async () => {
    const order = await edgeSale();
    await seedManualIssue(order, here());
    const event = edgeVoidEvent(order);
    await deliver([event]).catch(() => undefined);
    await expect(deliver([event])).resolves.toBeUndefined();
    await expect(deliver([event, event])).resolves.toBeUndefined();
    expect(await voidCount(order)).toBe(0);
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("a different, later void event of the same sale is refused while a manual refund is live", async () => {
    const order = await edgeSale();
    await seedManualIssue(order, here());
    await deliver([edgeVoidEvent(order, 2)]).catch(() => undefined);
    await deliver([edgeVoidEvent(order, 3)]).catch(() => undefined);
    expect(await voidCount(order)).toBe(0);
    expect(await paidOut(order)).toBe(PAID);
  });
});

// ============================================================================
// The guest never receives more than paid
// ============================================================================

describe("legend-1042 the guest never receives more than paid", () => {
  it("a Rp10.000 cashier refund blocks the manual refund and the void: payout stays Rp10.000", async () => {
    const order = await cloudSale();
    await posRefund(order, 10_000);
    refusedManual((await manualRefund(order)).status);
    await expect(cloudVoid(order)).rejects.toBeTruthy();
    expect(await paidOut(order)).toBe(10_000);
  });

  it("a manual refund blocks the cashier refund, the cloud void and the edge void: payout is exactly the paid amount", async () => {
    const order = await cloudSale();
    expect((await manualRefund(order)).status).toBe(201);
    await expect(posRefund(order, 1)).rejects.toMatchObject(REFUSED_BY_MANUAL);
    await expect(cloudVoid(order)).rejects.toMatchObject(REFUSED_BY_MANUAL);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("an edge void blocks every other path on the ingested sale: payout is exactly the paid amount", async () => {
    const order = await edgeSale();
    await deliver([edgeVoidEvent(order)]);
    refusedManual((await manualRefund(order)).status);
    await expect(posRefund(order, 10_000)).rejects.toBeTruthy();
    await expect(cloudVoid(order)).rejects.toBeTruthy();
    expect(await paidOut(order)).toBe(PAID);
  });

  it("a three-way race (refund, void, manual) on one sale pays out once", async () => {
    const order = await cloudSale();
    const results = await Promise.allSettled([
      posRefund(order, 10_000),
      cloudVoid(order),
      manualRefund(order),
    ]);
    expect(results.filter(settled)).toHaveLength(1);
    await onlyOnePath(order);
  });
});

// ============================================================================
// Controls that the new rule is not too broad (restrictive, but exact)
// ============================================================================

describe("legend-1042 only a live manual refund of the same order blocks", () => {
  it("a rejected, cancelled or ORD-09 manual issue does not block the edge void", async () => {
    for (const state of ["rejected", "cancelled", "ord09"] as const) {
      const order = await edgeSale();
      await seedManualIssue(order, here(), state);
      await deliver([edgeVoidEvent(order)]);
      expect(await voidCount(order)).toBe(1);
    }
  });

  it("a live manual refund of ANOTHER order (same outlet) blocks neither refund, void nor edge void here", async () => {
    const other = await cloudSale();
    await seedManualIssue(other, here());
    const refundTarget = await cloudSale();
    expect(Number((await posRefund(refundTarget, 10_000)).amountIdr)).toBe(
      10_000,
    );
    const voidTarget = await cloudSale();
    await cloudVoid(voidTarget);
    expect(await voidCount(voidTarget)).toBe(1);
    const edgeTarget = await edgeSale();
    await deliver([edgeVoidEvent(edgeTarget)]);
    expect(await voidCount(edgeTarget)).toBe(1);
  });

  it("a live manual refund in ANOTHER OUTLET of the tenant blocks nothing here", async () => {
    const elsewhere: Where = {
      tenantId: tenant.tenantId,
      outletId: ids.outletB,
      realMenu: true,
    };
    const other = await cloudSale(elsewhere);
    await seedManualIssue(other, elsewhere);
    const refundTarget = await cloudSale();
    expect(Number((await posRefund(refundTarget, 10_000)).amountIdr)).toBe(
      10_000,
    );
    const edgeTarget = await edgeSale();
    await deliver([edgeVoidEvent(edgeTarget)]);
    expect(await voidCount(edgeTarget)).toBe(1);
  });

  it("a live manual refund in ANOTHER TENANT blocks nothing here", async () => {
    const elsewhere: Where = {
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
      realMenu: false,
    };
    const other = await cloudSale(elsewhere);
    await seedManualIssue(other, elsewhere);
    const refundTarget = await cloudSale();
    expect(Number((await posRefund(refundTarget, 10_000)).amountIdr)).toBe(
      10_000,
    );
    const edgeTarget = await edgeSale();
    await deliver([edgeVoidEvent(edgeTarget)]);
    expect(await voidCount(edgeTarget)).toBe(1);
  });
});

// ============================================================================
// A parked edge void (edge_deferred_events) blocks the manual refund
//
// An edge `order.voided` (voidedFinalOrder true) that the cloud could not apply
// yet (refused for now or for good) is kept in `edge_deferred_events`. The
// pos_order_voids row does not exist and the ledger stays `ingested`, but the
// edge already voided the sale at the till, so the guest may already hold the
// money back. A manual refund of that order must be refused (409): restrictive,
// when unsure, refuse.
//
// Assumptions: the parked row is seeded straight into the table (like the
// deferred-events test does for its isolation row), parked_reason 'deferred',
// the envelope carries payload.orderId = the order's ULID and aggregate_id the
// same ULID. A parked void that is NOT a final void (voidedFinalOrder false),
// or that belongs to another order or another tenant, must not block.
// ============================================================================

/** Parks an edge `order.voided` of `order` in edge_deferred_events (ledger untouched). */
async function parkVoid(
  order: Order,
  options: {
    voidedFinalOrder?: boolean;
    sequence?: number;
    forTenant?: IsolatedTenant;
  } = {},
): Promise<void> {
  const forTenant = options.forTenant ?? tenant;
  const event = edgeVoidEvent(order, options.sequence ?? 2);
  const payload = event.payload as Record<string, unknown>;
  payload.voidedFinalOrder = options.voidedFinalOrder ?? true;
  // The payload contract: only a final-sale void carries a void record.
  if (payload.voidedFinalOrder === false) payload.voidId = null;
  const envelope = { ...event, tenantId: forTenant.tenantId };
  await asOwnerTenant(forTenant.tenantId, async (client) => {
    // A foreign tenant has no node or outlet of ours: skip those FKs for this write.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO edge_deferred_events
         (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id,
          aggregate_sequence, event_name, parked_reason, envelope)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'order', $5, $6, 'order.voided',
         'deferred', $7::jsonb)`,
      [
        forTenant.tenantId,
        forTenant.outletId,
        node.scope.edgeNodeId,
        ulidToUuid(event.id),
        order.ulid,
        event.sequence,
        JSON.stringify(envelope),
      ],
    );
  });
}

const deferredCount = (order: Order) =>
  count(
    `SELECT count(*)::int AS n FROM edge_deferred_events
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event_name = 'order.voided'`,
    [tenant.tenantId, order.ulid],
  );
const issueCount = (order: Order) =>
  count(
    "SELECT count(*)::int AS n FROM order_issues WHERE tenant_id = $1 AND order_id = $2",
    [tenant.tenantId, order.uuid],
  );

describe("legend-1042 a parked edge void blocks the manual refund", () => {
  it("a parked final void: the manual refund is refused (409), nothing is paid, the ledger stays ingested", async () => {
    const order = await edgeSale();
    await parkVoid(order);
    expect(await deferredCount(order)).toBe(1);
    expect(await voidCount(order)).toBe(0);
    expect(await ingestOf(order.ulid)).toMatchObject({ state: "ingested" });

    const res = await manualRefund(order);
    refusedManual(res.status);
    expect(await manualCount(order)).toBe(0);
    expect(await issueCount(order)).toBe(0);
    expect(await refundsTotal(order)).toBe(0);
    expect(await paidOut(order)).toBe(0);
    // The refusal changes nothing around it.
    expect(await deferredCount(order)).toBe(1);
    expect(await voidCount(order)).toBe(0);
    expect(await ingestOf(order.ulid)).toMatchObject({ state: "ingested" });
  });

  it("a parked final void stays blocking on a second attempt", async () => {
    const order = await edgeSale();
    await parkVoid(order, { sequence: 3 });
    refusedManual((await manualRefund(order)).status);
    refusedManual((await manualRefund(order)).status);
    expect(await issueCount(order)).toBe(0);
    expect(await paidOut(order)).toBe(0);
  });

  it("control: a parked void that is not a final void (voidedFinalOrder false) does not block", async () => {
    // F2: an edge sale is refused anyway, so the control uses a cloud sale.
    const order = await cloudSale();
    await parkVoid(order, { voidedFinalOrder: false });
    expect(await deferredCount(order)).toBe(1);
    expect((await manualRefund(order)).status).toBe(201);
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("control: a parked final void of ANOTHER order (same outlet) does not block this order", async () => {
    const other = await edgeSale();
    await parkVoid(other);
    const order = await cloudSale();
    expect((await manualRefund(order)).status).toBe(201);
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
    // ...while the other order stays blocked.
    refusedManual((await manualRefund(other)).status);
    expect(await manualCount(other)).toBe(0);
  });

  it("control: a parked final void in ANOTHER TENANT (same order id) does not block this order", async () => {
    const order = await cloudSale();
    await parkVoid(order, { forTenant: tenantB });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1 AND aggregate_id = $2",
        [tenantB.tenantId, order.ulid],
      ),
    ).toBe(1);
    expect((await manualRefund(order)).status).toBe(201);
    expect(await manualCount(order)).toBe(1);
    expect(await paidOut(order)).toBe(PAID);
  });

  it("control: with no parked void the lone manual refund is accepted (the refusal is not an unrelated 4xx)", async () => {
    const order = await cloudSale();
    expect(await deferredCount(order)).toBe(0);
    expect((await manualRefund(order)).status).toBe(201);
    expect(await paidOut(order)).toBe(PAID);
  });
});
