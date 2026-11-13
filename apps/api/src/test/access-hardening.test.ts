// RBAC hardening (bead legend-vbws; coordinator decisions C6; PRD v1.7 §3.7
// "Pemberian Role", TEN-03). Covers the two rules the RBAC engine lacks:
// - editing a custom role may only add permissions the editor holds, unless a
//   re-authenticated Owner / Admin Tenant does it;
// - Owner assignments are protected: only an active Owner may end another
//   Owner's assignment, and a tenant keeps at least one active Owner.
// Integration tests run the real service against PostgreSQL with RLS; each
// Owner-protection test gets its own tenant so the active-Owner count is not
// shared with other tests.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCustomRoleSchema,
  updateCustomRoleSchema,
} from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import {
  createCustomRole,
  endRoleAssignment,
  updateCustomRole,
} from "../services/access.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const audits: AuditEntry[] = [];
const tenantIds: string[] = [];
const createdUserIds: string[] = [];

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
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return userId;
}

/** A fresh tenant with the two top-authority template roles. */
async function createTenant(founderId: string) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'RBAC hardening', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `hardening-${tenantId}`, founderId],
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
  const adminRole = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, 'Admin Tenant', true, 'tenant_admin', $2::jsonb, true, '["tenant"]'::jsonb)
     RETURNING id`,
    [
      tenantId,
      // Mirrors the real tenant_admin template, which holds menu.item.view
      // (so the Admin can build a role from it) but never payroll.view.
      JSON.stringify([
        "access.role.view",
        "access.role.manage",
        "access.role.assign",
        "menu.item.view",
      ]),
    ],
  );
  return {
    tenantId,
    ownerRoleId: ownerRole.rows[0]!.id,
    adminRoleId: adminRole.rows[0]!.id,
  };
}

async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate one minute: a container clock may drift from the Node clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy],
  );
  return rows[0]!.id;
}

beforeAll(() => {
  // The dedicated audit-wiring test owns the real core audit writer; here a
  // recording writer keeps the assertions on rules and status codes.
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
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

describe("§3.7 custom-role edits follow the grant rule (C6)", () => {
  it("§3.7 Admin Tenant needs MFA and a fresh re-auth to add an unheld permission", async () => {
    const founder = await signedIn("Grant Rule Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Grant Rule Admin");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
    const context = scopedContext(tenant.tenantId);

    const role = await createCustomRole(
      context,
      createCustomRoleSchema.parse({
        name: `Menu viewer ${randomBytes(4).toString("hex")}`,
        permissions: ["menu.item.view"],
        allowedScopeTypes: ["tenant"],
      }),
      admin,
    );

    // Without a re-authentication the editor is an ordinary editor: payroll.view
    // is not held by Admin Tenant, so adding it is self-elevation.
    await expect(
      updateCustomRole(
        context,
        role.id,
        updateCustomRoleSchema.parse({
          permissions: ["menu.item.view", "payroll.view"],
        }),
        { actorUserId: admin, reauthenticatedAt: null, mfaVerified: false },
      ),
    ).rejects.toMatchObject({ code: "SELF_ELEVATION_FORBIDDEN" });

    // Owner/Admin Tenant top authority with MFA + re-auth may add it.
    const updated = await updateCustomRole(
      context,
      role.id,
      updateCustomRoleSchema.parse({
        permissions: ["menu.item.view", "payroll.view"],
      }),
      { actorUserId: admin, reauthenticatedAt: new Date(), mfaVerified: true },
    );
    expect(updated.permissions).toContain("payroll.view");
    expect(
      audits.some(
        (entry) =>
          entry.action === "role.updated" &&
          entry.objectId === role.id &&
          entry.actorId === admin,
      ),
    ).toBe(true);
  });
});

describe("§3.7 Owner assignments are protected (C6)", () => {
  it("§3.7 only an active Owner may end another Owner's assignment", async () => {
    const founder = await signedIn("Owner Guard Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Owner Guard Admin");
    const target = await signedIn("Owner Guard Target");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
    const targetAssignment = await assign(
      tenant.tenantId,
      target,
      tenant.ownerRoleId,
      founder,
    );

    // An Admin Tenant holds access.role.assign but is not an Owner.
    await expect(
      endRoleAssignment(
        scopedContext(tenant.tenantId),
        targetAssignment,
        { reason: "Bukan wewenang saya." },
        admin,
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const ownerActor = await signedIn("Owner Guard Actor");
    await assign(tenant.tenantId, ownerActor, tenant.ownerRoleId, founder);
    const ended = await endRoleAssignment(
      scopedContext(tenant.tenantId),
      targetAssignment,
      { reason: "Owner kedua sudah tidak bertugas." },
      ownerActor,
    );
    expect(ended.validUntil).not.toBeNull();
  });

  it("§3.7 the last active Owner of a tenant can never be ended", async () => {
    const founder = await signedIn("Last Owner Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Last Owner A");
    const ownerB = await signedIn("Last Owner B");
    const assignmentA = await assign(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    const assignmentB = await assign(
      tenant.tenantId,
      ownerB,
      tenant.ownerRoleId,
      founder,
    );
    const context = scopedContext(tenant.tenantId);

    // Two Owners: each may end the other's assignment.
    await endRoleAssignment(
      context,
      assignmentB,
      { reason: "Rotasi owner." },
      ownerA,
    );
    // One Owner left: even that Owner cannot end their own assignment.
    await expect(
      endRoleAssignment(
        context,
        assignmentA,
        { reason: "Mencabut owner terakhir." },
        ownerA,
      ),
    ).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM role_assignments
       WHERE tenant_id = $1 AND valid_until IS NULL`,
      [tenant.tenantId],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it("§3.7 two Owners ending each other at once never deadlock and one Owner remains", async () => {
    const founder = await signedIn("Race Owner Founder");
    const tenant = await createTenant(founder);
    const ownerA = await signedIn("Race Owner A");
    const ownerB = await signedIn("Race Owner B");
    const assignmentA = await assign(
      tenant.tenantId,
      ownerA,
      tenant.ownerRoleId,
      founder,
    );
    const assignmentB = await assign(
      tenant.tenantId,
      ownerB,
      tenant.ownerRoleId,
      founder,
    );
    const context = scopedContext(tenant.tenantId);

    const results = await Promise.allSettled([
      endRoleAssignment(context, assignmentB, { reason: "Rotasi A." }, ownerA),
      endRoleAssignment(context, assignmentA, { reason: "Rotasi B." }, ownerB),
    ]);
    // Exactly one wins; the loser waited on the per-tenant lock, then found
    // it is no longer an Owner and is refused cleanly (403), never a deadlock
    // (40P01) surfacing as a 500.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
    });
    const { rows } = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM role_assignments
       WHERE tenant_id = $1 AND valid_until IS NULL`,
      [tenant.tenantId],
    );
    expect(rows[0]!.count).toBe(1);
  });
});
