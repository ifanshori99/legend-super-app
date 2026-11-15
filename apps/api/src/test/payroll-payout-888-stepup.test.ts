// Brief 888, finding P1 "step-up approval accepts the enrollment as proof"
// (legend-w5yx6, docs/qa/second-opinion-payout-area-final.md).
//
// A thief of an approver's session who has no second factor yet can enroll one
// himself and, within 15 minutes, approve a batch of someone else, change the
// payout config or download the bank file: the gate only reads
// `mfaVerifiedAt`. CTO decision: every payout route that approves, confirms or
// changes money uses the pattern of the source endpoint (883): a session whose
// second factor only comes from the MFA enrollment (never passed a challenge)
// must send the current account `password`; a factor enrolled in the same
// session is never enough.
//
// Routes covered (contract: packages/shared/src/hris/payroll/payout-endpoints.ts):
// - POST /api/hris/payroll/disbursement-batches/:id/approve
//     { contentHash, sourceBankAccountId, password? }   payroll.disburse.approve
// - PUT  /api/hris/payroll/payout-configs/:legalEntityId
//     { ...config, password? }                          payroll.payout.configure
// - POST /api/hris/payroll/disbursement-batches/:id/export
//     { password? }                                     payroll.disburse.request
// - POST /api/hris/payroll/disbursement-batches/:id/confirm
//     { results, password? }                            payroll.disburse.approve
//   (confirm already has this step-up, see payroll-payout-evidence.test.ts
//   [stepup-confirm]; it is kept here as the control of the same rule, it is
//   expected to be green today, the other three are red.)
//
// Assumptions (spec silent, stated so they can be contested):
// - approve, config and export accept the optional `password` field like
//   confirm/confirm-cash/source do (today their strict bodies refuse it; that is
//   part of the missing behaviour). The export body is `{ password? }`.
// - Same codes as the source endpoint: enrollment-only session without password
//   is 401 REAUTH_REQUIRED, a wrong password is 401 or 403, the right one 200.
//   A wrong password is asserted as 401/403 on purpose, so a 422 for the unknown
//   field cannot pass as "refused".
// - A refusal changes nothing: approve leaves the batch unapproved (status and
//   approved_by unchanged), config keeps its stored values, export keeps the
//   batch `approved` with the one download unspent, confirm leaves the items
//   `exported` and journals nothing.
// - A session with a real challenge (factor older than the session, as in
//   payroll-payout-evidence.test.ts) may omit the password: approve is the
//   representative control for that.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { submitDisbursementBatch } from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import {
  BUDI,
  actorOf,
  REQ,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("888stepup");

const BASE = "/api/hris/payroll/disbursement-batches";
const NET = 2_000_000;
const PASSWORD = "Test-password-123!";
const WRONG = "Salah-password-999!";
const NEW_FEE = 7_777;

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

type Client = Awaited<ReturnType<typeof W.signedInClient>>["client"];

/** Signed in with the payout permissions; TOTP enrolled and verified in this very session. */
async function enrolledPerson(label: string) {
  const { client, userId } = await W.signedInClient(`Step888 ${label}`);
  await W.grantRole(userId, [
    "payroll.view",
    "payroll.disburse.approve",
    "payroll.payout.configure",
    // The export route is guarded by the request permission.
    "payroll.disburse.request",
  ]);
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
  return { client, userId, factorId, secretBase32 };
}

/** Enrollment-only: the factor was enrolled in this session, no challenge was ever passed. */
async function enrollmentOnly(label: string) {
  const person = await enrolledPerson(label);
  const stamp = await mfaOwner.query(
    `SELECT mfa_verified_at, mfa_challenge_verified_at FROM "session" WHERE revoked_at IS NULL AND user_id = $1`,
    [person.userId],
  );
  expect(
    stamp.rows[0]?.mfa_verified_at,
    "premise: the enrollment stamped a fresh second factor",
  ).not.toBeNull();
  expect(
    stamp.rows[0]?.mfa_challenge_verified_at,
    "premise: no challenge was ever passed",
  ).toBeNull();
  return person;
}

/** A real challenge: the factor existed before the session (backdated), then a code is verified. */
async function challenged(label: string) {
  const person = await enrolledPerson(label);
  await mfaOwner.query(
    `UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1`,
    [person.factorId],
  );
  const res = await person.client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId: person.factorId,
      code: totpCode(person.secretBase32, totpStep(new Date()) + 1),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const stamp = await mfaOwner.query(
    `SELECT mfa_challenge_verified_at FROM "session" WHERE revoked_at IS NULL AND user_id = $1`,
    [person.userId],
  );
  expect(
    stamp.rows[0]?.mfa_challenge_verified_at,
    "premise: a real challenge stamped the session",
  ).not.toBeNull();
  return person;
}

const errorCodeOf = (body: { error?: { code?: string } }) => body.error?.code;
const SLIPS = () => [bank(BUDI, NET)];

// ---- One scenario per route: a fresh state, the call, "unchanged", "done" ------

type Scenario = {
  /** Sends the call; `password === null` omits the field. */
  send: (
    client: Client,
    password: string | null,
  ) => Promise<{
    status: number;
    body: { error?: { code?: string } };
  }>;
  /** Nothing moved since the setup (asserted after every refusal). */
  expectUnchanged: () => Promise<void>;
  /** The effect of one accepted call. */
  expectDone: () => Promise<void>;
  /** Puts shared state back (config only). */
  cleanup?: () => Promise<void>;
};

async function approveScenario(): Promise<Scenario> {
  const runId = await W.seedRun(SLIPS());
  const batchId = await W.createBatch(runId);
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const before = await W.batchById(batchId);
  const contentHash = before.content_hash as string;
  expect(before.approved_by, "premise: not approved yet").toBeNull();
  const [config] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  const sourceBankAccountId = config!.id as string;
  return {
    send: (client, password) =>
      client
        .post(`${BASE}/${batchId}/approve`)
        .set(originHeader)
        .send(
          password === null
            ? { contentHash, sourceBankAccountId }
            : { contentHash, sourceBankAccountId, password },
        ),
    expectUnchanged: async () => {
      const now = await W.batchById(batchId);
      expect(now.status, "batch status unchanged").toBe(before.status);
      expect(now.approved_by, "nobody approved").toBeNull();
      expect(now.approved_at).toBeNull();
      expect(now.source_bank_account_id, "no source frozen").toBeNull();
    },
    expectDone: async () => {
      const now = await W.batchById(batchId);
      expect(now.status).toBe("approved");
      expect(now.approved_by).not.toBeNull();
    },
  };
}

async function configScenario(): Promise<Scenario> {
  const read = async () =>
    (
      await W.rowsOf(
        `SELECT manual_source_bank_account_id AS source, fee_per_transfer_idr::text AS fee,
                updated_by
           FROM payroll_payout_configs WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [W.tenantId, W.entityId()],
      )
    )[0]!;
  const before = await read();
  expect(Number(before.fee), "premise: the fee is not the new one").not.toBe(
    NEW_FEE,
  );
  const body = {
    method: "manual_bank",
    integrationId: null,
    manualSourceBankAccountId: before.source as string,
    manualBankFormat: "generic_csv",
    dailyCapIdr: null,
    feePerTransferIdr: NEW_FEE,
    enabled: true,
  };
  return {
    send: (client, password) =>
      client
        .put(`/api/hris/payroll/payout-configs/${W.entityId()}`)
        .set(originHeader)
        .send(password === null ? body : { ...body, password }),
    expectUnchanged: async () => {
      const now = await read();
      expect(now.fee, "fee unchanged").toBe(before.fee);
      expect(now.updated_by, "no new editor").toBe(before.updated_by);
    },
    expectDone: async () => {
      expect(Number((await read()).fee)).toBe(NEW_FEE);
    },
    cleanup: async () => {
      await W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_configs SET fee_per_transfer_idr = $3, updated_by = $4
              WHERE tenant_id = $1 AND legal_entity_id = $2`,
            [W.tenantId, W.entityId(), before.fee, before.updated_by],
          ),
        true,
      );
    },
  };
}

async function exportScenario(): Promise<Scenario> {
  const runId = await W.seedRun(SLIPS());
  const batchId = await W.approvedBatch(runId);
  const before = await W.batchById(batchId);
  expect(before.status, "premise: approved, not downloaded").toBe("approved");
  expect(before.exported_at).toBeNull();
  return {
    send: (client, password) =>
      client
        .post(`${BASE}/${batchId}/export`)
        .set(originHeader)
        .send(password === null ? {} : { password }),
    expectUnchanged: async () => {
      const now = await W.batchById(batchId);
      expect(now.status, "still approved").toBe("approved");
      expect(now.exported_at, "the one download is not spent").toBeNull();
      for (const item of await W.itemsOf(batchId))
        expect(item.status).toBe("approved");
    },
    expectDone: async () => {
      const now = await W.batchById(batchId);
      expect(now.status).toBe("exported");
      expect(now.exported_at).not.toBeNull();
    },
  };
}

async function confirmScenario(): Promise<Scenario> {
  const slips = SLIPS();
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i: Row) => i.status === "exported",
  );
  expect(items, "premise: one exported item").toHaveLength(1);
  const results = W.succeedItems(batchId, items);
  return {
    send: (client, password) =>
      client
        .post(`${BASE}/${batchId}/confirm`)
        .set(originHeader)
        .send(password === null ? { results } : { results, password }),
    expectUnchanged: async () => {
      for (const item of await W.itemsOf(batchId))
        expect(item.status, "items stay exported").toBe("exported");
      expect(await W.postingsOf(batchId), "nothing journaled").toHaveLength(0);
    },
    expectDone: async () => {
      for (const item of await W.itemsOf(batchId))
        expect(item.status).toBe("succeeded");
      expect(await W.postingsOf(batchId)).toHaveLength(1);
    },
  };
}

const ROUTES: [string, () => Promise<Scenario>][] = [
  ["approve", approveScenario],
  ["config", configScenario],
  ["export", exportScenario],
  ["confirm", confirmScenario],
];

// =========================================================================

describe("w5yx6: a factor enrolled in the same session is never enough for payout money routes", () => {
  for (const [route, makeScenario] of ROUTES) {
    it(`[w5yx6-${route}-enrollment-only-needs-password] ${route}: a session whose second factor only comes from the MFA enrollment is refused without the password (401 REAUTH_REQUIRED) and with a wrong one (401/403), nothing changes; with the right password it goes through`, async () => {
      const scenario = await makeScenario();
      const { client } = await enrollmentOnly(`${route} enrollment`);
      try {
        const without = await scenario.send(client, null);
        expect(without.status, JSON.stringify(without.body)).toBe(401);
        expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
        await scenario.expectUnchanged();

        const wrong = await scenario.send(client, WRONG);
        expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
        await scenario.expectUnchanged();

        const ok = await scenario.send(client, PASSWORD);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        await scenario.expectDone();
      } finally {
        await scenario.cleanup?.();
      }
    });
  }

  it("[w5yx6-approve-challenged-session-skips-password] control: a session that passed a real second-factor challenge approves without the password, once", async () => {
    const scenario = await approveScenario();
    const { client } = await challenged("approve challenged");
    const res = await scenario.send(client, null);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await scenario.expectDone();
  });

  it("[w5yx6-approve-wrong-password-refused] control: a wrong password alone never approves (401/403, nothing approved)", async () => {
    const scenario = await approveScenario();
    const { client } = await enrollmentOnly("approve wrong only");
    const wrong = await scenario.send(client, WRONG);
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
    await scenario.expectUnchanged();
  });
});
