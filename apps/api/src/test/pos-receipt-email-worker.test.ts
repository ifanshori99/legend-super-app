// E-receipt email worker wiring (bead legend-v3vo; PRD v1.7 §3 F11).
// `runPosReceiptEmailJob` existed but nothing called it, so queued e-receipt
// emails were never sent. Covers: a queued email goes out once through the job,
// a null provider fails closed like the PO job (rows stay queued, nothing
// counted, no attempt burned), and worker-main.ts registers the job.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-receipt-email-worker.test.ts" heavy pnpm test

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { FakeEmailProvider } from "@starter/shared/adapters";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import { createPosReceiptPort } from "../services/pos-receipt.service.ts";
import { runPosReceiptEmailJob } from "../worker/pos-receipt-email.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };

/** Owner-side access sets the tenant local, because RLS is FORCED. */
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

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Legend Senopati', 'Jl. Kopi Legenda No. 12', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `R${outletId.slice(0, 8)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant(async (client) => {
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

/** A completed cash sale on a registered device with the cashier's open shift. */
async function completedSale(outletId: string): Promise<string> {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir uji', $4)`,
      [deviceId, tenant.tenantId, outletId, new Date(issuedAt * 1000)],
    ),
  );
  const deviceHeaders = {
    Host: "localhost",
    [DEVICE_TOKEN_HEADER]: signDeviceToken({
      version: 1,
      tenantId: tenant.tenantId,
      brandId: tenant.brandId,
      deviceId,
      issuedAt,
    }),
  };
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos`;
  const post = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(deviceHeaders)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  const shift = await post("/shifts", { openingFloatIdr: 100_000 });
  expect(shift.status, JSON.stringify(shift.body)).toBe(201);
  const created = await post("/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await post(`/orders/${orderId}/submit`, {
      expectedStatus: status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await post(`/orders/${orderId}/tenders`, {
    method: "cash",
    receivedIdr: totalIdr + 5_000,
    expectedStatus: status,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await post(`/orders/${orderId}/complete`, {
    expectedStatus: paid.body.data.order.status as string,
  });
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return orderId;
}

/** Queues an e-receipt email through the real route. */
async function queueEmail(address: string): Promise<{ deliveryId: string }> {
  const outletId = await freshOutlet();
  const orderId = await completedSale(outletId);
  const res = await cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(outletId)}/pos/orders/${orderId}/receipts`,
    )
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      deliveries: ["email"],
      email: address,
    });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect(res.body.data.deliveries).toHaveLength(1);
  expect(res.body.data.deliveries[0].status).toBe("queued");
  return { deliveryId: res.body.data.deliveries[0].id as string };
}

async function deliveryRow(id: string) {
  return asOwnerTenant(async (client) => {
    const result = await client.query(
      `SELECT status, attempts, destination_sealed FROM pos_receipt_deliveries
       WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, id],
    );
    return result.rows[0] as {
      status: string;
      attempts: number;
      destination_sealed: string | null;
    };
  });
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rew-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(createDeviceOutletResolver());
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Receipt Email Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
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
  await signUp(client, "Receipt Email Kasir");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await asOwnerTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Receipt Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-REW', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  // Receipts and final orders are append-only: the tenant stays in the
  // disposable database, so give it a valid creator.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("e-receipt email job wiring (legend-v3vo)", () => {
  it("sends a queued e-receipt once, and a second run sends nothing", async () => {
    const address = `owner-${randomUUID().slice(0, 8)}@example.com`;
    const { deliveryId } = await queueEmail(address);
    const provider = new FakeEmailProvider();

    const first = await runPosReceiptEmailJob([tenantContext()], {
      email: provider,
    });
    expect(first).toEqual({ sent: 1, retried: 0, failed: 0 });
    const mine = provider.sent.filter((mail) => mail.to === address);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.reference).toBe(deliveryId);
    expect(await deliveryRow(deliveryId)).toMatchObject({
      status: "sent",
      destination_sealed: null,
    });

    const second = await runPosReceiptEmailJob([tenantContext()], {
      email: provider,
    });
    expect(second).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(provider.sent.filter((mail) => mail.to === address)).toHaveLength(1);
  });

  it("without a provider nothing is counted and the row stays queued with no attempt burned (same as the PO job)", async () => {
    const { deliveryId } = await queueEmail(
      `owner-${randomUUID().slice(0, 8)}@example.com`,
    );
    const result = await runPosReceiptEmailJob([tenantContext()], {
      email: null,
    });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0 });
    expect(await deliveryRow(deliveryId)).toMatchObject({
      status: "queued",
      attempts: 0,
      destination_sealed: expect.any(String),
    });
    // Once a provider is configured the same row goes out.
    const provider = new FakeEmailProvider();
    const later = await runPosReceiptEmailJob([tenantContext()], {
      email: provider,
    });
    expect(later.sent).toBeGreaterThanOrEqual(1);
    expect((await deliveryRow(deliveryId)).status).toBe("sent");
  });

  it("worker-main.ts registers the job in the per-tenant sweep", () => {
    const source = readFileSync(
      new URL("../worker-main.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("runPosReceiptEmailJob(");
    expect(source).toContain("POS receipt email sweep failed");
    // Cloud only: an edge-minted link would not resolve (review K).
    expect(source).toMatch(
      /if \(sendsReceiptEmails\) \{\s*try \{\s*await runPosReceiptEmailJob\(/,
    );
  });
});
