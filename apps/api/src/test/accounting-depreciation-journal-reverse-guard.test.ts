// Card legend-k048r (docs/briefs/500-shareholder-ledger-guards.md): a manual
// reversal (a journal entry whose `reversal_of` points at the original) of a
// journal that fixed_asset_depreciations or fixed_asset_depreciation_reversals
// references would undo the ledger side while the asset register still counts
// the depreciation, so the book value drifts from the ledger. The database
// refuses it: INSERT into journal_entries with such a `reversal_of` fails with
// SQLSTATE 23514 and the text DEPRECIATION_JOURNAL_LOCKED, for every role.
// The legitimate asset paths (disposal / revaluation corrections written by
// the fixed-asset service) must keep working. This file covers the trigger;
// the service-side 409 lives in the journal service tests.
//
// Assumptions (the brief does not pin these down):
// - The raw reversal entry is dated in the same open month as the journal it
//   points at; the refusal fires on the entry insert, before any line.
// - A reversal of an ordinary (non-depreciation) journal in an open month is
//   still accepted at the database level, with balanced mirrored lines.
// - The correcting journal of a taken-back depreciation row is seeded as the
//   migration owner (a reversal row written by plain SQL as owner).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allDepreciationRows,
  createAsset,
  disposeAsset,
  entryCount,
  failure,
  makeEntity,
  makeFixture,
  owner,
  postCorrection,
  rawInsertEntry,
  runMonth,
  saleLines,
  setupAssetLedger,
  tenantId,
  withAppRole,
  withOwner,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

async function depreciationLedger() {
  const entity = await makeEntity("Depreciation manual reverse guard");
  await setupAssetLedger(entity);
  const machine = await createAsset(entity);
  await runMonth(entity, "2026-01");
  await runMonth(entity, "2026-02");
  await runMonth(entity, "2026-03");
  const rows = await allDepreciationRows(machine.id);
  return { entity, machine, rows };
}

async function placeOf(journalId: string) {
  const { rows } = await owner.query<{
    legal_entity_id: string;
    fiscal_period_id: string;
    entry_date: string;
  }>(
    `SELECT legal_entity_id, fiscal_period_id, entry_date::text AS entry_date
       FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, journalId],
  );
  return {
    entity: rows[0]!.legal_entity_id,
    periodId: rows[0]!.fiscal_period_id,
    date: rows[0]!.entry_date,
  };
}

/** An entry-only manual reversal of `journalId` in the journal's own month. */
async function manualReversal(
  journalId: string,
  runAs: "owner" | "app",
): Promise<string> {
  const place = await placeOf(journalId);
  const write = (client: Parameters<typeof rawInsertEntry>[0]) =>
    rawInsertEntry(client, {
      ...place,
      sourceType: "reversal",
      reversalOf: journalId,
      lines: null,
    });
  return runAs === "owner" ? withOwner(write) : withAppRole(write);
}

async function reversalEntryCount(journalId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
    [tenantId, journalId],
  );
  return Number(rows[0]!.n);
}

describe("legend-k048r a manual reversal of a depreciation journal is refused by the database", () => {
  it("ACC-01 a reversal_of that points at a depreciation run journal is refused with DEPRECIATION_JOURNAL_LOCKED (migration owner)", async () => {
    const { rows } = await depreciationLedger();
    const journalId = rows[1]!.journalEntryId;
    const error = await failure(manualReversal(journalId, "owner"));
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/DEPRECIATION_JOURNAL_LOCKED/);
    expect(await reversalEntryCount(journalId)).toBe(0);
  });

  it("ACC-01 the same raw reversal is refused for the application role (the API's own database role)", async () => {
    const { rows } = await depreciationLedger();
    const journalId = rows[0]!.journalEntryId;
    const error = await failure(manualReversal(journalId, "app"));
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/DEPRECIATION_JOURNAL_LOCKED/);
    expect(await reversalEntryCount(journalId)).toBe(0);
  });

  it("ACC-01 a reversal_of that points at the correcting journal of a taken-back row is refused too", async () => {
    const { rows } = await depreciationLedger();
    const march = rows[2]!;
    const correction = await postCorrection(march.journalEntryId);
    await owner.query(
      `INSERT INTO fixed_asset_depreciation_reversals
         (tenant_id, depreciation_id, journal_entry_id, reason, created_by)
       VALUES ($1, $2, $3, 'Pelepasan mundur (k048r test)', 'test-actor')`,
      [tenantId, march.id, correction],
    );
    const error = await failure(manualReversal(correction, "owner"));
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/DEPRECIATION_JOURNAL_LOCKED/);
    expect(await reversalEntryCount(correction)).toBe(0);
  });

  it("ACC-01 does not over-block: reversing an ordinary journal of an open month is still accepted", async () => {
    const fx = await makeFixture();
    const original = await withOwner((client) =>
      rawInsertEntry(client, {
        entity: fx.entity,
        periodId: fx.feb,
        date: "2025-02-10",
        lines: saleLines(fx, 5_000),
      }),
    );
    const reversal = await withOwner((client) =>
      rawInsertEntry(client, {
        entity: fx.entity,
        periodId: fx.feb,
        date: "2025-02-11",
        sourceType: "reversal",
        reversalOf: original,
        lines: [
          { accountId: fx.cash, debit: 0, credit: 5_000 },
          { accountId: fx.revenue, debit: 5_000, credit: 0 },
        ],
      }),
    );
    expect(reversal).toBeTruthy();
    expect(await entryCount(fx.entity, fx.feb)).toBe(2);
    expect(await reversalEntryCount(original)).toBe(1);
  });

  it("ACC-01 does not break the legitimate asset path: a backdated disposal still corrects the later months", async () => {
    const { machine } = await depreciationLedger();
    const sold = await disposeAsset(machine.id, "2026-02-20", 10_000_000);
    expect(sold.status).toBe("disposed");
    expect(sold.accumulatedDepreciationIdr).toBe(2_000_000);
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM fixed_asset_depreciation_reversals r
         JOIN fixed_asset_depreciations d ON d.tenant_id = r.tenant_id AND d.id = r.depreciation_id
        WHERE d.tenant_id = $1 AND d.fixed_asset_id = $2`,
      [tenantId, machine.id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
