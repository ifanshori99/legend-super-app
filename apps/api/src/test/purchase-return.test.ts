// Supplier return of received goods (bead legend-65mgw, PRD v1.7 §3.18 Retur
// Pembelian; design docs/briefs/301b-sub-return-petty-design.md). Needs the
// disposable PostgreSQL database; the migration owner seeds fixtures and the
// service runs through the real tenant transaction (RLS on).
//
// Ids used in test names:
// - RT-1 gate off refuses the POST before any claim or write
// - RT-2 return takes stock out at the receipt cost, writes nota, audit, event
// - RT-3 cumulative line value: returns in parts add up to the receipt value
// - RT-4 a return cannot pass the accepted quantity
// - RT-5 idempotent create
// - RT-6 request validation
// - RT-7 insufficient stock rolls the return back
// - RT-8 permissions
// - RT-9 parallel returns cannot over-return
// - RT-10 reads and outlet isolation
//
// Assumption: quantities in the request are in the item base unit (see service).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { agent, signUp } from "./helpers.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import {
  createPurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns,
  setPurchaseReturnPostingEnabled,
  type CreatePurchaseReturnInput,
  type PurchaseReturnQuery,
} from "../services/purchase-return.service.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0]!.id;
const outletB = cafeLegendPlatformFixtures.outlets[1]!.id;

const app = createApp();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const tenant = establishTenantContext({
  tenantId: tenantA,
  brandId: null,
  source: "domain",
});

function contextFor(outletId: string): ScopedTenantContext {
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId) as OutletId],
  });
}

const createdUserIds: string[] = [];
const createdUomIds: string[] = [];
const createdItemIds: string[] = [];
const createdLocationIds: string[] = [];
const createdOrderIds: string[] = [];
const createdSupplierIds: string[] = [];

let supplierId: string;
let uomKg: string;
let uomGram: string;
let creatorId: string;
let approverId: string;
let warehouse: { userId: string };
let buyer: { userId: string };
let nobody: { userId: string };

const key = () => `k-${randomUUID()}`;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function signedIn(name: string, roles: string[]) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const role of roles)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantA, userId, await roleIdOf(role), outletA],
    );
  return { userId };
}

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Return ${label}`, `${id}@example.com`],
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
    [tenantA, outletId, `Gudang RT ${randomUUID().slice(0, 6)}`],
  );
  createdLocationIds.push(rows[0]!.id);
  return rows[0]!.id;
}

type Fixture = {
  poId: string;
  /** PO line 1: flour, 10 kg at Rp 10.000, base unit kg. */
  flourLine: string;
  /** PO line 2: sugar, 4 kg at Rp 20.000, base unit g (1 kg = 1000 g). */
  sugarLine: string;
  flour: string;
  sugar: string;
  location: string;
  receiptId: string;
  receivedOn: string;
};

/** A sent order of two lines, fully received (so there is stock to return). */
async function seedReceivedFixture(): Promise<Fixture> {
  const flour = await insertItem(uomKg, "Tepung RT");
  const sugar = await insertItem(uomGram, "Gula RT");
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
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', 180000, 0, 180000, 'user',
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
  const receipt = await createGoodsReceipt(
    contextFor(outletA),
    warehouse.userId,
    {
      outletId: outletA,
      purchaseOrderId: poId,
      lines: [
        {
          purchaseOrderLineId: lineIds[0]!,
          locationId: location,
          quantityReceived: "10.0000",
          quantityRejected: "0.0000",
        },
        {
          purchaseOrderLineId: lineIds[1]!,
          locationId: location,
          quantityReceived: "4.0000",
          quantityRejected: "0.0000",
        },
      ],
      idempotencyKey: key(),
    } as unknown as CreateGoodsReceiptInput,
  );
  return {
    poId,
    flourLine: lineIds[0]!,
    sugarLine: lineIds[1]!,
    flour,
    sugar,
    location,
    receiptId: receipt.receipt.id,
    receivedOn: receipt.receipt.receivedOn,
  };
}

type Line = {
  purchaseOrderLineId?: string | null;
  inventoryItemId: string;
  quantity: string;
  locationId: string;
  batchCode?: string | null;
};

function body(
  fx: Fixture,
  lines: Line[],
  overrides: Record<string, unknown> = {},
) {
  return {
    outletId: outletA,
    supplierId,
    purchaseOrderId: fx.poId,
    goodsReceiptId: fx.receiptId,
    returnedOn: fx.receivedOn,
    reason: "damaged",
    lines,
    idempotencyKey: key(),
    ...overrides,
  };
}

const flourLine = (
  fx: Fixture,
  quantity: string,
  locationId = fx.location,
) => ({
  purchaseOrderLineId: fx.flourLine,
  inventoryItemId: fx.flour,
  quantity,
  locationId,
});

const sugarLine = (
  fx: Fixture,
  quantity: string,
  locationId = fx.location,
) => ({
  purchaseOrderLineId: fx.sugarLine,
  inventoryItemId: fx.sugar,
  quantity,
  locationId,
});

const create = (
  userId: string,
  input: Record<string, unknown>,
  outletId = outletA,
) =>
  createPurchaseReturn(
    contextFor(outletId),
    userId,
    input as unknown as CreatePurchaseReturnInput,
  );

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
};

async function ledgerOf(returnId: string): Promise<LedgerRow[]> {
  const { rows } = await owner.query<LedgerRow>(
    `SELECT inventory_item_id, movement_type, source_type, quantity::text AS quantity,
            unit_cost_idr::text AS unit_cost_idr
       FROM stock_ledger WHERE tenant_id = $1 AND source_id = $2`,
    [tenantA, returnId],
  );
  return rows;
}

async function returnCount(receiptId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
    [tenantA, receiptId],
  );
  return rows[0]!.n;
}

async function claimCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM purchasing_idempotency WHERE tenant_id = $1 AND operation = 'purchase_return.create'",
    [tenantA],
  );
  return rows[0]!.n;
}

async function eventRows(returnId: string) {
  const { rows } = await owner.query<{
    aggregate_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT aggregate_type, event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'purchase_return.recorded'`,
    [tenantA, returnId],
  );
  return rows;
}

async function auditActionsFor(objectId: string): Promise<string[]> {
  const { rows } = await owner.query<{ action: string }>(
    `SELECT event->>'action' AS action FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
    [tenantA, objectId],
  );
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setPurchaseReturnPostingEnabled(true);
  creatorId = await plainUser("creator");
  approverId = await plainUser("approver");
  // warehouse holds inventory.stock.receive and purchasing.return.create.
  warehouse = await signedIn("RT warehouse", ["warehouse"]);
  buyer = await signedIn("RT buyer", ["purchasing"]);
  nobody = await signedIn("RT nobody", []);
  uomKg = await insertUom("kg");
  uomGram = await insertUom("g");
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantA, `Supplier RT ${randomUUID().slice(0, 6)}`, creatorId],
  );
  supplierId = rows[0]!.id;
  createdSupplierIds.push(supplierId);
});

afterEach(() => {
  setPurchaseReturnPostingEnabled(true);
});

afterAll(async () => {
  setPurchaseReturnPostingEnabled(null);
  // Ledger and history rows are append-only; replica mode lets the owner clean its own fixtures.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const receipts = `(SELECT id FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[]))`;
    const returns = `(SELECT id FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts})`;
    const args = [tenantA, createdOrderIds];
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND (aggregate_id IN ${receipts} OR aggregate_id IN ${returns})`,
      args,
    );
    await client.query(
      `DELETE FROM stock_ledger WHERE tenant_id = $1 AND (source_id IN ${receipts} OR source_id IN ${returns})`,
      args,
    );
    await client.query(
      `DELETE FROM purchase_return_lines WHERE tenant_id = $1 AND purchase_return_id IN ${returns}`,
      args,
    );
    await client.query(
      `DELETE FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      args,
    );
    await client.query(
      `DELETE FROM goods_receipt_lines WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts}`,
      args,
    );
    await client.query(
      "DELETE FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      args,
    );
    for (const table of ["stock_balances", "stock_batches"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND location_id = ANY($2::uuid[])`,
        [tenantA, createdLocationIds],
      );
    await client.query(
      "DELETE FROM purchase_order_lines WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      args,
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
      "DELETE FROM purchasing_document_sequences WHERE tenant_id = $1 AND kind IN ('GR', 'RT')",
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
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
    await client.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
});

describe("legend-65mgw RT purchase return", () => {
  it("[RT-1] gate off: the POST is refused with FEATURE_DISABLED and leaves no claim, row or stock movement", async () => {
    const fx = await seedReceivedFixture();
    const claimsBefore = await claimCount();
    setPurchaseReturnPostingEnabled(false);
    await expect(
      create(warehouse.userId, body(fx, [flourLine(fx, "1.0000")])),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    expect(await returnCount(fx.receiptId)).toBe(0);
    expect(await claimCount()).toBe(claimsBefore);
    expect(await balanceOf(fx.location, fx.flour)).toBe("10.0000");
  });

  it("[RT-2] a return takes stock out at the receipt cost and writes the nota, audit and event", async () => {
    const fx = await seedReceivedFixture();
    const detail = await create(
      warehouse.userId,
      body(fx, [flourLine(fx, "3.0000")], { note: "Karung robek" }),
    );
    const { purchaseReturn, lines } = detail;
    expect(purchaseReturn).toMatchObject({
      outletId: outletA,
      supplierId,
      purchaseOrderId: fx.poId,
      goodsReceiptId: fx.receiptId,
      reason: "damaged",
      valueIdr: 30000,
      returnedBy: warehouse.userId,
      note: "Karung robek",
    });
    expect(purchaseReturn.number).toMatch(/^RT\/\d{6}\/\d{4}$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      inventoryItemId: fx.flour,
      purchaseOrderLineId: fx.flourLine,
      quantity: "3.0000",
      unitCostIdr: "10000.0000",
      lineValueIdr: 30000,
    });

    expect(await balanceOf(fx.location, fx.flour)).toBe("7.0000");
    const ledger = await ledgerOf(purchaseReturn.id);
    expect(ledger).toEqual([
      {
        inventory_item_id: fx.flour,
        movement_type: "return",
        source_type: "purchase_return",
        quantity: "-3.0000",
        unit_cost_idr: "10000.0000",
      },
    ]);

    const events = await eventRows(purchaseReturn.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_type).toBe("purchase_return");
    expect(events[0]!.payload).toMatchObject({
      purchaseReturnId: purchaseReturn.id,
      supplierId,
      outletId: outletA,
      number: purchaseReturn.number,
      valueIdr: 30000,
      uninvoicedValueIdr: 30000,
      invoicedValueIdr: 0,
      ppnIdr: 0,
      returnedBy: warehouse.userId,
    });
    expect(await auditActionsFor(purchaseReturn.id)).toContain(
      "purchasing.return_recorded",
    );
  });

  it("[RT-3] value is cumulative per receipt line: returns in parts add up to the receipt line value exactly, in the base unit", async () => {
    const fx = await seedReceivedFixture();
    // Sugar: 4 kg at Rp 20.000 = Rp 80.000 for 4000 g (cost Rp 20 per g).
    expect(await balanceOf(fx.location, fx.sugar)).toBe("4000.0000");
    const first = await create(
      warehouse.userId,
      body(fx, [sugarLine(fx, "1333.3333")]),
    );
    // 80000 x 1333.3333 / 4000 = 26666.666 -> 26667
    expect(first.lines[0]).toMatchObject({
      quantity: "1333.3333",
      unitCostIdr: "20.0000",
      lineValueIdr: 26667,
    });
    const second = await create(
      warehouse.userId,
      body(fx, [sugarLine(fx, "2666.6667")]),
    );
    // cumulative 80000, minus 26667 already returned
    expect(second.lines[0]!.lineValueIdr).toBe(53333);
    expect(first.purchaseReturn.valueIdr + second.purchaseReturn.valueIdr).toBe(
      80000,
    );
    expect(await balanceOf(fx.location, fx.sugar)).toBe("0.0000");
    expect(first.purchaseReturn.number).not.toBe(second.purchaseReturn.number);
  });

  it("[RT-4] a return cannot pass the accepted quantity, counting earlier returns", async () => {
    const fx = await seedReceivedFixture();
    await create(warehouse.userId, body(fx, [flourLine(fx, "6.0000")]));
    await expect(
      create(warehouse.userId, body(fx, [flourLine(fx, "4.0001")])),
    ).rejects.toMatchObject({
      status: 409,
      code: "PURCHASE_RETURN_EXCEEDS_RECEIPT",
    });
    expect(await returnCount(fx.receiptId)).toBe(1);
    expect(await balanceOf(fx.location, fx.flour)).toBe("4.0000");
    // The exact remainder is still allowed.
    await create(warehouse.userId, body(fx, [flourLine(fx, "4.0000")]));
    expect(await balanceOf(fx.location, fx.flour)).toBe("0.0000");
  });

  it("[RT-5] the same key replays the first return; the same key with another request is refused", async () => {
    const fx = await seedReceivedFixture();
    const input = body(fx, [flourLine(fx, "2.0000")]);
    const first = await create(warehouse.userId, input);
    const replay = await create(warehouse.userId, input);
    expect(replay.purchaseReturn.id).toBe(first.purchaseReturn.id);
    expect(await returnCount(fx.receiptId)).toBe(1);
    expect(await ledgerOf(first.purchaseReturn.id)).toHaveLength(1);
    expect(await balanceOf(fx.location, fx.flour)).toBe("8.0000");
    await expect(
      create(warehouse.userId, {
        ...input,
        lines: [flourLine(fx, "3.0000")],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("[RT-6] validation: receipt and PO line required, supplier, item, duplicates and dates must match", async () => {
    const fx = await seedReceivedFixture();
    const line = flourLine(fx, "1.0000");
    const cases: [string, Record<string, unknown>][] = [
      ["no goods receipt", body(fx, [line], { goodsReceiptId: null })],
      ["no PO line", body(fx, [{ ...line, purchaseOrderLineId: null }])],
      ["other supplier", body(fx, [line], { supplierId: randomUUID() })],
      [
        "other purchase order",
        body(fx, [line], { purchaseOrderId: randomUUID() }),
      ],
      [
        "item differs from the receipt line",
        body(fx, [{ ...line, inventoryItemId: fx.sugar }]),
      ],
      ["same PO line twice", body(fx, [line, line])],
      [
        "batch the receipt line does not have",
        body(fx, [{ ...line, batchCode: "NOPE" }]),
      ],
      [
        "return date in the future",
        body(fx, [line], { returnedOn: "2099-01-01" }),
      ],
      [
        "return date before the receipt",
        body(fx, [line], { returnedOn: "2000-01-01" }),
      ],
      [
        "location of another outlet",
        body(fx, [{ ...line, locationId: randomUUID() }]),
      ],
    ];
    for (const [label, input] of cases)
      await expect(
        create(warehouse.userId, input),
        label,
      ).rejects.toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(await returnCount(fx.receiptId)).toBe(0);
    await expect(
      create(
        warehouse.userId,
        body(fx, [line], { goodsReceiptId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("[RT-7] not enough stock at the chosen location: 409 INSUFFICIENT_STOCK and nothing is written", async () => {
    const fx = await seedReceivedFixture();
    const empty = await insertLocation(outletA);
    await expect(
      create(warehouse.userId, body(fx, [flourLine(fx, "1.0000", empty)])),
    ).rejects.toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK" });
    expect(await returnCount(fx.receiptId)).toBe(0);
    expect(await balanceOf(fx.location, fx.flour)).toBe("10.0000");
  });

  it("[RT-8] permissions: warehouse and purchasing may return, a user without a role may not", async () => {
    const fx = await seedReceivedFixture();
    await expect(
      create(nobody.userId, body(fx, [flourLine(fx, "1.0000")])),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(await returnCount(fx.receiptId)).toBe(0);
    const byBuyer = await create(
      buyer.userId,
      body(fx, [flourLine(fx, "1.0000")]),
    );
    expect(byBuyer.purchaseReturn.returnedBy).toBe(buyer.userId);
    // The service also checks the outlet scope of the context.
    await expect(
      create(
        warehouse.userId,
        body(fx, [flourLine(fx, "1.0000")], { outletId: outletB }),
        outletA,
      ),
    ).rejects.toThrow();
  });

  it("[RT-9] two parallel returns cannot over-return one receipt line", async () => {
    const fx = await seedReceivedFixture();
    const results = await Promise.allSettled([
      create(warehouse.userId, body(fx, [flourLine(fx, "6.0000")])),
      create(warehouse.userId, body(fx, [flourLine(fx, "6.0000")])),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "PURCHASE_RETURN_EXCEEDS_RECEIPT",
    });
    expect(await returnCount(fx.receiptId)).toBe(1);
    expect(await balanceOf(fx.location, fx.flour)).toBe("4.0000");
  });

  it("[RT-10] reads: list and get for permitted users, denied without a role, hidden from another outlet; gate off keeps reads open", async () => {
    const fx = await seedReceivedFixture();
    const made = await create(
      warehouse.userId,
      body(fx, [flourLine(fx, "1.0000")]),
    );
    setPurchaseReturnPostingEnabled(false);
    const query = {
      outletId: outletA,
      purchaseOrderId: fx.poId,
      limit: 10,
    } as unknown as PurchaseReturnQuery;
    const page = await listPurchaseReturns(
      contextFor(outletA),
      buyer.userId,
      query,
    );
    expect(page.data.map((row) => row.id)).toEqual([made.purchaseReturn.id]);
    const got = await getPurchaseReturn(
      contextFor(outletA),
      buyer.userId,
      made.purchaseReturn.id,
    );
    expect(got.lines).toHaveLength(1);
    await expect(
      getPurchaseReturn(
        contextFor(outletA),
        nobody.userId,
        made.purchaseReturn.id,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      listPurchaseReturns(contextFor(outletA), nobody.userId, query),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      getPurchaseReturn(
        contextFor(outletB),
        warehouse.userId,
        made.purchaseReturn.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
