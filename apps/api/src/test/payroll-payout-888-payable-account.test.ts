// Brief 888, card legend-wcd24 (P1 "utang gaji"): the salaries_payable account
// the payout settles and returns against is the one the LOCK journal credited,
// never the mapping of the moment. Written fail-first from the second-opinion
// finding (docs/qa/second-opinion-payout-area-final.md) and the CTO decision in
// brief 888, not from the implementation.
//
// Rules proven here (founder: nobody is paid twice, the PT is not short, the
// GL matches the money that moved):
// - Lock credits salaries_payable account A. Finance then legitimately remaps
//   the role `salaries_payable` to B (no balance moves). Confirming the payout
//   debits A (the debt is paid off), never B; a return after yet another remap
//   (C) re-opens A, never C. Bank credits are exact (net + fee), B and C never
//   see a line, and A ends at the correct balance.
// - Same when the lock was posted while the role pointed at B and the mapping
//   went back to A before the payout: the payout follows the lock journal.
// - Replays (second confirm, repeated or parallel settle, repeated return) post
//   nothing more, also while the mapping keeps moving.
// - Items confirmed in two steps, each after another remap, both settle A.
// - A legacy posting without a frozen payable account (a row from before the
//   fix) takes the account from the lock journal, not from the mapping.
// - When that cannot be told for sure (the lock journal credits two liability
//   accounts for the same amount) the settlement is HELD: no journal, no
//   guess, and the posting is visible in the finance list
//   (`GET /api/hris/payroll/payout-fee-reposts`).
//
// Assumptions (spec silent, stated so they can be contested):
// - Accounts: A = 2103 (standard chart, the fixture mapping), B = 2104, C = 2106
//   (any other liability account of the same chart; the remap is done in SQL
//   with triggers off, like finance's mapping edit).
// - Fee of one BCA ("014") transfer is Rp5.000; net Rp1.000.000 (as 881 tests).
// - The frozen payable account lives in a nullable column of
//   payroll_payout_gl_postings, payroll_disbursement_batches or payroll_runs
//   whose name mentions both "payable"/"salaries" and "account". The legacy
//   tests find it by that name pattern and set it NULL (a pre-fix row); when no
//   such column exists the step is a no-op and the tests still judge the
//   ledger only. The new column's name is not asserted.
// - Held reason in the finance list: the exact reason name is not asserted,
//   only that the posting is listed with a non-empty string `reason`, and is
//   not listed any more after it resolved.
// - Ambiguity is produced by adding a balanced pair to the lock journal:
//   Cr 2106 net / Dr 2104 net, so two liability accounts (A and 2106) are each
//   credited the same net.
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { settleBatchPayouts } from "../services/payroll-payout-gl.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import {
  __resetRecoveryCursorsForTest,
  runPayoutGlRecoverySweep,
} from "../worker/payout-gl-recovery.job.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP2,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("888pay");
const tenantId = () => W.tenantId;

const LIST = "/api/hris/payroll/payout-fee-reposts";
const FEE = 5_000;
const NET = 1_000_000;
const NOW = new Date("2026-11-30T03:00:00Z");

const A = "2103";
const B = "2104";
const C = "2106";
const CODES = ["1102", "1103", "8101", A, B, C] as const;

const sweep = () => runPayoutGlRecoverySweep(W.scope(), NOW);
const settle = (batchId: string, by = APP2) =>
  W.inTx((tx) => settleBatchPayouts(tx, actorOf(by), batchId));
const returnItems = (batchId: string, itemIds: string[], by: string) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey: uploadEvidence(batchId, "dana-kembali.pdf"),
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );
const idOf = (row: Row) => row.id as string;

beforeEach(() => {
  __resetRecoveryCursorsForTest();
});
// Whatever a test did to the mapping, the next one starts on A.
afterEach(async () => {
  await setPayableMapping(A);
});

// ---- Finance client (permission + MFA, as the other payout HTTP tests) -------
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});
let financePromise: ReturnType<typeof makeFinance> | undefined;
async function makeFinance() {
  const { client, userId } = await W.signedInClient("Payable888 Finance");
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  enrolledUsers.push(userId);
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return client;
}
const finance = () => (financePromise ??= makeFinance());

/** The row of this posting in the finance recovery list, or undefined. */
async function listedRow(postingId: string) {
  const res = await (await finance()).get(LIST);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data as Row[]).find((row) => row.postingId === postingId);
}

// ---- Switches ----------------------------------------------------------------
async function tenantFlags() {
  const rows = await W.owner.query(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId()],
  );
  return rows.rows[0]!.flags as { modules: string[] } & Record<string, unknown>;
}
async function setFlags(flags: unknown) {
  await W.owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId(), JSON.stringify(flags)],
  );
}
async function withAccountingOff<T>(work: () => Promise<T>) {
  const original = await tenantFlags();
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await setFlags({
    ...original,
    modules: original.modules.filter((m) => m !== "accounting"),
  });
  try {
    return await work();
  } finally {
    await setFlags(original);
  }
}
async function removeBankChargesMapping() {
  const where = `tenant_id = $1 AND legal_entity_id = $2 AND role = 'bank_charges'`;
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${where}`,
    [tenantId(), W.entityId()],
  );
  expect(mapping, "premise: the fixture maps bank_charges").toBeDefined();
  await W.asTenant(
    (c) =>
      c.query(`DELETE FROM account_mappings WHERE ${where}`, [
        tenantId(),
        W.entityId(),
      ]),
    true,
  );
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, 'bank_charges', $3)`,
          [tenantId(), W.entityId(), mapping!.account_id],
        ),
      true,
    );
  };
}

// ---- Chart and mapping ---------------------------------------------------------
async function accountId(code: string) {
  const [row] = await W.rowsOf(
    `SELECT id FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
    [tenantId(), W.entityId(), code],
  );
  expect(row, `premise: the standard chart has ${code}`).toBeDefined();
  return row!.id as string;
}
/** Finance moves the role `salaries_payable` to another account (no balance moves). */
async function setPayableMapping(code: string) {
  const id = await accountId(code);
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE account_mappings SET account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'salaries_payable'`,
        [tenantId(), W.entityId(), id],
      ),
    true,
  );
}
async function withPayableMappedTo<T>(code: string, work: () => Promise<T>) {
  await setPayableMapping(code);
  try {
    return await work();
  } finally {
    await setPayableMapping(A);
  }
}

// ---- Ledger ------------------------------------------------------------------
type Balance = { debit: number; credit: number };
type Books = Record<(typeof CODES)[number], Balance>;
async function account(code: string): Promise<Balance> {
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
async function books(): Promise<Books> {
  const out = {} as Books;
  for (const code of CODES) out[code] = await account(code);
  return out;
}
/** What happened on each account since `before`. */
function movedSince(before: Books, after: Books): Books {
  const out = {} as Books;
  for (const code of CODES)
    out[code] = {
      debit: after[code].debit - before[code].debit,
      credit: after[code].credit - before[code].credit,
    };
  return out;
}
const untouched: Balance = { debit: 0, credit: 0 };
const journalCountOfEntity = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    )[0]!.n,
  );
const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
const feeJournal = (items: number) => ({
  "8101": { debit: items * FEE, credit: 0 },
  "1103": { debit: 0, credit: items * FEE },
});

// ---- Worlds ------------------------------------------------------------------
/**
 * A locked run whose lock journal is posted while the role points at
 * `lockedOn`, then an exported bank batch (items `exported`).
 */
async function lockedExported(slips: Slip[], lockedOn: string = A) {
  const runId = await W.seedRun(slips);
  const before = await books();
  await withPayableMappedTo(lockedOn, () => W.postLockedJournal(runId, slips));
  const netOfSlips = slips.reduce((total, s) => total + s.net, 0);
  const afterLock = movedSince(before, await books());
  expect(
    afterLock[lockedOn as (typeof CODES)[number]].credit,
    `premise: the lock journal credits ${lockedOn} with the net`,
  ).toBe(netOfSlips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items, before };
}

/** Bank batch confirmed while accounting is off (fee owed), lock not consumed yet. */
async function bankSkippedFeeOwed() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  await withAccountingOff(() =>
    W.confirm(batchId, W.succeedItems(batchId, items), APP2),
  );
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: final settle_skipped").toBe("settle_skipped");
  expect(posting!.fee_posted, "premise: the fee is still owed").toBe(false);
  return { slips, runId, batchId, posting: posting! };
}

/**
 * A skipped bank settlement whose lock journal is posted on A, kept held by a
 * missing bank_charges mapping. Returns with the mapping still removed.
 */
async function skippedWithLockOnA() {
  const world = await bankSkippedFeeOwed();
  const restoreCharges = await removeBankChargesMapping();
  const before = await books();
  const delivered = await W.postLockedJournal(world.runId, world.slips);
  expect(delivered.status, "premise: the lock event is delivered").toBe(
    "posted",
  );
  const [posting] = await W.postingsOf(world.batchId);
  expect(posting!.kind, "premise: still held for the fee mapping").toBe(
    "settle_skipped",
  );
  expect(await W.journalByKey(posting!.journal_key as string)).toBeUndefined();
  expect(movedSince(before, await books())[A]).toEqual({
    debit: 0,
    credit: NET,
  });
  return { ...world, posting: posting!, restoreCharges, before };
}

/**
 * A posting from before the fix has no frozen payable account. Clears every
 * nullable column that looks like one (see the assumptions at the top).
 */
async function clearFrozenPayableAccount(runId: string, batchId: string) {
  const columns = await W.rowsOf(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('payroll_payout_gl_postings', 'payroll_disbursement_batches', 'payroll_runs')
        AND is_nullable = 'YES'
        AND (column_name ~ '(payable|salaries).*(account|acct)'
          OR column_name ~ '(account|acct).*(payable|salaries)')`,
  );
  await W.asTenant(async (c) => {
    for (const { table_name, column_name } of columns) {
      const [where, key] =
        table_name === "payroll_payout_gl_postings"
          ? ["tenant_id = $1 AND batch_id = $2", batchId]
          : table_name === "payroll_disbursement_batches"
            ? ["tenant_id = $1 AND id = $2", batchId]
            : ["tenant_id = $1 AND id = $2", runId];
      await c.query(
        `UPDATE "${table_name}" SET "${column_name}" = NULL WHERE ${where}`,
        [tenantId(), key],
      );
    }
  }, true);
}

/** The lock journal now credits two liability accounts (A and C) the same net. */
async function makeLockJournalAmbiguous(runId: string, postingNet: number) {
  const payable = await accountId(A);
  const second = await accountId(C);
  const offset = await accountId(B);
  await W.asTenant(async (c) => {
    const entries = (
      await c.query(
        `SELECT e.id FROM journal_entries e
           JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
          WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
            AND l.account_id = $3 AND l.credit_idr = $4
            AND e.idempotency_key = $5`,
        [
          tenantId(),
          W.entityId(),
          payable,
          postingNet,
          `payroll-gl:locked:${runId}`,
        ],
      )
    ).rows as { id: string }[];
    expect(entries, "premise: exactly one lock journal credits A").toHaveLength(
      1,
    );
    const entry = entries[0]!.id;
    const next = Number(
      (
        await c.query(
          `SELECT COALESCE(max(line_no), 0) + 1 AS n FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2`,
          [tenantId(), entry],
        )
      ).rows[0].n,
    );
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, $4, 0, $6), ($1, $2, $5, $7, $6, 0)`,
      [tenantId(), entry, second, next, offset, postingNet, next + 1],
    );
  }, true);
}

// ==============================================================================
describe("888 wcd24: settle debits the account the lock credited, not the mapping of the moment", () => {
  it("[payable-settle-after-remap] lock on A, mapping moved to B, then the batch is confirmed: Dr A / Cr bank for the net, B untouched, A paid off, bank credited net + fee once", async () => {
    const { runId, batchId, items, before } = await lockedExported([
      bank(BUDI, NET),
    ]);
    await withPayableMappedTo(B, () =>
      W.confirm(batchId, W.succeedItems(batchId, items)),
    );

    const [posting] = await W.postingsOf(batchId);
    expect(posting!.kind).toBe("settle");
    expect(await W.journalByKey(posting!.journal_key as string)).toEqual({
      [A]: { debit: NET, credit: 0 },
      "1103": { debit: 0, credit: NET },
    });
    expect(await W.journalByKey(feeKey(posting!))).toEqual(feeJournal(1));

    const moved = movedSince(before, await books());
    expect(moved[A], "A: credited by the lock, debited by the settle").toEqual({
      debit: NET,
      credit: NET,
    });
    expect(moved[B], "B never sees the payout").toEqual(untouched);
    expect(moved[C]).toEqual(untouched);
    expect(moved["1103"]).toEqual({ debit: 0, credit: NET + FEE });
    expect(moved["8101"]).toEqual({ debit: FEE, credit: 0 });
    expect((await W.runRow(runId)).status).toBe("paid");
  });

  it("[payable-settle-lock-on-b] the lock was posted while the role pointed at B and the mapping is back on A at payout: B is paid off, A untouched", async () => {
    const { batchId, items, before } = await lockedExported(
      [bank(BUDI, NET)],
      B,
    );
    // The mapping is A again (lockedExported restores it) when the batch is paid.
    await W.confirm(batchId, W.succeedItems(batchId, items));

    const [posting] = await W.postingsOf(batchId);
    expect(await W.journalByKey(posting!.journal_key as string)).toEqual({
      [B]: { debit: NET, credit: 0 },
      "1103": { debit: 0, credit: NET },
    });
    const moved = movedSince(before, await books());
    expect(moved[B]).toEqual({ debit: NET, credit: NET });
    expect(moved[A], "A never saw the lock nor the payout").toEqual(untouched);
    expect(moved["1103"]).toEqual({ debit: 0, credit: NET + FEE });
  });

  it("[payable-settle-two-steps-two-remaps] items confirmed in two steps, each after another remap (B, then C): both journals debit A, the lock debt is fully paid off, B and C untouched, bank credited exactly the nets + two fees", async () => {
    const SITI_NET = 2_000_000;
    const { runId, batchId, items, before } = await lockedExported([
      bank(BUDI, NET),
      bank(SITI, SITI_NET),
    ]);
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    const siti = items.find((i) => i.employee_id === SITI.id)!;

    await withPayableMappedTo(B, () =>
      W.confirm(batchId, W.succeedItems(batchId, [budi])),
    );
    await withPayableMappedTo(C, () =>
      W.confirm(batchId, W.succeedItems(batchId, [siti])),
    );

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(2);
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toEqual({
      [A]: { debit: NET, credit: 0 },
      "1103": { debit: 0, credit: NET },
    });
    expect(await W.journalByKey(postings[1]!.journal_key as string)).toEqual({
      [A]: { debit: SITI_NET, credit: 0 },
      "1103": { debit: 0, credit: SITI_NET },
    });
    const moved = movedSince(before, await books());
    expect(
      moved[A],
      "GL equals the money that moved: nothing left owed",
    ).toEqual({ debit: NET + SITI_NET, credit: NET + SITI_NET });
    expect(moved[B]).toEqual(untouched);
    expect(moved[C]).toEqual(untouched);
    expect(moved["1103"]).toEqual({
      debit: 0,
      credit: NET + SITI_NET + 2 * FEE,
    });
    expect((await W.runRow(runId)).status).toBe("paid");
  });
});

describe("888 wcd24: a return re-opens the account the payout settled", () => {
  it("[payable-return-after-second-remap] lock on A, payout after a remap to B, return after a remap to C: Dr bank / Cr A for the net, B and C untouched, A owes the employee again, the fee stays spent", async () => {
    const { runId, batchId, items, before } = await lockedExported([
      bank(BUDI, NET),
    ]);
    await withPayableMappedTo(B, () =>
      W.confirm(batchId, W.succeedItems(batchId, items)),
    );
    const budi = await W.itemOfPerson(batchId, BUDI);

    await withPayableMappedTo(C, async () => {
      await returnItems(batchId, [idOf(budi)], APP);
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("succeeded");
      await returnItems(batchId, [idOf(budi)], APP3);
    });

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    const key = `payroll-payout-return:${idOf(budi)}`;
    expect(await W.journalByKey(key)).toEqual({
      "1103": { debit: NET, credit: 0 },
      [A]: { debit: 0, credit: NET },
    });

    const moved = movedSince(before, await books());
    // Lock Cr NET, settle Dr NET, return Cr NET: the employee is owed NET again.
    expect(moved[A]).toEqual({ debit: NET, credit: 2 * NET });
    expect(moved[B]).toEqual(untouched);
    expect(moved[C]).toEqual(untouched);
    // Bank: credited net + fee, got the net back; only the fee is gone.
    expect(moved["1103"]).toEqual({ debit: NET, credit: NET + FEE });
    expect((await W.runRow(runId)).status).toBe("paid");
  });

  it("[payable-return-control-no-remap] control: without any remap the return reopens A and nothing else moves (the plain flow keeps working)", async () => {
    const { batchId, items, before } = await lockedExported([bank(BUDI, NET)]);
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const budi = await W.itemOfPerson(batchId, BUDI);
    await returnItems(batchId, [idOf(budi)], APP);
    await returnItems(batchId, [idOf(budi)], APP3);

    const moved = movedSince(before, await books());
    expect(moved[A]).toEqual({ debit: NET, credit: 2 * NET });
    expect(moved[B]).toEqual(untouched);
    expect(moved[C]).toEqual(untouched);
  });
});

describe("888 wcd24: replays never double the journals, however the mapping moves", () => {
  it("[payable-replay-no-double] after payout (via B) and return (via C): confirming again, settling again (sequential and parallel, under a third mapping) and returning again are refused or add nothing; the ledger and the journal count stay exactly as they were", async () => {
    const { batchId, items } = await lockedExported([bank(BUDI, NET)]);
    const results = W.succeedItems(batchId, items);
    await withPayableMappedTo(B, () => W.confirm(batchId, results));
    const budi = await W.itemOfPerson(batchId, BUDI);
    await withPayableMappedTo(C, async () => {
      await returnItems(batchId, [idOf(budi)], APP);
      await returnItems(batchId, [idOf(budi)], APP3);
    });

    const booksBefore = await books();
    const journalsBefore = await journalCountOfEntity();
    const postingsBefore = await W.postingsOf(batchId);

    await withPayableMappedTo(B, async () => {
      await W.expectRefused(W.confirm(batchId, results));
      await W.expectRefused(W.confirm(batchId, results, APP3));
      await settle(batchId);
      await settle(batchId, APP3);
      await Promise.all([settle(batchId), settle(batchId, APP3)]);
      await W.expectRefused(returnItems(batchId, [idOf(budi)], APP));
      await W.expectRefused(returnItems(batchId, [idOf(budi)], APP3));
      await sweep();
    });

    expect(await books()).toEqual(booksBefore);
    expect(await journalCountOfEntity()).toBe(journalsBefore);
    expect((await W.postingsOf(batchId)).map(idOf)).toEqual(
      postingsBefore.map(idOf),
    );
    expect(await W.countJournals(`payroll-payout-return:${idOf(budi)}`)).toBe(
      1,
    );
  });

  it("[payable-replay-parallel-confirm] two simultaneous confirmations right after a remap: one wins, one settle journal, on A", async () => {
    const { batchId, items, before } = await lockedExported([bank(BUDI, NET)]);
    const results = W.succeedItems(batchId, items);
    const outcomes = await withPayableMappedTo(B, () =>
      Promise.allSettled([
        W.confirm(batchId, results, APP2),
        W.confirm(batchId, results, APP3),
      ]),
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toEqual({
      [A]: { debit: NET, credit: 0 },
      "1103": { debit: 0, credit: NET },
    });
    const moved = movedSince(before, await books());
    expect(moved[A]).toEqual({ debit: NET, credit: NET });
    expect(moved[B]).toEqual(untouched);
  });
});

describe("888 wcd24: a posting from before the fix (no frozen payable account)", () => {
  it("[payable-legacy-from-lock-journal] settlement held for the fee mapping, the row has no frozen payable account, the mapping moves to B, then the sweep settles it: the account comes from the lock journal (A is debited, B untouched), bank credited net + fee once, delisted; repeated and parallel sweeps add nothing", async () => {
    const world = await skippedWithLockOnA();
    expect(
      (await listedRow(world.posting.id as string))?.reason,
      "premise: finance sees it, held for the fee mapping",
    ).toBe("bank_charges_missing");
    await clearFrozenPayableAccount(world.runId, world.batchId);

    await setPayableMapping(B);
    await world.restoreCharges();
    await sweep();
    await sweep();
    await Promise.all([sweep(), sweep()]);

    const [posting] = await W.postingsOf(world.batchId);
    expect(posting!.kind).toBe("settle");
    expect(posting!.fee_posted).toBe(true);
    expect(await W.journalByKey(posting!.journal_key as string)).toEqual({
      [A]: { debit: NET, credit: 0 },
      "1103": { debit: 0, credit: NET },
    });
    expect(await W.journalByKey(feeKey(posting!))).toEqual(feeJournal(1));
    expect(await W.countJournals(posting!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(posting!))).toBe(1);

    const moved = movedSince(world.before, await books());
    expect(moved[A]).toEqual({ debit: NET, credit: NET });
    expect(moved[B]).toEqual(untouched);
    expect(moved[C]).toEqual(untouched);
    expect(moved["1103"]).toEqual({ debit: 0, credit: NET + FEE });
    expect(await listedRow(posting!.id as string)).toBeUndefined();
  });

  it("[payable-uncertain-held-and-listed] the lock journal credits two liability accounts (A and C) the same net, the row has no frozen account, the mapping is B: the sweep (repeated, parallel) journals nothing and guesses nothing; the posting stays settle_skipped and finance sees it in the list with a reason; no bank credit, no debit to A, B or C", async () => {
    const world = await skippedWithLockOnA();
    await makeLockJournalAmbiguous(world.runId, NET);
    await clearFrozenPayableAccount(world.runId, world.batchId);
    const afterTamper = await books();
    const journalsBefore = await journalCountOfEntity();

    await setPayableMapping(B);
    await world.restoreCharges();
    await sweep();
    await sweep();
    await Promise.all([sweep(), sweep()]);

    const [posting] = await W.postingsOf(world.batchId);
    expect(posting!.kind, "held, not settled").toBe("settle_skipped");
    expect(
      await W.journalByKey(posting!.journal_key as string),
    ).toBeUndefined();
    expect(await W.journalByKey(feeKey(posting!))).toBeUndefined();
    expect(posting!.fee_posted).toBe(false);
    for (const item of await W.itemsOf(world.batchId))
      expect(item.status).toBe("succeeded");

    expect(
      movedSince(afterTamper, await books()),
      "nothing moved: no debit to A, B or C, no bank credit, no fee",
    ).toEqual({
      "1102": untouched,
      "1103": untouched,
      "8101": untouched,
      [A]: untouched,
      [B]: untouched,
      [C]: untouched,
    });
    expect(await journalCountOfEntity()).toBe(journalsBefore);

    const listed = await listedRow(posting!.id as string);
    expect(listed, "finance can see the held posting").toBeDefined();
    expect(listed).toMatchObject({ postingId: posting!.id });
    expect(typeof listed!.reason).toBe("string");
    expect((listed!.reason as string).length).toBeGreaterThan(0);
    // The fee mapping is back, so this is not the old fee reason.
    expect(listed!.reason).not.toBe("bank_charges_missing");
  });
});
