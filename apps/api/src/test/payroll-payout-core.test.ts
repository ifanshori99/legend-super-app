// Payroll disbursement core (bead legend-648; design docs/design/payroll-disbursement.md
// sections 4-7 and 9; brief 648-brief.md). Money area: nobody is paid twice,
// nobody is paid more than net pay, no item is lost. Rules covered here:
// R1 (one live item per payslip, one open batch per run/channel), R5 (two
// people, DB CHECK), R7 (follow-up batch only for slips without a live item),
// R8 (only net > 0 slips, per-channel split), R10 (run `paid` guard),
// R11 (run reversal guard), item state machine and write guard triggers,
// payout config rules. Duitku-only rules are `it.todo` in
// payroll-payout-duitku-todo.test.ts. Manual export/confirm: payroll-payout-manual.test.ts.
//
// Interfaces under test (names from the brief; none exist yet, so every test
// fails first on the missing module or table):
//   services/payroll-payout-config.service.ts
//     getPayoutConfig(tx, tenantId, legalEntityId)
//     upsertPayoutConfig(tx, actor, legalEntityId, input)
//   services/payroll-payout.service.ts
//     createDisbursementBatch(tx, actor, { payrollRunId, channel })
//     submitDisbursementBatch(tx, actor, batchId)
//     approveDisbursementBatch(tx, actor, batchId, { contentHash, sourceBankAccountId })
//     cancelDisbursementBatch(tx, actor, batchId, { reason })
//     getDisbursementBatch(tx, tenantId, batchId)
//     listDisbursementBatches(tx, tenantId, payrollRunId)
//   actor = { tenantId, userId }; errors are HttpError.
//
// Assumptions (brief silent, stated so the engineer can contest them):
// - Return shapes of the services are NOT asserted. Tests read state straight
//   from the tables (`payroll_disbursement_batches`, `payroll_disbursement_items`)
//   with the column names of the brief. The batch id is looked up by
//   (run, channel), newest first.
// - Amounts and fees are sealed with binding names this test does not know,
//   so amounts are asserted through the manual export file (manual test file),
//   not here. Item and batch counts are asserted here.
// - Codes the brief names are asserted exactly: PAYOUT_CHANNEL_NOT_AVAILABLE
//   (409), PAYOUT_SELF_APPROVAL, PAYOUT_HASH_MISMATCH, PAYOUT_CONFIG_BUSY (409),
//   PAYOUT_RUN_REVERSAL_BLOCKED (409). Where the brief gives no code
//   (submit by a non-requester, empty batch, config disabled, run not locked,
//   duplicate open batch) only "a 4xx HttpError, nothing written" is asserted.
// - A batch with only blocked items: either create or submit refuses it and no
//   item is left `approved`.
// - Net pay <= 0 and slips of the other channel get no item at all.
// Fix round 1 (648-fix1.md): M1 (duitku integration must be an active
// duitku integration of this tenant: 422 + DB trigger), L2 (snapshot match
// guard on prepared|blocked items), L3 (settle -> paid refused while a batch
// or item is in flight), L4 (succeeded rows are frozen), L6 (manual batch
// needs config.method = manual_bank). Not testable here: L1 (lock order) and
// L5 (evidence key tie to storage, not in this slice). H1/H2/M2 live in
// payroll-payout-manual.test.ts.
// Assumptions: a bad integration is 422 (brief) with no exact code; the L2/L3/L4
// refusals are only asserted as "the database refuses" and the control update
// of each (a valid shape) must pass; the L4 control is succeeded -> returned
// with returned_at = now().
// - Direct SQL by the table owner is used for seeding final states (replica
//   role, triggers off) and for proving the DB triggers/CHECKs (normal role).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
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
  getPayoutConfig,
  upsertPayoutConfig,
} from "../services/payroll-payout-config.service.ts";
import {
  approveDisbursementBatch,
  cancelDisbursementBatch,
  createDisbursementBatch,
  getDisbursementBatch,
  listDisbursementBatches,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { requestPayrollRunReversalInTransaction } from "../services/payroll-run-reversal.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { testGrantIssuer } from "./payroll-payout-fixtures.ts";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const otherTenant = randomUUID();
const REQ = `payout-req-${randomUUID()}`;
const APP = `payout-app-${randomUUID()}`;
const sessionIdOf = (userId: string) => `payout-core-session-${userId}`;
// The approval spends a step-up grant (legend-xp8mc), so the actor carries a
// session id and the test grant issuer (live session, fresh MFA: see APP in
// `beforeAll`).
const actor = (userId: string) => {
  const base = {
    tenantId: tenant.id as string,
    userId,
    sessionId: sessionIdOf(userId),
  };
  return { ...base, grants: testGrantIssuer(base) };
};

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

type PgError = { code?: string; constraint?: string; message?: string };
const pgFailure = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error as PgError,
  );
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
        `Payout core ${roleId.slice(0, 8)}`,
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
const ALL_PEOPLE = [BUDI, SITI, ANDI, NOCODE, CASHIER];

const entityId = randomUUID();
const policyId = randomUUID();
const createdRuns: string[] = [];
const createdEmployees: string[] = [];
let bankAccountId = "";
let hr: Awaited<ReturnType<typeof signedInClient>>["client"];

const day = (n: number) =>
  new Date(Date.UTC(2041, 0, 1 + n)).toISOString().slice(0, 10);

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
    await c.query(
      `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
                totals = $2::jsonb, locked_by = '00000000-0000-4000-8000-0000000000a3', locked_at = now()
          WHERE id = $1`,
      [runId, JSON.stringify(runTotals(slips)), JSON.stringify(runSnapshot())],
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
  if (payees.length > 0)
    await inTx((tx) => snapshotPayeeBankForLock(tx, tenant.id, runId, payees));
  // PAYR-01 forbids payslips on a run that is not locked, so a not-locked run
  // is a locked one moved back to approved with triggers off (replica role).
  if (status === "approved")
    await asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_runs SET status = 'approved', locked_by = NULL, locked_at = NULL WHERE id = $1`,
        [runId],
      );
    }, true);
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

/** Clone a row (all columns) under a new id, then apply SQL overrides. */
async function cloneRow(
  table: string,
  id: string,
  overrides: string,
  raw = false,
) {
  return asTenant(async (c) => {
    await c.query(
      `CREATE TEMP TABLE payout_clone ON COMMIT DROP AS SELECT * FROM ${table} WHERE id = $1`,
      [id],
    );
    await c.query(
      `UPDATE payout_clone SET id = gen_random_uuid()${overrides ? `, ${overrides}` : ""}`,
    );
    await c.query(`INSERT INTO ${table} SELECT * FROM payout_clone`);
  }, raw);
}

/**
 * Put a batch straight into a later state (triggers off, CHECKs still on).
 * The batch CHECKs tie each status to its columns: an approved or later batch
 * needs approver + hash, an exported one also the export fields.
 */
async function forceBatchState(
  c: PoolClient,
  batchId: string,
  status: "exported" | "completed" | "partially_failed",
) {
  const exported = status === "exported";
  await c.query(
    `UPDATE payroll_disbursement_batches
        SET status = $2::text,
            content_hash = COALESCE(content_hash, $3::text),
            approved_by = COALESCE(approved_by, 'seed-approver'),
            approved_at = COALESCE(approved_at, now()),
            approval_expires_at = COALESCE(approval_expires_at, now() + interval '24 hours'),
            exported_by = CASE WHEN $4::boolean THEN COALESCE(exported_by, 'seed-exporter') ELSE exported_by END,
            exported_at = CASE WHEN $4::boolean THEN COALESCE(exported_at, now()) ELSE exported_at END,
            export_checksum_sha256 = CASE WHEN $4::boolean THEN COALESCE(export_checksum_sha256, $5::text) ELSE export_checksum_sha256 END
      WHERE id = $1`,
    [batchId, status, "a".repeat(64), exported, "b".repeat(64)],
  );
}

// ---- Setup / teardown ---------------------------------------------------------

beforeAll(async () => {
  const hrUser = await signedInClient("Payout core HR");
  await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
  hr = hrUser.client;

  // The approver of the main approval: what `app.payout_assert_actor` checks
  // (user row, live session with fresh MFA, payroll.disburse.approve).
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified)
     VALUES ($1, 'Payout core approver', $2, true)`,
    [APP, `${APP}@payout-core.test`],
  );
  await owner.query(
    `INSERT INTO session (id, expires_at, token, user_id, tenant_id, mfa_verified_at)
     VALUES ($1, now() + interval '1 day', $2, $3, $4, now())`,
    [sessionIdOf(APP), randomUUID(), APP, tenant.id],
  );
  createdUsers.push(APP);
  await grantRole(APP, ["payroll.disburse.approve"]);

  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Payout Core', false)`,
      [entityId, tenant.id],
    );
    const code = `PC${policyId.slice(0, 8)}`;
    await c.query(
      `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                     employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
       VALUES ($1, $2, $3, 'Kebijakan Payout Core', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
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
         VALUES ($1, $2, 'BCA', 'Rekening Gaji', '\\x00', $3, '0000', 1, $4, 'payout-core-test')
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
    // legend-rvao9: approving a cash batch needs the petty cash role mapped and
    // enough cash in 1102. Setup only: 1102 mapped as petty_cash and one plain
    // journal Dr 1102 / Cr 1103 (far above any batch of this file); the
    // journal is removed in afterAll.
    await c.query(
      `INSERT INTO chart_of_accounts
         (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
       VALUES ($1, $2, '1102', 'Kas Kecil', 'asset', 'cash_and_equivalents', NULL, true)`,
      [tenant.id, entityId],
    );
    await c.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       SELECT $1, $2, 'petty_cash', id FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'`,
      [tenant.id, entityId],
    );
    const fundDate = new Date(Date.now() + 7 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    const fundPeriod = (
      await c.query(
        `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenant.id, entityId, fundDate.slice(0, 7)],
      )
    ).rows[0].id as string;
    const fundEntry = (
      await c.query(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            source_id, description, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo kas kecil uji payout', $5, $6)
         RETURNING id`,
        [
          tenant.id,
          entityId,
          fundDate,
          fundPeriod,
          `payout-fund-1102-${randomUUID()}`,
          randomBytes(32).toString("hex"),
        ],
      )
    ).rows[0].id as string;
    await c.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       SELECT $1, $2, id, CASE code WHEN '1102' THEN 1 ELSE 2 END,
              CASE code WHEN '1102' THEN 1000000000 ELSE 0 END,
              CASE code WHEN '1102' THEN 0 ELSE 1000000000 END
         FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $3 AND code IN ('1102', '1103')`,
      [tenant.id, fundEntry, entityId],
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
        idempotencyKey: `payout-core-${randomUUID()}`,
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
       VALUES ($1, $2, 'manual_bank', $3, 'generic_csv', $4, 'payout-core-test')
       ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE SET enabled = $4`,
      [tenant.id, entityId, bankAccountId, values.enabled],
    );
  }, true);
}

afterAll(async () => {
  await asTenant(async (c) => {
    const del = (sql: string, params: unknown[]) => c.query(sql, params);
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
      "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)",
      [tenant.id, entityId],
    );
    await del(
      "DELETE FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenant.id, entityId],
    );
    await del(
      "DELETE FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2",
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
    await del(
      "DELETE FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
      [tenant.id, extraEntities],
    );
    await del(
      "DELETE FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
      [tenant.id, extraEntities],
    );
    await del(
      "DELETE FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
      [tenant.id, extraEntities],
    );
    await del(
      "DELETE FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = ANY($2)",
      [tenant.id, extraEntities],
    );
    await del("DELETE FROM legal_entities WHERE id = ANY($1)", [extraEntities]);
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
  await owner.query("DELETE FROM tenant_integrations WHERE id = ANY($1)", [
    createdIntegrations,
  ]);
  await owner.query("DELETE FROM session WHERE id = $1", [sessionIdOf(APP)]);
  await owner.query(`DELETE FROM "user" WHERE id = $1`, [APP]);
  if (otherTenantCreated)
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.end();
});

// ---- Fix round 1 helpers ----------------------------------------------------

const createdIntegrations: string[] = [];
const extraEntities: string[] = [];
let otherTenantCreated = false;

/** An active org-wide integration of a provider for a tenant (reuses an existing one). */
async function integrationFor(tenantId: string, provider: string) {
  if (tenantId === otherTenant && !otherTenantCreated) {
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Payout core tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `payout-core-${otherTenant.slice(0, 8)}`, tenant.id],
    );
    otherTenantCreated = true;
  }
  const inserted = await owner.query(
    `INSERT INTO tenant_integrations (tenant_id, outlet_id, provider, status, credentials_encrypted)
     VALUES ($1, NULL, $2, 'active', 'payout-core-sealed')
     ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId, provider],
  );
  if (inserted.rows[0]) {
    createdIntegrations.push(inserted.rows[0].id as string);
    return inserted.rows[0].id as string;
  }
  const found = await owner.query(
    `SELECT id FROM tenant_integrations
      WHERE tenant_id = $1 AND provider = $2 AND outlet_id IS NULL AND status = 'active'`,
    [tenantId, provider],
  );
  return found.rows[0]!.id as string;
}

/** A second legal entity with its own bank account (no open batch, so no PAYOUT_CONFIG_BUSY). */
async function extraEntityWithBank() {
  const id = randomUUID();
  extraEntities.push(id);
  return asTenant(async (c) => {
    await c.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Payout Core Dua', false)`,
      [id, tenant.id],
    );
    const gl = (
      await c.query(
        `INSERT INTO chart_of_accounts
           (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
         VALUES ($1, $2, '1103', 'Bank', 'asset', 'cash_and_equivalents', NULL, true)
         RETURNING id`,
        [tenant.id, id],
      )
    ).rows[0].id as string;
    const bankId = (
      await c.query(
        `INSERT INTO bank_accounts
           (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
            account_number_hmac, account_number_last4, account_number_key_version,
            gl_account_id, created_by)
         VALUES ($1, $2, 'BCA', 'Rekening Gaji Dua', '\\x00', $3, '0000', 1, $4, 'payout-core-test')
         RETURNING id`,
        [tenant.id, id, "c".repeat(64), gl],
      )
    ).rows[0].id as string;
    // Bank charges role (legend-8codi): approve and export are refused without it.
    await c.query(
      `INSERT INTO chart_of_accounts
         (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
       VALUES ($1, $2, '8101', 'Beban Administrasi Bank', 'expense', 'other_expense', NULL, true)`,
      [tenant.id, id],
    );
    await c.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       SELECT $1, $2, 'bank_charges', id FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '8101'`,
      [tenant.id, id],
    );
    return { entityId: id, bankId };
  });
}

/** Run a statement as the tenant, report the error (if any) and always roll back. */
async function probe(sql: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await client.query(sql, params);
    return null;
  } catch (error) {
    return error as PgError;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

// ---- Tests ----------------------------------------------------------------

describe("create batch", () => {
  it("[create-manual-items] a manual_bank batch gets one item per bank slip with net > 0: ok ones `prepared`, no bank code `blocked`; cash and net 0 slips get none", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_250_000),
      bank(SITI, 3_100_500),
      bank(NOCODE, 1_000_000),
      bank(ANDI, 0),
      cash(CASHIER, 2_000_000),
    ]);
    const batchId = await createBatch(runId);
    const batch = await batchById(batchId);
    expect(batch.status).toBe("draft");
    expect(batch.channel).toBe("manual_bank");
    expect(batch.requested_by).toBe(REQ);
    const items = await itemsOf(batchId);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.employee_id).sort()).toEqual(
      [BUDI.id, SITI.id, NOCODE.id].sort(),
    );
    for (const item of items) {
      expect(item.channel).toBe("manual_bank");
      expect(item.attempt_no).toBe(1);
      expect(item.idempotency_key).toBe(
        `payslip:${item.payslip_id as string}:attempt:1`,
      );
      expect(
        item.bank_snapshot_id,
        "bank items point at the snapshot",
      ).not.toBe(null);
    }
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("prepared");
    expect((await itemOfPerson(batchId, BUDI))!.bank_code).toBe("014");
    const blocked = (await itemOfPerson(batchId, NOCODE))!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.excluded_reason).toBe("bank_code_missing");
  });

  it("[create-cash-items] a cash batch takes only payment_method=cash slips with net > 0 and has no bank snapshot", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      cash(CASHIER, 2_000_000),
      cash(SITI, 0),
    ]);
    const batchId = await createBatch(runId, "cash");
    const items = await itemsOf(batchId);
    expect(items).toHaveLength(1);
    expect(items[0]!.employee_id).toBe(CASHIER.id);
    expect(items[0]!.channel).toBe("cash");
    expect(items[0]!.status).toBe("prepared");
    expect(items[0]!.bank_snapshot_id).toBeNull();
  });

  it("[create-channel-duitku] channel duitku is refused 409 PAYOUT_CHANNEL_NOT_AVAILABLE and writes nothing", async () => {
    const runId = await seedRun([bank(BUDI, 1_000_000)]);
    await expectRefused(
      inTx((tx) =>
        createDisbursementBatch(tx, actor(REQ), {
          payrollRunId: runId,
          channel: "duitku",
        } as never),
      ),
      { status: 409, code: "PAYOUT_CHANNEL_NOT_AVAILABLE" },
    );
    expect(await batchRow(runId, "duitku")).toBeUndefined();
  });

  it("[create-run-not-locked] a run that is not locked gets no batch", async () => {
    const runId = await seedRun([bank(BUDI, 1_000_000)], "approved");
    await expectRefused(createBatch(runId));
    expect(await batchRow(runId)).toBeUndefined();
  });

  it("[create-config-disabled] manual_bank needs the PT payout config enabled (per-PT switch)", async () => {
    const runId = await seedRun([bank(BUDI, 1_000_000)]);
    await setConfig({ enabled: false });
    try {
      await expectRefused(createBatch(runId));
      expect(await batchRow(runId)).toBeUndefined();
    } finally {
      await setConfig({ enabled: true });
    }
  });

  it("[create-run-other-tenant] a batch of a run id that does not exist is refused 404", async () => {
    await expectRefused(createBatch(randomUUID()), { status: 404 });
  });
});

describe("R1 nobody is paid twice", () => {
  it("[r1-one-open-batch] a second open batch for the same run and channel is refused, no duplicate items", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const first = await createBatch(runId);
    await expectRefused(createBatch(runId), { status: 409 });
    expect(
      await rowsOf(
        "SELECT id FROM payroll_disbursement_batches WHERE payroll_run_id = $1",
        [runId],
      ),
    ).toHaveLength(1);
    expect(await itemsOf(first)).toHaveLength(2);
  });

  it("[r1-concurrent-create] two simultaneous creates for one run: exactly one batch, one live item per slip", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const results = await Promise.allSettled([
      createBatch(runId),
      createBatch(runId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const live = await rowsOf(
      `SELECT payslip_id, count(*)::int AS n FROM payroll_disbursement_items
        WHERE payroll_run_id = $1
          AND status IN ('prepared','blocked','approved','sending','exported','unknown','succeeded')
        GROUP BY payslip_id`,
      [runId],
    );
    expect(live).toHaveLength(2);
    for (const row of live) expect(row.n).toBe(1);
  });

  it("[r1-db-live-item-unique] the database refuses a second live item for one payslip (partial unique index)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const item = (await itemOfPerson(batchId, BUDI))!;
    const error = await pgFailure(
      cloneRow(
        "payroll_disbursement_items",
        item.id as string,
        `attempt_no = attempt_no + 1, idempotency_key = 'payslip:' || payslip_id::text || ':attempt:2'`,
      ),
    );
    expect(error?.code).toBe("23505");
    expect(error?.constraint).toBe(
      "payroll_disbursement_items_one_live_per_payslip",
    );
  });

  it("[r1-db-idempotency-key-unique] the same idempotency key cannot be stored twice, even when the first item is no longer live", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await cancel(batchId);
    const item = (await itemOfPerson(batchId, BUDI))!;
    // Triggers off (the item is cancelled, a normal insert would stop at the
    // write guard first). The copy keeps the idempotency key and attempt, so
    // the unique constraints on them must refuse it; the live-item index
    // does not apply to a cancelled item.
    const error = await pgFailure(
      cloneRow("payroll_disbursement_items", item.id as string, "", true),
    );
    expect(error?.code).toBe("23505");
  });

  it("[r1-db-open-batch-unique] the database refuses a second open batch for (run, channel)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const error = await pgFailure(
      cloneRow("payroll_disbursement_batches", batchId, ""),
    );
    expect(error?.code).toBe("23505");
  });
});

describe("R7 follow-up batch", () => {
  it("[r7-followup-only-open-slips] after a final batch, a new batch holds only slips whose last attempt is failed/not_sent/returned/cancelled, with attempt_no + 1", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      bank(SITI, 3_000_000),
      bank(ANDI, 2_000_000),
    ]);
    const first = await createBatch(runId);
    // Seed the final state of the first attempt (triggers off on purpose):
    // Budi paid, Siti failed, Andi's file is exported and still unresolved.
    await asTenant(async (c) => {
      const set = (p: Person, status: string) =>
        c.query(
          `UPDATE payroll_disbursement_items
              SET status = $3::text,
                  settled_at = CASE WHEN $3::text = 'succeeded' THEN now() END,
                  confirmed_by = 'seed', confirmation_ref = 'SEED-REF'
            WHERE batch_id = $1 AND employee_id = $2`,
          [first, p.id, status],
        );
      await set(BUDI, "succeeded");
      await set(SITI, "failed");
      await set(ANDI, "exported");
      await forceBatchState(c, first, "partially_failed");
    }, true);

    const second = await createBatch(runId);
    expect(second).not.toBe(first);
    const items = await itemsOf(second);
    expect(items.map((i) => i.employee_id)).toEqual([SITI.id]);
    expect(items[0]!.attempt_no).toBe(2);
    expect(items[0]!.idempotency_key).toBe(
      `payslip:${items[0]!.payslip_id as string}:attempt:2`,
    );
    expect(items[0]!.status).toBe("prepared");
  });

  it("[r7-cancelled-batch-retry] cancelling a batch frees its slips for a new batch (attempt 2)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const first = await createBatch(runId);
    await cancel(first);
    const second = await createBatch(runId);
    const items = await itemsOf(second);
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.attempt_no).toBe(2);
  });

  it("[r7-nothing-left] when every slip already has a live item no empty batch is created", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await asTenant(async (c) => {
      await forceBatchState(c, batchId, "completed");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(), confirmed_by = 'seed', confirmation_ref = 'SEED-REF'
          WHERE payroll_run_id = $1`,
        [runId],
      );
    }, true);
    await expectRefused(createBatch(runId));
    expect(
      await rowsOf(
        "SELECT id FROM payroll_disbursement_batches WHERE payroll_run_id = $1",
        [runId],
      ),
    ).toHaveLength(1);
  });
});

const cancel = (batchId: string, reason = "uji batal") =>
  inTx((tx) => cancelDisbursementBatch(tx, actor(REQ), batchId, { reason }));

describe("submit and approve (R5 two people)", () => {
  it("[submit-excludes-blocked] submit moves draft to pending_approval, cancels blocked items, stores a content hash", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      bank(NOCODE, 1_000_000),
    ]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    const batch = await batchById(batchId);
    expect(batch.status).toBe("pending_approval");
    expect(batch.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("prepared");
    expect((await itemOfPerson(batchId, NOCODE))!.status).toBe("cancelled");
  });

  it("[submit-only-requester] only the requester can submit", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await expectRefused(submit(batchId, APP));
    expect((await batchById(batchId)).status).toBe("draft");
  });

  it("[submit-empty-refused] a batch with only blocked items is never approvable: nothing is left approved", async () => {
    const runId = await seedRun([bank(NOCODE, 1_000_000)]);
    await expectRefused(
      (async () => {
        const batchId = await createBatch(runId);
        await submit(batchId);
      })(),
    );
    const left = await rowsOf(
      `SELECT 1 FROM payroll_disbursement_items WHERE payroll_run_id = $1 AND status = 'approved'`,
      [runId],
    );
    expect(left).toHaveLength(0);
    const batch = await batchRow(runId);
    if (batch) expect(batch.status).not.toBe("pending_approval");
  });

  it("[submit-twice] submitting a pending batch again is refused", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    await expectRefused(submit(batchId), { status: 409 });
  });

  it("[approve-self-refused] the requester cannot approve their own batch: PAYOUT_SELF_APPROVAL, batch stays pending", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    await expectRefused(approve(batchId, REQ), {
      code: "PAYOUT_SELF_APPROVAL",
    });
    const batch = await batchById(batchId);
    expect(batch.status).toBe("pending_approval");
    expect(batch.approved_by).toBeNull();
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("prepared");
  });

  it("[approve-db-check-two-people] the database refuses approved_by = requested_by (CHECK)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const error = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_batches
            SET approved_by = requested_by, approved_at = now() WHERE id = $1`,
        [batchId],
      ),
    );
    expect(error?.code).toBe("23514");
  });

  it("[approve-hash-mismatch] a wrong content hash is refused PAYOUT_HASH_MISMATCH, nothing approved", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    await expectRefused(approve(batchId, APP, "0".repeat(64)), {
      code: "PAYOUT_HASH_MISMATCH",
    });
    expect((await batchById(batchId)).status).toBe("pending_approval");
    expect((await itemOfPerson(batchId, BUDI))!.status).toBe("prepared");
  });

  it("[approve-ok] a second person approves: batch and items approved, approver and 24h expiry stored", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    await approve(batchId);
    const batch = await batchById(batchId);
    expect(batch.status).toBe("approved");
    expect(batch.approved_by).toBe(APP);
    expect(batch.approved_by).not.toBe(batch.requested_by);
    const hours =
      (new Date(batch.approval_expires_at as string).getTime() -
        new Date(batch.approved_at as string).getTime()) /
      3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    for (const item of await itemsOf(batchId))
      expect(item.status).toBe("approved");
  });

  it("[approve-cash-two-people] a cash batch needs the same second person", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await createBatch(runId, "cash");
    await submit(batchId);
    await expectRefused(approve(batchId, REQ), {
      code: "PAYOUT_SELF_APPROVAL",
    });
    await approve(batchId);
    expect((await batchById(batchId)).status).toBe("approved");
    expect((await itemsOf(batchId))[0]!.status).toBe("approved");
  });

  it("[approve-needs-submit] a draft batch cannot be approved", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await expectRefused(approve(batchId, APP, "0".repeat(64)));
    expect((await batchById(batchId)).status).toBe("draft");
  });
});

describe("cancel", () => {
  it("[cancel-pending] cancelling a pending batch cancels its items and frees the slips", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    await cancel(batchId);
    const batch = await batchById(batchId);
    expect(batch.status).toBe("cancelled");
    expect(batch.cancelled_by).toBe(REQ);
    expect(batch.cancelled_reason).toBe("uji batal");
    expect((await itemsOf(batchId))[0]!.status).toBe("cancelled");
  });

  it("[cancel-approved] cancelling an approved batch leaves no approved item behind (cancelled or not_sent)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    await cancel(batchId);
    expect((await batchById(batchId)).status).toBe("cancelled");
    for (const item of await itemsOf(batchId))
      expect(["cancelled", "not_sent"]).toContain(item.status);
  });

  it("[cancel-exported-refused] an exported or completed batch cannot be cancelled", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    await asTenant(async (c) => {
      await forceBatchState(c, batchId, "exported");
      await c.query(
        `UPDATE payroll_disbursement_items SET status = 'exported' WHERE batch_id = $1`,
        [batchId],
      );
    }, true);
    await expectRefused(cancel(batchId), { status: 409 });
    expect((await batchById(batchId)).status).toBe("exported");
    expect((await itemsOf(batchId))[0]!.status).toBe("exported");
  });
});

describe("read", () => {
  it("[read-get-list] get and list find the batch of this tenant; another tenant id is not found", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const got = await inTx((tx) =>
      getDisbursementBatch(tx, tenant.id, batchId),
    );
    expect(JSON.stringify(got)).toContain(batchId);
    const listed = await inTx((tx) =>
      listDisbursementBatches(tx, tenant.id, runId),
    );
    expect(JSON.stringify(listed)).toContain(batchId);
    await expectRefused(
      inTx((tx) => getDisbursementBatch(tx, randomUUID(), batchId)),
      { status: 404 },
    );
  });
});

describe("item state machine and write guard (DB triggers)", () => {
  it("[item-transition-skip] prepared -> succeeded is refused by the database even with every CHECK field filled", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const error = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(), confirmed_by = 'x', confirmation_ref = 'REF'
          WHERE batch_id = $1`,
        [batchId],
      ),
    );
    expect(error, "prepared -> succeeded must be refused").not.toBeNull();
    expect((await itemsOf(batchId))[0]!.status).toBe("prepared");
  });

  it("[item-transition-backwards] a succeeded item cannot go back to approved", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await approvedBatch(runId, "cash");
    // valid cash move: approved -> succeeded (confirmed_by + settled_at)
    await rowsOf(
      `UPDATE payroll_disbursement_items
          SET status = 'succeeded', settled_at = now(), confirmed_by = 'x'
        WHERE batch_id = $1`,
      [batchId],
    );
    const error = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_items SET status = 'approved' WHERE batch_id = $1`,
        [batchId],
      ),
    );
    expect(error, "succeeded -> approved must be refused").not.toBeNull();
    expect((await itemsOf(batchId))[0]!.status).toBe("succeeded");
  });

  it("[item-immutable-after-approved] after approval amount, snapshot, bank code, batch and channel cannot change; other columns still can", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
    const batchId = await approvedBatch(runId);
    const budi = (await itemOfPerson(batchId, BUDI))!;
    const siti = (await itemOfPerson(batchId, SITI))!;
    const attempts: [string, unknown[]][] = [
      [
        "amount_encrypted = (SELECT amount_encrypted FROM payroll_disbursement_items WHERE id = $2)",
        [budi.id, siti.id],
      ],
      ["bank_code = '008'", [budi.id]],
      [
        "bank_snapshot_id = (SELECT bank_snapshot_id FROM payroll_disbursement_items WHERE id = $2)",
        [budi.id, siti.id],
      ],
      ["channel = 'cash'", [budi.id]],
    ];
    for (const [set, params] of attempts) {
      const error = await pgFailure(
        rowsOf(
          `UPDATE payroll_disbursement_items SET ${set} WHERE id = $1`,
          params,
        ),
      );
      expect(error, set).not.toBeNull();
    }
    // Control: a non-frozen column is writable, so the refusals above come
    // from the guard and not from a broken statement.
    await rowsOf(
      `UPDATE payroll_disbursement_items SET last_response_code = 'X' WHERE id = $1`,
      [budi.id],
    );
    expect((await itemOfPerson(batchId, BUDI))!.last_response_code).toBe("X");
  });

  it("[item-resolved-two-people] resolved_by and resolved_by_2 must differ (CHECK)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const error = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_items SET resolved_by = 'same', resolved_by_2 = 'same' WHERE batch_id = $1`,
        [batchId],
      ),
    );
    expect(error?.code).toBe("23514");
  });

  it("[item-no-doit] the channel vocabulary of items and batches excludes doit (CHECK)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    const onItem = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_items SET channel = 'doit' WHERE batch_id = $1`,
        [batchId],
      ),
    );
    expect(onItem?.code).toBe("23514");
    const onBatch = await pgFailure(
      rowsOf(
        `UPDATE payroll_disbursement_batches SET channel = 'doit' WHERE id = $1`,
        [batchId],
      ),
    );
    expect(onBatch?.code).toBe("23514");
  });
});

describe("payout config", () => {
  it("[config-upsert-and-get] upsert stores the manual config; get returns it", async () => {
    const stored = await inTx((tx) =>
      upsertPayoutConfig(tx, actor(REQ), entityId, {
        method: "manual_bank",
        manualSourceBankAccountId: bankAccountId,
        manualBankFormat: "generic_csv",
        maxPerTransferIdr: 50_000_000,
        feePerTransferIdr: 5000,
        enabled: true,
      } as never),
    );
    expect(stored).toBeTruthy();
    const read = await inTx((tx) => getPayoutConfig(tx, tenant.id, entityId));
    expect(JSON.stringify(read)).toContain(bankAccountId);
    const rows = await rowsOf(
      `SELECT * FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [tenant.id, entityId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("manual_bank");
    expect(rows[0]!.integration_id).toBeNull();
    expect(rows[0]!.updated_by).toBe(REQ);
  });

  it("[config-busy] changing enabled/method/source account while a batch is pending_approval|approved|sending|exported|halted is 409 PAYOUT_CONFIG_BUSY", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    await expectRefused(
      inTx((tx) =>
        upsertPayoutConfig(tx, actor(REQ), entityId, {
          method: "manual_bank",
          manualSourceBankAccountId: bankAccountId,
          manualBankFormat: "generic_csv",
          maxPerTransferIdr: 50_000_000,
          feePerTransferIdr: 5000,
          enabled: false,
        } as never),
      ),
      { status: 409, code: "PAYOUT_CONFIG_BUSY" },
    );
    expect(
      (
        await rowsOf(
          "SELECT enabled FROM payroll_payout_configs WHERE legal_entity_id = $1",
          [entityId],
        )
      )[0]!.enabled,
    ).toBe(true);
    await cancel(batchId);
  });

  it("[config-db-checks] the database refuses duitku without integration, max per transfer over 100 million or <= 0, negative fee, a second config per PT", async () => {
    const attempts: Record<string, string> = {
      "duitku needs an integration": `method = 'duitku', integration_id = NULL`,
      "manual_bank has no integration": `integration_id = gen_random_uuid()`,
      "max over 100 million": `max_per_transfer_idr = 100000001`,
      "max zero": `max_per_transfer_idr = 0`,
      "negative fee": `fee_per_transfer_idr = -1`,
    };
    for (const [name, set] of Object.entries(attempts)) {
      const error = await pgFailure(
        rowsOf(
          `UPDATE payroll_payout_configs SET ${set} WHERE tenant_id = $1 AND legal_entity_id = $2`,
          [tenant.id, entityId],
        ),
      );
      expect(error, name).not.toBeNull();
    }
    const id = (
      await rowsOf(
        "SELECT id FROM payroll_payout_configs WHERE legal_entity_id = $1",
        [entityId],
      )
    )[0]!.id as string;
    const duplicate = await pgFailure(
      cloneRow("payroll_payout_configs", id, ""),
    );
    expect(duplicate?.code).toBe("23505");
  });
});

describe("R10 and R11 run guards", () => {
  const reversal = JSON.stringify({
    status: "approved",
    reason: "Uji langsung lewat SQL",
    requestedBy: "req-user",
    requestedAt: "2041-11-30T00:00:00.000Z",
    decidedBy: "dec-user",
    decidedAt: "2041-11-30T00:01:00.000Z",
  });
  // 911 (legend-izza4): the run guard no longer reads the app.payout_settle
  // GUC. `settle = true` is the trusted payout role (what app.payout_run_settle
  // runs as); `"guc"` is only the old self-set setting, which buys nothing.
  const markPaid = (runId: string, settle: boolean | "guc") =>
    asTenant(async (c) => {
      if (settle === "guc")
        await c.query("SELECT set_config('app.payout_settle', 'on', true)");
      if (settle === true) await c.query("SET LOCAL ROLE legend_payout");
      await c.query(
        `UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = 'tester' WHERE id = $1`,
        [runId],
      );
    });
  const reverse = (runId: string) =>
    rowsOf(
      `UPDATE payroll_runs SET status = 'reversed', reversal = $2::jsonb WHERE id = $1`,
      [runId, reversal],
    );

  it("[r10-paid-needs-settle] a run with a batch cannot be marked paid by hand, nor with the old app.payout_settle GUC; only the payout role (app.payout_run_settle) can; a run without batch is unchanged", async () => {
    const withBatch = await seedRun([bank(BUDI, 4_000_000)]);
    await createBatch(withBatch);
    const error = await pgFailure(markPaid(withBatch, false));
    expect(
      error,
      "manual paid on a batched run must be refused",
    ).not.toBeNull();
    expect(await runStatus(withBatch)).toBe("locked");
    // 911: the self-set GUC alone is no key any more (PAYOUT-22).
    const gucOnly = await pgFailure(markPaid(withBatch, "guc"));
    expect(gucOnly, "the GUC alone must not mark the run paid").not.toBeNull();
    expect(await runStatus(withBatch)).toBe("locked");
    await markPaid(withBatch, true);
    expect(await runStatus(withBatch)).toBe("paid");

    const plain = await seedRun([bank(SITI, 1_000_000)]);
    await markPaid(plain, false);
    expect(await runStatus(plain)).toBe("paid");
  });

  it("[r10-cancelled-batch-releases] a run whose only batch is cancelled can be marked paid the old way", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await cancel(batchId);
    await markPaid(runId, false);
    expect(await runStatus(runId)).toBe("paid");
  });

  it("[r11-reverse-blocked-db] the database refuses reversing a run while its batch is approved; allowed once the batch is cancelled; a run without batch is unchanged", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await approvedBatch(runId);
    const error = await pgFailure(reverse(runId));
    expect(error, "reversal with an open batch must be refused").not.toBeNull();
    expect(await runStatus(runId)).toBe("locked");
    await cancel(batchId);
    await reverse(runId);
    expect(await runStatus(runId)).toBe("reversed");

    const plain = await seedRun([bank(SITI, 1_000_000)]);
    await reverse(plain);
    expect(await runStatus(plain)).toBe("reversed");
  });

  it("[r11-reverse-blocked-succeeded-item] a succeeded item blocks reversal even when its batch is completed", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await asTenant(async (c) => {
      await forceBatchState(c, batchId, "completed");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(), confirmed_by = 'seed', confirmation_ref = 'SEED-REF'
          WHERE batch_id = $1`,
        [batchId],
      );
    }, true);
    const error = await pgFailure(reverse(runId));
    expect(error, "money was paid: no reversal").not.toBeNull();
    expect(await runStatus(runId)).toBe("locked");
  });

  it("[r11-reverse-blocked-service] the reversal request is refused 409 PAYOUT_RUN_REVERSAL_BLOCKED while a batch is open; works for a run without batch", async () => {
    const locker = await signedInClient("Payout core locker");
    await grantRole(locker.userId, [
      "payroll.view",
      "payroll.lock",
      "payroll.cancel.approve",
    ]);
    const request = (runId: string) =>
      inTx((tx) =>
        requestPayrollRunReversalInTransaction(
          tx,
          scope(),
          locker.userId,
          runId as never,
          "Uji pembalikan dengan batch terbuka",
        ),
      );
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    await approvedBatch(runId);
    await expectRefused(request(runId), {
      status: 409,
      code: "PAYOUT_RUN_REVERSAL_BLOCKED",
    });
    const plain = await seedRun([bank(SITI, 1_000_000)]);
    await expect(request(plain)).resolves.toBeTruthy();
  });
});

// ---- Fix round 1 (648-fix1.md) --------------------------------------------

const duitkuInput = (integrationId: string, bankId: string) =>
  ({
    method: "duitku",
    integrationId,
    manualSourceBankAccountId: bankId,
    manualBankFormat: "generic_csv",
    maxPerTransferIdr: 50_000_000,
    feePerTransferIdr: 5000,
    enabled: false,
  }) as never;
const configRows = (legalEntityId: string) =>
  rowsOf(
    "SELECT * FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenant.id, legalEntityId],
  );

describe("M1 a duitku config needs an active duitku integration of this tenant", () => {
  it("[m1-integration-refused] an unknown id, another tenant's integration and another provider's integration are all 422 and nothing is stored", async () => {
    const { entityId: entity, bankId } = await extraEntityWithBank();
    const foreign = await integrationFor(otherTenant, "duitku");
    const wrongProvider = await integrationFor(tenant.id, "doit");
    for (const integrationId of [randomUUID(), foreign, wrongProvider])
      await expectRefused(
        inTx((tx) =>
          upsertPayoutConfig(
            tx,
            actor(REQ),
            entity,
            duitkuInput(integrationId, bankId),
          ),
        ),
        { status: 422 },
      );
    expect(await configRows(entity)).toHaveLength(0);
  });

  it("[m1-integration-ok] an active duitku integration of the same tenant is stored (control)", async () => {
    const { entityId: entity, bankId } = await extraEntityWithBank();
    const own = await integrationFor(tenant.id, "duitku");
    await inTx((tx) =>
      upsertPayoutConfig(tx, actor(REQ), entity, duitkuInput(own, bankId)),
    );
    const rows = await configRows(entity);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("duitku");
    expect(rows[0]!.integration_id).toBe(own);
  });

  it("[m1-db-tenant-match] the database refuses a config that points at an integration of another tenant; the same tenant's is accepted", async () => {
    const foreign = await integrationFor(otherTenant, "duitku");
    const own = await integrationFor(tenant.id, "duitku");
    const point = (integrationId: string) =>
      probe(
        `UPDATE payroll_payout_configs SET method = 'duitku', integration_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenant.id, entityId, integrationId],
      );
    const refused = await point(foreign);
    expect(refused, "foreign integration must be refused").not.toBeNull();
    expect(await point(own), "control: own integration").toBeNull();
  });
});

describe("L6 a manual batch needs the config method manual_bank", () => {
  it("[l6-method-duitku-no-manual-batch] with method duitku (enabled) a manual_bank batch is 409 PAYOUT_CHANNEL_NOT_AVAILABLE and nothing is written", async () => {
    const own = await integrationFor(tenant.id, "duitku");
    const runId = await seedRun([bank(BUDI, 1_000_000)]);
    // Triggers off on purpose: only the create-time check is under test.
    await asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_configs SET method = 'duitku', integration_id = $3, enabled = true
            WHERE tenant_id = $1 AND legal_entity_id = $2`,
          [tenant.id, entityId, own],
        ),
      true,
    );
    try {
      await expectRefused(createBatch(runId), {
        status: 409,
        code: "PAYOUT_CHANNEL_NOT_AVAILABLE",
      });
      expect(await batchRow(runId)).toBeUndefined();
    } finally {
      await asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_configs SET method = 'manual_bank', integration_id = NULL, enabled = true
              WHERE tenant_id = $1 AND legal_entity_id = $2`,
            [tenant.id, entityId],
          ),
        true,
      );
    }
    // Control: restored config, the same create works.
    await createBatch(runId);
    expect(await batchRow(runId)).toBeDefined();
  });
});

describe("L2 snapshot match guard while an item is prepared or blocked", () => {
  it("[l2-snapshot-match-on-update] a prepared item cannot be pointed at another payslip's snapshot or another bank code; a blocked item cannot get a code its snapshot lacks", async () => {
    const runId = await seedRun([
      bank(BUDI, 4_000_000),
      bank(SITI, 3_000_000),
      bank(NOCODE, 1_000_000),
    ]);
    const batchId = await createBatch(runId);
    const budi = (await itemOfPerson(batchId, BUDI))!;
    const siti = (await itemOfPerson(batchId, SITI))!;
    const nocode = (await itemOfPerson(batchId, NOCODE))!;
    expect(budi.status).toBe("prepared");
    expect(nocode.status).toBe("blocked");
    const update = (set: string, params: unknown[]) =>
      pgFailure(
        rowsOf(
          `UPDATE payroll_disbursement_items SET ${set} WHERE id = $1`,
          params,
        ),
      );
    expect(
      await update(
        "bank_snapshot_id = (SELECT bank_snapshot_id FROM payroll_disbursement_items WHERE id = $2)",
        [budi.id, siti.id],
      ),
      "snapshot of another payslip",
    ).not.toBeNull();
    expect(
      await update("bank_code = '008'", [budi.id]),
      "bank code differs from the snapshot",
    ).not.toBeNull();
    expect(
      await update("bank_code = '014'", [nocode.id]),
      "blocked item must not gain a code its snapshot lacks",
    ).not.toBeNull();
    const after = (await itemOfPerson(batchId, NOCODE))!;
    expect(after.status).toBe("blocked");
    expect(after.bank_code).toBeNull();
    // Control: a value equal to the snapshot's and a harmless column pass.
    expect(
      await update("bank_code = '014', last_response_code = 'X'", [budi.id]),
    ).toBeNull();
  });
});

describe("L3 settle cannot mark a run paid while money is in flight", () => {
  // 911: the trusted payout role (as inside app.payout_run_settle); L3
  // (PAYOUT-23) still refuses it while money is in flight.
  const settlePaid = (runId: string) =>
    pgFailure(
      asTenant(async (c) => {
        await c.query("SET LOCAL ROLE legend_payout");
        await c.query(
          `UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = 'tester' WHERE id = $1`,
          [runId],
        );
      }),
    );

  it("[l3-paid-refused-in-flight] pending_approval, approved, exported batches and an unknown item all refuse paid even for the payout role", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await submit(batchId);
    expect(await settlePaid(runId), "pending_approval").not.toBeNull();
    await approve(batchId);
    expect(await settlePaid(runId), "approved").not.toBeNull();
    await asTenant(async (c) => {
      await forceBatchState(c, batchId, "exported");
      await c.query(
        `UPDATE payroll_disbursement_items SET status = 'exported' WHERE batch_id = $1`,
        [batchId],
      );
    }, true);
    expect(await settlePaid(runId), "exported").not.toBeNull();
    expect(await runStatus(runId)).toBe("locked");

    const other = await seedRun([bank(SITI, 3_000_000)]);
    const otherBatch = await createBatch(other);
    await asTenant(async (c) => {
      await forceBatchState(c, otherBatch, "completed");
      await c.query(
        `UPDATE payroll_disbursement_items SET status = 'unknown' WHERE batch_id = $1`,
        [otherBatch],
      );
    }, true);
    expect(await settlePaid(other), "unknown item").not.toBeNull();
    expect(await runStatus(other)).toBe("locked");
  });

  it("[l3-paid-ok-when-settled] a completed batch with a succeeded item lets the settle code mark the run paid (control)", async () => {
    const runId = await seedRun([bank(BUDI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await asTenant(async (c) => {
      await forceBatchState(c, batchId, "completed");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(), confirmed_by = 'seed', confirmation_ref = 'SEED-REF'
          WHERE batch_id = $1`,
        [batchId],
      );
    }, true);
    expect(await settlePaid(runId)).toBeNull();
    expect(await runStatus(runId)).toBe("paid");
  });

  // 911 (legend-izza4): app.payout_run_settle is the only door to `paid` for
  // the app role; it re-checks the sealed-data conditions itself.
  const settleFn = (runId: string, batchId: string) =>
    asTenant(async (c) => {
      await c.query("SET LOCAL ROLE legend_app");
      const { rows } = await c.query(
        `SELECT app.payout_run_settle($1::uuid, '{}'::uuid[]) AS paid`,
        [batchId],
      );
      return rows[0].paid as boolean;
    }).then(async (paid) => ({ paid, status: await runStatus(runId) }));

  it("[l3-settle-fn-control] legend_app calls app.payout_run_settle: true and the run is paid when every slip has a succeeded item; false and the run stays locked while an item is still exported", async () => {
    const open = await seedRun([bank(BUDI, 4_000_000)]);
    const openBatch = await createBatch(open);
    await asTenant(async (c) => {
      await forceBatchState(c, openBatch, "exported");
      await c.query(
        `UPDATE payroll_disbursement_items SET status = 'exported' WHERE batch_id = $1`,
        [openBatch],
      );
    }, true);
    expect(await settleFn(open, openBatch)).toEqual({
      paid: false,
      status: "locked",
    });

    const runId = await seedRun([bank(SITI, 4_000_000)]);
    const batchId = await createBatch(runId);
    await asTenant(async (c) => {
      await forceBatchState(c, batchId, "completed");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(), confirmed_by = 'seed', confirmation_ref = 'SEED-REF'
          WHERE batch_id = $1`,
        [batchId],
      );
    }, true);
    expect(await settleFn(runId, batchId)).toEqual({
      paid: true,
      status: "paid",
    });
  });
});

describe("L4 a succeeded item is frozen", () => {
  it("[l4-succeeded-frozen] confirmation_ref, confirmed_by, settled_at and provider_ref cannot change on a succeeded item; succeeded -> returned still works", async () => {
    const runId = await seedRun([cash(CASHIER, 2_000_000)]);
    const batchId = await approvedBatch(runId, "cash");
    // 911: the payment record is written only by the payout role (PAYOUT-74).
    await asTenant(async (c) => {
      await c.query("SET LOCAL ROLE legend_payout");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(), confirmed_by = 'x', confirmation_ref = 'REF-1'
          WHERE batch_id = $1`,
        [batchId],
      );
    });
    const update = (set: string) =>
      pgFailure(
        rowsOf(
          `UPDATE payroll_disbursement_items SET ${set} WHERE batch_id = $1`,
          [batchId],
        ),
      );
    for (const set of [
      "confirmation_ref = 'FAKE'",
      "confirmed_by = 'someone-else'",
      "settled_at = settled_at + interval '1 day'",
      "provider_ref = 'PROV-1'",
    ])
      expect(await update(set), set).not.toBeNull();
    const item = (await itemsOf(batchId))[0]!;
    expect(item.status).toBe("succeeded");
    expect(item.confirmation_ref).toBe("REF-1");
    expect(item.confirmed_by).toBe("x");
    expect(item.provider_ref).toBeNull();
    // Without two different returners the move is refused (legend-qxkm6).
    expect(
      await update("status = 'returned', returned_at = now()"),
    ).not.toBeNull();
    // 905 (A1): even with two returners, plain SQL by the app role may no
    // longer move a succeeded item: only the payout role's trusted return
    // function does (PAYOUT-60). The two-person return path is proven
    // through the service in payroll-payout-proposal.test.ts.
    const twoReturners = await update(
      `status = 'returned', returned_at = now(), returned_by = 'returner-1',
       returned_by_2 = 'returner-2', return_evidence_key = 'bukti/kembali.pdf',
       return_note = 'Dana kembali dari bank'`,
    );
    expect(twoReturners?.code).toBe("23514");
    expect(twoReturners?.message).toMatch(/PAYOUT-60/);
    expect((await itemsOf(batchId))[0]!.status).toBe("succeeded");
  });
});
