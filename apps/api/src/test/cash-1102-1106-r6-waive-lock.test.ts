// SO 1105 (brief 1106, ronde 6), both P1 on the trusted waive function
// app.payout_waive_skipped(batch, posting, actor, session) of migration 0501.
// Written fail-first from the brief, the CTO decisions and the second-opinion
// report (HTTP + DB surface and the exported cash guards), NOT from the
// function or migration code. Model: the r1 waive file (world, helpers, how a
// hand built waive journal is posted as `SET LOCAL ROLE legend_app`).
//
// P1-1 (CTO decision 1): a posting whose settle_net_idr IS NULL (legacy, pre
// 0392: the net lives only in the sealed total that the reserve counts) can
// not be waived at all. The function and the deferred commit check refuse it
// (fail closed), whatever the journal amount (Rp1 or the exact net), the
// reserve stays held, and the endpoint answers 409
// PAYOUT_WAIVE_LEGACY_NET_UNKNOWN. A waived-without-journal replay stays 409.
//
// P1-2 (CTO decision 2): the function takes the entity advisory lock
// `acc-cashbank` (the one entityLock() takes) so it can not run between the
// GL read and the reserve read of a cash guard that holds that lock. Two real
// connections and a barrier: A holds entityLock and has read GL 1102 (the
// "supplier retry guard" read order: GL first, reserve later); B (legend_app)
// posts the exact-net journal and calls the function. B must WAIT behind A
// (pg_stat_activity wait_event_type = 'Lock'), A must still see the reserve
// (so it still refuses the payment), and after B commits GL and reserve have
// fallen together: available stays Rp0, GL never negative, no extra journal,
// a later spend (cash out / kasbon / reimbursement) is still refused.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Function arguments and the hand built journal header: as in the r1 file.
// - The exact database error of a refusal is not pinned: any error that is not
//   "function does not exist" (42883); refusal at the call or at COMMIT counts.
// - A real supplier retry cannot be driven in the payout world (the supplier
//   world is a different tenant), and the service has no pause point between
//   its GL and reserve reads. So reader A is emulated the way the SO describes
//   it: it takes the real entityLock(), reads GL 1102 (stale value), waits at
//   the barrier, then asks the real reserve reader (availableCash1102) and
//   applies the real guard (assertBankCreditCoveredBy1102 for the supplier
//   payment, assertCash1102CoversOutflow for kasbon and reimbursement). The
//   test asserts the reserve A reads AFTER the barrier still equals the GL it
//   read BEFORE it (stale GL minus reserve = 0), which is exactly what breaks
//   when B slips in without the lock. The later HTTP spends are the real ones.
// - After the race, "payment still pending / debt unchanged" is shown by the
//   guard still refusing and by the entity's journal count growing by exactly
//   the one waive journal.
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { entityLock } from "../services/accounting-bank-matching.ts";
import {
  assertBankCreditCoveredBy1102,
  assertCash1102CoversOutflow,
  availableCash1102,
} from "../services/accounting-petty-cash.service.ts";
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
const W = installPayoutWorld("1106r6waivelock");
const BASE = "/api/hris/payroll/disbursement-batches";
const ENTRIES = "/api/accounting/cash-bank/entries";
const LOANS = "/api/hris/payroll/loans";
const CLAIMS = "/api/hris/payroll/reimbursements";
const PASSWORD = "Test-password-123!";
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const NET = 100_000;
const EXTRA = 2_000_000;
const UNDEFINED_FUNCTION = "42883";
const DECIDER = randomUUID();
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];

withLimitSharedLock();

// ---- people and accounts ----------------------------------------------------

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
const employeeIds: string[] = [];
const loanIds: string[] = [];
const claimIds: string[] = [];
let categoryId: string;
type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];
let waiver: Client;
let waiverUserId: string;
let waiverSessionId: string;
let hr: Client;
let reimburser: Client;
let probeFinance: Session;
let pettyGlId: string;
let pettyBankId: string;
let expenseAccountId: string;
let salaryAccountId: string;
/** Net of the settle_skipped postings this file created and nobody waived. */
let reserve = 0;

async function enrolledActor(label: string, permissions: string[]) {
  const { client, userId } = await W.signedInClient(`Waive1106 ${label}`);
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
  probeFinance = await signedIn(app, "1106 r6 finance", [
    { role: "finance", outletId: null },
  ]);
  const hrUser = await W.signedInClient("Waive1106 HR");
  await W.grantRole(hrUser.userId, [
    "hr.employee.manage",
    "hr.employee.view",
    "hr.loan.approve",
    "payroll.view",
  ]);
  hr = hrUser.client;
  const payer = await W.signedInClient("Waive1106 reimbursement approver");
  await W.grantRole(payer.userId, ["hr.reimbursement.approve"]);
  reimburser = payer.client;
  categoryId = randomUUID();
  await kitOwner.query(
    `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
     VALUES ($1, $2, 'Kategori 1106', false, $3)`,
    [
      categoryId,
      tenantId,
      JSON.stringify([
        {
          positionId: null,
          perClaimLimitIdr: 500_000_000,
          perMonthLimitIdr: null,
        },
      ]),
    ],
  );
  pettyGlId = await accountId("1102");
  pettyBankId = await makeBankAccount(W.entityId(), pettyGlId);
  await kitOwner.query(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, '6992', 'Beban Uji 1106', 'expense', 'operating_expense')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO NOTHING`,
    [tenantId, W.entityId()],
  );
  expenseAccountId = await accountId("6992");
  const salary = await kitOwner.query<{ id: string }>(
    `SELECT a.id FROM account_mappings m
       JOIN chart_of_accounts a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
      WHERE m.tenant_id = $1 AND m.legal_entity_id = $2 AND m.role = 'salary_expense'`,
    [tenantId, W.entityId()],
  );
  expect(salary.rows, "premise: salary_expense is mapped").toHaveLength(1);
  salaryAccountId = salary.rows[0]!.id;
  await W.fundPettyCash(EXTRA);
});

afterAll(async () => {
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const ids = [...loanIds, ...claimIds];
    await client.query(
      "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE ANY (SELECT '%' || r || '%' FROM unnest($2::text[]) r)",
      [tenantId, ids],
    );
    await client.query(
      "DELETE FROM employee_loans WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, loanIds],
    );
    await client.query(
      "DELETE FROM reimbursements WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, claimIds],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, employeeIds],
    );
    await client.query(
      "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND id = $2",
      [tenantId, categoryId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

/** Drains GL 1102 (Dr 1103 / Cr 1102, seeded by SQL like W.fundPettyCash) until only the reserve is left: available Rp0. */
async function drainToReserve() {
  const amount = (await glBalance()) - reserve;
  expect(amount, "premise: GL never below the reserve").toBeGreaterThanOrEqual(
    0,
  );
  if (amount === 0) return;
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
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Kuras kas kecil uji 1106', $5, $6)
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
  expect(await available(), "premise: available is Rp0").toBe(0);
}

const cashOut = (amountIdr: number) =>
  probeFinance.client
    .post(ENTRIES)
    .set(originHeader)
    .send({
      legalEntityId: W.entityId(),
      entryDate: daysAgo(0),
      description: "Uji kas 1102 1106",
      reference: `REF-${randomBytes(3).toString("hex")}`,
      idempotencyKey: key(),
      kind: "cash_out",
      bankAccountId: pettyBankId,
      counterAccountId: expenseAccountId,
      amountIdr,
    });

/** Available cash is Rp0: spending Rp1 is refused with the 1102 code and nothing moves. */
async function expectNothingSpendable(why: string) {
  expect(await available(), `${why}: tracked available`).toBe(0);
  const gl = await glBalance();
  const journals = await journalCount();
  const res = await cashOut(1);
  const detail = JSON.stringify(res.body);
  expect([409, 422], `${why}: status ${res.status} ${detail}`).toContain(
    res.status,
  );
  expect(res.body.error?.code, `${why}: ${detail}`).toBe(REFUSAL);
  expect(await glBalance(), `${why}: refused cash out moved nothing`).toBe(gl);
  expect(await journalCount()).toBe(journals);
}

// kasbon and reimbursement, the same fixtures as the swn0m file

async function makeEmployee() {
  const id = randomUUID();
  employeeIds.push(id);
  await kitOwner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, 'Karyawan 1106', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
    [
      id,
      tenantId,
      `W6-${id.slice(0, 8).toUpperCase()}`,
      fixtureOutlet.id,
      W.entityId(),
    ],
  );
  return id;
}

async function disburseLoan(principal: number) {
  const id = randomUUID();
  loanIds.push(id);
  await kitOwner.query(
    `INSERT INTO employee_loans
       (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
        outstanding_idr, first_deduction_period, reason, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 10, $4, '2026-12-01', 'Kasbon uji 1106', 'approved', $6, now())`,
    [
      id,
      tenantId,
      await makeEmployee(),
      principal,
      Math.ceil(principal / 10),
      DECIDER,
    ],
  );
  const res = await hr
    .post(`${LOANS}/${id}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-1106-${randomUUID()}` });
  return { res, id };
}

async function payClaim(amount: number) {
  const id = randomUUID();
  claimIds.push(id);
  await kitOwner.query(
    `INSERT INTO reimbursements
       (id, tenant_id, employee_id, category_id, expense_date, amount_idr, approved_amount_idr,
        description, payout, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'Klaim uji 1106', 'cash', 'approved', $7, now())`,
    [
      id,
      tenantId,
      await makeEmployee(),
      categoryId,
      daysAgo(0),
      amount,
      DECIDER,
    ],
  );
  const res = await reimburser
    .post(`${CLAIMS}/${id}/pay`)
    .set(originHeader)
    .send({ idempotencyKey: `payout-gl-1106-${randomUUID()}` });
  return { res, id };
}

const expectGlRefusal = (
  res: { status: number; body: { error?: { code?: string } } },
  why: string,
) => {
  expect(
    [409, 422],
    `${why}: ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  expect(res.body.error?.code, `${why}: ${JSON.stringify(res.body)}`).toBe(
    REFUSAL,
  );
};

type Posting = Record<string, unknown> & {
  id: string;
  kind: string;
  journal_key: string;
};

/** Cash batch handed over while accounting is OFF: a final settle_skipped. Reserve grows by `net`. */
async function skippedHandover(net = NET) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  await W.fundPettyCash(net); // covers the approve guard
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

/** The same posting as a legacy row: settle_net_idr NULL, the net only in the sealed total (pre-0392). */
async function legacyHandover() {
  const h = await skippedHandover();
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET settle_net_idr = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, h.posting.id],
      ),
    true,
  );
  const rows = await W.postingsOf(h.batchId);
  expect(rows[0]!.settle_net_idr, "premise: legacy NULL net").toBeNull();
  expect(rows[0]!.kind, "premise: still settle_skipped").toBe("settle_skipped");
  return h;
}

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

type DbError = { code?: string; constraint?: string; message: string };

/** Opens a legend_app transaction (tenant context set). The caller commits. */
async function openAppTx(): Promise<PoolClient> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

/** A legend_app transaction with a real COMMIT; returns the first error (statement or commit). */
async function appTx(work: (client: PoolClient) => Promise<void>) {
  const client = await openAppTx();
  try {
    try {
      await work(client);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return error as DbError;
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
 * Header of the journal the real waive endpoint posts for a sibling posting
 * (a normal non-legacy one), mapped onto `target`.
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
     VALUES ($1, $2, $3, $4, $5, $6, 'Waive 1106 test', NULL, $7, $8)
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

const callWaiveFunction = (client: PoolClient, h: Handover) =>
  client.query("SELECT app.payout_waive_skipped($1, $2, $3, $4)", [
    h.batchId,
    h.posting.id,
    waiverUserId,
    waiverSessionId,
  ]);

const sourceAccountOf = (h: Handover) =>
  h.posting.source_gl_account_id as string;

const linesOf = (h: Handover, amount: number): Line[] => [
  { accountId: salaryAccountId, debit: amount, credit: 0 },
  { accountId: sourceAccountOf(h), debit: 0, credit: amount },
];

/** The refusal is a real guard, not a missing function. */
const expectGuardError = (error: DbError | null, why: string) => {
  expect(error, `${why}: must be refused`).not.toBeNull();
  expect(
    error!.code,
    `${why}: refused by a guard, not for a missing function (${error!.message})`,
  ).not.toBe(UNDEFINED_FUNCTION);
};

/** Nothing changed: still skipped, no waive journal, still Rp0 spendable. */
async function expectUntouched(h: Handover, why: string) {
  expect(await kindOf(h.batchId), `${why}: kind`).toBe("settle_skipped");
  expect(await waiveJournalIds(h.posting.id), `${why}: no journal`).toEqual([]);
  await expectNothingSpendable(why);
}

// ---- P1-1 legacy NULL net ---------------------------------------------------

describe("1106 P1-1: a legacy settle_skipped posting (NULL net) can not be waived", () => {
  it("[1106-p1-1-legacy-rp1-journal-refused] legacy posting (NULL settle_net_idr, sealed net Rp100.000, GL 1102 Rp100.000, available Rp0): as legend_app a Rp1 waive journal (Dr salary expense / Cr source 1102) plus the function, committed, is refused: kind stays settle_skipped, the journal is rolled back, available stays Rp0 and a later spend is refused", async () => {
    const h = await legacyHandover();
    const header = await realWaiveHeader(h);
    await drainToReserve();
    const glBefore = await glBalance();
    const journals = await journalCount();
    await expectNothingSpendable("premise");

    const error = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(client, entry, linesOf(h, 1), 1);
      await callWaiveFunction(client, h);
    });

    expectGuardError(error, "legacy NULL net with a Rp1 journal");
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    expect(await journalCount(), "journal rolled back").toBe(journals);
    await expectUntouched(h, "after the refused Rp1 waive");
    // a later spend of the cash the attack wanted to free is still refused
    const loan = await disburseLoan(1);
    expectGlRefusal(loan.res, "kasbon after the refused waive");
    const claim = await payClaim(1);
    expectGlRefusal(claim.res, "reimbursement after the refused waive");
  }, 180_000);

  it("[1106-p1-1-legacy-exact-net-journal-refused] legacy posting (NULL net): even a journal of the exact sealed net (Rp100.000) with the function is refused at the call or at COMMIT (fail closed): kind stays settle_skipped, no journal stays, available stays Rp0", async () => {
    const h = await legacyHandover();
    const header = await realWaiveHeader(h);
    await drainToReserve();
    const glBefore = await glBalance();
    const journals = await journalCount();

    const error = await appTx(async (client) => {
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(client, entry, linesOf(h, h.net), 1);
      await callWaiveFunction(client, h);
    });

    expectGuardError(error, "legacy NULL net with the exact net journal");
    expect(await glBalance(), "GL 1102 unchanged").toBe(glBefore);
    expect(await journalCount(), "journal rolled back").toBe(journals);
    await expectUntouched(h, "after the refused exact-net waive");
  }, 180_000);

  it("[1106-p1-1-legacy-endpoint-409-unknown-net] the waive endpoint on a legacy NULL-net row answers 409 PAYOUT_WAIVE_LEGACY_NET_UNKNOWN: no journal, no audit row, kind stays settle_skipped, the reserve stays held (available Rp0)", async () => {
    const h = await legacyHandover();
    await drainToReserve();
    const journals = await journalCount();
    const audit = await auditRowsOf(h.batchId);
    const glBefore = await glBalance();

    const res = await waive(waiver, h.batchId, h.posting.id);

    expect(res.body.error?.message, "route must exist").not.toBe(
      "Route not found.",
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
      "PAYOUT_WAIVE_LEGACY_NET_UNKNOWN",
    );
    expect(await journalCount(), "no journal posted").toBe(journals);
    expect(await auditRowsOf(h.batchId), "no audit row").toBe(audit);
    expect(await glBalance()).toBe(glBefore);
    await expectUntouched(h, "after the refused endpoint call");
    // a second call is refused the same way (nothing was half done)
    const again = await waive(waiver, h.batchId, h.posting.id);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error?.code).toBe("PAYOUT_WAIVE_LEGACY_NET_UNKNOWN");
    await expectUntouched(h, "after the second refused call");
  }, 120_000);

  it("[1106-p1-1-replay-waived-without-journal-409] a posting already settle_waived but without its waive journal (owner role, triggers off) stays refused: the endpoint answers 409 (PAYOUT_WAIVE_NOT_ALLOWED for a normal row, and for a legacy NULL-net row either that or PAYOUT_WAIVE_LEGACY_NET_UNKNOWN), never 200: no journal, no audit row", async () => {
    // Assumption: for the legacy row the brief does not say which of the two
    // 409 codes wins; both are refusals and both are accepted here.
    const cases: {
      label: string;
      make: () => Promise<Handover>;
      codes: string[];
    }[] = [
      {
        label: "normal row",
        make: skippedHandover,
        codes: ["PAYOUT_WAIVE_NOT_ALLOWED"],
      },
      {
        label: "legacy NULL-net row",
        make: legacyHandover,
        codes: ["PAYOUT_WAIVE_NOT_ALLOWED", "PAYOUT_WAIVE_LEGACY_NET_UNKNOWN"],
      },
    ];
    for (const c of cases) {
      const h = await c.make();
      await W.asTenant(
        (client) =>
          client.query(
            `UPDATE payroll_payout_gl_postings SET kind = 'settle_waived'
              WHERE tenant_id = $1 AND id = $2`,
            [W.tenantId, h.posting.id],
          ),
        true,
      );
      reserve -= h.net; // a waived row no longer reserves cash
      expect(await kindOf(h.batchId), `${c.label}: premise`).toBe(
        "settle_waived",
      );
      const journals = await journalCount();
      const audit = await auditRowsOf(h.batchId);

      const res = await waive(waiver, h.batchId, h.posting.id);

      expect(res.status, `${c.label}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(c.codes, `${c.label}: ${JSON.stringify(res.body)}`).toContain(
        res.body.error?.code,
      );
      expect(await journalCount(), `${c.label}: no journal`).toBe(journals);
      expect(await waiveJournalIds(h.posting.id)).toEqual([]);
      expect(await auditRowsOf(h.batchId), `${c.label}: no audit`).toBe(audit);
      expect(await kindOf(h.batchId)).toBe("settle_waived");
    }
  }, 180_000);
});

describe("1106b helper level: the waive journal helper fails closed on a NULL net", () => {
  it("[1106b-waive-helper-null-net-false] app.payout_waive_journal_ok on a legacy NULL-net settle_skipped posting with an exact-net waive journal answers false (and true for the same journal on a normal row, so the refusal is the NULL net)", async () => {
    const legacy = await legacyHandover();
    const normal = await skippedHandover();
    const answers: boolean[] = [];
    for (const h of [legacy, normal]) {
      const header = await realWaiveHeader(h);
      const client = await openAppTx();
      try {
        const entry = await insertEntry(client, h.posting.id, header);
        await addLines(client, entry, linesOf(h, h.net), 1);
        const { rows } = await client.query<{ ok: boolean }>(
          "SELECT app.payout_waive_journal_ok($1, $2) AS ok",
          [W.tenantId, h.posting.id],
        );
        answers.push(rows[0]!.ok);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
    expect(answers[1], "control: the normal row's exact journal is ok").toBe(
      true,
    );
    expect(answers[0], "legacy NULL net: never ok").toBe(false);
    for (const h of [legacy, normal]) {
      expect(await kindOf(h.batchId), "probe rolled back: kind").toBe(
        "settle_skipped",
      );
      expect(await waiveJournalIds(h.posting.id), "probe rolled back").toEqual(
        [],
      );
    }
  }, 180_000);
});

// ---- P1-2 entity lock -------------------------------------------------------

type Reader = "supplier" | "loan" | "reimbursement";

type Observation = {
  staleGl: number;
  reserveAfterBarrier: number;
  glAfterBarrier: number;
  refused: boolean;
};

/**
 * Connection B: legend_app posts the exact-net journal and calls the trusted
 * function, then commits. `pid` is its backend pid (probe for a lock wait);
 * `done` settles with the first error, or null.
 */
function startWaive(h: Handover, header: Header) {
  let pidResolve!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => (pidResolve = resolve));
  const done = (async (): Promise<DbError | null> => {
    let client: PoolClient | undefined;
    try {
      client = await openAppTx();
      const probe = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      pidResolve(probe.rows[0]!.pid);
      const entry = await insertEntry(client, h.posting.id, header);
      await addLines(client, entry, linesOf(h, h.net), 1);
      await callWaiveFunction(client, h);
      await client.query("COMMIT");
      return null;
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      return error as DbError;
    } finally {
      pidResolve(-1);
      client?.release();
    }
  })();
  return { pid, done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until backend `pid` waits on a lock, or `isDone()`; bounded, never a fixed sleep. */
async function waitsOnLockOrDone(pid: number, isDone: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (isDone()) return { blocked: false, finished: true };
    const { rows } = await kitOwner.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      "SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    // 1106b: the wait is on the advisory (entity) lock, not on a row lock.
    if (
      rows[0]?.wait_event_type === "Lock" &&
      rows[0]?.wait_event === "advisory"
    )
      return { blocked: true, finished: false };
    await sleep(25);
  }
  return { blocked: false, finished: false };
}

/**
 * The SO 1105 P1-2 interleaving. A (the balance reader) holds the entity lock
 * and reads GL; B (the waive) starts; A reads the reserve and applies the real
 * guard; then A commits and B may finish.
 */
async function raceWaiveAgainstReader(
  h: Handover,
  header: Header,
  reader: Reader,
) {
  const tid = tenantIdSchema.parse(W.tenantId);
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => (releaseA = resolve));
  let aReady!: () => void;
  const ready = new Promise<void>((resolve) => (aReady = resolve));

  const a = W.inTx(async (tx): Promise<Observation> => {
    await entityLock(tx, tid, W.entityId());
    const read = await tx.execute(sql`
      SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
        FROM journal_lines l
        JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       WHERE l.tenant_id = ${W.tenantId} AND e.legal_entity_id = ${W.entityId()}
         AND l.account_id = ${pettyGlId}`);
    const staleGl = Number(
      (read as unknown as { rows: { balance: string }[] }).rows[0]!.balance,
    );
    aReady();
    await gate;
    // The reserve read that comes AFTER the barrier, like the guard's second statement.
    const after = await availableCash1102(tx, tid, W.entityId());
    let refused = false;
    try {
      if (reader === "supplier")
        await assertBankCreditCoveredBy1102(
          tx,
          tid,
          W.entityId(),
          pettyGlId,
          h.net,
        );
      else
        await assertCash1102CoversOutflow(tx, tid, W.entityId(), h.net, true);
    } catch {
      refused = true;
    }
    return {
      staleGl,
      reserveAfterBarrier: after!.pendingCreditIdr,
      glAfterBarrier: after!.glIdr,
      refused,
    };
  });
  a.catch(() => aReady());

  let b: ReturnType<typeof startWaive> | undefined;
  let probe: { blocked: boolean; finished: boolean };
  try {
    await ready;
    b = startWaive(h, header);
    let settled = false;
    void b.done.then(() => (settled = true));
    const pid = await b.pid;
    probe = await waitsOnLockOrDone(pid, () => settled);
  } finally {
    releaseA();
  }
  const observation = await a;
  const bError = await b!.done;
  return { observation, bError, probe };
}

describe("1106 P1-2: the trusted waive function waits for the entity cash lock", () => {
  const scenarios: { id: string; reader: Reader; text: string }[] = [
    {
      id: "1106-p1-2-supplier-retry-guard-blocks-waive",
      reader: "supplier",
      text: "a supplier-retry style reader holds the entity lock after reading GL 1102 Rp100.000 (non-NULL net Rp100.000 reserved, available Rp0): the exact-net waive (journal + function, as legend_app) WAITS on a lock until the reader finishes, the reader still sees the reserve and refuses the Rp100.000 payment, after the waive commits GL and reserve fell together (available Rp0, GL never negative, exactly one extra journal) and a later cash out is refused",
    },
    {
      id: "1106-p1-2-loan-reader-blocks-waive",
      reader: "loan",
      text: "a kasbon disbursement style reader (assertCash1102CoversOutflow under the entity lock after a GL read) blocks the exact-net waive until it finishes, still refuses, and after the waive commits a real Rp1 kasbon disbursement is refused PETTY_CASH_GL_INSUFFICIENT (stays approved, no event, no journal)",
    },
    {
      id: "1106-p1-2-reimbursement-reader-blocks-waive",
      reader: "reimbursement",
      text: "a cash reimbursement style reader blocks the exact-net waive until it finishes, still refuses, and after the waive commits a real Rp1 cash reimbursement payment is refused PETTY_CASH_GL_INSUFFICIENT (stays approved, no event, no journal)",
    },
  ];

  for (const s of scenarios) {
    it(`[${s.id}] ${s.text}`, async () => {
      const h = await skippedHandover();
      const header = await realWaiveHeader(h);
      await drainToReserve();
      const glBefore = await glBalance();
      const journals = await journalCount();
      await expectNothingSpendable("premise");

      const { observation, bError, probe } = await raceWaiveAgainstReader(
        h,
        header,
        s.reader,
      );

      expect(
        probe.finished,
        "B must not finish while A holds the entity lock (it waits for it)",
      ).toBe(false);
      expect(
        probe.blocked,
        "B must wait on the advisory lock (pg_stat_activity wait_event_type = Lock, wait_event = advisory)",
      ).toBe(true);
      expect(
        observation.staleGl - observation.reserveAfterBarrier,
        "stale GL read before the barrier minus the reserve read after it: still Rp0 available",
      ).toBe(0);
      expect(observation.glAfterBarrier, "GL did not move under A").toBe(
        observation.staleGl,
      );
      expect(
        observation.refused,
        "the reader still refuses the Rp100.000 payment",
      ).toBe(true);

      // B resumes after A released the lock: the right journal is accepted.
      expect(bError?.message, "B commits once A is done").toBe(undefined);
      reserve -= h.net;
      expect(await kindOf(h.batchId)).toBe("settle_waived");
      expect(await glBalance(), "GL 1102 down by the net").toBe(
        glBefore - h.net,
      );
      expect(await glBalance(), "GL never negative").toBeGreaterThanOrEqual(0);
      expect(await available(), "available stays Rp0").toBe(0);
      expect(await waiveJournalIds(h.posting.id)).toHaveLength(1);
      expect(await journalCount(), "only the waive journal was added").toBe(
        journals + 1,
      );

      if (s.reader === "loan") {
        const loan = await disburseLoan(1);
        expectGlRefusal(loan.res, "kasbon after the waive");
        const row = await kitOwner.query<{
          status: string;
          disbursed_at: string | null;
        }>(
          "SELECT status, disbursed_at FROM employee_loans WHERE tenant_id = $1 AND id = $2",
          [tenantId, loan.id],
        );
        expect(row.rows[0]).toEqual({ status: "approved", disbursed_at: null });
      } else if (s.reader === "reimbursement") {
        const claim = await payClaim(1);
        expectGlRefusal(claim.res, "reimbursement after the waive");
        const row = await kitOwner.query<{
          status: string;
          paid_at: string | null;
        }>(
          "SELECT status, paid_at FROM reimbursements WHERE tenant_id = $1 AND id = $2",
          [tenantId, claim.id],
        );
        expect(row.rows[0]).toEqual({ status: "approved", paid_at: null });
      }
      expect(await journalCount(), "refused spends added no journal").toBe(
        journals + 1,
      );
      await expectNothingSpendable("after the race");
    }, 180_000);
  }
});
