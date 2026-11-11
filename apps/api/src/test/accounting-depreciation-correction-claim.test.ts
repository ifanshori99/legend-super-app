// Findings 2 and 3 of the second-opinion on 0313/0314 (brief "ledger guards
// fixes", items 2 and 3). Fail-first tests, written from the contract and the
// existing test helpers, not from the implementation.
//
// Item 2 (P1): app.record_depreciation_reversal locks only the depreciation
// row. Two transactions that take back DIFFERENT rows with the SAME correcting
// journal each see only their own reversal row, so each passes the "reversals
// equal the correction" check on its own snapshot, both commit, and the
// correction (1,000,000) takes back 2,000,000. A correcting journal is a claim:
// the amount taken back through it may never exceed what it corrects, also when
// two REPEATABLE READ transactions race.
//
// Item 3 (P1): a correcting journal that has already been reversed by a
// manual reversal journal (reversal_of -> correction) is still accepted, and
// linking a correction and reversing it must exclude each other in both orders
// and under concurrency.
//
// Rules under test: no value taken back or posted twice (ACC-01); a refusal
// beats a write when in doubt.
//
// Assumptions (the brief does not pin these down):
// - Fixture: a catch-up run (January, then April) posts February to April in
//   ONE journal (see accounting-fixed-asset-backdated-events.test.ts). March and
//   April are two active rows of one asset that share that journal. A correcting
//   journal of 1,000,000 mirrored on both accounts therefore fits either row on
//   its own, but not both; this is the shape the race needs.
// - A refusal is a database integrity error: 23514, 22023, P0001, 23505 or a
//   serialization failure 40001 (the loser of a REPEATABLE READ race). A
//   missing function (42883) or a permission error (42501) never counts.
// - The failure of a race may surface on the statement or at COMMIT (the
//   existing total check is a deferred constraint trigger); both count.
// - A reversal journal of a correction is a plain journal entry with
//   source_type 'reversal' and reversal_of = the correction, mirrored lines,
//   dated like the correction.
// - One transaction may still take back two rows with one correction that
//   covers both (the service does exactly this for a catch-up journal).

import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
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

const REFUSAL_CODES = ["23514", "22023", "P0001", "23505", "40001"];

function expectRefusal(error: DbError | undefined) {
  expect(error, "expected a refusal but the work was accepted").toBeDefined();
  expect(
    REFUSAL_CODES,
    `expected an integrity refusal, got ${error!.code}: ${error!.message}`,
  ).toContain(error!.code);
}

// ---- Fixture -------------------------------------------------------------------

type Ledger = {
  entity: string;
  assetId: string;
  march: DepreciationRow;
  april: DepreciationRow;
};

async function catchUpLedger(): Promise<Ledger> {
  const entity = await makeEntity("Correction claim");
  await setupAssetLedger(entity);
  const machine = await createAsset(entity);
  await runMonth(entity, "2026-01");
  // Skipping February and March: the April run posts February to April in ONE journal.
  await runMonth(entity, "2026-04");
  const rows = await allDepreciationRows(machine.id);
  expect(rows.map((row) => row.period)).toEqual([
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
  ]);
  const march = rows[2]!;
  const april = rows[3]!;
  expect(march.journalEntryId).toBe(april.journalEntryId);
  return { entity, assetId: machine.id, march, april };
}

/**
 * Correcting journal for `originalId`, as the fixed-asset service books it: a
 * `depreciation` entry, source_id = asset id, same entity, period and date as
 * the original, every line mirrored, every amount set to `amount`.
 */
async function postCorrection(
  originalId: string,
  assetId: string,
  amount: number,
): Promise<string> {
  const { rows: entry } = await owner.query<{
    legal_entity_id: string;
    fiscal_period_id: string;
    entry_date: string;
    source_type: string;
  }>(
    `SELECT legal_entity_id, fiscal_period_id, entry_date::text AS entry_date, source_type
       FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, originalId],
  );
  const { rows: lines } = await owner.query<{
    account_id: string;
    debit_idr: string;
    credit_idr: string;
    outlet_id: string | null;
  }>(
    `SELECT account_id, debit_idr, credit_idr, outlet_id
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no`,
    [tenantId, originalId],
  );
  return withOwner(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, 'Correction claim test', NULL, $7, $8)
       RETURNING id`,
      [
        tenantId,
        entry[0]!.legal_entity_id,
        entry[0]!.entry_date,
        entry[0]!.fiscal_period_id,
        entry[0]!.source_type,
        assetId,
        `raw-${randomUUID()}`,
        randomBytes(32).toString("hex"),
      ],
    );
    const entryId = rows[0]!.id;
    let lineNo = 1;
    for (const line of lines) {
      const set = (value: string) => (Number(value) > 0 ? amount : 0);
      await client.query(
        `INSERT INTO journal_lines
           (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          entryId,
          line.account_id,
          lineNo,
          set(line.credit_idr),
          set(line.debit_idr),
          line.outlet_id,
        ],
      );
      lineNo += 1;
    }
    return entryId;
  });
}

/** Mirrored reversal journal of `journalId` (reversal_of = journalId) on an open client. */
async function insertManualReversal(
  client: PoolClient,
  journalId: string,
): Promise<string> {
  const { rows: entry } = await owner.query<{
    legal_entity_id: string;
    fiscal_period_id: string;
    entry_date: string;
  }>(
    `SELECT legal_entity_id, fiscal_period_id, entry_date::text AS entry_date
       FROM journal_entries WHERE tenant_id = $1 AND id = $2`,
    [tenantId, journalId],
  );
  const { rows: lines } = await owner.query<{
    account_id: string;
    debit_idr: string;
    credit_idr: string;
    outlet_id: string | null;
  }>(
    `SELECT account_id, debit_idr, credit_idr, outlet_id
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 ORDER BY line_no`,
    [tenantId, journalId],
  );
  return rawInsertEntry(client, {
    entity: entry[0]!.legal_entity_id,
    periodId: entry[0]!.fiscal_period_id,
    date: entry[0]!.entry_date,
    sourceType: "reversal",
    reversalOf: journalId,
    lines: lines.map((line) => ({
      accountId: line.account_id,
      debit: Number(line.credit_idr),
      credit: Number(line.debit_idr),
      outletId: line.outlet_id,
    })),
  });
}

const REVERSE_SQL =
  "SELECT app.record_depreciation_reversal($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text) AS id";

const reverseRow = (
  client: PoolClient,
  row: DepreciationRow,
  journal: string,
) =>
  client.query<{ id: string }>(REVERSE_SQL, [
    tenantId,
    row.id,
    journal,
    "Pelepasan mundur (claim test)",
    "test-actor",
  ]);

// ---- Committed-state probes ------------------------------------------------------

async function takenBackThrough(journalId: string) {
  const { rows } = await owner.query<{ n: string; total: string }>(
    `SELECT count(*) AS n, COALESCE(sum(d.amount_idr), 0)::text AS total
       FROM fixed_asset_depreciation_reversals r
       JOIN fixed_asset_depreciations d
         ON d.tenant_id = r.tenant_id AND d.id = r.depreciation_id
      WHERE r.tenant_id = $1 AND r.journal_entry_id = $2`,
    [tenantId, journalId],
  );
  return { rows: Number(rows[0]!.n), total: Number(rows[0]!.total) };
}

async function debitTotal(journalId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    "SELECT COALESCE(sum(debit_idr), 0)::text AS total FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2",
    [tenantId, journalId],
  );
  return Number(rows[0]!.total);
}

async function reversalJournals(journalId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM journal_entries WHERE tenant_id = $1 AND reversal_of = $2",
    [tenantId, journalId],
  );
  return Number(rows[0]!.n);
}

async function reversedAtCount(rows: DepreciationRow[]): Promise<number> {
  const { rows: found } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM fixed_asset_depreciations
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND reversed_at IS NOT NULL`,
    [tenantId, rows.map((row) => row.id)],
  );
  return Number(found[0]!.n);
}

// ---- Two REPEATABLE READ connections -------------------------------------------

type Outcome = { ok: true } | { ok: false; error: DbError };

async function openRepeatableRead(asApp: boolean): Promise<PoolClient> {
  const client = await owner.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  if (asApp) {
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
  }
  // The first query of the transaction fixes the snapshot: before any write below.
  await client.query("SELECT 1 FROM fiscal_periods LIMIT 1");
  return client;
}

const toOutcome = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    () => ({ ok: true }) as Outcome,
    (error: DbError) => ({ ok: false, error }) as Outcome,
  );

/**
 * Both snapshots are taken first. `first` then runs and keeps its transaction
 * open; `second` starts (it may park on a lock `first` holds); `first` commits;
 * `second` finishes and commits. The result never depends on timing: whatever
 * the second statement does (fail at once, wait, pass), the second snapshot
 * stays older than the first commit.
 */
async function race(
  first: { asApp: boolean; run: (client: PoolClient) => Promise<unknown> },
  second: { asApp: boolean; run: (client: PoolClient) => Promise<unknown> },
): Promise<[Outcome, Outcome]> {
  const one = await openRepeatableRead(first.asApp);
  const two = await openRepeatableRead(second.asApp);
  try {
    const { rows: pidRows } = await two.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const firstOutcome = await toOutcome(first.run(one));

    let settled = false;
    const secondRun = toOutcome(second.run(two)).finally(() => {
      settled = true;
    });
    // Let the second statement either finish or park on a lock the first holds.
    for (let attempt = 0; attempt < 100 && !settled; attempt += 1) {
      const { rows } = await owner.query(
        "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
        [pidRows[0]!.pid],
      );
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    let finalFirst: Outcome = firstOutcome;
    if (firstOutcome.ok) {
      finalFirst = await toOutcome(one.query("COMMIT"));
    } else {
      await one.query("ROLLBACK").catch(() => undefined);
    }

    let finalSecond = await secondRun;
    if (finalSecond.ok) {
      finalSecond = await toOutcome(two.query("COMMIT"));
    } else {
      await two.query("ROLLBACK").catch(() => undefined);
    }
    return [finalFirst, finalSecond];
  } finally {
    await one.query("ROLLBACK").catch(() => undefined);
    await two.query("ROLLBACK").catch(() => undefined);
    one.release();
    two.release();
  }
}

// ---- Item 2: one correcting journal is one claim -------------------------------

describe("item 2: a correcting journal cannot take back more than it corrects, also under concurrency", () => {
  it("ACC-01 race: two REPEATABLE READ transactions that take back March and April with the same 1,000,000 correction cannot both commit", async () => {
    const { assetId, march, april } = await catchUpLedger();
    const correction = await postCorrection(
      march.journalEntryId,
      assetId,
      1_000_000,
    );
    expect(await debitTotal(correction)).toBe(1_000_000);

    const [first, second] = await race(
      { asApp: true, run: (client) => reverseRow(client, march, correction) },
      { asApp: true, run: (client) => reverseRow(client, april, correction) },
    );

    const successes = [first, second].filter((outcome) => outcome.ok);
    expect(
      successes,
      "both transactions committed: the same correction took back 2,000,000 of 1,000,000",
    ).toHaveLength(1);
    const loser = first.ok ? second : first;
    expectRefusal(loser.ok ? undefined : loser.error);

    const claimed = await takenBackThrough(correction);
    expect(claimed.rows).toBe(1);
    expect(claimed.total).toBeLessThanOrEqual(await debitTotal(correction));
    expect(await reversedAtCount([march, april])).toBe(1);
  });

  it("ACC-01 race with the roles swapped: the order of the two transactions does not matter", async () => {
    const { assetId, march, april } = await catchUpLedger();
    const correction = await postCorrection(
      march.journalEntryId,
      assetId,
      1_000_000,
    );

    const [first, second] = await race(
      { asApp: true, run: (client) => reverseRow(client, april, correction) },
      { asApp: true, run: (client) => reverseRow(client, march, correction) },
    );

    expect([first, second].filter((outcome) => outcome.ok)).toHaveLength(1);
    const claimed = await takenBackThrough(correction);
    expect(claimed.rows).toBe(1);
    expect(claimed.total).toBeLessThanOrEqual(await debitTotal(correction));
    expect(await reversedAtCount([march, april])).toBe(1);
  });

  it("ACC-01 sequential: once a 1,000,000 correction took back one row, a second row cannot use it", async () => {
    const { assetId, march, april } = await catchUpLedger();
    const correction = await postCorrection(
      march.journalEntryId,
      assetId,
      1_000_000,
    );
    await withAppRole((client) => reverseRow(client, march, correction));

    const error = await failure(
      withAppRole((client) => reverseRow(client, april, correction)),
    );
    expectRefusal(error);
    expect((await takenBackThrough(correction)).total).toBe(1_000_000);
    expect(await reversedAtCount([april])).toBe(0);
  });

  it("ACC-01 a 2,000,000 correction may still take back both rows in one transaction (the claim is not over-blocked)", async () => {
    const { assetId, march, april } = await catchUpLedger();
    const correction = await postCorrection(
      march.journalEntryId,
      assetId,
      2_000_000,
    );

    await withAppRole(async (client) => {
      await reverseRow(client, march, correction);
      await reverseRow(client, april, correction);
    });

    const claimed = await takenBackThrough(correction);
    expect(claimed).toEqual({ rows: 2, total: 2_000_000 });
    expect(await reversedAtCount([march, april])).toBe(2);
  });
});

// ---- Item 3: a reversed correction is not a valid correction -------------------

describe("item 3: linking a correction and reversing it exclude each other", () => {
  it("ACC-01 a correction that already has a reversal journal is refused and nothing is written", async () => {
    const { assetId, april } = await catchUpLedger();
    const correction = await postCorrection(
      april.journalEntryId,
      assetId,
      1_000_000,
    );
    // The correction is not linked to any row yet, so reversing it is allowed.
    await withOwner((client) => insertManualReversal(client, correction));
    expect(await reversalJournals(correction)).toBe(1);

    const error = await failure(
      withAppRole((client) => reverseRow(client, april, correction)),
    );

    expectRefusal(error);
    expect((await takenBackThrough(correction)).rows).toBe(0);
    expect(await reversedAtCount([april])).toBe(0);
  });

  it("ACC-01 a correction that is already linked to a row cannot be reversed afterwards", async () => {
    const { assetId, april } = await catchUpLedger();
    const correction = await postCorrection(
      april.journalEntryId,
      assetId,
      1_000_000,
    );
    await withAppRole((client) => reverseRow(client, april, correction));

    const error = await failure(
      withAppRole((client) => insertManualReversal(client, correction)),
    );

    expect(error.code).toBe("23514");
    expect(await reversalJournals(correction)).toBe(0);
    expect((await takenBackThrough(correction)).rows).toBe(1);
  });

  it("ACC-01 the application role of another tenant cannot mark this tenant's correction as reversed", async () => {
    const { assetId, april } = await catchUpLedger();
    const correction = await postCorrection(
      april.journalEntryId,
      assetId,
      1_000_000,
    );
    // The definer functions run as the owner (BYPASSRLS in production), so the
    // tenant policy does not help: the database itself must refuse. The session
    // below belongs to another tenant than the journal.
    const otherTenant = randomUUID();
    const client = await owner.connect();
    let error: DbError | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [otherTenant],
      );
      await client
        .query(
          "SELECT app.claim_correction_journal($1::uuid, $2::uuid, 0, true)",
          [tenantId, correction],
        )
        .catch((caught: DbError) => {
          error = caught;
        });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(
      error,
      "another tenant marked this correction as reversed",
    ).toBeDefined();
    // Refused because the role has no EXECUTE, not because the function is
    // missing (42883) or the arguments are wrong.
    expect(error!.code).toBe("42501");
    const { rows: privileges } = await owner.query<{ allowed: boolean }>(
      `SELECT has_function_privilege('legend_app', 'app.claim_correction_journal(uuid,uuid,bigint,boolean)', 'EXECUTE') AS allowed`,
    );
    expect(privileges[0]!.allowed).toBe(false);
    // The old callable mark function (uuid, uuid) is gone: marking is a trigger.
    const { rows: callable } = await owner.query<{ found: string | null }>(
      "SELECT to_regprocedure('app.mark_correction_journal_reversed(uuid,uuid)')::text AS found",
    );
    expect(callable[0]!.found).toBeNull();
    const { rows } = await owner.query(
      "SELECT 1 FROM fixed_asset_correction_claims WHERE tenant_id = $1 AND journal_entry_id = $2",
      [tenantId, correction],
    );
    expect(rows).toHaveLength(0);

    // The legitimate path keeps working: link, no reversal journal.
    await withAppRole((app) => reverseRow(app, april, correction));
    expect((await takenBackThrough(correction)).rows).toBe(1);
  });

  it("ACC-01 race: linking a correction to a row and reversing that correction cannot both commit", async () => {
    const { assetId, april } = await catchUpLedger();
    const correction = await postCorrection(
      april.journalEntryId,
      assetId,
      1_000_000,
    );

    const [link, reverse] = await race(
      { asApp: true, run: (client) => reverseRow(client, april, correction) },
      {
        asApp: true,
        run: (client) => insertManualReversal(client, correction),
      },
    );

    // The first transaction holds the claim row: it must win, the second must
    // lose with a serialization failure or an integrity refusal.
    expect(link.ok, "the first transaction must succeed").toBe(true);
    expect(reverse.ok, "the second transaction must fail").toBe(false);
    expect(["40001", "23514"]).toContain(
      reverse.ok ? undefined : reverse.error.code,
    );
    const linked = (await takenBackThrough(correction)).rows;
    const reversed = await reversalJournals(correction);
    expect(linked + reversed).toBe(1);
    // A reversed_at flag without a link, or a link without the flag, is drift.
    expect(await reversedAtCount([april])).toBe(linked);
  });

  it("ACC-01 race with the roles swapped: the reversal journal starts first, the link second", async () => {
    const { assetId, april } = await catchUpLedger();
    const correction = await postCorrection(
      april.journalEntryId,
      assetId,
      1_000_000,
    );

    const [reverse, link] = await race(
      {
        asApp: true,
        run: (client) => insertManualReversal(client, correction),
      },
      { asApp: true, run: (client) => reverseRow(client, april, correction) },
    );

    // The first transaction holds the claim row: it must win, the second must
    // lose with a serialization failure or an integrity refusal.
    expect(reverse.ok, "the first transaction must succeed").toBe(true);
    expect(link.ok, "the second transaction must fail").toBe(false);
    expect(["40001", "23514"]).toContain(link.ok ? undefined : link.error.code);
    const linked = (await takenBackThrough(correction)).rows;
    const reversed = await reversalJournals(correction);
    expect(linked + reversed).toBe(1);
    expect(await reversedAtCount([april])).toBe(linked);
  });
});
