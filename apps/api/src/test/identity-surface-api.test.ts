// AUTH-05 gate mounted on the real back-office surfaces (bead legend-qfvu;
// PRD v1.7 §3 F6 "Staf — Login Web", §3 F4 platform panel, TEN-02/03/04).
//
// Unlike identity-mfa-api.test.ts (which proves the gate middleware with probe
// routes and injected facts), this suite drives the production routers:
// /api/org and /api/access behind requireIdentitySurface("back_office") with
// the real RBAC resolver, and /api/platform behind requireSessionMfa().
// Real Express app + Better Auth + PostgreSQL.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const createdTenantIds: string[] = [];

async function signedIn(name: string) {
  const client = agent(app);
  const email = await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, email, userId };
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
  tenantId = seededTenantId,
): Promise<void> {
  await owner.query(
    // Backdate one minute: the test container's clock may drift sub-second from
    // the Node clock the resolver reads.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, await roleIdOf(templateKey, tenantId)],
  );
}

/** Enrolls TOTP and verifies it in this session, the way a staff member does. */
async function enrollAndVerify(
  client: ReturnType<typeof agent>,
): Promise<void> {
  const enrollment = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrollment.status).toBe(201);
  const factor = enrollment.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId: factor.factorId,
      code: totpCode(factor.secretBase32, totpStep(new Date())),
    });
  expect(verified.status).toBe(200);
}

async function platformAdmin(name: string) {
  const user = await signedIn(name);
  await setRole(user.email, "admin");
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [user.userId],
  );
  return user;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [createdUserIds],
    );
    await owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  }
  for (const tenantId of createdTenantIds) {
    await owner.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
    await owner.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
  await owner.end();
});

describe("AUTH-05 back-office gate on /api/org and /api/access", () => {
  it("AUTH-05 denies an MFA role until this session verifies a factor", async () => {
    const user = await signedIn("Kepala Outlet");
    await assign(user.userId, "owner");

    const modules = await user.client.get("/api/org/modules");
    expect(modules.status).toBe(403);
    expect(modules.body.error.code).toBe("MFA_REQUIRED");

    const roles = await user.client.get("/api/access/roles");
    expect(roles.status).toBe(403);
    expect(roles.body.error.code).toBe("MFA_REQUIRED");
  });

  it("AUTH-05 opens the back-office APIs after the session verifies TOTP", async () => {
    const user = await signedIn("Pemilik Outlet");
    await assign(user.userId, "owner");
    await enrollAndVerify(user.client);

    expect((await user.client.get("/api/org/modules")).status).toBe(200);
    expect((await user.client.get("/api/access/roles")).status).toBe(200);

    // The web guard reads the same flag the API gate enforces (legend-t4y7).
    const access = await user.client.get("/api/me/access");
    expect(access.body.data.mfaRequired).toBe(true);
    expect(access.body.data.mfaVerified).toBe(true);
  });

  it("AUTH-05 keeps /api/me/access readable before MFA so the web guard can redirect", async () => {
    const user = await signedIn("Staf Belum MFA");
    await assign(user.userId, "owner");

    const access = await user.client.get("/api/me/access");
    expect(access.status).toBe(200);
    expect(access.body.data.mfaRequired).toBe(true);
    expect(access.body.data.mfaVerified).toBe(false);
  });

  it("AUTH-05 still denies a session whose role does not need MFA, by permission", async () => {
    const user = await signedIn("Karyawan");
    // `employee` is self-service only and mfaRequired: false, so the surface
    // gate has nothing to challenge; the route permission denies.
    await assign(user.userId, "employee");

    const roles = await user.client.get("/api/access/roles");
    expect(roles.status).toBe(403);
    expect(roles.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("AUTH-05 closes an idle management session on the guarded API", async () => {
    const user = await signedIn("Manajer Idle");
    await assign(user.userId, "owner");
    await enrollAndVerify(user.client);
    await owner.query(
      // Idle for 31 minutes: the session must be older than its last activity
      // (sessionSchema: lastSeenAt cannot precede createdAt).
      `UPDATE "session"
       SET created_at = now() - interval '2 hours',
           last_seen_at = now() - interval '31 minutes'
       WHERE user_id = $1`,
      [user.userId],
    );

    // §3 F6 "Sesi & Perangkat": a management session ends after 30 idle minutes.
    const response = await user.client.get("/api/org/modules");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("AUTH-05 closes a revoked session on the guarded API", async () => {
    const user = await signedIn("Sesi Dicabut");
    await assign(user.userId, "owner");
    await verifySessionMfa(user.email);
    await owner.query(
      `UPDATE "session"
       SET revoked_at = now(), expires_at = now() - interval '1 minute'
       WHERE user_id = $1`,
      [user.userId],
    );

    const response = await user.client.get("/api/org/modules");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("TEN-03 an assignment in another tenant cannot open this tenant's back office", async () => {
    const user = await signedIn("Anggota Tenant Lain");
    await verifySessionMfa(user.email);

    const otherTenant = randomUUID();
    createdTenantIds.push(otherTenant);
    // A contract-valid tenant row: other platform tests list tenants and parse
    // every row with tenantSchema, so a half-filled fixture would poison them.
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Tenant lain', 'lengkap', 'active', 'shared',
               '{"modules":[],"integrationProviders":[]}',
               '{"maxOutlets":1,"maxActiveEmployees":1,"maxDevices":1,"aiRequestsPerMonth":0,"whatsappCostCapIdr":0,"aiCostCapIdr":0,"emailCostCapIdr":0}',
               $3)`,
      [otherTenant, `surface-${otherTenant}`, user.userId],
    );
    try {
      await owner.query(
        `INSERT INTO roles (id, tenant_id, name, permissions, allowed_scope_types)
         VALUES ($1, $2, 'Owner lain', '["org.structure.manage"]', '["tenant"]')`,
        [randomUUID(), otherTenant],
      );
      await owner.query(
        `INSERT INTO role_assignments
           (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
         SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
         WHERE tenant_id = $1 AND name = 'Owner lain'`,
        [otherTenant, user.userId],
      );

      const response = await user.client.get("/api/org/modules");
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PERMISSION_DENIED");
    } finally {
      // Later suites list every tenant (tenantSchema.parse), so drop the row now.
      await owner.query("DELETE FROM role_assignments WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await owner.query("DELETE FROM roles WHERE tenant_id = $1", [
        otherTenant,
      ]);
      await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
    }
  });
});

describe("AUTH-05 platform panel gate", () => {
  it("AUTH-05 requires a verified second factor on every /api/platform call", async () => {
    const admin = await platformAdmin("Super Admin Tanpa MFA");

    const denied = await admin.client.get("/api/platform/tenants");
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("MFA_REQUIRED");

    await enrollAndVerify(admin.client);
    expect((await admin.client.get("/api/platform/tenants")).status).toBe(200);
  });

  it("AUTH-05 answers a non-platform account with FORBIDDEN, not the MFA challenge", async () => {
    const user = await signedIn("Bukan Super Admin");
    const response = await user.client.get("/api/platform/tenants");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});
