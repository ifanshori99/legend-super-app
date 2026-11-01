// RBAC engine API (bead legend-4f9; PRD v1.7 §3.7 RBAC, Organisasi & Matriks
// Approval, §6 B, TEN-03/TEN-04) and GET /api/me/access (legend-t4y7).
// HTTP tests run the real Express app, Better Auth and PostgreSQL; the DB-role
// isolation for the new tables lives in platform-access-db.test.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  grantRoleSchema,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer";
import { grantRoleAssignment } from "../services/access.service";
import { agent, originHeader, setRole, signUp } from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const audits: AuditEntry[] = [];

function scopedContext(tenantId = seededTenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

async function signedIn(name = "RBAC user") {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function roleIdOf(
  templateKey: string,
  tenantId = seededTenantId,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0])
    throw new Error(`No ${templateKey} role for tenant ${tenantId}`);
  return rows[0].id;
}

async function assign(
  userId: string,
  templateKey: string,
  scope: { type: string; id?: string } = { type: "tenant" },
): Promise<{ id: string }> {
  const { rows } = await owner.query<{ id: string }>(
    // Backdate one minute: the test database runs in a container whose clock
    // may drift sub-second from the Node clock the resolver reads.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)
     RETURNING id`,
    [
      seededTenantId,
      userId,
      await roleIdOf(templateKey),
      scope.type,
      scope.id ?? null,
    ],
  );
  return rows[0]!;
}

const unique = () => randomBytes(4).toString("hex");

beforeAll(() => {
  // The real audit service (legend-4sc) is not on main yet; the port's default
  // fails closed, so install a recording writer for the write paths here.
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry);
    },
  });
});

afterAll(async () => {
  setAuditWriter(null);
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await owner.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, createdRoleIds],
    );
  await owner.end();
});

describe("legend-t4y7 GET /api/me/access", () => {
  it("TEN-03 fails closed without an assignment and lists effective codes with one", async () => {
    expect((await agent(app).get("/api/me/access")).status).toBe(401);

    const plain = await signedIn("No role");
    const empty = await plain.client.get("/api/me/access");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({
      permissions: [],
      mfaRequired: false,
      mfaVerified: false,
    });

    const ownerUser = await signedIn("Owner Access");
    await assign(ownerUser.userId, "owner");
    const access = await ownerUser.client.get("/api/me/access");
    expect(access.status).toBe(200);
    expect(access.body.data.permissions).toContain("org.structure.manage");
    expect(access.body.data.permissions).toContain("access.role.view");
    expect(access.body.data.mfaRequired).toBe(true);
    expect(access.body.data.mfaVerified).toBe(false);
    expect(
      access.body.data.permissions.some((code: string) =>
        code.startsWith("platform."),
      ),
    ).toBe(false);
  });
});

describe("TEN-04 platform and tenant authority are separate", () => {
  it("TEN-04 a global Better Auth admin without tenant membership is denied", async () => {
    const client = agent(app);
    const email = await signUp(client, "Legacy Admin");
    await setRole(email, "admin");
    const session = await client.get("/api/auth/get-session");
    createdUserIds.push(session.body.user.id as string);

    expect((await client.get("/api/org/brands")).status).toBe(403);
    expect((await client.get("/api/access/roles")).status).toBe(403);
    const write = await client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug: `legacy-${unique()}`, name: "Legacy", logoMediaId: null });
    expect(write.status).toBe(403);
  });
});

describe("TEN-03 tenant routes use stored assignments", () => {
  it("TEN-03 an owner reaches tenant org routes while an outlet role cannot", async () => {
    const ownerUser = await signedIn("Owner Org");
    await assign(ownerUser.userId, "owner");
    const brand = await ownerUser.client
      .post("/api/org/brands")
      .set(originHeader)
      .send({
        slug: `rbac-${unique()}`,
        name: "Brand RBAC",
        logoMediaId: null,
      });
    expect(brand.status).toBe(201);

    const cashier = await signedIn("Cashier Org");
    await assign(cashier.userId, "cashier", { type: "outlet", id: bandung });
    const denied = await cashier.client
      .post("/api/org/brands")
      .set(originHeader)
      .send({ slug: `rbac-${unique()}`, name: "Denied", logoMediaId: null });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("§3.7 role templates and custom roles", () => {
  it("§3.7 seeds the 17 tenant templates and validates custom roles against the catalog", async () => {
    const admin = await signedIn("Role Admin");
    await assign(admin.userId, "owner");

    const listed = await admin.client.get("/api/access/roles");
    expect(listed.status).toBe(200);
    const templates = listed.body.data.filter(
      (role: { isTemplate: boolean }) => role.isTemplate,
    );
    expect(templates).toHaveLength(17);
    const keys = templates.map(
      (role: { templateKey: string | null }) => role.templateKey,
    );
    for (const key of [
      "owner",
      "tenant_admin",
      "general_manager",
      "finance",
      "employee",
    ])
      expect(keys).toContain(key);
    expect(keys).not.toContain("super_admin");

    const platform = await admin.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Platform ${unique()}`,
        permissions: ["platform.tenant.manage"],
        allowedScopeTypes: ["tenant"],
      });
    expect(platform.status).toBe(422);

    const custom = await admin.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Payroll operator ${unique()}`,
        permissions: ["payroll.lock", "payroll.view"],
        allowedScopeTypes: ["tenant"],
      });
    expect(custom.status).toBe(201);
    createdRoleIds.push(custom.body.data.id);
    expect(custom.body.data.isTemplate).toBe(false);
    expect(custom.body.data.templateKey).toBeNull();
    // AUTH-05: a custom role reaching payroll requires MFA.
    expect(custom.body.data.mfaRequired).toBe(true);

    const updated = await admin.client
      .patch(`/api/access/roles/${custom.body.data.id}`)
      .set(originHeader)
      .send({ permissions: ["payroll.lock"] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.permissions).toEqual(["payroll.lock"]);
    const roleEvents = await owner.query<{ name: string; sequence: string }>(
      `SELECT event->>'name' AS name, sequence FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_type = 'role' AND aggregate_id = $2
       ORDER BY sequence`,
      [seededTenantId, custom.body.data.id],
    );
    expect(roleEvents.rows.map((row) => [row.name, row.sequence])).toEqual([
      ["role.created", "1"],
      ["role.updated", "2"],
    ]);

    const template = templates.find(
      (role: { templateKey: string | null }) => role.templateKey === "owner",
    );
    const patch = await admin.client
      .patch(`/api/access/roles/${template.id}`)
      .set(originHeader)
      .send({ name: "Renamed template" });
    expect(patch.status).toBe(422);

    expect(
      audits.some(
        (entry) =>
          entry.action === "role.created" &&
          entry.objectId === custom.body.data.id,
      ),
    ).toBe(true);
    expect(
      audits.some(
        (entry) =>
          entry.action === "role.created" &&
          entry.actorId === admin.userId &&
          entry.tenantId === seededTenantId,
      ),
    ).toBe(true);
  });
});

describe("§3.7 no self-elevation through role edits or assignment ends", () => {
  it("§3.7 refuses adding rights to a role the editor holds; others may", async () => {
    const owner1 = await signedIn("Role Owner");
    await assign(owner1.userId, "owner");
    const created = await owner1.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Role editor ${unique()}`,
        permissions: ["access.role.view", "access.role.manage"],
        allowedScopeTypes: ["tenant"],
      });
    expect(created.status).toBe(201);
    const roleId = created.body.data.id as string;
    createdRoleIds.push(roleId);

    const editor = await signedIn("Role Editor");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $4)`,
      [seededTenantId, editor.userId, roleId, owner1.userId],
    );

    const elevate = await editor.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({
        permissions: ["access.role.view", "access.role.manage", "payroll.view"],
      });
    expect(elevate.status).toBe(403);
    expect(elevate.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
    const rename = await editor.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({ name: `Role editor renamed ${unique()}` });
    expect(rename.status).toBe(200);

    const byOwner = await owner1.client
      .patch(`/api/access/roles/${roleId}`)
      .set(originHeader)
      .send({
        permissions: [
          "access.role.view",
          "access.role.manage",
          "audit.log.view",
        ],
      });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.data.permissions).toContain("audit.log.view");
  });

  it("§3.7 a role editor may add a permission they hold but not one they lack", async () => {
    const boss = await signedIn("Held Permission Owner");
    await assign(boss.userId, "owner");
    const target = await boss.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Held target ${unique()}`,
        permissions: ["access.role.view", "access.role.manage"],
        allowedScopeTypes: ["tenant"],
      });
    expect(target.status).toBe(201);
    const targetId = target.body.data.id as string;
    createdRoleIds.push(targetId);
    const editorRole = await boss.client
      .post("/api/access/roles")
      .set(originHeader)
      .send({
        name: `Held editor ${unique()}`,
        permissions: ["access.role.manage", "report.operational.view"],
        allowedScopeTypes: ["tenant"],
      });
    expect(editorRole.status).toBe(201);
    createdRoleIds.push(editorRole.body.data.id);

    const editor = await signedIn("Held Permission Editor");
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $4)`,
      [seededTenantId, editor.userId, editorRole.body.data.id, boss.userId],
    );

    // The editor holds report.operational.view through their own role, so the
    // grant rule allows adding it to another custom role.
    const held = await editor.client
      .patch(`/api/access/roles/${targetId}`)
      .set(originHeader)
      .send({
        permissions: [
          "access.role.view",
          "access.role.manage",
          "report.operational.view",
        ],
      });
    expect(held.status).toBe(200);
    expect(held.body.data.permissions).toContain("report.operational.view");

    // payroll.view is not held and the session has no re-auth, so still 403.
    const unheld = await editor.client
      .patch(`/api/access/roles/${targetId}`)
      .set(originHeader)
      .send({
        permissions: [
          "access.role.view",
          "access.role.manage",
          "report.operational.view",
          "payroll.view",
        ],
      });
    expect(unheld.status).toBe(403);
    expect(unheld.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
  });

  it("§3.7 ending an assignment never extends or re-activates it", async () => {
    const grantor = await signedIn("End Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedIn("End Grantee");
    const now = new Date();
    const assignment = await grantRoleAssignment(
      scopedContext(),
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("supervisor"),
        scope: { type: "outlet", id: bandung },
        validFrom: new Date(now.getTime() - 3_600_000).toISOString(),
        validUntil: new Date(now.getTime() - 1_800_000).toISOString(),
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: now,
        mfaVerified: true,
      },
    );
    const revive = await grantor.client
      .post(`/api/access/role-assignments/${assignment.id}/end`)
      .set(originHeader)
      .send({
        validUntil: new Date(now.getTime() + 86_400_000).toISOString(),
        reason: "Coba aktifkan lagi.",
      });
    expect(revive.status).toBe(422);
    const access = await grantee.client.get("/api/me/access");
    expect(access.body.data.permissions).toEqual([]);
  });
});

describe("§3.7 Pemberian Role", () => {
  it("§3.7 blocks self-grant and requires a recent re-authentication", async () => {
    const grantor = await signedIn("Grantor");
    await assign(grantor.userId, "owner");
    const cashierRole = await roleIdOf("cashier");

    const self = await grantor.client
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId: grantor.userId,
        roleId: cashierRole,
        scope: { type: "outlet", id: bandung },
      });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");

    const grantee = await signedIn("Grantee");
    const noReauth = await grantor.client
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({
        userId: grantee.userId,
        roleId: cashierRole,
        scope: { type: "outlet", id: bandung },
      });
    // No factor store yet (lib/mfa.ts), so re-auth is absent and denied.
    expect(noReauth.status).toBe(401);
    expect(noReauth.body.error.code).toBe("REAUTH_REQUIRED");
  });

  it("TEN-03 a verified grant is scoped, audited, emitted and revocable", async () => {
    const grantor = await signedIn("Service Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedIn("Service Grantee");
    const context = scopedContext();
    const assignment = await grantRoleAssignment(
      context,
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("cashier"),
        scope: { type: "outlet", id: bandung },
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: new Date(),
        mfaVerified: true,
      },
    );
    expect(assignment.scope).toEqual({ type: "outlet", id: bandung });

    const access = await grantee.client.get("/api/me/access");
    expect(access.body.data.permissions).toContain("pos.sale.create");
    expect(access.body.data.permissions).not.toContain("org.structure.manage");

    expect(
      audits.some(
        (entry) =>
          entry.action === "role_assignment.granted" &&
          entry.objectId === assignment.id,
      ),
    ).toBe(true);
    const outbox = await owner.query<{
      aggregate_type: string;
      sequence: string;
    }>(
      `SELECT aggregate_type, sequence FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_id = $2`,
      [seededTenantId, assignment.id],
    );
    expect(outbox.rows).toEqual([
      { aggregate_type: "role_assignment", sequence: "1" },
    ]);

    const ended = await grantor.client
      .post(`/api/access/role-assignments/${assignment.id}/end`)
      .set(originHeader)
      .send({ reason: "Penugasan uji sudah selesai." });
    expect(ended.status).toBe(200);
    expect(ended.body.data.validUntil).not.toBeNull();
    const after = await grantee.client.get("/api/me/access");
    expect(after.body.data.permissions).not.toContain("pos.sale.create");
  });

  it("TEN-03 an expired assignment grants nothing", async () => {
    const grantor = await signedIn("Window Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedIn("Window Grantee");
    const now = new Date();
    const assignment = await grantRoleAssignment(
      scopedContext(),
      grantRoleSchema.parse({
        userId: grantee.userId,
        roleId: await roleIdOf("supervisor"),
        scope: { type: "outlet", id: bandung },
        validFrom: new Date(now.getTime() - 3_600_000).toISOString(),
        validUntil: new Date(now.getTime() - 1_800_000).toISOString(),
      }),
      {
        actorUserId: grantor.userId,
        reauthenticatedAt: now,
        mfaVerified: true,
      },
    );
    expect(assignment.validUntil).not.toBeNull();
    const access = await grantee.client.get("/api/me/access");
    expect(access.body.data.permissions).toEqual([]);
  });

  it("TEN-03 a role from another tenant is unreachable", async () => {
    const grantor = await signedIn("Cross Tenant Grantor");
    await assign(grantor.userId, "owner");
    const grantee = await signedIn("Cross Tenant Grantee");
    const otherTenant = randomUUID();
    const foreignRole = randomUUID();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'RBAC other tenant', 'lengkap', 'active', 'shared', '{"modules":[]}', '{}', $3)`,
      [otherTenant, `rbac-other-${otherTenant}`, grantor.userId],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
       VALUES ($1, $2, 'Foreign role', '["org.structure.manage"]', '["tenant"]')`,
      [foreignRole, otherTenant],
    );
    try {
      await expect(
        grantRoleAssignment(
          scopedContext(),
          grantRoleSchema.parse({
            userId: grantee.userId,
            roleId: foreignRole,
            scope: { type: "tenant", id: null },
          }),
          {
            actorUserId: grantor.userId,
            reauthenticatedAt: new Date(),
            mfaVerified: true,
          },
        ),
      ).rejects.toMatchObject({ status: 404 });
      const roles = await grantor.client.get("/api/access/roles");
      expect(
        roles.body.data.some((role: { id: string }) => role.id === foreignRole),
      ).toBe(false);
    } finally {
      await owner.query("DELETE FROM roles WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
    }
  });
});

describe("§3.7 Matriks Approval", () => {
  it("§3.7 saves tiers and rejects a matrix with a missing level", async () => {
    const admin = await signedIn("Matrix Admin");
    await assign(admin.userId, "owner");
    const supervisor = await roleIdOf("supervisor");
    const outletManager = await roleIdOf("outlet_manager");

    const saved = await admin.client
      .put("/api/access/approval-policies")
      .set(originHeader)
      .send({
        policies: [
          {
            actionType: "void",
            thresholdIdr: null,
            approverRoleId: supervisor,
            levels: 1,
          },
          {
            actionType: "refund",
            thresholdIdr: 500_000,
            approverRoleId: supervisor,
            levels: 1,
          },
          {
            actionType: "refund",
            thresholdIdr: 500_000,
            approverRoleId: outletManager,
            levels: 2,
          },
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toHaveLength(3);
    expect(
      saved.body.data.every(
        (row: { requiresDistinctActor: boolean }) =>
          row.requiresDistinctActor === true,
      ),
    ).toBe(true);

    const listed = await admin.client.get("/api/access/approval-policies");
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(3);

    const gap = await admin.client
      .put("/api/access/approval-policies")
      .set(originHeader)
      .send({
        policies: [
          {
            actionType: "refund",
            thresholdIdr: 500_000,
            approverRoleId: outletManager,
            levels: 2,
          },
        ],
      });
    expect(gap.status).toBe(422);

    expect(
      audits.some(
        (entry) =>
          entry.action === "approval_policy.changed" &&
          entry.tenantId === seededTenantId,
      ),
    ).toBe(true);
    const events = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM domain_event_outbox
       WHERE tenant_id = $1 AND aggregate_type = 'approval_policy'`,
      [seededTenantId],
    );
    expect(events.rows[0]!.count).toBeGreaterThan(0);
  });
});
