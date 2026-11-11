// Backdated revaluation must re-post the months it took back (finding 3) and
// a backdated event must be refused when a LATER revaluation exists even if no
// depreciation was posted after it (finding 4). Source of the rules: the 497
// findings brief (ledger guards, bead WS-E), not the service code.
//
// Rules under test:
// - Finding 3: a revaluation dated before posted runs reverses the depreciation
//   of the months AFTER the event and posts those months again, on the new
//   base, inside the SAME revaluation transaction. Book value is never counted
//   twice: register (getFixedAsset) = cost - active depreciation rows = ledger
//   (1501 + 1502). When any affected month is closed the revaluation is refused
//   409 PERIOD_CLOSED and NOTHING is written (no reversal, no repost, no
//   revaluation row, no journal).
// - Finding 4: the check "is there a later revaluation/disposal" runs before the
//   "no later depreciation" early return. A backdated disposal or revaluation
//   dated before an existing revaluation is refused 409 CONFLICT, nothing written.
//
// Assumptions (spec silent):
// - After a revaluation dated 2026-02-25 to 12,000,000 the schedule restarts in
//   March: 12,000,000 over 10 months = 1,200,000/month (same numbers as
//   accounting-fixed-asset-backdated-events.test.ts).
// - The re-posted month is the next generation (2) of that month; the taken-back
//   row keeps generation 1.
// - The repost journal date is not asserted (only that it is a new, balanced
//   journal), the closed-month rule is asserted through the refusal.
// - Finding 4 refusal code for a backdated REVALUATION is the same as for a
//   backdated disposal (409 CONFLICT, as the existing disposal test shows).
// - A "later disposal" cannot be probed: a disposed asset refuses every further
//   event with ASSET_ALREADY_DISPOSED before any date check.
//
// NOTE for the service engineer: the older test in
// accounting-fixed-asset-backdated-events.test.ts "a revaluation dated before
// posted runs reverses the later months and re-spreads the new base" asserts
// that March is NOT re-posted until the April run (rows [Jan, Feb], April run =
// 2,400,000). That contradicts finding 3 and must be updated with the fix.
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
  disposeFixedAsset,
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

/** Chart + posting-role mappings that depreciation, revaluation and disposal post through. */
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

// 12,000,000 over 12 months = 1,000,000 per month, starting 2026-01.
const asset = (entity: string) =>
  createFixedAsset(
    tenantScope(),
    {
      legalEntityId: entity,
      outletId: outletA,
      name: "Mesin espresso",
      acquiredOn: "2026-01-05",
      costIdr: 12_000_000,
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

const dispose = (assetId: string, disposedOn: string, proceedsIdr: number) =>
  disposeFixedAsset(
    tenantScope(),
    assetId,
    {
      disposedOn,
      proceedsIdr,
      reason: "Dijual mundur",
      idempotencyKey: key("disp"),
    },
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

// ---- Ledger readers (straight from the tables) -------------------------------

/** Active depreciation rows of the asset (no reversal): oldest first. */
async function depreciationRows(
  assetId: string,
): Promise<{ period: string; amount: number; journalEntryId: string }[]> {
  const { rows } = await owner.query<{
    period: string;
    amount_idr: string;
    journal_entry_id: string;
  }>(
    `SELECT d.period, d.amount_idr, d.journal_entry_id FROM fixed_asset_depreciations d
      WHERE d.tenant_id = $1 AND d.fixed_asset_id = $2
        AND NOT EXISTS (SELECT 1 FROM fixed_asset_depreciation_reversals r
                         WHERE r.tenant_id = d.tenant_id AND r.depreciation_id = d.id)
      ORDER BY d.period`,
    [tenantId, assetId],
  );
  return rows.map((row) => ({
    period: row.period,
    amount: Number(row.amount_idr),
    journalEntryId: row.journal_entry_id,
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

/** Ledger book value of the fixed-asset accounts: cost (1501) + accumulated (1502), debit positive. */
function ledgerBookValue(net: Record<string, number>): number {
  return (net["1501"] ?? 0) + (net["1502"] ?? 0);
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

/** Taken-back rows: `id` = correcting journal, `reversalOf` = original journal. */
async function reversals(
  entity: string,
): Promise<{ id: string; reversalOf: string }[]> {
  const { rows } = await owner.query<{ id: string; reversal_of: string }>(
    `SELECT r.journal_entry_id AS id, d.journal_entry_id AS reversal_of
       FROM fixed_asset_depreciation_reversals r
       JOIN fixed_asset_depreciations d ON d.tenant_id = r.tenant_id AND d.id = r.depreciation_id
       JOIN fixed_assets a ON a.tenant_id = d.tenant_id AND a.id = d.fixed_asset_id
      WHERE r.tenant_id = $1 AND a.legal_entity_id = $2
      ORDER BY d.period`,
    [tenantId, entity],
  );
  return rows.map((row) => ({ id: row.id, reversalOf: row.reversal_of }));
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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("finding 3: backdated revaluation re-posts the affected months", () => {
  it("ACC-01 a revaluation dated before a posted run takes March back and posts it again on the new base in the same call; book value is not doubled", async () => {
    const entity = await createEntity("Reval repost one month");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    const marchJournal = (await depreciationRows(machine.id))[2]!
      .journalEntryId;
    const ledgerBefore = ledgerBookValue(await netByCode(entity));
    const registerBefore = (await getFixedAsset(tenantScope(), machine.id))
      .asset.bookValueIdr;
    expect(registerBefore).toBe(9_000_000);

    // February carrying amount 10,000,000 revalued to 12,000,000: the schedule
    // restarts in March at 1,200,000/month.
    const revalued = await revalue(machine.id, "2026-02-25", 12_000_000);
    expect(revalued.costIdr).toBe(12_000_000);
    expect(revalued.usefulLifeMonths).toBe(10);
    expect(revalued.depreciationStartPeriod).toBe("2026-03");

    // March is posted again immediately: old-basis row taken back (generation
    // 1), new-basis row active (generation 2). No second run needed.
    expect(await allDepreciationRows(machine.id)).toEqual([
      ["2026-01", 1, 1_000_000],
      ["2026-02", 1, 1_000_000],
      ["2026-03", 1, 1_000_000],
      ["2026-03", 2, 1_200_000],
    ]);
    const active = await depreciationRows(machine.id);
    expect(active.map((row) => [row.period, row.amount])).toEqual([
      ["2026-01", 1_000_000],
      ["2026-02", 1_000_000],
      ["2026-03", 1_200_000],
    ]);
    expect(active[2]!.journalEntryId).not.toBe(marchJournal);
    const reversed = await reversals(entity);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.reversalOf).toBe(marchJournal);

    // Register: accumulated = the new-basis rows only (elimination method);
    // book value = new cost - accumulated; the returned asset says the same.
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.costIdr).toBe(12_000_000);
    expect(fetched.accumulatedDepreciationIdr).toBe(1_200_000);
    expect(fetched.bookValueIdr).toBe(10_800_000);
    expect(revalued.accumulatedDepreciationIdr).toBe(1_200_000);
    expect(revalued.bookValueIdr).toBe(10_800_000);

    // Ledger agrees: expense = Jan + Feb + new March, accumulated account holds
    // only the new March charge, and the fixed-asset accounts moved by exactly
    // the register change (9,000,000 -> 10,800,000), not by a doubled March.
    expect(await unbalancedEntries(entity)).toEqual([]);
    const net = await netByCode(entity);
    expect(net["6101"]).toBe(3_200_000);
    expect(net["1502"]).toBe(-1_200_000);
    expect(ledgerBookValue(net) - ledgerBefore).toBe(
      fetched.bookValueIdr - registerBefore,
    );
    expect(Object.values(net).reduce((sum, value) => sum + value, 0)).toBe(0);

    // The April run posts April alone, not March again.
    const april = await run(entity, "2026-04");
    expect(april.amountIdr).toBe(1_200_000);
    const { asset: afterApril } = await getFixedAsset(
      tenantScope(),
      machine.id,
    );
    expect(afterApril.accumulatedDepreciationIdr).toBe(2_400_000);
    expect(afterApril.bookValueIdr).toBe(9_600_000);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });

  it("ACC-01 a revaluation dated before several posted runs re-posts every affected month, each exactly once", async () => {
    const entity = await createEntity("Reval repost two months");
    await setupLedger(entity);
    const machine = await asset(entity);
    for (const period of ["2026-01", "2026-02", "2026-03", "2026-04"])
      await run(entity, period);
    const originals = await depreciationRows(machine.id);

    const revalued = await revalue(machine.id, "2026-02-25", 12_000_000);

    expect(await allDepreciationRows(machine.id)).toEqual([
      ["2026-01", 1, 1_000_000],
      ["2026-02", 1, 1_000_000],
      ["2026-03", 1, 1_000_000],
      ["2026-03", 2, 1_200_000],
      ["2026-04", 1, 1_000_000],
      ["2026-04", 2, 1_200_000],
    ]);
    const active = await depreciationRows(machine.id);
    expect(active.map((row) => [row.period, row.amount])).toEqual([
      ["2026-01", 1_000_000],
      ["2026-02", 1_000_000],
      ["2026-03", 1_200_000],
      ["2026-04", 1_200_000],
    ]);
    // Months before the event keep their original journals.
    expect(active[0]!.journalEntryId).toBe(originals[0]!.journalEntryId);
    expect(active[1]!.journalEntryId).toBe(originals[1]!.journalEntryId);
    expect(
      (await reversals(entity)).map((row) => row.reversalOf).sort(),
    ).toEqual(
      [originals[2]!.journalEntryId, originals[3]!.journalEntryId].sort(),
    );

    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.accumulatedDepreciationIdr).toBe(2_400_000);
    expect(fetched.bookValueIdr).toBe(9_600_000);
    expect(revalued.bookValueIdr).toBe(9_600_000);

    expect(await unbalancedEntries(entity)).toEqual([]);
    const net = await netByCode(entity);
    expect(net["6101"]).toBe(4_400_000);
    expect(net["1502"]).toBe(-2_400_000);
    expect(Object.values(net).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("ACC-02 a revaluation whose affected month is closed is refused 409 PERIOD_CLOSED and writes nothing, even when an earlier affected month is open", async () => {
    const entity = await createEntity("Reval repost closed later month");
    await setupLedger(entity);
    const machine = await asset(entity);
    for (const period of ["2026-01", "2026-02", "2026-03", "2026-04"])
      await run(entity, period);
    // March (open) would be fine alone; April (closed) must stop the whole thing.
    await closePeriod(entity, "2026-04");
    const untouched = await footprint(entity, machine.id);

    await expect(
      revalue(machine.id, "2026-02-25", 12_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });

    expect(await footprint(entity, machine.id)).toEqual(untouched);
    expect(untouched.revaluations).toBe(0);
    expect(untouched.reversalRows).toBe(0);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.costIdr).toBe(12_000_000);
    expect(fetched.accumulatedDepreciationIdr).toBe(4_000_000);
    expect(fetched.bookValueIdr).toBe(8_000_000);
  });

  it("ACC-02 a refused backdated revaluation leaves the old schedule intact: the next run still posts on the old base", async () => {
    const entity = await createEntity("Reval repost refused then run");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    await closePeriod(entity, "2026-03");

    await expect(
      revalue(machine.id, "2026-02-25", 12_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });

    const april = await run(entity, "2026-04");
    expect(april.amountIdr).toBe(1_000_000);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.accumulatedDepreciationIdr).toBe(4_000_000);
    expect(fetched.bookValueIdr).toBe(8_000_000);
    expect(await allDepreciationRows(machine.id)).toEqual([
      ["2026-01", 1, 1_000_000],
      ["2026-02", 1, 1_000_000],
      ["2026-03", 1, 1_000_000],
      ["2026-04", 1, 1_000_000],
    ]);
  });

  it("ACC-02 a closed month before the event, which nothing re-posts, does not block the revaluation", async () => {
    const entity = await createEntity("Reval repost closed earlier");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    await closePeriod(entity, "2026-01");

    const revalued = await revalue(machine.id, "2026-02-25", 12_000_000);

    expect(revalued.costIdr).toBe(12_000_000);
    expect(
      (await depreciationRows(machine.id)).map((row) => [
        row.period,
        row.amount,
      ]),
    ).toEqual([
      ["2026-01", 1_000_000],
      ["2026-02", 1_000_000],
      ["2026-03", 1_200_000],
    ]);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.bookValueIdr).toBe(10_800_000);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });
});

describe("finding 4: a later revaluation blocks a backdated event even without later depreciation", () => {
  // Runs Jan-Mar, revaluation on 2026-03-25 (restart in April). No April run:
  // no depreciation row lies after either backdated event below, which is the
  // path that used to return early before the later-revaluation check.
  async function withLaterRevaluation(name: string) {
    const entity = await createEntity(name);
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    await revalue(machine.id, "2026-03-25", 9_000_000);
    return { entity, machine };
  }

  it("ACC-01 a disposal dated before a later revaluation is refused 409 CONFLICT and writes nothing", async () => {
    const { entity, machine } = await withLaterRevaluation(
      "Later reval blocks disposal",
    );
    const settled = await footprint(entity, machine.id);

    await expect(dispose(machine.id, "2026-03-10", 1)).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });

    expect(await footprint(entity, machine.id)).toEqual(settled);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.status).toBe("active");
  });

  it("ACC-01 a revaluation dated before a later revaluation is refused 409 CONFLICT and writes nothing", async () => {
    const { entity, machine } = await withLaterRevaluation(
      "Later reval blocks revaluation",
    );
    const settled = await footprint(entity, machine.id);

    await expect(
      revalue(machine.id, "2026-03-10", 11_000_000),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });

    expect(await footprint(entity, machine.id)).toEqual(settled);
    expect(settled.revaluations).toBe(1);
  });

  it("ACC-01 an event dated after the last revaluation is still accepted", async () => {
    const { entity, machine } = await withLaterRevaluation(
      "Later reval control",
    );

    const sold = await dispose(machine.id, "2026-04-15", 9_000_000);

    expect(sold.status).toBe("disposed");
    expect(await unbalancedEntries(entity)).toEqual([]);
  });
});
