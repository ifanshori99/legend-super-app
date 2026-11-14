// Held cash out approval (legend-3l4q, legend-ym2kr, tier K: money). A cash
// movement the drawer could not cover (cash_movements.needs_approval = true) is
// held; a supervisor other than the recorder may approve or reject it while the
// shift is open. Written from docs/briefs/sub-cash-out-approval.md (sections
// "Aturan uang" and "Desain"), not from the implementation.
//
// Rules under test:
//   - approved = counted exactly once in the drawer's expected / difference;
//     held, rejected and expired = not counted (the cash stays in the drawer);
//   - approve posts exactly one journal (key aj:cash-movement:<id>, idempotent
//     on replay); reject posts none;
//   - a closed shift never changes (approve / reject after close is refused,
//     the stored figures and the day report stay put; the DB trigger refuses a
//     direct insert too);
//   - the outlet never pays cash that is not in the drawer: approve when
//     amount > expected now is refused;
//   - the approver is never the recorder; no permission = FORBIDDEN.
//
// The service is called directly (no route is mounted yet, brief B):
//   decideHeldCashMovement(context, caller, outletId, movementId, { decision })
// from ../services/pos-shift-cash-approval.service.ts. Until it exists the file
// fails on that import (right reason: missing behavior).
//
// Assumptions (the brief leaves them open):
//  - Errors are HttpError: CONFLICT -> status 409, FORBIDDEN -> status 403.
//  - The audit rows (pos_shift.cash_movement_approved / _rejected) carry
//    objectId = the movement id, as the expired audit does.
//  - Drawer figures are read from a fresh count (pos_shift_counts expected_idr /
//    held_cash_out_idr / variance_idr), since the blind close never shows
//    expected to the cashier.
//  - A held Rp150.000 cash out on a Rp100.000 float becomes approvable after a
//    Rp100.000 cash sale (expected Rp200.000). expected == amount is approvable
//    (only amount > expected is refused).
//  - "Replay" = the same decider repeating the same decision.
//  - A direct DB insert of 'approved' / 'rejected' whose decided_by is the
//    movement's recorded_by is a check_violation (23514).

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
import { posShiftCountReceiptSchema } from "@starter/shared/pos";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { decideHeldCashMovement } from "../services/pos-shift-cash-approval.service.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const FLOAT_IDR = 100_000;
const HELD_IDR = 150_000;

const roleIds = {
  cashier: randomUUID(),
  /** Can record a cash movement AND approve one: used for the self-approval case. */
  operator: randomUUID(),
  supervisor: randomUUID(),
  manager: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;
let manager: Member;

const registeredDevices = new Map<string, string>();

// ---- Fixtures (trimmed copies of pos-shift-held-expire.test.ts) ----------------------

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
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
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
  const { rows } = await owner.query<{
    variance: number;
    expected: number;
    held: number;
  }>(
    `SELECT variance_idr::int AS variance, expected_idr::int AS expected,
            held_cash_out_idr::int AS held
       FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, countId],
  );
  return rows[0]!;
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
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: tenant.outletId,
          action: "cash_shift_close",
          valueIdr,
          reason: "Hitung kas akhir shift",
          objectType: "pos_shift_count",
          objectId: countId,
          approverUserId: supervisor.userId,
        }),
      ],
    ),
  );
  return { approvedBy: supervisor.userId, approvalRequestId: id };
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
  cashier: Cashier,
  amountIdr: number,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_refunds
         (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
          requested_by, approved_by, approval_request_id, refunded_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, 'quality_complaint', 'Minuman tumpah', $5::jsonb,
               $6, $7, $8, now(), $9, true)`,
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
      ],
    ),
  );
}

// ---- Accounting fixtures (pos-shift-codex146.test.ts F2 chart plus cash_out_expense) --------------

const ACCOUNTING_CHART: [string, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
  [
    "deposit_forfeit_income",
    "4201",
    "Pendapatan DP Hangus",
    "revenue",
    "other_income",
  ],
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
  // legend-ym2kr: the counter account of a booked cash out (rule cash_movement.recorded / cash_out).
  [
    "cash_out_expense",
    "6109",
    "Kas Keluar Kasir",
    "expense",
    "operating_expense",
  ],
];

/** Accounting module on, a mapped chart of accounts and open periods for the test tenant. */
async function enableAccounting(businessDate: string): Promise<void> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenant.tenantId,
      JSON.stringify({
        modules: ["qr_order", "accounting"],
        integrationProviders: [],
      }),
    ],
  );
  const { rows: have } = await owner.query(
    "SELECT 1 FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenant.tenantId, tenant.legalEntityId],
  );
  if (have.length === 0)
    for (const [role, code, name, type, group] of ACCOUNTING_CHART) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenant.tenantId, tenant.legalEntityId, code, name, type, group],
      );
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)`,
        [tenant.tenantId, tenant.legalEntityId, role, rows[0]!.id],
      );
    }
  const months = new Set([
    businessDate.slice(0, 7),
    new Date().toISOString().slice(0, 7),
  ]);
  for (const period of months)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.tenantId, tenant.legalEntityId, period],
    );
}

/** The stored `cashier_shift.closed` outbox event of the shift (exactly one). */
async function closedEventRow(shiftId: string) {
  const { rows } = await owner.query<{
    event: { payload: Record<string, unknown> };
  }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
        AND event->'payload'->>'shiftId' = $2`,
    [tenant.tenantId, shiftId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.event;
}

async function storedDifference(shiftId: string): Promise<number | null> {
  const { rows } = await owner.query<{ difference: string | null }>(
    "SELECT difference_idr::text AS difference FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, shiftId],
  );
  const value = rows[0]!.difference;
  return value === null ? null : Number(value);
}

type MovementRow = { id: string; amount: number; needs_approval: boolean };

async function movementsOf(shiftId: string): Promise<MovementRow[]> {
  const { rows } = await owner.query<MovementRow>(
    `SELECT id, amount_idr::int AS amount, needs_approval FROM cash_movements
      WHERE tenant_id = $1 AND shift_id = $2 ORDER BY recorded_at, id`,
    [tenant.tenantId, shiftId],
  );
  return rows;
}

async function outcomesOf(
  shiftId: string,
): Promise<{ movement_id: string; outcome: string }[]> {
  const { rows } = await owner.query<{ movement_id: string; outcome: string }>(
    `SELECT movement_id, outcome FROM cash_movement_outcomes
      WHERE tenant_id = $1 AND shift_id = $2 ORDER BY created_at, id`,
    [tenant.tenantId, shiftId],
  );
  return rows;
}

async function pgCode(
  run: () => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? `no-code: ${String(error)}`;
  }
}

// ---- Approval helpers -----------------------------------------------------------------

type Drawer = {
  countId: string;
  expected: number;
  held: number;
  variance: number;
};

/** The drawer as the shift sees it now: count `countedIdr` and read the stored figures. */
async function drawerNow(
  cashier: Member,
  shiftId: string,
  countedIdr: number,
): Promise<Drawer> {
  const count = await countDrawer(cashier, shiftId, countedIdr);
  const row = await countRow(count.id);
  return {
    countId: count.id,
    expected: row.expected,
    held: row.held,
    variance: row.variance,
  };
}

const callerOf = (who: Member) => ({
  userId: userIdSchema.parse(who.userId),
  deviceId: null,
});

function decide(
  who: Member,
  movementId: string,
  decision: "approved" | "rejected",
) {
  return decideHeldCashMovement(
    tenantContextOf(tenant.tenantId),
    callerOf(who),
    outletIdSchema.parse(tenant.outletId),
    movementId,
    { decision },
  );
}

async function eventsOf(movementId: string, name: string) {
  const { rows } = await owner.query<{
    event: { payload: Record<string, unknown> };
  }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2
        AND event->'payload'->>'movementId' = $3`,
    [tenant.tenantId, name, movementId],
  );
  return rows.map((row) => row.event);
}

async function auditsOf(action: string, movementId: string) {
  const { rows } = await owner.query<{ event: { objectId: string } }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [tenant.tenantId, action, movementId],
  );
  return rows.map((row) => row.event);
}

/** Every stored event of the movement (recorded, approved), handed to the auto-journal consumer. */
async function deliverMovementEvents(movementId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->'payload'->>'movementId' = $2
        AND event->>'name' IN ('cash_movement.recorded', 'cash_movement.approved')`,
    [tenant.tenantId, movementId],
  );
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
  for (const row of rows)
    await withTenant(db, context, (tx) =>
      deliverAutoJournalEvent(
        context,
        eventEnvelopeSchema.parse(row.event),
        tx,
        new Date(Date.now() + 60 * 60 * 1000),
      ),
    );
}

async function journalsOfMovement(movementId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant.tenantId, `aj:cash-movement:${movementId}`],
  );
  return rows[0]!.n;
}

function insertOutcomeBy(
  shiftId: string,
  movementId: string,
  outcome: "approved" | "rejected",
  decidedBy: string,
) {
  return asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO cash_movement_outcomes
         (tenant_id, outlet_id, shift_id, movement_id, outcome, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        tenant.tenantId,
        tenant.outletId,
        shiftId,
        movementId,
        outcome,
        decidedBy,
      ],
    ),
  );
}

async function shiftFigures(shiftId: string) {
  const { rows } = await owner.query(
    `SELECT status, expected_idr::text AS expected, counted_idr::text AS counted,
            variance_idr::text AS variance, difference_idr::text AS difference,
            held_cash_out_idr::text AS held
       FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, shiftId],
  );
  return rows[0];
}

type DeviceRow = {
  deviceId: string;
  cashVarianceIdr: number | string;
  expiredCashOutIdr?: number | string;
};

async function dayDevice(businessDate: string, deviceId: string) {
  const report = await manager.client
    .get(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day?businessDate=${encodeURIComponent(businessDate)}`,
    )
    .set(headers)
    .set(originHeader);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  const device = (report.body.data.devices as DeviceRow[]).find(
    (row) => row.deviceId === deviceId,
  );
  expect(device, "device row of the cashier's till").toBeDefined();
  return device!;
}

/**
 * One held cash out of Rp150.000 on a fresh shift whose drawer then receives a
 * cash sale of `saleIdr`: the drawer holds Rp100.000 + saleIdr, so the held out
 * is approvable once saleIdr >= Rp50.000.
 */
async function heldWithSale(saleIdr: number, label = "Kasir") {
  const cashier = await newCashier(label);
  const shift = await openShift(cashier);
  const held = await move(cashier, shift.id, {
    type: "cash_out",
    amountIdr: HELD_IDR,
    reasonNote: "Beli gas elpiji",
  });
  expect(held.status, JSON.stringify(held.body)).toBe(201);
  if (saleIdr > 0) await seedCashSale(shift, cashier, saleIdr);
  const [row] = await movementsOf(shift.id);
  expect(row!.needs_approval).toBe(true);
  return { cashier, shift, movementId: row!.id };
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `cash-approval-${randomUUID().slice(0, 6)}`,
  );
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Cash Approval", ["shift.cash.operate"]],
    [
      roleIds.operator,
      "Penyelia Kas Cash Approval",
      ["shift.cash.operate", "shift.cash.approve_close"],
    ],
    [
      roleIds.supervisor,
      "Supervisor Cash Approval",
      ["shift.cash.approve_close"],
    ],
    [
      roleIds.manager,
      "Manajer Cash Approval",
      [
        "order.view",
        "pos.day.close",
        "shift.cash.approve_close",
        "shift.cash.operate",
      ],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await member(roleIds.supervisor, "Supervisor");
  manager = await member(roleIds.manager, "Manajer");
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

// ---- 1. Approve --------------------------------------------------------------------

describe("legend-3l4q approving a held cash out", () => {
  it("legend-3l4q: approve lowers expected by exactly the amount once, clears the held figure, stores one 'approved' outcome, and the close difference is 0", async () => {
    const { cashier, shift, movementId } = await heldWithSale(100_000);

    // Held: not in expected yet (Rp100.000 float + Rp100.000 sale), held figure Rp150.000.
    const before = await drawerNow(cashier, shift.id, 200_000);
    expect(before).toMatchObject({ expected: 200_000, held: HELD_IDR });

    const decided = await decide(supervisor, movementId, "approved");
    expect(decided).toMatchObject({
      movementId,
      outcome: "approved",
      decidedBy: supervisor.userId,
    });
    expect(Number.isNaN(Date.parse(decided.decidedAt))).toBe(false);

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);

    // Counted exactly once: 200.000 - 150.000, not 200.000 - 300.000.
    const after = await drawerNow(cashier, shift.id, 50_000);
    expect(after).toMatchObject({ expected: 50_000, held: 0, variance: 0 });

    // The blind close books difference 0 (no varianceNote needed).
    const closed = await close(cashier, shift.id, {
      countId: after.countId,
      ...(await approvalFor(cashier, after.countId)),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(Number((await closedEventRow(shift.id)).payload.differenceIdr)).toBe(
      0,
    );
    expect(await storedDifference(shift.id)).toBe(0);
    // Closing does not turn the approved movement into an 'expired' one.
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);
  });

  it("legend-3l4q: approve emits one cash_movement.approved event (amount, shift, approver) and one pos_shift.cash_movement_approved audit", async () => {
    const { shift, movementId } = await heldWithSale(100_000);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      0,
    );

    const decided = await decide(supervisor, movementId, "approved");

    const events = await eventsOf(movementId, "cash_movement.approved");
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      movementId,
      shiftId: shift.id,
      outletId: tenant.outletId,
      type: "cash_out",
      amountIdr: HELD_IDR,
      approvedBy: supervisor.userId,
    });
    expect(Date.parse(String(events[0]!.payload.approvedAt))).toBe(
      Date.parse(decided.decidedAt),
    );
    expect(
      await auditsOf("pos_shift.cash_movement_approved", movementId),
    ).toHaveLength(1);
    expect(
      await auditsOf("pos_shift.cash_movement_rejected", movementId),
    ).toHaveLength(0);
  });

  it("legend-3l4q: amount equal to the drawer's expected cash is approvable (only amount > expected is refused) and leaves expected 0", async () => {
    const { cashier, shift, movementId } = await heldWithSale(50_000);
    const before = await drawerNow(cashier, shift.id, 150_000);
    expect(before).toMatchObject({ expected: 150_000, held: HELD_IDR });

    await decide(supervisor, movementId, "approved");

    expect(await drawerNow(cashier, shift.id, 0)).toMatchObject({
      expected: 0,
      held: 0,
    });
  });
});

// ---- 2. Replay -----------------------------------------------------------------------

describe("legend-3l4q replaying a decision", () => {
  it("legend-3l4q: the same approve twice returns the same answer with no second effect (one outcome, one event, one audit, same expected)", async () => {
    const { cashier, shift, movementId } = await heldWithSale(100_000);

    const first = await decide(supervisor, movementId, "approved");
    const afterFirst = await drawerNow(cashier, shift.id, 50_000);
    const second = await decide(supervisor, movementId, "approved");

    expect(second).toEqual(first);
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      1,
    );
    expect(
      await auditsOf("pos_shift.cash_movement_approved", movementId),
    ).toHaveLength(1);
    const afterSecond = await drawerNow(cashier, shift.id, 50_000);
    expect(afterSecond.expected).toBe(afterFirst.expected);
    expect(afterSecond.expected).toBe(50_000);
  });

  it("legend-3l4q: a different decision after approve (reject) is a CONFLICT and changes nothing", async () => {
    const { shift, movementId } = await heldWithSale(100_000);
    await decide(supervisor, movementId, "approved");

    await expect(
      decide(supervisor, movementId, "rejected"),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);
    expect(
      await auditsOf("pos_shift.cash_movement_rejected", movementId),
    ).toHaveLength(0);
  });

  it("legend-3l4q: another supervisor repeating an existing decision gets a CONFLICT (replay is by the same decider only)", async () => {
    const { movementId } = await heldWithSale(100_000);
    await decide(supervisor, movementId, "approved");
    const other = await member(roleIds.supervisor, "Supervisor Kedua");

    await expect(decide(other, movementId, "approved")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      1,
    );
  });
});

// ---- 3. Reject -----------------------------------------------------------------------

describe("legend-3l4q rejecting a held cash out", () => {
  it("legend-3l4q: reject leaves the cash in the drawer: expected unchanged, held 0, a 'rejected' outcome, a rejected audit, no approved event", async () => {
    const { cashier, shift, movementId } = await heldWithSale(100_000);

    const decided = await decide(supervisor, movementId, "rejected");
    expect(decided).toMatchObject({
      movementId,
      outcome: "rejected",
      decidedBy: supervisor.userId,
    });

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "rejected" },
    ]);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      0,
    );
    expect(
      await auditsOf("pos_shift.cash_movement_rejected", movementId),
    ).toHaveLength(1);
    expect(
      await auditsOf("pos_shift.cash_movement_approved", movementId),
    ).toHaveLength(0);

    // The cash never left: Rp100.000 float + Rp100.000 sale, nothing held.
    expect(await drawerNow(cashier, shift.id, 200_000)).toMatchObject({
      expected: 200_000,
      held: 0,
      variance: 0,
    });
  });

  it("legend-3l4q: a rejected movement cannot be approved afterwards (CONFLICT, drawer unchanged)", async () => {
    const { cashier, shift, movementId } = await heldWithSale(100_000);
    await decide(supervisor, movementId, "rejected");

    await expect(
      decide(supervisor, movementId, "approved"),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "rejected" },
    ]);
    expect(await drawerNow(cashier, shift.id, 200_000)).toMatchObject({
      expected: 200_000,
    });
  });
});

// ---- 4. Who may decide ---------------------------------------------------------------

describe("legend-3l4q who may decide", () => {
  it("legend-3l4q: the person who recorded the cash out cannot approve or reject it (FORBIDDEN), even holding the approve permission", async () => {
    // The operator role holds shift.cash.operate and shift.cash.approve_close.
    const operator = await newCashier("Penyelia", roleIds.operator);
    const shift = await openShift(operator);
    const held = await move(operator, shift.id, {
      type: "cash_out",
      amountIdr: HELD_IDR,
      reasonNote: "Beli gas elpiji",
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    await seedCashSale(shift, operator, 100_000);
    const [row] = await movementsOf(shift.id);

    for (const decision of ["approved", "rejected"] as const)
      await expect(
        decide(operator, row!.id, decision),
        decision,
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await outcomesOf(shift.id)).toEqual([]);
    expect(await eventsOf(row!.id, "cash_movement.approved")).toHaveLength(0);

    // A different person with the permission can.
    await decide(supervisor, row!.id, "approved");
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: row!.id, outcome: "approved" },
    ]);
  });

  it("legend-3l4q: a user without the approve permission (a plain cashier) gets FORBIDDEN and nothing changes", async () => {
    const { shift, movementId } = await heldWithSale(100_000);
    const otherCashier = await newCashier("Kasir Lain");

    for (const decision of ["approved", "rejected"] as const)
      await expect(
        decide(otherCashier, movementId, decision),
        decision,
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await outcomesOf(shift.id)).toEqual([]);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      0,
    );
  });
});

// ---- 5. The drawer must hold the cash ------------------------------------------------

describe("legend-3l4q the outlet never pays cash that is not in the drawer", () => {
  it("legend-3l4q: approve while amount > expected now is a CONFLICT with no effect; the movement stays held and is approvable after the drawer fills", async () => {
    // Drawer holds only the Rp100.000 float; the cash out is Rp150.000.
    const { cashier, shift, movementId } = await heldWithSale(0);
    const before = await drawerNow(cashier, shift.id, FLOAT_IDR);
    expect(before).toMatchObject({ expected: FLOAT_IDR, held: HELD_IDR });

    await expect(
      decide(supervisor, movementId, "approved"),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await outcomesOf(shift.id)).toEqual([]);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      0,
    );
    expect(
      await auditsOf("pos_shift.cash_movement_approved", movementId),
    ).toHaveLength(0);
    expect(await drawerNow(cashier, shift.id, FLOAT_IDR)).toMatchObject({
      expected: FLOAT_IDR,
      held: HELD_IDR,
    });
  });

  it("legend-3l4q: after the refused approve the movement is still held and approves once a sale fills the drawer", async () => {
    const { cashier, shift, movementId } = await heldWithSale(0);
    await expect(
      decide(supervisor, movementId, "approved"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await seedCashSale(shift, cashier, 100_000);

    await decide(supervisor, movementId, "approved");

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);
    expect(await drawerNow(cashier, shift.id, 50_000)).toMatchObject({
      expected: 50_000,
      held: 0,
    });
  });

  it("legend-3l4q: cash of a held refund already left the drawer, so it bounds the approval: amount > expected - held refund cash is a CONFLICT with no outcome and no event", async () => {
    // Drawer figures: Rp100.000 float + Rp100.000 cash sale = Rp200.000. A held
    // cash refund of Rp60.000 is out of the figures but already paid out, so
    // only Rp140.000 is physically there: the Rp150.000 cash out must not pass.
    const { cashier, shift, movementId } = await heldWithSale(0);
    const orderId = await seedCashSale(shift, cashier, 100_000);
    await seedHeldRefund(shift.id, orderId, cashier, 60_000);

    await expect(
      decide(supervisor, movementId, "approved"),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(await outcomesOf(shift.id)).toEqual([]);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      0,
    );
    expect(
      await auditsOf("pos_shift.cash_movement_approved", movementId),
    ).toHaveLength(0);
  });

  it("legend-3l4q: with a smaller held refund (Rp40.000) the same cash out fits the physical drawer (Rp160.000) and approves", async () => {
    const { cashier, shift, movementId } = await heldWithSale(0);
    const orderId = await seedCashSale(shift, cashier, 100_000);
    await seedHeldRefund(shift.id, orderId, cashier, 40_000);

    await decide(supervisor, movementId, "approved");

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);
  });

  it("legend-3l4q: a held cash out that is rejected while the drawer cannot cover it stores a 'rejected' outcome (rejecting never pays anything)", async () => {
    const { shift, movementId } = await heldWithSale(0);

    const decided = await decide(supervisor, movementId, "rejected");

    expect(decided.outcome).toBe("rejected");
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "rejected" },
    ]);
  });
});

// ---- 6. A closed shift never changes -------------------------------------------------

describe("legend-3l4q a closed shift's figures never change", () => {
  it("legend-3l4q: approve or reject after the shift closed is a CONFLICT; the outcome stays 'expired', the shift row and the day report are unchanged", async () => {
    const { cashier, shift, movementId } = await heldWithSale(0);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "expired" },
    ]);
    const figuresBefore = await shiftFigures(shift.id);
    const reportBefore = await dayDevice(shift.businessDate, cashier.deviceId);
    expect(Number(reportBefore.expiredCashOutIdr)).toBe(HELD_IDR);
    expect(Number(reportBefore.cashVarianceIdr)).toBe(0);

    for (const decision of ["approved", "rejected"] as const)
      await expect(
        decide(supervisor, movementId, decision),
        decision,
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "expired" },
    ]);
    expect(await shiftFigures(shift.id)).toEqual(figuresBefore);
    expect(await eventsOf(movementId, "cash_movement.approved")).toHaveLength(
      0,
    );
    const reportAfter = await dayDevice(shift.businessDate, cashier.deviceId);
    expect(Number(reportAfter.expiredCashOutIdr)).toBe(HELD_IDR);
    expect(Number(reportAfter.cashVarianceIdr)).toBe(0);
  });

  it("legend-3l4q: the database refuses a direct 'approved' or 'rejected' outcome once the shift is closed", async () => {
    const { cashier, shift, movementId } = await heldWithSale(0);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    for (const outcome of ["approved", "rejected"] as const)
      expect(
        await pgCode(() =>
          insertOutcomeBy(shift.id, movementId, outcome, supervisor.userId),
        ),
        outcome,
      ).toBe("23514");
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "expired" },
    ]);
  });
});

// ---- Database rules on an open shift -------------------------------------------------

describe("legend-3l4q cash_movement_outcomes (database rules, open shift)", () => {
  it("legend-3l4q: an 'approved' outcome by someone other than the recorder is accepted on an open shift", async () => {
    const { shift, movementId } = await heldWithSale(0);

    expect(
      await pgCode(() =>
        insertOutcomeBy(shift.id, movementId, "approved", supervisor.userId),
      ),
    ).toBeUndefined();
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: movementId, outcome: "approved" },
    ]);
  });

  it("legend-3l4q: an 'approved' or 'rejected' outcome decided by the movement's own recorder is refused (23514)", async () => {
    const { cashier, shift, movementId } = await heldWithSale(0);

    for (const outcome of ["approved", "rejected"] as const)
      expect(
        await pgCode(() =>
          insertOutcomeBy(shift.id, movementId, outcome, cashier.userId),
        ),
        outcome,
      ).toBe("23514");
    expect(await outcomesOf(shift.id)).toEqual([]);
  });
});

// ---- 7. Journal (legend-ym2kr) -------------------------------------------------------

describe("legend-ym2kr a held cash out reaches the ledger only when approved", () => {
  it("legend-ym2kr: approve gives exactly one journal under aj:cash-movement:<id>; replaying every stored event and the approve keeps it one", async () => {
    const { shift, movementId } = await heldWithSale(100_000);
    await enableAccounting(shift.businessDate);

    // Held and recorded: nothing posts.
    await deliverMovementEvents(movementId);
    expect(await journalsOfMovement(movementId)).toBe(0);

    await decide(supervisor, movementId, "approved");
    await deliverMovementEvents(movementId);
    expect(await journalsOfMovement(movementId)).toBe(1);

    // Replays: the approve call again, and every event delivered again.
    await decide(supervisor, movementId, "approved");
    await deliverMovementEvents(movementId);
    await deliverMovementEvents(movementId);
    expect(await journalsOfMovement(movementId)).toBe(1);
  });

  it("legend-ym2kr: a rejected held cash out never posts a journal", async () => {
    const { shift, movementId } = await heldWithSale(100_000);
    await enableAccounting(shift.businessDate);

    await decide(supervisor, movementId, "rejected");
    await deliverMovementEvents(movementId);

    expect(await journalsOfMovement(movementId)).toBe(0);
  });

  it("legend-ym2kr: a held cash out left undecided never posts, and closing the shift (expiry) posts nothing for it either", async () => {
    const { cashier, shift, movementId } = await heldWithSale(0);
    await enableAccounting(shift.businessDate);

    await deliverMovementEvents(movementId);
    expect(await journalsOfMovement(movementId)).toBe(0);

    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await deliverMovementEvents(movementId);
    expect(await journalsOfMovement(movementId)).toBe(0);
  });

  it("legend-ym2kr: an approved held drop changes the drawer but never posts a journal", async () => {
    const cashier = await newCashier("Kasir Setor");
    const shift = await openShift(cashier);
    await enableAccounting(shift.businessDate);
    // A Rp120.000 drop on a Rp100.000 drawer is held.
    const dropped = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: 120_000,
      reasonNote: "Setor ke brankas",
    });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(201);
    const [row] = await movementsOf(shift.id);
    expect(row!.needs_approval).toBe(true);
    await seedCashSale(shift, cashier, 100_000);

    await decide(supervisor, row!.id, "approved");

    // Drawer: 200.000 - 120.000 = 80.000, counted once.
    expect(await drawerNow(cashier, shift.id, 80_000)).toMatchObject({
      expected: 80_000,
      held: 0,
    });
    await deliverMovementEvents(row!.id);
    expect(await journalsOfMovement(row!.id)).toBe(0);
  });
});

// ---- 8. What each reader sees of a decision ------------------------------------------

describe("legend-3l4q the decision shows on the supervisor's read only", () => {
  // Assumptions: the contract (posCashMovementSchema) says `outcome` is sent
  // together with `needsApproval`, only to callers that see live figures
  // (supervisor reads), "approved" | "rejected" | "expired" once decided and
  // null while still pending; the shift's own cashier never gets the key. Both
  // reads (GET .../cash-movements and the shift report) follow the same rule.
  it("legend-3l4q: a supervisor sees outcome approved / rejected / null on held rows (list and shift report); the cashier's own read has no outcome key", async () => {
    const cashier = await newCashier("Kasir Hasil");
    const shift = await openShift(cashier);
    // Three cash outs larger than the Rp100.000 drawer: all held when recorded.
    const amounts = { approved: 150_000, rejected: 120_000, pending: 130_000 };
    for (const [label, amountIdr] of Object.entries(amounts)) {
      const recorded = await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr,
        reasonNote: `Kas keluar ${label}`,
      });
      expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    }
    const idOf = Object.fromEntries(
      (await movementsOf(shift.id)).map((row) => {
        expect(row.needs_approval).toBe(true);
        return [row.amount, row.id];
      }),
    ) as Record<number, string>;
    // Fill the drawer so the approve is allowed (expected Rp300.000 >= 150.000).
    await seedCashSale(shift, cashier, 200_000);
    await decide(supervisor, idOf[amounts.approved]!, "approved");
    await decide(supervisor, idOf[amounts.rejected]!, "rejected");

    const outcomes = (rows: { id: string; outcome?: unknown }[]) =>
      Object.fromEntries(rows.map((row) => [row.id, row.outcome]));
    const expected = {
      [idOf[amounts.approved]!]: "approved",
      [idOf[amounts.rejected]!]: "rejected",
      [idOf[amounts.pending]!]: null,
    };

    const listed = await listMovementsOf(supervisor, shift.id);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(outcomes(listed.body.data)).toEqual(expected);
    for (const row of listed.body.data)
      expect(row.needsApproval, "held rows keep the flag").toBe(true);
    const read = await shiftReport(supervisor, shift.id);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(outcomes(read.body.data.movements)).toEqual(expected);

    const mine = await listMovementsOf(cashier, shift.id);
    const mineReport = await shiftReport(cashier, shift.id);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mineReport.status, JSON.stringify(mineReport.body)).toBe(200);
    expect(mine.body.data).toHaveLength(3);
    expect(mineReport.body.data.movements).toHaveLength(3);
    for (const row of [...mine.body.data, ...mineReport.body.data.movements]) {
      expect(row).not.toHaveProperty("outcome");
      expect(row).not.toHaveProperty("needsApproval");
    }
  });
});

function listMovementsOf(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}/cash-movements`)
    .set(headers)
    .set(originHeader);
}

function shiftReport(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}`)
    .set(headers)
    .set(originHeader);
}
