// Metrics carry a legal_entity dimension (bead legend-brq1; DASH-02, SH-02,
// PRD v1.7 §3.19: a tenant may hold several legal entities, each with its own
// books and P&L). Today GET /api/metrics/query sums the ledger of every legal
// entity of the tenant, so a multi-entity tenant cannot see one entity's figure
// without mixing in the others.
//
// Assumptions (the brief does not pin these down):
// - The dimension key is `legal_entity` (CORE_METRIC_DIMENSIONS style
//   lower_snake_case) and is requested as `groupBy=legal_entity`; each series'
//   dimension is { key: "legal_entity", value: <legal entity id> }.
// - Lines without an outlet (entity level) belong to the entity of their
//   journal entry, so they count in that entity's series, not another's.
// - The tenant total without groupBy keeps summing all entities, and the entity
//   series add up to it (DASH-02).
//
// Fixture: one tenant, two legal entities (A, B), one outlet each.
//   A: net sales 1,000,000 (outlet A)
//   B: net sales   400,000 (outlet B) + 250,000 at entity level (no outlet)
// Expected: A 1,000,000; B 650,000; tenant 1,650,000.

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
let entityA: string;
let entityB: string;
let outletA: string;
let outletB: string;
let full: Client;

type EntityBooks = { cash: string; revenue: string; discount: string };
const books: Record<"A" | "B", EntityBooks> = {
  A: { cash: randomUUID(), revenue: randomUUID(), discount: randomUUID() },
  B: { cash: randomUUID(), revenue: randomUUID(), discount: randomUUID() },
};

function line(
  accountId: string,
  debit: number,
  credit: number,
  outletId: string | null,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: outletId as JournalLineInput["outletId"],
    costCenter: null,
  };
}

async function sale(
  legalEntityId: string,
  accounts: EntityBooks,
  outletId: string | null,
  amount: number,
) {
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
      legalEntityId,
      outletId,
      entryDate: businessDateSchema.parse("2025-06-10"),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Uji dimensi badan usaha",
      lines: [
        line(accounts.cash, amount, 0, outletId),
        line(accounts.revenue, 0, amount, outletId),
      ],
      postedBy: null,
      idempotencyKey: `metrics-entity-${randomUUID()}`,
    }),
  );
}

async function setUpEntityBooks(legalEntityId: string, accounts: EntityBooks) {
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $4, $5, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $4, $5, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($3, $4, $5, '4201', 'Diskon penjualan', 'revenue', 'revenue')`,
    [
      accounts.cash,
      accounts.revenue,
      accounts.discount,
      tenantId,
      legalEntityId,
    ],
  );
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, 'sales_revenue', $3), ($1, $2, 'sales_discount', $4)
     ON CONFLICT DO NOTHING`,
    [tenantId, legalEntityId, accounts.revenue, accounts.discount],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2025-06')`,
    [tenantId, legalEntityId],
  );
}

beforeAll(async () => {
  app = createApp();
  const tenant = await createIsolatedTenant(`mle-${randomUUID().slice(0, 6)}`);
  tenantId = tenant.tenantId;
  host = tenant.hostname;
  entityA = tenant.legalEntityId;
  outletA = tenant.outletId;
  entityB = randomUUID();
  outletB = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B uji metrik', false)",
    [entityB, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, $2, $3, 'Outlet Entity B', address, timezone, opening_hours, status
     FROM outlets WHERE id = $4`,
    [outletB, entityB, `OB-${randomUUID().slice(0, 8)}`.toUpperCase(), outletA],
  );
  await setUpEntityBooks(entityA, books.A);
  await setUpEntityBooks(entityB, books.B);

  await sale(entityA, books.A, outletA, 1_000_000);
  await sale(entityB, books.B, outletB, 400_000);
  await sale(entityB, books.B, null, 250_000);

  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Penuh uji dimensi entitas', false, NULL, $3, false, $4)`,
    [
      roleId,
      tenantId,
      JSON.stringify([
        "report.operational.view",
        "report.sales.view",
        "report.financial.view",
        "report.aggregate.view",
      ]),
      JSON.stringify(["tenant"]),
    ],
  );
  full = agent(app);
  const email = await signUp(full, "Penuh dimensi entitas");
  await setRole(email, null);
  const session = await full.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  await verifySessionMfa(email);
});

afterAll(async () => {
  await owner.end();
});

const query = (extra: Record<string, unknown> = {}) =>
  full
    .get(PATH)
    .set("Host", host)
    .query({ metricCodes: ["net_sales"], period: JUNE, ...extra });

/** net_sales series by its dimension value (null = the unsplit total). */
function netSalesByDimension(body: unknown): Map<string | null, number> {
  const result = new Map<string | null, number>();
  for (const series of metricQueryResponseSchema.parse(body).data.series) {
    if (series.metricCode !== "net_sales") continue;
    const value = series.points[0]?.value as { valueIdr: number } | null;
    if (value) result.set(series.dimension?.value ?? null, value.valueIdr);
  }
  return result;
}

describe("legend-brq1 metrics legal_entity dimension (DASH-02)", () => {
  it("DASH-02 groupBy=legal_entity returns one series per legal entity, not a mixed total", async () => {
    const response = await query({ groupBy: "legal_entity" });
    // Today: 400 METRIC_DIMENSION_NOT_SUPPORTED (the dimension does not exist).
    expect(response.body.error?.code).toBeUndefined();
    expect(response.status).toBe(200);
    const parsed = metricQueryResponseSchema.parse(response.body);
    for (const series of parsed.data.series)
      expect(series.dimension?.key).toBe("legal_entity");
    const byEntity = netSalesByDimension(response.body);
    expect(byEntity.get(entityA)).toBe(1_000_000);
    // Entity B keeps its entity-level line (no outlet) and nothing of A's.
    expect(byEntity.get(entityB)).toBe(650_000);
    expect(byEntity.size).toBe(2);
  });

  it("DASH-02 the entity series add up to the tenant total (no line lost or counted twice)", async () => {
    const split = netSalesByDimension(
      (await query({ groupBy: "legal_entity" })).body,
    );
    const total = netSalesByDimension((await query()).body).get(null);
    expect(total).toBe(1_650_000);
    expect([...split.values()].reduce((sum, value) => sum + value, 0)).toBe(
      total,
    );
  });

  it("DASH-02 an empty legal entity shows no mixed-in figures: a month without postings has no value for it", async () => {
    // July has no postings at all: neither entity may borrow the other's June
    // figure; any series that is returned must be zero or have no value.
    const response = await query({
      groupBy: "legal_entity",
      period: { startDate: "2025-07-01", endDate: "2025-07-31" },
    });
    expect(response.status).toBe(200);
    for (const value of netSalesByDimension(response.body).values())
      expect(value).toBe(0);
  });

  it("DASH-02 a percent metric without a split source (gross_margin_pct) is dimension_not_supported by legal entity, never a mixed-entity ratio", async () => {
    // gross_margin_pct has no splitFrom (numerator/denominator pair) in the GL
    // source map, so a per-entity percent is not computed. The documented
    // answer is 200 with availability "unavailable" / dimension_not_supported
    // and only null points; it must never return the tenant ratio as if it
    // belonged to one entity.
    const response = await query({
      metricCodes: ["gross_margin_pct"],
      groupBy: "legal_entity",
    });
    expect(response.status).toBe(200);
    const parsed = metricQueryResponseSchema.parse(response.body);
    expect(parsed.data.availability).toEqual([
      expect.objectContaining({
        metricCode: "gross_margin_pct",
        status: "unavailable",
        reason: "dimension_not_supported",
      }),
    ]);
    for (const series of parsed.data.series)
      for (const point of series.points) expect(point.value).toBeNull();
  });
});
