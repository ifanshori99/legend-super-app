// Approve must name the source bank account it saw (bead legend-3j9yz, brief
// "payout approval followups", card 1). Written fail-first from the brief, not
// from the implementation.
//
// Rule: the source account of a manual_bank batch is frozen at APPROVE (not at
// submit). The approver now sends the account id the screen showed him
// (`sourceBankAccountId`, a uuid or null). If it is not exactly the account the
// payout config names inside the approve transaction, approve is refused
// 409 PAYOUT_SOURCE_MISMATCH and NOTHING changes (batch stays pending_approval,
// no approver, no frozen account, items untouched, no audit row). Same id:
// approve works and the batch DTO shows the frozen account. null is refused for
// a manual_bank batch. Non-manual batches (cash) ignore the field.
//
// Assumptions (the brief leaves them open):
// - HTTP: POST /api/hris/payroll/disbursement-batches/:id/approve with
//   { contentHash, sourceBankAccountId }, permission payroll.disburse.approve,
//   answers 200 on success. The frozen account is read back from the batch list
//   (GET /api/hris/payroll/payout-batches?legalEntityId=), DTO key
//   `sourceBankAccountId` (null until approved), and from the column
//   payroll_disbursement_batches.source_bank_account_id.
// - The key is required: a body without it, or with a non-uuid, is 422.
// - Why these tests fail today: the service ignores the new field, so a wrong
//   id or null approves (no 409), the batch DTO has no `sourceBankAccountId`,
//   and the strict validator rejects the new key with 422.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  APP,
  BUDI,
  CASHIER,
  REQ,
  SITI,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("approval-source");
const BASE = "/api/hris/payroll/disbursement-batches";
const LIST = "/api/hris/payroll/payout-batches";
const CODE = "PAYOUT_SOURCE_MISMATCH";

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];
const enrolledUsers: string[] = [];
let approver: { client: ReturnType<typeof agent>; userId: string };

/** An approver with a real MFA challenge (no password step-up needed). */
async function challengedApprover() {
  const client = agent(W.app);
  await signUp(client, "Payout Source Approver");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
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
  return { client, userId };
}

beforeAll(async () => {
  approver = await challengedApprover();
});
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

// ---- Helpers --------------------------------------------------------------

const currentSource = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;

const setSource = (id: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_configs SET manual_source_bank_account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [W.tenantId, W.entityId(), id],
      ),
    true,
  );

/** A second, active bank account of the same legal entity (account B). */
async function otherBankAccount() {
  const [row] = await W.rowsOf(
    `INSERT INTO bank_accounts
       (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version,
        gl_account_id, created_by)
     SELECT $1, $2, 'BCA', 'Rekening Cadangan', '\\x00', $3, '2222', 1, id,
            'payout-approval-source-test'
       FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
     RETURNING id`,
    [W.tenantId, W.entityId(), randomBytes(32).toString("hex")],
  );
  return row!.id as string;
}

/** A submitted manual_bank batch waiting for its approver. */
async function pendingBatch() {
  const runId = await W.seedRun([bank(BUDI, 4_000_000), bank(SITI, 3_000_000)]);
  const batchId = await W.createBatch(runId);
  await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
  const hash = (await W.batchById(batchId)).content_hash as string;
  return { runId, batchId, hash };
}

const approveWith = (
  batchId: string,
  contentHash: string,
  sourceBankAccountId: string | null,
) =>
  W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash,
      sourceBankAccountId,
    } as never),
  );

const auditCount = async (batchId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM audit_logs
          WHERE tenant_id = $1 AND event::text LIKE '%' || $2 || '%'`,
        [W.tenantId, batchId],
      )
    )[0]!.n,
  );

const stateOf = async (batchId: string) =>
  JSON.stringify({
    batch: await W.batchById(batchId),
    items: await W.itemsOf(batchId),
    audit: await auditCount(batchId),
  });

async function expectNothingApproved(batchId: string, before: string) {
  const batch = await W.batchById(batchId);
  expect(batch.status).toBe("pending_approval");
  expect(batch.approved_by).toBeNull();
  expect(batch.source_bank_account_id, "no account frozen").toBeNull();
  expect(await stateOf(batchId), "state, items and audit unchanged").toBe(
    before,
  );
}

type BatchDto = { id: string; status: string; sourceBankAccountId?: unknown };
async function dtoOf(batchId: string) {
  const res = await approver.client.get(
    `${LIST}?legalEntityId=${W.entityId()}&limit=20`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  // The list pages newest first and this file makes few batches; the batch
  // under test is always on the first page.
  return (res.body.data as BatchDto[]).find((b) => b.id === batchId);
}

describe("legend-3j9yz approve names the source account it saw", () => {
  it("[3j9yz-mismatch] a source id that is not the configured account is refused 409 PAYOUT_SOURCE_MISMATCH and nothing changes; the right id then approves and freezes it", async () => {
    const { batchId, hash } = await pendingBatch();
    const a = await currentSource();
    const b = await otherBankAccount();
    const before = await stateOf(batchId);

    await W.expectRefused(approveWith(batchId, hash, b), {
      status: 409,
      code: CODE,
    });
    await expectNothingApproved(batchId, before);
    // A well-formed id that is no account of this tenant is a mismatch too.
    await W.expectRefused(approveWith(batchId, hash, randomUUID()), {
      status: 409,
      code: CODE,
    });
    await expectNothingApproved(batchId, before);

    await approveWith(batchId, hash, a);
    const batch = await W.batchById(batchId);
    expect(batch.status).toBe("approved");
    expect(batch.approved_by).toBe(APP);
    expect(batch.source_bank_account_id).toBe(a);
  });

  it("[3j9yz-null-refused] null is refused for a manual_bank batch (409 PAYOUT_SOURCE_MISMATCH), the batch stays pending", async () => {
    const { batchId, hash } = await pendingBatch();
    const before = await stateOf(batchId);
    await W.expectRefused(approveWith(batchId, hash, null), {
      status: 409,
      code: CODE,
    });
    await expectNothingApproved(batchId, before);
  });

  it("[3j9yz-draft-to-pending-config-switch] config A when the batch goes pending, then switched to B: approving with A is refused, approving with B freezes B", async () => {
    const { batchId, hash } = await pendingBatch();
    const a = await currentSource();
    const b = await otherBankAccount();
    await setSource(b);
    try {
      const before = await stateOf(batchId);
      await W.expectRefused(approveWith(batchId, hash, a), {
        status: 409,
        code: CODE,
      });
      await expectNothingApproved(batchId, before);

      await approveWith(batchId, hash, b);
      const batch = await W.batchById(batchId);
      expect(batch.status).toBe("approved");
      expect(
        batch.source_bank_account_id,
        "frozen at approve, not submit",
      ).toBe(b);
    } finally {
      await setSource(a);
    }
  });

  it("[3j9yz-cash-ignores-field] a cash batch ignores the field: null and a stray uuid both approve and freeze no account", async () => {
    for (const value of [null, randomUUID()]) {
      const slips = [cash(CASHIER, 900_000)];
      const runId = await W.seedRun(slips);
      const batchId = await W.createBatch(runId, "cash");
      await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
      const hash = (await W.batchById(batchId)).content_hash as string;
      await approveWith(batchId, hash, value);
      const batch = await W.batchById(batchId);
      expect(batch.status, `value ${String(value)}`).toBe("approved");
      expect(batch.source_bank_account_id).toBeNull();
    }
  });

  it("[3j9yz-http] over HTTP: the key is required (422), a non-uuid is 422, a wrong id or null is 409 PAYOUT_SOURCE_MISMATCH with nothing changed, the right id is 200 and the batch DTO shows the frozen account (null before)", async () => {
    const { batchId, hash } = await pendingBatch();
    const a = await currentSource();
    const b = await otherBankAccount();
    const post = (body: Record<string, unknown>) =>
      approver.client
        .post(`${BASE}/${batchId}/approve`)
        .set(originHeader)
        .send(body);
    const before = await stateOf(batchId);

    expect(await dtoOf(batchId)).toHaveProperty("sourceBankAccountId", null);

    const missing = await post({ contentHash: hash });
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    const garbage = await post({ contentHash: hash, sourceBankAccountId: "x" });
    expect(garbage.status, JSON.stringify(garbage.body)).toBe(422);
    for (const sourceBankAccountId of [b, null]) {
      const refused = await post({ contentHash: hash, sourceBankAccountId });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error?.code).toBe(CODE);
    }
    await expectNothingApproved(batchId, before);
    expect(await dtoOf(batchId)).toHaveProperty("sourceBankAccountId", null);

    const ok = await post({ contentHash: hash, sourceBankAccountId: a });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const dto = await dtoOf(batchId);
    expect(dto?.status).toBe("approved");
    expect(dto?.sourceBankAccountId).toBe(a);
  });
});
