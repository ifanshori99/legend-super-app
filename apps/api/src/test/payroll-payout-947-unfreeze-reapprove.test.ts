// Payout 947 (bead legend-s20iu): after "Bukan saya" on the MAIN approval of a
// batch (log row kind `batch_approve`, 934) and the unfreeze that follows, a batch
// that is still `approved` goes back to `pending_approval`: the approval of the
// person who said "not me" no longer counts, nobody is paid until a NEW, different
// person approves again. Written fail-first from the brief (scratchpad
// brief-947.md) and the sibling suites 920-mutual-unfreeze / 934, NOT from the
// implementation.
//
// Rule proven (founder: nobody is paid on one person's word; when in doubt, limit
// the payment): the reopened batch has no approver, no approval time, no expiry,
// no source account, its items are `prepared` again, all inside the unfreeze
// itself, with a trace; no bank file, transfer or posting can leave it before a
// new approval; that approval is refused for the requester and for the person who
// disowned (also the one who approved first), and granted to somebody else.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - People and routes are the ones of the 920 suites: disown and unfreeze over HTTP
//   with the account password; an owner/finance person who took no part lifts the
//   freeze. The main approval and the export are made through the services with
//   the fixture grantor (as 920-mutual-unfreeze does).
// - The disputant of the batch is the approver of the disowned `batch_approve` log
//   row (a person can only disown their own log row). So "the original approver
//   cannot approve again" and "the disputant cannot" are the same person in the
//   first cycle; the second cycle (test 3) separates them: a later disputant and
//   an earlier one are both refused ("actor of the dispute of that batch" = any
//   dispute of the batch).
// - "Refused" for the new approval means: grant_issue refuses with a PAYOUT-nn
//   message (no grant row), and the service throws a 4xx HttpError, the batch
//   stays `pending_approval`, no log row, no spent grant. The exact HTTP code is
//   not assumed. The refusal in `payout_batch_approve_attest` cannot be reached
//   on its own (its grant comes from grant_issue, which refuses first), so it is
//   covered through the service path only.
// - Audit trail: the unfreeze row stays (one per unfreeze) and the original
//   approval-log rows stay (append-only, never rewritten). The shape of any extra
//   audit row is not assumed.
// - Control (status other than `approved`): a batch already `exported` when the
//   unfreeze happens keeps status, approver and items; the unfreeze only lifts
//   the freeze.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
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

const W = installPayoutWorld("947unf");
const NET = 1_000_000;
const REASON = "Bukan saya yang menyetujui batch ini, akun saya dipakai orang";
const UNFREEZE_REASON = "Sudah dicek ke bank, tidak ada dana keluar tambahan";
const PASSWORD = "Test-password-123!";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const LOGS = "/api/hris/payroll/payout-approval-log";
const DISPUTES = "payroll_payout_batch_disputes";
const UNFREEZES = "payroll_payout_batch_unfreezes";
const LOG = "payroll_payout_approval_log";

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
    [W.tenantId, `Template ${key} 947unf`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in person with payroll.disburse.approve and an owner or finance role at tenant scope. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Reapprove947 ${label}`);
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

let requester: Person; // owner: creates every batch, may never approve or unfreeze it
let approverA: Person; // finance: gives the first main approval, then says "not me"
let approverC: Person; // finance: the new, different approver (and a later disputant)
let approverD: Person; // finance: third approver of the two-cycle test
let outsideOwner: Person; // owner, took no part: lifts the first freeze
let outsideOwner2: Person; // owner, took no part: lifts the second freeze

// ---- Raw SQL helpers ----------------------------------------------------------------------

/** Grant of the grantor stand-in with an explicit method. */
async function issueGrant(input: {
  kind: string;
  step: string;
  userId: string;
  batchId: string;
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
          null,
          null,
          null,
          input.userId,
          actorOf(input.userId).sessionId,
          "password",
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
const logsOf = (batchId: string) =>
  W.rowsOf(
    `SELECT id::text AS id, actor, kind, step FROM ${LOG}
      WHERE tenant_id = $1 AND batch_id = $2 ORDER BY logged_at, id`,
    [W.tenantId, batchId],
  );
const approveLogOf = async (batchId: string, actor: string) => {
  const [log] = await W.rowsOf(
    `SELECT id::text AS id FROM ${LOG}
      WHERE tenant_id = $1 AND batch_id = $2 AND actor = $3 AND kind = 'batch_approve'
      ORDER BY logged_at DESC, id DESC LIMIT 1`,
    [W.tenantId, batchId, actor],
  );
  expect(log, `premise: ${actor} left a batch_approve log row`).toBeTruthy();
  return log!.id as string;
};
const spentGrantsOf = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants
      WHERE tenant_id = $1 AND batch_id = $2 AND consumed_at IS NOT NULL`,
    [W.tenantId, batchId],
  );
const grantsOf = (batchId: string, userId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_grants
      WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'batch_approve' AND actor = $3`,
    [W.tenantId, batchId, userId],
  );
/** What must not move before a new approval: bank files, paid items, payout journals. */
async function moneyOf(runId: string, batchId: string) {
  return {
    files: await count(
      `SELECT count(*)::int AS n FROM bank_transfer_files WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, runId],
    ),
    succeeded: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2 AND status = 'succeeded'`,
      [W.tenantId, runId],
    ),
    postings: await count(
      `SELECT count(*)::int AS n FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND batch_id = $2`,
      [W.tenantId, batchId],
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

// ---- World ------------------------------------------------------------------------------------

type World = {
  runId: string;
  batchId: string;
  hash: string;
  source: string;
};

/** Created and submitted by `requester`, approved by `approverA` (main approval, logged). */
async function approvedWorld(): Promise<World> {
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
  const world = { runId, batchId, hash, source: source!.id as string };
  await approveAs(approverA, world);
  const batch = await W.batchById(batchId);
  expect(batch.status, "premise: approved").toBe("approved");
  expect(batch.approved_by, "premise: approved by A").toBe(approverA.userId);
  for (const item of await W.itemsOf(batchId))
    expect(item.status, "premise: the item is approved").toBe("approved");
  return world;
}

const approveAs = (who: Person, w: World) =>
  W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(who.userId), w.batchId, {
      contentHash: w.hash,
      sourceBankAccountId: w.source,
    }),
  );

/** `who` says "not me" on their main approval, `outsider` lifts the freeze. */
async function disownAndUnfreeze(who: Person, outsider: Person, w: World) {
  const logId = await approveLogOf(w.batchId, who.userId);
  const disown = await disownHttp(who, logId);
  expect([200, 201], `premise: disown ${detail(disown)}`).toContain(
    disown.status,
  );
  expect(await openDisputes(w.batchId), "premise: frozen").toBeGreaterThan(0);
  const before = await unfreezesOf(w.batchId);
  const res = await unfreezeHttp(outsider, w.batchId);
  expect([200, 201], `unfreeze ${detail(res)}`).toContain(res.status);
  expect(res.body.data?.released).toBe(1);
  expect(await openDisputes(w.batchId), "freeze lifted").toBe(0);
  expect(await unfreezesOf(w.batchId), "one more unfreeze row").toBe(
    before + 1,
  );
}

async function expectReopened(w: World) {
  const batch = await W.batchById(w.batchId);
  expect(batch.status, "back to pending_approval").toBe("pending_approval");
  expect(batch.approved_by, "no approver").toBeNull();
  expect(batch.approved_at, "no approval time").toBeNull();
  expect(batch.approval_expires_at, "no approval expiry").toBeNull();
  expect(batch.source_bank_account_id, "no source account").toBeNull();
  const items = await W.itemsOf(w.batchId);
  expect(items.length).toBeGreaterThan(0);
  for (const item of items)
    expect(item.status, "items are prepared again").toBe("prepared");
}

/** The approval of `who` is refused by the service; nothing is written. */
async function expectApprovalRefused(who: Person, w: World, label: string) {
  const logsBefore = (await logsOf(w.batchId)).length;
  const spentBefore = await spentGrantsOf(w.batchId);
  const error = await approveAs(who, w).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `${label}: the approval must be refused`).toBeInstanceOf(
    HttpError,
  );
  expect((error as HttpError).status, label).toBeGreaterThanOrEqual(400);
  expect((error as HttpError).status, label).toBeLessThan(500);
  const batch = await W.batchById(w.batchId);
  expect(batch.status, `${label}: stays pending`).toBe("pending_approval");
  expect(batch.approved_by, label).toBeNull();
  expect(await logsOf(w.batchId), `${label}: no new log row`).toHaveLength(
    logsBefore,
  );
  expect(await spentGrantsOf(w.batchId), `${label}: no grant spent`).toBe(
    spentBefore,
  );
}

/** The grantor refuses a batch_approve grant to `who` (PAYOUT-nn), no grant row. */
async function expectGrantRefused(who: Person, w: World, label: string) {
  const before = await grantsOf(w.batchId, who.userId);
  const issued = await issueGrant({
    kind: "batch_approve",
    step: "approve",
    userId: who.userId,
    batchId: w.batchId,
  });
  expect(issued.grant, `${label}: no grant is issued`).toBeUndefined();
  expect(issued.message, label).toMatch(/PAYOUT-\d+:/);
  expect(await grantsOf(w.batchId, who.userId), `${label}: no grant row`).toBe(
    before,
  );
}

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requester = await makePerson("Requester", "owner");
  approverA = await makePerson("Approver A", "finance");
  approverC = await makePerson("Approver C", "finance");
  approverD = await makePerson("Approver D", "finance");
  outsideOwner = await makePerson("Outside owner", "owner");
  outsideOwner2 = await makePerson("Outside owner 2", "owner");
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

describe("947 unfreeze after 'not me' on the main approval reopens the batch", () => {
  it("[947-unfreeze-reopens-approval] disown of the batch_approve row then unfreeze: the approved batch is pending_approval again, approval fields cleared, items prepared, the trace stays", async () => {
    const w = await approvedWorld();
    const logsBefore = await logsOf(w.batchId);
    await disownAndUnfreeze(approverA, outsideOwner, w);

    await expectReopened(w);
    // Trace: the original approval log row is still there (append-only), and the
    // unfreeze row of the unfreeze exists.
    const logsAfter = await logsOf(w.batchId);
    expect(
      logsAfter.map((l) => l.id),
      "the original approval-log rows are untouched",
    ).toEqual(expect.arrayContaining(logsBefore.map((l) => l.id)));
    expect(await unfreezesOf(w.batchId)).toBe(1);
  });

  it("[947-no-money-before-reapproval] after the reopening nothing leaves the batch: the bank file export is refused (409) and no file, transfer, journal or posting appears", async () => {
    const w = await approvedWorld();
    await disownAndUnfreeze(approverA, outsideOwner, w);
    await expectReopened(w);
    const money = await moneyOf(w.runId, w.batchId);

    // Neither the person who approved first nor anybody else can export it.
    for (const who of [approverA, approverC])
      await W.expectRefused(
        W.inTx((tx) => exportManualBatch(tx, actorOf(who.userId), w.batchId)),
        { status: 409 },
      );
    expect(await moneyOf(w.runId, w.batchId), "no money moved").toEqual(money);
    expect((await W.batchById(w.batchId)).status).toBe("pending_approval");
  });
});

describe("947 the new approval needs somebody else", () => {
  it("[947-reapprove-needs-new-person] the requester and the person who disowned (the first approver) are refused in grant_issue and in the service; a third person approves, is the logged actor and spends a new grant", async () => {
    const w = await approvedWorld();
    await disownAndUnfreeze(approverA, outsideOwner, w);
    await expectReopened(w);

    // Grant issue (database): refused for the requester and the disputant.
    await expectGrantRefused(approverA, w, "disputant and first approver");
    await expectGrantRefused(requester, w, "requester");
    // Service: refused for both, nothing written.
    await expectApprovalRefused(approverA, w, "disputant and first approver");
    await expectApprovalRefused(requester, w, "requester");

    // Control: a different person can (so the refusals above are about the person).
    const spentBefore = await spentGrantsOf(w.batchId);
    await approveAs(approverC, w);
    const batch = await W.batchById(w.batchId);
    expect(batch.status, "approved again").toBe("approved");
    expect(batch.approved_by, "by the new person").toBe(approverC.userId);
    expect(batch.approved_by).not.toBe(approverA.userId);
    expect(batch.approved_at).not.toBeNull();
    expect(batch.source_bank_account_id).toBe(w.source);
    const logs = (await logsOf(w.batchId)).filter(
      (l) => l.kind === "batch_approve",
    );
    expect(
      logs.map((l) => l.actor),
      "both approvals are in the log, the new one as the new person",
    ).toEqual([approverA.userId, approverC.userId]);
    expect(await spentGrantsOf(w.batchId), "a new grant was spent").toBe(
      spentBefore + 1,
    );
  });

  it("[947-reapprove-excludes-every-disputant] second cycle: the new approver also says 'not me' and the batch reopens again; the first and the second disputant and the requester are refused, a fourth person approves", async () => {
    const w = await approvedWorld();
    await disownAndUnfreeze(approverA, outsideOwner, w);
    await expectReopened(w);
    await approveAs(approverC, w);
    expect((await W.batchById(w.batchId)).approved_by).toBe(approverC.userId);

    await disownAndUnfreeze(approverC, outsideOwner2, w);
    await expectReopened(w);
    expect(await unfreezesOf(w.batchId), "two unfreezes").toBe(2);

    for (const [who, label] of [
      [approverA, "first disputant"],
      [approverC, "second disputant"],
      [requester, "requester"],
    ] as const) {
      await expectGrantRefused(who, w, label);
      await expectApprovalRefused(who, w, label);
    }

    await approveAs(approverD, w);
    const batch = await W.batchById(w.batchId);
    expect(batch.status).toBe("approved");
    expect(batch.approved_by).toBe(approverD.userId);
  });
});

describe("947 only an approved batch is reopened", () => {
  it("[947-exported-batch-unchanged] a batch already exported when the freeze is lifted keeps its status, approver and items; only the freeze is lifted", async () => {
    const w = await approvedWorld();
    await W.inTx((tx) =>
      exportManualBatch(tx, actorOf(approverA.userId), w.batchId),
    );
    const before = await W.batchById(w.batchId);
    expect(before.status, "premise: exported").toBe("exported");
    const itemsBefore = (await W.itemsOf(w.batchId)).map((i) => i.status);

    await disownAndUnfreeze(approverA, outsideOwner, w);

    const after = await W.batchById(w.batchId);
    expect(after.status, "status is not touched").toBe("exported");
    expect(after.approved_by, "approver is kept").toBe(approverA.userId);
    expect(after.approved_at).toEqual(before.approved_at);
    expect(after.approval_expires_at).toEqual(before.approval_expires_at);
    expect(after.source_bank_account_id).toBe(before.source_bank_account_id);
    expect((await W.itemsOf(w.batchId)).map((i) => i.status)).toEqual(
      itemsBefore,
    );
  });
});

// A disown on a log row of another kind is not covered here: after the main
// approval the next trusted step (export) moves the batch out of `approved`, so a
// batch that is `approved` with a non-batch_approve disown cannot be built without
// forcing rows by hand.
