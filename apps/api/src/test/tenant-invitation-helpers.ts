// Seed helpers for the legend-fy5y first-admin invitation tests. Plain SQL on
// the owner pool (RLS bypass), so the tests do not depend on how the platform
// service creates a tenant. Rows use random ids; the disposable DB is dropped
// after the run.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  tenantIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";

export const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

export function scopedContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

export type SeededInvitation = {
  tenantId: TenantId;
  tenantName: string;
  userId: string;
  email: string;
};

export async function seedInvitationTenant(
  options: {
    /** open = active tenant_admin assignment; ended = lapsed; none = no assignment. */
    assignment?: "open" | "ended" | "none";
    emailVerified?: boolean;
    email?: string;
    banned?: boolean;
    tenantStatus?: "active" | "suspended";
    credentialAccount?: boolean;
  } = {},
): Promise<SeededInvitation> {
  const tenantId = tenantIdSchema.parse(randomUUID());
  const userId = randomUUID();
  const tenantName = `Kedai Undangan ${tenantId.slice(0, 8)}`;
  const email = options.email ?? `inv-${userId}@example.test`;
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned)
     VALUES ($1, 'Admin Pertama', $2, $3, false)`,
    [userId, email, options.emailVerified ?? false],
  );
  await owner.query(
    `INSERT INTO tenants
       (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', $4, 'shared',
             '{"modules":[],"integrationProviders":[]}',
             '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}', $5)`,
    [
      tenantId,
      `undangan-${tenantId}`,
      tenantName,
      options.tenantStatus ?? "active",
      userId,
    ],
  );
  const role = await owner.query<{ id: string }>(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, 'Admin Tenant', true, 'tenant_admin', '[]'::jsonb, true, '["tenant"]'::jsonb)
     RETURNING id`,
    [tenantId],
  );
  const assignment = options.assignment ?? "open";
  if (assignment !== "none")
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, valid_from, valid_until, assigned_by)
       VALUES ($1, $2, $3, 'tenant', now() - interval '2 hours',
               ${assignment === "ended" ? "now() - interval '1 hour'" : "NULL"}, $2)`,
      [tenantId, userId, role.rows[0]!.id],
    );
  // Ban after the grant: the DB guard refuses granting a role to an already
  // banned user, but keeps an assignment when a ban lands later.
  if (options.banned)
    await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [
      userId,
    ]);
  if (options.credentialAccount)
    await owner.query(
      `INSERT INTO "account" (id, account_id, provider_id, user_id, password)
       VALUES ($1, $2, 'credential', $2, 'x')`,
      [randomUUID(), userId],
    );
  return { tenantId, tenantName, userId, email };
}

/** The `#token=` value of an invitation link `<origin>/undangan#token=..&tenant=..`. */
export function tokenOfLink(link: string): string {
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  const token = fragment.get("token");
  if (!token) throw new Error("No token in the invitation link");
  return token;
}
