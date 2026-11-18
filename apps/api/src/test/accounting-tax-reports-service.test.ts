// Tax report service flow (beads legend-5nhkp, legend-r3i8w; PRD v1.7 §3.19
// "Pajak"; docs/DECISIONS.md 2026-11-10 "Laporan pajak: pembetulan sebagai
// rantai revisi"). Runs the services against the disposable PostgreSQL
// database with a fake object storage and an injected line source, so no
// ledger postings are needed. Period close and reopen use the real services,
// so fiscal_periods.version moves exactly as in production (close 1 -> 2,
// reopen -> 3, re-close -> 4).
//
// Assumptions (the brief does not pin these down):
// - Service signatures follow the shared brief; the acting user is the second
//   argument. `finalizeTaxReport` body is `{ idempotencyKey, correctionReason? }`
//   (finalizeTaxReportBodySchema in the shared contract).
// - List services may return `{ data: [...] }` (the endpoint envelope) or a bare
//   array; `rowsOf` accepts both.
// - Errors are `AccountingError`s: asserted by `code` and `status`.
// - A whitespace-only correctionReason counts as missing (same 400 as absent).
// - Downloading a report that was never exported, or a draft, fails with 404 or
//   409 ("404/409" in the brief); an unknown id is 404.
// - The Coretax "code" of a revision is checked through the file name suffix
//   (-r<revisionNo>.xml) and by the XML of revision 1 differing from revision 0
//   built from identical lines. The XML element names are not part of the brief.
// - A missing fiscal period row makes generate fail; the error code is unspecified.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  accountingErrorHttpStatus,
  taxReportExportedEvent,
  type FiscalPeriod,
  type TaxReport,
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
  listTaxReports,
} from "../services/accounting-tax-reports.service";

const tenantA = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const unique = () => randomBytes(4).toString("hex");

// Four distinct people: closer, requester, approver and the tax accountant.
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

// ---- Fake storage ------------------------------------------------------------

type Put = { tenantId: string; key: string; content: string };

/** In-memory storage that records every upload and can be made to fail. */
class RecordingStorage extends FakeObjectStorage {
  puts: Put[] = [];
  failNext = false;
  override async put(
    ...args: Parameters<FakeObjectStorage["put"]>
  ): ReturnType<FakeObjectStorage["put"]> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("storage offline");
    }
    const input = args[1] as unknown as {
      tenantId: string;
      key: string;
      content: string | Uint8Array;
    };
    this.puts.push({
      tenantId: input.tenantId,
      key: input.key,
      content:
        typeof input.content === "string"
          ? input.content
          : new TextDecoder().decode(input.content),
    });
    return super.put(...args);
  }
}

function makeRuntime() {
  const storage = new RecordingStorage();
  const runtime: StorageRuntime = {
    storage,
    scanner: new NoopMalwareScanner(),
    fileSigner: async (_context, objectId) =>
      `https://signed.invalid/${objectId}`,
    hrisDocumentSigner: async () => null,
  };
  return { storage, runtime };
}

// ---- Fixtures ------------------------------------------------------------------

async function makeEntity(isPkp: boolean): Promise<string> {
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp, npwp_encrypted, npwp_last4) VALUES ($1, $2, $3, $4, $5, '1234')",
    [
      entity,
      tenantA,
      `Tax service ${unique()}`,
      isPkp,
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
  return entity;
}

async function makePeriod(entity: string, period: string) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantA, entity, period],
  );
  return { id: rows[0]!.id, entity, period };
}
type Period = Awaited<ReturnType<typeof makePeriod>>;

/** A fresh PKP legal entity with one open past period (version 1). */
async function fresh(period = "2025-01") {
  const entity = await makeEntity(true);
  return { entity, p: await makePeriod(entity, period) };
}

const periodVersion = async (p: Period) =>
  (
    await owner.query<{ version: number }>(
      "SELECT version FROM fiscal_periods WHERE id = $1",
      [p.id],
    )
  ).rows[0]!.version;

function closePeriod(
  p: Period,
  expectedVersion: number,
): Promise<FiscalPeriod> {
  return closeFiscalPeriod(
    scopedContext(),
    p.id,
    { expectedVersion, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
}

/** Close an open period (version 1 -> 2). */
const close = (p: Period) => closePeriod(p, 1);

/** Reopen a closed period and close it again (version n -> n+2). */
async function reopenAndReclose(p: Period): Promise<number> {
  const request = await requestPeriodReopen(
    scopedContext(),
    p.id,
    { reason: "Koreksi pajak" },
    userIdSchema.parse(requester),
  );
  const approved = await approvePeriodReopen(
    scopedContext(),
    request.id,
    { note: null },
    userIdSchema.parse(approver),
  );
  const reclosed = await closePeriod(p, approved.period.version);
  return reclosed.version;
}

// ---- Service adapters ------------------------------------------------------------

const actor = () => userIdSchema.parse(accountant);

/** Lines whose tax sum is `tax` (one outlet row). */
function lines(tax: number, name = "Outlet Uji"): TaxReportLine[] {
  return [
    {
      subjectType: "outlet",
      subjectId: randomUUID(),
      subjectName: name,
      taxIdMasked: null,
      outletId: null,
      baseIdr: tax * 10,
      taxIdr: tax,
      references: [],
    } as unknown as TaxReportLine,
  ];
}

/** A line source returning fixed lines, recording what it was asked for. */
function source(fixed: TaxReportLine[]) {
  const calls: unknown[] = [];
  return {
    calls,
    lineSource: async (_tx: unknown, args: unknown) => {
      calls.push(args);
      return fixed;
    },
  };
}

function generate(
  fx: { entity: string; p: Period },
  fixed: TaxReportLine[] = lines(100),
  type: "pbjt" | "pph21" | "pph23" | "ppn" = "pbjt",
): Promise<TaxReport> {
  return generateTaxReport(
    scopedContext(),
    actor(),
    { legalEntityId: fx.entity, type, period: fx.p.period } as never,
    { lineSource: source(fixed).lineSource as never },
  );
}

function finalize(report: { id: string }, correctionReason?: string) {
  return finalizeTaxReport(
    scopedContext(),
    actor(),
    report.id as never,
    {
      idempotencyKey: `fin-${randomUUID()}`,
      ...(correctionReason === undefined ? {} : { correctionReason }),
    } as never,
  );
}

const exportReport = (report: { id: string }, runtime: StorageRuntime) =>
  exportTaxReport(scopedContext(), actor(), report.id as never, runtime);

const download = (id: string, runtime: StorageRuntime) =>
  downloadTaxReport(scopedContext(), id as never, runtime);

async function list(
  fx: { entity: string },
  extra: { includeSuperseded?: boolean; type?: string; status?: string } = {},
): Promise<TaxReport[]> {
  const result = (await listTaxReports(scopedContext(), {
    legalEntityId: fx.entity,
    ...extra,
  } as never)) as unknown as { data: TaxReport[] } | TaxReport[];
  return Array.isArray(result) ? result : result.data;
}

/** Generate and finalize one filing on an already closed period. */
async function file(
  fx: { entity: string; p: Period },
  tax = 100,
  reason?: string,
): Promise<TaxReport> {
  const draft = await generate(fx, lines(tax));
  return finalize(draft, reason);
}

/** First normal filing: close, generate, finalize. */
async function normalFiling(fx: { entity: string; p: Period }) {
  await close(fx.p);
  return file(fx);
}

async function errorOf(run: Promise<unknown>) {
  try {
    await run;
    return null;
  } catch (error) {
    return error as {
      code?: string;
      status?: number;
      details?: Record<string, unknown>;
    };
  }
}

async function expectCode(
  run: Promise<unknown>,
  code: string,
  status?: number,
) {
  const error = await errorOf(run);
  expect(error?.code, String(error)).toBe(code);
  if (status !== undefined) expect(error?.status).toBe(status);
}

async function dbRow(id: string) {
  return (
    await owner.query(
      `SELECT status, revision_no, supersedes_id, superseded_by_id, superseded_at,
              correction_reason, file_key, exported_at, version, fiscal_period_version,
              amount_idr::int AS amount_idr
         FROM tax_reports WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

async function exportEvents(reportId: string) {
  const { rows } = await owner.query<{
    aggregate_id: string;
    event: { payload: unknown; tenantId: string };
  }>(
    `SELECT aggregate_id, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'tax_report.exported'
        AND event->'payload'->>'taxReportId' = $2`,
    [tenantA, reportId],
  );
  return rows;
}

async function currentRows(fx: { entity: string; p: Period }, type = "pbjt") {
  const { rows } = await owner.query<{ id: string; revision_no: number }>(
    `SELECT id, revision_no FROM tax_reports
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND type = $3 AND period = $4
        AND status <> 'draft' AND superseded_at IS NULL`,
    [tenantA, fx.entity, type, fx.p.period],
  );
  return rows;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  for (const id of [closer, requester, approver, accountant])
    await owner.query(
      'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
      [id, "Tax service test", `${id}@example.com`],
    );
});
afterAll(async () => {
  await owner.end();
});

// ================================================================================

describe("legend-5nhkp generate draft", () => {
  it("stores a draft with the line sum, the period version and no revision", async () => {
    const fx = await fresh();
    const feed = source([...lines(60), ...lines(40, "Outlet Dua")]);
    const draft = await generateTaxReport(
      scopedContext(),
      actor(),
      { legalEntityId: fx.entity, type: "pbjt", period: "2025-01" } as never,
      { lineSource: feed.lineSource as never },
    );
    expect(draft.status).toBe("draft");
    expect(draft.amountIdr).toBe(100);
    expect(draft.lines).toHaveLength(2);
    expect(draft.revisionNo).toBeNull();
    expect(draft.supersedesId).toBeNull();
    expect(draft.supersededById).toBeNull();
    expect(draft.isCurrent).toBe(false);
    expect(draft.fiscalPeriodVersion).toBe(await periodVersion(fx.p));
    expect(draft.generatedBy).toBe(accountant);
    expect(feed.calls).toHaveLength(1);
    expect(feed.calls[0]).toMatchObject({
      tenantId: tenantA,
      legalEntityId: fx.entity,
      type: "pbjt",
      period: "2025-01",
    });
  });

  it("regenerating replaces the same draft and refreshes the period version", async () => {
    const fx = await fresh();
    const first = await generate(fx, lines(100));
    expect(first.fiscalPeriodVersion).toBe(1);
    await close(fx.p); // version 2
    const second = await generate(fx, lines(250));
    expect(second.id).toBe(first.id);
    expect(second.amountIdr).toBe(250);
    expect(second.fiscalPeriodVersion).toBe(2);
    expect((await list(fx)).filter((r) => r.status === "draft")).toHaveLength(
      1,
    );
  });

  it("refuses an unknown legal entity (404)", async () => {
    const fx = await fresh();
    const error = await errorOf(
      generateTaxReport(
        scopedContext(),
        actor(),
        {
          legalEntityId: randomUUID(),
          type: "pbjt",
          period: fx.p.period,
        } as never,
        { lineSource: source(lines(1)).lineSource as never },
      ),
    );
    expect(error?.status).toBe(404);
  });

  it("refuses PPN for a legal entity that is not PKP", async () => {
    const entity = await makeEntity(false);
    const p = await makePeriod(entity, "2025-01");
    await expectCode(
      generate({ entity, p }, lines(10), "ppn"),
      "TAX_REPORT_NOT_APPLICABLE",
    );
  });

  it("refuses a period that has no fiscal period row", async () => {
    const entity = await makeEntity(true);
    const p = { id: randomUUID(), entity, period: "2025-02" };
    await expect(generate({ entity, p })).rejects.toThrow();
  });

  // The default sources are real now (legend-v4v7c). PPh 21 needs the
  // pph21_payable ledger role and fails closed when it is unmapped; PPh 23 and
  // PPN always read their ledger roles, so with the roles mapped and nothing on
  // the ledger or in the records they give an empty draft of amount 0 (ledger
  // activity without records, unmapped roles and mismatches are 422s, see
  // accounting-tax-source-vat-wht*.test.ts).
  it("PPh 21 fails closed without a ledger mapping; PPh 23 and PPN give an empty draft when roles are mapped and there is nothing to report (default source)", async () => {
    const fx = await fresh();
    const roles = ["pph23_payable", "ppn_input", "tax_payable_ppn"] as const;
    for (const role of roles) {
      const accountId = randomUUID();
      await owner.query(
        `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          accountId,
          tenantA,
          fx.entity,
          `9${roles.indexOf(role)}01`,
          role,
          role === "ppn_input" ? "asset" : "liability",
          role === "ppn_input" ? "current_asset" : "current_liability",
        ],
      );
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantA, fx.entity, role, accountId],
      );
    }
    await expectCode(
      generateTaxReport(scopedContext(), actor(), {
        legalEntityId: fx.entity,
        type: "pph21",
        period: fx.p.period,
      } as never),
      "TAX_REPORT_SOURCE_UNAVAILABLE",
      422,
    );
    for (const type of ["pph23", "ppn"] as const) {
      const report = await generateTaxReport(scopedContext(), actor(), {
        legalEntityId: fx.entity,
        type,
        period: fx.p.period,
      } as never);
      expect(report.lines, type).toEqual([]);
      expect(report.amountIdr, type).toBe(0);
    }
  });
});

describe("legend-5nhkp finalize and the revision chain", () => {
  it("refuses to finalize while the period is open (PERIOD_NOT_CLOSED)", async () => {
    const fx = await fresh();
    const draft = await generate(fx);
    await expectCode(finalize(draft), "PERIOD_NOT_CLOSED", 409);
    expect((await dbRow(draft.id)).status).toBe("draft");
  });

  it("files the first report as revision 0 and makes it current", async () => {
    const fx = await fresh();
    const report = await normalFiling(fx);
    expect(report.status).toBe("final");
    expect(report.revisionNo).toBe(0);
    expect(report.supersedesId).toBeNull();
    expect(report.correctionReason).toBeNull();
    expect(report.isCurrent).toBe(true);
    expect(report.finalizedBy).toBe(accountant);
    expect(report.finalizedAt).not.toBeNull();
    expect(report.fiscalPeriodVersion).toBe(2);
  });

  it("ignores a reason on revision 0", async () => {
    const fx = await fresh();
    await close(fx.p);
    const report = await file(fx, 100, "tidak diperlukan");
    expect(report.revisionNo).toBe(0);
    expect(report.correctionReason).toBeNull();
  });

  it("refuses to finalize a report that is not a draft (INVALID_TRANSITION)", async () => {
    const fx = await fresh();
    const report = await normalFiling(fx);
    await expectCode(finalize(report), "INVALID_TRANSITION", 409);
  });

  it("refuses an unknown report (404)", async () => {
    const error = await errorOf(finalize({ id: randomUUID() }));
    expect(error?.status).toBe(404);
  });

  it("files a correction as revision 1 with its reason and supersedes revision 0", async () => {
    const fx = await fresh();
    const rev0 = await normalFiling(fx);
    await reopenAndReclose(fx.p);
    const draft = await generate(fx, lines(150));

    // No reason: 400, nothing changes.
    await expectCode(
      finalize(draft),
      "TAX_REPORT_CORRECTION_REASON_REQUIRED",
      400,
    );
    await expectCode(
      finalize(draft, "   "),
      "TAX_REPORT_CORRECTION_REASON_REQUIRED",
      400,
    );
    expect((await dbRow(draft.id)).status).toBe("draft");
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev0.id]);

    const rev1 = await finalize(draft, "Omzet outlet dua belum masuk");
    expect(rev1.id).toBe(draft.id);
    expect(rev1.revisionNo).toBe(1);
    expect(rev1.supersedesId).toBe(rev0.id);
    expect(rev1.correctionReason).toBe("Omzet outlet dua belum masuk");
    expect(rev1.isCurrent).toBe(true);
    expect(rev1.amountIdr).toBe(150);

    const old = await dbRow(rev0.id);
    expect(old.superseded_by_id).toBe(rev1.id);
    expect(old.superseded_at).not.toBeNull();
    expect(old.status).toBe("final");
    expect(old.revision_no).toBe(0);
  });

  it("numbers the next correction 2 and keeps exactly one current report", async () => {
    const fx = await fresh();
    const rev0 = await normalFiling(fx);
    await reopenAndReclose(fx.p);
    const rev1 = await file(fx, 150, "Pembetulan pertama");
    await reopenAndReclose(fx.p);
    const rev2 = await file(fx, 175, "Pembetulan kedua");

    expect(rev2.revisionNo).toBe(2);
    expect(rev2.supersedesId).toBe(rev1.id);
    expect(rev2.correctionReason).toBe("Pembetulan kedua");
    const current = await currentRows(fx);
    expect(current).toEqual([{ id: rev2.id, revision_no: 2 }]);
    expect((await dbRow(rev0.id)).superseded_by_id).toBe(rev1.id);
    expect((await dbRow(rev1.id)).superseded_by_id).toBe(rev2.id);
  });

  it("supersedes an already exported report", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    const rev0 = await normalFiling(fx);
    await exportReport(rev0, runtime);
    await reopenAndReclose(fx.p);
    const rev1 = await file(fx, 120, "Koreksi setelah diekspor");
    expect(rev1.revisionNo).toBe(1);
    expect((await dbRow(rev0.id)).status).toBe("exported");
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev1.id]);
  });

  it("list shows the current report and drafts; includeSuperseded shows the history", async () => {
    const fx = await fresh();
    const rev0 = await normalFiling(fx);
    await reopenAndReclose(fx.p);
    const rev1 = await file(fx, 150, "Koreksi");
    await reopenAndReclose(fx.p);
    const draft = await generate(fx, lines(160));

    const shown = await list(fx);
    expect(shown.map((r) => r.id).sort()).toEqual([rev1.id, draft.id].sort());
    expect(shown.find((r) => r.id === rev1.id)).toMatchObject({
      revisionNo: 1,
      isCurrent: true,
      supersededById: null,
    });

    const history = await list(fx, { includeSuperseded: true });
    expect(history.map((r) => r.id).sort()).toEqual(
      [rev0.id, rev1.id, draft.id].sort(),
    );
    const old = history.find((r) => r.id === rev0.id)!;
    expect(old).toMatchObject({
      revisionNo: 0,
      isCurrent: false,
      supersededById: rev1.id,
    });
    expect(old.supersededAt).not.toBeNull();
    expect(history.filter((r) => r.isCurrent)).toHaveLength(1);
  });

  it("list filters by type and status", async () => {
    const fx = await fresh();
    await normalFiling(fx);
    const otherType = await generate(fx, lines(5), "ppn");
    expect((await list(fx, { type: "ppn" })).map((r) => r.id)).toEqual([
      otherType.id,
    ]);
    expect((await list(fx, { status: "draft" })).map((r) => r.id)).toEqual([
      otherType.id,
    ]);
    expect(
      (await list(fx, { status: "final" })).every((r) => r.status === "final"),
    ).toBe(true);
  });

  it("two finalizes of the same draft: exactly one wins, the other is INVALID_TRANSITION", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx);
    const results = await Promise.allSettled([
      finalize(draft),
      finalize(draft),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect(lost.reason.code).toBe("INVALID_TRANSITION");
    expect(await currentRows(fx)).toHaveLength(1);
  });
});

describe("legend-5nhkp stale draft and amount check", () => {
  it("a draft made while the period was open is stale once it closes (409 TAX_REPORT_STALE)", async () => {
    const fx = await fresh();
    const draft = await generate(fx); // period version 1
    await close(fx.p); // version 2
    await expectCode(finalize(draft), "TAX_REPORT_STALE", 409);
    expect((await dbRow(draft.id)).status).toBe("draft");
    // Regenerating from the closed books fixes it.
    const again = await generate(fx);
    expect(again.id).toBe(draft.id);
    expect(again.fiscalPeriodVersion).toBe(2);
    expect((await finalize(again)).revisionNo).toBe(0);
  });

  it("a draft is stale after a reopen and re-close moved the period version", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx); // version 2
    expect(draft.fiscalPeriodVersion).toBe(2);
    expect(await reopenAndReclose(fx.p)).toBe(4);
    await expectCode(finalize(draft), "TAX_REPORT_STALE", 409);
    const again = await generate(fx);
    expect(again.fiscalPeriodVersion).toBe(4);
    expect((await finalize(again)).status).toBe("final");
  });

  it("checks that the period is closed before it checks staleness", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx);
    // Reopen only (no re-close): period open, version moved.
    const request = await requestPeriodReopen(
      scopedContext(),
      fx.p.id,
      { reason: "Koreksi" },
      userIdSchema.parse(requester),
    );
    await approvePeriodReopen(
      scopedContext(),
      request.id,
      { note: null },
      userIdSchema.parse(approver),
    );
    await expectCode(finalize(draft), "PERIOD_NOT_CLOSED", 409);
  });

  it("rejects a draft whose amount is not the sum of its lines (TAX_REPORT_AMOUNT_MISMATCH)", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx, lines(100));
    // Tampered draft row: amount no longer equals the line tax sum.
    await owner.query("UPDATE tax_reports SET amount_idr = 999 WHERE id = $1", [
      draft.id,
    ]);
    await expectCode(finalize(draft), "TAX_REPORT_AMOUNT_MISMATCH", 422);
    const row = await dbRow(draft.id);
    expect(row.status).toBe("draft");
    expect(row.revision_no).toBeNull();
    expect(await currentRows(fx)).toHaveLength(0);
  });

  it("a failed correction leaves the old report current and unchanged", async () => {
    const fx = await fresh();
    const rev0 = await normalFiling(fx);
    const before = await dbRow(rev0.id);
    await reopenAndReclose(fx.p);
    const draft = await generate(fx, lines(10));
    await owner.query("UPDATE tax_reports SET amount_idr = 1 WHERE id = $1", [
      draft.id,
    ]);
    await expectCode(finalize(draft, "Koreksi"), "TAX_REPORT_AMOUNT_MISMATCH");
    const after = await dbRow(rev0.id);
    expect(after.superseded_at).toBeNull();
    expect(after.version).toBe(before.version);
  });
});

describe("legend-0cnqt tax export outbox", () => {
  it("WS-07 emits one strict tax_report.exported payload for a successful export without changing the reported amount", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    const report = await normalFiling(fx);
    const before = await dbRow(report.id);

    await exportReport(report, runtime);

    const events = await exportEvents(report.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.aggregate_id).toBe(report.id);
    expect(events[0]!.event.tenantId).toBe(tenantA);
    expect(
      taxReportExportedEvent.payloadSchema.parse(events[0]!.event.payload),
    ).toEqual({
      taxReportId: report.id,
      legalEntityId: fx.entity,
      type: "pbjt",
      period: fx.p.period,
      amountIdr: report.amountIdr,
    });
    expect((await dbRow(report.id)).amount_idr).toBe(before.amount_idr);
  });

  it("WS-07 sequential export replays keep a single outbox event", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const report = await normalFiling(fx);
    const first = await exportReport(report, runtime);
    const replay = await exportReport(report, runtime);

    expect(replay.fileKey).toBe(first.fileKey);
    expect(storage.puts).toHaveLength(1);
    expect(await exportEvents(report.id)).toHaveLength(1);
  });

  it("WS-07 concurrent first exports share one file and one outbox event", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const report = await normalFiling(fx);
    const results = await Promise.all([
      exportReport(report, runtime),
      exportReport(report, runtime),
    ]);

    expect(results[0]!.fileKey).toBe(results[1]!.fileKey);
    expect(storage.puts).toHaveLength(1);
    expect(await exportEvents(report.id)).toHaveLength(1);
  });

  it("WS-07 failed uploads emit no export event; a successful retry emits one", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const report = await normalFiling(fx);
    storage.failNext = true;

    await expect(exportReport(report, runtime)).rejects.toThrow(
      "storage offline",
    );
    expect(await exportEvents(report.id)).toHaveLength(0);
    expect((await dbRow(report.id)).status).toBe("final");

    await exportReport(report, runtime);
    expect(await exportEvents(report.id)).toHaveLength(1);
  });

  it("WS-07 rejected draft export leaves no outbox event or uploaded file", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const report = await generate(fx);

    await expectCode(exportReport(report, runtime), "INVALID_TRANSITION", 409);
    expect(await exportEvents(report.id)).toHaveLength(0);
    expect(storage.puts).toHaveLength(0);
  });

  it("WS-07 an outbox insert failure rolls back export state and removes the uploaded file", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const report = await normalFiling(fx);
    const triggerName = `tax_export_outbox_failure_${unique()}`;
    try {
      // Test-only failure targets this report, leaving other exports untouched.
      await owner.query(`CREATE FUNCTION public.${triggerName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.tenant_id::text = TG_ARGV[0]
             AND NEW.aggregate_id::text = TG_ARGV[1]
             AND NEW.event->>'name' = 'tax_report.exported' THEN
            RAISE EXCEPTION 'tax export outbox unavailable';
          END IF;
          RETURN NEW;
        END $$`);
      await owner.query(`CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON domain_event_outbox FOR EACH ROW
        EXECUTE FUNCTION public.${triggerName}('${tenantA}', '${report.id}')`);

      await expect(exportReport(report, runtime)).rejects.toMatchObject({
        cause: { message: "tax export outbox unavailable" },
      });

      expect(await exportEvents(report.id)).toHaveLength(0);
      expect(await dbRow(report.id)).toMatchObject({
        status: "final",
        file_key: null,
        exported_at: null,
      });
      expect(storage.puts).toHaveLength(1);
      await expect(
        storage.get(scopedContext(), {
          tenantId: tenantA,
          outletId: null,
          key: storage.puts[0]!.key,
          reference: "verify-tax-export-cleanup",
          visibility: "private",
        }),
      ).rejects.toThrow();
    } finally {
      await owner.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON domain_event_outbox`,
      );
      await owner.query(`DROP FUNCTION IF EXISTS public.${triggerName}()`);
    }
  });

  it("WS-07 an exported original and its correction each emit one event; a superseded export emits none", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const original = await normalFiling(fx);
    await exportReport(original, runtime);
    await reopenAndReclose(fx.p);
    const correction = await file(fx, 150, "Koreksi rekap pajak");

    await expectCode(
      exportReport(original, runtime),
      "TAX_REPORT_SUPERSEDED",
      409,
    );
    expect(await exportEvents(original.id)).toHaveLength(1);
    expect(storage.puts).toHaveLength(1);

    await exportReport(correction, runtime);
    const events = await exportEvents(correction.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.payload).toMatchObject({
      taxReportId: correction.id,
      amountIdr: 150,
    });
    expect(await exportEvents(original.id)).toHaveLength(1);
    expect(storage.puts).toHaveLength(2);
  });
});

describe("legend-5nhkp export and download", () => {
  it("refuses to export a draft (INVALID_TRANSITION)", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const draft = await generate(fx);
    await expectCode(exportReport(draft, runtime), "INVALID_TRANSITION", 409);
    expect(storage.puts).toHaveLength(0);
  });

  it("exports a final report once: XML uploaded, status exported, file named with the revision", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    await close(fx.p);
    const draft = await generate(fx, lines(100, "Outlet Uji"));
    const rev0 = await finalize(draft);

    const result = await exportReport(rev0, runtime);
    expect(result.taxReportId).toBe(rev0.id);
    expect(result.fileName).toBe("coretax-pbjt-2025-01-r0.xml");
    expect(result.fileKey.length).toBeGreaterThan(0);
    expect(() => new URL(result.downloadUrl)).not.toThrow();

    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]!.tenantId).toBe(tenantA);
    expect(storage.puts[0]!.content).toContain("<");
    expect(storage.puts[0]!.content).toContain("Outlet Uji");

    const [stored] = (await list(fx)).filter((r) => r.id === rev0.id);
    expect(stored).toMatchObject({
      status: "exported",
      exportFormat: "coretax_xml",
      fileKey: result.fileKey,
      isCurrent: true,
    });
    expect(stored!.exportedAt).not.toBeNull();
  });

  it("escapes XML special characters in subject names", async () => {
    const { runtime, storage } = makeRuntime();
    const tricky = await fresh();
    await close(tricky.p);
    const draft = await generate(
      tricky,
      lines(100, `Kopi & Teh <"Spesial"> 'Uji'`),
    );
    const report = await finalize(draft);
    await exportReport(report, runtime);
    const xml = storage.puts[0]!.content;
    expect(xml).toContain("Kopi &amp; Teh &lt;");
    expect(xml).not.toContain("Kopi & Teh");
    expect(xml).not.toContain('<"Spesial">');
  });

  it("re-export returns the same file key, uploads nothing and writes nothing", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const rev0 = await normalFiling(fx);
    const first = await exportReport(rev0, runtime);
    const rowBefore = await dbRow(rev0.id);

    const second = await exportReport(rev0, runtime);
    expect(second.fileKey).toBe(first.fileKey);
    expect(second.fileName).toBe(first.fileName);
    expect(storage.puts).toHaveLength(1);
    const rowAfter = await dbRow(rev0.id);
    expect(rowAfter.file_key).toBe(rowBefore.file_key);
    expect(rowAfter.version).toBe(rowBefore.version);
    expect(rowAfter.exported_at).toEqual(rowBefore.exported_at);
  });

  it("a failed upload writes nothing, and the export can be retried", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const rev0 = await normalFiling(fx);
    storage.failNext = true;
    await expect(exportReport(rev0, runtime)).rejects.toThrow();
    const row = await dbRow(rev0.id);
    expect(row.status).toBe("final");
    expect(row.file_key).toBeNull();
    expect(row.exported_at).toBeNull();

    const retry = await exportReport(rev0, runtime);
    expect(retry.fileKey.length).toBeGreaterThan(0);
    expect((await dbRow(rev0.id)).status).toBe("exported");
  });

  it("a correction exports its own file (-r1.xml) with Coretax revision 1 in it", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const rev0 = await normalFiling(fx);
    const first = await exportReport(rev0, runtime);
    await reopenAndReclose(fx.p);
    // Identical lines, so the XML can differ only by the revision.
    const rev1 = await file(fx, 100, "Koreksi tanpa perubahan angka");
    const second = await exportReport(rev1, runtime);

    expect(second.fileName).toBe("coretax-pbjt-2025-01-r1.xml");
    expect(second.fileKey).not.toBe(first.fileKey);
    expect(storage.puts).toHaveLength(2);
    expect(storage.puts[1]!.content).not.toBe(storage.puts[0]!.content);
  });

  it("export of a superseded report is 409 TAX_REPORT_SUPERSEDED, but its old file still downloads", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const rev0 = await normalFiling(fx);
    const exported = await exportReport(rev0, runtime);
    await reopenAndReclose(fx.p);
    const rev1 = await file(fx, 150, "Koreksi");

    const error = await errorOf(exportReport(rev0, runtime));
    expect(error?.code).toBe("TAX_REPORT_SUPERSEDED");
    expect(error?.status).toBe(409);
    expect(error?.details?.supersededById).toBe(rev1.id);
    expect(storage.puts).toHaveLength(1); // never regenerated

    const old = await download(rev0.id, runtime);
    expect(old.taxReportId).toBe(rev0.id);
    expect(old.fileKey).toBe(exported.fileKey);
    expect(old.fileName).toBe("coretax-pbjt-2025-01-r0.xml");
    expect(old.revisionNo).toBe(0);
    expect(old.supersededById).toBe(rev1.id);
    expect(() => new URL(old.downloadUrl)).not.toThrow();
  });

  it("a superseded report that was never exported cannot be exported, and has no file to download", async () => {
    const fx = await fresh();
    const { runtime, storage } = makeRuntime();
    const rev0 = await normalFiling(fx);
    await reopenAndReclose(fx.p);
    const rev1 = await file(fx, 150, "Koreksi");
    await expectCode(exportReport(rev0, runtime), "TAX_REPORT_SUPERSEDED", 409);
    expect(storage.puts).toHaveLength(0);
    const error = await errorOf(download(rev0.id, runtime));
    expect([404, 409]).toContain(error?.status);
    expect((await dbRow(rev0.id)).file_key).toBeNull();
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev1.id]);
  });

  it("download of the current exported report returns its file and revision", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    const rev0 = await normalFiling(fx);
    const exported = await exportReport(rev0, runtime);
    const got = await download(rev0.id, runtime);
    expect(got.fileKey).toBe(exported.fileKey);
    expect(got.revisionNo).toBe(0);
    expect(got.supersededById).toBeNull();
  });

  it("download refuses a draft and a final report with no file, and an unknown id is 404", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    await close(fx.p);
    const draft = await generate(fx);
    expect([404, 409]).toContain(
      (await errorOf(download(draft.id, runtime)))?.status,
    );
    const rev0 = await finalize(draft);
    expect([404, 409]).toContain(
      (await errorOf(download(rev0.id, runtime)))?.status,
    );
    expect((await errorOf(download(randomUUID(), runtime)))?.status).toBe(404);
    expect(
      (await errorOf(exportReport({ id: randomUUID() }, runtime)))?.status,
    ).toBe(404);
  });
});

// ---- Follow-up (brief 2): no-change guard and finalize idempotency -----------------
//
// Assumptions:
// - NO_CHANGE compares amount and the lines as stored (JSON, key order
//   irrelevant). The fiscal period version is NOT compared: it only decides
//   staleness (legend-powk0). Lines produced with the same content but a
//   different key order therefore count as equal.
// - NO_CHANGE is checked before the correction-reason check, so a no-change
//   draft finalized WITHOUT a reason answers TAX_REPORT_NO_CHANGE, not 400.
// - A second `generate` after a draft was filed creates a new draft on the same
//   closed period (same period version): the only way to get a same-version draft.
// - A replay (same key, same report) returns an equal body; HTTP 200 itself is
//   a route concern and not asserted here.
// - IDEMPOTENCY_KEY_REUSED is the core error code (409) and is thrown by the
//   tax service with that `code`.

const keyOfReport = async (id: string) =>
  (
    await owner.query<{ k: string | null }>(
      "SELECT finalize_idempotency_key AS k FROM tax_reports WHERE id = $1",
      [id],
    )
  ).rows[0]!.k;

const finalizeWithKey = (
  report: { id: string },
  idempotencyKey: string,
  correctionReason?: string,
) =>
  finalizeTaxReport(
    scopedContext(),
    actor(),
    report.id as never,
    {
      idempotencyKey,
      ...(correctionReason === undefined ? {} : { correctionReason }),
    } as never,
  );

/** The same line with its keys in reverse order (equal as JSON content). */
const reorderKeys = (rows: TaxReportLine[]): TaxReportLine[] =>
  rows.map(
    (row) =>
      Object.fromEntries(
        Object.entries(row as unknown as Record<string, unknown>).reverse(),
      ) as unknown as TaxReportLine,
  );

describe("legend-5nhkp finalize: no-change guard", () => {
  it("rejects a draft identical to the current report (same period version, lines, amount) with 409 TAX_REPORT_NO_CHANGE", async () => {
    const fx = await fresh();
    await close(fx.p);
    const same = lines(100);
    const rev0 = await finalize(await generate(fx, same));
    const draft = await generate(fx, same); // same closed period version
    expect(draft.id).not.toBe(rev0.id);
    expect(draft.fiscalPeriodVersion).toBe(rev0.fiscalPeriodVersion);

    const before = await dbRow(draft.id);
    const oldBefore = await dbRow(rev0.id);
    await expectCode(
      finalize(draft, "Tidak ada perubahan"),
      "TAX_REPORT_NO_CHANGE",
      409,
    );

    // Nothing written: the draft stays a draft, the current report is untouched.
    const after = await dbRow(draft.id);
    expect(after.status).toBe("draft");
    expect(after.revision_no).toBeNull();
    expect(after.version).toBe(before.version);
    expect(await keyOfReport(draft.id)).toBeNull();
    const oldAfter = await dbRow(rev0.id);
    expect(oldAfter.superseded_at).toBeNull();
    expect(oldAfter.version).toBe(oldBefore.version);
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev0.id]);
  });

  it("answers NO_CHANGE before it asks for a correction reason", async () => {
    const fx = await fresh();
    await close(fx.p);
    const same = lines(100);
    await finalize(await generate(fx, same));
    const draft = await generate(fx, same);
    await expectCode(finalize(draft), "TAX_REPORT_NO_CHANGE", 409);
    expect((await dbRow(draft.id)).status).toBe("draft");
  });

  it("also guards a current report that was already exported", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    await close(fx.p);
    const same = lines(100);
    const rev0 = await finalize(await generate(fx, same));
    await exportReport(rev0, runtime);
    const draft = await generate(fx, same);
    await expectCode(finalize(draft, "Cek"), "TAX_REPORT_NO_CHANGE", 409);
    expect((await dbRow(rev0.id)).status).toBe("exported");
  });

  it("treats lines with the same content in another key order as unchanged", async () => {
    const fx = await fresh();
    await close(fx.p);
    const same = lines(100);
    await finalize(await generate(fx, same));
    const draft = await generate(fx, reorderKeys(same));
    await expectCode(finalize(draft, "Cek"), "TAX_REPORT_NO_CHANGE", 409);
  });

  it("treats an old stored line (no warnings, 'Peringatan:' reference) as unchanged against its new-shape draft", async () => {
    const fx = await fresh();
    await close(fx.p);
    const warning = "Pajak non-PBJT Rp2000 tidak ikut";
    const withWarning = (): TaxReportLine[] =>
      lines(100).map(
        (row) =>
          ({
            ...row,
            references: ["INV-001"],
            warnings: [warning],
          }) as unknown as TaxReportLine,
      );
    const newShape = withWarning();
    const rev0 = await finalize(await generate(fx, newShape));
    // Rewrite the stored row the way an old report looked.
    const legacy = newShape.map((row) => {
      const legacyRow = { ...row } as Record<string, unknown>;
      delete legacyRow.warnings;
      return {
        ...legacyRow,
        references: ["INV-001", `Peringatan: ${warning}`],
      };
    });
    // The filed-report guard blocks edits to a final row; seed the legacy
    // shape with triggers off, in one transaction.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "UPDATE tax_reports SET lines = $2::jsonb WHERE id = $1",
        [rev0.id, JSON.stringify(legacy)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const draft = await generate(fx, newShape);
    await expectCode(finalize(draft, "Cek"), "TAX_REPORT_NO_CHANGE", 409);
    // The stored row is left as it was.
    const stored = (
      await owner.query<{ lines: { references: string[] }[] }>(
        "SELECT lines FROM tax_reports WHERE id = $1",
        [rev0.id],
      )
    ).rows[0]!;
    expect(stored.lines[0]!.references).toContain(`Peringatan: ${warning}`);
  });

  it("treats an old stored line without a warnings field as unchanged", async () => {
    const fx = await fresh();
    await close(fx.p);
    const same = lines(100);
    const rev0 = await finalize(await generate(fx, same));
    const draft = await generate(
      fx,
      same.map((row) => ({ ...row, warnings: [] }) as unknown as TaxReportLine),
    );
    expect(rev0.status).toBe("final");
    await expectCode(finalize(draft, "Cek"), "TAX_REPORT_NO_CHANGE", 409);
  });

  it("allows a correction with the same period version when the amount changed", async () => {
    const fx = await fresh();
    await close(fx.p);
    const rev0 = await finalize(await generate(fx, lines(100)));
    const draft = await generate(fx, lines(150));
    expect(draft.fiscalPeriodVersion).toBe(rev0.fiscalPeriodVersion);
    const rev1 = await finalize(draft, "Koreksi payroll");
    expect(rev1.revisionNo).toBe(1);
    expect(rev1.supersedesId).toBe(rev0.id);
    expect(rev1.amountIdr).toBe(150);
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev1.id]);
  });

  it("allows a correction with the same period version and amount when only the lines changed", async () => {
    const fx = await fresh();
    await close(fx.p);
    const rev0 = await finalize(await generate(fx, lines(100, "Outlet A")));
    // Same total (100), different subject: lines differ, amount and version equal.
    const draft = await generate(fx, lines(100, "Outlet B"));
    expect(draft.amountIdr).toBe(rev0.amountIdr);
    const rev1 = await finalize(draft, "Outlet salah");
    expect(rev1.revisionNo).toBe(1);
    expect(rev1.supersedesId).toBe(rev0.id);
  });

  it("a changed correction still needs its reason (400), and the draft stays a draft", async () => {
    const fx = await fresh();
    await close(fx.p);
    await finalize(await generate(fx, lines(100)));
    const draft = await generate(fx, lines(150));
    await expectCode(
      finalize(draft),
      "TAX_REPORT_CORRECTION_REASON_REQUIRED",
      400,
    );
    expect((await dbRow(draft.id)).status).toBe("draft");
  });

  it("refuses a correction after reopen and re-close when lines and amount are identical (409 TAX_REPORT_NO_CHANGE)", async () => {
    const fx = await fresh();
    const same = lines(100);
    await close(fx.p);
    const rev0 = await finalize(await generate(fx, same));
    await reopenAndReclose(fx.p); // period version 2 -> 4
    const draft = await generate(fx, same);
    expect(draft.fiscalPeriodVersion).toBe(4);
    expect(rev0.fiscalPeriodVersion).toBe(2);

    await expectCode(
      finalize(draft, "Periode dibuka dan ditutup ulang"),
      "TAX_REPORT_NO_CHANGE",
      409,
    );
    expect((await dbRow(draft.id)).status).toBe("draft");
    expect((await dbRow(rev0.id)).superseded_at).toBeNull();
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev0.id]);
  });

  it("allows a correction after reopen and re-close when the amount changed", async () => {
    const fx = await fresh();
    await close(fx.p);
    const rev0 = await finalize(await generate(fx, lines(100)));
    await reopenAndReclose(fx.p);
    const draft = await generate(fx, lines(150));
    expect(draft.fiscalPeriodVersion).toBe(4);
    const rev1 = await finalize(draft, "Periode dibuka dan ditutup ulang");
    expect(rev1.revisionNo).toBe(1);
    expect(rev1.supersedesId).toBe(rev0.id);
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev1.id]);
  });

  it("compares against the current report only: a draft equal to an older, superseded revision is a change", async () => {
    const fx = await fresh();
    const original = lines(100);
    await close(fx.p);
    await finalize(await generate(fx, original));
    await reopenAndReclose(fx.p);
    const rev1 = await finalize(await generate(fx, lines(150)), "Naik");
    // Back to the first lines on the same period version as rev1: differs from
    // the CURRENT report (150), so it is a valid correction.
    const draft = await generate(fx, original);
    expect(draft.fiscalPeriodVersion).toBe(rev1.fiscalPeriodVersion);
    const rev2 = await finalize(draft, "Kembali ke angka awal");
    expect(rev2.revisionNo).toBe(2);
    expect(rev2.supersedesId).toBe(rev1.id);
  });

  it("the very first filing is never a no-change case", async () => {
    const fx = await fresh();
    await close(fx.p);
    const rev0 = await finalize(await generate(fx, lines(100)));
    expect(rev0.revisionNo).toBe(0);
  });
});

describe("legend-5nhkp finalize: idempotency key", () => {
  it("stores the key on the report when the draft becomes final, never on a draft", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx);
    expect(await keyOfReport(draft.id)).toBeNull();
    const key = `fin-${randomUUID()}`;
    await finalizeWithKey(draft, key);
    expect(await keyOfReport(draft.id)).toBe(key);
  });

  it("replaying the same key on the same report returns the same finalized report", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx);
    const key = `fin-${randomUUID()}`;
    const first = await finalizeWithKey(draft, key);
    const rowBefore = await dbRow(draft.id);

    const replay = await finalizeWithKey(draft, key);
    expect(replay).toEqual(first);
    expect(replay.status).toBe("final");
    expect(replay.revisionNo).toBe(0);

    // The replay wrote nothing.
    const rowAfter = await dbRow(draft.id);
    expect(rowAfter.version).toBe(rowBefore.version);
    expect(await currentRows(fx)).toHaveLength(1);
  });

  it("a replay of a correction returns that correction, not NO_CHANGE or INVALID_TRANSITION", async () => {
    const fx = await fresh();
    await close(fx.p);
    const rev0 = await finalize(await generate(fx, lines(100)));
    const draft = await generate(fx, lines(150));
    const key = `fin-${randomUUID()}`;
    const rev1 = await finalizeWithKey(draft, key, "Koreksi");
    const oldBefore = await dbRow(rev0.id);

    const replay = await finalizeWithKey(draft, key, "Koreksi");
    expect(replay).toEqual(rev1);
    expect(replay.revisionNo).toBe(1);
    expect(replay.supersedesId).toBe(rev0.id);
    expect((await currentRows(fx)).map((r) => r.id)).toEqual([rev1.id]);
    expect((await dbRow(rev0.id)).version).toBe(oldBefore.version);
  });

  it("a replay still works after the report was exported", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    await close(fx.p);
    const draft = await generate(fx);
    const key = `fin-${randomUUID()}`;
    const first = await finalizeWithKey(draft, key);
    await exportReport(first, runtime);
    const replay = await finalizeWithKey(draft, key);
    expect(replay.id).toBe(first.id);
    expect((await dbRow(first.id)).status).toBe("exported");
  });

  it("two concurrent finalizes with the same key on one report both succeed with the same report", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx);
    const key = `fin-${randomUUID()}`;
    const [a, b] = await Promise.all([
      finalizeWithKey(draft, key),
      finalizeWithKey(draft, key),
    ]);
    expect(a.id).toBe(draft.id);
    expect(b).toEqual(a);
    expect(await currentRows(fx)).toHaveLength(1);
  });

  it("the same key for a different report is 409 IDEMPOTENCY_KEY_REUSED and writes nothing", async () => {
    const first = await fresh();
    await close(first.p);
    const key = `fin-${randomUUID()}`;
    await finalizeWithKey(await generate(first), key);

    const second = await fresh();
    await close(second.p);
    const other = await generate(second);
    const before = await dbRow(other.id);
    await expectCode(
      finalizeWithKey(other, key),
      "IDEMPOTENCY_KEY_REUSED",
      409,
    );
    const after = await dbRow(other.id);
    expect(after.status).toBe("draft");
    expect(after.version).toBe(before.version);
    expect(await keyOfReport(other.id)).toBeNull();
    expect(await currentRows(second)).toHaveLength(0);

    // With a fresh key the same draft finalizes normally.
    expect((await finalize(other)).status).toBe("final");
  });

  it("a different key on an already final report is still INVALID_TRANSITION", async () => {
    const fx = await fresh();
    await close(fx.p);
    const draft = await generate(fx);
    const key = `fin-${randomUUID()}`;
    await finalizeWithKey(draft, key);
    await expectCode(
      finalizeWithKey(draft, `fin-${randomUUID()}`),
      "INVALID_TRANSITION",
      409,
    );
    expect(await keyOfReport(draft.id)).toBe(key);
  });

  it("a different key on an exported report is still INVALID_TRANSITION", async () => {
    const fx = await fresh();
    const { runtime } = makeRuntime();
    const rev0 = await normalFiling(fx);
    await exportReport(rev0, runtime);
    await expectCode(
      finalizeWithKey(rev0, `fin-${randomUUID()}`),
      "INVALID_TRANSITION",
      409,
    );
  });

  it("a failed finalize (no change) does not consume its key", async () => {
    const fx = await fresh();
    await close(fx.p);
    const same = lines(100);
    await finalize(await generate(fx, same));
    const draft = await generate(fx, same);
    const key = `fin-${randomUUID()}`;
    await expectCode(
      finalizeWithKey(draft, key, "Cek"),
      "TAX_REPORT_NO_CHANGE",
      409,
    );
    expect(await keyOfReport(draft.id)).toBeNull();

    // The same key is free for a real change on another report.
    const fx2 = await fresh();
    await close(fx2.p);
    const ok = await finalizeWithKey(await generate(fx2), key);
    expect(ok.status).toBe("final");
  });
});

describe("legend-5nhkp contract", () => {
  it("maps TAX_REPORT_NO_CHANGE to 409", () => {
    expect(accountingErrorHttpStatus.TAX_REPORT_NO_CHANGE).toBe(409);
  });

  it("maps the new error codes to the agreed HTTP statuses", () => {
    expect(accountingErrorHttpStatus.TAX_REPORT_SUPERSEDED).toBe(409);
    expect(accountingErrorHttpStatus.TAX_REPORT_STALE).toBe(409);
    expect(
      accountingErrorHttpStatus.TAX_REPORT_CORRECTION_REASON_REQUIRED,
    ).toBe(400);
    expect(accountingErrorHttpStatus.TAX_REPORT_SOURCE_UNAVAILABLE).toBe(422);
    expect(accountingErrorHttpStatus.TAX_REPORT_AMOUNT_MISMATCH).toBe(422);
    expect(accountingErrorHttpStatus.TAX_REPORT_NOT_FOUND).toBe(404);
  });
});
