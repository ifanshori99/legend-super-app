// Petty cash fund vs general ledger 1102 (card legend-a4z2f, brief
// docs/briefs/991-akuntansi-kas-supplier.md section B). Written fail-first from
// the brief, not from the implementation.
//
// Why: payroll cash payouts, cash loans (kasbon) and cash reimbursements credit
// the petty cash GL account (1102) without touching the outlet's fund balance,
// and a parked journal leaves the GL behind. So the fund can be larger than the
// GL. Money rule: a return (cash leaving the fund back to the bank) must never
// move more than the GL can cover, and the gap must be visible to finance.
//
// Contract under test (brief section B):
// - GET /api/accounting/petty-cash/reconciliation?legalEntityId&outletId is
//   read-only and answers { data: { fundIdr, glIdr, diffIdr, parkedEntries,
//   nonPettyCredits1102 } }. GL = SUM(debit) - SUM(credit) of the petty_cash
//   role account on the entity's journals.
// - A `return` above min(fund, GL) is refused with 422 PETTY_CASH_GL_INSUFFICIENT
//   and writes nothing; the check runs inside the fund row lock (parallel
//   returns cannot overdraw the GL).
//
// Assumptions where the brief is silent (also stated in the report):
// - diffIdr = fundIdr - glIdr (fund >= GL makes it positive, as the brief says).
// - Money fields are integer rupiah; `parkedEntries` is a count (a list is also
//   accepted: its length is used); `nonPettyCredits1102` is the rupiah total of
//   credits to 1102 that did not come from a petty cash movement (a list of
//   { amountIdr } rows is also accepted: its amounts are summed).
// - Payroll, loan and reimbursement events carry no outlet, so their GL credit
//   is a legal-entity fact. Every test therefore owns a FRESH legal entity with
//   exactly one funded outlet: entity-level and outlet-level comparison then
//   agree, whichever the implementation chooses (the brief leaves it to the
//   CTO; conservative = block).
// - The refusal status is 422 (like PETTY_CASH_INSUFFICIENT); the error
//   envelope is { error: { code } }.
// - A fund-limited return (fund smaller than GL) keeps the existing code
//   PETTY_CASH_INSUFFICIENT; the tests accept either code there.
// - An outlet without a fund reads as 200 with zeros (never invented money),
//   like the funds list (PC-40).
// - Same permission as the funds read: finance reads; a user without a role is
//   403; anonymous is 401. A refused read of another scope may answer 403, 404
//   or 422, or 200 with no fund figures of that scope.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  employeeLoanDisbursed,
  payrollLocked,
  payrollPaid,
  payrollRunTotalsSchema,
  reimbursementPaid,
  type PayrollRunTotals,
} from "@starter/shared/hris/payroll";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { agent, originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  journalCount,
  key,
  makeBankAccount,
  makeOutlet,
  makeWorld,
  owner,
  short,
  signedIn,
  tenantId,
  type Session,
  type World,
} from "./helpers/cash-bank-world.ts";

const app = createApp();
// Top-ups are held for approval (202) above the TENANT cash limit (default
// Rp 5.000.000), and also when ONE creator's cash outs and top-ups of the
// calendar day, over all outlets, add up past it (anti-split, pending ones
// count). The limit is a single row for the whole test tenant that another
// file lowers for a moment, so this file holds the shared limit lock like the
// other petty cash files; and every fresh world gets its OWN finance user so
// no creator's daily total crosses the limit (`petty-purchase-policy` is the
// purchase limit and has nothing to do with it).
withLimitSharedLock();
const MOVEMENTS = "/api/accounting/petty-cash/movements";
const PETTY_ENTRIES = "/api/accounting/petty-cash/entries";
const RECONCILIATION = "/api/accounting/petty-cash/reconciliation";
const POLICY = "/api/inventory/petty-purchase-policy";
const PETTY_SOURCES = ["petty_cash_topup", "petty_cash_return"];

/** Fixed "now" for the payroll consumer; every instant below is in the past. */
const NOW = new Date("2026-11-30T03:00:00Z");
const PERIOD_START = "2026-09-26";
const PERIOD_END = "2026-10-25";
const PAY_DATE = "2026-10-27";
const LOCKED_AT = "2026-10-26T05:00:00.000Z";
const PAID_AT = "2026-11-27T05:00:00.000Z";

let finance: Session;
let scopedFinance: Session;
let nobody: Session;
let otherWorld: World;
let otherOutlet: string;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  finance = await signedIn(app, "GR finance", [
    { role: "finance", outletId: null },
  ]);
  nobody = await signedIn(app, "GR nobody", []);
  // Another legal entity of the same tenant with its own funded outlet.
  otherWorld = await makeWorld();
  otherOutlet = await makeOutlet(otherWorld.entityId);
  await setPolicy(otherOutlet);
  const scopedFx = await freshWorld();
  scopedFinance = await signedIn(app, "GR finance scoped", [
    { role: "finance", outletId: scopedFx.outletId },
  ]);
});

afterAll(async () => {
  setAuditWriter(null);
  await closeKit();
});

// ---- fixtures --------------------------------------------------------------

type Fx = {
  /** A tenant-wide finance user used only by this world (own daily total). */
  who: Session;
  entityId: string;
  outletId: string;
  bankAccountId: string;
  employeeId: string;
};

async function setPolicy(outletId: string): Promise<void> {
  const policy = await finance.client
    .put(POLICY)
    .set(originHeader)
    .send({ outletId, limitIdr: 1_000_000, idempotencyKey: key() });
  expect(policy.status, JSON.stringify(policy.body)).toBe(200);
}

function domainScope(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

/**
 * A fresh legal entity with the standard F&B chart (petty cash 1102, bank 1103,
 * employee receivable 1204, reimbursement 6110, payroll accounts, all role
 * mappings), open periods, ONE outlet and a bank account on 1103.
 */
async function freshWorld(): Promise<Fx> {
  const { rows: entity } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name, is_pkp) VALUES ($1, $2, false) RETURNING id",
    [tenantId, `Entity GR ${short()}`],
  );
  const entityId = entity[0]!.id;
  const ctx = domainScope();
  await withTenant(db, ctx, (tx) =>
    provisionStandardChart(tx, ctx, entityId, null),
  );
  const periods = new Set(["2026-09", "2026-10", "2026-11", "2026-12"]);
  const now = new Date();
  for (const shift of [-2, -1, 0, 1]) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
    );
    periods.add(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  for (const period of periods)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entityId, period],
    );
  const outletId = await makeOutlet(entityId);
  await setPolicy(outletId);
  const { rows: bankGl } = await owner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1103'",
    [tenantId, entityId],
  );
  const bankAccountId = await makeBankAccount(entityId, bankGl[0]!.id);
  const employeeId = randomUUID();
  await owner.query(
    `INSERT INTO employees (id, tenant_id, legal_entity_id, employee_no, full_name, home_outlet_id, employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan GR', $5, 'pkwt', '2026-01-01', 'active')`,
    [employeeId, tenantId, entityId, `E-${short().toUpperCase()}`, outletId],
  );
  const who = await signedIn(app, `GR finance ${short()}`, [
    { role: "finance", outletId: null },
  ]);
  return { who, entityId, outletId, bankAccountId, employeeId };
}

// ---- HTTP helpers ----------------------------------------------------------

const movementBody = (
  fx: Fx,
  kind: "topup" | "return",
  amountIdr: number,
  extra: Record<string, unknown> = {},
) => ({
  kind,
  outletId: fx.outletId,
  bankAccountId: fx.bankAccountId,
  amountIdr,
  description: kind === "topup" ? "Isi kas kecil" : "Setor sisa kas kecil",
  idempotencyKey: key(),
  ...extra,
});
const move = (who: Session, body: Record<string, unknown>) =>
  who.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send(body as object);
const topup = async (fx: Fx, amountIdr: number): Promise<string> => {
  const res = await move(fx.who, movementBody(fx, "topup", amountIdr));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
};
const giveBack = (fx: Fx, amountIdr: number) =>
  move(fx.who, movementBody(fx, "return", amountIdr));
const retryPost = (entryId: string) =>
  finance.client
    .post(`${PETTY_ENTRIES}/${entryId}/post`)
    .set(originHeader)
    .send({});
const reconcile = (
  who: Session,
  query: { legalEntityId: string; outletId?: string },
) => who.client.get(RECONCILIATION).set(originHeader).query(query);
const reconcileOf = (who: Session, fx: Fx) =>
  reconcile(who, { legalEntityId: fx.entityId, outletId: fx.outletId });

type Report = {
  fundIdr: number;
  glIdr: number;
  diffIdr: number;
  parkedEntries: unknown;
  nonPettyCredits1102: unknown;
};
async function report(fx: Fx): Promise<Report> {
  const res = await reconcileOf(finance, fx);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Report;
}
const parkedCount = (value: unknown): number =>
  Array.isArray(value) ? value.length : Number(value);
const creditTotal = (value: unknown): number =>
  Array.isArray(value)
    ? value.reduce(
        (sum: number, row: { amountIdr: number }) => sum + row.amountIdr,
        0,
      )
    : Number(value);

// ---- reads (migration owner) -----------------------------------------------

async function fundBalance(outletId: string): Promise<number | null> {
  const { rows } = await owner.query<{ balance: string }>(
    "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return rows[0] ? Number(rows[0].balance) : null;
}
async function entryCount(outletId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return Number(rows[0]!.n);
}
/** Independent GL oracle: net debit of the entity's petty_cash role account. */
async function glOracle(entityId: string): Promise<number> {
  const { rows } = await owner.query<{ gl: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS gl
       FROM journal_lines l
       JOIN account_mappings m
         ON m.tenant_id = l.tenant_id AND m.account_id = l.account_id AND m.role = 'petty_cash'
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND m.legal_entity_id = $2`,
    [tenantId, entityId],
  );
  return Number(rows[0]!.gl);
}

// ---- payroll-side cash credits to 1102 (no fund movement) -------------------

function envelope(
  name: string,
  aggregateType: string,
  aggregateId: string,
  occurredAt: string,
  payloadSchemaRef: string,
  payload: unknown,
) {
  return {
    id: createUlid(),
    tenantId,
    outletId: null,
    name,
    version: 1,
    aggregateType,
    aggregateId,
    sequence: 1,
    occurredAt,
    actor: { type: "user" as const, id: randomUUID() },
    deviceId: null,
    idempotencyKey: `${name}-${aggregateId}-${randomUUID()}`,
    payloadSchemaRef,
    payload,
  };
}

type AnyEvent = Parameters<typeof deliverPayrollGlEvent>[1];
async function deliver(event: unknown): Promise<void> {
  const ctx = domainScope();
  const result = await withTenant(db, ctx, (tx) =>
    deliverPayrollGlEvent(ctx, event as AnyEvent, tx, NOW),
  );
  expect(result.status).toBe("posted");
}

/** Run totals of a payroll run; 450.000 of the net is paid in cash. */
const PAYROLL_CASH = 450_000;
function payrollTotals(cashIdr = PAYROLL_CASH): PayrollRunTotals {
  const gross = 10_000_000;
  const deductions = 300_000 + 250_000;
  const net = gross - deductions;
  return payrollRunTotalsSchema.parse({
    employeeCount: 1,
    grossIdr: gross,
    deductionsIdr: deductions,
    netIdr: net,
    bpjsEmployeeIdr: 300_000,
    bpjsCompanyIdr: 400_000,
    pph21Idr: 250_000,
    pph21WithheldIdr: 250_000,
    pph21EmployerBorneIdr: 0,
    pph21RefundIdr: 0,
    pph21EmployerRefundIdr: 0,
    pph21EmployerAllowanceRefundIdr: 0,
    loanRepaymentIdr: 0,
    pph21ReceivableIdr: 0,
    pph21ReceivableCollectedIdr: 0,
    otherDeductionsIdr: 0,
    customDeductionsIdr: 0,
    serviceChargeIdr: 0,
    reimbursementIdr: 0,
    bankTransferIdr: net - cashIdr,
    cashIdr,
  });
}

async function payrollCashPaid(
  fx: Fx,
  cashIdr = PAYROLL_CASH,
): Promise<number> {
  const runId = randomUUID();
  const totals = payrollTotals(cashIdr);
  const runRef = {
    payrollRunId: runId,
    legalEntityId: fx.entityId,
    runType: "regular",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    payDate: PAY_DATE,
  };
  await deliver(
    payrollLocked.envelopeSchema.parse(
      envelope(
        "payroll.locked",
        "payroll",
        runId,
        LOCKED_AT,
        "payroll.locked.v1",
        { ...runRef, totals, lockedBy: randomUUID(), lockedAt: LOCKED_AT },
      ),
    ),
  );
  await deliver(
    payrollPaid.envelopeSchema.parse(
      envelope("payroll.paid", "payroll", runId, PAID_AT, "payroll.paid.v1", {
        ...runRef,
        netIdr: totals.netIdr,
        bankTransferIdr: totals.bankTransferIdr,
        cashIdr: totals.cashIdr,
        bankTransferFileId: null,
        paidBy: randomUUID(),
        paidAt: PAID_AT,
      }),
    ),
  );
  return cashIdr;
}

async function cashLoan(fx: Fx): Promise<number> {
  const loanId = randomUUID();
  const principalIdr = 150_000;
  await deliver(
    employeeLoanDisbursed.envelopeSchema.parse(
      envelope(
        "employee_loan.disbursed",
        "employee_loan",
        loanId,
        PAID_AT,
        "employee_loan.disbursed.v1",
        {
          employeeLoanId: loanId,
          employeeId: fx.employeeId,
          legalEntityId: fx.entityId,
          principalIdr,
          disbursedVia: "cash",
          disbursedBy: randomUUID(),
          disbursedAt: PAID_AT,
        },
      ),
    ),
  );
  return principalIdr;
}

async function cashReimbursement(fx: Fx): Promise<number> {
  const id = randomUUID();
  const amountIdr = 120_000;
  await deliver(
    reimbursementPaid.envelopeSchema.parse(
      envelope(
        "reimbursement.paid",
        "reimbursement",
        id,
        PAID_AT,
        "reimbursement.paid.v1",
        {
          reimbursementId: id,
          employeeId: fx.employeeId,
          categoryId: randomUUID(),
          amountIdr,
          payout: "cash",
          payrollRunId: null,
          paidAt: PAID_AT,
        },
      ),
    ),
  );
  return amountIdr;
}

// ---- tests -----------------------------------------------------------------

describe("legend-a4z2f petty cash reconciliation report", () => {
  it("[legend-a4z2f-GR-1] a consistent outlet shows fund == GL, diff 0, nothing parked, no outside credits", async () => {
    const fx = await freshWorld();
    await topup(fx, 100_000);
    expect((await giveBack(fx, 30_000)).status).toBe(201);

    const data = await report(fx);
    expect(data).toMatchObject({ fundIdr: 70_000, glIdr: 70_000, diffIdr: 0 });
    expect(parkedCount(data.parkedEntries)).toBe(0);
    expect(creditTotal(data.nonPettyCredits1102)).toBe(0);
    // The reported GL is the real ledger, not a copy of the fund.
    expect(await glOracle(fx.entityId)).toBe(70_000);
  });

  it("[legend-a4z2f-GR-2] an outlet without a fund reads as zeros, not an error and not invented money", async () => {
    const fx = await freshWorld();
    const data = await report(fx);
    expect(data).toMatchObject({ fundIdr: 0, glIdr: 0, diffIdr: 0 });
    expect(parkedCount(data.parkedEntries)).toBe(0);
    expect(creditTotal(data.nonPettyCredits1102)).toBe(0);
    expect(await fundBalance(fx.outletId)).toBeNull();
  });

  it.each([
    ["payroll cash payout", payrollCashPaid],
    ["cash loan (kasbon)", cashLoan],
    ["cash reimbursement", cashReimbursement],
  ] as const)(
    "[legend-a4z2f-GR-3] a %s credits 1102 without touching the fund: the gap shows as diff > 0",
    async (_label, divergence) => {
      const fx = await freshWorld();
      await topup(fx, 600_000);
      expect(await report(fx)).toMatchObject({ diffIdr: 0 });

      const credited = await divergence(fx);

      const data = await report(fx);
      expect(data.fundIdr).toBe(600_000);
      expect(data.glIdr).toBe(600_000 - credited);
      expect(data.diffIdr).toBe(credited);
      expect(data.diffIdr).toBeGreaterThan(0);
      expect(creditTotal(data.nonPettyCredits1102)).toBe(credited);
      expect(parkedCount(data.parkedEntries)).toBe(0);
      expect(await glOracle(fx.entityId)).toBe(600_000 - credited);
      // The fund itself never moved.
      expect(await fundBalance(fx.outletId)).toBe(600_000);
    },
  );

  it("[legend-a4z2f-GR-4] a parked topup (journal missing) leaves the GL behind and is counted", async () => {
    const fx = await freshWorld();
    const { rows } = await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
      [tenantId, fx.entityId],
    );
    expect(rows).toHaveLength(1);
    const pettyAccount = rows[0]!.account_id;
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
      [tenantId, fx.entityId],
    );
    let parkedId = "";
    try {
      const res = await move(fx.who, movementBody(fx, "topup", 30_000));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.journalStatus).toBe("parked");
      parkedId = res.body.data.id as string;
    } finally {
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, 'petty_cash', $3)`,
        [tenantId, fx.entityId, pettyAccount],
      );
    }

    const before = await report(fx);
    expect(before.fundIdr).toBe(30_000);
    expect(before.glIdr).toBe(0);
    expect(before.diffIdr).toBe(30_000);
    expect(parkedCount(before.parkedEntries)).toBeGreaterThanOrEqual(1);

    // Once the journal is posted the gap closes and nothing is parked.
    const retry = await retryPost(parkedId);
    expect([200, 201], JSON.stringify(retry.body)).toContain(retry.status);
    const after = await report(fx);
    expect(after).toMatchObject({
      fundIdr: 30_000,
      glIdr: 30_000,
      diffIdr: 0,
    });
    expect(parkedCount(after.parkedEntries)).toBe(0);
  });

  it("[legend-a4z2f-GR-5] reading the report writes nothing", async () => {
    const fx = await freshWorld();
    await topup(fx, 200_000);
    await cashLoan(fx);
    const snapshot = async () => ({
      fund: await fundBalance(fx.outletId),
      entries: await entryCount(fx.outletId),
      journals: (
        await owner.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
          [tenantId, fx.entityId],
        )
      ).rows[0]!.n,
      gl: await glOracle(fx.entityId),
    });
    const before = await snapshot();
    for (let i = 0; i < 3; i += 1) await report(fx);
    expect(await snapshot()).toEqual(before);
  });
});

describe("legend-a4z2f a return never moves more than min(fund, GL)", () => {
  it("[legend-a4z2f-GR-10] return above the GL is refused with PETTY_CASH_GL_INSUFFICIENT, writes nothing; up to the GL passes", async () => {
    const fx = await freshWorld();
    await topup(fx, 460_000);
    await payrollCashPaid(fx); // GL = 460.000 - 450.000 = 10.000, fund 460.000
    expect(await report(fx)).toMatchObject({
      fundIdr: 460_000,
      glIdr: 10_000,
      diffIdr: 450_000,
    });
    const entries = await entryCount(fx.outletId);
    const journals = await journalCount(fx.entityId, PETTY_SOURCES);

    // 50.000 is below the fund but above the GL.
    const over = await giveBack(fx, 50_000);
    expect(over.status, JSON.stringify(over.body)).toBe(422);
    expect(over.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    const oneOver = await giveBack(fx, 10_001);
    expect(oneOver.status).toBe(422);
    expect(oneOver.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    expect(await fundBalance(fx.outletId)).toBe(460_000);
    expect(await entryCount(fx.outletId)).toBe(entries);
    expect(await journalCount(fx.entityId, PETTY_SOURCES)).toBe(journals);

    // Boundary: exactly the GL is allowed, then 1 is too much.
    const exact = await giveBack(fx, 10_000);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await fundBalance(fx.outletId)).toBe(450_000);
    expect(await glOracle(fx.entityId)).toBe(0);
    const one = await giveBack(fx, 1);
    expect(one.status).toBe(422);
    expect(one.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    expect(await fundBalance(fx.outletId)).toBe(450_000);
  });

  it("[legend-a4z2f-GR-11] a return within both fund and GL is unchanged: 201, one balanced journal", async () => {
    const fx = await freshWorld();
    await topup(fx, 100_000);
    const res = await giveBack(fx, 40_000);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.balanceAfterIdr).toBe(60_000);
    expect(await journalCount(fx.entityId, PETTY_SOURCES)).toBe(2);
    expect(await report(fx)).toMatchObject({
      fundIdr: 60_000,
      glIdr: 60_000,
      diffIdr: 0,
    });
  });

  it("[legend-a4z2f-GR-12] a return above the fund is still refused when the GL is larger (a fund-limited case)", async () => {
    const fx = await freshWorld();
    await topup(fx, 100_000);
    const res = await giveBack(fx, 100_001);
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(["PETTY_CASH_INSUFFICIENT", "PETTY_CASH_GL_INSUFFICIENT"]).toContain(
      res.body.error.code,
    );
    expect(await fundBalance(fx.outletId)).toBe(100_000);
  });

  it("[legend-a4z2f-GR-13] a parked topup cannot be returned before its journal is posted; after the retry it can", async () => {
    const fx = await freshWorld();
    const { rows } = await owner.query<{ account_id: string }>(
      "SELECT account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
      [tenantId, fx.entityId],
    );
    const pettyAccount = rows[0]!.account_id;
    await owner.query(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'petty_cash'",
      [tenantId, fx.entityId],
    );
    let parkedId = "";
    try {
      const res = await move(fx.who, movementBody(fx, "topup", 30_000));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      parkedId = res.body.data.id as string;
    } finally {
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, 'petty_cash', $3)`,
        [tenantId, fx.entityId, pettyAccount],
      );
    }
    const refused = await giveBack(fx, 10_000);
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    expect(await fundBalance(fx.outletId)).toBe(30_000);

    const retry = await retryPost(parkedId);
    expect([200, 201]).toContain(retry.status);
    const ok = await giveBack(fx, 10_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await fundBalance(fx.outletId)).toBe(20_000);
  });

  it("[legend-a4z2f-GR-14] two parallel returns cannot overdraw the GL: exactly one passes", async () => {
    const fx = await freshWorld();
    await topup(fx, 600_000);
    await payrollCashPaid(fx); // GL 150.000, fund 600.000
    expect(await report(fx)).toMatchObject({ glIdr: 150_000 });

    const results = await Promise.all([
      giveBack(fx, 100_000),
      giveBack(fx, 100_000),
    ]);
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 422]);
    const refused = results.find((res) => res.status === 422)!;
    expect(refused.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    expect(await fundBalance(fx.outletId)).toBe(500_000);
    expect(await glOracle(fx.entityId)).toBe(50_000);
  });

  it("[legend-a4z2f-GR-15] two funded outlets in one entity: the GL shortfall is charged to the outlet that holds the excess", async () => {
    // Entity GL 1102 is shared. Outlet A holds 1.000.000, outlet B 2.000.000,
    // then a 1.000.000 cash payroll credits 1102 without drawing any fund:
    // GL = 3.000.000 - 1.000.000 = 2.000.000 < total fund 3.000.000.
    // Rule (coordinator): amount <= fundOfOutlet - max(0, totalFund - GL),
    // so A may return at most 1M - 1M = 0 and B at most 2M - 1M = 1M. This is
    // the coordinator's 5M / 10M / 5M scenario scaled down by 5: a 10M top-up
    // is above the tenant approval limit (5M) and would be held (202).
    // Assumption: the 1M excess is attributed to outlet A (the payroll cash
    // was paid out of A's money), so A has no headroom and B keeps 1M.
    const a = await freshWorld();
    const outletB = await makeOutlet(a.entityId);
    await setPolicy(outletB);
    const b: Fx = { ...a, outletId: outletB };
    await topup(a, 1_000_000);
    await topup(b, 2_000_000);
    await payrollCashPaid(a, 1_000_000);
    expect(await glOracle(a.entityId)).toBe(2_000_000);
    expect(await fundBalance(a.outletId)).toBe(1_000_000);
    expect(await fundBalance(b.outletId)).toBe(2_000_000);

    const entriesA = await entryCount(a.outletId);
    const journals = await journalCount(a.entityId, PETTY_SOURCES);
    const fromA = await giveBack(a, 1_000_000);
    expect(fromA.status, JSON.stringify(fromA.body)).toBe(422);
    expect(fromA.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    expect(await fundBalance(a.outletId)).toBe(1_000_000);
    expect(await entryCount(a.outletId)).toBe(entriesA);
    expect(await journalCount(a.entityId, PETTY_SOURCES)).toBe(journals);

    // B: one rupiah above its headroom (2M - 1M) is refused, the headroom passes.
    const tooMuch = await giveBack(b, 1_000_001);
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(422);
    expect(tooMuch.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
    const fromB = await giveBack(b, 1_000_000);
    expect(fromB.status, JSON.stringify(fromB.body)).toBe(201);
    expect(await fundBalance(b.outletId)).toBe(1_000_000);
    expect(await glOracle(a.entityId)).toBe(1_000_000);

    // Total fund 2M vs GL 1M: the 1M excess of A is still uncovered, B has no
    // headroom left.
    const again = await giveBack(b, 1);
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("PETTY_CASH_GL_INSUFFICIENT");
  });
});

describe("legend-a4z2f access and isolation", () => {
  it("[legend-a4z2f-GR-20] anonymous gets 401, a user without a role gets 403; finance reads (control)", async () => {
    const fx = await freshWorld();
    await topup(fx, 40_000);
    const anonymous = await agent(app)
      .get(RECONCILIATION)
      .query({ legalEntityId: fx.entityId, outletId: fx.outletId });
    expect(anonymous.status).toBe(401);
    expect((await reconcileOf(nobody, fx)).status).toBe(403);
    // Control: the route exists and the same query works for finance.
    expect((await reconcileOf(finance, fx)).status).toBe(200);
  });

  it("[legend-a4z2f-GR-21] a malformed legalEntityId is refused with 4xx", async () => {
    const res = await reconcile(finance, { legalEntityId: "not-a-uuid" });
    expect([400, 422], JSON.stringify(res.body)).toContain(res.status);
  });

  it("[legend-a4z2f-GR-22] the figures of another legal entity do not leak into this one", async () => {
    const fx = await freshWorld();
    await topup(fx, 100_000);
    // The other entity holds its own fund, on its own outlet.
    const res = await move(finance, {
      kind: "topup",
      outletId: otherOutlet,
      bankAccountId: otherWorld.bankAccountA,
      amountIdr: 55_000,
      description: "Isi kas kecil entitas lain",
      idempotencyKey: key(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const mine = await report(fx);
    expect(mine).toMatchObject({ fundIdr: 100_000, glIdr: 100_000 });

    // This entity with the other entity's outlet: no fund of that outlet shows.
    const crossed = await reconcile(finance, {
      legalEntityId: fx.entityId,
      outletId: otherOutlet,
    });
    if (crossed.status === 200) {
      expect(crossed.body.data.fundIdr).toBe(0);
    } else {
      expect([403, 404, 422]).toContain(crossed.status);
    }

    // The other entity reads only its own numbers (control).
    const theirs = await reconcile(finance, {
      legalEntityId: otherWorld.entityId,
      outletId: otherOutlet,
    });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    expect(theirs.body.data).toMatchObject({ fundIdr: 55_000, glIdr: 55_000 });
  });

  it("[legend-a4z2f-GR-23] another tenant's legal entity and outlet are not readable", async () => {
    const res = await reconcile(finance, {
      legalEntityId: otherWorld.foreign.entityId,
      outletId: randomUUID(),
    });
    if (res.status === 200) {
      expect(res.body.data).toMatchObject({
        fundIdr: 0,
        glIdr: 0,
        diffIdr: 0,
      });
    } else {
      expect([403, 404, 422]).toContain(res.status);
    }
  });

  it("[legend-a4z2f-GR-24] a finance user scoped to one outlet cannot read another outlet's reconciliation", async () => {
    const fx = await freshWorld();
    await topup(fx, 70_000);
    const res = await reconcileOf(scopedFinance, fx);
    if (res.status === 200) {
      expect(res.body.data.fundIdr).toBe(0);
    } else {
      expect([403, 404]).toContain(res.status);
    }
    // Control: the tenant-wide finance user reads it.
    expect(await report(fx)).toMatchObject({ fundIdr: 70_000 });
  });
});
