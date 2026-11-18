// Payout payment-proof binding and step-up (bead legend-658 card f5n9y, L5;
// design docs/design/payroll-disbursement.md 9 "MFA step-up", 7.7, 5.2; context
// docs/briefs/658-payout-gl-context.md). Written fail-first from the design,
// not from the implementation.
//
// Rules proven here:
// - A payment-proof (evidence) key is bound to the storage of the tenant that
//   owns the batch. A key of another tenant, or one that climbs out of the
//   batch folder with "..", is refused on manual confirm and on resolve, and
//   nothing changes (item status, resolver, GL). The cash handover takes no
//   evidence key at all: any key is PAYOUT_ITEMS_INVALID.
// - Step-up: confirm, resolve and cash handover over HTTP need a fresh second
//   factor AND, when the session's `mfa_verified_at` only comes from the first
//   MFA enrollment (the user just set up TOTP and never passed a challenge),
//   the account password again. Without it: 401 REAUTH_REQUIRED, nothing
//   changes. A wrong password is refused as well. The right password lets the
//   same call through.
//
// Contract chosen here (the engineer may adjust it in this file and in
// payroll-payout-fixtures.ts `evidenceKeyFor` only):
// - Valid evidence key: `tenants/<tenantId>/payroll-payout/<batchId>/<file>`.
//   Existence of the stored object is not checked (assumption); only the
//   binding to the tenant is. Refusal: 4xx HttpError, code
//   PAYOUT_EVIDENCE_INVALID.
// - HTTP routes (prefix /api/hris/payroll, permission
//   payroll.disburse.approve):
//     POST /disbursement-batches/:id/confirm       { results, password? }
//     POST /disbursement-batches/:id/resolve       { itemIds, outcome,
//                                                    evidenceKey, note, password? }
//     POST /disbursement-batches/:id/confirm-cash  { itemIds, password? }
//   `password` is the current account password. Missing password on an
//   enrollment-only session: 401 REAUTH_REQUIRED. Wrong password: 401 or 403
//   (only the status class and "nothing changed" are asserted).
// - The "genuinely challenged" session (TOTP passed at sign-in) is not covered
//   here: there is no test helper to build one without a marker column; the
//   engineer decides how enrollment-only is recorded.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { originHeader } from "./helpers.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  APP,
  APP2,
  APP3,
  BUDI,
  CASHIER,
  SITI,
  bank,
  cash,
  evidenceKeyFor,
  uploadEvidence,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("evidence");
const PASSWORD = "Test-password-123!";
const OTHER_TENANT_ID = "99999999-9999-4999-8999-999999999999";
const idOf = (row: Row) => row.id as string;
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

const SLIPS = () => [bank(BUDI, 4_000_000), bank(SITI, 3_000_000)];

async function exportedRun() {
  const slips = SLIPS();
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items };
}

/** Evidence keys that are not bound to this tenant's storage. */
const foreignKeys = (batchId: string) => ({
  "another tenant": evidenceKeyFor(OTHER_TENANT_ID, batchId, "bukti.pdf"),
  "path traversal out of the batch folder": `${evidenceKeyFor(W.tenantId, batchId, "x.pdf")}/../../../../${OTHER_TENANT_ID}/payroll-payout/${batchId}/bukti.pdf`,
});

describe("payment proof must belong to the tenant (service level)", () => {
  it("[evidence-confirm] a proof key of another tenant is refused on manual confirm; the own key passes", async () => {
    const { batchId, items } = await exportedRun();
    for (const [label, key] of Object.entries(foreignKeys(batchId))) {
      const results = W.succeedItems(batchId, items).map((r) => ({
        ...r,
        evidenceKey: key,
      }));
      await W.expectRefused(W.confirm(batchId, results), {
        code: "PAYOUT_EVIDENCE_INVALID",
      }).catch((error: unknown) => {
        throw new Error(`${label}: ${(error as Error).message}`);
      });
    }
    for (const item of await W.itemsOf(batchId)) {
      expect(item.status).toBe("exported");
      expect(item.gl_posting_id).toBeNull();
    }
    expect(await W.postingsOf(batchId)).toHaveLength(0);

    await W.confirm(batchId, W.succeedItems(batchId, items));
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("succeeded");
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });

  it("[evidence-resolve] a proof key of another tenant is refused on resolve at either step; no resolver is recorded", async () => {
    const { batchId, items } = await exportedRun();
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    for (const [label, key] of Object.entries(foreignKeys(batchId))) {
      await W.expectRefused(
        W.resolve(batchId, [idOf(siti)], "failed", APP, key),
        { code: "PAYOUT_EVIDENCE_INVALID" },
      ).catch((error: unknown) => {
        throw new Error(`${label}: ${(error as Error).message}`);
      });
    }
    let row = await W.itemOfPerson(batchId, SITI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by, "no first step recorded").toBeNull();

    // A valid first step by one person, then a foreign proof at step two.
    await W.resolve(batchId, [idOf(siti)], "failed", APP);
    await W.expectRefused(
      W.resolve(
        batchId,
        [idOf(siti)],
        "failed",
        APP3,
        foreignKeys(batchId)["another tenant"],
      ),
      { code: "PAYOUT_EVIDENCE_INVALID" },
    );
    row = await W.itemOfPerson(batchId, SITI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by_2, "no second step recorded").toBeNull();
  });

  it("[evidence-cash] any proof key on the cash handover is refused, foreign or own; nothing is paid or posted", async () => {
    const slips = [cash(CASHIER, 1_200_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    // legend-rvao9: approving a cash batch needs enough cash in 1102.
    await W.fundPettyCash(2_000_000);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    for (const [label, key] of Object.entries(foreignKeys(batchId))) {
      await W.expectRefused(W.handover(batchId, items.map(idOf), APP2, key), {
        code: "PAYOUT_ITEMS_INVALID",
      }).catch((error: unknown) => {
        throw new Error(`${label}: ${(error as Error).message}`);
      });
    }
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("approved");
    expect(await W.postingsOf(batchId)).toHaveLength(0);
    expect((await W.runRow(runId)).status).toBe("locked");

    await W.expectRefused(
      W.handover(
        batchId,
        items.map(idOf),
        APP2,
        evidenceKeyFor(W.tenantId, batchId, "serah-terima.pdf"),
      ),
      { code: "PAYOUT_ITEMS_INVALID" },
    );
    await W.handover(batchId, items.map(idOf), APP2);
    expect((await W.runRow(runId)).status).toBe("paid");
  });
});

// ---- Step-up over HTTP -------------------------------------------------------

/**
 * A staff member whose only second-factor proof is the enrollment itself:
 * signed up, enrolled TOTP and verified the first code. mfa_verified_at is
 * fresh, but no challenge was ever passed at sign-in.
 */
async function enrollmentOnlyApprover(label: string) {
  const { client, userId } = await W.signedInClient(`Payout ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  enrolledUsers.push(userId);
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  const stamp = await mfaOwner.query(
    `SELECT mfa_verified_at FROM "session" WHERE revoked_at IS NULL AND user_id = $1 AND id NOT LIKE 'payout-fixture-session-%'`,
    [userId],
  );
  expect(
    stamp.rows[0]?.mfa_verified_at,
    "premise: the enrollment stamped a fresh mfa_verified_at",
  ).not.toBeNull();
  return { client, userId, factorId, secretBase32 };
}

/**
 * An approver who passed a real challenge: the factor existed before the
 * session (backdated here), so the verify call stamps
 * `mfa_challenge_verified_at`.
 */
async function challengedApprover(label: string) {
  const approver = await enrollmentOnlyApprover(label);
  await mfaOwner.query(
    `UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1`,
    [approver.factorId],
  );
  const challenged = await approver.client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId: approver.factorId,
      code: totpCode(approver.secretBase32, totpStep(new Date()) + 1),
    });
  expect(challenged.status, JSON.stringify(challenged.body)).toBe(200);
  return approver;
}

/** Moves the challenge stamp into the past; mfa_verified_at stays fresh. */
async function ageChallengeStamp(userId: string, age: string) {
  const moved = await mfaOwner.query(
    `UPDATE "session" SET mfa_challenge_verified_at = now() - $2::interval
      WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
    [userId, age],
  );
  expect(moved.rowCount, "premise: the challenge stamped the session").toBe(1);
}

const BASE = "/api/hris/payroll/disbursement-batches";
const errorCodeOf = (body: { error?: { code?: string } }) => body.error?.code;

describe("step-up: password again when MFA was only just enrolled", () => {
  it("[stepup-confirm] confirm without the password is 401 REAUTH_REQUIRED, with a wrong password refused, with the right one it goes through", async () => {
    const { batchId, items } = await exportedRun();
    const { client } = await enrollmentOnlyApprover("Konfirmasi");
    const results = W.succeedItems(batchId, items);

    const without = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results });
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");

    const wrong = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results, password: "Salah-password-999!" });
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);

    for (const item of await W.itemsOf(batchId))
      expect(item.status, "nothing changed").toBe("exported");
    expect(await W.postingsOf(batchId)).toHaveLength(0);

    const ok = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results, password: PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("succeeded");
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });

  it("[stepup-resolve] resolve without the password is 401 REAUTH_REQUIRED and records no resolver; with the right one the first step is recorded", async () => {
    const { batchId, items } = await exportedRun();
    const { client, userId } = await enrollmentOnlyApprover("Putus");
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const body = {
      itemIds: [idOf(siti)],
      outcome: "failed",
      evidenceKey: uploadEvidence(batchId, "bank-menolak.pdf"),
      note: "Bank menolak transfer, tidak ada dana keluar",
    };

    const without = await client
      .post(`${BASE}/${batchId}/resolve`)
      .set(originHeader)
      .send(body);
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
    const wrong = await client
      .post(`${BASE}/${batchId}/resolve`)
      .set(originHeader)
      .send({ ...body, password: "Salah-password-999!" });
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
    let row = await W.itemOfPerson(batchId, SITI);
    expect(row.status).toBe("exported");
    expect(row.resolved_by).toBeNull();

    const ok = await client
      .post(`${BASE}/${batchId}/resolve`)
      .set(originHeader)
      .send({ ...body, password: PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    row = await W.itemOfPerson(batchId, SITI);
    expect(row.resolved_by).toBe(userId);
  });

  it("[stepup-confirm-cash] the cash handover without the password is 401 REAUTH_REQUIRED and pays nothing; with the right one the run is paid", async () => {
    const slips = [cash(CASHIER, 900_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    // legend-rvao9: approving a cash batch needs enough cash in 1102.
    await W.fundPettyCash(2_000_000);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    const { client } = await enrollmentOnlyApprover("Tunai");
    const body = {
      itemIds: items.map(idOf),
    };

    const without = await client
      .post(`${BASE}/${batchId}/confirm-cash`)
      .set(originHeader)
      .send(body);
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("approved");
    expect(await W.postingsOf(batchId)).toHaveLength(0);
    expect((await W.runRow(runId)).status).toBe("locked");

    const ok = await client
      .post(`${BASE}/${batchId}/confirm-cash`)
      .set(originHeader)
      .send({ ...body, password: PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await W.runRow(runId)).status).toBe("paid");
  });

  it("[stepup-same-session-verify] enrolling a factor and verifying it again in the same session is not a challenge: confirm still asks for the password", async () => {
    const { batchId, items } = await exportedRun();
    const { client, factorId, secretBase32 } = await enrollmentOnlyApprover(
      "Daftar Lalu Verifikasi",
    );
    const results = W.succeedItems(batchId, items);

    // The next time step is inside the accepted window and not yet used.
    const again = await client
      .post("/api/auth/mfa/verify")
      .set(originHeader)
      .send({
        factorId,
        code: totpCode(secretBase32, totpStep(new Date()) + 1),
      });
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    const res = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(errorCodeOf(res.body)).toBe("REAUTH_REQUIRED");
    for (const item of await W.itemsOf(batchId))
      expect(item.status, "nothing changed").toBe("exported");
    expect(await W.postingsOf(batchId)).toHaveLength(0);
  });

  it("[stepup-same-session-recovery] a recovery code from a set made in the same session is not a challenge: confirm still asks for the password", async () => {
    const { batchId, items } = await exportedRun();
    const { client } = await enrollmentOnlyApprover("Kode Cadangan Baru");
    const results = W.succeedItems(batchId, items);

    const made = await client
      .post("/api/auth/mfa/recovery-codes")
      .set(originHeader);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const [code] = (made.body.data as { codes: string[] }).codes;
    const used = await client
      .post("/api/auth/mfa/recovery")
      .set(originHeader)
      .send({ code });
    expect(used.status, JSON.stringify(used.body)).toBe(200);

    const res = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(errorCodeOf(res.body)).toBe("REAUTH_REQUIRED");
    expect(await W.postingsOf(batchId)).toHaveLength(0);
  });

  it("[stepup-older-factor] a challenge against a factor that existed before the session still skips the password", async () => {
    const { batchId, items } = await exportedRun();
    const { client, userId } = await challengedApprover("Faktor Lama");
    const results = W.succeedItems(batchId, items);
    const stamp = await mfaOwner.query(
      `SELECT mfa_challenge_verified_at FROM "session" WHERE revoked_at IS NULL AND user_id = $1 AND id NOT LIKE 'payout-fixture-session-%'`,
      [userId],
    );
    expect(stamp.rows[0]?.mfa_challenge_verified_at).not.toBeNull();

    const ok = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("[stepup-stamp-stale] a real challenge stamp older than 15 minutes no longer skips the password, even while mfa_verified_at is fresh", async () => {
    const { batchId, items } = await exportedRun();
    const { client, userId } = await challengedApprover("Stempel Basi");
    const results = W.succeedItems(batchId, items);
    await ageChallengeStamp(userId, "16 minutes");

    const res = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(errorCodeOf(res.body)).toBe("REAUTH_REQUIRED");
    for (const item of await W.itemsOf(batchId))
      expect(item.status, "nothing changed").toBe("exported");
    expect(await W.postingsOf(batchId)).toHaveLength(0);

    const ok = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results, password: PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("[stepup-stamp-fresh] control: a challenge stamp 10 minutes old still skips the password", async () => {
    const { batchId, items } = await exportedRun();
    const { client, userId } = await challengedApprover("Stempel Segar");
    await ageChallengeStamp(userId, "10 minutes");

    const ok = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results: W.succeedItems(batchId, items) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("[stepup-evidence-first] with the right password a foreign proof key is still refused (the password does not bypass the tenant binding)", async () => {
    const { batchId, items } = await exportedRun();
    const { client } = await enrollmentOnlyApprover("Bukti Asing");
    const results = W.succeedItems(batchId, items).map((r) => ({
      ...r,
      evidenceKey: foreignKeys(batchId)["another tenant"],
    }));
    const res = await client
      .post(`${BASE}/${batchId}/confirm`)
      .set(originHeader)
      .send({ results, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(errorCodeOf(res.body)).toBe("PAYOUT_EVIDENCE_INVALID");
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("exported");
    expect(await W.postingsOf(batchId)).toHaveLength(0);
  });
});
