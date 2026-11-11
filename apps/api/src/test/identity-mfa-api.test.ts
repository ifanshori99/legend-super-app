// Staff MFA + AUTH-05 enforcement over the real Express app (PRD v1.7 §3 F6
// "Staf — Login Web", §3 F4 platform panel, TEN-04). The RBAC engine is not on
// main yet, so the guarded probe routes inject a facts resolver; the default
// resolver (deny) is itself asserted.
//
// Database: the disposable PostgreSQL server started by `pnpm test`; rows are
// cleaned up through STARTER_TEST_DATABASE_URL.

import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import {
  roleAssignmentSchema,
  roleIdSchema,
  type AccessPrincipal,
  type PermissionCode,
  type RoleGrant,
} from "@starter/shared/access";
import { tenantIdSchema, userIdSchema } from "@starter/shared/core";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import { requireAuth } from "../middleware/auth";
import { errorHandler } from "../middleware/error-handler";
import {
  requireIdentitySurface,
  requireSessionMfa,
} from "../middleware/identity";
import type {
  SurfaceAccessFacts,
  SurfaceAccessFactsResolver,
} from "../services/identity-access.service";
import { agent, originHeader, setRole, signUp } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenants = cafeLegendPlatformFixtures.tenant.id;
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const PASSWORD = "Test-password-123!";
const createdUserIds = new Set<string>();

afterAll(async () => {
  if (createdUserIds.size > 0) {
    await owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [[...createdUserIds]],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      [...createdUserIds],
    ]);
    await owner.query(
      "DELETE FROM platform_admins WHERE user_id = ANY($1::text[])",
      [[...createdUserIds]],
    );
  }
  await owner.end();
});

/** A session cookie signed in outside the agent's jar, for cross-app probes. */
async function signInCookie(email: string): Promise<string> {
  const response = await request(app)
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  createdUserIds.add(response.body.user.id);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

function buildFacts(
  userId: string,
  options: { mfaRequired: boolean; permission?: PermissionCode },
): SurfaceAccessFacts {
  const roleId = randomUUID();
  const principal: AccessPrincipal = {
    tenantId: tenantIdSchema.parse(tenants),
    userId: userIdSchema.parse(userId),
    assignments: [
      roleAssignmentSchema.parse({
        id: randomUUID(),
        tenantId: tenants,
        userId,
        roleId,
        scope: { type: "tenant", id: null },
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: null,
        assignedBy: OTHER_USER_ID,
        assignedAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
  };
  const roles: RoleGrant[] = [
    {
      id: roleIdSchema.parse(roleId),
      permissions: [options.permission ?? "dashboard.management.view"],
      mfaRequired: options.mfaRequired,
    },
  ];
  return { principal, roles };
}

/** Probe surface: back office (/kelola) with an injected RBAC facts resolver. */
function probeApp(
  options: {
    facts?: SurfaceAccessFactsResolver;
    platform?: boolean;
  } = {},
) {
  const probe = express();
  const facts: SurfaceAccessFactsResolver =
    options.facts ??
    (async ({ userId }) => buildFacts(userId, { mfaRequired: true }));
  probe.get(
    "/kelola/probe",
    requireAuth,
    requireIdentitySurface("back_office", { resolveAccessFacts: facts }),
    (_req, res) => void res.json({ ok: true }),
  );
  probe.get(
    "/platform/probe",
    requireAuth,
    requireSessionMfa(),
    (_req, res) => void res.json({ ok: true }),
  );
  probe.use(errorHandler);
  return probe;
}

async function enrollTotp(cookie: string) {
  const response = await request(app)
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ type: "totp" });
  expect(response.status).toBe(201);
  return response.body.data as {
    factorId: string;
    secretBase32: string;
    otpauthUri: string;
  };
}

async function verifyCode(cookie: string, factorId: string, code: string) {
  return request(app)
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ factorId, code });
}

describe("Staff MFA factors and the AUTH-05 gate", () => {
  it("AUTH-05 denies the back office to an MFA role until this session verifies a factor", async () => {
    const client = agent(app);
    const email = await signUp(client, "Kepala Outlet");
    const cookie = await signInCookie(email);
    const probe = probeApp();

    const denied = await request(probe)
      .get("/kelola/probe")
      .set("Cookie", cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("MFA_REQUIRED");
  });

  it("AUTH-05 allows the surface after the session verifies a TOTP factor", async () => {
    const client = agent(app);
    const email = await signUp(client, "Manajer");
    const cookie = await signInCookie(email);
    const enrollment = await enrollTotp(cookie);
    expect(enrollment.otpauthUri.startsWith("otpauth://totp/")).toBe(true);

    const step = totpStep(new Date());
    const verified = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, step),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.data.factorId).toBe(enrollment.factorId);

    const list = await request(app)
      .get("/api/auth/mfa/factors")
      .set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    const allowed = await request(probeApp())
      .get("/kelola/probe")
      .set("Cookie", cookie);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ ok: true });
  });

  it("AUTH-05 a pending enrollment expires and must be reissued", async () => {
    const client = agent(app);
    const email = await signUp(client, "Pendaftaran Lama");
    const cookie = await signInCookie(email);
    const enrollment = await enrollTotp(cookie);
    await owner.query(
      "UPDATE mfa_factors SET created_at = now() - interval '20 minutes' WHERE id = $1",
      [enrollment.factorId],
    );
    const response = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, totpStep(new Date())),
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    // Re-enrolling drops the stale pending factor and issues a new secret.
    const reissued = await enrollTotp(cookie);
    expect(reissued.factorId).not.toBe(enrollment.factorId);
  });

  it("AUTH-05 denies the surface when the RBAC resolver is not wired (fail closed)", async () => {
    const client = agent(app);
    const email = await signUp(client, "Tanpa Resolver");
    const cookie = await signInCookie(email);
    const enrollment = await enrollTotp(cookie);
    await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, totpStep(new Date())),
    );

    const probe = express();
    probe.get(
      "/kelola/probe",
      requireAuth,
      requireIdentitySurface("back_office"),
      (_req, res) => void res.json({ ok: true }),
    );
    probe.use(errorHandler);
    const denied = await request(probe)
      .get("/kelola/probe")
      .set("Cookie", cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("PERMISSION_DENIED");
  });

  it("AUTH-05 platform panel needs a factor verified in this session", async () => {
    const client = agent(app);
    const email = await signUp(client, "Super Admin");
    await setRole(email, "admin");
    const cookie = await signInCookie(email);
    const probe = probeApp();

    const denied = await request(probe)
      .get("/platform/probe")
      .set("Cookie", cookie);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("MFA_REQUIRED");

    const enrollment = await enrollTotp(cookie);
    const verified = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, totpStep(new Date())),
    );
    expect(verified.status).toBe(200);

    const allowed = await request(probe)
      .get("/platform/probe")
      .set("Cookie", cookie);
    expect(allowed.status).toBe(200);
  });

  it("AUTH-05 rejects a wrong or replayed code and locks after five attempts", async () => {
    const client = agent(app);
    const email = await signUp(client, "Kasir Salah Kode");
    const cookie = await signInCookie(email);
    const enrollment = await enrollTotp(cookie);
    const step = totpStep(new Date());
    const code = totpCode(enrollment.secretBase32, step);

    expect(
      (await verifyCode(cookie, enrollment.factorId, "000000")).status,
    ).toBe(401);
    // First valid use, then the same code again: single-use per time step.
    expect((await verifyCode(cookie, enrollment.factorId, code)).status).toBe(
      200,
    );
    const replay = await verifyCode(cookie, enrollment.factorId, code);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("MFA_CODE_INVALID");

    // Four more misses reach the five-attempt lock (the successful use above
    // reset the counter).
    for (let attempt = 0; attempt < 4; attempt++)
      await verifyCode(cookie, enrollment.factorId, "999999");
    const locked = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, step + 1),
    );
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
  });

  it("AUTH-05 factors are isolated per user", async () => {
    const first = agent(app);
    const firstEmail = await signUp(first, "Pemilik Faktor");
    const firstCookie = await signInCookie(firstEmail);
    const enrollment = await enrollTotp(firstCookie);

    const second = agent(app);
    const secondEmail = await signUp(second, "Pengguna Lain");
    const secondCookie = await signInCookie(secondEmail);

    const list = await request(app)
      .get("/api/auth/mfa/factors")
      .set("Cookie", secondCookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);

    const foreign = await verifyCode(
      secondCookie,
      enrollment.factorId,
      "123456",
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");
  });

  // Passkey enrollment/verification now lives in identity-passkey-api.test.ts
  // (legend-jemg); the 501 MFA_PASSKEY_UNSUPPORTED stub is gone.

  it("AUTH-05 platform support access re-verifies the second factor per request", async () => {
    const client = agent(app);
    const email = await signUp(client, "Super Admin Support");
    await setRole(email, "admin");
    const cookie = await signInCookie(email);
    const session = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", cookie);
    const userId = session.body.user.id as string;
    createdUserIds.add(userId);
    await owner.query(
      "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [userId],
    );

    const enrollment = await enrollTotp(cookie);
    const step = totpStep(new Date());
    const used = totpCode(enrollment.secretBase32, step);
    expect((await verifyCode(cookie, enrollment.factorId, used)).status).toBe(
      200,
    );

    const body = {
      reason: "Menelusuri keluhan pelanggan pada tenant ini.",
      durationMinutes: 60,
      accessMode: "read_only",
      mfaCode: used,
    };
    // The enrollment code was already consumed: replay must not open a session.
    const replay = await request(app)
      .post(`/api/platform/tenants/${tenants}/support-access`)
      .set(originHeader)
      .set("Cookie", cookie)
      .send(body);
    expect(replay.status).toBe(403);

    const fresh = await request(app)
      .post(`/api/platform/tenants/${tenants}/support-access`)
      .set(originHeader)
      .set("Cookie", cookie)
      .send({ ...body, mfaCode: totpCode(enrollment.secretBase32, step + 1) });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.mfaVerifiedAt).toBeTruthy();

    await owner.query(
      "DELETE FROM support_access_grants WHERE super_admin_user_id = $1",
      [userId],
    );
  });

  it("AUTH-05 adding or removing a factor needs a session that verified one (no password-only bypass)", async () => {
    const client = agent(app);
    const email = await signUp(client, "Manajer Step Up");
    const verifiedCookie = await signInCookie(email);
    const enrollment = await enrollTotp(verifiedCookie);
    const step = totpStep(new Date());
    expect(
      (
        await verifyCode(
          verifiedCookie,
          enrollment.factorId,
          totpCode(enrollment.secretBase32, step),
        )
      ).status,
    ).toBe(200);

    // A second sign-in with only the password (e.g. a stolen password).
    const passwordOnly = await signInCookie(email);
    const enroll = await request(app)
      .post("/api/auth/mfa/factors")
      .set(originHeader)
      .set("Cookie", passwordOnly)
      .send({ type: "totp" });
    expect(enroll.status).toBe(403);
    expect(enroll.body.error.code).toBe("MFA_REQUIRED");
    const remove = await request(app)
      .delete(`/api/auth/mfa/factors/${enrollment.factorId}`)
      .set(originHeader)
      .set("Cookie", passwordOnly);
    expect(remove.status).toBe(403);
    expect(remove.body.error.code).toBe("MFA_REQUIRED");
    const denied = await request(probeApp())
      .get("/kelola/probe")
      .set("Cookie", passwordOnly);
    expect(denied.status).toBe(403);

    // The session that proved the factor may manage factors.
    const removed = await request(app)
      .delete(`/api/auth/mfa/factors/${enrollment.factorId}`)
      .set(originHeader)
      .set("Cookie", verifiedCookie);
    expect(removed.status).toBe(204);
  });

  it("AUTH-05 parallel guesses are all counted and a code is accepted once", async () => {
    const client = agent(app);
    const email = await signUp(client, "Kasir Paralel");
    const cookie = await signInCookie(email);
    const enrollment = await enrollTotp(cookie);
    const step = totpStep(new Date());
    const code = totpCode(enrollment.secretBase32, step);

    // Racing requests with the same valid code: exactly one wins.
    const same = await Promise.all(
      [0, 1, 2].map(() => verifyCode(cookie, enrollment.factorId, code)),
    );
    expect(same.filter((response) => response.status === 200)).toHaveLength(1);

    // Parallel wrong guesses cannot outrun the five-miss lock.
    const wrong = code === "111111" ? "222222" : "111111";
    await Promise.all(
      Array.from({ length: 8 }, () =>
        verifyCode(cookie, enrollment.factorId, wrong),
      ),
    );
    const { rows } = await owner.query<{ locked_until: Date | null }>(
      "SELECT locked_until FROM mfa_factors WHERE id = $1",
      [enrollment.factorId],
    );
    expect(rows[0]?.locked_until).not.toBeNull();
    const next = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, step + 1),
    );
    expect(next.status).toBe(429);
  });
});

describe("Adding a second factor needs a fresh second factor (legend-jemg fixes)", () => {
  async function verifiedTotpSession(name: string) {
    const email = await signUp(agent(app), name);
    const cookie = await signInCookie(email);
    const enrollment = await enrollTotp(cookie);
    const verified = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, totpStep(new Date())),
    );
    expect(verified.status).toBe(200);
    return { email, cookie, enrollment };
  }

  const stamp = (email: string, at: Date | null) =>
    owner.query(
      `UPDATE "session" SET mfa_verified_at = $2
       WHERE revoked_at IS NULL
         AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [email, at],
    );

  const readStamp = async (email: string) => {
    const { rows } = await owner.query<{ mfa_verified_at: Date | null }>(
      `SELECT mfa_verified_at FROM "session"
       WHERE revoked_at IS NULL
         AND user_id = (SELECT id FROM "user" WHERE email = $1)
       ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    return rows[0]?.mfa_verified_at ?? null;
  };

  const startEnroll = (cookie: string, type: "totp" | "passkey") =>
    request(app)
      .post("/api/auth/mfa/factors")
      .set(originHeader)
      .set("Cookie", cookie)
      .send({ type });

  it("jemg: the first factor can be enrolled by a session with no second factor", async () => {
    const { email } = await verifiedTotpSession("Faktor Pertama");
    expect(await readStamp(email)).not.toBeNull();
  });

  it("jemg: a second factor is refused when the session never proved one", async () => {
    const { email } = await verifiedTotpSession("Tanpa Bukti");
    const cookie = await signInCookie(email);
    const refused = await startEnroll(cookie, "totp");
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("MFA_REQUIRED");
  });

  it("jemg: a second factor is refused when the session's MFA is stale", async () => {
    const { email, cookie } = await verifiedTotpSession("Bukti Basi");
    await stamp(email, new Date(Date.now() - 10 * 60_000));
    for (const type of ["totp", "passkey"] as const) {
      const refused = await startEnroll(cookie, type);
      expect(refused.status).toBe(401);
      expect(refused.body.error.code).toBe("REAUTH_REQUIRED");
    }
  });

  it("jemg: a second factor is allowed with a fresh proof", async () => {
    const { cookie } = await verifiedTotpSession("Bukti Segar");
    expect((await startEnroll(cookie, "totp")).status).toBe(201);
  });

  it("jemg: finishing a second TOTP does not overwrite the session's mfaVerifiedAt", async () => {
    const { email, cookie } = await verifiedTotpSession("Tanpa Timpa");
    const earlier = new Date(Date.now() - 2 * 60_000);
    await stamp(email, earlier);
    const second = await enrollTotp(cookie);
    const done = await verifyCode(
      cookie,
      second.factorId,
      totpCode(second.secretBase32, totpStep(new Date()) + 1),
    );
    expect(done.status).toBe(200);
    expect((await readStamp(email))?.getTime()).toBe(earlier.getTime());
  });

  it("jemg: re-verifying an already enrolled factor still refreshes mfaVerifiedAt", async () => {
    const { email, cookie, enrollment } = await verifiedTotpSession("Re-auth");
    const earlier = new Date(Date.now() - 2 * 60_000);
    await stamp(email, earlier);
    const again = await verifyCode(
      cookie,
      enrollment.factorId,
      totpCode(enrollment.secretBase32, totpStep(new Date()) + 1),
    );
    expect(again.status).toBe(200);
    expect((await readStamp(email))!.getTime()).toBeGreaterThan(
      earlier.getTime(),
    );
  });
});
