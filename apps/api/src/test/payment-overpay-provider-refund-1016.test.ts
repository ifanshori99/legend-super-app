// legend-g6ept (brief 1016, "jangan sampai rugi"): a code is paid with MORE
// than the bill (one transaction E > bill B). The extra F = E - B is parked as
// an `overpayment` unallocated fund of the SAME provider transaction. When the
// provider then refunds that extra money on its own (payment_provider_refunds,
// brief 967), the refund comes off the parked extra FIRST: the bill is still
// covered, so the sale stays paid and nobody is refunded twice. Only the part
// of the provider refunds above F counts against the bill (brief 1009: sale
// not paid, the net is paid back). Written from the brief and the 967/980/1009
// fixtures, failing first; not from the implementation.
//
// World: a QR table order paid with one code (handleQrOrderPaymentPaid via the
// event consumer). "paid" = order `sent` and pinned to the code, "not paid" =
// the order is not `sent`.
//
// The code is a VA (bank Mandiri), not QRIS, on purpose: every QRIS code of a
// POS tender or of a QR order has a hold (D-05/D-07) that settles only the
// exact amount; any other amount is parked whole and the confirm is refused
// with AMOUNT_MISMATCH (the setup failure seen in 1009). A VA has no hold, so
// an overpaid VA settles the bill and parks the extra. POS is not covered: a
// POS tender offers QRIS only here.
//
// Assumptions (the card does not fix them):
//  - Overpayment setup: the intent is opened normally (amount B), then settled
//    with a verified webhook `confirmPayment(... amountIdr: B + EXTRA)`. The
//    gateway double is provider `doit`, which is not a strict-settlement
//    provider, so the settle is not held as AMOUNT_MISMATCH: it settles the
//    intent and parks EXTRA as an `overpayment` fund linked to the evidence row
//    (premise asserted in each case; the control case fails if it is false).
//  - A provider refund is recorded with `recordProviderRefundInTx` (the same
//    path as the webhook and poller) after the code settled and before its
//    paid event is consumed ("refund first, paid event later", as 1009).
//    "Bound to the overpaid transaction" = it names the evidence's provider
//    reference. "No binding" = it names only the intent's own provider
//    reference (the evidence is not matched, evidence_id stays null).
//  - Provider refunds R <= F (also several that sum to <= F, also R == F) are
//    taken off F: the sale is paid, our refund rows for the intent stay empty
//    and the fund row keeps its amount, unresolved.
//  - When the provider refunds more than F in total, the excess counts against
//    the bill: the sale is not paid and ours is refunded the net. What we
//    refund is pinned only to bounds: at least `bill - provider refunds` (the
//    1009 behaviour) and never more than what is still in the code
//    (`E - provider refunds`). Whether it is pending approval or completed is
//    not pinned.
//  - Money invariant in every case: our non-failed refunds for the intent plus
//    the provider's recorded refunds never exceed the money received (E).
//  - Restrictive default: a refund that cannot be proved to be of the extra
//    (not bound to the evidence, the fund has no evidence, or a live refund of
//    our own already took the fund) counts fully against the bill.
//  - Duplicate: the same provider refund id recorded twice is recorded once
//    ('duplicate'), and the same paid event delivered twice changes nothing.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-overpay-provider-refund-1016.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import type {
  PaymentChannel,
  PaymentInstructions,
} from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { resolveUnallocatedFund } from "../services/payment-admin-funds.service.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  recordProviderRefundInTx,
  type ProviderRefundOutcome,
} from "../services/payment-provider-partial-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

/** The money paid above the bill, parked as the overpayment fund F. */
const EXTRA = 10_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const BANKS: PaymentChannel[] = [{ code: "bmri", name: "Mandiri" }];
const KOPI_IDR = 25_000;

let app: Express;
const createdTenantIds: string[] = [];

/** Gateway double offering one VA bank; every code stays pending. */
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
            virtualAccountNumber: `8816${String(this.created).padStart(8, "0")}`,
          }
        : {
            method: "qris",
            qrPayload: "00020101021226FAKE1016",
            issuer: null,
          };
    return {
      providerRef: `N1016-${randomBytes(6).toString("hex")}-${this.created}`,
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

/** A verified webhook settlement (the trusted source). */
async function settleIntent(
  tenantId: string,
  intentId: string,
  amountIdr: number,
) {
  await confirmPayment(contextOf(tenantId), intentId, {
    source: "verified_webhook",
    method: "va",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

async function onlyPaidEventOf(
  tenantId: string,
  intentId: string,
): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliverEvent(tenantId: string, event: EventEnvelope) {
  const context = contextOf(tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

type Evidence = { id: string; providerRef: string; amountIdr: number };

/** The one provider transaction recorded for the intent. */
async function evidenceOf(
  tenantId: string,
  intentId: string,
): Promise<Evidence> {
  const { rows } = await owner.query<{
    id: string;
    provider_ref: string;
    amount_idr: string;
  }>(
    `SELECT id, provider_ref, amount_idr::text AS amount_idr
       FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  expect(rows, "one provider transaction recorded").toHaveLength(1);
  return {
    id: rows[0]!.id,
    providerRef: rows[0]!.provider_ref,
    amountIdr: Number(rows[0]!.amount_idr),
  };
}

type Fund = {
  id: string;
  amountIdr: number;
  reason: string;
  evidenceId: string | null;
  resolvedAt: Date | null;
};

async function fundsOf(tenantId: string, intentId: string): Promise<Fund[]> {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    reason: string;
    evidence_id: string | null;
    resolved_at: Date | null;
  }>(
    `SELECT id, amount_idr::text AS amount_idr, reason, evidence_id, resolved_at
       FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.id,
    amountIdr: Number(row.amount_idr),
    reason: row.reason,
    evidenceId: row.evidence_id,
    resolvedAt: row.resolved_at,
  }));
}

/** Our own (non-failed) refunds of the intent: what goes back to the guest. */
async function ourRefundedIdr(
  tenantId: string,
  intentId: string,
): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS total
       FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [tenantId, intentId],
  );
  return Number(rows[0]!.total);
}

async function refundRowCountOfIntent(
  tenantId: string,
  intentId: string,
): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
    [tenantId, intentId],
  );
  return Number(rows[0]!.n);
}

async function refundRowCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1",
    [tenantId],
  );
  return Number(rows[0]!.n);
}

/** What the provider returned on its own, as recorded (sum and row count). */
async function providerRefundedOf(
  tenantId: string,
  intentId: string,
): Promise<{ totalIdr: number; rows: number }> {
  const { rows } = await owner.query<{ total: string; n: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS total, count(*)::text AS n
       FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  return { totalIdr: Number(rows[0]!.total), rows: Number(rows[0]!.n) };
}

async function intentProviderRef(
  tenantId: string,
  intentId: string,
): Promise<string> {
  const { rows } = await owner.query<{ provider_ref: string }>(
    "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenantId, intentId],
  );
  return rows[0]!.provider_ref;
}

type Sale = {
  tenantId: string;
  intentId: string;
  /** The bill the code was opened for (B). */
  billIdr: number;
  /** The money received in one transaction (E = B + EXTRA). */
  receivedIdr: number;
  evidence: Evidence;
  fund: Fund;
  event: EventEnvelope;
  /** A user who may resolve parked funds (payment.reconcile) in the tenant. */
  actorId: string;
  /** The sale counts as paid: tender captured for the bill / order sent. */
  expectPaid(): Promise<void>;
  /** The sale does not count as paid and holds no tender money. */
  expectNotPaid(): Promise<void>;
};

/** A provider refund of `amountIdr`, named after the paid transaction. */
async function recordProviderRefund(
  sale: Pick<Sale, "tenantId" | "intentId">,
  input: {
    amountIdr: number;
    providerPaymentRef: string;
    providerRefundId?: string;
  },
): Promise<ProviderRefundOutcome> {
  const context = contextOf(sale.tenantId);
  return withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId:
          input.providerRefundId ?? `rf_${randomUUID().slice(0, 12)}`,
        providerPaymentRef: input.providerPaymentRef,
        amountIdr: input.amountIdr,
        source: "payment_webhook",
        expectedIntentId: sale.intentId,
        // Counting is the restrictive side: record without the in-flight
        // "retry" window, so a live refund of ours cannot hide the case.
        force: true,
      },
      new Date(),
    ),
  );
}

/** The provider refunded `amountIdr` of the overpaid transaction itself. */
async function refundOfTheExtra(
  sale: Sale,
  amountIdr: number,
  providerRefundId?: string,
) {
  const outcome = await recordProviderRefund(sale, {
    amountIdr,
    providerPaymentRef: sale.evidence.providerRef,
    providerRefundId,
  });
  return outcome;
}

/** Refundable cap and paid money of the intent, as the admin module sees them. */
async function refundableOf(
  tenantId: string,
  intentId: string,
): Promise<{ cap: number; paid: number }> {
  const context = contextOf(tenantId);
  return withTenant(db, context, async (tx) => {
    const [intent] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, context.tenant.tenantId),
          eq(paymentIntents.id, intentId),
        ),
      );
    const balance = await refundableBalance(tx, intent!, {
      lockDeposit: false,
    });
    return { cap: Number(balance.cap), paid: Number(balance.paid) };
  });
}

/** Staff tries to pay the parked fund out, as the admin funds path does. */
function resolveFundOf(
  sale: Pick<Sale, "tenantId" | "actorId"> & { fund: Fund },
  resolution: "refund" | "credit",
) {
  const key = randomUUID();
  return resolveUnallocatedFund(
    contextOf(sale.tenantId),
    sale.actorId,
    { fundId: sale.fund.id } as Parameters<typeof resolveUnallocatedFund>[2],
    {
      idempotencyKey: key,
      resolution,
      note: "Kembalikan kelebihan bayar",
    } as Parameters<typeof resolveUnallocatedFund>[3],
    key,
  );
}

/** Money invariant: nobody is paid back more than what came in. */
async function expectMoneySafe(sale: Sale) {
  const ours = await ourRefundedIdr(sale.tenantId, sale.intentId);
  const provider = await providerRefundedOf(sale.tenantId, sale.intentId);
  expect(
    ours + provider.totalIdr,
    `ours ${ours} + provider ${provider.totalIdr} must not exceed the ${sale.receivedIdr} received`,
  ).toBeLessThanOrEqual(sale.receivedIdr);
}

/** The sale is not paid; ours pays back the net, within the money still held. */
async function expectVoidedWithNetRefund(sale: Sale) {
  await sale.expectNotPaid();
  const ours = await ourRefundedIdr(sale.tenantId, sale.intentId);
  const provider = await providerRefundedOf(sale.tenantId, sale.intentId);
  expect(ours, "the net of the sale is paid back").toBeGreaterThan(0);
  expect(
    ours,
    "at least bill - provider refunds (1009)",
  ).toBeGreaterThanOrEqual(sale.billIdr - provider.totalIdr);
  expect(ours, "never more than what is still in the code").toBeLessThanOrEqual(
    sale.receivedIdr - provider.totalIdr,
  );
  await expectMoneySafe(sale);
}

/** The sale is paid, the extra stays parked, nothing refunded by us. */
async function expectPaidWithFundKept(sale: Sale) {
  await sale.expectPaid();
  expect(await ourRefundedIdr(sale.tenantId, sale.intentId)).toBe(0);
  expect(
    await refundRowCountOfIntent(sale.tenantId, sale.intentId),
    "no refund row of ours at all",
  ).toBe(0);
  const funds = await fundsOf(sale.tenantId, sale.intentId);
  expect(funds).toHaveLength(1);
  expect(funds[0]).toMatchObject({
    amountIdr: EXTRA,
    reason: "overpayment",
    resolvedAt: null,
  });
  await expectMoneySafe(sale);
}

/** Premise of every case: one transaction E, fund F = E - B on the same evidence. */
async function assertOverpaySetup(
  tenantId: string,
  intentId: string,
  billIdr: number,
) {
  const evidence = await evidenceOf(tenantId, intentId);
  expect(evidence.amountIdr, "one transaction larger than the bill").toBe(
    billIdr + EXTRA,
  );
  const funds = await fundsOf(tenantId, intentId);
  expect(funds, "the extra is parked once").toHaveLength(1);
  expect(funds[0]).toMatchObject({
    amountIdr: EXTRA,
    reason: "overpayment",
    evidenceId: evidence.id,
    resolvedAt: null,
  });
  return { evidence, fund: funds[0]! };
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
  for (const tenantId of createdTenantIds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// Menu + tax rows every world needs (one 25000 coffee, 10% PBJT).
async function seedMenu(
  tenant: IsolatedTenant,
  userId: string,
  channel: "dine_in" | "takeaway",
  code: string,
) {
  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
  };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Overpay Refund 1016', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, $4, '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId, channel],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $4, 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId, code],
    );
  });
  return ids;
}

// ---------------------------------------------------------------------------
// QR table-order world factory
// ---------------------------------------------------------------------------

async function makeQrWorld(label: string) {
  const tenant = await createIsolatedTenant(
    `q1016${label}-${randomUUID().slice(0, 5)}`,
  );
  createdTenantIds.push(tenant.tenantId);
  const staff = await staffOfIsolatedTenant(app, tenant);
  const headers = { Host: tenant.hostname };
  // A back-office role that may resolve parked funds (payment.reconcile).
  const reconcileRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Finance 1016', false, NULL, $3, false, '["tenant"]')`,
    [
      reconcileRoleId,
      tenant.tenantId,
      JSON.stringify(["payment.reconcile", "payment.transaction.view"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, staff.userId, reconcileRoleId],
  );
  const ids = await seedMenu(
    tenant,
    staff.userId,
    "dine_in",
    `PBJT-Q1016${label}`,
  );

  async function seat() {
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
      token: response.body.data.sessionToken as string,
      sessionId: response.body.data.session.id as string,
    };
  }

  function as(guest: { token: string; sessionId: string }) {
    const client = agent(app);
    const auth = (test: ReturnType<typeof client.get>) =>
      test
        .set("Host", tenant.hostname)
        .set("Authorization", `Bearer ${guest.token}`)
        .set(originHeader);
    const base = `/api/table-sessions/${guest.sessionId}`;
    return {
      add: (expectedCartVersion: number) =>
        auth(client.post(`${base}/cart/lines`)).send({
          idempotencyKey: randomUUID(),
          modifierIds: [],
          menuItemId: ids.kopi,
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

  async function orderRow(orderId: string) {
    const { rows } = await owner.query<{
      status: string;
      payment_intent_id: string | null;
    }>(
      `SELECT status, payment_intent_id
         FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows[0]!;
  }

  /**
   * A QR order paid with one VA code in one transaction of total + EXTRA;
   * the paid event is not yet consumed.
   */
  async function settledOverpaid(): Promise<Sale> {
    const guest = await seat();
    const added = await as(guest).add(0);
    expect(added.status).toBe(201);
    const placed = await as(guest).checkout(added.body.data.cart.version);
    expect(placed.status).toBe(201);
    const orderId: string = placed.body.data.order.id;
    const billIdr: number = placed.body.data.order.totalIdr;
    const paying = await as(guest).pay(orderId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(201);
    const intentId: string = paying.body.data.id;
    await settleIntent(tenant.tenantId, intentId, billIdr + EXTRA);
    const { evidence, fund } = await assertOverpaySetup(
      tenant.tenantId,
      intentId,
      billIdr,
    );
    return {
      tenantId: tenant.tenantId,
      actorId: staff.userId,
      intentId,
      billIdr,
      receivedIdr: billIdr + EXTRA,
      evidence,
      fund,
      event: await onlyPaidEventOf(tenant.tenantId, intentId),
      async expectPaid() {
        expect(
          await orderRow(orderId),
          "the bill is covered: order fired",
        ).toMatchObject({
          status: "sent",
          payment_intent_id: intentId,
        });
      },
      async expectNotPaid() {
        expect(
          (await orderRow(orderId)).status,
          "the bill is not covered: order must not be fired",
        ).not.toBe("sent");
      },
    };
  }

  return { tenant, settledOverpaid };
}

// ---------------------------------------------------------------------------
// The cases, once per world
// ---------------------------------------------------------------------------

type World = {
  tenant: IsolatedTenant;
  settledOverpaid: () => Promise<Sale>;
};

function defineCases(kind: "QR", make: (label: string) => Promise<World>) {
  describe(`legend-g6ept ${kind} overpaid code, provider refunds the extra`, () => {
    let a: World;
    let b: World;

    beforeAll(async () => {
      a = await make("a");
      b = await make("b");
    });

    it(`1016-${kind}-control: an overpaid code with no provider refund is paid, the extra stays parked, nothing is refunded`, async () => {
      const sale = await a.settledOverpaid();

      await deliverEvent(sale.tenantId, sale.event);

      await expectPaidWithFundKept(sale);
    });

    it(`1016-${kind}-extra-refunded: the provider refunds part of the extra => sale stays paid, no refund of ours, fund keeps its amount`, async () => {
      const sale = await a.settledOverpaid();
      const outcome = await refundOfTheExtra(sale, 4_000);
      expect(outcome.status).toBe("recorded");

      await deliverEvent(sale.tenantId, sale.event);

      await expectPaidWithFundKept(sale);
      expect(
        (await providerRefundedOf(sale.tenantId, sale.intentId)).totalIdr,
        "the provider refund stays on record",
      ).toBe(4_000);
    });

    it(`1016-${kind}-extra-refunded-whole: the provider refunds exactly the whole extra => sale stays paid, no refund of ours, fund keeps its amount`, async () => {
      const sale = await a.settledOverpaid();
      expect((await refundOfTheExtra(sale, EXTRA)).status).toBe("recorded");

      await deliverEvent(sale.tenantId, sale.event);

      await expectPaidWithFundKept(sale);
    });

    it(`1016-${kind}-fund-blocked: after the provider refunded the extra, the parked fund cannot be refunded or credited (409 PROVIDER_REFUNDED) and the refundable balance still holds the bill`, async () => {
      for (const providerIdr of [4_000, EXTRA]) {
        const sale = await a.settledOverpaid();
        expect((await refundOfTheExtra(sale, providerIdr)).status).toBe(
          "recorded",
        );

        // The provider already gave that money back: staff cannot pay it again.
        for (const resolution of ["refund", "credit"] as const)
          await expect(
            resolveFundOf(sale, resolution),
            `resolve by ${resolution} after a provider refund of ${providerIdr}`,
          ).rejects.toMatchObject({ status: 409, code: "PROVIDER_REFUNDED" });
        expect(
          await refundRowCountOfIntent(sale.tenantId, sale.intentId),
          "no refund filed",
        ).toBe(0);

        // The refund came off the extra: the bill is still fully paid. The
        // order is not fired yet, so nothing of it is held: cap == bill.
        // (Assumption: `cap` is paid minus money held by a fired sale.)
        expect(await refundableOf(sale.tenantId, sale.intentId)).toEqual({
          cap: sale.billIdr,
          paid: sale.billIdr,
        });

        await deliverEvent(sale.tenantId, sale.event);

        await expectPaidWithFundKept(sale);
        // Still blocked and still the bill after the order fired (the fired
        // sale now holds the whole bill: nothing left to refund).
        await expect(resolveFundOf(sale, "refund")).rejects.toMatchObject({
          status: 409,
          code: "PROVIDER_REFUNDED",
        });
        expect(await refundableOf(sale.tenantId, sale.intentId)).toEqual({
          cap: 0,
          paid: sale.billIdr,
        });
      }
    });

    it(`1016-${kind}-extra-refunded-twice: two provider refunds that together stay within the extra => sale stays paid`, async () => {
      const sale = await a.settledOverpaid();
      expect((await refundOfTheExtra(sale, 4_000)).status).toBe("recorded");
      expect((await refundOfTheExtra(sale, 5_000)).status).toBe("recorded");

      await deliverEvent(sale.tenantId, sale.event);

      await expectPaidWithFundKept(sale);
    });

    it(`1016-${kind}-above-extra: the provider refunds more than the extra => the excess counts against the bill: void, net paid back`, async () => {
      const sale = await a.settledOverpaid();
      // 3_000 above the extra.
      expect((await refundOfTheExtra(sale, EXTRA + 3_000)).status).toBe(
        "recorded",
      );

      await deliverEvent(sale.tenantId, sale.event);

      await expectVoidedWithNetRefund(sale);
    });

    it(`1016-${kind}-above-extra-twice: two provider refunds that together exceed the extra => the excess counts against the bill`, async () => {
      const sale = await a.settledOverpaid();
      expect((await refundOfTheExtra(sale, 6_000)).status).toBe("recorded");
      expect((await refundOfTheExtra(sale, 6_000)).status).toBe("recorded");

      await deliverEvent(sale.tenantId, sale.event);

      await expectVoidedWithNetRefund(sale);
    });

    it(`1016-${kind}-duplicate: the same provider refund id twice is recorded once, the sale stays paid, a repeated paid event changes nothing`, async () => {
      const sale = await a.settledOverpaid();
      const providerRefundId = `rf_${randomUUID().slice(0, 12)}`;
      expect(
        (await refundOfTheExtra(sale, 4_000, providerRefundId)).status,
      ).toBe("recorded");
      expect(
        (await refundOfTheExtra(sale, 4_000, providerRefundId)).status,
      ).toBe("duplicate");
      expect(
        await providerRefundedOf(sale.tenantId, sale.intentId),
        "recorded once, not twice",
      ).toEqual({ totalIdr: 4_000, rows: 1 });

      await deliverEvent(sale.tenantId, sale.event);
      await deliverEvent(sale.tenantId, sale.event);

      await expectPaidWithFundKept(sale);
    });

    it(`1016-${kind}-duplicate-above-extra: a duplicated provider refund above the extra is counted once: the net paid back is not short`, async () => {
      const sale = await a.settledOverpaid();
      const providerRefundId = `rf_${randomUUID().slice(0, 12)}`;
      await refundOfTheExtra(sale, EXTRA + 3_000, providerRefundId);
      expect(
        (await refundOfTheExtra(sale, EXTRA + 3_000, providerRefundId)).status,
      ).toBe("duplicate");

      await deliverEvent(sale.tenantId, sale.event);
      const afterFirst = await ourRefundedIdr(sale.tenantId, sale.intentId);
      await deliverEvent(sale.tenantId, sale.event);

      expect(
        await ourRefundedIdr(sale.tenantId, sale.intentId),
        "the repeated event refunds nothing more",
      ).toBe(afterFirst);
      await expectVoidedWithNetRefund(sale);
    });

    it(`1016-${kind}-other-tenant: a refund of the extra in one tenant leaves another tenant's overpaid sale paid and refund-free, and cannot be recorded against its payment`, async () => {
      const mine = await a.settledOverpaid();
      const theirs = await b.settledOverpaid();
      const theirRefundsBefore = await refundRowCount(b.tenant.tenantId);

      // Naming the other tenant's transaction from this tenant writes nothing.
      const crossed = await recordProviderRefund(
        { tenantId: mine.tenantId, intentId: theirs.intentId },
        { amountIdr: 4_000, providerPaymentRef: theirs.evidence.providerRef },
      );
      expect(crossed.status).toBe("unbound");
      expect((await refundOfTheExtra(mine, 4_000)).status).toBe("recorded");

      await deliverEvent(mine.tenantId, mine.event);
      await deliverEvent(theirs.tenantId, theirs.event);

      await expectPaidWithFundKept(mine);
      await expectPaidWithFundKept(theirs);
      expect(
        await providerRefundedOf(theirs.tenantId, theirs.intentId),
      ).toEqual({ totalIdr: 0, rows: 0 });
      expect(await refundRowCount(b.tenant.tenantId)).toBe(theirRefundsBefore);
    });

    it(`1016-${kind}-other-tenant-void: one tenant's refund above the extra voids only its own sale`, async () => {
      const mine = await a.settledOverpaid();
      const theirs = await b.settledOverpaid();
      await refundOfTheExtra(mine, EXTRA + 3_000);
      await refundOfTheExtra(theirs, 4_000);

      await deliverEvent(mine.tenantId, mine.event);
      await deliverEvent(theirs.tenantId, theirs.event);

      await expectVoidedWithNetRefund(mine);
      await expectPaidWithFundKept(theirs);
    });

    it(`1016-${kind}-no-binding: a provider refund recorded with no evidence of the overpaid transaction is not provable as the extra => counts fully: void, net paid back`, async () => {
      const sale = await a.settledOverpaid();
      // The intent's own reference is the overpaid transaction's reference, so
      // the refund binds to its evidence; clearing that link models a refund
      // recorded before the evidence was known.
      const outcome = await recordProviderRefund(sale, {
        amountIdr: 4_000,
        providerPaymentRef: await intentProviderRef(
          sale.tenantId,
          sale.intentId,
        ),
      });
      expect(outcome.status).toBe("recorded");
      await asOwnerTenant(sale.tenantId, (client) =>
        client.query(
          "UPDATE payment_provider_refunds SET evidence_id = NULL WHERE tenant_id = $1 AND payment_intent_id = $2",
          [sale.tenantId, sale.intentId],
        ),
      );

      await deliverEvent(sale.tenantId, sale.event);

      await expectVoidedWithNetRefund(sale);
    });

    it(`1016-${kind}-fund-without-evidence: a fund that is not linked to its transaction cannot prove the refund is of the extra => counts fully: void, net paid back`, async () => {
      const sale = await a.settledOverpaid();
      await asOwnerTenant(sale.tenantId, (client) =>
        client.query(
          "UPDATE payment_unallocated_funds SET evidence_id = NULL WHERE tenant_id = $1 AND id = $2",
          [sale.tenantId, sale.fund.id],
        ),
      );
      expect((await refundOfTheExtra(sale, 4_000)).status).toBe("recorded");

      await deliverEvent(sale.tenantId, sale.event);

      await expectVoidedWithNetRefund(sale);
    });

    it(`1016-${kind}-own-fund-refund: a live refund of ours already took the extra and the provider also refunds => restrictive: the foreign refund counts against the bill, guest never gets more than received`, async () => {
      const sale = await a.settledOverpaid();
      await owner.query(
        `INSERT INTO payment_refunds
           (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
            requested_by, completed_at, unallocated_fund_id)
         SELECT tenant_id, outlet_id, id, $3, 'Kembalikan kelebihan uji 1016', 'completed',
                'overpay-1016', now(), $4
           FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
        [sale.tenantId, sale.intentId, EXTRA, sale.fund.id],
      );
      expect((await refundOfTheExtra(sale, 4_000)).status).toBe("recorded");

      await deliverEvent(sale.tenantId, sale.event);

      await sale.expectNotPaid();
      await expectMoneySafe(sale);
      const ours = await ourRefundedIdr(sale.tenantId, sale.intentId);
      expect(
        ours,
        "the fund refund plus the net of the sale is what ours returns",
      ).toBeGreaterThan(EXTRA);
    });

    it(`1016-${kind}-money-invariant: whatever the provider refunds, ours + provider's never exceed the money received and the guest is never paid twice for the extra`, async () => {
      for (const providerIdr of [1_000, EXTRA, EXTRA + 1, EXTRA + 20_000]) {
        const sale = await a.settledOverpaid();
        expect((await refundOfTheExtra(sale, providerIdr)).status).toBe(
          "recorded",
        );

        await deliverEvent(sale.tenantId, sale.event);

        await expectMoneySafe(sale);
        if (providerIdr <= EXTRA) await sale.expectPaid();
        else await sale.expectNotPaid();
      }
    });
  });
}

defineCases("QR", makeQrWorld);
