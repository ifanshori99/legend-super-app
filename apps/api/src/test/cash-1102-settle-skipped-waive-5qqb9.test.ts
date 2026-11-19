// 5qqb9 P2 (round 2): a cash payroll handover done while accounting was OFF
// ends as a `settle_skipped` posting. It keeps counting as a reserve against GL
// 1102 (nobody may spend that cash twice). The catch-up journal is impossible
// without the payroll.locked journal, so finance gets an official MANUAL
// "waive" instead (kind `settle_waived`, terminal, audited). Round 2: the waive
// posts a correcting journal in the SAME transaction (Dr salary expense / Cr
// 1102 of the handover, net, key `payroll-payout-waive:<postingId>`), so the
// cash that left the till is really booked: GL 1102 -net, reserve -net,
// available cash UNCHANGED:
//   POST /api/hris/payroll/disbursement-batches/:id/postings/:postingId/waive-skipped
//   body { password, reason (trimmed, 1..500) }
// Written fail-first from the brief (scratchpad brief-5qqb9.md, "P2 REVISED"),
// the founder rule "nobody is paid twice, GL 1102 never goes negative", and the
// HTTP + DB surface only, NOT from the service code.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Permission: accounting.petty_cash.manage (the finance actor below holds it
//   plus payroll.view, TOTP enrolled and verified in this session, so the
//   password step-up applies). A user with only payroll.disburse.approve, or
//   only payroll.view, is refused 403.
// - Success 200; replay on settle_waived = 200 no-op, no second audit row.
// - Refusals: reason missing/blank/over 500 chars -> 422; posting not
//   settle_skipped (here settle_pending) -> 409; unknown ids -> 404; missing or
//   wrong password -> a 4xx in {400,401,403,422} (exact code not pinned); never
//   "Route not found.".
// - Round 2 (brief "ROUND 2 A"): the journal needs accounting ON (409
//   PAYOUT_WAIVE_NOT_ALLOWED when off). Salary expense is the account mapped to
//   role `salary_expense` (the role the payroll.locked journal debits; the
//   standard chart maps it to 6101). Role unmapped -> 409 (code not pinned,
//   non-empty message), no flip, no journal. GL 1102 below the net -> 422
//   PETTY_CASH_GL_INSUFFICIENT, no flip, no journal. Closed fiscal period ->
//   a 4xx refusal in {409,422} (code not pinned), no flip, no journal.
// - Waiving moves the net out of GL 1102 (journal) AND out of the reserve:
//   available cash is UNCHANGED, exactly one journal exists under the waive key.
// - Audit: exactly one new audit_logs row mentioning the batch, containing the
//   reason, the net and the journal entry id; its action name is not pinned.
// - DB level: the guard trigger must allow a pure flip settle_skipped ->
//   settle_waived (only `kind` changes) and refuse the flip when any other
//   column changes in the same UPDATE (refused by the trigger, NOT by the
//   kind CHECK constraint, which is what refuses it before the migration), and
//   a waived row can never go back (to settle_skipped / settle).
// - "resolvePendingSettles ignores a waived row" is not driven here: it is a
//   service call with no HTTP surface named in the brief. Covered indirectly:
//   no journal exists for a waived posting after replay and flip-back is refused.
// - "Other tenant -> 404" is not covered over HTTP (no second tenant client in
//   this world); unknown ids are the stand-in. Flagged in the report.
import { randomBytes, randomUUID } from "node:crypto";
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
const W = installPayoutWorld("5qqb9waive");
const BASE = "/api/hris/payroll/disbursement-batches";
const ENTRIES = "/api/accounting/cash-bank/entries";
const PASSWORD = "Test-password-123!";
// Small nets: every waive adds one to the free cash, and a probe cash out above
// the tenant limit (default Rp5.000.000) is parked pending_approval with the 1102
// guard deferred to approval, so it could not show the refusal. 12 scenarios
// stay far below the limit.
const NET = 100_000;
const EXTRA = 2_000_000;

withLimitSharedLock();

// ---- people -----------------------------------------------------------------

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];
let approver: Client;
let waiver: Client;
let viewer: Client;
let probeFinance: Session;
let pettyGlId: string;
let pettyBankId: string;
let expenseAccountId: string;
/** GL code mapped to role salary_expense (the account the payroll.locked journal debits). */
let salaryCode: string;
/** Net of the settle_skipped / settle_pending postings this file created and nobody caught up. */
let reserve = 0;
/** Free cash (GL 1102 minus reserve) every scenario must find: EXTRA plus the nets finance waived. */
let free = EXTRA;

/** Disburse permission, TOTP enrolled and verified in this session (enrollment-only: needs the password). */
async function enrolledActor(label: string, permissions: string[]) {
  const { client, userId } = await W.signedInClient(`Waive5qqb9 ${label}`);
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
  return client;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  approver = await enrolledActor("Approver", [
    "payroll.view",
    "payroll.disburse.approve",
  ]);
  waiver = await enrolledActor("Waiver", [
    "payroll.view",
    "accounting.petty_cash.manage",
  ]);
  const v = await W.signedInClient("Waive5qqb9 Viewer");
  await W.grantRole(v.userId, ["payroll.view"]);
  viewer = v.client;
  probeFinance = await signedIn(app, "5qqb9 waive finance", [
    { role: "finance", outletId: null },
  ]);
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
  pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6990', 'Beban Uji 5qqb9', 'expense', 'operating_expense')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId()],
  );
  const expense = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '6990'",
    [tenantId, W.entityId()],
  );
  expenseAccountId = expense.rows[0]!.id;
  const salary = await kitOwner.query<{ code: string }>(
    `SELECT a.code FROM account_mappings m
       JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
      WHERE m.tenant_id = $1 AND m.legal_entity_id = $2 AND m.role = 'salary_expense'`,
    [tenantId, W.entityId()],
  );
  expect(salary.rows, "premise: salary_expense is mapped").toHaveLength(1);
  salaryCode = salary.rows[0]!.code;
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

/** Runs `work` with every fiscal period of the entity closed; reopens them after (triggers off, test setup only). */
async function withPeriodsClosed<T>(work: () => Promise<T>) {
  await kitOwner.query(
    `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'open'`,
    [tenantId, W.entityId(), randomUUID()],
  );
  try {
    return await work();
  } finally {
    await reopenPeriods();
  }
}

async function reopenPeriods() {
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE fiscal_periods SET status = 'open', closed_by = NULL, closed_at = NULL, version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND status = 'closed'`,
      [tenantId, W.entityId()],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Runs `work` with the salary_expense role unmapped (setup SQL, triggers off); the mapping is restored after. */
async function withSalaryMappingMissing<T>(work: () => Promise<T>) {
  const removed = await W.asTenant(
    (c) =>
      c.query<{ account_id: string }>(
        `DELETE FROM account_mappings
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'salary_expense'
          RETURNING account_id`,
        [W.tenantId, W.entityId()],
      ),
    true,
  );
  expect(removed.rows, "premise: mapping removed").toHaveLength(1);
  try {
    return await work();
  } finally {
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, 'salary_expense', $3)`,
          [W.tenantId, W.entityId(), removed.rows[0]!.account_id],
        ),
      true,
    );
  }
}

/** Drains GL 1102 (Dr 1103 / Cr 1102, seeded by SQL like W.fundPettyCash) until `leave` rupiah remain; returns the drained amount. */
async function drainGlTo(leave: number) {
  const amount = (await glBalance()) - leave;
  expect(amount, "premise: GL can be drained").toBeGreaterThan(0);
  const date = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  await W.asTenant(async (c) => {
    const account = async (code: string) =>
      (
        await c.query(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
          [W.tenantId, W.entityId(), code],
        )
      ).rows[0].id as string;
    const period = (
      await c.query(
        `SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3`,
        [W.tenantId, W.entityId(), date.slice(0, 7)],
      )
    ).rows[0].id as string;
    const entry = (
      await c.query(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Kuras kas kecil uji 5qqb9', $5, $6)
         RETURNING id`,
        [
          W.tenantId,
          W.entityId(),
          date,
          period,
          `drain-1102-${randomUUID()}`,
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0].id as string;
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [W.tenantId, entry, await account("1103"), await account("1102"), amount],
    );
  }, true);
  return amount;
}

const waiveKeyOf = (postingId: string) => `payroll-payout-waive:${postingId}`;

/** Journal entry ids under the waive key of this posting (0 or 1 expected). */
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

/** Cash out of 1102 of `amountIdr`, answered as is. */
const cashOut = (amountIdr: number) =>
  probeFinance.client
    .post(ENTRIES)
    .set(originHeader)
    .send({
      legalEntityId: W.entityId(),
      entryDate: daysAgo(0),
      description: "Uji kas 1102 5qqb9",
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
  return { batchId, runId, slips, net, posting: postings[0] as Posting };
}

/** Body part with the default reason. */
const waiveBody = (
  reason: unknown = "Kas sudah diserahkan, jurnal gaji tidak bisa dibuat",
) => (reason === undefined ? {} : { reason });

const waive = (
  client: Client,
  batchId: string,
  postingId: string,
  body: Record<string, unknown> | null = {
    password: PASSWORD,
    ...waiveBody(),
  },
) =>
  client
    .post(`${BASE}/${batchId}/postings/${postingId}/waive-skipped`)
    .set(originHeader)
    .send(body ?? {});

const kindOf = async (batchId: string) =>
  (await W.postingsOf(batchId))[0]!.kind as string;

const notRouteMissing = (res: { body: { error?: { message?: string } } }) =>
  expect(res.body.error?.message, "route must exist").not.toBe(
    "Route not found.",
  );

/** Runs `work`; returns the database error it raised, or null when it succeeded. */
async function dbError(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (error) {
    return error as { code?: string; constraint?: string; message: string };
  }
}

const KIND_CHECK = "payroll_payout_gl_postings_kind_check";

/** UPDATE of the posting row with triggers ON (the guard trigger runs). */
const updatePosting = (postingId: string, setSql: string) =>
  W.asTenant((c) =>
    c.query(
      `UPDATE payroll_payout_gl_postings SET ${setSql}
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, postingId],
    ),
  );

/**
 * Flips the posting to settle_waived as the table owner with triggers off: the
 * only way left to reach that state without the trusted function and journal
 * (legend-1089, migration 0691). Used to test the terminal rule of the guard.
 */
async function forceWaived(postingId: string) {
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE payroll_payout_gl_postings SET kind = 'settle_waived'
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, postingId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---- scenarios ----------------------------------------------------------------

describe("5qqb9 P2: settle_skipped keeps counting as a reserve", () => {
  it("[5qqb9-skipped-stays-reserve] a handover done while accounting is off is a settle_skipped credit that still counts against GL 1102: back with accounting on, a cash out above the available cash is refused, nothing posted by itself", async () => {
    await expectAvailableIs(free, "premise: free cash before");
    const { batchId, posting } = await skippedHandover();

    await expectAvailableIs(free, "after the skipped handover");
    expect(await kindOf(batchId), "still skipped, nothing waives it").toBe(
      "settle_skipped",
    );
    expect(
      await W.journalByKey(posting.journal_key),
      "no settle journal yet",
    ).toBeUndefined();
  }, 90_000);
});

describe("5qqb9 P2: finance waives a skipped posting", () => {
  it("[5qqb9-waive-skipped-posts-journal] waive with a reason: 200, kind settle_waived, one journal Dr salary expense / Cr 1102 for the net under key payroll-payout-waive:<postingId>, GL 1102 down by the net, reserve down by the net so available cash is UNCHANGED, exactly one audit row with the reason, the net and the journal id", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const glBefore = await glBalance();
    const journals = await journalCount();
    const auditBefore = await auditRowsOf(batchId);
    await expectAvailableIs(free, "before the waive");
    expect(await waiveJournalIds(posting.id), "premise: no journal").toEqual(
      [],
    );
    const reason = `Waive uji ${randomBytes(3).toString("hex")}`;

    const res = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    reserve -= net;
    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await glBalance(), "GL 1102 down by the net").toBe(glBefore - net);
    expect(await journalCount(), "exactly one new journal").toBe(journals + 1);
    expect(
      await W.journalByKey(waiveKeyOf(posting.id)),
      "Dr salary expense / Cr 1102, net each",
    ).toEqual({
      [salaryCode]: { debit: net, credit: 0 },
      "1102": { debit: 0, credit: net },
    });
    await expectAvailableIs(free, "available cash unchanged by the waive");
    expect(await auditRowsOf(batchId), "one audit row").toBe(auditBefore + 1);
    const audit = await W.rowsOf(
      `SELECT event::text AS event FROM audit_logs
        WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
      [W.tenantId, reason],
    );
    expect(audit, "the audit row carries the reason").toHaveLength(1);
    const text = String(audit[0]!.event);
    expect(digitsOf(text), "and the net").toContain(String(net));
    const [journalId] = await waiveJournalIds(posting.id);
    expect(journalId, "premise: journal exists").toBeDefined();
    expect(text, "and the journal id").toContain(journalId);
  }, 90_000);

  it("[5qqb9-waive-skipped-accounting-off-409] accounting off: the journal cannot be posted, so the waive is refused 409 PAYOUT_WAIVE_NOT_ALLOWED: kind, GL, journals, audit and reserve unchanged", async () => {
    const { batchId, posting } = await skippedHandover();
    const journals = await journalCount();
    const gl = await glBalance();
    const audit = await auditRowsOf(batchId);

    const res = await withAccountingOff(() =>
      waive(waiver, batchId, posting.id),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe("PAYOUT_WAIVE_NOT_ALLOWED");
    expect(String(res.body.error?.message ?? "")).not.toBe("");
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await journalCount()).toBe(journals);
    expect(await glBalance()).toBe(gl);
    expect(await auditRowsOf(batchId)).toBe(audit);
    await expectAvailableIs(free, "reserve still counted");
  }, 90_000);

  it("[5qqb9-waive-skipped-expense-mapping-missing-409] the salary_expense role is unmapped: refused 409 with a message for finance, no flip, no journal, no audit row; with the mapping back the same waive works", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const journals = await journalCount();
    const gl = await glBalance();
    const audit = await auditRowsOf(batchId);

    const res = await withSalaryMappingMissing(() =>
      waive(waiver, batchId, posting.id),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    notRouteMissing(res);
    expect(String(res.body.error?.message ?? "")).not.toBe("");
    expect(await kindOf(batchId), "no flip").toBe("settle_skipped");
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance()).toBe(gl);
    expect(await auditRowsOf(batchId)).toBe(audit);
    await expectAvailableIs(free, "reserve still counted");

    const retry = await waive(waiver, batchId, posting.id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    reserve -= net;
    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await waiveJournalIds(posting.id)).toHaveLength(1);
  }, 90_000);

  it("[5qqb9-waive-skipped-gl-insufficient-422] GL 1102 below the net: refused 422 PETTY_CASH_GL_INSUFFICIENT (GL must never go negative): no flip, no journal, no audit row; after filling the till the same waive works", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const drained = await drainGlTo(net - 1);
    let res: Awaited<ReturnType<typeof waive>>;
    let journalsAfter: number;
    let glAfter: number;
    const journalsBefore = await journalCount();
    const audit = await auditRowsOf(batchId);
    try {
      res = await waive(waiver, batchId, posting.id);
      journalsAfter = await journalCount();
      glAfter = await glBalance();
    } finally {
      await W.fundPettyCash(drained);
    }

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error?.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    expect(String(res.body.error?.message ?? ""), "Indonesian message").toMatch(
      /kas/i,
    );
    expect(await kindOf(batchId), "no flip").toBe("settle_skipped");
    expect(journalsAfter, "no journal").toBe(journalsBefore);
    expect(glAfter, "GL untouched").toBe(net - 1);
    expect(await waiveJournalIds(posting.id)).toEqual([]);
    expect(await auditRowsOf(batchId)).toBe(audit);
    await expectAvailableIs(free, "reserve still counted after refill");

    const retry = await waive(waiver, batchId, posting.id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    reserve -= net;
    expect(await kindOf(batchId)).toBe("settle_waived");
  }, 90_000);

  it("[5qqb9-waive-skipped-period-closed-refused] every fiscal period closed: the waive is refused (409 or 422), no flip, no journal, no audit row, GL and reserve unchanged", async () => {
    const { batchId, posting } = await skippedHandover();
    const journals = await journalCount();
    const gl = await glBalance();
    const audit = await auditRowsOf(batchId);

    const res = await withPeriodsClosed(() =>
      waive(waiver, batchId, posting.id),
    );

    expect([409, 422], JSON.stringify(res.body)).toContain(res.status);
    notRouteMissing(res);
    expect(res.body.error?.code, "a real refusal").not.toBe(
      "PAYOUT_WAIVE_NOT_ALLOWED",
    );
    expect(await kindOf(batchId), "no flip").toBe("settle_skipped");
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance()).toBe(gl);
    expect(await auditRowsOf(batchId)).toBe(audit);
    await expectAvailableIs(free, "reserve still counted");
  }, 90_000);

  it("[5qqb9-waive-skipped-replay-noop] a second call is a no-op 200: still settle_waived, still exactly one journal under the waive key, no second audit row, GL, journals and available cash unchanged", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const first = await waive(waiver, batchId, posting.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    reserve -= net;
    const audit = await auditRowsOf(batchId);
    const gl = await glBalance();
    const journals = await journalCount();
    const [journalId] = await waiveJournalIds(posting.id);
    expect(journalId, "premise: first call posted the journal").toBeDefined();

    const replay = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason: "Alasan lain pada panggilan kedua",
    });

    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await auditRowsOf(batchId), "no second audit row").toBe(audit);
    expect(await glBalance()).toBe(gl);
    expect(await journalCount(), "no second journal").toBe(journals);
    expect(await waiveJournalIds(posting.id)).toEqual([journalId]);
    await expectAvailableIs(free, "replay changed nothing");
  }, 90_000);
});

describe("5qqb9 round 2: waive journal and source account", () => {
  it("[5qqb9-waive-journal-not-reversible-409] reversing the waive journal through the reversal endpoint is refused 409: no reversal journal, GL 1102 and available cash unchanged (a reversal would re-open the cash the employee already holds)", async () => {
    const { batchId, net, posting } = await skippedHandover();
    const res = await waive(waiver, batchId, posting.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    reserve -= net;
    const [journalId] = await waiveJournalIds(posting.id);
    expect(journalId, "premise: waive journal exists").toBeDefined();
    const glBefore = await glBalance();
    const journals = await journalCount();

    const reversal = await probeFinance.client
      .post(`/api/accounting/journals/${journalId}/reversal`)
      .set(originHeader)
      .send({
        entryDate: daysAgo(0),
        reason: "Koreksi uji 5qqb9 M1",
        idempotencyKey: key(),
      });

    expect(reversal.status, JSON.stringify(reversal.body)).toBe(409);
    expect(await journalCount(), "no reversal journal").toBe(journals);
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    await expectAvailableIs(free, "available cash unchanged");
  }, 90_000);

  it("[5qqb9-waive-source-account-not-current-409] the handover's 1102 account is no longer the entity's petty_cash mapping account: refused 409 PAYOUT_WAIVE_NOT_ALLOWED, no flip, no journal, no audit row; with the account back the same waive works", async () => {
    const { batchId, net, posting } = await skippedHandover();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $3
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, posting.id, expenseAccountId],
        ),
      true,
    );
    let res: Awaited<ReturnType<typeof waive>>;
    const journals = await journalCount();
    const audit = await auditRowsOf(batchId);
    try {
      res = await waive(waiver, batchId, posting.id);
    } finally {
      await W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $3
              WHERE tenant_id = $1 AND id = $2`,
            [W.tenantId, posting.id, pettyGlId],
          ),
        true,
      );
    }

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code).toBe("PAYOUT_WAIVE_NOT_ALLOWED");
    expect(await kindOf(batchId), "no flip").toBe("settle_skipped");
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await auditRowsOf(batchId)).toBe(audit);

    const retry = await waive(waiver, batchId, posting.id);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    reserve -= net;
  }, 90_000);

  // 1106 (CTO decision, brief 1106 P1-1): a legacy row whose net is only in the
  // sealed total can no longer be waived (fail closed). It used to be the
  // success case "books exactly the net the reserve counts"; now the reserve
  // stays held, finance settles it outside the system.
  it("[5qqb9-waive-legacy-null-net-refused-409] a legacy settle_skipped row (settle_net_idr NULL, net only in the sealed total, pre-0392) is refused 409 PAYOUT_WAIVE_LEGACY_NET_UNKNOWN: no flip, no journal, no audit row, the reserve stays held so available cash is unchanged", async () => {
    const { batchId, net, posting } = await skippedHandover();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET settle_net_idr = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, posting.id],
        ),
      true,
    );
    await expectAvailableIs(free, "premise: legacy row counts as the same net");
    const glBefore = await glBalance();
    const journals = await journalCount();
    const audit = await auditRowsOf(batchId);

    const res = await waive(waiver, batchId, posting.id);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
      "PAYOUT_WAIVE_LEGACY_NET_UNKNOWN",
    );
    expect(await kindOf(batchId), "no flip").toBe("settle_skipped");
    expect(await waiveJournalIds(posting.id), "no waive journal").toEqual([]);
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await auditRowsOf(batchId), "no audit row").toBe(audit);
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    // The reserve is still held: `reserve` (tracked above) still includes `net`.
    expect(net, "premise: the row still reserves its net").toBeGreaterThan(0);
    await expectAvailableIs(free, "reserve still held after the refusal");
  }, 90_000);
});

describe("5qqb9 P2: refusals change nothing", () => {
  it("[5qqb9-waive-skipped-reason-422] no reason, a blank reason and a reason over 500 characters are refused 422: posting stays settle_skipped, reserve kept, no audit row", async () => {
    const { batchId, posting } = await skippedHandover();
    const audit = await auditRowsOf(batchId);

    const missing = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
    });
    const blank = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason: "   ",
    });
    const tooLong = await waive(waiver, batchId, posting.id, {
      password: PASSWORD,
      reason: "x".repeat(501),
    });

    for (const res of [missing, blank, tooLong]) {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      notRouteMissing(res);
    }
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await auditRowsOf(batchId)).toBe(audit);
    await expectAvailableIs(free, "reserve still counted");
  }, 90_000);

  it("[5qqb9-waive-skipped-not-skipped-409] a posting that is not settle_skipped (here settle_pending, set with triggers off like other payout fixtures) is refused 409: kind and journals unchanged", async () => {
    const { batchId, posting } = await skippedHandover();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET kind = 'settle_pending'
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, posting.id],
        ),
      true,
    );
    const journals = await journalCount();

    const refused = await waive(waiver, batchId, posting.id);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    notRouteMissing(refused);
    expect(await kindOf(batchId)).toBe("settle_pending");
    expect(await journalCount()).toBe(journals);
  }, 90_000);

  it("[5qqb9-waive-skipped-no-permission-403] a disburse-only approver and a payroll.view-only user are refused 403: kind and reserve unchanged", async () => {
    const { batchId, posting } = await skippedHandover();

    const asApprover = await waive(approver, batchId, posting.id);
    const asViewer = await waive(viewer, batchId, posting.id);

    expect(asApprover.status, JSON.stringify(asApprover.body)).toBe(403);
    expect(asViewer.status, JSON.stringify(asViewer.body)).toBe(403);
    expect(await kindOf(batchId)).toBe("settle_skipped");
    await expectAvailableIs(free, "reserve still counted");
  }, 90_000);

  it("[5qqb9-waive-skipped-password-stepup] without the account password, or with a wrong one, the waive is refused with a 4xx: posting stays settle_skipped, no audit row", async () => {
    const { batchId, posting } = await skippedHandover();
    const audit = await auditRowsOf(batchId);

    const noPassword = await waive(waiver, batchId, posting.id, {
      ...waiveBody(),
    });
    const wrong = await waive(waiver, batchId, posting.id, {
      password: "Wrong-password-999!",
      ...waiveBody(),
    });

    for (const res of [noPassword, wrong]) {
      expect([400, 401, 403, 422], JSON.stringify(res.body)).toContain(
        res.status,
      );
      notRouteMissing(res);
    }
    expect(await kindOf(batchId)).toBe("settle_skipped");
    expect(await auditRowsOf(batchId)).toBe(audit);
  }, 90_000);

  it("[5qqb9-waive-skipped-unknown-404] an unknown posting of a real batch, and a posting under an unknown batch id, answer 404 (stand-in for another tenant's ids); nothing changes", async () => {
    const { batchId, posting } = await skippedHandover();
    const unknown = "00000000-0000-4000-8000-000000000000";

    const noPosting = await waive(waiver, batchId, unknown);
    const noBatch = await waive(waiver, unknown, posting.id);

    expect(noPosting.status, JSON.stringify(noPosting.body)).toBe(404);
    expect(noBatch.status, JSON.stringify(noBatch.body)).toBe(404);
    // The route exists: this is a business 404, not "Route not found."
    notRouteMissing(noPosting);
    notRouteMissing(noBatch);
    expect(await kindOf(batchId)).toBe("settle_skipped");
  }, 90_000);
});

describe("5qqb9 P2 (F1): the waive is only for a cash run nothing can catch up", () => {
  const NOT_ALLOWED = "PAYOUT_WAIVE_NOT_ALLOWED";

  /** Channel of the batch, set by SQL with triggers off (the fixtures only build cash handovers). */
  const setChannel = (batchId: string, channel: string) =>
    W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches SET channel = $3
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, batchId, channel],
        ),
      true,
    );

  async function expectNotAllowed(
    batchId: string,
    postingId: string,
    why: string,
  ) {
    const audit = await auditRowsOf(batchId);
    const journals = await journalCount();

    const res = await waive(waiver, batchId, postingId);

    expect(res.status, `${why}: ${JSON.stringify(res.body)}`).toBe(409);
    expect(res.body.error?.code, why).toBe(NOT_ALLOWED);
    expect(String(res.body.error?.message ?? ""), why).not.toBe("");
    expect(await kindOf(batchId), `${why}: kind unchanged`).toBe(
      "settle_skipped",
    );
    expect(await auditRowsOf(batchId), `${why}: no audit row`).toBe(audit);
    expect(await journalCount(), `${why}: no journal`).toBe(journals);
    expect(await available(), `${why}: reserve still counted`).toBe(free);
  }

  it("[5qqb9-waive-not-cash-409] a skipped posting of a bank-channel batch is refused 409 PAYOUT_WAIVE_NOT_ALLOWED: kind, audit and reserve unchanged", async () => {
    const { batchId, posting } = await skippedHandover();
    await setChannel(batchId, "manual_bank");
    try {
      await expectNotAllowed(batchId, posting.id, "bank channel");
    } finally {
      // Back to cash: the reserve is counted for cash batches only, and later
      // scenarios track this posting as a reserve.
      await setChannel(batchId, "cash");
    }
  }, 90_000);

  it("[5qqb9-waive-locked-journal-409] a run that has its payroll.locked journal is refused 409 PAYOUT_WAIVE_NOT_ALLOWED: the resolver catches the posting up, a waive would drop a credit that must be journaled", async () => {
    const { batchId, runId, posting } = await skippedHandover();
    // A header-only journal under the locked key, placed by SQL with triggers
    // off, so the posting stays settle_skipped: this tests the guard, not the
    // resolver that would catch it up with a real journal.
    const client = await kitOwner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type, description, idempotency_key, request_fingerprint)
         SELECT tenant_id, legal_entity_id, entry_date, fiscal_period_id, 'payroll',
                'Uji jurnal kunci 5qqb9', $3, repeat('0', 64)
           FROM journal_entries
          WHERE tenant_id = $1 AND legal_entity_id = $2
          LIMIT 1`,
        [tenantId, W.entityId(), `payroll-gl:locked:${runId}`],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    expect(
      (
        await kitOwner.query(
          "SELECT 1 FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2",
          [tenantId, `payroll-gl:locked:${runId}`],
        )
      ).rowCount,
      "premise: locked journal exists",
    ).toBe(1);

    await expectNotAllowed(batchId, posting.id, "locked journal");
  }, 90_000);

  it("[5qqb9-waive-lock-queued-409] a run whose payroll.locked event is still queued (not delivered) is refused 409 PAYOUT_WAIVE_NOT_ALLOWED", async () => {
    const { batchId, runId, posting } = await skippedHandover();
    const eventRowId = randomUUID();
    await kitOwner.query(
      `INSERT INTO domain_event_outbox
         (tenant_id, id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
       VALUES ($1, $2, $3, 'payroll', $4, 9001, $5, 'cloud-sync', 'pending')`,
      [
        tenantId,
        eventRowId,
        randomUUID(),
        runId,
        JSON.stringify({
          name: "payroll.locked",
          tenantId,
          aggregateType: "payroll",
          sequence: 9001,
          payload: { payrollRunId: runId },
        }),
      ],
    );
    try {
      await expectNotAllowed(batchId, posting.id, "lock event queued");
    } finally {
      await kitOwner.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND id = $2",
        [tenantId, eventRowId],
      );
    }
  }, 90_000);

  it("[5qqb9-waive-db-not-cash-refused] a direct UPDATE flip settle_skipped -> settle_waived on a non-cash batch is refused by the guard trigger (not the kind check): the row stays settle_skipped", async () => {
    const { batchId, posting } = await skippedHandover();
    await setChannel(batchId, "manual_bank");

    const error = await dbError(
      updatePosting(posting.id, "kind = 'settle_waived'"),
    );
    await setChannel(batchId, "cash");

    expect(error, "the guard must refuse a non-cash flip").not.toBeNull();
    expect(
      error!.constraint,
      `refused by the trigger, not the kind check (${error!.message})`,
    ).not.toBe(KIND_CHECK);
    expect(await kindOf(batchId)).toBe("settle_skipped");
  }, 90_000);
});

describe("5qqb9 P2: database guard on settle_waived", () => {
  it("[5qqb9-waive-db-pure-flip-refused-for-app] a direct UPDATE that only flips kind settle_skipped -> settle_waived by legend_app is refused by the guard trigger (1089: only the trusted function flips it, with its journal); the row stays settle_skipped and the available cash is unchanged", async () => {
    const { batchId, posting } = await skippedHandover();

    const error = await dbError(
      updatePosting(posting.id, "kind = 'settle_waived'"),
    );

    expect(error, "the guard must refuse the app flip").not.toBeNull();
    expect(
      error!.constraint,
      `refused by the trigger, not the kind check (${error!.message})`,
    ).not.toBe(KIND_CHECK);
    expect(await kindOf(batchId)).toBe("settle_skipped");
    await expectAvailableIs(free, "refused flip changes nothing");
  }, 90_000);

  it("[5qqb9-waive-db-flip-with-other-change-refused] the flip together with any other column change is refused by the guard trigger (not by the kind check constraint) and the row stays settle_skipped; the pure flip afterwards is accepted", async () => {
    const { batchId, posting } = await skippedHandover();

    const withSource = await dbError(
      updatePosting(
        posting.id,
        "kind = 'settle_waived', source_gl_account_id = NULL",
      ),
    );
    const withKey = await dbError(
      updatePosting(
        posting.id,
        "kind = 'settle_waived', journal_key = journal_key || '-x'",
      ),
    );

    for (const error of [withSource, withKey]) {
      expect(error, "the guard must refuse the combined change").not.toBeNull();
      expect(
        error!.constraint,
        `refused by the trigger, not the kind check (${error!.message})`,
      ).not.toBe(KIND_CHECK);
    }
    expect(await kindOf(batchId)).toBe("settle_skipped");

    // The pure flip by the app role is refused too (1089), so the row stays.
    const pure = await dbError(
      updatePosting(posting.id, "kind = 'settle_waived'"),
    );
    expect(pure, "pure app flip must be refused").not.toBeNull();
    expect(await kindOf(batchId)).toBe("settle_skipped");
  }, 90_000);

  it("[5qqb9-waive-db-terminal] a waived row can never be flipped back (to settle_skipped, settle_pending or settle) and is never journaled", async () => {
    const { batchId, net, posting } = await skippedHandover();
    await forceWaived(posting.id);
    expect(await kindOf(batchId), "premise: waived").toBe("settle_waived");
    reserve -= net;
    free += net;
    const journals = await journalCount();

    for (const kind of ["settle_skipped", "settle_pending", "settle"]) {
      const error = await dbError(
        updatePosting(posting.id, `kind = '${kind}'`),
      );
      expect(error, `waived -> ${kind} must be refused`).not.toBeNull();
    }

    expect(await kindOf(batchId)).toBe("settle_waived");
    expect(await journalCount()).toBe(journals);
    expect(await W.journalByKey(posting.journal_key)).toBeUndefined();
    await expectAvailableIs(free, "terminal row does not reserve again");
  }, 90_000);
});
