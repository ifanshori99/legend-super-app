// legend-ijcxc (tier K, access): PATCH /api/hris/employees/:employeeId/manager must also be
// serialized with changes to (a) the custom `roles` row that grants the caller
// hr.employee.manage, and (b) the target employee's own role assignments (the role rule:
// a non-junior employee needs a non-junior manager). A permission revoked or a role
// re-activated by a concurrent transaction may not slip in between the final check and the
// write. Follow-up of legend-c79uy (hris-employee-manager-authz-lock.test.ts, which only
// covers revoking the actor's role_assignments row).
//
// Written from the card text and the HTTP contract the neighbouring tests exercise
// (HR with hr.employee.manage at tenant scope may call it; a visible-but-forbidden actor
// gets 403 FORBIDDEN; a junior manager for a supervisor gets 422 MANAGER_ROLE_TOO_LOW;
// a rejected call writes no manager_id and no audit row), not from the implementation.
//
// How the race is made deterministic (no sleeps for ordering): a separate transaction makes
// an UNCOMMITTED change to the row in question and stays open. The request is sent. A plain
// (non-locking) read cannot see the uncommitted change, so a service that does not lock the
// row answers 200 and settles. A service that locks the row (FOR SHARE or stronger) is
// really blocked by the transaction (pg_blocking_pids). The test waits until the request has
// either settled or is blocked, and only then commits the change. A correct service re-reads
// after the commit and refuses; the buggy one has already written.
//
// Assumptions:
// - "Lock" means a row lock that conflicts with an UPDATE of the row (FOR SHARE or
//   stronger); the test change is a normal UPDATE (a non-key column).
// - The actor keeps a second, view-only role, so after the revoke the employee stays
//   visible and the answer is 403 FORBIDDEN (not 404).
// - A target with an expired supervisor assignment counts as junior (see
//   hris-employee-manager-change.test.ts: "an expired senior assignment no longer makes the
//   employee non-junior"); re-activating it (valid_until NULL) makes the target non-junior.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import type { ObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 5,
});
const storageRuntime: StorageRuntime = {
  storage: {} as ObjectStorage,
  scanner: new NoopMalwareScanner(),
  fileSigner: async (_context, objectId) =>
    `https://signed.example.test/file/${objectId}`,
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime });

type Client = ReturnType<typeof agent>;
type Res = Awaited<ReturnType<Client["get"]>>;

const ACTION = "hris.employee_manager_change";
const KEY_PREFIX = "mgr-role-rows-lock-";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createdUsers: string[] = [];
const createdRoles: string[] = [];
const createdEmployees: string[] = [];
let outletId: string;

async function inTenant<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await work(client);
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

async function newUserId(name: string): Promise<string> {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUsers.push(userId);
  return userId;
}

/** Custom tenant-scope role; returns the roles row id. */
async function grantTenantRole(
  userId: string,
  permissions: string[],
): Promise<string> {
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await inTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        `Role rows lock ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (id, tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, 'tenant', NULL, now() - interval '1 hour', $3)`,
      [randomUUID(), tenant.id, userId, roleId],
    );
  });
  return roleId;
}

const templateRoleIds = new Map<string, string>();
async function templateRole(key: string): Promise<string> {
  const cached = templateRoleIds.get(key);
  if (cached) return cached;
  const id = await inTenant(async (client) => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2 LIMIT 1",
      [tenant.id, key],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = randomUUID();
    createdRoles.push(created);
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, true, $4, '[]'::jsonb, false, '["outlet"]'::jsonb)`,
      [created, tenant.id, key, key],
    );
    return created;
  });
  templateRoleIds.set(key, id);
  return id;
}

/** Outlet-scope assignment; `expired` makes it already ended. Returns its id. */
async function assignOutletRole(
  userId: string,
  roleId: string,
  expired = false,
): Promise<string> {
  const id = randomUUID();
  await inTenant((client) =>
    client.query(
      `INSERT INTO role_assignments
         (id, tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, $4, 'outlet', $5, now() - interval '2 days',
               CASE WHEN $6 THEN now() - interval '1 day' END, $3)`,
      [id, tenant.id, userId, roleId, outletId, expired],
    ),
  );
  return id;
}

async function seedOutlet(): Promise<string> {
  const id = randomUUID();
  await inTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet role rows lock', 'Jl. Lock', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `RR-${id.slice(0, 8)}`.toUpperCase(),
      ],
    ),
  );
  return id;
}

async function seedEmployee(userId: string | null = null): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await inTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pkwtt', '2025-03-01', 'active', NULL, now() - interval '1 day')`,
      [
        id,
        tenant.id,
        userId,
        `RR-${id.slice(0, 8).toUpperCase()}`,
        `Karyawan Baris Role ${id.slice(0, 8)}`,
        outletId,
      ],
    ),
  );
  return id;
}

async function managerOf(employeeId: string): Promise<string | null> {
  const rows = await inTenant(async (client) => {
    const result = await client.query<{ manager_id: string | null }>(
      "SELECT manager_id FROM employees WHERE tenant_id = $1 AND id = $2",
      [tenant.id, employeeId],
    );
    return result.rows;
  });
  return rows[0]!.manager_id;
}

async function auditCount(employeeId: string): Promise<number> {
  return inTenant(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
      [tenant.id, ACTION, employeeId],
    );
    return result.rowCount ?? 0;
  });
}

const patchManager = (client: Client, employeeId: string, managerId: string) =>
  client
    .patch(`/api/hris/employees/${employeeId}/manager`)
    .set(originHeader)
    .send({ managerId, idempotencyKey: `${KEY_PREFIX}${randomUUID()}` });

/** A fresh HR actor: manage role (a custom roles row) plus a view-only role. */
async function seedActor(name: string) {
  const actor = await signedInClient(name);
  const manageRoleId = await grantTenantRole(actor.userId, [
    "hr.employee.manage",
    "hr.employee.view",
  ]);
  await grantTenantRole(actor.userId, ["hr.employee.view"]);
  return { ...actor, manageRoleId };
}

/**
 * Run `change` as an uncommitted transaction, send the PATCH, wait until the request has
 * settled or is blocked by that transaction, commit, and return the response.
 */
async function patchAroundUncommittedChange(
  actor: { client: Client },
  target: string,
  newManager: string,
  change: (holder: PoolClient) => Promise<void>,
): Promise<Res> {
  const holder = await owner.connect();
  let pending: Promise<Res> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const backend = await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    await change(holder);

    let settled = false;
    pending = patchManager(actor.client, target, newManager).then((res) => {
      settled = true;
      return res;
    });
    pending.catch(() => {
      settled = true;
    });
    const deadline = Date.now() + 15_000;
    while (!settled && Date.now() < deadline) {
      const blockers = await owner.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
        [backend.rows[0]!.pid],
      );
      if (blockers.rows[0]?.waiting) break;
      await sleep(20);
    }
    await holder.query("COMMIT");
    return await pending;
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    holder.release();
    if (pending) await pending.catch(() => undefined);
  }
}

beforeAll(async () => {
  outletId = await seedOutlet();
}, 60_000);

describe("legend-ijcxc manager change is serialized with edits of the caller's custom roles row", () => {
  it("control: an uncommitted edit that keeps hr.employee.manage still lets the change through", async () => {
    const actor = await seedActor("HR Roles Row Control");
    const target = await seedEmployee();
    const boss = await seedEmployee();

    const res = await patchAroundUncommittedChange(
      actor,
      target,
      boss,
      async (holder) => {
        await holder.query(
          "UPDATE roles SET permissions = $3::jsonb WHERE tenant_id = $1 AND id = $2",
          [
            tenant.id,
            actor.manageRoleId,
            JSON.stringify(["hr.employee.manage", "hr.employee.view"]),
          ],
        );
      },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: target, managerId: boss });
    expect(await managerOf(target)).toBe(boss);
    expect(await auditCount(target)).toBe(1);
  });

  it("403 FORBIDDEN and no write when hr.employee.manage is removed from the custom role while the request is in flight", async () => {
    // Fails on current code if the roles row is not locked: the request reads the old
    // permissions, answers 200, moves manager_id and writes an audit row, and only then
    // does the revoke commit.
    const actor = await seedActor("HR Roles Row Revoked");
    const target = await seedEmployee();
    const boss = await seedEmployee();

    const res = await patchAroundUncommittedChange(
      actor,
      target,
      boss,
      async (holder) => {
        await holder.query(
          "UPDATE roles SET permissions = $3::jsonb WHERE tenant_id = $1 AND id = $2",
          [tenant.id, actor.manageRoleId, JSON.stringify(["hr.employee.view"])],
        );
      },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBe("FORBIDDEN");
    expect(await managerOf(target)).toBeNull();
    expect(await auditCount(target)).toBe(0);
  });

  it("a request sent after the permission was removed from the custom role is refused (no write)", async () => {
    const actor = await seedActor("HR Roles Row Revoked Before");
    const target = await seedEmployee();
    const boss = await seedEmployee();
    await inTenant((client) =>
      client.query(
        "UPDATE roles SET permissions = $3::jsonb WHERE tenant_id = $1 AND id = $2",
        [tenant.id, actor.manageRoleId, JSON.stringify(["hr.employee.view"])],
      ),
    );

    const res = await patchManager(actor.client, target, boss);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await managerOf(target)).toBeNull();
    expect(await auditCount(target)).toBe(0);
  });
});

describe("legend-ijcxc manager change is serialized with changes to the target employee's role assignments", () => {
  /** Target holds an ENDED supervisor assignment (junior today); the boss is cashier-only. */
  async function seedScenario(name: string) {
    const actor = await seedActor(name);
    const supervisorRole = await templateRole("supervisor");
    const cashierRole = await templateRole("cashier");

    const targetUser = await newUserId("Target role rows");
    const targetSupervisorAssignment = await assignOutletRole(
      targetUser,
      supervisorRole,
      true,
    );
    const target = await seedEmployee(targetUser);

    const bossUser = await newUserId("Boss junior role rows");
    await assignOutletRole(bossUser, cashierRole);
    const boss = await seedEmployee(bossUser);
    return { actor, target, boss, targetSupervisorAssignment };
  }

  it("control: a junior target (ended supervisor assignment) gets a junior manager", async () => {
    const s = await seedScenario("HR Target Role Control");

    const res = await patchAroundUncommittedChange(
      s.actor,
      s.target,
      s.boss,
      async (holder) => {
        // Uncommitted no-op touch of the target's assignment.
        await holder.query(
          "UPDATE role_assignments SET assigned_by = assigned_by WHERE tenant_id = $1 AND id = $2",
          [tenant.id, s.targetSupervisorAssignment],
        );
      },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await managerOf(s.target)).toBe(s.boss);
    expect(await auditCount(s.target)).toBe(1);
  });

  it("422 MANAGER_ROLE_TOO_LOW and no write when the target's supervisor assignment is re-activated while the request is in flight", async () => {
    // Fails on current code if the target's role assignments are not locked: the request
    // still sees the target as junior, accepts the cashier boss (200, audit row), and only
    // then does the re-activation commit -> a supervisor ends up under a junior manager.
    const s = await seedScenario("HR Target Role Reactivated");

    const res = await patchAroundUncommittedChange(
      s.actor,
      s.target,
      s.boss,
      async (holder) => {
        await holder.query(
          "UPDATE role_assignments SET valid_until = NULL WHERE tenant_id = $1 AND id = $2",
          [tenant.id, s.targetSupervisorAssignment],
        );
      },
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body?.error?.code, JSON.stringify(res.body)).toBe(
      "MANAGER_ROLE_TOO_LOW",
    );
    expect(await managerOf(s.target)).toBeNull();
    expect(await auditCount(s.target)).toBe(0);
  });
});

afterAll(async () => {
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.id],
      );
      await client.query(
        "DELETE FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = ANY($2::text[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM hris_idempotency WHERE tenant_id = $1 AND key LIKE $2",
        [tenant.id, `%${KEY_PREFIX}%`],
      );
      await client.query(
        "UPDATE employees SET manager_id = NULL WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdEmployees],
      );
      await client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
        [tenant.id, createdUsers],
      );
      await client.query(
        "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenant.id, createdRoles],
      );
      await client.query(
        "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
        [tenant.id, outletId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUsers,
    ]);
  } finally {
    await owner.end();
  }
}, 60_000);
