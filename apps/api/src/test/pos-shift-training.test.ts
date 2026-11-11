// Training orders never touch the cashier drawer (legend-0v3b3; PRD v1.7 §3 F8
// "Shift Kasir", POS-03 blind-count close; twin of legend-gkc6b which keeps
// training orders out of the journal).
//
// A training order is stamped `pos_orders.is_training = true` at insert. Its
// cash tender, cash refund and cash void are play money: the shift's expected
// cash (and so the blind-count variance and the `cashier_shift.closed` journal)
// must ignore them. A mixed shift (one real + one training cash sale) expects
// float + the real sale only; counting exactly that closes with difference 0.
//
// Fixtures are trimmed copies of pos-shift-codex146.test.ts: real Express app,
// Better Auth, RBAC and PostgreSQL with RLS in a fresh isolated tenant, cash
// sales seeded straight into orders / pos_orders / pos_order_tenders.
//
// Assumptions (the brief leaves them open):
//  - Expected cash is observed through (a) the supervisor's live shift report
//    (`cashSalesIdr`, `cashRefundsIdr`), and (b) the blind count the cashier
//    submits: the stored `pos_shift_counts.expected_idr` / `variance_idr` and the
//    receipt's `noteRequired` (false when counted = expected). The cashier's own
//    reads are blind and are not used for figures.
//  - Cash refund / cash void of a training order are seeded the way the refund
//    and void writers store them: `pos_order_refunds` (one cash line) and
//    `pos_order_voids` with `shift_id` = the shift whose drawer paid out, not
//    held (`needs_approval = false`).
//  - Cases 2 and 3 sell the training order in ANOTHER shift (its tender's drawer)
//    and refund / void it in the shift under test. That way the old behaviour
//    (the refund / void leaves this drawer) cannot cancel against a sale in the
//    same drawer, and the test fails for the right reason. The mixed shift (4)
//    also refunds a training sale inside its own drawer.
//  - The `cashier_shift.closed` event books a signed `differenceIdr` (number or
//    numeric string, compared through Number); the auto-journal consumer answers
//    `{ status: "ignored" }` for a zero difference (same shape as
//    pos-shift-codex146.test.ts F2) and posts a journal for a real over, which
//    is the control that proves the accounting setup works.
//  - Isolation (6): a training order of shift B changes neither shift A nor the
//    real sales of shift B itself.
//  - Round 2 (7): the stored `pos_shift_counts.held_correction_idr` is the
//    observable of `heldCorrectionCashIdrOf` (the count stores it; close books
//    differenceIdr = variance + it). A held training refund / void must leave it
//    0 so a normal and a forced close book differenceIdr 0 (no fake shortage).
//    Control: a held refund of a REAL order is counted (stored value = its cash,
//    and the cashier who paid it out closes with booked difference 0).
//  - Round 2 (8): a QR pay-first cash tender has no `pos_orders` row; it is
//    seeded as an `orders` row (channel qr) + a captured cash tender on the shift.
//    The tender table has an FK to pos_orders, so that state is only reachable
//    with `session_replication_role = replica`; the test is a defensive guard of
//    the LEFT JOIN, not a flow the app produces today.

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
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const FLOAT_IDR = 100_000;

const roleIds = { cashier: randomUUID(), supervisor: randomUUID() };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
type Shift = { id: string; businessDate: string };
let supervisor: Member;

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

async function openShift(cashier: Cashier): Promise<Shift> {
  const response = await cashier.client
    .post(SHIFTS())
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as Shift;
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

function report(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}`)
    .set(headers)
    .set(originHeader);
}

type CountReceipt = {
  id: string;
  sequence: number;
  countedIdr: number;
  noteRequired: boolean;
};

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

/** The expected cash and variance the shift computed for a stored count. */
async function countRow(countId: string) {
  const { rows } = await owner.query<{ expected: number; variance: number }>(
    `SELECT expected_idr::float8 AS expected, variance_idr::float8 AS variance
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
  const valueIdr = Math.abs((await countRow(countId)).variance);
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

/**
 * A completed sale on the shift paid by cash or QRIS (cash lands in the
 * `drawer` shift, default the order's shift). `training` stamps
 * `pos_orders.is_training` at insert.
 */
async function seedSale(
  shift: Shift,
  cashier: Cashier,
  totalIdr: number,
  options: {
    method?: "cash" | "qris";
    training?: boolean;
    drawer?: Shift;
  } = {},
): Promise<string> {
  const orderId = randomUUID();
  const cash = (options.method ?? "cash") === "cash";
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
         (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id,
          submitted_at, completed_at, is_training)
       VALUES ($1, $2, $3, 'pos', $4, $5, $6, now(), now(), $7)`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        shift.id,
        cashier.deviceId,
        cashier.userId,
        options.training ?? false,
      ],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'captured', now(), now(), $9, $10)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        cash ? "cash" : "qris",
        cash ? "manual" : "doit",
        totalIdr,
        cash ? totalIdr : null,
        cash ? 0 : null,
        cashier.userId,
        cash ? (options.drawer ?? shift).id : null,
      ],
    );
  });
  return orderId;
}

/** A normal (not held) cash refund of the order, paid out of `shiftId`'s drawer. */
async function seedRefund(
  shiftId: string,
  orderId: string,
  cashier: Member,
  amountIdr: number,
  held = false,
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
        held,
      ],
    ),
  );
}

/** A normal (not held) void of the cash order, paid out of `shiftId`'s drawer. */
async function seedVoid(
  shiftId: string,
  orderId: string,
  cashier: Member,
  amountIdr: number,
  held = false,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_voids
         (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
          requested_by, approved_by, override_id, voided_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, $5, 'customer_cancelled', 'Pelanggan salah pesan',
               $6, $7, $8, now(), $9, $10)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        `SH-V-${orderId.slice(0, 8)}`,
        amountIdr,
        cashier.userId,
        supervisor.userId,
        randomUUID(),
        shiftId,
        held,
      ],
    ),
  );
}

/** A QR pay-first sale paid in cash at the shift's drawer: no `pos_orders` row at all. */
async function seedQrCashSale(
  shift: Shift,
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
       VALUES ($1, $2, $3, $4, 'qr', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', $8, now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `QR-${orderId.slice(0, 8)}`,
        totalIdr - tax,
        tax,
        totalIdr,
        shift.businessDate,
      ],
    );
    // pos_order_tenders has a foreign key (tenant_id, order_id) -> pos_orders, so a
    // tender without a pos_orders row cannot exist through normal writes. Switch the
    // FK trigger off for this one insert (LOCAL = this transaction only) to pin the
    // LEFT JOIN branch: a row with no pos_orders partner is real, never dropped.
    await client.query("SET LOCAL session_replication_role = replica");
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
    await client.query("SET LOCAL session_replication_role = origin");
  });
  return orderId;
}

/** What `heldCorrectionCashIdrOf` was when the count was stored. */
async function heldCorrectionOf(countId: string): Promise<number> {
  const { rows } = await owner.query<{ held: number | null }>(
    `SELECT held_correction_idr::float8 AS held
       FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, countId],
  );
  return Number(rows[0]!.held);
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

/** Live drawer figures, read as the supervisor (the cashier's own reads are blind). */
async function liveFigures(shiftId: string) {
  const response = await report(supervisor, shiftId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.shift as {
    cashSalesIdr: number;
    cashRefundsIdr: number;
  };
}

/** The counted cash equals what the drawer should hold: no note, variance 0. */
async function expectDrawerExpects(
  cashier: Member,
  shiftId: string,
  expectedIdr: number,
): Promise<CountReceipt> {
  const receipt = await countDrawer(cashier, shiftId, expectedIdr);
  expect(
    await countRow(receipt.id),
    "expected / variance of the count",
  ).toEqual({ expected: expectedIdr, variance: 0 });
  expect(receipt.noteRequired, "noteRequired").toBe(false);
  return receipt;
}

async function closedPayload(shiftId: string) {
  const { rows } = await owner.query<{
    payload: { differenceIdr: number | string };
  }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
        AND event->'payload'->>'shiftId' = $2`,
    [tenant.tenantId, shiftId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.payload;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`shifttrain-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Shift Latihan", ["shift.cash.operate"]],
    [
      roleIds.supervisor,
      "Supervisor Shift Latihan",
      ["shift.cash.approve_close"],
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

// ---- accounting (copied from pos-shift-codex146.test.ts F2) -------------------------

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

/** The stored `cashier_shift.closed` event of the shift, handed to the auto-journal consumer. */
async function deliverClosedEvent(shiftId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
        AND event->'payload'->>'shiftId' = $2`,
    [tenant.tenantId, shiftId],
  );
  expect(rows).toHaveLength(1);
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
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

// ---- Cases ----------------------------------------------------------------------------

describe("POS-03 legend-0v3b3: training orders stay out of the shift's expected cash", () => {
  it("1: a cash tender of a training order does not enter cashSalesIdr or the expected cash", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await seedSale(shift, cashier, 40_000, { training: true });

    expect(await liveFigures(shift.id)).toMatchObject({
      cashSalesIdr: 0,
      cashRefundsIdr: 0,
    });
    await expectDrawerExpects(cashier, shift.id, FLOAT_IDR);
  });

  it("2: a cash refund of a training order does not reduce the expected cash", async () => {
    const cashier = await newCashier();
    const earlier = await openShift(await newCashier("Kasir Pagi"));
    const shift = await openShift(cashier);
    // Sold (and its cash taken) in the earlier shift's drawer; refunded in this one.
    const trainingOrder = await seedSale(earlier, cashier, 40_000, {
      training: true,
    });
    await seedRefund(shift.id, trainingOrder, cashier, 15_000);
    await seedSale(shift, cashier, 30_000);

    expect(await liveFigures(shift.id)).toMatchObject({
      cashSalesIdr: 30_000,
      cashRefundsIdr: 0,
    });
    await expectDrawerExpects(cashier, shift.id, FLOAT_IDR + 30_000);
  });

  it("3: a cash void of a training order does not reduce the expected cash", async () => {
    const cashier = await newCashier();
    const earlier = await openShift(await newCashier("Kasir Pagi"));
    const shift = await openShift(cashier);
    const trainingOrder = await seedSale(earlier, cashier, 40_000, {
      training: true,
    });
    await seedVoid(shift.id, trainingOrder, cashier, 40_000);
    await seedSale(shift, cashier, 30_000);

    await expectDrawerExpects(cashier, shift.id, FLOAT_IDR + 30_000);
  });

  it("4: a mixed shift (one real, one training cash sale) expects float + the real sale; counting exactly that closes with difference 0 and posts no variance journal", async () => {
    const control = await newCashier("Kasir Kontrol");
    const controlShift = await openShift(control);
    await enableAccounting(controlShift.businessDate);

    // Control: a real cash over of Rp5.000 posts, so the accounting setup works.
    const over = await closeShift(control, controlShift.id, FLOAT_IDR + 5_000, {
      varianceNote: "Kelebihan kas dicek supervisor",
    });
    expect(over.status, JSON.stringify(over.body)).toBe(200);
    const posted = await deliverClosedEvent(controlShift.id);
    expect(posted.status, JSON.stringify(posted)).toBe("posted");
    const afterControl = await journalCount();
    expect(afterControl).toBeGreaterThan(0);

    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await seedSale(shift, cashier, 40_000);
    const trainingOrder = await seedSale(shift, cashier, 25_000, {
      training: true,
    });
    await seedRefund(shift.id, trainingOrder, cashier, 5_000);

    expect(await liveFigures(shift.id)).toMatchObject({
      cashSalesIdr: 40_000,
      cashRefundsIdr: 0,
    });
    const drawerIdr = FLOAT_IDR + 40_000;
    await expectDrawerExpects(cashier, shift.id, drawerIdr);

    const closed = await closeShift(cashier, shift.id, drawerIdr);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(Number((await closedPayload(shift.id)).differenceIdr)).toBe(0);

    const result = await deliverClosedEvent(shift.id);
    expect(result.status, JSON.stringify(result)).toBe("ignored");
    expect(await journalCount()).toBe(afterControl);
  });

  it("5 (control): a shift with no training order keeps its figures: float + cash sales - cash refunds, QRIS left out", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const sold = await seedSale(shift, cashier, 55_000);
    await seedSale(shift, cashier, 40_000, { method: "qris" });
    await seedRefund(shift.id, sold, cashier, 5_000);

    expect(await liveFigures(shift.id)).toMatchObject({
      cashSalesIdr: 55_000,
      cashRefundsIdr: 5_000,
    });
    const drawerIdr = FLOAT_IDR + 55_000 - 5_000;
    await expectDrawerExpects(cashier, shift.id, drawerIdr);
    const closed = await closeShift(cashier, shift.id, drawerIdr);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(Number((await closedPayload(shift.id)).differenceIdr)).toBe(0);
  });

  it("6: training orders of another shift change neither this shift nor the real sales of their own shift", async () => {
    const cashierA = await newCashier("Kasir A");
    const cashierB = await newCashier("Kasir B");
    const shiftA = await openShift(cashierA);
    const shiftB = await openShift(cashierB);
    await seedSale(shiftA, cashierA, 40_000);
    await seedSale(shiftB, cashierB, 20_000);
    const trainingOrder = await seedSale(shiftB, cashierB, 70_000, {
      training: true,
    });
    await seedRefund(shiftB.id, trainingOrder, cashierB, 10_000);
    await seedVoid(shiftA.id, trainingOrder, cashierA, 70_000);

    expect(await liveFigures(shiftA.id)).toMatchObject({
      cashSalesIdr: 40_000,
      cashRefundsIdr: 0,
    });
    expect(await liveFigures(shiftB.id)).toMatchObject({
      cashSalesIdr: 20_000,
      cashRefundsIdr: 0,
    });
    await expectDrawerExpects(cashierA, shiftA.id, FLOAT_IDR + 40_000);
    await expectDrawerExpects(cashierB, shiftB.id, FLOAT_IDR + 20_000);
  });
  it("7: a held cash refund and a held cash void of training orders leave heldCorrectionCashIdr at 0; normal close books difference 0", async () => {
    const cashier = await newCashier();
    const earlier = await openShift(await newCashier("Kasir Pagi"));
    const shift = await openShift(cashier);
    const refunded = await seedSale(earlier, cashier, 40_000, {
      training: true,
    });
    const voided = await seedSale(earlier, cashier, 25_000, { training: true });
    await seedRefund(shift.id, refunded, cashier, 15_000, true);
    await seedVoid(shift.id, voided, cashier, 25_000, true);
    await seedSale(shift, cashier, 30_000);

    const drawerIdr = FLOAT_IDR + 30_000;
    const receipt = await expectDrawerExpects(cashier, shift.id, drawerIdr);
    expect(await heldCorrectionOf(receipt.id)).toBe(0);

    const closed = await closeShift(cashier, shift.id, drawerIdr);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(Number((await closedPayload(shift.id)).differenceIdr)).toBe(0);
  });

  it("7 (force close): the same held training refund and void book difference 0 on a supervisor force close", async () => {
    const cashier = await newCashier();
    const forcer = await member(roleIds.supervisor, "Supervisor Paksa");
    const earlier = await openShift(await newCashier("Kasir Pagi"));
    const shift = await openShift(cashier);
    const refunded = await seedSale(earlier, cashier, 40_000, {
      training: true,
    });
    const voided = await seedSale(earlier, cashier, 25_000, { training: true });
    await seedRefund(shift.id, refunded, cashier, 15_000, true);
    await seedVoid(shift.id, voided, cashier, 25_000, true);
    await seedSale(shift, cashier, 30_000);

    const drawerIdr = FLOAT_IDR + 30_000;
    const count = await countDrawer(forcer, shift.id, drawerIdr);
    expect(await heldCorrectionOf(count.id)).toBe(0);
    const approval = await approvalFor(forcer, count.id);
    const closed = await forceClose(forcer, shift.id, {
      countId: count.id,
      note: "Kasir gagal menghitung kas tiga kali",
      ...approval,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(Number((await closedPayload(shift.id)).differenceIdr)).toBe(0);
  });

  it("7 (control): a held cash refund and a held cash void of REAL orders are still counted as held correction cash", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const refunded = await seedSale(shift, cashier, 40_000);
    const voided = await seedSale(shift, cashier, 25_000);
    await seedRefund(shift.id, refunded, cashier, 15_000, true);
    await seedVoid(shift.id, voided, cashier, 25_000, true);

    // Held cash is not subtracted from the expected cash; the cashier paid it
    // out, so the drawer holds 40.000 less than expected.
    const expectedIdr = FLOAT_IDR + 40_000 + 25_000;
    const countedIdr = expectedIdr - 40_000;
    const receipt = await countDrawer(cashier, shift.id, countedIdr);
    expect(await countRow(receipt.id)).toEqual({
      expected: expectedIdr,
      variance: -40_000,
    });
    expect(await heldCorrectionOf(receipt.id)).toBe(40_000);

    const approval = await approvalFor(cashier, receipt.id);
    const closed = await close(cashier, shift.id, {
      countId: receipt.id,
      varianceNote: "Refund dan void ditahan menunggu supervisor",
      ...approval,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    // variance (-40.000) + held correction (40.000): the paid-out cash is booked by its own events.
    expect(Number((await closedPayload(shift.id)).differenceIdr)).toBe(0);
  });

  it("8: a cash tender of an order without a pos_orders row (QR pay-first) still enters cashSalesIdr and the expected cash", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await seedQrCashSale(shift, cashier, 35_000);
    await seedSale(shift, cashier, 20_000, { training: true });

    expect(await liveFigures(shift.id)).toMatchObject({
      cashSalesIdr: 35_000,
      cashRefundsIdr: 0,
    });
    const drawerIdr = FLOAT_IDR + 35_000;
    await expectDrawerExpects(cashier, shift.id, drawerIdr);
    const closed = await closeShift(cashier, shift.id, drawerIdr);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(Number((await closedPayload(shift.id)).differenceIdr)).toBe(0);
  });
});
