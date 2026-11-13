// Carry-over expiry while days are pending (brief 85 item 2), against
// PostgreSQL with the restricted app role (RLS enforced). Expected behaviour
// comes from the service contract notes on `usableCarriedOverDays` and
// `expireLeaveCarryOver` in hris-leave.service.ts.
//
// Scenario from the review: carried days expire on 2029-03-31. On 30 Mar the
// employee files leave that holds part of the carry (pending). On 1 Apr the
// expiry job runs. On 2 Apr the employee files again: the carry not held by
// used or pending days must no longer count, whether or not the job ran.
//
// Assumptions:
// - Everything runs in a private tenant with its own outlet, brand and legal
//   entity, so no other test file's rows collide; service `now` and the
//   expiry `asOf` are passed explicitly.
// - "available" = entitled + carried - used - pending (before expiry).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, userIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { roleTemplate } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createLeaveRequest as createLeaveRequestEndpoint,
  expireLeaveCarryOver as expireLeaveCarryOverEndpoint,
  leaveTypeInputSchema,
  type Employee,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  createLeaveType,
  expireLeaveCarryOver,
} from "../services/hris-leave.service.ts";
import { createLeaveRequest } from "../services/hris-leave-request.service.ts";

const tenantId = randomUUID();
const outletA = outletIdSchema.parse(randomUUID());

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
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

async function sql<R extends Record<string, unknown> = Record<string, string>>(
  text: string,
  params: unknown[] = [],
  tenant: string = tenantId,
): Promise<R[]> {
  return asOwner(
    tenant,
    async (client) => (await client.query(text, params)).rows,
  );
}

async function roleIdOf(templateKey: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function newUser(tenant: string = tenantId): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Leave DB', $2)`,
    [userId, `${userId}@example.test`],
  );
  void tenant;
  return userId;
}

async function assign(
  tenant: string,
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenant,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
    tenant,
  );
}

/** A user holding a custom role with exactly `permissions` at `scope`. */
async function actor(
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  tenant: string = tenantId,
): Promise<string> {
  const userId = await newUser(tenant);
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenant,
      `Leave test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
    tenant,
  );
  await assign(tenant, userId, roleId, scope);
  return userId;
}

/** A user holding a seeded role template (the approver in the matrix). */
async function templateActor(templateKey: string, outletId: string) {
  const userId = await newUser();
  await assign(tenantId, userId, await roleIdOf(templateKey), {
    type: "outlet",
    id: outletId,
  });
  return userId;
}

const randomCode = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const freshNo = () =>
  `T-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const key = () => `hris-db-${randomUUID()}`;

// ---------------------------------------------------------------- fixtures

let hr: string; // tenant-wide: hr.employee.manage + view + hr.leave.approve

type Staff = { userId: string; employee: Employee };

async function makeStaff(
  outletId: string = outletA,
  joinDate = "2026-01-05",
): Promise<Staff> {
  const userId = await actor(["self.leave.request", "self.profile.view"], {
    type: "outlet",
    id: outletId,
  });
  const employee = await createEmployee(tenantScope(), hr, {
    userId: userIdSchema.parse(userId),
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Cuti",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletIdSchema.parse(outletId),
    employmentType: "pkwt",
    joinDate,
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
  return { userId, employee };
}

type PolicyOverrides = {
  annualDays?: string;
  carryOverMaxDays?: string;
  carryOverExpiryMonths?: number;
  tracksBalance?: boolean;
  accrual?: "upfront" | "monthly";
  negativeAllowanceDays?: string;
};

async function makeType(
  policy: PolicyOverrides = {},
  extra: { requiresAttachment?: boolean } = {},
) {
  const input = leaveTypeInputSchema.parse({
    code: randomCode("T1"),
    name: "Cuti uji",
    paid: true,
    requiresAttachment: extra.requiresAttachment ?? false,
    policy: {
      annualDays: "12.0000",
      carryOverMaxDays: "0.0000",
      carryOverExpiryMonths: 0,
      tracksBalance: true,
      accrual: "upfront",
      negativeAllowanceDays: "0.0000",
      ...policy,
    },
  });
  const type = await createLeaveType(tenantScope(), hr, {
    ...input,
    idempotencyKey: randomUUID(),
  });
  createdTypes.push(type.id);
  return type;
}

async function seedBalance(
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
  days: { entitled: string; carried?: string; used?: string; pending?: string },
) {
  await sql(
    `INSERT INTO leave_balances
       (id, tenant_id, employee_id, leave_type_id, period_year,
        entitled_days, carried_over_days, used_days, pending_days, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      randomUUID(),
      tenantId,
      employeeId,
      leaveTypeId,
      periodYear,
      days.entitled,
      days.carried ?? "0",
      days.used ?? "0",
      days.pending ?? "0",
    ],
  );
}

async function balanceOf(
  employeeId: string,
  leaveTypeId: string,
  periodYear: number,
) {
  const rows = await sql<{
    entitled_days: string;
    carried_over_days: string;
    used_days: string;
    pending_days: string;
    expires_on: string | null;
  }>(
    `SELECT entitled_days, carried_over_days, used_days, pending_days,
            to_char(carry_over_expires_on, 'YYYY-MM-DD') AS expires_on
       FROM leave_balances
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
    [tenantId, employeeId, leaveTypeId, periodYear],
  );
  return rows[0] ?? null;
}
function requestBody(
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  extra: { attachmentUploadRef?: string | null; idempotencyKey?: string } = {},
) {
  return createLeaveRequestEndpoint.body.parse({
    leaveTypeId,
    startDate,
    endDate,
    reason: "Keperluan keluarga",
    attachmentUploadRef: extra.attachmentUploadRef ?? null,
    idempotencyKey: extra.idempotencyKey ?? key(),
  });
}

const submitAt = (
  staff: Staff,
  leaveTypeId: string,
  dates: readonly [string, string],
  now: Date,
) =>
  createLeaveRequest(
    outletScope(outletA),
    staff.userId,
    requestBody(leaveTypeId, dates[0], dates[1]),
    now,
  );

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; code?: string };
  }
  throw new Error("Expected the call to fail");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  const fixture = cafeLegendPlatformFixtures.tenant;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Leave carry-expiry isolated tenant', $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      `leave-carry-${tenantId}`,
      fixture.plan,
      fixture.status,
      fixture.deploymentMode,
      JSON.stringify(fixture.featureFlags),
      JSON.stringify(fixture.limits),
      fixture.createdBy,
    ],
  );
  const brandId = randomUUID();
  const entityId = randomUUID();
  await sql(
    `INSERT INTO brands (id, tenant_id, slug, name)
     VALUES ($1, $2, 'leave-carry', 'Leave carry test brand')`,
    [brandId, tenantId],
  );
  await sql(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp)
     VALUES ($1, $2, 'Leave carry test entity', false)`,
    [entityId, tenantId],
  );
  await sql(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'LEAVE-CARRY-1', 'Leave carry test outlet', 'Jl. Uji', 'Asia/Jakarta', $5, 'active')`,
    [
      outletA,
      tenantId,
      brandId,
      entityId,
      JSON.stringify(cafeLegendPlatformFixtures.outlets[0].openingHours),
    ],
  );
  const managerRoleId = randomUUID();
  createdRoles.push(managerRoleId);
  const managerRole = roleTemplate("outlet_manager");
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
    [
      managerRoleId,
      tenantId,
      managerRole.defaultName,
      managerRole.key,
      JSON.stringify(managerRole.permissions),
      managerRole.mfaRequired,
      JSON.stringify(managerRole.allowedScopeTypes),
    ],
  );
  // §3.7 matrix: a leave request goes to the outlet manager, one level.
  await sql(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenantId, await roleIdOf("outlet_manager")],
  );

  hr = await actor(
    ["hr.employee.manage", "hr.employee.view", "hr.leave.approve"],
    { type: "tenant" },
  );
  // The matrix approver at outlet A.
  await templateActor("outlet_manager", outletA);
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(tenantId, async (client) => {
    const mine = `employee_id IN (SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2))`;
    await client.query(
      `DELETE FROM leave_requests WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
      [tenantId, createdUsers, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_accruals WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
      [tenantId, createdUsers, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_balances WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
      [tenantId, createdUsers, createdTypes],
    );
    await client.query(
      `DELETE FROM leave_types WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, createdTypes],
    );
    await client.query(
      `DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'hris-db-%'",
      [tenantId],
    );
    await client.query(
      "UPDATE employees SET manager_id = NULL WHERE tenant_id = $1 AND created_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND created_by = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
      [tenantId],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, createdRoles],
    );
  });
  // The private tenant holds only rows this file made; the database is
  // disposable per run, so a failed cleanup must not fail the suite.
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [tenantId])
    .catch(() => undefined);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
});

// ------------------------------------------------------------------ helpers

const EXPIRES_ON = "2029-03-31";
const MAR_30 = new Date("2029-03-30T05:00:00Z");
const MAR_31 = new Date("2029-03-31T05:00:00Z");
const APR_1 = new Date("2029-04-01T05:00:00Z");
const APR_2 = new Date("2029-04-02T05:00:00Z");
// Mondays in June 2029, after every simulated `now` above.
const WEEK_1 = ["2029-06-04", "2029-06-06"] as const; // Mon-Wed, 3 days
const WEEK_2_THREE = ["2029-06-11", "2029-06-13"] as const; // Mon-Wed, 3 days
const WEEK_2_TWO = ["2029-06-11", "2029-06-12"] as const; // Mon-Tue, 2 days

/** Balance with 2 entitled and 5 carried days; the carry expires on EXPIRES_ON. */
async function carriedBalance(staff: Staff, leaveTypeId: string) {
  await seedBalance(staff.employee.id, leaveTypeId, 2029, {
    entitled: "2",
    carried: "5",
  });
  await sql(
    `UPDATE leave_balances SET carry_over_expires_on = $4
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2029`,
    [tenantId, staff.employee.id, leaveTypeId, EXPIRES_ON],
  );
}

async function expiryLedger(employeeId: string, leaveTypeId: string) {
  return sql<{ days: string }>(
    `SELECT days::text AS days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
        AND kind = 'carry_over_expiry'`,
    [tenantId, employeeId, leaveTypeId],
  );
}

const runExpiry = (asOf: string, now: Date) =>
  expireLeaveCarryOver(
    tenantScope(),
    hr,
    expireLeaveCarryOverEndpoint.body.parse({ asOf }),
    now,
  );

// ------------------------------------------- carry expiry with pending days

describe("brief 85 item 2: expired carry-over is not usable while days are pending", () => {
  it("30 Mar pending, 1 Apr expiry forfeits the unheld carry, 2 Apr cannot spend it", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);

    // 30 Mar: 3 pending days, held by the carried part.
    const first = await submitAt(staff, type.id, WEEK_1, MAR_30);
    expect(first.days).toBe("3.0000");
    expect(await balanceOf(staff.employee.id, type.id, 2029)).toMatchObject({
      carried_over_days: "5.0000",
      pending_days: "3.0000",
    });

    // 1 Apr: the job forfeits carried − (used + pending) = 2 despite pending.
    await runExpiry("2029-04-01", APR_1);
    expect(await balanceOf(staff.employee.id, type.id, 2029)).toMatchObject({
      entitled_days: "2.0000",
      carried_over_days: "3.0000",
      pending_days: "3.0000",
    });
    expect(await expiryLedger(staff.employee.id, type.id)).toEqual([
      { days: "-2.0000" },
    ]);

    // 2 Apr: only the 2 entitled days are left, not 2 + 2 forfeited.
    const refused = await failure(
      submitAt(staff, type.id, WEEK_2_THREE, APR_2),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("INSUFFICIENT_LEAVE_BALANCE");
    const second = await submitAt(staff, type.id, WEEK_2_TWO, APR_2);
    expect(second.days).toBe("2.0000");
    expect(await balanceOf(staff.employee.id, type.id, 2029)).toMatchObject({
      carried_over_days: "3.0000",
      pending_days: "5.0000",
    });

    // A second expiry run claims nothing more.
    await runExpiry("2029-04-01", APR_2);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2029))?.carried_over_days,
    ).toBe("3.0000");
    expect(await expiryLedger(staff.employee.id, type.id)).toHaveLength(1);
  });

  it("2 Apr without the expiry job: available already leaves out the unheld carry", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);
    await submitAt(staff, type.id, WEEK_1, MAR_30);

    const refused = await failure(
      submitAt(staff, type.id, WEEK_2_THREE, APR_2),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("INSUFFICIENT_LEAVE_BALANCE");
    await submitAt(staff, type.id, WEEK_2_TWO, APR_2);
    // Filing writes the unheld carry off itself, once, as the job would.
    expect(await balanceOf(staff.employee.id, type.id, 2029)).toMatchObject({
      carried_over_days: "3.0000",
      pending_days: "5.0000",
    });
    expect(await expiryLedger(staff.employee.id, type.id)).toEqual([
      { days: "-2.0000" },
    ]);

    // The job running later claims nothing more.
    await runExpiry("2029-04-02", APR_2);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2029))?.carried_over_days,
    ).toBe("3.0000");
    expect(await expiryLedger(staff.employee.id, type.id)).toHaveLength(1);
  });

  it("after expiry, small filings cannot reopen the forfeited carry before the job runs", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);

    // 2 Apr, job not run: 2 entitled days left, the 5 carried are forfeit.
    const first = await submitAt(staff, type.id, WEEK_2_TWO, APR_2);
    expect(first.days).toBe("2.0000");
    expect(await balanceOf(staff.employee.id, type.id, 2029)).toMatchObject({
      carried_over_days: "0.0000",
      pending_days: "2.0000",
    });
    expect(await expiryLedger(staff.employee.id, type.id)).toEqual([
      { days: "-5.0000" },
    ]);
    const forfeits = await sql<{ forfeited: string }>(
      `SELECT event->'maskedChanges'->'after'->>'forfeitedDays' AS forfeited
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'hris.leave_carry_over.forfeited'
          AND event->>'objectId' = (SELECT id::text FROM leave_balances
            WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
              AND period_year = 2029)`,
      [tenantId, staff.employee.id, type.id],
    );
    expect(forfeits).toEqual([{ forfeited: "5.0000" }]);

    // The next 2-day filing finds nothing left.
    const refused = await failure(
      submitAt(staff, type.id, ["2029-06-18", "2029-06-19"], APR_2),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("INSUFFICIENT_LEAVE_BALANCE");

    // The job run afterwards is a no-op: one ledger row, carried unchanged.
    await runExpiry("2029-04-02", APR_2);
    expect(await expiryLedger(staff.employee.id, type.id)).toHaveLength(1);
    expect(await balanceOf(staff.employee.id, type.id, 2029)).toMatchObject({
      carried_over_days: "0.0000",
      pending_days: "2.0000",
    });
  });

  it("before the expiry date the whole carry counts; on the expiry date it no longer does", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);
    await submitAt(staff, type.id, WEEK_1, MAR_30);
    // 30 Mar: 2 + 5 − 3 = 4 left, so 3 more days fit.
    await submitAt(staff, type.id, WEEK_2_THREE, MAR_30);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2029))?.pending_days,
    ).toBe("6.0000");

    // 6 pending days hold all 5 carried: the job forfeits nothing.
    await runExpiry("2029-04-01", APR_1);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2029))?.carried_over_days,
    ).toBe("5.0000");
    expect(await expiryLedger(staff.employee.id, type.id)).toEqual([
      { days: "0.0000" },
    ]);

    // 31 Mar is the expiry date: a fresh balance can no longer use its carry.
    const other = await makeStaff();
    await carriedBalance(other, type.id);
    const refused = await failure(submitAt(other, type.id, WEEK_1, MAR_31));
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("INSUFFICIENT_LEAVE_BALANCE");
    expect((await submitAt(other, type.id, WEEK_2_TWO, MAR_31)).days).toBe(
      "2.0000",
    );
  });
});
