// Split bill + QR pay-first sale guard (bead legend-nslvm, tier K / money).
//
// A split bill is ONE payment link with two intents, P1 and P2, each paid for
// part of the bill (each with its own payment_evidence). A QR pay-first order
// is pinned to the payer intent P1 (the first paid event). Before the fix only
// P1 held the whole total - DP, so P2 looked 100% refundable and the guest could
// take P2 back while the kitchen cooked the order.
//
// Rule under test:
// - refundable listing / refund request: for a non-payer intent on the same
//   link the hold is min(total - DP, allocation of that intent), allocation =
//   evidence - unallocated funds; the payer intent still holds total - DP.
// - firing (handleQrOrderPaymentPaid): every contributing intent (allocation > 0)
//   is checked; a committed (approved/completed, not pending) refund on any of
//   them that pushes committed + allocation over that intent's cap voids the
//   order and files a late-payment refund per contributing intent.
//
// Real Express app, services and PostgreSQL with RLS.
//
// Assumptions where the brief is not exact:
// - A split link is raw rows: one payment_links row (total = sum of the shares,
//   paid = total) plus two paid payment_intents with one evidence row each.
//   For the consumer cases (N3, N4) the order and P1 come from the real QR flow
//   (as qr-order-fire-refund-cap.test.ts); P1's amount is lowered to its share
//   before it settles and P2 is a raw paid intent on P1's link (with evidence)
//   whose own paid event is not consumed. The order total is whatever the cart
//   totals, so the 60/40 split is 60%/40% of it ("60000/40000" is an example).
// - "Refund committed 40000 on P2" is a raw payment_refunds row 'approved' of
//   P2's whole share.
// - Refund requests over HTTP answer 409 { error: { code: REFUND_INTENT_IN_QR_SALE } }.
// - A fully held intent is listed with 0 refundable or not listed at all.
// - N2: the double payment P2 is returned through the unallocated-funds
//   resolve endpoint (resolution 'refund' -> 200, one pending refund of 40000);
//   the ordinary refund request is refused as exceeding the paid amount.
// - The void outcome name is not pinned: the consumer outcome only has to
//   mention "void" or "refund_committed"; void_reason is `refund_committed`.
// - Late-payment refunds filed by the consumer are the rows requested_by 'system:qr'.
import { randomBytes, randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
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
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededOutletA,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const ADMIN = "/api/payments/admin";
const GUARD_CODE = "REFUND_INTENT_IN_QR_SALE";
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

const app: Express = createApp();
const key = (prefix = "split") => `${prefix}-${randomUUID()}`;

// ---- seeded tenant: raw split links (N1, N2) --------------------------------

let seededStaff: Staff;
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderIds: string[] = [];

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
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

/**
 * One payment link whose intents each paid part of the bill. `shares` are the
 * intent amounts; the link total is `linkTotalIdr` (default: their sum).
 * Every intent is paid and has one evidence row of its own amount.
 */
async function splitLink(
  shares: number[],
  linkTotalIdr = shares.reduce((a, b) => a + b, 0),
): Promise<{ linkId: string; intents: string[]; evidence: string[] }> {
  const linkId = randomUUID();
  const intents: string[] = [];
  const evidence: string[] = [];
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'qr-split-guard-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `QS-${linkId.slice(0, 8)}`,
        linkTotalIdr,
      ],
    );
    for (const amount of shares) {
      const intentId = randomUUID();
      const evidenceId = randomUUID();
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
            idempotency_key, status, instructions, expires_at, paid_at)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
                 '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', now() + interval '1 hour', now())`,
        [
          intentId,
          seededTenantId,
          seededOutletA,
          linkId,
          amount,
          `qs-${intentId}`,
        ],
      );
      await client.query(
        `INSERT INTO payment_evidence (id, tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
         VALUES ($1, $2, $3, $4, 'doit', $5, 'qris', 'verified_webhook', $6, now())`,
        [
          evidenceId,
          seededTenantId,
          seededOutletA,
          intentId,
          `evidence-${intentId}`,
          amount,
        ],
      );
      intents.push(intentId);
      evidence.push(evidenceId);
    }
  });
  linkIds.push(linkId);
  intentIds.push(...intents);
  return { linkId, intents, evidence };
}

/** A fired QR pay-first order pinned to `intentId` (raw, as payment-refund-qr-sale-guard.test.ts). */
async function firedQrOrder(
  intentId: string,
  totalIdr: number,
): Promise<string> {
  const id = randomUUID();
  orderIds.push(id);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         deposit_applied_idr, status, business_date, placed_at, payment_intent_id, fired_at,
         payment_link_id, payment_link_token_sealed)
       VALUES ($1, $2, $3, $4, 'qr', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5,
         0, 'sent', '2026-11-09', now(), $6, now(),
         (SELECT payment_link_id FROM payment_intents WHERE tenant_id = $2 AND id = $6),
         'sealed-test')`,
      [
        id,
        seededTenantId,
        seededOutletA,
        `QS-${randomUUID().slice(0, 8)}`,
        totalIdr,
        intentId,
      ],
    );
  });
  return id;
}

const requestRefundAs = (
  who: Staff,
  intentId: string,
  amountIdr: number,
  host?: string,
) => {
  const call = who.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian uji split bill QR",
    });
  return host ? call.set("Host", host) : call;
};

async function refundableOf(
  who: Staff,
  outletId: string,
  intentId: string,
  host?: string,
) {
  const call = who.client.get(
    `${ADMIN}/refunds/refundable?outletId=${outletId}`,
  );
  const response = await (host ? call.set("Host", host) : call);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.payments.find(
    (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
  ) as { refundableAmountIdr: number } | undefined;
}

async function refundRowsOf(tenantId: string, intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
  }>(
    `SELECT id, status, amount_idr::text AS amount, requested_by
       FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  return rows;
}

// ---- isolated tenant: real QR flow + consumer (N3, N4) ----------------------

let tenant: IsolatedTenant;
let isoStaff: Staff;
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
            qrPayload: "00020101021226FAKEQRSPLIT",
            issuer: null,
          };
    return {
      providerRef: `QSP-${randomBytes(6).toString("hex")}-${this.created}`,
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
    isoStaff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(
    isoStaff.client,
    { zoneId: zone.id },
    headers,
  );
  const qr = await issueQr(isoStaff.client, table.id, headers);
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
        method: "va",
        bankCode: "bmri",
        idempotencyKey: randomUUID(),
      }),
  };
}

async function freshWorld(): Promise<void> {
  ids = newIds();
  tenant = await createIsolatedTenant(`qsp-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  isoStaff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Split Uji', 0)`,
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
      [ids.taxSettings, tenant.tenantId, isoStaff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-QSP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, isoStaff.userId],
    );
  });
}

/**
 * A QR pay-first order whose bill was paid by two intents on one link: P1 pays
 * 60% and settles (its paid event is the first, so P1 is the payer), P2 pays
 * the other 40% (raw paid intent + evidence). P1's event is NOT consumed yet.
 */
async function splitPaidOrder() {
  await freshWorld();
  const guest = await seatAtNewTable();
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  const orderId = placed.body.data.order.id as string;
  const totalIdr = placed.body.data.order.totalIdr as number;
  // legend-kf104: P1 is a VA. A QR P1 holds the full amount (frozen), and this
  // fixture turns the code into a 60% part-payment, which the hold would reject.
  const opened = await as(guest).pay(orderId);
  expect(opened.status).toBe(201);
  const p1 = opened.body.data.id as string;
  const share1 = Math.round(totalIdr * 0.6);
  const share2 = totalIdr - share1;

  // P1 is the part-payment of the shared bill: lower its amount, then settle.
  await owner.query(
    "UPDATE payment_intents SET amount_idr = $3 WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, p1, share1],
  );
  await confirmPayment(contextOf(tenant.tenantId), p1, {
    source: "verified_webhook",
    method: "va",
    amountIdr: share1,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });

  // P2: the second share of the same link, paid.
  const p2 = randomUUID();
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
        idempotency_key, status, instructions, expires_at, paid_at)
     SELECT $3, tenant_id, outlet_id, payment_link_id, method, provider, $4,
            $5, 'paid', instructions, expires_at, now()
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, p1, p2, share2, `qsp-p2-${p2}`],
  );
  await owner.query(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     SELECT tenant_id, outlet_id, id, 'doit', $3, 'qris', 'verified_webhook', $4, now()
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, p2, `evidence-${p2}`, share2],
  );
  await owner.query(
    `UPDATE payment_links SET paid_idr = total_idr
      WHERE tenant_id = $1 AND id = (SELECT payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2)`,
    [tenant.tenantId, p1],
  );

  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
     ORDER BY created_at, id`,
    [tenant.tenantId, p1],
  );
  expect(rows).toHaveLength(1);
  return {
    orderId,
    totalIdr,
    share1,
    share2,
    p1,
    p2,
    event: eventEnvelopeSchema.parse(rows[0]!.event) as EventEnvelope,
  };
}

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

/** A user of the isolated tenant holding a copy of the seeded owner role (can request refunds). */
async function refundRequesterOfTenant(): Promise<Staff> {
  const role = (
    await owner.query<{ id: string }>(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       SELECT gen_random_uuid(), $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
         FROM roles WHERE tenant_id = $2 AND template_key = 'owner'
       RETURNING id`,
      [tenant.tenantId, seededTenantId],
    )
  ).rows[0]!.id;
  const client = agent(app);
  const email = await signUp(client, "Split Guard Refund Requester");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await verifySessionMfa(email);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2, now() - interval '1 hour')`,
    [tenant.tenantId, userId, role],
  );
  return { client, userId, email };
}

async function approvedRefund(intentId: string, amountIdr: number) {
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, $3, 'Refund uji split', 'approved', 'split-guard-test'
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, intentId, amountIdr],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  seededStaff = await staffWithRole(app, {
    template: "owner",
    label: "QR Split Guard Owner",
  });
  await verifySessionMfa(seededStaff.email);
  setPaymentGateway(new FakeGateway());
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setPaymentGateway(null);
  setPaymentRefundGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  // Fired orders may be immutable: skip user triggers in a dedicated
  // transaction so the rest of the cleanup keeps FK checks.
  await asOwner(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
  });
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
  });
  // Audit rows are append-only, so the isolated tenants stay; give each a
  // valid creator so the platform tenant list still parses it.
  for (const tenantId of createdTenantIds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("PAY-04 split bill: every intent that paid a fired QR sale is held", () => {
  it("PAY-04 N1 split 60000/40000, order pinned to P1: refunding P2 (40000) or P1 is refused with REFUND_INTENT_IN_QR_SALE, stores nothing and P2 lists 0 refundable", async () => {
    const split = await splitLink([60_000, 40_000]);
    const [p1, p2] = split.intents as [string, string];
    await firedQrOrder(p1, 100_000);

    const refundP2 = await requestRefundAs(seededStaff, p2, 40_000);
    expect(refundP2.status, JSON.stringify(refundP2.body)).toBe(409);
    expect(refundP2.body.error.code).toBe(GUARD_CODE);
    expect(await refundRowsOf(seededTenantId, p2)).toHaveLength(0);

    const refundP1 = await requestRefundAs(seededStaff, p1, 60_000);
    expect(refundP1.status, JSON.stringify(refundP1.body)).toBe(409);
    expect(refundP1.body.error.code).toBe(GUARD_CODE);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(0);

    // A fully held intent is listed with 0 refundable or not listed at all.
    expect(
      (await refundableOf(seededStaff, seededOutletA, p2))
        ?.refundableAmountIdr ?? 0,
    ).toBe(0);
  });

  it("PAY-04 N2 P1 alone closed the 100000 bill and P2 (40000) is a double payment: P2 is not held and can be refunded", async () => {
    const split = await splitLink([100_000, 40_000], 100_000);
    const [p1, p2] = split.intents as [string, string];
    await firedQrOrder(p1, 100_000);
    await owner.query(
      `INSERT INTO payment_unallocated_funds (tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, 40000, 'double_payment')`,
      [seededTenantId, seededOutletA, p2, split.evidence[1]],
    );

    // The double payment is closed through the unallocated-funds refund; the
    // ordinary refund request would be refused as "exceeds available paid amount".
    const fundId = (
      await owner.query<{ id: string }>(
        "SELECT id FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2",
        [seededTenantId, p2],
      )
    ).rows[0]!.id;
    const response = await seededStaff.client
      .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: key("fund"),
        resolution: "refund",
        note: "Kembalikan pembayaran ganda",
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await refundRowsOf(seededTenantId, p2)).toEqual([
      expect.objectContaining({ status: "pending", amount: "40000" }),
    ]);
    // The payer P1 is still fully held.
    const refundP1 = await requestRefundAs(seededStaff, p1, 100_000);
    expect(refundP1.status, JSON.stringify(refundP1.body)).toBe(409);
    expect(refundP1.body.error.code).toBe(GUARD_CODE);
  });
});

describe("QR order fire versus refunds committed on any contributing intent of a split bill (legend-nslvm)", () => {
  it("PAY-04 N3 two shares paid and 40% refund approved on P2 before P1's paid event: the order is voided, not fired; the P1 rest is refunded as late payment, P2 has nothing left", async () => {
    const w = await splitPaidOrder();
    await approvedRefund(w.p2, w.share2);

    const result = await deliverToQr(w.event);

    // Soft: a missing void must not hide the other checks.
    expect
      .soft(String((result as { outcome?: string }).outcome))
      .toMatch(/void|refund_committed/);
    const order = await orderRow(w.orderId);
    expect.soft(order.status).toBe("voided");
    expect.soft(order.void_reason).toBe("refund_committed");
    expect(order.fired_at).toBeNull();
    // P1 gets back its whole share (nothing committed on it), P2 is already refunded.
    const p1System = (await refundRowsOf(tenant.tenantId, w.p1)).filter(
      (r) => r.requested_by === "system:qr",
    );
    expect(p1System).toEqual([
      expect.objectContaining({
        status: "pending",
        amount: String(w.share1),
      }),
    ]);
    const p2Rows = await refundRowsOf(tenant.tenantId, w.p2);
    expect(p2Rows.filter((r) => r.requested_by === "system:qr")).toEqual([]);
    expect(p2Rows).toHaveLength(1);
  });

  it("PAY-04 N4 split without any refund: the order fires, fired_at is set, and refunding P2 is refused with REFUND_INTENT_IN_QR_SALE", async () => {
    const w = await splitPaidOrder();

    const result = await deliverToQr(w.event);

    expect(result).toMatchObject({ outcome: "fired" });
    const order = await orderRow(w.orderId);
    expect(order.status).toBe("sent");
    expect(order.fired_at).not.toBeNull();
    expect(order.payment_intent_id).toBe(w.p1);
    expect(await refundRowsOf(tenant.tenantId, w.p1)).toEqual([]);

    const requester = await refundRequesterOfTenant();
    const response = await requestRefundAs(
      requester,
      w.p2,
      w.share2,
      tenant.hostname,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe(GUARD_CODE);
    expect(await refundRowsOf(tenant.tenantId, w.p2)).toEqual([]);
  });
});
