// Blind-count lock on supplier returns (bead legend-nxqrw; follow-up of 0hzu,
// see inventory-blind-count-movement-lock.test.ts; PRD v1.7 §3 F16 "Stok
// Opname" hitung buta, INV-01; error `BLIND_COUNT_LOCKED`, HTTP 409).
//
// The leak: a counter of an open blind count cannot read the stock of the
// counted (location, item) pair, but could probe it by posting a supplier
// return for that pair and watching 409 INSUFFICIENT_STOCK vs success.
// The rule under test: for that counter, a purchase return that takes the
// hidden pair out of stock is refused UNIFORMLY (409 BLIND_COUNT_LOCKED, same
// message) whether the stock would cover it or not, and nothing is posted.
//
// Cases:
// - BL-1 (a) blind counter, stock enough: 409 BLIND_COUNT_LOCKED, nothing posted
// - BL-2 (b) blind counter, stock short: identical locked answer (not
//   INSUFFICIENT_STOCK), nothing posted
// - BL-3 (c) a non-counter keeps today's behaviour (INSUFFICIENT_STOCK / success)
// - BL-4 (d) a non-blind count, a cancelled count, or another pair: no lock
//
// Assumptions (the brief is loose):
// - "Counter" = the count creator (counter_ids), as in the movement-lock suite.
// - A blind count hides the pair from creation (draft) until posted/cancelled.
// - Quantities in the request are in the item base unit (kg for flour).
// - The lock answers 409 with code BLIND_COUNT_LOCKED and one fixed message
//   that carries no quantity.
// - The return endpoint is POST /api/inventory/purchase-returns.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Response } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  decimal4,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import { setPurchaseReturnPostingEnabled } from "../services/purchase-return.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const brandA = cafeLegendPlatformFixtures.brand.id;
// A fresh outlet of a fresh legal entity with its own chart (made in
// beforeAll), so the receipt journals do not touch the shared template entity.
const entityA = randomUUID();
const outletA: string = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const app = createApp();

const tenant = establishTenantContext({
  tenantId: tenantA,
  brandId: null,
  source: "domain",
});
const tenantWide: ScopedTenantContext = establishScopedTenantContext(tenant, {
  kind: "tenant",
});

const short = () => randomUUID().slice(0, 6);
const key = (prefix = "k") => `${prefix}-${randomUUID()}`;
const today = new Date().toISOString().slice(0, 10);

function contextFor(outletId: string): ScopedTenantContext {
  return establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId) as OutletId],
  });
}

// ------------------------------------------------------------------ seeding

// [role, code, name, type, report_group]
const CHART: [string, string, string, string, string][] = [
  ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
  ["ppn_input", "1401", "PPN Masukan", "asset", "current_asset"],
  ["accounts_payable", "2101", "Utang Usaha", "liability", "current_liability"],
  [
    "grni",
    "2102",
    "Barang Diterima Belum Ditagih",
    "liability",
    "current_liability",
  ],
  [
    "purchase_price_variance",
    "5105",
    "Selisih Harga Pembelian",
    "expense",
    "cogs",
  ],
];

/** A fresh legal entity + outlet + chart with the purchasing roles mapped. */
async function makeAccountingWorld(): Promise<void> {
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entityA, tenantA, `Entity BL ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet BL', 'Jl. BL', 'Asia/Jakarta', '04:00', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [outletA, tenantA, brandA, entityA, `BL-${short()}`.toUpperCase()],
  );
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantA, entityA, code, name, type, group],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantA, entityA, role, rows[0]!.id],
    );
  }
  const now = new Date();
  for (const shift of [-1, 0, 1]) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantA, entityA, d.toISOString().slice(0, 7)],
    );
  }
}

/** Delivers the receipt's `goods_receipt.recorded` event and asserts it posted. */
async function journalReceipt(receiptId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'goods_receipt.recorded'`,
    [tenantA, receiptId],
  );
  if (rows.length !== 1)
    throw new Error(`Expected one receipt event, found ${rows.length}`);
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  const result = await withTenant(db, tenantWide, (tx) =>
    deliverAutoJournalEvent(tenantWide, event, tx, new Date()),
  );
  if (result.status !== "posted")
    throw new Error(`Receipt journal not posted: ${result.status}`);
}

let uomKg: string;
let supplierId: string;
let creatorId: string;
let approverId: string;
const createdUserIds: string[] = [];

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `Return Lock ${label}`, `${id}@example.com`],
  );
  createdUserIds.push(id);
  return id;
}

async function insertUom(code: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantA, `${code}${randomUUID().slice(0, 4)}`.slice(0, 10)],
  );
  return rows[0]!.id;
}

async function insertItem(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantA, `${name} ${short()}`, uomKg],
  );
  return rows[0]!.id;
}

async function insertLocation(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantA, outletA, `${name} ${short()}`],
  );
  return rows[0]!.id;
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

type Actor = { client: ReturnType<typeof agent>; userId: string };

async function makeActor(name: string, roles: string[]): Promise<Actor> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  for (const templateKey of roles)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantA, userId, await roleIdOf(templateKey), outletA],
    );
  return { client, userId };
}

let counter: Actor; // warehouse @ outletA: creates the blind counts
let other: Actor; // warehouse @ outletA: NOT a counter of any count below

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setPurchaseReturnPostingEnabled(true);
  // The receipt journal is posted only while the purchasing posting flag is on.
  setSupplierInvoicePostingEnabled(true);
  await liftDocumentCounters(owner, tenantA);
  await makeAccountingWorld();
  creatorId = await plainUser("creator");
  approverId = await plainUser("approver");
  uomKg = await insertUom("kg");
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantA, `Supplier BL ${short()}`, creatorId],
  );
  supplierId = rows[0]!.id;
  counter = await makeActor("RL Counter", ["warehouse"]);
  other = await makeActor("RL Other", ["warehouse"]);
});

afterEach(() => {
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterAll(async () => {
  setPurchaseReturnPostingEnabled(null);
  setSupplierInvoicePostingEnabled(null);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantA, createdUserIds],
    );
  await owner.end();
});

type Fixture = {
  poId: string;
  poLineId: string;
  itemId: string;
  /** Holds the whole received quantity (10 kg) -> a return of 3 kg is covered. */
  fullLocation: string;
  /** Holds only 1 kg of the item -> a return of 3 kg is short. */
  shortLocation: string;
  receiptId: string;
  receivedOn: string;
};

/**
 * A sent order of one line (10 kg flour at Rp 10.000), fully received into
 * `fullLocation`, plus a second location that holds only 1 kg of the item.
 * A return line may name either location; the receipt cap (10 kg) is not hit.
 */
async function seedFixture(): Promise<Fixture> {
  const itemId = await insertItem("Tepung BL");
  const fullLocation = await insertLocation("Gudang BL full");
  const shortLocation = await insertLocation("Gudang BL short");
  const poId = randomUUID();
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', 100000, 0, 100000, 'user',
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
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, '10.0000', $5, '10000.0000', 100000, 1) RETURNING id`,
    [tenantA, outletA, poId, itemId, uomKg],
  );
  const poLineId = rows[0]!.id;
  const receipt = await createGoodsReceipt(contextFor(outletA), other.userId, {
    outletId: outletA,
    purchaseOrderId: poId,
    lines: [
      {
        purchaseOrderLineId: poLineId,
        locationId: fullLocation,
        quantityReceived: "10.0000",
        quantityRejected: "0.0000",
      },
    ],
    idempotencyKey: key(),
  } as unknown as CreateGoodsReceiptInput);
  await journalReceipt(receipt.receipt.id);
  // Only 1 kg at the second location (it did not come from this receipt).
  await recordStockMovement(contextFor(outletA), {
    outletId: outletA,
    locationId: shortLocation,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4("1.0000"),
    unitCostIdr: decimal4("10000.0000"),
    batchId: null,
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    actor: { type: "system" },
  });
  return {
    poId,
    poLineId,
    itemId,
    fullLocation,
    shortLocation,
    receiptId: receipt.receipt.id,
    receivedOn: receipt.receipt.receivedOn,
  };
}

// ----------------------------------------------------------------- HTTP kit

const countsBase = "/api/inventory/stock-counts";

async function ok(response: Response, status?: number): Promise<Response> {
  if (status === undefined)
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  else expect(response.status, JSON.stringify(response.body)).toBe(status);
  return response;
}

async function createCount(
  actor: Actor,
  locationId: string,
  itemIds: string[],
  options: { blind?: boolean } = {},
): Promise<string> {
  const response = await actor.client
    .post(countsBase)
    .set(originHeader)
    .send({
      outletId: outletA,
      locationId,
      type: "cycle",
      blind: options.blind ?? true,
      businessDate: today,
      inventoryItemIds: itemIds,
      idempotencyKey: key("rl-count"),
    });
  await ok(response, 201);
  return response.body.data.count.id as string;
}

function cancelCount(actor: Actor, countId: string) {
  return actor.client
    .post(`${countsBase}/${countId}/transitions`)
    .set(originHeader)
    .send({ action: "cancel", idempotencyKey: key("cancel") });
}

/** Supplier return of `quantity` kg taken from `locationId`. */
function postReturn(
  actor: Actor,
  fx: Fixture,
  locationId: string,
  quantity: string,
) {
  return actor.client
    .post("/api/inventory/purchase-returns")
    .set(originHeader)
    .send({
      outletId: outletA,
      supplierId,
      purchaseOrderId: fx.poId,
      goodsReceiptId: fx.receiptId,
      returnedOn: fx.receivedOn,
      reason: "damaged",
      lines: [
        {
          purchaseOrderLineId: fx.poLineId,
          inventoryItemId: fx.itemId,
          quantity,
          locationId,
        },
      ],
      idempotencyKey: key("rl-return"),
    });
}

/** The locked answer is fixed: status, code and message never vary. */
function expectLocked(response: Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error?.code).toBe("BLIND_COUNT_LOCKED");
  expect(response.body.data).toBeUndefined();
}

function lockedShape(response: Response) {
  return {
    status: response.status,
    code: response.body.error?.code,
    message: response.body.error?.message,
  };
}

async function balanceOf(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ quantity: string }>(
    "SELECT quantity::text AS quantity FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

async function ledgerRows(locationId: string, itemId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM stock_ledger WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantA, locationId, itemId],
  );
  return rows[0]!.n;
}

async function returnCount(receiptId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
    [tenantA, receiptId],
  );
  return rows[0]!.n;
}

/** Snapshot of everything a refused return must leave untouched. */
async function snapshot(fx: Fixture, locationId: string) {
  return {
    balance: await balanceOf(locationId, fx.itemId),
    ledger: await ledgerRows(locationId, fx.itemId),
    returns: await returnCount(fx.receiptId),
  };
}

// =========================================================================

describe("legend-nxqrw BL purchase return and the blind-count lock", () => {
  it("[BL-1] a counter of an open blind count is refused 409 BLIND_COUNT_LOCKED when stock would cover the return, and nothing is posted", async () => {
    const fx = await seedFixture();
    await createCount(counter, fx.fullLocation, [fx.itemId]);
    const before = await snapshot(fx, fx.fullLocation);
    expect(before.balance).toBe("10.0000");

    expectLocked(await postReturn(counter, fx, fx.fullLocation, "3.0000"));

    expect(await snapshot(fx, fx.fullLocation)).toEqual(before);
  });

  it("[BL-2] the same counter gets the identical locked answer when stock would NOT cover the return (no insufficient-stock signal), and nothing is posted", async () => {
    const fx = await seedFixture();
    await createCount(counter, fx.fullLocation, [fx.itemId]);
    await createCount(counter, fx.shortLocation, [fx.itemId]);
    const beforeFull = await snapshot(fx, fx.fullLocation);
    const beforeShort = await snapshot(fx, fx.shortLocation);
    expect(beforeShort.balance).toBe("1.0000");

    const covered = await postReturn(counter, fx, fx.fullLocation, "3.0000");
    const uncovered = await postReturn(counter, fx, fx.shortLocation, "3.0000");

    expectLocked(covered);
    expectLocked(uncovered);
    // The answer must not depend on stock: same status, code and message, and
    // the message carries no quantity.
    expect(lockedShape(uncovered)).toEqual(lockedShape(covered));
    expect(String(uncovered.body.error?.message)).not.toMatch(/\d/);
    // And it never became INSUFFICIENT_STOCK.
    expect(uncovered.body.error?.code).not.toBe("INSUFFICIENT_STOCK");

    expect(await snapshot(fx, fx.fullLocation)).toEqual(beforeFull);
    expect(await snapshot(fx, fx.shortLocation)).toEqual(beforeShort);
  });

  it("[BL-2b] a counter is locked even on a pair with no stock record at all", async () => {
    const fx = await seedFixture();
    const empty = await insertLocation("Gudang BL empty");
    await createCount(counter, empty, [fx.itemId]);
    expectLocked(await postReturn(counter, fx, empty, "1.0000"));
    expect(await returnCount(fx.receiptId)).toBe(0);
  });

  it("[BL-3] a user who is not a counter keeps the plain answers: INSUFFICIENT_STOCK when short, success when enough", async () => {
    const fx = await seedFixture();
    await createCount(counter, fx.fullLocation, [fx.itemId]);
    await createCount(counter, fx.shortLocation, [fx.itemId]);

    const refused = await postReturn(other, fx, fx.shortLocation, "3.0000");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error?.code).toBe("INSUFFICIENT_STOCK");
    expect(await returnCount(fx.receiptId)).toBe(0);
    expect(await balanceOf(fx.shortLocation, fx.itemId)).toBe("1.0000");

    const done = await ok(
      await postReturn(other, fx, fx.fullLocation, "3.0000"),
    );
    expect(done.body.error).toBeUndefined();
    expect(await balanceOf(fx.fullLocation, fx.itemId)).toBe("7.0000");
    expect(await returnCount(fx.receiptId)).toBe(1);
  });

  it("[BL-4] a counter whose count is not blind returns normally", async () => {
    const fx = await seedFixture();
    await createCount(counter, fx.fullLocation, [fx.itemId], { blind: false });

    await ok(await postReturn(counter, fx, fx.fullLocation, "3.0000"));
    expect(await balanceOf(fx.fullLocation, fx.itemId)).toBe("7.0000");

    // Short stock keeps its honest answer when the count is not blind.
    const refused = await postReturn(counter, fx, fx.shortLocation, "3.0000");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error?.code).toBe("INSUFFICIENT_STOCK");
  });

  it("[BL-5] once the blind count is cancelled the counter returns normally", async () => {
    const fx = await seedFixture();
    const countId = await createCount(counter, fx.fullLocation, [fx.itemId]);
    await ok(await cancelCount(counter, countId));

    await ok(await postReturn(counter, fx, fx.fullLocation, "3.0000"));
    expect(await balanceOf(fx.fullLocation, fx.itemId)).toBe("7.0000");
    expect(await returnCount(fx.receiptId)).toBe(1);
  });

  it("[BL-6] the lock covers only the hidden (location, item) pair: another location of the same item is not locked", async () => {
    const fx = await seedFixture();
    // Only the full location is under a blind count; the short one is not.
    await createCount(counter, fx.fullLocation, [fx.itemId]);

    const refused = await postReturn(counter, fx, fx.shortLocation, "3.0000");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error?.code).toBe("INSUFFICIENT_STOCK");

    await ok(await postReturn(counter, fx, fx.shortLocation, "1.0000"));
    expect(await balanceOf(fx.shortLocation, fx.itemId)).toBe("0.0000");
    expectLocked(await postReturn(counter, fx, fx.fullLocation, "3.0000"));
    expect(await balanceOf(fx.fullLocation, fx.itemId)).toBe("10.0000");
  });
});
