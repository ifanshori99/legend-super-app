// Tutup Hari checks every receipt run of the outlet (bead legend-6b0ld, POS-06:
// no acceptable gap). Before this, only devices with activity on the business
// date were checked, so a hole in a device without activity that day, in a
// retired run, or in the outlet-owned cloud sequence (device_id = outlet_id,
// prefix C) never blocked the close.
//
// Assumptions (spec is the brief, not a document):
// - a device is "inactive" on the business date when none of its completed
//   orders, shifts or cash movements fall on that date; the seed puts its
//   orders one business day earlier (orders.business_date - 1), so it is
//   outside the day recap's device list;
// - a lost range (edge_regressed, edge_reported_number > last_number) with no
//   missing ordinal stays non-blocking, as in pos-receipt-gaps-prefix.test.ts;
// - the outlet port is installed exactly as app.ts does (adapter over
//   receiptGapsForOutletFast).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant; helpers are copied from pos-receipt-gaps-prefix.test.ts.
// Each scenario uses its own outlet.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-day-close-all-gaps.test.ts" pnpm test

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { formatReceiptNumber } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  setPosOutletReceiptGapsPort,
  setPosReceiptGapsPort,
} from "../services/pos-shift-ports.ts";
import {
  receiptGapsForDevice,
  receiptGapsForOutletFast,
} from "../services/pos-receipt.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const SEED_SNAPSHOT = JSON.stringify({
  outletName: "Cafe Legend Senopati",
  outletAddress: "Jl. Kopi Legenda No. 12, Jakarta Selatan",
  legalName: null,
  npwpLast4: null,
});

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
  managerRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let manager: Member;

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body.error?.code ?? body.code;

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

/** An outlet with its own price list, so a draft can be made there. */
async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Legend Senopati', 'Jl. Kopi Legenda No. 12, Jakarta Selatan', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `G${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceListId, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, ids.kopi, KOPI_IDR],
    );
  });
  return outletId;
}

async function draftOrder(outletId: string): Promise<string> {
  const created = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

function closeDay(outletId: string, businessDate: string) {
  return manager.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/day/close`)
    .set(headers)
    .set(originHeader)
    .send({
      businessDate,
      inventoryDeduction: false,
      idempotencyKey: randomUUID(),
    });
}

async function dailyCloseCount(outletId: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_daily_closes WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  );
  return rows.length;
}

beforeAll(async () => {
  app = createApp();
  // Same wiring as app.ts (legend-ain0); other test files reset it to null.
  setPosReceiptGapsPort(receiptGapsForDevice);
  setPosOutletReceiptGapsPort((tx, context, { outletId }) =>
    receiptGapsForOutletFast(tx, context, outletId),
  );
  tenant = await createIsolatedTenant(`gap-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "Kasir Celah Struk",
      ["order.view", "pos.sale.create", "shift.cash.operate"],
    ],
    [ids.managerRole, "Manajer Celah Struk", ["pos.day.close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "Kasir Celah");
  manager = await member(ids.managerRole, "Manajer Celah");
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Celah Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    // A draft needs published tax settings and a rule for the item.
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-GAP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
}, 120_000);

afterAll(async () => {
  setPosReceiptGapsPort(null);
  setPosOutletReceiptGapsPort(null);
  // Final orders and audit rows are immutable, so the isolated tenant stays in
  // the disposable database; give it a valid creator for the tenant list.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

type RunSeed = {
  prefix: string;
  lastNumber: number;
  present: number[];
  /** Offset in minutes before now, so runs have a stable age order. */
  ageMinutes: number;
  /** Set for a retired run; omitted for the current run. */
  retired?: { reason: string; edgeReportedNumber: number };
};

/**
 * Owner-side seed: one device (or the outlet-owned cloud sequence when
 * `deviceId` is the outlet id) with several runs. Every receipt gets its own
 * zero-value completed order. `daysBefore` moves those orders to an earlier
 * business date, so the device has no activity on the closing date.
 */
async function seedDevice(
  outletId: string,
  runs: RunSeed[],
  options: { deviceId?: string; daysBefore?: number } = {},
): Promise<{ deviceId: string; businessDate: string }> {
  const deviceId = options.deviceId ?? randomUUID();
  const daysBefore = options.daysBefore ?? 0;
  const total = runs.reduce((sum, run) => sum + run.present.length, 0);
  const orderIds: string[] = [];
  for (let n = 0; n < total; n += 1) orderIds.push(await draftOrder(outletId));
  let next = 0;
  const businessDate = await asOwnerTenant(tenant.tenantId, async (client) => {
    let date = "";
    for (const run of runs) {
      const sequenceId = randomUUID();
      await client.query(
        `INSERT INTO receipt_sequences
           (id, tenant_id, outlet_id, device_id, prefix, last_number,
            edge_reported_number, retired_at, retired_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE now() END,
                 $8::text,
                 now() - ($9::int * interval '1 minute'))`,
        [
          sequenceId,
          tenant.tenantId,
          outletId,
          deviceId,
          run.prefix,
          run.lastNumber,
          run.retired?.edgeReportedNumber ?? 0,
          run.retired?.reason ?? null,
          run.ageMinutes,
        ],
      );
      for (const ordinal of run.present) {
        const orderUuid = ulidToUuid(orderIds[next]!);
        next += 1;
        await client.query(
          `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
          [tenant.tenantId, orderUuid, deviceId],
        );
        const done = await client.query<{ business_date: string }>(
          `UPDATE orders
              SET subtotal_idr = 0, discount_idr = 0, service_charge_idr = 0,
                  tax_idr = 0, rounding_idr = 0, total_idr = 0, status = 'completed',
                  business_date = business_date - $3::int
            WHERE tenant_id = $1 AND id = $2::uuid
            RETURNING business_date::text AS business_date`,
          [tenant.tenantId, orderUuid, daysBefore],
        );
        date = done.rows[0]!.business_date;
        await client.query(
          `INSERT INTO pos_receipts
             (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
          [
            tenant.tenantId,
            outletId,
            orderUuid,
            sequenceId,
            deviceId,
            formatReceiptNumber(run.prefix, ordinal),
            ordinal,
            SEED_SNAPSHOT,
          ],
        );
      }
    }
    return date;
  });
  return { deviceId, businessDate };
}

/** The active device: one clean run, completed orders on the closing date. */
function seedActiveDevice(outletId: string) {
  return seedDevice(outletId, [
    { prefix: "AC", lastNumber: 2, present: [1, 2], ageMinutes: 10 },
  ]);
}

/** Sequences of the outlet that miss ordinals (what the outlet port reports). */
async function outletGaps(outletId: string) {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) =>
    receiptGapsForOutletFast(tx as never, context, outletId),
  );
}

describe("Tutup Hari checks every receipt run of the outlet (legend-6b0ld)", () => {
  it("a device without activity that day, with a hole in a retired run, blocks the close", async () => {
    const outletId = await freshOutlet();
    const active = await seedActiveDevice(outletId);
    const idle = await seedDevice(
      outletId,
      [
        {
          prefix: "ID",
          lastNumber: 3,
          present: [1, 3],
          ageMinutes: 60,
          retired: { reason: "claim_rotated", edgeReportedNumber: 0 },
        },
        { prefix: "IE", lastNumber: 1, present: [1], ageMinutes: 30 },
      ],
      { daysBefore: 1 },
    );
    // Precondition: B is outside the recap of the closing date.
    expect(idle.businessDate).not.toBe(active.businessDate);
    expect(await outletGaps(outletId)).toEqual([
      expect.objectContaining({ prefix: "ID", missing: [2] }),
    ]);

    const refused = await closeDay(outletId, active.businessDate);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
    expect(await dailyCloseCount(outletId)).toBe(0);
  });

  it("a device without activity that day, with a hole in its current run, blocks the close", async () => {
    const outletId = await freshOutlet();
    const active = await seedActiveDevice(outletId);
    const idle = await seedDevice(
      outletId,
      [{ prefix: "IF", lastNumber: 4, present: [1, 2, 4], ageMinutes: 30 }],
      { daysBefore: 1 },
    );
    expect(idle.businessDate).not.toBe(active.businessDate);

    const refused = await closeDay(outletId, active.businessDate);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
    expect(await dailyCloseCount(outletId)).toBe(0);
  });

  it("a hole in the outlet cloud sequence (device_id = outlet_id, prefix C) blocks the close", async () => {
    const outletId = await freshOutlet();
    const active = await seedActiveDevice(outletId);
    await seedDevice(
      outletId,
      [{ prefix: "C", lastNumber: 3, present: [1, 3], ageMinutes: 30 }],
      { deviceId: outletId, daysBefore: 1 },
    );
    expect(await outletGaps(outletId)).toEqual([
      expect.objectContaining({ prefix: "C", missing: [2] }),
    ]);

    const refused = await closeDay(outletId, active.businessDate);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
    expect(await dailyCloseCount(outletId)).toBe(0);
  });

  it("an inactive device whose only issue is an edge_regressed lost range does not block the close", async () => {
    const outletId = await freshOutlet();
    const active = await seedActiveDevice(outletId);
    await seedDevice(
      outletId,
      [
        {
          prefix: "LR",
          lastNumber: 2,
          present: [1, 2],
          ageMinutes: 60,
          retired: { reason: "edge_regressed", edgeReportedNumber: 5 },
        },
        { prefix: "LS", lastNumber: 0, present: [], ageMinutes: 30 },
      ],
      { daysBefore: 1 },
    );
    // Lost range 3..5, nothing missing: the outlet port reports no gap.
    expect(await outletGaps(outletId)).toEqual([]);

    const closed = await closeDay(outletId, active.businessDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);
  });

  it("every run of the outlet clean (retired run, idle device, cloud sequence) closes the day", async () => {
    const outletId = await freshOutlet();
    const active = await seedActiveDevice(outletId);
    await seedDevice(
      outletId,
      [
        {
          prefix: "OK",
          lastNumber: 2,
          present: [1, 2],
          ageMinutes: 60,
          retired: { reason: "claim_rotated", edgeReportedNumber: 0 },
        },
        { prefix: "OL", lastNumber: 1, present: [1], ageMinutes: 30 },
      ],
      { daysBefore: 1 },
    );
    await seedDevice(
      outletId,
      [{ prefix: "C", lastNumber: 2, present: [1, 2], ageMinutes: 30 }],
      { deviceId: outletId, daysBefore: 1 },
    );
    expect(await outletGaps(outletId)).toEqual([]);

    const closed = await closeDay(outletId, active.businessDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);
  });

  it("a hole in another outlet does not block this outlet", async () => {
    const otherOutletId = await freshOutlet();
    await seedDevice(
      otherOutletId,
      [{ prefix: "XO", lastNumber: 3, present: [1, 3], ageMinutes: 30 }],
      { daysBefore: 1 },
    );
    expect(await outletGaps(otherOutletId)).toHaveLength(1);

    const outletId = await freshOutlet();
    const active = await seedActiveDevice(outletId);
    const closed = await closeDay(outletId, active.businessDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);
    expect(await dailyCloseCount(otherOutletId)).toBe(0);
  });
});
