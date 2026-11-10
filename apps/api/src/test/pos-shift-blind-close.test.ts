// legend-4wrfd (tier K): blind close for the cashier. Decision (CTO, 9 Nov):
// the close response and every shift DTO sent to a caller WITHOUT permission to
// see the variance (the shift's own cashier, or anyone holding only
// shift.cash.operate; a supervisor on their OWN shift too) carry expectedIdr,
// varianceIdr and the drawer breakdown (cashSalesIdr, cashRefundsIdr,
// cashInIdr, cashOutIdr, cashDropIdr) as null, open or closed. Supervisors
// (shift.cash.view_all / shift.cash.approve_close) on another's shift see the
// full figures. countedIdr, varianceNote, status and times stay.
// Acceptance: POS-03 "Tutup shift memakai blind count".
//
// Assumptions:
//  - Read routes: GET <shifts>/:id (data.shift, data.movements), GET <shifts>
//    (data[]), GET <shifts>/:id/cash-movements, as in pos-shift.test.ts.
//  - A supervisor who can also open a shift holds shift.cash.operate plus
//    shift.cash.approve_close (test role "Supervisor Kasir").
//  - Held vs normal cash out differ in amount, so those responses are compared
//    by shape (keys and value types); held vs normal refund have equal amounts
//    and are compared exactly after blanking ids and timestamps.
//  - A close replay (same idempotencyKey and body) answers 200 or 201 with the
//    same data as the first answer for the same caller.

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
import { posShiftCountReceiptSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const FLOAT_IDR = 100_000;
const HELD_IDR = 150_000;

const roleIds = {
  cashier: randomUUID(),
  supervisor: randomUUID(),
  supervisorCashier: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;

const registeredDevices = new Map<string, string>();

// ---- Fixtures (trimmed copies of pos-shift-held-expire.test.ts) --------------------

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

async function member(roleId: string, label: string): Promise<Member> {
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

async function newCashier(
  label = "Kasir",
  roleId = roleIds.cashier,
): Promise<Cashier> {
  const base = await member(roleId, label);
  const deviceId = randomUUID();
  registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  return { ...base, deviceId };
}

function deviceHeader(deviceId: string): string {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

const SHIFTS = () =>
  `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`;

async function openShift(
  cashier: Cashier,
): Promise<{ id: string; businessDate: string }> {
  const response = await cashier.client
    .post(SHIFTS())
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; businessDate: string };
}

function move(who: Member, shiftId: string, body: Record<string, unknown>) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/cash-movements`)
    .set(headers)
    .set(originHeader)
    .send({
      type: "cash_in",
      amountIdr: 20_000,
      reasonNote: "Tambah uang kembalian",
      idempotencyKey: randomUUID(),
      ...body,
    });
}

function close(who: Member, shiftId: string, body: Record<string, unknown>) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/close`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

function submitCount(
  who: Member,
  shiftId: string,
  body: Record<string, unknown>,
) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/counts`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

type CountReceipt = { id: string; sequence: number; countedIdr: number };

function countsFor(
  totalIdr: number,
): { denominationIdr: number; quantity: number }[] {
  let rest = totalIdr;
  const lines: { denominationIdr: number; quantity: number }[] = [];
  for (const denominationIdr of [
    100_000, 50_000, 20_000, 10_000, 5_000, 1_000,
  ]) {
    const quantity = Math.floor(rest / denominationIdr);
    if (quantity > 0) lines.push({ denominationIdr, quantity });
    rest -= quantity * denominationIdr;
  }
  if (rest !== 0) throw new Error("countsFor needs a multiple of 1000");
  if (lines.length === 0) lines.push({ denominationIdr: 1_000, quantity: 0 });
  return lines;
}

async function countDrawer(
  who: Member,
  shiftId: string,
  countedIdr: number,
): Promise<CountReceipt> {
  const response = await submitCount(who, shiftId, {
    counts: countsFor(countedIdr),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(response.body.data) as CountReceipt;
}

async function countRow(countId: string) {
  const { rows } = await owner.query<{ variance: number }>(
    "SELECT variance_idr::int AS variance FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, countId],
  );
  return rows[0];
}

/** An approved `supervisor_pin` override row for closing with count `countId`. */
async function approvalFor(
  cashier: Member,
  countId: string,
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const id = randomUUID();
  const valueIdr = Math.abs((await countRow(countId))?.variance ?? 0);
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               'Hitung kas akhir shift', $6, 'pos_shift_count', $7, $8,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        supervisor.userId,
        valueIdr,
        countId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    ),
  );
  return { approvedBy: supervisor.userId, approvalRequestId: id };
}

/** A completed sale on the shift paid by `method` (cash lands in the shift's drawer). */
async function seedCashSale(
  shift: { id: string; businessDate: string },
  cashier: Cashier,
  totalIdr: number,
): Promise<string> {
  const orderId = randomUUID();
  const tax = Math.round(totalIdr / 11);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', $8, now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `SH-${orderId.slice(0, 8)}`,
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
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        shift.id,
        cashier.deviceId,
        cashier.userId,
      ],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now(), $5, $6)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        totalIdr,
        cashier.userId,
        shift.id,
      ],
    );
  });
  return orderId;
}

/** A held cash refund of the order, charged to `shiftId` (one cash line, as the refund writer stores it). */
async function seedHeldRefund(
  shiftId: string,
  orderId: string,
  cashier: Member,
  amountIdr: number,
  needsApproval = true,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_refunds
         (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
          requested_by, approved_by, approval_request_id, refunded_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, 'quality_complaint', 'Minuman tumpah', $5::jsonb,
               $6, $7, $8, now(), $9, $10)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        amountIdr,
        JSON.stringify([{ method: "cash", amountIdr, reference: null }]),
        cashier.userId,
        supervisor.userId,
        randomUUID(),
        shiftId,
        needsApproval,
      ],
    ),
  );
}

// ---- Blind-close helpers -----------------------------------------------------------

const BLIND_FIELDS = [
  "expectedIdr",
  "varianceIdr",
  "cashSalesIdr",
  "cashRefundsIdr",
  "cashInIdr",
  "cashOutIdr",
  "cashDropIdr",
] as const;

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_PATTERN =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;

/** Ids and timestamps blanked, so two responses compare by figures and shape. */
function normalised(body: unknown): string {
  return JSON.stringify(body)
    .replace(UUID_PATTERN, "<id>")
    .replace(TIMESTAMP_PATTERN, "<time>");
}

/** Keys at every depth plus value types, so two bodies compare by shape only. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  return typeof value;
}

function expectBlind(dto: Record<string, unknown> | undefined) {
  expect(dto, "shift DTO missing").toBeDefined();
  for (const field of BLIND_FIELDS)
    expect(dto, `${field} must be present and null`).toHaveProperty(
      field,
      null,
    );
}

function reportOf(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}`)
    .set(headers)
    .set(originHeader);
}

function listOf(who: Member, deviceId: string) {
  return who.client
    .get(`${SHIFTS()}?deviceId=${deviceId}`)
    .set(headers)
    .set(originHeader);
}

function movementsOfShift(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}/cash-movements`)
    .set(headers)
    .set(originHeader);
}

async function listedShift(who: Member, deviceId: string, shiftId: string) {
  const listed = await listOf(who, deviceId);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return (listed.body.data as Record<string, unknown>[]).find(
    (row) => row.id === shiftId,
  );
}

async function storedShift(shiftId: string) {
  const { rows } = await owner.query<{
    expected: number | null;
    counted: number | null;
    variance: number | null;
    note: string | null;
  }>(
    `SELECT expected_idr::int AS expected, counted_idr::int AS counted,
            variance_idr::int AS variance, variance_note AS note
       FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, shiftId],
  );
  return rows[0]!;
}

// Drawer of the scenario: float 100.000 + sales 55.000 - refund 5.000
// + cash in 20.000 - cash out 10.000 - drop 30.000 = expected 130.000.
const SCENARIO_EXPECTED_IDR = 130_000;
const SCENARIO_COUNTED_IDR = 129_000;
const SCENARIO_NOTE = "Uang kembalian kurang Rp1.000";

/** An open shift with one of each drawer movement and a cash sale / refund. */
async function busyOpenShift(cashier: Cashier) {
  const shift = await openShift(cashier);
  const orderId = await seedCashSale(shift, cashier, 55_000);
  expect(
    (await move(cashier, shift.id, { type: "cash_in", amountIdr: 20_000 }))
      .status,
  ).toBe(201);
  expect(
    (
      await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr: 10_000,
        reasonNote: "Beli es batu",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await move(cashier, shift.id, {
        type: "drop",
        amountIdr: 30_000,
        reasonNote: "Setor ke brankas",
      })
    ).status,
  ).toBe(201);
  await seedHeldRefund(shift.id, orderId, cashier, 5_000, false);
  return shift;
}

/** Count, approve and close a busy shift as its own owner; returns the reply and the body sent. */
async function closeBusyShift(cashier: Cashier, shiftId: string) {
  const count = await countDrawer(cashier, shiftId, SCENARIO_COUNTED_IDR);
  const body = {
    idempotencyKey: randomUUID(),
    countId: count.id,
    varianceNote: SCENARIO_NOTE,
    ...(await approvalFor(cashier, count.id)),
  };
  return { reply: await close(cashier, shiftId, body), body };
}

/** Count `countedIdr`, approve and close a shift; every answer the cashier can read afterwards. */
async function closeAndRead(
  cashier: Cashier,
  shiftId: string,
  countedIdr: number,
) {
  const count = await countDrawer(cashier, shiftId, countedIdr);
  const reply = await close(cashier, shiftId, {
    countId: count.id,
    ...(await approvalFor(cashier, count.id)),
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const report = await reportOf(cashier, shiftId);
  const listed = await listedShift(cashier, cashier.deviceId, shiftId);
  const moves = await movementsOfShift(cashier, shiftId);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  expect(moves.status, JSON.stringify(moves.body)).toBe(200);
  expectBlind(reply.body.data);
  expectBlind(report.body.data.shift);
  expectBlind(listed);
  return {
    close: reply.body,
    report: report.body,
    listed,
    moves: moves.body,
  };
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `blind-close-${randomUUID().slice(0, 6)}`,
  );
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Blind Close", ["shift.cash.operate"]],
    [
      roleIds.supervisor,
      "Supervisor Blind Close",
      ["shift.cash.approve_close"],
    ],
    [
      roleIds.supervisorCashier,
      "Supervisor Kasir Blind Close",
      ["shift.cash.operate", "shift.cash.approve_close"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await member(roleIds.supervisor, "Supervisor");
  await setStaffPin(
    tenantContextOf(tenant.tenantId).tenant,
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  // Audit rows and closed shifts are append-only, so the isolated tenant stays
  // in the disposable database; give it a valid creator.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Tests -------------------------------------------------------------------------

describe("POS-03 legend-4wrfd blind close: the cashier sees no expected, variance or drawer breakdown", () => {
  it("legend-4wrfd: the cashier's close response has the seven figures null and keeps countedIdr, varianceNote and status", async () => {
    const cashier = await newCashier();
    const shift = await busyOpenShift(cashier);
    const { reply } = await closeBusyShift(cashier, shift.id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectBlind(reply.body.data);
    expect(reply.body.data).toMatchObject({
      status: "closed",
      countedIdr: SCENARIO_COUNTED_IDR,
      varianceNote: SCENARIO_NOTE,
    });
    expect(reply.body.data.closedAt).toBeTruthy();
  });

  it("legend-4wrfd: the cashier's own shift report and list show the seven figures null while the shift is open", async () => {
    const cashier = await newCashier();
    const shift = await busyOpenShift(cashier);

    const own = await reportOf(cashier, shift.id);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expectBlind(own.body.data.shift);
    expect(own.body.data.shift.status).toBe("open");
    expectBlind(await listedShift(cashier, cashier.deviceId, shift.id));
  });

  it("legend-4wrfd: the open response of a new shift has the seven figures null for the cashier", async () => {
    const cashier = await newCashier();
    const opened = await cashier.client
      .post(SHIFTS())
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
      .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expectBlind(opened.body.data);
  });

  it("legend-4wrfd: the cashier's own shift report and list show the seven figures null after the close", async () => {
    const cashier = await newCashier();
    const shift = await busyOpenShift(cashier);
    expect((await closeBusyShift(cashier, shift.id)).reply.status).toBe(200);

    const own = await reportOf(cashier, shift.id);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expectBlind(own.body.data.shift);
    expect(own.body.data.shift).toMatchObject({
      status: "closed",
      countedIdr: SCENARIO_COUNTED_IDR,
      varianceNote: SCENARIO_NOTE,
    });
    const listed = await listedShift(cashier, cashier.deviceId, shift.id);
    expectBlind(listed);
    expect(listed).toMatchObject({
      status: "closed",
      countedIdr: SCENARIO_COUNTED_IDR,
    });
  });

  it("legend-4wrfd: a supervisor reading the cashier's shift sees full figures equal to the stored row, in the report and the list", async () => {
    const cashier = await newCashier();
    const shift = await busyOpenShift(cashier);

    // Open: the live drawer breakdown is visible to a supervisor.
    const live = await reportOf(supervisor, shift.id);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(live.body.data.shift).toMatchObject({
      status: "open",
      cashSalesIdr: 55_000,
      cashRefundsIdr: 5_000,
      cashInIdr: 20_000,
      cashOutIdr: 10_000,
      cashDropIdr: 30_000,
    });

    expect((await closeBusyShift(cashier, shift.id)).reply.status).toBe(200);
    const stored = await storedShift(shift.id);
    expect(stored.expected).toBe(SCENARIO_EXPECTED_IDR);
    expect(stored.variance).toBe(SCENARIO_COUNTED_IDR - SCENARIO_EXPECTED_IDR);

    const full = {
      status: "closed",
      expectedIdr: stored.expected,
      countedIdr: stored.counted,
      varianceIdr: stored.variance,
      varianceNote: stored.note,
      cashSalesIdr: 55_000,
      cashRefundsIdr: 5_000,
      cashInIdr: 20_000,
      cashOutIdr: 10_000,
      cashDropIdr: 30_000,
    };
    const read = await reportOf(supervisor, shift.id);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.shift).toMatchObject(full);
    expect(
      await listedShift(supervisor, cashier.deviceId, shift.id),
    ).toMatchObject(full);
  });

  it("legend-4wrfd: a supervisor's own shift is blind to them, in the close response, the report and the list", async () => {
    const boss = await newCashier(
      "Supervisor Kasir",
      roleIds.supervisorCashier,
    );
    const shift = await busyOpenShift(boss);

    const open = await reportOf(boss, shift.id);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expectBlind(open.body.data.shift);
    expectBlind(await listedShift(boss, boss.deviceId, shift.id));

    const { reply } = await closeBusyShift(boss, shift.id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expectBlind(reply.body.data);
    const closed = await reportOf(boss, shift.id);
    expectBlind(closed.body.data.shift);
    expectBlind(await listedShift(boss, boss.deviceId, shift.id));
    // The stored row is untouched: blindness is only in the answer.
    expect((await storedShift(shift.id)).expected).toBe(SCENARIO_EXPECTED_IDR);
  });

  it("legend-4wrfd: replaying the cashier's close keeps the blind shape", async () => {
    const cashier = await newCashier();
    const shift = await busyOpenShift(cashier);
    const { reply, body } = await closeBusyShift(cashier, shift.id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);

    const replay = await close(cashier, shift.id, body);
    expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
    expectBlind(replay.body.data);
    expect(normalised(replay.body.data)).toBe(normalised(reply.body.data));
  });

  it("legend-4wrfd: the cashier's answers are identical for a held and a normal cash out, in the close, report, list and movements", async () => {
    // Held: Rp150.000 over the drawer; normal: Rp10.000 that fits. Amounts
    // differ, so the two runs compare by shape.
    const runs = [];
    for (const amountIdr of [HELD_IDR, 10_000]) {
      const cashier = await newCashier();
      const shift = await openShift(cashier);
      const out = await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr,
        reasonNote: "Beli gas elpiji",
      });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      const counted =
        amountIdr === HELD_IDR ? FLOAT_IDR : FLOAT_IDR - amountIdr;
      runs.push(await closeAndRead(cashier, shift.id, counted));
    }
    const [held, normal] = runs;
    expect(shape(held!.close)).toEqual(shape(normal!.close));
    expect(shape(held!.report)).toEqual(shape(normal!.report));
    expect(shape(held!.listed)).toEqual(shape(normal!.listed));
    expect(shape(held!.moves)).toEqual(shape(normal!.moves));
    for (const run of [held!, normal!])
      expect(JSON.stringify([run.close, run.report, run.listed])).not.toMatch(
        /held|expire|needs_?approval/i,
      );
  });

  it("legend-4wrfd: the cashier's answers are identical for a held and a normal cash refund, in the close, report, list and movements", async () => {
    const runs = [];
    for (const needsApproval of [true, false]) {
      const cashier = await newCashier();
      const shift = await openShift(cashier);
      const orderId = await seedCashSale(shift, cashier, 11_000);
      await seedHeldRefund(shift.id, orderId, cashier, 1_000, needsApproval);
      runs.push(
        await closeAndRead(cashier, shift.id, FLOAT_IDR + 11_000 - 1_000),
      );
    }
    const [held, normal] = runs;
    expect(normalised(held!.close)).toBe(normalised(normal!.close));
    expect(normalised(held!.report)).toBe(normalised(normal!.report));
    expect(normalised(held!.listed)).toBe(normalised(normal!.listed));
    expect(normalised(held!.moves)).toBe(normalised(normal!.moves));
    for (const run of [held!, normal!])
      expect(JSON.stringify([run.close, run.report, run.listed])).not.toMatch(
        /held|needs_?approval/i,
      );
  });
});
