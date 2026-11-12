// legend-co93l: approved U5a Owner panel needs bounded, audited tenant-member
// search and the current permanent Owner assignment, never a global directory.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendPlatformFixtures,
  platformEndpoints,
} from "@starter/shared/platform";
import { agent, originHeader, verifySessionMfa } from "./helpers";
import {
  account,
  app,
  assign,
  audit,
  closeFixtures,
  enrollTotp,
  owner,
  platformAdmin,
  signedIn,
  supportReadOnly,
  tenant,
} from "./platform-tenant-559-helpers";

let admin: Awaited<ReturnType<typeof platformAdmin>>;
let target: string;
let other: string;
let current: Awaited<ReturnType<typeof account>>;
let assignmentId: string;
const ownersPath = (id: string) => `/api/platform/tenants/${id}/owners`;
const accountsPath = (id: string) => `/api/platform/tenants/${id}/accounts`;

beforeAll(async () => {
  admin = await platformAdmin();
  target = await tenant("Tenant Directory A");
  other = await tenant("Tenant Directory B");
  current = await account("Pemilik Direktori Aktif");
  assignmentId = await assign(target, current.userId, "owner");
});
afterAll(closeFixtures);

describe("legend-co93l U5a platform tenant Owner directory", () => {
  it("TEN-04 AC13 existing shared tenant fixtures parse with an empty Owner list", () => {
    const result = platformEndpoints.getTenant.response.parse({
      data: cafeLegendPlatformFixtures.tenant,
    });
    expect(result.data.owners).toEqual([]);
    expect(result.data.id).toBe(cafeLegendPlatformFixtures.tenant.id);
  });

  it("TEN-04 AC1 tenant detail includes active Owner and assignmentId with masked email", async () => {
    const result = await admin.client.get(`/api/platform/tenants/${target}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data.owners).toEqual([
      expect.objectContaining({
        assignmentId,
        userId: current.userId,
        name: current.name,
      }),
    ]);
    expect(result.body.data.owners[0].email).not.toBe(current.email);
    expect(
      platformEndpoints.getTenant.response.safeParse(result.body).success,
    ).toBe(true);
    expect(
      await audit(target, admin.userId, "platform.tenant_detail.read"),
    ).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toMatch(
      /password|token|secret|hash/i,
    );
  });

  it("TEN-04 AC2 Owner read excludes other tenants, ended and future assignments", async () => {
    const former = await account("Mantan Pemilik Direktori");
    const future = await account("Calon Pemilik Direktori");
    const foreign = await account("Pemilik Tenant Lain");
    await assign(target, former.userId, "owner", "expired");
    await assign(target, future.userId, "owner", "future");
    await assign(other, foreign.userId, "owner");
    const brandOwner = await account("Pemilik Merek Saja");
    const brandId = randomUUID();
    await owner.query(
      "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Merek Pemilik')",
      [brandId, target, `owner-brand-${brandId}`],
    );
    const scopedAssignmentId = await assign(target, brandOwner.userId, "owner");
    await owner.query(
      "UPDATE role_assignments SET scope_type = 'brand', scope_id = $2 WHERE id = $1",
      [scopedAssignmentId, brandId],
    );
    const result = await admin.client.get(ownersPath(target));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toEqual([
      expect.objectContaining({
        assignmentId,
        userId: current.userId,
        name: current.name,
      }),
    ]);
    expect(Object.keys(result.body.data[0]).sort()).toEqual([
      "assignedAt",
      "assignmentId",
      "email",
      "name",
      "userId",
    ]);
    expect(result.body.data[0].email).not.toBe(current.email);
    const reads = await audit(
      target,
      admin.userId,
      "platform.tenant_owners.read",
    );
    expect(reads).toHaveLength(1);
    expect(JSON.stringify(reads)).not.toContain(current.email);
  });

  it("TEN-04 AC3 member search is bounded, masked and isolated from inactive or foreign members", async () => {
    const active = await account("Cari Direktori Cocok");
    const expired = await account("Cari Direktori Berakhir");
    const future = await account("Cari Direktori Mendatang");
    const foreign = await account("Cari Direktori Asing");
    const banned = await account("Cari Direktori Diblokir");
    await assign(target, active.userId);
    await assign(target, expired.userId, "tenant_admin", "expired");
    await assign(target, future.userId, "tenant_admin", "future");
    await assign(other, foreign.userId);
    await assign(target, banned.userId);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      banned.userId,
    ]);
    const response = await admin.client
      .get(accountsPath(target))
      .query({ q: "Cari Direktori", limit: 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ userId: active.userId, name: active.name }),
    ]);
    expect(Object.keys(response.body.data[0]).sort()).toEqual([
      "email",
      "name",
      "userId",
    ]);
    expect(response.body.data[0].email).not.toBe(active.email);
    const all = await admin.client
      .get(accountsPath(target))
      .query({ q: "Cari Direktori", limit: 50 });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data.map((row: { userId: string }) => row.userId)).toEqual([
      active.userId,
    ]);
    const events = await audit(
      target,
      admin.userId,
      "platform.tenant_accounts.search",
    );
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(active.email);
    expect(JSON.stringify(events)).not.toContain("Cari Direktori");
  });

  it("TEN-04 AC4 search returns empty results and refuses malformed or excessive queries", async () => {
    const empty = await admin.client
      .get(accountsPath(target))
      .query({ q: "TidakAdaCocok" });
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data).toEqual([]);
    for (const query of [
      { q: "x" },
      { q: "x".repeat(101) },
      { q: "ab", limit: 51 },
    ]) {
      expect(
        (await admin.client.get(accountsPath(target)).query(query)).status,
      ).toBe(422);
    }
    expect((await admin.client.get(ownersPath(randomUUID()))).status).toBe(404);
    expect(
      (await admin.client.get(accountsPath(randomUUID())).query({ q: "ab" }))
        .status,
    ).toBe(404);
  });

  it("TEN-04 AC5 tenant Owner, legacy admin and read-only support grant cannot gain platform authority", async () => {
    const ordinary = await signedIn("Tenant Owner Only");
    await assign(target, ordinary.userId, "owner");
    await verifySessionMfa(ordinary.email);
    await supportReadOnly(target, ordinary.userId);
    for (const path of [ownersPath(target), accountsPath(target) + "?q=ab"]) {
      expect((await ordinary.client.get(path)).status).toBe(403);
      expect((await agent(app).get(path)).status).toBe(401);
    }
    const legacy = await signedIn("Legacy Global Admin");
    await owner.query("UPDATE \"user\" SET role = 'admin' WHERE id = $1", [
      legacy.userId,
    ]);
    await verifySessionMfa(legacy.email);
    expect((await legacy.client.get(ownersPath(target))).status).toBe(403);
  });

  it("TEN-04 AC6 platform actor with read-only support cannot assign or replace Owner", async () => {
    const support = await platformAdmin("Read Only Platform Support");
    const code = await enrollTotp(support);
    await supportReadOnly(target, support.userId);
    const replacement = await account("Pemilik Pengganti");
    await assign(target, replacement.userId);
    for (const path of [
      ownersPath(target),
      `${ownersPath(target)}/${assignmentId}/replace`,
    ]) {
      const result = await support.client
        .post(path)
        .set(originHeader)
        .send({
          account: { userId: replacement.userId },
          reason: "Percobaan mengganti Owner lewat sesi dukungan read-only.",
          mfaCode: await code(),
        });
      expect(result.status, JSON.stringify(result.body)).toBe(403);
    }
    const unchanged = await owner.query<{ valid_until: Date | null }>(
      "SELECT valid_until FROM role_assignments WHERE id = $1",
      [assignmentId],
    );
    expect(unchanged.rows[0]!.valid_until).toBeNull();
  });

  it("TEN-04 AC8 wildcard input is literal and unknown query fields are rejected", async () => {
    const literal = await account("Cocok%_Direktori");
    const decoy = await account("CocokXYDirektori");
    await assign(target, literal.userId);
    await assign(target, decoy.userId);
    const result = await admin.client
      .get(accountsPath(target))
      .query({ q: "Cocok%_" });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(
      result.body.data.map((row: { userId: string }) => row.userId),
    ).toEqual([literal.userId]);
    expect(
      (
        await admin.client
          .get(accountsPath(target))
          .query({ q: "ab", tenantId: other })
      ).status,
    ).toBe(422);
  });

  it("TEN-04 AC9 revoked, unverified and impersonated platform sessions cannot read or mutate Owner", async () => {
    const revoked = await platformAdmin("Revoked Directory Admin");
    await owner.query(
      "UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1",
      [revoked.userId],
    );
    expect((await revoked.client.get(ownersPath(target))).status).toBe(403);
    const unverified = await platformAdmin("Unverified Directory Admin");
    await owner.query(
      'UPDATE "session" SET mfa_verified_at = NULL WHERE user_id = $1',
      [unverified.userId],
    );
    expect(
      (await unverified.client.get(accountsPath(target)).query({ q: "ab" }))
        .status,
    ).toBe(403);
    const impersonated = await platformAdmin("Impersonated Directory Admin");
    await owner.query(
      'UPDATE "session" SET impersonated_by = $2 WHERE user_id = $1',
      [impersonated.userId, admin.userId],
    );
    expect((await impersonated.client.get(ownersPath(target))).status).toBe(
      403,
    );
    // Refusing a grantless impersonation deletes that session. Use a new
    // authenticated session for the independent write-denial assertion.
    const impersonatedWriter = await platformAdmin(
      "Impersonated Directory Writer",
    );
    const writerCode = await enrollTotp(impersonatedWriter);
    await owner.query(
      'UPDATE "session" SET impersonated_by = $2 WHERE user_id = $1',
      [impersonatedWriter.userId, admin.userId],
    );
    const response = await impersonatedWriter.client
      .post(ownersPath(target))
      .set(originHeader)
      .send({
        account: { userId: current.userId },
        reason: "Penunjukan lewat sesi impersonasi wajib ditolak.",
        mfaCode: await writerCode(),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("TEN-04 AC10 default and requested result limits cap a large matching member set", async () => {
    for (let index = 0; index < 55; index++) {
      const member = await account(
        `Batas Direktori ${index.toString().padStart(2, "0")}`,
      );
      await assign(target, member.userId);
    }
    const limited = await admin.client
      .get(accountsPath(target))
      .query({ q: "Batas Direktori", limit: 50 });
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    expect(limited.body.data).toHaveLength(50);
    const defaultLimit = await admin.client
      .get(accountsPath(target))
      .query({ q: "Batas Direktori" });
    expect(defaultLimit.status, JSON.stringify(defaultLimit.body)).toBe(200);
    expect(defaultLimit.body.data).toHaveLength(20);
  });

  it("TEN-04 AC11 expired, ended and foreign read-only grants do not block an authorized appointment", async () => {
    for (const state of ["expired", "ended", "foreign"] as const) {
      const staff = await platformAdmin(`Platform ${state} Support`);
      const code = await enrollTotp(staff);
      const candidate = await account(`Pemilik ${state} Dukungan`);
      await assign(target, candidate.userId);
      await supportReadOnly(state === "foreign" ? other : target, staff.userId);
      if (state === "expired") {
        const started = new Date(Date.now() - 7_200_000);
        await owner.query(
          `UPDATE support_access_grants SET started_at = $2, expires_at = $3,
          mfa_verified_at = $2 WHERE super_admin_user_id = $1`,
          [staff.userId, started, new Date(started.getTime() + 3_600_000)],
        );
      } else if (state === "ended") {
        await owner.query(
          "UPDATE support_access_grants SET ended_at = $2, ended_by = $1 WHERE super_admin_user_id = $1",
          [staff.userId, new Date()],
        );
      }
      const response = await staff.client
        .post(ownersPath(target))
        .set(originHeader)
        .send({
          account: { userId: candidate.userId },
          reason: "Penunjukan Owner oleh platform dengan kewenangan penuh.",
          mfaCode: await code(),
        });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.data.userId).toBe(candidate.userId);
    }
  });

  it("TEN-04 AC7 repeated searches are rate limited per platform actor", async () => {
    const limited = await platformAdmin("Directory Rate Limited");
    let response;
    let calls = 0;
    for (let index = 0; index < 61; index++) {
      calls++;
      response = await limited.client
        .get(accountsPath(index % 2 === 0 ? target : other))
        .query({ q: "NoMatch" });
      if (response.status === 429) break;
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect(response!.status).toBe(429);
    const events = [
      ...(await audit(
        target,
        limited.userId,
        "platform.tenant_accounts.search",
      )),
      ...(await audit(
        other,
        limited.userId,
        "platform.tenant_accounts.search",
      )),
    ];
    expect(events).toHaveLength(calls);
  });
});
