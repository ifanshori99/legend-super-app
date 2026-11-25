import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../app";

if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
  throw new Error(
    "Run pnpm test from the repository root so these tests get their own disposable PostgreSQL server.",
  );

export const WEB_ORIGIN = new URL(
  process.env.WEB_URL ?? "http://localhost:3101",
).origin;
export const originHeader = { Origin: WEB_ORIGIN };

// A supertest agent keeps cookies between requests, like a browser.
export function agent(app: Express = createApp()) {
  return request.agent(app);
}

export async function signUp(
  client: ReturnType<typeof agent>,
  name = "Test User",
) {
  const email = `test-${randomUUID()}@example.com`;
  const response = await client
    .post("/api/auth/sign-up/email")
    .set(originHeader)
    .send({ name, email, password: "Test-password-123!" });
  if (response.status !== 200)
    throw new Error(`Sign-up failed with ${response.status}`);
  return email;
}

// The edge serves no password sign-in: the session cookie comes from the cloud.
export async function cloudSignIn(email: string): Promise<string> {
  const response = await request(createApp({ edgeMode: false }))
    .post("/api/auth/sign-in/email")
    .set(originHeader)
    .send({ email, password: "Test-password-123!" });
  if (response.status !== 200)
    throw new Error(`Sign-in failed with ${response.status}`);
  const lines = response.headers["set-cookie"] as unknown as string[];
  return lines.map((line) => line.split(";")[0]).join("; ");
}

// Roles are granted out of band, the way pnpm role:set does it.
export async function setRole(email: string, role: string | null) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rowCount } = await pool.query(
      'UPDATE "user" SET role = $1 WHERE email = $2',
      [role, email],
    );
    if (rowCount !== 1) throw new Error(`No user ${email}`);
  } finally {
    await pool.end();
  }
}

// AUTH-05: back-office and platform APIs are closed until this session verified
// a second factor. The real TOTP path (enroll → verify) is covered by
// identity-mfa-api.test.ts; every other suite marks the session verified here so
// it keeps testing its own concern.
export async function verifySessionMfa(email: string) {
  const pool = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 1,
  });
  try {
    const { rowCount } = await pool.query(
      // Stamp with the API clock, as identity-mfa.service does in production.
      // The database clock (Colima VM) can run ahead of the API clock, and a
      // verification dated in the future fails the role-grant re-auth age
      // check (assertCanGrantRole: age >= 0) with REAUTH_REQUIRED (legend-p4ap).
      `UPDATE "session" SET mfa_verified_at = $2
       WHERE revoked_at IS NULL
         AND user_id = (SELECT id FROM "user" WHERE email = $1)`,
      [email, new Date()],
    );
    if (rowCount === 0) throw new Error(`No session for ${email}`);
  } finally {
    await pool.end();
  }
}
