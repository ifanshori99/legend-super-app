// legend-mrwtp (brief 985, money, "Jangan sampai rugi"): manual refund of a PAID
// swap-difference charge (`order_issue_charges`) that was collected at the till
// in CASH or by EDC card (no payment intent, so the nsvu0 intent refund cannot
// return it). Two steps: request, then approval by ANOTHER person.
//
// The interplay with voiding the order (POS void fixture) lives in
// order-charge-manual-refund-void-985.test.ts.
//
// Written from the brief's DESIGN DECISIONS and the shared validators, never
// from the services. Fixtures follow order-charge-refund-982-pos-nontunai-gt98h
// (charges are paid through the real collect-at-pos route) and
// order-charge-refund-982-nsvu0 (journal delivery by hand).
//
// ASSUMPTIONS (the contract does not define bodies/codes; adjust here if the
// engineer picks other names):
//  - Request: POST /api/order-issue-charges/:chargeId/manual-refund with
//    { amountIdr, reason, method: "cash" | "edc", reference? }. Any 2xx. The
//    refund id is read from the table `order_issue_charge_manual_refunds`
//    (the response shape is not asserted).
//  - Approve: POST /api/order-issue-charge-manual-refunds/:id/approve with
//    { shiftId } (cash) or {} (EDC). Reject: .../:id/reject with { reason }.
//    Neither needs a device token (staff session only).
//  - Approver holds `order.recovery.handle` + `pos.refund.approve`. The
//    requester (w.supervisor) holds order.recovery.handle only.
//  - Over-limit amount: 409 or 422. Missing/short EDC reference, bad body: 400
//    or 422. Missing shift on cash approve: 400, 409 or 422.
//  - Event after a completed refund: `order_issue.charge_refunded` with
//    payload.method "pos_cash" (refundId = cash_out id) or "edc_manual"
//    (refundId = manual refund row id), as in the design card.
//  - Journal: "balanced and back to the pre-charge balances" is measured on the
//    six chart roles of the tenant, whatever account the EDC leg uses.

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
let otherOutletApprover: Staff; // same permissions, limited to the other outlet
let cashier: { client: ReturnType<typeof agent>; userId: string };
let otherOutletCashier: { client: ReturnType<typeof agent>; userId: string };
let shiftId = ""; // the main drawer (float 100.000)
let businessDate = "";
let otherOutletShiftId = "";
let terminalId = "";

const DEVICE_ID = randomUUID();
const OTHER_OUTLET_DEVICE_ID = randomUUID();
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

beforeAll(async () => {
  w = await createWorld();
  foreignOwner = await staffWithRole(w.app, {
    template: "owner",
    label: "Pemilik Tenant Lain",
  });
  requester = w.supervisor;

  const approverRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Penyetuju Refund Manual Uji', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      approverRole,
      w.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "order.recovery.handle",
        "pos.refund.approve",
      ]),
    ],
  );
  approverA = await staffUser(approverRole, { type: "tenant" }, "Penyetuju A");
  approverB = await staffUser(approverRole, { type: "tenant" }, "Penyetuju B");
  otherOutletApprover = await staffUser(
    approverRole,
    { type: "outlet", outletId: w.ids.otherOutlet },
    "Penyetuju Outlet Lain",
  );

  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId: DEVICE_ID,
  });
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.ids.otherOutlet,
    deviceId: OTHER_OUTLET_DEVICE_ID,
  });
  cashier = await cashierWithRole("Refund Manual", w.tenant.outletId);
  otherOutletCashier = await cashierWithRole(
    "Refund Manual Lain",
    w.ids.otherOutlet,
  );
  terminalId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-MRWTP', 'MID-MRWTP', 'Test EDC', 'lan',
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

/** A fresh drawer (own cashier + device): open, or closed with a real count row. */
async function newShift(
  floatIdr: number,
  { closed = false }: { closed?: boolean } = {},
): Promise<string> {
  const user = await cashierWithRole(
    `Laci ${randomUUID().slice(0, 6)}`,
    w.tenant.outletId,
  );
  const deviceId = randomUUID();
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId,
  });
  if (!closed)
    return insertShift({
      cashierId: user.userId,
      deviceId,
      outletId: w.tenant.outletId,
      floatIdr,
    });

  // Closed shift fixture (as accounting-auto-journal-cash-movement.test.ts):
  // triggers and cross foreign keys are skipped, the CHECK constraints are not.
  const id = randomUUID();
  const countId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenant.tenantId],
    );
    await client.query(
      `INSERT INTO pos_shift_counts
         (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
          counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, $6, $6, 0, $7, now(), false, $8, $5)`,
      [
        countId,
        w.tenant.tenantId,
        w.tenant.outletId,
        id,
        "b".repeat(64),
        floatIdr,
        user.userId,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO pos_shifts
         (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
          opened_at, opening_float_idr, open_key, open_fingerprint, expected_idr,
          counted_idr, variance_idr, counts, count_id, approved_by, approval_request_id,
          approval_override_id, approved_at, closed_at, closed_by, close_key,
          close_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'closed', now() - interval '2 hours', $7, $8, $9,
               $7, $7, 0, '[]'::jsonb, $10, $11, $12, $13, now(), now(), $5, $14, $15)`,
      [
        id,
        w.tenant.tenantId,
        w.tenant.outletId,
        deviceId,
        user.userId,
        businessDate,
        floatIdr,
        randomUUID(),
        "a".repeat(64),
        countId,
        w.approverUserId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        "c".repeat(64),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

async function allManualRows(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM order_issue_charge_manual_refunds WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

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

// ============================================================================

describe("legend-mrwtp manual refund of a cash charge: request, then approval", () => {
  it("MRF-1 request reserves, approve by another person pays cash_out from the open shift, drawer drops once, refund event pos_cash", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const moves = await movementCount();

    const row = await request(c.charge.id, cashBody(3_000));
    expect(row).toMatchObject({
      method: "cash",
      amount_idr: 3_000,
      status: "requested",
      requested_by: requester.userId,
      decided_by: null,
      cash_movement_id: null,
    });
    expect(row.reference).toBeNull();
    // A request alone moves no money and books nothing.
    expect(await expectedCash()).toBe(drawer);
    expect(await movementCount()).toBe(moves);
    expect(await refundedEvents(c.issueId)).toHaveLength(0);

    const res = await approveRefund(row.id, { shiftId });
    expectOk(res);

    const [after] = await manualRows(c.charge.id);
    expect(after).toMatchObject({
      status: "completed",
      decided_by: approverA.userId,
      shift_id: shiftId,
    });
    const out = await cashOutOf(row.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "cash_out",
      amount_idr: 3_000,
      shift_id: shiftId,
    });
    expect(after!.cash_movement_id).toBe(out[0]!.id);
    expect(await expectedCash()).toBe(drawer - 3_000);

    const events = await refundedEvents(c.issueId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({
      method: "pos_cash",
      refundId: out[0]!.id,
    });
  });

  it("MRF-1b a second approve of the same refund is refused: still one cash_out, drawer dropped once", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const row = await request(c.charge.id, cashBody(2_000));
    expectOk(await approveRefund(row.id, { shiftId }));

    const again = await approveRefund(row.id, { shiftId }, approverB);
    expect(again.status, JSON.stringify(again.body)).toBe(409);

    expect(await cashOutOf(row.id)).toHaveLength(1);
    expect(await expectedCash()).toBe(drawer - 2_000);
    expect(await refundedEvents(c.issueId)).toHaveLength(1);
  });

  it("MRF-1c parallel approvals of one refund pay out once", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const row = await request(c.charge.id, cashBody(2_500));

    const results = await Promise.all([
      approveRefund(row.id, { shiftId }, approverA),
      approveRefund(row.id, { shiftId }, approverB),
      approveRefund(row.id, { shiftId }, approverA),
    ]);

    expect(results.filter(isOk)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await cashOutOf(row.id)).toHaveLength(1);
    expect(await expectedCash()).toBe(drawer - 2_500);
    expect(await refundedEvents(c.issueId)).toHaveLength(1);
  });
});

describe("legend-mrwtp manual refund of an EDC charge", () => {
  it("MRF-2 EDC refund with a bank reference: approve completes it, no cash movement, drawer untouched, refund event edc_manual", async () => {
    const c = await paidEdcCharge();
    const drawer = await expectedCash();
    const moves = await movementCount();
    const reference = freshRef();

    const row = await request(c.charge.id, edcBody(AMOUNT, reference));
    expect(row).toMatchObject({
      method: "edc",
      amount_idr: AMOUNT,
      status: "requested",
      reference,
    });

    // EDC approval needs no shift.
    expectOk(await approveRefund(row.id, {}));

    const [after] = await manualRows(c.charge.id);
    expect(after).toMatchObject({
      status: "completed",
      decided_by: approverA.userId,
      reference,
      cash_movement_id: null,
    });
    expect(await movementCount()).toBe(moves);
    expect(await expectedCash()).toBe(drawer);
    const events = await refundedEvents(c.issueId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({
      method: "edc_manual",
      refundId: row.id,
    });
  });

  it("MRF-3 EDC needs a bank reference (3-100 chars) and the same reference cannot be used twice", async () => {
    const c = await paidEdcCharge();
    const rows = await allManualRows();

    for (const body of [
      { amountIdr: 1_000, reason: REASON, method: "edc" },
      edcBody(1_000, "ab"),
      edcBody(1_000, "x".repeat(101)),
    ]) {
      const res = await requestRefund(c.charge.id, body);
      expect([400, 422], JSON.stringify(res.body)).toContain(res.status);
    }
    expect(await allManualRows()).toBe(rows);

    const reference = freshRef();
    const first = await request(c.charge.id, edcBody(1_000, reference));
    const dup = await requestRefund(c.charge.id, edcBody(1_000, reference));
    expect(dup.status, JSON.stringify(dup.body)).toBe(409);
    expect(await reserved(c.charge.id)).toBe(1_000);

    // A rejected request frees its reference (the unique key skips rejected).
    expectOk(await rejectRefund(first.id));
    await request(c.charge.id, edcBody(1_000, reference));
    expect(await reserved(c.charge.id)).toBe(1_000);
  });

  it("MRF-4 the method must match how the guest paid: cash on an EDC charge and EDC on a cash charge are 409", async () => {
    const edc = await paidEdcCharge();
    const cash = await paidCashCharge();
    const rows = await allManualRows();

    const a = await requestRefund(edc.charge.id, cashBody(1_000));
    const b = await requestRefund(cash.charge.id, edcBody(1_000));

    expect(a.status, JSON.stringify(a.body)).toBe(409);
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(await allManualRows()).toBe(rows);
    // Controls: the matching method works on each.
    await request(edc.charge.id, edcBody(1_000));
    await request(cash.charge.id, cashBody(1_000));
  });

  it("MRF-4b only a paid charge without an intent can be refunded by hand: open, waived and gateway-paid charges are 409", async () => {
    const open = await openCharge();
    const waived = await openCharge();
    await owner.query(
      `UPDATE order_issue_charges
       SET status = 'waived', closed_at = now(), closed_by = $3,
           close_reason = 'Tamu komplain lama menunggu'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, waived.charge.id, w.supervisor.userId],
    );
    const qris = await paidQrisCharge();
    const rows = await allManualRows();

    for (const target of [open, waived, qris])
      for (const body of [cashBody(1_000), edcBody(1_000)]) {
        const res = await requestRefund(target.charge.id, body);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
      }
    expect(await allManualRows()).toBe(rows);
  });
});

describe("legend-mrwtp the person who asks is not the person who approves, and permissions", () => {
  it("MRF-5 the requester cannot approve their own refund even holding pos.refund.approve: 409 APPROVER_IS_REQUESTER, nothing paid; another approver can", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const row = await request(c.charge.id, cashBody(2_000), approverA);

    const self = await approveRefund(row.id, { shiftId }, approverA);
    expect(self.status, JSON.stringify(self.body)).toBe(409);
    expect(JSON.stringify(self.body)).toContain("APPROVER_IS_REQUESTER");
    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");
    expect(await cashOutOf(row.id)).toHaveLength(0);
    expect(await expectedCash()).toBe(drawer);

    expectOk(await approveRefund(row.id, { shiftId }, approverB));
    expect((await manualRows(c.charge.id))[0]).toMatchObject({
      status: "completed",
      decided_by: approverB.userId,
    });
  });

  it("MRF-5b the same rule holds for EDC", async () => {
    const c = await paidEdcCharge();
    const row = await request(c.charge.id, edcBody(AMOUNT), approverA);

    const self = await approveRefund(row.id, {}, approverA);
    expect(self.status, JSON.stringify(self.body)).toBe(409);
    expect(JSON.stringify(self.body)).toContain("APPROVER_IS_REQUESTER");
    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");
    expect(await refundedEvents(c.issueId)).toHaveLength(0);
  });

  it("MRF-6 permissions: no order.recovery.handle cannot request (403); no pos.refund.approve cannot approve or pays nothing (403); other outlet's approver 403/404", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();

    const noRecovery = await requestRefund(
      c.charge.id,
      cashBody(1_000),
      w.floorStaff,
    );
    expect(noRecovery.status, JSON.stringify(noRecovery.body)).toBe(403);
    expect(await manualRows(c.charge.id)).toHaveLength(0);

    const row = await request(c.charge.id, cashBody(1_000));
    // The supervisor holds order.recovery.handle but NOT pos.refund.approve.
    const noApprove = await approveRefund(
      row.id,
      { shiftId },
      w.outletSupervisor,
    );
    expect(noApprove.status, JSON.stringify(noApprove.body)).toBe(403);
    const wrongOutlet = await approveRefund(
      row.id,
      { shiftId },
      otherOutletApprover,
    );
    expect([403, 404], JSON.stringify(wrongOutlet.body)).toContain(
      wrongOutlet.status,
    );

    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");
    expect(await cashOutOf(row.id)).toHaveLength(0);
    expect(await expectedCash()).toBe(drawer);

    // Control: the rightful approver pays.
    expectOk(await approveRefund(row.id, { shiftId }));
    expect(await completed(c.charge.id)).toBe(1_000);
  });

  it("MRF-6b a request by another outlet's staff is 403/404 and creates nothing", async () => {
    const c = await paidCashCharge();
    const res = await requestRefund(
      c.charge.id,
      cashBody(1_000),
      otherOutletApprover,
    );
    expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    expect(await manualRows(c.charge.id)).toHaveLength(0);
  });
});

describe("legend-mrwtp the total returned by hand never passes the charge", () => {
  it("MRF-7 requests add up and reserve: 5.000 + 3.085 fits, 3.086 and 1 more do not, 0 and negative are invalid", async () => {
    const c = await paidCashCharge();

    await request(c.charge.id, cashBody(5_000));
    const over = await requestRefund(c.charge.id, cashBody(AMOUNT - 5_000 + 1));
    expect([409, 422], JSON.stringify(over.body)).toContain(over.status);
    expect(await reserved(c.charge.id)).toBe(5_000);

    await request(c.charge.id, cashBody(AMOUNT - 5_000));
    expect(await reserved(c.charge.id)).toBe(AMOUNT);
    const again = await requestRefund(c.charge.id, cashBody(1));
    expect([409, 422], JSON.stringify(again.body)).toContain(again.status);

    for (const amountIdr of [0, -5, 1.5]) {
      const bad = await requestRefund(c.charge.id, cashBody(amountIdr));
      expect([400, 422], JSON.stringify(bad.body)).toContain(bad.status);
    }
    expect(await reserved(c.charge.id)).toBeLessThanOrEqual(AMOUNT);
  });

  it("MRF-7b one request above the charge is refused outright; a full request holds the whole value, completed or not", async () => {
    const c = await paidCashCharge();
    const res = await requestRefund(c.charge.id, cashBody(AMOUNT + 1));
    expect([409, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(await manualRows(c.charge.id)).toHaveLength(0);

    const full = await request(c.charge.id, cashBody(AMOUNT));
    expectOk(await approveRefund(full.id, { shiftId }));
    const more = await requestRefund(c.charge.id, cashBody(1));
    expect([409, 422], JSON.stringify(more.body)).toContain(more.status);
    expect(await completed(c.charge.id)).toBe(AMOUNT);
  });

  it("MRF-8 concurrent requests cannot overshoot: five of 3.000 on 8.085, exactly two win, 6.000 reserved", async () => {
    const c = await paidCashCharge();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        requestRefund(c.charge.id, cashBody(3_000)),
      ),
    );

    expect(results.filter(isOk)).toHaveLength(2);
    expect(
      results.filter((r) => r.status === 409 || r.status === 422),
    ).toHaveLength(3);
    expect(await reserved(c.charge.id)).toBe(6_000);
    expect(await manualRows(c.charge.id)).toHaveLength(2);
  });

  it("MRF-8b concurrent full requests (cash and EDC mixed): one wins, the charge is never over-reserved", async () => {
    const c = await paidCashCharge();

    const results = await Promise.all([
      requestRefund(c.charge.id, cashBody(AMOUNT)),
      requestRefund(c.charge.id, cashBody(AMOUNT), approverA),
      requestRefund(c.charge.id, cashBody(AMOUNT), approverB),
    ]);

    expect(results.filter(isOk)).toHaveLength(1);
    expect(await reserved(c.charge.id)).toBe(AMOUNT);
  });

  it("MRF-8c approved cash never exceeds the charge across requests: total cash_out of its refunds <= charge value", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const rows = [
      await request(c.charge.id, cashBody(4_000)),
      await request(c.charge.id, cashBody(4_000)),
    ];
    const extra = await requestRefund(c.charge.id, cashBody(1_000));
    expect([409, 422]).toContain(extra.status);

    await Promise.all(rows.map((row) => approveRefund(row.id, { shiftId })));

    let paid = 0;
    for (const row of rows)
      for (const movement of await cashOutOf(row.id))
        paid += movement.amount_idr;
    expect(paid).toBe(8_000);
    expect(paid).toBeLessThanOrEqual(AMOUNT);
    expect(await expectedCash()).toBe(drawer - paid);
  });
});

describe("legend-mrwtp the drawer cannot go negative; the shift must be open", () => {
  it("MRF-9 the drawer holds less than the refund: approve is 409, nothing paid, still requested; an adequate drawer pays", async () => {
    const c = await paidCashCharge();
    const tight = await newShift(1_000);
    const row = await request(c.charge.id, cashBody(3_000));
    const movesBefore = await movementCount();

    const res = await approveRefund(row.id, { shiftId: tight });
    expect(res.status, JSON.stringify(res.body)).toBe(409);

    expect((await manualRows(c.charge.id))[0]).toMatchObject({
      status: "requested",
      cash_movement_id: null,
      decided_by: null,
    });
    expect(await cashOutOf(row.id)).toHaveLength(0);
    expect(await movementCount()).toBe(movesBefore);
    expect(await expectedCashOf(tight)).toBe(1_000);
    expect(await refundedEvents(c.issueId)).toHaveLength(0);

    expectOk(await approveRefund(row.id, { shiftId }));
    expect(await completed(c.charge.id)).toBe(3_000);
  });

  it("MRF-9b boundary: a drawer of exactly the refund pays it down to 0, one more rupiah is refused", async () => {
    const c = await paidCashCharge();
    const exact = await newShift(5_000);
    const first = await request(c.charge.id, cashBody(5_000));
    const second = await request(c.charge.id, cashBody(1));

    expectOk(await approveRefund(first.id, { shiftId: exact }));
    expect(await expectedCashOf(exact)).toBe(0);
    const over = await approveRefund(second.id, { shiftId: exact });
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(await expectedCashOf(exact)).toBe(0);
    expect((await manualRows(c.charge.id))[1]!.status).toBe("requested");
  });

  it("MRF-9c two refunds approved at the same time on a drawer that fits only one: exactly one is paid, the drawer never goes below 0", async () => {
    const c = await paidCashCharge();
    const tight = await newShift(5_000);
    const a = await request(c.charge.id, cashBody(3_000));
    const b = await request(c.charge.id, cashBody(3_000));

    const results = await Promise.all([
      approveRefund(a.id, { shiftId: tight }, approverA),
      approveRefund(b.id, { shiftId: tight }, approverB),
    ]);

    expect(results.filter(isOk)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await expectedCashOf(tight)).toBe(2_000);
    expect(await completed(c.charge.id)).toBe(3_000);
  });

  it("MRF-10 a closed shift is refused 409; no shift on a cash approve is refused; an open shift of ANOTHER outlet is refused 409", async () => {
    const c = await paidCashCharge();
    const closed = await newShift(50_000, { closed: true });
    if (!otherOutletShiftId)
      otherOutletShiftId = await insertShift({
        cashierId: otherOutletCashier.userId,
        deviceId: OTHER_OUTLET_DEVICE_ID,
        outletId: w.ids.otherOutlet,
        floatIdr: 50_000,
      });
    const row = await request(c.charge.id, cashBody(2_000));
    const drawer = await expectedCash();
    const movesBefore = await movementCount();

    const onClosed = await approveRefund(row.id, { shiftId: closed });
    expect(onClosed.status, JSON.stringify(onClosed.body)).toBe(409);
    const noShift = await approveRefund(row.id, {});
    expect([400, 409, 422], JSON.stringify(noShift.body)).toContain(
      noShift.status,
    );
    const wrongOutlet = await approveRefund(row.id, {
      shiftId: otherOutletShiftId,
    });
    expect(wrongOutlet.status, JSON.stringify(wrongOutlet.body)).toBe(409);

    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");
    expect(await movementCount()).toBe(movesBefore);
    expect(await expectedCash()).toBe(drawer);
    expect(await expectedCashOf(otherOutletShiftId)).toBe(50_000);

    expectOk(await approveRefund(row.id, { shiftId }));
    expect(await completed(c.charge.id)).toBe(2_000);
  });
});

describe("legend-mrwtp reject releases the reservation", () => {
  it("MRF-11 reject by the approver records the reason, frees the whole amount for a new request, and a rejected refund cannot be approved", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const row = await request(c.charge.id, cashBody(AMOUNT));
    const blocked = await requestRefund(c.charge.id, cashBody(1));
    expect([409, 422]).toContain(blocked.status);

    const reason = "Tamu setuju selisih dipakai untuk menu lain";
    expectOk(await rejectRefund(row.id, { reason }));

    expect((await manualRows(c.charge.id))[0]).toMatchObject({
      status: "rejected",
      decided_by: approverA.userId,
      reject_reason: reason,
    });
    expect(await reserved(c.charge.id)).toBe(0);
    expect(await cashOutOf(row.id)).toHaveLength(0);
    expect(await expectedCash()).toBe(drawer);
    expect(await refundedEvents(c.issueId)).toHaveLength(0);

    const late = await approveRefund(row.id, { shiftId }, approverB);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(await expectedCash()).toBe(drawer);

    // The released amount is requestable (and payable) again.
    const again = await request(c.charge.id, cashBody(AMOUNT));
    expectOk(await approveRefund(again.id, { shiftId }, approverB));
    expect(await completed(c.charge.id)).toBe(AMOUNT);
  });

  it("MRF-11b the requester may withdraw their own request; only a requested refund can be rejected; a reason is required", async () => {
    const c = await paidCashCharge();
    const row = await request(c.charge.id, cashBody(1_000));

    const noReason = await rejectRefund(row.id, { reason: "" });
    expect([400, 422], JSON.stringify(noReason.body)).toContain(
      noReason.status,
    );
    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");

    expectOk(
      await rejectRefund(row.id, { reason: "Salah input nominal" }, requester),
    );
    expect((await manualRows(c.charge.id))[0]!.status).toBe("rejected");

    const done = await request(c.charge.id, cashBody(1_000));
    expectOk(await approveRefund(done.id, { shiftId }));
    const afterPaid = await rejectRefund(done.id);
    expect(afterPaid.status, JSON.stringify(afterPaid.body)).toBe(409);
    expect((await manualRows(c.charge.id))[1]!.status).toBe("completed");
    expect(await cashOutOf(done.id)).toHaveLength(1);
  });

  it("MRF-11c someone without pos.refund.approve who is not the requester cannot reject (403)", async () => {
    const c = await paidCashCharge();
    const row = await request(c.charge.id, cashBody(1_000), approverA);

    const res = await rejectRefund(row.id, undefined, w.outletSupervisor);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");
  });
});

describe("legend-mrwtp other tenant, other outlet and other charges are untouched", () => {
  it("MRF-12 a staff member of another tenant gets 404 on request, approve and reject; nothing changes", async () => {
    const c = await paidCashCharge();
    const drawer = await expectedCash();
    const row = await request(c.charge.id, cashBody(2_000));
    const rows = await allManualRows();

    const asked = await requestRefund(
      c.charge.id,
      cashBody(1_000),
      foreignOwner,
      seededHostname,
    );
    const approved = await approveRefund(
      row.id,
      { shiftId },
      foreignOwner,
      seededHostname,
    );
    const rejected = await rejectRefund(
      row.id,
      undefined,
      foreignOwner,
      seededHostname,
    );

    for (const res of [asked, approved, rejected])
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await allManualRows()).toBe(rows);
    expect((await manualRows(c.charge.id))[0]!.status).toBe("requested");
    expect(await cashOutOf(row.id)).toHaveLength(0);
    expect(await expectedCash()).toBe(drawer);
    expect(await chargeStatus(c.charge.id)).toBe("paid");

    // The rightful tenant still pays.
    expectOk(await approveRefund(row.id, { shiftId }));
  });

  it("MRF-12b refunding one charge by hand never touches another charge's reservation, cash or event", async () => {
    const a = await paidCashCharge();
    const b = await paidCashCharge();
    const e = await paidEdcCharge();
    const row = await request(a.charge.id, cashBody(AMOUNT));
    expectOk(await approveRefund(row.id, { shiftId }));

    expect(await manualRows(b.charge.id)).toHaveLength(0);
    expect(await manualRows(e.charge.id)).toHaveLength(0);
    expect(await chargeStatus(b.charge.id)).toBe("paid");
    expect(await chargeStatus(e.charge.id)).toBe("paid");
    expect(await refundedEvents(b.issueId)).toHaveLength(0);
    expect(await refundedEvents(e.issueId)).toHaveLength(0);
    // b still has its whole value requestable.
    await request(b.charge.id, cashBody(AMOUNT));
  });
});

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

describe("legend-mrwtp the reversal journal", () => {
  it("MRF-J1 cash: a requested refund books nothing; a full approved refund reverses the charge journal exactly (every role back to before), balanced, replay adds nothing", async () => {
    await enableAccounting();
    const opened = await openCharge();
    await deliverAllOutboxToJournal();
    const before = await balances();

    const res = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "cash",
      receivedIdr: AMOUNT,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await deliverAllOutboxToJournal();
    const paid = await balances();
    expect(salesSide(paid) - salesSide(before)).toBe(-AMOUNT); // credits
    expect(paid.cash_on_hand - before.cash_on_hand).toBe(AMOUNT);

    const row = await request(opened.charge.id, cashBody(AMOUNT));
    await deliverAllOutboxToJournal();
    expect(await balances(), "a request alone books nothing").toEqual(paid);

    expectOk(await approveRefund(row.id, { shiftId }));
    await deliverAllOutboxToJournal();
    expect(await balances(), "charge fully reversed").toEqual(before);
    expect(await unbalancedEntries()).toBe(0);
    expect(await parkedFor(opened.charge.id)).toBe(0);

    const entries = await entryCount();
    await deliverAllOutboxToJournal();
    expect(await entryCount()).toBe(entries);
    expect(await balances()).toEqual(before);
  });

  it("MRF-J2 cash partial: 3.000 comes out of revenue/service/PBJT and out of the cash account, no more", async () => {
    await enableAccounting();
    const opened = await paidCashCharge();
    await deliverAllOutboxToJournal();
    const paid = await balances();

    const row = await request(opened.charge.id, cashBody(3_000));
    expectOk(await approveRefund(row.id, { shiftId }));
    await deliverAllOutboxToJournal();
    const after = await balances();

    expect(salesSide(after) - salesSide(paid)).toBe(3_000); // debits
    expect(after.cash_on_hand - paid.cash_on_hand).toBe(-3_000);
    expect(sumOfBalances(after)).toBe(sumOfBalances(paid));
    expect(await unbalancedEntries()).toBe(0);
    expect(await parkedFor(opened.charge.id)).toBe(0);
  });

  it("MRF-J3 EDC: a full approved refund reverses the charge journal on the same accounts the charge used (every role back to before), balanced, replay adds nothing", async () => {
    await enableAccounting();
    const opened = await openCharge();
    await deliverAllOutboxToJournal();
    const before = await balances();

    const sale = await ledgerSale(opened.charge.id);
    const res = await collect(opened.charge.id, {
      idempotencyKey: randomUUID(),
      method: "edc_card",
      edcTransactionId: sale,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await deliverAllOutboxToJournal();
    const paid = await balances();
    expect(salesSide(paid) - salesSide(before)).toBe(-AMOUNT);

    const row = await request(opened.charge.id, edcBody(AMOUNT));
    expectOk(await approveRefund(row.id, {}));
    await deliverAllOutboxToJournal();

    expect(await balances(), "charge fully reversed").toEqual(before);
    expect(await unbalancedEntries()).toBe(0);
    expect(await parkedFor(opened.charge.id)).toBe(0);
    const entries = await entryCount();
    await deliverAllOutboxToJournal();
    expect(await entryCount()).toBe(entries);
  });

  it("MRF-J4 a rejected refund books nothing", async () => {
    await enableAccounting();
    const opened = await paidCashCharge();
    await deliverAllOutboxToJournal();
    const paid = await balances();

    const row = await request(opened.charge.id, cashBody(AMOUNT));
    expectOk(await rejectRefund(row.id));
    await deliverAllOutboxToJournal();

    expect(await balances()).toEqual(paid);
    expect(await refundedEvents(opened.issueId)).toHaveLength(0);
  });
});
