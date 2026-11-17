// Late QRIS payment on a voided QR pay-first order (beads legend-b0au,
// legend-dahl; PRD v1.7 §3.13 "Siklus Pembayaran", PAY-04, ORD-02).
//
// WS-05 now accepts a verified gateway settlement after an intent went
// `failed` (like a late one after `expired`). Before this fix the QR consumer
// treated `payment.failed` as provider-final and voided the order at once;
// the later settlement was booked on the voided order's bill and the consumer
// only logged it, so the guest's money became revenue of a voided order and
// was never refunded. Now `payment.failed` waits for the late-payment grace
// like an expiry, and a settlement that still lands on a voided order files
// exactly one WS-05 system refund request (`system:qr`) for the intent.
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS, in a fresh
// isolated tenant (same setup as order-payment-consumers.test.ts).

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
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import {
  LATE_PAYMENT_GRACE_MS,
  sweepUnpaidQrOrders,
} from "../services/qr-order-consumers.ts";
import { getGuestPayment } from "../services/qr-order-payment.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { runPosQrisHoldCheckJob } from "../worker/pos-qris-hold-check.job.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers.ts";
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

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const MINUTE = 60_000;

/** QRIS gateway double; `status` is what the status poll answers. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  status: "pending" | "failed" = "pending";
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
            qrPayload: "00020101021226FAKEQRLATE",
            issuer: null,
          };
    return {
      providerRef: `QLP-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: this.status,
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
  providerRef: string,
  method: "qris" | "va" = "qris",
) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method,
    amountIdr,
    providerRef,
    at: new Date().toISOString(),
  });
}

async function outboxEvents(
  name: string,
  intentId: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'intentId' = $3
     ORDER BY created_at, id`,
    [tenant.tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function onlyEvent(name: string, intentId: string) {
  const events = await outboxEvents(name, intentId);
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(
  event: EventEnvelope,
  now = new Date(),
  context = contextOf(tenant.tenantId),
) {
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, now),
  );
}

/**
 * legend-kf104: the guest QR holds its bill until the hold check job has the
 * provider's own proof that the code is dead (answer `failed` at or after the
 * code's expiry + 60 s). The unpaid-order void and a replacement code both
 * wait for it, so a test that reaches them first lets the job run, at `now`,
 * with the provider answering `failed`.
 */
async function proveDead(now: Date) {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
  gateway.status = "failed";
  try {
    await runPosQrisHoldCheckJob(context, now, { force: true });
  } finally {
    gateway.status = "pending";
  }
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    void_reason: string | null;
    payment_link_id: string | null;
  }>(
    "SELECT status, void_reason, payment_link_id FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    flags: string[];
    expires_at: Date;
  }>(
    "SELECT status, flags, expires_at FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function refundsOfIntent(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    status: string;
    requested_by: string;
  }>(
    `SELECT id, amount_idr::text AS amount_idr, status, requested_by
     FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

async function refundAudits(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_logs a
     JOIN payment_refunds r ON r.id::text = a.event->>'objectId'
     WHERE a.tenant_id = $1 AND a.event->>'action' = 'payment.refund_requested'
       AND r.payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return Number(rows[0]?.count ?? 0);
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`qlp-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Late Payment Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-QLP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // Audit rows are append-only, so the isolated tenant stays; give it a
  // valid creator so the platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("QR pay-first late payment after payment.failed (legend-b0au, legend-dahl)", () => {
  it("a failed code waits the grace; a verified settlement on the voided order files one system refund", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    // The code is a VA: a QR code holds its bill until the provider proves it
    // dead, and a payment after that proof is parked, never refunded through
    // this consumer (legend-kf104). A VA has no hold, so the grace and the late
    // payment on a voided order work as before. The QR hold paths are the
    // describe at the end of this file.
    const intentId = await openPayment(guest, orderId, "va");

    // The gateway reports the code failed on the guest's status poll.
    const failedAt = new Date();
    gateway.status = "failed";
    try {
      const polled = await getGuestPayment(
        contextOf(tenant.tenantId),
        guest.token,
        guest.sessionId,
        intentId,
        failedAt,
      );
      expect(polled.status).toBe("failed");
    } finally {
      gateway.status = "pending";
    }
    const failed = await onlyEvent("payment.failed", intentId);

    // The WS-05 bill then lapses: no fresh code can be opened, so the order is
    // voided once the payment window closes.
    const { payment_link_id: linkId } = await orderRow(orderId);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, linkId],
      ),
    );

    // Before the fix `payment.failed` was provider-final and voided at once,
    // although WS-05 still accepts a verified settlement after `failed`.
    expect(await deliver(failed, failedAt)).toEqual({
      route: "qr",
      outcome: "awaiting_grace",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");

    // The grace past the code's end elapses with no money: the order voids.
    const { expires_at: codeEnd } = await intentRow(intentId);
    const afterGrace = new Date(
      codeEnd.getTime() + LATE_PAYMENT_GRACE_MS + MINUTE,
    );
    expect(await deliver(failed, afterGrace)).toEqual({
      route: "qr",
      outcome: "voided",
    });
    expect(await orderRow(orderId)).toMatchObject({
      status: "voided",
      void_reason: "payment_link_expired",
    });

    // The guest's money still arrives: a verified webhook settles it late.
    const ref = `WEBHOOK-${randomBytes(6).toString("hex")}`;
    await settle(intentId, totalIdr, ref, "va");
    const settled = await intentRow(intentId);
    expect(settled.status).toBe("paid");
    expect(settled.flags).toContain("late_payment");
    const paid = await onlyEvent("payment.paid", intentId);

    // TEN-01: another tenant's worker context changes nothing.
    expect(await deliver(paid, new Date(), contextOf(seededTenantId))).toEqual({
      route: "ignored",
    });
    expect(await refundsOfIntent(intentId)).toHaveLength(0);

    // Before the fix the consumer only logged it: zero refund rows.
    expect(await deliver(paid)).toEqual({
      route: "qr",
      outcome: "late_payment_on_voided_order",
    });
    const refunds = await refundsOfIntent(intentId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: String(totalIdr),
      status: "pending",
      requested_by: "system:qr",
    });
    expect(await refundAudits(intentId)).toBe(1);
    // The voided order is never revived.
    expect((await orderRow(orderId)).status).toBe("voided");

    // Replays (sequential and concurrent): still one refund, one audit.
    await settle(intentId, totalIdr, ref, "va");
    expect(await outboxEvents("payment.paid", intentId)).toHaveLength(1);
    await deliver(paid);
    await Promise.all([deliver(paid), deliver(paid)]);
    expect(await refundsOfIntent(intentId)).toHaveLength(1);
    expect(await refundAudits(intentId)).toBe(1);
  });

  // legend-2dnh (PAY-04): the system refund opens its approval chain when it is
  // created, so a supervisor finds it without anyone submitting it first.
  it("PAY-04 the QR late-payment refund opens its approval chain at creation", async () => {
    // The tenant needs its refund approval matrix (supervisor from Rp0).
    await withTenant(db, contextOf(tenant.tenantId), (tx) =>
      seedTenantRoleTemplates(tx, tenant.tenantId),
    );
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const intentId = await openPayment(guest, orderId, "va");
    const failedAt = new Date();
    gateway.status = "failed";
    try {
      await getGuestPayment(
        contextOf(tenant.tenantId),
        guest.token,
        guest.sessionId,
        intentId,
        failedAt,
      );
    } finally {
      gateway.status = "pending";
    }
    const failed = await onlyEvent("payment.failed", intentId);
    const { payment_link_id: linkId } = await orderRow(orderId);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, linkId],
      ),
    );
    const { expires_at: codeEnd } = await intentRow(intentId);
    const afterGrace = new Date(
      codeEnd.getTime() + LATE_PAYMENT_GRACE_MS + MINUTE,
    );
    await deliver(failed, afterGrace);
    expect((await orderRow(orderId)).status).toBe("voided");
    await settle(
      intentId,
      totalIdr,
      `WEBHOOK-${randomBytes(6).toString("hex")}`,
      "va",
    );
    const paid = await onlyEvent("payment.paid", intentId);
    expect(await deliver(paid)).toEqual({
      route: "qr",
      outcome: "late_payment_on_voided_order",
    });

    const { rows } = await owner.query<{
      id: string;
      approval_chain_id: string | null;
    }>(
      "SELECT id, approval_chain_id FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenant.tenantId, intentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approval_chain_id).not.toBeNull();
    const chain = await owner.query<{ status: string; requested_by: string }>(
      `SELECT status, requested_by FROM approval_requests
       WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
      [tenant.tenantId, rows[0]!.id],
    );
    expect(chain.rows).toEqual([
      {
        status: "pending",
        requested_by: "00000000-0000-4000-8000-000000000002",
      },
    ]);

    // A replay creates no second refund and no second chain.
    await deliver(paid);
    const again = await owner.query(
      "SELECT 1 FROM approval_requests WHERE tenant_id = $1 AND object_id = $2",
      [tenant.tenantId, rows[0]!.id],
    );
    expect(again.rowCount).toBe(1);
  });
});

describe("QR late-payment refund ignores refunds still pending (legend-leqj6)", () => {
  /** A voided QR order whose intent the guest then paid late; the paid event. */
  async function lateSettledOrder() {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const intentId = await openPayment(guest, orderId, "va");
    const failedAt = new Date();
    gateway.status = "failed";
    try {
      await getGuestPayment(
        contextOf(tenant.tenantId),
        guest.token,
        guest.sessionId,
        intentId,
        failedAt,
      );
    } finally {
      gateway.status = "pending";
    }
    const failed = await onlyEvent("payment.failed", intentId);
    const { payment_link_id: linkId } = await orderRow(orderId);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, linkId],
      ),
    );
    const { expires_at: codeEnd } = await intentRow(intentId);
    const afterGrace = new Date(
      codeEnd.getTime() + LATE_PAYMENT_GRACE_MS + MINUTE,
    );
    expect(await deliver(failed, afterGrace)).toEqual({
      route: "qr",
      outcome: "voided",
    });
    await settle(
      intentId,
      totalIdr,
      `WEBHOOK-${randomBytes(6).toString("hex")}`,
      "va",
    );
    return {
      intentId,
      totalIdr,
      paid: await onlyEvent("payment.paid", intentId),
    };
  }

  async function filedRefund(
    intentId: string,
    amountIdr: number,
    status: "pending" | "approved",
    requestedBy = "leqj6-test",
  ) {
    await owner.query(
      `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       SELECT tenant_id, outlet_id, id, $3, 'Refund uji leqj6', $4, $5
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, intentId, amountIdr, status, requestedBy],
    );
  }

  /**
   * The tenant's two refund approvers, set up once for the whole describe (the
   * policy row and role changes must not be inserted twice). `staff` is the
   * first approver; the returned account is the second.
   */
  let approversReady: Promise<Staff> | undefined;
  function readyApprovers(): Promise<Staff> {
    approversReady ??= (async () => {
      // The tenant's floor-only role needs the refund permissions and a place in
      // the default Rp0 refund tier (beside the supervisor template) BEFORE the
      // late refund is filed: a system refund opens its approval chain at
      // creation (legend-2dnh) and one approver decides.
      await owner.query(
        "UPDATE roles SET permissions = permissions || $2::jsonb WHERE tenant_id = $1 AND id = $3",
        [
          tenant.tenantId,
          JSON.stringify([
            "payment.reconcile",
            "pos.refund.approve",
            "approval.inbox.view",
            "approval.request.decide",
          ]),
          tenant.roleId,
        ],
      );
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
         VALUES ($1, 'refund', 0, $2, 1)`,
        [tenant.tenantId, tenant.roleId],
      );
      const second = await staffOfIsolatedTenant(app, tenant);
      await verifySessionMfa(staff.email);
      await verifySessionMfa(second.email);
      // Q63: a refund approver also needs an amount ceiling. Both approvers hold
      // the tenant's supervisor template at the outlet (Rp200.000 per bill).
      await withTenant(db, contextOf(tenant.tenantId), (tx) =>
        seedTenantRoleTemplates(tx, tenant.tenantId),
      );
      for (const approver of [staff, second])
        await owner.query(
          `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
           SELECT $1, $2, r.id, 'outlet', $3, now() - interval '1 hour', $2
             FROM roles r WHERE r.tenant_id = $1 AND r.template_key = 'supervisor'`,
          [tenant.tenantId, approver.userId, tenant.outletId],
        );
      return second;
    })();
    return approversReady;
  }

  it("a pending 1000 refund is not subtracted: the late refund returns the whole amount", async () => {
    const { intentId, totalIdr, paid } = await lateSettledOrder();
    await filedRefund(intentId, 1000, "pending");

    expect(await deliver(paid)).toEqual({
      route: "qr",
      outcome: "late_payment_on_voided_order",
    });
    const late = (await refundsOfIntent(intentId)).filter(
      (row) => row.requested_by === "system:qr",
    );
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      amount_idr: String(totalIdr),
      status: "pending",
    });
  });

  it("approving the late refund first succeeds; the old pending refund then fails cap_exceeded", async () => {
    const second = await readyApprovers();

    const { intentId, totalIdr, paid } = await lateSettledOrder();
    await filedRefund(intentId, 1000, "approved");
    // The older pending refund is requested by `staff`, so `second` decides it.
    await filedRefund(intentId, 2000, "pending", staff.userId);
    await deliver(paid);
    const rows = await refundsOfIntent(intentId);
    const late = rows.find((row) => row.requested_by === "system:qr")!;
    const older = rows.find(
      (row) => row.requested_by === staff.userId && row.status === "pending",
    )!;
    expect(late.amount_idr).toBe(String(totalIdr - 1000));

    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const decide = (who: Staff, refundId: string) =>
        who.client
          .post(`/api/payments/admin/refunds/${refundId}/approve`)
          .set(headers)
          .set(originHeader)
          .send({ idempotencyKey: `leqj6-${randomUUID()}` });
      const lateResponse = await decide(staff, late.id);
      expect(lateResponse.status, JSON.stringify(lateResponse.body)).toBe(200);
      expect(["approved", "completed"]).toContain(
        lateResponse.body.data.status,
      );
      await decide(second, older.id);
    } finally {
      setPaymentRefundGateway(null);
    }
    const after = await refundsOfIntent(intentId);
    expect(after.filter((row) => row.status === "failed")).toEqual([
      expect.objectContaining({ id: older.id }),
    ]);
    // Guest total: 1000 approved + the late refund = what was paid.
    const kept = after
      .filter((row) => row.status !== "failed")
      .reduce((sum, row) => sum + Number(row.amount_idr), 0);
    expect(kept).toBe(totalIdr);
  });

  it("race: the late refund and the old pending refund are approved at the same moment; together they never exceed what was paid", async () => {
    const second = await readyApprovers();
    const { intentId, totalIdr, paid } = await lateSettledOrder();
    await filedRefund(intentId, 1000, "approved");
    await filedRefund(intentId, 2000, "pending", staff.userId);
    await deliver(paid);
    const rows = await refundsOfIntent(intentId);
    const late = rows.find((row) => row.requested_by === "system:qr")!;
    const older = rows.find(
      (row) => row.requested_by === staff.userId && row.status === "pending",
    )!;
    expect(late.amount_idr).toBe(String(totalIdr - 1000));

    // Two different approvers decide in parallel; the provider call is slowed
    // so both requests are in flight together.
    const fake = new FakeRefundGateway();
    fake.delayMs = 150;
    setPaymentRefundGateway(fake);
    try {
      const decide = (who: Staff, refundId: string) =>
        who.client
          .post(`/api/payments/admin/refunds/${refundId}/approve`)
          .set(headers)
          .set(originHeader)
          .send({ idempotencyKey: `leqj6-race-${randomUUID()}` })
          .then((response) => response);
      const responses = await Promise.all([
        decide(staff, late.id),
        decide(second, older.id),
      ]);
      for (const response of responses)
        expect(response.status, JSON.stringify(response.body)).toBeLessThan(
          500,
        );
    } finally {
      setPaymentRefundGateway(null);
    }

    const after = await refundsOfIntent(intentId);
    // Money cap: whatever the order of the two approvals, what is not failed
    // never exceeds the amount the guest paid.
    const kept = after
      .filter((row) => row.status !== "failed")
      .reduce((sum, row) => sum + Number(row.amount_idr), 0);
    expect(kept).toBeLessThanOrEqual(totalIdr);
    // The two refunds cannot both be paid out (1000 + late + 2000 > paid).
    const decided = (id: string) =>
      after.find((row) => row.id === id)!.status !== "pending" &&
      after.find((row) => row.id === id)!.status !== "failed";
    expect(decided(late.id) && decided(older.id)).toBe(false);
    // The provider was asked once per refund at most, and never for more than
    // the 1000 still free of the approved refund allows.
    const asked = new Map<string, number>(
      fake.calls.map((call): [string, number] => [
        call.idempotencyKey,
        call.amountIdr,
      ]),
    );
    const askedTotal = [...asked.values()].reduce((sum, v) => sum + v, 0);
    expect(askedTotal).toBeLessThanOrEqual(totalIdr - 1000);
  });

  it("regression: an approved 1000 refund is still subtracted", async () => {
    const { intentId, totalIdr, paid } = await lateSettledOrder();
    await filedRefund(intentId, 1000, "approved");

    await deliver(paid);
    const late = (await refundsOfIntent(intentId)).filter(
      (row) => row.requested_by === "system:qr",
    );
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ amount_idr: String(totalIdr - 1000) });
  });
});

describe("legend-kf104 the guest QR hold keeps the unpaid void and a replacement code waiting", () => {
  it("before the provider proves the code dead: a replacement is refused 409, the void is left for later, no money moves; after the proof the void and a new code work", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest);
    const intentId = await openPayment(guest, orderId);
    const failedAt = new Date();
    gateway.status = "failed";
    try {
      await getGuestPayment(
        contextOf(tenant.tenantId),
        guest.token,
        guest.sessionId,
        intentId,
        failedAt,
      );
    } finally {
      gateway.status = "pending";
    }
    const failed = await onlyEvent("payment.failed", intentId);
    const createdBefore = gateway.created;

    // The local status says failed, but only the job's proof closes the hold.
    const early = await as(guest).pay(orderId);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(JSON.stringify(early.body)).toContain("QRIS_HOLD_ACTIVE");
    expect(gateway.created, "no replacement code at the provider").toBe(
      createdBefore,
    );
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");
    expect(await refundsOfIntent(intentId)).toEqual([]);

    // The void is refused by the hold: the consumer leaves the order (it
    // retries on the next event / sweep), it does not throw or dead-letter.
    const { expires_at: codeEnd } = await intentRow(intentId);
    const afterGrace = new Date(
      codeEnd.getTime() + LATE_PAYMENT_GRACE_MS + MINUTE,
    );
    expect(await deliver(failed, afterGrace)).not.toEqual({
      route: "qr",
      outcome: "voided",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_payment");

    await proveDead(afterGrace);
    const next = await as(guest).pay(orderId);
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body.data.id).not.toBe(intentId);
    expect(gateway.created).toBe(createdBefore + 1);
  });

  it("the unpaid sweep skips a bill whose QR hold is active and still voids the bill behind it", async () => {
    const holdGuest = await seatAtNewTable();
    const held = await placeOrder(holdGuest);
    await openPayment(holdGuest, held.orderId);
    const idleGuest = await seatAtNewTable();
    const idle = await placeOrder(idleGuest);

    const later = new Date(Date.now() + 3 * 60 * MINUTE);
    const result = await sweepUnpaidQrOrders(contextOf(tenant.tenantId), later);
    expect(result.voided).toBeGreaterThanOrEqual(1);
    expect((await orderRow(idle.orderId)).status).toBe("voided");
    expect((await orderRow(held.orderId)).status).toBe("awaiting_payment");
  });
});
