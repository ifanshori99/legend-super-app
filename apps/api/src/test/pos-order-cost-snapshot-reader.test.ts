// POS order reader: `order_items.cost_snapshot_idr` as seen in the POS order
// DTO (`items[].costSnapshotIdr`). Contract (HPP snapshot, bead legend-u4js6):
// HPP is finance data (`inventory.cost.view`), so the POS order DTO ALWAYS
// sends `null`, whatever the DB column holds (NULL, 5800 or 0). A cashier with
// only `order.view` + `pos.sale.create` must never see the cost.
//
// Fixtures follow order-cost-snapshot.test.ts / pos-order.test.ts: real Express
// app, real HTTP routes, disposable PostgreSQL with RLS, fresh isolated tenants.
// The order is created through the POS route, then the snapshot column of each
// line is set owner-side (a snapshot is written only when the line is created,
// so this is the way to get each of the three states into one order).
//
// Assumptions:
// - The order stays `draft`/open: the line snapshot column can still be written
//   owner-side and the reader does not depend on the order being completed.
// - Cross-tenant: a staff member of tenant B reading tenant A's order id gets
//   a non-200 answer and never sees A's lines, and B's order list omits A's order.
//   (The owner pool bypasses RLS, so isolation is asserted through the routes.)
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PRICE_IDR = 25_000;

type Member = { client: ReturnType<typeof agent>; userId: string };
type Shop = {
  tenant: IsolatedTenant;
  headers: { Host: string };
  deviceId: string;
  cashier: Member;
  items: { unknown: string; costed: string; zero: string };
};

let app: Express;
let A: Shop;
let B: Shop;

/** Owner-side statement with the tenant local set (RLS is FORCED). */
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

// Receipt numbering is not under test; the port only has to exist.
const receiptPort: PosReceiptPort = {
  async issueForSale() {
    throw new Error("not used: these tests never settle an order");
  },
  async findForOrder() {
    return null;
  },
  async voidForOrder() {
    return null;
  },
};

async function buildShop(label: string): Promise<Shop> {
  const tenant = await createIsolatedTenant(
    `${label}-${randomUUID().slice(0, 6)}`,
  );
  const roleId = randomUUID();
  const category = randomUUID();
  const priceList = randomUUID();
  const items = {
    unknown: randomUUID(),
    costed: randomUUID(),
    zero: randomUUID(),
  };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, `POS Kasir ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'HPP Reader', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [name, itemId] of Object.entries(items)) {
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          itemId,
          tenant.tenantId,
          tenant.brandId,
          category,
          `Menu ${name}`,
          randomUUID(),
        ],
      );
      await db.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, priceList, itemId, PRICE_IDR],
      );
    }
    // PBJT 10% on F&B, as in pos-order.test.ts (the sale math needs a tax setup).
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
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
  return {
    tenant,
    headers: { Host: tenant.hostname },
    deviceId: randomUUID(),
    cashier: { client, userId },
    items,
  };
}

function posBase(shop: Shop) {
  return `/api/outlets/${encodeURIComponent(shop.tenant.outletId)}/pos/orders`;
}

/** The cashier of `shop` rings up one line of each of the three menu items. */
async function createOrder(shop: Shop): Promise<string> {
  const created = await shop.cashier.client
    .post(posBase(shop))
    .set(shop.headers)
    .set(originHeader)
    .set(
      DEVICE_TOKEN_HEADER,
      signDeviceToken({
        version: 1,
        issuedAt: Math.floor(Date.now() / 1000),
        tenantId: shop.tenant.tenantId,
        brandId: null,
        deviceId: shop.deviceId,
      }),
    )
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [shop.items.unknown, shop.items.costed, shop.items.zero].map(
        (menuItemId) => ({ menuItemId, quantity: 1, modifierIds: [] }),
      ),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/** Sets one line's snapshot owner-side; `null` writes SQL NULL. */
async function setSnapshot(
  shop: Shop,
  orderId: string,
  menuItemId: string,
  value: number | null,
) {
  await asOwnerTenant(shop.tenant.tenantId, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE order_items SET cost_snapshot_idr = $4
        WHERE tenant_id = $1 AND order_id = $2 AND menu_item_id = $3`,
      [shop.tenant.tenantId, ulidToUuid(orderId), menuItemId, value],
    );
    expect(rowCount, "line updated").toBe(1);
  });
}

type DtoLine = { menuItemId: string; costSnapshotIdr: number | null };

async function readLines(shop: Shop, orderId: string): Promise<DtoLine[]> {
  const read = await shop.cashier.client
    .get(`${posBase(shop)}/${orderId}`)
    .set(shop.headers)
    .set(originHeader);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data.items as DtoLine[];
}

const lineOf = (lines: DtoLine[], menuItemId: string) => {
  const found = lines.filter((line) => line.menuItemId === menuItemId);
  expect(found, "order line in DTO").toHaveLength(1);
  return found[0]!;
};

let orderA: string;

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(receiptPort);
  A = await buildShop("hppa");
  B = await buildShop("hppb");
  for (const shop of [A, B])
    await registerTestDevice(owner, {
      tenantId: shop.tenant.tenantId,
      outletId: shop.tenant.outletId,
      deviceId: shop.deviceId,
    });
  setDeviceOutletResolver(async ({ tenantId, deviceId }) => {
    for (const shop of [A, B])
      if (tenantId === shop.tenant.tenantId && deviceId === shop.deviceId)
        return shop.tenant.outletId;
    return null;
  });
  orderA = await createOrder(A);
  await setSnapshot(A, orderA, A.items.unknown, null);
  await setSnapshot(A, orderA, A.items.costed, 5_800);
  await setSnapshot(A, orderA, A.items.zero, 0);
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  // Same cleanup as pos-order.test.ts: the tenants stay in the disposable
  // database, with a valid creator so the platform tenant list still parses.
  for (const shop of [A, B])
    if (shop)
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        shop.tenant.tenantId,
        randomUUID(),
      ]);
  await owner.end();
});

describe("POS order reader: cost_snapshot_idr in the order DTO", () => {
  it("a line with a NULL snapshot reads as null", async () => {
    const line = lineOf(await readLines(A, orderA), A.items.unknown);
    expect(line.costSnapshotIdr).toBeNull();
  });

  it("a line with a snapshot of 5800 in the DB still reads as null (no leak to the cashier)", async () => {
    const lines = await readLines(A, orderA);
    expect(lineOf(lines, A.items.costed).costSnapshotIdr).toBeNull();
    expect(JSON.stringify(lines)).not.toContain("5800");
  });

  it("a line with a snapshot of 0 in the DB reads as null, not 0", async () => {
    const line = lineOf(await readLines(A, orderA), A.items.zero);
    expect(line.costSnapshotIdr).toBeNull();
  });

  it("tenant isolation: tenant B cannot read tenant A's lines or snapshots", async () => {
    // Through the route: B's cashier asks for A's order id on B's host.
    const read = await B.cashier.client
      .get(`${posBase(B)}/${orderA}`)
      .set(B.headers)
      .set(originHeader);
    expect(read.status).not.toBe(200);
    expect(JSON.stringify(read.body)).not.toContain("costSnapshotIdr");

    // B's order list does not contain A's order either.
    const list = await B.cashier.client
      .get(posBase(B))
      .set(B.headers)
      .set(originHeader);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(orderA);

    // A still reads its own lines (the non-200 above is not a broken order);
    // the cost stays hidden for A's own cashier too.
    expect(
      lineOf(await readLines(A, orderA), A.items.costed).costSnapshotIdr,
    ).toBeNull();
  });
});
