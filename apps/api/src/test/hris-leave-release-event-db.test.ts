// Leave balance carry-over clamp on release (bead legend-arj.3) and the
// `leave.approved` outbox event, against PostgreSQL with the restricted app
// role (RLS enforced). Expected behaviour comes from the service contract notes
// in hris-leave-request.service.ts and PRD v1.7 §3 Kelompok D 29, F27, §3.7.
//
// Assumptions (the brief leaves them open):
// - Everything runs in calendar year 2031 (carry-over expiry 2031-03-31, leave
//   in June 2031) so no other test file's data collides. Service `now` and the
//   expiry `asOf` are passed explicitly to simulate the later dates.
// - "available" = entitled + carried - used - pending.
// - "No matrix tier matches" is produced by removing every `leave` approval
//   policy for the tenant for the duration of that one test.
// - A rejection after the expiry date is driven by deciding the chain through
//   the approval service at real time and then settling at the later `now`
//   (the chain deadline would otherwise lapse at the simulated time).
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import { roleTemplate } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createLeaveRequest as createLeaveRequestEndpoint,
  decideLeaveRequest as decideLeaveRequestEndpoint,
  expireLeaveCarryOver as expireLeaveCarryOverEndpoint,
  leaveTypeInputSchema,
  type Employee,
} from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { decideApprovalRequest } from "../services/platform-approval.service.ts";
import {
  createEmployee,
  type CreateEmployeeInput,
} from "../services/hris-employee.service.ts";
import {
  createLeaveType,
  expireLeaveCarryOver,
} from "../services/hris-leave.service.ts";
import {
  createLeaveRequest,
  decideLeaveRequest,
  settleLeaveRequest,
} from "../services/hris-leave-request.service.ts";
import { handleHrisApprovalResolved } from "../services/hris-approval-consumers.ts";

// Own tenant, brand, entity and outlets: createEmployee counts seats per tenant
// against `limits.maxActiveEmployees` (QUOTA_EXCEEDED "Kuota paket sudah
// tercapai."), so sharing the fixture tenant with other files that create
// employees concurrently exhausts the quota.
const tenantId = randomUUID();
const outletA = outletIdSchema.parse(randomUUID());
const outletB = outletIdSchema.parse(randomUUID());
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

const randomCode = (prefix: string) =>
  `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const freshNo = () =>
  `T-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const key = () => `hris-db-${randomUUID()}`;

// ---------------------------------------------------------------- fixtures

let hr: string; // tenant-wide: hr.employee.manage + view + hr.leave.approve
let managerA: string; // outlet_manager template at outlet A (the matrix approver)

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
  decideLeaveRequestEndpoint.body.parse({
    action,
    idempotencyKey: key(),
    ...(action === "reject" ? { rejectionReason: "Jadwal penuh" } : {}),
  });

const decideAs = (
  userId: string,
  requestId: string,
  action: "approve" | "reject" | "cancel",
  now?: Date,
) =>
  decideLeaveRequest(
    outletScope(outletA),
    userId,
    requestId as never,
    decisionBody(action),
    { mfaVerified: true },
    now,
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The API bootstrap installs this; these service calls run without the app.
  setAuditWriter(coreAuditWriter);
  const fixture = cafeLegendPlatformFixtures.tenant;
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Leave release tenant', $3, $4, $5, $6, $7, $8)`,
    [
      tenantId,
      `lrel-${tenantId}`,
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
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'lrel', 'Leave release brand')`,
    [brandId, tenantId],
  );
  await sql(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Leave release entity', false)`,
    [entityId, tenantId],
  );
  for (const [index, outletId] of [outletA, outletB].entries())
    await sql(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Leave release outlet', 'Jl. Uji', 'Asia/Jakarta', $6, 'active')`,
      [
        outletId,
        tenantId,
        brandId,
        entityId,
        `LREL-${index + 1}`,
        JSON.stringify(cafeLegendPlatformFixtures.outlets[index].openingHours),
      ],
    );
  const managerRole = roleTemplate("outlet_manager");
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, true, $4, $5, $6, $7)`,
    [
      randomUUID(),
      tenantId,
      managerRole.defaultName,
      managerRole.key,
      JSON.stringify(managerRole.permissions),
      managerRole.mfaRequired,
      JSON.stringify(managerRole.allowedScopeTypes),
    ],
  );
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
  // Matrix approver at outlet B (keeps the fixture symmetric with outlet A).
  await templateActor("outlet_manager", outletB);
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
    await client.query("DELETE FROM hris_idempotency WHERE tenant_id = $1", [
      tenantId,
    ]);
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
  // Leave services write audit_logs rows with outlet_id (FK to outlets), and
  // the table is append-only. Disable the trigger for one purge so the tenant
  // can really be removed (same pattern as floor-test-helpers dropIsolatedTenant);
  // a failure here must be visible, not swallowed.
  {
    const purge = await owner.connect();
    try {
      await purge.query("BEGIN");
      await purge.query(
        "ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_append_only",
      );
      await purge.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
        tenantId,
      ]);
      await purge.query(
        "ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_append_only",
      );
      await purge.query("COMMIT");
    } catch (error) {
      await purge.query("ROLLBACK");
      throw error;
    } finally {
      purge.release();
    }
  }
  for (const statement of [
    "DELETE FROM role_assignments WHERE tenant_id = $1",
    "DELETE FROM outlets WHERE tenant_id = $1",
    "DELETE FROM legal_entities WHERE tenant_id = $1",
    "DELETE FROM brands WHERE tenant_id = $1",
    "DELETE FROM roles WHERE tenant_id = $1",
    "DELETE FROM tenants WHERE id = $1",
  ])
    await owner.query(statement, [tenantId]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [createdUsers]);
  await owner.end();
  await appPool.end();
});

// ------------------------------------------------------------------ helpers

const expiryBody = (asOf: string) =>
  expireLeaveCarryOverEndpoint.body.parse({ asOf });

const EXPIRES_ON = "2031-03-31";
const AFTER_EXPIRY = new Date("2031-04-02T05:00:00Z");
const BEFORE_EXPIRY = new Date("2031-03-30T05:00:00Z");
const EXPIRY_RUN = new Date("2031-04-01T05:00:00Z");
// 2031-06-02 is a Monday: Mon-Wed = 3 leave days, in the future of every
// simulated `now` above.
const LEAVE = ["2031-06-02", "2031-06-04"] as const;

/** Balance with 5 carried days expiring on EXPIRES_ON. */
async function carriedBalance(staff: Staff, leaveTypeId: string) {
  await seedBalance(staff.employee.id, leaveTypeId, 2031, {
    entitled: "12",
    carried: "5",
  });
  await sql(
    `UPDATE leave_balances SET carry_over_expires_on = $4
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2031`,
    [tenantId, staff.employee.id, leaveTypeId, EXPIRES_ON],
  );
}

async function balanceIdOf(employeeId: string, leaveTypeId: string) {
  const rows = await sql<{ id: string }>(
    `SELECT id FROM leave_balances
      WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2031`,
    [tenantId, employeeId, leaveTypeId],
  );
  return rows[0]!.id;
}

const available = (
  balance: NonNullable<Awaited<ReturnType<typeof balanceOf>>>,
) =>
  parseDecimal4(balance.entitled_days) +
  parseDecimal4(balance.carried_over_days) -
  parseDecimal4(balance.used_days) -
  parseDecimal4(balance.pending_days);

async function forfeitAudits(balanceId: string) {
  return sql<{ forfeited: string | null; carried: string | null }>(
    `SELECT event->'maskedChanges'->'after'->>'forfeitedDays' AS forfeited,
            event->'maskedChanges'->'after'->>'carriedOverDays' AS carried
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'hris.leave_carry_over.forfeited'
        AND event->>'objectId' = $2`,
    [tenantId, balanceId],
  );
}

async function leaveApprovedRows(requestId: string) {
  return sql<{
    destination: string;
    aggregate_type: string;
    aggregate_id: string;
    sequence: number;
    event: Record<string, unknown> & { payload: Record<string, unknown> };
  }>(
    `SELECT destination, aggregate_type, aggregate_id::text AS aggregate_id,
            sequence::int AS sequence, event
       FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id::text = $2
        AND event->>'name' = 'leave.approved'
      ORDER BY sequence`,
    [tenantId, requestId],
  );
}

async function withoutLeavePolicy<T>(run: () => Promise<T>): Promise<T> {
  await sql(
    `DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'leave'`,
    [tenantId],
  );
  try {
    return await run();
  } finally {
    await sql(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'leave', NULL, $2, 1)`,
      [tenantId, await roleIdOf("outlet_manager")],
    );
  }
}

// -------------------------------------------------- arj.3 carry-over clamp

describe("legend-arj.3 releasing leave days after carry-over expiry", () => {
  it("cancelling an approved future leave after expiry forfeits the carried days it used, never restores them", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);
    const created = await submit(staff, type.id, LEAVE[0], LEAVE[1]);
    expect((await decideAs(managerA, created.id, "approve")).status).toBe(
      "approved",
    );
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      carried_over_days: "5.0000",
      used_days: "3.0000",
      pending_days: "0.0000",
    });

    // Expiry forfeits the 2 unused carried days; the 3 used ones stay carried.
    await expireLeaveCarryOver(
      tenantScope(),
      hr,
      expiryBody("2031-04-01"),
      EXPIRY_RUN,
    );
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      carried_over_days: "3.0000",
      used_days: "3.0000",
    });
    const balanceId = await balanceIdOf(staff.employee.id, type.id);
    expect(await forfeitAudits(balanceId)).toHaveLength(0);

    const cancelled = await decideAs(
      staff.userId,
      created.id,
      "cancel",
      AFTER_EXPIRY,
    );
    expect(cancelled.status).toBe("cancelled");
    const after = (await balanceOf(staff.employee.id, type.id, 2031))!;
    expect(after).toMatchObject({
      carried_over_days: "0.0000",
      used_days: "0.0000",
      pending_days: "0.0000",
      entitled_days: "12.0000",
    });
    expect(available(after)).toBe(parseDecimal4("12"));
    expect(await forfeitAudits(balanceId)).toEqual([
      { forfeited: "3.0000", carried: "0.0000" },
    ]);
  });

  it("cancelling an approved future leave BEFORE the expiry date leaves carried untouched", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);
    const created = await submit(staff, type.id, LEAVE[0], LEAVE[1]);
    await decideAs(managerA, created.id, "approve");

    const cancelled = await decideAs(
      staff.userId,
      created.id,
      "cancel",
      BEFORE_EXPIRY,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      carried_over_days: "5.0000",
      used_days: "0.0000",
      pending_days: "0.0000",
    });
    expect(
      await forfeitAudits(await balanceIdOf(staff.employee.id, type.id)),
    ).toHaveLength(0);
  });

  it("a pending request cancelled after expiry clamps carried to used", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);
    const created = await submit(staff, type.id, LEAVE[0], LEAVE[1]);
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.pending_days,
    ).toBe("3.0000");

    // The 3 pending days hold 3 carried days; expiry forfeits the other 2.
    await expireLeaveCarryOver(
      tenantScope(),
      hr,
      expiryBody("2031-04-01"),
      EXPIRY_RUN,
    );
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.carried_over_days,
    ).toBe("3.0000");

    await decideAs(staff.userId, created.id, "cancel", AFTER_EXPIRY);
    const after = (await balanceOf(staff.employee.id, type.id, 2031))!;
    expect(after).toMatchObject({
      carried_over_days: "0.0000",
      used_days: "0.0000",
      pending_days: "0.0000",
    });
    expect(available(after)).toBe(parseDecimal4("12"));
    expect(
      await forfeitAudits(await balanceIdOf(staff.employee.id, type.id)),
    ).toEqual([{ forfeited: "3.0000", carried: "0.0000" }]);
  });

  it("a pending request rejected after expiry clamps carried to used (system actor)", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await carriedBalance(staff, type.id);
    // 2 days already used from the carried part; 3 more pending.
    await sql(
      `UPDATE leave_balances SET used_days = 2
        WHERE tenant_id = $1 AND employee_id = $2 AND leave_type_id = $3 AND period_year = 2031`,
      [tenantId, staff.employee.id, type.id],
    );
    const created = await submit(staff, type.id, LEAVE[0], LEAVE[1]);
    const chainId = (
      await sql<{ approval_chain_id: string }>(
        "SELECT approval_chain_id FROM leave_requests WHERE tenant_id = $1 AND id = $2",
        [tenantId, created.id],
      )
    )[0]!.approval_chain_id;

    await expireLeaveCarryOver(
      tenantScope(),
      hr,
      expiryBody("2031-04-01"),
      EXPIRY_RUN,
    );
    expect(
      (await balanceOf(staff.employee.id, type.id, 2031))?.carried_over_days,
    ).toBe("5.0000");

    await decideApprovalRequest(
      base(),
      managerA,
      await openLevelRow(chainId),
      { decision: "rejected", reason: "Tidak sesuai jadwal." },
      { mfaVerified: true, idempotencyKey: null },
    );
    expect(
      await settleLeaveRequest(tenantScope(), created.id, AFTER_EXPIRY),
    ).toBe("rejected");
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      carried_over_days: "2.0000",
      used_days: "2.0000",
      pending_days: "0.0000",
    });
    const rows = await sql(
      `SELECT event->>'actorType' AS actor_type, event->'maskedChanges'->'after'->>'forfeitedDays' AS forfeited
         FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'hris.leave_carry_over.forfeited'
          AND event->>'objectId' = $2`,
      [tenantId, await balanceIdOf(staff.employee.id, type.id)],
    );
    expect(rows).toEqual([{ actor_type: "system", forfeited: "3.0000" }]);
  });
});

// --------------------------------------------------- leave.approved outbox

describe("leave.approved event emission", () => {
  it("approval through the matrix emits exactly one cloud-sync row without personal data", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, LEAVE[0], LEAVE[1]);
    expect(await leaveApprovedRows(created.id)).toHaveLength(0);

    await decideAs(managerA, created.id, "approve");
    const rows = await leaveApprovedRows(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: "cloud-sync",
      aggregate_type: "leave",
      aggregate_id: created.id,
      sequence: 1,
    });
    const envelope = eventEnvelopeSchema.parse(rows[0]!.event);
    expect(envelope.name).toBe("leave.approved");
    expect(envelope.aggregateId).toBe(created.id);
    const payload = rows[0]!.event.payload;
    expect(payload).toMatchObject({
      leaveRequestId: created.id,
      employeeId: staff.employee.id,
      leaveTypeId: type.id,
      decidedBy: managerA,
    });
    const serialized = JSON.stringify(payload);
    expect(Object.keys(payload).join(",")).not.toMatch(/reason|attachment/i);
    expect(serialized).not.toContain("Keperluan keluarga");
    expect(serialized).not.toMatch(/attachment/i);
  });

  it("replaying settle and the approval.resolved consumer does not add a second row", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    const created = await submit(staff, type.id, LEAVE[0], LEAVE[1]);
    const chainId = (await requestRow(created.id)).approval_chain_id!;
    await decideApprovalRequest(
      base(),
      managerA,
      await openLevelRow(chainId),
      { decision: "approved", reason: "Sesuai jadwal." },
      { mfaVerified: true, idempotencyKey: null },
    );
    expect(await leaveApprovedRows(created.id)).toHaveLength(0);

    const event = await resolvedEventOf(chainId);
    await handleHrisApprovalResolved(workerContext, event);
    expect(await leaveApprovedRows(created.id)).toHaveLength(1);

    await handleHrisApprovalResolved(workerContext, event);
    await handleHrisApprovalResolved(workerContext, event);
    expect(await settleLeaveRequest(tenantScope(), created.id)).toBe(
      "approved",
    );
    expect(await settleLeaveRequest(tenantScope(), created.id)).toBe(
      "approved",
    );
    // A repeated approve decision is a replay too.
    await decideAs(managerA, created.id, "approve");
    const rows = await leaveApprovedRows(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sequence).toBe(1);
  });

  // Assumption: the matrix has no "auto-approve" path for leave. A leave
  // request carries no amount, which applies every tier (fail closed), so the
  // only way to skip approval is no policy at all, and that refuses the filing
  // with 409 APPROVAL_POLICY_MISSING. Either way no leave.approved is emitted.
  it("filing with no leave approval policy is refused (409) and emits nothing", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });
    let failed: { status?: number; code?: string } | null = null;
    await withoutLeavePolicy(async () => {
      try {
        await submit(staff, type.id, LEAVE[0], LEAVE[1]);
      } catch (error) {
        failed = error as { status?: number; code?: string };
      }
    });
    expect(failed).toMatchObject({
      status: 409,
      code: "APPROVAL_POLICY_MISSING",
    });
    expect(
      await sql(
        "SELECT id FROM leave_requests WHERE tenant_id = $1 AND employee_id = $2",
        [tenantId, staff.employee.id],
      ),
    ).toHaveLength(0);
    expect(await balanceOf(staff.employee.id, type.id, 2031)).toMatchObject({
      pending_days: "0.0000",
      used_days: "0.0000",
    });
  });

  it("rejected and cancelled requests emit none; cancelling an approved one adds no second row", async () => {
    const type = await makeType();
    const staff = await makeStaff();
    await seedBalance(staff.employee.id, type.id, 2031, { entitled: "12" });

    const rejected = await submit(staff, type.id, "2031-07-07", "2031-07-08");
    await decideAs(managerA, rejected.id, "reject");
    expect((await requestRow(rejected.id)).status).toBe("rejected");
    expect(await leaveApprovedRows(rejected.id)).toHaveLength(0);

    const cancelled = await submit(staff, type.id, "2031-07-14", "2031-07-15");
    await decideAs(staff.userId, cancelled.id, "cancel");
    expect((await requestRow(cancelled.id)).status).toBe("cancelled");
    expect(await leaveApprovedRows(cancelled.id)).toHaveLength(0);

    const approved = await submit(staff, type.id, "2031-07-21", "2031-07-22");
    await decideAs(managerA, approved.id, "approve");
    await decideAs(staff.userId, approved.id, "cancel");
    expect((await requestRow(approved.id)).status).toBe("cancelled");
    expect(await leaveApprovedRows(approved.id)).toHaveLength(1);
  });
});
