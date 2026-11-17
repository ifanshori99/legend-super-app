// legend-m9pf6 (brief 980, "jangan sampai rugi"): six places that decide "this
// sale / split part / bill is paid" read the money a payment brought in as
// `evidence - unallocated funds` and forget the PARTIAL refunds the provider
// made on its own (table payment_provider_refunds, brief 967). After such a
// refund the sale must never be treated as fully paid. Written from the card,
// the 967 fixtures and the existing consumer tests, failing first.
//
// One case per site (each also has a control that passes today, so a failure
// can only come from the missing subtraction):
//  980-1  bill-split.service  allocatedIdrOfIntent   -> a split part whose
//         code was partly refunded by the provider is NOT marked paid.
//  980-2  pos-qris-hold       appliedQrisMoneyTx     -> a QR whose money the
//         provider fully refunded holds no applied money any more.
//  980-3  qr-order-consumers  allocatedIdrByIntent   -> a code partly refunded
//         by the provider no longer "covers the bill alone": a second code's
//         paid event does not fire the order pinned to it.
//  980-4  qr-order-consumers  refundPositionOfLink   -> money returned by the
//         provider counts as returned: every payment paid back (ours +
//         provider's) with all codes dead lets the sweep void the order.
//  980-5  facility-breakfast  allocatedIdrByIntent   -> a breakfast paid with a
//         code the provider partly refunded does not become `paid`.
//  980-6  pos-order-payment   handlePosPaymentPaid   -> a POS QRIS tender
//         whose money the provider fully refunded is never captured.
//
// Assumptions (the card does not fix them):
//  - A provider refund is seeded straight into payment_provider_refunds with
//    the columns the 967 tests use (the webhook path is covered by
//    payment-doit-partial-refund-967.test.ts). It is recorded after the code
//    settled and before its `payment.paid` event is consumed, like 967.
//  - "Not paid" is read from the stored state: bill_splits.status stays
//    `pending`, the order is not `sent`, facility_linked_orders.status is not
//    `paid`/`fired`, pos_order_tenders.status is not `captured`. What the
//    consumer does instead (refund the rest, cancel, void) is not pinned.
//  - 980-3: code A pays the bill and the provider refunds a part of it; code B
//    (a second code, parked as double payment) delivers its paid event first.
//    Before the fix B's event fires the order pinned to A (QR-DOUBLE-PAY-03);
//    after it A's allocation is below what is owed, so nobody covers the bill.
//  - 980-4: the order's paid event is not consumed, all codes are dead, the
//    sweep runs past the late-payment grace. Our completed refund plus the
//    provider's cover every rupiah paid => voided `payment_refunded_codes_dead`
//    (SO-879). With only part of it returned (control) the order stays.
//  - 980-6: a PARTIAL provider refund still leaves money of the code on the
//    tender (counted > 0), so only the full refund is asserted for this site.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-net-paid-provider-refund-980.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
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
import type {
  PaymentChannel,
  PaymentInstructions,
} from "@starter/shared/payment";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { appliedQrisMoneyTx } from "../services/pos-qris-hold.ts";
import {
  resetUnpaidQrSweepCursor,
  sweepUnpaidQrOrders,
} from "../services/qr-order-consumers.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  MINUTE,
  createBreakfastWorld,
  dropBreakfastWorld,
  endPools,
  installGateway,
  linkedOf,
  newMember,
  openIntent,
  paidEvent,
  payLink,
  placeOrder as placeBreakfastOrder,
  removeGateway,
  seedTicket,
  settle as settleBreakfast,
  deliver as deliverBreakfast,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
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
import { agent, originHeader, signUp } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

/** A provider refund smaller than any part, deposit or bill used below. */
const PARTIAL = 1_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const BANKS: PaymentChannel[] = [{ code: "bmri", name: "Mandiri" }];

let app: Express;
const createdTenantIds: string[] = [];

/** Gateway double offering QRIS and one VA bank; every code stays pending. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const bank = BANKS.find((entry) => entry.code === input.channelCode);
    const instructions: PaymentInstructions =
      input.method === "va" && bank
        ? {
            method: "va",
            channelCode: bank.code,
            channelName: bank.name,
            virtualAccountNumber: `8808${String(this.created).padStart(8, "0")}`,
          }
        : {
            method: "qris",
            qrPayload: "00020101021226FAKE980",
            issuer: null,
          };
    return {
      providerRef: `N980-${randomBytes(6).toString("hex")}-${this.created}`,
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
  async channels(
    _context: ScopedTenantContext,
    method: OnlinePaymentMethod,
  ): Promise<PaymentChannel[]> {
    return method === "va" ? [...BANKS] : [];
  }
}
const gateway = new FakeGateway();

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

/** The provider refunded `amountIdr` of the intent on its own (brief 967). */
async function providerRefunded(
  where: Pick<IsolatedTenant, "tenantId" | "outletId">,
  intentId: string,
  amountIdr: number,
): Promise<void> {
  await asOwnerTenant(where.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')`,
      [
        where.tenantId,
        where.outletId,
        intentId,
        `rf_${randomUUID().slice(0, 12)}`,
        `pay_${intentId.slice(0, 12)}`,
        amountIdr,
      ],
    ),
  );
}

/** A verified webhook settlement (the trusted source). */
async function settleIntent(
  tenantId: string,
  intentId: string,
  amountIdr: number,
  method: "qris" | "va" = "qris",
) {
  await confirmPayment(contextOf(tenantId), intentId, {
    source: "verified_webhook",
    method,
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

async function paymentEventsOf(
  tenantId: string,
  name: string,
  intentId: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'intentId' = $3
      ORDER BY created_at, id`,
    [tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function onlyPaidEventOf(
  tenantId: string,
  intentId: string,
): Promise<EventEnvelope> {
  const events = await paymentEventsOf(tenantId, "payment.paid", intentId);
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliverEvent(tenantId: string, event: EventEnvelope) {
  const context = contextOf(tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
});

afterAll(async () => {
  // Audit rows are append-only, so the isolated tenants stay; give each a
  // valid creator so the platform tenant list still parses it.
  for (const tenantId of createdTenantIds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await endPools();
});

// ---------------------------------------------------------------------------
// QR ordering world (980-1, 980-3, 980-4): a fresh isolated tenant per case
// ---------------------------------------------------------------------------

type Guest = { token: string; sessionId: string };
type Part = {
  id: string;
  amountIdr: number;
  shareIndex: number;
  status: string;
};

let qrTenant: IsolatedTenant;
let qrStaff: Staff;
let qrHeaders: { Host: string };
let qrIds: { category: string; kopi: string; priceList: string };

async function qrFreshWorld(): Promise<void> {
  qrIds = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
  };
  qrTenant = await createIsolatedTenant(`n980-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(qrTenant.tenantId);
  qrStaff = await staffOfIsolatedTenant(app, qrTenant);
  qrHeaders = { Host: qrTenant.hostname };
  await asOwnerTenant(qrTenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Net Paid 980', 0)`,
      [qrIds.category, qrTenant.tenantId, qrTenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [
        qrIds.kopi,
        qrTenant.tenantId,
        qrTenant.brandId,
        qrIds.category,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [qrIds.priceList, qrTenant.tenantId, qrTenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), qrTenant.tenantId, qrIds.priceList, qrIds.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), qrTenant.tenantId, qrStaff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-N980', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), qrTenant.tenantId, qrStaff.userId],
    );
  });
}

async function seatAtNewTable(): Promise<Guest> {
  const zone = await createZone(
    qrStaff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    qrHeaders,
  );
  const table = await createTable(
    qrStaff.client,
    { zoneId: zone.id },
    qrHeaders,
  );
  const qr = await issueQr(qrStaff.client, table.id, qrHeaders);
  const response = await scan(app, {
    token: qr.token,
    hostname: qrTenant.hostname,
  });
  expect(response.status).toBe(201);
  const token: string = response.body.data.sessionToken;
  const sessionId: string = response.body.data.session.id;
  return { token, sessionId };
}

function as(guest: Guest) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", qrTenant.hostname)
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
    split: (parts: number) =>
      auth(client.post(`${base}/splits`)).send({
        method: "equal",
        parts,
        idempotencyKey: randomUUID(),
      }),
    paySplit: (billSplitId: string, method: "qris" | "va") =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method,
        payerSecret: secretFor(billSplitId),
        ...(method === "va" ? { bankCode: "bmri" } : {}),
        idempotencyKey: randomUUID(),
      }),
  };
}

async function placeQrOrder(guest: Guest) {
  const added = await as(guest).add(qrIds.kopi, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  expect(placed.body.data.order.status).toBe("awaiting_payment");
  const orderId: string = placed.body.data.order.id;
  const totalIdr: number = placed.body.data.order.totalIdr;
  return { orderId, totalIdr };
}

async function openOrderCode(
  guest: Guest,
  orderId: string,
  method: "qris" | "va" = "qris",
): Promise<string> {
  const response = await as(guest).pay(orderId, method);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const id: string = response.body.data.id;
  return id;
}

async function qrOrderRow(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    void_reason: string | null;
    payment_intent_id: string | null;
  }>(
    `SELECT status, void_reason, payment_intent_id
       FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [qrTenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

async function splitRow(partId: string) {
  const { rows } = await owner.query<{
    status: string;
    claim_token_hash: string | null;
    payment_intent_id: string | null;
  }>(
    `SELECT status, claim_token_hash, payment_intent_id
       FROM bill_splits WHERE tenant_id = $1 AND id = $2`,
    [qrTenant.tenantId, partId],
  );
  return rows[0]!;
}

describe("legend-m9pf6 QR and split-bill paid checks after a partial provider refund", () => {
  beforeAll(() => {
    setPaymentGateway(gateway);
    setTableSessionSettlementLookup(qrOrderSettlementLookup);
    setAuditWriter(coreAuditWriter);
  });
  afterAll(() => {
    setPaymentGateway(null);
    setTableSessionSettlementLookup(null);
    setAuditWriter(null);
  });

  /** An order split into two equal parts; the first part's VA code is settled. */
  async function settledSplitPart() {
    await qrFreshWorld();
    const guest = await seatAtNewTable();
    const { orderId } = await placeQrOrder(guest);
    const split = await as(guest).split(2);
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts: Part[] = split.body.data.splits;
    expect(parts).toHaveLength(2);
    const part = parts[0]!;
    const opened = await as(guest).paySplit(part.id, "va");
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const intentId: string = opened.body.data.id;
    await settleIntent(qrTenant.tenantId, intentId, part.amountIdr, "va");
    return {
      orderId,
      part,
      intentId,
      event: await onlyPaidEventOf(qrTenant.tenantId, intentId),
    };
  }

  it("980-1 control: a split part whose code was paid in full is marked paid by its paid event", async () => {
    const w = await settledSplitPart();

    await deliverEvent(qrTenant.tenantId, w.event);

    const row = await splitRow(w.part.id);
    expect(row.status).toBe("paid");
    expect(row.payment_intent_id).toBe(w.intentId);
  });

  it("980-1 a split part whose code the provider partly refunded is NOT marked paid and gets no claim token", async () => {
    const w = await settledSplitPart();
    await providerRefunded(qrTenant, w.intentId, PARTIAL);

    await deliverEvent(qrTenant.tenantId, w.event);

    const row = await splitRow(w.part.id);
    expect(row.status, "part is not fully paid").toBe("pending");
    expect(row.claim_token_hash).toBeNull();
  });

  /**
   * Code A (a VA, since expired at the provider) pays the bill; code B is paid
   * after it, so its money is parked as a double payment. Both paid events are
   * still to be consumed (as QR-DOUBLE-PAY-03).
   */
  async function orderPaidTwice() {
    await qrFreshWorld();
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeQrOrder(guest);
    const intentA = await openOrderCode(guest, orderId, "va");
    await owner.query(
      `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes',
              provider_final_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [qrTenant.tenantId, intentA],
    );
    const intentB = await openOrderCode(guest, orderId, "qris");
    await settleIntent(qrTenant.tenantId, intentA, totalIdr, "va");
    await settleIntent(qrTenant.tenantId, intentB, totalIdr);
    return {
      orderId,
      intentA,
      intentB,
      eventB: await onlyPaidEventOf(qrTenant.tenantId, intentB),
    };
  }

  it("980-3 control: with code A fully paid, code B's paid event fires the order pinned to A", async () => {
    const w = await orderPaidTwice();

    expect(await deliverEvent(qrTenant.tenantId, w.eventB)).toMatchObject({
      outcome: "fired",
    });
    expect(await qrOrderRow(w.orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: w.intentA,
    });
  });

  it("980-3 once the provider partly refunded code A, code B's paid event does not fire the order on A's allocation", async () => {
    const w = await orderPaidTwice();
    await providerRefunded(qrTenant, w.intentA, PARTIAL);

    const result = await deliverEvent(qrTenant.tenantId, w.eventB);

    expect(result).not.toMatchObject({ outcome: "fired" });
    const order = await qrOrderRow(w.orderId);
    expect(order.status, "A no longer covers the bill alone").not.toBe("sent");
    expect(order.payment_intent_id).not.toBe(w.intentA);
  });

  /**
   * One VA code paid the bill (its paid event is not consumed, the order is
   * still awaiting payment), the code is dead, and the bill was paid back as
   * `back(total)` says: `completedIdr` by a completed refund of ours,
   * `providerIdr` by the provider's own refund.
   */
  async function paidOrderPaidBack(
    back: (totalIdr: number) => { completedIdr: number; providerIdr: number },
  ) {
    await qrFreshWorld();
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeQrOrder(guest);
    const intentId = await openOrderCode(guest, orderId, "va");
    await settleIntent(qrTenant.tenantId, intentId, totalIdr, "va");
    await owner.query(
      "UPDATE payment_intents SET expires_at = now() - interval '15 minutes' WHERE tenant_id = $1 AND id = $2",
      [qrTenant.tenantId, intentId],
    );
    const { completedIdr, providerIdr } = back(totalIdr);
    if (completedIdr > 0)
      await owner.query(
        `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by, completed_at)
         SELECT tenant_id, outlet_id, id, $3, 'Refund uji 980', 'completed', 'net-paid-980', now()
           FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
        [qrTenant.tenantId, intentId, completedIdr],
      );
    if (providerIdr > 0)
      await providerRefunded(qrTenant, intentId, providerIdr);
    await owner.query(
      "UPDATE payment_intents SET status = 'refunded' WHERE tenant_id = $1 AND id = $2",
      [qrTenant.tenantId, intentId],
    );
    return { orderId, totalIdr, intentId };
  }

  async function sweepPastGrace() {
    for (let round = 0; round < 2; round += 1) {
      resetUnpaidQrSweepCursor(qrTenant.tenantId);
      await sweepUnpaidQrOrders(
        contextOf(qrTenant.tenantId),
        new Date(Date.now() + 30 * MINUTE),
      );
    }
  }

  it("980-4 control: only part of the payment was paid back (provider refund alone): the order is not voided", async () => {
    const w = await paidOrderPaidBack(() => ({
      completedIdr: 0,
      providerIdr: PARTIAL,
    }));

    await sweepPastGrace();

    expect((await qrOrderRow(w.orderId)).status).toBe("awaiting_payment");
  });

  it("980-4 our completed refund plus the provider's refund cover everything that was paid: the sweep voids the order", async () => {
    // A completed refund of ours for all but PARTIAL, the provider's own
    // refund for PARTIAL.
    const w = await paidOrderPaidBack((totalIdr) => ({
      completedIdr: totalIdr - PARTIAL,
      providerIdr: PARTIAL,
    }));

    await sweepPastGrace();

    const order = await qrOrderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.void_reason).toBe("payment_refunded_codes_dead");
  });

  it("980-4 the provider refunded the whole payment on its own: the sweep voids the order", async () => {
    const w = await paidOrderPaidBack((totalIdr) => ({
      completedIdr: 0,
      providerIdr: totalIdr,
    }));

    await sweepPastGrace();

    const order = await qrOrderRow(w.orderId);
    expect(order.status).toBe("voided");
    expect(order.void_reason).toBe("payment_refunded_codes_dead");
  });
});

// ---------------------------------------------------------------------------
// POS world (980-2, 980-6): one isolated tenant, one order per case
// ---------------------------------------------------------------------------

describe("legend-m9pf6 POS QRIS paid checks after a provider refund", () => {
  const KOPI_IDR = 25_000;
  const posIds = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
    cashierRole: randomUUID(),
    device: randomUUID(),
  };
  let posTenant: IsolatedTenant;
  let posHeaders: { Host: string };
  let cashier: { client: ReturnType<typeof agent>; userId: string };

  beforeAll(async () => {
    setPaymentGateway(gateway);
    posTenant = await createIsolatedTenant(`n980p-${randomUUID().slice(0, 6)}`);
    createdTenantIds.push(posTenant.tenantId);
    posHeaders = { Host: posTenant.hostname };
    setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
      tenantId === posTenant.tenantId && deviceId === posIds.device
        ? posTenant.outletId
        : null,
    );
    await registerTestDevice(owner, {
      tenantId: posTenant.tenantId,
      outletId: posTenant.outletId,
      deviceId: posIds.device,
    });
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'POS Kasir 980', false, NULL, $3, false, '["tenant"]')`,
      [
        posIds.cashierRole,
        posTenant.tenantId,
        JSON.stringify([
          "order.view",
          "pos.sale.create",
          "pos.payment.accept",
          "shift.cash.operate",
        ]),
      ],
    );
    const client = agent(app);
    await signUp(client, "Net Paid 980 Kasir");
    const session = await client.get("/api/auth/get-session");
    const userId: string = session.body.user.id;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [posTenant.tenantId, userId, posIds.cashierRole],
    );
    cashier = { client, userId };
    await openPosShift(
      contextOf(posTenant.tenantId),
      { userId: userIdSchema.parse(userId), deviceId: posIds.device },
      outletIdSchema.parse(posTenant.outletId),
      { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
    );
    await asOwnerTenant(posTenant.tenantId, async (poolClient) => {
      await poolClient.query(
        `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
         VALUES ($1, $2, $3, 'POS 980', 0)`,
        [posIds.category, posTenant.tenantId, posTenant.brandId],
      );
      await poolClient.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
        [
          posIds.kopi,
          posTenant.tenantId,
          posTenant.brandId,
          posIds.category,
          randomUUID(),
        ],
      );
      await poolClient.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [posIds.priceList, posTenant.tenantId, posTenant.outletId],
      );
      await poolClient.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          randomUUID(),
          posTenant.tenantId,
          posIds.priceList,
          posIds.kopi,
          KOPI_IDR,
        ],
      );
      await poolClient.query(
        `INSERT INTO tax_settings
           (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
            tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
                 'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), posTenant.tenantId, userId],
      );
      await poolClient.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'PBJT-N980P', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                 '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), posTenant.tenantId, userId],
      );
    });
  });
  afterAll(() => {
    setPaymentGateway(null);
  });

  function pos() {
    const base = `/api/outlets/${encodeURIComponent(posTenant.outletId)}/pos/orders`;
    const send = (path: string, body: Record<string, unknown>) =>
      cashier.client
        .post(`${base}${path}`)
        .set(posHeaders)
        .set(originHeader)
        .set(
          DEVICE_TOKEN_HEADER,
          signDeviceToken({
            version: 1,
            issuedAt: Math.floor(Date.now() / 1000),
            tenantId: posTenant.tenantId,
            brandId: null,
            deviceId: posIds.device,
          }),
        )
        .send({ idempotencyKey: randomUUID(), ...body });
    return {
      create: () =>
        send("", {
          channel: "pos",
          serviceType: "takeaway",
          items: [{ menuItemId: posIds.kopi, quantity: 2, modifierIds: [] }],
        }),
      get: (orderId: string) =>
        cashier.client
          .get(`${base}/${orderId}`)
          .set(posHeaders)
          .set(originHeader),
      submit: (orderId: string, expectedStatus: string) =>
        send(`/${orderId}/submit`, { expectedStatus }),
      qris: (orderId: string, expectedStatus: string) =>
        send(`/${orderId}/tenders`, { method: "qris", expectedStatus }),
    };
  }

  async function tenderOf(orderId: string, tenderId: string) {
    const { rows } = await owner.query<{
      status: string;
      payment_intent_id: string | null;
      amount_idr: string;
    }>(
      `SELECT status, payment_intent_id, amount_idr::text AS amount_idr
         FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2::uuid AND id = $3`,
      [posTenant.tenantId, ulidToUuid(orderId), tenderId],
    );
    return rows[0]!;
  }

  /** A POS order with one open QRIS tender (hold) for the whole bill. */
  async function openQrisTender() {
    const created = await pos().create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId: string = created.body.data.id;
    if (created.body.data.status === "draft") {
      const submitted = await pos().submit(orderId, "draft");
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    }
    const read = await pos().get(orderId);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const opened = await pos().qris(orderId, read.body.data.status);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const tenderId: string = opened.body.data.tender.id;
    const tender = await tenderOf(orderId, tenderId);
    expect(tender.status).toBe("authorized");
    const intentId = tender.payment_intent_id;
    if (intentId === null) throw new Error("QRIS tender has no intent");
    return {
      orderId,
      tenderId,
      intentId,
      amountIdr: Number(tender.amount_idr),
    };
  }

  /** Is there money of the QR applied to the bill (it cannot be released)? */
  async function appliedMoney(intentId: string): Promise<boolean> {
    const context = contextOf(posTenant.tenantId);
    return withTenant(db, context, (tx) =>
      appliedQrisMoneyTx(tx, context.tenant.tenantId, intentId),
    );
  }

  it("980-2 control: a paid QR, and one the provider only partly refunded, still hold applied money", async () => {
    const full = await openQrisTender();
    await settleIntent(posTenant.tenantId, full.intentId, full.amountIdr);
    expect(await appliedMoney(full.intentId)).toBe(true);

    const partly = await openQrisTender();
    await settleIntent(posTenant.tenantId, partly.intentId, partly.amountIdr);
    await providerRefunded(posTenant, partly.intentId, PARTIAL);
    expect(await appliedMoney(partly.intentId)).toBe(true);
  });

  it("980-2 a paid QR whose money the provider fully refunded holds no applied money any more", async () => {
    const qr = await openQrisTender();
    await settleIntent(posTenant.tenantId, qr.intentId, qr.amountIdr);
    await providerRefunded(posTenant, qr.intentId, qr.amountIdr);

    expect(await appliedMoney(qr.intentId)).toBe(false);
  });

  it("980-6 control: a QRIS tender paid in full is captured by its paid event", async () => {
    const qr = await openQrisTender();
    await settleIntent(posTenant.tenantId, qr.intentId, qr.amountIdr);
    const event = await onlyPaidEventOf(posTenant.tenantId, qr.intentId);

    await deliverEvent(posTenant.tenantId, event);

    expect((await tenderOf(qr.orderId, qr.tenderId)).status).toBe("captured");
  });

  it("980-6 a QRIS tender whose money the provider fully refunded is never captured", async () => {
    const qr = await openQrisTender();
    await settleIntent(posTenant.tenantId, qr.intentId, qr.amountIdr);
    const event = await onlyPaidEventOf(posTenant.tenantId, qr.intentId);
    await providerRefunded(posTenant, qr.intentId, qr.amountIdr);

    await deliverEvent(posTenant.tenantId, event);

    expect(
      (await tenderOf(qr.orderId, qr.tenderId)).status,
      "no money of this code is left on the sale",
    ).not.toBe("captured");
  });
});

// ---------------------------------------------------------------------------
// Facility breakfast world (980-5)
// ---------------------------------------------------------------------------

describe("legend-m9pf6 breakfast paid check after a partial provider refund", () => {
  let world: BreakfastWorld;

  beforeAll(async () => {
    installGateway();
    world = await createBreakfastWorld(app);
  });
  afterAll(async () => {
    removeGateway();
    await dropBreakfastWorld(world);
  });

  /** A breakfast order whose QRIS code is settled; the paid event is not consumed. */
  async function settledBreakfast() {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const order = await placeBreakfastOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const intent = await openIntent(world, token);
    await settleBreakfast(world, intent.id, intent.amountIdr);
    return {
      orderId: order.id,
      intentId: intent.id,
      event: await paidEvent(world, intent.id),
    };
  }

  it("980-5 control: a breakfast paid in full by its code becomes paid", async () => {
    const w = await settledBreakfast();

    await deliverBreakfast(world, w.event);

    const linked = await linkedOf(world, w.orderId);
    expect(linked.status).toBe("paid");
    expect(linked.paidIntentId).toBe(w.intentId);
  });

  it("980-5 a breakfast whose code the provider partly refunded does not become paid", async () => {
    const w = await settledBreakfast();
    await providerRefunded(world.tenant, w.intentId, PARTIAL);

    await deliverBreakfast(world, w.event);

    const linked = await linkedOf(world, w.orderId);
    expect(["paid", "fired"], "not fully paid").not.toContain(linked.status);
    expect(linked.paidIntentId).toBeNull();
  });
});
