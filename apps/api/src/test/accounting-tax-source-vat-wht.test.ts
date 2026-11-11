// PPh 23 and PPN tax report sources (bead legend-v4v7c, Slice D; PRD v1.7 §3.19
// "Pajak: PPh 23 (jasa supplier) dan PPN masukan bila badan usaha PKP";
// docs/briefs/538-g3-sub.md Slice D decisions 2 and 3). Written fail-first from
// the brief, not from the implementation. Runs generateTaxReport with the
// DEFAULT line source against the disposable PostgreSQL database; ledger,
// tax_snapshots and suppliers are seeded as the migration owner, supplier
// invoice records go through recordSupplierInvoicePayableInTransaction.
//
// Rules under test:
// - pph23: one line per supplier from the structured supplier invoice records
//   of the period (base = sum DPP, tax = sum PPh 23, masked NPWP), reconciled to
//   the pph23_payable ledger. Missing supplier NPWP, unmapped role or a ledger
//   that differs from the records -> 422 TAX_REPORT_SOURCE_UNAVAILABLE.
// - ppn: masukan lines per supplier (ppn_input ledger) and keluaran lines per
//   outlet (tax_snapshots type ppn, tax_payable_ppn ledger), each line carrying
//   direction "masukan" | "keluaran". Report amount = max(0, keluaran -
//   masukan). A refund position (lebih bayar) reports 0 plus a reference
//   "PPN lebih bayar Rp X", never a negative payment.
// - ppn for a non-PKP legal entity -> TAX_REPORT_NOT_APPLICABLE.
// - Tenant isolation.
//
// Assumptions (the brief does not pin these down):
// - Supplier invoice record input gains dppIdr/ppnIdr/pph23Idr; see
//   accounting-supplier-invoice-record.test.ts. The matching journal (source_type
//   'supplier_invoice', Dr expense + Dr ppn_input, Cr pph23_payable + Cr
//   accounts_payable) is seeded with a ULID source_id; supplierInvoiceId is
//   a separate random UUID (the validator rejects ulidToUuid output); the link is journal_entry_id.
// - A supplier with PPh 23 = 0 on all its invoices gets no pph23 line and does
//   not need an NPWP. A supplier with a PPN masukan line may lack an NPWP.
// - The "lebih bayar" note sits in the `references` of at least one report line;
//   the amount may be written 300000 or 300.000.
// - ppn keluaran lines: subjectType outlet, taxIdMasked null.
// - pph23 is allowed for a non-PKP legal entity (only ppn is PKP-gated).
// - A period without any records gives an empty report with amount 0.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createUlid,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { TaxReport } from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { recordSupplierInvoicePayableInTransaction } from "../services/accounting-ap.service";
import { generateTaxReport } from "../services/accounting-tax-reports.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const outletB = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const user = randomUUID();
const actor = userIdSchema.parse(user);
const createdSupplierIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdRuleIds: string[] = [];
const otherTenantIds: string[] = [];

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
    [user, "Tax source vat wht test", `${user}@example.com`],
  );
});

afterAll(async () => {
  // Best-effort: journals are append-only and stay; everything else created
  // here is removed so later suites on the shared tenant are unaffected.
  const quietly = (sql: string, params: unknown[]) =>
    owner.query(sql, params).catch(() => undefined);
  await quietly(
    "DELETE FROM tax_snapshots WHERE tenant_id = $1 AND tax_rule_id = ANY($2::uuid[])",
    [tenantId, createdRuleIds],
  );
  await quietly(
    "DELETE FROM tax_rules WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, createdRuleIds],
  );
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
  for (const table of [
    "supplier_invoices",
    "accounting_open_items",
    "suppliers",
    "fiscal_periods",
    "legal_entities",
  ])
    if (otherTenantIds.length > 0)
      await quietly(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
        otherTenantIds,
      ]);
  if (otherTenantIds.length > 0)
    await quietly("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
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
  tenant: string;
  outlet: string | null;
  entity: string;
  accounts: Record<Role | "expense", string>;
  nov: string;
  oct: string;
  ruleId: string | null;
};

async function makeWorld(
  options: {
    isPkp?: boolean;
    omit?: Role[];
    tenant?: string;
    outlet?: string | null;
  } = {},
): Promise<World> {
  const tenant = options.tenant ?? tenantId;
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, $4)",
    [entity, tenant, `Tax vat wht ${unique()}`, options.isPkp ?? true],
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
      tenant,
      entity,
    ],
  );
  const omit = new Set(options.omit ?? []);
  for (const role of Object.keys(accounts) as (Role | "expense")[]) {
    if (role === "expense" || omit.has(role as Role)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenant, entity, role, accounts[role]],
    );
  }
  const periods = await owner.query<{ id: string; period: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-10'), ($1, $2, '2026-11') RETURNING id, period`,
    [tenant, entity],
  );
  const periodId = (period: string) =>
    periods.rows.find((row) => row.period === period)!.id;
  return {
    tenant,
    outlet: options.outlet === undefined ? outletA : options.outlet,
    entity,
    accounts,
    nov: periodId("2026-11"),
    oct: periodId("2026-10"),
    ruleId: null,
  };
}

async function makeSupplier(
  name: string,
  npwp: string | null,
  tenant: string = tenantId,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by, npwp)
     VALUES ($1, $2, $3, 30, $4, $5)`,
    [id, tenant, `${name} ${unique()}`, user, npwp],
  );
  if (tenant === tenantId) createdSupplierIds.push(id);
  return id;
}

type Posting = [account: string, debitIdr: number, creditIdr: number];

/** One balanced journal entry in its own transaction. */
async function postEntry(
  world: World,
  input: {
    period: string;
    entryDate: string;
    sourceType: "sale" | "supplier_invoice" | "manual";
    sourceId: string | null;
    lines: Posting[];
  },
): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Tax vat wht test', $8, $9)
       RETURNING id`,
      [
        world.tenant,
        world.entity,
        world.outlet,
        input.entryDate,
        input.period,
        input.sourceType,
        input.sourceId,
        `tvw-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const [account, debit, credit] of input.lines)
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [world.tenant, entryId, account, world.outlet, lineNo++, debit, credit],
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
  number?: string;
  date?: string;
  dpp: number;
  ppn?: number;
  pph23?: number;
  /** Override what the LEDGER holds when it must differ from the record. */
  ledgerPpn?: number;
  ledgerPph23?: number;
};

/** Supplier invoice: ledger journal plus the structured record (same amounts). */
async function postSupplierInvoice(world: World, seed: InvoiceSeed) {
  const ppn = seed.ppn ?? 0;
  const pph23 = seed.pph23 ?? 0;
  const ledgerPpn = seed.ledgerPpn ?? ppn;
  const ledgerPph23 = seed.ledgerPph23 ?? pph23;
  const date = seed.date ?? "2026-11-05";
  const period = date.startsWith("2026-10") ? world.oct : world.nov;
  const sourceId = createUlid();
  const payable = seed.dpp + ledgerPpn - ledgerPph23;
  const lines: Posting[] = [[world.accounts.expense, seed.dpp, 0]];
  if (ledgerPpn > 0) lines.push([world.accounts.ppn_input, ledgerPpn, 0]);
  if (ledgerPph23 > 0)
    lines.push([world.accounts.pph23_payable, 0, ledgerPph23]);
  lines.push([world.accounts.accounts_payable, 0, payable]);
  const journalEntryId = await postEntry(world, {
    period,
    entryDate: date,
    sourceType: "supplier_invoice",
    sourceId,
    lines,
  });
  const supplierInvoiceId = randomUUID();
  createdInvoiceIds.push(supplierInvoiceId);
  const context = scope(world.tenant);
  const invoiceNumber = seed.number ?? `INV-${unique()}`;
  await withTenant(db, context, (tx) =>
    recordSupplierInvoicePayableInTransaction(
      tx,
      context,
      {
        supplierInvoiceId,
        legalEntityId: world.entity,
        outletId: world.outlet,
        supplierId: seed.supplierId,
        supplierName: "Pemasok Uji",
        invoiceNumber,
        invoiceDate: date,
        dueOn: "2026-12-31",
        dppIdr: seed.dpp,
        ppnIdr: ppn,
        pph23Idr: pph23,
        payableIdr: seed.dpp + ppn - pph23,
        journalEntryId,
        idempotencyKey: `ap-${unique()}-${unique()}`,
      } as never,
      actor,
    ),
  );
  return { invoiceNumber, journalEntryId };
}

async function ppnRule(world: World): Promise<string> {
  if (world.ruleId) return world.ruleId;
  const ruleId = randomUUID();
  createdRuleIds.push(ruleId);
  await owner.query(
    `INSERT INTO tax_rules
       (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
        price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
        published_at, published_by)
     VALUES ($1, $2, NULL, $3, 'PPN uji', 'ppn', 1100, NULL, '[]',
             '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
             false, true, true, 1, '2026-01-01', 'published', now(), $4)`,
    [ruleId, world.tenant, `PPN-VW-${unique()}`.toUpperCase(), user],
  );
  world.ruleId = ruleId;
  return ruleId;
}

/** A November sale with PPN keluaran: snapshot plus ledger credit (kept equal unless told). */
async function postPpnSale(
  world: World,
  amounts: { base: number; tax: number; ledgerTax?: number },
  outlet: string = outletA,
) {
  const orderId = createUlid();
  const ruleId = await ppnRule(world);
  await owner.query(
    `INSERT INTO tax_snapshots
       (id, tenant_id, outlet_id, source_type, source_id, business_date, tax_rule_id, tax_rule_code,
        tax_rule_version, tax_type, rate_bp, price_includes_tax, gross_idr, tax_base_idr,
        service_charge_idr, tax_idr)
     VALUES ($1, $2, $3, 'order', $4, '2026-11-06', $5, 'PPN-VW', 1, 'ppn', 1100, false, $6, $7, 0, $8)`,
    [
      randomUUID(),
      world.tenant,
      outlet,
      ulidToUuid(orderId),
      ruleId,
      amounts.base + amounts.tax,
      amounts.base,
      amounts.tax,
    ],
  );
  const ledgerTax = amounts.ledgerTax ?? amounts.tax;
  const savedOutlet = world.outlet;
  world.outlet = outlet;
  try {
    await postEntry(world, {
      period: world.nov,
      entryDate: "2026-11-06",
      sourceType: "sale",
      sourceId: orderId,
      lines: [
        [world.accounts.cash_on_hand, amounts.base + ledgerTax, 0],
        [world.accounts.sales_revenue, 0, amounts.base],
        [world.accounts.tax_payable_ppn, 0, ledgerTax],
      ],
    });
  } finally {
    world.outlet = savedOutlet;
  }
}

type AnyLine = TaxReport["lines"][number] & { direction?: string };

const generate = (
  world: World,
  type: "pph23" | "ppn",
  period = "2026-11",
  tenant: string = tenantId,
) =>
  generateTaxReport(scope(tenant), actor, {
    legalEntityId: world.entity,
    type,
    period,
  } as never);

async function errorOf(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (error) {
    return error as { code?: string; status?: number };
  }
}

async function expectUnavailable(run: Promise<unknown>) {
  const error = await errorOf(run);
  expect(error?.code, String(error)).toBe("TAX_REPORT_SOURCE_UNAVAILABLE");
  expect(error?.status).toBe(422);
}

const linesOf = (report: TaxReport) => report.lines as AnyLine[];
const references = (report: TaxReport) =>
  report.lines.flatMap((line) => line.references);

// ---- PPh 23 -------------------------------------------------------------------

describe("legend-v4v7c PPh 23 source", () => {
  it("builds one line per supplier from the invoice records, with base, tax, masked NPWP and invoice references", async () => {
    const world = await makeWorld();
    const kopi = await makeSupplier("CV Kopi Jasa", "01.234.567.8-905.123");
    const susu = await makeSupplier("PT Susu Jasa", "02.345.678.9-012.456");
    const goods = await makeSupplier("Toko Barang", null);
    const a1 = await postSupplierInvoice(world, {
      supplierId: kopi,
      dpp: 1_000_000,
      ppn: 110_000,
      pph23: 20_000,
    });
    const a2 = await postSupplierInvoice(world, {
      supplierId: kopi,
      dpp: 500_000,
      pph23: 10_000,
    });
    await postSupplierInvoice(world, {
      supplierId: susu,
      dpp: 2_000_000,
      pph23: 40_000,
    });
    // Goods only: no PPh 23, so no line and no NPWP needed.
    await postSupplierInvoice(world, {
      supplierId: goods,
      dpp: 700_000,
      ppn: 77_000,
    });

    const report = await generate(world, "pph23");

    expect(report.type).toBe("pph23");
    expect(report.lines).toHaveLength(2);
    expect(report.amountIdr).toBe(70_000);
    const line = report.lines.find((l) => l.subjectId === kopi)!;
    expect(line).toMatchObject({
      subjectType: "supplier",
      baseIdr: 1_500_000,
      taxIdr: 30_000,
    });
    expect(line.subjectName).toContain("CV Kopi Jasa");
    expect(line.taxIdMasked).toContain("5123");
    expect(line.taxIdMasked).not.toContain("01.234.567");
    expect(line.references).toEqual(
      expect.arrayContaining([a1.invoiceNumber, a2.invoiceNumber]),
    );
    expect(report.lines.find((l) => l.subjectId === susu)).toMatchObject({
      baseIdr: 2_000_000,
      taxIdr: 40_000,
    });
    expect(report.lines.some((l) => l.subjectId === goods)).toBe(false);
  });

  it("counts only invoices dated in the report period", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("CV Jasa Okt", "03.456.789.0-123.789");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      date: "2026-10-20",
      dpp: 900_000,
      pph23: 18_000,
    });
    await postSupplierInvoice(world, {
      supplierId: supplier,
      date: "2026-11-02",
      dpp: 400_000,
      pph23: 8_000,
    });

    const report = await generate(world, "pph23");

    expect(report.amountIdr).toBe(8_000);
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({ baseIdr: 400_000, taxIdr: 8_000 });
  });

  it("gives an empty report with amount 0 when no invoice withheld PPh 23", async () => {
    const world = await makeWorld();
    const report = await generate(world, "pph23");
    expect(report.lines).toEqual([]);
    expect(report.amountIdr).toBe(0);
  });

  it("refuses the report (422 TAX_REPORT_SOURCE_UNAVAILABLE) when a withheld supplier has no NPWP", async () => {
    const world = await makeWorld();
    const noNpwp = await makeSupplier("CV Tanpa NPWP", null);
    await postSupplierInvoice(world, {
      supplierId: noNpwp,
      dpp: 1_000_000,
      pph23: 20_000,
    });

    await expectUnavailable(generate(world, "pph23"));
  });

  it("refuses the report when the pph23_payable ledger differs from the invoice records", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("CV Selisih", "04.567.890.1-234.012");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
      ledgerPph23: 15_000,
    });

    await expectUnavailable(generate(world, "pph23"));
  });

  it("refuses the report when the pph23_payable role is not mapped", async () => {
    const world = await makeWorld({ omit: ["pph23_payable"] });
    const supplier = await makeSupplier(
      "CV Tanpa Akun",
      "05.678.901.2-345.123",
    );
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
    });

    await expectUnavailable(generate(world, "pph23"));
  });

  it("still reports PPh 23 for a non-PKP legal entity (only PPN is PKP-gated)", async () => {
    const world = await makeWorld({ isPkp: false });
    const supplier = await makeSupplier("CV Non PKP", "06.789.012.3-456.234");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      pph23: 20_000,
    });

    const report = await generate(world, "pph23");

    expect(report.amountIdr).toBe(20_000);
  });

  it("never mixes in another tenant's suppliers and hides a foreign legal entity (404)", async () => {
    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Tax vat wht other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `tvw-${unique()}`, tenantId],
    );
    const foreign = await makeWorld({ tenant: otherTenant, outlet: null });
    const foreignSupplier = await makeSupplier(
      "PT Tenant Lain",
      "07.890.123.4-567.345",
      otherTenant,
    );
    await postSupplierInvoice(foreign, {
      supplierId: foreignSupplier,
      dpp: 9_000_000,
      pph23: 180_000,
    });
    const world = await makeWorld();
    const own = await makeSupplier("CV Milik Sendiri", "08.901.234.5-678.456");
    await postSupplierInvoice(world, {
      supplierId: own,
      dpp: 1_000_000,
      pph23: 20_000,
    });

    const report = await generate(world, "pph23");

    expect(report.amountIdr).toBe(20_000);
    expect(report.lines.map((l) => l.subjectId)).toEqual([own]);
    // Tenant A cannot generate for tenant B's legal entity.
    const error = await errorOf(generate(foreign, "pph23"));
    expect(error?.status).toBe(404);
  });
});

// ---- PPN ----------------------------------------------------------------------

describe("legend-v4v7c PPN source (masukan and keluaran)", () => {
  it("lists masukan per supplier and keluaran per outlet with direction; amount is the net kurang bayar", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Bahan", "09.012.345.6-789.567");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      ppn: 110_000,
    });
    await postPpnSale(world, { base: 2_000_000, tax: 220_000 }, outletA);
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 }, outletB);

    const report = await generate(world, "ppn");

    const masukan = linesOf(report).filter((l) => l.direction === "masukan");
    const keluaran = linesOf(report).filter((l) => l.direction === "keluaran");
    expect(masukan).toHaveLength(1);
    expect(masukan[0]).toMatchObject({
      subjectType: "supplier",
      subjectId: supplier,
      baseIdr: 1_000_000,
      taxIdr: 110_000,
    });
    expect(
      keluaran
        .map((l) => [l.subjectType, l.outletId, l.baseIdr, l.taxIdr])
        .sort(),
    ).toEqual(
      [
        ["outlet", outletA, 2_000_000, 220_000],
        ["outlet", outletB, 1_000_000, 110_000],
      ].sort(),
    );
    // keluaran 330.000 - masukan 110.000
    expect(report.amountIdr).toBe(220_000);
    for (const line of report.lines)
      expect(line.taxIdr).toBeGreaterThanOrEqual(0);
  });

  it("sums several masukan suppliers against keluaran (largest-case net)", async () => {
    const world = await makeWorld();
    const a = await makeSupplier("PT Satu", "10.123.456.7-890.678");
    const b = await makeSupplier("PT Dua", null);
    await postSupplierInvoice(world, {
      supplierId: a,
      dpp: 1_000_000,
      ppn: 110_000,
    });
    await postSupplierInvoice(world, {
      supplierId: b,
      dpp: 3_000_000,
      ppn: 330_000,
    });
    await postPpnSale(world, { base: 5_000_000, tax: 550_000 });

    const report = await generate(world, "ppn");

    expect(
      linesOf(report).filter((l) => l.direction === "masukan"),
    ).toHaveLength(2);
    expect(report.amountIdr).toBe(550_000 - 440_000);
  });

  it("reports only keluaran when there are no purchases", async () => {
    const world = await makeWorld();
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 });

    const report = await generate(world, "ppn");

    expect(report.amountIdr).toBe(110_000);
    expect(linesOf(report).every((l) => l.direction === "keluaran")).toBe(true);
  });

  it("lebih bayar: masukan above keluaran reports 0 with a 'PPN lebih bayar' reference, never a negative", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Besar", "11.234.567.8-901.789");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 5_000_000,
      ppn: 550_000,
    });
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 });

    const report = await generate(world, "ppn");

    // keluaran 110.000 - masukan 550.000 = -440.000 -> lebih bayar Rp 440.000
    expect(report.amountIdr).toBe(0);
    for (const line of report.lines)
      expect(line.taxIdr).toBeGreaterThanOrEqual(0);
    expect(references(report).join(" | ")).toMatch(
      /PPN lebih bayar Rp\s?440\.?000/i,
    );
  });

  it("lebih bayar with masukan only (no sales in the period)", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Awal", "12.345.678.9-012.890");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      ppn: 110_000,
    });

    const report = await generate(world, "ppn");

    expect(report.amountIdr).toBe(0);
    expect(references(report).join(" | ")).toMatch(
      /PPN lebih bayar Rp\s?110\.?000/i,
    );
  });

  it("does not note a lebih bayar when the position is kurang bayar", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Kecil", "13.456.789.0-123.901");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 100_000,
      ppn: 11_000,
    });
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 });

    const report = await generate(world, "ppn");

    expect(report.amountIdr).toBe(99_000);
    expect(references(report).join(" | ")).not.toMatch(/lebih bayar/i);
  });

  it("an empty period gives an empty PPN report with amount 0", async () => {
    const world = await makeWorld();
    const report = await generate(world, "ppn");
    expect(report.lines).toEqual([]);
    expect(report.amountIdr).toBe(0);
  });

  it("counts only the report period", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier("PT Lampau", "14.567.890.1-234.012");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      date: "2026-10-12",
      dpp: 9_000_000,
      ppn: 990_000,
    });
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 });

    const report = await generate(world, "ppn");

    expect(report.amountIdr).toBe(110_000);
    expect(linesOf(report).filter((l) => l.direction === "masukan")).toEqual(
      [],
    );
  });

  it("refuses the report when the ppn_input ledger differs from the invoice records", async () => {
    const world = await makeWorld();
    const supplier = await makeSupplier(
      "PT Selisih Masukan",
      "15.678.901.2-345.123",
    );
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      ppn: 110_000,
      ledgerPpn: 100_000,
    });

    await expectUnavailable(generate(world, "ppn"));
  });

  it("refuses the report when the tax_payable_ppn ledger differs from the tax snapshots", async () => {
    const world = await makeWorld();
    await postPpnSale(world, {
      base: 1_000_000,
      tax: 110_000,
      ledgerTax: 100_000,
    });

    await expectUnavailable(generate(world, "ppn"));
  });

  it("refuses the report when the tax_payable_ppn role is not mapped but sales carry PPN", async () => {
    const world = await makeWorld({ omit: ["tax_payable_ppn"] });
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 });

    await expectUnavailable(generate(world, "ppn"));
  });

  it("is not applicable (TAX_REPORT_NOT_APPLICABLE) for a legal entity that is not PKP", async () => {
    const world = await makeWorld({ isPkp: false });
    const supplier = await makeSupplier("PT Non PKP", "16.789.012.3-456.234");
    await postSupplierInvoice(world, {
      supplierId: supplier,
      dpp: 1_000_000,
      ppn: 110_000,
    });

    const error = await errorOf(generate(world, "ppn"));

    expect(error?.code).toBe("TAX_REPORT_NOT_APPLICABLE");
  });

  it("keeps tenants apart: another tenant's purchases never reduce this tenant's PPN", async () => {
    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Tax vat wht other tenant 2', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `tvw-${unique()}`, tenantId],
    );
    const foreign = await makeWorld({ tenant: otherTenant, outlet: null });
    const foreignSupplier = await makeSupplier(
      "PT Tenant Lain",
      "17.890.123.4-567.345",
      otherTenant,
    );
    await postSupplierInvoice(foreign, {
      supplierId: foreignSupplier,
      dpp: 50_000_000,
      ppn: 5_500_000,
    });
    const world = await makeWorld();
    await postPpnSale(world, { base: 1_000_000, tax: 110_000 });

    const report = await generate(world, "ppn");

    expect(report.amountIdr).toBe(110_000);
    expect(linesOf(report).filter((l) => l.direction === "masukan")).toEqual(
      [],
    );
  });
});
