// Payout 1005 (bead legend-snwnn): two people withdraw an OPEN bank-return claim.
// Written fail-first from docs/briefs/1005/design.md ("Keputusan desain", "Kode
// error", "Fungsi SQL", "API", "Test"), NOT from the implementation. The recon
// side is in payroll-payout-1005-return-withdraw-recon.test.ts.
//
// Rules proven (founder: nobody is paid twice or on one person's word; when in
// doubt limit the payment; tenants never touch each other):
// - One person proposes (reason 10-500 chars), a DIFFERENT person (and session)
//   approves, each with the account password: the claim goes open -> withdrawn,
//   the item stays `succeeded` and its return columns are emptied. No journal,
//   posting, batch, item or attestation row is changed or added by the withdraw
//   itself; the claim and withdrawal rows stay (audit).
// - A consumed claim (item `returned`, journal posted) is terminal: never
//   withdrawable. A withdrawn claim cannot be confirmed.
// - The proof of a withdrawn claim stays burnt: re-filing needs a NEW proof file;
//   the same bank reference may be used again (a withdrawn claim moved no money).
// - No automatic re-payment: nothing but the return columns moves.
//
// Assumptions (the design leaves them open, stated so they can be contested):
// - HTTP statuses follow the recon-clearance mapping of docs/briefs/990/i2-contract.md:
//   PAYOUT-92 reason length 422, PAYOUT-93 not withdrawable 409, PAYOUT-94
//   proposer/session approving 403, PAYOUT-95 already approved 409, PAYOUT-64
//   batch requester 403, PAYOUT-69 other tenant / unknown id 404, no password
//   401, wrong password 403, a person without tenant-wide owner/finance role 403.
//   A step that completes answers 200 or 201. Response bodies are not parsed:
//   ids are read back from the tables.
// - SQL signatures: app.payout_return_withdraw_propose(claim uuid, grant text,
//   reason text) RETURNS uuid; app.payout_return_withdraw_approve(withdrawal
//   uuid, grant text) RETURNS integer. Grant kind `return_withdraw`, batch =
//   claim batch, ref = claim id (propose) or withdrawal id (approve), detail =
//   sha256 hex of the reason, method password. Exact messages are asserted only
//   in SQL ("PAYOUT-92".."PAYOUT-95", "PAYOUT-64", "PAYOUT-69"); a refusal may
//   come at the grant issue or at the call.
// - Tables: payroll_payout_return_withdrawals(id, tenant_id, claim_id, batch_id,
//   reason, proposed_by, approved_by, approved_at ...); the claim gets status
//   `withdrawn` and `withdrawn_at`; claims use status `open` / `consumed`.
// - "Same session of another user" cannot be a real session (a session belongs
//   to one user), so it is covered by "a grant of another user carrying the
//   proposer's session is refused" (any refusal, nothing approved).
// - The list route answers 200 and mentions the claim id and its status
//   `withdrawn` in the body (shape of the rows is not fixed).
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  ANDI,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1005wd");
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const NOTE = "Bank mengembalikan dana, rekening tujuan ditutup";
const REASON = "Klaim salah input, uang tidak pernah kembali dari bank";
const OTHER_REASON =
  "Alasan lain yang diajukan orang kedua, bukan yang pertama";
const NET = 1_000_000;
const API = "/api/hris/payroll";
const BATCHES = `${API}/disbursement-batches`;
const CLAIM_ROUTE = `${API}/payout-return-claims`;
const WITHDRAWAL_ROUTE = `${API}/payout-return-withdrawals`;
const CLAIMS = "payroll_payout_return_claims";
const WITHDRAWALS = "payroll_payout_return_withdrawals";
const GRANTS = "payroll_payout_grants";
const ATTESTATIONS = "payroll_payout_attestations";
const PRIVILEGE = "42501";
const RETURN_COLUMNS = [
  "returned_by",
  "return_evidence_key",
  "return_note",
  "return_claim_id",
  "return_bank_ref",
] as const;
const returnKey = (itemId: string) => `payroll-payout-return:${itemId}`;
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const foreignTenants: string[] = [];
const allItemIds: string[] = [];
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
    [W.tenantId, `Template ${key} 1005wd`, key],
  );
  return (await read()).rows[0]!.id;
}

/** Signed-in person with TOTP enrolled in this session; `template` = tenant-wide owner/finance role, `approve` = payroll.disburse.approve. */
async function makePerson(
  label: string,
  template: "owner" | "finance" | null,
  approve = true,
) {
  const { client, userId } = await W.signedInClient(`Withdraw1005 ${label}`);
  personIds.push(userId);
  await W.grantRole(
    userId,
    approve ? ["payroll.view", "payroll.disburse.approve"] : ["payroll.view"],
  );
  if (template) {
    const roleId = await templateRoleId(template);
    await W.owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [W.tenantId, userId, roleId],
    );
  }
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

let c1: Person; // files the return claim (step 1) and re-files it
let c2: Person; // confirms the return claim (step 2)
let prop: Person; // proposes withdrawals
let apA: Person; // approves withdrawals
let apB: Person; // second approver
let requester: Person; // requester of the batch of the requester world

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  c1 = await makePerson("Claim One", "finance");
  c2 = await makePerson("Claim Two", "finance");
  prop = await makePerson("Proposer", "owner");
  apA = await makePerson("Approver A", "finance");
  apB = await makePerson("Approver B", "owner");
  requester = await makePerson("Requester", "finance");
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    for (const id of foreignTenants.splice(0)) {
      await c.query(`DELETE FROM ${WITHDRAWALS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM ${CLAIMS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
  }, true);
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    if (allItemIds.length > 0)
      await c.query(
        `DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1 AND item_ids && $2::uuid[]`,
        [W.tenantId, allItemIds],
      );
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [W.tenantId, personIds],
    );
  }, true).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- HTTP ----------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const ok = (res: Res) => [200, 201].includes(res.status);

const returnHttp = (
  who: Person,
  batchId: string,
  itemId: string,
  evidenceKey: string,
  bankRef: string,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/return`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      evidenceKey,
      note: NOTE,
      password: PASSWORD,
      bankRef,
    }) as unknown as Promise<Res>;
const proposeHttp = (
  who: Person,
  claimId: string,
  body: Record<string, unknown> = { reason: REASON, password: PASSWORD },
) =>
  who.client
    .post(`${CLAIM_ROUTE}/${claimId}/withdrawal`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const approveHttp = (
  who: Person,
  withdrawalId: string,
  body: Record<string, unknown> = { password: PASSWORD },
) =>
  who.client
    .post(`${WITHDRAWAL_ROUTE}/${withdrawalId}/approve`)
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;
const listClaimsHttp = (who: Person, batchId: string) =>
  who.client.get(
    `${BATCHES}/${batchId}/return-claims`,
  ) as unknown as Promise<Res>;

// ---- Raw SQL (legend_app, grantor stand-in) ------------------------------------------------

type Outcome = { code: string | undefined; message: string; rows: Row[] };

async function callAs(
  role: "legend_app" | "legend_payout",
  sql: string,
  params: unknown[] = [],
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
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
const appCall = (sql: string, params: unknown[] = []) =>
  callAs("legend_app", sql, params);
const payoutCall = (sql: string, params: unknown[] = []) =>
  callAs("legend_payout", sql, params);

/** A return_withdraw grant of the grantor stand-in (method password). */
async function issueGrant(input: {
  step: "propose" | "approve";
  userId: string;
  /** Session to bind; default the session of `userId`. */
  sessionOf?: string;
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
          "return_withdraw",
          input.step,
          input.batchId,
          "{}",
          null,
          input.refId,
          null,
          input.detail,
          input.userId,
          actorOf(input.sessionOf ?? input.userId).sessionId,
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

const PROPOSE_SQL = `SELECT app.payout_return_withdraw_propose($1::uuid, $2::text, $3::text) AS id`;
const APPROVE_SQL = `SELECT app.payout_return_withdraw_approve($1::uuid, $2::text) AS restored`;

/** Propose in SQL as `who`; returns the outcome of the call (grant included). */
async function proposeSql(who: Person, claim: Claim, reason = REASON) {
  const grant = await issueGrant({
    step: "propose",
    userId: who.userId,
    batchId: claim.batchId,
    refId: claim.claimId,
    detail: sha256(reason),
  });
  if (!grant.grant) return { grantMessage: grant.message } as const;
  return appCall(PROPOSE_SQL, [claim.claimId, grant.grant, reason]);
}

// ---- Worlds --------------------------------------------------------------------------------

const freshKey = (batchId: string) =>
  uploadEvidence(batchId, `return-${randomUUID()}.pdf`);
const freshRef = () => `BCA-RET-${randomUUID().slice(0, 8).toUpperCase()}`;

/** Items paid in one batch (confirmed), in the order of the slips (BUDI, SITI, ANDI). */
async function paidBatch(count: 2 | 3) {
  const slips = [bank(BUDI, NET), bank(SITI, NET), bank(ANDI, NET)].slice(
    0,
    count,
  );
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  const itemOf = async (p: typeof BUDI) =>
    (await W.itemOfPerson(batchId, p)).id as string;
  const world = {
    runId,
    batchId,
    a: await itemOf(BUDI),
    b: await itemOf(SITI),
    c: count === 3 ? await itemOf(ANDI) : "",
  };
  allItemIds.push(world.a, world.b, ...(world.c ? [world.c] : []));
  return world;
}

/** Like paidBatch(2), but the batch was REQUESTED by the real person `requester`. */
async function paidBatchOfRequester() {
  const slips = [bank(BUDI, NET), bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batch = await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const batchId = batch.id;
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
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId: source!.id as string,
    } as never),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  const a = (await W.itemOfPerson(batchId, BUDI)).id as string;
  allItemIds.push(a);
  return { runId, batchId, a };
}

type Claim = {
  key: string;
  ref: string;
  claimId: string;
  batchId: string;
  itemId: string;
};

const claimRow = async (claimId: string) =>
  (
    await W.rowsOf(`SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND id = $2`, [
      W.tenantId,
      claimId,
    ])
  )[0]!;
const claimsOfKey = (key: string) =>
  W.rowsOf(
    `SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
const openClaimsOfBatch = (batchId: string) =>
  W.rowsOf(
    `SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND batch_id = $2 AND status = 'open'`,
    [W.tenantId, batchId],
  );
const itemRow = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT * FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const withdrawalsOf = (claimId: string) =>
  W.rowsOf(
    `SELECT * FROM ${WITHDRAWALS} WHERE tenant_id = $1 AND claim_id = $2 ORDER BY proposed_at, id`,
    [W.tenantId, claimId],
  );
const grantCount = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM ${GRANTS} WHERE tenant_id = $1 AND kind = 'return_withdraw'`,
        [W.tenantId],
      )
    )[0]!.n,
  );

/** Step 1 of a return: an OPEN claim over item `itemId`. */
async function openClaim(
  batchId: string,
  itemId: string,
  ref = freshRef(),
  first = c1,
): Promise<Claim> {
  const key = freshKey(batchId);
  const res = await returnHttp(first, batchId, itemId, key, ref);
  expect(ok(res), `premise: step 1 ${detail(res)}`).toBe(true);
  const [claim] = await claimsOfKey(key);
  expect(claim, "premise: the claim is on record").toBeDefined();
  expect(claim!.status, "premise: open").toBe("open");
  return { key, ref, claimId: claim!.id as string, batchId, itemId };
}
/** Step 2 of a return (another person): the claim is consumed, the item returned, one journal. */
async function confirmClaim(claim: Claim, who = c2) {
  const res = await returnHttp(
    who,
    claim.batchId,
    claim.itemId,
    claim.key,
    claim.ref,
  );
  expect(ok(res), `premise: step 2 ${detail(res)}`).toBe(true);
  expect((await itemRow(claim.itemId)).status, "premise: returned").toBe(
    "returned",
  );
}
/** A proposal over HTTP; returns the withdrawal id read from the table. */
async function proposed(claim: Claim, who = prop) {
  const res = await proposeHttp(who, claim.claimId);
  expect(ok(res), `premise: propose ${detail(res)}`).toBe(true);
  const rows = await withdrawalsOf(claim.claimId);
  expect(rows, "premise: one withdrawal on record").toHaveLength(1);
  return rows[0]!.id as string;
}
/** Propose + approve over HTTP by two different people. */
async function withdrawn(claim: Claim) {
  const id = await proposed(claim);
  const res = await approveHttp(apA, id);
  expect(ok(res), `premise: approve ${detail(res)}`).toBe(true);
  expect((await claimRow(claim.claimId)).status, "premise: withdrawn").toBe(
    "withdrawn",
  );
  return id;
}

// ---- Observations --------------------------------------------------------------------------

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const without = (row: Row, keys: readonly string[]) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))),
  );
const attestationsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${ATTESTATIONS}
      WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids) ORDER BY attested_at, id`,
    [W.tenantId, itemId],
  );
const proofOf = async (key: string) =>
  JSON.stringify({
    files: await W.rowsOf(
      `SELECT * FROM payroll_payout_evidence_files WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    ),
    bindings: await W.rowsOf(
      `SELECT * FROM payroll_payout_proof_bindings WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    ),
  });

/** What a withdraw must never move. The return columns of the item are left out. */
async function moneyOf(w: { runId: string; batchId: string; itemId: string }) {
  return {
    item: without(await itemRow(w.itemId), [...RETURN_COLUMNS, "updated_at"]),
    postings: JSON.stringify(await W.postingsOf(w.batchId)),
    journals: await count(
      `SELECT count(*)::int AS n FROM journal_entries
        WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
      [W.tenantId],
    ),
    items: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, w.runId],
    ),
    batches: await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_batches
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, w.runId],
    ),
    run: JSON.stringify(await W.runRow(w.runId)),
  };
}

async function expectNoReturnColumns(itemId: string, label: string) {
  const item = await itemRow(itemId);
  for (const column of RETURN_COLUMNS)
    expect(item[column], `${label}: ${column} is empty`).toBeNull();
}

// =========================================================================
// 1: two people withdraw an open claim
// =========================================================================

describe("1005: an open return claim is withdrawn by two people", () => {
  it("[1005-withdraw-1-two-people] one proposes, another approves, both with the password: the claim is withdrawn, the item stays succeeded with its return columns empty; no journal, posting, batch, item or old attestation changes; claim and withdrawal rows stay", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const claimBefore = await claimRow(claim.claimId);
    const proofBefore = await proofOf(claim.key);
    const money = await moneyOf({ ...w, itemId: w.a });
    const attestBefore = (await attestationsOf(w.a)).map((r) =>
      JSON.stringify(r),
    );
    expect(attestBefore.length, "premise: step 1 is attested").toBeGreaterThan(
      0,
    );

    const id = await proposed(claim);
    const [proposal] = await withdrawalsOf(claim.claimId);
    expect(proposal!.proposed_by).toBe(prop.userId);
    expect(proposal!.reason).toBe(REASON);
    expect(proposal!.approved_by, "not approved yet").toBeNull();
    expect(
      (await claimRow(claim.claimId)).status,
      "a proposal alone changes nothing",
    ).toBe("open");
    expect((await itemRow(w.a)).return_claim_id).toBe(claim.claimId);

    const approved = await approveHttp(apA, id);
    expect(ok(approved), detail(approved)).toBe(true);

    const [done] = await withdrawalsOf(claim.claimId);
    expect(done!.approved_by).toBe(apA.userId);
    expect(done!.approved_by).not.toBe(done!.proposed_by);
    expect(done!.approved_at).not.toBeNull();
    expect(await withdrawalsOf(claim.claimId), "the row stays").toHaveLength(1);

    const claimAfter = await claimRow(claim.claimId);
    expect(claimAfter.status).toBe("withdrawn");
    expect(claimAfter.withdrawn_at).not.toBeNull();
    expect(
      without(claimAfter, ["status", "withdrawn_at", "updated_at"]),
      "the claim row keeps everything else (audit)",
    ).toBe(without(claimBefore, ["status", "withdrawn_at", "updated_at"]));

    const item = await itemRow(w.a);
    expect(item.status, "back to the status before the claim").toBe(
      "succeeded",
    );
    await expectNoReturnColumns(w.a, "after the withdraw");
    expect(item.returned_by_2).toBeNull();
    expect(await moneyOf({ ...w, itemId: w.a }), "no money moves").toEqual(
      money,
    );
    expect(await W.countJournals(returnKey(w.a)), "no return journal").toBe(0);
    expect(await proofOf(claim.key), "the proof stays burnt").toBe(proofBefore);
    const attestAfter = (await attestationsOf(w.a)).map((r) =>
      JSON.stringify(r),
    );
    for (const row of attestBefore)
      expect(attestAfter, "an old attestation is unchanged").toContain(row);

    // The other item of the batch was never touched.
    expect((await itemRow(w.b)).status).toBe("succeeded");
  });

  it("[1005-withdraw-1-sql-flow] the same flow in SQL as legend_app: propose returns a withdrawal id, approve by another person returns the number of items restored (1)", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);

    const proposal = await proposeSql(prop, claim);
    expect("grantMessage" in proposal ? proposal.grantMessage : "").toBe("");
    const out = proposal as Outcome;
    expect(out.code, out.message).toBeUndefined();
    const withdrawalId = out.rows[0]!.id as string;
    expect((await claimRow(claim.claimId)).status).toBe("open");

    const grant = await issueGrant({
      step: "approve",
      userId: apA.userId,
      batchId: claim.batchId,
      refId: withdrawalId,
      detail: sha256(REASON),
    });
    expect(grant.grant, `approve grant: ${grant.message}`).toBeTruthy();
    const approval = await appCall(APPROVE_SQL, [withdrawalId, grant.grant!]);
    expect(approval.code, approval.message).toBeUndefined();
    expect(Number(approval.rows[0]!.restored), "items restored").toBe(1);
    expect((await claimRow(claim.claimId)).status).toBe("withdrawn");
    expect((await itemRow(w.a)).status).toBe("succeeded");
    await expectNoReturnColumns(w.a, "after the SQL withdraw");
  });

  it("[1005-withdraw-1-propose-idempotent] a second proposal for the same claim while one is open returns the same withdrawal; the first reason stays; one row", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);

    const again = await proposeHttp(apB, claim.claimId, {
      reason: OTHER_REASON,
      password: PASSWORD,
    });
    expect(ok(again), detail(again)).toBe(true);
    const rows = await withdrawalsOf(claim.claimId);
    expect(rows, "still one withdrawal").toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.reason, "the first reason stays").toBe(REASON);
    expect(rows[0]!.proposed_by).toBe(prop.userId);
  });

  it("[1005-withdraw-1-list-claims] the batch lists its return claims with their status; a withdrawn one shows as withdrawn", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const before = await listClaimsHttp(prop, w.batchId);
    expect(before.status, detail(before)).toBe(200);
    expect(detail(before), "the open claim is listed").toContain(claim.claimId);
    await withdrawn(claim);
    const after = await listClaimsHttp(prop, w.batchId);
    expect(after.status, detail(after)).toBe(200);
    expect(detail(after)).toContain(claim.claimId);
    expect(detail(after), "the status is shown").toContain("withdrawn");
  });
});

// =========================================================================
// 2: nobody withdraws alone
// =========================================================================

describe("1005: the proposer cannot approve", () => {
  it("[1005-withdraw-2-self-approve-api] the proposer approving over HTTP is refused 403 (PAYOUT-94); the claim stays open and the item keeps its return columns; another person can still approve", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);

    const res = await approveHttp(prop, id);
    expect(res.status, detail(res)).toBe(403);
    expect((await withdrawalsOf(claim.claimId))[0]!.approved_by).toBeNull();
    expect((await claimRow(claim.claimId)).status).toBe("open");
    expect((await itemRow(w.a)).return_claim_id).toBe(claim.claimId);

    const control = await approveHttp(apA, id);
    expect(ok(control), detail(control)).toBe(true);
  });

  it("[1005-withdraw-2-self-approve-sql] the proposer approving in SQL gives PAYOUT-94 (at the grant or at the call); a grant of another user that carries the proposer's session is refused too; nothing is approved", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const proposal = (await proposeSql(prop, claim)) as Outcome;
    expect(proposal.code, `premise: ${proposal.message}`).toBeUndefined();
    const withdrawalId = proposal.rows[0]!.id as string;

    const self = await issueGrant({
      step: "approve",
      userId: prop.userId,
      batchId: claim.batchId,
      refId: withdrawalId,
      detail: sha256(REASON),
    });
    if (self.grant) {
      const out = await appCall(APPROVE_SQL, [withdrawalId, self.grant]);
      expect(out.code, "self-approval must be refused").toBeDefined();
      expect(out.message).toMatch(/PAYOUT-94/);
    } else {
      expect(self.message).toMatch(/PAYOUT-94/);
    }

    const borrowed = await issueGrant({
      step: "approve",
      userId: apA.userId,
      sessionOf: prop.userId,
      batchId: claim.batchId,
      refId: withdrawalId,
      detail: sha256(REASON),
    });
    if (borrowed.grant) {
      const out = await appCall(APPROVE_SQL, [withdrawalId, borrowed.grant]);
      expect(out.code, "the proposer's session must not approve").toBeDefined();
    } else {
      expect(borrowed.message, "refused at the grant").not.toBe("");
    }

    expect((await withdrawalsOf(claim.claimId))[0]!.approved_by).toBeNull();
    expect((await claimRow(claim.claimId)).status).toBe("open");
  });

  it("[1005-withdraw-2-approved-twice] an approved withdrawal cannot be approved again (PAYOUT-95: 409 over HTTP, PAYOUT-95 in SQL); a new proposal for the withdrawn claim is refused 409; the first approver stays", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await withdrawn(claim);

    const second = await approveHttp(apB, id);
    expect(second.status, detail(second)).toBe(409);

    const grant = await issueGrant({
      step: "approve",
      userId: apB.userId,
      batchId: claim.batchId,
      refId: id,
      detail: sha256(REASON),
    });
    if (grant.grant) {
      const out = await appCall(APPROVE_SQL, [id, grant.grant]);
      expect(out.message).toMatch(/PAYOUT-95/);
    } else {
      expect(grant.message).toMatch(/PAYOUT-95/);
    }

    const again = await proposeHttp(prop, claim.claimId);
    expect(again.status, detail(again)).toBe(409);
    const rows = await withdrawalsOf(claim.claimId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approved_by).toBe(apA.userId);
  });

  it("[1005-withdraw-2-concurrent-approve] two different people approve the same withdrawal at the same moment: exactly one succeeds, the other is 409; one approver on record", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);

    const results = await Promise.all([
      approveHttp(apA, id),
      approveHttp(apB, id),
    ]);
    expect(results.filter(ok).length, results.map(detail).join(" | ")).toBe(1);
    expect(
      results.filter((r) => r.status === 409).length,
      results.map(detail).join(" | "),
    ).toBe(1);
    const [row] = await withdrawalsOf(claim.claimId);
    expect(row!.approved_by).toBe(ok(results[0]!) ? apA.userId : apB.userId);
    expect((await claimRow(claim.claimId)).status).toBe("withdrawn");
    expect((await itemRow(w.a)).status).toBe("succeeded");
  });
});

// =========================================================================
// 3: password, role, reason, requester
// =========================================================================

describe("1005: password, role, reason and requester rules", () => {
  it("[1005-withdraw-3-password-each-step] propose and approve without the password are refused 401, with a wrong password 403; nothing is recorded, no grant", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const grantsBefore = await grantCount();

    const none = await proposeHttp(prop, claim.claimId, { reason: REASON });
    expect(none.status, detail(none)).toBe(401);
    const wrong = await proposeHttp(prop, claim.claimId, {
      reason: REASON,
      password: WRONG_PASSWORD,
    });
    expect(wrong.status, detail(wrong)).toBe(403);
    expect(await withdrawalsOf(claim.claimId), "no proposal").toHaveLength(0);
    expect(await grantCount(), "no grant").toBe(grantsBefore);

    const id = await proposed(claim);
    const approveNone = await approveHttp(apA, id, {});
    expect(approveNone.status, detail(approveNone)).toBe(401);
    const approveWrong = await approveHttp(apA, id, {
      password: WRONG_PASSWORD,
    });
    expect(approveWrong.status, detail(approveWrong)).toBe(403);
    expect((await withdrawalsOf(claim.claimId))[0]!.approved_by).toBeNull();
    expect((await claimRow(claim.claimId)).status).toBe("open");
    await expectNoReturnColumns(w.b, "other item");
    expect((await itemRow(w.a)).return_claim_id).toBe(claim.claimId);
  });

  it("[1005-withdraw-3-role-required] a person with payroll.disburse.approve but no tenant-wide owner or finance role, and a person with neither that role nor the permission, cannot propose; no withdrawal", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const plain = await makePerson("Plain", null);
    // The finance/owner template carries payroll.disburse.approve itself, so "finance without
    // the permission" cannot exist; this person has neither the role nor the permission.
    const noPermission = await makePerson("NoPermission", null, false);
    for (const [label, who] of [
      ["no owner/finance role", plain],
      ["no role and no approve permission", noPermission],
    ] as const) {
      const res = await proposeHttp(who, claim.claimId);
      expect(res.status, `${label}: ${detail(res)}`).toBe(403);
    }
    expect(await withdrawalsOf(claim.claimId)).toHaveLength(0);
    expect((await claimRow(claim.claimId)).status).toBe("open");
  });

  it("[1005-withdraw-3-reason-length] a reason of 9 or 501 characters is refused (HTTP 422, SQL PAYOUT-92); a reason of 10 and one of 500 are accepted", async () => {
    const w = await paidBatch(3);
    const claim = await openClaim(w.batchId, w.a);
    for (const reason of ["x".repeat(9), "x".repeat(501)]) {
      const res = await proposeHttp(prop, claim.claimId, {
        reason,
        password: PASSWORD,
      });
      expect(res.status, `${reason.length} chars: ${detail(res)}`).toBe(422);
      const sql = await proposeSql(prop, claim, reason);
      const message =
        "grantMessage" in sql ? sql.grantMessage : (sql as Outcome).message;
      expect(message, `${reason.length} chars in SQL`).toMatch(/PAYOUT-92/);
    }
    expect(await withdrawalsOf(claim.claimId), "no proposal").toHaveLength(0);

    for (const [item, reason] of [
      [w.b, "y".repeat(10)],
      [w.c, "z".repeat(500)],
    ] as const) {
      const other = await openClaim(w.batchId, item);
      const res = await proposeHttp(prop, other.claimId, {
        reason,
        password: PASSWORD,
      });
      expect(ok(res), `${reason.length} chars: ${detail(res)}`).toBe(true);
    }
  });

  it("[1005-withdraw-3-requester-refused] the requester of the batch can neither propose (403, PAYOUT-64 in SQL) nor approve (403); nothing moves; another person can", async () => {
    const w = await paidBatchOfRequester();
    const claim = await openClaim(w.batchId, w.a);

    const res = await proposeHttp(requester, claim.claimId);
    expect(res.status, detail(res)).toBe(403);
    const sql = await proposeSql(requester, claim);
    const message =
      "grantMessage" in sql ? sql.grantMessage : (sql as Outcome).message;
    expect(message, "SQL propose by the requester").toMatch(/PAYOUT-64/);
    expect(await withdrawalsOf(claim.claimId), "no proposal").toHaveLength(0);

    const id = await proposed(claim);
    const approve = await approveHttp(requester, id);
    expect(approve.status, detail(approve)).toBe(403);
    const grant = await issueGrant({
      step: "approve",
      userId: requester.userId,
      batchId: claim.batchId,
      refId: id,
      detail: sha256(REASON),
    });
    if (grant.grant) {
      const out = await appCall(APPROVE_SQL, [id, grant.grant]);
      expect(out.message, "SQL approve by the requester").toMatch(/PAYOUT-64/);
    } else {
      expect(grant.message).toMatch(/PAYOUT-64/);
    }
    expect((await claimRow(claim.claimId)).status).toBe("open");

    const control = await approveHttp(apA, id);
    expect(ok(control), detail(control)).toBe(true);
  });
});

// =========================================================================
// 4: what can be withdrawn
// =========================================================================

describe("1005: only an open claim can be withdrawn", () => {
  it("[1005-withdraw-4-consumed-terminal] a consumed claim (item returned, journal posted) cannot be withdrawn (PAYOUT-93, 409): item stays returned, one journal, claim stays consumed", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    await confirmClaim(claim);
    const journals = await W.countJournals(returnKey(w.a));
    expect(journals, "premise: the return is journaled once").toBe(1);

    // The proposal itself may already be refused; if it is accepted, the approval must be.
    const res = await proposeHttp(prop, claim.claimId);
    if (ok(res)) {
      const [row] = await withdrawalsOf(claim.claimId);
      const approve = await approveHttp(apA, row!.id as string);
      expect(approve.status, detail(approve)).toBe(409);
    } else {
      expect(res.status, detail(res)).toBe(409);
    }
    expect((await claimRow(claim.claimId)).status).toBe("consumed");
    expect((await itemRow(w.a)).status).toBe("returned");
    expect(await W.countJournals(returnKey(w.a))).toBe(journals);
    expect(
      (await withdrawalsOf(claim.claimId)).filter((r) => r.approved_by),
      "never approved",
    ).toHaveLength(0);

    // SQL: a grant-backed propose of a consumed claim never yields an approved withdrawal.
    const sql = await proposeSql(prop, claim);
    if (!("grantMessage" in sql) && sql.code === undefined) {
      const id = sql.rows[0]!.id as string;
      const grant = await issueGrant({
        step: "approve",
        userId: apA.userId,
        batchId: claim.batchId,
        refId: id,
        detail: sha256(REASON),
      });
      if (grant.grant) {
        const out = await appCall(APPROVE_SQL, [id, grant.grant]);
        expect(out.message).toMatch(/PAYOUT-93/);
      }
    }
    expect((await claimRow(claim.claimId)).status).toBe("consumed");
  });

  it("[1005-withdraw-4-confirmed-after-proposal] a claim confirmed after the proposal but before the approval is consumed; the approval then fails with PAYOUT-93 (409) and changes nothing; first come wins", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);

    await confirmClaim(claim);
    expect((await claimRow(claim.claimId)).status).toBe("consumed");

    const res = await approveHttp(apA, id);
    expect(res.status, detail(res)).toBe(409);
    expect((await withdrawalsOf(claim.claimId))[0]!.approved_by).toBeNull();
    expect((await claimRow(claim.claimId)).status).toBe("consumed");
    const item = await itemRow(w.a);
    expect(item.status).toBe("returned");
    expect(item.return_claim_id, "return columns kept").toBe(claim.claimId);
    expect(await W.countJournals(returnKey(w.a))).toBe(1);
  });

  it("[1005-withdraw-4-approve-at-the-same-time-as-confirm] approve and confirm at the same moment: exactly one wins and the state is consistent (withdrawn: item succeeded, no journal; consumed: item returned, one journal)", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);

    const [approve, confirmStep] = await Promise.all([
      approveHttp(apA, id),
      returnHttp(c2, claim.batchId, claim.itemId, claim.key, claim.ref),
    ]);
    const both = `${detail(approve)} | ${detail(confirmStep)}`;
    expect([approve, confirmStep].filter(ok).length, both).toBe(1);

    const status = (await claimRow(claim.claimId)).status;
    if (ok(approve)) {
      expect(status, both).toBe("withdrawn");
      expect((await itemRow(w.a)).status).toBe("succeeded");
      await expectNoReturnColumns(w.a, "withdrawn side");
      expect(await W.countJournals(returnKey(w.a))).toBe(0);
    } else {
      expect(status, both).toBe("consumed");
      expect((await itemRow(w.a)).status).toBe("returned");
      expect(await W.countJournals(returnKey(w.a))).toBe(1);
    }
  });

  it("[1005-withdraw-4-item-changed] when the item no longer matches the claim (returned_by changed, a second returner, no claim link) the approval is refused with PAYOUT-93 (409) and nothing changes", async () => {
    const w = await paidBatch(3);
    const variants: [string, string, string][] = [
      ["returned_by changed", w.a, `returned_by = 'someone-else'`],
      ["second returner present", w.b, `returned_by_2 = 'second-person'`],
      ["claim link missing", w.c, `return_claim_id = NULL`],
    ];
    for (const [label, itemId, set] of variants) {
      const claim = await openClaim(w.batchId, itemId);
      const id = await proposed(claim);
      await W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_disbursement_items SET ${set} WHERE tenant_id = $1 AND id = $2`,
            [W.tenantId, itemId],
          ),
        true,
      );
      const before = await itemRow(itemId);
      const res = await approveHttp(apA, id);
      expect(res.status, `${label}: ${detail(res)}`).toBe(409);
      expect((await claimRow(claim.claimId)).status, label).toBe("open");
      expect(JSON.stringify(await itemRow(itemId)), label).toBe(
        JSON.stringify(before),
      );
      expect((await withdrawalsOf(claim.claimId))[0]!.approved_by).toBeNull();
    }
  });

  it("[1005-withdraw-4-confirm-twice-and-withdrawn] an item returned once cannot be returned a second time; a withdrawn claim cannot be confirmed with its old proof", async () => {
    const w = await paidBatch(3);

    const done = await openClaim(w.batchId, w.a);
    await confirmClaim(done);
    for (const who of [c1, c2, apA]) {
      const res = await returnHttp(who, done.batchId, w.a, done.key, done.ref);
      expect(ok(res), `second confirmation: ${detail(res)}`).toBe(false);
      const fresh = await returnHttp(
        who,
        done.batchId,
        w.a,
        freshKey(done.batchId),
        freshRef(),
      );
      expect(
        ok(fresh),
        `a new return of a returned item: ${detail(fresh)}`,
      ).toBe(false);
    }
    expect(await W.countJournals(returnKey(w.a)), "one journal").toBe(1);

    const gone = await openClaim(w.batchId, w.b);
    await withdrawn(gone);
    const res = await returnHttp(c2, gone.batchId, w.b, gone.key, gone.ref);
    expect(ok(res), `confirm a withdrawn claim: ${detail(res)}`).toBe(false);
    expect((await claimRow(gone.claimId)).status).toBe("withdrawn");
    expect((await itemRow(w.b)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(w.b))).toBe(0);
  });
});

// =========================================================================
// 5: filing again after a withdraw
// =========================================================================

describe("1005: after a withdraw the return can be filed again, with a new proof", () => {
  it("[1005-withdraw-5-refile-new-ref-new-proof] a new reference and a new proof file open a new claim; confirming it returns the item once with one journal; the withdrawn claim stays withdrawn", async () => {
    const w = await paidBatch(2);
    const old = await openClaim(w.batchId, w.a);
    await withdrawn(old);

    const fresh = await openClaim(w.batchId, w.a);
    expect(fresh.claimId).not.toBe(old.claimId);
    expect((await itemRow(w.a)).return_claim_id).toBe(fresh.claimId);
    await confirmClaim(fresh);

    const item = await itemRow(w.a);
    expect(item.status).toBe("returned");
    expect(item.return_bank_ref).toBe(fresh.ref);
    expect(await W.countJournals(returnKey(w.a)), "one journal").toBe(1);
    expect((await claimRow(old.claimId)).status).toBe("withdrawn");
    expect((await claimRow(fresh.claimId)).status).toBe("consumed");
  });

  it("[1005-withdraw-5-refile-same-ref-new-proof] the SAME bank reference with a new proof file is accepted after the withdraw, but not while the withdrawal is only proposed", async () => {
    const w = await paidBatch(2);
    const old = await openClaim(w.batchId, w.a);
    const id = await proposed(old);

    const early = await returnHttp(
      c2,
      w.batchId,
      w.a,
      freshKey(w.batchId),
      old.ref,
    );
    expect(ok(early), `still held by the open claim: ${detail(early)}`).toBe(
      false,
    );
    expect((await claimRow(old.claimId)).status).toBe("open");

    const approved = await approveHttp(apA, id);
    expect(ok(approved), detail(approved)).toBe(true);
    const again = await openClaim(w.batchId, w.a, old.ref);
    await confirmClaim(again);
    expect((await itemRow(w.a)).return_bank_ref).toBe(old.ref);
    expect(await W.countJournals(returnKey(w.a)), "one journal").toBe(1);
  });

  it("[1005-withdraw-5-old-proof-stays-burnt] the proof file of a withdrawn claim cannot be used again, with the old or a new reference; no new claim appears", async () => {
    const w = await paidBatch(2);
    const old = await openClaim(w.batchId, w.a);
    await withdrawn(old);
    const before = (await claimsOfKey(old.key)).length;

    for (const ref of [old.ref, freshRef()]) {
      const res = await returnHttp(c1, w.batchId, w.a, old.key, ref);
      expect(ok(res), `old proof with ${ref}: ${detail(res)}`).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(
      await claimsOfKey(old.key),
      "no second claim for the old proof",
    ).toHaveLength(before);
    expect(await openClaimsOfBatch(w.batchId), "no open claim").toHaveLength(0);
    expect((await itemRow(w.a)).status).toBe("succeeded");
  });
});

// =========================================================================
// 6: no automatic re-payment
// =========================================================================

describe("1005: a withdraw never pays again", () => {
  it("[1005-withdraw-6-no-repayment] after the withdraw there is no new item, batch or journal, the item stays succeeded, and a follow-up batch does not offer the slip again", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const before = await moneyOf({ ...w, itemId: w.a });
    await withdrawn(claim);

    const after = await moneyOf({ ...w, itemId: w.a });
    expect(after, "nothing but the return columns moved").toEqual(before);
    expect((await itemRow(w.a)).status).toBe("succeeded");

    const items = await count(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND payroll_run_id = $2`,
      [W.tenantId, w.runId],
    );
    await W.httpFailure(W.createBatch(w.runId));
    expect(
      await count(
        `SELECT count(*)::int AS n FROM payroll_disbursement_items
          WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [W.tenantId, w.runId],
      ),
      "a follow-up batch offers no new item for a paid slip",
    ).toBe(items);
    expect(await W.countJournals(returnKey(w.a))).toBe(0);
  });
});

// =========================================================================
// 7: another tenant
// =========================================================================

describe("1005: claims and withdrawals of another tenant", () => {
  it("[1005-withdraw-7-foreign-untouched] propose and approve for another tenant's claim or withdrawal are 404 (PAYOUT-69 in SQL); they are not listed and their rows are unchanged; my own flow still works", async () => {
    const w = await paidBatch(2);
    const mine = await openClaim(w.batchId, w.a);
    const mineWithdrawal = await proposed(mine);

    const foreignTenant = randomUUID();
    foreignTenants.push(foreignTenant);
    const foreignClaim = randomUUID();
    const foreignWithdrawal = randomUUID();
    const hex = () => (randomUUID() + randomUUID()).replace(/-/g, "");
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 1005 tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `payout-1005-${foreignTenant.slice(0, 8)}`, W.tenantId],
      );
      // A claim and a withdrawal of that tenant: copies of mine under the other tenant (FKs are off here).
      await c.query(
        `INSERT INTO ${CLAIMS}
         SELECT (jsonb_populate_record(t, $1::jsonb)).* FROM ${CLAIMS} t WHERE t.id = $2`,
        [
          JSON.stringify({
            id: foreignClaim,
            tenant_id: foreignTenant,
            bank_ref: freshRef(),
            evidence_key: `f1005-${randomUUID()}`,
            content_sha256: hex().slice(0, 64),
            stored_sha256: hex().slice(0, 64),
          }),
          mine.claimId,
        ],
      );
      await c.query(
        `INSERT INTO ${WITHDRAWALS}
         SELECT (jsonb_populate_record(t, $1::jsonb)).* FROM ${WITHDRAWALS} t WHERE t.id = $2`,
        [
          JSON.stringify({
            id: foreignWithdrawal,
            tenant_id: foreignTenant,
            claim_id: foreignClaim,
          }),
          mineWithdrawal,
        ],
      );
    }, true);
    const rowOf = async (table: string, id: string) =>
      JSON.stringify(
        (await W.rowsOf(`SELECT * FROM ${table} WHERE id = $1`, [id]))[0],
      );
    const claimBefore = await rowOf(CLAIMS, foreignClaim);
    const withdrawalBefore = await rowOf(WITHDRAWALS, foreignWithdrawal);
    expect(claimBefore, "premise: the foreign claim exists").not.toBe(
      undefined,
    );
    expect(withdrawalBefore, "premise: the foreign withdrawal exists").not.toBe(
      undefined,
    );

    const list = await listClaimsHttp(prop, w.batchId);
    expect(detail(list), "my claim is listed").toContain(mine.claimId);
    expect(detail(list), "the foreign claim is not listed").not.toContain(
      foreignClaim,
    );

    const propose = await proposeHttp(prop, foreignClaim);
    expect(propose.status, detail(propose)).toBe(404);
    const approve = await approveHttp(apA, foreignWithdrawal);
    expect(approve.status, detail(approve)).toBe(404);
    const unknown = await approveHttp(apA, randomUUID());
    expect(unknown.status, detail(unknown)).toBe(404);

    const sqlPropose = await issueGrant({
      step: "propose",
      userId: prop.userId,
      batchId: w.batchId,
      refId: foreignClaim,
      detail: sha256(REASON),
    });
    const proposeMessage = sqlPropose.grant
      ? (await appCall(PROPOSE_SQL, [foreignClaim, sqlPropose.grant, REASON]))
          .message
      : sqlPropose.message;
    expect(proposeMessage, "SQL propose of a foreign claim").toMatch(
      /PAYOUT-69/,
    );
    const sqlApprove = await issueGrant({
      step: "approve",
      userId: apA.userId,
      batchId: w.batchId,
      refId: foreignWithdrawal,
      detail: sha256(REASON),
    });
    const approveMessage = sqlApprove.grant
      ? (await appCall(APPROVE_SQL, [foreignWithdrawal, sqlApprove.grant]))
          .message
      : sqlApprove.message;
    expect(approveMessage, "SQL approve of a foreign withdrawal").toMatch(
      /PAYOUT-69/,
    );

    expect(await rowOf(CLAIMS, foreignClaim), "foreign claim unchanged").toBe(
      claimBefore,
    );
    expect(
      await rowOf(WITHDRAWALS, foreignWithdrawal),
      "foreign withdrawal unchanged",
    ).toBe(withdrawalBefore);

    // Control: my own withdrawal goes through.
    const control = await approveHttp(apA, mineWithdrawal);
    expect(ok(control), detail(control)).toBe(true);
    expect((await claimRow(mine.claimId)).status).toBe("withdrawn");
  });
});

// =========================================================================
// 8: only the trusted functions write
// =========================================================================

describe("1005: the tables are written only by the trusted functions", () => {
  it("[1005-withdraw-8-app-cannot-write] legend_app cannot INSERT, UPDATE or DELETE the withdrawals table (42501), nor mark a claim withdrawn, nor empty the return columns of an item; everything stays as it was", async () => {
    const w = await paidBatch(2);
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);
    const withdrawalBefore = JSON.stringify(
      (await withdrawalsOf(claim.claimId))[0],
    );
    const claimBefore = JSON.stringify(await claimRow(claim.claimId));
    const itemBefore = JSON.stringify(await itemRow(w.a));

    const insert = await appCall(
      `INSERT INTO ${WITHDRAWALS}
         SELECT (jsonb_populate_record(t, jsonb_build_object('id', gen_random_uuid(),
                  'claim_id', gen_random_uuid(), 'approved_by', $2::text, 'approved_at', now(),
                  'approved_session_id', 'forged-session', 'approved_grant_id', t.proposed_grant_id))).*
           FROM ${WITHDRAWALS} t WHERE t.tenant_id = $1 AND t.id = $3`,
      [W.tenantId, apA.userId, id],
    );
    expect(insert.code, `INSERT: ${insert.message}`).toBe(PRIVILEGE);
    const approve = await appCall(
      `UPDATE ${WITHDRAWALS} SET approved_by = $3, approved_at = now() WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, id, apA.userId],
    );
    expect(approve.code, `UPDATE: ${approve.message}`).toBe(PRIVILEGE);
    const del = await appCall(
      `DELETE FROM ${WITHDRAWALS} WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, id],
    );
    expect(del.code, `DELETE: ${del.message}`).toBe(PRIVILEGE);

    const claimWrite = await appCall(
      `UPDATE ${CLAIMS} SET status = 'withdrawn', withdrawn_at = now() WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, claim.claimId],
    );
    expect(claimWrite.code, "marking a claim withdrawn").toBeDefined();
    expect(claimWrite.message).not.toMatch(/does not exist/);
    const itemWrite = await appCall(
      `UPDATE payroll_disbursement_items
          SET returned_by = NULL, return_evidence_key = NULL, return_note = NULL,
              return_claim_id = NULL, return_bank_ref = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, w.a],
    );
    expect(itemWrite.code, "emptying the return columns").toBeDefined();

    expect(JSON.stringify((await withdrawalsOf(claim.claimId))[0])).toBe(
      withdrawalBefore,
    );
    expect(JSON.stringify(await claimRow(claim.claimId))).toBe(claimBefore);
    expect(JSON.stringify(await itemRow(w.a))).toBe(itemBefore);
  });

  it("[1005-withdraw-8-payout-guards] even as legend_payout: an approved withdrawal cannot be rewritten, approved again or deleted; a withdrawn claim cannot go back to open or on to consumed; the return columns of an item of an OPEN claim cannot be emptied", async () => {
    const w = await paidBatch(2);
    const gone = await openClaim(w.batchId, w.a);
    const id = await withdrawn(gone);
    const live = await openClaim(w.batchId, w.b);
    const claimBefore = JSON.stringify(await claimRow(gone.claimId));
    const withdrawalBefore = JSON.stringify(
      (await withdrawalsOf(gone.claimId))[0],
    );
    const liveItemBefore = JSON.stringify(await itemRow(w.b));

    const attempts: [string, string, unknown[]][] = [
      [
        "rewrite the reason",
        `UPDATE ${WITHDRAWALS} SET reason = $3 WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, id, OTHER_REASON],
      ],
      [
        "approve again as someone else",
        `UPDATE ${WITHDRAWALS} SET approved_by = $3 WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, id, apB.userId],
      ],
      [
        "delete the withdrawal",
        `DELETE FROM ${WITHDRAWALS} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, id],
      ],
      [
        "reopen the withdrawn claim",
        `UPDATE ${CLAIMS} SET status = 'open' WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, gone.claimId],
      ],
      [
        "consume the withdrawn claim",
        `UPDATE ${CLAIMS} SET status = 'consumed', consumed_at = now() WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, gone.claimId],
      ],
      [
        "empty the return columns of an item of an open claim",
        `UPDATE payroll_disbursement_items
            SET returned_by = NULL, return_evidence_key = NULL, return_note = NULL,
                return_claim_id = NULL, return_bank_ref = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.b],
      ],
    ];
    for (const [label, sql, params] of attempts) {
      const out = await payoutCall(sql, params);
      expect(out.code, `${label}: must be refused`).toBeDefined();
      expect(out.message, `${label}: refused by a guard`).not.toMatch(
        /does not exist/,
      );
    }
    expect(JSON.stringify(await claimRow(gone.claimId))).toBe(claimBefore);
    expect(JSON.stringify((await withdrawalsOf(gone.claimId))[0])).toBe(
      withdrawalBefore,
    );
    expect(JSON.stringify(await itemRow(w.b))).toBe(liveItemBefore);
    expect((await claimRow(live.claimId)).status).toBe("open");
  });
});
