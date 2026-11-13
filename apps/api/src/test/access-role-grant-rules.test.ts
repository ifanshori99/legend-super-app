// legend-sjq5w (createCustomRole self-elevation) and legend-wc69d (a non-Owner
// must not give the Owner role). Tier K (access). Fail-first HTTP tests: written
// from the brief docs/briefs/ws01-grant-rules.md and the shared access contract
// (packages/shared/src/access), not from the service code.
//
// Assumptions (brief ambiguity):
// - The seeded Cafe Legend tenant is the caller's tenant (session source), as
//   in access-audit.test.ts. Test users get permanent tenant-scope assignments
//   by direct insert; the session is marked MFA-verified (fresh re-auth).
// - "Permissions the creator holds" means the union of the permissions of the
//   creator's roles in force at tenant scope. Held = menu.item.view and the
//   access.role.* codes; not held = inventory.stock.view.
// - A refused create is HTTP 403 with error code SELF_ELEVATION_FORBIDDEN
//   (brief). A refused Owner grant is only asserted as HTTP 403 plus no row
//   (the brief does not name the code).
// - "Other tenant" = a user who manages roles in a second tenant but holds no
//   assignment in the seeded tenant. Asserted: 403 and no role created in the
//   seeded tenant (the resolved tenant is not part of the API input).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  ROLE_GRANT_REAUTH_MAX_AGE_MS,
  cafeLegendAccessFixtures,
} from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { deleteHires, seedHire } from "./hire-seed";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung: string = cafeLegendAccessFixtures.outletIds.bandung;
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");

const createdRoleIds: string[] = [];
const createdAssignmentIds: string[] = [];
const createdHireIds: string[] = [];
const otherTenantIds: string[] = [];
const createdUserIds: string[] = [];

const HELD = ["access.role.view", "access.role.manage", "menu.item.view"];
const NOT_HELD = "inventory.stock.view";

async function signedIn(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  await verifySessionMfa(email);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role for the seeded tenant`);
  return rows[0].id;
}

async function insertCustomRole(
  forTenant: string,
  permissions: readonly string[],
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, false, NULL, $3::jsonb, false, '["tenant"]'::jsonb)
     RETURNING id`,
    [forTenant, `Peran uji ${unique()}`, JSON.stringify(permissions)],
  );
  createdRoleIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function assign(forTenant: string, userId: string, roleId: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)
     RETURNING id`,
    [forTenant, userId, roleId],
  );
  createdAssignmentIds.push(rows[0]!.id);
}

/** A signed-in user whose only role is a custom one with these permissions. */
async function managerWith(permissions: readonly string[], name: string) {
  const user = await signedIn(name);
  await assign(
    tenantId,
    user.userId,
    await insertCustomRole(tenantId, permissions),
  );
  return user;
}

const createRole = (
  client: ReturnType<typeof agent>,
  name: string,
  permissions: readonly string[],
) =>
  client
    .post("/api/access/roles")
    .set(originHeader)
    .send({ name, permissions, allowedScopeTypes: ["tenant"] });

async function rolesNamed(name: string) {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND name = $2",
    [tenantId, name],
  );
  createdRoleIds.push(...rows.map((row) => row.id));
  return rows;
}

async function assignmentCount(userId: string) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
  return rowCount;
}

afterAll(async () => {
  await deleteHires(db, tenantId, createdHireIds);
  if (createdAssignmentIds.length > 0)
    await db.query("DELETE FROM role_assignments WHERE id = ANY($1::uuid[])", [
      createdAssignmentIds,
    ]);
  if (createdUserIds.length > 0)
    await db
      .query("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
        createdUserIds,
      ])
      .catch(() => undefined);
  if (createdRoleIds.length > 0)
    await db.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  if (otherTenantIds.length > 0) {
    await db.query(
      "DELETE FROM role_assignments WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await db.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
    await db.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  await db.end();
});

describe("legend-sjq5w createCustomRole over the API enforces grant rules", () => {
  it("legend-sjq5w a user without access.role.manage cannot create a role", async () => {
    const viewer = await managerWith(
      ["access.role.view", "menu.item.view"],
      "Sjq5w viewer",
    );
    const name = `Tanpa izin ${unique()}`;
    const response = await createRole(viewer.client, name, ["menu.item.view"]);
    expect(response.status).toBe(403);
    expect(await rolesNamed(name)).toHaveLength(0);
  });

  it("legend-sjq5w a manager of another tenant cannot create a role in this tenant", async () => {
    const outsider = await signedIn("Sjq5w other tenant manager");
    const otherTenantId = randomUUID();
    otherTenantIds.push(otherTenantId);
    await db.query(
      `INSERT INTO tenants
         (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared',
               '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
      [otherTenantId, `sjq5w-other-${otherTenantId}`, outsider.userId],
    );
    const otherRole = await insertCustomRole(otherTenantId, HELD);
    await assign(otherTenantId, outsider.userId, otherRole);

    const name = `Lintas tenant ${unique()}`;
    const response = await createRole(outsider.client, name, [
      "menu.item.view",
    ]);
    expect(response.status).toBe(403);
    expect(await rolesNamed(name)).toHaveLength(0);
  });

  it("legend-sjq5w a manager cannot put a permission they do not hold into a new role", async () => {
    const manager = await managerWith(HELD, "Sjq5w manager over");
    const name = `Melebihi milik ${unique()}`;
    const response = await createRole(manager.client, name, [
      "menu.item.view",
      NOT_HELD,
    ]);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
    expect(await rolesNamed(name)).toHaveLength(0);
  });

  it("legend-sjq5w a permission held only at one outlet does not count at tenant scope", async () => {
    const manager = await managerWith(HELD, "Sjq5w manager outlet only");
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO roles
         (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, false, NULL, $3::jsonb, false, '["outlet"]'::jsonb)
       RETURNING id`,
      [tenantId, `Peran outlet ${unique()}`, JSON.stringify([NOT_HELD])],
    );
    createdRoleIds.push(rows[0]!.id);
    const outletAssignment = await db.query<{ id: string }>(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)
       RETURNING id`,
      [tenantId, manager.userId, rows[0]!.id, bandung],
    );
    createdAssignmentIds.push(outletAssignment.rows[0]!.id);

    const name = `Hanya outlet ${unique()}`;
    const response = await createRole(manager.client, name, [NOT_HELD]);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
    expect(await rolesNamed(name)).toHaveLength(0);
  });

  it("legend-sjq5w a manager can create a role holding only permissions they hold", async () => {
    const manager = await managerWith(HELD, "Sjq5w manager ok");
    const name = `Dalam batas ${unique()}`;
    const response = await createRole(manager.client, name, ["menu.item.view"]);
    expect(response.status).toBe(201);
    createdRoleIds.push(response.body.data.id as string);
    expect(response.body.data.permissions).toEqual(["menu.item.view"]);
  });
});

describe("legend-sjq5w an Admin Tenant may exceed their own permissions only with fresh re-auth", () => {
  // Admin Tenant does not hold inventory.stock.view (roles.ts), so adding it
  // to a new role is a grant beyond what the creator holds.
  async function adminWithMfaAge(name: string, ageMs: number) {
    const admin = await signedIn(name);
    await assign(tenantId, admin.userId, await roleIdOf("tenant_admin"));
    await db.query(
      // A session row may not have its second factor older than the session
      // itself, so an old re-auth needs an equally old session.
      `UPDATE "session"
       SET mfa_verified_at = $2,
           created_at = LEAST(created_at, $2::timestamptz - interval '1 minute')
       WHERE revoked_at IS NULL AND user_id = $1`,
      [admin.userId, new Date(Date.now() - ageMs)],
    );
    return admin;
  }

  it("legend-sjq5w an Admin Tenant with fresh MFA re-auth can create a role with a permission they do not hold", async () => {
    const admin = await adminWithMfaAge("Sjq5w admin fresh", 0);
    const name = `Admin segar ${unique()}`;
    const response = await createRole(admin.client, name, [NOT_HELD]);
    expect(response.status).toBe(201);
    createdRoleIds.push(response.body.data.id as string);
    expect(response.body.data.permissions).toEqual([NOT_HELD]);
  });

  it("legend-sjq5w an Admin Tenant whose re-auth is older than 5 minutes is refused with SELF_ELEVATION_FORBIDDEN", async () => {
    const admin = await adminWithMfaAge(
      "Sjq5w admin stale",
      ROLE_GRANT_REAUTH_MAX_AGE_MS + 60_000,
    );
    const name = `Admin basi ${unique()}`;
    const response = await createRole(admin.client, name, [NOT_HELD]);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SELF_ELEVATION_FORBIDDEN");
    expect(await rolesNamed(name)).toHaveLength(0);
  });
});

describe("legend-wc69d a non-Owner cannot hand out the Owner role over the API", () => {
  async function newHire(name: string) {
    const grantee = await signedIn(name);
    createdHireIds.push(
      await seedHire(db, {
        tenantId,
        userId: grantee.userId,
        outletId: bandung,
      }),
    );
    return grantee;
  }

  const grant = (
    client: ReturnType<typeof agent>,
    userId: string,
    roleId: string,
    scope: { type: "tenant"; id: null } | { type: "outlet"; id: string },
  ) =>
    client
      .post("/api/access/role-assignments")
      .set(originHeader)
      .send({ userId, roleId, scope });

  it("legend-wc69d an Admin Tenant granting the Owner role is refused with 403", async () => {
    const admin = await signedIn("Wc69d admin");
    await assign(tenantId, admin.userId, await roleIdOf("tenant_admin"));
    const grantee = await newHire("Wc69d grantee owner");

    const response = await grant(
      admin.client,
      grantee.userId,
      await roleIdOf("owner"),
      { type: "tenant", id: null },
    );
    expect(response.status).toBe(403);
    expect(await assignmentCount(grantee.userId)).toBe(0);
  });

  it("legend-wc69d a granter cannot give a role that holds permissions they lack", async () => {
    const granter = await managerWith(
      ["access.role.view", "access.role.assign", "menu.item.view"],
      "Wc69d limited granter",
    );
    const grantee = await newHire("Wc69d grantee finance");

    const response = await grant(
      granter.client,
      grantee.userId,
      await roleIdOf("finance"),
      { type: "tenant", id: null },
    );
    expect(response.status).toBe(403);
    expect(await assignmentCount(grantee.userId)).toBe(0);
  });

  it("legend-wc69d an Admin Tenant can still grant a role within their own permissions", async () => {
    const admin = await signedIn("Wc69d admin control");
    await assign(tenantId, admin.userId, await roleIdOf("tenant_admin"));
    const grantee = await newHire("Wc69d grantee cashier");

    const response = await grant(
      admin.client,
      grantee.userId,
      await roleIdOf("cashier"),
      { type: "outlet", id: bandung },
    );
    expect(response.status).toBe(201);
    expect(await assignmentCount(grantee.userId)).toBe(1);
  });
});
