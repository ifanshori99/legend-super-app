// Financial statement endpoints (bead legend-yc96u; PRD v1.7 §3.19 "Laporan
// Keuangan" and "Tutup Periode"; ACC-02, ACC-03, TEN-01, TEN-03). Real Express
// app, Better Auth and PostgreSQL on the disposable test database.
//
//   GET /api/accounting/statements/trial-balance     ?legalEntityId&asOf
//   GET /api/accounting/statements/balance-sheet     ?legalEntityId&asOf
//   GET /api/accounting/statements/profit-and-loss   ?legalEntityId&from&to[&outletId]
//   GET /api/accounting/statements/cash-flow         ?legalEntityId&from&to
//   GET /api/accounting/statements/equity-changes    ?legalEntityId&from&to
//
// Expected values come from the PRD and the shared contract (endpoints.ts
// response schemas, statement-basis rules), never from the handler code. Every
// response is also parsed with the shared endpoint schema.
//
// Ledger used by most tests (IDR), one legal entity per scenario:
//   2025-01-05 modal injection  Dr Kas 1,000,000 / Cr Modal 1,000,000
//   2025-01-10 sale (outlet A)  Dr Kas   300,000 / Cr Penjualan 300,000
//   2025-01-15 expense (A)      Dr Beban 100,000 / Cr Kas 100,000
//   2025-02-03 sale (outlet B)  Dr Kas   200,000 / Cr Penjualan 200,000
//   2025-02-10 equipment        Dr Peralatan 400,000 / Cr Kas 400,000
//   2025-02-12 expense (B)      Dr Beban  50,000 / Cr Kas  50,000
//   => cash 1,200,000 at Jan 31 and 950,000 at Feb 28; profit Jan 200,000,
//      Feb 150,000 (cumulative 350,000); equity at Feb 28 = 1,350,000.
//
// Assumptions (the spec does not pin these down):
// - Cash flow is the direct method; a cash movement is classified by the other
//   side of the entry: sales and expenses are operating, a non-current asset is
//   investing, an equity or non-current liability account is financing. Rows
//   labels are not asserted, only the section totals. A section with no
//   movement may be omitted or present with 0 (`activityTotal` treats both as 0).
// - Equity changes: one row per equity account plus the "Laba periode
//   berjalan" row (accountId null). Its opening is the cumulative profit before
//   `from`, its profit the profit in [from, to]; the closing of all rows adds
//   up to the balance sheet's total equity at `to`. A credit to an equity
//   account that is not profit is asserted only through opening and closing
//   (whether it lands in otherMovements is not pinned down).
// - A legal entity of another tenant, or an unknown id, is 404 (like the
//   accounts route). Bad query input is 422 (ZodError); from > to is 400 or 422.
// - Status of a fiscal period without a row counts as open, so the basis is
//   `live` (statement-basis.ts).
// - Closed periods are closed with the real close service (snapshot taken) except in
//   the "earlier month still open" test, which flips the status in SQL (as
//   accounting-core.test.ts does) and asserts only the basis fields there.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  getBalanceSheet,
  getCashFlow,
  getEquityChanges,
  getProfitAndLoss,
  getTrialBalance,
  type JournalLineInput,
} from "@starter/shared/accounting";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  getBalanceSheet as getBalanceSheetService,
  getCashFlow as getCashFlowService,
  getEquityChanges as getEquityChangesService,
  getProfitAndLoss as getProfitAndLossService,
  getTrialBalance as getTrialBalanceService,
} from "../services/accounting-statements.service";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const outletB = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");

const closer = randomUUID();
const requester = randomUUID();
const approver = randomUUID();

const PATHS = {
  tb: "/api/accounting/statements/trial-balance",
  bs: "/api/accounting/statements/balance-sheet",
  pl: "/api/accounting/statements/profit-and-loss",
  cf: "/api/accounting/statements/cash-flow",
  eq: "/api/accounting/statements/equity-changes",
} as const;

const scopedContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

const outletScopedContext = (...outlets: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outlets.map((id) => outletIdSchema.parse(id)),
    },
  );

// ---- Users -----------------------------------------------------------------

type Client = ReturnType<typeof agent>;

async function userWithTemplate(
  name: string,
  templateKey: string | null,
): Promise<Client> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  if (templateKey) {
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantId, templateKey],
    );
    if (!rows[0]) throw new Error(`No ${templateKey} role template`);
    await owner.query(
      // Backdated one minute: the container clock can drift from Node's clock.
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
      [tenantId, userId, rows[0].id],
    );
  }
  return client;
}

// ---- Ledger fixtures ---------------------------------------------------------

type Ledger = {
  entity: string;
  acc: Record<"kas" | "alat" | "modal" | "jual" | "beban", string>;
};

async function makeLedger(tenant: string = tenantId): Promise<Ledger> {
  const entity = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [entity, tenant, `Statements ${unique()}`],
  );
  const acc = {
    kas: randomUUID(),
    alat: randomUUID(),
    modal: randomUUID(),
    jual: randomUUID(),
    beban: randomUUID(),
  };
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $6, $7, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $6, $7, '1501', 'Peralatan', 'asset', 'non_current_asset'),
            ($3, $6, $7, '3101', 'Modal Disetor', 'equity', 'equity'),
            ($4, $6, $7, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($5, $6, $7, '6101', 'Beban Operasional', 'expense', 'operating_expense')`,
    [acc.kas, acc.alat, acc.modal, acc.jual, acc.beban, tenant, entity],
  );
  return { entity, acc };
}

function line(
  accountId: string,
  debit: number,
  credit: number,
  outlet: string | null,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outlet === null ? null : outletIdSchema.parse(outlet),
    costCenter: null,
  };
}

function post(
  ledger: Ledger,
  date: string,
  lines: JournalLineInput[],
  outlet: string | null,
) {
  const context = scopedContext();
  return withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId: ledger.entity,
      outletId: outlet === null ? null : outletIdSchema.parse(outlet),
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale",
      sourceId: randomUUID(),
      description: "Uji laporan keuangan",
      lines,
      postedBy: null,
      idempotencyKey: `stmt-${randomUUID()}`,
    }),
  );
}

/** The ledger described in the header comment. */
async function seed(ledger: Ledger) {
  const { kas, alat, modal, jual, beban } = ledger.acc;
  await post(
    ledger,
    "2025-01-05",
    [line(kas, 1_000_000, 0, null), line(modal, 0, 1_000_000, null)],
    null,
  );
  await post(
    ledger,
    "2025-01-10",
    [line(kas, 300_000, 0, outletA), line(jual, 0, 300_000, outletA)],
    outletA,
  );
  await post(
    ledger,
    "2025-01-15",
    [line(beban, 100_000, 0, outletA), line(kas, 0, 100_000, outletA)],
    outletA,
  );
  await post(
    ledger,
    "2025-02-03",
    [line(kas, 200_000, 0, outletB), line(jual, 0, 200_000, outletB)],
    outletB,
  );
  await post(
    ledger,
    "2025-02-10",
    [line(alat, 400_000, 0, null), line(kas, 0, 400_000, null)],
    null,
  );
  await post(
    ledger,
    "2025-02-12",
    [line(beban, 50_000, 0, outletB), line(kas, 0, 50_000, outletB)],
    outletB,
  );
}

async function periodId(ledger: Ledger, period: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
    [tenantId, ledger.entity, period],
  );
  if (!rows[0]) throw new Error(`No fiscal period ${period}`);
  return rows[0].id;
}

async function closePeriod(ledger: Ledger, period: string, version?: number) {
  const id = await periodId(ledger, period);
  const current =
    version ??
    (
      await owner.query<{ version: number }>(
        "SELECT version FROM fiscal_periods WHERE id = $1",
        [id],
      )
    ).rows[0]!.version;
  return closeFiscalPeriod(
    scopedContext(),
    id,
    { expectedVersion: current, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
}

async function reopenPeriod(ledger: Ledger, period: string) {
  const id = await periodId(ledger, period);
  const request = await requestPeriodReopen(
    scopedContext(),
    id,
    { reason: "Koreksi laporan" },
    userIdSchema.parse(requester),
  );
  return approvePeriodReopen(
    scopedContext(),
    request.id,
    { note: null },
    userIdSchema.parse(approver),
  );
}

// ---- Requests --------------------------------------------------------------

function getStatement(
  client: Client,
  path: string,
  query: Record<string, string>,
) {
  return client.get(`${path}?${new URLSearchParams(query)}`);
}

const asOfQuery = (l: Ledger, asOf: string) => ({
  legalEntityId: l.entity,
  asOf,
});
const rangeQuery = (l: Ledger, from: string, to: string) => ({
  legalEntityId: l.entity,
  from,
  to,
});

function body(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

async function trialBalance(client: Client, l: Ledger, asOf: string) {
  return getTrialBalance.response.parse(
    body(await getStatement(client, PATHS.tb, asOfQuery(l, asOf))),
  ).data;
}
async function balanceSheet(client: Client, l: Ledger, asOf: string) {
  return getBalanceSheet.response.parse(
    body(await getStatement(client, PATHS.bs, asOfQuery(l, asOf))),
  ).data;
}
async function profitAndLoss(
  client: Client,
  l: Ledger,
  from: string,
  to: string,
  outletId?: string,
) {
  return getProfitAndLoss.response.parse(
    body(
      await getStatement(client, PATHS.pl, {
        ...rangeQuery(l, from, to),
        ...(outletId ? { outletId } : {}),
      }),
    ),
  ).data;
}
async function cashFlow(client: Client, l: Ledger, from: string, to: string) {
  return getCashFlow.response.parse(
    body(await getStatement(client, PATHS.cf, rangeQuery(l, from, to))),
  ).data;
}
async function equityChanges(
  client: Client,
  l: Ledger,
  from: string,
  to: string,
) {
  return getEquityChanges.response.parse(
    body(await getStatement(client, PATHS.eq, rangeQuery(l, from, to))),
  ).data;
}

type Sectioned = { sections: { activity: string; totalIdr: number }[] };
const activityTotal = (cf: Sectioned, activity: string) =>
  cf.sections.find((section) => section.activity === activity)?.totalIdr ?? 0;

type PlLike = {
  sections: { group: string; totalIdr: number }[];
  netProfitIdr: number;
};
const groupTotal = (statement: PlLike, group: string) =>
  statement.sections.find((section) => section.group === group)?.totalIdr ?? 0;

// ---- Suite -----------------------------------------------------------------

let finance: Client;
let cashier: Client;
let nobody: Client;
let live: Ledger; // nothing closed
let closedJan: Ledger; // January closed with the real service
let closedBoth: Ledger; // January and February closed with the real service
let febOnly: Ledger; // February closed in SQL while January is still open
let empty: Ledger; // no journal lines at all

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await userWithTemplate("Statements finance", "finance");
  cashier = await userWithTemplate("Statements cashier", "cashier");
  nobody = await userWithTemplate("Statements nobody", null);
  [live, closedJan, closedBoth, febOnly, empty] = await Promise.all([
    makeLedger(),
    makeLedger(),
    makeLedger(),
    makeLedger(),
    makeLedger(),
  ]);
  await seed(live);
  await seed(closedJan);
  await seed(closedBoth);
  await seed(febOnly);
  await closePeriod(closedJan, "2025-01");
  await closePeriod(closedBoth, "2025-01");
  await closePeriod(closedBoth, "2025-02");
  await owner.query(
    `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2025-02'`,
    [tenantId, febOnly.entity, createdUserIds[0]],
  );
});

afterAll(async () => {
  if (otherTenantIds.length > 0) {
    await owner.query(
      "DELETE FROM chart_of_accounts WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query(
      "DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-yc96u trial balance", () => {
  it("lists each account's net on its debit or credit side and balances", async () => {
    const tb = await trialBalance(finance, live, "2025-02-28");
    const byCode = Object.fromEntries(tb.rows.map((row) => [row.code, row]));
    expect(byCode["1101"]).toMatchObject({ debitIdr: 950_000, creditIdr: 0 });
    expect(byCode["1501"]).toMatchObject({ debitIdr: 400_000, creditIdr: 0 });
    expect(byCode["3101"]).toMatchObject({
      debitIdr: 0,
      creditIdr: 1_000_000,
    });
    expect(byCode["4101"]).toMatchObject({ debitIdr: 0, creditIdr: 500_000 });
    expect(byCode["6101"]).toMatchObject({ debitIdr: 150_000, creditIdr: 0 });
    expect(tb.totalDebitIdr).toBe(1_500_000);
    expect(tb.totalCreditIdr).toBe(1_500_000);
    expect(tb.legalEntityId).toBe(live.entity);
    expect(tb.asOf).toBe("2025-02-28");
  });

  it("is cumulative: as-of January excludes February, as-of February includes January", async () => {
    const jan = await trialBalance(finance, live, "2025-01-31");
    const byCode = Object.fromEntries(jan.rows.map((row) => [row.code, row]));
    expect(byCode["1101"]).toMatchObject({ debitIdr: 1_200_000 });
    expect(byCode["1501"]).toBeUndefined(); // equipment bought in February
    expect(byCode["4101"]).toMatchObject({ creditIdr: 300_000 });
    expect(jan.totalDebitIdr).toBe(1_300_000);
    expect(jan.totalCreditIdr).toBe(1_300_000);

    const mid = await trialBalance(finance, live, "2025-02-05");
    expect(
      Object.fromEntries(mid.rows.map((r) => [r.code, r]))["1101"],
    ).toMatchObject(
      { debitIdr: 1_400_000 }, // Jan 1,200,000 + Feb 3 sale 200,000
    );
  });

  it("empty ledger: no rows, zero totals, live basis for the as-of month", async () => {
    const tb = await trialBalance(finance, empty, "2025-02-28");
    expect(tb.rows).toEqual([]);
    expect(tb.totalDebitIdr).toBe(0);
    expect(tb.totalCreditIdr).toBe(0);
    expect(tb.basis).toBe("live");
    expect(tb.periodKeys).toEqual(["2025-02"]);
    expect(tb.closedPeriodKeys).toEqual([]);
  });

  it("another legal entity's journal never shows up (entity isolation)", async () => {
    const tb = await trialBalance(finance, empty, "2025-12-31");
    expect(tb.rows).toEqual([]);
  });
});

describe("legend-yc96u balance sheet", () => {
  it("assets equal liabilities + equity, with current earnings under equity", async () => {
    const bs = await balanceSheet(finance, live, "2025-02-28");
    expect(bs.totalAssetsIdr).toBe(1_350_000);
    expect(bs.totalLiabilitiesIdr).toBe(0);
    expect(bs.currentEarningsIdr).toBe(350_000);
    expect(bs.totalEquityIdr).toBe(1_350_000);
    expect(bs.totalAssetsIdr).toBe(bs.totalLiabilitiesIdr + bs.totalEquityIdr);
    const cash = bs.sections.find((s) => s.group === "cash_and_equivalents");
    expect(cash?.totalIdr).toBe(950_000);
    const fixed = bs.sections.find((s) => s.group === "non_current_asset");
    expect(fixed?.totalIdr).toBe(400_000);
  });

  it("is cumulative from the first journal: January figures at Jan 31, no February", async () => {
    const bs = await balanceSheet(finance, live, "2025-01-31");
    expect(bs.totalAssetsIdr).toBe(1_200_000);
    expect(bs.currentEarningsIdr).toBe(200_000);
    expect(bs.totalEquityIdr).toBe(1_200_000);
  });

  it("empty ledger: all zero and still balanced", async () => {
    const bs = await balanceSheet(finance, empty, "2025-02-28");
    expect(bs.totalAssetsIdr).toBe(0);
    expect(bs.totalLiabilitiesIdr).toBe(0);
    expect(bs.totalEquityIdr).toBe(0);
    expect(bs.currentEarningsIdr).toBe(0);
  });
});

describe("legend-yc96u profit and loss", () => {
  it("is non-cumulative: only the requested range, with gross, operating and net profit", async () => {
    const jan = await profitAndLoss(finance, live, "2025-01-01", "2025-01-31");
    expect(groupTotal(jan, "revenue")).toBe(300_000);
    expect(groupTotal(jan, "operating_expense")).toBe(100_000);
    expect(jan.grossProfitIdr).toBe(300_000);
    expect(jan.operatingProfitIdr).toBe(200_000);
    expect(jan.netProfitIdr).toBe(200_000);
    expect(jan.outletId).toBeNull();

    const feb = await profitAndLoss(finance, live, "2025-02-01", "2025-02-28");
    expect(groupTotal(feb, "revenue")).toBe(200_000);
    expect(feb.netProfitIdr).toBe(150_000);

    const both = await profitAndLoss(finance, live, "2025-01-01", "2025-02-28");
    expect(both.netProfitIdr).toBe(350_000);
  });

  it("per outlet counts only lines tagged with that outlet (ACC-03)", async () => {
    const a = await profitAndLoss(
      finance,
      live,
      "2025-01-01",
      "2025-02-28",
      outletA,
    );
    expect(a.outletId).toBe(outletA);
    expect(groupTotal(a, "revenue")).toBe(300_000);
    expect(a.netProfitIdr).toBe(200_000);
    const b = await profitAndLoss(
      finance,
      live,
      "2025-01-01",
      "2025-02-28",
      outletB,
    );
    expect(b.outletId).toBe(outletB);
    expect(groupTotal(b, "revenue")).toBe(200_000);
    expect(b.netProfitIdr).toBe(150_000);
  });

  it("empty ledger: zero profit", async () => {
    const pl = await profitAndLoss(finance, empty, "2025-01-01", "2025-02-28");
    expect(pl.netProfitIdr).toBe(0);
    expect(pl.grossProfitIdr).toBe(0);
  });
});

describe("legend-yc96u cash flow (direct method)", () => {
  it("February: opening cash from January, operating and investing movements, closing = balance sheet cash", async () => {
    const cf = await cashFlow(finance, live, "2025-02-01", "2025-02-28");
    expect(cf.method).toBe("direct");
    expect(cf.openingCashIdr).toBe(1_200_000);
    expect(activityTotal(cf, "operating")).toBe(150_000);
    expect(activityTotal(cf, "investing")).toBe(-400_000);
    expect(activityTotal(cf, "financing")).toBe(0);
    expect(cf.netChangeIdr).toBe(-250_000);
    expect(cf.closingCashIdr).toBe(950_000);
    const bs = await balanceSheet(finance, live, "2025-02-28");
    const cash = bs.sections.find((s) => s.group === "cash_and_equivalents");
    expect(cf.closingCashIdr).toBe(cash?.totalIdr);
  });

  it("January: starts from zero, owner capital is financing", async () => {
    const cf = await cashFlow(finance, live, "2025-01-01", "2025-01-31");
    expect(cf.openingCashIdr).toBe(0);
    expect(activityTotal(cf, "operating")).toBe(200_000);
    expect(activityTotal(cf, "financing")).toBe(1_000_000);
    expect(activityTotal(cf, "investing")).toBe(0);
    expect(cf.closingCashIdr).toBe(1_200_000);
  });

  it("empty ledger: zero opening, change and closing", async () => {
    const cf = await cashFlow(finance, empty, "2025-02-01", "2025-02-28");
    expect(cf.openingCashIdr).toBe(0);
    expect(cf.netChangeIdr).toBe(0);
    expect(cf.closingCashIdr).toBe(0);
  });

  it("has no per-outlet view: an outletId query is rejected", async () => {
    const response = await getStatement(finance, PATHS.cf, {
      ...rangeQuery(live, "2025-02-01", "2025-02-28"),
      outletId: outletA,
    });
    expect(response.status).toBe(422);
  });
});

describe("legend-yc96u equity changes", () => {
  it("February: capital unchanged, current earnings roll forward from January", async () => {
    const eq = await equityChanges(finance, live, "2025-02-01", "2025-02-28");
    const modal = eq.rows.find((row) => row.accountId === live.acc.modal);
    expect(modal).toMatchObject({
      openingIdr: 1_000_000,
      closingIdr: 1_000_000,
    });
    const earnings = eq.rows.find((row) => row.accountId === null);
    expect(earnings).toMatchObject({
      label: "Laba periode berjalan",
      openingIdr: 200_000,
      profitIdr: 150_000,
      closingIdr: 350_000,
    });
    const bs = await balanceSheet(finance, live, "2025-02-28");
    expect(eq.rows.reduce((sum, row) => sum + row.closingIdr, 0)).toBe(
      bs.totalEquityIdr,
    );
  });

  it("January: capital goes from 0 to 1,000,000 and profit 200,000", async () => {
    const eq = await equityChanges(finance, live, "2025-01-01", "2025-01-31");
    const modal = eq.rows.find((row) => row.accountId === live.acc.modal);
    expect(modal).toMatchObject({ openingIdr: 0, closingIdr: 1_000_000 });
    const earnings = eq.rows.find((row) => row.accountId === null);
    expect(earnings).toMatchObject({
      openingIdr: 0,
      profitIdr: 200_000,
      closingIdr: 200_000,
    });
  });

  it("empty ledger: nothing moves", async () => {
    const eq = await equityChanges(finance, empty, "2025-02-01", "2025-02-28");
    for (const row of eq.rows) {
      expect(row.openingIdr).toBe(0);
      expect(row.closingIdr).toBe(0);
    }
  });

  it("has no per-outlet view: an outletId query is rejected", async () => {
    const response = await getStatement(finance, PATHS.eq, {
      ...rangeQuery(live, "2025-02-01", "2025-02-28"),
      outletId: outletA,
    });
    expect(response.status).toBe(422);
  });
});

describe("legend-yc96u data basis: closed_snapshot vs live", () => {
  it("no fiscal period closed: every statement is live and lists the months it covers", async () => {
    const tb = await trialBalance(finance, live, "2025-02-28");
    expect(tb).toMatchObject({
      basis: "live",
      periodKeys: ["2025-02"],
      closedPeriodKeys: [],
    });
    const pl = await profitAndLoss(finance, live, "2025-01-01", "2025-02-28");
    expect(pl).toMatchObject({
      basis: "live",
      periodKeys: ["2025-01", "2025-02"],
      closedPeriodKeys: [],
    });
    expect((await balanceSheet(finance, live, "2025-02-28")).basis).toBe(
      "live",
    );
    expect(
      (await cashFlow(finance, live, "2025-02-01", "2025-02-28")).basis,
    ).toBe("live");
    expect(
      (await equityChanges(finance, live, "2025-02-01", "2025-02-28")).basis,
    ).toBe("live");
  });

  it("January closed: statements up to January are closed_snapshot with the same figures", async () => {
    const tb = await trialBalance(finance, closedJan, "2025-01-31");
    expect(tb).toMatchObject({
      basis: "closed_snapshot",
      periodKeys: ["2025-01"],
      closedPeriodKeys: ["2025-01"],
    });
    expect(tb.totalDebitIdr).toBe(1_300_000);
    const bs = await balanceSheet(finance, closedJan, "2025-01-31");
    expect(bs.basis).toBe("closed_snapshot");
    expect(bs.totalAssetsIdr).toBe(1_200_000);
    const pl = await profitAndLoss(
      finance,
      closedJan,
      "2025-01-01",
      "2025-01-31",
    );
    expect(pl.basis).toBe("closed_snapshot");
    expect(pl.netProfitIdr).toBe(200_000);
    const cf = await cashFlow(finance, closedJan, "2025-01-01", "2025-01-31");
    expect(cf.basis).toBe("closed_snapshot");
    expect(cf.closingCashIdr).toBe(1_200_000);
    const eq = await equityChanges(
      finance,
      closedJan,
      "2025-01-01",
      "2025-01-31",
    );
    expect(eq.basis).toBe("closed_snapshot");
  });

  it("the open February makes a statement that reaches into it live, even though January is closed", async () => {
    const tb = await trialBalance(finance, closedJan, "2025-02-28");
    expect(tb).toMatchObject({
      basis: "live",
      periodKeys: ["2025-02"],
      closedPeriodKeys: [],
    });
    expect(tb.totalDebitIdr).toBe(1_500_000);
    const pl = await profitAndLoss(
      finance,
      closedJan,
      "2025-01-01",
      "2025-02-28",
    );
    expect(pl).toMatchObject({
      basis: "live",
      periodKeys: ["2025-01", "2025-02"],
      closedPeriodKeys: ["2025-01"],
    });
    expect(pl.netProfitIdr).toBe(350_000);
  });

  it("both months closed: closed_snapshot across the whole range, cumulative statements included", async () => {
    const bs = await balanceSheet(finance, closedBoth, "2025-02-28");
    expect(bs.basis).toBe("closed_snapshot");
    expect(bs.totalAssetsIdr).toBe(1_350_000);
    expect(bs.currentEarningsIdr).toBe(350_000);
    const cf = await cashFlow(finance, closedBoth, "2025-02-01", "2025-02-28");
    expect(cf).toMatchObject({
      basis: "closed_snapshot",
      periodKeys: ["2025-02"],
      closedPeriodKeys: ["2025-02"],
      openingCashIdr: 1_200_000,
      closingCashIdr: 950_000,
    });
    const pl = await profitAndLoss(
      finance,
      closedBoth,
      "2025-01-01",
      "2025-02-28",
    );
    expect(pl).toMatchObject({
      basis: "closed_snapshot",
      closedPeriodKeys: ["2025-01", "2025-02"],
    });
    expect(pl.netProfitIdr).toBe(350_000);
  });

  it("a range that reaches a month with no fiscal period is live", async () => {
    const pl = await profitAndLoss(
      finance,
      closedBoth,
      "2025-01-01",
      "2025-03-31",
    );
    expect(pl.basis).toBe("live");
    expect(pl.closedPeriodKeys).toEqual(["2025-01", "2025-02"]);
    expect(pl.netProfitIdr).toBe(350_000);
  });

  it("cumulative statements are live while an earlier month is still open; profit and loss is not", async () => {
    // February is closed, January is open (no snapshot for either).
    const tb = await trialBalance(finance, febOnly, "2025-02-28");
    expect(tb).toMatchObject({
      basis: "live",
      periodKeys: ["2025-02"],
      closedPeriodKeys: ["2025-02"],
    });
    expect(tb.totalDebitIdr).toBe(1_500_000);
    expect((await balanceSheet(finance, febOnly, "2025-02-28")).basis).toBe(
      "live",
    );
    expect(
      (await cashFlow(finance, febOnly, "2025-02-01", "2025-02-28")).basis,
    ).toBe("live");
    expect(
      (await equityChanges(finance, febOnly, "2025-02-01", "2025-02-28")).basis,
    ).toBe("live");
    // Profit and loss for February alone depends on February only.
    const pl = await profitAndLoss(
      finance,
      febOnly,
      "2025-02-01",
      "2025-02-28",
    );
    expect(pl.basis).toBe("closed_snapshot");
    expect(pl.closedPeriodKeys).toEqual(["2025-02"]);
  });

  it("reopening a closed month drops the label to live and shows the new posting, not the stale snapshot; closing again freezes the new figures", async () => {
    const ledger = await makeLedger();
    await seed(ledger);
    await closePeriod(ledger, "2025-01");
    const before = await trialBalance(finance, ledger, "2025-01-31");
    expect(before.basis).toBe("closed_snapshot");
    expect(before.totalDebitIdr).toBe(1_300_000);

    const approved = await reopenPeriod(ledger, "2025-01");
    await post(
      ledger,
      "2025-01-20",
      [
        line(ledger.acc.kas, 50_000, 0, outletA),
        line(ledger.acc.jual, 0, 50_000, outletA),
      ],
      outletA,
    );

    const reopened = await trialBalance(finance, ledger, "2025-01-31");
    expect(reopened).toMatchObject({ basis: "live", closedPeriodKeys: [] });
    expect(reopened.totalDebitIdr).toBe(1_350_000);
    const pl = await profitAndLoss(finance, ledger, "2025-01-01", "2025-01-31");
    expect(pl.basis).toBe("live");
    expect(pl.netProfitIdr).toBe(250_000);

    await closePeriod(ledger, "2025-01", approved.period.version);
    const after = await trialBalance(finance, ledger, "2025-01-31");
    expect(after.basis).toBe("closed_snapshot");
    expect(after.totalDebitIdr).toBe(1_350_000);
    const plAfter = await profitAndLoss(
      finance,
      ledger,
      "2025-01-01",
      "2025-01-31",
    );
    expect(plAfter.basis).toBe("closed_snapshot");
    expect(plAfter.netProfitIdr).toBe(250_000);
  });
});

describe("legend-yc96u tenant isolation and permission", () => {
  async function foreignEntity(): Promise<string> {
    const other = randomUUID();
    otherTenantIds.push(other);
    // Copy a valid plan/limits row so unrelated tenant parsers keep working.
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Statements other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [other, `stmt-${unique()}`, tenantId],
    );
    const entity = randomUUID();
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Statements foreign entity')",
      [entity, other],
    );
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, '1101', 'Kas Rahasia Tenant Lain', 'asset', 'cash_and_equivalents')`,
      [randomUUID(), other, entity],
    );
    return entity;
  }

  it("a legal entity of another tenant is 404 on every statement and leaks nothing", async () => {
    const entity = await foreignEntity();
    const queries: [string, Record<string, string>][] = [
      [PATHS.tb, { legalEntityId: entity, asOf: "2025-02-28" }],
      [PATHS.bs, { legalEntityId: entity, asOf: "2025-02-28" }],
      [
        PATHS.pl,
        { legalEntityId: entity, from: "2025-01-01", to: "2025-02-28" },
      ],
      [
        PATHS.cf,
        { legalEntityId: entity, from: "2025-01-01", to: "2025-02-28" },
      ],
      [
        PATHS.eq,
        { legalEntityId: entity, from: "2025-01-01", to: "2025-02-28" },
      ],
    ];
    for (const [path, query] of queries) {
      const response = await getStatement(finance, path, query);
      expect(response.status, path).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("Rahasia");
    }
  });

  it("an unknown legal entity id is 404", async () => {
    const response = await getStatement(finance, PATHS.tb, {
      legalEntityId: randomUUID(),
      asOf: "2025-02-28",
    });
    expect(response.status).toBe(404);
  });

  it("anonymous callers get 401 on every statement", async () => {
    const anonymous = agent(app);
    for (const [path, query] of [
      [PATHS.tb, asOfQuery(live, "2025-02-28")],
      [PATHS.bs, asOfQuery(live, "2025-02-28")],
      [PATHS.pl, rangeQuery(live, "2025-01-01", "2025-02-28")],
      [PATHS.cf, rangeQuery(live, "2025-01-01", "2025-02-28")],
      [PATHS.eq, rangeQuery(live, "2025-01-01", "2025-02-28")],
    ] as const) {
      expect((await getStatement(anonymous, path, query)).status, path).toBe(
        401,
      );
    }
  });

  it("without accounting.journal.view (cashier, or no role) every statement is 403", async () => {
    for (const client of [cashier, nobody]) {
      for (const [path, query] of [
        [PATHS.tb, asOfQuery(live, "2025-02-28")],
        [PATHS.bs, asOfQuery(live, "2025-02-28")],
        [PATHS.pl, rangeQuery(live, "2025-01-01", "2025-02-28")],
        [PATHS.cf, rangeQuery(live, "2025-01-01", "2025-02-28")],
        [PATHS.eq, rangeQuery(live, "2025-01-01", "2025-02-28")],
      ] as const) {
        const response = await getStatement(client, path, query);
        expect(response.status, path).toBe(403);
        expect(JSON.stringify(response.body)).not.toContain("1101");
      }
    }
  });
});

describe("legend-yc96u TEN-03 outlet scope", () => {
  const entity = () => live.entity;

  it("entity-wide statements are refused (403) for an outlet-scoped caller", async () => {
    const context = outletScopedContext(outletA);
    const legalEntityId = entity();
    const range = { legalEntityId, from: "2025-01-01", to: "2025-02-28" };
    const calls = [
      () =>
        getTrialBalanceService(context, { legalEntityId, asOf: "2025-02-28" }),
      () =>
        getBalanceSheetService(context, { legalEntityId, asOf: "2025-02-28" }),
      () => getCashFlowService(context, range),
      () => getEquityChangesService(context, range),
      () => getProfitAndLossService(context, range),
    ];
    for (const call of calls)
      await expect(call()).rejects.toMatchObject({
        code: "OUTLET_OUT_OF_SCOPE",
      });
  });

  it("profit and loss by outlet needs that outlet in scope", async () => {
    const legalEntityId = entity();
    const range = { legalEntityId, from: "2025-01-01", to: "2025-02-28" };
    const home = await getProfitAndLossService(outletScopedContext(outletA), {
      ...range,
      outletId: outletA,
    });
    expect(home.outletId).toBe(outletA);
    await expect(
      getProfitAndLossService(outletScopedContext(outletA), {
        ...range,
        outletId: outletB,
      }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
  });

  it("a tenant-scope caller still reads every statement", async () => {
    const context = scopedContext();
    const legalEntityId = entity();
    const range = { legalEntityId, from: "2025-01-01", to: "2025-02-28" };
    await getTrialBalanceService(context, {
      legalEntityId,
      asOf: "2025-02-28",
    });
    await getCashFlowService(context, range);
    await getProfitAndLossService(context, { ...range, outletId: outletB });
  });
});

describe("legend-yc96u query validation", () => {
  it("rejects a missing legal entity, a bad date and unknown parameters with 422 (project ZodError status)", async () => {
    expect(
      (await getStatement(finance, PATHS.tb, { asOf: "2025-02-28" })).status,
    ).toBe(422);
    expect(
      (
        await getStatement(finance, PATHS.bs, {
          legalEntityId: live.entity,
          asOf: "2025-13-40",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await getStatement(finance, PATHS.pl, {
          legalEntityId: live.entity,
          from: "2025-01-01",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await getStatement(finance, PATHS.tb, {
          ...asOfQuery(live, "2025-02-28"),
          tenantId: randomUUID(),
        })
      ).status,
    ).toBe(422);
  });

  it("profit and loss with from after to is refused (400 or 422)", async () => {
    const response = await getStatement(
      finance,
      PATHS.pl,
      rangeQuery(live, "2025-02-28", "2025-02-01"),
    );
    expect([400, 422]).toContain(response.status);
  });
});
