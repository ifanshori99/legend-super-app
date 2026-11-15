// Payout 897 (cards legend-klr99 / legend-v2dco; design scratchpad b897/design.md
// F6 and F7; finding "guard fee accepts a journal of the wrong amount or account"
// and "settle_net_idr stays NULL" in docs/qa/second-opinion-payout-888-891.md).
// Written fail-first from the finding text and the design, not from the
// implementation. Everything here runs as the app role (`legend_app`) or as the
// table owner, so the database guard is what is proven, not the service.
//
// Rules proven here (founder: the GL matches the money that moved):
// - The flip `fee_posted` false -> true is accepted only for a fee journal that
//   books the real fee on the real accounts (debit the bank-charges account,
//   credit the frozen source bank): a Rp1 journal against a Rp5.000 fee is
//   refused (23514), a balanced journal on the wrong debit or credit account is
//   refused, the right one is accepted exactly once, and a refused flip stays
//   in the recovery list (the sweep posts the real fee once).
// - A new posting never carries NULL `settle_net_idr` or NULL `fee_idr`
//   (23514). Historical rows (NULL) are not touched: they still flip with the
//   account checks and without an amount check.
//
// Assumptions (the design names them, stated so they can be contested):
// - The new column is `payroll_payout_gl_postings.fee_idr` (bigint). Where a
//   test needs it, it first asserts the column exists, so a missing column is a
//   failure of the missing behaviour, not of the setup.
// - A refusal is the guard code 23514, like the other payout guards.
// - A posting is copied with INSERT .. SELECT over the columns found in
//   information_schema, so the test does not depend on the full column list.
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetRecoveryCursorsForTest,
  runPayoutGlRecoverySweep,
} from "../worker/payout-gl-recovery.job.ts";
import { withAppRole } from "./accounting-ledger-guard-test-helpers.ts";
import {
  APP2,
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("897fee");
const tenantId = () => W.tenantId;
const GUARD_CODE = "23514";
const FEE = 5_000;
const NET = 1_000_000;
const NOW = new Date("2026-11-30T03:00:00Z");
const sweep = () => runPayoutGlRecoverySweep(W.scope(), NOW);

beforeEach(() => {
  __resetRecoveryCursorsForTest();
});

let periodId = "";
let bankChargesId = "";
let salariesPayableId = "";
let pettyCashId = "";

beforeAll(async () => {
  const idOfCode = async (code: string) =>
    (
      await W.rowsOf(
        `SELECT id FROM chart_of_accounts
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
        [tenantId(), W.entityId(), code],
      )
    )[0]!.id as string;
  bankChargesId = await idOfCode("8101");
  salariesPayableId = await idOfCode("2103");
  pettyCashId = await idOfCode("1102");
  periodId = (
    await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
});

// ---- Helpers (patterns of payroll-payout-888-guards.test.ts) ---------------------

const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
const feeJournal = {
  "8101": { debit: FEE, credit: 0 },
  "1103": { debit: 0, credit: FEE },
};

async function deactivateGlAccount(code: string) {
  const setActive = (active: boolean) =>
    W.asTenant(
      (c) =>
        c.query(
          `UPDATE chart_of_accounts SET is_active = $3
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $4`,
          [tenantId(), W.entityId(), active, code],
        ),
      true,
    );
  await setActive(false);
  return () => setActive(true);
}

async function sourceGlOf(batchId: string) {
  return (
    await W.rowsOf(
      `SELECT ba.gl_account_id FROM payroll_disbursement_batches b
         JOIN bank_accounts ba ON ba.tenant_id = b.tenant_id AND ba.id = b.source_bank_account_id
        WHERE b.tenant_id = $1 AND b.id = $2`,
      [tenantId(), batchId],
    )
  )[0]!.gl_account_id as string;
}

/** Bank batch confirmed while 8101 is inactive: settle journaled, fee deferred. */
async function bankSettledFeeDeferred() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  const restore = await deactivateGlAccount("8101");
  try {
    await W.confirm(batchId, W.succeedItems(batchId, items), APP2);
  } finally {
    await restore();
  }
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: settle journaled").toBe("settle");
  expect(posting!.fee_posted, "premise: fee deferred").toBe(false);
  expect(await W.journalByKey(feeKey(posting!))).toBeUndefined();
  return { runId, batchId, posting: posting! };
}

/** Source type and source id of the REAL fee journal of a normal settlement, mapped onto `target`. */
async function realFeeHeaderFor(target: { runId: string; batchId: string }) {
  const slips = [bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  await W.confirm(
    batchId,
    W.succeedItems(batchId, await W.itemsOf(batchId)),
    APP2,
  );
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.fee_posted, "premise: normal settle posts its fee").toBe(
    true,
  );
  const [entry] = await W.rowsOf(
    `SELECT source_type, source_id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId(), W.entityId(), feeKey(posting!)],
  );
  expect(entry, "premise: the real fee journal exists").toBeDefined();
  const sourceId =
    entry!.source_id === runId
      ? target.runId
      : entry!.source_id === batchId
        ? target.batchId
        : ((entry!.source_id as string | null) ?? null);
  return { sourceType: entry!.source_type as string, sourceId };
}

type Line = { accountId: string; debit: number; credit: number };
type JournalSpec = {
  key: string;
  lines: Line[];
  header: { sourceType: string; sourceId: string | null };
};

async function insertJournal(client: PoolClient, spec: JournalSpec) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 897 fee guard test',
             NULL, $6, $7)
     RETURNING id`,
    [
      tenantId(),
      W.entityId(),
      periodId,
      spec.header.sourceType,
      spec.header.sourceId,
      spec.key,
      randomBytes(32).toString("hex"),
    ],
  );
  const entryId = rows[0]!.id;
  for (const [index, line] of spec.lines.entries())
    await client.query(
      `INSERT INTO journal_lines
         (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [tenantId(), entryId, line.accountId, index + 1, line.debit, line.credit],
    );
}

/**
 * `UPDATE .. SET fee_posted = true` as the app role after inserting `journals`
 * in the same transaction (behind a savepoint so a refusal can be read back).
 */
async function tryFlip(id: string, journals: JournalSpec[] = []) {
  return withAppRole(async (client) => {
    await client.query("SAVEPOINT guard_try");
    for (const spec of journals) await insertJournal(client, spec);
    let code: string | undefined;
    try {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET fee_posted = true WHERE id = $1`,
        [id],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? "unknown";
      await client.query("ROLLBACK TO SAVEPOINT guard_try");
    }
    return code;
  });
}

const committedRow = async (id: string) =>
  (
    await W.rowsOf(
      `SELECT kind, fee_posted, settle_net_idr::text AS settle_net FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    )
  )[0]!;

const hasColumn = async (column: string) =>
  (
    await W.rowsOf(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'
          AND column_name = $1`,
      [column],
    )
  ).length > 0;

async function balance(code: string) {
  const [row] = await W.rowsOf(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS debit,
            COALESCE(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND a.code = $3`,
    [tenantId(), W.entityId(), code],
  );
  return { debit: Number(row!.debit), credit: Number(row!.credit) };
}

/** Fee journal spec of `posting` with the given lines (real header, the posting's key). */
async function feeSpec(
  ctx: { runId: string; batchId: string; posting: Row },
  lines: Line[],
): Promise<JournalSpec> {
  return {
    key: feeKey(ctx.posting),
    header: await realFeeHeaderFor(ctx),
    lines,
  };
}

// =========================================================================
// F6: the fee flip is bound to the real amount and accounts
// =========================================================================

describe("897 fee_posted flip needs the real fee amount on the real accounts (F6)", () => {
  it("[897-fee-flip-rp1-refused] a balanced Rp1 fee journal against a Rp5.000 fee is refused (23514); the flag stays false and the recovery sweep still posts the real fee exactly once", async () => {
    const ctx = await bankSettledFeeDeferred();
    const source = await sourceGlOf(ctx.batchId);
    const spec = await feeSpec(ctx, [
      { accountId: bankChargesId, debit: 1, credit: 0 },
      { accountId: source, debit: 0, credit: 1 },
    ]);
    const before8101 = await balance("8101");

    const code = await tryFlip(ctx.posting.id as string, [spec]);

    expect(code, "Rp1 is not the fee").toBe(GUARD_CODE);
    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      false,
    );
    expect(await W.journalByKey(feeKey(ctx.posting))).toBeUndefined();

    // Still owed: the recovery list shows the posting and the sweep books the
    // real fee, once.
    await sweep();
    await sweep();
    const [done] = await W.postingsOf(ctx.batchId);
    expect(done!.fee_posted, "the sweep recovered the fee").toBe(true);
    expect(await W.journalByKey(feeKey(done!))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    expect((await balance("8101")).debit - before8101.debit).toBeGreaterThan(0);
  });

  it("[897-fee-flip-wrong-account-refused] a balanced fee journal of the right amount on the wrong debit account, or on the wrong credit account, is refused (23514); nothing is booked", async () => {
    const ctx = await bankSettledFeeDeferred();
    const source = await sourceGlOf(ctx.batchId);

    const wrongDebit = await tryFlip(ctx.posting.id as string, [
      await feeSpec(ctx, [
        { accountId: salariesPayableId, debit: FEE, credit: 0 },
        { accountId: source, debit: 0, credit: FEE },
      ]),
    ]);
    expect(wrongDebit, "debit on a salaries payable account").toBe(GUARD_CODE);

    const wrongCredit = await tryFlip(ctx.posting.id as string, [
      await feeSpec(ctx, [
        { accountId: bankChargesId, debit: FEE, credit: 0 },
        { accountId: pettyCashId, debit: 0, credit: FEE },
      ]),
    ]);
    expect(wrongCredit, "credit on petty cash, not the source bank").toBe(
      GUARD_CODE,
    );

    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      false,
    );
    expect(await W.journalByKey(feeKey(ctx.posting))).toBeUndefined();
  });

  it("[897-fee-flip-accepted-once] the exact fee (Dr 8101 / Cr frozen source, Rp5.000) lets the flag turn true once; a second flip attempt changes nothing and no second fee is booked", async () => {
    const ctx = await bankSettledFeeDeferred();
    const source = await sourceGlOf(ctx.batchId);
    const before = await balance("8101");

    const code = await tryFlip(ctx.posting.id as string, [
      await feeSpec(ctx, [
        { accountId: bankChargesId, debit: FEE, credit: 0 },
        { accountId: source, debit: 0, credit: FEE },
      ]),
    ]);

    expect(code).toBeUndefined();
    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      true,
    );
    expect(await W.journalByKey(feeKey(ctx.posting))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(ctx.posting))).toBe(1);
    const afterFirst = await balance("8101");
    expect(afterFirst.debit - before.debit).toBe(FEE);

    await tryFlip(ctx.posting.id as string);
    await sweep();
    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      true,
    );
    expect(await W.countJournals(feeKey(ctx.posting))).toBe(1);
    expect(await balance("8101")).toEqual(afterFirst);
  });
});

// =========================================================================
// F7: new postings never carry NULL amounts; history is left alone
// =========================================================================

/** Runs `work` as the app role and always rolls back, so nothing stays behind. */
async function asAppRoleRolledBack<T>(
  work: (client: PoolClient) => Promise<T>,
) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId()],
    );
    return await work(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** Copies posting `sourceId` as a NEW row; `overrides` are SQL expressions per column. */
async function copyPosting(
  client: PoolClient,
  sourceId: string,
  overrides: Record<string, string>,
) {
  const columns = (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'
          AND is_generated = 'NEVER'
        ORDER BY ordinal_position`,
    )
  ).rows.map((r) => r.column_name);
  const hex = randomBytes(32).toString("hex");
  const values: Record<string, string> = {
    id: "gen_random_uuid()",
    item_set_hash: `'${hex}'`,
    journal_key: `'payroll-payout:${hex}'`,
    ...overrides,
  };
  await client.query(
    `INSERT INTO payroll_payout_gl_postings (${columns.map((c) => `"${c}"`).join(", ")})
     SELECT ${columns.map((c) => values[c] ?? `"${c}"`).join(", ")}
       FROM payroll_payout_gl_postings WHERE id = $1`,
    [sourceId],
  );
}

async function tryCopy(
  sourceId: string,
  overrides: Record<string, string>,
): Promise<string | undefined> {
  return asAppRoleRolledBack(async (client) => {
    try {
      await copyPosting(client, sourceId, overrides);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  });
}

describe("897 a new posting never carries NULL settle_net_idr or fee_idr (F7)", () => {
  it("[897-posting-null-amounts-refused] the app role cannot insert a posting with NULL settle_net_idr or NULL fee_idr (23514); the same row with both amounts is accepted", async () => {
    expect(await hasColumn("fee_idr"), "fee_idr column holds the fee").toBe(
      true,
    );
    const ctx = await bankSettledFeeDeferred();
    const id = ctx.posting.id as string;

    expect(
      await tryCopy(id, {}),
      "control: a copy with both amounts is a valid posting",
    ).toBeUndefined();
    expect(await tryCopy(id, { settle_net_idr: "NULL" })).toBe(GUARD_CODE);
    expect(await tryCopy(id, { fee_idr: "NULL" })).toBe(GUARD_CODE);
    expect(await tryCopy(id, { settle_net_idr: "NULL", fee_idr: "NULL" })).toBe(
      GUARD_CODE,
    );
  });

  it("[897-posting-written-with-amounts] a posting the service writes carries its principal and its fee", async () => {
    expect(await hasColumn("fee_idr")).toBe(true);
    const ctx = await bankSettledFeeDeferred();
    const [row] = await W.rowsOf(
      `SELECT settle_net_idr::text AS net, fee_idr::text AS fee
         FROM payroll_payout_gl_postings WHERE id = $1`,
      [ctx.posting.id],
    );
    expect(row!.net).toBe(String(NET));
    expect(row!.fee).toBe(String(FEE));
  });

  it("[897-historical-null-still-flips] a historical row (NULL amounts, trigger off under the owner) is not bricked: a fee journal on the wrong account is refused, one on the right accounts flips without an amount check, and the NULLs stay", async () => {
    expect(await hasColumn("fee_idr"), "fee_idr column holds the fee").toBe(
      true,
    );
    const ctx = await bankSettledFeeDeferred();
    const id = ctx.posting.id as string;
    // What a row written before the migration looks like (owner, triggers off).
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings
              SET fee_idr = NULL, settle_net_idr = NULL WHERE id = $1`,
          [id],
        ),
      true,
    );
    const source = await sourceGlOf(ctx.batchId);

    const wrong = await tryFlip(id, [
      await feeSpec(ctx, [
        { accountId: salariesPayableId, debit: 1, credit: 0 },
        { accountId: source, debit: 0, credit: 1 },
      ]),
    ]);
    expect(wrong, "the account checks still apply to history").toBe(GUARD_CODE);
    expect((await committedRow(id)).fee_posted).toBe(false);

    const right = await tryFlip(id, [
      await feeSpec(ctx, [
        { accountId: bankChargesId, debit: 1, credit: 0 },
        { accountId: source, debit: 0, credit: 1 },
      ]),
    ]);
    expect(right, "no amount check for a historical row").toBeUndefined();
    const after = await committedRow(id);
    expect(after.fee_posted).toBe(true);
    expect(after.settle_net, "history is left as it was").toBeNull();
    expect(
      (
        await W.rowsOf(
          `SELECT fee_idr FROM payroll_payout_gl_postings WHERE id = $1`,
          [id],
        )
      )[0]!.fee_idr,
    ).toBeNull();
  });
});
