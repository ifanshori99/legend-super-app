// Payroll manual bank channel and cash handover (bead legend-648; design
// docs/design/payroll-disbursement.md 5.2, 6 R14/R15, 7.7, 7.9; brief
// 648-brief.md). Rules: R14 the bank file comes out once, R15 the per-PT
// `enabled` switch is checked at export, hash and approval expiry are checked
// at export, the requester never confirms (R5), a run turns `paid` only when
// every net > 0 slip has a succeeded item (R10) and then `payroll.paid` leaves
// the outbox once with `settledPerItem` (card .5, bead legend-658), a payment
// proof key lies in this tenant's folder of the batch (L5), net pay is paid in full (R8/R9: the fee is borne by
// the PT, never subtracted), file rows come from the lock-time snapshot only.
//
// Interfaces under test (names from the brief; none exist yet):
//   services/payroll-payout-manual.service.ts
//     exportManualBatch(tx, actor, batchId)
//       -> { filename, contentType, content, checksumSha256 }
//     confirmManualItems(tx, actor, batchId,
//       { results: [{ itemId, result: 'succeeded', bankRef, evidenceKey? }] })
//       (fix round 1, H2: 'failed' is no longer accepted here)
//     resolveManualItems(tx, actor, batchId,
//       { itemIds, outcome: 'failed'|'not_sent', evidenceKey, note })
//       (fix round 1, H2: two different non-requesters, same outcome, evidence)
//     confirmCashHandover(tx, actor, batchId, { itemIds, evidenceKey? })
//   plus the batch services used by payroll-payout-core.test.ts.
//
// Assumptions (brief silent, stated so the engineer can contest them):
// - The PT test config uses format generic_csv (layout from
//   payroll-bank-export.test.ts: one data row per payee holding the account
//   number and the plain integer net pay as cells; header first, CRLF). BCA is
//   covered in payroll-bank-format-bca.test.ts.
// - `content` is text (string); `checksumSha256` is the lowercase hex SHA-256
//   of exactly that content.
// - The bank reference of a confirmed item is stored in
//   `confirmation_ref`, the evidence file key in `confirmation_evidence_key`.
// - Codes asserted exactly: PAYOUT_EXPORT_ALREADY_DOWNLOADED (409),
//   PAYOUT_APPROVAL_EXPIRED, PAYOUT_HASH_MISMATCH, PAYOUT_CONFIRM_SELF.
//   Disabled config, export before approval, confirm before export, double
//   confirm, missing bank reference: only "4xx HttpError, nothing changed".
// - The audit action names are unknown, so audit rows are not asserted here.
// Fix round 1 (648-fix1.md) assumptions:
// - H1: the legacy bank file is the HTTP route
//   POST /api/hris/payroll/runs/:id/bank-transfer-files (user with payroll.lock);
//   a cash batch never blocks it and a cancelled batch does not either.
// - H2: only the codes named in the brief are asserted exactly
//   (PAYOUT_RESOLVE_SAME_PERSON 403, PAYOUT_RESOLVE_OUTCOME_MISMATCH 409).
//   The requester resolving (first or second step), an empty evidence key and
//   an item that is not `exported` are only asserted as "4xx HttpError,
//   nothing changed". A confirm with result 'failed' is only asserted as
//   "rejected, item stays exported" (zod or HttpError, either way).
// - H2 DB: the control update for the allowed transition sets failure_class
//   'definitive' on `failed` (brief) and nothing extra on `not_sent`.
// - M2: cancelling a cash batch with some succeeded items is allowed for the
//   requester; the cash handover also checks approval_expires_at.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CoreError, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { payrollConfigSnapshotSchema } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import type { Tx } from "../services/hris-access.ts";
import { snapshotPayeeBankForLock } from "../services/payroll-bank-snapshot.service.ts";
import {
  approveDisbursementBatch,
  cancelDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  confirmCashHandover,
  confirmManualItems,
  exportManualBatch,
  resolveManualItems,
} from "../services/payroll-payout-manual.service.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import type { ObjectStorage, StorageRequest } from "@starter/shared/adapters";
import { agent, originHeader, signUp } from "./helpers.ts";

// In-memory object storage: the legacy bank file route (H1) answers 503
// without a storage runtime.
const stored = new Map<string, StorageRequest>();
const fakeStorage: ObjectStorage = {
  put: async (_context, input) => {
    stored.set(input.key, input);
    return { reference: input.reference, accepted: true };
  },
  get: async (_context, input) => {
    const found = stored.get(input.key);
    if (!found) throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
    return found;
  },
  delete: async (_context, input) => {
    stored.delete(input.key);
  },
  signedGetUrl: async (_context, input) =>
    `https://payout-manual-store.example.test/object?key=${encodeURIComponent(input.key)}&sig=fake`,
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

const app = createApp({ storageRuntime });
const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const REQ = `payout-req-${randomUUID()}`;
const APP = `payout-app-${randomUUID()}`;
const APP2 = `payout-app2-${randomUUID()}`;
const actor = (userId: string) => ({ tenantId: tenant.id as string, userId });
/**
 * Stores a payment proof under the only key shape accepted (legend-658 L5) and
 * returns its key: confirm, resolve and return refuse a key whose object is not
 * stored (legend-01gg8).
 */
const uploadEvidence = (batchId: string, file: string) => {
  const key = `tenants/${tenant.id}/payroll-payout/${batchId}/${file}`;
  stored.set(key, {
    tenantId: tenant.id,
    outletId: null,
    reference: file,
    key,
    contentType: "application/pdf",
    content: "bukti",
    visibility: "private",
  } as StorageRequest);
  return key;
};

const proofs = () => ({ storage: fakeStorage, context: scope() });
const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.id),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
const inTx = <T>(run: (tx: Tx) => Promise<T>) => withTenant(db, scope(), run);

// ---- Database helpers -----------------------------------------------------

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

type Row = Record<string, unknown>;
const rowsOf = (sql: string, params: unknown[] = []) =>
  asTenant(async (c) => (await c.query(sql, params)).rows as Row[]);

const httpFailure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error as HttpError,
  );

/** The call is refused with a 4xx HttpError (optionally this exact code). */
async function expectRefused(
  work: Promise<unknown>,
  expected: { status?: number; code?: string } = {},
) {
  const error = await httpFailure(work);
  expect(error, "the call must be refused").toBeInstanceOf(HttpError);
  expect(error!.status).toBeGreaterThanOrEqual(400);
  expect(error!.status).toBeLessThan(500);
  if (expected.status) expect(error!.status).toBe(expected.status);
  if (expected.code) expect(error!.code).toBe(expected.code);
}

async function signedInClient(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return { client, userId };
}
const createdUsers: string[] = [];
const createdRoles: string[] = [];
async function grantRole(userId: string, permissions: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant.id,
        `Payout manual ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await c.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.id, userId, roleId],
    );
  });
}

// ---- Fixtures: people, legal entity, bank account, payout config, runs -----

type Person = {
  id: string;
  name: string;
  account: string;
  bankCode: string | null;
};
let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};
const person = (name: string, bankCode: string | null): Person => ({
  id: randomUUID(),
  name,
  account: digits(12),
  bankCode,
});
const BUDI = person("Budi Santoso", "014");
const SITI = person("Siti Aminah", "014");
const ANDI = person("Andi Wijaya", "014");
const NOCODE = person("Tanpa Kode Bank", null);
const CASHIER = person("Kasir Tunai", "014");
const MOVER = person("Pindah Rekening", "014");
const ALL_PEOPLE = [BUDI, SITI, ANDI, NOCODE, CASHIER, MOVER];

const entityId = randomUUID();
const policyId = randomUUID();
const createdRuns: string[] = [];
const createdEmployees: string[] = [];
let bankAccountId = "";
let hr: Awaited<ReturnType<typeof signedInClient>>["client"];
let locker: Awaited<ReturnType<typeof signedInClient>>["client"]; // payroll.lock: legacy bank file

const day = (n: number) =>
  new Date(Date.UTC(2042, 0, 1 + n)).toISOString().slice(0, 10);

const STEPS = [
  `status = 'simulated', simulation_count = 1, last_simulated_at = now()`,
  `status = 'hr_approved', approved_by_hr = '00000000-0000-4000-8000-0000000000a1', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = '00000000-0000-4000-8000-0000000000a2', approved_by_finance_at = now()`,
];

function calculation(p: Person, net: number, method: string, days: string[]) {
  return {
    employeeId: p.id,
    employeeNo: `PO-${p.id.slice(0, 8).toUpperCase()}`,
    employeeName: p.name,
    positionName: null,
    outletId: outlet.id,
    periodStart: days[0],
    periodEnd: days[1],
    payDate: days[1],
    grossIdr: net,
    deductionsIdr: 0,
    netIdr: net,
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
        amountIdr: net,
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
      taxableGrossIdr: net,
      pph21Idr: 0,
      pph21WithheldIdr: 0,
      taxAllowanceIdr: 0,
      pph21EmployerBorneIdr: 0,
      pph21RefundIdr: 0,
      pph21EmployerRefundIdr: 0,
      noTaxIdSurchargeApplied: false,
      grossSchemeBaseIdr: net,
      employerSchemeBaseIdr: 0,
    },
    paymentMethod: method,
  };
}

type Slip = { person: Person; method: "bank_transfer" | "cash"; net: number };
const bank = (p: Person, net: number): Slip => ({
  person: p,
  method: "bank_transfer",
  net,
});
const cash = (p: Person, net: number): Slip => ({
  person: p,
  method: "cash",
  net,
});

/** Run totals that pass payrollRunTotalsSchema (net = bank + cash, gross = net, no tax). */
function runTotals(slips: Slip[]) {
  const sum = (method: string) =>
    slips
      .filter((s) => s.method === method)
      .reduce((total, s) => total + s.net, 0);
  const net = sum("bank_transfer") + sum("cash");
  return {
    employeeCount: slips.length,
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
    bankTransferIdr: sum("bank_transfer"),
    cashIdr: sum("cash"),
  };
}

/** A config snapshot that passes payrollConfigSnapshotSchema (parsed when a run is read by the services). */
function runSnapshot() {
  return payrollConfigSnapshotSchema.parse({
    statutoryVersions: [
      {
        type: "pph21_ter",
        versionId: randomUUID(),
        version: 9300,
        effectiveFrom: "2002-01-01",
      },
    ],
    policy: {
      id: policyId,
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

/** A `locked` run with sealed payslips and the lock-time bank snapshots. */
async function seedRun(
  slips: Slip[],
  status: "locked" | "approved" = "locked",
) {
  const runId = randomUUID();
  createdRuns.push(runId);
  const start = ++counter * 3;
  const days = [day(start), day(start + 1)];
  const payees: { payslipId: string; employeeId: string }[] = [];
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, '00000000-0000-4000-8000-0000000000a4')`,
      [runId, tenant.id, entityId, policyId, days[0], days[1]],
    );
    for (const step of STEPS)
      await c.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [runId]);
    if (status === "locked")
      await c.query(
        `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
                totals = $2::jsonb, locked_by = '00000000-0000-4000-8000-0000000000a3', locked_at = now()
          WHERE id = $1`,
        [
          runId,
          JSON.stringify(runTotals(slips)),
          JSON.stringify(runSnapshot()),
        ],
      );
    for (const slip of slips) {
      const id = randomUUID();
      if (slip.method === "bank_transfer" && slip.net > 0)
        payees.push({ payslipId: id, employeeId: slip.person.id });
      await c.query(
        `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                               calculation_encrypted, pii_key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          tenant.id,
          runId,
          slip.person.id,
          slip.method,
          sealPayrollValue(
            JSON.stringify(
              calculation(slip.person, slip.net, slip.method, days),
            ),
            {
              tenantId: tenant.id,
              table: "payslips",
              rowId: id,
              field: "calculation",
            },
          ),
          PAYROLL_SEAL_KEY_VERSION,
        ],
      );
    }
  });
  if (status === "locked" && payees.length > 0)
    await inTx((tx) => snapshotPayeeBankForLock(tx, tenant.id, runId, payees));
  return runId;
}

// ---- Service flow helpers -------------------------------------------------

const batchRow = async (runId: string, channel = "manual_bank") =>
  (
    await rowsOf(
      `SELECT * FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND channel = $3
        ORDER BY created_at DESC LIMIT 1`,
      [tenant.id, runId, channel],
    )
  )[0];
const batchById = async (batchId: string) =>
  (
    await rowsOf("SELECT * FROM payroll_disbursement_batches WHERE id = $1", [
      batchId,
    ])
  )[0]!;
const itemsOf = (batchId: string) =>
  rowsOf(
    `SELECT * FROM payroll_disbursement_items WHERE batch_id = $1 ORDER BY created_at, id`,
    [batchId],
  );
const itemOfPerson = async (batchId: string, p: Person) =>
  (
    await rowsOf(
      `SELECT i.* FROM payroll_disbursement_items i
        WHERE i.batch_id = $1 AND i.employee_id = $2`,
      [batchId, p.id],
    )
  )[0];
const runStatus = async (runId: string) =>
  (await rowsOf("SELECT status FROM payroll_runs WHERE id = $1", [runId]))[0]!
    .status as string;

async function createBatch(runId: string, channel = "manual_bank") {
  await inTx((tx) =>
    createDisbursementBatch(tx, actor(REQ), {
      payrollRunId: runId,
      channel,
    } as never),
  );
  return (await batchRow(runId, channel))!.id as string;
}
const submit = (batchId: string, by = REQ) =>
  inTx((tx) => submitDisbursementBatch(tx, actor(by), batchId));
async function approve(batchId: string, by = APP, contentHash?: string) {
  const batch = await batchById(batchId);
  const hash = contentHash ?? (batch.content_hash as string);
  return inTx((tx) =>
    approveDisbursementBatch(tx, actor(by), batchId, {
      contentHash: hash,
      // The account the approver saw (legend-3j9yz): the configured source
      // for manual_bank, null for other channels.
      sourceBankAccountId:
        batch.channel === "manual_bank" ? bankAccountId : null,
    }),
  );
}
async function approvedBatch(runId: string, channel = "manual_bank") {
  const id = await createBatch(runId, channel);
  await submit(id);
  await approve(id);
  return id;
}

// ---- Setup / teardown ---------------------------------------------------------

beforeAll(async () => {
  const hrUser = await signedInClient("Payout manual HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;
  const lockUser = await signedInClient("Payout manual locker");
  await grantRole(lockUser.userId, [
    "payroll.view",
    "payroll.run",
    "payroll.lock",
  ]);
  locker = lockUser.client;

  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Payout Manual', false)`,
      [entityId, tenant.id],
    );
    const code = `PC${policyId.slice(0, 8)}`;
    await c.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Payout Manual', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
      [policyId, tenant.id, entityId, code, JSON.stringify({ code })],
    );
    const gl = (
      await c.query(
        `INSERT INTO chart_of_accounts
           (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
         VALUES ($1, $2, '1103', 'Bank', 'asset', 'cash_and_equivalents', NULL, true)
         RETURNING id`,
        [tenant.id, entityId],
      )
    ).rows[0].id as string;
    bankAccountId = (
      await c.query(
        `INSERT INTO bank_accounts
           (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
            account_number_hmac, account_number_last4, account_number_key_version,
            gl_account_id, created_by)
         VALUES ($1, $2, 'BCA', 'Rekening Gaji', '\\x00', $3, '0000', 1, $4, 'payout-manual-test')
         RETURNING id`,
        [tenant.id, entityId, "b".repeat(64), gl],
      )
    ).rows[0].id as string;

    // Bank charges role (legend-8codi): approve and export are refused without it.
    await c.query(
      `INSERT INTO chart_of_accounts
         (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
       VALUES ($1, $2, '8101', 'Beban Administrasi Bank', 'expense', 'other_expense', NULL, true)`,
      [tenant.id, entityId],
    );
    await c.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       SELECT $1, $2, 'bank_charges', id FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '8101'`,
      [tenant.id, entityId],
    );
    for (const p of ALL_PEOPLE) {
      createdEmployees.push(p.id);
      await c.query(
        `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                legal_entity_id, employment_type, join_date, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
        [
          p.id,
          tenant.id,
          `PO-${p.id.slice(0, 8).toUpperCase()}`,
          p.name,
          outlet.id,
          entityId,
        ],
      );
    }
  });
  for (const p of ALL_PEOPLE) {
    const put = await hr
      .put(`/api/hris/employees/${p.id}/pii`)
      .set(originHeader)
      .send({
        nik: digits(16),
        npwp: digits(15),
        bankAccount: p.account,
        idempotencyKey: `payout-manual-${randomUUID()}`,
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  // employees.bank_code (migration 0345): the 3-digit BI code, copied into the
  // snapshot at lock.
  await asTenant(async (c) => {
    for (const p of ALL_PEOPLE)
      await c.query(`UPDATE employees SET bank_code = $2 WHERE id = $1`, [
        p.id,
        p.bankCode,
      ]);
  }, true);
  await setConfig({ enabled: true });
});

/** Payout config of the test PT, written straight into the table. */
async function setConfig(values: { enabled: boolean }) {
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO payroll_payout_configs
         (tenant_id, legal_entity_id, method, manual_source_bank_account_id,
          manual_bank_format, enabled, updated_by)
       VALUES ($1, $2, 'manual_bank', $3, 'generic_csv', $4, 'payout-manual-test')
       ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET enabled = $4`,
      [tenant.id, entityId, bankAccountId, values.enabled],
    );
  }, true);
}

afterAll(async () => {
  await asTenant(async (c) => {
    const del = (sql: string, params: unknown[]) => c.query(sql, params);
    await del(
      "DELETE FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await del(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'payout-legacy-%'",
      [tenant.id],
    );
    await del(
      "DELETE FROM payroll_disbursement_items WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await del(
      "DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await del(
      "DELETE FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenant.id, entityId],
    );
    await del(
      "DELETE FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenant.id, entityId],
    );
    await del(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenant.id, entityId],
    );
    await del(
      "DELETE FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenant.id, entityId],
    );
    await del(
      "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await del(
      "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await del(
      "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
      [tenant.id, createdRuns],
    );
    await del("DELETE FROM payroll_policies WHERE id = $1", [policyId]);
    await del("DELETE FROM employees WHERE id = ANY($1)", [createdEmployees]);
    await del("DELETE FROM legal_entities WHERE id = $1", [entityId]);
    await del(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenant.id, createdUsers],
    );
    await del("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
      tenant.id,
      createdRoles,
    ]);
  }, true);
  await owner.end();
});

// ---- Manual-channel helpers ------------------------------------------------

const exportBatch = (batchId: string, by = APP) =>
  inTx((tx) => exportManualBatch(tx, actor(by), batchId));
const confirm = (
  batchId: string,
  results: {
    itemId: string;
    result: "succeeded";
    bankRef?: string;
    evidenceKey?: string;
  }[],
  by = APP,
) =>
  inTx((tx) =>
    confirmManualItems(tx, actor(by), batchId, { results } as never, proofs()),
  );
const resolve = (
  batchId: string,
  itemIds: string[],
  outcome: "failed" | "not_sent",
  by: string,
  extra: { evidenceKey?: string; note?: string } = {},
) =>
  inTx((tx) =>
    resolveManualItems(
      tx,
      actor(by),
      batchId,
      {
        itemIds,
        outcome,
        evidenceKey:
          extra.evidenceKey ?? uploadEvidence(batchId, "resolve.pdf"),
        note: extra.note ?? "Bank menolak transfer, tidak ada dana keluar",
      } as never,
      proofs(),
    ),
  );
const cancelBatch = (batchId: string, by = REQ) =>
  inTx((tx) =>
    cancelDisbursementBatch(tx, actor(by), batchId, { reason: "uji batal" }),
  );
/** Any rejection (HttpError or a validation error), nothing else asserted. */
const rejected = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error as Error,
  );
type PgError = { code?: string; constraint?: string; message?: string };
const pgFailure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error as PgError,
  );
/** Clone a row (all columns) under a new id, then apply SQL overrides. Triggers stay on. */
async function cloneRow(table: string, id: string, overrides: string) {
  return asTenant(async (c) => {
    await c.query(
      `CREATE TEMP TABLE payout_clone ON COMMIT DROP AS SELECT * FROM ${table} WHERE id = $1`,
      [id],
    );
    await c.query(
      `UPDATE payout_clone SET id = gen_random_uuid()${overrides ? `, ${overrides}` : ""}`,
    );
    await c.query(`INSERT INTO ${table} SELECT * FROM payout_clone`);
  });
}
const legacyPath = (runId: string) =>
  `/api/hris/payroll/runs/${runId}/bank-transfer-files`;
const legacyExport = (runId: string) =>
  locker
    .post(legacyPath(runId))
    .set(originHeader)
    .send({
      format: "generic_csv",
      idempotencyKey: `payout-legacy-${randomUUID()}`,
    });
const bankFileCount = async (runId: string) =>
  Number(
    (
      await rowsOf(
        "SELECT count(*)::int AS n FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, runId],
      )
    )[0]!.n,
  );
const handover = (batchId: string, itemIds: string[], by = APP) =>
  inTx((tx) =>
    confirmCashHandover(tx, actor(by), batchId, {
      itemIds,
    } as never),
  );
const succeedAll = (items: Row[], batchId: string) =>
  items.map((item, index) => ({
    itemId: item.id as string,
    result: "succeeded" as const,
    bankRef: `BCA-REF-${batchId.slice(0, 8)}-${index}`,
    evidenceKey: uploadEvidence(batchId, "laporan.pdf"),
  }));
const liveItems = async (batchId: string) =>
  (await itemsOf(batchId)).filter((i) => i.status !== "cancelled");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const paidEvents = async (runId: string) =>
  Number(
    (
      await rowsOf(
        `SELECT count(*)::int AS n FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'payroll.paid'
            AND event::text LIKE '%' || $2 || '%'`,
        [tenant.id, runId],
      )
    )[0]!.n,
  );

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// ---- Tests ----------------------------------------------------------------

describe("R14 the bank file comes out once", () => {
  it("[export-file] export returns the file of approved items only, net pay in full, checksum stored, batch and items exported", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_250_000),
      bank(SITI, 3_100_500),
      bank(ANDI, 5_000_001),
      bank(NOCODE, 1_000_000),
      cash(CASHIER, 2_000_000),
    ]);
    const batchId = await approvedBatch(runId);
    const file = await exportBatch(batchId);

    expect(file.filename).toMatch(/\.csv$/);
    expect(file.contentType).toMatch(/^text\/csv/);
    const content = String(file.content);
    expect(file.checksumSha256).toBe(sha256(content));

    const data = parseCsv(content).slice(1);
    expect(data).toHaveLength(3);
    for (const [p, net] of [
      [BUDI, 4_250_000],
      [SITI, 3_100_500],
      [ANDI, 5_000_001],
    ] as const) {
      const row = data.find((cells) => cells.includes(p.account));
      expect(row, `row of ${p.name}`).toBeDefined();
      // R8/R9: the amount is the net pay itself. The PT bears the bank fee.
      expect(row).toContain(String(net));
    }
    expect(content).not.toContain(NOCODE.account);
    expect(content).not.toContain(CASHIER.account);

    const batch = await batchById(batchId);
    expect(batch.status).toBe("exported");
    expect(batch.export_checksum_sha256).toBe(file.checksumSha256);
    expect(batch.exported_by).toBe(APP);
    expect(batch.exported_at).not.toBeNull();
    // Only the checksum is kept, never the file or a payee account number.
    const stored = JSON.stringify(batch);
    for (const p of [BUDI, SITI, ANDI]) expect(stored).not.toContain(p.account);
    const items = await itemsOf(batchId);
    expect(items.filter((i) => i.status === "exported")).toHaveLength(3);
    expect(items.filter((i) => i.status === "cancelled")).toHaveLength(1);
    for (const item of items.filter((i) => i.status === "exported"))
      expect(item.fee_idr_encrypted, "fee is sealed per item").not.toBeNull();
  });

  it("[export-second-refused] a second download is 409 PAYOUT_EXPORT_ALREADY_DOWNLOADED and returns no file", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    const first = await exportBatch(batchId);
    const checksum = (await batchById(batchId)).export_checksum_sha256;
    await expectRefused(exportBatch(batchId), {
      status: 409,
      code: "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
    });
    await expectRefused(exportBatch(batchId, REQ), {
      status: 409,
      code: "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
    });
    const batch = await batchById(batchId);
    expect(batch.status).toBe("exported");
    expect(batch.export_checksum_sha256).toBe(checksum);
    expect(checksum).toBe(first.checksumSha256);
  });

  it("[export-concurrent] two simultaneous downloads: exactly one gets the file", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    const results = await Promise.allSettled([
      exportBatch(batchId),
      exportBatch(batchId),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      code: "PAYOUT_EXPORT_ALREADY_DOWNLOADED",
    });
    expect((await batchById(batchId)).export_checksum_sha256).toBe(
      (won[0] as PromiseFulfilledResult<{ checksumSha256: string }>).value
        .checksumSha256,
    );
  });

  it("[export-needs-approval] a draft or pending batch cannot be exported", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await expectRefused(exportBatch(batchId), { status: 409 });
    await submit(batchId);
    await expectRefused(exportBatch(batchId), { status: 409 });
    expect((await batchById(batchId)).status).toBe("pending_approval");
    expect((await batchById(batchId)).export_checksum_sha256).toBeNull();
  });

  it("[export-expired] after the 24h approval window the export is refused PAYOUT_APPROVAL_EXPIRED and nothing moves", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    await asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches
              SET approval_expires_at = now() - interval '1 minute' WHERE id = $1`,
          [batchId],
        ),
      true,
    );
    await expectRefused(exportBatch(batchId), {
      code: "PAYOUT_APPROVAL_EXPIRED",
    });
    expect((await batchById(batchId)).status).toBe("approved");
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
  });

  it("[export-hash-mismatch] a changed content hash is refused PAYOUT_HASH_MISMATCH and nothing moves", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    await asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches SET content_hash = $2 WHERE id = $1`,
          [batchId, "f".repeat(64)],
        ),
      true,
    );
    await expectRefused(exportBatch(batchId), { code: "PAYOUT_HASH_MISMATCH" });
    expect((await batchById(batchId)).status).toBe("approved");
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
  });

  it("[export-pt-disabled] R15: a PT switched off after approval cannot export; switched on again it can", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    await setConfig({ enabled: false });
    try {
      await expectRefused(exportBatch(batchId));
      expect((await batchById(batchId)).status).toBe("approved");
      expect((await itemsOf(batchId))[0]!.status).toBe("approved");
    } finally {
      await setConfig({ enabled: true });
    }
    const file = await exportBatch(batchId);
    expect(file.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("[export-snapshot-only] the file shows the bank account frozen at lock, not the employee's current one", async () => {
    const runId = await seedRun([bank(MOVER, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    const newAccount = digits(12);
    const put = await hr
      .put(`/api/hris/employees/${MOVER.id}/pii`)
      .set(originHeader)
      .send({
        nik: digits(16),
        npwp: digits(15),
        bankAccount: newAccount,
        idempotencyKey: `payout-manual-${randomUUID()}`,
      });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const content = String((await exportBatch(batchId)).content);
    expect(content).toContain(MOVER.account);
    expect(content).not.toContain(newAccount);
  });
});

describe("confirm manual results (R5, R10)", () => {
  it("[confirm-self-refused] the requester cannot confirm results: PAYOUT_CONFIRM_SELF, items stay exported", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    const items = await itemsOf(batchId);
    await expectRefused(confirm(batchId, succeedAll(items, batchId), REQ), {
      code: "PAYOUT_CONFIRM_SELF",
    });
    expect((await itemsOf(batchId))[0]!.status).toBe("exported");
    expect((await batchById(batchId)).status).toBe("exported");
  });

  it("[confirm-needs-export] items that were never exported cannot be confirmed", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    const items = await itemsOf(batchId);
    await expectRefused(confirm(batchId, succeedAll(items, batchId)), {
      status: 409,
    });
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
  });

  it("[confirm-bank-ref-required] a succeeded result without a bank reference is refused", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    const [item] = await itemsOf(batchId);
    await expectRefused(
      confirm(batchId, [{ itemId: item!.id as string, result: "succeeded" }]),
    );
    expect((await itemsOf(batchId))[0]!.status).toBe("exported");
  });

  it("[confirm-all-succeeded-run-paid] all items succeeded: reference and evidence stored, batch completed, run paid by the batch approver, one payroll.paid event", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    const items = await itemsOf(batchId);
    const results = succeedAll(items, batchId);
    await confirm(batchId, results, APP);

    for (const result of results) {
      const item = (await itemsOf(batchId)).find(
        (i) => i.id === result.itemId,
      )!;
      expect(item.status).toBe("succeeded");
      expect(item.settled_at).not.toBeNull();
      expect(item.confirmed_by).toBe(APP);
      expect(item.confirmation_ref).toBe(result.bankRef);
      expect(item.confirmation_evidence_key).toBe(result.evidenceKey);
    }
    expect((await batchById(batchId)).status).toBe("completed");
    const run = (
      await rowsOf(
        "SELECT status, paid_by, paid_at FROM payroll_runs WHERE id = $1",
        [runId],
      )
    )[0]!;
    expect(run.status).toBe("paid");
    expect(run.paid_by).toBe(APP);
    expect(run.paid_at).not.toBeNull();
    expect(await paidEvents(runId), "payroll.paid is emitted once").toBe(1);
  });

  it("[confirm-partial] one failed (two-person resolve): batch partially_failed, run stays locked, the failed slip returns in a follow-up batch and the paid one does not (R7)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    const budi = (await itemOfPerson(batchId, BUDI))!;
    const siti = (await itemOfPerson(batchId, SITI))!;
    await confirm(batchId, [
      {
        itemId: budi.id as string,
        result: "succeeded",
        bankRef: "BCA-OK-1",
        evidenceKey: uploadEvidence(batchId, "ok.pdf"),
      },
    ]);
    // H2: one person alone can never free the slip. Two different people
    // resolve it as failed.
    await resolve(batchId, [siti.id as string], "failed", APP);
    expect((await itemOfPerson(batchId, SITI))!.status).toBe("exported");
    await resolve(batchId, [siti.id as string], "failed", APP2);
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("succeeded");
    expect((await itemOfPerson(batchId, SITI))!.status).toBe("failed");
    expect((await batchById(batchId)).status).toBe("partially_failed");
    expect(await runStatus(runId)).toBe("locked");

    const second = await createBatch(runId);
    const items = await itemsOf(second);
    expect(items.map((i) => i.employee_id)).toEqual([SITI.id]);
    expect(items[0]!.attempt_no).toBe(2);
  });

  it("[confirm-subset] confirming part of the items leaves the batch exported and the run locked; the same item cannot be confirmed twice", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    const budi = (await itemOfPerson(batchId, BUDI))!;
    const one = [
      {
        itemId: budi.id as string,
        result: "succeeded" as const,
        bankRef: "BCA-ONE-1",
        evidenceKey: uploadEvidence(batchId, "one.pdf"),
      },
    ];
    await confirm(batchId, one);
    expect((await batchById(batchId)).status).toBe("exported");
    expect((await itemOfPerson(batchId, SITI))!.status).toBe("exported");
    expect(await runStatus(runId)).toBe("locked");
    await expectRefused(confirm(batchId, one), { status: 409 });
    expect((await itemOfPerson(batchId, BUDI))!.confirmation_ref).toBe(
      "BCA-ONE-1",
    );
  });

  it("[run-paid-only-when-every-slip-paid] a slip excluded for a missing bank code keeps the run locked after the manual batch completes", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      bank(NOCODE, 1_000_000),
    ]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    await confirm(batchId, succeedAll(await liveItems(batchId), batchId));
    expect((await batchById(batchId)).status).toBe("completed");
    expect(await runStatus(runId)).toBe("locked");
  });
});

describe("cash handover and the mixed run", () => {
  it("[cash-handover] the requester cannot confirm a handover; another person can; item succeeded, batch completed, second confirm refused", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await approvedBatch(runId, "cash");
    const [item] = await itemsOf(batchId);
    await expectRefused(handover(batchId, [item!.id as string], REQ), {
      code: "PAYOUT_CONFIRM_SELF",
    });
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
    await handover(batchId, [item!.id as string], APP);
    const done = (await itemsOf(batchId))[0]!;
    expect(done.status).toBe("succeeded");
    expect(done.confirmed_by).toBe(APP);
    expect(done.settled_at).not.toBeNull();
    expect((await batchById(batchId)).status).toBe("completed");
    await expectRefused(handover(batchId, [item!.id as string], APP), {
      status: 409,
    });
  });

  it("[cash-needs-approval] a cash item of a batch that is not approved cannot be handed over", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await createBatch(runId, "cash");
    await submit(batchId);
    const [item] = await itemsOf(batchId);
    await expectRefused(handover(batchId, [item!.id as string]), {
      status: 409,
    });
    expect((await itemsOf(batchId))[0]!.status).toBe("prepared");
  });

  it("[cash-only-run-paid] a run with only cash slips turns paid after the handover, one payroll.paid event", async () => {
    const runId = await seedRun([
      cash(CASHIER, 2_000_000),
      cash(SITI, 1_000_000),
    ]);
    const batchId = await approvedBatch(runId, "cash");
    const items = await itemsOf(batchId);
    await handover(
      batchId,
      items.map((i) => i.id as string),
    );
    expect(await runStatus(runId)).toBe("paid");
    expect(await paidEvents(runId)).toBe(1);
  });

  it("[mixed-run-paid-after-both] bank + cash run: still locked after the bank batch completes, paid after the cash handover", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      cash(CASHIER, 2_000_000),
    ]);
    const bankBatch = await approvedBatch(runId, "manual_bank");
    await exportBatch(bankBatch);
    await confirm(bankBatch, succeedAll(await itemsOf(bankBatch), bankBatch));
    expect((await batchById(bankBatch)).status).toBe("completed");
    expect(await runStatus(runId)).toBe("locked");

    const cashBatch = await approvedBatch(runId, "cash");
    const items = await itemsOf(cashBatch);
    await handover(
      cashBatch,
      items.map((i) => i.id as string),
      APP,
    );
    expect(await runStatus(runId)).toBe("paid");
    expect(
      (
        await rowsOf("SELECT paid_by FROM payroll_runs WHERE id = $1", [runId])
      )[0]!.paid_by,
    ).toBe(APP);
  });
});

// ---- Fix round 1 (648-fix1.md) --------------------------------------------

describe("H2 an exported item is freed only by two different people", () => {
  /** Approved + exported manual batch of Budi and Siti. */
  async function exportedBatch() {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    await exportBatch(batchId);
    return { runId, batchId };
  }

  it("[confirm-failed-no-longer-accepted] confirm takes succeeded only: a 'failed' result is rejected and the item stays exported", async () => {
    const { batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    const error = await rejected(
      inTx((tx) =>
        confirmManualItems(
          tx,
          actor(APP),
          batchId,
          {
            results: [{ itemId: siti.id as string, result: "failed" }],
          } as never,
          proofs(),
        ),
      ),
    );
    expect(error, "'failed' must not be accepted by confirm").not.toBeNull();
    expect((await itemOfPerson(batchId, SITI))!.status).toBe("exported");
    expect((await batchById(batchId)).status).toBe("exported");
  });

  it("[resolve-first-step] the first person records evidence and a proposed outcome; the item stays exported and the slip stays blocked for a new batch", async () => {
    const { runId, batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    await resolve(batchId, [siti.id as string], "failed", APP, {
      evidenceKey: uploadEvidence(batchId, "resolve-1.pdf"),
      note: "Mutasi rekening tidak menunjukkan dana keluar",
    });
    const after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("exported");
    expect(after.resolved_by).toBe(APP);
    expect(after.resolved_by_2).toBeNull();
    expect(after.resolution_outcome).toBe("failed");
    expect(after.resolution_evidence_key).toBe(
      uploadEvidence(batchId, "resolve-1.pdf"),
    );
    expect(after.resolution_note).toBe(
      "Mutasi rekening tidak menunjukkan dana keluar",
    );
    expect((await batchById(batchId)).status).toBe("exported");
    expect(await runStatus(runId)).toBe("locked");
    // The slip still has a live (exported) item: no second batch for it.
    const budi = (await itemOfPerson(batchId, BUDI))!;
    await confirm(batchId, [
      {
        itemId: budi.id as string,
        result: "succeeded",
        bankRef: "BCA-OK-RS",
        evidenceKey: uploadEvidence(batchId, "ok.pdf"),
      },
    ]);
    await expectRefused(createBatch(runId));
  });

  it("[resolve-second-step] a different second person with the same outcome moves the item to failed (definitive), both people and evidence stored", async () => {
    const { batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    await resolve(batchId, [siti.id as string], "failed", APP);
    await resolve(batchId, [siti.id as string], "failed", APP2);
    const after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("failed");
    expect(after.failure_class).toBe("definitive");
    expect(after.resolved_by).toBe(APP);
    expect(after.resolved_by_2).toBe(APP2);
    expect(after.resolution_evidence_key).not.toBeNull();
    // Budi is still exported: the batch is not final.
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("exported");
    expect((await batchById(batchId)).status).toBe("exported");
  });

  it("[resolve-same-person-twice] the same person cannot take both steps: 403 PAYOUT_RESOLVE_SAME_PERSON, item stays exported", async () => {
    const { batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    await resolve(batchId, [siti.id as string], "failed", APP);
    await expectRefused(resolve(batchId, [siti.id as string], "failed", APP), {
      status: 403,
      code: "PAYOUT_RESOLVE_SAME_PERSON",
    });
    const after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("exported");
    expect(after.resolved_by_2).toBeNull();
  });

  it("[resolve-requester-refused] the batch requester can be neither the first nor the second person", async () => {
    const { batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    await expectRefused(resolve(batchId, [siti.id as string], "failed", REQ));
    let after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("exported");
    expect(after.resolved_by).toBeNull();
    await resolve(batchId, [siti.id as string], "failed", APP);
    await expectRefused(resolve(batchId, [siti.id as string], "failed", REQ));
    after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("exported");
    expect(after.resolved_by_2).toBeNull();
  });

  it("[resolve-outcome-mismatch] a second person with another outcome is refused 409 PAYOUT_RESOLVE_OUTCOME_MISMATCH", async () => {
    const { batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    await resolve(batchId, [siti.id as string], "failed", APP);
    await expectRefused(
      resolve(batchId, [siti.id as string], "not_sent", APP2),
      { status: 409, code: "PAYOUT_RESOLVE_OUTCOME_MISMATCH" },
    );
    const after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("exported");
    expect(after.resolved_by_2).toBeNull();
  });

  it("[resolve-evidence-required] a resolve without an evidence key is refused and nothing is recorded", async () => {
    const { batchId } = await exportedBatch();
    const siti = (await itemOfPerson(batchId, SITI))!;
    await expectRefused(
      resolve(batchId, [siti.id as string], "failed", APP, { evidenceKey: "" }),
    );
    const after = (await itemOfPerson(batchId, SITI))!;
    expect(after.status).toBe("exported");
    expect(after.resolved_by).toBeNull();
    expect(after.resolution_outcome).toBeNull();
  });

  it("[resolve-only-exported] approved (not yet exported) and succeeded items cannot be resolved: 409", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    const items = await itemsOf(batchId);
    await expectRefused(
      resolve(batchId, [items[0]!.id as string], "not_sent", APP),
      { status: 409 },
    );
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
    await exportBatch(batchId);
    const budi = (await itemOfPerson(batchId, BUDI))!;
    await confirm(batchId, [
      {
        itemId: budi.id as string,
        result: "succeeded",
        bankRef: "BCA-OK-2",
        evidenceKey: uploadEvidence(batchId, "ok.pdf"),
      },
    ]);
    await expectRefused(resolve(batchId, [budi.id as string], "failed", APP), {
      status: 409,
    });
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("succeeded");
  });

  it("[resolve-not-sent-all] 'file not uploaded' (R14): every item resolved not_sent by two people ends the batch partially_failed, the run stays locked, a new batch takes both slips (attempt 2)", async () => {
    const { runId, batchId } = await exportedBatch();
    const ids = (await itemsOf(batchId)).map((i) => i.id as string);
    await resolve(batchId, ids, "not_sent", APP);
    for (const item of await itemsOf(batchId)) {
      expect(item.status).toBe("exported");
      expect(item.resolution_outcome).toBe("not_sent");
    }
    await resolve(batchId, ids, "not_sent", APP2);
    for (const item of await itemsOf(batchId)) {
      expect(item.status).toBe("not_sent");
      expect(item.resolved_by).toBe(APP);
      expect(item.resolved_by_2).toBe(APP2);
    }
    expect((await batchById(batchId)).status).toBe("partially_failed");
    expect(await runStatus(runId)).toBe("locked");
    const second = await createBatch(runId);
    const items = await itemsOf(second);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.attempt_no).toBe(2);
  });

  it("[resolve-db-two-people] the database refuses exported -> failed|not_sent unless two different non-requesters and an evidence key are on the row", async () => {
    const { batchId } = await exportedBatch();
    const budi = (await itemOfPerson(batchId, BUDI))!;
    const siti = (await itemOfPerson(batchId, SITI))!;
    const requester = (await batchById(batchId)).requested_by as string;
    const move = (id: unknown, status: string, set: string) =>
      pgFailure(
        rowsOf(
          `UPDATE payroll_disbursement_items
              SET status = '${status}', ${set}
            WHERE id = $1`,
          [id],
        ),
      );
    const evidence = `resolution_evidence_key = 'evidence/db.pdf'`;
    const cases: [string, string][] = [
      ["no resolver at all", evidence],
      ["only one resolver", `resolved_by = 'p1', ${evidence}`],
      [
        "resolver is the requester",
        `resolved_by = '${requester}', resolved_by_2 = 'p2', ${evidence}`,
      ],
      [
        "second resolver is the requester",
        `resolved_by = 'p1', resolved_by_2 = '${requester}', ${evidence}`,
      ],
      [
        "same person twice",
        `resolved_by = 'p1', resolved_by_2 = 'p1', ${evidence}`,
      ],
      ["no evidence key", `resolved_by = 'p1', resolved_by_2 = 'p2'`],
    ];
    for (const status of ["failed", "not_sent"])
      for (const [name, set] of cases) {
        const error = await move(siti.id, status, set);
        expect(error, `${status}: ${name}`).not.toBeNull();
      }
    expect((await itemOfPerson(batchId, SITI))!.status).toBe("exported");
    // The proposed outcome column only holds failed | not_sent.
    const bad = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_items SET resolution_outcome = 'succeeded' WHERE id = $1`,
        [siti.id],
      ),
    );
    expect(bad?.code).toBe("23514");
    // Controls: the allowed shape passes, so the refusals above come from the guard.
    const okFailed = await move(
      siti.id,
      "failed",
      `failure_class = 'definitive', resolution_outcome = 'failed', resolved_by = 'p1', resolved_by_2 = 'p2', ${evidence}`,
    );
    expect(okFailed).toBeNull();
    const okNotSent = await move(
      budi.id,
      "not_sent",
      `resolution_outcome = 'not_sent', resolved_by = 'p1', resolved_by_2 = 'p2', ${evidence}`,
    );
    expect(okNotSent).toBeNull();
  });
});

describe("H1 the legacy bank file and a disbursement batch exclude each other", () => {
  it("[h1-legacy-refused-with-batch] a run with a non-cancelled manual_bank batch gets no legacy bank file: 409 PAYOUT_RUN_HAS_PAYOUT_BATCH", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await createBatch(runId);
    for (const stage of ["draft", "exported"]) {
      if (stage === "exported") {
        await submit(batchId);
        await approve(batchId);
        await exportBatch(batchId);
      }
      const response = await legacyExport(runId);
      expect(
        response.status,
        `${stage}: ${JSON.stringify(response.body)}`,
      ).toBe(409);
      expect(response.body.error.code).toBe("PAYOUT_RUN_HAS_PAYOUT_BATCH");
      expect(await bankFileCount(runId)).toBe(0);
    }
  });

  it("[h1-legacy-allowed-without-bank-batch] a cancelled batch or a cash-only batch does not block the legacy bank file", async () => {
    const cancelled = await seedRun([bank(BUDI, 4_000_000)]);
    await cancelBatch(await createBatch(cancelled));
    const afterCancel = await legacyExport(cancelled);
    expect(afterCancel.status, JSON.stringify(afterCancel.body)).toBe(201);
    expect(await bankFileCount(cancelled)).toBe(1);

    const mixed = await seedRun([
      bank(SITI, 3_000_000),
      cash(CASHIER, 2_000_000),
    ]);
    await approvedBatch(mixed, "cash");
    const withCash = await legacyExport(mixed);
    expect(withCash.status, JSON.stringify(withCash.body)).toBe(201);
    expect(await bankFileCount(mixed)).toBe(1);
  });

  it("[h1-batch-refused-with-bank-file] a run that already has a legacy bank file gets no manual_bank batch: 409 PAYOUT_RUN_HAS_BANK_FILE; a cash batch is still allowed", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      cash(CASHIER, 2_000_000),
    ]);
    const file = await legacyExport(runId);
    expect(file.status, JSON.stringify(file.body)).toBe(201);
    await expectRefused(
      inTx((tx) =>
        createDisbursementBatch(tx, actor(REQ), {
          payrollRunId: runId,
          channel: "manual_bank",
        } as never),
      ),
      { status: 409, code: "PAYOUT_RUN_HAS_BANK_FILE" },
    );
    expect(await batchRow(runId, "manual_bank")).toBeUndefined();
    await createBatch(runId, "cash");
    expect(await batchRow(runId, "cash")).toBeDefined();
  });

  it("[h1-db-batch-insert-trigger] the database refuses a non-cash batch for a run that has a legacy bank file; a run without one is fine", async () => {
    const fileRun = await seedRun([bank(BUDI, 4_000_000)]);
    expect((await legacyExport(fileRun)).status).toBe(201);
    const batchRun = await seedRun([bank(SITI, 3_000_000)]);
    const source = await createBatch(batchRun);
    const freeRun = await seedRun([bank(ANDI, 2_000_000)]);
    const refused = await pgFailure(
      cloneRow(
        "payroll_disbursement_batches",
        source,
        `payroll_run_id = '${fileRun}'`,
      ),
    );
    expect(refused, "batch insert next to a bank file").not.toBeNull();
    expect(refused?.code).not.toBe("23505");
    // Control: the same clone on a run without a bank file is accepted.
    expect(
      await pgFailure(
        cloneRow(
          "payroll_disbursement_batches",
          source,
          `payroll_run_id = '${freeRun}'`,
        ),
      ),
    ).toBeNull();
  });

  it("[h1-db-file-insert-trigger] the database refuses a legacy bank file row for a run with a non-cancelled non-cash batch; cancelled batch or no batch is fine", async () => {
    const fileRun = await seedRun([bank(BUDI, 4_000_000)]);
    expect((await legacyExport(fileRun)).status).toBe(201);
    const fileId = (
      await rowsOf(
        "SELECT id FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = $2",
        [tenant.id, fileRun],
      )
    )[0]!.id as string;
    const batchRun = await seedRun([bank(SITI, 3_000_000)]);
    const batchId = await createBatch(batchRun);
    const freeRun = await seedRun([bank(ANDI, 2_000_000)]);
    const refused = await pgFailure(
      cloneRow("bank_transfer_files", fileId, `payroll_run_id = '${batchRun}'`),
    );
    expect(refused, "bank file insert next to a batch").not.toBeNull();
    expect(
      await pgFailure(
        cloneRow(
          "bank_transfer_files",
          fileId,
          `payroll_run_id = '${freeRun}'`,
        ),
      ),
    ).toBeNull();
    await cancelBatch(batchId);
    expect(
      await pgFailure(
        cloneRow(
          "bank_transfer_files",
          fileId,
          `payroll_run_id = '${batchRun}'`,
        ),
      ),
      "a cancelled batch no longer blocks",
    ).toBeNull();
  });
});

describe("M2 cash batch: partial cancel and handover expiry", () => {
  it("[m2-cash-partial-cancel] cancelling an approved cash batch after some handovers keeps the paid items, turns the rest not_sent, batch partially_failed; the rest can be re-batched", async () => {
    const runId = await seedRun([
      cash(CASHIER, 2_000_000),
      cash(SITI, 1_000_000),
      cash(ANDI, 1_500_000),
    ]);
    const batchId = await approvedBatch(runId, "cash");
    const paid = (await itemOfPerson(batchId, CASHIER))!;
    await handover(batchId, [paid.id as string]);
    await cancelBatch(batchId);

    expect((await itemOfPerson(batchId, CASHIER))!.status).toBe("succeeded");
    expect((await itemOfPerson(batchId, SITI))!.status).toBe("not_sent");
    expect((await itemOfPerson(batchId, ANDI))!.status).toBe("not_sent");
    expect((await batchById(batchId)).status).toBe("partially_failed");
    expect(await runStatus(runId)).toBe("locked");

    const second = await createBatch(runId, "cash");
    const items = await itemsOf(second);
    expect(items.map((i) => i.employee_id).sort()).toEqual(
      [SITI.id, ANDI.id].sort(),
    );
    for (const item of items) expect(item.attempt_no).toBe(2);
  });

  it("[m2-cash-cancel-nothing-paid] a cash batch with no handover is still cancelled as before", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await approvedBatch(runId, "cash");
    await cancelBatch(batchId);
    expect((await batchById(batchId)).status).toBe("cancelled");
    expect(["cancelled", "not_sent"]).toContain(
      (await itemsOf(batchId))[0]!.status,
    );
  });

  it("[m2-cash-handover-expired] a cash handover after the 24h approval window is refused PAYOUT_APPROVAL_EXPIRED and nothing moves", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await approvedBatch(runId, "cash");
    await asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches
              SET approval_expires_at = now() - interval '1 minute' WHERE id = $1`,
          [batchId],
        ),
      true,
    );
    const [item] = await itemsOf(batchId);
    await expectRefused(handover(batchId, [item!.id as string]), {
      code: "PAYOUT_APPROVAL_EXPIRED",
    });
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
    expect((await batchById(batchId)).status).toBe("approved");
  });
});
