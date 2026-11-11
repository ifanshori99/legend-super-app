// Tenant owner revokes a support-access grant (bead legend-8en8, TEN-04).
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui sesi
// berjangka ... tercatat di audit log, dan memicu notifikasi ke admin tenant"
// (PRD v1.7 §3 F4 Support Access): the tenant admin can cut a session short.
//
// Endpoint under test: POST /api/org/support-access/:grantId/revoke
//   guard = the one of approve/reject (permission org.support_access.approve,
//   verified second factor, not an impersonated session), response
//   { data: grant }.
//
// Assumptions (the brief, not the implementation):
//   - A grant of another tenant, or an unknown id, answers 404 (no leak).
//   - Revoking an already ended or lapsed grant answers 200 with the grant as
//     it is, without a second audit row or event (idempotent).
//   - The audit row is action `support_access.ended` (objectId = grant id,
//     actorType user, actorId = the tenant admin); the outbox event is
//     `support_access.ended` with payload.cause `revoked_by_tenant_admin`
//     (shared events.ts already lists that cause).
//   - The response grant carries endedAt and endedBy = the revoking user.
//   - A malformed grant id, or a body with unknown keys, is a 422.
//   - Impersonated sessions are refused with 403 error.code
//     IMPERSONATION_NOT_ALLOWED, like approve/reject.
//   - Revoking ends linked impersonation sessions at once (same path as an
//     ordinary end): the support session's next request is 401.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  requestSupportAccessInputSchema,
} from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import {
  approveSupportAccessRequest,
  assertSupportAccess,
  endSupportAccess,
  requestSupportAccess,
  requestSupportWriteAccess,
} from "../services/platform-support.service.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers.ts";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const otherTenantId = randomUUID();
const db = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const REASON = "Memperbaiki pengaturan peran tenant atas permintaan pemilik.";

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];
const customRoleIds: string[] = [];

type Client = ReturnType<typeof agent>;
type TenantUser = { client: Client; userId: string; email: string };

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

async function newTenantUser(
  templateKey: "owner" | "finance",
  options: { verifyMfa?: boolean } = {},
): Promise<TenantUser> {
  const client = agent(app);
  const email = await signUp(client, `Anggota ${templateKey}`);
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  const { rowCount } = await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by, assigned_at)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2,
            now() - interval '1 day' FROM roles
     WHERE tenant_id = $1 AND template_key = $3`,
    [tenantId, userId, templateKey],
  );
  expect(rowCount).toBe(1);
  if (options.verifyMfa !== false) await verifySessionMfa(email);
  return { client, userId, email };
}

/**
 * A non-owner holding a custom tenant-scope role with the approve permission
 * (same pattern as newCustomApprover in support-access-approval.test.ts).
 */
async function newCustomApprover(): Promise<TenantUser> {
  const client = agent(app);
  const email = await signUp(client, "Pemegang izin kustom");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  tenantUserIds.push(userId);
  const roleId = randomUUID();
  customRoleIds.push(roleId);
  await db.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $4, false, $3::jsonb, '["tenant"]'::jsonb)`,
    [
      roleId,
      tenantId,
      JSON.stringify(["org.support_access.approve"]),
      `Penyetuju pencabutan ${roleId}`,
    ],
  );
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  await verifySessionMfa(email);
  return { client, userId, email };
}

async function newSuperAdmin(): Promise<TenantUser> {
  const client = agent(app);
  const email = await signUp(client, "Super Admin Pencabutan");
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId, email };
}

function openGrant(forTenantId: string, adminUserId: string) {
  const now = new Date();
  return requestSupportAccess({
    tenantId: tenantIdSchema.parse(forTenantId),
    actorUserId: adminUserId,
    request: requestSupportAccessInputSchema.parse({
      reason: REASON,
      mfaCode: "123456",
    }),
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/** read_write grant through the real request + owner approval path. */
async function openWriteGrant(adminUserId: string, approver: TenantUser) {
  const now = new Date();
  const request = await requestSupportWriteAccess({
    tenantId,
    actorUserId: adminUserId,
    request: { reason: REASON, durationMinutes: 30, mfaCode: "123456" },
    mfaVerifiedAt: now.toISOString(),
    now,
  });
  const approved = await approveSupportAccessRequest(
    contextOf(tenantId),
    { userId: approver.userId },
    request.id,
    now,
  );
  expect(approved.grantId).toBeTruthy();
  return approved.grantId as string;
}

const revokePath = (grantId: string) =>
  `/api/org/support-access/${grantId}/revoke`;

function postRevoke(client: Client, grantId: string, body: object = {}) {
  return client.post(revokePath(grantId)).set(originHeader).send(body);
}

async function grantRow(grantId: string) {
  const result = await db.query<{
    ended_at: Date | null;
    ended_by: string | null;
  }>("SELECT ended_at, ended_by FROM support_access_grants WHERE id = $1", [
    grantId,
  ]);
  expect(result.rowCount).toBe(1);
  return result.rows[0]!;
}

async function auditRows(
  forTenantId: string,
  action: string,
  objectId: string,
) {
  const result = await db.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3
      ORDER BY created_at, id`,
    [forTenantId, action, objectId],
  );
  return result.rows.map((row) => row.event);
}

async function outboxRows(forTenantId: string, grantId: string) {
  const result = await db.query<{
    event: { name: string; payload: Record<string, unknown> };
  }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'support_access' AND aggregate_id = $2
      ORDER BY sequence`,
    [forTenantId, grantId],
  );
  return result.rows.map((row) => row.event);
}

async function expectStillActive(grantId: string) {
  expect((await grantRow(grantId)).ended_at).toBeNull();
}

beforeAll(async () => {
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Support revoke tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `support-revoke-${otherTenantId.slice(0, 8)}`, tenantId],
  );
});

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
  await db.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
    customRoleIds,
  ]);
  await db.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await db.end();
});

describe("TEN-04 tenant owner revokes a support-access grant (legend-8en8)", () => {
  it("TEN-04 an owner with a verified second factor revokes an active grant: 200, ended, audited once, event with cause revoked_by_tenant_admin, access closed", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    await expect(
      assertSupportAccess({
        tenantId,
        actorUserId: admin.userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).resolves.toMatchObject({ id: grant.id });

    const response = await postRevoke(owner.client, grant.id);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: grant.id,
      tenantId,
      endedBy: owner.userId,
    });
    expect(response.body.data.endedAt).not.toBeNull();
    const row = await grantRow(grant.id);
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_by).toBe(owner.userId);

    const audits = await auditRows(tenantId, "support_access.ended", grant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "user",
      actorId: owner.userId,
      objectType: "support_access_grant",
      objectId: grant.id,
    });
    // The cause is shown in the audit row, not redacted by the allowlist.
    expect(audits[0]?.maskedChanges).toMatchObject({
      after: { cause: "revoked_by_tenant_admin" },
    });
    const events = await outboxRows(tenantId, grant.id);
    expect(events.map((event) => event.name)).toEqual([
      "support_access.granted",
      "support_access.ended",
    ]);
    expect(events[1]?.payload).toMatchObject({
      grantId: grant.id,
      cause: "revoked_by_tenant_admin",
    });

    await expect(
      assertSupportAccess({
        tenantId,
        actorUserId: admin.userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_ACCESS_REQUIRED" });
  });

  it("TEN-04 revoking again is idempotent: 200, same endedAt, no second audit row or event", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);

    const first = await postRevoke(owner.client, grant.id);
    const second = await postRevoke(owner.client, grant.id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.endedAt).toBe(first.body.data.endedAt);
    expect(
      await auditRows(tenantId, "support_access.ended", grant.id),
    ).toHaveLength(1);
    expect(await outboxRows(tenantId, grant.id)).toHaveLength(2);
  });

  it("TEN-04 revoking a grant the Super Admin already ended changes nothing and adds no audit row or event", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const ended = await endSupportAccess({
      tenantId,
      grantId: grant.id,
      actorUserId: admin.userId,
    });

    const response = await postRevoke(owner.client, grant.id);
    expect(response.status).toBe(200);
    expect(response.body.data.endedAt).toBe(ended.endedAt);
    expect(response.body.data.endedBy).toBe(admin.userId);
    const audits = await auditRows(tenantId, "support_access.ended", grant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: admin.userId });
    const events = await outboxRows(tenantId, grant.id);
    expect(events.map((event) => event.name)).toEqual([
      "support_access.granted",
      "support_access.ended",
    ]);
    expect(events[1]?.payload).toMatchObject({ cause: "ended_by_super_admin" });
  });

  it("TEN-04 revoking ends the linked support session at once", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin();
    await openGrant(tenantId, admin.userId);
    const grant = (
      await db.query<{ id: string }>(
        `SELECT id FROM support_access_grants
          WHERE super_admin_user_id = $1 AND tenant_id = $2 AND ended_at IS NULL`,
        [admin.userId, tenantId],
      )
    ).rows[0]!;

    const started = await admin.client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: owner.userId });
    expect(started.status).toBe(200);
    await verifySessionMfa(owner.email);
    expect((await admin.client.get("/api/org/domains")).status).toBe(200);

    const response = await postRevoke(owner.client, grant.id);
    expect(response.status).toBe(200);

    // The support session is gone: not even authenticated any more.
    expect((await admin.client.get("/api/org/domains")).status).toBe(401);
    const sessions = await db.query(
      `SELECT 1 FROM "session" WHERE impersonated_by = $1`,
      [admin.userId],
    );
    expect(sessions.rowCount).toBe(0);
  });
});

describe("TEN-04 revoke is refused or hidden when it must be", () => {
  it("TEN-04 a grant of another tenant answers 404 and stays active", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin();
    const foreign = await openGrant(otherTenantId, admin.userId);

    const response = await postRevoke(owner.client, foreign.id);
    expect(response.status).toBe(404);
    await expectStillActive(foreign.id);
    expect(
      await auditRows(otherTenantId, "support_access.ended", foreign.id),
    ).toHaveLength(0);
  });

  it("TEN-04 an unknown grant id is 404 and a malformed one is 422", async () => {
    const owner = await newTenantUser("owner");
    expect((await postRevoke(owner.client, randomUUID())).status).toBe(404);
    expect((await postRevoke(owner.client, "bukan-id")).status).toBe(422);
  });

  it("TEN-04 a body with unknown keys is refused (422) and the grant stays active", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const response = await postRevoke(owner.client, grant.id, {
      reason: "tidak dikenal",
    });
    expect(response.status).toBe(422);
    await expectStillActive(grant.id);
  });

  it("TEN-04 a tenant member without the approval permission gets 403 and the grant stays active", async () => {
    const finance = await newTenantUser("finance");
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const response = await postRevoke(finance.client, grant.id);
    expect(response.status).toBe(403);
    await expectStillActive(grant.id);
  });

  // Assumption: revoke is owner-only like approve/reject, so a non-owner with
  // a custom role holding org.support_access.approve gets 403 OWNER_REQUIRED
  // (same answer as approve by a non-owner in support-access-approval.test.ts).
  it("TEN-04 a non-owner with the approve permission in a custom role gets 403 OWNER_REQUIRED and the grant stays active", async () => {
    const custom = await newCustomApprover();
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const eventsBefore = await outboxRows(tenantId, grant.id);

    const response = await postRevoke(custom.client, grant.id);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("OWNER_REQUIRED");

    const row = await grantRow(grant.id);
    expect(row.ended_at).toBeNull();
    expect(row.ended_by).toBeNull();
    expect(
      await auditRows(tenantId, "support_access.ended", grant.id),
    ).toHaveLength(0);
    expect(await outboxRows(tenantId, grant.id)).toHaveLength(
      eventsBefore.length,
    );
    // The Super Admin's access is untouched.
    await expect(
      assertSupportAccess({
        tenantId,
        actorUserId: admin.userId,
        dataClass: "personal",
        intent: "read",
      }),
    ).resolves.toMatchObject({ id: grant.id });

    // The real owner can still revoke the same grant.
    const owner = await newTenantUser("owner");
    const ok = await postRevoke(owner.client, grant.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.endedBy).toBe(owner.userId);
  });

  it("TEN-04 an owner session without a verified second factor gets 403 and the grant stays active", async () => {
    const owner = await newTenantUser("owner", { verifyMfa: false });
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const response = await postRevoke(owner.client, grant.id);
    expect(response.status).toBe(403);
    await expectStillActive(grant.id);
  });

  it("TEN-04 an anonymous caller gets 401 and the grant stays active", async () => {
    const admin = await newSuperAdmin();
    const grant = await openGrant(tenantId, admin.userId);
    const response = await postRevoke(agent(app), grant.id);
    expect(response.status).toBe(401);
    await expectStillActive(grant.id);
  });

  it("TEN-04 an impersonated session cannot revoke, even one with a write grant", async () => {
    const owner = await newTenantUser("owner");
    const target = await newSuperAdmin();
    const targetGrant = await openGrant(tenantId, target.userId);

    // A second admin holds an approved read_write grant so only the
    // impersonation rule can refuse the call.
    const supporter = await newSuperAdmin();
    await openWriteGrant(supporter.userId, owner);
    const started = await supporter.client
      .post("/api/auth/admin/impersonate-user")
      .set(originHeader)
      .send({ userId: owner.userId });
    expect(started.status).toBe(200);
    await verifySessionMfa(owner.email);

    const response = await postRevoke(supporter.client, targetGrant.id);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("IMPERSONATION_NOT_ALLOWED");
    await expectStillActive(targetGrant.id);
  });
});
