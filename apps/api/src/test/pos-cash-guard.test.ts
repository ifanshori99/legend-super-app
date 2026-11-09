// Closed business day and open cash drawer guards (bead legend-6c0, round 2
// findings 1, 2 and 5; PRD v1.7 POS-03 blind count, POS-05 "Total penjualan
// harian di POS, akuntansi, dan dashboard identik").
//
// - Finding 1: an order of day D cannot be created, submitted, paid or
//   completed once D is closed, and a refund/void cannot land on a closed day.
//   Order writes take the day lock (shared) that the close takes exclusively,
//   so a write racing the close either lands in the frozen recap or is refused.
// - Finding 2: cash tenders, refunds and voids need the caller's open shift
//   and wait for a closing shift, so cash is never accepted and missing from
//   the closed shift's figures.
// - Finding 5: a shift opened before the 04:00 cutoff and still open (its
//   business date is yesterday) blocks closing today.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in one isolated
// tenant. Every scenario that closes a day or races a close uses its own
// outlet, so the scenarios do not share a business day.

import { randomUUID } from "node:crypto";
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
import type { EndOfDayRecap, PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import { addPosTender } from "../services/pos-order-payment.ts";
import {
  setPosEdcTenderPort,
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setPosReceiptGapsPort } from "../services/pos-shift-ports.ts";
import {
  closePosShift,
  openPosShift,
  recordCashMovement,
  submitPosShiftCount,
} from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const OPENING_FLOAT_IDR = 100_000;
const RACE_ROUNDS = 5;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  managerRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let otherCashier: Member;
let supervisor: Member;
let manager: Member;
/** The outlet business date of the run (all outlets share zone and cutoff). */
let today = "";
let yesterday = "";
/** device id -> outlet id, for the shift-open device check. */
const devices = new Map<string, string>();

// ---- Doubles --------------------------------------------------------------------

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
        deviceId: input.deviceId ?? randomUUID(),
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

// ---- Fixtures -------------------------------------------------------------------

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

async function memberOf(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A fresh outlet of the tenant with the Kopi takeaway price and one device. */
async function addOutlet(): Promise<{ outletId: string; deviceId: string }> {
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
      `G-${suffix}`.toUpperCase(),
      `Outlet Guard ${suffix}`,
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
  // The supervisor PIN is per outlet.
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
  devices.set(deviceId, outletId);
  return { outletId, deviceId };
}

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

/** A signed X-Device-Token for `deviceId` in the run's tenant. */
const deviceToken = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

/** The outlet's first registered device (addOutlet registers one). */
function deviceOf(outletId: string): string | null {
  for (const [deviceId, outlet] of devices)
    if (outlet === outletId) return deviceId;
  return null;
}

/**
 * The POS order API as `who` on a till. The till is the outlet's device
 * unless `deviceId` says otherwise; null sends no device token.
 */
function pos(
  outletId: string,
  who: Member = cashier,
  deviceId: string | null = deviceOf(outletId),
) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) => {
    const request = who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader);
    if (deviceId !== null)
      request.set(DEVICE_TOKEN_HEADER, deviceToken(deviceId));
    return request.send({ idempotencyKey: randomUUID(), ...body });
  };
  return {
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    edc: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/tenders`, {
        method: "edc_card",
        reference: `EDC-${randomUUID().slice(0, 8)}`,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    void: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

function closeDay(outletId: string, businessDate: string = today) {
  return manager.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/day/close`)
    .set(headers)
    .set(originHeader)
    .send({
      businessDate,
      inventoryDeduction: false,
      idempotencyKey: randomUUID(),
    });
}

type Order = { orderId: string; status: string; totalIdr: number };

/** A created (draft) order. */
async function draftOrder(outletId: string): Promise<Order> {
  const created = await pos(outletId).create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    orderId: created.body.data.id as string,
    status: created.body.data.status as string,
    totalIdr: created.body.data.totalIdr as number,
  };
}

/** A created and submitted order, ready to take a tender. */
async function submittedOrder(outletId: string): Promise<Order> {
  const order = await draftOrder(outletId);
  if (order.status !== "draft") return order;
  const submitted = await pos(outletId).submit(order.orderId, order.status);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  return { ...order, status: submitted.body.data.status as string };
}

/** submitted -> paid in full (cash or EDC) -> completed. */
async function completedSale(
  outletId: string,
  method: "cash" | "edc",
): Promise<Order> {
  const order = await submittedOrder(outletId);
  const paid =
    method === "cash"
      ? await pos(outletId).cash(
          order.orderId,
          order.status,
          order.totalIdr + 5_000,
        )
      : await pos(outletId).edc(order.orderId, order.status);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos(outletId).complete(
    order.orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return { ...order, status: completed.body.data.status as string };
}

async function openShift(
  outlet: { outletId: string; deviceId: string },
  who: Member = cashier,
): Promise<string> {
  const shift = await openPosShift(
    scopedContext(),
    { userId: userIdSchema.parse(who.userId), deviceId: outlet.deviceId },
    outletIdSchema.parse(outlet.outletId),
    { openingFloatIdr: idr(OPENING_FLOAT_IDR), idempotencyKey: randomUUID() },
  );
  return shift.id;
}

/** A supervisor PIN override for a void/refund, as the POS does it. */
async function pinApproval(input: {
  outletId: string;
  action: "void" | "refund";
  orderId: string;
  valueIdr: number;
  requester?: Member;
}) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    (input.requester ?? cashier).userId,
    {
      outletId: input.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: "Persetujuan uji guard kas",
      objectType: "order",
      objectId: input.orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

/** An approved shift-close override row for a zero-variance count (objectType pos_shift_count). */
async function shiftCloseApproval(
  outletId: string,
  countId: string,
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               'Hitung kas akhir shift', 0, 'pos_shift_count', $6, $7,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        id,
        tenant.tenantId,
        outletId,
        cashier.userId,
        supervisor.userId,
        countId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    ),
  );
  return { approvedBy: supervisor.userId, approvalRequestId: id };
}

/** Marks `businessDate` closed for the outlet on an open owner transaction. */
function insertDayCloseOn(
  client: PoolClient,
  outletId: string,
  businessDate: string,
) {
  return client.query(
    `INSERT INTO pos_daily_closes
       (tenant_id, outlet_id, business_date, order_count, total_sales_idr,
        total_refunds_idr, total_voids_idr, total_variance_idr,
        inventory_deduction_applied, recap, closed_by, closed_at,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, '{}', $4, now(), $5, $6)`,
    [
      tenant.tenantId,
      outletId,
      businessDate,
      manager.userId,
      randomUUID(),
      "0".repeat(64),
    ],
  );
}

/** Marks `businessDate` closed for the outlet as the database owner. */
async function insertDayClose(outletId: string, businessDate: string) {
  await asOwnerTenant(tenant.tenantId, (client) =>
    insertDayCloseOn(client, outletId, businessDate),
  );
}

/** Void rows on record for the outlet (unpaid-order voids and corrections). */
async function voidRowCount(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pos_order_voids
     WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function storedRecap(outletId: string): Promise<EndOfDayRecap | null> {
  const { rows } = await owner.query<{ recap: EndOfDayRecap }>(
    `SELECT recap FROM pos_daily_closes
     WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
    [tenant.tenantId, outletId, today],
  );
  return rows[0]?.recap ?? null;
}

/** Waits until `min` backends wait on the day lock (shared mode). */
async function waitForDayLockWaiters(min: number): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query LIKE '%pg_advisory_xact_lock_shared%'`,
    );
    if (Number(rows[0]?.count ?? 0) >= min) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No ${min} request(s) waited on the business-day lock`);
}

/**
 * Waits (polling pg_locks, at most 3 s) until a backend waits, not granted, on
 * the advisory lock of the outlet's business day of `today`.
 */
async function waitForDayLockWaiterInPgLocks(outletId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND classid::bigint = ((hashtext($1)::bigint >> 32) & 4294967295)
         AND objid::bigint = (hashtext($1)::bigint & 4294967295)`,
      [`pos-day:${tenant.tenantId}:${outletId}:${today}`],
    );
    if (Number(rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("No request waited on the business-day advisory lock");
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPosEdcTenderPort(async (_tx, _context, input) => ({
    reference: input.reference ?? "EDC-TEST",
    approvedBy: null,
  }));
  tenant = await createIsolatedTenant(`guard-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId ? (devices.get(deviceId) ?? null) : null,
  );

  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "Kasir Guard",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "Supervisor Guard",
      [
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "shift.cash.approve_close",
        "shift.cash.view_all",
      ],
    ],
    [ids.managerRole, "Manajer Guard", ["pos.day.close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await memberOf(ids.cashierRole, "Kasir Guard");
  otherCashier = await memberOf(ids.cashierRole, "Kasir Guard Dua");
  supervisor = await memberOf(ids.supervisorRole, "Supervisor Guard");
  manager = await memberOf(ids.managerRole, "Manajer Guard");
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
       VALUES ($1, $2, $3, 'Guard Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
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
       VALUES ($1, $2, NULL, 'PBJT-GRD', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });

  // The run's business date, as the order service stamps it.
  const probe = await addOutlet();
  const order = await draftOrder(probe.outletId);
  const { rows } = await owner.query<{ today: string; yesterday: string }>(
    `SELECT business_date::text AS today,
            (business_date - 1)::text AS yesterday
     FROM orders WHERE tenant_id = $1 AND outlet_id = $2 LIMIT 1`,
    [tenant.tenantId, probe.outletId],
  );
  today = rows[0]?.today ?? "";
  yesterday = rows[0]?.yesterday ?? "";
  expect(today, order.orderId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setPosReceiptGapsPort(null);
  setPosEdcTenderPort(null);
  setDeviceOutletResolver(null);
  // Final orders and audit rows are immutable; the isolated tenant stays in
  // the disposable database with a valid creator for the tenant list.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Finding 1: a closed day takes no more order writes -------------------------

describe("POS-05 a closed business day refuses order writes (legend-6c0 finding 1)", () => {
  it("create, submit, tender and complete on a closed day are refused with 409 BUSINESS_DAY_ALREADY_CLOSED", async () => {
    const outlet = await addOutlet();
    await openShift(outlet);
    const draft = await draftOrder(outlet.outletId);
    expect(draft.status).toBe("draft");
    const unpaid = await submittedOrder(outlet.outletId);
    const paid = await submittedOrder(outlet.outletId);
    const tendered = await pos(outlet.outletId).cash(
      paid.orderId,
      paid.status,
      paid.totalIdr,
    );
    expect(tendered.status, JSON.stringify(tendered.body)).toBe(201);
    const paidStatus = tendered.body.data.order.status as string;

    await insertDayClose(outlet.outletId, today);

    const created = await pos(outlet.outletId).create();
    expect(created.status, JSON.stringify(created.body)).toBe(409);
    expect(errorCode(created.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    const submitted = await pos(outlet.outletId).submit(
      draft.orderId,
      draft.status,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(409);
    expect(errorCode(submitted.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    const cash = await pos(outlet.outletId).cash(
      unpaid.orderId,
      unpaid.status,
      unpaid.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);
    expect(errorCode(cash.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    const completed = await pos(outlet.outletId).complete(
      paid.orderId,
      paidStatus,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(409);
    expect(errorCode(completed.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pos_order_tenders
       WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outlet.outletId],
    );
    expect(rows[0]?.count).toBe(1);
  }, 60_000);

  it("a refund dated on a closed day is refused; the same sale refunded on the next (open) day goes through", async () => {
    const outlet = await addOutlet();
    const sale = await completedSale(outlet.outletId, "edc");
    await insertDayClose(outlet.outletId, today);

    const refused = await pos(outlet.outletId).refund(sale.orderId, {
      reason: "quality_complaint",
      reasonNote: "Minuman tumpah",
      amountIdr: KOPI_IDR,
      ...(await pinApproval({
        outletId: outlet.outletId,
        action: "refund",
        orderId: sale.orderId,
        valueIdr: KOPI_IDR,
      })),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    // The refund counts in the recap of the day it is made: tomorrow is open,
    // so yesterday's closed sale can still be refunded.
    const tomorrow = new Date(Date.now() + 26 * 60 * 60_000);
    // The PIN approval is given when the refund is made (tomorrow): a PIN
    // override only counts for a few minutes after it is approved.
    const approval = await pinApproval({
      outletId: outlet.outletId,
      action: "refund",
      orderId: sale.orderId,
      valueIdr: KOPI_IDR,
    });
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE pos_overrides SET created_at = $3, resolved_at = $3
         WHERE tenant_id = $1 AND id = $2`,
        [
          tenant.tenantId,
          ulidToUuid(approval.overrideId),
          new Date(tomorrow.getTime() - 5_000),
        ],
      ),
    );
    const refund = await refundPosOrder(
      scopedContext(),
      {
        userId: userIdSchema.parse(cashier.userId),
        deviceId: null,
        expectedVersion: null,
      },
      outletIdSchema.parse(outlet.outletId),
      sale.orderId,
      {
        reason: "quality_complaint",
        reasonNote: "Minuman tumpah",
        amountIdr: KOPI_IDR,
        idempotencyKey: randomUUID(),
        ...approval,
      } as Parameters<typeof refundPosOrder>[4],
      tomorrow,
    );
    expect(refund.amountIdr).toBe(KOPI_IDR);
  }, 60_000);

  it("an order write waits for a closing day: it blocks on the day lock and succeeds once the lock holder commits without closing", async () => {
    const outlet = await addOutlet();
    const draft = await draftOrder(outlet.outletId);
    const holder = await owner.connect();
    let settled = 0;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `pos-day:${tenant.tenantId}:${outlet.outletId}:${today}`,
      ]);
      const create = pos(outlet.outletId)
        .create()
        .then((response) => {
          settled += 1;
          return response;
        });
      const submit = pos(outlet.outletId)
        .submit(draft.orderId, draft.status)
        .then((response) => {
          settled += 1;
          return response;
        });
      try {
        await waitForDayLockWaiters(2);
        expect(settled).toBe(0);
      } finally {
        await holder.query("COMMIT");
      }
      const [created, submitted] = await Promise.all([create, submit]);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    } finally {
      holder.release();
    }
  }, 60_000);

  it("a refund racing the day close either lands in the stored recap or is refused; the stored recap always matches the refunds on record", async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const outlet = await addOutlet();
      const sale = await completedSale(outlet.outletId, "edc");
      const approval = await pinApproval({
        outletId: outlet.outletId,
        action: "refund",
        orderId: sale.orderId,
        valueIdr: KOPI_IDR,
      });
      const [refund, close] = await Promise.all([
        pos(outlet.outletId).refund(sale.orderId, {
          reason: "quality_complaint",
          reasonNote: "Minuman tumpah",
          amountIdr: KOPI_IDR,
          ...approval,
        }),
        closeDay(outlet.outletId),
      ]);
      expect(close.status, JSON.stringify(close.body)).toBeLessThan(300);
      if (refund.status >= 300)
        expect(errorCode(refund.body), JSON.stringify(refund.body)).toBe(
          "BUSINESS_DAY_ALREADY_CLOSED",
        );

      const { rows } = await owner.query<{ total: number }>(
        `SELECT coalesce(sum(amount_idr), 0)::int AS total FROM pos_order_refunds
         WHERE tenant_id = $1 AND outlet_id = $2`,
        [tenant.tenantId, outlet.outletId],
      );
      const recap = await storedRecap(outlet.outletId);
      expect(recap, `round ${round}`).not.toBeNull();
      expect(Number(recap?.totalRefundsIdr), `round ${round}`).toBe(
        rows[0]?.total,
      );
      expect(rows[0]?.total).toBe(refund.status < 300 ? KOPI_IDR : 0);
    }
  }, 180_000);
});

// ---- legend-mf0.1: voids on a closed day and the tender vs close race ----------

describe("POS-05 closed business day: voids and the close race (legend-mf0.1)", () => {
  it("voiding an unpaid submitted order after the day is closed is refused with 409 BUSINESS_DAY_ALREADY_CLOSED; recap and void rows stay as they were", async () => {
    const outlet = await addOutlet();
    const unpaid = await submittedOrder(outlet.outletId);
    // An unfinished order blocks the real close, so the day is marked closed
    // directly (the recap row is '{}': it must stay exactly that).
    await insertDayClose(outlet.outletId, today);
    const recapBefore = await storedRecap(outlet.outletId);
    const voidsBefore = await voidRowCount(outlet.outletId);

    // Assumption: an unpaid-order void takes the same supervisor PIN approval
    // fields as the correction void (approvedBy + overrideId).
    const refused = await pos(outlet.outletId).void(unpaid.orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal pesan",
      expectedStatus: unpaid.status,
      ...(await pinApproval({
        outletId: outlet.outletId,
        action: "void",
        orderId: unpaid.orderId,
        valueIdr: unpaid.totalIdr,
      })),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    expect(await storedRecap(outlet.outletId)).toEqual(recapBefore);
    expect(await voidRowCount(outlet.outletId)).toBe(voidsBefore);
    const { rows } = await owner.query<{ status: string }>(
      `SELECT status FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, ulidToUuid(unpaid.orderId)],
    );
    expect(rows[0]?.status).toBe(unpaid.status);
  }, 60_000);

  it("a correction void of a completed sale after the real day close is refused with 409 BUSINESS_DAY_ALREADY_CLOSED; the stored recap and void rows stay as they were", async () => {
    const outlet = await addOutlet();
    const sale = await completedSale(outlet.outletId, "edc");
    const close = await closeDay(outlet.outletId);
    expect(close.status, JSON.stringify(close.body)).toBeLessThan(300);
    const recapBefore = await storedRecap(outlet.outletId);
    expect(recapBefore).not.toBeNull();
    const voidsBefore = await voidRowCount(outlet.outletId);

    const refused = await pos(outlet.outletId).correctionVoid(sale.orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      ...(await pinApproval({
        outletId: outlet.outletId,
        action: "void",
        orderId: sale.orderId,
        valueIdr: sale.totalIdr,
      })),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");

    expect(await storedRecap(outlet.outletId)).toEqual(recapBefore);
    expect(await voidRowCount(outlet.outletId)).toBe(voidsBefore);
  }, 60_000);

  it("a tender racing Tutup Hari waits on the day lock, then is refused with 409 BUSINESS_DAY_ALREADY_CLOSED once the close commits; no tender is captured", async () => {
    const outlet = await addOutlet();
    const order = await submittedOrder(outlet.outletId);
    const holder = await owner.connect();
    let settled = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      // The close holds the day lock exclusively while it writes its row.
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `pos-day:${tenant.tenantId}:${outlet.outletId}:${today}`,
      ]);
      const tender = pos(outlet.outletId)
        .edc(order.orderId, order.status)
        .then((response) => {
          settled = true;
          return response;
        });
      try {
        await waitForDayLockWaiterInPgLocks(outlet.outletId);
        expect(settled).toBe(false);
        await insertDayCloseOn(holder, outlet.outletId, today);
      } finally {
        await holder.query("COMMIT");
      }
      const response = await tender;
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(errorCode(response.body)).toBe("BUSINESS_DAY_ALREADY_CLOSED");
    } finally {
      holder.release();
    }

    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pos_order_tenders
       WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outlet.outletId],
    );
    expect(rows[0]?.count).toBe(0);
  }, 60_000);
});

// ---- Finding 5: a shift across the cutoff blocks today's close ------------------

describe("POS-05 a shift still open from before the cutoff blocks the day close (legend-6c0 finding 5)", () => {
  it("an open shift dated yesterday blocks closing today with 409 and stores nothing", async () => {
    const outlet = await addOutlet();
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_shifts
           (tenant_id, outlet_id, device_id, cashier_id, business_date, status,
            opened_at, opening_float_idr, open_key, open_fingerprint)
         VALUES ($1, $2, $3, $4, $5, 'open', now() - interval '20 hours', $6, $7, $8)`,
        [
          tenant.tenantId,
          outlet.outletId,
          outlet.deviceId,
          cashier.userId,
          yesterday,
          OPENING_FLOAT_IDR,
          randomUUID(),
          "0".repeat(64),
        ],
      ),
    );
    const close = await closeDay(outlet.outletId);
    expect(close.status, JSON.stringify(close.body)).toBe(409);
    expect(await storedRecap(outlet.outletId)).toBeNull();
  }, 60_000);
});

// ---- Finding 2: cash needs an open drawer ---------------------------------------

describe("POS-03 cash needs the cashier's open shift (legend-6c0 finding 2)", () => {
  it("a cash tender, cash refund or cash void by a cashier without an open shift is refused with 409 SHIFT_NOT_OPEN", async () => {
    const outlet = await addOutlet();
    await openShift(outlet);
    const sale = await completedSale(outlet.outletId, "cash");

    const unpaid = await submittedOrder(outlet.outletId);
    const tender = await pos(outlet.outletId, otherCashier).cash(
      unpaid.orderId,
      unpaid.status,
      unpaid.totalIdr,
    );
    expect(tender.status, JSON.stringify(tender.body)).toBe(409);
    expect(errorCode(tender.body)).toBe("SHIFT_NOT_OPEN");

    const refund = await pos(outlet.outletId, otherCashier).refund(
      sale.orderId,
      {
        reason: "quality_complaint",
        reasonNote: "Minuman tumpah",
        amountIdr: KOPI_IDR,
        ...(await pinApproval({
          outletId: outlet.outletId,
          action: "refund",
          orderId: sale.orderId,
          valueIdr: KOPI_IDR,
          requester: otherCashier,
        })),
      },
    );
    expect(refund.status, JSON.stringify(refund.body)).toBe(409);
    expect(errorCode(refund.body)).toBe("SHIFT_NOT_OPEN");

    const voided = await pos(outlet.outletId, otherCashier).correctionVoid(
      sale.orderId,
      {
        reason: "customer_cancelled",
        reasonNote: "Pelanggan salah pesan",
        ...(await pinApproval({
          outletId: outlet.outletId,
          action: "void",
          orderId: sale.orderId,
          valueIdr: sale.totalIdr,
          requester: otherCashier,
        })),
      },
    );
    expect(voided.status, JSON.stringify(voided.body)).toBe(409);
    expect(errorCode(voided.body)).toBe("SHIFT_NOT_OPEN");

    const { rows } = await owner.query<{
      tenders: number;
      corrections: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM pos_order_tenders
          WHERE tenant_id = $1 AND order_id = $2::uuid) AS tenders,
         (SELECT count(*)::int FROM pos_order_refunds WHERE tenant_id = $1 AND outlet_id = $3)
         + (SELECT count(*)::int FROM pos_order_voids WHERE tenant_id = $1 AND outlet_id = $3)
           AS corrections`,
      [tenant.tenantId, ulidToUuid(unpaid.orderId), outlet.outletId],
    );
    expect(rows[0]).toEqual({ tenders: 0, corrections: 0 });
  }, 60_000);

  it("a cash tender racing the shift close is either refused or counted in the closed shift's cash sales, never accepted and missing", async () => {
    for (let round = 0; round < RACE_ROUNDS; round++) {
      const outlet = await addOutlet();
      const shiftId = await openShift(outlet);
      const order = await submittedOrder(outlet.outletId);
      const caller = {
        userId: userIdSchema.parse(cashier.userId),
        deviceId: outlet.deviceId,
      };
      const outletId = outletIdSchema.parse(outlet.outletId);
      // Blind count of the drawer as it stands: the opening float only.
      const count = await submitPosShiftCount(
        scopedContext(),
        caller,
        outletId,
        shiftId,
        {
          counts: [{ denominationIdr: OPENING_FLOAT_IDR, quantity: 1 }],
          idempotencyKey: randomUUID(),
        },
      );
      const approval = await shiftCloseApproval(outlet.outletId, count.id);
      const [tender, close] = await Promise.all([
        pos(outlet.outletId).cash(order.orderId, order.status, order.totalIdr),
        closePosShift(scopedContext(), caller, outletId, shiftId, {
          countId: count.id,
          approvedBy: userIdSchema.parse(approval.approvedBy),
          approvalRequestId: approval.approvalRequestId,
          idempotencyKey: randomUUID(),
        } as Parameters<typeof closePosShift>[4]).then(
          (shift) => ({ ok: true as const, shift }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ]);
      const { rows } = await owner.query<{
        status: string;
        cash_sales_idr: number;
      }>(
        `SELECT status, cash_sales_idr::int AS cash_sales_idr FROM pos_shifts
         WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, shiftId],
      );
      const shift = rows[0];
      const label = `round ${round}: tender ${tender.status} ${JSON.stringify(tender.body)}, close ${close.ok ? "ok" : String(close.error)}`;
      if (tender.status < 300) {
        // Accepted cash must be in the drawer the shift reports.
        if (shift?.status === "closed")
          expect(shift.cash_sales_idr, label).toBe(order.totalIdr);
      } else {
        expect(tender.status, label).toBe(409);
        expect(errorCode(tender.body), label).toBe("SHIFT_NOT_OPEN");
        expect(shift?.status, label).toBe("closed");
      }
      // A close refused only because the drawer moved after the count.
      if (!close.ok)
        expect((close.error as { code?: string }).code, label).toBe(
          "SHIFT_COUNT_STALE",
        );
    }
  }, 180_000);

  it("cash recorded under a time before the open shift's openedAt is refused with SHIFT_NOT_OPEN (S1 closed and S2 opened while the request waited); at or after openedAt it goes through", async () => {
    const outlet = await addOutlet();
    const shiftId = await openShift(outlet);
    const sale = await completedSale(outlet.outletId, "cash");
    const unpaid = await submittedOrder(outlet.outletId);
    const {
      rows: [opened],
    } = await owner.query<{ opened_at: Date }>(
      `SELECT opened_at FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, shiftId],
    );
    // The request took its timestamp before the shift it now lands in opened.
    const beforeOpen = new Date(opened!.opened_at.getTime() - 60_000);
    const caller = {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: outlet.deviceId,
      expectedVersion: null,
    };
    const outletId = outletIdSchema.parse(outlet.outletId);
    const expectShiftNotOpen = async (run: Promise<unknown>) =>
      expect(
        await run.then(
          () => null,
          (error: unknown) => error,
        ),
      ).toMatchObject({ code: "SHIFT_NOT_OPEN" });

    await expectShiftNotOpen(
      addPosTender(
        scopedContext(),
        caller,
        outletId,
        unpaid.orderId,
        {
          method: "cash",
          receivedIdr: unpaid.totalIdr,
          expectedStatus: unpaid.status,
          idempotencyKey: randomUUID(),
        } as Parameters<typeof addPosTender>[4],
        beforeOpen,
      ),
    );
    await expectShiftNotOpen(
      refundPosOrder(
        scopedContext(),
        caller,
        outletId,
        sale.orderId,
        {
          reason: "quality_complaint",
          reasonNote: "Minuman tumpah",
          amountIdr: KOPI_IDR,
          idempotencyKey: randomUUID(),
          ...(await pinApproval({
            outletId: outlet.outletId,
            action: "refund",
            orderId: sale.orderId,
            valueIdr: KOPI_IDR,
          })),
        } as Parameters<typeof refundPosOrder>[4],
        beforeOpen,
      ),
    );
    await expectShiftNotOpen(
      voidPosOrderCorrection(
        scopedContext(),
        caller,
        outletId,
        sale.orderId,
        {
          reason: "customer_cancelled",
          reasonNote: "Pelanggan salah pesan",
          idempotencyKey: randomUUID(),
          ...(await pinApproval({
            outletId: outlet.outletId,
            action: "void",
            orderId: sale.orderId,
            valueIdr: sale.totalIdr,
          })),
        } as Parameters<typeof voidPosOrderCorrection>[4],
        beforeOpen,
      ),
    );

    const count = async (table: string, orderId: string) =>
      (
        await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND order_id = $2::uuid`,
          [tenant.tenantId, ulidToUuid(orderId)],
        )
      ).rows[0]?.n;
    expect(await count("pos_order_tenders", unpaid.orderId)).toBe(0);
    expect(await count("pos_order_refunds", sale.orderId)).toBe(0);
    expect(await count("pos_order_voids", sale.orderId)).toBe(0);

    // At or after openedAt the same cash is accepted, recorded under that time.
    const at = new Date();
    const paid = await addPosTender(
      scopedContext(),
      caller,
      outletId,
      unpaid.orderId,
      {
        method: "cash",
        receivedIdr: unpaid.totalIdr,
        expectedStatus: unpaid.status,
        idempotencyKey: randomUUID(),
      } as Parameters<typeof addPosTender>[4],
      at,
    );
    expect(paid.order.id).toBe(unpaid.orderId);
    expect(await count("pos_order_tenders", unpaid.orderId)).toBe(1);
  }, 60_000);
});

describe("POS-03 cash goes into the drawer of the till it is taken on (legend-6c0 review K)", () => {
  it("a cash tender without a device token, or through another till of the outlet, is refused with 409 SHIFT_NOT_OPEN; the shift's own till takes it into that shift", async () => {
    const outlet = await addOutlet();
    const shiftId = await openShift(outlet);
    const otherTill = randomUUID();
    devices.set(otherTill, outlet.outletId);
    const unpaid = await submittedOrder(outlet.outletId);

    const noDevice = await pos(outlet.outletId, cashier, null).cash(
      unpaid.orderId,
      unpaid.status,
      unpaid.totalIdr,
    );
    expect(noDevice.status, JSON.stringify(noDevice.body)).toBe(409);
    expect(errorCode(noDevice.body)).toBe("SHIFT_NOT_OPEN");

    const viaOtherTill = await pos(outlet.outletId, cashier, otherTill).cash(
      unpaid.orderId,
      unpaid.status,
      unpaid.totalIdr,
    );
    expect(viaOtherTill.status, JSON.stringify(viaOtherTill.body)).toBe(409);
    expect(errorCode(viaOtherTill.body)).toBe("SHIFT_NOT_OPEN");

    const paid = await pos(outlet.outletId).cash(
      unpaid.orderId,
      unpaid.status,
      unpaid.totalIdr,
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const { rows } = await owner.query<{ shift_id: string | null }>(
      `SELECT shift_id FROM pos_order_tenders
       WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(unpaid.orderId)],
    );
    expect(rows).toEqual([{ shift_id: shiftId }]);
  }, 60_000);

  it("a cash refund or void larger than the drawer holds is refused with 409 without the expected amount, stores nothing, and the shift still counts and closes", async () => {
    const outlet = await addOutlet();
    const shiftId = await openShift(outlet);
    const sale = await completedSale(outlet.outletId, "cash");
    const caller = {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: outlet.deviceId,
    };
    const outletId = outletIdSchema.parse(outlet.outletId);
    // Leave 1.000 in the drawer: float + the sale, minus a cash out.
    const left = 1_000;
    await recordCashMovement(scopedContext(), caller, outletId, shiftId, {
      type: "cash_out",
      amountIdr: idr(OPENING_FLOAT_IDR + sale.totalIdr - left),
      reasonNote: "Belanja es batu",
      idempotencyKey: randomUUID(),
    } as Parameters<typeof recordCashMovement>[4]);

    const refund = await pos(outlet.outletId).refund(sale.orderId, {
      reason: "quality_complaint",
      reasonNote: "Minuman tumpah",
      amountIdr: KOPI_IDR,
      ...(await pinApproval({
        outletId: outlet.outletId,
        action: "refund",
        orderId: sale.orderId,
        valueIdr: KOPI_IDR,
      })),
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(409);
    expect(JSON.stringify(refund.body)).not.toContain(String(left));

    const voided = await pos(outlet.outletId).correctionVoid(sale.orderId, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan salah pesan",
      ...(await pinApproval({
        outletId: outlet.outletId,
        action: "void",
        orderId: sale.orderId,
        valueIdr: sale.totalIdr,
      })),
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(409);

    const { rows } = await owner.query<{ corrections: number }>(
      `SELECT (SELECT count(*)::int FROM pos_order_refunds WHERE tenant_id = $1 AND outlet_id = $2)
            + (SELECT count(*)::int FROM pos_order_voids WHERE tenant_id = $1 AND outlet_id = $2)
              AS corrections`,
      [tenant.tenantId, outlet.outletId],
    );
    expect(rows[0]).toEqual({ corrections: 0 });

    const count = await submitPosShiftCount(
      scopedContext(),
      caller,
      outletId,
      shiftId,
      {
        counts: [{ denominationIdr: left, quantity: 1 }],
        idempotencyKey: randomUUID(),
      } as Parameters<typeof submitPosShiftCount>[4],
    );
    const approval = await shiftCloseApproval(outlet.outletId, count.id);
    const closed = await closePosShift(
      scopedContext(),
      caller,
      outletId,
      shiftId,
      {
        countId: count.id,
        approvedBy: userIdSchema.parse(approval.approvedBy),
        approvalRequestId: approval.approvalRequestId,
        idempotencyKey: randomUUID(),
      } as Parameters<typeof closePosShift>[4],
    );
    expect(closed.status).toBe("closed");
  }, 60_000);
});
