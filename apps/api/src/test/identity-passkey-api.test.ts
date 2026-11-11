// Staff passkey (WebAuthn) MFA over the real Express app, legend-jemg
// (PRD v1.7 §3 F6 "Staf — Login Web": MFA by TOTP or passkey; §6 B
// `mfa_factors.public_key`). A software authenticator signs real WebAuthn
// payloads (webauthn-software-authenticator.ts), so the API's verification,
// challenge handling and sign-count check are exercised, not mocked.
//
// Wire contract assumed (see identity-passkey-contract.test.ts):
//   POST /api/auth/mfa/factors {type:"passkey"}            201 data.publicKeyOptions.challenge
//   POST /api/auth/mfa/verify {factorId, attestation}      finishes enrollment
//   POST /api/auth/mfa/factors/:factorId/challenge         200 data.publicKeyOptions.challenge
//   POST /api/auth/mfa/verify {factorId, assertion}        200 data {factorId, verifiedAt}
// Other assumptions:
//  - The relying party id is the hostname of the web origin and the expected
//    origin is the web origin itself.
//  - A refused passkey request answers a 4xx; the exact code is not asserted
//    except NOT_FOUND for another user's factor (same as TOTP factor isolation).
//  - Sign counts must strictly increase while the stored count is above zero;
//    an equal or lower count is refused (cloned authenticator signal).
//  - Challenges are single use and bound to the session that requested them.
//  - Whether finishing enrollment also verifies that session is not asserted;
//    every assertion test uses a fresh sign-in so the outcome is observable
//    through the platform probe (closed until the session is MFA-verified).

import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import { requireAuth } from "../middleware/auth";
import { errorHandler } from "../middleware/error-handler";
import { requireSessionMfa } from "../middleware/identity";
import { agent, originHeader, signUp, WEB_ORIGIN } from "./helpers";
import {
  assertionResponse,
  createSoftwareAuthenticator,
  registrationResponse,
  type SoftwareAuthenticator,
} from "./webauthn-software-authenticator";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const PASSWORD = "Test-password-123!";
const RP_ID = new URL(WEB_ORIGIN).hostname;
const createdUserIds = new Set<string>();

afterAll(async () => {
  try {
    if (createdUserIds.size > 0) {
      const ids = [...createdUserIds];
      await owner.query(
        "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
        [ids],
      );
      await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
    }
  } catch {
    // Disposable test database: cleanup is best effort.
  }
  await owner.end();
});

const probe = express();
probe.get("/platform/probe", requireAuth, requireSessionMfa(), (_req, res) => {
  res.json({ ok: true });
});
probe.use(errorHandler);

async function signIn(email: string): Promise<string> {
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

const post = (cookie: string | null, path: string, body?: unknown) => {
  const req = request(app).post(path).set(originHeader);
  if (cookie) req.set("Cookie", cookie);
  return body === undefined ? req : req.send(body as object);
};

async function startEnrollment(cookie: string) {
  const response = await post(cookie, "/api/auth/mfa/factors", {
    type: "passkey",
  });
  expect(response.status).toBe(201);
  expect(response.body.data.type).toBe("passkey");
  return {
    factorId: response.body.data.factorId as string,
    challenge: response.body.data.publicKeyOptions.challenge as string,
  };
}

const finishEnrollment = (
  cookie: string,
  factorId: string,
  attestation: unknown,
) => post(cookie, "/api/auth/mfa/verify", { factorId, attestation });

async function requestChallenge(cookie: string, factorId: string) {
  return post(cookie, `/api/auth/mfa/factors/${factorId}/challenge`);
}

async function issuedChallenge(cookie: string, factorId: string) {
  const response = await requestChallenge(cookie, factorId);
  expect(response.status).toBe(200);
  return response.body.data.publicKeyOptions.challenge as string;
}

const verifyAssertion = (
  cookie: string,
  factorId: string,
  assertion: unknown,
) => post(cookie, "/api/auth/mfa/verify", { factorId, assertion });

async function sessionIsVerified(cookie: string): Promise<boolean> {
  const response = await request(probe)
    .get("/platform/probe")
    .set("Cookie", cookie);
  if (response.status === 200) return true;
  expect(response.status).toBe(403);
  expect(response.body.error.code).toBe("MFA_REQUIRED");
  return false;
}

/** A staff user with one enrolled passkey (counter 0) and no verified session. */
async function userWithPasskey() {
  const email = await signUp(agent(app), "Passkey Staff");
  const enrollCookie = await signIn(email);
  const authenticator = createSoftwareAuthenticator();
  const { factorId, challenge } = await startEnrollment(enrollCookie);
  const finished = await finishEnrollment(
    enrollCookie,
    factorId,
    registrationResponse(authenticator, {
      challenge,
      rpId: RP_ID,
      origin: WEB_ORIGIN,
    }),
  );
  expect(finished.status).toBe(200);
  return { email, factorId, authenticator, enrollCookie };
}

function sign(
  authenticator: SoftwareAuthenticator,
  challenge: string,
  counter: number,
  overrides: { rpId?: string; origin?: string } = {},
) {
  return assertionResponse(authenticator, {
    challenge,
    counter,
    rpId: overrides.rpId ?? RP_ID,
    origin: overrides.origin ?? WEB_ORIGIN,
  });
}

describe("Staff passkey MFA enroll and verify (legend-jemg)", () => {
  it("jemg: enrolling a passkey issues WebAuthn creation options instead of 501", async () => {
    const email = await signUp(agent(app), "Passkey");
    const cookie = await signIn(email);
    const { factorId, challenge } = await startEnrollment(cookie);
    expect(factorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(challenge.length).toBeGreaterThanOrEqual(16);
  });

  it("jemg: finishing enrollment stores the public key on the factor", async () => {
    const { factorId } = await userWithPasskey();
    const { rows } = await owner.query(
      "SELECT type, public_key FROM mfa_factors WHERE id = $1",
      [factorId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("passkey");
    expect(rows[0].public_key).not.toBeNull();
  });

  it("jemg: a valid assertion verifies a fresh session and opens the MFA-gated surface", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    expect(await sessionIsVerified(cookie)).toBe(false);

    const challenge = await issuedChallenge(cookie, factorId);
    const verified = await verifyAssertion(
      cookie,
      factorId,
      sign(authenticator, challenge, 1),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.data.factorId).toBe(factorId);
    expect(typeof verified.body.data.verifiedAt).toBe("string");
    expect(await sessionIsVerified(cookie)).toBe(true);
  });

  it("jemg: counters that keep increasing verify across sessions", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    for (const counter of [1, 2, 7]) {
      const cookie = await signIn(email);
      const challenge = await issuedChallenge(cookie, factorId);
      const verified = await verifyAssertion(
        cookie,
        factorId,
        sign(authenticator, challenge, counter),
      );
      expect(verified.status).toBe(200);
    }
  });

  it("jemg: an enrollment with the wrong challenge is refused and the factor stays unusable", async () => {
    const email = await signUp(agent(app), "Passkey");
    const cookie = await signIn(email);
    const authenticator = createSoftwareAuthenticator();
    const { factorId } = await startEnrollment(cookie);
    const refused = await finishEnrollment(
      cookie,
      factorId,
      registrationResponse(authenticator, {
        challenge: Buffer.from("not-the-issued-challenge").toString(
          "base64url",
        ),
        rpId: RP_ID,
        origin: WEB_ORIGIN,
      }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const { rows } = await owner.query(
      "SELECT public_key FROM mfa_factors WHERE id = $1",
      [factorId],
    );
    expect(rows.every((row) => row.public_key === null)).toBe(true);
  });

  it("jemg: an enrollment payload cannot be replayed to finish enrollment twice", async () => {
    const email = await signUp(agent(app), "Passkey");
    const cookie = await signIn(email);
    const authenticator = createSoftwareAuthenticator();
    const { factorId, challenge } = await startEnrollment(cookie);
    const attestation = registrationResponse(authenticator, {
      challenge,
      rpId: RP_ID,
      origin: WEB_ORIGIN,
    });
    expect((await finishEnrollment(cookie, factorId, attestation)).status).toBe(
      200,
    );
    const replay = await finishEnrollment(cookie, factorId, attestation);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
  });
});

describe("Staff passkey MFA challenge reuse is rejected (legend-jemg)", () => {
  it("jemg: replaying a used assertion is refused in the same session", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    const challenge = await issuedChallenge(cookie, factorId);
    const assertion = sign(authenticator, challenge, 1);
    expect((await verifyAssertion(cookie, factorId, assertion)).status).toBe(
      200,
    );
    const replay = await verifyAssertion(cookie, factorId, assertion);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
  });

  it("jemg: a captured assertion replayed in another session does not verify it", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const first = await signIn(email);
    const challenge = await issuedChallenge(first, factorId);
    const assertion = sign(authenticator, challenge, 1);
    expect((await verifyAssertion(first, factorId, assertion)).status).toBe(
      200,
    );

    const attacker = await signIn(email);
    const replay = await verifyAssertion(attacker, factorId, assertion);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(replay.status).toBeLessThan(500);
    expect(await sessionIsVerified(attacker)).toBe(false);
  });

  it("jemg: an assertion over a challenge the server never issued is refused", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    await issuedChallenge(cookie, factorId); // a real one exists, but is not used
    const forged = Buffer.from("self-made-challenge-0123456789").toString(
      "base64url",
    );
    const refused = await verifyAssertion(
      cookie,
      factorId,
      sign(authenticator, forged, 1),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await sessionIsVerified(cookie)).toBe(false);
  });

  it("jemg: a challenge issued to one session cannot verify another session", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const issuedTo = await signIn(email);
    const other = await signIn(email);
    const challenge = await issuedChallenge(issuedTo, factorId);
    const refused = await verifyAssertion(
      other,
      factorId,
      sign(authenticator, challenge, 1),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await sessionIsVerified(other)).toBe(false);
  });

  it("jemg: asking for a new challenge invalidates the previous one", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    const stale = await issuedChallenge(cookie, factorId);
    const fresh = await issuedChallenge(cookie, factorId);
    expect(fresh).not.toBe(stale);
    const refused = await verifyAssertion(
      cookie,
      factorId,
      sign(authenticator, stale, 1),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(
      (await verifyAssertion(cookie, factorId, sign(authenticator, fresh, 1)))
        .status,
    ).toBe(200);
  });
});

describe("Staff passkey MFA sign-count rollback is rejected (legend-jemg)", () => {
  it("jemg: a lower sign count than the last accepted one is refused", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const first = await signIn(email);
    expect(
      (
        await verifyAssertion(
          first,
          factorId,
          sign(authenticator, await issuedChallenge(first, factorId), 5),
        )
      ).status,
    ).toBe(200);

    const second = await signIn(email);
    const rolledBack = await verifyAssertion(
      second,
      factorId,
      sign(authenticator, await issuedChallenge(second, factorId), 3),
    );
    expect(rolledBack.status).toBeGreaterThanOrEqual(400);
    expect(rolledBack.status).toBeLessThan(500);
    expect(await sessionIsVerified(second)).toBe(false);
  });

  it("jemg: an equal sign count (replayed counter) is refused too", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const first = await signIn(email);
    expect(
      (
        await verifyAssertion(
          first,
          factorId,
          sign(authenticator, await issuedChallenge(first, factorId), 4),
        )
      ).status,
    ).toBe(200);

    const second = await signIn(email);
    const same = await verifyAssertion(
      second,
      factorId,
      sign(authenticator, await issuedChallenge(second, factorId), 4),
    );
    expect(same.status).toBeGreaterThanOrEqual(400);
    expect(same.status).toBeLessThan(500);
    expect(await sessionIsVerified(second)).toBe(false);
  });
});

describe("Staff passkey MFA wrong user, key, origin and tenant are rejected (legend-jemg)", () => {
  it("jemg: another user cannot request a challenge for a foreign factor", async () => {
    const { factorId } = await userWithPasskey();
    const intruder = await signIn(await signUp(agent(app), "Intruder"));
    const response = await requestChallenge(intruder, factorId);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("jemg: another user cannot verify with a foreign factor even holding a valid assertion", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const owner1 = await signIn(email);
    const challenge = await issuedChallenge(owner1, factorId);
    const assertion = sign(authenticator, challenge, 1);

    const intruder = await signIn(await signUp(agent(app), "Intruder"));
    const response = await verifyAssertion(intruder, factorId, assertion);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await sessionIsVerified(intruder)).toBe(false);
  });

  it("jemg: another user cannot finish someone else's pending enrollment", async () => {
    const email = await signUp(agent(app), "Passkey");
    const cookie = await signIn(email);
    const authenticator = createSoftwareAuthenticator();
    const { factorId, challenge } = await startEnrollment(cookie);
    const intruder = await signIn(await signUp(agent(app), "Intruder"));
    const response = await finishEnrollment(
      intruder,
      factorId,
      registrationResponse(authenticator, {
        challenge,
        rpId: RP_ID,
        origin: WEB_ORIGIN,
      }),
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("jemg: an assertion signed by a different key is refused", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    const challenge = await issuedChallenge(cookie, factorId);
    const impostor = createSoftwareAuthenticator();
    // Same credential id, different private key: the stored public key must not match.
    const forged = sign(
      { ...impostor, credentialId: authenticator.credentialId },
      challenge,
      1,
    );
    const refused = await verifyAssertion(cookie, factorId, forged);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await sessionIsVerified(cookie)).toBe(false);
  });

  it("jemg: an assertion made for a foreign origin or relying party is refused", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    for (const overrides of [
      { origin: "https://evil.example" },
      { rpId: "evil.example" },
    ]) {
      const cookie = await signIn(email);
      const challenge = await issuedChallenge(cookie, factorId);
      const refused = await verifyAssertion(
        cookie,
        factorId,
        sign(authenticator, challenge, 1, overrides),
      );
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
      expect(await sessionIsVerified(cookie)).toBe(false);
    }
  });

  it("jemg: the tenant never comes from the client body (TEN-02)", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    const challenge = await issuedChallenge(cookie, factorId);
    const response = await post(cookie, "/api/auth/mfa/verify", {
      factorId,
      assertion: sign(authenticator, challenge, 1),
      tenantId: "22222222-2222-4222-8222-222222222222",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await sessionIsVerified(cookie)).toBe(false);
  });

  it("jemg: passkey endpoints answer 401 without a session", async () => {
    const { factorId, authenticator } = await userWithPasskey();
    expect((await requestChallenge("", factorId)).status).toBe(401);
    const response = await post(null, "/api/auth/mfa/verify", {
      factorId,
      assertion: sign(authenticator, "Y2hhbGxlbmdl", 1),
    });
    expect(response.status).toBe(401);
  });
});

/** Stamps every live session of this user with an API-clock instant (not the DB clock). */
async function stampSessions(email: string, at: Date | null): Promise<void> {
  await owner.query(
    `UPDATE "session" SET mfa_verified_at = $2
     WHERE revoked_at IS NULL
       AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
    [email, at],
  );
}

async function sessionStamp(email: string): Promise<Date | null> {
  const { rows } = await owner.query<{ mfa_verified_at: Date | null }>(
    `SELECT mfa_verified_at FROM "session"
     WHERE revoked_at IS NULL
       AND user_id = (SELECT id FROM "user" WHERE email = $1)
     ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  return rows[0]?.mfa_verified_at ?? null;
}

describe("Staff passkey MFA lockout, expiry and step-up (legend-jemg fixes)", () => {
  it("jemg: five wrong assertions lock the factor, even for the right key afterwards", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const challenge = await issuedChallenge(cookie, factorId);
      const impostor = createSoftwareAuthenticator();
      const forged = sign(
        { ...impostor, credentialId: authenticator.credentialId },
        challenge,
        attempt + 1,
      );
      statuses.push((await verifyAssertion(cookie, factorId, forged)).status);
    }
    expect(
      statuses.slice(0, 4).every((s) => s >= 400 && s < 500 && s !== 429),
    ).toBe(true);
    expect(statuses[4]).toBe(429);
    // A locked factor issues no new challenge, so the real key cannot get in.
    const locked = await requestChallenge(cookie, factorId);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("RATE_LIMITED");
    expect(await sessionIsVerified(cookie)).toBe(false);
  });

  it("jemg: an expired challenge is refused", async () => {
    const { email, factorId, authenticator } = await userWithPasskey();
    const cookie = await signIn(email);
    const challenge = await issuedChallenge(cookie, factorId);
    await owner.query(
      "UPDATE mfa_passkey_challenges SET expires_at = $2 WHERE factor_id = $1",
      [factorId, new Date(Date.now() - 60_000)],
    );
    const refused = await verifyAssertion(
      cookie,
      factorId,
      sign(authenticator, challenge, 1),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await sessionIsVerified(cookie)).toBe(false);
  });

  it("jemg: a second passkey needs a fresh second factor (no factor proven: MFA_REQUIRED)", async () => {
    const { email } = await userWithPasskey();
    const cookie = await signIn(email); // new session, nothing verified yet
    const refused = await post(cookie, "/api/auth/mfa/factors", {
      type: "passkey",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("MFA_REQUIRED");
  });

  it("jemg: a second passkey is refused when the session's MFA is stale (REAUTH_REQUIRED)", async () => {
    const { email, enrollCookie } = await userWithPasskey();
    await stampSessions(email, new Date(Date.now() - 10 * 60_000));
    const refused = await post(enrollCookie, "/api/auth/mfa/factors", {
      type: "passkey",
    });
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("REAUTH_REQUIRED");
    const totp = await post(enrollCookie, "/api/auth/mfa/factors", {
      type: "totp",
    });
    expect(totp.status).toBe(401);
    expect(totp.body.error.code).toBe("REAUTH_REQUIRED");
  });

  it("jemg: a second passkey is allowed with a fresh second factor", async () => {
    const { enrollCookie } = await userWithPasskey();
    const { factorId } = await startEnrollment(enrollCookie);
    expect(factorId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("jemg: finishing a second passkey does not overwrite the session's mfaVerifiedAt", async () => {
    const { email, enrollCookie } = await userWithPasskey();
    const earlier = new Date(Date.now() - 2 * 60_000);
    await stampSessions(email, earlier);
    const authenticator = createSoftwareAuthenticator();
    const { factorId, challenge } = await startEnrollment(enrollCookie);
    const finished = await finishEnrollment(
      enrollCookie,
      factorId,
      registrationResponse(authenticator, {
        challenge,
        rpId: RP_ID,
        origin: WEB_ORIGIN,
      }),
    );
    expect(finished.status).toBe(200);
    expect((await sessionStamp(email))?.getTime()).toBe(earlier.getTime());
  });

  it("jemg: enrolling the first passkey still verifies a session that had no factor", async () => {
    const { email } = await userWithPasskey();
    expect(await sessionStamp(email)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Factor activation is re-checked when enrollment FINISHES (Codex second
// opinion P1). Contract assumptions (docs/CONTRACT.md, "a second factor needs a
// fresh proof of an existing one"):
//  - Finishing enrollment of a factor, when the user already has ANOTHER
//    verified factor, needs a session with fresh MFA; otherwise 403 MFA_REQUIRED
//    (never proven) the same as at enrollment start. The check happens at
//    activation time, not only when enrollment was started.
//  - The first verified factor of a user never needs prior MFA.
//  - A refused activation leaves the factor pending (verified_at NULL), leaves
//    the refused session's mfaVerifiedAt NULL, and does not burn the TOTP code
//    (last_used_step stays NULL, no failed attempt is counted).
// ---------------------------------------------------------------------------

/** Live session ids of a user, used to identify which session a sign-in made. */
async function liveSessionIds(email: string): Promise<Set<string>> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM "session"
     WHERE revoked_at IS NULL
       AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
    [email],
  );
  return new Set(rows.map((row) => row.id));
}

/** Signs in and returns the cookie plus the id of the session that sign-in created. */
async function trackedSignIn(email: string) {
  const before = await liveSessionIds(email);
  const cookie = await signIn(email);
  const created = [...(await liveSessionIds(email))].filter(
    (id) => !before.has(id),
  );
  expect(created).toHaveLength(1);
  return { cookie, sessionId: created[0]! };
}

async function sessionMfaStamp(sessionId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ mfa_verified_at: Date | null }>(
    'SELECT mfa_verified_at FROM "session" WHERE id = $1',
    [sessionId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.mfa_verified_at;
}

async function factorRow(factorId: string) {
  const { rows } = await owner.query<{
    verified_at: Date | null;
    public_key: unknown;
    last_used_step: string | null;
    failed_attempts: number;
  }>(
    "SELECT verified_at, public_key, last_used_step, failed_attempts FROM mfa_factors WHERE id = $1",
    [factorId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function verifiedFactorCount(email: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*) AS count FROM mfa_factors
     WHERE verified_at IS NOT NULL
       AND user_id::text = (SELECT id FROM "user" WHERE email = $1)`,
    [email],
  );
  return Number(rows[0]!.count);
}

async function startTotp(cookie: string) {
  const response = await post(cookie, "/api/auth/mfa/factors", {
    type: "totp",
  });
  expect(response.status).toBe(201);
  return {
    factorId: response.body.data.factorId as string,
    secretBase32: response.body.data.secretBase32 as string,
  };
}

const finishTotp = (
  cookie: string,
  totp: { factorId: string; secretBase32: string },
) =>
  post(cookie, "/api/auth/mfa/verify", {
    factorId: totp.factorId,
    code: totpCode(totp.secretBase32, totpStep(new Date())),
  });

const passkeyAttestation = (challenge: string) =>
  registrationResponse(createSoftwareAuthenticator(), {
    challenge,
    rpId: RP_ID,
    origin: WEB_ORIGIN,
  });

describe("Finishing a factor re-checks the user's other verified factors (Codex P1)", () => {
  it("jemg-activation: a passkey started before the victim's TOTP went live cannot be activated without MFA", async () => {
    const email = await signUp(agent(app), "Korban");
    const attacker = await trackedSignIn(email); // session A
    const victim = await trackedSignIn(email); // session B

    // A starts a passkey while the user has no verified factor yet.
    const passkey = await startEnrollment(attacker.cookie);
    // B starts TOTP and activates it with a correct code (first factor).
    const totp = await startTotp(victim.cookie);
    expect((await finishTotp(victim.cookie, totp)).status).toBe(200);
    expect(await verifiedFactorCount(email)).toBe(1);

    // A now tries to finish the passkey without ever proving the TOTP.
    const refused = await finishEnrollment(
      attacker.cookie,
      passkey.factorId,
      passkeyAttestation(passkey.challenge),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("MFA_REQUIRED");

    const factor = await factorRow(passkey.factorId);
    expect(factor.verified_at).toBeNull();
    expect(await sessionMfaStamp(attacker.sessionId)).toBeNull();
    expect(await sessionIsVerified(attacker.cookie)).toBe(false);
    expect(await verifiedFactorCount(email)).toBe(1);
  });

  it("jemg-activation: a TOTP started before a passkey went live cannot be activated without MFA", async () => {
    const email = await signUp(agent(app), "Korban Terbalik");
    const attacker = await trackedSignIn(email); // session A
    const victim = await trackedSignIn(email); // session B

    // A starts TOTP (pending); B starts a passkey and activates it (first factor).
    const totp = await startTotp(attacker.cookie);
    const passkey = await startEnrollment(victim.cookie);
    expect(
      (
        await finishEnrollment(
          victim.cookie,
          passkey.factorId,
          passkeyAttestation(passkey.challenge),
        )
      ).status,
    ).toBe(200);
    expect(await verifiedFactorCount(email)).toBe(1);

    // A finishes TOTP with the correct code, but has no MFA proof.
    const refused = await finishTotp(attacker.cookie, totp);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("MFA_REQUIRED");

    const factor = await factorRow(totp.factorId);
    expect(factor.verified_at).toBeNull();
    // The refused session must not burn the code or count a failed attempt.
    expect(factor.last_used_step).toBeNull();
    expect(factor.failed_attempts).toBe(0);
    expect(await sessionMfaStamp(attacker.sessionId)).toBeNull();
    expect(await sessionIsVerified(attacker.cookie)).toBe(false);
    expect(await verifiedFactorCount(email)).toBe(1);
  });

  it("jemg-activation: two sessions finishing different first factors at once leave exactly one verified factor", async () => {
    const email = await signUp(agent(app), "Serentak");
    const sessionA = await trackedSignIn(email);
    const sessionB = await trackedSignIn(email);

    const passkey = await startEnrollment(sessionA.cookie);
    const totp = await startTotp(sessionB.cookie);

    const [passkeyResult, totpResult] = await Promise.all([
      finishEnrollment(
        sessionA.cookie,
        passkey.factorId,
        passkeyAttestation(passkey.challenge),
      ),
      finishTotp(sessionB.cookie, totp),
    ]);

    const statuses = [passkeyResult.status, totpResult.status].sort();
    expect(statuses).toEqual([200, 403]);
    const loser = passkeyResult.status === 200 ? totpResult : passkeyResult;
    expect(loser.body.error.code).toBe("MFA_REQUIRED");

    expect(await verifiedFactorCount(email)).toBe(1);
    // Only the winning session carries an MFA proof.
    const stamps = await Promise.all([
      sessionMfaStamp(sessionA.sessionId),
      sessionMfaStamp(sessionB.sessionId),
    ]);
    expect(stamps.filter((stamp) => stamp !== null)).toHaveLength(1);
    expect(stamps[passkeyResult.status === 200 ? 0 : 1]).not.toBeNull();
  });

  it("jemg-activation: control, the first factor needs no prior MFA", async () => {
    const email = await signUp(agent(app), "Faktor Pertama");
    const session = await trackedSignIn(email);
    const passkey = await startEnrollment(session.cookie);
    const finished = await finishEnrollment(
      session.cookie,
      passkey.factorId,
      passkeyAttestation(passkey.challenge),
    );
    expect(finished.status).toBe(200);
    expect((await factorRow(passkey.factorId)).verified_at).not.toBeNull();
    expect(await sessionMfaStamp(session.sessionId)).not.toBeNull();
  });

  it("jemg-activation: control, a session with fresh MFA can finish a second factor started earlier", async () => {
    const email = await signUp(agent(app), "Segar");
    const session = await trackedSignIn(email);

    // Both factors are started while none is verified.
    const passkey = await startEnrollment(session.cookie);
    const totp = await startTotp(session.cookie);

    // The passkey becomes the first factor and stamps this session.
    expect(
      (
        await finishEnrollment(
          session.cookie,
          passkey.factorId,
          passkeyAttestation(passkey.challenge),
        )
      ).status,
    ).toBe(200);

    // The same session now has fresh MFA, so it may also activate the TOTP.
    const second = await finishTotp(session.cookie, totp);
    expect(second.status).toBe(200);
    expect(await verifiedFactorCount(email)).toBe(2);
  });

  it("jemg-activation: control, a session with fresh MFA can finish a second passkey", async () => {
    const { email, enrollCookie } = await userWithPasskey();
    const second = await startEnrollment(enrollCookie);
    const finished = await finishEnrollment(
      enrollCookie,
      second.factorId,
      passkeyAttestation(second.challenge),
    );
    expect(finished.status).toBe(200);
    expect(await verifiedFactorCount(email)).toBe(2);
  });
});
