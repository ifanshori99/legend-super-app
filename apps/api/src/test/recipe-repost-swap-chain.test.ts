// Second-opinion finding T1 (WS-06, legend-q55i): a chained swap A -> B -> C on
// a sale whose deductions were ALL skipped. Repost may draw only the last
// replacement still in force (C): A was swapped away for B, and B was swapped
// away for C, so neither A nor B left the kitchen. Repost twice = drawn once.
//
// Written from the brief and the repost contract, not from the service:
// POST /api/inventory/outlets/:outletId/recipe-deductions/repost-skipped
// { businessDate } -> { data: { reposted, stillSkipped } }.
//
// Assumptions where the brief is silent:
// - The swaps are applied while the outlet has no sale location, so the sale
//   and both swap draws are skipped (`no_sale_location`) and nothing moved.
// - Assertion is on stock only (on hand and ledger rows per item), not on how
//   many deduction rows carry the C draw: sale row or swap row may post it.
// - `reposted` / `stillSkipped` are counts (a list is accepted, length used).
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates and removes again (same harness as recipe-deduction-repost.test.ts).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  decimal4,
  outletIdSchema,
  ulidToUuid,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  applySwapStockAdjustment,
  deliverRecipeDeductionEvent,
} from "../services/recipe-deduction.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const slugA = `rsc${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();
const short = () => randomUUID().slice(0, 6);
const iso = () => new Date().toISOString();

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

let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2034, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

let ownerUserId: string;
let gramId: string;
let portionId: string;
let categoryId: string;
let adminClient: ReturnType<typeof agent>;
const createdUserIds: string[] = [];

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await owner.query<{ id: T }>(sql, params);
  return rows[0]!.id;
}

async function newItem(name: string): Promise<string> {
  return one<string>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, gramId],
  );
}

async function receive(locationId: string, itemId: string, quantity: string) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outletA) as OutletId,
    locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4("10.0000"),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  } as never);
}

async function configureOutlet(saleLocationId: string | null) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time',
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantA, outletA, saleLocationId],
  );
}

/** A dish whose recipe is `qty` g of `itemId`. */
async function insertDish(itemId: string, qty: string): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, true, $5) RETURNING id`,
    [tenantA, brandA, `Resep ${short()}`, portionId, ownerUserId],
  );
  await owner.query(
    `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
     VALUES ($1, $2, 0, 'item', $3, $4, $5, 0)`,
    [tenantA, recipeId, itemId, qty, gramId],
  );
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantA, brandA, categoryId, `Menu ${short()}`, recipeId, randomUUID()],
  );
}

async function insertLine(
  orderUuid: string,
  menuItemId: string,
  businessDate: string,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
        quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
        fire_status, status, reserved_business_date)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Item', 1, 0, 0, 0, '[]'::jsonb, 'fired', 'served', $6)`,
    [id, tenantA, outletA, orderUuid, menuItemId, businessDate],
  );
  return id;
}

async function insertSwapIssue(
  orderUuid: string,
  oldLineId: string,
  replacementMenuItemId: string,
  replacementLineId: string,
): Promise<string> {
  return one<string>(
    `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
        reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
        cost_idr, idempotency_key, status, resolved_at)
     VALUES ($1, $2, $3, $4, 'unfulfillable', 'out_of_stock', 'uji rantai swap', $5, 'swap', $6, $7,
        0, $8, 'resolved', now())
     RETURNING id`,
    [
      tenantA,
      outletA,
      orderUuid,
      oldLineId,
      ownerUserId,
      replacementMenuItemId,
      replacementLineId,
      randomUUID(),
    ],
  );
}

async function applySwap(input: {
  orderUlid: string;
  businessDate: string;
  issueId: string;
  oldLineId: string;
  oldMenuItemId: string;
  newMenuItemId: string;
}) {
  const context = tenantContext();
  return withTenant(db, context, (tx) =>
    applySwapStockAdjustment(tx, context, {
      outletId: outletA,
      orderId: input.orderUlid,
      issueId: input.issueId,
      businessDate: input.businessDate,
      oldLineId: uuidToUlid(input.oldLineId),
      oldLine: {
        menuItemId: input.oldMenuItemId,
        variantId: null,
        modifierIds: [],
        quantity: 1,
      },
      replacement: {
        menuItemId: input.newMenuItemId,
        variantId: null,
        modifierIds: [],
        quantity: 1,
      },
      recordedBy: ownerUserId,
      occurredAt: iso(),
    }),
  );
}

async function onHand(locationId: string, itemId: string): Promise<number> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return Number(rows[0]?.quantity ?? 0);
}

/** Ledger rows that took stock out of (or put back into) the item, any type but the receipt. */
async function movedRows(locationId: string, itemId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM stock_ledger
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3
        AND movement_type <> 'receipt'`,
    [tenantA, locationId, itemId],
  );
  return Number(rows[0]!.n);
}

async function skippedCount(orderUlid: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM recipe_deductions
      WHERE tenant_id = $1 AND status = 'skipped'
        AND (source_id = $2 OR source_id = $3)`,
    [tenantA, orderUlid, ulidToUuid(orderUlid)],
  );
  return Number(rows[0]!.n);
}

const count = (value: unknown): number =>
  Array.isArray(value) ? value.length : Number(value);

function repost(businessDate: string) {
  return adminClient
    .post(`/api/inventory/outlets/${outletA}/recipe-deductions/repost-skipped`)
    .set(originHeader)
    .send({ businessDate });
}

// --------------------------------------------------------------------- setup

async function createOwnTenant() {
  const fixtures = cafeLegendPlatformFixtures;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, 'test')`,
    [
      tenantA,
      `tenant-${slugA}`,
      `Tenant ${slugA}`,
      JSON.stringify(fixtures.tenant.featureFlags),
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
      `C${slugA.slice(3)}`.toUpperCase(),
      `Outlet ${slugA}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
  for (const template of ROLE_TEMPLATES.filter((t) => t.level === "tenant"))
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
      [
        randomUUID(),
        tenantA,
        template.defaultName,
        template.key,
        JSON.stringify(template.permissions),
        template.mfaRequired,
        JSON.stringify(template.allowedScopeTypes),
      ],
    );
  await owner.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), tenantA, brandA, hostA],
  );
}

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
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "Chain Owner", `${ownerUserId}@example.com`],
  );
  createdUserIds.push(ownerUserId);
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  portionId = await uom("porsi");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Rantai Uji', 0)",
    [categoryId, tenantA, brandA],
  );
  adminClient = agent(app);
  await signUp(adminClient, "Chain Admin");
  const session = await adminClient.get("/api/auth/get-session");
  const adminId = session.body.user.id as string;
  createdUserIds.push(adminId);
  adminClient.set("Host", hostA);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [
      tenantA,
      adminId,
      await one<string>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
        [tenantA],
      ),
    ],
  );
});

afterAll(async () => {
  await dropOwnTenant();
  await owner.end();
});

// ===========================================================================

describe("INV-02 repost of a chained swap A -> B -> C on a fully skipped sale", () => {
  it("INV-02 repost draws only the last replacement (C), once, however often it runs", async () => {
    const location = await one<string>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
      [tenantA, outletA, `Bar Rantai ${short()}`],
    );
    const itemA = await newItem("Kopi");
    const itemB = await newItem("Teh");
    const itemC = await newItem("Coklat");
    for (const item of [itemA, itemB, itemC])
      await receive(location, item, "1000.0000");
    const dishA = await insertDish(itemA, "10.0000");
    const dishB = await insertDish(itemB, "20.0000");
    const dishC = await insertDish(itemC, "30.0000");

    // Order with the A line, then swap A -> B, then B -> C (two issues).
    const businessDate = nextDate();
    const orderUlid = createUlid();
    const orderUuid = ulidToUuid(orderUlid);
    await owner.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0, 'completed', $5, now())`,
      [
        orderUuid,
        tenantA,
        outletA,
        `RSC-${randomUUID().slice(0, 12)}`,
        businessDate,
      ],
    );
    const lineA = await insertLine(orderUuid, dishA, businessDate);
    const lineB = await insertLine(orderUuid, dishB, businessDate);
    const lineC = await insertLine(orderUuid, dishC, businessDate);
    const issue1 = await insertSwapIssue(orderUuid, lineA, dishB, lineB);
    const issue2 = await insertSwapIssue(orderUuid, lineB, dishC, lineC);

    // The outlet has no sale location: the sale and both swaps are skipped.
    await configureOutlet(null);
    const context = tenantContext();
    await withTenant(db, context, (tx) =>
      deliverRecipeDeductionEvent(
        context,
        eventEnvelopeSchema.parse({
          id: createUlid(),
          tenantId: tenantA,
          outletId: outletA,
          name: "order.paid",
          version: 1,
          aggregateType: "order",
          aggregateId: orderUlid,
          sequence: 1,
          occurredAt: iso(),
          actor: { type: "system" },
          idempotencyKey: `order.paid:${orderUlid}`,
          payloadSchemaRef: "order.paid.v1",
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
        }),
        tx,
      ),
    );
    await applySwap({
      orderUlid,
      businessDate,
      issueId: issue1,
      oldLineId: lineA,
      oldMenuItemId: dishA,
      newMenuItemId: dishB,
    });
    await applySwap({
      orderUlid,
      businessDate,
      issueId: issue2,
      oldLineId: lineB,
      oldMenuItemId: dishB,
      newMenuItemId: dishC,
    });
    // Precondition: nothing is drawn yet, and something is waiting to be reposted.
    for (const item of [itemA, itemB, itemC]) {
      expect(await onHand(location, item)).toBe(1000);
      expect(await movedRows(location, item)).toBe(0);
    }
    expect(await skippedCount(orderUlid)).toBeGreaterThan(0);

    await configureOutlet(location);
    const first = await repost(businessDate);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(count(first.body.data.reposted)).toBeGreaterThan(0);

    // Only C (30 g) leaves stock. A and B were swapped away: not drawn at all.
    expect(await onHand(location, itemA)).toBe(1000);
    expect(await onHand(location, itemB)).toBe(1000);
    expect(await onHand(location, itemC)).toBe(970);
    expect(await movedRows(location, itemA)).toBe(0);
    expect(await movedRows(location, itemB)).toBe(0);
    expect(await movedRows(location, itemC)).toBe(1);

    // Second repost: nothing moves again.
    const second = await repost(businessDate);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(count(second.body.data.reposted)).toBe(0);
    expect(await onHand(location, itemA)).toBe(1000);
    expect(await onHand(location, itemB)).toBe(1000);
    expect(await onHand(location, itemC)).toBe(970);
    expect(await movedRows(location, itemC)).toBe(1);
  });
});
