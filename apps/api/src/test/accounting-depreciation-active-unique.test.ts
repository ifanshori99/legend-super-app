// Finding 5 of docs/briefs/497-findings-fixes.md (0269 generation guard):
// the BEFORE INSERT trigger that refuses a second active generation of the same
// asset+month reads only committed rows, so two concurrent transactions both
// pass it and the ledger can hold two active depreciation rows (book value
// counted twice). Decision (CTO): a unique partial index
// (tenant_id, fixed_asset_id, period) WHERE reversed_at IS NULL serialises
// active generations; `fixed_asset_depreciations.reversed_at timestamptz NULL`
// marks a row that was taken back.
//
// Rules under test: no value counted twice; "book value" = cost minus the sum
// of the ACTIVE rows (ACC-01 spirit for the sub-ledger).
//
// Assumptions (the brief does not pin these down):
// - The race is provoked with raw INSERTs on two connections for a month that
//   has no row yet: one transaction takes generation 1, the other generation 2
//   (both pass the 0269 trigger because neither sees the other). After both
//   try to commit, exactly one active row may exist; the loser fails 23505.
// - `reversed_at` is set exactly for rows that have a reversal row, and stays
//   NULL for every other row, including the new generation of a taken-back month.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allDepreciationRows,
  createAsset,
  disposeAsset,
  failure,
  makeEntity,
  owner,
  revalueAsset,
  runMonth,
  setupAssetLedger,
  tenantId,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

async function activeRows(assetId: string, period: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM fixed_asset_depreciations
      WHERE tenant_id = $1 AND fixed_asset_id = $2 AND period = $3
        AND reversed_at IS NULL`,
    [tenantId, assetId, period],
  );
  return Number(rows[0]!.n);
}

const INSERT_ROW = `INSERT INTO fixed_asset_depreciations
   (tenant_id, fixed_asset_id, period, amount_idr, journal_entry_id, generation)
 VALUES ($1, $2, $3, 1000000, $4, $5)`;

async function seededAsset() {
  const entity = await makeEntity("Depreciation active unique");
  await setupAssetLedger(entity);
  const machine = await createAsset(entity);
  await runMonth(entity, "2026-01");
  const [january] = await allDepreciationRows(machine.id);
  return { entity, machine, january: january! };
}

describe("497 finding 5: one active depreciation row per asset and month, enforced by the database", () => {
  it("ACC-01 a unique partial index covers (tenant, asset, period) for rows that were not taken back", async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'fixed_asset_depreciations'
          AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
          AND indexdef ILIKE '%reversed_at IS NULL%'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.indexdef).toMatch(/\(tenant_id, fixed_asset_id, period\)/);
  });

  it("ACC-01 race: two transactions that both pass the generation trigger cannot both commit an active row for the same month", async () => {
    const { machine, january } = await seededAsset();
    const first = await owner.connect();
    const second = await owner.connect();
    let secondOutcome: { ok: boolean; code?: string } | undefined;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const { rows: pidRows } = await second.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      // Neither sees the other's uncommitted row, so the trigger passes twice.
      await first.query(INSERT_ROW, [
        tenantId,
        machine.id,
        "2026-09",
        january.journalEntryId,
        1,
      ]);
      let settled = false;
      const secondInsert = second
        .query(INSERT_ROW, [
          tenantId,
          machine.id,
          "2026-09",
          january.journalEntryId,
          2,
        ])
        .then(
          () => ({ ok: true }),
          (error: Error & { code?: string }) => ({
            ok: false,
            code: error.code,
          }),
        )
        .finally(() => {
          settled = true;
        });
      // Commit the first transaction only once the second insert has run its
      // trigger: it either finished (no index) or is parked on the first
      // transaction's index entry (index present). Never decided by timing.
      let parked = false;
      for (
        let attempt = 0;
        attempt < 100 && !settled && !parked;
        attempt += 1
      ) {
        const { rows } = await first.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pidRows[0]!.pid],
        );
        parked = rows.length > 0;
        if (!parked && !settled)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(settled || parked).toBe(true);
      await first.query("COMMIT");
      secondOutcome = await secondInsert;
      if (secondOutcome.ok) await second.query("COMMIT");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
    expect(secondOutcome).toEqual({ ok: false, code: "23505" });
    expect(await activeRows(machine.id, "2026-09")).toBe(1);
  });

  it("ACC-01 a sequential second active row for a month is still refused (the generation trigger is not weakened)", async () => {
    const { machine, january } = await seededAsset();
    const error = await failure(
      owner.query(INSERT_ROW, [
        tenantId,
        machine.id,
        "2026-01",
        january.journalEntryId,
        2,
      ]),
    );
    expect(error.code).toBe("23505");
    expect(await activeRows(machine.id, "2026-01")).toBe(1);
  });

  it("ACC-01 reversed_at is set for exactly the rows that were taken back by a backdated disposal, and the book value counts active rows only", async () => {
    const entity = await makeEntity("Depreciation reversed_at");
    await setupAssetLedger(entity);
    const machine = await createAsset(entity);
    await runMonth(entity, "2026-01");
    await runMonth(entity, "2026-02");
    await runMonth(entity, "2026-03");

    const sold = await disposeAsset(machine.id, "2026-02-20", 10_000_000);
    expect(sold.accumulatedDepreciationIdr).toBe(2_000_000);

    const { rows } = await owner.query<{
      period: string;
      reversed_at: Date | null;
      has_reversal: boolean;
    }>(
      `SELECT d.period, d.reversed_at,
              EXISTS (SELECT 1 FROM fixed_asset_depreciation_reversals r
                       WHERE r.tenant_id = d.tenant_id AND r.depreciation_id = d.id) AS has_reversal
         FROM fixed_asset_depreciations d
        WHERE d.tenant_id = $1 AND d.fixed_asset_id = $2
        ORDER BY d.period`,
      [tenantId, machine.id],
    );
    expect(rows.map((row) => [row.period, row.reversed_at !== null])).toEqual([
      ["2026-01", false],
      ["2026-02", false],
      ["2026-03", true],
    ]);
    for (const row of rows)
      expect(row.reversed_at !== null).toBe(row.has_reversal);

    const { rows: sum } = await owner.query<{ active: string }>(
      `SELECT COALESCE(sum(amount_idr), 0)::text AS active FROM fixed_asset_depreciations
        WHERE tenant_id = $1 AND fixed_asset_id = $2 AND reversed_at IS NULL`,
      [tenantId, machine.id],
    );
    expect(Number(sum[0]!.active)).toBe(sold.accumulatedDepreciationIdr);
  });

  it("ACC-01 a month that was taken back may get a new active generation (the index only guards active rows)", async () => {
    const entity = await makeEntity("Depreciation new generation");
    await setupAssetLedger(entity);
    const machine = await createAsset(entity);
    await runMonth(entity, "2026-01");
    await runMonth(entity, "2026-02");
    await runMonth(entity, "2026-03");
    // Backdated revaluation takes March back; the schedule restarts after it.
    await revalueAsset(machine.id, "2026-02-25", 12_000_000);
    await runMonth(entity, "2026-04");

    const rows = await allDepreciationRows(machine.id);
    expect(rows.map((row) => [row.period, row.generation])).toEqual([
      ["2026-01", 1],
      ["2026-02", 1],
      ["2026-03", 1],
      ["2026-03", 2],
      ["2026-04", 1],
    ]);
    expect(await activeRows(machine.id, "2026-03")).toBe(1);
  });
});
