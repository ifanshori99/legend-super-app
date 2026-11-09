// QR dine-in service charge with DEFAULT tenant provisioning (bead legend-xx22n,
// Codex finding 133). A new tenant gets PBJT-FNB 10% (service in base) and a
// tenant-wide SC-DINE-IN 500bp rule for [dine_in, reservation] through the real
// provisioning services. A zone with `serviceChargeBp: 0` must then fall back to
// that rule on the QR path, exactly like the POS path.
//
// Real Express app, Better Auth and PostgreSQL with RLS. Each tenant here is a
// fresh isolated tenant; tax config is never inserted by hand for the default
// tenant, it comes from `provisionDefaultTaxConfig` and
// `provisionDefaultServiceChargeRule`.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { floorZones } from "../db/schema/floor.ts";
import { withTenant } from "../db/tenant.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { computePosBill } from "../services/pos-order-pricing.ts";
import { loadTaxConfig } from "../services/qr-order-pricing.ts";
import {
  setQrOrderDepositCreditLookup,
  setQrOrderPromoPort,
} from "../services/qr-order-ports.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import {
  provisionDefaultServiceChargeRule,
  provisionDefaultTaxConfig,
} from "../services/tax-provisioning.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
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

const ITEM_PRICE = 100_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRSC",
      issuer: null,
    };
    return {
      providerRef: `QRSC-${randomBytes(6).toString("hex")}-${this.created}`,
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
  async channels() {
    return [];
  }
}

type Env = {
  tenant: IsolatedTenant;
  staff: Staff;
  headers: { Host: string };
  itemId: string;
};
type Guest = { token: string; sessionId: string };

let app: Express;
const envs: Env[] = [];

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

/**
 * serviceRule "default": real `provisionDefaultServiceChargeRule` (SC-DINE-IN).
 * serviceRule "outlet-default": no tenant-wide rule; the real provisioning
 * service creates SC-DINE-IN scoped to the tenant's outlet only.
 * serviceRule number: the tenant's own published tenant-wide rule at that bp.
 * serviceRule null: no service charge rule at all.
 */
async function setupTenant(
  label: string,
  serviceRule: "default" | "outlet-default" | number | null,
): Promise<Env> {
  const tenant = await createIsolatedTenant(
    `qsc-${label}-${randomUUID().slice(0, 5)}`,
  );
  const staff = await staffOfIsolatedTenant(app, tenant);
  const itemId = randomUUID();
  const categoryId = randomUUID();
  const priceListId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'SC Default Uji', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Nasi Uji', true, $5)`,
      [itemId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [priceListId, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, itemId, ITEM_PRICE],
    );
    if (typeof serviceRule === "number")
      await client.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes,
            is_active, version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'SC-OWN', 'Service sendiri', $3, NULL, '[]', '["food_beverage"]',
                 true, 1, '2024-01-01', 'published', now(), $4)`,
        [randomUUID(), tenant.tenantId, serviceRule, staff.userId],
      );
  });
  const context = contextOf(tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    const tax = await provisionDefaultTaxConfig(tx, context, null);
    expect(tax.rulesInserted).toBe(1);
    expect(tax.settingsInserted).toBe(1);
    if (serviceRule === "default") {
      const sc = await provisionDefaultServiceChargeRule(
        tx,
        context,
        null,
        null,
      );
      expect(sc.rulesInserted).toBe(1);
    }
    if (serviceRule === "outlet-default") {
      const sc = await provisionDefaultServiceChargeRule(
        tx,
        context,
        null,
        outletIdSchema.parse(tenant.outletId),
      );
      expect(sc.rulesInserted).toBe(1);
    }
  });
  const env: Env = {
    tenant,
    staff,
    headers: { Host: tenant.hostname },
    itemId,
  };
  envs.push(env);
  return env;
}

async function seatedGuest(
  env: Env,
  zoneBp: number,
): Promise<{
  guest: Guest;
  zoneId: string;
}> {
  const zone = await createZone(
    env.staff.client,
    { paymentMode: "pay_first", serviceChargeBp: zoneBp, hours: ALL_DAY },
    env.headers,
  );
  const table = await createTable(
    env.staff.client,
    { zoneId: zone.id },
    env.headers,
  );
  const qr = await issueQr(env.staff.client, table.id, env.headers);
  const response = await scan(app, {
    token: qr.token,
    hostname: env.tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    guest: {
      token: response.body.data.sessionToken,
      sessionId: response.body.data.session.id,
    },
    zoneId: zone.id as string,
  };
}

function as(guest: Guest, env: Env) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", env.tenant.hostname)
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
    quote: () => auth(client.post(`${base}/quote`)).send({}),
    checkout: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/orders`)).send(body),
  };
}

/** One Rp100.000 item, then the quote. Returns the guest and cart version too. */
async function quoteOneItem(env: Env, zoneBp: number) {
  const { guest, zoneId } = await seatedGuest(env, zoneBp);
  const added = await as(guest, env).add({
    menuItemId: env.itemId,
    quantity: 1,
    expectedCartVersion: 0,
  });
  expect(added.status).toBe(201);
  const quote = await as(guest, env).quote();
  expect(quote.status).toBe(200);
  return {
    guest,
    zoneId,
    cartVersion: added.body.data.cart.version as number,
    data: quote.body.data,
  };
}

let main: Env;

beforeAll(async () => {
  app = createApp();
  setPaymentGateway(new FakeGateway());
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  main = await setupTenant("main", "default");
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setQrOrderPromoPort(null);
  setQrOrderDepositCreditLookup(null);
  // Isolated tenants stay in the disposable database (append-only audit rows);
  // give each a valid creator so the platform tenant list still parses them.
  for (const env of envs)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      env.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("QR service charge with default provisioning (legend-xx22n)", () => {
  it("case 1: zone bp 0 falls back to the default SC-DINE-IN rule (quote, checkout, DB)", async () => {
    const { guest, cartVersion, data } = await quoteOneItem(main, 0);
    expect(data.subtotalIdr).toBe(100_000);
    expect(data.serviceCharge.amountIdr).toBe(5_000);
    expect(data.serviceCharge.rateBp).toBe(500);
    expect(data.taxIdr).toBe(10_500);
    expect(data.totalIdr).toBe(115_500);

    const placed = await as(guest, main).checkout({
      expectedCartVersion: cartVersion,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const order = placed.body.data.order;
    expect(order.serviceChargeIdr).toBe(5_000);
    expect(order.taxIdr).toBe(10_500);

    const stored = await owner.query<{
      service_charge_idr: string | number;
      tax_idr: string | number;
      total_idr: string | number;
    }>(
      "SELECT service_charge_idr, tax_idr, total_idr FROM orders WHERE tenant_id = $1 AND id = $2",
      [main.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(Number(stored.rows[0]?.service_charge_idr)).toBe(5_000);
    expect(Number(stored.rows[0]?.tax_idr)).toBe(10_500);
    expect(Number(stored.rows[0]?.total_idr)).toBe(115_500);
  });

  it("case 2: an explicit zone bp 1000 overrides the default rule", async () => {
    const { data } = await quoteOneItem(main, 1000);
    expect(data.serviceCharge.amountIdr).toBe(10_000);
    expect(data.serviceCharge.rateBp).toBe(1000);
  });

  it("case 3: POS computePosBill with the DB-loaded config matches the QR quote; takeaway has no service", async () => {
    const { zoneId, data } = await quoteOneItem(main, 0);
    const context = contextOf(main.tenant.tenantId);
    const outletId = outletIdSchema.parse(main.tenant.outletId);
    const businessDate = new Date().toISOString().slice(0, 10);
    const { taxConfig, zone } = await withTenant(db, context, async (tx) => {
      const config = await loadTaxConfig(tx, context, main.tenant.outletId);
      const [row] = await tx
        .select()
        .from(floorZones)
        .where(eq(floorZones.id, zoneId));
      return { taxConfig: config, zone: row! };
    });
    expect(zone.serviceChargeBp).toBe(0);
    const bill = (channel: "dine_in" | "takeaway") =>
      computePosBill({
        context,
        outletId,
        businessDate,
        channel,
        zone,
        lines: [
          {
            lineId: randomUUID(),
            menuItemId: main.itemId,
            categoryId: randomUUID(),
            quantity: 1,
            unitPriceIdr: ITEM_PRICE,
            modifiersTotalIdr: 0,
          },
        ],
        orderDiscountIdr: 0,
        taxConfig,
      });
    const dineIn = bill("dine_in");
    const takeaway = bill("takeaway");
    expect(dineIn.serviceChargeIdr).toBe(data.serviceCharge.amountIdr);
    expect(dineIn.taxIdr).toBe(data.taxIdr);
    expect(dineIn.totalIdr).toBe(data.totalIdr);
    expect(dineIn.serviceChargeIdr).toBe(5_000);
    expect(takeaway.serviceChargeIdr).toBe(0);
  });

  it("case 4: tenants do not leak service rules into each other", async () => {
    const own = await setupTenant("own1000", 1000);
    const none = await setupTenant("none", null);

    const ownQuote = await quoteOneItem(own, 0);
    const noneQuote = await quoteOneItem(none, 0);
    const mainQuote = await quoteOneItem(main, 0);
    expect(ownQuote.data.serviceCharge.amountIdr).toBe(10_000);
    expect(ownQuote.data.serviceCharge.rateBp).toBe(1000);
    expect(noneQuote.data.serviceCharge.amountIdr).toBe(0);
    // The first tenant is unaffected by the second tenant's own rule.
    expect(mainQuote.data.serviceCharge.amountIdr).toBe(5_000);
    expect(mainQuote.data.serviceCharge.rateBp).toBe(500);
  });

  it("case 5: outlet-scoped default rule without a tenant-wide rule applies on the QR path", async () => {
    const outletOnly = await setupTenant("outlet", "outlet-default");
    const rules = await owner.query<{ outlet_id: string | null }>(
      "SELECT outlet_id FROM service_charge_rules WHERE tenant_id = $1 AND code = 'SC-DINE-IN'",
      [outletOnly.tenant.tenantId],
    );
    expect(rules.rows).toHaveLength(1);
    expect(rules.rows[0]?.outlet_id).toBe(outletOnly.tenant.outletId);

    const { guest, cartVersion, data } = await quoteOneItem(outletOnly, 0);
    expect(data.serviceCharge.amountIdr).toBe(5_000);
    expect(data.serviceCharge.rateBp).toBe(500);
    expect(data.taxIdr).toBe(10_500);

    const placed = await as(guest, outletOnly).checkout({
      expectedCartVersion: cartVersion,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status).toBe(201);
    const order = placed.body.data.order;
    expect(order.serviceChargeIdr).toBe(5_000);
    expect(order.taxIdr).toBe(10_500);

    const stored = await owner.query<{
      service_charge_idr: string | number;
      tax_idr: string | number;
    }>(
      "SELECT service_charge_idr, tax_idr FROM orders WHERE tenant_id = $1 AND id = $2",
      [outletOnly.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(Number(stored.rows[0]?.service_charge_idr)).toBe(5_000);
    expect(Number(stored.rows[0]?.tax_idr)).toBe(10_500);
  });
});
