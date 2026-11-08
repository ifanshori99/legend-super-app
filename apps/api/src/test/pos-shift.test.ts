// Cashier shift, cash movements and blind-count close (bead legend-6c0; PRD
// v1.7 §3 F8 "Shift Kasir", §4 E, §6 C pos_shifts / cash_movements).
// Acceptance:
//   POS-03  "Tutup shift memakai blind count; selisih kas tidak dapat
//           disembunyikan atau diubah setelah disetujui"
//   TEN-01  another tenant never reads or closes a shift (API and RLS).
// The end-of-day half of the bead lives in pos-day.test.ts.
//
// Everything goes through the real Express app (HTTP), Better Auth, RBAC and
// PostgreSQL with RLS in a fresh isolated tenant. Behaviour is derived from
// the contract in packages/shared/src/pos and the bead brief, not from the
// service code.
//
// Assumptions (the brief leaves them open):
//  - A supervisor approval is an approved `supervisor_pin` pos_overrides row
//    (action `cash_shift_close`, objectType `pos_shift`, objectId = shift id,
//    requested_by = cashier) inserted directly with a UUID id; the close body
//    sends `approvedBy` + `approvalRequestId` = that id. One test goes through
//    the real staff-override service and exposes a contract gap: its ULID id
//    is not a valid UUID for `approvalRequestId`.
//  - Idempotent replays answer 200 or 201 with the stored result.
//  - A refused request answers with `{ error: { code } }` and the HTTP status
//    of the contract error table (packages/shared/src/pos/errors.ts).
//  - Cash sales are seeded straight into orders / pos_orders /
//    pos_order_tenders with `shift_id` set, so this file does not depend on the
//    order service's pricing set-up.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { getPosShiftReport } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

// This API answers a body, query or param that fails the strict contract with
// 422 VALIDATION_ERROR (not 400); see the other API suites.
const VALIDATION_STATUS = 422;
const PIN = "582914";
const FLOAT_IDR = 100_000;

const roleIds = {
  cashier: randomUUID(),
  supervisor: randomUUID(),
  viewAll: randomUUID(),
  none: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let other: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;
let viewAllUser: Member;
let noShiftUser: Member;
let outsider: Member; // staff of the other tenant

/** `${tenantId}:${deviceId}` → outletId, read by the device outlet resolver. */
const registeredDevices = new Map<string, string>();

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
  forTenant: IsolatedTenant,
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
    [forTenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

/** A cashier with the operate permission and a registered terminal. */
async function newCashier(label = "Kasir"): Promise<Cashier> {
  const base = await member(tenant, roleIds.cashier, label);
  const deviceId = randomUUID();
  registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  return { ...base, deviceId };
}

function deviceHeader(deviceId: string, forTenant = tenant): string {
  return signDeviceToken({
    version: 1,
    tenantId: forTenant.tenantId,
    brandId: null,
    deviceId,
  });
}

const SHIFTS = (outletId = tenant.outletId) =>
  `/api/outlets/${encodeURIComponent(outletId)}/pos/shifts`;

function open(
  who: Member,
  deviceId: string | null,
  body: Record<string, unknown> = {},
) {
  const request = who.client.post(SHIFTS()).set(headers).set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request.send({
    openingFloatIdr: FLOAT_IDR,
    idempotencyKey: randomUUID(),
    ...body,
  });
}

function move(
  who: Member,
  shiftId: string,
  body: Record<string, unknown> = {},
) {
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

function report(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}`)
    .set(headers)
    .set(originHeader);
}

function list(who: Member, query = "") {
  return who.client.get(`${SHIFTS()}${query}`).set(headers).set(originHeader);
}

function listMovements(who: Member, shiftId: string, query = "") {
  return who.client
    .get(`${SHIFTS()}/${shiftId}/cash-movements${query}`)
    .set(headers)
    .set(originHeader);
}

/** Notes and coins that add up to `totalIdr` (a multiple of Rp1.000). */
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

/**
 * An approved `supervisor_pin` override row for closing `shiftId`, written
 * directly (the staff-override service issues a ULID id that the contract's
 * UUID `approvalRequestId` cannot carry; see the gap test below). The row is
 * exactly what an approved PIN decision stores; its id is the approval id.
 */
async function approvalFor(
  cashier: Member,
  shiftId: string,
  overrides: {
    approver?: string;
    objectId?: string;
    action?: string;
    objectType?: string;
  } = {},
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const approver = overrides.approver ?? supervisor.userId;
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'supervisor_pin', 'approved', $5, $6,
               'Hitung kas akhir shift', 0, $7, $8, $9, now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        overrides.action ?? "cash_shift_close",
        cashier.userId,
        approver,
        overrides.objectType ?? "pos_shift",
        overrides.objectId ?? shiftId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    ),
  );
  return { approvedBy: approver, approvalRequestId: id };
}

async function openShift(
  cashier: Cashier,
  openingFloatIdr = FLOAT_IDR,
): Promise<{ id: string; businessDate: string }> {
  const response = await open(cashier, cashier.deviceId, { openingFloatIdr });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; businessDate: string };
}

/** Close with a real approval and a count that equals `countedIdr`. */
async function closeShift(
  cashier: Member,
  shiftId: string,
  countedIdr: number,
  extra: Record<string, unknown> = {},
) {
  const approval = await approvalFor(cashier, shiftId);
  return close(cashier, shiftId, {
    counts: countsFor(countedIdr),
    ...approval,
    ...extra,
  });
}

/**
 * A captured cash sale of `totalIdr` on the shift, plus (optionally) other
 * tenders, written straight into the POS tables with `shift_id` set.
 */
async function seedSale(input: {
  shift: { id: string; businessDate: string };
  cashier: Cashier;
  method?: "cash" | "qris";
  status?: "captured" | "failed";
  totalIdr: number;
}): Promise<void> {
  const orderId = randomUUID();
  const method = input.method ?? "cash";
  const status = input.status ?? "captured";
  const tax = Math.round(input.totalIdr / 11);
  const subtotal = input.totalIdr - tax;
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
        subtotal,
        tax,
        input.totalIdr,
        input.shift.businessDate,
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
        input.shift.id,
        input.cashier.deviceId,
        input.cashier.userId,
      ],
    );
    const cash = method === "cash";
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        method,
        cash ? "manual" : "doit",
        input.totalIdr,
        cash ? input.totalIdr + 5_000 : null,
        cash ? 5_000 : null,
        status,
        input.cashier.userId,
      ],
    );
  });
}

async function outboxNames(shiftId: string): Promise<string[]> {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->'payload'->>'shiftId' = $2
     ORDER BY sequence`,
    [tenant.tenantId, shiftId],
  );
  return rows.map((row) => row.name);
}

async function shiftRow(shiftId: string) {
  const { rows } = await owner.query(
    `SELECT status, counted_idr::int AS counted, expected_idr::int AS expected,
            variance_idr::int AS variance, variance_note, version
     FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, shiftId],
  );
  return rows[0] as
    | {
        status: string;
        counted: number | null;
        expected: number | null;
        variance: number | null;
        variance_note: string | null;
        version: number;
      }
    | undefined;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`shift-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`shift2-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string, string[]][] = [
    [
      roleIds.cashier,
      tenant.tenantId,
      "Kasir Shift Uji",
      ["shift.cash.operate"],
    ],
    [
      roleIds.supervisor,
      tenant.tenantId,
      "Supervisor Shift Uji",
      ["shift.cash.approve_close"],
    ],
    [
      roleIds.viewAll,
      tenant.tenantId,
      "Lihat Semua Shift",
      ["shift.cash.view_all"],
    ],
    [roleIds.none, tenant.tenantId, "Tanpa Shift", ["floor.table.view"]],
  ];
  for (const [id, forTenant, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, forTenant, name, JSON.stringify(permissions)],
    );
  const outsiderRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Semua Shift', false, NULL, $3, false, '["tenant"]')`,
    [
      outsiderRole,
      other.tenantId,
      JSON.stringify([
        "shift.cash.operate",
        "shift.cash.view_all",
        "shift.cash.approve_close",
      ]),
    ],
  );
  supervisor = await member(tenant, roleIds.supervisor, "Supervisor");
  viewAllUser = await member(tenant, roleIds.viewAll, "Lihat Semua");
  noShiftUser = await member(tenant, roleIds.none, "Tanpa Shift");
  outsider = await member(other, outsiderRole, "Orang Luar");
  await setStaffPin(
    tenantContextOf(tenant.tenantId).tenant,
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  // Audit rows and closed shifts are append-only, so the isolated tenants stay
  // in the disposable database; give them a valid creator so the platform
  // tenant list still parses them.
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Open -------------------------------------------------------------------------

describe("POS-03 open a cashier shift", () => {
  it("opens from a registered terminal with the opening float, and records cashier_shift.opened", async () => {
    const cashier = await newCashier();
    const response = await open(cashier, cashier.deviceId, {
      openingFloatIdr: 150_000,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const shift = response.body.data;
    expect(shift).toMatchObject({
      status: "open",
      outletId: tenant.outletId,
      deviceId: cashier.deviceId,
      cashierId: cashier.userId,
      openingFloatIdr: 150_000,
      countedIdr: null,
      expectedIdr: null,
      varianceIdr: null,
      approvedBy: null,
      closedAt: null,
    });
    expect(shift.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(response.headers.location).toContain(shift.id);

    const row = await shiftRow(shift.id);
    expect(row?.status).toBe("open");
    expect(await outboxNames(shift.id)).toEqual(["cashier_shift.opened"]);
    const { rows } = await owner.query(
      `SELECT event->'payload' AS payload FROM domain_event_outbox
       WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.opened'
         AND event->'payload'->>'shiftId' = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(rows[0]?.payload).toMatchObject({
      shiftId: shift.id,
      deviceId: cashier.deviceId,
      cashierId: cashier.userId,
      openingFloatIdr: 150_000,
    });
  });

  it("refuses to open without a verified device token (403) and stores nothing", async () => {
    const cashier = await newCashier();
    const noToken = await open(cashier, null);
    expect(noToken.status).toBe(403);

    const forged = await cashier.client
      .post(SHIFTS())
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, "dv1.forged.token")
      .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
    expect(forged.status).toBe(403);

    // A correctly signed token for a terminal that is not registered at this outlet.
    const unregistered = await open(cashier, randomUUID());
    expect(unregistered.status).toBe(403);

    const { rows } = await owner.query(
      "SELECT 1 FROM pos_shifts WHERE tenant_id = $1 AND cashier_id = $2",
      [tenant.tenantId, cashier.userId],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses staff without shift.cash.operate (403) and anonymous callers (401)", async () => {
    const deviceId = randomUUID();
    registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
    const denied = await open(noShiftUser, deviceId);
    expect(denied.status).toBe(403);
    const anonymous = await agent(app)
      .post(SHIFTS())
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId))
      .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
    expect(anonymous.status).toBe(401);
  });

  it("validates the body strictly: negative float, missing float and extra fields are rejected", async () => {
    const cashier = await newCashier();
    for (const body of [
      { openingFloatIdr: -1 },
      { openingFloatIdr: "abc" },
      { openingFloatIdr: FLOAT_IDR, expectedIdr: 1 },
    ]) {
      const response = await open(cashier, cashier.deviceId, body);
      expect(response.status, JSON.stringify(body)).toBe(VALIDATION_STATUS);
    }
    const missing = await cashier.client
      .post(SHIFTS())
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
      .send({ idempotencyKey: randomUUID() });
    expect(missing.status).toBe(VALIDATION_STATUS);
  });

  it("refuses a second open shift on the same terminal or for the same cashier (409 SHIFT_ALREADY_OPEN)", async () => {
    const first = await newCashier();
    await openShift(first);

    const secondCashierSameDevice = await newCashier();
    const sameDevice = await open(secondCashierSameDevice, first.deviceId);
    expect(sameDevice.status).toBe(409);
    expect(sameDevice.body.error.code).toBe("SHIFT_ALREADY_OPEN");

    const otherDevice = randomUUID();
    registeredDevices.set(`${tenant.tenantId}:${otherDevice}`, tenant.outletId);
    const sameCashier = await open(first, otherDevice);
    expect(sameCashier.status).toBe(409);
    expect(sameCashier.body.error.code).toBe("SHIFT_ALREADY_OPEN");

    const { rows } = await owner.query(
      "SELECT 1 FROM pos_shifts WHERE tenant_id = $1 AND status = 'open' AND (device_id = $2 OR cashier_id = $3)",
      [tenant.tenantId, first.deviceId, first.userId],
    );
    expect(rows).toHaveLength(1);
  });

  it("is idempotent: the same key and body returns the stored shift once; the same key with another body is 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const cashier = await newCashier();
    const idempotencyKey = randomUUID();
    const first = await open(cashier, cashier.deviceId, { idempotencyKey });
    expect(first.status).toBe(201);
    const replay = await open(cashier, cashier.deviceId, { idempotencyKey });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);

    const { rows } = await owner.query(
      "SELECT 1 FROM pos_shifts WHERE tenant_id = $1 AND cashier_id = $2",
      [tenant.tenantId, cashier.userId],
    );
    expect(rows).toHaveLength(1);
    expect(await outboxNames(first.body.data.id)).toEqual([
      "cashier_shift.opened",
    ]);

    const changed = await open(cashier, cashier.deviceId, {
      idempotencyKey,
      openingFloatIdr: FLOAT_IDR + 1_000,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

// ---- Cash movements ---------------------------------------------------------------

describe("POS-03 cash in, cash out and drops", () => {
  it("refuses a cash out or drop larger than the drawer should hold (409), so the shift can still close", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier); // float Rp100.000, no sales
    const tooMuch = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: FLOAT_IDR + 1,
      reasonNote: "Beli gas elpiji",
    });
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(409);
    expect(tooMuch.body.error.code).toBe("CONFLICT");
    const dropTooMuch = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: FLOAT_IDR + 1,
      reasonNote: "Setor ke brankas",
    });
    expect(dropTooMuch.status).toBe(409);
    const exact = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: FLOAT_IDR,
      reasonNote: "Setor ke brankas",
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await outboxNames(shift.id)).toEqual([
      "cashier_shift.opened",
      "cash_movement.recorded",
    ]);
  });

  it("records cash_in, cash_out and drop with a reason, lists them and emits cash_movement.recorded", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const inbound = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: 20_000,
      reasonNote: "Tambah uang kembalian",
    });
    const outbound = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Beli es batu",
    });
    const drop = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: 30_000,
      reasonNote: "Setor ke brankas",
    });
    for (const response of [inbound, outbound, drop])
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(inbound.body.data).toMatchObject({
      shiftId: shift.id,
      type: "cash_in",
      amountIdr: 20_000,
      reasonNote: "Tambah uang kembalian",
      recordedBy: cashier.userId,
      approvedBy: null,
    });

    const listed = await listMovements(cashier, shift.id);
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.map((m: { type: string }) => m.type).sort(),
    ).toEqual(["cash_in", "cash_out", "drop"]);
    const onlyDrops = await listMovements(cashier, shift.id, "?type=drop");
    expect(onlyDrops.body.data).toHaveLength(1);

    const read = await report(viewAllUser, shift.id);
    expect(read.status).toBe(200);
    expect(read.body.data.movements).toHaveLength(3);
    expect(read.body.data.shift).toMatchObject({
      cashInIdr: 20_000,
      cashOutIdr: 10_000,
      cashDropIdr: 30_000,
    });

    const names = await outboxNames(shift.id);
    expect(names.filter((n) => n === "cash_movement.recorded")).toHaveLength(3);
  });

  it("rejects a movement with no reason, a too short reason, zero or negative amount, an unknown type or extra fields (rejected, VALIDATION_ERROR)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    for (const body of [
      { reasonNote: "" },
      { reasonNote: "abc" },
      { amountIdr: 0 },
      { amountIdr: -5_000 },
      { type: "gift" },
      { approvedBy: supervisor.userId },
    ]) {
      const response = await move(cashier, shift.id, body);
      expect(response.status, JSON.stringify(body)).toBe(VALIDATION_STATUS);
    }
    const missingReason = await cashier.client
      .post(`${SHIFTS()}/${shift.id}/cash-movements`)
      .set(headers)
      .set(originHeader)
      .send({
        type: "cash_in",
        amountIdr: 1_000,
        idempotencyKey: randomUUID(),
      });
    expect(missingReason.status).toBe(VALIDATION_STATUS);
    const { rows } = await owner.query(
      "SELECT 1 FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("is idempotent per key: a retry stores one movement, another body under the same key is 409", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const idempotencyKey = randomUUID();
    const first = await move(cashier, shift.id, { idempotencyKey });
    const replay = await move(cashier, shift.id, { idempotencyKey });
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const changed = await move(cashier, shift.id, {
      idempotencyKey,
      amountIdr: 99_000,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const { rows } = await owner.query(
      "SELECT 1 FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses a movement by a cashier other than the shift cashier (403), even a supervisor", async () => {
    const owningCashier = await newCashier();
    const shift = await openShift(owningCashier);
    const intruder = await newCashier("Kasir Lain");
    const denied = await move(intruder, shift.id);
    expect(denied.status).toBe(403);
    const byApprover = await move(supervisor, shift.id);
    expect(byApprover.status).toBe(403);
    const { rows } = await owner.query(
      "SELECT 1 FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a movement on a closed shift (409 SHIFT_NOT_OPEN)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const refused = await move(cashier, shift.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SHIFT_NOT_OPEN");
  });

  it("answers 404 for an unknown shift", async () => {
    const cashier = await newCashier();
    const response = await move(cashier, randomUUID());
    expect(response.status).toBe(404);
  });
});

// ---- Close ------------------------------------------------------------------------

describe("POS-03 close with blind count and supervisor approval", () => {
  it("rejects a body that carries expected, counted or variance (strict, VALIDATION_ERROR) and leaves the shift open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const approval = await approvalFor(cashier, shift.id);
    for (const secret of [
      { expectedIdr: 100_000 },
      { countedIdr: 100_000 },
      { varianceIdr: 0 },
    ]) {
      const response = await close(cashier, shift.id, {
        counts: countsFor(FLOAT_IDR),
        ...approval,
        ...secret,
      });
      expect(response.status, JSON.stringify(secret)).toBe(VALIDATION_STATUS);
    }
    const emptyCounts = await close(cashier, shift.id, {
      counts: [],
      ...approval,
    });
    expect(emptyCounts.status).toBe(VALIDATION_STATUS);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("refuses a count line that is not a Rupiah denomination or repeats one (Q8, VALIDATION_ERROR) and leaves the shift open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const approval = await approvalFor(cashier, shift.id);
    const notListed = await close(cashier, shift.id, {
      counts: [{ denominationIdr: 75_000, quantity: 1 }],
      ...approval,
    });
    expect(notListed.status).toBe(VALIDATION_STATUS);
    expect(notListed.body.error.code).toBe("VALIDATION_ERROR");
    const duplicate = await close(cashier, shift.id, {
      counts: [
        { denominationIdr: 50_000, quantity: 1 },
        { denominationIdr: 50_000, quantity: 2 },
      ],
      ...approval,
    });
    expect(duplicate.status).toBe(VALIDATION_STATUS);
    expect(duplicate.body.error.code).toBe("VALIDATION_ERROR");
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("refuses a missing, unknown, self-issued, foreign-shift or mismatched approval (403) and the shift stays open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const counts = countsFor(FLOAT_IDR);

    // No approval fields at all: contract validation.
    const none = await close(cashier, shift.id, { counts });
    expect(none.status).toBe(VALIDATION_STATUS);

    // An approval id nobody issued.
    const invalid = await close(cashier, shift.id, {
      counts,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(invalid.status).toBe(403);

    // The cashier names themself as the approver.
    const real = await approvalFor(cashier, shift.id);
    const self = await close(cashier, shift.id, {
      counts,
      approvedBy: cashier.userId,
      approvalRequestId: real.approvalRequestId,
    });
    expect(self.status).toBe(403);

    // A real approval, but the body names another person as approver.
    const mismatched = await close(cashier, shift.id, {
      counts,
      approvedBy: viewAllUser.userId,
      approvalRequestId: real.approvalRequestId,
    });
    expect(mismatched.status).toBe(403);

    // An approval issued for another shift.
    const otherCashier = await newCashier("Kasir B");
    const otherShift = await openShift(otherCashier);
    const foreign = await approvalFor(cashier, otherShift.id);
    const wrongShift = await close(cashier, shift.id, { counts, ...foreign });
    expect(wrongShift.status).toBe(403);

    // An approval issued for another action (a void) on this object.
    const wrongAction = await approvalFor(cashier, shift.id, {
      action: "void",
      objectType: "order",
    });
    const refusedAction = await close(cashier, shift.id, {
      counts,
      ...wrongAction,
    });
    expect(refusedAction.status).toBe(403);

    expect((await shiftRow(shift.id))?.status).toBe("open");
    expect(await outboxNames(shift.id)).toEqual(["cashier_shift.opened"]);
  });

  it("refuses to close a shift of another cashier (403)", async () => {
    const owningCashier = await newCashier();
    const shift = await openShift(owningCashier);
    const intruder = await newCashier("Kasir Lain");
    const approval = await approvalFor(owningCashier, shift.id);
    const denied = await close(intruder, shift.id, {
      counts: countsFor(FLOAT_IDR),
      ...approval,
    });
    expect(denied.status).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("a cash difference needs a written note (422 SHIFT_VARIANCE_NOTE_REQUIRED); the refused attempt does not burn the approval", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const approval = await approvalFor(cashier, shift.id);
    const counts = countsFor(FLOAT_IDR - 5_000);
    const missingNote = await close(cashier, shift.id, { counts, ...approval });
    expect(missingNote.status).toBe(422);
    expect(missingNote.body.error.code).toBe("SHIFT_VARIANCE_NOTE_REQUIRED");
    const shortNote = await close(cashier, shift.id, {
      counts,
      ...approval,
      varianceNote: "abc",
    });
    expect(shortNote.status).toBe(VALIDATION_STATUS);
    expect((await shiftRow(shift.id))?.status).toBe("open");

    const ok = await close(cashier, shift.id, {
      counts,
      ...approval,
      varianceNote: "Uang kembalian terselip, kurang Rp5.000",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: "closed",
      expectedIdr: FLOAT_IDR,
      countedIdr: FLOAT_IDR - 5_000,
      varianceIdr: -5_000,
      varianceNote: "Uang kembalian terselip, kurang Rp5.000",
    });
  });

  it.each([
    { label: "short", counted: 95_000, variance: -5_000 },
    { label: "over", counted: 105_000, variance: 5_000 },
  ])(
    "a drawer $label by Rp5.000 closes with the signed variance and the note",
    async ({ counted, variance }) => {
      const cashier = await newCashier();
      const shift = await openShift(cashier);
      const response = await closeShift(cashier, shift.id, counted, {
        varianceNote: "Selisih dihitung ulang dua kali",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toMatchObject({
        status: "closed",
        countedIdr: counted,
        expectedIdr: FLOAT_IDR,
        varianceIdr: variance,
        approvedBy: supervisor.userId,
      });
      const names = await outboxNames(shift.id);
      expect(names).toContain("cashier_shift.closed");
      const { rows } = await owner.query(
        `SELECT event->'payload' AS payload FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
           AND event->'payload'->>'shiftId' = $2`,
        [tenant.tenantId, shift.id],
      );
      expect(rows[0]?.payload).toMatchObject({
        differenceIdr: variance,
        countedIdr: counted,
        expectedIdr: FLOAT_IDR,
      });
    },
  );

  it("POS-03 blind count: the shift's own cashier sees cash aggregates as 0 on an open shift in the report, the list and an open replay; another user with view_all sees them", async () => {
    const cashier = await newCashier();
    const idempotencyKey = randomUUID();
    const opened = await open(cashier, cashier.deviceId, { idempotencyKey });
    expect(opened.status).toBe(201);
    const shift = opened.body.data;
    await seedSale({ shift, cashier, totalIdr: 55_000 });
    await move(cashier, shift.id, { type: "cash_in", amountIdr: 20_000 });
    await move(cashier, shift.id, {
      type: "drop",
      amountIdr: 30_000,
      reasonNote: "Setor ke brankas",
    });
    const zeros = {
      cashSalesIdr: 0,
      cashRefundsIdr: 0,
      cashInIdr: 0,
      cashOutIdr: 0,
      cashDropIdr: 0,
      expectedIdr: null,
      countedIdr: null,
      varianceIdr: null,
    };

    const ownReport = await report(cashier, shift.id);
    expect(ownReport.body.data.shift).toMatchObject(zeros);
    const ownList = await list(cashier, `?deviceId=${cashier.deviceId}`);
    expect(ownList.body.data).toHaveLength(1);
    expect(ownList.body.data[0]).toMatchObject({ id: shift.id, ...zeros });
    const replay = await open(cashier, cashier.deviceId, { idempotencyKey });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data).toMatchObject({ id: shift.id, ...zeros });

    for (const viewer of [viewAllUser, supervisor]) {
      const seen = await report(viewer, shift.id);
      expect(seen.body.data.shift).toMatchObject({
        cashSalesIdr: 55_000,
        cashInIdr: 20_000,
        cashDropIdr: 30_000,
      });
      const seenList = await list(viewer, `?deviceId=${cashier.deviceId}`);
      expect(seenList.body.data[0]).toMatchObject({ cashSalesIdr: 55_000 });
    }
  });

  it("cash goes to the drawer of the cashier who took it: a tab submitted in another shift and paid here counts here, not there", async () => {
    const first = await newCashier("Kasir pagi");
    const second = await newCashier("Kasir sore");
    const morning = await openShift(first);
    const evening = await openShift(second);
    // The order was submitted in the morning shift but the evening cashier
    // took the cash.
    await seedSale({ shift: morning, cashier: second, totalIdr: 40_000 });
    const here = await report(viewAllUser, evening.id);
    expect(here.status).toBe(200);
    expect(here.body.data.shift.cashSalesIdr).toBe(40_000);
    const there = await report(viewAllUser, morning.id);
    expect(there.body.data.shift.cashSalesIdr).toBe(0);
  });

  it("closes a shift: expected = float + cash sales + in − out − drops, counted from the blind count, variance = counted − expected", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier, FLOAT_IDR);
    // Cash sale counts; a QRIS sale and a failed cash tender do not.
    await seedSale({ shift, cashier, totalIdr: 55_000 });
    await seedSale({ shift, cashier, method: "qris", totalIdr: 40_000 });
    await seedSale({ shift, cashier, status: "failed", totalIdr: 7_000 });
    await move(cashier, shift.id, { type: "cash_in", amountIdr: 20_000 });
    await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Beli es batu",
    });
    await move(cashier, shift.id, {
      type: "drop",
      amountIdr: 30_000,
      reasonNote: "Setor ke brankas",
    });

    // Blind count (POS-03): the shift's own cashier sees no cash figure on an
    // open shift; a supervisor or a view_all user sees the live aggregates.
    // Neither sees expected / counted / variance before the close.
    const live = await report(viewAllUser, shift.id);
    expect(live.status).toBe(200);
    expect(live.body.data.shift).toMatchObject({
      status: "open",
      cashSalesIdr: 55_000,
      cashInIdr: 20_000,
      cashOutIdr: 10_000,
      cashDropIdr: 30_000,
      expectedIdr: null,
      countedIdr: null,
      varianceIdr: null,
    });
    const liveForSupervisor = await report(supervisor, shift.id);
    expect(liveForSupervisor.body.data.shift.cashSalesIdr).toBe(55_000);
    expect(live.body.data.receiptGaps).toEqual([]);
    const blind = await report(cashier, shift.id);
    expect(blind.status).toBe(200);
    expect(blind.body.data.shift).toMatchObject({
      status: "open",
      cashSalesIdr: 0,
      cashRefundsIdr: 0,
      cashInIdr: 0,
      cashOutIdr: 0,
      cashDropIdr: 0,
      expectedIdr: null,
      countedIdr: null,
      varianceIdr: null,
    });

    // Float 100.000 + sales 55.000 + in 20.000 − out 10.000 − drop 30.000.
    const expected = 135_000;
    const counts = [
      { denominationIdr: 100_000, quantity: 1 },
      { denominationIdr: 20_000, quantity: 1 },
      { denominationIdr: 10_000, quantity: 1 },
      { denominationIdr: 5_000, quantity: 1 },
    ];
    const approval = await approvalFor(cashier, shift.id);
    const idempotencyKey = randomUUID();
    const body = { counts, ...approval, idempotencyKey };
    const response = await close(cashier, shift.id, body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      id: shift.id,
      status: "closed",
      openingFloatIdr: FLOAT_IDR,
      cashSalesIdr: 55_000,
      cashRefundsIdr: 0,
      cashInIdr: 20_000,
      cashOutIdr: 10_000,
      cashDropIdr: 30_000,
      expectedIdr: expected,
      countedIdr: expected,
      varianceIdr: 0,
      approvedBy: supervisor.userId,
      approvalRequestId: approval.approvalRequestId,
    });
    expect(response.body.data.closedAt).toEqual(expect.any(String));
    expect(response.body.data.approvedAt).toEqual(expect.any(String));

    const row = await shiftRow(shift.id);
    expect(row).toMatchObject({
      status: "closed",
      counted: expected,
      expected,
      variance: 0,
    });
    const names = await outboxNames(shift.id);
    expect(names.filter((n) => n === "cashier_shift.closed")).toHaveLength(1);

    // The closed shift reads back with the same locked figures and movements.
    const after = await report(cashier, shift.id);
    expect(after.body.data.shift).toMatchObject({
      status: "closed",
      expectedIdr: expected,
      countedIdr: expected,
      varianceIdr: 0,
    });
    expect(after.body.data.movements).toHaveLength(3);

    // The same request replayed returns the stored close; no second event.
    const replay = await close(cashier, shift.id, body);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data).toMatchObject({
      id: shift.id,
      countedIdr: expected,
      varianceIdr: 0,
    });
    expect(
      (await outboxNames(shift.id)).filter((n) => n === "cashier_shift.closed"),
    ).toHaveLength(1);
    // Same key, another count: refused, never applied.
    const tampered = await close(cashier, shift.id, {
      ...body,
      counts: countsFor(expected + 50_000),
    });
    expect(tampered.status).toBe(409);
    expect(tampered.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await shiftRow(shift.id))?.counted).toBe(expected);
  });

  it("a second close of a closed shift is 409 SHIFT_ALREADY_CLOSED and changes nothing", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const first = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await closeShift(cashier, shift.id, FLOAT_IDR + 20_000, {
      varianceNote: "Mencoba mengubah hitungan",
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("SHIFT_ALREADY_CLOSED");
    expect(await shiftRow(shift.id)).toMatchObject({
      counted: FLOAT_IDR,
      variance: 0,
    });
  });

  it("an approval is used once: a closed shift's approval cannot close the cashier's next shift (403)", async () => {
    const cashier = await newCashier();
    const first = await openShift(cashier);
    const approval = await approvalFor(cashier, first.id);
    const closed = await close(cashier, first.id, {
      counts: countsFor(FLOAT_IDR),
      ...approval,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const next = await openShift(cashier);
    expect(next.id).not.toBe(first.id);
    const reused = await close(cashier, next.id, {
      counts: countsFor(FLOAT_IDR),
      ...approval,
    });
    expect(reused.status).toBe(403);
    expect((await shiftRow(next.id))?.status).toBe("open");
  });

  it("a supervisor PIN approval made through the staff-override service can close the shift (fresh request id, bound by the PIN fallback)", async () => {
    // Spec §3.10: the supervisor approves through the existing staff-override
    // service (PIN on the device). The close body types `approvalRequestId` as
    // a UUID, but a PIN override's id is a ULID that is not an RFC UUID, so the
    // cashier has nothing valid to send. This test fails until the contract or
    // the service resolves that.
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const { override } = await createPosOverride(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      cashier.userId,
      {
        outletId: tenant.outletId,
        action: "cash_shift_close",
        valueIdr: 0,
        reason: "Hitung kas akhir shift",
        objectType: "pos_shift",
        objectId: shift.id,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(supervisor.userId),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");
    const response = await close(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
      approvedBy: supervisor.userId,
      // Contract gap shared with pos-order consumeApproval: a PIN override has
      // no approval request and its ULID id rarely parses as an RFC UUID, so
      // the device sends a fresh request id and the API binds the newest PIN
      // override for this very shift, cashier and approver.
      approvalRequestId: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("closed");
  });

  it("answers 404 when closing an unknown shift", async () => {
    const cashier = await newCashier();
    const response = await close(cashier, randomUUID(), {
      counts: countsFor(FLOAT_IDR),
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(response.status).toBe(404);
  });
});

// ---- Locked after close (database backstop) ----------------------------------------

describe("POS-03 a closed shift and its cash movements cannot be changed", () => {
  it("refuses direct SQL UPDATE and DELETE of a closed shift, even by the database owner", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await move(cashier, shift.id);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR + 20_000);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    for (const statement of [
      "UPDATE pos_shifts SET counted_idr = counted_idr + 1 WHERE tenant_id = $1 AND id = $2",
      "UPDATE pos_shifts SET variance_idr = 0, variance_note = NULL WHERE tenant_id = $1 AND id = $2",
      "UPDATE pos_shifts SET status = 'open' WHERE tenant_id = $1 AND id = $2",
      "DELETE FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    ])
      await expect(
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(statement, [tenant.tenantId, shift.id]),
        ),
        statement,
      ).rejects.toThrow(/POS-03/);

    expect(await shiftRow(shift.id)).toMatchObject({
      status: "closed",
      counted: FLOAT_IDR + 20_000,
      variance: 0,
    });
  });

  it("refuses UPDATE and DELETE of a cash movement and an insert onto a closed shift", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const moved = await move(cashier, shift.id);
    expect(moved.status).toBe(201);
    const movementId = moved.body.data.id as string;

    for (const statement of [
      "UPDATE cash_movements SET amount_idr = 1 WHERE tenant_id = $1 AND id = $2",
      "DELETE FROM cash_movements WHERE tenant_id = $1 AND id = $2",
    ])
      await expect(
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(statement, [tenant.tenantId, movementId]),
        ),
        statement,
      ).rejects.toThrow(/POS-03/);

    const closed = await closeShift(cashier, shift.id, FLOAT_IDR + 20_000);
    expect(closed.status).toBe(200);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `INSERT INTO cash_movements
             (tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
              recorded_at, idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, 'cash_out', 5000, 'Keluar diam-diam', $4, now(), $5, $6)`,
          [
            tenant.tenantId,
            tenant.outletId,
            shift.id,
            cashier.userId,
            randomUUID(),
            "a".repeat(64),
          ],
        ),
      ),
    ).rejects.toThrow(/POS-03/);
  });

  it("an open shift keeps its identity and opening float even against direct SQL", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE pos_shifts SET opening_float_idr = 1 WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, shift.id],
        ),
      ),
    ).rejects.toThrow(/POS-03/);
  });
});

// ---- Reads ------------------------------------------------------------------------

describe("POS-03 who can read a shift", () => {
  it("a cashier with only shift.cash.operate reads their own shift but not another cashier's (403)", async () => {
    const a = await newCashier("Kasir A");
    const b = await newCashier("Kasir B");
    const shiftA = await openShift(a);
    const own = await report(a, shiftA.id);
    expect(own.status).toBe(200);
    expect(own.body.data.shift.id).toBe(shiftA.id);
    expect(own.body.data.movements).toEqual([]);
    expect(own.body.data.receiptGaps).toEqual([]);

    const foreign = await report(b, shiftA.id);
    expect(foreign.status).toBe(403);
    const foreignMovements = await listMovements(b, shiftA.id);
    expect(foreignMovements.status).toBe(403);
  });

  it("view_all and approve_close can read any shift of the outlet; staff without either cannot", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    expect((await report(viewAllUser, shift.id)).status).toBe(200);
    expect((await report(supervisor, shift.id)).status).toBe(200);
    expect((await listMovements(viewAllUser, shift.id)).status).toBe(200);
    expect((await report(noShiftUser, shift.id)).status).toBe(403);
    const anonymous = await agent(app)
      .get(`${SHIFTS()}/${shift.id}`)
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
    expect((await report(cashier, randomUUID())).status).toBe(404);
  });

  it("lists only the caller's own shifts for an operate-only cashier, all shifts for view_all, with filters, paging and an empty state", async () => {
    const a = await newCashier("Kasir A");
    const b = await newCashier("Kasir B");
    const shiftA = await openShift(a);
    const shiftB = await openShift(b);

    const mine = await list(a);
    expect(mine.status).toBe(200);
    const mineIds = mine.body.data.map((s: { id: string }) => s.id);
    expect(mineIds).toContain(shiftA.id);
    expect(mineIds).not.toContain(shiftB.id);
    for (const s of mine.body.data) expect(s.cashierId).toBe(a.userId);

    const all = await list(viewAllUser, "?limit=100");
    const allIds = all.body.data.map((s: { id: string }) => s.id);
    expect(allIds).toEqual(expect.arrayContaining([shiftA.id, shiftB.id]));

    const byDevice = await list(viewAllUser, `?deviceId=${b.deviceId}`);
    expect(byDevice.body.data.map((s: { id: string }) => s.id)).toEqual([
      shiftB.id,
    ]);

    const byDate = await list(
      viewAllUser,
      `?businessDate=${shiftA.businessDate}&deviceId=${a.deviceId}`,
    );
    expect(byDate.body.data).toHaveLength(1);

    // Empty state: a date nobody opened a shift on.
    const none = await list(viewAllUser, "?businessDate=2001-01-01");
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
    expect(none.body.meta.nextCursor).toBeNull();

    // Paging: one row per page and an opaque cursor to the next.
    const page = await list(viewAllUser, "?limit=1");
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.nextCursor).toEqual(expect.any(String));
    const next = await list(
      viewAllUser,
      `?limit=1&cursor=${encodeURIComponent(page.body.meta.nextCursor)}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.data[0].id).not.toBe(page.body.data[0].id);

    const denied = await list(noShiftUser);
    expect(denied.status).toBe(403);
    const invalid = await list(viewAllUser, "?businessDate=not-a-date");
    expect(invalid.status).toBe(VALIDATION_STATUS);
  });
});

// ---- TEN-01 -----------------------------------------------------------------------

describe("TEN-01 shifts are isolated per tenant", () => {
  it("another tenant's staff, even with every shift permission, cannot read or close the shift through the API", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await move(cashier, shift.id);
    const approval = await approvalFor(cashier, shift.id);
    const counts = countsFor(FLOAT_IDR + 20_000);
    const send = (path: string, method: "get" | "post", body?: object) => {
      // Once on the other tenant's host, once on this tenant's host.
      return Promise.all(
        [other.hostname, tenant.hostname].map((host) => {
          const request = outsider.client[method](`${SHIFTS()}${path}`)
            .set({ Host: host })
            .set(originHeader);
          return body ? request.send(body) : request;
        }),
      );
    };

    for (const response of [
      ...(await send(`/${shift.id}`, "get")),
      ...(await send(`/${shift.id}/cash-movements`, "get")),
      ...(await send("", "get")),
      ...(await send(`/${shift.id}/cash-movements`, "post", {
        type: "cash_out",
        amountIdr: 5_000,
        reasonNote: "Mengambil uang",
        idempotencyKey: randomUUID(),
      })),
      ...(await send(`/${shift.id}/close`, "post", {
        counts,
        ...approval,
        idempotencyKey: randomUUID(),
      })),
    ])
      expect([403, 404], JSON.stringify(response.body)).toContain(
        response.status,
      );

    // The other tenant's own outlet id with this shift id is not found either.
    const ownOutlet = await outsider.client
      .get(`${SHIFTS(other.outletId)}/${shift.id}`)
      .set({ Host: other.hostname })
      .set(originHeader);
    expect([403, 404]).toContain(ownOutlet.status);

    expect(await shiftRow(shift.id)).toMatchObject({ status: "open" });
    const { rows } = await owner.query(
      "SELECT 1 FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("the shift service refuses a context of another tenant", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await expect(
      getPosShiftReport(
        tenantContextOf(other.tenantId),
        { userId: userIdSchema.parse(outsider.userId), deviceId: null },
        outletIdSchema.parse(tenant.outletId),
        shift.id,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
    await expect(
      getPosShiftReport(
        tenantContextOf(seededTenantId),
        { userId: userIdSchema.parse(supervisor.userId), deviceId: null },
        outletIdSchema.parse(tenant.outletId),
        shift.id,
      ),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
  });

  it("RLS hides shifts and cash movements from another tenant and from another outlet", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await move(cashier, shift.id);

    const count = async (
      tenantId: string,
      outletIds: string,
      table: string,
    ): Promise<string | undefined> => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_app");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
          [tenantId, outletIds],
        );
        const column = table === "pos_shifts" ? "id" : "shift_id";
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1::uuid`,
          [shift.id],
        );
        return rows[0]?.count;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };

    for (const table of ["pos_shifts", "cash_movements"]) {
      // Control: the owning tenant sees the row, so the zeroes below mean something.
      expect(await count(tenant.tenantId, "*", table), table).toBe("1");
      expect(await count(seededTenantId, "*", table), table).toBe("0");
      expect(await count(other.tenantId, "*", table), table).toBe("0");
      expect(
        await count(tenant.tenantId, JSON.stringify([randomUUID()]), table),
        table,
      ).toBe("0");
    }
  });
});
