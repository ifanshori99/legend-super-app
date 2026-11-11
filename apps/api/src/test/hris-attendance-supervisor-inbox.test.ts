// Architect finding F2 item 1 (access, tier K) of branch hris-leave-guard: an
// attendance correction approved through the GENERAL approval inbox
// (POST /api/approvals/:id/decisions) skips the correction endpoint's reach
// check. The approval matrix only checks role + outlet of the approver, so a
// supervisor B of the same outlet could approve the correction of supervisor
// A's report, and the approval.resolved consumer then wrote the valid
// manual_correction log.
//
// Rule (hris-access.ts reachedEmployeeCondition / isReachedEmployee): tenant
// reach and hr.employee.manage see everything in reach; other outlet-scoped
// holders (outlet_manager, supervisor) only their direct reports
// (employees.manager_id = their own employee id).
//
// Contract: when the chain ends approved but its last decider does not reach
// the employee, the correction settles rejected (cause not_supervisor) and no
// log is written. The real supervisor and HR still approve. The inbox decision
// only appends approval.resolved to the outbox; tests have no worker, so the
// real envelope of the chain is delivered to the HRIS consumer.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { handleHrisApprovalResolved } from "../services/hris-approval-consumers.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp();

const KEY_PREFIX = "att-sup-inbox-";
type Client = ReturnType<typeof agent>;

const createdUsers: string[] = [];
const createdEmployees: string[] = [];
const createdCorrections: string[] = [];
let outletId: string;

async function asTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function signedInClient(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  await verifySessionMfa(email);
  return { client, userId };
}

async function templateRoleId(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenant.id, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function assignTemplate(
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  await asTenant((client) =>
    client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenant.id,
        userId,
        roleId,
        scope.type,
        scope.type === "tenant" ? null : scope.id,
      ],
    ),
  );
}

async function grantStaffRole(userId: string) {
  const roleId = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["outlet"]')`,
      [
        roleId,
        tenant.id,
        `Inbox scope staff ${roleId.slice(0, 8)}`,
        JSON.stringify(["self.profile.view", "self.attendance.clock"]),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenant.id, userId, roleId, outletId],
    );
  });
  return roleId;
}

const createdRoles: string[] = [];

async function seedOutlet() {
  const id = randomUUID();
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status, geofence)
       VALUES ($1, $2, $3, $4, $5, 'Outlet inbox supervisor', 'Jl. Absensi', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active', $6)`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `SI-${id.slice(0, 8)}`.toUpperCase(),
        JSON.stringify({ latitude: -6.2, longitude: 106.8, radiusMeters: 100 }),
      ],
    );
  });
  return id;
}

async function seedEmployee(options: {
  userId: string | null;
  managerId: string | null;
  name: string;
}): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await asTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', $7)`,
      [
        id,
        tenant.id,
        options.userId,
        `SI-${id.slice(0, 8).toUpperCase()}`,
        options.name,
        outletId,
        options.managerId,
      ],
    ),
  );
  return id;
}

const post = (client: Client, path: string, body: unknown) =>
  client
    .post(path)
    .set(originHeader)
    .send(body as object);

/** A pending correction with a real approval chain, filed by a report of `managerId`. */
async function requestCorrection(managerId: string) {
  const staff = await signedInClient("Bawahan Inbox Scope");
  createdRoles.push(await grantStaffRole(staff.userId));
  await seedEmployee({
    userId: staff.userId,
    managerId,
    name: "Bawahan Inbox Scope",
  });
  const occurredAt = new Date();
  occurredAt.setUTCDate(occurredAt.getUTCDate() - 3);
  occurredAt.setUTCHours(12, 0, 0, 0);
  const response = await post(
    staff.client,
    "/api/hris/attendance/corrections",
    {
      outletId,
      attendanceLogId: null,
      requestedType: "in",
      requestedOccurredAt: occurredAt.toISOString(),
      reason: "Lupa absen masuk, mesin tidak terbaca",
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
    },
  );
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  const id = response.body.data.id as string;
  createdCorrections.push(id);
  return id;
}

async function pendingInboxRequest(correctionId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT a.id FROM approval_requests a
       JOIN attendance_corrections c ON c.approval_chain_id = a.chain_id
      WHERE a.tenant_id = $1 AND c.id = $2 AND a.status = 'pending'
      ORDER BY a.level LIMIT 1`,
    [tenant.id, correctionId],
  );
  if (!rows[0]) throw new Error("No pending inbox request for the correction");
  return rows[0].id;
}

async function inboxApprove(client: Client, correctionId: string) {
  const response = await post(
    client,
    `/api/approvals/${await pendingInboxRequest(correctionId)}/decisions`,
    { decision: "approved", reason: "Disetujui lewat inbox" },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

/** Delivers the real approval.resolved envelope of the correction's chain. */
async function deliverResolved(correctionId: string): Promise<void> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT o.event FROM domain_event_outbox o
       JOIN attendance_corrections c
         ON o.event->'payload'->>'chainId' = c.approval_chain_id::text
      WHERE o.tenant_id = $1 AND c.id = $2
        AND o.destination = 'cloud-sync'
        AND o.event->>'name' = 'approval.resolved'`,
    [tenant.id, correctionId],
  );
  expect(rows).toHaveLength(1);
  const workerContext = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "job",
    } as Parameters<typeof establishTenantContext>[0]),
    { kind: "tenant" },
  );
  await handleHrisApprovalResolved(
    workerContext,
    eventEnvelopeSchema.parse(rows[0]?.event),
  );
}

async function outcome(correctionId: string) {
  const { rows: status } = await owner.query<{ status: string }>(
    "SELECT status FROM attendance_corrections WHERE tenant_id = $1 AND id = $2",
    [tenant.id, correctionId],
  );
  const { rows: logs } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM attendance_logs
      WHERE tenant_id = $1 AND correction_id = $2 AND method = 'manual_correction'`,
    [tenant.id, correctionId],
  );
  const { rows: causes } = await owner.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'
        AND event::text LIKE '%not_supervisor%'`,
    [tenant.id, correctionId],
  );
  return {
    status: status[0]?.status,
    logs: Number(logs[0]?.n ?? 0),
    notSupervisorCause: Number(causes[0]?.n ?? 0),
  };
}

let supA: Awaited<ReturnType<typeof signedInClient>>;
let supB: Awaited<ReturnType<typeof signedInClient>>;
let hr: Awaited<ReturnType<typeof signedInClient>>;
let empAId: string;
let insertedApprovalPolicy = false;

beforeAll(async () => {
  outletId = await seedOutlet();
  const managerRole = await templateRoleId("outlet_manager");
  const inserted = await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     SELECT $1, 'attendance_correction', NULL, $2, 1
      WHERE NOT EXISTS (SELECT 1 FROM approval_policies
                         WHERE tenant_id = $1 AND action_type = 'attendance_correction')`,
    [tenant.id, managerRole],
  );
  insertedApprovalPolicy = (inserted.rowCount ?? 0) > 0;
  supA = await signedInClient("Supervisor Inbox A");
  supB = await signedInClient("Supervisor Inbox B");
  hr = await signedInClient("HR Inbox Scope");
  for (const supervisor of [supA, supB, hr])
    await assignTemplate(supervisor.userId, managerRole, {
      type: "outlet",
      id: outletId,
    });
  await assignTemplate(hr.userId, await templateRoleId("hr"), {
    type: "tenant",
  });
  empAId = await seedEmployee({
    userId: supA.userId,
    managerId: null,
    name: "Supervisor Inbox A",
  });
  await seedEmployee({
    userId: supB.userId,
    managerId: null,
    name: "Supervisor Inbox B",
  });
}, 120_000);

afterAll(async () => {
  try {
    await owner.query("BEGIN");
    await owner.query("SET LOCAL session_replication_role = replica");
    await owner.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    await owner.query(
      "DELETE FROM attendance_logs WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await owner.query(
      "DELETE FROM attendance_corrections WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.id, outletId],
    );
    await owner.query(
      "DELETE FROM approval_requests WHERE tenant_id = $1 AND requested_by = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    if (insertedApprovalPolicy)
      await owner.query(
        "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'attendance_correction'",
        [tenant.id],
      );
    await owner.query(
      "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
      [tenant.id, `${KEY_PREFIX}%`],
    );
    await owner.query(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1 AND (event->>'objectId' = ANY($2::text[])
           OR event->>'actorId' = ANY($3::text[]))`,
      [tenant.id, createdCorrections, createdUsers],
    );
    await owner.query(
      `DELETE FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->'payload'->>'employeeId' = ANY($2::text[])`,
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdEmployees],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, createdUsers],
    );
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, createdRoles],
    );
    await owner.query("COMMIT");
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }
}, 60_000);

describe("[F2-1] a correction approved through the inbox needs the decider to reach the employee", () => {
  it("rejects (cause not_supervisor, no log) when supervisor B approves supervisor A's report", async () => {
    const correctionId = await requestCorrection(empAId);
    await inboxApprove(supB.client, correctionId);
    await deliverResolved(correctionId);
    expect(await outcome(correctionId)).toEqual({
      status: "rejected",
      logs: 0,
      notSupervisorCause: expect.any(Number),
    });
    expect((await outcome(correctionId)).notSupervisorCause).toBeGreaterThan(0);
  });

  it("approves and writes the log when the real supervisor approves", async () => {
    const correctionId = await requestCorrection(empAId);
    await inboxApprove(supA.client, correctionId);
    await deliverResolved(correctionId);
    expect(await outcome(correctionId)).toEqual({
      status: "approved",
      logs: 1,
      notSupervisorCause: 0,
    });
  });

  it("approves and writes the log when HR (tenant reach) approves any report", async () => {
    const correctionId = await requestCorrection(empAId);
    await inboxApprove(hr.client, correctionId);
    await deliverResolved(correctionId);
    expect(await outcome(correctionId)).toEqual({
      status: "approved",
      logs: 1,
      notSupervisorCause: 0,
    });
  });
});
