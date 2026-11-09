// GET /api/metrics/query follows the report-run access rule (bead
// legend-svrzc, routes/report-viewer.ts): each metric is read under the
// permissions of its source report (`definition.sourceReport`). Holding them
// reads the metric on the outlets they reach; lacking them,
// `report.aggregate.view` reads it tenant-wide as aggregates only when the
// source report accepts the aggregate view; otherwise 403
// REPORT_NOT_PERMITTED. The outlets of a query are the intersection over its
// metrics; an empty intersection is 403, never a tenant-wide read.
//
// Metrics used: `net_sales` (source `sales.daily`: report.sales.view, accepts
// the aggregate view) and `cogs` (source `inventory.food_cost`:
// report.operational.view, does not accept it). Every run builds its own
// tenant with two outlets and a small ledger.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { businessDateSchema, idr, tenantIdSchema } from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
} from "@starter/shared/accounting";
import { metricQueryResponseSchema } from "@starter/shared/metrics";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { agent, setRole, signUp, verifySessionMfa } from "./helpers";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

type Client = ReturnType<typeof agent>;

const PATH = "/api/metrics/query";
const JUNE = { startDate: "2025-06-01", endDate: "2025-06-30" };

let app: Express;
let tenantId: string;
let host: string;
let entityId: string;
let outlet1: string;
let outlet2: string;
const accounts = {
  cash: randomUUID(),
  inventory: randomUUID(),
  revenue: randomUUID(),
  discount: randomUUID(),
  cogs: randomUUID(),
};

let full: Client; // every report permission, tenant
let financialOnly: Client; // report.financial.view, tenant
let salesOutlet1: Client; // report.sales.view, outlet1 only
let shareholder: Client; // report.aggregate.view, tenant
let disjoint: Client; // sales on outlet1, operational on outlet2
let nobody: Client; // no report permission
let operationalTenant: Client; // report.operational.view only, tenant
let mixed: Client; // operational on outlet1, report.aggregate.view tenant

// ---- Helpers ----------------------------------------------------------------

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

async function post(date: string, outletId: string, lines: JournalLineInput[]) {
  const ctx = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: entityId,
      outletId,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji akses metrik",
      lines,
      postedBy: null,
      idempotencyKey: `metrics-access-${randomUUID()}`,
    }),
  );
}

async function insertRole(
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

async function assign(
  userId: string,
  roleId: string,
  scopeType: "tenant" | "outlet",
  scopeId: string | null,
) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scopeType, scopeId],
  );
}

/** A signed-in user holding `grants` (role, scope type, outlet or null). */
async function viewer(
  label: string,
  grants: [string, "tenant" | "outlet", string | null][],
): Promise<Client> {
  const client = agent(app);
  const email = await signUp(client, label);
  await setRole(email, null);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  for (const [roleId, scopeType, scopeId] of grants)
    await assign(userId, roleId, scopeType, scopeId);
  await verifySessionMfa(email);
  return client;
}

const query = (
  client: Client,
  metricCodes: string[],
  extra: Record<string, unknown> = {},
) =>
  client
    .get(PATH)
    .set("Host", host)
    .query({ metricCodes, period: JUNE, ...extra });

/** Total-bucket rupiah of a metric (no dimension). */
function idrOf(body: unknown, metricCode: string): number {
  const series = metricQueryResponseSchema
    .parse(body)
    .data.series.find(
      (entry) => entry.metricCode === metricCode && entry.dimension === null,
    );
  expect(series, `series for ${metricCode}`).toBeDefined();
  expect(series!.points).toHaveLength(1);
  const value = series!.points[0]!.value as {
    unit: string;
    valueIdr: number;
  } | null;
  expect(value, `${metricCode} has a value`).not.toBeNull();
  expect(value!.unit).toBe("idr");
  return value!.valueIdr;
}

function expectNotPermitted(response: {
  status: number;
  body: { error?: { code?: string } };
}) {
  expect(response.status).toBe(403);
  expect(response.body.error?.code).toBe("REPORT_NOT_PERMITTED");
}

beforeAll(async () => {
  app = createApp();
  const tenant = await createIsolatedTenant(`mqa-${randomUUID().slice(0, 6)}`);
  tenantId = tenant.tenantId;
  host = tenant.hostname;
  entityId = tenant.legalEntityId;
  outlet1 = tenant.outletId;
  outlet2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Dua', address, timezone, opening_hours, status
     FROM outlets WHERE id = $3`,
    [outlet2, `O2-${randomUUID().slice(0, 8)}`.toUpperCase(), outlet1],
  );
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
      tenantId,
      entityId,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3), ($1, $2, 'sales_discount', $4),
            ($1, $2, 'cogs', $5), ($1, $2, 'inventory', $6)
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
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2025-06')`,
    [tenantId, entityId],
  );

  // Outlet 1: 950k net sales (1,000k - 50k discount), cogs 300k.
  // Outlet 2: 400k net sales, cogs 120k. Tenant: 1,350k and 420k.
  const sale = (date: string, outlet: string, amount: number) =>
    post(date, outlet, [
      line(accounts.cash, amount, 0, outlet),
      line(accounts.revenue, 0, amount, outlet),
    ]);
  const cogs = (date: string, outlet: string, amount: number) =>
    post(date, outlet, [
      line(accounts.cogs, amount, 0, outlet),
      line(accounts.inventory, 0, amount, outlet),
    ]);
  await sale("2025-06-10", outlet1, 1_000_000);
  await cogs("2025-06-10", outlet1, 300_000);
  await sale("2025-06-11", outlet2, 400_000);
  await cogs("2025-06-11", outlet2, 120_000);
  await post("2025-06-20", outlet1, [
    line(accounts.discount, 50_000, 0, outlet1),
    line(accounts.cash, 0, 50_000, outlet1),
  ]);

  const roles = {
    full: await insertRole(
      "Penuh uji akses metrik",
      [
        "report.operational.view",
        "report.sales.view",
        "report.financial.view",
        "report.aggregate.view",
      ],
      ["tenant"],
    ),
    financial: await insertRole(
      "Keuangan saja",
      ["report.financial.view"],
      ["tenant"],
    ),
    sales: await insertRole(
      "Penjualan outlet",
      ["report.sales.view"],
      ["outlet"],
    ),
    operational: await insertRole(
      "Operasional outlet",
      ["report.operational.view"],
      ["outlet"],
    ),
    operationalTenant: await insertRole(
      "Operasional tenant",
      ["report.operational.view"],
      ["tenant"],
    ),
    aggregate: await insertRole(
      "Agregat tenant",
      ["report.aggregate.view"],
      ["tenant"],
    ),
    shareholder: await insertRole(
      "Shareholder",
      ["dashboard.shareholder.view", "report.aggregate.view"],
      ["tenant"],
      "shareholder",
    ),
  };
  full = await viewer("Penuh akses metrik", [[roles.full, "tenant", null]]);
  financialOnly = await viewer("Keuangan akses metrik", [
    [roles.financial, "tenant", null],
  ]);
  salesOutlet1 = await viewer("Sales outlet akses metrik", [
    [roles.sales, "outlet", outlet1],
  ]);
  shareholder = await viewer("Shareholder akses metrik", [
    [roles.shareholder, "tenant", null],
  ]);
  disjoint = await viewer("Terpisah akses metrik", [
    [roles.sales, "outlet", outlet1],
    [roles.operational, "outlet", outlet2],
  ]);
  nobody = await viewer("Tanpa izin akses metrik", []);
  operationalTenant = await viewer("Operasional tenant akses metrik", [
    [roles.operationalTenant, "tenant", null],
  ]);
  mixed = await viewer("Campuran akses metrik", [
    [roles.operational, "outlet", outlet1],
    [roles.aggregate, "tenant", null],
  ]);
});

afterAll(async () => {
  await owner.end();
});

// ---- Source report permission -------------------------------------------------

describe("GET /api/metrics/query: source report decides access", () => {
  it("answers 403 REPORT_NOT_PERMITTED without the source report's permission", async () => {
    // report.financial.view alone used to open every metric; net_sales needs
    // sales.daily's report.sales.view, cogs needs report.operational.view.
    expectNotPermitted(await query(financialOnly, ["net_sales"]));
    expectNotPermitted(await query(financialOnly, ["cogs"]));
    expectNotPermitted(await query(nobody, ["net_sales"]));
  });

  it("admits a caller holding the source permission on its outlet, for that outlet only", async () => {
    const response = await query(salesOutlet1, ["net_sales"]);
    expect(response.status).toBe(200);
    expect(idrOf(response.body, "net_sales")).toBe(950_000);
    expect(JSON.stringify(response.body)).not.toContain("1350000");
  });

  it("reads the whole tenant for a caller holding every source permission tenant-wide", async () => {
    const response = await query(full, ["net_sales", "cogs"]);
    expect(response.status).toBe(200);
    expect(idrOf(response.body, "net_sales")).toBe(1_350_000);
    expect(idrOf(response.body, "cogs")).toBe(420_000);
  });

  it("refuses a query whose metrics' outlets do not intersect instead of reading tenant-wide", async () => {
    expect((await query(disjoint, ["net_sales"])).status).toBe(200);
    expectNotPermitted(await query(disjoint, ["net_sales", "cogs"]));
  });
});

// ---- Aggregate view ---------------------------------------------------------

describe("GET /api/metrics/query: aggregate view only for whitelisted source reports", () => {
  it("gives a shareholder the tenant aggregate of a metric whose source report accepts it", async () => {
    const response = await query(shareholder, ["net_sales"]);
    expect(response.status).toBe(200);
    expect(idrOf(response.body, "net_sales")).toBe(1_350_000);
  });

  it("refuses a shareholder a metric whose source report is not on the aggregate list", async () => {
    expectNotPermitted(await query(shareholder, ["cogs"]));
    expectNotPermitted(await query(shareholder, ["net_sales", "cogs"]));
  });
});

// ---- Unknown code -------------------------------------------------------------

describe("GET /api/metrics/query: code without a source report", () => {
  it("keeps 404 for a permitted caller and 403 for a caller without report permissions", async () => {
    const unknown = await query(full, ["no_such_metric"]);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe("METRIC_NOT_FOUND");
    expectNotPermitted(await query(nobody, ["no_such_metric"]));
  });
});

// ---- Review fixes (R1) ----------------------------------------------------------

describe("GET /api/metrics/query: report-run rule edge cases", () => {
  it("opens cogs to report.operational.view alone (access widened from report.financial.view)", async () => {
    const response = await query(operationalTenant, ["cogs"]);
    expect(response.status).toBe(200);
    expect(idrOf(response.body, "cogs")).toBe(420_000);
  });

  it("reads the outlet intersection when one request mixes a full-permission metric and an aggregate-only metric", async () => {
    // cogs: operational on outlet1 only. net_sales: no sales permission, so
    // the tenant-wide aggregate view applies. The read covers outlet1 only.
    const response = await query(mixed, ["cogs", "net_sales"]);
    expect(response.status).toBe(200);
    expect(idrOf(response.body, "cogs")).toBe(300_000);
    expect(idrOf(response.body, "net_sales")).toBe(950_000);
    expect(JSON.stringify(response.body)).not.toContain("1350000");
  });

  it("answers 403 for an outlet filter outside the caller's reach", async () => {
    const response = await query(salesOutlet1, ["net_sales"], {
      outletIds: outlet2,
    });
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("400000");
  });

  it("records what a catalog code plus an unknown code in one request does", async () => {
    const response = await query(full, ["net_sales", "no_such_metric"]);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error?.code).toBe("METRIC_NOT_FOUND");
  });
});
