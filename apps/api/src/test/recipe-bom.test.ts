// Recipe / BOM and automatic stock deduction integration tests (bead
// legend-db6; PRD v1.7 §3 F16 "Resep / BOM & Pemotongan Otomatis", INV-02;
// KDS-07 remake and comp consume stock; duty meal "makan karyawan").
//
// Runs against the disposable PostgreSQL test database: the migration owner
// seeds fixtures (recipes, menu, orders), the restricted legend_app login
// proves RLS, the consumer runs through `withTenant` exactly as the worker
// delivers a cloud-sync event, and the HTTP block uses the real Express app.
//
// Assumptions where the spec is silent:
// - A recipe line's gross quantity is net / (1 - waste), rounded half_up once.
// - Modifier add/replace/remove rule quantities are per sold unit and scaled
//   by the sold quantity; a variant recipe overrides the menu item recipe.
// - The deduction row is found by its source id (order ULID or its UUID form).
// - A user without inventory.cost.view sees costIdr as null (or 0).
// - Tenant B asking for tenant A's data gets 403/404, never A's rows.
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
  orderIssueRecordedPayloadSchema,
  type OrderIssueType,
} from "@starter/shared/inventory";
import {
  dayClosedPayloadSchema,
  orderPaidPayloadSchema,
} from "@starter/shared/pos";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { deliverRecipeDeductionEvent } from "../services/recipe-deduction.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

// Every scenario runs in a tenant, brand and two outlets this file creates in
// `beforeAll` and removes in `afterAll`. The shared fixture tenant is never
// written to: menu categories/items and order_items seeded there broke the
// menu suites running in parallel on the same database.
const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const slugA = `bom${randomUUID().slice(0, 8)}`;
const hostA = `tenant-${slugA}.legend.test`;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const app = createApp();
const createdUserIds: string[] = [];

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

/** Runs `run` in a rolled-back legend_app transaction with tenant + outlets. */
async function asTenant<T>(
  tenantId: string,
  outlets: string,
  run: (
    query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outlets],
    );
    return await run((sql) => client.query(sql));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const short = () => randomUUID().slice(0, 6);
const key = (prefix: string) => `${prefix}-${randomUUID()}`;
const iso = () => new Date().toISOString();

// Every test books its sales on its own far-future business date so a
// `day.closed` in one test can never touch another test's pending rows.
let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2031, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

// ------------------------------------------------------------ owner fixtures

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertLocation(
  name: string,
  outletId = outletA,
  type = "bar",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, outletId, `${name} ${short()}`, type],
  );
  return rows[0]!.id;
}

async function insertItem(
  name: string,
  baseUomId: string,
  type: "raw_material" | "semi_finished" = "raw_material",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $3, $4, true) RETURNING id`,
    [tenantA, `${name} ${short()}`, type, baseUomId],
  );
  return rows[0]!.id;
}

/** `from` -> `to` factor: 1 `from` equals `factor` `to`. */
async function insertConversion(
  itemId: string,
  fromUomId: string,
  toUomId: string,
  factor: string,
) {
  await owner.query(
    "INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor) VALUES ($1, $2, $3, $4, $5)",
    [tenantA, itemId, fromUomId, toUomId, factor],
  );
}

async function receive(
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
  outletId = outletA,
) {
  await recordStockMovement(tenantContext(), {
    outletId: outletIdSchema.parse(outletId) as OutletId,
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

type RecipeLineSeed = {
  type?: "item" | "recipe";
  id: string;
  qty: string;
  uom: string;
  wasteBp?: number;
};

async function insertRecipe(input: {
  name: string;
  yieldUomId: string;
  yieldQuantity?: string;
  outputItemId?: string | null;
  isActive?: boolean;
  lines: RecipeLineSeed[];
}): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      tenantA,
      brandA,
      `${input.name} ${short()}`,
      input.outputItemId ?? null,
      input.yieldQuantity ?? "1.0000",
      input.yieldUomId,
      input.isActive ?? true,
      ownerUserId,
    ],
  );
  const recipeId = rows[0]!.id;
  await addRecipeLines(recipeId, input.lines);
  return recipeId;
}

async function addRecipeLines(recipeId: string, lines: RecipeLineSeed[]) {
  for (const [index, line] of lines.entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantA,
        recipeId,
        index,
        line.type ?? "item",
        line.id,
        line.qty,
        line.uom,
        line.wasteBp ?? 0,
      ],
    );
}

let categoryId: string;
let modifierGroupId: string;

async function insertMenuItem(
  name: string,
  recipeId: string | null,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantA, brandA, categoryId, `${name} ${short()}`, recipeId],
  );
  return rows[0]!.id;
}

async function insertVariant(
  menuItemId: string,
  name: string,
  recipeId: string | null,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, menuItemId, `${name} ${short()}`, recipeId],
  );
  return rows[0]!.id;
}

async function insertModifier(
  name: string,
  recipeId: string | null = null,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO modifiers (tenant_id, group_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [tenantA, modifierGroupId, `${name} ${short()}`, recipeId],
  );
  return rows[0]!.id;
}

type RuleSeed =
  | {
      action: "add";
      component: { id: string; qty: string; uom: string; wasteBp?: number };
    }
  | {
      action: "replace";
      target: string;
      component: { id: string; qty: string; uom: string; wasteBp?: number };
    }
  | { action: "remove"; target: string };

/** Item-typed rules only; recipe-typed targets are covered by the unit tests. */
async function insertRule(modifierId: string, rule: RuleSeed) {
  const target = "target" in rule ? rule.target : null;
  const component = "component" in rule ? rule.component : null;
  await owner.query(
    `INSERT INTO modifier_recipe_rules
       (tenant_id, modifier_id, action, target_component_type, target_component_id,
        component_type, component_id, quantity, uom_id, waste_pct_bp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantA,
      modifierId,
      rule.action,
      target ? "item" : null,
      target,
      component ? "item" : null,
      component?.id ?? null,
      component?.qty ?? null,
      component?.uom ?? null,
      component?.wasteBp ?? 0,
    ],
  );
}

async function configureOutlet(
  outletId: string,
  settings: {
    mode: "real_time" | "close_of_day" | null;
    saleLocationId: string | null;
  },
) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode,
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantA, outletId, settings.mode, settings.saleLocationId],
  );
}

/** Sets the tenant-wide mode for `run`, then restores whatever was there. */
async function withTenantMode<T>(
  mode: "real_time" | "close_of_day",
  run: () => Promise<T>,
): Promise<T> {
  const previous = await owner.query<{ recipe_deduction_mode: string }>(
    "SELECT recipe_deduction_mode FROM inventory_settings WHERE tenant_id = $1",
    [tenantA],
  );
  const upsert = `INSERT INTO inventory_settings (tenant_id, recipe_deduction_mode) VALUES ($1, $2)
                  ON CONFLICT (tenant_id) DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode`;
  await owner.query(upsert, [tenantA, mode]);
  try {
    return await run();
  } finally {
    if (previous.rows[0])
      await owner.query(upsert, [
        tenantA,
        previous.rows[0].recipe_deduction_mode,
      ]);
    else
      await owner.query("DELETE FROM inventory_settings WHERE tenant_id = $1", [
        tenantA,
      ]);
  }
}

type SaleLine = {
  menuItemId: string;
  variantId?: string | null;
  modifierIds?: string[];
  quantity: number;
  voided?: boolean;
};

/** A paid order with its lines, as the POS leaves it for the consumer. */
async function seedOrder(
  outletId: string,
  businessDate: string,
  lines: SaleLine[],
): Promise<{ ulid: string; uuid: string }> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0, 'completed', $5, now())`,
    [uuid, tenantA, outletId, `BOM-${randomUUID().slice(0, 12)}`, businessDate],
  );
  for (const line of lines)
    await owner.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, $6, 'Item', $7, 0, 0, 0, $8::jsonb, 'fired', $9, $10)`,
      [
        randomUUID(),
        tenantA,
        outletId,
        uuid,
        line.menuItemId,
        line.variantId ?? null,
        line.quantity,
        JSON.stringify(
          (line.modifierIds ?? []).map((modifierId) => ({
            modifierId,
            groupId: modifierGroupId,
            name: "Modifier",
            priceIdr: 0,
          })),
        ),
        line.voided ? "voided" : "served",
        businessDate,
      ],
    );
  return { ulid, uuid };
}

// ------------------------------------------------------------------- events

function envelope(input: {
  name: string;
  aggregateType: string;
  aggregateId: string;
  outletId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): EventEnvelope {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantA,
    outletId: input.outletId,
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

function paidEvent(orderUlid: string, outletId: string, businessDate: string) {
  const payload = orderPaidPayloadSchema.parse({
    orderId: orderUlid,
    outletId,
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
  });
  return envelope({
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    outletId,
    payload,
    idempotencyKey: `order.paid:${orderUlid}`,
  });
}

function dayClosedEvent(outletId: string, businessDate: string) {
  const payload = dayClosedPayloadSchema.parse({
    outletId,
    businessDate,
    orderCount: 1,
    totalSalesIdr: 50000,
    totalRefundsIdr: 0,
    totalVoidsIdr: 0,
    totalVarianceIdr: 0,
    inventoryDeductionApplied: false,
    accountingSyncStatus: "pending",
    closedBy: ownerUserId,
    closedAt: iso(),
  });
  return envelope({
    name: "day.closed",
    aggregateType: "day",
    aggregateId: createUlid(),
    outletId,
    payload,
    idempotencyKey: key("day.closed"),
  });
}

function issueEvent(input: {
  issueId: string;
  orderUlid: string;
  outletId: string;
  businessDate: string;
  type: OrderIssueType;
  menuItemId: string;
  quantity?: number;
}) {
  const payload = orderIssueRecordedPayloadSchema.parse({
    issueId: input.issueId,
    orderId: input.orderUlid,
    orderItemId: randomUUID(),
    outletId: input.outletId,
    businessDate: input.businessDate,
    type: input.type,
    reason: "quality",
    stationId: null,
    recordedBy: ownerUserId,
    menuItemId: input.menuItemId,
    variantId: null,
    modifierIds: [],
    quantity: input.quantity ?? 1,
    occurredAt: iso(),
  });
  return envelope({
    name: "order_issue.recorded",
    aggregateType: "order_issue",
    aggregateId: input.issueId,
    outletId: input.outletId,
    payload,
    idempotencyKey: `order_issue.recorded:${input.issueId}`,
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

type DeductionRow = {
  id: string;
  kind: string;
  status: string;
  mode: string;
  source_type: string;
  source_id: string;
  business_date: string;
  cost_idr: string | null;
  skip_reason: string | null;
  posted_at: string | null;
  lines: {
    inventory_item_id: string;
    location_id: string;
    quantity: string;
    unit_cost_idr: string | null;
    ledger_entry_id: string | null;
  }[];
};

async function deductionsOf(...sourceIds: string[]): Promise<DeductionRow[]> {
  const { rows } = await owner.query<Omit<DeductionRow, "lines">>(
    `SELECT id, kind, status, mode, source_type, source_id, business_date::text AS business_date,
            cost_idr::text AS cost_idr, skip_reason, posted_at::text AS posted_at
     FROM recipe_deductions WHERE tenant_id = $1
       AND (source_id = ANY($2::text[]) OR idempotency_key = ANY($3::text[]))
     ORDER BY created_at, id`,
    [tenantA, sourceIds, sourceIds.map((id) => `order_issue:${id}`)],
  );
  const result: DeductionRow[] = [];
  for (const row of rows) {
    const lines = await owner.query<DeductionRow["lines"][number]>(
      `SELECT inventory_item_id, location_id, quantity::text AS quantity,
              unit_cost_idr::text AS unit_cost_idr, ledger_entry_id::text AS ledger_entry_id
       FROM recipe_deduction_lines WHERE tenant_id = $1 AND deduction_id = $2`,
      [tenantA, row.id],
    );
    result.push({ ...row, lines: lines.rows });
  }
  return result;
}

/** Quantity drawn per item, as `{ itemId: "36.0000" }`. */
const drawn = (deduction: DeductionRow) =>
  Object.fromEntries(
    deduction.lines.map((line) => [line.inventory_item_id, line.quantity]),
  );

async function ledgerRows(locationId: string, itemId: string) {
  const { rows } = await owner.query<{
    movement_type: string;
    source_type: string;
    quantity: string;
  }>(
    `SELECT movement_type, source_type, quantity::text AS quantity
     FROM stock_ledger WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3
     ORDER BY posting_seq`,
    [tenantA, locationId, itemId],
  );
  return rows;
}

async function onHand(locationId: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

async function sell(
  lines: SaleLine[],
  options: { outletId?: string; businessDate?: string } = {},
) {
  const outletId = options.outletId ?? outletA;
  const businessDate = options.businessDate ?? nextDate();
  const order = await seedOrder(outletId, businessDate, lines);
  const event = paidEvent(order.ulid, outletId, businessDate);
  await deliver(event);
  const deduction = (await deductionsOf(order.ulid, order.uuid)).find(
    (row) => row.kind === "sale",
  );
  if (!deduction)
    throw new Error("order.paid recorded no deduction for the order");
  return { order, event, businessDate, deduction };
}

// ------------------------------------------------------------- users & roles

let ownerUserId: string;
let gramId: string;
let mlId: string;
let literId: string;
let cartonId: string;
let portionId: string;
let cupId: string;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function assignRole(
  userId: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantA,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

async function insertUser(name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, name, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  // Every later request of this agent is addressed to this file's tenant.
  client.set("Host", hostA);
  return { client, userId };
}

// ---------------------------------------------------------------- the Latte

type LatteKit = Awaited<ReturnType<typeof buildLatteKit>>;

/**
 * A cafe sale location with stock, a Latte (18 g beans + 200 ml milk), a Large
 * variant (300 ml milk), a Regular variant without its own recipe and the
 * modifiers used by the INV-02 modifier cases. Unit costs: beans 100/g,
 * milk 20/ml, oat 40/ml, syrup 80/ml, so one plain Latte costs Rp5.800.
 */
async function buildLatteKit() {
  const location = await insertLocation("Bar Penjualan");
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  const oat = await insertItem("Oat Milk", mlId);
  const syrup = await insertItem("Sirup", mlId);
  for (const [item, cost] of [
    [beans, "100.0000"],
    [milk, "20.0000"],
    [oat, "40.0000"],
    [syrup, "80.0000"],
  ] as const)
    await receive(location, item, "100000.0000", cost);

  const latteRecipe = await insertRecipe({
    name: "Latte",
    yieldUomId: cupId,
    lines: [
      { id: beans, qty: "18.0000", uom: gramId },
      { id: milk, qty: "200.0000", uom: mlId },
    ],
  });
  const largeRecipe = await insertRecipe({
    name: "Latte Large",
    yieldUomId: cupId,
    lines: [
      { id: beans, qty: "18.0000", uom: gramId },
      { id: milk, qty: "300.0000", uom: mlId },
    ],
  });
  const syrupAddOn = await insertRecipe({
    name: "Tambah Sirup",
    yieldUomId: portionId,
    lines: [{ id: syrup, qty: "15.0000", uom: mlId }],
  });
  const latte = await insertMenuItem("Latte", latteRecipe);
  const regular = await insertVariant(latte, "Regular", null);
  const large = await insertVariant(latte, "Large", largeRecipe);

  const extraShot = await insertModifier("Extra Shot");
  await insertRule(extraShot, {
    action: "add",
    component: { id: beans, qty: "9.0000", uom: gramId },
  });
  const oatMilk = await insertModifier("Oat Milk");
  await insertRule(oatMilk, {
    action: "replace",
    target: milk,
    component: { id: oat, qty: "150.0000", uom: mlId },
  });
  const noMilk = await insertModifier("Tanpa Susu");
  await insertRule(noMilk, { action: "remove", target: milk });
  const syrupMod = await insertModifier("Sirup", syrupAddOn);

  return {
    location,
    beans,
    milk,
    oat,
    syrup,
    latte,
    regular,
    large,
    extraShot,
    oatMilk,
    noMilk,
    syrupMod,
  };
}

// --------------------------------------------------------------------- setup

let tenantB: IsolatedTenant | null = null;

/** Creates this file's own tenant, brand, entity, two outlets, roles, domain. */
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
  for (const [index, outletId] of [outletA, outletB].entries())
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
      [
        outletId,
        tenantA,
        brandA,
        legalEntityA,
        `B${slugA.slice(3)}${index}`.toUpperCase(),
        `Outlet ${slugA} ${index}`,
        JSON.stringify(fixtures.outlets[0]!.openingHours),
      ],
    );
  // The tenant-level role templates, as the shared fixture tenant has them.
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

/**
 * Removes everything this file created in its own tenant. The stock ledger is
 * append-only (INV-01) and audit rows pin outlets, so the owner connection
 * suspends triggers (and with them FK checks) for this one purge; every table
 * holding a tenant_id column is emptied for this tenant only, then the tenant.
 */
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
  ownerUserId = await insertUser("Recipe BOM Owner");
  await assignRole(ownerUserId, "owner", { type: "tenant" });
  gramId = await insertUom("g");
  mlId = await insertUom("ml");
  literId = await insertUom("l");
  cartonId = await insertUom("ctn");
  portionId = await insertUom("porsi");
  cupId = await insertUom("cup");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Resep Uji', 0)",
    [categoryId, tenantA, brandA],
  );
  modifierGroupId = randomUUID();
  await owner.query(
    "INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select) VALUES ($1, $2, 'Tambahan Uji', 0, 10)",
    [modifierGroupId, tenantA],
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
  if (tenantB) await dropIsolatedTenant(tenantB);
  await dropOwnTenant();
  // User rows stay (shared auth tables); their role assignments went with the
  // tenant above.
  await owner.end();
  await appPool.end();
});

// ------------------------------------------------------------- explosion

describe("INV-02 recipe explosion into stock draws", () => {
  it("INV-02 explodes a 3-level recipe (menu -> inline sub-recipe -> semi-finished) with waste gross-up", async () => {
    const location = await insertLocation("Bar Tiga Level");
    const beans = await insertItem("Biji", gramId);
    const milk = await insertItem("Susu", mlId);
    const sugar = await insertItem("Gula", gramId);
    const syrupItem = await insertItem("Sirup Jadi", mlId, "semi_finished");
    await receive(location, beans, "1000.0000", "100.0000");
    await receive(location, milk, "5000.0000", "20.0000");
    await receive(location, syrupItem, "1000.0000", "80.0000");
    await receive(location, sugar, "1000.0000", "10.0000");
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: location,
    });

    // Level 3: syrup is produced in batches (output item), so it is drawn as
    // the semi-finished item and sugar is NOT drawn.
    const syrup = await insertRecipe({
      name: "Sirup",
      outputItemId: syrupItem,
      yieldQuantity: "1000.0000",
      yieldUomId: mlId,
      lines: [{ id: sugar, qty: "500.0000", uom: gramId }],
    });
    // Level 2: inline milk base (no output) yields 2 portions.
    const milkBase = await insertRecipe({
      name: "Dasar Susu",
      yieldQuantity: "2.0000",
      yieldUomId: portionId,
      lines: [
        { id: milk, qty: "400.0000", uom: mlId },
        // 50 ml net with 20% waste = 62.5 ml gross per batch of 2 portions.
        { type: "recipe", id: syrup, qty: "50.0000", uom: mlId, wasteBp: 2000 },
      ],
    });
    // Level 1: the menu recipe; 18 g beans with 10% waste = 20 g gross per cup.
    const menuRecipe = await insertRecipe({
      name: "Kopi Susu Sirup",
      yieldUomId: cupId,
      lines: [
        { id: beans, qty: "18.0000", uom: gramId, wasteBp: 1000 },
        { type: "recipe", id: milkBase, qty: "1.0000", uom: portionId },
      ],
    });
    const menuItem = await insertMenuItem("Kopi Susu Sirup", menuRecipe);

    const { deduction } = await sell([{ menuItemId: menuItem, quantity: 2 }]);
    expect(deduction).toMatchObject({ kind: "sale", status: "posted" });
    // Two cups: beans 2 x 20, milk 2 x (400 / 2), syrup 2 x (62.5 / 2).
    expect(drawn(deduction)).toEqual({
      [beans]: "40.0000",
      [milk]: "400.0000",
      [syrupItem]: "62.5000",
    });
    expect(await onHand(location, beans)).toBe("960.0000");
    expect(await onHand(location, sugar)).toBe("1000.0000");
    // 40 x 100 + 400 x 20 + 62.5 x 80 = 17,000
    expect(deduction.cost_idr).toBe("17000");
  });

  it("INV-02 converts recipe units to each item's base unit (ml -> L, ml -> L -> carton)", async () => {
    const location = await insertLocation("Bar Konversi");
    const milkLiter = await insertItem("Susu Liter", literId);
    const milkCarton = await insertItem("Susu Karton", cartonId);
    // 1 L = 1000 ml; 1 carton = 12 L (so 12000 ml).
    await insertConversion(milkLiter, literId, mlId, "1000.0000");
    await insertConversion(milkCarton, cartonId, literId, "12.0000");
    await insertConversion(milkCarton, literId, mlId, "1000.0000");
    await receive(location, milkLiter, "10.0000", "15000.0000");
    await receive(location, milkCarton, "5.0000", "180000.0000");
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: location,
    });

    const recipe = await insertRecipe({
      name: "Susu Konversi",
      yieldUomId: cupId,
      lines: [
        { id: milkLiter, qty: "250.0000", uom: mlId },
        { id: milkCarton, qty: "6000.0000", uom: mlId },
      ],
    });
    const menuItem = await insertMenuItem("Susu Konversi", recipe);

    const { deduction } = await sell([{ menuItemId: menuItem, quantity: 2 }]);
    // 2 cups: 500 ml = 0.5 L; 12000 ml = 1 carton.
    expect(drawn(deduction)).toEqual({
      [milkLiter]: "0.5000",
      [milkCarton]: "1.0000",
    });
    expect(await onHand(location, milkLiter)).toBe("9.5000");
    expect(await onHand(location, milkCarton)).toBe("4.0000");
    // 0.5 x 15.000 + 1 x 180.000
    expect(deduction.cost_idr).toBe("187500");
  });
});

describe("INV-02 modifiers and variants change what is drawn", () => {
  let kit: LatteKit;
  beforeAll(async () => {
    kit = await buildLatteKit();
  });
  beforeEach(async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
  });

  it("INV-02 draws the menu item recipe scaled by the sold quantity", async () => {
    const { deduction } = await sell([{ menuItemId: kit.latte, quantity: 2 }]);
    expect(drawn(deduction)).toEqual({
      [kit.beans]: "36.0000",
      [kit.milk]: "400.0000",
    });
    expect(deduction.cost_idr).toBe("11600");
  });

  it("INV-02 uses the variant recipe when it has one and falls back to the item recipe when it does not", async () => {
    const large = await sell([
      { menuItemId: kit.latte, variantId: kit.large, quantity: 1 },
    ]);
    expect(drawn(large.deduction)).toEqual({
      [kit.beans]: "18.0000",
      [kit.milk]: "300.0000",
    });
    const regular = await sell([
      { menuItemId: kit.latte, variantId: kit.regular, quantity: 1 },
    ]);
    expect(drawn(regular.deduction)).toEqual({
      [kit.beans]: "18.0000",
      [kit.milk]: "200.0000",
    });
  });

  it("INV-02 a modifier 'add' rule adds its component per sold unit", async () => {
    const { deduction } = await sell([
      { menuItemId: kit.latte, modifierIds: [kit.extraShot], quantity: 2 },
    ]);
    // (18 + 9) x 2 beans, milk unchanged.
    expect(drawn(deduction)).toEqual({
      [kit.beans]: "54.0000",
      [kit.milk]: "400.0000",
    });
  });

  it("INV-02 a modifier 'replace' rule swaps the target for another item (oat milk replaces milk)", async () => {
    const { deduction } = await sell([
      { menuItemId: kit.latte, modifierIds: [kit.oatMilk], quantity: 2 },
    ]);
    expect(drawn(deduction)).toEqual({
      [kit.beans]: "36.0000",
      [kit.oat]: "300.0000",
    });
    expect(deduction.lines.map((line) => line.inventory_item_id)).not.toContain(
      kit.milk,
    );
  });

  it("INV-02 a modifier 'remove' rule leaves the target out", async () => {
    const { deduction } = await sell([
      { menuItemId: kit.latte, modifierIds: [kit.noMilk], quantity: 1 },
    ]);
    expect(drawn(deduction)).toEqual({ [kit.beans]: "18.0000" });
  });

  it("INV-02 a modifier's own recipe is added as one portion per sold unit", async () => {
    const { deduction } = await sell([
      { menuItemId: kit.latte, modifierIds: [kit.syrupMod], quantity: 3 },
    ]);
    expect(drawn(deduction)).toEqual({
      [kit.beans]: "54.0000",
      [kit.milk]: "600.0000",
      [kit.syrup]: "45.0000",
    });
  });

  it("INV-02 merges several order lines into one deduction and ignores voided lines", async () => {
    const { deduction } = await sell([
      { menuItemId: kit.latte, quantity: 1 },
      { menuItemId: kit.latte, variantId: kit.large, quantity: 1 },
      { menuItemId: kit.latte, quantity: 5, voided: true },
    ]);
    expect(drawn(deduction)).toEqual({
      [kit.beans]: "36.0000",
      [kit.milk]: "500.0000",
    });
  });
});

// ------------------------------------------------------------------- modes

describe("INV-02 deduction mode: real_time vs close_of_day", () => {
  let kit: LatteKit;
  beforeAll(async () => {
    kit = await buildLatteKit();
  });

  it("INV-02 real_time posts the stock movement as soon as the order is paid", async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
    const before = await ledgerRows(kit.location, kit.beans);
    const beansBefore = await onHand(kit.location, kit.beans);
    const { deduction } = await sell([{ menuItemId: kit.latte, quantity: 2 }]);

    expect(deduction).toMatchObject({
      kind: "sale",
      status: "posted",
      mode: "real_time",
      source_type: "order",
    });
    expect(deduction.posted_at).not.toBeNull();
    expect(deduction.cost_idr).toBe("11600");
    for (const line of deduction.lines) {
      expect(line.ledger_entry_id).not.toBeNull();
      expect(line.unit_cost_idr).not.toBeNull();
    }
    const after = await ledgerRows(kit.location, kit.beans);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      movement_type: "sale",
      source_type: "order",
      quantity: "-36.0000",
    });
    expect(Number(await onHand(kit.location, kit.beans))).toBe(
      Number(beansBefore) - 36,
    );
  });

  it("INV-02 close_of_day keeps the deduction pending until day.closed posts it", async () => {
    await configureOutlet(outletA, {
      mode: "close_of_day",
      saleLocationId: kit.location,
    });
    const date = nextDate();
    const before = await ledgerRows(kit.location, kit.beans);
    const beansBefore = await onHand(kit.location, kit.beans);
    const { deduction } = await sell([{ menuItemId: kit.latte, quantity: 2 }], {
      businessDate: date,
    });

    expect(deduction).toMatchObject({
      status: "pending",
      mode: "close_of_day",
      business_date: date,
    });
    expect(deduction.posted_at).toBeNull();
    expect(deduction.cost_idr).toBeNull();
    // What will be drawn is already known, but nothing has moved.
    expect(drawn(deduction)).toEqual({
      [kit.beans]: "36.0000",
      [kit.milk]: "400.0000",
    });
    expect(await ledgerRows(kit.location, kit.beans)).toHaveLength(
      before.length,
    );
    expect(await onHand(kit.location, kit.beans)).toBe(beansBefore);

    // A day that closed before the sale does not post it.
    const earlier = new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await deliver(dayClosedEvent(outletA, earlier));
    expect((await deductionsOf(deduction.source_id))[0]!.status).toBe(
      "pending",
    );

    // Closing the sale's own day posts it.
    await deliver(dayClosedEvent(outletA, date));
    const [posted] = await deductionsOf(deduction.source_id);
    expect(posted).toMatchObject({ status: "posted", cost_idr: "11600" });
    expect(posted!.posted_at).not.toBeNull();
    const after = await ledgerRows(kit.location, kit.beans);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      movement_type: "sale",
      quantity: "-36.0000",
    });
    expect(Number(await onHand(kit.location, kit.beans))).toBe(
      Number(beansBefore) - 36,
    );
  });

  it("INV-02 day.closed of another outlet does not post this outlet's pending deductions", async () => {
    await configureOutlet(outletA, {
      mode: "close_of_day",
      saleLocationId: kit.location,
    });
    const date = nextDate();
    const { deduction } = await sell([{ menuItemId: kit.latte, quantity: 1 }], {
      businessDate: date,
    });
    await deliver(dayClosedEvent(outletB, date));
    expect((await deductionsOf(deduction.source_id))[0]!.status).toBe(
      "pending",
    );
  });

  it("INV-02 the outlet override beats the tenant setting, and an empty override follows the tenant", async () => {
    // Tenant says close_of_day, outlet says real_time => posted now.
    await withTenantMode("close_of_day", async () => {
      await configureOutlet(outletA, {
        mode: "real_time",
        saleLocationId: kit.location,
      });
      const overridden = await sell([{ menuItemId: kit.latte, quantity: 1 }]);
      expect(overridden.deduction).toMatchObject({
        status: "posted",
        mode: "real_time",
      });

      // No override => follows the tenant => pending.
      await configureOutlet(outletA, {
        mode: null,
        saleLocationId: kit.location,
      });
      const followed = await sell([{ menuItemId: kit.latte, quantity: 1 }]);
      expect(followed.deduction).toMatchObject({
        status: "pending",
        mode: "close_of_day",
      });
    });

    // Tenant says real_time, outlet says close_of_day => pending.
    await withTenantMode("real_time", async () => {
      await configureOutlet(outletA, {
        mode: "close_of_day",
        saleLocationId: kit.location,
      });
      const overridden = await sell([{ menuItemId: kit.latte, quantity: 1 }]);
      expect(overridden.deduction).toMatchObject({
        status: "pending",
        mode: "close_of_day",
      });
    });
  });
});

// ------------------------------------------------------------- idempotency

describe("INV-02 idempotent consumption", () => {
  let kit: LatteKit;
  beforeAll(async () => {
    kit = await buildLatteKit();
  });

  it("INV-02 delivering the same order.paid twice records one deduction and one set of ledger rows", async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
    const { order, event, deduction } = await sell([
      { menuItemId: kit.latte, quantity: 2 },
    ]);
    const ledger = await ledgerRows(kit.location, kit.beans);
    const beans = await onHand(kit.location, kit.beans);

    await deliver(event);
    // The same sale re-emitted under a new event id is still the same sale.
    await deliver({ ...event, id: createUlid() });

    const all = await deductionsOf(order.ulid, order.uuid);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(deduction.id);
    expect(await ledgerRows(kit.location, kit.beans)).toHaveLength(
      ledger.length,
    );
    expect(await onHand(kit.location, kit.beans)).toBe(beans);
  });

  it("INV-02 delivering day.closed twice does not post a deduction twice", async () => {
    await configureOutlet(outletA, {
      mode: "close_of_day",
      saleLocationId: kit.location,
    });
    const date = nextDate();
    const { deduction } = await sell([{ menuItemId: kit.latte, quantity: 1 }], {
      businessDate: date,
    });
    const close = dayClosedEvent(outletA, date);
    await deliver(close);
    const ledger = await ledgerRows(kit.location, kit.beans);
    const beans = await onHand(kit.location, kit.beans);
    expect(ledger.at(-1)!.quantity).toBe("-18.0000");

    await deliver(close);
    await deliver(dayClosedEvent(outletA, date));
    expect(await ledgerRows(kit.location, kit.beans)).toHaveLength(
      ledger.length,
    );
    expect(await onHand(kit.location, kit.beans)).toBe(beans);
    const [after] = await deductionsOf(deduction.source_id);
    expect(after).toMatchObject({ id: deduction.id, status: "posted" });
  });
});

// ------------------------------------------------- remake, comp, duty meal

describe("KDS-07 remake and comp consume stock", () => {
  let kit: LatteKit;
  beforeAll(async () => {
    kit = await buildLatteKit();
  });

  it("KDS-07 a remake and a comp each record their own deduction kind with a cost", async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
    const date = nextDate();
    const order = await seedOrder(outletA, date, [
      { menuItemId: kit.latte, quantity: 1 },
    ]);
    await deliver(paidEvent(order.ulid, outletA, date));

    const remakeIssue = randomUUID();
    const compIssue = randomUUID();
    const beansBefore = await onHand(kit.location, kit.beans);
    for (const [issueId, type] of [
      [remakeIssue, "remake"],
      [compIssue, "comp"],
    ] as const)
      await deliver(
        issueEvent({
          issueId,
          orderUlid: order.ulid,
          outletId: outletA,
          businessDate: date,
          type,
          menuItemId: kit.latte,
        }),
      );

    const [remake] = await deductionsOf(remakeIssue);
    const [comp] = await deductionsOf(compIssue);
    expect(remake).toMatchObject({
      kind: "remake",
      status: "posted",
      source_type: "order_issue",
      cost_idr: "5800",
    });
    expect(comp).toMatchObject({
      kind: "comp",
      status: "posted",
      source_type: "order_issue",
      cost_idr: "5800",
    });
    expect(drawn(remake!)).toEqual({
      [kit.beans]: "18.0000",
      [kit.milk]: "200.0000",
    });
    // Remake and comp draw stock on top of the original sale.
    expect(Number(await onHand(kit.location, kit.beans))).toBe(
      Number(beansBefore) - 36,
    );
    // Issue deductions store the order id as source_id too: keep the sale.
    const sale = (await deductionsOf(order.ulid, order.uuid)).filter(
      (row) => row.kind === "sale",
    );
    expect(sale).toHaveLength(1);
    expect(sale[0]!.kind).toBe("sale");
    const beansLedger = await ledgerRows(kit.location, kit.beans);
    expect(beansLedger.slice(-2).map((row) => row.movement_type)).toEqual([
      "sale",
      "sale",
    ]);

    // Redelivery of an issue records nothing more.
    await deliver(
      issueEvent({
        issueId: remakeIssue,
        orderUlid: order.ulid,
        outletId: outletA,
        businessDate: date,
        type: "remake",
        menuItemId: kit.latte,
      }),
    );
    expect(await deductionsOf(remakeIssue)).toHaveLength(1);
    expect(await ledgerRows(kit.location, kit.beans)).toHaveLength(
      beansLedger.length,
    );
  });
});

describe("INV-02 duty meal (makan karyawan) over HTTP", () => {
  let kit: LatteKit;
  let kitchen: Awaited<ReturnType<typeof signedIn>>;
  beforeAll(async () => {
    kit = await buildLatteKit();
    kitchen = await signedIn("Kitchen Lead Duty Meal");
    await assignRole(kitchen.userId, "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
  });
  beforeEach(async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
  });

  const dutyMealBody = (overrides: Record<string, unknown> = {}) => ({
    outletId: outletA,
    employeeUserId: ownerUserId,
    shiftId: null,
    menuItemId: kit.latte,
    variantId: null,
    modifierIds: [],
    quantity: 2,
    note: "Makan siang kru",
    idempotencyKey: key("duty"),
    ...overrides,
  });

  it("INV-02 requires a session, a trusted origin and a valid body", async () => {
    expect(
      (await agent(app).post("/api/inventory/duty-meals").send(dutyMealBody()))
        .status,
    ).toBe(401);
    expect(
      (
        await kitchen.client
          .post("/api/inventory/duty-meals")
          .send(dutyMealBody())
      ).status,
    ).toBe(403);
    const zero = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send(dutyMealBody({ quantity: 0 }));
    expect(zero.status).toBe(422);
    const extra = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send({ ...dutyMealBody(), costIdr: 1 });
    expect(extra.status).toBe(422);
    // The beneficiary must belong to this tenant.
    const stranger = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send(dutyMealBody({ employeeUserId: await insertUser("Stranger") }));
    expect(stranger.status).toBe(422);
    // A kitchen lead of outlet A cannot record a duty meal for outlet B.
    const otherOutlet = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send(dutyMealBody({ outletId: outletB }));
    expect(otherOutlet.status).toBe(403);
  });

  it("INV-02 records a duty meal as its own kind, moves stock as duty_meal and replays safely", async () => {
    const beansBefore = await onHand(kit.location, kit.beans);
    const ledgerBefore = await ledgerRows(kit.location, kit.beans);
    const body = dutyMealBody();
    const created = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send(body);
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const meal = created.body.data;
    expect(meal).toMatchObject({
      kind: "duty_meal",
      status: "posted",
      sourceType: "duty_meal",
      outletId: outletA,
      recordedBy: kitchen.userId,
    });
    expect(meal.sourceId).toBe(meal.id);
    expect(meal.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The kitchen lead has no inventory.cost.view: no cost is revealed.
    expect([null, 0]).toContain(meal.costIdr);

    const ledger = await ledgerRows(kit.location, kit.beans);
    expect(ledger).toHaveLength(ledgerBefore.length + 1);
    expect(ledger.at(-1)).toMatchObject({
      movement_type: "duty_meal",
      source_type: "duty_meal",
      quantity: "-36.0000",
    });
    expect(Number(await onHand(kit.location, kit.beans))).toBe(
      Number(beansBefore) - 36,
    );

    // Same idempotency key: same deduction, no second draw.
    const replay = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send(body);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.id).toBe(meal.id);
    expect(await ledgerRows(kit.location, kit.beans)).toHaveLength(
      ledger.length,
    );

    // The stored cost (owner view) is the real cost: 2 x Rp5.800.
    const [stored] = await deductionsOf(meal.id);
    expect(stored).toMatchObject({ kind: "duty_meal", cost_idr: "11600" });
  });

  it("INV-02 lists deductions separately by kind and keeps outlets apart", async () => {
    const date = nextDate();
    const sale = await sell([{ menuItemId: kit.latte, quantity: 1 }], {
      businessDate: date,
    });
    const meal = await kitchen.client
      .post("/api/inventory/duty-meals")
      .set(originHeader)
      .send(dutyMealBody({ quantity: 1 }));
    expect(meal.status).toBeLessThan(300);

    const list = async (query: string) => {
      const response = await kitchen.client.get(
        `/api/inventory/recipe-deductions?outletId=${outletA}${query}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body.data as { id: string; kind: string }[];
    };
    const duty = await list("&kind=duty_meal");
    expect(duty.length).toBeGreaterThan(0);
    expect(duty.every((row) => row.kind === "duty_meal")).toBe(true);
    expect(duty.map((row) => row.id)).toContain(meal.body.data.id);
    const sales = await list("&kind=sale");
    expect(sales.every((row) => row.kind === "sale")).toBe(true);
    expect(sales.map((row) => row.id)).toContain(sale.deduction.id);
    expect(sales.map((row) => row.id)).not.toContain(meal.body.data.id);
    const byDate = await list(`&businessDate=${date}`);
    expect(byDate.map((row) => row.id)).toContain(sale.deduction.id);
    expect(byDate.map((row) => row.id)).not.toContain(meal.body.data.id);

    // An outlet-A-only user is refused outlet B's deductions.
    const refused = await kitchen.client.get(
      `/api/inventory/recipe-deductions?outletId=${outletB}`,
    );
    expect(refused.status).toBe(403);
  });
});

// ------------------------------------------------------------ skipped sales

describe("INV-02 sales that cannot deduct are skipped, never thrown", () => {
  let kit: LatteKit;
  beforeAll(async () => {
    kit = await buildLatteKit();
  });
  beforeEach(async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
  });

  async function expectSkipped(
    lines: SaleLine[],
    reason: string,
  ): Promise<void> {
    const beans = await ledgerRows(kit.location, kit.beans);
    const milk = await ledgerRows(kit.location, kit.milk);
    const { order, event, deduction } = await sell(lines);
    expect(deduction).toMatchObject({
      kind: "sale",
      status: "skipped",
      skip_reason: reason,
    });
    expect(deduction.lines).toEqual([]);
    expect(deduction.posted_at).toBeNull();
    expect(await ledgerRows(kit.location, kit.beans)).toHaveLength(
      beans.length,
    );
    expect(await ledgerRows(kit.location, kit.milk)).toHaveLength(milk.length);
    // Redelivery stays a no-op and does not throw either.
    await deliver(event);
    expect(await deductionsOf(order.ulid, order.uuid)).toHaveLength(1);
  }

  it("INV-02 a menu item without a recipe is skipped as no_recipe", async () => {
    const menuItem = await insertMenuItem("Tanpa Resep", null);
    await expectSkipped([{ menuItemId: menuItem, quantity: 1 }], "no_recipe");
  });

  it("INV-02 an outlet without a sale location is skipped as no_sale_location", async () => {
    await configureOutlet(outletA, { mode: "real_time", saleLocationId: null });
    await expectSkipped(
      [{ menuItemId: kit.latte, quantity: 1 }],
      "no_sale_location",
    );
  });

  it("INV-02 an inactive recipe is skipped as recipe_inactive", async () => {
    const recipe = await insertRecipe({
      name: "Resep Nonaktif",
      yieldUomId: cupId,
      isActive: false,
      lines: [{ id: kit.beans, qty: "10.0000", uom: gramId }],
    });
    const menuItem = await insertMenuItem("Menu Nonaktif", recipe);
    await expectSkipped(
      [{ menuItemId: menuItem, quantity: 1 }],
      "recipe_inactive",
    );
  });

  it("INV-02 a recipe that contains itself through another recipe is skipped as recipe_error", async () => {
    const a = await insertRecipe({
      name: "Siklus A",
      yieldUomId: portionId,
      lines: [{ id: kit.beans, qty: "10.0000", uom: gramId }],
    });
    const b = await insertRecipe({
      name: "Siklus B",
      yieldUomId: portionId,
      lines: [{ type: "recipe", id: a, qty: "1.0000", uom: portionId }],
    });
    await addRecipeLines(a, [
      { type: "recipe", id: b, qty: "1.0000", uom: portionId },
    ]);
    const menuItem = await insertMenuItem("Menu Siklus", a);
    await expectSkipped(
      [{ menuItemId: menuItem, quantity: 1 }],
      "recipe_error",
    );
  });
});

// ----------------------------------------------------------------- HTTP API

describe("INV-02 recipe and outlet deduction settings API", () => {
  let admin: Awaited<ReturnType<typeof signedIn>>;
  beforeAll(async () => {
    admin = await signedIn("Recipe Owner");
    await assignRole(admin.userId, "owner", { type: "tenant" });
  });

  it("INV-02 creates a recipe, edits it into a new version and sells with the latest version", async () => {
    const location = await insertLocation("Bar Resep API");
    const beans = await insertItem("Biji API", gramId);
    await receive(location, beans, "1000.0000", "100.0000");
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: location,
    });

    expect((await agent(app).get("/api/inventory/recipes")).status).toBe(401);

    const create = {
      brandId: brandA,
      name: `Kopi Hitam ${short()}`,
      outputItemId: null,
      yieldQuantity: "1.0000",
      yieldUomId: cupId,
      lines: [
        {
          componentType: "item",
          componentId: beans,
          quantity: "10.0000",
          uomId: gramId,
          wastePctBp: 0,
        },
      ],
      idempotencyKey: key("recipe"),
    };
    const created = await admin.client
      .post("/api/inventory/recipes")
      .set(originHeader)
      .send(create);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recipeId = created.body.data.recipe.id as string;
    expect(created.body.data.recipe.version).toBe(1);
    expect(created.body.data.lines).toHaveLength(1);

    // Replaying the same request returns the same recipe.
    const replay = await admin.client
      .post("/api/inventory/recipes")
      .set(originHeader)
      .send(create);
    expect(replay.status).toBeLessThan(300);
    expect(replay.body.data.recipe.id).toBe(recipeId);

    // A recipe may not contain itself (a line pointing at a missing recipe is
    // refused as well).
    const missing = await admin.client
      .post("/api/inventory/recipes")
      .set(originHeader)
      .send({
        ...create,
        idempotencyKey: key("recipe"),
        lines: [
          {
            componentType: "recipe",
            componentId: randomUUID(),
            quantity: "1.0000",
            uomId: cupId,
            wastePctBp: 0,
          },
        ],
      });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);

    const menuItem = await insertMenuItem("Kopi Hitam", recipeId);
    const first = await sell([{ menuItemId: menuItem, quantity: 1 }]);
    expect(drawn(first.deduction)).toEqual({ [beans]: "10.0000" });

    const version = await admin.client
      .post(`/api/inventory/recipes/${recipeId}/versions`)
      .set(originHeader)
      .send({
        lines: [
          {
            componentType: "item",
            componentId: beans,
            quantity: "12.0000",
            uomId: gramId,
            wastePctBp: 0,
          },
        ],
        changeNote: "Lebih kuat",
        idempotencyKey: key("recipe-version"),
      });
    expect(version.status, JSON.stringify(version.body)).toBeLessThan(300);
    expect(version.body.data.recipe).toMatchObject({
      id: recipeId,
      version: 2,
    });

    const detail = await admin.client.get(`/api/inventory/recipes/${recipeId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.recipe.version).toBe(2);
    expect(detail.body.data.lines[0].quantity).toBe("12.0000");

    const list = await admin.client.get("/api/inventory/recipes");
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((row) => row.id)).toContain(
      recipeId,
    );

    // Sales after the edit use the new version.
    const second = await sell([{ menuItemId: menuItem, quantity: 1 }]);
    expect(drawn(second.deduction)).toEqual({ [beans]: "12.0000" });
    // The sale before the edit keeps what it drew.
    expect(drawn((await deductionsOf(first.deduction.source_id))[0]!)).toEqual({
      [beans]: "10.0000",
    });
  });

  it("INV-02 reads and saves the per-outlet sale location and mode", async () => {
    const saleLocation = await insertLocation("Lokasi Jual API");
    const otherOutletLocation = await insertLocation(
      "Lokasi Outlet B",
      outletB,
    );
    const path = `/api/inventory/outlets/${outletA}/deduction-settings`;
    expect((await agent(app).get(path)).status).toBe(401);

    const saved = await admin.client.put(path).set(originHeader).send({
      recipeDeductionMode: "close_of_day",
      saleLocationId: saleLocation,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data).toMatchObject({
      outletId: outletA,
      recipeDeductionMode: "close_of_day",
      effectiveMode: "close_of_day",
      saleLocationId: saleLocation,
    });
    const read = await admin.client.get(path);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      recipeDeductionMode: "close_of_day",
      saleLocationId: saleLocation,
    });

    // No override: the effective mode is the tenant's.
    const followTenant = await withTenantMode("real_time", async () => {
      const response = await admin.client
        .put(path)
        .set(originHeader)
        .send({ recipeDeductionMode: null, saleLocationId: saleLocation });
      expect(response.status).toBe(200);
      return response.body.data;
    });
    expect(followTenant).toMatchObject({
      recipeDeductionMode: null,
      effectiveMode: "real_time",
    });

    // The sale location must belong to the outlet.
    const foreign = await admin.client
      .put(path)
      .set(originHeader)
      .send({ recipeDeductionMode: null, saleLocationId: otherOutletLocation });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    // Strict body.
    const extra = await admin.client
      .put(path)
      .set(originHeader)
      .send({ recipeDeductionMode: null, saleLocationId: null, other: 1 });
    expect(extra.status).toBe(422);
    // Mutations need the trusted origin.
    expect(
      (
        await admin.client
          .put(path)
          .send({ recipeDeductionMode: null, saleLocationId: null })
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------- isolation

describe("TEN-01 TEN-03 INV-02 tenant and outlet isolation", () => {
  let kit: LatteKit;
  let recipeA: string;
  let staffB: Staff;
  let hostB: string;

  beforeAll(async () => {
    kit = await buildLatteKit();
    const { rows } = await owner.query<{ recipe_id: string }>(
      "SELECT recipe_id FROM menu_items WHERE tenant_id = $1 AND id = $2",
      [tenantA, kit.latte],
    );
    recipeA = rows[0]!.recipe_id;
    tenantB = await createIsolatedTenant(`bom${short()}`);
    hostB = tenantB.hostname;
    // Give tenant B's owner the permissions that would let it read recipes.
    await owner.query(
      "UPDATE roles SET permissions = $2::jsonb WHERE id = $1",
      [
        tenantB.roleId,
        JSON.stringify([
          "recipe.manage",
          "inventory.stock.view",
          "inventory.waste.record",
        ]),
      ],
    );
    staffB = await staffOfIsolatedTenant(app, tenantB);
  });

  it("INV-02 row level security hides tenant A's recipe data from tenant B", async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
    await sell([{ menuItemId: kit.latte, quantity: 1 }]);
    const tables = [
      "recipes",
      "recipe_lines",
      "modifier_recipe_rules",
      "outlet_inventory_settings",
      "recipe_deductions",
      "recipe_deduction_lines",
    ];
    for (const table of tables) {
      const exists = await owner.query(
        `SELECT 1 FROM ${table} WHERE tenant_id = $1 LIMIT 1`,
        [tenantA],
      );
      expect(exists.rows, `${table} has tenant A rows`).toHaveLength(1);
      const seen = await asTenant(tenantB!.tenantId, "[]", (query) =>
        query(`SELECT 1 FROM ${table}`),
      );
      expect(seen.rows, `${table} visible to tenant B`).toHaveLength(0);
    }
  });

  it("INV-02 row level security hides one outlet's deductions from a session scoped to another outlet", async () => {
    const locationB = await insertLocation("Bar Outlet B", outletB);
    for (const [item, cost] of [
      [kit.beans, "100.0000"],
      [kit.milk, "20.0000"],
    ] as const)
      await receive(locationB, item, "1000.0000", cost, outletB);
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
    await configureOutlet(outletB, {
      mode: "real_time",
      saleLocationId: locationB,
    });
    const saleA = await sell([{ menuItemId: kit.latte, quantity: 1 }]);
    const saleB = await sell([{ menuItemId: kit.latte, quantity: 1 }], {
      outletId: outletB,
    });
    expect(saleA.deduction.status).toBe("posted");
    expect(saleB.deduction.status).toBe("posted");

    const idsFor = async (outlets: string[]) =>
      asTenant(tenantA, JSON.stringify(outlets), async (query) =>
        (
          await query(
            "SELECT id FROM recipe_deductions WHERE id IN ('" +
              saleA.deduction.id +
              "', '" +
              saleB.deduction.id +
              "')",
          )
        ).rows.map((row) => row.id),
      );
    expect(await idsFor([outletA])).toEqual([saleA.deduction.id]);
    expect(await idsFor([outletB])).toEqual([saleB.deduction.id]);
    const lineRows = await asTenant(
      tenantA,
      JSON.stringify([outletB]),
      (query) =>
        query(
          `SELECT 1 FROM recipe_deduction_lines WHERE deduction_id = '${saleA.deduction.id}'`,
        ),
    );
    expect(lineRows.rows).toHaveLength(0);
    const settings = await asTenant(
      tenantA,
      JSON.stringify([outletB]),
      (query) =>
        query(
          `SELECT outlet_id FROM outlet_inventory_settings WHERE outlet_id = '${outletA}'`,
        ),
    );
    expect(settings.rows).toHaveLength(0);
  });

  it("INV-02 tenant B cannot read tenant A's recipes, deductions or outlet settings through the API", async () => {
    await configureOutlet(outletA, {
      mode: "real_time",
      saleLocationId: kit.location,
    });
    const asB = (path: string) => staffB.client.get(path).set("Host", hostB);

    const detail = await asB(`/api/inventory/recipes/${recipeA}`);
    expect([403, 404]).toContain(detail.status);
    expect(JSON.stringify(detail.body)).not.toContain(kit.beans);

    const list = await asB("/api/inventory/recipes");
    if (list.status === 200)
      expect(
        (list.body.data as { id: string }[]).map((row) => row.id),
      ).not.toContain(recipeA);
    else expect(list.status).toBe(403);

    const deductions = await asB(
      `/api/inventory/recipe-deductions?outletId=${outletA}`,
    );
    expect([403, 404]).toContain(deductions.status);

    const settings = await asB(
      `/api/inventory/outlets/${outletA}/deduction-settings`,
    );
    expect([403, 404]).toContain(settings.status);

    const write = await staffB.client
      .put(`/api/inventory/outlets/${outletA}/deduction-settings`)
      .set("Host", hostB)
      .set(originHeader)
      .send({ recipeDeductionMode: "close_of_day", saleLocationId: null });
    expect([403, 404]).toContain(write.status);
    const unchanged = await owner.query<{
      recipe_deduction_mode: string | null;
    }>(
      "SELECT recipe_deduction_mode FROM outlet_inventory_settings WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantA, outletA],
    );
    expect(unchanged.rows[0]?.recipe_deduction_mode).toBe("real_time");
  });
});
