// Goods receipt: partial receiving + QC + photos (bead legend-o1o4s, PRD v1.7
// INV-05, §3.18 "QC/partial", §4 Alur I step 3). Needs the disposable
// PostgreSQL database; the migration owner seeds fixtures, the restricted
// legend_app login checks RLS, requests go through the real routes.
//
// Acceptance ids used in test names:
// - o1o4s-GR-1 receive in parts until the PO is complete; a third receipt is refused
// - o1o4s-GR-2 QC reject: rejected stock never enters the ledger
// - o1o4s-GR-3 idempotent create and re-runnable stock posting
// - o1o4s-GR-4 parallel receipts cannot over-receive
// - o1o4s-GR-5 photos must be own-tenant, own-outlet receipt objects
// - o1o4s-GR-6 permissions
// - o1o4s-GR-7 RLS and immutability
// - o1o4s-GR-8 goods_receipt.recorded event carries the accepted value only
//
// Assumptions where the shared contract is silent:
// - Error responses use the `{ error: { code } }` envelope of the other suites.
// - A replayed create answers 200 or 201 (only the same receipt id is pinned).
// - Received > rejected violations answer 400 or 422 with VALIDATION_ERROR.
// - Photos of purpose other than `receipt` are refused with 422.
// - The same media id twice in one request is stored once, in first-seen order.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { postGoodsReceiptStockInTransaction } from "../services/inventory-receiving.service.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;
const tenantB = randomUUID();

const app = createApp();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});

const tenant = establishTenantContext({
  tenantId: tenantA,
  brandId: null,
  source: "domain",
});

function tenantContext(): ScopedTenantContext {
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletA) as OutletId],
  });
}

const createdUserIds: string[] = [];
const createdUomIds: string[] = [];
const createdItemIds: string[] = [];
const createdLocationIds: string[] = [];
const createdOrderIds: string[] = [];
const createdStorageIds: string[] = [];
const createdSupplierIds: string[] = [];

let supplierId: string;
let uomKg: string;
let uomGram: string;
let creatorId: string;
let approverId: string;
let receiver: { client: ReturnType<typeof agent>; userId: string };
let buyer: { client: ReturnType<typeof agent>; userId: string };
let nobody: { client: ReturnType<typeof agent>; userId: string };
let outletBReceiver: { client: ReturnType<typeof agent>; userId: string };

const key = () => `k-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

type Grant = { role: string; outletId: string | null };

async function grantRoles(userId: string, grants: Grant[]): Promise<void> {
  for (const grant of grants)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantA,
        userId,
        await roleIdOf(grant.role),
        grant.outletId === null ? "tenant" : "outlet",
        grant.outletId,
      ],
    );
}

/** A real session user (cookie agent) holding `grants`. */
async function signedIn(name: string, grants: Grant[]) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await grantRoles(userId, grants);
  return { client, userId };
}

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Receiving ${label}`, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  createdUomIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertItem(baseUomId: string, name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `${name} ${randomUUID().slice(0, 6)}`, baseUomId],
  );
  createdItemIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertLocation(outletId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantA, outletId, `Gudang GR ${randomUUID().slice(0, 6)}`],
  );
  createdLocationIds.push(rows[0]!.id);
  return rows[0]!.id;
}

/** Storage rows are seeded as the migration owner; FKs are skipped so tenant B needs no outlet. */
async function insertStorageObject(
  tenantId: string,
  outletId: string,
  purpose: string,
  // The uploader; a receipt only links its own recorder's photos.
  ownerUserId: string = receiver.userId,
): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, 'image/webp', 1024, $6)`,
      [tenantId, outletId, id, purpose, `legend-o1o4s/${id}.webp`, ownerUserId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  createdStorageIds.push(id);
  return id;
}

type Fixture = {
  poId: string;
  /** PO line 1: flour, 10 kg at Rp 10.000, base unit kg (same unit). */
  flourLine: string;
  /** PO line 2: sugar, 4 kg at Rp 20.000, base unit g (1 kg = 1000 g). */
  sugarLine: string;
  flour: string;
  sugar: string;
  location: string;
};

/** A sent order with two lines, one of them in a purchase unit that differs from the base unit. */
async function seedFixture(status = "sent"): Promise<Fixture> {
  const flour = await insertItem(uomKg, "Tepung GR");
  const sugar = await insertItem(uomGram, "Gula GR");
  await owner.query(
    `INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor)
     VALUES ($1, $2, $3, $4, 1000)`,
    [tenantA, sugar, uomKg, uomGram],
  );
  const location = await insertLocation(outletA);
  const poId = randomUUID();
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2099-12-20', 180000, 0, 180000, 'user',
        $7, $8, now(), now())`,
    [
      poId,
      tenantA,
      outletA,
      supplierId,
      `PO/209912/${randomBytes(4).toString("hex")}`,
      status,
      creatorId,
      approverId,
    ],
  );
  createdOrderIds.push(poId);
  const lineIds: string[] = [];
  const lines: [string, string, string, string, number, number][] = [
    [flour, "10.0000", uomKg, "10000.0000", 100000, 1],
    [sugar, "4.0000", uomKg, "20000.0000", 80000, 2],
  ];
  for (const [item, quantity, uom, price, total, lineNo] of lines) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO purchase_order_lines
         (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
          uom_id, unit_price_idr, line_total_idr, line_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [tenantA, outletA, poId, item, quantity, uom, price, total, lineNo],
    );
    lineIds.push(rows[0]!.id);
  }
  return {
    poId,
    flourLine: lineIds[0]!,
    sugarLine: lineIds[1]!,
    flour,
    sugar,
    location,
  };
}

/** A sent order whose purchase unit (g) is far smaller than the item's base unit (kg): 1 g = 0.001 kg. */
async function seedTinyUnitFixture(): Promise<{
  poId: string;
  line: string;
  item: string;
  location: string;
}> {
  const item = await insertItem(uomKg, "Saffron GR");
  await owner.query(
    `INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor)
     VALUES ($1, $2, $3, $4, 0.001)`,
    [tenantA, item, uomGram, uomKg],
  );
  const location = await insertLocation(outletA);
  const poId = randomUUID();
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', 500, 0, 500, 'user',
        $6, $7, now(), now())`,
    [
      poId,
      tenantA,
      outletA,
      supplierId,
      `PO/209912/${randomBytes(4).toString("hex")}`,
      creatorId,
      approverId,
    ],
  );
  createdOrderIds.push(poId);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, 5.0000, $5, 100.0000, 500, 1) RETURNING id`,
    [tenantA, outletA, poId, item, uomGram],
  );
  return { poId, line: rows[0]!.id, item, location };
}

type LineInput = Record<string, unknown>;

function rl(
  poLineId: string,
  locationId: string,
  received: string,
  rejected = "0.0000",
  extra: Record<string, unknown> = {},
): LineInput {
  return {
    purchaseOrderLineId: poLineId,
    locationId,
    quantityReceived: received,
    quantityRejected: rejected,
    ...extra,
  };
}

function receiptBody(
  fx: Fixture,
  lines: LineInput[],
  overrides: Record<string, unknown> = {},
) {
  return {
    outletId: outletA,
    purchaseOrderId: fx.poId,
    lines,
    idempotencyKey: key(),
    ...overrides,
  };
}

const receive = (
  client: ReturnType<typeof agent>,
  body: Record<string, unknown>,
) =>
  client
    .post("/api/inventory/goods-receipts")
    .set(originHeader)
    .send(body as object);

/** Audit actions written for rows mentioning `objectId` (audit_logs, as the other suites read it). */
async function auditActionsFor(objectId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
    [tenantA, objectId],
  );
  return rows.map((row) => row.action);
}

async function poStatus(poId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM purchase_orders WHERE id = $1",
    [poId],
  );
  return rows[0]!.status;
}

async function balanceOf(
  locationId: string,
  itemId: string,
): Promise<string | null> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM stock_balances
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

type LedgerRow = {
  inventory_item_id: string;
  movement_type: string;
  source_type: string;
  quantity: string;
  unit_cost_idr: string;
  batch_id: string | null;
};

async function ledgerOf(receiptId: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT inventory_item_id, movement_type, source_type, quantity::text AS quantity,
            unit_cost_idr::text AS unit_cost_idr, batch_id
       FROM stock_ledger
      WHERE tenant_id = $1 AND source_id = $2`,
    [tenantA, receiptId],
  );
  return rows;
}

async function ledgerCountForOrder(poId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM stock_ledger
      WHERE tenant_id = $1 AND source_type = 'goods_receipt'
        AND source_id IN (SELECT id FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = $2)`,
    [tenantA, poId],
  );
  return rows[0]!.n;
}

async function receiptCount(poId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = $2",
    [tenantA, poId],
  );
  return rows[0]!.n;
}

async function eventRows(receiptId: string) {
  const { rows } = await owner.query<{
    aggregate_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT aggregate_type, event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'goods_receipt.recorded'`,
    [tenantA, receiptId],
  );
  return rows;
}

/** Runs `run` as the restricted runtime login with the given tenant and outlet scope. */
async function asScope<T>(
  tenantId: string,
  outletScope: string,
  run: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [tenantId, outletScope],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function countRows(
  client: import("pg").PoolClient,
  table: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await liftDocumentCounters(owner, tenantA);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Goods Receipt Tenant B', 'lengkap', 'active', 'shared', $3, $4, $5)`,
    [
      tenantB,
      `gr-b-${randomUUID().slice(0, 8)}`,
      JSON.stringify({ modules: [], integrationProviders: [] }),
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  creatorId = await plainUser("creator");
  approverId = await plainUser("approver");
  // The warehouse role holds inventory.stock.receive; the purchasing role only
  // reads receipts (purchasing permissions) and cannot record one.
  receiver = await signedIn("GR receiver", [
    { role: "warehouse", outletId: outletA },
  ]);
  buyer = await signedIn("GR buyer", [
    { role: "purchasing", outletId: outletA },
  ]);
  nobody = await signedIn("GR nobody", []);
  outletBReceiver = await signedIn("GR receiver B", [
    { role: "warehouse", outletId: outletB },
  ]);
  uomKg = await insertUom("kg");
  uomGram = await insertUom("g");
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantA, `Supplier GR ${randomUUID().slice(0, 6)}`, creatorId],
  );
  supplierId = rows[0]!.id;
  createdSupplierIds.push(supplierId);
});

afterAll(async () => {
  // Ledger rows are append-only; replica mode lets the owner clean its own fixtures.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const orders = [createdOrderIds];
    const receipts = `(SELECT id FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[]))`;
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id IN ${receipts}`,
      [tenantA, ...orders],
    );
    await client.query(
      `DELETE FROM stock_ledger WHERE tenant_id = $1 AND source_id IN ${receipts}`,
      [tenantA, ...orders],
    );
    await client.query(
      `DELETE FROM goods_receipt_media WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      [tenantA, ...orders],
    );
    await client.query(
      `DELETE FROM goods_receipt_lines WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      [tenantA, ...orders],
    );
    await client.query(
      "DELETE FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      [tenantA, createdOrderIds],
    );
    for (const table of ["stock_balances", "stock_batches"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND location_id = ANY($2::uuid[])`,
        [tenantA, createdLocationIds],
      );
    await client.query(
      "DELETE FROM purchase_order_lines WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      [tenantA, createdOrderIds],
    );
    await client.query(
      "DELETE FROM purchase_orders WHERE id = ANY($1::uuid[])",
      [createdOrderIds],
    );
    await client.query(
      "DELETE FROM purchasing_idempotency WHERE tenant_id = $1",
      [tenantA],
    );
    await client.query(
      "DELETE FROM purchasing_document_sequences WHERE tenant_id = $1 AND kind = 'GR'",
      [tenantA],
    );
    await client.query(
      "DELETE FROM uom_conversions WHERE tenant_id = $1 AND inventory_item_id = ANY($2::uuid[])",
      [tenantA, createdItemIds],
    );
    await client.query(
      "DELETE FROM stock_locations WHERE id = ANY($1::uuid[])",
      [createdLocationIds],
    );
    await client.query(
      "DELETE FROM inventory_items WHERE id = ANY($1::uuid[])",
      [createdItemIds],
    );
    await client.query("DELETE FROM uoms WHERE id = ANY($1::uuid[])", [
      createdUomIds,
    ]);
    await client.query("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
      createdSupplierIds,
    ]);
    await client.query(
      "DELETE FROM core_storage_objects WHERE id = ANY($1::uuid[])",
      [createdStorageIds],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantB]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
  await appPool.end();
});

describe("o1o4s-GR goods receipt: partial, QC, photos", () => {
  it("[o1o4s-GR-1] receiving in parts: PO goes partially_received then received, stock follows accepted base quantity, a third receipt is refused", async () => {
    const fx = await seedFixture();

    // Part one: 6 of 10 kg flour (with a batch), 1 of 4 kg sugar (base unit g).
    const first = await receive(
      receiver.client,
      receiptBody(fx, [
        rl(fx.flourLine, fx.location, "6.0000", "0.0000", {
          batchCode: "TP-001",
          expiresOn: "2027-01-31",
        }),
        rl(fx.sugarLine, fx.location, "1.0000"),
      ]),
    );
    expect(first.status).toBe(201);
    const receipt1 = first.body.data.receipt;
    expect(receipt1.number).toMatch(/^GR\/\d{6}\/\d{4}$/);
    expect(receipt1.purchaseOrderId).toBe(fx.poId);
    expect(receipt1.receivedBy).toBe(receiver.userId);
    // DTO quantities stay in the purchase unit.
    const dtoSugar = first.body.data.lines.find(
      (line: { purchaseOrderLineId: string }) =>
        line.purchaseOrderLineId === fx.sugarLine,
    );
    expect(dtoSugar).toMatchObject({
      quantityReceived: "1.0000",
      quantityRejected: "0.0000",
      unitCostIdr: "20000.0000",
    });
    expect(await poStatus(fx.poId)).toBe("partially_received");
    expect(await balanceOf(fx.location, fx.flour)).toBe("6.0000");
    expect(await balanceOf(fx.location, fx.sugar)).toBe("1000.0000");
    const ledger1 = await ledgerOf(receipt1.id);
    expect(ledger1).toHaveLength(2);
    for (const row of ledger1) {
      expect(row.source_type).toBe("goods_receipt");
      expect(row.movement_type).toBe("receipt");
    }
    const flourRow = ledger1.find((row) => row.inventory_item_id === fx.flour)!;
    const sugarRow = ledger1.find((row) => row.inventory_item_id === fx.sugar)!;
    expect(flourRow.quantity).toBe("6.0000");
    expect(flourRow.unit_cost_idr).toBe("10000.0000");
    expect(flourRow.batch_id).not.toBeNull();
    // Rp 20.000 per kg is Rp 20 per gram.
    expect(sugarRow.quantity).toBe("1000.0000");
    expect(sugarRow.unit_cost_idr).toBe("20.0000");
    expect(sugarRow.batch_id).toBeNull();
    const { rows: batches } = await owner.query<{ batch_code: string }>(
      "SELECT batch_code FROM stock_batches WHERE tenant_id = $1 AND id = $2",
      [tenantA, flourRow.batch_id],
    );
    expect(batches[0]?.batch_code).toBe("TP-001");

    // Part two: the rest of both lines completes the order.
    const second = await receive(
      receiver.client,
      receiptBody(fx, [
        rl(fx.flourLine, fx.location, "4.0000"),
        rl(fx.sugarLine, fx.location, "3.0000"),
      ]),
    );
    expect(second.status).toBe(201);
    expect(second.body.data.receipt.number).not.toBe(receipt1.number);
    expect(await poStatus(fx.poId)).toBe("received");
    expect(await balanceOf(fx.location, fx.flour)).toBe("10.0000");
    expect(await balanceOf(fx.location, fx.sugar)).toBe("4000.0000");

    // Part three: nothing is left to receive on a completed order.
    const third = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000")]),
    );
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("PURCHASE_ORDER_INVALID_TRANSITION");
    expect(await receiptCount(fx.poId)).toBe(2);
    expect(await balanceOf(fx.location, fx.flour)).toBe("10.0000");
  });

  it("[o1o4s-GR-2] QC reject keeps rejected goods out of stock and out of the received count; rejecting needs a reason", async () => {
    const fx = await seedFixture();

    // Whole line rejected: receipt is recorded, nothing enters stock, PO unchanged.
    const rejectedAll = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.sugarLine, fx.location, "4.0000", "4.0000")], {
        qcNotes: "Gula basah, ditolak semua",
      }),
    );
    expect(rejectedAll.status).toBe(201);
    expect(rejectedAll.body.data.receipt.qcNotes).toBe(
      "Gula basah, ditolak semua",
    );
    expect(rejectedAll.body.data.lines[0]).toMatchObject({
      quantityReceived: "4.0000",
      quantityRejected: "4.0000",
    });
    expect(await ledgerOf(rejectedAll.body.data.receipt.id)).toHaveLength(0);
    expect(await balanceOf(fx.location, fx.sugar)).toBeNull();
    expect(await poStatus(fx.poId)).toBe("sent");

    // Partly rejected: only the accepted part enters stock.
    const partly = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "5.0000", "1.0000")], {
        qcNotes: "1 kg tepung bocor",
      }),
    );
    expect(partly.status).toBe(201);
    expect(await balanceOf(fx.location, fx.flour)).toBe("4.0000");
    const partlyLedger = await ledgerOf(partly.body.data.receipt.id);
    expect(partlyLedger).toHaveLength(1);
    expect(partlyLedger[0]!.quantity).toBe("4.0000");
    expect(await poStatus(fx.poId)).toBe("partially_received");

    // Rejected goods do not count as received: all 4 kg of sugar can still arrive.
    const replacement = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.sugarLine, fx.location, "4.0000")]),
    );
    expect(replacement.status).toBe(201);
    expect(await balanceOf(fx.location, fx.sugar)).toBe("4000.0000");

    // A rejected quantity without a QC note is refused and records nothing.
    const before = await receiptCount(fx.poId);
    const noNote = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "2.0000", "1.0000")]),
    );
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe("VALIDATION_ERROR");
    // Rejected more than received is refused by validation.
    const tooMany = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000", "2.0000")], {
        qcNotes: "Salah hitung",
      }),
    );
    expect([400, 422]).toContain(tooMany.status);
    expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(fx.poId)).toBe(before);
    expect(await balanceOf(fx.location, fx.flour)).toBe("4.0000");
  });

  it("[o1o4s-GR-3] the same idempotency key replays one receipt; a changed body with the same key is refused; stock posting can be re-run safely", async () => {
    const fx = await seedFixture();
    const body = receiptBody(fx, [
      rl(fx.flourLine, fx.location, "3.0000"),
      rl(fx.sugarLine, fx.location, "2.0000"),
    ]);

    const first = await receive(receiver.client, body);
    expect(first.status).toBe(201);
    const receiptId = first.body.data.receipt.id as string;
    const replay = await receive(receiver.client, body);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.receipt.id).toBe(receiptId);
    expect(replay.body.data.receipt.number).toBe(
      first.body.data.receipt.number,
    );
    expect(await receiptCount(fx.poId)).toBe(1);
    expect(await ledgerOf(receiptId)).toHaveLength(2);
    expect(await balanceOf(fx.location, fx.flour)).toBe("3.0000");
    expect(await balanceOf(fx.location, fx.sugar)).toBe("2000.0000");
    expect(await eventRows(receiptId)).toHaveLength(1);

    const reused = await receive(receiver.client, {
      ...body,
      lines: [rl(fx.flourLine, fx.location, "1.0000")],
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await receiptCount(fx.poId)).toBe(1);

    // Service level: posting the receipt's stock again writes nothing new.
    const context = tenantContext();
    for (let run = 0; run < 2; run += 1)
      await withTenant(db, context, (tx) =>
        postGoodsReceiptStockInTransaction(
          tx,
          context,
          receiptId as never,
          receiver.userId as never,
        ),
      );
    expect(await ledgerOf(receiptId)).toHaveLength(2);
    expect(await balanceOf(fx.location, fx.flour)).toBe("3.0000");
    expect(await balanceOf(fx.location, fx.sugar)).toBe("2000.0000");
  });

  it("[o1o4s-GR-4] two parallel receipts that together exceed the order: exactly one wins, the other is refused as over-receipt", async () => {
    const fx = await seedFixture();
    const results = await Promise.all(
      [0, 1].map(() =>
        receive(
          receiver.client,
          receiptBody(fx, [rl(fx.flourLine, fx.location, "6.0000")]),
        ),
      ),
    );
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((result) => result.status === 409)!;
    expect(loser.body.error.code).toBe("PURCHASE_ORDER_OVER_RECEIPT");
    expect(await receiptCount(fx.poId)).toBe(1);
    expect(await ledgerCountForOrder(fx.poId)).toBe(1);
    const { rows } = await owner.query<{ total: string }>(
      `SELECT coalesce(sum(quantity), 0)::text AS total FROM stock_ledger
        WHERE tenant_id = $1 AND inventory_item_id = $2 AND source_type = 'goods_receipt'`,
      [tenantA, fx.flour],
    );
    expect(Number(rows[0]!.total)).toBeLessThanOrEqual(10);
    expect(await balanceOf(fx.location, fx.flour)).toBe("6.0000");
    expect(await poStatus(fx.poId)).toBe("partially_received");
  });

  it("[o1o4s-GR-5] photos: another tenant's, another outlet's or a wrong-purpose object is refused; own receipt photos are kept in order", async () => {
    const fx = await seedFixture();
    const photoA1 = await insertStorageObject(
      tenantA,
      outletA,
      "goods_receipt_photo",
    );
    const photoA2 = await insertStorageObject(
      tenantA,
      outletA,
      "goods_receipt_photo",
    );
    const foreignTenant = await insertStorageObject(
      tenantB,
      outletA,
      "goods_receipt_photo",
    );
    const otherOutlet = await insertStorageObject(
      tenantA,
      outletB,
      "goods_receipt_photo",
    );
    const wrongPurpose = await insertStorageObject(
      tenantA,
      outletA,
      "document",
    );
    const lines = [rl(fx.flourLine, fx.location, "1.0000")];

    for (const mediaId of [foreignTenant, otherOutlet, wrongPurpose]) {
      const refused = await receive(
        receiver.client,
        receiptBody(fx, lines, { mediaIds: [photoA1, mediaId] }),
      );
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await receiptCount(fx.poId)).toBe(0);
    expect(await balanceOf(fx.location, fx.flour)).toBeNull();

    const ok = await receive(
      receiver.client,
      receiptBody(fx, lines, { mediaIds: [photoA2, photoA1, photoA2] }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.receipt.mediaIds).toEqual([photoA2, photoA1]);
    const fetched = await receiver.client.get(
      `/api/inventory/goods-receipts/${ok.body.data.receipt.id}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.receipt.mediaIds).toEqual([photoA2, photoA1]);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM goods_receipt_media WHERE tenant_id = $1 AND goods_receipt_id = $2",
      [tenantA, ok.body.data.receipt.id],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("[o1o4s-GR-6] permissions: 401 without a session, 403 without receive permission or outlet reach, reads need a purchasing or receive permission", async () => {
    const fx = await seedFixture();
    const body = receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000")]);

    expect(
      (await receive(agent(app), body as Record<string, unknown>)).status,
    ).toBe(401);
    expect(
      (await receive(nobody.client, receiptBody(fx, body.lines))).status,
    ).toBe(403);
    // Purchasing reads receipts but does not hold inventory.stock.receive.
    expect(
      (await receive(buyer.client, receiptBody(fx, body.lines))).status,
    ).toBe(403);
    // A warehouse user of outlet B cannot receive an outlet A order.
    expect(
      (await receive(outletBReceiver.client, receiptBody(fx, body.lines)))
        .status,
    ).toBe(403);
    expect(await receiptCount(fx.poId)).toBe(0);
    expect(await balanceOf(fx.location, fx.flour)).toBeNull();

    const created = await receive(receiver.client, body);
    expect(created.status).toBe(201);
    const receiptId = created.body.data.receipt.id as string;
    const listUrl = `/api/inventory/goods-receipts?outletId=${outletA}&purchaseOrderId=${fx.poId}&limit=20`;

    expect((await agent(app).get(listUrl)).status).toBe(401);
    expect((await nobody.client.get(listUrl)).status).toBe(403);
    expect(
      (
        await outletBReceiver.client.get(
          `/api/inventory/goods-receipts?outletId=${outletA}&limit=5`,
        )
      ).status,
    ).toBe(403);
    for (const reader of [buyer, receiver]) {
      const list = await reader.client.get(listUrl);
      expect(list.status).toBe(200);
      expect(
        (list.body.data as { id: string }[]).map((receipt) => receipt.id),
      ).toEqual([receiptId]);
      const detail = await reader.client.get(
        `/api/inventory/goods-receipts/${receiptId}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.data.lines).toHaveLength(1);
    }
    // Detail: no session, no permission, unknown id; an outlet B user sees no outlet A receipt.
    expect(
      (await agent(app).get(`/api/inventory/goods-receipts/${receiptId}`))
        .status,
    ).toBe(401);
    expect(
      (await nobody.client.get(`/api/inventory/goods-receipts/${receiptId}`))
        .status,
    ).toBe(403);
    expect(
      (
        await receiver.client.get(
          `/api/inventory/goods-receipts/${randomUUID()}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await outletBReceiver.client.get(
          `/api/inventory/goods-receipts/${receiptId}`,
        )
      ).status,
    ).toBe(404);
  });

  it("[o1o4s-GR-7] RLS hides receipts from other tenants and outlets; the runtime login cannot change or delete them", async () => {
    const fx = await seedFixture();
    const created = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "2.0000")], {
        mediaIds: [
          await insertStorageObject(tenantA, outletA, "goods_receipt_photo"),
        ],
      }),
    );
    expect(created.status).toBe(201);
    const tables = [
      "goods_receipts",
      "goods_receipt_lines",
      "goods_receipt_media",
    ];

    // Positive control: the owning tenant, tenant-wide or at its own outlet, sees rows.
    for (const scope of ["*", JSON.stringify([outletA])])
      await asScope(tenantA, scope, async (client) => {
        for (const table of tables)
          expect(await countRows(client, table)).toBeGreaterThan(0);
      });
    // Tenant B sees nothing of tenant A.
    await asScope(tenantB, "*", async (client) => {
      for (const table of tables) {
        expect(await countRows(client, table)).toBe(0);
        const { rows } = await client.query(
          `SELECT 1 FROM ${table} WHERE tenant_id = $1`,
          [tenantA],
        );
        expect(rows).toHaveLength(0);
      }
    });
    // Another outlet of the same tenant sees nothing of outlet A.
    await asScope(tenantA, JSON.stringify([outletB]), async (client) => {
      for (const table of tables) {
        const { rows } = await client.query(
          `SELECT 1 FROM ${table} WHERE outlet_id = $1`,
          [outletA],
        );
        expect(rows).toHaveLength(0);
      }
    });
    // Receipts are immutable for the runtime login.
    const statements: [string, string][] = [
      [
        "goods_receipt_lines",
        "UPDATE goods_receipt_lines SET quantity_rejected = 0",
      ],
      ["goods_receipt_lines", "DELETE FROM goods_receipt_lines"],
      ["goods_receipts", "UPDATE goods_receipts SET qc_notes = 'x'"],
      ["goods_receipts", "DELETE FROM goods_receipts"],
      ["goods_receipt_media", "DELETE FROM goods_receipt_media"],
    ];
    for (const [table, statement] of statements)
      await expect(
        asScope(tenantA, "*", (client) => client.query(statement)),
        `${statement} on ${table}`,
      ).rejects.toThrow(/permission denied/);
  });

  it("[o1o4s-GR-8] one goods_receipt.recorded event carries the accepted value only", async () => {
    const fx = await seedFixture();
    const created = await receive(
      receiver.client,
      receiptBody(
        fx,
        [
          // accepted 4 kg x 10.000 = 40.000 (received value would be 50.000)
          rl(fx.flourLine, fx.location, "5.0000", "1.0000"),
          // accepted 1 kg x 20.000 = 20.000 (received value would be 40.000)
          rl(fx.sugarLine, fx.location, "2.0000", "1.0000"),
        ],
        { qcNotes: "Satu kemasan tiap barang rusak" },
      ),
    );
    expect(created.status).toBe(201);
    const receipt = created.body.data.receipt;
    const events = await eventRows(receipt.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_type).toBe("goods_receipt");
    expect(events[0]!.payload).toMatchObject({
      goodsReceiptId: receipt.id,
      purchaseOrderId: fx.poId,
      supplierId,
      number: receipt.number,
      receivedValueIdr: 60000,
      lineCount: 2,
      receivedBy: receiver.userId,
    });
  });
  it("[o1o4s-GR-9] accepted quantity that converts to zero base units is refused and records nothing", async () => {
    const tiny = await seedTinyUnitFixture();
    const fx = {
      poId: tiny.poId,
    } as Fixture;
    // 0.0001 g x 0.001 kg/g = 0.0000001 kg, below the 4-decimal base precision.
    const refused = await receive(
      receiver.client,
      receiptBody(fx, [
        rl(tiny.line, tiny.location, "0.0001", "0.0000", {
          batchCode: "TINY-1",
        }),
      ]),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(tiny.poId)).toBe(0);
    expect(await ledgerCountForOrder(tiny.poId)).toBe(0);
    expect(await balanceOf(tiny.location, tiny.item)).toBeNull();
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stock_batches WHERE tenant_id = $1 AND inventory_item_id = $2",
      [tenantA, tiny.item],
    );
    expect(rows[0]!.n).toBe(0);
    expect(await poStatus(tiny.poId)).toBe("sent");

    // Control: a quantity that does convert (2 g = 0.002 kg) is accepted.
    const ok = await receive(
      receiver.client,
      receiptBody(fx, [rl(tiny.line, tiny.location, "2.0000")]),
    );
    expect(ok.status).toBe(201);
    expect(await balanceOf(tiny.location, tiny.item)).toBe("0.0020");
  });

  it("[o1o4s-GR-10] photo order is kept as sent (first is the cover) and duplicates are removed", async () => {
    const fx = await seedFixture();
    const [p1, p2, p3] = [
      await insertStorageObject(tenantA, outletA, "goods_receipt_photo"),
      await insertStorageObject(tenantA, outletA, "goods_receipt_photo"),
      await insertStorageObject(tenantA, outletA, "goods_receipt_photo"),
    ] as [string, string, string];
    const created = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000")], {
        mediaIds: [p3, p1, p2, p1, p3],
      }),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.receipt.mediaIds).toEqual([p3, p1, p2]);
    const fetched = await receiver.client.get(
      `/api/inventory/goods-receipts/${created.body.data.receipt.id}`,
    );
    expect(fetched.body.data.receipt.mediaIds).toEqual([p3, p1, p2]);
    const { rows } = await owner.query<{ storage_object_id: string }>(
      `SELECT storage_object_id FROM goods_receipt_media
        WHERE tenant_id = $1 AND goods_receipt_id = $2 ORDER BY position`,
      [tenantA, created.body.data.receipt.id],
    );
    expect(rows.map((row) => row.storage_object_id)).toEqual([p3, p1, p2]);
  });

  it("[o1o4s-GR-11] a receipt photo already attached to an earlier goods receipt is refused", async () => {
    const fx = await seedFixture();
    const used = await insertStorageObject(
      tenantA,
      outletA,
      "goods_receipt_photo",
    );
    const fresh = await insertStorageObject(
      tenantA,
      outletA,
      "goods_receipt_photo",
    );
    const first = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000")], {
        mediaIds: [used],
      }),
    );
    expect(first.status).toBe(201);

    const reuse = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000")], {
        mediaIds: [fresh, used],
      }),
    );
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe("VALIDATION_ERROR");
    expect(await receiptCount(fx.poId)).toBe(1);
    expect(await balanceOf(fx.location, fx.flour)).toBe("1.0000");

    // A photo nobody used yet still works on the next receipt.
    const next = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "1.0000")], {
        mediaIds: [fresh],
      }),
    );
    expect(next.status).toBe(201);
  });

  it("[o1o4s-GR-12] a fully rejected receipt leaves a partially_received order untouched: same status, same updated_at, no order_received audit", async () => {
    const fx = await seedFixture();
    const partial = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.flourLine, fx.location, "3.0000")]),
    );
    expect(partial.status).toBe(201);
    expect(await poStatus(fx.poId)).toBe("partially_received");
    // Control: the accepting receipt moved the order and audited it.
    const ordersAudited = async () =>
      (await auditActionsFor(fx.poId)).filter((action) =>
        action.endsWith("purchasing.order_received"),
      ).length;
    expect(await ordersAudited()).toBe(1);
    expect(await auditActionsFor(partial.body.data.receipt.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/inventory\.goods_receipt_recorded$/),
      ]),
    );

    const stamp = async () =>
      (
        await owner.query<{ status: string; updated_at: string }>(
          "SELECT status, updated_at::text AS updated_at FROM purchase_orders WHERE id = $1",
          [fx.poId],
        )
      ).rows[0]!;
    const before = await stamp();

    const rejected = await receive(
      receiver.client,
      receiptBody(fx, [rl(fx.sugarLine, fx.location, "2.0000", "2.0000")], {
        qcNotes: "Gula rusak, ditolak semua",
      }),
    );
    expect(rejected.status).toBe(201);
    expect(await stamp()).toEqual(before);
    expect(await ledgerOf(rejected.body.data.receipt.id)).toHaveLength(0);
    expect(await auditActionsFor(rejected.body.data.receipt.id)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/inventory\.goods_receipt_recorded$/),
      ]),
    );
    // Still exactly the one order_received row from the accepting receipt.
    expect(await ordersAudited()).toBe(1);
  });
});
