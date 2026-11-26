// WS-13 acceptance, Alur A (pelanggan memesan, bayar di muka) and Alur Y (item
// gagal setelah dibayar). Source of truth: docs/PRD.md §4 Alur A (baris ~1140)
// and Alur Y, criteria ORD-01/02/03/06/08 and PAY-02/03/04. Written as stories
// (actor -> action -> result) over the real Express app and PostgreSQL.
//
// Assumptions where the PRD is silent:
// - The outbox worker is not running in tests, so "the verified webhook" is
//   the WS-05 `confirmPayment(verified_webhook)` plus delivery of the resulting
//   `payment.paid` event to the QR order consumer (same as qr-order-api.test.ts).
//   The real signed DOIT webhook + polling is the PENDING-BRANCH block below.
// - Guest payment methods in the QR session are QRIS (and e-wallet via QRIS);
//   Virtual Account is paid on the payment-link page (PRD "Payment gateway").
// - Online card is P1 (PRD baris 223): skipped as PENDING-DECISION.
// - Split bill: the endpoint is POST /api/table-sessions/:id/splits and a share
//   is paid with target {kind:"split"} (shared contract qr-order/endpoints.ts).
// - Alur Y endpoints follow the shared contract (qr-order/endpoints.ts):
//   POST /api/order-items/:id/issues, GET /api/table-sessions/:id/order-issues,
//   GET /api/order-issues/:id/options, POST /api/order-issues/:id/customer-choice,
//   POST /api/order-issues/:id/resolve. A report carries `reason` (enum) and
//   `reasonNote`. The guest may swap only to a menu costing the same or less
//   than the failed line (dearer: 422); a cheaper swap credits the difference.
//   The split routes do not exist yet: ORD-06 stays PENDING-CARD.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { ZodError } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../../app.ts";
import { db } from "../../db/index.ts";
import { withTenant } from "../../db/tenant.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentStatus,
  type PaymentGatewayPort,
} from "../../services/payment-gateway.ts";
import {
  confirmPayment,
  createPaymentLink,
} from "../../services/payment.service.ts";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../../services/platform-integration.service.ts";
import { unallocatedFundsOfIntent } from "../../services/payment-unallocated.service.ts";
import { deliverQrOrderPaymentEvent } from "../../services/qr-order-payment.ts";
import { qrOrderSettlementLookup } from "../../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../../services/table-session.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "../helpers.ts";
import { secretFor } from "../payer-secret-helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "../floor-test-helpers.ts";
import { itUntilBuilt } from "./pending-branch.ts";

let app: Express;
let tenant: IsolatedTenant;
let floorStaff: Staff;
let kitchenStaff: Staff;
let headers: { Host: string };

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  roti: randomUUID(),
  habis: randomUUID(),
  priceList: randomUUID(),
  group: randomUUID(),
  extraShot: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
  kitchenRole: randomUUID(),
};
const PRICES = { kopi: 25_000, roti: 18_000, extraShot: 5_000 } as const;
/** Kopi x2 + extra shot, Roti x1 = 78.000; +5% service; +10% PBJT = 90.090. */
const CART_TOTAL = 90_090;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

/** Gateway test double (the DOIT port); `settle` models the provider paying. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  lastCreated: string | null = null;
  private readonly payments = new Map<string, GatewayPaymentStatus>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const providerRef = `AZA-${randomBytes(6).toString("hex")}-${this.created}`;
    this.lastCreated = providerRef;
    this.payments.set(providerRef, {
      status: "pending",
      providerRef,
      amountIdr: input.amountIdr,
    });
    const instructions: PaymentInstructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: input.channelCode ?? "bca",
            channelName: "BCA",
            virtualAccountNumber: "8808123456789012",
          }
        : { method: "qris", qrPayload: "00020101021226AZAQR", issuer: null };
    return { providerRef, instructions, expiresAt: input.expiresAt };
  }
  async getStatus(input: { providerRef: string }) {
    return (
      this.payments.get(input.providerRef) ?? {
        status: "pending" as const,
        providerRef: input.providerRef,
        amountIdr: null,
      }
    );
  }
  async channels(_context: ScopedTenantContext, method: string) {
    return method === "qris" ? [] : [{ code: "bca", name: "BCA" }];
  }
  settle(providerRef: string, amountIdr?: number) {
    const found = this.payments.get(providerRef);
    if (!found) throw new Error(`No fake payment ${providerRef}`);
    this.payments.set(providerRef, {
      ...found,
      status: "paid",
      amountIdr: amountIdr ?? found.amountIdr,
    });
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

function tenantContext(tenantId: string): ScopedTenantContext {
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

async function newTable(paymentMode: "pay_first" | "open_bill" = "pay_first") {
  const zone = await createZone(
    floorStaff.client,
    { paymentMode, serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(
    floorStaff.client,
    { zoneId: zone.id },
    headers,
  );
  const qr = await issueQr(floorStaff.client, table.id, headers);
  return { zone, table, qrToken: qr.token as string };
}

async function seat(qrToken: string, pax = 2): Promise<Guest> {
  const response = await scan(app, {
    token: qrToken,
    pax,
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
    view: () => auth(client.get(base)),
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    quote: () => auth(client.post(`${base}/quote`)).send({}),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
    bill: () => auth(client.get(base + "/bill")),
    splits: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/splits`)).send(body),
    pay: (target: Record<string, unknown>, key = randomUUID()) =>
      auth(client.post(`${base}/payments`)).send({
        target,
        method: "qris",
        ...(target.kind === "split"
          ? { payerSecret: secretFor(String(target.billSplitId)) }
          : {}),
        idempotencyKey: key,
      }),
    payment: (paymentId: string) =>
      auth(client.get(`${base}/payments/${paymentId}`)),
    issues: () => auth(client.get(`${base}/order-issues`)),
    issueOptions: (issueId: string) =>
      auth(client.get(`/api/order-issues/${issueId}/options`)),
    choose: (issueId: string, body: Record<string, unknown>) =>
      auth(client.post(`/api/order-issues/${issueId}/customer-choice`)).send(
        body,
      ),
  };
}

async function fillStandardCart(guest: Guest): Promise<number> {
  const first = await as(guest).add({
    menuItemId: ids.kopi,
    quantity: 2,
    modifierIds: [ids.extraShot],
    expectedCartVersion: 0,
  });
  expect(first.status).toBe(201);
  const second = await as(guest).add({
    menuItemId: ids.roti,
    quantity: 1,
    expectedCartVersion: first.body.data.cart.version,
  });
  expect(second.status).toBe(201);
  return second.body.data.cart.version as number;
}

async function placeOrder(guest: Guest) {
  const version = await fillStandardCart(guest);
  const placed = await as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status).toBe(201);
  return placed.body.data.order as {
    id: string;
    status: string;
    items: { id: string; menuItemId: string; fireStatus: string }[];
  };
}

async function outboxRows(name: string, field: string, value: string) {
  const { rows } = await owner.query<{ event: unknown; created_at: Date }>(
    `SELECT event, created_at FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>$3 = $4
     ORDER BY created_at, id`,
    [tenant.tenantId, name, field, value],
  );
  return rows.map((row) => ({
    event: eventEnvelopeSchema.parse(row.event),
    createdAt: row.created_at,
  }));
}

/** The verified webhook settles the intent; its payment.paid reaches the order. */
async function payVerified(intentId: string, amountIdr: number) {
  await confirmPayment(tenantContext(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const [row] = await outboxRows("payment.paid", "intentId", intentId);
  expect(row).toBeDefined();
  const context = tenantContext(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, row!.event, row!.event.id, tx),
  );
}

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  tenant = await createIsolatedTenant(`aza-${randomUUID().slice(0, 6)}`);
  floorStaff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };

  // A kitchen supervisor: marks failed items and resolves them (PRD Alur Y).
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Dapur Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.kitchenRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "order.recovery.handle",
        "order.apology_voucher.issue",
        "kds.ticket.process",
        "kds.remake_comp.record",
        "floor.table.view",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Supervisor Dapur");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.kitchenRole],
  );
  kitchenStaff = { client, userId, email: "" };

  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Alur A Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.roti, "Roti Bakar"],
      [ids.habis, "Kue Habis"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [itemId, price] of [
      [ids.kopi, PRICES.kopi],
      [ids.roti, PRICES.roti],
      [ids.habis, 15_000],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
      );
    await client.query(
      `INSERT INTO modifier_groups (id, tenant_id, name, min_select, max_select)
       VALUES ($1, $2, 'Ekstra', 0, 1)`,
      [ids.group, tenant.tenantId],
    );
    await client.query(
      `INSERT INTO modifiers (id, tenant_id, group_id, name, price_idr)
       VALUES ($1, $2, $3, 'Extra shot', $4)`,
      [ids.extraShot, tenant.tenantId, ids.group, PRICES.extraShot],
    );
    await client.query(
      `INSERT INTO menu_item_modifier_groups (tenant_id, menu_item_id, group_id, sort_order)
       VALUES ($1, $2, $3, 0)`,
      [tenant.tenantId, ids.kopi, ids.group],
    );
    await client.query(
      `INSERT INTO item_availability (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, status)
       VALUES ($1, $2, $3, $4, '[]', NULL, 'sold_out')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, ids.habis],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, tenant.tenantId, floorStaff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-AZA', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, floorStaff.userId],
    );
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // The isolated tenant stays in the disposable database (audit rows are
  // append-only); give it a valid creator like the other floor suites do.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await cleanupSeededPayments();
  await owner.end();
});

// --------------------------------------------------------------------------
// Alur A: scan QR -> sesi meja -> pesan -> bayar QRIS -> dapur
// --------------------------------------------------------------------------

describe("Alur A pelanggan memesan dengan bayar di muka", () => {
  it("ORD-01 tamu tanpa login memindai QR, membuka sesi meja, dan tamu lain bergabung", async () => {
    const { qrToken, table } = await newTable();
    const first = await seat(qrToken, 3);
    const view = await as(first).view();
    expect(view.status).toBe(200);
    expect(view.body.data.session.tableId).toBe(table.id);
    expect(view.body.data.session.pax).toBe(3);
    expect(view.body.data.cart.lines).toHaveLength(0);

    // A second phone scanning the same QR joins the same session.
    const second = await seat(qrToken, 3);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("ORD-05 ORD-03 menu habis ditolak, harga dari klien ditolak, total dihitung server", async () => {
    const guest = await seat((await newTable()).qrToken);

    const soldOut = await as(guest).add({
      menuItemId: ids.habis,
      quantity: 1,
      expectedCartVersion: 0,
    });
    expect(soldOut.status).toBe(409);

    const forged = await as(guest).add({
      menuItemId: ids.kopi,
      quantity: 1,
      expectedCartVersion: 0,
      unitPriceIdr: 1,
    });
    expect(forged.status).toBe(422);

    await fillStandardCart(guest);
    const quote = await as(guest).quote();
    expect(quote.status).toBe(200);
    expect(quote.body.data).toMatchObject({
      subtotalIdr: 78_000,
      taxIdr: 8_190,
      totalIdr: CART_TOTAL,
    });
    expect(quote.body.data.serviceCharge.amountIdr).toBe(3_900);
  });

  it("ORD-02 PAY-02 PAY-03 pesanan ditahan sampai webhook terverifikasi, lalu masuk dapur sekali saja", async () => {
    const guest = await seat((await newTable()).qrToken);
    const order = await placeOrder(guest);

    // Before payment nothing is sent to the kitchen.
    expect(order.status).toBe("awaiting_payment");
    expect(order.items.every((item) => item.fireStatus === "held")).toBe(true);

    // Step 5: the server creates a QRIS payment intent for the whole bill.
    const payment = await as(guest).pay({ kind: "order", orderId: order.id });
    expect(payment.status).toBe(201);
    expect(payment.body.data).toMatchObject({
      method: "qris",
      amountIdr: CART_TOTAL,
      status: "pending",
    });
    expect(payment.body.data.qrisPayload).toEqual(expect.any(String));
    const intentId = payment.body.data.id as string;

    // PAY-02: a browser coming back from the payment page proves nothing.
    await expect(
      confirmPayment(
        tenantContext(tenant.tenantId),
        intentId,
        {
          source: "browser_redirect" as never,
          method: "qris",
          amountIdr: CART_TOTAL,
          providerRef: "REDIRECT-1",
          at: new Date().toISOString(),
        },
        { type: "system" },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues.some((issue) => issue.path[0] === "source"),
    );
    const polled = await as(guest).payment(intentId);
    expect(polled.body.data.status).toBe("pending");
    expect((await as(guest).view()).body.data.orders[0].status).toBe(
      "awaiting_payment",
    );

    // Step 6: the verified webhook settles it; the order goes to the kitchen.
    expect(await payVerified(intentId, CART_TOTAL)).toBe(true);
    const fired = (await as(guest).view()).body.data.orders[0];
    expect(fired.status).toBe("sent");
    expect(
      fired.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "fired",
      ),
    ).toBe(true);
    expect((await as(guest).payment(intentId)).body.data.status).toBe("paid");

    // PAY-03: the same delivery again changes nothing (no second settlement).
    const before = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenant.tenantId, intentId],
    );
    const [paidEvent] = await outboxRows("payment.paid", "intentId", intentId);
    const context = tenantContext(tenant.tenantId);
    expect(
      await withTenant(db, context, (tx) =>
        deliverQrOrderPaymentEvent(
          context,
          paidEvent!.event,
          paidEvent!.event.id,
          tx,
        ),
      ),
    ).toBe(false);
    const after = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenant.tenantId, intentId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const bill = await as(guest).bill();
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: CART_TOTAL,
      paidIdr: CART_TOTAL,
      outstandingIdr: 0,
    });
  });

  itUntilBuilt(
    "legend-ms3",
    "ORD-06 split bill: bagian bulat dan jumlahnya persis sama dengan total tagihan",
    async () => {
      const guest = await seat((await newTable()).qrToken, 4);
      await placeOrder(guest);

      // 90.090 / 4 is not a whole number of rupiah: rounding must not leak.
      const split = await as(guest).splits({
        method: "equal",
        parts: 4,
        idempotencyKey: randomUUID(),
      });
      expect(split.status).toBe(201);
      const shares = split.body.data.splits as {
        id: string;
        amountIdr: number;
      }[];
      expect(shares).toHaveLength(4);
      expect(shares.every((share) => Number.isInteger(share.amountIdr))).toBe(
        true,
      );
      expect(shares.reduce((sum, share) => sum + share.amountIdr, 0)).toBe(
        CART_TOTAL,
      );
      const amounts = shares.map((share) => share.amountIdr);
      expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(
        1,
      );

      // Each guest pays only their own share from their own phone.
      const mine = await as(guest).pay({
        kind: "split",
        billSplitId: shares[0]!.id,
      });
      expect(mine.status).toBe(201);
      expect(mine.body.data.amountIdr).toBe(shares[0]!.amountIdr);
      // One share paid does not release the order (assumption: the order is fired
      // when the whole bill is covered).
      expect((await as(guest).view()).body.data.orders[0].status).toBe(
        "awaiting_payment",
      );
    },
  );

  // PRD baris 223: online card through the gateway is P1.
  it.skip("[PENDING-DECISION card-online] pelanggan membayar dengan kartu online lewat gateway", () => {});
});

// --------------------------------------------------------------------------
// Alur A step 5: halaman payment link, QRIS dan VA, PAY-02/03/04
// --------------------------------------------------------------------------

const seededOutlet = cafeLegendAccessFixtures.outletIds.bandung as OutletId;
const createdLinkIds: string[] = [];
let manager: Staff | null = null;

function seededContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [seededOutlet] },
  );
}

/** Rp125.000 + 5% service + 10% PBJT, as the payment contract fixture. */
async function openLink() {
  const opened = await createPaymentLink(
    seededContext(),
    {
      outletId: seededOutlet,
      reference: `AZA-${randomBytes(4).toString("hex")}`,
      tableLabel: "A03",
      pax: 3,
      subtotalIdr: 125_000,
      discountIdr: 0,
      serviceChargeIdr: 6_250,
      taxIdr: 13_125,
      roundingIdr: 0,
      totalIdr: 144_375,
      returnPath: "/t/v1.abc",
    },
    "00000000-0000-4000-8000-000000000001",
  );
  createdLinkIds.push(opened.linkId);
  return opened;
}

async function createIntent(token: string, method: "qris" | "va") {
  return agent(app)
    .post(`/api/payments/links/${token}/intents`)
    .send({
      method,
      channelCode: method === "va" ? "bca" : null,
      idempotencyKey: `aza-${randomUUID()}`,
    });
}

async function cleanupSeededPayments() {
  if (createdLinkIds.length === 0) return;
  // Best effort: approval and refund rows made by the PAY-04 story may pin
  // some rows; the seeded tenant tolerates leftovers (unique references).
  try {
    const intents =
      "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])";
    const args = [seededTenantId, createdLinkIds];
    await owner.query(
      `DELETE FROM payment_refunds WHERE unallocated_fund_id IN (SELECT id FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents}))`,
      args,
    );
    await owner.query(
      `DELETE FROM payment_evidence WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      args,
    );
    await owner.query(
      `DELETE FROM payment_unallocated_funds WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      args,
    );
    await owner.query(
      `DELETE FROM gateway_webhook_events WHERE tenant_id = $1 AND payment_intent_id IN (${intents})`,
      args,
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      args,
    );
    await owner.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      args,
    );
  } catch {
    // leftovers are unique per run
  }
}

describe("Alur A langkah 5 payment link: QRIS dan VA", () => {
  it("PAY-02 intent QRIS dan VA dibuat server; pelunasan hanya dari bukti terverifikasi", async () => {
    const { token } = await openLink();

    const view = await agent(app).get(`/api/payments/links/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.bill.totals.outstandingIdr).toBe(144_375);

    // Amount is never taken from the client. The key is valid, so the 422 can
    // only come from the injected amountIdr; the same key without it succeeds.
    const key = `aza-${randomUUID()}`;
    const injected = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({
        method: "qris",
        channelCode: null,
        idempotencyKey: key,
        amountIdr: 1,
      });
    expect(injected.status).toBe(422);
    expect(injected.body.error.code).toBe("VALIDATION_ERROR");

    const qris = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: key });
    expect(qris.status).toBe(201);
    expect(qris.body.data.instructions.method).toBe("qris");
    expect(qris.body.data.amountIdr).toBe(144_375);

    // A live QRIS code refuses a second code on the link (legend-osqou.41):
    // the VA waits until the provider has proven the QRIS code dead.
    const refused = await createIntent(token, "va");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("ORDER_CODE_ACTIVE");
    await owner.query(
      "UPDATE payment_intents SET status = 'expired', provider_final_at = now() WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, qris.body.data.id],
    );
    const va = await createIntent(token, "va");
    expect(va.status).toBe(201);
    expect(va.body.data.instructions).toMatchObject({
      method: "va",
      virtualAccountNumber: expect.any(String),
    });
    expect(va.body.data.amountIdr).toBe(144_375);
    const vaRef = gateway.lastCreated!;

    // Redirect / no evidence: still pending, nothing paid.
    const pending = await agent(app).get(
      `/api/payments/links/${token}/intents/${va.body.data.id}`,
    );
    expect(pending.body.data.status).toBe("pending");
    expect(pending.body.data.paidAt).toBeNull();

    // The gateway status check is a valid confirmation.
    gateway.settle(vaRef);
    const paid = await agent(app).get(
      `/api/payments/links/${token}/intents/${va.body.data.id}`,
    );
    expect(paid.body.data.status).toBe("paid");
    const link = await agent(app).get(`/api/payments/links/${token}`);
    expect(link.body.data.bill.totals).toMatchObject({
      paidIdr: 144_375,
      outstandingIdr: 0,
    });
  });

  it("PAY-03 pengiriman bukti yang sama dua kali tidak melunasi dua kali", async () => {
    const { token, linkId } = await openLink();
    const created = await createIntent(token, "qris");
    const intentId = created.body.data.id as string;
    const evidence = {
      source: "verified_webhook" as const,
      method: "qris" as const,
      amountIdr: 144_375,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    };
    await confirmPayment(seededContext(), intentId, evidence);
    await confirmPayment(seededContext(), intentId, evidence);

    const { rows } = await owner.query<{ paid: string; n: string }>(
      `SELECT l.paid_idr::text AS paid,
              (SELECT count(*)::text FROM payment_evidence e
               WHERE e.tenant_id = $1 AND e.payment_intent_id = $3) AS n
       FROM payment_links l WHERE l.id = $2`,
      [seededTenantId, linkId, intentId],
    );
    expect(rows[0]).toEqual({ paid: "144375", n: "1" });
    expect(
      await unallocatedFundsOfIntent(seededContext(), intentId),
    ).toHaveLength(0);
  });

  it("PAY-04 kurang bayar tidak melunasi; lebih bayar menjadi dana belum teralokasi dan diselesaikan dengan refund (approval)", async () => {
    // Underpayment never settles.
    const under = await openLink();
    const underIntent = await createIntent(under.token, "qris");
    await expect(
      confirmPayment(seededContext(), underIntent.body.data.id, {
        source: "verified_webhook",
        method: "qris",
        amountIdr: 100_000,
        providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
        at: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Double payment: the second settlement is parked, not lost.
    const { token } = await openLink();
    const created = await createIntent(token, "va");
    const intentId = created.body.data.id as string;
    for (const ref of ["VA-1", "VA-2"])
      await confirmPayment(seededContext(), intentId, {
        source: "verified_webhook",
        method: "va",
        amountIdr: 144_375,
        providerRef: `${ref}-${randomBytes(4).toString("hex")}`,
        at: new Date().toISOString(),
      });
    const funds = await unallocatedFundsOfIntent(seededContext(), intentId);
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      amountIdr: 144_375,
      reason: "double_payment",
      resolution: null,
    });

    // A finance manager resolves it by refund, which waits for approval.
    manager = await staffWithRole(app, { template: "owner", label: "Finance" });
    await verifySessionMfa(manager.email);
    const resolved = await manager.client
      .post(`/api/payments/admin/unallocated-funds/${funds[0]!.id}/resolve`)
      .set(originHeader)
      .send({
        idempotencyKey: `fund-${randomUUID()}`,
        resolution: "refund",
        note: "Kembalikan bayar ganda ke tamu",
      });
    expect(resolved.status).toBe(200);
    const refund = await owner.query<{ status: string }>(
      "SELECT status FROM payment_refunds WHERE unallocated_fund_id = $1",
      [funds[0]!.id],
    );
    expect(refund.rows).toEqual([{ status: "pending" }]);
  });
});

// Real DOIT webhook (signed) and polling arrive with ws/doit-provider.
describe("Alur A webhook DOIT asli", () => {
  // The tenant's webhook secret is seeded through the platform integration, as
  // in payment-webhook-api.test.ts of ws/doit-provider. Seeded before any
  // webhook arrives so the receiver has not cached an empty secret yet.
  const webhookSecret = `whsec-az-${randomBytes(16).toString("hex")}`;
  let integrationId = "";

  beforeAll(async () => {
    const context = tenantContext(seededTenantId);
    const actor = randomUUID();
    const created = await upsertIntegration(
      context,
      {
        outletId: null,
        provider: "doit",
        config: { baseUrl: "http://127.0.0.1:9" },
        credentials: {
          apiKey: `doit-key-${randomBytes(8).toString("hex")}`,
          webhookSecret,
        },
      },
      actor,
    );
    await setIntegrationStatus(
      context,
      created.id,
      { status: "active" },
      actor,
    );
    integrationId = created.id;
  });

  afterAll(async () => {
    if (integrationId)
      await owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
        integrationId,
      ]);
  });

  const sign = (raw: string, secret: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
  };

  it("PAY-03 webhook palsu ditolak 401 dan webhook duplikat tidak menggandakan pelunasan", async () => {
    const { token, linkId } = await openLink();
    const created = await createIntent(token, "qris");
    const intentId = created.body.data.id as string;
    const url = `/api/webhooks/payments/doit/${seededTenantId}`;
    const body = JSON.stringify({
      id: `evt_${randomBytes(6).toString("hex")}`,
      type: "payment.paid",
      created_at: new Date().toISOString(),
      data: {
        id: gateway.lastCreated,
        status: "paid",
        amount: 144_375,
        reference: intentId,
      },
    });

    const forged = await agent(app)
      .post(url)
      .set("Content-Type", "application/json")
      .set("PayBridge-Signature", sign(body, "bukan-secret-tenant"))
      .send(body);
    expect(forged.status).toBe(401);
    const untouched = await owner.query(
      "SELECT paid_idr::text FROM payment_links WHERE id = $1",
      [linkId],
    );
    expect(untouched.rows[0]?.paid_idr).toBe("0");

    // Signed with the tenant's webhook secret (seeded via the platform
    // integration, as in payment-webhook-api.test.ts of that branch).
    const send = () =>
      agent(app)
        .post(url)
        .set("Content-Type", "application/json")
        .set("PayBridge-Signature", sign(body, webhookSecret))
        .send(body);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const settled = await owner.query(
      "SELECT paid_idr::text FROM payment_links WHERE id = $1",
      [linkId],
    );
    expect(settled.rows[0]?.paid_idr).toBe("144375");
  });

  // Polling fallback (PRD D11): reading the intent status syncs a pending intent
  // with the gateway. POST .../refresh only replaces an expired code.
  it("PAY-02 polling ke gateway melunasi intent yang webhooknya terlambat", async () => {
    const { token } = await openLink();
    const created = await createIntent(token, "qris");
    gateway.settle(gateway.lastCreated!);
    const polled = await agent(app).get(
      `/api/payments/links/${token}/intents/${created.body.data.id}`,
    );
    expect(polled.status, JSON.stringify(polled.body)).toBe(200);
    expect(polled.body.data.status).toBe("paid");
  });
});

// --------------------------------------------------------------------------
// Alur Y: item gagal setelah dibayar
// --------------------------------------------------------------------------

describe("Alur Y item gagal setelah dibayar", () => {
  async function paidOrder() {
    const guest = await seat((await newTable()).qrToken);
    const order = await placeOrder(guest);
    const payment = await as(guest).pay({ kind: "order", orderId: order.id });
    expect(await payVerified(payment.body.data.id, CART_TOTAL)).toBe(true);
    return { guest, order };
  }

  const staffCall = (path: string, body: Record<string, unknown>) =>
    kitchenStaff.client.post(path).set(headers).set(originHeader).send(body);

  it("ORD-08 cook menandai item tidak dapat dibuat; pelanggan diberi tahu <= 1 menit dengan dua pilihan saja", async () => {
    const { guest, order } = await paidOrder();
    const failing = order.items.find((item) => item.menuItemId === ids.roti)!;

    const startedAt = Date.now();
    const reported = await staffCall(`/api/order-items/${failing.id}/issues`, {
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Roti habis di dapur",
    });
    expect(reported.status).toBe(201);
    expect(reported.body.data).toMatchObject({
      orderItemId: failing.id,
      type: "unfulfillable",
      status: "open",
    });
    const issueId = reported.body.data.id as string;

    // Step 3: the guest is notified within one minute (item.failed event).
    const [failed] = await outboxRows("item.failed", "orderIssueId", issueId);
    expect(failed).toBeDefined();
    expect(failed!.createdAt.getTime() - startedAt).toBeLessThanOrEqual(60_000);
    expect(failed!.event.payload).toMatchObject({
      orderItemId: failing.id,
      offeredResolutions: ["swap", "voucher"],
    });

    // The guest sees exactly swap or voucher credit: never a refund.
    const mine = await as(guest).issues();
    expect(mine.status).toBe(200);
    const issue = mine.body.data.find(
      (row: { id: string }) => row.id === issueId,
    );
    expect(issue.options.voucher).toMatchObject({
      allowed: true,
      valueIdr: PRICES.roti,
    });
    expect(issue.options.swap.allowed).toBe(true);
    const options = await as(guest).issueOptions(issueId);
    expect(options.body.data.manualRefundOfferedToCustomer).toBe(false);
    const refundTry = await as(guest).choose(issueId, {
      choice: "manual_refund",
    });
    expect(refundTry.status).toBe(422);
  });

  it("Y ORD-08 pelanggan ganti menu ke yang lebih murah: selisih harga dikreditkan", async () => {
    const { guest, order } = await paidOrder();
    // Kopi Susu x2 + extra shot (60.000) fails; Roti Bakar x2 costs 36.000.
    const failing = order.items.find((item) => item.menuItemId === ids.kopi)!;
    const reported = await staffCall(`/api/order-items/${failing.id}/issues`, {
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Susu habis di dapur",
    });
    expect(reported.status).toBe(201);
    const issueId = reported.body.data.id as string;

    // The guest is only offered a replacement that costs the same or less.
    const mine = (await as(guest).issues()).body.data.find(
      (row: { id: string }) => row.id === issueId,
    );
    const offeredIds = mine.options.swap.items.map(
      (item: { menuItemId: string }) => item.menuItemId,
    );
    expect(offeredIds).toContain(ids.roti);
    expect(offeredIds).not.toContain(ids.kopi);
    const lineTotal = mine.lineTotalIdr as number;
    const options = await as(guest).issueOptions(issueId);
    expect(options.body.data.swap.suggestedMenuItemIds).toContain(ids.roti);

    const swapWithoutItem = await as(guest).choose(issueId, { choice: "swap" });
    expect(swapWithoutItem.status).toBe(422);

    const chosen = await as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: ids.roti,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data).toMatchObject({
      status: "resolved",
      resolution: "swap",
      replacementItemId: ids.roti,
      // A cheaper replacement: the difference is negative and credited.
      priceDifferenceIdr: PRICES.roti * 2 - lineTotal,
    });
    expect(chosen.body.data.priceDifferenceIdr).toBeLessThan(0);
    const credited = (await as(guest).issues()).body.data.find(
      (row: { id: string }) => row.id === issueId,
    );
    expect(credited.voucher).toMatchObject({
      valueIdr: lineTotal - PRICES.roti * 2,
    });
  });

  it("Y ORD-08 pelanggan tidak boleh ganti ke menu yang lebih mahal dari item gagal (422)", async () => {
    const { guest, order } = await paidOrder();
    // Roti Bakar 18.000 fails; Kopi Susu 25.000 is dearer.
    const failing = order.items.find((item) => item.menuItemId === ids.roti)!;
    const reported = await staffCall(`/api/order-items/${failing.id}/issues`, {
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Roti habis di dapur",
    });
    const issueId = reported.body.data.id as string;

    const mine = (await as(guest).issues()).body.data.find(
      (row: { id: string }) => row.id === issueId,
    );
    expect(
      mine.options.swap.items.map(
        (item: { menuItemId: string }) => item.menuItemId,
      ),
    ).not.toContain(ids.kopi);

    const dearer = await as(guest).choose(issueId, {
      choice: "swap",
      replacementItemId: ids.kopi,
    });
    expect(dearer.status).toBe(422);
    // The issue stays open: the guest can still pick voucher credit.
    const after = (await as(guest).issues()).body.data.find(
      (row: { id: string }) => row.id === issueId,
    );
    expect(after.status).toBe("open");
  });

  it("Y ORD-08 pelanggan memilih kredit voucher senilai item", async () => {
    const { guest, order } = await paidOrder();
    const failing = order.items.find((item) => item.menuItemId === ids.roti)!;
    const reported = await staffCall(`/api/order-items/${failing.id}/issues`, {
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Roti habis di dapur",
    });
    const issueId = reported.body.data.id as string;

    const chosen = await as(guest).choose(issueId, { choice: "voucher" });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data).toMatchObject({
      status: "resolved",
      resolution: "voucher",
    });
    const seen = (await as(guest).issues()).body.data.find(
      (row: { id: string }) => row.id === issueId,
    );
    expect(seen.voucher).toMatchObject({
      valueIdr: PRICES.roti,
      code: expect.stringMatching(/^[A-Z0-9]{3,6}(-[A-Z0-9]{4,6})+$/),
    });
  });

  it("Y ORD-09 refund manual hanya oleh supervisor dengan approval dan alasan tertulis", async () => {
    const { order } = await paidOrder();
    const failing = order.items.find((item) => item.menuItemId === ids.roti)!;
    const reported = await staffCall(`/api/order-items/${failing.id}/issues`, {
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Roti habis di dapur",
    });
    const issueId = reported.body.data.id as string;

    const noApproval = await staffCall(`/api/order-issues/${issueId}/resolve`, {
      resolution: "manual_refund",
      reason: "Pelanggan menolak ganti menu dan voucher",
    });
    expect(noApproval.status).toBe(422);
    const shortReason = await staffCall(
      `/api/order-issues/${issueId}/resolve`,
      {
        resolution: "manual_refund",
        approvalRequestId: randomUUID(),
        reason: "habis",
      },
    );
    expect(shortReason.status).toBe(422);
  });
});
