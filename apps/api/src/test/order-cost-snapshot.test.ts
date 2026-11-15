// HPP snapshot per order line at sale time (bead legend-u4js6; DECISIONS.md
// 2026-11-10 "WS-11: HPP per baris pesanan saat penjualan"; PRD v1.7 F16
// "Resep / BOM", INV-02, INV-03 stock value).
//
// `order_items.cost_snapshot_idr` = the whole line's theoretical cost
// (quantity x cost of one portion), whole rupiah, rounded half up ONCE per
// line from the full-scale sum; cost = `stock_balances.avg_cost_idr` at the
// outlet's sale location when the line is inserted. NULL = unknown, never 0.
//
// Runs against the disposable PostgreSQL test database in two tenants this
// file creates and removes again. POS, QR and delivery orders are created
// through the real HTTP routes (the real services insert the lines); the
// edge applier and the savepoint case call the service entry points directly.
//
// Assumptions where the decision record is silent:
// - Prices of menu items are irrelevant to the snapshot; the fixtures price
//   every item Rp25.000 on the takeaway, dine_in and gofood price lists.
// - A variant is priced like its menu item (price rows exist per menu item only).
// - "Edge QR applier" is driven as in qr-order-edge-forwarding.test.ts: the
//   cloud order is placed with a live edge link, its cloud copy removed, and
//   the queued `qr_order.placed` event applied. The cloud copy carries the
//   snapshot, the edge copy is NULL (decision 5).
// - A direct call with a malformed menu item id makes the helper's SQL fail;
//   the helper must answer all NULL, keep the surrounding transaction alive
//   and warn through `logger.warn` with tenant and outlet but not the
//   offending value (decision 7: error code only).
// - A void is simulated by setting the lines to `voided` (a real void needs
//   approvals and a shift); the snapshot must not move.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  decimal4,
  idr,
  outletIdSchema,
  ulidToUuid,
  userIdSchema,
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
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import {
  PERMISSION_CODES,
  tenantPermissionCodeSchema,
} from "@starter/shared/access";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { edgeEventApplier, setEdgeEventApplier } from "../edge/ports.ts";
import { registerQrOrderEdgeApplier } from "../edge/qr-order-applier.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { logger } from "../lib/logger.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { computeLineCostSnapshots } from "../services/order-cost-snapshot.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createTable,
  createZone,
  issueQr,
  scan,
} from "./floor-test-helpers.ts";

// ------------------------------------------------------------------ tenants

type Fx = {
  tenantId: string;
  brandId: string;
  legalEntityId: string;
  outletId: string;
  slug: string;
  host: string;
  gramId: string;
  mlId: string;
  cupId: string;
  categoryId: string;
  groupId: string;
};

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
let app: Express;
let A: Fx;
let B: Fx;
let ownerUserId: string;
const deviceId = randomUUID();
const short = () => randomUUID().slice(0, 6);
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

function ctxOf(fx: Fx): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: fx.tenantId,
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}
const outletOf = (fx: Fx) => outletIdSchema.parse(fx.outletId) as OutletId;

/** Owner-side statement with the tenant local set (RLS is FORCED). */
async function q<T = Record<string, unknown>>(
  fx: Fx,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
const id = async (fx: Fx, text: string, params: unknown[]) =>
  (await q<{ id: string }>(fx, text, params))[0]!.id;

async function createTenantFx(
  prefix: string,
  withDomain: boolean,
): Promise<Fx> {
  const fixtures = cafeLegendPlatformFixtures;
  const slug = `${prefix}${randomUUID().slice(0, 8)}`;
  const fx: Fx = {
    tenantId: randomUUID(),
    brandId: randomUUID(),
    legalEntityId: randomUUID(),
    outletId: randomUUID(),
    slug,
    host: `tenant-${slug}.legend.test`,
    gramId: "",
    mlId: "",
    cupId: "",
    categoryId: randomUUID(),
    groupId: randomUUID(),
  };
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, $6)`,
    [
      fx.tenantId,
      `tenant-${slug}`,
      `Tenant ${slug}`,
      JSON.stringify(fixtures.tenant.featureFlags),
      JSON.stringify(fixtures.tenant.limits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    [fx.brandId, fx.tenantId, `brand-${slug}`, `Brand ${slug}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [fx.legalEntityId, fx.tenantId, `Entity ${slug}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji 1', 'Asia/Jakarta', $7, 'active')`,
    [
      fx.outletId,
      fx.tenantId,
      fx.brandId,
      fx.legalEntityId,
      `S${slug.slice(-8)}`.toUpperCase(),
      `Outlet ${slug}`,
      JSON.stringify(fixtures.outlets[0]!.openingHours),
    ],
  );
  if (withDomain)
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
      [randomUUID(), fx.tenantId, fx.brandId, fx.host],
    );
  const uom = (code: string) =>
    id(
      fx,
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [fx.tenantId, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
    );
  fx.gramId = await uom("g");
  fx.mlId = await uom("ml");
  fx.cupId = await uom("cup");
  await q(
    fx,
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'HPP Snapshot', 0)",
    [fx.categoryId, fx.tenantId, fx.brandId],
  );
  await q(
    fx,
    "INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select) VALUES ($1, $2, 'Tambahan', 0, 10)",
    [fx.groupId, fx.tenantId],
  );
  return fx;
}

/** Removes everything a fixture tenant created (ledger and audit are append-only). */
async function dropTenantFx(fx: Fx) {
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
        fx.tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [fx.tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------- stock + recipes

async function newLocation(fx: Fx): Promise<string> {
  return id(
    fx,
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [fx.tenantId, fx.outletId, `Bar ${short()}`],
  );
}

async function newItem(fx: Fx, name: string, uomId: string): Promise<string> {
  return id(
    fx,
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
    [fx.tenantId, `${name} ${short()}`, uomId],
  );
}

async function receive(
  fx: Fx,
  locationId: string,
  itemId: string,
  quantity: string,
  unitCost: string,
) {
  await recordStockMovement(ctxOf(fx), {
    outletId: outletOf(fx),
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

type Part = { item: string; qty: string; uom: string };

async function newRecipe(
  fx: Fx,
  name: string,
  parts: Part[],
  isActive = true,
): Promise<string> {
  const recipe = await id(
    fx,
    `INSERT INTO recipes (tenant_id, brand_id, name, output_item_id, yield_quantity, yield_uom_id, is_active, updated_by)
     VALUES ($1, $2, $3, NULL, 1, $4, $5, $6) RETURNING id`,
    [
      fx.tenantId,
      fx.brandId,
      `${name} ${short()}`,
      fx.cupId,
      isActive,
      ownerUserId,
    ],
  );
  for (const [index, part] of parts.entries())
    await q(
      fx,
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [fx.tenantId, recipe, index, part.item, part.qty, part.uom],
    );
  return recipe;
}

const PRICE_LISTS: Record<string, string> = {};
const MENU_PRICE = 25_000;

async function newMenuItem(
  fx: Fx,
  name: string,
  recipeId: string | null,
  plainPrice = true,
): Promise<string> {
  const menuItem = await id(
    fx,
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id)
     VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
    [
      fx.tenantId,
      fx.brandId,
      fx.categoryId,
      `${name} ${short()}`,
      recipeId,
      randomUUID(),
    ],
  );
  if (plainPrice) await priceEverywhere(fx, menuItem);
  return menuItem;
}

async function priceEverywhere(
  fx: Fx,
  itemId: string,
  variantId: string | null = null,
) {
  if (fx.tenantId !== A.tenantId) return;
  for (const list of Object.values(PRICE_LISTS))
    await q(
      fx,
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, variant_id, price_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), fx.tenantId, list, itemId, variantId, MENU_PRICE],
    );
}

async function newVariant(
  fx: Fx,
  menuItemId: string,
  name: string,
  recipeId: string | null,
): Promise<string> {
  const variant = await id(
    fx,
    "INSERT INTO item_variants (tenant_id, menu_item_id, name, recipe_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [fx.tenantId, menuItemId, `${name} ${short()}`, recipeId],
  );
  await priceEverywhere(fx, menuItemId, variant);
  return variant;
}

/** A modifier on `menuItemId` with one add / replace rule (item components). */
async function newModifier(
  fx: Fx,
  menuItemId: string,
  name: string,
  rule:
    | { action: "add"; item: string; qty: string; uom: string }
    | {
        action: "replace";
        target: string;
        item: string;
        qty: string;
        uom: string;
      },
): Promise<string> {
  const modifier = await id(
    fx,
    "INSERT INTO modifiers (tenant_id, group_id, name) VALUES ($1, $2, $3) RETURNING id",
    [fx.tenantId, fx.groupId, `${name} ${short()}`],
  );
  await q(
    fx,
    `INSERT INTO modifier_recipe_rules
       (tenant_id, modifier_id, action, target_component_type, target_component_id,
        component_type, component_id, quantity, uom_id, waste_pct_bp)
     VALUES ($1, $2, $3, $4, $5, 'item', $6, $7, $8, 0)`,
    [
      fx.tenantId,
      modifier,
      rule.action,
      rule.action === "replace" ? "item" : null,
      rule.action === "replace" ? rule.target : null,
      rule.item,
      rule.qty,
      rule.uom,
    ],
  );
  await q(
    fx,
    `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
     VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`,
    [fx.tenantId, menuItemId, fx.groupId],
  );
  return modifier;
}

async function configureOutlet(fx: Fx, saleLocationId: string | null) {
  await q(
    fx,
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = EXCLUDED.recipe_deduction_mode,
                   sale_location_id = EXCLUDED.sale_location_id`,
    [fx.tenantId, fx.outletId, saleLocationId],
  );
}

/**
 * Sale location with 1.000 g beans (Rp100/g), 10.000 ml milk (Rp20/ml) and
 * 10.000 ml oat milk (Rp40/ml); a Latte (18 g beans + 200 ml milk = Rp5.800 a
 * cup), a Large variant (300 ml milk = Rp7.800), a Regular variant without a
 * recipe, and the modifiers Extra Shot (add 9 g beans = +Rp900) and Oat Milk
 * (replace milk by 150 ml oat = Rp6.000 instead of Rp4.000). The outlet sells
 * from this location.
 */
async function latteKit(fx: Fx) {
  const location = await newLocation(fx);
  const beans = await newItem(fx, "Biji Kopi", fx.gramId);
  const milk = await newItem(fx, "Susu", fx.mlId);
  const oat = await newItem(fx, "Oat", fx.mlId);
  await receive(fx, location, beans, "1000.0000", "100.0000");
  await receive(fx, location, milk, "10000.0000", "20.0000");
  await receive(fx, location, oat, "10000.0000", "40.0000");
  const recipe = await newRecipe(fx, "Latte", [
    { item: beans, qty: "18.0000", uom: fx.gramId },
    { item: milk, qty: "200.0000", uom: fx.mlId },
  ]);
  const largeRecipe = await newRecipe(fx, "Latte Large", [
    { item: beans, qty: "18.0000", uom: fx.gramId },
    { item: milk, qty: "300.0000", uom: fx.mlId },
  ]);
  const latte = await newMenuItem(fx, "Latte", recipe);
  // A menu item with variants is sold per variant only (priced per variant),
  // so the variants live on their own menu item sharing the Latte recipe.
  const latteSizes = await newMenuItem(fx, "Latte Ukuran", recipe, false);
  const large = await newVariant(fx, latteSizes, "Large", largeRecipe);
  const regular = await newVariant(fx, latteSizes, "Regular", null);
  const extraShot = await newModifier(fx, latte, "Extra Shot", {
    action: "add",
    item: beans,
    qty: "9.0000",
    uom: fx.gramId,
  });
  const oatMilk = await newModifier(fx, latte, "Oat Milk", {
    action: "replace",
    target: milk,
    item: oat,
    qty: "150.0000",
    uom: fx.mlId,
  });
  await configureOutlet(fx, location);
  return {
    location,
    beans,
    milk,
    oat,
    recipe,
    latte,
    latteSizes,
    large,
    regular,
    extraShot,
    oatMilk,
  };
}

// ------------------------------------------------------------- order readers

type LineRow = {
  menu_item_id: string;
  variant_id: string | null;
  cost: string | null;
  status: string;
};

async function linesOf(fx: Fx, orderUuid: string): Promise<LineRow[]> {
  return q<LineRow>(
    fx,
    `SELECT menu_item_id, variant_id, cost_snapshot_idr::text AS cost, status
       FROM order_items WHERE tenant_id = $1 AND order_id = $2
      ORDER BY menu_item_id`,
    [fx.tenantId, orderUuid],
  );
}

/** The line's snapshot as a number, or null; fails if the line is missing. */
async function costOf(
  fx: Fx,
  orderUuid: string,
  menuItemId: string,
): Promise<number | null> {
  const rows = (await linesOf(fx, orderUuid)).filter(
    (row) => row.menu_item_id === menuItemId,
  );
  expect(rows, "order line").toHaveLength(1);
  return rows[0]!.cost === null ? null : Number(rows[0]!.cost);
}

// ---------------------------------------------------------------- POS (HTTP)

let cashier: { client: ReturnType<typeof agent>; userId: string };

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

function pos(path: string, body: Record<string, unknown>) {
  return cashier.client
    .post(`/api/outlets/${encodeURIComponent(A.outletId)}/pos/orders${path}`)
    .set({ Host: A.host })
    .set(originHeader)
    .set(
      DEVICE_TOKEN_HEADER,
      signDeviceToken({
        version: 1,
        issuedAt: Math.floor(Date.now() / 1000),
        tenantId: A.tenantId,
        brandId: null,
        deviceId,
      }),
    )
    .send({ idempotencyKey: randomUUID(), ...body });
}

type SaleLine = {
  menuItemId: string;
  variantId?: string | null;
  modifierIds?: string[];
  quantity: number;
};

/** A cashier sells `lines` through the real POS routes; returns the order UUID. */
async function posSale(lines: SaleLine[]): Promise<string> {
  const created = await pos("", {
    channel: "pos",
    serviceType: "takeaway",
    items: lines.map((line) => ({
      menuItemId: line.menuItemId,
      variantId: line.variantId ?? null,
      modifierIds: line.modifierIds ?? [],
      quantity: line.quantity,
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
  return ulidToUuid(orderId);
}

// --------------------------------------------------------------- QR (HTTP)

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    return {
      providerRef: `HPP-${randomUUID()}`,
      instructions: {
        method: "qris" as const,
        qrPayload: "00020101021226FAKEQRORDER",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

type Guest = { token: string; sessionId: string };

async function seatGuest(): Promise<Guest> {
  const zone = await createZone(
    cashier.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    { Host: A.host },
  );
  const table = await createTable(
    cashier.client,
    { zoneId: zone.id },
    { Host: A.host },
  );
  const qr = await issueQr(cashier.client, table.id, { Host: A.host });
  const response = await scan(app, { token: qr.token, hostname: A.host });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

function asGuest(guest: Guest) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", A.host)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
  };
}

/** A guest orders `lines` through the real QR checkout; returns the order ULID. */
async function qrOrder(lines: SaleLine[]): Promise<string> {
  const guest = await seatGuest();
  let version = 0;
  for (const line of lines) {
    const added = await asGuest(guest).add({
      menuItemId: line.menuItemId,
      variantId: line.variantId ?? null,
      modifierIds: line.modifierIds ?? [],
      quantity: line.quantity,
      expectedCartVersion: version,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    version = added.body.data.cart.version as number;
  }
  const placed = await asGuest(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  return placed.body.data.order.id as string;
}

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPaymentGateway(new FakeGateway());
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  A = await createTenantFx("snp", true);
  B = await createTenantFx("snq", false);
  ownerUserId = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [ownerUserId, "HPP Snapshot Owner", `${ownerUserId}@example.com`],
  );

  setPosReceiptPort(receiptPort());
  setDeviceOutletResolver(async (input) =>
    input.tenantId === A.tenantId && input.deviceId === deviceId
      ? A.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: A.tenantId,
    outletId: A.outletId,
    deviceId,
  });
  // One role that can run POS, QR floor set-up and delivery orders.
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir HPP', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      A.tenantId,
      JSON.stringify(
        PERMISSION_CODES.filter(
          (code) => tenantPermissionCodeSchema.safeParse(code).success,
        ),
      ),
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
    [A.tenantId, userId, roleId],
  );
  cashier = { client, userId };
  await openPosShift(
    ctxOf(A),
    { userId: userIdSchema.parse(userId), deviceId },
    outletOf(A),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  for (const channel of ["takeaway", "dine_in", "gofood"]) {
    PRICE_LISTS[channel] = randomUUID();
    await q(
      A,
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, $4, '2026-01-01')`,
      [PRICE_LISTS[channel], A.tenantId, A.outletId, channel],
    );
  }
  await q(
    A,
    `INSERT INTO delivery_channels
       (tenant_id, outlet_id, platform, store_external_id, commission_rate_bps, is_open)
     VALUES ($1, $2, 'gofood', $3, 2000, true)`,
    [A.tenantId, A.outletId, `store-${short()}`],
  );
  await q(
    A,
    `INSERT INTO tax_settings
       (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
        tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
        version, effective_from, status, published_at, published_by)
     VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
             'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
    [randomUUID(), A.tenantId, ownerUserId],
  );
  await q(
    A,
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, 'PBJT-SNP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
    [randomUUID(), A.tenantId, ownerUserId],
  );
}, 60_000);

afterEach(() => {
  setEdgeEventApplier("cloud_to_edge", null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  await dropTenantFx(A);
  await dropTenantFx(B);
  await owner.end();
});

// =========================================================================

describe("legend-u4js6 HPP snapshot per order line", () => {
  it("HPP-SNAP-01 a POS line of 2 cups stores the whole line cost, 2 x Rp5.800 = Rp11.600", async () => {
    const kit = await latteKit(A);
    const order = await posSale([{ menuItemId: kit.latte, quantity: 2 }]);
    expect(await costOf(A, order, kit.latte)).toBe(11_600);

    // One cup is one portion: the same line with quantity 1 stores Rp5.800.
    const single = await posSale([{ menuItemId: kit.latte, quantity: 1 }]);
    expect(await costOf(A, single, kit.latte)).toBe(5_800);
  }, 60_000);

  it("HPP-SNAP-02 rounds half up once per line: 0,3 + 0,3 = 0,6 becomes Rp1, not 0 + 0", async () => {
    const location = await newLocation(A);
    const spice = await newItem(A, "Bumbu", A.gramId);
    const sugar = await newItem(A, "Gula", A.gramId);
    await receive(A, location, spice, "1000.0000", "0.1000");
    await receive(A, location, sugar, "1000.0000", "0.1000");
    // Two ingredients of Rp0,3 each: 0,6 -> 1 (per-ingredient rounding gives 0).
    const twoParts = await newMenuItem(
      A,
      "Dua Bahan",
      await newRecipe(A, "Dua Bahan", [
        { item: spice, qty: "3.0000", uom: A.gramId },
        { item: sugar, qty: "3.0000", uom: A.gramId },
      ]),
    );
    // One portion of Rp0,3 sold twice: 0,6 -> 1 (per-portion rounding gives 0 x 2).
    const twoPortions = await newMenuItem(
      A,
      "Dua Porsi",
      await newRecipe(A, "Dua Porsi", [
        { item: spice, qty: "3.0000", uom: A.gramId },
      ]),
    );
    // Exactly half a rupiah rounds up.
    const half = await newMenuItem(
      A,
      "Setengah",
      await newRecipe(A, "Setengah", [
        { item: spice, qty: "5.0000", uom: A.gramId },
      ]),
    );
    await configureOutlet(A, location);

    const order = await posSale([
      { menuItemId: twoParts, quantity: 1 },
      { menuItemId: twoPortions, quantity: 2 },
      { menuItemId: half, quantity: 1 },
    ]);
    expect(await costOf(A, order, twoParts)).toBe(1);
    expect(await costOf(A, order, twoPortions)).toBe(1);
    expect(await costOf(A, order, half)).toBe(1);
  }, 60_000);

  it("HPP-SNAP-03 variant recipe, fallback to the menu recipe, add and replace modifiers all count", async () => {
    const kit = await latteKit(A);
    const cost = async (line: SaleLine) =>
      costOf(A, await posSale([line]), line.menuItemId);

    // Large has its own recipe: 18 x 100 + 300 x 20.
    expect(
      await cost({
        menuItemId: kit.latteSizes,
        variantId: kit.large,
        quantity: 1,
      }),
    ).toBe(7_800);
    // Regular has none: falls back to the menu item recipe.
    expect(
      await cost({
        menuItemId: kit.latteSizes,
        variantId: kit.regular,
        quantity: 1,
      }),
    ).toBe(5_800);
    // Extra shot adds 9 g beans (Rp900) per cup: 2 x (5.800 + 900).
    expect(
      await cost({
        menuItemId: kit.latte,
        modifierIds: [kit.extraShot],
        quantity: 2,
      }),
    ).toBe(13_400);
    // Oat replaces 200 ml milk (Rp4.000) with 150 ml oat (Rp6.000).
    expect(
      await cost({
        menuItemId: kit.latte,
        modifierIds: [kit.oatMilk],
        quantity: 1,
      }),
    ).toBe(7_800);
  }, 120_000);

  it("HPP-SNAP-04 a menu item without a recipe gets NULL, not 0, and its sibling line is still costed", async () => {
    const kit = await latteKit(A);
    const plain = await newMenuItem(A, "Air Mineral", null);
    const order = await posSale([
      { menuItemId: kit.latte, quantity: 1 },
      { menuItemId: plain, quantity: 1 },
    ]);
    expect(await costOf(A, order, plain)).toBeNull();
    expect(await costOf(A, order, kit.latte)).toBe(5_800);
  }, 60_000);

  it("HPP-SNAP-05 an inactive recipe gets NULL", async () => {
    const kit = await latteKit(A);
    const inactiveRecipe = await newRecipe(
      A,
      "Menu Lama",
      [{ item: kit.beans, qty: "18.0000", uom: A.gramId }],
      false,
    );
    const old = await newMenuItem(A, "Menu Lama", inactiveRecipe);
    const order = await posSale([
      { menuItemId: old, quantity: 1 },
      { menuItemId: kit.latte, quantity: 1 },
    ]);
    expect(await costOf(A, order, old)).toBeNull();
    expect(await costOf(A, order, kit.latte)).toBe(5_800);
  }, 60_000);

  it("HPP-SNAP-06 an outlet without a sale location gets NULL on every line", async () => {
    const kit = await latteKit(A);
    await configureOutlet(A, null);
    const order = await posSale([{ menuItemId: kit.latte, quantity: 2 }]);
    expect(await costOf(A, order, kit.latte)).toBeNull();
  }, 60_000);

  it("HPP-SNAP-07 one ingredient without stock balance, or at cost 0, gives NULL for the whole line (no partial value)", async () => {
    const kit = await latteKit(A);
    const unstocked = await newItem(A, "Gula Tanpa Saldo", A.gramId);
    const free = await newItem(A, "Bahan Gratis", A.gramId);
    await receive(A, kit.location, free, "1000.0000", "50.0000");
    const withoutBalance = await newMenuItem(
      A,
      "Tanpa Saldo",
      await newRecipe(A, "Tanpa Saldo", [
        { item: kit.beans, qty: "18.0000", uom: A.gramId },
        { item: unstocked, qty: "5.0000", uom: A.gramId },
      ]),
    );
    const withFree = await newMenuItem(
      A,
      "Ada Gratis",
      await newRecipe(A, "Ada Gratis", [
        { item: kit.beans, qty: "18.0000", uom: A.gramId },
        { item: free, qty: "5.0000", uom: A.gramId },
      ]),
    );
    // The ingredient's average cost is now exactly 0.
    await q(
      A,
      `UPDATE stock_balances SET avg_cost_idr = 0
        WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
      [A.tenantId, kit.location, free],
    );

    const order = await posSale([
      { menuItemId: withoutBalance, quantity: 1 },
      { menuItemId: withFree, quantity: 1 },
      { menuItemId: kit.latte, quantity: 1 },
    ]);
    expect(await costOf(A, order, withoutBalance)).toBeNull();
    expect(await costOf(A, order, withFree)).toBeNull();
    expect(await costOf(A, order, kit.latte)).toBe(5_800);
  }, 60_000);

  it("HPP-SNAP-08 an SQL error inside the helper gives all NULL, warns, and leaves the surrounding transaction usable (savepoint)", async () => {
    const kit = await latteKit(A);
    const warn = vi.spyOn(logger, "warn");
    const lines = [
      { menuItemId: kit.latte, variantId: null, modifierIds: [], quantity: 1 },
      // Not a UUID: PostgreSQL rejects it, which aborts a transaction that has no savepoint.
      {
        menuItemId: "not-a-uuid",
        variantId: null,
        modifierIds: [],
        quantity: 1,
      },
    ] as unknown as Parameters<typeof computeLineCostSnapshots>[3];

    const outcome = await withTenant(db, ctxOf(A), async (tx) => {
      const snapshots = await computeLineCostSnapshots(
        tx,
        ctxOf(A),
        outletOf(A),
        lines,
      );
      // Would throw "current transaction is aborted" without the savepoint.
      const alive = await tx.execute(sql`SELECT 1 AS ok`);
      return { snapshots, alive: alive.rows[0] };
    });

    expect(outcome.snapshots).toEqual([null, null]);
    expect(outcome.alive).toEqual({ ok: 1 });
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(A.tenantId);
    expect(logged).toContain(A.outletId);
    // Only the error code is logged, never the offending value.
    expect(logged).not.toContain("not-a-uuid");
    // The logged code is the SQLSTATE of the failure (22P02 for a bad UUID),
    // not the generic class name "Error".
    const fields = warn.mock.calls[0]![0] as { code?: unknown };
    expect(fields.code).toBe("22P02");

    // The same lines without the broken one are still costed afterwards.
    const healthy = await withTenant(db, ctxOf(A), (tx) =>
      computeLineCostSnapshots(tx, ctxOf(A), outletOf(A), [lines[0]!]),
    );
    expect(healthy).toEqual([5_800]);
  }, 60_000);

  it("HPP-SNAP-13 a recipe in kg costs correctly through the item's uom conversion to g", async () => {
    const location = await newLocation(A);
    const kgId = await id(
      A,
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [A.tenantId, `kg${short()}`.slice(0, 10)],
    );
    const flour = await newItem(A, "Tepung", A.gramId);
    // Both directions are seeded: 1 kg = 1000 g and 1 g = 0,001 kg.
    await q(
      A,
      `INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor)
       VALUES ($1, $2, $3, $4, '1000.0000'), ($1, $2, $4, $3, '0.0010')`,
      [A.tenantId, flour, kgId, A.gramId],
    );
    await receive(A, location, flour, "5000.0000", "100.0000");
    const bread = await newMenuItem(
      A,
      "Roti Kg",
      await newRecipe(A, "Roti Kg", [
        { item: flour, qty: "0.0180", uom: kgId },
      ]),
    );
    await configureOutlet(A, location);

    // 0,018 kg = 18 g x Rp100 = Rp1.800 a portion; 2 portions = Rp3.600.
    const order = await posSale([{ menuItemId: bread, quantity: 2 }]);
    expect(await costOf(A, order, bread)).toBe(3_600);
  }, 60_000);

  it("HPP-SNAP-14 a line with no uom conversion path is NULL, the other lines are still costed, and nothing is warned", async () => {
    const kit = await latteKit(A);
    const warn = vi.spyOn(logger, "warn");
    // The item is stocked in grams; the recipe asks for ml and no g <-> ml
    // conversion exists for it.
    const stuck = await newMenuItem(
      A,
      "Tanpa Konversi",
      await newRecipe(A, "Tanpa Konversi", [
        { item: kit.beans, qty: "50.0000", uom: A.mlId },
      ]),
    );
    const order = await posSale([
      { menuItemId: stuck, quantity: 1 },
      { menuItemId: kit.latte, quantity: 1 },
    ]);
    expect(await costOf(A, order, stuck)).toBeNull();
    expect(await costOf(A, order, kit.latte)).toBe(5_800);
    // An ordinary NULL reason is not an error: no warning for this outlet.
    const ours = warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes(A.outletId),
    );
    expect(ours).toEqual([]);
  }, 60_000);

  it("HPP-SNAP-15 a line with quantity 0 is NULL while a valid line next to it is costed", async () => {
    const kit = await latteKit(A);
    const lines = [
      { menuItemId: kit.latte, variantId: null, modifierIds: [], quantity: 0 },
      { menuItemId: kit.latte, variantId: null, modifierIds: [], quantity: 1 },
    ];
    const result = await withTenant(db, ctxOf(A), (tx) =>
      computeLineCostSnapshots(tx, ctxOf(A), outletOf(A), lines),
    );
    expect(result).toEqual([null, 5_800]);
  }, 60_000);

  // legend-xtuik. The deduction (planDeduction) answers `recipe_error` and
  // takes no stock when a recipe line names an own-outlet location that is
  // inactive. The snapshot must then be NULL (unknown), not a cost for stock
  // that is never drawn. Assumption: an inactive own location is unusable
  // exactly as for the deduction; no fallback to the sale location.
  it("HPP-SNAP-16 a draw from an own but inactive recipe-line location gives NULL, an active one is costed at that location", async () => {
    const kit = await latteKit(A);
    const bar2 = await newLocation(A);
    await receive(A, bar2, kit.beans, "1000.0000", "150.0000");
    // The Latte's bean line is drawn from bar2 instead of the sale location.
    await q(
      A,
      `UPDATE recipe_lines SET deduction_location_id = $3
        WHERE tenant_id = $1 AND recipe_id = $2 AND component_id = $4`,
      [A.tenantId, kit.recipe, bar2, kit.beans],
    );
    const lines = [
      { menuItemId: kit.latte, variantId: null, modifierIds: [], quantity: 1 },
    ];
    const cost = () =>
      withTenant(db, ctxOf(A), (tx) =>
        computeLineCostSnapshots(tx, ctxOf(A), outletOf(A), lines),
      );

    // Control: active bar2. 18 g x Rp150 (bar2) + 200 ml x Rp20 (sale location).
    expect(await cost()).toEqual([6_700]);

    await q(
      A,
      "UPDATE stock_locations SET is_active = false WHERE tenant_id = $1 AND id = $2",
      [A.tenantId, bar2],
    );
    // Not the sale-location fallback (5.800), not bar2's cost (6.700).
    expect(await cost()).toEqual([null]);
  }, 60_000);

  // legend-xtuik. planDeduction answers `no_sale_location` and takes no stock
  // when a draw falls back to the outlet sale location and that location is
  // inactive. The snapshot must then be NULL, not a cost for stock never drawn.
  it("HPP-SNAP-17 an inactive sale location gives NULL for draws that fall back to it, an active one is costed", async () => {
    const kit = await latteKit(A);
    const lines = [
      { menuItemId: kit.latte, variantId: null, modifierIds: [], quantity: 1 },
    ];
    const cost = () =>
      withTenant(db, ctxOf(A), (tx) =>
        computeLineCostSnapshots(tx, ctxOf(A), outletOf(A), lines),
      );

    // Control: active sale location, 18 g x Rp100 + 200 ml x Rp20.
    expect(await cost()).toEqual([5_800]);

    await q(
      A,
      "UPDATE stock_locations SET is_active = false WHERE tenant_id = $1 AND id = $2",
      [A.tenantId, kit.location],
    );
    expect(await cost()).toEqual([null]);
  }, 60_000);

  it("HPP-SNAP-09QR orders (with a modifier) and delivery orders (base recipe only) store their line cost", async () => {
    const kit = await latteKit(A);

    // QR: 2 lattes with an extra shot = 2 x (5.800 + 900).
    const qrId = await qrOrder([
      { menuItemId: kit.latte, modifierIds: [kit.extraShot], quantity: 2 },
    ]);
    expect(await costOf(A, ulidToUuid(qrId), kit.latte)).toBe(13_400);

    // Delivery (manual platform order): 3 lattes = 3 x 5.800.
    const manual = await cashier.client
      .post(
        `/api/outlets/${encodeURIComponent(A.outletId)}/delivery-orders/manual`,
      )
      .set({ Host: A.host })
      .set(originHeader)
      .set("Idempotency-Key", randomUUID())
      .send({
        platform: "gofood",
        externalOrderId: `M-${short()}`,
        lines: [{ menuItemId: kit.latte, quantity: 3 }],
      });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);
    const deliveryOrder = manual.body.data.orderId as string;
    expect(deliveryOrder).toBeTruthy();
    expect(await costOf(A, ulidToUuid(deliveryOrder), kit.latte)).toBe(17_400);
  }, 60_000);

  it("HPP-SNAP-11 a later void and a changed average cost never change a stored snapshot; a new sale uses the new cost", async () => {
    const kit = await latteKit(A);
    const first = await posSale([{ menuItemId: kit.latte, quantity: 2 }]);
    expect(await costOf(A, first, kit.latte)).toBe(11_600);

    // Beans now average Rp200/g: 1.000 g at 100 + 1.000 g at 300.
    await receive(A, kit.location, kit.beans, "1000.0000", "300.0000");
    // The line is voided afterwards. A completed order's lines are immutable
    // for the app (POS-04 trigger), so the owner flips the status in replica
    // mode, standing in for the void correction.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [A.tenantId],
      );
      await client.query(
        "UPDATE order_items SET status = 'voided' WHERE tenant_id = $1 AND order_id = $2",
        [A.tenantId, first],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(await costOf(A, first, kit.latte)).toBe(11_600);
    expect((await linesOf(A, first))[0]!.status).toBe("voided");

    // A sale after the price move is costed at the new average: 18 x 200 + 200 x 20.
    const second = await posSale([{ menuItemId: kit.latte, quantity: 1 }]);
    expect(await costOf(A, second, kit.latte)).toBe(7_600);
    expect(await costOf(A, first, kit.latte)).toBe(11_600);
  }, 60_000);

  it("HPP-SNAP-12 tenants are isolated: each prices from its own stock, and no tenant reads or reaches the other's data", async () => {
    const kitA = await latteKit(A);
    // Tenant B sells the same kind of Latte but its beans cost Rp1.000/g.
    const location = await newLocation(B);
    const beans = await newItem(B, "Biji Kopi", B.gramId);
    const milk = await newItem(B, "Susu", B.mlId);
    await receive(B, location, beans, "1000.0000", "1000.0000");
    await receive(B, location, milk, "10000.0000", "50.0000");
    const latteB = await newMenuItem(
      B,
      "Latte",
      await newRecipe(B, "Latte", [
        { item: beans, qty: "18.0000", uom: B.gramId },
        { item: milk, qty: "200.0000", uom: B.mlId },
      ]),
    );
    await configureOutlet(B, location);

    const line = (menuItemId: string) => [
      { menuItemId, variantId: null, modifierIds: [], quantity: 1 },
    ];
    const snapshots = (fx: Fx, outlet: OutletId, menuItemId: string) =>
      withTenant(db, ctxOf(fx), (tx) =>
        computeLineCostSnapshots(tx, ctxOf(fx), outlet, line(menuItemId)),
      );

    // Own stock, own cost: B = 18 x 1.000 + 200 x 50, A = 18 x 100 + 200 x 20.
    expect(await snapshots(B, outletOf(B), latteB)).toEqual([28_000]);
    expect(await snapshots(A, outletOf(A), kitA.latte)).toEqual([5_800]);
    // The other tenant's menu item or outlet is invisible: unknown, not a leak.
    expect(await snapshots(B, outletOf(B), kitA.latte)).toEqual([null]);
    expect(await snapshots(A, outletOf(A), latteB)).toEqual([null]);
    expect(await snapshots(B, outletOf(A), latteB)).toEqual([null]);

    // A's stored snapshots are invisible to a session of tenant B.
    await posSale([{ menuItemId: kitA.latte, quantity: 1 }]);
    const stored = (fx: Fx) =>
      withTenant(
        db,
        ctxOf(fx),
        async (tx) =>
          (
            await tx.execute(
              sql`SELECT count(*)::int AS n FROM order_items WHERE cost_snapshot_idr IS NOT NULL`,
            )
          ).rows[0]!.n,
      );
    expect(await stored(A)).toBeGreaterThan(0);
    expect(await stored(B)).toBe(0);
  }, 60_000);

  // Last: it registers an edge node on tenant A's outlet, which makes later QR
  // checkouts there queue for the edge.
  it("HPP-SNAP-10 an order applied on the edge from qr_order.placed stays NULL (the cloud copy has the snapshot)", async () => {
    const kit = await latteKit(A);
    const registered = await registerEdgeNode(
      ctxOf(A),
      randomUUID() as never,
      { outletId: A.outletId, role: "primary", label: "Utama HPP" } as never,
    );
    const edgeNodeId = (registered as { edgeNode: { id: string } }).edgeNode.id;
    await q(
      A,
      "UPDATE edge_nodes SET last_heartbeat_at = now() - make_interval(secs => 5) WHERE id = $1",
      [edgeNodeId],
    );

    const orderUlid = await qrOrder([{ menuItemId: kit.latte, quantity: 2 }]);
    const orderUuid = ulidToUuid(orderUlid);
    // The cloud order is costed.
    expect(await costOf(A, orderUuid, kit.latte)).toBe(11_600);

    const queued = await q<{ event: unknown }>(
      A,
      `SELECT event FROM edge_outbound_queue WHERE tenant_id = $1 ORDER BY link_seq`,
      [A.tenantId],
    );
    const event = queued
      .map((row) => eventEnvelopeSchema.parse(row.event) as EventEnvelope)
      .filter((candidate) => candidate.name === "qr_order.placed")
      .find((candidate) => {
        const text = JSON.stringify(candidate.payload).toLowerCase();
        return (
          text.includes(orderUuid) || text.includes(orderUlid.toLowerCase())
        );
      });
    expect(event, "queued qr_order.placed for the order").toBeDefined();

    // An empty edge database: remove the cloud copy (replica mode skips triggers and FKs).
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [A.tenantId],
      );
      await client.query(
        "DELETE FROM order_items WHERE tenant_id = $1 AND order_id = $2",
        [A.tenantId, orderUuid],
      );
      await client.query(
        "DELETE FROM orders WHERE tenant_id = $1 AND id = $2",
        [A.tenantId, orderUuid],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(await linesOf(A, orderUuid)).toHaveLength(0);

    registerQrOrderEdgeApplier();
    const edgeContext = establishScopedTenantContext(
      establishTenantContext({
        tenantId: A.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletOf(A)] },
    );
    await withTenant(db, edgeContext, (tx) =>
      edgeEventApplier("cloud_to_edge").apply(tx, event!, {
        edgeNodeId,
        direction: "cloud_to_edge",
        kind: "transaction_event",
        context: edgeContext,
      }),
    );

    const applied = await linesOf(A, orderUuid);
    expect(applied.length).toBeGreaterThan(0);
    for (const row of applied) expect(row.cost).toBeNull();
  }, 60_000);
});
