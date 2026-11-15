// legend-9vzvs (tier K, money): firing a QR pay-first order must not happen
// when refunds already committed on the paying intent leave too little of that
// intent to pay the order. Otherwise the kitchen cooks the order AND the guest
// gets the money back.
//
// Rule under test (handleQrOrderPaymentPaid, before the order is fired): lock
// the PAYER intent, then if (reserved - pending) + (total - DP) > cap of that
// intent, the order is voided (void_reason `refund_committed`), a late-payment
// refund is filed for what is left, and the order is NOT fired. A `pending`
// refund does not block: the order fires and approving that refund later fails
// with `cap_exceeded` (REFUND_INTENT_IN_QR_SALE on the request).
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as qr-order-double-pay-payer.test.ts).
//
// Assumptions:
// - The order total is whatever the cart totals (one Kopi Susu with service
//   charge and PBJT); "Rp100.000" in the brief is only an example. The intent
//   settles exactly that total, and "full" refunds are totalIdr.
// - "Approved, not completed" is a raw payment_refunds row with status
//   'approved' (no refund gateway installed, so nothing pays it out), as in
//   qr-order-late-payment.test.ts.
// - The void outcome name is not pinned: the consumer result's `outcome` must
//   only mention "void" or "refund_committed" (implementation answers
//   `late_payment_refund_committed`). The void reason is asserted as `refund_committed`.
// - A late-payment refund filed by the consumer is the one `requested_by`
//   'system:qr'; "no new row" means no such row exists.
// - Approving a pending refund of a fired order answers 409
//   REFUND_INTENT_IN_QR_SALE, the row ends failed/cap_exceeded and the refund
//   gateway is never called (as payment-refund-qr-sale-guard.test.ts).
// - F5 uses a 10000 partial refund (the brief's 40000 of 100000 would exceed
//   this cart's total); the late refund is then totalIdr - 10000.
// - F6/F7: a `completed` refund is a raw row with status 'completed' and
//   completed_at set; the intent status is set by hand to `refunded` (100%) or
//   `partially_refunded` (partial), as the refund completion would leave it.
// - F9: the DP (10000) is set on the order before the QR is opened, so the
//   intent amount is totalIdr - DP; the approved refund (5000) is raw.
// - F10: a fired order cannot coexist with a completed refund under the guard
//   (committed > 0 voids), so "fired after the refund" is asserted against the
//   timestamp that is defined: fired_at >= paid_at of the intent. (fired_at
//   is not later than the pending refund's created_at: it follows the
//   payment time, so that comparison is not asserted.)

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
import { confirmPayment } from "../services/payment.service.ts";
import { sweepUnpaidQrOrders } from "../services/qr-order-consumers.ts";
import { runPosQrisHoldCheckJob } from "../worker/pos-qris-hold-check.job.ts";
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
const GUARD_CODE = "REFUND_INTENT_IN_QR_SALE";

/** QRIS gateway double (the guest pays by QRIS). */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  /** Provider references the provider reports as expired (rawStatus "02"). */
  readonly dead = new Set<string>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: input.channelCode ?? "bmri",
            channelName: "Mandiri",
            virtualAccountNumber: "8808123456789012",
          }
        : {
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
    if (this.dead.has(input.providerRef))
      return {
        status: "expired" as const,
        rawStatus: "02",
        providerRef: input.providerRef,
        amountIdr: null,
      };
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels(_context: unknown, method: string) {
    return method === "va" ? [{ code: "bmri", name: "Mandiri" }] : [];
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
    pay: (orderId: string, method: "qris" | "va" = "qris") =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method,
        ...(method === "va" ? { bankCode: "bmri" } : {}),
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

async function openPayment(
  guest: Guest,
  orderId: string,
  method: "qris" | "va" = "qris",
): Promise<string> {
  const paid = await as(guest).pay(orderId, method);
  expect(paid.status).toBe(201);
  expect(paid.body.data.status).toBe("pending");
  return paid.body.data.id as string;
}

/** A verified webhook settlement (the trusted source). */
async function settle(
  intentId: string,
  amountIdr: number,
  method: "qris" | "va" = "qris",
) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method,
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

async function orderPaidEventCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
        AND event->'payload'->>'orderId' = $2`,
    [tenant.tenantId, orderId],
  );
  return Number(rows[0]!.n);
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

/** A refund already completed on the intent, and the intent status it leaves. */
async function completedRefund(
  intentId: string,
  amountIdr: number,
  intentStatus: "refunded" | "partially_refunded",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, completed_at)
     SELECT tenant_id, outlet_id, id, $3, 'Refund uji completed', 'completed', 'fire-cap-test', now()
       FROM payment_intents WHERE tenant_id = $1 AND id = $2
     RETURNING id`,
    [tenant.tenantId, intentId, amountIdr],
  );
  await owner.query(
    `UPDATE payment_intents SET status = $3 WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, intentId, intentStatus],
  );
  return rows[0]!.id;
}

/** Like paidOrder, but the order carries a deposit that the QR does not collect. */
async function paidOrderWithDeposit(depositIdr: number) {
  await freshWorld();
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      "UPDATE orders SET deposit_applied_idr = $3 WHERE tenant_id = $1 AND id = $2::uuid",
      [tenant.tenantId, ulidToUuid(orderId), depositIdr],
    ),
  );
  const intentId = await openPayment(guest, orderId);
  const dueIdr = totalIdr - depositIdr;
  await settle(intentId, dueIdr);
  return {
    orderId,
    totalIdr,
    dueIdr,
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

describe("QR order fire versus refunds committed on the payer intent (legend-9vzvs)", () => {
  it("QR-FIRE-REFUND-F1 an approved full refund exists when payment.paid arrives: the order is voided as refund_committed, never fired, no second refund", async () => {
    const w = await paidOrder();
    await filedRefund(w.intentId, w.totalIdr, "approved");

    const result = await deliverToQr(w.event);

    // Soft: a missing void must not hide the other checks.
    expect
      .soft(String((result as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const order = await orderRow(w.orderId);
    expect.soft(order.status).toBe("voided");
    expect.soft(order.void_reason).toBe("refund_committed");
    expect(order.fired_at).toBeNull();
    expect(await orderPaidEventCount(w.orderId)).toBe(0);
    // Nothing is left to return: the committed refund already covers the intent.
    expect(await systemRefunds(w.intentId)).toEqual([]);
    expect(await refundsOf(w.intentId)).toHaveLength(1);
  });

  it("QR-FIRE-REFUND-F2 a refund still pending does not block: the order fires and approving that refund fails cap_exceeded without calling the gateway", async () => {
    const w = await paidOrder();
    const refundId = await filedRefund(
      w.intentId,
      w.totalIdr,
      "pending",
      staff.userId,
    );
    const approver = await makeApprover();

    const result = await deliverToQr(w.event);

    expect(result).toMatchObject({ outcome: "fired" });
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("sent");
    expect(order.fired_at).not.toBeNull();
    expect(order.payment_intent_id).toBe(w.intentId);
    expect(await orderPaidEventCount(w.orderId)).toBe(1);

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approver
        .post(`${ADMIN}/refunds/${refundId}/approve`)
        .set("Host", tenant.hostname)
        .set(originHeader)
        .send({ idempotencyKey: `apr-${randomUUID()}` });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe(GUARD_CODE);
      expect(await refundsOf(w.intentId)).toEqual([
        expect.objectContaining({
          id: refundId,
          status: "failed",
          failure_reason: "cap_exceeded",
        }),
      ]);
      expect(fake.calls).toHaveLength(0);
    } finally {
      setPaymentRefundGateway(null);
    }
  });

  it("QR-FIRE-REFUND-F3 superseded code A pays and A is refunded: the check uses payer A, so the order is voided, not fired", async () => {
    await freshWorld();
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    // Code A is a VA: a QR A would hold the bill and refuse B until the
    // provider proves A dead (legend-kf104). A lapsed past the late-payment
    // grace, so the replacement B is allowed.
    const intentA = await openPayment(guest, orderId, "va");
    await owner.query(
      `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, intentA],
    );
    // B is a VA too: with a QR B the consumer cannot void the order for the
    // refunded A while B's QR hold is open (QRIS_HOLD_ACTIVE out of
    // `handleQrOrderPaymentPaid`, finding reported with legend-kf104).
    const intentB = await openPayment(guest, orderId, "va");
    expect(intentB).not.toBe(intentA);
    // The order points at B, yet the guest pays the superseded code A.
    expect((await orderRow(orderId)).payment_intent_id).toBe(intentB);
    await settle(intentA, totalIdr, "va");
    const eventA = await onlyPaidEvent(intentA);
    await filedRefund(intentA, totalIdr, "approved");

    const result = await deliverToQr(eventA);

    expect
      .soft(String((result as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const order = await orderRow(orderId);
    expect.soft(order.status).toBe("voided");
    expect.soft(order.void_reason).toBe("refund_committed");
    expect(order.fired_at).toBeNull();
    expect(await orderPaidEventCount(orderId)).toBe(0);
    expect(await systemRefunds(intentA)).toEqual([]);
    expect(await refundsOf(intentB)).toEqual([]);
  });

  it("QR-FIRE-REFUND-F3b payer A has a committed refund while code B holds the bill: the event neither fails nor voids, and A is refunded once", async () => {
    await freshWorld();
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    // A is a VA that lapsed past the late-payment grace (as F3); B is a QR, so
    // its hold (legend-kf104) freezes the order against a void.
    const intentA = await openPayment(guest, orderId, "va");
    await owner.query(
      `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, intentA],
    );
    const intentB = await openPayment(guest, orderId);
    const partial = 10_000;
    await settle(intentA, totalIdr, "va");
    const eventA = await onlyPaidEvent(intentA);
    await filedRefund(intentA, partial, "approved");

    // The void is held by B's hold, so it must not throw out of the consumer
    // (that would retry and dead-letter the event). The refund of what is left
    // of A still goes out: the direction that limits money.
    const result = await deliverToQr(eventA);

    expect(result).toMatchObject({ outcome: "late_payment_refund_committed" });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");
    expect((await orderRow(orderId)).fired_at).toBeNull();
    expect(await orderPaidEventCount(orderId)).toBe(0);
    const refunded = [
      expect.objectContaining({
        status: "pending",
        amount: String(totalIdr - partial),
      }),
    ];
    expect(await systemRefunds(intentA)).toEqual(refunded);
    expect(await refundsOf(intentB)).toEqual([]);

    // Redelivery: still one refund, the guest never gets back more than paid.
    await deliverToQr(eventA);
    expect(await systemRefunds(intentA)).toEqual(refunded);

    // Voided later (SO-879): B is proven dead by the hold check job and the
    // refunds of A are all completed, so the sweep voids the order. A's money
    // is back in full and not refunded a second time.
    const { rows: bRows } = await owner.query<{ provider_ref: string }>(
      `UPDATE payment_intents SET expires_at = now() - interval '15 minutes'
        WHERE tenant_id = $1 AND id = $2 RETURNING provider_ref`,
      [tenant.tenantId, intentB],
    );
    gateway.dead.add(bRows[0]!.provider_ref);
    await runPosQrisHoldCheckJob(contextOf(tenant.tenantId), new Date(), {
      force: true,
    });
    await owner.query(
      `UPDATE payment_refunds SET status = 'completed', completed_at = now()
        WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [tenant.tenantId, intentA],
    );
    await owner.query(
      "UPDATE payment_intents SET status = 'refunded' WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, intentA],
    );

    await sweepUnpaidQrOrders(
      contextOf(tenant.tenantId),
      new Date(Date.now() + 10 * 60_000),
    );
    await sweepUnpaidQrOrders(
      contextOf(tenant.tenantId),
      new Date(Date.now() + 10 * 60_000),
    );

    expect((await orderRow(orderId)).status).toBe("voided");
    expect((await orderRow(orderId)).void_reason).toBe(
      "payment_refunded_codes_dead",
    );
    expect(await orderPaidEventCount(orderId)).toBe(0);
    expect(await refundsOf(intentA)).toHaveLength(2);
    expect(await refundsOf(intentB)).toEqual([]);
  });

  it("QR-FIRE-REFUND-F4 no refund at all: the order fires, fired_at is set and the payer is the paying intent", async () => {
    const w = await paidOrder();

    const result = await deliverToQr(w.event);

    expect(result).toMatchObject({ outcome: "fired" });
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("sent");
    expect(order.fired_at).not.toBeNull();
    expect(order.payment_intent_id).toBe(w.intentId);
    expect(await orderPaidEventCount(w.orderId)).toBe(1);
    expect(await refundsOf(w.intentId)).toEqual([]);
  });

  it("QR-FIRE-REFUND-F5 a partly refunded intent (10000 approved) cannot pay the order: voided, not fired, and the rest is refunded as a late payment", async () => {
    const w = await paidOrder();
    const partial = 10_000;
    await filedRefund(w.intentId, partial, "approved");

    const result = await deliverToQr(w.event);

    expect
      .soft(String((result as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const order = await orderRow(w.orderId);
    expect.soft(order.status).toBe("voided");
    expect.soft(order.void_reason).toBe("refund_committed");
    expect(order.fired_at).toBeNull();
    expect(await orderPaidEventCount(w.orderId)).toBe(0);
    // The guest gets back the whole payment: 10000 approved + the rest.
    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.totalIdr - partial),
      }),
    ]);
  });

  it("QR-FIRE-REFUND-F6 a 100% refund already completed (intent refunded) when payment.paid arrives: the order is voided, not awaiting_payment, not fired, and no new refund is filed", async () => {
    const w = await paidOrder();
    await completedRefund(w.intentId, w.totalIdr, "refunded");

    const result = await deliverToQr(w.event);

    expect
      .soft(String((result as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.fired_at).toBeNull();
    expect(await orderPaidEventCount(w.orderId)).toBe(0);
    // Nothing is left to return.
    expect(await systemRefunds(w.intentId)).toEqual([]);
    expect(await refundsOf(w.intentId)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
  });

  it("QR-FIRE-REFUND-F7 a 10000 refund completed (intent partially_refunded): the order is voided and the rest is filed as a late-payment refund", async () => {
    const w = await paidOrder();
    const partial = 10_000;
    await completedRefund(w.intentId, partial, "partially_refunded");

    const result = await deliverToQr(w.event);

    expect
      .soft(String((result as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.fired_at).toBeNull();
    expect(await orderPaidEventCount(w.orderId)).toBe(0);
    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.totalIdr - partial),
      }),
    ]);
  });

  it("QR-FIRE-REFUND-F8 replaying the same payment.paid after a void keeps one late-payment refund and the order voided", async () => {
    const w = await paidOrder();
    const partial = 10_000;
    await completedRefund(w.intentId, partial, "partially_refunded");

    await deliverToQr(w.event);
    expect((await orderRow(w.orderId)).status).toBe("voided");
    await deliverToQr(w.event);

    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.fired_at).toBeNull();
    expect(await orderPaidEventCount(w.orderId)).toBe(0);
    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({
        amount: String(w.totalIdr - partial),
      }),
    ]);
    expect(await refundsOf(w.intentId)).toHaveLength(2);
  });

  it("QR-FIRE-REFUND-F8 replaying a payment.paid whose intent was fully refunded files no refund and keeps the order voided", async () => {
    const w = await paidOrder();
    await filedRefund(w.intentId, w.totalIdr, "approved");

    await deliverToQr(w.event);
    await deliverToQr(w.event);

    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.fired_at).toBeNull();
    expect(await systemRefunds(w.intentId)).toEqual([]);
    expect(await refundsOf(w.intentId)).toHaveLength(1);
  });

  it("QR-FIRE-REFUND-F9 an order with a deposit: an approved refund leaving less than total - DP voids it, without a refund it fires", async () => {
    const dp = 10_000;
    const refunded = await paidOrderWithDeposit(dp);
    expect(refunded.dueIdr).toBe(refunded.totalIdr - dp);
    await filedRefund(refunded.intentId, 5_000, "approved");

    const voidResult = await deliverToQr(refunded.event);

    expect
      .soft(String((voidResult as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const voided = await orderRow(refunded.orderId);
    expect(voided.status).toBe("voided");
    expect(voided.fired_at).toBeNull();
    expect(await orderPaidEventCount(refunded.orderId)).toBe(0);

    const clean = await paidOrderWithDeposit(dp);
    const fireResult = await deliverToQr(clean.event);

    expect(fireResult).toMatchObject({ outcome: "fired" });
    const fired = await orderRow(clean.orderId);
    expect(fired.status).toBe("sent");
    expect(fired.fired_at).not.toBeNull();
    expect(await orderPaidEventCount(clean.orderId)).toBe(1);
    expect(await refundsOf(clean.intentId)).toEqual([]);
  });

  it("QR-FIRE-REFUND-F10 an order that fires with a pending refund on its intent is fired no earlier than the intent was paid", async () => {
    const w = await paidOrder();
    await filedRefund(w.intentId, w.totalIdr, "pending", staff.userId);

    const result = await deliverToQr(w.event);

    expect(result).toMatchObject({ outcome: "fired" });
    const { rows } = await owner.query<{ ordered: boolean }>(
      `SELECT o.fired_at >= i.paid_at AS ordered
         FROM orders o
         JOIN payment_intents i ON i.id = $3 AND i.tenant_id = o.tenant_id
        WHERE o.tenant_id = $1 AND o.id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(w.orderId), w.intentId],
    );
    expect(rows).toEqual([{ ordered: true }]);
  });
});
