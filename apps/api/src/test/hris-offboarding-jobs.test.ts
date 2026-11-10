// Automatic exit clearance against PostgreSQL (bead legend-arj.6, tier K
// access). The worker sweep runs `runScheduledExitClearance` once per tenant
// tick (no day marker) as the SYSTEM actor: every offboarding that is still
// open, not yet revoked and whose last working day is before today (in the
// home outlet's time zone) gets exit clearance, one employee at a time.
//
// Expected behaviour comes from the architect's sub-brief (system actor,
// nil-UUID "who" fields, canAssignRoles = false, error isolation, a blocked exit
// retried at most once per Jakarta day per process), not from the service code.
//
// Assumptions:
//  - Time: the clearance itself reads the real clock, so the tests do not
//    inject `now`. Due dates are fixed past dates (2026-01-15) or relative to
//    the real "today" computed per time zone. The outlet time-zone test uses
//    Pacific/Pago_Pago (UTC-11) against Pacific/Kiritimati (UTC+14): the same
//    calendar date is "today" in one and already past in the other, whatever
//    the clock says (only a midnight crossing within one test could disturb it).
//  - There is no day marker: every run rescans. A blocked exit (Owner or
//    tenant-scoped role) is remembered in a module Map for the rest of the
//    Jakarta day, so every test uses fresh offboarding ids.
//  - Audit rows live in `audit_logs.event` JSON (action, objectId, actorType,
//    actorId); a system actor has actorType "system" and no actorId. The
//    outbox envelope carries `actor.type`.
//  - "Who" columns of a system run hold the nil UUID.
//  - Result lists are filtered to rows created by this file, so a leftover
//    row of another suite cannot decide the outcome.
//  - Case (6) cannot import worker-main (it starts the worker on import), so it
//    checks the startup source for the `setAuditWriter(coreAuditWriter)` call.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { CreateOffboardingInput } from "@starter/shared/hris";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { createOffboarding } from "../services/hris-offboarding.service.ts";
import { runScheduledExitClearance } from "../services/hris-offboarding-jobs.ts";
import {
  createSecondTenant,
  removeSecondTenant,
  type SecondTenant,
} from "./tenant-isolation-harness.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const LAST_DAY = "2026-01-15"; // strictly in the past: due
const FAR_FUTURE = "2034-09-30"; // never due during these tests

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
const createdOffboardings = new Set<string>();
const createdOutlets: string[] = [];
let tenantB: SecondTenant | null = null;
let hr: string;

const workerContext = (tenant: string = tenantId) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tenant, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const sessionContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
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

// ---- fixtures ---------------------------------------------------------------

async function newUser(name = "Exit Jobs"): Promise<string> {
  const userId = randomUUID();
  createdUsers.push(userId);
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [userId, name, `${userId}@example.test`],
  );
  return userId;
}

async function newRole(permissions: string[], scopeTypes: string[]) {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await sql(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Exit jobs test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(scopeTypes),
    ],
  );
  return roleId;
}

async function assignRole(
  userId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const rows = await sql<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)
     RETURNING id`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return rows[0]!.id;
}

async function templateRoleId(templateKey: string) {
  const rows = await sql<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

async function seedOutlet(timezone: string) {
  const id = randomUUID();
  createdOutlets.push(id);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Keluar Otomatis', $7, '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
    [
      id,
      tenantId,
      cafeLegendPlatformFixtures.brand.id,
      cafeLegendPlatformFixtures.legalEntity.id,
      `XJ-${id.slice(0, 8)}`.toUpperCase(),
      `Outlet keluar otomatis ${timezone}`,
      timezone,
    ],
  );
  return id;
}

async function seedEmployee(
  userId: string | null,
  outletId: string,
  tenant: string = tenantId,
) {
  const id = randomUUID();
  createdEmployees.push(id);
  await owner.query(
    `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, $4, 'Karyawan Keluar Otomatis', $5, 'pkwtt', '2025-03-01', 'active')`,
    [id, tenant, userId, `XJ-${id.slice(0, 8).toUpperCase()}`, outletId],
  );
  return id;
}

/** Offboarding through the real service, so the checklist tasks exist too. */
async function newOffboarding(employeeId: string, lastWorkingDate: string) {
  const created = await createOffboarding(sessionContext(), hr, employeeId, {
    exitType: "termination",
    reason: "Akhir hubungan kerja otomatis.",
    lastWorkingDate,
  } as CreateOffboardingInput);
  createdOffboardings.add(created.id);
  return created.id;
}

/** An ordinary leaver: a login with one outlet-scoped role. */
async function makeLeaver(
  outletId: string,
  lastWorkingDate: string = LAST_DAY,
) {
  const userId = await newUser();
  const roleId = await newRole(["self.profile.view"], ["outlet"]);
  const assignmentId = await assignRole(userId, roleId, {
    type: "outlet",
    id: outletId,
  });
  const employeeId = await seedEmployee(userId, outletId);
  const offboardingId = await newOffboarding(employeeId, lastWorkingDate);
  return { userId, employeeId, offboardingId, assignmentId };
}

/** Calendar date "today" in a time zone, for dates relative to the real clock. */
const todayIn = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/** Runs the job like the worker's sweep would. */
const runJob = (tenant: string = tenantId) =>
  runScheduledExitClearance(workerContext(tenant));

const mine = (ids: string[]) => ids.filter((id) => createdOffboardings.has(id));
const mineFailed = (list: { offboardingId: string; code: string }[]) =>
  list.filter((item) => createdOffboardings.has(item.offboardingId));
const byOffboardingId = (
  a: { offboardingId: string },
  b: { offboardingId: string },
) => a.offboardingId.localeCompare(b.offboardingId);

async function offboardingRow(
  offboardingId: string,
  tenant: string = tenantId,
) {
  const rows = await sql<{
    status: string;
    access_revoked_at: string | null;
    access_revoked_by: string | null;
  }>(
    `SELECT status, access_revoked_at::text AS access_revoked_at, access_revoked_by
       FROM hris_offboardings WHERE tenant_id = $1 AND id = $2`,
    [tenant, offboardingId],
    tenant,
  );
  return rows[0]!;
}

async function employeeStatus(employeeId: string, tenant: string = tenantId) {
  const rows = await sql<{ status: string }>(
    "SELECT status FROM employees WHERE tenant_id = $1 AND id = $2",
    [tenant, employeeId],
    tenant,
  );
  return rows[0]!.status;
}

async function assignmentEnded(assignmentId: string) {
  const rows = await sql<{ ended: boolean }>(
    "SELECT valid_until IS NOT NULL AS ended FROM role_assignments WHERE tenant_id = $1 AND id = $2",
    [tenantId, assignmentId],
  );
  return rows[0]!.ended;
}

const auditRows = (objectId: string, action: string) =>
  sql<{ actor_type: string | null; actor_id: string | null }>(
    `SELECT event->>'actorType' AS actor_type, event->>'actorId' AS actor_id
       FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = $3`,
    [tenantId, objectId, action],
  );

async function cancelOffboarding(offboardingId: string) {
  await sql(
    `UPDATE hris_offboardings
        SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3, cancel_reason = 'Batal'
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, offboardingId, hr],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  hr = await newUser("Exit Jobs HR");
  const hrRole = await newRole(
    ["hr.employee.manage", "hr.employee.view"],
    ["tenant"],
  );
  await assignRole(hr, hrRole, { type: "tenant" });
}, 60_000);

// Offboardings are removed after each case so a later run never sees the
// leftovers (the Owner leaver, for instance, stays open on purpose).
afterEach(async () => {
  const ids = [...createdOffboardings];
  const tenants = [tenantId, ...(tenantB ? [tenantB.tenantId] : [])];
  for (const tenant of tenants) {
    await sql(
      `DELETE FROM hris_checklist_task_actions WHERE tenant_id = $1 AND task_id IN
         (SELECT id FROM hris_checklist_tasks WHERE tenant_id = $1 AND offboarding_id = ANY($2::uuid[]))`,
      [tenant, ids],
      tenant,
    );
    await sql(
      "DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND offboarding_id = ANY($2::uuid[])",
      [tenant, ids],
      tenant,
    );
    await sql(
      "DELETE FROM hris_offboardings WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant, ids],
      tenant,
    );
  }
  createdOffboardings.clear();
});

afterAll(async () => {
  setAuditWriter(null);
  await asOwner(tenantId, async (client) => {
    await client.query(
      "DELETE FROM hris_checklist_tasks WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM hris_offboardings WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdEmployees],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUsers],
    );
    await client.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, createdRoles],
    );
    // Outlets stay: audit_logs is append-only and may reference them
    // (disposable database), as in hris-offboarding-clearance.test.ts.
  });
  if (tenantB) {
    await owner.query("DELETE FROM hris_checklist_tasks WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM hris_offboardings WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    await owner.query("DELETE FROM employees WHERE tenant_id = $1", [
      tenantB.tenantId,
    ]);
    // Revoked rows leave append-only audit rows in tenant B; the disposable
    // database is dropped after the run, so a failed teardown is harmless.
    await removeSecondTenant(owner, tenantB).catch(() => undefined);
  }
  await owner
    .query('DELETE FROM "user" WHERE id = ANY($1::text[])', [createdUsers])
    .catch(() => undefined);
  await owner.end();
});

// ---- (1) and (2): due and not due -------------------------------------------

describe("exit clearance job: due exits", () => {
  it("[legend-arj.6] revokes an employee past the last working day once, even when the job runs twice", async () => {
    const outlet = await seedOutlet("Asia/Jakarta");
    const leaver = await makeLeaver(outlet);

    const first = await runJob();
    expect(first.ran).toBe(true);
    expect(mine(first.revoked)).toEqual([leaver.offboardingId]);
    expect(mineFailed(first.failed)).toEqual([]);
    expect(await offboardingRow(leaver.offboardingId)).toMatchObject({
      status: "revoked",
    });
    expect(await employeeStatus(leaver.employeeId)).toBe("terminated");
    expect(await assignmentEnded(leaver.assignmentId)).toBe(true);
    const before = await offboardingRow(leaver.offboardingId);
    expect(
      await auditRows(leaver.offboardingId, "hris.offboarding.access_revoked"),
    ).toHaveLength(1);

    // The next tick rescans: the revoked exit is not a candidate any more.
    const second = await runJob();
    expect(mine(second.revoked)).toEqual([]);
    expect(await offboardingRow(leaver.offboardingId)).toEqual(before);
    expect(
      await auditRows(leaver.offboardingId, "hris.offboarding.access_revoked"),
    ).toHaveLength(1);
    expect(
      await auditRows(leaver.assignmentId, "role_assignment.ended"),
    ).toHaveLength(1);
  }, 60_000);

  it("[legend-arj.6] an exit whose last working day is today or later is left open", async () => {
    const outlet = await seedOutlet("Asia/Jakarta");
    const today = await makeLeaver(outlet, todayIn("Asia/Jakarta"));
    const future = await makeLeaver(outlet, FAR_FUTURE);

    const result = await runJob();
    expect(mine(result.revoked)).toEqual([]);
    expect(mineFailed(result.failed)).toEqual([]);
    for (const leaver of [today, future]) {
      expect(await offboardingRow(leaver.offboardingId)).toMatchObject({
        status: "open",
        access_revoked_at: null,
      });
      expect(await employeeStatus(leaver.employeeId)).toBe("active");
      expect(await assignmentEnded(leaver.assignmentId)).toBe(false);
    }
  }, 60_000);

  it("[legend-arj.6] 'today' follows the home outlet's time zone", async () => {
    // One calendar date: still today in UTC-11, already past in UTC+14.
    const lastDay = todayIn("Pacific/Pago_Pago");
    const west = await makeLeaver(
      await seedOutlet("Pacific/Pago_Pago"),
      lastDay,
    );
    const east = await makeLeaver(
      await seedOutlet("Pacific/Kiritimati"),
      lastDay,
    );

    const result = await runJob();
    expect(mine(result.revoked)).toEqual([east.offboardingId]);
    expect(await offboardingRow(east.offboardingId)).toMatchObject({
      status: "revoked",
    });
    expect(await offboardingRow(west.offboardingId)).toMatchObject({
      status: "open",
      access_revoked_at: null,
    });
    expect(await employeeStatus(west.employeeId)).toBe("active");
  }, 60_000);

  it("[legend-arj.6] a cancelled exit is not cleared", async () => {
    const leaver = await makeLeaver(await seedOutlet("Asia/Jakarta"));
    await cancelOffboarding(leaver.offboardingId);

    const result = await runJob();
    expect(mine(result.revoked)).toEqual([]);
    expect(mineFailed(result.failed)).toEqual([]);
    expect(await offboardingRow(leaver.offboardingId)).toMatchObject({
      status: "cancelled",
    });
    expect(await employeeStatus(leaver.employeeId)).toBe("active");
    expect(await assignmentEnded(leaver.assignmentId)).toBe(false);
  }, 60_000);
});

// ---- (3) system actor -------------------------------------------------------

describe("exit clearance job: system actor", () => {
  it("[legend-arj.6] records the system actor in audit, outbox and the who-columns", async () => {
    const leaver = await makeLeaver(await seedOutlet("Asia/Jakarta"));

    const result = await runJob();
    expect(mine(result.revoked)).toEqual([leaver.offboardingId]);

    expect(
      await auditRows(leaver.offboardingId, "hris.offboarding.access_revoked"),
    ).toEqual([{ actor_type: "system", actor_id: null }]);
    // The role assignment ended by the job is audited as the system too.
    expect(
      await auditRows(leaver.assignmentId, "role_assignment.ended"),
    ).toEqual([{ actor_type: "system", actor_id: null }]);
    const events = await sql<{ actor_type: string | null }>(
      `SELECT event->'actor'->>'type' AS actor_type FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'role_assignment.ended'
          AND event::text LIKE '%' || $2 || '%'`,
      [tenantId, leaver.assignmentId],
    );
    expect(events).toEqual([{ actor_type: "system" }]);

    // "Who" columns hold the nil UUID, never a real user.
    expect(await offboardingRow(leaver.offboardingId)).toMatchObject({
      access_revoked_by: NIL_UUID,
    });
    const tasks = await sql<{ done_by: string | null }>(
      `SELECT done_by FROM hris_checklist_tasks
        WHERE tenant_id = $1 AND offboarding_id = $2 AND category = 'access_revocation'`,
      [tenantId, leaver.offboardingId],
    );
    expect(tasks).toEqual([{ done_by: NIL_UUID }]);
  }, 60_000);
});

// ---- (4) error isolation ----------------------------------------------------

describe("exit clearance job: leavers that need a human", () => {
  it("[legend-arj.6] an Owner leaver and a tenant-role leaver fail and stay open while the others are revoked", async () => {
    const outlet = await seedOutlet("Asia/Jakarta");
    const ownerUser = await newUser("Exit Jobs Owner");
    const ownerAssignment = await assignRole(
      ownerUser,
      await templateRoleId("owner"),
      { type: "tenant" },
    );
    const ownerEmployee = await seedEmployee(ownerUser, outlet);
    const ownerExit = await newOffboarding(ownerEmployee, LAST_DAY);

    const adminUser = await newUser("Exit Jobs Admin");
    const adminAssignment = await assignRole(
      adminUser,
      await newRole(["hr.employee.view"], ["tenant"]),
      { type: "tenant" },
    );
    const adminEmployee = await seedEmployee(adminUser, outlet);
    const adminExit = await newOffboarding(adminEmployee, LAST_DAY);

    // Ordinary leavers: the failures must not stop them, whatever the order.
    const others = [await makeLeaver(outlet), await makeLeaver(outlet)];

    const result = await runJob();

    expect(mine(result.revoked).sort()).toEqual(
      others.map((leaver) => leaver.offboardingId).sort(),
    );
    expect(mineFailed(result.failed).sort(byOffboardingId)).toEqual(
      [
        { offboardingId: ownerExit, code: "OFFBOARDING_OWNER" },
        { offboardingId: adminExit, code: "OFFBOARDING_ADMIN_ROLE" },
      ].sort(byOffboardingId),
    );
    expect(mineFailed(result.skipped)).toEqual([]);

    // The refused rows changed nothing: still open, access intact.
    for (const [exit, employee, assignment] of [
      [ownerExit, ownerEmployee, ownerAssignment],
      [adminExit, adminEmployee, adminAssignment],
    ] as const) {
      expect(await offboardingRow(exit)).toMatchObject({
        status: "open",
        access_revoked_at: null,
      });
      expect(await employeeStatus(employee)).toBe("active");
      expect(await assignmentEnded(assignment)).toBe(false);
      expect(
        await auditRows(exit, "hris.offboarding.access_revoked"),
      ).toHaveLength(0);
    }
    for (const leaver of others) {
      expect(await offboardingRow(leaver.offboardingId)).toMatchObject({
        status: "revoked",
      });
      expect(await assignmentEnded(leaver.assignmentId)).toBe(true);
    }
  }, 90_000);

  it("[legend-arj.6] an exit that becomes due after a clean run is revoked by the next run the same day", async () => {
    const outlet = await seedOutlet("Asia/Jakarta");
    const early = await makeLeaver(outlet);
    const firstRun = await runJob();
    expect(mine(firstRun.revoked)).toEqual([early.offboardingId]);
    expect(firstRun.ran).toBe(true);

    // HR files another exit whose last day is already past, after that run.
    const late = await makeLeaver(outlet);
    const secondRun = await runJob();
    expect(secondRun.ran).toBe(true);
    expect(mine(secondRun.revoked)).toEqual([late.offboardingId]);
    expect(await offboardingRow(late.offboardingId)).toMatchObject({
      status: "revoked",
    });
    expect(await employeeStatus(late.employeeId)).toBe("terminated");
  }, 60_000);

  it("[legend-arj.6] a blocked Owner exit is reported once, not retried on the next run, and others are still processed", async () => {
    const outlet = await seedOutlet("Asia/Jakarta");
    const ownerUser = await newUser("Exit Jobs Owner Retry");
    const ownerAssignment = await assignRole(
      ownerUser,
      await templateRoleId("owner"),
      { type: "tenant" },
    );
    const ownerEmployee = await seedEmployee(ownerUser, outlet);
    const ownerExit = await newOffboarding(ownerEmployee, LAST_DAY);

    const run1 = await runJob();
    expect(mineFailed(run1.failed)).toEqual([
      { offboardingId: ownerExit, code: "OFFBOARDING_OWNER" },
    ]);

    // A later exit of an ordinary employee is still handled on run 2, while the
    // blocked one is left alone (not listed in failed again).
    const other = await makeLeaver(outlet);
    const run2 = await runJob();
    expect(mine(run2.revoked)).toEqual([other.offboardingId]);
    expect(mineFailed(run2.failed)).toEqual([]);
    expect(mineFailed(run2.skipped)).toEqual([]);

    expect(await offboardingRow(ownerExit)).toMatchObject({
      status: "open",
      access_revoked_at: null,
    });
    expect(await employeeStatus(ownerEmployee)).toBe("active");
    expect(await assignmentEnded(ownerAssignment)).toBe(false);
    expect(
      await auditRows(ownerExit, "hris.offboarding.access_revoked"),
    ).toHaveLength(0);
  }, 90_000);
});

// ---- (5) tenant isolation ---------------------------------------------------

describe("exit clearance job: tenant isolation", () => {
  async function dueInTenantB(second: SecondTenant) {
    const employeeId = await seedEmployee(
      null,
      second.outletId,
      second.tenantId,
    );
    const rows = await sql<{ id: string }>(
      `INSERT INTO hris_offboardings
         (tenant_id, employee_id, exit_type, reason, last_working_date, created_by)
       VALUES ($1, $2, 'termination', 'Akhir hubungan kerja tenant B.', $3, $4)
       RETURNING id`,
      [second.tenantId, employeeId, LAST_DAY, randomUUID()],
      second.tenantId,
    );
    createdOffboardings.add(rows[0]!.id);
    return { employeeId, offboardingId: rows[0]!.id };
  }

  it("[legend-arj.6] running for tenant A leaves tenant B's due exit alone, and the other way round", async () => {
    tenantB ??= await createSecondTenant(owner, "exitjob");
    const second = tenantB;
    const outlet = await seedOutlet("Asia/Jakarta");
    const a = await makeLeaver(outlet);
    const b = await dueInTenantB(second);

    const forA = await runJob(tenantId);
    expect(mine(forA.revoked)).toEqual([a.offboardingId]);
    expect(
      await offboardingRow(b.offboardingId, second.tenantId),
    ).toMatchObject({ status: "open", access_revoked_at: null });
    expect(await employeeStatus(b.employeeId, second.tenantId)).toBe("active");

    // A fresh due exit in A, then run for B only.
    const a2 = await makeLeaver(outlet);
    const forB = await runJob(second.tenantId);
    expect(mine(forB.revoked)).toEqual([b.offboardingId]);
    expect(
      await offboardingRow(b.offboardingId, second.tenantId),
    ).toMatchObject({ status: "revoked", access_revoked_by: NIL_UUID });
    expect(await offboardingRow(a2.offboardingId)).toMatchObject({
      status: "open",
      access_revoked_at: null,
    });
    expect(await employeeStatus(a2.employeeId)).toBe("active");
    expect(await assignmentEnded(a2.assignmentId)).toBe(false);
  }, 90_000);
});

// ---- (6) worker wiring ------------------------------------------------------

describe("exit clearance job: worker wiring", () => {
  it("[legend-arj.6] the worker installs the core audit writer and runs the job in its sweep", () => {
    // worker-main starts the worker on import, so its source is checked.
    // Without the audit writer every audited write in the worker fails closed.
    const source = readFileSync(
      new URL("../worker-main.ts", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(source).toMatch(/setAuditWriter\(\s*coreAuditWriter\s*\)/);
    expect(source).toMatch(/runScheduledExitClearance\(\s*context\s*\)/);
  });
});
