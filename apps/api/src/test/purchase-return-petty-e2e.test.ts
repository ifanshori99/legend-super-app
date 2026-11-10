// End to end: purchase return and petty purchase through to the general ledger
// (cards legend-1xbs, legend-v3lh; brief docs/briefs/298a-sub-purchase-return-
// posting-design.md; PRD v1.7 §3.18 Retur Pembelian / Pembelian Sederhana,
// §3.19 Jurnal Otomatis; ACC-01 balanced journals).
//
// Unlike accounting-purchase-return-journal.test.ts (synthetic envelopes), the
// events here are the real outbox rows written by the services, handed to
// `deliverAutoJournalEvent`. Needs the disposable PostgreSQL database. All
// accounting data lives on a fresh legal entity + outlet of the Cafe Legend
// tenant (own chart, mappings, periods) and is removed again in afterAll.
//
// Ids used in test names:
// - PRE-1 return -> outbox event -> journal Dr GRNI / Cr inventory, replay once
// - PRE-2 petty purchase -> outbox event -> journal Dr 5104 / Cr petty cash
// - PRE-3 HTTP guards: gate off, wrong role, missing permission, anonymous
//
// Assumptions:
// - Nothing is invoiced in these tests, so the whole return value is
//   uninvoiced and posts to the GRNI role (Dr grni / Cr inventory).
// - A replayed delivery answers `{ status: "already_posted" }` with the same
//   journal id (as in accounting-purchase-return-journal.test.ts).
// - Guard failures answer 403; FEATURE_DISABLED is asserted for the gate only,
//   the other 403s are asserted by status (the code name is not pinned).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import {
  createPurchaseReturn,
  setPurchaseReturnPostingEnabled,
  type CreatePurchaseReturnInput,
} from "../services/purchase-return.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const brandA = cafeLegendPlatformFixtures.brand.id;

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const short = () => randomUUID().slice(0, 6);
const key = () => `k-${randomUUID()}`;

type Role =
  | "grni"
  | "accounts_payable"
  | "inventory"
  | "ppn_input"
  | "petty_cash"
  | "petty_purchase_expense"
  | "cogs";

const CHART: [Role, string, string, string, string][] = [
  ["petty_cash", "1102", "Kas Kecil", "asset", "cash_and_equivalents"],
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
  ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
  [
    "petty_purchase_expense",
    "5104",
    "Pembelian Langsung (Kas Kecil)",
    "expense",
    "cogs",
  ],
];

// Fresh accounting world of this file.
const entityId = randomUUID();
const outletC = randomUUID();
const accounts = {} as Record<Role, string>;

const tenantContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantA),
    brandId: null,
    source: "domain",
  }),
  { kind: "tenant" },
);

function outletContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantA),
      brandId: null,
      source: "domain",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletC) as OutletId] },
  );
}

const createdUserIds: string[] = [];
const createdUomIds: string[] = [];
const createdItemIds: string[] = [];
const createdLocationIds: string[] = [];
const createdOrderIds: string[] = [];
const createdStorageIds: string[] = [];
const createdSupplierIds: string[] = [];

type Session = { client: ReturnType<typeof agent>; userId: string };
let warehouse: Session;
let nobody: Session;
let finance: Session;
let recorder: Session;
let creatorId: string;
let approverId: string;
let supplierId: string;
let uomKg: string;
let uomGram: string;

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantA, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant ${tenantA}`);
  return rows[0].id;
}

async function signedIn(
  name: string,
  grants: { role: string; outletId: string | null }[],
): Promise<Session> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
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
  return { client, userId };
}

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `PRE ${label}`, `${id}@example.com`],
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

async function insertLocation(): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantA, outletC, `Gudang PRE ${short()}`],
  );
  createdLocationIds.push(rows[0]!.id);
  return rows[0]!.id;
}

/** A fresh legal entity + outlet + chart with every posting role mapped. */
async function makeAccountingWorld(): Promise<void> {
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entityId, tenantA, `Entity PRE ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PRE', 'Jl. PRE', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletC, tenantA, brandA, entityId, `PRE-${short()}`.toUpperCase()],
  );
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantA, entityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantA, entityId, role, accounts[role]],
    );
  }
  // Open periods around today: the services stamp the outlet's business date.
  const now = new Date();
  for (const shift of [-1, 0, 1]) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantA, entityId, period],
    );
  }
}

// ---- purchase fixtures -----------------------------------------------------

type Fixture = {
  poId: string;
  flourLine: string;
  sugarLine: string;
  flour: string;
  sugar: string;
  location: string;
  receiptId: string;
  receivedOn: string;
};

/** Sent order (flour 10 kg x 10.000, sugar 4 kg x 20.000 in g), fully received. */
async function seedReceivedFixture(): Promise<Fixture> {
  const flour = await insertItem(uomKg, "Tepung PRE");
  const sugar = await insertItem(uomGram, "Gula PRE");
  await owner.query(
    `INSERT INTO uom_conversions (tenant_id, inventory_item_id, from_uom_id, to_uom_id, factor)
     VALUES ($1, $2, $3, $4, 1000)`,
    [tenantA, sugar, uomKg, uomGram],
  );
  const location = await insertLocation();
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
      outletC,
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
      [tenantA, outletC, poId, item, quantity, uom, price, total, lineNo],
    );
    lineIds.push(rows[0]!.id);
  }
  const receipt = await createGoodsReceipt(outletContext(), warehouse.userId, {
    outletId: outletC,
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
  } as unknown as CreateGoodsReceiptInput);
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

function returnBody(fx: Fixture, lines: Record<string, unknown>[]) {
  return {
    outletId: outletC,
    supplierId,
    purchaseOrderId: fx.poId,
    goodsReceiptId: fx.receiptId,
    returnedOn: fx.receivedOn,
    reason: "damaged",
    lines,
    idempotencyKey: key(),
  };
}

const flourLine = (fx: Fixture, quantity: string) => ({
  purchaseOrderLineId: fx.flourLine,
  inventoryItemId: fx.flour,
  quantity,
  locationId: fx.location,
});

const sugarLine = (fx: Fixture, quantity: string) => ({
  purchaseOrderLineId: fx.sugarLine,
  inventoryItemId: fx.sugar,
  quantity,
  locationId: fx.location,
});

async function returnCount(receiptId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id = $2",
    [tenantA, receiptId],
  );
  return rows[0]!.n;
}

async function pettyCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantA, outletC],
  );
  return rows[0]!.n;
}

async function insertPhoto(ownerUserId: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
     VALUES ($1, $2, $3, 'receipt', $4, 'image/webp', 1024, $5)`,
    [tenantA, outletC, id, `legend-pre/${id}.webp`, ownerUserId],
  );
  createdStorageIds.push(id);
  return id;
}

async function pettyBody(uploader: Session) {
  return {
    outletId: outletC,
    vendorName: "Pasar Induk",
    description: "Cabai dan bawang",
    amountIdr: 50000,
    photoMediaId: await insertPhoto(uploader.userId),
    idempotencyKey: key(),
  };
}

const postPetty = (client: Session["client"], body: Record<string, unknown>) =>
  client
    .post("/api/inventory/petty-purchases")
    .set(originHeader)
    .send(body as object);

const postReturn = (client: Session["client"], body: Record<string, unknown>) =>
  client
    .post("/api/inventory/purchase-returns")
    .set(originHeader)
    .send(body as object);

// ---- outbox + journal reads -----------------------------------------------

/** The real envelope the service wrote to the outbox for one aggregate. */
async function outboxEvent(
  aggregateId: string,
  name: string,
): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [tenantA, aggregateId, name],
  );
  expect(rows, `${name} outbox rows of ${aggregateId}`).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

const NOW = () => new Date();

function deliver(event: EventEnvelope) {
  return withTenant(db, tenantContext, (tx) =>
    deliverAutoJournalEvent(tenantContext, event, tx, NOW()),
  );
}

type JournalLine = { role: Role; debit: number; credit: number };

async function linesOf(entryId: string): Promise<JournalLine[]> {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [tenantA, entryId],
  );
  const roleOf = new Map(
    (Object.entries(accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows
    .map((row) => ({
      role: roleOf.get(row.account_id)!,
      debit: Number(row.debit),
      credit: Number(row.credit),
    }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

function expectBalanced(lines: JournalLine[]): void {
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

async function journalsOfKey(
  idempotencyKey: string,
): Promise<{ id: string; source_type: string; outlet_id: string | null }[]> {
  const { rows } = await owner.query<{
    id: string;
    source_type: string;
    outlet_id: string | null;
  }>(
    "SELECT id, source_type, outlet_id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantA, entityId, idempotencyKey],
  );
  return rows;
}

async function journalCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantA, entityId],
  );
  return Number(rows[0]!.n);
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setPurchaseReturnPostingEnabled(true);
  setAuditWriter(coreAuditWriter);
  await makeAccountingWorld();
  creatorId = await plainUser("creator");
  approverId = await plainUser("approver");
  // warehouse holds inventory.stock.receive and purchasing.return.create.
  warehouse = await signedIn("PRE warehouse", [
    { role: "warehouse", outletId: outletC },
  ]);
  nobody = await signedIn("PRE nobody", []);
  finance = await signedIn("PRE finance", [
    { role: "finance", outletId: null },
  ]);
  recorder = await signedIn("PRE recorder", [
    { role: "outlet_manager", outletId: outletC },
  ]);
  uomKg = await insertUom("kg");
  uomGram = await insertUom("g");
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantA, `Supplier PRE ${short()}`, creatorId],
  );
  supplierId = rows[0]!.id;
  createdSupplierIds.push(supplierId);
});

afterEach(() => {
  setPurchaseReturnPostingEnabled(true);
});

afterAll(async () => {
  setPurchaseReturnPostingEnabled(null);
  setAuditWriter(null);
  // Ledger, journal and outbox rows are append-only; replica mode lets the
  // owner remove its own fixtures (this file only touches its own outlet C).
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const receipts = `(SELECT id FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[]))`;
    const returns = `(SELECT id FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts})`;
    const petty = `(SELECT id FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = $3)`;
    const args = [tenantA, createdOrderIds, outletC];
    await client.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND (aggregate_id IN ${receipts} OR aggregate_id IN ${returns} OR aggregate_id IN ${petty}) AND $3::uuid IS NOT NULL`,
      args,
    );
    await client.query(
      `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)`,
      [tenantA, entityId],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantA, entityId],
    );
    await client.query(
      `DELETE FROM stock_ledger WHERE tenant_id = $1 AND (source_id IN ${receipts} OR source_id IN ${returns}) AND $3::uuid IS NOT NULL`,
      args,
    );
    await client.query(
      `DELETE FROM purchase_return_lines WHERE tenant_id = $1 AND purchase_return_id IN ${returns} AND $3::uuid IS NOT NULL`,
      args,
    );
    await client.query(
      `DELETE FROM purchase_returns WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts} AND $3::uuid IS NOT NULL`,
      args,
    );
    await client.query(
      `DELETE FROM goods_receipt_lines WHERE tenant_id = $1 AND goods_receipt_id IN ${receipts} AND $3::uuid IS NOT NULL`,
      args,
    );
    await client.query(
      "DELETE FROM goods_receipts WHERE tenant_id = $1 AND purchase_order_id = ANY($2::uuid[])",
      [tenantA, createdOrderIds],
    );
    await client.query(
      "DELETE FROM petty_purchases WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantA, outletC],
    );
    await client.query(
      "DELETE FROM petty_purchase_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantA, outletC],
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
    await client.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantA, entityId],
    );
    await client.query(
      "DELETE FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantA, entityId],
    );
    await client.query(
      "DELETE FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantA, entityId],
    );
    await client.query("DELETE FROM outlets WHERE id = $1", [outletC]);
    await client.query("DELETE FROM legal_entities WHERE id = $1", [entityId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
});

// ============================================================================

describe("purchase return and petty purchase to the ledger, end to end", () => {
  it("[PRE-1] a recorded return posts Dr GRNI / Cr inventory for the line sum, balanced, and a replay posts once", async () => {
    const fx = await seedReceivedFixture();
    // Flour 3 kg at Rp 10.000 = 30.000; sugar 1000 g of 4000 g (Rp 80.000) = 20.000.
    const detail = await createPurchaseReturn(
      outletContext(),
      warehouse.userId,
      returnBody(fx, [
        flourLine(fx, "3.0000"),
        sugarLine(fx, "1000.0000"),
      ]) as unknown as CreatePurchaseReturnInput,
    );
    const lineSum = detail.lines.reduce(
      (total, line) => total + line.lineValueIdr,
      0,
    );
    expect(lineSum).toBe(50_000);
    expect(detail.purchaseReturn.valueIdr).toBe(lineSum);

    const event = await outboxEvent(
      detail.purchaseReturn.id,
      "purchase_return.recorded",
    );
    expect(event.payload).toMatchObject({
      purchaseReturnId: detail.purchaseReturn.id,
      valueIdr: lineSum,
    });

    const first = await deliver(event);
    expect(first.status).toBe("posted");
    if (first.status !== "posted") throw new Error("not posted");

    const journalKey = `aj:purchase-return:${detail.purchaseReturn.id}`;
    const entries = await journalsOfKey(journalKey);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: first.journalEntryId,
      source_type: "purchase_return",
      outlet_id: outletC,
    });
    const lines = await linesOf(first.journalEntryId);
    expect(lines).toEqual([
      { role: "grni", debit: lineSum, credit: 0 },
      { role: "inventory", debit: 0, credit: lineSum },
    ]);
    expectBalanced(lines);

    // Replay of the same delivery: still one journal, same entry.
    const before = await journalCount();
    const replay = await deliver(event);
    expect(replay.status).toBe("already_posted");
    expect(await journalsOfKey(journalKey)).toHaveLength(1);
    expect(await journalCount()).toBe(before);
    expect(await linesOf(first.journalEntryId)).toEqual(lines);
  });

  it("[PRE-2] a recorded petty purchase posts Dr 5104 petty-purchase expense / Cr petty cash, balanced, once", async () => {
    // The outlet limit must allow the spend (no policy denies by default).
    const policy = await finance.client
      .put("/api/inventory/petty-purchase-policy")
      .set(originHeader)
      .send({ outletId: outletC, limitIdr: 100_000, idempotencyKey: key() });
    expect(policy.status).toBe(200);

    const res = await postPetty(recorder.client, await pettyBody(recorder));
    expect(res.status).toBe(201);
    const purchase = res.body.data as { id: string; amountIdr: number };
    expect(purchase.amountIdr).toBe(50_000);

    const event = await outboxEvent(purchase.id, "petty_purchase.recorded");
    expect(event.payload).toMatchObject({
      pettyPurchaseId: purchase.id,
      amountIdr: 50_000,
    });

    const first = await deliver(event);
    expect(first.status).toBe("posted");
    if (first.status !== "posted") throw new Error("not posted");

    const journalKey = `aj:petty-purchase:${purchase.id}`;
    const entries = await journalsOfKey(journalKey);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: first.journalEntryId,
      source_type: "petty_purchase",
      outlet_id: outletC,
    });
    const lines = await linesOf(first.journalEntryId);
    expect(lines).toEqual([
      { role: "petty_cash", debit: 0, credit: 50_000 },
      { role: "petty_purchase_expense", debit: 50_000, credit: 0 },
    ]);
    expectBalanced(lines);

    const replay = await deliver(event);
    expect(replay.status).toBe("already_posted");
    expect(await journalsOfKey(journalKey)).toHaveLength(1);
  });

  it("[PRE-3] HTTP guards: gate off answers 403 FEATURE_DISABLED, wrong role and missing permission answer 403, anonymous 401", async () => {
    const fx = await seedReceivedFixture();
    const input = () => returnBody(fx, [flourLine(fx, "1.0000")]);

    // Gate off: refused before any write, even for a permitted role.
    setPurchaseReturnPostingEnabled(false);
    const gated = await postReturn(warehouse.client, input());
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe("FEATURE_DISABLED");
    expect(await returnCount(fx.receiptId)).toBe(0);
    setPurchaseReturnPostingEnabled(true);

    // Gate on: a user without the role is refused, nothing written.
    const wrongRole = await postReturn(nobody.client, input());
    expect(wrongRole.status).toBe(403);
    expect(await returnCount(fx.receiptId)).toBe(0);

    // Anonymous caller.
    expect((await postReturn(agent(app), input())).status).toBe(401);

    // Control: the same request by the warehouse user succeeds, so the 403s
    // above are the guards and not a malformed body.
    const ok = await postReturn(warehouse.client, input());
    expect(ok.status).toBe(201);
    expect(await returnCount(fx.receiptId)).toBe(1);

    // Petty purchase without the permission (warehouse and no-role users).
    await finance.client
      .put("/api/inventory/petty-purchase-policy")
      .set(originHeader)
      .send({ outletId: outletC, limitIdr: 100_000, idempotencyKey: key() });
    const before = await pettyCount();
    for (const denied of [warehouse, nobody]) {
      const res = await postPetty(denied.client, await pettyBody(denied));
      expect(res.status).toBe(403);
    }
    expect(await pettyCount()).toBe(before);
    expect(
      (await postPetty(agent(app), await pettyBody(recorder))).status,
    ).toBe(401);
  });
});
