// Unsynced receipts on the Tutup Hari recap (bead legend-21c8n, card of
// legend-1130). Assumption (the spec names no field, the card does): "belum
// sinkron" is what the cloud can know, i.e. the receipt numbers its sequence
// head says were issued but pos_receipts does not hold (the same outlet-wide
// gaps that block the close with RECEIPT_SEQUENCE_GAP, minus numbers the owner
// wrote off). The recap carries their total as `unsyncedReceiptCount`; it is
// 0 on a gap-free day. A receipt the edge issued but never reported at all
// cannot be seen by the cloud and is out of scope.
// The field is read from the raw JSON of the recap response.
//
// Harness copied from pos-day-receipt-gaps.test.ts (real app, RBAC, RLS).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-day-recap-unsynced-receipts-1130.test.ts" heavy pnpm test

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { formatReceiptNumber } from "@starter/shared/pos";
import { createApp } from "../app.ts";
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

/**
 * Owner-side seed: a device run that stopped at `lastNumber` and holds the
 * receipts of `present` only. Each receipt needs an order; the orders are made
 * completed orders of the device (so the day recap lists the device) with zero
 * amounts (so the recap money identity holds without tenders).
 */
async function seedRun(
  outletId: string,
  input: { prefix: string; lastNumber: number; present: number[] },
): Promise<{ deviceId: string; businessDate: string }> {
  const deviceId = randomUUID();
  const sequenceId = randomUUID();
  const orderIds: string[] = [];
  for (let n = 0; n < input.present.length; n += 1)
    orderIds.push(await draftOrder(outletId));
  const businessDate = await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sequenceId,
        tenant.tenantId,
        outletId,
        deviceId,
        input.prefix,
        input.lastNumber,
      ],
    );
    let date = "";
    for (const [index, ordinal] of input.present.entries()) {
      const orderUuid = ulidToUuid(orderIds[index]!);
      await client.query(
        `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [tenant.tenantId, orderUuid, deviceId],
      );
      const done = await client.query<{ business_date: string }>(
        `UPDATE orders
            SET subtotal_idr = 0, discount_idr = 0, service_charge_idr = 0,
                tax_idr = 0, rounding_idr = 0, total_idr = 0, status = 'completed'
          WHERE tenant_id = $1 AND id = $2::uuid
          RETURNING business_date::text AS business_date`,
        [tenant.tenantId, orderUuid],
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
          formatReceiptNumber(input.prefix, ordinal),
          ordinal,
          SEED_SNAPSHOT,
        ],
      );
    }
    return date;
  });
  return { deviceId, businessDate };
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

describe("day recap unsynced receipts (legend-21c8n)", () => {
  function recapOf(outletId: string, businessDate: string) {
    return manager.client
      .get(`/api/outlets/${encodeURIComponent(outletId)}/pos/day`)
      .query({ businessDate })
      .set(headers)
      .set(originHeader);
  }

  it("a run 1, 2, 4 (head 4) shows unsyncedReceiptCount 1 on the recap", async () => {
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "UNS1",
      lastNumber: 4,
      present: [1, 2, 4],
    });
    const recap = await recapOf(outletId, run.businessDate);
    expect(recap.status, JSON.stringify(recap.body)).toBe(200);
    expect(recap.body.data.unsyncedReceiptCount).toBe(1);
  });

  it("every missing number counts: a run 1, 3, 6 (head 6) shows 3", async () => {
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "UNS3",
      lastNumber: 6,
      present: [1, 3, 6],
    });
    const recap = await recapOf(outletId, run.businessDate);
    expect(recap.status, JSON.stringify(recap.body)).toBe(200);
    expect(recap.body.data.unsyncedReceiptCount).toBe(3);
  });

  it("a gap-free day shows unsyncedReceiptCount 0, before and after the close", async () => {
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "UNS0",
      lastNumber: 2,
      present: [1, 2],
    });
    const open = await recapOf(outletId, run.businessDate);
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body.data.unsyncedReceiptCount).toBe(0);
    const closed = await manager.client
      .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/day/close`)
      .set(headers)
      .set(originHeader)
      .send({
        businessDate: run.businessDate,
        inventoryDeduction: false,
        idempotencyKey: randomUUID(),
      });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.unsyncedReceiptCount).toBe(0);
    const after = await recapOf(outletId, run.businessDate);
    expect(after.body.data.unsyncedReceiptCount).toBe(0);
  });

  it("a hole in another outlet does not count here", async () => {
    const holed = await freshOutlet();
    await seedRun(holed, { prefix: "UNSH", lastNumber: 3, present: [1, 3] });
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "UNSG",
      lastNumber: 1,
      present: [1],
    });
    const recap = await recapOf(outletId, run.businessDate);
    expect(recap.status, JSON.stringify(recap.body)).toBe(200);
    expect(recap.body.data.unsyncedReceiptCount).toBe(0);
  });
});
