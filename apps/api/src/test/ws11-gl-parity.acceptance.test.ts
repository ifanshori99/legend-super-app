// WS-11 acceptance: money metrics must equal the general ledger (I1), carry
// the right finality (I2, SH-02), respect outlet scope (TEN-03), and never let a
// shareholder see personal splits (SH-01). Dashboard and report read the same
// query path (DASH-02), so one endpoint is exercised: GET /api/metrics/query.
//
// Written from PRD v1.7 (DASH-02, SH-01, SH-02), the sub-brief invariants and the
// public contract `metricQueryResponseSchema`; the implementation was not read.
//
// ASSUMPTIONS (the contract does not pin these down; each lives in one place):
// - Wire encoding of the GET request is a qs-style query string built from
//   `metricQueryRequestSchema` (`period[startDate]=..`, `metricCodes[0]=..`).
//   Change only `queryMetrics()` if the real endpoint encodes differently.
//   `packages/shared/src/metrics/endpoints.ts` did not exist when this was written.
// - Account roles: `net_sales` = credit minus debit on report_group `revenue`
//   accounts (sales_revenue and the contra sales_discount, which is net of
//   discount per the metric description); `cogs` = debit minus credit on
//   report_group `cogs`; `gross_profit` = net_sales - cogs. The GL oracle below
//   uses the same rule over journal_lines, so it is the ledger, not raw orders.
// - Finality: a range wholly inside closed accounting periods is `final`. A
//   range in a month that is still open and not yet over is `estimate`. Only
//   `gross_profit` (closed_period_only) is asserted `estimate` for a past
//   month whose accounting period is open: for `live` metrics the catalog allows
//   a closed calendar bucket to be final, so that case is not asserted.
// - Failure statuses: unknown metric 404 (METRIC_NOT_FOUND), official-only on a
//   period that is not closed 409 (PERIOD_NOT_CLOSED), unauthenticated 401,
//   missing permission 403. A shareholder asking for a personal split is any
//   4xx (400 or 403); the body must not leak the split.
// - A scoped user asking for an outlet outside the scope gets 403, or a 200
//   that carries none of that outlet's money (server intersects with scope).
// - A period with no journal lines returns null values (or no points), never 0.
//
// Every run builds its own tenant (outlets, legal entity, chart, journals), so
// concurrent suites never touch these numbers. Journal rows are append-only and
// stay in the disposable database until the run ends.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
} from "@starter/shared/accounting";
import { metricQueryResponseSchema } from "@starter/shared/metrics";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import { agent, signUp, setRole, verifySessionMfa } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const METRICS_QUERY_PATH = "/api/metrics/query";

type Client = ReturnType<typeof agent>;
type Viewer = { client: Client; userId: string };

let app: Express;
let tenantId: string;
let hostname: string;
let entityId: string;
let outlet1: string;
let outlet2: string;

let ownerViewer: Viewer;
let shareholderViewer: Viewer;
let outlet1Viewer: Viewer;

const accounts = {
  cash: randomUUID(),
  inventory: randomUUID(),
  revenue: randomUUID(),
  discount: randomUUID(),
  cogs: randomUUID(),
};

const CLOSED_MONTH = "2025-06";
const OPEN_PAST_MONTH = "2025-07";
const EMPTY_MONTH_START = "2024-01-01";
const EMPTY_MONTH_END = "2024-01-31";

const now = new Date();
const CURRENT_MONTH = now.toISOString().slice(0, 7);
const CURRENT_MONTH_START = `${CURRENT_MONTH}-01`;
const CURRENT_MONTH_END = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
)
  .toISOString()
  .slice(0, 10);

// ---- Helpers ----------------------------------------------------------------

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function line(
  accountId: string,
  debit: number,
  credit: number,
  outletId: string,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletId as JournalLineInput["outletId"],
    costCenter: null,
  };
}

async function postEntry(
  date: string,
  outletId: string,
  description: string,
  lines: JournalLineInput[],
) {
  const context = scopedContext();
  await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId: entityId,
      outletId,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description,
      lines,
      postedBy: null,
      idempotencyKey: `ws11-parity-${randomUUID()}`,
    }),
  );
}

async function sale(date: string, outletId: string, amount: number) {
  await postEntry(date, outletId, "Penjualan (uji paritas GL)", [
    line(accounts.cash, amount, 0, outletId),
    line(accounts.revenue, 0, amount, outletId),
  ]);
}

async function discount(date: string, outletId: string, amount: number) {
  await postEntry(date, outletId, "Diskon (uji paritas GL)", [
    line(accounts.discount, amount, 0, outletId),
    line(accounts.cash, 0, amount, outletId),
  ]);
}

async function cogsEntry(date: string, outletId: string, amount: number) {
  await postEntry(date, outletId, "HPP (uji paritas GL)", [
    line(accounts.cogs, amount, 0, outletId),
    line(accounts.inventory, 0, amount, outletId),
  ]);
}

async function createPeriod(period: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, entityId, period],
  );
  return rows[0]!.id;
}

/**
 * The ledger oracle: balances read straight from journal_lines (the GL), by
 * account report group, for the date range and optional outlet.
 */
async function ledger(
  range: { start: string; end: string },
  outletId?: string,
) {
  const { rows } = await owner.query<{
    revenue: string;
    cogs: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN a.report_group = 'revenue'
                    THEN l.credit_idr - l.debit_idr END), 0)::text AS revenue,
       COALESCE(SUM(CASE WHEN a.report_group = 'cogs'
                    THEN l.debit_idr - l.credit_idr END), 0)::text AS cogs
     FROM journal_lines l
     JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
     JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
     WHERE l.tenant_id = $1 AND e.legal_entity_id = $2
       AND e.entry_date BETWEEN $3 AND $4
       AND ($5::uuid IS NULL OR l.outlet_id = $5::uuid)`,
    [tenantId, entityId, range.start, range.end, outletId ?? null],
  );
  const netSales = Number(rows[0]!.revenue);
  const cogs = Number(rows[0]!.cogs);
  return { netSales, cogs, grossProfit: netSales - cogs };
}

type QueryInput = {
  metricCodes: string[];
  period: { startDate: string; endDate: string };
  bucket?: string;
  outletIds?: string[];
  groupBy?: string;
  comparePrevious?: boolean;
  requireFinal?: boolean;
};

/** The only place that knows how the request is encoded on the wire. */
function queryMetrics(viewer: Viewer | null, input: QueryInput) {
  const client = viewer?.client ?? agent(app);
  return client.get(METRICS_QUERY_PATH).set("Host", hostname).query(input);
}

function parsed(body: unknown) {
  return metricQueryResponseSchema.parse(body);
}

/** Total-bucket point of a metric series (no dimension). */
function totalPoint(body: unknown, metricCode: string) {
  const series = parsed(body).data.series.find(
    (entry) => entry.metricCode === metricCode && entry.dimension === null,
  );
  expect(series, `series for ${metricCode}`).toBeDefined();
  expect(series!.points).toHaveLength(1);
  return series!.points[0]!;
}

function idrOf(point: { value: unknown }): number {
  const value = point.value as { unit: string; valueIdr: number } | null;
  expect(value, "point has a value").not.toBeNull();
  expect(value!.unit).toBe("idr");
  return value!.valueIdr;
}

const MONEY = ["net_sales", "cogs", "gross_profit"];

async function viewerWithRole(input: {
  roleId: string;
  scopeType: "tenant" | "outlet";
  scopeId?: string;
  label: string;
}): Promise<Viewer> {
  const client = agent(app);
  const email = await signUp(client, input.label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      input.roleId,
      input.scopeType,
      input.scopeType === "tenant" ? null : (input.scopeId ?? null),
    ],
  );
  await verifySessionMfa(email);
  return { client, userId };
}

async function insertRole(input: {
  name: string;
  templateKey: string | null;
  permissions: string[];
  scopes: string[];
}): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
    [
      roleId,
      tenantId,
      input.name,
      input.templateKey !== null,
      input.templateKey,
      JSON.stringify(input.permissions),
      JSON.stringify(input.scopes),
    ],
  );
  return roleId;
}

// ---- World ------------------------------------------------------------------

beforeAll(async () => {
  app = createApp();
  const tenant = await createIsolatedTenant(`ws11-${randomUUID().slice(0, 6)}`);
  tenantId = tenant.tenantId;
  hostname = tenant.hostname;
  entityId = tenant.legalEntityId;
  outlet1 = tenant.outletId;
  outlet2 = randomUUID();
  const brand = await owner.query<{ brand_id: string }>(
    "SELECT brand_id FROM outlets WHERE id = $1",
    [outlet1],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $3, address, timezone, opening_hours, status
     FROM outlets WHERE id = $4`,
    [
      outlet2,
      `OUT2-${randomUUID().slice(0, 6)}`.toUpperCase(),
      "Outlet Dua",
      outlet1,
    ],
  );
  expect(brand.rows).toHaveLength(1);

  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $6, $7, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $6, $7, '1301', 'Persediaan', 'asset', 'current_asset'),
            ($3, $6, $7, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($4, $6, $7, '4201', 'Diskon penjualan', 'revenue', 'revenue'),
            ($5, $6, $7, '5101', 'Harga pokok penjualan', 'expense', 'cogs')`,
    [
      accounts.cash,
      accounts.inventory,
      accounts.revenue,
      accounts.discount,
      accounts.cogs,
      tenantId,
      entityId,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3),
            ($1, $2, 'sales_discount', $4),
            ($1, $2, 'cogs', $5),
            ($1, $2, 'inventory', $6)
     ON CONFLICT DO NOTHING`,
    [
      tenantId,
      entityId,
      accounts.revenue,
      accounts.discount,
      accounts.cogs,
      accounts.inventory,
    ],
  );

  const closedPeriodId = await createPeriod(CLOSED_MONTH);
  await createPeriod(OPEN_PAST_MONTH);
  await createPeriod(CURRENT_MONTH);

  // Closed month (2025-06): outlet 1 and outlet 2 sell, outlet 1 gives a
  // discount later in the month, so [06-01..06-15] has no discount at all.
  await sale("2025-06-10", outlet1, 1_000_000);
  await cogsEntry("2025-06-10", outlet1, 300_000);
  await sale("2025-06-11", outlet2, 400_000);
  await cogsEntry("2025-06-11", outlet2, 120_000);
  await discount("2025-06-20", outlet1, 50_000);
  // Past month that stays open (2025-07).
  await sale("2025-07-05", outlet1, 500_000);
  await cogsEntry("2025-07-05", outlet1, 150_000);
  // Current month, not over yet: first day of the month, outlet 2.
  await sale(CURRENT_MONTH_START, outlet2, 200_000);
  await cogsEntry(CURRENT_MONTH_START, outlet2, 80_000);

  await closeFiscalPeriod(
    scopedContext(),
    closedPeriodId,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(randomUUID()),
  );

  const financial = [
    "dashboard.owner.view",
    "dashboard.management.view",
    "report.operational.view",
    "report.sales.view",
    "report.financial.view",
    "report.aggregate.view",
  ];
  const ownerRole = await insertRole({
    name: "Owner uji metrik",
    templateKey: null,
    permissions: financial,
    scopes: ["tenant", "brand"],
  });
  const shareholderRole = await insertRole({
    name: "Shareholder",
    templateKey: "shareholder",
    permissions: ["dashboard.shareholder.view", "report.aggregate.view"],
    scopes: ["tenant"],
  });
  const outletRole = await insertRole({
    name: "Manajer outlet uji metrik",
    templateKey: null,
    permissions: financial,
    scopes: ["outlet"],
  });
  ownerViewer = await viewerWithRole({
    roleId: ownerRole,
    scopeType: "tenant",
    label: "Owner Metrik",
  });
  shareholderViewer = await viewerWithRole({
    roleId: shareholderRole,
    scopeType: "tenant",
    label: "Shareholder Metrik",
  });
  outlet1Viewer = await viewerWithRole({
    roleId: outletRole,
    scopeType: "outlet",
    scopeId: outlet1,
    label: "Manajer Outlet 1",
  });
});

afterAll(async () => {
  await owner.end();
});

// ---- DASH-02 + I1: parity with the general ledger ----------------------------

describe("DASH-02 / I1: money metrics equal the general ledger", () => {
  it("net sales, HPP and gross profit of a closed period equal the GL balances", async () => {
    // No discount posted inside 06-01..06-15, so only revenue and COGS count.
    const range = { start: "2025-06-01", end: "2025-06-15" };
    const gl = await ledger(range);
    expect(gl).toEqual({
      netSales: 1_400_000,
      cogs: 420_000,
      grossProfit: 980_000,
    });

    const response = await queryMetrics(ownerViewer, {
      metricCodes: MONEY,
      period: { startDate: range.start, endDate: range.end },
    });
    expect(response.status).toBe(200);
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(gl.netSales);
    expect(idrOf(totalPoint(response.body, "cogs"))).toBe(gl.cogs);
    expect(idrOf(totalPoint(response.body, "gross_profit"))).toBe(
      gl.grossProfit,
    );
  });

  it("net sales is net of the discount posted to the ledger", async () => {
    const range = { start: "2025-06-01", end: "2025-06-30" };
    const gl = await ledger(range);
    expect(gl.netSales).toBe(1_350_000);

    const response = await queryMetrics(ownerViewer, {
      metricCodes: MONEY,
      period: { startDate: range.start, endDate: range.end },
    });
    expect(response.status).toBe(200);
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(gl.netSales);
    expect(idrOf(totalPoint(response.body, "cogs"))).toBe(gl.cogs);
    expect(idrOf(totalPoint(response.body, "gross_profit"))).toBe(
      gl.grossProfit,
    );
  });

  it("a single outlet filter equals the GL balance of that outlet", async () => {
    const range = { start: "2025-06-01", end: "2025-06-30" };
    const gl = await ledger(range, outlet1);
    expect(gl.netSales).toBe(950_000);

    const response = await queryMetrics(ownerViewer, {
      metricCodes: MONEY,
      period: { startDate: range.start, endDate: range.end },
      outletIds: [outlet1],
    });
    expect(response.status).toBe(200);
    expect(parsed(response.body).data.outletFilter).toEqual({
      kind: "outlets",
      outletIds: [outlet1],
    });
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(gl.netSales);
    expect(idrOf(totalPoint(response.body, "cogs"))).toBe(gl.cogs);
    expect(idrOf(totalPoint(response.body, "gross_profit"))).toBe(
      gl.grossProfit,
    );
  });

  it("daily points add up to the total for the same period and filter", async () => {
    // Dashboard tile (total) and report (daily rows) must agree (DASH-02).
    const period = { startDate: "2025-06-01", endDate: "2025-06-30" };
    const total = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period,
    });
    const daily = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period,
      bucket: "day",
    });
    expect(total.status).toBe(200);
    expect(daily.status).toBe(200);
    const series = parsed(daily.body).data.series.find(
      (entry) => entry.metricCode === "net_sales" && entry.dimension === null,
    );
    expect(series).toBeDefined();
    const sum = series!.points.reduce(
      (acc, point) => (point.value === null ? acc : acc + idrOf(point)),
      0,
    );
    expect(sum).toBe(idrOf(totalPoint(total.body, "net_sales")));
  });

  it("asking for one metric alone gives the same figure as asking with others", async () => {
    const period = { startDate: "2025-06-01", endDate: "2025-06-30" };
    const alone = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period,
    });
    const together = await queryMetrics(ownerViewer, {
      metricCodes: MONEY,
      period,
    });
    expect(idrOf(totalPoint(alone.body, "net_sales"))).toBe(
      idrOf(totalPoint(together.body, "net_sales")),
    );
  });

  it("a period with no journal lines gives no figure instead of zero", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period: { startDate: EMPTY_MONTH_START, endDate: EMPTY_MONTH_END },
    });
    expect(response.status).toBe(200);
    for (const series of parsed(response.body).data.series)
      for (const point of series.points) expect(point.value).toBeNull();
  });

  it("compares with the previous period when asked", async () => {
    // July is the month after the closed June; its previous period is June.
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-07-01", endDate: "2025-07-31" },
      comparePrevious: true,
    });
    expect(response.status).toBe(200);
    const point = totalPoint(response.body, "net_sales");
    expect(idrOf(point)).toBe(500_000);
    expect(point.comparison).not.toBeNull();
    const june = await ledger({ start: "2025-06-01", end: "2025-06-30" });
    expect(point.comparison!.previousValue).toEqual({
      unit: "idr",
      valueIdr: june.netSales,
    });
  });
});

// ---- SH-02 + I2: final vs estimate ------------------------------------------

describe("SH-02 / I2: closed periods are final, running periods are estimates", () => {
  it("labels a closed accounting period as final", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: MONEY,
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    expect(response.status).toBe(200);
    const data = parsed(response.body).data;
    expect(data.period.accountingPeriodClosed).toBe(true);
    for (const code of MONEY)
      expect(totalPoint(response.body, code).finality).toBe("final");
  });

  it("labels the running month as estimate", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: MONEY,
      period: { startDate: CURRENT_MONTH_START, endDate: CURRENT_MONTH_END },
    });
    expect(response.status).toBe(200);
    expect(parsed(response.body).data.period.accountingPeriodClosed).toBe(
      false,
    );
    for (const code of MONEY)
      expect(totalPoint(response.body, code).finality).toBe("estimate");
    // Figures still come from the ledger.
    const gl = await ledger({
      start: CURRENT_MONTH_START,
      end: CURRENT_MONTH_END,
    });
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(gl.netSales);
  });

  it("keeps gross profit an estimate while its accounting period is open", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["gross_profit"],
      period: { startDate: "2025-07-01", endDate: "2025-07-31" },
    });
    expect(response.status).toBe(200);
    expect(parsed(response.body).data.period.accountingPeriodClosed).toBe(
      false,
    );
    expect(totalPoint(response.body, "gross_profit").finality).toBe("estimate");
  });

  it("does not call a range final when it only partly lies in closed periods", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["gross_profit"],
      period: { startDate: "2025-06-15", endDate: "2025-07-15" },
    });
    expect(response.status).toBe(200);
    expect(parsed(response.body).data.period.accountingPeriodClosed).toBe(
      false,
    );
    expect(totalPoint(response.body, "gross_profit").finality).toBe("estimate");
  });

  it("official-only request on a closed period returns final figures", async () => {
    const response = await queryMetrics(shareholderViewer, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
      requireFinal: true,
    });
    expect(response.status).toBe(200);
    const point = totalPoint(response.body, "net_sales");
    expect(point.finality).toBe("final");
    expect(idrOf(point)).toBe(
      (await ledger({ start: "2025-06-01", end: "2025-06-30" })).netSales,
    );
  });

  it("official-only request on a period that is not closed is refused, not estimated", async () => {
    const response = await queryMetrics(shareholderViewer, {
      metricCodes: ["gross_profit"],
      period: { startDate: "2025-07-01", endDate: "2025-07-31" },
      requireFinal: true,
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain("PERIOD_NOT_CLOSED");
    // No estimate figure leaks in the refusal.
    expect(JSON.stringify(response.body)).not.toContain("500000");
  });
});

// ---- SH-01: shareholder sees aggregates only ---------------------------------

describe("SH-01: a shareholder sees aggregates, never personal splits", () => {
  it("can read aggregate money figures equal to the ledger", async () => {
    const response = await queryMetrics(shareholderViewer, {
      metricCodes: MONEY,
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    expect(response.status).toBe(200);
    const gl = await ledger({ start: "2025-06-01", end: "2025-06-30" });
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(gl.netSales);
    expect(idrOf(totalPoint(response.body, "gross_profit"))).toBe(
      gl.grossProfit,
    );
  });

  it.each(["employee", "customer", "member"])(
    "refuses a split per %s",
    async (groupBy) => {
      const response = await queryMetrics(shareholderViewer, {
        metricCodes: ["net_sales"],
        period: { startDate: "2025-06-01", endDate: "2025-06-30" },
        groupBy,
      });
      expect([400, 403]).toContain(response.status);
      // A refusal carries no money figures.
      expect(JSON.stringify(response.body)).not.toContain("valueIdr");
    },
  );
});

// ---- TEN-03: outlet scope ---------------------------------------------------

describe("outlet scope is enforced on money metrics", () => {
  it("an outlet-scoped user without an outlet filter gets only their outlet", async () => {
    const response = await queryMetrics(outlet1Viewer, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    expect(response.status).toBe(200);
    const gl = await ledger(
      { start: "2025-06-01", end: "2025-06-30" },
      outlet1,
    );
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(gl.netSales);
    expect(gl.netSales).not.toBe(
      (await ledger({ start: "2025-06-01", end: "2025-06-30" })).netSales,
    );
  });

  it("an outlet-scoped user cannot read another outlet", async () => {
    const response = await queryMetrics(outlet1Viewer, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-11", endDate: "2025-06-11" },
      outletIds: [outlet2],
    });
    // Outlet 2 sold 400000 on that day; none of it may reach this user.
    if (response.status === 200) {
      const series = parsed(response.body).data.series;
      for (const entry of series)
        for (const point of entry.points)
          if (point.value !== null) expect(idrOf(point)).not.toBe(400_000);
    } else {
      expect(response.status).toBe(403);
    }
    expect(JSON.stringify(response.body)).not.toContain("400000");
  });

  it("another tenant's ledger never reaches this tenant's figures", async () => {
    // The seeded Cafe Legend tenant has its own ledger; this isolated tenant's
    // numbers are exactly the seeded rows above, so the whole-tenant total of
    // closed June equals only this tenant's GL.
    const other = cafeLegendPlatformFixtures.tenant.id as string;
    expect(other).not.toBe(tenantId);
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    expect(idrOf(totalPoint(response.body, "net_sales"))).toBe(1_350_000);
  });
});

// ---- Error and access states ------------------------------------------------

describe("error states", () => {
  it("answers 401 to an anonymous caller", async () => {
    const response = await queryMetrics(null, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    expect(response.status).toBe(401);
  });

  it("answers 404 for an unknown metric code", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["metrik_tidak_ada"],
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain("METRIC_NOT_FOUND");
  });

  it("rejects a period whose start is after its end", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: ["net_sales"],
      period: { startDate: "2025-06-30", endDate: "2025-06-01" },
    });
    // Project convention: every ZodError maps to 422 VALIDATION_ERROR
    // (apps/api/src/middleware/error-handler.ts).
    expect(response.status).toBe(422);
  });

  it("rejects a request without any metric code", async () => {
    const response = await queryMetrics(ownerViewer, {
      metricCodes: [],
      period: { startDate: "2025-06-01", endDate: "2025-06-30" },
    });
    // Project convention: every ZodError maps to 422 VALIDATION_ERROR
    // (apps/api/src/middleware/error-handler.ts).
    expect(response.status).toBe(422);
  });
});
