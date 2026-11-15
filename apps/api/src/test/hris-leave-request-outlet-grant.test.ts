// legend-lyll9 (architect review legend-bkd76): two outlet-grant gaps in the
// leave request service, against PostgreSQL with the restricted app role (RLS
// enforced). Expected behaviour comes from the card text and the access rules
// in AGENTS.md (authorize against the live grant, never trust a stale scope),
// not from service code:
//  1. A replayed create (same idempotency key) must not hand back a request of
//     ANOTHER outlet than the employee's current home outlet: 403, nothing
//     created, nothing held twice. A replay with an unchanged home outlet still
//     returns the same request (control).
//  2. The requester cancelling their own leave needs a LIVE `self.leave.request`
//     grant at the outlet of the leave. A revoked grant (assignment gone, or
//     moved to another outlet) with a still-valid minted scope is refused 403
//     and the request stays pending with its days held. With a live grant the
//     cancel works (control).
//
// Assumptions:
//  - The refusals are HTTP status 403 (the card names 403 for the replay; the
//    card gives no code for the cancel, 403 is assumed). Only the status is
//    asserted, not the error code.
//  - "Stale scope" is simulated by deleting the requester's role assignment
//    after the request was created, then calling the service with the outlet
//    scope the session minted earlier (the service has no other way to notice).
//  - The employee's home outlet moves by a plain UPDATE of employees.home_outlet_id.
//  - Own private tenant, outlets, leave types and users, year 2037.
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
  decideLeaveRequest as decideLeaveRequestEndpoint,
  leaveTypeInputSchema,
  type Employee,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import { createLeaveType } from "../services/hris-leave.service.ts";
import {
  createLeaveRequest,
  decideLeaveRequest,
} from "../services/hris-leave-request.service.ts";

const tenantId = randomUUID();
const outletA = outletIdSchema.parse(randomUUID());
const outletB = outletIdSchema.parse(randomUUID());
const YEAR = 2037;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];

const base = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const tenantScope = () =>
  establishScopedTenantContext(base(), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

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

async function newUser(): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Leave grant', $2)`,
    [userId, `${userId}@example.test`],
  );
  return userId;
}

async function assign(
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await sql(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

/** Give an existing user a custom role with exactly `permissions` at `scope`. */
async function grant(
  userId: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Leave grant ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await assign(userId, roleId, scope);
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

const freshNo = () =>
  `G-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const key = () => `lgrant-${randomUUID()}`;
const SELF = ["self.leave.request", "self.profile.view"];

let hr: string;
type Staff = { userId: string; employee: Employee };

async function makeStaff(): Promise<Staff> {
  const userId = await newUser();
  await grant(userId, SELF, { type: "outlet", id: outletA });
  const employee = await createEmployee(tenantScope(), hr, {
    userId: userIdSchema.parse(userId),
    legalEntityId: null,
    employeeNo: freshNo(),
    fullName: "Karyawan Grant Cuti",
    positionId: null,
    orgUnitId: null,
    managerId: null,
    homeOutletId: outletIdSchema.parse(outletA),
    employmentType: "pkwt",
    joinDate: "2036-01-05",
    endDate: null,
    ptkpStatus: "TK/0",
    status: "active",
  } as CreateEmployeeInput);
  return { userId, employee };
}

async function makeStaffWithBalance() {
  const staff = await makeStaff();
  const type = await createLeaveType(tenantScope(), hr, {
    ...leaveTypeInputSchema.parse({
      code: `LG_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
      name: "Cuti grant uji",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "12.0000",
        carryOverMaxDays: "0.0000",
        carryOverExpiryMonths: 0,
        tracksBalance: true,
        accrual: "upfront",
        negativeAllowanceDays: "0.0000",
      },
    }),
    idempotencyKey: randomUUID(),
  });
  createdTypes.push(type.id);
  await sql(
    `INSERT INTO leave_balances
       (id, tenant_id, employee_id, leave_type_id, period_year,
        entitled_days, carried_over_days, used_days, pending_days, updated_at)
     VALUES ($1, $2, $3, $4, $5, '12', '0', '0', '0', now())`,
    [randomUUID(), tenantId, staff.employee.id, type.id, YEAR],
  );
  return { staff, type };
}

const pendingOf = async (employeeId: string, leaveTypeId: string) =>
  (
    await sql<{ p: string }>(
      `SELECT pending_days::text AS p FROM leave_balances
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = $4`,
      [tenantId, employeeId, leaveTypeId, YEAR],
    )
  )[0]?.p;

const requestRowsOf = (employeeId: string) =>
  sql<{ id: string; status: string; outlet_id: string }>(
    `SELECT id, status, outlet_id FROM leave_requests
      WHERE tenant_id = $1 AND employee_id = $2 ORDER BY updated_at`,
    [tenantId, employeeId],
  );

const requestBody = (
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  idempotencyKey = key(),
) =>
  createLeaveRequestEndpoint.body.parse({
    leaveTypeId,
    startDate,
    endDate,
    reason: "Keperluan keluarga",
    attachmentUploadRef: null,
    idempotencyKey,
  });

const cancelAs = (userId: string, requestId: string, outletId: string) =>
  decideLeaveRequest(
    outletScope(outletId),
    userId,
    requestId as never,
    decideLeaveRequestEndpoint.body.parse({
      action: "cancel",
      idempotencyKey: key(),
    }),
    { mfaVerified: true },
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  const fixture = cafeLegendPlatformFixtures.tenant;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Leave grant tenant', $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      `lgrant-${tenantId}`,
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
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'lgrant', 'Leave grant brand')`,
    [brandId, tenantId],
  );
  await sql(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Leave grant entity', false)`,
    [entityId, tenantId],
  );
  for (const [index, outletId] of [outletA, outletB].entries())
    await sql(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Leave grant outlet', 'Jl. Uji', 'Asia/Jakarta', $6, 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        entityId,
        `LGRANT-${index + 1}`,
        JSON.stringify(cafeLegendPlatformFixtures.outlets[index].openingHours),
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
  // One-level leave approval by the outlet manager, so a created request is pending.
  await sql(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenantId, managerRoleId],
  );
  for (const outletId of [outletA, outletB]) {
    const managerId = await newUser();
    await assign(managerId, managerRoleId, { type: "outlet", id: outletId });
  }
  hr = await newUser();
  await grant(
    hr,
    ["hr.employee.manage", "hr.employee.view", "hr.leave.approve"],
    {
      type: "tenant",
    },
  );
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
    const mine = `employee_id IN (SELECT id FROM employees WHERE tenant_id = $1 AND created_by = ANY($2))`;
    for (const table of ["leave_requests", "leave_accruals", "leave_balances"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND (${mine} OR leave_type_id = ANY($3::uuid[]))`,
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
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE 'lgrant-%'",
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const statement of [
    "DELETE FROM outlets WHERE tenant_id = $1",
    "DELETE FROM legal_entities WHERE tenant_id = $1",
    "DELETE FROM brands WHERE tenant_id = $1",
  ])
    await owner.query(statement, [tenantId]).catch(() => undefined);
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [tenantId])
    .catch(() => undefined);
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

describe("legend-lyll9: replayed create compares the stored outlet with the employee's home outlet", () => {
  it("control: a replay with an unchanged home outlet returns the same request and holds days once", async () => {
    const { staff, type } = await makeStaffWithBalance();
    const body = requestBody(type.id, `${YEAR}-03-03`, `${YEAR}-03-04`);
    const first = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      body,
    );
    const replay = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      body,
    );
    expect(replay.id).toBe(first.id);
    expect(await pendingOf(staff.employee.id, type.id)).toBe("2.0000");
  });

  it("home outlet moved after the first create: the replay is refused 403, nothing new is created or held", async () => {
    const { staff, type } = await makeStaffWithBalance();
    const body = requestBody(type.id, `${YEAR}-04-07`, `${YEAR}-04-08`);
    const first = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      body,
    );
    expect((await requestRowsOf(staff.employee.id))[0]?.outlet_id).toBe(
      outletA,
    );

    // The employee transfers to outlet B and holds the self grant there.
    await sql(
      "UPDATE employees SET home_outlet_id = $1 WHERE tenant_id = $2 AND id = $3",
      [outletB, tenantId, staff.employee.id],
    );
    await grant(staff.userId, SELF, { type: "outlet", id: outletB });

    const refused = await failure(
      createLeaveRequest(outletScope(outletB), staff.userId, body),
    );
    // Row-level security hides the old outlet's row from the new home scope,
    // so the unique idempotency key refuses the replay with 409; 403 when the
    // row is visible. Either way nothing is handed back or created.
    expect([403, 409]).toContain(refused.status);

    const rows = await requestRowsOf(staff.employee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.id,
      status: "pending",
      outlet_id: outletA,
    });
    expect(await pendingOf(staff.employee.id, type.id)).toBe("2.0000");
  });
});

describe("legend-lyll9: self-cancel needs a live self.leave.request grant at the leave's outlet", () => {
  it("control: with the grant live the requester cancels a pending leave and the hold is released", async () => {
    const { staff, type } = await makeStaffWithBalance();
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, `${YEAR}-05-05`, `${YEAR}-05-06`),
    );
    expect(await pendingOf(staff.employee.id, type.id)).toBe("2.0000");
    const cancelled = await cancelAs(staff.userId, created.id, outletA);
    expect(cancelled.status).toBe("cancelled");
    expect(await pendingOf(staff.employee.id, type.id)).toBe("0.0000");
  });

  it("grant revoked after the request: cancel with the stale scope is 403, the leave stays pending and held", async () => {
    const { staff, type } = await makeStaffWithBalance();
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, `${YEAR}-06-02`, `${YEAR}-06-03`),
    );
    await sql(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, staff.userId],
    );

    const refused = await failure(cancelAs(staff.userId, created.id, outletA));
    expect(refused.status).toBe(403);

    expect((await requestRowsOf(staff.employee.id))[0]?.status).toBe("pending");
    expect(await pendingOf(staff.employee.id, type.id)).toBe("2.0000");
  });

  it("grant exists only at another outlet: cancel of the leave at outlet A is 403 and nothing changes", async () => {
    const { staff, type } = await makeStaffWithBalance();
    const created = await createLeaveRequest(
      outletScope(outletA),
      staff.userId,
      requestBody(type.id, `${YEAR}-07-07`, `${YEAR}-07-08`),
    );
    await sql(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, staff.userId],
    );
    await grant(staff.userId, SELF, { type: "outlet", id: outletB });

    const refused = await failure(cancelAs(staff.userId, created.id, outletA));
    expect(refused.status).toBe(403);

    expect((await requestRowsOf(staff.employee.id))[0]?.status).toBe("pending");
    expect(await pendingOf(staff.employee.id, type.id)).toBe("2.0000");
  });
});
