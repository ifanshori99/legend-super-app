// legend-fy5y T9-T19: minting and accepting the one-time first-admin invitation
// link (verify email only, never a session). Real PostgreSQL, service level plus
// one HTTP route test. Written from design-invite.md, not from the services.
//
// Names assumed from the design:
//   - services/identity-invitation.service.ts exports
//       issueInvitationLink(context, { userId, origin, now }) -> string | null
//       acceptInvitationLink({ token, tenantId }, { now })
//     (refusals throw an error with `.code`, like verifyEmailMagicLink).
//   - @starter/shared/identity exports INVITATION_LINK_TTL_MINUTES and
//     INVITATION_LINKS_PER_DAY (next to LOGIN_CODE_TTL_MINUTES).
//   - Link shape: `<origin>/undangan#token=<43 chars>&tenant=<tenantId>`.
//   - Guard refusals (T14-T17) are asserted as "rejects, nothing verified,
//     challenge cancelled"; the exact code is only asserted where the design
//     names it (T11, T13, T18, T12).
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INVITATION_LINKS_PER_DAY,
  INVITATION_LINK_TTL_MINUTES,
} from "@starter/shared/identity";
import { establishTenantContext } from "@starter/shared/core/server";
import { createApp } from "../app";
import { emailDigest, magicLinkTokenDigest } from "../lib/identity-digest";
import {
  setEmailFromResolverForTests,
  setEmailSenderForTests,
} from "../lib/email-sender";
import { requestEmailMagicLink } from "../services/identity-email-login.service";
import { verifyEmailMagicLink } from "../services/identity-email-login.service";
import {
  acceptInvitationLink,
  issueInvitationLink,
} from "../services/identity-invitation.service";
import { agent, originHeader } from "./helpers";
import {
  owner,
  scopedContext,
  seedInvitationTenant,
  tokenOfLink,
  type SeededInvitation,
} from "./tenant-invitation-helpers";

const ORIGIN = "https://app.legend.example.test";
const WINDOW_MS = 60_000;
const NO_DOMAIN_HOST = "belum-ada-domain.example.test";

async function mint(seed: SeededInvitation, now = new Date()) {
  const link = await issueInvitationLink(scopedContext(seed.tenantId), {
    userId: seed.userId,
    origin: ORIGIN,
    now,
  });
  return link;
}

async function mintToken(seed: SeededInvitation, now = new Date()) {
  const link = await mint(seed, now);
  if (!link) throw new Error("expected an invitation link");
  return tokenOfLink(link);
}

const accept = (
  seed: Pick<SeededInvitation, "tenantId">,
  token: string,
  now = new Date(),
) => acceptInvitationLink({ token, tenantId: seed.tenantId }, { now });

async function userRow(userId: string) {
  const { rows } = await owner.query<{ email_verified: boolean }>(
    'SELECT email_verified FROM "user" WHERE id = $1',
    [userId],
  );
  return rows[0]!;
}

async function challengeOf(token: string) {
  const { rows } = await owner.query<{
    status: string;
    matched_user_id: string | null;
    code_hash: string;
  }>(
    "SELECT status, matched_user_id, code_hash FROM login_challenges WHERE code_hash = $1",
    [magicLinkTokenDigest(token)],
  );
  return rows[0];
}

async function sessionCount(userId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM "session" WHERE user_id = $1',
    [userId],
  );
  return rows[0]!.n;
}

async function expectNotVerified(seed: SeededInvitation) {
  expect((await userRow(seed.userId)).email_verified).toBe(false);
  const { rows } = await owner.query(
    "SELECT 1 FROM user_identities WHERE user_id = $1 AND type = 'email' AND verified_at IS NOT NULL",
    [seed.userId],
  );
  expect(rows).toHaveLength(0);
}

afterAll(async () => {
  await owner.end();
});

describe("legend-fy5y issueInvitationLink", () => {
  it("T9 returns the link, refuses the 4th mint in 24h, and a new mint leaves the earlier pending link usable", async () => {
    expect(INVITATION_LINKS_PER_DAY).toBe(3);
    const seed = await seedInvitationTenant();
    const now = new Date();
    const first = await mint(seed, now);
    expect(first).toMatch(
      new RegExp(
        `^${ORIGIN}/undangan#token=[A-Za-z0-9_-]{43}&tenant=${seed.tenantId}$`,
      ),
    );
    const firstToken = tokenOfLink(first!);
    const second = await mint(seed, now);
    expect(second).not.toBeNull();
    // The earlier pending invitation stays pending (no cancel-on-mint).
    expect((await challengeOf(firstToken))!.status).toBe("pending");
    expect(await mint(seed, now)).not.toBeNull();
    // 4th within 24h: durable throttle, no link.
    expect(await mint(seed, now)).toBeNull();
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'login_challenge.rate_limited'`,
      [seed.tenantId],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it("T9 mints nothing for a user without an open tenant_admin assignment", async () => {
    const seed = await seedInvitationTenant({ assignment: "ended" });
    expect(await mint(seed)).toBeNull();
    const { rows } = await owner.query(
      "SELECT 1 FROM login_challenges WHERE link_user_id = $1",
      [seed.userId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("legend-fy5y acceptInvitationLink", () => {
  it("T10 verifies the email, records the identity, completes the challenge and issues no session", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    const sessionsBefore = await sessionCount(seed.userId);
    await accept(seed, token);

    expect((await userRow(seed.userId)).email_verified).toBe(true);
    const { rows } = await owner.query<{ verified_at: Date | null }>(
      "SELECT verified_at FROM user_identities WHERE user_id = $1 AND type = 'email'",
      [seed.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verified_at).not.toBeNull();
    const challenge = await challengeOf(token);
    expect(challenge).toMatchObject({
      status: "completed",
      matched_user_id: seed.userId,
    });
    expect(await sessionCount(seed.userId)).toBe(sessionsBefore);
  });

  it("T11 refuses a second use of the same link", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    await accept(seed, token);
    await expect(accept(seed, token)).rejects.toMatchObject({
      code: "CHALLENGE_NOT_PENDING",
    });
  });

  it("T12 refuses an expired link and leaves the email unverified", async () => {
    const seed = await seedInvitationTenant();
    const minted = new Date();
    const token = await mintToken(seed, minted);
    const late = new Date(
      minted.getTime() + (INVITATION_LINK_TTL_MINUTES + 1) * 60_000,
    );
    await expect(accept(seed, token, late)).rejects.toMatchObject({
      code: "CHALLENGE_EXPIRED",
    });
    await expectNotVerified(seed);
    expect((await challengeOf(token))!.status).toBe("expired");
  });

  it("T13 refuses a link presented with another tenant's id", async () => {
    const seed = await seedInvitationTenant();
    const other = await seedInvitationTenant();
    const token = await mintToken(seed);
    await expect(accept(other, token)).rejects.toMatchObject({
      code: "CHALLENGE_NOT_PENDING",
    });
    await expectNotVerified(seed);
    // The wrong id did not burn the link: the right tenant can still accept.
    await accept(seed, token);
    expect((await userRow(seed.userId)).email_verified).toBe(true);
  });

  it("T14 refuses when the user's email changed after the link was minted", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    await owner.query('UPDATE "user" SET email = $2 WHERE id = $1', [
      seed.userId,
      `ganti-${randomUUID()}@example.test`,
    ]);
    await expect(accept(seed, token)).rejects.toThrow();
    await expectNotVerified(seed);
    expect((await challengeOf(token))!.status).toBe("cancelled");
  });

  it("T15 refuses an unverified user with a credential account, even with a role assignment", async () => {
    const seed = await seedInvitationTenant({ credentialAccount: true });
    const token = await mintToken(seed);
    await expect(accept(seed, token)).rejects.toThrow();
    await expectNotVerified(seed);
    expect((await challengeOf(token))!.status).toBe("cancelled");
  });

  it("T16 refuses when the email identity is owned by another user", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    const otherUser = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Pemilik Lain', $2, true)`,
      [otherUser, `lain-${otherUser}@example.test`],
    );
    await owner.query(
      `INSERT INTO user_identities (id, user_id, type, value_hash, value_encrypted, verified_at)
       VALUES ($1, $2, 'email', $3, 'c2VhbGVk', now())`,
      [randomUUID(), otherUser, await emailDigest(seed.email.toLowerCase())],
    );
    await expect(accept(seed, token)).rejects.toThrow();
    expect((await userRow(seed.userId)).email_verified).toBe(false);
    expect((await challengeOf(token))!.status).toBe("cancelled");
  });

  it("T17 refuses a banned user", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    await owner.query('UPDATE "user" SET banned = true WHERE id = $1', [
      seed.userId,
    ]);
    await expect(accept(seed, token)).rejects.toThrow();
    await expectNotVerified(seed);
  });

  it("T17 refuses when the tenant is no longer active", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    await owner.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [
      seed.tenantId,
    ]);
    await expect(accept(seed, token)).rejects.toThrow();
    await expectNotVerified(seed);
  });
});

describe("legend-fy5y invitation and login tokens stay apart", () => {
  beforeEach(() => {
    setEmailFromResolverForTests(async () => "masuk@brand.example.test");
  });
  afterEach(() => {
    setEmailSenderForTests(undefined);
    setEmailFromResolverForTests(undefined);
  });

  it("T18 an invitation token never yields a login session", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    await expect(
      verifyEmailMagicLink(
        establishTenantContext({
          tenantId: seed.tenantId,
          brandId: null,
          source: "session",
        }),
        { token, bindingNonce: null, ip: "203.0.113.5", userAgent: "vitest" },
        {},
      ),
    ).rejects.toMatchObject({ code: "CHALLENGE_NOT_PENDING" });
    expect(await sessionCount(seed.userId)).toBe(0);
    // The invitation is still usable for what it is for.
    await accept(seed, token);
    expect((await userRow(seed.userId)).email_verified).toBe(true);
  });

  it("T18 a login magic-link token is refused by the invitation accept", async () => {
    const seed = await seedInvitationTenant({ emailVerified: true });
    const mails: string[] = [];
    setEmailSenderForTests({
      async send(message) {
        mails.push(message.text);
      },
    });
    await requestEmailMagicLink(
      establishTenantContext({
        tenantId: seed.tenantId,
        brandId: null,
        source: "session",
      }),
      {
        email: seed.email,
        bindingNonce: randomBytes(32).toString("base64url"),
        linkOrigin: ORIGIN,
        ip: "203.0.113.6",
        userAgent: "vitest",
      },
      {},
    );
    const loginToken = /#token=([A-Za-z0-9_-]{43})/.exec(mails[0] ?? "")?.[1];
    expect(loginToken, "login mail has a #token= link").toBeDefined();
    await expect(accept(seed, loginToken!)).rejects.toMatchObject({
      code: "CHALLENGE_NOT_PENDING",
    });
  });
});

describe("legend-fy5y POST /api/auth/login-challenges/invitation", () => {
  const ROUTE = "/api/auth/login-challenges/invitation";
  const post = (
    app: ReturnType<typeof createApp>,
    body: unknown,
    host = NO_DOMAIN_HOST,
  ) =>
    agent(app)
      .host(host)
      .post(ROUTE)
      .set(originHeader)
      .send(body as object);

  it("T19 works on a host with no tenant domain and issues no session", async () => {
    const seed = await seedInvitationTenant();
    const token = await mintToken(seed);
    const app = createApp();
    const response = await post(app, { token, tenantId: seed.tenantId });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(String(response.headers["set-cookie"] ?? "")).not.toMatch(
      /session_token/,
    );
    expect((await userRow(seed.userId)).email_verified).toBe(true);
    expect(await sessionCount(seed.userId)).toBe(0);
  });

  it("T19 answers a bad token with CHALLENGE_NOT_PENDING, not TENANT_NOT_FOUND, and rejects extra fields", async () => {
    const seed = await seedInvitationTenant();
    const app = createApp();
    const bad = await post(app, {
      token: randomBytes(32).toString("base64url"),
      tenantId: seed.tenantId,
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.error.code).toBe("CHALLENGE_NOT_PENDING");
    const extra = await post(app, {
      token: randomBytes(32).toString("base64url"),
      tenantId: seed.tenantId,
      userId: seed.userId,
    });
    expect(extra.status).toBeGreaterThanOrEqual(400);
    expect(extra.body.error.code).not.toBe("CHALLENGE_NOT_PENDING");
  });

  it("T19 is rate limited per IP by the login-challenge limiter", async () => {
    const seed = await seedInvitationTenant();
    // Assumption: the route falls under the existing issue or poll budget; both
    // per-IP budgets are set to 2 so either classification trips on the 3rd call.
    const app = createApp({
      loginChallengeRateLimit: {
        issuePerIp: 2,
        issuePerBinding: 1000,
        pollPerIp: 2,
        pollPerBinding: 1000,
        windowMs: WINDOW_MS,
        now: () => 1_000_000,
      },
    });
    const body = {
      token: randomBytes(32).toString("base64url"),
      tenantId: seed.tenantId,
    };
    expect((await post(app, body)).status).not.toBe(429);
    expect((await post(app, body)).status).not.toBe(429);
    const limited = await post(app, body);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});
