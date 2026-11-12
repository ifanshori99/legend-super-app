// QR checkout vs POS promo and deposit allocation (bead legend-94qt).
// The promo test uses a shared lock and a barrier to overlap redemption. POS
// repricing leaves a draft unallocated; checkout may allocate to the QR order.
// Separate submit races use persisted paid payment evidence and, for the
// second case, a completed partial refund. A held table-live advisory lock
// proves both concurrent HTTP operations are waiting before release; each
// then allocates through the production reservation deposit lookup.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { idr, ulidToUuid } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { depositCreditForSession } from "../services/reservation-lifecycle.ts";
import { seedSettledDeposit } from "./batch49-settled-deposit-helper.ts";
import type { OrderPromoPort } from "../services/order-promo-port.ts";
import {
  setPosOrderPromoPort,
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import {
  setQrOrderDepositCreditLookup,
  setQrOrderPromoPort,
} from "../services/qr-order-ports.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
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

const KOPI_IDR = 25_000;
/** Kopi x2 = Rp50.000 + PBJT 10% = Rp55.000 (no service charge, no rounding). */
const ORDER_TOTAL_IDR = 55_000;
const PROMO_DISCOUNT_IDR = 1_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

let app: Express;

type Member = { client: ReturnType<typeof agent>; userId: string };
type Fixture = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  kopi: string;
  cashier: Member;
  floor: Staff;
};
type Session = { id: string; guestToken: string };

let a: Fixture;

// ---- Fixtures ---------------------------------------------------------------------

const receiptPort: PosReceiptPort = {
  async issueForSale() {
    throw new Error("This file never completes a sale");
  },
  async findForOrder() {
    return null;
  },
  async voidForOrder() {
    return null;
  },
};

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

async function seedFixture(label: string): Promise<Fixture> {
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
    cashierRole: randomUUID(),
  };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "POS Kasir");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  const cashier: Member = { client, userId };
  const floor = await staffOfIsolatedTenant(app, tenant);
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Lock Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
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
       VALUES ($1, $2, NULL, 'PBJT-LCK', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    kopi: ids.kopi,
    cashier,
    floor,
  };
}

// ---- Promo double with a shared lock and an overlap barrier ----------------------------

const credits = new Map<string, number>();

type Gate = {
  tenantId: string;
  arrived: number;
  met: boolean;
  open: Promise<void>;
  release: () => void;
  timeoutMs: number;
};
let gate: Gate | null = null;

function armGate(fx: Fixture, timeoutMs = 4_000): Gate {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate = {
    tenantId: fx.tenant.tenantId,
    arrived: 0,
    met: false,
    open,
    release,
    timeoutMs,
  };
  return gate;
}

/**
 * Always quotes Rp1.000 off. `redeem` first counts the arrival, then takes the
 * shared lock (stands for the engine's promotion rows), then parks until both
 * the QR checkout and the POS discount have reached `redeem`.
 */
const promoDouble: OrderPromoPort = {
  async quote() {
    return {
      result: { evaluations: [], totalDiscountIdr: idr(PROMO_DISCOUNT_IDR) },
      totalDiscountIdr: idr(PROMO_DISCOUNT_IDR),
    };
  },
  async redeem(tx, ctx, input) {
    const tenantId = ctx.tenant.tenantId;
    const current = gate;
    const armed = current !== null && current.tenantId === tenantId;
    if (armed && !current.met) {
      current.arrived += 1;
      if (current.arrived >= 2) {
        current.met = true;
        current.release();
      }
    }
    // Same hashing as the real advisory locks; one key per tenant.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lock-order-promo:${tenantId}`}, 0))`,
    );
    if (armed && !current.met) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        current.open,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, current.timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return promoDouble.quote(tx, ctx, input);
  },
  async release() {
    return { released: false, releasedDiscountIdr: idr(0) };
  },
};

function useCreditDouble() {
  setQrOrderDepositCreditLookup(async (_tx, tenantId, sessionId) => {
    return credits.get(`${tenantId}:${sessionId.toLowerCase()}`) ?? 0;
  });
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(receiptPort);
  setQrOrderPromoPort(promoDouble);
  setPosOrderPromoPort(promoDouble);
  useCreditDouble();
  a = await seedFixture("lck-a");
});

afterEach(() => {
  useCreditDouble();
  credits.clear();
  gate = null;
});

afterAll(async () => {
  setQrOrderDepositCreditLookup(null);
  setQrOrderPromoPort(null);
  setPosOrderPromoPort(null);
  setPosReceiptPort(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    a.tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Routes ---------------------------------------------------------------------------

async function openSession(fx: Fixture): Promise<Session> {
  const zone = await createZone(
    fx.floor.client,
    { paymentMode: "pay_first", serviceChargeBp: 0, hours: ALL_DAY },
    fx.headers,
  );
  const table = await createTable(
    fx.floor.client,
    { zoneId: zone.id },
    fx.headers,
  );
  const qr = await issueQr(fx.floor.client, table.id, fx.headers);
  const scanned = await scan(app, {
    token: qr.token,
    hostname: fx.tenant.hostname,
  });
  expect(scanned.status, JSON.stringify(scanned.body)).toBe(201);
  return {
    id: scanned.body.data.session.id as string,
    guestToken: scanned.body.data.sessionToken as string,
  };
}

function posSend(fx: Fixture, path: string, body: Record<string, unknown>) {
  return fx.cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(fx.tenant.outletId)}/pos/orders${path}`,
    )
    .set(fx.headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

async function posCreate(fx: Fixture, session: Session) {
  const created = await posSend(fx, "", {
    channel: "pos",
    serviceType: "dine_in",
    tableSessionId: session.id,
    items: [{ menuItemId: fx.kopi, quantity: 2, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/** A promo/voucher discount: the double redeems it, then the order reprices. */
function posPromoDiscount(fx: Fixture, orderId: string) {
  return posSend(fx, `/${orderId}/discounts`, {
    source: "promo",
    kind: "amount",
    promoCode: "LOCK-ORDER",
    reason: "promo_engine",
    reasonNote: "Promo uji",
  });
}

function guestRequest(fx: Fixture, session: Session, path: string) {
  return agent(app)
    .post(`/api/table-sessions/${session.id}${path}`)
    .set(fx.headers)
    .set("Authorization", `Bearer ${session.guestToken}`)
    .set(originHeader);
}

async function fillCart(fx: Fixture, session: Session): Promise<number> {
  const added = await guestRequest(fx, session, "/cart/lines").send({
    idempotencyKey: randomUUID(),
    menuItemId: fx.kopi,
    quantity: 2,
    modifierIds: [],
    expectedCartVersion: 0,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return added.body.data.cart.version as number;
}

type OrderRow = {
  id: string;
  channel: string;
  status: string;
  total: number;
  deposit: number;
  discount: number;
};

async function ordersOf(fx: Fixture, session: Session): Promise<OrderRow[]> {
  const { rows } = await owner.query<{
    id: string;
    channel: string;
    status: string;
    total: string;
    deposit: string;
    discount: string;
  }>(
    `SELECT id, channel, status, total_idr::text AS total,
            deposit_applied_idr::text AS deposit, discount_idr::text AS discount
     FROM orders WHERE tenant_id = $1 AND table_session_id = $2
     ORDER BY created_at, id`,
    [fx.tenant.tenantId, session.id],
  );
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    status: row.status,
    total: Number(row.total),
    deposit: Number(row.deposit),
    discount: Number(row.discount),
  }));
}

// ---- Tests ----------------------------------------------------------------------------

describe("QR checkout and POS promo lock order (legend-94qt)", () => {
  it("legend-94qt a QR pay-first checkout with a promo applies the deposit once and records the discount", async () => {
    const session = await openSession(a);
    const version = await fillCart(a, session);
    credits.set(`${a.tenant.tenantId}:${session.id.toLowerCase()}`, 20_000);
    const placed = await guestRequest(a, session, "/orders").send({
      expectedCartVersion: version,
      idempotencyKey: randomUUID(),
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const rows = await ordersOf(a, session);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.discount).toBeGreaterThan(0);
    expect(rows[0]?.deposit).toBe(20_000);
    expect(rows[0]?.total).toBeLessThan(ORDER_TOTAL_IDR);
  });

  it("legend-94qt a QR pay-first checkout with a promo racing a POS promo discount in one session: no 40P01, deposit applied once", async () => {
    const session = await openSession(a);
    // POS remains a draft and cannot reserve deposit while QR checkout runs.
    const posOrderId = await posCreate(a, session);
    const version = await fillCart(a, session);

    credits.set(`${a.tenant.tenantId}:${session.id.toLowerCase()}`, 60_000);
    const overlap = armGate(a);
    const [pos, qr] = await Promise.all([
      posPromoDiscount(a, posOrderId),
      guestRequest(a, session, "/orders").send({
        expectedCartVersion: version,
        idempotencyKey: randomUUID(),
      }),
    ]);
    // A 40P01 surfaces as a 5xx; a deadlock victim is not an acceptable result.
    expect(pos.status, JSON.stringify(pos.body)).toBeLessThan(300);
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    // Both transactions reached the promo redeem together: a real race.
    expect(overlap.met).toBe(true);

    const rows = await ordersOf(a, session);
    expect(rows.map((row) => row.channel).sort()).toEqual(["pos", "qr"]);
    for (const row of rows) expect(row.deposit).toBeLessThanOrEqual(row.total);
    const live = rows.filter((row) => row.status !== "voided");
    const deposit = live.reduce((sum, row) => sum + row.deposit, 0);
    expect(deposit).toBeLessThanOrEqual(60_000);
    expect(rows.find((row) => row.channel === "pos")?.deposit).toBe(0);
    expect(rows.find((row) => row.channel === "qr")?.deposit).toBe(53_900);
    expect(deposit).toBe(53_900);
    expect(ulidToUuid(posOrderId)).toBe(
      rows.find((row) => row.channel === "pos")?.id,
    );
  });

  it.each([0, 10_000])(
    "QR and POS submit share only settled deposit after refund Rp%s",
    async (refundedIdr) => {
      const session = await openSession(a);
      const paidIdr = 60_000;
      await seedSettledDeposit({
        tenantId: a.tenant.tenantId,
        outletId: a.tenant.outletId,
        sessionId: session.id,
        requestedBy: a.cashier.userId,
        approverId: a.floor.userId,
        paidIdr,
        refundedIdr,
      });
      setQrOrderDepositCreditLookup(depositCreditForSession);
      const posOrderId = await posCreate(a, session);
      const before = await ordersOf(a, session);
      expect(before.find((row) => row.channel === "pos")?.deposit).toBe(0);
      const version = await fillCart(a, session);

      // Both requests must reach the same table-live lock before we release it:
      // checkout and submit serialize there before either allocates the credit.
      const holder = await owner.connect();
      let requests: Promise<unknown>[] = [];
      try {
        await holder.query("BEGIN");
        const table = await holder.query<{ table_id: string }>(
          "SELECT table_id FROM table_sessions WHERE tenant_id = $1 AND id = $2",
          [a.tenant.tenantId, session.id],
        );
        expect(table.rows).toHaveLength(1);
        await holder.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`table-live:${a.tenant.tenantId}:${table.rows[0]!.table_id}`],
        );
        const pid = await holder.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pos = posSend(a, `/${posOrderId}/submit`, {
          expectedStatus: "draft",
        });
        const qr = guestRequest(a, session, "/orders").send({
          expectedCartVersion: version,
          idempotencyKey: randomUUID(),
        });
        // Starting via then() dispatches both supertest requests immediately.
        const posResult = pos.then((response) => response);
        const qrResult = qr.then((response) => response);
        requests = [posResult, qrResult];
        const deadline = Date.now() + 8_000;
        let blocked = 0;
        while (Date.now() < deadline) {
          const waiters = await owner.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [pid.rows[0]!.pid],
          );
          blocked = Number(waiters.rows[0]!.n);
          if (blocked >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        expect(blocked).toBeGreaterThanOrEqual(2);
        await holder.query("COMMIT");
        const [posResponse, qrResponse] = await Promise.all([
          posResult,
          qrResult,
        ]);
        expect(posResponse.status, JSON.stringify(posResponse.body)).toBe(200);
        expect(qrResponse.status, JSON.stringify(qrResponse.body)).toBe(201);
      } finally {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
        await Promise.allSettled(requests);
      }

      const rows = await ordersOf(a, session);
      const live = rows.filter(
        (row) => row.status !== "draft" && row.status !== "voided",
      );
      expect(live.map((row) => row.channel).sort()).toEqual(["pos", "qr"]);
      for (const row of live) {
        expect(row.deposit).toBeGreaterThanOrEqual(0);
        expect(row.deposit).toBeLessThanOrEqual(row.total);
      }
      const credited = paidIdr - refundedIdr;
      const used = live.reduce((sum, row) => sum + row.deposit, 0);
      expect(used).toBeLessThanOrEqual(credited);
      expect(used).toBeLessThanOrEqual(
        live.reduce((sum, row) => sum + row.total, 0),
      );
      expect(used).toBe(credited);
    },
    30_000,
  );
});
