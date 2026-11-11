// Shared fixture for the legend-n039 blind-index DB tests (not a test file).
// Builds throwaway tenants with an outlet, an HR actor and helpers that put
// employee and legal-entity rows back into the pre-cutover state (key version
// 1, digests from the legacy raw-data-key HMAC `secrets.blindIndex`).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { blindIndex } from "../lib/secrets.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";

export const fixtureTenant = cafeLegendPlatformFixtures.tenant.id;

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

export const scope = (tenant: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

export async function asOwner<T>(
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

export type Fixture = {
  tenants: string[];
  hr: Record<string, string>;
  outlet: Record<string, string>;
  entity: Record<string, string>;
  users: string[];
  roles: string[];
};

export function newFixture(count = 2): Fixture {
  const tenants = Array.from({ length: count }, () => randomUUID());
  const byTenant = () =>
    Object.fromEntries(tenants.map((tenant) => [tenant, randomUUID()]));
  return {
    tenants,
    hr: {},
    outlet: byTenant(),
    entity: byTenant(),
    users: [],
    roles: [],
  };
}

export async function setupTenants(fx: Fixture, label: string): Promise<void> {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  for (const tenant of fx.tenants) {
    const brand = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, $4, plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `${label}-${tenant.slice(0, 8)}`, fixtureTenant, label],
    );
    await asOwner(tenant, async (client) => {
      await client.query(
        `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand')`,
        [brand, tenant],
      );
      await client.query(
        `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
        [fx.entity[tenant], tenant],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
                 '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
        [fx.outlet[tenant], tenant, brand, fx.entity[tenant]],
      );
    });
    fx.hr[tenant] = await hrActor(fx, tenant);
  }
}

async function hrActor(fx: Fixture, tenant: string): Promise<string> {
  const userId = randomUUID();
  fx.users.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Blind index', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  fx.roles.push(roleId);
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, $5)`,
      [
        roleId,
        tenant,
        `Blind index ${roleId.slice(0, 8)}`,
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

export async function teardown(fx: Fixture): Promise<void> {
  for (const tenant of fx.tenants)
    await asOwner(tenant, async (client) => {
      await client.query("DELETE FROM hris_idempotency WHERE tenant_id = $1", [
        tenant,
      ]);
      await client.query("DELETE FROM employees WHERE tenant_id = $1", [
        tenant,
      ]);
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, fx.users],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, fx.roles],
      );
    });
  for (const tenant of fx.tenants) {
    // Audit rows are append-only and may reference the outlet: keep the
    // tenant in that case (the database is disposable per run).
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
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [fx.users]);
  await owner.end();
}

let counter = 0;
/** A 16-digit NIK that no other row uses. */
export const freshNik = () =>
  `34${String(Date.now()).slice(-8)}${String(800_000 + counter++).padStart(6, "0")}`;
/** A 15-digit NPWP that no other row uses. */
export const freshNpwp = () =>
  `${String(Date.now()).slice(-9)}${String(100_000 + counter++).padStart(6, "0")}`;

export const employeeNo = () =>
  `B-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

export async function seedEmployee(
  fx: Fixture,
  tenant: string,
  nik: string | null,
): Promise<string> {
  const created = await createEmployee(scope(tenant), fx.hr[tenant]!, {
    userId: null,
    legalEntityId: null,
    employeeNo: employeeNo(),
    fullName: "Karyawan Blind Index",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletIdSchema.parse(fx.outlet[tenant]),
    employmentType: "pkwt",
    joinDate: "2026-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
    ...(nik === null ? {} : { pii: { nik } }),
  } as CreateEmployeeInput);
  return created.id;
}

/** Legacy digest of an employee NIK (raw data key, pre-cutover). */
export const legacyNikDigest = (tenant: string, nik: string) =>
  blindIndex(nik, `hris:nik:${tenant.toLowerCase()}`);

/** Puts an employee's NIK index back to the pre-cutover state (v1 digest, version 1). */
export async function forceEmployeeV1(
  tenant: string,
  id: string,
  nik: string,
): Promise<void> {
  await asOwner(tenant, (client) =>
    client.query(
      `UPDATE employees SET nik_hmac = $3, blind_index_version = 1
        WHERE tenant_id = $1 AND id = $2`,
      [tenant, id, legacyNikDigest(tenant, nik)],
    ),
  );
}

/** Legacy digest of a legal-entity NPWP. */
export const legacyNpwpDigest = (tenant: string, npwp: string) =>
  blindIndex(npwp, `legal_entity-npwp:${tenant}`);
