// legend-g510l (tier K, money): the QR consumer must refund what is left of a
// PARTLY refunded intent when its payment.paid event arrives late, i.e. when
// the order is already voided, or the table session is closed.
//
// Bug under test: those two branches of handleQrOrderPaymentPaid only
// continued when the intent was `paid`. An intent `partially_refunded` (a
// partial refund completed before the event was processed) answered
// `unchanged` / `not_settled`, so the rest of the guest's money was never
// returned.
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as qr-order-fire-refund-cap.test.ts).
//
// Assumptions:
// - The order total is whatever the cart totals; "Rp100.000 / 30.000" in the
//   brief is only an example. A 10000 partial refund is used (as
//   qr-order-fire-refund-cap.test.ts F7), so the late refund is
//   totalIdr - 10000.
// - A `completed` refund is a raw row (status 'completed', completed_at set)
//   and the intent status is set by hand to `partially_refunded` / `refunded`,
//   as the refund completion would leave it.
// - "Order voided" (G1, G3, G4) is set by hand on the orders row after the
//   intent settled (void_reason `payment_link_expired`), before the event is
//   delivered.
// - "Session closed" (G2) follows ws03-guest-va.test.ts: the table session is
//   voided and closed while the order is still awaiting_payment.
// - The late refund filed by the consumer is the one `requested_by`
//   'system:qr'; "no new refund" means no such row exists.
// - G3 (full refund done): the outcome name is not pinned; the delivery must
//   not throw, file no system refund, and leave the order voided.

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
import { confirmPayment } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
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
const PARTIAL = 10_000;

/** QRIS gateway double (the guest pays by QRIS). */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
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
            qrPayload: "00020101021226FAKEQRLATEPARTIAL",
            issuer: null,
          };
    return {
      providerRef: `QLR-${randomBytes(6).toString("hex")}-${this.created}`,
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

// ---- QR ordering (as qr-order-fire-refund-cap.test.ts) ----------------------

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
    fired_at: Date | null;
  }>(
    `SELECT status, void_reason, fired_at
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
};

async function refundsOf(intentId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, status, amount_idr::text AS amount, requested_by
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

const systemRefunds = async (intentId: string) =>
  (await refundsOf(intentId)).filter((row) => row.requested_by === "system:qr");

// ---- fresh world per case ---------------------------------------------------

async function freshWorld(): Promise<void> {
  ids = newIds();
  tenant = await createIsolatedTenant(`lpr-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Late Partial Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-LPR', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
}

/** One code paid in full, order still awaiting payment; the paid event is not yet consumed. */
async function paidOrder() {
  await freshWorld();
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
  // The code is a VA: an open QR holds its bill, so the order cannot be voided
  // (these tests void it) and a payment after the provider's proof is parked,
  // never a late payment for this consumer (legend-kf104). A VA has no hold.
  const intentId = await openPayment(guest, orderId, "va");
  await settle(intentId, totalIdr, "va");
  return {
    guest,
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
): Promise<void> {
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, completed_at)
     SELECT tenant_id, outlet_id, id, $3, 'Refund uji completed', 'completed', 'late-partial-test', now()
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, intentId, amountIdr],
  );
  await owner.query(
    `UPDATE payment_intents SET status = $3 WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, intentId, intentStatus],
  );
}

/** The order was voided (for example its payment window lapsed) before the money arrived. */
async function voidOrder(orderId: string): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `UPDATE orders SET status = 'voided', void_reason = 'payment_link_expired'
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    ),
  );
}

/** The table session closed while the order was unpaid (as ws03-guest-va.test.ts). */
async function closeSession(sessionId: string): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `UPDATE table_sessions SET status = 'voided', closed_at = now(), closed_reason = 'voided'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, sessionId],
    ),
  );
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

describe("QR late payment.paid on a partly refunded intent (legend-g510l)", () => {
  it("QR-LATE-PARTIAL-G1 order voided, 10000 refund completed (partially_refunded): the rest is filed as a late-payment refund", async () => {
    const w = await paidOrder();
    await voidOrder(w.orderId);
    await completedRefund(w.intentId, PARTIAL, "partially_refunded");

    const result = await deliverToQr(w.event);

    expect(result).toEqual({
      route: "qr",
      outcome: "late_payment_on_voided_order",
    });
    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.totalIdr - PARTIAL),
      }),
    ]);
    // The voided order is never revived or fired.
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.fired_at).toBeNull();
  });

  it("QR-LATE-PARTIAL-G2 table session closed, order awaiting payment, 10000 refund completed: the order is voided and the rest is refunded", async () => {
    const w = await paidOrder();
    await closeSession(w.guest.sessionId);
    await completedRefund(w.intentId, PARTIAL, "partially_refunded");

    const result = await deliverToQr(w.event);

    expect(result).toEqual({
      route: "qr",
      outcome: "late_payment_on_closed_session",
    });
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.void_reason).toBe("payment_unpaid_session_closed");
    expect(order.fired_at).toBeNull();
    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.totalIdr - PARTIAL),
      }),
    ]);
  });

  it("QR-LATE-PARTIAL-G3 control: intent fully refunded (refunded) on a voided order: no new refund and no error", async () => {
    const w = await paidOrder();
    await voidOrder(w.orderId);
    await completedRefund(w.intentId, w.totalIdr, "refunded");

    await expect(deliverToQr(w.event)).resolves.toBeDefined();

    expect(await systemRefunds(w.intentId)).toEqual([]);
    expect(await refundsOf(w.intentId)).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect((await orderRow(w.orderId)).status).toBe("voided");
  });

  it("QR-LATE-PARTIAL-G4 replaying the G1 event keeps exactly one late-payment refund", async () => {
    const w = await paidOrder();
    await voidOrder(w.orderId);
    await completedRefund(w.intentId, PARTIAL, "partially_refunded");

    await deliverToQr(w.event);
    expect(await systemRefunds(w.intentId)).toHaveLength(1);
    await deliverToQr(w.event);

    expect(await systemRefunds(w.intentId)).toEqual([
      expect.objectContaining({ amount: String(w.totalIdr - PARTIAL) }),
    ]);
    // The completed 10000 refund plus the single late-payment refund.
    expect(await refundsOf(w.intentId)).toHaveLength(2);
    expect((await orderRow(w.orderId)).status).toBe("voided");
  });
});
