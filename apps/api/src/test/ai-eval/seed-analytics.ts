// Real source rows for the deterministic AIG-04 numeric comparisons.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type AnalyticsSeed = {
  tenantId: string;
  brandId: string;
  outletId: string;
  creatorId: string;
};

export async function seedAnalytics(client: PoolClient, seed: AnalyticsSeed) {
  const { tenantId, brandId, outletId, creatorId } = seed;
  const categoryId = randomUUID();
  const menuItemId = randomUUID();
  await client.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name)
     VALUES ($1, $2, $3, 'Eval beverages')`,
    [categoryId, tenantId, brandId],
  );
  await client.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name)
     VALUES ($1, $2, $3, $4, 'Eval kopi susu')`,
    [menuItemId, tenantId, brandId, categoryId],
  );
  // Include each week/month queried by the dataset, with a real menu row.
  for (const date of ["2031-01-05", "2031-02-05", "2031-03-03", "2031-03-10"]) {
    const orderId = randomUUID();
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 60000, 0, 0, 0, 0,
               60000, 'completed', $5, $6)`,
      [orderId, tenantId, outletId, `EA-${date}`, date, `${date}T05:00:00Z`],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name,
         quantity, unit_price_idr, modifiers_total_idr, line_total_idr, fire_status, status,
         reserved_business_date, cost_snapshot_idr)
       VALUES ($1, $2, $3, $4, $5, 'Eval kopi susu', 2, 30000, 0, 60000, 'fired',
               'served', $6, 15000)`,
      [randomUUID(), tenantId, outletId, orderId, menuItemId, date],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
       VALUES ($1, $2, $3, 'pos')`,
      [orderId, tenantId, outletId],
    );
    // Four events in the first week create both monthly and weekly spikes.
    if (date === "2031-03-03") {
      for (let index = 0; index < 4; index++) {
        const eventOrderId = randomUUID();
        await client.query(
          `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
             subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
             status, business_date, placed_at)
           VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 30000, 0, 0, 0, 0,
                   30000, 'completed', $5, $6)`,
          [
            eventOrderId,
            tenantId,
            outletId,
            `EA-void-${index}`,
            date,
            `${date}T06:00:00Z`,
          ],
        );
        await client.query(
          `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel)
           VALUES ($1, $2, $3, 'pos')`,
          [eventOrderId, tenantId, outletId],
        );
        await client.query(
          `INSERT INTO pos_order_voids (id, tenant_id, outlet_id, order_id, receipt_number,
             amount_idr, reason, reason_note, requested_by, approved_by, approval_request_id, voided_at)
           VALUES ($1, $2, $3, $4, $5, 30000, 'wrong_item', 'Eval void', $6, 'eval-supervisor', $7, $8)`,
          [
            randomUUID(),
            tenantId,
            outletId,
            eventOrderId,
            `EA-void-${index}`,
            creatorId,
            randomUUID(),
            `${date}T06:00:00Z`,
          ],
        );
        await client.query(
          `INSERT INTO pos_order_discounts (id, tenant_id, outlet_id, order_id, source, kind,
             amount_idr, reason, reason_note, applied_by, created_at)
           VALUES ($1, $2, $3, $4, 'manual', 'amount', 10000, 'loyal', 'Eval discount', $5, $6)`,
          [
            randomUUID(),
            tenantId,
            outletId,
            orderId,
            creatorId,
            `${date}T06:00:00Z`,
          ],
        );
      }
    }
  }

  const uomId = randomUUID();
  const locationId = randomUUID();
  await client.query(
    `INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, 'eval-kg', 'Eval kilogram')`,
    [uomId, tenantId],
  );
  await client.query(
    `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type)
     VALUES ($1, $2, $3, 'Eval warehouse', 'warehouse')`,
    [locationId, tenantId, outletId],
  );
  for (const name of [
    "kopi",
    "susu",
    "gula",
    "tepung",
    "ayam",
    "telur",
    "beras",
    "minyak",
    "bawang",
  ]) {
    const itemId = randomUUID();
    await client.query(
      `INSERT INTO inventory_items (id, tenant_id, name, category, base_uom_id, par_min)
       VALUES ($1, $2, $3, 'bahan', $4, 10)`,
      [itemId, tenantId, name, uomId],
    );
    await client.query(
      `INSERT INTO stock_balances (tenant_id, outlet_id, location_id, inventory_item_id, quantity, avg_cost_idr)
       VALUES ($1, $2, $3, $4, 4, 1000)`,
      [tenantId, outletId, locationId, itemId],
    );
  }

  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitId = randomUUID();
  const productId = randomUUID();
  await client.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
       arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, 'Eval shower', 'shower', 60, 10, 10, $4, $5, $6)`,
    [
      facilityId,
      tenantId,
      outletId,
      JSON.stringify([
        {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "08:00",
          closesAt: "20:00",
        },
      ]),
      JSON.stringify({
        graceMinutes: 5,
        blockMinutes: 15,
        feePerBlockIdr: 5000,
      }),
      JSON.stringify({
        freeCancelMinutesBefore: 30,
        lateCancelResolution: "no_refund",
        lateCancelFeeIdr: 0,
        noShowResolution: "no_refund",
      }),
    ],
  );
  await client.query(
    `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
     VALUES ($1, $2, $3, $4, 'Eval area', 0)`,
    [areaId, tenantId, outletId, facilityId],
  );
  await client.query(
    `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
     VALUES ($1, $2, $3, $4, $5, 'EA1', 'available', 0)`,
    [unitId, tenantId, outletId, facilityId, areaId],
  );
  await client.query(
    `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
     VALUES ($1, $2, $3, $4, 'Eval ticket', 'single', 50000, 1)`,
    [productId, tenantId, outletId, facilityId],
  );
  await client.query(
    `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id,
       customer_profile_id, product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes,
       status, overtime_fee_idr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', '2031-03-03T05:00:00Z',
             '2031-03-03T06:00:00Z', '2031-03-03T06:10:00Z', 10, 'completed', 0)`,
    [
      randomUUID(),
      tenantId,
      outletId,
      facilityId,
      areaId,
      unitId,
      randomUUID(),
      productId,
    ],
  );
}
