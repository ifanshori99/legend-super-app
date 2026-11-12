// Structured supplier invoice record (bead legend-v4v7c, Slice D; PRD v1.7
// §3.19 "Pajak": PPh 23 jasa supplier and PPN masukan need DPP, PPN and PPh 23
// per supplier invoice; docs/briefs/538-g3-sub.md "Slice D decisions" 2).
// Written fail-first from the brief, not from the implementation.
//
// Contract under test:
// - suppliers has a nullable `npwp` column (max 20 characters).
// - recordSupplierInvoicePayableInTransaction writes one `supplier_invoices`
//   row (id = supplierInvoiceId) with dpp_idr, ppn_idr, pph23_idr, payable_idr,
//   invoice_number, invoice_date, journal_entry_id and npwp_snapshot, in the
//   SAME transaction as the open item: both exist or neither.
// - RLS isolates supplier_invoices by tenant.
//
// Assumptions (the brief does not pin these down):
// - The record input gains `dppIdr`, `ppnIdr`, `pph23Idr` next to the existing
//   `payableIdr`. Money must add up: payable = dpp + ppn - pph23, otherwise the
//   call is refused (no guessed amounts) and nothing is written.
// - Column names follow the brief design: id, tenant_id, legal_entity_id,
//   supplier_id, invoice_number, invoice_date, dpp_idr, ppn_idr, pph23_idr,
//   payable_idr, journal_entry_id, npwp_snapshot.
// - npwp_snapshot is copied from suppliers.npwp when the invoice is recorded
//   and does not follow later NPWP edits; null when the supplier has no NPWP.
// - A second invoice with the same supplier and invoice_number (different
//   supplierInvoiceId) is refused (unique tenant + supplier + number).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  userIdSchema,
  type ScopedTenantContext,
  type TenantId,
  type UserId,
} from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { supplierSchema } from "@starter/shared/inventory";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  recordSupplierInvoicePayableInTransaction,
  repairSupplierInvoiceNpwpInTransaction,
} from "../services/accounting-ap.service";
import * as schema from "../db/schema";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const key = (prefix: string) => `${prefix}-${unique()}-${unique()}`;
const creator = randomUUID();
const actor: UserId = userIdSchema.parse(creator);
const createdSupplierIds: string[] = [];
const createdInvoiceIds: string[] = [];
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
    [creator, "Supplier invoice record test", `${creator}@example.com`],
  );
});

afterAll(async () => {
  // Best-effort cleanup: journals are append-only, everything else we created
  // is removed so later suites on the shared tenant see no stray suppliers.
  const quietly = (sql: string, params: unknown[]) =>
    owner.query(sql, params).catch(() => undefined);
  await quietly(
    "DELETE FROM supplier_invoices WHERE tenant_id = $1 AND supplier_id = ANY($2::uuid[])",
    [tenantId, createdSupplierIds],
  );
  await quietly(
    "DELETE FROM accounting_open_items WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
    [tenantId, createdInvoiceIds],
  );
  await quietly("DELETE FROM suppliers WHERE id = ANY($1::uuid[])", [
    createdSupplierIds,
  ]);
  if (otherTenantIds.length > 0) {
    for (const table of [
      "supplier_invoices",
      "accounting_open_items",
      "suppliers",
      "legal_entities",
    ])
      await quietly(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
        otherTenantIds,
      ]);
    await quietly("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  await quietly('DELETE FROM "user" WHERE id = $1', [creator]);
  await owner.end();
});

async function createEntity(tenant: string = tenantId): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenant, `Supplier invoice ${unique()}`],
  );
  return rows[0]!.id;
}

async function createSupplier(
  npwp: string | null,
  tenant: string = tenantId,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by, npwp)
     VALUES ($1, $2, $3, 30, $4, $5)`,
    [id, tenant, `Pemasok ${unique()}`, creator, npwp],
  );
  if (tenant === tenantId) createdSupplierIds.push(id);
  return id;
}

/** One balanced supplier invoice journal of the entity (the entry a caller links). */
async function createJournal(
  entity: string,
  sourceType: string = "supplier_invoice",
  tenant: string = tenantId,
): Promise<string> {
  const { rows: period } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11')
     ON CONFLICT (tenant_id, legal_entity_id, period) DO UPDATE SET period = excluded.period
     RETURNING id`,
    [tenant, entity],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6201', 'Beban', 'expense', 'operating_expense'),
            ($1, $2, '2101', 'Utang Usaha', 'liability', 'current_liability')
     ON CONFLICT DO NOTHING`,
    [tenant, entity],
  );
  const { rows: accounts } = await owner.query<{ id: string; code: string }>(
    "SELECT id, code FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code IN ('6201', '2101')",
    [tenant, entity],
  );
  const expense = accounts.find((a) => a.code === "6201")!.id;
  const payable = accounts.find((a) => a.code === "2101")!.id;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, outlet_id, entry_date, fiscal_period_id, source_type,
          source_id, description, idempotency_key, request_fingerprint)
       VALUES ($1, $2, NULL, '2026-11-05', $3, $4, $5, 'Supplier invoice record test', $6, $7)
       RETURNING id`,
      [
        tenant,
        entity,
        period[0]!.id,
        sourceType,
        sourceType === "manual" ? null : randomUUID(),
        `sir-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, outlet_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, NULL, 1, 1, 0), ($1, $2, $4, NULL, 2, 0, 1)`,
      [tenant, entryId, expense, payable],
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

type InvoiceInput = {
  supplierInvoiceId?: string;
  legalEntityId: string;
  supplierId: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dppIdr?: number;
  ppnIdr?: number;
  pph23Idr?: number;
  payableIdr?: number;
  /** Default: a fresh supplier invoice journal of the entity, made on run. */
  journalEntryId?: string | null;
  journalSource?: string;
  idempotencyKey?: string;
};

/** Input for the record call: DPP 1.000.000 + PPN 110.000 - PPh 23 20.000. */
function input(r: InvoiceInput, outletId: string | null = outletA) {
  const dppIdr = r.dppIdr ?? 1_000_000;
  const ppnIdr = r.ppnIdr ?? 110_000;
  const pph23Idr = r.pph23Idr ?? 20_000;
  const supplierInvoiceId = r.supplierInvoiceId ?? randomUUID();
  createdInvoiceIds.push(supplierInvoiceId);
  return {
    supplierInvoiceId,
    legalEntityId: r.legalEntityId,
    outletId,
    supplierId: r.supplierId,
    supplierName: "Pemasok Uji",
    invoiceNumber: r.invoiceNumber ?? `INV-${unique()}`,
    invoiceDate: r.invoiceDate ?? "2026-11-05",
    dueOn: "2026-12-05",
    dppIdr,
    ppnIdr,
    pph23Idr,
    payableIdr: r.payableIdr ?? dppIdr + ppnIdr - pph23Idr,
    journalEntryId: r.journalEntryId ?? null,
    idempotencyKey: r.idempotencyKey ?? key("ap"),
  };
}

const record = (r: InvoiceInput, tenant: string = tenantId) => {
  const context = scope(tenant);
  const body = input(r, tenant === tenantId ? outletA : null);
  return {
    body,
    run: async () => {
      if (r.journalEntryId === undefined)
        body.journalEntryId = await createJournal(
          r.legalEntityId,
          r.journalSource,
          tenant,
        );
      return withTenant(db, context, (tx) =>
        recordSupplierInvoicePayableInTransaction(
          tx,
          context,
          body as never,
          actor,
        ),
      );
    },
  };
};

const invoiceRows = (id: string) =>
  owner.query<{
    id: string;
    tenant_id: string;
    legal_entity_id: string;
    supplier_id: string;
    invoice_number: string;
    invoice_date: Date | string;
    dpp_idr: string | number;
    ppn_idr: string | number;
    pph23_idr: string | number;
    payable_idr: string | number;
    npwp_snapshot: string | null;
  }>("SELECT * FROM supplier_invoices WHERE tenant_id = $1 AND id = $2", [
    tenantId,
    id,
  ]);

const openItemRows = (id: string) =>
  owner.query<{ original_idr: string | number }>(
    "SELECT original_idr FROM accounting_open_items WHERE tenant_id = $1 AND id = $2",
    [tenantId, id],
  );

describe("legend-v4v7c suppliers.npwp", () => {
  it("stores an NPWP on a supplier and leaves it empty by default", async () => {
    const withNpwp = await createSupplier("01.234.567.8-901.000");
    const without = await createSupplier(null);
    const { rows } = await owner.query<{ id: string; npwp: string | null }>(
      "SELECT id, npwp FROM suppliers WHERE id = ANY($1::uuid[])",
      [[withNpwp, without]],
    );
    expect(rows.find((r) => r.id === withNpwp)?.npwp).toBe(
      "01.234.567.8-901.000",
    );
    expect(rows.find((r) => r.id === without)?.npwp).toBeNull();
  });

  it("refuses an NPWP longer than 20 characters", async () => {
    await expect(createSupplier("1".repeat(21))).rejects.toThrow();
  });

  it("exposes npwp on the shared supplier contract", () => {
    expect(Object.keys(supplierSchema.shape)).toContain("npwp");
  });
});

describe("legend-v4v7c supplier invoice record", () => {
  it("writes the structured row with DPP, PPN, PPh 23 and the NPWP snapshot next to the open item", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("01.234.567.8-901.000");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      invoiceNumber: "INV-STRUCT-1",
      invoiceDate: "2026-11-05",
    });

    await run();

    const { rows } = await invoiceRows(body.supplierInvoiceId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.legal_entity_id).toBe(entity);
    expect(row.supplier_id).toBe(supplier);
    expect(row.invoice_number).toBe("INV-STRUCT-1");
    expect(Number(row.dpp_idr)).toBe(1_000_000);
    expect(Number(row.ppn_idr)).toBe(110_000);
    expect(Number(row.pph23_idr)).toBe(20_000);
    expect(Number(row.payable_idr)).toBe(1_090_000);
    expect(row.npwp_snapshot).toBe("01.234.567.8-901.000");
    // The open item carries the payable (total minus PPh 23).
    const open = await openItemRows(body.supplierInvoiceId);
    expect(open.rows.map((r) => Number(r.original_idr))).toEqual([1_090_000]);
  });

  it("keeps a zero PPh 23 and a missing NPWP (null snapshot) for a goods invoice", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier(null);
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      dppIdr: 500_000,
      ppnIdr: 55_000,
      pph23Idr: 0,
    });

    await run();

    const { rows } = await invoiceRows(body.supplierInvoiceId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.pph23_idr)).toBe(0);
    expect(Number(rows[0]!.payable_idr)).toBe(555_000);
    expect(rows[0]!.npwp_snapshot).toBeNull();
  });

  it.each([null, "", "   "])(
    "547b refuses PPh 23 posting without supplier NPWP (%s), leaving no payable",
    async (npwp) => {
      const entity = await createEntity();
      const supplier = await createSupplier(npwp);
      const { body, run } = record({
        legalEntityId: entity,
        supplierId: supplier,
      });

      await expect(run()).rejects.toMatchObject({
        status: 422,
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("NPWP"),
      });
      expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
      expect((await openItemRows(body.supplierInvoiceId)).rows).toHaveLength(0);
    },
  );

  it("snapshots the NPWP at record time; a later supplier edit does not rewrite the invoice", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("11.111.111.1-111.000");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
    });
    await run();

    await owner.query("UPDATE suppliers SET npwp = $2 WHERE id = $1", [
      supplier,
      "99.999.999.9-999.000",
    ]);

    const { rows } = await invoiceRows(body.supplierInvoiceId);
    expect(rows[0]!.npwp_snapshot).toBe("11.111.111.1-111.000");
  });

  it("547b replays a valid immutable PPh 23 snapshot even after supplier NPWP is cleared", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("11.111.111.1-111.000");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: await createJournal(entity),
    });
    await run();
    await owner.query("UPDATE suppliers SET npwp = NULL WHERE id = $1", [
      supplier,
    ]);

    await expect(run()).resolves.toMatchObject({ id: body.supplierInvoiceId });
    expect(
      (await invoiceRows(body.supplierInvoiceId)).rows[0]!.npwp_snapshot,
    ).toBe("11.111.111.1-111.000");
    expect((await openItemRows(body.supplierInvoiceId)).rows).toHaveLength(1);
  });

  it("writes the row and the open item in one transaction: a rollback leaves neither", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("22.222.222.2-222.000");
    const context = scope();
    const body = input({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: await createJournal(entity),
    });

    await expect(
      withTenant(db, context, async (tx) => {
        await recordSupplierInvoicePayableInTransaction(
          tx,
          context,
          body as never,
          actor,
        );
        throw new Error("rollback after record");
      }),
    ).rejects.toThrow("rollback after record");

    expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
    expect((await openItemRows(body.supplierInvoiceId)).rows).toHaveLength(0);
  });

  it("refuses a second invoice with the same number for the same supplier and writes nothing for it", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("33.333.333.3-333.000");
    const first = record({
      legalEntityId: entity,
      supplierId: supplier,
      invoiceNumber: "INV-DUP",
    });
    await first.run();
    const second = record({
      legalEntityId: entity,
      supplierId: supplier,
      invoiceNumber: "INV-DUP",
    });

    await expect(second.run()).rejects.toBeTruthy();

    expect(
      (await invoiceRows(second.body.supplierInvoiceId)).rows,
    ).toHaveLength(0);
    expect(
      (await openItemRows(second.body.supplierInvoiceId)).rows,
    ).toHaveLength(0);
    expect((await invoiceRows(first.body.supplierInvoiceId)).rows).toHaveLength(
      1,
    );
  });

  it("allows the same invoice number for different suppliers", async () => {
    const entity = await createEntity();
    const a = await createSupplier("44.444.444.4-444.000");
    const b = await createSupplier("55.555.555.5-555.000");
    const first = record({
      legalEntityId: entity,
      supplierId: a,
      invoiceNumber: "INV-SHARED",
    });
    const second = record({
      legalEntityId: entity,
      supplierId: b,
      invoiceNumber: "INV-SHARED",
    });
    await first.run();
    await second.run();
    expect((await invoiceRows(first.body.supplierInvoiceId)).rows).toHaveLength(
      1,
    );
    expect(
      (await invoiceRows(second.body.supplierInvoiceId)).rows,
    ).toHaveLength(1);
  });

  it("refuses amounts that do not add up (payable != DPP + PPN - PPh 23) and writes nothing", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("66.666.666.6-666.000");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      payableIdr: 1_200_000, // should be 1_090_000
    });

    await expect(run()).rejects.toBeTruthy();

    expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
    expect((await openItemRows(body.supplierInvoiceId)).rows).toHaveLength(0);
  });

  it("refuses tax parts without a journal entry and writes nothing", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("90.000.000.0-000.001");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: null,
    });

    const error = await run().catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 422 });
    expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
    expect((await openItemRows(body.supplierInvoiceId)).rows).toHaveLength(0);
  });

  it("refuses a journal entry that does not exist", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("90.000.000.0-000.002");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: randomUUID(),
    });

    await expect(run()).rejects.toMatchObject({ status: 422 });

    expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
  });

  it("refuses a journal entry of another legal entity of the tenant", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("90.000.000.0-000.003");
    const foreign = await createJournal(await createEntity());
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: foreign,
    });

    await expect(run()).rejects.toMatchObject({ status: 422 });

    expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
  });

  it("refuses a journal entry that is not a supplier invoice journal and writes nothing", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("90.000.000.0-000.004");
    const { body, run } = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalSource: "manual",
    });

    await expect(run()).rejects.toMatchObject({ status: 422 });

    expect((await invoiceRows(body.supplierInvoiceId)).rows).toHaveLength(0);
    expect((await openItemRows(body.supplierInvoiceId)).rows).toHaveLength(0);
  });

  it("a replay with the same command is idempotent; one with another journal entry is refused with 409", async () => {
    const entity = await createEntity();
    const supplier = await createSupplier("90.000.000.0-000.005");
    const journal = await createJournal(entity);
    const first = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: journal,
    });
    await first.run();
    await expect(first.run()).resolves.toBeDefined();

    const other = await createJournal(entity);
    const replay = record({
      legalEntityId: entity,
      supplierId: supplier,
      journalEntryId: other,
      supplierInvoiceId: first.body.supplierInvoiceId,
      invoiceNumber: first.body.invoiceNumber,
      idempotencyKey: first.body.idempotencyKey,
    });

    await expect(replay.run()).rejects.toMatchObject({ status: 409 });
    const { rows } = await owner.query<{ journal_entry_id: string }>(
      "SELECT journal_entry_id FROM supplier_invoices WHERE tenant_id = $1 AND id = $2",
      [tenantId, first.body.supplierInvoiceId],
    );
    expect(rows[0]!.journal_entry_id).toBe(journal);
  });

  it("hides another tenant's supplier invoices (RLS)", async () => {
    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Supplier invoice other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `sir-${unique()}`, tenantId],
    );
    const otherEntity = await createEntity(otherTenant);
    const otherSupplier = await createSupplier(
      "77.777.777.7-777.000",
      otherTenant,
    );
    const other = record(
      { legalEntityId: otherEntity, supplierId: otherSupplier },
      otherTenant,
    );
    await other.run();

    const entity = await createEntity();
    const supplier = await createSupplier("88.888.888.8-888.000");
    await record({ legalEntityId: entity, supplierId: supplier }).run();

    const appPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    try {
      await appPool.query("BEGIN");
      await appPool.query("SET LOCAL ROLE legend_app");
      await appPool.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const { rows } = await appPool.query<{ id: string }>(
        "SELECT id FROM supplier_invoices WHERE id = $1 OR legal_entity_id = $2",
        [other.body.supplierInvoiceId, entity],
      );
      expect(rows.map((r) => r.id)).not.toContain(other.body.supplierInvoiceId);
      expect(rows).toHaveLength(1);
      await appPool.query("ROLLBACK");
    } finally {
      await appPool.end();
    }
  });
});

// The owner connection is intentionally separate from withTenant: the normal
// application role must retain its immutable-table UPDATE restriction.
const ownerDatabase = drizzle(owner, { schema });
const repairNpwp = (
  id: string,
  entity: string,
  reason = "547b recover missing legacy supplier identity",
) =>
  ownerDatabase.transaction((tx) =>
    repairSupplierInvoiceNpwpInTransaction(
      tx,
      scope(),
      {
        supplierInvoiceId: id,
        legalEntityId: entity,
        reason,
      },
      actor,
    ),
  );
const repairAudits = (id: string) =>
  owner.query<{
    event: { actorId: string; reason: string; maskedChanges: unknown };
  }>(
    "SELECT event FROM audit_logs WHERE tenant_id = $1 AND event->>'action' = 'accounting.supplier_invoice.npwp_corrected' AND event->>'objectId' = $2",
    [tenantId, id],
  );
async function legacyInvoice() {
  const entity = await createEntity();
  const supplier = await createSupplier("11.111.111.1-111.000");
  const invoice = record({ legalEntityId: entity, supplierId: supplier });
  await invoice.run();
  await owner.query(
    "UPDATE supplier_invoices SET npwp_snapshot = NULL WHERE tenant_id = $1 AND id = $2",
    [tenantId, invoice.body.supplierInvoiceId],
  );
  return { entity, supplier, ...invoice };
}

describe("547b legacy supplier invoice identity repair", () => {
  it("fills only the missing snapshot and audits actor/reason, preserving every monetary value", async () => {
    const invoice = await legacyInvoice();
    const id = invoice.body.supplierInvoiceId;
    const before = (await invoiceRows(id)).rows[0]!;
    const openBefore = (await openItemRows(id)).rows;
    const linesBefore = (
      await owner.query(
        "SELECT * FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no",
        [tenantId, invoice.body.journalEntryId],
      )
    ).rows;

    expect(await repairNpwp(id, invoice.entity)).toBe("corrected");

    expect((await invoiceRows(id)).rows[0]).toEqual({
      ...before,
      npwp_snapshot: "11.111.111.1-111.000",
    });
    expect((await openItemRows(id)).rows).toEqual(openBefore);
    expect(
      (
        await owner.query(
          "SELECT * FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no",
          [tenantId, invoice.body.journalEntryId],
        )
      ).rows,
    ).toEqual(linesBefore);
    const audit = (await repairAudits(id)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toMatchObject({
      actorId: actor,
      reason: "547b recover missing legacy supplier identity",
      maskedChanges: {
        before: { status: "missing" },
        after: { status: "corrected" },
      },
    });
    expect(JSON.stringify(audit)).not.toContain("11.111.111.1-111.000");
    await owner.query(
      "UPDATE suppliers SET npwp = '99.999.999.9-999.000' WHERE id = $1",
      [invoice.supplier],
    );
    expect(await repairNpwp(id, invoice.entity)).toBe("unchanged");
    expect((await invoiceRows(id)).rows[0]!.npwp_snapshot).toBe(
      "11.111.111.1-111.000",
    );
    expect((await repairAudits(id)).rows).toHaveLength(1);
  });

  it("rolls back the snapshot and audit together", async () => {
    const invoice = await legacyInvoice();
    const id = invoice.body.supplierInvoiceId;
    await expect(
      ownerDatabase.transaction(async (tx) => {
        await repairSupplierInvoiceNpwpInTransaction(
          tx,
          scope(),
          {
            supplierInvoiceId: id,
            legalEntityId: invoice.entity,
            reason: "547b rollback proof for supplier identity",
          },
          actor,
        );
        throw new Error("rollback after repair");
      }),
    ).rejects.toThrow("rollback after repair");
    expect((await invoiceRows(id)).rows[0]!.npwp_snapshot).toBeNull();
    expect((await repairAudits(id)).rows).toHaveLength(0);
  });

  it("refuses repair through the application role and never grants invoice UPDATE", async () => {
    const invoice = await legacyInvoice();
    await expect(
      withTenant(db, scope(), (tx) =>
        repairSupplierInvoiceNpwpInTransaction(
          tx,
          scope(),
          {
            supplierInvoiceId: invoice.body.supplierInvoiceId,
            legalEntityId: invoice.entity,
            reason: "547b app role cannot change immutable identities",
          },
          actor,
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const grants = await owner.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('legend_app', 'public.supplier_invoices', 'UPDATE') AS allowed",
    );
    expect(grants.rows[0]!.allowed).toBe(false);
    expect(
      (await invoiceRows(invoice.body.supplierInvoiceId)).rows[0]!
        .npwp_snapshot,
    ).toBeNull();
  });

  it("refuses missing supplier identity and wrong legal entity without mutation", async () => {
    const invoice = await legacyInvoice();
    const id = invoice.body.supplierInvoiceId;
    await expect(repairNpwp(id, await createEntity())).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      ownerDatabase.transaction((tx) =>
        repairSupplierInvoiceNpwpInTransaction(
          tx,
          scope(randomUUID()),
          {
            supplierInvoiceId: id,
            legalEntityId: invoice.entity,
            reason: "547b tenant isolation of owner repair",
          },
          actor,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await owner.query("UPDATE suppliers SET npwp = '   ' WHERE id = $1", [
      invoice.supplier,
    ]);
    await expect(repairNpwp(id, invoice.entity)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("NPWP"),
    });
    expect((await invoiceRows(id)).rows[0]!.npwp_snapshot).toBeNull();
    expect((await repairAudits(id)).rows).toHaveLength(0);
  });

  it("requires an explicit nonempty reason and actor", async () => {
    const invoice = await legacyInvoice();
    await expect(
      repairNpwp(invoice.body.supplierInvoiceId, invoice.entity, "   "),
    ).rejects.toBeTruthy();
    await expect(
      ownerDatabase.transaction((tx) =>
        repairSupplierInvoiceNpwpInTransaction(
          tx,
          scope(),
          {
            supplierInvoiceId: invoice.body.supplierInvoiceId,
            legalEntityId: invoice.entity,
            reason: "547b must record an attributable correction",
          },
          null as never,
        ),
      ),
    ).rejects.toBeTruthy();
    expect(
      (await repairAudits(invoice.body.supplierInvoiceId)).rows,
    ).toHaveLength(0);
  });
});
