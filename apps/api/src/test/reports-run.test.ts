// Fail-first tests for the report catalog, run and preview endpoints (WS-11
// foundation, bead legend-5wzoc; contract: docs/briefs/sub-ws11-foundation-design.md
// §2.2 and §2.6, endpoints in packages/shared/src/dashboard/endpoints.ts).
//
// Written from the contract only; `routes/reports.routes.ts` and
// `services/report-run.service.ts` do not exist yet, so these fail until the
// foundation lands (every request answers 404 from the router today).
// Everything goes over HTTP so the permission and outlet-scope rules of the
// route are part of what is pinned.
//
// ASSUMPTIONS (the contract does not pin these down; each lives in one place):
// - Wire format: POST bodies are JSON (`reportRunInputSchema`,
//   `reportBuilderQuerySchema`); GET /api/reports takes `limit`/`cursor`.
//   Tenant is picked by the Host header, as in ws11-gl-parity.acceptance.test.ts.
// - Failure statuses: unauthenticated 401, missing report permission 403,
//   unknown report 404 REPORT_NOT_FOUND, a group-by a report does not declare
//   at all 4xx (the contract says 400; the project maps zod errors to 422, so
//   either is accepted).
// - An outlet-scoped caller asking for an outlet outside the scope gets 403, or
//   a 200 that carries none of that outlet's money (same assumption as the
//   GL parity suite).
// - A caller holding none of the report permissions gets 403 or an empty
//   catalog, never another family's reports.
// - "No data" for a period without journal lines: either no rows or every
//   cell null, never 0 (same assumption as the GL parity suite).
// - Metrics with no source use `finance.pending_settlement`
//   (pending_settlement; cash_balance moved to the ledger in F6, legend-qlirp).
//   When a family card builds that source, repoint
//   UNBUILT_REPORT / UNBUILT_METRIC at a metric that is still unbuilt.
// - Ledger numbers are asserted for `net_sales`, `cogs` and `gross_profit`
//   only: net sales = revenue credit minus debit (discount is a contra
//   revenue account), cogs = cogs debit minus credit.
//
// Every run builds its own two tenants (outlets, legal entity, chart, journals,
// users), so concurrent suites never touch these numbers.

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
import { reportResultSchema, reportCatalog } from "@starter/shared/dashboard";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type Client = ReturnType<typeof agent>;
type Viewer = { client: Client; host: string };

type World = {
  tenantId: string;
  host: string;
  entityId: string;
  outlet1: string;
  outlet2: string;
  accounts: Record<
    "cash" | "inventory" | "revenue" | "discount" | "cogs",
    string
  >;
  full: Viewer; // all report permissions, tenant scope
  outletManager: Viewer; // all report permissions, outlet1 only
  salesOnly: Viewer; // report.sales.view only
  shareholder: Viewer; // report.aggregate.view only
  nobody: Viewer; // no report permission
};

const FINANCIAL = [
  "dashboard.owner.view",
  "dashboard.management.view",
  "report.operational.view",
  "report.sales.view",
  "report.financial.view",
  "report.aggregate.view",
];

const INCOME_STATEMENT = "finance.income_statement"; // GL metrics, outlet split
const UNBUILT_REPORT = "finance.pending_settlement";
const UNBUILT_METRIC = "pending_settlement";
const JUNE = { startDate: "2025-06-01", endDate: "2025-06-30" };
const EMPTY = { startDate: "2024-01-01", endDate: "2024-01-31" };

let app: Express;
let a: World;
let b: World;
let c: World; // books of June 2025 are closed

// ---- Helpers ----------------------------------------------------------------

function context(w: World): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenantId),
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

async function post(
  w: World,
  date: string,
  outletId: string,
  lines: JournalLineInput[],
) {
  const ctx = context(w);
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: w.entityId,
      outletId,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji laporan",
      lines,
      postedBy: null,
      idempotencyKey: `reports-run-${randomUUID()}`,
    }),
  );
}

const sale = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.cash, amount, 0, outlet),
    line(w.accounts.revenue, 0, amount, outlet),
  ]);
const discount = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.discount, amount, 0, outlet),
    line(w.accounts.cash, 0, amount, outlet),
  ]);
const cogs = (w: World, date: string, outlet: string, amount: number) =>
  post(w, date, outlet, [
    line(w.accounts.cogs, amount, 0, outlet),
    line(w.accounts.inventory, 0, amount, outlet),
  ]);

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
  scopes: string[],
  templateKey: string | null = null,
): Promise<string> {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
    [
      roleId,
      tenantId,
      name,
      templateKey !== null,
      templateKey,
      JSON.stringify(permissions),
      JSON.stringify(scopes),
    ],
  );
  return roleId;
}

async function viewerWithRole(input: {
  tenantId: string;
  host: string;
  roleId: string | null;
  scopeType: "tenant" | "outlet";
  scopeId?: string;
  label: string;
}): Promise<Viewer> {
  const client = agent(app);
  const email = await signUp(client, input.label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  if (input.roleId !== null)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        input.tenantId,
        userId,
        input.roleId,
        input.scopeType,
        input.scopeType === "tenant" ? null : (input.scopeId ?? null),
      ],
    );
  await verifySessionMfa(email);
  return { client, host: input.host };
}

async function makeWorld(label: string, bigLedger: number): Promise<World> {
  const tenant = await createIsolatedTenant(
    `rr-${label}-${randomUUID().slice(0, 6)}`,
  );
  const outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), tenant.outletId],
  );
  const accounts = {
    cash: randomUUID(),
    inventory: randomUUID(),
    revenue: randomUUID(),
    discount: randomUUID(),
    cogs: randomUUID(),
  };
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $6, $7, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $6, $7, '1301', 'Persediaan', 'asset', 'current_asset'),
            ($3, $6, $7, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($4, $6, $7, '4201', 'Diskon penjualan', 'revenue', 'revenue'),
            ($5, $6, $7, '5101', 'HPP', 'expense', 'cogs')`,
    [
      accounts.cash,
      accounts.inventory,
      accounts.revenue,
      accounts.discount,
      accounts.cogs,
      tenant.tenantId,
      tenant.legalEntityId,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3), ($1, $2, 'sales_discount', $4),
            ($1, $2, 'cogs', $5), ($1, $2, 'inventory', $6)
     ON CONFLICT DO NOTHING`,
    [
      tenant.tenantId,
      tenant.legalEntityId,
      accounts.revenue,
      accounts.discount,
      accounts.cogs,
      accounts.inventory,
    ],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2025-06')`,
    [tenant.tenantId, tenant.legalEntityId],
  );

  const roles = {
    full: await insertRole(tenant.tenantId, "Penuh uji laporan", FINANCIAL, [
      "tenant",
      "brand",
    ]),
    outlet: await insertRole(
      tenant.tenantId,
      "Manajer outlet uji laporan",
      FINANCIAL,
      ["outlet"],
    ),
    sales: await insertRole(
      tenant.tenantId,
      "Penjualan saja",
      ["report.sales.view"],
      ["tenant"],
    ),
    shareholder: await insertRole(
      tenant.tenantId,
      "Shareholder",
      ["dashboard.shareholder.view", "report.aggregate.view"],
      ["tenant"],
      "shareholder",
    ),
  };
  const common = { tenantId: tenant.tenantId, host: tenant.hostname };
  const world: World = {
    tenantId: tenant.tenantId,
    host: tenant.hostname,
    entityId: tenant.legalEntityId,
    outlet1: tenant.outletId,
    outlet2,
    accounts,
    full: await viewerWithRole({
      ...common,
      roleId: roles.full,
      scopeType: "tenant",
      label: `Penuh ${label}`,
    }),
    outletManager: await viewerWithRole({
      ...common,
      roleId: roles.outlet,
      scopeType: "outlet",
      scopeId: tenant.outletId,
      label: `Outlet ${label}`,
    }),
    salesOnly: await viewerWithRole({
      ...common,
      roleId: roles.sales,
      scopeType: "tenant",
      label: `Sales ${label}`,
    }),
    shareholder: await viewerWithRole({
      ...common,
      roleId: roles.shareholder,
      scopeType: "tenant",
      label: `Shareholder ${label}`,
    }),
    nobody: await viewerWithRole({
      ...common,
      roleId: null,
      scopeType: "tenant",
      label: `Tanpa izin ${label}`,
    }),
  };

  // Tenant A: outlet1 950k net (1,000k sale - 50k discount), cogs 300k;
  // outlet2 400k net, cogs 120k. Tenant B posts `bigLedger` on outlet1 only.
  if (bigLedger === 0) {
    await sale(world, "2025-06-10", world.outlet1, 1_000_000);
    await cogs(world, "2025-06-10", world.outlet1, 300_000);
    await sale(world, "2025-06-11", world.outlet2, 400_000);
    await cogs(world, "2025-06-11", world.outlet2, 120_000);
    await discount(world, "2025-06-20", world.outlet1, 50_000);
  } else {
    await sale(world, "2025-06-10", world.outlet1, bigLedger);
  }
  return world;
}

type Body = Record<string, unknown>;

const get = (v: Viewer | null, path: string) =>
  (v?.client ?? agent(app)).get(path).set("Host", (v ?? a).host);

const run = (v: Viewer | null, body: Body) =>
  (v?.client ?? agent(app))
    .post("/api/reports/run")
    .set(originHeader)
    .set("Host", (v ?? a).host)
    .send(body);

const preview = (v: Viewer | null, body: Body) =>
  (v?.client ?? agent(app))
    .post("/api/reports/builder/preview")
    .set(originHeader)
    .set("Host", (v ?? a).host)
    .send(body);

async function catalogCodes(v: Viewer): Promise<string[] | number> {
  const codes: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const response = await get(
      v,
      `/api/reports?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (response.status !== 200) return response.status;
    codes.push(
      ...(response.body.data as { code: string }[]).map((r) => r.code),
    );
    cursor = response.body.meta.nextCursor ?? undefined;
    if (cursor === undefined) return codes;
  }
}

type Result = ReturnType<typeof reportResultSchema.parse>;

function resultOf(response: {
  status: number;
  body: { data: unknown };
}): Result {
  expect(response.status).toBe(200);
  return reportResultSchema.parse(response.body.data);
}

/** Money of one metric in every row, in row order; null cells stay null. */
function idrCells(result: Result, metricCode: string): (number | null)[] {
  return result.rows.map((row) => {
    const cell = row.values.find((value) => value.metricCode === metricCode);
    expect(cell, `${metricCode} cell`).toBeDefined();
    if (cell!.value === null) return null;
    expect(cell!.value.unit).toBe("idr");
    return (cell!.value as { valueIdr: number }).valueIdr;
  });
}

function sum(cells: (number | null)[]): number {
  return cells.reduce<number>((total, cell) => total + (cell ?? 0), 0);
}

function availabilityOf(result: Result, metricCode: string) {
  const entry = result.availability.find(
    (item) => item.metricCode === metricCode,
  );
  expect(entry, `availability of ${metricCode}`).toBeDefined();
  return entry!;
}

beforeAll(async () => {
  app = createApp();
  a = await makeWorld("a", 0);
  b = await makeWorld("b", 9_000_000);
  c = await makeWorld("c", 0);
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND period = '2025-06'`,
    [c.tenantId],
  );
  await closeFiscalPeriod(
    context(c),
    rows[0]!.id,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(randomUUID()),
  );
});

afterAll(async () => {
  await owner.end();
});

// ---- Catalog ----------------------------------------------------------------

describe("GET /api/reports: catalog filtered by permission", () => {
  it("answers 401 without a session", async () => {
    expect((await get(null, "/api/reports")).status).toBe(401);
  });

  it("lists every report to a caller holding every report permission", async () => {
    const codes = await catalogCodes(a.full);
    expect(Array.isArray(codes)).toBe(true);
    expect(new Set(codes as string[])).toEqual(
      new Set(
        reportCatalog
          .filter((report) =>
            report.requiredPermissions.every((p) => FINANCIAL.includes(p)),
          )
          .map((report) => report.code),
      ),
    );
    expect(codes).toContain(INCOME_STATEMENT);
  });

  it("hides reports whose permissions the caller lacks", async () => {
    const codes = (await catalogCodes(a.salesOnly)) as string[];
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.every((code) => code.startsWith("sales."))).toBe(true);
    expect(codes).not.toContain(INCOME_STATEMENT);
  });

  it("shows a shareholder only aggregate reports, never a personal split", async () => {
    const codes = (await catalogCodes(a.shareholder)) as string[];
    expect(codes).toContain(INCOME_STATEMENT);
    expect(codes).not.toContain("sales.per_employee");
    expect(codes).not.toContain("finance.supplier_due");
  });

  it("gives a caller without any report permission 403 or an empty list", async () => {
    const codes = await catalogCodes(a.nobody);
    if (typeof codes === "number") expect(codes).toBe(403);
    else expect(codes).toEqual([]);
  });
});

describe("GET /api/reports/:reportCode", () => {
  it("returns the definition of a permitted report", async () => {
    const response = await get(a.full, `/api/reports/${INCOME_STATEMENT}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      code: INCOME_STATEMENT,
      family: "finance",
    });
    expect(response.body.data.metrics).toEqual([
      "net_sales",
      "cogs",
      "gross_profit",
      "net_profit",
    ]);
  });

  it("answers 404 REPORT_NOT_FOUND for a code that is not in the catalog", async () => {
    const response = await get(a.full, "/api/reports/sales.tidak_ada");
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain("REPORT_NOT_FOUND");
  });

  it("answers 403 for a report the caller has no permission for", async () => {
    const response = await get(a.salesOnly, `/api/reports/${INCOME_STATEMENT}`);
    expect(response.status).toBe(403);
  });
});

// ---- Run: ledger-backed report ------------------------------------------------

describe("POST /api/reports/run: ledger report", () => {
  it("answers 401 without a session", async () => {
    expect(
      (await run(null, { reportCode: INCOME_STATEMENT, period: JUNE })).status,
    ).toBe(401);
  });

  it("answers 403 when the caller lacks the report's permission", async () => {
    const response = await run(a.salesOnly, {
      reportCode: INCOME_STATEMENT,
      period: JUNE,
    });
    expect(response.status).toBe(403);
  });

  it("answers 404 REPORT_NOT_FOUND for an unknown report", async () => {
    const response = await run(a.full, {
      reportCode: "sales.tidak_ada",
      period: JUNE,
    });
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain("REPORT_NOT_FOUND");
  });

  it("returns the ledger numbers with every metric available", async () => {
    const result = resultOf(
      await run(a.full, { reportCode: INCOME_STATEMENT, period: JUNE }),
    );
    expect(result.reportCode).toBe(INCOME_STATEMENT);
    expect(result.availability.map((item) => item.metricCode)).toEqual(
      result.definitions.map((definition) => definition.code),
    );
    for (const metric of ["net_sales", "cogs", "gross_profit"])
      expect(availabilityOf(result, metric).status).toBe("available");
    // 1,000k + 400k sales - 50k discount = 1,350k; cogs 300k + 120k.
    expect(sum(idrCells(result, "net_sales"))).toBe(1_350_000);
    expect(sum(idrCells(result, "cogs"))).toBe(420_000);
    expect(sum(idrCells(result, "gross_profit"))).toBe(930_000);
  });

  it("splits by outlet and the outlet rows add up to the ledger total", async () => {
    const result = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period: JUNE,
        groupBy: ["outlet"],
      }),
    );
    expect(result.groupBy).toEqual(["outlet"]);
    const cells = idrCells(result, "net_sales").filter(
      (value) => value !== null && value !== 0,
    );
    expect(cells.sort((x, y) => (x as number) - (y as number))).toEqual([
      400_000, 950_000,
    ]);
    expect(sum(idrCells(result, "net_sales"))).toBe(1_350_000);
  });

  it("runs bucket day as one row per day with its bucket dates and per-day ledger figures", async () => {
    const result = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period: JUNE,
        bucket: "day",
      }),
    );
    expect(result.bucket).toBe("day");
    expect(result.period.bucket).toBe("day");
    expect(result.rows).toHaveLength(30);
    result.rows.forEach((row, index) => {
      const date = `2025-06-${String(index + 1).padStart(2, "0")}`;
      expect(row.bucketStart).toBe(date);
      expect(row.bucketEnd).toBe(date);
    });
    const netSales = idrCells(result, "net_sales");
    // Ledger by day: 10th 1,000k, 11th 400k, 20th -50k (discount); no data
    // elsewhere is null or 0 but never a number from another day.
    expect(netSales[9]).toBe(1_000_000);
    expect(netSales[10]).toBe(400_000);
    expect(netSales[19]).toBe(-50_000);
    expect(netSales[0] ?? 0).toBe(0);
    expect(sum(netSales)).toBe(1_350_000);
    expect(sum(idrCells(result, "cogs"))).toBe(420_000);
    expect(idrCells(result, "cogs")[9]).toBe(300_000);
  });

  it("runs bucket total as one bucket covering the whole period", async () => {
    const result = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period: JUNE,
        bucket: "total",
      }),
    );
    expect(result.bucket).toBe("total");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      bucketStart: JUNE.startDate,
      bucketEnd: JUNE.endDate,
    });
  });

  it("orders rows by bucket, then dimension, and counts the limit over all rows", async () => {
    const period = { startDate: "2025-06-10", endDate: "2025-06-12" };
    const result = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period,
        bucket: "day",
        groupBy: ["outlet"],
        sort: { column: "net_sales", direction: "desc" },
      }),
    );
    const starts = result.rows.map((row) => row.bucketStart);
    expect(starts).toEqual([...starts].sort());
    const tenth = result.rows.filter((row) => row.bucketStart === "2025-06-10");
    const tenthSales = idrCells({ ...result, rows: tenth }, "net_sales");
    expect(tenthSales[0]).toBe(1_000_000);
    const limited = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period,
        bucket: "day",
        groupBy: ["outlet"],
        limit: 2,
      }),
    );
    expect(limited.rows).toHaveLength(2);
    expect(limited.rowLimit).toBe(2);
  });

  it("flags truncated only when the limit cuts rows", async () => {
    const body = {
      reportCode: INCOME_STATEMENT,
      period: JUNE,
      bucket: "day",
      groupBy: ["outlet"],
    };
    // 30 days x 2 outlets with ledger data = 60 rows.
    const all = resultOf(await run(a.full, { ...body, limit: 500 }));
    expect(all.rows.length).toBeGreaterThan(30);
    expect(all.truncated).toBe(false);
    const exact = resultOf(
      await run(a.full, { ...body, limit: all.rows.length }),
    );
    expect(exact.truncated).toBe(false);
    const cut = resultOf(
      await run(a.full, { ...body, limit: all.rows.length - 1 }),
    );
    expect(cut.truncated).toBe(true);
    expect(cut.rows).toHaveLength(all.rows.length - 1);
  });

  it("runs bucket week with the first and last week cut to the period", async () => {
    // Wed 4 June to Wed 25 June 2025: weeks start on Monday.
    const result = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period: { startDate: "2025-06-04", endDate: "2025-06-25" },
        bucket: "week",
      }),
    );
    expect(result.rows.map((row) => [row.bucketStart, row.bucketEnd])).toEqual([
      ["2025-06-04", "2025-06-08"],
      ["2025-06-09", "2025-06-15"],
      ["2025-06-16", "2025-06-22"],
      ["2025-06-23", "2025-06-25"],
    ]);
    // 10th and 11th fall in week two, the 20th discount in week three.
    expect(idrCells(result, "net_sales")).toEqual([
      null,
      1_400_000,
      -50_000,
      null,
    ]);
  });

  it("runs bucket month with the first and last month cut to the period", async () => {
    const result = resultOf(
      await run(a.full, {
        reportCode: INCOME_STATEMENT,
        period: { startDate: "2025-05-15", endDate: "2025-07-10" },
        bucket: "month",
      }),
    );
    expect(result.rows.map((row) => [row.bucketStart, row.bucketEnd])).toEqual([
      ["2025-05-15", "2025-05-31"],
      ["2025-06-01", "2025-06-30"],
      ["2025-07-01", "2025-07-10"],
    ]);
    expect(idrCells(result, "net_sales")).toEqual([null, 1_350_000, null]);
  });

  it("rules finality per bucket: a closed month stays final inside a longer period", async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const result = resultOf(
      await run(c.full, {
        reportCode: INCOME_STATEMENT,
        period: { startDate: "2025-06-10", endDate: soon },
        bucket: "month",
      }),
    );
    // The period reaches today, so it is open and its books are not all closed.
    expect(result.period.status).toBe("open");
    expect(result.period.accountingPeriodClosed).toBe(false);
    // 10-30 June 2025: books closed, so the figures are final.
    const june = result.rows[0]!;
    expect([june.bucketStart, june.bucketEnd]).toEqual([
      "2025-06-10",
      "2025-06-30",
    ]);
    const netSales = june.values.find(
      (cell) => cell.metricCode === "net_sales",
    );
    expect(netSales).toMatchObject({
      value: { valueIdr: 1_350_000 },
      finality: "final",
    });
    // July 2025 is past but its books are open; the running month is open.
    for (const row of result.rows.slice(1))
      for (const cell of row.values) expect(cell.finality).toBe("estimate");
  });

  it("keeps tenants apart: tenant B never sees tenant A figures", async () => {
    const forB = resultOf(
      await run(b.full, { reportCode: INCOME_STATEMENT, period: JUNE }),
    );
    expect(sum(idrCells(forB, "net_sales"))).toBe(9_000_000);
    expect(sum(idrCells(forB, "cogs"))).toBe(0);
    const forA = resultOf(
      await run(a.full, { reportCode: INCOME_STATEMENT, period: JUNE }),
    );
    expect(sum(idrCells(forA, "net_sales"))).toBe(1_350_000);
  });

  it("limits an outlet-scoped caller to its own outlet", async () => {
    const result = resultOf(
      await run(a.outletManager, {
        reportCode: INCOME_STATEMENT,
        period: JUNE,
      }),
    );
    // outlet1 only: 1,000k sale - 50k discount, cogs 300k.
    expect(sum(idrCells(result, "net_sales"))).toBe(950_000);
    expect(sum(idrCells(result, "cogs"))).toBe(300_000);
  });

  it("refuses or empties an outlet outside the caller's scope", async () => {
    const response = await run(a.outletManager, {
      reportCode: INCOME_STATEMENT,
      period: JUNE,
      outletIds: [a.outlet2],
    });
    if (response.status === 200) {
      const result = resultOf(response);
      expect(sum(idrCells(result, "net_sales"))).not.toBe(400_000);
      expect(sum(idrCells(result, "net_sales"))).toBe(0);
    } else expect(response.status).toBe(403);
  });

  it("shows no data, never zero, for a period without journals", async () => {
    const result = resultOf(
      await run(a.full, { reportCode: INCOME_STATEMENT, period: EMPTY }),
    );
    for (const row of result.rows)
      for (const cell of row.values) expect(cell.value).toBeNull();
    expect(availabilityOf(result, "net_sales").status).toBe("available");
  });

  it("rejects a group-by the report does not declare", async () => {
    const response = await run(a.full, {
      reportCode: INCOME_STATEMENT,
      period: JUNE,
      groupBy: ["channel"],
    });
    expect([400, 422]).toContain(response.status);
  });
});

// ---- Run: metrics without a source -------------------------------------------

describe("POST /api/reports/run: metrics without a source", () => {
  it("answers 200 with unavailable / source_not_built and empty cells", async () => {
    const result = resultOf(
      await run(a.full, { reportCode: UNBUILT_REPORT, period: JUNE }),
    );
    expect(result.reportCode).toBe(UNBUILT_REPORT);
    expect(result.availability.map((item) => item.metricCode)).toEqual(
      result.definitions.map((definition) => definition.code),
    );
    for (const item of result.availability) {
      expect(item).toMatchObject({
        status: "unavailable",
        reason: "source_not_built",
      });
      expect((item as { message: string }).message.length).toBeGreaterThan(0);
    }
    for (const row of result.rows)
      for (const cell of row.values) expect(cell.value).toBeNull();
  });

  it("marks only the unbuilt metrics of a mixed preview as unavailable", async () => {
    const result = resultOf(
      await preview(a.full, {
        metricCodes: ["net_sales", UNBUILT_METRIC],
        period: JUNE,
      }),
    );
    expect(availabilityOf(result, "net_sales").status).toBe("available");
    expect(availabilityOf(result, UNBUILT_METRIC)).toMatchObject({
      status: "unavailable",
      reason: "source_not_built",
    });
    expect(sum(idrCells(result, "net_sales"))).toBe(1_350_000);
    expect(
      idrCells(result, UNBUILT_METRIC).every((cell) => cell === null),
    ).toBe(true);
  });
});

// ---- Preview ------------------------------------------------------------------

describe("POST /api/reports/builder/preview", () => {
  it("answers 401 without a session", async () => {
    expect(
      (await preview(null, { metricCodes: ["net_sales"], period: JUNE }))
        .status,
    ).toBe(401);
  });

  it("returns reportCode null and the ledger figure for an ad hoc query", async () => {
    const result = resultOf(
      await preview(a.full, {
        metricCodes: ["net_sales", "cogs"],
        period: JUNE,
      }),
    );
    expect(result.reportCode).toBeNull();
    expect(result.definitions.map((definition) => definition.code)).toEqual([
      "net_sales",
      "cogs",
    ]);
    expect(sum(idrCells(result, "net_sales"))).toBe(1_350_000);
    expect(sum(idrCells(result, "cogs"))).toBe(420_000);
  });

  it("keeps tenants apart", async () => {
    const result = resultOf(
      await preview(b.full, { metricCodes: ["net_sales"], period: JUNE }),
    );
    expect(sum(idrCells(result, "net_sales"))).toBe(9_000_000);
  });

  it("limits an outlet-scoped caller to its own outlet", async () => {
    const result = resultOf(
      await preview(a.outletManager, {
        metricCodes: ["net_sales"],
        period: JUNE,
      }),
    );
    expect(sum(idrCells(result, "net_sales"))).toBe(950_000);
  });

  it("answers dimension_not_supported when groupBy has more than outlet plus one", async () => {
    const response = await preview(a.full, {
      metricCodes: ["net_sales"],
      period: JUNE,
      groupBy: ["outlet", "channel", "hour"],
    });
    const result = resultOf(response);
    expect(availabilityOf(result, "net_sales")).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
    for (const row of result.rows)
      for (const cell of row.values) expect(cell.value).toBeNull();
  });

  it("refuses an identity split to an aggregate-only caller", async () => {
    const response = await preview(a.shareholder, {
      metricCodes: ["net_sales"],
      period: JUNE,
      groupBy: ["employee"],
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(JSON.stringify(response.body)).not.toContain("valueIdr");
  });
});

// ---- Scope and aggregate fallback (architect review) ------------------------

type Assignment = {
  permissions: string[];
  scopeType: "tenant" | "outlet";
  scopeId?: string;
};

/** One user holding several roles, each with its own scope. */
async function viewerWithAssignments(
  w: World,
  label: string,
  assignments: Assignment[],
): Promise<Viewer> {
  const client = agent(app);
  const email = await signUp(client, label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  for (const [index, assignment] of assignments.entries()) {
    const roleId = await insertRole(
      w.tenantId,
      `${label} ${index}`,
      assignment.permissions,
      [assignment.scopeType],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        w.tenantId,
        userId,
        roleId,
        assignment.scopeType,
        assignment.scopeType === "tenant" ? null : (assignment.scopeId ?? null),
      ],
    );
  }
  await verifySessionMfa(email);
  return { client, host: w.host };
}

describe("report scope: aggregate reach never widens a full report", () => {
  it("reads an inventory metric only on the caller's outlet even when an aggregate report rides along", async () => {
    // Operational reach on outlet1 only, plus tenant-wide aggregate view.
    // finance.ebitda is an aggregate report; inventory.stock_value is not.
    const viewer = await viewerWithAssignments(a, "Operasional+agregat", [
      {
        permissions: ["report.operational.view"],
        scopeType: "outlet",
        scopeId: a.outlet1,
      },
      { permissions: ["report.aggregate.view"], scopeType: "tenant" },
    ]);
    const result = resultOf(
      await preview(viewer, {
        metricCodes: ["stock_value", "ebitda"],
        period: JUNE,
      }),
    );
    expect(result.outletFilter).toEqual({
      kind: "outlets",
      outletIds: [a.outlet1],
    });
  });

  it("refuses a non-aggregate metric the caller has no permission for, aggregate view or not", async () => {
    const viewer = await viewerWithAssignments(a, "Hanya agregat", [
      { permissions: ["report.aggregate.view"], scopeType: "tenant" },
    ]);
    const response = await preview(viewer, {
      metricCodes: ["net_sales", "stock_value"],
      period: JUNE,
    });
    expect(response.status).toBe(403);
  });

  it("refuses a report whose permissions reach disjoint outlets instead of running tenant-wide", async () => {
    // attendance.daily needs report.operational.view and hr.employee.view.
    const viewer = await viewerWithAssignments(a, "Dua izin dua outlet", [
      {
        permissions: ["report.operational.view"],
        scopeType: "outlet",
        scopeId: a.outlet1,
      },
      {
        permissions: ["hr.employee.view"],
        scopeType: "outlet",
        scopeId: a.outlet2,
      },
      { permissions: ["report.aggregate.view"], scopeType: "tenant" },
    ]);
    const response = await run(viewer, {
      reportCode: "attendance.daily",
      period: JUNE,
    });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).toContain("REPORT_NOT_PERMITTED");
  });
});
