// Reproduction of legend-y9bf (tier K): a held manual cash out / drop
// (cash_movements.needs_approval = true, legend-67dt) is NOT disbursed, so at
// the shift close (normal and force) it expires instead of being booked.
// Acceptance: POS-03 "Tutup shift memakai blind count; selisih kas tidak dapat
// disembunyikan atau diubah setelah disetujui".
//
// CTO rule (bd show legend-y9bf), written against the DESIGN's names:
//   - new append-only table `cash_movement_outcomes` (outcome expired /
//     approved / rejected, UNIQUE (tenant_id, movement_id)); a trigger refuses
//     'approved' outright (no approval flow updates the drawer yet,
//     legend-3l4q) and 'rejected' once the movement's shift is closed;
//   - new column `pos_shifts.difference_idr` (the difference the close booked;
//     NULL on shifts closed before the change);
//   - day report device row field `expiredCashOutIdr`;
//   - audit action `pos_shift.cash_movement_expired`, one row per expired
//     movement.
// Tests that need the not-yet-existing schema fail by error before the change;
// that is expected. Each test asserts the CORRECT behaviour.
//
// Fixtures are trimmed copies of pos-shift-codex146.test.ts (real Express app,
// Better Auth, RBAC and PostgreSQL with RLS in a fresh isolated tenant).
//
// Assumptions (the rule leaves them open):
//  - A close whose booked difference is 0 is sent WITHOUT a varianceNote: the
//    note is required exactly when the booked difference is not 0, and the
//    cashier must never learn that a cash out was held (legend-utqr).
//  - The expiry audit row mirrors the held audit: objectId = the movement id,
//    maskedChanges.after.shiftId = the shift.
//  - A refused outcome insert is a check_violation (23514); a second outcome
//    for one movement is a unique_violation (23505).
//  - The day report is read with a role holding order.view, pos.day.close,
//    shift.cash.operate and shift.cash.approve_close (as pos-day.test.ts).
//  - A legacy shift is emulated by a closed shift whose difference_idr is set
//    back to NULL and whose stored event is rewritten, as the owner with
//    session_replication_role = replica (the closed rows are append-only).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
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
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
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

// ---- Fixtures (trimmed copies of pos-shift-codex146.test.ts) -----------------------

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

async function newCashier(label = "Kasir"): Promise<Cashier> {
  const base = await member(roleIds.cashier, label);
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

function forceClose(
  who: Member,
  shiftId: string,
  body: Record<string, unknown>,
) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/force-close`)
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

async function pinOverride(caller: Member, countId: string) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    caller.userId,
    {
      outletId: tenant.outletId,
      action: "cash_shift_close",
      valueIdr: 0,
      reason: "Hitung kas akhir shift",
      objectType: "pos_shift_count",
      objectId: countId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  return override;
}

/** Force close by a supervisor with a forced count of `countedIdr`. */
async function forceCloseShift(shiftId: string, countedIdr: number) {
  const caller = await member(roleIds.supervisor, "Supervisor Paksa");
  const forced = await submitCount(caller, shiftId, {
    counts: countsFor(countedIdr),
  });
  expect(forced.status, JSON.stringify(forced.body)).toBe(201);
  const forcedCount = posShiftCountReceiptSchema.parse(forced.body.data);
  await pinOverride(caller, forcedCount.id);
  return forceClose(caller, shiftId, {
    countId: forcedCount.id,
    note: "Kasir gagal menghitung kas tiga kali",
    approvedBy: supervisor.userId,
    approvalRequestId: randomUUID(),
  });
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

// ---- Accounting fixtures (same chart as pos-shift-codex146.test.ts F2) --------------

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

/** The stored event, handed to the auto-journal consumer. */
async function deliverClosedEvent(shiftId: string) {
  const event = eventEnvelopeSchema.parse(await closedEventRow(shiftId));
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(
      context,
      event,
      tx,
      new Date(Date.now() + 60 * 60 * 1000),
    ),
  );
}

async function journalCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return rows[0]!.n;
}

async function parkedCount(shiftId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM auto_journal_parked
      WHERE tenant_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
    [tenant.tenantId, shiftId],
  );
  return rows[0]!.n;
}

async function storedDifference(shiftId: string): Promise<number | null> {
  const { rows } = await owner.query<{ difference: string | null }>(
    "SELECT difference_idr::text AS difference FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, shiftId],
  );
  const value = rows[0]!.difference;
  return value === null ? null : Number(value);
}

// ---- Movements, outcomes, audits -----------------------------------------------------

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

async function expiredAudits(shiftId: string) {
  const { rows } = await owner.query<{
    event: {
      objectId: string;
      objectType: string;
      maskedChanges: { after: Record<string, unknown> };
    };
  }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'pos_shift.cash_movement_expired'
        AND event->'maskedChanges'->'after'->>'shiftId' = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, shiftId],
  );
  return rows.map((row) => row.event);
}

function insertOutcome(
  shiftId: string,
  movementId: string,
  outcome: "expired" | "approved" | "rejected",
  decidedBy: string = supervisor.userId,
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

/** One held cash out of Rp150.000 on a fresh shift (the drawer holds only the float). */
async function shiftWithHeldCashOut(label = "Kasir") {
  const cashier = await newCashier(label);
  const shift = await openShift(cashier);
  const held = await move(cashier, shift.id, {
    type: "cash_out",
    amountIdr: HELD_IDR,
    reasonNote: "Beli gas elpiji",
  });
  expect(held.status, JSON.stringify(held.body)).toBe(201);
  return { cashier, shift };
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `held-expire-${randomUUID().slice(0, 6)}`,
  );
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Held Expire", ["shift.cash.operate"]],
    [
      roleIds.supervisor,
      "Supervisor Held Expire",
      ["shift.cash.approve_close"],
    ],
    [
      roleIds.manager,
      "Manajer Held Expire",
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

// ---- Booking: the held cash out never reaches the ledger --------------------------

describe("POS-03 legend-y9bf booking at close: a held cash out is not part of the booked difference", () => {
  it("legend-y9bf: expected Rp100.000, held cash out Rp150.000, count Rp100.000 closes with differenceIdr 0, no journal and nothing parked", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    await enableAccounting(shift.businessDate);

    // No varianceNote: the booked difference is 0, so none may be required.
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      // Blind close (legend-4wrfd): the cashier's answer carries no expected.
      expectedIdr: null,
      countedIdr: FLOAT_IDR,
    });

    const payload = (await closedEventRow(shift.id)).payload;
    expect(Number(payload.differenceIdr)).toBe(0);
    expect(await storedDifference(shift.id)).toBe(0);

    const before = await journalCount();
    await deliverClosedEvent(shift.id);
    expect(await journalCount()).toBe(before);
    expect(await parkedCount(shift.id)).toBe(0);
  });

  it("legend-y9bf: the same held cash out with a count of Rp90.000 books a Rp10.000 shortage journal and parks nothing", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    await enableAccounting(shift.businessDate);

    const closed = await closeShift(cashier, shift.id, FLOAT_IDR - 10_000, {
      varianceNote: "Uang kembalian kurang Rp10.000",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const payload = (await closedEventRow(shift.id)).payload;
    expect(Number(payload.differenceIdr)).toBe(-10_000);
    expect(await storedDifference(shift.id)).toBe(-10_000);

    const before = await journalCount();
    const result = await deliverClosedEvent(shift.id);
    expect(result.status, JSON.stringify(result)).toBe("posted");
    expect(await journalCount()).toBe(before + 1);
    expect(await parkedCount(shift.id)).toBe(0);
  });

  it("legend-y9bf: force close with a held cash out of Rp150.000 and a forced count of Rp100.000 books differenceIdr 0, no journal and nothing parked", async () => {
    const { shift } = await shiftWithHeldCashOut();
    await enableAccounting(shift.businessDate);

    const forced = await forceCloseShift(shift.id, FLOAT_IDR);
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);

    expect(Number((await closedEventRow(shift.id)).payload.differenceIdr)).toBe(
      0,
    );
    expect(await storedDifference(shift.id)).toBe(0);
    const before = await journalCount();
    await deliverClosedEvent(shift.id);
    expect(await journalCount()).toBe(before);
    expect(await parkedCount(shift.id)).toBe(0);
  });
});

// ---- Held refund cash keeps today's rule ------------------------------------------

describe("POS-03 legend-y9bf held refund cash is still booked by its own event", () => {
  // Cash sale Rp11.000, held cash refund of Rp1.000 paid out of the drawer. The
  // expected cash leaves the held refund out (Rp111.000), so a drawer holding
  // Rp110.000 is a variance of -Rp1.000 that the refund event already books.
  async function shiftWithHeldRefund() {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const orderId = await seedCashSale(shift, cashier, 11_000);
    await seedHeldRefund(shift.id, orderId, cashier, 1_000);
    await enableAccounting(shift.businessDate);
    return { cashier, shift };
  }

  it("legend-y9bf: count = expected - refund closes with differenceIdr 0 (stored difference_idr 0), posts nothing and parks nothing", async () => {
    const { cashier, shift } = await shiftWithHeldRefund();
    const closed = await closeShift(
      cashier,
      shift.id,
      FLOAT_IDR + 11_000 - 1_000,
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(Number((await closedEventRow(shift.id)).payload.differenceIdr)).toBe(
      0,
    );
    expect(await storedDifference(shift.id)).toBe(0);
    const before = await journalCount();
    await deliverClosedEvent(shift.id);
    expect(await journalCount()).toBe(before);
    expect(await parkedCount(shift.id)).toBe(0);
  });

  it("legend-y9bf: an extra Rp5.000 shortage on top of the refund books Rp5.000 (not the Rp6.000 variance) and parks nothing", async () => {
    const { cashier, shift } = await shiftWithHeldRefund();
    const closed = await closeShift(
      cashier,
      shift.id,
      FLOAT_IDR + 11_000 - 1_000 - 5_000,
      {
        varianceNote: "Uang kembalian kurang Rp5.000",
      },
    );
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(Number((await closedEventRow(shift.id)).payload.differenceIdr)).toBe(
      -5_000,
    );
    expect(await storedDifference(shift.id)).toBe(-5_000);
    const before = await journalCount();
    const result = await deliverClosedEvent(shift.id);
    expect(result.status, JSON.stringify(result)).toBe("posted");
    expect(await journalCount()).toBe(before + 1);
    expect(await parkedCount(shift.id)).toBe(0);
  });
});

// ---- Expiry outcome rows and audits -----------------------------------------------

describe("POS-03 legend-y9bf held cash movements expire at close", () => {
  /** Rp10.000 cash out that fits the drawer, then a Rp150.000 cash out that is held. */
  async function shiftWithNormalAndHeld() {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const fits = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Beli es batu",
    });
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    const held = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: HELD_IDR,
      reasonNote: "Beli gas elpiji",
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const rows = await movementsOf(shift.id);
    const heldRow = rows.find((row) => row.needs_approval)!;
    const normalRow = rows.find((row) => !row.needs_approval)!;
    expect(heldRow.amount).toBe(HELD_IDR);
    expect(normalRow.amount).toBe(10_000);
    return { cashier, shift, heldRow, normalRow };
  }

  it("legend-y9bf: a normal close stores one 'expired' outcome and one pos_shift.cash_movement_expired audit for the held movement, none for the normal one", async () => {
    const { cashier, shift, heldRow } = await shiftWithNormalAndHeld();
    expect(await outcomesOf(shift.id)).toEqual([]);
    expect(await expiredAudits(shift.id)).toEqual([]);

    // Drawer: Rp100.000 float - Rp10.000 = Rp90.000; the held out left nothing.
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR - 10_000);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: heldRow.id, outcome: "expired" },
    ]);
    const audits = await expiredAudits(shift.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.objectId).toBe(heldRow.id);
  });

  it("legend-y9bf: a force close expires the held movement the same way", async () => {
    const { shift, heldRow } = await shiftWithNormalAndHeld();
    const forced = await forceCloseShift(shift.id, FLOAT_IDR - 10_000);
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);

    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: heldRow.id, outcome: "expired" },
    ]);
    const audits = await expiredAudits(shift.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.objectId).toBe(heldRow.id);
  });

  it("legend-y9bf: two held movements give two outcomes and two audits; a shift with no held movement gets none", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    const second = await move(cashier, shift.id, {
      type: "drop",
      amountIdr: 120_000,
      reasonNote: "Setor ke brankas",
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(
      (await movementsOf(shift.id)).filter((row) => row.needs_approval),
    ).toHaveLength(2);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await outcomesOf(shift.id)).map((row) => row.outcome)).toEqual([
      "expired",
      "expired",
    ]);
    expect(await expiredAudits(shift.id)).toHaveLength(2);

    const plain = await newCashier();
    const plainShift = await openShift(plain);
    const plainClosed = await closeShift(plain, plainShift.id, FLOAT_IDR);
    expect(plainClosed.status, JSON.stringify(plainClosed.body)).toBe(200);
    expect(await outcomesOf(plainShift.id)).toEqual([]);
    expect(await expiredAudits(plainShift.id)).toEqual([]);
  });
});

// ---- The database refuses a decision after the expiry -----------------------------

describe("POS-03 legend-y9bf cash_movement_outcomes (database rules)", () => {
  it("legend-y9bf: after close an 'approved' or 'rejected' outcome for the expired movement is refused, and the outcome stays 'expired'", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    const [held] = await movementsOf(shift.id);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: held!.id, outcome: "expired" },
    ]);

    for (const outcome of ["approved", "rejected"] as const)
      expect(
        await pgCode(() => insertOutcome(shift.id, held!.id, outcome)),
        outcome,
      ).toBe("23514");
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: held!.id, outcome: "expired" },
    ]);
  });

  it("legend-y9bf: an 'approved' outcome is allowed on an open shift for a decider other than the recorder (legend-3l4q), refused for the recorder and on a closed shift", async () => {
    // Open shift: the recorder's own approval is refused, another user's is stored.
    const open = await shiftWithHeldCashOut();
    const [held] = await movementsOf(open.shift.id);
    expect(
      await pgCode(() =>
        insertOutcome(open.shift.id, held!.id, "approved", open.cashier.userId),
      ),
    ).toBe("23514");
    expect(await outcomesOf(open.shift.id)).toEqual([]);
    expect(
      await pgCode(() => insertOutcome(open.shift.id, held!.id, "approved")),
    ).toBeUndefined();
    expect(await outcomesOf(open.shift.id)).toEqual([
      { movement_id: held!.id, outcome: "approved" },
    ]);

    // Closed shift: the held movement expired at close, 'approved' is refused.
    const { cashier, shift } = await shiftWithHeldCashOut();
    const [heldClosed] = await movementsOf(shift.id);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(
      await pgCode(() => insertOutcome(shift.id, heldClosed!.id, "approved")),
    ).toBe("23514");
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: heldClosed!.id, outcome: "expired" },
    ]);
  });

  it("legend-y9bf: on an open shift a 'rejected' outcome is stored, a second outcome is refused, and the close neither expires nor books it", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    const [held] = await movementsOf(shift.id);

    expect(
      await pgCode(() => insertOutcome(shift.id, held!.id, "rejected")),
    ).toBeUndefined();
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: held!.id, outcome: "rejected" },
    ]);
    for (const [outcome, code] of [
      ["approved", "23505"],
      ["rejected", "23505"],
      ["expired", "23505"],
    ] as const)
      expect(
        await pgCode(() => insertOutcome(shift.id, held!.id, outcome)),
        outcome,
      ).toBe(code);

    // The drawer still holds only the float: nothing to book, no note needed.
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: held!.id, outcome: "rejected" },
    ]);
    expect(await expiredAudits(shift.id)).toEqual([]);
    expect(Number((await closedEventRow(shift.id)).payload.differenceIdr)).toBe(
      0,
    );
    expect(await storedDifference(shift.id)).toBe(0);
  });

  it("legend-y9bf: a direct UPDATE closing a shift with a difference_idr other than variance + the count's held correction is refused", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
    let message = "";
    try {
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE pos_shifts s
              SET status = 'closed', count_id = c.id, counted_idr = c.counted_idr,
                  expected_idr = c.expected_idr, variance_idr = c.variance_idr,
                  held_cash_out_idr = c.held_cash_out_idr,
                  difference_idr = c.variance_idr + c.held_cash_out_idr
             FROM pos_shift_counts c
            WHERE s.tenant_id = $1 AND s.id = $2
              AND c.tenant_id = s.tenant_id AND c.id = $3`,
          [tenant.tenantId, shift.id, count.id],
        ),
      );
    } catch (error) {
      message = String((error as { message?: string }).message);
      expect((error as { code?: string }).code).toBe("23514");
    }
    expect(message).toMatch(/must book its count's difference/);
  });

  it("legend-y9bf: an outcome for a movement that was not held is refused, and so is one naming another shift", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const normal = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Beli es batu",
    });
    expect(normal.status, JSON.stringify(normal.body)).toBe(201);
    const [fits] = await movementsOf(shift.id);
    expect(fits!.needs_approval).toBe(false);
    expect(
      await pgCode(() => insertOutcome(shift.id, fits!.id, "rejected")),
    ).toBe("23514");

    const { shift: otherShift } = await shiftWithHeldCashOut();
    const [otherHeld] = await movementsOf(otherShift.id);
    expect(
      await pgCode(() => insertOutcome(shift.id, otherHeld!.id, "rejected")),
    ).toBeDefined();
    expect(await outcomesOf(shift.id)).toEqual([]);
  });

  it("legend-y9bf: an outcome row cannot be updated or deleted afterwards", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    const [held] = await movementsOf(shift.id);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    expect(
      await pgCode(() =>
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(
            "UPDATE cash_movement_outcomes SET outcome = 'approved' WHERE tenant_id = $1 AND movement_id = $2",
            [tenant.tenantId, held!.id],
          ),
        ),
      ),
    ).toBeDefined();
    expect(
      await pgCode(() =>
        asOwnerTenant(tenant.tenantId, (client) =>
          client.query(
            "DELETE FROM cash_movement_outcomes WHERE tenant_id = $1 AND movement_id = $2",
            [tenant.tenantId, held!.id],
          ),
        ),
      ),
    ).toBeDefined();
    expect(await outcomesOf(shift.id)).toEqual([
      { movement_id: held!.id, outcome: "expired" },
    ]);
  });
});

// ---- Day report -------------------------------------------------------------------

type DeviceRow = {
  deviceId: string;
  cashVarianceIdr: number | string;
  expiredCashOutIdr?: number | string;
};

describe("POS-05 legend-y9bf the day report shows the expired held cash", () => {
  it("legend-y9bf: the device row shows expiredCashOutIdr = Rp150.000 and cashVarianceIdr 0 (from difference_idr), not Rp150.000 of variance", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const report = await manager.client
      .get(
        `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day?businessDate=${encodeURIComponent(shift.businessDate)}`,
      )
      .set(headers)
      .set(originHeader);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const device = (report.body.data.devices as DeviceRow[]).find(
      (row) => row.deviceId === cashier.deviceId,
    );
    expect(device, "device row of the cashier's till").toBeDefined();
    expect(Number(device!.expiredCashOutIdr)).toBe(HELD_IDR);
    expect(Number(device!.cashVarianceIdr)).toBe(0);
  });

  it("legend-y9bf: a device whose shift had no held cash out shows expiredCashOutIdr 0", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR + 1_000, {
      varianceNote: "Kelebihan kas dicek supervisor",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);

    const report = await manager.client
      .get(
        `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day?businessDate=${encodeURIComponent(shift.businessDate)}`,
      )
      .set(headers)
      .set(originHeader);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const device = (report.body.data.devices as DeviceRow[]).find(
      (row) => row.deviceId === cashier.deviceId,
    );
    expect(Number(device!.expiredCashOutIdr)).toBe(0);
    expect(Number(device!.cashVarianceIdr)).toBe(1_000);
  });
});

// ---- Legacy shifts (difference_idr NULL) ------------------------------------------

describe("POS-03 legend-y9bf legacy shifts closed before the change", () => {
  /**
   * Turn a freshly closed shift into one closed by the old code: difference_idr
   * NULL and an event whose differenceIdr / heldCashOutIdr carry `legacyIdr`.
   */
  async function makeLegacy(shiftId: string, legacyIdr: number | null) {
    const event = await closedEventRow(shiftId);
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        // The old close stored a note whenever variance + held ≠ 0
        // (pos_shifts_closed_check), so the legacy row carries one.
        "UPDATE pos_shifts SET difference_idr = NULL, variance_note = coalesce(variance_note, 'legacy close') WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, shiftId],
      );
      if (legacyIdr === null) return;
      const asStored = (value: number) =>
        JSON.stringify(
          typeof event.payload.differenceIdr === "string"
            ? String(value)
            : value,
        );
      await client.query(
        `UPDATE domain_event_outbox
            SET event = jsonb_set(jsonb_set(event, '{payload,differenceIdr}', $3::jsonb),
                                  '{payload,heldCashOutIdr}', $3::jsonb)
          WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
            AND event->'payload'->>'shiftId' = $2`,
        [tenant.tenantId, shiftId, asStored(legacyIdr)],
      );
    });
  }

  it("legend-y9bf: a legacy shift (difference_idr NULL) whose event differenceIdr differs from its variance is still parked as POSTING_AMOUNTS_MISMATCH", async () => {
    const { cashier, shift } = await shiftWithHeldCashOut();
    await enableAccounting(shift.businessDate);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    // What the old code stored: variance 0, held Rp150.000 added to the difference.
    await makeLegacy(shift.id, HELD_IDR);

    const before = await journalCount();
    const result = await deliverClosedEvent(shift.id);
    expect(result).toMatchObject({
      status: "parked",
      code: "POSTING_AMOUNTS_MISMATCH",
    });
    expect(await journalCount()).toBe(before);
    expect(await parkedCount(shift.id)).toBe(1);
  });

  it("legend-y9bf: a legacy shift whose event differenceIdr equals its variance still posts normally", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await enableAccounting(shift.businessDate);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR - 5_000, {
      varianceNote: "Uang kembalian kurang Rp5.000",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    await makeLegacy(shift.id, null);
    expect(await storedDifference(shift.id)).toBeNull();

    const before = await journalCount();
    const result = await deliverClosedEvent(shift.id);
    expect(result.status, JSON.stringify(result)).toBe("posted");
    expect(await journalCount()).toBe(before + 1);
    expect(await parkedCount(shift.id)).toBe(0);
  });
});

// ---- The cashier never learns that a cash out was held ----------------------------

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_PATTERN =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;

/** Ids and timestamps blanked, so two responses compare by shape and figures. */
function normalised(body: unknown): string {
  return JSON.stringify(body)
    .replace(UUID_PATTERN, "<id>")
    .replace(TIMESTAMP_PATTERN, "<time>");
}

describe("POS-03 legend-y9bf the cashier's responses do not reveal a held or expired cash out", () => {
  it("legend-y9bf: count and close answers are identical with and without a held Rp150.000 cash out, and hold no held or expired figure", async () => {
    const heldRun = await shiftWithHeldCashOut();
    const plain = await newCashier();
    const plainShift = await openShift(plain);

    const heldCount = await submitCount(heldRun.cashier, heldRun.shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    const plainCount = await submitCount(plain, plainShift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(heldCount.status, JSON.stringify(heldCount.body)).toBe(201);
    expect(plainCount.status, JSON.stringify(plainCount.body)).toBe(201);
    expect(normalised(heldCount.body)).toBe(normalised(plainCount.body));

    const heldClosed = await close(heldRun.cashier, heldRun.shift.id, {
      countId: heldCount.body.data.id,
      ...(await approvalFor(heldRun.cashier, heldCount.body.data.id)),
    });
    const plainClosed = await close(plain, plainShift.id, {
      countId: plainCount.body.data.id,
      ...(await approvalFor(plain, plainCount.body.data.id)),
    });
    expect(heldClosed.status, JSON.stringify(heldClosed.body)).toBe(200);
    expect(plainClosed.status, JSON.stringify(plainClosed.body)).toBe(200);
    expect(normalised(heldClosed.body)).toBe(normalised(plainClosed.body));

    for (const body of [heldCount.body, heldClosed.body])
      expect(JSON.stringify(body)).not.toMatch(
        /held|expire|needs_?approval|150000|150\.000/i,
      );
  });

  it("legend-y9bf: force close answers are identical with and without a held Rp150.000 cash out", async () => {
    const heldRun = await shiftWithHeldCashOut();
    const plain = await newCashier();
    const plainShift = await openShift(plain);
    const heldForced = await forceCloseShift(heldRun.shift.id, FLOAT_IDR);
    const plainForced = await forceCloseShift(plainShift.id, FLOAT_IDR);
    expect(heldForced.status, JSON.stringify(heldForced.body)).toBe(200);
    expect(plainForced.status, JSON.stringify(plainForced.body)).toBe(200);
    expect(normalised(heldForced.body)).toBe(normalised(plainForced.body));
    expect(JSON.stringify(heldForced.body)).not.toMatch(
      /held|expire|needs_?approval|150000|150\.000/i,
    );
  });

  it("legend-y9bf: the cashier's movement list after close has the same shape for a held and a normal cash out, with no held or expiry field", async () => {
    const heldRun = await shiftWithHeldCashOut();
    const plain = await newCashier();
    const plainShift = await openShift(plain);
    const fits = await move(plain, plainShift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Beli es batu",
    });
    expect(fits.status, JSON.stringify(fits.body)).toBe(201);
    expect(
      (await closeShift(heldRun.cashier, heldRun.shift.id, FLOAT_IDR)).status,
    ).toBe(200);
    expect(
      (await closeShift(plain, plainShift.id, FLOAT_IDR - 10_000)).status,
    ).toBe(200);

    const list = (who: Member, shiftId: string) =>
      who.client
        .get(`${SHIFTS()}/${shiftId}/cash-movements`)
        .set(headers)
        .set(originHeader);
    const heldList = await list(heldRun.cashier, heldRun.shift.id);
    const plainList = await list(plain, plainShift.id);
    expect(heldList.status, JSON.stringify(heldList.body)).toBe(200);
    expect(plainList.status, JSON.stringify(plainList.body)).toBe(200);
    /** Keys at every depth, so the two lists compare by shape only. */
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(shape)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [
                  key,
                  shape((value as Record<string, unknown>)[key]),
                ]),
            )
          : typeof value;
    expect(shape(heldList.body)).toEqual(shape(plainList.body));
    expect(JSON.stringify(heldList.body)).not.toMatch(
      /held|expire|needs_?approval|outcome/i,
    );
  });

  it("legend-y9bf: count and close answers are identical for a held and a normal cash refund (legend-4wrfd)", async () => {
    const runs = [];
    for (const needsApproval of [true, false]) {
      const cashier = await newCashier();
      const shift = await openShift(cashier);
      const orderId = await seedCashSale(shift, cashier, 11_000);
      await seedHeldRefund(shift.id, orderId, cashier, 1_000, needsApproval);
      const count = await submitCount(cashier, shift.id, {
        counts: countsFor(FLOAT_IDR + 11_000 - 1_000),
      });
      expect(count.status, JSON.stringify(count.body)).toBe(201);
      const closed = await close(cashier, shift.id, {
        countId: count.body.data.id,
        ...(await approvalFor(cashier, count.body.data.id)),
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      runs.push({ count: count.body, closed: closed.body });
    }
    const [held, normal] = runs;
    expect(normalised(held!.count)).toBe(normalised(normal!.count));
    expect(normalised(held!.closed)).toBe(normalised(normal!.closed));
    for (const body of [held!.count, held!.closed])
      expect(JSON.stringify(body)).not.toMatch(/held|needs_?approval/i);
  });
});
