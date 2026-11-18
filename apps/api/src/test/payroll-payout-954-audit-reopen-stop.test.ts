// Payout 954 (bead legend-e3m8d): the audit events of the 947 follow-up, `batch_reopened`
// (unfreeze after "not me" sends an approved batch back to pending_approval) and
// `batch_stopped` (cash already partly handed over: the batch is closed instead).
// Written from the bead text and PROGRESS.md ("Audit batch_reopened/batch_stopped"),
// NOT from the implementation. World, people and routes copy the 947 suite.
//
// Assumptions (the spec leaves them open, stated so they can be contested):
// - Audit events live in `audit_logs.event` (jsonb) like the other payout audit
//   events; the event name is found in `event->>'action'` (substring match, so a
//   namespace prefix does not matter) and the batch in the event text (its id).
// - Exactly one event per reopening / stopping, of the right kind only: a reopened
//   batch writes no batch_stopped, a stopped batch no batch_reopened, and an
//   exported batch (the freeze is only lifted) writes neither.
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
  CASHIER,
  SITI,
  cash,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("954aud");
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
    [W.tenantId, `Template ${key} 954aud`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in person with payroll.disburse.approve and an owner or finance role at tenant scope. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Audit954 ${label}`);
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
let outsideOwner: Person; // owner, took no part: lifts the first freeze

// ---- Raw SQL helpers ----------------------------------------------------------------------

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
async function approvedWorld(
  channel: "manual_bank" | "cash" = "manual_bank",
): Promise<World> {
  const slips =
    channel === "cash"
      ? [cash(CASHIER, NET), cash(SITI, NET)]
      : [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel,
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
  // Cash approval needs 1102 to cover the batch (legend-rvao9): setup only.
  if (channel === "cash") await W.fundPettyCash(NET * 2);
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

// ---- Setup / teardown --------------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  requester = await makePerson("Requester", "owner");
  approverA = await makePerson("Approver A", "finance");
  approverC = await makePerson("Approver C", "finance");
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

// ---- Audit observations -----------------------------------------------------------------------

const auditOf = (batchId: string, action: string) =>
  count(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' LIKE '%' || $2 || '%'
        AND event::text LIKE '%' || $3 || '%'`,
    [W.tenantId, action, batchId],
  );

// ---- Tests -------------------------------------------------------------------------------------

describe("954 audit events of the unfreeze follow-up", () => {
  it("[954-audit-batch-reopened] unfreeze after 'not me' on the main approval writes one batch_reopened event for the batch and no batch_stopped", async () => {
    const w = await approvedWorld();
    expect(
      await auditOf(w.batchId, "batch_reopened"),
      "premise: none yet",
    ).toBe(0);
    await disownAndUnfreeze(approverA, outsideOwner, w);
    await expectReopened(w);
    expect(await auditOf(w.batchId, "batch_reopened")).toBe(1);
    expect(await auditOf(w.batchId, "batch_stopped")).toBe(0);
  });

  it("[954-audit-batch-stopped] cash partly handed over: unfreeze closes the batch and writes one batch_stopped event and no batch_reopened", async () => {
    const w = await approvedWorld("cash");
    const [paid] = await W.itemsOf(w.batchId);
    await W.handover(w.batchId, [paid!.id as string], approverC.userId);
    await disownAndUnfreeze(approverA, outsideOwner, w);
    expect((await W.batchById(w.batchId)).status).toBe("partially_failed");
    expect(await auditOf(w.batchId, "batch_stopped")).toBe(1);
    expect(await auditOf(w.batchId, "batch_reopened")).toBe(0);
  });

  it("[954-audit-none-when-exported] an exported batch only has its freeze lifted: neither batch_reopened nor batch_stopped is written", async () => {
    const w = await approvedWorld();
    await W.inTx((tx) =>
      exportManualBatch(tx, actorOf(approverA.userId), w.batchId),
    );
    await disownAndUnfreeze(approverA, outsideOwner, w);
    expect((await W.batchById(w.batchId)).status).toBe("exported");
    expect(await auditOf(w.batchId, "batch_reopened")).toBe(0);
    expect(await auditOf(w.batchId, "batch_stopped")).toBe(0);
  });
});
