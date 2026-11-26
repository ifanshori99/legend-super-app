// Finance family of the metric registry (F6, bead legend-qlirp; CTO decisions
// docs/briefs/1272-d2-keputusan.md). Every money figure is reconciled with an
// oracle read straight from journal_lines, and in a closed fiscal month also
// with the balance snapshot of that month:
// - ebitda: income statement accounts less the accounts mapped to the
//   depreciation, amortization, interest and income tax roles (and their
//   children). An entity that has not mapped one of those roles keeps it in
//   the figure and the answer says "Belum memisahkan ...".
// - cash_balance / bank_balance: ledger balance of the cash_on_hand +
//   petty_cash accounts and of the bank accounts at the period end.
// - finance.* reports split by legal_entity where every metric can.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  outletIdSchema,
  tenantIdSchema,
  userIdSchema,
  type OutletQueryFilter,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  standardFnbChartTemplate,
  type JournalLineInput,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import {
  reportDefinitionByCode,
  reportMetricByCode,
} from "@starter/shared/dashboard";
import type { MetricDimensionKey } from "@starter/shared/metrics";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import { metricSourceOf } from "../services/metric-sources";
import { NON_GL_MONEY_METRICS } from "../services/metrics-gl-sources";
import {
  evaluateMetrics,
  withTenantSnapshot,
  type EvaluatedMetrics,
} from "../services/metrics-query.service";
import { createIsolatedTenant, owner } from "./floor-test-helpers";

const LATE = new Date("2025-12-20T05:00:00Z");
const JUNE = { start: "2025-06-01", end: "2025-06-30" };
const JULY = { start: "2025-07-01", end: "2025-07-31" };
const EXCLUDED_ROLES = [
  "depreciation_expense",
  "amortization_expense",
  "interest_expense",
  "income_tax_expense",
] as const;

type Entity = {
  id: string;
  outlet: string;
  accounts: Record<string, string>;
};

let tenantId: string;
let entityA: Entity;
let entityB: Entity;

function context(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const date = (value: string) => businessDateSchema.parse(value);

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
    outletId: outletId === null ? null : outletIdSchema.parse(outletId),
    costCenter: null,
  };
}

/** Debit `debit` / credit `credit` for `amount`, at the outlet or the entity. */
async function post(
  entity: Entity,
  day: string,
  debit: string,
  credit: string,
  amount: number,
  atOutlet: boolean,
) {
  const ctx = context();
  const outletId = atOutlet ? entity.outlet : null;
  await withTenant(db, ctx, (tx) =>
    postJournalInTransaction(tx, ctx, {
      legalEntityId: entity.id as never,
      outletId: outletId === null ? null : outletIdSchema.parse(outletId),
      entryDate: date(day),
      sourceType: "manual" as const,
      sourceId: randomUUID(),
      description: "Uji laporan keuangan",
      lines: [
        line(entity.accounts[debit]!, amount, 0, outletId),
        line(entity.accounts[credit]!, 0, amount, outletId),
      ],
      postedBy: null,
      idempotencyKey: `ms-finance-${randomUUID()}`,
    }),
  );
}

type AccountSeed = {
  key: string;
  code: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  group: string;
  role?: PostingAccountRole;
  parent?: string;
};

async function chart(entity: Entity, seeds: readonly AccountSeed[]) {
  for (const seed of seeds) {
    const id = randomUUID();
    entity.accounts[seed.key] = id;
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        tenantId,
        entity.id,
        seed.code,
        `Akun ${seed.key}`,
        seed.type,
        seed.group,
        seed.parent ? entity.accounts[seed.parent]! : null,
      ],
    );
    if (seed.role)
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, entity.id, seed.role, id],
      );
  }
}

const BASE_ACCOUNTS: readonly AccountSeed[] = [
  {
    key: "cash",
    code: "1101",
    type: "asset",
    group: "cash_and_equivalents",
    role: "cash_on_hand",
  },
  {
    key: "petty",
    code: "1102",
    type: "asset",
    group: "cash_and_equivalents",
    role: "petty_cash",
  },
  {
    key: "bank",
    code: "1103",
    type: "asset",
    group: "cash_and_equivalents",
    role: "bank",
  },
  { key: "accum", code: "1502", type: "asset", group: "non_current_asset" },
  { key: "equity", code: "3101", type: "equity", group: "equity" },
  {
    key: "revenue",
    code: "4101",
    type: "revenue",
    group: "revenue",
    role: "sales_revenue",
  },
  { key: "cogs", code: "5101", type: "expense", group: "cogs", role: "cogs" },
  {
    key: "salary",
    code: "6101",
    type: "expense",
    group: "operating_expense",
    role: "salary_expense",
  },
  {
    key: "depreciation",
    code: "6104",
    type: "expense",
    group: "operating_expense",
    role: "depreciation_expense",
  },
];

/** A sub-account opened under A's mapped depreciation account. */
const CHILD_ACCOUNTS: readonly AccountSeed[] = [
  {
    key: "depreciationVehicle",
    code: "6104.1",
    type: "expense",
    group: "operating_expense",
    parent: "depreciation",
  },
];

/** Accounts that entity A maps and entity B leaves unmapped. */
const EXTRA_ROLE_ACCOUNTS: readonly AccountSeed[] = [
  {
    key: "amortization",
    code: "6113",
    type: "expense",
    group: "operating_expense",
    role: "amortization_expense",
  },
  {
    key: "interest",
    code: "8103",
    type: "expense",
    group: "other_expense",
    role: "interest_expense",
  },
  {
    key: "incomeTax",
    code: "8104",
    type: "expense",
    group: "other_expense",
    role: "income_tax_expense",
  },
];

/** Same accounts, no role: B books interest and tax but never maps them. */
const UNMAPPED_EXTRA: readonly AccountSeed[] = EXTRA_ROLE_ACCOUNTS.map(
  (seed) => ({ ...seed, role: undefined }),
);

function evaluate(
  metricCodes: string[],
  period: { start: string; end: string },
  groupBy: MetricDimensionKey[] = [],
  outletFilter: OutletQueryFilter = { kind: "all" },
): Promise<EvaluatedMetrics> {
  const ctx = context();
  return withTenantSnapshot(ctx, (tx) =>
    evaluateMetrics(
      tx,
      ctx,
      {
        metricCodes,
        period: { start: date(period.start), end: date(period.end) },
        bucket: "total",
        outletFilter,
        groupBy,
        filters: [],
        comparePrevious: false,
        viewer: "full",
      },
      LATE,
    ),
  );
}

/** Rupiah per split value (dimension values joined by "|", "" = total). */
function amounts(
  result: EvaluatedMetrics,
  code: string,
): Map<string, number | null> {
  return new Map(
    result.series
      .filter((series) => series.metricCode === code)
      .map((series) => {
        const value = series.points[0]?.value;
        return [
          series.dimensions.map((dimension) => dimension.value).join("|"),
          value && value.unit === "idr" ? Number(value.valueIdr) : null,
        ];
      }),
  );
}

// ---- Oracles: journal_lines and snapshots, never the engine -----------------

const ENTITY_FILTER = `($2::uuid IS NULL OR e.legal_entity_id = $2::uuid)`;

/** Accounts (with children) mapped to the excluded roles, per entity. */
const excludedAccounts = (rolesParam: string) => `
  WITH RECURSIVE excluded (id) AS (
    SELECT m.account_id FROM account_mappings m
     WHERE m.tenant_id = $1 AND m.role = ANY(${rolesParam}::text[])
    UNION
    SELECT c.id FROM chart_of_accounts c JOIN excluded x ON c.parent_id = x.id
     WHERE c.tenant_id = $1
  )`;

async function journalEbitda(
  range: { start: string; end: string },
  entityId: string | null = null,
): Promise<number> {
  const { rows } = await owner.query<{ v: string }>(
    `${excludedAccounts("$5")}
     SELECT COALESCE(SUM(l.credit_idr - l.debit_idr), 0)::text AS v
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
       JOIN chart_of_accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND ${ENTITY_FILTER}
        AND e.entry_date BETWEEN $3::date AND $4::date
        AND a.report_group IN ('revenue', 'other_income', 'cogs', 'operating_expense', 'other_expense')
        AND a.id NOT IN (SELECT id FROM excluded)`,
    [tenantId, entityId, range.start, range.end, EXCLUDED_ROLES],
  );
  return Number(rows[0]!.v);
}

async function journalBalance(
  roles: readonly PostingAccountRole[],
  end: string,
  entityId: string | null = null,
): Promise<number> {
  const { rows } = await owner.query<{ v: string }>(
    `SELECT COALESCE(SUM(l.debit_idr - l.credit_idr), 0)::text AS v
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND ${ENTITY_FILTER}
        AND e.entry_date <= $3::date
        AND l.account_id IN (SELECT account_id FROM account_mappings
                              WHERE tenant_id = $1 AND role = ANY($4::text[]))`,
    [tenantId, entityId, end, roles],
  );
  return Number(rows[0]!.v);
}

/** June is the first closed month: its cumulative snapshot is its movement. */
async function snapshotEbitda(): Promise<number> {
  const { rows } = await owner.query<{ v: string }>(
    `${excludedAccounts("$2")}
     SELECT COALESCE(SUM(sl.credit_idr - sl.debit_idr), 0)::text AS v
       FROM fiscal_period_snapshot_lines sl
       JOIN fiscal_period_snapshots s ON s.id = sl.snapshot_id AND s.tenant_id = sl.tenant_id
       JOIN chart_of_accounts a ON a.id = sl.account_id AND a.tenant_id = sl.tenant_id
      WHERE s.tenant_id = $1 AND s.period = '2025-06'
        AND a.report_group IN ('revenue', 'other_income', 'cogs', 'operating_expense', 'other_expense')
        AND a.id NOT IN (SELECT id FROM excluded)`,
    [tenantId, EXCLUDED_ROLES],
  );
  return Number(rows[0]!.v);
}

async function snapshotBalance(
  roles: readonly PostingAccountRole[],
): Promise<number> {
  const { rows } = await owner.query<{ v: string }>(
    `SELECT COALESCE(SUM(sl.debit_idr - sl.credit_idr), 0)::text AS v
       FROM fiscal_period_snapshot_lines sl
       JOIN fiscal_period_snapshots s ON s.id = sl.snapshot_id AND s.tenant_id = sl.tenant_id
      WHERE s.tenant_id = $1 AND s.period = '2025-06'
        AND sl.account_id IN (SELECT account_id FROM account_mappings
                               WHERE tenant_id = $1 AND role = ANY($2::text[]))`,
    [tenantId, roles],
  );
  return Number(rows[0]!.v);
}

// ---- World ------------------------------------------------------------------

beforeAll(async () => {
  const tenant = await createIsolatedTenant(`msf-${randomUUID().slice(0, 6)}`);
  tenantId = tenant.tenantId;
  entityA = { id: tenant.legalEntityId, outlet: tenant.outletId, accounts: {} };
  entityB = { id: randomUUID(), outlet: randomUUID(), accounts: {} };
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entitas B', false)`,
    [entityB.id, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, $2, $3, 'Outlet Entitas B', address, timezone, opening_hours, status
     FROM outlets WHERE id = $4`,
    [
      entityB.outlet,
      entityB.id,
      `OB-${randomUUID().slice(0, 8)}`.toUpperCase(),
      entityA.outlet,
    ],
  );
  await chart(entityA, [
    ...BASE_ACCOUNTS,
    ...CHILD_ACCOUNTS,
    ...EXTRA_ROLE_ACCOUNTS,
  ]);
  await chart(entityB, [...BASE_ACCOUNTS, ...UNMAPPED_EXTRA]);
  const periods: string[] = [];
  for (const entity of [entityA, entityB])
    for (const period of ["2025-06", "2025-07"]) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, entity.id, period],
      );
      if (period === "2025-06") periods.push(rows[0]!.id);
    }

  // Entity A, June (closed): capital into the bank, a float to petty cash,
  // sales, cost of goods, salary and every excluded expense.
  await post(entityA, "2025-06-01", "bank", "equity", 5_000_000, false);
  await post(entityA, "2025-06-02", "petty", "bank", 100_000, true);
  await post(entityA, "2025-06-10", "cash", "revenue", 1_000_000, true);
  await post(entityA, "2025-06-10", "cogs", "cash", 300_000, true);
  await post(entityA, "2025-06-25", "salary", "bank", 200_000, false);
  // The mapped depreciation account is a header: lines post to its child.
  await post(
    entityA,
    "2025-06-30",
    "depreciationVehicle",
    "accum",
    55_000,
    false,
  );
  await post(entityA, "2025-06-30", "amortization", "accum", 10_000, false);
  await post(entityA, "2025-06-30", "interest", "bank", 20_000, false);
  await post(entityA, "2025-06-30", "incomeTax", "bank", 30_000, false);
  // Entity B, June: sales, mapped depreciation, unmapped interest and tax.
  await post(entityB, "2025-06-12", "cash", "revenue", 400_000, true);
  await post(entityB, "2025-06-30", "depreciation", "accum", 40_000, false);
  await post(entityB, "2025-06-30", "interest", "cash", 15_000, false);
  await post(entityB, "2025-06-30", "incomeTax", "cash", 7_000, false);
  // July stays open.
  await post(entityA, "2025-07-05", "cash", "revenue", 600_000, true);
  await post(
    entityA,
    "2025-07-31",
    "depreciationVehicle",
    "accum",
    50_000,
    false,
  );
  await post(entityA, "2025-07-15", "cash", "bank", 250_000, true);

  for (const periodId of periods)
    await closeFiscalPeriod(
      context(),
      periodId,
      { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
      userIdSchema.parse(randomUUID()),
    );
});

afterAll(async () => {
  await owner.end();
});

describe("finance registry (F6)", () => {
  it("ebitda, cash_balance and bank_balance are ledger sources with ledger formulas", () => {
    for (const code of ["ebitda", "cash_balance", "bank_balance"]) {
      expect(metricSourceOf(code).kind, code).toBe("gl");
      expect(NON_GL_MONEY_METRICS, code).not.toContain(code);
      const definition = reportMetricByCode.get(code)!;
      expect(definition.formula.expression, code).toContain("journal_lines");
      expect(definition.version, code).toBeGreaterThanOrEqual(2);
      expect(definition.dimensions, code).toContain("legal_entity");
    }
  });

  it("finance reports split by legal entity where every metric can", () => {
    for (const code of [
      "finance.income_statement",
      "finance.ebitda",
      "finance.cash_position",
      "finance.gross_margin",
      "finance.profit_trend",
    ])
      expect(reportDefinitionByCode.get(code)!.dimensions, code).toContain(
        "legal_entity",
      );
  });

  it("the standard chart maps the three new roles", () => {
    const roles = new Set(standardFnbChartTemplate.flatMap((row) => row.roles));
    for (const role of [
      "amortization_expense",
      "interest_expense",
      "income_tax_expense",
    ])
      expect(roles.has(role as PostingAccountRole), role).toBe(true);
  });
});

describe("ebitda reconciles with the journal", () => {
  it("tenant total: income statement less the excluded roles, children included", async () => {
    const result = await evaluate(["ebitda", "net_profit"], JUNE);
    // A: 1,000,000 - 300,000 - 200,000; B: 400,000 - 15,000 - 7,000 (B never
    // mapped interest or income tax, so both stay in its EBITDA).
    expect(amounts(result, "ebitda").get("")).toBe(878_000);
    expect(amounts(result, "ebitda").get("")).toBe(await journalEbitda(JUNE));
    // net_profit is untouched by the exclusion: every expense counts.
    expect(amounts(result, "net_profit").get("")).toBe(
      1_400_000 -
        300_000 -
        200_000 -
        55_000 -
        10_000 -
        20_000 -
        30_000 -
        40_000 -
        15_000 -
        7_000,
    );
  });

  it("the closed month is final and equals the balance snapshot", async () => {
    const result = await evaluate(["ebitda"], JUNE);
    const point = result.series[0]!.points[0]!;
    expect(point.finality).toBe("final");
    expect(amounts(result, "ebitda").get("")).toBe(await snapshotEbitda());
  });

  it("per legal entity: each entity's own excluded roles", async () => {
    const result = await evaluate(["ebitda"], JUNE, ["legal_entity"]);
    const values = amounts(result, "ebitda");
    expect(values.get(entityA.id)).toBe(500_000);
    expect(values.get(entityA.id)).toBe(await journalEbitda(JUNE, entityA.id));
    expect(values.get(entityB.id)).toBe(378_000);
    expect(values.get(entityB.id)).toBe(await journalEbitda(JUNE, entityB.id));
  });

  it("an open month is an estimate and still reconciles", async () => {
    const result = await evaluate(["ebitda"], JULY);
    expect(result.series[0]!.points[0]!.finality).toBe("estimate");
    expect(amounts(result, "ebitda").get("")).toBe(600_000);
    expect(amounts(result, "ebitda").get("")).toBe(await journalEbitda(JULY));
  });

  it("an entity without a mapping for an excluded role gets a note, not a guess", async () => {
    const all = await evaluate(["ebitda", "net_profit"], JUNE);
    expect(all.availability[0]).toEqual({
      metricCode: "ebitda",
      status: "available",
      note: "Belum memisahkan beban amortisasi, beban bunga, beban pajak penghasilan; angkanya masih ikut dihitung.",
    });
    // Metrics without exclusions never carry a note.
    expect(all.availability[1]).toEqual({
      metricCode: "net_profit",
      status: "available",
    });
    // Entity A alone has every role mapped: no note.
    const onlyA = await evaluate(["ebitda"], JUNE, [], {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(entityA.outlet)],
    });
    expect(onlyA.availability[0]).toEqual({
      metricCode: "ebitda",
      status: "available",
    });
  });
});

describe("cash and bank balances reconcile with the journal", () => {
  it("tenant balance at the period end, closed month equals its snapshot", async () => {
    const result = await evaluate(["cash_balance", "bank_balance"], JUNE);
    const cash = amounts(result, "cash_balance").get("");
    const bank = amounts(result, "bank_balance").get("");
    // A: cash 1,000,000 - 300,000, petty 100,000; B: 400,000 - 22,000.
    expect(cash).toBe(1_178_000);
    expect(cash).toBe(
      await journalBalance(["cash_on_hand", "petty_cash"], JUNE.end),
    );
    expect(cash).toBe(await snapshotBalance(["cash_on_hand", "petty_cash"]));
    // 5,000,000 - 100,000 - 200,000 - 20,000 - 30,000.
    expect(bank).toBe(4_650_000);
    expect(bank).toBe(await journalBalance(["bank"], JUNE.end));
    expect(bank).toBe(await snapshotBalance(["bank"]));
    for (const series of result.series)
      expect(series.points[0]!.finality).toBe("final");
  });

  it("a later month carries the balance forward", async () => {
    const result = await evaluate(["cash_balance", "bank_balance"], JULY);
    expect(amounts(result, "cash_balance").get("")).toBe(
      await journalBalance(["cash_on_hand", "petty_cash"], JULY.end),
    );
    expect(amounts(result, "bank_balance").get("")).toBe(4_400_000);
  });

  it("per legal entity", async () => {
    const result = await evaluate(["cash_balance"], JUNE, ["legal_entity"]);
    const values = amounts(result, "cash_balance");
    expect(values.get(entityA.id)).toBe(
      await journalBalance(
        ["cash_on_hand", "petty_cash"],
        JUNE.end,
        entityA.id,
      ),
    );
    expect(values.get(entityB.id)).toBe(378_000);
  });

  it("an outlet's share of a balance is not guessed", async () => {
    const result = await evaluate(["cash_balance"], JUNE, ["outlet"]);
    expect(result.availability[0]).toMatchObject({
      status: "unavailable",
      reason: "dimension_not_supported",
    });
  });
});

describe("finance percents per legal entity", () => {
  it("gross_margin_pct splits from gross_profit over net_sales per entity", async () => {
    const result = await evaluate(["gross_margin_pct"], JUNE, ["legal_entity"]);
    expect(result.availability[0]).toMatchObject({ status: "available" });
    const values = new Map(
      result.series.map((series) => [
        series.dimensions[0]!.value,
        series.points[0]!.value,
      ]),
    );
    expect(values.get(entityA.id)).toEqual({
      unit: "percent",
      value: "70.0000",
    });
    expect(values.get(entityB.id)).toEqual({
      unit: "percent",
      value: "100.0000",
    });
  });
});
