// Backdated asset disposal / revaluation (bead legend-i5kc, replaces the
// fail-closed 409 CONFLICT of ACC-01 §3.19 when an event predates posted
// depreciation). Design (append-only, migration 0311): fixed_asset_depreciations
// is never updated or deleted. The depreciation rows of the months AFTER the
// event are taken back by fixed_asset_depreciation_reversals rows, and ONE
// correcting journal per original journal (this asset only, debit/credit
// mirrored, dated like the original) is posted. Other assets sharing a run
// journal are untouched. When any correcting journal would land in or before a
// closed month the event is refused with 409 PERIOD_CLOSED, nothing written.
//
// Assumptions (spec silent):
// - The event month itself keeps its depreciation (a February disposal keeps
//   February's charge, as the existing "caught up" disposal tests show).
// - A multi-month catch-up journal (Feb-Apr dated April) is not reversed as a
//   whole: only the rows after the event are taken back by a correction dated
//   like that journal, so April is the affected (closed-checked) month.
// - After a backdated revaluation the schedule restarts the month after the
//   event with the new base (cost 12,000,000 over 10 months = 1,200,000/month);
//   a month taken back and posted again is the next generation of that month.
//
// Runs the real PostgreSQL test DB; every test owns a fresh legal entity.
// The older test in accounting-ap-fa.test.ts ("a disposal/revaluation dated
// before an already-posted run ...") was updated together with this behaviour.

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
     DO UPDATE SET status = 'closed', closed_by = $4, closed_at = now()`,
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

/**
 * Taken-back depreciation rows of the entity's assets: `id` = the correcting
 * journal, `reversalOf` = the original journal the row was posted in.
 */
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

/** Net debit (+) / credit (−) per account code of one journal entry. */
async function netOfEntry(entryId: string): Promise<Record<string, number>> {
  const { rows } = await owner.query<{ code: string; net: string }>(
    `SELECT a.code, SUM(l.debit_idr - l.credit_idr) AS net
       FROM journal_lines l
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND l.entry_id = $2
      GROUP BY a.code`,
    [tenantId, entryId],
  );
  return Object.fromEntries(rows.map((row) => [row.code, Number(row.net)]));
}

/** Per account, original + reversal net to zero (the reversal mirrors it fully). */
async function entriesCancelOut(ids: string[]): Promise<boolean> {
  const { rows } = await owner.query<{ net: string }>(
    `SELECT SUM(debit_idr - credit_idr) AS net FROM journal_lines
      WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])
      GROUP BY account_id, outlet_id`,
    [tenantId, ids],
  );
  return rows.length > 0 && rows.every((row) => Number(row.net) === 0);
}

/** Everything a refused event must leave untouched. */
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

describe("legend-i5kc backdated disposal / revaluation", () => {
  it("ACC-01 §3.19 a disposal dated before posted runs reverses the later months; book value is not doubled and the ledger agrees with the register", async () => {
    const entity = await createEntity("Backdated dispose");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    const before = await depreciationRows(machine.id);
    expect(before.map((row) => row.period)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    const marchJournal = before[2]!.journalEntryId;

    // Sold in February for 500,000 above the February carrying amount
    // (12,000,000 − 2 × 1,000,000 = 10,000,000). March's charge must go.
    const sold = await dispose(machine.id, "2026-02-20", 10_500_000);
    expect(sold.status).toBe("disposed");
    expect(sold.accumulatedDepreciationIdr).toBe(2_000_000);
    expect(sold.bookValueIdr).toBe(10_000_000);
    expect(sold.disposalResultIdr).toBe(500_000);

    // Accumulated = the rows that are left; March is gone, January/February stay.
    const after = await depreciationRows(machine.id);
    expect(after.map((row) => [row.period, row.amount])).toEqual([
      ["2026-01", 1_000_000],
      ["2026-02", 1_000_000],
    ]);
    expect(after.reduce((sum, row) => sum + row.amount, 0)).toBe(
      sold.accumulatedDepreciationIdr,
    );
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.status).toBe("disposed");
    expect(fetched.accumulatedDepreciationIdr).toBe(2_000_000);
    expect(fetched.bookValueIdr).toBe(10_000_000);
    expect(fetched.disposalResultIdr).toBe(500_000);

    // March's journal is reversed exactly once, mirrored line for line.
    const reversed = await reversals(entity);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.reversalOf).toBe(marchJournal);
    expect(await entriesCancelOut([marchJournal, reversed[0]!.id])).toBe(true);

    // Ledger: every entry balanced; expense = 2 months only; the accumulated
    // account is emptied by the disposal (no phantom March credit left behind);
    // bank got the proceeds; the disposal result is the gain.
    expect(await unbalancedEntries(entity)).toEqual([]);
    const net = await netByCode(entity);
    expect(net["6101"]).toBe(2_000_000);
    expect(net["1502"]).toBe(0);
    expect(net["1103"]).toBe(10_500_000);
    expect(net["7101"]).toBe(-500_000);
    expect(Object.values(net).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("ACC-01 §3.19 a disposed asset is not depreciated again and the reversal is not reversed a second time", async () => {
    const entity = await createEntity("Backdated dispose twice");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    await dispose(machine.id, "2026-02-20", 10_000_000);
    const settled = await footprint(entity, machine.id);
    const reversalIds = (await reversals(entity)).map((row) => row.id);
    expect(reversalIds).toHaveLength(1);

    // A second disposal and a later run change nothing.
    await expect(dispose(machine.id, "2026-02-21", 1)).rejects.toMatchObject({
      status: 409,
      code: "ASSET_ALREADY_DISPOSED",
    });
    const april = await run(entity, "2026-04");
    expect(april.amountIdr).toBe(0);
    expect(april.journalEntryId).toBeNull();
    expect(await footprint(entity, machine.id)).toEqual(settled);

    // The reversal entry itself was never reversed.
    const reversalsAfter = await reversals(entity);
    expect(reversalsAfter.map((row) => row.id)).toEqual(reversalIds);
    expect(
      reversalsAfter.some((row) => reversalIds.includes(row.reversalOf)),
    ).toBe(false);
  });

  it("ACC-01 §3.19 a multi-month catch-up journal is corrected for the months after the event only; the months that still apply stay", async () => {
    const entity = await createEntity("Backdated catch-up journal");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    // Skipping February and March: the April run posts Feb–Apr in ONE journal.
    await run(entity, "2026-04");
    const before = await depreciationRows(machine.id);
    expect(before.map((row) => row.period)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    const catchUpJournal = before[1]!.journalEntryId;
    expect(before[2]!.journalEntryId).toBe(catchUpJournal);
    expect(before[3]!.journalEntryId).toBe(catchUpJournal);

    const sold = await dispose(machine.id, "2026-02-20", 10_000_000);
    expect(sold.accumulatedDepreciationIdr).toBe(2_000_000);
    expect(sold.bookValueIdr).toBe(10_000_000);
    expect(sold.disposalResultIdr).toBe(0);

    // March and April are taken back by ONE correction (2,000,000, mirrored)
    // dated like the catch-up journal; February stays on the original journal.
    const after = await depreciationRows(machine.id);
    expect(after.map((row) => [row.period, row.amount])).toEqual([
      ["2026-01", 1_000_000],
      ["2026-02", 1_000_000],
    ]);
    expect(after[1]!.journalEntryId).toBe(catchUpJournal);
    const reversed = await reversals(entity);
    expect(reversed).toHaveLength(2);
    expect(reversed.every((row) => row.reversalOf === catchUpJournal)).toBe(
      true,
    );
    const correction = reversed[0]!.id;
    expect(reversed[1]!.id).toBe(correction);
    expect(await netOfEntry(correction)).toEqual({
      "1502": 2_000_000,
      "6101": -2_000_000,
    });

    expect(await unbalancedEntries(entity)).toEqual([]);
    const net = await netByCode(entity);
    expect(net["6101"]).toBe(2_000_000);
    expect(net["1502"]).toBe(0);
    expect(net["1103"]).toBe(10_000_000);
    expect(net["7101"] ?? 0).toBe(0);
    expect(Object.values(net).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("ACC-01 §3.19 a revaluation dated before posted runs reverses the later months and re-spreads the new base without doubling value", async () => {
    const entity = await createEntity("Backdated revaluation");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    const marchJournal = (await depreciationRows(machine.id))[2]!
      .journalEntryId;

    // February carrying amount is 10,000,000; revalued to 12,000,000 (elimination
    // method: accumulated restarts at 0, cost = new carrying amount).
    const revalued = await revalue(machine.id, "2026-02-25", 12_000_000);
    expect(revalued.costIdr).toBe(12_000_000);
    expect(revalued.accumulatedDepreciationIdr).toBe(0);
    expect(revalued.bookValueIdr).toBe(12_000_000);
    expect(revalued.usefulLifeMonths).toBe(10);
    expect(revalued.depreciationStartPeriod).toBe("2026-03");

    // March's old-basis charge is gone: no row for it, journal reversed once.
    expect(
      (await depreciationRows(machine.id)).map((row) => row.period),
    ).toEqual(["2026-01", "2026-02"]);
    const reversed = await reversals(entity);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.reversalOf).toBe(marchJournal);
    expect(await entriesCancelOut([marchJournal, reversed[0]!.id])).toBe(true);

    // Ledger agrees with the register: Jan+Feb expense only, accumulated
    // account back to 0 (2,000,000 credited, 2,000,000 eliminated), all balanced.
    expect(await unbalancedEntries(entity)).toEqual([]);
    const net = await netByCode(entity);
    expect(net["6101"]).toBe(2_000_000);
    expect(net["1502"]).toBe(revalued.accumulatedDepreciationIdr);

    // The new schedule starts in March at 1,200,000/month: an April run catches
    // up March + April on the new base, not on top of the old March charge.
    const april = await run(entity, "2026-04");
    expect(april.amountIdr).toBe(2_400_000);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.accumulatedDepreciationIdr).toBe(2_400_000);
    expect(fetched.bookValueIdr).toBe(9_600_000);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });

  it("ACC-02 a backdated disposal or revaluation whose reversal would touch a closed month is refused PERIOD_CLOSED and writes nothing", async () => {
    const entity = await createEntity("Backdated closed month");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    await closePeriod(entity, "2026-03");
    const untouched = await footprint(entity, machine.id);

    await expect(
      dispose(machine.id, "2026-02-20", 10_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });
    await expect(
      revalue(machine.id, "2026-02-25", 12_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });

    expect(await footprint(entity, machine.id)).toEqual(untouched);
    expect(untouched.asset).toMatchObject({ status: "active" });
    expect(await reversals(entity)).toEqual([]);
    const { asset: fetched } = await getFixedAsset(tenantScope(), machine.id);
    expect(fetched.status).toBe("active");
    expect(fetched.accumulatedDepreciationIdr).toBe(3_000_000);
    expect(fetched.bookValueIdr).toBe(9_000_000);
  });

  it("ACC-02 a closed month that a multi-month catch-up journal sits in also refuses the event, with nothing written", async () => {
    const entity = await createEntity("Backdated closed catch-up");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-04"); // Feb–Apr journal dated in April
    await closePeriod(entity, "2026-04");
    const untouched = await footprint(entity, machine.id);

    await expect(
      dispose(machine.id, "2026-02-20", 10_000_000),
    ).rejects.toMatchObject({ status: 409, code: "PERIOD_CLOSED" });
    expect(await footprint(entity, machine.id)).toEqual(untouched);
    expect(await reversals(entity)).toEqual([]);
  });

  it("ACC-02 a closed month before the event, which nothing has to touch, does not block the backdated disposal", async () => {
    const entity = await createEntity("Backdated closed earlier");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    await closePeriod(entity, "2026-01");

    const sold = await dispose(machine.id, "2026-02-20", 10_000_000);
    expect(sold.status).toBe("disposed");
    expect(sold.accumulatedDepreciationIdr).toBe(2_000_000);
    expect(sold.bookValueIdr).toBe(10_000_000);
    expect(
      (await depreciationRows(machine.id)).map((row) => row.period),
    ).toEqual(["2026-01", "2026-02"]);
    expect(await reversals(entity)).toHaveLength(1);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });

  it("ACC-01 a backdated event corrects this asset only: the shared run journal and the other asset stay untouched; book value follows the active rows", async () => {
    const entity = await createEntity("Backdated other asset");
    await setupLedger(entity);
    const sold = await asset(entity);
    const kept = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    const marchJournal = (await depreciationRows(sold.id))[2]!.journalEntryId;
    expect((await depreciationRows(kept.id))[2]!.journalEntryId).toBe(
      marchJournal,
    );
    const marchBefore = await netOfEntry(marchJournal);
    const keptBefore = await depreciationRows(kept.id);

    const result = await dispose(sold.id, "2026-02-20", 10_000_000);
    expect(result.accumulatedDepreciationIdr).toBe(2_000_000);

    // The shared March journal is not touched; the correction is its own entry
    // and moves only this asset's 1,000,000.
    expect(await netOfEntry(marchJournal)).toEqual(marchBefore);
    const reversed = await reversals(entity);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.id).not.toBe(marchJournal);
    expect(await netOfEntry(reversed[0]!.id)).toEqual({
      "1502": 1_000_000,
      "6101": -1_000_000,
    });
    expect(await depreciationRows(kept.id)).toEqual(keptBefore);
    const { asset: other } = await getFixedAsset(tenantScope(), kept.id);
    expect(other.accumulatedDepreciationIdr).toBe(3_000_000);
    expect(other.bookValueIdr).toBe(9_000_000);

    // Book value = cost − the active rows; expense = 3 + 2 months of the two assets.
    const active = await depreciationRows(sold.id);
    expect(result.bookValueIdr).toBe(
      12_000_000 - active.reduce((sum, row) => sum + row.amount, 0),
    );
    expect((await netByCode(entity))["6101"]).toBe(5_000_000);
    expect(await unbalancedEntries(entity)).toEqual([]);
  });

  it("ACC-01 the same month cannot be posted twice for one asset; it can only be posted again once the earlier row is taken back", async () => {
    const entity = await createEntity("Backdated generation");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await run(entity, "2026-03");
    const insertMarch = (generation: number) =>
      owner.query(
        `INSERT INTO fixed_asset_depreciations
           (tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id, generation)
         SELECT tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id, $3
           FROM fixed_asset_depreciations
          WHERE tenant_id = $1 AND fixed_asset_id = $2 AND period = '2026-03'`,
        [tenantId, machine.id, generation],
      );
    // Same generation, and a newer generation while the row is still active.
    await expect(insertMarch(1)).rejects.toThrow(/DEPRECIATION_ALREADY_POSTED/);
    await expect(insertMarch(2)).rejects.toThrow(/DEPRECIATION_ALREADY_POSTED/);

    await revalue(machine.id, "2026-02-25", 12_000_000);
    const { rows: reversedRows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM fixed_asset_depreciation_reversals WHERE tenant_id = $1 AND journal_entry_id = ANY($2::uuid[])`,
      [tenantId, (await reversals(entity)).map((row) => row.id)],
    );
    expect(Number(reversedRows[0]!.n)).toBe(1);
    // March was taken back: the new schedule posts it again as generation 2,
    // and only one active row per month is left.
    await run(entity, "2026-04");
    const { rows } = await owner.query<{ period: string; generation: number }>(
      `SELECT d.period, d.generation FROM fixed_asset_depreciations d
        WHERE d.tenant_id = $1 AND d.fixed_asset_id = $2 ORDER BY d.period, d.generation`,
      [tenantId, machine.id],
    );
    expect(rows.map((row) => [row.period, row.generation])).toEqual([
      ["2026-01", 1],
      ["2026-02", 1],
      ["2026-03", 1],
      ["2026-03", 2],
      ["2026-04", 1],
    ]);
    expect(
      (await depreciationRows(machine.id)).map((row) => row.period),
    ).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    // A third posting of March is refused again (generation 2 is active).
    await expect(insertMarch(3)).rejects.toThrow(/DEPRECIATION_ALREADY_POSTED/);
  });

  it("ACC-01 the application role cannot update or delete depreciation rows or their reversals", async () => {
    const entity = await createEntity("Backdated append-only");
    await setupLedger(entity);
    const machine = await asset(entity);
    await run(entity, "2026-01");
    await run(entity, "2026-02");
    await dispose(machine.id, "2026-01-20", 12_000_000);
    const appPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    try {
      for (const statement of [
        "DELETE FROM fixed_asset_depreciation_reversals",
        "UPDATE fixed_asset_depreciation_reversals SET reason = 'x'",
        "DELETE FROM fixed_asset_depreciations",
        "UPDATE fixed_asset_depreciations SET amount_idr = 1",
      ]) {
        await appPool.query("BEGIN");
        try {
          await appPool.query("SET LOCAL ROLE legend_app");
          await appPool.query(
            "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
            [tenantId],
          );
          await expect(appPool.query(statement), statement).rejects.toThrow(
            /permission denied/,
          );
        } finally {
          await appPool.query("ROLLBACK");
        }
      }
    } finally {
      await appPool.end();
    }
  });
});
