// Payroll run LOCK step + reversal (beads legend-b9y4y, legend-c2yca; design
// docs/briefs/sub-payroll-run-lock-design.md sections 3.2, 4 and 6 tests 1-3,
// docs/briefs/sub-payroll-followups-design.md section 7; PRD PAYR-01..PAYR-05;
// founder rule "jangan sampai rugi": no month under- or double-withheld, no
// money to a wrong account, no reversal that breaks a later run's tax).
//
// Round 2 (legend-c2yca): the lock no longer takes caller numbers. Every run is
// SIMULATED by the service (results stored, sealed), approved with SQL (the
// approval routes do not exist yet, design O6), then locked with
// `{ payrollRunId }` only. The December two-run case moved to
// payroll-pph21-december-runs.test.ts; the rapel lock to
// payroll-run-lock-rapel.test.ts; the stored-result contract to
// payroll-run-simulate.test.ts.
//
// RULES UNDER TEST
//  1. [lock-atomic] `lockPayrollRunInTransaction` writes status `locked`,
//     payslips (with the monthly PPh 21), month-dependency edges and the payee
//     bank snapshot in ONE transaction.
//     (a) a bank_transfer payee whose bank account is gone at lock time: 422
//         PAYROLL_BANK_ACCOUNT_MISSING, nothing persisted;
//     (b) a competing run of the month locked after this run was simulated:
//         409 PAYROLL_PPH21_MONTH_STALE, nothing persisted;
//     (c) happy path: status `locked`, the sealed slip equals the stored
//         simulation, snapshot count = bank_transfer slips with net > 0 (a
//         cash slip is excluded).
//  2. [lock-parallel-month] two runs (regular, THR) of one legal entity + month
//     locked concurrently: exactly one is fulfilled, the other is 409
//     PAYROLL_PPH21_MONTH_STALE; after SQL return-to-draft, a fresh simulation
//     and re-approval the loser locks; the month's PPh 21 of both slips equals
//     the TER tax of the month's TOTAL (half up), and the loser has exactly one
//     edge, to the winner.
//  3. [reversal-blocked] reversing the earlier run is refused 409
//     PAYROLL_RUN_REVERSAL_BLOCKED while the later run depends on it; a direct
//     SQL update to `reversed` fails with SQLSTATE 23514; deciding as the
//     requester is 403 PAYROLL_APPROVER_NOT_DISTINCT; reversing the later run
//     first, then the earlier one, works.
//  4. [reversal-after-bank-file] reversal is refused once a bank file exists.
//  5. [lock-guards] a lock refuses what is not what was approved: a result row
//     missing, run totals that differ from the stored results, a stored tax
//     that no longer equals the recomputed one (all 409
//     PAYROLL_RUN_RESULT_STALE), and reimbursements/service charge in the
//     totals (409 PAYROLL_RUN_LOCK_UNSUPPORTED). Loans are supported since
//     legend-8tfvr (docs/briefs/955-loan-design.md): kasbon totals that no
//     deduction row backs are 409 PAYROLL_RUN_RESULT_STALE; the happy path is
//     in payroll-run-loans.test.ts.
//
// ASSUMPTIONS (design silent or OPEN; stated so the engineer can contest them)
//  - Gross of a run = the employee's fixed base-salary component; a THR run's
//    gross is whatever the THR rules give, so the month tax is compared with an
//    oracle (the shared engine on the month's total taxable gross), not with
//    hand numbers.
//  - Payment method = bank_transfer when a bank account is on file, else cash
//    (design O1). The "bank account missing" refusal therefore needs the
//    account removed (raw SQL) after the simulation.
//  - [lock-result-stale-tax] reseals one stored result with a changed
//    `calculation.tax.terRateBp` (raw role, bypassing the freeze trigger) and
//    expects the lock to refuse it as stale.
//  - The payroll.locked event is counted in `domain_event_outbox` by event name
//    and the run id appearing in the event JSON.
//  - Reversal request permission: payroll.lock; decide: payroll.cancel.approve.
//  - The request step may or may not fast-fail with REVERSAL_BLOCKED (design 4);
//    the test accepts the 409 from either request or decide.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  computePayslipTax,
  DEFAULT_PPH21_POLICY,
  payrollRunIdSchema,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { StorageRequest } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import {
  openPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { REFERENCE_TABLES } from "./fixtures/payroll/statutory-tables.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  approveSimulatedRun,
  deleteStatutoryTables,
  insertDraftRun,
  insertEmployee,
  insertPolicy,
  insertSalary,
  publishStatutoryTables,
  returnRunToDraft,
} from "./payroll-simulate-kit.ts";

// ---- App, storage, DB pool -------------------------------------------------

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
class RecordingStorage extends FakeObjectStorage {
  puts: StorageRequest[] = [];
  override async put(context: ScopedTenantContext, input: StorageRequest) {
    this.puts.push(input);
    return super.put(context, input);
  }
}
const storage = new RecordingStorage();
const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime: {
    storage,
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => null,
    hrisDocumentSigner: async () => null,
  },
});

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdThrSchedules: string[] = [];
const createdEntities: string[] = [];
const createdPolicies: string[] = [];

const key = () => `run-lock-${randomUUID()}`;

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId, email };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Run lock ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await conn.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let hr: Client;
let exporterUserId: string;

// ---- Fixtures: worlds, employees, runs --------------------------------------

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

type World = { entityId: string; policyId: string };
type Emp = { id: string; name: string };

/** A legal entity plus a payroll policy and the published statutory tables. */
async function makeWorld(): Promise<World> {
  const world = { entityId: randomUUID(), policyId: randomUUID() };
  createdEntities.push(world.entityId);
  createdPolicies.push(world.policyId);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
      [world.entityId, tenant.id, `PT Kunci Payroll ${++counter}`],
    );
    await insertPolicy(conn, tenant.id, world.entityId, world.policyId);
    await publishStatutoryTables(conn, tenant.id, exporterUserId);
  });
  return world;
}

async function makeEmployee(
  world: World,
  opts: { gross?: number; withBank?: boolean } = {},
): Promise<Emp> {
  const emp: Emp = { id: randomUUID(), name: `Kunci Person ${++counter}` };
  createdEmployees.push(emp.id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: world.entityId,
      id: emp.id,
      name: emp.name,
    });
    await insertSalary(conn, {
      tenantId: tenant.id,
      employeeId: emp.id,
      amount: opts.gross ?? SALARY_GROSS,
      createdBy: exporterUserId,
    });
  });
  // NPWP always (tax id); a bank account unless the test wants a cash payee.
  const put = await hr
    .put(`/api/hris/employees/${emp.id}/pii`)
    .set(originHeader)
    .send({
      nik: digits(16),
      npwp: digits(15),
      ...(opts.withBank === false ? {} : { bankAccount: digits(12) }),
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return emp;
}

type RunDates = { periodStart: string; periodEnd: string; payDate: string };
const NOV = (pay: number): RunDates => ({
  periodStart: "2026-11-01",
  periodEnd: "2026-11-30",
  payDate: `2026-11-${String(pay).padStart(2, "0")}`,
});
const EARLIER_PAY = 15;
const THR_PAY = 28;

/** Run row born a draft (the DB only allows that). */
async function seedDraftRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  await asTenant(async (conn) => {
    const schedule = await insertDraftRun(conn, {
      tenantId: tenant.id,
      runId,
      entityId: world.entityId,
      policyId: world.policyId,
      thr: runType === "thr",
      ...dates,
    });
    if (schedule) createdThrSchedules.push(schedule);
  });
  return runId;
}

// ---- Service adapters (design 3.2 and 4) ----------------------------------------------

async function simulateRun(runId: string) {
  const { simulatePayrollRunInTransaction } =
    await import("../services/payroll-run-simulate.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    simulatePayrollRunInTransaction(
      tx,
      tenantScope(),
      exporterUserId,
      payrollRunIdSchema.parse(runId),
    ),
  );
}

/** A run simulated by the service and approved with SQL, ready to lock. */
async function approvedRun(
  world: World,
  dates: RunDates,
  runType: "regular" | "thr" = "regular",
) {
  const runId = await seedDraftRun(world, dates, runType);
  await simulateRun(runId);
  await asTenant((conn) => approveSimulatedRun(conn, runId));
  expect(await runStatus(runId), "seeded run is approved").toBe("approved");
  return { runId };
}

async function lockRun(runId: string) {
  const { lockPayrollRunInTransaction } =
    await import("../services/payroll-run-lock.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    lockPayrollRunInTransaction(tx, tenantScope(), exporterUserId, {
      payrollRunId: payrollRunIdSchema.parse(runId),
    }),
  );
}

async function requestReversal(runId: string, actor: string) {
  const { requestPayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    requestPayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      actor,
      payrollRunIdSchema.parse(runId),
      "Salah hitung, dibatalkan (uji)",
    ),
  );
}

async function decideReversal(
  runId: string,
  actor: string,
  decision: "approve" | "reject",
) {
  const { decidePayrollRunReversalInTransaction } =
    await import("../services/payroll-run-reversal.service.ts");
  return withTenant(db, tenantScope(), (tx) =>
    decidePayrollRunReversalInTransaction(
      tx,
      tenantScope(),
      actor,
      payrollRunIdSchema.parse(runId),
      decision,
    ),
  );
}

type Failure = { status?: number; code?: string };
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error as Failure,
  );

// ---- DB readers ---------------------------------------------------------------------

const scalar = (sqlText: string, params: unknown[]) =>
  asTenant(async (conn) => (await conn.query(sqlText, params)).rows[0]);

const runStatus = async (runId: string) =>
  (
    await scalar(
      "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).status as string;

const countOf = async (table: string, column: string, runId: string) =>
  Number(
    (
      await scalar(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${column} = $2`,
        [tenant.id, runId],
      )
    ).n,
  );
const payslipCount = (runId: string) =>
  countOf("payslips", "payroll_run_id", runId);
const snapshotCount = (runId: string) =>
  countOf("payslip_bank_snapshots", "payroll_run_id", runId);
const edgeCount = (runId: string) =>
  countOf("payroll_run_month_priors", "payroll_run_id", runId);

const lockedEventCount = async (runId: string) =>
  Number(
    (
      await owner.query(
        `SELECT count(*)::int AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'payroll.locked'
            AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, runId],
      )
    ).rows[0].n,
  );

const priorsOf = async (runId: string) =>
  asTenant(async (conn) =>
    (
      await conn.query(
        "SELECT prior_payroll_run_id FROM payroll_run_month_priors WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      )
    ).rows.map((row) => row.prior_payroll_run_id as string),
  );

type Calc = {
  employeeId: string;
  grossIdr: number;
  netIdr: number;
  pph21Idr: number;
  paymentMethod: string;
  tax: Record<string, unknown> & { taxableGrossIdr: number };
};

/** The stored (decrypted) calculation of every payslip of the given runs. */
const storedSlips = (runIds: string[]) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT id, payroll_run_id, employee_id, calculation_encrypted, pii_key_version
           FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
        [tenant.id, runIds],
      )
    ).rows;
    return rows.map((row) => ({
      runId: row.payroll_run_id as string,
      employeeId: row.employee_id as string,
      calculation: JSON.parse(
        openPayrollValue(
          row.calculation_encrypted,
          {
            tenantId: tenant.id,
            table: "payslips",
            rowId: row.id,
            field: "calculation",
          },
          row.pii_key_version,
        ),
      ) as Calc,
    }));
  });

const resultBinding = (payslipId: string) =>
  ({
    tenantId: tenant.id,
    table: "payroll_run_results",
    rowId: payslipId,
    field: "result",
  }) as never;

/** The stored (decrypted) simulation of every employee of a run. */
const storedResults = (runId: string) =>
  asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT employee_id, payslip_id, result_encrypted, pii_key_version
           FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows;
    return rows.map((row) => ({
      employeeId: row.employee_id as string,
      payslipId: row.payslip_id as string,
      envelope: JSON.parse(
        openPayrollValue(
          row.result_encrypted,
          resultBinding(row.payslip_id),
          row.pii_key_version,
        ),
      ) as { calculation: Calc },
    }));
  });

const reversalOf = async (runId: string) =>
  (
    await scalar(
      "SELECT reversal FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
      [tenant.id, runId],
    )
  ).reversal as { status: string } | null;

/**
 * Oracle for a TER month: the shared engine on the month's TOTAL taxable gross
 * (TK/0, tax id, no earlier periods), default policy (half up). Whoever locks
 * second withholds the difference, so the month sums to exactly this.
 */
const monthTax = (totalTaxableGross: number) =>
  Number(
    computePayslipTax({
      tables: REFERENCE_TABLES,
      policy: DEFAULT_PPH21_POLICY,
      ptkpStatus: "TK/0",
      hasTaxId: true,
      lastTaxPeriod: false,
      monthsWorked: 11,
      earnings: [
        {
          amountIdr: idr(totalTaxableGross),
          taxable: true,
          taxScheme: "gross",
        },
      ],
      employerBenefitIdr: 0,
      employeeDeductibleIdr: 0,
      prior: {
        taxableGrossIdr: 0,
        employeeDeductibleIdr: 0,
        pph21WithheldIdr: 0,
        pph21EmployerBorneIdr: 0,
      },
    }).tax.pph21Idr,
  );

const SALARY_GROSS = 8_000_020;

/**
 * Totals the approvers "saw" differ from what the stored results add up to, or
 * carry an unsupported side effect (raw role: the freeze trigger would refuse).
 */
async function tamperTotals(runId: string, override: Record<string, number>) {
  const loan = override.loanRepaymentIdr ?? 0;
  await asTenant(
    (conn) =>
      conn.query(
        `UPDATE payroll_runs
            SET totals = totals || $2::jsonb
                  || CASE WHEN $3::bigint > 0 THEN jsonb_build_object(
                       'deductionsIdr', (totals->>'deductionsIdr')::bigint + $3::bigint,
                       'netIdr', (totals->>'netIdr')::bigint - $3::bigint,
                       'bankTransferIdr', (totals->>'bankTransferIdr')::bigint - $3::bigint)
                     ELSE '{}'::jsonb END,
                config_snapshot = CASE WHEN $3::bigint > 0
                  THEN config_snapshot || '{"loanMaxDeductionOfNetPayBp":5000}'::jsonb
                  ELSE config_snapshot END
          WHERE id = $1`,
        [runId, JSON.stringify(override), loan],
      ),
    true,
  );
}

// ---- Setup / teardown ------------------------------------------------------------

let approver: { userId: string }; // payroll.cancel.approve, not the requester

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const lock = await signedInClient("Run lock locker");
  await grantRole(lock.userId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
    // The requester may also hold the decide permission: the reducer, not the
    // permission, must refuse the same person deciding (403 NOT_DISTINCT).
    "payroll.cancel.approve",
  ]);
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("Run lock HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const decider = await signedInClient("Run lock reversal approver");
  await grantRole(decider.userId, ["payroll.view", "payroll.cancel.approve"]);
  approver = { userId: decider.userId };

  // No tenant PPh 21 policy version: the default policy (half up) applies.
  await asTenant((conn) =>
    conn.query("DELETE FROM payroll_pph21_policies WHERE tenant_id = $1", [
      tenant.id,
    ]),
  );
});

afterAll(async () => {
  await asTenant(async (conn) => {
    // Raw (replica role): append-only tables reference payslips and runs.
    for (const table of [
      "payroll_run_results",
      "payroll_run_month_priors",
      "payslip_bank_snapshots",
    ])
      if (
        (await conn.query("SELECT to_regclass($1) AS t", [`public.${table}`]))
          .rows[0].t !== null
      )
        await conn.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = ANY($2)`,
          [tenant.id, createdRuns],
        );
    await conn.query(
      "DELETE FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'run-lock-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM thr_schedules WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdThrSchedules],
    );
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdPolicies,
    ]);
    await deleteStatutoryTables(conn, tenant.id);
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM pay_components WHERE tenant_id = $1 AND code LIKE 'SM\\_%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM employment_contracts WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
    ]);
    await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
      createdEntities,
    ]);
    await conn.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await conn.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRoles],
    );
  }, true);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- 1. [lock-atomic] -------------------------------------------------------------

describe("run lock writes monthly tax and bank snapshot in one transaction", () => {
  it("[lock-atomic-a] a bank_transfer payee with net > 0 whose bank account is gone at lock time: 422 PAYROLL_BANK_ACCOUNT_MISSING and nothing persisted", async () => {
    const world = await makeWorld();
    const paid = await makeEmployee(world);
    const gone = await makeEmployee(world);
    const { runId } = await approvedRun(world, NOV(THR_PAY));
    // The simulation stored bank_transfer for both; HR then loses one account.
    await asTenant(
      (conn) =>
        conn.query(
          `UPDATE employees SET bank_account_encrypted = NULL, bank_account_hmac = NULL
            WHERE id = $1`,
          [gone.id],
        ),
      true,
    );
    expect(paid.id).not.toBe(gone.id);

    const refused = await failureOf(lockRun(runId));
    expect(refused, "the lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(422);
    expect(refused!.code).toBe("PAYROLL_BANK_ACCOUNT_MISSING");

    // The tax part and the status ran before the snapshot in the transaction:
    // all of it rolled back.
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
    expect(await snapshotCount(runId)).toBe(0);
    expect(await edgeCount(runId)).toBe(0);
    expect(await lockedEventCount(runId)).toBe(0);
  }, 90_000);

  it("[lock-atomic-b] a competing run of the month locked after this run was simulated: 409 PAYROLL_PPH21_MONTH_STALE and nothing persisted", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    // Both approved against an empty month; the first locks, the second is stale.
    const first = await approvedRun(world, NOV(EARLIER_PAY));
    const second = await approvedRun(world, NOV(THR_PAY), "thr");
    // `second` was simulated before `first` locked: its month basis is empty.
    await lockRun(first.runId);

    const refused = await failureOf(lockRun(second.runId));
    expect(refused, "the stale lock must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_PPH21_MONTH_STALE");
    expect(await runStatus(second.runId)).toBe("approved");
    expect(await payslipCount(second.runId)).toBe(0);
    expect(await snapshotCount(second.runId)).toBe(0);
    expect(await edgeCount(second.runId)).toBe(0);
    expect(await lockedEventCount(second.runId)).toBe(0);
  }, 90_000);

  it("[lock-atomic-c] a good lock: status locked, sealed slip = stored simulation, one snapshot per bank_transfer slip with net > 0 (cash excluded)", async () => {
    const world = await makeWorld();
    const bank = await makeEmployee(world);
    const cash = await makeEmployee(world, {
      gross: 3_000_000,
      withBank: false,
    });
    const { runId } = await approvedRun(world, NOV(THR_PAY));
    const results = await storedResults(runId);
    expect(results).toHaveLength(2);

    const result = await lockRun(runId);
    expect(await runStatus(runId)).toBe("locked");
    expect(result.bankSnapshotCount).toBe(1);
    expect(result.payslips).toHaveLength(2);
    expect(await snapshotCount(runId)).toBe(1);
    expect(await payslipCount(runId)).toBe(2);
    expect(await lockedEventCount(runId)).toBe(1);

    const stored = await storedSlips([runId]);
    for (const expected of results) {
      const slip = stored.find((s) => s.employeeId === expected.employeeId);
      expect(slip, "a payslip exists for the employee").toBeDefined();
      // The sealed slip is the simulation the approvers saw, to the rupiah.
      expect(
        isDeepStrictEqual(slip!.calculation, expected.envelope.calculation),
      ).toBe(true);
      const planned = result.payslips.find(
        (p) => p.employeeId === expected.employeeId,
      );
      expect(Number(planned!.netIdr)).toBe(
        Number(expected.envelope.calculation.netIdr),
      );
    }
    expect(
      stored.find((s) => s.employeeId === cash.id)!.calculation.paymentMethod,
    ).toBe("cash");
    expect(
      stored.find((s) => s.employeeId === bank.id)!.calculation.paymentMethod,
    ).toBe("bank_transfer");
  }, 90_000);
});

// ---- 2. [lock-parallel-month] ------------------------------------------------------

describe("two parallel locks of runs in the same month", () => {
  it("[lock-parallel-month] one wins, the other is 409 PAYROLL_PPH21_MONTH_STALE; after re-simulation the month withholds exactly the TER tax of the month total", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const salary = await approvedRun(world, NOV(EARLIER_PAY));
    const thr = await approvedRun(world, NOV(THR_PAY), "thr");

    // Both were simulated and approved against an empty month (zero basis).
    const [a, b] = await Promise.allSettled([
      lockRun(salary.runId),
      lockRun(thr.runId),
    ]);
    const settled = [
      { name: "salary", result: a, run: salary },
      { name: "thr", result: b, run: thr },
    ];
    const winners = settled.filter((s) => s.result.status === "fulfilled");
    const losers = settled.filter((s) => s.result.status === "rejected");
    expect(winners, "exactly one lock succeeds").toHaveLength(1);
    expect(losers, "exactly one lock is refused").toHaveLength(1);
    const winner = winners[0]!;
    const loser = losers[0]!;
    const failure = (loser.result as PromiseRejectedResult).reason as Failure;
    expect(failure.status).toBe(409);
    expect(failure.code).toBe("PAYROLL_PPH21_MONTH_STALE");
    expect(await runStatus(loser.run.runId)).toBe("approved");
    expect(await payslipCount(loser.run.runId)).toBe(0);

    // The loser is re-simulated against the winner's payslip, re-approved
    // through SQL (return_to_draft -> simulated -> hr_approved -> approved).
    await asTenant((conn) => returnRunToDraft(conn, loser.run.runId));
    await simulateRun(loser.run.runId);
    await asTenant((conn) => approveSimulatedRun(conn, loser.run.runId));
    await lockRun(loser.run.runId);

    expect(await runStatus(salary.runId)).toBe("locked");
    expect(await runStatus(thr.runId)).toBe("locked");
    const stored = await storedSlips([salary.runId, thr.runId]);
    expect(stored).toHaveLength(2);
    const total = stored.reduce((sum, s) => sum + s.calculation.pph21Idr, 0);
    const totalGross = stored.reduce(
      (sum, s) => sum + s.calculation.tax.taxableGrossIdr,
      0,
    );
    // Not the sum of each run alone (double), not less (missing).
    expect(total).toBe(monthTax(totalGross));
    expect(await priorsOf(loser.run.runId)).toEqual([winner.run.runId]);
    expect(await edgeCount(winner.run.runId)).toBe(0);
  }, 90_000);
});

// ---- 3. [reversal-blocked] -----------------------------------------------------------

describe("run reversal", () => {
  it("[reversal-blocked] refused while a later run of the month depends on it; SQL bypass fails with 23514; reverse later first, then earlier", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    // A locks first; B is simulated and locked on top of A (edge B -> A).
    const earlier = await approvedRun(world, NOV(EARLIER_PAY));
    await lockRun(earlier.runId);
    const later = await approvedRun(world, NOV(THR_PAY), "thr");
    await lockRun(later.runId);
    expect(await priorsOf(later.runId)).toEqual([earlier.runId]);

    // The requester cannot decide their own request (reducer, not permission).
    await requestReversal(later.runId, exporterUserId);
    const self = await failureOf(
      decideReversal(later.runId, exporterUserId, "approve"),
    );
    expect(self, "the requester must not decide").not.toBeNull();
    expect(self!.status).toBe(403);
    expect(self!.code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    expect(await runStatus(later.runId)).toBe("locked");

    // A (the earlier run) cannot be reversed: B's tax was computed on it.
    const blocked = await failureOf(
      (async () => {
        await requestReversal(earlier.runId, exporterUserId);
        await decideReversal(earlier.runId, approver.userId, "approve");
      })(),
    );
    expect(blocked, "reversing the earlier run must be refused").not.toBeNull();
    expect(blocked!.status).toBe(409);
    expect(blocked!.code).toBe("PAYROLL_RUN_REVERSAL_BLOCKED");
    expect(await runStatus(earlier.runId)).toBe("locked");

    // The DB refuses the same move written directly (trigger, SQLSTATE 23514).
    const bypass = await asTenant((conn) =>
      conn.query(
        `UPDATE payroll_runs SET status = 'reversed', reversal = $2::jsonb WHERE id = $1`,
        [
          earlier.runId,
          JSON.stringify({
            status: "approved",
            reason: "Uji langsung lewat SQL",
            requestedBy: exporterUserId,
            requestedAt: "2026-11-30T00:00:00.000Z",
            decidedBy: approver.userId,
            decidedAt: "2026-11-30T00:01:00.000Z",
          }),
        ],
      ),
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(bypass, "the direct update must be refused").not.toBeNull();
    expect(bypass!.code).toBe("23514");
    expect(await runStatus(earlier.runId)).toBe("locked");

    // Reverse the later run first (its request is already pending), then A.
    await decideReversal(later.runId, approver.userId, "approve");
    expect(await runStatus(later.runId)).toBe("reversed");
    const pending = await reversalOf(earlier.runId);
    if (pending?.status !== "pending")
      await requestReversal(earlier.runId, exporterUserId);
    await decideReversal(earlier.runId, approver.userId, "approve");
    expect(await runStatus(earlier.runId)).toBe("reversed");
  }, 90_000);
});

// ---- 4. [reversal-after-bank-file] ---------------------------------------------------
//
// ASSUMPTIONS
//  - [reversal-after-bank-file] The legacy export endpoint is closed (legend-yjbjb:
//    409 LEGACY_BANK_EXPORT_DISABLED), so the bank file row is always inserted
//    with SQL (an archive file from before the cutover); for the decide step it
//    is inserted after the request.
//  - The two-run December case ([lock-december-two-runs], formerly a refusal)
//    is now a success and lives in payroll-pph21-december-runs.test.ts.

describe("[reversal-after-bank-file] reversal is refused once a bank file exists", () => {
  it("request is refused 409 PAYROLL_RUN_REVERSAL_BLOCKED once an archived bank file exists for the run", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const run = await approvedRun(world, NOV(THR_PAY));
    await lockRun(run.runId);

    // The legacy export endpoint is closed (legend-yjbjb, 409
    // LEGACY_BANK_EXPORT_DISABLED); a bank file made before the cutover is an
    // archive row, so it is inserted with SQL.
    await asTenant(
      (conn) =>
        conn.query(
          `INSERT INTO bank_transfer_files
             (tenant_id, payroll_run_id, format, row_count, total_idr, checksum_sha256, object_key, created_by)
           VALUES ($1, $2, 'generic_csv', 1, 1, $3, $4, $5)`,
          [
            tenant.id,
            run.runId,
            "a".repeat(64),
            `run-lock-test/${run.runId}.csv`,
            exporterUserId,
          ],
        ),
      true,
    );

    const refused = await failureOf(requestReversal(run.runId, exporterUserId));
    expect(
      refused,
      "reversal after a bank file must be refused",
    ).not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_REVERSAL_BLOCKED");
    expect(await runStatus(run.runId)).toBe("locked");
    expect(await reversalOf(run.runId)).toBeNull();
  }, 90_000);

  it("approve is refused 409 PAYROLL_RUN_REVERSAL_BLOCKED when the bank file was made after the request", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const run = await approvedRun(world, NOV(THR_PAY));
    await lockRun(run.runId);
    await requestReversal(run.runId, exporterUserId);
    expect((await reversalOf(run.runId))?.status).toBe("pending");

    await asTenant(
      (conn) =>
        conn.query(
          `INSERT INTO bank_transfer_files
             (tenant_id, payroll_run_id, format, row_count, total_idr, checksum_sha256, object_key, created_by)
           VALUES ($1, $2, 'generic_csv', 1, 1, $3, $4, $5)`,
          [
            tenant.id,
            run.runId,
            "a".repeat(64),
            `run-lock-test/${run.runId}.csv`,
            exporterUserId,
          ],
        ),
      true,
    );

    const refused = await failureOf(
      decideReversal(run.runId, approver.userId, "approve"),
    );
    expect(refused, "approve after a bank file must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_REVERSAL_BLOCKED");
    expect(await runStatus(run.runId)).toBe("locked");
  }, 90_000);

  // Round 3 G3 (DB backstop for the approve vs bank-file export race). ASSUMPTION:
  // the bank file row is inserted with SQL (raw role, as above) so no service
  // code path is involved; the guard must live in the database itself.
  it("[reversal-bank-file-db-guard] a direct SQL update to reversed is refused with SQLSTATE 23514 while a bank file exists", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const run = await approvedRun(world, NOV(THR_PAY));
    await lockRun(run.runId);

    await asTenant(
      (conn) =>
        conn.query(
          `INSERT INTO bank_transfer_files
             (tenant_id, payroll_run_id, format, row_count, total_idr, checksum_sha256, object_key, created_by)
           VALUES ($1, $2, 'generic_csv', 1, 1, $3, $4, $5)`,
          [
            tenant.id,
            run.runId,
            "b".repeat(64),
            `run-lock-test/${run.runId}-g3.csv`,
            exporterUserId,
          ],
        ),
      true,
    );

    const bypass = await asTenant((conn) =>
      conn.query(
        `UPDATE payroll_runs SET status = 'reversed', reversal = $2::jsonb WHERE id = $1`,
        [
          run.runId,
          JSON.stringify({
            status: "approved",
            reason: "Uji langsung lewat SQL dengan berkas bank",
            requestedBy: exporterUserId,
            requestedAt: "2026-11-30T00:00:00.000Z",
            decidedBy: approver.userId,
            decidedAt: "2026-11-30T00:01:00.000Z",
          }),
        ],
      ),
    ).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(
      bypass,
      "the direct update must be refused while a bank file exists",
    ).not.toBeNull();
    expect(bypass!.code).toBe("23514");
    expect(bypass!.message).toMatch(/has a bank transfer file/);
    expect(await runStatus(run.runId)).toBe("locked");
  }, 90_000);
});

// ---- 5. [lock-guards] ------------------------------------------------------------------

describe("[lock-guards] the lock refuses a run that is not what was approved", () => {
  it("[lock-result-stale-totals] a stored result missing for an approved employee: 409 PAYROLL_RUN_RESULT_STALE, nothing persisted", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    await makeEmployee(world);
    const { runId } = await approvedRun(world, NOV(THR_PAY));
    await asTenant(
      (conn) =>
        conn.query(
          `DELETE FROM payroll_run_results
            WHERE tenant_id = $1 AND payroll_run_id = $2
              AND employee_id = (SELECT employee_id FROM payroll_run_results
                                  WHERE tenant_id = $1 AND payroll_run_id = $2 LIMIT 1)`,
          [tenant.id, runId],
        ),
      true,
    );

    const refused = await failureOf(lockRun(runId));
    expect(refused, "a short result set must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
    expect(await snapshotCount(runId)).toBe(0);
  }, 90_000);

  it("[lock-result-stale-totals] run totals that differ from the stored results: 409 PAYROLL_RUN_RESULT_STALE, nothing persisted", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const { runId } = await approvedRun(world, NOV(THR_PAY));
    const totals = (
      await scalar(
        "SELECT totals FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
        [tenant.id, runId],
      )
    ).totals as { grossIdr: number; netIdr: number; bankTransferIdr: number };
    // A bigger gross than the results add up to; net and transfer move with it.
    await tamperTotals(runId, {
      grossIdr: Number(totals.grossIdr) + 1_000,
      netIdr: Number(totals.netIdr) + 1_000,
      bankTransferIdr: Number(totals.bankTransferIdr) + 1_000,
    });

    const refused = await failureOf(lockRun(runId));
    expect(
      refused,
      "totals off the stored results must be refused",
    ).not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
  }, 90_000);

  it("[lock-result-stale-tax] a stored tax that differs from the recomputed one: 409 PAYROLL_RUN_RESULT_STALE, nothing persisted", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const { runId } = await approvedRun(world, NOV(THR_PAY));
    const [stored] = await storedResults(runId);
    // Totals and amounts untouched; only the rate the approver saw is changed.
    const tampered: { calculation: { tax: { terRateBp: number } } } =
      JSON.parse(JSON.stringify(stored!.envelope));
    tampered.calculation.tax.terRateBp += 1;
    await asTenant(
      (conn) =>
        conn.query(
          `UPDATE payroll_run_results SET result_encrypted = $3, pii_key_version = $4
            WHERE tenant_id = $1 AND payslip_id = $2`,
          [
            tenant.id,
            stored!.payslipId,
            sealPayrollValue(
              JSON.stringify(tampered),
              resultBinding(stored!.payslipId),
            ),
            PAYROLL_SEAL_KEY_VERSION,
          ],
        ),
      true,
    );

    const refused = await failureOf(lockRun(runId));
    expect(refused, "a tax mismatch must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
    expect(await snapshotCount(runId)).toBe(0);
  }, 90_000);

  it("[lock-loan-unrecorded] approved totals with loanRepaymentIdr > 0 that no deduction row backs: 409 PAYROLL_RUN_RESULT_STALE (no longer LOCK_UNSUPPORTED), nothing persisted", async () => {
    const world = await makeWorld();
    await makeEmployee(world);
    const { runId } = await approvedRun(world, NOV(THR_PAY));
    await tamperTotals(runId, { loanRepaymentIdr: 50_000 });

    const refused = await failureOf(lockRun(runId));
    expect(refused, "loan totals without rows must be refused").not.toBeNull();
    expect(refused!.status).toBe(409);
    expect(refused!.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(runId)).toBe("approved");
    expect(await payslipCount(runId)).toBe(0);
    expect(await snapshotCount(runId)).toBe(0);
  }, 90_000);

  it.each([
    ["reimbursementIdr", 75_000],
    ["serviceChargeIdr", 25_000],
  ])(
    "[lock-unsupported] approved totals with %s > 0: 409 PAYROLL_RUN_LOCK_UNSUPPORTED, nothing persisted",
    async (field, amount) => {
      const world = await makeWorld();
      await makeEmployee(world);
      const { runId } = await approvedRun(world, NOV(THR_PAY));
      await tamperTotals(runId, { [field]: amount });

      const refused = await failureOf(lockRun(runId));
      expect(refused, `${field} > 0 must be refused`).not.toBeNull();
      expect(refused!.status).toBe(409);
      expect(refused!.code).toBe("PAYROLL_RUN_LOCK_UNSUPPORTED");
      expect(await runStatus(runId)).toBe("approved");
      expect(await payslipCount(runId)).toBe(0);
      expect(await snapshotCount(runId)).toBe(0);
    },
    90_000,
  );
});
