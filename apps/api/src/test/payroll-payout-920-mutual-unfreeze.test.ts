// Payout 920: two batches of one run freeze each other (same payslip), and the
// unfreeze of one of them must not be undone by the freeze of the other.
// Written fail-first from the brief, NOT from the implementation.
//
// Bug proven: after an unfreeze, the service catches the run up (settles the run
// and announces `payroll.paid`). It used to count the batch being unfrozen as
// still frozen, so the settle hit PAYOUT-79 and the whole unfreeze answered 409
// and rolled back, although nothing else blocked that batch except its sibling.
//
// Rule proven (founder: nobody is paid on one person's word; when in doubt, limit
// the payment): in a run with batch A (`partially_failed`) and its retry B (same
// payslip, `completed`), every slip paid, a "not me" on a log of A and another
// on a log of B freezes both. Unfreezing one of them (an outsider, with the
// password) succeeds (200, never 409) and releases that claim, but the run stays
// `locked` with no `payroll.paid` while the other claim is open. Unfreezing the
// other turns the run `paid` exactly once, with exactly one `payroll.paid` event.
//
// Assumptions (the spec leaves them open, stated so they can be contested):
// - Routes and people are the ones of 920-unfreeze-password: disown and unfreeze
//   over HTTP with the account password (grant method `password`), an owner who
//   took no part in either batch lifts the freezes.
// - World: one run [BUDI, SITI], both bank transfers. A: BUDI confirmed by
//   confirmerA, SITI closed `failed` by two resolvers (A ends `partially_failed`).
//   B: the retry of SITI (createDisbursementBatch for the same run), confirmed by
//   confirmerB (B ends `completed`). Disowned logs: resolver1 on A, confirmerB on B.
// - The run still turns `paid` when B is confirmed (nothing is frozen yet). A
//   "not me" about a step whose run settle did not happen yet is the state under
//   test, so the fixture puts the run back to `locked` (paid fields cleared, its
//   `payroll.paid` outbox rows removed, triggers off) before the disowns. If the
//   run was not paid at that point, nothing is changed.
// - Both orders are covered: unfreeze A first then B, and B first then A.
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
  SITI,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("920mut");
const NET = 1_000_000;
const REASON =
  "Bukan saya yang menyetujui langkah ini, akun saya dipakai orang";
const UNFREEZE_REASON = "Sudah dicek ke bank, tidak ada dana keluar tambahan";
const PASSWORD = "Test-password-123!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const LOGS = "/api/hris/payroll/payout-approval-log";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";

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
    [W.tenantId, `Template ${key} 920mut`, key],
  );
  return (await read()).rows[0]!.id;
}

/**
 * A signed-in person with payroll.disburse.approve and an owner or finance
 * template role at tenant scope, TOTP enrolled and verified in this session.
 */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Mutual920 ${label}`);
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
  return { client, userId };
}

let requester: Person; // owner: creates every batch
let approver: Person; // finance: approves and exports every batch
let confirmerA: Person; // finance: confirms BUDI in A
let resolver1: Person; // finance: first closer of SITI in A (will disown)
let resolver2: Person; // finance: second closer of SITI in A
let confirmerB: Person; // finance: confirms SITI in B (will disown)
let outsideOwner: Person; // owner, took no part: the legitimate unfreezer

// ---- Observations ---------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const openDisputes = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${DISPUTES} d
      WHERE d.tenant_id = $1 AND d.batch_id = $2
        AND NOT EXISTS (SELECT 1 FROM ${UNFREEZES} u
                         WHERE u.tenant_id = d.tenant_id AND u.dispute_id = d.id)`,
    [W.tenantId, batchId],
  );
const unfreezesOf = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM ${UNFREEZES} WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  );
const logOfActor = async (batchId: string, actor: string) => {
  const [log] = await W.rowsOf(
    `SELECT id::text AS id FROM payroll_payout_approval_log
      WHERE tenant_id = $1 AND batch_id = $2 AND actor = $3
      ORDER BY logged_at, id LIMIT 1`,
    [W.tenantId, batchId, actor],
  );
  expect(log, `premise: ${actor} left an approval-log row`).toBeTruthy();
  return log!.id as string;
};
/** What an unfreeze must never move: paid items and payout journals of the run. */
async function moneyOf(runId: string) {
  return {
    succeeded: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'succeeded'`,
      [W.tenantId, runId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId, W.entityId()],
    ),
  };
}

// ---- HTTP -------------------------------------------------------------------------------------

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
const unfreezeHttp = (who: Person, batchId: string) =>
  who.client.post(`${BATCHES}/${batchId}/unfreeze`).set(originHeader).send({
    reason: UNFREEZE_REASON,
    password: PASSWORD,
  }) as unknown as Promise<Res>;
const getBatch = (who: Person, batchId: string) =>
  who.client.get(`${BATCHES}/${batchId}`) as unknown as Promise<Res>;

// ---- World ------------------------------------------------------------------------------------

/** Created by requester, approved and exported by approver: items wait for the bank result. */
async function exportedBatchOf(runId: string, exceptBatchId?: string) {
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [row] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId, exceptBatchId ?? null],
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
  return batchId;
}

/**
 * Run [BUDI, SITI]. A is `partially_failed` (BUDI paid, SITI failed twice-closed),
 * B is the `completed` retry of SITI. Every slip has a paid item.
 */
async function retryWorld() {
  const slips = [bank(BUDI, NET), bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);

  const batchA = await exportedBatchOf(runId);
  const itemsA = await W.itemsOf(batchA);
  const budiA = itemsA.find((i) => i.employee_id === BUDI.id)!;
  const sitiA = itemsA.find((i) => i.employee_id === SITI.id)!;
  await W.confirm(batchA, W.succeedItems(batchA, [budiA]), confirmerA.userId);
  await W.resolve(batchA, [sitiA.id as string], "failed", resolver1.userId);
  await W.resolve(batchA, [sitiA.id as string], "failed", resolver2.userId);
  expect(
    (await W.batchById(batchA)).status,
    "premise: A is partially_failed",
  ).toBe("partially_failed");

  const batchB = await exportedBatchOf(runId, batchA);
  const itemsB = await W.itemsOf(batchB);
  expect(itemsB, "premise: B retries only SITI").toHaveLength(1);
  expect(itemsB[0]!.employee_id).toBe(SITI.id);
  await W.confirm(batchB, W.succeedItems(batchB, itemsB), confirmerB.userId);
  expect((await W.batchById(batchB)).status, "premise: B is completed").toBe(
    "completed",
  );
  expect(
    (await moneyOf(runId)).succeeded,
    "premise: every slip is paid (BUDI in A, SITI in B)",
  ).toBe(2);

  // The state under test: the run is still waiting to be settled (see header).
  if ((await W.runRow(runId)).status === "paid")
    await W.asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_runs SET status = 'locked', paid_at = NULL, paid_by = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, runId],
      );
      await c.query(
        `DELETE FROM domain_event_outbox
          WHERE tenant_id = $1 AND event->>'name' = 'payroll.paid'
            AND event::text LIKE '%' || $2 || '%'`,
        [W.tenantId, runId],
      );
    }, true);
  expect((await W.runRow(runId)).status, "premise: run locked").toBe("locked");
  expect(
    await W.paidEventsOf(runId),
    "premise: nothing announced yet",
  ).toHaveLength(0);

  // Two "not me": one on a log of A, one on a log of B. Both batches freeze.
  const logA = await logOfActor(batchA, resolver1.userId);
  const logB = await logOfActor(batchB, confirmerB.userId);
  for (const [who, logId] of [
    [resolver1, logA],
    [confirmerB, logB],
  ] as const) {
    const res = await disownHttp(who, logId);
    expect([200, 201], `premise: disown ${detail(res)}`).toContain(res.status);
  }
  expect(await openDisputes(batchA), "premise: A frozen").toBe(1);
  expect(await openDisputes(batchB), "premise: B frozen").toBe(1);
  expect(
    (await W.runRow(runId)).status,
    "premise: freezing alone does not move the run",
  ).toBe("locked");
  return { runId, batchA, batchB };
}

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requester = await makePerson("Requester", "owner");
  approver = await makePerson("Approver", "finance");
  confirmerA = await makePerson("Confirmer A", "finance");
  resolver1 = await makePerson("Resolver 1", "finance");
  resolver2 = await makePerson("Resolver 2", "finance");
  confirmerB = await makePerson("Confirmer B", "finance");
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

// ---- Tests -------------------------------------------------------------------------------------

/** Unfreeze `first`, expect the run to wait; unfreeze `second`, expect the run paid once. */
async function mutualUnfreeze(order: "AB" | "BA") {
  const w = await retryWorld();
  const [first, second] =
    order === "AB" ? [w.batchA, w.batchB] : [w.batchB, w.batchA];
  const money = await moneyOf(w.runId);

  const one = await unfreezeHttp(outsideOwner, first);
  expect(
    one.status,
    `the first unfreeze is not undone: ${detail(one)}`,
  ).not.toBe(409);
  expect([200, 201], detail(one)).toContain(one.status);
  expect(one.body.data?.released, "its claim is released").toBe(1);
  expect(await openDisputes(first), "first claim released").toBe(0);
  expect(await unfreezesOf(first), "one unfreeze row").toBe(1);
  expect(await openDisputes(second), "the other claim is untouched").toBe(1);
  expect(await unfreezesOf(second)).toBe(0);
  expect(
    (await W.runRow(w.runId)).status,
    "the run stays locked while the other batch is frozen",
  ).toBe("locked");
  expect(
    await W.paidEventsOf(w.runId),
    "no payroll.paid while the other batch is frozen",
  ).toHaveLength(0);
  const stillFrozen = await getBatch(outsideOwner, second);
  expect(stillFrozen.status, detail(stillFrozen)).toBe(200);
  expect(
    (stillFrozen.body.data?.freeze as { frozen: boolean }).frozen,
    "the other batch still reads frozen",
  ).toBe(true);
  expect(await moneyOf(w.runId), "no money moved").toEqual(money);

  const two = await unfreezeHttp(outsideOwner, second);
  expect([200, 201], detail(two)).toContain(two.status);
  expect(two.body.data?.released).toBe(1);
  expect(await openDisputes(first)).toBe(0);
  expect(await openDisputes(second)).toBe(0);
  expect(await unfreezesOf(second)).toBe(1);
  const run = await W.runRow(w.runId);
  expect(run.status, "the run is paid once nothing is frozen").toBe("paid");
  expect(run.paid_at).not.toBeNull();
  expect(
    await W.paidEventsOf(w.runId),
    "exactly one payroll.paid event",
  ).toHaveLength(1);
  expect(await moneyOf(w.runId), "no money moved").toEqual(money);
  for (const batchId of [w.batchA, w.batchB]) {
    const batch = await getBatch(outsideOwner, batchId);
    expect(batch.status, detail(batch)).toBe(200);
    expect(
      (batch.body.data?.freeze as { frozen: boolean }).frozen,
      "neither batch reads frozen",
    ).toBe(false);
  }
}

describe("920 two siblings frozen: unfreezing one is not undone by the other", () => {
  it("[920-mutual-unfreeze-a-then-b] A (partially_failed) and its retry B (completed) both disowned: unfreeze A succeeds (not 409) and the run stays locked; unfreeze B turns the run paid with exactly one payroll.paid", async () => {
    await mutualUnfreeze("AB");
  });

  it("[920-mutual-unfreeze-b-then-a] same world, other order: unfreeze B succeeds (not 409) and the run stays locked; unfreeze A turns the run paid with exactly one payroll.paid", async () => {
    await mutualUnfreeze("BA");
  });
});
