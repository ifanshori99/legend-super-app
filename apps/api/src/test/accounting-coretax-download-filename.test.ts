// Coretax export download file name (bead legend-12amh; PRD v1.7 §3.19 "Pajak").
// The signed download URL handed to the browser must carry
// downloadFileName = coretaxExportFileName(type, period, revisionNo), so the
// saved file is named `coretax-<type>-<period>-r<revisionNo>.xml` and not the
// private storage key.
//
// The handler is already built (m1, 16dfb81d): this test only pins the file
// name on the signed URL, so it is expected to pass on first run (no fail-first).
//
// Assumptions:
// - FakeObjectStorage (shared adapters) puts `&download=<encoded name>` on the
//   signed URL it returns; that is how the test sees downloadFileName.
// - Both the export response and the audit download response carry a signed
//   URL with that name (same name for export and a later download).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  coretaxExportFileName,
  type TaxReportLine,
} from "@starter/shared/accounting";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { sealSecret } from "../lib/secrets";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import {
  downloadTaxReport,
  exportTaxReport,
  finalizeTaxReport,
  generateTaxReport,
} from "../services/accounting-tax-reports.service";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");
const closer = randomUUID();
const requester = randomUUID();
const approver = randomUUID();
const accountant = randomUUID();

const scopedContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantA,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

function makeRuntime(): StorageRuntime {
  return {
    storage: new FakeObjectStorage(),
    scanner: new NoopMalwareScanner(),
    fileSigner: async (_context, objectId) =>
      `https://signed.invalid/${objectId}`,
    hrisDocumentSigner: async () => null,
  };
}

async function freshPeriod(period = "2025-01") {
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4) VALUES ($1, $2, $3, true, $4, '1234')",
    [
      entity,
      tenantA,
      `Coretax filename ${unique()}`,
      // The Coretax export refuses an entity without NPWP (legend-xysyi).
      sealSecret("012345678901234", `legal_entity:${tenantA}`),
    ],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [randomUUID(), randomUUID(), tenantA, entity],
  );
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantA, entity, period],
  );
  return { entity, id: rows[0]!.id, period };
}
type Fx = Awaited<ReturnType<typeof freshPeriod>>;

const lines = (tax: number): TaxReportLine[] => [
  {
    subjectType: "outlet",
    subjectId: randomUUID(),
    subjectName: "Outlet Uji",
    taxIdMasked: null,
    outletId: null,
    baseIdr: tax * 10,
    taxIdr: tax,
    references: [],
  } as unknown as TaxReportLine,
];

async function closeAt(fx: Fx, expectedVersion: number) {
  return closeFiscalPeriod(
    scopedContext(),
    fx.id,
    { expectedVersion, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
}

async function fileReport(fx: Fx, tax: number, correctionReason?: string) {
  const draft = await generateTaxReport(
    scopedContext(),
    userIdSchema.parse(accountant),
    { legalEntityId: fx.entity, type: "pbjt", period: fx.period } as never,
    { lineSource: (async () => lines(tax)) as never },
  );
  return finalizeTaxReport(
    scopedContext(),
    userIdSchema.parse(accountant),
    draft.id as never,
    {
      idempotencyKey: `fin-${randomUUID()}`,
      ...(correctionReason === undefined ? {} : { correctionReason }),
    } as never,
  );
}

/** The `download=` query value (the file name) of a signed URL. */
function downloadNameOf(signedUrl: string): string | null {
  return new URL(signedUrl).searchParams.get("download");
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("legend-12amh Coretax export download file name", () => {
  it("the signed URL of an export carries coretaxExportFileName(type, period, revisionNo) for revision 0", async () => {
    const fx = await freshPeriod();
    const runtime = makeRuntime();
    await closeAt(fx, 1);
    const report = await fileReport(fx, 100);
    const exported = await exportTaxReport(
      scopedContext(),
      userIdSchema.parse(accountant),
      report.id as never,
      runtime,
    );
    const expected = coretaxExportFileName("pbjt", fx.period, 0);
    expect(expected).toBe("coretax-pbjt-2025-01-r0.xml");
    expect(exported.fileName).toBe(expected);
    expect(downloadNameOf(exported.downloadUrl)).toBe(expected);
  });

  it("a later download returns a signed URL with the same file name", async () => {
    const fx = await freshPeriod();
    const runtime = makeRuntime();
    await closeAt(fx, 1);
    const report = await fileReport(fx, 100);
    await exportTaxReport(
      scopedContext(),
      userIdSchema.parse(accountant),
      report.id as never,
      runtime,
    );
    const got = await downloadTaxReport(
      scopedContext(),
      report.id as never,
      runtime,
    );
    const expected = coretaxExportFileName("pbjt", fx.period, 0);
    expect(got.fileName).toBe(expected);
    expect(downloadNameOf(got.downloadUrl)).toBe(expected);
  });

  it("a correction (revision 1) downloads as -r1.xml, and the superseded revision keeps -r0.xml", async () => {
    const fx = await freshPeriod();
    const runtime = makeRuntime();
    await closeAt(fx, 1);
    const rev0 = await fileReport(fx, 100);
    await exportTaxReport(
      scopedContext(),
      userIdSchema.parse(accountant),
      rev0.id as never,
      runtime,
    );
    const request = await requestPeriodReopen(
      scopedContext(),
      fx.id,
      { reason: "Koreksi nama file" },
      userIdSchema.parse(requester),
    );
    const approved = await approvePeriodReopen(
      scopedContext(),
      request.id,
      { note: null },
      userIdSchema.parse(approver),
    );
    await closeAt(fx, approved.period.version);
    const rev1 = await fileReport(fx, 120, "Koreksi tarif");
    const second = await exportTaxReport(
      scopedContext(),
      userIdSchema.parse(accountant),
      rev1.id as never,
      runtime,
    );
    expect(downloadNameOf(second.downloadUrl)).toBe(
      coretaxExportFileName("pbjt", fx.period, 1),
    );
    expect(downloadNameOf(second.downloadUrl)).toBe(
      "coretax-pbjt-2025-01-r1.xml",
    );
    const old = await downloadTaxReport(
      scopedContext(),
      rev0.id as never,
      runtime,
    );
    expect(downloadNameOf(old.downloadUrl)).toBe(
      coretaxExportFileName("pbjt", fx.period, 0),
    );
  });

  it("the download name is a plain file name, never the private storage key", async () => {
    const fx = await freshPeriod();
    const runtime = makeRuntime();
    await closeAt(fx, 1);
    const report = await fileReport(fx, 100);
    const exported = await exportTaxReport(
      scopedContext(),
      userIdSchema.parse(accountant),
      report.id as never,
      runtime,
    );
    const name = downloadNameOf(exported.downloadUrl);
    expect(name).toMatch(/^coretax-[a-z0-9-]+\.xml$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain(report.id);
  });
});
