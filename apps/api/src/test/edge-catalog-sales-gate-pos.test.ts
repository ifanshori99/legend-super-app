// POS sales hold on a stale edge catalog (bead legend-10nex, founder Q57):
// after more than 24 hours without a successful catalog sync the edge refuses
// to start or pay a sale until the owner allows it. "Jangan sampai rugi":
// a refused sale must leave NO order row and NO payment (tender) row.
// Written from the design contract, not from the implementation.
//
// The gate is driven through its public seam: edge mode is switched on with
// `setSalesGateEdgeModeForTests(() => true)` and the state is whatever the
// installed `SalesGateProvider` returns (the freshness maths is covered in
// edge/catalog-freshness-block.test.ts). Fixtures follow pos-order.test.ts:
// a real Express app, Better Auth, RBAC and PostgreSQL in an isolated tenant.
//
// Assumptions (the contract is silent):
//  - A blocked create answers HTTP 423 with code CATALOG_STALE_BLOCKED and the
//    Indonesian message from the contract (design: "423 or the repo's
//    convention"; the code and message are asserted anywhere in the body).
//  - Only STARTING a sale is held (the implementation gates createPosOrder and
//    the QR order create). Paying an order that was opened before the hold is
//    NOT asserted either way (ambiguous in the design); refunds, voids and
//    closing are not gated. A refused create leaves no order, hence no tender.
//  - A cloud (non-edge) process is never gated.
import { setPosWriteGateEdgeModeForTests } from "../services/pos-edge-outlet.ts";
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import type { PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  saveCatalogGateState,
  startCatalogGate,
} from "../edge/catalog-gate.ts";
import { CRITICAL_CATALOG_STREAMS } from "../edge/catalog-freshness.ts";
import { startPromoGate } from "../edge/promo-gate-runtime.ts";
import {
  promosEnabled,
  setPromoGateEdgeModeForTests,
  withPromoFreshness,
} from "../edge/promo-gate.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import type { OrderPromoPort } from "../services/order-promo-port.ts";
import {
  installSalesGateProvider,
  setSalesGateEdgeModeForTests,
  type SalesGateState,
} from "../edge/sales-gate.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosOrderPromoPort,
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
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
  device: randomUUID(),
};
const BLOCKED_MESSAGE =
  "Penjualan ditahan: katalog belum tersinkron lebih dari 24 jam. Minta owner untuk mengizinkan.";

const allowed: SalesGateState = {
  blocked: false,
  stale24h: false,
  reason: null,
  staleSince: null,
  staleStreams: [],
  override: null,
};
const held: SalesGateState = {
  blocked: true,
  stale24h: true,
  reason: "CATALOG_STALE_24H",
  staleSince: new Date(Date.now() - 30 * 60 * 60_000),
  staleStreams: ["price_lists"],
  override: null,
};
const overridden: SalesGateState = {
  ...held,
  blocked: false,
  override: {
    id: randomUUID(),
    grantedBy: randomUUID(),
    grantedAt: new Date(),
    untilAt: new Date(Date.now() + 60 * 60_000),
    reason: "Internet toko mati",
  },
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `GATE-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
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
    async voidForOrder() {
      return null;
    },
  };
}

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

function pos() {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
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
          deviceId: ids.device,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
      }),
    discount: (orderId: string, source: "promo" | "voucher") =>
      send(`/${orderId}/discounts`, {
        source,
        kind: "amount",
        reason: "promo_engine",
        ...(source === "promo"
          ? { promoCode: "OLD-PROMO" }
          : { voucherCode: "OLD-VOUCHER" }),
      }),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
  };
}

async function count(table: "orders" | "pos_order_tenders"): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1`,
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

/** An unpaid order created while the gate was open. */
async function openOrder(): Promise<{
  orderId: string;
  status: string;
  totalIdr: number;
}> {
  installSalesGateProvider(() => allowed);
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  return { orderId, status, totalIdr: created.body.data.totalIdr as number };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`gate-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  // POS routes check the device registry on every request (second-opinion 495):
  // the signed token must name an active, registered device.
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', 'Kasir Gate', now() - interval '1 minute')`,
    [ids.device, tenant.tenantId, tenant.outletId],
  );
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Gate', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "shift.cash.operate",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "POS Kasir Gate");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  await asOwnerTenant(async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Gate Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await db.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-GATE', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

afterEach(() => {
  installSalesGateProvider(null);
  setSalesGateEdgeModeForTests(null);
  setPromoGateEdgeModeForTests(null);
  setPosOrderPromoPort(null);
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  // Sale records are immutable; give the tenant a valid creator so the platform
  // tenant list still parses it (same as pos-order.test.ts).
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-10nex a held sale writes no order and no payment", () => {
  it("sells normally while the catalog is fresh (control)", async () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => allowed);
    const res = await pos().create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("refuses a new sale after 24 hours without sync: 423, Indonesian message, no order row", async () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => held);
    const orders = await count("orders");
    const tenders = await count("pos_order_tenders");

    const res = await pos().create();
    expect(res.status, JSON.stringify(res.body)).toBe(423);
    expect(JSON.stringify(res.body)).toContain("CATALOG_STALE_BLOCKED");
    expect(JSON.stringify(res.body)).toContain(BLOCKED_MESSAGE);
    expect(res.body.data?.id).toBeUndefined();

    expect(await count("orders")).toBe(orders);
    expect(await count("pos_order_tenders")).toBe(tenders);
  });

  it("a held sale is not stored even when the same idempotency key is retried", async () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => held);
    const orders = await count("orders");
    const idempotencyKey = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await pos().create({ idempotencyKey });
      expect(res.status).toBe(423);
    }
    expect(await count("orders")).toBe(orders);
  });

  it("replays an already created order for the same idempotency key even while held; a new key is refused and writes nothing", async () => {
    // Replay must return the stored order (a retry after a lost response is not
    // a new sale), a NEW key is a new sale and is held.
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => allowed);
    const idempotencyKey = randomUUID();
    const first = await pos().create({ idempotencyKey });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const orderId = first.body.data.id as string;

    installSalesGateProvider(() => held);
    const orders = await count("orders");
    const tenders = await count("pos_order_tenders");

    const replay = await pos().create({ idempotencyKey });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.id).toBe(orderId);

    const fresh = await pos().create({ idempotencyKey: randomUUID() });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(423);
    expect(JSON.stringify(fresh.body)).toContain("CATALOG_STALE_BLOCKED");

    expect(await count("orders")).toBe(orders);
    expect(await count("pos_order_tenders")).toBe(tenders);
  });

  it("fails closed when the gate is not installed on an edge process", async () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(null);
    const orders = await count("orders");
    const res = await pos().create();
    expect(res.status, JSON.stringify(res.body)).toBe(423);
    expect(await count("orders")).toBe(orders);
  });
});

describe("legend-10nex sales resume when the owner allows or the catalog is fresh", () => {
  it("sells again under an active owner override", async () => {
    setSalesGateEdgeModeForTests(() => true);
    installSalesGateProvider(() => overridden);
    const orders = await count("orders");
    const res = await pos().create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await count("orders")).toBe(orders + 1);
  });

  it("the hold applies again the moment the override ends", async () => {
    setSalesGateEdgeModeForTests(() => true);
    let state = overridden;
    installSalesGateProvider(() => state);
    expect((await pos().create()).status).toBe(201);
    state = held; // override expired
    expect((await pos().create()).status).toBe(423);
  });

  it("pays an open order under an active override", async () => {
    setSalesGateEdgeModeForTests(() => true);
    const { orderId, status, totalIdr } = await openOrder();
    installSalesGateProvider(() => overridden);
    const res = await pos().cash(orderId, status, totalIdr + 5_000);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe("legend-10nex the cloud is never held", () => {
  it("sells even if a provider says blocked, when the process is not an edge", async () => {
    setSalesGateEdgeModeForTests(() => false);
    installSalesGateProvider(() => held);
    const res = await pos().create();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe("521 Q62 unproven offline time keeps the outlet whole", () => {
  it("sells at normal price, refuses promo/voucher without financial writes, and never returns excess change", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "device",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
    );
    const registration = await registerEdgeNode(
      context,
      userIdSchema.parse(cashier.userId),
      {
        outletId: tenant.outletId,
        role: "standby",
        label: "Q62 POS boot offline",
      },
    );
    const scope = {
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      edgeNodeId: registration.edgeNode.id,
    };
    const at = new Date();
    await saveCatalogGateState(context, scope, {
      trackingStartedAt: at,
      clockHighWaterAt: at,
    });
    // The device was powered off for an unknowable duration and rebooted with
    // its clock exactly at the last saved high water/checkpoint.
    for (const stream of ["catalog:promotions", "catalog:vouchers"])
      await owner.query(
        `INSERT INTO edge_pull_checkpoints (tenant_id, outlet_id, edge_node_id, stream, last_success_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant.tenantId, tenant.outletId, scope.edgeNodeId, stream, at],
      );
    const alarm = vi.fn();
    const gate = await startCatalogGate({
      context,
      scope,
      overrides: { load: async () => null, close: async () => undefined },
      wall: () => at,
      mono: () => 0,
      persistMs: 24 * 60 * 60_000,
      seed: async (freshness) => {
        for (const stream of CRITICAL_CATALOG_STREAMS)
          freshness.seedLastSuccess(stream, at);
      },
      onOwnerAlarm: alarm,
    });
    const promoGate = startPromoGate({
      context,
      edgeNodeId: scope.edgeNodeId,
      clock: gate.clock,
      intervalMs: 24 * 60 * 60_000,
    });
    const inner: OrderPromoPort = {
      quote: async () => ({
        result: { evaluations: [], totalDiscountIdr: idr(10_000) },
        totalDiscountIdr: idr(10_000),
      }),
      redeem: async () => ({
        result: { evaluations: [], totalDiscountIdr: idr(10_000) },
        totalDiscountIdr: idr(10_000),
      }),
      release: async () => ({ released: true, releasedDiscountIdr: idr(0) }),
    };
    setPosOrderPromoPort(withPromoFreshness(inner));
    setSalesGateEdgeModeForTests(() => true);
    setPromoGateEdgeModeForTests(() => true);
    // This process plays the edge: 1269 E3 refuses the sale in the cloud.
    setPosWriteGateEdgeModeForTests(() => true);
    try {
      await promoGate.refresh();
      expect(promosEnabled()).toBe(false);
      expect(gate.freshness.snapshot()).toMatchObject({
        stale: true,
        ownerAlarm: true,
      });
      expect(gate.freshness.snapshot().cashierWarning).toBeTruthy();
      expect(alarm).toHaveBeenCalled();
      const created = await pos().create();
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const orderId = created.body.data.id as string;
      const status = created.body.data.status as string;
      const fullPrice = 2 * KOPI_IDR + 5_000;
      expect(created.body.data.discountIdr).toBe(0);
      expect(created.body.data.totalIdr).toBe(fullPrice);
      const before = await owner.query(
        "SELECT (SELECT count(*) FROM orders WHERE tenant_id=$1)::int AS orders, (SELECT count(*) FROM pos_order_discounts WHERE tenant_id=$1)::int AS discounts, (SELECT count(*) FROM pos_order_tenders WHERE tenant_id=$1)::int AS tenders",
        [tenant.tenantId],
      );
      for (const source of ["promo", "voucher"] as const) {
        const refused = await pos().discount(orderId, source);
        expect(refused.status, JSON.stringify(refused.body)).toBe(400);
        expect(JSON.stringify(refused.body)).toContain(
          "Promo dan voucher dimatikan",
        );
      }
      const after = await owner.query(
        "SELECT (SELECT count(*) FROM orders WHERE tenant_id=$1)::int AS orders, (SELECT count(*) FROM pos_order_discounts WHERE tenant_id=$1)::int AS discounts, (SELECT count(*) FROM pos_order_tenders WHERE tenant_id=$1)::int AS tenders",
        [tenant.tenantId],
      );
      expect(after.rows).toEqual(before.rows);
      const submitted = await pos().submit(orderId, status);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const paid = await pos().cash(
        orderId,
        submitted.body.data.status as string,
        fullPrice + 5_000,
      );
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const tender = await owner.query<{
        amount_idr: number;
        received_idr: number;
        change_idr: number;
      }>(
        "SELECT amount_idr::int, received_idr::int, change_idr::int FROM pos_order_tenders WHERE tenant_id=$1 AND order_id=$2",
        [tenant.tenantId, ulidToUuid(orderId)],
      );
      expect(tender.rows).toHaveLength(1);
      expect(tender.rows[0]).toEqual({
        amount_idr: fullPrice,
        received_idr: fullPrice + 5_000,
        change_idr: 5_000,
      });
      const row = tender.rows[0]!;
      expect(row.received_idr - row.change_idr).toBe(fullPrice);
      expect(row.change_idr).toBeLessThanOrEqual(row.received_idr - fullPrice);
    } finally {
      setPosWriteGateEdgeModeForTests(null);
      promoGate.stop();
      await gate.stop();
    }
  });
});
