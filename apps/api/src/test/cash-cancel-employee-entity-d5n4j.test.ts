// legend-d5n4j: (1) cancel an approved-but-not-paid cash kasbon / cash
// reimbursement with a mandatory reason, (2) set an employee's legal entity once
// so a stuck cash item passes the cv00j gate. Written fail-first from the brief
// (scratchpad brief-d5n4j.md), the founder rule "nobody is paid twice, no
// journal for money that never moved", the shared validators and the public HTTP
// surface, NOT from the implementation.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Cancel reason is read from the audit row: the whole stored audit row
//   (to_jsonb of audit_logs) must contain the reason text and the id of the
//   person who cancelled; its exact JSON shape is not pinned. The audit row of a
//   kasbon cancel is found by `event.objectId = <loan id>`; the claim one has the
//   action `payroll.reimbursement.cancelled` (brief).
// - A missing / blank / too long reason on an approved item is HTTP 422 (the code
//   PAYROLL_CANCEL_REASON_REQUIRED only when the reason is missing; a reason that
//   is blank or above 500 characters fails body validation, so only 422 is
//   pinned).
// - A cancelled claim reports approvedAmountIdr null and keeps the approver's
//   decidedBy (brief). A second cancel with a new key, a cancel of a paid /
//   disbursed item, of a submitted claim and of a payroll-payout approved claim
//   are all 409 PAYROLL_INVALID_TRANSITION.
// - The loser of cancel-vs-pay gets 409 (never 5xx).
// - Month cap: a cap-limited category with a default (null position) limit of
//   Rp100.000 per claim and per month; the employee has no position. The second
//   claim is a seeded `submitted` one: approving it re-checks the month and is
//   refused 422 PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED while the first is approved.
// - Money: cash is measured as GL 1102 minus the kasbon / claims paid here that
//   still have a pending outbox event. Cancelling an item never changes that, so
//   a later payment of exactly the available cash passes and one rupiah more is
//   refused PETTY_CASH_GL_INSUFFICIENT.
// - Legal entity endpoint: other-tenant entity gets the same 4xx status and error
//   code as a random unknown entity id (404 or 422, never a leak). Another
//   tenant's employee is 404. A user with only hr.employee.view gets 403.
//   The response body is `{ data: employee }` with `legalEntityId`.
// - Replay of the entity set: same key and body returns 200 with the same body
//   and writes one audit row only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { agent, originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  owner as kitOwner,
  tenantId,
} from "./helpers/cash-bank-world.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";
import { installPayoutWorld } from "./payroll-payout-fixtures.ts";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const app = createApp();
const LOANS = "/api/hris/payroll/loans";
const CLAIMS = "/api/hris/payroll/reimbursements";
const EMPLOYEES = "/api/hris/employees";
const ENTITY_MISSING = "PAYROLL_CASH_ENTITY_MISSING";
const REASON_REQUIRED = "PAYROLL_CANCEL_REASON_REQUIRED";
const INVALID_TRANSITION = "PAYROLL_INVALID_TRANSITION";
const ENTITY_SET = "EMPLOYEE_LEGAL_ENTITY_ALREADY_SET";
const SET_ACTION = "hris.employee_legal_entity_set";
const REFUSAL = "PETTY_CASH_GL_INSUFFICIENT";
const DECIDER = randomUUID();
const W = installPayoutWorld("d5n4j");
const fixtureOutlet = cafeLegendPlatformFixtures.outlets[0];
const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

type Session = Awaited<ReturnType<typeof W.signedInClient>>;
type Res = {
  status: number;
  body: {
    error?: { code?: string; message?: string };
    data?: Record<string, unknown>;
  };
};

let hr: Session;
let approver: Session;
let viewer: Session;
let categoryId: string;
let tenantB: SecondTenant;
let otherEntityId: string;
let pettyGlId: string;
const employeeIds: string[] = [];
const loanIds: string[] = [];
const claimIds: string[] = [];
const categoryIds: string[] = [];
const paidAmounts = new Map<string, number>();

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  hr = await W.signedInClient("d5n4j HR");
  await W.grantRole(hr.userId, [
    "hr.employee.manage",
    "hr.employee.view",
    "hr.loan.approve",
    "payroll.view",
  ]);
  approver = await W.signedInClient("d5n4j reimbursement approver");
  await W.grantRole(approver.userId, ["hr.reimbursement.approve"]);
  viewer = await W.signedInClient("d5n4j viewer");
  await W.grantRole(viewer.userId, ["hr.employee.view"]);
  categoryId = await makeCategory(500_000_000, null);
  otherEntityId = randomUUID();
  await kitOwner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Lain d5n4j', false)",
    [otherEntityId, tenantId],
  );
  pettyGlId = (
    await kitOwner.query<{ id: string }>(
      "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
      [tenantId, W.entityId()],
    )
  ).rows[0]!.id;
  tenantB = await createSecondTenant(kitOwner, "d5n4j");
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
    await client.query("DELETE FROM employees WHERE id = ANY($1::uuid[])", [
      employeeIds,
    ]);
    await client.query(
      "DELETE FROM reimbursement_categories WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, [categoryId, ...categoryIds]],
    );
    await client.query(
      "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
      [tenantId, otherEntityId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await removeSecondTenant(kitOwner, tenantB);
  await closeKit();
});

// ---- setup helpers -------------------------------------------------------------

const uniqueKey = () => `d5n4j-${randomUUID()}`;

async function makeCategory(perClaim: number, perMonth: number | null) {
  const id = randomUUID();
  await kitOwner.query(
    `INSERT INTO reimbursement_categories (id, tenant_id, name, receipt_required, limits)
     VALUES ($1, $2, $3, false, $4)`,
    [
      id,
      tenantId,
      `Kategori d5n4j ${id.slice(0, 6)}`,
      JSON.stringify([
        {
          positionId: null,
          perClaimLimitIdr: perClaim,
          perMonthLimitIdr: perMonth,
        },
      ]),
    ],
  );
  if (id !== categoryId) categoryIds.push(id);
  return id;
}

async function makeEmployee(
  options: { entity?: string | null; userId?: string | null } = {},
) {
  const id = randomUUID();
  employeeIds.push(id);
  await kitOwner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            legal_entity_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan d5n4j', $5, $6, 'pkwtt', '2025-03-01', 'active')`,
    [
      id,
      tenantId,
      options.userId ?? null,
      `D5-${id.slice(0, 8).toUpperCase()}`,
      fixtureOutlet.id,
      options.entity === undefined ? W.entityId() : options.entity,
    ],
  );
  return id;
}

async function seedLoan(
  employeeId: string,
  principal: number,
  status: "approved" | "pending" = "approved",
) {
  const id = randomUUID();
  loanIds.push(id);
  const decided = status === "approved";
  await kitOwner.query(
    `INSERT INTO employee_loans
       (id, tenant_id, employee_id, principal_idr, installment_idr, installment_count,
        outstanding_idr, first_deduction_period, reason, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, 10, $4, '2026-12-01', 'Kasbon uji d5n4j', $6, $7,
             ${decided ? "now()" : "NULL"})`,
    [
      id,
      tenantId,
      employeeId,
      principal,
      Math.ceil(principal / 10),
      status,
      decided ? DECIDER : null,
    ],
  );
  return id;
}

async function seedClaim(
  employeeId: string,
  amount: number,
  options: {
    status?: "approved" | "submitted";
    payout?: "cash" | "payroll";
    category?: string;
  } = {},
) {
  const id = randomUUID();
  claimIds.push(id);
  const status = options.status ?? "approved";
  const approved = status === "approved";
  await kitOwner.query(
    `INSERT INTO reimbursements
       (id, tenant_id, employee_id, category_id, expense_date, amount_idr, approved_amount_idr,
        description, payout, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Klaim uji d5n4j', $8, $9, $10,
             ${approved ? "now()" : "NULL"})`,
    [
      id,
      tenantId,
      employeeId,
      options.category ?? categoryId,
      today,
      amount,
      approved ? amount : null,
      options.payout ?? "cash",
      status,
      approved ? DECIDER : null,
    ],
  );
  return id;
}

/** Puts cash into GL 1102 of the world's entity (setup only). */
const addCash = (amountIdr: number) => W.fundPettyCash(amountIdr);

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

async function journalCount(): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenantId, W.entityId()],
  );
  return Number(rows[0]!.n);
}

/** Every outbox event that mentions this id (any name). */
async function eventsMentioning(id: string): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
    [tenantId, id],
  );
  return Number(rows[0]!.n);
}

/** GL 1102 minus the kasbon / claims paid here that still hold a pending event. */
async function available(): Promise<number> {
  const ids = [...paidAmounts.keys()];
  let pending = 0;
  if (ids.length > 0) {
    const { rows } = await kitOwner.query<{ id: string }>(
      `SELECT r AS id FROM unnest($2::text[]) r
        WHERE EXISTS (SELECT 1 FROM domain_event_outbox
                       WHERE tenant_id = $1
                         AND event->>'name' IN ('employee_loan.disbursed', 'reimbursement.paid')
                         AND event::text LIKE '%' || r || '%')`,
      [tenantId, ids],
    );
    pending = rows.reduce((sum, row) => sum + paidAmounts.get(row.id)!, 0);
  }
  return (await glBalance()) - pending;
}

async function loanRow(id: string) {
  return (
    await kitOwner.query<{
      status: string;
      disbursed_at: string | null;
      decided_by: string | null;
    }>(
      "SELECT status, disbursed_at, decided_by FROM employee_loans WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!;
}

async function claimRow(id: string) {
  return (
    await kitOwner.query<{
      status: string;
      paid_at: string | null;
      decided_by: string | null;
      approved_amount_idr: string | null;
    }>(
      "SELECT status, paid_at, decided_by, approved_amount_idr::text FROM reimbursements WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    )
  ).rows[0]!;
}

/** The whole stored audit rows of an object (action + full row text). */
async function auditOf(objectId: string) {
  const { rows } = await kitOwner.query<{ action: string; text: string }>(
    `SELECT a.event->>'action' AS action, to_jsonb(a)::text AS text
       FROM audit_logs a
      WHERE a.tenant_id = $1 AND a.event->>'objectId' = $2`,
    [tenantId, objectId],
  );
  return rows;
}

// ---- HTTP helpers ----------------------------------------------------------------

const decideLoan = (
  loanId: string,
  action: "approve" | "reject" | "cancel",
  extra: Record<string, unknown> = {},
  who: Session = hr,
): Promise<Res> =>
  who.client
    .post(`${LOANS}/${loanId}/decision`)
    .set(originHeader)
    .send({ action, idempotencyKey: uniqueKey(), ...extra }) as never;

async function disburse(loanId: string, principal: number): Promise<Res> {
  const res = (await hr.client
    .post(`${LOANS}/${loanId}/disburse`)
    .set(originHeader)
    .send({ idempotencyKey: uniqueKey() })) as Res;
  if (res.status === 200) paidAmounts.set(loanId, principal);
  return res;
}

const decideClaim = (
  claimId: string,
  extra: Record<string, unknown> = {},
  who: Session = approver,
): Promise<Res> =>
  who.client
    .post(`${CLAIMS}/${claimId}/decision`)
    .set(originHeader)
    .send({
      action: "cancel",
      approvedAmountIdr: null,
      idempotencyKey: uniqueKey(),
      ...extra,
    }) as never;

async function payClaim(claimId: string, amount: number): Promise<Res> {
  const res = (await approver.client
    .post(`${CLAIMS}/${claimId}/pay`)
    .set(originHeader)
    .send({ idempotencyKey: uniqueKey() })) as Res;
  if (res.status === 200) paidAmounts.set(claimId, amount);
  return res;
}

function expectError(res: Res, status: number, code: string) {
  const detail = JSON.stringify(res.body);
  expect(res.status, detail).toBe(status);
  expect(res.body.error?.code, detail).toBe(code);
}

const REASON = "Karyawan resign sebelum kasbon dicairkan";

// ---- 1a. kasbon cancel -------------------------------------------------------------

describe("d5n4j cancel an approved cash kasbon", () => {
  it("[d5n4j-loan-cancel-ok] cancels an approved kasbon with a reason: status cancelled, reason and canceller in the audit, no event, no journal, GL 1102 untouched, then it cannot be disbursed", async () => {
    await addCash(100_000);
    const loan = await seedLoan(await makeEmployee(), 40_000);
    const journals = await journalCount();
    const gl = await glBalance();

    const res = await decideLoan(loan, "cancel", { reason: REASON });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: loan, status: "cancelled" });
    const row = await loanRow(loan);
    expect(row.status).toBe("cancelled");
    expect(row.disbursed_at).toBeNull();
    expect(row.decided_by, "the approver stays on the row").toBe(DECIDER);
    const audit = (await auditOf(loan)).filter((a) => a.text.includes(REASON));
    expect(audit, "one audit row carries the reason").toHaveLength(1);
    expect(audit[0]!.text, "the canceller is named").toContain(hr.userId);
    expect(audit[0]!.text.toLowerCase()).toContain("cancel");
    expect(await eventsMentioning(loan), "no outbox event").toBe(0);
    expect(await W.countJournals(`payroll-gl:loan:${loan}`)).toBe(0);
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance(), "1102 untouched").toBe(gl);
    expectError(await disburse(loan, 40_000), 409, INVALID_TRANSITION);
  }, 90_000);

  it("[d5n4j-loan-cancel-replay] the same idempotency key replays the stored result: same body, one audit row", async () => {
    const loan = await seedLoan(await makeEmployee(), 40_000);
    const idempotencyKey = uniqueKey();

    const first = await decideLoan(loan, "cancel", {
      reason: REASON,
      idempotencyKey,
    });
    const second = await decideLoan(loan, "cancel", {
      reason: REASON,
      idempotencyKey,
    });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toEqual(first.body);
    const audit = (await auditOf(loan)).filter((a) => a.text.includes(REASON));
    expect(audit, "no second audit row").toHaveLength(1);
  }, 90_000);

  it("[d5n4j-loan-cancel-twice] a second cancel with a new key is 409 PAYROLL_INVALID_TRANSITION and writes no second audit row", async () => {
    const loan = await seedLoan(await makeEmployee(), 40_000);
    expect((await decideLoan(loan, "cancel", { reason: REASON })).status).toBe(
      200,
    );

    const again = await decideLoan(loan, "cancel", { reason: "Alasan lain" });

    expectError(again, 409, INVALID_TRANSITION);
    const audit = (await auditOf(loan)).filter((a) =>
      a.text.includes("Alasan lain"),
    );
    expect(audit).toHaveLength(0);
  }, 90_000);

  it("[d5n4j-loan-cancel-disbursed] a disbursed kasbon cannot be cancelled: 409 PAYROLL_INVALID_TRANSITION, it stays disbursed", async () => {
    await addCash(60_000);
    const loan = await seedLoan(await makeEmployee(), 30_000);
    const paid = await disburse(loan, 30_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);

    const res = await decideLoan(loan, "cancel", { reason: REASON });

    expectError(res, 409, INVALID_TRANSITION);
    expect((await loanRow(loan)).status).toBe("disbursed");
  }, 90_000);

  it("[d5n4j-loan-cancel-reason-required] cancelling an approved kasbon without a reason is 422 PAYROLL_CANCEL_REASON_REQUIRED and changes nothing", async () => {
    const loan = await seedLoan(await makeEmployee(), 40_000);

    const res = await decideLoan(loan, "cancel");

    expectError(res, 422, REASON_REQUIRED);
    expect((await loanRow(loan)).status).toBe("approved");
    expect(await auditOf(loan)).toHaveLength(0);
  }, 90_000);

  it("[d5n4j-loan-cancel-reason-invalid] a blank or too long reason is 422 and the kasbon stays approved", async () => {
    const loan = await seedLoan(await makeEmployee(), 40_000);

    for (const reason of ["", "   ", "x".repeat(501)]) {
      const res = await decideLoan(loan, "cancel", { reason });
      expect(res.status, `reason of ${reason.length} chars`).toBe(422);
    }

    expect((await loanRow(loan)).status).toBe("approved");
    // The limit itself is allowed.
    const edge = await decideLoan(loan, "cancel", { reason: "y".repeat(500) });
    expect(edge.status, JSON.stringify(edge.body)).toBe(200);
  }, 90_000);

  it("[d5n4j-loan-cancel-pending-no-reason] a pending kasbon is still cancelled without a reason (old callers keep working)", async () => {
    const loan = await seedLoan(await makeEmployee(), 40_000, "pending");

    const res = await decideLoan(loan, "cancel");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await loanRow(loan)).status).toBe("cancelled");
  }, 90_000);

  it("[d5n4j-loan-cancel-auth] a user without hr.loan.approve gets 403, no session 401, untrusted origin 403; nothing changes", async () => {
    const loan = await seedLoan(await makeEmployee(), 40_000);
    const body = {
      action: "cancel",
      reason: REASON,
      idempotencyKey: uniqueKey(),
    };

    const noRole = await viewer.client
      .post(`${LOANS}/${loan}/decision`)
      .set(originHeader)
      .send(body);
    const anonymous = await agent(app)
      .post(`${LOANS}/${loan}/decision`)
      .set(originHeader)
      .send(body);
    const evil = await hr.client
      .post(`${LOANS}/${loan}/decision`)
      .set({ Origin: "https://evil.example.test" })
      .send(body);

    expect(noRole.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(evil.status).toBe(403);
    expect((await loanRow(loan)).status).toBe("approved");
  }, 90_000);
});

// ---- 1b. reimbursement cancel -------------------------------------------------------

describe("d5n4j cancel an approved cash reimbursement", () => {
  it("[d5n4j-reimb-cancel-ok] cancels an approved cash claim with a reason: status cancelled, approved amount null, approver kept, canceller and reason in the audit, no event, no journal", async () => {
    await addCash(100_000);
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const journals = await journalCount();
    const gl = await glBalance();

    const res = await decideClaim(claim, { reason: REASON });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: claim,
      status: "cancelled",
      approvedAmountIdr: null,
      decidedBy: DECIDER,
    });
    const row = await claimRow(claim);
    expect(row.status).toBe("cancelled");
    expect(row.paid_at).toBeNull();
    expect(row.approved_amount_idr).toBeNull();
    expect(row.decided_by).toBe(DECIDER);
    const audit = (await auditOf(claim)).filter((a) => a.text.includes(REASON));
    expect(audit, "one audit row carries the reason").toHaveLength(1);
    expect(audit[0]!.action).toBe("payroll.reimbursement.cancelled");
    expect(audit[0]!.text, "the canceller is named").toContain(approver.userId);
    expect(await eventsMentioning(claim), "no outbox event").toBe(0);
    expect(await W.countJournals(`payroll-gl:reimbursement:${claim}`)).toBe(0);
    expect(await journalCount(), "no journal").toBe(journals);
    expect(await glBalance(), "1102 untouched").toBe(gl);
    expectError(await payClaim(claim, 40_000), 409, INVALID_TRANSITION);
  }, 90_000);

  it("[d5n4j-reimb-cancel-replay] the same idempotency key replays the stored result: same body, one audit row", async () => {
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const idempotencyKey = uniqueKey();

    const first = await decideClaim(claim, { reason: REASON, idempotencyKey });
    const second = await decideClaim(claim, { reason: REASON, idempotencyKey });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toEqual(first.body);
    const audit = (await auditOf(claim)).filter((a) => a.text.includes(REASON));
    expect(audit).toHaveLength(1);
  }, 90_000);

  it("[d5n4j-reimb-cancel-twice] a second cancel with a new key is 409 PAYROLL_INVALID_TRANSITION", async () => {
    const claim = await seedClaim(await makeEmployee(), 40_000);
    expect((await decideClaim(claim, { reason: REASON })).status).toBe(200);

    expectError(
      await decideClaim(claim, { reason: "Alasan lain" }),
      409,
      INVALID_TRANSITION,
    );
  }, 90_000);

  it("[d5n4j-reimb-cancel-reason-required] cancelling without a reason is 422 PAYROLL_CANCEL_REASON_REQUIRED; a blank or too long reason is 422; the claim stays approved", async () => {
    const claim = await seedClaim(await makeEmployee(), 40_000);

    expectError(await decideClaim(claim), 422, REASON_REQUIRED);
    for (const reason of ["", "   ", "x".repeat(501)]) {
      const res = await decideClaim(claim, { reason });
      expect(res.status, `reason of ${reason.length} chars`).toBe(422);
    }

    expect((await claimRow(claim)).status).toBe("approved");
    expect(await auditOf(claim)).toHaveLength(0);
  }, 90_000);

  it("[d5n4j-reimb-cancel-payroll-payout] an approved claim that goes through payroll cannot be cancelled this way: 409 PAYROLL_INVALID_TRANSITION", async () => {
    const claim = await seedClaim(await makeEmployee(), 40_000, {
      payout: "payroll",
    });

    const res = await decideClaim(claim, { reason: REASON });

    expectError(res, 409, INVALID_TRANSITION);
    expect((await claimRow(claim)).status).toBe("approved");
  }, 90_000);

  it("[d5n4j-reimb-cancel-paid] a paid claim cannot be cancelled: 409 PAYROLL_INVALID_TRANSITION, it stays paid", async () => {
    await addCash(60_000);
    const claim = await seedClaim(await makeEmployee(), 30_000);
    const paid = await payClaim(claim, 30_000);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);

    const res = await decideClaim(claim, { reason: REASON });

    expectError(res, 409, INVALID_TRANSITION);
    expect((await claimRow(claim)).status).toBe("paid");
  }, 90_000);

  it("[d5n4j-reimb-cancel-submitted] a submitted claim is not cancelled through the decision route: 409 PAYROLL_INVALID_TRANSITION", async () => {
    const claim = await seedClaim(await makeEmployee(), 40_000, {
      status: "submitted",
    });

    const res = await decideClaim(claim, { reason: REASON });

    expectError(res, 409, INVALID_TRANSITION);
    expect((await claimRow(claim)).status).toBe("submitted");
  }, 90_000);

  it("[d5n4j-reimb-cancel-own-claim] the claimant cannot cancel their own claim: 403 PAYROLL_APPROVER_NOT_DISTINCT, still approved", async () => {
    const claim = await seedClaim(
      await makeEmployee({ userId: approver.userId }),
      40_000,
    );

    const res = await decideClaim(claim, { reason: REASON });

    expectError(res, 403, "PAYROLL_APPROVER_NOT_DISTINCT");
    expect((await claimRow(claim)).status).toBe("approved");
  }, 90_000);

  it("[d5n4j-reimb-cancel-auth] a user without hr.reimbursement.approve gets 403, no session 401, untrusted origin 403; nothing changes", async () => {
    const claim = await seedClaim(await makeEmployee(), 40_000);
    const body = {
      action: "cancel",
      approvedAmountIdr: null,
      reason: REASON,
      idempotencyKey: uniqueKey(),
    };

    const noRole = await viewer.client
      .post(`${CLAIMS}/${claim}/decision`)
      .set(originHeader)
      .send(body);
    const anonymous = await agent(app)
      .post(`${CLAIMS}/${claim}/decision`)
      .set(originHeader)
      .send(body);
    const evil = await approver.client
      .post(`${CLAIMS}/${claim}/decision`)
      .set({ Origin: "https://evil.example.test" })
      .send(body);

    expect(noRole.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(evil.status).toBe(403);
    expect((await claimRow(claim)).status).toBe("approved");
  }, 90_000);

  it("[d5n4j-reimb-cancel-frees-month-cap] a cancelled claim frees its amount in the month limit: a claim refused 422 before the cancel is approved after it", async () => {
    const category = await makeCategory(100_000, 100_000);
    const employee = await makeEmployee();
    const first = await seedClaim(employee, 60_000, { category });
    const second = await seedClaim(employee, 60_000, {
      status: "submitted",
      category,
    });
    expectError(
      await decideClaim(second, { action: "approve" }),
      422,
      "PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED",
    );

    const cancelled = await decideClaim(first, { reason: REASON });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const approved = await decideClaim(second, { action: "approve" });

    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await claimRow(second)).status).toBe("approved");
  }, 90_000);
});

// ---- 1c. money and races ---------------------------------------------------------------

describe("d5n4j cancelling moves no money and cancel vs pay has one winner", () => {
  it("[d5n4j-money-loan] a cancelled kasbon is no pending 1102 credit: after it, a kasbon for all the available cash is disbursed and one rupiah more is refused", async () => {
    await addCash(100_000);
    const avail = await available();
    const cancelled = await seedLoan(await makeEmployee(), avail);
    expect(
      (await decideLoan(cancelled, "cancel", { reason: REASON })).status,
    ).toBe(200);
    expect(await available(), "cancel changes no cash").toBe(avail);

    const exact = await seedLoan(await makeEmployee(), avail);
    const ok = await disburse(exact, avail);

    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await available()).toBe(0);
    const more = await seedLoan(await makeEmployee(), 1);
    const refused = await disburse(more, 1);
    expectError(refused, 422, REFUSAL);
    await addCash(1); // hygiene: not below zero for the next test
  }, 90_000);

  it("[d5n4j-money-reimb] a cancelled cash claim is no pending 1102 credit: after it, a claim for all the available cash is paid and one rupiah more is refused", async () => {
    await addCash(100_000);
    const avail = await available();
    const cancelled = await seedClaim(await makeEmployee(), avail);
    expect((await decideClaim(cancelled, { reason: REASON })).status).toBe(200);
    expect(await available(), "cancel changes no cash").toBe(avail);

    const exact = await seedClaim(await makeEmployee(), avail);
    const ok = await payClaim(exact, avail);

    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await available()).toBe(0);
    const more = await seedClaim(await makeEmployee(), 1);
    expectError(await payClaim(more, 1), 422, REFUSAL);
    await addCash(1);
  }, 90_000);

  it("[d5n4j-race-loan-cancel-vs-disburse] cancel and disbursement of the same kasbon at once: exactly one wins, the loser gets 409, a cancel win leaves no event and no journal, a pay win leaves one event", async () => {
    await addCash(1_000_000);
    for (let round = 0; round < 3; round++) {
      const loan = await seedLoan(await makeEmployee(), 10_000);

      const [cancel, pay] = await Promise.all([
        decideLoan(loan, "cancel", { reason: REASON }),
        disburse(loan, 10_000),
      ]);

      const detail = `round ${round}: cancel=${JSON.stringify(cancel.body)} pay=${JSON.stringify(pay.body)}`;
      const cancelWon = cancel.status === 200;
      const payWon = pay.status === 200;
      expect(Number(cancelWon) + Number(payWon), detail).toBe(1);
      const row = await loanRow(loan);
      if (cancelWon) {
        expect(pay.status, detail).toBe(409);
        expect(row.status).toBe("cancelled");
        expect(row.disbursed_at).toBeNull();
        expect(await eventsMentioning(loan), "no event").toBe(0);
        expect(await W.countJournals(`payroll-gl:loan:${loan}`)).toBe(0);
      } else {
        expect(cancel.status, detail).toBe(409);
        expect(row.status).toBe("disbursed");
        expect(await eventsMentioning(loan), "one pay event").toBe(1);
      }
    }
  }, 180_000);

  it("[d5n4j-race-reimb-cancel-vs-pay] cancel and payment of the same claim at once: exactly one wins, the loser gets 409, a cancel win leaves no event and no journal, a pay win leaves one event", async () => {
    await addCash(1_000_000);
    for (let round = 0; round < 3; round++) {
      const claim = await seedClaim(await makeEmployee(), 10_000);

      const [cancel, pay] = await Promise.all([
        decideClaim(claim, { reason: REASON }),
        payClaim(claim, 10_000),
      ]);

      const detail = `round ${round}: cancel=${JSON.stringify(cancel.body)} pay=${JSON.stringify(pay.body)}`;
      const cancelWon = cancel.status === 200;
      const payWon = pay.status === 200;
      expect(Number(cancelWon) + Number(payWon), detail).toBe(1);
      const row = await claimRow(claim);
      if (cancelWon) {
        expect(pay.status, detail).toBe(409);
        expect(row.status).toBe("cancelled");
        expect(row.paid_at).toBeNull();
        expect(await eventsMentioning(claim), "no event").toBe(0);
        expect(await W.countJournals(`payroll-gl:reimbursement:${claim}`)).toBe(
          0,
        );
      } else {
        expect(cancel.status, detail).toBe(409);
        expect(row.status).toBe("paid");
        expect(await eventsMentioning(claim), "one pay event").toBe(1);
      }
    }
  }, 180_000);
});

// ---- 2. set the employee's legal entity once ----------------------------------------------

type EntityAudit = { action: string; text: string };

const setEntity = (
  employeeId: string,
  legalEntityId: string,
  extra: Record<string, unknown> = {},
  who: Session = hr,
): Promise<Res> =>
  who.client
    .put(`${EMPLOYEES}/${employeeId}/legal-entity`)
    .set(originHeader)
    .send({ legalEntityId, idempotencyKey: uniqueKey(), ...extra }) as never;

/** Control: the endpoint exists and works, so a 404 below is a business answer. */
async function expectEndpointLive() {
  const control = await makeEmployee({ entity: null });
  const res = await setEntity(control, W.entityId());
  expect(res.status, `control call: ${JSON.stringify(res.body)}`).toBe(200);
}

async function entityOf(employeeId: string): Promise<string | null> {
  return (
    await kitOwner.query<{ legal_entity_id: string | null }>(
      "SELECT legal_entity_id FROM employees WHERE id = $1",
      [employeeId],
    )
  ).rows[0]!.legal_entity_id;
}

async function setAudits(employeeId: string): Promise<EntityAudit[]> {
  return (await auditOf(employeeId)).filter((a) => a.action === SET_ACTION);
}

describe("d5n4j set the employee's legal entity once", () => {
  it("[d5n4j-entity-set] sets the entity of an employee without one: 200 with the entity, saved, one audit row naming employee, entity and actor", async () => {
    const employee = await makeEmployee({ entity: null });

    const res = await setEntity(employee, W.entityId());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: employee,
      legalEntityId: W.entityId(),
    });
    expect(await entityOf(employee)).toBe(W.entityId());
    const audit = await setAudits(employee);
    expect(audit, "one audit row").toHaveLength(1);
    expect(audit[0]!.text).toContain(W.entityId());
    expect(audit[0]!.text, "the actor is named").toContain(hr.userId);
  }, 90_000);

  it("[d5n4j-entity-different-value] an entity already set cannot be changed: a different value is 409 EMPLOYEE_LEGAL_ENTITY_ALREADY_SET, nothing changes, no audit row", async () => {
    const employee = await makeEmployee({ entity: null });
    expect((await setEntity(employee, W.entityId())).status).toBe(200);

    const res = await setEntity(employee, otherEntityId);

    expectError(res, 409, ENTITY_SET);
    expect(await entityOf(employee)).toBe(W.entityId());
    expect(await setAudits(employee)).toHaveLength(1);
    // Also for an employee created with an entity.
    const created = await makeEmployee();
    expectError(await setEntity(created, otherEntityId), 409, ENTITY_SET);
    expect(await entityOf(created)).toBe(W.entityId());
  }, 90_000);

  it("[d5n4j-entity-same-value] setting the value that is already there is 200 and writes no audit row", async () => {
    const employee = await makeEmployee();

    const res = await setEntity(employee, W.entityId());

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      id: employee,
      legalEntityId: W.entityId(),
    });
    expect(await entityOf(employee)).toBe(W.entityId());
    expect(await setAudits(employee)).toHaveLength(0);
  }, 90_000);

  it("[d5n4j-entity-replay] the same key and body replays the stored result: 200, same body, one audit row", async () => {
    const employee = await makeEmployee({ entity: null });
    const idempotencyKey = uniqueKey();

    const first = await setEntity(employee, W.entityId(), { idempotencyKey });
    const second = await setEntity(employee, W.entityId(), { idempotencyKey });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await setAudits(employee)).toHaveLength(1);
  }, 90_000);

  it("[d5n4j-entity-other-tenant-entity] an entity of another tenant is refused like an unknown entity (no leak): nothing is set, no audit row", async () => {
    await expectEndpointLive();
    const employee = await makeEmployee({ entity: null });

    const foreign = await setEntity(employee, tenantB.legalEntityId);
    const unknown = await setEntity(employee, randomUUID());

    expect([404, 422], JSON.stringify(foreign.body)).toContain(foreign.status);
    expect(foreign.status, "same status as an unknown id").toBe(unknown.status);
    expect(foreign.body.error?.code, "same code as an unknown id").toBe(
      unknown.body.error?.code,
    );
    expect(await entityOf(employee)).toBeNull();
    expect(await setAudits(employee)).toHaveLength(0);
  }, 90_000);

  it("[d5n4j-entity-other-tenant-employee] an employee of another tenant is 404 and stays untouched", async () => {
    await expectEndpointLive();
    const foreignId = randomUUID();
    employeeIds.push(foreignId);
    await kitOwner.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, 'Karyawan tenant lain d5n4j', $4, NULL, 'pkwtt', '2025-03-01', 'active')`,
      [
        foreignId,
        tenantB.tenantId,
        `DB-${foreignId.slice(0, 8).toUpperCase()}`,
        tenantB.outletId,
      ],
    );

    const res = await setEntity(foreignId, W.entityId());

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await entityOf(foreignId)).toBeNull();
    expect(await setAudits(foreignId)).toHaveLength(0);
    expect((await setEntity(randomUUID(), W.entityId())).status).toBe(404);
  }, 90_000);

  it("[d5n4j-entity-auth] a user without hr.employee.manage gets 403, no session 401, untrusted origin 403; nothing is set", async () => {
    const employee = await makeEmployee({ entity: null });
    const body = { legalEntityId: W.entityId(), idempotencyKey: uniqueKey() };

    const noManage = await setEntity(employee, W.entityId(), {}, viewer);
    const anonymous = await agent(app)
      .put(`${EMPLOYEES}/${employee}/legal-entity`)
      .set(originHeader)
      .send(body);
    const evil = await hr.client
      .put(`${EMPLOYEES}/${employee}/legal-entity`)
      .set({ Origin: "https://evil.example.test" })
      .send(body);

    expect(noManage.status, JSON.stringify(noManage.body)).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(evil.status).toBe(403);
    expect(await entityOf(employee)).toBeNull();
    expect(await setAudits(employee)).toHaveLength(0);
  }, 90_000);

  it("[d5n4j-entity-validation] a body without a valid entity id or an idempotency key is 422 and nothing is set", async () => {
    const employee = await makeEmployee({ entity: null });

    const badId = await setEntity(employee, "not-a-uuid");
    const noKey = await hr.client
      .put(`${EMPLOYEES}/${employee}/legal-entity`)
      .set(originHeader)
      .send({ legalEntityId: W.entityId() });

    expect(badId.status).toBe(422);
    expect(noKey.status).toBe(422);
    expect(await entityOf(employee)).toBeNull();
  }, 90_000);

  it("[d5n4j-entity-unlocks-kasbon] a cash kasbon of an employee without an entity is refused 422 PAYROLL_CASH_ENTITY_MISSING, and is disbursed after HR sets the entity", async () => {
    await addCash(100_000);
    const employee = await makeEmployee({ entity: null });
    const loan = await seedLoan(employee, 30_000);
    expectError(await disburse(loan, 30_000), 422, ENTITY_MISSING);

    const set = await setEntity(employee, W.entityId());
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const res = await disburse(loan, 30_000);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await loanRow(loan)).status).toBe("disbursed");
  }, 90_000);

  it("[d5n4j-entity-unlocks-reimb] a cash claim of an employee without an entity is refused 422 PAYROLL_CASH_ENTITY_MISSING, and is paid after HR sets the entity", async () => {
    await addCash(100_000);
    const employee = await makeEmployee({ entity: null });
    const claim = await seedClaim(employee, 30_000);
    expectError(await payClaim(claim, 30_000), 422, ENTITY_MISSING);

    const set = await setEntity(employee, W.entityId());
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const res = await payClaim(claim, 30_000);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await claimRow(claim)).status).toBe("paid");
  }, 90_000);
});
