// Payroll bank transfer file export (bead legend-34qx, brief
// docs/briefs/ws10-payroll-bank-coretax.md rules 1-5; PRD v1.7 §3 D.30
// "Pembayaran Gaji", PAYR-04, HR-03).
//
// LEGACY POST CLOSED (bead legend-yjbjb): POST .../bank-transfer-files now
// always answers 409 LEGACY_BANK_EXPORT_DISABLED (payroll-payout-870-legacy-export
// test covers that). The file-building tests below call the internal service
// `createBankTransferFile` directly (same actor, tenant context and storage
// runtime the route used); route-level checks that still hold (401, 403, 422
// bad body, GET list) stay on HTTP.
//
// ROUTE UNDER TEST (shared contract endpoints.ts `createBankTransferFile` /
// `listBankTransferFiles`; implemented in routes/payroll-export.routes.ts and
// services/payroll-export.service.ts, mounted by routes/storage-api.routes.ts):
//   POST /api/hris/payroll/runs/:payrollRunId/bank-transfer-files
//        body { format, idempotencyKey } -> 201 { data: BankTransferFile }
//        needs payroll.lock
//   GET  /api/hris/payroll/runs/:payrollRunId/bank-transfer-files
//        needs payroll.view

// Assumptions (spec silent, stated so the engineer can contest them):
// - Creating needs `payroll.lock` (endpoints.ts header); payroll.view +
//   payroll.run is NOT enough (403). Anonymous -> 401. Listing needs
//   payroll.view; a user with no payroll permission gets 403.
// - A run in `locked` status is exportable; draft/simulated/hr_approved/
//   approved -> 409 PAYROLL_RUN_NOT_LOCKED. (`paid` is not asserted.)
// - The routes live in the storage-backed router and answer 503 without a
//   storage runtime, so the app gets an in-memory ObjectStorage
//   (`fakeStorage` below). `fileUrl` is the URL the fake `signedGetUrl`
//   returns; `downloadCsv()` reads the stored bytes back through that URL.
//   Files must be stored private and read through a short-lived signed URL.
// - generic_csv layout is not fixed by the spec: tests parse the CSV (RFC 4180)
//   and look at cells, never at header names or column positions. A data row
//   holds the employee's bank account number, their net pay as a plain
//   integer, and the employee full name (account name; only a person's
//   own name exists in the data). Header row first, no footer/total row.
// - Unsupported bank layouts (mandiri|bni|bjb are in the enum but have no
//   confirmed layout; bca is registered since legend-648) -> 422 PAYROLL_BANK_FORMAT_NOT_SUPPORTED (brief rule 5).
// - A locked run with no bank_transfer payslip of net > 0 -> 422
//   PAYROLL_BANK_FILE_EMPTY, no file row, nothing left in storage.
// - A mismatch between payslips and run totals -> 409
//   PAYROLL_BANK_FILE_MISMATCH (payrollErrorHttpStatus) and no file row.
// - Audit: the export writes an audit row that mentions the run or file id and
//   carries no PII value (account no., NIK, NPWP, names).
// - Employees: bank account / NIK / NPWP are written through the real HR PII
//   route; the net pay of a payslip is the "bank portion" (rule 2).
import { randomUUID, createHash } from "node:crypto";
import { Writable } from "node:stream";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bankTransferFileSchema,
  type BankTransferFormat,
  type PayrollRunId,
} from "@starter/shared/hris/payroll";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type {
  ObjectStorage,
  StorageRequest,
  StorageSignedLookup,
} from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { snapshotPayeeBankForLock } from "../services/payroll-bank-snapshot.service.ts";
import { createBankTransferFile } from "../services/payroll-export.service.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { openPayslipCalculation } from "../services/hris-payslip.service.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { createLogger } from "../lib/logger.ts";
import {
  sealPayrollValue,
  PAYROLL_SEAL_KEY_VERSION,
} from "../lib/payroll-sealed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

// ---- App with a captured log stream (no-PII-in-logs test) ---------------

const logLines: string[] = [];
const logStream = new Writable({
  write(chunk, _encoding, done) {
    logLines.push(String(chunk));
    done();
  },
});
// ---- In-memory object storage (the routes answer 503 without a runtime) ----

const stored = new Map<string, StorageRequest>();
const signedLookups: StorageSignedLookup[] = [];
const FAKE_STORE = "https://bank-export-store.example.test/object";
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
  signedGetUrl: async (_context, input) => {
    signedLookups.push(input);
    return `${FAKE_STORE}?key=${encodeURIComponent(input.key)}&sig=fake`;
  },
  // A payroll bank file holds PII: it must never get a public URL.
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
const otherTenant = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

const runPath = (runId: string) =>
  `/api/hris/payroll/runs/${runId}/bank-transfer-files`;
const key = () => `bank-export-${randomUUID()}`;

// ---- Database helpers -----------------------------------------------------

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
  await asTenant(tenant.id, async (db) => {
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Bank export ${roleId.slice(0, 8)}`,
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
let exporter: Client; // payroll.lock: may export
let exporterId: string;
let runner: Client; // payroll.view + payroll.run, no lock: may not export
let stranger: Client; // no payroll permission at all
let hr: Client; // writes employee PII through the real route

// ---- Fixtures: employees, a payroll world, runs -----------------------------

type Person = {
  id: string;
  name: string;
  account: string;
  nik: string;
  npwp: string;
  method: "bank_transfer" | "cash";
  net: number;
};
const createdEmployees: string[] = [];
const createdRuns: string[] = [];
const entityId = randomUUID();
const policyId = randomUUID();
let counter = 0;
// Unique per call: a 3-digit counter first (so no two values of one length
// can match), then random digits. (Date.now() first made every 12-digit value
// identical after slicing.)
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};

// Names exercise CSV injection (leading = + - @) and RFC 4180 quoting.
const PEOPLE: Person[] = [
  ["Budi Santoso", "bank_transfer", 4_250_000],
  ["=cmd|' /C calc'!A0", "bank_transfer", 3_100_500],
  [`Siti "Cici", S.Kom`, "bank_transfer", 5_000_001],
  ["-Dash Name", "bank_transfer", 1_000_000],
  ["@Atname", "bank_transfer", 2_222_222],
  ["+Plus Name", "cash", 2_000_000], // cash: never in the bank file
  ["Nol Rupiah", "bank_transfer", 0], // net 0: never in the bank file
].map(([name, method, net]) => ({
  id: randomUUID(),
  name: name as string,
  account: digits(12),
  nik: digits(16),
  npwp: digits(15),
  method: method as Person["method"],
  net: net as number,
}));
const bankPeople = PEOPLE.filter(
  (p) => p.method === "bank_transfer" && p.net > 0,
);
const BANK_TOTAL = bankPeople.reduce((sum, p) => sum + p.net, 0);
const CASH_TOTAL = PEOPLE.filter((p) => p.method === "cash").reduce(
  (sum, p) => sum + p.net,
  0,
);

const day = (n: number) =>
  new Date(Date.UTC(2038, 0, 1 + n)).toISOString().slice(0, 10);

const STEPS = [
  `status = 'simulated'`,
  `status = 'hr_approved', approved_by_hr = 'hr-user', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = 'finance-user', approved_by_finance_at = now()`,
];
const STATUS_STEPS = {
  draft: 0,
  simulated: 1,
  hr_approved: 2,
  approved: 3,
} as const;

function totalsOf(bank: number, cash: number) {
  const net = bank + cash;
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
    bankTransferIdr: bank,
    cashIdr: cash,
  };
}

/** A valid sealed payslip body: one base-salary earning line, no deductions. */
function calculation(person: Person, runDays: [string, string]) {
  return {
    employeeId: person.id,
    employeeNo: `BE-${person.id.slice(0, 8).toUpperCase()}`,
    employeeName: person.name,
    positionName: null,
    outletId: outlet.id,
    periodStart: runDays[0],
    periodEnd: runDays[1],
    payDate: runDays[1],
    grossIdr: person.net,
    deductionsIdr: 0,
    netIdr: person.net,
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
        amountIdr: person.net,
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
      taxableGrossIdr: person.net,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      taxAllowanceIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      grossSchemeBaseIdr: person.net,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: person.method,
  };
}

type SeedRun = {
  status: keyof typeof STATUS_STEPS | "locked";
  /** Payslips: person plus the payment method / net this run pays them. */
  slips?: { person: Person; method: Person["method"]; net: number }[];
  totals?: ReturnType<typeof totalsOf>;
};

async function seedRun(tenantId: string, input: SeedRun): Promise<string> {
  const runId = randomUUID();
  createdRuns.push(runId);
  const start = ++counter * 3;
  const runDays: [string, string] = [day(start), day(start + 1)];
  // bank_transfer payslips that carry a transfer (net > 0): the payees whose
  // bank details the lock freezes in payslip_bank_snapshots.
  const payees: { payslipId: string; employeeId: string }[] = [];
  await asTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, 'bank-export-test')`,
      [
        runId,
        tenantId,
        tenantId === tenant.id ? entityId : otherEntity,
        tenantId === tenant.id ? policyId : otherPolicy,
        ...runDays,
      ],
    );
    const upTo = input.status === "locked" ? 3 : STATUS_STEPS[input.status];
    for (const step of STEPS.slice(0, upTo))
      await db.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [runId]);
    if (input.status === "locked")
      await db.query(
        `UPDATE payroll_runs SET status = 'locked', config_snapshot = '{"v":1}',
                totals = $2::jsonb, locked_by = 'lock-user', locked_at = now()
          WHERE id = $1`,
        [runId, JSON.stringify(input.totals ?? totalsOf(0, 0))],
      );
    for (const slip of input.slips ?? []) {
      const id = randomUUID();
      if (slip.method === "bank_transfer" && slip.net > 0)
        payees.push({ payslipId: id, employeeId: slip.person.id });
      const body = calculation(
        { ...slip.person, method: slip.method, net: slip.net },
        runDays,
      );
      await db.query(
        `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                               calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          tenantId,
          runId,
          slip.person.id,
          slip.method,
          sealPayrollValue(JSON.stringify(body), {
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
  // As the lock transaction does it (payroll-bank-snapshot.service.ts): after
  // the payslips exist, freeze each payee's bank details. The bank export
  // reads only this snapshot.
  if (input.status === "locked" && payees.length > 0)
    await withTenant(
      db,
      establishScopedTenantContext(
        establishTenantContext({
          tenantId: tenantIdSchema.parse(tenantId),
          brandId: null,
          source: "domain",
        }),
        { kind: "tenant" },
      ),
      (tx) => snapshotPayeeBankForLock(tx, tenantId, runId, payees),
    );
  return runId;
}

const mainSlips = () =>
  PEOPLE.map((person) => ({ person, method: person.method, net: person.net }));

let otherEntity: string;
let otherPolicy: string;
let lockedRun: string;

const bankFileCount = (runId: string) =>
  asTenant(tenant.id, async (db) =>
    Number(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = $2",
          [tenant.id, runId],
        )
      ).rows[0].n,
    ),
  );

const exportRun = (
  client: Client,
  runId: string,
  format: string = "generic_csv",
  idempotencyKey: string = key(),
) =>
  client
    .post(runPath(runId))
    .set(originHeader)
    .send({ format, idempotencyKey });

/** The scoped tenant context the route hands to the service. */
const tenantContext = (tenantId: string = tenant.id) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );

/** The legacy builder, called directly (the HTTP route is closed). */
const exportViaService = (
  runId: string,
  format: string = "generic_csv",
  idempotencyKey: string = key(),
) =>
  createBankTransferFile(
    tenantContext(),
    exporterId,
    runId as PayrollRunId,
    { format: format as BankTransferFormat, idempotencyKey },
    storageRuntime,
  );

type Refusal = { status: number; code: string; message: string };

/** Awaits a service call that must be refused and returns the error. */
async function refusalOf(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (error) {
    return error as Refusal;
  }
  throw new Error("expected the bank file export to be refused");
}

// ---- CSV helpers --------------------------------------------------------------

/** RFC 4180 parser: quoted cells, doubled quotes, CRLF or LF, BOM tolerated. */
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

/** Reads the exported bytes back through the signed `fileUrl` of the fake store. */
function downloadCsv(fileUrl: string): string {
  const url = new URL(fileUrl);
  expect(`${url.origin}${url.pathname}`).toBe(FAKE_STORE);
  const objectKey = url.searchParams.get("key");
  expect(objectKey, "signed URL carries the object key").not.toBeNull();
  const object = stored.get(objectKey!);
  expect(object, `object ${objectKey} is in storage`).toBeDefined();
  return typeof object!.content === "string"
    ? object!.content
    : Buffer.from(object!.content).toString("utf8");
}

type Exported = {
  file: ReturnType<typeof bankTransferFileSchema.parse>;
  text: string;
  rows: string[][];
  data: string[][];
};

async function exportOk(runId: string): Promise<Exported> {
  const file = bankTransferFileSchema.parse(await exportViaService(runId));
  const text = downloadCsv(file.fileUrl);
  const rows = parseCsv(text);
  return { file, text, rows, data: rows.slice(1) };
}

const DANGEROUS = /^[=+\-@\t\r]/;
/** Escaped form of a cell the CSV must carry for a dangerous leading char. */
const escaped = (value: string) =>
  DANGEROUS.test(value) ? `'${value}` : value;

// ---- Setup / teardown ---------------------------------------------------------

beforeAll(async () => {
  const lock = await signedInClient("Bank export locker");
  await grantRole(lock.userId, ["payroll.view", "payroll.run", "payroll.lock"]);
  exporter = lock.client;
  exporterId = lock.userId;
  const run = await signedInClient("Bank export runner");
  await grantRole(run.userId, ["payroll.view", "payroll.run"]);
  runner = run.client;
  const other = await signedInClient("Bank export stranger");
  await grantRole(other.userId, ["hr.employee.view"]);
  stranger = other.client;
  const hrUser = await signedInClient("Bank export HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;

  // Tenant B (cross-tenant 404).
  otherEntity = randomUUID();
  otherPolicy = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Bank export tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `bank-export-${otherTenant.slice(0, 8)}`, tenant.id],
  );

  const policy = (tenantId: string, entity: string, id: string) =>
    asTenant(tenantId, async (db) => {
      await db.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Bank Export', false)`,
        [entity, tenantId],
      );
      const code = `BX${id.slice(0, 8)}`;
      await db.query(
        `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                       employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
         VALUES ($1, $2, $3, 'Kebijakan Bank Export', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
        [id, tenantId, entity, code, JSON.stringify({ code })],
      );
    });
  await policy(tenant.id, entityId, policyId);
  await policy(otherTenant, otherEntity, otherPolicy);

  // Employees, then bank account / NIK / NPWP through the real HR PII route.
  await asTenant(tenant.id, async (db) => {
    for (const p of PEOPLE) {
      createdEmployees.push(p.id);
      await db.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                legal_entity_id, employment_type, join_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
        [
          p.id,
          tenant.id,
          `BE-${p.id.slice(0, 8).toUpperCase()}`,
          p.name,
          outlet.id,
          entityId,
        ],
      );
    }
  });
  for (const p of PEOPLE) {
    const put = await hr
      .put(`/api/hris/employees/${p.id}/pii`)
      .set(originHeader)
      .send({
        nik: p.nik,
        npwp: p.npwp,
        bankAccount: p.account,
        idempotencyKey: key(),
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }

  lockedRun = await seedRun(tenant.id, {
    status: "locked",
    slips: mainSlips(),
    totals: totalsOf(BANK_TOTAL, CASH_TOTAL),
  });
});

afterAll(async () => {
  await asTenant(
    tenant.id,
    async (db) => {
      await db.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'bank-export-%'",
        [tenant.id],
      );
      await db.query(
        "DELETE FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenant.id, createdRuns],
      );
      await db.query(
        "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenant.id, createdRuns],
      );
      await db.query(
        "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenant.id, createdRuns],
      );
      await db.query(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant.id, createdRuns],
      );
      await db.query("DELETE FROM payroll_policies WHERE id = $1", [policyId]);
      await db.query("DELETE FROM employees WHERE id = ANY($1)", [
        createdEmployees,
      ]);
      await db.query("DELETE FROM legal_entities WHERE id = $1", [entityId]);
      await db.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant.id, createdUsers],
      );
      await db.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant.id, createdRoles],
      );
    },
    true,
  );
  await asTenant(
    otherTenant,
    async (db) => {
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

// ---- Tests --------------------------------------------------------------------

describe("bank transfer file export: permission and run state", () => {
  it("[bank-export-auth] 401 anonymous, 403 without payroll.lock (even with payroll.view + payroll.run), 403 for a non-payroll user", async () => {
    expect(
      (
        await agent(app).post(runPath(lockedRun)).set(originHeader).send({
          format: "generic_csv",
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(401);
    expect((await exportRun(runner, lockedRun)).status).toBe(403);
    expect((await exportRun(stranger, lockedRun)).status).toBe(403);
    expect((await stranger.get(runPath(lockedRun))).status).toBe(403);
    // Nothing was written by the refused calls.
    expect(await bankFileCount(lockedRun)).toBe(0);
  });

  it("[bank-export-unlocked] an unlocked run (draft, simulated, hr_approved, approved) answers 409 and writes no file", async () => {
    for (const status of [
      "draft",
      "simulated",
      "hr_approved",
      "approved",
    ] as const) {
      const runId = await seedRun(tenant.id, { status });
      const refusal = await refusalOf(exportViaService(runId));
      expect(refusal.status, `${status}: ${refusal.message}`).toBe(409);
      expect(refusal.code).toBe("PAYROLL_RUN_NOT_LOCKED");
      expect(await bankFileCount(runId)).toBe(0);
      expect(storedKeysOf(runId)).toEqual([]);
    }
  });

  it("[bank-export-unsupported-format] mandiri/bni/bjb answer 422 format_not_supported and write no file; an unknown format is 422 too", async () => {
    const runId = await seedRun(tenant.id, {
      status: "locked",
      slips: mainSlips(),
      totals: totalsOf(BANK_TOTAL, CASH_TOTAL),
    });
    for (const format of ["mandiri", "bni", "bjb"]) {
      const refusal = await refusalOf(exportViaService(runId, format));
      expect(refusal.status, `${format}: ${refusal.message}`).toBe(422);
      expect(refusal.code).toBe("PAYROLL_BANK_FORMAT_NOT_SUPPORTED");
    }
    // An unknown format fails the route's body schema (before the closed-route 409).
    expect((await exportRun(exporter, runId, "not-a-bank")).status).toBe(422);
    expect(await bankFileCount(runId)).toBe(0);
    expect(storedKeysOf(runId)).toEqual([]);
  });

  it("[bank-export-cross-tenant] a run of another tenant and an unknown run both answer 404", async () => {
    const foreign = await seedRun(otherTenant, {
      status: "locked",
      totals: totalsOf(0, 0),
    });
    expect((await refusalOf(exportViaService(foreign))).status).toBe(404);
    expect((await exporter.get(runPath(foreign))).status).toBe(404);
    expect((await refusalOf(exportViaService(randomUUID()))).status).toBe(404);
    const foreignFiles = await owner.query(
      "SELECT 1 FROM bank_transfer_files WHERE tenant_id = $1",
      [otherTenant],
    );
    expect(foreignFiles.rowCount).toBe(0);
  });
});

describe("bank transfer file export: generic_csv content", () => {
  it("[bank-export-rows] the file holds exactly the bank_transfer payslips with net > 0, per-employee amount = net, total = run bankTransferIdr", async () => {
    const { file, data } = await exportOk(lockedRun);

    expect(file.payrollRunId).toBe(lockedRun);
    expect(file.format).toBe("generic_csv");
    expect(file.rowCount).toBe(bankPeople.length);
    expect(file.totalIdr).toBe(BANK_TOTAL);

    // One row per expected employee, found by account number cell.
    expect(data).toHaveLength(bankPeople.length);
    let fileTotal = 0;
    for (const person of bankPeople) {
      const matches = data.filter((row) => row.includes(person.account));
      expect(matches, `row for ${person.account}`).toHaveLength(1);
      const row = matches[0]!;
      expect(row, "net pay as a plain integer cell").toContain(
        String(person.net),
      );
      expect(row).toContain(escaped(person.name));
      fileTotal += person.net;
    }
    expect(fileTotal).toBe(BANK_TOTAL);

    // Excluded people never appear: cash and net 0.
    const everything = data.flat();
    for (const person of PEOPLE.filter((p) => !bankPeople.includes(p)))
      expect(everything).not.toContain(person.account);

    // The run totals in the database are what the file total was checked against.
    const run = await asTenant(tenant.id, (db) =>
      db.query("SELECT totals FROM payroll_runs WHERE id = $1", [lockedRun]),
    );
    expect(run.rows[0].totals.bankTransferIdr).toBe(file.totalIdr);
  });

  it("[bank-export-no-overpay] file total never exceeds the run's bank transfer total and the checksum matches the downloaded bytes", async () => {
    const { file, text, data } = await exportOk(lockedRun);
    const run = await asTenant(tenant.id, (db) =>
      db.query("SELECT totals FROM payroll_runs WHERE id = $1", [lockedRun]),
    );
    const bankTransferIdr = run.rows[0].totals.bankTransferIdr as number;
    expect(file.totalIdr).toBeLessThanOrEqual(bankTransferIdr);
    expect(file.totalIdr).toBe(bankTransferIdr);
    // Integer rupiah only: every amount cell is digits, no decimals or signs.
    for (const row of data) {
      const amounts = row.filter((cell) => /^\d{1,15}$/.test(cell));
      expect(amounts.length).toBeGreaterThan(0);
    }
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(
      file.checksumSha256,
    );
  });

  it("[bank-export-net-1253] file total equals the sum of net pay of the run's own bank_transfer payslips, read back from the sealed payslips", async () => {
    const { file, data } = await exportOk(lockedRun);
    const slips = await asTenant(tenant.id, (db) =>
      db.query(
        `SELECT id, tenant_id, payment_method, calculation_encrypted, pii_key_version
           FROM payslips WHERE payroll_run_id = $1`,
        [lockedRun],
      ),
    );
    const netOf = (row: Record<string, unknown>) =>
      openPayslipCalculation({
        id: row.id as never,
        tenantId: row.tenant_id as never,
        calculationEncrypted: row.calculation_encrypted as Buffer,
        piiKeyVersion: row.pii_key_version as number,
      }).netIdr;
    const bankNet = slips.rows
      .filter((row) => row.payment_method === "bank_transfer")
      .map(netOf)
      .filter((net) => net > 0);
    expect(bankNet.length).toBeGreaterThan(0);
    expect(file.totalIdr).toBe(bankNet.reduce((sum, net) => sum + net, 0));
    expect(file.rowCount).toBe(bankNet.length);
    expect(data).toHaveLength(bankNet.length);
  });

  it("[bank-export-mismatch] payslips that disagree with the run bank total are refused with 409 PAYROLL_BANK_FILE_MISMATCH and no file", async () => {
    const [a, b] = bankPeople as [Person, Person];
    // Payslips add up to 3.000.000 but the sealed run total says 3.500.000:
    // writing the file from the total would overpay, so the export refuses.
    const runId = await seedRun(tenant.id, {
      status: "locked",
      slips: [
        { person: a, method: "bank_transfer", net: 1_000_000 },
        { person: b, method: "bank_transfer", net: 2_000_000 },
      ],
      totals: totalsOf(3_500_000, 0),
    });
    const refusal = await refusalOf(exportViaService(runId));
    expect(refusal.status, refusal.message).toBe(409);
    expect(refusal.code).toBe("PAYROLL_BANK_FILE_MISMATCH");
    expect(await bankFileCount(runId)).toBe(0);
    expect(storedKeysOf(runId)).toEqual([]);
  });

  it("[bank-export-empty] a locked run with no bank_transfer payslip of net > 0 answers 422 PAYROLL_BANK_FILE_EMPTY and writes no file", async () => {
    const [cash, zero] = [
      PEOPLE.find((p) => p.method === "cash")!,
      PEOPLE.find((p) => p.method === "bank_transfer" && p.net === 0)!,
    ];
    const runId = await seedRun(tenant.id, {
      status: "locked",
      slips: [
        { person: cash, method: "cash", net: cash.net },
        { person: zero, method: "bank_transfer", net: 0 },
      ],
      totals: totalsOf(0, cash.net),
    });
    const refusal = await refusalOf(exportViaService(runId));
    expect(refusal.status, refusal.message).toBe(422);
    expect(refusal.code).toBe("PAYROLL_BANK_FILE_EMPTY");
    expect(await bankFileCount(runId)).toBe(0);
    expect(storedKeysOf(runId)).toEqual([]);
  });

  it("[bank-export-readonly] exporting changes no payslip and no run amount", async () => {
    const runId = await seedRun(tenant.id, {
      status: "locked",
      slips: mainSlips(),
      totals: totalsOf(BANK_TOTAL, CASH_TOTAL),
    });
    const snapshot = () =>
      asTenant(tenant.id, async (db) => {
        const rows = await db.query(
          `SELECT (SELECT to_jsonb(r) FROM payroll_runs r WHERE r.id = $1) AS run,
                  (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payslips p
                    WHERE p.payroll_run_id = $1) AS payslips`,
          [runId],
        );
        return rows.rows[0];
      });
    const before = await snapshot();
    const file = await exportViaService(runId);
    expect(file.rowCount).toBe(bankPeople.length);
    expect(await bankFileCount(runId)).toBe(1);
    expect(await snapshot()).toEqual(before);
  });

  it("[bank-export-csv-injection] cells starting with = + - @ are prefixed with ', RFC 4180 quoting round-trips, no cell starts with a formula character", async () => {
    const { data, text } = await exportOk(lockedRun);
    const cells = data.flat();

    for (const cell of cells) expect(cell).not.toMatch(DANGEROUS);

    for (const person of bankPeople)
      expect(cells, `name cell of ${person.name}`).toContain(
        escaped(person.name),
      );
    // Explicit samples, independent of the helper above.
    expect(cells).toContain("'=cmd|' /C calc'!A0");
    expect(cells).toContain("'-Dash Name");
    expect(cells).toContain("'@Atname");
    // A comma and doubled quotes survive: parsed back to the original.
    expect(cells).toContain(`Siti "Cici", S.Kom`);
    // And on the wire the quoted cell is RFC 4180 (doubled quotes, wrapped).
    expect(text).toContain(`"Siti ""Cici"", S.Kom"`);
  });
});

describe("bank transfer file export: run reversed after export", () => {
  it("[bank-export-reversed] once the run is reversed, list and a replayed create answer 409 PAYROLL_RUN_NOT_LOCKED and expose no download URL", async () => {
    const runId = await seedRun(tenant.id, {
      status: "locked",
      slips: mainSlips(),
      totals: totalsOf(BANK_TOTAL, CASH_TOTAL),
    });
    const idempotencyKey = key();
    const file = bankTransferFileSchema.parse(
      await exportViaService(runId, "generic_csv", idempotencyKey),
    );
    expect(await bankFileCount(runId)).toBe(1);

    // Reverse the run straight in the database, as the other payroll tests
    // do for run status (triggers off: only the status matters here).
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

    const signedBefore = signedLookups.length;
    const noUrl = (text: string) => {
      expect(text).not.toContain(file.fileUrl);
      expect(text).not.toContain(FAKE_STORE);
      expect(text).not.toContain("sig=");
      expect(text).not.toContain("fileUrl");
    };

    const list = await exporter.get(runPath(runId));
    expect(list.status, JSON.stringify(list.body)).toBe(409);
    expect(list.body.error.code).toBe("PAYROLL_RUN_NOT_LOCKED");
    noUrl(list.text);

    const replay = await refusalOf(
      exportViaService(runId, "generic_csv", idempotencyKey),
    );
    expect(replay.status, replay.message).toBe(409);
    expect(replay.code).toBe("PAYROLL_RUN_NOT_LOCKED");
    noUrl(JSON.stringify(replay));

    // No URL was even minted for the reversed run, and no second file exists.
    expect(signedLookups.length).toBe(signedBefore);
    expect(await bankFileCount(runId)).toBe(1);
  });
});

describe("bank transfer file export: PII handling", () => {
  it("[bank-export-private-storage] the file is stored private as CSV and handed out only through a short-lived signed URL", async () => {
    signedLookups.length = 0;
    const { file } = await exportOk(lockedRun);
    const object = [...stored.values()].find(
      (item) => item.key === new URL(file.fileUrl).searchParams.get("key"),
    );
    expect(object?.visibility).toBe("private");
    expect(object?.contentType).toMatch(/csv/i);
    expect(object?.key).toContain(lockedRun);
    expect(signedLookups.length).toBeGreaterThan(0);
    for (const lookup of signedLookups) {
      expect(lookup.visibility).toBe("private");
      expect(lookup.expiresInSeconds).toBeLessThanOrEqual(900);
    }
  });

  it("[bank-export-no-pii-in-logs] the export request logs no account number, NIK, NPWP, employee name or file content", async () => {
    logLines.length = 0;
    // The route is closed (409), but the request is still logged: it must carry
    // no PII. The file is then built through the service, which must not log
    // PII either (it has no logger of its own).
    const closed = await exportRun(exporter, lockedRun);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe("LEGACY_BANK_EXPORT_DISABLED");
    const { text } = await exportOk(lockedRun);
    const logged = logLines.join("");
    expect(logged.length).toBeGreaterThan(0); // the request itself was logged
    for (const person of PEOPLE) {
      expect(logged).not.toContain(person.account);
      expect(logged).not.toContain(person.nik);
      expect(logged).not.toContain(person.npwp);
      expect(logged).not.toContain(person.name);
    }
    // No row of the file leaked as a whole line either.
    for (const row of parseCsv(text).slice(1))
      expect(logged).not.toContain(row.join(","));
  });

  it("[bank-export-audit] the export is audited without any PII value", async () => {
    const { file } = await exportOk(lockedRun);
    const rows = await asTenant(tenant.id, (db) =>
      db.query<{ text: string }>(
        `SELECT event::text AS text FROM audit_logs
          WHERE tenant_id = $1
            AND (event::text LIKE '%' || $2 || '%' OR event::text LIKE '%' || $3 || '%')`,
        [tenant.id, file.id, lockedRun],
      ),
    );
    expect(rows.rowCount).toBeGreaterThan(0);
    // The export hands out salary-bank PII: its audit row is flagged as
    // sensitive access (event.sensitiveAccess, see core-audit.ts).
    const created = await asTenant(tenant.id, (db) =>
      db.query<{ sensitive: string | null; action: string }>(
        `SELECT event->>'sensitiveAccess' AS sensitive, event->>'action' AS action
           FROM audit_logs
          WHERE tenant_id = $1 AND event->>'objectId' = $2`,
        [tenant.id, file.id],
      ),
    );
    expect(created.rowCount).toBeGreaterThan(0);
    for (const row of created.rows) expect(row.sensitive).toBe("true");
    const audited = rows.rows.map((row) => row.text).join("\n");
    for (const person of PEOPLE) {
      expect(audited).not.toContain(person.account);
      expect(audited).not.toContain(person.nik);
      expect(audited).not.toContain(person.npwp);
      expect(audited).not.toContain(person.name);
    }
  });

  it("[bank-export-list] listing the files of a run returns the created file without any PII", async () => {
    const runId = await seedRun(tenant.id, {
      status: "locked",
      slips: mainSlips(),
      totals: totalsOf(BANK_TOTAL, CASH_TOTAL),
    });
    const created = await exportViaService(runId);
    const list = await exporter.get(runPath(runId));
    expect(list.status).toBe(200);
    const ids = (list.body.data as { id: string }[]).map((item) => item.id);
    expect(ids).toContain(created.id);
    for (const person of PEOPLE) {
      expect(list.text).not.toContain(person.account);
      expect(list.text).not.toContain(person.name);
    }
  });
});
