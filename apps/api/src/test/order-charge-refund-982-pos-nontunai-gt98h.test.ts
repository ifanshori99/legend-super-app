// legend-gt98h (thread 982): the cashier collects a swap charge
// (`order_issue_charges`) at the till with EDC or QRIS, not only cash:
// POST /api/order-issue-charges/:chargeId/collect-at-pos.
//
// Written from the card text and the shared validator (qr-order/schemas.ts
// `collectChargeAtPosInputSchema`, cash only today), not from the services.
// Modelled on order-issue-charge-collect-pos.test.ts (cash, legend-800h1) and
// order-issue-charge-pos-tender.test.ts (legend-i83ls).
//
// ASSUMPTIONS (the contract does not define the new bodies yet; adjust here if
// the engineer picks other names):
//  - Same route, same device token + open shift + `pos.payment.accept`.
//  - QRIS body: { idempotencyKey, method: "qris" }. It answers 2xx (200, 201 or
//    202), keeps the charge `open`, and stores the pending payment intent on
//    `order_issue_charges.payment_intent_id`. Settling that intent through the
//    normal verified webhook (`confirmPayment` + `deliverOrderPaymentEvent`)
//    marks the charge `paid` exactly once.
//  - EDC body: { idempotencyKey, method: "edc_card", edcTransactionId } where
//    the id is an `edc_transactions` ledger sale (like the POS EDC tender,
//    pos-edc-tender.test.ts) whose `reference` is the CHARGE id and whose
//    amount equals the charge amount. Only an `approved` sale settles it;
//    `pending`, `unknown`, `declined`, `failed` and `cancelled` leave it open.
//  - One approved EDC sale pays one charge only.
//  - Non-cash money never enters the drawer: no cash_in, expected cash unchanged.
//  - A cash collect while a POS QRIS is still pending wins and expires that
//    intent, like the existing guest-QR code does (800h1).
//
// Fail-first: today the validator accepts only `method: "cash"`, so every
// qris / edc request is a 400 (feature missing). The cash control tests pass.

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
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
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
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

let w: World;
const DEVICE_ID = randomUUID();
const OTHER_OUTLET_DEVICE_ID = randomUUID();
const NO_SHIFT_DEVICE_ID = randomUUID();
let cashier: { client: ReturnType<typeof agent>; userId: string };
let otherOutletCashier: { client: ReturnType<typeof agent>; userId: string };
let shiftId = "";
let terminalId = "";

const AMOUNT = 8_085; // 7.000 + service 350 + PBJT 735 (standard order)
const DIFFERENCE = PRICES.kopi - PRICES.roti;

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
  const client = agent(w.app);
  await signUp(client, `Kasir ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, userId, roleId, scopeOutletId],
  );
  return { client, userId };
}

beforeAll(async () => {
  w = await createWorld();
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId: DEVICE_ID,
  });
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.tenant.outletId,
    deviceId: NO_SHIFT_DEVICE_ID,
  });
  await registerTestDevice(owner, {
    tenantId: w.tenant.tenantId,
    outletId: w.ids.otherOutlet,
    deviceId: OTHER_OUTLET_DEVICE_ID,
  });
  cashier = await cashierWithRole("Selisih Nontunai", w.tenant.outletId);
  otherOutletCashier = await cashierWithRole("Outlet Lain", w.ids.otherOutlet);
  terminalId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-GT98H', 'MID-GT98H', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
      [terminalId, w.tenant.tenantId, w.tenant.outletId],
    ),
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

async function openShiftFor(
  cashierId: string,
  deviceId: string,
  outletId: string,
  businessDate: string,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', 100000, $7, $8)`,
    [
      id,
      w.tenant.tenantId,
      outletId,
      deviceId,
      cashierId,
      businessDate,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

async function businessDateOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.d;
}

/** A swap charge opened by the real flow, with the cashier's shift ready. */
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
  if (!shiftId)
    shiftId = await openShiftFor(
      cashier.userId,
      DEVICE_ID,
      w.tenant.outletId,
      await businessDateOf(order.order.id),
    );
  return { ...order, issueId, charge };
}

type ChargeRow = {
  id: string;
  status: string;
  payment_intent_id: string | null;
  cash_movement_id: string | null;
  paid_at: Date | null;
};

async function chargeOf(issueId: string): Promise<ChargeRow> {
  const { rows } = await owner.query<ChargeRow>(
    `SELECT id, status, payment_intent_id, cash_movement_id, paid_at
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function collect(
  chargeId: string,
  body: Record<string, unknown>,
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string | null = DEVICE_ID,
  host: string = w.tenant.hostname,
) {
  const request = who.client
    .post(`/api/order-issue-charges/${chargeId}/collect-at-pos`)
    .set("Host", host)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request.send(body);
}

const cashBody = (receivedIdr = AMOUNT) => ({
  idempotencyKey: randomUUID(),
  method: "cash",
  receivedIdr,
});
const qrisBody = (idempotencyKey = randomUUID()) => ({
  idempotencyKey,
  method: "qris",
});
const edcBody = (edcTransactionId: string, idempotencyKey = randomUUID()) => ({
  idempotencyKey,
  method: "edc_card",
  edcTransactionId,
});

function expectAccepted(res: { status: number; body: unknown }) {
  expect([200, 201, 202], JSON.stringify(res.body)).toContain(res.status);
}

async function movementCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
    [w.tenant.tenantId, shiftId],
  );
  return Number(rows[0]!.n);
}

async function expectedCash(): Promise<number> {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return liveExpectedCashIdr(tx, shift!);
  });
}

async function intentCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

async function intentStatus(intentId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.status;
}

async function chargePaidEvents(issueId: string) {
  return w.outboxRows("order_issue.charge_paid", issueId);
}

/** The verified QRIS webhook, then the order-payment consumer (as production). */
async function settleQris(intentId: string) {
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
  const paid = eventEnvelopeSchema.parse(rows[0]!.event);
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, paid, tx),
  );
}

async function ledgerSale(input: {
  reference: string;
  amountIdr: number;
  status: string;
}): Promise<string> {
  const id = randomUUID();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    input.status,
  );
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               'APP123', $10, $11)`,
      [
        id,
        w.tenant.tenantId,
        w.tenant.outletId,
        terminalId,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.status,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
        final ? new Date() : null,
      ],
    ),
  );
  return id;
}

async function setLedgerStatus(id: string, status: string) {
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `UPDATE edc_transactions SET status = $2, completed_at = now() WHERE id = $1`,
      [id, status],
    ),
  );
}

describe("legend-gt98h collect a swap charge at the till with EDC or QRIS", () => {
  it("QRIS: the collect leaves the charge open with a pending intent, no cash, no charge_paid", async () => {
    const opened = await openCharge();
    const cashBefore = await expectedCash();
    const moves = await movementCount();
    const intents = await intentCount();

    const res = await collect(opened.charge.id, qrisBody());
    expectAccepted(res);

    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("open");
    expect(row.paid_at).toBeNull();
    expect(row.cash_movement_id).toBeNull();
    expect(row.payment_intent_id).not.toBeNull();
    expect(await intentStatus(row.payment_intent_id!)).not.toBe("paid");
    expect(await intentCount()).toBe(intents + 1);
    expect(await movementCount()).toBe(moves);
    expect(await expectedCash()).toBe(cashBefore);
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);
  });

  it("QRIS: once the intent is settled the charge is paid exactly once, still no cash in the drawer", async () => {
    const opened = await openCharge();
    const cashBefore = await expectedCash();
    const moves = await movementCount();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    expect(intentId).not.toBeNull();

    await settleQris(intentId);

    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("paid");
    expect(row.paid_at).not.toBeNull();
    expect(row.cash_movement_id).toBeNull();
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
    expect(await movementCount()).toBe(moves);
    expect(await expectedCash()).toBe(cashBefore);
  });

  it("QRIS timeout: an expired intent does not mark the charge paid, and the charge can still be collected in cash", async () => {
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    expect(intentId).not.toBeNull();

    // Lapsed beyond the 60 s provider margin (HOLD_CLOSE_MARGIN_MS): a code
    // that lapsed less than that ago is still "maybe payable" and the cash
    // collect fails closed with PAYMENT_PROVIDER_UNCONFIRMED.
    await owner.query(
      `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '5 minutes'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, intentId],
    );

    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("open");
    expect(row.paid_at).toBeNull();
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);

    const cash = await collect(opened.charge.id, cashBody());
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect((await chargeOf(opened.issueId)).status).toBe("paid");
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
  });

  it("QRIS retry: same key twice and a new key while the first is pending create one intent and one payment", async () => {
    const opened = await openCharge();
    const intents = await intentCount();
    const body = qrisBody();

    const first = await collect(opened.charge.id, body);
    expectAccepted(first);
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id;
    expect(intentId).not.toBeNull();
    expect(await intentCount()).toBe(intents + 1);

    const replay = await collect(opened.charge.id, body);
    expectAccepted(replay);
    expect(replay.body.data).toEqual(first.body.data);

    // A second attempt under another key must not open a second live intent.
    await collect(opened.charge.id, qrisBody());
    expect((await chargeOf(opened.issueId)).payment_intent_id).toBe(intentId);
    expect(await intentCount()).toBe(intents + 1);

    await settleQris(intentId!);
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
  });

  it("QRIS retry in parallel under one key creates one intent", async () => {
    const opened = await openCharge();
    const intents = await intentCount();
    const body = qrisBody();
    const [a, b] = await Promise.all([
      collect(opened.charge.id, body),
      collect(opened.charge.id, body),
    ]);
    expect([a.status, b.status].some((s) => [200, 201, 202].includes(s))).toBe(
      true,
    );
    expect(a.status).toBeLessThan(500);
    expect(b.status).toBeLessThan(500);
    expect(await intentCount()).toBe(intents + 1);
    expect((await chargeOf(opened.issueId)).status).toBe("open");
  });

  it("EDC approved: the charge is paid once, by the EDC sale, with no cash in the drawer", async () => {
    const opened = await openCharge();
    const cashBefore = await expectedCash();
    const moves = await movementCount();
    const sale = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });

    const res = await collect(opened.charge.id, edcBody(sale));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("paid");
    expect(row.paid_at).not.toBeNull();
    expect(row.cash_movement_id).toBeNull();
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
    expect(await movementCount()).toBe(moves);
    expect(await expectedCash()).toBe(cashBefore);
  });

  it.each(["pending", "unknown"])(
    "EDC %s: the charge stays open until the sale is approved, then the same key settles it once",
    async (status) => {
      const opened = await openCharge();
      const sale = await ledgerSale({
        reference: opened.charge.id,
        amountIdr: AMOUNT,
        status,
      });
      const body = edcBody(sale);

      const waiting = await collect(opened.charge.id, body);
      expect(waiting.status, JSON.stringify(waiting.body)).toBeLessThan(500);
      expect((await chargeOf(opened.issueId)).status).toBe("open");
      expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);

      await setLedgerStatus(sale, "approved");
      const settled = await collect(opened.charge.id, body);
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect((await chargeOf(opened.issueId)).status).toBe("paid");
      expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
    },
  );

  it.each(["declined", "failed", "cancelled"])(
    "EDC %s: the charge is not paid, no event, and cash still works afterwards",
    async (status) => {
      const opened = await openCharge();
      const sale = await ledgerSale({
        reference: opened.charge.id,
        amountIdr: AMOUNT,
        status,
      });

      const res = await collect(opened.charge.id, edcBody(sale));
      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      // Feature must exist: the refusal names the EDC outcome, not the validator.
      expect(JSON.stringify(res.body)).not.toMatch(/invalid|validation/i);
      const row = await chargeOf(opened.issueId);
      expect(row.status).toBe("open");
      expect(row.paid_at).toBeNull();
      expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);

      const cash = await collect(opened.charge.id, cashBody());
      expect(cash.status, JSON.stringify(cash.body)).toBe(200);
      expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
    },
  );

  it("EDC sale for another amount does not pay the charge", async () => {
    const opened = await openCharge();
    const sale = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT - 1_000,
      status: "approved",
    });
    const res = await collect(opened.charge.id, edcBody(sale));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(res.body)).not.toMatch(/invalid|validation/i);
    expect((await chargeOf(opened.issueId)).status).toBe("open");
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);
  });

  it("EDC retry: same key twice is one settlement; one approved sale never pays a second charge", async () => {
    const first = await openCharge();
    const second = await openCharge();
    const sale = await ledgerSale({
      reference: first.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });
    const body = edcBody(sale);

    const one = await collect(first.charge.id, body);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const again = await collect(first.charge.id, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toEqual(one.body.data);
    expect(await chargePaidEvents(first.issueId)).toHaveLength(1);

    // The same sale offered for the other charge (new key) is refused.
    const reuse = await collect(second.charge.id, edcBody(sale));
    expect(reuse.status).toBeGreaterThanOrEqual(400);
    expect(reuse.status).toBeLessThan(500);
    expect((await chargeOf(second.issueId)).status).toBe("open");
    expect(await chargePaidEvents(second.issueId)).toHaveLength(0);
  });

  it("an already paid charge cannot be collected again by QRIS or EDC", async () => {
    const opened = await openCharge();
    expect((await collect(opened.charge.id, cashBody())).status).toBe(200);
    const moves = await movementCount();
    const intents = await intentCount();
    const sale = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });

    const qris = await collect(opened.charge.id, qrisBody());
    const edc = await collect(opened.charge.id, edcBody(sale));
    expect(qris.status).toBe(409);
    expect(edc.status).toBe(409);
    expect(JSON.stringify(qris.body)).not.toMatch(/invalid|validation/i);
    expect(await intentCount()).toBe(intents);
    expect(await movementCount()).toBe(moves);
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
  });

  it("no open shift on the device: QRIS and EDC are refused with SHIFT_NOT_OPEN, nothing written", async () => {
    const opened = await openCharge();
    const intents = await intentCount();
    const sale = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });
    const qris = await collect(
      opened.charge.id,
      qrisBody(),
      cashier,
      NO_SHIFT_DEVICE_ID,
    );
    const edc = await collect(
      opened.charge.id,
      edcBody(sale),
      cashier,
      NO_SHIFT_DEVICE_ID,
    );
    expect(qris.status).toBe(409);
    expect(JSON.stringify(qris.body)).toContain("SHIFT_NOT_OPEN");
    expect(edc.status).toBe(409);
    expect(JSON.stringify(edc.body)).toContain("SHIFT_NOT_OPEN");
    expect((await chargeOf(opened.issueId)).status).toBe("open");
    expect(await intentCount()).toBe(intents);
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);
  });

  it("cash path unchanged: cash_in on the shift, expected cash rises, event says pos_cash, change returned", async () => {
    const opened = await openCharge();
    const cashBefore = await expectedCash();
    const moves = await movementCount();

    const res = await collect(opened.charge.id, cashBody(AMOUNT + 1_915));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.charge.status).toBe("paid");
    expect(res.body.data.charge.amountIdr).toBe(AMOUNT);
    expect(res.body.data.changeIdr).toBe(1_915);

    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("paid");
    expect(row.cash_movement_id).not.toBeNull();
    expect(row.payment_intent_id).toBeNull();
    expect(await movementCount()).toBe(moves + 1);
    expect(await expectedCash()).toBe(cashBefore + AMOUNT);
    const events = await chargePaidEvents(opened.issueId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({
      method: "pos_cash",
      amountIdr: AMOUNT,
    });
  });

  it("cash while a POS QRIS is pending: cash wins, the intent is expired, a late QRIS payment is not a second charge_paid", async () => {
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    expect(intentId).not.toBeNull();

    const cash = await collect(opened.charge.id, cashBody());
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(await intentStatus(intentId)).toBe("expired");

    await settleQris(intentId);
    expect((await chargeOf(opened.issueId)).status).toBe("paid");
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(1);
  });

  it("another charge of the same tenant is untouched by a QRIS or EDC collect", async () => {
    const target = await openCharge();
    const bystander = await openCharge();
    // legend-f1mmf: the code first; an approved sale waiting to be recorded
    // refuses a new QRIS code (one money path at a time).
    expectAccepted(await collect(target.charge.id, qrisBody()));
    const sale = await ledgerSale({
      reference: target.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });
    expect((await collect(target.charge.id, edcBody(sale))).status).toBe(200);

    const row = await chargeOf(bystander.issueId);
    expect(row.status).toBe("open");
    expect(row.payment_intent_id).toBeNull();
    expect(row.cash_movement_id).toBeNull();
    expect(await chargePaidEvents(bystander.issueId)).toHaveLength(0);
  });

  it("another outlet's cashier and another tenant's host cannot collect this charge by QRIS or EDC", async () => {
    const opened = await openCharge();
    const intents = await intentCount();
    const sale = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });
    const otherShift = await openShiftFor(
      otherOutletCashier.userId,
      OTHER_OUTLET_DEVICE_ID,
      w.ids.otherOutlet,
      await businessDateOf(opened.order.id),
    );
    expect(otherShift).not.toBe("");
    const stranger = await createIsolatedTenant(
      `gt98h-${randomUUID().slice(0, 6)}`,
    );

    for (const body of [qrisBody(), edcBody(sale)]) {
      const otherOutlet = await collect(
        opened.charge.id,
        body,
        otherOutletCashier,
        OTHER_OUTLET_DEVICE_ID,
      );
      expect([403, 404], JSON.stringify(otherOutlet.body)).toContain(
        otherOutlet.status,
      );
      const otherTenant = await collect(
        opened.charge.id,
        body,
        cashier,
        DEVICE_ID,
        stranger.hostname,
      );
      expect([401, 403, 404]).toContain(otherTenant.status);
    }
    const row = await chargeOf(opened.issueId);
    expect(row.status).toBe("open");
    expect(row.payment_intent_id).toBeNull();
    expect(await intentCount()).toBe(intents);
    expect(await chargePaidEvents(opened.issueId)).toHaveLength(0);

    // The rightful cashier still collects it (feature exists, scope is the only gate).
    // legend-f1mmf: the approved sale is the only way left (no QRIS on top).
    expectAccepted(await collect(opened.charge.id, edcBody(sale)));
    expect((await chargeOf(opened.issueId)).status).toBe("paid");
  });
});
