// Coretax export opens the real tax ids (bead legend-xysyi, WS-07). Real
// PostgreSQL on the disposable test DB: employees (sealed NPWP, NIK fallback),
// supplier invoice snapshots, the legal entity's sealed NPWP (AAD
// `legal_entity:<tenant>`), tenant isolation, last-4 check against the report
// mask, and the `accounting.tax_report.npwp_opened` audit row (numbers only).
//
// Assumptions: the report mask of an employee is `****<last4>` and of a
// supplier `NPWP ****<last4>` (as the PPh 21 and PPN/PPh 23 sources write it);
// the export checks the real id's last four digits against it.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import type { TaxReportLine } from "@starter/shared/accounting";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HRIS_PII_KEY_VERSION, sealHrisPii } from "../lib/hris-pii";
import { sealSecret } from "../lib/secrets";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import { resolveCoretaxTaxIds } from "../services/accounting-coretax-tax-ids";
import { buildCoretaxXml } from "../services/accounting-coretax-xml";
import {
  exportTaxReport,
  finalizeTaxReport,
  generateTaxReport,
} from "../services/accounting-tax-reports.service";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");
const closer = randomUUID();
const accountant = randomUUID();
const otherTenantIds: string[] = [];

const NPWP15 = "012345678901234";
const NIK16 = "3174012345670009";

const ctxOf = (tenantId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

const runtime = (): StorageRuntime => ({
  storage: new FakeObjectStorage(),
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.invalid/${objectId}`,
  hrisDocumentSigner: async () => null,
});

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (otherTenantIds.length > 0)
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  await owner.end();
});

async function makeEntity(
  npwp: string | null,
  aadTenant: string = tenantA,
): Promise<string> {
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4)
     VALUES ($1, $2, $3, true, $4, $5)`,
    [
      entity,
      tenantA,
      `Coretax ids ${unique()}`,
      npwp === null ? null : sealSecret(npwp, `legal_entity:${aadTenant}`),
      npwp === null ? null : npwp.slice(-4),
    ],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [randomUUID(), randomUUID(), tenantA, entity],
  );
  return entity;
}

async function makeEmployee(opts: {
  npwp?: string | null;
  nik?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const seal = (value: string | null | undefined, field: "npwp" | "nik") =>
    value
      ? sealHrisPii(
          value,
          { tenantId: tenantA, table: "employees", rowId: id, field },
          HRIS_PII_KEY_VERSION,
        )
      : null;
  await owner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status, npwp_encrypted, npwp_hmac,
                            pii_key_version, nik_encrypted, nik_hmac)
     VALUES ($1, $2, $3, 'Karyawan Coretax', $4, 'pkwt', '2026-01-01', 'active', $5, $6, $7, $8, $9)`,
    [
      id,
      tenantA,
      `E-${unique().toUpperCase()}`,
      outletA,
      seal(opts.npwp, "npwp"),
      opts.npwp ? randomBytes(32).toString("hex") : null,
      HRIS_PII_KEY_VERSION,
      seal(opts.nik, "nik"),
      opts.nik ? randomBytes(32).toString("hex") : null,
    ],
  );
  return id;
}

const employeeLine = (subjectId: string, mask: string): TaxReportLine =>
  ({
    subjectType: "employee",
    subjectId,
    subjectName: "Karyawan Coretax",
    taxIdMasked: mask,
    outletId: null,
    baseIdr: 1000,
    taxIdr: 100,
    references: [],
  }) as unknown as TaxReportLine;

const supplierLine = (subjectId: string, mask: string): TaxReportLine =>
  ({
    subjectType: "supplier",
    subjectId,
    subjectName: "CV Pemasok",
    taxIdMasked: mask,
    outletId: null,
    baseIdr: 1000,
    taxIdr: 100,
    references: [],
  }) as unknown as TaxReportLine;

const resolve = (
  tenantId: string,
  report: Parameters<typeof resolveCoretaxTaxIds>[2],
) =>
  withTenant(db, ctxOf(tenantId), (tx) =>
    resolveCoretaxTaxIds(tx, tenantId, report),
  );

const xmlOf = (
  report: Parameters<typeof resolveCoretaxTaxIds>[2],
  ids: Awaited<ReturnType<typeof resolveCoretaxTaxIds>>,
) =>
  buildCoretaxXml(
    {
      id: randomUUID(),
      legalEntityId: report.legalEntityId,
      type: report.type,
      period: report.period,
      revisionNo: 0,
      amountIdr: 100,
      lines: report.lines as TaxReportLine[],
      finalizedAt: new Date("2026-12-01T00:00:00Z"),
    } as never,
    ids,
  );

describe("legend-xysyi resolveCoretaxTaxIds", () => {
  it("opens the employee NPWP and the entity NPWP", async () => {
    const entity = await makeEntity(NPWP15);
    const emp = await makeEmployee({ npwp: NPWP15 });
    const report = {
      legalEntityId: entity,
      type: "pph21",
      period: "2026-11",
      lines: [employeeLine(emp, "****1234")],
    } as const;
    const ids = await resolve(tenantA, report as never);
    expect(ids.lines.get(emp)).toBe(NPWP15);
    expect(ids.taxpayer).toBe(NPWP15);
    expect(xmlOf(report as never, ids)).toContain(`<TaxId>${NPWP15}</TaxId>`);
  });

  it("falls back to the NIK when the employee has no NPWP", async () => {
    const entity = await makeEntity(NPWP15);
    const emp = await makeEmployee({ npwp: null, nik: NIK16 });
    const report = {
      legalEntityId: entity,
      type: "pph21",
      period: "2026-11",
      lines: [employeeLine(emp, "****0009")],
    };
    const ids = await resolve(tenantA, report as never);
    expect(ids.lines.get(emp)).toBe(NIK16);
  });

  it("refuses a real id whose last 4 digits differ from the mask, without echoing it", async () => {
    const entity = await makeEntity(NPWP15);
    const emp = await makeEmployee({ npwp: NPWP15 });
    const report = {
      legalEntityId: entity,
      type: "pph21",
      period: "2026-11",
      lines: [employeeLine(emp, "****9999")],
    };
    const ids = await resolve(tenantA, report as never);
    let message = "";
    try {
      xmlOf(report as never, ids);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        "TAX_REPORT_SOURCE_UNAVAILABLE",
      );
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(NPWP15);
  });

  it("refuses an entity without NPWP", async () => {
    const entity = await makeEntity(null);
    await expect(
      resolve(tenantA, {
        legalEntityId: entity,
        type: "pph21",
        period: "2026-11",
        lines: [],
      } as never),
    ).rejects.toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
  });

  it("refuses an entity NPWP sealed under another tenant's AAD", async () => {
    const entity = await makeEntity(NPWP15, randomUUID());
    await expect(
      resolve(tenantA, {
        legalEntityId: entity,
        type: "pph21",
        period: "2026-11",
        lines: [],
      } as never),
    ).rejects.toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
  });

  it("does not open another tenant's entity or employees", async () => {
    const entity = await makeEntity(NPWP15);
    const emp = await makeEmployee({ npwp: NPWP15 });
    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Coretax ids other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `cti-${unique()}`, tenantA],
    );
    await expect(
      resolve(otherTenant, {
        legalEntityId: entity,
        type: "pph21",
        period: "2026-11",
        lines: [employeeLine(emp, "****1234")],
      } as never),
    ).rejects.toMatchObject({ code: "TAX_REPORT_SOURCE_UNAVAILABLE" });
  });

  it("reads a supplier's NPWP from the latest source invoice snapshot, not the supplier master", async () => {
    const entity = await makeEntity(NPWP15);
    const supplier = randomUUID();
    const creator = randomUUID();
    await owner.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
      [creator, "Coretax ids test", `${creator}@example.com`],
    );
    await owner.query(
      `INSERT INTO suppliers (id, tenant_id, name, payment_terms_days, created_by, npwp)
       VALUES ($1, $2, $3, 30, $4, '99.999.999.9-999.999')`,
      [supplier, tenantA, `Pemasok ${unique()}`, creator],
    );
    for (const [number, date, snapshot, createdAt] of [
      ["INV-1", "2026-11-02", "01.234.567.8-901.111", "2026-11-02T01:00:00Z"],
      ["INV-2", "2026-11-05", "01.234.567.8-901.234", "2026-11-05T01:00:00Z"],
    ] as const)
      await owner.query(
        `INSERT INTO supplier_invoices
           (id, tenant_id, legal_entity_id, supplier_id, invoice_number, invoice_date,
            dpp_idr, ppn_idr, pph23_idr, payable_idr, npwp_snapshot, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1000, 0, 20, 980, $7, $8)`,
        [
          randomUUID(),
          tenantA,
          entity,
          supplier,
          number,
          date,
          snapshot,
          createdAt,
        ],
      );
    const report = {
      legalEntityId: entity,
      type: "pph23",
      period: "2026-11",
      lines: [supplierLine(supplier, "NPWP ****1234")],
    };
    const ids = await resolve(tenantA, report as never);
    expect(ids.lines.get(supplier)).toBe(NPWP15);
    // The master NPWP (ending 9999) is never used: a mask of 9999 is refused.
    const stale = {
      ...report,
      lines: [supplierLine(supplier, "NPWP ****9999")],
    };
    expect(() => xmlOf(stale as never, ids)).toThrow();
  });
});

describe("legend-xysyi exportTaxReport", () => {
  async function filed(entity: string, lines: TaxReportLine[]) {
    const period = "2025-01";
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) RETURNING id`,
      [tenantA, entity, period],
    );
    await closeFiscalPeriod(
      ctxOf(tenantA),
      rows[0]!.id,
      { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
      userIdSchema.parse(closer),
    );
    const draft = await generateTaxReport(
      ctxOf(tenantA),
      userIdSchema.parse(accountant),
      { legalEntityId: entity, type: "pph21", period } as never,
      { lineSource: (async () => lines) as never },
    );
    return finalizeTaxReport(
      ctxOf(tenantA),
      userIdSchema.parse(accountant),
      draft.id as never,
      { idempotencyKey: `fin-${randomUUID()}` } as never,
    );
  }

  const doExport = (id: string) =>
    exportTaxReport(
      ctxOf(tenantA),
      userIdSchema.parse(accountant),
      id as never,
      runtime(),
    );

  const auditRows = async (id: string) =>
    (
      await owner.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'accounting.tax_report.npwp_opened'
            AND event->>'objectId' = $2`,
        [tenantA, id],
      )
    ).rows;

  it("writes an npwp_opened audit row with counts, no [redacted] and no NPWP", async () => {
    const entity = await makeEntity(NPWP15);
    const emp = await makeEmployee({ npwp: NPWP15 });
    const report = await filed(entity, [employeeLine(emp, "****1234")]);
    await doExport(report.id);
    const rows = await auditRows(report.id);
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0]!.event);
    const after = (
      rows[0]!.event.maskedChanges as { after: Record<string, unknown> }
    ).after;
    expect(after).toEqual({ lineTaxIds: 1, taxpayerIncluded: true });
    expect(text).not.toContain("redacted");
    expect(text).not.toContain(NPWP15);
  });

  it("refuses the export when the real NPWP ends differently from the report mask", async () => {
    const entity = await makeEntity(NPWP15);
    const emp = await makeEmployee({ npwp: NPWP15 });
    const report = await filed(entity, [employeeLine(emp, "****9999")]);
    await expect(doExport(report.id)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM tax_reports WHERE id = $1",
      [report.id],
    );
    expect(rows[0]!.status).toBe("final");
    expect(await auditRows(report.id)).toHaveLength(0);
  });

  it("refuses the export when the legal entity has no NPWP", async () => {
    const entity = await makeEntity(null);
    const report = await filed(entity, []);
    await expect(doExport(report.id)).rejects.toMatchObject({
      code: "TAX_REPORT_SOURCE_UNAVAILABLE",
    });
  });
});
