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
//  - Round 2 (findings 3 and 4): the cashier first submits a blind count
//    (POST .../shifts/:id/counts, stored append-only), the supervisor approves
//    that count, and the close names it (`countId`). The approval is bound to
//    the count and to |variance| of that count.
//  - A supervisor approval is an approved `supervisor_pin` pos_overrides row
//    (action `cash_shift_close`, objectType `pos_shift_count`, objectId = count
//    id, requested_by = cashier, value_idr = |variance| of the count, as the
//    staff-override service stores it) inserted directly with a UUID id; the
//    close body sends `approvedBy` + `approvalRequestId` = that id. Some tests
//    go through the real staff-override service (ULID id, PIN fallback).
//  - The approval matrix (§3.7) is exercised with `approval_policies` rows for
//    `cash_shift_close` inserted as the owner and removed in the same test.
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
  ulidToUuid,
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
import {
  posShiftCountReceiptSchema,
  posShiftCountSchema,
} from "@starter/shared/pos";
import { getPosShiftReport } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
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
    issuedAt: Math.floor(Date.now() / 1000),
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

/** POST a blind count submission (round 2: the close names its id). */
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

/** GET the count trail of a shift (supervisors only). */
function listCounts(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}/counts`)
    .set(headers)
    .set(originHeader);
}

type CountReceipt = {
  id: string;
  shiftId: string;
  sequence: number;
  countedIdr: number;
  noteRequired: boolean;
  submittedAt: string;
};

/** The cashier counts the drawer blind; the notes add up to `countedIdr`. */
async function countDrawer(
  cashier: Member,
  shiftId: string,
  countedIdr: number,
): Promise<CountReceipt> {
  const response = await submitCount(cashier, shiftId, {
    counts: countsFor(countedIdr),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(response.body.data) as CountReceipt;
}

/** The stored count submission, read as the database owner. */
async function countRow(countId: string) {
  const { rows } = await owner.query<{
    sequence: number;
    counted: number;
    expected: number;
    variance: number;
  }>(
    `SELECT sequence, counted_idr::int AS counted, expected_idr::int AS expected,
            variance_idr::int AS variance
     FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, countId],
  );
  return rows[0];
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
 * An approved `supervisor_pin` override row for closing with the count
 * submission `countId`, written directly (the staff-override service issues a
 * ULID id that the contract's UUID `approvalRequestId` rarely carries). The
 * row is exactly what an approved PIN decision stores: it names the count and
 * is worth |variance| of that count (the service ignores the device's value
 * for `cash_shift_close`). `valueIdr` forges another value.
 */
async function approvalFor(
  cashier: Member,
  countId: string,
  overrides: {
    approver?: string;
    objectId?: string;
    action?: string;
    objectType?: string;
    valueIdr?: number;
  } = {},
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const approver = overrides.approver ?? supervisor.userId;
  const id = randomUUID();
  const valueIdr =
    overrides.valueIdr ?? Math.abs((await countRow(countId))?.variance ?? 0);
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'supervisor_pin', 'approved', $5, $6,
               'Hitung kas akhir shift', $10, $7, $8, $9, now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        overrides.action ?? "cash_shift_close",
        cashier.userId,
        approver,
        overrides.objectType ?? "pos_shift_count",
        overrides.objectId ?? countId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
        valueIdr,
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

/** Count `countedIdr`, approve that count, and close with it. */
async function closeShift(
  cashier: Member,
  shiftId: string,
  countedIdr: number,
  extra: Record<string, unknown> = {},
) {
  const count = await countDrawer(cashier, shiftId, countedIdr);
  const approval = await approvalFor(cashier, count.id);
  return close(cashier, shiftId, { countId: count.id, ...approval, ...extra });
}

/**
 * A captured cash sale of `totalIdr` on the shift, plus (optionally) other
 * tenders, written straight into the POS tables with `shift_id` set.
 */
async function seedSale(input: {
  shift: { id: string; businessDate: string };
  /** The shift whose drawer took the cash (default: the order's shift). */
  drawer?: { id: string };
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
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10, $11)`,
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
        // Review K: cash is counted by the drawer (shift_id), not by time.
        cash ? (input.drawer ?? input.shift).id : null,
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
    // Review K: the refusal never reveals the drawer (or any amount).
    expect(tooMuch.body.error.message).toBe(
      "Kas keluar ini perlu persetujuan supervisor.",
    );
    const dropTooMuch = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: FLOAT_IDR + 1,
      reasonNote: "Setor ke brankas",
    });
    expect(dropTooMuch.status).toBe(409);
    // Two refusals used up the shift's allowance (review K round 2): even an
    // exact fit is refused now. A fresh shift takes the exact amount.
    const afterTwo = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: FLOAT_IDR,
      reasonNote: "Setor ke brankas",
    });
    expect(afterTwo.status, JSON.stringify(afterTwo.body)).toBe(409);
    const fresh = await newCashier("Kasir Pas");
    const freshShift = await openShift(fresh);
    const exact = await move(fresh, freshShift.id, {
      type: "drop",
      amountIdr: FLOAT_IDR,
      reasonNote: "Setor ke brankas",
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await outboxNames(freshShift.id)).toEqual([
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

  it("trims the reason before the length check: spaces alone are VALIDATION_ERROR and a padded reason is stored trimmed (legend-vor4)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    for (const reasonNote of ["      ", "  ab  ", "\t\n  abc \n"]) {
      const refused = await move(cashier, shift.id, { reasonNote });
      expect(refused.status, JSON.stringify(reasonNote)).toBe(
        VALIDATION_STATUS,
      );
    }
    const padded = await move(cashier, shift.id, {
      reasonNote: "   Beli gas elpiji  ",
    });
    expect(padded.status, JSON.stringify(padded.body)).toBe(201);
    expect(padded.body.data.reasonNote).toBe("Beli gas elpiji");
    const { rows } = await owner.query<{ reason_note: string }>(
      "SELECT reason_note FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows.map((row) => row.reason_note)).toEqual(["Beli gas elpiji"]);
  });

  it("the database backstops a whitespace-only reason with btrim (legend-vor4)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const insert = owner.query(
      `INSERT INTO cash_movements
         (tenant_id, outlet_id, shift_id, type, amount_idr, reason_note,
          recorded_by, recorded_at, idempotency_key, request_fingerprint)
       SELECT tenant_id, outlet_id, id, 'cash_in', 1000, '      ',
              cashier_id, now(), $3, repeat('a', 64)
         FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, shift.id, randomUUID()],
    );
    await expect(insert).rejects.toThrow(/cash_movements_reason_check/);
  });

  it("refuses a cash in that would push the drawer figures past the safe integer, before it is stored (legend-1hza)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier); // float Rp100.000
    const overflow = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: Number.MAX_SAFE_INTEGER - FLOAT_IDR + 1,
    });
    // The service refuses (CoreError VALIDATION_ERROR = 400), not the schema.
    expect(overflow.status, JSON.stringify(overflow.body)).toBe(400);
    expect(overflow.body.error.code).toBe("VALIDATION_ERROR");
    const { rows } = await owner.query(
      "SELECT 1 FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(0);
    // The exact bound is still allowed, and the shift can still be counted,
    // but one more rupiah is not.
    const exact = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: Number.MAX_SAFE_INTEGER - FLOAT_IDR,
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    const over = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: 1,
    });
    expect(over.status, JSON.stringify(over.body)).toBe(400);
    const counted = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
  });

  it("answers a retried refused cash out with the same refusal and counts it once toward the 2-refusal limit (legend-uw47)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const key = randomUUID();
    const body = {
      type: "cash_out",
      amountIdr: FLOAT_IDR + 1,
      reasonNote: "Beli gas elpiji",
      idempotencyKey: key,
    };
    const first = await move(cashier, shift.id, body);
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await move(cashier, shift.id, body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(409);
      expect(retry.body.error.code).toBe(first.body.error.code);
      expect(retry.body.error.message).toBe(first.body.error.message);
    }
    const audit = () =>
      owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'pos_shift.cash_movement_refused'
            AND event->>'objectId' = $2`,
        [tenant.tenantId, shift.id],
      );
    expect((await audit()).rows[0]?.n).toBe(1);
    // The same key with another payload keeps the conflict behaviour.
    const changed = await move(cashier, shift.id, {
      ...body,
      amountIdr: FLOAT_IDR + 2,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // One unique refusal so far: a cash out that fits is still recorded.
    const fits = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Beli gas elpiji",
    });
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    // A second unique refusal uses up the allowance; the third attempt is
    // refused whatever the amount.
    const second = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: FLOAT_IDR + 5,
      reasonNote: "Beli gas elpiji",
    });
    expect(second.status).toBe(409);
    expect((await audit()).rows[0]?.n).toBe(2);
    const blocked = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 1_000,
      reasonNote: "Beli gas elpiji",
    });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
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
  it("rejects a count or close body that carries expected, counted or variance (strict, VALIDATION_ERROR) and leaves the shift open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    for (const secret of [
      { expectedIdr: 100_000 },
      { countedIdr: 100_000 },
      { varianceIdr: 0 },
    ]) {
      const response = await submitCount(cashier, shift.id, {
        counts: countsFor(FLOAT_IDR),
        ...secret,
      });
      expect(response.status, JSON.stringify(secret)).toBe(VALIDATION_STATUS);
    }
    const emptyCounts = await submitCount(cashier, shift.id, { counts: [] });
    expect(emptyCounts.status).toBe(VALIDATION_STATUS);

    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const approval = await approvalFor(cashier, count.id);
    for (const secret of [
      { expectedIdr: 100_000 },
      { countedIdr: 100_000 },
      { varianceIdr: 0 },
      // Round 2: the close names a stored count; it no longer takes one.
      { counts: countsFor(FLOAT_IDR) },
    ]) {
      const response = await close(cashier, shift.id, {
        countId: count.id,
        ...approval,
        ...secret,
      });
      expect(response.status, JSON.stringify(secret)).toBe(VALIDATION_STATUS);
    }
    const noCount = await close(cashier, shift.id, { ...approval });
    expect(noCount.status).toBe(VALIDATION_STATUS);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("refuses a count line that is not a Rupiah denomination or repeats one (Q8, VALIDATION_ERROR) and stores no count", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const notListed = await submitCount(cashier, shift.id, {
      counts: [{ denominationIdr: 75_000, quantity: 1 }],
    });
    expect(notListed.status).toBe(VALIDATION_STATUS);
    expect(notListed.body.error.code).toBe("VALIDATION_ERROR");
    const duplicate = await submitCount(cashier, shift.id, {
      counts: [
        { denominationIdr: 50_000, quantity: 1 },
        { denominationIdr: 50_000, quantity: 2 },
      ],
    });
    expect(duplicate.status).toBe(VALIDATION_STATUS);
    expect(duplicate.body.error.code).toBe("VALIDATION_ERROR");
    expect((await shiftRow(shift.id))?.status).toBe("open");
    const { rows } = await owner.query(
      "SELECT 1 FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a missing, unknown, self-issued, foreign-shift or mismatched approval (403) and the shift stays open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const countId = count.id;

    // No approval fields at all: contract validation.
    const none = await close(cashier, shift.id, { countId });
    expect(none.status).toBe(VALIDATION_STATUS);

    // An approval id nobody issued.
    const invalid = await close(cashier, shift.id, {
      countId,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(invalid.status).toBe(403);

    // The cashier names themself as the approver.
    const real = await approvalFor(cashier, countId);
    const self = await close(cashier, shift.id, {
      countId,
      approvedBy: cashier.userId,
      approvalRequestId: real.approvalRequestId,
    });
    expect(self.status).toBe(403);

    // A real approval, but the body names another person as approver.
    const mismatched = await close(cashier, shift.id, {
      countId,
      approvedBy: viewAllUser.userId,
      approvalRequestId: real.approvalRequestId,
    });
    expect(mismatched.status).toBe(403);

    // An approval issued for another shift's count.
    const otherCashier = await newCashier("Kasir B");
    const otherShift = await openShift(otherCashier);
    const otherCount = await countDrawer(
      otherCashier,
      otherShift.id,
      FLOAT_IDR,
    );
    const foreign = await approvalFor(cashier, otherCount.id);
    const wrongShift = await close(cashier, shift.id, { countId, ...foreign });
    expect(wrongShift.status).toBe(403);

    // An approval issued for another action (a void) on this object.
    const wrongAction = await approvalFor(cashier, countId, {
      action: "void",
      objectType: "order",
    });
    const refusedAction = await close(cashier, shift.id, {
      countId,
      ...wrongAction,
    });
    expect(refusedAction.status).toBe(403);

    // A pre-round-2 approval that names the shift instead of the count.
    const wholeShift = await approvalFor(cashier, countId, {
      objectType: "pos_shift",
      objectId: shift.id,
    });
    const refusedShift = await close(cashier, shift.id, {
      countId,
      ...wholeShift,
    });
    expect(refusedShift.status).toBe(403);

    expect((await shiftRow(shift.id))?.status).toBe("open");
    expect(await outboxNames(shift.id)).toEqual(["cashier_shift.opened"]);
  });

  it("refuses a count or a close by a cashier other than the shift cashier (403)", async () => {
    const owningCashier = await newCashier();
    const shift = await openShift(owningCashier);
    const intruder = await newCashier("Kasir Lain");
    const foreignCount = await submitCount(intruder, shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(foreignCount.status).toBe(403);
    // Review K: a supervisor holding approve_close submits a forced count
    // (step one of a force close); the cashier then simply counts again below.
    const bySupervisor = await submitCount(supervisor, shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(bySupervisor.status, JSON.stringify(bySupervisor.body)).toBe(201);

    const count = await countDrawer(owningCashier, shift.id, FLOAT_IDR);
    const approval = await approvalFor(owningCashier, count.id);
    const denied = await close(intruder, shift.id, {
      countId: count.id,
      ...approval,
    });
    expect(denied.status).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("a cash difference needs a written note (422 SHIFT_VARIANCE_NOTE_REQUIRED); the refused attempt keeps the count on the trail and does not burn the approval", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    // The receipt says a note is needed, without saying how much is missing.
    expect(count.noteRequired).toBe(true);
    const approval = await approvalFor(cashier, count.id);
    const missingNote = await close(cashier, shift.id, {
      countId: count.id,
      ...approval,
    });
    expect(missingNote.status).toBe(422);
    expect(missingNote.body.error.code).toBe("SHIFT_VARIANCE_NOTE_REQUIRED");
    const shortNote = await close(cashier, shift.id, {
      countId: count.id,
      ...approval,
      varianceNote: "abc",
    });
    expect(shortNote.status).toBe(VALIDATION_STATUS);
    expect((await shiftRow(shift.id))?.status).toBe("open");

    // Finding 4: the submission is not discarded with the refused close.
    const trail = await listCounts(supervisor, shift.id);
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    expect(trail.body.data).toHaveLength(1);
    expect(trail.body.data[0]).toMatchObject({
      id: count.id,
      sequence: 1,
      countedIdr: FLOAT_IDR - 5_000,
      expectedIdr: FLOAT_IDR,
      varianceIdr: -5_000,
    });

    const ok = await close(cashier, shift.id, {
      countId: count.id,
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
      countId: count.id,
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
    // took the cash: its tender carries the evening shift (the drawer).
    await seedSale({
      shift: morning,
      drawer: evening,
      cashier: second,
      totalIdr: 40_000,
    });
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
    const submitted = await submitCount(cashier, shift.id, { counts });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const countId = submitted.body.data.id as string;
    expect(submitted.body.data).toMatchObject({
      shiftId: shift.id,
      sequence: 1,
      countedIdr: expected,
      noteRequired: false,
    });
    const approval = await approvalFor(cashier, countId);
    const idempotencyKey = randomUUID();
    const body = { countId, ...approval, idempotencyKey };
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
      countId,
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
      countId: randomUUID(),
    });
    expect(tampered.status).toBe(409);
    expect(tampered.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // Nor can a new count land on the closed shift.
    const late = await submitCount(cashier, shift.id, {
      counts: countsFor(expected + 50_000),
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("SHIFT_ALREADY_CLOSED");
    expect((await shiftRow(shift.id))?.counted).toBe(expected);
  });

  it("a second close of a closed shift is 409 SHIFT_ALREADY_CLOSED and changes nothing", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const first = await close(cashier, shift.id, {
      countId: count.id,
      ...(await approvalFor(cashier, count.id)),
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await close(cashier, shift.id, {
      countId: count.id,
      ...(await approvalFor(cashier, count.id)),
      varianceNote: "Mencoba mengubah hitungan",
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("SHIFT_ALREADY_CLOSED");
    const recount = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR + 20_000),
    });
    expect(recount.status).toBe(409);
    expect(recount.body.error.code).toBe("SHIFT_ALREADY_CLOSED");
    expect(await shiftRow(shift.id)).toMatchObject({
      counted: FLOAT_IDR,
      variance: 0,
    });
  });

  it("an approval is used once: a closed shift's approval cannot close the cashier's next shift (403)", async () => {
    const cashier = await newCashier();
    const first = await openShift(cashier);
    const firstCount = await countDrawer(cashier, first.id, FLOAT_IDR);
    const approval = await approvalFor(cashier, firstCount.id);
    const closed = await close(cashier, first.id, {
      countId: firstCount.id,
      ...approval,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const next = await openShift(cashier);
    expect(next.id).not.toBe(first.id);
    const nextCount = await countDrawer(cashier, next.id, FLOAT_IDR);
    const reused = await close(cashier, next.id, {
      countId: nextCount.id,
      ...approval,
    });
    expect(reused.status).toBe(403);
    expect((await shiftRow(next.id))?.status).toBe("open");
  });

  it("a supervisor PIN approval made through the staff-override service can close the shift (fresh request id, bound by the PIN fallback)", async () => {
    // Spec §3.10: the supervisor approves through the existing staff-override
    // service (PIN on the device). A PIN override's id is a ULID that is
    // rarely an RFC UUID, so the device sends a fresh request id and the API
    // binds the newest PIN override for this very count, cashier and approver.
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const override = await pinOverride(cashier, count.id, 0);
    expect(override.status).toBe("approved");
    const response = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("closed");
  });

  it("answers 404 when closing an unknown shift, and when the count is unknown", async () => {
    const cashier = await newCashier();
    const response = await close(cashier, randomUUID(), {
      countId: randomUUID(),
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(response.status).toBe(404);
    const countOnUnknown = await submitCount(cashier, randomUUID(), {
      counts: countsFor(FLOAT_IDR),
    });
    expect(countOnUnknown.status).toBe(404);
    const shift = await openShift(cashier);
    const unknownCount = await close(cashier, shift.id, {
      countId: randomUUID(),
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(unknownCount.status).toBe(404);
  });
});

// ---- Round 2: the approval is bound to the count and its variance -------------------

/** The real staff-override service: the supervisor's PIN on the device. */
async function pinOverride(
  cashier: Member,
  countId: string,
  valueIdr: number,
  approver: string = supervisor.userId,
) {
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
      valueIdr,
      reason: "Hitung kas akhir shift",
      objectType: "pos_shift_count",
      objectId: countId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  return override;
}

/**
 * §3.7 matrix rows for `cash_shift_close`, inserted as the owner for the
 * duration of `run` only (the rest of the file relies on "no rule").
 */
async function withShiftClosePolicies(
  rows: { thresholdIdr: number | null; roleId: string; level: number }[],
  run: () => Promise<void>,
): Promise<void> {
  const ids: string[] = [];
  try {
    for (const row of rows) {
      const { rows: inserted } = await owner.query<{ id: string }>(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
         VALUES ($1, 'cash_shift_close', $2, $3, $4) RETURNING id`,
        [tenant.tenantId, row.thresholdIdr, row.roleId, row.level],
      );
      ids.push(inserted[0]!.id);
    }
    await run();
  } finally {
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.tenantId, ids],
    );
  }
}

/**
 * An approved phone decision: a one-level `pos_override` approval chain for
 * `chainAmountIdr` and the approved `supervisor_phone` override that points at
 * it, worth |variance| of the count. Written as the owner (deciding a chain
 * through the inbox needs a second session; the rows are what it stores).
 */
async function phoneApprovalFor(
  cashier: Member,
  countId: string,
  chainAmountIdr: number,
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const chainId = randomUUID();
  const overrideId = randomUUID();
  const valueIdr = Math.abs((await countRow(countId))?.variance ?? 0);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
          requested_by, source, level, required_levels, required_steps, amount_idr, status,
          decided_by, decided_at, reason, request_reason, deadline_at, created_at)
       VALUES ($1, $2, $3, $1, 'pos_override', 'cash_shift_close', 'pos_override', $4,
               $5, 'user', 1, 1, $6::jsonb, $7, 'approved',
               $8, now() - interval '4 seconds', 'Disetujui lewat ponsel', 'Hitung kas akhir shift',
               now() + interval '1 hour', now() - interval '6 seconds')`,
      [
        chainId,
        tenant.tenantId,
        tenant.outletId,
        overrideId,
        cashier.userId,
        JSON.stringify([{ level: 1, approverRoleIds: [roleIds.supervisor] }]),
        chainAmountIdr,
        supervisor.userId,
      ],
    );
    await client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, approval_request_id, request_fingerprint,
          created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_phone', 'approved', $4, $5,
               'Hitung kas akhir shift', $6, 'pos_shift_count', $7, $8, $9,
               now() - interval '6 seconds', now() - interval '4 seconds')`,
      [
        overrideId,
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        supervisor.userId,
        valueIdr,
        countId,
        chainId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    );
  });
  return { approvedBy: supervisor.userId, approvalRequestId: chainId };
}

describe("POS-03 round 2: a close approval is bound to one count and its variance (legend-6c0 findings 3 and 4)", () => {
  it("finding 3: an approval for a Rp0 count cannot close the shift with a later Rp1.000.000 count; the override for that count is worth Rp1.000.000 even when the device sent Rp0", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const balanced = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const rp0 = await approvalFor(cashier, balanced.id);
    expect((await countRow(balanced.id))?.variance).toBe(0);

    const big = await countDrawer(cashier, shift.id, FLOAT_IDR + 1_000_000);
    expect(big.sequence).toBe(2);
    expect(big.noteRequired).toBe(true);
    const note = { varianceNote: "Uang titipan pelanggan ikut terhitung" };

    // The approved count is no longer the latest one.
    const superseded = await close(cashier, shift.id, {
      countId: balanced.id,
      ...rp0,
      ...note,
    });
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(409);
    expect(superseded.body.error.code).toBe("SHIFT_COUNT_SUPERSEDED");
    // The Rp0 approval does not cover the new count.
    const swapped = await close(cashier, shift.id, {
      countId: big.id,
      ...rp0,
      ...note,
    });
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(403);
    // Nor does an approval for this count recorded at Rp0.
    const forged = await approvalFor(cashier, big.id, { valueIdr: 0 });
    const underValued = await close(cashier, shift.id, {
      countId: big.id,
      ...forged,
      ...note,
    });
    expect(underValued.status, JSON.stringify(underValued.body)).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");

    // The service never takes a superseded count…
    await expect(pinOverride(cashier, balanced.id, 0)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // …and values the latest one itself: the device sent Rp0.
    const override = await pinOverride(cashier, big.id, 0);
    expect(override.status).toBe("approved");
    // The cashier (requester) never reads the value back: blind count.
    expect(override.valueIdr).toBeNull();
    const { rows } = await owner.query<{ value: number }>(
      "SELECT value_idr::int AS value FROM pos_overrides WHERE tenant_id = $1 AND object_id = $2 AND method = 'supervisor_pin' ORDER BY created_at DESC LIMIT 1",
      [tenant.tenantId, big.id],
    );
    expect(rows[0]?.value).toBe(1_000_000);

    const closed = await close(cashier, shift.id, {
      countId: big.id,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
      ...note,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      countId: big.id,
      countedIdr: FLOAT_IDR + 1_000_000,
      varianceIdr: 1_000_000,
    });
  });

  it("finding 4: a recount with other numbers makes the earlier approval unusable (409 superseded, 403 on the new count) and both counts stay on the trail", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const first = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const approval = await approvalFor(cashier, first.id);
    const note = { varianceNote: "Uang kembalian terselip" };
    const noNote = await close(cashier, shift.id, {
      countId: first.id,
      ...approval,
    });
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe("SHIFT_VARIANCE_NOTE_REQUIRED");

    // The cashier changes the numbers instead of writing the note.
    const second = await countDrawer(cashier, shift.id, FLOAT_IDR - 10_000);
    const old = await close(cashier, shift.id, {
      countId: first.id,
      ...approval,
      ...note,
    });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe("SHIFT_COUNT_SUPERSEDED");
    const reused = await close(cashier, shift.id, {
      countId: second.id,
      ...approval,
      ...note,
    });
    expect(reused.status).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");

    const trail = await listCounts(supervisor, shift.id);
    expect(trail.status).toBe(200);
    expect(
      trail.body.data.map((c: { id: string; varianceIdr: number }) => [
        c.id,
        c.varianceIdr,
      ]),
    ).toEqual([
      [first.id, -5_000],
      [second.id, -10_000],
    ]);

    // A fresh approval for the new count closes it.
    const fresh = await close(cashier, shift.id, {
      countId: second.id,
      ...(await approvalFor(cashier, second.id)),
      ...note,
    });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.data).toMatchObject({
      countId: second.id,
      varianceIdr: -10_000,
    });
  });

  it("the supervisor's trail lists every submission in order with expected and variance; the shift's cashier gets 403 and the receipt never shows expected or variance", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await seedSale({ shift, cashier, totalIdr: 55_000 }); // expected 155.000
    const short = await countDrawer(cashier, shift.id, 150_000);
    const even = await countDrawer(cashier, shift.id, 155_000);
    const over = await countDrawer(cashier, shift.id, 160_000);

    for (const receipt of [short, even, over])
      expect(Object.keys(receipt).sort()).toEqual([
        "countedIdr",
        "id",
        "noteRequired",
        "sequence",
        "shiftId",
        "submittedAt",
      ]);
    expect(
      [short, even, over].map((r) => [
        r.sequence,
        r.countedIdr,
        r.noteRequired,
      ]),
    ).toEqual([
      [1, 150_000, true],
      [2, 155_000, false],
      [3, 160_000, true],
    ]);

    for (const viewer of [supervisor, viewAllUser]) {
      const trail = await listCounts(viewer, shift.id);
      expect(trail.status, JSON.stringify(trail.body)).toBe(200);
      const rows = (trail.body.data as unknown[]).map((row) =>
        posShiftCountSchema.parse(row),
      );
      expect(
        rows.map((row) => [
          row.id,
          row.sequence,
          row.countedIdr,
          row.expectedIdr,
          row.varianceIdr,
          row.submittedBy,
        ]),
      ).toEqual([
        [short.id, 1, 150_000, 155_000, -5_000, cashier.userId],
        [even.id, 2, 155_000, 155_000, 0, cashier.userId],
        [over.id, 3, 160_000, 155_000, 5_000, cashier.userId],
      ]);
      expect(rows[0]?.counts).toEqual(countsFor(150_000));
    }

    expect((await listCounts(cashier, shift.id)).status).toBe(403);
    const otherCashier = await newCashier("Kasir Lain");
    expect((await listCounts(otherCashier, shift.id)).status).toBe(403);
    expect((await listCounts(noShiftUser, shift.id)).status).toBe(403);
    const anonymous = await agent(app)
      .get(`${SHIFTS()}/${shift.id}/counts`)
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
  });

  it("a count is idempotent per key: a retry returns the same submission, another body under the same key is 409", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const idempotencyKey = randomUUID();
    const counts = countsFor(FLOAT_IDR);
    const first = await submitCount(cashier, shift.id, {
      counts,
      idempotencyKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await submitCount(cashier, shift.id, {
      counts,
      idempotencyKey,
    });
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const changed = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR + 1_000),
      idempotencyKey,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const { rows } = await owner.query(
      "SELECT 1 FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("a count goes stale when the drawer moves after it (409 SHIFT_COUNT_STALE); a recount closes", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const approval = await approvalFor(cashier, count.id);
    const moved = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: 20_000,
    });
    expect(moved.status).toBe(201);
    const stale = await close(cashier, shift.id, {
      countId: count.id,
      ...approval,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("SHIFT_COUNT_STALE");
    expect((await shiftRow(shift.id))?.status).toBe("open");

    const closed = await closeShift(cashier, shift.id, FLOAT_IDR + 20_000);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      expectedIdr: FLOAT_IDR + 20_000,
      varianceIdr: 0,
    });
  });

  it("the approval matrix tier is checked when the approval is used: a two-level tier refuses a PIN; a one-level tier needs its role", async () => {
    const seniorRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Supervisor Senior Uji', false, NULL, $3, false, '["tenant"]')`,
      [
        seniorRole,
        tenant.tenantId,
        JSON.stringify(["shift.cash.approve_close"]),
      ],
    );
    const senior = await member(tenant, seniorRole, "Supervisor Senior");
    const note = { varianceNote: "Selisih besar, dicek ulang" };

    await withShiftClosePolicies(
      [
        // Rp50.000 and up: one level, the senior role.
        { thresholdIdr: 50_000, roleId: seniorRole, level: 1 },
        // Rp500.000 and up: two levels.
        { thresholdIdr: 500_000, roleId: roleIds.supervisor, level: 1 },
        { thresholdIdr: 500_000, roleId: seniorRole, level: 2 },
      ],
      async () => {
        // Two-level tier: no single PIN closes it, whoever approves.
        const a = await newCashier("Kasir Matriks A");
        const bigShift = await openShift(a);
        const big = await countDrawer(a, bigShift.id, FLOAT_IDR + 600_000);
        for (const approver of [supervisor.userId, senior.userId]) {
          const refused = await close(a, bigShift.id, {
            countId: big.id,
            ...(await approvalFor(a, big.id, { approver })),
            ...note,
          });
          expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        }
        expect((await shiftRow(bigShift.id))?.status).toBe("open");

        // One-level tier with the senior role: the plain supervisor is refused,
        // the senior closes.
        const b = await newCashier("Kasir Matriks B");
        const midShift = await openShift(b);
        const mid = await countDrawer(b, midShift.id, FLOAT_IDR + 60_000);
        const wrongRole = await close(b, midShift.id, {
          countId: mid.id,
          ...(await approvalFor(b, mid.id)),
          ...note,
        });
        expect(wrongRole.status, JSON.stringify(wrongRole.body)).toBe(403);
        expect((await shiftRow(midShift.id))?.status).toBe("open");
        const rightRole = await close(b, midShift.id, {
          countId: mid.id,
          ...(await approvalFor(b, mid.id, { approver: senior.userId })),
          ...note,
        });
        expect(rightRole.status, JSON.stringify(rightRole.body)).toBe(200);
        expect(rightRole.body.data).toMatchObject({
          varianceIdr: 60_000,
          approvedBy: senior.userId,
        });

        // Below every threshold: the approve permission alone is enough.
        const c = await newCashier("Kasir Matriks C");
        const smallShift = await openShift(c);
        const small = await closeShift(c, smallShift.id, FLOAT_IDR);
        expect(small.status, JSON.stringify(small.body)).toBe(200);
      },
    );
  });

  it("a phone approval is refused when its chain was opened for another amount than the variance", async () => {
    await withShiftClosePolicies(
      [{ thresholdIdr: 50_000, roleId: roleIds.supervisor, level: 1 }],
      async () => {
        const cashier = await newCashier("Kasir Ponsel");
        const shift = await openShift(cashier);
        const count = await countDrawer(cashier, shift.id, FLOAT_IDR + 60_000);
        const note = { varianceNote: "Selisih dicek supervisor lewat ponsel" };
        const cheap = await close(cashier, shift.id, {
          countId: count.id,
          ...(await phoneApprovalFor(cashier, count.id, 1_000)),
          ...note,
        });
        expect(cheap.status, JSON.stringify(cheap.body)).toBe(403);
        expect((await shiftRow(shift.id))?.status).toBe("open");
        // Control: the same chain for the real amount closes.
        const exact = await close(cashier, shift.id, {
          countId: count.id,
          ...(await phoneApprovalFor(cashier, count.id, 60_000)),
          ...note,
        });
        expect(exact.status, JSON.stringify(exact.body)).toBe(200);
        expect(exact.body.data.varianceIdr).toBe(60_000);
      },
    );
  });

  it("blind count: the cashier never reads the variance from the override or the approval request; the approver and an inbox viewer do, and the close still works", async () => {
    const inboxRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Penyetuju Ponsel Uji', false, NULL, $3, false, '["tenant"]')`,
      [
        inboxRole,
        tenant.tenantId,
        JSON.stringify(["shift.cash.approve_close", "approval.inbox.view"]),
      ],
    );
    const inboxViewer = await member(tenant, inboxRole, "Penyetuju Ponsel");
    const cashier = await newCashier("Kasir Buta");
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR + 60_000);
    const postOverride = (approval: Record<string, unknown>, key: string) =>
      cashier.client
        .post("/api/pos-overrides")
        .set(headers)
        .set(originHeader)
        .set("Idempotency-Key", key)
        .send({
          outletId: tenant.outletId,
          action: "cash_shift_close",
          valueIdr: 0,
          reason: "Hitung kas akhir shift",
          objectType: "pos_shift_count",
          objectId: count.id,
          approval,
        });
    const getOverride = (who: Member, id: string) =>
      who.client.get(`/api/pos-overrides/${id}`).set(headers).set(originHeader);
    const getApproval = (who: Member, id: string) =>
      who.client.get(`/api/approvals/${id}`).set(headers).set(originHeader);

    // Phone approval: the chain carries |variance| for the approver only.
    await withShiftClosePolicies(
      [{ thresholdIdr: 50_000, roleId: inboxRole, level: 1 }],
      async () => {
        const key = randomUUID();
        const created = await postOverride({ method: "supervisor_phone" }, key);
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.data).toMatchObject({
          status: "pending",
          valueIdr: null,
        });
        const overrideId = created.body.data.id as string;
        const replay = await postOverride({ method: "supervisor_phone" }, key);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body.data).toMatchObject({
          id: overrideId,
          valueIdr: null,
        });
        const polled = await getOverride(cashier, overrideId);
        expect(polled.status, JSON.stringify(polled.body)).toBe(200);
        expect(polled.body.data.valueIdr).toBeNull();
        const { rows } = await owner.query<{ value: number }>(
          "SELECT value_idr::int AS value FROM pos_overrides WHERE tenant_id = $1 AND approval_request_id = $2",
          [tenant.tenantId, created.body.data.approvalRequestId],
        );
        expect(rows[0]?.value).toBe(60_000);

        // The cashier's own approval list and detail hide the amount.
        const own = await cashier.client
          .get("/api/approvals")
          .set(headers)
          .set(originHeader);
        expect(own.status, JSON.stringify(own.body)).toBe(200);
        const mine = (
          own.body.data as {
            id: string;
            objectId: string;
            amountIdr: number | null;
            payload: Record<string, unknown>;
          }[]
        ).find((row) => row.objectId === overrideId);
        expect(mine).toBeDefined();
        expect(mine?.amountIdr).toBeNull();
        expect(mine?.payload).not.toHaveProperty("valueIdr");
        expect(JSON.stringify(own.body)).not.toContain("60000");
        const detail = await getApproval(cashier, mine!.id);
        expect(detail.status, JSON.stringify(detail.body)).toBe(200);
        expect(detail.body.data.amountIdr).toBeNull();
        expect(detail.body.data.payload).not.toHaveProperty("valueIdr");
        expect(detail.body.data.payload).toMatchObject({
          action: "cash_shift_close",
          objectId: count.id,
        });

        // The inbox viewer (the approver role) still sees the amount.
        const inbox = await getApproval(inboxViewer, mine!.id);
        expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
        expect(inbox.body.data.amountIdr).toBe(60_000);
        expect(inbox.body.data.payload.valueIdr).toBe(60_000);
        const inboxList = await inboxViewer.client
          .get("/api/approvals")
          .set(headers)
          .set(originHeader);
        expect(inboxList.status, JSON.stringify(inboxList.body)).toBe(200);
        expect(
          (
            inboxList.body.data as { id: string; amountIdr: number | null }[]
          ).find((row) => row.id === mine!.id)?.amountIdr,
        ).toBe(60_000);
      },
    );

    // PIN approval: the cashier's response hides it, the approver reads it.
    const pin = await postOverride(
      {
        method: "supervisor_pin",
        approverUserId: supervisor.userId,
        pin: PIN,
      },
      randomUUID(),
    );
    expect(pin.status, JSON.stringify(pin.body)).toBe(201);
    expect(pin.body.data).toMatchObject({
      status: "approved",
      valueIdr: null,
    });
    const pinId = pin.body.data.id as string;
    expect((await getOverride(cashier, pinId)).body.data.valueIdr).toBeNull();
    const asApprover = await getOverride(supervisor, pinId);
    expect(asApprover.status, JSON.stringify(asApprover.body)).toBe(200);
    expect(asApprover.body.data.valueIdr).toBe(60_000);

    // The close still binds the approval to the variance and succeeds.
    const closed = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
      varianceNote: "Selisih dicek supervisor",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      countId: count.id,
      varianceIdr: 60_000,
    });
  });
});

// ---- Locked after close (database backstop) ----------------------------------------

describe("POS-03 review K: shift service fixes (legend-6c0)", () => {
  it("stores the verified PIN override's own id as approval_request_id, never the raw client value, on the shift and its event", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const override = await pinOverride(cashier, count.id, 0);
    const clientValue = randomUUID();
    const closed = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: clientValue,
      varianceNote: "Uang kembalian terselip",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const expected = ulidToUuid(override.id);
    expect(closed.body.data.approvalRequestId).toBe(expected);
    expect(closed.body.data.approvalRequestId).not.toBe(clientValue);
    const { rows } = await owner.query<{ stored: string; event: string }>(
      `SELECT s.approval_request_id::text AS stored,
              (SELECT e.event->'payload'->>'approvalRequestId'
                 FROM domain_event_outbox e
                WHERE e.tenant_id = s.tenant_id
                  AND e.event->>'name' = 'cashier_shift.closed'
                  AND e.event->'payload'->>'shiftId' = s.id::text) AS event
         FROM pos_shifts s WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(rows[0]).toEqual({ stored: expected, event: expected });
  });

  it("refuses a cash out over the drawer with a generic message and keeps an audit row of the refusal (no expected figure)", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const refused = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: FLOAT_IDR + 1_000,
      reasonNote: "Beli gas elpiji",
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    expect(refused.body.error.message).toBe(
      "Kas keluar ini perlu persetujuan supervisor.",
    );
    expect(refused.body.error.message).not.toMatch(/laci|\d/);
    const { rows } = await owner.query<{
      event: {
        actorId: string;
        objectType: string;
        maskedChanges: { after: Record<string, unknown> };
      };
    }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'pos_shift.cash_movement_refused'
          AND event->>'objectId' = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.actorId).toBe(cashier.userId);
    expect(rows[0]!.event.maskedChanges.after).toEqual({
      shiftId: shift.id,
      type: "cash_out",
      amountIdr: FLOAT_IDR + 1_000,
    });
    // Nothing was recorded as a movement.
    const { rows: moved } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(moved[0]?.n).toBe(0);
  });

  it("a tier that needs several levels says only that the shift needs a supervisor over the phone, whatever the variance", async () => {
    await withShiftClosePolicies(
      [
        { thresholdIdr: 50_000, roleId: roleIds.supervisor, level: 1 },
        { thresholdIdr: 50_000, roleId: roleIds.supervisor, level: 2 },
      ],
      async () => {
        const cashier = await newCashier();
        const shift = await openShift(cashier);
        const count = await countDrawer(cashier, shift.id, FLOAT_IDR + 60_000);
        const refused = await close(cashier, shift.id, {
          countId: count.id,
          ...(await approvalFor(cashier, count.id)),
          varianceNote: "Selisih dicek supervisor",
        });
        expect(refused.status, JSON.stringify(refused.body)).toBe(403);
        expect(refused.body.error.message).toBe(
          "Penutupan shift ini perlu persetujuan supervisor lewat ponsel.",
        );
        expect(refused.body.error.message).not.toMatch(/selisih|berjenjang/i);
        expect((await shiftRow(shift.id))?.status).toBe("open");
      },
    );
  });

  it("a cashier submits at most 3 counts per shift: the 4th is 409 SHIFT_COUNT_LIMIT, a replay of an earlier count still answers, and the latest count closes", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await countDrawer(cashier, shift.id, FLOAT_IDR - 1_000);
    await countDrawer(cashier, shift.id, FLOAT_IDR - 2_000);
    const thirdKey = randomUUID();
    const third = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
      idempotencyKey: thirdKey,
    });
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    const fourth = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR - 3_000),
    });
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(409);
    expect(fourth.body.error.code).toBe("SHIFT_COUNT_LIMIT");
    expect(fourth.body.error.message).toBe(
      "Batas hitung ulang tercapai. Minta supervisor menutup shift.",
    );
    const replay = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
      idempotencyKey: thirdKey,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.id).toBe(third.body.data.id);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(rows[0]?.n).toBe(3);
    const closed = await close(cashier, shift.id, {
      countId: third.body.data.id,
      ...(await approvalFor(cashier, third.body.data.id)),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("after 2 over-drawer cash-out refusals every further cash out is refused, whatever the amount; cash in, counts and close still work", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const message = "Kas keluar ini perlu persetujuan supervisor.";
    const refusals = () =>
      owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'pos_shift.cash_movement_refused'
            AND event->>'objectId' = $2`,
        [tenant.tenantId, shift.id],
      );
    const movements = () =>
      owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
        [tenant.tenantId, shift.id],
      );
    for (const over of [FLOAT_IDR + 1_000, FLOAT_IDR + 2_000]) {
      const refused = await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr: over,
        reasonNote: "Beli gas elpiji",
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    }
    expect((await refusals()).rows[0]?.n).toBe(2);

    // A small cash out that fits the drawer is now refused as well, with the
    // same message, and audited like any other refusal.
    for (const [index, type] of (["cash_out", "drop"] as const).entries()) {
      const refused = await move(cashier, shift.id, {
        type,
        amountIdr: 1,
        reasonNote: "Beli gas elpiji",
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error.message).toBe(message);
      expect((await refusals()).rows[0]?.n).toBe(3 + index);
    }
    expect((await movements()).rows[0]?.n).toBe(0);

    // Cash in stays allowed.
    const cashIn = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: 10_000,
    });
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(201);
    expect((await movements()).rows[0]?.n).toBe(1);

    // Counting and closing are untouched.
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR + 10_000);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("stores the verified override's approver, not the client's spelling of the id, on the shift, its event and the audit row", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const override = await pinOverride(cashier, count.id, 0);
    expect(override.approvedBy).toBe(supervisor.userId);
    const spelling = supervisor.userId.toUpperCase();
    const closed = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: spelling,
      approvalRequestId: randomUUID(),
      varianceNote: "Uang kembalian terselip",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.approvedBy).toBe(supervisor.userId);
    const { rows } = await owner.query<{
      stored: string;
      event: string;
      audit: string;
    }>(
      `SELECT s.approved_by AS stored,
              (SELECT e.event->'payload'->>'approvedBy'
                 FROM domain_event_outbox e
                WHERE e.tenant_id = s.tenant_id
                  AND e.event->>'name' = 'cashier_shift.closed'
                  AND e.event->'payload'->>'shiftId' = s.id::text) AS event,
              (SELECT a.event->'maskedChanges'->'after'->>'approvedBy'
                 FROM audit_logs a
                WHERE a.tenant_id = s.tenant_id
                  AND a.event->>'action' = 'pos_shift.closed'
                  AND a.event->>'objectId' = s.id::text) AS audit
         FROM pos_shifts s WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(rows[0]?.stored).toBe(override.approvedBy);
    expect(rows[0]?.event).toBe(override.approvedBy);
    expect(rows[0]?.audit).toBe(override.approvedBy);
  });

  it("a supervisor's forced counts do not use up the cashier's 3 counts: the 4th cashier count is SHIFT_COUNT_LIMIT", async () => {
    const cashier = await newCashier();
    const caller = await member(
      tenant,
      roleIds.supervisor,
      "Supervisor Hitung",
    );
    const shift = await openShift(cashier);
    const first = await forcedCount(caller, shift.id, FLOAT_IDR - 1_000);
    const second = await forcedCount(caller, shift.id, FLOAT_IDR - 2_000);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    for (const [index, delta] of [3_000, 4_000, 5_000].entries()) {
      const counted = await countDrawer(cashier, shift.id, FLOAT_IDR - delta);
      expect(counted.sequence).toBe(3 + index);
    }
    const fourth = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(409);
    expect(fourth.body.error.code).toBe("SHIFT_COUNT_LIMIT");
  });
});

// ---- Review K: supervisor force close (U9) ---------------------------------------

function forceClose(
  who: Member,
  shiftId: string,
  body: Record<string, unknown>,
  outletId = tenant.outletId,
) {
  return who.client
    .post(`${SHIFTS(outletId)}/${shiftId}/force-close`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

/**
 * Step one of a force close: a supervisor (not the shift's cashier) submits a
 * forced count; step two's witness approves it through the real override path.
 */
async function forcedCount(
  caller: Member,
  shiftId: string,
  countedIdr: number,
): Promise<CountReceipt> {
  const response = await submitCount(caller, shiftId, {
    counts: countsFor(countedIdr),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(response.body.data) as CountReceipt;
}

/** The witness (`supervisor`, who holds a PIN) approves `countId`, asked for by `caller`. */
async function witnessFor(caller: Member, countId: string) {
  const override = await pinOverride(caller, countId, 0);
  return {
    override,
    body: { approvedBy: supervisor.userId, approvalRequestId: randomUUID() },
  };
}

describe("POS-03 review K: supervisor force close (legend-6c0)", () => {
  const note = "Kasir gagal menghitung kas tiga kali";

  it("a supervisor submits a forced count past the cashier's limit; the witness approves it; the shift closes with it, replays by key and stores the override's id", async () => {
    const cashier = await newCashier();
    const caller = await member(tenant, roleIds.supervisor, "Supervisor Paksa");
    const shift = await openShift(cashier);
    for (const delta of [1_000, 2_000, 3_000])
      await countDrawer(cashier, shift.id, FLOAT_IDR - delta);
    const blocked = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(blocked.body.error.code).toBe("SHIFT_COUNT_LIMIT");

    const count = await forcedCount(caller, shift.id, FLOAT_IDR - 5_000);
    expect(count.sequence).toBe(4);
    // The receipt stays blind.
    expect(count).not.toHaveProperty("expectedIdr");
    expect(count).not.toHaveProperty("varianceIdr");
    const { override, body: witness } = await witnessFor(caller, count.id);
    const request = { countId: count.id, note, ...witness };
    const key = randomUUID();
    const closed = await forceClose(caller, shift.id, {
      ...request,
      idempotencyKey: key,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      countedIdr: FLOAT_IDR - 5_000,
      expectedIdr: FLOAT_IDR,
      varianceIdr: -5_000,
      varianceNote: note,
      approvedBy: supervisor.userId,
      countId: count.id,
      approvalRequestId: ulidToUuid(override.id),
    });
    const { rows } = await owner.query<{
      closed_by: string;
      forced: boolean;
      submitted_by: string;
    }>(
      `SELECT s.closed_by, c.forced, c.submitted_by
         FROM pos_shifts s JOIN pos_shift_counts c
           ON c.tenant_id = s.tenant_id AND c.id = s.count_id
        WHERE s.tenant_id = $1 AND s.id = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(rows[0]).toEqual({
      closed_by: caller.userId,
      forced: true,
      submitted_by: caller.userId,
    });
    expect(await outboxNames(shift.id)).toContain("cashier_shift.closed");
    const { rows: audit } = await owner.query(
      `SELECT 1 FROM audit_logs WHERE tenant_id = $1
        AND event->>'action' = 'pos_shift.force_closed' AND event->>'objectId' = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(audit).toHaveLength(1);

    const replay = await forceClose(caller, shift.id, {
      ...request,
      idempotencyKey: key,
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.id).toBe(closed.body.data.id);
    const again = await forceClose(caller, shift.id, request);
    expect(again.body.error.code).toBe("SHIFT_ALREADY_CLOSED");
    const reused = await forceClose(caller, shift.id, {
      ...request,
      note: "Catatan lain yang cukup panjang",
      idempotencyKey: key,
    });
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("refuses a forced count from someone who may not (403) and a cashier closing on a forced count", async () => {
    const cashier = await newCashier();
    const peer = await newCashier("Kasir Lain");
    const caller = await member(tenant, roleIds.supervisor, "Supervisor Tolak");
    const shift = await openShift(cashier);

    // No shift permission at all, or only `operate` on another cashier's shift.
    for (const who of [noShiftUser, peer]) {
      const refused = await submitCount(who, shift.id, {
        counts: countsFor(FLOAT_IDR),
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    }
    const { rows: none } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(none[0]?.n).toBe(0);

    // The cashier cannot close on the supervisor's forced count.
    const count = await forcedCount(caller, shift.id, FLOAT_IDR);
    const byCashier = await close(cashier, shift.id, {
      countId: count.id,
      ...(await approvalFor(cashier, count.id)),
    });
    expect(byCashier.status, JSON.stringify(byCashier.body)).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("force close refuses the cashier, a non-holder, a short note, a cashier's own count, a bad witness, a superseded and a stale count; nothing closes", async () => {
    const cashier = await newCashier();
    const caller = await member(tenant, roleIds.supervisor, "Supervisor Batas");
    const shift = await openShift(cashier);
    const cashierCount = await countDrawer(cashier, shift.id, FLOAT_IDR);
    const first = await forcedCount(caller, shift.id, FLOAT_IDR - 5_000);
    const { body: witness } = await witnessFor(caller, first.id);
    const base = { countId: first.id, note, ...witness };

    for (const who of [cashier, noShiftUser]) {
      const refused = await forceClose(who, shift.id, base);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    }
    const shortNote = await forceClose(caller, shift.id, {
      ...base,
      note: "terlalu",
    });
    expect(shortNote.status).toBe(VALIDATION_STATUS);
    // The cashier's own (not forced) count is no basis for a force close.
    const own = await forceClose(caller, shift.id, {
      ...base,
      countId: cashierCount.id,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    // Witness is the caller, or the cashier.
    for (const bad of [caller.userId, cashier.userId]) {
      const refused = await forceClose(caller, shift.id, {
        ...base,
        approvedBy: bad,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    }
    // No witness approval was ever given for this count.
    const second = await forcedCount(caller, shift.id, FLOAT_IDR - 5_000);
    const superseded = await forceClose(caller, shift.id, base);
    expect(superseded.status, JSON.stringify(superseded.body)).toBe(409);
    expect(superseded.body.error.code).toBe("SHIFT_COUNT_SUPERSEDED");
    const unapproved = await forceClose(caller, shift.id, {
      countId: second.id,
      note,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(unapproved.status, JSON.stringify(unapproved.body)).toBe(403);

    // The drawer moves after the count: stale.
    const moved = await move(cashier, shift.id, { amountIdr: 10_000 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    const { body: lateWitness } = await witnessFor(caller, second.id);
    const stale = await forceClose(caller, shift.id, {
      countId: second.id,
      note,
      ...lateWitness,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("SHIFT_COUNT_STALE");
    expect((await shiftRow(shift.id))?.status).toBe("open");

    // A fresh forced count, approved, closes.
    const third = await forcedCount(caller, shift.id, FLOAT_IDR + 10_000);
    const { body: okWitness } = await witnessFor(caller, third.id);
    const ok = await forceClose(caller, shift.id, {
      countId: third.id,
      note,
      ...okWitness,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.varianceIdr).toBe(0);
  });

  it("after a force close nothing is left open, so Tutup Hari proceeds", async () => {
    // A fresh outlet: the shared one keeps other tests' shifts open all day.
    const outletId = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet Tutup Hari Uji', 'Jl. Uji 1', 'Asia/Jakarta', $6, 'active')`,
      [
        outletId,
        tenant.tenantId,
        tenant.brandId,
        tenant.legalEntityId,
        `TH${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
    const managerRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Manajer Hari Uji', false, NULL, $3, false, '["tenant"]')`,
      [managerRole, tenant.tenantId, JSON.stringify(["pos.day.close"])],
    );
    const manager = await member(tenant, managerRole, "Manajer Hari");
    const caller = await member(tenant, roleIds.supervisor, "Supervisor Hari");
    const cashier = await member(tenant, roleIds.cashier, "Kasir Hari");
    const deviceId = randomUUID();
    registeredDevices.set(`${tenant.tenantId}:${deviceId}`, outletId);
    await setStaffPin(
      tenantContextOf(tenant.tenantId).tenant,
      supervisor.userId,
      { outletId, userId: supervisor.userId },
      { pin: PIN },
    );
    const post = (who: Member, path: string, body: Record<string, unknown>) =>
      who.client
        .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/${path}`)
        .set(headers)
        .set(originHeader)
        .set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId))
        .send({ idempotencyKey: randomUUID(), ...body });

    const opened = await post(cashier, "shifts", {
      openingFloatIdr: FLOAT_IDR,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const shift = opened.body.data as { id: string; businessDate: string };
    const closeDay = () =>
      post(manager, "day/close", {
        businessDate: shift.businessDate,
        inventoryDeduction: false,
      });
    const blocked = await closeDay();
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);

    const countResponse = await post(caller, `shifts/${shift.id}/counts`, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(countResponse.status, JSON.stringify(countResponse.body)).toBe(201);
    const { override } = await createPosOverride(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      caller.userId,
      {
        outletId,
        action: "cash_shift_close",
        valueIdr: 0,
        reason: "Hitung kas akhir shift",
        objectType: "pos_shift_count",
        objectId: countResponse.body.data.id,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(supervisor.userId),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");
    const forced = await post(caller, `shifts/${shift.id}/force-close`, {
      countId: countResponse.body.data.id,
      note,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);

    const day = await closeDay();
    expect(day.status, JSON.stringify(day.body)).toBe(200);
  });
});

describe("POS-03 close names the PIN override by its own ULID (legend-6c0)", () => {
  const stored = async (shiftId: string) => {
    const { rows } = await owner.query<{
      approval_request_id: string;
      approval_override_id: string;
    }>(
      `SELECT approval_request_id::text, approval_override_id::text
         FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, shiftId],
    );
    return rows[0]!;
  };

  it("closes with the override's ULID exactly as the override service returned it", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const override = await pinOverride(cashier, count.id, 0);
    const closed = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: override.id,
      varianceNote: "Uang kembalian terselip",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.status).toBe("closed");
    const row = await stored(shift.id);
    expect(row.approval_request_id).toBe(ulidToUuid(override.id));
    expect(row.approval_override_id).toBe(ulidToUuid(override.id));
  });

  it("closes with the override's ulidToUuid form, which is not an RFC uuid", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const override = await pinOverride(cashier, count.id, 0);
    const closed = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: ulidToUuid(override.id),
      varianceNote: "Uang kembalian terselip",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await stored(shift.id)).approval_override_id).toBe(
      ulidToUuid(override.id),
    );
  });

  it("force close accepts the witness override's ULID", async () => {
    const cashier = await newCashier();
    const caller = await member(tenant, roleIds.supervisor, "Supervisor Paksa");
    const shift = await openShift(cashier);
    for (const delta of [1_000, 2_000, 3_000])
      await countDrawer(cashier, shift.id, FLOAT_IDR - delta);
    const count = await forcedCount(caller, shift.id, FLOAT_IDR - 5_000);
    const { override } = await witnessFor(caller, count.id);
    const closed = await forceClose(caller, shift.id, {
      countId: count.id,
      note: "Kasir gagal menghitung kas tiga kali",
      approvedBy: supervisor.userId,
      approvalRequestId: override.id,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await stored(shift.id)).approval_override_id).toBe(
      ulidToUuid(override.id),
    );
  });

  it("refuses the ULID of another count's override and the shift stays open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    // The override service only approves the latest count of an open shift,
    // so the first approval is made before the recount supersedes it.
    const first = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const firstOverride = await pinOverride(cashier, first.id, 0);
    const second = await countDrawer(cashier, shift.id, FLOAT_IDR - 6_000);
    await pinOverride(cashier, second.id, 0);
    const refused = await close(cashier, shift.id, {
      countId: second.id,
      approvedBy: supervisor.userId,
      approvalRequestId: firstOverride.id,
      varianceNote: "Uang kembalian terselip",
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("refuses the ULID of an override for another action and the shift stays open", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    await pinOverride(cashier, count.id, 0);
    // A real void approval needs an approver holding pos.void.approve, with a
    // PIN of their own; the shift close still names the shift's supervisor.
    const voidRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Penyetuju Void Uji', false, NULL, $3, false, '["tenant"]')`,
      [voidRole, tenant.tenantId, JSON.stringify(["pos.void.approve"])],
    );
    const voidApprover = await member(tenant, voidRole, "Penyetuju Void");
    await setStaffPin(
      tenantContextOf(tenant.tenantId).tenant,
      voidApprover.userId,
      { outletId: tenant.outletId, userId: voidApprover.userId },
      { pin: PIN },
    );
    const { override: voidOverride } = await createPosOverride(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      cashier.userId,
      {
        outletId: tenant.outletId,
        action: "void",
        valueIdr: 0,
        reason: "Batalkan pesanan uji",
        objectType: "order",
        objectId: randomUUID(),
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(voidApprover.userId),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    const refused = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: voidOverride.id,
      varianceNote: "Uang kembalian terselip",
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect((await shiftRow(shift.id))?.status).toBe("open");
  });

  it("rejects a garbage approval id with 422 VALIDATION_ERROR", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR - 5_000);
    const response = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: "abc",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

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

  it("a count submission is history: direct SQL UPDATE and DELETE are refused, and no count lands on a closed shift", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    for (const statement of [
      "UPDATE pos_shift_counts SET counted_idr = counted_idr + 1000, variance_idr = variance_idr + 1000 WHERE tenant_id = $1 AND id = $2",
      "DELETE FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2",
    ])
      await expect(
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(statement, [tenant.tenantId, count.id]),
        ),
        statement,
      ).rejects.toThrow(/POS-03/);
    expect(await countRow(count.id)).toMatchObject({
      counted: FLOAT_IDR,
      variance: 0,
    });

    const closed = await close(cashier, shift.id, {
      countId: count.id,
      ...(await approvalFor(cashier, count.id)),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await expect(
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `INSERT INTO pos_shift_counts
             (tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
              counted_idr, expected_idr, variance_idr, submitted_by, submitted_at,
              idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, 2, '[]'::jsonb, $4, 0, 100000, -100000, $5, now(), $6, $4)`,
          [
            tenant.tenantId,
            tenant.outletId,
            shift.id,
            "b".repeat(64),
            cashier.userId,
            randomUUID(),
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
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR + 20_000);
    const approval = await approvalFor(cashier, count.id);
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
      ...(await send(`/${shift.id}/counts`, "get")),
      ...(await send(`/${shift.id}/counts`, "post", {
        counts,
        idempotencyKey: randomUUID(),
      })),
      ...(await send(`/${shift.id}/close`, "post", {
        countId: count.id,
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
    const { rows: countRows } = await owner.query(
      "SELECT 1 FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
      [tenant.tenantId, shift.id],
    );
    expect(countRows).toHaveLength(1);
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

  it("RLS hides shifts, cash movements and count submissions from another tenant and from another outlet", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await move(cashier, shift.id);
    await countDrawer(cashier, shift.id, FLOAT_IDR + 20_000);

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

    for (const table of ["pos_shifts", "cash_movements", "pos_shift_counts"]) {
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
