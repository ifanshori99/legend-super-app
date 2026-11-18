// Shared world of the 1118 tests (kasbon whose receivable account is the
// petty cash account). Not a test file. One payout world (own legal entity,
// standard chart, mappings), an HR user who disburses kasbon over HTTP, a
// finance user for the mapping endpoint, and helpers that read GL 1102 and
// probe the REAL cash guard (a kasbon above the available cash is refused 422
// PETTY_CASH_GL_INSUFFICIENT). Written from the brief and the public surface
// (HTTP routes, the exported GL consumer), not from the service code.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { employeeLoanDisbursed } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../../app.ts";
import { db } from "../../db/index.ts";
import { withTenant } from "../../db/tenant.ts";
import type { HttpError } from "../../lib/http-error.ts";
import { deliverPayrollGlEvent } from "../../services/payroll-gl-consumer.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../../services/payroll-payout.service.ts";
import { originHeader } from "../helpers.ts";
import { withLimitSharedLock } from "./cash-limit-lock.ts";
import {
  closeKit,
  owner,
  signedIn,
  tenantId,
  type Session,
} from "./cash-bank-world.ts";
import {
  APP,
  CASHIER,
  REQ,
  actorOf,
  cash,
  installPayoutWorld,
} from "../payroll-payout-fixtures.ts";

export const LOANS = "/api/hris/payroll/loans";
export const GL_REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";

export type Res = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: unknown };
};

export function installLoanCashWorld(label: string) {
  const app = createApp();
  const W = installPayoutWorld(label);
  const decider = randomUUID();
  const outlet = cafeLegendPlatformFixtures.outlets[0];
  let finance: Session;
  let hr: Session;
  let approver: Session;
  let categoryId: string;
  let pettyGlId: string;
  const employeeIds: string[] = [];
  const loanIds: string[] = [];
  const claimIds: string[] = [];
  /** Kasbon paid here (HTTP 200) and their principal. */
  const principals = new Map<string, number>();
  /** Kasbon whose event is delivered but whose journal does not credit 1102: still reserved. */
  const stuck = new Set<string>();
  /** Net of the cash batches approved here and not handed over. */
  let committed = 0;

  withLimitSharedLock();

  const accountId = async (code: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3",
        [tenantId, W.entityId(), code],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error("Requires the disposable test database");
    finance = await signedIn(app, `${label} finance`, [
      { role: "finance", outletId: null },
    ]);
    pettyGlId = await accountId("1102");
    const hrUser = await W.signedInClient(`${label} HR`);
    await W.grantRole(hrUser.userId, [
      "hr.employee.manage",
      "hr.employee.view",
      "hr.loan.approve",
      "payroll.view",
    ]);
    hr = hrUser;
    const approverUser = await W.signedInClient(`${label} reimbursement`);
    await W.grantRole(approverUser.userId, ["hr.reimbursement.approve"]);
    approver = approverUser;
    categoryId = randomUUID();
    await owner.query(
      `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
       VALUES ($1, $2, 'Kategori 1118', false, $3)`,
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
    // The standard chart maps employee_receivable to 1204 (premise of every test).
    await setReceivable("1204");
  });

  afterAll(async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE ANY (SELECT '%' || r || '%' FROM unnest($2::text[]) r)",
        [tenantId, [...loanIds, ...claimIds]],
      );
      await client.query(
        "DELETE FROM reimbursements WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, claimIds],
      );
      await client.query(
        "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND id = $2",
        [tenantId, categoryId],
      );
      await client.query(
        "DELETE FROM employee_loans WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, loanIds],
      );
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, employeeIds],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    await closeKit();
  });

  // ---- GL and the cash guard ----------------------------------------------------

  async function glBalance(): Promise<number> {
    const { rows } = await owner.query<{ balance: string }>(
      `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
         FROM journal_lines l
         JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
        WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
      [tenantId, W.entityId(), pettyGlId],
    );
    return Number(rows[0]!.balance);
  }

  async function journalCount(): Promise<number> {
    const { rows } = await owner.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, W.entityId()],
    );
    return Number(rows[0]!.n);
  }

  /** Principal of paid kasbon whose outbox event is not delivered yet, plus the stuck ones. */
  async function reservedByLoans(): Promise<number> {
    const ids = [...principals.keys()];
    if (ids.length === 0) return 0;
    const { rows } = await owner.query<{ id: string; delivered: boolean }>(
      `SELECT r AS id,
              EXISTS (SELECT 1 FROM domain_event_outbox
                       WHERE tenant_id = $1 AND status = 'delivered'
                         AND event->>'name' IN ('employee_loan.disbursed', 'reimbursement.paid')
                         AND event::text LIKE '%' || r || '%') AS delivered
         FROM unnest($2::text[]) r`,
      [tenantId, ids],
    );
    return rows.reduce(
      (sum, row) =>
        !row.delivered || stuck.has(row.id)
          ? sum + principals.get(row.id)!
          : sum,
      0,
    );
  }

  /** Modelled available cash, used for hygiene only; the assertions use the real guard. */
  const available = async () =>
    (await glBalance()) - committed - (await reservedByLoans());

  async function tryApprove(net: number): Promise<HttpError | null> {
    const slips = [cash(CASHIER, net)];
    const runId = await W.seedRun(slips);
    const batchId = await W.createBatch(runId, "cash");
    await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
    const hash = (await W.batchById(batchId)).content_hash as string;
    const failure = await W.httpFailure(
      W.inTx((tx) =>
        approveDisbursementBatch(tx, actorOf(APP), batchId, {
          contentHash: hash,
          sourceBankAccountId: null,
        } as never),
      ),
    );
    if (failure === null) committed += net;
    return failure;
  }

  /** Approves one batch for all the available cash: the modelled baseline is 0. */
  async function drain() {
    const avail = await available();
    expect(avail, "no negative cash between tests").toBeGreaterThanOrEqual(0);
    if (avail > 0)
      expect(await tryApprove(avail), "premise: no hidden reserve").toBeNull();
    expect(await available()).toBe(0);
  }

  async function restoreBaseline() {
    const gap = -(await available());
    if (gap > 0) await W.fundPettyCash(gap);
  }

  /** The real guard says "nothing is available": a batch of Rp1 is refused (409/422). */
  async function expectNoCashAvailable() {
    const failure = await tryApprove(1);
    expect(
      failure,
      "a cash batch of Rp1 must be refused: no cash is available",
    ).not.toBeNull();
    expect([409, 422]).toContain(failure!.status);
  }

  // ---- employees, kasbon -----------------------------------------------------------

  async function makeEmployee() {
    const id = randomUUID();
    employeeIds.push(id);
    await owner.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan 1118', $4, $5, 'pkwtt', '2025-03-01', 'active')`,
      [
        id,
        tenantId,
        `K1-${id.slice(0, 8).toUpperCase()}`,
        outlet.id,
        W.entityId(),
      ],
    );
    return id;
  }

  async function seedLoan(principal: number) {
    const id = randomUUID();
    loanIds.push(id);
    await owner.query(
      `INSERT INTO employee_loans
         (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
          outstanding_idr, first_deduction_period, reason, status, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, 10, $4, '2026-12-01', 'Kasbon uji 1118', 'approved', $6, now())`,
      [
        id,
        tenantId,
        await makeEmployee(),
        principal,
        Math.ceil(principal / 10),
        decider,
      ],
    );
    return id;
  }

  async function disburse(loanId: string, principal: number): Promise<Res> {
    const res = await hr.client
      .post(`${LOANS}/${loanId}/disburse`)
      .set(originHeader)
      .send({ idempotencyKey: `payout-gl-1118-${randomUUID()}` });
    if (res.status === 200) principals.set(loanId, principal);
    return res;
  }

  async function loanState(loanId: string) {
    const row = (
      await owner.query<{ status: string; disbursed_at: string | null }>(
        "SELECT status, disbursed_at FROM employee_loans WHERE tenant_id = $1 AND id = $2",
        [tenantId, loanId],
      )
    ).rows[0]!;
    const events = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'employee_loan.disbursed'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, loanId],
    );
    return {
      status: row.status,
      disbursed: row.disbursed_at !== null,
      events: Number(events.rows[0]!.n),
    };
  }

  async function loanEvent(loanId: string) {
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'employee_loan.disbursed'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, loanId],
    );
    expect(rows, "exactly one employee_loan.disbursed event").toHaveLength(1);
    return employeeLoanDisbursed.envelopeSchema.parse(rows[0]!.event);
  }

  async function eventStatus(loanId: string): Promise<string> {
    const { rows } = await owner.query<{ status: string }>(
      `SELECT status FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'employee_loan.disbursed'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, loanId],
    );
    return rows[0]!.status;
  }

  async function markDelivered(loanId: string) {
    await owner.query(
      `UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now()
        WHERE tenant_id = $1
          AND event->>'name' IN ('employee_loan.disbursed', 'reimbursement.paid')
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, loanId],
    );
  }

  /** Runs the real GL consumer; a refusal may be a thrown error or a non-posted result. */
  async function deliver(
    event: Awaited<ReturnType<typeof loanEvent>>,
  ): Promise<{ status?: string; error?: unknown }> {
    try {
      const result = await withTenant(db, W.scope(), (tx) =>
        deliverPayrollGlEvent(W.scope(), event, tx, new Date()),
      );
      return { status: result.status };
    } catch (error) {
      return { error };
    }
  }

  /**
   * A delivery counts as refused when it threw, or answered with a status that
   * is not one the outbox treats as done (posted / ignored / skipped).
   */
  function expectRefused(outcome: { status?: string; error?: unknown }) {
    if (outcome.error !== undefined) return;
    expect(
      ["posted", "ignored", "skipped"],
      `the consumer must refuse to post, it answered ${outcome.status}`,
    ).not.toContain(outcome.status);
  }

  // ---- mappings -----------------------------------------------------------------

  /** Maps employee_receivable straight in the database (simulates old data). */
  async function setReceivable(code: string) {
    const id = await accountId(code);
    const upd = await owner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'employee_receivable'`,
      [tenantId, W.entityId(), id],
    );
    if (upd.rowCount === 0)
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, 'employee_receivable', $3)`,
        [tenantId, W.entityId(), id],
      );
  }

  /** Maps employee_receivable to whatever account a cash role uses. */
  async function setReceivableToRoleAccount(role: string) {
    const { rows } = await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [tenantId, W.entityId(), role],
    );
    expect(rows, `premise: role ${role} is mapped`).toHaveLength(1);
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'employee_receivable'`,
      [tenantId, W.entityId(), rows[0]!.account_id],
    );
  }

  const mappingsUrl = () =>
    `/api/accounting/legal-entities/${W.entityId()}/account-mappings`;

  async function listMappings(): Promise<
    { role: string; accountId: string }[]
  > {
    const res = await finance.client.get(mappingsUrl());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as { role: string; accountId: string }[];
  }

  async function putMappings(
    mappings: { role: string; accountId: string }[],
  ): Promise<Res> {
    return finance.client
      .put(mappingsUrl())
      .set(originHeader)
      .send({
        mappings: mappings.map(({ role, accountId }) => ({ role, accountId })),
      });
  }

  // ---- journals -------------------------------------------------------------------

  /** Inserts a balanced journal (setup only: bypasses the poster on purpose). */
  async function insertJournal(input: {
    key: string;
    sourceId: string | null;
    debitAccountId: string;
    creditAccountId: string;
    amount: number;
    snapshot?: Record<string, string> | null;
  }) {
    const date = new Date(Date.now() + 7 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const period = (
        await client.query<{ id: string }>(
          "SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
          [tenantId, W.entityId(), date.slice(0, 7)],
        )
      ).rows[0]!.id;
      const entry = (
        await client.query<{ id: string }>(
          `INSERT INTO journal_entries
             (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
              source_id, description, idempotency_key, request_fingerprint,
              posting_account_snapshot)
           VALUES ($1, $2, $3, $4, 'payroll', $5, 'Kas tunai (uji 1118)', $6, $7, $8)
           RETURNING id`,
          [
            tenantId,
            W.entityId(),
            date,
            period,
            input.sourceId,
            input.key,
            randomBytes(32).toString("hex"),
            input.snapshot ? JSON.stringify(input.snapshot) : null,
          ],
        )
      ).rows[0]!.id;
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
        [
          tenantId,
          entry,
          input.debitAccountId,
          input.creditAccountId,
          input.amount,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  type JournalOptions = {
    /** `posting_account_snapshot` of the entry (role -> account id); none by default. */
    snapshot?: Record<string, string> | null;
    /** Account the journal credits; 1102 (the current petty cash account) by default. */
    creditAccountId?: string;
  };

  /**
   * A journal of the kasbon under the consumer's key. `netCredit` 0 makes
   * Dr 1102 / Cr 1102 (what a shared mapping produced before the fix);
   * `netCredit` > 0 makes Dr 1204 / Cr <creditAccountId or 1102> of that amount.
   */
  async function seedLoanJournal(
    loanId: string,
    amount: number,
    netCredit = 0,
    options: JournalOptions = {},
  ) {
    const credit = options.creditAccountId ?? pettyGlId;
    await insertJournal({
      key: `payroll-gl:loan:${loanId}`,
      sourceId: loanId,
      debitAccountId: netCredit > 0 ? await accountId("1204") : credit,
      creditAccountId: credit,
      amount,
      snapshot: options.snapshot,
    });
  }

  /** Same for a cash reimbursement (key payroll-gl:reimbursement:<id>, real debit 6110). */
  async function seedReimbursementJournal(
    claimId: string,
    amount: number,
    netCredit = 0,
    options: JournalOptions = {},
  ) {
    const credit = options.creditAccountId ?? pettyGlId;
    await insertJournal({
      key: `payroll-gl:reimbursement:${claimId}`,
      sourceId: claimId,
      debitAccountId: netCredit > 0 ? await accountId("6110") : credit,
      creditAccountId: credit,
      amount,
      snapshot: options.snapshot,
    });
  }

  // ---- cash reimbursements ----------------------------------------------------------

  /** An approved cash reimbursement claim waiting to be paid. */
  async function seedClaim(amount: number) {
    const id = randomUUID();
    claimIds.push(id);
    const today = new Date(Date.now() + 7 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    await owner.query(
      `INSERT INTO reimbursements
         (id, tenant_id, employee_id, category_id, expense_date, amount_idr, approved_amount_idr,
          description, payout, status, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 'Klaim uji 1118', 'cash', 'approved', $7, now())`,
      [id, tenantId, await makeEmployee(), categoryId, today, amount, decider],
    );
    return id;
  }

  /** Pays the claim over HTTP; a 200 is modelled as a reserve until its event is delivered. */
  async function payClaim(claimId: string, amount: number): Promise<Res> {
    const res = await approver.client
      .post(`/api/hris/payroll/reimbursements/${claimId}/pay`)
      .set(originHeader)
      .send({ idempotencyKey: `payout-gl-1118-${randomUUID()}` });
    if (res.status === 200) principals.set(claimId, amount);
    return res;
  }

  async function claimEvents(claimId: string) {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'reimbursement.paid'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, claimId],
    );
    return Number(rows[0]!.n);
  }

  /**
   * Drops the pending outbox event of a kasbon or claim paid by a test (and
   * its modelled reserve), so a later test starts without that reserve.
   * Setup hygiene only.
   */
  async function forget(id: string) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'",
        [tenantId, id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    principals.delete(id);
    stuck.delete(id);
  }

  // ---- extra accounts (petty cash remaps) -------------------------------------------

  /** The account currently mapped to a role of the entity. */
  async function mappedAccountId(role: string) {
    const { rows } = await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3",
      [tenantId, W.entityId(), role],
    );
    expect(rows, `premise: role ${role} is mapped`).toHaveLength(1);
    return rows[0]!.account_id;
  }

  /** A new postable asset account (cash group) with a code the standard chart does not use. */
  async function createCashAccount(code: string) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, 'Kas pindahan uji 1118', 'asset', 'cash_and_equivalents')
       ON CONFLICT (tenant_id, legal_entity_id, code) DO UPDATE SET name = excluded.name
       RETURNING id`,
      [tenantId, W.entityId(), code],
    );
    return rows[0]!.id;
  }

  /** Puts cash on any account (Dr account / Cr opening balance equity). */
  async function fundAccount(targetAccountId: string, amount: number) {
    await insertJournal({
      key: `payout-fund-1118-${randomUUID()}`,
      sourceId: null,
      debitAccountId: targetAccountId,
      creditAccountId: await mappedAccountId("opening_balance_equity"),
      amount,
    });
  }

  /** Remaps petty_cash straight in the database (simulates an owner remap). */
  async function setPettyCashAccount(targetAccountId: string) {
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'`,
      [tenantId, W.entityId(), targetAccountId],
    );
  }

  return {
    W,
    accountId,
    glBalance,
    journalCount,
    available,
    drain,
    restoreBaseline,
    tryApprove,
    expectNoCashAvailable,
    seedLoan,
    disburse,
    loanState,
    loanEvent,
    eventStatus,
    markDelivered,
    deliver,
    expectRefused,
    setReceivable,
    setReceivableToRoleAccount,
    listMappings,
    putMappings,
    seedLoanJournal,
    seedReimbursementJournal,
    seedClaim,
    payClaim,
    claimEvents,
    forget,
    mappedAccountId,
    createCashAccount,
    fundAccount,
    setPettyCashAccount,
    markStuck: (loanId: string) => stuck.add(loanId),
    clearStuck: (loanId: string) => stuck.delete(loanId),
  };
}

/** The 422 of the cash guard. */
export function expectGlRefusal(res: Res) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(422);
  expect(res.body.error?.code, detail).toBe(GL_REFUSAL);
}
