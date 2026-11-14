// Purchase return rounding residual (second opinion 15 Nov 2026, finding 1,
// card legend-853). Written fail-first from the finding, not from the code.
//
// Finding: each partial return rounded on its own leaves a phantom inventory
// balance and inflates profit. Receive 3 units @ Rp 1.000,3333: the receipt
// journal books Dr inventory / Cr GRNI round(3 x 1000.3333) = 3.001. Three
// returns of 1 unit each credited inventory a total of 3.000. Stock is empty,
// GL inventory keeps Rp 1, and 5106 (Selisih Harga Persediaan) is credited Rp 1.
// Required behaviour: the inventory reduction of a return is
//   round(qtyBefore x avg) - round(qtyAfter x avg)   (per stock balance),
// so a staged return down to zero brings GL inventory back to exactly 0.
//
// Real flow: PO -> goods receipt (service) -> receipt journal -> three real
// purchase returns (service) -> their real outbox events -> auto-journal
// consumer. Fresh tenant, entity and outlet (no shared state, no cleanup).
//
// Assumptions:
// - Nothing is invoiced, so every return posts Dr GRNI / Cr inventory (+ the
//   self-balancing 5106 pair). "Supplier debt unchanged" is read as: the
//   supplier's payable card (aging report) and the accounts_payable ledger
//   balance stay exactly as seeded (Rp 5.000) after all returns.
// - "5106 not credited the rounding difference": no return journal carries a
//   credit line on 5106 and the net of 5106 over the whole flow is not a
//   credit. How the leftover is split (debit 5106 / other) is not pinned.
// - The ledger oracle is stock_balances: after each return GL inventory must
//   equal round(qty_left x avg).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { recordSupplierInvoicePayableInTransaction } from "../services/accounting-ap.service.ts";
import { getAgingReport } from "../services/accounting-open-items.service.ts";
import { liftDocumentCounters } from "./purchasing-document-counters.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import {
  createGoodsReceipt,
  type CreateGoodsReceiptInput,
} from "../services/inventory-receiving.service.ts";
import { setSupplierInvoicePostingEnabled } from "../services/purchasing-invoice.service.ts";
import {
  createPurchaseReturn,
  setPurchaseReturnPostingEnabled,
  type CreatePurchaseReturnInput,
} from "../services/purchase-return.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const createdWorlds: {
  tenantId: string;
  entity: string;
  outletId: string;
  poId: string;
  supplierId: string;
  itemId: string;
  locationId: string;
  uomId: string;
}[] = [];
const createdUserIds: string[] = [];

const short = () => randomUUID().slice(0, 6);
const key = () => `k-${randomUUID()}`;

const FLAGS_ON = JSON.stringify({
  modules: ["accounting"],
  integrationProviders: [],
});

type Role =
  | "grni"
  | "accounts_payable"
  | "inventory"
  | "ppn_input"
  | "cogs"
  | "purchase_price_variance"
  | "inventory_price_variance";

const CHART: [Role, string, string, string, string][] = [
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
    "purchase_price_variance",
    "5105",
    "Selisih Harga Pembelian",
    "expense",
    "cogs",
  ],
  [
    "inventory_price_variance",
    "5106",
    "Selisih Harga Persediaan",
    "expense",
    "cogs",
  ],
];

const UNIT_COST = "1000.3333";
const RECEIVED_QTY = 3;
const PAYABLE_IDR = 5_000;

type World = {
  tenantId: string;
  entity: string;
  outletId: string;
  accounts: Record<Role, string>;
  userId: string;
  supplierId: string;
  itemId: string;
  locationId: string;
  poId: string;
  poLineId: string;
  receiptId: string;
  receivedOn: string;
};

function tenantContext(world: { tenantId: string }): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

function outletContext(world: World): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "domain",
    }),
    {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(world.outletId) as OutletId],
    },
  );
}

/** Integer rupiah of q x c, half up, on decimal strings of any scale. */
function roundIdr(quantity: string, unitCost: string): number {
  const parse = (value: string): [bigint, bigint] => {
    const [whole, fraction = ""] = value.split(".");
    return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
  };
  const [q, qScale] = parse(quantity);
  const [c, cScale] = parse(unitCost);
  const denominator = qScale * cScale;
  return Number((q * c * 2n + denominator) / (2n * denominator));
}

async function seedJournal(
  world: Pick<World, "tenantId" | "entity" | "accounts">,
  debitRole: Role,
  creditRole: Role,
  amountIdr: number,
): Promise<string> {
  const { rows: period } = await owner.query<{ id: string }>(
    "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = to_char(current_date, 'YYYY-MM')",
    [world.tenantId, world.entity],
  );
  // The two-line balance trigger is deferred: insert header and lines in one transaction.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, NULL, current_date, $3, 'supplier_invoice', $4, 'Seed uji', $5, $6)
       RETURNING id`,
      [
        world.tenantId,
        world.entity,
        period[0]!.id,
        randomUUID(),
        `rr-seed-${randomUUID()}`,
        randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      ],
    );
    const entryId = rows[0]!.id;
    const lines: [string, number, number][] = [
      [world.accounts[debitRole], amountIdr, 0],
      [world.accounts[creditRole], 0, amountIdr],
    ];
    for (const [index, [accountId, debit, credit]] of lines.entries())
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
        [world.tenantId, entryId, accountId, index + 1, debit, credit],
      );
    await client.query("COMMIT");
    return entryId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Delivers one recorded outbox event of an aggregate to the auto-journal consumer. */
async function journalOutboxEvent(
  world: { tenantId: string },
  aggregateId: string,
  name: string,
) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = $3`,
    [world.tenantId, aggregateId, name],
  );
  expect(rows, `${name} outbox rows of ${aggregateId}`).toHaveLength(1);
  const event: EventEnvelope = eventEnvelopeSchema.parse(rows[0]!.event);
  const context = tenantContext(world);
  const result = await withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
  expect(result, `${name} must post: ${JSON.stringify(result)}`).toMatchObject({
    status: "posted",
  });
  if (result.status !== "posted") throw new Error("not posted");
  return result.journalEntryId;
}

/**
 * Fresh tenant + entity + outlet + chart (5106 mapped) + a supplier with
 * Rp 5.000 payable + a PO of 3 units @ 1000.3333, fully received and journaled
 * (Dr inventory / Cr GRNI round(3 x 1000.3333) = 3.001).
 */
async function makeWorld(): Promise<World> {
  const tenantId = cafeLegendPlatformFixtures.tenant.id;
  const brandId = cafeLegendPlatformFixtures.brand.id;
  const entity = randomUUID();
  const outletId = randomUUID();
  const userId = randomUUID();
  createdUserIds.push(userId);
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [userId, "Purchase return rounding test", `${userId}@example.com`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entity, tenantId, `Entity PRR ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet PRR', 'Jl. PRR', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [outletId, tenantId, brandId, entity, `RR-${short()}`.toUpperCase()],
  );
  // The services check permissions: a warehouse role on this outlet holds
  // inventory.stock.receive and purchasing.return.create.
  const roleRow = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'warehouse'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [tenantId, userId, roleRow.rows[0]!.id, outletId],
  );
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, accounts[role]],
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
      [tenantId, entity, period],
    );
  }

  // Supplier with an open payable card of Rp 5.000 (Dr cogs / Cr AP seed).
  const supplierId = randomUUID();
  await owner.query(
    `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, is_active, created_by)
     VALUES ($1, $2, $3, 30, true, $4)`,
    [supplierId, tenantId, `Pemasok PRR ${short()}`, userId],
  );
  const base = { tenantId, entity, accounts };
  const payableJournal = await seedJournal(
    base,
    "cogs",
    "accounts_payable",
    PAYABLE_IDR,
  );
  const context = tenantContext(base);
  await withTenant(db, context, (tx) =>
    recordSupplierInvoicePayableInTransaction(
      tx,
      context,
      {
        supplierInvoiceId: randomUUID(),
        legalEntityId: entity,
        outletId,
        supplierId,
        supplierName: "Pemasok Uji",
        invoiceNumber: `INV-${short()}`,
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueOn: new Date(Date.now() + 30 * 86_400_000)
          .toISOString()
          .slice(0, 10),
        dppIdr: PAYABLE_IDR,
        ppnIdr: 0,
        pph23Idr: 0,
        payableIdr: PAYABLE_IDR,
        journalEntryId: payableJournal,
        idempotencyKey: `rr-ap-${randomUUID()}`,
      },
      userIdSchema.parse(userId),
    ),
  );

  // Item, location, PO of 3 @ 1000.3333, goods receipt, receipt journal.
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, 'pcs') RETURNING id",
    [tenantId, `pcs${short()}`],
  );
  const item = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id)
     VALUES ($1, $2, 'Bahan Baku', 'raw_material', $3) RETURNING id`,
    [tenantId, `Bumbu ${short()}`, uom.rows[0]!.id],
  );
  const location = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `Gudang PRR ${short()}`],
  );
  const poId = randomUUID();
  const lineTotal = roundIdr(String(RECEIVED_QTY), UNIT_COST);
  await owner.query(
    `INSERT INTO purchase_orders
       (id, tenant_id, outlet_id, supplier_id, number, status, expected_date,
        subtotal_idr, tax_idr, total_idr, source, created_by, approved_by,
        approved_at, sent_at)
     VALUES ($1, $2, $3, $4, $5, 'sent', '2099-12-20', $6, 0, $6, 'user',
        $7, $7, now(), now())`,
    [
      poId,
      tenantId,
      outletId,
      supplierId,
      `PO/209912/${short()}`,
      lineTotal,
      userId,
    ],
  );
  const poLine = await owner.query<{ id: string }>(
    `INSERT INTO purchase_order_lines
       (tenant_id, outlet_id, purchase_order_id, inventory_item_id, quantity,
        uom_id, unit_price_idr, line_total_idr, line_no)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1) RETURNING id`,
    [
      tenantId,
      outletId,
      poId,
      item.rows[0]!.id,
      `${RECEIVED_QTY}.0000`,
      uom.rows[0]!.id,
      UNIT_COST,
      lineTotal,
    ],
  );
  const world: World = {
    tenantId,
    entity,
    outletId,
    accounts,
    userId,
    supplierId,
    itemId: item.rows[0]!.id,
    locationId: location.rows[0]!.id,
    poId,
    poLineId: poLine.rows[0]!.id,
    receiptId: "",
    receivedOn: "",
  };
  createdWorlds.push({
    tenantId,
    entity,
    outletId,
    poId,
    supplierId,
    itemId: world.itemId,
    locationId: world.locationId,
    uomId: uom.rows[0]!.id,
  });
  const receipt = await createGoodsReceipt(outletContext(world), userId, {
    outletId,
    purchaseOrderId: poId,
    lines: [
      {
        purchaseOrderLineId: world.poLineId,
        locationId: world.locationId,
        quantityReceived: `${RECEIVED_QTY}.0000`,
        quantityRejected: "0.0000",
      },
    ],
    idempotencyKey: key(),
  } as unknown as CreateGoodsReceiptInput);
  world.receiptId = receipt.receipt.id;
  world.receivedOn = receipt.receipt.receivedOn;
  await journalOutboxEvent(world, world.receiptId, "goods_receipt.recorded");
  return world;
}

/** One real return of `quantity` units; returns its posted journal id. */
async function returnAndJournal(world: World, quantity: string) {
  const detail = await createPurchaseReturn(
    outletContext(world),
    world.userId,
    {
      outletId: world.outletId,
      supplierId: world.supplierId,
      purchaseOrderId: world.poId,
      goodsReceiptId: world.receiptId,
      returnedOn: world.receivedOn,
      reason: "damaged",
      lines: [
        {
          purchaseOrderLineId: world.poLineId,
          inventoryItemId: world.itemId,
          quantity,
          locationId: world.locationId,
        },
      ],
      idempotencyKey: key(),
    } as unknown as CreatePurchaseReturnInput,
  );
  const journalId = await journalOutboxEvent(
    world,
    detail.purchaseReturn.id,
    "purchase_return.recorded",
  );
  return { detail, journalId };
}

// ---- reads ------------------------------------------------------------------

async function glNet(world: World, role: Role): Promise<number> {
  const { rows } = await owner.query<{ net: string | null }>(
    `SELECT sum(debit_idr - credit_idr)::text AS net
       FROM journal_lines WHERE tenant_id = $1 AND account_id = $2`,
    [world.tenantId, world.accounts[role]],
  );
  return Number(rows[0]!.net ?? 0);
}

async function entryLines(world: World, entryId: string) {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenantId, entryId],
  );
  const roleOf = new Map(
    (Object.entries(world.accounts) as [Role, string][]).map(([role, id]) => [
      id,
      role,
    ]),
  );
  return rows.map((row) => ({
    role: roleOf.get(row.account_id)!,
    debit: Number(row.debit),
    credit: Number(row.credit),
  }));
}

function expectBalanced(lines: { debit: number; credit: number }[]): void {
  const debit = lines.reduce((total, line) => total + line.debit, 0);
  const credit = lines.reduce((total, line) => total + line.credit, 0);
  expect(debit).toBeGreaterThan(0);
  expect(debit).toBe(credit);
}

async function stockBalance(world: World) {
  const { rows } = await owner.query<{ quantity: string; avg: string }>(
    `SELECT quantity::text AS quantity, avg_cost_idr::text AS avg FROM stock_balances
      WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3`,
    [world.tenantId, world.locationId, world.itemId],
  );
  expect(rows, "stock_balances row").toHaveLength(1);
  return rows[0]!;
}

async function supplierPayable(world: World): Promise<number> {
  const report = await getAgingReport(tenantContext(world), {
    legalEntityId: world.entity,
    kind: "payable",
    asOf: new Date().toISOString().slice(0, 10),
  });
  return (
    report.rows.find((row) => row.counterpartyId === world.supplierId)
      ?.totalIdr ?? 0
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setPurchaseReturnPostingEnabled(true);
  // The receipt journal is posted only while the purchasing posting flag is on.
  setSupplierInvoicePostingEnabled(true);
  setAuditWriter(coreAuditWriter);
  await liftDocumentCounters(owner, cafeLegendPlatformFixtures.tenant.id);
});

afterEach(() => {
  setPurchaseReturnPostingEnabled(true);
  setSupplierInvoicePostingEnabled(true);
});

afterAll(async () => {
  setPurchaseReturnPostingEnabled(null);
  setSupplierInvoicePostingEnabled(null);
  setAuditWriter(null);
  // Ledger, journal and outbox rows are append-only; replica mode lets the
  // owner remove its own fixtures. Everything is keyed by this file's own
  // fresh legal entity and outlet, so no other suite's data is touched.
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows: tables } = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('legal_entity_id', 'outlet_id')
          AND table_name NOT IN ('outlets', 'legal_entities')
          AND table_name IN (SELECT table_name FROM information_schema.tables
                              WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`,
    );
    for (const w of createdWorlds) {
      await client.query(
        `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event->>'outletId' = $2`,
        [w.tenantId, w.outletId],
      );
      for (const t of tables)
        await client.query(
          `DELETE FROM "${t.table_name}" WHERE "${t.column_name}" = $1`,
          [t.column_name === "legal_entity_id" ? w.entity : w.outletId],
        );
      await client.query(
        "DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE legal_entity_id = $1)",
        [w.entity],
      );
      await client.query("DELETE FROM purchase_orders WHERE id = $1", [w.poId]);
      for (const table of ["stock_balances", "stock_batches", "stock_ledger"])
        await client
          .query(
            `DELETE FROM ${table} WHERE tenant_id = $1 AND location_id = $2`,
            [w.tenantId, w.locationId],
          )
          .catch(() => undefined);
      await client.query("DELETE FROM stock_locations WHERE id = $1", [
        w.locationId,
      ]);
      await client.query("DELETE FROM inventory_items WHERE id = $1", [
        w.itemId,
      ]);
      await client.query("DELETE FROM uoms WHERE id = $1", [w.uomId]);
      await client.query("DELETE FROM suppliers WHERE id = $1", [w.supplierId]);
      await client.query("DELETE FROM outlets WHERE id = $1", [w.outletId]);
      await client.query("DELETE FROM legal_entities WHERE id = $1", [
        w.entity,
      ]);
    }
    await client.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
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

// ============================================================================

describe("staged purchase return of a fractional-cost receipt", () => {
  it("PRR-01 receive 3 @ 1.000,3333, return 1+1+1: GL inventory ends at 0, 5106 is never credited, each journal balanced, supplier payable unchanged", async () => {
    const world = await makeWorld();

    // Starting point: receipt journal booked round(3 x 1000.3333) = 3.001.
    expect(await glNet(world, "inventory")).toBe(3_001);
    expect(await glNet(world, "grni")).toBe(-3_001);
    const payableGl = await glNet(world, "accounts_payable");
    expect(payableGl).toBe(-PAYABLE_IDR);
    expect(await supplierPayable(world)).toBe(PAYABLE_IDR);

    const journals: string[] = [];
    for (let step = 0; step < 3; step += 1) {
      const { journalId } = await returnAndJournal(world, "1.0000");
      journals.push(journalId);
    }

    // Stock is empty.
    expect(Number((await stockBalance(world)).quantity)).toBe(0);

    // Every return journal is balanced and never credits 5106.
    for (const journalId of journals) {
      const lines = await entryLines(world, journalId);
      expectBalanced(lines);
      for (const line of lines)
        if (line.role === "inventory_price_variance")
          expect(
            line.credit,
            "5106 must not be credited by a rounding difference",
          ).toBe(0);
    }

    // The bug: GL inventory keeps Rp 1 of phantom stock (3.001 - 3.000).
    expect(await glNet(world, "inventory")).toBe(0);
    // And profit is not inflated by a 5106 credit.
    expect(
      await glNet(world, "inventory_price_variance"),
    ).toBeGreaterThanOrEqual(0);

    // Debt to the supplier is untouched by an uninvoiced return.
    expect(await glNet(world, "accounts_payable")).toBe(payableGl);
    expect(await supplierPayable(world)).toBe(PAYABLE_IDR);
  });

  it("PRR-02 after every staged return GL inventory equals round(qty left x avg)", async () => {
    const world = await makeWorld();
    for (let step = 1; step <= 3; step += 1) {
      await returnAndJournal(world, "1.0000");
      const balance = await stockBalance(world);
      expect(
        await glNet(world, "inventory"),
        `GL inventory after return ${step} of 3 (qty left ${balance.quantity}, avg ${balance.avg})`,
      ).toBe(roundIdr(balance.quantity, balance.avg));
    }
  });
});
