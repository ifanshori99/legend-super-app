// legend-7vsby: the Owner template may only be granted by a real Owner.
// A custom role that merely repeats every Owner permission must not let its
// holder hand out the Owner template (privilege escalation chain:
// Admin Tenant -> custom role C -> account B -> Owner template for account A).
// Integration tests run the real services against PostgreSQL with RLS; each
// test gets its own tenant so assignments are not shared.
//
// Assumptions (spec/brief ambiguity):
// - The owner-only permission set is exactly ["pos.receipt.writeoff"].
// - A refused grant is AccessError code PERMISSION_DENIED, HTTP 403; an
//   owner-only code in a custom role is PERMISSION_OWNER_ONLY, HTTP 422.
// - The brand-scoped-owner case is covered by the pure contract test (it
//   needs brand fixtures); here an expired Owner assignment stands in.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCustomRoleSchema,
  grantRoleSchema,
  roleTemplate,
  updateCustomRoleSchema,
  type PermissionCode,
} from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer";
import {
  createCustomRole,
  grantRoleAssignment,
  listRoles,
  updateCustomRole,
} from "../services/access.service";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver";
import { agent, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantIds: string[] = [];

const WRITEOFF = "pos.receipt.writeoff";
const ALL_OWNER_CODES: readonly PermissionCode[] =
  roleTemplate("owner").permissions;
const OWNER_CODES_WITHOUT_WRITEOFF = ALL_OWNER_CODES.filter(
  (code) => code !== WRITEOFF,
);
const TENANT_SCOPE = { type: "tenant", id: null } as const;

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
    templateKey: string | null;
    permissions: readonly string[];
    allowedScopeTypes: readonly string[];
  },
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, $4, $5::jsonb, true, $6::jsonb)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.templateKey !== null,
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
     VALUES ($1, $2, 'Owner grant', 'lengkap', 'active', 'shared',
             '{"modules":[],"integrationProviders":[]}', '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $3)`,
    [tenantId, `owner-grant-${tenantId}`, founderId],
  );
  const ownerRoleId = await insertRole(tenantId, {
    name: "Owner",
    templateKey: "owner",
    permissions: ALL_OWNER_CODES,
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
  // legend-495 G2: a grantee must already belong to the tenant. This role
  // carries no permission; it only stands for "already on the team".
  const memberRoleId = await insertRole(tenantId, {
    name: "Team member",
    templateKey: null,
    permissions: [],
    allowedScopeTypes: ["tenant"],
  });
  return { tenantId, ownerRoleId, adminRoleId, financeRoleId, memberRoleId };
}

async function assign(
  tenantId: string,
  userId: string,
  roleId: string,
  assignedBy: string,
  window: { from: string; until: string | null } = {
    // Backdate: a container clock may drift from the Node clock.
    from: "now() - interval '1 minute'",
    until: null,
  },
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, 'tenant', ${window.from}, ${window.until ?? "NULL"}, $4)
     RETURNING id`,
    [tenantId, userId, roleId, assignedBy],
  );
  return rows[0]!.id;
}

/** A signed-in account that is already on the tenant's team (G2). */
async function signedInMember(
  tenant: Awaited<ReturnType<typeof createTenant>>,
  founder: string,
  name: string,
) {
  const userId = await signedIn(name);
  await assign(tenant.tenantId, userId, tenant.memberRoleId, founder);
  return userId;
}

const freshAuth = () => ({ reauthenticatedAt: new Date(), mfaVerified: true });

async function grantOwnerTemplate(
  tenantId: string,
  ownerRoleId: string,
  grantor: string,
  targetUser: string,
) {
  return grantRoleAssignment(
    scopedContext(tenantId),
    grantRoleSchema.parse({
      userId: targetUser,
      roleId: ownerRoleId,
      scope: TENANT_SCOPE,
    }),
    { actorUserId: grantor, ...freshAuth() },
  );
}

/** Tenant admin makes custom role C and grants it to account B. */
async function adminGrantsCustomRoleToB(
  tenant: Awaited<ReturnType<typeof createTenant>>,
  founder: string,
  customRoleId: string,
) {
  const admin = await signedIn("Owner Grant Admin");
  await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
  const accountB = await signedInMember(
    tenant,
    founder,
    "Owner Grant Account B",
  );
  await grantRoleAssignment(
    scopedContext(tenant.tenantId),
    grantRoleSchema.parse({
      userId: accountB,
      roleId: customRoleId,
      scope: TENANT_SCOPE,
    }),
    { actorUserId: admin, ...freshAuth() },
  );
  return { admin, accountB };
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

describe("legend-7vsby only an Owner may grant the Owner template", () => {
  it("legend-7vsby a custom role with every Owner permission cannot grant the Owner template (403)", async () => {
    const founder = await signedIn("Chain Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Chain Admin");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
    const context = scopedContext(tenant.tenantId);

    // Step 1 of the chain on the base code: the admin builds an exact Owner
    // clone. Write-off is Owner-only now, so that clone is refused outright.
    await expect(
      createCustomRole(
        context,
        createCustomRoleSchema.parse({
          name: `Owner clone ${randomBytes(4).toString("hex")}`,
          permissions: ALL_OWNER_CODES,
          allowedScopeTypes: ["tenant"],
        }),
        admin,
      ),
    ).rejects.toMatchObject({ status: 422, code: "PERMISSION_OWNER_ONLY" });

    // C holds every Owner code the service still allows. `now` must not be
    // earlier than the re-auth time (negative age drops the Owner/Admin
    // bypass and flakes under load), so reuse the re-auth instant.
    const fresh = freshAuth();
    const roleC = await createCustomRole(
      context,
      createCustomRoleSchema.parse({
        name: `Almost owner ${randomBytes(4).toString("hex")}`,
        permissions: OWNER_CODES_WITHOUT_WRITEOFF,
        allowedScopeTypes: ["tenant"],
      }),
      admin,
      fresh.reauthenticatedAt,
      fresh,
    );
    const accountB = await signedInMember(tenant, founder, "Chain Account B");
    await grantRoleAssignment(
      context,
      grantRoleSchema.parse({
        userId: accountB,
        roleId: roleC.id,
        scope: TENANT_SCOPE,
      }),
      { actorUserId: admin, ...freshAuth() },
    );
    const accountA = await signedInMember(tenant, founder, "Chain Account A");

    await expect(
      grantOwnerTemplate(
        tenant.tenantId,
        tenant.ownerRoleId,
        accountB,
        accountA,
      ),
    ).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
    const { rows } = await owner.query(
      "SELECT 1 FROM role_assignments WHERE tenant_id = $1 AND user_id = $2 AND role_id <> $3",
      [tenant.tenantId, accountA, tenant.memberRoleId],
    );
    expect(rows).toHaveLength(0);
  });

  it("legend-7vsby old data: a custom role stored with ALL Owner codes (incl. write-off) still cannot grant the Owner template (403)", async () => {
    const founder = await signedIn("Legacy Chain Founder");
    const tenant = await createTenant(founder);
    const legacyRoleId = await insertRole(tenant.tenantId, {
      name: `Legacy owner clone ${randomBytes(4).toString("hex")}`,
      templateKey: null,
      permissions: ALL_OWNER_CODES,
      allowedScopeTypes: ["tenant"],
    });
    const { accountB } = await adminGrantsCustomRoleToB(
      tenant,
      founder,
      legacyRoleId,
    );
    const accountA = await signedInMember(
      tenant,
      founder,
      "Legacy Chain Account A",
    );

    await expect(
      grantOwnerTemplate(
        tenant.tenantId,
        tenant.ownerRoleId,
        accountB,
        accountA,
      ),
    ).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
  });

  it("legend-7vsby an expired Owner assignment is not enough, even with a custom role holding every Owner permission (403)", async () => {
    const founder = await signedIn("Expired Owner Founder");
    const tenant = await createTenant(founder);
    const cloneRoleId = await insertRole(tenant.tenantId, {
      name: `Owner clone ${randomBytes(4).toString("hex")}`,
      templateKey: null,
      permissions: OWNER_CODES_WITHOUT_WRITEOFF,
      allowedScopeTypes: ["tenant"],
    });
    const { accountB } = await adminGrantsCustomRoleToB(
      tenant,
      founder,
      cloneRoleId,
    );
    // B used to be an Owner; that assignment ended an hour ago.
    await assign(tenant.tenantId, accountB, tenant.ownerRoleId, founder, {
      from: "now() - interval '2 hours'",
      until: "now() - interval '1 hour'",
    });
    const accountA = await signedInMember(
      tenant,
      founder,
      "Expired Owner Account A",
    );

    await expect(
      grantOwnerTemplate(
        tenant.tenantId,
        tenant.ownerRoleId,
        accountB,
        accountA,
      ),
    ).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
  });

  it("legend-7vsby a real tenant Owner can still grant the Owner template", async () => {
    const founder = await signedIn("Real Owner Founder");
    const tenant = await createTenant(founder);
    const realOwner = await signedIn("Real Owner");
    await assign(tenant.tenantId, realOwner, tenant.ownerRoleId, founder);
    const accountA = await signedInMember(tenant, founder, "Real Owner Target");

    const granted = await grantOwnerTemplate(
      tenant.tenantId,
      tenant.ownerRoleId,
      realOwner,
      accountA,
    );
    expect(granted.userId).toBe(accountA);
    expect(granted.roleId).toBe(tenant.ownerRoleId);
    expect(granted.validUntil).toBeNull();
  });

  it("legend-7vsby other grants are unchanged: Admin Tenant can still grant Finance", async () => {
    const founder = await signedIn("Finance Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Finance Admin");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
    const target = await signedInMember(tenant, founder, "Finance Target");

    const granted = await grantRoleAssignment(
      scopedContext(tenant.tenantId),
      grantRoleSchema.parse({
        userId: target,
        roleId: tenant.financeRoleId,
        scope: TENANT_SCOPE,
      }),
      { actorUserId: admin, ...freshAuth() },
    );
    expect(granted.userId).toBe(target);
    expect(granted.roleId).toBe(tenant.financeRoleId);
  });
});

describe("legend-7vsby owner-only permissions in custom roles", () => {
  it("legend-7vsby createCustomRole refuses pos.receipt.writeoff with 422 PERMISSION_OWNER_ONLY", async () => {
    const founder = await signedIn("Create Owner-only Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Create Owner-only Admin");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);

    await expect(
      createCustomRole(
        scopedContext(tenant.tenantId),
        createCustomRoleSchema.parse({
          name: `Writeoff ${randomBytes(4).toString("hex")}`,
          permissions: ["menu.item.view", WRITEOFF],
          allowedScopeTypes: ["tenant"],
        }),
        admin,
      ),
    ).rejects.toMatchObject({ status: 422, code: "PERMISSION_OWNER_ONLY" });
  });

  it("legend-7vsby updateCustomRole refuses adding pos.receipt.writeoff with 422 PERMISSION_OWNER_ONLY, even for a re-authenticated Admin Tenant", async () => {
    const founder = await signedIn("Update Owner-only Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Update Owner-only Admin");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
    const context = scopedContext(tenant.tenantId);
    const role = await createCustomRole(
      context,
      createCustomRoleSchema.parse({
        name: `Viewer ${randomBytes(4).toString("hex")}`,
        permissions: ["menu.item.view"],
        allowedScopeTypes: ["tenant"],
      }),
      admin,
    );

    await expect(
      updateCustomRole(
        context,
        role.id,
        updateCustomRoleSchema.parse({
          permissions: ["menu.item.view", WRITEOFF],
        }),
        { actorUserId: admin, ...freshAuth() },
      ),
    ).rejects.toMatchObject({ status: 422, code: "PERMISSION_OWNER_ONLY" });
    const { rows } = await owner.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE id = $1",
      [role.id],
    );
    expect(rows[0]!.permissions).toEqual(["menu.item.view"]);
  });
});

describe("legend-7vsby old custom roles that already store pos.receipt.writeoff", () => {
  async function legacyRole() {
    const founder = await signedIn("Old Data Founder");
    const tenant = await createTenant(founder);
    const admin = await signedIn("Old Data Admin");
    await assign(tenant.tenantId, admin, tenant.adminRoleId, founder);
    const roleId = await insertRole(tenant.tenantId, {
      name: `Old writeoff ${randomBytes(4).toString("hex")}`,
      templateKey: null,
      permissions: ["menu.item.view", WRITEOFF],
      allowedScopeTypes: ["tenant"],
    });
    return { founder, tenant, admin, roleId };
  }

  it("legend-7vsby listRoles still lists it without error and hides the write-off code", async () => {
    const { tenant, admin, roleId } = await legacyRole();

    const { data } = await listRoles(scopedContext(tenant.tenantId), admin);
    const listed = data.find((role) => role.id === roleId);
    expect(listed).toBeDefined();
    expect(listed!.permissions).toContain("menu.item.view");
    expect(listed!.permissions).not.toContain(WRITEOFF);
  });

  it("legend-7vsby the permission resolver ignores the write-off code for its holder", async () => {
    const { founder, tenant, roleId } = await legacyRole();
    const holder = await signedIn("Old Data Holder");
    await assign(tenant.tenantId, holder, roleId, founder);
    const context = scopedContext(tenant.tenantId);

    const data = await loadTenantAccess(context, holder);
    const snapshot = resolveAccessSnapshot({
      tenant: context.tenant,
      userId: holder,
      ...data,
      mfaVerified: true,
      now: new Date(),
    });
    expect(snapshot.permissions).toContain("menu.item.view");
    expect(snapshot.permissions).not.toContain(WRITEOFF);
  });

  it("legend-7vsby renaming it (no permissions in the update) succeeds and drops the stored code", async () => {
    const { tenant, admin, roleId } = await legacyRole();

    const renamed = await updateCustomRole(
      scopedContext(tenant.tenantId),
      roleId,
      updateCustomRoleSchema.parse({ name: "Old writeoff renamed" }),
      { actorUserId: admin, ...freshAuth() },
    );
    expect(renamed.name).toBe("Old writeoff renamed");
    expect(renamed.permissions).not.toContain(WRITEOFF);
    const { rows } = await owner.query<{ permissions: string[] }>(
      "SELECT permissions FROM roles WHERE id = $1",
      [roleId],
    );
    expect(rows[0]!.permissions).not.toContain(WRITEOFF);
    expect(rows[0]!.permissions).toContain("menu.item.view");
  });
});
