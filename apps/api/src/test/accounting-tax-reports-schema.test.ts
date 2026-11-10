// tax_reports table (bead legend-gmww, WS-07; PRD v1.7 §3.19 "Pajak [P0]";
// §6 F `tax_reports`). The table persists the `taxReportSchema` contract in
// packages/shared/src/accounting/tax.ts: lines, finalized_by/at, exported_at.
// Real PostgreSQL on the disposable test DB: constraints are checked with the
// owner pool, tenant isolation (TEN-01/02) through withTenant.
// Migration 0231 (legend-r3i8w) added the revision chain: every row carries
// fiscal_period_version, and a filed row carries revision_no (0 here, the
// normal filing). Chain rules themselves live in
// accounting-tax-report-revisions.test.ts; this file only keeps its earlier
// cases valid and records what 0231 changed (file_key is now locked).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );

async function seedEntity() {
  const [tenantId, legalEntityId] = [randomUUID(), randomUUID()];
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Pajak', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-pajak-${tenantId.slice(0, 8)}`,
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
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', true)",
    [legalEntityId, tenantId],
  );
  return { tenantId, legalEntityId };
}

let a: Awaited<ReturnType<typeof seedEntity>>;
let b: Awaited<ReturnType<typeof seedEntity>>;
beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  a = await seedEntity();
  b = await seedEntity();
});
afterAll(async () => {
  await pool.end();
  await owner.end();
});

type Overrides = Partial<{
  tenantId: string;
  legalEntityId: string;
  type: string;
  period: string;
  amountIdr: number;
  lines: unknown;
  status: string;
  exportFormat: string | null;
  fileKey: string | null;
  finalizedBy: string | null;
  finalizedAt: string | null;
  exportedAt: string | null;
}>;

const NOW = "2026-11-10T03:00:00Z";
const LINE = {
  subjectType: "outlet",
  subjectId: randomUUID(),
  subjectName: "Outlet Uji",
  taxIdMasked: null,
  outletId: null,
  baseIdr: 1000,
  taxIdr: 100,
  references: [],
};

/** A valid draft by default; each test overrides the field it breaks. */
function insertReport(o: Overrides = {}) {
  const v = {
    tenantId: a.tenantId,
    legalEntityId: a.legalEntityId,
    type: "pbjt",
    period: "2026-10",
    amountIdr: 100,
    lines: [LINE],
    status: "draft",
    exportFormat: null,
    fileKey: null,
    finalizedBy: null,
    finalizedAt: null,
    exportedAt: null,
    ...o,
  };
  return owner.query(
    `INSERT INTO tax_reports
       (tenant_id, legal_entity_id, type, period, amount_idr, lines, status,
        export_format, file_key, generated_by, generated_at,
        finalized_by, finalized_at, exported_at,
        revision_no, fiscal_period_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'user-1', $10, $11, $12, $13,
             $14, 1)`,
    [
      v.tenantId,
      v.legalEntityId,
      v.type,
      v.period,
      v.amountIdr,
      JSON.stringify(v.lines),
      v.status,
      v.exportFormat,
      v.fileKey,
      NOW,
      v.finalizedBy,
      v.finalizedAt,
      v.exportedAt,
      // 0231: NULL exactly while draft; 0 = the normal filing.
      v.status === "draft" ? null : 0,
    ],
  );
}

describe("legend-gmww tax_reports", () => {
  it("stores a draft with lines and no finalize/export stamps", async () => {
    await insertReport({ period: "2026-01" });
    const { rows } = await owner.query(
      `SELECT lines, finalized_by, finalized_at, exported_at, version
       FROM tax_reports WHERE tenant_id = $1 AND period = '2026-01'`,
      [a.tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].lines).toEqual([LINE]);
    expect(rows[0].finalized_by).toBeNull();
    expect(rows[0].exported_at).toBeNull();
    expect(rows[0].version).toBe(1);
  });

  it("stores a final and an exported report with their stamps", async () => {
    const stamps = { finalizedBy: "user-2", finalizedAt: NOW };
    await insertReport({ period: "2026-02", status: "final", ...stamps });
    await insertReport({
      period: "2026-03",
      status: "exported",
      ...stamps,
      exportFormat: "coretax_xml",
      fileKey: "t/tax/2026-03.xml",
      exportedAt: NOW,
    });
  });

  it.each<[string, Overrides]>([
    ["unknown type", { type: "pph22" }],
    ["malformed period", { period: "2026-13" }],
    ["negative amount", { amountIdr: -1 }],
    ["lines that are not an array", { lines: { a: 1 } }],
    ["unknown status", { status: "void" }],
    ["unknown export format", { exportFormat: "csv" }],
    ["a final report without finalize stamps", { status: "final" }],
    [
      "a draft that carries finalize stamps",
      { finalizedBy: "user-2", finalizedAt: NOW },
    ],
    [
      "an exported report without a file key",
      {
        status: "exported",
        finalizedBy: "user-2",
        finalizedAt: NOW,
        exportFormat: "coretax_xml",
        exportedAt: NOW,
      },
    ],
    [
      "an export stamp on a non-exported report",
      { exportedAt: NOW, exportFormat: "coretax_xml", fileKey: "k" },
    ],
  ])("rejects %s", async (_name, overrides) => {
    // 23514 = check_violation: the table exists and a constraint refused it,
    // not a missing relation.
    await expect(
      insertReport({ period: "2026-04", ...overrides }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows one active draft per entity, type and period", async () => {
    await insertReport({ period: "2026-05" });
    await expect(insertReport({ period: "2026-05" })).rejects.toThrow(
      /tax_reports_draft_key/,
    );
    // A different type, and a finalised report beside a draft, are fine.
    await insertReport({ period: "2026-05", type: "ppn" });
    await insertReport({
      period: "2026-05",
      status: "final",
      finalizedBy: "user-2",
      finalizedAt: NOW,
    });
  });

  it("rejects a legal entity of another tenant (composite FK)", async () => {
    await expect(
      insertReport({ period: "2026-06", legalEntityId: b.legalEntityId }),
    ).rejects.toThrow(/tax_reports_legal_entity_fk/);
  });

  describe("filed reports are locked", () => {
    const STAMPS = { finalizedBy: "user-2", finalizedAt: NOW };
    const EXPORT = {
      exportFormat: "coretax_xml",
      fileKey: "t/tax/x.xml",
      exportedAt: NOW,
    };
    const update = (period: string, type: string, set: string) =>
      owner.query(
        `UPDATE tax_reports SET ${set} WHERE tenant_id = $1 AND period = $2 AND type = $3`,
        [a.tenantId, period, type],
      );

    it("lets a draft be regenerated and deleted", async () => {
      await insertReport({ period: "2025-01" });
      await update("2025-01", "pbjt", "amount_idr = 5, lines = '[]'::jsonb");
      await update("2025-01", "pbjt", "version = version + 1");
      const del = await owner.query(
        "DELETE FROM tax_reports WHERE tenant_id = $1 AND period = '2025-01'",
        [a.tenantId],
      );
      expect(del.rowCount).toBe(1);
    });

    it("lets final move to exported, and an export be repeated without a new file", async () => {
      await insertReport({
        period: "2025-02",
        status: "final",
        ...STAMPS,
      });
      await update(
        "2025-02",
        "pbjt",
        `status = 'exported', export_format = 'coretax_xml', file_key = 'k1', exported_at = '${NOW}'`,
      );
      // 0231: the file_key is locked once set, so a repeat keeps the same file.
      await update("2025-02", "pbjt", "version = version + 1");
    });

    it("rejects swapping the file of an exported report (changed by 0231)", async () => {
      await insertReport({
        period: "2025-06",
        status: "exported",
        ...STAMPS,
        ...EXPORT,
      });
      await expect(
        update("2025-06", "pbjt", "file_key = 'k2'"),
      ).rejects.toMatchObject({ code: "42501" });
    });

    let lockCase = 0;
    it.each([
      ["amount_idr", "amount_idr = 1"],
      ["lines", "lines = '[]'::jsonb"],
      ["type", "type = 'ppn'"],
      ["period", "period = '2025-12'"],
      ["finalized_by", "finalized_by = 'user-9'"],
      ["generated_by", "generated_by = 'user-9'"],
      [
        "status back to draft",
        "status = 'draft', finalized_by = NULL, finalized_at = NULL",
      ],
    ])("rejects changing %s of a final report", async (_name, set) => {
      // 0231: one current filed report per key, so each case owns its period.
      const period = `${2100 + lockCase++}-03`;
      await insertReport({ period, status: "final", ...STAMPS });
      await expect(update(period, "pbjt", set)).rejects.toMatchObject({
        code: "42501",
      });
    });

    it("rejects moving an exported report back to final", async () => {
      await insertReport({
        period: "2025-04",
        status: "exported",
        ...STAMPS,
        ...EXPORT,
      });
      await expect(
        update(
          "2025-04",
          "pbjt",
          "status = 'final', export_format = NULL, file_key = NULL, exported_at = NULL",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("rejects deleting a final or exported report", async () => {
      await insertReport({ period: "2025-05", status: "final", ...STAMPS });
      await expect(
        owner.query(
          "DELETE FROM tax_reports WHERE tenant_id = $1 AND period = '2025-05'",
          [a.tenantId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("TEN-01/02 isolates reports across tenants", async () => {
    await insertReport({ period: "2026-07" });
    const own = await withTenant(db, context(a.tenantId), (tx) =>
      tx
        .select()
        .from(schema.taxReports)
        .where(eq(schema.taxReports.period, "2026-07")),
    );
    expect(own).toHaveLength(1);
    const other = await withTenant(db, context(b.tenantId), (tx) =>
      tx
        .select()
        .from(schema.taxReports)
        .where(eq(schema.taxReports.period, "2026-07")),
    );
    expect(other).toEqual([]);
  });
});
