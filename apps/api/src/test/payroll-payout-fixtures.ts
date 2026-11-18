// Shared fixtures for the payout GL and evidence tests (bead legend-658,
// docs/design/payroll-disbursement.md 6 R9/R10, 8). Not a test file: it is
// imported by payroll-payout-gl.test.ts and payroll-payout-evidence.test.ts.
// Call `installPayoutWorld()` once at the top level of a test file; it
// registers beforeAll/afterAll and returns the helpers.
//
// The PT is a fresh legal entity of the cafe-legend fixture tenant with the
// standard chart (1103 bank, 1102 petty cash, 2103 salaries payable, 8101 bank
// admin expense), a manual_bank payout config (generic_csv) whose source bank
// account points at 1103, and fiscal periods around "today". Everything is
// removed in afterAll (journals included, with triggers off like the other
// payroll suites do) so the shared tenant is left clean.
//
// EVIDENCE KEY CONTRACT assumed by both tests (design 9 / bead f5n9y): a
// payment-proof key is bound to the tenant storage of the batch it belongs to:
//   tenants/<tenantId>/payroll-payout/<batchId>/<fileName>
// `evidenceKeyFor` is the single place to change if the engineer picks a
// different format.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import type { ObjectStorage } from "@starter/shared/adapters";
import { CoreError, createUlid, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  payrollConfigSnapshotSchema,
  payrollLocked,
  payrollRunTotalsSchema,
} from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import type { PayoutEvidenceStore } from "../services/payroll-payout-evidence.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { provisionStandardChart } from "../services/accounting-provisioning.service.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import type { Tx } from "../services/hris-access.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { recordOverpaidItems } from "../services/payroll-payout-overpaid-route.service.ts";
import type {
  PayoutGrantBinding,
  PayoutGrantIssuer,
} from "../services/payroll-payout-grant.service.ts";
import { snapshotPayeeBankForLock } from "../services/payroll-bank-snapshot.service.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  confirmCashHandover,
  confirmManualItems,
  exportManualBatch,
  resolveManualItems,
} from "../services/payroll-payout-manual.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";

export type Row = Record<string, unknown>;
export type Person = {
  id: string;
  name: string;
  account: string;
  bankCode: string | null;
};
export type Slip = {
  person: Person;
  method: "bank_transfer" | "cash";
  net: number;
};

const tenant = cafeLegendPlatformFixtures.tenant;
const outlet = cafeLegendPlatformFixtures.outlets[0];

export const REQ = `payout-gl-req-${randomUUID()}`;
export const APP = `payout-gl-app-${randomUUID()}`;
export const APP2 = `payout-gl-app2-${randomUUID()}`;
export const APP3 = `payout-gl-app3-${randomUUID()}`;
/**
 * The Better Auth session id of a fixture actor: one per user, derived from the
 * user id so `actorOf` stays synchronous. The row is created by
 * `installPayoutWorld` (`provisionActor`) for the fixture constants and for
 * every user made through `signedInClient`; the trusted payout paths
 * (`app.payout_assert_actor`) check it is live with a fresh MFA step-up.
 */
const sessionIdOf = (userId: string) => `payout-fixture-session-${userId}`;

/**
 * The test stand-in of the grantor login (migration 0419): a short owner
 * connection that does `SET LOCAL ROLE legend_payout_grantor`, sets the tenant
 * and calls `app.payout_grant_issue` with the real COMMIT, so the grant is
 * visible to the payout transaction (READ COMMITTED) exactly as in production.
 * It skips the request step-up the real issuer checks; the SQL still checks
 * the actor (live session, fresh MFA, permission).
 */
export function testGrantIssuer(actor: {
  tenantId: string;
  userId: string;
  sessionId?: string;
}): PayoutGrantIssuer {
  return {
    async issue(binding: PayoutGrantBinding): Promise<string> {
      const pool = new Pool({
        connectionString: process.env.STARTER_TEST_DATABASE_URL,
        max: 1,
      });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE legend_payout_grantor");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [
          actor.tenantId,
        ]);
        const { rows } = await client.query(
          `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid, $8::varchar, $9::text, $10::text, $11::text) AS grant`,
          [
            binding.kind,
            binding.step,
            binding.batchId,
            `{${binding.itemIds.join(",")}}`,
            binding.evidenceKey,
            binding.refId,
            binding.targetId,
            binding.detail ?? null,
            actor.userId,
            actor.sessionId ?? null,
            "mfa_challenge",
          ],
        );
        await client.query("COMMIT");
        return (rows[0] as { grant: string }).grant;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
    },
  };
}

export const actorOf = (userId: string) => {
  const actor = {
    tenantId: tenant.id as string,
    userId,
    sessionId: sessionIdOf(userId),
  };
  return { ...actor, grants: testGrantIssuer(actor) };
};

/**
 * A full `PayoutActor` for the trusted payout paths (correction, overpaid,
 * return, closure, posting source): inserts a live Better Auth session of
 * `userId` with `mfa_verified_at = now()` (what `app.payout_assert_actor`
 * checks) and returns the actor carrying its id. The user must already exist.
 */
export async function payoutActorSession(tenantId: string, userId: string) {
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  try {
    const sessionId = randomUUID();
    await owner.query(
      `INSERT INTO session (id, expires_at, token, user_id, tenant_id, mfa_verified_at)
       VALUES ($1, now() + interval '1 day', $2, $3, $4, now())`,
      [sessionId, randomBytes(16).toString("hex"), userId, tenantId],
    );
    const actor = { tenantId, userId, sessionId };
    return { ...actor, grants: testGrantIssuer(actor) };
  } finally {
    await owner.end();
  }
}

export const evidenceKeyFor = (
  tenantId: string,
  batchId: string,
  fileName = "laporan-bank.pdf",
) => `tenants/${tenantId}/payroll-payout/${batchId}/${fileName}`;

/**
 * Payment-proof storage of the fixtures (legend-01gg8): resolve, return,
 * confirm and the overpaid record accept a key only when its object is stored.
 * `uploadEvidence` stages one, the way a real upload would; any other key is
 * "not found". Only `get` is implemented (the existence probe and the
 * fingerprint read).
 */
const stagedProofs = new Set<string>();
const proofStorage = {
  async get(_context, input) {
    if (!stagedProofs.has(`${input.tenantId}/${input.key}`))
      throw new CoreError("NOT_FOUND", "Objek tidak ditemukan.");
    // Distinct, non-empty bytes per key: an empty object is no proof
    // (legend-so897 F3), and two staged keys are two different documents.
    return {
      ...input,
      contentType: "application/pdf",
      content: `fixture proof ${input.tenantId}/${input.key}`,
    };
  },
} as ObjectStorage;
/** Stores a proof for the batch and returns its key (the fixture tenant). */
export const uploadEvidence = (
  batchId: string,
  fileName = "laporan-bank.pdf",
) => {
  const key = evidenceKeyFor(tenant.id, batchId, fileName);
  stagedProofs.add(`${tenant.id}/${key}`);
  return key;
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
export const BUDI = person("Budi Santoso", "014");
export const SITI = person("Siti Aminah", "014");
export const ANDI = person("Andi Wijaya", "014");
export const CASHIER = person("Kasir Tunai", "014");
const ALL_PEOPLE = [BUDI, SITI, ANDI, CASHIER];

export const bank = (p: Person, net: number): Slip => ({
  person: p,
  method: "bank_transfer",
  net,
});
export const cash = (p: Person, net: number): Slip => ({
  person: p,
  method: "cash",
  net,
});

const day = (n: number) =>
  new Date(Date.UTC(2043, 0, 1 + n)).toISOString().slice(0, 10);

const STEPS = [
  `status = 'simulated', simulation_count = 1, last_simulated_at = now()`,
  `status = 'hr_approved', approved_by_hr = '00000000-0000-4000-8000-0000000000a1', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = '00000000-0000-4000-8000-0000000000a2', approved_by_finance_at = now()`,
];

function calculation(p: Person, net: number, method: string, days: string[]) {
  return {
    employeeId: p.id,
    employeeNo: `PG-${p.id.slice(0, 8).toUpperCase()}`,
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

/** Run totals that pass payrollRunTotalsSchema (net = bank + cash, gross = net, no tax). */
export function runTotals(slips: Slip[]) {
  const sum = (method: string) =>
    slips
      .filter((s) => s.method === method)
      .reduce((total, s) => total + s.net, 0);
  const net = sum("bank_transfer") + sum("cash");
  return payrollRunTotalsSchema.parse({
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
  });
}

export const netOf = (slips: Slip[]) =>
  slips.reduce((total, s) => total + s.net, 0);

export function installPayoutWorld(label: string) {
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 3,
  });
  const app = createApp({
    storageRuntime: {
      storage: proofStorage,
      scanner: new NoopMalwareScanner(),
      fileSigner: async () => "https://signed.example.test/x",
      hrisDocumentSigner: async () => null,
    },
  });
  const entityId = randomUUID();
  const policyId = randomUUID();
  const createdRuns: string[] = [];
  const createdEmployees: string[] = [];
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  const actorUsers: string[] = [];
  const actorSessions: string[] = [];
  let mfaRefresh: NodeJS.Timeout | undefined;
  let bankAccountId = "";
  let hr: ReturnType<typeof agent>;

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
  /** The proof store the payout services check keys against. */
  const proofs = () => ({ storage: proofStorage, context: scope() });

  async function asTenant<T>(
    run: (client: PoolClient) => Promise<T>,
    raw = false,
  ): Promise<T> {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      if (raw)
        await client.query("SET LOCAL session_replication_role = replica");
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

  /**
   * Like `asTenant`, but the statements of `run` execute as the `legend_payout`
   * role (`SET LOCAL ROLE`, legend-r86qa/izza4): the only role that may move an
   * item out of `exported`, write the resolution or payment record, or turn a
   * run `paid` (outside the trusted functions that run as it). For seeds that
   * force such a state by SQL and for tests of the trigger guards. The owner
   * login is a superuser in tests, so no membership grant is needed. `raw`
   * turns triggers off like in `asTenant`.
   */
  const asPayoutRole = <T>(
    run: (client: PoolClient) => Promise<T>,
    raw = false,
  ): Promise<T> =>
    asTenant(async (client) => {
      await client.query("SET LOCAL ROLE legend_payout");
      return run(client);
    }, raw);
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
    await provisionActor(userId, { user: false, permit: false });
    return { client, userId };
  }

  /**
   * What `app.payout_assert_actor` checks about the human behind a trusted
   * step: the user row (`user: true` creates it), a live session with a fresh
   * MFA step-up (the id `actorOf` returns) and, with `permit`, a tenant role
   * carrying `payroll.disburse.approve`.
   */
  async function provisionActor(
    userId: string,
    { user, permit }: { user: boolean; permit: boolean },
  ) {
    const sessionId = sessionIdOf(userId);
    actorSessions.push(sessionId);
    if (user) {
      actorUsers.push(userId);
      await owner.query(
        `INSERT INTO "user" (id, name, email, email_verified)
         VALUES ($1, $2, $3, true) ON CONFLICT (id) DO NOTHING`,
        [userId, `Payout ${label} actor`, `${userId}@payout-fixture.test`],
      );
    }
    await owner.query(
      `INSERT INTO session (id, expires_at, token, user_id, tenant_id, mfa_verified_at)
       VALUES ($1, now() + interval '1 day', $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET mfa_verified_at = now()`,
      [sessionId, randomBytes(16).toString("hex"), userId, tenant.id],
    );
    if (permit) {
      createdUsers.push(userId);
      await grantRole(userId, ["payroll.disburse.approve"]);
    }
  }
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
          `Payout ${label} ${roleId.slice(0, 8)}`,
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
  async function seedRun(slips: Slip[]) {
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
    if (payees.length > 0)
      await inTx((tx) =>
        snapshotPayeeBankForLock(tx, tenant.id, runId, payees),
      );
    return runId;
  }

  // ---- Payroll GL: the run journal (Dr salary expense / Cr 2103) ----------

  /**
   * Posts the `payroll.locked` journal of the run through the real consumer,
   * so the payout settle has a locked entry to settle against. Without this
   * call a run is the "accounting switched on after the lock" case.
   */
  async function postLockedJournal(runId: string, slips: Slip[]) {
    const lockedAt = "2026-10-26T05:00:00.000Z";
    const event = payrollLocked.envelopeSchema.parse({
      id: createUlid(),
      tenantId: tenant.id,
      outletId: null,
      name: "payroll.locked",
      version: 1,
      aggregateType: "payroll",
      aggregateId: runId,
      sequence: 1,
      occurredAt: lockedAt,
      actor: { type: "user", id: randomUUID() },
      deviceId: null,
      idempotencyKey: `payroll.locked-${runId}-${randomUUID()}`,
      payloadSchemaRef: "payroll.locked.v1",
      payload: {
        payrollRunId: runId,
        legalEntityId: entityId,
        runType: "regular",
        periodStart: "2026-09-26",
        periodEnd: "2026-10-25",
        payDate: "2026-10-27",
        totals: runTotals(slips),
        lockedBy: randomUUID(),
        lockedAt,
      },
    });
    return deliverGl(event);
  }

  function deliverGl(event: unknown) {
    return withTenant(db, scope(), (tx) =>
      deliverPayrollGlEvent(
        scope(),
        event as Parameters<typeof deliverPayrollGlEvent>[1],
        tx,
        new Date("2026-11-30T03:00:00Z"),
      ),
    );
  }

  /** A `payroll.paid` envelope with any payload, not parsed (the schema may predate the fields under test). */
  function paidEnvelope(
    runId: string,
    slips: Slip[],
    extra: Record<string, unknown> = {},
  ) {
    const totals = runTotals(slips);
    const paidAt = "2026-11-27T05:00:00.000Z";
    return {
      id: createUlid(),
      tenantId: tenant.id,
      outletId: null,
      name: "payroll.paid",
      version: 1,
      aggregateType: "payroll",
      aggregateId: runId,
      sequence: 2,
      occurredAt: paidAt,
      actor: { type: "user", id: randomUUID() },
      deviceId: null,
      idempotencyKey: `payroll.paid-${runId}-${randomUUID()}`,
      payloadSchemaRef: "payroll.paid.v1",
      payload: {
        payrollRunId: runId,
        legalEntityId: entityId,
        runType: "regular",
        periodStart: "2026-09-26",
        periodEnd: "2026-10-25",
        payDate: "2026-10-27",
        netIdr: totals.netIdr,
        bankTransferIdr: totals.bankTransferIdr,
        cashIdr: totals.cashIdr,
        bankTransferFileId: null,
        paidBy: randomUUID(),
        paidAt,
        ...extra,
      },
    };
  }

  // ---- Cash in 1102 (approve guard, legend-rvao9) ----------------------

  /**
   * Puts `amountIdr` into GL 1102 (Dr 1102 / Cr 1103, a plain balanced journal
   * seeded by SQL) so approving a cash batch passes the cash-cover guard. Setup
   * only: no petty cash fund or outbox event is touched. The journal is removed
   * with the rest of the entity in afterAll.
   */
  async function fundPettyCash(amountIdr: number) {
    const now = new Date(Date.now() + 7 * 3_600_000);
    const date = now.toISOString().slice(0, 10);
    await asTenant(async (c) => {
      const account = async (code: string) =>
        (
          await c.query(
            `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
            [tenant.id, entityId, code],
          )
        ).rows[0].id as string;
      const period = (
        await c.query(
          `SELECT id FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3`,
          [tenant.id, entityId, date.slice(0, 7)],
        )
      ).rows[0].id as string;
      const entry = (
        await c.query(
          `INSERT INTO journal_entries
             (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
              source_id, description, idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, $4, 'sale', NULL, 'Saldo kas kecil uji payout', $5, $6)
           RETURNING id`,
          [
            tenant.id,
            entityId,
            date,
            period,
            `payout-fund-1102-${randomUUID()}`,
            randomBytes(32).toString("hex"),
          ],
        )
      ).rows[0].id as string;
      await c.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
        [
          tenant.id,
          entry,
          await account("1102"),
          await account("1103"),
          amountIdr,
        ],
      );
    }, true);
  }

  // ---- Reading the ledger -------------------------------------------------

  type LineByCode = Record<string, { debit: number; credit: number }>;
  /** Lines of the journal entry with this idempotency key, summed by GL code; undefined when no such entry. */
  async function journalByKey(key: string) {
    const entries = await rowsOf(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
      [tenant.id, entityId, key],
    );
    if (entries.length === 0) return undefined;
    expect(entries, `exactly one journal entry for key ${key}`).toHaveLength(1);
    const lines = await rowsOf(
      `SELECT a.code, l.debit_idr::text AS debit, l.credit_idr::text AS credit
         FROM journal_lines l
         JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE l.tenant_id = $1 AND l.entry_id = $2
        ORDER BY l.line_no`,
      [tenant.id, entries[0]!.id],
    );
    const byCode: LineByCode = {};
    for (const line of lines) {
      const row = (byCode[line.code as string] ??= { debit: 0, credit: 0 });
      row.debit += Number(line.debit);
      row.credit += Number(line.credit);
    }
    return byCode;
  }
  const countJournals = async (keyLike: string) =>
    Number(
      (
        await rowsOf(
          `SELECT count(*)::int AS n FROM journal_entries
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE $3`,
          [tenant.id, entityId, keyLike],
        )
      )[0]!.n,
    );

  // ---- Payout rows ----------------------------------------------------------

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
        `SELECT * FROM payroll_disbursement_items WHERE batch_id = $1 AND employee_id = $2`,
        [batchId, p.id],
      )
    )[0]!;
  const runRow = async (runId: string) =>
    (
      await rowsOf(
        "SELECT status, paid_by, paid_at FROM payroll_runs WHERE id = $1",
        [runId],
      )
    )[0]!;
  /** Postings (one per grouped journal) of a batch, oldest first. */
  const postingsOf = (batchId: string) =>
    rowsOf(
      `SELECT * FROM payroll_payout_gl_postings
        WHERE tenant_id = $1 AND batch_id = $2 ORDER BY posted_at, id`,
      [tenant.id, batchId],
    );
  /** The run's `payroll.paid` events in the outbox. */
  const paidEventsOf = (runId: string) =>
    rowsOf(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'payroll.paid'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenant.id, runId],
    );

  // ---- Service flow ---------------------------------------------------------

  async function createBatch(runId: string, channel = "manual_bank") {
    const batch = await inTx((tx) =>
      createDisbursementBatch(tx, actorOf(REQ), {
        payrollRunId: runId,
        channel,
      } as never),
    );
    // Creation timestamps can sort an older attempt after this one. Continue
    // with the exact batch the committed creation returned, not a latest row.
    return batch.id;
  }
  async function approvedBatch(runId: string, channel = "manual_bank") {
    const id = await createBatch(runId, channel);
    await inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), id));
    const hash = (await batchById(id)).content_hash as string;
    // The account the approver saw (legend-3j9yz): the source configured NOW
    // for manual_bank (tests may switch it mid-flow), null otherwise.
    const sourceBankAccountId =
      channel === "manual_bank"
        ? (((
            await rowsOf(
              `SELECT manual_source_bank_account_id AS id
                 FROM payroll_payout_configs
                WHERE tenant_id = $1 AND legal_entity_id = $2`,
              [tenant.id, entityId],
            )
          )[0]?.id as string | null | undefined) ?? null)
        : null;
    await inTx((tx) =>
      approveDisbursementBatch(tx, actorOf(APP), id, {
        contentHash: hash,
        sourceBankAccountId,
      } as never),
    );
    return id;
  }
  /** Approved and downloaded: items are `exported`, waiting for the bank result. */
  async function exportedBatch(runId: string) {
    const id = await approvedBatch(runId);
    await inTx((tx) => exportManualBatch(tx, actorOf(APP), id));
    return id;
  }
  const succeedItems = (batchId: string, items: Row[]) =>
    items.map((item, index) => ({
      itemId: item.id as string,
      result: "succeeded" as const,
      bankRef: `BCA-${batchId.slice(0, 8)}-${index}`,
      evidenceKey: uploadEvidence(batchId),
    }));
  const confirm = (
    batchId: string,
    results: {
      itemId: string;
      result: "succeeded";
      bankRef?: string;
      evidenceKey?: string;
    }[],
    by = APP2,
    store: PayoutEvidenceStore = proofs(),
  ) =>
    inTx((tx) =>
      confirmManualItems(tx, actorOf(by), batchId, { results } as never, store),
    );
  const resolve = (
    batchId: string,
    itemIds: string[],
    outcome: "failed" | "not_sent",
    by: string,
    evidenceKey = uploadEvidence(batchId),
    store: PayoutEvidenceStore = proofs(),
  ) =>
    inTx((tx) =>
      resolveManualItems(
        tx,
        actorOf(by),
        batchId,
        {
          itemIds,
          outcome,
          evidenceKey,
          note: "Bank menolak transfer, tidak ada dana keluar",
        } as never,
        store,
      ),
    );
  const handover = (
    batchId: string,
    itemIds: string[],
    by = APP2,
    evidenceKey?: string,
  ) =>
    inTx((tx) =>
      confirmCashHandover(tx, actorOf(by), batchId, {
        itemIds,
        evidenceKey,
      } as never),
    );

  // ---- Setup / teardown -----------------------------------------------------

  beforeAll(async () => {
    setAuditWriter(coreAuditWriter);
    for (const id of [REQ, APP, APP2, APP3])
      await provisionActor(id, { user: true, permit: true });
    // The step-up must stay fresh (15 minutes) for the whole file.
    mfaRefresh = setInterval(() => {
      owner
        .query(
          `UPDATE session SET mfa_verified_at = now() WHERE id = ANY($1)`,
          [actorSessions],
        )
        .catch(() => {});
    }, 60_000);
    mfaRefresh.unref();
    const hrUser = await signedInClient(`Payout ${label} HR`);
    await grantRole(hrUser.userId, ["hr.employee.manage", "hr.employee.view"]);
    hr = hrUser.client;

    await asTenant(async (c) => {
      await c.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
        [entityId, tenant.id, `PT Payout ${label} ${entityId.slice(0, 6)}`],
      );
      const code = `PC${policyId.slice(0, 8)}`;
      await c.query(
        `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                       employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
         VALUES ($1, $2, $3, 'Kebijakan Payout GL', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
        [policyId, tenant.id, entityId, code, JSON.stringify({ code })],
      );
    });
    await withTenant(db, scope(), (tx) =>
      provisionStandardChart(tx, scope(), entityId, null),
    );
    // Fiscal periods around the journals: the locked entry (2026-10), the
    // legacy paid event (2026-11) and the real clock of the settle.
    const now = new Date(Date.now() + 7 * 3_600_000);
    const periods = new Set(["2026-09", "2026-10", "2026-11"]);
    for (const shift of [-1, 0, 1]) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + shift, 1),
      );
      periods.add(d.toISOString().slice(0, 7));
    }
    await asTenant(async (c) => {
      for (const period of periods)
        await c.query(
          `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
           VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
          [tenant.id, entityId, period],
        );
      const gl = (
        await c.query(
          `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1103'`,
          [tenant.id, entityId],
        )
      ).rows[0].id as string;
      bankAccountId = (
        await c.query(
          `INSERT INTO bank_accounts
             (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
              account_number_hmac, account_number_last4, account_number_key_version,
              gl_account_id, created_by)
           VALUES ($1, $2, 'BCA', 'Rekening Gaji', '\\x00', $3, '0000', 1, $4, 'payout-gl-test')
           RETURNING id`,
          [tenant.id, entityId, "c".repeat(64), gl],
        )
      ).rows[0].id as string;
      // The "bank charges" role: part of the standard chart once migration
      // 0534 lands. Mapped here only when the provisioning has not done it
      // (and ignored when the role key does not exist yet: the tests then
      // fail on the missing behavior, not on this setup).
    });
    try {
      await asTenant(async (c) => {
        await c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           SELECT $1, $2, 'bank_charges', id FROM chart_of_accounts
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '8101'
           ON CONFLICT DO NOTHING`,
          [tenant.id, entityId],
        );
      });
    } catch {
      // role key not allowed before migration 0348
    }

    await asTenant(async (c) => {
      for (const p of ALL_PEOPLE) {
        createdEmployees.push(p.id);
        await c.query(
          `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                                  legal_entity_id, employment_type, join_date, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active')`,
          [
            p.id,
            tenant.id,
            `PG-${p.id.slice(0, 8).toUpperCase()}`,
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
          idempotencyKey: `payout-gl-${randomUUID()}`,
        });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
    }
    await asTenant(async (c) => {
      for (const p of ALL_PEOPLE)
        await c.query(`UPDATE employees SET bank_code = $2 WHERE id = $1`, [
          p.id,
          p.bankCode,
        ]);
      await c.query(
        `INSERT INTO payroll_payout_configs
           (tenant_id, legal_entity_id, method, manual_source_bank_account_id,
            manual_bank_format, enabled, updated_by)
         VALUES ($1, $2, 'manual_bank', $3, 'generic_csv', true, 'payout-gl-test')`,
        [tenant.id, entityId, bankAccountId],
      );
    }, true);
  });

  afterAll(async () => {
    setAuditWriter(null);
    if (mfaRefresh) clearInterval(mfaRefresh);
    await asTenant(async (c) => {
      const del = (sql: string, params: unknown[]) => c.query(sql, params);
      const runs = [tenant.id, createdRuns];
      await del(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'payout-gl-%'",
        [tenant.id],
      );
      await del(
        "DELETE FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND batch_id IN (SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = ANY($2))",
        runs,
      );
      // 905: the operation rows of this file's batches (corrections, overpaid
      // proposals, return claims, bindings, attestations, recon flags, ...) go
      // with their items. The fixture tenant is shared by every payout file, and
      // the night recon reads the whole tenant: an operation left over an item
      // deleted here fails it (PAYOUT-68).
      const batchesOfRuns =
        "SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = ANY($2)";
      await del(
        `DELETE FROM payroll_payout_proof_hashes WHERE binding_id IN (
           SELECT id FROM payroll_payout_proof_bindings
            WHERE tenant_id = $1 AND batch_id IN (${batchesOfRuns}))`,
        runs,
      );
      const opTables = (
        await c.query(
          `SELECT a.table_name FROM information_schema.columns a
             JOIN information_schema.columns b
               ON b.table_schema = a.table_schema AND b.table_name = a.table_name AND b.column_name = 'tenant_id'
             JOIN information_schema.tables t
               ON t.table_schema = a.table_schema AND t.table_name = a.table_name AND t.table_type = 'BASE TABLE'
            WHERE a.table_schema = 'public' AND a.column_name = 'batch_id'
              AND a.table_name LIKE 'payroll\\_payout\\_%'`,
        )
      ).rows as { table_name: string }[];
      for (const { table_name } of opTables)
        await del(
          `DELETE FROM "${table_name}" WHERE tenant_id = $1 AND batch_id IN (${batchesOfRuns})`,
          runs,
        );
      await del(
        "DELETE FROM payroll_disbursement_items WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        runs,
      );
      await del(
        "DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        runs,
      );
      await del(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND event::text LIKE ANY (SELECT '%' || r || '%' FROM unnest($2::text[]) r)",
        runs,
      );
      await del(
        "DELETE FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenant.id, entityId],
      );
      await del(
        "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        runs,
      );
      await del(
        "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        runs,
      );
      await del(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
        runs,
      );
      await del(
        "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN (SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2)",
        [tenant.id, entityId],
      );
      // Every other table that carries this entity (journal entries, chart,
      // mappings, fiscal periods, bank account, ...). Triggers and FKs are off.
      const tables = (
        await c.query(
          `SELECT a.table_name FROM information_schema.columns a
             JOIN information_schema.columns b
               ON b.table_schema = a.table_schema AND b.table_name = a.table_name AND b.column_name = 'tenant_id'
            WHERE a.table_schema = 'public' AND a.column_name = 'legal_entity_id'
              AND a.table_name <> 'legal_entities'`,
        )
      ).rows as { table_name: string }[];
      for (const { table_name } of tables)
        await del(
          `DELETE FROM "${table_name}" WHERE tenant_id = $1 AND legal_entity_id = $2`,
          [tenant.id, entityId],
        );
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
    await owner.query("DELETE FROM session WHERE id = ANY($1)", [
      actorSessions,
    ]);
    await owner.query(`DELETE FROM "user" WHERE id = ANY($1)`, [actorUsers]);
    await owner.end();
  });

  /**
   * 905: step one of an overpaid record (the proposal) by `proposer`, through
   * the same service the route uses. `app.payout_overpaid_record` (the second
   * step, `recordOverpaidItem`) now refuses an item with no proposal of another
   * person, so a test that calls the second step directly proposes first. The
   * proposer is the first of APP2 / APP3 / APP that is not `recorder`.
   */
  async function proposeOverpaid(
    batchId: string,
    itemId: string,
    evidenceKey: string,
    note: string,
    recorder: string,
  ) {
    const proposer = [APP2, APP3, APP].find((id) => id !== recorder)!;
    // A test may call its wrapper again after a refused second step (for
    // example: refused while accounting is off, then accepted). The open
    // proposal of the same person and proof is step one already; proposing
    // again is a same-person replay (PAYOUT_OVERPAID_SAME_PERSON).
    const open = await rowsOf(
      `SELECT 1 FROM payroll_payout_overpaid_proposals
        WHERE tenant_id = $1 AND item_id = $2 AND proposed_by = $3
          AND evidence_key = $4 AND status = 'proposed'`,
      [tenant.id, itemId, proposer, evidenceKey],
    );
    if (open.length > 0) return;
    return inTx((tx) =>
      recordOverpaidItems(
        tx,
        actorOf(proposer),
        batchId,
        { itemIds: [itemId], evidenceKey, note },
        proofs(),
      ),
    );
  }

  /**
   * 905: a pre-claim historical return. The trusted binder (app.payout_backfill_bind)
   * recomputes the item set hash from real items, so a legacy claim needs a real
   * item behind its key. Clones `itemId` as a `returned` item (replica: triggers
   * off, the clone is history, not a new payment) with `return_evidence_key = key`
   * and returns the hash of that one-item set (what the claim must carry).
   */
  async function legacyReturnItem(itemId: string, key: string) {
    return asTenant(async (c) => {
      await c.query(
        `CREATE TEMP TABLE legacy_clone ON COMMIT DROP AS
           SELECT * FROM payroll_disbursement_items WHERE id = $1`,
        [itemId],
      );
      await c.query(
        `UPDATE legacy_clone SET id = gen_random_uuid(),
                attempt_no = 1000 + floor(random() * 1000000)::int,
                status = 'returned', return_evidence_key = $1,
                returned_by = COALESCE(returned_by, 'legacy-905'),
                return_note = COALESCE(return_note, 'legacy 905'),
                returned_by_2 = COALESCE(returned_by_2, 'legacy-905-b'),
                returned_at = COALESCE(returned_at, now())`,
        [key],
      );
      await c.query(
        `UPDATE legacy_clone SET idempotency_key = 'payslip:' || payslip_id::text || ':attempt:' || attempt_no::text`,
      );
      const id = (await c.query(`SELECT id::text AS id FROM legacy_clone`))
        .rows[0].id as string;
      await c.query(
        `INSERT INTO payroll_disbursement_items SELECT * FROM legacy_clone`,
      );
      return (
        await c.query(
          `SELECT encode(sha256(convert_to($1::text, 'UTF8')), 'hex') AS h`,
          [id],
        )
      ).rows[0].h as string;
    }, true);
  }

  return {
    app,
    owner,
    tenantId: tenant.id as string,
    proposeOverpaid,
    legacyReturnItem,
    entityId: () => entityId,
    scope,
    inTx,
    proofs,
    asTenant,
    asPayoutRole,
    rowsOf,
    expectRefused,
    httpFailure,
    signedInClient,
    provisionActor,
    grantRole,
    seedRun,
    postLockedJournal,
    fundPettyCash,
    deliverGl,
    paidEnvelope,
    journalByKey,
    countJournals,
    batchById,
    itemsOf,
    itemOfPerson,
    runRow,
    postingsOf,
    paidEventsOf,
    createBatch,
    approvedBatch,
    exportedBatch,
    succeedItems,
    confirm,
    resolve,
    handover,
  };
}
