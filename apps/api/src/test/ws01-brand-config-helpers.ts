// Shared setup for the WS-01 brand/tenant-config HTTP tests (beads legend-bkdmc,
// legend-datb2): HTTP actors that are members of the seeded tenant, with either
// a role template or a custom role holding exactly the listed permissions.
// A throwaway tenant (createTestTenant) is only ever "the other tenant".
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Express } from "express";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { agent, signUp, verifySessionMfa } from "./helpers.ts";

export const seededTenantId = cafeLegendPlatformFixtures.tenant.id;

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

export type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  email: string;
};

export const createdUsers: string[] = [];
export const createdRoles: string[] = [];
const templateRoleCache = new Map<string, string>();

async function newUser(app: Express, name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  createdUsers.push(userId);
  return { client, email, userId };
}

async function assign(tenantId: string, userId: string, roleId: string) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 day', $2, now() - interval '1 day')`,
    [tenantId, userId, roleId],
  );
}

/** A user holding a template role (e.g. tenant_admin, cashier) in the seeded tenant. */
export async function memberOf(
  app: Express,
  template: string,
): Promise<Member> {
  const user = await newUser(app, `Uji ws01 ${template}`);
  let roleId = templateRoleCache.get(template);
  if (!roleId) {
    const found = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [seededTenantId, template],
    );
    roleId = found.rows[0]!.id;
    templateRoleCache.set(template, roleId);
  }
  await assign(seededTenantId, user.userId, roleId);
  await verifySessionMfa(user.email);
  return user;
}

/** A user holding a custom tenant-scoped role with exactly `permissions`. */
export async function memberWith(
  app: Express,
  tenantId: string,
  permissions: string[],
): Promise<Member> {
  const user = await newUser(app, "Uji ws01 izin khusus");
  const roleId = randomUUID();
  createdRoles.push(roleId);
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Uji ws01 ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant"]),
    ],
  );
  await assign(tenantId, user.userId, roleId);
  await verifySessionMfa(user.email);
  return user;
}

export async function cleanupMembers(): Promise<void> {
  await owner
    .query("DELETE FROM role_assignments WHERE user_id = ANY($1::text[])", [
      createdUsers,
    ])
    .catch(() => undefined);
  if (createdRoles.length)
    await owner
      .query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [createdRoles])
      .catch(() => undefined);
}
