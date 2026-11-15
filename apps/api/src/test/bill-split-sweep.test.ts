// legend-ms3 split bill, unpaid-order sweep (design D4/D5, ORD-06, ORD-02):
//
// - a split order whose parts are mostly paid is not voided by the payment
//   attempt cap (3 paid codes + 1 unpaid part must keep waiting);
// - when the table session closes with paid parts, the order is voided and
//   each paid part's intent gets exactly one refund request, replay-safe.
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as qr-order-late-partial-refund.test.ts).
//
// Assumptions:
// - The sweep runs at "now + 5 minutes": past the 2 minute late-payment grace
//   (so the order is a candidate) and before the 15 minute abandon limit.
// - To make the attempt cap bite on the old logic, the paid codes' expiry is
//   moved into the past (their status stays `paid`).
// - "Not voided by attempts" means: order still `awaiting_payment`, the three
//   paid parts still paid, the fourth still pending, and no refund requests.
// - Refunds are the `payment_refunds` rows filed by `system:qr`; each paid
//   intent gets one for its own amount, the unpaid part's code gets none.
// - Session closed = table session voided + closed (as
//   qr-order-late-partial-refund.test.ts).

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
import { runPosQrisHoldCheckJob } from "../worker/pos-qris-hold-check.job.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { getSplitClaimByToken } from "../services/bill-split.service.ts";
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
  /** Codes the provider answers final (expired) for (SO-885: only a provider
   * answer proves a code dead; the local expiry never does). */
  readonly expiredRefs = new Set<string>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKESWEEP",
      issuer: null,
    };
    return {
      providerRef: `SWP-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: this.expiredRefs.has(input.providerRef)
        ? ("expired" as const)
        : ("pending" as const),
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
    paySplit: (billSplitId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method: "qris",
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

async function openCode(guest: Guest, part: Part): Promise<string> {
  const response = await as(guest).paySplit(part.id);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/**
 * SO-885: the provider answers final (expired) for the code and the QR hold
 * check ran past its life + margin, so the hold is closed on provider proof
 * (the lapsed local expiry alone keeps the hold, and the order, alive).
 */
async function providerClosesCodes(intentIds: string[], at: Date) {
  const { rows } = await owner.query<{ provider_ref: string }>(
    `SELECT provider_ref FROM payment_intents
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenant.tenantId, intentIds],
  );
  for (const row of rows) gateway.expiredRefs.add(row.provider_ref);
  await runPosQrisHoldCheckJob(contextOf(tenant.tenantId), at, {
    force: true,
  });
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

async function partStatuses(orderId: string): Promise<string[]> {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM bill_splits
      WHERE tenant_id = $1 AND order_id = $2::uuid ORDER BY share_index`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows.map((row) => row.status);
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

async function closeSession(sessionId: string): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `UPDATE table_sessions SET status = 'voided', closed_at = now(), closed_reason = 'voided'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, sessionId],
    ),
  );
}

// ---- fresh world per case ---------------------------------------------------

async function freshWorld(): Promise<void> {
  ids = newIds();
  tenant = await createIsolatedTenant(`bss-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Split Sweep Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-BSS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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

describe("Split bill sweep (legend-ms3, ORD-06)", () => {
  it("ORD-06-SWEEP-01 4 parts with 3 paid: the attempt cap does not void the order or any part", async () => {
    const w = await splitOrder(4);
    const paidIntents: string[] = [];
    for (const part of w.parts.slice(0, 3))
      paidIntents.push(await payPart(w.guest, part));
    // The paid codes lapsed long ago; the cap must not count them against the
    // one part that is still unpaid.
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '10 minutes'
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant.tenantId, paidIntents],
    );

    const context = contextOf(tenant.tenantId);
    const at = new Date(Date.now() + 5 * MINUTE);
    await sweepUnpaidQrOrders(context, at);
    await sweepUnpaidQrOrders(context, at);

    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
    expect(await partStatuses(w.orderId)).toEqual([
      "paid",
      "paid",
      "paid",
      "pending",
    ]);
    for (const intentId of paidIntents)
      expect(await refundsOf(intentId)).toEqual([]);
  });

  it("ORD-06-SWEEP-02 session closed with paid parts: the order is voided and each paid code gets one refund request", async () => {
    const w = await splitOrder(3);
    const [p0, p1, p2] = w.parts as [Part, Part, Part];
    const paid0 = await payPart(w.guest, p0);
    const paid1 = await payPart(w.guest, p1);
    const unpaid2 = await openCode(w.guest, p2);
    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");

    await closeSession(w.guest.sessionId);
    // The payment window ends at the last code's expiry; an open pending code
    // keeps the order alive until it lapses plus the late-payment grace (same
    // rule as a non-split order). Lapse every code first.
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '10 minutes'
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant.tenantId, [paid0, paid1, unpaid2]],
    );
    const context = contextOf(tenant.tenantId);
    const at = new Date(Date.now() + 5 * MINUTE);
    await providerClosesCodes([unpaid2], at);
    await sweepUnpaidQrOrders(context, at);

    expect((await orderRow(w.orderId)).status).toBe("voided");
    expect(await refundsOf(paid0)).toEqual([
      { amount: String(p0.amountIdr), requested_by: "system:qr" },
    ]);
    expect(await refundsOf(paid1)).toEqual([
      { amount: String(p1.amountIdr), requested_by: "system:qr" },
    ]);
    expect(await refundsOf(unpaid2)).toEqual([]);

    // A second sweep finds the order voided and files nothing more.
    await sweepUnpaidQrOrders(context, at);
    expect(await refundsOf(paid0)).toHaveLength(1);
    expect(await refundsOf(paid1)).toHaveLength(1);
    expect(await refundsOf(unpaid2)).toEqual([]);
  });

  // Fix round 2, R3. Assumptions: the claim tokens are issued by the guest
  // GET while the session is still open (the read is session-scoped), the
  // session then closes and the sweep voids the order at `at`. Afterwards the
  // unpaid part is `voided`, no claim redeems (at the real clock or at `at`),
  // and every paid part's claim_expires_at is <= `at`. The status of the paid
  // parts themselves is not asserted.
  it("ORD-06-SWEEP-03 voided order: unpaid parts are voided and paid parts' claims no longer redeem", async () => {
    const w = await splitOrder(3);
    const [p0, p1, p2] = w.parts as [Part, Part, Part];
    const paid0 = await payPart(w.guest, p0);
    const paid1 = await payPart(w.guest, p1);
    const unpaid2 = await openCode(w.guest, p2);

    const tokens: string[] = [];
    for (const part of [p0, p1]) {
      const claim = await as(w.guest).claim(part.id, secretFor(part.id));
      expect(claim.status, JSON.stringify(claim.body)).toBe(200);
      expect(claim.body.data.status).toBe("available");
      tokens.push(claim.body.data.claimToken as string);
    }

    await closeSession(w.guest.sessionId);
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '10 minutes'
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant.tenantId, [paid0, paid1, unpaid2]],
    );
    const context = contextOf(tenant.tenantId);
    const at = new Date(Date.now() + 5 * MINUTE);
    await providerClosesCodes([unpaid2], at);
    await sweepUnpaidQrOrders(context, at);

    expect((await orderRow(w.orderId)).status).toBe("voided");
    expect((await partStatuses(w.orderId))[2]).toBe("voided");

    const { rows } = await owner.query<{
      claim_expires_at: Date;
      claim_redeemed_at: Date | null;
    }>(
      `SELECT claim_expires_at, claim_redeemed_at FROM bill_splits
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant.tenantId, [p0.id, p1.id]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(new Date(row.claim_expires_at).getTime()).toBeLessThanOrEqual(
        at.getTime(),
      );
      expect(row.claim_redeemed_at).toBeNull();
    }
    for (const token of tokens) {
      for (const now of [new Date(), at]) {
        await expect(
          getSplitClaimByToken(context, token, now),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    }
  });
});
