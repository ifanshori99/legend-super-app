// legend-111j: member consent with versioned policies and the member status
// gates (design M4, M7; brief 290a Tujuan 1, 2, 10 "Tes gagal-dulu").
//
// Real Express app, Better Auth and PostgreSQL. Members are real accounts in
// the seeded tenant (Host = its hostname); profiles are seeded with SQL.
//
// Assumptions:
// - Body of POST /api/member/consents is the contract
//   `{ purpose, granted, policyVersion }`; the response is `{ data: consent }`
//   with `source: "member_pwa"`.
// - The active policy version is `2026-01` (seeded by the test with
//   ON CONFLICT DO NOTHING, standing in for tenant provisioning/backfill).
//   Any other string is "outdated" (`2025-12` is used).
// - A request without a profile on a non-signup route, or with a `closed`
//   profile, answers 404 CUSTOMER_NOT_FOUND; a status that is not allowed
//   answers 403 MEMBERSHIP_NOT_ACTIVE. Error body: `{ error: { code } }`.
// - Staff `recordConsent` refuses source `member_pwa` (the member path is the
//   only writer of that source).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app";
import { recordConsent } from "../services/consent.service.ts";
import { agent, originHeader } from "./helpers";
import { seededTenantId } from "./floor-test-helpers";
import {
  asTenant,
  createWorld,
  ensureConsentPolicies,
  memberHeaders,
  newMemberUser,
  owner,
  profileOf,
  rejection,
} from "./member-loyalty-helpers.ts";

let app: Express;

beforeAll(async () => {
  app = createApp();
  await ensureConsentPolicies();
});

afterAll(async () => {
  await owner.end();
});

type Member = Awaited<ReturnType<typeof newMemberUser>>;

const get = (member: Pick<Member, "client">, path: string) =>
  member.client.get(path).set(memberHeaders);
const consent = (
  member: Pick<Member, "client">,
  body: { purpose: string; granted: boolean; policyVersion: string },
) =>
  member.client
    .post("/api/member/consents")
    .set(memberHeaders)
    .set(originHeader)
    .send(body);

const ACTIVE = "2026-01";
const OLD = "2025-12";

async function profileByUser(userId: string) {
  const { rows } = await asTenant(seededTenantId, (client) =>
    client.query<{ id: string; membership_status: string; name: string }>(
      "SELECT id, membership_status, name FROM customer_profiles WHERE tenant_id = $1 AND user_id = $2",
      [seededTenantId, userId],
    ),
  );
  return rows;
}

describe("LOY-04 member consent versions", () => {
  it("LOY-04 granting an outdated policy version is 409 CONSENT_POLICY_OUTDATED and writes nothing", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    const response = await consent(member, {
      purpose: "marketing",
      granted: true,
      policyVersion: OLD,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONSENT_POLICY_OUTDATED");
    expect(
      (await profileOf(seededTenantId, member.profileId!)).marketing_opt_in,
    ).toBe(false);
  });

  it("LOY-04 an outdated loyalty grant at signup is 409 and creates no profile", async () => {
    const member = await newMemberUser(app, { profile: false });
    const response = await consent(member, {
      purpose: "loyalty",
      granted: true,
      policyVersion: OLD,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONSENT_POLICY_OUTDATED");
    expect(await profileByUser(member.userId)).toHaveLength(0);
  });

  it("LOY-04 a withdrawal accepts any policy version", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    // A withdrawal needs a grant to withdraw (NOTHING_TO_WITHDRAW, as staff).
    expect(
      (
        await consent(member, {
          purpose: "marketing",
          granted: true,
          policyVersion: ACTIVE,
        })
      ).status,
    ).toBe(200);
    const response = await consent(member, {
      purpose: "marketing",
      granted: false,
      policyVersion: OLD,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      purpose: "marketing",
      source: "member_pwa",
    });
    expect(response.body.data.withdrawnAt).not.toBeNull();
  });

  it("LOY-04 a grant records source member_pwa for the member's own profile and keeps marketing_opt_in in sync", async () => {
    const member = await newMemberUser(app, { profile: "active" });
    const granted = await consent(member, {
      purpose: "marketing",
      granted: true,
      policyVersion: ACTIVE,
    });
    expect(granted.status).toBe(200);
    expect(granted.body.data).toMatchObject({
      purpose: "marketing",
      policyVersion: ACTIVE,
      source: "member_pwa",
      customerProfileId: member.profileId,
    });
    expect(
      (await profileOf(seededTenantId, member.profileId!)).marketing_opt_in,
    ).toBe(true);
    const { rows } = await asTenant(seededTenantId, (client) =>
      client.query<{ recorded_by: string; source: string }>(
        "SELECT recorded_by, source FROM consents WHERE tenant_id = $1 AND subject_id = $2 AND purpose = 'marketing'",
        [seededTenantId, member.profileId],
      ),
    );
    expect(rows).toEqual([
      { recorded_by: member.userId, source: "member_pwa" },
    ]);

    await consent(member, {
      purpose: "marketing",
      granted: false,
      policyVersion: ACTIVE,
    });
    expect(
      (await profileOf(seededTenantId, member.profileId!)).marketing_opt_in,
    ).toBe(false);
  });

  it("LOY-04 the staff path keeps refusing source member_pwa", async () => {
    const world = await createWorld();
    const subject = randomUUID();
    const message = await rejection(
      recordConsent(
        world.context,
        {
          subjectId: subject,
          purpose: "loyalty",
          policyVersion: ACTIVE,
          decision: "granted",
          source: "member_pwa",
        },
        randomUUID(),
      ),
    );
    expect(message.length).toBeGreaterThan(0);
    const { rows } = await asTenant(world.tenantId, (client) =>
      client.query(
        "SELECT 1 FROM consents WHERE tenant_id = $1 AND subject_id = $2",
        [world.tenantId, subject],
      ),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("member status follows the loyalty consent", () => {
  it("LOY-04 withdrawing the loyalty consent suspends the membership", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const response = await consent(member, {
      purpose: "loyalty",
      granted: false,
      policyVersion: OLD,
    });
    expect(response.status).toBe(200);
    expect(
      (await profileOf(seededTenantId, member.profileId!)).membership_status,
    ).toBe("suspended");
    const profile = await get(member, "/api/member/profile");
    expect(profile.status).toBe(200);
    expect(profile.body.data.membershipStatus).toBe("suspended");
  });

  it("LOY-04 granting the loyalty consent again returns a suspended verified member to active", async () => {
    const member = await newMemberUser(app, {
      profile: "suspended",
      verifiedWhatsapp: true,
      consent: false,
    });
    const response = await consent(member, {
      purpose: "loyalty",
      granted: true,
      policyVersion: ACTIVE,
    });
    expect(response.status).toBe(200);
    expect(
      (await profileOf(seededTenantId, member.profileId!)).membership_status,
    ).toBe("active");
  });

  it("LOY-04 granting it again without a verified WhatsApp returns the member to pending_verification", async () => {
    const member = await newMemberUser(app, {
      profile: "suspended",
      verifiedWhatsapp: false,
      consent: false,
    });
    const response = await consent(member, {
      purpose: "loyalty",
      granted: true,
      policyVersion: ACTIVE,
    });
    expect(response.status).toBe(200);
    expect(
      (await profileOf(seededTenantId, member.profileId!)).membership_status,
    ).toBe("pending_verification");
  });
});

describe("member signup through POST /api/member/consents", () => {
  it("LOY-04 a user without a profile signs up by granting the loyalty consent (unverified WhatsApp: pending_verification)", async () => {
    const member = await newMemberUser(app, {
      profile: false,
      name: "Siti Pendaftar",
    });
    const response = await consent(member, {
      purpose: "loyalty",
      granted: true,
      policyVersion: ACTIVE,
    });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      purpose: "loyalty",
      source: "member_pwa",
    });
    const profiles = await profileByUser(member.userId);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      membership_status: "pending_verification",
      name: "Siti Pendaftar",
    });
    const own = await get(member, "/api/member/profile");
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({
      id: profiles[0]!.id,
      membershipStatus: "pending_verification",
    });
  });

  it("LOY-04 signup with a verified WhatsApp creates an active member", async () => {
    const member = await newMemberUser(app, {
      profile: false,
      verifiedWhatsapp: true,
    });
    const response = await consent(member, {
      purpose: "loyalty",
      granted: true,
      policyVersion: ACTIVE,
    });
    expect(response.status).toBe(200);
    const profiles = await profileByUser(member.userId);
    expect(profiles.map((row) => row.membership_status)).toEqual(["active"]);
  });

  it("LOY-04 granting a non-loyalty consent without a profile is 404 CUSTOMER_NOT_FOUND", async () => {
    const member = await newMemberUser(app, { profile: false });
    const response = await consent(member, {
      purpose: "marketing",
      granted: true,
      policyVersion: ACTIVE,
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("CUSTOMER_NOT_FOUND");
    expect(await profileByUser(member.userId)).toHaveLength(0);
  });

  it("LOY-04 a repeated signup grant keeps one profile", async () => {
    const member = await newMemberUser(app, { profile: false });
    const body = {
      purpose: "loyalty",
      granted: true,
      policyVersion: ACTIVE,
    };
    expect((await consent(member, body)).status).toBe(200);
    expect((await consent(member, body)).status).toBe(200);
    expect(await profileByUser(member.userId)).toHaveLength(1);
  });
});

describe("GET /api/member/consent-policies", () => {
  it("LOY-04 is readable by a signed-in user without a profile and lists the active version per purpose", async () => {
    const member = await newMemberUser(app, { profile: false });
    const response = await get(member, "/api/member/consent-policies");
    expect(response.status).toBe(200);
    const byPurpose = Object.fromEntries(
      (response.body.data as { purpose: string; version: string }[]).map(
        (row) => [row.purpose, row.version],
      ),
    );
    expect(byPurpose).toMatchObject({
      loyalty: ACTIVE,
      marketing: ACTIVE,
      ai: ACTIVE,
    });
    expect(response.body.data[0]).toHaveProperty("publishedAt");
  });

  it("LOY-04 needs a session: anonymous is 401", async () => {
    const response = await agent(app)
      .get("/api/member/consent-policies")
      .set(memberHeaders);
    expect(response.status).toBe(401);
  });
});

describe("member status gates (brief 290a Tujuan 10)", () => {
  it("LOY-04 pending_verification: only profile, consents and consent-policies are open; the rest is 403 MEMBERSHIP_NOT_ACTIVE", async () => {
    const member = await newMemberUser(app, {
      profile: "pending_verification",
    });
    expect((await get(member, "/api/member/profile")).status).toBe(200);
    expect((await get(member, "/api/member/consent-policies")).status).toBe(
      200,
    );
    expect(
      (
        await consent(member, {
          purpose: "marketing",
          granted: true,
          policyVersion: ACTIVE,
        })
      ).status,
    ).toBe(200);

    const points = await get(member, "/api/member/points");
    expect(points.status).toBe(403);
    expect(points.body.error.code).toBe("MEMBERSHIP_NOT_ACTIVE");
    const qr = await member.client
      .post("/api/member/qr-token")
      .set(memberHeaders)
      .set(originHeader)
      .send({});
    expect(qr.status).toBe(403);
    expect(qr.body.error.code).toBe("MEMBERSHIP_NOT_ACTIVE");
  });

  it("LOY-04 suspended: profile is open, points are 403 MEMBERSHIP_NOT_ACTIVE", async () => {
    const member = await newMemberUser(app, {
      profile: "suspended",
      verifiedWhatsapp: true,
    });
    expect((await get(member, "/api/member/profile")).status).toBe(200);
    const points = await get(member, "/api/member/points");
    expect(points.status).toBe(403);
    expect(points.body.error.code).toBe("MEMBERSHIP_NOT_ACTIVE");
  });

  it("LOY-04 active: points and the QR token are open", async () => {
    const member = await newMemberUser(app, {
      profile: "active",
      verifiedWhatsapp: true,
    });
    const points = await get(member, "/api/member/points");
    expect(points.status).toBe(200);
    expect(points.body.data).toEqual([]);
    const qr = await member.client
      .post("/api/member/qr-token")
      .set(memberHeaders)
      .set(originHeader)
      .send({});
    expect(qr.status).toBe(200);
    expect(typeof qr.body.data.token).toBe("string");
    expect(Date.parse(qr.body.data.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("LOY-04 a closed profile is 404 CUSTOMER_NOT_FOUND on member routes", async () => {
    const member = await newMemberUser(app, { profile: "closed" });
    for (const path of ["/api/member/profile", "/api/member/points"]) {
      const response = await get(member, path);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe("CUSTOMER_NOT_FOUND");
    }
  });

  it("LOY-04 a signed-in user without a profile is 404 CUSTOMER_NOT_FOUND on profile and points", async () => {
    const member = await newMemberUser(app, { profile: false });
    for (const path of ["/api/member/profile", "/api/member/points"]) {
      const response = await get(member, path);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe("CUSTOMER_NOT_FOUND");
    }
  });
});
