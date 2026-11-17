// Payout 990 card A (bead legend-xbagc): a payout recon flag can be cleared, but
// never by one person alone. Written fail-first from the brief
// (docs/briefs/sub-990-payout-lanjutan.md "Kartu A", "I1", "I2"), NOT from the
// implementation.
//
// Rules proven (founder: nobody is paid on one person's word; when in doubt,
// limit the payment; tenants never touch each other):
// - A flag (payroll_payout_recon_exceptions row, insert-only) holds its payslip
//   from a new batch. Two different finance people (one proposes with a reason,
//   the other approves), each with the account password, release the hold; the
//   flag row itself stays (audit).
// - The proposer can never approve (API 403, SQL PAYOUT-86); a proposal alone
//   keeps holding; an approved clearance cannot be approved again (409 / PAYOUT-87);
//   two approvals at the same moment: exactly one wins.
// - No password (401), a wrong password (403), a missing, expired or mis-bound
//   grant (PAYOUT-70) change nothing.
// - The app role cannot write the clearance table directly (INSERT, UPDATE,
//   DELETE refused with 42501), so it cannot open the hold behind the function.
// - A flag of another tenant is not found (404) and stays untouched.
// - Running the recon again for a key already cleared does not hold the slip
//   again (the flag insert stays ON CONFLICT DO NOTHING).
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - ROUTES are the final ones of docs/briefs/990/i2-contract.md: GET
//   /api/hris/payroll/payout-recon-flags, POST .../payout-recon-flags/:flagId/
//   clearance {reason, password} -> 201 {data:{clearanceId}}, POST
//   .../payout-recon-clearances/:clearanceId/approve {password} -> 200.
// - The flag id the routes take is the `id` of payroll_payout_recon_exceptions.
// - Error statuses: no password 401, wrong password 403 (as the 920 unfreeze),
//   PAYOUT-86 403, PAYOUT-87 409, a flag of another tenant 404.
// - A grant (kind recon_clear, method password) is bound to batch = batch of the
//   flagged item, ref = flag id (propose) or clearance id (approve), detail =
//   sha256 hex of the reason (brief I1). SQL signatures: app.payout_recon_clear_
//   propose(exception, grant, reason) and app.payout_recon_clear_approve(
//   clearance, grant), called as legend_app.
// - The self-approval refusal in SQL may happen at the grant issue or at the
//   approve call; both must say PAYOUT-86. "Same session" is covered by the
//   same person (a person has one session in the fixtures).
// - A hold is probed by creating a follow-up batch of the failed slip (as the
//   905 recon test does): refused 409 while held, accepted once released.
// - The flag is made as the table owner with app.payout_recon_flag(tenant,
//   'correction', <random operation>, item, reason), as the 905 recon test does.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import {
  actorOf,
  bank,
  BUDI,
  APP,
  APP3,
  REQ,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("990clr");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const REASON = "Sudah dicek manual, jurnal dan bukti bank cocok semuanya";
const OTHER_REASON = "Alasan lain yang tidak pernah diajukan oleh siapa pun";
const FLAGS = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const GRANTS = "payroll_payout_grants";
const PRIVILEGE = "42501";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
/** payroll_payout_grants.secret_sha256 is sha256 of the raw bytes of the hex grant. */
const grantSecretHash = (grant: string) =>
  createHash("sha256").update(Buffer.from(grant, "hex")).digest("hex");

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const foreignTenants: string[] = [];
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
    [W.tenantId, `Template ${key} 990clr`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in finance person (tenant-level template role, approve permission), TOTP enrolled in this session. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Clear990 ${label}`);
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

let proposer: Person;
let approverA: Person;
let approverB: Person;

// ---- HTTP ----------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);

const proposeHttp = (
  who: Person,
  flagId: string,
  body: Record<string, unknown> = { reason: REASON, password: PASSWORD },
) =>
  who.client
    .post(`${FLAGS}/${flagId}/clearance`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const approveHttp = (
  who: Person,
  clearanceId: string,
  body: Record<string, unknown> = { password: PASSWORD },
) =>
  who.client
    .post(`${CLEARANCES}/${clearanceId}/approve`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const listFlagsHttp = (who: Person) =>
  who.client.get(FLAGS) as unknown as Promise<Res>;

const clearanceIdOf = (res: Res) => {
  const id = res.body.data?.clearanceId ?? res.body.clearanceId;
  expect(id, `the response carries clearanceId: ${detail(res)}`).toBeTruthy();
  return id as string;
};

// ---- Raw SQL (legend_app, grantor stand-in) ------------------------------------------------

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

/** A recon_clear grant of the grantor stand-in (method password), bound as in brief I1. */
async function issueGrant(input: {
  step: "propose" | "approve";
  userId: string;
  batchId: string;
  refId: string;
  detail: string;
}): Promise<{ grant?: string; message: string }> {
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
          "recon_clear",
          input.step,
          input.batchId,
          "{}",
          null,
          input.refId,
          null,
          input.detail,
          input.userId,
          actorOf(input.userId).sessionId,
          "password",
        ],
      );
      await client.query("COMMIT");
      return { grant: (rows[0] as { grant: string }).grant, message: "" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return { message: (error as { message?: string }).message ?? "" };
    }
  } finally {
    client.release();
  }
}

const PROPOSE_SQL = `SELECT app.payout_recon_clear_propose($1::uuid, $2::text, $3::text) AS id`;
const APPROVE_SQL = `SELECT app.payout_recon_clear_approve($1::uuid, $2::text) AS id`;

// ---- Observations --------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const clearancesOf = (flagId: string) =>
  W.rowsOf(
    `SELECT * FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1 AND exception_id = $2`,
    [W.tenantId, flagId],
  );
const clearanceCount = () =>
  count(
    `SELECT count(*)::int AS n FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1`,
    [W.tenantId],
  );
const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const grantCount = () =>
  count(
    `SELECT count(*)::int AS n FROM ${GRANTS} WHERE tenant_id = $1 AND kind = 'recon_clear'`,
    [W.tenantId],
  );
/** What a clearance must never move: paid items and payout journals. */
async function moneyOf() {
  return {
    succeeded: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND status = 'succeeded'`,
      [W.tenantId],
    ),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId],
    ),
  };
}

// ---- Worlds --------------------------------------------------------------------------------

/** The only item was closed `failed` by two people: its slip may get a follow-up batch. */
async function failedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  expect(item!.status, "premise: failed").toBe("failed");
  return { runId, batchId, itemId };
}

/** The night run flags the item (the owner calls the trusted flag function, as the 905 recon test does). */
const FLAG_REASON = "recon test: forged transition";
const flagCall = (itemId: string, operation: string) =>
  W.asTenant(
    (c) =>
      c.query(`SELECT app.payout_recon_flag($1, 'correction', $2, $3, $4)`, [
        W.tenantId,
        operation,
        itemId,
        FLAG_REASON,
      ]),
    true,
  );
async function flagItem(itemId: string, operation: string) {
  await flagCall(itemId, operation);
  const rows = await exceptionRows(itemId);
  expect(rows.length, "premise: the flag is on record").toBeGreaterThan(0);
  return rows[0]!.id as string;
}

async function flaggedWorld() {
  const world = await failedWorld();
  const operation = randomUUID();
  const flagId = await flagItem(world.itemId, operation);
  return { ...world, flagId, operation };
}

const followUpBatch = (runId: string) =>
  W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(REQ), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
const batchCount = (runId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2`,
    [W.tenantId, runId],
  );
/** The follow-up batch is refused (409) and no batch appears. */
async function expectHeld(runId: string, label: string) {
  const before = await batchCount(runId);
  await W.expectRefused(followUpBatch(runId), { status: 409 });
  expect(await batchCount(runId), `${label}: no new batch`).toBe(before);
}
/** The follow-up batch is accepted: the slip is free. */
async function expectReleased(runId: string, label: string) {
  const before = await batchCount(runId);
  const failure = await W.httpFailure(followUpBatch(runId));
  expect(failure, `${label}: the slip can get a new batch`).toBeNull();
  expect(await batchCount(runId), `${label}: one new batch`).toBe(before + 1);
}

/** Proposal by `proposer` over HTTP; returns the clearance id. */
async function proposed(flagId: string) {
  const res = await proposeHttp(proposer, flagId);
  expect(res.status, `premise: propose ${detail(res)}`).toBe(201);
  return clearanceIdOf(res);
}

// ---- The recon (adapter of the 905 recon test: one page per call) --------------------------

async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = [
    "reconcileTrustedPayouts",
    "runTrustedPayoutRecon",
    "runPayoutRecon",
  ].find((n) => typeof mod[n] === "function");
  expect(name, "the recon service exports the night run").toBeDefined();
  const run = mod[name!] as (
    context: unknown,
    options: unknown,
  ) => Promise<{ operations: number; last: string | null }>;
  const { storage } = W.proofs();
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

// ---- Setup / teardown ----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  proposer = await makePerson("Proposer", "finance");
  approverA = await makePerson("Approver A", "finance");
  approverB = await makePerson("Approver B", "finance");
});

afterEach(async () => {
  // Insert-only rows of this file (guards off): clearances first, then their grants and flags.
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    await c.query(
      `DELETE FROM ${GRANTS} WHERE tenant_id = $1 AND kind = 'recon_clear'`,
      [W.tenantId],
    );
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    for (const id of foreignTenants.splice(0)) {
      await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
  }, true);
});

afterAll(async () => {
  await W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
        [W.tenantId, personIds],
      ),
    true,
  ).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// =========================================================================
// A1: two different finance people release the slip
// =========================================================================

describe("990 A: a recon flag is cleared by two people", () => {
  it("[990-A-1-two-finance-release-slip] one finance proposes with a reason, a different one approves, both with the password: the flag no longer holds the payslip (a new batch is accepted); the flag row stays; no money or journal moves", async () => {
    const w = await flaggedWorld();
    await expectHeld(w.runId, "control: a flagged slip is held");
    const money = await moneyOf();

    const clearanceId = await proposed(w.flagId);
    const [proposal] = await clearancesOf(w.flagId);
    expect(proposal, "the proposal is on record").toBeDefined();
    expect(proposal!.proposed_by).toBe(proposer.userId);
    expect(proposal!.reason).toBe(REASON);
    expect(proposal!.approved_by, "not approved yet").toBeNull();

    const approved = await approveHttp(approverA, clearanceId);
    expect(approved.status, detail(approved)).toBe(200);
    const [done] = await clearancesOf(w.flagId);
    expect(done!.approved_by).toBe(approverA.userId);
    expect(done!.approved_by).not.toBe(done!.proposed_by);
    expect(done!.approved_at).not.toBeNull();
    expect(
      await exceptionRows(w.itemId),
      "the flag row is kept (insert-only audit)",
    ).toHaveLength(1);

    await expectReleased(w.runId, "after the two-person clearance");
    expect(await moneyOf(), "clearing moves no money").toEqual(money);
  });

  it("[990-A-1-sql-flow] the same two-person flow in SQL as legend_app: propose returns a clearance, approve by another person fills approved_by", async () => {
    const w = await flaggedWorld();
    const grantP = await issueGrant({
      step: "propose",
      userId: proposer.userId,
      batchId: w.batchId,
      refId: w.flagId,
      detail: sha256(REASON),
    });
    expect(grantP.grant, `propose grant: ${grantP.message}`).toBeTruthy();
    const proposal = await appCall(PROPOSE_SQL, [
      w.flagId,
      grantP.grant!,
      REASON,
    ]);
    expect(proposal.code, proposal.message).toBeUndefined();
    const clearanceId = proposal.rows[0]!.id as string;
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
    await expectHeld(w.runId, "a proposal alone does not release");

    const grantA = await issueGrant({
      step: "approve",
      userId: approverA.userId,
      batchId: w.batchId,
      refId: clearanceId,
      detail: sha256(REASON),
    });
    expect(grantA.grant, `approve grant: ${grantA.message}`).toBeTruthy();
    const approval = await appCall(APPROVE_SQL, [clearanceId, grantA.grant!]);
    expect(approval.code, approval.message).toBeUndefined();
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBe(
      approverA.userId,
    );
    await expectReleased(w.runId, "after the SQL clearance");
  });

  it("[990-A-1-sql-reason-length] a reason shorter than 10 or longer than 500 characters is refused in SQL with PAYOUT-85; no clearance row", async () => {
    const w = await flaggedWorld();
    for (const reason of ["pendek", "x".repeat(501)]) {
      const grant = await issueGrant({
        step: "propose",
        userId: proposer.userId,
        batchId: w.batchId,
        refId: w.flagId,
        detail: sha256(reason),
      });
      expect(grant.grant, `grant: ${grant.message}`).toBeTruthy();
      const out = await appCall(PROPOSE_SQL, [w.flagId, grant.grant!, reason]);
      expect(out.message, `reason of ${reason.length} chars`).toMatch(
        /PAYOUT-85/,
      );
    }
    expect(await clearancesOf(w.flagId)).toHaveLength(0);
    await expectHeld(w.runId, "still held");
  });
});

// =========================================================================
// A2: nobody clears alone
// =========================================================================

describe("990 A: the proposer cannot approve", () => {
  it("[990-A-2-self-approve-api] the proposer approving their own clearance over HTTP is refused 403; not approved, the slip stays held", async () => {
    const w = await flaggedWorld();
    const clearanceId = await proposed(w.flagId);

    const res = await approveHttp(proposer, clearanceId);
    expect(res.status, detail(res)).toBe(403);
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
    await expectHeld(w.runId, "self-approval does not release");

    // Control: a different finance person can still approve it.
    const ok = await approveHttp(approverA, clearanceId);
    expect(ok.status, detail(ok)).toBe(200);
  });

  it("[990-A-2-self-approve-sql] the proposer approving in SQL is refused with PAYOUT-86 (at the grant or at the call); not approved, the slip stays held", async () => {
    const w = await flaggedWorld();
    const grantP = await issueGrant({
      step: "propose",
      userId: proposer.userId,
      batchId: w.batchId,
      refId: w.flagId,
      detail: sha256(REASON),
    });
    expect(grantP.grant, `propose grant: ${grantP.message}`).toBeTruthy();
    const proposal = await appCall(PROPOSE_SQL, [
      w.flagId,
      grantP.grant!,
      REASON,
    ]);
    expect(proposal.code, `premise: ${proposal.message}`).toBeUndefined();
    const clearanceId = proposal.rows[0]!.id as string;

    const grantSelf = await issueGrant({
      step: "approve",
      userId: proposer.userId,
      batchId: w.batchId,
      refId: clearanceId,
      detail: sha256(REASON),
    });
    if (grantSelf.grant) {
      const out = await appCall(APPROVE_SQL, [clearanceId, grantSelf.grant]);
      expect(out.code, "the self-approval must be refused").toBeDefined();
      expect(out.message).toMatch(/PAYOUT-86/);
    } else {
      expect(grantSelf.message).toMatch(/PAYOUT-86/);
    }
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
    await expectHeld(w.runId, "self-approval does not release");
  });

  it("[990-A-2-approved-twice] a clearance already approved cannot be approved again: PAYOUT-87 in SQL, 409 over HTTP; the first approver stays", async () => {
    const w = await flaggedWorld();
    const clearanceId = await proposed(w.flagId);
    const first = await approveHttp(approverA, clearanceId);
    expect(first.status, detail(first)).toBe(200);

    const second = await approveHttp(approverB, clearanceId);
    expect(second.status, detail(second)).toBe(409);

    const grant = await issueGrant({
      step: "approve",
      userId: approverB.userId,
      batchId: w.batchId,
      refId: clearanceId,
      detail: sha256(REASON),
    });
    if (grant.grant) {
      const out = await appCall(APPROVE_SQL, [clearanceId, grant.grant]);
      expect(out.message).toMatch(/PAYOUT-87/);
    } else {
      expect(grant.message).toMatch(/PAYOUT-87/);
    }
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBe(
      approverA.userId,
    );
  });
});

// =========================================================================
// A3: password and grant
// =========================================================================

describe("990 A: password and grant are required", () => {
  it("[990-A-3-no-password-wrong-password] propose and approve without the password are refused 401, with a wrong password 403; nothing is recorded, no grant, the slip stays held", async () => {
    const w = await flaggedWorld();
    const grantsBefore = await grantCount();

    const noPassword = await proposeHttp(proposer, w.flagId, {
      reason: REASON,
    });
    expect(noPassword.status, detail(noPassword)).toBe(401);
    const wrong = await proposeHttp(proposer, w.flagId, {
      reason: REASON,
      password: WRONG_PASSWORD,
    });
    expect(wrong.status, detail(wrong)).toBe(403);
    expect(await clearancesOf(w.flagId), "no proposal").toHaveLength(0);
    expect(await grantCount(), "no grant").toBe(grantsBefore);

    // Control: with the password the proposal is accepted; then the approve side.
    const clearanceId = await proposed(w.flagId);
    const approveNoPassword = await approveHttp(approverA, clearanceId, {});
    expect(approveNoPassword.status, detail(approveNoPassword)).toBe(401);
    const approveWrong = await approveHttp(approverA, clearanceId, {
      password: WRONG_PASSWORD,
    });
    expect(approveWrong.status, detail(approveWrong)).toBe(403);
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
    await expectHeld(w.runId, "refused approvals do not release");
  });

  it("[990-A-3-expired-grant] a propose grant past its validity is refused with PAYOUT-70 and stays unspent; no proposal", async () => {
    const w = await flaggedWorld();
    const grant = await issueGrant({
      step: "propose",
      userId: proposer.userId,
      batchId: w.batchId,
      refId: w.flagId,
      detail: sha256(REASON),
    });
    expect(grant.grant, `grant: ${grant.message}`).toBeTruthy();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE ${GRANTS}
              SET issued_at = now() - interval '10 minutes',
                  expires_at = now() - interval '8 minutes'
            WHERE secret_sha256 = $1`,
          [grantSecretHash(grant.grant!)],
        ),
      true,
    );
    const out = await appCall(PROPOSE_SQL, [w.flagId, grant.grant!, REASON]);
    expect(out.code, out.message).toBe(PRIVILEGE);
    expect(out.message).toMatch(/PAYOUT-70/);
    expect(await clearancesOf(w.flagId)).toHaveLength(0);
    await expectHeld(w.runId, "expired grant does not release");
  });

  it("[990-A-3-wrong-grant] a grant bound to another reason, another flag or the other step is refused with PAYOUT-70; no proposal", async () => {
    const w = await flaggedWorld();
    const other = await flaggedWorld();
    const variants: [string, Awaited<ReturnType<typeof issueGrant>>][] = [
      [
        "another reason",
        await issueGrant({
          step: "propose",
          userId: proposer.userId,
          batchId: w.batchId,
          refId: w.flagId,
          detail: sha256(OTHER_REASON),
        }),
      ],
      [
        "another flag",
        await issueGrant({
          step: "propose",
          userId: proposer.userId,
          batchId: other.batchId,
          refId: other.flagId,
          detail: sha256(REASON),
        }),
      ],
      [
        "the approve step",
        await issueGrant({
          step: "approve",
          userId: proposer.userId,
          batchId: w.batchId,
          refId: w.flagId,
          detail: sha256(REASON),
        }),
      ],
    ];
    for (const [label, grant] of variants) {
      // The approve-step grant may already be refused at issue (it needs a
      // clearance): then there is nothing to spend, which is also a refusal.
      if (!grant.grant) {
        expect(label, `${grant.message}`).toBe("the approve step");
        continue;
      }
      const out = await appCall(PROPOSE_SQL, [w.flagId, grant.grant, REASON]);
      expect(out.code, `${label}: ${out.message}`).toBe(PRIVILEGE);
      expect(out.message, label).toMatch(/PAYOUT-70/);
    }
    expect(await clearancesOf(w.flagId)).toHaveLength(0);
    expect(await clearancesOf(other.flagId)).toHaveLength(0);
    await expectHeld(w.runId, "wrong grants do not release");

    // Control: the grant that matches the call is accepted.
    const good = await issueGrant({
      step: "propose",
      userId: proposer.userId,
      batchId: w.batchId,
      refId: w.flagId,
      detail: sha256(REASON),
    });
    expect(good.grant, `matching grant: ${good.message}`).toBeTruthy();
    const ok = await appCall(PROPOSE_SQL, [w.flagId, good.grant!, REASON]);
    expect(ok.code, ok.message).toBeUndefined();
  });
});

// =========================================================================
// A4: two approvals at the same moment
// =========================================================================

describe("990 A: concurrent approvals", () => {
  it("[990-A-4-concurrent-approve] two different finance people approve the same clearance at the same moment: exactly one 200, the other 409; one approver on record; the slip is released once", async () => {
    const w = await flaggedWorld();
    const clearanceId = await proposed(w.flagId);

    const results = await Promise.all([
      approveHttp(approverA, clearanceId),
      approveHttp(approverB, clearanceId),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses, results.map(detail).join(" | ")).toEqual([200, 409]);

    const rows = await clearancesOf(w.flagId);
    expect(rows).toHaveLength(1);
    const winner = results[0]!.status === 200 ? approverA : approverB;
    expect(rows[0]!.approved_by).toBe(winner.userId);
    await expectReleased(w.runId, "released once");
  });
});

// =========================================================================
// A5: the app role cannot write the table
// =========================================================================

describe("990 A: the clearance table is written only by the trusted functions", () => {
  it("[990-A-5-app-cannot-write] legend_app cannot INSERT, UPDATE or DELETE payroll_payout_recon_clearances (42501); the proposal is unchanged and the slip stays held", async () => {
    const w = await flaggedWorld();
    const second = await flaggedWorld();
    const clearanceId = await proposed(w.flagId);
    const [real] = await clearancesOf(w.flagId);
    expect(real, "premise: a real proposal exists").toBeDefined();
    const before = JSON.stringify(real);
    const total = await clearanceCount();

    // INSERT of an already approved clearance for the second flag.
    const insert = await appCall(
      `INSERT INTO ${CLEARANCE_TABLE}
         (tenant_id, exception_id, reason, proposed_by, proposed_session_id, proposed_grant_id,
          approved_by, approved_session_id, approved_grant_id, approved_at)
       VALUES ($1, $2, $3, $4, 'forged-session', $5, $6, 'forged-session-2', $5, now())`,
      [
        W.tenantId,
        second.flagId,
        REASON,
        proposer.userId,
        real!.proposed_grant_id,
        approverA.userId,
      ],
    );
    expect(insert.code, `INSERT: ${insert.message}`).toBe(PRIVILEGE);

    // UPDATE that would approve (or rewrite) the real proposal.
    const approve = await appCall(
      `UPDATE ${CLEARANCE_TABLE}
          SET approved_by = $3, approved_session_id = 'forged-session',
              approved_grant_id = proposed_grant_id, approved_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, clearanceId, approverA.userId],
    );
    expect(approve.code, `UPDATE approve: ${approve.message}`).toBe(PRIVILEGE);
    const rewrite = await appCall(
      `UPDATE ${CLEARANCE_TABLE} SET reason = $3 WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, clearanceId, OTHER_REASON],
    );
    expect(rewrite.code, `UPDATE reason: ${rewrite.message}`).toBe(PRIVILEGE);

    const del = await appCall(
      `DELETE FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, clearanceId],
    );
    expect(del.code, `DELETE: ${del.message}`).toBe(PRIVILEGE);

    expect(JSON.stringify((await clearancesOf(w.flagId))[0])).toBe(before);
    expect(await clearanceCount(), "no row added or removed").toBe(total);
    expect(await clearancesOf(second.flagId)).toHaveLength(0);
    await expectHeld(w.runId, "forged writes do not release the first slip");
    await expectHeld(second.runId, "nor the second");
  });
});

// =========================================================================
// A6: another tenant
// =========================================================================

describe("990 A: flags of another tenant", () => {
  it("[990-A-6-foreign-flag-untouched] a flag of another tenant is not found (404) for propose and cannot be proposed in SQL; it is not listed and its row is unchanged; no clearance for it", async () => {
    const mine = await flaggedWorld();
    const foreignTenant = randomUUID();
    const foreignFlag = randomUUID();
    foreignTenants.push(foreignTenant);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 990 tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `payout-990-${foreignTenant.slice(0, 8)}`, W.tenantId],
      );
      // A flag of that tenant: a copy of mine under the other tenant (FKs are off in this fixture).
      await c.query(
        `CREATE TEMP TABLE flag990_copy ON COMMIT DROP AS
           SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, mine.flagId],
      );
      await c.query(`UPDATE flag990_copy SET id = $1, tenant_id = $2`, [
        foreignFlag,
        foreignTenant,
      ]);
      await c.query(`INSERT INTO ${EXCEPTIONS} SELECT * FROM flag990_copy`);
    }, true);
    const rowOf = async () =>
      JSON.stringify(
        (
          await W.rowsOf(`SELECT * FROM ${EXCEPTIONS} WHERE id = $1`, [
            foreignFlag,
          ])
        )[0],
      );
    const rowBefore = await rowOf();
    expect(rowBefore, "premise: the foreign flag exists").not.toBe(undefined);

    const list = await listFlagsHttp(proposer);
    expect(list.status, detail(list)).toBe(200);
    expect(detail(list), "my own flag is listed").toContain(mine.flagId);
    expect(detail(list), "the other tenant's flag is not listed").not.toContain(
      foreignFlag,
    );

    const res = await proposeHttp(proposer, foreignFlag);
    expect(res.status, detail(res)).toBe(404);

    const grant = await issueGrant({
      step: "propose",
      userId: proposer.userId,
      batchId: mine.batchId,
      refId: foreignFlag,
      detail: sha256(REASON),
    });
    if (grant.grant) {
      const out = await appCall(PROPOSE_SQL, [
        foreignFlag,
        grant.grant,
        REASON,
      ]);
      expect(out.code, "a foreign flag cannot be proposed").toBeDefined();
    }
    const rows = await W.rowsOf(
      `SELECT count(*)::int AS n FROM ${CLEARANCE_TABLE} WHERE exception_id = $1`,
      [foreignFlag],
    );
    expect(Number(rows[0]!.n), "no clearance for the foreign flag").toBe(0);
    expect(await rowOf(), "the foreign flag is unchanged").toBe(rowBefore);

    // Control: my own flag clears normally.
    const own = await proposeHttp(proposer, mine.flagId);
    expect(own.status, detail(own)).toBe(201);
  });
});

// =========================================================================
// A7 and A8: re-running the recon, proposal alone
// =========================================================================

describe("990 A: a cleared key is not flagged again; a proposal alone still holds", () => {
  it("[990-A-7-recon-rerun-after-clear] after the two-person clearance, flagging the same key again and a full night run add no flag and do not hold the slip again", async () => {
    const w = await flaggedWorld();
    const clearanceId = await proposed(w.flagId);
    const approved = await approveHttp(approverA, clearanceId);
    expect(approved.status, detail(approved)).toBe(200);

    // The same key again (what the night run does for a difference it already saw).
    await flagCall(w.itemId, w.operation);
    await runRecon();
    expect(
      await exceptionRows(w.itemId),
      "no second flag for the cleared key",
    ).toHaveLength(1);
    await expectReleased(w.runId, "the cleared slip stays free");
  });

  it("[990-A-8-proposal-alone-holds] a proposal without approval keeps holding the payslip, also after the recon runs again", async () => {
    const w = await flaggedWorld();
    await proposed(w.flagId);
    await expectHeld(w.runId, "proposed only");
    await runRecon();
    await expectHeld(w.runId, "proposed only, after the recon");
    expect((await clearancesOf(w.flagId))[0]!.approved_by).toBeNull();
  });
});
