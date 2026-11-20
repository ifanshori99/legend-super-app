// Coretax BPA1 / A1 annual export (bead legend-838hi, brief
// docs/briefs/949-context.md "838hi"; PRD v1.7 §3 D.30 "Dokumen Pajak").
// Expected behaviour is written from the shared contract (kind
// `annual_statement`, taxPeriod = YYYY, `summary.rowCount`) and the brief, not
// from the service code.
//
// ROUTE UNDER TEST (shared contract `createPayrollTaxExport`):
//   POST /api/hris/payroll/tax-exports
//        body { legalEntityId, kind: "annual_statement", taxPeriod: "YYYY", idempotencyKey }
//        -> 201 { data: PayrollTaxExport }
//
// Assumptions (brief silent, stated so the engineer can contest them):
// - Same permission (payroll.lock), storage runtime (503 without) and fixtures
//   as payroll-coretax-export.test.ts. This file replaces that file's
//   [coretax-annual-not-supported] test once the A1 ships (the stub 422 stays
//   for unknown kinds only).
// - FORMAT (legend-y6w4q): the official DJP BPA1 layout, documented in
//   docs/qa/coretax-bpa1-format.md (XSD embedded in the DJP converter): root
//   `<A1Bulk>` > `<TIN>` (entity NPWP) > `<ListOfA1>` > one `<A1>` per employee
//   with exactly 27 elements in the mandatory xsd:sequence order. The official
//   sample is stored unchanged as fixtures/payroll/bpa1-official.xml (golden).
//   `<CounterpartTin>` = employee NIK, `<TaxPeriodYear>` = the requested year.
// - Article21IncomeTax = the PPh 21 already withheld, i.e. the sum of the
//   sealed locked payslips' PPh 21 of the year; it is never recomputed from
//   gross x rate. Money-critical: the A1 total must equal the slips' total.
// - Engine constants (format doc "Fix plan"): WorkForSecondEmployer No,
//   GrossUpOpt No, IncomeTaxBenefit 0, NumberOfMonths 0, CounterpartPassport and
//   PrevWhTaxSlip xsi:nil, TaxCertificate N/A, CounterpartOpt Resident,
//   TaxObjectCode 21-100-01, TaxExemptOpt = the slip's PTKP status.
// - Assumptions (doc silent): TaxPeriodMonthStart/End = first/last month with a
//   locked slip of the employee; StatusOfWithholding FullYear when that is
//   1..12, else PartialYear (Annualized is never emitted); WithholdingDate is a
//   YYYY-MM-DD date not earlier than the first day of the last paid month;
//   IDPlaceOfBusinessActivity = 22 digits starting with the entity NPWP
//   (NITKU, as in the sample).
// - Fixture slips are pure base salary (category base_salary), which the brief
//   maps to SalaryPensionJhtTht. The sum of that field over the blocks must
//   equal the sum of the locked payslips' gross for the year. Fixture slips are
//   TER slips (valid brackets, as in the monthly test).
// - Source rows: payslips of `locked` runs (and `paid`, not seeded here) of the
//   requested legal entity whose run payDate falls in the year. Reversed runs
//   never count; an employee with only reversed slips gets no block.
// - `summary.rowCount` = number of A1 blocks (employees), not payslips.
// - A year with no exportable run, a missing NIK, a monthly period passed to
//   annual_statement: 422 (code not fixed: only the status is asserted, plus the
//   codes already named by the monthly export for the same conditions).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  payrollConfigSnapshotSchema,
  payrollTaxExportSchema,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { FakeObjectStorage } from "@starter/shared/adapters";
import type { StorageRequest } from "@starter/shared/adapters";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { createLogger } from "../lib/logger.ts";
import {
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { REFERENCE_TER } from "./fixtures/payroll/statutory-tables.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

// ---- App with a captured log stream (no-PII-in-logs test) ---------------

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logLines.push(String(chunk));
    done();
  },
});

// The routes answer 503 without a storage runtime. The fake storage records
// every object the API writes, so the XML bytes are read back from it (the
// fake's signed URLs are not fetchable).
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
const otherTenant = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

const EXPORT_PATH = "/api/hris/payroll/tax-exports";
const key = () => `tax-export-${randomUUID()}`;

// ---- Database helpers (same shape as payroll-bank-export.test.ts) --------

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
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId, email };
}

async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Coretax export ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await db.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

type Client = Awaited<ReturnType<typeof signedInClient>>["client"];
let exporter: Client; // payroll.view + payroll.run + payroll.lock: may export
let runner: Client; // payroll.view + payroll.run, no lock: may not export
let stranger: Client; // no payroll permission
let hr: Client; // writes employee PII through the real route
let orgAdmin: Client; // creates legal entities (with NPWP) through the real org API

// ---- Fixtures --------------------------------------------------------------

let counter = 0;
const digits = (length: number) =>
  `${Date.now()}${++counter}${Math.floor(Math.random() * 1e9)}`
    .padEnd(length, "7")
    .slice(0, length);

const YEAR = 2038;

type World = { entityId: string; policyId: string; npwp: string };
type Emp = {
  id: string;
  name: string;
  nik: string | null;
  npwp: string;
  account: string;
};
type Slip = {
  emp: Emp;
  gross: number;
  bp: number | null; // terRateBp, null for annual_recalculation
  pph: number;
  method?: "ter" | "annual_recalculation";
  /**
   * Non-taxable earning (a reimbursement line) on top of `gross`. A valid slip
   * needs net >= 0, so PPh 21 above 0 on taxable gross 0 can only be sealed
   * when something non-taxable pays for the deduction.
   */
  nonTaxable?: number;
  ptkp?: string;
  position?: string | null;
};

const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const createdWorlds: World[] = [];
const allPeople: Emp[] = [];
let otherEntity: string;
let otherPolicy: string;

/** Creates a legal entity (NPWP through the org API) plus a payroll policy. */
async function makeWorld(npwp: string | null): Promise<World> {
  const created = await orgAdmin
    .post("/api/org/legal-entities")
    .set(originHeader)
    .send({
      name: `PT Coretax ${++counter}`,
      npwp,
      isPkp: false,
      address: "Kota Bandung",
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const entityId = created.body.data.id as string;
  const policyId = randomUUID();
  await asTenant(tenant.id, async (db) => {
    const code = `CX${policyId.slice(0, 8)}`;
    await db.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Coretax', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenant.id, entityId, code, JSON.stringify({ code })],
    );
  });
  const world = { entityId, policyId, npwp: npwp ?? "" };
  createdWorlds.push(world);
  return world;
}

async function makeEmployee(
  world: World,
  opts: {
    type?: "pkwtt" | "pkwt" | "daily" | "intern";
    nik?: string | null;
    name?: string;
  } = {},
): Promise<Emp> {
  const emp: Emp = {
    id: randomUUID(),
    name: opts.name ?? `Coretax Person ${++counter}`,
    nik: opts.nik === undefined ? digits(16) : opts.nik,
    npwp: digits(15),
    account: digits(12),
  };
  createdEmployees.push(emp.id);
  allPeople.push(emp);
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                              legal_entity_id, employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2025-03-01', 'active')`,
      [
        emp.id,
        tenant.id,
        `CX-${emp.id.slice(0, 8).toUpperCase()}`,
        emp.name,
        outlet.id,
        world.entityId,
        opts.type ?? "pkwtt",
      ],
    );
  });
  const put = await hr
    .put(`/api/hris/employees/${emp.id}/pii`)
    .set(originHeader)
    .send({
      ...(emp.nik ? { nik: emp.nik } : {}),
      npwp: emp.npwp,
      bankAccount: emp.account,
      idempotencyKey: key(),
    });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return emp;
}

function calculation(slip: Slip, dates: RunDates) {
  const method = slip.method ?? "ter";
  const lines: Record<string, unknown>[] = [
    {
      componentCode: "GAJI",
      name: "Gaji pokok",
      category: "base_salary",
      kind: "earning",
      amountIdr: slip.gross,
      taxable: true,
      quantity: null,
      sourceId: null,
    },
  ];
  const nonTaxable = slip.nonTaxable ?? 0;
  if (nonTaxable > 0)
    lines.push({
      componentCode: "REIMB",
      name: "Reimbursement",
      category: "reimbursement",
      kind: "earning",
      amountIdr: nonTaxable,
      taxable: false,
      quantity: null,
      sourceId: null,
    });
  if (slip.pph > 0)
    lines.push({
      componentCode: "PPH21",
      name: "PPh 21",
      category: "pph21",
      kind: "deduction",
      amountIdr: slip.pph,
      taxable: false,
      quantity: null,
      sourceId: null,
    });
  return {
    employeeId: slip.emp.id,
    employeeNo: `CX-${slip.emp.id.slice(0, 8).toUpperCase()}`,
    employeeName: slip.emp.name,
    positionName: slip.position === undefined ? "Kasir" : slip.position,
    outletId: outlet.id,
    periodStart: dates.periodStart,
    periodEnd: dates.periodEnd,
    payDate: dates.payDate,
    grossIdr: slip.gross + nonTaxable,
    deductionsIdr: slip.pph,
    netIdr: slip.gross + nonTaxable - slip.pph,
    pph21Idr: slip.pph,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    serviceChargeIdr: 0,
    overtimeIdr: 0,
    lines,
    bpjs: [],
    tax: {
      ptkpStatus: slip.ptkp ?? "TK/0",
      method,
      terCategory: null,
      terRateBp: method === "ter" ? slip.bp : null,
      taxableGrossIdr: slip.gross,
      pph21Idr: slip.pph,
      pph21WithheldIdr: slip.pph,
      taxAllowanceIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      grossSchemeBaseIdr: slip.gross,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: "bank_transfer",
  };
}

const STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
];

function totalsFor(slips: Slip[]) {
  const nonTaxable = slips.reduce((sum, s) => sum + (s.nonTaxable ?? 0), 0);
  const gross = slips.reduce((sum, s) => sum + s.gross, 0) + nonTaxable;
  const pph = slips.reduce((sum, s) => sum + s.pph, 0);
  const net = gross - pph;
  return {
    employeeCount: slips.length,
    grossIdr: gross,
    deductionsIdr: pph,
    netIdr: net,
    bpjsEmployeeIdr: 0,
    bpjsCompanyIdr: 0,
    pph21Idr: pph,
    pph21WithheldIdr: pph,
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
    reimbursementIdr: nonTaxable,
    bankTransferIdr: net,
    cashIdr: 0,
  };
}

// ---- Pinned TER table (PAYR-02) ----------------------------------------------

const TER_ID = randomUUID();
const TER_VERSION = 9100;
const TER_FROM = "2001-01-01";
let exporterUserId: string;

/**
 * Publishes the reference TER table for this tenant. Called before every locked
 * run is seeded: another suite clears the tenant's statutory rates, so a
 * deleted row is simply published again under the same id.
 */
async function ensureTerTable() {
  await asTenant(tenant.id, async (db) => {
    // PAYR-02: a version is inserted as a draft, then published by an UPDATE.
    await db.query(
      `INSERT INTO statutory_rates
         (id, tenant_id, type, version, effective_from, status, legal_basis, parameters, created_by)
       VALUES ($1, $2, 'pph21_ter', $3, $4, 'draft', 'PP 58/2023 Lampiran A-C (test)', $5::jsonb, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        TER_ID,
        tenant.id,
        TER_VERSION,
        TER_FROM,
        JSON.stringify(REFERENCE_TER),
        exporterUserId,
      ],
    );
    await db.query(
      `UPDATE statutory_rates
          SET status = 'published', published_at = now(), published_by = $2
        WHERE id = $1 AND status = 'draft'`,
      [TER_ID, exporterUserId],
    );
  });
}

/** The snapshot a lock writes: pinned TER version, default (half_up) PPh 21 policy. */
function snapshotFor(world: World) {
  return payrollConfigSnapshotSchema.parse({
    statutoryVersions: [
      {
        type: "pph21_ter",
        versionId: TER_ID,
        version: TER_VERSION,
        effectiveFrom: TER_FROM,
      },
    ],
    policy: {
      id: world.policyId,
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
        id: randomUUID(),
        code: "GAJI",
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
    capturedAt: "2037-03-31T00:00:00.000Z",
  });
}

type RunDates = { periodStart: string; periodEnd: string; payDate: string };
async function seedRun(
  world: World,
  status: "locked" | "approved",
  slips: Slip[],
  dates: RunDates,
  tenantId: string = tenant.id,
): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  if (status === "locked") await ensureTerTable();
  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $7, 'coretax-export-test')`,
      [
        runId,
        tenantId,
        world.entityId,
        world.policyId,
        dates.periodStart,
        dates.periodEnd,
        dates.payDate,
      ],
    );
    for (const step of STEPS)
      await db.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [runId]);
    if (status === "locked")
      await db.query(
        `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
                totals = $2::jsonb, locked_by = 'lock-user', locked_at = now()
          WHERE id = $1`,
        [
          runId,
          JSON.stringify(totalsFor(slips)),
          JSON.stringify(snapshotFor(world)),
        ],
      );
    // PAYR-01: the database refuses payslips on a run that is not locked, so
    // an approved run is seeded without any (it must still be ignored).
    for (const slip of status === "locked" ? slips : []) {
      const id = randomUUID();
      await db.query(
        `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                               calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
        [
          id,
          tenantId,
          runId,
          slip.emp.id,
          sealPayrollValue(JSON.stringify(calculation(slip, dates)), {
            tenantId,
            table: "payslips",
            rowId: id,
            field: "calculation",
          }),
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
    }
  });
  return runId;
}

const exportCount = (entityId: string) =>
  asTenant(tenant.id, async (db) =>
    Number(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM payroll_tax_exports WHERE tenant_id = $1 AND legal_entity_id = $2",
          [tenant.id, entityId],
        )
      ).rows[0].n,
    ),
  );

const exportTax = async (
  client: Client,
  body: Record<string, unknown>,
  idempotencyKey: string = key(),
) => {
  await ensureTerTable();
  return client
    .post(EXPORT_PATH)
    .set(originHeader)
    .send({ ...body, idempotencyKey });
};

/** The text of the one object the last export wrote to storage. */
function storedText(): string {
  expect(storage.puts, "the export wrote exactly one object").toHaveLength(1);
  const content = storage.puts[0]!.content;
  return typeof content === "string"
    ? content
    : Buffer.from(content).toString("utf8");
}

const field = (block: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1];

// ---- Setup / teardown -----------------------------------------------------------

beforeAll(async () => {
  const lock = await signedInClient("Coretax locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporter = lock.client;
  exporterUserId = lock.userId;
  const run = await signedInClient("Coretax runner");
  await grantRole(run.userId, ["payroll.view", "payroll.run"]);
  runner = run.client;
  const other = await signedInClient("Coretax stranger");
  await grantRole(other.userId, ["hr.employee.view"]);
  stranger = other.client;
  const hrUser = await signedInClient("Coretax HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;

  // Org admin: global admin + Owner template + MFA, as platform-org-api.test.ts.
  const admin = agent(app);
  const email = await signUp(admin, "Coretax org admin");
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

  // Tenant B: an entity and a locked run that must stay invisible.
  otherEntity = randomUUID();
  otherPolicy = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Coretax export tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `coretax-export-${otherTenant.slice(0, 8)}`, tenant.id],
  );
  await asTenant(otherTenant, async (db) => {
    await db.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Coretax B', false)`,
      [otherEntity, otherTenant],
    );
    const code = `CXB${otherPolicy.slice(0, 8)}`;
    await db.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Coretax B', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [otherPolicy, otherTenant, otherEntity, code, JSON.stringify({ code })],
    );
  });
});

afterAll(async () => {
  await asTenant(
    tenant.id,
    async (db) => {
      const entities = createdWorlds.map((w) => w.entityId);
      await db.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'tax-export-%'",
        [tenant.id],
      );
      await db.query(
        "DELETE FROM payroll_tax_exports WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
        [tenant.id, entities],
      );
      await db.query(
        "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenant.id, createdRuns],
      );
      await db.query(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant.id, createdRuns],
      );
      await db.query("DELETE FROM payroll_policies WHERE id = ANY($1)", [
        createdWorlds.map((w) => w.policyId),
      ]);
      await db.query(
        "DELETE FROM statutory_rates WHERE tenant_id = $1 AND id = $2",
        [tenant.id, TER_ID],
      );
      await db.query("DELETE FROM employees WHERE id = ANY($1)", [
        createdEmployees,
      ]);
      await db.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant.id, createdUsers],
      );
      await db.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant.id, createdRoles],
      );
      await db.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
        entities,
      ]);
    },
    true,
  );
  await asTenant(
    otherTenant,
    async (db) => {
      await db.query("DELETE FROM payslips WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await db.query("DELETE FROM payroll_runs WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await db.query("DELETE FROM payroll_policies WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await db.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        otherTenant,
      ]);
    },
    true,
  );
  // Audit rows are append-only: an audited tenant stays in place.
  const audited = await owner.query(
    "SELECT 1 FROM audit_logs WHERE tenant_id = $1 LIMIT 1",
    [otherTenant],
  );
  if ((audited.rowCount ?? 0) === 0)
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---- A1 helpers ------------------------------------------------------------------

const runDates = (month: number, year: number = YEAR): RunDates => {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodStart: `${year}-${mm}-01`,
    periodEnd: `${year}-${mm}-${lastDay}`,
    payDate: `${year}-${mm}-${lastDay}`,
  };
};

const annual = (world: World, taxPeriod: string = String(YEAR)) => ({
  legalEntityId: world.entityId,
  kind: "annual_statement",
  taxPeriod,
});

/** Marks a locked run reversed, straight in the database (as the bank export test does). */
async function reverseRun(runId: string) {
  await asTenant(
    tenant.id,
    (db) =>
      db.query(
        `UPDATE payroll_runs SET status = 'reversed', reversal = '{"status":"approved"}'
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.id, runId],
      ),
    true,
  );
}

async function exportA1Ok(world: World, taxPeriod: string = String(YEAR)) {
  storage.puts.length = 0;
  const response = await exportTax(exporter, annual(world, taxPeriod));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const file = payrollTaxExportSchema.parse(response.body.data);
  expect(file.kind).toBe("annual_statement");
  expect(file.taxPeriod).toBe(taxPeriod);
  expect(file.status).toBe("ready");
  return { file, xml: storedText() };
}

/** A1 blocks by employee NIK (CounterpartTin, assumed as in BPMP). */
function a1ByNik(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of xml.match(/<A1>[\s\S]*?<\/A1>/g) ?? []) {
    const nik = field(block, "CounterpartTin")!;
    expect(map.has(nik), `no second A1 block for NIK ${nik}`).toBe(false);
    map.set(nik, block);
  }
  return map;
}
const salary = (block: string) => Number(field(block, "SalaryPensionJhtTht"));
const withheld = (block: string) => Number(field(block, "Article21IncomeTax"));
const sumPph = (slips: Slip[]) => slips.reduce((s, x) => s + x.pph, 0);

/** The 27 A1 elements in the mandatory XSD order (docs/qa/coretax-bpa1-format.md). */
const A1_ORDER = [
  "WorkForSecondEmployer",
  "TaxPeriodMonthStart",
  "TaxPeriodMonthEnd",
  "TaxPeriodYear",
  "CounterpartOpt",
  "CounterpartPassport",
  "CounterpartTin",
  "TaxExemptOpt",
  "StatusOfWithholding",
  "CounterpartPosition",
  "TaxObjectCode",
  "NumberOfMonths",
  "SalaryPensionJhtTht",
  "GrossUpOpt",
  "IncomeTaxBenefit",
  "OtherBenefit",
  "Honorarium",
  "InsurancePaidByEmployer",
  "Natura",
  "TantiemBonusThr",
  "PensionContributionJhtThtFee",
  "Zakat",
  "PrevWhTaxSlip",
  "TaxCertificate",
  "Article21IncomeTax",
  "IDPlaceOfBusinessActivity",
  "WithholdingDate",
];

/** Names of the opening tags in `xml`, in document order. */
const tagNames = (xml: string): string[] =>
  [...xml.matchAll(/<([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g)].map((m) => m[1]!);
/** Element names directly inside one `<A1>` block, in order. */
const a1Tags = (block: string) =>
  tagNames(block.replace(/^<A1>/, "").replace(/<\/A1>$/, ""));
const a1Blocks = (xml: string) => xml.match(/<A1>[\s\S]*?<\/A1>/g) ?? [];
/** Everything outside the A1 blocks: the envelope (root, TIN, ListOfA1). */
const envelopeTags = (xml: string) =>
  tagNames(xml.replace(/<A1>[\s\S]*?<\/A1>/g, ""));
const isNil = (block: string, tag: string) =>
  new RegExp(`<${tag}\\s+xsi:nil="true"\\s*(/>|></${tag}>)`).test(block);

const OFFICIAL_SAMPLE = readFileSync(
  new URL("./fixtures/payroll/bpa1-official.xml", import.meta.url),
  "utf8",
);
const sumGross = (slips: Slip[]) => slips.reduce((s, x) => s + x.gross, 0);

// Valid TER brackets (see the monthly test header): A 40M = 16%, 12M = 4%,
// 9M = 1.75%; B (K/1) 8M = 1%.
const slipA = (emp: Emp): Slip => ({
  emp,
  gross: 40_000_000,
  bp: 1600,
  pph: 6_400_000,
});
const slip12 = (emp: Emp): Slip => ({
  emp,
  gross: 12_000_000,
  bp: 400,
  pph: 480_000,
});
const slip9 = (emp: Emp): Slip => ({
  emp,
  gross: 9_000_000,
  bp: 175,
  pph: 157_500,
});
const slipB = (emp: Emp): Slip => ({
  emp,
  gross: 8_000_000,
  bp: 100,
  pph: 80_000,
  ptkp: "K/1",
});

// ---- Tests -----------------------------------------------------------------------

describe("Coretax A1 export: permission, period, scope", () => {
  it("[coretax-a1-auth] 401 anonymous, 403 without payroll.lock, 403 for a non-payroll user; the permitted role exports", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(emp)], runDates(3));
    const body = { ...annual(world), idempotencyKey: key() };
    expect(
      (await agent(app).post(EXPORT_PATH).set(originHeader).send(body)).status,
    ).toBe(401);
    expect((await exportTax(runner, annual(world))).status).toBe(403);
    expect((await exportTax(stranger, annual(world))).status).toBe(403);
    expect(await exportCount(world.entityId)).toBe(0);
    expect((await exportTax(exporter, annual(world))).status).toBe(201);
  });

  it("[coretax-a1-period-yyyy] taxPeriod is a four-digit year: YYYY-MM is refused with 422 and nothing is written, YYYY exports", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(emp)], runDates(3));
    const monthStyle = await exportTax(exporter, annual(world, `${YEAR}-03`));
    expect(monthStyle.status, JSON.stringify(monthStyle.body)).toBe(422);
    expect(await exportCount(world.entityId)).toBe(0);
    const { xml } = await exportA1Ok(world, String(YEAR));
    expect(field(xml, "TaxPeriodYear")).toBe(String(YEAR));
    expect(await exportCount(world.entityId)).toBe(1);
  });

  it("[coretax-a1-no-locked-run] a year without any locked run (only an approved one, or runs of another year) is refused with 422 and writes nothing", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    const none = await exportTax(exporter, annual(world));
    expect(none.status, JSON.stringify(none.body)).toBe(422);
    await seedRun(world, "approved", [slipA(emp)], runDates(3));
    await seedRun(world, "locked", [slipA(emp)], runDates(3, YEAR - 1));
    const unlocked = await exportTax(exporter, annual(world));
    expect(unlocked.status, JSON.stringify(unlocked.body)).toBe(422);
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-a1-tenant-isolation] an entity of another tenant or an unknown entity answers 404; a second entity of the same tenant never leaks its slips", async () => {
    const foreignWorld: World = {
      entityId: otherEntity,
      policyId: otherPolicy,
      npwp: "",
    };
    expect((await exportTax(exporter, annual(foreignWorld))).status).toBe(404);
    expect(
      (
        await exportTax(exporter, {
          legalEntityId: randomUUID(),
          kind: "annual_statement",
          taxPeriod: String(YEAR),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM payroll_tax_exports WHERE tenant_id = $1",
          [otherTenant],
        )
      ).rowCount,
    ).toBe(0);

    const mine = await makeWorld(digits(16));
    const theirs = await makeWorld(digits(16));
    const mineEmp = await makeEmployee(mine);
    const theirEmp = await makeEmployee(theirs);
    await seedRun(mine, "locked", [slipA(mineEmp)], runDates(3));
    await seedRun(theirs, "locked", [slip12(theirEmp)], runDates(3));
    const { xml } = await exportA1Ok(mine);
    const blocks = a1ByNik(xml);
    expect([...blocks.keys()]).toEqual([mineEmp.nik]);
    expect(xml).not.toContain(theirEmp.nik!);
    expect(salary(blocks.get(mineEmp.nik!)!)).toBe(40_000_000);
  });
});

describe("Coretax A1 export: content", () => {
  it("[coretax-a1-totals-equal-payslips] each employee's amount and the file total equal the sum of their locked payslips of the year; other years are left out", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    const c = await makeEmployee(world);
    const aSlips = [slipA(a), slip12(a), slip9(a)];
    await seedRun(world, "locked", [aSlips[0]!, slipB(b)], runDates(3));
    await seedRun(world, "locked", [aSlips[1]!, slip9(c)], runDates(6));
    await seedRun(world, "locked", [aSlips[2]!], runDates(9));
    // Other years: never part of this A1.
    await seedRun(world, "locked", [slip12(a)], runDates(12, YEAR - 1));
    await seedRun(world, "locked", [slip12(b)], runDates(1, YEAR + 1));

    const { file, xml } = await exportA1Ok(world);
    expect(xml).toContain("<A1Bulk");
    const blocks = a1ByNik(xml);
    expect(blocks.size).toBe(3);
    expect(salary(blocks.get(a.nik!)!)).toBe(sumGross(aSlips)); // 61M
    expect(salary(blocks.get(b.nik!)!)).toBe(8_000_000);
    expect(salary(blocks.get(c.nik!)!)).toBe(9_000_000);
    const fileTotal = [...blocks.values()].reduce((s, x) => s + salary(x), 0);
    expect(fileTotal).toBe(61_000_000 + 8_000_000 + 9_000_000);
    expect(file.summary?.rowCount).toBe(3);
    for (const block of blocks.values())
      expect(field(block, "TaxPeriodYear")).toBe(String(YEAR));
  });

  it("[coretax-a1-reversed-excluded] slips of a reversed run never count: they leave the employee's amount, and an employee with only reversed slips gets no A1", async () => {
    const world = await makeWorld(digits(16));
    const kept = await makeEmployee(world);
    const onlyReversed = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(kept)], runDates(3));
    const reversed = await seedRun(
      world,
      "locked",
      [slip12(kept), slip9(onlyReversed)],
      runDates(9),
    );
    await reverseRun(reversed);

    const { file, xml } = await exportA1Ok(world);
    const blocks = a1ByNik(xml);
    expect([...blocks.keys()]).toEqual([kept.nik]);
    expect(salary(blocks.get(kept.nik!)!)).toBe(40_000_000);
    expect(xml).not.toContain(onlyReversed.nik!);
    expect(file.summary?.rowCount).toBe(1);
  });

  it("[coretax-a1-only-reversed-year] when every run of the year is reversed nothing is exportable: 422 and no row", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    const runId = await seedRun(world, "locked", [slipA(emp)], runDates(3));
    await reverseRun(runId);
    const response = await exportTax(exporter, annual(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-a1-no-duplicate-employee] an employee paid in twelve locked runs is one A1 block, never twelve", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    const other = await makeEmployee(world);
    const slips: Slip[] = [];
    for (let month = 1; month <= 12; month++) {
      const s = slip12(emp);
      slips.push(s);
      await seedRun(
        world,
        "locked",
        month === 1 ? [s, slip9(other)] : [s],
        runDates(month),
      );
    }
    const { xml } = await exportA1Ok(world);
    const blocks = a1ByNik(xml); // also fails on a repeated NIK
    expect(blocks.size).toBe(2);
    expect(xml.match(/<A1>/g)).toHaveLength(2);
    expect(salary(blocks.get(emp.nik!)!)).toBe(sumGross(slips)); // 144M
    expect(salary(blocks.get(other.nik!)!)).toBe(9_000_000);
  });

  it("[coretax-a1-daily-intern-excluded] daily and intern staff (BP21, not A1) are not listed", async () => {
    const world = await makeWorld(digits(16));
    const permanent = await makeEmployee(world);
    const daily = await makeEmployee(world, { type: "daily" });
    const intern = await makeEmployee(world, { type: "intern" });
    await seedRun(
      world,
      "locked",
      [slipA(permanent), slip12(daily), slip9(intern)],
      runDates(3),
    );
    const { xml } = await exportA1Ok(world);
    expect([...a1ByNik(xml).keys()]).toEqual([permanent.nik]);
  });

  it("[coretax-a1-export-is-read-only-idempotent] the same idempotency key returns the same export and writes one row", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(emp)], runDates(3));
    const idempotencyKey = key();
    const first = await exportTax(exporter, annual(world), idempotencyKey);
    const second = await exportTax(exporter, annual(world), idempotencyKey);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await exportCount(world.entityId)).toBe(1);
  });
});

describe("Coretax A1 export: official DJP BPA1 format (legend-y6w4q)", () => {
  it("[coretax-a1-golden-bpa1] the official DJP sample defines the layout: the 27 element names and their order, and the envelope, match the export", async () => {
    // Guard the fixture itself: it is the unchanged DJP sample.
    const officialBlocks = a1Blocks(OFFICIAL_SAMPLE);
    expect(officialBlocks).toHaveLength(2);
    for (const block of officialBlocks) expect(a1Tags(block)).toEqual(A1_ORDER);

    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(emp)], runDates(3));
    const { xml } = await exportA1Ok(world);
    const blocks = a1Blocks(xml);
    expect(blocks).toHaveLength(1);
    expect(a1Tags(blocks[0]!)).toEqual(a1Tags(officialBlocks[0]!));
    expect(envelopeTags(xml)).toEqual(envelopeTags(OFFICIAL_SAMPLE));
    expect(envelopeTags(xml)).toEqual(["A1Bulk", "TIN", "ListOfA1"]);
    expect(xml).toContain(
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"')).toBe(true);
  });

  it("[coretax-a1-27-elements-in-xsd-order] every A1 block has exactly the 27 official elements in XSD order, with no guessed or renamed element, and TIN is the entity NPWP before ListOfA1", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(a), slipB(b)], runDates(3));
    const { xml } = await exportA1Ok(world);
    const blocks = a1Blocks(xml);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const tags = a1Tags(block);
      expect(tags).toHaveLength(27);
      expect(tags).toEqual(A1_ORDER);
      for (const guessed of ["StatusTaxExemption", "Position"])
        expect(tags).not.toContain(guessed);
    }
    expect(field(xml, "TIN")).toBe(world.npwp);
    expect(xml.indexOf("<TIN>")).toBeLessThan(xml.indexOf("<ListOfA1>"));
  });

  it("[coretax-a1-official-values] fixed and mapped elements carry the official values: constants, nil elements, PTKP, position, NITKU, withholding date", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(a), slipB(b)], runDates(3));
    const { xml } = await exportA1Ok(world);
    const blocks = a1ByNik(xml);
    const blockA = blocks.get(a.nik!)!;
    const blockB = blocks.get(b.nik!)!;
    for (const block of [blockA, blockB]) {
      expect(field(block, "WorkForSecondEmployer")).toBe("No");
      expect(field(block, "CounterpartOpt")).toBe("Resident");
      expect(isNil(block, "CounterpartPassport")).toBe(true);
      expect(isNil(block, "PrevWhTaxSlip")).toBe(true);
      expect(field(block, "TaxObjectCode")).toBe("21-100-01");
      expect(field(block, "NumberOfMonths")).toBe("0");
      expect(field(block, "GrossUpOpt")).toBe("No");
      expect(field(block, "IncomeTaxBenefit")).toBe("0");
      expect(field(block, "TaxCertificate")).toBe("N/A");
      expect(field(block, "CounterpartPosition")).toBe("Kasir");
      expect(field(block, "IDPlaceOfBusinessActivity")).toMatch(/^\d{22}$/);
      expect(
        field(block, "IDPlaceOfBusinessActivity")!.startsWith(world.npwp),
      ).toBe(true);
      expect(field(block, "WithholdingDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(field(block, "WithholdingDate")! >= `${YEAR}-03-01`).toBe(true);
      // Plain decimals: no separators, no currency.
      for (const amount of [
        "SalaryPensionJhtTht",
        "OtherBenefit",
        "Honorarium",
        "InsurancePaidByEmployer",
        "Natura",
        "TantiemBonusThr",
        "PensionContributionJhtThtFee",
        "Zakat",
        "Article21IncomeTax",
      ])
        expect(field(block, amount), amount).toMatch(/^\d+(\.\d+)?$/);
    }
    expect(field(blockA, "TaxExemptOpt")).toBe("TK/0");
    expect(field(blockB, "TaxExemptOpt")).toBe("K/1");
  });

  it("[coretax-a1-tax-period-and-status] a full-year employee is FullYear 1..12; a part-year employee is PartialYear with the first and last paid month", async () => {
    const world = await makeWorld(digits(16));
    const full = await makeEmployee(world);
    const part = await makeEmployee(world);
    // One run per month and policy: the part-year employee shares runs 5 and 6.
    for (let month = 1; month <= 12; month++)
      await seedRun(
        world,
        "locked",
        month === 5 || month === 6
          ? [slip12(full), slip9(part)]
          : [slip12(full)],
        runDates(month),
      );
    const { xml } = await exportA1Ok(world);
    const blocks = a1ByNik(xml);
    const fullBlock = blocks.get(full.nik!)!;
    const partBlock = blocks.get(part.nik!)!;
    expect(field(fullBlock, "StatusOfWithholding")).toBe("FullYear");
    expect(field(fullBlock, "TaxPeriodMonthStart")).toBe("1");
    expect(field(fullBlock, "TaxPeriodMonthEnd")).toBe("12");
    expect(field(fullBlock, "WithholdingDate")! >= `${YEAR}-12-01`).toBe(true);
    expect(field(partBlock, "StatusOfWithholding")).toBe("PartialYear");
    expect(field(partBlock, "TaxPeriodMonthStart")).toBe("5");
    expect(field(partBlock, "TaxPeriodMonthEnd")).toBe("6");
    expect(field(partBlock, "TaxPeriodYear")).toBe(String(YEAR));
    expect(field(partBlock, "WithholdingDate")! >= `${YEAR}-06-01`).toBe(true);
  });
});

describe("Coretax A1 export: PTKP is the slip's (bead 1223 r3)", () => {
  it("[coretax-a1-ptkp-from-slip] a status recorded later for that year (history and profile K/2) never changes the A1: TaxExemptOpt stays the locked slip's TK/0", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(a)], runDates(3));
    await asTenant(tenant.id, async (conn) => {
      await conn.query(
        `INSERT INTO employee_ptkp_history (tenant_id, employee_id, effective_from, ptkp_status)
         VALUES ($1, $2, $3, 'K/2')
         ON CONFLICT (tenant_id, employee_id, effective_from) DO UPDATE SET ptkp_status = 'K/2'`,
        [tenant.id, a.id, `${YEAR}-01-01`],
      );
      await conn.query(
        "UPDATE employees SET ptkp_status = 'K/2' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, a.id],
      );
    });
    const { xml } = await exportA1Ok(world);
    expect(field(a1ByNik(xml).get(a.nik!)!, "TaxExemptOpt")).toBe("TK/0");
  });
});

describe("Coretax A1 export: Article21IncomeTax is the PPh 21 already withheld", () => {
  it("[coretax-a1-article21-equals-slip-pph21] per employee Article21IncomeTax is the sum of the year's locked slips' PPh 21; other years and reversed runs are left out", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    const aSlips = [slipA(a), slip12(a), slip9(a)];
    await seedRun(world, "locked", [aSlips[0]!, slipB(b)], runDates(3));
    await seedRun(world, "locked", [aSlips[1]!], runDates(6));
    await seedRun(world, "locked", [aSlips[2]!], runDates(9));
    await seedRun(world, "locked", [slip12(a)], runDates(12, YEAR - 1)); // other year
    const reversed = await seedRun(world, "locked", [slip12(a)], runDates(10));
    await reverseRun(reversed);

    const { xml } = await exportA1Ok(world);
    const blocks = a1ByNik(xml);
    expect(withheld(blocks.get(a.nik!)!)).toBe(sumPph(aSlips)); // 7_037_500
    expect(withheld(blocks.get(b.nik!)!)).toBe(80_000);
  });

  it("[coretax-a1-article21-not-recomputed] the withheld amount is copied from the slips, never recomputed: an annual-recalculation slip with a PPh 21 no TER rate gives is carried as is", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    const ter = slip12(emp); // 480_000
    const december: Slip = {
      emp,
      gross: 20_000_000,
      bp: null,
      pph: 1_234_567, // not gross x any rate
      method: "annual_recalculation",
    };
    await seedRun(world, "locked", [ter], runDates(11));
    await seedRun(world, "locked", [december], runDates(12));
    const { xml } = await exportA1Ok(world);
    const block = a1ByNik(xml).get(emp.nik!)!;
    expect(withheld(block)).toBe(480_000 + 1_234_567);
    expect(salary(block)).toBe(12_000_000 + 20_000_000);
  });

  it("[coretax-a1-total-equals-sealed-slips] the file total of PPh 21 and of gross equals the sum of every sealed locked slip of the year: no pay-over, no under-report", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    const c = await makeEmployee(world);
    const sealed: Slip[] = [];
    const lock = async (slips: Slip[], month: number) => {
      sealed.push(...slips);
      await seedRun(world, "locked", slips, runDates(month));
    };
    await lock([slipA(a), slipB(b)], 2);
    await lock([slip12(a), slip9(c)], 5);
    await lock([slip12(b), slip9(c)], 8);
    // Not sealed for this A1: other year, reversed run, approved (unlocked) run.
    await seedRun(world, "locked", [slipA(a)], runDates(12, YEAR - 1));
    await reverseRun(await seedRun(world, "locked", [slipA(b)], runDates(10)));
    await seedRun(world, "approved", [slipA(c)], runDates(11));

    const { file, xml } = await exportA1Ok(world);
    const blocks = [...a1ByNik(xml).values()];
    expect(blocks).toHaveLength(3);
    expect(blocks.reduce((s, x) => s + withheld(x), 0)).toBe(sumPph(sealed));
    expect(blocks.reduce((s, x) => s + salary(x), 0)).toBe(sumGross(sealed));
    expect(file.summary?.rowCount).toBe(3);
  });
});

describe("Coretax A1 export: refusals (never guess)", () => {
  it("[coretax-a1-missing-nik] an employee without NIK refuses the whole export with 422 listing employee ids, never NIKs", async () => {
    const world = await makeWorld(digits(16));
    const withNik = await makeEmployee(world);
    const withoutNik = await makeEmployee(world, { nik: null });
    await seedRun(
      world,
      "locked",
      [slip9(withNik), slip9(withoutNik)],
      runDates(3),
    );
    const response = await exportTax(exporter, annual(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_NIK_INVALID");
    expect(response.text).toContain(withoutNik.id);
    expect(response.text).not.toContain(withNik.nik!);
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-a1-withholder-npwp] a legal entity without NPWP refuses the export with 422", async () => {
    const world = await makeWorld(null);
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(emp)], runDates(3));
    const response = await exportTax(exporter, annual(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe(
      "PAYROLL_TAX_EXPORT_WITHHOLDER_NPWP_INVALID",
    );
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-a1-zero-gross-tax-invalid] an employee with gross 0 but a sealed slip PPh 21 above 0 refuses the whole export with 422 PAYROLL_TAX_EXPORT_A1_TAX_INVALID, never listing NIKs", async () => {
    // Assumption: a slip that withheld tax on no income is inconsistent data the
    // exporter must not report or silently drop (money-critical: no under-report).
    // The slip is an annual_recalculation one so no TER bracket is involved.
    // A readable slip needs net >= 0, so the 500 PPh 21 is covered by a 500
    // non-taxable reimbursement line: taxable gross stays 0 (PPh 21 > 0 on it).
    const world = await makeWorld(digits(16));
    const ok = await makeEmployee(world);
    const broken = await makeEmployee(world);
    await seedRun(
      world,
      "locked",
      [
        slip9(ok),
        {
          emp: broken,
          gross: 0,
          nonTaxable: 500,
          bp: null,
          pph: 500,
          method: "annual_recalculation",
        },
      ],
      runDates(3),
    );
    const response = await exportTax(exporter, annual(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_A1_TAX_INVALID");
    expect(response.text).not.toContain(broken.nik!);
    expect(response.text).not.toContain(ok.nik!);
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-a1-zero-gross-zero-tax-skipped] an employee with gross 0 and PPh 21 0 is left out of the file; the export still succeeds for the others", async () => {
    // Assumption: "skipped" means no A1 block and not counted in summary.rowCount.
    const world = await makeWorld(digits(16));
    const paid = await makeEmployee(world);
    const idle = await makeEmployee(world);
    await seedRun(
      world,
      "locked",
      [
        slip9(paid),
        {
          emp: idle,
          gross: 0,
          bp: null,
          pph: 0,
          method: "annual_recalculation",
        },
      ],
      runDates(3),
    );
    const { file, xml } = await exportA1Ok(world);
    const blocks = a1ByNik(xml);
    expect(blocks.has(paid.nik!), "the paid employee has an A1").toBe(true);
    expect(blocks.has(idle.nik!), "the zero-gross employee has none").toBe(
      false,
    );
    expect(blocks.size).toBe(1);
    expect(file.summary?.rowCount).toBe(1);
  });

  it("[coretax-a1-no-pii-in-response] the response carries no NIK, NPWP or employee name", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [slipA(emp)], runDates(3));
    const response = await exportTax(exporter, annual(world));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.text).not.toContain(emp.nik!);
    expect(response.text).not.toContain(emp.npwp);
    expect(response.text).not.toContain(emp.name);
  });
});
