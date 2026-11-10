// legend-8igcm: a swap's replacement line (order_items.id =
// order_issues.replacement_order_item_id) with line_total_idr = 0 is not a sale.
// Sales readers must not count its quantity, so quantity sold and average price
// stay unchanged. A replacement line with a real price (swap in an open order,
// then paid) is a sale and still counts. Real PostgreSQL, seeded per tenant,
// same pattern as ms-sales.test.ts.

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { dailyReaders } from "../services/metric-sources";
import { queryMenuPerformance } from "../services/ai-metrics/sales";
import { recomputeMetricsDaily } from "../services/metrics-daily.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const D1 = "2025-05-10";
const NOW = new Date("2025-09-15T05:00:00Z");
const date = (value: string) => businessDateSchema.parse(value);

let tenantId: string;
let outletId: string;
let menuA: string;
let menuB: string;
let userId: string;

function context(): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

async function seedOrder(
  number: string,
  lines: {
    key: string;
    menu: string;
    quantity: number;
    unit: number;
    status?: string;
  }[],
): Promise<Map<string, string>> {
  const orderId = randomUUID();
  const subtotal = lines.reduce((a, l) => a + l.quantity * l.unit, 0);
  await owner.query(
    `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
       subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
       status, business_date, placed_at)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5,
       'completed', $6, $7)`,
    [orderId, tenantId, outletId, number, subtotal, D1, `${D1}T05:00:00.000Z`],
  );
  const ids = new Map<string, string>();
  for (const l of lines) {
    const id = randomUUID();
    ids.set(l.key, id);
    await owner.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
         unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, 'Menu', $6, $7, 0, $8, 'fired', $9, $10)`,
      [
        id,
        tenantId,
        outletId,
        orderId,
        l.menu,
        l.quantity,
        l.unit,
        l.quantity * l.unit,
        l.status ?? "served",
        D1,
      ],
    );
  }
  await owner.query(
    `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, cashier_id, is_training)
     VALUES ($1, $2, $3, 'pos', 'cashier-1', false)`,
    [orderId, tenantId, outletId],
  );
  return ids;
}

/** `order_issues` row: `original` was swapped for `replacement` (resolved). */
async function linkSwap(
  orderId: string,
  originalId: string,
  replacementId: string,
  replacementMenu: string,
) {
  await owner.query(
    `INSERT INTO order_issues (tenant_id, outlet_id, order_id, order_item_id, type, reason,
       reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
       cost_idr, status, idempotency_key, resolved_at)
     VALUES ($1, $2, $3, $4, 'unfulfillable', 'out_of_stock', 'Habis, ditukar', $5, 'swap',
       $6, $7, 0, 'resolved', $8, now())`,
    [
      tenantId,
      outletId,
      orderId,
      originalId,
      userId,
      replacementMenu,
      replacementId,
      `swap-sales-${randomUUID()}`,
    ],
  );
}

async function orderIdOf(itemId: string): Promise<string> {
  const { rows } = await owner.query<{ order_id: string }>(
    "SELECT order_id FROM order_items WHERE id = $1",
    [itemId],
  );
  return rows[0]!.order_id;
}

beforeAll(async () => {
  const tenant = await createIsolatedTenant(`sws-${randomUUID().slice(0, 6)}`);
  tenantId = tenant.tenantId;
  outletId = tenant.outletId;
  userId = `swap-sales-${randomUUID()}`;
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Pelapor', $2)`,
    [userId, `${userId}@example.test`],
  );
  const category = randomUUID();
  menuA = randomUUID();
  menuB = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Minuman')`,
    [category, tenantId, tenant.brandId],
  );
  for (const [id, name] of [
    [menuA, "Kopi Susu"],
    [menuB, "Nasi Goreng"],
  ] as const)
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, tenant.brandId, category, name],
    );

  // O1 (completed): menuA 2 x 32.000 sold; menuB 1 x 36.000 failed and kept
  // (completed order), swapped for a free menuA line (price 0).
  const o1 = await seedOrder("S1", [
    { key: "a", menu: menuA, quantity: 2, unit: 32_000 },
    { key: "old", menu: menuB, quantity: 1, unit: 36_000 },
    { key: "free", menu: menuA, quantity: 1, unit: 0 },
  ]);
  await linkSwap(
    await orderIdOf(o1.get("old")!),
    o1.get("old")!,
    o1.get("free")!,
    menuA,
  );
  // O2 (swap in an open order, then paid): old line voided, the replacement
  // carries a real price and is a sale.
  const o2 = await seedOrder("S2", [
    { key: "old", menu: menuB, quantity: 1, unit: 30_000, status: "voided" },
    { key: "paid", menu: menuB, quantity: 1, unit: 20_000 },
  ]);
  await linkSwap(
    await orderIdOf(o2.get("old")!),
    o2.get("old")!,
    o2.get("paid")!,
    menuB,
  );

  await recomputeMetricsDaily(
    context(),
    outletIdSchema.parse(outletId),
    date(D1),
    date(D1),
    {
      readers: dailyReaders().filter((entry) => entry.family === "sales"),
      now: NOW,
    },
  );
});

describe("swap replacement line is not a sale at price 0 (legend-8igcm)", () => {
  it("menu performance: qty and revenue skip the free line, keep the priced one", async () => {
    const rows = await queryMenuPerformance(context(), {
      outletIds: [outletId],
      from: D1,
      to: D1,
    });
    const byId = new Map(rows.map((row) => [row.menuItemId, row]));
    expect(byId.get(menuA)).toMatchObject({ qtySold: 2, revenueIdr: 64_000 });
    // menuB: kept original (36.000) + priced replacement (20.000).
    expect(byId.get(menuB)).toMatchObject({ qtySold: 2, revenueIdr: 56_000 });
  });

  it("sales metric source: menu_sold_qty skips the free line, keeps the priced one", async () => {
    const { rows } = await owner.query<{
      dimension_key: string | null;
      dimension_value: string | null;
      value_int: string;
    }>(
      `SELECT dimension_key, dimension_value, value_int FROM metrics_daily
        WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
          AND metric_code = 'menu_sold_qty'`,
      [tenantId, outletId, D1],
    );
    const qty = (key: string | null, value: string | null) =>
      Number(
        rows.find((r) => r.dimension_key === key && r.dimension_value === value)
          ?.value_int ?? NaN,
      );
    expect(qty("menu_item", menuA)).toBe(2);
    expect(qty("menu_item", menuB)).toBe(2);
    expect(qty(null, null)).toBe(4);
  });
});
