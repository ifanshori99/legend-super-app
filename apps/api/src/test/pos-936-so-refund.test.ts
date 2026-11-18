// legend-hpgyw (POS 936) second-opinion fixes, group R: refund and void of a
// bill that was (partly) paid with member points.
//
// Written from docs/briefs/1048-so-fixes.md (decisions 1 and 2) and the shared
// POS / loyalty contract, not from service code. Feature ids: SO-R-NN.
//
// Money rules proven here (founder: nobody is paid more, the outlet never loses):
// - points are not money: a manual refund approval is limited to what the bill
//   took in as NON-points tenders (all points: limit 0, refused);
// - a cashier refund and a manual refund racing for the same bill never pay
//   out more than the money received;
// - points debited on a bill that is voided before it is paid come back
//   exactly once (balance, tender voided, one ledger row, no journal);
// - a bill with points AND other captured money, or a fully paid bill, still
//   cannot be voided (that case needs a refund).
//
// Assumptions where the brief is silent (also in the report):
// - SO-R-01..03 seed completed bills straight in the database (Rp25.000 x 2
//   lines, no tax) like order-issues-manual-refund-approval-980.test.ts; a
//   points tender is a captured `pos_order_tenders` row with `points_used`.
//   Manual refund of one line = Rp25.000, approval bound to that value.
// - a refused manual refund is a 403, 409 or 422 (the brief fixes no code).
// - the restore ledger row's `type` is the engineer's choice (adjust or
//   reverse): the test finds it as "the one row that is neither the earn grant
//   nor the redeem row" and checks positive points, `reverses_entry_id` = the
//   redeem row and `source_id` = the points tender id (brief, Group R).
// - after a void the order status is "voided" or "cancelled".
// - in the redeem/void race, a void refused for a stale order status is
//   retried once with a fresh status; the retry must succeed.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPosOverrideSchema,
  posOverrideIdSchema,
} from "@starter/shared/access/override";
import {
  createUlid,
  decimal4,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant,
  balanceOf,
  ledgerOf,
  owner as memberOwner,
  seedMember,
  seedProgram,
  type Profile,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";

const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10%. */
const ORDER_TOTAL_IDR = 55_000;
const POINT_VALUE_IDR = 70;
/** floor(55.000 / 70): 786 points would be worth Rp55.020 > the bill. */
const MAX_POINTS_FULL_BILL = 785;
const MAX_VALUE_FULL_BILL = MAX_POINTS_FULL_BILL * POINT_VALUE_IDR; // 54.950

const PIN = "582914";
const DEVICE_ID = randomUUID();
/** The refunded line of the seeded bills: Rp25.000, one cup. */
const LINE_TOTAL = 25_000;

const POS_PERMISSIONS = [
  "order.view",
  "pos.sale.create",
  "pos.payment.accept",
  "pos.discount.apply",
  "pos.refund.request",
  "pos.void.request",
  "shift.cash.operate",
];

/** Receipt numbering double (the production port is wired elsewhere). */
function memoryReceiptPort(): PosReceiptPort {
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
        deviceId: input.deviceId ?? DEVICE_ID,
        number: `SOR936-${String(next).padStart(6, "0")}`,
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
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
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

let app: Express;

type Staff = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

/** Tenant 1: bills made through the public POS API, paid with points. */
type World = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  kopi: string;
  cashier: Staff;
  supervisor: Staff;
};
/** Tenant 2: completed bills seeded in the database, for manual refunds. */
type RefundWorld = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  recorder: Staff; // reports the manual refund, requests the cashier refund
  supervisor: Staff; // approves
  menuItem: string;
  stationId: string;
};
let world: World;
let rf: RefundWorld;

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
  scopes: string[],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
  return id;
}

async function staff(
  tenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId, email };
}

const tenantContext = (tenantId: string) =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });

async function seedWorld(): Promise<World> {
  const tenant = await createIsolatedTenant(`sor-${randomUUID().slice(0, 6)}`);
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  const template = await owner.query<{ permissions: string[] }>(
    "SELECT permissions FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [seededTenantId],
  );
  const cashierRole = await insertRole(
    tenant.tenantId,
    "Kasir Poin R",
    [
      ...new Set([
        ...POS_PERMISSIONS,
        ...(template.rows[0]?.permissions ?? []),
      ]),
    ],
    ["tenant", "outlet"],
  );
  const supervisorRole = await insertRole(
    tenant.tenantId,
    "Supervisor Poin R",
    ["order.view", "pos.void.approve", "pos.refund.approve"],
    ["tenant"],
  );
  const cashier = await staff(tenant, cashierRole, "Kasir Poin R");
  const supervisor = await staff(tenant, supervisorRole, "Supervisor Poin R");
  await verifySessionMfa(cashier.email);
  setPosReceiptPort(memoryReceiptPort());
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === DEVICE_ID
      ? tenant.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: DEVICE_ID,
  });
  const context = tenantContext(tenant.tenantId);
  await setStaffPin(
    context,
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await openPosShift(
    establishScopedTenantContext(context, { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId: DEVICE_ID },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const category = randomUUID();
  const kopi = randomUUID();
  await asTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Poin Uji R', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [kopi, tenant.tenantId, tenant.brandId, category, randomUUID()],
    );
    const priceList = randomUUID();
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceList, kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-SOR', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    kopi,
    cashier,
    supervisor,
  };
}

const short = () => randomUUID().slice(0, 6);

async function seedRefundWorld(): Promise<RefundWorld> {
  const tenant = await createIsolatedTenant(`sorr-${short()}`);
  const recorderRole = await insertRole(
    tenant.tenantId,
    "Pencatat Refund R",
    ["kds.remake_comp.record", "pos.refund.request"],
    ["tenant", "outlet", "station"],
  );
  const supervisorRole = await insertRole(
    tenant.tenantId,
    "Supervisor Refund R",
    ["pos.refund.approve", "kds.remake_comp.record", "pos.refund.request"],
    ["tenant", "outlet"],
  );
  // A phone approval fails closed without a refund rule; one tier, any amount.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenant.tenantId, supervisorRole],
  );
  const recorder = await staff(tenant, recorderRole, "Pencatat Refund R");
  const supervisor = await staff(tenant, supervisorRole, "Supervisor Refund R");
  await setStaffPin(
    tenantContext(tenant.tenantId),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );

  const stationId = randomUUID();
  await owner.query(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar R', 'beverage_bar')`,
    [stationId, tenant.tenantId, tenant.outletId],
  );
  const one = async (sql: string, params: unknown[]): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(sql, params);
    return rows[0]!.id;
  };
  const uom = (code: string) =>
    one(
      "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
      [tenant.tenantId, `${code}${short()}`.slice(0, 10)],
    );
  const [gramId, mlId, cupId] = [
    await uom("g"),
    await uom("ml"),
    await uom("cup"),
  ];
  const category = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Refund Uji R', 0)",
    [category, tenant.tenantId, tenant.brandId],
  );
  // A latte with a recipe and stock, so the issue cost can be computed.
  const location = await one(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'bar') RETURNING id",
    [tenant.tenantId, tenant.outletId, `Bar ${short()}`],
  );
  const inventoryItem = (name: string, baseUom: string) =>
    one(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3, true) RETURNING id`,
      [tenant.tenantId, `${name} ${short()}`, baseUom],
    );
  const beans = await inventoryItem("Biji Kopi", gramId);
  const milk = await inventoryItem("Susu", mlId);
  const scoped = establishScopedTenantContext(tenantContext(tenant.tenantId), {
    kind: "tenant",
  });
  for (const [itemId, quantity, cost] of [
    [beans, "100000.0000", "100.0000"],
    [milk, "1000000.0000", "20.0000"],
  ] as const)
    await recordStockMovement(scoped, {
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
  const recipe = await one(
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
  for (const [index, [itemId, qty, lineUom]] of (
    [
      [beans, "18.0000", gramId],
      [milk, "200.0000", mlId],
    ] as const
  ).entries())
    await owner.query(
      `INSERT INTO recipe_lines (tenant_id, recipe_id, sort_order, component_type, component_id, quantity, uom_id, waste_pct_bp)
       VALUES ($1, $2, $3, 'item', $4, $5, $6, 0)`,
      [tenant.tenantId, recipe, index, itemId, qty, lineUom],
    );
  const menuItem = await one(
    `INSERT INTO menu_items (tenant_id, brand_id, category_id, name, recipe_id, is_active, media_id, station_id, station_type)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, 'beverage_bar') RETURNING id`,
    [
      tenant.tenantId,
      tenant.brandId,
      category,
      `Latte ${short()}`,
      recipe,
      randomUUID(),
      stationId,
    ],
  );
  await owner.query(
    `INSERT INTO outlet_inventory_settings (tenant_id, outlet_id, recipe_deduction_mode, sale_location_id)
     VALUES ($1, $2, 'real_time', $3)
     ON CONFLICT (tenant_id, outlet_id)
     DO UPDATE SET recipe_deduction_mode = 'real_time', sale_location_id = EXCLUDED.sale_location_id`,
    [tenant.tenantId, tenant.outletId, location],
  );
  return {
    tenant,
    headers: { Host: tenant.hostname },
    recorder,
    supervisor,
    menuItem,
    stationId,
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  world = await seedWorld();
  rf = await seedRefundWorld();
}, 180_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await memberOwner.end();
  await owner.end();
});

const errorCodeOf = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;
const refusedStatus = (status: number) => [403, 409, 422].includes(status);

// ================================================================================
// Manual refund approval: points are not money (decision 1)
// ================================================================================

type Tender = { method: "cash" | "edc_card" | "points"; amountIdr: number };
type Bill = { ulid: string; uuid: string; lines: [Line, Line] };
type Line = { itemUlid: string; itemUuid: string };

let dayCounter = 0;
function nextDate(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2034, 0, 1 + dayCounter)).toISOString().slice(0, 10);
}

async function asRfTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [rf.tenant.tenantId],
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

/**
 * A completed bill with two Rp25.000 lines (total Rp50.000, no tax) and the
 * given captured tenders (their sum must be the total).
 */
async function seedBill(tenders: Tender[]): Promise<Bill> {
  expect(tenders.reduce((sum, t) => sum + t.amountIdr, 0)).toBe(LINE_TOTAL * 2);
  const ulid = createUlid();
  const uuid = ulidToUuid(ulid);
  const businessDate = nextDate();
  const lines = [0, 1].map((): Line => {
    const itemUlid = createUlid();
    return { itemUlid, itemUuid: ulidToUuid(itemUlid) };
  });
  const { tenantId, outletId } = rf.tenant;
  await asRfTenant(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
               'completed', $6, now())`,
      [
        uuid,
        tenantId,
        outletId,
        `SOR-${randomUUID().slice(0, 12)}`,
        LINE_TOTAL * 2,
        businessDate,
      ],
    );
    for (const line of lines)
      await client.query(
        `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, variant_id, name,
            quantity, unit_price_idr, modifiers_total_idr, line_total_idr, modifiers,
            fire_status, status, reserved_business_date)
         VALUES ($1, $2, $3, $4, $5, NULL, 'Latte', 1, $6, 0, $6, '[]'::jsonb,
                 'fired', 'served', $7)`,
        [
          line.itemUuid,
          tenantId,
          outletId,
          uuid,
          rf.menuItem,
          LINE_TOTAL,
          businessDate,
        ],
      );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [uuid, tenantId, outletId],
    );
    for (const tender of tenders) {
      if (tender.method === "cash")
        await client.query(
          `INSERT INTO pos_order_tenders
             (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
              change_idr, status, requested_at, resolved_at)
           VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now())`,
          [tenantId, outletId, uuid, tender.amountIdr],
        );
      else if (tender.method === "edc_card")
        await client.query(
          `INSERT INTO pos_order_tenders
             (tenant_id, outlet_id, order_id, method, provider, amount_idr, status, reference,
              requested_at, resolved_at)
           VALUES ($1, $2, $3, 'edc_card', 'edc', $4, 'captured', $5, now(), now())`,
          [tenantId, outletId, uuid, tender.amountIdr, `BANK-${ulid}`],
        );
      else
        await client.query(
          `INSERT INTO pos_order_tenders
             (tenant_id, outlet_id, order_id, method, provider, amount_idr, points_used,
              status, requested_at, resolved_at)
           VALUES ($1, $2, $3, 'points', 'manual', $4, $5, 'captured', now(), now())`,
          [
            tenantId,
            outletId,
            uuid,
            tender.amountIdr,
            Math.floor(tender.amountIdr / 100),
          ],
        );
    }
  });
  return { ulid, uuid, lines: [lines[0]!, lines[1]!] };
}

/** A supervisor-PIN approval for a manual refund of one line (value = line total). */
async function lineApproval(line: Line) {
  const { override } = await createPosOverride(
    tenantContext(rf.tenant.tenantId),
    rf.recorder.userId,
    createPosOverrideSchema.parse({
      outletId: rf.tenant.outletId,
      action: "refund",
      valueIdr: LINE_TOTAL,
      reason: "Refund manual dibayar poin",
      objectType: "order_item",
      objectId: line.itemUlid,
      approval: {
        method: "supervisor_pin",
        approverUserId: rf.supervisor.userId,
        pin: PIN,
      },
    }),
    { idempotencyKey: randomUUID() },
  );
  return override;
}

function reportManualRefund(
  bill: Bill,
  line: Line,
  overrideId: string,
  stationId = rf.stationId,
) {
  return rf.recorder.client
    .post(`/api/outlets/${rf.tenant.outletId}/orders/${bill.ulid}/issues`)
    .set(rf.headers)
    .set(originHeader)
    .send({
      orderItemId: line.itemUlid,
      type: "complaint",
      reason: "complaint",
      reasonNote: "Pelanggan kecewa, refund manual disetujui",
      stationId,
      employeeId: null,
      resolution: "manual_refund",
      voucherId: null,
      approvedBy: rf.supervisor.userId,
      overrideId,
      idempotencyKey: `sor-${randomUUID()}`,
    });
}

async function issueRows(line: Line): Promise<number> {
  const { rows } = await owner.query(
    "SELECT 1 FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
    [rf.tenant.tenantId, line.itemUuid],
  );
  return rows.length;
}

async function approvalUses(overrideId: string): Promise<number> {
  const { rows } = await owner.query(
    "SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1",
    [ulidToUuid(overrideId)],
  );
  return rows.length;
}

/** Refund one line by manual approval; expect it refused and nothing spent. */
async function expectManualRefundRefused(bill: Bill, line: Line) {
  const override = await lineApproval(line);
  const response = await reportManualRefund(bill, line, override.id);
  expect(
    refusedStatus(response.status),
    `status ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(true);
  expect(await issueRows(line)).toBe(0);
  expect(await approvalUses(override.id)).toBe(0);
}

/** The same kind of line on an all-cash bill is refunded: the refusal is about points. */
async function expectCashControlRefunds() {
  const clean = await seedBill([{ method: "cash", amountIdr: LINE_TOTAL * 2 }]);
  const override = await lineApproval(clean.lines[0]);
  const response = await reportManualRefund(clean, clean.lines[0], override.id);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(await issueRows(clean.lines[0])).toBe(1);
}

describe("SO-R manual refund counts only non-points money", () => {
  it("SO-R-01 a bill fully paid with points has refund limit 0: the manual refund is refused and nothing is spent", async () => {
    const bill = await seedBill([
      { method: "points", amountIdr: LINE_TOTAL * 2 },
    ]);
    await expectManualRefundRefused(bill, bill.lines[0]);
    await expectManualRefundRefused(bill, bill.lines[1]);
    await expectCashControlRefunds();
  });

  it("SO-R-02 a mixed bill: a line worth more than the non-points part (Rp20.000 cash + Rp30.000 points) is refused", async () => {
    const bill = await seedBill([
      { method: "cash", amountIdr: 20_000 },
      { method: "points", amountIdr: 30_000 },
    ]);
    await expectManualRefundRefused(bill, bill.lines[0]);
    await expectCashControlRefunds();
  });

  it("SO-R-03 a mixed bill (Rp30.000 cash + Rp20.000 points): the first Rp25.000 line fits the cash part, the second would pay out points as money and is refused", async () => {
    const bill = await seedBill([
      { method: "cash", amountIdr: 30_000 },
      { method: "points", amountIdr: 20_000 },
    ]);
    const first = await lineApproval(bill.lines[0]);
    const ok = await reportManualRefund(bill, bill.lines[0], first.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await issueRows(bill.lines[0])).toBe(1);
    // Rp50.000 of refunds against Rp30.000 of real money.
    await expectManualRefundRefused(bill, bill.lines[1]);
  });

  it("SO-R-04 a cashier refund racing a manual refund never pays out more than the money received", async () => {
    // Money received: Rp20.000 by card. Points: Rp30.000 (not money).
    const MONEY_IDR = 20_000;
    const bill = await seedBill([
      { method: "edc_card", amountIdr: MONEY_IDR },
      { method: "points", amountIdr: 30_000 },
    ]);
    const line = bill.lines[0];
    const manualOverride = await lineApproval(line);
    const { override: cashierOverride } = await createPosOverride(
      tenantContext(rf.tenant.tenantId),
      rf.recorder.userId,
      {
        outletId: rf.tenant.outletId,
        action: "refund",
        valueIdr: MONEY_IDR,
        reason: "Refund kasir lawan refund manual",
        objectType: "order",
        objectId: bill.ulid,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(rf.supervisor.userId),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    const [manual, cashier] = await Promise.all([
      reportManualRefund(bill, line, manualOverride.id),
      refundPosOrder(
        establishScopedTenantContext(tenantContext(rf.tenant.tenantId), {
          kind: "tenant",
        }),
        {
          userId: userIdSchema.parse(rf.recorder.userId),
          deviceId: null,
          expectedVersion: null,
        },
        outletIdSchema.parse(rf.tenant.outletId),
        bill.ulid,
        {
          idempotencyKey: randomUUID(),
          amountIdr: MONEY_IDR,
          reason: "quality_complaint",
          reasonNote: "Refund kasir lawan refund manual",
          overrideId: posOverrideIdSchema.parse(cashierOverride.id),
          approvedBy: userIdSchema.parse(rf.supervisor.userId),
        },
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ]);
    // No server error from the race.
    expect(manual.status, JSON.stringify(manual.body)).toBeLessThan(500);
    if (!cashier.ok) {
      const status = (cashier.error as { status?: number }).status;
      if (typeof status === "number") expect(status).toBeLessThan(500);
    }
    const { rows } = await owner.query<{ total: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
      [rf.tenant.tenantId, bill.uuid],
    );
    const cashierPaid = Number(rows[0]!.total);
    const manualPaid = manual.status === 201 ? LINE_TOTAL : 0;
    expect(cashierPaid + manualPaid).toBeLessThanOrEqual(MONEY_IDR);
    // One approval, one refund: the two paths never both pay.
    expect(cashierPaid > 0 && manualPaid > 0).toBe(false);
  });
});

// ================================================================================
// Void before payment gives debited points back (decision 2)
// ================================================================================

type CreatedOrder = { id: string; outletId: string };

async function newOrder(member: Profile): Promise<CreatedOrder> {
  const outletId = world.tenant.outletId;
  const created = await world.cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: world.kopi, quantity: 2, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  const id = created.body.data.id as string;
  // Member proof (decision 4): the member QR was scanned at the till.
  await asTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE orders
          SET customer_profile_id = $3, customer_attached_via = 'member_qr',
              customer_attached_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenant.tenantId, ulidToUuid(id), member.id],
    ),
  );
  const submitted = await world.cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(outletId)}/pos/orders/${id}/submit`,
    )
    .set(world.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      expectedStatus: created.body.data.status as string,
    });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return { id, outletId };
}

async function memberWith(points: number): Promise<Profile> {
  const member = await seedMember(world.tenant.tenantId);
  await grantPoints(world.tenant.tenantId, member.id, points);
  expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(points);
  return member;
}

const redeem = (order: CreatedOrder, points: number) =>
  world.cashier.client
    .post(`/api/pos/orders/${order.id}/points/redeem`)
    .set(world.headers)
    .set(originHeader)
    .send({ points, idempotencyKey: randomUUID() });

async function redeemOk(order: CreatedOrder, points: number) {
  const response = await redeem(order, points);
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
}

async function seedCashTender(order: CreatedOrder, amountIdr: number) {
  await asTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, points_used, payment_intent_id, reference, status,
          requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, NULL, NULL, NULL, 'captured', now(), now())`,
      [world.tenant.tenantId, order.outletId, ulidToUuid(order.id), amountIdr],
    ),
  );
}

async function pointsTenders(order: CreatedOrder) {
  const { rows } = await asTenant(world.tenant.tenantId, (client) =>
    client.query<{ id: string; points_used: number; status: string }>(
      `SELECT id, points_used, status FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2 AND method = 'points'
        ORDER BY created_at, id`,
      [world.tenant.tenantId, ulidToUuid(order.id)],
    ),
  );
  return rows;
}

const orderDetail = (order: CreatedOrder) =>
  world.cashier.client
    .get(
      `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}`,
    )
    .set(world.headers)
    .set(originHeader);

async function statusOf(order: CreatedOrder): Promise<string> {
  const detail = await orderDetail(order);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return detail.body.data.status as string;
}

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: world.tenant.tenantId,
    brandId: null,
    deviceId: DEVICE_ID,
  });

/** A single-use supervisor-PIN approval for voiding the whole bill. */
async function voidApproval(order: CreatedOrder) {
  const { override } = await createPosOverride(
    tenantContext(world.tenant.tenantId),
    world.cashier.userId,
    {
      outletId: order.outletId,
      action: "void",
      valueIdr: ORDER_TOTAL_IDR,
      reason: "Pelanggan batal bayar",
      objectType: "order",
      objectId: order.id,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(world.supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: world.supervisor.userId, overrideId: override.id };
}

type PreparedVoid = { send: () => ReturnType<typeof voidOrder> };

function voidOrder(order: CreatedOrder, body: Record<string, unknown>) {
  return world.cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/void`,
    )
    .set(world.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({
      idempotencyKey: randomUUID(),
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal sebelum bayar lunas",
      ...body,
    });
}

/** Approval and status are read now; the request is sent when `send` is called. */
async function prepareVoid(order: CreatedOrder): Promise<PreparedVoid> {
  const expectedStatus = await statusOf(order);
  const approval = await voidApproval(order);
  return { send: () => voidOrder(order, { expectedStatus, ...approval }) };
}

async function voidNow(order: CreatedOrder) {
  return (await prepareVoid(order)).send();
}

async function journalLineCount(): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM journal_lines WHERE tenant_id = $1",
    [world.tenant.tenantId],
  );
  return Number(rows[0]!.count);
}

/** Ledger rows that are neither the earn grant nor a redeem: the restores. */
async function restoreRows(member: Profile) {
  return (await ledgerOf(world.tenant.tenantId, member.id)).filter(
    (row) => row.type !== "earn" && row.type !== "redeem",
  );
}

const redeemRows = async (member: Profile) =>
  (await ledgerOf(world.tenant.tenantId, member.id)).filter(
    (row) => row.type === "redeem",
  );

describe("SO-R void of a bill with points redeemed but not yet paid", () => {
  it("SO-R-05 partial points redeem then void gives back exactly the points once: balance, tender voided, one ledger row, no journal", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder(member);
    await redeemOk(order, 100);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(4_900);
    const [tender] = await pointsTenders(order);
    const [redeemRow] = await redeemRows(member);
    expect(tender).toMatchObject({ points_used: 100, status: "captured" });
    const journalBefore = await journalLineCount();

    const voided = await voidNow(order);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);

    expect(["voided", "cancelled"]).toContain(await statusOf(order));
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(5_000);
    expect(await pointsTenders(order)).toEqual([
      { id: tender!.id, points_used: 100, status: "voided" },
    ]);
    const restores = await restoreRows(member);
    expect(restores).toHaveLength(1);
    expect(Number(restores[0]!.points)).toBe(100);
    expect(restores[0]!.reverses_entry_id).toBe(redeemRow!.id);
    expect(String(restores[0]!.source_id).toLowerCase()).toBe(
      tender!.id.toLowerCase(),
    );
    // A pos_tender debit books no journal, and neither does its restore.
    expect(await journalLineCount()).toBe(journalBefore);
  });

  it("SO-R-06 voiding twice, one after the other, restores once", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder(member);
    await redeemOk(order, 100);
    const first = await voidNow(order);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await voidNow(order);
    // Refused or an idempotent answer, never a server error and never a
    // second give-back.
    expect(second.status).toBeLessThan(500);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(5_000);
    expect(await restoreRows(member)).toHaveLength(1);
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "voided",
    ]);
  });

  it("SO-R-07 two voids at the same time restore once", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder(member);
    await redeemOk(order, 100);
    const [one, two] = [await prepareVoid(order), await prepareVoid(order)];
    const results = await Promise.all([one.send(), two.send()]);
    for (const result of results) expect(result.status).toBeLessThan(500);
    expect(
      results.some((result) => result.status === 200),
      JSON.stringify(results.map((result) => result.body)),
    ).toBe(true);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(5_000);
    expect(await restoreRows(member)).toHaveLength(1);
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "voided",
    ]);
  });

  it("SO-R-08 a redeem racing a void never leaves points taken from a voided bill", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder(member);
    await redeemOk(order, 100);
    const racingVoid = await prepareVoid(order);
    const [second, firstVoid] = await Promise.all([
      redeem(order, 200),
      racingVoid.send(),
    ]);
    for (const result of [second, firstVoid])
      expect(result.status).toBeLessThan(500);
    if (!["voided", "cancelled"].includes(await statusOf(order))) {
      // The void met a stale status: one retry with a fresh one must work.
      const retry = await voidNow(order);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    }
    expect(["voided", "cancelled"]).toContain(await statusOf(order));

    // Whatever the order of events: every points tender is voided, every
    // redeem has exactly one give-back, and the member is whole again.
    const tenders = await pointsTenders(order);
    for (const tender of tenders) expect(tender.status).toBe("voided");
    const redeems = await redeemRows(member);
    const restores = await restoreRows(member);
    expect(restores).toHaveLength(redeems.length);
    expect(new Set(restores.map((row) => row.reverses_entry_id))).toEqual(
      new Set(redeems.map((row) => row.id)),
    );
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(5_000);
  });

  it("SO-R-09 a mixed bill (points redeemed and cash captured) still cannot be voided; nothing changes", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder(member);
    await seedCashTender(order, 20_000);
    await redeemOk(order, 100);
    const statusBefore = await statusOf(order);

    const voided = await voidNow(order);
    expect(voided.status, JSON.stringify(voided.body)).toBe(409);

    expect(await statusOf(order)).toBe(statusBefore);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(4_900);
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "captured",
    ]);
    expect(await restoreRows(member)).toHaveLength(0);
  });

  it("SO-R-10 a fully paid order still cannot be voided; the points stay spent", async () => {
    const member = await memberWith(5_000);
    const order = await newOrder(member);
    // Rp50 in cash so that 785 points (Rp54.950) settle the rest exactly.
    await seedCashTender(order, ORDER_TOTAL_IDR - MAX_VALUE_FULL_BILL);
    await redeemOk(order, MAX_POINTS_FULL_BILL);
    const expectedStatus = await statusOf(order);
    const completed = await world.cashier.client
      .post(
        `/api/outlets/${encodeURIComponent(order.outletId)}/pos/orders/${order.id}/complete`,
      )
      .set(world.headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({
        idempotencyKey: randomUUID(),
        expectedStatus,
      });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const statusBefore = await statusOf(order);

    const voided = await voidNow(order);
    expect(voided.status, JSON.stringify(voided.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(voided.status).toBeLessThan(500);

    expect(await statusOf(order)).toBe(statusBefore);
    expect(await balanceOf(world.tenant.tenantId, member.id)).toBe(
      5_000 - MAX_POINTS_FULL_BILL,
    );
    expect((await pointsTenders(order)).map((row) => row.status)).toEqual([
      "captured",
    ]);
    expect(await restoreRows(member)).toHaveLength(0);
    expect(errorCodeOf(voided.body)).toBeTruthy();
  });
});
