// Backdated revaluation must post EVERY positive month of the new schedule up to
// the horizon, also the months that were "zero" under the old schedule (the old
// schedule posted nothing there, so there was nothing to take back), and must
// refuse the whole event when ANY month it would write is closed. Source of the
// rules: the ledger-guards brief, item 5 (second-opinion finding), not the
// service code.
//
// Rules under test:
// - Report case: an asset of Rp3 (so small that straight-line over 12 months
//   gives 1 rupiah to the first three months and 0 to the rest) is revalued
//   backdated to Rp12,000,000. The new schedule is 1,200,000/month from March.
//   After the revaluation the accumulated depreciation up to October is
//   9,600,000 (March..October, 8 x 1,200,000), book value 2,400,000. Old
//   behaviour re-posted only the one month that had been taken back (March).
// - A closed month that the new schedule would write (even a month that had no
//   old row) refuses the revaluation 409 PERIOD_CLOSED and NOTHING is written
//   (no reversal, no repost, no revaluation row, no journal).
//
// Assumptions (spec silent):
// - "Rp3" in the report is 3 rupiah (a cost whose old monthly amounts are zero
//   for most months); with Rp3 million no month would be zero and the report
//   could not happen.
// - splitIdrEvenly hands the remainder to the first months, so the old
//   schedule posts 1 rupiah in 2026-01, 2026-02, 2026-03 and nothing after.
//   The assertions below do not depend on which months carry the remainder
//   except that March (after the event) is one of them.
// - The horizon is the last month already run before the revaluation: the test
//   runs depreciation up to 2026-10 first (nothing is posted for the zero
//   months, but the run covers them), so October is the horizon. The month
//   after the horizon (2026-11) is posted by the next normal run only.
// - A revaluation dated 2026-02-25 restarts the schedule in March over the
//   remaining 10 of 12 months (same derivation as
//   accounting-fixed-asset-revaluation-repost.test.ts).
// - Accumulated depreciation after the revaluation is the new-basis rows only
//   (elimination method), as the repost test shows.
//
// Runs the real PostgreSQL test DB; every test owns a fresh legal entity.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import { POSTING_ACCOUNT_ROLES } from "@starter/shared/accounting";
import {
  createFixedAsset,
  getFixedAsset,
  revalueFixedAsset,
  runDepreciation,
} from "../services/accounting-fixed-assets.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");
const key = (prefix: string) => `${prefix}-${unique()}-${unique()}`;
/** Fixed "now" for service calls: every test date below is in the past. */
const NOW = new Date("2026-11-03T03:00:00Z");
const actor: UserId = userIdSchema.parse(randomUUID());

function tenantScope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function createEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

/** Chart + posting-role mappings that depreciation and revaluation post through. */
async function setupLedger(entity: string): Promise<void> {
  const rows: [string, string, string, string, string][] = [
    ["bank", "1103", "Bank Operasional", "asset", "cash_and_equivalents"],
    ["fixed_assets", "1501", "Aset Tetap", "asset", "non_current_asset"],
    [
      "accumulated_depreciation",
      "1502",
      "Akumulasi Penyusutan",
      "asset",
      "non_current_asset",
    ],
    ["revaluation_surplus", "3201", "Surplus Revaluasi", "equity", "equity"],
    [
      "asset_disposal_result",
      "7101",
      "Laba/Rugi Pelepasan Aset",
      "revenue",
      "other_income",
    ],
    [
      "depreciation_expense",
      "6101",
      "Beban Penyusutan",
      "expense",
      "operating_expense",
    ],
    [
      "asset_revaluation_loss",
      "6102",
      "Rugi Revaluasi",
      "expense",
      "other_expense",
    ],
  ];
  for (const [role, code, label, type, group] of rows) {
    const { rows: inserted } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, label, type, group],
    );
    if (!(role in POSTING_ACCOUNT_ROLES)) continue;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, inserted[0]!.id],
    );
  }
}

async function closePeriod(entity: string, period: string): Promise<void> {
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
     VALUES ($1, $2, $3, 'closed', $4, now())
     ON CONFLICT (tenant_id, legal_entity_id, period)
     DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now(),
         version = fiscal_periods.version + (CASE WHEN fiscal_periods.status = 'closed' THEN 0 ELSE 1 END)`,
    [tenantId, entity, period, actor],
  );
}

// Cost Rp3 over 12 months from 2026-01: 1 rupiah in the first three months,
// zero afterwards (see the assumptions above).
const tinyAsset = (entity: string) =>
  createFixedAsset(
    tenantScope(),
    {
      legalEntityId: entity,
      outletId: outletA,
      name: "Mesin espresso nilai kecil",
      acquiredOn: "2026-01-05",
      costIdr: 3,
      residualValueIdr: 0,
      usefulLifeMonths: 12,
      depreciationStartPeriod: "2026-01",
      sourceDocumentId: null,
      idempotencyKey: key("fa"),
    },
    actor,
    NOW,
  );

const run = (entity: string, period: string) =>
  runDepreciation(
    tenantScope(),
    { legalEntityId: entity, period, idempotencyKey: key("run") },
    actor,
    NOW,
  );

const revalue = (
  assetId: string,
  revaluedOn: string,
  newCarryingAmountIdr: number,
) =>
  revalueFixedAsset(
    tenantScope(),
    assetId,
    {
      revaluedOn,
      newCarryingAmountIdr,
      reason: "Penilaian mundur",
      idempotencyKey: key("reval"),
    },
    actor,
    NOW,
  );

/** The asset, depreciated up to October (zero months post nothing). */
async function assetRunThroughOctober(name: string) {
  const entity = await createEntity(name);
  await setupLedger(entity);
  const machine = await tinyAsset(entity);
  await run(entity, "2026-10");
  return { entity, machine };
}

// ---- Ledger readers (straight from the tables) -------------------------------

/** Active depreciation rows of the asset (no reversal): oldest first. */
async function depreciationRows(
  assetId: string,
): Promise<{ period: string; amount: number }[]> {
  const { rows } = await owner.query<{ period: string; amount_idr: string }>(
    `SELECT d.period, d.amount_idr FROM fixed_asset_depreciations d
      WHERE d.tenant_id = $1 AND d.fixed_asset_id = $2
        AND NOT EXISTS (SELECT 1 FROM fixed_asset_depreciation_reversals r
                         WHERE r.tenant_id = d.tenant_id AND r.depreciation_id = d.id)
      ORDER BY d.period`,
    [tenantId, assetId],
  );
  return rows.map((row) => ({
    period: row.period,
    amount: Number(row.amount_idr),
  }));
}

/** Every depreciation row incl. taken-back ones: period + generation + amount. */
async function allDepreciationRows(
  assetId: string,
): Promise<[string, number, number][]> {
  const { rows } = await owner.query<{
    period: string;
    generation: number;
    amount_idr: string;
  }>(
    `SELECT period, generation, amount_idr FROM fixed_asset_depreciations
      WHERE tenant_id = $1 AND fixed_asset_id = $2 ORDER BY period, generation`,
    [tenantId, assetId],
  );
  return rows.map((row) => [
    row.period,
    Number(row.generation),
    Number(row.amount_idr),
  ]);
}

/** Net debit (+) / credit (−) per account code for the whole legal entity. */
async function netByCode(entity: string): Promise<Record<string, number>> {
  const { rows } = await owner.query<{ code: string; net: string }>(
    `SELECT a.code, SUM(l.debit_idr - l.credit_idr) AS net
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
      GROUP BY a.code`,
    [tenantId, entity],
  );
  return Object.fromEntries(rows.map((row) => [row.code, Number(row.net)]));
}

/** Entries of the entity whose debit total differs from the credit total. */
async function unbalancedEntries(entity: string): Promise<string[]> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT e.id FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
      GROUP BY e.id HAVING SUM(l.debit_idr) <> SUM(l.credit_idr)`,
    [tenantId, entity],
  );
  return rows.map((row) => row.id);
}

/** Everything a refused event must leave untouched (incl. taken-back and reposted rows). */
async function footprint(entity: string, assetId: string) {
  const count = async (sql: string) =>
    Number(
      (await owner.query<{ n: string }>(sql, [tenantId, entity])).rows[0]!.n,
    );
  const { rows: assetRows } = await owner.query(
    `SELECT cost_idr, accumulated_depreciation_idr, status, useful_life_months,
            depreciation_start_period, disposal_journal_entry_id
       FROM fixed_assets WHERE tenant_id = $1 AND id = $2`,
    [tenantId, assetId],
  );
  return {
    entries: await count(
      "SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    ),
    lines: await count(
      `SELECT count(*) AS n FROM journal_lines l
         JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
        WHERE e.tenant_id = $1 AND e.legal_entity_id = $2`,
    ),
    revaluations: await count(
      `SELECT count(*) AS n FROM fixed_asset_revaluations r
         JOIN fixed_assets a ON a.tenant_id = r.tenant_id AND a.id = r.fixed_asset_id
        WHERE a.tenant_id = $1 AND a.legal_entity_id = $2`,
    ),
    reversalRows: await count(
      `SELECT count(*) AS n FROM fixed_asset_depreciation_reversals r
         JOIN fixed_asset_depreciations d ON d.tenant_id = r.tenant_id AND d.id = r.depreciation_id
         JOIN fixed_assets a ON a.tenant_id = d.tenant_id AND a.id = d.fixed_asset_id
        WHERE a.tenant_id = $1 AND a.legal_entity_id = $2`,
    ),
    allDepreciation: await allDepreciationRows(assetId),
    depreciation: await depreciationRows(assetId),
    asset: assetRows[0],
    net: await netByCode(entity),
  };
}

const MARCH_TO_OCTOBER = [
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
  "2026-10",
];

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("backdated revaluation also posts the months that were zero under the old schedule", () => {
  it("ACC-01 an asset of Rp3 revalued to Rp12 million (dated February) accumulates 9,600,000 up to October, every month posted once", async () => {
    const { entity, machine } = await assetRunThroughOctober(
      "Reval zero months report case",
    );
    // Old schedule: 1 rupiah in Jan-Mar, nothing after; fully depreciated.
    const before = await getFixedAsset(tenantScope(), machine.id);
    expect(before.asset.accumulatedDepreciationIdr).toBe(3);
    expect(before.asset.bookValueIdr).toBe(0);

    const revalued = await revalue(machine.id, "2026-02-25", 12_000_000);
    expect(revalued.costIdr).toBe(12_000_000);
    expect(revalued.usefulLifeMonths).toBe(10);
    expect(revalued.depreciationStartPeriod).toBe("2026-03");

    // Jan + Feb keep their old rows; March..October are on the new base,
    // including April..October that had no row before.
    const active = await depreciationRows(machine.id);
    expect(active.map((row) => [row.period, row.amount])).toEqual([
      ["2026-01", 1],
      ["2026-02", 1],
      ...MARCH_TO_OCTOBER.map((period) => [period, 1_200_000]),
    ]);
    // The only row taken back is the old March one (1 rupiah), still stored.
    const all = await allDepreciationRows(machine.id);
    expect(all.filter(([, generation]) => generation === 1)[2]).toEqual([
      "2026-03",
      1,
      1,
    ]);
    expect(all.filter(([period]) => period === "2026-03")).toHaveLength(2);
    expect(
      all.filter(([period]) => period !== "2026-03" && period > "2026-02"),
    ).toHaveLength(7);

    // Register: accumulated = new-basis rows only = 8 x 1,200,000.
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.costIdr).toBe(12_000_000);
    expect(fetched.accumulatedDepreciationIdr).toBe(9_600_000);
    expect(fetched.bookValueIdr).toBe(2_400_000);
    expect(revalued.accumulatedDepreciationIdr).toBe(9_600_000);
    expect(revalued.bookValueIdr).toBe(2_400_000);

    // Ledger agrees with the register and stays balanced.
    expect(await unbalancedEntries(entity)).toEqual([]);
    const net = await netByCode(entity);
    expect(net["1502"]).toBe(-9_600_000);
    expect(net["6101"]).toBe(9_600_002);
    expect((net["1501"] ?? 0) + (net["1502"] ?? 0)).toBe(
      fetched.bookValueIdr,
    );
    expect(Object.values(net).reduce((sum, value) => sum + value, 0)).toBe(0);

    // The next normal run posts November alone, not the months above again.
    const november = await run(entity, "2026-11");
    expect(november.amountIdr).toBe(1_200_000);
    const { asset: afterNovember } = await getFixedAsset(
      tenantScope(),
      machine.id,
    );
    expect(afterNovember.accumulatedDepreciationIdr).toBe(10_800_000);
    expect(afterNovember.bookValueIdr).toBe(1_200_000);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });

  it("ACC-02 a closed month that had no old row but would be written by the new schedule refuses the revaluation 409 PERIOD_CLOSED and writes nothing", async () => {
    const { entity, machine } = await assetRunThroughOctober(
      "Reval zero months closed new month",
    );
    // July had no depreciation under the old schedule, so no old journal sits
    // there; the new schedule would still post 1,200,000 into it.
    await closePeriod(entity, "2026-07");
    const untouched = await footprint(entity, machine.id);

    await expect(
      revalue(machine.id, "2026-02-25", 12_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });

    expect(await footprint(entity, machine.id)).toEqual(untouched);
    expect(untouched.revaluations).toBe(0);
    expect(untouched.reversalRows).toBe(0);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.costIdr).toBe(3);
    expect(fetched.accumulatedDepreciationIdr).toBe(3);
    expect(fetched.bookValueIdr).toBe(0);
  });

  it("ACC-02 a refused revaluation (closed new month) leaves the old schedule intact: a later run posts nothing on the old base", async () => {
    const { entity, machine } = await assetRunThroughOctober(
      "Reval zero months closed then run",
    );
    await closePeriod(entity, "2026-10");

    await expect(
      revalue(machine.id, "2026-02-25", 12_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });

    const november = await run(entity, "2026-11");
    expect(november.amountIdr).toBe(0);
    expect(
      (await allDepreciationRows(machine.id)).map(
        ([period, generation, amount]) => [period, generation, amount],
      ),
    ).toEqual([
      ["2026-01", 1, 1],
      ["2026-02", 1, 1],
      ["2026-03", 1, 1],
    ]);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });
});
