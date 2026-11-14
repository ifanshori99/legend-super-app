// Two collective holidays deleted at the same time must not deadlock.
//
// reverseCollectiveLeaveDeductions takes an advisory lock PER DATE
// (`hris:collective:<tenant>:<date>`), so deleting two different dates runs two
// transactions in parallel. Each one then row-locks the leave balances
// (employee, leave type, year) of the employees it reverses, one by one, in the
// order of the rows its ledger DELETE ... RETURNING hands back. Employees with
// a deduction on both dates share balances: if the two transactions walk those
// balances in opposite orders, they wait on each other (Postgres 40P01).
//
// How the deadlock is provoked: 8 employees, spread over 3 leave types, each
// with a `collective_leave` ledger row on BOTH dates of a round (one deduction
// per employee, date and type, so the same balance row is hit by both
// transactions). The ledger rows of date 1 are inserted in employee order
// e1..e8 and those of date 2 in the reverse order e8..e1, so the heap order
// (which the DELETE ... RETURNING follows) is inverted between the two
// transactions. Without a fixed lock order that is the classic A-B / B-A
// pattern. Ten rounds, each on its own pair of past dates, widen the window.
//
// Expectation (from the contract, not from the code): both deletes succeed, no
// status >= 500, no 40P01 / deadlock text, every deduction row is gone and each
// balance's used_days is back to its value before the deductions. The baseline
// is 5 (not 0) so a double give-back or a clamp at zero cannot hide.
//
// The service functions are called directly (same transaction code the route
// runs) in Promise.all; the HTTP layer adds nothing to the lock order.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { leaveTypeInputSchema, type Employee } from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { deleteHoliday } from "../services/hris-holiday.service.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";

// Private fixtures: this file never touches the shared fixture tenant rows.
const templateTenantId = cafeLegendPlatformFixtures.tenant.id;
const tenantId = tenantIdSchema.parse(randomUUID());
const outletA = outletIdSchema.parse(randomUUID());
const brandId = randomUUID();
const legalEntityId = randomUUID();
const YEAR = 2049;
// 2049-12-20 12:00 WIB: every round date (January to October) is in the past.
const NOW = new Date("2049-12-20T05:00:00Z");
const ROUNDS = 10;
const EMPLOYEES = 8;
const BASE_USED = 5;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

async function sql<R extends Record<string, unknown> = Record<string, string>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client: PoolClient = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as R[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function customUser(permissions: string[]): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'CRACE user', $2)`,
    [userId, `${userId}@example.test`],
  );
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `CRACE role ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, userId, roleId],
  );
  return userId;
}

const key = () => `crace-${randomUUID()}`;
const freshNo = () =>
  `CRC-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

let hr: string;
const typeIds: string[] = [];
const employees: Employee[] = [];

async function leaveType(code: string): Promise<string> {
  const type = await createLeaveType(tenantScope(), hr, {
    ...leaveTypeInputSchema.parse({
      code,
      name: `CRACE ${code}`,
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "0.0000",
        carryOverExpiryMonths: 0,
        tracksBalance: true,
      },
    }),
    idempotencyKey: key(),
  });
  createdTypes.push(type.id);
  return type.id;
}

/** Employee i always uses leave type i % 3: the same balance on both dates. */
const typeOf = (index: number) => typeIds[index % typeIds.length]!;

async function employee(): Promise<Employee> {
  const created = await createEmployee(tenantScope(), hr, {
    userId: null,
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan CRACE",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletA,
    employmentType: "pkwt",
    joinDate: "2040-01-02",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
  return created;
}

/** One `collective_leave` row per listed employee, inserted in this order. */
async function insertDeductions(date: string, order: number[]) {
  await sql(
    `INSERT INTO leave_accruals
       (tenant_id, employee_id, leave_type_id, kind, period, days)
     SELECT $1::uuid, u.emp, u.typ, 'collective_leave', $4::text, '-1'
       FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS u(emp, typ, ord)
      ORDER BY u.ord`,
    [
      tenantId,
      order.map((i) => employees[i]!.id),
      order.map((i) => typeOf(i)),
      date,
    ],
  );
}

async function insertHoliday(date: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO holidays (tenant_id, outlet_id, date, name, type)
     VALUES ($1, $2, $3, $4, 'collective')
     RETURNING id`,
    [tenantId, outletA, date, `CRACE collective ${date}`],
  );
  return row!.id;
}

/** Error text including the driver cause: 40P01 can sit one level down. */
function describeError(reason: unknown): string {
  const parts: string[] = [];
  let current: unknown = reason;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) {
      const extra = current as Error & { code?: string; status?: number };
      parts.push(
        `${current.name}: ${current.message} code=${extra.code ?? ""} status=${extra.status ?? ""}`,
      );
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" | ");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'CRACE tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [tenantId, `crace-${tenantId.slice(0, 8)}`, templateTenantId],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'crace', 'CRACE')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity CRACE', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet CRACE', 'Jl. CRACE', 'Asia/Jakarta', '04:00', '{}', 'active')`,
    [
      outletA,
      tenantId,
      brandId,
      legalEntityId,
      `CRACE-${tenantId.slice(0, 8)}`.toUpperCase(),
    ],
  );
  hr = await customUser(["hr.employee.manage", "hr.employee.view"]);
  for (const code of ["CRACE_A", "CRACE_B", "CRACE_C"])
    typeIds.push(await leaveType(code));
  for (let i = 0; i < EMPLOYEES; i += 1) {
    const created = await employee();
    employees.push(created);
    await sql(
      `INSERT INTO leave_balances
         (tenant_id, employee_id, leave_type_id, period_year, entitled_days, used_days)
       VALUES ($1, $2, $3, $4, '12', '0')`,
      [tenantId, created.id, typeOf(i), YEAR],
    );
  }
}, 60_000);

afterAll(async () => {
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1
         AND leave_type_id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1
         AND leave_type_id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'crace-%'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'CRACE %'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM leave_types WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdTypes],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  // Private tenant rows (children first); the tenant itself last. Best effort,
  // like the other private-tenant tests.
  await owner
    .query("DELETE FROM outlets WHERE tenant_id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM legal_entities WHERE tenant_id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM brands WHERE tenant_id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("deleting two past collective holidays at once", () => {
  it("never deadlocks and gives every day back exactly once, over several rounds", async () => {
    const ascending = employees.map((_, i) => i);
    const descending = [...ascending].reverse();
    for (let round = 1; round <= ROUNDS; round += 1) {
      const month = String(round).padStart(2, "0");
      const first = `${YEAR}-${month}-10`;
      const second = `${YEAR}-${month}-11`;
      const firstId = await insertHoliday(first);
      const secondId = await insertHoliday(second);
      // Opposite ledger (heap) order per date: see the header comment.
      await insertDeductions(first, ascending);
      await insertDeductions(second, descending);
      // Two deductions are in `used` on top of the baseline.
      await sql(
        `UPDATE leave_balances SET used_days = $2
            WHERE tenant_id = $1 AND leave_type_id = ANY($3::uuid[])
              AND period_year = $4`,
        [tenantId, String(BASE_USED + 2), typeIds, YEAR],
      );

      const results = await Promise.allSettled([
        deleteHoliday(tenantScope(), hr, firstId, NOW),
        deleteHoliday(tenantScope(), hr, secondId, NOW),
      ]);

      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [describeError(result.reason)] : [],
      );
      for (const text of failures) {
        expect(text, `round ${round}`).not.toMatch(/deadlock|40P01/i);
        expect(text, `round ${round}`).not.toMatch(/status=5\d\d/);
      }
      expect(failures, `round ${round}`).toEqual([]);

      const left = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM leave_accruals
            WHERE tenant_id = $1 AND period = ANY($2::text[])
              AND kind LIKE 'collective_leave%'`,
        [tenantId, [first, second]],
      );
      expect(left[0]!.n, `round ${round}: ledger rows left`).toBe("0");
      const gone = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM holidays
            WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [firstId, secondId]],
      );
      expect(gone[0]!.n, `round ${round}: holidays left`).toBe("0");
      const balances = await sql<{ employee_id: string; used: string }>(
        `SELECT employee_id, used_days::numeric::text AS used FROM leave_balances
            WHERE tenant_id = $1 AND leave_type_id = ANY($2::uuid[])
              AND period_year = $3`,
        [tenantId, typeIds, YEAR],
      );
      expect(balances).toHaveLength(EMPLOYEES);
      for (const balance of balances)
        expect(
          Number(balance.used),
          `round ${round}: used_days of ${balance.employee_id}`,
        ).toBe(BASE_USED);
    }
  }, 90_000);
});
