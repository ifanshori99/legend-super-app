// Staff MFA recovery codes over the real Express app (AUTH-05 / sub-brief
// legend-omp4). Real TOTP enroll -> verify, then the recovery-code endpoints:
//   GET  /api/auth/mfa/recovery-codes   status { remaining, generatedAt }
//   POST /api/auth/mfa/recovery-codes   generate / regenerate (plaintext once)
//   POST /api/auth/mfa/recovery         consume { code } -> { verifiedAt, remaining }
//
// Assumptions where the brief is silent:
//  - Status for a user who never generated codes is { remaining: 0, generatedAt: null }.
//  - A malformed code is refused with a 4xx (exact status not asserted).
//  - Audit rows are written before the HTTP response returns (no polling).
//  - The audit tenant is the session's tenant_id, set here through the owner
//    pool (same technique as hris-offboarding-clearance.test.ts).
//
// audit_logs is append-only: its rows are not cleaned up, every assertion is
// scoped to the actor (a fresh user per test).

import { Pool } from "pg";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { totpCode, totpStep } from "../lib/totp";
import { requireAuth } from "../middleware/auth";
import { errorHandler } from "../middleware/error-handler";
import { requireSessionMfa } from "../middleware/identity";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const TENANT_ID = cafeLegendPlatformFixtures.tenant.id;
const PASSWORD = "Test-password-123!";
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
const createdUserIds = new Set<string>();

afterAll(async () => {
  if (createdUserIds.size > 0) {
    const ids = [...createdUserIds];
    await owner.query(
      "DELETE FROM mfa_recovery_code_sets WHERE user_id = ANY($1::uuid[])",
      [ids],
    );
    await owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [ids],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [ids]);
  }
  await owner.end();
});

/** Only the platform probe is needed: it is closed until the session is MFA-verified. */
const probe = express();
probe.get("/platform/probe", requireAuth, requireSessionMfa(), (_req, res) => {
  res.json({ ok: true });
});
probe.use(errorHandler);

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

async function sessionOf(cookie: string) {
  const response = await request(app)
    .get("/api/auth/get-session")
    .set("Cookie", cookie);
  expect(response.status).toBe(200);
  return {
    sessionId: response.body.session.id as string,
    userId: response.body.user.id as string,
  };
}

/** Give a session a tenant so the service has somewhere to write audit rows. */
async function setSessionTenant(sessionId: string, tenantId: string | null) {
  await owner.query(
    tenantId === null
      ? `UPDATE "session" SET tenant_id = NULL WHERE id = $1`
      : `UPDATE "session" SET kind = 'management', tenant_id = $2 WHERE id = $1`,
    tenantId === null ? [sessionId] : [sessionId, tenantId],
  );
}

type Staff = {
  email: string;
  userId: string;
  factorId: string;
  /** Session that proved the TOTP factor (MFA-verified). */
  cookie: string;
  sessionId: string;
};

/** A user with one verified TOTP factor and one MFA-verified session. */
async function staffWithFactor(name: string): Promise<Staff> {
  const client = agent(app);
  const email = await signUp(client, name);
  const cookie = await signInCookie(email);
  const enroll = await request(app)
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ type: "totp" });
  expect(enroll.status).toBe(201);
  const { factorId, secretBase32 } = enroll.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await request(app)
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status).toBe(200);
  const { sessionId, userId } = await sessionOf(cookie);
  return { email, userId, factorId, cookie, sessionId };
}

function generate(cookie: string) {
  return request(app)
    .post("/api/auth/mfa/recovery-codes")
    .set(originHeader)
    .set("Cookie", cookie);
}

function status(cookie: string) {
  return request(app).get("/api/auth/mfa/recovery-codes").set("Cookie", cookie);
}

function useCode(cookie: string, code: string) {
  return request(app)
    .post("/api/auth/mfa/recovery")
    .set(originHeader)
    .set("Cookie", cookie)
    .send({ code });
}

async function generateCodes(staff: Staff): Promise<string[]> {
  const response = await generate(staff.cookie);
  expect(response.status).toBeLessThan(300);
  return response.body.data.codes as string[];
}

/** A well-formed code that is (practically) never in a generated set. */
const WRONG_CODES = [
  "AAAAA-AAAAA",
  "BBBBB-BBBBB",
  "CCCCC-CCCCC",
  "DDDDD-DDDDD",
  "EEEEE-EEEEE",
  "FFFFF-FFFFF",
];

async function mfaVerifiedAt(sessionId: string): Promise<Date | null> {
  const { rows } = await owner.query<{ mfa_verified_at: Date | null }>(
    `SELECT mfa_verified_at FROM "session" WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.mfa_verified_at ?? null;
}

type RecoveryAuditEvent = {
  action: string;
  objectType: string;
  objectId: string | null;
  tenantId: string;
  actorType: string;
  actorId: string | null;
  maskedChanges: { after: Record<string, unknown> | null };
};

async function recoveryAudit(userId: string) {
  const { rows } = await owner.query<{
    tenant_id: string;
    retention_class: string;
    event: RecoveryAuditEvent;
  }>(
    `SELECT tenant_id, retention_class, event FROM audit_logs
      WHERE event->>'objectType' = 'mfa_recovery_code_set'
        AND event->>'actorId' = $1
      ORDER BY id`,
    [userId],
  );
  return rows;
}

describe("Staff MFA recovery codes", () => {
  it("AUTH-05 recovery: generates 10 codes in XXXXX-XXXXX form, shown once, for an MFA-verified session", async () => {
    const staff = await staffWithFactor("Pemilik Kode");

    const response = await generate(staff.cookie);
    expect(response.status).toBe(201);
    const { codes, generatedAt } = response.body.data as {
      codes: string[];
      generatedAt: string;
    };
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(CODE_PATTERN);
    expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);

    // Status reports how many are left, never the codes themselves.
    const current = await status(staff.cookie);
    expect(current.status).toBe(200);
    expect(current.body.data.remaining).toBe(10);
    expect(current.body.data.generatedAt).toBeTruthy();
    expect(Object.keys(current.body.data).sort()).toEqual([
      "generatedAt",
      "remaining",
    ]);
    const serialized = JSON.stringify(current.body);
    for (const code of codes) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(code.replace("-", ""));
    }
  });

  it("AUTH-05 recovery: status is empty before any codes were generated", async () => {
    const staff = await staffWithFactor("Belum Punya Kode");
    const response = await status(staff.cookie);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ remaining: 0, generatedAt: null });
  });

  it("AUTH-05 recovery: only a signed-in user can read status, generate or use codes", async () => {
    const get = await request(app).get("/api/auth/mfa/recovery-codes");
    expect(get.status).toBe(401);
    const post = await request(app)
      .post("/api/auth/mfa/recovery-codes")
      .set(originHeader);
    expect(post.status).toBe(401);
    const consume = await request(app)
      .post("/api/auth/mfa/recovery")
      .set(originHeader)
      .send({ code: WRONG_CODES[0] });
    expect(consume.status).toBe(401);
  });

  it("AUTH-05 recovery: generating needs a session that already verified MFA", async () => {
    const staff = await staffWithFactor("Hanya Kata Sandi");
    // A second sign-in with only the password: has the factor, not verified.
    const passwordOnly = await signInCookie(staff.email);
    const denied = await generate(passwordOnly);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("MFA_REQUIRED");

    const stored = await owner.query(
      "SELECT 1 FROM mfa_recovery_code_sets WHERE user_id = $1",
      [staff.userId],
    );
    expect(stored.rowCount).toBe(0);
  });

  it("AUTH-05 recovery: generating without a verified factor is a conflict", async () => {
    const client = agent(app);
    const email = await signUp(client, "Tanpa Faktor");
    const cookie = await signInCookie(email);
    // Session is marked verified out of band, but the user has no factor.
    await verifySessionMfa(email);

    const response = await generate(cookie);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("AUTH-05 recovery: the database holds only keyed hashes, never the plaintext codes", async () => {
    const staff = await staffWithFactor("Simpan Hash");
    const codes = await generateCodes(staff);

    const { rows } = await owner.query<{
      code_hash: string;
      used_at: Date | null;
    }>(
      `SELECT c.code_hash, c.used_at
         FROM mfa_recovery_codes c
         JOIN mfa_recovery_code_sets s ON s.id = c.set_id
        WHERE s.user_id = $1`,
      [staff.userId],
    );
    expect(rows).toHaveLength(10);
    const plain = new Set(
      codes.flatMap((code) => [
        code,
        code.replace("-", ""),
        code.toLowerCase(),
      ]),
    );
    for (const row of rows) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(plain.has(row.code_hash)).toBe(false);
      expect(row.used_at).toBeNull();
    }
    expect(new Set(rows.map((row) => row.code_hash)).size).toBe(10);
  });

  it("AUTH-05 recovery: a code signs in a session that is not MFA-verified, once, and the count drops", async () => {
    const staff = await staffWithFactor("Pakai Sekali");
    const codes = await generateCodes(staff);

    const fresh = await signInCookie(staff.email);
    const { sessionId } = await sessionOf(fresh);
    const before = await request(probe)
      .get("/platform/probe")
      .set("Cookie", fresh);
    expect(before.status).toBe(403);
    expect(before.body.error.code).toBe("MFA_REQUIRED");
    expect(await mfaVerifiedAt(sessionId)).toBeNull();

    const used = await useCode(fresh, codes[0]!);
    expect(used.status).toBe(200);
    expect(used.body.data.remaining).toBe(9);
    expect(Number.isNaN(Date.parse(used.body.data.verifiedAt))).toBe(false);
    expect(await mfaVerifiedAt(sessionId)).not.toBeNull();

    const after = await request(probe)
      .get("/platform/probe")
      .set("Cookie", fresh);
    expect(after.status).toBe(200);
    expect((await status(fresh)).body.data.remaining).toBe(9);

    // The same code on another password-only session is refused.
    const other = await signInCookie(staff.email);
    const { sessionId: otherSessionId } = await sessionOf(other);
    const replay = await useCode(other, codes[0]!);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
    expect(replay.body.error.message).toBe(
      "Kode cadangan salah atau sudah dipakai.",
    );
    expect(await mfaVerifiedAt(otherSessionId)).toBeNull();
    expect((await status(staff.cookie)).body.data.remaining).toBe(9);
  });

  it("AUTH-05 recovery: a code is accepted in lowercase and without the dash", async () => {
    const staff = await staffWithFactor("Format Longgar");
    const codes = await generateCodes(staff);

    const lowerNoDash = await signInCookie(staff.email);
    const first = await useCode(
      lowerNoDash,
      codes[0]!.replace("-", "").toLowerCase(),
    );
    expect(first.status).toBe(200);
    expect(first.body.data.remaining).toBe(9);

    const spaced = await signInCookie(staff.email);
    const second = await useCode(spaced, `  ${codes[1]!.toLowerCase()}  `);
    expect(second.status).toBe(200);
    expect(second.body.data.remaining).toBe(8);
  });

  it("AUTH-05 recovery: a malformed code is refused and never verifies the session", async () => {
    const staff = await staffWithFactor("Format Salah");
    await generateCodes(staff);
    const fresh = await signInCookie(staff.email);
    const { sessionId } = await sessionOf(fresh);

    for (const bad of ["", "12345", "ABCDE-FGHIJ-KLMNO", "ABC!E-FGHIJ"]) {
      const response = await useCode(fresh, bad);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(await mfaVerifiedAt(sessionId)).toBeNull();
  });

  it("AUTH-05 recovery: a user with no codes gets the same 401 as a wrong code", async () => {
    const client = agent(app);
    const email = await signUp(client, "Tanpa Kode");
    const cookie = await signInCookie(email);
    const response = await useCode(cookie, WRONG_CODES[0]!);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
  });

  it("AUTH-05 recovery: regenerating invalidates every old code and the new set works", async () => {
    const staff = await staffWithFactor("Buat Ulang");
    const oldCodes = await generateCodes(staff);
    const newCodes = await generateCodes(staff);
    expect(newCodes).toHaveLength(10);
    expect(newCodes.filter((code) => oldCodes.includes(code))).toEqual([]);
    expect((await status(staff.cookie)).body.data.remaining).toBe(10);

    for (const old of [oldCodes[0]!, oldCodes[9]!]) {
      const fresh = await signInCookie(staff.email);
      const refused = await useCode(fresh, old);
      expect(refused.status).toBe(401);
      expect(refused.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
    }

    const fresh = await signInCookie(staff.email);
    const accepted = await useCode(fresh, newCodes[3]!);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.remaining).toBe(9);

    const sets = await owner.query(
      "SELECT 1 FROM mfa_recovery_code_sets WHERE user_id = $1",
      [staff.userId],
    );
    expect(sets.rowCount).toBe(1);
    const rows = await owner.query(
      `SELECT 1 FROM mfa_recovery_codes c
         JOIN mfa_recovery_code_sets s ON s.id = c.set_id
        WHERE s.user_id = $1`,
      [staff.userId],
    );
    expect(rows.rowCount).toBe(10);
  });

  it("AUTH-05 recovery: five wrong codes lock for 15 minutes, even a valid code is refused, and the counter persists", async () => {
    const staff = await staffWithFactor("Salah Lima Kali");
    const codes = await generateCodes(staff);
    const fresh = await signInCookie(staff.email);
    const { sessionId } = await sessionOf(fresh);

    for (const wrong of WRONG_CODES.slice(0, 2)) {
      const miss = await useCode(fresh, wrong);
      expect(miss.status).toBe(401);
      expect(miss.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
    }
    // Failed attempts are committed even though the request failed.
    const counted = await owner.query<{ failed_attempts: number }>(
      "SELECT failed_attempts FROM mfa_recovery_code_sets WHERE user_id = $1",
      [staff.userId],
    );
    expect(counted.rows[0]?.failed_attempts).toBe(2);

    for (const wrong of WRONG_CODES.slice(2, 4)) {
      expect((await useCode(fresh, wrong)).status).toBe(401);
    }
    const fifth = await useCode(fresh, WRONG_CODES[4]!);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe("RATE_LIMITED");
    expect(fifth.body.error.message).toBe(
      "Terlalu banyak kode salah. Coba lagi dalam 15 menit.",
    );

    const locked = await owner.query<{
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      "SELECT failed_attempts, locked_until FROM mfa_recovery_code_sets WHERE user_id = $1",
      [staff.userId],
    );
    expect(locked.rows[0]?.failed_attempts).toBe(5);
    expect(locked.rows[0]?.locked_until).not.toBeNull();

    // A valid code is refused while locked, from this and from another session.
    const validWhileLocked = await useCode(fresh, codes[0]!);
    expect(validWhileLocked.status).toBe(429);
    expect(validWhileLocked.body.error.code).toBe("RATE_LIMITED");
    const other = await signInCookie(staff.email);
    expect((await useCode(other, codes[1]!)).status).toBe(429);
    expect(await mfaVerifiedAt(sessionId)).toBeNull();
    expect((await status(staff.cookie)).body.data.remaining).toBe(10);
  });

  it("AUTH-05 recovery: after the lock expires a valid code works and resets the counter", async () => {
    const staff = await staffWithFactor("Kunci Selesai");
    const codes = await generateCodes(staff);
    const fresh = await signInCookie(staff.email);
    for (const wrong of WRONG_CODES.slice(0, 5)) await useCode(fresh, wrong);
    expect((await useCode(fresh, codes[0]!)).status).toBe(429);

    // 15 minutes pass: move the lock into the past (owner pool, like other suites).
    await owner.query(
      `UPDATE mfa_recovery_code_sets
          SET locked_until = now() - interval '1 minute'
        WHERE user_id = $1`,
      [staff.userId],
    );
    const accepted = await useCode(fresh, codes[0]!);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.remaining).toBe(9);

    const reset = await owner.query<{
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      "SELECT failed_attempts, locked_until FROM mfa_recovery_code_sets WHERE user_id = $1",
      [staff.userId],
    );
    expect(reset.rows[0]?.failed_attempts).toBe(0);
    expect(reset.rows[0]?.locked_until).toBeNull();
  });

  it("AUTH-05 recovery: deleting the last verified factor revokes the codes", async () => {
    const staff = await staffWithFactor("Hapus Faktor Terakhir");
    const codes = await generateCodes(staff);

    const removed = await request(app)
      .delete(`/api/auth/mfa/factors/${staff.factorId}`)
      .set(originHeader)
      .set("Cookie", staff.cookie);
    expect(removed.status).toBe(204);

    const sets = await owner.query(
      "SELECT 1 FROM mfa_recovery_code_sets WHERE user_id = $1",
      [staff.userId],
    );
    expect(sets.rowCount).toBe(0);
    const rows = await owner.query(
      `SELECT 1 FROM mfa_recovery_codes WHERE set_id NOT IN
         (SELECT id FROM mfa_recovery_code_sets)`,
    );
    expect(rows.rowCount).toBe(0);

    // A code must never satisfy MFA when no factor is left.
    const fresh = await signInCookie(staff.email);
    const { sessionId } = await sessionOf(fresh);
    const refused = await useCode(fresh, codes[0]!);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("MFA_RECOVERY_CODE_INVALID");
    expect(await mfaVerifiedAt(sessionId)).toBeNull();
    expect((await status(fresh)).body.data.remaining).toBe(0);
  });

  it("AUTH-05 recovery: audit rows are written on the session tenant without the code or its hash", async () => {
    const staff = await staffWithFactor("Jejak Audit");
    await setSessionTenant(staff.sessionId, TENANT_ID);

    const first = await generateCodes(staff);
    const second = await generateCodes(staff); // regenerate
    const stored = await owner.query<{ code_hash: string }>(
      `SELECT c.code_hash FROM mfa_recovery_codes c
         JOIN mfa_recovery_code_sets s ON s.id = c.set_id
        WHERE s.user_id = $1`,
      [staff.userId],
    );
    const hashes = stored.rows.map((row) => row.code_hash);
    expect(hashes).toHaveLength(10);

    const fresh = await signInCookie(staff.email);
    const { sessionId } = await sessionOf(fresh);
    await setSessionTenant(sessionId, TENANT_ID);
    expect((await useCode(fresh, second[0]!)).status).toBe(200);
    expect((await useCode(fresh, WRONG_CODES[0]!)).status).toBe(401);
    for (const wrong of WRONG_CODES.slice(1, 5)) await useCode(fresh, wrong);
    // Locked now: this attempt is rejected as "locked".
    expect((await useCode(fresh, second[1]!)).status).toBe(429);

    const removed = await request(app)
      .delete(`/api/auth/mfa/factors/${staff.factorId}`)
      .set(originHeader)
      .set("Cookie", staff.cookie);
    expect(removed.status).toBe(204);

    const rows = await recoveryAudit(staff.userId);
    const events = rows.map((row) => row.event);
    const byAction = (action: string) =>
      events.filter((event) => event.action === action);
    const afterOf = (event: RecoveryAuditEvent) => event.maskedChanges.after;

    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_ID);
      expect(row.retention_class).toBe("audit_2y");
      expect(row.event.tenantId).toBe(TENANT_ID);
      expect(row.event.actorType).toBe("user");
      expect(row.event.actorId).toBe(staff.userId);
      expect(row.event.objectType).toBe("mfa_recovery_code_set");
      expect(row.event.objectId).toBeTruthy();
    }

    const generated = byAction("mfa_recovery_codes.generated");
    expect(generated).toHaveLength(2);
    expect(generated.map(afterOf)).toEqual([
      { count: 10, regenerated: false },
      { count: 10, regenerated: true },
    ]);

    const used = byAction("mfa_recovery_code.used");
    expect(used).toHaveLength(1);
    expect(afterOf(used[0]!)).toEqual({ remaining: 9 });

    const rejectedCauses = byAction("mfa_recovery_code.rejected").map(
      (event) => afterOf(event)?.cause,
    );
    expect(rejectedCauses).toContain("invalid");
    expect(rejectedCauses).toContain("locked");
    for (const cause of rejectedCauses)
      expect(["invalid", "locked"]).toContain(cause);

    const revoked = byAction("mfa_recovery_codes.revoked");
    expect(revoked).toHaveLength(1);
    expect(afterOf(revoked[0]!)).toEqual({ cause: "last_factor_deleted" });

    // Neither a code nor its stored hash may appear in any audit event.
    const serialized = JSON.stringify(rows.map((row) => row.event));
    for (const code of [...first, ...second, ...WRONG_CODES]) {
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(code.replace("-", ""));
    }
    for (const hash of hashes) expect(serialized).not.toContain(hash);
  });

  it("AUTH-05 recovery: a session without a tenant leaves no audit row", async () => {
    const staff = await staffWithFactor("Tanpa Tenant");
    await setSessionTenant(staff.sessionId, null);
    const codes = await generateCodes(staff);
    const fresh = await signInCookie(staff.email);
    const { sessionId } = await sessionOf(fresh);
    await setSessionTenant(sessionId, null);

    expect((await useCode(fresh, codes[0]!)).status).toBe(200);
    expect((await useCode(fresh, WRONG_CODES[0]!)).status).toBe(401);
    expect(await recoveryAudit(staff.userId)).toHaveLength(0);
  });
});
