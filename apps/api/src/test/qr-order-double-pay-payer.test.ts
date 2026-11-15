// legend-mks0q: an order paid twice (superseded code A, then fresh code B, both
// settled before any event is consumed) must be paid by the FIRST code that
// settled (A), whichever `payment.paid` event the QR consumer sees first.
//
// Bug: when B's event arrives first the order was fired pinned to B and B's
// double-payment refund was requested; once that refund paid out, accounting
// counted sale + payout against B's one receipt, parked the payout journal as
// POSTING_AMOUNTS_MISMATCH and left A's receipt unused in customer_deposit.
//
// Correct outcome, in BOTH delivery orders (A first, B first):
// - the order is `sent`, payment_intent_id = A, exactly one `order.paid`
//   (its payer, orders.payment_intent_id, is A);
// - one pending refund request for B's `double_payment` fund, none for A;
// - after the refund is approved and paid out, the real accounting auto-journal
//   consumer, fed every relevant outbox event in outbox order, parks nothing
//   and the customer_deposit balance is 0 (no residual credit).
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as qr-order-paid-event.test.ts).
//
// Assumptions:
// - The order total is whatever the cart totals (one Kopi Susu with service
//   charge and PBJT); "Rp100.000" in the bug report is only an example. A and
//   B each settle exactly that total.
// - "A first" means A settled first in time; both are settled before any event
//   is delivered, so the outbox holds A's `payment.paid` before B's.
// - The order.paid payload carries no payer intent id (tenders are method and
//   amount only), so "payer = A" is asserted on orders.payment_intent_id and,
//   through accounting, by A's receipt being consumed (deposit balance 0).
// - The system-requested double-payment refund starts `pending` and is
//   approved by a finance approver through the admin API (the approval policy
//   and the finance + supervisor roles are copied from the seeded tenant into
//   the isolated tenant). The payout is then run with a fake refund gateway.
// - Accounting events are `payment.paid`, `order.paid`, `payment.refunded`
//   and `order.refunded`, delivered to `deliverAutoJournalEvent` in outbox
//   order (created_at, id). `payment.refunded` is what completing a refund
//   emits; other event names are not accounting inputs.
// - "No residual credit": the customer_deposit account (debits minus credits)
//   is 0 over every journal of the tenant.

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
import { orderPaidPayloadSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { runRefundPayout } from "../services/payment-refund.service.ts";
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

/** Gateway double: QRIS, or a Mandiri VA for code A (see `orderPaidTwice`). */
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
            qrPayload: "00020101021226FAKEQRDOUBLE",
            issuer: null,
          };
    return {
      providerRef: `QDP-${randomBytes(6).toString("hex")}-${this.created}`,
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

// ---- QR ordering (as qr-order-paid-event.test.ts) ----------------------------

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
    payment_intent_id: string | null;
  }>(
    `SELECT status, payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

async function orderPaidEvents(orderId: string): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
        AND event->'payload'->>'orderId' = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, orderId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

type RefundRow = { id: string; status: string; amount: string };

/** Refund requests that return a `double_payment` fund of the intent. */
async function doublePaymentRefunds(intentId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT r.id, r.status, r.amount_idr::text AS amount
       FROM payment_refunds r
       JOIN payment_unallocated_funds f ON f.id = r.unallocated_fund_id
      WHERE r.tenant_id = $1 AND f.payment_intent_id = $2 AND f.reason = 'double_payment'`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

async function allRefunds(intentId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, status, amount_idr::text AS amount FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

// ---- refund approval + payout ------------------------------------------------

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
  const email = await signUp(client, "Double Pay Finance");
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

async function approveRefund(refundId: string) {
  const approver = await makeApprover();
  const response = await approver
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set("Host", tenant.hostname)
    .set(originHeader)
    .send({ idempotencyKey: `apr-${randomUUID()}` });
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
}

// ---- accounting ---------------------------------------------------------------

const ACCOUNTING_CHART: [string, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
  [
    "deposit_forfeit_income",
    "4201",
    "Pendapatan DP Hangus",
    "revenue",
    "other_income",
  ],
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
  ["bank", "1103", "Bank Operasional", "asset", "current_asset"],
  [
    "gateway_fee_expense",
    "6109",
    "Biaya Gateway (MDR)",
    "expense",
    "operating_expense",
  ],
];

/** Accounting on for the tenant, with a CoA, every role mapped and open periods. */
async function setUpAccounting(): Promise<Record<string, string>> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenant.tenantId,
      JSON.stringify({
        modules: ["qr_order", "accounting"],
        integrationProviders: [],
      }),
    ],
  );
  const accounts: Record<string, string> = {};
  for (const [role, code, name, type, group] of ACCOUNTING_CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.tenantId, tenant.legalEntityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant.tenantId, tenant.legalEntityId, role, rows[0]!.id],
    );
  }
  // Today's money time falls in one of these months (Jakarta vs UTC edges).
  const now = new Date();
  for (const shift of [-1, 0, 1]) {
    const month = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    const period = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.tenantId, tenant.legalEntityId, period],
    );
  }
  return accounts;
}

const ACCOUNTING_EVENTS = [
  "payment.paid",
  "order.paid",
  "payment.refunded",
  "order.refunded",
];

/**
 * Every accounting input of the tenant in causal order (a payment before its
 * order and before its refund). created_at is not a key: the DB clock can step
 * back, so rows inserted in sequence may swap.
 */
async function accountingInputs(): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = ANY($2::text[])
      ORDER BY array_position($2::text[], event->>'name'), created_at, id`,
    [tenant.tenantId, ACCOUNTING_EVENTS],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function parkedRows(): Promise<
  { error_code: string; event_name: string; idempotency_key: string }[]
> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT error_code, event_name, idempotency_key
         FROM auto_journal_parked WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    return rows;
  });
}

async function balanceOf(accountId: string): Promise<number> {
  const { rows } = await owner.query<{ balance: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenant.tenantId, accountId],
  );
  return Number(rows[0]!.balance ?? 0);
}

async function journalCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

// ---- fresh world per case ---------------------------------------------------

async function freshWorld(): Promise<Record<string, string>> {
  ids = newIds();
  tenant = await createIsolatedTenant(`dpp-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Double Pay Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-DPP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
  return setUpAccounting();
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

describe("QR order paid twice keeps the first code as payer (legend-mks0q)", () => {
  const cases: { id: string; first: "A" | "B" }[] = [
    { id: "QR-DOUBLE-PAY-01", first: "A" },
    { id: "QR-DOUBLE-PAY-02", first: "B" },
  ];

  for (const { id, first } of cases) {
    it(`${id} payment.paid of code ${first} is consumed first: payer is A, B's double payment is refunded, accounting parks nothing and leaves no customer deposit`, async () => {
      const accounts = await freshWorld();
      const guest = await seatAtNewTable();
      const { orderId, totalIdr } = await placeOrder(guest);

      // Code A is superseded by code B (A lapses, the guest opens B) ...
      // Code A is a VA, not a QR: a QR A would hold the bill and refuse B until
      // the provider proves A dead (legend-kf104, qris-hold-so879-a-kf104 test).
      // A is expired and the provider answered final for it (SO-885: a
      // replacement waits for that proof, not for the clock).
      const intentA = await openPayment(guest, orderId, "va");
      await owner.query(
        `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes',
               provider_final_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, intentA],
      );
      const intentB = await openPayment(guest, orderId);
      expect(intentB).not.toBe(intentA);

      // ... yet the guest pays both: A settles first, then B, before the
      // order is fired.
      await settle(intentA, totalIdr, "va");
      await settle(intentB, totalIdr);
      const eventA = await onlyPaidEvent(intentA);
      const eventB = await onlyPaidEvent(intentB);
      expect(await orderPaidEvents(orderId)).toHaveLength(0);

      for (const event of first === "A" ? [eventA, eventB] : [eventB, eventA])
        await deliverToQr(event);

      // QR side: A pays the order; B's payment is refunded as a double payment.
      // Soft: a wrong payer must not hide the refund and accounting checks below.
      expect.soft(await orderRow(orderId)).toMatchObject({
        status: "sent",
        payment_intent_id: intentA,
      });
      const paidEvents = await orderPaidEvents(orderId);
      expect(paidEvents).toHaveLength(1);
      expect(
        orderPaidPayloadSchema.parse(paidEvents[0]!.payload),
      ).toMatchObject({ orderId, totalIdr });
      const refundsForB = await doublePaymentRefunds(intentB);
      expect(refundsForB).toEqual([
        { id: expect.any(String), status: "pending", amount: String(totalIdr) },
      ]);
      expect(await allRefunds(intentA)).toHaveLength(0);

      // The double-payment refund is approved and paid out.
      const refundId = refundsForB[0]!.id;
      const refundGateway = new FakeRefundGateway();
      setPaymentRefundGateway(refundGateway);
      try {
        // With a refund gateway installed, approving also starts the payout;
        // running it again is a no-op and settles it if approval did not.
        await approveRefund(refundId);
        await runRefundPayout(contextOf(tenant.tenantId, "job"), refundId);
      } finally {
        setPaymentRefundGateway(null);
      }
      // The fake gateway is only a stub: the refund must end `completed`.
      expect(await doublePaymentRefunds(intentB)).toMatchObject([
        { id: refundId, status: "completed" },
      ]);

      // Accounting: the real consumer, every relevant event in outbox order.
      const inputs = await accountingInputs();
      expect(inputs.map((event) => event.name)).toEqual(
        expect.arrayContaining([
          "payment.paid",
          "order.paid",
          "payment.refunded",
        ]),
      );
      const accountingContext = contextOf(tenant.tenantId, "domain");
      const results: { name: string; status: string; code?: string }[] = [];
      for (const event of inputs) {
        const result = await withTenant(db, accountingContext, (tx) =>
          deliverAutoJournalEvent(accountingContext, event, tx, new Date()),
        );
        results.push({
          name: event.name,
          status: result.status,
          ...(result.status === "parked" ? { code: result.code } : {}),
        });
      }

      expect(results.filter((result) => result.status === "parked")).toEqual(
        [],
      );
      expect(await parkedRows()).toEqual([]);
      expect(await journalCount()).toBeGreaterThan(0);
      expect(await balanceOf(accounts.customer_deposit!)).toBe(0);
    });
  }
});

// ---- extra delivery orders (legend-mks0q, brief 2) ---------------------------
//
// Assumptions:
// - When B's event is consumed first, A (settled, covers the link total) is the
//   one paid code that covers it, so the order is fired pinned to A and B's
//   double-payment fund is refunded; A's event afterwards changes nothing.
// - Only the consumer result's `outcome` ("fired" / "unchanged") is asserted;
//   its other fields are not pinned.

/** Two codes (A superseded, B fresh), both settled; returns events in outbox order. */
async function orderPaidTwice() {
  await freshWorld();
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
  // A is a VA: a QR A now holds the bill and refuses B (legend-kf104 test).
  // A is expired and the provider answered final for it (SO-885: a
  // replacement waits for that proof, not for the clock).
  const intentA = await openPayment(guest, orderId, "va");
  await owner.query(
    `UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '10 minutes',
               provider_final_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, intentA],
  );
  const intentB = await openPayment(guest, orderId);
  await settle(intentA, totalIdr, "va");
  await settle(intentB, totalIdr);
  return {
    orderId,
    totalIdr,
    intentA,
    intentB,
    eventA: await onlyPaidEvent(intentA),
    eventB: await onlyPaidEvent(intentB),
  };
}

describe("QR order paid twice: delivery order and replay (legend-mks0q)", () => {
  it("QR-DOUBLE-PAY-03 B's event alone fires the order pinned to A; A's event afterwards changes nothing", async () => {
    const w = await orderPaidTwice();

    expect(await deliverToQr(w.eventB)).toMatchObject({ outcome: "fired" });
    expect(await orderRow(w.orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: w.intentA,
    });
    expect(await orderPaidEvents(w.orderId)).toHaveLength(1);
    expect(await doublePaymentRefunds(w.intentB)).toEqual([
      { id: expect.any(String), status: "pending", amount: String(w.totalIdr) },
    ]);
    expect(await allRefunds(w.intentA)).toHaveLength(0);

    expect(await deliverToQr(w.eventA)).toMatchObject({
      outcome: "unchanged",
    });
    expect(await orderRow(w.orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: w.intentA,
    });
    expect(await orderPaidEvents(w.orderId)).toHaveLength(1);
    expect(await doublePaymentRefunds(w.intentB)).toHaveLength(1);
    expect(await allRefunds(w.intentA)).toHaveLength(0);
  });

  it("QR-DOUBLE-PAY-04 replaying both events leaves one order.paid, payer A, one refund for B and none for A", async () => {
    const w = await orderPaidTwice();
    await deliverToQr(w.eventB);
    await deliverToQr(w.eventA);
    await deliverToQr(w.eventB);
    await deliverToQr(w.eventA);

    expect(await orderRow(w.orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: w.intentA,
    });
    expect(await orderPaidEvents(w.orderId)).toHaveLength(1);
    expect(await doublePaymentRefunds(w.intentB)).toHaveLength(1);
    expect(await doublePaymentRefunds(w.intentA)).toHaveLength(0);
    expect(await allRefunds(w.intentA)).toHaveLength(0);
  });

  it("QR-DOUBLE-PAY-05 one code paid twice: that code is the payer and its extra payment is refunded once", async () => {
    await freshWorld();
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest);
    const intent = await openPayment(guest, orderId);

    // Two settlements with different provider refs on the same intent.
    await settle(intent, totalIdr);
    await settle(intent, totalIdr);
    const event = await onlyPaidEvent(intent);

    expect(await deliverToQr(event)).toMatchObject({ outcome: "fired" });
    expect(await orderRow(orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: intent,
    });
    expect(await orderPaidEvents(orderId)).toHaveLength(1);
    expect(await doublePaymentRefunds(intent)).toEqual([
      { id: expect.any(String), status: "pending", amount: String(totalIdr) },
    ]);
  });
});
