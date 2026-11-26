// Receipt gaps at Tutup Hari and in the shift report (bead legend-ain0; PRD
// v1.7 §3 F8, POS-06). The contract already exists: `closePosDay` refuses with
// RECEIPT_SEQUENCE_GAP while a device of the day has a missing receipt number,
// and the shift report lists the missing numbers (both read
// `posReceiptGapsPort`). The port defaulted to "no gaps"; app.ts now installs
// `receiptGapsForDevice` and this test installs it the same way.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant. Drafts come from HTTP; owner SQL makes them completed
// orders of a device (zero-value, so the money identity stays trivial) and
// seeds sequences and receipts, as in pos-receipt.test.ts (whose helpers are
// copied here, that file is not edited). Each scenario uses its own outlet.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/pos-day-receipt-gaps.test.ts" pnpm test

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { formatReceiptNumber } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { pullDeviceRegistry } from "../services/edge-device-sync.ts";
import { setPosReceiptGapsPort } from "../services/pos-shift-ports.ts";
import {
  allocateReceipt,
  receiptGapsForDevice,
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

/** An open shift of the device (owner SQL; the shift report reads it). */
async function openShift(
  outletId: string,
  deviceId: string,
  businessDate: string,
): Promise<string> {
  const shiftId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), 100000, $7, $8)`,
    [
      shiftId,
      tenant.tenantId,
      outletId,
      deviceId,
      cashier.userId,
      businessDate,
      randomUUID(),
      "0".repeat(64),
    ],
  );
  return shiftId;
}

beforeAll(async () => {
  app = createApp();
  // Same wiring as app.ts (legend-ain0); other test files reset it to null.
  setPosReceiptGapsPort(receiptGapsForDevice);
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
  // Final orders and audit rows are immutable, so the isolated tenant stays in
  // the disposable database; give it a valid creator for the tenant list.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("receipt gaps at Tutup Hari (legend-ain0, POS-06)", () => {
  it("a device run 1, 2, 4 refuses the day close with RECEIPT_SEQUENCE_GAP and writes nothing", async () => {
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "HOLE",
      lastNumber: 4,
      present: [1, 2, 4],
    });
    const refused = await closeDay(outletId, run.businessDate);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("RECEIPT_SEQUENCE_GAP");
    expect(await dailyCloseCount(outletId)).toBe(0);
  });

  it("the shift report of the device lists the missing number [3]", async () => {
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "SHFT",
      lastNumber: 4,
      present: [1, 2, 4],
    });
    const shiftId = await openShift(outletId, run.deviceId, run.businessDate);
    const report = await cashier.client
      .get(
        `/api/outlets/${encodeURIComponent(outletId)}/pos/shifts/${encodeURIComponent(shiftId)}`,
      )
      .set(headers)
      .set(originHeader);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    // legend-nhmct: gaps are listed per run, with the printed number and prefix.
    expect(report.body.data.receiptGaps).toEqual([
      {
        prefix: "SHFT",
        missing: ["SHFT-000003"],
        lostRange: null,
        writtenOff: [],
      },
    ]);
  });

  it("a gap-free run closes the day, and a hole elsewhere in the outlet does not matter to other outlets", async () => {
    const outletId = await freshOutlet();
    const run = await seedRun(outletId, {
      prefix: "FULL",
      lastNumber: 2,
      present: [1, 2],
    });
    const closed = await closeDay(outletId, run.businessDate);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);
  });

  it("the port returns [] for a device with no sequence and for an empty run (legend-nhmct: no run entries)", async () => {
    const outletId = await freshOutlet();
    const none = await setAndAsk(outletId, randomUUID());
    expect(none).toEqual([]);
    const fresh = await seedRun(outletId, {
      prefix: "ZERO",
      lastNumber: 0,
      present: [],
    });
    expect(await setAndAsk(outletId, fresh.deviceId)).toEqual([]);
  });

  it("S-K1 an edge pull never inserts an advanced cloud run (lastNumber 40); a fresh one (0) closes the day after one edge sale with no gap", async () => {
    const outletId = await freshOutlet();
    const advanced = pulledSequence(outletId, "P8", 40);
    const fresh = pulledSequence(outletId, "P1", 0);
    // legend-zsdd: the edge's own edge_nodes row carries the instance the
    // pulled sequences are bound to (an edge sells only on a matching binding).
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
         VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, $5)
         ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
        [
          EDGE_OWN.edgeNodeId,
          tenant.tenantId,
          outletId,
          "b".repeat(64),
          EDGE_OWN.edgeInstanceId,
        ],
      ),
    );
    const pulled = await inEdgeMode(() =>
      pullDeviceRegistry({
        context: edgeContext(outletId),
        role: "primary",
        binding: EDGE_OWN,
        fetchPage: async () => ({
          data: [],
          receiptSequences: [advanced, fresh],
          meta: { limit: 100, nextCursor: null, watermark: null },
        }),
      }),
    );
    expect(pulled.receiptSequencesRefused).toBe(1);
    const sequences = await owner.query(
      `SELECT device_id, last_number FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outletId],
    );
    expect(sequences.rows).toEqual([
      { device_id: fresh.deviceId, last_number: 0 },
    ]);

    // One edge sale on the fresh run, then Tutup Hari on the edge (the sale is
    // made on the edge too: 1269 E3 refuses it in the cloud, POS_WRITE_ON_EDGE).
    const orderId = await inEdgeMode(() => draftOrder(outletId));
    const businessDate = await inEdgeMode(() =>
      completeAsDevice(orderId, fresh.deviceId),
    );
    const receipt = await inEdgeMode(() =>
      withTenant(db, edgeContext(outletId), (tx) =>
        allocateReceipt(tx as never, edgeContext(outletId), {
          orderId,
          outletId,
          deviceId: fresh.deviceId,
          at: new Date(),
        }),
      ),
    );
    expect(receipt.number).toBe("P1-000001");
    const closed = await inEdgeMode(() => closeDay(outletId, businessDate));
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await dailyCloseCount(outletId)).toBe(1);
  });

  it("app.ts installs the real port (the default would report no gaps)", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain("setPosReceiptGapsPort(receiptGapsForDevice)");
    // legend-6b0ld: the outlet-wide port is installed too.
    expect(source).toContain("setPosOutletReceiptGapsPort(");
  });
});

async function setAndAsk(outletId: string, deviceId: string) {
  const { db } = await import("../db/index.ts");
  const { withTenant } = await import("../db/tenant.ts");
  const { establishScopedTenantContext, establishTenantContext } =
    await import("@starter/shared/core/server");
  const { tenantIdSchema } = await import("@starter/shared/core");
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) =>
    receiptGapsForDevice(tx as never, context, { outletId, deviceId }),
  );
}

// ---- S-K1 helpers (edge pull, edge sale) -------------------------------------

function edgeContext(outletId: string) {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}

function pulledSequence(outletId: string, prefix: string, lastNumber: number) {
  return {
    id: randomUUID(),
    outletId,
    deviceId: randomUUID(),
    prefix,
    lastNumber,
    // legend-zsdd: pulled sequences are bound to the applying edge database.
    ...EDGE_OWN,
  };
}

const EDGE_OWN = { edgeNodeId: randomUUID(), edgeInstanceId: randomUUID() };

/** Runs `run` with edge mode on and always restores the previous state. */
async function inEdgeMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
}

/** Owner SQL: the draft becomes a zero-value completed order of the device. */
async function completeAsDevice(
  orderId: string,
  deviceId: string,
): Promise<string> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const orderUuid = ulidToUuid(orderId);
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
    return done.rows[0]!.business_date;
  });
}
