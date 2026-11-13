// Employee bank code (bead legend-86he4, brief docs/briefs/650-bankcode-shared.md).
// HR sets the 3-digit BI bank code of an employee next to the bank account
// (PUT .../pii and createEmployee `pii`). The code is not a secret: it is
// returned as-is in the PII response and may appear in the audit entry, but
// the account number never does. A manual-bank payout batch item stops being
// `bank_code_missing` once the code is filled before the run is locked (the
// lock-time snapshot copies employees.bank_code).
//
// Assumptions (the brief is silent, stated so the engineer can contest them):
// - The input and response field is `bankCode` (string | null); `null` clears
//   the code, an omitted field leaves it unchanged. The EmployeePii response
//   carries `bankCode` as a plain string (not `{ masked, keyVersion }`).
// - Valid codes come from a fixed list; '014' (BCA) is in it. '01' (too
//   short), 'abcd' (letters, too long) and '999x' (not 3 digits) are not.
// - The audit entry `hris.employee_pii.updated` lists `bankCode` in
//   `maskedChanges.after.changedFields`, like `bankAccount`.
// - Permission follows the bankAccount field: hr.employee.manage; a payroll
//   viewer is refused 403 and nothing changes.
// - Another tenant's HR gets 404 (row invisible under RLS) and nothing
//   changes.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  updateEmployeePiiInputSchema,
  type UpdateEmployeePiiInput,
} from "@starter/shared/hris";
import { payrollConfigSnapshotSchema } from "@starter/shared/hris/payroll";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createEmployee,
  getEmployeePii,
  updateEmployeePii,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import type { Tx } from "../services/hris-access.ts";
import { snapshotPayeeBankForLock } from "../services/payroll-bank-snapshot.service.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdRuns: string[] = [];

const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const inTx = <T>(run: (tx: Tx) => Promise<T>) =>
  withTenant(db, tenantScope(), run);

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  raw = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (raw) await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

/** A user holding a custom tenant-wide role with exactly `permissions`. */
async function actor(
  permissions: string[],
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Bank code test', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Bank code ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify(["tenant"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant, userId, roleId],
    );
  });
  return userId;
}

let counter = 0;
const digits = (length: number) => {
  let tail = "";
  while (tail.length < length) tail += Math.floor(Math.random() * 1e9);
  return `${String(++counter).padStart(3, "0")}${tail}`.slice(0, length);
};
const employeeNo = () =>
  `BK-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const codeOf = (error: unknown) => (error as { code?: string }).code;
const statusOf = (error: unknown) => (error as { status?: number }).status;
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: codeOf(error), status: statusOf(error), error };
  }
  throw new Error("Expected the call to fail");
}

// `bankCode` is the new field under test: the casts keep this file compiling
// before and after the contract change.
const piiBody = (fields: Record<string, unknown>) =>
  ({
    ...fields,
    idempotencyKey: `bankcode-${randomUUID()}`,
  }) as unknown as Parameters<typeof updateEmployeePii>[3];
const piiFields = (fields: Record<string, unknown>) =>
  fields as unknown as UpdateEmployeePiiInput;

let hr: string;
let payroll: string;
let hrOther: string;
const entityId = randomUUID();
const policyId = randomUUID();
let bankAccountId = "";

async function newEmployee(
  pii: Record<string, unknown> = {},
  legalEntityId: string | null = entityId,
) {
  const created = await createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId,
    employeeNo: employeeNo(),
    fullName: "Karyawan Kode Bank",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwtt",
    joinDate: "2026-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
    pii: piiFields({ nik: digits(16), ...pii }),
  } as CreateEmployeeInput);
  createdEmployees.push(created.id);
  return created;
}

const storedBankCode = async (employeeId: string) =>
  (
    await asOwner(tenantId, (c) =>
      c.query<{ bank_code: string | null }>(
        "SELECT bank_code FROM employees WHERE id = $1",
        [employeeId],
      ),
    )
  ).rows[0]?.bank_code;

async function auditRows(employeeId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query<{ event: Record<string, unknown>; raw: string }>(
      `SELECT event, event::text AS raw FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
        ORDER BY event->>'createdAt', id`,
      [tenantId, employeeId],
    ),
  );
  return rows;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Bank code other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `bankcode-${otherTenant.slice(0, 8)}`, tenantId],
  );
  hr = await actor(["hr.employee.manage", "hr.employee.view"]);
  payroll = await actor(["payroll.view"]);
  hrOther = await actor(
    ["hr.employee.manage", "hr.employee.view"],
    otherTenant,
  );

  // PT, policy, payroll bank account and manual payout config for the batch tests.
  await asOwner(
    tenantId,
    async (c) => {
      await c.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Kode Bank', false)`,
        [entityId, tenantId],
      );
      const code = `PB${policyId.slice(0, 8)}`;
      await c.query(
        `INSERT INTO payroll_policies (id, tenant_id, legal_entity_id, name, employee_group_code,
                                       employee_group, cycle, pay_date_adjustment, jkk_risk_class, bpjs_programmes)
         VALUES ($1, $2, $3, 'Kebijakan Kode Bank', $4, $5, '{"kind":"monthly"}', 'none', 'low', '[]')`,
        [policyId, tenantId, entityId, code, JSON.stringify({ code })],
      );
      const gl = (
        await c.query(
          `INSERT INTO chart_of_accounts
             (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
           VALUES ($1, $2, '1103', 'Bank', 'asset', 'cash_and_equivalents', NULL, true)
           RETURNING id`,
          [tenantId, entityId],
        )
      ).rows[0].id as string;
      bankAccountId = (
        await c.query(
          `INSERT INTO bank_accounts
             (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
              account_number_hmac, account_number_last4, account_number_key_version,
              gl_account_id, created_by)
           VALUES ($1, $2, 'BCA', 'Rekening Gaji', '\\x00', $3, '0000', 1, $4, 'bankcode-test')
           RETURNING id`,
          [tenantId, entityId, "c".repeat(64), gl],
        )
      ).rows[0].id as string;
      await c.query(
        `INSERT INTO payroll_payout_configs
           (tenant_id, legal_entity_id, method, manual_source_bank_account_id,
            manual_bank_format, enabled, updated_by)
         VALUES ($1, $2, 'manual_bank', $3, 'generic_csv', true, 'bankcode-test')`,
        [tenantId, entityId, bankAccountId],
      );
    },
    true,
  );
});

afterAll(async () => {
  await asOwner(
    tenantId,
    async (c) => {
      const del = (sql: string, params: unknown[]) => c.query(sql, params);
      await del(
        "DELETE FROM payroll_disbursement_items WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenantId, createdRuns],
      );
      await del(
        "DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenantId, createdRuns],
      );
      await del(
        "DELETE FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entityId],
      );
      await del(
        "DELETE FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entityId],
      );
      await del(
        "DELETE FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2",
        [tenantId, entityId],
      );
      await del(
        "DELETE FROM payslip_bank_snapshots WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenantId, createdRuns],
      );
      await del(
        "DELETE FROM payslips WHERE tenant_id = $1 AND payroll_run_id = ANY($2)",
        [tenantId, createdRuns],
      );
      await del(
        "DELETE FROM payroll_runs WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdRuns],
      );
      await del("DELETE FROM payroll_policies WHERE id = $1", [policyId]);
      await del(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'bankcode-%'",
        [tenantId],
      );
      await del("DELETE FROM employees WHERE id = ANY($1)", [createdEmployees]);
      await del("DELETE FROM legal_entities WHERE id = $1", [entityId]);
    },
    true,
  );
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (c) => {
      await c.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await c.query("DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)", [
        tenant,
        createdRoles,
      ]);
    });
  // Audit rows are append-only; keep the fixture tenant when one references it.
  const referenced = await owner.query(
    "SELECT 1 FROM audit_logs WHERE tenant_id = $1 LIMIT 1",
    [otherTenant],
  );
  if ((referenced.rowCount ?? 0) === 0)
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ---------------------------------------------------------------- validator

describe("employee-bank-code validator", () => {
  it("[employee-bank-code] a 3-digit code from the bank list is accepted; null clears it", () => {
    expect(
      updateEmployeePiiInputSchema.safeParse({ bankCode: "014" }).success,
    ).toBe(true);
    expect(
      updateEmployeePiiInputSchema.safeParse({ bankCode: null }).success,
    ).toBe(true);
  });

  it.each(["01", "abcd", "999x"])(
    "[employee-bank-code] the invalid code '%s' is rejected on the bankCode field",
    (bankCode) => {
      // The valid case first: a rejection of the field name itself
      // (unrecognized key) must not pass as "invalid code".
      expect(
        updateEmployeePiiInputSchema.safeParse({ bankCode: "014" }).success,
      ).toBe(true);
      const result = updateEmployeePiiInputSchema.safeParse({ bankCode });
      expect(result.success).toBe(false);
      if (result.success) return;
      const issues = result.error.issues;
      expect(issues.some((i) => i.code === "unrecognized_keys")).toBe(false);
      expect(issues.some((i) => i.path[0] === "bankCode")).toBe(true);
    },
  );
});

// ------------------------------------------------------------------ service

describe("employee-bank-code HR fills, changes and clears the code", () => {
  it("[employee-bank-code] updateEmployeePii sets the code; the PII response and the table show it, the account stays masked", async () => {
    const e = await newEmployee({ bankAccount: "1234567890" });
    expect(await storedBankCode(e.id)).toBeNull();
    const result = await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankCode: "014" }),
    );
    expect((result as unknown as { bankCode: string }).bankCode).toBe("014");
    expect(result.bankAccount?.masked).toBe("****7890");
    expect(await storedBankCode(e.id)).toBe("014");
    const read = await getEmployeePii(tenantScope(), hr, e.id);
    expect((read as unknown as { bankCode: string }).bankCode).toBe("014");
  });

  it("[employee-bank-code] updateEmployeePii changes the code, and an update touching neither bank field leaves it alone", async () => {
    const e = await newEmployee({ bankCode: "014" });
    expect(await storedBankCode(e.id)).toBe("014");
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankCode: "008" }),
    );
    expect(await storedBankCode(e.id)).toBe("008");
    // Assumption: an update that carries neither bankAccount nor bankCode
    // (here: npwp) leaves the stored code alone. Only a NEW bankAccount
    // without bankCode resets it (next test).
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ npwp: digits(16) }),
    );
    expect(await storedBankCode(e.id)).toBe("008");
  });

  // Rule (orchestrator brief): the code belongs to the account it was entered
  // for. A new bankAccount without bankCode must not keep the old bank's code,
  // otherwise money would be routed to the wrong bank. The code is reset to
  // null and HR must fill it again.
  it("[employee-bank-code] a new bankAccount without bankCode resets the stored code to null", async () => {
    const e = await newEmployee({
      bankAccount: "1112223334",
      bankCode: "014",
    });
    expect(await storedBankCode(e.id)).toBe("014");
    const result = await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankAccount: "5550001112223" }),
    );
    expect(await storedBankCode(e.id)).toBeNull();
    expect(result.bankAccount?.masked).toBe("****2223");
    expect((result as unknown as { bankCode: null }).bankCode).toBeNull();
    const read = await getEmployeePii(tenantScope(), hr, e.id);
    expect((read as unknown as { bankCode: null }).bankCode).toBeNull();
  });

  it("[employee-bank-code] a new bankAccount together with bankCode stores the new code", async () => {
    const e = await newEmployee({
      bankAccount: "1112223334",
      bankCode: "014",
    });
    const result = await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankAccount: "5550001112223", bankCode: "008" }),
    );
    expect(await storedBankCode(e.id)).toBe("008");
    expect(result.bankAccount?.masked).toBe("****2223");
    expect((result as unknown as { bankCode: string }).bankCode).toBe("008");
    const read = await getEmployeePii(tenantScope(), hr, e.id);
    expect((read as unknown as { bankCode: string }).bankCode).toBe("008");
  });

  it("[employee-bank-code] updateEmployeePii with bankCode null clears the code", async () => {
    const e = await newEmployee({ bankCode: "014" });
    const result = await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankCode: null }),
    );
    expect(await storedBankCode(e.id)).toBeNull();
    expect((result as unknown as { bankCode: null }).bankCode).toBeNull();
  });

  it("[employee-bank-code] createEmployee with pii.bankCode stores it", async () => {
    const e = await newEmployee({
      bankAccount: "9876543210",
      bankCode: "002",
    });
    expect(await storedBankCode(e.id)).toBe("002");
    const read = await getEmployeePii(tenantScope(), hr, e.id);
    expect((read as unknown as { bankCode: string }).bankCode).toBe("002");
  });

  it("[employee-bank-code] createEmployee without bankCode leaves it empty (null)", async () => {
    const e = await newEmployee({ bankAccount: "9876543210" });
    expect(await storedBankCode(e.id)).toBeNull();
    const read = await getEmployeePii(tenantScope(), hr, e.id);
    expect((read as unknown as { bankCode: null }).bankCode).toBeNull();
  });
});

describe("employee-bank-code invalid codes and refusals", () => {
  it.each(["01", "abcd", "999x"])(
    "[employee-bank-code] updateEmployeePii refuses '%s' and the stored code does not change",
    async (bankCode) => {
      const e = await newEmployee({ bankCode: "014" });
      const refused = await failure(
        updateEmployeePii(tenantScope(), hr, e.id, piiBody({ bankCode })),
      );
      const issues =
        (refused.error as { issues?: { code: string; path: unknown[] }[] })
          .issues ?? [];
      expect(issues.some((i) => i.code === "unrecognized_keys")).toBe(false);
      expect(issues.some((i) => i.path[0] === "bankCode")).toBe(true);
      expect(await storedBankCode(e.id)).toBe("014");
    },
  );

  it("[employee-bank-code] createEmployee refuses an invalid code and creates no employee", async () => {
    const no = employeeNo();
    const refused = await failure(
      createEmployee(tenantScope(), hr, {
        userId: null,
        legalEntityId: entityId,
        employeeNo: no,
        fullName: "Gagal Kode Bank",
        positionId: null,
        orgUnitId: null,
        managerId: null,
        homeOutletId: outletA,
        employmentType: "pkwtt",
        joinDate: "2026-01-05",
        endDate: null,
        ptkpStatus: "TK/0",
        status: "active",
        pii: piiFields({ nik: digits(16), bankCode: "999x" }),
      } as CreateEmployeeInput),
    );
    const issues =
      (refused.error as { issues?: { code: string; path: unknown[] }[] })
        .issues ?? [];
    expect(issues.some((i) => i.code === "unrecognized_keys")).toBe(false);
    expect(issues.some((i) => i.path[0] === "bankCode")).toBe(true);
    const rows = await asOwner(tenantId, (c) =>
      c.query("SELECT 1 FROM employees WHERE employee_no = $1", [no]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("[employee-bank-code] another tenant's HR cannot set or clear the code (404) and the data stays", async () => {
    const e = await newEmployee({ bankCode: "014" });
    for (const bankCode of ["008", null])
      expect(
        (
          await failure(
            updateEmployeePii(
              tenantScope(otherTenant),
              hrOther,
              e.id,
              piiBody({ bankCode }),
            ),
          )
        ).status,
      ).toBe(404);
    expect(await storedBankCode(e.id)).toBe("014");
  });

  it("[employee-bank-code] a payroll viewer without hr.employee.manage is refused (403) and the code stays", async () => {
    const e = await newEmployee({ bankCode: "014" });
    expect(
      (
        await failure(
          updateEmployeePii(
            tenantScope(),
            payroll,
            e.id,
            piiBody({ bankCode: "008" }),
          ),
        )
      ).status,
    ).toBe(403);
    expect(await storedBankCode(e.id)).toBe("014");
  });
});

describe("employee-bank-code audit", () => {
  it("[employee-bank-code] the audit entry lists bankCode and never carries the account number", async () => {
    const account = "7771234567890";
    const e = await newEmployee({ bankAccount: account });
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankCode: "014", bankAccount: "7770000011112" }),
    );
    const updated = (await auditRows(e.id)).filter(
      (row) => row.event.action === "hris.employee_pii.updated",
    );
    expect(updated).toHaveLength(1);
    const changed = (
      updated[0].event.maskedChanges as {
        after: { changedFields: string[] };
      }
    ).after.changedFields;
    expect(changed).toContain("bankCode");
    expect(changed).toContain("bankAccount");
    for (const row of await auditRows(e.id)) {
      expect(row.raw).not.toContain(account);
      expect(row.raw).not.toContain("7770000011112");
    }
  });

  it("[employee-bank-code] a new bankAccount without bankCode lists bankCode in changedFields (the reset is audited)", async () => {
    const e = await newEmployee({
      bankAccount: "6661234567890",
      bankCode: "014",
    });
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankAccount: "6660000011112" }),
    );
    const updated = (await auditRows(e.id)).filter(
      (row) => row.event.action === "hris.employee_pii.updated",
    );
    expect(updated).toHaveLength(1);
    const changed = (
      updated[0].event.maskedChanges as {
        after: { changedFields: string[] };
      }
    ).after.changedFields;
    expect(changed).toContain("bankAccount");
    expect(changed).toContain("bankCode");
    for (const row of await auditRows(e.id))
      expect(row.raw).not.toContain("6660000011112");
  });

  it("[employee-bank-code] creating an employee with bankCode writes no account number to the audit log", async () => {
    const account = "8881234567890";
    const e = await newEmployee({ bankAccount: account, bankCode: "014" });
    for (const row of await auditRows(e.id))
      expect(row.raw).not.toContain(account);
  });
});

// ---------------------------------------------------------- payout batch item

const STEPS = [
  `status = 'simulated', simulation_count = 1, last_simulated_at = now()`,
  `status = 'hr_approved', approved_by_hr = '00000000-0000-4000-8000-0000000000a1', approved_by_hr_at = now()`,
  `status = 'approved', approved_by_finance = '00000000-0000-4000-8000-0000000000a2', approved_by_finance_at = now()`,
];
const day = (n: number) =>
  new Date(Date.UTC(2043, 0, 1 + n)).toISOString().slice(0, 10);

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

/** A locked run with one bank slip for `employee`; snapshots copy the code at lock. */
async function seedLockedRun(employee: { id: string }, net = 2_000_000) {
  const runId = randomUUID();
  createdRuns.push(runId);
  const start = ++counter * 3;
  const days = [day(start), day(start + 1)];
  const payslipId = randomUUID();
  const totals = {
    employeeCount: 1,
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
  const calculation = {
    employeeId: employee.id,
    employeeNo: `BK-${employee.id.slice(0, 8).toUpperCase()}`,
    employeeName: "Karyawan Kode Bank",
    positionName: null,
    outletId: outletA,
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
    paymentMethod: "bank_transfer",
  };
  await asOwner(tenantId, async (c) => {
    await c.query(
      `INSERT INTO payroll_runs (id, tenant_id, legal_entity_id, payroll_policy_id, run_type,
                                 period_start, period_end, pay_date, created_by)
       VALUES ($1, $2, $3, $4, 'regular', $5, $6, $6, '00000000-0000-4000-8000-0000000000a4')`,
      [runId, tenantId, entityId, policyId, days[0], days[1]],
    );
    for (const step of STEPS)
      await c.query(`UPDATE payroll_runs SET ${step} WHERE id = $1`, [runId]);
    await c.query(
      `UPDATE payroll_runs SET status = 'locked', config_snapshot = $3::jsonb,
              totals = $2::jsonb, locked_by = '00000000-0000-4000-8000-0000000000a3', locked_at = now()
        WHERE id = $1`,
      [runId, JSON.stringify(totals), JSON.stringify(runSnapshot())],
    );
    await c.query(
      `INSERT INTO payslips (id, tenant_id, payroll_run_id, employee_id, payment_method,
                             calculation_encrypted, pii_key_version)
       VALUES ($1, $2, $3, $4, 'bank_transfer', $5, $6)`,
      [
        payslipId,
        tenantId,
        runId,
        employee.id,
        sealPayrollValue(JSON.stringify(calculation), {
          tenantId,
          table: "payslips",
          rowId: payslipId,
          field: "calculation",
        }),
        PAYROLL_SEAL_KEY_VERSION,
      ],
    );
  });
  await inTx((tx) =>
    snapshotPayeeBankForLock(tx, tenantId, runId, [
      { payslipId, employeeId: employee.id },
    ]),
  );
  return runId;
}

/** Creates a manual_bank batch for the run and returns the employee's item. */
async function itemAfterBatch(runId: string, employee: { id: string }) {
  await inTx((tx) =>
    createDisbursementBatch(
      tx,
      { tenantId, userId: `bankcode-req-${randomUUID()}` },
      { payrollRunId: runId, channel: "manual_bank" } as never,
    ),
  );
  const { rows } = await asOwner(tenantId, (c) =>
    c.query<{
      status: string;
      excluded_reason: string | null;
      bank_code: string | null;
    }>(
      `SELECT i.status, i.excluded_reason, i.bank_code
         FROM payroll_disbursement_items i
        WHERE i.payroll_run_id = $1 AND i.employee_id = $2`,
      [runId, employee.id],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("employee-bank-code manual payout item", () => {
  it("[employee-bank-code] an item is bank_code_missing without the code, and prepared with the code HR filled in", async () => {
    const e = await newEmployee({ bankAccount: digits(12) });

    const before = await itemAfterBatch(await seedLockedRun(e), e);
    expect(before.status).toBe("blocked");
    expect(before.excluded_reason).toBe("bank_code_missing");

    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankCode: "014" }),
    );

    const after = await itemAfterBatch(await seedLockedRun(e), e);
    expect(after.excluded_reason).toBeNull();
    expect(after.status).toBe("prepared");
    expect(after.bank_code).toBe("014");
  });

  it("[employee-bank-code] an employee created with the code gets a prepared item right away", async () => {
    const e = await newEmployee({ bankAccount: digits(12), bankCode: "008" });
    const item = await itemAfterBatch(await seedLockedRun(e), e);
    expect(item.excluded_reason).toBeNull();
    expect(item.status).toBe("prepared");
    expect(item.bank_code).toBe("008");
  });

  it("[employee-bank-code] a new bankAccount without bankCode makes the next batch item bank_code_missing", async () => {
    const e = await newEmployee({ bankAccount: digits(12), bankCode: "014" });
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankAccount: digits(12) }),
    );
    expect(await storedBankCode(e.id)).toBeNull();
    const item = await itemAfterBatch(await seedLockedRun(e), e);
    expect(item.status).toBe("blocked");
    expect(item.excluded_reason).toBe("bank_code_missing");
  });

  it("[employee-bank-code] a new bankAccount together with bankCode gives a prepared item with the new code", async () => {
    const e = await newEmployee({ bankAccount: digits(12), bankCode: "014" });
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankAccount: digits(12), bankCode: "008" }),
    );
    const item = await itemAfterBatch(await seedLockedRun(e), e);
    expect(item.excluded_reason).toBeNull();
    expect(item.status).toBe("prepared");
    expect(item.bank_code).toBe("008");
  });

  it("[employee-bank-code] clearing the code makes the next batch item bank_code_missing again", async () => {
    const e = await newEmployee({ bankAccount: digits(12), bankCode: "014" });
    await updateEmployeePii(
      tenantScope(),
      hr,
      e.id,
      piiBody({ bankCode: null }),
    );
    const item = await itemAfterBatch(await seedLockedRun(e), e);
    expect(item.status).toBe("blocked");
    expect(item.excluded_reason).toBe("bank_code_missing");
  });
});
