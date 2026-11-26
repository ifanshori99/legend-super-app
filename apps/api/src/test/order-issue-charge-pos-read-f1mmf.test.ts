// legend-f1mmf: the cashier reads one dearer-swap charge before taking the
// money: GET /api/order-issue-charges/:chargeId. The amount, the swap lines,
// the code that can still take money and the charge's EDC sales all come
// from the server. A code past its expiry stays `pending` until its margin
// (HOLD_CLOSE_MARGIN_MS) passed and the provider holds nothing, and no second
// QRIS code is opened before that (one live code per charge). Another
// tenant's or another outlet's charge is a 404. Setup copied from
// order-charge-refund-982-pos-nontunai-gt98h.test.ts.

import { randomUUID } from "node:crypto";
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
import { posIssueChargeDetailSchema } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  backdateIntentExpiry,
  installScriptedGateway,
  type ScriptedGateway,
} from "./payment-link-cancel-provider-helpers.ts";
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

const qrisBody = (idempotencyKey = randomUUID()) => ({
  idempotencyKey,
  method: "qris",
});
function expectAccepted(res: { status: number; body: unknown }) {
  expect([200, 201, 202], JSON.stringify(res.body)).toContain(res.status);
}

async function intentCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_intents WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
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
  needsReconciliation?: boolean;
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
          approval_code, rrn, completed_at, needs_reconciliation)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               'APP123', $10, $11, $12)`,
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
        input.needsReconciliation ?? false,
      ],
    ),
  );
  return id;
}

function read(
  chargeId: string,
  who: { client: ReturnType<typeof agent> } = cashier,
  deviceId: string | null = DEVICE_ID,
  host: string = w.tenant.hostname,
) {
  const request = who.client
    .get(`/api/order-issue-charges/${chargeId}`)
    .set("Host", host)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceHeader(deviceId));
  return request;
}

async function detailOf(chargeId: string) {
  const res = await read(chargeId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return posIssueChargeDetailSchema.parse(res.body.data);
}

async function setExpiry(intentId: string, secondsAgo: number) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - ($3::int * interval '1 second')
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, intentId, secondsAgo],
  );
}

describe("legend-f1mmf the cashier reads a swap charge before taking the money", () => {
  let gateway: ScriptedGateway;
  beforeAll(() => {
    gateway = installScriptedGateway();
  });

  it("answers the server's amount, the two dishes and nothing out yet", async () => {
    const opened = await openCharge();
    const detail = await detailOf(opened.charge.id);
    expect(detail.id).toBe(opened.charge.id);
    expect(detail.status).toBe("open");
    expect(detail.amountIdr).toBe(AMOUNT);
    expect(detail.differenceIdr).toBe(DIFFERENCE);
    expect(detail.orderNumber).toBe(opened.order.number);
    expect(detail.original.quantity).toBeGreaterThan(0);
    expect(detail.replacement.lineTotalIdr - detail.original.lineTotalIdr).toBe(
      DIFFERENCE,
    );
    expect(detail.payment).toBeNull();
    expect(detail.edcSales).toEqual([]);
  });

  it("lists only this charge's EDC sales, newest first, with the reconciliation flag", async () => {
    const opened = await openCharge();
    const other = await openCharge();
    const declined = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "declined",
    });
    await owner.query(
      "UPDATE edc_transactions SET created_at = now() - interval '1 minute' WHERE id = $1",
      [declined],
    );
    const flagged = await ledgerSale({
      reference: opened.charge.id,
      amountIdr: AMOUNT,
      status: "cancelled",
      needsReconciliation: true,
    });
    await ledgerSale({
      reference: other.charge.id,
      amountIdr: AMOUNT,
      status: "approved",
    });
    const detail = await detailOf(opened.charge.id);
    expect(detail.edcSales.map((sale) => sale.id)).toEqual([flagged, declined]);
    expect(detail.edcSales[0]!.needsReconciliation).toBe(true);
    expect(detail.edcSales[1]!.needsReconciliation).toBe(false);
    expect(detail.edcSales[1]!.mode).toBe("ecr");
  });

  it("shows the QRIS code the till opened, then paid once the gateway confirms", async () => {
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    const waiting = await detailOf(opened.charge.id);
    expect(waiting.payment?.id).toBe(intentId);
    expect(waiting.payment?.method).toBe("qris");
    expect(waiting.payment?.status).toBe("pending");
    expect(waiting.payment?.amountIdr).toBe(AMOUNT);

    await settleQris(intentId);
    const paid = await detailOf(opened.charge.id);
    expect(paid.status).toBe("paid");
    expect(paid.paidAt).not.toBeNull();
  });

  it("a code just past its expiry stays pending and no second code is opened", async () => {
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    await setExpiry(intentId, 20);
    gateway.script(intentId, { rawStatus: "02" });

    expect((await detailOf(opened.charge.id)).payment?.status).toBe("pending");
    const intents = await intentCount();
    const again = await collect(opened.charge.id, qrisBody());
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(await intentCount()).toBe(intents);
    expect((await chargeOf(opened.issueId)).payment_intent_id).toBe(intentId);
  });

  it("a code the provider cannot confirm stays pending, even long past its expiry", async () => {
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    await backdateIntentExpiry(w.tenant.tenantId, intentId, 5);
    gateway.script(intentId, { error: "timeout" });

    const detail = await detailOf(opened.charge.id);
    expect(detail.payment?.id).toBe(intentId);
    expect(detail.payment?.status).toBe("pending");
  });

  it("a code long past its expiry that the provider says is dead reads expired, and only then a new code opens", async () => {
    const opened = await openCharge();
    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const intentId = (await chargeOf(opened.issueId)).payment_intent_id!;
    await backdateIntentExpiry(w.tenant.tenantId, intentId, 5);
    gateway.script(intentId, { rawStatus: "02" });

    const ended = await detailOf(opened.charge.id);
    expect(ended.payment?.id).toBe(intentId);
    expect(ended.payment?.status).toBe("expired");

    expectAccepted(await collect(opened.charge.id, qrisBody()));
    const renewed = await detailOf(opened.charge.id);
    expect(renewed.payment?.id).not.toBe(intentId);
    expect(renewed.payment?.status).toBe("pending");
  });

  it("another outlet's cashier, another tenant and an unknown id all get 404; no session 401", async () => {
    const opened = await openCharge();
    const otherOutlet = await read(
      opened.charge.id,
      otherOutletCashier,
      OTHER_OUTLET_DEVICE_ID,
    );
    expect(otherOutlet.status, JSON.stringify(otherOutlet.body)).toBe(404);

    const stranger = await createIsolatedTenant(
      `f1mmf-${randomUUID().slice(0, 6)}`,
    );
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Kasir Asing', false, NULL, $3, false, '["tenant","outlet"]')`,
      [roleId, stranger.tenantId, JSON.stringify(["pos.payment.accept"])],
    );
    const strangerClient = agent(w.app);
    await signUp(strangerClient, "Kasir Asing");
    const session = await strangerClient.get("/api/auth/get-session");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [stranger.tenantId, session.body.user.id, roleId, stranger.outletId],
    );
    const otherTenant = await read(
      opened.charge.id,
      { client: strangerClient },
      null,
      stranger.hostname,
    );
    expect(otherTenant.status, JSON.stringify(otherTenant.body)).toBe(404);

    expect((await read(randomUUID())).status).toBe(404);
    const anonymous = await agent(w.app)
      .get(`/api/order-issue-charges/${opened.charge.id}`)
      .set("Host", w.tenant.hostname);
    expect(anonymous.status).toBe(401);
  });
});
