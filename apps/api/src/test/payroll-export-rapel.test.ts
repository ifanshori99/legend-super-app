// Bank transfer export of a rapel-finalized run (bead legend-yod9z, brief
// docs/briefs/sub-payroll-run-lock.md card 2; PRD PAYR-04; founder rule "no
// employee paid more, outlet never loses"). Fail-first: written before the fix.
//
// RULES UNDER TEST
//  1. A run whose payslips were written by rapel finalization (sealed as a gross
//     envelope, not a full payslip calculation) can be exported: 201, not 422
//     PAYROLL_PAYSLIP_UNREADABLE.
//  2. PAYR-04: the file holds exactly the run's bank_transfer payslips with net
//     > 0; its total (response totalIdr AND the sum of the file rows) equals the
//     run's total transfer (payroll_runs.totals.bankTransferIdr). Nobody is paid
//     more than their net.
//  3. The account paid is the snapshot frozen at finalize, not an account HR
//     changed afterwards.
//
// WORKED NUMBERS (by hand): employee base 6.000.000 -> 6.900.000 from 2026-06-16
// of a June month: back pay 450.000, so the July rapel run pays 6.900.000 +
// 450.000 = 7.350.000. No tax (pph21 0, TK/0 bracket not reached in the seed),
// so net = gross = 7.350.000 = run totals.bankTransferIdr.
//
// ASSUMPTIONS (brief silent):
//  - The rapel envelope's net equals gross here (no deductions), so the bank
//    row must be exactly 7.350.000.
//  - Fixtures are those of payroll-bank-snapshot.test.ts (seedRapelTarget).
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

const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenant.id,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

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

// ---- Tests --------------------------------------------------------------------

/** Finalize the locked rapel target run: writes its payslips (gross envelope). */
async function finalizeRapelRun(
  p: Person,
  seeded: { runId: string; payslipId: string },
) {
  await withTenant(db, context, (tx) =>
    finalizePayrollRapelRunInTransaction(tx, context, exporterUserId, {
      payrollRunId: seeded.runId as never,
      employeePlan: [
        {
          employeeId: p.id as never,
          payslipId: seeded.payslipId as never,
          paymentMethod: "bank_transfer",
        },
      ],
      expectedAllocationRevisions: { [p.id]: 1 },
    }),
  );
}

const runBankTotal = (runId: string) =>
  asTenant(tenant.id, async (conn) =>
    Number(
      (
        await conn.query(
          "SELECT (totals->>'bankTransferIdr')::bigint AS total FROM payroll_runs WHERE tenant_id = $1 AND id = $2",
          [tenant.id, runId],
        )
      ).rows[0].total,
    ),
  );

describe("bank transfer export of a rapel-finalized run", () => {
  it("[rapel-export-total-equals-run-transfer] exports with 201; the file total and the sum of its rows equal the run total transfer, and the payee is paid exactly the net", async () => {
    const p = person("Rapel export", 6_000_000);
    await makeEmployee(p);
    const seeded = await seedRapelTarget(p);
    await finalizeRapelRun(p, seeded);

    const response = await exportRun(seeded.runId);
    // Today: 422 PAYROLL_PAYSLIP_UNREADABLE (envelope is not a full calculation).
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const file = bankTransferFileSchema.parse(response.body.data);
    const runTotal = await runBankTotal(seeded.runId);
    expect(runTotal).toBe(seeded.gross);
    expect(file.totalIdr).toBe(runTotal);
    expect(file.rowCount).toBe(1);

    const rows = parseCsv(downloadCsv(file.fileUrl)).slice(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toContain(p.account);
    // Never more than the net: the single row carries exactly 7.350.000.
    expect(row).toContain(String(seeded.gross));
    expect(row.filter((cell) => cell === String(seeded.gross))).toHaveLength(1);
    expect(await bankFileCount(seeded.runId)).toBe(1);
  });

  it("[rapel-export-pays-snapshot-account] an account changed after the rapel run was finalized does not change the file, and the payee is still paid no more than the net", async () => {
    const p = person("Rapel moved", 6_000_000);
    await makeEmployee(p);
    const seeded = await seedRapelTarget(p);
    await finalizeRapelRun(p, seeded);

    const newAccount = digits(12);
    sensitive.push(newAccount);
    await putPii(p, newAccount);

    const { text, data } = await exportOk(seeded.runId);
    expect(data).toHaveLength(1);
    expect(data[0]).toContain(p.account);
    expect(text).not.toContain(newAccount);
    expect(
      data[0]!.filter((cell) => cell === String(seeded.gross)),
    ).toHaveLength(1);
    const total = data.reduce(
      (sum, row) =>
        sum + Number(row.find((cell) => cell === String(seeded.gross)) ?? 0),
      0,
    );
    expect(total).toBe(await runBankTotal(seeded.runId));
  });

  // Design §6 test 4 negative case. ASSUMPTIONS: the run is finalized normally
  // (the DB insert guard refuses an envelope slip without a receipt), then the
  // receipt row is removed with the owner connection (triggers bypassed). The
  // slip is readable but nothing authorizes paying it: 409
  // PAYROLL_BANK_FILE_MISMATCH (not 422 unreadable), and no file row.
  it("[rapel-export-no-receipt-refused] a readable envelope payslip in a locked run with no finalization receipt is refused with 409 PAYROLL_BANK_FILE_MISMATCH and creates no file", async () => {
    const p = person("Rapel no receipt", 6_000_000);
    await makeEmployee(p);
    const seeded = await seedRapelTarget(p);
    // The DB guard (app.payroll_rapel_payslip_insert_guard) refuses an envelope
    // slip without a receipt, so finalize normally and then remove the receipt
    // with the owner connection (triggers bypassed), as a tampering would.
    await finalizeRapelRun(p, seeded);
    await asTenant(
      tenant.id,
      (conn) =>
        conn.query(
          "DELETE FROM payroll_rapel_finalizations WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenant.id, seeded.runId],
        ),
      true,
    );

    const response = await exportRun(seeded.runId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.error?.code).toBe("PAYROLL_BANK_FILE_MISMATCH");
    expect(await bankFileCount(seeded.runId)).toBe(0);
  });
});
