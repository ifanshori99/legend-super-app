// POS tax snapshot facility (legend-bjy6). Expected behavior: a POS sale that
// is paid and completed writes its tax_snapshots (the tax report source)
// exactly once per tax rule, and the snapshot tax/service amounts add up to
// the totals stored on the order. Replaying pay/complete changes nothing.
//
// Real Express app + PostgreSQL (disposable server from `pnpm test`) in a
// fresh isolated tenant. Fixture follows pos-order.test.ts: PBJT 10% on F&B,
// menu prices exclude tax, no service charge: 2 x Rp25.000 -> tax Rp5.000,
// total Rp55.000.
//
// Assumptions: the POS snapshot is keyed by the order id (source_id) like the
// QR one in ws03-inclusive-order.test.ts; source_type is not asserted. A
// replayed tender/complete may be accepted or refused (status < 500); the
// test asserts only that the snapshot rows stay the same in content and count.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
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
  taxRule: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };

/** Gapless per outlet, idempotent per order: stands in for the receipt allocator. */
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
        number: `POS1-${String(next).padStart(6, "0")}`,
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
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (
      orderId: string,
      expectedStatus: string,
      receivedIdr: number,
      idempotencyKey: string = randomUUID(),
    ) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
        idempotencyKey,
      }),
    complete: (
      orderId: string,
      expectedStatus: string,
      idempotencyKey: string = randomUUID(),
    ) => send(`/${orderId}/complete`, { expectedStatus, idempotencyKey }),
  };
}

type Sale = {
  orderId: string;
  paidKey: string;
  completeKey: string;
  totalIdr: number;
};

/** create -> submit -> cash tender -> complete. */
async function completedSale(): Promise<Sale> {
  const paidKey = randomUUID();
  const completeKey = randomUUID();
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await pos().cash(orderId, status, totalIdr + 5_000, paidKey);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  status = paid.body.data.order.status as string;
  const completed = await pos().complete(orderId, status, completeKey);
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe("completed");
  return { orderId, paidKey, completeKey, totalIdr };
}

type SnapshotRow = {
  id: string;
  created_at: string;
  tax_rule_id: string;
  tax_base_idr: string;
  service_charge_idr: string;
  tax_idr: string;
};

async function snapshots(orderId: string): Promise<SnapshotRow[]> {
  const { rows } = await owner.query<SnapshotRow>(
    `SELECT id::text, created_at::text, tax_rule_id::text, tax_base_idr::text, service_charge_idr::text, tax_idr::text
       FROM tax_snapshots
      WHERE tenant_id = $1 AND source_id = $2
      ORDER BY tax_rule_id`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows;
}

async function storedOrder(orderId: string) {
  const { rows } = await owner.query<{
    subtotal_idr: string;
    service_charge_idr: string;
    tax_idr: string;
    total_idr: string;
  }>(
    `SELECT subtotal_idr::text, service_charge_idr::text, tax_idr::text, total_idr::text
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  const row = rows[0];
  if (!row) throw new Error("order row missing");
  return {
    subtotal: Number(row.subtotal_idr),
    service: Number(row.service_charge_idr),
    tax: Number(row.tax_idr),
    total: Number(row.total_idr),
  };
}

const sum = (rows: SnapshotRow[], column: keyof SnapshotRow): number =>
  rows.reduce((acc, row) => acc + Number(row[column]), 0);

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`pts-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Snapshot', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "POS Kasir Snapshot");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  // Cash tenders need the cashier's open shift on the registered device.
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
       VALUES ($1, $2, $3, 'POS Snapshot', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-SNAP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  // Final orders are immutable; the isolated tenant stays in the disposable
  // database. Give it a valid creator so the platform tenant list parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("POS tax snapshots (legend-bjy6)", () => {
  it("a completed sale has one snapshot per tax rule that adds up to the order totals", async () => {
    const sale = await completedSale();
    expect(sale.totalIdr).toBe(55_000);

    const rows = await snapshots(sale.orderId);
    // One rule applies, so exactly one row, for that rule.
    expect(rows.map((row) => row.tax_rule_id)).toEqual([ids.taxRule]);

    const order = await storedOrder(sale.orderId);
    expect(order).toEqual({
      subtotal: 50_000,
      service: 0,
      tax: 5_000,
      total: 55_000,
    });
    expect(sum(rows, "tax_idr")).toBe(order.tax);
    expect(sum(rows, "service_charge_idr")).toBe(order.service);
    expect(sum(rows, "tax_base_idr")).toBe(order.subtotal);
  });

  it("each sale gets its own snapshot; another sale never touches an earlier one", async () => {
    const first = await completedSale();
    const before = await snapshots(first.orderId);
    const second = await completedSale();
    expect(second.orderId).not.toBe(first.orderId);
    expect(await snapshots(second.orderId)).toHaveLength(1);
    expect(await snapshots(first.orderId)).toEqual(before);
  });

  it("replaying pay and complete leaves the same snapshot rows, never a duplicate", async () => {
    const sale = await completedSale();
    const before = await snapshots(sale.orderId);
    expect(before).toHaveLength(1);

    const status = "completed";
    const replayPay = await pos().cash(
      sale.orderId,
      status,
      sale.totalIdr + 5_000,
      sale.paidKey,
    );
    expect(replayPay.status, JSON.stringify(replayPay.body)).toBeLessThan(500);
    const replayComplete = await pos().complete(
      sale.orderId,
      status,
      sale.completeKey,
    );
    expect(
      replayComplete.status,
      JSON.stringify(replayComplete.body),
    ).toBeLessThan(500);

    const after = await snapshots(sale.orderId);
    expect(after).toEqual(before);
    // Same row, not delete-and-reinsert: id and created_at must be unchanged.
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.created_at)).toEqual(
      before.map((row) => row.created_at),
    );
    const order = await storedOrder(sale.orderId);
    expect(sum(after, "tax_idr")).toBe(order.tax);
    expect(order.total).toBe(55_000);
  });

  it("an order that is created but not paid has no snapshot yet", async () => {
    const created = await pos().create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await snapshots(created.body.data.id as string)).toEqual([]);
  });
});
