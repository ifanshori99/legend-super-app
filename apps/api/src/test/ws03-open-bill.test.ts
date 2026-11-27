// WS-03 open-bill controls (legend-cqrw; PRD v1.7 §3 F43 "Kontrol Open Bill").
//
// Real Express app + PostgreSQL (disposable server from `pnpm test`). Cases:
// the default policy (never "no limit"), an order refused over the per-outlet
// limit with the breach audited, and the idle-session alert to the zone's
// waiters once per idle spell.

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { idr, tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import {
  getOpenBillPolicy,
  OPEN_BILL_DEFAULT_BILL_REQUEST_SLO_SECONDS,
  OPEN_BILL_DEFAULT_INACTIVITY_MINUTES,
  OPEN_BILL_DEFAULT_MAX_BILL_VALUE_IDR,
  sweepInactiveOpenBillSessions,
  upsertOpenBillPolicy,
} from "../services/open-bill-control.service.ts";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { agent, originHeader } from "./helpers.ts";
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

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  roti: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

async function asOwnerTenant<T>(
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

function context() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

type Guest = { token: string; sessionId: string; zoneId: string };

async function seat(paymentMode: "pay_first" | "open_bill"): Promise<Guest> {
  const zone = await createZone(
    staff.client,
    { paymentMode, serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(scanned.status).toBe(201);
  return {
    token: scanned.body.data.sessionToken,
    sessionId: scanned.body.data.session.id,
    zoneId: zone.id,
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
    add: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        ...body,
      }),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
    bill: () => auth(client.get(`${base}/bill`)),
    view: () => auth(client.get(base)),
  };
}

/** Kopi x2 + Roti x1 = Rp68.000 before service charge and tax. */
async function fillCart(guest: Guest, expectedCartVersion: number) {
  const first = await as(guest).add({
    menuItemId: ids.kopi,
    quantity: 2,
    expectedCartVersion,
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

async function confirm(guest: Guest) {
  const response = await staff.client
    .post(`/api/table-sessions/${guest.sessionId}/confirm`)
    .set(headers)
    .set(originHeader);
  expect(response.status).toBe(200);
}

const setIdle = (sessionId: string, minutes: number) =>
  asOwnerTenant((client) =>
    client.query(
      `UPDATE table_sessions SET last_activity_at = now() - ($2 || ' minutes')::interval
       WHERE tenant_id = $1 AND id = $3`,
      [tenant.tenantId, String(minutes), sessionId],
    ),
  );

async function countEvents(name: string, sessionId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenant.tenantId, sessionId, name],
  );
  return Number(rows[0]?.count ?? 0);
}

const setLimit = (maxBillValueIdr: number) =>
  upsertOpenBillPolicy(
    context(),
    tenant.outletId,
    {
      maxBillValueIdr: idr(maxBillValueIdr),
      inactivityMinutes: 45,
      billRequestSloSeconds: 180,
    },
    staff.userId,
  );

/** Checks out the current cart, filling it first when it is empty. */
async function place(guest: Guest) {
  const view = await as(guest).view();
  const version = view.body.data.cart.lines.length
    ? view.body.data.cart.version
    : await fillCart(guest, view.body.data.cart.version);
  return as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
}

/**
 * The order's WS-05 link is paid by a verified QRIS payment of `paidIdr`
 * (link `paid_idr`, intent, evidence); `providerRefundIdr` > 0 then records a
 * refund the provider made on its own (legend-9yw78.12). The link's
 * `paid_idr` stays gross, as the provider refund never touches it.
 */
async function payViaLink(
  orderId: string,
  paidIdr: number,
  providerRefundIdr = 0,
) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'test')`,
      [
        linkId,
        tenant.tenantId,
        tenant.outletId,
        randomUUID().replaceAll("-", "").repeat(2),
        `OB-${randomUUID().slice(0, 8)}`,
        paidIdr,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7,
         '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
         now() + interval '1 hour', now())`,
      [
        intentId,
        tenant.tenantId,
        tenant.outletId,
        linkId,
        paidIdr,
        `ob-pay-${intentId}`,
        providerRefundIdr > 0 ? "partially_refunded" : "paid",
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        tenant.tenantId,
        tenant.outletId,
        intentId,
        `ob-evidence-${intentId}`,
        paidIdr,
      ],
    );
    if (providerRefundIdr > 0)
      await client.query(
        `INSERT INTO payment_provider_refunds
           (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
            provider_payment_ref, amount_idr, source)
         VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')`,
        [
          tenant.tenantId,
          tenant.outletId,
          intentId,
          `rf_${randomUUID().slice(0, 12)}`,
          `pay_${intentId.slice(0, 12)}`,
          providerRefundIdr,
        ],
      );
    await client.query(
      `UPDATE orders SET payment_link_id = $3, payment_link_token_sealed = 'sealed-test' WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, ulidToUuid(orderId), linkId],
    );
  });
}

/**
 * The cashier takes the order over (a POS extension row) and records
 * tenders on it, as the POS payment panel does; `complete` then closes it.
 */
async function ringAtCashier(
  orderId: string,
  tenders: {
    method: "cash" | "edc_card";
    amountIdr: number;
    captured: boolean;
  }[],
  options = { complete: true },
) {
  const id = ulidToUuid(orderId);
  await asOwnerTenant(async (client) => {
    await client.query(
      `UPDATE orders SET channel = 'captain' WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, id],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'captain')`,
      [id, tenant.tenantId, tenant.outletId],
    );
    for (const tender of tenders) {
      const cash = tender.method === "cash";
      await client.query(
        `INSERT INTO pos_order_tenders
           (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr,
            change_idr, status, requested_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)`,
        [
          tenant.tenantId,
          tenant.outletId,
          id,
          tender.method,
          cash ? "manual" : "edc",
          tender.amountIdr,
          cash ? tender.amountIdr : null,
          cash ? 0 : null,
          tender.captured ? "captured" : "authorized",
          tender.captured ? new Date() : null,
        ],
      );
    }
    if (options.complete)
      await client.query(
        `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, id],
      );
  });
}

/** `currentBillIdr` of each breach recorded for the session. */
async function breachedBills(sessionId: string): Promise<number[]> {
  const { rows } = await owner.query<{ current: string }>(
    `SELECT event->'payload'->>'currentBillIdr' AS current FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'open_bill.limit_exceeded'`,
    [tenant.tenantId, sessionId],
  );
  return rows.map((row) => Number(row.current));
}

async function waiterAlerts(sessionId: string): Promise<string[]> {
  const { rows } = await owner.query<{ user_id: string }>(
    `SELECT n.user_id FROM notifications n
       JOIN domain_event_outbox o ON o.tenant_id = n.tenant_id AND o.event_id = n.source_event_id
      WHERE n.tenant_id = $1 AND o.aggregate_id = $2 AND o.event->>'name' = 'open_bill.inactive'`,
    [tenant.tenantId, sessionId],
  );
  return rows.map((row) => row.user_id);
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`ob-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Open Bill Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.roti, "Roti Bakar"],
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
      [ids.kopi, 25_000],
      [ids.roti, 18_000],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, itemId, price],
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
       VALUES ($1, $2, NULL, 'PBJT-OB', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
});

afterAll(async () => {
  // The isolated tenant stays in the disposable test database (append-only
  // audit rows); give it a valid creator so the tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("open-bill policy", () => {
  it("a missing policy falls back to the named defaults, never to no limit", async () => {
    const policy = await getOpenBillPolicy(context(), tenant.outletId);
    expect(policy).toMatchObject({
      isDefault: true,
      maxBillValueIdr: OPEN_BILL_DEFAULT_MAX_BILL_VALUE_IDR,
      inactivityMinutes: OPEN_BILL_DEFAULT_INACTIVITY_MINUTES,
      billRequestSloSeconds: OPEN_BILL_DEFAULT_BILL_REQUEST_SLO_SECONDS,
    });
    expect(OPEN_BILL_DEFAULT_MAX_BILL_VALUE_IDR).toBe(3_000_000);
    expect(OPEN_BILL_DEFAULT_INACTIVITY_MINUTES).toBe(45);
    expect(OPEN_BILL_DEFAULT_BILL_REQUEST_SLO_SECONDS).toBe(180);
  });
});

describe("open-bill value limit", () => {
  it("refuses an order over the outlet limit, audits the breach, keeps the bill", async () => {
    const guest = await seat("open_bill");
    await confirm(guest);
    const version = await fillCart(guest, 0);
    // Default limit (Rp3.000.000) lets a normal order through.
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const firstTotal = placed.body.data.order.totalIdr as number;

    // The outlet sets the smallest allowed limit: a second order would pass it.
    const saved = await upsertOpenBillPolicy(
      context(),
      tenant.outletId,
      {
        maxBillValueIdr: idr(100_000),
        inactivityMinutes: 45,
        billRequestSloSeconds: 180,
      },
      staff.userId,
    );
    expect(saved.isDefault).toBe(false);
    expect(
      (await getOpenBillPolicy(context(), tenant.outletId)).maxBillValueIdr,
    ).toBe(100_000);
    expect(firstTotal).toBeLessThan(100_000);

    const cartNow = await as(guest).view();
    const version2 = await fillCart(guest, cartNow.body.data.cart.version);
    const refused = await as(guest).checkout({
      expectedCartVersion: version2,
      idempotencyKey: randomUUID(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("QR_ORDER_OPEN_BILL_LIMIT");
    expect(refused.body.error.message).toContain("open bill");

    // Audited and queued in a transaction that outlives the refusal.
    expect(await countEvents("open_bill.limit_exceeded", guest.sessionId)).toBe(
      1,
    );
    const audit = await owner.query<{
      event: {
        maskedChanges: {
          after: { maxBillValueIdr: number; currentBillIdr: number };
        };
      };
    }>(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'open_bill.limit_exceeded' AND event->>'objectId' = $2`,
      [tenant.tenantId, guest.sessionId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.event.maskedChanges.after).toMatchObject({
      maxBillValueIdr: 100_000,
      currentBillIdr: firstTotal,
    });

    // The refused order stored nothing; the bill is still the first order.
    const bill = await as(guest).bill();
    expect(bill.body.data.totals.totalIdr).toBe(firstTotal);
  });

  it("limits unpaid exposure only; a repeated refusal of one cart records once", async () => {
    await upsertOpenBillPolicy(
      context(),
      tenant.outletId,
      {
        maxBillValueIdr: idr(100_000),
        inactivityMinutes: 45,
        billRequestSloSeconds: 180,
      },
      staff.userId,
    );
    const guest = await seat("open_bill");
    await confirm(guest);
    const place = async () => {
      const view = await as(guest).view();
      const version = view.body.data.cart.lines.length
        ? view.body.data.cart.version
        : await fillCart(guest, view.body.data.cart.version);
      return as(guest).checkout({
        expectedCartVersion: version,
        idempotencyKey: randomUUID(),
      });
    };
    const first = await place();
    expect(first.status).toBe(201);
    const total = first.body.data.order.totalIdr as number;
    const firstId = first.body.data.order.id as string;

    // Paid in full: the order no longer counts, so the next one fits.
    await payViaLink(firstId, total);
    const second = await place();
    expect(second.status).toBe(201);
    const secondId = second.body.data.order.id as string;

    // Unpaid second order + a third: over the limit. Same cart twice: one record.
    const refusedA = await place();
    const refusedB = await as(guest).checkout({
      expectedCartVersion: (await as(guest).view()).body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(refusedA.status).toBe(409);
    expect(refusedB.status).toBe(409);
    expect(await countEvents("open_bill.limit_exceeded", guest.sessionId)).toBe(
      1,
    );

    // Voiding the unpaid order frees the room again.
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE orders SET status = 'voided' WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, ulidToUuid(secondId)],
      ),
    );
    expect((await place()).status).toBe(201);
  });

  it("a provider's own refund of a link payment counts the refunded part as unpaid again (legend-9yw78.12)", async () => {
    await setLimit(100_000);
    const guest = await seat("open_bill");
    await confirm(guest);
    const first = await place(guest);
    expect(first.status).toBe(201);
    const total = first.body.data.order.totalIdr as number;
    // Without payment a second order would pass Rp100.000.
    expect(total * 2).toBeGreaterThan(100_000);
    const refunded = Math.ceil(total / 2);

    // The link took the whole order, then the provider gave half back on its
    // own. The link's gross paid_idr still says paid in full; the bill is not.
    await payViaLink(first.body.data.order.id as string, total, refunded);
    const refused = await place(guest);
    expect(refused.status).toBe(409);
    expect(await breachedBills(guest.sessionId)).toEqual([refunded]);
  });

  it("a cashier cash payment frees room; a completed order no longer counts", async () => {
    await setLimit(100_000);
    const guest = await seat("open_bill");
    await confirm(guest);
    const first = await place(guest);
    expect(first.status).toBe(201);
    const total = first.body.data.order.totalIdr as number;
    // Without payment a second order would pass Rp100.000.
    expect(total * 2).toBeGreaterThan(100_000);

    await ringAtCashier(first.body.data.order.id as string, [
      { method: "cash", amountIdr: total, captured: true },
    ]);
    expect((await place(guest)).status).toBe(201);
  });

  it("a half-paid split tender frees half the order", async () => {
    await setLimit(100_000);
    const guest = await seat("open_bill");
    await confirm(guest);
    const first = await place(guest);
    expect(first.status).toBe(201);
    const total = first.body.data.order.totalIdr as number;
    const half = Math.floor(total / 2);

    // Cash half captured; the EDC half is still waiting for the terminal.
    await ringAtCashier(
      first.body.data.order.id as string,
      [
        { method: "cash", amountIdr: half, captured: true },
        { method: "edc_card", amountIdr: total - half, captured: false },
      ],
      { complete: false },
    );
    const refused = await place(guest);
    expect(refused.status).toBe(409);
    expect(await breachedBills(guest.sessionId)).toEqual([total - half]);

    // The EDC half is captured too: the whole order is paid.
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE pos_order_tenders SET status = 'captured', resolved_at = now()
          WHERE tenant_id = $1 AND order_id = $2 AND status = 'authorized'`,
        [tenant.tenantId, ulidToUuid(first.body.data.order.id as string)],
      ),
    );
    expect((await place(guest)).status).toBe(201);
  });

  it("records at most one breach per session per minute, whatever the cart", async () => {
    await setLimit(100_000);
    const guest = await seat("open_bill");
    await confirm(guest);
    expect((await place(guest)).status).toBe(201);
    const refusedA = await place(guest);
    expect(refusedA.status).toBe(409);
    // A changed cart (new cart version) refused again within the minute.
    const view = await as(guest).view();
    const added = await as(guest).add({
      menuItemId: ids.kopi,
      quantity: 1,
      expectedCartVersion: view.body.data.cart.version,
    });
    expect(added.status).toBe(201);
    const refusedB = await as(guest).checkout({
      expectedCartVersion: added.body.data.cart.version,
      idempotencyKey: randomUUID(),
    });
    expect(refusedB.status).toBe(409);
    expect(await countEvents("open_bill.limit_exceeded", guest.sessionId)).toBe(
      1,
    );
    const audit = await owner.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'open_bill.limit_exceeded' AND event->>'objectId' = $2`,
      [tenant.tenantId, guest.sessionId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("the session's unused reservation deposit offsets the bill, the new order included", async () => {
    await setLimit(100_000);
    setQrOrderDepositCreditLookup(async () => 60_000);
    try {
      const guest = await seat("open_bill");
      await confirm(guest);
      const first = await place(guest);
      expect(first.status).toBe(201);
      const total = first.body.data.order.totalIdr as number;
      // Two orders less the Rp60.000 deposit fit; without it they would not.
      expect(total * 2).toBeGreaterThan(100_000);
      expect(total * 2 - 60_000).toBeLessThanOrEqual(100_000);
      expect((await place(guest)).status).toBe(201);
      // A third order passes the limit; the breach records the bill after the deposit.
      expect((await place(guest)).status).toBe(409);
      expect(await breachedBills(guest.sessionId)).toEqual([
        total * 2 - 60_000,
      ]);
    } finally {
      setQrOrderDepositCreditLookup(null);
    }
  });

  it("does not limit a pay-first session", async () => {
    const guest = await seat("pay_first");
    const version = await fillCart(guest, 0);
    const placed = await as(guest).checkout({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    expect(await countEvents("open_bill.limit_exceeded", guest.sessionId)).toBe(
      0,
    );
  });
});

describe("open-bill inactivity alert", () => {
  it("alerts only the zone waiters, once per idle spell, only for idle open-bill sessions", async () => {
    const idle = await seat("open_bill");
    const active = await seat("open_bill");
    const payFirst = await seat("pay_first");
    await confirm(idle);
    await confirm(active);
    await asOwnerTenant((client) =>
      client.query(
        `INSERT INTO zone_waiter_assignments (tenant_id, outlet_id, zone_id, user_id)
         VALUES ($1, $2, $3, $4)`,
        [tenant.tenantId, tenant.outletId, idle.zoneId, staff.userId],
      ),
    );
    await setIdle(idle.sessionId, 50);
    await setIdle(active.sessionId, 10);
    await setIdle(payFirst.sessionId, 50);

    const alerted = await sweepInactiveOpenBillSessions(new Date(), context());
    expect(alerted).toContain(idle.sessionId);
    expect(alerted).not.toContain(active.sessionId);
    expect(alerted).not.toContain(payFirst.sessionId);
    expect(await countEvents("open_bill.inactive", idle.sessionId)).toBe(1);
    expect(await waiterAlerts(idle.sessionId)).toEqual([staff.userId]);

    // The same idle spell alerts once.
    expect(
      await sweepInactiveOpenBillSessions(new Date(), context()),
    ).not.toContain(idle.sessionId);
    expect(await countEvents("open_bill.inactive", idle.sessionId)).toBe(1);

    // New activity, then idle again: a new spell alerts again.
    await setIdle(idle.sessionId, 47);
    expect(
      await sweepInactiveOpenBillSessions(new Date(), context()),
    ).toContain(idle.sessionId);
    expect(await countEvents("open_bill.inactive", idle.sessionId)).toBe(2);
  });

  it("uses the outlet's own inactivity limit", async () => {
    const guest = await seat("open_bill");
    await confirm(guest);
    await upsertOpenBillPolicy(
      context(),
      tenant.outletId,
      {
        maxBillValueIdr: idr(100_000),
        inactivityMinutes: 120,
        billRequestSloSeconds: 180,
      },
      staff.userId,
    );
    await setIdle(guest.sessionId, 60);
    expect(
      await sweepInactiveOpenBillSessions(new Date(), context()),
    ).not.toContain(guest.sessionId);
    await setIdle(guest.sessionId, 125);
    expect(
      await sweepInactiveOpenBillSessions(new Date(), context()),
    ).toContain(guest.sessionId);
  });
});
