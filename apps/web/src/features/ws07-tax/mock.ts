// Mock handlers for the tax recap screen (`VITE_API_MOCK=true`), so the screen
// works with no API (docs/frontend.md "Typed endpoints and mock mode"). They
// serve the Cafe Legend tax fixtures and run the contract's own rules:
// transitionTaxReport (draft → final → exported, finalize needs a closed
// period) and assertTaxTypeApplicable (PPN masukan needs PKP). Mutations live in
// a mock store, so generate/finalize/export are clickable and every store
// re-seeds on resetMocks().
//
// Loaded by the browser mock transport only (no `@/` alias here). The real API
// sums posted transactions and writes the official Coretax XML; this mock has
// no ledger to sum yet, so a generated recap reuses the fixture report lines of
// the same type (references cleared, because they belong to the fixture
// period). That is mock-only; no rate or amount is computed here.
import {
  AccountingError,
  assertTaxTypeApplicable,
  cafeLegendAccountingFixtures,
  coretaxExportFileName,
  exportTaxReport,
  finalizeTaxReport,
  generateTaxReport,
  listTaxReports,
  TAX_REPORT_TYPES,
  taxReportExportSchema,
  taxReportSchema,
  transitionTaxReport,
  type FiscalPeriod,
  type TaxReport,
  type TaxReportLine,
  type TaxReportType,
} from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { AnyEndpoint } from "@starter/shared/api";
import type { z } from "zod";
import { ApiError } from "../../lib/api/errors.ts";
import { registerMock, type MockHandler } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const fixtures = cafeLegendAccountingFixtures;
const legalEntity = cafeLegendPlatformFixtures.legalEntity;
const finance = fixtures.users.finance;

type TaxReportExport = z.infer<typeof taxReportExportSchema>;

type TaxMockState = {
  reports: TaxReport[];
  /** One artifact per report, so an idempotent export replays the same file. */
  artifacts: Map<string, TaxReportExport>;
  /** Idempotency and replay: request key → report id. */
  created: Map<string, string>;
};

const state = createMockStore<TaxMockState>(() => ({
  reports: [...fixtures.taxReports],
  artifacts: new Map(),
  created: new Map(),
}));

/**
 * Registers a handler and maps the contract's own errors the way the API does:
 * `AccountingError` carries `code` and `status`, but the mock runtime only
 * knows `ApiError`, so a refusal would surface as INTERNAL_ERROR.
 */
function register<E extends AnyEndpoint>(
  endpoint: E,
  handler: MockHandler<E>,
): void {
  registerMock(endpoint, (context) => {
    try {
      return handler(context);
    } catch (error) {
      if (error instanceof AccountingError)
        throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

function findReport(taxReportId: string): TaxReport {
  const found = state.get().reports.find((report) => report.id === taxReportId);
  if (!found) throw notFound("Rekap pajak tidak ditemukan.");
  return found;
}

/**
 * The fiscal period a report is finalised in. A month with no fixture row is
 * treated as open (the fixtures list Sep–Nov 2026 only), so finalising it is
 * refused by the contract exactly like the API would.
 */
function periodOfReport(period: string): Pick<FiscalPeriod, "status"> {
  return (
    fixtures.fiscalPeriods.find((row) => row.period === period) ?? {
      status: "open",
    }
  );
}

/** Latest fixture recap of the type; the mock's stand-in for posted rows. */
function recapTemplate(type: TaxReportType): TaxReportLine[] {
  const template = fixtures.taxReports
    .filter((report) => report.type === type)
    .sort((a, b) => b.period.localeCompare(a.period))[0];
  if (!template) return [];
  // Document numbers belong to the fixture period, so they are not carried
  // into another month's recap.
  return template.lines.map((line) => ({
    ...line,
    references: [],
    warnings: [],
  }));
}

// ---- Report list -----------------------------------------------------------

register(listTaxReports, ({ query, scenario }) => {
  // The empty scenario is about the screen's own list; reference data
  // (legal entities) stays available.
  if (scenario === "empty") return { data: [] };
  const rows = state
    .get()
    .reports.filter((report) => report.legalEntityId === query.legalEntityId)
    .filter((report) => !query.type || report.type === query.type)
    .filter((report) => !query.status || report.status === query.status)
    // Newest period first, then the contract's type order (PBJT, PPh 21, …).
    .sort(
      (a, b) =>
        b.period.localeCompare(a.period) ||
        TAX_REPORT_TYPES.indexOf(a.type) - TAX_REPORT_TYPES.indexOf(b.type) ||
        a.id.localeCompare(b.id),
    );
  return { data: rows };
});

// ---- Generate (draft) ------------------------------------------------------

register(generateTaxReport, ({ body }) => {
  if (body.legalEntityId !== legalEntity.id)
    throw notFound("Badan usaha tidak ditemukan.");
  // §3 F19: PPN masukan needs PKP. The screen hides the action, the server
  // still refuses (fail closed).
  assertTaxTypeApplicable(body.type, { isPkp: legalEntity.isPkp });

  const current = state.get();
  const existing = current.reports.find(
    (report) =>
      report.legalEntityId === body.legalEntityId &&
      report.type === body.type &&
      report.period === body.period,
  );
  if (existing) {
    // Regenerating a draft is the same recap; a final report is frozen.
    if (existing.status !== "draft")
      throw new AccountingError("INVALID_TRANSITION");
    return { data: existing };
  }

  const lines = recapTemplate(body.type);
  const report = taxReportSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fixtures.tenantId,
    legalEntityId: body.legalEntityId,
    type: body.type,
    period: body.period,
    // The server sums the lines; the mock does the same from its recap rows.
    amountIdr: lines.reduce((total, line) => total + line.taxIdr, 0),
    lines,
    status: "draft",
    exportFormat: null,
    fileKey: null,
    generatedBy: finance,
    generatedAt: nowIso(),
    finalizedBy: null,
    finalizedAt: null,
    exportedAt: null,
    revisionNo: null,
    supersedesId: null,
    supersededById: null,
    supersededAt: null,
    correctionReason: null,
    fiscalPeriodVersion: 1,
    isCurrent: false,
  });
  current.reports.push(report);
  return { data: report };
});

// ---- Finalize (draft → final) ---------------------------------------------

register(finalizeTaxReport, ({ params, body }) => {
  const current = state.get();
  const replayKey = `finalize:${params.taxReportId}:${body.idempotencyKey}`;
  const replayed = current.created.get(replayKey);
  if (replayed) return { data: findReport(replayed) };

  const index = current.reports.findIndex(
    (report) => report.id === params.taxReportId,
  );
  if (index === -1) throw notFound("Rekap pajak tidak ditemukan.");
  const report = current.reports[index];
  // The contract decides the transition and refuses an open period.
  const status = transitionTaxReport(
    report,
    "finalize",
    periodOfReport(report.period),
  );
  const next = taxReportSchema.parse({
    ...report,
    status,
    finalizedBy: finance,
    finalizedAt: nowIso(),
    // The mock keeps one filing per period: revision 0, never superseded.
    revisionNo: 0,
    isCurrent: true,
  });
  current.reports[index] = next;
  current.created.set(replayKey, next.id);
  return { data: next };
});

// ---- Export (final → exported) --------------------------------------------

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Stand-in for the server-written Coretax file: the stored report values in a
 * plain XML envelope (mock only; the real DJP schema is the API's job and the
 * real file carries the unmasked tax ids, which the browser never sees).
 */
function mockCoretaxXml(report: TaxReport): string {
  const lines = report.lines
    .map(
      (line) =>
        `  <Line subjectType="${line.subjectType}" subjectName="${xmlText(line.subjectName)}" baseIdr="${line.baseIdr}" taxIdr="${line.taxIdr}"/>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MockCoretaxExport type="${report.type}" period="${report.period}" amountIdr="${report.amountIdr}">\n${lines}\n</MockCoretaxExport>\n`;
}

register(exportTaxReport, ({ params, body }) => {
  const current = state.get();
  const replayKey = `export:${params.taxReportId}:${body.idempotencyKey}`;
  if (current.created.get(replayKey)) {
    const artifact = current.artifacts.get(params.taxReportId);
    if (artifact) return { data: artifact };
  }

  const index = current.reports.findIndex(
    (report) => report.id === params.taxReportId,
  );
  if (index === -1) throw notFound("Rekap pajak tidak ditemukan.");
  const report = current.reports[index];
  // Export is allowed from final and may repeat; a draft is refused.
  transitionTaxReport(report, "export", periodOfReport(report.period));

  const fileKey = `tax/${report.period}/${report.type}-coretax.xml`;
  const exportedAt = nowIso();
  const artifact = taxReportExportSchema.parse({
    taxReportId: report.id,
    fileKey,
    fileName: coretaxExportFileName(
      report.type,
      report.period,
      report.revisionNo ?? 0,
    ),
    // The mock has no storage adapter, so the "signed URL" is a data: URL of
    // the file the server would store. The screen downloads whatever URL the
    // endpoint returns and never builds the file itself.
    downloadUrl: `data:application/xml;charset=utf-8,${encodeURIComponent(
      mockCoretaxXml(report),
    )}`,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  const next = taxReportSchema.parse({
    ...report,
    status: "exported",
    exportFormat: "coretax_xml",
    fileKey,
    exportedAt,
  });
  current.reports[index] = next;
  current.artifacts.set(next.id, artifact);
  current.created.set(replayKey, next.id);
  return { data: artifact };
});
