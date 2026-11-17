// Coretax PPh 21 export (bead legend-34qx, brief docs/briefs/ws10-payroll-bank-coretax.md
// "Coretax spec"; PRD v1.7 §3 D.30 "Dokumen Pajak"; HR-03 for PII).
//
// ROUTE UNDER TEST (declared by the shared contract, endpoints.ts
// `createPayrollTaxExport`; no router exists yet, so every test is expected to
// fail first):
//   POST /api/hris/payroll/tax-exports
//        body { legalEntityId, kind, taxPeriod, idempotencyKey } -> 201 { data: PayrollTaxExport }
//
// Assumptions (brief silent, stated so the engineer can contest them):
// - Permission is `payroll.lock` (endpoints.ts header line 13). A role with
//   payroll.view + payroll.run but no payroll.lock gets 403. Anonymous -> 401.
// - Source rows are payslips of `locked` runs of the requested legal entity whose
//   run `payDate` falls in the requested month. Runs that are not locked,
//   runs of another entity and runs paid in another month never contribute.
// - A month with no exportable locked run at all is refused with a 4xx and no
//   export row (status code not fixed by the brief: 409 or 422 both accepted).
// - Permanent employees (pegawai tetap, coordinator decision) are
//   `employment_type` `pkwtt` AND `pkwt` (included); `daily` and `intern` are
//   BP21 (excluded).
// - The routes need a storage runtime (503 without). The test passes a fake
//   storage that records writes and reads the XML bytes from it.
// - Error codes (coordinator, from the service): PAYROLL_TAX_EXPORT_NOT_SUPPORTED,
//   _EMPTY, _PTKP_UNSUPPORTED, _TER_MISMATCH, _NIK_INVALID,
//   _WITHHOLDER_NPWP_INVALID, _PERIOD_INVALID, PAYROLL_RUN_NOT_LOCKED.
// - Position text is the payslip's `positionName`; the withholder TIN is the
//   legal entity NPWP (written through the real org API), NITKU = NPWP + "000000".
// - Error bodies carry employee ids (not NIKs) for missing NIK; the exact JSON
//   shape is not asserted, only that the id is present and no NIK leaks.
// - Tax values are real: the export re-derives rate and PPh 21 from the TER table
//   the locked run pinned (PAYR-02). The test publishes the repo's PP 58/2023
//   reference table (fixtures/payroll/statutory-tables.ts, categories A/B/C) as
//   a `pph21_ter` statutory version and pins it in each locked run's
//   config_snapshot.statutoryVersions, like the payroll lock does. Every gross
//   and rate below is a real bracket: category A (TK/0): 5.4M-5.65M 0.25%,
//   8.55M-9.65M 1.75%, 11.6M-12.5M 4%, 39.1M-43.85M 16%; B (K/1, K/2):
//   7.3M-9.2M 1%, 37.1M-41.1M 15%.
// - `pph21Policy: null` in the snapshot = the tenant published no PPh 21 policy,
//   so the default policy applies, whose rounding is half_up (PER-11/PJ/2025).
//   The reference table itself says roundingMode "down" ("kept for other
//   consumers", statutory-tables.ts header): the engine rounds with the policy,
//   so a slip whose gross x rate ends in .5 carries the half_up amount. The
//   export must accept it (test [coretax-half-up-rounding]).
import { randomUUID, createHash } from "node:crypto";
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
const appWithoutStorage = createApp({ storageRuntime: null });

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

const YEAR = 2037;
const MONTH = 3;
const PERIOD = `${YEAR}-03`;
const PAY_DATE = `${YEAR}-03-21`;

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
    grossIdr: slip.gross,
    deductionsIdr: slip.pph,
    netIdr: slip.gross - slip.pph,
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
  const gross = slips.reduce((sum, s) => sum + s.gross, 0);
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
    reimbursementIdr: 0,
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
const MAIN_RUN: RunDates = {
  periodStart: `${YEAR}-03-01`,
  periodEnd: `${YEAR}-03-31`,
  payDate: PAY_DATE,
};

async function seedRun(
  world: World,
  status: "locked" | "approved",
  slips: Slip[],
  dates: RunDates = MAIN_RUN,
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

const monthly = (world: World, taxPeriod: string = PERIOD) => ({
  legalEntityId: world.entityId,
  kind: "monthly_withholding",
  taxPeriod,
});

/** The text of the one object the last export wrote to storage. */
function storedText(): string {
  expect(storage.puts, "the export wrote exactly one object").toHaveLength(1);
  const content = storage.puts[0]!.content;
  return typeof content === "string"
    ? content
    : Buffer.from(content).toString("utf8");
}

async function exportOk(world: World, taxPeriod: string = PERIOD) {
  storage.puts.length = 0;
  const response = await exportTax(exporter, monthly(world, taxPeriod));
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const file = payrollTaxExportSchema.parse(response.body.data);
  expect(file.status).toBe("ready");
  expect(file.fileUrl).not.toBeNull(); // signed URL, only on the response
  return { file, xml: storedText() };
}

// ---- XML helpers: layout expectation written by hand from the brief ------

type Block = {
  month: string;
  year: string;
  nik: string;
  ptkp: string;
  position: string;
  gross: string;
  rate: string;
  date: string;
};
function expectedXml(tin: string, rows: Block[]): string {
  const nitku = `${tin}000000`;
  const block = (r: Block) =>
    [
      `\t\t<MmPayroll>`,
      `\t\t\t<TaxPeriodMonth>${r.month}</TaxPeriodMonth>`,
      `\t\t\t<TaxPeriodYear>${r.year}</TaxPeriodYear>`,
      `\t\t\t<CounterpartOpt>Resident</CounterpartOpt>`,
      `\t\t\t<CounterpartPassport xsi:nil="true"/>`,
      `\t\t\t<CounterpartTin>${r.nik}</CounterpartTin>`,
      `\t\t\t<StatusTaxExemption>${r.ptkp}</StatusTaxExemption>`,
      `\t\t\t<Position>${r.position}</Position>`,
      `\t\t\t<TaxCertificate>N/A</TaxCertificate>`,
      `\t\t\t<TaxObjectCode>21-100-01</TaxObjectCode>`,
      `\t\t\t<Gross>${r.gross}</Gross>`,
      `\t\t\t<Rate>${r.rate}</Rate>`,
      `\t\t\t<IDPlaceOfBusinessActivity>${nitku}</IDPlaceOfBusinessActivity>`,
      `\t\t\t<WithholdingDate>${r.date}</WithholdingDate>`,
      `\t\t</MmPayroll>`,
    ].join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<MmPayrollBulk xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `\t<TIN>${tin}</TIN>`,
    `\t<ListOfMmPayroll>`,
    ...rows.map(block),
    `\t</ListOfMmPayroll>`,
    `</MmPayrollBulk>`,
  ].join("\n");
}
const normalise = (xml: string) => xml.replace(/\r\n/g, "\n").trimEnd();

/** The exported MmPayroll blocks by CounterpartTin. */
function blocksByNik(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of xml.match(/<MmPayroll>[\s\S]*?<\/MmPayroll>/g) ?? []) {
    const nik = /<CounterpartTin>(\d+)<\/CounterpartTin>/.exec(block)![1]!;
    map.set(nik, block);
  }
  return map;
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

// ---- Tests -----------------------------------------------------------------------

describe("Coretax export: permission, validation, scope", () => {
  it("[coretax-auth] 401 anonymous, 403 without payroll.lock (even with payroll.view + payroll.run), 403 for a non-payroll user", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const body = { ...monthly(world), idempotencyKey: key() };
    expect(
      (await agent(app).post(EXPORT_PATH).set(originHeader).send(body)).status,
    ).toBe(401);
    expect((await exportTax(runner, monthly(world))).status).toBe(403);
    expect((await exportTax(stranger, monthly(world))).status).toBe(403);
    expect(await exportCount(world.entityId)).toBe(0);
    // The permitted role does export.
    expect((await exportTax(exporter, monthly(world))).status).toBe(201);
  });

  it("[coretax-cross-tenant] a legal entity of another tenant and an unknown entity both answer 404 and write nothing", async () => {
    const foreignWorld: World = {
      entityId: otherEntity,
      policyId: otherPolicy,
      npwp: "",
    };
    expect((await exportTax(exporter, monthly(foreignWorld))).status).toBe(404);
    expect(
      (
        await exportTax(exporter, {
          legalEntityId: randomUUID(),
          kind: "monthly_withholding",
          taxPeriod: PERIOD,
        })
      ).status,
    ).toBe(404);
    const rows = await owner.query(
      "SELECT 1 FROM payroll_tax_exports WHERE tenant_id = $1",
      [otherTenant],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("[coretax-bad-period] a monthly export needs YYYY-MM; a bare year or a month 13 answers 422", async () => {
    const world = await makeWorld(digits(16));
    const bareYear = await exportTax(exporter, monthly(world, String(YEAR)));
    expect(bareYear.status, JSON.stringify(bareYear.body)).toBe(422);
    expect(bareYear.body.error?.code).toBe("PAYROLL_TAX_EXPORT_PERIOD_INVALID");
    // Month 13 fails the contract's period pattern before the service runs.
    expect(
      (await exportTax(exporter, monthly(world, `${YEAR}-13`))).status,
    ).toBe(422);
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-no-locked-run] a month without any locked run is refused (409 or 422) and writes nothing; an approved (unlocked) run does not count", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    // Nothing at all.
    const none = await exportTax(exporter, monthly(world));
    expect([409, 422], JSON.stringify(none.body)).toContain(none.status);
    expect(none.body.error?.code).toBe("PAYROLL_TAX_EXPORT_EMPTY");
    // Only an approved run with payslips.
    await seedRun(world, "approved", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const unlocked = await exportTax(exporter, monthly(world));
    expect([409, 422], JSON.stringify(unlocked.body)).toContain(
      unlocked.status,
    );
    expect(["PAYROLL_TAX_EXPORT_EMPTY", "PAYROLL_RUN_NOT_LOCKED"]).toContain(
      unlocked.body.error?.code,
    );
    expect(await exportCount(world.entityId)).toBe(0);
  });
});

describe("Coretax export: storage runtime", () => {
  it("[coretax-no-storage] without a storage runtime the route answers 503 and writes no export", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const client = agent(appWithoutStorage);
    await signUp(client, "Coretax no storage");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUsers.push(userId);
    await grantRole(userId, ["payroll.view", "payroll.run", "payroll.lock"]);
    const response = await exportTax(client, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(await exportCount(world.entityId)).toBe(0);
  });
});

describe("Coretax export: BPMP XML content", () => {
  it("[coretax-bpmp-exact] one permanent employee renders exactly the DJP BPMP layout: TIN, NITKU, NIK, PTKP, gross, rate, withholding date", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      {
        emp,
        gross: 40_000_000,
        bp: 1500,
        pph: 6_000_000,
        ptkp: "K/1",
        position: "Sifu",
      },
    ]);
    const { file, xml } = await exportOk(world);
    expect(file.kind).toBe("monthly_withholding");
    expect(file.taxPeriod).toBe(PERIOD);
    expect(file.legalEntityId).toBe(world.entityId);
    expect(normalise(xml)).toBe(
      expectedXml(world.npwp, [
        {
          month: String(MONTH), // no leading zero
          year: String(YEAR),
          nik: emp.nik!,
          ptkp: "K/1",
          position: "Sifu",
          gross: "40000000",
          rate: "15", // K/1 = category B: 37.1M-41.1M is 15%
          date: PAY_DATE,
        },
      ]),
    );
  });

  it("[coretax-bpmp-selection] only locked TER slips of permanent employees (pkwtt, pkwt) of this entity and month are listed; fractional rates render dot-decimal", async () => {
    const world = await makeWorld(digits(16));
    const a = await makeEmployee(world);
    const b = await makeEmployee(world);
    const fixedTerm = await makeEmployee(world, { type: "pkwt" });
    const contractDaily = await makeEmployee(world, { type: "daily" });
    const intern = await makeEmployee(world, { type: "intern" });
    const decemberStyle = await makeEmployee(world);
    const unlockedOnly = await makeEmployee(world);
    const otherMonth = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp: a, gross: 9_000_000, bp: 175, pph: 157_500, position: "Barista" },
      { emp: b, gross: 5_500_000, bp: 25, pph: 13_750, position: "R&D <Lead>" },
      { emp: fixedTerm, gross: 8_000_000, bp: 100, pph: 80_000, ptkp: "K/2" },
      { emp: contractDaily, gross: 8_000_000, bp: 150, pph: 120_000 },
      { emp: intern, gross: 8_000_000, bp: 150, pph: 120_000 },
      // annual_recalculation slip (A1 territory): excluded from BPMP.
      {
        emp: decemberStyle,
        gross: 20_000_000,
        bp: null,
        pph: 500_000,
        method: "annual_recalculation",
      },
    ]);
    // Approved (not locked) run, same month, same entity.
    await seedRun(
      world,
      "approved",
      [{ emp: unlockedOnly, gross: 8_000_000, bp: 150, pph: 120_000 }],
      {
        periodStart: `${YEAR}-02-01`,
        periodEnd: `${YEAR}-02-28`,
        payDate: `${YEAR}-03-25`,
      },
    );
    // Locked run paid in the next month.
    await seedRun(
      world,
      "locked",
      [{ emp: otherMonth, gross: 8_000_000, bp: 150, pph: 120_000 }],
      {
        periodStart: `${YEAR}-04-01`,
        periodEnd: `${YEAR}-04-30`,
        payDate: `${YEAR}-04-21`,
      },
    );
    // A different legal entity of the same tenant, same month.
    const sibling = await makeWorld(digits(16));
    const foreignEmp = await makeEmployee(sibling);
    await seedRun(sibling, "locked", [
      { emp: foreignEmp, gross: 9_000_000, bp: 175, pph: 157_500 },
    ]);

    const { xml } = await exportOk(world);
    const blocks = blocksByNik(xml);
    // pkwtt and pkwt are both pegawai tetap.
    expect([...blocks.keys()].sort()).toEqual(
      [a.nik!, b.nik!, fixedTerm.nik!].sort(),
    );
    expect(field(blocks.get(fixedTerm.nik!)!, "Gross")).toBe("8000000");
    expect(field(blocks.get(fixedTerm.nik!)!, "Rate")).toBe("1");
    expect(field(blocks.get(fixedTerm.nik!)!, "StatusTaxExemption")).toBe(
      "K/2",
    );
    expect(field(blocks.get(a.nik!)!, "Gross")).toBe("9000000");
    expect(field(blocks.get(a.nik!)!, "Rate")).toBe("1.75");
    expect(field(blocks.get(b.nik!)!, "Gross")).toBe("5500000");
    expect(field(blocks.get(b.nik!)!, "Rate")).toBe("0.25");
    // Position text is escaped.
    expect(field(blocks.get(b.nik!)!, "Position")).not.toMatch(/[<>]/);
    expect(field(blocks.get(b.nik!)!, "Position")).toContain("R&amp;D");
    for (const excluded of [
      contractDaily,
      intern,
      decemberStyle,
      unlockedOnly,
      otherMonth,
      foreignEmp,
    ])
      expect(xml, excluded.name).not.toContain(excluded.nik!);
    expect(xml).toContain(`<TIN>${world.npwp}</TIN>`);
    expect(xml).not.toContain(sibling.npwp);
  });

  it("[coretax-amounts-from-slips] gross and rate are the payslip's own taxable gross and its TER bracket rate (12.5M, category A = 4%)", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 12_500_000, bp: 400, pph: 500_000 },
    ]);
    const { xml } = await exportOk(world);
    const block = blocksByNik(xml).get(emp.nik!)!;
    expect(field(block, "Gross")).toBe("12500000");
    expect(field(block, "Rate")).toBe("4");
  });

  it("[coretax-half-up-rounding] a slip whose gross x rate ends in .5 (5,500,200 at 0.25% = 13,750.5) exports with the half_up amount 13,751", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 5_500_200, bp: 25, pph: 13_751 },
    ]);
    const { xml } = await exportOk(world);
    const block = blocksByNik(xml).get(emp.nik!)!;
    expect(field(block, "Gross")).toBe("5500200");
    expect(field(block, "Rate")).toBe("0.25");
  });

  it("[coretax-half-up-wrong-rounding] the same slip carrying the rounded-down amount 13,750 is refused (the policy rounds half up)", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 5_500_200, bp: 25, pph: 13_750 },
    ]);
    const response = await exportTax(exporter, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_TER_MISMATCH");
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-multi-slip-sum] two TER slips of one employee in the month are one row: gross is the sum (20M + 20M = 40M) at the 16% rate of the combined gross", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(
      world,
      "locked",
      [{ emp, gross: 20_000_000, bp: 1600, pph: 3_200_000 }],
      {
        periodStart: `${YEAR}-03-01`,
        periodEnd: `${YEAR}-03-15`,
        payDate: `${YEAR}-03-16`,
      },
    );
    await seedRun(
      world,
      "locked",
      [{ emp, gross: 20_000_000, bp: 1600, pph: 3_200_000 }],
      {
        periodStart: `${YEAR}-03-16`,
        periodEnd: `${YEAR}-03-31`,
        payDate: `${YEAR}-03-31`,
      },
    );
    const { xml } = await exportOk(world);
    const blocks = blocksByNik(xml);
    expect([...blocks.keys()]).toEqual([emp.nik!]);
    const block = blocks.get(emp.nik!)!;
    expect(field(block, "Gross")).toBe("40000000");
    expect(field(block, "Rate")).toBe("16");
    // Withholding date: the latest pay date.
    expect(field(block, "WithholdingDate")).toBe(`${YEAR}-03-31`);
  });

  it("[coretax-export-is-read-only] exporting changes no payslip and no run total", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    const runId = await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const snapshot = () =>
      asTenant(tenant.id, async (db) => {
        const slips = await db.query(
          "SELECT id, calculation_encrypted FROM payslips WHERE payroll_run_id = $1 ORDER BY id",
          [runId],
        );
        const run = await db.query(
          "SELECT status, totals FROM payroll_runs WHERE id = $1",
          [runId],
        );
        return createHash("sha256")
          .update(JSON.stringify([slips.rows, run.rows]))
          .digest("hex");
      });
    const before = await snapshot();
    await exportOk(world);
    expect(await snapshot()).toBe(before);
  });

  it("[coretax-idempotent] the same idempotency key returns the same export and writes one row", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const idempotencyKey = key();
    const first = await exportTax(exporter, monthly(world), idempotencyKey);
    const second = await exportTax(exporter, monthly(world), idempotencyKey);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await exportCount(world.entityId)).toBe(1);
  });
});

describe("Coretax export: refusals (never guess)", () => {
  it("[coretax-missing-nik] a permanent employee without NIK refuses the whole export with 422 listing employee ids, never NIKs", async () => {
    const world = await makeWorld(digits(16));
    const withNik = await makeEmployee(world);
    const withoutNik = await makeEmployee(world, { nik: null });
    await seedRun(world, "locked", [
      { emp: withNik, gross: 9_000_000, bp: 175, pph: 157_500 },
      { emp: withoutNik, gross: 9_000_000, bp: 175, pph: 157_500 },
    ]);
    const response = await exportTax(exporter, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_NIK_INVALID");
    expect(response.text).toContain(withoutNik.id);
    expect(response.text).not.toContain(withNik.nik!);
    expect(response.text).not.toContain(withoutNik.npwp);
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-tax-mismatch] a slip whose PPh 21 differs from gross x TER rate refuses the export with 422", async () => {
    const world = await makeWorld(digits(16));
    const ok = await makeEmployee(world);
    const bad = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp: ok, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
      // 40,000,000 x 16% = 6,400,000, not 6,400,001.
      { emp: bad, gross: 40_000_000, bp: 1600, pph: 6_400_001 },
    ]);
    const response = await exportTax(exporter, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_TER_MISMATCH");
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-rate-mismatch-multi-slip] two TER slips of one employee in the month with different rates refuse the export with 422", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(
      world,
      "locked",
      [{ emp, gross: 20_000_000, bp: 1600, pph: 3_200_000 }],
      {
        periodStart: `${YEAR}-03-01`,
        periodEnd: `${YEAR}-03-15`,
        payDate: `${YEAR}-03-16`,
      },
    );
    await seedRun(
      world,
      "locked",
      [{ emp, gross: 20_000_000, bp: 1750, pph: 3_500_000 }],
      {
        periodStart: `${YEAR}-03-16`,
        periodEnd: `${YEAR}-03-31`,
        payDate: `${YEAR}-03-31`,
      },
    );
    const response = await exportTax(exporter, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe("PAYROLL_TAX_EXPORT_TER_MISMATCH");
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-ptkp-unsupported] a slip with a PTKP status outside the BPMP range (K/I/1) refuses the export with 422", async () => {
    const world = await makeWorld(digits(16));
    const ok = await makeEmployee(world);
    const odd = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp: ok, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
      { emp: odd, gross: 40_000_000, bp: 1600, pph: 6_400_000, ptkp: "K/I/1" },
    ]);
    const response = await exportTax(exporter, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.code).toBe(
      "PAYROLL_TAX_EXPORT_PTKP_UNSUPPORTED",
    );
    expect(await exportCount(world.entityId)).toBe(0);
  });

  it("[coretax-withholder-npwp] a legal entity without NPWP, or with a legacy 15-digit NPWP, refuses the export with 422", async () => {
    for (const npwp of [null, digits(15)]) {
      const world = await makeWorld(npwp);
      const emp = await makeEmployee(world);
      await seedRun(world, "locked", [
        { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
      ]);
      const response = await exportTax(exporter, monthly(world));
      expect(response.status, `${npwp}: ${JSON.stringify(response.body)}`).toBe(
        422,
      );
      expect(response.body.error?.code).toBe(
        "PAYROLL_TAX_EXPORT_WITHHOLDER_NPWP_INVALID",
      );
      if (npwp) expect(response.text).not.toContain(npwp);
      expect(await exportCount(world.entityId)).toBe(0);
    }
  });
});

describe("Coretax export: PII handling", () => {
  it("[coretax-no-pii-in-logs] the export request logs no NIK, NPWP, employee name or XML content", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    logLines.length = 0;
    const { xml } = await exportOk(world);
    const logged = logLines.join("");
    expect(logged.length).toBeGreaterThan(0); // the request itself was logged
    for (const value of [emp.nik!, emp.npwp, emp.account, emp.name, world.npwp])
      expect(logged).not.toContain(value);
    expect(logged).not.toContain("CounterpartTin");
    expect(logged).not.toContain("MmPayroll");
    expect(xml).toContain(emp.nik!); // sanity: the file itself does carry the NIK
  });

  it("[coretax-audit] the export is audited without any PII value", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const { file } = await exportOk(world);
    const rows = await asTenant(tenant.id, (db) =>
      db.query<{ text: string }>(
        `SELECT event::text AS text FROM audit_logs
          WHERE tenant_id = $1
            AND (event::text LIKE '%' || $2 || '%' OR event::text LIKE '%' || $3 || '%')`,
        [tenant.id, file.id, world.entityId],
      ),
    );
    const audited = rows.rows
      .filter((row) => row.text.includes(file.id))
      .map((row) => row.text)
      .join("\n");
    expect(audited.length, "an audit row names the export id").toBeGreaterThan(
      0,
    );
    for (const value of [emp.nik!, emp.npwp, emp.account, emp.name, world.npwp])
      expect(audited).not.toContain(value);
  });

  it("[coretax-response-no-pii] the API response carries no NIK, NPWP or employee name, only the signed file URL", async () => {
    const world = await makeWorld(digits(16));
    const emp = await makeEmployee(world);
    await seedRun(world, "locked", [
      { emp, gross: 40_000_000, bp: 1600, pph: 6_400_000 },
    ]);
    const response = await exportTax(exporter, monthly(world));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    for (const value of [emp.nik!, emp.npwp, emp.name, world.npwp])
      expect(response.text).not.toContain(value);
  });
});
