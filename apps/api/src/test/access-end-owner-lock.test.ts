// legend-qr1uv (tier K auth). endRoleAssignment must decide "is the actor an
// Owner" and "does another Owner remain" at a clock read AFTER the per-tenant
// advisory lock, and only a permanent Owner (valid_until IS NULL) counts as the
// remaining Owner. Expected behavior comes from PRD v1.7 §3.7 / TEN-03: a
// tenant always keeps at least one active Owner, and only an active Owner may
// end an Owner assignment.
// Assumption: the loser of the race is refused with PERMISSION_DENIED (403, it
// is no longer an Owner). A third permanent Owner keeps the tenant above one
// Owner, so the remaining-Owner check (CONFLICT) cannot be what refuses it.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import { endRoleAssignment } from "../services/access.service";
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

async function createTenant(founderId: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Owner end lock', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `owner-end-lock-${tenantId}`, founderId],
  );
  const ownerRole = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, 'Owner', true, 'owner', $2::jsonb, true, '["tenant","brand"]'::jsonb)
     RETURNING id`,
    [
      tenantId,
      JSON.stringify([
        "access.role.view",
        "access.role.manage",
        "access.role.assign",
      ]),
    ],
  );
  return { tenantId, ownerRoleId: ownerRole.rows[0]!.id };
}

/** Tenant-scope Owner assignment; `temporary` sets valid_until = now + 1 day. */
async function assignOwner(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
  temporary = false,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate one minute: a container clock may drift from the Node clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute',
             CASE WHEN $5::boolean THEN now() + interval '1 day' ELSE NULL END, $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy, temporary],
  );
  return rows[0]!.id;
}

async function isEnded(assignmentId: string): Promise<boolean> {
  const { rows } = await owner.query<{ ended: boolean }>(
    "SELECT valid_until IS NOT NULL AS ended FROM role_assignments WHERE id = $1",
    [assignmentId],
  );
  return rows[0]!.ended;
}

async function activeOwnerCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM role_assignments
     WHERE tenant_id = $1 AND valid_until IS NULL`,
    [tenantId],
  );
  return rows[0]!.count;
}

/** Poll until a session waits (not granted) on this tenant's advisory lock. */
async function waitForLockWaiter(
  client: PoolClient,
  lockKey: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await client.query<{ waiting: boolean }>(
      `WITH k AS (SELECT hashtextextended($1, 0) AS key)
       SELECT EXISTS (
         SELECT 1 FROM pg_locks l, k
         WHERE l.locktype = 'advisory'
           AND NOT l.granted
           AND l.classid::bigint = ((k.key >> 32) & 4294967295)
           AND l.objid::bigint = (k.key & 4294967295)
       ) AS waiting`,
      [lockKey],
    );
    if (rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("endRoleAssignment never waited on the advisory lock");
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

describe("legend-qr1uv Owner end decides after the tenant lock", () => {
  it("legend-qr1uv an Owner ended while waiting for the lock cannot then end the other Owner", async () => {
    const founder = await signedIn("Lock Race Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Lock Race A");
    const ownerB = await signedIn("Lock Race B");
    const ownerC = await signedIn("Lock Race C");
    const assignmentA = await assignOwner(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    const assignmentB = await assignOwner(
      tenant.tenantId,
      ownerB,
      tenant.ownerRoleId,
      founder,
    );
    const assignmentC = await assignOwner(
      tenant.tenantId,
      ownerC,
      tenant.ownerRoleId,
      founder,
    );
    const lockKey = `legend:role-assignment-end:${tenant.tenantId}`;

    const holder = await owner.connect();
    let pending: Promise<{ ok: true } | { ok: false; reason: unknown }> | null =
      null;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      // Owner A starts ending Owner B; the call parks on the tenant lock.
      pending = endRoleAssignment(
        scopedContext(tenant.tenantId),
        assignmentB,
        { reason: "Rotasi dengan kunci." },
        ownerA,
      ).then(
        () => ({ ok: true as const }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );

      await waitForLockWaiter(holder, lockKey);
      // Let the pending call's early clock read fall clearly in the past.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Meanwhile B ended A first (simulated), then the lock is released.
      // DB time: endRoleAssignment reads the DB clock (legend-hzdy5), so a Node
      // timestamp ahead of the container would still look active. Truncated
      // because the service compares at millisecond precision.
      await holder.query(
        `UPDATE role_assignments
         SET valid_until = date_trunc('milliseconds', clock_timestamp())
         WHERE id = $1`,
        [assignmentA],
      );
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    const outcome = await pending!;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { code?: string }).code).toBe(
        "PERMISSION_DENIED",
      );
    }
    // B and C stay active (valid_until IS NULL).
    expect(await isEnded(assignmentB)).toBe(false);
    expect(await isEnded(assignmentC)).toBe(false);
    expect(await activeOwnerCount(tenant.tenantId)).toBe(2);
  }, 20_000);

  it("legend-qr1uv an Owner ended while waiting for the lock cannot then end a non-Owner assignment", async () => {
    // Assumption: a tenant_admin member's assignment is ended through the
    // same access.role.assign permission an Owner holds. Once Owner A is
    // ended during the wait, A no longer holds it and is refused with
    // PERMISSION_DENIED, even though Owner B keeps the tenant above one Owner.
    const founder = await signedIn("Admin Race Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Admin Race A");
    const ownerB = await signedIn("Admin Race B");
    const member = await signedIn("Admin Race M");
    const assignmentA = await assignOwner(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    await assignOwner(tenant.tenantId, ownerB, tenant.ownerRoleId, founder);
    const adminRole = await owner.query<{ id: string }>(
      `INSERT INTO roles
         (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, 'Tenant Admin', true, 'tenant_admin', $2::jsonb, false, '["tenant","brand"]'::jsonb)
       RETURNING id`,
      [tenant.tenantId, JSON.stringify(["access.role.view"])],
    );
    // assignOwner only inserts a permanent tenant-scope assignment of the
    // given role; here it is the tenant_admin role for member M.
    const assignmentM = await assignOwner(
      tenant.tenantId,
      member,
      adminRole.rows[0]!.id,
      founder,
    );
    const lockKey = `legend:role-assignment-end:${tenant.tenantId}`;

    const holder = await owner.connect();
    let pending: Promise<{ ok: true } | { ok: false; reason: unknown }> | null =
      null;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      // Owner A starts ending M's assignment; the call parks on the tenant lock.
      pending = endRoleAssignment(
        scopedContext(tenant.tenantId),
        assignmentM,
        { reason: "Admin selesai tugas." },
        ownerA,
      ).then(
        () => ({ ok: true as const }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );

      await waitForLockWaiter(holder, lockKey);
      // Let the pending call's early clock read fall clearly in the past.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Meanwhile Owner A is ended (simulated), then the lock is released.
      // DB time: endRoleAssignment reads the DB clock (legend-hzdy5), so a Node
      // timestamp ahead of the container would still look active. Truncated
      // because the service compares at millisecond precision.
      await holder.query(
        `UPDATE role_assignments
         SET valid_until = date_trunc('milliseconds', clock_timestamp())
         WHERE id = $1`,
        [assignmentA],
      );
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    const outcome = await pending!;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.reason as { code?: string }).code).toBe(
        "PERMISSION_DENIED",
      );
    }
    // M's assignment stays active (valid_until IS NULL).
    expect(await isEnded(assignmentM)).toBe(false);
  }, 20_000);

  it("legend-qr1uv a temporary Owner does not count as the remaining Owner", async () => {
    const founder = await signedIn("Temp Owner Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Temp Owner A");
    const ownerB = await signedIn("Temp Owner B");
    const assignmentA = await assignOwner(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    const assignmentB = await assignOwner(
      tenant.tenantId,
      ownerB,
      tenant.ownerRoleId,
      founder,
      true,
    );
    const context = scopedContext(tenant.tenantId);

    // Temporary Owner B is an active Owner, but ending the only permanent
    // Owner A would leave nobody permanent: refused with 409 "minimal satu Owner".
    await expect(
      endRoleAssignment(
        context,
        assignmentA,
        { reason: "Mencabut owner permanen terakhir." },
        ownerB,
      ),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(await isEnded(assignmentA)).toBe(false);

    // The permanent Owner may end the temporary one: A remains.
    const ended = await endRoleAssignment(
      context,
      assignmentB,
      { reason: "Owner sementara selesai." },
      ownerA,
    );
    expect(ended.validUntil).not.toBeNull();
    expect(await isEnded(assignmentB)).toBe(true);
    expect(await isEnded(assignmentA)).toBe(false);
  });

  it("legend-qr1uv one permanent Owner may end another permanent Owner", async () => {
    const founder = await signedIn("Sanity Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Sanity A");
    const ownerB = await signedIn("Sanity B");
    await assignOwner(tenant.tenantId, ownerA, tenant.ownerRoleId, founder);
    const assignmentB = await assignOwner(
      tenant.tenantId,
      ownerB,
      tenant.ownerRoleId,
      founder,
    );

    const ended = await endRoleAssignment(
      scopedContext(tenant.tenantId),
      assignmentB,
      { reason: "Rotasi owner." },
      ownerA,
    );
    expect(ended.validUntil).not.toBeNull();
    expect(await isEnded(assignmentB)).toBe(true);
    expect(await activeOwnerCount(tenant.tenantId)).toBe(1);
  });
});
