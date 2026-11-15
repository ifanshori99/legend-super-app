// legend-gjf1 (tier K, money): voiding an unpaid QR order must refund every
// QR payment intent that already settled when the link was only PARTLY paid
// (link.paidIdr < link.totalIdr, e.g. a split bill with 2 of 3 parts paid).
//
// Bug under test: voidUnpaidQrOrderTx voided the order and its parts but never
// asked for a refund of the settled partial intents, so the guests' money
// stayed with the outlet.
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as bill-split-sweep.test.ts).
//
// Assumptions:
// - "Link with 2 paid intents, partly paid" = a 3-part equal split where two
//   parts are paid by QRIS (settled, payment.paid consumed) and the third is
//   not paid.
// - The staff path is `voidUnpaidQrOrder(context, orderId, { reason,
//   actorUserId: staff.userId })`.
// - Each refund is the `payment_refunds` row filed by `system:qr` for the
//   intent's own amount; the once-only key `qr-late-payment-refund:<intentId>`
//   is the `payment_admin_idempotency` row of that name (one per paid intent).
// - A second staff void of an already voided order may resolve or reject (the
//   contract only requires it to be safe); either way it must not add a
//   refund, so its outcome is not asserted.
// - Sweep at "now + 5 minutes" (as bill-split-sweep.test.ts); the voided order
//   is not a candidate any more, so it must add nothing.
// - "No one paid too much, outlet not out of pocket": total refunded over the
//   link <= total settled over the link, and each intent is refunded at most
//   its own paid amount.

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
import { sweepUnpaidQrOrders } from "../services/qr-order-consumers.ts";
import {
  qrOrderSettlementLookup,
  voidUnpaidQrOrder,
} from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
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

const MINUTE = 60_000;
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

/** QRIS gateway double. */
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
            qrPayload: "00020101021226FAKEVOIDPARTIAL",
            issuer: null,
          };
    return {
      providerRef: `VPR-${randomBytes(6).toString("hex")}-${this.created}`,
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

// ---- QR ordering + split ------------------------------------------------------

type Guest = { token: string; sessionId: string };
type Part = { id: string; amountIdr: number };

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
    split: (parts: number) =>
      auth(client.post(`${base}/splits`)).send({
        method: "equal",
        parts,
        idempotencyKey: randomUUID(),
      }),
    claim: (splitId: string, payerSecret: string) =>
      auth(client.post(`${base}/splits/${splitId}/claim`)).send({
        payerSecret,
      }),
    paySplit: (billSplitId: string, method: "qris" | "va" = "qris") =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method,
        ...(method === "va" ? { bankCode: "bmri" } : {}),
        payerSecret: secretFor(billSplitId),
        idempotencyKey: randomUUID(),
      }),
  };
}

async function splitOrder(count: number) {
  await freshWorld();
  const guest = await seatAtNewTable();
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  const orderId = placed.body.data.order.id as string;
  const split = await as(guest).split(count);
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  return { guest, orderId, parts: split.body.data.splits as Part[] };
}

async function openCode(
  guest: Guest,
  part: Part,
  method: "qris" | "va" = "qris",
): Promise<string> {
  const response = await as(guest).paySplit(part.id, method);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

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

/** Open a code, settle it and consume the paid event; returns the intent id. */
async function payPart(guest: Guest, part: Part): Promise<string> {
  const intentId = await openCode(guest, part);
  await settle(intentId, part.amountIdr);
  const event = await onlyPaidEvent(intentId);
  const context = contextOf(tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
  return intentId;
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

type RefundRow = { amount: string; requested_by: string };

async function refundsOf(intentId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT amount_idr::text AS amount, requested_by FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

// ---- fresh world per case ---------------------------------------------------

async function freshWorld(): Promise<void> {
  ids = newIds();
  tenant = await createIsolatedTenant(`vpr-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Void Partial Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-VPR', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
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

const VOID_INPUT = { reason: "Staf membatalkan pesanan" };

/** Settled and total of the order's payment link (paid_idr < total_idr = partly paid). */
async function linkOf(orderId: string) {
  const { rows } = await owner.query<{ paid: string; total: string }>(
    `SELECT l.paid_idr::text AS paid, l.total_idr::text AS total
       FROM payment_links l JOIN orders o ON o.payment_link_id = l.id AND o.tenant_id = l.tenant_id
      WHERE o.tenant_id = $1 AND o.id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return { paid: Number(rows[0]!.paid), total: Number(rows[0]!.total) };
}

async function lateRefundKeys(): Promise<string[]> {
  const { rows } = await owner.query<{ key: string }>(
    `SELECT key FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key LIKE 'qr-late-payment-refund:%' ORDER BY key`,
    [tenant.tenantId],
  );
  return rows.map((row) => row.key);
}

describe("Void of a partly paid QR order refunds each settled intent (legend-gjf1)", () => {
  it("QR-VOID-PARTIAL-01 staff void with 2 of 3 parts paid and a third code still open: 2 refunds exactly once, none for the open code, replay and sweep add nothing", async () => {
    const w = await splitOrder(3);
    const [p0, p1, p2] = w.parts as [Part, Part, Part];
    const paid0 = await payPart(w.guest, p0);
    const paid1 = await payPart(w.guest, p1);
    // The third code is a VA: an open QR holds the bill and the staff void is
    // refused (409 QRIS_HOLD_ACTIVE) until the provider proves it dead
    // (legend-kf104). A VA has no hold, so "a third code still open" keeps its
    // meaning here; the QR-hold void paths are covered by the hold tests.
    const open2 = await openCode(w.guest, p2, "va");

    const link = await linkOf(w.orderId);
    expect(link.paid).toBe(p0.amountIdr + p1.amountIdr);
    expect(link.paid).toBeLessThan(link.total);

    const context = contextOf(tenant.tenantId);
    await voidUnpaidQrOrder(context, w.orderId, {
      ...VOID_INPUT,
      actorUserId: staff.userId,
    });

    expect((await orderRow(w.orderId)).status).toBe("voided");
    expect(await refundsOf(paid0)).toEqual([
      { amount: String(p0.amountIdr), requested_by: "system:qr" },
    ]);
    expect(await refundsOf(paid1)).toEqual([
      { amount: String(p1.amountIdr), requested_by: "system:qr" },
    ]);
    expect(await refundsOf(open2)).toEqual([]);
    expect(await lateRefundKeys()).toEqual(
      [
        `qr-late-payment-refund:${paid0}`,
        `qr-late-payment-refund:${paid1}`,
      ].sort(),
    );
    // Nobody is refunded more than was settled.
    const refunded = [
      ...(await refundsOf(paid0)),
      ...(await refundsOf(paid1)),
    ].reduce((sum, row) => sum + Number(row.amount), 0);
    expect(refunded).toBeLessThanOrEqual(link.paid);

    // Void again (may resolve or reject) and sweep later: nothing new.
    await voidUnpaidQrOrder(context, w.orderId, {
      ...VOID_INPUT,
      actorUserId: staff.userId,
    }).catch(() => undefined);
    await sweepUnpaidQrOrders(context, new Date(Date.now() + 5 * MINUTE));
    await sweepUnpaidQrOrders(context, new Date(Date.now() + 5 * MINUTE));

    expect(await refundsOf(paid0)).toHaveLength(1);
    expect(await refundsOf(paid1)).toHaveLength(1);
    expect(await refundsOf(open2)).toEqual([]);
    expect(await lateRefundKeys()).toHaveLength(2);
    expect((await orderRow(w.orderId)).status).toBe("voided");
  });

  it("QR-VOID-PARTIAL-02 staff void with 2 of 3 parts paid and the third never opened: still exactly one refund per paid intent", async () => {
    const w = await splitOrder(3);
    const [p0, p1] = w.parts as [Part, Part, Part];
    const paid0 = await payPart(w.guest, p0);
    const paid1 = await payPart(w.guest, p1);

    const link = await linkOf(w.orderId);
    expect(link.paid).toBeLessThan(link.total);

    const context = contextOf(tenant.tenantId);
    await voidUnpaidQrOrder(context, w.orderId, {
      ...VOID_INPUT,
      actorUserId: staff.userId,
    });
    await voidUnpaidQrOrder(context, w.orderId, {
      ...VOID_INPUT,
      actorUserId: staff.userId,
    }).catch(() => undefined);

    expect((await orderRow(w.orderId)).status).toBe("voided");
    expect(await refundsOf(paid0)).toEqual([
      { amount: String(p0.amountIdr), requested_by: "system:qr" },
    ]);
    expect(await refundsOf(paid1)).toEqual([
      { amount: String(p1.amountIdr), requested_by: "system:qr" },
    ]);
    expect(await lateRefundKeys()).toHaveLength(2);
  });
});
