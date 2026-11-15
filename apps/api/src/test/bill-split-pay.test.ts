// legend-ms3 split bill, payment side (design D4/D5, PRD v1.7 §3 F10, ORD-06):
// each part of a split bill gets its own payment code; the order fires only
// when every part is paid; a paid part can never be re-split.
//
// Real Express app, WS-05 payment service and PostgreSQL with RLS in a fresh
// isolated tenant per case (setup as qr-order-double-pay-payer.test.ts).
//
// Assumptions:
// - Test names carry the PRD criterion id ORD-06 (split bill); there is no
//   separate feature id for the payment side.
// - The order total is whatever the cart totals (one Kopi Susu, 5% service,
//   10% PBJT). Parts come from `POST /splits` (equal), never hard-coded.
// - "Replaced code" (new method on a part) is not `pending` any more; the
//   exact terminal status (expired / cancelled / superseded) is not pinned.
// - Error codes: voided part -> 409 CONFLICT; part above the outstanding
//   amount -> 409 CONFLICT; split after a payment -> 409 SPLIT_LOCKED;
//   reuse of an idempotency key on another part -> 409
//   IDEMPOTENCY_KEY_REUSED (as D5 states it; at the HTTP level).
// - "Part above outstanding" is produced by raising the pending part's
//   amount_idr in the DB above what is still owed, since the service never
//   issues such a split itself.
// - Only the order status, the `order.paid` outbox count and the bill_splits
//   rows are asserted for "fires"; the consumer outcome name is not pinned.

import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { runPosQrisHoldCheckJob } from "../worker/pos-qris-hold-check.job.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type OnlinePaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import { newPayerSecret, secretFor } from "./payer-secret-helpers.ts";
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
const BANKS: PaymentChannel[] = [{ code: "bmri", name: "Mandiri" }];

/** Gateway double offering QRIS and one VA bank. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  /** Provider references the provider reports expired (legend-yhia9 D-03). */
  readonly expiredRefs = new Set<string>();
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
            qrPayload: "00020101021226FAKESPLIT",
            issuer: null,
          };
    return {
      providerRef: `SPL-${randomBytes(6).toString("hex")}-${this.created}`,
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
  async channels(
    _context: ScopedTenantContext,
    method: OnlinePaymentMethod,
  ): Promise<PaymentChannel[]> {
    return method === "va" ? [...BANKS] : [];
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
type Part = {
  id: string;
  amountIdr: number;
  shareIndex: number;
  status: string;
};

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
    split: (parts: number, idempotencyKey = randomUUID()) =>
      auth(client.post(`${base}/splits`)).send({
        method: "equal",
        parts,
        idempotencyKey,
      }),
    paySplit: (
      billSplitId: string,
      opts: { key?: string; method?: "qris" | "va"; secret?: string } = {},
    ) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method: opts.method ?? "qris",
        payerSecret: opts.secret ?? secretFor(billSplitId),
        ...(opts.method === "va" ? { bankCode: "bmri" } : {}),
        idempotencyKey: opts.key ?? randomUUID(),
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

/** An order split into `count` equal parts. */
async function splitOrder(count: number) {
  await freshWorld();
  const guest = await seatAtNewTable();
  const { orderId, totalIdr } = await placeOrder(guest);
  const split = await as(guest).split(count);
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as Part[];
  expect(parts).toHaveLength(count);
  return { guest, orderId, totalIdr, parts };
}

async function openCode(
  guest: Guest,
  part: Part,
  method?: "qris" | "va",
): Promise<string> {
  const response = await as(guest).paySplit(part.id, { method });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.status).toBe("pending");
  return response.body.data.id as string;
}

/**
 * The part's code lapses. Since legend-yhia9 a QRIS stays collectible (its hold
 * freezes the bill, so no second QR opens) until the provider itself answers
 * expired about it: the test gateway does, and the hold check job runs.
 */
async function lapseCode(intentId: string) {
  await owner.query(
    // The gateway double answers `expired` for it (below): the provider's
    // final proof, which is what SO-885 requires before a code counts as dead.
    "UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '1 hour', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, intentId],
  );
  const { rows } = await owner.query<{ provider_ref: string }>(
    "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, intentId],
  );
  gateway.expiredRefs.add(rows[0]!.provider_ref);
  await runPosQrisHoldCheckJob(contextOf(tenant.tenantId), new Date(), {
    force: true,
  });
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

/** Open a code for the part, settle it and consume the paid event. */
async function payPart(guest: Guest, part: Part) {
  const intentId = await openCode(guest, part);
  await settle(intentId, part.amountIdr);
  const event = await onlyPaidEvent(intentId);
  await deliverToQr(event);
  return { intentId, event };
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

async function orderPaidCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
        AND event->'payload'->>'orderId' = $2`,
    [tenant.tenantId, orderId],
  );
  return Number(rows[0]!.n);
}

type SplitRow = {
  id: string;
  status: string;
  amount_idr: string;
  paid_at: string | null;
  claim_token_hash: string | null;
  payment_intent_id: string | null;
};

async function splitRows(orderId: string): Promise<SplitRow[]> {
  const { rows } = await owner.query<SplitRow>(
    `SELECT id, status, amount_idr::text, paid_at::text, claim_token_hash, payment_intent_id
       FROM bill_splits WHERE tenant_id = $1 AND order_id = $2::uuid
      ORDER BY created_at, share_index`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows;
}

async function splitRow(partId: string): Promise<SplitRow> {
  const { rows } = await owner.query<SplitRow>(
    `SELECT id, status, amount_idr::text, paid_at::text, claim_token_hash, payment_intent_id
       FROM bill_splits WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, partId],
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

// ---- fresh world per case ---------------------------------------------------

async function freshWorld(): Promise<void> {
  ids = newIds();
  tenant = await createIsolatedTenant(`bsp-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Split Pay Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-BSP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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

describe("Split bill payment (legend-ms3, ORD-06)", () => {
  it("ORD-06-PAY-01 two parts hold their own live code at the same time", async () => {
    const w = await splitOrder(3);
    const [p0, p1] = w.parts as [Part, Part];

    // One QRIS at a time per bill (legend-yhia9 D-01): the second part pays
    // by virtual account, so both codes are live together.
    const a = await as(w.guest).paySplit(p0.id);
    const b = await as(w.guest).paySplit(p1.id, { method: "va" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(a.body.data).toMatchObject({
      status: "pending",
      amountIdr: p0.amountIdr,
      target: { kind: "split", billSplitId: p0.id },
    });
    expect(b.body.data).toMatchObject({
      status: "pending",
      amountIdr: p1.amountIdr,
      target: { kind: "split", billSplitId: p1.id },
    });
    expect(await intentStatus(a.body.data.id)).toBe("pending");
    expect(await intentStatus(b.body.data.id)).toBe("pending");
    // A part's code never becomes the order's payer code.
    expect((await orderRow(w.orderId)).payment_intent_id).toBeNull();
    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
  });

  it("ORD-06-PAY-02 choosing another method for a part replaces only that part's code once the old one has lapsed", async () => {
    const w = await splitOrder(3);
    const [p0, p1] = w.parts as [Part, Part];
    const qris0 = await openCode(w.guest, p0);
    const qris1 = await openCode(w.guest, p1, "va");

    // While the code is live the switch is refused (SPLIT_CODE_ACTIVE).
    // Reconciliation resolves the lapsed code as expired, past the
    // late-payment grace: then the switch is allowed.
    await lapseCode(qris0);

    const va0 = await as(w.guest).paySplit(p0.id, { method: "va" });
    expect(va0.status, JSON.stringify(va0.body)).toBe(201);
    expect(va0.body.data).toMatchObject({
      method: "va",
      bankCode: "bmri",
      status: "pending",
      amountIdr: p0.amountIdr,
    });
    expect(va0.body.data.id).not.toBe(qris0);

    expect(await intentStatus(qris0)).not.toBe("pending");
    expect(await intentStatus(qris1)).toBe("pending");
    expect(await intentStatus(va0.body.data.id)).toBe("pending");
    expect((await splitRow(p0.id)).payment_intent_id).toBe(va0.body.data.id);
    expect((await splitRow(p1.id)).payment_intent_id).toBe(qris1);
  });

  it("ORD-06-PAY-03 a part larger than what is still owed is refused with 409 CONFLICT", async () => {
    const w = await splitOrder(2);
    const [p0, p1] = w.parts as [Part, Part];
    await payPart(w.guest, p0);

    await owner.query(
      "UPDATE bill_splits SET amount_idr = $3 WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, p1.id, w.totalIdr],
    );
    const refused = await as(w.guest).paySplit(p1.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
    expect((await splitRow(p1.id)).payment_intent_id).toBeNull();
  });

  it("ORD-06-PAY-04 the same idempotency key on another part is refused with IDEMPOTENCY_KEY_REUSED", async () => {
    const w = await splitOrder(2);
    const [p0, p1] = w.parts as [Part, Part];
    const key = randomUUID();

    expect((await as(w.guest).paySplit(p0.id, { key })).status).toBe(201);
    const reused = await as(w.guest).paySplit(p1.id, { key });
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await splitRow(p1.id)).payment_intent_id).toBeNull();
  });

  it("ORD-06-PAY-05 the same key on the same part twice returns one code", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const key = randomUUID();

    const first = await as(w.guest).paySplit(p0.id, { key });
    const second = await as(w.guest).paySplit(p0.id, { key });
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);
    expect(second.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_intents
        WHERE tenant_id = $1 AND bill_split_id = $2`,
      [tenant.tenantId, p0.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("ORD-06-PAY-06 the order fires only when the last part is paid", async () => {
    const w = await splitOrder(3);
    const [p0, p1, p2] = w.parts as [Part, Part, Part];

    await payPart(w.guest, p0);
    await payPart(w.guest, p1);
    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
    expect(await orderPaidCount(w.orderId)).toBe(0);
    expect((await splitRow(p0.id)).status).toBe("paid");
    expect((await splitRow(p1.id)).status).toBe("paid");
    expect((await splitRow(p2.id)).status).toBe("pending");

    await payPart(w.guest, p2);
    expect((await orderRow(w.orderId)).status).toBe("sent");
    expect(await orderPaidCount(w.orderId)).toBe(1);
    expect((await splitRows(w.orderId)).map((row) => row.status)).toEqual([
      "paid",
      "paid",
      "paid",
    ]);
  });

  it("ORD-06-PAY-07 replaying a part's paid event changes nothing", async () => {
    const w = await splitOrder(2);
    const [p0, p1] = w.parts as [Part, Part];

    const first = await payPart(w.guest, p0);
    const before = await splitRows(w.orderId);
    await deliverToQr(first.event);
    await deliverToQr(first.event);
    expect(await splitRows(w.orderId)).toEqual(before);
    expect((await orderRow(w.orderId)).status).toBe("awaiting_payment");
    expect(await orderPaidCount(w.orderId)).toBe(0);

    const last = await payPart(w.guest, p1);
    const fired = await splitRows(w.orderId);
    await deliverToQr(last.event);
    await deliverToQr(first.event);
    expect(await splitRows(w.orderId)).toEqual(fired);
    expect((await orderRow(w.orderId)).status).toBe("sent");
    expect(await orderPaidCount(w.orderId)).toBe(1);
  });

  it("ORD-06-PAY-08 paying a voided part is refused with 409 CONFLICT", async () => {
    const w = await splitOrder(2);
    const oldPart = w.parts[0]!;

    const resplit = await as(w.guest).split(3);
    expect(resplit.status, JSON.stringify(resplit.body)).toBe(201);
    expect((await splitRow(oldPart.id)).status).toBe("voided");

    const refused = await as(w.guest).paySplit(oldPart.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CONFLICT");
  });

  it("ORD-06-PAY-09 a paid part cannot be re-split: 409 SPLIT_LOCKED, parts unchanged", async () => {
    const w = await splitOrder(2);
    await payPart(w.guest, w.parts[0]!);
    const before = await splitRows(w.orderId);

    const refused = await as(w.guest).split(3);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("SPLIT_LOCKED");
    expect(await splitRows(w.orderId)).toEqual(before);
    expect(before.map((row) => row.status)).toEqual(["paid", "pending"]);
  });

  // Fix round 2, R2-a. Assumption: "live code" = the part's pending code; asking
  // for another method while it is live is refused (one payable code per part),
  // and the live code and the part's row stay as they were.
  it("ORD-06-PAY-10 another method while the part's code is live is refused with 409 SPLIT_CODE_ACTIVE", async () => {
    const w = await splitOrder(3);
    const [p0] = w.parts as [Part, Part, Part];
    const qris0 = await openCode(w.guest, p0);

    const refused = await as(w.guest).paySplit(p0.id, { method: "va" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("SPLIT_CODE_ACTIVE");
    expect(await intentStatus(qris0)).toBe("pending");
    expect((await splitRow(p0.id)).payment_intent_id).toBe(qris0);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_intents
        WHERE tenant_id = $1 AND bill_split_id = $2`,
      [tenant.tenantId, p0.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  // Fix round 2, R2-b. Assumption: a new pay request for an already paid part
  // answers 200/201 with the paid intent (same id, status "paid").
  it("ORD-06-PAY-11 a paid part records its paying intent and a new pay request returns that paid intent", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const { intentId } = await payPart(w.guest, p0);

    const row = await splitRow(p0.id);
    expect(row.status).toBe("paid");
    expect(row.payment_intent_id).toBe(intentId);

    const again = await as(w.guest).paySplit(p0.id);
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.id).toBe(intentId);
    expect(again.body.data.status).toBe("paid");
    expect((await splitRow(p0.id)).payment_intent_id).toBe(intentId);
  });

  it("ORD-06-PAY-12 two parts settled before either event is consumed: both end paid with a claim token, none voided", async () => {
    const w = await splitOrder(2);
    const [p0, p1] = w.parts as [Part, Part];
    const code0 = await openCode(w.guest, p0);
    const code1 = await openCode(w.guest, p1, "va");
    await settle(code0, p0.amountIdr);
    await settle(code1, p1.amountIdr, "va");
    const event0 = await onlyPaidEvent(code0);
    const event1 = await onlyPaidEvent(code1);

    await deliverToQr(event0);
    await deliverToQr(event1);

    expect((await orderRow(w.orderId)).status).toBe("sent");
    expect(await orderPaidCount(w.orderId)).toBe(1);
    const rows = await splitRows(w.orderId);
    expect(rows.map((row) => row.status)).toEqual(["paid", "paid"]);
    for (const row of rows) {
      expect(row.claim_token_hash).not.toBeNull();
      expect(row.paid_at).not.toBeNull();
    }
    expect(rows.map((row) => row.payment_intent_id)).toEqual([code0, code1]);
  });
});

// legend-r77pq: the part ids and intent ids are visible to the whole table, so
// the payer secret (only its hash is stored) is what makes a guest the payer of
// a part. Everyone shares the table's session credential; "guest B" is a
// different secret on the same session.
describe("Split part payer secret (legend-r77pq)", () => {
  async function payerHash(partId: string): Promise<string | null> {
    const { rows } = await owner.query<{ payer_secret_hash: string | null }>(
      "SELECT payer_secret_hash FROM bill_splits WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, partId],
    );
    return rows[0]!.payer_secret_hash;
  }

  async function intentCount(partId: string): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM payment_intents
        WHERE tenant_id = $1 AND bill_split_id = $2`,
      [tenant.tenantId, partId],
    );
    return Number(rows[0]!.n);
  }

  it("PAYER-SECRET-01 another guest opening a pending part gets 409 SPLIT_CODE_ACTIVE and never the intent id", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const mine = await openCode(w.guest, p0);

    const other = await as(w.guest).paySplit(p0.id, {
      secret: newPayerSecret(),
    });
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(other.body.error.code).toBe("SPLIT_CODE_ACTIVE");
    expect(JSON.stringify(other.body)).not.toContain(mine);
    expect(other.body.data).toBeUndefined();
    expect(await intentCount(p0.id)).toBe(1);
  });

  it("PAYER-SECRET-02 another guest opening a paid part gets 409 SPLIT_PART_PAID and never the intent id", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const { intentId } = await payPart(w.guest, p0);

    const other = await as(w.guest).paySplit(p0.id, {
      secret: newPayerSecret(),
    });
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(other.body.error.code).toBe("SPLIT_PART_PAID");
    expect(JSON.stringify(other.body)).not.toContain(intentId);
    expect(other.body.data).toBeUndefined();
    expect(await intentCount(p0.id)).toBe(1);
  });

  it("PAYER-SECRET-03 the first intent stores only the hash; the same payer retrying gets the same intent", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const first = await as(w.guest).paySplit(p0.id);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const hash = await payerHash(p0.id);
    expect(hash).toBe(
      createHash("sha256").update(secretFor(p0.id)).digest("hex"),
    );
    expect(hash).not.toContain("ps_");

    const retry = await as(w.guest).paySplit(p0.id);
    expect(retry.status, JSON.stringify(retry.body)).toBeLessThan(300);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(await intentCount(p0.id)).toBe(1);
  });

  it("PAYER-SECRET-04 the raw secret is nowhere in the idempotency record", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    expect((await as(w.guest).paySplit(p0.id)).status).toBe(201);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM qr_order_idempotency
        WHERE tenant_id = $1 AND (response::text LIKE $2 OR fingerprint LIKE $2 OR key LIKE $2)`,
      [tenant.tenantId, `%${secretFor(p0.id)}%`],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("PAYER-SECRET-05 once the old code is dead another guest takes the part over: the hash changes, the old payer is out", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const oldCode = await openCode(w.guest, p0);
    const oldHash = await payerHash(p0.id);
    await lapseCode(oldCode);

    const newSecret = newPayerSecret();
    const taken = await as(w.guest).paySplit(p0.id, { secret: newSecret });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect(taken.body.data.id).not.toBe(oldCode);
    const newHash = await payerHash(p0.id);
    expect(newHash).toBe(createHash("sha256").update(newSecret).digest("hex"));
    expect(newHash).not.toBe(oldHash);
    expect((await splitRow(p0.id)).payment_intent_id).toBe(taken.body.data.id);

    // The old payer now looks like any other guest: the new code is live.
    const old = await as(w.guest).paySplit(p0.id);
    expect(old.status, JSON.stringify(old.body)).toBe(409);
    expect(old.body.error.code).toBe("SPLIT_CODE_ACTIVE");
    expect(JSON.stringify(old.body)).not.toContain(taken.body.data.id);
  });

  it("PAYER-SECRET-07 an old intent settling after a takeover pays the part and clears the payer hash: no secret opens the claim", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const secretA = secretFor(p0.id);
    // Virtual-account codes: a lapsed QRIS stays collectible until the
    // provider proves it dead (legend-yhia9) and its late money is then parked
    // (D-07), so the "old code pays after a takeover" case is a VA one.
    const intentA = await openCode(w.guest, p0, "va");
    await lapseCode(intentA);
    const secretB = newPayerSecret();
    const taken = await as(w.guest).paySplit(p0.id, {
      secret: secretB,
      method: "va",
    });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    expect(taken.body.data.id).not.toBe(intentA);

    await settle(intentA, p0.amountIdr, "va");
    await deliverToQr(await onlyPaidEvent(intentA));

    const row = await splitRow(p0.id);
    expect(row.status).toBe("paid");
    expect(row.payment_intent_id).toBe(intentA);
    expect(await payerHash(p0.id)).toBeNull();

    const client = agent(app);
    for (const payerSecret of [secretB, secretA]) {
      const claim = await client
        .post(`/api/table-sessions/${w.guest.sessionId}/splits/${p0.id}/claim`)
        .set("Host", tenant.hostname)
        .set("Authorization", `Bearer ${w.guest.token}`)
        .set(originHeader)
        .send({ payerSecret });
      expect(claim.status, JSON.stringify(claim.body)).toBe(404);
    }
  });

  it("PAYER-SECRET-08 a part without a payer hash but with a live code (orphan intent) answers 409 SPLIT_CODE_ACTIVE to anyone, no intent returned", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const orphan = await openCode(w.guest, p0);
    await owner.query(
      "UPDATE bill_splits SET payer_secret_hash = NULL, payment_intent_id = NULL WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, p0.id],
    );

    for (const secret of [newPayerSecret(), secretFor(p0.id)]) {
      const response = await as(w.guest).paySplit(p0.id, { secret });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error.code).toBe("SPLIT_CODE_ACTIVE");
      expect(JSON.stringify(response.body)).not.toContain(orphan);
      expect(response.body.data).toBeUndefined();
    }
    expect(await intentCount(p0.id)).toBe(1);
    expect(await payerHash(p0.id)).toBeNull();
  });

  it("PAYER-SECRET-06 a split payment without payerSecret is a validation error (422), no intent", async () => {
    const w = await splitOrder(2);
    const [p0] = w.parts as [Part, Part];
    const response = await agent(app)
      .post(`/api/table-sessions/${w.guest.sessionId}/payments`)
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${w.guest.token}`)
      .set(originHeader)
      .send({
        target: { kind: "split", billSplitId: p0.id },
        method: "qris",
        idempotencyKey: randomUUID(),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await intentCount(p0.id)).toBe(0);
    expect(await payerHash(p0.id)).toBeNull();
  });
});
