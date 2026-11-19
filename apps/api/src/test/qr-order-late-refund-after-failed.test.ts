// legend-p61pe (tier K, money): a QR order voided as `refund_committed` files
// the late-payment refund for what is left (nothing, when an approved 100%
// refund R already took the money). If R later FAILS, the guest's money must
// come back by a new late-payment refund (requested_by `system:qr`).
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as qr-order-fire-refund-cap.test.ts).
//
// Assumptions:
// - The order total is whatever the cart totals; "Rp100.000" in the brief is
//   only an example. "Full" refund = totalIdr.
// - R "approved" is NOT a raw row: a raw 'approved' row (as in
//   qr-order-fire-refund-cap.test.ts) cannot be failed through /retry (it is
//   quarantined for lacking a real approval). So R is a pending refund really
//   approved over HTTP with the fake gateway answering "pending" (R stays
//   approved, has a providerRef), and then fails by a provider update
//   (applyRefundProviderUpdate status "failed" -> failed/provider_declined),
//   as in payment-refund-approval.test.ts.
// - The new refund of P1 is the only `payment_refunds` row of that intent with
//   requested_by `system:qr`, status `pending`, amount cap - (reserved - pending).
// - The new refund of P3/P4 is failed through POST /refunds/:id/approve with the
//   fake gateway declining.
// - P2 uses an intent whose order was never voided (still awaiting payment) and
//   that has no late-payment key. The cap_exceeded failure route is not covered.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { applyRefundProviderUpdate } from "../services/payment-refund.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededTenantId,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };
let ids: ReturnType<typeof newIds>;
const createdTenantIds: string[] = [];

const newIds = () => ({
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
});
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const ADMIN = "/api/payments/admin";

/** QRIS gateway double (the guest pays by QRIS). */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRFIRECAP",
      issuer: null,
    };
    return {
      providerRef: `QFC-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}
const gateway = new FakeGateway();

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function contextOf(
  tenantId: string,
  source: "session" | "domain" | "job" = "session",
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "tenant" },
  );
}

// ---- QR ordering (as qr-order-double-pay-payer.test.ts) ----------------------

type Guest = { token: string; sessionId: string };

async function seatAtNewTable(): Promise<Guest> {
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const response = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

function as(guest: Guest) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    add: (menuItemId: string, expectedCartVersion: number) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        menuItemId,
        quantity: 1,
        expectedCartVersion,
      }),
    checkout: (expectedCartVersion: number) =>
      auth(client.post(`${base}/orders`)).send({
        expectedCartVersion,
        idempotencyKey: randomUUID(),
      }),
    pay: (orderId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
  };
}

async function placeOrder(guest: Guest) {
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  expect(placed.body.data.order.status).toBe("awaiting_payment");
  return {
    orderId: placed.body.data.order.id as string,
    totalIdr: placed.body.data.order.totalIdr as number,
  };
}

async function openPayment(guest: Guest, orderId: string): Promise<string> {
  const paid = await as(guest).pay(orderId);
  expect(paid.status).toBe(201);
  expect(paid.body.data.status).toBe("pending");
  return paid.body.data.id as string;
}

/** A verified webhook settlement (the trusted source). */
async function settle(intentId: string, amountIdr: number) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

async function onlyPaidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
     ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliverToQr(event: EventEnvelope) {
  const context = contextOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    void_reason: string | null;
    payment_intent_id: string | null;
    fired_at: Date | null;
  }>(
    `SELECT status, void_reason, payment_intent_id, fired_at
       FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

type RefundRow = {
  id: string;
  status: string;
  amount: string;
  requested_by: string;
  failure_reason: string | null;
};

async function refundsOf(intentId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, status, amount_idr::text AS amount, requested_by, failure_reason
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

const systemRefunds = async (intentId: string) =>
  (await refundsOf(intentId)).filter((row) => row.requested_by === "system:qr");

/** A refund request already filed on the intent (not made via the API). */
async function filedRefund(
  intentId: string,
  amountIdr: number,
  status: "pending" | "approved",
  requestedBy = "fire-cap-test",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, $3, 'Refund uji fire-cap', $4, $5
       FROM payment_intents WHERE tenant_id = $1 AND id = $2
     RETURNING id`,
    [tenant.tenantId, intentId, amountIdr, status, requestedBy],
  );
  return rows[0]!.id;
}

/** A finance + outlet supervisor approver of the isolated tenant. */
async function makeApprover() {
  const copyRole = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
         SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
           FROM roles WHERE tenant_id = $2 AND template_key = $3
         RETURNING id`,
        [tenant.tenantId, seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const financeRole = await copyRole("finance");
  const supervisorRole = await copyRole("supervisor");
  // One tier for every amount: Finance decides in a single level.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenant.tenantId, financeRole],
  );
  const client = agent(app);
  const email = await signUp(client, "Fire Cap Finance");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, financeRole],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, supervisorRole, tenant.outletId],
  );
  return client;
}

// ---- fresh world per case ---------------------------------------------------

async function freshWorld(): Promise<void> {
  ids = newIds();
  tenant = await createIsolatedTenant(`frc-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Fire Cap Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-FRC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
}

/** One code, paid in full, order still awaiting payment; the paid event is not yet consumed. */
async function paidOrder() {
  await freshWorld();
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
  const intentId = await openPayment(guest, orderId);
  await settle(intentId, totalIdr);
  return {
    orderId,
    totalIdr,
    intentId,
    event: await onlyPaidEvent(intentId),
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  // Audit rows are append-only, so the isolated tenants stay; give each a
  // valid creator so the platform tenant list still parses it.
  for (const tenantId of createdTenantIds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

/** Approver acts on a refund through the admin API (real flow). */
async function adminPost(
  approver: Awaited<ReturnType<typeof makeApprover>>,
  refundId: string,
  action: "approve",
) {
  return approver
    .post(`${ADMIN}/refunds/${refundId}/${action}`)
    .set("Host", tenant.hostname)
    .set(originHeader)
    .send({ idempotencyKey: `${action}-${randomUUID()}` });
}

/** Fail a refund: the provider definitively declines the payout. */
async function failViaDecline(
  approver: Awaited<ReturnType<typeof makeApprover>>,
  refundId: string,
  action: "approve",
) {
  const fake = new FakeRefundGateway();
  fake.enqueue("failed");
  setPaymentRefundGateway(fake);
  try {
    const response = await adminPost(approver, refundId, action);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      failureReason: "provider_declined",
    });
    expect(fake.calls).toHaveLength(1);
  } finally {
    setPaymentRefundGateway(null);
  }
}

/** R: a refund really approved over HTTP; the provider accepted it but has not finished. */
async function approvedRefund(
  approver: Awaited<ReturnType<typeof makeApprover>>,
  intentId: string,
  amountIdr: number,
) {
  const refundId = await filedRefund(
    intentId,
    amountIdr,
    "pending",
    staff.userId,
  );
  const fake = new FakeRefundGateway();
  fake.enqueue("pending");
  setPaymentRefundGateway(fake);
  try {
    const response = await adminPost(approver, refundId, "approve");
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.status).toBe("approved");
    return { refundId, providerRef: response.body.data.providerRef as string };
  } finally {
    setPaymentRefundGateway(null);
  }
}

/** The provider reports the payout as failed (definitive decline). */
async function providerFails(providerRef: string, amountIdr: number) {
  await applyRefundProviderUpdate(contextOf(tenant.tenantId), {
    providerRef,
    status: "failed",
    code: "bank_rejected",
    amountIdr,
  });
}

async function refundStatus(refundId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, refundId],
  );
  return rows[0]!.status;
}

/** An owner of the isolated tenant: finance closes refund holds through the route. */
async function makeHoldResolver() {
  const { rows: roles } = await owner.query<{ id: string }>(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key = 'owner'
     RETURNING id`,
    [tenant.tenantId, seededTenantId],
  );
  const client = agent(app);
  const email = await signUp(client, "Hold Resolver");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, roles[0]!.id],
  );
  return client;
}

/**
 * legend-w2td5 (1045 F1): R was sent and then failed, so its intent carries one
 * open hold until finance checks the provider. Asserts that hold exists and
 * that approving the follow-up late refund is refused (409) with no payout.
 */
async function expectHeldAndApproveRefused(
  approver: Awaited<ReturnType<typeof makeApprover>>,
  intentId: string,
  lateRefundId: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM refund_recon_holds
      WHERE tenant_id = $1 AND payment_intent_id = $2
        AND reason = 'own_refund_failed_unverified' AND resolved_at IS NULL`,
    [tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  const fake = new FakeRefundGateway();
  fake.enqueue("succeeded");
  setPaymentRefundGateway(fake);
  try {
    const response = await adminPost(approver, lateRefundId, "approve");
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(fake.calls, "nothing is sent while the hold is open").toHaveLength(
      0,
    );
  } finally {
    setPaymentRefundGateway(null);
  }
  return rows[0]!.id;
}

/** Finance checked the provider dashboard: R is not refunded elsewhere. */
async function resolveHoldNotThisIntent(holdId: string) {
  const resolver = await makeHoldResolver();
  const response = await resolver
    .post(`${ADMIN}/refund-recon-holds/${holdId}/resolve`)
    .set("Host", tenant.hostname)
    .set(originHeader)
    .send({
      idempotencyKey: `hold-${randomUUID()}`,
      resolution: "not_this_intent",
      note: "Dicek di dashboard penyedia: refund gagal, dana masih di kami.",
    });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

describe("QR order late refund after the committed refund failed (legend-p61pe)", () => {
  it("QR-LATE-REFUND-P1 order voided refund_committed by an approved 100% refund R; R then fails: a new pending system:qr refund returns the full amount", async () => {
    const w = await paidOrder();
    const approver = await makeApprover();
    const { refundId, providerRef } = await approvedRefund(
      approver,
      w.intentId,
      w.totalIdr,
    );

    await deliverToQr(w.event);
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.void_reason).toBe("refund_committed");
    // Precondition: nothing is left, so no late refund yet.
    expect(await systemRefunds(w.intentId)).toEqual([]);

    await providerFails(providerRef, w.totalIdr);

    expect(await refundStatus(refundId)).toBe("failed");
    const refunds = await refundsOf(w.intentId);
    expect(refunds).toHaveLength(2);
    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.totalIdr),
        requested_by: "system:qr",
      }),
    ]);
  });

  it("QR-LATE-REFUND-P2 a refund failing on an ordinary intent (no voided QR order, no late-payment key) files no new refund", async () => {
    const w = await paidOrder();
    // The paid event is never consumed: the order stays awaiting payment.
    const approver = await makeApprover();
    const { refundId, providerRef } = await approvedRefund(
      approver,
      w.intentId,
      w.totalIdr,
    );

    await providerFails(providerRef, w.totalIdr);

    expect(await refundStatus(refundId)).toBe("failed");
    expect(await refundsOf(w.intentId)).toHaveLength(1);
    expect(await systemRefunds(w.intentId)).toEqual([]);
    expect((await orderRow(w.orderId)).status).not.toBe("voided");
  });

  it("QR-LATE-REFUND-P3 a failing late-payment refund is not filed again", async () => {
    // A partial committed refund voids the order; the consumer files the
    // late-payment refund for the rest (system:qr).
    const w = await paidOrder();
    const partial = 10_000;
    await filedRefund(w.intentId, partial, "approved");
    const approver = await makeApprover();

    await deliverToQr(w.event);
    expect((await orderRow(w.orderId)).void_reason).toBe("refund_committed");
    const late = await systemRefunds(w.intentId);
    expect(late).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.totalIdr - partial),
      }),
    ]);

    await failViaDecline(approver, late[0]!.id, "approve");

    expect(await refundStatus(late[0]!.id)).toBe("failed");
    expect(await refundsOf(w.intentId)).toHaveLength(2);
    expect(await systemRefunds(w.intentId)).toHaveLength(1);
  });

  it("QR-LATE-REFUND-P4 the refund filed after R failed also fails: no third refund", async () => {
    const w = await paidOrder();
    const approver = await makeApprover();
    const { providerRef } = await approvedRefund(
      approver,
      w.intentId,
      w.totalIdr,
    );
    await deliverToQr(w.event);
    await providerFails(providerRef, w.totalIdr);
    const [second] = await systemRefunds(w.intentId);
    expect(second).toBeDefined();

    // legend-w2td5 (1045 F1): R was sent, so the intent is held; finance
    // closes the hold, then the late refund is approved and declined.
    const holdId = await expectHeldAndApproveRefused(
      approver,
      w.intentId,
      second!.id,
    );
    await resolveHoldNotThisIntent(holdId);
    await failViaDecline(approver, second!.id, "approve");

    expect(await refundStatus(second!.id)).toBe("failed");
    expect(await refundsOf(w.intentId)).toHaveLength(2);
    expect(await systemRefunds(w.intentId)).toHaveLength(1);
  });

  // Assumptions (P5): P is a raw pending staff refund inserted after R was
  // approved (a raw insert skips the cap check at filing time). The amount of
  // LP2 is not asserted (it depends on how the late refund counts P); only
  // that approving LP2 while P is still pending is not rejected as
  // cap_exceeded. The fake gateway answers "succeeded", so LP2 may end
  // `approved` or `completed`.
  it("QR-LATE-REFUND-P5 a replacement late refund approved while another staff refund is still pending is not failed cap_exceeded", async () => {
    const w = await paidOrder();
    const approver = await makeApprover();
    const { refundId, providerRef } = await approvedRefund(
      approver,
      w.intentId,
      w.totalIdr,
    );
    const partial = 1_000;
    const pendingId = await filedRefund(
      w.intentId,
      partial,
      "pending",
      staff.userId,
    );

    await deliverToQr(w.event);
    const order = await orderRow(w.orderId);
    expect(order.void_reason).toBe("refund_committed");

    await providerFails(providerRef, w.totalIdr);
    expect(await refundStatus(refundId)).toBe("failed");
    const [late] = await systemRefunds(w.intentId);
    expect(late, "replacement late refund LP2 was not filed").toBeDefined();
    expect(late!.status).toBe("pending");

    // legend-w2td5 (1045 F1): R was sent, so the intent is held; finance
    // closes the hold before LP2 can be approved.
    const holdId = await expectHeldAndApproveRefused(
      approver,
      w.intentId,
      late!.id,
    );
    await resolveHoldNotThisIntent(holdId);

    const fake = new FakeRefundGateway();
    fake.enqueue("succeeded");
    setPaymentRefundGateway(fake);
    try {
      const response = await adminPost(approver, late!.id, "approve");
      // Before the fix this is a 409 and LP2 is stored failed/cap_exceeded.
      const after = (await refundsOf(w.intentId)).find(
        (row) => row.id === late!.id,
      )!;
      expect(
        response.status,
        `${JSON.stringify(response.body)} stored=${after.status}/${after.failure_reason}`,
      ).toBe(200);
      expect(["approved", "completed"]).toContain(response.body.data.status);
    } finally {
      setPaymentRefundGateway(null);
    }

    expect(["approved", "completed"]).toContain(await refundStatus(late!.id));
    // The staff refund is untouched.
    expect(await refundStatus(pendingId)).toBe("pending");
  });
});
