// End-of-day ("Tutup Hari") acceptance tests (bead legend-6c0; PRD v1.7 §3 F8
// "Tutup Hari", acceptance POS-05: "Total penjualan harian di POS, akuntansi,
// dan dashboard identik"). Contract: @starter/shared/pos endOfDayRecapSchema,
// closeBusinessDayInputSchema, dayClosedPayloadSchema, endpoints getEndOfDayRecap
// (GET /api/outlets/:outletId/pos/day) and closePosDay (POST .../day/close).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant. Everything is driven through HTTP except fixtures that the
// brief says to seed directly (price lists, roles, supervisor PIN overrides).
//
// The tests in each describe run in order on ONE business day: the recap is
// built up first, the refusal cases each leave exactly one blocker, and the
// irreversible day close comes last.
//
// Assumptions (the brief leaves them open):
// - A completed sale later corrected by a linked void/refund stays `completed`
//   (POS-04), so it stays in the sales set; the void/refund amounts are then
//   subtracted per tender (identity: tender net = sales - refunds - voids).
// - A sale made before any shift is open is attributed to the nil-uuid device;
//   a sale made while the cashier's shift is open is attributed to the shift's
//   device (the order service wires the shift lookup through app.ts).
// - A supervisor's PIN override for `cash_shift_close` names the cashier's
//   blind count submission (objectType `pos_shift_count`, round 2) and is
//   named in the close body by the override's own ULID (`override.id`).
// - A day close blocked by a rule is 409 (CoreError CONFLICT / PosError 409);
//   an unavailable inventory port is 503; permission failures are 403;
//   strict-schema validation failures are 422 (the API error handler's
//   convention for ZodError, not 400).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  dayClosedPayloadSchema,
  endOfDayRecapSchema,
  type EndOfDayRecap,
  type PosReceipt,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import type { PosReceiptPort } from "../services/pos-order-ports.ts";
import { setPosOutletReceiptGapsPort } from "../services/pos-shift-ports.ts";
import { closePosDay, getEndOfDayRecap } from "../services/pos-day.service.ts";
import { recordCashMovement } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { seedEconomicDepositRefund } from "./dp-economic-refund-fixture.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const KOPI_GOFOOD_IDR = 30_000;
const OPENING_FLOAT_IDR = 100_000;
const NIL_DEVICE = "00000000-0000-0000-0000-000000000000";
const EMPTY_DAY = "2025-01-15";

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  goFoodPriceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  managerRole: randomUUID(),
  viewerRole: randomUUID(),
  otherRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let other: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
let manager: Member;
let viewer: Member;
let otherManager: Member;
/** device id -> outlet id for the extra outlets a describe adds (legend-ifnb). */
const extraDevices = new Map<string, string>();

// Seeded by `seedDay`.
type Sale = { orderId: string; totalIdr: number };
const sales: Record<"a" | "b" | "c" | "d" | "e", Sale> = {} as never;
let shiftId = "";
let today = "";
let refundedIdr = 0;

// ---- Receipt numbering double (legend-93a port) --------------------------------

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
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

// ---- Fixtures ---------------------------------------------------------------------

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

async function memberOf(
  tenantId: string,
  roleId: string,
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  return { client, userId };
}

function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

/** A terminal: the outlet it belongs to and its device id. */
type Till = { outletId: string; deviceId: string };
const mainTill = (): Till => ({
  outletId: tenant.outletId,
  deviceId: ids.device,
});

function pos(
  who: Member = cashier,
  withDevice = true,
  till: Till = mainTill(),
) {
  const base = `/api/outlets/${encodeURIComponent(till.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) => {
    const request = who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader);
    // The till: cash goes into the drawer of the shift open on this device.
    // An order made without the device header belongs to no terminal.
    if (withDevice) request.set("X-Device-Token", deviceToken(till.deviceId));
    return request.send({ idempotencyKey: randomUUID(), ...body });
  };
  return {
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
      }),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

/** create → submit → cash → complete, paid in cash. */
async function cashSale(
  body: Record<string, unknown> = {},
  /** Runs after create/submit, before the cash is taken (cash needs a shift). */
  beforeCash?: () => Promise<void>,
): Promise<{ orderId: string; totalIdr: number; shiftId: string | null }> {
  // The order carries the device it was made on; a sale made before any shift
  // is open (`beforeCash`) is rung up with no device, so it stays on the nil
  // device. Only the cash tender below needs the till.
  const ring = pos(cashier, !beforeCash);
  const created = await ring.create(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await ring.submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  await beforeCash?.();
  const paid = await pos().cash(orderId, status, totalIdr + 5_000);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  status = paid.body.data.order.status as string;
  const completed = await pos().complete(orderId, status);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return {
    orderId,
    totalIdr,
    shiftId: (completed.body.data.shiftId as string | null) ?? null,
  };
}

/** The supervisor's own tile + PIN, as the POS does it (staff-override service). */
async function pinApproval(input: {
  action: "void" | "refund" | "cash_shift_close";
  objectType: "order" | "pos_shift_count";
  objectId: string;
  valueIdr: number;
  approver?: string;
  /** Defaults to the main outlet. */
  outletId?: string;
}) {
  const approver = input.approver ?? supervisor.userId;
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: input.outletId ?? tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: "Persetujuan uji tutup hari",
      objectType: input.objectType,
      objectId: input.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  // Void/refund name the override itself (main legend-0gy1); the shift close
  // names it by its ULID too (legend-6c0).
  if (input.action !== "cash_shift_close")
    return { approvedBy: approver, overrideId: override.id };
  return { approvedBy: approver, approvalRequestId: override.id };
}

const deviceToken = (deviceId: string = ids.device) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

function shiftApi(who: Member = cashier, till: Till = mainTill()) {
  const base = `/api/outlets/${encodeURIComponent(till.outletId)}/pos/shifts`;
  return {
    open: (body: Record<string, unknown> = {}) =>
      who.client
        .post(base)
        .set(headers)
        .set(originHeader)
        .set("X-Device-Token", deviceToken(till.deviceId))
        .send({
          openingFloatIdr: OPENING_FLOAT_IDR,
          idempotencyKey: randomUUID(),
          ...body,
        }),
    /** The blind count submission (round 2): the close names its id. */
    count: (
      id: string,
      counts: { denominationIdr: number; quantity: number }[],
    ) =>
      who.client
        .post(`${base}/${id}/counts`)
        .set(headers)
        .set(originHeader)
        .send({ counts, idempotencyKey: randomUUID() }),
    close: (id: string, body: Record<string, unknown>) =>
      who.client
        .post(`${base}/${id}/close`)
        .set(headers)
        .set(originHeader)
        .send({ idempotencyKey: randomUUID(), ...body }),
  };
}

function day(who: Member = manager, outletId = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/day`;
  return {
    get: (businessDate: string = today) =>
      who.client
        .get(`${base}?businessDate=${encodeURIComponent(businessDate)}`)
        .set(headers)
        .set(originHeader),
    close: (body: Record<string, unknown> = {}) =>
      who.client
        .post(`${base}/close`)
        .set(headers)
        .set(originHeader)
        .send({
          businessDate: today,
          inventoryDeduction: false,
          idempotencyKey: randomUUID(),
          ...body,
        }),
  };
}

async function dailyCloseRows(businessDate: string = today) {
  const { rows } = await owner.query<{
    order_count: number;
    total_sales_idr: string;
    total_refunds_idr: string;
    total_voids_idr: string;
    total_variance_idr: string;
    inventory_deduction_applied: boolean;
    closed_by: string;
    recap: EndOfDayRecap;
  }>(
    `SELECT order_count, total_sales_idr, total_refunds_idr, total_voids_idr,
            total_variance_idr, inventory_deduction_applied, closed_by, recap
     FROM pos_daily_closes
     WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
    [tenant.tenantId, tenant.outletId, businessDate],
  );
  return rows;
}

async function dayClosedEvents(businessDate: string = today) {
  const { rows } = await owner.query<{ payload: unknown }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'day.closed'
       AND event->'payload'->>'businessDate' = $2`,
    [tenant.tenantId, businessDate],
  );
  return rows;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** One closed-recap parse: every response must satisfy the contract. */
function parseRecap(body: { data: unknown }): EndOfDayRecap {
  return endOfDayRecapSchema.parse(body.data);
}

// ---- Seed: sales, one refund, one void, one open shift -----------------------------

async function seedDay() {
  // Sale A: made before any shift is open -> nil-uuid device. Cash needs the
  // cashier's open shift (finding 2), so the order is created and submitted
  // with no shift, then the shift opens just before the cash is taken.
  const first: {
    opened?: Awaited<ReturnType<ReturnType<typeof shiftApi>["open"]>>;
  } = {};
  const a = await cashSale({}, async () => {
    first.opened = await shiftApi().open();
  });
  sales.a = a;
  const rows = await owner.query<{ business_date: string }>(
    `SELECT business_date::text AS business_date FROM orders
     WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(a.orderId)],
  );
  today = rows.rows[0]?.business_date ?? "";
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  const shiftOpened = first.opened;
  if (!shiftOpened) throw new Error("the shift opens before sale A is paid");
  expect(shiftOpened.status, JSON.stringify(shiftOpened.body)).toBe(201);
  shiftId = shiftOpened.body.data.id as string;

  // Sales B, C, D (pos) and E (gofood, a different price list) on the shift.
  for (const key of ["b", "c", "d"] as const) {
    const sale = await cashSale();
    expect(sale.shiftId, "order service must attach the open shift").toBe(
      shiftId,
    );
    sales[key] = sale;
  }
  sales.e = await cashSale({
    channel: "gofood",
    serviceType: "takeaway",
    externalRef: `GF-${randomUUID().slice(0, 8)}`,
  });

  // A partial refund of B and a linked void of C.
  refundedIdr = KOPI_IDR;
  const refund = await pos().refund(sales.b.orderId, {
    reason: "quality_complaint",
    reasonNote: "Minuman tumpah",
    amountIdr: refundedIdr,
    ...(await pinApproval({
      action: "refund",
      objectType: "order",
      objectId: sales.b.orderId,
      valueIdr: refundedIdr,
    })),
  });
  expect(refund.status, JSON.stringify(refund.body)).toBeLessThan(300);
  const voided = await pos().correctionVoid(sales.c.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...(await pinApproval({
      action: "void",
      objectType: "order",
      objectId: sales.c.orderId,
      valueIdr: sales.c.totalIdr,
    })),
  });
  expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`day-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`dayx-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : tenantId === tenant.tenantId
        ? (extraDevices.get(deviceId) ?? null)
        : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });

  const roles: [string, string, string, string[]][] = [
    [
      ids.cashierRole,
      tenant.tenantId,
      "Kasir Tutup Hari",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      tenant.tenantId,
      "Supervisor Tutup Hari",
      [
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "shift.cash.approve_close",
        "shift.cash.view_all",
      ],
    ],
    // Founder Q9 (2026-11-08): only the outlet manager closes the business
    // day. A supervisor approves shift closes but holds no `pos.day.close`.
    [
      ids.managerRole,
      tenant.tenantId,
      "Manajer Outlet Hari",
      ["pos.day.close"],
    ],
    [ids.viewerRole, tenant.tenantId, "Tanpa POS", ["floor.table.view"]],
    [
      ids.otherRole,
      other.tenantId,
      "Manajer Tenant Lain",
      [
        "order.view",
        "pos.day.close",
        "shift.cash.approve_close",
        "shift.cash.operate",
      ],
    ],
  ];
  for (const [id, tenantId, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant"]')`,
      [
        id,
        tenantId,
        name,
        JSON.stringify(permissions),
        id === ids.supervisorRole ? "supervisor" : null,
      ],
    );
  cashier = await memberOf(tenant.tenantId, ids.cashierRole, "Kasir Hari");
  supervisor = await memberOf(
    tenant.tenantId,
    ids.supervisorRole,
    "Supervisor Hari",
  );
  manager = await memberOf(tenant.tenantId, ids.managerRole, "Manajer Hari");
  viewer = await memberOf(tenant.tenantId, ids.viewerRole, "Tamu Hari");
  otherManager = await memberOf(other.tenantId, ids.otherRole, "Manajer Lain");
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Hari Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    for (const [listId, channel, price] of [
      [ids.priceList, "takeaway", KOPI_IDR],
      [ids.goFoodPriceList, "gofood", KOPI_GOFOOD_IDR],
    ] as const) {
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [listId, tenant.tenantId, tenant.outletId, channel],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, listId, ids.kopi, price],
      );
    }
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-DAY', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
  await seedDay();
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setPosOutletReceiptGapsPort(null);
  setDeviceOutletResolver(null);
  // Final orders and audit rows are immutable, so the isolated tenants stay in
  // the disposable database; give them a valid creator for the tenant list.
  for (const row of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      row.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Recap ------------------------------------------------------------------------

describe("POS-05 end-of-day recap (legend-6c0)", () => {
  it("POS-05 a day without activity returns an open recap with one zero row per list, never an empty list", async () => {
    const response = await day().get(EMPTY_DAY);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const recap = parseRecap(response.body);
    expect(recap).toMatchObject({
      businessDate: EMPTY_DAY,
      status: "open",
      closedAt: null,
      closedBy: null,
      totalSalesIdr: 0,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
      totalVarianceIdr: 0,
      inventoryDeductionApplied: false,
      accountingSync: { status: "pending", journalCount: 0, postedAt: null },
    });
    expect(recap.devices).toHaveLength(1);
    expect(recap.devices[0]).toMatchObject({
      deviceId: NIL_DEVICE,
      orderCount: 0,
      totalIdr: 0,
      shiftCount: 0,
    });
    expect(recap.tenders).toEqual([
      { method: "cash", capturedIdr: 0, refundedIdr: 0, netIdr: 0 },
    ]);
    expect(recap.channels).toEqual([
      { channel: "pos", orderCount: 0, totalIdr: 0 },
    ]);
    // Reading a recap never closes the day.
    expect(await dailyCloseRows(EMPTY_DAY)).toHaveLength(0);
  });

  it("POS-05 the recap of a busy day satisfies the identity: tender net = sales - refunds - voids", async () => {
    const response = await day().get();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const recap = parseRecap(response.body);
    const allSales = sum(Object.values(sales).map((sale) => sale.totalIdr));

    expect(recap).toMatchObject({
      businessDate: today,
      status: "open",
      closedAt: null,
      closedBy: null,
      totalSalesIdr: allSales,
      totalRefundsIdr: refundedIdr,
      totalVoidsIdr: sales.c.totalIdr,
      inventoryDeductionApplied: false,
      accountingSync: { status: "pending", journalCount: 0, postedAt: null },
    });
    const cash = recap.tenders.find((row) => row.method === "cash");
    expect(cash).toEqual({
      method: "cash",
      capturedIdr: allSales,
      refundedIdr: refundedIdr + sales.c.totalIdr,
      netIdr: allSales - refundedIdr - sales.c.totalIdr,
    });
    expect(sum(recap.tenders.map((row) => row.netIdr))).toBe(
      recap.totalSalesIdr - recap.totalRefundsIdr - recap.totalVoidsIdr,
    );
  });

  it("POS-05 the recap splits sales by channel with the right counts and totals", async () => {
    const recap = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    const posTotal = sum(
      (["a", "b", "c", "d"] as const).map((key) => sales[key].totalIdr),
    );
    expect(recap.channels).toHaveLength(2);
    expect(recap.channels).toEqual(
      expect.arrayContaining([
        { channel: "pos", orderCount: 4, totalIdr: posTotal },
        { channel: "gofood", orderCount: 1, totalIdr: sales.e.totalIdr },
      ]),
    );
    // The outlet-specific gofood price list is what the sale was billed at.
    expect(sales.e.totalIdr).toBeGreaterThan(sales.b.totalIdr);
  });

  it("POS-05 the recap attributes sales, refunds and voids to the terminal that made them", async () => {
    const recap = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    const nil = recap.devices.find((row) => row.deviceId === NIL_DEVICE);
    const device = recap.devices.find((row) => row.deviceId === ids.device);
    expect(recap.devices).toHaveLength(2);
    expect(nil).toMatchObject({
      orderCount: 1,
      totalIdr: sales.a.totalIdr,
      voidedOrderCount: 0,
      refundCount: 0,
      shiftCount: 0,
    });
    expect(device).toMatchObject({
      orderCount: 4,
      totalIdr: sum(
        (["b", "c", "d", "e"] as const).map((key) => sales[key].totalIdr),
      ),
      voidedOrderCount: 1,
      voidedAmountIdr: sales.c.totalIdr,
      refundCount: 1,
      refundAmountIdr: refundedIdr,
      shiftCount: 1,
      // The cashier's shift is still open, so the terminal is not closed yet.
      closed: false,
    });
  });

  it("POS-05 reading the recap twice gives the same figures and changes nothing", async () => {
    const first = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    const second = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    expect({ ...second, id: undefined, generatedAt: undefined }).toEqual({
      ...first,
      id: undefined,
      generatedAt: undefined,
    });
    expect(await dailyCloseRows()).toHaveLength(0);
    expect(await dayClosedEvents()).toHaveLength(0);
  });

  it("POS-05 an invalid or missing business date and extra body fields are refused with 422", async () => {
    const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day`;
    for (const query of [
      "",
      "?businessDate=besok",
      "?businessDate=2026-13-45",
    ]) {
      const bad = await supervisor.client
        .get(`${base}${query}`)
        .set(headers)
        .set(originHeader);
      expect(bad.status, query).toBe(422);
    }
    const extra = await day().close({ closedBy: manager.userId });
    expect(extra.status, JSON.stringify(extra.body)).toBe(422);
    const noKey = await day().close({ idempotencyKey: undefined });
    expect(noKey.status).toBe(422);
    expect(await dailyCloseRows()).toHaveLength(0);
  });
});

// ---- Permissions ------------------------------------------------------------------

describe("POS-05 who may read and close the day (legend-6c0)", () => {
  it("a cashier with only shift.cash.operate and a user without POS rights get 403 on read and close", async () => {
    for (const who of [cashier, viewer]) {
      const read = await day(who).get();
      expect(read.status, JSON.stringify(read.body)).toBe(403);
      const close = await day(who).close();
      expect(close.status, JSON.stringify(close.body)).toBe(403);
    }
    expect(await dailyCloseRows()).toHaveLength(0);
  });

  it("the service checks the permission itself, not only the route guard", async () => {
    await expect(
      getEndOfDayRecap(
        tenantContext(tenant.tenantId),
        { userId: userIdSchema.parse(cashier.userId) },
        outletIdSchema.parse(tenant.outletId),
        today,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Q9 a supervisor (shift.cash.approve_close + view_all, no pos.day.close) can read the recap but not close the day", async () => {
    const read = await day(supervisor).get();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(parseRecap(read.body).status).toBe("open");

    const close = await day(supervisor).close();
    expect(close.status, JSON.stringify(close.body)).toBe(403);
    expect(await dailyCloseRows()).toHaveLength(0);
    expect(await dayClosedEvents()).toHaveLength(0);
  });

  it("Q9 the service refuses to close the day for a supervisor and still lets the supervisor read it", async () => {
    const caller = { userId: userIdSchema.parse(supervisor.userId) };
    await expect(
      closePosDay(
        tenantContext(tenant.tenantId),
        caller,
        outletIdSchema.parse(tenant.outletId),
        {
          businessDate: today,
          inventoryDeduction: false,
          idempotencyKey: randomUUID(),
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await dailyCloseRows()).toHaveLength(0);
    await expect(
      getEndOfDayRecap(
        tenantContext(tenant.tenantId),
        caller,
        outletIdSchema.parse(tenant.outletId),
        today,
      ),
    ).resolves.toMatchObject({ businessDate: today });
  });

  it("Q9 the outlet manager (pos.day.close) reads the recap and is not refused on close", async () => {
    const read = await day(manager).get();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(parseRecap(read.body).businessDate).toBe(today);
    // The manager passes the permission gate. Here the open cashier shift
    // still blocks the close (409, nothing stored); the 200 close by the
    // manager is asserted in "POS-05 closing the day" below.
    const close = await day(manager).close();
    expect(close.status, JSON.stringify(close.body)).not.toBe(403);
    expect(close.status).not.toBe(401);
    expect(await dailyCloseRows()).toHaveLength(0);
  });

  it("an anonymous caller gets 401", async () => {
    const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day`;
    const read = await agent(app)
      .get(`${base}?businessDate=${today}`)
      .set(headers)
      .set(originHeader);
    expect(read.status).toBe(401);
    const close = await agent(app)
      .post(`${base}/close`)
      .set(headers)
      .set(originHeader)
      .send({
        businessDate: today,
        inventoryDeduction: false,
        idempotencyKey: randomUUID(),
      });
    expect(close.status).toBe(401);
  });
});

// ---- Close refusals, one blocker at a time ------------------------------------------

describe("POS-05 the day cannot be closed while something is unfinished (legend-6c0)", () => {
  it("an open cashier shift blocks the close with 409 and stores nothing", async () => {
    const refused = await day().close();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(
      "Masih ada shift kasir yang terbuka.",
    );
    expect(await dailyCloseRows()).toHaveLength(0);
    expect(await dayClosedEvents()).toHaveLength(0);
  });

  it("POS-03 closing the cashier shift with a supervisor approval turns the terminal closed and carries its variance into the recap", async () => {
    const counted = await shiftApi().count(shiftId, [
      { denominationIdr: 100_000, quantity: 5 },
    ]);
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
    const countId = counted.body.data.id as string;
    const closed = await shiftApi().close(shiftId, {
      countId,
      varianceNote: "Selisih hitung kas pada uji tutup hari",
      ...(await pinApproval({
        action: "cash_shift_close",
        objectType: "pos_shift_count",
        objectId: countId,
        // Ignored for a shift close: the server stores |variance| of the count.
        valueIdr: 0,
      })),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const shift = closed.body.data as {
      status: string;
      varianceIdr: number;
      countedIdr: number;
    };
    expect(shift.status).toBe("closed");
    expect(shift.countedIdr).toBe(500_000);
    // legend-4wrfd: the cashier's close is blind; the variance is stored.
    expect(shift.varianceIdr).toBeNull();
    const { rows } = await owner.query<{ variance: number }>(
      "SELECT variance_idr::float8 AS variance FROM pos_shifts WHERE id = $1",
      [closed.body.data.id],
    );
    shift.varianceIdr = rows[0]!.variance;
    expect(closed.body.data.countId).toBe(countId);
    // The drawer cannot balance by accident, so there is a variance to carry.
    expect(shift.varianceIdr).not.toBe(0);

    const recap = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    const device = recap.devices.find((row) => row.deviceId === ids.device);
    expect(device).toMatchObject({
      shiftCount: 1,
      closed: true,
      cashVarianceIdr: shift.varianceIdr,
    });
    expect(recap.totalVarianceIdr).toBe(shift.varianceIdr);
  });

  it("an order that is not completed or voided blocks the close with 409; once it is voided the day is clear", async () => {
    const draft = await pos().create();
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const draftId = draft.body.data.id as string;
    const draftStatus = draft.body.data.status as string;
    expect(["completed", "voided"]).not.toContain(draftStatus);

    const refused = await day().close();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(
      "Masih ada pesanan yang belum selesai.",
    );
    expect(await dailyCloseRows()).toHaveLength(0);

    const voided = await pos().voidOrder(draftId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal sebelum bayar",
      expectedStatus: draftStatus,
      ...(await pinApproval({
        action: "void",
        objectType: "order",
        objectId: draftId,
        valueIdr: draft.body.data.totalIdr as number,
      })),
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe("voided");
  });

  it("POS-06 a device with a missing receipt number blocks the close with RECEIPT_SEQUENCE_GAP", async () => {
    setPosOutletReceiptGapsPort(async () => [
      { prefix: "P1", deviceId: randomUUID(), missing: [3] },
    ]);
    try {
      const refused = await day().close();
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
    } finally {
      setPosOutletReceiptGapsPort(null);
    }
    expect(await dailyCloseRows()).toHaveLength(0);
  });

  it("asking for the end-of-day stock deduction while it is unavailable fails closed with 503 and the day stays open", async () => {
    const refused = await day().close({ inventoryDeduction: true });
    expect(refused.status, JSON.stringify(refused.body)).toBe(503);
    expect(await dailyCloseRows()).toHaveLength(0);
    expect(await dayClosedEvents()).toHaveLength(0);
    const recap = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    expect(recap.status).toBe("open");
    expect(recap.inventoryDeductionApplied).toBe(false);
  });
});

// ---- Close -----------------------------------------------------------------------

describe("POS-05 closing the day (legend-6c0)", () => {
  const key = randomUUID();
  let closedRecap: EndOfDayRecap;

  it("POS-05 closing stores the recap and emits day.closed with the same totals as the recap", async () => {
    const before = parseRecap(
      await day()
        .get()
        .then((r) => r.body),
    );
    const response = await day().close({ idempotencyKey: key });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    closedRecap = parseRecap(response.body);

    expect(closedRecap).toMatchObject({
      businessDate: today,
      status: "closed",
      closedBy: manager.userId,
      inventoryDeductionApplied: false,
      accountingSync: { status: "pending", journalCount: 0, postedAt: null },
      totalSalesIdr: before.totalSalesIdr,
      totalRefundsIdr: before.totalRefundsIdr,
      totalVoidsIdr: before.totalVoidsIdr,
      totalVarianceIdr: before.totalVarianceIdr,
    });
    expect(closedRecap.closedAt).not.toBeNull();
    expect(closedRecap.tenders).toEqual(before.tenders);
    expect(closedRecap.channels).toEqual(before.channels);
    expect(closedRecap.devices).toEqual(before.devices);

    const rows = await dailyCloseRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    const orderCount = sum(closedRecap.devices.map((d) => d.orderCount));
    expect(orderCount).toBe(5);
    expect(row).toMatchObject({
      order_count: orderCount,
      inventory_deduction_applied: false,
      closed_by: manager.userId,
    });
    expect(Number(row.total_sales_idr)).toBe(closedRecap.totalSalesIdr);
    expect(Number(row.total_refunds_idr)).toBe(closedRecap.totalRefundsIdr);
    expect(Number(row.total_voids_idr)).toBe(closedRecap.totalVoidsIdr);
    expect(Number(row.total_variance_idr)).toBe(closedRecap.totalVarianceIdr);
    expect(parseRecap({ data: row.recap })).toEqual(closedRecap);

    const events = await dayClosedEvents();
    expect(events).toHaveLength(1);
    expect(dayClosedPayloadSchema.parse(events[0]!.payload)).toMatchObject({
      outletId: tenant.outletId,
      businessDate: today,
      orderCount,
      totalSalesIdr: closedRecap.totalSalesIdr,
      totalRefundsIdr: closedRecap.totalRefundsIdr,
      totalVoidsIdr: closedRecap.totalVoidsIdr,
      totalVarianceIdr: closedRecap.totalVarianceIdr,
      inventoryDeductionApplied: false,
      accountingSyncStatus: "pending",
      closedBy: manager.userId,
    });
  });

  it("POS-05 once closed, reading the day returns the stored recap", async () => {
    const response = await day().get();
    expect(response.status).toBe(200);
    expect(parseRecap(response.body)).toEqual(closedRecap);
  });

  it("a retry with the same idempotency key returns the same recap and does not close twice", async () => {
    const replay = await day().close({ idempotencyKey: key });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(parseRecap(replay.body)).toEqual(closedRecap);
    expect(await dailyCloseRows()).toHaveLength(1);
    expect(await dayClosedEvents()).toHaveLength(1);
  });

  it("a second close with a new key is refused with 409 BUSINESS_DAY_ALREADY_CLOSED", async () => {
    const again = await day().close();
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(errorCode(again.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");
    expect(await dailyCloseRows()).toHaveLength(1);
    expect(await dayClosedEvents()).toHaveLength(1);
  });

  it("a shift cannot be opened on a closed business day (409 BUSINESS_DAY_ALREADY_CLOSED)", async () => {
    const opened = await shiftApi().open();
    expect(opened.status, JSON.stringify(opened.body)).toBe(409);
    expect(errorCode(opened.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");
  });

  it("POS-05 a closed day's record cannot be changed or deleted, even by the database owner", async () => {
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE pos_daily_closes SET total_sales_idr = 1 WHERE tenant_id = $1",
          [tenant.tenantId],
        ),
      ),
    ).rejects.toThrow(/POS-05/);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query("DELETE FROM pos_daily_closes WHERE tenant_id = $1", [
          tenant.tenantId,
        ]),
      ),
    ).rejects.toThrow(/POS-05/);
    const rows = await dailyCloseRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.total_sales_idr)).toBe(closedRecap.totalSalesIdr);
  });
});

// ---- Device cash variance with a held cash refund (legend-ifnb) ----------------------
//
// A cash refund over the drawer is recorded like any other but held
// (`needs_approval`): it stays out of the expected drawer figure and is summed
// into the count's `heldCashOutIdr`. The shift closes with book variance
// `differenceIdr` = counted - expected + held (the drawer figure with the held
// cash paid out). The end-of-day recap must carry that same book variance, not
// the raw counted - expected, so an honest count shows no variance on the day.
//
// Assumptions: the stored day close `total_variance_idr`, the `day.closed`
// payload `totalVarianceIdr` and the device row `cashVarianceIdr` are all the
// book variance; the shift's own `cashier_shift.closed` payload carries
// `differenceIdr` and `heldCashOutIdr` as numbers or numeric strings.

describe("POS-05 the day's device cash variance counts a held cash refund as paid out (legend-ifnb)", () => {
  const LEFT_IDR = 1_000;

  /**
   * A fresh outlet (own device, price list and supervisor PIN) with one cash
   * sale, the drawer cashed out down to LEFT_IDR and a cash refund over the
   * drawer, which is held. The drawer then takes the refunded cash back in, so
   * the expected figure (without the held cash) is LEFT_IDR + held and the
   * refunded cash is the part a count can show as paid out.
   */
  async function heldRefundOutlet() {
    const outletId = randomUUID();
    const deviceId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $3, $4, address, timezone, opening_hours, status
       FROM outlets WHERE tenant_id = $2 AND id = $5`,
      [
        outletId,
        tenant.tenantId,
        `V-${suffix}`.toUpperCase(),
        `Outlet Selisih ${suffix}`,
        tenant.outletId,
      ],
    );
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const listId = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [listId, tenant.tenantId, outletId],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, listId, ids.kopi, KOPI_IDR],
      );
    });
    await setStaffPin(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      supervisor.userId,
      { outletId, userId: supervisor.userId },
      { pin: PIN },
    );
    extraDevices.set(deviceId, outletId);
    await registerTestDevice(owner, {
      tenantId: tenant.tenantId,
      outletId,
      deviceId,
    });
    const till: Till = { outletId, deviceId };

    const opened = await shiftApi(cashier, till).open();
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const outletShiftId = opened.body.data.id as string;

    const ring = pos(cashier, true, till);
    const created = await ring.create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    let status = created.body.data.status as string;
    if (status === "draft") {
      const submitted = await ring.submit(orderId, status);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }
    const totalIdr = created.body.data.totalIdr as number;
    const paid = await ring.cash(orderId, status, totalIdr + 5_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const completed = await ring.complete(
      orderId,
      paid.body.data.order.status as string,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const caller = {
      userId: userIdSchema.parse(cashier.userId),
      deviceId,
    };
    const movement = (
      type: "cash_out" | "cash_in",
      amountIdr: number,
      reasonNote: string,
    ) =>
      recordCashMovement(
        tenantContext(tenant.tenantId),
        caller,
        outletIdSchema.parse(outletId),
        outletShiftId,
        {
          type,
          amountIdr: idr(amountIdr),
          reasonNote,
          idempotencyKey: randomUUID(),
        } as Parameters<typeof recordCashMovement>[4],
      );
    // Cash out all but LEFT_IDR, so a refund of KOPI_IDR is over the drawer.
    await movement(
      "cash_out",
      OPENING_FLOAT_IDR + totalIdr - LEFT_IDR,
      "Belanja es batu",
    );
    const refund = await ring.refund(orderId, {
      reason: "quality_complaint",
      reasonNote: "Minuman tumpah",
      amountIdr: KOPI_IDR,
      ...(await pinApproval({
        outletId,
        action: "refund",
        objectType: "order",
        objectId: orderId,
        valueIdr: KOPI_IDR,
      })),
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const held = await owner.query<{ needs_approval: boolean }>(
      `SELECT needs_approval FROM pos_order_refunds
        WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(held.rows).toHaveLength(1);
    expect(held.rows[0]!.needs_approval).toBe(true);
    await movement("cash_in", KOPI_IDR, "Tambah uang kembalian");

    const date = await owner.query<{ business_date: string }>(
      `SELECT business_date::text AS business_date FROM orders
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return {
      till,
      shiftId: outletShiftId,
      businessDate: date.rows[0]!.business_date,
    };
  }

  /** Counts `countedIdr` in 1.000 notes and closes the shift with a supervisor PIN. */
  async function closeShift(
    outlet: Awaited<ReturnType<typeof heldRefundOutlet>>,
    countedIdr: number,
    varianceNote?: string,
  ) {
    const api = shiftApi(cashier, outlet.till);
    const counted = await api.count(outlet.shiftId, [
      { denominationIdr: 1_000, quantity: countedIdr / 1_000 },
    ]);
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
    const countId = counted.body.data.id as string;
    const closed = await api.close(outlet.shiftId, {
      countId,
      ...(varianceNote ? { varianceNote } : {}),
      ...(await pinApproval({
        outletId: outlet.till.outletId,
        action: "cash_shift_close",
        objectType: "pos_shift_count",
        objectId: countId,
        // Ignored for a shift close: the server stores |variance| of the count.
        valueIdr: 0,
      })),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.status).toBe("closed");
    return closed;
  }

  /** The recap read and the day close, plus what the close stored and emitted. */
  async function recapAndClose(
    outlet: Awaited<ReturnType<typeof heldRefundOutlet>>,
  ) {
    const { outletId } = outlet.till;
    const read = await day(manager, outletId).get(outlet.businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const closed = await day(manager, outletId).close({
      businessDate: outlet.businessDate,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const stored = await owner.query<{ total_variance_idr: string }>(
      `SELECT total_variance_idr FROM pos_daily_closes
        WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
      [tenant.tenantId, outletId, outlet.businessDate],
    );
    const events = await owner.query<{ payload: unknown }>(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'day.closed'
          AND event->'payload'->>'outletId' = $2
          AND event->'payload'->>'businessDate' = $3`,
      [tenant.tenantId, outletId, outlet.businessDate],
    );
    return {
      open: parseRecap(read.body),
      closed: parseRecap(closed.body),
      stored,
      events,
    };
  }

  const deviceRow = (recap: EndOfDayRecap, till: Till) =>
    recap.devices.find((row) => row.deviceId === till.deviceId);

  it("an honest count after a held cash refund (the refunded cash really left the drawer) shows no variance on the device, the recap, the stored day close or day.closed", async () => {
    const outlet = await heldRefundOutlet();
    // Expected without the held cash is LEFT + refund; the drawer holds LEFT.
    await closeShift(outlet, LEFT_IDR);

    const result = await recapAndClose(outlet);
    for (const recap of [result.open, result.closed]) {
      expect(deviceRow(recap, outlet.till)).toMatchObject({
        shiftCount: 1,
        closed: true,
        cashVarianceIdr: 0,
      });
      expect(recap.totalVarianceIdr).toBe(0);
    }
    expect(result.stored.rows).toHaveLength(1);
    expect(Number(result.stored.rows[0]!.total_variance_idr)).toBe(0);
    expect(result.events.rows).toHaveLength(1);
    expect(
      dayClosedPayloadSchema.parse(result.events.rows[0]!.payload),
    ).toMatchObject({
      outletId: outlet.till.outletId,
      businessDate: outlet.businessDate,
      totalVarianceIdr: 0,
    });
  }, 120_000);

  it("a count equal to the expected figure after a held cash refund (the cash was not paid out) shows the refund as a positive variance on the device, the recap, the stored day close and day.closed", async () => {
    const outlet = await heldRefundOutlet();
    // Counted = expected without the held cash: LEFT + refund is still there.
    await closeShift(
      outlet,
      LEFT_IDR + KOPI_IDR,
      "Selisih kas dicek ulang bersama supervisor",
    );

    const result = await recapAndClose(outlet);
    for (const recap of [result.open, result.closed]) {
      expect(deviceRow(recap, outlet.till)).toMatchObject({
        shiftCount: 1,
        closed: true,
        cashVarianceIdr: KOPI_IDR,
      });
      expect(recap.totalVarianceIdr).toBe(KOPI_IDR);
    }
    expect(Number(result.stored.rows[0]!.total_variance_idr)).toBe(KOPI_IDR);
    expect(result.events.rows).toHaveLength(1);
    expect(
      dayClosedPayloadSchema.parse(result.events.rows[0]!.payload),
    ).toMatchObject({
      outletId: outlet.till.outletId,
      totalVarianceIdr: KOPI_IDR,
    });
  }, 120_000);
});

// ---- Tenant isolation --------------------------------------------------------------

describe("TEN-01 end-of-day isolation (legend-6c0)", () => {
  it("TEN-01 a manager of another tenant can neither read nor close this outlet's day through the API", async () => {
    const outlet = tenant.outletId;
    const read = await day(otherManager, outlet).get();
    expect(read.status, JSON.stringify(read.body)).toBeGreaterThanOrEqual(400);
    expect(read.status).toBeLessThan(500);
    expect(JSON.stringify(read.body)).not.toContain(String(sales.a.orderId));

    // Even with this tenant's host the other tenant's account holds no role here.
    const spoofRead = await otherManager.client
      .get(
        `/api/outlets/${encodeURIComponent(outlet)}/pos/day?businessDate=${today}`,
      )
      .set(headers)
      .set(originHeader);
    expect(spoofRead.status).toBe(403);
    const spoofClose = await otherManager.client
      .post(`/api/outlets/${encodeURIComponent(outlet)}/pos/day/close`)
      .set(headers)
      .set(originHeader)
      .send({
        businessDate: EMPTY_DAY,
        inventoryDeduction: false,
        idempotencyKey: randomUUID(),
      });
    expect(spoofClose.status).toBe(403);
    expect(await dailyCloseRows(EMPTY_DAY)).toHaveLength(0);
  });

  it("TEN-01 the service refuses a context of another tenant for this outlet", async () => {
    await expect(
      getEndOfDayRecap(
        tenantContext(other.tenantId),
        { userId: userIdSchema.parse(otherManager.userId) },
        outletIdSchema.parse(tenant.outletId),
        today,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
  });

  it("TEN-01 the other tenant's own day is empty: no sales of this tenant leak into it", async () => {
    const response = await otherManager.client
      .get(
        `/api/outlets/${encodeURIComponent(other.outletId)}/pos/day?businessDate=${today}`,
      )
      .set({ Host: other.hostname })
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const recap = parseRecap(response.body);
    expect(recap).toMatchObject({
      status: "open",
      totalSalesIdr: 0,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
    });
    expect(sum(recap.devices.map((device) => device.orderCount))).toBe(0);
  });

  it("TEN-01 under RLS another tenant sees no shifts, cash movements or day closes of this tenant", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [other.tenantId],
      );
      for (const table of [
        "pos_daily_closes",
        "pos_shifts",
        "pos_shift_counts",
        "cash_movements",
        "cash_movement_refusals",
      ]) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
          [tenant.tenantId],
        );
        expect(rows[0]?.count, table).toBe("0");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("TEN-03 under RLS a context scoped to another outlet sees no day close of this outlet", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
        [tenant.tenantId, JSON.stringify([randomUUID()])],
      );
      const { rows } = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pos_daily_closes",
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

// ---- Migration 0090 backfill (was 0070, regenerated on milestone/m1) -----------------

describe("POS-05 migration 0090 grants pos.day.close to existing template roles (legend-6c0)", () => {
  const migrationSql = readFileSync(
    new URL("../../drizzle/0090_pos_day_close_permission.sql", import.meta.url),
    "utf8",
  );
  const templateRoleId = randomUUID();
  const customRoleId = randomUUID();
  const oldTemplatePermissions = ["order.view", "shift.cash.operate"];
  const customPermissions = ["floor.table.view", "order.view"];

  async function permissionsOf(roleId: string): Promise<string[]> {
    return asOwnerTenant(tenant.tenantId, async (client) => {
      const { rows } = await client.query<{ permissions: string[] }>(
        "SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2",
        [roleId, tenant.tenantId],
      );
      return rows[0]!.permissions;
    });
  }

  /**
   * Runs the migration file as the DB owner on a connection with NO
   * app.tenant_id set (as a migration runner has). Returns the role facts.
   * Role: the pool's login role from STARTER_TEST_DATABASE_URL; its
   * rolsuper/rolbypassrls flags are returned so the report can name them.
   */
  async function runMigrationAsOwner() {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      const tenantBefore = await client.query<{ value: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS value",
      );
      expect(tenantBefore.rows[0]?.value ?? "").toBe("");
      const role = await client.query<{
        name: string;
        super: boolean;
        bypass: boolean;
      }>(
        `SELECT current_user AS name, rolsuper AS super, rolbypassrls AS bypass
         FROM pg_roles WHERE rolname = current_user`,
      );
      await client.query(migrationSql);
      await client.query("COMMIT");
      return role.rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("POS-05 a pre-existing outlet_manager template role gains pos.day.close exactly once, re-running changes nothing, a custom role is untouched", async () => {
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         VALUES ($1, $2, 'Outlet Manager', true, 'outlet_manager', $3, false, '["tenant"]'),
                ($4, $2, 'Custom Tanpa Tutup Hari', false, NULL, $5, false, '["tenant"]')`,
        [
          templateRoleId,
          tenant.tenantId,
          JSON.stringify(oldTemplatePermissions),
          customRoleId,
          JSON.stringify(customPermissions),
        ],
      );
    });
    expect(await permissionsOf(templateRoleId)).not.toContain("pos.day.close");

    const role = await runMigrationAsOwner();
    console.info(
      `[0090] migration role: ${role.name} rolsuper=${role.super} rolbypassrls=${role.bypass}`,
    );
    const afterFirst = await permissionsOf(templateRoleId);
    expect(afterFirst.filter((code) => code === "pos.day.close")).toHaveLength(
      1,
    );
    expect(afterFirst).toEqual(expect.arrayContaining(oldTemplatePermissions));
    expect(await permissionsOf(customRoleId)).toEqual(customPermissions);

    await runMigrationAsOwner();
    expect(await permissionsOf(templateRoleId)).toEqual(afterFirst);
    expect(await permissionsOf(customRoleId)).toEqual(customPermissions);
  });
});

describe("legend-vet9d DP buckets in the day recap (liability, never a tender)", () => {
  const at = (businessDate: string, time = "12:00:00") =>
    `${businessDate}T${time}Z`;

  /** A completed POS sale funded partly or wholly by DP; cash is the only tender. */
  async function seedDpSale(
    client: PoolClient,
    input: {
      businessDate: string;
      totalIdr: number;
      depositIdr: number;
      cashIdr?: number;
      outletId?: string;
      deviceId?: string;
      shiftId?: string;
    },
  ) {
    const orderId = randomUUID();
    const outletId = input.outletId ?? tenant.outletId;
    await client.query(
      `INSERT INTO orders
        (id,tenant_id,outlet_id,number,channel,service_type,payment_mode,
         subtotal_idr,discount_idr,service_charge_idr,tax_idr,rounding_idr,total_idr,
         prices_include_tax,status,business_date,placed_at,deposit_applied_idr)
       VALUES ($1,$2,$3,$4,'pos','takeaway','pay_first',$5,0,0,0,0,$5,
         false,'completed',$6,$7,$8)`,
      [
        orderId,
        tenant.tenantId,
        outletId,
        `DP-DAY-${orderId.slice(0, 20)}`,
        input.totalIdr,
        input.businessDate,
        at(input.businessDate),
        input.depositIdr,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders
        (order_id,tenant_id,outlet_id,channel,cashier_id,submitted_at,completed_at,
         device_id,shift_id)
       VALUES ($1,$2,$3,'pos',$4,$5,$6,$7,$8)`,
      [
        orderId,
        tenant.tenantId,
        outletId,
        cashier.userId,
        at(input.businessDate),
        at(input.businessDate, "12:00:01"),
        input.deviceId ?? null,
        input.shiftId ?? null,
      ],
    );
    if ((input.cashIdr ?? 0) > 0)
      await client.query(
        `INSERT INTO pos_order_tenders
          (tenant_id,outlet_id,order_id,method,provider,amount_idr,received_idr,
           change_idr,status,requested_at,resolved_at,captured_by,shift_id)
         VALUES ($1,$2,$3,'cash','manual',$4,$4,0,'captured',$5,$5,$6,$7)`,
        [
          tenant.tenantId,
          outletId,
          orderId,
          input.cashIdr,
          at(input.businessDate),
          cashier.userId,
          input.shiftId ?? null,
        ],
      );
    return orderId;
  }

  const depositRefund = (
    client: PoolClient,
    orderId: string,
    refundedAt: string,
    tenderIdr: number,
    depositIdr: number,
  ) =>
    seedEconomicDepositRefund(client, {
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      orderId,
      tenderIdr,
      depositIdr,
      requestedBy: cashier.userId,
      approvedBy: supervisor.userId,
      refundedAt,
    });

  const readRecap = async (businessDate: string) => {
    const response = await day(manager).get(businessDate);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return parseRecap(response.body);
  };
  const cashRow = (recap: EndOfDayRecap) =>
    recap.tenders.find((row) => row.method === "cash")!;

  it("Q81-ECON-DAY-01: a DP return today for an earlier sale closes the day with the refund in today's DP bucket", async () => {
    const saleDay = "2025-03-10";
    const refundDay = "2025-03-11";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate: saleDay,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
      await depositRefund(client, orderId, at(refundDay), 0, 25_000);
    });

    // DP applied stays on the sale's own day; nothing is netted across days.
    const sale = await readRecap(saleDay);
    expect(sale).toMatchObject({
      totalSalesIdr: 25_000,
      totalDepositAppliedIdr: 25_000,
      totalDepositRefundedIdr: 0,
      totalRefundsIdr: 0,
    });
    expect(cashRow(sale)).toMatchObject({ capturedIdr: 0, netIdr: 0 });

    const open = await readRecap(refundDay);
    expect(open).toMatchObject({
      totalSalesIdr: 0,
      totalDepositAppliedIdr: 0,
      totalDepositRefundedIdr: 25_000,
      totalRefundsIdr: 0,
    });
    expect(open.devices[0]).toMatchObject({
      refundCount: 1,
      refundAmountIdr: 0,
      depositRefundedIdr: 25_000,
    });
    expect(cashRow(open).netIdr).toBe(0);

    const closed = await day(manager).close({ businessDate: refundDay });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const stored = await dailyCloseRows(refundDay);
    expect(stored).toHaveLength(1);
    expect(parseRecap({ data: stored[0]!.recap })).toMatchObject({
      status: "closed",
      totalDepositRefundedIdr: 25_000,
    });
  });

  it("a DP refund today for today's sale, on top of a cash part, lands in both buckets and the cash row only nets the cash part", async () => {
    const businessDate = "2025-03-12";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 40_000,
        depositIdr: 10_000,
        cashIdr: 30_000,
      });
      await depositRefund(
        client,
        orderId,
        at(businessDate, "13:00:00"),
        5_000,
        10_000,
      );
    });
    const recap = await readRecap(businessDate);
    expect(recap).toMatchObject({
      totalSalesIdr: 40_000,
      totalDepositAppliedIdr: 10_000,
      totalDepositRefundedIdr: 10_000,
      totalRefundsIdr: 5_000,
    });
    expect(recap.devices[0]).toMatchObject({
      refundCount: 1,
      refundAmountIdr: 5_000,
      depositAppliedIdr: 10_000,
      depositRefundedIdr: 10_000,
    });
    expect(cashRow(recap)).toMatchObject({
      capturedIdr: 30_000,
      refundedIdr: 5_000,
      netIdr: 25_000,
    });
  });

  it("a mixed DP and cash sale: the cash net is exactly the cash captured, DP is not a tender", async () => {
    const businessDate = "2025-03-13";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await seedDpSale(client, {
        businessDate,
        totalIdr: 50_000,
        depositIdr: 20_000,
        cashIdr: 30_000,
      });
    });
    const recap = await readRecap(businessDate);
    expect(recap.totalSalesIdr).toBe(50_000);
    expect(recap.totalDepositAppliedIdr).toBe(20_000);
    expect(recap.devices[0]!.depositAppliedIdr).toBe(20_000);
    expect(cashRow(recap)).toMatchObject({
      capturedIdr: 30_000,
      netIdr: 30_000,
    });
    expect(recap.tenders.map((row) => row.method)).toEqual(["cash"]);
  });

  it("a DP-only sale with no tender balances and the day closes", async () => {
    const businessDate = "2025-03-14";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
    });
    const recap = await readRecap(businessDate);
    expect(recap).toMatchObject({
      totalSalesIdr: 25_000,
      totalDepositAppliedIdr: 25_000,
    });
    expect(cashRow(recap)).toMatchObject({ capturedIdr: 0, netIdr: 0 });
    const closed = await day(manager).close({ businessDate });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("a WS-05 payment_refunds mirror row of the same DP return is not counted a second time", async () => {
    const businessDate = "2025-03-15";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
      const { intentId } = await depositRefund(
        client,
        orderId,
        at(businessDate, "13:00:00"),
        0,
        25_000,
      );
      await client.query(
        `INSERT INTO payment_refunds
           (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
            requested_by, approved_by, decided_at, completed_at, unallocated_fund_id)
         VALUES ($1, $2, $3, $4, 25000, 'Pengembalian dana', 'completed',
                 'requester', 'approver', $5, $5, NULL)`,
        [
          randomUUID(),
          tenant.tenantId,
          tenant.outletId,
          intentId,
          at(businessDate, "13:00:00"),
        ],
      );
    });
    const recap = await readRecap(businessDate);
    expect(recap.totalDepositRefundedIdr).toBe(25_000);
    expect(recap.totalRefundsIdr).toBe(0);
    expect(recap.devices[0]!.refundCount).toBe(1);
  });

  it("a void of an order that took DP is refused with 409 and nothing is stored", async () => {
    const businessDate = "2025-03-16";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 10_000,
        cashIdr: 15_000,
      });
      await client.query(
        `INSERT INTO pos_order_voids
          (tenant_id,outlet_id,order_id,receipt_number,amount_idr,reason,reason_note,
           requested_by,approved_by,approval_request_id,voided_at)
         VALUES ($1,$2,$3,'POS1-000999',15000,'customer_cancelled','Void DP',$4,$5,$6,$7)`,
        [
          tenant.tenantId,
          tenant.outletId,
          orderId,
          cashier.userId,
          supervisor.userId,
          randomUUID(),
          at(businessDate, "13:00:00"),
        ],
      );
    });
    // The void (Rp15.000) equals the cash taken, so only the DP guard can fire.
    const read = await day(manager).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(409);
    expect(read.body.error.code).toBe("CONFLICT");
    expect(read.body.error.message).toContain(
      "void pada pesanan yang memakai DP",
    );
    const closed = await day(manager).close({ businessDate });
    expect(closed.status, JSON.stringify(closed.body)).toBe(409);
    expect(closed.body.error.message).toContain(
      "void pada pesanan yang memakai DP",
    );
    expect(await dailyCloseRows(businessDate)).toHaveLength(0);
  });

  it("deposit refunds above the DP the order took are refused with 409 (never pay out more than was paid)", async () => {
    const businessDate = "2025-03-17";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 10_000,
        cashIdr: 15_000,
      });
      await depositRefund(
        client,
        orderId,
        at(businessDate, "13:00:00"),
        0,
        10_000,
      );
      await depositRefund(
        client,
        orderId,
        at(businessDate, "14:00:00"),
        0,
        10_000,
      );
    });
    const read = await day(manager).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(409);
    expect(read.body.error.code).toBe("CONFLICT");
    expect(read.body.error.message).toContain("melebihi DP pesanan asal");
    const closed = await day(manager).close({ businessDate });
    expect(closed.status, JSON.stringify(closed.body)).toBe(409);
    expect(closed.body.error.message).toContain("melebihi DP pesanan asal");
    expect(await dailyCloseRows(businessDate)).toHaveLength(0);
  });

  it("deposit refunds spread over two days above the DP: day 2 is refused with 409, day 1 still reads", async () => {
    const dayOne = "2025-03-20";
    const dayTwo = "2025-03-21";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate: dayOne,
        totalIdr: 25_000,
        depositIdr: 10_000,
        cashIdr: 15_000,
      });
      await depositRefund(client, orderId, at(dayOne, "13:00:00"), 0, 10_000);
      await depositRefund(client, orderId, at(dayTwo, "13:00:00"), 0, 10_000);
    });
    const first = await readRecap(dayOne);
    expect(first.totalDepositRefundedIdr).toBe(10_000);
    const second = await day(manager).get(dayTwo);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.message).toContain("melebihi DP pesanan asal");
  });

  it("a deposit refund on an order that took no DP is refused with 409", async () => {
    const businessDate = "2025-03-18";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 0,
        cashIdr: 25_000,
      });
      await depositRefund(
        client,
        orderId,
        at(businessDate, "13:00:00"),
        0,
        5_000,
      );
    });
    const read = await day(manager).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(409);
    expect(read.body.error.code).toBe("CONFLICT");
    expect(read.body.error.message).toContain(
      "refund DP pada pesanan tanpa DP",
    );
  });

  /**
   * A refund (Rp0 tender, goods return) and a hand-made deposit row for it, so a
   * row that disagrees with its refund can be seeded. A valid release is made
   * first on another day, only to borrow a real payment intent.
   */
  async function rawDepositRefund(
    client: PoolClient,
    input: {
      refundOrderId: string;
      depositOrderId?: string;
      depositOutletId?: string;
      refundedAt: string;
      releasedAt: string;
    },
  ) {
    const borrowedOrder = await seedDpSale(client, {
      businessDate: "2025-03-01",
      totalIdr: 25_000,
      depositIdr: 25_000,
    });
    const { intentId } = await depositRefund(
      client,
      borrowedOrder,
      at("2025-03-01", "13:00:00"),
      0,
      25_000,
    );
    const refundId = randomUUID();
    await client.query(
      `INSERT INTO pos_order_refunds
        (id,tenant_id,outlet_id,order_id,amount_idr,reason,reason_note,lines,
         requested_by,approved_by,approval_request_id,refunded_at,items)
       VALUES ($1,$2,$3,$4,0,'customer_cancelled','Retur DP','[]'::jsonb,$5,$6,$7,$8,$9::jsonb)`,
      [
        refundId,
        tenant.tenantId,
        tenant.outletId,
        input.refundOrderId,
        cashier.userId,
        supervisor.userId,
        randomUUID(),
        input.refundedAt,
        JSON.stringify([{ itemId: randomUUID(), quantity: 1 }]),
      ],
    );
    await client.query(
      `INSERT INTO pos_deposit_refunds
        (tenant_id,outlet_id,order_id,pos_refund_id,payment_intent_id,amount_idr,released_at)
       VALUES ($1,$2,$3,$4,$5,25000,$6)`,
      [
        tenant.tenantId,
        input.depositOutletId ?? tenant.outletId,
        input.depositOrderId ?? input.refundOrderId,
        refundId,
        intentId,
        input.releasedAt,
      ],
    );
  }

  it("a deposit release dated outside the business day of its refund is refused with 409", async () => {
    const businessDate = "2025-03-19";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
      await rawDepositRefund(client, {
        refundOrderId: orderId,
        refundedAt: at(businessDate, "13:00:00"),
        releasedAt: at("2025-03-25"),
      });
    });
    const read = await day(manager).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(409);
    expect(read.body.error.code).toBe("CONFLICT");
    expect(read.body.error.message).toContain(
      "tanggal pelepasan DP di luar hari kerja refund",
    );
  });

  it("a deposit row on another outlet than its refund is refused with 409", async () => {
    const businessDate = "2025-03-22";
    const otherOutletId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $3, $4, address, timezone, opening_hours, status
       FROM outlets WHERE tenant_id = $2 AND id = $5`,
      [
        otherOutletId,
        tenant.tenantId,
        `M-${suffix}`.toUpperCase(),
        `Outlet Lain ${suffix}`,
        tenant.outletId,
      ],
    );
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const orderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
      await rawDepositRefund(client, {
        refundOrderId: orderId,
        depositOutletId: otherOutletId,
        refundedAt: at(businessDate, "13:00:00"),
        releasedAt: at(businessDate, "13:00:00"),
      });
    });
    const read = await day(manager).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(409);
    expect(read.body.error.code).toBe("CONFLICT");
    expect(read.body.error.message).toContain(
      "outlet refund DP tidak sama dengan outlet refund",
    );
  });

  it("a deposit row for another order than its refund is refused with 409", async () => {
    const businessDate = "2025-03-23";
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const refundOrderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
      const depositOrderId = await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
      });
      await rawDepositRefund(client, {
        refundOrderId,
        depositOrderId,
        refundedAt: at(businessDate, "13:00:00"),
        releasedAt: at(businessDate, "13:00:00"),
      });
    });
    const read = await day(manager).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(409);
    expect(read.body.error.code).toBe("CONFLICT");
    expect(read.body.error.message).toContain(
      "order refund DP tidak sama dengan order refund",
    );
  });

  it("the shift close difference stays 0 on a day that took DP: expected cash ignores DP", async () => {
    const outletId = randomUUID();
    const deviceId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $3, $4, address, timezone, opening_hours, status
       FROM outlets WHERE tenant_id = $2 AND id = $5`,
      [
        outletId,
        tenant.tenantId,
        `D-${suffix}`.toUpperCase(),
        `Outlet DP ${suffix}`,
        tenant.outletId,
      ],
    );
    await setStaffPin(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      supervisor.userId,
      { outletId, userId: supervisor.userId },
      { pin: PIN },
    );
    extraDevices.set(deviceId, outletId);
    await registerTestDevice(owner, {
      tenantId: tenant.tenantId,
      outletId,
      deviceId,
    });
    const till: Till = { outletId, deviceId };
    const opened = await shiftApi(cashier, till).open();
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const outletShiftId = opened.body.data.id as string;
    const businessDate = opened.body.data.businessDate as string;

    await asOwnerTenant(tenant.tenantId, async (client) => {
      await seedDpSale(client, {
        businessDate,
        totalIdr: 25_000,
        depositIdr: 25_000,
        outletId,
        deviceId,
        shiftId: outletShiftId,
      });
    });

    const api = shiftApi(cashier, till);
    const counted = await api.count(outletShiftId, [
      { denominationIdr: 1_000, quantity: OPENING_FLOAT_IDR / 1_000 },
    ]);
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
    const countId = counted.body.data.id as string;
    const closed = await api.close(outletShiftId, {
      countId,
      ...(await pinApproval({
        outletId,
        action: "cash_shift_close",
        objectType: "pos_shift_count",
        objectId: countId,
        valueIdr: 0,
      })),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const { rows } = await owner.query<{ difference: number }>(
      "SELECT difference_idr::float8 AS difference FROM pos_shifts WHERE id = $1",
      [outletShiftId],
    );
    expect(rows[0]!.difference).toBe(0);

    const read = await day(manager, outletId).get(businessDate);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const recap = parseRecap(read.body);
    expect(recap.totalVarianceIdr).toBe(0);
    expect(recap.totalDepositAppliedIdr).toBe(25_000);
    expect(
      recap.devices.find((row) => row.deviceId === deviceId),
    ).toMatchObject({ cashVarianceIdr: 0, depositAppliedIdr: 25_000 });
  }, 120_000);
});
