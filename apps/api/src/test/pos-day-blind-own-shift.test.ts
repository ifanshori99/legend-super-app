// legend-awg5p (tier K): the end-of-day recap is blind for the caller's own
// shift. Decision (CTO, 9 Nov): GET /api/outlets/:outletId/pos/day answers
//  - a caller WITH pos.day.close (outlet manager and up): the full recap,
//    unchanged, no `drawerFiguresHidden` key;
//  - a caller WITHOUT pos.day.close who ran ANY shift (open or closed) on that
//    business date at that outlet (e.g. a supervisor with shift.cash.view_all /
//    shift.cash.approve_close): the blind recap. Every device row the caller ran
//    a shift on has cashVarianceIdr and expiredCashOutIdr null, the outlet
//    totalVarianceIdr and totalExpiredCashOutIdr are null, every tender row has
//    capturedIdr / refundedIdr / netIdr null (method kept), and
//    drawerFiguresHidden is true. Sales, refund and void totals, channels and
//    counts stay. Same for the live (day open) and the frozen (day closed) recap;
//  - a caller WITHOUT pos.day.close and no shift that day: the full recap.
// Contract: endOfDayRecapViewSchema (union of the full and the blind recap).
// Acceptance: POS-03 "Tutup shift memakai blind count", POS-05 recap.
//
// Assumptions (the brief leaves them open):
//  - Each case runs in its own isolated tenant (one business day per tenant),
//    so one case never leaves a shift on the day another case reads.
//  - A supervisor who can also open a shift holds shift.cash.operate plus
//    shift.cash.view_all and shift.cash.approve_close; the PIN approval of a
//    shift close comes from a second member (approve_close only), written as an
//    approved pos_overrides row like pos-shift-blind-close.test.ts does.
//  - Sales are seeded straight into orders / pos_orders / pos_order_tenders on
//    the shift (cash, captured), as pos-shift-blind-close.test.ts does.
//  - The outlet manager role is pos.day.close plus shift.cash.operate (so the
//    manager can hold a shift too); the cashier is shift.cash.operate only.
//  - A nonzero close variance: float 100.000 + cash sale 55.000 = expected
//    155.000, counted 150.000, variance -5.000.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  endOfDayRecapSchema,
  endOfDayRecapViewSchema,
  POS_TENDER_METHODS,
  posShiftCountReceiptSchema,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const FLOAT_IDR = 100_000;
const SALE_IDR = 55_000;
const COUNTED_IDR = 150_000;
const VARIANCE_IDR = COUNTED_IDR - (FLOAT_IDR + SALE_IDR); // -5.000

let app: Express;
const registeredDevices = new Map<string, string>();

type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  deviceId: string;
};

type Scenario = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  supervisor: Member;
  approver: Member;
  cashier: Member;
  manager: Member;
};

// ---- Fixtures ------------------------------------------------------------------------

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

function tenantContextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function member(
  tenant: IsolatedTenant,
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
    [tenant.tenantId, userId, roleId],
  );
  const deviceId = randomUUID();
  registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  return { client, userId, deviceId };
}

async function newScenario(label: string): Promise<Scenario> {
  const tenant = await createIsolatedTenant(
    `day-blind-${label}-${randomUUID().slice(0, 6)}`,
  );
  const roles: [string, string, string[]][] = [
    [randomUUID(), "Kasir Hari Buta", ["shift.cash.operate"]],
    [
      randomUUID(),
      "Supervisor Kasir Hari Buta",
      [
        "shift.cash.operate",
        "shift.cash.view_all",
        "shift.cash.approve_close",
        "order.view",
      ],
    ],
    [
      randomUUID(),
      "Penyetuju Hari Buta",
      ["shift.cash.view_all", "shift.cash.approve_close"],
    ],
    [
      randomUUID(),
      "Manajer Hari Buta",
      ["pos.day.close", "shift.cash.operate"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  const cashier = await member(tenant, roles[0]![0], `Kasir ${label}`);
  const supervisor = await member(tenant, roles[1]![0], `Supervisor ${label}`);
  const approver = await member(tenant, roles[2]![0], `Penyetuju ${label}`);
  const manager = await member(tenant, roles[3]![0], `Manajer ${label}`);
  await setStaffPin(
    tenantContextOf(tenant.tenantId).tenant,
    approver.userId,
    { outletId: tenant.outletId, userId: approver.userId },
    { pin: PIN },
  );
  return {
    tenant,
    headers: { Host: tenant.hostname },
    supervisor,
    approver,
    cashier,
    manager,
  };
}

const deviceHeader = (s: Scenario, deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: s.tenant.tenantId,
    brandId: null,
    deviceId,
  });

const shiftsPath = (s: Scenario) =>
  `/api/outlets/${encodeURIComponent(s.tenant.outletId)}/pos/shifts`;
const dayPath = (s: Scenario) =>
  `/api/outlets/${encodeURIComponent(s.tenant.outletId)}/pos/day`;

type Shift = { id: string; businessDate: string };

async function openShift(s: Scenario, who: Member): Promise<Shift> {
  const response = await who.client
    .post(shiftsPath(s))
    .set(s.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(s, who.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as Shift;
}

/** A completed cash sale on the shift (cash lands in the shift's drawer). */
async function seedCashSale(
  s: Scenario,
  shift: Shift,
  who: Member,
  totalIdr: number,
): Promise<void> {
  const orderId = randomUUID();
  const tax = Math.round(totalIdr / 11);
  const { tenantId, outletId } = s.tenant;
  await asOwnerTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', $8, now())`,
      [
        orderId,
        tenantId,
        outletId,
        `BL-${orderId.slice(0, 8)}`,
        totalIdr - tax,
        tax,
        totalIdr,
        shift.businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders
         (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', $4, $5, $6, now(), now())`,
      [orderId, tenantId, outletId, shift.id, who.deviceId, who.userId],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now(), $5, $6)`,
      [tenantId, outletId, orderId, totalIdr, who.userId, shift.id],
    );
  });
}

/** An approved supervisor-PIN override row for closing with count `countId`. */
async function approvalFor(
  s: Scenario,
  who: Member,
  countId: string,
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const id = randomUUID();
  const { rows } = await owner.query<{ variance: number }>(
    "SELECT variance_idr::int AS variance FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2",
    [s.tenant.tenantId, countId],
  );
  const valueIdr = Math.abs(rows[0]?.variance ?? 0);
  await asOwnerTenant(s.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               'Hitung kas akhir shift', $6, 'pos_shift_count', $7, $8,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        id,
        s.tenant.tenantId,
        s.tenant.outletId,
        who.userId,
        s.approver.userId,
        valueIdr,
        countId,
        pinOverrideFixtureFingerprint({
          requestedBy: who.userId,
          outletId: s.tenant.outletId,
          action: "cash_shift_close",
          valueIdr,
          reason: "Hitung kas akhir shift",
          objectType: "pos_shift_count",
          objectId: countId,
          approverUserId: s.approver.userId,
        }),
      ],
    ),
  );
  return { approvedBy: s.approver.userId, approvalRequestId: id };
}

function countsFor(totalIdr: number) {
  let rest = totalIdr;
  const lines: { denominationIdr: number; quantity: number }[] = [];
  for (const denominationIdr of [100_000, 50_000, 20_000, 10_000, 5_000]) {
    const quantity = Math.floor(rest / denominationIdr);
    if (quantity > 0) lines.push({ denominationIdr, quantity });
    rest -= quantity * denominationIdr;
  }
  if (rest !== 0) throw new Error("countsFor needs a multiple of 5000");
  return lines;
}

/** Count COUNTED_IDR and close the member's shift (variance -5.000). */
async function closeShiftWithVariance(s: Scenario, who: Member, shift: Shift) {
  const counted = await who.client
    .post(`${shiftsPath(s)}/${shift.id}/counts`)
    .set(s.headers)
    .set(originHeader)
    .send({ counts: countsFor(COUNTED_IDR), idempotencyKey: randomUUID() });
  expect(counted.status, JSON.stringify(counted.body)).toBe(201);
  const count = posShiftCountReceiptSchema.parse(counted.body.data);
  const closed = await who.client
    .post(`${shiftsPath(s)}/${shift.id}/close`)
    .set(s.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      countId: count.id,
      varianceNote: "Selisih hitung kas pada uji hari buta",
      ...(await approvalFor(s, who, count.id)),
    });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
}

function readDay(s: Scenario, who: Member, businessDate: string) {
  return who.client
    .get(`${dayPath(s)}?businessDate=${encodeURIComponent(businessDate)}`)
    .set(s.headers)
    .set(originHeader);
}

function closeDay(s: Scenario, who: Member, businessDate: string) {
  return who.client
    .post(`${dayPath(s)}/close`)
    .set(s.headers)
    .set(originHeader)
    .send({
      businessDate,
      inventoryDeduction: false,
      idempotencyKey: randomUUID(),
    });
}

type Recap = ReturnType<typeof endOfDayRecapViewSchema.parse>;

/** Every GET answer must satisfy the contract (full or blind recap). */
async function recapOf(
  s: Scenario,
  who: Member,
  businessDate: string,
): Promise<Recap> {
  const response = await readDay(s, who, businessDate);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return endOfDayRecapViewSchema.parse(response.body.data);
}

function deviceRow(recap: Recap, deviceId: string) {
  const row = recap.devices.find((device) => device.deviceId === deviceId);
  expect(row, `device ${deviceId} missing from the recap`).toBeDefined();
  return row!;
}

/** The blind view: flag, blank totals, blank tender amounts, method kept. */
function expectBlindTotals(recap: Recap) {
  expect(recap).toHaveProperty("drawerFiguresHidden", true);
  expect(recap.totalVarianceIdr).toBeNull();
  expect(recap.totalExpiredCashOutIdr).toBeNull();
  // Every method, so the used set (cash only here) does not leak (legend-awg5p
  // architect K finding).
  expect(recap.tenders.map((row) => row.method).sort()).toEqual(
    [...POS_TENDER_METHODS].sort(),
  );
  for (const row of recap.tenders) {
    expect(row.capturedIdr).toBeNull();
    expect(row.refundedIdr).toBeNull();
    expect(row.netIdr).toBeNull();
  }
  // Sales, refund and void totals stay numbers.
  expect(recap.totalSalesIdr).toEqual(expect.any(Number));
  expect(recap.totalRefundsIdr).toEqual(expect.any(Number));
  expect(recap.totalVoidsIdr).toEqual(expect.any(Number));
}

function expectBlindDevice(recap: Recap, deviceId: string) {
  const row = deviceRow(recap, deviceId);
  expect(row.cashVarianceIdr).toBeNull();
  expect(row.expiredCashOutIdr).toBeNull();
}

/** The full view: no flag key at all, numbers everywhere. */
function expectFullTotals(recap: Recap) {
  expect(recap).not.toHaveProperty("drawerFiguresHidden");
  expect(recap.totalVarianceIdr).toEqual(expect.any(Number));
  expect(recap.totalExpiredCashOutIdr).toEqual(expect.any(Number));
  expect(recap.tenders.length).toBeGreaterThan(0);
  for (const row of recap.tenders) {
    expect(row.capturedIdr).toEqual(expect.any(Number));
    expect(row.refundedIdr).toEqual(expect.any(Number));
    expect(row.netIdr).toEqual(expect.any(Number));
  }
}

function expectFullDevice(recap: Recap, deviceId: string) {
  const row = deviceRow(recap, deviceId);
  expect(row.cashVarianceIdr).toEqual(expect.any(Number));
  expect(row.expiredCashOutIdr).toEqual(expect.any(Number));
}

beforeAll(() => {
  app = createApp();
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  // Audit rows and closed shifts are append-only, so the isolated tenants stay
  // in the disposable database; give them a valid creator.
  await owner.query(
    "UPDATE tenants SET created_by = $1 WHERE slug LIKE 'tenant-day-blind-%'",
    [randomUUID()],
  );
  await owner.end();
});

// ---- Tests -----------------------------------------------------------------------------

describe("POS-03 legend-awg5p day recap is blind for the caller's own shift", () => {
  it("legend-awg5p: a supervisor with a shift on the open day sees the recap with their device and every tender amount blank", async () => {
    const s = await newScenario("open");
    const shift = await openShift(s, s.supervisor);
    await seedCashSale(s, shift, s.supervisor, SALE_IDR);

    const recap = await recapOf(s, s.supervisor, shift.businessDate);
    expect(recap.status).toBe("open");
    expectBlindTotals(recap);
    expectBlindDevice(recap, s.supervisor.deviceId);
    // The sale itself is still reported.
    expect(recap.totalSalesIdr).toBe(SALE_IDR);
    expect(deviceRow(recap, s.supervisor.deviceId).totalIdr).toBe(SALE_IDR);
  });

  it("legend-awg5p: the supervisor stays blind after their shift closes with a variance, and after the outlet manager closes the day", async () => {
    const s = await newScenario("closed");
    const shift = await openShift(s, s.supervisor);
    await seedCashSale(s, shift, s.supervisor, SALE_IDR);
    await closeShiftWithVariance(s, s.supervisor, shift);

    // Shift closed, day still open (live path).
    const live = await recapOf(s, s.supervisor, shift.businessDate);
    expect(live.status).toBe("open");
    expectBlindTotals(live);
    expectBlindDevice(live, s.supervisor.deviceId);
    expect(live.totalSalesIdr).toBe(SALE_IDR);

    // The outlet manager closes the day and sees the real variance.
    const closed = await closeDay(s, s.manager, shift.businessDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const managerView = await recapOf(s, s.manager, shift.businessDate);
    expect(managerView.status).toBe("closed");
    expectFullTotals(managerView);
    expect(managerView.totalVarianceIdr).toBe(VARIANCE_IDR);

    // Frozen path: the supervisor is still blind.
    const frozen = await recapOf(s, s.supervisor, shift.businessDate);
    expect(frozen.status).toBe("closed");
    expect(frozen.closedAt).not.toBeNull();
    expectBlindTotals(frozen);
    expectBlindDevice(frozen, s.supervisor.deviceId);
    expect(frozen.totalSalesIdr).toBe(SALE_IDR);
  });

  it("legend-awg5p: an outlet manager (pos.day.close) who also held a shift that day gets the full recap", async () => {
    const s = await newScenario("manager");
    const shift = await openShift(s, s.manager);
    await seedCashSale(s, shift, s.manager, SALE_IDR);

    const response = await readDay(s, s.manager, shift.businessDate);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).not.toHaveProperty("drawerFiguresHidden");
    const recap = endOfDayRecapSchema.parse(response.body.data);
    expectFullTotals(recap);
    expectFullDevice(recap, s.manager.deviceId);
    const cash = recap.tenders.find((row) => row.method === "cash");
    expect(cash?.capturedIdr).toBe(SALE_IDR);
  });

  it("legend-awg5p: a supervisor with no shift that day gets the full recap", async () => {
    const s = await newScenario("noshift");
    // Another member (the cashier) ran the shift; the supervisor ran none.
    const shift = await openShift(s, s.cashier);
    await seedCashSale(s, shift, s.cashier, SALE_IDR);

    const response = await readDay(s, s.supervisor, shift.businessDate);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).not.toHaveProperty("drawerFiguresHidden");
    const recap = endOfDayRecapSchema.parse(response.body.data);
    expectFullTotals(recap);
    expectFullDevice(recap, s.cashier.deviceId);
    const cash = recap.tenders.find((row) => row.method === "cash");
    expect(cash?.capturedIdr).toBe(SALE_IDR);
  });

  it("legend-awg5p: with two devices, only the supervisor's device is blank and the cashier's device keeps its numbers", async () => {
    const s = await newScenario("twodev");
    const supervisorShift = await openShift(s, s.supervisor);
    await seedCashSale(s, supervisorShift, s.supervisor, SALE_IDR);
    const cashierShift = await openShift(s, s.cashier);
    await seedCashSale(s, cashierShift, s.cashier, SALE_IDR);
    await closeShiftWithVariance(s, s.cashier, cashierShift);

    const recap = await recapOf(s, s.supervisor, supervisorShift.businessDate);
    expectBlindTotals(recap);
    expectBlindDevice(recap, s.supervisor.deviceId);
    const cashierDevice = deviceRow(recap, s.cashier.deviceId);
    expect(cashierDevice.cashVarianceIdr).toBe(VARIANCE_IDR);
    expect(cashierDevice.expiredCashOutIdr).toEqual(expect.any(Number));
    expect(cashierDevice.totalIdr).toBe(SALE_IDR);
    expect(recap.totalSalesIdr).toBe(2 * SALE_IDR);
  });
});
