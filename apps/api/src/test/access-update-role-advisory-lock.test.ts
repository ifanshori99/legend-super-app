// legend-v8dfx (tier K auth). updateCustomRole must take the same per-tenant
// advisory lock as grantRoleAssignment and endRoleAssignment
// (`legend:role-assignment-end:<tenantId>`, pg_advisory_xact_lock) at the start
// of its transaction, so an edit of a role's permissions and an end/grant of an
// assignment are serialized. Expected behavior comes from PRD v1.7 §3.7 / TEN-03:
// an access decision never rests on permissions that another call changed
// meanwhile.
// Assumptions:
// - Only the lock key and the outcomes are asserted, not the code path. FIFO
//   order of waiters on one advisory lock is relied on: the call started (and
//   seen waiting) first runs first after the holder releases.
// - An actor that lost access.role.assign (its custom role was edited first) is
//   refused with PERMISSION_DENIED (403) when it then ends an assignment, and
//   the assignment stays active. An editor whose assignment was ended first is
//   refused with 403 and the role keeps its old permissions.
// - A custom role may hold access.role.assign (rows are inserted directly).
// - The barrier is best effort and never throws: without the lock the edit does
//   not park, so the "unchanged while the lock is held" assertion fails first.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { roleTemplate, updateCustomRoleSchema } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import {
  endRoleAssignment,
  updateCustomRole,
} from "../services/access.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "domain" }),
    { kind: "tenant" },
  );
}

async function signedIn(name: string) {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  return session.body.user.id as string;
}

async function insertTemplateRole(
  tenantId: string,
  input: {
    name: string;
    templateKey: string;
    permissions: readonly string[];
    allowedScopeTypes: readonly string[];
  },
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, $3, $4::jsonb, true, $5::jsonb)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.templateKey,
      JSON.stringify(input.permissions),
      JSON.stringify(input.allowedScopeTypes),
    ],
  );
  return rows[0]!.id;
}

/** A fresh tenant with the Owner and Admin Tenant template roles. */
async function createTenant(founderId: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Update role advisory lock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `update-role-advisory-${tenantId}`, founderId],
  );
  const ownerRoleId = await insertTemplateRole(tenantId, {
    name: "Owner",
    templateKey: "owner",
    permissions: roleTemplate("owner").permissions,
    allowedScopeTypes: ["tenant", "brand"],
  });
  const adminRoleId = await insertTemplateRole(tenantId, {
    name: "Admin Tenant",
    templateKey: "tenant_admin",
    permissions: roleTemplate("tenant_admin").permissions,
    allowedScopeTypes: ["tenant"],
  });
  return { tenantId, ownerRoleId, adminRoleId };
}

/** A custom (non-template) role holding the given permissions. */
async function insertCustomRole(
  tenantId: string,
  permissions: readonly string[],
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, false, NULL, $3::jsonb, false, '["tenant"]'::jsonb)
     RETURNING id`,
    [
      tenantId,
      `Custom ${randomUUID().slice(0, 8)}`,
      JSON.stringify(permissions),
    ],
  );
  return rows[0]!.id;
}

/** Permanent tenant-scope assignment (valid_until IS NULL). */
async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate: a container clock may drift from the Node clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '10 minutes', NULL, $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy],
  );
  return rows[0]!.id;
}

async function rolePermissions(roleId: string): Promise<string[]> {
  const { rows } = await owner.query<{ permissions: string[] }>(
    "SELECT permissions FROM roles WHERE id = $1",
    [roleId],
  );
  return rows[0]!.permissions;
}

async function isEnded(assignmentId: string): Promise<boolean> {
  const { rows } = await owner.query<{ ended: boolean }>(
    "SELECT valid_until IS NOT NULL AS ended FROM role_assignments WHERE id = $1",
    [assignmentId],
  );
  return rows[0]!.ended;
}

/**
 * Poll until at least `count` sessions wait (not granted) on this tenant's
 * advisory lock. Returns false after ~3 s instead of throwing: without the lock
 * no waiter appears, and the test must still reach its outcome assertions.
 * Counts iterations, not wall time.
 */
async function waitForWaiters(
  client: PoolClient,
  lockKey: string,
  count: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const { rows } = await client.query<{ waiting: number }>(
      `WITH k AS (SELECT hashtextextended($1, 0) AS key)
       SELECT count(*)::int AS waiting
       FROM pg_locks l, k
       WHERE l.locktype = 'advisory'
         AND NOT l.granted
         AND l.classid::bigint = ((k.key >> 32) & 4294967295)
         AND l.objid::bigint = (k.key & 4294967295)`,
      [lockKey],
    );
    if (rows[0]!.waiting >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

type Outcome = { ok: true } | { ok: false; reason: unknown };

const settle = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    () => ({ ok: true as const }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );

const editInput = updateCustomRoleSchema.parse({
  permissions: ["menu.item.view"],
});

function startEdit(tenantId: string, roleId: string, editorUserId: string) {
  return settle(
    updateCustomRole(scopedContext(tenantId), roleId, editInput, {
      actorUserId: editorUserId,
      reauthenticatedAt: new Date(),
      mfaVerified: true,
    }),
  );
}

function startEnd(tenantId: string, assignmentId: string, actorUserId: string) {
  return settle(
    endRoleAssignment(
      scopedContext(tenantId),
      assignmentId,
      { reason: "Selesai tugas, ditutup." },
      actorUserId,
    ),
  );
}

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
  setAuditWriter(null);
  if (tenantIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = ANY($1::uuid[])",
      [tenantIds],
    );
    await owner.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
      tenantIds,
    ]);
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      tenantIds,
    ]);
  }
  await owner.end();
});

describe("legend-v8dfx custom role edit shares the tenant role-assignment lock", () => {
  it("legend-v8dfx a role edit queued on the lock lands before a later end, which then finds no stale permission", async () => {
    const founder = await signedIn("Role Adv Founder");
    const tenant = await createTenant(founder);
    const editor = await signedIn("Role Adv Editor");
    const actor = await signedIn("Role Adv Actor");
    const member = await signedIn("Role Adv Member");
    await assign(tenant.tenantId, editor, tenant.adminRoleId, founder);
    // The actor can end assignments only through this custom role.
    const actorRoleId = await insertCustomRole(tenant.tenantId, [
      "access.role.view",
      "access.role.assign",
    ]);
    await assign(tenant.tenantId, actor, actorRoleId, founder);
    const memberAssignment = await assign(
      tenant.tenantId,
      member,
      tenant.adminRoleId,
      founder,
    );
    const lockKey = `legend:role-assignment-end:${tenant.tenantId}`;

    const holder = await owner.connect();
    let editOutcome: Promise<Outcome> | null = null;
    let endOutcome: Promise<Outcome> | null = null;
    let sawEditWaiting = false;
    let sawEndWaiting = false;
    let permissionsWhileLocked: string[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      // First in the queue: the editor drops access.role.assign from the actor.
      editOutcome = startEdit(tenant.tenantId, actorRoleId, editor);
      sawEditWaiting = await waitForWaiters(holder, lockKey, 1);
      // While the lock is held by someone else, the edit must not have landed.
      permissionsWhileLocked = await rolePermissions(actorRoleId);

      // Second in the queue: the actor ends the member's assignment.
      endOutcome = startEnd(tenant.tenantId, memberAssignment, actor);
      sawEndWaiting = await waitForWaiters(holder, lockKey, 2);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    const edit = await editOutcome!;
    const end = await endOutcome!;
    expect(edit.ok).toBe(true);
    expect(permissionsWhileLocked).toEqual([
      "access.role.view",
      "access.role.assign",
    ]);
    expect(await rolePermissions(actorRoleId)).toEqual(["menu.item.view"]);
    // The end ran after the edit: the actor no longer holds access.role.assign.
    expect(end.ok).toBe(false);
    if (!end.ok) {
      expect((end.reason as { code?: string }).code).toBe("PERMISSION_DENIED");
    }
    expect(await isEnded(memberAssignment)).toBe(false);
    // Last on purpose: without the lock the checks above fail first.
    expect(sawEditWaiting).toBe(true);
    expect(sawEndWaiting).toBe(true);
  }, 30_000);

  it("legend-v8dfx an editor ended through the lock cannot then change the role", async () => {
    const founder = await signedIn("Role Adv End Founder");
    const tenant = await createTenant(founder);
    const ownerUser = await signedIn("Role Adv End Owner");
    const editor = await signedIn("Role Adv End Editor");
    await assign(tenant.tenantId, ownerUser, tenant.ownerRoleId, founder);
    const editorAssignment = await assign(
      tenant.tenantId,
      editor,
      tenant.adminRoleId,
      founder,
    );
    const roleId = await insertCustomRole(tenant.tenantId, [
      "menu.item.manage",
    ]);
    const lockKey = `legend:role-assignment-end:${tenant.tenantId}`;

    const holder = await owner.connect();
    let endOutcome: Promise<Outcome> | null = null;
    let editOutcome: Promise<Outcome> | null = null;
    let sawEndWaiting = false;
    let sawEditWaiting = false;
    let permissionsWhileLocked: string[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      // First in the queue: the Owner ends the editor's assignment.
      endOutcome = startEnd(tenant.tenantId, editorAssignment, ownerUser);
      sawEndWaiting = await waitForWaiters(holder, lockKey, 1);

      // Second in the queue: the editor tries to change the custom role.
      editOutcome = startEdit(tenant.tenantId, roleId, editor);
      sawEditWaiting = await waitForWaiters(holder, lockKey, 2);
      permissionsWhileLocked = await rolePermissions(roleId);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    const end = await endOutcome!;
    const edit = await editOutcome!;
    expect(permissionsWhileLocked).toEqual(["menu.item.manage"]);
    expect(end.ok).toBe(true);
    expect(await isEnded(editorAssignment)).toBe(true);
    expect(edit.ok).toBe(false);
    if (!edit.ok) {
      expect((edit.reason as { status?: number }).status).toBe(403);
    }
    expect(await rolePermissions(roleId)).toEqual(["menu.item.manage"]);
    expect(sawEndWaiting).toBe(true);
    expect(sawEditWaiting).toBe(true);
  }, 30_000);

  // Assumption: the editor's authority is judged by the DB clock. The editor's
  // only assignment ended 30 s ago by the DB clock, while the app Date (faked,
  // derived from the DB clock) is 60 s behind and so still sees it as valid. The
  // edit is refused with 403 and the role keeps its permissions.
  it("legend-v8dfx an editor whose assignment ended by the DB clock cannot change the role although the app clock says it is still valid", async () => {
    const founder = await signedIn("Role Adv Clock Founder");
    const tenant = await createTenant(founder);
    const editor = await signedIn("Role Adv Clock Editor");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'tenant', clock_timestamp() - interval '10 minutes',
               clock_timestamp() - interval '30 seconds', $4)`,
      [tenant.tenantId, editor, tenant.adminRoleId, founder],
    );
    const roleId = await insertCustomRole(tenant.tenantId, [
      "menu.item.manage",
    ]);

    const { rows: clock } = await owner.query<{ ms: number }>(
      "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms",
    );
    let edit: Outcome;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(clock[0]!.ms - 60_000));
      edit = await startEdit(tenant.tenantId, roleId, editor);
    } finally {
      vi.useRealTimers();
    }

    expect(edit.ok).toBe(false);
    if (!edit.ok) {
      expect((edit.reason as { status?: number }).status).toBe(403);
    }
    expect(await rolePermissions(roleId)).toEqual(["menu.item.manage"]);
  }, 30_000);

  it("legend-v8dfx without contention an edit and an end both go through", async () => {
    const founder = await signedIn("Role Adv Ok Founder");
    const tenant = await createTenant(founder);
    const editor = await signedIn("Role Adv Ok Editor");
    const actor = await signedIn("Role Adv Ok Actor");
    const member = await signedIn("Role Adv Ok Member");
    await assign(tenant.tenantId, editor, tenant.adminRoleId, founder);
    const actorRoleId = await insertCustomRole(tenant.tenantId, [
      "access.role.view",
      "access.role.assign",
    ]);
    await assign(tenant.tenantId, actor, actorRoleId, founder);
    const memberAssignment = await assign(
      tenant.tenantId,
      member,
      tenant.adminRoleId,
      founder,
    );

    const end = await startEnd(tenant.tenantId, memberAssignment, actor);
    expect(end.ok).toBe(true);
    expect(await isEnded(memberAssignment)).toBe(true);

    const edit = await startEdit(tenant.tenantId, actorRoleId, editor);
    expect(edit.ok).toBe(true);
    expect(await rolePermissions(actorRoleId)).toEqual(["menu.item.view"]);
  }, 30_000);
});
