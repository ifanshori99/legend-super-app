// HRIS master data against PostgreSQL with the restricted app role (RLS
// enforced): PRD v1.7 §3 F26, §6 H, §2 enkripsi aplikasi; HR-01 (own data
// only), HR-03 (encrypted PII, HR/payroll only), HR-04 (employee quota under
// concurrency); TEN-01/02/03 isolation; bead legend-qe1z.
//
// Services are called directly with server-minted contexts, like the other
// *-db tests. Actors are real users with real role assignments, so every
// decision goes through the RBAC resolver.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decimal4, outletIdSchema, userIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { Employee } from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { employees, orgUnits } from "../db/schema/hris.ts";
import { withTenant } from "../db/tenant.ts";
import {
  createEmployee,
  getEmployee,
  getEmployeePii,
  getMyHrisProfile,
  listEmployees,
  revealEmployeePii,
  updateEmployeePii,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  createEmployeeDocument,
  createEmploymentContract,
  listEmployeeDocuments,
  listEmploymentContracts,
} from "../services/hris-contract.service.ts";
import {
  createOrgUnit,
  createPosition,
  createPositionGrade,
  listOrgUnits,
  listPositions,
} from "../services/hris-org.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = outletIdSchema.parse(randomUUID());

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdStorage: { tenant: string; id: string }[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string, tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
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

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'HRIS DB', $2)`,
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
        `HRIS test ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
        JSON.stringify([scope.type]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.id : null,
      ],
    );
  });
  return userId;
}

const employeeNo = () =>
  `T-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
/** A 16-digit NIK that no other test row uses. */
const freshNik = () =>
  `32${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

function employeeInput(
  overrides: Partial<CreateEmployeeInput> = {},
): CreateEmployeeInput {
  return {
    userId: null,
    legalEntityId: null,
    employeeNo: employeeNo(),
    fullName: "Karyawan Uji",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwt",
    joinDate: "2026-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
    ...overrides,
  } as CreateEmployeeInput;
}

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

/** `ownerUserId` is the uploader; HR links of an unowned object are refused. */
async function storageObject(
  tenant: string,
  outletId: string,
  ownerUserId: string | null = null,
): Promise<string> {
  const id = randomUUID();
  createdStorage.push({ tenant, id });
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO core_storage_objects (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, owner_user_id)
       VALUES ($1, $2, $3, 'document', $4, 'application/pdf', 1024, $5)`,
      [tenant, outletId, id, `private/${tenant}/${id}.pdf`, ownerUserId],
    ),
  );
  return id;
}

async function auditRows(objectId: string) {
  const { rows } = await asOwner(tenantId, (client) =>
    client.query<{ event: Record<string, unknown>; raw: string }>(
      `SELECT event, event::text AS raw FROM audit_logs
        WHERE tenant_id = $1 AND event->>'objectId' = $2
        ORDER BY event->>'createdAt', id`,
      [tenantId, objectId],
    ),
  );
  return rows;
}

// Actors (assigned in beforeAll).
let hr: string; // tenant-wide HR: hr.employee.manage + hr.employee.view
let payroll: string; // tenant-wide payroll.view (no payroll.run)
let payrollRunner: string; // payroll.view + payroll.run
let managerB: string; // outlet B only: hr.employee.view (supervisor kind)
let staff1: string; // self.profile.view at outlet A
let staff2: string; // self.profile.view at outlet A
let hrOther: string; // HR of the other tenant
let stranger: string; // a user with no HR code at all

// Employees.
let e1: Employee; // staff1, outlet A
let e2: Employee; // staff2, outlet A
let e3: Employee; // outlet B
const NIK1 = freshNik();
const BANK1 = "1234567890123";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'HRIS RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `hris-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });

  hr = await actor(["hr.employee.manage", "hr.employee.view"], {
    type: "tenant",
  });
  payroll = await actor(["payroll.view"], { type: "tenant" });
  payrollRunner = await actor(["payroll.view", "payroll.run"], {
    type: "tenant",
  });
  managerB = await actor(["hr.employee.view"], { type: "outlet", id: outletB });
  staff1 = await actor(["self.profile.view"], { type: "outlet", id: outletA });
  staff2 = await actor(["self.profile.view"], { type: "outlet", id: outletA });
  hrOther = await actor(
    ["hr.employee.manage", "hr.employee.view"],
    { type: "tenant" },
    otherTenant,
  );
  stranger = await actor(["menu.item.view"], { type: "tenant" });

  e1 = await createEmployee(
    tenantScope(),
    hr,
    employeeInput({
      userId: userIdSchema.parse(staff1),
      fullName: "Siti Aminah",
      pii: {
        nik: NIK1,
        npwp: "12.345.678.9-012.000",
        bpjsKesNo: "0001234567890",
        bpjsTkNo: "12345678901",
        bankAccount: BANK1,
        emergencyContactName: "Budi Santoso",
        emergencyContactPhone: "+62 812 1111 2222",
      },
    }),
  );
  e2 = await createEmployee(
    tenantScope(),
    hr,
    employeeInput({
      userId: userIdSchema.parse(staff2),
      fullName: "Rina Putri",
    }),
  );
  e3 = await createEmployee(
    tenantScope(),
    hr,
    employeeInput({
      homeOutletId: outletB,
      pii: { nik: freshNik(), bankAccount: "9876543210" },
    }),
  );
});

afterAll(async () => {
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      const owned = `tenant_id = $1 AND employee_id IN (SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2))`;
      await client.query(`DELETE FROM employee_documents WHERE ${owned}`, [
        tenant,
        createdUsers,
      ]);
      await client.query(`DELETE FROM employment_contracts WHERE ${owned}`, [
        tenant,
        createdUsers,
      ]);
      // The leave accrual job grants every active employee of a tenant, so a
      // parallel leave file can leave ledger/balance rows on ours (FK no action).
      for (const table of ["leave_accruals", "leave_balances"])
        await client.query(`DELETE FROM ${table} WHERE ${owned}`, [
          tenant,
          createdUsers,
        ]);
      await client.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'hris-db-%'",
        [tenant],
      );
      await client.query(
        "UPDATE employees SET manager_id = NULL WHERE tenant_id = $1 AND created_by = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM positions WHERE tenant_id = $1 AND name LIKE 'HRIS Uji%'",
        [tenant],
      );
      await client.query(
        "DELETE FROM position_grades WHERE tenant_id = $1 AND code LIKE 'HG-%'",
        [tenant],
      );
      await client.query(
        "DELETE FROM org_units WHERE tenant_id = $1 AND code LIKE 'HU-%'",
        [tenant],
      );
      const ids = createdStorage
        .filter((row) => row.tenant === tenant)
        .map((row) => row.id);
      if (ids.length > 0)
        await client.query(
          "DELETE FROM core_storage_objects WHERE tenant_id = $1 AND id = ANY($2)",
          [tenant, ids],
        );
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  // platformbe's 0050 constrains audit_logs.outlet_id to outlets, and audit
  // rows are append-only: an outlet that an audited action referenced cannot be
  // deleted any more. Leave that fixture tenant in place instead of failing the
  // suite (the database is disposable per run).
  const referenced = await owner.query(
    "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND outlet_id IS NOT NULL LIMIT 1",
    [otherTenant],
  );
  if ((referenced.rowCount ?? 0) === 0) {
    await asOwner(otherTenant, async (client) => {
      await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await client.query("DELETE FROM brands WHERE tenant_id = $1", [
        otherTenant,
      ]);
    });
    await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ------------------------------------------------------------------ HR-03

describe("HR-03 encrypted PII at rest, masked reads, role-gated decrypt", () => {
  it("[HR-03] stores NIK/NPWP/BPJS/bank/emergency contact as ciphertext only (raw SQL shows no plaintext)", async () => {
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT nik_encrypted, nik_hmac, npwp_encrypted, bpjs_kes_no_encrypted, bpjs_tk_no_encrypted,
                bank_account_encrypted, bank_account_hmac, emergency_contact_name_encrypted,
                emergency_contact_phone_encrypted, pii_key_version, row_to_json(employees)::text AS raw
           FROM employees WHERE tenant_id = $1 AND id = $2`,
        [tenantId, e1.id],
      ),
    );
    const row = rows[0];
    expect(row.pii_key_version).toBe(1);
    for (const column of [
      "nik_encrypted",
      "npwp_encrypted",
      "bpjs_kes_no_encrypted",
      "bpjs_tk_no_encrypted",
      "bank_account_encrypted",
      "emergency_contact_name_encrypted",
      "emergency_contact_phone_encrypted",
    ]) {
      expect(Buffer.isBuffer(row[column]), column).toBe(true);
      expect(row[column][0], `${column} envelope version`).toBe(1);
    }
    expect(row.nik_hmac).toMatch(/^[a-f0-9]{64}$/);
    // Neither the row (as text, bytea hex included) nor any column holds plaintext.
    for (const secret of [
      NIK1,
      "123456789012000",
      "0001234567890",
      BANK1,
      "Budi Santoso",
      "6281211112222",
    ])
      expect(row.raw).not.toContain(secret);
    const { rows: hits } = await asOwner(tenantId, (client) =>
      client.query(
        `SELECT count(*)::int AS n FROM employees
          WHERE tenant_id = $1 AND (encode(nik_encrypted, 'escape') LIKE '%' || $2 || '%'
             OR encode(bank_account_encrypted, 'escape') LIKE '%' || $3 || '%')`,
        [tenantId, NIK1, BANK1],
      ),
    );
    expect(hits[0].n).toBe(0);
  });

  it("[HR-03] HR reads masked values only (never plaintext) and the decrypt is audited", async () => {
    const pii = await getEmployeePii(tenantScope(), hr, e1.id);
    expect(pii.nik).toEqual({ masked: `****${NIK1.slice(-4)}`, keyVersion: 1 });
    expect(pii.npwp?.masked).toBe("****2000");
    expect(pii.bankAccount?.masked).toBe(`****${BANK1.slice(-4)}`);
    expect(pii.emergencyContactName?.masked).toBe("Budi S***");
    expect(JSON.stringify(pii)).not.toContain(NIK1);
    expect(JSON.stringify(pii)).not.toContain(BANK1);
    const audits = (await auditRows(e1.id)).filter(
      (row) => row.event.action === "hris.employee_pii.viewed",
    );
    expect(audits.length).toBeGreaterThan(0);
    const last = audits.at(-1)!;
    expect(last.event.sensitiveAccess).toBe(true);
    expect(last.event.actorId).toBe(hr);
    expect(last.raw).not.toContain(NIK1);
    expect(last.raw).not.toContain(BANK1);
  });

  it("[HR-03] payroll sees masked identity/bank but not the emergency contact", async () => {
    const pii = await getEmployeePii(tenantScope(), payroll, e1.id);
    expect(pii.nik?.masked).toBe(`****${NIK1.slice(-4)}`);
    expect(pii.bankAccount?.masked).toBe(`****${BANK1.slice(-4)}`);
    expect(pii.emergencyContactName).toBeNull();
    expect(pii.emergencyContactPhone).toBeNull();
  });

  it("[HR-03] a supervisor (hr.employee.view only) sees the employee but no PII, and nothing is decrypted", async () => {
    const before = (await auditRows(e3.id)).length;
    const pii = await getEmployeePii(outletScope(outletB), managerB, e3.id);
    expect(Object.values(pii).every((value) => value === null)).toBe(true);
    expect((await auditRows(e3.id)).length).toBe(before);
  });

  it("[HR-03] plaintext reveal is server-only, role-gated, purpose-bound and audited", async () => {
    const revealed = await revealEmployeePii(
      tenantScope(),
      hr,
      e1.id,
      ["nik", "bankAccount"],
      "Ekspor file transfer gaji",
    );
    expect(revealed).toEqual({ nik: NIK1, bankAccount: BANK1 });
    const audit = (await auditRows(e1.id)).filter(
      (row) => row.event.action === "hris.employee_pii.revealed",
    );
    expect(audit.at(-1)?.event.reason).toBe("Ekspor file transfer gaji");
    expect(audit.at(-1)?.raw).not.toContain(NIK1);

    // payroll.run unlocks the payroll viewer; payroll.view alone does not.
    expect(
      await revealEmployeePii(
        tenantScope(),
        payrollRunner,
        e1.id,
        ["bankAccount"],
        "Bank file",
      ),
    ).toEqual({ bankAccount: BANK1 });
    expect(
      (
        await failure(
          revealEmployeePii(tenantScope(), payroll, e1.id, ["nik"], "x"),
        )
      ).status,
    ).toBe(403);
    // Payroll may never reveal the emergency contact (hidden for payroll).
    expect(
      (
        await failure(
          revealEmployeePii(
            tenantScope(),
            payrollRunner,
            e1.id,
            ["emergencyContactName"],
            "x",
          ),
        )
      ).status,
    ).toBe(403);
    // Self (masked only) and supervisors fail closed; another outlet answers 404.
    expect(
      (
        await failure(
          revealEmployeePii(outletScope(outletA), staff1, e1.id, ["nik"], "x"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await failure(
          revealEmployeePii(
            outletScope(outletB),
            managerB,
            e3.id,
            ["bankAccount"],
            "x",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await failure(
          revealEmployeePii(
            outletScope(outletB),
            managerB,
            e1.id,
            ["nik"],
            "x",
          ),
        )
      ).status,
    ).toBe(404);
    // No purpose, no decrypt.
    expect(
      (
        await failure(
          revealEmployeePii(tenantScope(), hr, e1.id, ["nik"], "  "),
        )
      ).status,
    ).toBe(422);
  });

  it("[HR-03] HR updates PII write-only; the response is masked, the write is audited by field name only", async () => {
    const newBank = "5550001112223";
    const body = {
      bankAccount: newBank,
      idempotencyKey: `hris-db-${randomUUID()}`,
    };
    const first = await updateEmployeePii(tenantScope(), hr, e2.id, body);
    expect(first.bankAccount?.masked).toBe("****2223");
    expect(JSON.stringify(first)).not.toContain(newBank);
    // Same key + same request → same answer; same key + other request → refused.
    expect(await updateEmployeePii(tenantScope(), hr, e2.id, body)).toEqual(
      first,
    );
    expect(
      codeOf(
        (
          await failure(
            updateEmployeePii(tenantScope(), hr, e2.id, {
              ...body,
              bankAccount: "5550001112224",
            }),
          )
        ).error,
      ),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
    const updated = (await auditRows(e2.id)).filter(
      (row) => row.event.action === "hris.employee_pii.updated",
    );
    expect(updated).toHaveLength(1);
    expect(updated[0].raw).not.toContain(newBank);
    expect(updated[0].event.maskedChanges).toEqual({
      before: null,
      // A new account clears the old bank code (legend-86he4), so it is listed.
      after: { changedFields: ["bankAccount", "bankCode"] },
    });
  });

  it("[HR-03] only hr.employee.manage may write PII (payroll, supervisor, self refused)", async () => {
    const body = () => ({
      npwp: "123456789012345",
      idempotencyKey: `hris-db-${randomUUID()}`,
    });
    expect(
      (await failure(updateEmployeePii(tenantScope(), payroll, e1.id, body())))
        .status,
    ).toBe(403);
    expect(
      (
        await failure(
          updateEmployeePii(outletScope(outletA), staff1, e1.id, body()),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await failure(
          updateEmployeePii(outletScope(outletB), managerB, e3.id, body()),
        )
      ).status,
    ).toBe(403);
  });

  it("[HR-03] ciphertext copied to another employee row cannot be opened (AAD binds the row)", async () => {
    const victim = await createEmployee(
      tenantScope(),
      hr,
      employeeInput({ pii: { nik: freshNik() } }),
    );
    await asOwner(tenantId, (client) =>
      client.query(
        `UPDATE employees SET nik_encrypted = (SELECT nik_encrypted FROM employees WHERE tenant_id = $1 AND id = $2)
          WHERE tenant_id = $1 AND id = $3`,
        [tenantId, e1.id, victim.id],
      ),
    );
    await expect(
      getEmployeePii(tenantScope(), hr, victim.id),
    ).rejects.toThrow();
  });

  it("[HR-03] the blind index enforces one NIK per tenant (any formatting) without plaintext", async () => {
    const formatted = `${NIK1.slice(0, 4)}.${NIK1.slice(4, 8)}-${NIK1.slice(8)}`;
    const duplicate = await failure(
      createEmployee(
        tenantScope(),
        hr,
        employeeInput({ pii: { nik: formatted } }),
      ),
    );
    expect(duplicate.status).toBe(409);
    expect((duplicate.error as Error).message).not.toContain(NIK1);
    const viaUpdate = await failure(
      updateEmployeePii(tenantScope(), hr, e2.id, {
        nik: NIK1,
        idempotencyKey: `hris-db-${randomUUID()}`,
      }),
    );
    expect(viaUpdate.status).toBe(409);
    // The same NIK in another tenant is a different person record (tenant-separated HMAC).
    const elsewhere = await createEmployee(
      tenantScope(otherTenant),
      hrOther,
      employeeInput({ homeOutletId: otherOutlet, pii: { nik: NIK1 } }),
    );
    const hmacOf = (tenant: string, id: string) =>
      asOwner(tenant, async (client) => {
        const { rows } = await client.query<{ nik_hmac: string }>(
          "SELECT nik_hmac FROM employees WHERE tenant_id = $1 AND id = $2",
          [tenant, id],
        );
        return rows[0]?.nik_hmac;
      });
    const here = await hmacOf(tenantId, e1.id);
    const there = await hmacOf(otherTenant, elsewhere.id);
    expect(here).toMatch(/^[a-f0-9]{64}$/);
    expect(there).toMatch(/^[a-f0-9]{64}$/);
    expect(there).not.toBe(here);
  });

  it("[HR-03] contract salary is sealed at rest, masked for HR/payroll, hidden for self and supervisors", async () => {
    const contract = await createEmploymentContract(tenantScope(), hr, {
      employeeId: e1.id,
      type: "pkwt",
      taxScheme: "gross",
      startDate: "2026-01-05",
      endDate: "2026-12-31",
      renewedFromId: null,
      salarySnapshotIdr: 5_750_000,
      fileObjectId: null,
      reminderDaysBefore: 30,
      status: "active",
    });
    expect(contract.salarySnapshot?.masked).toBe("****0000");
    const { rows } = await asOwner(tenantId, (client) =>
      client.query(
        "SELECT row_to_json(employment_contracts)::text AS raw, salary_snapshot_encrypted FROM employment_contracts WHERE id = $1",
        [contract.id],
      ),
    );
    expect(Buffer.isBuffer(rows[0].salary_snapshot_encrypted)).toBe(true);
    expect(rows[0].raw).not.toContain("5750000");

    const asPayroll = await listEmploymentContracts(tenantScope(), payroll, {
      limit: 20,
      employeeId: e1.id,
    });
    expect(asPayroll.data[0]?.salarySnapshot?.masked).toBe("****0000");
    const asSelf = await listEmploymentContracts(outletScope(outletA), staff1, {
      limit: 20,
    });
    expect(asSelf.data.map((row) => row.id)).toEqual([contract.id]);
    expect(asSelf.data[0]?.salarySnapshot).toBeNull();
  });
});

// ------------------------------------------------------- legend-rhq5

describe("legend-rhq5 the PPh 21 tax scheme is an attribute of the employment contract", () => {
  const schemes = ["gross", "gross_up", "net"] as const;

  const contractInput = (taxScheme: (typeof schemes)[number]) => ({
    employeeId: e1.id,
    type: "pkwt" as const,
    taxScheme,
    startDate: "2026-02-01",
    endDate: "2026-12-31",
    renewedFromId: null,
    salarySnapshotIdr: null,
    fileObjectId: null,
    reminderDaysBefore: 30,
  });

  const contractsOfE1 = async (viewer: string) =>
    (
      await listEmploymentContracts(tenantScope(), viewer, {
        limit: 100,
        employeeId: e1.id,
      })
    ).data;

  // Raw insert as the table owner (tenant context set by asOwner), so only the
  // database constraints decide. `undefined` leaves the column out entirely.
  const rawInsert = (taxScheme: string | undefined) =>
    asOwner(tenantId, (client) =>
      client.query(
        `INSERT INTO employment_contracts
           (id, tenant_id, employee_id, type, ${taxScheme === undefined ? "" : "tax_scheme,"}
            start_date, end_date, reminder_days_before, status)
         VALUES ($1, $2, $3, 'pkwt', ${taxScheme === undefined ? "" : "$4,"}
                 '2026-02-01', '2026-12-31', 30, 'draft')`,
        taxScheme === undefined
          ? [randomUUID(), tenantId, e1.id]
          : [randomUUID(), tenantId, e1.id, taxScheme],
      ),
    );

  for (const scheme of schemes)
    it(`[legend-rhq5] creating a ${scheme} contract keeps taxScheme when it is read back`, async () => {
      const created = await createEmploymentContract(
        tenantScope(),
        hr,
        contractInput(scheme),
      );
      expect(created.taxScheme).toBe(scheme);

      const listed = await contractsOfE1(hr);
      expect(listed.find((row) => row.id === created.id)?.taxScheme).toBe(
        scheme,
      );

      const { rows } = await asOwner(tenantId, (client) =>
        client.query(
          "SELECT tax_scheme FROM employment_contracts WHERE id = $1",
          [created.id],
        ),
      );
      expect(rows[0].tax_scheme).toBe(scheme);
    });

  it("[legend-rhq5] a payroll viewer reads the scheme too", async () => {
    const created = await createEmploymentContract(
      tenantScope(),
      hr,
      contractInput("gross_up"),
    );
    const asPayroll = await contractsOfE1(payroll);
    expect(asPayroll.find((row) => row.id === created.id)?.taxScheme).toBe(
      "gross_up",
    );
  });

  it("[legend-rhq5] the database rejects a raw insert without tax_scheme (no silent default)", async () => {
    const rejected = await failure(rawInsert(undefined));
    expect(rejected.code).toBe("23502"); // not_null_violation
  });

  it("[legend-rhq5] the database rejects an invalid tax_scheme value", async () => {
    for (const bad of ["", "GROSS", "grossup", "net_up", "none"]) {
      const rejected = await failure(rawInsert(bad));
      expect(rejected.code, bad).toBe("23514"); // check_violation
    }
    // Control: a valid value goes through the very same statement.
    await expect(rawInsert("net")).resolves.toBeDefined();
  });

  it("[legend-rhq5] the service refuses an unknown tax scheme and writes nothing", async () => {
    const before = (await contractsOfE1(hr)).length;
    await expect(
      createEmploymentContract(tenantScope(), hr, {
        ...contractInput("gross"),
        taxScheme: "bogus" as never,
      }),
    ).rejects.toBeDefined();
    expect((await contractsOfE1(hr)).length).toBe(before);
  });

  it("[legend-rhq5] the creation audit entry carries taxScheme", async () => {
    const created = await createEmploymentContract(
      tenantScope(),
      hr,
      contractInput("net"),
    );
    const entries = (await auditRows(created.id)).filter(
      (row) => row.event.action === "hris.employment_contract.created",
    );
    expect(entries).toHaveLength(1);
    // The scheme is not sensitive, so it is stored readable, not redacted.
    expect(JSON.stringify(entries[0].event)).toContain('"taxScheme":"net"');
  });
});

// ------------------------------------------------------------------ HR-01

describe("HR-01 an employee sees only their own data", () => {
  it("[HR-01] /me resolves the caller's own row without any id in the request", async () => {
    const profile = await getMyHrisProfile(outletScope(outletA), staff1);
    expect(profile.employee.id).toBe(e1.id);
    expect(profile.outlet.id).toBe(outletA);
    await expect(
      getMyHrisProfile(tenantScope(), stranger),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("[HR-01] own record and own masked PII are readable; another employee's answers 404", async () => {
    expect((await getEmployee(outletScope(outletA), staff1, e1.id)).id).toBe(
      e1.id,
    );
    const own = await getEmployeePii(outletScope(outletA), staff1, e1.id);
    expect(own.nik?.masked).toBe(`****${NIK1.slice(-4)}`);
    expect(own.emergencyContactName?.masked).toBe("Budi S***");
    expect(
      (await failure(getEmployee(outletScope(outletA), staff1, e2.id))).status,
    ).toBe(404);
    expect(
      (await failure(getEmployeePii(outletScope(outletA), staff1, e2.id)))
        .status,
    ).toBe(404);
    expect(
      (await failure(getEmployee(outletScope(outletA), staff1, randomUUID())))
        .status,
    ).toBe(404);
  });

  it("[HR-01] a self-only caller cannot list employees, org structure, or others' contracts", async () => {
    expect(
      (
        await failure(
          listEmployees(outletScope(outletA), staff1, { limit: 20 }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await failure(listOrgUnits(outletScope(outletA), staff1, { limit: 20 })))
        .status,
    ).toBe(403);
    const contracts = await listEmploymentContracts(
      outletScope(outletA),
      staff2,
      {
        limit: 20,
        employeeId: e1.id,
      },
    );
    expect(contracts.data).toEqual([]);
  });

  it("[HR-01] documents: owner and HR list them (signed URL audited); others get 404/403", async () => {
    const objectId = await storageObject(tenantId, outletA, hr);
    const document = await createEmployeeDocument(tenantScope(), hr, {
      employeeId: e1.id,
      type: "ktp",
      storageObjectId: objectId,
      expiresOn: null,
    });
    const signer = async (_context: unknown, id: string) =>
      `https://signed.example.test/${id}`;
    const own = await listEmployeeDocuments(
      outletScope(outletA),
      staff1,
      e1.id,
      { limit: 20 },
      signer,
    );
    expect(own.data.map((row) => row.id)).toEqual([document.id]);
    expect(own.data[0]?.downloadUrl).toBe(
      `https://signed.example.test/${objectId}`,
    );
    expect(JSON.stringify(own)).not.toContain("private/");
    const audit = (await auditRows(document.id)).filter(
      (row) => row.event.action === "hris.employee_document.url_issued",
    );
    expect(audit).toHaveLength(1);
    // Default signer mints nothing (storage not wired → fail closed).
    const byHr = await listEmployeeDocuments(tenantScope(), hr, e1.id, {
      limit: 20,
    });
    expect(byHr.data[0]?.downloadUrl).toBeNull();
    expect(
      (
        await failure(
          listEmployeeDocuments(
            outletScope(outletA),
            staff2,
            e1.id,
            { limit: 20 },
            signer,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await failure(
          listEmployeeDocuments(
            tenantScope(),
            payroll,
            e1.id,
            { limit: 20 },
            signer,
          ),
        )
      ).status,
    ).toBe(403);
  });
});

// ------------------------------------------- storage object source + owner

describe("storage-object-owner HR files record their source and the employee as owner", () => {
  const storageRow = async (objectId: string) =>
    (
      await asOwner(tenantId, (client) =>
        client.query<{
          source_kind: string | null;
          source_id: string | null;
          owner_user_id: string | null;
        }>(
          "SELECT source_kind, source_id, owner_user_id FROM core_storage_objects WHERE tenant_id = $1 AND id = $2",
          [tenantId, objectId],
        ),
      )
    ).rows[0];

  const contractInput = (fileObjectId: string) => ({
    employeeId: e1.id,
    type: "pkwt" as const,
    taxScheme: "gross" as const,
    startDate: "2026-02-01",
    endDate: "2026-12-31",
    renewedFromId: null,
    salarySnapshotIdr: null,
    fileObjectId,
    reminderDaysBefore: 30,
  });

  it("[storage-object-owner] an employee document links its file: source employee_document, owner = the employee's user (not the HR actor)", async () => {
    const objectId = await storageObject(tenantId, outletA, hr);
    expect(await storageRow(objectId)).toMatchObject({
      source_kind: null,
      source_id: null,
      owner_user_id: hr,
    });
    const document = await createEmployeeDocument(tenantScope(), hr, {
      employeeId: e1.id,
      type: "ktp",
      storageObjectId: objectId,
      expiresOn: null,
    });
    expect(await storageRow(objectId)).toEqual({
      source_kind: "employee_document",
      source_id: document.id,
      owner_user_id: staff1,
    });
  });

  it("[storage-object-owner] an employment contract file links the same way: source employment_contract, owner = the employee's user", async () => {
    const objectId = await storageObject(tenantId, outletA, hr);
    const contract = await createEmploymentContract(
      tenantScope(),
      hr,
      contractInput(objectId),
    );
    expect(await storageRow(objectId)).toEqual({
      source_kind: "employment_contract",
      source_id: contract.id,
      owner_user_id: staff1,
    });
  });

  it("[storage-object-owner] HR cannot link a file uploaded (owned) by another user; HR's own upload links and passes to the employee", async () => {
    const owned = async (objectId: string, userId: string) =>
      asOwner(tenantId, (client) =>
        client.query(
          "UPDATE core_storage_objects SET owner_user_id = $3 WHERE tenant_id = $1 AND id = $2",
          [tenantId, objectId, userId],
        ),
      );
    const input = (storageObjectId: string) => ({
      employeeId: e1.id,
      type: "ktp" as const,
      storageObjectId,
      expiresOn: null,
    });
    const countDocs = async (objectId: string) =>
      Number(
        (
          await asOwner(tenantId, (client) =>
            client.query<{ n: string }>(
              "SELECT count(*) AS n FROM employee_documents WHERE tenant_id = $1 AND storage_object_id = $2",
              [tenantId, objectId],
            ),
          )
        ).rows[0]!.n,
      );

    // Uploaded by someone else (staff2 is neither HR nor the employee).
    const foreign = await storageObject(tenantId, outletA);
    await owned(foreign, staff2);
    const refused = await failure(
      createEmployeeDocument(tenantScope(), hr, input(foreign)),
    );
    expect(refused.code).toBe("VALIDATION_ERROR");
    expect(await countDocs(foreign)).toBe(0);
    expect(await storageRow(foreign)).toEqual({
      source_kind: null,
      source_id: null,
      owner_user_id: staff2,
    });
    // Same for a contract file.
    expect(
      (
        await failure(
          createEmploymentContract(tenantScope(), hr, contractInput(foreign)),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(await storageRow(foreign)).toMatchObject({
      source_kind: null,
      owner_user_id: staff2,
    });

    // Positive control: HR uploaded it, so HR may link it; owner moves to the employee.
    const mine = await storageObject(tenantId, outletA);
    await owned(mine, hr);
    const document = await createEmployeeDocument(
      tenantScope(),
      hr,
      input(mine),
    );
    expect(await storageRow(mine)).toEqual({
      source_kind: "employee_document",
      source_id: document.id,
      owner_user_id: staff1,
    });
  });

  it("[storage-object-owner] HR cannot link an unowned (legacy, null-owner) file; the same file owned by HR links", async () => {
    const input = (storageObjectId: string) => ({
      employeeId: e1.id,
      type: "ktp" as const,
      storageObjectId,
      expiresOn: null,
    });
    const unowned = await storageObject(tenantId, outletA);
    expect(
      (await failure(createEmployeeDocument(tenantScope(), hr, input(unowned))))
        .code,
    ).toBe("VALIDATION_ERROR");
    expect(
      (
        await failure(
          createEmploymentContract(tenantScope(), hr, contractInput(unowned)),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(await storageRow(unowned)).toEqual({
      source_kind: null,
      source_id: null,
      owner_user_id: null,
    });
    // Positive control: the same shape of file, uploaded by HR, links.
    const owned = await storageObject(tenantId, outletA, hr);
    const document = await createEmployeeDocument(
      tenantScope(),
      hr,
      input(owned),
    );
    expect((await storageRow(owned)).source_id).toBe(document.id);
  });

  it("[storage-object-owner] a file stored at another outlet than the employee's home outlet is refused", async () => {
    // e1's home outlet is A; the file sits at outlet B.
    const elsewhere = await storageObject(tenantId, outletB, hr);
    expect(
      (
        await failure(
          createEmployeeDocument(tenantScope(), hr, {
            employeeId: e1.id,
            type: "ktp",
            storageObjectId: elsewhere,
            expiresOn: null,
          }),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      (
        await failure(
          createEmploymentContract(tenantScope(), hr, contractInput(elsewhere)),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(await storageRow(elsewhere)).toEqual({
      source_kind: null,
      source_id: null,
      owner_user_id: hr,
    });
    // Positive control: employee e3 is homed at outlet B, so the same file links for them.
    const document = await createEmployeeDocument(tenantScope(), hr, {
      employeeId: e3.id,
      type: "ktp",
      storageObjectId: elsewhere,
      expiresOn: null,
    });
    expect((await storageRow(elsewhere)).source_id).toBe(document.id);
  });

  it("[storage-object-owner] a file already linked cannot be linked a second time: nothing new is created and the first link stays", async () => {
    const objectId = await storageObject(tenantId, outletA, hr);
    const first = await createEmployeeDocument(tenantScope(), hr, {
      employeeId: e1.id,
      type: "ktp",
      storageObjectId: objectId,
      expiresOn: null,
    });
    const count = async (table: string) =>
      Number(
        (
          await asOwner(tenantId, (client) =>
            client.query<{ n: string }>(
              `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1 AND ${
                table === "employee_documents"
                  ? "storage_object_id"
                  : "file_object_id"
              } = $2`,
              [tenantId, objectId],
            ),
          )
        ).rows[0]!.n,
      );

    // Same object as a second document, for the same and for another employee.
    for (const employeeId of [e1.id, e2.id])
      expect(
        (
          await failure(
            createEmployeeDocument(tenantScope(), hr, {
              employeeId,
              type: "npwp",
              storageObjectId: objectId,
              expiresOn: null,
            }),
          )
        ).code,
      ).toBe("VALIDATION_ERROR");
    // Same object as a contract file.
    expect(
      (
        await failure(
          createEmploymentContract(tenantScope(), hr, contractInput(objectId)),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");

    expect(await count("employee_documents")).toBe(1);
    expect(await count("employment_contracts")).toBe(0);
    expect(await storageRow(objectId)).toEqual({
      source_kind: "employee_document",
      source_id: first.id,
      owner_user_id: staff1,
    });
  });
});

// --------------------------------------------------- TEN-01/02/03 isolation

describe("HRIS tenant and outlet isolation", () => {
  it("[TEN-01] another tenant's HR never sees this tenant's employees, even by id", async () => {
    const list = await listEmployees(tenantScope(otherTenant), hrOther, {
      limit: 100,
    });
    expect(list.data.every((row) => row.tenantId === otherTenant)).toBe(true);
    expect(list.data.map((row) => row.id)).not.toContain(e1.id);
    expect(
      (await failure(getEmployee(tenantScope(otherTenant), hrOther, e1.id)))
        .status,
    ).toBe(404);
    expect(
      (await failure(getEmployeePii(tenantScope(otherTenant), hrOther, e1.id)))
        .status,
    ).toBe(404);
    const rows = await withTenant(db, tenantScope(otherTenant), (tx) =>
      tx.select().from(employees).where(eq(employees.id, e1.id)),
    );
    expect(rows).toEqual([]);
  });

  it("[TEN-02] RLS refuses writing a row into another tenant from a tenant context", async () => {
    await expect(
      withTenant(db, tenantScope(otherTenant), (tx) =>
        tx.insert(orgUnits).values({
          tenantId,
          code: `HU-${randomUUID().slice(0, 6)}`,
          name: "Bocor",
        }),
      ),
    ).rejects.toThrow();
  });

  it("[TEN-03] an outlet-B HR viewer lists only outlet-B employees and cannot open outlet-A rows", async () => {
    const list = await listEmployees(outletScope(outletB), managerB, {
      limit: 100,
    });
    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data.every((row) => row.homeOutletId === outletB)).toBe(true);
    expect(
      (await failure(getEmployee(outletScope(outletB), managerB, e1.id)))
        .status,
    ).toBe(404);
    // Creating at an outlet the caller does not manage is refused.
    expect(
      (
        await failure(
          createEmployee(
            outletScope(outletB),
            managerB,
            employeeInput({ homeOutletId: outletB }),
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("[TEN-03] a user without any HR code is refused", async () => {
    expect(
      (await failure(listEmployees(tenantScope(), stranger, { limit: 20 })))
        .status,
    ).toBe(403);
    expect(
      (await failure(getEmployee(tenantScope(), stranger, e1.id))).status,
    ).toBe(404);
  });

  it("[TEN-01] org structure is tenant-scoped and readable by HR", async () => {
    const unit = await createOrgUnit(tenantScope(), hr, {
      parentId: null,
      code: `HU-${randomUUID().slice(0, 6).toUpperCase()}`,
      name: "Dapur",
    });
    const grade = await createPositionGrade(tenantScope(), hr, {
      code: `HG-${randomUUID().slice(0, 6).toUpperCase()}`,
      name: "Staf",
      level: 1,
    });
    const position = await createPosition(tenantScope(), hr, {
      name: "HRIS Uji Cook",
      gradeId: grade.id,
      orgUnitId: unit.id,
      serviceChargePoints: decimal4("1.5000"),
    });
    const units = await listOrgUnits(tenantScope(), hr, { limit: 100 });
    expect(units.data.map((row) => row.id)).toContain(unit.id);
    const listed = await listPositions(tenantScope(), payroll, {
      limit: 100,
      orgUnitId: unit.id,
    });
    expect(listed.data.map((row) => row.id)).toEqual([position.id]);
    const otherUnits = await listOrgUnits(tenantScope(otherTenant), hrOther, {
      limit: 100,
    });
    expect(otherUnits.data.map((row) => row.id)).not.toContain(unit.id);
    // Outlet-scoped HR may not create tenant-wide structure.
    expect(
      (
        await failure(
          createOrgUnit(outletScope(outletB), managerB, {
            parentId: null,
            code: "HU-X",
            name: "X",
          }),
        )
      ).status,
    ).toBe(403);
  });
});

// ------------------------------------------------------------------ HR-04

describe("HR-04 employee quota of the tenant plan", () => {
  async function seats(tenant: string): Promise<number> {
    const { rows } = await asOwner(tenant, (client) =>
      client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM employees
          WHERE tenant_id = $1 AND status IN ('onboarding', 'active', 'suspended')`,
        [tenant],
      ),
    );
    return rows[0]!.n;
  }
  async function setQuota(tenant: string, max: number) {
    await owner.query(
      `UPDATE tenants SET limits = jsonb_set(limits, '{maxActiveEmployees}', to_jsonb($2::int)) WHERE id = $1`,
      [tenant, max],
    );
  }

  it("[HR-04] six concurrent creates with two seats left: exactly two succeed, four get QUOTA_EXCEEDED", async () => {
    const used = await seats(otherTenant);
    await setQuota(otherTenant, used + 2);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createEmployee(
          tenantScope(otherTenant),
          hrOther,
          employeeInput({ homeOutletId: otherOutlet }),
        ),
      ),
    );
    const ok = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(ok).toHaveLength(2);
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      expect(codeOf(result.reason)).toBe("QUOTA_EXCEEDED");
      expect(statusOf(result.reason)).toBe(409);
    }
    expect(await seats(otherTenant)).toBe(used + 2);
  });

  it("[HR-04] onboarding counts as a seat and a resigned employee frees one", async () => {
    const used = await seats(otherTenant);
    await setQuota(otherTenant, used + 1);
    const onboarding = await createEmployee(
      tenantScope(otherTenant),
      hrOther,
      employeeInput({ homeOutletId: otherOutlet, status: "onboarding" }),
    );
    expect(
      codeOf(
        (
          await failure(
            createEmployee(
              tenantScope(otherTenant),
              hrOther,
              employeeInput({ homeOutletId: otherOutlet }),
            ),
          )
        ).error,
      ),
    ).toBe("QUOTA_EXCEEDED");
    await asOwner(otherTenant, (client) =>
      client.query(
        "UPDATE employees SET status = 'resigned', end_date = '2026-06-30' WHERE id = $1",
        [onboarding.id],
      ),
    );
    const replacement = await createEmployee(
      tenantScope(otherTenant),
      hrOther,
      employeeInput({ homeOutletId: otherOutlet }),
    );
    expect(replacement.status).toBe("active");
  });

  it("[HR-04] a quota of zero refuses the first employee", async () => {
    await setQuota(otherTenant, 0);
    expect(
      codeOf(
        (
          await failure(
            createEmployee(
              tenantScope(otherTenant),
              hrOther,
              employeeInput({ homeOutletId: otherOutlet }),
            ),
          )
        ).error,
      ),
    ).toBe("QUOTA_EXCEEDED");
  });
});
