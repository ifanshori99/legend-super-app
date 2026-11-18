// legend-ra4lu (brief 1025, card A, "jangan sampai rugi"): an overpaid code
// parks the extra as an `overpayment` fund (payment_unallocated_funds). When
// the PROVIDER refunds money on its own (payment_provider_refunds, 967) the
// guest already got it back, so staff must not pay the fund out a second time
// (409 PROVIDER_REFUNDED, 1016). The gap: a provider refund row that carries
// NO evidence link (evidence_id NULL) and names a provider payment reference
// that matches no transaction of the intent did not block the open fund, so
// the guest could be refunded twice (provider + us). Restrictive default of
// the brief: such an unattributable provider refund on an intent that has an
// open fund (resolution NULL) blocks the fund refund until finance decides.
// Written from the brief and the 1016 fixtures, failing first; not from the
// implementation.
//
// World: a QR table order paid with one VA code (bank Mandiri) in ONE
// transaction E = bill + EXTRA, exactly like payment-overpay-provider-refund-1016
// (a VA has no hold, so the settle takes the bill and parks the extra).
//
// Assumptions (the card does not fix them):
//  - The "unattributable" provider refund is inserted directly into
//    payment_provider_refunds (evidence_id NULL, provider_payment_ref = a
//    reference that matches neither the intent nor its evidence), because the
//    recording service may refuse to record a ref it cannot bind. This is
//    the row shape the card names.
//  - "Blocked" = resolveUnallocatedFund throws 409 PROVIDER_REFUNDED (the
//    code already used by 1016 for the matched case), for both the `refund`
//    and the `credit` resolution, and no refund row of ours is filed and the
//    fund stays unresolved.
//  - "Still refundable" (control) = resolving the untouched fund by `refund`
//    does not throw and files exactly one refund row of ours for EXTRA
//    (pending approval or completed is not pinned).
//  - "Resolved fund unaffected" = a fund resolved before the stray row
//    arrived keeps its resolution and resolver, and no refund row of ours is
//    created by a later attempt.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1025-a-fund-blocked-null-evidence.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
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
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { resolveUnallocatedFund } from "../services/payment-admin-funds.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { recordProviderRefundInTx } from "../services/payment-provider-partial-refund.ts";
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

/** The money paid above the bill, parked as the overpayment fund. */
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
            virtualAccountNumber: `8825${String(this.created).padStart(8, "0")}`,
          }
        : {
            method: "qris",
            qrPayload: "00020101021226FAKE1025A",
            issuer: null,
          };
    return {
      providerRef: `N1025A-${randomBytes(6).toString("hex")}-${this.created}`,
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
// Helpers
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
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
};

async function fundsOf(tenantId: string, intentId: string): Promise<Fund[]> {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: string;
    reason: string;
    evidence_id: string | null;
    resolution: string | null;
    resolved_by: string | null;
    resolved_at: Date | null;
  }>(
    `SELECT id, amount_idr::text AS amount_idr, reason, evidence_id, resolution, resolved_by, resolved_at
       FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.id,
    amountIdr: Number(row.amount_idr),
    reason: row.reason,
    evidenceId: row.evidence_id,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
  }));
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

type Sale = {
  tenantId: string;
  intentId: string;
  billIdr: number;
  evidence: Evidence;
  fund: Fund;
  event: EventEnvelope;
  /** A user who may resolve parked funds (payment.reconcile) in the tenant. */
  actorId: string;
};

/**
 * A provider refund the system cannot attribute: no evidence link and a
 * payment reference that matches no transaction of the intent.
 */
async function insertUnattributableProviderRefund(
  sale: Pick<Sale, "tenantId" | "intentId">,
  amountIdr: number,
) {
  const { rowCount } = await owner.query(
    `INSERT INTO payment_provider_refunds
       (tenant_id, outlet_id, payment_intent_id, evidence_id, provider,
        provider_refund_id, provider_payment_ref, amount_idr, source)
     SELECT tenant_id, outlet_id, id, NULL, 'doit', $3, $4, $5, 'payment_webhook'
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [
      sale.tenantId,
      sale.intentId,
      `rf_${randomUUID().slice(0, 12)}`,
      `UNMATCHED-${randomBytes(6).toString("hex")}`,
      amountIdr,
    ],
  );
  expect(rowCount, "the stray provider refund row is written").toBe(1);
  const { rows } = await owner.query<{ evidence_id: string | null }>(
    `SELECT evidence_id FROM payment_provider_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [sale.tenantId, sale.intentId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.evidence_id, "premise: no evidence link").toBeNull();
}

/** A provider refund that names the overpaid transaction itself (matched). */
async function recordMatchedProviderRefund(sale: Sale, amountIdr: number) {
  const context = contextOf(sale.tenantId);
  const outcome = await withTenant(db, context, (tx) =>
    recordProviderRefundInTx(
      tx,
      context,
      {
        provider: "doit",
        providerRefundId: `rf_${randomUUID().slice(0, 12)}`,
        refundIdKind: "provider",
        providerPaymentRef: sale.evidence.providerRef,
        amountIdr,
        source: "payment_webhook",
        expectedIntentId: sale.intentId,
        force: true,
      },
      new Date(),
    ),
  );
  expect(outcome.status).toBe("recorded");
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

/** The guest was not paid back by us, and the fund is still open. */
async function expectFundUntouched(sale: Sale) {
  expect(
    await refundRowCountOfIntent(sale.tenantId, sale.intentId),
    "no refund of ours filed",
  ).toBe(0);
  const funds = await fundsOf(sale.tenantId, sale.intentId);
  expect(funds).toHaveLength(1);
  expect(funds[0]).toMatchObject({
    amountIdr: EXTRA,
    reason: "overpayment",
    resolution: null,
    resolvedAt: null,
  });
}

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
    resolution: null,
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
       VALUES ($1, $2, $3, 'Refund 1025 A', 0)`,
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
    `q1025a${label}-${randomUUID().slice(0, 5)}`,
  );
  createdTenantIds.push(tenant.tenantId);
  const staff = await staffOfIsolatedTenant(app, tenant);
  const headers = { Host: tenant.hostname };
  // A back-office role that may resolve parked funds (payment.reconcile).
  const reconcileRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Finance 1025A', false, NULL, $3, false, '["tenant"]')`,
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
    `PBJT-Q1025A${label}`,
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

  /** A QR order paid with one VA code in one transaction of total + EXTRA. */
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
      evidence,
      fund,
      event: await onlyPaidEventOf(tenant.tenantId, intentId),
    };
  }

  return { tenant, settledOverpaid };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

describe("legend-ra4lu refund fund blocked by a provider refund without evidence", () => {
  let a: Awaited<ReturnType<typeof makeQrWorld>>;
  let b: Awaited<ReturnType<typeof makeQrWorld>>;

  beforeAll(async () => {
    a = await makeQrWorld("a");
    b = await makeQrWorld("b");
  });

  it("1025-A-control-no-refund: an overpaid fund with no provider refund at all is still refundable (one refund of the extra is filed)", async () => {
    const sale = await a.settledOverpaid();
    await deliverEvent(sale.tenantId, sale.event);

    await expect(resolveFundOf(sale, "refund")).resolves.toBeDefined();

    expect(await refundRowCountOfIntent(sale.tenantId, sale.intentId)).toBe(1);
    expect(await ourRefundedIdr(sale.tenantId, sale.intentId)).toBe(EXTRA);
  });

  it("1025-A-control-matched: a provider refund bound to the overpaid transaction still blocks the fund (409 PROVIDER_REFUNDED)", async () => {
    const sale = await a.settledOverpaid();
    await recordMatchedProviderRefund(sale, 4_000);

    await expect(resolveFundOf(sale, "refund")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });

    await expectFundUntouched(sale);
  });

  it("1025-A-refund-blocked: a provider refund with no evidence and an unmatched reference blocks the fund refund (409), the guest is not refunded twice", async () => {
    const sale = await a.settledOverpaid();
    await insertUnattributableProviderRefund(sale, 4_000);

    await expect(resolveFundOf(sale, "refund")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });

    await expectFundUntouched(sale);
  });

  it("1025-A-credit-blocked: the same stray provider refund also blocks resolving the fund by credit", async () => {
    const sale = await a.settledOverpaid();
    await insertUnattributableProviderRefund(sale, 4_000);

    await expect(resolveFundOf(sale, "credit")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });

    await expectFundUntouched(sale);
  });

  it("1025-A-refund-blocked-after-paid: the fund stays blocked after the paid event is consumed, a repeated attempt files no fund refund, and the guest never gets more than paid", async () => {
    const sale = await a.settledOverpaid();
    await insertUnattributableProviderRefund(sale, EXTRA);
    await deliverEvent(sale.tenantId, sale.event);
    // The unattributable provider refund counts against the bill, so the system
    // may legitimately file a late-payment refund of the bill (no fund link):
    // zero refunds overall is NOT asserted here, only the fund and the totals.

    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(resolveFundOf(sale, "refund")).rejects.toMatchObject({
        status: 409,
        code: "PROVIDER_REFUNDED",
      });

    // (a) no refund of ours is linked to the fund
    const { rows: fundRefunds } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND unallocated_fund_id = $2",
      [sale.tenantId, sale.fund.id],
    );
    expect(Number(fundRefunds[0]!.n), "no refund row linked to the fund").toBe(
      0,
    );
    // (b) the fund stays open
    const funds = await fundsOf(sale.tenantId, sale.intentId);
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({ resolution: null, resolvedAt: null });
    // (c) ours + the provider's never exceed what was paid
    const { rows: provider } = await owner.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_idr), 0)::text AS total
         FROM payment_provider_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [sale.tenantId, sale.intentId],
    );
    expect(
      (await ourRefundedIdr(sale.tenantId, sale.intentId)) +
        Number(provider[0]!.total),
      "guest never gets more than paid",
    ).toBeLessThanOrEqual(sale.billIdr + EXTRA);
  });

  it("1025-A-other-intent: a stray provider refund on one intent does not block the open fund of another sale of the same tenant", async () => {
    const stray = await a.settledOverpaid();
    const other = await a.settledOverpaid();
    await insertUnattributableProviderRefund(stray, 4_000);

    await expect(resolveFundOf(stray, "refund")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });
    await expect(resolveFundOf(other, "refund")).resolves.toBeDefined();

    expect(await ourRefundedIdr(other.tenantId, other.intentId)).toBe(EXTRA);
    await expectFundUntouched(stray);
  });

  it("1025-A-other-tenant: a stray provider refund in tenant A leaves the open fund of tenant B refundable", async () => {
    const mine = await a.settledOverpaid();
    const theirs = await b.settledOverpaid();
    await insertUnattributableProviderRefund(mine, 4_000);

    await expect(resolveFundOf(mine, "refund")).rejects.toMatchObject({
      status: 409,
      code: "PROVIDER_REFUNDED",
    });
    await expect(resolveFundOf(theirs, "refund")).resolves.toBeDefined();

    expect(await ourRefundedIdr(theirs.tenantId, theirs.intentId)).toBe(EXTRA);
    await expectFundUntouched(mine);
  });

  it("1025-A-resolved-unaffected: a fund that was already resolved keeps its resolution when a stray provider refund arrives, and nothing new is filed", async () => {
    const sale = await a.settledOverpaid();
    await asOwnerTenant(sale.tenantId, (client) =>
      client.query(
        `UPDATE payment_unallocated_funds
            SET resolution = 'credit', resolved_by = $3, resolved_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [sale.tenantId, sale.fund.id, sale.actorId],
      ),
    );
    const before = (await fundsOf(sale.tenantId, sale.intentId))[0]!;
    expect(before.resolution, "premise: resolved").toBe("credit");

    await insertUnattributableProviderRefund(sale, 4_000);
    await resolveFundOf(sale, "refund").catch(() => undefined);

    const after = (await fundsOf(sale.tenantId, sale.intentId))[0]!;
    expect(after).toMatchObject({
      resolution: "credit",
      resolvedBy: sale.actorId,
    });
    expect(after.resolvedAt).toEqual(before.resolvedAt);
    expect(
      await refundRowCountOfIntent(sale.tenantId, sale.intentId),
      "a resolved fund is never paid out again",
    ).toBe(0);
  });
});
