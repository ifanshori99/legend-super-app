// Shared fixtures for the supplier-invoice / AP tests (branch
// ws/purchasing-apar, docs/briefs/ws-purchasing-apar-design.md §5, §6, §9).
// Not a test file: it builds, per call, a fresh legal entity + outlet + chart of
// accounts with every posting role mapped, open fiscal periods, a supplier, and
// three signed-in users (warehouse, buyer, finance) scoped to that outlet. A
// received purchase order is then one call away, so a test only states the
// numbers it cares about. Everything runs through the real services and the
// disposable PostgreSQL database (RLS on); the migration owner seeds fixtures.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";
import {
  outletIdSchema,
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
import { agent, signUp } from "./helpers.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import {
  createPurchaseReturn,
  type CreatePurchaseReturnInput,
} from "../services/purchase-return.service.ts";
import { createSupplierInvoice } from "../services/purchasing-invoice.service.ts";

type SupplierInvoiceCreateInput = Parameters<typeof createSupplierInvoice>[2];

export const tenantId = cafeLegendPlatformFixtures.tenant.id;
const templateOutletId = cafeLegendPlatformFixtures.outlets[0]!.id;
const app = createApp();

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

export const hex = (bytes = 4) => randomBytes(bytes).toString("hex");
export const key = () => `k-${randomUUID()}`;

export function tenantScope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

export function outletScope(outletId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(outletId) as OutletId],
    },
  );
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Role =
  | "grni"
  | "inventory"
  | "accounts_payable"
  | "ppn_input"
  | "service_expense"
  | "pph23_payable"
  | "purchase_price_variance"
  | "fixed_assets";

// [role, code, name, type, report_group]
const CHART: [Role, string, string, string, string][] = [
  ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
  ["ppn_input", "1401", "PPN Masukan", "asset", "current_asset"],
  ["fixed_assets", "1501", "Aset Tetap", "asset", "non_current_asset"],
  ["accounts_payable", "2101", "Utang Usaha", "liability", "current_liability"],
  [
    "grni",
    "2102",
    "Barang Diterima Belum Ditagih",
    "liability",
    "current_liability",
  ],
  ["pph23_payable", "2103", "Utang PPh 23", "liability", "current_liability"],
  ["service_expense", "6201", "Beban Jasa", "expense", "operating_expense"],
  [
    "purchase_price_variance",
    "5105",
    "Selisih Harga Pembelian",
    "expense",
    "cogs",
  ],
];

export type ApWorld = {
  entityId: string;
  outletId: string;
  supplierId: string;
  uomKg: string;
  accounts: Record<Role, string>;
  creatorId: string;
  approverId: string;
  warehouse: { userId: string };
  /** Holds purchasing.invoice.match (records and re-matches invoices). */
  buyer: { userId: string };
  /** Holds accounting.supplier_payment.process (releases and rejects holds). */
  finance: { userId: string };
};

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for tenant`);
  return rows[0].id;
}

async function signedIn(name: string, outletId: string, templateKey: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, await roleIdOf(templateKey), outletId],
  );
  return { userId };
}

async function plainUser(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, `AP world ${label}`, `${id}@example.com`],
  );
  return id;
}

export async function setupApWorld(): Promise<ApWorld> {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await liftDocumentCounters(owner, tenantId);
  const entityId = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entityId, tenantId, `Entity AP ${hex()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     SELECT $1, tenant_id, brand_id, $2, $3, 'Outlet AP', 'Jl. AP', 'Asia/Jakarta', '04:00', '{}', 'active'
       FROM outlets WHERE tenant_id = $4 AND id = $5`,
    [
      outletId,
      entityId,
      `AP-${hex(3)}`.toUpperCase(),
      tenantId,
      templateOutletId,
    ],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entityId, role, accounts[role]],
    );
  }
  // Open periods for last, this and next month (business dates are "today").
  const now = new Date();
  for (const shift of [-1, 0, 1]) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entityId, d.toISOString().slice(0, 7)],
    );
  }
  const creatorId = await plainUser("creator");
  const approverId = await plainUser("approver");
  const { rows: uom } = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, $2) RETURNING id",
    [tenantId, `kg${hex(3)}`.slice(0, 10)],
  );
  const { rows: supplier } = await owner.query<{ id: string }>(
    `INSERT INTO suppliers (tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, 30, true, $3) RETURNING id`,
    [tenantId, `Pemasok AP ${hex(3)}`, creatorId],
  );
  return {
    entityId,
    outletId,
    supplierId: supplier[0]!.id,
    uomKg: uom[0]!.id,
    accounts,
    creatorId,
    approverId,
    warehouse: await signedIn("AP warehouse", outletId, "warehouse"),
    buyer: await signedIn("AP buyer", outletId, "purchasing"),
    finance: await signedIn("AP finance", outletId, "finance"),
  };
}

export type ReceivedPo = {
  poId: string;
  poLineId: string;
  itemId: string;
  locationId: string;
  receiptId: string;
  receivedOn: string;
  unitPriceIdr: number;
};

/**
 * Delivers the `goods_receipt.recorded` outbox event of a receipt to the
 * auto-journal consumer, as the outbox worker would (legend-29vw): the receipt
 * journal (Dr inventory / Cr GRNI) is what lets an invoice or a return of the
 * uninvoiced part be booked. A no-op (ignored) while the posting flag is off.
 */
export async function deliverGoodsReceiptJournal(
  receiptId: string,
): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'goods_receipt.recorded'`,
    [tenantId, receiptId],
  );
  for (const row of rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    await withTenant(db, tenantScope(), (tx) =>
      deliverAutoJournalEvent(tenantScope(), event, tx, new Date()),
    );
  }
}

/** A sent PO of one line (flour) fully received into a new warehouse location. */
export async function seedReceivedPo(
  world: ApWorld,
  options: { quantity?: number; unitPriceIdr?: number } = {},
): Promise<ReceivedPo> {
  const quantity = options.quantity ?? 10;
  const unitPriceIdr = options.unitPriceIdr ?? 10_000;
  const { rows: item } = await owner.query<{ id: string }>(
    "INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id) VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id",
    [tenantId, `Tepung AP ${hex(3)}`, world.uomKg],
  );
  const { rows: location } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, world.outletId, `Gudang AP ${hex(3)}`],
  );
  const poId = randomUUID();
  const total = quantity * unitPriceIdr;
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', $6, 0, $6, 'user', $7, $8, now(), now())`,
    [
      poId,
      tenantId,
      world.outletId,
      world.supplierId,
      `PO/209912/${hex()}`,
      total,
      world.creatorId,
      world.approverId,
    ],
  );
  const { rows: line } = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING id`,
    [
      tenantId,
      world.outletId,
      poId,
      item[0]!.id,
      `${quantity}.0000`,
      world.uomKg,
      `${unitPriceIdr}.0000`,
      total,
    ],
  );
  const receipt = await createGoodsReceipt(
    outletScope(world.outletId),
    world.warehouse.userId,
    {
      outletId: world.outletId,
      purchaseOrderId: poId,
      lines: [
        {
          purchaseOrderLineId: line[0]!.id,
          locationId: location[0]!.id,
          quantityReceived: `${quantity}.0000`,
          quantityRejected: "0.0000",
          // legend-1242: a zero-price line is only receivable as a supplier bonus.
          ...(unitPriceIdr === 0 ? { isBonus: true } : {}),
        },
      ],
      idempotencyKey: key(),
    } as unknown as CreateGoodsReceiptInput,
  );
  await deliverGoodsReceiptJournal(receipt.receipt.id);
  return {
    poId,
    poLineId: line[0]!.id,
    itemId: item[0]!.id,
    locationId: location[0]!.id,
    receiptId: receipt.receipt.id,
    receivedOn: receipt.receipt.receivedOn,
    unitPriceIdr,
  };
}

/**
 * Records a supplier invoice of one goods line on the PO, as the buyer. The
 * invoice price defaults to the PO price (so it matches); the caller states the
 * PPN, which is the only tax the goods-only invoice carries.
 */
export function invoicePo(
  world: ApWorld,
  fx: ReceivedPo,
  options: {
    quantity: number;
    ppnIdr: number;
    unitPriceIdr?: number;
    number?: string;
  },
) {
  return createSupplierInvoice(
    outletScope(world.outletId),
    world.buyer.userId,
    {
      outletId: world.outletId,
      supplierId: world.supplierId,
      purchaseOrderId: fx.poId,
      number: options.number ?? `INV-${hex()}`,
      invoiceDate: fx.receivedOn,
      dueDate: addDays(fx.receivedOn, 30),
      lines: [
        {
          purchaseOrderLineId: fx.poLineId,
          kind: "goods",
          description: "Tepung",
          quantity: `${options.quantity}.0000`,
          unitPriceIdr: `${options.unitPriceIdr ?? fx.unitPriceIdr}.0000`,
        },
      ],
      ppnIdr: options.ppnIdr,
      pph23Idr: 0,
      idempotencyKey: key(),
    } as unknown as SupplierInvoiceCreateInput,
  );
}

/** A supplier return of `quantity` units of the PO line, by the warehouse. */
export function returnPo(
  world: ApWorld,
  fx: ReceivedPo,
  quantity: number,
  idempotencyKey: string = key(),
) {
  return createPurchaseReturn(
    outletScope(world.outletId),
    world.warehouse.userId,
    {
      outletId: world.outletId,
      supplierId: world.supplierId,
      purchaseOrderId: fx.poId,
      goodsReceiptId: fx.receiptId,
      returnedOn: fx.receivedOn,
      reason: "damaged",
      lines: [
        {
          purchaseOrderLineId: fx.poLineId,
          inventoryItemId: fx.itemId,
          quantity: `${quantity}.0000`,
          locationId: fx.locationId,
        },
      ],
      idempotencyKey,
    } as unknown as CreatePurchaseReturnInput,
  );
}

export type ReturnRow = {
  value: number;
  uninvoiced: number;
  invoiced: number;
  /** Billed minus order price of the invoiced part (signed; legend-29vw). */
  priceVariance: number;
  ppn: number;
};

/** Persisted value split of a return (the nota). */
export async function returnRow(returnId: string): Promise<ReturnRow> {
  const { rows } = await owner.query<{
    value_idr: string;
    uninvoiced_value_idr: string;
    invoiced_value_idr: string;
    price_variance_idr: string;
    ppn_idr: string;
  }>(
    `SELECT value_idr::text, uninvoiced_value_idr::text, invoiced_value_idr::text, price_variance_idr::text, ppn_idr::text
       FROM purchase_returns WHERE tenant_id = $1 AND id = $2`,
    [tenantId, returnId],
  );
  const row = rows[0];
  if (!row) throw new Error(`purchase return ${returnId} not found`);
  return {
    value: Number(row.value_idr),
    uninvoiced: Number(row.uninvoiced_value_idr),
    invoiced: Number(row.invoiced_value_idr),
    priceVariance: Number(row.price_variance_idr),
    ppn: Number(row.ppn_idr),
  };
}

/** The `purchase_return.recorded` payload the return wrote to the outbox. */
export async function returnEventPayload(
  returnId: string,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'purchase_return.recorded'`,
    [tenantId, returnId],
  );
  return rows[0]?.payload;
}

export async function stockOf(
  locationId: string,
  itemId: string,
): Promise<string | null> {
  const { rows } = await owner.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM stock_balances
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [tenantId, locationId, itemId],
  );
  return rows[0]?.quantity ?? null;
}

/** General ledger balance of accounts_payable (credit minus debit) of the entity. */
export async function apLedger(world: ApWorld): Promise<number> {
  const { rows } = await owner.query<{ balance: string }>(
    `SELECT coalesce(sum(credit_idr - debit_idr), 0)::text AS balance
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [tenantId, world.accounts.accounts_payable],
  );
  return Number(rows[0]!.balance);
}

export async function journalCount(world: ApWorld): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, world.entityId],
  );
  return Number(rows[0]!.n);
}

export async function closeOwner(): Promise<void> {
  await owner.end();
}
