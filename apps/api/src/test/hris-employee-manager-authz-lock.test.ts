// legend-c79uy P1 (tier K, access + personal data): PATCH /api/hris/employees/:employeeId/manager
// must authorize the caller AGAIN after it holds the employee locks, using the latest access
// (serialized with role revocation). A role revoked after the request was first authorized
// but before the write may not still move employees.manager_id.
//
// Written from the legend-f4uvg contract exercised in hris-employee-manager-change.test.ts
// (HR with hr.employee.manage at tenant scope may call it; a visible-but-forbidden actor gets
// 403 FORBIDDEN; a rejected call writes no manager_id and no audit row) and the brief
// docs/briefs/fix-ykk88-c79uy.md section B, not from the implementation.
//
// How the race is made deterministic (no sleeps for ordering): a separate transaction takes
// row locks on the target and the new-manager employee rows and, in the same transaction,
// revokes the actor's manage role (uncommitted). The request is sent and the test waits until
// a backend is really blocked by that transaction, i.e. the service has passed its first
// authorization and is waiting on the employee lock. Only then the revocation commits.
//
// Assumptions:
// - The service locks the target and/or new-manager employee row (or the actor's role
//   assignment); the test locks all of them, so any of those makes the request wait. If it
//   never waits the setup precondition assertion fails (not a behaviour assertion).
// - The actor keeps a second, view-only role (hr.employee.view, tenant scope), so after the
//   revocation the employee is still visible and the answer is 403 FORBIDDEN (not 404).
// - A revoked role means either the role_assignments row deleted or its valid_until moved
//   into the past; both must stop the write.
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
  max: 4,
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
const KEY_PREFIX = "mgr-authz-lock-";
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

/** Tenant-scope role with the given permissions; returns the role_assignments id. */
async function grantTenantRole(
  userId: string,
  permissions: string[],
): Promise<string> {
  const roleId = randomUUID();
  const assignmentId = randomUUID();
  createdRoles.push(roleId);
  await inTenant(async (client) => {
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
       VALUES ($1, $2, $3, false, $4, '["tenant"]')`,
      [
        roleId,
        tenant.id,
        `Authz lock ${roleId.slice(0, 8)}`,
        JSON.stringify(permissions),
      ],
    );
    await client.query(
      `INSERT INTO role_assignments
         (id, tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, 'tenant', NULL, now() - interval '1 hour', $3)`,
      [assignmentId, tenant.id, userId, roleId],
    );
  });
  return assignmentId;
}

async function seedOutlet(): Promise<string> {
  const id = randomUUID();
  await inTenant((client) =>
    client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, 'Outlet authz lock', 'Jl. Lock', 'Asia/Jakarta',
               '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `AL-${id.slice(0, 8)}`.toUpperCase(),
      ],
    ),
  );
  return id;
}

async function seedEmployee(): Promise<string> {
  const id = randomUUID();
  createdEmployees.push(id);
  await inTenant((client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status, manager_id, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, 'pkwtt', '2025-03-01', 'active', NULL, now() - interval '1 day')`,
      [
        id,
        tenant.id,
        `AL-${id.slice(0, 8).toUpperCase()}`,
        `Karyawan Lock ${id.slice(0, 8)}`,
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

const patchManager = (
  client: Client,
  employeeId: string,
  managerId: string | null,
) =>
  client
    .patch(`/api/hris/employees/${employeeId}/manager`)
    .set(originHeader)
    .send({ managerId, idempotencyKey: `${KEY_PREFIX}${randomUUID()}` });

/** A fresh HR actor: manage role (the one to be revoked) plus a view-only role. */
async function seedActor(name: string) {
  const actor = await signedInClient(name);
  const manageAssignment = await grantTenantRole(actor.userId, [
    "hr.employee.manage",
    "hr.employee.view",
  ]);
  await grantTenantRole(actor.userId, ["hr.employee.view"]);
  return { ...actor, manageAssignment };
}

type Revocation = "delete" | "expire";

/**
 * Send the PATCH while another transaction holds the employee rows (and, when `revoke` is
 * set, has revoked the actor's manage role uncommitted). Wait until the request is really
 * blocked, then commit and return the response.
 */
async function patchWhileLocked(
  actor: Awaited<ReturnType<typeof seedActor>>,
  target: string,
  newManager: string,
  revoke: Revocation | null,
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
    await holder.query(
      "UPDATE employees SET status = 'active' WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, [target, newManager]],
    );
    if (revoke === "delete")
      await holder.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND id = $2",
        [tenant.id, actor.manageAssignment],
      );
    if (revoke === "expire")
      await holder.query(
        "UPDATE role_assignments SET valid_until = now() - interval '1 second' WHERE tenant_id = $1 AND id = $2",
        [tenant.id, actor.manageAssignment],
      );

    let settled = false;
    pending = patchManager(actor.client, target, newManager).then((res) => {
      settled = true;
      return res;
    });
    pending.catch(() => {
      settled = true;
    });
    const deadline = Date.now() + 15_000;
    let waiting = false;
    while (!settled && Date.now() < deadline) {
      const blockers = await owner.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
        [backend.rows[0]!.pid],
      );
      if (blockers.rows[0]?.waiting) {
        waiting = true;
        break;
      }
      await sleep(20);
    }
    expect(
      waiting,
      "the request must wait on the employee/role locks held by the test (setup precondition)",
    ).toBe(true);
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

describe("legend-c79uy P1 manager change re-authorizes after the lock", () => {
  it("control: an actor whose role is intact still changes the manager after waiting on the lock", async () => {
    const actor = await seedActor("HR Lock Control");
    const target = await seedEmployee();
    const boss = await seedEmployee();

    const res = await patchWhileLocked(actor, target, boss, null);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ id: target, managerId: boss });
    expect(await managerOf(target)).toBe(boss);
    expect(await auditCount(target)).toBe(1);
  });

  it.each<Revocation>(["delete", "expire"])(
    "rejects with 403 and writes nothing when the manage role is revoked (%s) while the request waits for the lock",
    async (revoke) => {
      // Fails on current code: authorization happened before the lock, so the revoked actor
      // still gets 200, manager_id moves and an audit row is written.
      const actor = await seedActor(`HR Lock Revoked ${revoke}`);
      const target = await seedEmployee();
      const boss = await seedEmployee();

      const res = await patchWhileLocked(actor, target, boss, revoke);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body?.error?.code, JSON.stringify(res.body)).toBe("FORBIDDEN");
      expect(await managerOf(target)).toBeNull();
      expect(await auditCount(target)).toBe(0);
    },
  );

  it("a request sent after the revocation committed is also rejected (no write)", async () => {
    const actor = await seedActor("HR Lock Revoked Before");
    const target = await seedEmployee();
    const boss = await seedEmployee();
    await inTenant((client) =>
      client.query(
        "DELETE FROM role_assignments WHERE tenant_id = $1 AND id = $2",
        [tenant.id, actor.manageAssignment],
      ),
    );

    const res = await patchManager(actor.client, target, boss);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await managerOf(target)).toBeNull();
    expect(await auditCount(target)).toBe(0);
  });
});

afterAll(async () => {
  try {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
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
