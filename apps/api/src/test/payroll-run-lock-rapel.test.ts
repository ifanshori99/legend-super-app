// Rapel runs lock through the GENERAL payroll run lock (bead legend-ele0u; design
// docs/briefs/sub-payroll-followups-design.md sections 0.3, 4 and 7 tests 10-14;
// PRD PAYR-01..PAYR-04; founder rule "no employee paid more, outlet never loses").
// Fail-first: written before the implementation (simulate/lock routes, the rapel
// lock helpers and the v1 receipt guard do not exist yet).
//
// RULES UNDER TEST
//  10. [lock-rapel-locks] a draft run holding an approved rapel allocation is
//      simulated (route), approved (SQL, design O6: no route yet) and locked
//      (route): status `locked`, the payslip written under the reserved payslip
//      id is a FULL PayslipCalculation (RAPEL line + PPh 21), a rapel receipt
//      exists, and the bank file total equals totals.bankTransferIdr.
//  11. [lock-rapel-allocation-changed] an allocation changed after the
//      simulation (the stored result no longer matches the live allocation:
//      other revision, other RAPEL amount, or a RAPEL line for an employee with
//      no allocation): lock is 409 PAYROLL_RUN_RESULT_STALE, nothing is written.
//  12. [lock-rapel-thr-coretax] a THR run of the same legal entity and month
//      simulates (no 422 for the locked rapel run's slips) and the Coretax
//      monthly export of the month works (201, the employee is in the file).
//  13. [lock-rapel-finalize-refused] the rapel finalize step on a run locked by
//      the general lock is 409 (fail closed, no second payment).
//  14. [lock-rapel-v1-needs-receipt] a v1 (full calculation) payslip carrying a
//      RAPEL allocation, inserted with no receipt in the same transaction, is
//      refused by the database with SQLSTATE 23514.
//
// WORKED NUMBERS (as payroll-export-rapel.test.ts): base 6.000.000 -> 6.900.000
// from 2026-06-16 of June: back pay 450.000; July gross = 6.900.000 + 450.000 =
// 7.350.000. TK/0 + NPWP, TER category A, no BPJS programmes. Expected PPh 21 is
// read from the PP 58/2023 reference table (fixtures/payroll/statutory-tables.ts)
// and rounded half up, net = gross - PPh 21 = the bank transfer.
//
// ASSUMPTIONS (brief silent; stated so the engineer can contest them)
//  - Routes: POST /api/hris/payroll/runs/:id/simulate and /lock, body
//    { idempotencyKey } (design section 2); lock needs payroll.lock, simulate
//    payroll.run. Approval is by SQL (design O6), by uuid approvers.
//  - "Allocations changed" (test 11): an allocated rapel is terminal and its rows
//    are DB-guarded (clearing the reservation is refused, 23514), so staleness is
//    made on the STORED result instead: while the run is `simulated` the stored
//    result is replaced (DELETE + INSERT, same simulation_no; UPDATE is refused) with
//    another allocation revision, another RAPEL amount, or an extra RAPEL line on
//    an employee with no allocation; gross and totals stay as simulated so only
//    the rapel check (design 4: assertRapelResultMatches) can refuse. Then the run
//    is approved and locked: 409 PAYROLL_RUN_RESULT_STALE.
//  - The employee is in the run through legal entity + employment type pkwtt
//    (policy employeeGroup.employmentTypes), has ptkp_status TK/0 and a bank
//    account, so the payment method is bank_transfer (design O1).
//  - The THR run only needs to simulate: its numbers are not asserted.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  bankTransferFileSchema,
  cafeLegendPayrollFixtures,
  payrollConfigSnapshotSchema,
  payrollRunTotalsSchema,
  payrollTaxExportSchema,
  payslipCalculationSchema,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ObjectStorage, StorageRequest } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { createLogger } from "../lib/logger.ts";
import {
  openPayrollValue,
  sealPayrollAmount,
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  openRunResult,
  sealRunResult,
} from "../services/payroll-run-simulate.service.ts";
import { createBankTransferFile } from "../services/payroll-export.service.ts";
import { finalizePayrollRapelRunInTransaction } from "../services/payroll-rapel-finalize.service.ts";
import {
  REFERENCE_PPH21_ANNUAL,
  REFERENCE_PTKP,
  REFERENCE_TER,
} from "./fixtures/payroll/statutory-tables.ts";
import {
  insertEmployee,
  insertSalary,
  publishStatutoryTables,
} from "./payroll-simulate-kit.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

// ---- App with in-memory storage -------------------------------------------

const logStream = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});

const stored = new Map<string, StorageRequest>();
const FAKE_STORE = "https://lock-rapel-store.example.test/object";
const fakeStorage: ObjectStorage = {
  put: async (_context, input) => {
    stored.set(input.key, input);
    return { reference: input.reference, accepted: true };
  },
  get: async (_context, input) => {
    const found = stored.get(input.key);
    if (!found) throw new Error(`fake storage: no object ${input.key}`);
    return found;
  },
  delete: async (_context, input) => {
    stored.delete(input.key);
  },
  signedGetUrl: async (_context, input) =>
    `${FAKE_STORE}?key=${encodeURIComponent(input.key)}&sig=fake`,
  publicUrl: async () => {
    throw new Error("a payroll file must not use a public URL");
  },
};
const storageRuntime: StorageRuntime = {
  storage: fakeStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => null,
  hrisDocumentSigner: async () => null,
};

const app = createApp({
  logger: createLogger({ level: "debug", destination: logStream }),
  storageRuntime,
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
const createdPositions: string[] = [];
const createdRuns: string[] = [];
const createdComponents: string[] = [];
const createdThrSchedules: string[] = [];
const createdEntities: { entityId: string; policyId: string }[] = [];

const key = () => `lock-rapel-${randomUUID()}`;
const simulatePath = (runId: string) =>
  `/api/hris/payroll/runs/${runId}/simulate`;
const lockPath = (runId: string) => `/api/hris/payroll/runs/${runId}/lock`;
const RAPEL_ROOT = "/api/hris/payroll/rapel";
const TAX_EXPORT_PATH = "/api/hris/payroll/tax-exports";

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
        `Lock rapel ${roleId.slice(0, 8)}`,
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
let exporter: Client; // payroll.view + run + lock: simulates, locks, exports
let exporterUserId: string;
let hr: Client; // writes employee PII through the real route
let rapelHr: Client; // payroll.approve: first approver
let rapelFinance: Client; // payroll.approve + payroll.lock: second approver
let orgAdmin: Client; // creates legal entities (with NPWP) through the org API

const post = (client: Client, path: string, payload: object) =>
  client.post(path).set(originHeader).send(payload);

// ---- Fixtures ----------------------------------------------------------------

let counter = 0;
// A 3-digit counter first (no two values of one length can match), then random digits.
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

// Pinned tables (PAYR-02): ptkp, pph21_ter, pph21_annual. Own ids/versions and
// an old effective date, as payroll-run-lock.test.ts.
const PINNED = [
  { type: "ptkp", id: randomUUID(), version: 9601, params: REFERENCE_PTKP },
  { type: "pph21_ter", id: randomUUID(), version: 9602, params: REFERENCE_TER },
  {
    type: "pph21_annual",
    id: randomUUID(),
    version: 9603,
    params: REFERENCE_PPH21_ANNUAL,
  },
] as const;
// Older than the kit range (1900-1949): the kit tables win for simulate, so
// deleting these rows in afterAll never strands another file's run snapshot.
const PINNED_FROM = "1899-01-01";

async function ensureStatutoryTables() {
  await asTenant(async (conn) => {
    for (const row of PINNED) {
      await conn.query(
        `INSERT INTO statutory_rates
           (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
         VALUES ($1, $2, $3, $4, $5, 'draft', 'PP 58/2023 (test)', $6::jsonb, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          row.id,
          tenant.id,
          row.type,
          row.version,
          PINNED_FROM,
          JSON.stringify(row.params),
          exporterUserId,
        ],
      );
      await conn.query(
        `UPDATE statutory_rates
            SET status = 'published', published_at = now(), published_by = $2
          WHERE id = $1 AND status = 'draft'`,
        [row.id, exporterUserId],
      );
    }
    // The THR simulate also needs the BPJS and THR tables: publish the kit
    // set too, so this file passes when it runs alone.
    await publishStatutoryTables(conn, tenant.id, exporterUserId);
  });
}

/** PPh 21 by TER category A (TK/0) on a monthly gross, half up. */
function terPph21(gross: number): number {
  const bracket = REFERENCE_TER.bracketsByCategory.A.find(
    (b) => b.upToIdr === null || gross <= b.upToIdr,
  )!;
  return Math.floor((gross * bracket.rateBp + 5_000) / 10_000);
}
const RAPEL_GROSS = 7_350_000;
const RAPEL_AMOUNT = 450_000;

type Person = {
  id: string;
  name: string;
  nik: string;
  npwp: string;
  account: string;
};

type Scenario = {
  person: Person;
  entityId: string;
  policyId: string;
  sourceRunId: string;
  runId: string;
  payslipId: string;
  rapelId: string;
  componentId: string;
  componentCode: string;
};

// Run approvers and creator are uuids (payrollRunSchema).
const CREATOR = randomUUID();
const HR_APPROVER = randomUUID();
const FINANCE_APPROVER = randomUUID();

/**
 * A DRAFT July regular run (not locked: the general lock does that) that holds a
 * real rapel allocation, like payroll-export-rapel.test.ts: a locked June source
 * run with the employee's payslip, a 6.000.000 -> 6.900.000 raise from
 * 2026-06-16 approved by HR then Finance and allocated to the July run.
 */
async function seedScenario(label: string): Promise<Scenario> {
  await ensureStatutoryTables();
  const created = await orgAdmin
    .post("/api/org/legal-entities")
    .set(originHeader)
    .send({
      name: `PT Lock Rapel ${label} ${++counter}`,
      npwp: digits(16),
      isPkp: false,
      address: "Kota Bandung",
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const entityId = created.body.data.id as string;
  const policyId = randomUUID();
  createdEntities.push({ entityId, policyId });

  const person: Person = {
    id: randomUUID(),
    name: `Lock Rapel ${label} ${counter}`,
    nik: digits(16),
    npwp: digits(15),
    account: digits(12),
  };
  createdEmployees.push(person.id);
  const sourceRunId = randomUUID();
  const runId = randomUUID();
  const sourcePayslipId = randomUUID();
  createdRuns.push(sourceRunId, runId);
  const componentId = randomUUID();
  createdComponents.push(componentId);
  const amountId = randomUUID();
  const componentCode = `LR_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const employeeNo = `LR-${person.id.slice(0, 8).toUpperCase()}`;
  const calculation = payslipCalculationSchema.parse({
    employeeId: person.id,
    employeeNo,
    employeeName: person.name,
    positionName: "Staff",
    outletId: outlet.id,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    payDate: "2026-06-30",
    grossIdr: 6_000_000,
    deductionsIdr: 0,
    netIdr: 6_000_000,
    pph21Idr: 0,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines: [
      {
        componentCode,
        name: "Gaji pokok lock rapel",
        category: "base_salary",
        kind: "earning",
        amountIdr: 6_000_000,
        taxable: true,
        quantity: null,
        sourceId: null,
      },
    ],
    bpjs: [],
    tax: {
      ...cafeLegendPayrollFixtures.payslips[0]!.tax,
      taxableGrossIdr: 6_000_000,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      pph21EmployerAllowanceRefundIdr: 0,
      pph21ReceivableIdr: 0,
      taxAllowanceIdr: 0,
      grossSchemeBaseIdr: 6_000_000,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: "bank_transfer",
  });
  const positionId = randomUUID();
  createdPositions.push(positionId);
  await asTenant(async (conn) => {
    // The Coretax export needs the employee's position (422
    // PAYROLL_TAX_EXPORT_POSITION_MISSING without one).
    await conn.query(
      "INSERT INTO positions (id, tenant_id, name) VALUES ($1, $2, 'Staf lock rapel')",
      [positionId, tenant.id],
    );
    await conn.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name,
         employee_group_code, employee_group, cycle, pay_date_adjustment,
         jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Kunci Rapel', $4, $5,
          '{"frequency":"monthly","cutoffDay":null,"payDay":null,"payMonthOffset":0}', 'none', 'low', '[]')`,
      [
        policyId,
        tenant.id,
        entityId,
        `LR${policyId.slice(0, 8).toUpperCase()}`,
        JSON.stringify({
          code: `LR${policyId.slice(0, 8).toUpperCase()}`,
          name: "Kunci rapel",
          employmentTypes: ["pkwtt"],
        }),
      ],
    );
    await conn.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, position_id, employment_type, join_date, status,
                              ptkp_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pkwtt', '2025-01-01', 'active', 'TK/0')`,
      [
        person.id,
        tenant.id,
        employeeNo,
        person.name,
        outlet.id,
        entityId,
        positionId,
      ],
    );
    // Simulate reads the employee's PPh 21 scheme from the latest non-draft
    // contract starting on or before the pay date (422 when there is none).
    await conn.query(
      `INSERT INTO employment_contracts
         (id, tenant_id, employee_id, type, tax_scheme, start_date,
          reminder_days_before, status)
       VALUES ($1, $2, $3, 'pkwtt', 'gross', '2025-01-01', 30, 'active')`,
      [randomUUID(), tenant.id, person.id],
    );
  });
  const put = await hr
    .put(`/api/hris/employees/${person.id}/pii`)
    .set(originHeader)
    .send({
      nik: person.nik,
      npwp: person.npwp,
      bankAccount: person.account,
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  await asTenant(async (conn) => {
    await conn.query(
      `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
         recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
       VALUES ($1, $2, $3, 'Gaji pokok lock rapel', 'base_salary', 'earning',
         'fixed', true, 'gross', true, true, true)`,
      [componentId, tenant.id, componentCode],
    );
    await conn.query(
      `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
         amount_encrypted, pii_key_version, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, '2025-01-01', $7)`,
      [
        amountId,
        tenant.id,
        person.id,
        componentId,
        sealPayrollAmount(idr(6_000_000), {
          tenantId: tenant.id,
          table: "employee_pay_components",
          rowId: amountId,
          field: "amount",
        }),
        PAYROLL_SEAL_KEY_VERSION,
        exporterUserId,
      ],
    );
    for (const [id, start, end] of [
      [sourceRunId, "2026-06-01", "2026-06-30"],
      [runId, "2026-07-01", "2026-07-31"],
    ])
      await conn.query(
        `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                   period_start, period_end, pay_date, created_by)
         VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, $7)`,
        [id, tenant.id, entityId, policyId, start, end, CREATOR],
      );
    for (const step of [
      `status = 'simulated'`,
      `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
      `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
      `status = 'locked', config_snapshot = '{"v":1}', totals = '{"t":1}', locked_by = 'lock-user', locked_at = now()`,
    ])
      await conn.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        sourceRunId,
      ]);
    await conn.query(
      `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
         payment_method, calculation_encrypted, pii_key_version)
       VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
      [
        sourcePayslipId,
        tenant.id,
        sourceRunId,
        person.id,
        sealPayrollValue(JSON.stringify(calculation), {
          tenantId: tenant.id,
          table: "payslips",
          rowId: sourcePayslipId,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    );
  });

  // The raise: create, approve (HR then Finance), allocate to the July run.
  const raise = await post(exporter, RAPEL_ROOT, {
    employeeId: person.id,
    componentId,
    effectiveFrom: "2026-06-16",
    newAmountIdr: 6_900_000,
    idempotencyKey: key(),
  });
  expect(raise.status, JSON.stringify(raise.body)).toBe(201);
  const rapelId = raise.body.data.id as string;
  for (const [client, step] of [
    [rapelHr, "approve-hr"],
    [rapelFinance, "approve-finance"],
  ] as const) {
    const approved = await post(client, `${RAPEL_ROOT}/${rapelId}/${step}`, {
      idempotencyKey: key(),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  }
  const allocated = await post(exporter, `${RAPEL_ROOT}/${rapelId}/allocate`, {
    payrollRunId: runId,
    idempotencyKey: key(),
  });
  expect(allocated.status, JSON.stringify(allocated.body)).toBe(200);
  return {
    person,
    entityId,
    policyId,
    sourceRunId,
    runId,
    payslipId: allocated.body.data.reservedPayslipId as string,
    rapelId,
    componentId,
    componentCode,
  };
}

// ---- Run steps -----------------------------------------------------------------

const simulateRun = (runId: string) =>
  post(exporter, simulatePath(runId), { idempotencyKey: key() });
const lockRun = (runId: string) =>
  post(exporter, lockPath(runId), { idempotencyKey: key() });

/** simulated -> hr_approved -> approved by SQL (design O6: no route yet). */
async function approveBySql(runId: string) {
  await asTenant(async (conn) => {
    await conn.query(
      `UPDATE payroll_runs SET status = 'hr_approved', approved_by_hr = $2, approved_by_hr_at = now()
        WHERE id = $1`,
      [runId, HR_APPROVER],
    );
    await conn.query(
      `UPDATE payroll_runs SET status = 'approved', approved_by_finance = $2, approved_by_finance_at = now()
        WHERE id = $1`,
      [runId, FINANCE_APPROVER],
    );
  });
}

/** Simulate (route, 200) and approve (SQL). */
async function simulatedAndApproved(s: Scenario) {
  const simulated = await simulateRun(s.runId);
  expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);
  expect(simulated.body.data.status).toBe("simulated");
  await approveBySql(s.runId);
  expect(await runStatus(s.runId)).toBe("approved");
}

const runStatus = (runId: string) =>
  asTenant(
    async (conn) =>
      (
        await conn.query(
          "SELECT status FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
          [tenant.id, runId],
        )
      ).rows[0].status as string,
  );

const runTotals = (runId: string) =>
  asTenant(async (conn) =>
    payrollRunTotalsSchema.parse(
      (
        await conn.query(
          "SELECT totals FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
          [tenant.id, runId],
        )
      ).rows[0].totals,
    ),
  );

const countOf = (table: string, runId: string) =>
  asTenant(async (conn) =>
    Number(
      (
        await conn.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND payroll_run_id = $2`,
          [tenant.id, runId],
        )
      ).rows[0].n,
    ),
  );

async function payslipsOf(runId: string) {
  return asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT id, employee_id, payment_method, calculation_encrypted, pii_key_version
           FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows;
    return rows.map((row) => ({
      id: row.id as string,
      employeeId: row.employee_id as string,
      calculation: payslipCalculationSchema.parse(
        JSON.parse(
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
        ),
      ),
    }));
  });
}

/** Nothing the lock writes exists for this run (status stays as given). */
async function expectNothingWritten(runId: string) {
  expect(await countOf("payslips", runId)).toBe(0);
  expect(await countOf("payroll_rapel_finalizations", runId)).toBe(0);
  expect(await countOf("payslip_bank_snapshots", runId)).toBe(0);
  expect(await countOf("payroll_run_month_priors", runId)).toBe(0);
}

type StoredResultJson = {
  calculation: { lines: Array<Record<string, unknown>> };
  rapelAllocationRevision: number | null;
};

/**
 * Keeps grossIdr = sum of earnings after a RAPEL edit: takes `delta` off the
 * employee's first non-RAPEL earning line, so only the rapel check can fail.
 */
function shiftFromBaseEarning(result: StoredResultJson, delta: number): void {
  const base = result.calculation.lines.find(
    (l) =>
      l.kind === "earning" &&
      l.componentCode !== "RAPEL" &&
      typeof l.amountIdr === "number" &&
      l.amountIdr > delta,
  );
  expect(base, "a base earning line to offset the RAPEL edit").toBeDefined();
  base!.amountIdr = (base!.amountIdr as number) - delta;
}

/**
 * Opens every stored result of the run, lets `mutate` edit them (keyed by
 * employee id), and replaces the rows (DELETE then INSERT, same simulation_no).
 * Call it while the run is `simulated` (results are frozen after approval).
 */
async function tamperStoredResults(
  runId: string,
  mutate: (byEmployee: Map<string, StoredResultJson>) => void,
) {
  await asTenant(async (conn) => {
    const rows = (
      await conn.query(
        `SELECT employee_id, payslip_id, simulation_no, payment_method,
                result_encrypted, pii_key_version
           FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [tenant.id, runId],
      )
    ).rows;
    const byEmployee = new Map<string, StoredResultJson>();
    for (const row of rows)
      byEmployee.set(
        row.employee_id as string,
        openRunResult(
          row.result_encrypted,
          tenant.id,
          row.payslip_id,
          row.pii_key_version,
        ) as unknown as StoredResultJson,
      );
    mutate(byEmployee);
    // The table refuses UPDATE (re-seal needs a higher key version), but DELETE
    // and INSERT are allowed while the run is draft or simulated: replace each
    // row, keeping its simulation_no.
    await conn.query(
      "DELETE FROM payroll_run_results WHERE tenant_id = $1 AND payroll_run_id = $2",
      [tenant.id, runId],
    );
    for (const row of rows)
      await conn.query(
        `INSERT INTO payroll_run_results
           (tenant_id, payroll_run_id, employee_id, payslip_id, simulation_no,
            payment_method, result_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tenant.id,
          runId,
          row.employee_id,
          row.payslip_id,
          row.simulation_no,
          row.payment_method,
          sealRunResult(
            tenant.id,
            row.payslip_id,
            byEmployee.get(row.employee_id as string) as never,
          ),
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
  });
}

/**
 * A second active employee in the scenario's entity and policy (so in the run's
 * population) with a salary and a bank account but NO rapel allocation.
 */
async function addEmployeeWithoutAllocation(s: Scenario): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant(async (conn) => {
    await insertEmployee(conn, {
      tenantId: tenant.id,
      outletId: outlet.id,
      entityId: s.entityId,
      id,
      name: `Lock Rapel tanpa alokasi ${++counter}`,
    });
    createdComponents.push(
      await insertSalary(conn, {
        tenantId: tenant.id,
        employeeId: id,
        amount: 8_000_020,
        createdBy: exporterUserId,
      }),
    );
  });
  const put = await hr
    .put(`/api/hris/employees/${id}/pii`)
    .set(originHeader)
    .send({
      nik: digits(16),
      npwp: digits(15),
      bankAccount: digits(12),
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return id;
}

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenant.id,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

// ---- Setup / teardown -----------------------------------------------------------

beforeAll(async () => {
  const lock = await signedInClient("Lock rapel locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporter = lock.client;
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("Lock rapel HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const approverHr = await signedInClient("Lock rapel approver HR");
  await grantRole(approverHr.userId, ["payroll.view", "payroll.approve"]);
  rapelHr = approverHr.client;
  const approverFinance = await signedInClient("Lock rapel approver Finance");
  await grantRole(approverFinance.userId, [
    "payroll.view",
    "payroll.approve",
    "payroll.lock",
  ]);
  rapelFinance = approverFinance.client;

  // Org admin: global admin + Owner template + MFA, as payroll-coretax-export.test.ts.
  const admin = agent(app);
  const email = await signUp(admin, "Lock rapel org admin");
  await setRole(email, "admin");
  const session = await admin.get("/api/auth/get-session");
  const adminId = session.body.user.id as string;
  createdUsers.push(adminId);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
      WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenant.id, adminId],
  );
  await verifySessionMfa(email);
  orgAdmin = admin;
});

afterAll(async () => {
  await asTenant(async (conn) => {
    // Append-only tables reference payslips and runs; the new ones may not exist
    // before the implementation.
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'lock-rapel-%'",
      [tenant.id],
    );
    await conn.query(
      "DELETE FROM payroll_tax_exports WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
      [tenant.id, createdEntities.map((e) => e.entityId)],
    );
    await conn.query(
      "DELETE FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM payroll_rapel_finalizations WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      `DELETE FROM payroll_rapel_items WHERE tenant_id = $1 AND rapel_id IN
         (SELECT id FROM payroll_rapels WHERE tenant_id = $1 AND employee_id = ANY($2))`,
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM payroll_rapels WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query(
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query(
      "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM pay_components WHERE id = ANY($1)", [
      createdComponents,
    ]);
    await conn.query(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await conn.query("DELETE FROM thr_schedules WHERE id = ANY($1)", [
      createdThrSchedules,
    ]);
    await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
      createdEntities.map((e) => e.policyId),
    ]);
    await conn.query(
      "DELETE FROM employment_contracts WHERE tenant_id = $1 AND employee_id = ANY($2)",
      [tenant.id, createdEmployees],
    );
    await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
      createdEmployees,
    ]);
    await conn.query("DELETE FROM positions WHERE id = ANY($1)", [
      createdPositions,
    ]);
    await conn.query(
      "DELETE FROM statutory_rates WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, PINNED.map((row) => row.id)],
    );
    await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
      createdEntities.map((e) => e.entityId),
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

// ---- Tests -------------------------------------------------------------------------

describe("legend-ele0u rapel runs lock through the general run lock", () => {
  it("[lock-rapel-locks] simulate, approve, lock: the run is locked, the slip is a full calculation with the RAPEL line and PPh 21, a receipt exists, and the bank file total equals totals.bankTransferIdr", async () => {
    const s = await seedScenario("locks");
    await simulatedAndApproved(s);

    const locked = await lockRun(s.runId);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.data.status).toBe("locked");
    expect(await runStatus(s.runId)).toBe("locked");

    // One slip, under the identity reserved by the allocation, as a FULL
    // calculation (payslipCalculationSchema parses it; not a gross envelope).
    const slips = await payslipsOf(s.runId);
    expect(slips).toHaveLength(1);
    const slip = slips[0]!;
    expect(slip.id).toBe(s.payslipId);
    expect(slip.employeeId).toBe(s.person.id);
    const calc = slip.calculation;
    expect(calc.grossIdr).toBe(RAPEL_GROSS);
    expect(calc.lines.filter((line) => line.componentCode === "RAPEL")).toEqual(
      [
        expect.objectContaining({
          sourceId: s.rapelId,
          amountIdr: RAPEL_AMOUNT,
        }),
      ],
    );
    const pph21 = terPph21(RAPEL_GROSS);
    expect(pph21).toBeGreaterThan(0);
    expect(calc.pph21Idr).toBe(pph21);
    expect(calc.tax.pph21Idr).toBe(pph21);
    expect(calc.netIdr).toBe(RAPEL_GROSS - pph21);
    expect(calc.paymentMethod).toBe("bank_transfer");

    // The receipt written in the same transaction.
    expect(await countOf("payroll_rapel_finalizations", s.runId)).toBe(1);

    // Run totals equal the slip; nobody is paid more than the net.
    const totals = await runTotals(s.runId);
    expect(totals.employeeCount).toBe(1);
    expect(totals.pph21Idr).toBe(pph21);
    expect(totals.bankTransferIdr).toBe(calc.netIdr);

    // Bank export: file total == totals.bankTransferIdr (PAYR-04). The legacy
    // POST route is closed (legend-yjbjb: 409 LEGACY_BANK_EXPORT_DISABLED, see
    // payroll-payout-870-legacy-export), so the internal builder is called
    // directly.
    const exported = await createBankTransferFile(
      context,
      exporterUserId,
      s.runId as never,
      { format: "generic_csv", idempotencyKey: key() },
      storageRuntime,
    );
    const file = bankTransferFileSchema.parse(
      JSON.parse(JSON.stringify(exported)),
    );
    expect(file.totalIdr).toBe(totals.bankTransferIdr);
    expect(file.rowCount).toBe(1);
  });

  it("[lock-rapel-allocation-changed] an allocation revision changed after the simulation: lock is 409 PAYROLL_RUN_RESULT_STALE and nothing is written", async () => {
    const s = await seedScenario("changed");
    const simulated = await simulateRun(s.runId);
    expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);

    // The stored result was computed against another allocation revision.
    await tamperStoredResults(s.runId, (byEmployee) => {
      const result = byEmployee.get(s.person.id)!;
      expect(result.rapelAllocationRevision).not.toBeNull();
      result.rapelAllocationRevision = result.rapelAllocationRevision! + 1;
    });
    await approveBySql(s.runId);

    const response = await lockRun(s.runId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(s.runId)).toBe("approved");
    await expectNothingWritten(s.runId);
  });

  it("[lock-rapel-amount-changed] the stored RAPEL line differs from the allocated amount: lock is 409 PAYROLL_RUN_RESULT_STALE and nothing is written", async () => {
    const s = await seedScenario("amount");
    const simulated = await simulateRun(s.runId);
    expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);

    // Only the RAPEL line moves; gross and totals stay as simulated.
    await tamperStoredResults(s.runId, (byEmployee) => {
      const line = byEmployee
        .get(s.person.id)!
        .calculation.lines.find((l) => l.componentCode === "RAPEL");
      expect(line, "the stored result holds the RAPEL line").toBeDefined();
      expect(line!.amountIdr).toBe(RAPEL_AMOUNT);
      line!.amountIdr = RAPEL_AMOUNT + 1_000;
      shiftFromBaseEarning(byEmployee.get(s.person.id)!, 1_000);
    });
    await approveBySql(s.runId);

    const response = await lockRun(s.runId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(s.runId)).toBe("approved");
    await expectNothingWritten(s.runId);
  });

  it("[lock-rapel-line-without-allocation] a stored RAPEL line for an employee with no allocation: lock is 409 PAYROLL_RUN_RESULT_STALE and nothing is written", async () => {
    const s = await seedScenario("noalloc");
    const otherId = await addEmployeeWithoutAllocation(s);
    const simulated = await simulateRun(s.runId);
    expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);

    // Give the unallocated employee a copy of the allocated RAPEL line (another
    // source id); gross and totals stay as simulated.
    await tamperStoredResults(s.runId, (byEmployee) => {
      const line = byEmployee
        .get(s.person.id)!
        .calculation.lines.find((l) => l.componentCode === "RAPEL");
      expect(line, "the stored result holds the RAPEL line").toBeDefined();
      const other = byEmployee.get(otherId);
      expect(other, "the second employee is in the run").toBeDefined();
      expect(
        other!.calculation.lines.some((l) => l.componentCode === "RAPEL"),
      ).toBe(false);
      other!.calculation.lines.push({ ...line!, sourceId: randomUUID() });
      shiftFromBaseEarning(other!, Number(line!.amountIdr));
    });
    await approveBySql(s.runId);

    const response = await lockRun(s.runId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error.code).toBe("PAYROLL_RUN_RESULT_STALE");
    expect(await runStatus(s.runId)).toBe("approved");
    await expectNothingWritten(s.runId);
  });

  it("[lock-rapel-thr-coretax] a THR run of the same entity and month simulates after the rapel run is locked, and the Coretax monthly export of the month works", async () => {
    const s = await seedScenario("thr");
    await simulatedAndApproved(s);
    const locked = await lockRun(s.runId);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);

    // A THR run of the same legal entity and month (needs a THR schedule).
    const thrRunId = randomUUID();
    const scheduleId = randomUUID();
    createdRuns.push(thrRunId);
    createdThrSchedules.push(scheduleId);
    await asTenant(async (conn) => {
      await conn.query(
        `INSERT INTO thr_schedules (id, tenant_id, legal_entity_id, name, holiday_name,
                                    holiday_date, tenure_as_of_date, pay_date, created_by)
         VALUES ($1, $2, $3, 'THR uji kunci rapel', 'Hari raya uji', '2026-07-28',
                 '2026-07-28', '2026-07-28', 'lock-rapel-test')`,
        [scheduleId, tenant.id, s.entityId],
      );
      await conn.query(
        `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                   period_start, period_end, pay_date, thr_schedule_id, created_by)
         VALUES ($1, $2, $3, $4, 'thr', '2026-07-01', '2026-07-31', '2026-07-28', $5, $6)`,
        [thrRunId, tenant.id, s.entityId, s.policyId, scheduleId, CREATOR],
      );
    });
    const simulated = await simulateRun(thrRunId);
    // Today the month basis cannot read a rapel slip: 422, not 200.
    expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);
    expect(simulated.body.data.status).toBe("simulated");

    // Coretax monthly withholding export of July: the locked rapel run only.
    stored.clear();
    const exported = await post(exporter, TAX_EXPORT_PATH, {
      legalEntityId: s.entityId,
      kind: "monthly_withholding",
      taxPeriod: "2026-07",
      idempotencyKey: key(),
    });
    expect(exported.status, JSON.stringify(exported.body)).toBe(201);
    const file = payrollTaxExportSchema.parse(exported.body.data);
    expect(file.status).toBe("ready");
    const texts = [...stored.values()].map((object) =>
      typeof object.content === "string"
        ? object.content
        : Buffer.from(object.content).toString("utf8"),
    );
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(s.person.nik);
  });

  it("[lock-rapel-finalize-refused] the rapel finalize step on a run locked by the general lock is 409 and pays nobody a second time", async () => {
    const s = await seedScenario("finalize");
    await simulatedAndApproved(s);
    const locked = await lockRun(s.runId);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    const before = await payslipsOf(s.runId);
    expect(before).toHaveLength(1);

    await expect(
      withTenant(db, context, (tx) =>
        finalizePayrollRapelRunInTransaction(tx, context, exporterUserId, {
          payrollRunId: s.runId as never,
          employeePlan: [
            {
              employeeId: s.person.id as never,
              payslipId: s.payslipId as never,
              paymentMethod: "bank_transfer",
            },
          ],
          expectedAllocationRevisions: { [s.person.id]: 1 },
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });

    const after = await payslipsOf(s.runId);
    expect(after).toHaveLength(1);
    expect(after[0]!.calculation).toEqual(before[0]!.calculation);
    expect(await countOf("payroll_rapel_finalizations", s.runId)).toBe(1);
  });

  // Independent of the simulate/lock path: the run is forced to `locked` by SQL
  // (as payroll-export-rapel.test.ts), then a v1 slip is inserted by the owner
  // connection with triggers active and no receipt in the transaction.
  it("[lock-rapel-v1-needs-receipt] a v1 full-calculation payslip carrying a RAPEL allocation, inserted with no receipt in the same transaction, is refused with 23514", async () => {
    const s = await seedScenario("v1guard");
    const gross = RAPEL_GROSS;
    const calculation = payslipCalculationSchema.parse({
      employeeId: s.person.id,
      employeeNo: `LR-${s.person.id.slice(0, 8).toUpperCase()}`,
      employeeName: s.person.name,
      positionName: "Staff",
      outletId: outlet.id,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      payDate: "2026-07-31",
      grossIdr: gross,
      deductionsIdr: 0,
      netIdr: gross,
      pph21Idr: 0,
      bpjsEmployeeIdr: 0,
      bpjsCompanyIdr: 0,
      serviceChargeIdr: 0,
      overtimeIdr: 0,
      lines: [
        {
          componentCode: s.componentCode,
          name: "Gaji pokok lock rapel",
          category: "base_salary",
          kind: "earning",
          amountIdr: 6_900_000,
          taxable: true,
          quantity: null,
          sourceId: null,
        },
        {
          componentCode: "RAPEL",
          name: "Rapel",
          category: "custom_earning",
          kind: "earning",
          amountIdr: RAPEL_AMOUNT,
          taxable: true,
          quantity: null,
          sourceId: s.rapelId,
        },
      ],
      bpjs: [],
      tax: {
        ...cafeLegendPayrollFixtures.payslips[0]!.tax,
        taxableGrossIdr: gross,
        pph21Idr: 0,
        pph21WithheldIdr: 0,
        pph21EmployerBorneIdr: 0,
        pph21RefundIdr: 0,
        pph21EmployerRefundIdr: 0,
        pph21EmployerAllowanceRefundIdr: 0,
        pph21ReceivableIdr: 0,
        taxAllowanceIdr: 0,
        grossSchemeBaseIdr: gross,
        employerSchemeBaseIdr: 0,
      },
      paymentMethod: "bank_transfer",
    });
    const totals = payrollRunTotalsSchema.parse({
      employeeCount: 1,
      grossIdr: gross,
      deductionsIdr: 0,
      netIdr: gross,
      bpjsEmployeeIdr: 0,
      bpjsCompanyIdr: 0,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
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
      bankTransferIdr: gross,
      cashIdr: 0,
    });
    const snapshot = payrollConfigSnapshotSchema.parse({
      statutoryVersions: PINNED.map((row) => ({
        type: row.type,
        versionId: row.id,
        version: row.version,
        effectiveFrom: PINNED_FROM,
      })),
      policy: {
        id: s.policyId,
        cycle: {
          frequency: "monthly",
          cutoffDay: null,
          payDay: null,
          payMonthOffset: 0,
        },
        payDateAdjustment: "none",
        jkkRiskClass: "low",
        bpjsProgrammes: [],
      },
      components: [
        {
          id: s.componentId,
          code: s.componentCode,
          category: "base_salary",
          taxable: true,
          taxScheme: "gross",
          bpjsBase: true,
          overtimeBase: true,
          thrBase: true,
        },
      ],
      loanMaxDeductionOfNetPayBp: 0,
      pph21Policy: null,
      capturedAt: "2026-07-31T00:00:00.000Z",
    });
    await asTenant(async (conn) => {
      for (const step of [
        `status = 'simulated'`,
        `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
        `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
      ])
        await conn.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
          s.runId,
        ]);
      await conn.query(
        `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
                totals = $2::jsonb, locked_by = 'lock-user', locked_at = now()
          WHERE id = $1`,
        [s.runId, JSON.stringify(totals), JSON.stringify(snapshot)],
      );
    });

    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      // Today: the insert succeeds (only envelope slips need a receipt).
      await expect(
        client.query(
          `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
             payment_method, calculation_encrypted, pii_key_version)
           VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
          [
            s.payslipId,
            tenant.id,
            s.runId,
            s.person.id,
            sealPayrollValue(JSON.stringify(calculation), {
              tenantId: tenant.id,
              table: "payslips",
              rowId: s.payslipId,
              field: "calculation",
            }),
            PAYROLL_SEAL_KEY_VERSION,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await countOf("payslips", s.runId)).toBe(0);
  });
});

describe("legend 1229 a Coretax export goes stale after a later lock or a reversal", () => {
  it("[tax-export-superseded] lock of a new run in the month, then its reversal, mark the earlier exports stale with an audit row; a stale replay is 409, an export made after the reversal replays", async () => {
    const s = await seedScenario("superseded");
    await simulatedAndApproved(s);
    const locked = await lockRun(s.runId);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    const exportJuly = (idempotencyKey: string) =>
      post(exporter, TAX_EXPORT_PATH, {
        legalEntityId: s.entityId,
        kind: "monthly_withholding",
        taxPeriod: "2026-07",
        idempotencyKey,
      });
    const exportRow = (id: string) =>
      asTenant(async (conn) => {
        const result = await conn.query<{
          superseded_at: Date | null;
          superseded_reason: string | null;
        }>(
          "SELECT superseded_at, superseded_reason FROM payroll_tax_exports WHERE id = $1",
          [id],
        );
        return result.rows[0]!;
      });
    const supersededAudits = (id: string) =>
      asTenant(async (conn) => {
        const result = await conn.query<{ text: string }>(
          `SELECT event::text AS text FROM audit_logs
            WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'
              AND event::text LIKE '%payroll.tax_export.superseded%'`,
          [tenant.id, id],
        );
        return result.rows;
      });
    const message =
      "Ekspor pajak bulan Juli 2026 sudah tidak sesuai. Buat ekspor baru dan lakukan pembetulan SPT bila sudah dilaporkan.";

    // Export A of July, before the THR run is locked.
    const keyA = key();
    const a = await exportJuly(keyA);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const fileA = payrollTaxExportSchema.parse(a.body.data);
    expect(fileA.supersededAt).toBeNull();

    // A THR run of the same entity and month is locked: A is stale.
    const thrRunId = randomUUID();
    const scheduleId = randomUUID();
    createdRuns.push(thrRunId);
    createdThrSchedules.push(scheduleId);
    await asTenant(async (conn) => {
      await conn.query(
        `INSERT INTO thr_schedules (id, tenant_id, legal_entity_id, name, holiday_name,
                                    holiday_date, tenure_as_of_date, pay_date, created_by)
         VALUES ($1, $2, $3, 'THR uji ekspor basi', 'Hari raya uji', '2026-07-28',
                 '2026-07-28', '2026-07-28', 'lock-rapel-test')`,
        [scheduleId, tenant.id, s.entityId],
      );
      await conn.query(
        `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                   period_start, period_end, pay_date, thr_schedule_id, created_by)
         VALUES ($1, $2, $3, $4, 'thr', '2026-07-01', '2026-07-31', '2026-07-28', $5, $6)`,
        [thrRunId, tenant.id, s.entityId, s.policyId, scheduleId, CREATOR],
      );
    });
    const simulated = await simulateRun(thrRunId);
    expect(simulated.status, JSON.stringify(simulated.body)).toBe(200);
    await approveBySql(thrRunId);
    const thrLocked = await lockRun(thrRunId);
    expect(thrLocked.status, JSON.stringify(thrLocked.body)).toBe(200);
    expect(thrLocked.body.data.taxExportsSuperseded).toEqual([
      expect.objectContaining({
        id: fileA.id,
        kind: "monthly_withholding",
        taxPeriod: "2026-07",
        message,
      }),
    ]);
    const rowA = await exportRow(fileA.id);
    expect(rowA.superseded_at).not.toBeNull();
    expect(rowA.superseded_reason).toBe("run_locked");
    expect(await supersededAudits(fileA.id)).toHaveLength(1);

    // A replay of the stale export gives no link.
    const replayA = await exportJuly(keyA);
    expect(replayA.status, JSON.stringify(replayA.body)).toBe(409);
    expect(replayA.body.error.code).toBe("PAYROLL_TAX_EXPORT_SUPERSEDED");
    expect(replayA.body.error.message).toBe(message);

    // Export B after the lock is current and replays.
    const keyB = key();
    const b = await exportJuly(keyB);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const fileB = payrollTaxExportSchema.parse(b.body.data);
    expect(fileB.supersededAt).toBeNull();
    expect((await exportJuly(keyB)).status).toBe(201);

    // The THR run is reversed (request + a second person approves): B is stale.
    const approver = await signedInClient("Lock rapel cancel approver");
    await grantRole(approver.userId, [
      "payroll.view",
      "payroll.cancel.approve",
    ]);
    const {
      requestPayrollRunReversalInTransaction,
      decidePayrollRunReversalInTransaction,
    } = await import("../services/payroll-run-reversal.service.ts");
    await withTenant(db, context, (tx) =>
      requestPayrollRunReversalInTransaction(
        tx,
        context,
        exporterUserId,
        thrRunId as never,
        "Salah hitung THR (uji ekspor basi)",
      ),
    );
    const reversed = await withTenant(db, context, (tx) =>
      decidePayrollRunReversalInTransaction(
        tx,
        context,
        approver.userId,
        thrRunId as never,
        "approve",
      ),
    );
    expect(reversed.status).toBe("reversed");
    expect(reversed.taxExportsSuperseded?.map((row) => row.id)).toEqual([
      fileB.id,
    ]);
    const rowB = await exportRow(fileB.id);
    expect(rowB.superseded_reason).toBe("run_reversed");
    expect(await supersededAudits(fileB.id)).toHaveLength(1);
    // A was already stale: not marked (or audited) twice.
    expect(await supersededAudits(fileA.id)).toHaveLength(1);
    expect((await exportJuly(keyB)).status).toBe(409);

    // Export C after the reversal is correct and replays (a reversed run
    // of the month alone no longer blocks the link).
    const keyC = key();
    const c = await exportJuly(keyC);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const replayC = await exportJuly(keyC);
    expect(replayC.status, JSON.stringify(replayC.body)).toBe(201);
    expect(replayC.body.data.supersededAt).toBeNull();
  });
});

describe("legend 1229 a Coretax export waits for a lock or reversal of its year", () => {
  it("[tax-export-year-lock] an export started while the run lock (or reversal) holds the year lock waits for it, then succeeds", async () => {
    const s = await seedScenario("year-lock");
    await simulatedAndApproved(s);
    const locked = await lockRun(s.runId);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);

    // The same advisory year lock `lockPayrollRunMonth` takes for a lock,
    // a reversal or a rapel finalize, held open by another transaction.
    const holder = await owner.connect();
    let settled = false;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`payroll-pph21-year:${tenant.id}:${s.entityId}:2026`],
      );
      const pending = post(exporter, TAX_EXPORT_PATH, {
        legalEntityId: s.entityId,
        kind: "monthly_withholding",
        taxPeriod: "2026-07",
        idempotencyKey: key(),
      }).then((response) => {
        settled = true;
        return response;
      });
      // Deterministic: the export backend is seen waiting on the advisory lock.
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const activity = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
              AND query ILIKE '%pg_advisory_xact_lock%'
              AND pid <> pg_backend_pid()`,
        );
        waiting = activity.rows[0]!.n > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      const exported = await pending;
      expect(exported.status, JSON.stringify(exported.body)).toBe(201);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
  });
});
