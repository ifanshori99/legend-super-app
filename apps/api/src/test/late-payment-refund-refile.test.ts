// Staff re-file of a late-paid intent's refund (POS and QR).
//
// The late-payment refund of an intent is filed once by the system
// (`system:pos` / `system:qr`). When an approver rejects it (or its approval
// expires) the refund goes `failed` and the cap is free again, but nothing
// re-files it. A QR intent belongs to a sales document, so the staff refund
// path refused it with REFUND_SOURCE_DOCUMENT and the guest's money stayed
// stuck. A late-paid intent (a late-payment idempotency row exists) may now be
// re-filed by staff; the cap and requester != approver still hold.
//
// QR: real Express app, WS-05 and an isolated tenant (as
// qr-order-late-payment.test.ts). POS: raw bill rows in the seeded tenant (as
// pos-late-payment-pending-refund.test.ts).

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
import {
  handlePosPaymentPaid,
  type DomainEvent,
} from "../services/pos-order-payment.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { LATE_PAYMENT_GRACE_MS } from "../services/qr-order-consumers.ts";
import { getGuestPayment } from "../services/qr-order-payment.ts";
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
  seededOutletA,
  seededTenantId,
  staffWithRole,
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

/**
 * Gateway double offering a VA bank; `status` is what the status poll answers.
 * The late-paid QR order uses a VA: a QRIS code of a guest bill has a QR hold
 * (SO-885), which freezes the bill until the provider proves the code dead and
 * then parks any later payment as unallocated funds instead of settling it.
 * A VA has no hold, so the late settlement path under test is reachable.
 */
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
            channelCode: "bmri",
            channelName: "Mandiri",
            virtualAccountNumber: `8808${String(this.created).padStart(8, "0")}`,
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
  async channels(_context: ScopedTenantContext, method: OnlinePaymentMethod) {
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
    pay: (orderId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "va",
        bankCode: "bmri",
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

async function openPayment(guest: Guest, orderId: string): Promise<string> {
  const paid = await as(guest).pay(orderId);
  expect(paid.status).toBe(201);
  expect(paid.body.data.status).toBe("pending");
  return paid.body.data.id as string;
}

/** A verified webhook settlement (the trusted source). */
async function settle(
  intentId: string,
  amountIdr: number,
  providerRef: string,
) {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "va",
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

// A business day no other test closes for outlet A.
const BUSINESS_DATE = "2031-03-15";

async function asPosOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

let approver: ReturnType<typeof agent>; // finance + outlet supervisor
let posStaff: Staff;
const approverUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderIds: string[] = [];
const key = (prefix = "refile") => `${prefix}-${randomUUID()}`;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

type Bill = {
  orderId: string;
  linkId: string;
  intentId: string;
  amountIdr: number;
};

/**
 * An open POS order of `amountIdr` and a QRIS link + intent the guest has
 * paid in full (evidence written, intent `paid`), as the WS-05 webhook leaves
 * them before the POS consumer runs. The tender is added by `addTender`.
 */
async function paidBill(amountIdr: number): Promise<Bill> {
  const orderId = randomUUID();
  const linkId = randomUUID();
  const intentId = randomUUID();
  orderIds.push(orderId);
  linkIds.push(linkId);
  intentIds.push(intentId);
  await asPosOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'awaiting_payment', $6, now())`,
      [
        orderId,
        seededTenantId,
        seededOutletA,
        `CR-${randomUUID().slice(0, 8)}`,
        amountIdr,
        BUSINESS_DATE,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [orderId, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'capture-race-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `CR-${linkId.slice(0, 8)}`,
        amountIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
               now() + interval '1 hour', now(), $7)`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        amountIdr,
        `cr-pay-${intentId}`,
        `ref-${intentId.slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        seededTenantId,
        seededOutletA,
        intentId,
        `evidence-${intentId}`,
        amountIdr,
      ],
    );
  });
  return { orderId, linkId, intentId, amountIdr };
}

/** The bill's authorized QRIS tender (link + paid intent); returns its id. */
async function addTender(
  bill: Bill,
  { replica = false }: { replica?: boolean } = {},
): Promise<string> {
  return asPosOwner(
    async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
            payment_link_id, payment_link_token_sealed, payment_intent_id, amount_idr,
            status, requested_at)
         VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed-test-token', $5, $6,
                 'authorized', now())
         RETURNING id`,
        [
          seededTenantId,
          seededOutletA,
          bill.orderId,
          bill.linkId,
          bill.intentId,
          bill.amountIdr,
        ],
      );
      return rows[0]!.id;
    },
    { replica },
  );
}

const deliverPaid = (bill: Bill) =>
  handlePosPaymentPaid(scope(), {
    name: "payment.paid",
    payload: { paymentLinkId: bill.linkId, intentId: bill.intentId },
  } as unknown as DomainEvent);

async function lateSettledOrder() {
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
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
  await settle(intentId, totalIdr, `WEBHOOK-${randomBytes(6).toString("hex")}`);
  return {
    intentId,
    totalIdr,
    paid: await onlyEvent("payment.paid", intentId),
  };
}

let second: Staff;

/** Admin API call as `who`; every call gets a fresh idempotency key. */
const admin = (who: Staff, path: string, body: Record<string, unknown>) =>
  who.client
    .post(`/api/payments/admin${path}`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: `refile-${randomUUID()}`, ...body })
    .then((response) => response);

async function refundOf(intentId: string, requestedBy: string) {
  const rows = await refundsOfIntent(intentId);
  return rows.find((row) => row.requested_by === requestedBy)!;
}

async function refundStatus(refundId: string) {
  const { rows } = await owner.query<{
    status: string;
    failure_reason: string | null;
  }>(
    "SELECT status, failure_reason FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, refundId],
  );
  return rows[0]!;
}

/** Sum of every refund of the intent that is not `failed`. */
async function reservedOfIntent(intentId: string) {
  return (await refundsOfIntent(intentId))
    .filter((row) => row.status !== "failed")
    .reduce((sum, row) => sum + Number(row.amount_idr), 0);
}

async function posRefundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
  }>(
    "SELECT id, status, amount_idr::text AS amount, requested_by FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at",
    [seededTenantId, intentId],
  );
  return rows;
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

beforeAll(async () => {
  // Floor-only role: add the refund permissions and a place in the Rp0 refund
  // tier BEFORE any late refund is filed (a system refund opens its approval
  // chain at creation, legend-2dnh). Two users: one requests, one approves.
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb, is_template = true, template_key = 'supervisor' WHERE tenant_id = $1 AND id = $3",
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
  second = await staffOfIsolatedTenant(app, tenant);
  await verifySessionMfa(staff.email);
  await verifySessionMfa(second.email);
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  posStaff = await staffWithRole(app, {
    template: "owner",
    label: "Capture Race Owner",
  });
  await verifySessionMfa(posStaff.email);
  const roleId = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  const makeApprover = async (label: string) => {
    const client = agent(app);
    const email = await signUp(client, label);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    approverUserIds.push(userId);
    await verifySessionMfa(email);
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [seededTenantId, userId, await roleId("finance")],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [seededTenantId, userId, await roleId("supervisor"), seededOutletA],
    );
    return client;
  };
  approver = await makeApprover("Late Refund Finance");
  // One tier for every amount: Finance decides in a single level.
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [seededTenantId, await roleId("finance")],
  );
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  const { rows: refunds } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refunds.map((r) => r.id)],
  );
  // Refund, tender and order rows may be immutable once final: skip user
  // triggers in a dedicated transaction.
  await asPosOwner(
    async (client) => {
      await client.query(
        "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      await client.query(
        "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
        [intentIds],
      );
      for (const table of ["pos_order_tenders", "pos_orders"])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
          [seededTenantId, orderIds],
        );
      await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
        orderIds,
      ]);
      await client.query(
        "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, intentIds],
      );
      await client.query(
        "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, linkIds],
      );
    },
    { replica: true },
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, approverUserIds],
  );
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

/** Ends a pending system refund as an approver rejecting it or as an expired chain. */
async function failSystemRefund(
  how: "rejected" | "approval_expired",
  refundId: string,
  tenantId: string,
  reject: () => Promise<{ status: number; body: unknown }>,
  context: ScopedTenantContext,
) {
  if (how === "rejected") {
    const rejected = await reject();
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    return;
  }
  await owner.query(
    "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
    [tenantId, refundId],
  );
  const settled = await settleRefundFromChain(context, refundId);
  expect(settled.status).toBe("failed");
}

describe.each(["rejected", "approval_expired"] as const)(
  "staff re-file of a late-paid QR intent (system refund %s)",
  (how) => {
    it("staff re-files the whole amount, another user approves, paid once, cap holds", async () => {
      const { intentId, totalIdr, paid } = await lateSettledOrder();
      expect(await deliver(paid)).toEqual({
        route: "qr",
        outcome: "late_payment_on_voided_order",
      });
      const late = await refundOf(intentId, "system:qr");
      expect(late).toMatchObject({
        amount_idr: String(totalIdr),
        status: "pending",
      });

      await failSystemRefund(
        how,
        late.id,
        tenant.tenantId,
        () =>
          admin(staff, `/refunds/${late.id}/reject`, {
            reason: "Uji tolak refund sistem",
          }),
        contextOf(tenant.tenantId),
      );
      expect(await refundStatus(late.id)).toEqual({
        status: "failed",
        failure_reason: how,
      });

      const filed = await admin(staff, "/refunds", {
        paymentIntentId: intentId,
        amountIdr: totalIdr,
        reason: "Refund ulang pembayaran terlambat",
      });
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        const approved = await admin(
          second,
          `/refunds/${filed.body.data.id}/approve`,
          {},
        );
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.data.status).toBe("completed");
        expect(fake.executionCount).toBe(1);

        // The guest got what was paid, once: any further refund is refused.
        expect(await reservedOfIntent(intentId)).toBe(totalIdr);
        const extra = await admin(staff, "/refunds", {
          paymentIntentId: intentId,
          amountIdr: 1,
          reason: "Refund berlebih",
        });
        expect(extra.status, JSON.stringify(extra.body)).toBe(409);
        expect(fake.executionCount).toBe(1);
      } finally {
        setPaymentRefundGateway(null);
      }
      expect(await reservedOfIntent(intentId)).toBe(totalIdr);
    });
  },
);

describe.each(["rejected", "approval_expired"] as const)(
  "staff re-file of a late-paid POS intent (system refund %s)",
  (how) => {
    it("staff re-files, another user approves, paid once, cap holds", async () => {
      const bill = await paidBill(100_000);
      await addTender(bill);
      // The bill closed before the guest paid: the capture is refused.
      await asPosOwner(
        (client) =>
          client.query(
            "UPDATE orders SET status = 'voided' WHERE tenant_id = $1 AND id = $2",
            [seededTenantId, bill.orderId],
          ),
        { replica: true },
      );
      await deliverPaid(bill);
      const late = (await posRefundRows(bill.intentId)).find(
        (row) => row.requested_by === "system:pos",
      )!;
      expect(late).toMatchObject({ status: "pending", amount: "100000" });

      await failSystemRefund(
        how,
        late.id,
        seededTenantId,
        () =>
          approver
            .post(`/api/payments/admin/refunds/${late.id}/reject`)
            .set(originHeader)
            .send({ idempotencyKey: key(), reason: "Uji tolak refund sistem" })
            .then((response) => response),
        scope(),
      );

      const filed = await posStaff.client
        .post("/api/payments/admin/refunds")
        .set(originHeader)
        .send({
          idempotencyKey: key(),
          paymentIntentId: bill.intentId,
          amountIdr: bill.amountIdr,
          reason: "Refund ulang pembayaran terlambat",
        });
      expect(filed.status, JSON.stringify(filed.body)).toBe(201);

      const fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
      try {
        const approved = await approver
          .post(`/api/payments/admin/refunds/${filed.body.data.id}/approve`)
          .set(originHeader)
          .send({ idempotencyKey: key() });
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.data.status).toBe("completed");
        expect(fake.executionCount).toBe(1);

        const extra = await posStaff.client
          .post("/api/payments/admin/refunds")
          .set(originHeader)
          .send({
            idempotencyKey: key(),
            paymentIntentId: bill.intentId,
            amountIdr: 1,
            reason: "Refund berlebih",
          });
        expect(extra.status, JSON.stringify(extra.body)).toBe(409);
        expect(fake.executionCount).toBe(1);
      } finally {
        setPaymentRefundGateway(null);
      }
      const kept = (await posRefundRows(bill.intentId))
        .filter((row) => row.status !== "failed")
        .reduce((sum, row) => sum + Number(row.amount), 0);
      expect(kept).toBe(bill.amountIdr);
    });
  },
);

describe("reserved system idempotency keys", () => {
  it("a user cannot pre-claim the late-payment key; the system filer still files", async () => {
    const { intentId, totalIdr, paid } = await lateSettledOrder();
    const squat = await admin(staff, "/refunds", {
      idempotencyKey: `qr-late-payment-refund:${intentId}`,
      paymentIntentId: intentId,
      amountIdr: 1000,
      reason: "Pre-claim kunci sistem",
    });
    expect(squat.status, JSON.stringify(squat.body)).toBe(422);
    expect(squat.body.error.code).toBe("IDEMPOTENCY_KEY_RESERVED");
    expect(await refundsOfIntent(intentId)).toHaveLength(0);

    expect(await deliver(paid)).toEqual({
      route: "qr",
      outcome: "late_payment_on_voided_order",
    });
    const late = await refundOf(intentId, "system:qr");
    expect(late).toMatchObject({
      amount_idr: String(totalIdr),
      status: "pending",
    });
  });
});
