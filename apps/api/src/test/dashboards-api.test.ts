// Fail-first tests for the dashboard endpoints and the batch values read (WS-11
// F11, bead legend-flb8f, absorbs legend-1ye3 and legend-5bjh; endpoints in
// packages/shared/src/dashboard/endpoints.ts).
//
// Everything goes over HTTP (createApp + Host header, as reports-run.test.ts) so
// the permission and outlet-scope rules of the route are part of what is
// pinned. Every run builds its own tenants, so concurrent suites never touch
// these numbers.
//
// ASSUMPTIONS (the contract does not pin these down):
// - `/api/dashboards/:kind/values` is the batch endpoint: one call answers every
//   metric tile of the dashboard.
// - Failure statuses: unauthenticated 401, missing dashboard permission 403
//   REPORT_NOT_PERMITTED.
// - Tiles the caller may not open are left out, never blanked.
// - The reviews queue has no table yet: 501 DASHBOARD_QUEUE_UNAVAILABLE.
// - Ledger numbers asserted: net_sales = revenue minus discount.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import {
  DASHBOARD_CATALOG,
  dashboardLayoutSchema,
  dashboardQueueRowsSchema,
  dashboardValuesQuerySchema,
  dashboardValuesSchema,
  reportAcceptsAggregateView,
  reportByCode,
  reportResultSchema,
} from "@starter/shared/dashboard";
import { METRIC_UNAVAILABLE_MESSAGES } from "@starter/shared/metrics";
import { metricSourceOf } from "../services/metric-sources";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import {
  admittedTiles,
  getDashboardLayout,
  getDashboardValues,
  setDashboardCacheTtlMs,
  viewerReportsOf,
} from "../services/dashboard-run.service";
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
    "cash" | "revenue" | "discount" | "cogs" | "inventory",
    string
  >;
  full: Viewer; // every dashboard + report permission, tenant scope
  outletManager: Viewer; // same permissions, outlet1 only
  salesOnly: Viewer; // dashboard.owner.view + report.sales.view
  managementOnly: Viewer; // dashboard.management.view only
  shareholder: Viewer; // dashboard.shareholder.view + report.aggregate.view
  nobody: Viewer; // no permission
};

const FULL = [
  "dashboard.owner.view",
  "dashboard.management.view",
  "report.operational.view",
  "report.sales.view",
  "report.financial.view",
  "report.aggregate.view",
];

const JUNE = "period=custom&startDate=2025-06-01&endDate=2025-06-30";
const JUNE_RANGE = { startDate: "2025-06-01", endDate: "2025-06-30" };
const EMPTY = "period=custom&startDate=2024-01-01&endDate=2024-01-31";

let app: Express;
let a: World; // June 2025 books open
let b: World; // one big ledger on outlet1
let c: World; // same data as `a`, June 2025 books closed

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
      description: "Uji dasbor",
      lines,
      postedBy: null,
      idempotencyKey: `dashboards-${randomUUID()}`,
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
    `dash-${label}-${randomUUID().slice(0, 6)}`,
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
    full: await insertRole(tenant.tenantId, "Penuh uji dasbor", FULL, [
      "tenant",
      "brand",
    ]),
    outlet: await insertRole(
      tenant.tenantId,
      "Manajer outlet uji dasbor",
      FULL,
      ["outlet"],
    ),
    sales: await insertRole(
      tenant.tenantId,
      "Penjualan saja",
      ["dashboard.owner.view", "report.sales.view"],
      ["tenant"],
    ),
    management: await insertRole(
      tenant.tenantId,
      "Manajemen saja",
      ["dashboard.management.view"],
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
    managementOnly: await viewerWithRole({
      ...common,
      roleId: roles.management,
      scopeType: "tenant",
      label: `Manajemen ${label}`,
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

  // Outlet1 950k net (1,000k sale - 50k discount), cogs 300k; outlet2 400k net,
  // cogs 120k. Tenant B posts `bigLedger` on outlet1 only.
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

const get = (v: Viewer | null, path: string) =>
  (v?.client ?? agent(app)).get(path).set("Host", (v ?? a).host);

const runReport = (v: Viewer, body: Record<string, unknown>) =>
  v.client
    .post("/api/reports/run")
    .set(originHeader)
    .set("Host", v.host)
    .send(body);

async function values(v: Viewer, query = "", kind = "owner") {
  const response = await get(v, `/api/dashboards/${kind}/values?${query}`);
  expect(response.status).toBe(200);
  return dashboardValuesSchema.parse(response.body.data);
}

type Values = Awaited<ReturnType<typeof values>>;

function entry(result: Values, tileKey: string, metricCode: string) {
  const tile = result.tiles.find((candidate) => candidate.tileKey === tileKey);
  expect(tile, tileKey).toBeDefined();
  const found = tile!.values.find((value) => value.metricCode === metricCode);
  expect(found, `${tileKey} ${metricCode}`).toBeDefined();
  return found!;
}

const idrOf = (value: { value: unknown } | undefined): number | null => {
  const inner = value?.value as { unit: string; valueIdr?: number } | null;
  if (inner === null || inner === undefined) return null;
  expect(inner.unit).toBe("idr");
  return inner.valueIdr ?? null;
};

beforeAll(async () => {
  app = createApp();
  setDashboardCacheTtlMs(0);
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

afterEach(() => setDashboardCacheTtlMs(0));

afterAll(async () => {
  setDashboardCacheTtlMs(15_000);
  await owner.end();
});

// ---- Layout -----------------------------------------------------------------

describe("GET /api/dashboards/:dashboard: layout", () => {
  it("answers 401 without a session", async () => {
    expect((await get(null, "/api/dashboards/owner")).status).toBe(401);
  });

  it("gives the owner layout with the outlets the caller reaches", async () => {
    const response = await get(a.full, "/api/dashboards/owner");
    expect(response.status).toBe(200);
    const layout = dashboardLayoutSchema.parse(response.body.data);
    expect(layout.dashboard).toBe("owner");
    expect(layout.tiles.every((tile) => tile.dashboard === "owner")).toBe(true);
    expect([...layout.availableOutlets].sort()).toEqual(
      [a.outlet1, a.outlet2].sort(),
    );
    const scoped = dashboardLayoutSchema.parse(
      (await get(a.outletManager, "/api/dashboards/owner")).body.data,
    );
    expect(scoped.availableOutlets).toEqual([a.outlet1]);
  });

  it("refuses an outlet outside the caller scope", async () => {
    const response = await get(
      a.outletManager,
      `/api/dashboards/owner?outletIds=${a.outlet2}`,
    );
    expect(response.status).toBe(403);
  });

  it("answers 403 REPORT_NOT_PERMITTED without the dashboard permission", async () => {
    for (const path of [
      "/api/dashboards/owner",
      "/api/dashboards/owner/values",
      "/api/dashboards/management",
      "/api/dashboards/shareholder",
    ]) {
      const response = await get(a.nobody, path);
      expect(response.status, path).toBe(403);
      expect(response.body.error.code).toBe("REPORT_NOT_PERMITTED");
    }
  });

  it("leaves out tiles whose reports the caller may not open", async () => {
    const layout = dashboardLayoutSchema.parse(
      (await get(a.salesOnly, "/api/dashboards/owner")).body.data,
    );
    const keys = layout.tiles.map((tile) => tile.key);
    expect(keys).toContain("owner.today_sales");
    expect(keys).not.toContain("owner.income_statement");
    expect(keys).not.toContain("owner.cash_position");
  });

  it("gives the management home without any report permission", async () => {
    const response = await get(a.managementOnly, "/api/dashboards/management");
    expect(response.status).toBe(200);
    const layout = dashboardLayoutSchema.parse(response.body.data);
    expect(layout.tiles.map((tile) => tile.key)).toContain(
      "management.reports",
    );
    expect((await get(a.managementOnly, "/api/dashboards/owner")).status).toBe(
      403,
    );
  });
});

// ---- Shareholder ------------------------------------------------------------

describe("shareholder dashboard (SH-01, SH-02, legend-5bjh)", () => {
  it("opens through report.aggregate.view without dashboard.management.view", async () => {
    const layout = dashboardLayoutSchema.parse(
      (await get(a.shareholder, "/api/dashboards/shareholder")).body.data,
    );
    expect(layout.tiles.every((tile) => tile.dashboard === "shareholder")).toBe(
      true,
    );
    expect(layout.tiles.map((tile) => tile.key)).toContain(
      "shareholder.revenue",
    );
    expect(
      (await get(a.shareholder, "/api/dashboards/management")).status,
    ).toBe(403);
    expect((await get(a.shareholder, "/api/dashboards/owner")).status).toBe(
      403,
    );
  });

  it("answers aggregate figures from the ledger", async () => {
    const result = await values(a.shareholder, JUNE, "shareholder");
    expect(idrOf(entry(result, "shareholder.revenue", "net_sales"))).toBe(
      1_350_000,
    );
  });

  it("stays an estimate while the books are open and turns final once closed", async () => {
    const open = await values(a.shareholder, JUNE, "shareholder");
    expect(entry(open, "shareholder.revenue", "net_sales").finality).toBe(
      "estimate",
    );
    const closed = await values(c.shareholder, JUNE, "shareholder");
    expect(entry(closed, "shareholder.revenue", "net_sales")).toMatchObject({
      value: { valueIdr: 1_350_000 },
      finality: "final",
    });
  });

  it("reads no queue rows", async () => {
    for (const queue of ["kitchen_queue", "waiter_calls", "facility_units"])
      expect(
        (await get(a.shareholder, `/api/dashboards/queues/${queue}/rows`))
          .status,
        queue,
      ).toBe(403);
    expect(
      (await get(a.shareholder, "/api/dashboards/queues/facility-scope"))
        .status,
    ).toBe(403);
  });
});

describe("viewerReportsOf: dedup key", () => {
  it("keeps a shareholder-linked report and an owner-only report apart when their permissions match", () => {
    const tile = (key: string) => {
      const found = DASHBOARD_CATALOG.find((item) => item.key === key);
      if (found === undefined) throw new Error(`no tile ${key}`);
      return found;
    };
    // Both reports require report.sales.view; only sales.daily accepts
    // report.aggregate.view.
    const reports = viewerReportsOf([
      tile("shareholder.revenue"),
      tile("owner.sales_by_channel"),
    ]);
    const sales = reports.filter((report) =>
      report.requiredPermissions.includes("report.sales.view"),
    );
    expect(sales.map(reportAcceptsAggregateView).sort()).toEqual([false, true]);
    expect(sales.map((report) => report.code)).toContain("sales.daily");
  });
});

// ---- Values -----------------------------------------------------------------

describe("GET /api/dashboards/:dashboard/values: batch of tile values", () => {
  it("answers the ledger figure of a tile from the test data", async () => {
    const result = await values(a.full, JUNE);
    expect(idrOf(entry(result, "owner.today_sales", "net_sales"))).toBe(
      1_350_000,
    );
    expect(result.tiles.length).toBeGreaterThan(10);
  });

  it("keeps tenants apart", async () => {
    const forB = await values(b.full, JUNE);
    expect(idrOf(entry(forB, "owner.today_sales", "net_sales"))).toBe(
      9_000_000,
    );
    const forA = await values(a.full, JUNE);
    expect(idrOf(entry(forA, "owner.today_sales", "net_sales"))).toBe(
      1_350_000,
    );
  });

  it("keeps outlets apart: an outlet caller reads only its outlet", async () => {
    const scoped = await values(a.outletManager, JUNE);
    expect(idrOf(entry(scoped, "owner.today_sales", "net_sales"))).toBe(
      950_000,
    );
    expect(scoped.outlets).toEqual({ kind: "outlets", outletIds: [a.outlet1] });
    const only2 = dashboardValuesSchema.parse(
      (
        await get(
          a.full,
          `/api/dashboards/owner/values?${JUNE}&outletIds=${a.outlet2}`,
        )
      ).body.data,
    );
    expect(idrOf(entry(only2, "owner.today_sales", "net_sales"))).toBe(400_000);
    expect(
      (
        await get(
          a.outletManager,
          `/api/dashboards/owner/values?${JUNE}&outletIds=${a.outlet2}`,
        )
      ).status,
    ).toBe(403);
  });

  it("leaves out tiles the caller may not open", async () => {
    const response = await get(
      a.salesOnly,
      `/api/dashboards/owner/values?${JUNE}`,
    );
    expect(response.status).toBe(200);
    const result = dashboardValuesSchema.parse(response.body.data);
    const keys = result.tiles.map((tile) => tile.tileKey);
    expect(keys).toContain("owner.today_sales");
    expect(keys).not.toContain("owner.income_statement");
  });

  it("never calls a day without data final or zero", async () => {
    // Default periods: today and this month, with no postings in them.
    const today = await values(a.full);
    const sales = entry(today, "owner.today_sales", "net_sales");
    expect(sales.value).toBeNull();
    for (const tile of today.tiles)
      for (const value of tile.values) {
        expect(value.finality, `${tile.tileKey} ${value.metricCode}`).not.toBe(
          "final",
        );
        expect(value.comparison === null || value.value !== null).toBe(true);
      }
    const empty = await values(c.full, EMPTY);
    for (const tile of empty.tiles)
      for (const value of tile.values) expect(value.finality).not.toBe("final");
    expect(entry(empty, "owner.today_sales", "net_sales").value).toBeNull();
  });

  it("rejects a custom period without dates and dates without custom", async () => {
    expect(
      (await get(a.full, "/api/dashboards/owner/values?period=custom")).status,
    ).toBe(422);
    expect(
      (
        await get(
          a.full,
          "/api/dashboards/owner/values?startDate=2025-06-01&endDate=2025-06-30",
        )
      ).status,
    ).toBe(422);
  });

  it("gives the same numbers as running each tile's report one by one", async () => {
    const result = await values(a.full, JUNE);
    const layout = dashboardLayoutSchema.parse(
      (await get(a.full, "/api/dashboards/owner")).body.data,
    );
    const metricTiles = layout.tiles.flatMap((tile) =>
      tile.kind === "metric" ? [tile] : [],
    );
    expect(result.tiles.map((tile) => tile.tileKey).sort()).toEqual(
      metricTiles.map((tile) => tile.key).sort(),
    );
    let compared = 0;
    let withFigure = 0;
    const started = Date.now();
    for (const tile of metricTiles) {
      const report = reportByCode(tile.reportCode)!;
      const response = await runReport(a.full, {
        reportCode: tile.reportCode,
        period: JUNE_RANGE,
        bucket: "total",
      });
      expect(response.status, tile.reportCode).toBe(200);
      const run = reportResultSchema.parse(response.body.data);
      for (const code of tile.metricCodes) {
        if (!report.metrics.includes(code)) continue;
        const cell = run.rows[0]?.values.find((v) => v.metricCode === code);
        const figure = entry(result, tile.key, code);
        expect(figure.value, `${tile.key} ${code}`).toEqual(
          cell?.value ?? null,
        );
        compared += 1;
        if (figure.value !== null) withFigure += 1;
      }
    }
    console.info(
      `[dashboards] ${metricTiles.length} one-by-one runs took ${Date.now() - started} ms`,
    );
    expect(compared).toBeGreaterThan(10);
    expect(withFigure).toBeGreaterThan(0);
  });

  it("answers the whole owner dashboard in one call within p95 3 s", async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const started = Date.now();
      const response = await get(
        a.full,
        `/api/dashboards/owner/values?${JUNE}`,
      );
      times.push(Date.now() - started);
      expect(response.status).toBe(200);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    console.info(
      `[dashboards] owner values p95 ${p95} ms, median ${times[10]} ms`,
    );
    expect(p95).toBeLessThanOrEqual(3000);
  });

  it("caches per tenant, scope and viewer without leaking across them", async () => {
    setDashboardCacheTtlMs(60_000);
    const first = await get(a.full, `/api/dashboards/owner/values?${JUNE}`);
    const again = await get(a.full, `/api/dashboards/owner/values?${JUNE}`);
    expect(again.body.data.generatedAt).toBe(first.body.data.generatedAt);
    // Another tenant, another scope and a narrower tile set each get their own.
    const other = dashboardValuesSchema.parse(
      (await get(b.full, `/api/dashboards/owner/values?${JUNE}`)).body.data,
    );
    expect(idrOf(entry(other, "owner.today_sales", "net_sales"))).toBe(
      9_000_000,
    );
    const scoped = dashboardValuesSchema.parse(
      (await get(a.outletManager, `/api/dashboards/owner/values?${JUNE}`)).body
        .data,
    );
    expect(idrOf(entry(scoped, "owner.today_sales", "net_sales"))).toBe(
      950_000,
    );
    const sales = dashboardValuesSchema.parse(
      (await get(a.salesOnly, `/api/dashboards/owner/values?${JUNE}`)).body
        .data,
    );
    expect(sales.tiles.map((tile) => tile.tileKey)).not.toContain(
      "owner.income_statement",
    );
    // A caller without the permission never reads another caller's cache.
    expect(
      (await get(a.nobody, `/api/dashboards/owner/values?${JUNE}`)).status,
    ).toBe(403);
  });
});

// ---- Queues -----------------------------------------------------------------

async function seedFacility(w: World, name: string, statuses: string[]) {
  const facilityId = randomUUID();
  const areaId = randomUUID();
  await owner.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, $4, 'shower', 30, 10, 10, $5, $6, $7)`,
    [
      facilityId,
      w.tenantId,
      w.outlet1,
      name,
      JSON.stringify([
        {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "00:00",
          closesAt: "23:59",
        },
      ]),
      JSON.stringify({ mode: "block" }),
      JSON.stringify({ freeCancelMinutes: 60, lateFeeIdr: 0 }),
    ],
  );
  await owner.query(
    `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
     VALUES ($1, $2, $3, $4, 'Area', 0)`,
    [areaId, w.tenantId, w.outlet1, facilityId],
  );
  for (const [index, status] of statuses.entries())
    await owner.query(
      `INSERT INTO facility_units (tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [w.tenantId, w.outlet1, facilityId, areaId, `U${index}`, status, index],
    );
  return facilityId;
}

describe("queue rows and facility scope", () => {
  let facilityId: string;

  beforeAll(async () => {
    facilityId = await seedFacility(a, "Shower uji dasbor", [
      "available",
      "available",
      "in_use",
      "maintenance",
    ]);
  });

  it("counts shower units by status and keeps tenants apart", async () => {
    const response = await get(
      a.full,
      "/api/dashboards/queues/facility_units/rows",
    );
    expect(response.status).toBe(200);
    const rows = dashboardQueueRowsSchema.parse(response.body.data);
    if (rows.queue !== "facility_units") throw new Error("wrong queue");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      facilityId,
      outletId: a.outlet1,
      facilityName: "Shower uji dasbor",
      unitCounts: {
        available: 2,
        in_use: 1,
        needs_cleaning: 0,
        cleaning: 0,
        maintenance: 1,
      },
    });
    const forB = dashboardQueueRowsSchema.parse(
      (await get(b.full, "/api/dashboards/queues/facility_units/rows")).body
        .data,
    );
    expect(forB.rows).toEqual([]);
  });

  it("lists facility ids per outlet inside the caller scope", async () => {
    const response = await get(a.full, "/api/dashboards/queues/facility-scope");
    expect(response.status).toBe(200);
    const byOutlet = new Map(
      (
        response.body.data.outlets as {
          outletId: string;
          facilityIds: string[];
        }[]
      ).map((entry) => [entry.outletId, entry.facilityIds]),
    );
    expect(byOutlet.get(a.outlet1)).toEqual([facilityId]);
    expect(byOutlet.get(a.outlet2)).toEqual([]);
    expect(byOutlet.has(b.outlet1)).toBe(false);
    const scoped = await get(
      a.outletManager,
      "/api/dashboards/queues/facility-scope",
    );
    expect(
      (scoped.body.data.outlets as { outletId: string }[]).map(
        (e) => e.outletId,
      ),
    ).toEqual([a.outlet1]);
  });

  it("answers the kitchen and waiter queues with rows of the contract shape", async () => {
    for (const queue of ["kitchen_queue", "waiter_calls"]) {
      const response = await get(
        a.full,
        `/api/dashboards/queues/${queue}/rows`,
      );
      expect(response.status, queue).toBe(200);
      const rows = dashboardQueueRowsSchema.parse(response.body.data);
      expect(rows.queue).toBe(queue);
      expect(rows.hasMore).toBe(false);
    }
  });

  it("refuses queues without permission and says reviews are not built", async () => {
    expect(
      (await get(a.nobody, "/api/dashboards/queues/kitchen_queue/rows")).status,
    ).toBe(403);
    // The reviews queue answers an explicit "not built" instead of an empty
    // list that would read as "no reviews" (F11 availability per queue).
    const reviews = await get(a.full, "/api/dashboards/queues/reviews/rows");
    expect(reviews.status).toBe(200);
    const parsed = dashboardQueueRowsSchema.parse(reviews.body.data);
    expect(parsed.queue).toBe("reviews");
    expect(parsed.rows).toEqual([]);
    expect(parsed.availability).toEqual({
      status: "unavailable",
      reason: "source_not_built",
      message: METRIC_UNAVAILABLE_MESSAGES.source_not_built,
    });
    expect(
      (await get(a.full, "/api/dashboards/queues/approvals/rows")).status,
    ).toBe(422);
  });

  it("marks a served queue available", async () => {
    const response = await get(
      a.full,
      "/api/dashboards/queues/kitchen_queue/rows",
    );
    expect(
      dashboardQueueRowsSchema.parse(response.body.data).availability,
    ).toEqual({ status: "available" });
  });
});

// ---- F11 additions (managerRole, availability, single outletIds) -----------

describe("management managerRole query", () => {
  it("narrows the management layout to the role's tiles plus shared ones", async () => {
    const response = await get(
      a.full,
      "/api/dashboards/management?managerRole=gm",
    );
    expect(response.status).toBe(200);
    const keys = dashboardLayoutSchema
      .parse(response.body.data)
      .tiles.map((tile) => tile.key);
    expect(keys).toContain("management.gm_kpi");
    expect(keys).toContain("management.reports");
    expect(keys).not.toContain("management.hr_kpi");
    expect(keys).not.toContain("management.kitchen_kpi");
  });

  it("narrows the values the same way", async () => {
    const result = await values(a.full, `${JUNE}&managerRole=gm`, "management");
    const keys = result.tiles.map((tile) => tile.tileKey);
    expect(keys).toContain("management.gm_kpi");
    expect(keys).not.toContain("management.hr_kpi");
  });

  // The API answers every zod failure 422 (error-handler.ts), not 400.
  it("rejects an unknown role", async () => {
    for (const path of [
      "/api/dashboards/management?managerRole=ceo",
      "/api/dashboards/management/values?managerRole=ceo",
    ]) {
      const res = await get(a.full, path);
      expect(res.status, path).toBe(422);
      // The role itself is refused, not an unknown query key.
      expect(
        res.body.error.details.map((d: { field: string }) => d.field),
        path,
      ).toContain("managerRole");
    }
  });
});

describe("tile availability", () => {
  it("marks a built tile available and an unbuilt one unavailable with the Indonesian message", async () => {
    // Unbuilt: a management tile whose every metric the registry answers
    // `unavailable` (read from the registry, so families that build a source
    // do not break this test).
    const unbuiltTile = DASHBOARD_CATALOG.find(
      (tile) =>
        tile.dashboard === "management" &&
        "metricCodes" in tile &&
        tile.metricCodes.length > 0 &&
        tile.metricCodes.every(
          (code) => metricSourceOf(code)?.kind === "unavailable",
        ),
    );
    expect(unbuiltTile, "a management tile with no built source").toBeDefined();
    const result = await values(
      a.full,
      unbuiltTile!.managerRole
        ? `${JUNE}&managerRole=${unbuiltTile!.managerRole}`
        : JUNE,
      "management",
    );
    const built = await values(a.full, JUNE);
    expect(
      built.tiles.find((tile) => tile.tileKey === "owner.today_sales")
        ?.availability,
    ).toEqual({ status: "available" });
    const unbuilt = result.tiles.find(
      (tile) => tile.tileKey === unbuiltTile!.key,
    );
    expect(unbuilt?.availability).toEqual({
      status: "unavailable",
      reason: "source_not_built",
      message: METRIC_UNAVAILABLE_MESSAGES.source_not_built,
    });
  });
});

describe("a single outletIds on GET", () => {
  it("is read as a one-element array on layout, values and queue rows", async () => {
    const layout = await get(
      a.full,
      `/api/dashboards/owner?outletIds=${a.outlet1}`,
    );
    expect(layout.status).toBe(200);
    expect(
      dashboardLayoutSchema.parse(layout.body.data).availableOutlets,
    ).toEqual([a.outlet1]);
    const result = await values(a.full, `${JUNE}&outletIds=${a.outlet1}`);
    expect(result.outlets).toEqual({ kind: "outlets", outletIds: [a.outlet1] });
    const rows = await get(
      a.full,
      `/api/dashboards/queues/kitchen_queue/rows?outletIds=${a.outlet1}`,
    );
    expect(rows.status).toBe(200);
  });
});

// ---- Outlet clock (legend-nipn7) --------------------------------------------

describe("today and periodClosed follow the outlet clock", () => {
  // 20:30 UTC on 10 June: Jakarta (+7) is 03:30 on the 11th, still before the
  // 04:00 cutoff, so its business date is the 10th; Makassar (+8) is 04:30 and
  // Jayapura (+9) is 05:30 on the 11th, so theirs is the 11th. The default
  // clock (Jakarta, 04:00) would have said the 10th for all three.
  const NOW = new Date("2025-06-10T20:30:00Z");
  let w: World;
  let jakarta: string;
  let makassar: string;
  let jayapura: string;
  let cutoffLate: string;

  async function addOutlet(
    from: string,
    timezone: string,
    cutoff: string,
  ): Promise<string> {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Zona', address, $4, $5, opening_hours, status
       FROM outlets WHERE id = $3`,
      [
        id,
        `Z-${randomUUID().slice(0, 8)}`.toUpperCase(),
        from,
        timezone,
        cutoff,
      ],
    );
    return id;
  }

  beforeAll(async () => {
    w = await makeWorld("zona", 0);
    jakarta = w.outlet1;
    makassar = w.outlet2;
    await owner.query(
      `UPDATE outlets SET timezone = 'Asia/Jakarta', business_day_cutoff = '04:00' WHERE id = $1`,
      [jakarta],
    );
    await owner.query(
      `UPDATE outlets SET timezone = 'Asia/Makassar', business_day_cutoff = '04:00' WHERE id = $1`,
      [makassar],
    );
    jayapura = await addOutlet(jakarta, "Asia/Jayapura", "04:00");
    cutoffLate = await addOutlet(jakarta, "Asia/Jakarta", "06:00");
  });

  const tiles = () => admittedTiles("owner", FULL);
  const valuesAt = (
    outletIds: string[],
    query: Record<string, string>,
    now = NOW,
  ) =>
    getDashboardValues(
      context(w),
      {
        dashboard: "owner",
        viewer: "full",
        tiles: tiles(),
        query: dashboardValuesQuerySchema.parse({
          ...(outletIds.length > 0 ? { outletIds } : {}),
          ...query,
        }),
      },
      { now },
    );
  const layoutAt = (outletIds: string[], now = NOW) =>
    getDashboardLayout(
      context(w),
      { dashboard: "owner", tiles: tiles(), outletIds },
      { now },
    );

  it("gives each outlet the business date of its own zone", async () => {
    expect((await layoutAt([jakarta])).businessDate).toBe("2025-06-10");
    expect((await layoutAt([makassar])).businessDate).toBe("2025-06-11");
    expect((await layoutAt([jayapura])).businessDate).toBe("2025-06-11");
    expect((await valuesAt([jakarta], { period: "today" })).businessDate).toBe(
      "2025-06-10",
    );
    const makassarToday = await valuesAt([makassar], { period: "today" });
    expect(makassarToday.businessDate).toBe("2025-06-11");
    expect(makassarToday.tiles[0]?.period).toMatchObject({
      startDate: "2025-06-11",
      endDate: "2025-06-11",
      status: "open",
    });
  });

  it("resolves presets on the outlet date, not the default clock's", async () => {
    const yesterday = await valuesAt([makassar], { period: "yesterday" });
    expect(yesterday.tiles[0]?.period).toMatchObject({
      startDate: "2025-06-10",
      endDate: "2025-06-10",
      status: "closed",
    });
  });

  it("closes a period by the outlet's own today", async () => {
    const custom = {
      period: "custom",
      startDate: "2025-06-10",
      endDate: "2025-06-10",
    };
    // The 10th is over in Makassar, still today in Jakarta.
    expect((await valuesAt([makassar], custom)).tiles[0]?.period.status).toBe(
      "closed",
    );
    expect((await valuesAt([jakarta], custom)).tiles[0]?.period.status).toBe(
      "open",
    );
  });

  it("takes the earliest outlet date when outlets differ", async () => {
    const both = await valuesAt([jakarta, makassar, jayapura], {
      period: "today",
    });
    expect(both.businessDate).toBe("2025-06-10");
    const custom = {
      period: "custom",
      startDate: "2025-06-10",
      endDate: "2025-06-10",
    };
    // One outlet is still on the 10th, so the period is not closed for the set.
    expect(
      (await valuesAt([jakarta, makassar, jayapura], custom)).tiles[0]?.period
        .status,
    ).toBe("open");
    // Tenant scope (no outlet filter) reads every outlet: same earliest date.
    expect((await valuesAt([], { period: "today" })).businessDate).toBe(
      "2025-06-10",
    );
  });

  it("follows the outlet cutoff after midnight", async () => {
    // 22:30 UTC = 05:30 Jakarta on the 11th: past the 04:00 cutoff, before 06:00.
    const night = new Date("2025-06-10T22:30:00Z");
    expect((await layoutAt([jakarta], night)).businessDate).toBe("2025-06-11");
    expect((await layoutAt([cutoffLate], night)).businessDate).toBe(
      "2025-06-10",
    );
    const late = await valuesAt([cutoffLate], { period: "today" }, night);
    expect(late.businessDate).toBe("2025-06-10");
    expect(late.tiles[0]?.period.status).toBe("open");
  });
});
