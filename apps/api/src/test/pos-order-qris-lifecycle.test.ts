// POS QRIS tender lifecycle (bead legend-b0au; PRD v1.7 §3 F8 "Pembayaran",
// §3.13 "Siklus Pembayaran", PAY-01/PAY-02/PAY-04). A QRIS tender is opened
// `authorized` and must end in exactly one of: captured (verified
// `payment.paid`), failed (code expired / gateway failure), voided (cash or
// another method took over, or the order was voided). Proven here:
// - expiry and failure events fail the tender so a new QRIS can open;
// - voiding the order or paying another way closes the WS-05 link (link
//   expired, pending intent expired, `payment.expired` emitted);
// - a QRIS the guest already paid is never voided (409);
// - a late payment on a QR the provider already closed is parked in full, once
//   (legend-yhia9 D-07); one on a bill that cannot take it is refunded once;
// - a replayed or concurrent `payment.paid` captures once;
// - events and ids of another tenant do nothing.
//
// Real Express app, WS-05 service and PostgreSQL with RLS in a fresh isolated
// tenant; the gateway is a test double behind its port. The setup is copied
// from pos-order.test.ts.

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
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
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret } from "../lib/secrets.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { runPosQrisHoldCheckJob } from "../worker/pos-qris-hold-check.job.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  confirmPayment,
  createIntent,
  getIntentView,
} from "../services/payment.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const MINUTE = 60_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let other: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;

/** Gateway double: QRIS codes on demand, status answer set by the test. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  status: "pending" | "failed" | "expired" = "pending";
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEPOSQRIS",
      issuer: null,
    };
    return {
      providerRef: `OPC-${randomBytes(6).toString("hex")}-${this.created}`,
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
  async channels() {
    return [];
  }
}
let gateway: FakeGateway;

/** Gapless per outlet, idempotent per order: like the allocator it stands for. */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

// ---- Fixtures ---------------------------------------------------------------------

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

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
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

/** The till a request comes from: outlet plus the device registered there. */
type Till = { outletId: string; deviceId: string };
const mainTill = (): Till => ({
  outletId: tenant.outletId,
  deviceId: ids.device,
});
/** Extra devices (own outlets) the resolver knows besides `ids.device`. */
const extraDevices = new Map<string, string>();

function pos(till: Till = mainTill()) {
  const base = `/api/outlets/${encodeURIComponent(till.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      // The till: cash goes into the drawer of the shift open on this device.
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt: Math.floor(Date.now() / 1000),
          tenantId: tenant.tenantId,
          brandId: null,
          deviceId: till.deviceId,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    get: (orderId: string) =>
      cashier.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    qris: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/tenders`, { method: "qris", expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
  };
}

async function statusOf(
  orderId: string,
  till: Till = mainTill(),
): Promise<string> {
  const read = await pos(till).get(orderId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data.status as string;
}

type OpenOrder = { orderId: string; totalIdr: number };

/** create → submit: a payable POS order for Rp55.000. */
async function payableOrder(till: Till = mainTill()): Promise<OpenOrder> {
  const created = await pos(till).create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  if (created.body.data.status === "draft") {
    const submitted = await pos(till).submit(orderId, "draft");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  return { orderId, totalIdr: created.body.data.totalIdr as number };
}

type TenderRow = {
  id: string;
  status: string;
  resolved_at: Date | null;
  payment_link_id: string | null;
  payment_intent_id: string | null;
  amount_idr: string;
  method: string;
};

async function tendersOfOrder(orderId: string): Promise<TenderRow[]> {
  const { rows } = await owner.query<TenderRow>(
    `SELECT id, status, resolved_at, payment_link_id, payment_intent_id,
            amount_idr::text AS amount_idr, method
     FROM pos_order_tenders
     WHERE tenant_id = $1 AND order_id = $2::uuid
     ORDER BY requested_at, id`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows;
}

/** Opens a QRIS tender through the API and returns its stored row. */
async function openQris(
  order: OpenOrder,
  till: Till = mainTill(),
): Promise<TenderRow> {
  const response = await pos(till).qris(
    order.orderId,
    await statusOf(order.orderId, till),
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const tender = (await tendersOfOrder(order.orderId)).find(
    (row) => row.id === response.body.data.tender.id,
  );
  expect(tender?.status).toBe("authorized");
  expect(tender?.payment_link_id).not.toBeNull();
  expect(tender?.payment_intent_id).not.toBeNull();
  return tender!;
}

/** The guest's link token, unsealed the way the cashier screen would. */
async function tokenOf(tender: TenderRow): Promise<string> {
  const { rows } = await owner.query<{ sealed: string }>(
    `SELECT payment_link_token_sealed AS sealed FROM pos_order_tenders
     WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, tender.id],
  );
  return openSecret(
    rows[0]!.sealed,
    `pos-order-payment-link:${tenant.tenantId}:${tender.id}`,
  );
}

async function linkRow(linkId: string) {
  const { rows } = await owner.query<{
    expired: boolean;
    expires_at: Date | null;
  }>(
    `SELECT expires_at IS NOT NULL AND expires_at <= now() AS expired, expires_at
     FROM payment_links WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, linkId],
  );
  return rows[0]!;
}

async function intentStatus(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, intentId],
  );
  return rows[0]!.status;
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

async function paymentEvents(
  name: string,
  intentId: string,
  tenantId = tenant.tenantId,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'intentId' = $3
     ORDER BY created_at, id`,
    [tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function onlyPaymentEvent(name: string, intentId: string) {
  const events = await paymentEvents(name, intentId);
  expect(events).toHaveLength(1);
  return events[0]!;
}

/** As the worker does: inside the consumption (tenant) transaction. */
async function deliver(
  event: EventEnvelope,
  context = contextOf(tenant.tenantId),
  now = new Date(),
) {
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, now),
  );
}

/**
 * legend-yhia9 D-03: a QR stays collectible (its hold freezes the bill) until
 * the provider itself answers expired/failed about it. The test gateway
 * answers `answer`; the hold check job runs past expires_at + 60 s and closes
 * the hold: tender voided, link closed, bill unlocked.
 */
async function closeHoldByProvider(answer: "expired" | "failed" = "expired") {
  // The 5 minute code has lapsed on the real clock too.
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - interval '10 minutes'
      WHERE tenant_id = $1 AND id IN (
        SELECT payment_intent_id FROM pos_qris_holds
         WHERE tenant_id = $1 AND state IN ('open', 'cancelling'))`,
    [tenant.tenantId],
  );
  gateway.status = answer;
  try {
    await runPosQrisHoldCheckJob(contextOf(tenant.tenantId), new Date(), {
      force: true,
    });
  } finally {
    gateway.status = "pending";
  }
}

/**
 * legend-yhia9 D-07: money for a QR whose hold the provider already closed is
 * parked (unallocated), never captured and never auto-refunded; the payer is
 * paid back by the manager (Q93). confirmPayment parks it and throws 409.
 */
async function settleParked(
  intentId: string,
  amountIdr: number,
  providerRef = `WEBHOOK-${randomBytes(6).toString("hex")}`,
) {
  try {
    await confirmPayment(contextOf(tenant.tenantId), intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr,
      providerRef,
      at: new Date().toISOString(),
    });
  } catch (error) {
    if ((error as { status?: unknown }).status !== 409) throw error;
  }
}

async function parkedOfIntent(intentId: string) {
  const { rows } = await owner.query<{ amount_idr: string }>(
    `SELECT amount_idr::text AS amount_idr FROM payment_unallocated_funds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenant.tenantId, intentId],
  );
  return rows;
}

async function orderEventCount(orderId: string, type: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM order_events
     WHERE tenant_id = $1 AND order_id = $2::uuid AND type = $3`,
    [tenant.tenantId, ulidToUuid(orderId), type],
  );
  return Number(rows[0]!.count);
}

async function auditCount(
  action: string,
  objectIds: string[],
): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = ANY($3)`,
    [tenant.tenantId, action, objectIds],
  );
  return Number(rows[0]!.count);
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

/** Main's per-staff PIN approval: the supervisor's own tile + PIN. */
async function voidApproval(orderId: string, valueIdr: number) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

beforeAll(async () => {
  app = createApp();
  gateway = new FakeGateway();
  setPaymentGateway(gateway);
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`qrl-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`qro-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId !== tenant.tenantId
      ? null
      : deviceId === ids.device
        ? tenant.outletId
        : (extraDevices.get(deviceId) ?? null),
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "QRIS Kasir");
  supervisor = await member(ids.supervisorRole, "QRIS Supervisor");
  // Cash tenders, refunds and voids of cash-paid orders need the acting
  // cashier's open shift (409 SHIFT_NOT_OPEN otherwise): one shift on the
  // registered device covers every sale here.
  await openPosShift(
    contextOf(tenant.tenantId),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'POS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    // PBJT 10% on F&B, menu prices exclude tax, no service charge rule: a
    // Rp50.000 sale is billed Rp55.000.
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setPaymentGateway(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  // Final orders are immutable and audit rows append-only, so the isolated
  // tenants stay in the disposable database; give them a valid creator so the
  // platform tenant list still parses them.
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

beforeEach(() => {
  gateway.status = "pending";
});

describe("POS QRIS tender lifecycle (legend-b0au)", () => {
  it("an expired QRIS code never unlocks the bill by itself; once the provider proves it dead the tender is voided once and a new QRIS can open", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // The 10 minute code lapses; WS-05 emits payment.expired.
    // DOIT got our expires_in, so it reports the lapsed code expired.
    gateway.status = "expired";
    await getIntentView(
      contextOf(tenant.tenantId),
      await tokenOf(tender),
      tender.payment_intent_id!,
      new Date(Date.now() + 11 * MINUTE),
    );
    expect(await intentStatus(tender.payment_intent_id!)).toBe("expired");
    const event = await onlyPaymentEvent(
      "payment.expired",
      tender.payment_intent_id!,
    );

    // D-04: the local expiry event alone changes nothing (the QR may still
    // be paid at the provider).
    const routed = await deliver(event);
    expect(routed).toEqual({ route: "pos" });
    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      id: tender.id,
      status: "authorized",
    });
    expect(await orderEventCount(order.orderId, "order.tender_failed")).toBe(0);

    await closeHoldByProvider("expired");
    const [voided] = await tendersOfOrder(order.orderId);
    expect(voided).toMatchObject({ id: tender.id, status: "voided" });
    expect(voided!.resolved_at).not.toBeNull();
    expect(await orderEventCount(order.orderId, "order.tender_voided")).toBe(1);

    // Replay: nothing changes.
    await deliver(event);
    expect(await orderEventCount(order.orderId, "order.tender_voided")).toBe(1);

    // The cashier can open a fresh QRIS for the same balance.
    const again = await openQris(order);
    expect(again.id).not.toBe(tender.id);
    expect(again.payment_intent_id).not.toBe(tender.payment_intent_id);
    expect(Number(again.amount_idr)).toBe(order.totalIdr);
  });

  it("a failed QRIS (gateway answer) frees its tender only once the provider proves it", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    gateway.status = "failed";
    try {
      await getIntentView(
        contextOf(tenant.tenantId),
        await tokenOf(tender),
        tender.payment_intent_id!,
      );
    } finally {
      gateway.status = "pending";
    }
    expect(await intentStatus(tender.payment_intent_id!)).toBe("failed");
    const event = await onlyPaymentEvent(
      "payment.failed",
      tender.payment_intent_id!,
    );
    expect(await deliver(event)).toEqual({ route: "pos" });
    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      status: "authorized",
    });
    await closeHoldByProvider("failed");
    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      status: "voided",
    });
    // A new QRIS is allowed again.
    await openQris(order);
  });

  it("a closed-intent event does not fail a tender that was already captured", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    await settle(tender.payment_intent_id!, order.totalIdr);
    await deliver(
      await onlyPaymentEvent("payment.paid", tender.payment_intent_id!),
    );
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("captured");
    // A stray expiry for the same intent changes nothing.
    const paid = await onlyPaymentEvent(
      "payment.paid",
      tender.payment_intent_id!,
    );
    await deliver({
      ...paid,
      name: "payment.expired",
      payload: { intentId: tender.payment_intent_id, reason: "timeout" },
    } as EventEnvelope);
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("captured");
  });

  it("voiding the order is refused while the QRIS can be paid; once the provider closes it the link is closed: link expired, pending intent expired, payment.expired emitted", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    const before = await linkRow(tender.payment_link_id!);
    expect(before.expired).toBe(false);

    const approval = await voidApproval(order.orderId, order.totalIdr);
    const refused = await pos().voidOrder(order.orderId, {
      expectedStatus: await statusOf(order.orderId),
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      ...approval,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("QRIS_HOLD_ACTIVE");
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("authorized");
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(false);

    await closeHoldByProvider("expired");
    const voided = await pos().voidOrder(order.orderId, {
      expectedStatus: await statusOf(order.orderId),
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      ...approval,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe("voided");

    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      status: "voided",
    });
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(true);
    expect(await intentStatus(tender.payment_intent_id!)).toBe("expired");
    const event = await onlyPaymentEvent(
      "payment.expired",
      tender.payment_intent_id!,
    );
    expect(event.payload).toMatchObject({
      intentId: tender.payment_intent_id,
      reason: "provider_expired",
    });
    // The guest's page refuses the closed link.
    await expect(
      createIntent(contextOf(tenant.tenantId), await tokenOf(tender), {
        method: "qris",
        channelCode: null,
        idempotencyKey: `late-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ status: 404 });
    // The expiry event is harmless on the voided tender.
    await deliver(event);
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");
  });

  it("cash is refused while a QRIS can be paid; once the provider closes it, cash takes the full balance", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    const refused = await pos().cash(
      order.orderId,
      await statusOf(order.orderId),
      order.totalIdr,
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("QRIS_HOLD_ACTIVE");
    expect(await tendersOfOrder(order.orderId)).toEqual([
      expect.objectContaining({ id: tender.id, status: "authorized" }),
    ]);
    await closeHoldByProvider("expired");
    const cash = await pos().cash(
      order.orderId,
      await statusOf(order.orderId),
      order.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);

    const rows = await tendersOfOrder(order.orderId);
    expect(rows.find((row) => row.id === tender.id)).toMatchObject({
      status: "voided",
    });
    expect(rows.find((row) => row.method === "cash")).toMatchObject({
      status: "captured",
    });
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(true);
    expect(await intentStatus(tender.payment_intent_id!)).toBe("expired");
    await onlyPaymentEvent("payment.expired", tender.payment_intent_id!);
    expect(await orderEventCount(order.orderId, "order.tender_voided")).toBe(1);
    // The provider-proof closure writes the audit row (named after the hold).
    const { rows: holds } = await owner.query<{ id: string }>(
      "SELECT id::text AS id FROM pos_qris_holds WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenant.tenantId, ulidToUuid(order.orderId)],
    );
    expect(holds).toHaveLength(1);
    expect(
      await auditCount("pos_qris_hold.closed_by_provider", [
        holds[0]!.id,
        uuidToUlid(holds[0]!.id),
      ]),
    ).toBe(1);

    const completed = await pos().complete(
      order.orderId,
      cash.body.data.order.status,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  });

  it("cash while the QRIS intent is already paid is refused with 409 and keeps the QRIS", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // Verified money is in; the payment.paid event is not consumed yet.
    await settle(tender.payment_intent_id!, order.totalIdr);

    const cash = await pos().cash(
      order.orderId,
      await statusOf(order.orderId),
      order.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(409);
    // The bill is frozen until the confirmation is booked (the hold guard
    // answers before the old "QRIS sudah dibayar" wording).
    expect(JSON.stringify(cash.body)).toContain("QRIS_HOLD_ACTIVE");
    expect(await tendersOfOrder(order.orderId)).toEqual([
      expect.objectContaining({ id: tender.id, status: "authorized" }),
    ]);
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(false);

    // The confirmation then books the QRIS as usual.
    await deliver(
      await onlyPaymentEvent("payment.paid", tender.payment_intent_id!),
    );
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("captured");
  });

  it("voiding the order while the QRIS intent is already paid is refused with 409 and changes nothing", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // Verified money is in; the payment.paid event is not consumed yet.
    await settle(tender.payment_intent_id!, order.totalIdr);

    const statusBefore = await statusOf(order.orderId);
    const approval = await voidApproval(order.orderId, order.totalIdr);
    const voided = await pos().voidOrder(order.orderId, {
      expectedStatus: statusBefore,
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      ...approval,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(409);
    expect(JSON.stringify(voided.body)).toContain("QRIS_HOLD_ACTIVE");

    // Nothing changed: order not voided, tender still waiting, link open.
    expect(await statusOf(order.orderId)).toBe(statusBefore);
    expect(await statusOf(order.orderId)).not.toBe("voided");
    expect(await tendersOfOrder(order.orderId)).toEqual([
      expect.objectContaining({ id: tender.id, status: "authorized" }),
    ]);
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(false);
    expect(await orderEventCount(order.orderId, "order.tender_voided")).toBe(0);

    // The confirmation then books the QRIS as usual.
    await deliver(
      await onlyPaymentEvent("payment.paid", tender.payment_intent_id!),
    );
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("captured");
  });

  it("payment.expired keeps the POS QRIS tender while the QR can be paid; the provider's proof voids it and cancels its payment link", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(false);
    // DOIT got our expires_in, so it reports the lapsed code expired.
    gateway.status = "expired";
    await getIntentView(
      contextOf(tenant.tenantId),
      await tokenOf(tender),
      tender.payment_intent_id!,
      new Date(Date.now() + 11 * MINUTE),
    );
    const event = await onlyPaymentEvent(
      "payment.expired",
      tender.payment_intent_id!,
    );

    expect(await deliver(event)).toEqual({ route: "pos" });
    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      id: tender.id,
      status: "authorized",
    });
    await closeHoldByProvider("expired");
    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      id: tender.id,
      status: "voided",
    });
    // The link stops taking new intents: expires_at <= now.
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(true);
  });

  it("payment.expired consumed after the guest already paid keeps the tender authorized, then payment.paid captures it", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // DOIT got our expires_in, so it reports the lapsed code expired.
    gateway.status = "expired";
    await getIntentView(
      contextOf(tenant.tenantId),
      await tokenOf(tender),
      tender.payment_intent_id!,
      new Date(Date.now() + 11 * MINUTE),
    );
    const expired = await onlyPaymentEvent(
      "payment.expired",
      tender.payment_intent_id!,
    );
    // Assumption (spec ambiguity): WS-05 accepts a late settlement on an
    // expired intent, so the late webhook wins before the expiry is consumed.
    await settle(tender.payment_intent_id!, order.totalIdr);
    expect(await intentStatus(tender.payment_intent_id!)).toBe("paid");

    await deliver(expired);
    expect(await tendersOfOrder(order.orderId)).toEqual([
      expect.objectContaining({ id: tender.id, status: "authorized" }),
    ]);
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
    expect(await orderEventCount(order.orderId, "order.tender_failed")).toBe(0);

    await deliver(
      await onlyPaymentEvent("payment.paid", tender.payment_intent_id!),
    );
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("captured");
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
  });

  it("payment.paid after the bill shrank below the open QRIS voids the tender, closes its link and refunds once", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // More deposit is applied while the QRIS waits: what is still due (Rp45.000)
    // is now below the QRIS amount (Rp55.000). Neither the API nor (since
    // legend-yhia9, QH-20) the 0369 trigger lets this happen while the QR can
    // be paid, so the write bypasses triggers (replica role): it models a bill
    // changed behind the freeze, which the consumer must still survive.
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE orders SET deposit_applied_idr = 10000 WHERE tenant_id = $1 AND id = $2::uuid",
        [tenant.tenantId, ulidToUuid(order.orderId)],
      );
    });
    await settle(tender.payment_intent_id!, order.totalIdr);
    const event = await onlyPaymentEvent(
      "payment.paid",
      tender.payment_intent_id!,
    );
    await deliver(event);

    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      id: tender.id,
      status: "voided",
    });
    expect((await linkRow(tender.payment_link_id!)).expired).toBe(true);
    const refunds = await refundsOfIntent(tender.payment_intent_id!);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: String(order.totalIdr),
      requested_by: "system:pos",
    });

    // Replay, sequential and concurrent: still one refund row.
    await deliver(event);
    await Promise.all([deliver(event), deliver(event)]);
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(1);
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");
  });

  it("a QRIS paid after the provider closed it and cash took the bill is parked in full, once (no capture, no automatic refund)", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // The QR is closed by the provider's proof first (D-01: cash cannot
    // replace a QR that can still be paid).
    await closeHoldByProvider("expired");
    const cash = await pos().cash(
      order.orderId,
      await statusOf(order.orderId),
      order.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");

    // The guest still scans the old code: WS-05 accepts it as a late payment
    // but the bill cannot take it (hold closed): D-07, parked in full.
    const ref = `WEBHOOK-${randomBytes(6).toString("hex")}`;
    await settleParked(tender.payment_intent_id!, order.totalIdr, ref);
    expect(await parkedOfIntent(tender.payment_intent_id!)).toEqual([
      { amount_idr: String(order.totalIdr) },
    ]);
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
    // The POS bill itself is untouched: cash stays the only captured tender.
    const rows = await tendersOfOrder(order.orderId);
    expect(rows.filter((row) => row.status === "captured")).toHaveLength(1);

    // Replay, sequential and concurrent: still one parked row.
    await settleParked(tender.payment_intent_id!, order.totalIdr, ref);
    await Promise.all([
      settleParked(tender.payment_intent_id!, order.totalIdr, ref),
      settleParked(tender.payment_intent_id!, order.totalIdr, ref),
    ]);
    expect(await parkedOfIntent(tender.payment_intent_id!)).toHaveLength(1);
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
  });

  it("a QRIS paid after the provider closed its expired code is parked too", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // DOIT got our expires_in, so it reports the lapsed code expired.
    gateway.status = "expired";
    await getIntentView(
      contextOf(tenant.tenantId),
      await tokenOf(tender),
      tender.payment_intent_id!,
      new Date(Date.now() + 11 * MINUTE),
    );
    await deliver(
      await onlyPaymentEvent("payment.expired", tender.payment_intent_id!),
    );
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("authorized");
    await closeHoldByProvider("expired");
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");

    await settleParked(tender.payment_intent_id!, order.totalIdr);
    expect(await parkedOfIntent(tender.payment_intent_id!)).toHaveLength(1);
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");
  });

  it("a replayed or concurrent payment.paid captures the tender exactly once", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    await settle(tender.payment_intent_id!, order.totalIdr);
    const event = await onlyPaymentEvent(
      "payment.paid",
      tender.payment_intent_id!,
    );

    await Promise.all([deliver(event), deliver(event)]);
    await deliver(event);

    const rows = await tendersOfOrder(order.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "captured" });
    expect(await orderEventCount(order.orderId, "order.tender_captured")).toBe(
      1,
    );
    expect(
      await auditCount("pos_order.tender_captured", [
        order.orderId,
        ulidToUuid(order.orderId),
      ]),
    ).toBe(1);
    // Paid exactly once: no refund was requested for the captured money.
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
  });
});

describe("POS QRIS lifecycle tenant isolation (legend-b0au)", () => {
  it("events delivered under another tenant never touch this tenant's tender", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    // DOIT got our expires_in, so it reports the lapsed code expired.
    gateway.status = "expired";
    await getIntentView(
      contextOf(tenant.tenantId),
      await tokenOf(tender),
      tender.payment_intent_id!,
      new Date(Date.now() + 11 * MINUTE),
    );
    const expired = await onlyPaymentEvent(
      "payment.expired",
      tender.payment_intent_id!,
    );

    // (a) The other tenant's worker holds this tenant's envelope: refused.
    expect(await deliver(expired, contextOf(other.tenantId))).toEqual({
      route: "ignored",
    });
    // (b) An envelope forged under the other tenant naming this tenant's ids:
    // RLS hides the intent, link and tender, so nothing is found or changed.
    const forged = { ...expired, tenantId: other.tenantId } as EventEnvelope;
    expect(await deliver(forged, contextOf(other.tenantId))).toEqual({
      route: "ignored",
    });
    const forgedPaid = {
      ...forged,
      name: "payment.paid",
      payload: {
        paymentLinkId: tender.payment_link_id,
        intentId: tender.payment_intent_id,
      },
    } as EventEnvelope;
    await deliver(forgedPaid, contextOf(other.tenantId));

    expect((await tendersOfOrder(order.orderId))[0]).toMatchObject({
      status: "authorized",
    });
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(0);
    expect(await orderEventCount(order.orderId, "order.tender_failed")).toBe(0);
  });
});

/** A fresh outlet of the tenant with the Kopi takeaway price and a device. */
async function addOutlet(): Promise<Till> {
  const outletId = randomUUID();
  const deviceId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $3, $4, address, timezone, opening_hours, status
     FROM outlets WHERE tenant_id = $2 AND id = $5`,
    [
      outletId,
      tenant.tenantId,
      `Q-${suffix}`.toUpperCase(),
      `Outlet QRIS ${suffix}`,
      tenant.outletId,
    ],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    const listId = randomUUID();
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [listId, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, listId, ids.kopi, KOPI_IDR],
    );
  });
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId,
    deviceId,
  });
  extraDevices.set(deviceId, outletId);
  return { outletId, deviceId };
}

/** The order's stored business day (what the day close is keyed on). */
async function businessDateOf(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ business_date: string }>(
    `SELECT business_date::text AS business_date FROM orders
     WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.business_date;
}

/** Same SQL as pos-cash-guard.test.ts insertDayClose, with a marker recap. */
async function insertDayClose(outletId: string, businessDate: string) {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_daily_closes
         (tenant_id, outlet_id, business_date, order_count, total_sales_idr,
          total_refunds_idr, total_voids_idr, total_variance_idr,
          inventory_deduction_applied, recap, closed_by, closed_at,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0, false, '{"marker":"frozen"}', $4, now(), $5, $6)`,
      [
        tenant.tenantId,
        outletId,
        businessDate,
        cashier.userId,
        randomUUID(),
        "0".repeat(64),
      ],
    ),
  );
}

async function dayCloseRows(
  outletId: string,
  businessDate: string,
): Promise<string[]> {
  const { rows } = await owner.query<{ row: string }>(
    `SELECT to_jsonb(c)::text AS row FROM pos_daily_closes c
     WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
    [tenant.tenantId, outletId, businessDate],
  );
  return rows.map((row) => row.row);
}

describe("POS QRIS paid on a closed business day (legend-mf0.1)", () => {
  // Assumption: a payment.paid event for a QRIS whose order's business day is
  // already closed must not capture (the order can never complete); the
  // tender is voided and the guest's money refunded once. The consumer never
  // throws for it (that would retry forever).
  it("payment.paid after the day was closed voids the tender, refunds once and leaves the close untouched", async () => {
    // Own outlet: a day close is immutable, so closing the shared outlet's
    // today would break every other test regardless of order.
    const till = await addOutlet();
    const order = await payableOrder(till);
    const tender = await openQris(order, till);
    const businessDate = await businessDateOf(order.orderId);
    await insertDayClose(till.outletId, businessDate);
    const closeBefore = await dayCloseRows(till.outletId, businessDate);
    expect(closeBefore).toHaveLength(1);

    await settle(tender.payment_intent_id!, order.totalIdr);
    const event = await onlyPaymentEvent(
      "payment.paid",
      tender.payment_intent_id!,
    );
    await deliver(event);

    const rows = await tendersOfOrder(order.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: tender.id, status: "voided" });
    expect(rows.filter((row) => row.status === "captured")).toHaveLength(0);
    expect(await orderEventCount(order.orderId, "order.tender_captured")).toBe(
      0,
    );
    expect(await orderEventCount(order.orderId, "order.tender_voided")).toBe(1);
    const { rows: events } = await owner.query<{ event: string }>(
      `SELECT to_jsonb(e)::text AS event FROM order_events e
       WHERE tenant_id = $1 AND order_id = $2::uuid AND type = 'order.tender_voided'`,
      [tenant.tenantId, ulidToUuid(order.orderId)],
    );
    expect(events[0]!.event).toContain("business_day_closed");
    expect(
      await auditCount("pos_order.tender_voided", [
        order.orderId,
        ulidToUuid(order.orderId),
        tender.id,
      ]),
    ).toBe(1);
    expect(await statusOf(order.orderId, till)).not.toBe("completed");

    const refunds = await refundsOfIntent(tender.payment_intent_id!);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      amount_idr: String(order.totalIdr),
      status: "pending",
      requested_by: "system:pos",
    });
    expect(
      await auditCount("pos_order.late_payment_refund_requested", [
        refunds[0]!.id,
      ]),
    ).toBe(1);
    expect(await dayCloseRows(till.outletId, businessDate)).toEqual(
      closeBefore,
    );

    // Replay, sequential and concurrent: nothing changes.
    await deliver(event);
    await Promise.all([deliver(event), deliver(event)]);
    expect(await refundsOfIntent(tender.payment_intent_id!)).toHaveLength(1);
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");
    expect(await orderEventCount(order.orderId, "order.tender_voided")).toBe(1);
    expect(
      await auditCount("pos_order.tender_voided", [
        order.orderId,
        ulidToUuid(order.orderId),
        tender.id,
      ]),
    ).toBe(1);
    expect(
      await auditCount("pos_order.late_payment_refund_requested", [
        refunds[0]!.id,
      ]),
    ).toBe(1);
    expect(await dayCloseRows(till.outletId, businessDate)).toEqual(
      closeBefore,
    );
  }, 60_000);
});
