// legend-ng3tf + legend-ayobh (+ money cap), brief 985, money, "Jangan sampai rugi".
// Follow-ups of order-charge-manual-refund-985.test.ts (same fixtures, own
// world). Written from the card texts, docs/briefs 120/121 (closed business day
// is refused with 409 BUSINESS_DAY_ALREADY_CLOSED) and the endpoints of the
// mrwtp design, never from the services.
//
// legend-ng3tf: approving a manual EDC refund AFTER the business day of the
//   charge's outlet was closed (Tutup Hari, `pos_daily_closes` row) must be
//   refused 409 BUSINESS_DAY_ALREADY_CLOSED, with no effect (refund stays
//   requested, no refund event, no journal entry). A day closed at ANOTHER
//   outlet changes nothing. The cash path is unchanged (a cash approve on an
//   open day still pays; a day cannot close while a shift is open, so cash is
//   not asserted on a synthetic closed day).
// legend-ayobh: reject of a manual refund. A staff member who holds
//   order.recovery.handle only at outlet A and pos.refund.approve only at outlet
//   B must not be falsely refused when WITHDRAWING THEIR OWN request (the
//   requester may always withdraw). They must still NOT be able to reject or
//   approve somebody else's request at outlet A (no approve permission there).
//   Other tenant/outlet untouched. (Not asserted, spec silent: approve @ A with
//   handle only @ B.)
// Money cap: manual refund + intent refund (nsvu0 route) never pass the charge
//   value, also with Promise.all; the journal stays balanced and each charge
//   keeps its own reservation. (Void + manual: order-charge-money-cap-985.test.ts.)
//
// ASSUMPTIONS (spec silent; adjust here if the engineer differs):
//  - The day that matters is the business date of the charge's order at the
//    charge's outlet (== today in these fixtures).
//  - "False reject" (ayobh) = a 403/404 for the requester withdrawing own request.
//  - Intent refund route on a cash/EDC charge (no intent): not 2xx, no
//    payment_refunds row. Manual refund request on a QRIS charge: 409.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  PRICES,
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import {
  owner,
  seededHostname,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

let w: World;
let foreignOwner: Staff;
let requester: Staff; // order.recovery.handle only
let approverA: Staff; // order.recovery.handle + pos.refund.approve
let approverB: Staff; // same role, a different person
let cashier: { client: ReturnType<typeof agent>; userId: string };
let shiftId = ""; // the main drawer (float 100.000)
let businessDate = "";
let terminalId = "";

const DEVICE_ID = randomUUID();
const AMOUNT = 8_085; // 7.000 + service 350 + PBJT 735 (standard order)
const DIFFERENCE = PRICES.kopi - PRICES.roti;
const REASON = "Tamu minta uang selisih swap dikembalikan";
const MAIN_FLOAT = 100_000;

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const deviceHeader = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function staffUser(
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
  label: string,
): Promise<Staff> {
  const client = agent(w.app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      w.tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId, email };
}

async function cashierWithRole(
  label: string,
  scopeOutletId: string,
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [
      roleId,
      w.tenant.tenantId,
      `Kasir ${label}`,
      JSON.stringify(["pos.payment.accept", "order.view"]),
    ],
  );
  const staff = await staffUser(
    roleId,
    { type: "outlet", outletId: scopeOutletId },
    `Kasir ${label}`,
  );
  return { client: staff.client, userId: staff.userId };
}

/** Gives an existing staff member one more role assignment (own scope). */
async function addAssignment(
  staff: Staff,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      w.tenant.tenantId,
      staff.userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
}

async function roleWith(name: string, permissions: string[]): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [roleId, w.tenant.tenantId, name, JSON.stringify(permissions)],
  );
  return roleId;
}

let handleRole = "";
let approveRole = "";
let splitRequester: Staff; // handle @ outlet A, pos.refund.approve @ outlet B only
let splitOther: Staff; // same split, a different person (never the requester)

beforeAll(async () => {
  w = await createWorld();
  foreignOwner = await staffWithRole(w.app, {
    template: "owner",
    label: "Pemilik Tenant Lain",
  });
  requester = w.supervisor;

  const approverRole = await roleWith("Penyetuju Refund Manual Uji", [
    "order.view",
    "order.recovery.handle",
    "pos.refund.approve",
  ]);
  approverA = await staffUser(approverRole, { type: "tenant" }, "Penyetuju A");
  approverB = await staffUser(approverRole, { type: "tenant" }, "Penyetuju B");

  handleRole = await roleWith("Penangan Pemulihan Uji", [
    "order.view",
    "order.recovery.handle",
  ]);
  approveRole = await roleWith("Penyetuju Saja Uji", [
    "order.view",
    "pos.refund.approve",
  ]);
  const outletA = w.tenant.outletId;
  const outletB = w.ids.otherOutlet;
  splitRequester = await staffUser(
    handleRole,
    { type: "outlet", outletId: outletA },
    "Split Peminta",
  );
  await addAssignment(splitRequester, approveRole, {
    type: "outlet",
    outletId: outletB,
  });
  splitOther = await staffUser(
    handleRole,
    { type: "outlet", outletId: outletA },
    "Split Lain",
  );
  await addAssignment(splitOther, approveRole, {
    type: "outlet",
    outletId: outletB,
  });

  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId: DEVICE_ID,
  });
  cashier = await cashierWithRole("Refund Manual", w.tenant.outletId);
  terminalId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-FU985', 'MID-FU985', 'Test EDC', 'lan',
               '10.0.0.9', ARRAY['card','qris'], 'active')`,
      [terminalId, w.tenant.tenantId, w.tenant.outletId],
    ),
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

// ---- shifts ------------------------------------------------------------------

async function insertShift(input: {
  cashierId: string;
  deviceId: string;
  outletId: string;
  floatIdr: number;
}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', $7, $8, $9)`,
    [
      id,
      w.tenant.tenantId,
      input.outletId,
      input.deviceId,
      input.cashierId,
      businessDate,
      input.floatIdr,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

async function expectedCashOf(shift: string): Promise<number> {
  return withTenant(db, contextOf(w.tenant.tenantId), async (tx) => {
    const [row] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shift));
    return liveExpectedCashIdr(tx, row!);
  });
}
const expectedCash = () => expectedCashOf(shiftId);

async function businessDateOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.d;
}

// ---- charges (real flow) -------------------------------------------------------

type ChargeRow = {
  id: string;
  status: string;
  payment_intent_id: string | null;
  cash_movement_id: string | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, status, payment_intent_id, cash_movement_id
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function chargeStatus(chargeId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]!.status;
}

/** A swap charge opened by the real flow. */
async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status).toBe(200);
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const charge = await chargeOf(issueId);
  if (!shiftId) {
    businessDate = await businessDateOf(order.order.id);
    shiftId = await insertShift({
      cashierId: cashier.userId,
      deviceId: DEVICE_ID,
      outletId: w.tenant.outletId,
      floatIdr: MAIN_FLOAT,
    });
  }
  return { ...order, issueId, charge };
}

function collect(chargeId: string, body: Record<string, unknown>) {
  return cashier.client
    .post(`/api/order-issue-charges/${chargeId}/collect-at-pos`)
    .set("Host", w.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(DEVICE_ID))
    .send(body);
}

async function ledgerSale(chargeId: string): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', 'approved', 'sale', 'ecr', $8,
               'APP123', $9, now())`,
      [
        id,
        w.tenant.tenantId,
        w.tenant.outletId,
        terminalId,
        chargeId,
        randomUUID(),
        AMOUNT,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
      ],
    ),
  );
  return id;
}

type Paid = Awaited<ReturnType<typeof openCharge>>;

/** Paid in cash at the till: cash_in on the main drawer, no intent. */
async function paidCashCharge(): Promise<Paid> {
  const opened = await openCharge();
  const res = await collect(opened.charge.id, {
    idempotencyKey: randomUUID(),
    method: "cash",
    receivedIdr: AMOUNT,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect((await chargeOf(opened.issueId)).status).toBe("paid");
  return opened;
}

/** Paid by an approved EDC card sale: no cash, no intent. */
async function paidEdcCharge(): Promise<Paid> {
  const opened = await openCharge();
  const sale = await ledgerSale(opened.charge.id);
  const res = await collect(opened.charge.id, {
    idempotencyKey: randomUUID(),
    method: "edc_card",
    edcTransactionId: sale,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = await chargeOf(opened.issueId);
  expect(row.status).toBe("paid");
  expect(row.cash_movement_id).toBeNull();
  expect(row.payment_intent_id).toBeNull();
  return opened;
}

/** Paid by QRIS (gateway intent): the intent refund path owns it. */
async function paidQrisCharge(): Promise<Paid> {
  const opened = await openCharge();
  const res = await collect(opened.charge.id, {
    idempotencyKey: randomUUID(),
    method: "qris",
  });
  expect([200, 201, 202], JSON.stringify(res.body)).toContain(res.status);
  const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
  expect(intentId).not.toBeNull();
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: AMOUNT,
    providerRef: `WEBHOOK-${randomUUID().slice(0, 8)}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(
      context,
      eventEnvelopeSchema.parse(rows[0]!.event),
      tx,
    ),
  );
  expect((await chargeOf(opened.issueId)).status).toBe("paid");
  return opened;
}

// ---- manual refund endpoints -----------------------------------------------------

type Method = "cash" | "edc";

const cashBody = (amountIdr: number) => ({
  amountIdr,
  reason: REASON,
  method: "cash" as Method,
});
const edcBody = (amountIdr: number, reference = freshRef()) => ({
  amountIdr,
  reason: REASON,
  method: "edc" as Method,
  reference,
});
const freshRef = () => `EDC-${randomUUID().slice(0, 8).toUpperCase()}`;

function requestRefund(
  chargeId: string,
  body: Record<string, unknown>,
  who: Staff = requester,
  host: string = w.tenant.hostname,
) {
  return who.client
    .post(
      `/api/order-issue-charges/${encodeURIComponent(chargeId)}/manual-refund`,
    )
    .set("Host", host)
    .set(originHeader)
    .send(body);
}

function approveRefund(
  id: string,
  body: Record<string, unknown> = {},
  who: Staff = approverA,
  host: string = w.tenant.hostname,
) {
  return who.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/approve`,
    )
    .set("Host", host)
    .set(originHeader)
    .send(body);
}

function rejectRefund(
  id: string,
  body: Record<string, unknown> = { reason: "Tidak jadi, tamu setuju lanjut" },
  who: Staff = approverA,
  host: string = w.tenant.hostname,
) {
  return who.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/reject`,
    )
    .set("Host", host)
    .set(originHeader)
    .send(body);
}

function expectOk(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}
const isOk = (res: { status: number }) => res.status >= 200 && res.status < 300;

type ManualRow = {
  id: string;
  method: string;
  amount_idr: number;
  status: string;
  reference: string | null;
  reason: string;
  requested_by: string;
  decided_by: string | null;
  shift_id: string | null;
  cash_movement_id: string | null;
  reject_reason: string | null;
};

async function manualRows(chargeId: string): Promise<ManualRow[]> {
  const { rows } = await owner.query<ManualRow>(
    `SELECT id, method, amount_idr::int AS amount_idr, status, reference, reason,
            requested_by, decided_by, shift_id, cash_movement_id, reject_reason
     FROM order_issue_charge_manual_refunds
     WHERE tenant_id = $1 AND charge_id = $2
     ORDER BY requested_at, id`,
    [w.tenant.tenantId, chargeId],
  );
  return rows;
}

async function sumOf(chargeId: string, statuses: string[]): Promise<number> {
  return (await manualRows(chargeId))
    .filter((row) => statuses.includes(row.status))
    .reduce((total, row) => total + row.amount_idr, 0);
}
const reserved = (chargeId: string) =>
  sumOf(chargeId, ["requested", "completed"]);
const completed = (chargeId: string) => sumOf(chargeId, ["completed"]);

/** Requests a refund and returns the new row (the request must succeed). */
async function request(
  chargeId: string,
  body: Record<string, unknown>,
  who: Staff = requester,
): Promise<ManualRow> {
  const before = new Set((await manualRows(chargeId)).map((row) => row.id));
  const res = await requestRefund(chargeId, body, who);
  expectOk(res);
  const fresh = (await manualRows(chargeId)).filter(
    (row) => !before.has(row.id),
  );
  expect(fresh, "one new requested row").toHaveLength(1);
  return fresh[0]!;
}

async function movementsByKey(key: string) {
  const { rows } = await owner.query<{
    id: string;
    type: string;
    amount_idr: number;
    shift_id: string;
  }>(
    `SELECT id, type, amount_idr::int AS amount_idr, shift_id FROM cash_movements
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [w.tenant.tenantId, key],
  );
  return rows;
}
const cashOutOf = (manualId: string) =>
  movementsByKey(`manual-charge-refund:${manualId}`);

async function movementCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_movements WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function refundedEvents(issueId: string) {
  return w.outboxRows("order_issue.charge_refunded", issueId);
}

// ---- reversal journal ----------------------------------------------------------

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "edc_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "service_charge";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas Outlet", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1203", "Kliring EDC", "asset", "current_asset"],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
];
let accounts: Record<Role, string> | null = null;

async function enableAccounting(): Promise<Record<Role, string>> {
  if (accounts) return accounts;
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    w.tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "accounting"],
      integrationProviders: [],
    }),
  ]);
  const made = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.tenant.tenantId, w.tenant.legalEntityId, code, name, type, group],
    );
    made[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [w.tenant.tenantId, w.tenant.legalEntityId, role, made[role]],
    );
  }
  const now = new Date();
  for (const shift of [-1, 0, 1]) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [
        w.tenant.tenantId,
        w.tenant.legalEntityId,
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      ],
    );
  }
  accounts = made;
  return made;
}

/** The worker, by hand: every outbox event of the tenant, in order. */
async function deliverAllOutboxToJournal() {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id = $1
     ORDER BY created_at, id`,
    [w.tenant.tenantId],
  );
  const context = contextOf(w.tenant.tenantId);
  for (const row of rows) {
    const event: EventEnvelope = eventEnvelopeSchema.parse(row.event);
    await withTenant(db, context, (tx) =>
      deliverAutoJournalEvent(context, event, tx),
    );
  }
}

async function balances(): Promise<Record<Role, number>> {
  const made = await enableAccounting();
  const out = {} as Record<Role, number>;
  for (const role of Object.keys(made) as Role[]) {
    const { rows } = await owner.query<{ balance: string | null }>(
      `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
      [w.tenant.tenantId, made[role]],
    );
    out[role] = Number(rows[0]!.balance ?? 0);
  }
  return out;
}

const sumOfBalances = (b: Record<Role, number>) =>
  Object.values(b).reduce((total, n) => total + n, 0);
const salesSide = (b: Record<Role, number>) =>
  b.sales_revenue + b.service_charge + b.tax_payable_pbjt;

async function unbalancedEntries(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT entry_id FROM journal_lines WHERE tenant_id = $1
       GROUP BY entry_id HAVING sum(debit_idr) <> sum(credit_idr)) t`,
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function entryCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function parkedFor(chargeId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auto_journal_parked
     WHERE tenant_id = $1 AND idempotency_key LIKE $2`,
    [w.tenant.tenantId, `%${chargeId}%`],
  );
  return Number(rows[0]!.n);
}

// ---- follow-up helpers -----------------------------------------------------------

/** The nsvu0 refund of a charge paid through a gateway intent. */
function intentRefund(
  chargeId: string,
  amountIdr: number,
  who: Staff = requester,
) {
  return who.client
    .post(`/api/order-issue-charges/${encodeURIComponent(chargeId)}/refund`)
    .set("Host", w.tenant.hostname)
    .set(originHeader)
    .send({ amountIdr, reason: REASON });
}

/** Every refund of the intent that is not failed (reserved money counts). */
async function intentRefundedTotal(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS total FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.total;
}

async function paymentRefundRows(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

/** Tutup Hari of one outlet and business date (a frozen, immutable row). */
async function closeDay(outletId: string, date: string) {
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_daily_closes
         (tenant_id, outlet_id, business_date, order_count, total_sales_idr,
          total_refunds_idr, total_voids_idr, total_variance_idr,
          inventory_deduction_applied, recap, closed_by, closed_at,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, '{}', $4, now(), $5, $6)`,
      [
        w.tenant.tenantId,
        outletId,
        date,
        w.supervisor.userId,
        randomUUID(),
        "0".repeat(64),
      ],
    ),
  );
}

const denied = (status: number) => status === 403 || status === 404;

// ============================================================================

describe("legend-ayobh reject: outlet scope of HANDLE vs APPROVE", () => {
  for (const method of ["cash", "edc"] as const) {
    it(`AYB-1 (${method}) the requester (handle @ outlet A, approve only @ outlet B) can withdraw their own request: not falsely refused`, async () => {
      const c =
        method === "cash" ? await paidCashCharge() : await paidEdcCharge();
      const drawer = await expectedCash();
      const body = method === "cash" ? cashBody(1_000) : edcBody(1_000);
      const row = await request(c.charge.id, body, splitRequester);
      expect(row.requested_by).toBe(splitRequester.userId);
      expect(await reserved(c.charge.id)).toBe(1_000);

      const res = await rejectRefund(
        row.id,
        { reason: "Salah input nominal" },
        splitRequester,
      );
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

      expect((await manualRows(c.charge.id))[0]).toMatchObject({
        status: "rejected",
        decided_by: splitRequester.userId,
        reject_reason: "Salah input nominal",
      });
      expect(await reserved(c.charge.id)).toBe(0);
      expect(await cashOutOf(row.id)).toHaveLength(0);
      expect(await expectedCash()).toBe(drawer);
      expect(await refundedEvents(c.issueId)).toHaveLength(0);
    });
  }

  it("AYB-2 somebody ELSE with handle @ A and approve only @ B cannot reject or approve a request of outlet A (403/404); nothing changes; the right approver still can", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const moves = await movementCount();
    const row = await request(c.charge.id, cashBody(2_000));

    for (const who of [splitOther]) {
      const rejected = await rejectRefund(row.id, undefined, who);
      expect(denied(rejected.status), JSON.stringify(rejected.body)).toBe(true);
      const approved = await approveRefund(row.id, { shiftId }, who);
      expect(denied(approved.status), JSON.stringify(approved.body)).toBe(true);
    }

    expect((await manualRows(c.charge.id))[0]).toMatchObject({
      status: "requested",
      decided_by: null,
      cash_movement_id: null,
    });
    expect(await cashOutOf(row.id)).toHaveLength(0);
    expect(await movementCount()).toBe(moves);
    expect(await expectedCash()).toBe(drawer);
    expect(await refundedEvents(c.issueId)).toHaveLength(0);

    // Control: a person with approve at outlet A rejects it.
    expectOk(await rejectRefund(row.id, undefined, approverB));
    expect((await manualRows(c.charge.id))[0]!.status).toBe("rejected");
  });

  it("AYB-3 the requester of a request of outlet A who holds neither permission pair at A cannot reject somebody else's request", async () => {
    const c = await paidCashCharge();
    const mine = await request(c.charge.id, cashBody(1_000), splitRequester);
    const theirs = await request(c.charge.id, cashBody(1_000), approverA);

    const res = await rejectRefund(
      theirs.id,
      { reason: "Bukan permintaan saya" },
      splitRequester,
    );
    expect(denied(res.status), JSON.stringify(res.body)).toBe(true);

    const byId = new Map((await manualRows(c.charge.id)).map((r) => [r.id, r]));
    expect(byId.get(theirs.id)!.status).toBe("requested");
    expect(byId.get(mine.id)!.status).toBe("requested");
  });

  it("AYB-4 isolation: a reject touches only its own request; another charge's request, another tenant's staff (404) and the charge itself stay", async () => {
    const a = await paidCashCharge();
    const b = await paidCashCharge();
    const rowA = await request(a.charge.id, cashBody(1_500), splitRequester);
    const rowB = await request(b.charge.id, cashBody(1_500));

    const foreign = await rejectRefund(
      rowA.id,
      undefined,
      foreignOwner,
      seededHostname,
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect((await manualRows(a.charge.id))[0]!.status).toBe("requested");

    expectOk(
      await rejectRefund(rowA.id, { reason: "Salah input" }, splitRequester),
    );
    expect((await manualRows(a.charge.id))[0]!.status).toBe("rejected");
    expect((await manualRows(b.charge.id))[0]!.status).toBe("requested");
    expect(await reserved(b.charge.id)).toBe(1_500);
    expect(rowB.status).toBe("requested");
    expect(await chargeStatus(a.charge.id)).toBe("paid");
    expect(await chargeStatus(b.charge.id)).toBe("paid");
  });
});

describe("legend-ng3tf a day closed at ANOTHER outlet does not block the refund", () => {
  it("NG3-1 the other outlet closes its day: cash approve and EDC approve of this outlet's charges still pay", async () => {
    const edc = await paidEdcCharge();
    const cash = await paidCashCharge();
    const drawer = await expectedCash();
    const edcRow = await request(edc.charge.id, edcBody(2_000));
    const cashRow = await request(cash.charge.id, cashBody(1_000));

    await closeDay(w.ids.otherOutlet, await businessDateOf(edc.order.id));

    expectOk(await approveRefund(edcRow.id, {}));
    expectOk(await approveRefund(cashRow.id, { shiftId }));
    expect(await completed(edc.charge.id)).toBe(2_000);
    expect(await completed(cash.charge.id)).toBe(1_000);
    expect(await expectedCash()).toBe(drawer - 1_000);
    expect(await refundedEvents(edc.issueId)).toHaveLength(1);
    expect(await refundedEvents(cash.issueId)).toHaveLength(1);
  });
});

describe("legend-mrwtp money cap: manual refund + intent refund (+ void, other file) never pass the charge", () => {
  it("CAP-1 gateway (QRIS) charge: concurrent intent refunds stay within the charge; a manual refund request on it is 409 and creates nothing", async () => {
    const q = await paidQrisCharge();
    const intentId = (await chargeOf(q.issueId)).payment_intent_id!;

    const results = await Promise.all([
      intentRefund(q.charge.id, 3_000),
      intentRefund(q.charge.id, 3_000),
      intentRefund(q.charge.id, 3_000),
      intentRefund(q.charge.id, AMOUNT),
      requestRefund(q.charge.id, cashBody(3_000)),
      requestRefund(q.charge.id, edcBody(3_000), approverA),
    ]);

    expect(results[4]!.status, JSON.stringify(results[4]!.body)).toBe(409);
    expect(results[5]!.status, JSON.stringify(results[5]!.body)).toBe(409);
    expect(await manualRows(q.charge.id)).toHaveLength(0);
    const total = await intentRefundedTotal(intentId);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(AMOUNT);
    expect(results.slice(0, 4).filter(isOk).length).toBeGreaterThanOrEqual(1);
  });

  for (const method of ["cash", "edc"] as const) {
    it(`CAP-2 (${method}) charge: concurrent manual requests, approvals and intent-route refunds together never return more than the charge; intent route refused; journal balanced`, async () => {
      await enableAccounting();
      const opened = await openCharge();
      await deliverAllOutboxToJournal();
      if (method === "cash") {
        const res = await collect(opened.charge.id, {
          idempotencyKey: randomUUID(),
          method: "cash",
          receivedIdr: AMOUNT,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      } else {
        const sale = await ledgerSale(opened.charge.id);
        const res = await collect(opened.charge.id, {
          idempotencyKey: randomUUID(),
          method: "edc_card",
          edcTransactionId: sale,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      await deliverAllOutboxToJournal();
      const paid = await balances();
      const intentRows = await paymentRefundRows();
      const drawer = await expectedCash();
      const body = method === "cash" ? cashBody : edcBody;

      const asked = await Promise.all([
        requestRefund(opened.charge.id, body(3_000), requester),
        requestRefund(opened.charge.id, body(3_000), approverA),
        requestRefund(opened.charge.id, body(3_000), approverB),
        requestRefund(opened.charge.id, body(3_000), requester),
        intentRefund(opened.charge.id, 3_000),
        intentRefund(opened.charge.id, AMOUNT),
      ]);

      // Exactly two of 3.000 fit in 8.085; the intent route never pays a till charge.
      expect(asked.slice(0, 4).filter(isOk)).toHaveLength(2);
      expect(asked[4]!.status).toBeGreaterThanOrEqual(400);
      expect(asked[5]!.status).toBeGreaterThanOrEqual(400);
      expect(await paymentRefundRows()).toBe(intentRows);
      expect(await reserved(opened.charge.id)).toBe(6_000);

      const pending = (await manualRows(opened.charge.id)).filter(
        (row) => row.status === "requested",
      );
      await Promise.all(
        pending.flatMap((row) => [
          approveRefund(
            row.id,
            method === "cash" ? { shiftId } : {},
            approverA,
          ),
          approveRefund(
            row.id,
            method === "cash" ? { shiftId } : {},
            approverB,
          ),
        ]),
      );
      // One more attempt after everything settled: the charge has 2.085 left, not 3.000.
      const late = await requestRefund(opened.charge.id, body(3_000));
      expect([409, 422], JSON.stringify(late.body)).toContain(late.status);

      const done = await completed(opened.charge.id);
      expect(done).toBe(6_000);
      expect(done).toBeLessThanOrEqual(AMOUNT);
      expect(await reserved(opened.charge.id)).toBeLessThanOrEqual(AMOUNT);
      expect(await expectedCash()).toBe(
        method === "cash" ? drawer - done : drawer,
      );
      expect(await refundedEvents(opened.issueId)).toHaveLength(2);

      await deliverAllOutboxToJournal();
      const after = await balances();
      expect(salesSide(after) - salesSide(paid)).toBe(done); // debits
      expect(sumOfBalances(after)).toBe(sumOfBalances(paid));
      expect(await unbalancedEntries()).toBe(0);
      expect(await parkedFor(opened.charge.id)).toBe(0);
      expect(await chargeStatus(opened.charge.id)).toBe("paid");
    });
  }
});

// This block is LAST on purpose: a closed day cannot be reopened (the row is immutable).
describe("legend-ng3tf approve of a manual EDC refund after the business day was closed", () => {
  it("NG3-2 EDC approve on a closed day of the charge's outlet is refused 409 BUSINESS_DAY_ALREADY_CLOSED: stays requested, no refund event, no journal entry, journal balanced; other charges untouched", async () => {
    await enableAccounting();
    const opened = await openCharge();
    await deliverAllOutboxToJournal();
    const sale = await ledgerSale(opened.charge.id);
    const collected = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "edc_card",
      edcTransactionId: sale,
    });
    expect(collected.status, JSON.stringify(collected.body)).toBe(200);
    await deliverAllOutboxToJournal();

    const other = await paidCashCharge(); // another charge of the same outlet
    const otherRow = await request(other.charge.id, cashBody(1_000));
    const row = await request(opened.charge.id, edcBody(2_000));
    await deliverAllOutboxToJournal();
    const beforeClose = await balances();
    const entries = await entryCount();
    const moves = await movementCount();

    await closeDay(w.tenant.outletId, await businessDateOf(opened.order.id));

    const res = await approveRefund(row.id, {});
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("BUSINESS_DAY_ALREADY_CLOSED");

    expect((await manualRows(opened.charge.id))[0]).toMatchObject({
      status: "requested",
      decided_by: null,
      cash_movement_id: null,
    });
    expect(await completed(opened.charge.id)).toBe(0);
    expect(await refundedEvents(opened.issueId)).toHaveLength(0);
    expect(await chargeStatus(opened.charge.id)).toBe("paid");
    expect(await movementCount()).toBe(moves);

    await deliverAllOutboxToJournal();
    expect(await balances()).toEqual(beforeClose);
    expect(await entryCount()).toBe(entries);
    expect(await unbalancedEntries()).toBe(0);
    expect(await parkedFor(opened.charge.id)).toBe(0);

    // Another charge's pending request is untouched by the refusal.
    expect((await manualRows(other.charge.id))[0]).toMatchObject({
      id: otherRow.id,
      status: "requested",
    });
    // A repeat is refused the same way, not paid by a second try (also from the
    // other approver); a foreign tenant still sees 404.
    const again = await approveRefund(row.id, {}, approverB);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    const foreign = await approveRefund(
      row.id,
      {},
      foreignOwner,
      seededHostname,
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(await refundedEvents(opened.issueId)).toHaveLength(0);
  });
});
