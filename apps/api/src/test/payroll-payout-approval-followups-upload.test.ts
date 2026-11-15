// Payment-proof upload needs the same password step-up as resolve (bead
// legend-dz8g3, brief "payout approval followups", card 2). Written fail-first
// from the brief, not from the implementation.
//
// Rule: POST /api/hris/payroll/disbursement-batches/:id/evidence keeps its MFA
// step-up and now ALSO asks the account password, read from the multipart field
// `password`, exactly when resolve would ask for it: a session whose second
// factor only comes from the first MFA enrollment, or whose real MFA challenge
// is too old. A session with a recent real challenge needs no password.
// - no password: 401 REAUTH_REQUIRED, nothing stored.
// - wrong password: 403, nothing stored (the brief says 403; resolve's tests
//   accept 401 or 403, this card pins 403).
// - right password: 201 with the key, one blob stored, password never echoed.
//
// Assumptions (the brief leaves them open):
// - The password travels as a plain multipart text field named `password`
//   (sent before the file part; the gate runs after the whole form is parsed).
// - A "too old" challenge is made by moving session.mfa_challenge_verified_at a
//   day into the past (the same device the resolve step-up tests use); one day
//   is beyond any PAYOUT_STEP_UP_MAX_AGE_MINUTES.
// - Why these tests fail today: upload has no password gate, so the missing and
//   wrong password cases answer 201 instead of 401/403 and store a blob.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { createApp } from "../app.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import type { StorageRuntime } from "../services/core-storage-runtime.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("approval-upload");
const BASE = "/api/hris/payroll/disbursement-batches";
const PASSWORD = "Test-password-123!";
const WRONG = "Salah-password-999!";
const APPROVE = ["payroll.view", "payroll.disburse.approve"];

const store = new FakeObjectStorage();
const runtime: StorageRuntime = {
  storage: store,
  scanner: new NoopMalwareScanner(),
  fileSigner: async () => "https://signed.example.test/x",
  hrisDocumentSigner: async () => null,
};
const app = createApp({ storageRuntime: runtime });
const blobCount = () =>
  (store as unknown as { objects: Map<string, unknown> }).objects.size;

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
const enrolledUsers: string[] = [];
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  if (grantedUsers.length > 0)
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  await dbOwner.end();
});

/**
 * An approver whose only second-factor proof is the enrollment itself (TOTP
 * enrolled and the first code verified in this session). `challenged` then
 * backdates the factor and verifies again, giving a real MFA challenge.
 */
async function approver(challenged: boolean) {
  const client = agent(app);
  await signUp(client, "Payout Upload Password");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, APPROVE);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  enrolledUsers.push(userId);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  if (challenged) {
    await dbOwner.query(
      "UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1",
      [factorId],
    );
    const again = await client
      .post("/api/auth/mfa/verify")
      .set(originHeader)
      .send({
        factorId,
        code: totpCode(secretBase32, totpStep(new Date()) + 1),
      });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  }
  return { client, userId };
}
type Staff = Awaited<ReturnType<typeof approver>>;

/** Moves the real-challenge stamp into the past; mfa_verified_at stays fresh. */
async function ageChallengeStamp(userId: string) {
  const moved = await dbOwner.query(
    `UPDATE "session" SET mfa_challenge_verified_at = now() - interval '1 day'
      WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
    [userId],
  );
  expect(moved.rowCount, "premise: the challenge stamped the session").toBe(1);
}

const pdfBytes = () =>
  Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\nlaporan bank\n%%EOF\n");

function upload(who: Staff, batchId: string, password?: string) {
  const req = who.client.post(`${BASE}/${batchId}/evidence`).set(originHeader);
  if (password !== undefined) req.field("password", password);
  return req.attach("file", pdfBytes(), {
    filename: "bukti.pdf",
    contentType: "application/pdf",
  });
}

async function exportedBatch() {
  const slips = [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  return W.exportedBatch(runId);
}
const snapshotOf = async (batchId: string) =>
  JSON.stringify({
    batch: await W.batchById(batchId),
    items: await W.itemsOf(batchId),
  });

describe("legend-dz8g3 proof upload asks the password like resolve", () => {
  it("[dz8g3-enrollment-only] an enrollment-only session without the password is 401 REAUTH_REQUIRED and stores nothing; a wrong password is 403 and stores nothing; the right one is 201 with the key", async () => {
    const batchId = await exportedBatch();
    const who = await approver(false);
    const state = await snapshotOf(batchId);
    const blobs = blobCount();

    const without = await upload(who, batchId);
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(without.body.error?.code).toBe("REAUTH_REQUIRED");
    const wrong = await upload(who, batchId, WRONG);
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(403);
    expect(blobCount(), "refused uploads store no blob").toBe(blobs);
    expect(await snapshotOf(batchId)).toBe(state);

    const ok = await upload(who, batchId, PASSWORD);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.evidenceKey).toContain(
      `tenants/${W.tenantId}/payroll-payout/${batchId}/`,
    );
    expect(blobCount()).toBe(blobs + 1);
    expect(JSON.stringify(ok.body)).not.toContain(PASSWORD);
    expect(await snapshotOf(batchId), "upload moves no batch or item").toBe(
      state,
    );
  });

  it("[dz8g3-challenged] a session with a recent real MFA challenge uploads without a password (no looser, no stricter than resolve)", async () => {
    const batchId = await exportedBatch();
    const who = await approver(true);
    const ok = await upload(who, batchId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("[dz8g3-stale-challenge] a real challenge older than the step-up window needs the password again: none is 401 REAUTH_REQUIRED, wrong 403, right 201", async () => {
    const batchId = await exportedBatch();
    const who = await approver(true);
    await ageChallengeStamp(who.userId);
    const blobs = blobCount();

    const without = await upload(who, batchId);
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(without.body.error?.code).toBe("REAUTH_REQUIRED");
    const wrong = await upload(who, batchId, WRONG);
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(403);
    expect(blobCount()).toBe(blobs);

    const ok = await upload(who, batchId, PASSWORD);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(blobCount()).toBe(blobs + 1);
  });
});
