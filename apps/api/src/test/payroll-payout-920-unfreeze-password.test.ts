// Payout 920 (second opinion 919, finding P1-1): a stolen session cookie must not
// lift the victim's own "not me" freeze. Written fail-first from the 918 design
// and the 919 second opinion, NOT from the implementation.
//
// Rule proven (founder: nobody is paid on one person's word; when in doubt, limit
// the payment): the person who froze a batch with "not me" (password) may withdraw
// their own claim only with a fresh proof a cookie alone cannot give: the account
// password on the unfreeze request, and a grant of method `password`. A fresh MFA
// challenge still living in the same session (which the disown does not revoke)
// is not enough.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Routes and SQL are the ones of the 918 suite (disown / unfreeze over HTTP,
//   app.payout_approval_disown / app.payout_batch_unfreeze through the grantor
//   stand-in). Unfreeze without password -> 401 (the other payout steps).
// - The "attacker" is the same cookie jar as the victim (same session S): the
//   victim's supertest agent is used again, without a password.
// - "Fresh challenge" = a real TOTP challenge in the session (factor older than the
//   session, so the code stamps mfa_challenge_verified_at), as in the 911 suite.
// - The SQL issue refuses an unfreeze grant of method mfa_challenge for every
//   person (the brief: "grant unfreeze method mfa_challenge ditolak di SQL
//   issue"), not only for the disputant. The refusal carries a PAYOUT-nn code.
// - Controls (must pass before and after the fix): unfreeze with the password,
//   enrollment-only session without password, challenge older than 15 minutes.
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import { originHeader } from "./helpers.ts";
import {
  actorOf,
  bank,
  BUDI,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("920unf");
const NET = 1_000_000;
const REASON =
  "Bukan saya yang menyetujui langkah ini, akun saya dipakai orang";
const UNFREEZE_REASON = "Sudah dicek ke bank, tidak ada dana keluar tambahan";
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const LOGS = "/api/hris/payroll/payout-approval-log";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const batchIds: string[] = [];
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// ---- People (HTTP, TOTP enrolled in this very session) --------------------------------

type Person = Awaited<ReturnType<typeof makePerson>>;

async function templateRoleId(key: "owner" | "finance") {
  const read = () =>
    W.owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2`,
      [W.tenantId, key],
    );
  const found = await read();
  if (found.rows[0]) return found.rows[0].id;
  await W.owner.query(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, $3, '[]'::jsonb, false, '["tenant","brand"]'::jsonb)
     ON CONFLICT DO NOTHING`,
    [W.tenantId, `Template ${key} 920`, key],
  );
  return (await read()).rows[0]!.id;
}

/**
 * A signed-in person with payroll.disburse.approve and an owner or finance
 * template role at tenant scope, TOTP enrolled and verified in this very session
 * (enrollment only: no real challenge yet).
 */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Unfreeze920 ${label}`);
  personIds.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const roleId = await templateRoleId(template);
  await W.owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [W.tenantId, userId, roleId],
  );
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

/**
 * Like makePerson, plus a real challenge: the factor is made older than the
 * session, so a fresh code stamps `mfa_challenge_verified_at` on the real session
 * (the state a stolen cookie inherits).
 */
async function challengedPerson(
  label: string,
  template: "owner" | "finance" = "finance",
) {
  const person = await makePerson(label, template);
  await W.owner.query(
    `UPDATE mfa_factors SET created_at = now() - interval '1 day', verified_at = now() - interval '1 day' WHERE id = $1`,
    [person.factorId],
  );
  const challenged = await person.client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({
      factorId: person.factorId,
      code: totpCode(person.secretBase32, totpStep(new Date()) + 1),
    });
  expect(challenged.status, JSON.stringify(challenged.body)).toBe(200);
  const stamped = await W.owner.query(
    `SELECT 1 FROM "session"
      WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
    [person.userId],
  );
  expect(stamped.rowCount, "premise: the challenge stamped the session").toBe(
    1,
  );
  return person;
}

let requester: Person; // owner: created every batch
let approver: Person; // finance: approved and exported every batch
let other: Person; // finance: second resolver
let outsideOwner: Person; // owner, took no part: the legitimate unfreezer

// ---- Raw SQL helpers ----------------------------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

/** legend_app, one statement, real COMMIT. */
async function appCall(sql: string, params: unknown[] = []): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      const result = await client.query(sql, params);
      await client.query("COMMIT");
      return { code: undefined, message: "", rows: result.rows as Row[] };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "", rows: [] };
    }
  } finally {
    client.release();
  }
}

/** Grant of the grantor stand-in with an explicit method (the fixture issuer hard-codes mfa_challenge). */
async function issueGrant(input: {
  kind: string;
  step: string;
  userId: string;
  batchId: string;
  refId?: string | null;
  detail?: string | null;
  method: "password" | "mfa_challenge";
}): Promise<{ grant?: string; code?: string; message: string }> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_payout_grantor");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      W.tenantId,
    ]);
    try {
      const { rows } = await client.query(
        `SELECT app.payout_grant_issue($1::text, $2::text, $3::uuid, $4::uuid[], $5::varchar, $6::uuid, $7::uuid, $8::varchar, $9::text, $10::text, $11::text) AS grant`,
        [
          input.kind,
          input.step,
          input.batchId,
          "{}",
          null,
          input.refId ?? null,
          null,
          input.detail ?? null,
          input.userId,
          actorOf(input.userId).sessionId,
          input.method,
        ],
      );
      await client.query("COMMIT");
      return { grant: (rows[0] as { grant: string }).grant, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

const UNFREEZE = `SELECT app.payout_batch_unfreeze($1::uuid, $2::text, $3::text) AS released`;

// ---- Observations ---------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const unfreezesOf = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${UNFREEZES} WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  );
const openDisputes = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${DISPUTES} d
      WHERE d.tenant_id = $1 AND d.batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM ${UNFREEZES} u
                         WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
    [W.tenantId, batchId],
  );
const unfreezeGrants = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants
      WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'unfreeze'`,
    [W.tenantId, batchId],
  );
const logsOf = (batchId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, actor FROM payroll_payout_approval_log
      WHERE tenant_id = $1 AND batch_id = $2 ORDER BY logged_at, id`,
    [W.tenantId, batchId],
  );
/** What a freeze must never move: paid items, payout journals, batches of the run. */
async function moneyOf(w: World) {
  return {
    succeeded: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'succeeded'`,
      [W.tenantId, w.runId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId, W.entityId()],
    ),
    batches: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, w.runId],
    ),
    statuses: JSON.stringify(
      (
        await W.rowsOf(
          `SELECT id::text AS id, status FROM payroll_disbursement_items
            WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY id`,
          [W.tenantId, w.runId],
        )
      ).map((r) => [r.id, r.status]),
    ),
  };
}

// ---- Worlds ---------------------------------------------------------------------------------

type World = {
  runId: string;
  batchId: string;
  itemIds: string[];
  /** Approval-log row of each resolver, by user id. */
  logOf: Record<string, string>;
};

/**
 * Batch created by `requester`, approved and exported by `approver`, every item
 * closed `failed` by two people (`disputant` and `other`): each leaves one
 * approval-log row, and the main approval leaves one for `approver`.
 */
async function failedWorld(disputant: Person): Promise<World> {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [row] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = row!.id as string;
  batchIds.push(batchId);
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requester.userId), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const [source] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(approver.userId), batchId, {
      contentHash: hash,
      sourceBankAccountId: source!.id as string,
    }),
  );
  await W.inTx((tx) =>
    exportManualBatch(tx, actorOf(approver.userId), batchId),
  );
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await W.resolve(batchId, itemIds, "failed", disputant.userId);
  await W.resolve(batchId, itemIds, "failed", other.userId);
  for (const item of await W.itemsOf(batchId))
    expect(item.status, "premise: the item is failed").toBe("failed");
  const logOf: Record<string, string> = {};
  for (const log of await logsOf(batchId))
    logOf[log.actor as string] = log.id as string;
  expect(
    Object.keys(logOf).sort(),
    "premise: the approver (main approval) and each resolver left one approval-log row",
  ).toEqual([approver.userId, disputant.userId, other.userId].sort());
  return { runId, batchId, itemIds, logOf };
}

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);

const disownHttp = (who: Person, logId: string) =>
  who.client
    .post(`${LOGS}/${logId}/disown`)
    .set(originHeader)
    .send({ reason: REASON, password: PASSWORD }) as unknown as Promise<Res>;
const unfreezeHttp = (
  who: Person,
  batchId: string,
  body: Record<string, unknown> = { reason: UNFREEZE_REASON },
) =>
  who.client
    .post(`${BATCHES}/${batchId}/unfreeze`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const getBatch = (who: Person, batchId: string) =>
  who.client.get(`${BATCHES}/${batchId}`) as unknown as Promise<Res>;

/** The disputant says "not me" over HTTP with the password: the batch is frozen. */
async function disownAsVictim(victim: Person, w: World) {
  const res = await disownHttp(victim, w.logOf[victim.userId]!);
  expect([200, 201], `premise: disown ${detail(res)}`).toContain(res.status);
  expect(await openDisputes(w.batchId), "premise: frozen").toBe(1);
}

/** Nothing moved: claim still open, no unfreeze row, no unfreeze grant, same money. */
async function expectStillFrozen(
  victim: Person,
  w: World,
  money: Awaited<ReturnType<typeof moneyOf>>,
  grantsBefore: number,
  label: string,
) {
  expect(await openDisputes(w.batchId), `${label}: claim stays open`).toBe(1);
  expect(await unfreezesOf(w.batchId), `${label}: no unfreeze row`).toBe(0);
  expect(await unfreezeGrants(w.batchId), `${label}: no unfreeze grant`).toBe(
    grantsBefore,
  );
  expect(await moneyOf(w), `${label}: money and journals unchanged`).toEqual(
    money,
  );
  const batch = await getBatch(victim, w.batchId);
  expect(batch.status, detail(batch)).toBe(200);
  expect(
    (batch.body.data?.freeze as { frozen: boolean }).frozen,
    `${label}: the batch still reads frozen`,
  ).toBe(true);
}

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requester = await makePerson("Requester", "owner");
  approver = await makePerson("Approver", "finance");
  other = await makePerson("Other resolver", "finance");
  outsideOwner = await makePerson("Outside owner", "owner");
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [W.tenantId, personIds],
    );
    if (batchIds.length > 0) {
      for (const table of [UNFREEZES, DISPUTES])
        await c.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2)`,
          [W.tenantId, batchIds],
        );
      await c.query(
        `DELETE FROM payroll_payout_grants WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, batchIds],
      );
    }
  }, true).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// =========================================================================
// P1-1: the cookie alone cannot withdraw the victim's own claim
// =========================================================================

describe("920 unfreeze: a stolen session cookie cannot lift the victim's own freeze", () => {
  it("[920-unfreeze-cookie-needs-password] after a disown with the password, the same session with a fresh MFA challenge but no password (or a wrong one) is refused 401; the claim stays open, no unfreeze row, no grant, money and journals unchanged", async () => {
    const victim = await challengedPerson("Victim");
    const w = await failedWorld(victim);
    await disownAsVictim(victim, w);
    const money = await moneyOf(w);
    const grantsBefore = await unfreezeGrants(w.batchId);

    // The attacker holds the very same cookie: same agent, no password.
    const noPassword = await unfreezeHttp(victim, w.batchId);
    expect(noPassword.status, detail(noPassword)).toBe(401);
    await expectStillFrozen(victim, w, money, grantsBefore, "no password");

    const wrong = await unfreezeHttp(victim, w.batchId, {
      reason: UNFREEZE_REASON,
      password: WRONG_PASSWORD,
    });
    // A wrong password is the REAUTH_PASSWORD_INVALID refusal (403).
    expect(wrong.status, detail(wrong)).toBe(403);
    await expectStillFrozen(victim, w, money, grantsBefore, "wrong password");
  });

  it("[920-unfreeze-own-claim-with-password] control: the victim withdraws their own claim with the account password; one unfreeze row, the freeze is lifted", async () => {
    const victim = await challengedPerson("Withdraws");
    const w = await failedWorld(victim);
    await disownAsVictim(victim, w);

    const res = await unfreezeHttp(victim, w.batchId, {
      reason: UNFREEZE_REASON,
      password: PASSWORD,
    });
    expect([200, 201], detail(res)).toContain(res.status);
    expect(res.body.data?.released).toBe(1);
    expect(await openDisputes(w.batchId)).toBe(0);
    expect(await unfreezesOf(w.batchId)).toBe(1);
    const batch = await getBatch(victim, w.batchId);
    expect((batch.body.data?.freeze as { frozen: boolean }).frozen).toBe(false);
  });

  it("[920-unfreeze-outsider-with-password] control: an owner who took no part lifts the freeze with the password", async () => {
    const victim = await makePerson("Victim of outsider", "finance");
    const w = await failedWorld(victim);
    await disownAsVictim(victim, w);

    const noPassword = await unfreezeHttp(outsideOwner, w.batchId);
    expect(noPassword.status, detail(noPassword)).toBe(401);
    expect(await openDisputes(w.batchId), "still frozen").toBe(1);

    const res = await unfreezeHttp(outsideOwner, w.batchId, {
      reason: UNFREEZE_REASON,
      password: PASSWORD,
    });
    expect([200, 201], detail(res)).toContain(res.status);
    expect(res.body.data?.released).toBe(1);
    expect(await openDisputes(w.batchId)).toBe(0);
  });

  it("[920-unfreeze-enrollment-only-needs-password] control: a session whose MFA is enrollment only (no real challenge) without the password is refused 401; the claim stays open", async () => {
    const victim = await makePerson("Enrollment only", "finance");
    const w = await failedWorld(victim);
    await disownAsVictim(victim, w);
    const money = await moneyOf(w);
    const grantsBefore = await unfreezeGrants(w.batchId);

    const res = await unfreezeHttp(victim, w.batchId);
    expect(res.status, detail(res)).toBe(401);
    await expectStillFrozen(victim, w, money, grantsBefore, "enrollment only");
  });

  it("[920-unfreeze-expired-challenge-refused] control: a challenge older than 15 minutes is refused 401, with or without the password (the 15-minute MFA step-up is stale); the claim stays open", async () => {
    const victim = await challengedPerson("Expired challenge");
    const w = await failedWorld(victim);
    await disownAsVictim(victim, w);
    const aged = await W.owner.query(
      `UPDATE "session"
          SET created_at = now() - interval '30 minutes',
              mfa_challenge_verified_at = now() - interval '16 minutes',
              mfa_verified_at = now() - interval '16 minutes'
        WHERE revoked_at IS NULL AND user_id = $1 AND mfa_challenge_verified_at IS NOT NULL`,
      [victim.userId],
    );
    expect(aged.rowCount, "premise: the challenge stamped the session").toBe(1);
    const money = await moneyOf(w);
    const grantsBefore = await unfreezeGrants(w.batchId);

    const noPassword = await unfreezeHttp(victim, w.batchId);
    expect(noPassword.status, detail(noPassword)).toBe(401);
    await expectStillFrozen(victim, w, money, grantsBefore, "expired, no pw");

    const withPassword = await unfreezeHttp(victim, w.batchId, {
      reason: UNFREEZE_REASON,
      password: PASSWORD,
    });
    expect(
      withPassword.status,
      `the MFA step-up is stale: ${detail(withPassword)}`,
    ).toBe(401);
    await expectStillFrozen(victim, w, money, grantsBefore, "expired, pw");
  });
});

// =========================================================================
// P1-1 in SQL: the grantor refuses an unfreeze grant of method mfa_challenge
// =========================================================================

describe("920 unfreeze grant: only the password method is issued", () => {
  it("[920-grant-unfreeze-mfa-challenge-refused] the SQL issue refuses an unfreeze grant of method mfa_challenge (the disputant and an outsider), no grant row, the claim stays open; method password is issued and works", async () => {
    const victim = await makePerson("Victim of grant", "finance");
    const w = await failedWorld(victim);
    await disownAsVictim(victim, w);
    const reasonHash = sha256(UNFREEZE_REASON);
    const money = await moneyOf(w);
    const grantsBefore = await unfreezeGrants(w.batchId);

    for (const [who, label] of [
      [victim, "disputant"],
      [outsideOwner, "outsider"],
    ] as const) {
      const issued = await issueGrant({
        kind: "unfreeze",
        step: "approve",
        userId: who.userId,
        batchId: w.batchId,
        detail: reasonHash,
        method: "mfa_challenge",
      });
      expect(
        issued.grant,
        `${label}: a mfa_challenge unfreeze grant must not be issued`,
      ).toBeUndefined();
      expect(issued.code, `${label}: refused by the grantor`).toBeDefined();
      expect(issued.message, label).toMatch(/PAYOUT-\d+:/);
    }
    expect(await unfreezeGrants(w.batchId), "no grant row").toBe(grantsBefore);
    expect(await openDisputes(w.batchId), "claim stays open").toBe(1);
    expect(await unfreezesOf(w.batchId)).toBe(0);
    expect(await moneyOf(w)).toEqual(money);

    // Control: the password method is issued and lifts the freeze.
    const ok = await issueGrant({
      kind: "unfreeze",
      step: "approve",
      userId: outsideOwner.userId,
      batchId: w.batchId,
      detail: reasonHash,
      method: "password",
    });
    expect(ok.grant, `password grant: ${ok.message}`).toBeTruthy();
    const released = await appCall(UNFREEZE, [
      w.batchId,
      ok.grant!,
      UNFREEZE_REASON,
    ]);
    expect(released.code, released.message).toBe(undefined);
    expect(Number(released.rows[0]!.released)).toBe(1);
    expect(await openDisputes(w.batchId)).toBe(0);
  });

  it("[920-grant-unfreeze-own-claim-password-ok] control: the disputant's own claim is withdrawn in SQL with a password-method grant", async () => {
    // The own-claim exception needs the same actor AND the same session id as the
    // disown, so the disown is made in SQL under the fixture session that the
    // grantor stand-in also uses for the unfreeze grant.
    const victim = await makePerson("Own claim SQL", "finance");
    const w = await failedWorld(victim);
    const logId = w.logOf[victim.userId]!;
    const disownGrant = await issueGrant({
      kind: "disown",
      step: "record",
      userId: victim.userId,
      batchId: w.batchId,
      refId: logId,
      detail: sha256(REASON),
      method: "password",
    });
    expect(
      disownGrant.grant,
      `disown grant: ${disownGrant.message}`,
    ).toBeTruthy();
    const disowned = await appCall(
      `SELECT app.payout_approval_disown($1::uuid, $2::text, $3::text) AS id`,
      [logId, disownGrant.grant!, REASON],
    );
    expect(disowned.code, `premise: disown, ${disowned.message}`).toBe(
      undefined,
    );
    expect(await openDisputes(w.batchId), "premise: frozen").toBe(1);
    const issued = await issueGrant({
      kind: "unfreeze",
      step: "approve",
      userId: victim.userId,
      batchId: w.batchId,
      detail: sha256(UNFREEZE_REASON),
      method: "password",
    });
    expect(issued.grant, `password grant: ${issued.message}`).toBeTruthy();
    const released = await appCall(UNFREEZE, [
      w.batchId,
      issued.grant!,
      UNFREEZE_REASON,
    ]);
    expect(released.code, released.message).toBe(undefined);
    expect(Number(released.rows[0]!.released)).toBe(1);
    expect(await openDisputes(w.batchId)).toBe(0);
    expect(await unfreezesOf(w.batchId)).toBe(1);
  });
});
