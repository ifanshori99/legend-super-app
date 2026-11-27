// POS QRIS money fixes, round 2 (bead legend-b0au; PRD v1.7 §3.13
// "Siklus Pembayaran", PAY-01/PAY-02/PAY-04). Proven here:
// - a verified gateway settlement that lands after the intent went `failed`
//   (the cashier took another method meanwhile) is accepted like a late one
//   after `expired`: the intent becomes `paid` + `late_payment`, one
//   `payment.paid` is emitted, and the POS consumer files exactly one pending
//   refund; a webhook replay records nothing twice;
// - `createIntent` calls the gateway outside the lock, so a link closed
//   (cash replaced the QRIS) while the gateway call was in flight must refuse
//   the new intent instead of storing it on the closed link.
//
// Real Express app, WS-05 service and PostgreSQL with RLS in a fresh isolated
// tenant; the gateway is a test double behind its port. The setup is copied
// from pos-order-qris-lifecycle.test.ts.

// from pos-order.test.ts.

import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { PaymentInstructions } from "@starter/shared/payment";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { openSecret } from "../lib/secrets.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
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
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

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

function pos() {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
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
          deviceId: ids.device,
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

async function statusOf(orderId: string): Promise<string> {
  const read = await pos().get(orderId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data.status as string;
}

type OpenOrder = { orderId: string; totalIdr: number };

/** create → submit: a payable POS order for Rp55.000. */
async function payableOrder(): Promise<OpenOrder> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  if (created.body.data.status === "draft") {
    const submitted = await pos().submit(orderId, "draft");
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
async function openQris(order: OpenOrder): Promise<TenderRow> {
  const response = await pos().qris(
    order.orderId,
    await statusOf(order.orderId),
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

beforeAll(async () => {
  app = createApp();
  gateway = new FakeGateway();
  setPaymentGateway(gateway);
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`qrl-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
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
  // Final orders are immutable and audit rows append-only, so the isolated
  // tenants stay in the disposable database; give them a valid creator so the
  // platform tenant list still parses them.
  for (const t of [tenant])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

/** Fixed settlement evidence: the same provider transaction on every replay. */
async function settleAs(intentId: string, amountIdr: number, ref: string) {
  return confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: ref,
    at: new Date().toISOString(),
  });
}

/**
 * legend-yhia9 D-03: a QR stays collectible (its hold freezes the bill) until
 * the provider itself answers expired/failed about it. The test gateway
 * answers `answer`; the hold check job runs past expires_at + 60 s and closes
 * the hold: tender voided, link closed, bill unlocked.
 */
async function closeHoldByProvider(
  answer: "expired" | "failed",
  via: FakeGateway = gateway,
) {
  // The 5 minute code has lapsed on the real clock too.
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - interval '10 minutes'
      WHERE tenant_id = $1 AND id IN (
        SELECT payment_intent_id FROM pos_qris_holds
         WHERE tenant_id = $1 AND state IN ('open', 'cancelling'))`,
    [tenant.tenantId],
  );
  via.status = answer;
  try {
    await runPosQrisHoldCheckJob(contextOf(tenant.tenantId), new Date(), {
      force: true,
    });
  } finally {
    via.status = "pending";
  }
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    flags: string[];
    paid_at: Date | null;
  }>(
    "SELECT status, flags, paid_at FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function intentCountOfLink(linkId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM payment_intents
     WHERE tenant_id = $1 AND payment_link_id = $2`,
    [tenant.tenantId, linkId],
  );
  return Number(rows[0]!.count);
}

describe("POS QRIS verified settlement after the intent failed (legend-b0au)", () => {
  it("a verified webhook after the provider closed the QR + cash tender is a late payment: parked once, no double record on replay", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    const intentId = tender.payment_intent_id!;

    // The gateway reports the code failed; the POS consumer fails the tender.
    gateway.status = "failed";
    try {
      await getIntentView(
        contextOf(tenant.tenantId),
        await tokenOf(tender),
        intentId,
      );
    } finally {
      gateway.status = "pending";
    }
    expect(await intentStatus(intentId)).toBe("failed");
    expect(
      await deliver(await onlyPaymentEvent("payment.failed", intentId)),
    ).toEqual({ route: "pos" });
    // D-04: the failure event alone does not unlock the bill; the provider's
    // own answer does (the hold check), which voids the tender.
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("authorized");
    await closeHoldByProvider("failed");
    expect((await tendersOfOrder(order.orderId))[0]!.status).toBe("voided");

    // The cashier takes the full bill in cash.
    const cash = await pos().cash(
      order.orderId,
      await statusOf(order.orderId),
      order.totalIdr,
    );
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);

    // The guest's QRIS money still arrives: a verified webhook. The provider
    // already closed this QR (hold closed), so the bill cannot take it: D-07
    // parks it in full (never lost, never captured, no automatic refund).
    const ref = `WEBHOOK-${randomBytes(6).toString("hex")}`;
    const settleParked = async () => {
      try {
        await settleAs(intentId, order.totalIdr, ref);
      } catch (error) {
        if ((error as { status?: unknown }).status !== 409) throw error;
      }
    };
    await settleParked();
    // The intent itself stays closed: nothing was booked on the bill.
    expect((await intentRow(intentId)).status).toBe("failed");
    const parkedOf = async () =>
      (
        await owner.query<{ amount_idr: string }>(
          `SELECT amount_idr::text AS amount_idr FROM payment_unallocated_funds
            WHERE tenant_id = $1 AND payment_intent_id = $2`,
          [tenant.tenantId, intentId],
        )
      ).rows;
    expect(await parkedOf()).toEqual([{ amount_idr: String(order.totalIdr) }]);
    expect(await refundsOfIntent(intentId)).toHaveLength(0);
    // The POS bill is untouched: cash stays the only captured tender.
    expect(
      (await tendersOfOrder(order.orderId)).filter(
        (row) => row.status === "captured",
      ),
    ).toHaveLength(1);

    // Replay the webhook: still one parked row.
    await settleParked();
    await Promise.all([settleParked(), settleParked()]);
    expect(await parkedOf()).toHaveLength(1);
    expect(await refundsOfIntent(intentId)).toHaveLength(0);
  });

  it("an unverified source never settles a failed intent", async () => {
    const order = await payableOrder();
    const tender = await openQris(order);
    const intentId = tender.payment_intent_id!;
    gateway.status = "failed";
    try {
      await getIntentView(
        contextOf(tenant.tenantId),
        await tokenOf(tender),
        intentId,
      );
    } finally {
      gateway.status = "pending";
    }
    await expect(
      confirmPayment(contextOf(tenant.tenantId), intentId, {
        source: "authorized_cash",
        method: "qris",
        amountIdr: order.totalIdr,
        providerRef: `REDIRECT-${randomBytes(4).toString("hex")}`,
        at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await intentStatus(intentId)).toBe("failed");
  });
});

/** Holds `createIntent` at the gateway until the test lets it through. */
class BlockingGateway extends FakeGateway {
  arrived: () => void = () => {};
  readonly hasArrived = new Promise<void>((resolve) => {
    this.arrived = resolve;
  });
  release: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  block = false;
  override async createIntent(input: GatewayIntentRequest) {
    if (!this.block) return super.createIntent(input);
    this.arrived();
    await this.gate;
    return super.createIntent(input);
  }
}

describe("POS createIntent racing a link cancellation (legend-b0au)", () => {
  it("a link closed while the gateway call is in flight stores no intent", async () => {
    const blocking = new BlockingGateway();
    const order = await payableOrder();
    const tender = await openQris(order);
    const token = await tokenOf(tender);
    const linkId = tender.payment_link_id!;
    expect(await intentCountOfLink(linkId)).toBe(1);

    // The guest's page asks for a fresh code (new idempotency key) and the
    // gateway call is held; the plan was read while the link was still open.
    // legend-osqou.41 (1bdbf0a8b): a link with no order takes a new code only
    // once the live one is final, so the first code is closed for the issue
    // check and reopened once the gateway call is held.
    const firstIntentId = tender.payment_intent_id!;
    await owner.query(
      "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, firstIntentId],
    );
    setPaymentGateway(blocking);
    blocking.block = true;
    const key = `race-${randomUUID()}`;
    const racing = createIntent(contextOf(tenant.tenantId), token, {
      method: "qris",
      channelCode: null,
      idempotencyKey: key,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await blocking.hasArrived;
      await owner.query(
        "UPDATE payment_intents SET status = 'pending', provider_final_at = NULL WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, firstIntentId],
      );

      // Meanwhile the provider proves the QR dead and the hold check closes
      // it (cash can no longer replace a collectible QR, D-01):
      // cancelPaymentLinkInTx commits.
      await closeHoldByProvider("expired", blocking);
      expect((await linkRow(linkId)).expired).toBe(true);
    } finally {
      blocking.release();
      setPaymentGateway(gateway);
    }

    // Refused like an expired link, and no pending code on the closed link.
    const outcome = await racing;
    expect(outcome.ok).toBe(false);
    // legend-154wr (940): the code the gateway made is kept as ONE orphan row
    // (failed, not final, derived key, id = intent id) so a late payment on it
    // is found by webhook and poll; it is never a pending (live) code.
    expect(await intentCountOfLink(linkId)).toBe(2);
    const { rows } = await owner.query(
      `SELECT 1 FROM payment_intents
       WHERE tenant_id = $1 AND payment_link_id = $2 AND status = 'pending'
         AND idempotency_key NOT LIKE '%:orphan:%'`,
      [tenant.tenantId, linkId],
    );
    expect(rows).toHaveLength(0);
    const orphans = await owner.query<{
      id: string;
      status: string;
      provider_final_at: Date | null;
      provider_ref: string | null;
    }>(
      `SELECT id, status, provider_final_at, provider_ref FROM payment_intents
       WHERE tenant_id = $1 AND payment_link_id = $2
         AND idempotency_key LIKE '%:orphan:%'`,
      [tenant.tenantId, linkId],
    );
    expect(orphans.rows).toHaveLength(1);
    expect(orphans.rows[0]!.status).toBe("failed");
    expect(orphans.rows[0]!.provider_final_at).toBeNull();
    expect(orphans.rows[0]!.provider_ref).not.toBeNull();
  });
});
