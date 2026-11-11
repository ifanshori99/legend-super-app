// Fail-closed review of the PPh 23 / PPN sources (bead legend-v4v7c, Slice D,
// architect review holes). Fixtures mirror accounting-tax-source-vat-wht.test.ts.
//
// - No supplier invoice record but ledger activity on pph23_payable / ppn_input
//   -> 422 TAX_REPORT_SOURCE_UNAVAILABLE; the roles are always resolved.
// - Ledger activity on ppn_input / pph23_payable from a source other than
//   supplier_invoice (purchase return, manual) -> 422 naming the source.
// - Sales ledger credits on tax_payable_ppn without any PPN snapshot -> 422.
// - A supplier invoice reversed in the same period nets out (not stuck).
// - Replaying a supplier invoice record with other DPP / PPN / PPh 23 -> 409.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createUlid,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { recordSupplierInvoicePayableInTransaction } from "../services/accounting-ap.service";
import { generateTaxReport } from "../services/accounting-tax-reports.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const user = randomUUID();
const actor = userIdSchema.parse(user);
const createdSupplierIds: string[] = [];
const createdInvoiceIds: string[] = [];

const scope = (tenant: string = tenantId): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant as TenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [user, "Tax source vat wht review test", `${user}@example.com`],
  );
});

afterAll(async () => {
  const quietly = (sql: string, params: unknown[]) =>
    owner.query(sql, params).catch(() => undefined);
  await quietly(
    "DELETE FROM tax_reports WHERE tenant_id = $1 AND generated_by = $2",
    [tenantId, user],
  );
  await quietly(
    "DELETE FROM supplier_invoices WHERE supplier_id = ANY($1::uuid[])",
    [createdSupplierIds],
  );
  await quietly(
    "DELETE FROM accounting_open_items WHERE id = ANY($1::uuid[])",
    [createdInvoiceIds],
  );
  await quietly("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
    createdSupplierIds,
  ]);
  await quietly('DELETE FROM "user" WHERE id = $1', [user]);
  await owner.end();
});

// ---- Fixtures ----------------------------------------------------------------

type Role =
  | "accounts_payable"
  | "ppn_input"
  | "pph23_payable"
  | "tax_payable_ppn"
  | "sales_revenue"
  | "cash_on_hand";

type World = {
  entity: string;
  accounts: Record<Role | "expense", string>;
  nov: string;
};

async function makeWorld(options: { omit?: Role[] } = {}): Promise<World> {
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, true)",
    [entity, tenantId, `Tax vat wht review ${unique()}`],
  );
  const accounts = {
    cash_on_hand: randomUUID(),
    sales_revenue: randomUUID(),
    accounts_payable: randomUUID(),
    ppn_input: randomUUID(),
    pph23_payable: randomUUID(),
    tax_payable_ppn: randomUUID(),
    expense: randomUUID(),
  };
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $8, $9, '1101', 'Kas', 'asset', 'current_asset'),
            ($2, $8, $9, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $8, $9, '2101', 'Utang Usaha', 'liability', 'current_liability'),
            ($4, $8, $9, '1301', 'PPN Masukan', 'asset', 'current_asset'),
            ($5, $8, $9, '2105', 'Utang PPh 23', 'liability', 'current_liability'),
            ($6, $8, $9, '2106', 'Utang PPN', 'liability', 'current_liability'),
            ($7, $8, $9, '6201', 'Beban Pembelian', 'expense', 'operating_expense')`,
    [
      accounts.cash_on_hand,
      accounts.sales_revenue,
      accounts.accounts_payable,
      accounts.ppn_input,
      accounts.pph23_payable,
      accounts.tax_payable_ppn,
      accounts.expense,
      tenantId,
      entity,
    ],
  );
  const omit = new Set(options.omit ?? []);
  for (const role of Object.keys(accounts) as (Role | "expense")[]) {
    if (role === "expense" || omit.has(role as Role)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, accounts[role]],
    );
  }
  const periods = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11') RETURNING id`,
    [tenantId, entity],
  );
  return { entity, accounts, nov: periods.rows[0]!.id };
}

async function makeSupplier(name: string, npwp: string | null) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by, npwp)
     VALUES ($1, $2, $3, 30, $4, $5)`,
    [id, tenantId, `${name} ${unique()}`, user, npwp],
  );
  createdSupplierIds.push(id);
  return id;
}

type Posting = [account: string, debitIdr: number, creditIdr: number];

/** One balanced journal entry in its own transaction (a reversal when reversalOf is set). */
async function postEntry(
  world: World,
  input: {
    sourceType: string;
    sourceId: string | null;
    lines: Posting[];
    reversalOf?: string;
    outlet?: string | null;
  },
): Promise<string> {
  const outlet = input.outlet === undefined ? outletA : input.outlet;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, reversal_of, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, '2026-11-05', $4, $5, $6, $7, 'Tax vat wht review', $8, $9)
       RETURNING id`,
      [
        tenantId,
        world.entity,
        outlet,
        world.nov,
        input.sourceType,
        input.sourceId,
        input.reversalOf ?? null,
        `tvwr-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const [account, debit, credit] of input.lines)
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, entryId, account, outlet, lineNo++, debit, credit],
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

type InvoiceSeed = {
  supplierId: string;
  dpp: number;
  ppn?: number;
  pph23?: number;
  idempotencyKey?: string;
  supplierInvoiceId?: string;
  invoiceNumber?: string;
};

function recordInvoice(
  world: World,
  seed: InvoiceSeed,
  journalEntryId: string | null,
) {
  const ppn = seed.ppn ?? 0;
  const pph23 = seed.pph23 ?? 0;
  const supplierInvoiceId = seed.supplierInvoiceId ?? randomUUID();
  const idempotencyKey = seed.idempotencyKey ?? `ap-${unique()}-${unique()}`;
  const invoiceNumber = seed.invoiceNumber ?? `INV-${unique()}`;
  const context = scope();
  const run = () =>
    withTenant(db, context, (tx) =>
      recordSupplierInvoicePayableInTransaction(
        tx,
        context,
        {
          supplierInvoiceId,
          legalEntityId: world.entity,
          outletId: outletA,
          supplierId: seed.supplierId,
          supplierName: "Pemasok Uji",
          invoiceNumber,
          invoiceDate: "2026-11-05",
          dueOn: "2026-12-31",
          dppIdr: seed.dpp,
          ppnIdr: ppn,
          pph23Idr: pph23,
          payableIdr: seed.dpp + ppn - pph23,
          journalEntryId,
          idempotencyKey,
        } as never,
        actor,
      ),
    );
  createdInvoiceIds.push(supplierInvoiceId);
  return { run, supplierInvoiceId };
}

/** Supplier invoice: ledger journal plus the structured record. */
async function postSupplierInvoice(world: World, seed: InvoiceSeed) {
  const ppn = seed.ppn ?? 0;
  const pph23 = seed.pph23 ?? 0;
  const sourceId = createUlid();
  const lines: Posting[] = [[world.accounts.expense, seed.dpp, 0]];
  if (ppn > 0) lines.push([world.accounts.ppn_input, ppn, 0]);
  if (pph23 > 0) lines.push([world.accounts.pph23_payable, 0, pph23]);
  lines.push([world.accounts.accounts_payable, 0, seed.dpp + ppn - pph23]);
  const journalEntryId = await postEntry(world, {
    sourceType: "supplier_invoice",
    sourceId,
    lines,
  });
  const record = recordInvoice(world, seed, journalEntryId);
  await record.run();
  return { journalEntryId, lines };
}

/** A bare supplier invoice journal for tests that only record the invoice. */
const invoiceJournal = (world: World) =>
  postEntry(world, {
    sourceType: "supplier_invoice",
    sourceId: createUlid(),
    lines: [
      [world.accounts.expense, 1, 0],
      [world.accounts.accounts_payable, 0, 1],
    ],
  });

const generate = (world: World, type: "pph23" | "ppn") =>
  generateTaxReport(scope(), actor, {
    legalEntityId: world.entity,
    type,
    period: "2026-11",
  } as never);

async function errorOf(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (error) {
    return error as { code?: string; status?: number; message?: string };
  }
}

async function expectUnavailable(run: Promise<unknown>, mention?: string) {
  const error = await errorOf(run);
  expect(error?.code, String(error)).toBe("TAX_REPORT_SOURCE_UNAVAILABLE");
  expect(error?.status).toBe(422);
  if (mention) expect(error?.message).toContain(mention);
}

// ---- 1: no records, ledger activity -------------------------------------------

describe("legend-v4v7c review: no invoice records but ledger activity", () => {
  it("pph23: pph23_payable credited by a supplier invoice journal without any record -> 422", async () => {
    const world = await makeWorld();
    await postEntry(world, {
      sourceType: "supplier_invoice",
      sourceId: createUlid(),
      lines: [
        [world.accounts.expense, 1_000_000, 0],
        [world.accounts.pph23_payable, 0, 20_000],
        [world.accounts.accounts_payable, 0, 980_000],
      ],
    });
    await expectUnavailable(generate(world, "pph23"));
  });

  it("ppn: ppn_input debited by a supplier invoice journal without any record -> 422", async () => {
    const world = await makeWorld();
    await postEntry(world, {
      sourceType: "supplier_invoice",
      sourceId: createUlid(),
      lines: [
        [world.accounts.expense, 1_000_000, 0],
        [world.accounts.ppn_input, 110_000, 0],
        [world.accounts.accounts_payable, 0, 1_110_000],
      ],
    });
    await expectUnavailable(generate(world, "ppn"));
  });

  it("an empty period with mapped roles and nothing on the ledger stays an empty report", async () => {
    const world = await makeWorld();
    for (const type of ["pph23", "ppn"] as const) {
      const report = await generate(world, type);
      expect(report.lines, type).toEqual([]);
      expect(report.amountIdr, type).toBe(0);
    }
  });

  it("pph23 and the masukan side always resolve their roles (unmapped -> 422 even with no records)", async () => {
    const wht = await makeWorld({ omit: ["pph23_payable"] });
    await expectUnavailable(generate(wht, "pph23"));
    const vat = await makeWorld({ omit: ["ppn_input"] });
    await expectUnavailable(generate(vat, "ppn"));
  });
});

// ---- 2: ledger activity from other sources ------------------------------------

describe("legend-v4v7c review: ledger activity from another source", () => {
  it("ppn: a purchase return crediting ppn_input is refused, naming the source", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Retur", "01.234.567.8-905.123");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      ppn: 110_000,
    });
    await postEntry(world, {
      sourceType: "purchase_return",
      sourceId: createUlid(),
      lines: [
        [world.accounts.accounts_payable, 55_000, 0],
        [world.accounts.expense, 0, 50_000],
        [world.accounts.ppn_input, 0, 5_000],
      ],
    });
    await expectUnavailable(generate(world, "ppn"), "purchase_return");
  });

  it("pph23: a manual credit on pph23_payable is refused, naming the source", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("CV Manual", "02.345.678.9-012.456");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
    });
    await postEntry(world, {
      sourceType: "manual",
      sourceId: null,
      lines: [
        [world.accounts.expense, 5_000, 0],
        [world.accounts.pph23_payable, 0, 5_000],
      ],
    });
    await expectUnavailable(generate(world, "pph23"), "manual");
  });

  it("pph23: a remittance (setoran) debit from another source does not block the report", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("CV Setoran", "02.345.678.9-012.457");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
    });
    for (const sourceType of ["manual", "supplier_payment"])
      await postEntry(world, {
        sourceType,
        sourceId: sourceType === "manual" ? null : createUlid(),
        lines: [
          [world.accounts.pph23_payable, 7_000, 0],
          [world.accounts.cash_on_hand, 0, 7_000],
        ],
      });

    const report = await generate(world, "pph23");

    expect(report.amountIdr).toBe(20_000);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({
      baseIdr: 1_000_000,
      taxIdr: 20_000,
    });
  });

  it("pph23: a purchase return debit on pph23_payable reverses withholding and is refused, naming the source", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("CV Retur", "02.345.678.9-012.458");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
    });
    await postEntry(world, {
      sourceType: "purchase_return",
      sourceId: createUlid(),
      lines: [
        [world.accounts.pph23_payable, 4_000, 0],
        [world.accounts.accounts_payable, 0, 4_000],
      ],
    });
    await expectUnavailable(generate(world, "pph23"), "purchase_return");
  });

  it("ppn keluaran: a manual credit on tax_payable_ppn is refused, naming the source", async () => {
    const world = await makeWorld();
    await postEntry(world, {
      sourceType: "manual",
      sourceId: null,
      lines: [
        [world.accounts.cash_on_hand, 9_000, 0],
        [world.accounts.tax_payable_ppn, 0, 9_000],
      ],
    });
    await expectUnavailable(generate(world, "ppn"), "manual");
  });

  it("ppn keluaran: a remittance debit on tax_payable_ppn from another source does not block the report", async () => {
    const world = await makeWorld();
    for (const sourceType of ["manual", "supplier_payment"])
      await postEntry(world, {
        sourceType,
        sourceId: sourceType === "manual" ? null : createUlid(),
        lines: [
          [world.accounts.tax_payable_ppn, 6_000, 0],
          [world.accounts.cash_on_hand, 0, 6_000],
        ],
      });

    const report = await generate(world, "ppn");

    expect(report.lines).toEqual([]);
    expect(report.amountIdr).toBe(0);
  });

  it("ppn: any manual debit on ppn_input is still refused", async () => {
    const world = await makeWorld();
    await postEntry(world, {
      sourceType: "manual",
      sourceId: null,
      lines: [
        [world.accounts.ppn_input, 3_000, 0],
        [world.accounts.cash_on_hand, 0, 3_000],
      ],
    });
    await expectUnavailable(generate(world, "ppn"), "manual");
  });
});

// ---- 3: keluaran without snapshots --------------------------------------------

describe("legend-v4v7c review: keluaran ledger without snapshots", () => {
  it("sale credits on tax_payable_ppn with no PPN snapshot -> 422", async () => {
    const world = await makeWorld();
    await postEntry(world, {
      sourceType: "sale",
      sourceId: createUlid(),
      lines: [
        [world.accounts.cash_on_hand, 1_110_000, 0],
        [world.accounts.sales_revenue, 0, 1_000_000],
        [world.accounts.tax_payable_ppn, 0, 110_000],
      ],
    });
    await expectUnavailable(generate(world, "ppn"));
  });

  it("an unmapped tax_payable_ppn with nothing taxed is still an empty keluaran side", async () => {
    const world = await makeWorld({ omit: ["tax_payable_ppn"] });
    const report = await generate(world, "ppn");
    expect(report.lines).toEqual([]);
    expect(report.amountIdr).toBe(0);
  });
});

// ---- 4: reversed in the same period -------------------------------------------

describe("legend-v4v7c review: supplier invoice reversed in the same period", () => {
  it("nets out of both reports instead of blocking the period", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Batal", "03.456.789.0-123.789");
    const posted = await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      ppn: 110_000,
      pph23: 20_000,
    });
    await postEntry(world, {
      sourceType: "reversal",
      sourceId: null,
      reversalOf: posted.journalEntryId,
      lines: posted.lines.map(([account, debit, credit]): Posting => [
        account,
        credit,
        debit,
      ]),
    });

    const pph23 = await generate(world, "pph23");
    expect(pph23.lines).toEqual([]);
    expect(pph23.amountIdr).toBe(0);
    const ppn = await generate(world, "ppn");
    expect(ppn.lines).toEqual([]);
    expect(ppn.amountIdr).toBe(0);
  });

  it("a second, unreversed invoice is still reported", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Sebagian", "04.567.890.1-234.012");
    const voided = await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
    });
    await postEntry(world, {
      sourceType: "reversal",
      sourceId: null,
      reversalOf: voided.journalEntryId,
      lines: voided.lines.map(([account, debit, credit]): Posting => [
        account,
        credit,
        debit,
      ]),
    });
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 500_000,
      pph23: 10_000,
    });

    const report = await generate(world, "pph23");

    expect(report.amountIdr).toBe(10_000);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({ baseIdr: 500_000, taxIdr: 10_000 });
  });
});

// ---- 5: replay of the supplier invoice record ---------------------------------

describe("legend-v4v7c review: supplier invoice record replay", () => {
  it("the same command replays idempotently", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Ulang", "05.678.901.2-345.123");
    const record = recordInvoice(
      world,
      { supplierId: supplier, dpp: 1_000_000, pph23: 20_000 },
      await invoiceJournal(world),
    );
    await record.run();
    await expect(record.run()).resolves.toBeDefined();
  });

  it("a replay with other DPP / PPh 23 (same payable) is refused with 409, the stored row is kept", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Beda", "06.789.012.3-456.234");
    const key = `ap-${unique()}-${unique()}`;
    const id = randomUUID();
    const number = `INV-${unique()}`;
    const journalEntryId = await invoiceJournal(world);
    await recordInvoice(
      world,
      {
        supplierId: supplier,
        dpp: 1_000_000,
        pph23: 20_000,
        idempotencyKey: key,
        supplierInvoiceId: id,
        invoiceNumber: number,
      },
      journalEntryId,
    ).run();

    const error = await errorOf(
      recordInvoice(
        world,
        {
          supplierId: supplier,
          dpp: 1_001_000,
          pph23: 21_000,
          idempotencyKey: key,
          supplierInvoiceId: id,
          invoiceNumber: number,
        },
        journalEntryId,
      ).run(),
    );

    expect(error?.status).toBe(409);
    const { rows } = await owner.query<{ dpp_idr: string; pph23_idr: string }>(
      "SELECT dpp_idr, pph23_idr FROM supplier_invoices WHERE id = $1",
      [id],
    );
    expect(rows[0]).toMatchObject({ dpp_idr: "1000000", pph23_idr: "20000" });
  });
});
