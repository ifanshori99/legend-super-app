// Remake / comp / complaint log (bead legend-4b5; PRD v1.7 §6 C `order_issues`,
// F41 "Remake & Comp", KDS-07, R25). Contract: @starter/shared/kitchen
// `reportOrderIssue` + `listOrderIssues`.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in two fresh
// isolated tenants. The recipe consumer runs through `withTenant` as the worker
// delivers a cloud-sync event; the `order_issue.recorded` events are read back
// from the outbox.
//
// Assumptions where the brief is silent:
// - A comp of a line that is still billed (not voided at kitchen/POS) is refused
//   (422): the sale deduction of `order.paid` already drew that line, so a
//   second draw would count the dish twice. A comp of a voided line emits the
//   event and draws once.
// - A remake always emits the event (the kitchen cooks the line again).
// - A manual refund is refused (422): an approver id alone is no proof and no
//   approval flow exists yet.
import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import {
  orderIssueSchema,
  orderIssueViewSchema,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();
// 18 g beans x Rp100 + 200 ml milk x Rp20 = Rp5.800 per cup.
const CUP_COST = 5800;

const ids = {
  recorderRole: randomUUID(),
  supervisorRole: randomUUID(),
  otherRole: randomUUID(),
  outletB: randomUUID(),
  barA: randomUUID(),
  kitchenA: randomUUID(),
  category: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let recorder: Member; // kds.remake_comp.record, tenant scope
let barista: Member; // kds.remake_comp.record on bar A only
let outletBRecorder: Member; // kds.remake_comp.record on outlet B only
let supervisor: Member; // pos.refund.approve, tenant scope
let nobody: Member; // role without kds.remake_comp.record
let tenantBRecorder: Member;
let cookUserId: string; // the staff member a remake is attributed to
let gramId: string;
let mlId: string;
let cupId: string;

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.tenantId,
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2032, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  outletIds = "*",
  asAppRole = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outletIds],
    );
    // The test owner is a superuser, which bypasses RLS: read as the app role.
    if (asAppRole) await client.query("SET LOCAL ROLE legend_app");
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

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

/** A latte kit in a fresh sale location of the tenant's outlet. */
async function buildKit() {
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenant.tenantId, tenant.outletId, `Bar ${short()}`],
  );
  const item = (name: string, uom: string) =>
    one<string>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
      [tenant.tenantId, `${name} ${short()}`, uom],
    );
  const beans = await item("Biji Kopi", gramId);
  const milk = await item("Susu", mlId);
  for (const [itemId, quantity, cost] of [
    [beans, "1000.0000", "100.0000"],
    [milk, "10000.0000", "20.0000"],
  ] as const)
    await recordStockMovement(tenantContext(), {
      outletId: outletIdSchema.parse(tenant.outletId) as OutletId,
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
    [tenant.tenantId, tenant.brandId, `Latte ${short()}`, cupId, cookUserId],
  );
  for (const [index, [itemId, qty, uom]] of (
    [
      [beans, "18.0000", gramId],
      [milk, "200.0000", mlId],
    ] as const
  ).entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenant.tenantId, recipe, index, itemId, qty, uom],
    );
  const menuItem = await one<string>(
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
  return { location, menuItem };
}

type Order = {
  ulid: string;
  uuid: string;
  itemUlid: string;
  itemUuid: string;
  businessDate: string;
};

/** A paid order with one latte line; `voided` marks the line voided. */
async function seedOrder(
  menuItemId: string,
  options: { quantity?: number; voided?: boolean; outletId?: string } = {},
): Promise<Order> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const itemUlid = createUlid();
  const itemUuid = ulidToUuid(itemUlid);
  const businessDate = nextDate();
  const outletId = options.outletId ?? tenant.outletId;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 50000, 0, 0, 0, 0, 50000,
               'completed', $5, now())`,
      [
        uuid,
        tenant.tenantId,
        outletId,
        `ISS-${randomUUID().slice(0, 12)}`,
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', $6, 0, 0, 0, '[]'::jsonb,
               'fired', $7, $8)`,
      [
        itemUuid,
        tenant.tenantId,
        outletId,
        uuid,
        menuItemId,
        options.quantity ?? 2,
        options.voided ? "voided" : "served",
        businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [uuid, tenant.tenantId, outletId],
    );
  });
  return { ulid, uuid, itemUlid, itemUuid, businessDate };
}

function paidEvent(order: Order): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: "order.paid",
    version: 1,
    aggregateType: "order",
    aggregateId: order.ulid,
    sequence: 1,
    occurredAt: iso(),
    actor: { type: "system" },
    idempotencyKey: `order.paid:${order.ulid}`,
    payloadSchemaRef: "order.paid.v1",
    payload: orderPaidPayloadSchema.parse({
      orderId: order.ulid,
      outletId: tenant.outletId,
      businessDate: order.businessDate,
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

async function deliver(event: EventEnvelope) {
  const context = tenantContext();
  return withTenant(db, context, (tx) =>
    deliverRecipeDeductionEvent(context, event, tx),
  );
}

/** The `order_issue.recorded` events the API appended for one issue. */
async function issueEvents(issueId: string): Promise<EventEnvelope[]> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
    client.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'order_issue.recorded'`,
      [tenant.tenantId, issueId],
    ),
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function deductionsOf(order: Order) {
  const { rows } = await owner.query<{
    kind: string;
    status: string;
    cost_idr: string | null;
  }>(
    `SELECT kind, status, cost_idr::text AS cost_idr FROM recipe_deductions
     WHERE tenant_id = $1 AND source_id = $2 ORDER BY created_at, id`,
    [tenant.tenantId, order.ulid],
  );
  return rows;
}

function api(who: Member, forHeaders = headers, outletId = tenant.outletId) {
  return {
    report: (orderId: string, body: Record<string, unknown>) =>
      who.client
        .post(`/api/outlets/${outletId}/orders/${orderId}/issues`)
        .set(forHeaders)
        .set(originHeader)
        .send(body),
    list: (query = "") =>
      who.client
        .get(`/api/outlets/${outletId}/order-issues${query}`)
        .set(forHeaders)
        .set(originHeader),
  };
}

function issueBody(order: Order, patch: Record<string, unknown> = {}) {
  return {
    orderItemId: order.itemUlid,
    type: "remake",
    reason: "quality",
    reasonNote: "Rasa kurang pas, dibuat ulang",
    stationId: ids.barA,
    employeeId: cookUserId,
    resolution: null,
    voucherId: null,
    approvedBy: null,
    idempotencyKey: `iss-${randomUUID()}`,
    ...patch,
  };
}

let kit: Awaited<ReturnType<typeof buildKit>>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`iss-${short()}`);
  tenantB = await createIsolatedTenant(`issb-${short()}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.recorderRole,
    "Pencatat Remake",
    ["kds.remake_comp.record"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenant.tenantId,
    ids.supervisorRole,
    "Supervisor Refund",
    ["pos.refund.approve"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenant.tenantId,
    ids.otherRole,
    "Tanpa Remake",
    ["order.view"],
    ["tenant"],
  );
  const roleB = randomUUID();
  await insertRole(
    tenantB.tenantId,
    roleB,
    "Pencatat B",
    ["kds.remake_comp.record"],
    ["tenant"],
  );

  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Issue B', 'Jl. Uji 2', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $3 AND id = $4`,
    [
      ids.outletB,
      `IB-${short()}`.toUpperCase(),
      tenant.tenantId,
      tenant.outletId,
    ],
  );
  for (const [id, name, type] of [
    [ids.barA, "Bar A", "beverage_bar"],
    [ids.kitchenA, "Dapur A", "hot_kitchen"],
  ])
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenant.tenantId, tenant.outletId, name, type],
    );

  recorder = await member(
    tenant,
    ids.recorderRole,
    { type: "tenant", id: null },
    "Pencatat",
  );
  barista = await member(
    tenant,
    ids.recorderRole,
    { type: "station", id: ids.barA },
    "Barista",
  );
  outletBRecorder = await member(
    tenant,
    ids.recorderRole,
    { type: "outlet", id: ids.outletB },
    "Pencatat Outlet B",
  );
  supervisor = await member(
    tenant,
    ids.supervisorRole,
    { type: "tenant", id: null },
    "Supervisor",
  );
  nobody = await member(
    tenant,
    ids.otherRole,
    { type: "tenant", id: null },
    "Tanpa Akses",
  );
  tenantBRecorder = await member(
    tenantB,
    roleB,
    { type: "tenant", id: null },
    "Pencatat Tenant B",
  );
  // The staff member the remake is attributed to: an assigned user of the tenant.
  cookUserId = (
    await member(tenant, ids.otherRole, { type: "tenant", id: null }, "Koki")
  ).userId;

  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenant.tenantId, `${code}${short()}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  cupId = await uom("cup");
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Issue Uji', 0)",
    [ids.category, tenant.tenantId, tenant.brandId],
  );
  kit = await buildKit();
});

afterAll(async () => {
  // order_issues rows stay in the disposable database (like KDS history).
});

describe("reportOrderIssue: remake", () => {
  it("stores the issue with a server-computed cost and draws stock a second time", async () => {
    const order = await seedOrder(kit.menuItem, { quantity: 2 });
    await deliver(paidEvent(order));
    const res = await api(recorder).report(order.ulid, issueBody(order));
    expect(res.status).toBe(201);
    const issue = orderIssueSchema.parse(res.body.data);
    expect(issue).toMatchObject({
      type: "remake",
      reason: "quality",
      status: "open",
      orderId: order.ulid,
      orderItemId: order.itemUlid,
      stationId: ids.barA,
      employeeId: cookUserId,
      reportedBy: recorder.userId,
      costIdr: 2 * CUP_COST,
    });

    const events = await issueEvents(issue.id);
    expect(events).toHaveLength(1);
    await deliver(events[0]!);
    const deductions = await deductionsOf(order);
    // Order-insensitive: created_at follows the DB clock, which can step back.
    expect(deductions.map((d) => [d.kind, d.status]).sort()).toEqual([
      ["remake", "posted"],
      ["sale", "posted"],
    ]);
    expect(Number(deductions.find((d) => d.kind === "remake")!.cost_idr)).toBe(
      2 * CUP_COST,
    );
  });

  it("ignores a client-sent costIdr (strict contract)", async () => {
    const order = await seedOrder(kit.menuItem);
    const res = await api(recorder).report(
      order.ulid,
      issueBody(order, { costIdr: 1 }),
    );
    expect(res.status).toBe(422);
  });

  it("needs the staff member for a remake", async () => {
    const order = await seedOrder(kit.menuItem);
    const res = await api(recorder).report(
      order.ulid,
      issueBody(order, { employeeId: null }),
    );
    expect(res.status).toBe(422);
  });

  it("refuses an employee who is not staff of this tenant", async () => {
    const order = await seedOrder(kit.menuItem);
    const res = await api(recorder).report(
      order.ulid,
      issueBody(order, { employeeId: tenantBRecorder.userId }),
    );
    expect(res.status).toBe(422);
  });

  it("a complaint is recorded without any stock event", async () => {
    const order = await seedOrder(kit.menuItem);
    const res = await api(recorder).report(
      order.ulid,
      issueBody(order, { type: "complaint", reason: "complaint" }),
    );
    expect(res.status).toBe(201);
    expect(await issueEvents(res.body.data.id)).toHaveLength(0);
  });
});

describe("reportOrderIssue: comp never deducts twice", () => {
  it("a comp of a still-billed line is refused (422) and stores nothing", async () => {
    const order = await seedOrder(kit.menuItem, { quantity: 1 });
    await deliver(paidEvent(order));
    const res = await api(recorder).report(
      order.ulid,
      issueBody(order, { type: "comp", reason: "late" }),
    );
    expect(res.status).toBe(422);
    const { rows } = await owner.query(
      "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
      [tenant.tenantId, order.itemUuid],
    );
    expect(rows).toHaveLength(0);
    expect((await deductionsOf(order)).map((d) => d.kind)).toEqual(["sale"]);
  });

  it("a comp of a voided line draws the stock once, and a second comp conflicts", async () => {
    const order = await seedOrder(kit.menuItem, { quantity: 1, voided: true });
    await deliver(paidEvent(order)); // the voided line is not in the sale
    const res = await api(recorder).report(
      order.ulid,
      issueBody(order, { type: "comp", reason: "wrong_order" }),
    );
    expect(res.status).toBe(201);
    const events = await issueEvents(res.body.data.id);
    expect(events).toHaveLength(1);
    await deliver(events[0]!);
    await deliver(events[0]!); // re-delivery is a no-op
    const deductions = await deductionsOf(order);
    expect(deductions.filter((d) => d.kind === "comp")).toHaveLength(1);
    expect(deductions.filter((d) => d.kind === "sale")).toHaveLength(1);
    expect(
      deductions.filter((d) => d.status === "posted" && d.kind === "sale"),
    ).toHaveLength(0);

    const again = await api(recorder).report(
      order.ulid,
      issueBody(order, { type: "comp", reason: "wrong_order" }),
    );
    expect(again.status).toBe(409);
  });
});

describe("reportOrderIssue: concurrent comps and idempotency", () => {
  it("eight concurrent comps of one voided line end in one 201 and seven 409", async () => {
    const order = await seedOrder(kit.menuItem, { quantity: 1, voided: true });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api(recorder).report(
          order.ulid,
          issueBody(order, { type: "comp", reason: "wrong_order" }),
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      201, 409, 409, 409, 409, 409, 409, 409,
    ]);
    const { rows } = await owner.query(
      "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2 AND type = 'comp'",
      [tenant.tenantId, order.itemUuid],
    );
    expect(rows).toHaveLength(1);
  });

  it("a resend with the same key returns the stored row and no second event", async () => {
    const order = await seedOrder(kit.menuItem);
    const body = issueBody(order, { idempotencyKey: `resend-${short()}-key` });
    const first = await api(recorder).report(order.ulid, body);
    const again = await api(recorder).report(order.ulid, body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.data).toEqual(first.body.data);
    expect(await issueEvents(first.body.data.id)).toHaveLength(1);
    const { rows } = await owner.query(
      "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
      [tenant.tenantId, order.itemUuid],
    );
    expect(rows).toHaveLength(1);
  });

  it("concurrent resends of one key store a single row", async () => {
    const order = await seedOrder(kit.menuItem);
    const body = issueBody(order, { idempotencyKey: `race-${short()}-key` });
    const results = await Promise.all(
      [0, 1].map(() => api(recorder).report(order.ulid, body)),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[1]!.body.data.id).toBe(results[0]!.body.data.id);
    const { rows } = await owner.query(
      "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
      [tenant.tenantId, order.itemUuid],
    );
    expect(rows).toHaveLength(1);
  });

  it("a key reused for another order line conflicts (409)", async () => {
    const first = await seedOrder(kit.menuItem);
    const second = await seedOrder(kit.menuItem);
    const key = `reuse-${short()}-key`;
    expect(
      (
        await api(recorder).report(
          first.ulid,
          issueBody(first, { idempotencyKey: key }),
        )
      ).status,
    ).toBe(201);
    const res = await api(recorder).report(
      second.ulid,
      issueBody(second, { idempotencyKey: key }),
    );
    expect(res.status).toBe(409);
  });
});

// R25 (legend-uyw0v): a supervisor id is no proof. The accepted path (a real,
// single-use approval) is in order-issues-manual-refund-approval-980.test.ts.
describe("reportOrderIssue: R25 manual refund without an approval is refused", () => {
  const refund = (order: Order, approvedBy: string | null) =>
    issueBody(order, {
      type: "complaint",
      reason: "complaint",
      employeeId: null,
      resolution: "manual_refund",
      approvedBy,
      reasonNote: "Pelanggan kecewa, refund manual disetujui",
    });

  it("refuses a manual refund with a valid supervisor id but no override (403)", async () => {
    const order = await seedOrder(kit.menuItem);
    const res = await api(recorder).report(
      order.ulid,
      refund(order, supervisor.userId),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("persetujuan");
  });

  it("refuses an unprivileged approver and a self-approval alike", async () => {
    const order = await seedOrder(kit.menuItem);
    expect(
      (await api(recorder).report(order.ulid, refund(order, nobody.userId)))
        .status,
    ).toBe(403);
    expect(
      (await api(recorder).report(order.ulid, refund(order, recorder.userId)))
        .status,
    ).toBe(403);
    const { rows } = await owner.query(
      "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
      [tenant.tenantId, order.itemUuid],
    );
    expect(rows).toHaveLength(0);
  });
});

// legend-o8quo: the voucher and the swap item a staff member names must belong
// to this tenant, and a voucher from a promotion must be valid at this outlet.
// Assumptions where the brief is silent:
// - Refusal is 422 and nothing is stored (no order_issues row, no event).
// - A promotion's outlet scope: `only` = allowlist (an enabled row for the
//   outlet includes it), `all_except` = opt-out (an enabled=false row for the
//   outlet excludes it); a voucher without a promotion is checked by tenant only.
describe("reportOrderIssue: voucher and swap item belong to this tenant (legend-o8quo)", () => {
  const resolveWith = (
    order: Order,
    patch: Record<string, unknown>,
  ): Record<string, unknown> =>
    issueBody(order, {
      type: "complaint",
      reason: "complaint",
      employeeId: null,
      reasonNote: "Pelanggan kecewa, diberi kompensasi",
      ...patch,
    });

  async function seedVoucher(
    forTenantId: string,
    promotionId: string | null,
  ): Promise<string> {
    return one<string>(
      `INSERT INTO vouchers (tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, NULL, $3, 'manual', 10000, now() - interval '1 hour', NULL)
       RETURNING id`,
      [
        forTenantId,
        promotionId,
        createHash("sha256").update(randomUUID()).digest("hex"),
      ],
    );
  }

  async function seedPromotion(
    outletScope: "only" | "all_except",
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, voucher_required, starts_at,
          conditions, benefit, stack_group, stackable, priority, outlet_scope)
       VALUES ($1, $2, $3, 'Uji', 'active', false, now() - interval '2 hours',
               '[]'::jsonb, $4, $5, true, 0, $6)`,
      [
        id,
        tenant.tenantId,
        `Promo Issue ${id.slice(0, 8)}`,
        JSON.stringify({
          kind: "percent_off",
          percentBp: 1000,
          maxDiscountIdr: null,
        }),
        `g${id.slice(0, 8)}`,
        outletScope,
      ],
    );
    return id;
  }

  async function setPromotionOutlet(
    promotionId: string,
    outletId: string,
    enabled: boolean,
  ) {
    await owner.query(
      `INSERT INTO promotion_outlets (tenant_id, promotion_id, outlet_id, enabled)
       VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, promotionId, outletId, enabled],
    );
  }

  async function seedOtherTenantMenuItem(): Promise<string> {
    const categoryId = await one<string>(
      "INSERT INTO menu_categories (tenant_id, brand_id, name, sort_order) VALUES ($1, $2, 'Kategori B', 0) RETURNING id",
      [tenantB.tenantId, tenantB.brandId],
    );
    return one<string>(
      "INSERT INTO menu_items (tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, 'Menu Tenant B') RETURNING id",
      [tenantB.tenantId, tenantB.brandId, categoryId],
    );
  }

  async function expectRefusedAndNothingStored(
    order: Order,
    patch: Record<string, unknown>,
  ) {
    const res = await api(recorder).report(
      order.ulid,
      resolveWith(order, patch),
    );
    expect(res.status).toBe(422);
    const { rows } = await owner.query(
      "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
      [tenant.tenantId, order.itemUuid],
    );
    expect(rows).toHaveLength(0);
  }

  it("refuses a voucher id that does not exist", async () => {
    const order = await seedOrder(kit.menuItem);
    await expectRefusedAndNothingStored(order, {
      resolution: "voucher",
      voucherId: randomUUID(),
    });
  });

  it("refuses a voucher that belongs to another tenant", async () => {
    const order = await seedOrder(kit.menuItem);
    const foreign = await seedVoucher(tenantB.tenantId, null);
    await expectRefusedAndNothingStored(order, {
      resolution: "voucher",
      voucherId: foreign,
    });
  });

  it("refuses a swap item that does not exist", async () => {
    const order = await seedOrder(kit.menuItem);
    await expectRefusedAndNothingStored(order, {
      resolution: "swap",
      replacementItemId: randomUUID(),
    });
  });

  it("refuses a swap item that belongs to another tenant", async () => {
    const order = await seedOrder(kit.menuItem);
    await expectRefusedAndNothingStored(order, {
      resolution: "swap",
      replacementItemId: await seedOtherTenantMenuItem(),
    });
  });

  it("refuses a voucher whose promotion is allowlisted to another outlet only", async () => {
    const order = await seedOrder(kit.menuItem);
    const promotion = await seedPromotion("only");
    await setPromotionOutlet(promotion, ids.outletB, true);
    await expectRefusedAndNothingStored(order, {
      resolution: "voucher",
      voucherId: await seedVoucher(tenant.tenantId, promotion),
    });
  });

  it("refuses a voucher whose promotion is switched off at this outlet", async () => {
    const order = await seedOrder(kit.menuItem);
    const promotion = await seedPromotion("all_except");
    await setPromotionOutlet(promotion, tenant.outletId, false);
    await expectRefusedAndNothingStored(order, {
      resolution: "voucher",
      voucherId: await seedVoucher(tenant.tenantId, promotion),
    });
  });

  it("stores a voucher of this tenant with no promotion", async () => {
    const order = await seedOrder(kit.menuItem);
    const voucherId = await seedVoucher(tenant.tenantId, null);
    const res = await api(recorder).report(
      order.ulid,
      resolveWith(order, { resolution: "voucher", voucherId }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      resolution: "voucher",
      voucherId,
    });
  });

  it("stores a voucher whose promotion covers this outlet (allowlist and opt-out scopes)", async () => {
    const allowed = await seedPromotion("only");
    await setPromotionOutlet(allowed, tenant.outletId, true);
    const optOutElsewhere = await seedPromotion("all_except");
    await setPromotionOutlet(optOutElsewhere, ids.outletB, false);
    const untouched = await seedPromotion("all_except");
    for (const promotion of [allowed, optOutElsewhere, untouched]) {
      const order = await seedOrder(kit.menuItem);
      const voucherId = await seedVoucher(tenant.tenantId, promotion);
      const res = await api(recorder).report(
        order.ulid,
        resolveWith(order, { resolution: "voucher", voucherId }),
      );
      expect(res.status).toBe(201);
      expect(res.body.data.voucherId).toBe(voucherId);
    }
  });

  it("stores a swap to a menu item of this tenant", async () => {
    const order = await seedOrder(kit.menuItem);
    const res = await api(recorder).report(
      order.ulid,
      resolveWith(order, {
        resolution: "swap",
        replacementItemId: kit.menuItem,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      resolution: "swap",
      replacementItemId: kit.menuItem,
    });
  });
});

describe("permissions, tenant and outlet isolation", () => {
  it("denies a user without kds.remake_comp.record", async () => {
    const order = await seedOrder(kit.menuItem);
    expect(
      (await api(nobody).report(order.ulid, issueBody(order))).status,
    ).toBe(403);
    expect((await api(nobody).list()).status).toBe(403);
  });

  it("a station-scoped user reports only for their own station", async () => {
    const order = await seedOrder(kit.menuItem);
    const own = await api(barista).report(order.ulid, issueBody(order));
    expect(own.status).toBe(201);
    const other = await seedOrder(kit.menuItem);
    const foreign = await api(barista).report(
      other.ulid,
      issueBody(other, { stationId: ids.kitchenA }),
    );
    expect(foreign.status).toBe(403);
    // A station-only account cannot file an issue without a station.
    const none = await api(barista).report(
      other.ulid,
      issueBody(other, { stationId: null }),
    );
    expect(none.status).toBe(403);
  });

  it("a station-scoped user lists only their station's issues", async () => {
    const res = await api(barista).list();
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) expect(row.stationId).toBe(ids.barA);
  });

  it("an outlet-B account cannot read or file in outlet A", async () => {
    const order = await seedOrder(kit.menuItem);
    expect(
      (await api(outletBRecorder).report(order.ulid, issueBody(order))).status,
    ).toBe(403);
    expect((await api(outletBRecorder).list()).status).toBe(403);
  });

  it("an order of outlet B is not reachable through outlet A's path", async () => {
    const order = await seedOrder(kit.menuItem);
    // Outlet B account names outlet B but an outlet A order id.
    const res = await api(outletBRecorder, headers, ids.outletB).report(
      order.ulid,
      issueBody(order, { stationId: null }),
    );
    expect(res.status).toBe(404);
  });

  it("another tenant cannot file, read, or see the rows", async () => {
    const order = await seedOrder(kit.menuItem);
    const mine = await api(recorder).report(order.ulid, issueBody(order));
    expect(mine.status).toBe(201);
    const other = api(tenantBRecorder, headersB);
    const filed = await other.report(order.ulid, issueBody(order));
    expect([403, 404]).toContain(filed.status);
    const listed = await other.list();
    expect([403, 404]).toContain(listed.status);
    if (listed.status === 200) expect(listed.body.data).toEqual([]);
  });

  it("RLS hides the rows from another tenant and another outlet", async () => {
    const order = await seedOrder(kit.menuItem);
    await api(recorder).report(order.ulid, issueBody(order));
    const count = (tenantId: string, outletIds: string) =>
      asOwnerTenant(
        tenantId,
        async (client) =>
          Number(
            (
              await client.query<{ n: string }>(
                "SELECT count(*)::text AS n FROM order_issues",
              )
            ).rows[0]!.n,
          ),
        outletIds,
        true,
      );
    expect(await count(tenant.tenantId, "*")).toBeGreaterThan(0);
    expect(await count(tenantB.tenantId, "*")).toBe(0);
    expect(await count(tenant.tenantId, JSON.stringify([ids.outletB]))).toBe(0);
  });
});

describe("listOrderIssues projection (legend-0eq7)", () => {
  it("returns the order label, item name and staff names with each row", async () => {
    const order = await seedOrder(kit.menuItem);
    const remake = await api(recorder).report(order.ulid, issueBody(order));
    // The API refuses manual refunds (R25); seed the row the way a future
    // approval flow would store it.
    const refundId = await one<string>(
      `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
          reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key, resolved_at)
       VALUES ($1, $2, $3, $4, 'complaint', 'complaint', 'Pelanggan kecewa, refund manual disetujui',
          $5, 'manual_refund', $6, 0, 'resolved', $7, now()) RETURNING id`,
      [
        tenant.tenantId,
        tenant.outletId,
        order.uuid,
        order.itemUuid,
        recorder.userId,
        supervisor.userId,
        `seed-${randomUUID()}`,
      ],
    );
    expect(remake.status).toBe(201);
    const res = await api(recorder).list("?limit=100");
    expect(res.status).toBe(200);
    const byId = new Map<string, Record<string, unknown>>(
      res.body.data.map((row: { id: string }) => [row.id, row]),
    );
    const orderNumber = (
      await owner.query<{ number: string }>(
        "SELECT number FROM orders WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, order.uuid],
      )
    ).rows[0]!.number;
    expect(byId.get(remake.body.data.id)).toMatchObject({
      orderLabel: orderNumber,
      itemName: "Latte",
      reportedByName: "Pencatat",
      employeeName: "Koki",
      approvedByName: null,
    });
    expect(byId.get(refundId)).toMatchObject({
      employeeName: null,
      approvedByName: "Supervisor",
    });
    expect(
      orderIssueViewSchema.safeParse(byId.get(remake.body.data.id)).success,
    ).toBe(true);
  });
});

describe("listOrderIssues", () => {
  it("filters by type and station and pages with a cursor", async () => {
    const all = await api(recorder).list("?limit=2");
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.meta.nextCursor).toBeTruthy();
    const next = await api(recorder).list(
      `?limit=2&cursor=${encodeURIComponent(all.body.meta.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data[0].id).not.toBe(all.body.data[0].id);

    const comps = await api(recorder).list("?type=comp&limit=100");
    expect(comps.body.data.length).toBeGreaterThan(0);
    for (const row of comps.body.data) expect(row.type).toBe("comp");

    const kitchen = await api(recorder).list(
      `?stationId=${ids.kitchenA}&limit=100`,
    );
    expect(kitchen.body.data).toEqual([]);
  });
});
