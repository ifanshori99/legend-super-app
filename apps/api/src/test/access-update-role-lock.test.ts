// legend-tegsk (tier K auth). updateCustomRole must read "now" AFTER it holds the
// role row lock (SELECT ... FOR UPDATE) and decide "does the editor still hold
// access.role.manage" at that instant. Same rule as legend-8ajy4/qr1uv: an
// editor ended while the call waited for another editor's row lock must be
// refused, not judged at a clock read taken before the wait.
// Assumptions:
// - The loser is refused with a 403 (PERMISSION_DENIED) and the role keeps its
//   old permissions.
// - The barrier is best effort and returns false (never throws) when no waiter
//   appears, so on code without the fix the outcome assertions fail first.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { roleTemplate, updateCustomRoleSchema } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { updateCustomRole } from "../services/access.service";
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

async function insertRole(
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

/** A fresh tenant with the Owner, Admin Tenant and Finance template roles. */
async function createTenant(founderId: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Update role lock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `update-role-lock-${tenantId}`, founderId],
  );
  const ownerRoleId = await insertRole(tenantId, {
    name: "Owner",
    templateKey: "owner",
    permissions: roleTemplate("owner").permissions,
    allowedScopeTypes: ["tenant", "brand"],
  });
  const adminRoleId = await insertRole(tenantId, {
    name: "Admin Tenant",
    templateKey: "tenant_admin",
    permissions: roleTemplate("tenant_admin").permissions,
    allowedScopeTypes: ["tenant"],
  });
  const financeRoleId = await insertRole(tenantId, {
    name: "Finance",
    templateKey: "finance",
    permissions: roleTemplate("finance").permissions,
    allowedScopeTypes: ["tenant", "brand", "outlet"],
  });
  return { tenantId, ownerRoleId, adminRoleId, financeRoleId };
}

/** Permanent tenant-scope assignment (valid_until IS NULL). */
async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate one minute: a container clock may drift from the Node clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', NULL, $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy],
  );
  return rows[0]!.id;
}

/** A custom (non-template) role with no permissions. */
async function insertCustomRole(tenantId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, false, NULL, '[]'::jsonb, false, '["tenant"]'::jsonb)
     RETURNING id`,
    [tenantId, `Custom ${randomUUID().slice(0, 8)}`],
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

/**
 * Poll until a session waits for the holder's transaction (the row lock taken
 * by SELECT ... FOR UPDATE makes the waiter queue on the holder's xid).
 * pg_locks is readable by every role; pg_stat_activity hides other roles'
 * queries. Returns false after the timeout instead of throwing.
 */
async function waitForRowLockWaiter(client: PoolClient): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await client.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
         WHERE locktype = 'transactionid'
           AND NOT granted
           AND transactionid = pg_current_xact_id()::xid
       ) AS waiting`,
    );
    if (rows[0]!.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

type Outcome = { ok: true } | { ok: false; reason: unknown };

/**
 * Hold the role row lock, start the edit (not awaited), end the editor with
 * database time while the edit waits, then release the lock.
 */
async function editWhileEditorIsEnded(input: {
  tenantId: string;
  roleId: string;
  editorUserId: string;
  editorAssignmentId: string;
}): Promise<{ outcome: Outcome; sawWaiter: boolean }> {
  const holder = await owner.connect();
  let pending: Promise<Outcome> | null = null;
  let sawWaiter = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM roles WHERE id = $1 FOR UPDATE", [
      input.roleId,
    ]);

    pending = updateCustomRole(
      scopedContext(input.tenantId),
      input.roleId,
      updateCustomRoleSchema.parse({ permissions: ["menu.item.view"] }),
      {
        actorUserId: input.editorUserId,
        reauthenticatedAt: new Date(),
        mfaVerified: true,
      },
    ).then(
      () => ({ ok: true as const }),
      (reason: unknown) => ({ ok: false as const, reason }),
    );

    sawWaiter = await waitForRowLockWaiter(holder);
    // Let the pending call's early clock read (if any) fall clearly in the past.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The editor is ended meanwhile (simulated), then the lock is released.
    // Database clock, the one the edit reads after the lock (readDbClock).
    await holder.query(
      "UPDATE role_assignments SET valid_until = clock_timestamp() WHERE id = $1",
      [input.editorAssignmentId],
    );
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  return { outcome: await pending!, sawWaiter };
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

describe("legend-tegsk custom role edit decides after the role row lock", () => {
  it("legend-tegsk an editor ended while waiting for the role lock cannot add permissions", async () => {
    const founder = await signedIn("Update Lock Founder");
    const tenant = await createTenant(founder);
    const editor = await signedIn("Update Lock Editor");
    const assignment = await assign(
      tenant.tenantId,
      editor,
      tenant.adminRoleId,
      founder,
    );
    const roleId = await insertCustomRole(tenant.tenantId);

    const { outcome, sawWaiter } = await editWhileEditorIsEnded({
      tenantId: tenant.tenantId,
      roleId,
      editorUserId: editor,
      editorAssignmentId: assignment,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { status?: number }).status).toBe(403);
    }
    expect(await rolePermissions(roleId)).toEqual([]);
    // Last on purpose: on code without the fix the outcome fails first.
    expect(sawWaiter).toBe(true);
  }, 20_000);

  it("legend-tegsk an active editor still adds a permission without contention", async () => {
    const founder = await signedIn("Update Lock Ok Founder");
    const tenant = await createTenant(founder);
    const editor = await signedIn("Update Lock Ok Editor");
    await assign(tenant.tenantId, editor, tenant.adminRoleId, founder);
    const roleId = await insertCustomRole(tenant.tenantId);

    await updateCustomRole(
      scopedContext(tenant.tenantId),
      roleId,
      updateCustomRoleSchema.parse({ permissions: ["menu.item.view"] }),
      {
        actorUserId: editor,
        reauthenticatedAt: new Date(),
        mfaVerified: true,
      },
    );

    expect(await rolePermissions(roleId)).toEqual(["menu.item.view"]);
  }, 20_000);
});
