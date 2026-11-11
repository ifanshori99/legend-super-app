// legend-mxxev (tier K): the audit reader must not unmask the own-shift
// day-close variance. GET /api/audit/events rows with objectType
// "pos_daily_close" (action pos_day.closed) carry maskedChanges.after
// { businessDate, totalVarianceIdr, totalSalesIdr, ... }.
//  - reader WITHOUT pos.day.close who ran a shift at that outlet on that
//    businessDate: totalVarianceIdr is "[REDACTED]", other fields stay;
//  - reader WITH pos.day.close at that outlet: the raw number;
//  - reader WITHOUT pos.day.close and no shift that date: the raw number.
// Same rule as the day recap (pos-day-blind-own-shift.test.ts).
//
// Assumptions:
//  - Fixtures follow pos-day-blind-own-shift.test.ts: one isolated tenant per
//    case, supervisor opens a shift, sells cash 55.000 and closes it with
//    counted 150.000 (variance -5.000); the outlet manager then closes the day.
//  - The supervisor role gets audit.log.view on top of its shift permissions
//    (a custom grant); the manager role gets audit.log.view as well.
//  - The audit row is found by objectType=pos_daily_close and the tenant's
//    only outlet; each tenant closes exactly one day, so one row exists.
//  - Rule 2 (cases 4-5): the cashier who reads the audit rows of their own
//    shift (pos_shift, pos_shift_count, pos_override) sees the drawer fields
//    expectedIdr and varianceIdr as "[REDACTED]" and countedIdr intact; a
//    reader with pos.day.close sees raw numbers. A pos_override row is
//    asserted through the real createPosOverride path (rule 3): the shift close
//    approval writes pos_override.recorded rows keyed by the COUNT id.
//  - Null values (open-time snapshots) are ignored; non-null drawer values
//    on the supervisor's own-shift rows must all be "[REDACTED]".
//  - The shift's expected drawer is 155.000 (float 100.000 + cash sale 55.000).

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
  createPosOverrideSchema,
  type PosOverrideView,
} from "@starter/shared/access/override";
import { ulidToUuid } from "@starter/shared/core";
import { posShiftCountReceiptSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
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
const EXPECTED_IDR = FLOAT_IDR + SALE_IDR; // 155.000
const VARIANCE_IDR = COUNTED_IDR - EXPECTED_IDR; // -5.000

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
  otherSupervisor: Member;
  approver: Member;
  manager: Member;
  approverRoleId: string;
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
    `audit-day-blind-${label}-${randomUUID().slice(0, 6)}`,
  );
  const roles: [string, string, string[]][] = [
    [
      randomUUID(),
      "Supervisor Kasir Hari Buta",
      [
        "shift.cash.operate",
        "shift.cash.view_all",
        "shift.cash.approve_close",
        "order.view",
        "audit.log.view",
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
      ["pos.day.close", "shift.cash.operate", "audit.log.view"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  const supervisor = await member(tenant, roles[0]![0], `Supervisor ${label}`);
  const otherSupervisor = await member(
    tenant,
    roles[0]![0],
    `Supervisor Lain ${label}`,
  );
  const approver = await member(tenant, roles[1]![0], `Penyetuju ${label}`);
  const manager = await member(tenant, roles[2]![0], `Manajer ${label}`);
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
    otherSupervisor,
    approver,
    manager,
    approverRoleId: roles[1]![0],
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

async function submitCount(
  s: Scenario,
  who: Member,
  shift: Shift,
  totalIdr: number,
) {
  const counted = await who.client
    .post(`${shiftsPath(s)}/${shift.id}/counts`)
    .set(s.headers)
    .set(originHeader)
    .send({ counts: countsFor(totalIdr), idempotencyKey: randomUUID() });
  expect(counted.status, JSON.stringify(counted.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(counted.body.data);
}

/**
 * The shift-close approval through the real path (createPosOverride), so the
 * pos_override.recorded (PIN) or pos_override.requested (phone) audit row exists.
 * For cash_shift_close the service stores |server variance| as the value.
 */
async function shiftCloseOverride(
  s: Scenario,
  who: Member,
  countId: string,
  approval: Record<string, unknown>,
): Promise<PosOverrideView> {
  const { override } = await createPosOverride(
    tenantContextOf(s.tenant.tenantId).tenant,
    who.userId,
    createPosOverrideSchema.parse({
      outletId: s.tenant.outletId,
      action: "cash_shift_close",
      valueIdr: 0,
      reason: "Hitung kas akhir shift",
      objectType: "pos_shift_count",
      objectId: countId,
      approval,
    }),
    { idempotencyKey: null },
  );
  return override;
}

const pinApproval = (s: Scenario) => ({
  method: "supervisor_pin",
  approverUserId: s.approver.userId,
  pin: PIN,
});

/** Close the member's shift on `countId` with a real PIN-approved override. */
async function closeShift(
  s: Scenario,
  who: Member,
  shift: Shift,
  countId: string,
) {
  const override = await shiftCloseOverride(s, who, countId, pinApproval(s));
  expect(override.status).toBe("approved");
  const closed = await who.client
    .post(`${shiftsPath(s)}/${shift.id}/close`)
    .set(s.headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      countId,
      varianceNote: "Selisih hitung kas pada uji hari buta",
      approvedBy: s.approver.userId,
      approvalRequestId: ulidToUuid(override.id),
    });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
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

type DayCloseAfter = Record<string, unknown>;

/** The `after` payload of the tenant's single pos_day.closed audit row. */
async function dayCloseAfter(s: Scenario, who: Member): Promise<DayCloseAfter> {
  const response = await who.client
    .get("/api/audit/events?objectType=pos_daily_close&limit=100")
    .set(s.headers)
    .set(originHeader);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const rows = (
    response.body.data as Array<{
      event: {
        action: string;
        objectType: string;
        maskedChanges: { after: DayCloseAfter | null };
      };
    }>
  ).filter((row) => row.event.action === "pos_day.closed");
  expect(rows, "pos_day.closed audit row").toHaveLength(1);
  const after = rows[0]!.event.maskedChanges.after;
  expect(after).not.toBeNull();
  return after!;
}

type AuditRow = {
  event: {
    action: string;
    objectType: string;
    objectId: string | null;
    maskedChanges: {
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    };
  };
};

async function auditRows(
  s: Scenario,
  who: Member,
  objectType: string,
): Promise<AuditRow[]> {
  const response = await who.client
    .get(`/api/audit/events?objectType=${objectType}&limit=100`)
    .set(s.headers)
    .set(originHeader);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data as AuditRow[];
}

/** Both sides (before, after) of every row, as flat payloads. */
const sidesOf = (rows: AuditRow[]) =>
  rows.flatMap((row) =>
    [row.event.maskedChanges.before, row.event.maskedChanges.after].filter(
      (side): side is Record<string, unknown> => side !== null,
    ),
  );

/** Every value of `field` across all sides that carry it. */
const valuesOf = (sides: Record<string, unknown>[], field: string) =>
  sides
    .filter((side) => side[field] !== undefined && side[field] !== null)
    .map((side) => side[field]);

/** The audit rows that belong to the shift (shift rows and count rows). */
async function ownShiftRows(s: Scenario, who: Member, shiftId: string) {
  const shiftRows = (await auditRows(s, who, "pos_shift")).filter(
    (row) => row.event.objectId === shiftId,
  );
  const countRows = (await auditRows(s, who, "pos_shift_count")).filter(
    (row) =>
      row.event.maskedChanges.after?.shiftId === shiftId ||
      row.event.maskedChanges.before?.shiftId === shiftId,
  );
  expect(shiftRows.length, "pos_shift audit rows of the shift").toBeGreaterThan(
    0,
  );
  expect(
    countRows.length,
    "pos_shift_count audit rows of the shift",
  ).toBeGreaterThan(0);
  return { shiftRows, countRows };
}

/** pos_override audit rows (recorded and requested) of the shift-close count. */
async function overrideRowsOfCount(s: Scenario, who: Member, countId: string) {
  return (await auditRows(s, who, "pos_override")).filter((row) => {
    const after = row.event.maskedChanges.after;
    return (
      after !== null &&
      after.action === "cash_shift_close" &&
      after.objectId === countId
    );
  });
}

/**
 * Supervisor ran and closed a shift with variance; the manager closes the day.
 * Options (all done BEFORE the day closes, since a closed day takes no more
 * shifts): `phone` also files a phone-approval request (pos_override.requested)
 * for the supervisor's count; `cashierB` has the other supervisor open, count
 * and close their own shift.
 */
async function scenarioWithClosedDay(
  label: string,
  options: { phone?: boolean; cashierB?: boolean } = {},
) {
  const s = await newScenario(label);
  if (options.phone)
    // A phone request needs an approval matrix row: one level, the approver role.
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'cash_shift_close', NULL, $2, 1)`,
      [s.tenant.tenantId, s.approverRoleId],
    );
  const shift = await openShift(s, s.supervisor);
  await seedCashSale(s, shift, s.supervisor, SALE_IDR);
  const count = await submitCount(s, s.supervisor, shift, COUNTED_IDR);
  if (options.phone)
    await shiftCloseOverride(s, s.supervisor, count.id, {
      method: "supervisor_phone",
    });
  await closeShift(s, s.supervisor, shift, count.id);
  let countIdB: string | null = null;
  if (options.cashierB) {
    const shiftB = await openShift(s, s.otherSupervisor);
    const countB = await submitCount(s, s.otherSupervisor, shiftB, COUNTED_IDR);
    await closeShift(s, s.otherSupervisor, shiftB, countB.id);
    countIdB = countB.id;
  }
  const closed = await closeDay(s, s.manager, shift.businessDate);
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  return {
    s,
    businessDate: shift.businessDate,
    shiftId: shift.id,
    countId: count.id,
    countIdB,
  };
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
    "UPDATE tenants SET created_by = $1 WHERE slug LIKE 'tenant-audit-day-blind-%'",
    [randomUUID()],
  );
  await owner.end();
});

describe("POS-05 legend-mxxev audit reader masks the own-shift day-close variance", () => {
  it("legend-mxxev: a supervisor with audit.log.view who ran a shift that day sees totalVarianceIdr redacted and the sales total intact", async () => {
    const { s, businessDate } = await scenarioWithClosedDay("own");
    const after = await dayCloseAfter(s, s.supervisor);
    expect(after.businessDate).toBe(businessDate);
    expect(after.totalVarianceIdr).toBe("[REDACTED]");
    expect(after.totalSalesIdr).toBeDefined();
    expect(after.totalSalesIdr).not.toBe("[REDACTED]");
    expect(Number(after.totalSalesIdr)).toBe(SALE_IDR);
  });

  it("legend-mxxev: the outlet manager (pos.day.close) reads the raw variance", async () => {
    const { s } = await scenarioWithClosedDay("manager");
    const after = await dayCloseAfter(s, s.manager);
    expect(Number(after.totalVarianceIdr)).toBe(VARIANCE_IDR);
    expect(Number(after.totalSalesIdr)).toBe(SALE_IDR);
  });

  it("legend-mxxev: a supervisor with audit.log.view and no shift that day reads the raw variance", async () => {
    const { s } = await scenarioWithClosedDay("noshift");
    const after = await dayCloseAfter(s, s.otherSupervisor);
    expect(Number(after.totalVarianceIdr)).toBe(VARIANCE_IDR);
    expect(Number(after.totalSalesIdr)).toBe(SALE_IDR);
  });

  it("legend-mxxev: the supervisor reads their own shift and count audit rows with expectedIdr and varianceIdr redacted, countedIdr intact", async () => {
    const { s, shiftId } = await scenarioWithClosedDay("own-shift-rows");
    const { shiftRows, countRows } = await ownShiftRows(
      s,
      s.supervisor,
      shiftId,
    );
    const sides = sidesOf([...shiftRows, ...countRows]);
    for (const field of ["varianceIdr", "expectedIdr"]) {
      const values = valuesOf(sides, field);
      expect(
        values.length,
        `${field} present on own-shift rows`,
      ).toBeGreaterThan(0);
      expect(values, `${field} on own-shift rows`).toEqual(
        values.map(() => "[REDACTED]"),
      );
    }
    const counted = valuesOf(sides, "countedIdr");
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.map(Number)).toEqual(counted.map(() => COUNTED_IDR));
  });

  it("legend-mxxev: the outlet manager reads the raw drawer numbers on the same shift and count rows", async () => {
    const { s, shiftId } = await scenarioWithClosedDay("manager-shift-rows");
    const { shiftRows, countRows } = await ownShiftRows(s, s.manager, shiftId);
    const sides = sidesOf([...shiftRows, ...countRows]);
    const variances = valuesOf(sides, "varianceIdr");
    const expecteds = valuesOf(sides, "expectedIdr");
    // The open-time snapshot may carry 0; the counted/closed state carries
    // the real figure. Nothing may be redacted, and the real figure is there.
    expect(variances).not.toContain("[REDACTED]");
    expect(expecteds).not.toContain("[REDACTED]");
    expect(variances.map(Number)).toContain(VARIANCE_IDR);
    expect(expecteds.map(Number)).toContain(EXPECTED_IDR);
    const counted = valuesOf(sides, "countedIdr");
    expect(counted).not.toContain("[REDACTED]");
    expect(counted.map(Number)).toContain(COUNTED_IDR);
  });
  it("legend-mxxev: the supervisor reads the override audit row of their own shift close with valueIdr, expectedIdr and varianceIdr redacted", async () => {
    const { s, countId } = await scenarioWithClosedDay("override-own");
    const rows = await overrideRowsOfCount(s, s.supervisor, countId);
    // The real PIN path wrote at least one pos_override.recorded row.
    expect(
      rows.filter((row) => row.event.action === "pos_override.recorded").length,
      "pos_override.recorded rows of the shift close",
    ).toBeGreaterThan(0);
    for (const row of rows) {
      const after = row.event.maskedChanges.after!;
      expect(after.valueIdr, "valueIdr").toBe("[REDACTED]");
      for (const field of ["expectedIdr", "varianceIdr"])
        if (after[field] !== undefined && after[field] !== null)
          expect(after[field], field).toBe("[REDACTED]");
    }
  });

  it("legend-mxxev: the outlet manager reads the raw override audit row of the shift close", async () => {
    const { s, countId } = await scenarioWithClosedDay("override-manager");
    const rows = await overrideRowsOfCount(s, s.manager, countId);
    expect(rows.length, "override rows of the shift close").toBeGreaterThan(0);
    const values = valuesOf(sidesOf(rows), "valueIdr");
    expect(values).not.toContain("[REDACTED]");
    expect(values.map(Number)).toContain(Math.abs(VARIANCE_IDR));
  });

  it("legend-mxxev: a supervisor with no shift that day reads the first supervisor's override audit row raw", async () => {
    const { s, countId } = await scenarioWithClosedDay("override-other");
    const rows = await overrideRowsOfCount(s, s.otherSupervisor, countId);
    expect(rows.length, "override rows of the shift close").toBeGreaterThan(0);
    const values = valuesOf(sidesOf(rows), "valueIdr");
    expect(values).not.toContain("[REDACTED]");
    expect(values.map(Number)).toContain(Math.abs(VARIANCE_IDR));
  });

  it("legend-mxxev: a phone-requested shift close (pos_override.requested) never shows valueIdr to its cashier", async () => {
    // Observed: the default audit masking already redacts the whole `after`
    // of pos_override.requested rows (action, objectId, valueIdr ...) at write
    // time, for every reader, so the rows cannot be matched by count
    // id and this case cannot tell rule 3 from the default masking. It is a
    // regression guard: the row exists and valueIdr is never the raw number.
    const { s } = await scenarioWithClosedDay("override-phone", {
      phone: true,
    });
    const requested = (await auditRows(s, s.supervisor, "pos_override")).filter(
      (row) => row.event.action === "pos_override.requested",
    );
    expect(requested.length, "pos_override.requested rows").toBeGreaterThan(0);
    for (const row of requested)
      expect(row.event.maskedChanges.after!.valueIdr).toBe("[REDACTED]");
  });

  it("legend-mxxev: another cashier's shift-close override audit row stays raw for the supervisor", async () => {
    const { s, countIdB } = await scenarioWithClosedDay("override-cashier-b", {
      cashierB: true,
    });
    const rows = await overrideRowsOfCount(s, s.supervisor, countIdB!);
    expect(rows.length).toBeGreaterThan(0);
    const values = valuesOf(sidesOf(rows), "valueIdr");
    expect(values.length).toBeGreaterThan(0);
    expect(values).not.toContain("[REDACTED]");
  });
});
