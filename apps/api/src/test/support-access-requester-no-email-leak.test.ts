// legend-p0ms5 (tier K, personal data): the support access request shown to a tenant owner
// carries `requesterName` (supportAccessRequestSchema in @starter/shared/platform). When the
// Super Admin has no real display name, the name field of the account holds an email
// address. That email is personal data of platform staff and must never reach the tenant
// owner: a name that looks like an email address (contains "@") is not shown. The
// audit-log actor label uses the same rule (`actorName`, packages/shared audit endpoints).
//
// Written from docs/briefs/sub-support-rw-owner-approval.md-style behaviour already pinned in
// support-access-approval.test.ts ("shows the requesting support member's name to the
// owner") and the card text, not from the implementation.
//
// Assumptions:
// - What is shown instead of an email-like name is not pinned: null, undefined or any
//   fallback label without "@" passes. The test only asserts that neither the email-like
//   name, nor the requester's login email, nor any "@" appears in requesterName, and that
//   the raw response body does not contain the email.
// - Only an owner may list/approve/reject (OWNER_REQUIRED for others), so "tenant admin"
//   here is the owner; every response that carries the request DTO is checked: list,
//   approve and reject.
// - A request of another tenant never shows up in this tenant owner's list, and the owner
//   of this tenant may not read the other tenant's list at the service level (403).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app.ts";
import {
  listSupportAccessRequests,
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
const LIST = "/api/org/support-access/requests";

const platformAdminIds: string[] = [];
const tenantUserIds: string[] = [];

type Client = ReturnType<typeof agent>;
type Person = { client: Client; userId: string; email: string };

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
): Promise<Person> {
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
  await verifySessionMfa(email);
  return { client, userId, email };
}

/** A Super Admin whose account name is `name` (the email-like name is the leak under test). */
async function newSuperAdmin(name: string): Promise<Person> {
  const client = agent(app);
  const email = await signUp(client, name);
  await setRole(email, "admin");
  const userId = (await client.get("/api/auth/get-session")).body.user
    .id as string;
  await db.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [userId]);
  platformAdminIds.push(userId);
  return { client, userId, email };
}

function requestWrite(forTenantId: string, adminUserId: string) {
  const now = new Date();
  return requestSupportWriteAccess({
    tenantId: tenantIdSchema.parse(forTenantId),
    actorUserId: adminUserId,
    request: { reason: REASON, durationMinutes: 30, mfaCode: "123456" },
    mfaVerifiedAt: now.toISOString(),
    now,
  });
}

/** requesterName of the listed request `id`, plus the raw list body. */
async function listedRequest(owner: Person, id: string) {
  const listed = await owner.client.get(LIST);
  expect(listed.status).toBe(200);
  const row = (
    listed.body.data as { id: string; requesterName?: string | null }[]
  ).find((item) => item.id === id);
  expect(row, "the owner sees the request").toBeDefined();
  return { row: row!, raw: JSON.stringify(listed.body) };
}

beforeAll(async () => {
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Support requester tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenantId, `support-req-${otherTenantId.slice(0, 8)}`, tenantId],
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
  await db.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await db.end();
});

describe("legend-p0ms5 requesterName never carries the support member's email", () => {
  it("control: a real display name is still shown to the owner", async () => {
    const owner = await newTenantUser("owner");
    const admin = await newSuperAdmin("Dewi Dukungan");
    const request = await requestWrite(tenantId, admin.userId);

    const { row } = await listedRequest(owner, request.id);

    expect(row.requesterName).toBe("Dewi Dukungan");
  });

  it("an email-like account name is not shown to the owner in the list", async () => {
    // Fails on current code: requesterName is passed through without the "@" filter.
    const owner = await newTenantUser("owner");
    const leaky = `staf-${randomUUID().slice(0, 8)}@perusahaan-dukungan.test`;
    const admin = await newSuperAdmin(leaky);
    const request = await requestWrite(tenantId, admin.userId);

    const { row, raw } = await listedRequest(owner, request.id);

    expect(row.requesterName ?? "").not.toContain("@");
    expect(raw).not.toContain(leaky);
    expect(raw).not.toContain(admin.email);
  });

  it("the approve and reject responses do not carry the email either", async () => {
    const owner = await newTenantUser("owner");
    const leakyA = `staf-${randomUUID().slice(0, 8)}@perusahaan-dukungan.test`;
    const adminA = await newSuperAdmin(leakyA);
    const requestA = await requestWrite(tenantId, adminA.userId);
    const approved = await owner.client
      .post(`/api/org/support-access/requests/${requestA.id}/approve`)
      .set(originHeader)
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(JSON.stringify(approved.body)).not.toContain(leakyA);
    expect(JSON.stringify(approved.body)).not.toContain(adminA.email);

    const leakyB = `staf-${randomUUID().slice(0, 8)}@perusahaan-dukungan.test`;
    const adminB = await newSuperAdmin(leakyB);
    const requestB = await requestWrite(tenantId, adminB.userId);
    const rejected = await owner.client
      .post(`/api/org/support-access/requests/${requestB.id}/reject`)
      .set(originHeader)
      .send({});
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(JSON.stringify(rejected.body)).not.toContain(leakyB);
    expect(JSON.stringify(rejected.body)).not.toContain(adminB.email);
  });

  it("a role without the owner permission gets 403 and no requester data at all", async () => {
    const finance = await newTenantUser("finance");
    const leaky = `staf-${randomUUID().slice(0, 8)}@perusahaan-dukungan.test`;
    const admin = await newSuperAdmin(leaky);
    await requestWrite(tenantId, admin.userId);

    const listed = await finance.client.get(LIST);

    expect(listed.status).toBe(403);
    expect(JSON.stringify(listed.body)).not.toContain(leaky);
    expect(JSON.stringify(listed.body)).not.toContain(admin.email);
  });

  it("another tenant's request is absent from this owner's list and the owner cannot list tenant B", async () => {
    const owner = await newTenantUser("owner");
    const leaky = `staf-${randomUUID().slice(0, 8)}@perusahaan-dukungan.test`;
    const admin = await newSuperAdmin(leaky);
    const foreign = await requestWrite(otherTenantId, admin.userId);

    const listed = await owner.client.get(LIST);
    expect(listed.status).toBe(200);
    expect(
      (listed.body.data as { id: string }[]).map((item) => item.id),
    ).not.toContain(foreign.id);
    expect(JSON.stringify(listed.body)).not.toContain(leaky);

    await expect(
      listSupportAccessRequests(
        contextOf(otherTenantId),
        { userId: owner.userId },
        { limit: 20 },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
