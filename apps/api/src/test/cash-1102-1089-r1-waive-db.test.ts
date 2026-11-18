// SO 1089 P1-1 (brief 1091, SECTION R1): the `settle_skipped -> settle_waived`
// transition must not be a bare UPDATE any more. Every transition to
// `settle_waived` needs a correcting journal with the right net and accounts
// AT COMMIT (deferred constraint trigger), and only the trusted function
// app.payout_waive_skipped(batch, posting, actor, session) may flip the kind.
// Written fail-first from the brief and the CTO decisions (HTTP + DB surface
// only), NOT from the service or migration code. Model: the waive test of
// 5qqb9 (world and helpers), whose "pure flip allowed" test is replaced.
//
// CTO decisions this file pins:
// - As legend_app a direct UPDATE ... SET kind = 'settle_waived' is refused by
//   the guard trigger (not by the kind CHECK) and nothing changes.
// - The function with no journal under key payroll-payout-waive:<postingId> is
//   refused. With a journal of the wrong net, the wrong credit account or a
//   debit on an account other than the entity's salary_expense mapping, the
//   COMMIT is refused. With the right journal the function works.
// - The waive endpoint keeps working: exactly one journal and one audit row,
//   available cash unchanged, replay is a no-op.
// - A posting already settle_waived WITHOUT its journal: the endpoint answers
//   409 PAYOUT_WAIVE_NOT_ALLOWED, not 200.
// - A line added late to the waive journal in the same transaction (after the
//   function flipped the kind) makes the COMMIT fail.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The function's arguments are (batch id, posting id, actor user id, session
//   id), in that order; they are passed as untyped parameters so the exact SQL
//   types do not matter. The actor is the finance user below (holds
//   accounting.petty_cash.manage), the session is one of its sessions.
// - The exact error code of a refusal is not pinned: any database error that is
//   not "function does not exist" (42883) and, for the direct UPDATE, not the
//   kind CHECK constraint. Refusal at the function call or at COMMIT both count.
// - The journal header (entry date, period, source type and id) for the hand
//   built waive journals is copied from the journal the real endpoint posts for
//   a sibling posting, so the tests do not guess the producer's source type.
// - Test (c) is a regression guard: the endpoint happy path already works
//   before the fix, so it is expected to pass at the base commit.
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  daysAgo,
  key,
  makeBankAccount,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  APP2,
  CASHIER,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const W = installPayoutWorld("1089r1waive");
const BASE = "/api/hris/payroll/disbursement-batches";
const ENTRIES = "/api/accounting/cash-bank/entries";
const PASSWORD = "Test-password-123!";
// Small nets: a probe cash out above the tenant limit is parked
// pending_approval and could not show the 1102 refusal.
const NET = 100_000;
const EXTRA = 2_000_000;
const KIND_CHECK = "payroll_payout_gl_postings_kind_check";
const UNDEFINED_FUNCTION = "42883";

withLimitSharedLock();

// ---- people and accounts ----------------------------------------------------

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];
let waiver: Client;
let waiverUserId: string;
let waiverSessionId: string;
let probeFinance: Session;
let pettyGlId: string;
let pettyBankId: string;
let expenseAccountId: string;
let salaryAccountId: string;
let otherCreditAccountId: string;
/** GL code mapped to role salary_expense. */
let salaryCode: string;
/** Net of the settle_skipped postings this file created and nobody waived. */
let reserve = 0;
/** Free cash (GL 1102 minus reserve) every scenario must find. */
let free = EXTRA;

async function enrolledActor(label: string, permissions: string[]) {
  const { client, userId } = await W.signedInClient(`Waive1089 ${label}`);
  await W.grantRole(userId, permissions);
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
  return { client, userId };
}

const accountId = async (code: string) =>
  (
    await kitOwner.query<{ id: string }>(
      "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
      [tenantId, W.entityId(), code],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const actor = await enrolledActor("Waiver", [
    "payroll.view",
    "accounting.petty_cash.manage",
  ]);
  waiver = actor.client;
  waiverUserId = actor.userId;
  const sessions = await kitOwner.query<{ id: string }>(
    `SELECT s.id FROM session s
      WHERE to_jsonb(s)->>'user_id' = $1 OR to_jsonb(s)->>'userId' = $1
      LIMIT 1`,
    [waiverUserId],
  );
  expect(sessions.rows, "premise: the waiver has a session").toHaveLength(1);
  waiverSessionId = sessions.rows[0]!.id;
  probeFinance = await signedIn(app, "1089 r1 waive finance", [
    { role: "finance", outletId: null },
  ]);
  pettyGlId = await accountId("1102");
  otherCreditAccountId = await accountId("1103");
  pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6991', 'Beban Uji 1089', 'expense', 'operating_expense')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId()],
  );
  expenseAccountId = await accountId("6991");
  const salary = await kitOwner.query<{ code: string; id: string }>(
    `SELECT a.code, a.id FROM account_mappings m
       JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
      WHERE m.tenant_id = $1 AND m.legal_entity_id = $2 AND m.role = 'salary_expense'`,
    [tenantId, W.entityId()],
  );
  expect(salary.rows, "premise: salary_expense is mapped").toHaveLength(1);
  salaryCode = salary.rows[0]!.code;
  salaryAccountId = salary.rows[0]!.id;
  await W.fundPettyCash(EXTRA);
});

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
  await closeKit();
});

// ---- helpers ----------------------------------------------------------------

async function withAccountingOff<T>(work: () => Promise<T>) {
  const before = await kitOwner.query<{ flags: unknown }>(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId],
  );
  const original = before.rows[0]!.flags as { modules?: string[] };
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await kitOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenantId,
      JSON.stringify({
        ...original,
        modules: (original.modules ?? []).filter((m) => m !== "accounting"),
      }),
    ],
  );
  try {
    return await work();
  } finally {
    await kitOwner.query(
      "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
      [tenantId, JSON.stringify(original)],
    );
  }
}

const waiveKeyOf = (postingId: string) => `payroll-payout-waive:${postingId}`;

const waiveJournalIds = async (postingId: string) =>
  (
    await kitOwner.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
      [tenantId, W.entityId(), waiveKeyOf(postingId)],
    )
  ).rows.map((r) => r.id);

async function glBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.balance);
}

const available = async () => (await glBalance()) - reserve;

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

const auditRowsOf = async (batchId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
        [W.tenantId, batchId],
      )
    )[0]!.n,
  );

const digitsOf = (text: string) => text.replace(/(?<=\d)[.,](?=\d)/g, "");

const cashOut = (amountIdr: number) =>
  probeFinance.client
    .post(ENTRIES)
    .set(originHeader)
    .send({
      legalEntityId: W.entityId(),
      entryDate: daysAgo(0),
      description: "Uji kas 1102 1089 r1",
      reference: `REF-${randomBytes(3).toString("hex")}`,
      idempotencyKey: key(),
      kind: "cash_out",
      bankAccountId: pettyBankId,
      counterAccountId: expenseAccountId,
      amountIdr,
    });

/** Available cash is exactly `avail`: spending one rupiah more is refused and the message names it. */
async function expectAvailableIs(avail: number, why: string) {
  expect(await available(), `${why}: tracked available`).toBe(avail);
  const gl = await glBalance();
  const journals = await journalCount();
  const res = await cashOut(avail + 1);
  const detail = JSON.stringify(res.body);
  expect([409, 422], `${why}: status ${res.status} ${detail}`).toContain(
    res.status,
  );
  expect(res.body.error?.code, `${why}: ${detail}`).toBe(
    "PETTY_CASH_GL_INSUFFICIENT",
  );
  expect(
    digitsOf(String(res.body.error?.message ?? "")),
    `${why}: the message names the available cash`,
  ).toContain(String(avail));
  expect(await glBalance(), `${why}: refused cash out moved nothing`).toBe(gl);
  expect(await journalCount()).toBe(journals);
}

type Posting = Record<string, unknown> & {
  id: string;
  kind: string;
  journal_key: string;
};

/** Cash batch handed over while accounting is OFF: a final settle_skipped. Reserve grows by `net`. */
async function skippedHandover(net = NET) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  await W.fundPettyCash(net); // keeps available at EXTRA, covers the approve guard
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  expect(postings[0]!.kind, "premise: settle_skipped").toBe("settle_skipped");
  reserve += net;
  return { batchId, runId, net, posting: postings[0] as Posting };
}

type Handover = Awaited<ReturnType<typeof skippedHandover>>;

const waive = (
  client: Client,
  batchId: string,
  postingId: string,
  reason = "Kas sudah diserahkan, jurnal gaji tidak bisa dibuat",
) =>
  client
    .post(`${BASE}/${batchId}/postings/${postingId}/waive-skipped`)
    .set(originHeader)
    .send({ password: PASSWORD, reason });

const kindOf = async (batchId: string) =>
  (await W.postingsOf(batchId))[0]!.kind as string;

/** A legend_app transaction with a real COMMIT; returns the first error (statement or commit). */
async function appTx(work: (client: PoolClient) => Promise<void>) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      await work(client);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return error as { code?: string; constraint?: string; message: string };
    }
  } finally {
    client.release();
  }
}

type Line = { accountId: string; debit: number; credit: number };
type Header = {
  entryDate: string;
  periodId: string;
  sourceType: string;
  sourceId: string | null;
};

/**
 * Header of the journal the real waive endpoint posts for a sibling posting,
 * mapped onto `target` (its posting and batch ids replace the sibling's).
 */
async function realWaiveHeader(target: Handover): Promise<Header> {
  const sibling = await skippedHandover();
  const res = await waive(waiver, sibling.batchId, sibling.posting.id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  reserve -= sibling.net;
  const rows = await kitOwner.query<{
    entry_date: string;
    fiscal_period_id: string;
    source_type: string;
    source_id: string | null;
  }>(
    `SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date, fiscal_period_id,
            source_type, source_id
       FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId, W.entityId(), waiveKeyOf(sibling.posting.id)],
  );
  expect(rows.rows, "premise: the real waive journal exists").toHaveLength(1);
  const row = rows.rows[0]!;
  const sourceId =
    row.source_id === sibling.posting.id
      ? target.posting.id
      : row.source_id === sibling.batchId
        ? target.batchId
        : row.source_id === sibling.runId
          ? target.runId
          : row.source_id;
  return {
    entryDate: row.entry_date,
    periodId: row.fiscal_period_id,
    sourceType: row.source_type,
    sourceId,
  };
}

async function insertEntry(
  client: PoolClient,
  postingId: string,
  header: Header,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'Waive 1089 r1 test', NULL, $7, $8)
     RETURNING id`,
    [
      W.tenantId,
      W.entityId(),
      header.entryDate,
      header.periodId,
      header.sourceType,
      header.sourceId,
      waiveKeyOf(postingId),
      randomBytes(32).toString("hex"),
    ],
  );
  return rows[0]!.id;
}

/** One statement, so every line exists when per-row triggers run. */
async function addLines(
  client: PoolClient,
  entryId: string,
  lines: Line[],
  firstNo: number,
) {
  const values = lines
    .map(
      (_, i) =>
        `($1, $2, $${i * 3 + 3}, ${firstNo + i}, $${i * 3 + 4}, $${i * 3 + 5}, NULL)`,
    )
    .join(", ");
  await client.query(
    `INSERT INTO journal_lines
       (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
     VALUES ${values}`,
    [
      W.tenantId,
      entryId,
      ...lines.flatMap((l) => [l.accountId, l.debit, l.credit]),
    ],
  );
}

/** The trusted function, called as legend_app inside `client`'s transaction. */
const callWaiveFunction = (client: PoolClient, h: Handover) =>
  client.query("SELECT app.payout_waive_skipped($1, $2, $3, $4)", [
    h.batchId,
    h.posting.id,
    waiverUserId,
    waiverSessionId,
  ]);

const sourceAccountOf = (h: Handover) =>
  h.posting.source_gl_account_id as string;

const correctLines = (h: Handover): Line[] => [
  { accountId: salaryAccountId, debit: h.net, credit: 0 },
  { accountId: sourceAccountOf(h), debit: 0, credit: h.net },
];

/** Owner-role transaction with triggers off (setup only). */
async function withOwnerNoTriggers<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The refusal is a real guard, not a missing function. */
const expectGuardError = (
  error: { code?: string; message: string } | null,
  why: string,
) => {
  expect(error, `${why}: must be refused`).not.toBeNull();
  expect(
    error!.code,
    `${why}: refused by a guard, not for a missing function (${error!.message})`,
  ).not.toBe(UNDEFINED_FUNCTION);
};

async function expectUntouched(h: Handover, why: string) {
  expect(await kindOf(h.batchId), `${why}: kind`).toBe("settle_skipped");
  expect(await waiveJournalIds(h.posting.id), `${why}: no journal`).toEqual([]);
  await expectAvailableIs(free, `${why}: available cash`);
}

// ---- scenarios ----------------------------------------------------------------

describe("1089 R1: settle_waived only through the trusted function with its journal", () => {
  it("[1089-r1-a-legend-app-flip-refused] as legend_app a direct UPDATE of kind to settle_waived is refused by the guard (not the kind check): the row stays settle_skipped and available cash is unchanged", async () => {
    const h = await skippedHandover();
    await expectAvailableIs(free, "before");

    const error = await appTx(async (client) => {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET kind = 'settle_waived'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, h.posting.id],
      );
    });
    if (error === null) {
      // Not refused (old behaviour): keep the trackers true for later tests.
      reserve -= h.net;
      free += h.net;
    }

    expect(error, "the direct flip must be refused").not.toBeNull();
    expect(
      error!.constraint,
      `refused by the guard, not the kind check (${error!.message})`,
    ).not.toBe(KIND_CHECK);
    await expectUntouched(h, "after the refused flip");
  }, 90_000);

  it("[1089-r1-b0-function-with-right-journal-works] the trusted function with the right journal (Dr salary expense / Cr the handover's 1102 account, net each, key payroll-payout-waive:<postingId>) commits: settle_waived, GL 1102 and reserve both down by the net, available cash unchanged", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);
    const glBefore = await glBalance();

    const error = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(client, entry, correctLines(h), 1);
      await callWaiveFunction(client, h);
    });

    expect(error?.message, "right journal + function must commit").toBe(
      undefined,
    );
    reserve -= h.net;
    expect(await kindOf(h.batchId)).toBe("settle_waived");
    expect(await glBalance()).toBe(glBefore - h.net);
    expect(await W.journalByKey(waiveKeyOf(h.posting.id))).toEqual({
      [salaryCode]: { debit: h.net, credit: 0 },
      "1102": { debit: 0, credit: h.net },
    });
    await expectAvailableIs(free, "available cash unchanged");
  }, 120_000);

  it("[1089-r1-b1-function-without-journal-refused] the trusted function with no journal under the waive key is refused: the row stays settle_skipped, no journal appears", async () => {
    const h = await skippedHandover();

    const error = await appTx(async (client) => {
      await callWaiveFunction(client, h);
    });

    expectGuardError(error, "no journal");
    await expectUntouched(h, "no journal");
  }, 90_000);

  it("[1089-r1-b2-wrong-net-refused-at-commit] a waive journal of the wrong net (Dr salary expense / Cr 1102 for net + 1) with the function call: COMMIT is refused, the row stays settle_skipped and no journal stays", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);

    const error = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(
        client,
        entry,
        [
          { accountId: salaryAccountId, debit: h.net + 1, credit: 0 },
          { accountId: sourceAccountOf(h), debit: 0, credit: h.net + 1 },
        ],
        1,
      );
      await callWaiveFunction(client, h);
    });

    expectGuardError(error, "wrong net");
    await expectUntouched(h, "wrong net");
  }, 120_000);

  it("[1089-r1-b3-wrong-credit-account-refused-at-commit] a waive journal of the right net that credits another account than the handover's 1102 account (here 1103): COMMIT is refused, the row stays settle_skipped and no journal stays", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);

    const error = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(
        client,
        entry,
        [
          { accountId: salaryAccountId, debit: h.net, credit: 0 },
          { accountId: otherCreditAccountId, debit: 0, credit: h.net },
        ],
        1,
      );
      await callWaiveFunction(client, h);
    });

    expectGuardError(error, "wrong credit account");
    await expectUntouched(h, "wrong credit account");
  }, 120_000);

  it("[1089-r1-b4-debit-not-salary-expense-refused-at-commit] a waive journal of the right net that debits an account other than the salary_expense mapping (here a plain expense account): COMMIT is refused, the row stays settle_skipped and no journal stays", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);

    const error = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(
        client,
        entry,
        [
          { accountId: expenseAccountId, debit: h.net, credit: 0 },
          { accountId: sourceAccountOf(h), debit: 0, credit: h.net },
        ],
        1,
      );
      await callWaiveFunction(client, h);
    });

    expectGuardError(error, "debit not on salary expense");
    await expectUntouched(h, "debit not on salary expense");
  }, 120_000);

  it("[1089-r1-e-late-line-after-flip-refused-at-commit] the right journal and the function call, then a line added later in the same transaction (a balanced Dr salary expense / Cr 1102 pair of 4.999, and in a second try one unbalanced Dr line of 1): COMMIT is refused, the row stays settle_skipped and no journal stays", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);

    const balancedLate = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(client, entry, correctLines(h), 1);
      await callWaiveFunction(client, h);
      await addLines(
        client,
        entry,
        [
          { accountId: salaryAccountId, debit: 4_999, credit: 0 },
          { accountId: sourceAccountOf(h), debit: 0, credit: 4_999 },
        ],
        3,
      );
    });
    expectGuardError(balancedLate, "late balanced pair");
    await expectUntouched(h, "late balanced pair");

    const unbalancedLate = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(client, entry, correctLines(h), 1);
      await callWaiveFunction(client, h);
      await addLines(
        client,
        entry,
        [{ accountId: salaryAccountId, debit: 1, credit: 0 }],
        3,
      );
    });
    expectGuardError(unbalancedLate, "late unbalanced line");
    await expectUntouched(h, "late unbalanced line");
  }, 120_000);
});

describe("1089 R1 round 2: the trusted function re-checks the current petty cash mapping and the locked journal", () => {
  it("[1089-r1-f-remapped-petty-cash-refused] after the entity's petty_cash mapping is moved to another account, the function with an otherwise right journal (credit on the handover's old 1102 account) is refused: the row stays settle_skipped, no journal stays", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);
    const mapping = [W.tenantId, W.entityId()];
    await kitOwner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'`,
      [...mapping, otherCreditAccountId],
    );
    let error: Awaited<ReturnType<typeof appTx>>;
    try {
      error = await appTx(async (client) => {
        const entry = await insertEntry(client, h.posting.id, header);
        await addLines(client, entry, correctLines(h), 1);
        await callWaiveFunction(client, h);
      });
    } finally {
      await kitOwner.query(
        `UPDATE account_mappings SET account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'`,
        [...mapping, pettyGlId],
      );
    }

    expectGuardError(error, "petty_cash remapped");
    await expectUntouched(h, "petty_cash remapped");
  }, 120_000);

  it("[1089-r1-g-run-with-locked-journal-refused] when the run already has its payroll.locked journal (key payroll-gl:locked:<run>), the function with an otherwise right journal is refused: the row stays settle_skipped, no waive journal stays", async () => {
    const h = await skippedHandover();
    const header = await realWaiveHeader(h);
    const lockedKey = `payroll-gl:locked:${h.runId}`;
    const lockedId = await withOwnerNoTriggers(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 'payroll', $5, 'Jurnal kunci gaji uji 1089 r1', $6, $7)
         RETURNING id`,
        [
          W.tenantId,
          W.entityId(),
          header.entryDate,
          header.periodId,
          h.runId,
          lockedKey,
          randomBytes(32).toString("hex"),
        ],
      );
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
        [W.tenantId, rows[0]!.id, salaryAccountId, otherCreditAccountId, h.net],
      );
      return rows[0]!.id;
    });
    let error: Awaited<ReturnType<typeof appTx>>;
    try {
      error = await appTx(async (client) => {
        const entry = await insertEntry(client, h.posting.id, header);
        await addLines(client, entry, correctLines(h), 1);
        await callWaiveFunction(client, h);
      });
    } finally {
      await withOwnerNoTriggers(async (client) => {
        await client.query(
          "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2",
          [W.tenantId, lockedId],
        );
        await client.query(
          "DELETE FROM journal_entries WHERE tenant_id = $1 AND id = $2",
          [W.tenantId, lockedId],
        );
      });
    }

    expectGuardError(error, "run has a locked journal");
    await expectUntouched(h, "run has a locked journal");
  }, 120_000);
});

describe("1089 R1: the waive endpoint", () => {
  it("[1089-r1-c-endpoint-happy-path-one-journal-one-audit] waive with a reason: 200, settle_waived, exactly one journal (Dr salary expense / Cr 1102, net each) and one audit row; available cash unchanged, and a replay is a 200 no-op that adds no journal and no audit row (regression guard: passes before the fix)", async () => {
    const h = await skippedHandover();
    const glBefore = await glBalance();
    const journals = await journalCount();
    const auditBefore = await auditRowsOf(h.batchId);

    const res = await waive(waiver, h.batchId, h.posting.id);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    reserve -= h.net;
    expect(await kindOf(h.batchId)).toBe("settle_waived");
    expect(await glBalance(), "GL 1102 down by the net").toBe(glBefore - h.net);
    expect(await journalCount(), "exactly one journal").toBe(journals + 1);
    expect(await waiveJournalIds(h.posting.id)).toHaveLength(1);
    expect(await W.journalByKey(waiveKeyOf(h.posting.id))).toEqual({
      [salaryCode]: { debit: h.net, credit: 0 },
      "1102": { debit: 0, credit: h.net },
    });
    expect(await auditRowsOf(h.batchId), "exactly one audit row").toBe(
      auditBefore + 1,
    );
    await expectAvailableIs(free, "available cash unchanged");

    const replay = await waive(
      waiver,
      h.batchId,
      h.posting.id,
      "Alasan lain pada panggilan kedua",
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(await journalCount(), "no second journal").toBe(journals + 1);
    expect(await waiveJournalIds(h.posting.id)).toHaveLength(1);
    expect(await auditRowsOf(h.batchId), "no second audit row").toBe(
      auditBefore + 1,
    );
    await expectAvailableIs(free, "available cash unchanged after replay");
  }, 120_000);

  it("[1089-r1-d-already-waived-without-journal-409] a posting that is already settle_waived but has no waive journal (set up by the owner role with triggers off) is answered 409 PAYOUT_WAIVE_NOT_ALLOWED by the endpoint, not 200: no journal is posted, no audit row is written", async () => {
    const h = await skippedHandover();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET kind = 'settle_waived'
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, h.posting.id],
        ),
      true,
    );
    // The row no longer reserves cash (it was waived without booking anything).
    reserve -= h.net;
    free += h.net;
    expect(await kindOf(h.batchId), "premise: waived").toBe("settle_waived");
    expect(await waiveJournalIds(h.posting.id), "premise: no journal").toEqual(
      [],
    );
    const journals = await journalCount();
    const audit = await auditRowsOf(h.batchId);

    const res = await waive(waiver, h.batchId, h.posting.id);

    expect(res.body.error?.message, "route must exist").not.toBe(
      "Route not found.",
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
      "PAYOUT_WAIVE_NOT_ALLOWED",
    );
    expect(await journalCount(), "no journal posted").toBe(journals);
    expect(await waiveJournalIds(h.posting.id)).toEqual([]);
    expect(await auditRowsOf(h.batchId), "no audit row").toBe(audit);
    expect(await kindOf(h.batchId)).toBe("settle_waived");
  }, 90_000);
});
