// Re-posting skipped recipe deductions (bead legend-q55i; INV-02). A sale or
// order issue whose deduction was skipped (`no_sale_location`, `no_recipe`,
// `recipe_inactive`, `recipe_error`) can be re-posted once the configuration is
// fixed: POST /api/inventory/outlets/:outletId/recipe-deductions/repost-skipped
// { businessDate } -> { reposted, stillSkipped }, permission
// `inventory.adjustment.approve`; GET .../recipe-deductions/skipped-summary
// ?businessDate= lists the skipped count per skip reason.
//
// Written from the brief and the shared role catalogue, not from the service.
// Runs against the disposable PostgreSQL test database in a tenant this file
// creates and removes again (same harness as recipe-bom.test.ts).
//
// Assumptions where the brief is silent:
// - Routes live under `/api/inventory` like the other recipe routes and answer
//   `{ data: ... }`.
// - `reposted` / `stillSkipped` are counts (a number); a list of rows is also
//   accepted (its length is used).
// - The skipped-summary body is `data.byReason = { <skip_reason>: <count> }`;
//   `data.counts`, `data` itself as a map, or a list of
//   `{ skipReason, count }` are also accepted. Reasons with no skipped row are
//   absent or 0.
// - A repost that is still wrong keeps `status = 'skipped'` on the same row
//   (the reason MAY be refreshed, so only the status is asserted).
// - A training order is flagged after its deduction was skipped (a pos_orders
//   row inserted under session_replication_role = replica), modelling a row
//   that predates the training rule. Repost must never post it.
// - Roles: `owner` (tenant scope) and `outlet_manager` (outlet scope) hold
//   inventory.adjustment.approve; `kitchen_lead` does not.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  orderIssueRecordedPayloadSchema,
  type OrderIssueType,
} from "@starter/shared/inventory";
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
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const tenantA = randomUUID();
const brandA = randomUUID();
const legalEntityA = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const slugA = `rpo${randomUUID().slice(0, 8)}`;
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

// Each test books on its own far-future business date.
let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2032, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

let ownerUserId: string;
let gramId: string;
let mlId: string;
let portionId: string;
let categoryId: string;
let tenantB: IsolatedTenant | null = null;

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
  outletId: string,
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
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

async function configureOutlet(
  outletId: string,
  saleLocationId: string | null,
) {
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time',
                   sale_location_id = EXCLUDED.sale_location_id`,
    [tenantA, outletId, saleLocationId],
  );
}

async function insertRecipe(input: {
  isActive?: boolean;
  lines: { type?: "item" | "recipe"; id: string; qty: string; uom: string }[];
}): Promise<string> {
  const recipeId = await one<string>(
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, $5, $6) RETURNING id`,
    [
      tenantA,
      brandA,
      `Resep ${short()}`,
      portionId,
      input.isActive ?? true,
      ownerUserId,
    ],
  );
  for (const [index, line] of input.lines.entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [
        tenantA,
        recipeId,
        index,
        line.type ?? "item",
        line.id,
        line.qty,
        line.uom,
      ],
    );
  return recipeId;
}

async function insertMenuItem(recipeId: string | null): Promise<string> {
  return one<string>(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [tenantA, brandA, categoryId, `Menu ${short()}`, recipeId, randomUUID()],
  );
}

type Kit = Awaited<ReturnType<typeof buildKit>>;

/**
 * A stock location of `outletId` holding 1.000 g beans (Rp100/g) and 10.000 ml
 * milk (Rp20/ml), and a Latte (18 g beans + 200 ml milk, Rp5.800 a cup).
 */
async function buildKit(outletId = outletA) {
  const location = await one<string>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenantA, outletId, `Bar Repost ${short()}`],
  );
  const beans = await insertItem("Biji Kopi", gramId);
  const milk = await insertItem("Susu", mlId);
  await receive(outletId, location, beans, "1000.0000", "100.0000");
  await receive(outletId, location, milk, "10000.0000", "20.0000");
  const recipe = await insertRecipe({
    lines: [
      { id: beans, qty: "18.0000", uom: gramId },
      { id: milk, qty: "200.0000", uom: mlId },
    ],
  });
  const latte = await insertMenuItem(recipe);
  return { outletId, location, beans, milk, recipe, latte };
}

/** A paid order of `quantity` units of `menuItemId`, as the POS leaves it. */
async function seedOrder(
  outletId: string,
  businessDate: string,
  menuItemId: string,
  quantity: number,
): Promise<{ ulid: string; uuid: string; itemId: string }> {
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const itemId = randomUUID();
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
        status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', 0, 0, 0, 0, 0, 0, 'completed', $5, now())`,
    [uuid, tenantA, outletId, `RPO-${randomUUID().slice(0, 12)}`, businessDate],
  );
  await owner.query(
    `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
        quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
        fire_status, status, reserved_business_date)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Item', $6, 0, 0, 0, '[]'::jsonb, 'fired', 'served', $7)`,
    [itemId, tenantA, outletId, uuid, menuItemId, quantity, businessDate],
  );
  return { ulid, uuid, itemId };
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
  return envelope({
    name: "order.paid",
    aggregateType: "order",
    aggregateId: orderUlid,
    outletId,
    idempotencyKey: `order.paid:${orderUlid}`,
    payload: orderPaidPayloadSchema.parse({
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
    }),
  });
}

function issueEvent(input: {
  issueId: string;
  orderUlid: string;
  outletId: string;
  businessDate: string;
  type: OrderIssueType;
  menuItemId: string;
  orderItemId?: string;
}) {
  return envelope({
    name: "order_issue.recorded",
    aggregateType: "order_issue",
    aggregateId: input.issueId,
    outletId: input.outletId,
    idempotencyKey: `order_issue.recorded:${input.issueId}`,
    payload: orderIssueRecordedPayloadSchema.parse({
      issueId: input.issueId,
      orderId: input.orderUlid,
      orderItemId: input.orderItemId ?? randomUUID(),
      outletId: input.outletId,
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

type DeductionRow = {
  id: string;
  kind: string;
  status: string;
  skip_reason: string | null;
  cost_idr: string | null;
  lines: { inventory_item_id: string; quantity: string }[];
};

async function deductionsOf(...sourceIds: string[]): Promise<DeductionRow[]> {
  const { rows } = await owner.query<Omit<DeductionRow, "lines">>(
    `SELECT id, kind, status, skip_reason, cost_idr::text AS cost_idr
       FROM recipe_deductions WHERE tenant_id = $1
        AND (source_id = ANY($2::text[]) OR idempotency_key = ANY($3::text[]))
      ORDER BY created_at, id`,
    [tenantA, sourceIds, sourceIds.map((id) => `order_issue:${id}`)],
  );
  const result: DeductionRow[] = [];
  for (const row of rows) {
    const lines = await owner.query<DeductionRow["lines"][number]>(
      `SELECT inventory_item_id, quantity::text AS quantity
         FROM recipe_deduction_lines WHERE tenant_id = $1 AND deduction_id = $2`,
      [tenantA, row.id],
    );
    result.push({ ...row, lines: lines.rows });
  }
  return result;
}

const drawn = (deduction: DeductionRow) =>
  Object.fromEntries(
    deduction.lines.map((line) => [line.inventory_item_id, line.quantity]),
  );

async function onHand(locationId: string, itemId: string): Promise<string> {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? "0.0000";
}

async function ledgerCount(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM stock_ledger
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [tenantA, locationId, itemId],
  );
  return Number(rows[0]!.n);
}

/** Both kit items: [beans on hand, milk on hand, beans ledger rows, milk ledger rows]. */
async function stockOf(kit: Kit) {
  return [
    await onHand(kit.location, kit.beans),
    await onHand(kit.location, kit.milk),
    await ledgerCount(kit.location, kit.beans),
    await ledgerCount(kit.location, kit.milk),
  ];
}

/**
 * Sells `quantity` units on a fresh business date and returns the sale's
 * deduction row (the consumer never throws on a skip, it records it).
 */
async function sell(
  outletId: string,
  menuItemId: string,
  options: { businessDate?: string; quantity?: number } = {},
) {
  const businessDate = options.businessDate ?? nextDate();
  const order = await seedOrder(
    outletId,
    businessDate,
    menuItemId,
    options.quantity ?? 2,
  );
  const event = paidEvent(order.ulid, outletId, businessDate);
  await deliver(event);
  const deduction = (await deductionsOf(order.ulid, order.uuid)).find(
    (row) => row.kind === "sale",
  );
  if (!deduction) throw new Error("order.paid recorded no deduction");
  return { order, event, businessDate, deduction };
}

// -------------------------------------------------------------- HTTP helpers

const repostPath = (outletId: string) =>
  `/api/inventory/outlets/${outletId}/recipe-deductions/repost-skipped`;
const summaryPath = (outletId: string, businessDate: string) =>
  `/api/inventory/outlets/${outletId}/recipe-deductions/skipped-summary?businessDate=${businessDate}`;

type Session = { client: ReturnType<typeof agent>; userId: string };

function repost(
  who: Session,
  outletId: string,
  businessDate: string,
  host?: string,
) {
  const req = who.client.post(repostPath(outletId));
  if (host) req.set("Host", host);
  return req.set(originHeader).send({ businessDate });
}

/** `reposted` / `stillSkipped` as a number, whether sent as a count or a list. */
const count = (value: unknown): number =>
  Array.isArray(value) ? value.length : Number(value);

function summaryCount(data: unknown, reason: string): number {
  if (Array.isArray(data)) {
    const entry = (data as Record<string, unknown>[]).find(
      (row) => (row.skipReason ?? row.reason) === reason,
    );
    return entry ? Number(entry.count) : 0;
  }
  const record = data as Record<string, unknown>;
  const map = (record.byReason ?? record.counts ?? record) as Record<
    string,
    unknown
  >;
  return Number(map[reason] ?? 0);
}

// ------------------------------------------------------------- users & roles

const createdUserIds: string[] = [];

async function roleIdOf(templateKey: string): Promise<string> {
  return one<string>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
}

async function signedIn(
  name: string,
  templateKey: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  client.set("Host", hostA);
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
  return { client, userId };
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
  for (const [index, outletId] of [outletA, outletB].entries())
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
      [
        outletId,
        tenantA,
        brandA,
        legalEntityA,
        `R${slugA.slice(3)}${index}`.toUpperCase(),
        `Outlet ${slugA} ${index}`,
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

let admin: Session;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await createOwnTenant();
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "Repost Owner", `${ownerUserId}@example.com`],
  );
  createdUserIds.push(ownerUserId);
  const uom = (code: string) =>
    one<string>(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  gramId = await uom("g");
  mlId = await uom("ml");
  portionId = await uom("porsi");
  categoryId = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Repost Uji', 0)",
    [categoryId, tenantA, brandA],
  );
  admin = await signedIn("Repost Admin", "owner", { type: "tenant" });
});

beforeEach(async () => {
  await owner.query(
    "DELETE FROM recipe_deductions WHERE tenant_id = $1 AND status = 'pending'",
    [tenantA],
  );
});

afterAll(async () => {
  if (tenantB) await dropIsolatedTenant(tenantB);
  await dropOwnTenant();
  await owner.end();
});

// ------------------------------------------------- one case per skip reason

type Reason =
  "no_sale_location" | "no_recipe" | "recipe_inactive" | "recipe_error";

type SkippedCase = {
  reason: Reason;
  /** Builds the sale that gets skipped and the way an operator fixes it. */
  build: (kit: Kit) => Promise<{ menuItem: string; fix: () => Promise<void> }>;
  saleLocation: (kit: Kit) => string | null;
};

const latteLines = (kit: Kit) => [
  { id: kit.beans, qty: "18.0000", uom: gramId },
  { id: kit.milk, qty: "200.0000", uom: mlId },
];

const cases: SkippedCase[] = [
  {
    reason: "no_sale_location",
    saleLocation: () => null,
    build: async (kit) => ({
      menuItem: kit.latte,
      fix: () => configureOutlet(kit.outletId, kit.location),
    }),
  },
  {
    reason: "no_recipe",
    saleLocation: (kit) => kit.location,
    build: async (kit) => {
      const menuItem = await insertMenuItem(null);
      return {
        menuItem,
        fix: async () => {
          await owner.query(
            "UPDATE menu_items SET recipe_id = $3 WHERE tenant_id = $1 AND id = $2",
            [tenantA, menuItem, kit.recipe],
          );
        },
      };
    },
  },
  {
    reason: "recipe_inactive",
    saleLocation: (kit) => kit.location,
    build: async (kit) => {
      const recipe = await insertRecipe({
        isActive: false,
        lines: latteLines(kit),
      });
      return {
        menuItem: await insertMenuItem(recipe),
        fix: async () => {
          await owner.query(
            "UPDATE recipes SET is_active = true WHERE tenant_id = $1 AND id = $2",
            [tenantA, recipe],
          );
        },
      };
    },
  },
  {
    reason: "recipe_error",
    saleLocation: (kit) => kit.location,
    build: async (kit) => {
      // A contains B and B contains A: a cycle. The fix removes A's line to B.
      const a = await insertRecipe({ lines: latteLines(kit) });
      const b = await insertRecipe({
        lines: [{ type: "recipe", id: a, qty: "1.0000", uom: portionId }],
      });
      await owner.query(
        `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
         VALUES ($1, $2, 9, 'recipe', $3, 1, $4, 0)`,
        [tenantA, a, b, portionId],
      );
      return {
        menuItem: await insertMenuItem(a),
        fix: async () => {
          await owner.query(
            "DELETE FROM recipe_lines WHERE tenant_id = $1 AND recipe_id = $2 AND component_type = 'recipe'",
            [tenantA, a],
          );
        },
      };
    },
  },
];

/** A kit, a skipped sale of 2 units for `skippedCase`, and its stock snapshot. */
async function skippedSale(skippedCase: SkippedCase, outletId = outletA) {
  const kit = await buildKit(outletId);
  const { menuItem, fix } = await skippedCase.build(kit);
  await configureOutlet(outletId, skippedCase.saleLocation(kit));
  const sale = await sell(outletId, menuItem);
  expect(sale.deduction).toMatchObject({
    status: "skipped",
    skip_reason: skippedCase.reason,
  });
  return { kit, fix, sale, stockBefore: await stockOf(kit) };
}

// ===========================================================================

describe("INV-02 repost of skipped deductions: fixed configuration posts the same row once", () => {
  for (const skippedCase of cases)
    it(`INV-02 repost posts a sale skipped as ${skippedCase.reason} once the cause is fixed`, async () => {
      const { kit, fix, sale, stockBefore } = await skippedSale(skippedCase);
      await fix();

      const response = await repost(admin, kit.outletId, sale.businessDate);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(count(response.body.data.reposted)).toBe(1);
      expect(count(response.body.data.stillSkipped)).toBe(0);

      // The SAME row became posted (no second row), with the recipe's lines.
      const rows = await deductionsOf(sale.order.ulid, sale.order.uuid);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: sale.deduction.id,
        kind: "sale",
        status: "posted",
        skip_reason: null,
        cost_idr: "11600",
      });
      expect(drawn(rows[0]!)).toEqual({
        [kit.beans]: "36.0000",
        [kit.milk]: "400.0000",
      });
      // Stock left the bin exactly once: 2 x (18 g beans, 200 ml milk).
      expect(Number(await onHand(kit.location, kit.beans))).toBe(
        Number(stockBefore[0]) - 36,
      );
      expect(Number(await onHand(kit.location, kit.milk))).toBe(
        Number(stockBefore[1]) - 400,
      );
      expect(await ledgerCount(kit.location, kit.beans)).toBe(
        Number(stockBefore[2]) + 1,
      );
      expect(await ledgerCount(kit.location, kit.milk)).toBe(
        Number(stockBefore[3]) + 1,
      );
    });

  it("INV-02 a skipped remake (order issue) is reposted from its order issue and order line", async () => {
    const kit = await buildKit();
    await configureOutlet(outletA, null);
    const date = nextDate();
    const order = await seedOrder(outletA, date, kit.latte, 1);
    // The issue and its order line are the source of truth for the repost.
    const issueId = await one<string>(
      `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
          reason_note, employee_id, reported_by, cost_idr, idempotency_key, status)
       VALUES ($1, $2, $3, $4, 'remake', 'quality', 'uji repost', $5, $5, 0, $6, 'open')
       RETURNING id`,
      [tenantA, outletA, order.uuid, order.itemId, ownerUserId, randomUUID()],
    );
    await deliver(
      issueEvent({
        issueId,
        orderUlid: order.ulid,
        orderItemId: order.itemId,
        outletId: outletA,
        businessDate: date,
        type: "remake",
        menuItemId: kit.latte,
      }),
    );
    const [skipped] = await deductionsOf(issueId);
    expect(skipped).toMatchObject({
      kind: "remake",
      status: "skipped",
      skip_reason: "no_sale_location",
    });
    const before = await stockOf(kit);

    await configureOutlet(outletA, kit.location);
    const response = await repost(admin, outletA, date);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(1);

    const rows = await deductionsOf(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: skipped!.id,
      kind: "remake",
      status: "posted",
    });
    expect(drawn(rows[0]!)).toEqual({
      [kit.beans]: "18.0000",
      [kit.milk]: "200.0000",
    });
    expect(Number(await onHand(kit.location, kit.beans))).toBe(
      Number(before[0]) - 18,
    );
  });
});

describe("INV-02 repost is idempotent: stock is deducted once, never twice", () => {
  it("INV-02 reposting twice leaves the same balance, ledger and row as reposting once", async () => {
    const skippedCase = cases[0]!;
    const { kit, fix, sale, stockBefore } = await skippedSale(skippedCase);
    await fix();

    const first = await repost(admin, kit.outletId, sale.businessDate);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(count(first.body.data.reposted)).toBe(1);
    const afterFirst = await stockOf(kit);
    expect(Number(afterFirst[0])).toBe(Number(stockBefore[0]) - 36);

    const second = await repost(admin, kit.outletId, sale.businessDate);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(count(second.body.data.reposted)).toBe(0);
    expect(count(second.body.data.stillSkipped)).toBe(0);
    expect(await stockOf(kit)).toEqual(afterFirst);

    const rows = await deductionsOf(sale.order.ulid, sale.order.uuid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: sale.deduction.id, status: "posted" });
    expect(drawn(rows[0]!)).toEqual({
      [kit.beans]: "36.0000",
      [kit.milk]: "400.0000",
    });
  });

  it("INV-02 redelivering order.paid after a repost does not deduct again", async () => {
    const { kit, fix, sale } = await skippedSale(cases[0]!);
    await fix();
    expect((await repost(admin, kit.outletId, sale.businessDate)).status).toBe(
      200,
    );
    const afterRepost = await stockOf(kit);

    await deliver(sale.event);

    expect(await stockOf(kit)).toEqual(afterRepost);
    expect(await deductionsOf(sale.order.ulid, sale.order.uuid)).toHaveLength(
      1,
    );
  });

  it("INV-02 a deduction that was already posted is never touched by a repost", async () => {
    const kit = await buildKit();
    await configureOutlet(outletA, kit.location);
    const sale = await sell(outletA, kit.latte, { quantity: 1 });
    expect(sale.deduction.status).toBe("posted");
    const before = await stockOf(kit);

    const response = await repost(admin, outletA, sale.businessDate);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(0);
    expect(count(response.body.data.stillSkipped)).toBe(0);
    expect(await stockOf(kit)).toEqual(before);
    expect(await deductionsOf(sale.order.ulid, sale.order.uuid)).toHaveLength(
      1,
    );
  });

  it("INV-02 an outlet-and-date with nothing skipped answers 200 with zero counts", async () => {
    const response = await repost(admin, outletA, nextDate());
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(0);
    expect(count(response.body.data.stillSkipped)).toBe(0);
  });
});

describe("INV-02 repost keeps a deduction skipped while the cause is still there", () => {
  for (const skippedCase of cases)
    it(`INV-02 ${skippedCase.reason} stays skipped, without stock effect, until it is fixed`, async () => {
      const { kit, fix, sale, stockBefore } = await skippedSale(skippedCase);

      // Nothing fixed yet: still skipped on the same row, stock untouched.
      const response = await repost(admin, kit.outletId, sale.businessDate);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(count(response.body.data.reposted)).toBe(0);
      expect(count(response.body.data.stillSkipped)).toBe(1);
      const rows = await deductionsOf(sale.order.ulid, sale.order.uuid);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: sale.deduction.id,
        status: "skipped",
      });
      expect(rows[0]!.lines).toEqual([]);
      expect(await stockOf(kit)).toEqual(stockBefore);

      // A second try is just as harmless.
      const again = await repost(admin, kit.outletId, sale.businessDate);
      expect(count(again.body.data.reposted)).toBe(0);
      expect(count(again.body.data.stillSkipped)).toBe(1);
      expect(await stockOf(kit)).toEqual(stockBefore);

      // After the fix the very same row finally posts.
      await fix();
      const fixed = await repost(admin, kit.outletId, sale.businessDate);
      expect(count(fixed.body.data.reposted)).toBe(1);
      expect(count(fixed.body.data.stillSkipped)).toBe(0);
      const [posted] = await deductionsOf(sale.order.ulid, sale.order.uuid);
      expect(posted).toMatchObject({ id: sale.deduction.id, status: "posted" });
      expect(Number(await onHand(kit.location, kit.beans))).toBe(
        Number(stockBefore[0]) - 36,
      );
    });

  it("INV-02 one fixed and one still broken sale in the same day: only the fixed one posts", async () => {
    const kit = await buildKit();
    const noRecipeItem = await insertMenuItem(null);
    await configureOutlet(outletA, null);
    const date = nextDate();
    const good = await sell(outletA, kit.latte, {
      businessDate: date,
      quantity: 1,
    });
    const bad = await sell(outletA, noRecipeItem, {
      businessDate: date,
      quantity: 1,
    });
    expect(good.deduction).toMatchObject({
      status: "skipped",
      skip_reason: "no_sale_location",
    });
    expect(bad.deduction.status).toBe("skipped");
    await configureOutlet(outletA, kit.location);

    const response = await repost(admin, outletA, date);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(1);
    expect(count(response.body.data.stillSkipped)).toBe(1);
    expect(
      (await deductionsOf(good.order.ulid, good.order.uuid))[0],
    ).toMatchObject({ status: "posted" });
    expect(
      (await deductionsOf(bad.order.ulid, bad.order.uuid))[0],
    ).toMatchObject({ status: "skipped" });
    expect(Number(await onHand(kit.location, kit.beans))).toBe(1000 - 18);
  });
});

describe("POS-TRAIN INV-02 a training order is never posted by a repost", () => {
  it("INV-02 a skipped deduction of a training order stays skipped and moves no stock", async () => {
    const skippedCase = cases[0]!;
    const { kit, fix, sale, stockBefore } = await skippedSale(skippedCase);
    // Flag the order as training (it predates the training rule).
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
         VALUES ($1, $2, $3, 'pos', true)`,
        [sale.order.uuid, tenantA, kit.outletId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await fix();

    const response = await repost(admin, kit.outletId, sale.businessDate);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(0);
    const rows = await deductionsOf(sale.order.ulid, sale.order.uuid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: sale.deduction.id, status: "skipped" });
    expect(await stockOf(kit)).toEqual(stockBefore);
  });
});

describe("TEN-01 TEN-03 INV-02 repost is scoped to the outlet and business date", () => {
  it("INV-02 reposting outlet A leaves outlet B's skipped deduction skipped", async () => {
    const date = nextDate();
    const kitA = await buildKit(outletA);
    const kitB = await buildKit(outletB);
    await configureOutlet(outletA, null);
    await configureOutlet(outletB, null);
    const saleA = await sell(outletA, kitA.latte, { businessDate: date });
    const saleB = await sell(outletB, kitB.latte, { businessDate: date });
    const beforeB = await stockOf(kitB);
    // Both outlets are fixed, but only A is reposted.
    await configureOutlet(outletA, kitA.location);
    await configureOutlet(outletB, kitB.location);

    const response = await repost(admin, outletA, date);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(1);
    expect(
      (await deductionsOf(saleA.order.ulid, saleA.order.uuid))[0],
    ).toMatchObject({ status: "posted" });
    expect(
      (await deductionsOf(saleB.order.ulid, saleB.order.uuid))[0],
    ).toMatchObject({ id: saleB.deduction.id, status: "skipped" });
    expect(await stockOf(kitB)).toEqual(beforeB);

    // B posts only when B is reposted, from its own location.
    const second = await repost(admin, outletB, date);
    expect(count(second.body.data.reposted)).toBe(1);
    expect(Number(await onHand(kitB.location, kitB.beans))).toBe(1000 - 36);
    expect(Number(await onHand(kitA.location, kitA.beans))).toBe(1000 - 36);
  });

  it("INV-02 reposting one business date leaves another date's skipped deduction skipped", async () => {
    const kit = await buildKit();
    await configureOutlet(outletA, null);
    const dayOne = nextDate();
    const dayTwo = nextDate();
    const one = await sell(outletA, kit.latte, { businessDate: dayOne });
    const two = await sell(outletA, kit.latte, { businessDate: dayTwo });
    await configureOutlet(outletA, kit.location);

    const response = await repost(admin, outletA, dayOne);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(1);
    expect(
      (await deductionsOf(one.order.ulid, one.order.uuid))[0],
    ).toMatchObject({ status: "posted" });
    expect(
      (await deductionsOf(two.order.ulid, two.order.uuid))[0],
    ).toMatchObject({ id: two.deduction.id, status: "skipped" });
    expect(Number(await onHand(kit.location, kit.beans))).toBe(1000 - 36);
  });

  it("INV-02 tenant B cannot repost or read tenant A's skipped deductions", async () => {
    tenantB = await createIsolatedTenant(`rpo${short()}`);
    await owner.query(
      "UPDATE roles SET permissions = $2::jsonb WHERE id = $1",
      [
        tenantB.roleId,
        JSON.stringify([
          "inventory.adjustment.approve",
          "recipe.manage",
          "inventory.stock.view",
        ]),
      ],
    );
    const staffB: Staff = await staffOfIsolatedTenant(app, tenantB);
    const hostB = tenantB.hostname;
    const { kit, fix, sale, stockBefore } = await skippedSale(cases[0]!);
    await fix();

    const post = await repost(
      { client: staffB.client, userId: staffB.userId },
      kit.outletId,
      sale.businessDate,
      hostB,
    );
    expect([403, 404]).toContain(post.status);
    const summary = await staffB.client
      .get(summaryPath(kit.outletId, sale.businessDate))
      .set("Host", hostB);
    expect([403, 404]).toContain(summary.status);
    expect(JSON.stringify(summary.body)).not.toContain(sale.deduction.id);

    // Nothing moved: A's deduction is still skipped, stock untouched.
    expect(
      (await deductionsOf(sale.order.ulid, sale.order.uuid))[0],
    ).toMatchObject({ id: sale.deduction.id, status: "skipped" });
    expect(await stockOf(kit)).toEqual(stockBefore);
  });
});

describe("INV-02 repost permission and request validation", () => {
  let kitchen: Session;
  let manager: Session;
  beforeAll(async () => {
    // kitchen_lead has no inventory.adjustment.approve; outlet_manager has it
    // for its own outlet only.
    kitchen = await signedIn("Repost Kitchen", "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    manager = await signedIn("Repost Manager", "outlet_manager", {
      type: "outlet",
      id: outletA,
    });
  });

  it("INV-02 answers 401 without a session and 403 without a trusted origin", async () => {
    const date = nextDate();
    expect(
      (await agent(app).post(repostPath(outletA)).send({ businessDate: date }))
        .status,
    ).toBe(401);
    expect(
      (
        await admin.client
          .post(repostPath(outletA))
          .send({ businessDate: date })
      ).status,
    ).toBe(403);
  });

  it("INV-02 a user without inventory.adjustment.approve gets 403 and nothing is posted", async () => {
    const { kit, fix, sale, stockBefore } = await skippedSale(cases[0]!);
    await fix();

    const response = await repost(kitchen, kit.outletId, sale.businessDate);
    expect(response.status).toBe(403);
    expect(
      (await deductionsOf(sale.order.ulid, sale.order.uuid))[0],
    ).toMatchObject({ id: sale.deduction.id, status: "skipped" });
    expect(await stockOf(kit)).toEqual(stockBefore);
  });

  it("INV-02 an outlet manager may repost its own outlet but not another outlet", async () => {
    const own = await skippedSale(cases[0]!, outletA);
    await own.fix();
    const other = await skippedSale(cases[0]!, outletB);
    await other.fix();

    const refused = await repost(manager, outletB, other.sale.businessDate);
    expect(refused.status).toBe(403);
    expect(
      (await deductionsOf(other.sale.order.ulid, other.sale.order.uuid))[0],
    ).toMatchObject({ status: "skipped" });
    expect(await stockOf(other.kit)).toEqual(other.stockBefore);

    const allowed = await repost(manager, outletA, own.sale.businessDate);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(count(allowed.body.data.reposted)).toBe(1);
  });

  it("INV-02 rejects a missing or malformed businessDate and unknown fields with 422", async () => {
    const post = (body: Record<string, unknown>) =>
      admin.client.post(repostPath(outletA)).set(originHeader).send(body);
    expect((await post({})).status).toBe(422);
    expect((await post({ businessDate: "31-12-2032" })).status).toBe(422);
    expect((await post({ businessDate: "not-a-date" })).status).toBe(422);
    expect((await post({ businessDate: nextDate(), extra: 1 })).status).toBe(
      422,
    );
  });
});

describe("INV-02 skipped-summary lists skipped deductions per reason", () => {
  it("INV-02 counts the skipped deductions of the outlet and date by skip reason", async () => {
    const kit = await buildKit();
    const noRecipeItem = await insertMenuItem(null);
    const date = nextDate();
    await configureOutlet(outletA, null);
    await sell(outletA, kit.latte, { businessDate: date, quantity: 1 });
    await sell(outletA, kit.latte, { businessDate: date, quantity: 1 });
    await configureOutlet(outletA, kit.location);
    await sell(outletA, noRecipeItem, { businessDate: date, quantity: 1 });
    // A posted sale and another date must not be counted.
    await sell(outletA, kit.latte, { businessDate: date, quantity: 1 });
    await configureOutlet(outletA, null);
    await sell(outletA, kit.latte, { businessDate: nextDate(), quantity: 1 });

    const response = await admin.client.get(summaryPath(outletA, date));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(summaryCount(response.body.data, "no_sale_location")).toBe(2);
    expect(summaryCount(response.body.data, "no_recipe")).toBe(1);
    expect(summaryCount(response.body.data, "recipe_inactive")).toBe(0);
    expect(summaryCount(response.body.data, "recipe_error")).toBe(0);
  });

  it("INV-02 the summary drops to zero for a reason once its deductions are reposted", async () => {
    const { kit, fix, sale } = await skippedSale(cases[0]!);
    const before = await admin.client.get(
      summaryPath(kit.outletId, sale.businessDate),
    );
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(summaryCount(before.body.data, "no_sale_location")).toBe(1);

    await fix();
    expect((await repost(admin, kit.outletId, sale.businessDate)).status).toBe(
      200,
    );
    const after = await admin.client.get(
      summaryPath(kit.outletId, sale.businessDate),
    );
    expect(after.status).toBe(200);
    expect(summaryCount(after.body.data, "no_sale_location")).toBe(0);
  });

  it("INV-02 an outlet and date with nothing skipped has an empty summary", async () => {
    const response = await admin.client.get(summaryPath(outletA, nextDate()));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    for (const reason of [
      "no_sale_location",
      "no_recipe",
      "recipe_inactive",
      "recipe_error",
    ])
      expect(summaryCount(response.body.data, reason)).toBe(0);
  });

  it("INV-02 the summary needs a session, the approve permission and a valid date", async () => {
    const kitchen = await signedIn("Summary Kitchen", "kitchen_lead", {
      type: "outlet",
      id: outletA,
    });
    const date = nextDate();
    expect((await agent(app).get(summaryPath(outletA, date))).status).toBe(401);
    expect((await kitchen.client.get(summaryPath(outletA, date))).status).toBe(
      403,
    );
    expect(
      (await admin.client.get(summaryPath(outletA, "not-a-date"))).status,
    ).toBe(422);
  });
});

describe("INV-02 repost never posts what a void, a swap or a lock race already settled", () => {
  it("INV-02 a POS correction void (order status untouched) keeps the deduction skipped", async () => {
    const { kit, fix, sale, stockBefore } = await skippedSale(cases[0]!);
    await fix();
    // pos_order_voids is append-only with FKs and triggers: insert as replica.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO pos_order_voids (tenant_id, outlet_id, order_id, receipt_number, amount_idr,
            reason, reason_note, requested_by, approved_by, override_id, voided_at)
         VALUES ($1, $2, $3, $4, 50000, 'other', 'uji repost setelah void', 'kasir-a', 'spv-b', $5, now())`,
        [
          tenantA,
          kit.outletId,
          sale.order.uuid,
          `V-${short()}`,
          ulidToUuid(createUlid()),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const response = await repost(admin, kit.outletId, sale.businessDate);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(0);
    expect(count(response.body.data.stillSkipped)).toBe(1);
    expect(
      (await deductionsOf(sale.order.ulid, sale.order.uuid))[0],
    ).toMatchObject({ id: sale.deduction.id, status: "skipped" });
    expect(await stockOf(kit)).toEqual(stockBefore);
  });

  it("INV-02 a swap made after payment while the sale was skipped is not drawn again by the repost", async () => {
    const kit = await buildKit();
    const teaItem = await insertItem("Daun Teh", gramId);
    await receive(outletA, kit.location, teaItem, "1000.0000", "10.0000");
    const tea = await insertMenuItem(
      await insertRecipe({
        lines: [{ id: teaItem, qty: "10.0000", uom: gramId }],
      }),
    );
    const date = nextDate();
    await configureOutlet(outletA, null);
    // Order: the latte line was swapped for a tea line (the issue exists).
    const order = await seedOrder(outletA, date, kit.latte, 1);
    const teaLineId = randomUUID();
    await owner.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
          quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
          fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, NULL, 'Teh', 1, 0, 0, 0, '[]'::jsonb, 'fired', 'served', $6)`,
      [teaLineId, tenantA, outletA, order.uuid, tea, date],
    );
    const issueId = await one<string>(
      `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
          reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
          cost_idr, idempotency_key, status, resolved_at)
       VALUES ($1, $2, $3, $4, 'unfulfillable', 'out_of_stock', 'uji swap', $5, 'swap', $6, $7,
          0, $8, 'resolved', now())
       RETURNING id`,
      [
        tenantA,
        outletA,
        order.uuid,
        order.itemId,
        ownerUserId,
        tea,
        teaLineId,
        randomUUID(),
      ],
    );
    await deliver(paidEvent(order.ulid, outletA, date));
    const [sale] = await deductionsOf(order.ulid, order.uuid);
    expect(sale).toMatchObject({ kind: "sale", status: "skipped" });

    // The configuration is fixed, then the swap draws the tea as a remake.
    await configureOutlet(outletA, kit.location);
    const context = tenantContext();
    await withTenant(db, context, (tx) =>
      applySwapStockAdjustment(tx, context, {
        outletId: outletA,
        orderId: order.ulid,
        issueId,
        businessDate: date,
        oldLineId: uuidToUlid(order.itemId),
        oldLine: {
          menuItemId: kit.latte,
          variantId: null,
          modifierIds: [],
          quantity: 1,
        },
        replacement: {
          menuItemId: tea,
          variantId: null,
          modifierIds: [],
          quantity: 1,
        },
        recordedBy: ownerUserId,
        occurredAt: iso(),
      }),
    );
    expect(Number(await onHand(kit.location, teaItem))).toBe(990);
    const beforeRepost = await stockOf(kit);

    const response = await repost(admin, outletA, date);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Nothing is left for the sale to draw: the tea went out with the swap.
    expect(count(response.body.data.reposted)).toBe(0);
    expect(Number(await onHand(kit.location, teaItem))).toBe(990);
    expect(await stockOf(kit)).toEqual(beforeRepost);
    const rows = await deductionsOf(order.ulid, order.uuid);
    expect(rows.find((row) => row.kind === "sale")).toMatchObject({
      id: sale!.id,
      status: "skipped",
    });
  });

  it("INV-02 unpostable rows ahead of a fixed one do not hide it from the repost", async () => {
    const skipped = await skippedSale(cases[0]!);
    await skipped.fix();
    // 501 skipped rows that can never post (their orders do not exist), all
    // older than the real sale: more than the 500 posted per call.
    const ulids = Array.from({ length: 501 }, () => createUlid());
    await owner.query(
      `INSERT INTO recipe_deductions (tenant_id, outlet_id, kind, status, mode, source_type, source_id,
          business_date, idempotency_key, skip_reason, occurred_at)
       SELECT $1, $2, 'sale', 'skipped', 'real_time', 'order', u, $3, 'sale:order:' || u,
              'no_recipe', '2000-01-01T00:00:00Z'
         FROM unnest($4::text[]) AS u`,
      [tenantA, skipped.kit.outletId, skipped.sale.businessDate, ulids],
    );

    const response = await repost(
      admin,
      skipped.kit.outletId,
      skipped.sale.businessDate,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(count(response.body.data.reposted)).toBe(1);
    expect(count(response.body.data.stillSkipped)).toBe(501);
    expect(
      (await deductionsOf(skipped.sale.order.ulid, skipped.sale.order.uuid))[0],
    ).toMatchObject({ id: skipped.sale.deduction.id, status: "posted" });
    expect(Number(await onHand(skipped.kit.location, skipped.kit.beans))).toBe(
      Number(skipped.stockBefore[0]) - 36,
    );
  });

  it("INV-02 repost takes the order lock before the row lock, so a swap holding the order cannot deadlock with it", async () => {
    const { kit, fix, sale } = await skippedSale(cases[0]!);
    await fix();
    // A swap locks the order FOR UPDATE, then the sale row.
    const swapTx = await owner.connect();
    try {
      await swapTx.query("BEGIN");
      await swapTx.query(
        "SELECT id FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, sale.order.uuid],
      );
      const pending = Promise.resolve(
        repost(admin, kit.outletId, sale.businessDate),
      ).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await swapTx.query(
        "SELECT id FROM recipe_deductions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, sale.deduction.id],
      );
      await swapTx.query("COMMIT");
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(count(response.body.data.reposted)).toBe(1);
    } finally {
      await swapTx.query("ROLLBACK").catch(() => undefined);
      swapTx.release();
    }
  });
});
