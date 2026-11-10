// HRIS PII key rotation re-seal job against PostgreSQL with the restricted app
// role (RLS enforced): bead legend-33mj. The suite runs with a key ring of
// versions 1 and 2 and version 2 active; rows are forced back to version 1 to
// stand for data written before the rotation.
//
// Covers: v1 -> v2 re-seal of employees and employment_contracts (all rows
// readable through the services afterwards), idempotent second run, resumable
// after an interrupt (abort signal and a crash), tenant isolation of a single
// tenant run and AAD tenant binding after the move. Review fixes: every tenant
// status is listed, a row locked by someone else makes the run incomplete (and
// the job fail), and the job refuses a target version that is not the worker's.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Config reads the environment when it loads, before the imports below run.
const KEY2 = vi.hoisted(() => {
  const key = Buffer.alloc(32, 9).toString("base64");
  process.env.HRIS_PII_KEYS = `2:${key}`;
  process.env.HRIS_PII_ACTIVE_KEY_VERSION = "2";
  return key;
});

import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  HRIS_PII_KEY_VERSION,
  openHrisPii,
  sealHrisPii,
  type HrisPiiBinding,
} from "../lib/hris-pii.ts";
import {
  createEmployee,
  getEmployeePii,
  revealEmployeePii,
  updateEmployeePii,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  createEmploymentContract,
  listEmploymentContracts,
} from "../services/hris-contract.service.ts";
import {
  listAllTenantIds,
  registerHrisPiiResealJob,
  runHrisPiiReseal,
} from "../worker/hris-pii-reseal.job.ts";

const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;
const tenantA = randomUUID();
const tenantB = randomUUID();
const tenants = [tenantA, tenantB];
const brand = { [tenantA]: randomUUID(), [tenantB]: randomUUID() };
const entity = { [tenantA]: randomUUID(), [tenantB]: randomUUID() };
const outlet = { [tenantA]: randomUUID(), [tenantB]: randomUUID() };

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];

const scope = (tenant: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

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

async function hrActor(tenant: string): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'PII reseal', $2)`,
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
        `PII reseal ${roleId.slice(0, 8)}`,
        JSON.stringify(["hr.employee.manage", "hr.employee.view"]),
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

const employeeNo = () =>
  `R-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
let nikCounter = 0;
/** A 16-digit NIK that no other row uses. */
const freshNik = () =>
  `33${String(Date.now()).slice(-8)}${String(900_000 + nikCounter++).padStart(6, "0")}`;

type Seeded = {
  tenant: string;
  id: string;
  nik: string | null;
  bank: string | null;
};
const hr: Record<string, string> = {};
const employeesOf: Record<string, Seeded[]> = { [tenantA]: [], [tenantB]: [] };
const contractsOf: Record<string, string[]> = { [tenantA]: [], [tenantB]: [] };

async function seedEmployee(tenant: string, withPii: boolean): Promise<Seeded> {
  const nik = withPii ? freshNik() : null;
  const bank = withPii ? `98765${nikCounter}43210` : null;
  const created = await createEmployee(scope(tenant), hr[tenant]!, {
    userId: null,
    legalEntityId: null,
    employeeNo: employeeNo(),
    fullName: "Karyawan Rotasi",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletIdSchema.parse(outlet[tenant]),
    employmentType: "pkwt",
    joinDate: "2026-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
    ...(withPii
      ? {
          pii: {
            nik: nik!,
            bankAccount: bank!,
            emergencyContactName: "Budi Santoso",
          },
        }
      : {}),
  } as CreateEmployeeInput);
  const seeded = { tenant, id: created.id, nik, bank };
  employeesOf[tenant]!.push(seeded);
  return seeded;
}

async function seedContract(tenant: string, employeeId: string) {
  const contract = await createEmploymentContract(scope(tenant), hr[tenant]!, {
    employeeId,
    type: "pkwt",
    taxScheme: "gross",
    startDate: "2026-02-01",
    endDate: "2026-12-31",
    renewedFromId: null,
    salarySnapshotIdr: 4_500_000,
    fileObjectId: null,
    reminderDaysBefore: 30,
    status: "active",
  });
  contractsOf[tenant]!.push(contract.id);
}

const EMPLOYEE_COLUMNS: [string, HrisPiiBinding["field"]][] = [
  ["nik_encrypted", "nik"],
  ["npwp_encrypted", "npwp"],
  ["bpjs_kes_no_encrypted", "bpjsKesNo"],
  ["bpjs_tk_no_encrypted", "bpjsTkNo"],
  ["bank_account_encrypted", "bankAccount"],
  ["emergency_contact_name_encrypted", "emergencyContactName"],
  ["emergency_contact_phone_encrypted", "emergencyContactPhone"],
];

/** Re-seals every sealed column of one row under `to` (test fixture only). */
async function forceVersion(
  tenant: string,
  table: "employees" | "employment_contracts",
  id: string,
  to: number,
): Promise<void> {
  const columns: [string, HrisPiiBinding["field"]][] =
    table === "employees"
      ? EMPLOYEE_COLUMNS
      : [["salary_snapshot_encrypted", "salarySnapshot"]];
  await asOwner(tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`,
      [tenant, id],
    );
    const row = rows[0];
    const from = Number(row.pii_key_version);
    for (const [column, field] of columns) {
      const sealed = row[column] as Buffer | null;
      if (!sealed) continue;
      const binding: HrisPiiBinding = {
        tenantId: tenant,
        table,
        rowId: id,
        field,
      };
      const value = openHrisPii(sealed, binding, from);
      await client.query(
        `UPDATE ${table} SET ${column} = $3 WHERE tenant_id = $1 AND id = $2`,
        [tenant, id, sealHrisPii(value, binding, to)],
      );
    }
    await client.query(
      `UPDATE ${table} SET pii_key_version = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenant, id, to],
    );
  });
}

async function forceAll(to: number) {
  for (const tenant of tenants) {
    for (const employee of employeesOf[tenant]!)
      await forceVersion(tenant, "employees", employee.id, to);
    for (const id of contractsOf[tenant]!)
      await forceVersion(tenant, "employment_contracts", id, to);
  }
}

async function versionCounts(tenant: string) {
  return asOwner(tenant, async (client) => {
    const count = async (table: string, where: string) =>
      Number(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${where}`,
            [tenant],
          )
        ).rows[0].n,
      );
    return {
      employeesV1: await count("employees", "pii_key_version = 1"),
      employeesV2: await count("employees", "pii_key_version = 2"),
      contractsV1: await count("employment_contracts", "pii_key_version = 1"),
      contractsV2: await count("employment_contracts", "pii_key_version = 2"),
    };
  });
}

const quiet = { error: () => {} };
const reseal = (
  extra: Partial<Parameters<typeof runHrisPiiReseal>[0]> = {},
  only: string[] = tenants,
) =>
  runHrisPiiReseal({
    batchSize: 2,
    log: quiet,
    listTenantIds: async () => only,
    ...extra,
  });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  expect(HRIS_PII_KEY_VERSION).toBe(2);
  for (const tenant of tenants) {
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'PII reseal tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `pii-reseal-${tenant.slice(0, 8)}`, fixtureTenant],
    );
    await asOwner(tenant, async (client) => {
      await client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
        [brand[tenant], tenant],
      );
      await client.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT R', false)`,
        [entity[tenant], tenant],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, 'R-01', 'Outlet R', 'Jl. R', 'Asia/Jakarta',
                 '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
        [outlet[tenant], tenant, brand[tenant], entity[tenant]],
      );
    });
    hr[tenant] = await hrActor(tenant);
  }
  // Tenant A: three employees (one without PII) and two contracts. Tenant B:
  // two employees and one contract.
  const a1 = await seedEmployee(tenantA, true);
  await seedEmployee(tenantA, true);
  const a3 = await seedEmployee(tenantA, false);
  await seedContract(tenantA, a1.id);
  await seedContract(tenantA, a3.id);
  const b1 = await seedEmployee(tenantB, true);
  await seedEmployee(tenantB, true);
  await seedContract(tenantB, b1.id);
  // Everything written before the rotation is version 1.
  await forceAll(1);
});

afterAll(async () => {
  for (const tenant of tenants)
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM employment_contracts WHERE tenant_id = $1",
        [tenant],
      );
      await client.query("DELETE FROM hris_idempotency WHERE tenant_id = $1", [
        tenant,
      ]);
      await client.query("DELETE FROM employees WHERE tenant_id = $1", [
        tenant,
      ]);
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  for (const tenant of tenants) {
    // Audit rows are append-only and may reference the outlet: keep the
    // fixture tenant in that case (the database is disposable per run).
    const referenced = await owner.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND outlet_id IS NOT NULL LIMIT 1",
      [tenant],
    );
    if ((referenced.rowCount ?? 0) > 0) continue;
    await asOwner(tenant, async (client) => {
      await client.query("DELETE FROM outlets WHERE tenant_id = $1", [tenant]);
      await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
        tenant,
      ]);
      await client.query("DELETE FROM brands WHERE tenant_id = $1", [tenant]);
    });
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenant]);
  }
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

describe("legend-33mj HRIS PII re-seal job", () => {
  it("[HR-03] starts from version 1 rows that the services still read", async () => {
    expect(await versionCounts(tenantA)).toEqual({
      employeesV1: 3,
      employeesV2: 0,
      contractsV1: 2,
      contractsV2: 0,
    });
    const first = employeesOf[tenantA]![0]!;
    const pii = await getEmployeePii(scope(tenantA), hr[tenantA]!, first.id);
    expect(pii.nik?.keyVersion).toBe(1);
    // A version 1 row waits for the job; the service does not re-seal it.
    await expect(
      updateEmployeePii(scope(tenantA), hr[tenantA]!, first.id, {
        bankAccount: "1234567890",
        idempotencyKey: "reseal-pre-1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("[HR-03] a run for tenant A moves only tenant A (tenant B stays version 1 and readable)", async () => {
    const result = await reseal({}, [tenantA]);
    expect(result).toMatchObject({
      tenants: 1,
      employees: 3,
      contracts: 2,
      failedTenants: 0,
      aborted: false,
    });
    expect(await versionCounts(tenantA)).toEqual({
      employeesV1: 0,
      employeesV2: 3,
      contractsV1: 0,
      contractsV2: 2,
    });
    expect(await versionCounts(tenantB)).toEqual({
      employeesV1: 2,
      employeesV2: 0,
      contractsV1: 1,
      contractsV2: 0,
    });
    const b = employeesOf[tenantB]![0]!;
    const pii = await getEmployeePii(scope(tenantB), hr[tenantB]!, b.id);
    expect(pii.nik?.keyVersion).toBe(1);
  });

  it("[HR-03] the full run finishes tenant B; every row is version 2 and readable through the services", async () => {
    const result = await reseal();
    expect(result).toMatchObject({
      tenants: 2,
      employees: 2,
      contracts: 1,
      failedTenants: 0,
      aborted: false,
    });
    for (const tenant of tenants) {
      expect(await versionCounts(tenant)).toMatchObject({
        employeesV1: 0,
        contractsV1: 0,
      });
      for (const employee of employeesOf[tenant]!) {
        const pii = await getEmployeePii(
          scope(tenant),
          hr[tenant]!,
          employee.id,
        );
        if (employee.nik === null) {
          expect(pii.nik).toBeNull();
          continue;
        }
        expect(pii.nik).toEqual({
          masked: `****${employee.nik.slice(-4)}`,
          keyVersion: 2,
        });
        const revealed = await revealEmployeePii(
          scope(tenant),
          hr[tenant]!,
          employee.id,
          ["nik", "bankAccount", "emergencyContactName"],
          "reseal check",
        );
        expect(revealed).toEqual({
          nik: employee.nik,
          bankAccount: employee.bank,
          emergencyContactName: "Budi Santoso",
        });
      }
    }
    const contracts = await listEmploymentContracts(
      scope(tenantA),
      hr[tenantA]!,
      {
        limit: 20,
      },
    );
    expect(contracts.data).toHaveLength(2);
    for (const contract of contracts.data)
      expect(contract.salarySnapshot).toEqual({
        masked: "****0000",
        keyVersion: 2,
      });
    // The row is current again: an update is accepted instead of waiting.
    await updateEmployeePii(
      scope(tenantA),
      hr[tenantA]!,
      employeesOf[tenantA]![0]!.id,
      { bankAccount: "5555566666", idempotencyKey: "reseal-post-1" },
    );
  });

  it("[HR-03] ciphertext keeps its tenant binding after the move", async () => {
    const a = employeesOf[tenantA]![0]!;
    const { rows } = await asOwner(tenantA, (client) =>
      client.query(
        "SELECT nik_encrypted FROM employees WHERE tenant_id = $1 AND id = $2",
        [tenantA, a.id],
      ),
    );
    const sealed = rows[0].nik_encrypted as Buffer;
    const binding: HrisPiiBinding = {
      tenantId: tenantA,
      table: "employees",
      rowId: a.id,
      field: "nik",
    };
    expect(openHrisPii(sealed, binding, 2)).toBe(a.nik);
    expect(() =>
      openHrisPii(sealed, { ...binding, tenantId: tenantB }, 2),
    ).toThrow();
    expect(() => openHrisPii(sealed, binding, 1)).toThrow();
  });

  it("[HR-03] a second run changes nothing", async () => {
    const before = await asOwner(tenantA, (client) =>
      client.query(
        "SELECT id, nik_encrypted, updated_at FROM employees WHERE tenant_id = $1 ORDER BY id",
        [tenantA],
      ),
    );
    const result = await reseal();
    expect(result).toMatchObject({
      employees: 0,
      contracts: 0,
      failedTenants: 0,
    });
    const after = await asOwner(tenantA, (client) =>
      client.query(
        "SELECT id, nik_encrypted, updated_at FROM employees WHERE tenant_id = $1 ORDER BY id",
        [tenantA],
      ),
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("[HR-03] an interrupted run resumes: abort after the first batch, then rerun finishes the rest", async () => {
    await forceAll(1);
    const controller = new AbortController();
    const result = await reseal({
      batchSize: 1,
      signal: controller.signal,
      afterBatch: () => controller.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(result.employees + result.contracts).toBe(1);
    const left = [
      await versionCounts(tenantA),
      await versionCounts(tenantB),
    ].reduce((sum, row) => sum + row.employeesV1 + row.contractsV1, 0);
    expect(left).toBe(5 + 3 - 1);

    const resumed = await reseal({ batchSize: 1 });
    expect(resumed).toMatchObject({ aborted: false, failedTenants: 0 });
    expect(resumed.employees + resumed.contracts).toBe(5 + 3 - 1);
    for (const tenant of tenants)
      expect(await versionCounts(tenant)).toMatchObject({
        employeesV1: 0,
        contractsV1: 0,
      });
    expect(await reseal()).toMatchObject({ employees: 0, contracts: 0 });
  });

  it("[HR-03] a crash after a committed batch keeps that batch; the next run completes", async () => {
    await forceAll(1);
    const errors: string[] = [];
    let batches = 0;
    const result = await reseal({
      batchSize: 1,
      log: { error: (message: string) => errors.push(message) },
      afterBatch: () => {
        batches += 1;
        if (batches === 2) throw new Error("simulated crash");
      },
    });
    expect(result.failedTenants).toBeGreaterThanOrEqual(1);
    expect(errors.join("\n")).not.toContain(KEY2);
    const done = result.employees + result.contracts;
    expect(done).toBeGreaterThanOrEqual(2);
    const resumed = await reseal({ batchSize: 1 });
    expect(resumed.failedTenants).toBe(0);
    expect(done + resumed.employees + resumed.contracts).toBe(5 + 3);
    for (const tenant of tenants)
      expect(await versionCounts(tenant)).toMatchObject({
        employeesV1: 0,
        contractsV1: 0,
      });
  });

  it("[HR-03] tenant listing covers every status, suspended included", async () => {
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      tenantB,
    ]);
    try {
      const ids = await listAllTenantIds();
      expect(ids).toContain(tenantA);
      expect(ids).toContain(tenantB);
      // A suspended tenant is not in the queue role's active registry.
      const active = await owner.query(
        "SELECT id FROM app.active_tenant_registry",
      );
      expect(active.rows.map((row) => String(row.id))).not.toContain(tenantB);
    } finally {
      await owner.query("UPDATE tenants SET status = 'active' WHERE id = $1", [
        tenantB,
      ]);
    }
  });

  it("[HR-03] a row locked by another transaction makes the run incomplete; rerun after release finishes", async () => {
    await forceAll(1);
    const target = employeesOf[tenantA]![0]!;
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantA],
      );
      await holder.query(
        "SELECT id FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantA, target.id],
      );
      const result = await reseal({}, [tenantA]);
      expect(result).toMatchObject({
        failedTenants: 0,
        incompleteTenants: 1,
        aborted: false,
      });
      expect(result.employees).toBe(2);
      expect((await versionCounts(tenantA)).employeesV1).toBe(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const done = await reseal({}, [tenantA]);
    expect(done).toMatchObject({
      employees: 1,
      failedTenants: 0,
      incompleteTenants: 0,
    });
    expect(await versionCounts(tenantA)).toMatchObject({
      employeesV1: 0,
      contractsV1: 0,
    });
    // Tenant B is still version 1 from forceAll; finish it for later tests.
    await reseal({}, [tenantB]);
  });

  describe("queued job", () => {
    type Handler = (jobs: { data: unknown }[]) => Promise<void>;
    async function handler(): Promise<Handler> {
      let work: Handler | undefined;
      await registerHrisPiiResealJob({
        boss: {
          createQueue: async () => {},
          work: async (_name, fn) => {
            work = fn;
          },
        },
        listTenantIds: async () => tenants,
        log: { error: () => {}, info: () => {} },
      });
      return work!;
    }

    it("[HR-03] refuses without writes when targetKeyVersion differs from the worker's version", async () => {
      await forceAll(1);
      const run = await handler();
      await expect(run([{ data: { targetKeyVersion: 1 } }])).rejects.toThrow(
        /targetKeyVersion/,
      );
      await expect(run([{ data: {} }])).rejects.toThrow(/targetKeyVersion/);
      await expect(run([{ data: null }])).rejects.toThrow(/targetKeyVersion/);
      for (const tenant of tenants)
        expect(await versionCounts(tenant)).toMatchObject({
          employeesV2: 0,
          contractsV2: 0,
        });
    });

    it("[HR-03] runs when targetKeyVersion matches the worker's version", async () => {
      const run = await handler();
      await run([{ data: { targetKeyVersion: HRIS_PII_KEY_VERSION } }]);
      for (const tenant of tenants)
        expect(await versionCounts(tenant)).toMatchObject({
          employeesV1: 0,
          contractsV1: 0,
        });
    });

    it("[HR-03] fails the job when a tenant is left incomplete", async () => {
      await forceAll(1);
      const run = await handler();
      const target = employeesOf[tenantA]![0]!;
      const holder = await owner.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
          [tenantA],
        );
        await holder.query(
          "SELECT id FROM employees WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [tenantA, target.id],
        );
        await expect(
          run([{ data: { targetKeyVersion: HRIS_PII_KEY_VERSION } }]),
        ).rejects.toThrow(/incomplete/i);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      await run([{ data: { targetKeyVersion: HRIS_PII_KEY_VERSION } }]);
    });
  });
});
