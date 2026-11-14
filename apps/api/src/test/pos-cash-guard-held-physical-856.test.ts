// legend-t78la (bead 856, card A): the cash guard on a refund or void counts
// cash that is already held. A held cash refund/void already left the drawer
// (it is out of the stored expected figure but physically gone), so a later
// cash refund/void is held when amount > expected - held cash, not only when
// amount > expected. Same rule as a cash out (pos-shift-cash-approval.test.ts,
// round 2 F). Money rule: no cash out above what is physically in the drawer;
// when in doubt the payment is held (needs_approval = true), never paid.
//
// Assumptions: a partial cash refund of any amount up to the order's cash is
// accepted (201); a held correction answers 201 like any other (legend-utqr)
// and is stored needs_approval = true; a refund/void exactly equal to
// expected - held is NOT held (only amount > expected - held is); a held
// void's amount is the order's captured cash (the sale total).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in one isolated
// tenant; every scenario uses its own outlet and shift. Helpers are copied
// from pos-cash-guard.test.ts (they are not exported from a test file).

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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosEdcTenderPort,
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setPosReceiptGapsPort } from "../services/pos-shift-ports.ts";
import {
  openPosShift,
  recordCashMovement,
} from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const OPENING_FLOAT_IDR = 100_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
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
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId,
    deviceId,
  });
  return { outletId, deviceId };
}

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
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant"]')`,
      [
        id,
        tenant.tenantId,
        name,
        JSON.stringify(permissions),
        id === ids.supervisorRole ? "supervisor" : null,
      ],
    );
  cashier = await memberOf(ids.cashierRole, "Kasir Guard");
  supervisor = await memberOf(ids.supervisorRole, "Supervisor Guard");
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

// ---- Scenario helpers -----------------------------------------------------------

const callerOf = (outlet: { deviceId: string }) => ({
  userId: userIdSchema.parse(cashier.userId),
  deviceId: outlet.deviceId,
});

/** Cash left in the drawer before the first (held) correction. */
const START_IDR = 20_000;
/** The first held refund: more than START_IDR, so it is held at once. */
const FIRST_REFUND_IDR = 25_000;

type Drawer = {
  outletId: string;
  deviceId: string;
  shiftId: string;
  /** Three completed cash sales; [0] is the first held correction's order. */
  sales: [Order, Order, Order];
  /** Cash one sale puts in the drawer (its total; change is given back). */
  saleIdr: number;
};

/**
 * Fresh outlet and shift, three cash sales, then a cash out that leaves
 * exactly START_IDR expected in the drawer (that cash out fits, so it is paid).
 */
async function drawerAtStart(): Promise<Drawer> {
  const outlet = await addOutlet();
  const shiftId = await openShift(outlet);
  const sales = [
    await completedSale(outlet.outletId, "cash"),
    await completedSale(outlet.outletId, "cash"),
    await completedSale(outlet.outletId, "cash"),
  ] as Drawer["sales"];
  const saleIdr = sales[0].totalIdr;
  await recordCashMovement(
    scopedContext(),
    callerOf(outlet),
    outletIdSchema.parse(outlet.outletId),
    shiftId,
    {
      type: "cash_out",
      amountIdr: idr(OPENING_FLOAT_IDR + 3 * saleIdr - START_IDR),
      reasonNote: "Setor ke brankas",
      idempotencyKey: randomUUID(),
    } as Parameters<typeof recordCashMovement>[4],
  );
  return { ...outlet, shiftId, sales, saleIdr };
}

async function cashRefundOf(drawer: Drawer, sale: Order, amountIdr: number) {
  return pos(drawer.outletId).refund(sale.orderId, {
    reason: "quality_complaint",
    reasonNote: "Minuman tumpah",
    amountIdr,
    ...(await pinApproval({
      outletId: drawer.outletId,
      action: "refund",
      orderId: sale.orderId,
      valueIdr: amountIdr,
    })),
  });
}

async function cashVoidOf(drawer: Drawer, sale: Order) {
  return pos(drawer.outletId).correctionVoid(sale.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...(await pinApproval({
      outletId: drawer.outletId,
      action: "void",
      orderId: sale.orderId,
      valueIdr: sale.totalIdr,
    })),
  });
}

type Kind = "refund" | "void";
const correctionTable = {
  refund: "pos_order_refunds",
  void: "pos_order_voids",
} as const;

/** The single correction row of an order: held or paid out. */
async function heldOf(kind: Kind, order: Order): Promise<boolean> {
  const { rows } = await owner.query<{ needs_approval: boolean }>(
    `SELECT needs_approval FROM ${correctionTable[kind]}
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(order.orderId)],
  );
  expect(rows, `${kind} rows of ${order.orderId}`).toHaveLength(1);
  return rows[0]!.needs_approval;
}

async function movementHeld(
  shiftId: string,
  amountIdr: number,
): Promise<boolean> {
  const { rows } = await owner.query<{ needs_approval: boolean }>(
    `SELECT needs_approval FROM cash_movements
      WHERE tenant_id = $1 AND shift_id = $2 AND amount_idr::int = $3`,
    [tenant.tenantId, shiftId, amountIdr],
  );
  expect(rows, `cash movement of ${amountIdr}`).toHaveLength(1);
  return rows[0]!.needs_approval;
}

/** The first correction is held at once: it is more than the START_IDR in the drawer. */
async function holdFirst(drawer: Drawer, kind: Kind): Promise<number> {
  const first = drawer.sales[0];
  const response =
    kind === "refund"
      ? await cashRefundOf(drawer, first, FIRST_REFUND_IDR)
      : await cashVoidOf(drawer, first);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(await heldOf(kind, first), "the first correction is held").toBe(true);
  return kind === "refund" ? FIRST_REFUND_IDR : drawer.saleIdr;
}

/** A new cash sale: the drawer's expected grows by one sale. */
async function topUp(drawer: Drawer, sales: number): Promise<void> {
  for (let n = 0; n < sales; n++) await completedSale(drawer.outletId, "cash");
}

// ---- Tests ----------------------------------------------------------------------
//
// Numbers (S = one sale's total): after the setup the drawer expects 20.000.
// A held correction H leaves it out of expected but it is physically gone, so
// the usable cash is expected - H. Each top-up sale adds S to both.

describe("legend-t78la a cash refund/void is held when it exceeds expected minus the cash already held", () => {
  it("refund after a held refund: more than expected - held (46.000 > 70.000 - 25.000 = 45.000 with S = 50.000) is held although it fits expected", async () => {
    const drawer = await drawerAtStart();
    const held = await holdFirst(drawer, "refund");
    await topUp(drawer, 1);
    const usable = START_IDR + drawer.saleIdr - held;
    const amount = usable + 1;
    // Fits expected (START_IDR + S), does not fit expected - held.
    expect(amount).toBeLessThanOrEqual(START_IDR + drawer.saleIdr);
    expect(amount).toBeLessThanOrEqual(drawer.saleIdr);

    const second = drawer.sales[1];
    const response = await cashRefundOf(drawer, second, amount);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await heldOf("refund", second)).toBe(true);
  }, 120_000);

  it("refund after a held refund: exactly expected - held is paid, not held", async () => {
    const drawer = await drawerAtStart();
    const held = await holdFirst(drawer, "refund");
    await topUp(drawer, 1);
    const usable = START_IDR + drawer.saleIdr - held;

    const second = drawer.sales[1];
    const response = await cashRefundOf(drawer, second, usable);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await heldOf("refund", second)).toBe(false);
  }, 120_000);

  it("void after a held void: a sale that exceeds expected - held (S > 20.000) is held although it fits expected (S <= 20.000 + S)", async () => {
    const drawer = await drawerAtStart();
    await holdFirst(drawer, "void");
    await topUp(drawer, 1);
    // expected = 20.000 + S, held = S, so only 20.000 is usable: less than S.
    expect(drawer.saleIdr).toBeGreaterThan(START_IDR);

    const second = drawer.sales[1];
    const response = await cashVoidOf(drawer, second);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await heldOf("void", second)).toBe(true);
  }, 120_000);

  it("void after a held void: a sale that fits expected - held (20.000 + S - S + S) is paid, not held", async () => {
    const drawer = await drawerAtStart();
    await holdFirst(drawer, "void");
    await topUp(drawer, 2);
    // expected = 20.000 + 2S, held = S, usable = 20.000 + S >= S.

    const second = drawer.sales[1];
    const response = await cashVoidOf(drawer, second);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await heldOf("void", second)).toBe(false);
  }, 120_000);

  it("void after a held refund: a sale larger than expected - held refund (S > 20.000 + S - 25.000) is held", async () => {
    const drawer = await drawerAtStart();
    const held = await holdFirst(drawer, "refund");
    await topUp(drawer, 1);
    // usable = 20.000 + S - 25.000 = S - 5.000 < S <= expected.
    expect(START_IDR + drawer.saleIdr - held).toBeLessThan(drawer.saleIdr);

    const second = drawer.sales[1];
    const response = await cashVoidOf(drawer, second);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await heldOf("void", second)).toBe(true);
  }, 120_000);

  it("refund after a held void: more than expected - held void is held", async () => {
    const drawer = await drawerAtStart();
    const held = await holdFirst(drawer, "void");
    await topUp(drawer, 1);
    // usable = 20.000 + S - S = 20.000; a refund of 21.000 fits expected only.
    const amount = START_IDR + drawer.saleIdr - held + 1_000;
    expect(amount).toBeLessThanOrEqual(START_IDR + drawer.saleIdr);

    const second = drawer.sales[1];
    const response = await cashRefundOf(drawer, second, amount);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await heldOf("refund", second)).toBe(true);
  }, 120_000);

  it("no cash goes out above the physical drawer: after a paid refund uses up expected - held, any further refund and any cash out is held", async () => {
    const drawer = await drawerAtStart();
    const held = await holdFirst(drawer, "refund");
    await topUp(drawer, 1);
    const usable = START_IDR + drawer.saleIdr - held;

    const [, second, third] = drawer.sales;
    const paid = await cashRefundOf(drawer, second, usable);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(await heldOf("refund", second)).toBe(false);

    // Nothing usable is left (expected - held = 0), so even 1.000 is held.
    const more = await cashRefundOf(drawer, third, 1_000);
    expect(more.status, JSON.stringify(more.body)).toBe(201);
    expect(await heldOf("refund", third)).toBe(true);

    const cashOut = await recordCashMovement(
      scopedContext(),
      callerOf(drawer),
      outletIdSchema.parse(drawer.outletId),
      drawer.shiftId,
      {
        type: "cash_out",
        amountIdr: idr(1_000),
        reasonNote: "Beli plastik",
        idempotencyKey: randomUUID(),
      } as Parameters<typeof recordCashMovement>[4],
    );
    expect(cashOut).toBeTruthy();
    expect(await movementHeld(drawer.shiftId, 1_000)).toBe(true);
  }, 120_000);
});
