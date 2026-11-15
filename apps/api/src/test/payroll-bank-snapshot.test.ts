// Payroll bank snapshot at lock (bead legend-89cl7, brief
// docs/briefs/615-payroll-money-fixes-lead.md card A; founder rule "no outlet
// pays twice, no money goes to the wrong account"). Fail-first: written before
// the implementation.
//
// RULES UNDER TEST
//  1. When a run locks, the payee bank details (account number, holder name)
//     are frozen per bank_transfer payslip. The bank transfer file of that run
//     reads ONLY that snapshot: an HR edit of the employee's account (or
//     name) after the lock never changes the file.
//  2. A locked run that has no snapshot (a run locked before this change)
//     answers 422 PAYROLL_BANK_SNAPSHOT_MISSING with a clear Indonesian
//     message, never falls back to the employee's current account, writes no
//     file row and stores nothing.
//  3. No account number, holder name, NIK or NPWP in the server logs.
//
// ASSUMPTIONS (brief silent, stated so the engineer can contest them)
//  - There is no run lock route/service yet (payslips are only seeded in
//    tests, like payroll-bank-export.test.ts), so the lock-time step is driven
//    through `snapshotPayeeBankForLock(tx, tenantId, runId, payees)` of
//    services/payroll-bank-snapshot.service.ts, called inside `withTenant`
//    (the lock transaction) with the run's bank_transfer payslips.
//  - HR data has no account-holder field (HR PII route takes `bankAccount`
//    only), so the holder name is the employee's full name AT LOCK. Renaming
//    the employee after the lock must not change the bank file.
//  - The bank file layout is the one payroll-bank-export.test.ts assumes
//    (generic_csv: a data row holds the account number, the net pay as a plain
//    integer and the holder name; tests read cells, never header names).
//  - The snapshot is created from the CURRENT HR bank account at the moment the
//    helper runs (the lock transaction), for payslips whose payment_method is
//    bank_transfer.
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  PayrollError,
  bankTransferFileSchema,
  cafeLegendPayrollFixtures,
  payrollConfigSnapshotSchema,
  payrollRunTotalsSchema,
  payslipCalculationSchema,
  statutoryVersionRef,
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
  sealPayrollAmount,
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import { withTenant } from "../db/tenant.ts";
import { createBankTransferFile } from "../services/payroll-export.service.ts";
import { finalizePayrollRapelRunInTransaction } from "../services/payroll-rapel-finalize.service.ts";
import {
  openPayeeBankSnapshot,
  snapshotPayeeBankForLock,
} from "../services/payroll-bank-snapshot.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

// ---- App with a captured log stream and in-memory storage ----------------

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logLines.push(String(chunk));
    done();
  },
});

const stored = new Map<string, StorageRequest>();
const FAKE_STORE = "https://bank-snapshot-store.example.test/object";
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
    throw new Error("a payroll bank file must not use a public URL");
  },
};
const storageRuntime: StorageRuntime = {
  storage: fakeStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => null,
  hrisDocumentSigner: async () => null,
};
const storedKeysOf = (runId: string) =>
  [...stored.keys()].filter((storedKey) => storedKey.includes(runId));

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
const createdRuns: string[] = [];
const entityId = randomUUID();
const policyId = randomUUID();

const key = () => `bank-snapshot-${randomUUID()}`;

async function asTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenant.id, async (conn) => {
    await conn.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Bank snapshot ${roleId.slice(0, 8)}`,
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
let exporter: Client; // payroll.lock: may export
let exporterUserId: string; // the same user: finalizes runs (payroll.lock + payroll.run)
const createdComponents: string[] = [];
let hr: Client; // writes employee PII through the real route

// ---- Fixtures --------------------------------------------------------------

let counter = 0;
// A 3-digit counter first (no two values of one length can match), then random digits.
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};
const tag = randomUUID().slice(0, 8);

type Person = {
  id: string;
  name: string;
  account: string;
  nik: string;
  npwp: string;
  net: number;
};
const person = (label: string, net: number): Person => ({
  id: randomUUID(),
  name: `Snap ${label} ${tag}`,
  account: digits(12),
  nik: digits(16),
  npwp: digits(15),
  net,
});
const sensitive: string[] = []; // every value that must never reach a log

async function makeEmployee(p: Person) {
  createdEmployees.push(p.id);
  sensitive.push(p.name, p.account, p.nik, p.npwp);
  await asTenant(tenant.id, async (conn) => {
    await conn.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
      [
        p.id,
        tenant.id,
        `BS-${p.id.slice(0, 8).toUpperCase()}`,
        p.name,
        outlet.id,
        entityId,
      ],
    );
  });
  await putPii(p, p.account);
}

async function putPii(p: Person, bankAccount: string) {
  const put = await hr
    .put(`/api/hris/employees/${p.id}/pii`)
    .set(originHeader)
    .send({ nik: p.nik, npwp: p.npwp, bankAccount, idempotencyKey: key() });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

const day = (n: number) =>
  new Date(Date.UTC(2039, 0, 1 + n)).toISOString().slice(0, 10);

function calculation(p: Person, days: [string, string]) {
  return {
    employeeId: p.id,
    employeeNo: `BS-${p.id.slice(0, 8).toUpperCase()}`,
    employeeName: p.name,
    positionName: null,
    outletId: outlet.id,
    periodStart: days[0],
    periodEnd: days[1],
    payDate: days[1],
    grossIdr: p.net,
    deductionsIdr: 0,
    netIdr: p.net,
    pph21Idr: 0,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines: [
      {
        componentCode: "GAJI",
        name: "Gaji pokok",
        category: "base_salary",
        kind: "earning",
        amountIdr: p.net,
        taxable: true,
        quantity: null,
        sourceId: null,
      },
    ],
    bpjs: [],
    tax: {
      ptkpStatus: "TK/0",
      method: "ter",
      terCategory: null,
      terRateBp: null,
      taxableGrossIdr: p.net,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      taxAllowanceIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      grossSchemeBaseIdr: p.net,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: "bank_transfer",
  };
}

function totals(net: number) {
  return {
    employeeCount: 0,
    grossIdr: net,
    deductionsIdr: 0,
    netIdr: net,
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
    bankTransferIdr: net,
    cashIdr: 0,
  };
}

/** A locked run with one bank_transfer payslip per person, no snapshot yet. */
type SeededRun = {
  runId: string;
  payees: { payslipId: string; employeeId: string }[];
};
async function seedLockedRun(people: Person[]): Promise<SeededRun> {
  const runId = randomUUID();
  createdRuns.push(runId);
  const start = ++counter * 3;
  const days: [string, string] = [day(start), day(start + 1)];
  const net = people.reduce((sum, p) => sum + p.net, 0);
  const payees: SeededRun["payees"] = [];
  await asTenant(tenant.id, async (conn) => {
    await conn.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'bank-snapshot-test')`,
      [runId, tenant.id, entityId, policyId, ...days],
    );
    for (const step of [
      `status = 'simulated'`,
      `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
      `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
    ])
      await conn.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        runId,
      ]);
    await conn.query(
      `UPDATE payroll_runs SET status = 'locked', config_snapshot = '{"v":1}',
              totals = $2::jsonb, locked_by = 'lock-user', locked_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(totals(net))],
    );
    for (const p of people) {
      const id = randomUUID();
      payees.push({ payslipId: id, employeeId: p.id });
      await conn.query(
        `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                               calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
        [
          id,
          tenant.id,
          runId,
          p.id,
          sealPayrollValue(JSON.stringify(calculation(p, days)), {
            tenantId: tenant.id,
            table: "payslips",
            rowId: id,
            field: "calculation",
          }),
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
    }
  });
  return { runId, payees };
}

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenant.id,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

/** The lock-time step: freezes the payee bank details in one transaction. */
async function lockSnapshot(seeded: SeededRun): Promise<void> {
  await withTenant(db, context, (tx) =>
    snapshotPayeeBankForLock(tx, tenant.id, seeded.runId, seeded.payees),
  );
}

const RAPEL_ROOT = "/api/hris/payroll/rapel";
// Rapel may only be allocated to the NEXT regular draft run of the source legal
// entity, so every rapel scenario gets a legal entity and policy of its own
// (the shared one also holds the other tests' runs).
const rapelEntities: { entityId: string; policyId: string }[] = [];
let rapelHr: Client; // payroll.approve: first approver
let rapelFinance: Client; // payroll.approve + payroll.lock: second approver

const post = (client: Client, path: string, payload: object) =>
  client.post(path).set(originHeader).send(payload);

/**
 * A locked run that holds a real rapel allocation, like payroll-rapel.test.ts:
 * a locked June source run with the employee's payslip, a 6.000.000 -> 6.900.000
 * raise from 2026-06-16 (back pay 450.000), approved by HR then Finance and
 * allocated to the July target run, which is then locked without payslips for
 * the run writer (rapel finalization) to fill. Returns the reserved payslip id.
 */
async function seedRapelTarget(
  p: Person,
): Promise<{ runId: string; payslipId: string; gross: number }> {
  const gross = 7_350_000;
  const rapelEntityId = randomUUID();
  const rapelPolicyId = randomUUID();
  rapelEntities.push({ entityId: rapelEntityId, policyId: rapelPolicyId });
  const sourceRunId = randomUUID();
  const runId = randomUUID();
  const sourcePayslipId = randomUUID();
  createdRuns.push(sourceRunId, runId);
  const componentId = randomUUID();
  createdComponents.push(componentId);
  const amountId = randomUUID();
  const code = `BS_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
  const employeeNo = `BS-${p.id.slice(0, 8).toUpperCase()}`;
  const calculation = payslipCalculationSchema.parse({
    employeeId: p.id,
    employeeNo,
    employeeName: p.name,
    positionName: "Staff",
    outletId: outlet.id,
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    payDate: "2026-06-30",
    grossIdr: p.net,
    deductionsIdr: 0,
    netIdr: p.net,
    pph21Idr: 0,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines: [
      {
        componentCode: code,
        name: "Gaji pokok snapshot",
        category: "base_salary",
        kind: "earning",
        amountIdr: p.net,
        taxable: true,
        quantity: null,
        sourceId: null,
      },
    ],
    bpjs: [],
    tax: {
      ...cafeLegendPayrollFixtures.payslips[0]!.tax,
      taxableGrossIdr: p.net,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      pph21EmployerAllowanceRefundIdr: 0,
      pph21ReceivableIdr: 0,
      taxAllowanceIdr: 0,
      grossSchemeBaseIdr: p.net,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: "bank_transfer",
  });
  await asTenant(tenant.id, async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Bank Snapshot Rapel', false)`,
      [rapelEntityId, tenant.id],
    );
    await conn.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name,
         employee_group_code, employee_group, cycle, pay_date_adjustment,
         jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Rapel Snapshot', 'RS', '{"code":"RS"}',
          '{"frequency":"monthly","cutoffDay":null,"payDay":null,"payMonthOffset":0}', 'none', 'low', '[]')`,
      [rapelPolicyId, tenant.id, rapelEntityId],
    );
    // The raise history starts before the employee's source payslip, and the
    // employee belongs to the entity whose runs the rapel is allocated to.
    await conn.query(
      "UPDATE employees SET join_date = '2025-01-01', legal_entity_id = $2 WHERE id = $1",
      [p.id, rapelEntityId],
    );
    await conn.query(
      `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
         recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
       VALUES ($1, $2, $3, 'Gaji pokok snapshot', 'base_salary', 'earning',
         'fixed', true, 'gross', true, true, true)`,
      [componentId, tenant.id, code],
    );
    await conn.query(
      `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
         amount_encrypted, pii_key_version, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, '2025-01-01', $7)`,
      [
        amountId,
        tenant.id,
        p.id,
        componentId,
        sealPayrollAmount(idr(p.net), {
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
        [
          id,
          tenant.id,
          rapelEntityId,
          rapelPolicyId,
          start,
          end,
          exporterUserId,
        ],
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
        p.id,
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

  // The raise: create, approve (HR then Finance), allocate to the target run.
  const created = await post(exporter, RAPEL_ROOT, {
    employeeId: p.id,
    componentId,
    effectiveFrom: "2026-06-16",
    newAmountIdr: 6_900_000,
    idempotencyKey: key(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const rapelId = created.body.data.id as string;
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
  const payslipId = allocated.body.data.reservedPayslipId as string;

  // Lock the target run (no payslips yet).
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
    statutoryVersions: [
      statutoryVersionRef(
        cafeLegendPayrollFixtures.statutoryTables.find(
          (r) => r.type === "overtime",
        )!,
      ),
    ],
    policy: {
      id: rapelPolicyId,
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
        id: componentId,
        code,
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
  await asTenant(tenant.id, async (conn) => {
    for (const step of [
      `status = 'simulated'`,
      `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
      `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
    ])
      await conn.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [
        runId,
      ]);
    await conn.query(
      `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
              totals = $2::jsonb, locked_by = 'lock-user', locked_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(totals), JSON.stringify(snapshot)],
    );
  });
  return { runId, payslipId, gross };
}

// ---- CSV helpers (RFC 4180) -----------------------------------------------

function parseCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function downloadCsv(fileUrl: string): string {
  const url = new URL(fileUrl);
  expect(`${url.origin}${url.pathname}`).toBe(FAKE_STORE);
  const object = stored.get(url.searchParams.get("key")!);
  expect(object, "the exported object is in storage").toBeDefined();
  return typeof object!.content === "string"
    ? object!.content
    : Buffer.from(object!.content).toString("utf8");
}

// The legacy POST route is closed (legend-yjbjb: 409
// LEGACY_BANK_EXPORT_DISABLED, covered by payroll-payout-870-legacy-export), so
// the internal bank file builder is driven directly. The result keeps the old
// response shape ({ status, body, text }) so the assertions below are unchanged.
type ExportRunResult = {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: { data?: any; error?: { code: string; message: string } };
  text: string;
};

async function exportRun(
  runId: string,
  idempotencyKey: string = key(),
): Promise<ExportRunResult> {
  try {
    const data = await createBankTransferFile(
      context,
      exporterUserId,
      runId as never,
      { format: "generic_csv", idempotencyKey },
      storageRuntime,
    );
    const body = { data: JSON.parse(JSON.stringify(data)) };
    return { status: 201, body, text: JSON.stringify(body) };
  } catch (error) {
    if (!(error instanceof PayrollError || error instanceof HttpError))
      throw error;
    const body = { error: { code: error.code, message: error.message } };
    return { status: error.status, body, text: JSON.stringify(body) };
  }
}

async function exportOk(runId: string) {
  const response = await exportRun(runId);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const file = bankTransferFileSchema.parse(response.body.data);
  const text = downloadCsv(file.fileUrl);
  return { text, data: parseCsv(text).slice(1) };
}

const bankFileCount = (runId: string) =>
  asTenant(tenant.id, async (conn) =>
    Number(
      (
        await conn.query(
          "SELECT count(*)::int AS n FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenant.id, runId],
        )
      ).rows[0].n,
    ),
  );

// ---- Setup / teardown ---------------------------------------------------------

beforeAll(async () => {
  const lock = await signedInClient("Bank snapshot locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporter = lock.client;
  exporterUserId = lock.userId;
  const hrUser = await signedInClient("Bank snapshot HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const approverHr = await signedInClient("Bank snapshot rapel HR");
  await grantRole(approverHr.userId, ["payroll.view", "payroll.approve"]);
  rapelHr = approverHr.client;
  const approverFinance = await signedInClient("Bank snapshot rapel Finance");
  await grantRole(approverFinance.userId, [
    "payroll.view",
    "payroll.approve",
    "payroll.lock",
  ]);
  rapelFinance = approverFinance.client;

  await asTenant(tenant.id, async (conn) => {
    await conn.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Bank Snapshot', false)`,
      [entityId, tenant.id],
    );
    const code = `BS${policyId.slice(0, 8)}`;
    await conn.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Bank Snapshot', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenant.id, entityId, code, JSON.stringify({ code })],
    );
  });
});

afterAll(async () => {
  // The snapshot rows (new table) reference payslips: delete them first. The
  // table does not exist before the implementation, hence the try/catch.
  try {
    await asTenant(
      tenant.id,
      (conn) =>
        conn.query(
          "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
          [tenant.id, createdRuns],
        ),
      true,
    );
  } catch {
    /* table not created yet */
  }
  await asTenant(
    tenant.id,
    async (conn) => {
      await conn.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'bank-snapshot-%'",
        [tenant.id],
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
      await conn.query("DELETE FROM payroll_policies WHERE id = $1", [
        policyId,
      ]);
      await conn.query("DELETE FROM employees WHERE id = ANY($1)", [
        createdEmployees,
      ]);
      await conn.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
        rapelEntities.map((r) => r.policyId),
      ]);
      await conn.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
        [entityId, ...rapelEntities.map((r) => r.entityId)],
      ]);
      await conn.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant.id, createdUsers],
      );
      await conn.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant.id, createdRoles],
      );
    },
    true,
  );
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- Tests --------------------------------------------------------------------

describe("bank transfer file reads the snapshot taken at lock", () => {
  it("[snapshot-keeps-old-account] an account and name changed after the lock do not change the bank file", async () => {
    const changed = person("Changed", 4_250_000);
    const steady = person("Steady", 3_100_500);
    await makeEmployee(changed);
    await makeEmployee(steady);
    const seeded = await seedLockedRun([changed, steady]);
    const { runId } = seeded;

    // Lock transaction: the payee bank details are frozen here.
    await lockSnapshot(seeded);

    // HR then moves the account and renames the employee.
    const newAccount = digits(12);
    const newName = `Snap Renamed ${tag}`;
    sensitive.push(newAccount, newName);
    await putPii(changed, newAccount);
    await asTenant(tenant.id, (conn) =>
      conn.query("UPDATE employees SET full_name = $2 WHERE id = $1", [
        changed.id,
        newName,
      ]),
    );

    const { text, data } = await exportOk(runId);

    // The changed employee is paid to the OLD account under the OLD holder name.
    const oldRow = data.find((row) => row.includes(changed.account));
    expect(oldRow, "old account is in the file").toBeDefined();
    expect(oldRow).toContain(changed.name);
    expect(oldRow).toContain(String(changed.net));
    // Neither the new account nor the new name appears anywhere in the file.
    expect(text).not.toContain(newAccount);
    expect(text).not.toContain(newName);
    // The unchanged employee is unaffected and nobody is paid twice.
    const steadyRow = data.find((row) => row.includes(steady.account));
    expect(steadyRow).toContain(steady.name);
    expect(steadyRow).toContain(String(steady.net));
    expect(data).toHaveLength(2);
  });
});

describe("a run locked before the snapshot existed", () => {
  it("[snapshot-missing] answers 422 PAYROLL_BANK_SNAPSHOT_MISSING in Indonesian, never uses the current account, writes nothing", async () => {
    const old = person("Old run", 5_000_001);
    await makeEmployee(old);
    const { runId } = await seedLockedRun([old]); // locked, no snapshot

    const response = await exportRun(runId);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_BANK_SNAPSHOT_MISSING");
    const message = String(response.body.error?.message ?? "");
    expect(message.length).toBeGreaterThan(10);
    // Clear Indonesian text: not an English or empty fallback.
    expect(message).toMatch(
      /rekening|bank|payroll|gaji|dikunci|snapshot|transfer/i,
    );
    // The refusal never echoes the current account or the name.
    expect(response.text).not.toContain(old.account);
    expect(response.text).not.toContain(old.name);
    expect(await bankFileCount(runId)).toBe(0);
    expect(storedKeysOf(runId)).toEqual([]);
  });

  it("[snapshot-missing-after-edit] changing the account of an old run's employee still never yields a file", async () => {
    const old = person("Old edited", 2_222_222);
    await makeEmployee(old);
    const { runId } = await seedLockedRun([old]);
    const newAccount = digits(12);
    sensitive.push(newAccount);
    await putPii(old, newAccount);

    const response = await exportRun(runId);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_BANK_SNAPSHOT_MISSING");
    expect(response.text).not.toContain(newAccount);
    expect(await bankFileCount(runId)).toBe(0);
    expect(storedKeysOf(runId)).toEqual([]);
  });
});

describe("rapel finalization is a lock path too", () => {
  it("[snapshot-rapel-finalize] finalizing a locked run writes the bank snapshot, and a later account change does not touch it", async () => {
    const p = person("Finalized", 6_000_000);
    await makeEmployee(p);
    const { runId, payslipId } = await seedRapelTarget(p);

    const readSnapshots = () =>
      asTenant(tenant.id, async (conn) => {
        const res = await conn.query(
          `SELECT id, tenant_id, snapshot_encrypted, pii_key_version
             FROM payslip_bank_snapshots
            WHERE tenant_id = $1 AND payslip_id = $2`,
          [tenant.id, payslipId],
        );
        return res.rows.map((row) =>
          openPayeeBankSnapshot({
            id: row.id,
            tenantId: row.tenant_id,
            snapshotEncrypted: row.snapshot_encrypted,
            piiKeyVersion: row.pii_key_version,
          }),
        );
      });
    expect(await readSnapshots(), "nothing is frozen before finalize").toEqual(
      [],
    );

    // The run writer inserts the payslips of the locked run (and, with this
    // change, freezes the payee bank details in the same transaction).
    await withTenant(db, context, (tx) =>
      finalizePayrollRapelRunInTransaction(tx, context, exporterUserId, {
        payrollRunId: runId as never,
        employeePlan: [
          {
            employeeId: p.id as never,
            payslipId: payslipId as never,
            paymentMethod: "bank_transfer",
          },
        ],
        expectedAllocationRevisions: { [p.id]: 1 },
      }),
    );

    // Rapel finalization seals a gross envelope (payrollGrossEnvelopeSchema),
    // not a full payslipCalculationSchema. The bank transfer export now reads
    // these payslips through openRapelFinalizedPayslip (design §5); the
    // [rapel-bank-export] tests cover the file itself. This test checks the
    // stored snapshot itself.
    const frozen = await readSnapshots();
    expect(
      frozen,
      "exactly one snapshot for the reserved payslip",
    ).toHaveLength(1);
    expect(frozen[0]).toMatchObject({
      accountNumber: p.account,
      accountHolder: p.name,
    });

    // HR moves the account after the run was finalized.
    const newAccount = digits(12);
    sensitive.push(newAccount);
    await putPii(p, newAccount);

    const after = await readSnapshots();
    expect(after, "still exactly one snapshot").toHaveLength(1);
    expect(after[0]).toEqual(frozen[0]);
    expect(after[0]!.accountNumber).not.toBe(newAccount);
  });
});

describe("no PII in logs", () => {
  it("[snapshot-no-pii-in-logs] account numbers, holder names, NIK and NPWP never reach a log line", async () => {
    // One more full cycle so this test fails first on its own too.
    const p = person("Logged", 1_000_000);
    await makeEmployee(p);
    const seeded = await seedLockedRun([p]);
    const { runId } = seeded;
    await lockSnapshot(seeded);
    const ok = await exportOk(runId);
    expect(ok.data.some((row) => row.includes(p.account))).toBe(true);

    const joined = logLines.join("\n");
    expect(joined.length, "the app logged the requests").toBeGreaterThan(0);
    for (const value of sensitive)
      expect(joined, `log contains a sensitive value`).not.toContain(value);
  });
});
