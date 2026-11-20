// legend-svqew / founder Q43-Q44: explicit back-pay, frozen history and no overpayment.
// The HTTP contract is agreed with the rapel implementer before implementation.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The worker needs the next test key available while normal writes stay on key1.
const priorKeyConfiguration = vi.hoisted(() => {
  const previous = process.env.HRIS_PII_KEYS;
  process.env.HRIS_PII_KEYS = `2:${Buffer.alloc(32, 9).toString("base64")}`;
  return previous;
});

import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { employeeIdSchema } from "@starter/shared/hris";
import {
  cafeLegendPayrollFixtures,
  payComponentIdSchema,
  payrollConfigSnapshotSchema,
  payrollRunIdSchema,
  payrollRunTotalsSchema,
  payslipCalculationSchema,
  statutoryVersionRef,
} from "@starter/shared/hris/payroll";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  HRIS_PII_KEY_VERSION,
  hrisBlindIndex,
  normalizeHrisPii,
  sealHrisPii,
} from "../lib/hris-pii.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollAmount,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { computeEmployeeGross } from "../services/payroll-components.service.ts";
import { finalizePayrollRapelRunInTransaction } from "../services/payroll-rapel-finalize.service.ts";
import {
  allocatePayrollRapel,
  approvePayrollRapel,
  createPayrollRapel,
  getPayrollRapel,
} from "../services/payroll-rapel.service.ts";
import { runHrisPiiReseal } from "../worker/hris-pii-reseal.job.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const root = "/api/hris/payroll/rapel";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
const key = () => `rapel-549-${randomUUID()}`;
type Client = ReturnType<typeof agent>;
type Actor = { client: Client; id: string };
type Seed = {
  employeeId: string;
  componentId: string;
  componentCode: string;
  amountId: string;
  sourceRunId: string;
  targetRunId: string;
  sourcePayslipId: string;
  policyId: string;
  entityId: string;
};
type Rapel = {
  id: string;
  totalIdr: number;
  status: string;
  payrollRunId: string | null;
  reservedPayslipId: string | null;
  approvedByHr: string | null;
  approvedByFinance: string | null;
  items: { sourceRunId: string; amountIdr: number }[];
};
const seeds: Seed[] = [];
const users: string[] = [];
const roles: string[] = [];
const privateOutlets = new Map<string, string>();
const transferEntities: string[] = [];
let requester: Actor;
let hr: Actor;
let finance: Actor;
let finalizer: Actor;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
  scopedTenantId = tenantId,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [scopedTenantId],
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

async function actor(name: string, permissions: string[]): Promise<Actor> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  users.push(id);
  const roleId = randomUUID();
  roles.push(roleId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [roleId, tenantId, `Rapel ${roleId}`, JSON.stringify(permissions)],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenantId, id, roleId],
    );
  });
  return { client, id };
}

async function seed(
  joinDate = "2025-01-01",
  sourcePaidIdr = 6_000_000,
  envelope:
    | "full"
    | "legacy"
    | "pinned_gross"
    | "mismatched_pinned_gross"
    | "malformed_full" = "full",
  partitionedHistory = false,
  scope = { tenantId, outletId },
): Promise<Seed> {
  const { tenantId, outletId } = scope;
  const s: Seed = {
    employeeId: randomUUID(),
    componentId: randomUUID(),
    componentCode: `RP_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
    amountId: randomUUID(),
    sourceRunId: randomUUID(),
    targetRunId: randomUUID(),
    sourcePayslipId: randomUUID(),
    policyId: randomUUID(),
    entityId: randomUUID(),
  };
  seeds.push(s);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
       VALUES ($1, $2, 'PT Rapel 549', false)`,
      [s.entityId, tenantId],
    );
    // Locking a run now freezes the payee bank account (legend-89cl7, fail
    // closed when it is missing): every bank_transfer employee has one.
    const bankAccount = normalizeHrisPii(
      "bankAccount",
      `${Math.floor(1e11 + Math.random() * 9e11)}`,
    );
    await db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
         legal_entity_id, employment_type, join_date, status,
         bank_account_encrypted, bank_account_hmac, pii_key_version)
       VALUES ($1, $2, $3, 'Karyawan Rapel', $4, $5, 'pkwtt', $6, 'active', $7, $8, $9)`,
      [
        s.employeeId,
        tenantId,
        `RP-${s.employeeId.slice(0, 8).toUpperCase()}`,
        outletId,
        s.entityId,
        joinDate,
        sealHrisPii(
          bankAccount,
          {
            tenantId,
            table: "employees",
            rowId: s.employeeId,
            field: "bankAccount",
          },
          HRIS_PII_KEY_VERSION,
        ),
        hrisBlindIndex("bankAccount", tenantId, bankAccount),
        HRIS_PII_KEY_VERSION,
      ],
    );
    await db.query(
      `INSERT INTO pay_components (id, tenant_id, code, name, category, kind,
         recurrence, taxable, tax_scheme, bpjs_base, overtime_base, thr_base)
       VALUES ($1, $2, $3, 'Gaji pokok rapel', 'base_salary', 'earning',
         'fixed', true, 'gross', true, true, true)`,
      [s.componentId, tenantId, s.componentCode],
    );
    await db.query(
      `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
         amount_encrypted, pii_key_version, effective_from, created_by, effective_to)
       VALUES ($1, $2, $3, $4, $5, $6, '2025-01-01', $7, $8::date)`,
      [
        s.amountId,
        tenantId,
        s.employeeId,
        s.componentId,
        sealPayrollAmount(idr(partitionedHistory ? 6_000_001 : 6_000_000), {
          tenantId,
          table: "employee_pay_components",
          rowId: s.amountId,
          field: "amount",
        }),
        PAYROLL_SEAL_KEY_VERSION,
        requester.id,
        partitionedHistory ? "2026-06-03" : null,
      ],
    );
    if (partitionedHistory)
      for (const [from, to, nominal] of [
        ["2026-06-04", "2026-06-06", 6_000_001],
        ["2026-06-07", null, 6_000_000],
      ] as const) {
        const rowId = randomUUID();
        await db.query(
          `INSERT INTO employee_pay_components (id, tenant_id, employee_id, component_id,
             amount_encrypted, pii_key_version, effective_from, created_by, effective_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9::date)`,
          [
            rowId,
            tenantId,
            s.employeeId,
            s.componentId,
            sealPayrollAmount(idr(nominal), {
              tenantId,
              table: "employee_pay_components",
              rowId,
              field: "amount",
            }),
            PAYROLL_SEAL_KEY_VERSION,
            from,
            requester.id,
            to,
          ],
        );
      }
    await db.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name,
         employee_group_code, employee_group, cycle, pay_date_adjustment,
         jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Rapel', 'RP', '{"code":"RP"}',
          '{"frequency":"monthly","cutoffDay":null,"payDay":null,"payMonthOffset":0}', 'none', 'low', '[]')`,
      [s.policyId, tenantId, s.entityId],
    );
    for (const [runId, start, end] of [
      [s.sourceRunId, "2026-06-01", "2026-06-30"],
      [s.targetRunId, "2026-07-01", "2026-07-31"],
    ]) {
      await db.query(
        `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id,
           run_type, period_start, period_end, pay_date, created_by)
         VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, $7)`,
        [runId, tenantId, s.entityId, s.policyId, start, end, requester.id],
      );
    }
    for (const update of [
      "status = 'simulated'",
      "status = 'hr_approved', approved_by_hr = $2, approved_by_hr_at = now()",
      "status = 'approved', approved_by_finance = $2, approved_by_finance_at = now()",
      "status = 'locked', config_snapshot = '{\"v\":1}', totals = '{\"t\":1}', locked_by = $2, locked_at = now()",
    ]) {
      const args = update.includes("$2")
        ? [s.sourceRunId, update.includes("finance") ? finance.id : hr.id]
        : [s.sourceRunId];
      await db.query(`UPDATE payroll_runs SET ${update} WHERE id = $1`, args);
    }
    const calculation = payslipCalculationSchema.parse({
      employeeId: s.employeeId,
      employeeNo: `RP-${s.employeeId.slice(0, 8).toUpperCase()}`,
      employeeName: "Karyawan Rapel",
      positionName: "Staff",
      outletId,
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      payDate: "2026-06-30",
      grossIdr: sourcePaidIdr,
      deductionsIdr: 0,
      netIdr: sourcePaidIdr,
      pph21Idr: 0,
      bpjsEmployeeIdr: 0,
      bpjsCompanyIdr: 0,
      serviceChargeIdr: 0,
      overtimeIdr: 0,
      lines: [
        {
          componentCode: s.componentCode,
          name: "Gaji pokok rapel",
          category: "base_salary",
          kind: "earning",
          amountIdr: sourcePaidIdr,
          taxable: true,
          quantity: null,
          sourceId: null,
        },
      ],
      bpjs: [],
      tax: {
        ...cafeLegendPayrollFixtures.payslips[0]!.tax,
        taxableGrossIdr: sourcePaidIdr,
        pph21Idr: 0,
        pph21WithheldIdr: 0,
        pph21EmployerBorneIdr: 0,
        pph21RefundIdr: 0,
        pph21EmployerRefundIdr: 0,
        pph21EmployerAllowanceRefundIdr: 0,
        pph21ReceivableIdr: 0,
        taxAllowanceIdr: 0,
        grossSchemeBaseIdr: sourcePaidIdr,
        employerSchemeBaseIdr: 0,
      },
      paymentMethod: "bank_transfer",
    });
    const oldGross = {
      grossIdr: calculation.grossIdr,
      deductionsIdr: calculation.deductionsIdr,
      netIdr: calculation.netIdr,
      overtimeIdr: calculation.overtimeIdr,
      lines: calculation.lines,
    };
    const sourceEnvelope =
      envelope === "legacy"
        ? oldGross
        : envelope === "pinned_gross" || envelope === "mismatched_pinned_gross"
          ? {
              ...oldGross,
              payrollRunId:
                envelope === "pinned_gross" ? s.sourceRunId : randomUUID(),
            }
          : envelope === "malformed_full"
            ? { ...calculation, employeeId: "not-an-employee-id" }
            : calculation;
    await db.query(
      `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
         payment_method, calculation_encrypted, pii_key_version)
       VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
      [
        s.sourcePayslipId,
        tenantId,
        s.sourceRunId,
        s.employeeId,
        sealPayrollValue(JSON.stringify(sourceEnvelope), {
          tenantId,
          table: "payslips",
          rowId: s.sourcePayslipId,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    );
  }, tenantId);
  return s;
}

const body = (s: Seed, amount = 6_900_000, effectiveFrom = "2026-06-16") => ({
  employeeId: s.employeeId,
  componentId: s.componentId,
  effectiveFrom,
  newAmountIdr: amount,
  idempotencyKey: key(),
});
const post = (client: Client, path: string, payload: object) =>
  client.post(path).set(originHeader).send(payload);
async function create(
  s: Seed,
  amount = 6_900_000,
  from = "2026-06-16",
): Promise<Rapel> {
  const res = await post(requester.client, root, body(s, amount, from));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Rapel;
}
async function approve(id: string) {
  const h = await post(hr.client, `${root}/${id}/approve-hr`, {
    idempotencyKey: key(),
  });
  expect(h.status, JSON.stringify(h.body)).toBe(200);
  const f = await post(finance.client, `${root}/${id}/approve-finance`, {
    idempotencyKey: key(),
  });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
}
async function allocate(s: Seed, id: string) {
  const res = await post(requester.client, `${root}/${id}/allocate`, {
    payrollRunId: s.targetRunId,
    idempotencyKey: key(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Rapel;
}
async function frozenSnapshot(s: Seed) {
  return asTenant(async (db) => {
    const r = await db.query(
      "SELECT to_jsonb(r) AS value FROM payroll_runs r WHERE id = $1",
      [s.sourceRunId],
    );
    const p = await db.query(
      "SELECT encode(calculation_encrypted, 'hex') AS value FROM payslips WHERE id = $1",
      [s.sourcePayslipId],
    );
    const c = await db.query(
      "SELECT encode(amount_encrypted, 'hex') AS value, effective_from::text, effective_to::text FROM employee_pay_components WHERE id = $1",
      [s.amountId],
    );
    return { run: r.rows, payslip: p.rows, salary: c.rows };
  });
}

function supportedTotals(grossIdr: number, employeeCount = 1) {
  return payrollRunTotalsSchema.parse({
    employeeCount,
    grossIdr,
    deductionsIdr: 0,
    netIdr: grossIdr,
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
    bankTransferIdr: grossIdr,
    cashIdr: 0,
  });
}

async function lockTarget(
  s: Seed,
  grossIdr = 7_350_000,
  employees = [s],
  totalOverrides: Record<string, number> = {},
  scopedTenantId = tenantId,
) {
  const totals = payrollRunTotalsSchema.parse({
    ...supportedTotals(grossIdr, employees.length),
    ...totalOverrides,
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
    components: employees.map((employee) => ({
      id: employee.componentId,
      code: employee.componentCode,
      category: "base_salary",
      taxable: true,
      taxScheme: "gross",
      bpjsBase: true,
      overtimeBase: true,
      thrBase: true,
    })),
    loanMaxDeductionOfNetPayBp: 0,
    pph21Policy: null,
    capturedAt: "2026-07-31T00:00:00.000Z",
  });
  await asTenant(async (db) => {
    for (const update of [
      "status = 'simulated'",
      "status = 'hr_approved', approved_by_hr = $2, approved_by_hr_at = now()",
      "status = 'approved', approved_by_finance = $2, approved_by_finance_at = now()",
    ]) {
      await db.query(
        `UPDATE payroll_runs SET ${update} WHERE id = $1`,
        update.includes("$2")
          ? [s.targetRunId, update.includes("finance") ? finance.id : hr.id]
          : [s.targetRunId],
      );
    }
    await db.query(
      `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3, totals = $4,
       locked_by = $2, locked_at = now() WHERE id = $1`,
      [s.targetRunId, hr.id, JSON.stringify(snapshot), JSON.stringify(totals)],
    );
  }, scopedTenantId);
}

const preview = (s: Seed, payslipId: string, runId = s.targetRunId) =>
  computeEmployeeGross(context, requester.id, {
    employeeId: s.employeeId,
    payslipId,
    payrollRunId: runId,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    overtimeParameters: cafeLegendPayrollFixtures.statutoryTables.find(
      (r) => r.type === "overtime",
    )!.parameters,
  } as never);

type EmployeePlan = {
  employeeId: string;
  payslipId: string;
  paymentMethod: "bank_transfer";
};
const finalize = (
  s: Seed,
  payslipId: string,
  expectedRevision?: number,
  additionalPlan: EmployeePlan[] = [],
) =>
  withTenant(db, context, (tx) =>
    finalizePayrollRapelRunInTransaction(tx, context, finalizer.id, {
      payrollRunId: s.targetRunId,
      employeePlan: [
        { employeeId: s.employeeId, payslipId, paymentMethod: "bank_transfer" },
        ...additionalPlan,
      ],
      ...(expectedRevision === undefined
        ? {}
        : {
            expectedAllocationRevisions: {
              [s.employeeId]: expectedRevision,
              ...Object.fromEntries(
                additionalPlan.map((employee) => [employee.employeeId, 0]),
              ),
            },
          }),
    }),
  );

async function storedPayslip(
  s: Seed,
  payslipId: string,
  scopedTenantId = tenantId,
) {
  const tenantId = scopedTenantId;
  return asTenant(async (db) => {
    const result = await db.query<{
      id: string;
      payroll_run_id: string;
      employee_id: string;
      calculation_encrypted: Buffer;
      pii_key_version: number;
    }>(
      `SELECT id, payroll_run_id, employee_id, calculation_encrypted, pii_key_version
       FROM payslips WHERE tenant_id = $1 AND id = $2`,
      [tenantId, payslipId],
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    const calculation = JSON.parse(
      openPayrollValue(
        row.calculation_encrypted,
        { tenantId, table: "payslips", rowId: payslipId, field: "calculation" },
        row.pii_key_version,
      ),
    ) as {
      grossIdr: number;
      deductionsIdr: number;
      netIdr: number;
      lines: {
        sourceId?: string;
        componentCode: string;
        amountIdr: number;
      }[];
    };
    const count = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3",
      [tenantId, s.targetRunId, s.employeeId],
    );
    return { row, calculation, count: count.rows[0]!.count };
  }, scopedTenantId);
}

async function attachPrivateOutlet(s: Seed) {
  const id = randomUUID();
  privateOutlets.set(s.employeeId, id);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code,
         name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, $2, $3, 'Outlet Rapel Transfer', address,
         timezone, opening_hours, status FROM outlets WHERE id = $4 AND tenant_id = $5`,
      [
        id,
        s.entityId,
        `RP-${id.slice(0, 8).toUpperCase()}`,
        outletId,
        tenantId,
      ],
    );
    await db.query("UPDATE employees SET home_outlet_id = $1 WHERE id = $2", [
      id,
      s.employeeId,
    ]);
  });
}

async function transferToNewEntity(s: Seed): Promise<string> {
  const entityId = randomUUID();
  const policyId = randomUUID();
  const runId = randomUUID();
  transferEntities.push(entityId);
  await asTenant(async (db) => {
    await db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
       VALUES ($1, $2, 'PT Rapel Transfer B', false)`,
      [entityId, tenantId],
    );
    await db.query("UPDATE employees SET legal_entity_id = $1 WHERE id = $2", [
      entityId,
      s.employeeId,
    ]);
    await db.query("UPDATE outlets SET legal_entity_id = $1 WHERE id = $2", [
      entityId,
      privateOutlets.get(s.employeeId),
    ]);
    await db.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name,
         employee_group_code, employee_group, cycle, pay_date_adjustment,
         jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Transfer B', 'RP', '{"code":"RP"}',
         '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenantId, entityId],
    );
    await db.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id,
         run_type, period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', '2026-07-01', '2026-07-31', '2026-07-31', $5)`,
      [runId, tenantId, entityId, policyId, requester.id],
    );
  });
  return runId;
}

async function reverseOrRefuse(runId: string): Promise<boolean> {
  return asTenant(async (db) => {
    await db.query("SAVEPOINT reverse_run");
    try {
      await db.query(
        `UPDATE payroll_runs SET status = 'reversed', reversal = '{"status":"approved"}'
         WHERE id = $1`,
        [runId],
      );
      return true;
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT reverse_run");
      expect(error).toMatchObject({ code: "23514" });
      return false;
    }
  });
}

beforeAll(async () => {
  requester = await actor("Rapel requester 549", [
    "payroll.view",
    "payroll.run",
  ]);
  hr = await actor("Rapel HR 549", ["payroll.view", "payroll.approve"]);
  finance = await actor("Rapel Finance 549", [
    "payroll.view",
    "payroll.approve",
    "payroll.lock",
  ]);
  finalizer = await actor("Rapel finalizer G688h", [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
  ]);
});

afterAll(async () => {
  const db = await owner.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    // A missing ledger is expected during RED; cleanup only this file's employees.
    const table = await db.query<{ name: string | null }>(
      "SELECT to_regclass('public.payroll_rapels')::text AS name",
    );
    if (table.rows[0]?.name) {
      const employeeIds = seeds.map((s) => s.employeeId);
      const receipts = await db.query<{ name: string | null }>(
        "SELECT to_regclass('public.payroll_rapel_finalizations')::text AS name",
      );
      if (receipts.rows[0]?.name) {
        await db.query(
          "DELETE FROM payroll_rapel_finalizations WHERE tenant_id = $1 AND employee_id = ANY($2)",
          [tenantId, employeeIds],
        );
      }
      await db.query(
        `DELETE FROM payroll_rapel_items WHERE tenant_id = $1 AND rapel_id IN
         (SELECT id FROM payroll_rapels WHERE tenant_id = $1 AND employee_id = ANY($2))`,
        [tenantId, employeeIds],
      );
      await db.query(
        "DELETE FROM payroll_rapels WHERE tenant_id = $1 AND employee_id = ANY($2)",
        [tenantId, employeeIds],
      );
    }
    for (const s of seeds) {
      await db.query(
        "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND employee_id = $2",
        [tenantId, s.employeeId],
      );
      await db.query(
        "DELETE FROM payslips WHERE tenant_id = $1 AND employee_id = $2",
        [tenantId, s.employeeId],
      );
      await db.query(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, s.entityId],
      );
      await db.query(
        "DELETE FROM employee_pay_components WHERE tenant_id = $1 AND employee_id = $2",
        [tenantId, s.employeeId],
      );
      await db.query("DELETE FROM pay_components WHERE id = $1", [
        s.componentId,
      ]);
      await db.query("DELETE FROM employees WHERE id = $1", [s.employeeId]);
      if (privateOutlets.has(s.employeeId))
        await db.query("DELETE FROM outlets WHERE id = $1", [
          privateOutlets.get(s.employeeId),
        ]);
      await db.query("DELETE FROM payroll_policies WHERE id = $1", [
        s.policyId,
      ]);
      await db.query("DELETE FROM legal_entities WHERE id = $1", [s.entityId]);
    }
    for (const entityId of transferEntities) {
      await db.query(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entityId],
      );
      await db.query(
        "DELETE FROM payroll_policies WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entityId],
      );
      await db.query(
        "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
        [tenantId, entityId],
      );
    }
    await db.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'rapel-549-%'",
      [tenantId],
    );
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, users],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenantId,
      roles,
    ]);
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
    await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [users]);
    await owner.end();
    if (priorKeyConfiguration === undefined) delete process.env.HRIS_PII_KEYS;
    else process.env.HRIS_PII_KEYS = priorKeyConfiguration;
  }
});

describe("legend-svqew rapel Q43/Q44", () => {
  it.each([
    { label: "legacy", envelope: "legacy" },
    { label: "pinned", envelope: "pinned_gross" },
  ] as const)(
    "[Q44 $label gross envelope] accepts the exact gross engine seal without full payslip metadata",
    async ({ envelope }) => {
      const s = await seed("2025-01-01", 6_000_000, envelope);
      const before = await frozenSnapshot(s);
      const rapel = await create(s);
      expect(rapel.totalIdr).toBe(450_000);
      await approve(rapel.id);
      const allocated = await allocate(s, rapel.id);
      const gross = await preview(s, allocated.reservedPayslipId!);
      expect(gross.grossIdr).toBe(7_350_000);
      expect(gross.lines.filter((line) => line.sourceId === rapel.id)).toEqual([
        expect.objectContaining({ amountIdr: 450_000 }),
      ]);
      expect(await frozenSnapshot(s)).toEqual(before);
    },
  );

  it("[Q44 mismatched pinned gross envelope] rejects a seal that names a different source run", async () => {
    const s = await seed("2025-01-01", 6_000_000, "mismatched_pinned_gross");
    const before = await frozenSnapshot(s);
    const res = await post(requester.client, root, body(s));
    expect([409, 422]).toContain(res.status);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 malformed full envelope] refuses invalid full metadata instead of falling back to the legacy shape", async () => {
    const s = await seed("2025-01-01", 6_000_000, "malformed_full");
    const before = await frozenSnapshot(s);
    const res = await post(requester.client, root, body(s));
    expect([409, 422]).toContain(res.status);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q43/Q44] prorates a raise by 15/30 calendar days and preserves frozen salary, run and payslip", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s, 6_900_001);
    expect(rapel.totalIdr).toBe(450_000);
    expect(rapel.totalIdr).toBeLessThanOrEqual(900_000);
    expect(rapel.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceRunId: s.sourceRunId,
          amountIdr: 450_000,
        }),
      ]),
    );
    await approve(rapel.id);
    expect((await allocate(s, rapel.id)).payrollRunId).toBe(s.targetRunId);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[1220] refuses allocating to a run that leaves the employee out (ended in an earlier year than its pay date), naming the employee", async () => {
    const s = await seed();
    // Ends before the rapel is made, so the rapel's own eligibility snapshot holds.
    await asTenant((db) =>
      db.query("UPDATE employees SET end_date = '2026-12-31' WHERE id = $1", [
        s.employeeId,
      ]),
    );
    const rapel = await create(s);
    await approve(rapel.id);
    await asTenant(async (db) => {
      await db.query(
        "UPDATE payroll_runs SET pay_date = '2027-01-05' WHERE id = $1",
        [s.targetRunId],
      );
    });
    const res = await post(requester.client, `${root}/${rapel.id}/allocate`, {
      payrollRunId: s.targetRunId,
      idempotencyKey: key(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain(
      "PAYROLL_RAPEL_EMPLOYEE_EXCLUDED",
    );
    expect(JSON.stringify(res.body)).toContain("2026-12-31");
  });

  it("[Q44] requires HR then a distinct Finance approver before allocating any payment", async () => {
    const s = await seed();
    const rapel = await create(s);
    const early = await post(requester.client, `${root}/${rapel.id}/allocate`, {
      payrollRunId: s.targetRunId,
      idempotencyKey: key(),
    });
    expect(early.status).toBe(409);
    const wrongOrder = await post(
      finance.client,
      `${root}/${rapel.id}/approve-finance`,
      { idempotencyKey: key() },
    );
    expect(wrongOrder.status).toBe(409);
    const self = await post(
      requester.client,
      `${root}/${rapel.id}/approve-hr`,
      { idempotencyKey: key() },
    );
    expect(self.status).toBe(403);
    const noHrPermission = await post(
      requester.client,
      `${root}/${rapel.id}/approve-hr`,
      { idempotencyKey: key() },
    );
    expect(noHrPermission.status).toBe(403);
    const noFinancePermission = await post(
      hr.client,
      `${root}/${rapel.id}/approve-finance`,
      { idempotencyKey: key() },
    );
    expect(noFinancePermission.status).toBe(403);
    await approve(rapel.id);
    const paid = await allocate(s, rapel.id);
    expect(paid.approvedByHr).toBe(hr.id);
    expect(paid.approvedByFinance).toBe(finance.id);
  });

  it("[Q44] replay, recomputation and run preview never allocate or pay the same raise twice", async () => {
    const s = await seed();
    const payload = body(s);
    const first = await post(requester.client, root, payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await post(requester.client, root, payload);
    expect([200, 201]).toContain(replay.status);
    expect(replay.body.data.id).toBe(first.body.data.id);
    await approve(first.body.data.id);
    const allocated = await allocate(s, first.body.data.id);
    await allocate(s, first.body.data.id);
    const repeat = await post(requester.client, root, body(s));
    expect(repeat.status).toBe(409);
    const get1 = await requester.client.get(`${root}/${first.body.data.id}`);
    const get2 = await requester.client.get(`${root}/${first.body.data.id}`);
    expect(get1.status).toBe(200);
    expect(get2.body.data).toEqual(get1.body.data);
    let sealed: { calculation: Buffer; keyVersion: number } | undefined;
    for (let i = 0; i < 2; i += 1) {
      const gross = await computeEmployeeGross(context, requester.id, {
        employeeId: s.employeeId,
        payslipId: allocated.reservedPayslipId,
        payrollRunId: s.targetRunId,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        overtimeParameters: cafeLegendPayrollFixtures.statutoryTables.find(
          (r) => r.type === "overtime",
        )!.parameters,
      } as never);
      const lines = gross.lines.filter(
        (l) => l.sourceId === first.body.data.id,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]!.amountIdr).toBe(450_000);
      expect(gross.grossIdr).toBe(7_350_000);
      sealed = gross.sealed;
    }
    const reopened = JSON.parse(
      openPayrollValue(
        sealed!.calculation,
        {
          tenantId,
          table: "payslips",
          rowId: allocated.reservedPayslipId!,
          field: "calculation",
        },
        sealed!.keyVersion,
      ),
    ) as { lines: { sourceId: string; amountIdr: number }[] };
    expect(
      reopened.lines.filter((line) => line.sourceId === first.body.data.id),
    ).toEqual([expect.objectContaining({ amountIdr: 450_000 })]);
    await lockTarget(s);
    const finalized = await finalize(s, allocated.reservedPayslipId!, 1);
    expect(finalized.payslips).toEqual([
      expect.objectContaining({ grossIdr: 7_350_000 }),
    ]);
    const persisted = await storedPayslip(s, allocated.reservedPayslipId!);
    expect(
      persisted.calculation.lines.filter(
        (line) => line.sourceId === first.body.data.id,
      ),
    ).toEqual([expect.objectContaining({ amountIdr: 450_000 })]);
    await asTenant(async (db) => {
      const insert = `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
        payment_method, calculation_encrypted, pii_key_version)
        VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`;
      const values = [
        allocated.reservedPayslipId,
        tenantId,
        s.targetRunId,
        s.employeeId,
        sealed!.calculation,
        sealed!.keyVersion,
      ];
      await db.query("SAVEPOINT duplicate_payment");
      await expect(
        db.query(insert, [randomUUID(), ...values.slice(1)]),
      ).rejects.toMatchObject({
        code: "23514",
      });
      await db.query("ROLLBACK TO SAVEPOINT duplicate_payment");
      const stored = await db.query(
        "SELECT calculation_encrypted FROM payslips WHERE id = $1",
        [allocated.reservedPayslipId],
      );
      expect(stored.rows[0]!.calculation_encrypted).toEqual(
        persisted.row.calculation_encrypted,
      );
      const count = await db.query(
        "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3",
        [tenantId, s.targetRunId, s.employeeId],
      );
      expect(count.rows[0]!.count).toBe(1);
    });
  });

  it("[Q44] two successive raises pay only their incremental differences, never the original delta twice", async () => {
    const s = await seed();
    const first = await create(s);
    await approve(first.id);
    await allocate(s, first.id);
    const second = await create(s, 7_500_000);
    expect(second.totalIdr).toBe(300_000);
    expect(first.totalIdr + second.totalIdr).toBe(750_000);
    await approve(second.id);
    const allocated = await allocate(s, second.id);
    const duplicate = await post(requester.client, root, body(s, 7_500_000));
    expect(duplicate.status).toBe(409);
    const gross = await preview(s, allocated.reservedPayslipId!);
    const rapelLines = gross.lines.filter((line) =>
      [first.id, second.id].includes(line.sourceId ?? ""),
    );
    expect(rapelLines).toHaveLength(2);
    expect(rapelLines.reduce((sum, line) => sum + line.amountIdr, 0)).toBe(
      750_000,
    );
    expect(gross.grossIdr).toBe(8_250_000);
  });

  it("[G688h P1 stale allocation seal] rejects an earlier preview after a second raise is allocated to the same payslip", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const first = await create(s);
    await approve(first.id);
    const firstAllocation = await allocate(s, first.id);
    const oldPreview = await preview(s, firstAllocation.reservedPayslipId!);
    expect(oldPreview.grossIdr).toBe(7_350_000);
    expect(
      oldPreview.lines.filter((line) => line.componentCode === "RAPEL"),
    ).toEqual([
      expect.objectContaining({ sourceId: first.id, amountIdr: 450_000 }),
    ]);

    const second = await create(s, 7_500_000);
    expect(second.totalIdr).toBe(300_000);
    await approve(second.id);
    const secondAllocation = await allocate(s, second.id);
    expect(secondAllocation.reservedPayslipId).toBe(
      firstAllocation.reservedPayslipId,
    );
    await lockTarget(s);

    await asTenant(async (db) => {
      await db.query("SAVEPOINT stale_allocation_seal");
      await expect(
        db.query(
          `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
           payment_method, calculation_encrypted, pii_key_version)
           VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
          [
            firstAllocation.reservedPayslipId,
            tenantId,
            s.targetRunId,
            s.employeeId,
            oldPreview.sealed.calculation,
            oldPreview.sealed.keyVersion,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.query("ROLLBACK TO SAVEPOINT stale_allocation_seal");
      const stored = await db.query(
        "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2 AND employee_id = $3",
        [tenantId, s.targetRunId, s.employeeId],
      );
      expect(stored.rows[0]!.count).toBe(0);
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[G688h P1 forged current receipt] rejects the intact old preview even when a same-transaction receipt claims the current allocation revision", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const first = await create(s);
    await approve(first.id);
    const firstAllocation = await allocate(s, first.id);
    const oldPreview = await preview(s, firstAllocation.reservedPayslipId!);
    const second = await create(s, 7_500_000);
    expect(second.totalIdr).toBe(300_000);
    await approve(second.id);
    const secondAllocation = await allocate(s, second.id);
    expect(secondAllocation.reservedPayslipId).toBe(
      firstAllocation.reservedPayslipId,
    );
    await lockTarget(s, 8_250_000);

    await asTenant(async (db) => {
      await db.query("SAVEPOINT relabeled_old_preview");
      await db.query(
        `INSERT INTO payroll_rapel_finalizations
         (payslip_id, tenant_id, employee_id, payroll_run_id, allocation_revision,
          calculation_sha256, pii_key_version, created_by)
         VALUES ($1, $2, $3, $4, 2, $5, $6, $7)`,
        [
          firstAllocation.reservedPayslipId,
          tenantId,
          s.employeeId,
          s.targetRunId,
          createHash("sha256")
            .update(oldPreview.sealed.calculation)
            .digest("hex"),
          oldPreview.sealed.keyVersion,
          finalizer.id,
        ],
      );
      // All receipt facts match the current allocation and this transaction.
      // The unchanged ciphertext itself still contains only the first raise.
      await expect(
        db.query(
          `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
           payment_method, calculation_encrypted, pii_key_version)
           VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
          [
            firstAllocation.reservedPayslipId,
            tenantId,
            s.targetRunId,
            s.employeeId,
            oldPreview.sealed.calculation,
            oldPreview.sealed.keyVersion,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.query("ROLLBACK TO SAVEPOINT relabeled_old_preview");
      const count = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenantId, s.targetRunId],
      );
      expect(count.rows[0]!.count).toBe(0);
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it.each(["revision", "run"] as const)(
    "[G688h P1 authenticated header %s] refuses modified clear metadata before a calculation can authorize pay",
    async (changed) => {
      const s = await seed();
      const first = await create(s);
      await approve(first.id);
      const allocated = await allocate(s, first.id);
      const gross = await preview(s, allocated.reservedPayslipId!);
      const binding = {
        tenantId,
        table: "payslips",
        rowId: allocated.reservedPayslipId!,
        field: "calculation",
      } as const;
      expect(gross.sealed.calculation[0]).toBe(2);
      expect(gross.sealed.calculation.readUInt32BE(1)).toBe(1);
      const opened = openPayrollValue(
        gross.sealed.calculation,
        binding,
        gross.sealed.keyVersion,
      );
      expect(JSON.parse(opened)).toMatchObject({
        payrollRunId: s.targetRunId,
        rapelAllocationRevision: 1,
        grossIdr: 7_350_000,
      });
      const tampered = Buffer.from(gross.sealed.calculation);
      if (changed === "revision") tampered.writeUInt32BE(2, 1);
      else tampered[5] = tampered[5]! ^ 1;
      expect(() =>
        openPayrollValue(tampered, binding, gross.sealed.keyVersion),
      ).toThrow();
      const count = await asTenant((db) =>
        db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenantId, s.targetRunId],
        ),
      );
      expect(count.rows[0]!.count).toBe(0);
    },
  );

  it.each(["revision", "hash", "transaction"] as const)(
    "[G688h P1 receipt %s binding] refuses a mismatched receipt before any payroll is paid",
    async (mismatch) => {
      const s = await seed();
      const before = await frozenSnapshot(s);
      const rapel = await create(s);
      await approve(rapel.id);
      const allocated = await allocate(s, rapel.id);
      const gross = await preview(s, allocated.reservedPayslipId!);
      await lockTarget(s);
      await asTenant(async (db) => {
        await db.query("SAVEPOINT mismatched_receipt");
        const transactionId =
          mismatch === "transaction"
            ? "(txid_current() + 1)::text"
            : "txid_current()::text";
        const receipt = db.query(
          `INSERT INTO payroll_rapel_finalizations
           (payslip_id, tenant_id, employee_id, payroll_run_id, allocation_revision,
            calculation_sha256, pii_key_version, transaction_id, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ${transactionId}, $8)`,
          [
            allocated.reservedPayslipId,
            tenantId,
            s.employeeId,
            s.targetRunId,
            mismatch === "revision" ? 0 : 1,
            mismatch === "hash"
              ? "0".repeat(64)
              : createHash("sha256")
                  .update(gross.sealed.calculation)
                  .digest("hex"),
            gross.sealed.keyVersion,
            finalizer.id,
          ],
        );
        if (mismatch === "hash") {
          await receipt;
          await expect(
            db.query(
              `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
               payment_method, calculation_encrypted, pii_key_version)
               VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
              [
                allocated.reservedPayslipId,
                tenantId,
                s.targetRunId,
                s.employeeId,
                gross.sealed.calculation,
                gross.sealed.keyVersion,
              ],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        } else {
          await expect(receipt).rejects.toMatchObject({ code: "23514" });
        }
        await db.query("ROLLBACK TO SAVEPOINT mismatched_receipt");
        const count = await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenantId, s.targetRunId],
        );
        expect(count.rows[0]!.count).toBe(0);
      });
      expect(await frozenSnapshot(s)).toEqual(before);
    },
  );

  it("[G688h P1 receipt replay] refuses a matching cipher receipt committed in an earlier transaction", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    const gross = await preview(s, allocated.reservedPayslipId!);
    const previewReceipts = await asTenant((db) =>
      db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payroll_rapel_finalizations WHERE tenant_id = $1 AND employee_id = $2",
        [tenantId, s.employeeId],
      ),
    );
    expect(previewReceipts.rows[0]!.count).toBe(0);
    await lockTarget(s);
    await asTenant((db) =>
      db.query(
        `INSERT INTO payroll_rapel_finalizations
         (payslip_id, tenant_id, employee_id, payroll_run_id, allocation_revision,
          calculation_sha256, pii_key_version, created_by)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7)`,
        [
          allocated.reservedPayslipId,
          tenantId,
          s.employeeId,
          s.targetRunId,
          createHash("sha256").update(gross.sealed.calculation).digest("hex"),
          gross.sealed.keyVersion,
          finalizer.id,
        ],
      ),
    );
    await asTenant(async (db) => {
      await db.query("SAVEPOINT previous_receipt");
      await expect(
        db.query(
          `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
           payment_method, calculation_encrypted, pii_key_version)
           VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
          [
            allocated.reservedPayslipId,
            tenantId,
            s.targetRunId,
            s.employeeId,
            gross.sealed.calculation,
            gross.sealed.keyVersion,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.query("ROLLBACK TO SAVEPOINT previous_receipt");
      const count = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenantId, s.targetRunId],
      );
      expect(count.rows[0]!.count).toBe(0);
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[G688h P1 finalization] pays both raises and the complete ordinary employee plan exactly once", async () => {
    const s = await seed();
    const ordinary = await seed();
    await asTenant((db) =>
      db.query("UPDATE employees SET legal_entity_id = $1 WHERE id = $2", [
        s.entityId,
        ordinary.employeeId,
      ]),
    );
    const ordinaryPlan: EmployeePlan = {
      employeeId: ordinary.employeeId,
      payslipId: randomUUID(),
      paymentMethod: "bank_transfer",
    };
    const before = await frozenSnapshot(s);
    const first = await create(s);
    await approve(first.id);
    const firstAllocation = await allocate(s, first.id);
    const oldPreview = await preview(s, firstAllocation.reservedPayslipId!);
    expect(oldPreview.grossIdr).toBe(7_350_000);
    const second = await create(s, 7_500_000);
    expect(second.totalIdr).toBe(300_000);
    await approve(second.id);
    const secondAllocation = await allocate(s, second.id);
    expect(secondAllocation.reservedPayslipId).toBe(
      firstAllocation.reservedPayslipId,
    );
    await lockTarget(s, 14_250_000, [s, ordinary]);
    const frozenTarget = await asTenant((db) =>
      db.query(
        "SELECT to_jsonb(r) AS value FROM payroll_runs r WHERE id = $1",
        [s.targetRunId],
      ),
    );

    await expect(
      finalize(s, firstAllocation.reservedPayslipId!, 1, [ordinaryPlan]),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      finalize(s, firstAllocation.reservedPayslipId!, 2),
    ).rejects.toMatchObject({ status: 409 });
    const empty = await asTenant((db) =>
      db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenantId, s.targetRunId],
      ),
    );
    expect(empty.rows[0]!.count).toBe(0);

    const finalized = await finalize(s, firstAllocation.reservedPayslipId!, 2, [
      ordinaryPlan,
    ]);
    expect(finalized.payrollRunId).toBe(s.targetRunId);
    expect(finalized.payslips).toHaveLength(2);
    expect(finalized.payslips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payslipId: firstAllocation.reservedPayslipId,
          employeeId: s.employeeId,
          allocationRevision: 2,
          grossIdr: 8_250_000,
          deductionsIdr: 0,
          netIdr: 8_250_000,
        }),
        expect.objectContaining({
          payslipId: ordinaryPlan.payslipId,
          employeeId: ordinary.employeeId,
          allocationRevision: 0,
          grossIdr: 6_000_000,
          deductionsIdr: 0,
          netIdr: 6_000_000,
        }),
      ]),
    );
    expect(
      finalized.payslips.reduce((sum, slip) => sum + slip.grossIdr, 0),
    ).toBe(14_250_000);
    const paid = await storedPayslip(s, firstAllocation.reservedPayslipId!);
    expect(paid.count).toBe(1);
    expect(paid.calculation.grossIdr).toBe(8_250_000);
    expect(
      paid.calculation.lines.filter(
        (line) => line.componentCode === s.componentCode,
      ),
    ).toEqual([expect.objectContaining({ amountIdr: 7_500_000 })]);
    const rapelLines = paid.calculation.lines.filter(
      (line) => line.componentCode === "RAPEL",
    );
    expect(rapelLines).toHaveLength(2);
    expect(rapelLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: first.id, amountIdr: 450_000 }),
        expect.objectContaining({ sourceId: second.id, amountIdr: 300_000 }),
      ]),
    );
    expect(rapelLines.reduce((sum, line) => sum + line.amountIdr, 0)).toBe(
      750_000,
    );
    const ordinaryPaid = await storedPayslip(
      { ...s, employeeId: ordinary.employeeId },
      ordinaryPlan.payslipId,
    );
    expect(ordinaryPaid.count).toBe(1);
    expect(ordinaryPaid.calculation.grossIdr).toBe(6_000_000);
    expect(
      ordinaryPaid.calculation.lines.filter(
        (line) => line.componentCode === "RAPEL",
      ),
    ).toEqual([]);

    const repeated = await finalize(s, firstAllocation.reservedPayslipId!, 2, [
      ordinaryPlan,
    ]);
    expect(repeated).toEqual(finalized);
    const afterRepeat = await storedPayslip(
      s,
      firstAllocation.reservedPayslipId!,
    );
    expect(afterRepeat.count).toBe(1);
    expect(afterRepeat.row.calculation_encrypted).toEqual(
      paid.row.calculation_encrypted,
    );
    expect(afterRepeat.calculation).toEqual(paid.calculation);
    const ordinaryAfterRepeat = await storedPayslip(
      { ...s, employeeId: ordinary.employeeId },
      ordinaryPlan.payslipId,
    );
    expect(ordinaryAfterRepeat.row.calculation_encrypted).toEqual(
      ordinaryPaid.row.calculation_encrypted,
    );
    const persistedTarget = await asTenant((db) =>
      db.query(
        "SELECT to_jsonb(r) AS value FROM payroll_runs r WHERE id = $1",
        [s.targetRunId],
      ),
    );
    expect(persistedTarget.rows).toEqual(frozenTarget.rows);
    for (const correction of [first, second]) {
      const read = await requester.client.get(`${root}/${correction.id}`);
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({
        status: "allocated",
        payrollRunId: s.targetRunId,
        reservedPayslipId: firstAllocation.reservedPayslipId,
      });
    }
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[G688h P1 overlay recomputation] refreshes the salary overlay with the same allocation revision", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const first = await create(s);
    await approve(first.id);
    const allocated = await allocate(s, first.id);
    const oldPreview = await preview(s, allocated.reservedPayslipId!);
    expect(oldPreview.grossIdr).toBe(7_350_000);
    const second = await create(s, 7_500_000);
    expect(second.totalIdr).toBe(300_000);
    await approve(second.id);
    // Approval changes the salary overlay without allocating the second rapel.
    await lockTarget(s, 7_950_000);
    const finalized = await finalize(s, allocated.reservedPayslipId!, 1);
    expect(finalized.payslips).toEqual([
      expect.objectContaining({
        allocationRevision: 1,
        grossIdr: 7_950_000,
        deductionsIdr: 0,
        netIdr: 7_950_000,
      }),
    ]);
    const paid = await storedPayslip(s, allocated.reservedPayslipId!);
    expect(paid.count).toBe(1);
    expect(paid.calculation.grossIdr).toBe(7_950_000);
    expect(
      paid.calculation.lines.filter(
        (line) => line.componentCode === s.componentCode,
      ),
    ).toEqual([expect.objectContaining({ amountIdr: 7_500_000 })]);
    expect(
      paid.calculation.lines.filter((line) => line.componentCode === "RAPEL"),
    ).toEqual([
      expect.objectContaining({ sourceId: first.id, amountIdr: 450_000 }),
    ]);
    const unallocated = await requester.client.get(`${root}/${second.id}`);
    expect(unallocated.status).toBe(200);
    expect(unallocated.body.data).toMatchObject({
      status: "approved",
      totalIdr: 300_000,
      payrollRunId: null,
      reservedPayslipId: null,
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it.each(["mismatch", "unsupported"] as const)(
    "[G688h P1 frozen totals %s] rejects unsupported or mismatched approval totals without any payslip write",
    async (failure) => {
      const s = await seed();
      const before = await frozenSnapshot(s);
      const rapel = await create(s);
      await approve(rapel.id);
      const allocated = await allocate(s, rapel.id);
      if (failure === "mismatch") await lockTarget(s, 7_350_001);
      else
        await lockTarget(s, 7_350_000, [s], {
          deductionsIdr: 1,
          netIdr: 7_349_999,
          bankTransferIdr: 7_349_999,
          bpjsEmployeeIdr: 1,
        });
      await expect(
        finalize(s, allocated.reservedPayslipId!, 1),
      ).rejects.toMatchObject({ status: 409 });
      const count = await asTenant((db) =>
        db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenantId, s.targetRunId],
        ),
      );
      expect(count.rows[0]!.count).toBe(0);
      expect(await frozenSnapshot(s)).toEqual(before);
    },
  );

  it("[G688h P1 finalization row lock] waits for the target run lock before writing exactly one payslip", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    await lockTarget(s);
    const holder = await owner.connect();
    let pending: ReturnType<typeof finalize> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
      const pid = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await holder.query(
        "SELECT id FROM payroll_runs WHERE id = $1 FOR UPDATE",
        [s.targetRunId],
      );
      let settled = false;
      pending = finalize(s, allocated.reservedPayslipId!, 1).then((result) => {
        settled = true;
        return result;
      });
      let blocked = false;
      const deadline = Date.now() + 2_000;
      while (!settled && Date.now() < deadline) {
        const observed = await owner.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
           WHERE $1::int = ANY(pg_blocking_pids(pid))
           AND state = 'active' AND query ILIKE '%payroll_runs%') AS blocked`,
          [pid.rows[0]!.pid],
        );
        blocked = observed.rows[0]!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      expect(settled).toBe(false);
      const empty = await owner.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenantId, s.targetRunId],
      );
      expect(empty.rows[0]!.count).toBe(0);
      await holder.query("COMMIT");
      const finalized = await pending;
      expect(finalized.payslips).toEqual([
        expect.objectContaining({ grossIdr: 7_350_000 }),
      ]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await pending?.catch(() => undefined);
    }
    const paid = await storedPayslip(s, allocated.reservedPayslipId!);
    expect(paid.count).toBe(1);
    expect(
      paid.calculation.lines.filter((line) => line.componentCode === "RAPEL"),
    ).toEqual([
      expect.objectContaining({ sourceId: rapel.id, amountIdr: 450_000 }),
    ]);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 shifted-date] preserves the first raise before a later raise and pays only 220000 additional rupiah", async () => {
    const s = await seed();
    const first = await create(s, 6_900_000, "2026-06-16");
    expect(first.totalIdr).toBe(450_000);
    await approve(first.id);
    await allocate(s, first.id);

    const second = await create(s, 7_500_000, "2026-06-20");
    // June 16-19 retains the earlier raise. Only June 20-30 (11/30)
    // receives the additional 600000, so the second payment is 220000.
    expect(second.totalIdr).toBe(220_000);
    expect(first.totalIdr + second.totalIdr).toBe(670_000);
    expect(first.totalIdr + second.totalIdr).toBeLessThanOrEqual(
      Math.floor((900_000 * 4 + 1_500_000 * 11) / 30),
    );
    await approve(second.id);
    const allocated = await allocate(s, second.id);
    const gross = await preview(s, allocated.reservedPayslipId!);
    const rapelLines = gross.lines.filter((line) =>
      [first.id, second.id].includes(line.sourceId ?? ""),
    );
    expect(rapelLines.reduce((sum, line) => sum + line.amountIdr, 0)).toBe(
      670_000,
    );
    expect(gross.grossIdr).toBe(8_170_000);
  });

  it("[Q43 rounding cap] floors revised entitlement per original history row and never pays the eighth rupiah", async () => {
    const s = await seed("2025-01-01", 6_000_000, "full", true);
    const before = await frozenSnapshot(s);
    const rapel = await create(s, 6_000_009, "2026-06-01");
    // Three original windows cover 3, 3 and 24 June days. Keeping the
    // gross engine's row-level floors gives 600000 + 600000 + 4800007.
    const targetEntitlement =
      Math.floor((6_000_009 * 3) / 30) +
      Math.floor((6_000_009 * 3) / 30) +
      Math.floor((6_000_009 * 24) / 30);
    expect(targetEntitlement).toBe(6_000_007);
    expect(rapel.totalIdr).toBe(7);
    expect(6_000_000 + rapel.totalIdr).toBeLessThanOrEqual(targetEntitlement);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    const gross = await preview(s, allocated.reservedPayslipId!);
    expect(gross.grossIdr).toBe(6_000_016);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 actual-paid cap] limits rapel to the unpaid entitlement shown by the real frozen payslip", async () => {
    const s = await seed("2025-01-01", 6_300_000);
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    // The revised June entitlement is 6.45m. The frozen slip already paid
    // 6.3m, so a nominal-history delta of 450k must be capped to 150k.
    expect(rapel.totalIdr).toBe(150_000);
    expect(6_300_000 + rapel.totalIdr).toBe(6_450_000);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    const gross = await preview(s, allocated.reservedPayslipId!);
    expect(gross.lines.filter((line) => line.sourceId === rapel.id)).toEqual([
      expect.objectContaining({ amountIdr: 150_000 }),
    ]);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 actual-paid cap] refuses extra pay when the frozen payslip already exceeds revised entitlement", async () => {
    const s = await seed("2025-01-01", 6_500_000);
    const before = await frozenSnapshot(s);
    const res = await post(requester.client, root, body(s));
    // 6.5m already paid exceeds the revised 6.45m entitlement. Do not pay
    // the nominal 450k difference or automatically collect the 50k excess.
    expect(res.status).toBe(409);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44] rejects a backdated decrease instead of creating an automatic deduction", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const res = await post(requester.client, root, body(s, 5_000_000));
    expect(res.status).toBe(409);
    expect(await frozenSnapshot(s)).toEqual(before);
    const raise = await create(s);
    await approve(raise.id);
    await allocate(s, raise.id);
    const rollbackRaise = await post(
      requester.client,
      root,
      body(s, 6_500_000),
    );
    expect(rollbackRaise.status).toBe(409);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44] refuses an allocation to the original frozen run and records auditable approval history", async () => {
    const s = await seed();
    const rapel = await create(s);
    await approve(rapel.id);
    const bad = await post(requester.client, `${root}/${rapel.id}/allocate`, {
      payrollRunId: s.sourceRunId,
      idempotencyKey: key(),
    });
    expect(bad.status).toBe(409);
    await allocate(s, rapel.id);
    const events = await asTenant((db) =>
      db.query(
        "SELECT event->>'action' AS action FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 ORDER BY created_at",
        [tenantId, rapel.id],
      ),
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(4);
    expect(events.rows.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        "payroll.rapel.created",
        "payroll.rapel.approved_hr",
        "payroll.rapel.approved_finance",
        "payroll.rapel.allocated",
      ]),
    );
  });

  it("[Q44] rejects self approval even with every permission and requires a different final approver", async () => {
    const s = await seed();
    const all = await actor("Rapel maker checker 549", [
      "payroll.view",
      "payroll.run",
      "payroll.approve",
      "payroll.lock",
    ]);
    const made = await post(all.client, root, body(s));
    expect(made.status).toBe(201);
    const self = await post(
      all.client,
      `${root}/${made.body.data.id}/approve-hr`,
      { idempotencyKey: key() },
    );
    expect(self.status).toBe(409);
    const h = await post(
      finance.client,
      `${root}/${made.body.data.id}/approve-hr`,
      { idempotencyKey: key() },
    );
    expect(h.status).toBe(200);
    const sameFinal = await post(
      finance.client,
      `${root}/${made.body.data.id}/approve-finance`,
      { idempotencyKey: key() },
    );
    expect(sameFinal.status).toBe(409);
  });

  it("[Q44] freezes the approved calculation and rejects a stale frozen-period approval until cancelled", async () => {
    const s = await seed();
    const rapel = await create(s);
    const h = await post(hr.client, `${root}/${rapel.id}/approve-hr`, {
      idempotencyKey: key(),
    });
    expect(h.status).toBe(200);
    await lockTarget(s);
    const stale = await post(
      finance.client,
      `${root}/${rapel.id}/approve-finance`,
      { idempotencyKey: key() },
    );
    expect(stale.status).toBe(409);
    const cancelled = await post(
      requester.client,
      `${root}/${rapel.id}/cancel`,
      { idempotencyKey: key() },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
  });

  it("[Q44 stale employment approval] rejects review after the source employment window changes", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    expect(rapel.totalIdr).toBe(450_000);
    await asTenant((db) =>
      db.query("UPDATE employees SET end_date = '2026-06-20' WHERE id = $1", [
        s.employeeId,
      ]),
    );

    const h = await post(hr.client, `${root}/${rapel.id}/approve-hr`, {
      idempotencyKey: key(),
    });
    expect(h.status).toBe(409);
    const f = await post(
      finance.client,
      `${root}/${rapel.id}/approve-finance`,
      {
        idempotencyKey: key(),
      },
    );
    expect(f.status).toBe(409);
    const read = await requester.client.get(`${root}/${rapel.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      status: "pending",
      approvedByHr: null,
      approvedByFinance: null,
      payrollRunId: null,
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 employment row lock] waits for an employee update and rechecks eligibility before Finance approval", async () => {
    const s = await seed();
    const rapel = await create(s);
    const h = await post(hr.client, `${root}/${rapel.id}/approve-hr`, {
      idempotencyKey: key(),
    });
    expect(h.status).toBe(200);
    const holder = await owner.connect();
    let pending: Promise<{ status: number }> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
      const pid = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await holder.query(
        "UPDATE employees SET end_date = '2026-06-20' WHERE id = $1",
        [s.employeeId],
      );
      let settled = false;
      pending = post(finance.client, `${root}/${rapel.id}/approve-finance`, {
        idempotencyKey: key(),
      }).then((res) => {
        settled = true;
        return res;
      });
      let blocked = false;
      const deadline = Date.now() + 2_000;
      while (!settled && Date.now() < deadline) {
        const observed = await owner.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE $1::int = ANY(pg_blocking_pids(pid))
            AND state = 'active' AND query ILIKE '%employees%') AS blocked`,
          [pid.rows[0]!.pid],
        );
        blocked = observed.rows[0]!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // Observe PostgreSQL's actual wait edge, not only an unresolved promise.
      expect(blocked).toBe(true);
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(409);
      const read = await requester.client.get(`${root}/${rapel.id}`);
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({
        status: "hr_approved",
        approvedByFinance: null,
        payrollRunId: null,
      });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await pending?.catch(() => undefined);
    }
  }, 10_000);

  it("[Q44 stale employment allocation] refuses payment when eligibility changes after both approvals", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    await asTenant((db) =>
      db.query("UPDATE employees SET end_date = '2026-06-20' WHERE id = $1", [
        s.employeeId,
      ]),
    );

    const paid = await post(requester.client, `${root}/${rapel.id}/allocate`, {
      payrollRunId: s.targetRunId,
      idempotencyKey: key(),
    });
    expect(paid.status).toBe(409);
    const read = await requester.client.get(`${root}/${rapel.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      status: "approved",
      approvedByHr: hr.id,
      approvedByFinance: finance.id,
      payrollRunId: null,
      reservedPayslipId: null,
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 stale employment gross] fails closed when allocated rapel no longer matches employment eligibility", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    await asTenant((db) =>
      db.query("UPDATE employees SET end_date = '2026-06-20' WHERE id = $1", [
        s.employeeId,
      ]),
    );

    await expect(
      preview(s, allocated.reservedPayslipId!),
    ).rejects.toMatchObject({
      status: 409,
    });
    const read = await requester.client.get(`${root}/${rapel.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      status: "allocated",
      payrollRunId: s.targetRunId,
      reservedPayslipId: allocated.reservedPayslipId,
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 entity transfer gross] refuses the former entity run and pays ordinary salary only once in the new entity", async () => {
    const s = await seed();
    await attachPrivateOutlet(s);
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    const runB = await transferToNewEntity(s);

    await expect(
      preview(s, allocated.reservedPayslipId!),
    ).rejects.toMatchObject({ status: 409 });
    const grossB = await preview(s, randomUUID(), runB);
    expect(grossB.lines.filter((line) => line.sourceId === rapel.id)).toEqual(
      [],
    );
    expect(
      grossB.lines.filter((line) => line.componentCode === "RAPEL"),
    ).toEqual([]);
    // Root's conservative ruling: the raise approved in A is held for an
    // entity review. B retains the original 6m and cannot pay A's correction.
    expect(grossB.grossIdr).toBe(6_000_000);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 entity transfer create] refuses a historical correction whose source belongs to a different current legal entity", async () => {
    const s = await seed();
    await attachPrivateOutlet(s);
    const before = await frozenSnapshot(s);
    await transferToNewEntity(s);
    const res = await post(requester.client, root, body(s));
    expect(res.status).toBe(409);
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44 entity transfer allocation] refuses an approved correction after the employee and outlet move legal entity", async () => {
    const s = await seed();
    await attachPrivateOutlet(s);
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    await transferToNewEntity(s);
    const res = await post(requester.client, `${root}/${rapel.id}/allocate`, {
      payrollRunId: s.targetRunId,
      idempotencyKey: key(),
    });
    expect(res.status).toBe(409);
    const read = await requester.client.get(`${root}/${rapel.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({
      status: "approved",
      payrollRunId: null,
      reservedPayslipId: null,
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it.each(["employee", "run"] as const)(
    "[Q44 reserved payslip tuple %s] rejects a real allocated seal under a different valid recipient tuple",
    async (changed) => {
      const s = await seed();
      const rapel = await create(s);
      await approve(rapel.id);
      const allocated = await allocate(s, rapel.id);
      const gross = await preview(s, allocated.reservedPayslipId!);
      await lockTarget(s);
      let wrongEmployeeId = s.employeeId;
      let wrongRunId = s.targetRunId;
      if (changed === "employee") {
        const recipient = await seed();
        // Keep the recipient valid for run A's tenant AND legal entity, so
        // the regression cannot pass through an unrelated parent check.
        await asTenant((db) =>
          db.query("UPDATE employees SET legal_entity_id = $1 WHERE id = $2", [
            s.entityId,
            recipient.employeeId,
          ]),
        );
        wrongEmployeeId = recipient.employeeId;
      } else {
        wrongRunId = randomUUID();
        await asTenant((db) =>
          db.query(
            `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id,
             run_type, period_start, period_end, pay_date, created_by)
           VALUES ($1, $2, $3, $4, 'regular', '2026-08-01', '2026-08-31', '2026-08-31', $5)`,
            [wrongRunId, tenantId, s.entityId, s.policyId, requester.id],
          ),
        );
        await lockTarget({ ...s, targetRunId: wrongRunId });
      }

      // AAD binds the original ciphertext to the unchanged reserved row ID.
      // The DB must also bind that ID to its intended employee/run tuple.
      const plaintext = JSON.parse(
        openPayrollValue(
          gross.sealed.calculation,
          {
            tenantId,
            table: "payslips",
            rowId: allocated.reservedPayslipId!,
            field: "calculation",
          },
          gross.sealed.keyVersion,
        ),
      ) as { lines: { sourceId: string; amountIdr: number }[] };
      expect(
        plaintext.lines.filter((line) => line.sourceId === rapel.id),
      ).toEqual([expect.objectContaining({ amountIdr: 450_000 })]);
      await asTenant(async (db) => {
        await db.query("SAVEPOINT wrong_reserved_tuple");
        await expect(
          db.query(
            `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
             payment_method, calculation_encrypted, pii_key_version)
           VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
            [
              allocated.reservedPayslipId,
              tenantId,
              wrongRunId,
              wrongEmployeeId,
              gross.sealed.calculation,
              gross.sealed.keyVersion,
            ],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await db.query("ROLLBACK TO SAVEPOINT wrong_reserved_tuple");
        const stored = await db.query(
          "SELECT count(*)::int AS count FROM payslips WHERE tenant_id = $1 AND id = $2",
          [tenantId, allocated.reservedPayslipId],
        );
        expect(stored.rows[0]!.count).toBe(0);
      });
    },
  );

  it("[Q44 target facts immutability] freezes allocated run facts while allowing status-only lock and the original valid payslip", async () => {
    const s = await seed();
    const other = await seed();
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    const gross = await preview(s, allocated.reservedPayslipId!);
    expect(gross.grossIdr).toBe(7_350_000);

    await asTenant(async (db) => {
      for (const [assignment, values] of [
        ["period_start = $2::date", [s.targetRunId, "2026-07-02"]],
        ["period_end = $2::date", [s.targetRunId, "2026-07-30"]],
        ["run_type = $2", [s.targetRunId, "off_cycle"]],
        ["payroll_policy_id = $2::uuid", [s.targetRunId, other.policyId]],
        ["legal_entity_id = $2::uuid", [s.targetRunId, other.entityId]],
      ] as const) {
        await db.query("SAVEPOINT allocated_run_facts");
        await expect(
          db.query(`UPDATE payroll_runs SET ${assignment} WHERE id = $1`, [
            ...values,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
        await db.query("ROLLBACK TO SAVEPOINT allocated_run_facts");
      }
    });

    await lockTarget(s);
    const finalized = await finalize(s, allocated.reservedPayslipId!, 1);
    expect(finalized.payslips).toEqual([
      expect.objectContaining({
        payslipId: allocated.reservedPayslipId,
        grossIdr: 7_350_000,
      }),
    ]);
    const stored = await storedPayslip(s, allocated.reservedPayslipId!);
    expect(stored.count).toBe(1);
    expect(stored.calculation.grossIdr).toBe(gross.grossIdr);
    expect(
      stored.calculation.lines.filter((line) => line.sourceId === rapel.id),
    ).toEqual([expect.objectContaining({ amountIdr: 450_000 })]);
  });

  it("[Q44 stale employment persistence] rejects an old valid gross seal if eligibility changes before the payslip is inserted", async () => {
    const s = await seed();
    const before = await frozenSnapshot(s);
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    const gross = await preview(s, allocated.reservedPayslipId!);
    expect(gross.grossIdr).toBe(7_350_000);
    await asTenant((db) =>
      db.query("UPDATE employees SET end_date = '2026-06-20' WHERE id = $1", [
        s.employeeId,
      ]),
    );
    await lockTarget(s);
    await expect(
      finalize(s, allocated.reservedPayslipId!, 1),
    ).rejects.toMatchObject({ status: 409 });

    await asTenant(async (db) => {
      await db.query("SAVEPOINT stale_payslip");
      await expect(
        db.query(
          `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id,
          payment_method, calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
          [
            allocated.reservedPayslipId,
            tenantId,
            s.targetRunId,
            s.employeeId,
            gross.sealed.calculation,
            gross.sealed.keyVersion,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.query("ROLLBACK TO SAVEPOINT stale_payslip");
      const stored = await db.query(
        "SELECT count(*)::int AS count FROM payslips WHERE id = $1",
        [allocated.reservedPayslipId],
      );
      expect(stored.rows[0]!.count).toBe(0);
    });
    expect(await frozenSnapshot(s)).toEqual(before);
  });

  it("[Q44] cannot pay an allocated correction after its source is reversed", async () => {
    const s = await seed();
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    if (await reverseOrRefuse(s.sourceRunId))
      await expect(
        preview(s, allocated.reservedPayslipId!),
      ).rejects.toMatchObject({ status: 409 });
  });

  it("[Q44] keeps a reversed target allocation reserved and refuses another payslip identity", async () => {
    const s = await seed();
    const rapel = await create(s);
    await approve(rapel.id);
    const allocated = await allocate(s, rapel.id);
    await expect(preview(s, randomUUID())).rejects.toMatchObject({
      status: 409,
    });
    await lockTarget(s);
    if (await reverseOrRefuse(s.targetRunId)) {
      const read = await requester.client.get(`${root}/${rapel.id}`);
      expect(read.status).toBe(200);
      expect(read.body.data.payrollRunId).toBe(s.targetRunId);
      expect(read.body.data.reservedPayslipId).toBe(
        allocated.reservedPayslipId,
      );
      const repeated = await post(requester.client, root, body(s));
      expect(repeated.status).toBe(409);
    }
  });

  it("[G688h P1 rekey replay] preserves the authenticated allocation header through the isolated tenant reseal worker and repeats without another payment", async () => {
    const sharedControl = await seed();
    const isolatedTenant = tenantIdSchema.parse(randomUUID());
    const isolatedBrand = randomUUID();
    const isolatedEntity = randomUUID();
    const isolatedOutlet = outletIdSchema.parse(randomUUID());
    const isolatedContext = establishScopedTenantContext(
      establishTenantContext({
        tenantId: isolatedTenant,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode,
       feature_flags, limits, created_by)
       SELECT $1, $2, 'Rapel rekey isolated', plan, status, deployment_mode,
       feature_flags, limits, created_by FROM tenants WHERE id = $3`,
      [isolatedTenant, `rapel-rekey-${isolatedTenant.slice(0, 8)}`, tenantId],
    );
    let s: Seed | undefined;
    try {
      await asTenant(async (client) => {
        await client.query(
          "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'rapel-rekey', 'Rapel rekey')",
          [isolatedBrand, isolatedTenant],
        );
        await client.query(
          "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Rapel Rekey', false)",
          [isolatedEntity, isolatedTenant],
        );
        await client.query(
          `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code,
           name, address, timezone, opening_hours, status)
           VALUES ($1, $2, $3, $4, 'RR-01', 'Rapel rekey', 'Jl. Rekey',
           'Asia/Jakarta', '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
          [isolatedOutlet, isolatedTenant, isolatedBrand, isolatedEntity],
        );
        for (const [actor, permissions] of [
          [requester, ["payroll.view", "payroll.run"]],
          [hr, ["payroll.view", "payroll.approve"]],
          [finance, ["payroll.view", "payroll.approve", "payroll.lock"]],
          [finalizer, ["payroll.view", "payroll.run", "payroll.lock"]],
        ] as const) {
          const roleId = randomUUID();
          await client.query(
            `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
             VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
            [
              roleId,
              isolatedTenant,
              `Rapel rekey ${roleId}`,
              JSON.stringify(permissions),
            ],
          );
          await client.query(
            `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type,
             scope_id, valid_from, assigned_by)
             VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
            [isolatedTenant, actor.id, roleId],
          );
        }
      }, isolatedTenant);
      s = await seed("2025-01-01", 6_000_000, "full", false, {
        tenantId: isolatedTenant,
        outletId: isolatedOutlet,
      });
      const seeded = s;
      const scopedCreate = (amount: number) =>
        createPayrollRapel(isolatedContext, requester.id, {
          employeeId: employeeIdSchema.parse(seeded.employeeId),
          componentId: payComponentIdSchema.parse(seeded.componentId),
          effectiveFrom: "2026-06-16",
          newAmountIdr: idr(amount),
          idempotencyKey: key(),
        });
      const scopedApprove = async (id: string) => {
        await approvePayrollRapel(isolatedContext, hr.id, id, "hr", {
          idempotencyKey: key(),
        });
        await approvePayrollRapel(isolatedContext, finance.id, id, "finance", {
          idempotencyKey: key(),
        });
      };
      const scopedAllocate = (id: string) =>
        allocatePayrollRapel(isolatedContext, requester.id, id, {
          payrollRunId: payrollRunIdSchema.parse(seeded.targetRunId),
          idempotencyKey: key(),
        });
      const first = await scopedCreate(6_900_000);
      await scopedApprove(first.id);
      const allocated = await scopedAllocate(first.id);
      const second = await scopedCreate(7_500_000);
      await scopedApprove(second.id);
      await scopedAllocate(second.id);
      await lockTarget(seeded, 8_250_000, [seeded], {}, isolatedTenant);
      const scopedFinalize = () =>
        withTenant(db, isolatedContext, (tx) =>
          finalizePayrollRapelRunInTransaction(
            tx,
            isolatedContext,
            finalizer.id,
            {
              payrollRunId: seeded.targetRunId,
              employeePlan: [
                {
                  employeeId: seeded.employeeId,
                  payslipId: allocated.reservedPayslipId!,
                  paymentMethod: "bank_transfer",
                },
              ],
              expectedAllocationRevisions: { [seeded.employeeId]: 2 },
            },
          ),
        );
      const finalized = await scopedFinalize();
      const before = await storedPayslip(
        seeded,
        allocated.reservedPayslipId!,
        isolatedTenant,
      );
      expect(before.row.pii_key_version).toBe(1);
      expect(before.row.calculation_encrypted[0]).toBe(2);
      expect(before.row.calculation_encrypted.readUInt32BE(1)).toBe(2);
      const frozenRuns = await asTenant(
        (client) =>
          client.query(
            "SELECT to_jsonb(r) AS value FROM payroll_runs r WHERE id = ANY($1) ORDER BY id",
            [[seeded.sourceRunId, seeded.targetRunId]],
          ),
        isolatedTenant,
      );
      const sharedTenantBefore = await asTenant((client) =>
        client.query(
          `SELECT id, pii_key_version, encode(calculation_encrypted, 'hex') AS calculation
         FROM payslips WHERE tenant_id = $1 AND id = $2`,
          [tenantId, sharedControl.sourcePayslipId],
        ),
      );
      expect(sharedTenantBefore.rows).toHaveLength(1);

      const rotated = await runHrisPiiReseal({
        activeKeyVersion: 2,
        batchSize: 20,
        listTenantIds: async () => [isolatedTenant],
        log: { error: () => {} },
      });
      expect(rotated).toMatchObject({ failedTenants: 0, aborted: false });
      const after = await storedPayslip(
        seeded,
        allocated.reservedPayslipId!,
        isolatedTenant,
      );
      expect(after.row.pii_key_version).toBe(2);
      expect(after.row.calculation_encrypted).not.toEqual(
        before.row.calculation_encrypted,
      );
      expect(after.row.calculation_encrypted[0]).toBe(2);
      expect(after.row.calculation_encrypted.subarray(1, 21)).toEqual(
        before.row.calculation_encrypted.subarray(1, 21),
      );
      expect(after.calculation).toEqual(before.calculation);
      expect(after.calculation.grossIdr).toBe(8_250_000);
      const rapelLines = after.calculation.lines.filter(
        (line) => line.componentCode === "RAPEL",
      );
      expect(rapelLines).toHaveLength(2);
      expect(rapelLines.reduce((sum, line) => sum + line.amountIdr, 0)).toBe(
        750_000,
      );
      const repeated = await scopedFinalize();
      expect(repeated).toEqual(finalized);
      const afterReplay = await storedPayslip(
        seeded,
        allocated.reservedPayslipId!,
        isolatedTenant,
      );
      expect(afterReplay.count).toBe(1);
      expect(afterReplay.row.pii_key_version).toBe(2);
      expect(afterReplay.row.calculation_encrypted).toEqual(
        after.row.calculation_encrypted,
      );
      expect(afterReplay.calculation).toEqual(after.calculation);
      const runsAfter = await asTenant(
        (client) =>
          client.query(
            "SELECT to_jsonb(r) AS value FROM payroll_runs r WHERE id = ANY($1) ORDER BY id",
            [[seeded.sourceRunId, seeded.targetRunId]],
          ),
        isolatedTenant,
      );
      expect(runsAfter.rows).toEqual(frozenRuns.rows);
      const sharedTenantAfter = await asTenant((client) =>
        client.query(
          `SELECT id, pii_key_version, encode(calculation_encrypted, 'hex') AS calculation
         FROM payslips WHERE tenant_id = $1 AND id = $2`,
          [tenantId, sharedControl.sourcePayslipId],
        ),
      );
      expect(sharedTenantAfter.rows).toEqual(sharedTenantBefore.rows);
      for (const correction of [first, second]) {
        const read = await getPayrollRapel(
          isolatedContext,
          requester.id,
          correction.id,
        );
        expect(read).toMatchObject({
          status: "allocated",
          payrollRunId: seeded.targetRunId,
          reservedPayslipId: allocated.reservedPayslipId,
        });
      }
    } finally {
      if (s) seeds.splice(seeds.indexOf(s), 1);
      await asTenant(async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        for (const table of [
          "payroll_rapel_finalizations",
          "payroll_rapel_items",
          "payroll_rapels",
          "payslip_bank_snapshots",
          "payslips",
          "employee_pay_components",
          "pay_components",
          "employees",
          "payroll_runs",
          "payroll_policies",
          "hris_idempotency",
          "role_assignments",
          "roles",
          "audit_logs",
          "outlets",
          "legal_entities",
          "brands",
        ])
          await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            isolatedTenant,
          ]);
      }, isolatedTenant);
      await owner.query("DELETE FROM tenants WHERE id = $1", [isolatedTenant]);
    }
  });
});
