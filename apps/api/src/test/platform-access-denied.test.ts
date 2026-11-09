// legend-ktc4d platform.access.denied: when an IMPERSONATED session is refused
// on a platform route (support guard or platform-admin check), the refusal is
// audited as `platform.access.denied` on the tenant the request concerns.
//
// Assumptions (spec/brief ambiguity):
// - Rows are found by tenant + action + actorId, so parallel suites that
//   write to the seeded tenant cannot disturb counts.
// - actorId is the impersonator. The stored event keeps the extra fields under
//   maskedChanges.after: { cause, code, impersonatedBy, impersonatedUserId,
//   method, route }, objectType platform_route.
// - A row is only written when the impersonator (or impersonated user) holds a
//   role in the tenant or the impersonator has a support grant for it, so the
//   simulated impersonators below are owners of the seeded tenant.
// - The route string is the lower-cased path.
// - The owner-service branch (assignTenantOwner called directly with
//   impersonatedBy set) is NOT covered here: its input type lives in backend
//   code, which this task may not read.
// - A platform admin (normal session) reading a tenant's usage answers 200.
// - Impersonated sessions are simulated by stamping session.impersonated_by
//   (the same trick as platform-tenant-owner.test.ts); case (d) uses the real
//   Better Auth impersonation after an owner-approved read_write grant.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import {
  approveSupportAccessRequest,
  requestSupportWriteAccess,
} from "../services/platform-support.service";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Memperbaiki pengaturan peran tenant atas permintaan pemilik.";
const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const foreignTenantIds: string[] = [];

type Client = ReturnType<typeof agent>;
type User = { client: Client; userId: string; email: string };

const usagePath = `/api/platform/tenants/${tenantId}/usage`;

async function newUser(name: string): Promise<User> {
  const client = agent(app);
  const email = await signUp(client, name);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  return { client, userId, email };
}

/** A Super Admin: Better Auth `admin` role, platform_admins row, MFA-verified session. */
async function newSuperAdmin(): Promise<User> {
  const user = await newUser("Super Admin Akses Ditolak");
  await setRole(user.email, "admin");
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [
    user.userId,
  ]);
  platformAdminIds.push(user.userId);
  await verifySessionMfa(user.email);
  return user;
}

/** A normal tenant owner of the seeded tenant (not a platform admin). */
async function newTenantOwner(): Promise<User> {
  const user = await newUser("Pemilik Akses Ditolak");
  tenantUserIds.push(user.userId);
  const { rowCount } = await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2,
            now() - interval '1 day' FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [tenantId, user.userId],
  );
  expect(rowCount).toBe(1);
  await verifySessionMfa(user.email);
  return user;
}

function contextOf(forTenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(forTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** Rows of an action on a tenant written for one session user (no clock use). */
async function auditRows(forTenantId: string, action: string, actorId: string) {
  const { rows } = await db.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND event->>'actorId' = $3
      ORDER BY id`,
    [forTenantId, action, actorId],
  );
  return rows.map((row) => row.event);
}

/** Marks the user's live sessions as impersonated by `byUserId`. */
async function markImpersonated(userId: string, byUserId: string) {
  const { rowCount } = await db.query(
    `UPDATE "session" SET impersonated_by = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, byUserId],
  );
  expect(rowCount).toBeGreaterThan(0);
}

afterAll(async () => {
  await db.query(
    `WITH gone AS (
       DELETE FROM support_access_grants WHERE super_admin_user_id = ANY($1::text[])
     )
     DELETE FROM support_access_requests WHERE super_admin_user_id = ANY($1::text[])`,
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
    [platformAdminIds],
  );
  await db.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, tenantUserIds],
  );
  await db.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
    foreignTenantIds,
  ]);
  await db.end();
});

describe("legend-ktc4d platform.access.denied", () => {
  it("legend-ktc4d platform.access.denied audits an impersonated GET on a tenant path route", async () => {
    const admin = await newSuperAdmin();
    const impersonator = await newTenantOwner();
    await markImpersonated(admin.userId, impersonator.userId);

    const response = await admin.client.get(usagePath);
    expect(response.status).toBe(403);

    const rows = await auditRows(
      tenantId,
      "platform.access.denied",
      impersonator.userId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      actorId: impersonator.userId,
      objectType: "platform_route",
      maskedChanges: {
        after: {
          cause: "impersonated_session",
          impersonatedBy: impersonator.userId,
          impersonatedUserId: admin.userId,
          method: "GET",
          route: usagePath,
        },
      },
    });
  });

  it("legend-ktc4d platform.access.denied audits only the tenant in the path", async () => {
    const admin = await newSuperAdmin();
    const impersonator = await newTenantOwner();
    await markImpersonated(admin.userId, impersonator.userId);
    const unknownTenantId = randomUUID();

    // Unknown tenant: still refused, but no row can exist for it.
    const response = await admin.client.get(
      `/api/platform/tenants/${unknownTenantId}/usage`,
    );
    expect(response.status).toBe(403);
    expect(
      await auditRows(
        unknownTenantId,
        "platform.access.denied",
        impersonator.userId,
      ),
    ).toHaveLength(0);
    expect(
      await auditRows(tenantId, "platform.access.denied", impersonator.userId),
    ).toHaveLength(0);
  });

  it("legend-ktc4d platform.access.denied writes no row when a normal non-admin user is refused", async () => {
    const user = await newTenantOwner();

    const response = await user.client.get(usagePath);
    expect(response.status).toBe(403);
    expect(
      await auditRows(tenantId, "platform.access.denied", user.userId),
    ).toHaveLength(0);
  });

  it("legend-ktc4d platform.access.denied writes no row for a normal platform admin who is allowed", async () => {
    const admin = await newSuperAdmin();

    const response = await admin.client.get(usagePath);
    expect(response.status).toBe(200);
    expect(
      await auditRows(tenantId, "platform.access.denied", admin.userId),
    ).toHaveLength(0);
  });

  it("legend-ktc4d platform.access.denied records code FORBIDDEN when an impersonated session passes the support guard but is not a platform admin", async () => {
    // The supporter holds an owner-approved read_write grant on the tenant, so
    // the support guard lets the impersonated session through. The session
    // user is the tenant owner, who is not a platform admin: refused.
    const owner = await newTenantOwner();
    const supporter = await newSuperAdmin();
    const now = new Date();
    const writeRequest = await requestSupportWriteAccess({
      tenantId,
      actorUserId: supporter.userId,
      request: { reason: REASON, durationMinutes: 30, mfaCode: "123456" },
      mfaVerifiedAt: now.toISOString(),
      now,
    });
    const approved = await approveSupportAccessRequest(
      contextOf(tenantId),
      { userId: owner.userId },
      writeRequest.id,
      now,
    );
    expect(approved.status).toBe("approved");

    const started = await supporter.client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: owner.userId });
    expect(started.status).toBe(200);
    // The impersonated session is the owner's: give it a verified second factor.
    await verifySessionMfa(owner.email);

    const response = await supporter.client.get(usagePath);
    expect(response.status).toBe(403);

    const rows = await auditRows(
      tenantId,
      "platform.access.denied",
      supporter.userId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // actor = the impersonating admin; the session user is impersonatedUserId.
      actorId: supporter.userId,
      support: {
        impersonatedUserId: owner.userId,
        impersonatorUserId: supporter.userId,
      },
      objectType: "platform_route",
      maskedChanges: {
        after: {
          cause: "impersonated_session",
          code: "FORBIDDEN",
          impersonatedBy: supporter.userId,
          impersonatedUserId: owner.userId,
          method: "GET",
          route: usagePath,
        },
      },
    });
  });

  it("legend-ktc4d platform.access.denied writes no row for a foreign tenant in the path that neither person is tied to", async () => {
    const foreignTenantId = randomUUID();
    foreignTenantIds.push(foreignTenantId);
    await db.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Akses ditolak tenant asing', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [foreignTenantId, `denied-${foreignTenantId.slice(0, 8)}`, tenantId],
    );
    const admin = await newSuperAdmin();
    const impersonator = await newTenantOwner();
    await markImpersonated(admin.userId, impersonator.userId);

    const response = await admin.client.get(
      `/api/platform/tenants/${foreignTenantId}/usage`,
    );
    expect(response.status).toBe(403);
    expect(
      await auditRows(
        foreignTenantId,
        "platform.access.denied",
        impersonator.userId,
      ),
    ).toHaveLength(0);
    // The seeded tenant (where the impersonator is an owner) is not charged.
    expect(
      await auditRows(tenantId, "platform.access.denied", impersonator.userId),
    ).toHaveLength(0);
  });

  it("legend-ktc4d platform.access.denied keeps one row when the same session is refused repeatedly", async () => {
    const admin = await newSuperAdmin();
    const impersonator = await newTenantOwner();
    await markImpersonated(admin.userId, impersonator.userId);

    // legend-w1due: the first refusal (no live grant covers the session)
    // also deletes the session, so the repeats are 401 and add no row.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1)
      statuses.push((await admin.client.get(usagePath)).status);
    expect(statuses).toEqual([403, 401, 401]);
    expect(
      await auditRows(tenantId, "platform.access.denied", impersonator.userId),
    ).toHaveLength(1);
  });

  it("legend-ktc4d platform.access.denied audits the tenant of a mixed-case /Tenants/ path", async () => {
    const admin = await newSuperAdmin();
    const impersonator = await newTenantOwner();
    await markImpersonated(admin.userId, impersonator.userId);

    const response = await admin.client.get(
      `/api/platform/Tenants/${tenantId}/usage`,
    );
    expect(response.status).toBe(403);

    const rows = await auditRows(
      tenantId,
      "platform.access.denied",
      impersonator.userId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId,
      maskedChanges: { after: { method: "GET", route: usagePath } },
    });
  });

  it("legend-ktc4d platform.access.denied masks a non-word path segment such as an email in the stored route", async () => {
    const admin = await newSuperAdmin();
    const impersonator = await newTenantOwner();
    await markImpersonated(admin.userId, impersonator.userId);

    // The unknown sub-route may answer 403 (guard) before any 404.
    const response = await admin.client.get(
      `/api/platform/tenants/${tenantId}/budi@mail.com`,
    );
    expect(response.status).toBe(403);

    const rows = await auditRows(
      tenantId,
      "platform.access.denied",
      impersonator.userId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      maskedChanges: {
        after: { route: `/api/platform/tenants/${tenantId}/*` },
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain("budi@mail.com");
  });
});
