// Leave types, balances, accrual, carry-over, leave requests and the approval
// matrix against PostgreSQL with the restricted app role (RLS enforced): PRD
// v1.7 §3 Kelompok D 29 "Cuti, Izin & Lembur", F27, §3.7 Matriks Approval,
// TEN-01/02/03; bead legend-hggk (section T1).
//
// Services are called directly with server-minted contexts, like hris-db.test.
// Actors are real users with real role assignments. Rows are verified with the
// owner pool (raw SQL), so the assertions do not depend on a service's own
// read path.
//
// Assumptions (the brief leaves them open):
// - Everything runs in calendar year 2031 (carry-over lands in 2032) so no
//   other test file's data can collide; the services do not reject future
//   periods or dates.
// - A monthly accrual grants the month in which the employee joined (only
//   months strictly before the join date are skipped); the join date used
//   here is the 1st of a month, so the reading is unambiguous.
// - Service functions return contract DTOs (LeaveRequest) directly, lists
//   return `{ data, meta }`, like hris-employee.service.
// - Overlap and missing-attachment refusals are 4xx; the exact code is not
//   specified, so only the status class and "no state change" are asserted.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  formatDecimal4,
  localDateOf,
  outletIdSchema,
  parseDecimal4,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createLeaveRequest as createLeaveRequestEndpoint,
  decideLeaveRequest as decideLeaveRequestEndpoint,
  expireLeaveCarryOver as expireLeaveCarryOverEndpoint,
  leaveTypeInputSchema,
  runLeaveAccrual as runLeaveAccrualEndpoint,
  runLeaveCarryOver as runLeaveCarryOverEndpoint,
  updateLeaveType as updateLeaveTypeEndpoint,
  type Employee,
} from "@starter/shared/hris";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  decideApprovalRequest,
  expireDueApprovalRequests,
} from "../services/platform-approval.service.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  countLeaveDays,
  createLeaveType,
  expireLeaveCarryOver,
  listLeaveBalances,
  runLeaveAccrual,
  runLeaveCarryOver,
  updateLeaveType,
} from "../services/hris-leave.service.ts";
import {
  createLeaveRequest,
  decideLeaveRequest,
  listLeaveRequests,
  settleLeaveRequest,
} from "../services/hris-leave-request.service.ts";
import { handleHrisApprovalResolved } from "../services/hris-approval-consumers.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdTypes: string[] = [];
let savedLeavePolicies: Record<string, unknown>[] = [];

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
/** What the worker hands a consumer: tenant-wide scope minted from the job. */
const workerContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
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

const randomCode = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const freshNo = () =>
  `T-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const key = () => `hris-db-${randomUUID()}`;

// ---------------------------------------------------------------- fixtures

let hr: string; // tenant-wide: hr.employee.manage + view + hr.leave.approve
let managerA: string; // outlet_manager template at outlet A (the matrix approver)
let managerB: string; // outlet_manager template at outlet B
let hrOther: string; // HR of the other tenant

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

async function ledgerOf(employeeId: string, leaveTypeId: string) {
  return sql<{ kind: string; period: string; days: string }>(
    `SELECT kind, period, days FROM leave_accruals
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3
      ORDER BY kind, period`,
    [tenantId, employeeId, leaveTypeId],
  );
}

async function requestRow(id: string) {
  const rows = await sql<{
    status: string;
    days: string;
    decided_by: string | null;
    decided_at: Date | null;
    approval_chain_id: string | null;
    outlet_id: string;
  }>(
    `SELECT status, days, decided_by, decided_at, approval_chain_id, outlet_id
       FROM leave_requests WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return rows[0]!;
}

async function openLevelRow(chainId: string): Promise<string> {
  const rows = await sql<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND chain_id = $2 AND status = 'pending'
      ORDER BY level LIMIT 1`,
    [tenantId, chainId],
  );
  if (!rows[0]) throw new Error("No pending approval level");
  return rows[0].id;
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

const submit = (
  staff: Staff,
  leaveTypeId: string,
  startDate: string,
  endDate: string,
  outletId: string = outletA,
) =>
  createLeaveRequest(
    outletScope(outletId),
    staff.userId,
    requestBody(leaveTypeId, startDate, endDate),
  );

const decisionBody = (action: "approve" | "reject" | "cancel") =>
  decideLeaveRequestEndpoint.body.parse({ action, idempotencyKey: key() });

const decideAs = (
  userId: string,
  requestId: string,
  action: "approve" | "reject" | "cancel",
  outletId: string = outletA,
) =>
  decideLeaveRequest(
    outletScope(outletId),
    userId,
    requestId as never,
    decisionBody(action),
    { mfaVerified: true },
  );

/** The real approval.resolved envelope the approval service appended. */
async function resolvedEventOf(chainId: string): Promise<EventEnvelope> {
  const rows = await sql<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [tenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]?.event);
}

/** A well-formed approval.resolved the database never produced. */
function forgedResolved(input: {
  chainId: string;
  objectId: string;
  requestedBy: string;
  decidedBy: string;
  outlet: string;
  sourceModule?: string;
  objectType?: string;
}): EventEnvelope {
  return approvalResolvedEvent.envelopeSchema.parse({
    id: createUlid(),
    tenantId,
    outletId: input.outlet,
    name: approvalResolvedEvent.name,
    version: approvalResolvedEvent.version,
    aggregateType: approvalResolvedEvent.entry.aggregateType,
    aggregateId: input.chainId,
    sequence: 99,
    occurredAt: new Date().toISOString(),
    actor: { type: "user", id: input.decidedBy },
    deviceId: null,
    idempotencyKey: `forged:${input.chainId}`,
    payloadSchemaRef: approvalResolvedEvent.payloadSchemaRef,
    payload: {
      chainId: input.chainId,
      requestId: input.chainId,
      sourceModule: input.sourceModule ?? "hris_leave",
      actionType: "leave",
      objectType: input.objectType ?? "leave_request",
      objectId: input.objectId,
      source: "user",
      outcome: "approved",
      level: 1,
      requiredLevels: 1,
      requestedBy: input.requestedBy,
      decidedBy: input.decidedBy,
      amountIdr: null,
    },
  }) as EventEnvelope;
}

async function insertHoliday(
  date: string,
  outletId: string | null,
  name: string,
) {
  await sql(
    `INSERT INTO holidays (id, tenant_id, outlet_id, date, name, type, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
    [
      randomUUID(),
      tenantId,
      outletId,
      date,
      name,
      outletId === null ? "national" : "company",
    ],
  );
}

// Accrual helpers mirroring the spec formula (PRD F27): the month-m grant is
// round4(annual*m/12) - round4(annual*(m-1)/12), so 12 months sum to annual.
const round4Share = (annual: string, month: number) =>
  (parseDecimal4(annual) * BigInt(month) + 6n) / 12n;
const monthlyGrant = (annual: string, month: number) =>
  round4Share(annual, month) - round4Share(annual, month - 1);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Leave RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `leave-rls-${otherTenant.slice(0, 8)}`, tenantId],
  );

  // §3.7 matrix: a leave request goes to the outlet manager, one level.
  savedLeavePolicies = await sql(
    `SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
    [tenantId],
  );
  await sql(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
    [tenantId],
  );
  await sql(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'leave', NULL, $2, 1)`,
    [tenantId, await roleIdOf("outlet_manager")],
  );

  hr = await actor(
    ["hr.employee.manage", "hr.employee.view", "hr.leave.approve"],
    { type: "tenant" },
  );
  managerA = await templateActor("outlet_manager", outletA);
  managerB = await templateActor("outlet_manager", outletB);
  hrOther = await actor(
    ["hr.employee.manage", "hr.employee.view", "hr.leave.approve"],
    { type: "tenant" },
    otherTenant,
  );
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
      `DELETE FROM holidays WHERE tenant_id = $1 AND name LIKE 'T1 %'`,
      [tenantId],
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
    for (const row of savedLeavePolicies)
      await client.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.id,
          row.tenant_id,
          row.action_type,
          row.threshold_idr,
          row.approver_role_id,
          row.levels,
          row.requires_distinct_actor,
        ],
      );
  });
  for (const tenant of [tenantId, otherTenant])
    await asOwner(tenant, async (client) => {
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2)",
        [tenant, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2)",
        [tenant, createdRoles],
      );
    });
  // The other tenant only holds a role and no audited rows; the database is
  // disposable per run, so a failed cleanup must not fail the suite.
  await owner
    .query("DELETE FROM tenants WHERE id = $1", [otherTenant])
    .catch(() => undefined);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
  await appPool.end();
});

// ------------------------------------------------------------------ types

describe("legend-hggk leave types (HR manage only)", () => {
  it("HR creates a leave type and a self-service employee is refused with 403", async () => {
    const type = await makeType({ annualDays: "12.0000" });
    expect(type).toMatchObject({ paid: true, isActive: true });
    expect(type.policy.annualDays).toBe("12.0000");
    const staff = await makeStaff();
    const refused = await failure(
      createLeaveType(outletScope(outletA), staff.userId, {
        idempotencyKey: randomUUID(),
        ...leaveTypeInputSchema.parse({
          code: randomCode("T1"),
          name: "Tidak boleh",
          paid: true,
          requiresAttachment: false,
          policy: {
            annualDays: "1.0000",
            carryOverMaxDays: "0.0000",
            carryOverExpiryMonths: 0,
          },
        }),
      }),
    );
    expect(refused.status).toBe(403);
  });

  it("a duplicate code in the same tenant is refused with 409", async () => {
    const type = await makeType();
    const input = leaveTypeInputSchema.parse({
      code: type.code,
      name: "Duplikat",
      paid: true,
      requiresAttachment: false,
      policy: {
        annualDays: "1.0000",
        carryOverMaxDays: "0.0000",
        carryOverExpiryMonths: 0,
      },
    });
    expect(
      (
        await failure(
          createLeaveType(tenantScope(), hr, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
        )
      ).status,
    ).toBe(409);
  });
});

// ---------------------------------------------------------------- accrual

describe("legend-hggk accrual (PRD F27 akrual)", () => {
  it("upfront: grants annual days once per year and a second run grants nothing", async () => {
    const type = await makeType({ annualDays: "12.0000", accrual: "upfront" });
    const staff = await makeStaff();
    const body = runLeaveAccrualEndpoint.body.parse({ period: "2031-01" });

    const first = await runLeaveAccrual(tenantScope(), hr, body);
    expect(first.granted).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      entitled_days: "12.0000",
      used_days: "0.0000",
      pending_days: "0.0000",
    });
    expect(await ledgerOf(staff.employee.id, type.id)).toEqual([
      { kind: "grant", period: "2031", days: "12.0000" },
    ]);

    // Idempotent: the same period again, and another month of the same year.
    const second = await runLeaveAccrual(tenantScope(), hr, body);
    expect(second.granted).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    await runLeaveAccrual(
      tenantScope(),
      hr,
      runLeaveAccrualEndpoint.body.parse({ period: "2031-02" }),
    );
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.entitled_days,
    ).toBe("12.0000");
    expect(await ledgerOf(staff.employee.id, type.id)).toHaveLength(1);
  });

  it("monthly: twelve months sum to exactly the annual days; running a month twice adds nothing", async () => {
    const annual = "10.0000";
    const type = await makeType({ annualDays: annual, accrual: "monthly" });
    const early = await makeStaff(outletA, "2026-01-05");
    // Joined on the 1st of July 2031: months before July grant nothing.
    const late = await makeStaff(outletA, "2031-07-01");

    for (let month = 1; month <= 12; month += 1) {
      const body = runLeaveAccrualEndpoint.body.parse({
        period: `2031-${String(month).padStart(2, "0")}`,
      });
      await runLeaveAccrual(tenantScope(), hr, body);
      if (month === 3)
        // Same month again: no second grant.
        expect((await runLeaveAccrual(tenantScope(), hr, body)).granted).toBe(
          0,
        );
    }

    const ledger = await ledgerOf(early.employee.id, type.id);
    expect(ledger).toHaveLength(12);
    expect(ledger.every((row) => row.kind === "grant")).toBe(true);
    expect(ledger.map((row) => [row.period, parseDecimal4(row.days)])).toEqual(
      Array.from({ length: 12 }, (_, index) => [
        `2031-${String(index + 1).padStart(2, "0")}`,
        monthlyGrant(annual, index + 1),
      ]),
    );
    const total = ledger.reduce(
      (sum, row) => sum + parseDecimal4(row.days),
      0n,
    );
    expect(formatDecimal4(total)).toBe(annual);
    expect(
      (await balanceOf(early.employee.id, type.id, 2031))?.entitled_days,
    ).toBe(annual);

    const lateLedger = await ledgerOf(late.employee.id, type.id);
    expect(lateLedger.map((row) => row.period)).toEqual(
      Array.from(
        { length: 6 },
        (_, index) => `2031-${String(index + 7).padStart(2, "0")}`,
      ),
    );
    expect(
      (await balanceOf(late.employee.id, type.id, 2031))?.entitled_days,
    ).toBe(formatDecimal4(parseDecimal4(annual) - round4Share(annual, 6)));
  });

  it("a leave type without balance tracking (sakit) is never accrued", async () => {
    const type = await makeType({ tracksBalance: false });
    const staff = await makeStaff();
    await runLeaveAccrual(
      tenantScope(),
      hr,
      runLeaveAccrualEndpoint.body.parse({ period: "2031-01" }),
    );
    expect(await ledgerOf(staff.employee.id, type.id)).toEqual([]);
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toBeNull();
  });
});

// --------------------------------------------------------------- carry-over

describe("legend-hggk carry-over and expiry", () => {
  const capped = { used: "4.0000", expectCarried: "5.0000" }; // 12-4=8 -> cap 5
  const below = { used: "9.0000", expectCarried: "3.0000" }; // 12-9=3 -> 3
  // Pending days are undecided: the first run skips this balance (L2) and a
  // later run, once the pending days cleared, carries 12-2=10 -> cap 5.
  const pendingCounts = {
    used: "2.0000",
    pending: "6.0000",
    expectCarried: "5.0000",
  };
  // Carry-over and expiry only accept past dates (L3), so run "in" mid 2032.
  const runNow = new Date("2032-06-01T00:00:00Z");

  let capType: Awaited<ReturnType<typeof makeType>>;
  let noExpiryType: Awaited<ReturnType<typeof makeType>>;
  let c1: Staff;
  let c2: Staff;
  let c3: Staff;

  it("carries min(remaining, max) into next year with an expiry date; capped, pending counted, idempotent", async () => {
    capType = await makeType({
      annualDays: "12.0000",
      carryOverMaxDays: "5.0000",
      carryOverExpiryMonths: 3,
    });
    noExpiryType = await makeType({
      annualDays: "12.0000",
      carryOverMaxDays: "5.0000",
      carryOverExpiryMonths: 0,
    });
    c1 = await makeStaff();
    c2 = await makeStaff();
    c3 = await makeStaff();
    await runLeaveAccrual(
      tenantScope(),
      hr,
      runLeaveAccrualEndpoint.body.parse({ period: "2031-01" }),
    );
    for (const [staff, days] of [
      [c1, capped],
      [c2, below],
      [c3, pendingCounts],
    ] as const)
      await sql(
        `UPDATE leave_balances SET used_days = $4, pending_days = $5
          WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2031`,
        [
          tenantId,
          staff.employee.id,
          capType.id,
          days.used,
          "pending" in days ? days.pending : "0",
        ],
      );

    const body = runLeaveCarryOverEndpoint.body.parse({ fromYear: 2031 });
    const firstRun = await runLeaveCarryOver(tenantScope(), hr, body, runNow);
    expect(firstRun.skipped).toBeGreaterThanOrEqual(1);

    // L2: the balance with pending days got no ledger row and no carry.
    expect(
      (await balanceOf(c3.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBeUndefined();
    expect(
      (await ledgerOf(c3.employee.id, capType.id)).filter(
        (row) => row.kind === "carry_over",
      ),
    ).toHaveLength(0);
    await sql(
      `UPDATE leave_balances SET pending_days = 0
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2031`,
      [tenantId, c3.employee.id, capType.id],
    );
    await runLeaveCarryOver(tenantScope(), hr, body, runNow);

    for (const [staff, days] of [
      [c1, capped],
      [c2, below],
      [c3, pendingCounts],
    ] as const) {
      const next = await balanceOf(staff.employee.id, capType.id, 2032);
      expect(next?.carried_over_days).toBe(days.expectCarried);
      // 1 Jan 2032 + 3 months.
      expect(next?.expires_on).toBe("2032-04-01");
      expect(await ledgerOf(staff.employee.id, capType.id)).toContainEqual(
        expect.objectContaining({ kind: "carry_over", period: "2032" }),
      );
    }
    // Expiry 0 months: the carried days never expire.
    const never = await balanceOf(c1.employee.id, noExpiryType.id, 2032);
    expect(never?.carried_over_days).toBe("5.0000");
    expect(never?.expires_on).toBeNull();

    // Idempotent: even after the source balance changed, a rerun adds nothing.
    await sql(
      `UPDATE leave_balances SET used_days = 0
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2031`,
      [tenantId, c1.employee.id, capType.id],
    );
    await runLeaveCarryOver(tenantScope(), hr, body, runNow);
    await runLeaveCarryOver(tenantScope(), hr, body, runNow);
    expect(
      (await balanceOf(c1.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBe("5.0000");
    expect(
      (await ledgerOf(c1.employee.id, capType.id)).filter(
        (row) => row.kind === "carry_over",
      ),
    ).toHaveLength(1);
  });

  it("expiry forfeits only the unused carried days, not before the expiry date, and runs once", async () => {
    // c1 already consumed 2 of its 5 carried days in 2032 (carried is used first).
    await sql(
      `UPDATE leave_balances SET used_days = 2
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2032`,
      [tenantId, c1.employee.id, capType.id],
    );

    // The day before expiry: nothing is forfeited.
    await expireLeaveCarryOver(
      tenantScope(),
      hr,
      expireLeaveCarryOverEndpoint.body.parse({ asOf: "2032-03-31" }),
      runNow,
    );
    expect(
      (await balanceOf(c1.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBe("5.0000");

    const body = expireLeaveCarryOverEndpoint.body.parse({
      asOf: "2032-04-01",
    });
    await expireLeaveCarryOver(tenantScope(), hr, body, runNow);
    expect(
      (await balanceOf(c1.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBe("2.0000");
    expect(
      (await balanceOf(c2.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBe("0.0000");
    expect(
      (await balanceOf(c3.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBe("0.0000");
    // The never-expiring balance is untouched.
    expect(
      (await balanceOf(c1.employee.id, noExpiryType.id, 2032))
        ?.carried_over_days,
    ).toBe("5.0000");

    await expireLeaveCarryOver(tenantScope(), hr, body, runNow);
    expect(
      (await balanceOf(c1.employee.id, capType.id, 2032))?.carried_over_days,
    ).toBe("2.0000");
    expect(
      (await ledgerOf(c1.employee.id, capType.id)).filter(
        (row) => row.kind === "carry_over_expiry",
      ),
    ).toHaveLength(1);
  });

  it("L3: carry-over refuses a fromYear that is not before the current year; expiry refuses a future asOf (422)", async () => {
    const year = Number(localDateOf(new Date()).slice(0, 4));
    for (const fromYear of [year, year + 1]) {
      const refused = await failure(
        runLeaveCarryOver(
          tenantScope(),
          hr,
          runLeaveCarryOverEndpoint.body.parse({ fromYear }),
        ),
      );
      expect(refused.status).toBe(422);
      expect(refused.code).toBe("VALIDATION_ERROR");
    }
    const refusedExpiry = await failure(
      expireLeaveCarryOver(
        tenantScope(),
        hr,
        expireLeaveCarryOverEndpoint.body.parse({ asOf: `${year + 1}-01-01` }),
      ),
    );
    expect(refusedExpiry.status).toBe(422);
    expect(refusedExpiry.code).toBe("VALIDATION_ERROR");
  });

  it("L3: bounds use the Jakarta business date (02:00 WIB on 2027-03-10 is still 2027-03-09 UTC)", async () => {
    const now = new Date("2027-03-09T19:00:00Z");
    // asOf = Jakarta today is accepted (not a future date).
    await expect(
      expireLeaveCarryOver(
        tenantScope(),
        hr,
        expireLeaveCarryOverEndpoint.body.parse({ asOf: "2027-03-10" }),
        now,
      ),
    ).resolves.toBeDefined();
    const refused = await failure(
      expireLeaveCarryOver(
        tenantScope(),
        hr,
        expireLeaveCarryOverEndpoint.body.parse({ asOf: "2027-03-11" }),
        now,
      ),
    );
    expect(refused.status).toBe(422);
    // New Year's Eve 23:00 UTC is already next year in Jakarta.
    const newYear = new Date("2027-12-31T18:00:00Z");
    const carry = await failure(
      runLeaveCarryOver(
        tenantScope(),
        hr,
        runLeaveCarryOverEndpoint.body.parse({ fromYear: 2028 }),
        newYear,
      ),
    );
    expect(carry.status).toBe(422);
    await expect(
      runLeaveCarryOver(
        tenantScope(),
        hr,
        runLeaveCarryOverEndpoint.body.parse({ fromYear: 2027 }),
        newYear,
      ),
    ).resolves.toBeDefined();
  });

  it("L2: expiry skips a balance with pending days (no ledger row) and forfeits once the pending days cleared", async () => {
    const type = await makeType({
      annualDays: "12.0000",
      carryOverMaxDays: "5.0000",
      carryOverExpiryMonths: 3,
    });
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2036, {
      entitled: "12",
      carried: "5",
      pending: "1",
    });
    await sql(
      `UPDATE leave_balances SET carry_over_expires_on = '2036-04-01'
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2036`,
      [tenantId, staff.employee.id, type.id],
    );
    const asOfNow = new Date("2036-06-01T00:00:00Z");
    const body = expireLeaveCarryOverEndpoint.body.parse({
      asOf: "2036-04-01",
    });
    const first = await expireLeaveCarryOver(tenantScope(), hr, body, asOfNow);
    expect(first.skipped).toBeGreaterThanOrEqual(1);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2036))?.carried_over_days,
    ).toBe("5.0000");
    expect(
      (await ledgerOf(staff.employee.id, type.id)).filter(
        (row) => row.kind === "carry_over_expiry",
      ),
    ).toHaveLength(0);

    await sql(
      `UPDATE leave_balances SET pending_days = 0
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2036`,
      [tenantId, staff.employee.id, type.id],
    );
    await expireLeaveCarryOver(tenantScope(), hr, body, asOfNow);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2036))?.carried_over_days,
    ).toBe("0.0000");
  });
});

// ----------------------------------------------------------- leave requests

describe("legend-hggk leave request through the approval matrix", () => {
  it("request holds days as pending, approval turns pending into used", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });

    const created = await submit(staff, type.id, "2031-03-03", "2031-03-04");
    expect(created).toMatchObject({
      status: "pending",
      days: "2.0000",
      employeeId: staff.employee.id,
    });
    const row = await requestRow(created.id);
    expect(row.approval_chain_id).not.toBeNull();
    expect(row.outlet_id).toBe(outletA);
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "2.0000",
      used_days: "0.0000",
    });

    // The employee is not the approver: the matrix role (outlet manager) is.
    expect(
      (await failure(decideAs(staff.userId, created.id, "approve"))).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await requestRow(created.id)).status).toBe("pending");

    const approved = await decideAs(managerA, created.id, "approve");
    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe(managerA);
    expect(await requestRow(created.id)).toMatchObject({
      status: "approved",
      decided_by: managerA,
    });
    expect((await requestRow(created.id)).decided_at).not.toBeNull();
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
      used_days: "2.0000",
      entitled_days: "12.0000",
    });
  });

  it("rejection releases the pending days and leaves used unchanged", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-04-07", "2031-04-09");
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("3.0000");

    const rejected = await decideAs(managerA, created.id, "reject");
    expect(rejected.status).toBe("rejected");
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
      used_days: "0.0000",
    });
    expect((await requestRow(created.id)).status).toBe("rejected");
  });

  it("the requester cancels a pending request and the pending days are released", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-04-14", "2031-04-15");
    const cancelled = await decideAs(staff.userId, created.id, "cancel");
    expect(cancelled.status).toBe("cancelled");
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("0.0000");
  });

  it("two concurrent requests on a balance that fits only one: exactly one succeeds, the other gets 409 INSUFFICIENT_LEAVE_BALANCE", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "3" });

    const results = await Promise.allSettled([
      submit(staff, type.id, "2031-06-02", "2031-06-03"),
      submit(staff, type.id, "2031-06-09", "2031-06-10"),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const refused = results.find(
      (row): row is PromiseRejectedResult => row.status === "rejected",
    );
    expect(codeOf(refused?.reason)).toBe("INSUFFICIENT_LEAVE_BALANCE");
    expect(statusOf(refused?.reason)).toBe(409);

    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "2.0000",
      used_days: "0.0000",
    });
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM leave_requests
        WHERE tenant_id = $1 AND employee_id = $2`,
      [tenantId, staff.employee.id],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("refuses more days than the balance, honours the negative allowance, and skips balance for untracked types", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "1" });
    const refused = await failure(
      submit(staff, type.id, "2031-07-01", "2031-07-02"),
    );
    expect(refused).toMatchObject({
      code: "INSUFFICIENT_LEAVE_BALANCE",
      status: 409,
    });
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
    });

    const overdraft = await makeType({ negativeAllowanceDays: "1.0000" });
    const overdrawn = await makeStaff();
    await seedBalance(overdrawn.employee.id, overdraft.id, 2031, {
      entitled: "1",
    });
    const allowed = await submit(
      overdrawn,
      overdraft.id,
      "2031-07-01",
      "2031-07-02",
    );
    expect(allowed.status).toBe("pending");
    expect(
      (await balanceOf(overdrawn.employee.id, overdraft.id, 2031))
        ?.pending_days,
    ).toBe("2.0000");

    const sakit = await makeType({ tracksBalance: false });
    const sick = await makeStaff();
    const unlimited = await submit(sick, sakit.id, "2031-07-01", "2031-07-20");
    expect(unlimited).toMatchObject({ status: "pending", days: "20.0000" });
    expect(await balanceOf(sick.employee.id, sakit.id, 2031)).toBeNull();
  });

  it("a replayed create with the same idempotency key returns the same request and holds days once", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const body = requestBody(type.id, "2031-08-04", "2031-08-05");
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
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("2.0000");
  });

  it("invalid ranges are refused without touching the balance: cross-year 422, overlap, missing attachment", async () => {
    const type = await makeType();
    const attachmentType = await makeType({}, { requiresAttachment: true });
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    await seedBalance(staff.employee.id, attachmentType.id, 2031, {
      entitled: "12",
    });

    const crossYear = await failure(
      submit(staff, type.id, "2031-12-30", "2032-01-02"),
    );
    expect(crossYear).toMatchObject({ code: "VALIDATION_ERROR", status: 422 });

    await submit(staff, type.id, "2031-09-01", "2031-09-03");
    const overlap = await failure(
      submit(staff, type.id, "2031-09-03", "2031-09-04"),
    );
    expect(overlap.status).toBeGreaterThanOrEqual(400);
    expect(overlap.status).toBeLessThan(500);

    const noAttachment = await failure(
      submit(staff, attachmentType.id, "2031-10-01", "2031-10-02"),
    );
    expect(noAttachment.status).toBeGreaterThanOrEqual(400);
    expect(noAttachment.status).toBeLessThan(500);

    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("3.0000");
    expect(
      (await balanceOf(staff.employee.id, attachmentType.id, 2031))
        ?.pending_days,
    ).toBe("0.0000");
  });
});

// ----------------------------------------------------------------- holidays

describe("legend-hggk leave type policy, idempotency and system endings", () => {
  it("L1: flipping tracksBalance while a request is pending is 409 LEAVE_TYPE_HAS_PENDING_REQUESTS; allowed once it settled, other edits unaffected", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-09-01", "2031-09-02");
    const flip = (tracksBalance: boolean) =>
      updateLeaveType(
        tenantScope(),
        hr,
        type.id,
        updateLeaveTypeEndpoint.body.parse({
          policy: { ...type.policy, tracksBalance },
          idempotencyKey: randomUUID(),
        }),
      );

    const refused = await failure(flip(false));
    expect(refused.status).toBe(409);
    expect(refused.code).toBe("LEAVE_TYPE_HAS_PENDING_REQUESTS");
    const stored = await sql<{ policy: { tracksBalance: boolean } }>(
      `SELECT policy FROM leave_types WHERE tenant_id = $1 AND id = $2`,
      [tenantId, type.id],
    );
    expect(stored[0]?.policy.tracksBalance).toBe(true);

    // A rename (policy untouched) and a same-value policy are fine meanwhile.
    await updateLeaveType(
      tenantScope(),
      hr,
      type.id,
      updateLeaveTypeEndpoint.body.parse({
        name: "Cuti uji ganti nama",
        idempotencyKey: randomUUID(),
      }),
    );
    await flip(true);

    await decideAs(managerA, created.id, "approve");
    const updated = await flip(false);
    expect(updated.policy.tracksBalance).toBe(false);
  });

  it("L4: two employees filing with the same idempotency key at once: one wins, the other is 409 IDEMPOTENCY_KEY_REUSED, never a 500", async () => {
    const type = await makeType();
    const one = await makeStaff();
    const two = await makeStaff();
    await seedBalance(one.employee.id, type.id, 2031, { entitled: "12" });
    await seedBalance(two.employee.id, type.id, 2031, { entitled: "12" });
    const shared = key();
    const results = await Promise.allSettled([
      createLeaveRequest(
        outletScope(outletA),
        one.userId,
        requestBody(type.id, "2031-09-08", "2031-09-09", {
          idempotencyKey: shared,
        }),
      ),
      createLeaveRequest(
        outletScope(outletA),
        two.userId,
        requestBody(type.id, "2031-09-08", "2031-09-09", {
          idempotencyKey: shared,
        }),
      ),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const refused = results.find(
      (row): row is PromiseRejectedResult => row.status === "rejected",
    );
    expect(codeOf(refused?.reason)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(statusOf(refused?.reason)).toBe(409);
  });

  it("L5: a matrix-expired chain settles as rejected with decidedBy null and decidedAt set; a human rejection keeps its decider", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-09-15", "2031-09-16");
    const chainId = (await requestRow(created.id)).approval_chain_id!;
    await sql(
      `UPDATE approval_requests SET deadline_at = now() - interval '1 hour',
              created_at = now() - interval '2 hours'
        WHERE tenant_id = $1 AND chain_id = $2`,
      [tenantId, chainId],
    );
    await expireDueApprovalRequests(tenantScope());
    expect(await settleLeaveRequest(tenantScope(), created.id)).toBe(
      "rejected",
    );
    const row = await requestRow(created.id);
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toBeNull();
    expect(row.decided_at).not.toBeNull();
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("0.0000");
    expect(
      await sql(
        "SELECT event->>'actorType' AS actor_type, event->>'actorId' AS actor_id FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = 'hris.leave_request.rejected'",
        [tenantId, created.id],
      ),
    ).toEqual([{ actor_type: "system", actor_id: null }]);

    const human = await submit(staff, type.id, "2031-09-22", "2031-09-23");
    await decideAs(managerA, human.id, "reject");
    expect(await requestRow(human.id)).toMatchObject({
      status: "rejected",
      decided_by: managerA,
    });
  });
});

describe("legend-hggk holidays reduce the requested days", () => {
  it("a tenant-wide and an own-outlet holiday are not counted; another outlet's holiday is", async () => {
    // Mon 5 - Fri 9 May 2031 = 5 calendar days.
    await insertHoliday("2031-05-07", null, "T1 Libur nasional");
    await insertHoliday("2031-05-09", outletA, "T1 Libur outlet A");
    await insertHoliday("2031-05-08", outletB, "T1 Libur outlet B");

    const counted = await withTenant(db, tenantScope(), (tx) =>
      countLeaveDays(tx, {
        tenantId,
        outletId: outletA,
        startDate: "2031-05-05",
        endDate: "2031-05-09",
      } as never),
    );
    expect(counted).toBe("3.0000");
    const atB = await withTenant(db, tenantScope(), (tx) =>
      countLeaveDays(tx, {
        tenantId,
        outletId: outletB,
        startDate: "2031-05-05",
        endDate: "2031-05-09",
      } as never),
    );
    expect(atB).toBe("3.0000");

    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-05-05", "2031-05-09");
    expect(created.days).toBe("3.0000");
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("3.0000");
  });

  it("a range made only of holidays has no working days: 422 LEAVE_NO_WORKING_DAYS", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const refused = await failure(
      submit(staff, type.id, "2031-05-07", "2031-05-07"),
    );
    expect(refused).toMatchObject({
      code: "LEAVE_NO_WORKING_DAYS",
      status: 422,
    });
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("0.0000");
  });
});

// ------------------------------------------------------------ balances read

describe("legend-hggk balances are readable by HR and by the employee for their own record only", () => {
  it("HR lists any employee's balance; an employee sees only their own", async () => {
    const type = await makeType();
    const mine = await makeStaff();
    const theirs = await makeStaff();
    await seedBalance(mine.employee.id, type.id, 2031, {
      entitled: "12",
      used: "2",
    });
    await seedBalance(theirs.employee.id, type.id, 2031, { entitled: "7" });

    const asHr = await listLeaveBalances(tenantScope(), hr, {
      year: 2031,
      limit: 100,
    } as never);
    const hrIds = asHr.data.map((row) => row.employeeId);
    expect(hrIds).toContain(mine.employee.id);
    expect(hrIds).toContain(theirs.employee.id);

    const own = await listLeaveBalances(outletScope(outletA), mine.userId, {
      year: 2031,
      limit: 100,
    } as never);
    expect(own.data.map((row) => row.employeeId)).toEqual([mine.employee.id]);
    expect(own.data[0]).toMatchObject({
      entitledDays: "12.0000",
      usedDays: "2.0000",
    });
  });
});

// ---------------------------------------------------- approval.resolved replay

describe("legend-hggk handleHrisApprovalResolved (worker consumer)", () => {
  it("settles an approved chain once; replays are a no-op", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-11-03", "2031-11-04");
    const chainId = (await requestRow(created.id)).approval_chain_id!;

    // The approval service decides; nothing settles the leave request yet.
    await decideApprovalRequest(
      base(),
      managerA,
      await openLevelRow(chainId),
      { decision: "approved", reason: "Sesuai jadwal." },
      { mfaVerified: true, idempotencyKey: null },
    );
    expect((await requestRow(created.id)).status).toBe("pending");

    const event = await resolvedEventOf(chainId);
    await handleHrisApprovalResolved(workerContext, event);
    const settled = await requestRow(created.id);
    expect(settled.status).toBe("approved");
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
      used_days: "2.0000",
    });

    await handleHrisApprovalResolved(workerContext, event);
    await handleHrisApprovalResolved(workerContext, event);
    expect(await requestRow(created.id)).toEqual(settled);
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
      used_days: "2.0000",
    });
  });

  it("a rejected chain releases the days exactly once even when the event is replayed", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-11-10", "2031-11-12");
    const chainId = (await requestRow(created.id)).approval_chain_id!;
    await decideApprovalRequest(
      base(),
      managerA,
      await openLevelRow(chainId),
      { decision: "rejected", reason: "Tim kekurangan orang." },
      { mfaVerified: true, idempotencyKey: null },
    );
    const event = await resolvedEventOf(chainId);
    await handleHrisApprovalResolved(workerContext, event);
    await handleHrisApprovalResolved(workerContext, event);
    expect((await requestRow(created.id)).status).toBe("rejected");
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
      used_days: "0.0000",
    });
  });

  it("a forged approved event for a chain the database still has pending approves nothing; other source modules are ignored", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-11-17", "2031-11-18");
    const chainId = (await requestRow(created.id)).approval_chain_id!;

    for (const decidedBy of [managerA, staff.userId])
      await handleHrisApprovalResolved(
        workerContext,
        forgedResolved({
          chainId,
          objectId: created.id,
          requestedBy: staff.userId,
          decidedBy,
          outlet: outletA,
        }),
      );
    await handleHrisApprovalResolved(
      workerContext,
      forgedResolved({
        chainId,
        objectId: created.id,
        requestedBy: staff.userId,
        decidedBy: managerA,
        outlet: outletA,
        sourceModule: "payment",
        objectType: "order",
      }),
    );
    expect((await requestRow(created.id)).status).toBe("pending");
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "2.0000",
      used_days: "0.0000",
    });
  });
});

// ---------------------------------------------------------------- isolation

describe("legend-hggk tenant and outlet isolation (TEN-01/02/03)", () => {
  it("[TEN-01] another tenant's HR cannot list, decide or settle this tenant's request, and RLS hides every leave table", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-12-01", "2031-12-02");

    const listed = await listLeaveRequests(tenantScope(otherTenant), hrOther, {
      limit: 100,
    } as never);
    expect(listed.data.map((row) => row.id)).not.toContain(created.id);
    const balances = await listLeaveBalances(
      tenantScope(otherTenant),
      hrOther,
      {
        limit: 100,
      } as never,
    );
    expect(balances.data.map((row) => row.employeeId)).not.toContain(
      staff.employee.id,
    );
    expect(
      (
        await failure(
          decideLeaveRequest(
            tenantScope(otherTenant),
            hrOther,
            created.id,
            decisionBody("approve"),
            { mfaVerified: true },
          ),
        )
      ).status,
    ).toBe(404);
    // Settling from the wrong tenant finds nothing (404 or silent no-op).
    await settleLeaveRequest(tenantScope(otherTenant), created.id).catch(
      () => undefined,
    );
    expect((await requestRow(created.id)).status).toBe("pending");
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("2.0000");

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [otherTenant],
      );
      for (const table of [
        "leave_types",
        "leave_balances",
        "leave_accruals",
        "leave_requests",
        "holidays",
      ])
        expect(
          (
            await client.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [
              tenantId,
            ])
          ).rowCount,
          table,
        ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE leave_requests SET status = 'rejected' WHERE id = $1",
            [created.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("[TEN-03] the manager of outlet B cannot list or decide an outlet A request", async () => {
    const type = await makeType();
    const staff = await makeStaff(outletA);
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, "2031-12-08", "2031-12-09");

    const seenByB = await listLeaveRequests(outletScope(outletB), managerB, {
      limit: 100,
    } as never);
    expect(seenByB.data.map((row) => row.id)).not.toContain(created.id);
    const seenByA = await listLeaveRequests(outletScope(outletA), managerA, {
      limit: 100,
    } as never);
    expect(seenByA.data.map((row) => row.id)).toContain(created.id);

    expect(
      (await failure(decideAs(managerB, created.id, "approve", outletB)))
        .status,
    ).toBe(404);
    expect((await requestRow(created.id)).status).toBe("pending");
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("2.0000");

    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)`,
        [tenantId, JSON.stringify([outletB])],
      );
      expect(
        (
          await client.query("SELECT 1 FROM leave_requests WHERE id = $1", [
            created.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            "UPDATE leave_requests SET status = 'rejected' WHERE id = $1",
            [created.id],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
