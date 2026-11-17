// legend-6i91b (brief 1009, F1 "jangan sampai rugi"): the provider (DOIT)
// partly refunded a QRIS payment BEFORE the `payment.paid` outbox event of that
// payment is consumed. The sale must not be treated as fully paid: the money
// that came back is outstanding on the order, and the guest is paid back only
// what is still in the code (paid - provider refunds). The outlet never ends
// up out of pocket. Written from the brief and the 967/980 fixtures, failing
// first; not from the implementation.
//
// 1009-POS-*  a POS QRIS tender (handlePosPaymentPaid via the event consumer)
// 1009-QR-*   a QR table order paid with one code (handleQrOrderPaymentPaid)
//
// Assumptions (the card does not fix them):
//  - A provider refund is seeded straight into payment_provider_refunds (as
//    the 967/980 tests do), after the code settled and before its paid event
//    is consumed ("refund first, paid event later").
//  - "Not paid" is read from stored state: POS tender status is not
//    `captured`, no captured tender money on the order, the order status did
//    not move; QR order is not `sent` and is not pinned to the code.
//  - "Guest gets back the net": non-failed payment_refunds of OUR side for the
//    intent add up to exactly `paid - provider refund`. Whether the refund is
//    pending approval or already completed is not pinned. Total returned
//    (ours + provider's) must equal what was paid, never more (outlet never
//    pays twice) and never less (guest is not short-changed).
//  - Duplicate delivery of the same paid event must change nothing more.
//  - "Other tenant untouched": a second isolated tenant with its own fully
//    paid code (no refund) is captured / fires normally and gets no refund
//    row from the first tenant's event.
//
// Round 2 (architect findings, same card):
//  - 1009-QR-split-*: a split bill (two parts, two codes, one payment link).
//    Part amounts are net allocations, so no single code looks short; the
//    link as a whole must still hold the bill, else the order is not fired and
//    every code's net goes back (ours + provider's == paid, per code).
//  - 1009-QR-deposit: an order with a deposit applied owes total - deposit;
//    the code collects exactly that. The deposit is set straight on the order
//    before the code is opened (as order-payment-consumers.test.ts does).
//  - 1009-POS-full-provider-refund: net 0 on the only settled code. The tender
//    must be closed (neither captured nor left `authorized`).
//  - 1009-POS-refreshed-intent: the link also carries an older, expired code
//    (a refreshed QR); the paying code is the newer one.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/payment-paid-after-provider-refund-1009.test.ts" heavy pnpm test

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
import { openPosShift } from "../services/pos-shift.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { registerTestDevice } from "./device-seed.ts";
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
import { agent, originHeader, signUp } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

/** A provider refund smaller than the bill, so money is left in the code. */
const PARTIAL = 1_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const BANKS: PaymentChannel[] = [{ code: "bmri", name: "Mandiri" }];
const KOPI_IDR = 25_000;

let app: Express;
const createdTenantIds: string[] = [];
const deviceTenants = new Map<string, { tenantId: string; outletId: string }>();

/** Gateway double offering QRIS; every code stays pending. */
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
            virtualAccountNumber: `8809${String(this.created).padStart(8, "0")}`,
          }
        : {
            method: "qris",
            qrPayload: "00020101021226FAKE1009",
            issuer: null,
          };
    return {
      providerRef: `N1009-${randomBytes(6).toString("hex")}-${this.created}`,
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

async function refundRowCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1",
    [tenantId],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    const entry = deviceTenants.get(deviceId);
    return entry && entry.tenantId === tenantId ? entry.outletId : null;
  });
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
       VALUES ($1, $2, $3, 'Paid After Refund 1009', 0)`,
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
// POS world factory
// ---------------------------------------------------------------------------

async function makePosWorld(label: string) {
  const tenant = await createIsolatedTenant(
    `p1009${label}-${randomUUID().slice(0, 5)}`,
  );
  createdTenantIds.push(tenant.tenantId);
  const headers = { Host: tenant.hostname };
  const deviceId = randomUUID();
  deviceTenants.set(deviceId, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
  });
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir 1009', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, `Paid After Refund 1009 ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId: string = session.body.user.id;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  await openPosShift(
    contextOf(tenant.tenantId),
    { userId: userIdSchema.parse(userId), deviceId },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const ids = await seedMenu(tenant, userId, "takeaway", `PBJT-P1009${label}`);

  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt: Math.floor(Date.now() / 1000),
          tenantId: tenant.tenantId,
          brandId: null,
          deviceId,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });

  async function tenderOf(orderId: string, tenderId: string) {
    const { rows } = await owner.query<{
      status: string;
      payment_intent_id: string | null;
      amount_idr: string;
    }>(
      `SELECT status, payment_intent_id, amount_idr::text AS amount_idr
         FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2::uuid AND id = $3`,
      [tenant.tenantId, ulidToUuid(orderId), tenderId],
    );
    return rows[0]!;
  }

  /** Sum of tender money that counts as taken on the order. */
  async function capturedIdr(orderId: string): Promise<number> {
    const { rows } = await owner.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_idr), 0)::text AS total
         FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2::uuid AND status = 'captured'`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return Number(rows[0]!.total);
  }

  async function orderStatus(orderId: string): Promise<string> {
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows[0]!.status;
  }

  /** A POS order with one open QRIS tender (hold) for the whole bill, settled. */
  async function settledQrisTender() {
    const created = await send("", {
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId: string = created.body.data.id;
    if (created.body.data.status === "draft") {
      const submitted = await send(`/${orderId}/submit`, {
        expectedStatus: "draft",
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    }
    const read = await client
      .get(`${base}/${orderId}`)
      .set(headers)
      .set(originHeader);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const opened = await send(`/${orderId}/tenders`, {
      method: "qris",
      expectedStatus: read.body.data.status,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const tenderId: string = opened.body.data.tender.id;
    const tender = await tenderOf(orderId, tenderId);
    expect(tender.status).toBe("authorized");
    const intentId = tender.payment_intent_id;
    if (intentId === null) throw new Error("QRIS tender has no intent");
    const amountIdr = Number(tender.amount_idr);
    await settleIntent(tenant.tenantId, intentId, amountIdr);
    return {
      orderId,
      tenderId,
      intentId,
      amountIdr,
      event: await onlyPaidEventOf(tenant.tenantId, intentId),
    };
  }

  /** An older, expired code on the same link: the paying code is the refreshed one. */
  async function addExpiredSiblingIntent(intentId: string, amountIdr: number) {
    await asOwnerTenant(tenant.tenantId, async (client) => {
      const { rows } = await client.query<{ payment_link_id: string }>(
        "SELECT payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, intentId],
      );
      const siblingId = randomUUID();
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
            idempotency_key, status, instructions, expires_at, provider_ref,
            provider_final_at, created_at)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'expired',
                 '{"method":"qris","qrPayload":"00020101021226OLD1009","issuer":null}',
                 now() - interval '30 minutes', $7, now() - interval '30 minutes',
                 now() - interval '1 hour')`,
        [
          siblingId,
          tenant.tenantId,
          tenant.outletId,
          rows[0]!.payment_link_id,
          amountIdr,
          `old-${siblingId}`,
          `old-ref-${siblingId.slice(0, 8)}`,
        ],
      );
    });
  }

  return {
    tenant,
    tenderOf,
    capturedIdr,
    orderStatus,
    settledQrisTender,
    addExpiredSiblingIntent,
  };
}

describe("legend-6i91b POS QRIS paid after a provider partial refund", () => {
  let a: Awaited<ReturnType<typeof makePosWorld>>;
  let b: Awaited<ReturnType<typeof makePosWorld>>;

  beforeAll(async () => {
    a = await makePosWorld("a");
    b = await makePosWorld("b");
  });

  it("1009-POS-normal: a QRIS tender paid in full, no provider refund, is captured for the full amount", async () => {
    const w = await a.settledQrisTender();

    await deliverEvent(a.tenant.tenantId, w.event);

    expect((await a.tenderOf(w.orderId, w.tenderId)).status).toBe("captured");
    expect(await a.capturedIdr(w.orderId)).toBe(w.amountIdr);
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(0);
  });

  it("1009-POS-refund-first: provider refund before the paid event => tender not captured, order keeps its full balance, guest gets back exactly the net", async () => {
    const w = await a.settledQrisTender();
    const statusBefore = await a.orderStatus(w.orderId);
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.event);

    const tender = await a.tenderOf(w.orderId, w.tenderId);
    expect(tender.status, "sale must not count as fully paid").not.toBe(
      "captured",
    );
    expect(await a.capturedIdr(w.orderId), "no tender money on the sale").toBe(
      0,
    );
    expect(await a.orderStatus(w.orderId)).toBe(statusBefore);
    // Guest is paid back what is left in the code: paid - provider refund.
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(
      w.amountIdr - PARTIAL,
    );
  });

  it("1009-POS-outlet-not-out-of-pocket: money returned (ours + provider's) equals money paid, while nothing is captured", async () => {
    const w = await a.settledQrisTender();
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.event);

    const ours = await ourRefundedIdr(a.tenant.tenantId, w.intentId);
    expect(ours + PARTIAL, "never returned more than paid").toBeLessThanOrEqual(
      w.amountIdr,
    );
    expect(ours + PARTIAL, "guest not short-changed").toBe(w.amountIdr);
    expect(await a.capturedIdr(w.orderId)).toBe(0);
  });

  it("1009-POS-duplicate-event: delivering the same paid event twice changes nothing and does not refund twice", async () => {
    const w = await a.settledQrisTender();
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.event);
    const afterFirst = await ourRefundedIdr(a.tenant.tenantId, w.intentId);
    await deliverEvent(a.tenant.tenantId, w.event);

    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(
      afterFirst,
    );
    expect(afterFirst).toBe(w.amountIdr - PARTIAL);
    expect((await a.tenderOf(w.orderId, w.tenderId)).status).not.toBe(
      "captured",
    );
    expect(await a.capturedIdr(w.orderId)).toBe(0);
  });

  it("1009-POS-full-provider-refund: the provider returned the whole payment before the paid event => tender is closed, not captured and not stuck, nothing more to refund", async () => {
    const w = await a.settledQrisTender();
    await providerRefunded(a.tenant, w.intentId, w.amountIdr);

    await deliverEvent(a.tenant.tenantId, w.event);

    const status = (await a.tenderOf(w.orderId, w.tenderId)).status;
    expect(status).not.toBe("captured");
    expect(status, "tender must not stay authorized").not.toBe("authorized");
    expect(await a.capturedIdr(w.orderId)).toBe(0);
    // Nothing left in the code: no refund of ours (never more than paid).
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(0);
  });

  it("1009-POS-refreshed-intent: the link also carries an older expired code; a partial provider refund of the paying code still blocks the capture and pays back the net", async () => {
    const w = await a.settledQrisTender();
    await a.addExpiredSiblingIntent(w.intentId, w.amountIdr);
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.event);

    expect((await a.tenderOf(w.orderId, w.tenderId)).status).not.toBe(
      "captured",
    );
    expect(await a.capturedIdr(w.orderId)).toBe(0);
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(
      w.amountIdr - PARTIAL,
    );
  });

  it("1009-POS-other-tenant: a provider refund in one tenant leaves another tenant's paid tender captured and refund-free", async () => {
    const mine = await a.settledQrisTender();
    const theirs = await b.settledQrisTender();
    const theirRefundsBefore = await refundRowCount(b.tenant.tenantId);
    await providerRefunded(a.tenant, mine.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, mine.event);
    await deliverEvent(b.tenant.tenantId, theirs.event);

    expect((await a.tenderOf(mine.orderId, mine.tenderId)).status).not.toBe(
      "captured",
    );
    expect((await b.tenderOf(theirs.orderId, theirs.tenderId)).status).toBe(
      "captured",
    );
    expect(await b.capturedIdr(theirs.orderId)).toBe(theirs.amountIdr);
    expect(await refundRowCount(b.tenant.tenantId)).toBe(theirRefundsBefore);
  });
});

// ---------------------------------------------------------------------------
// QR table-order world factory
// ---------------------------------------------------------------------------

async function makeQrWorld(label: string) {
  const tenant = await createIsolatedTenant(
    `q1009${label}-${randomUUID().slice(0, 5)}`,
  );
  createdTenantIds.push(tenant.tenantId);
  const staff = await staffOfIsolatedTenant(app, tenant);
  const headers = { Host: tenant.hostname };
  const ids = await seedMenu(
    tenant,
    staff.userId,
    "dine_in",
    `PBJT-Q1009${label}`,
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
          method: "qris",
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

  async function placeOrder() {
    const guest = await seat();
    const added = await as(guest).add(0);
    expect(added.status).toBe(201);
    const placed = await as(guest).checkout(added.body.data.cart.version);
    expect(placed.status).toBe(201);
    return {
      guest,
      orderId: placed.body.data.order.id as string,
      totalIdr: placed.body.data.order.totalIdr as number,
    };
  }

  /** A QR order whose single QRIS code is settled; the paid event is pending. */
  async function settledOrder() {
    const { guest, orderId, totalIdr } = await placeOrder();
    const paying = await as(guest).pay(orderId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(201);
    const intentId: string = paying.body.data.id;
    await settleIntent(tenant.tenantId, intentId, totalIdr);
    return {
      orderId,
      totalIdr,
      intentId,
      event: await onlyPaidEventOf(tenant.tenantId, intentId),
    };
  }

  /**
   * An order with a deposit already applied: the code collects only
   * total - deposit, and that is what is settled.
   */
  async function settledOrderWithDeposit(depositIdr: number) {
    const { guest, orderId, totalIdr } = await placeOrder();
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr = $3 WHERE tenant_id = $1 AND id = $2::uuid",
        [tenant.tenantId, ulidToUuid(orderId), depositIdr],
      ),
    );
    const paying = await as(guest).pay(orderId);
    expect(paying.status, JSON.stringify(paying.body)).toBe(201);
    const intentId: string = paying.body.data.id;
    const { rows } = await owner.query<{ amount_idr: string }>(
      "SELECT amount_idr::text AS amount_idr FROM payment_intents WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, intentId],
    );
    const paidIdr = Number(rows[0]!.amount_idr);
    expect(paidIdr, "the code collects total - deposit").toBe(
      totalIdr - depositIdr,
    );
    await settleIntent(tenant.tenantId, intentId, paidIdr);
    return {
      orderId,
      totalIdr,
      paidIdr,
      intentId,
      event: await onlyPaidEventOf(tenant.tenantId, intentId),
    };
  }

  /**
   * An order split into two parts, each paid with its own code (part 0 QRIS,
   * part 1 VA, as bill-split-pay does); both paid events are still pending.
   */
  async function settledSplitOrder() {
    const { guest, orderId, totalIdr } = await placeOrder();
    const split = await as(guest).split(2);
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts: { id: string; amountIdr: number }[] = split.body.data.splits;
    expect(parts).toHaveLength(2);
    const codes: { intentId: string; paidIdr: number; event: EventEnvelope }[] =
      [];
    for (const [index, part] of parts.entries()) {
      const method = index === 0 ? "qris" : "va";
      const opened = await as(guest).paySplit(part.id, method);
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const intentId: string = opened.body.data.id;
      await settleIntent(tenant.tenantId, intentId, part.amountIdr, method);
      codes.push({
        intentId,
        paidIdr: part.amountIdr,
        event: await onlyPaidEventOf(tenant.tenantId, intentId),
      });
    }
    return { orderId, totalIdr, x: codes[0]!, y: codes[1]! };
  }

  return {
    tenant,
    orderRow,
    settledOrder,
    settledOrderWithDeposit,
    settledSplitOrder,
  };
}

describe("legend-6i91b QR order paid after a provider partial refund", () => {
  let a: Awaited<ReturnType<typeof makeQrWorld>>;
  let b: Awaited<ReturnType<typeof makeQrWorld>>;

  beforeAll(async () => {
    a = await makeQrWorld("a");
    b = await makeQrWorld("b");
  });

  it("1009-QR-normal: an order paid in full by its code, no provider refund, is fired", async () => {
    const w = await a.settledOrder();

    expect(await deliverEvent(a.tenant.tenantId, w.event)).toMatchObject({
      outcome: "fired",
    });

    expect(await a.orderRow(w.orderId)).toMatchObject({
      status: "sent",
      payment_intent_id: w.intentId,
    });
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(0);
  });

  it("1009-QR-refund-first: provider refund before the paid event => order not fired, guest gets back exactly the net", async () => {
    const w = await a.settledOrder();
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    const result = await deliverEvent(a.tenant.tenantId, w.event);

    expect(result).not.toMatchObject({ outcome: "fired" });
    const order = await a.orderRow(w.orderId);
    expect(order.status, "bill is not covered").not.toBe("sent");
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(
      w.totalIdr - PARTIAL,
    );
  });

  it("1009-QR-outlet-not-out-of-pocket: money returned (ours + provider's) equals money paid, the order is not served", async () => {
    const w = await a.settledOrder();
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.event);

    const ours = await ourRefundedIdr(a.tenant.tenantId, w.intentId);
    expect(ours + PARTIAL).toBeLessThanOrEqual(w.totalIdr);
    expect(ours + PARTIAL).toBe(w.totalIdr);
    expect((await a.orderRow(w.orderId)).status).not.toBe("sent");
  });

  it("1009-QR-duplicate-event: the same paid event delivered twice does not refund twice or fire the order", async () => {
    const w = await a.settledOrder();
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.event);
    const afterFirst = await ourRefundedIdr(a.tenant.tenantId, w.intentId);
    await deliverEvent(a.tenant.tenantId, w.event);

    expect(afterFirst).toBe(w.totalIdr - PARTIAL);
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(
      afterFirst,
    );
    expect((await a.orderRow(w.orderId)).status).not.toBe("sent");
  });

  it("1009-QR-deposit-normal: an order with a deposit applied, its code paid in full (total - deposit), is fired", async () => {
    const w = await a.settledOrderWithDeposit(5_000);

    expect(await deliverEvent(a.tenant.tenantId, w.event)).toMatchObject({
      outcome: "fired",
    });

    expect((await a.orderRow(w.orderId)).status).toBe("sent");
    expect(await ourRefundedIdr(a.tenant.tenantId, w.intentId)).toBe(0);
  });

  it("1009-QR-deposit: deposit applied + provider partial refund of the code => order not fired, guest gets back exactly code - provider refund", async () => {
    const w = await a.settledOrderWithDeposit(5_000);
    await providerRefunded(a.tenant, w.intentId, PARTIAL);

    const result = await deliverEvent(a.tenant.tenantId, w.event);

    expect(result).not.toMatchObject({ outcome: "fired" });
    expect((await a.orderRow(w.orderId)).status).not.toBe("sent");
    const ours = await ourRefundedIdr(a.tenant.tenantId, w.intentId);
    expect(ours).toBe(w.paidIdr - PARTIAL);
    expect(ours + PARTIAL, "never more than the code collected").toBe(
      w.paidIdr,
    );
  });

  it("1009-QR-split-normal: a split bill whose two codes are paid in full fires the order", async () => {
    const w = await a.settledSplitOrder();

    await deliverEvent(a.tenant.tenantId, w.x.event);
    await deliverEvent(a.tenant.tenantId, w.y.event);

    expect((await a.orderRow(w.orderId)).status).toBe("sent");
    expect(await ourRefundedIdr(a.tenant.tenantId, w.x.intentId)).toBe(0);
    expect(await ourRefundedIdr(a.tenant.tenantId, w.y.intentId)).toBe(0);
  });

  it("1009-QR-split-partial-refund: provider refunded part of one code of a split bill => order not fired, each code's net goes back", async () => {
    const w = await a.settledSplitOrder();
    await providerRefunded(a.tenant, w.x.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, w.x.event);
    await deliverEvent(a.tenant.tenantId, w.y.event);

    expect(
      (await a.orderRow(w.orderId)).status,
      "bill is not covered: 80 of 100 is still in the codes",
    ).not.toBe("sent");
    const oursX = await ourRefundedIdr(a.tenant.tenantId, w.x.intentId);
    const oursY = await ourRefundedIdr(a.tenant.tenantId, w.y.intentId);
    expect(oursX + PARTIAL, "code X: returned == paid").toBe(w.x.paidIdr);
    expect(oursY, "code Y: returned == paid").toBe(w.y.paidIdr);
  });

  it("1009-QR-split-all-refunded: the provider returned both codes of a split bill => order not fired, nothing of ours to refund", async () => {
    const w = await a.settledSplitOrder();
    await providerRefunded(a.tenant, w.x.intentId, w.x.paidIdr);
    await providerRefunded(a.tenant, w.y.intentId, w.y.paidIdr);

    await deliverEvent(a.tenant.tenantId, w.x.event);
    await deliverEvent(a.tenant.tenantId, w.y.event);

    expect((await a.orderRow(w.orderId)).status).not.toBe("sent");
    expect(await ourRefundedIdr(a.tenant.tenantId, w.x.intentId)).toBe(0);
    expect(await ourRefundedIdr(a.tenant.tenantId, w.y.intentId)).toBe(0);
  });

  it("1009-QR-other-tenant: a provider refund in one tenant leaves another tenant's paid order fired and refund-free", async () => {
    const mine = await a.settledOrder();
    const theirs = await b.settledOrder();
    const theirRefundsBefore = await refundRowCount(b.tenant.tenantId);
    await providerRefunded(a.tenant, mine.intentId, PARTIAL);

    await deliverEvent(a.tenant.tenantId, mine.event);
    expect(await deliverEvent(b.tenant.tenantId, theirs.event)).toMatchObject({
      outcome: "fired",
    });

    expect((await a.orderRow(mine.orderId)).status).not.toBe("sent");
    expect((await b.orderRow(theirs.orderId)).status).toBe("sent");
    expect(await refundRowCount(b.tenant.tenantId)).toBe(theirRefundsBefore);
  });
});
