// Finding 6 of docs/briefs/497-findings-fixes.md (0311 reversal rows): a row in
// fixed_asset_depreciation_reversals can today point at any journal entry, so a
// depreciation row can be "taken back" without a real correcting journal and
// the book value drifts from the ledger. Decision (CTO): INSERT into the
// reversal table only through the database function
//   app.record_depreciation_reversal(p_tenant uuid, p_depreciation_id uuid,
//     p_journal_entry_id uuid, p_reason text, p_actor text) RETURNS uuid
// (SECURITY DEFINER). It validates the correcting journal, inserts the
// reversal row, sets `reversed_at = now()` on the depreciation row, and returns
// the reversal id. `legend_app` loses INSERT on the reversal table and gets
// EXECUTE on the function.
//
// Rules under test: no value counted twice, no ledger/register drift (ACC-01);
// the correction is a real mirrored journal of the same asset month and amount.
//
// Assumptions (the brief does not pin these down):
// - A refusal is an integrity error: SQLSTATE 23514, 22023 or P0001 (the exact
//   code is not fixed). A missing function (42883) never counts as a refusal.
// - Refusing a second reversal of the same row surfaces as 23505 (the existing
//   unique key) or one of the codes above.
// - A random journal id that does not exist is refused with any of the codes
//   above or 23503.
// - "Same asset" cannot be probed with a journal of a second asset without a
//   second asset ledger; "unrelated journal" (other accounts, same month and
//   amount) stands for it.
// - Seeding the correcting journals is done as the migration owner with plain
//   SQL; the function itself is called as `legend_app`.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allDepreciationRows,
  createAsset,
  failure,
  makeEntity,
  owner,
  rawInsertEntry,
  runMonth,
  setupAssetLedger,
  tenantId,
  withAppRole,
  withOwner,
  type DbError,
  type DepreciationRow,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

type CorrectionLine = {
  accountId: string;
  debit: number;
  credit: number;
  outletId: string | null;
};

/**
 * Correcting journal as the fixed-asset service books it: a `depreciation`
 * entry whose source_id is the asset id (the shared postCorrection helper leaves
 * source_id NULL, which the function rightly refuses).
 */
async function postCorrection(
  originalId: string,
  options: {
    mirror?: boolean;
    amount?: number;
    likeJournalId?: string;
    /** Rewrites the (already mirrored) lines before they are inserted. */
    transform?: (lines: CorrectionLine[]) => CorrectionLine[];
  } = {},
): Promise<string> {
  const read = async (id: string) => {
    const { rows: entry } = await owner.query<{
      legal_entity_id: string;
      fiscal_period_id: string;
      entry_date: string;
      source_type: string;
      source_id: string | null;
    }>(
      `SELECT legal_entity_id, fiscal_period_id, entry_date::text AS entry_date, source_type, source_id
         FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const { rows: lines } = await owner.query<{
      account_id: string;
      debit_idr: string;
      credit_idr: string;
      outlet_id: string | null;
    }>(
      `SELECT account_id, debit_idr, credit_idr, outlet_id
         FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no`,
      [tenantId, id],
    );
    return { entry: entry[0]!, lines };
  };
  const original = await read(originalId);
  // drizzle/0313: a correction's source_id is the asset id (the asset of the
  // depreciation row whose journal_entry_id is the original), not the original
  // journal's own source_id. Falls back to the original's when no row matches.
  const { rows: assetRows } = await owner.query<{ fixed_asset_id: string }>(
    `SELECT fixed_asset_id::text AS fixed_asset_id
       FROM fixed_asset_depreciations
      WHERE tenant_id = $1 AND journal_entry_id = $2`,
    [tenantId, originalId],
  );
  const correctionSourceId =
    assetRows[0]?.fixed_asset_id ?? original.entry.source_id;
  const placeLike = options.likeJournalId
    ? (await read(options.likeJournalId)).entry
    : original.entry;
  const mirror = options.mirror ?? true;
  const set = (value: number) =>
    options.amount !== undefined && value > 0 ? options.amount : value;
  const mirrored = original.lines.map((line) => {
    const debit = Number(mirror ? line.credit_idr : line.debit_idr);
    const credit = Number(mirror ? line.debit_idr : line.credit_idr);
    return {
      accountId: line.account_id,
      debit: set(debit),
      credit: set(credit),
      outletId: line.outlet_id,
    };
  });
  const lines = options.transform ? options.transform(mirrored) : mirrored;
  return withOwner(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'Ledger guard correction', NULL, $7, $8)
       RETURNING id`,
      [
        tenantId,
        original.entry.legal_entity_id,
        placeLike.entry_date,
        placeLike.fiscal_period_id,
        original.entry.source_type,
        correctionSourceId,
        `raw-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const line of lines) {
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          entryId,
          line.accountId,
          lineNo,
          line.debit,
          line.credit,
          line.outletId,
        ],
      );
      lineNo += 1;
    }
    return entryId;
  });
}

const REFUSAL_CODES = ["23514", "22023", "P0001"];

function expectRefusal(error: DbError, extra: string[] = []) {
  expect(
    error.code,
    `expected an integrity refusal, got: ${error.message}`,
  ).not.toBe("42883");
  expect([...REFUSAL_CODES, ...extra]).toContain(error.code);
}

async function ledger() {
  const entity = await makeEntity("Depreciation reversal fn");
  await setupAssetLedger(entity);
  const machine = await createAsset(entity);
  await runMonth(entity, "2026-01");
  await runMonth(entity, "2026-02");
  await runMonth(entity, "2026-03");
  const [january, february, march] = await allDepreciationRows(machine.id);
  return {
    entity,
    machine,
    january: january!,
    february: february!,
    march: march!,
  };
}

const callFunction = (
  row: DepreciationRow,
  journalId: string,
  reason = "Pelepasan mundur (reversal fn test)",
) =>
  withAppRole((client) =>
    client.query<{ id: string }>(
      "SELECT app.record_depreciation_reversal($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text) AS id",
      [tenantId, row.id, journalId, reason, "test-actor"],
    ),
  );

async function reversalRows(depreciationId: string) {
  const { rows } = await owner.query<{
    id: string;
    journal_entry_id: string;
    reason: string;
  }>(
    `SELECT id, journal_entry_id, reason FROM fixed_asset_depreciation_reversals
      WHERE tenant_id = $1 AND depreciation_id = $2`,
    [tenantId, depreciationId],
  );
  return rows;
}

async function reversedAt(depreciationId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ reversed_at: Date | null }>(
    "SELECT reversed_at FROM fixed_asset_depreciations WHERE tenant_id = $1 AND id = $2",
    [tenantId, depreciationId],
  );
  return rows[0]!.reversed_at;
}

async function expectUntouched(row: DepreciationRow) {
  expect(await reversalRows(row.id)).toEqual([]);
  expect(await reversedAt(row.id)).toBeNull();
}

describe("497 finding 6: a depreciation row is taken back only through app.record_depreciation_reversal", () => {
  it("ACC-01 a valid mirrored correcting journal is accepted: reversal row inserted, reversed_at set, reversal id returned", async () => {
    const { march } = await ledger();
    const correction = await postCorrection(march.journalEntryId);

    const result = await callFunction(march, correction);

    const returned = result.rows[0]!.id;
    expect(returned).toMatch(/^[0-9a-f-]{36}$/);
    const reversals = await reversalRows(march.id);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.id).toBe(returned);
    expect(reversals[0]!.journal_entry_id).toBe(correction);
    expect(reversals[0]!.reason).toBe("Pelepasan mundur (reversal fn test)");
    expect(await reversedAt(march.id)).not.toBeNull();
  });

  it("ACC-01 a correcting journal with another amount is refused and nothing is written", async () => {
    const { march } = await ledger();
    const correction = await postCorrection(march.journalEntryId, {
      amount: 400_000,
    });
    expectRefusal(await failure(callFunction(march, correction)));
    await expectUntouched(march);
  });

  it("ACC-01 a journal that repeats the depreciation in the same direction (not mirrored) is refused", async () => {
    const { march } = await ledger();
    const sameDirection = await postCorrection(march.journalEntryId, {
      mirror: false,
    });
    expectRefusal(await failure(callFunction(march, sameDirection)));
    await expectUntouched(march);
  });

  it("ACC-01 a mirrored journal dated in another month than the depreciation row is refused", async () => {
    const { february, march } = await ledger();
    // March's depreciation corrected by a journal that sits in February.
    const wrongMonth = await postCorrection(march.journalEntryId, {
      likeJournalId: february.journalEntryId,
    });
    expectRefusal(await failure(callFunction(march, wrongMonth)));
    await expectUntouched(march);
  });

  it("ACC-01 an unrelated journal of the same month and amount (other accounts) is refused", async () => {
    const { entity, march } = await ledger();
    const { rows: period } = await owner.query<{
      fiscal_period_id: string;
      entry_date: string;
    }>(
      "SELECT fiscal_period_id, entry_date::text AS entry_date FROM journal_entries WHERE tenant_id = $1 AND id = $2",
      [tenantId, march.journalEntryId],
    );
    const { rows: accounts } = await owner.query<{ id: string; code: string }>(
      "SELECT id, code FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code IN ('1103', '7101')",
      [tenantId, entity],
    );
    const bank = accounts.find((a) => a.code === "1103")!.id;
    const gain = accounts.find((a) => a.code === "7101")!.id;
    const unrelated = await withOwner((client) =>
      rawInsertEntry(client, {
        entity,
        periodId: period[0]!.fiscal_period_id,
        date: period[0]!.entry_date,
        lines: [
          { accountId: bank, debit: 1_000_000, credit: 0 },
          { accountId: gain, debit: 0, credit: 1_000_000 },
        ],
      }),
    );
    expectRefusal(await failure(callFunction(march, unrelated)));
    await expectUntouched(march);
  });

  // 0313 assert_depreciation_reversal_total checks the mirror per account, at
  // commit. The service books one expense account per depreciation journal, so
  // the test splits the original's expense line over two expense accounts as the
  // migration owner. Assumption: the owner may switch off triggers for the
  // seeding transaction only (`session_replication_role = replica`, needs a
  // superuser, as the disposable test database gives); the reversal function
  // itself still runs with every trigger on.
  async function splitExpenseAcrossTwoAccounts(
    entity: string,
    journalId: string,
  ): Promise<{ expenseA: string; expenseB: string }> {
    return withOwner(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, '6103', 'Beban Penyusutan Cabang', 'expense', 'operating_expense')
         RETURNING id`,
        [tenantId, entity],
      );
      const expenseB = created[0]!.id;
      const { rows: expense } = await client.query<{
        id: string;
        account_id: string;
        outlet_id: string | null;
      }>(
        `SELECT id, account_id, outlet_id FROM journal_lines
          WHERE tenant_id = $1 AND entry_id = $2 AND debit_idr > 0`,
        [tenantId, journalId],
      );
      expect(expense).toHaveLength(1);
      const { rows: next } = await client.query<{ n: number }>(
        "SELECT max(line_no) + 1 AS n FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2",
        [tenantId, journalId],
      );
      // 1,000,000 expense becomes 600,000 + 400,000; the journal total is unchanged.
      await client.query(
        "UPDATE journal_lines SET debit_idr = 600000 WHERE tenant_id = $1 AND id = $2",
        [tenantId, expense[0]!.id],
      );
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
         VALUES ($1, $2, $3, $4, 400000, 0, $5)`,
        [tenantId, journalId, expenseB, next[0]!.n, expense[0]!.outlet_id],
      );
      return { expenseA: expense[0]!.account_id, expenseB };
    });
  }

  it("ACC-01 a correction that mirrors only one of two expense accounts (same total) is refused at commit", async () => {
    const { entity, march } = await ledger();
    const { expenseA, expenseB } = await splitExpenseAcrossTwoAccounts(
      entity,
      march.journalEntryId,
    );
    // Mirror carries 600,000 + 400,000 on the two expense accounts; fold both
    // into expense A: the total is still 1,000,000 but account B is not mirrored.
    const lumped = await postCorrection(march.journalEntryId, {
      transform: (lines) => {
        const credit = lines
          .filter((l) => l.accountId === expenseA || l.accountId === expenseB)
          .reduce((sum, l) => sum + l.credit, 0);
        const first = lines.find((l) => l.accountId === expenseA)!;
        return [
          ...lines.filter(
            (l) => l.accountId !== expenseA && l.accountId !== expenseB,
          ),
          { ...first, credit },
        ];
      },
    });
    expectRefusal(await failure(callFunction(march, lumped)));
    await expectUntouched(march);
  });

  it("ACC-01 a correction that mirrors both expense accounts one by one is accepted", async () => {
    const { entity, march } = await ledger();
    await splitExpenseAcrossTwoAccounts(entity, march.journalEntryId);
    const correction = await postCorrection(march.journalEntryId);

    const result = await callFunction(march, correction);

    const reversals = await reversalRows(march.id);
    expect(reversals).toHaveLength(1);
    expect(reversals[0]!.id).toBe(result.rows[0]!.id);
    expect(reversals[0]!.journal_entry_id).toBe(correction);
    expect(await reversedAt(march.id)).not.toBeNull();
  });

  it("ACC-01 a journal id that does not exist is refused", async () => {
    const { march } = await ledger();
    expectRefusal(await failure(callFunction(march, randomUUID())), ["23503"]);
    await expectUntouched(march);
  });

  it("ACC-01 the same depreciation row cannot be taken back twice", async () => {
    const { march } = await ledger();
    const first = await postCorrection(march.journalEntryId);
    await callFunction(march, first);
    const second = await postCorrection(march.journalEntryId);
    expectRefusal(await failure(callFunction(march, second)), ["23505"]);
    expect(await reversalRows(march.id)).toHaveLength(1);
  });

  it("ACC-01 legend_app can no longer INSERT into the reversal table directly (permission denied)", async () => {
    const { march } = await ledger();
    const correction = await postCorrection(march.journalEntryId);
    const error = await failure(
      withAppRole((client) =>
        client.query(
          `INSERT INTO fixed_asset_depreciation_reversals
             (tenant_id, depreciation_id, journal_entry_id, reason, created_by)
           VALUES ($1, $2, $3, 'langsung', 'test-actor')`,
          [tenantId, march.id, correction],
        ),
      ),
    );
    expect(error.code).toBe("42501");
    expect(await reversalRows(march.id)).toEqual([]);
  });

  it("ACC-01 a direct INSERT with an arbitrary journal is refused too (the drift the finding describes)", async () => {
    const { march, january } = await ledger();
    const error = await failure(
      withAppRole((client) =>
        client.query(
          `INSERT INTO fixed_asset_depreciation_reversals
             (tenant_id, depreciation_id, journal_entry_id, reason, created_by)
           VALUES ($1, $2, $3, 'jurnal sembarang', 'test-actor')`,
          [tenantId, march.id, january.journalEntryId],
        ),
      ),
    );
    expect(error.code).toBe("42501");
    await expectUntouched(march);
  });

  it("ACC-01 legend_app cannot set reversed_at itself: only the function marks a row as taken back", async () => {
    const { march } = await ledger();
    const error = await failure(
      withAppRole((client) =>
        client.query(
          "UPDATE fixed_asset_depreciations SET reversed_at = now() WHERE tenant_id = $1 AND id = $2",
          [tenantId, march.id],
        ),
      ),
    );
    expect(error.code).toBe("42501");
    expect(await reversedAt(march.id)).toBeNull();
  });
});
