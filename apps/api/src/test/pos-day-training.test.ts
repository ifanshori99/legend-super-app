// End-of-day recap ignores training orders (bead legend-fbxzw; PRD v1.7 §3 F8
// "Tutup Hari", POS-05; twin of legend-0v3b3 which keeps training orders out
// of the cashier drawer and legend-gkc6b which keeps them out of the journal).
//
// A training order is stamped `pos_orders.is_training = true` at insert. Its
// sale, tender, void and refund are play money: the end-of-day recap
// (`getEndOfDayRecap`, GET /api/outlets/:outletId/pos/day) and the day close
// must leave them out of EVERY section: sales set (order count, gross,
// discount, service, tax, rounding, total, per channel, per device), captured
// tender per method, voids (count and value) and refunds (count and value).
// A day with one real + one training order recaps exactly like a day with only
// the real order, and the balance check (tender = total sales) never throws.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant. Sales, tenders, voids and refunds are seeded straight into
// orders / pos_orders / pos_order_tenders / pos_order_voids /
// pos_order_refunds (same pattern as pos-shift-training.test.ts); the recap
// and the close are driven through HTTP as the outlet manager.
//
// Assumptions (the brief leaves them open):
//  - Every case uses its own past business date, so the recaps cannot affect
//    each other and a day close in case 6 does not lock the other cases.
//  - Seeded sales sit on no cashier shift (no open shift blocks the day close);
//    the cash tender has shift_id NULL, the sale has a device id.
//  - "Recap is the same as a real-only day" is checked two ways: explicit
//    figures, and equality with a reference day seeded with only the real
//    order on the same device (ignoring id, generatedAt and businessDate).
//  - A void or refund of a completed sale leaves the order `completed`
//    (POS-04), as in pos-day.test.ts; the void/refund value is then also
//    subtracted per tender (tender refundedIdr = refunds + voids).
//  - Amounts follow pos-day.test.ts: 2 x Kopi Susu 25_000 = 50_000 + 10% PBJT
//    = 55_000 (pos channel); gofood 2 x 30_000 + 10% = 66_000.
//  - Day close is allowed on a past day with no shift, no unfinished order and
//    no receipt gap (inventory deduction off).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { endOfDayRecapSchema, type EndOfDayRecap } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const REAL_IDR = 55_000;
const TRAINING_IDR = 40_000;
const GOFOOD_IDR = 66_000;

const managerRole = randomUUID();
const cashierRole = randomUUID();
const deviceId = randomUUID();

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let manager: { client: ReturnType<typeof agent>; userId: string };
// A second person: a void / refund needs an approver other than the requester.
let approverId: string;
// Voids and refunds are paid out of an open drawer: they name this shift.
let shiftId: string;

// ---- Fixtures -------------------------------------------------------------------

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

type SaleOptions = {
  date: string;
  totalIdr: number;
  training?: boolean;
  method?: "cash" | "qris" | "card";
  channel?: "pos" | "gofood";
};

/** A completed, paid sale on `date`; `training` stamps pos_orders.is_training. */
async function seedSale(options: SaleOptions): Promise<string> {
  const orderId = randomUUID();
  const method = options.method ?? "cash";
  const channel = options.channel ?? "pos";
  const tax = Math.round(options.totalIdr / 11);
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, $5, 'takeaway', 'pay_first', $6, 0, 0, $7, 0, $8,
               'completed', $9, now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `DT-${orderId.slice(0, 8)}`,
        channel,
        options.totalIdr - tax,
        tax,
        options.totalIdr,
        options.date,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders
         (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id,
          submitted_at, completed_at, is_training)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, now(), now(), $7)`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        channel,
        deviceId,
        manager.userId,
        options.training ?? false,
      ],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'captured', now(), now(), $9, NULL)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        method,
        method === "cash" ? "manual" : "doit",
        options.totalIdr,
        method === "cash" ? options.totalIdr : null,
        method === "cash" ? 0 : null,
        manager.userId,
      ],
    );
  });
  return orderId;
}

/** A refund of the order; one tender line of the sale's method. */
async function seedRefund(
  orderId: string,
  amountIdr: number,
  method: "cash" | "qris" | "card" = "cash",
): Promise<void> {
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO pos_order_refunds
         (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
          requested_by, approved_by, approval_request_id, refunded_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, 'quality_complaint', 'Minuman tumpah', $5::jsonb,
               $6, $7, $8, ((SELECT business_date FROM orders WHERE tenant_id = $1 AND id = $3)::timestamp + interval '5 hours') AT TIME ZONE 'UTC', $9, false)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        amountIdr,
        JSON.stringify([{ method, amountIdr, reference: null }]),
        manager.userId,
        approverId,
        randomUUID(),
        shiftId,
      ],
    ),
  );
}

/** A linked void of the (completed) order. */
async function seedVoid(orderId: string, amountIdr: number): Promise<void> {
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO pos_order_voids
         (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
          requested_by, approved_by, override_id, voided_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, $5, 'customer_cancelled', 'Pelanggan salah pesan',
               $6, $7, $8, ((SELECT business_date FROM orders WHERE tenant_id = $1 AND id = $3)::timestamp + interval '5 hours') AT TIME ZONE 'UTC', $9, false)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        `DT-V-${orderId.slice(0, 8)}`,
        amountIdr,
        manager.userId,
        approverId,
        randomUUID(),
        shiftId,
      ],
    ),
  );
}

/**
 * An order that is not final yet (status draft / awaiting_payment / sent), left hanging on
 * `date`. No tender, no completed_at; `training` stamps pos_orders.is_training.
 */
async function seedUnfinished(options: {
  date: string;
  training?: boolean;
  status?: "draft" | "awaiting_payment" | "sent";
}): Promise<string> {
  const orderId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 50000, 0, 0, 5000, 0, 55000,
               $5, $6, now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `DT-U-${orderId.slice(0, 8)}`,
        options.status ?? "draft",
        options.date,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders
         (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id,
          submitted_at, completed_at, is_training)
       VALUES ($1, $2, $3, 'pos', NULL, $4, $5, now(), NULL, $6)`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        deviceId,
        manager.userId,
        options.training ?? false,
      ],
    );
  });
  return orderId;
}

async function dailyCloseRowCount(date: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_daily_closes
     WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
    [tenant.tenantId, tenant.outletId, date],
  );
  return rows.length;
}

function day(date: string) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/day`;
  return {
    get: () =>
      manager.client
        .get(`${base}?businessDate=${encodeURIComponent(date)}`)
        .set(headers)
        .set(originHeader),
    close: () =>
      manager.client.post(`${base}/close`).set(headers).set(originHeader).send({
        businessDate: date,
        inventoryDeduction: false,
        idempotencyKey: randomUUID(),
      }),
  };
}

async function readRecap(date: string): Promise<EndOfDayRecap> {
  const response = await day(date).get();
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return endOfDayRecapSchema.parse(response.body.data);
}

/** The recap without what is unique to one day or one read. */
function comparable(recap: EndOfDayRecap) {
  return {
    ...recap,
    id: undefined,
    generatedAt: undefined,
    businessDate: undefined,
  };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const deviceTotals = (recap: EndOfDayRecap) => ({
  orderCount: sum(recap.devices.map((d) => d.orderCount)),
  totalIdr: sum(recap.devices.map((d) => d.totalIdr)),
  voidedOrderCount: sum(recap.devices.map((d) => d.voidedOrderCount)),
  voidedAmountIdr: sum(recap.devices.map((d) => d.voidedAmountIdr)),
  refundCount: sum(recap.devices.map((d) => d.refundCount)),
  refundAmountIdr: sum(recap.devices.map((d) => d.refundAmountIdr)),
});
const tender = (recap: EndOfDayRecap, method: string) =>
  recap.tenders.find((row) => row.method === method);

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`daytrain-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    tenantId === tenant.tenantId && id === deviceId ? tenant.outletId : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  for (const [id, name, permissions] of [
    [managerRole, "Manajer Hari Latihan", ["pos.day.close"]],
    [cashierRole, "Kasir Hari Latihan", ["shift.cash.operate"]],
  ] as const)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  const member = async (roleId: string, label: string) => {
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
  };
  manager = await member(managerRole, "Manajer Hari Latihan");
  // The cashier opens the drawer that pays out the voids and refunds below.
  const cashier = await member(cashierRole, "Kasir Hari Latihan");
  const opened = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`)
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
    .send({ openingFloatIdr: 100_000, idempotencyKey: randomUUID() });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shiftId = opened.body.data.id as string;
  const approverClient = agent(app);
  await signUp(approverClient, "Penyetuju Hari Latihan");
  const approverSession = await approverClient.get("/api/auth/get-session");
  approverId = approverSession.body.user.id as string;
}, 120_000);

afterAll(async () => {
  setDeviceOutletResolver(null);
  // Final orders and audit rows are immutable, so the isolated tenant stays in
  // the disposable database; give it a valid creator for the tenant list.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Cases ------------------------------------------------------------------------

describe("POS-05 legend-fbxzw: training orders stay out of the end-of-day recap", () => {
  it("1: a mixed day (one real + one training cash sale) recaps as the real order only and does not throw", async () => {
    const mixed = "2025-03-01";
    const realOnly = "2025-03-02";
    await seedSale({ date: mixed, totalIdr: REAL_IDR });
    await seedSale({ date: mixed, totalIdr: TRAINING_IDR, training: true });
    await seedSale({ date: realOnly, totalIdr: REAL_IDR });

    const recap = await readRecap(mixed);
    expect(recap).toMatchObject({
      status: "open",
      totalSalesIdr: REAL_IDR,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
    });
    expect(tender(recap, "cash")).toEqual({
      method: "cash",
      capturedIdr: REAL_IDR,
      refundedIdr: 0,
      netIdr: REAL_IDR,
    });
    expect(recap.channels.find((row) => row.channel === "pos")).toEqual({
      channel: "pos",
      orderCount: 1,
      totalIdr: REAL_IDR,
    });
    expect(
      recap.devices.find((row) => row.deviceId === deviceId),
    ).toMatchObject({ orderCount: 1, totalIdr: REAL_IDR });
    expect(deviceTotals(recap).orderCount).toBe(1);
    // The same recap as a day that only has the real order.
    expect(comparable(recap)).toEqual(comparable(await readRecap(realOnly)));
  });

  it("2: a non-cash training order (QRIS, card) does not enter the tender per method", async () => {
    const mixed = "2025-03-03";
    const realOnly = "2025-03-04";
    await seedSale({ date: mixed, totalIdr: REAL_IDR, method: "qris" });
    await seedSale({
      date: mixed,
      totalIdr: TRAINING_IDR,
      method: "qris",
      training: true,
    });
    await seedSale({
      date: mixed,
      totalIdr: 33_000,
      method: "card",
      training: true,
    });
    await seedSale({ date: realOnly, totalIdr: REAL_IDR, method: "qris" });

    const recap = await readRecap(mixed);
    expect(recap.totalSalesIdr).toBe(REAL_IDR);
    expect(tender(recap, "qris")).toEqual({
      method: "qris",
      capturedIdr: REAL_IDR,
      refundedIdr: 0,
      netIdr: REAL_IDR,
    });
    // A method used only by training orders carries no money.
    expect(tender(recap, "card")?.capturedIdr ?? 0).toBe(0);
    expect(sum(recap.tenders.map((row) => row.capturedIdr))).toBe(REAL_IDR);
    expect(comparable(recap)).toEqual(comparable(await readRecap(realOnly)));
  });

  it("3: the void of a training order changes neither voidedOrderCount nor voidedAmountIdr; a real void still counts", async () => {
    const date = "2025-03-05";
    const real = await seedSale({ date, totalIdr: REAL_IDR });
    const realVoided = await seedSale({ date, totalIdr: REAL_IDR });
    const training = await seedSale({
      date,
      totalIdr: TRAINING_IDR,
      training: true,
    });
    await seedVoid(realVoided, REAL_IDR);
    await seedVoid(training, TRAINING_IDR);
    expect(real).not.toBe(realVoided);

    const recap = await readRecap(date);
    // Void figures first: they must hold on their own, not only through sales.
    expect(recap.totalVoidsIdr).toBe(REAL_IDR);
    expect(deviceTotals(recap)).toMatchObject({
      voidedOrderCount: 1,
      voidedAmountIdr: REAL_IDR,
    });
    expect(recap.totalSalesIdr).toBe(2 * REAL_IDR);
    expect(deviceTotals(recap).orderCount).toBe(2);
    expect(tender(recap, "cash")).toEqual({
      method: "cash",
      capturedIdr: 2 * REAL_IDR,
      refundedIdr: REAL_IDR,
      netIdr: REAL_IDR,
    });
  });

  it("4: the refund of a training order changes neither refundCount nor refundAmountIdr; a real refund still counts", async () => {
    const date = "2025-03-06";
    const realRefunded = await seedSale({ date, totalIdr: REAL_IDR });
    const training = await seedSale({
      date,
      totalIdr: TRAINING_IDR,
      training: true,
    });
    await seedRefund(realRefunded, 20_000);
    await seedRefund(training, 15_000);

    const recap = await readRecap(date);
    // Refund figures first: they must hold on their own, not only through sales.
    expect(recap.totalRefundsIdr).toBe(20_000);
    expect(deviceTotals(recap)).toMatchObject({
      refundCount: 1,
      refundAmountIdr: 20_000,
    });
    expect(recap.totalSalesIdr).toBe(REAL_IDR);
    expect(deviceTotals(recap).orderCount).toBe(1);
    expect(tender(recap, "cash")).toEqual({
      method: "cash",
      capturedIdr: REAL_IDR,
      refundedIdr: 20_000,
      netIdr: REAL_IDR - 20_000,
    });
  });

  it("5 (control): a day without training orders keeps its figures (pos-day.test.ts amounts: sales, one refund, one void, two channels)", async () => {
    const date = "2025-03-07";
    await seedSale({ date, totalIdr: REAL_IDR });
    const refunded = await seedSale({ date, totalIdr: REAL_IDR });
    const voided = await seedSale({ date, totalIdr: REAL_IDR });
    await seedSale({ date, totalIdr: GOFOOD_IDR, channel: "gofood" });
    await seedRefund(refunded, 25_000);
    await seedVoid(voided, REAL_IDR);

    const allSales = 3 * REAL_IDR + GOFOOD_IDR;
    const recap = await readRecap(date);
    expect(recap).toMatchObject({
      status: "open",
      totalSalesIdr: allSales,
      totalRefundsIdr: 25_000,
      totalVoidsIdr: REAL_IDR,
    });
    expect(tender(recap, "cash")).toEqual({
      method: "cash",
      capturedIdr: allSales,
      refundedIdr: 25_000 + REAL_IDR,
      netIdr: allSales - 25_000 - REAL_IDR,
    });
    expect(sum(recap.tenders.map((row) => row.netIdr))).toBe(
      recap.totalSalesIdr - recap.totalRefundsIdr - recap.totalVoidsIdr,
    );
    expect(recap.channels).toHaveLength(2);
    expect(recap.channels).toEqual(
      expect.arrayContaining([
        { channel: "pos", orderCount: 3, totalIdr: 3 * REAL_IDR },
        { channel: "gofood", orderCount: 1, totalIdr: GOFOOD_IDR },
      ]),
    );
    expect(deviceTotals(recap)).toEqual({
      orderCount: 4,
      totalIdr: allSales,
      voidedOrderCount: 1,
      voidedAmountIdr: REAL_IDR,
      refundCount: 1,
      refundAmountIdr: 25_000,
    });
  });

  it("6: a day with only training orders recaps as empty (all zero) and closes without an imbalance error", async () => {
    const date = "2025-03-08";
    const training = await seedSale({
      date,
      totalIdr: TRAINING_IDR,
      training: true,
    });
    await seedSale({
      date,
      totalIdr: 33_000,
      method: "qris",
      training: true,
    });
    await seedRefund(training, 10_000);
    await seedVoid(training, TRAINING_IDR);

    const recap = await readRecap(date);
    expect(recap).toMatchObject({
      status: "open",
      totalSalesIdr: 0,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
      totalVarianceIdr: 0,
    });
    expect(deviceTotals(recap)).toEqual({
      orderCount: 0,
      totalIdr: 0,
      voidedOrderCount: 0,
      voidedAmountIdr: 0,
      refundCount: 0,
      refundAmountIdr: 0,
    });
    expect(sum(recap.tenders.map((row) => row.capturedIdr))).toBe(0);
    expect(sum(recap.channels.map((row) => row.orderCount))).toBe(0);
    expect(sum(recap.channels.map((row) => row.totalIdr))).toBe(0);

    const closed = await day(date).close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const closedRecap = endOfDayRecapSchema.parse(closed.body.data);
    expect(closedRecap).toMatchObject({
      status: "closed",
      totalSalesIdr: 0,
      totalRefundsIdr: 0,
      totalVoidsIdr: 0,
    });
    const { rows } = await owner.query<{
      order_count: number;
      total_sales_idr: string;
    }>(
      `SELECT order_count, total_sales_idr FROM pos_daily_closes
       WHERE tenant_id = $1 AND outlet_id = $2 AND business_date = $3`,
      [tenant.tenantId, tenant.outletId, date],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.order_count).toBe(0);
    expect(Number(rows[0]!.total_sales_idr)).toBe(0);
  });
});

// ---- Round 2 (CTO decision: a hanging training order does not hold the close) ----

describe("POS-05 legend-fbxzw round 2: unfinished training orders and mixed voids", () => {
  it("R2-1: an unfinished training order does not block the day close", async () => {
    // Assumption: "unfinished" = status draft / awaiting_payment / sent (neither completed nor voided).
    const trainingDay = "2025-03-09";
    await seedSale({ date: trainingDay, totalIdr: REAL_IDR });
    await seedUnfinished({
      date: trainingDay,
      training: true,
      status: "draft",
    });
    await seedUnfinished({
      date: trainingDay,
      training: true,
      status: "sent",
    });

    const closed = await day(trainingDay).close();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(endOfDayRecapSchema.parse(closed.body.data)).toMatchObject({
      status: "closed",
      totalSalesIdr: REAL_IDR,
    });
    expect(await dailyCloseRowCount(trainingDay)).toBe(1);
  });

  it("R2-2 (control): an unfinished real order still blocks the day close", async () => {
    // The same hanging orders as R2-1, but real: the close must stay refused.
    for (const [date, status] of [
      ["2025-03-10", "draft"],
      ["2025-03-11", "sent"],
    ] as const) {
      await seedSale({ date, totalIdr: REAL_IDR });
      await seedUnfinished({ date, status });
      const refused = await day(date).close();
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(JSON.stringify(refused.body)).toContain(
        "Masih ada pesanan yang belum selesai.",
      );
      expect(await dailyCloseRowCount(date)).toBe(0);
    }
  });

  it("R2-3: a real void and a training void on one day with the same tender method and different amounts count only the real one", async () => {
    // Expected to pass at once: the code is already right; this test pins the
    // per-method allocation (cash refunded = real void only) against regression.
    const date = "2025-03-12";
    const realVoided = await seedSale({ date, totalIdr: REAL_IDR });
    const trainingVoided = await seedSale({
      date,
      totalIdr: 77_000,
      training: true,
    });
    await seedVoid(realVoided, 40_000);
    await seedVoid(trainingVoided, 70_000);

    const recap = await readRecap(date);
    expect(recap.totalVoidsIdr).toBe(40_000);
    expect(deviceTotals(recap)).toMatchObject({
      voidedOrderCount: 1,
      voidedAmountIdr: 40_000,
    });
    expect(recap.totalSalesIdr).toBe(REAL_IDR);
    expect(tender(recap, "cash")).toEqual({
      method: "cash",
      capturedIdr: REAL_IDR,
      refundedIdr: 40_000,
      netIdr: REAL_IDR - 40_000,
    });
  });
});
