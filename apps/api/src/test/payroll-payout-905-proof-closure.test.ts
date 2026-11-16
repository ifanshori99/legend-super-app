// Payout 905 card 3 (bead legend-6htrf; docs/briefs/905/brief.md "Kartu 3" and
// docs/briefs/905/design.md "0413 kartu 3", "Endpoint kartu 3 (C3)" and "Asumsi
// pemanggil"). Written fail-first from the brief, the design and the shared
// validators/DTO types (packages/shared payroll-payout), not from the
// implementation. API level: everything goes over HTTP like the other payout
// route tests; state is observed in the database as the table owner.
//
// A stuck proof key (unreadable, hash_conflict, legacy_duplicate, shared_key)
// holds the GLOBAL proof gate `app.payout_proof_history_pending()` for ever.
// Two different finance people close it: one proposes (note + password step-up),
// the other approves (password step-up). Rules proven here (founder: nobody is
// paid twice or without money moving; when in doubt, limit the payment):
// - Two people: approver is neither the proposer (403 PAYOUT_CLOSURE_SAME_PERSON)
//   nor the person who requested the batch (403 PAYOUT_CLOSURE_REQUESTER).
// - Step-up: a session whose second factor only comes from the MFA enrollment
//   must send the account password on both steps (401 REAUTH_REQUIRED without,
//   401/403 with a wrong one), like resolve/return/overpaid (888).
// - Closing is idempotent, tenant-scoped, never changes an item, and after the
//   last stuck key of the whole database is closed the gate answers false.
// - Money: a closed key stays bound for good. It can never be used again, so no
//   correction, overpaid record or return over those bytes can move an item,
//   even though the gate is clear again. Open proposals over a closed key cannot
//   finish.
//
// Assumptions (the brief/design leave them open, stated so they can be contested):
// - Success of POST is HTTP 200 (201 is accepted too). Responses are
//   `{ data: ... }` with the DTOs of packages/shared (PayoutProofClosureProposedDto
//   / ClosedDto, PayoutStuckProof[] for the list under `data`).
// - Table `payroll_payout_proof_closures` has at least `id, tenant_id,
//   evidence_key, proposed_at, closed_at` (design "Asumsi pemanggil" C3);
//   `closed_at` is null while only proposed.
// - Approving an already closed closure is idempotent: either 200 with
//   stage "closed" again, or 409 PAYOUT_CLOSURE_ALREADY_CLOSED (both appear in
//   the design); proposing again over a closed key is any 4xx (404 because the
//   stuck row is resolved, or 409). What is asserted is: one closure row, the
//   same closed_at, gate stays false, never a 5xx.
// - Approving a closure id that does not exist is 404.
// - A closed key used again is refused 409; the code is PAYOUT_PROOF_CLOSED or
//   PAYOUT_PROOF_REUSED (the key is also bound); it is never the gate code
//   PAYOUT_PROOF_FINGERPRINT_PENDING because the gate is clear then. The
//   proof is the unchanged state (item status, no claim/correction/posting).
// - The stuck rows are built as the table owner with guards off (what the
//   fingerprint backfill leaves); `tenant B` is a copy of a batch under a new
//   tenant, like payroll-payout-900-global-gate.test.ts.
// - The test database has no other unresolved stuck rows when this file starts
//   (files run one at a time); the premise is asserted in beforeAll.
// - Not covered here: the audit row of a closure (its event name is not in the
//   brief) and the SQL-level actor checks of the 0413 functions (the 905
//   trusted-boundary file covers the role boundary).
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
import { agent, originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("905clo");
const PASSWORD = "Test-password-123!";
const WRONG = "Salah-password-999!";
const NET = 1_000_000;
const STUCK = "payroll_payout_proof_backfill_stuck";
const CLOSURES = "payroll_payout_proof_closures";
const PROOFS = "/api/hris/payroll/payout-proofs";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const NOTE = "Bukti macet, file tidak bisa dibaca lagi, kasus ditutup permanen";

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];

// ---- People -------------------------------------------------------------------------

type Person = Awaited<ReturnType<typeof finance>>;

/** Signed in with the approve permission, TOTP enrolled in this very session (enrollment-only). */
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Closure905 ${label}`);
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
  return { client, userId };
}

let one: Person;
let two: Person;
let three: Person;
let viewer: Awaited<ReturnType<typeof W.signedInClient>>;

// ---- Cleanup --------------------------------------------------------------------------

const trackedKeys: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => undefined);
  const keys = trackedKeys.splice(0);
  // 905: the upload records `stuck()` seeded (only those), and the hashes a
  // closure contested from them.
  const files = seededFiles
    .splice(0)
    .filter((f) => f.tenant === W.tenantId)
    .map((f) => f.key);
  if (files.length > 0)
    await W.asTenant(async (c) => {
      await c.query(
        `DELETE FROM payroll_payout_proof_hash_contests
          WHERE sha256 IN (SELECT f.content_sha256 FROM payroll_payout_evidence_files f
                            WHERE f.tenant_id = $1 AND f.evidence_key = ANY($2::text[]))`,
        [W.tenantId, files],
      );
      await c.query(
        `DELETE FROM payroll_payout_evidence_files
          WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
        [W.tenantId, files],
      );
    }, true);
  if (keys.length === 0) return;
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_proof_hash_contests
        WHERE sha256 IN (SELECT h.sha256 FROM payroll_payout_proof_hashes h
                          JOIN payroll_payout_proof_bindings b ON b.id = h.binding_id
                         WHERE b.tenant_id = $1 AND b.evidence_key = ANY($2::text[]))`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_proof_hashes
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND evidence_key = ANY($2::text[]))`,
      [W.tenantId, keys],
    );
    for (const table of [
      "payroll_payout_proof_bindings",
      "payroll_payout_failed_corrections",
      "payroll_payout_overpaid_proposals",
      "payroll_payout_return_claims",
      CLOSURES,
      STUCK,
    ])
      await c.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
        [W.tenantId, keys],
      );
  }, true);
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await finance("One");
  two = await finance("Two");
  three = await finance("Three");
  viewer = await W.signedInClient("Closure905 Viewer");
  await W.grantRole(viewer.userId, ["payroll.view"]);
  const state = await gate();
  expect(
    state.history_pending,
    "premise: no stuck or unaccounted proof history is left in the database",
  ).toBe(false);
});

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- Worlds -----------------------------------------------------------------------------

const sourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;

/** An exported batch of Budi; `requesterId` is the user who requested it (default: the fixture requester). */
async function exportedBatch(requesterId?: string) {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  if (!requesterId) {
    const batchId = await W.exportedBatch(runId);
    return { batchId, itemId: (await W.itemsOf(batchId))[0]!.id as string };
  }
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requesterId), {
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
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requesterId), batchId),
  );
  await W.inTx(async (tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: (await W.batchById(batchId)).content_hash as string,
      sourceBankAccountId: await sourceBank(),
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  return { batchId, itemId: (await W.itemsOf(batchId))[0]!.id as string };
}

/** The only item was closed `failed` by two people: the shape a correction/overpaid starts from. */
async function failedBatch() {
  const w = await exportedBatch();
  await W.resolve(w.batchId, [w.itemId], "failed", APP);
  await W.resolve(w.batchId, [w.itemId], "failed", APP3);
  expect((await itemOf(w.itemId)).status, "premise: failed").toBe("failed");
  return w;
}

/** Budi paid (succeeded): the shape a return starts from. */
async function paidBatch() {
  const w = await exportedBatch();
  const items = await W.itemsOf(w.batchId);
  await W.confirm(w.batchId, W.succeedItems(w.batchId, items));
  expect((await itemOf(w.itemId)).status, "premise: succeeded").toBe(
    "succeeded",
  );
  return w;
}

// 905: the stuck table alone never held the gate (app.payout_proof_tenant_pending,
// 0399/0413, reads no stuck row). What holds it in production is the proof
// history the backfill could not finish: an upload record whose stored
// fingerprint was never read (stored_sha256 NULL). The helper now leaves that
// real pending state next to the stuck row; the gate itself is unchanged.
const seededFiles: { tenant: string; key: string }[] = [];
async function pendingUpload(
  batchId: string,
  key: string,
  tenant = W.tenantId,
) {
  const sha = createHash("sha256")
    .update(`fixture proof ${tenant}/${key}`)
    .digest("hex");
  const inserted = await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
         VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT (tenant_id, evidence_key) DO NOTHING RETURNING id`,
        [tenant, batchId, key, sha, APP],
      ),
    true,
  );
  if (inserted.rowCount) seededFiles.push({ tenant, key });
}

/** A stuck row as the fingerprint backfill leaves it (owner, guards off), with its pending upload record. Returns the key. */
async function stuck(
  batchId: string,
  reason: "unreadable" | "hash_conflict" | "legacy_duplicate" | "shared_key",
  key = uploadEvidence(batchId, `stuck-${randomUUID()}.pdf`),
  tenant = W.tenantId,
) {
  if (!trackedKeys.includes(key)) trackKey(key);
  await pendingUpload(batchId, key, tenant);
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason, attempts)
         VALUES ($1, $2, $3, $4, 3)`,
        [tenant, batchId, key, reason],
      ),
    true,
  );
  return key;
}

// ---- Observations --------------------------------------------------------------------------

const gate = async () =>
  (
    await W.rowsOf(
      `SELECT app.payout_proof_history_pending() AS history_pending,
              app.payout_proof_tenant_pending() AS tenant_pending`,
    )
  )[0] as { history_pending: boolean; tenant_pending: boolean };
const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, settled_at, confirmed_by, confirmation_ref, confirmation_evidence_key,
              returned_by, return_evidence_key, gl_posting_id
         FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const closuresOf = (key: string) =>
  W.rowsOf(
    `SELECT id, evidence_key, closed_at FROM ${CLOSURES}
      WHERE tenant_id = $1 AND evidence_key = $2 ORDER BY proposed_at`,
    [W.tenantId, key],
  );
const stuckOf = async (key: string, tenant = W.tenantId) =>
  (
    await W.rowsOf(
      `SELECT resolved_at FROM ${STUCK} WHERE tenant_id = $1 AND evidence_key = $2`,
      [tenant, key],
    )
  )[0];
const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const trailOf = async (batchId: string) => ({
  corrections: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_failed_corrections WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  proposals: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_overpaid_proposals WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  claims: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_return_claims WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  postings: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  journals: await count(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
    [W.tenantId],
  ),
});

// ---- Calls -----------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const codeOf = (res: Res) => res.body.error?.code;
const detail = (res: Res) => JSON.stringify(res.body);
const expectOk = (res: Res, label = "") =>
  expect([200, 201], `${label} ${detail(res)}`).toContain(res.status);

const propose = (
  who: Person,
  evidenceKey: string,
  password: string | null = PASSWORD,
  note = NOTE,
) =>
  who.client
    .post(`${PROOFS}/closures`)
    .set(originHeader)
    .send(
      password === null
        ? { evidenceKey, note }
        : { evidenceKey, note, password },
    ) as unknown as Promise<Res>;
const approve = (
  who: Person,
  closureId: string,
  password: string | null = PASSWORD,
) =>
  who.client
    .post(`${PROOFS}/closures/${closureId}/approve`)
    .set(originHeader)
    .send(password === null ? {} : { password }) as unknown as Promise<Res>;
const listStuck = (client: Person["client"], query = "") =>
  client.get(`${PROOFS}/stuck${query}`) as unknown as Promise<Res>;

/** Propose by one person, approve by another; both must succeed. */
async function close(key: string, proposer: Person, approver: Person) {
  const proposed = await propose(proposer, key);
  expectOk(proposed, "propose");
  const closureId = proposed.body.data!.closureId as string;
  const approved = await approve(approver, closureId);
  expectOk(approved, "approve");
  return { closureId, approved };
}

const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";
const itemCall = (
  who: Person,
  route: "correct-failed" | "overpaid" | "return",
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client.post(`${BATCHES}/${batchId}/${route}`).set(originHeader).send({
    itemIds,
    evidenceKey,
    note: NOTE_ITEM,
    password: PASSWORD,
  }) as unknown as Promise<Res>;

const CLOSED_OR_REUSED = ["PAYOUT_PROOF_CLOSED", "PAYOUT_PROOF_REUSED"];
function expectKeyRefused(res: Res, label: string) {
  expect(res.status, `${label} ${detail(res)}`).toBe(409);
  expect(codeOf(res), `${label}: not the gate, the key itself`).not.toBe(
    "PAYOUT_PROOF_FINGERPRINT_PENDING",
  );
  expect(CLOSED_OR_REUSED, `${label} ${detail(res)}`).toContain(codeOf(res));
}

// =========================================================================
// The list of stuck keys
// =========================================================================

describe("905 card 3: GET /payout-proofs/stuck", () => {
  it("[905-closure-list] a signed-out visitor gets 401 and a viewer without the approve permission 403; finance sees the stuck key with its reason and no closure, then the proposed closure", async () => {
    const w = await exportedBatch();
    const key = await stuck(w.batchId, "unreadable");

    const anonymous = (await agent(W.app).get(
      `${PROOFS}/stuck`,
    )) as unknown as Res;
    expect(anonymous.status, detail(anonymous)).toBe(401);
    const forbidden = await listStuck(viewer.client);
    expect(forbidden.status, detail(forbidden)).toBe(403);

    const before = await listStuck(one.client, "?limit=100");
    expect(before.status, detail(before)).toBe(200);
    const rows = before.body.data as unknown as Row[];
    expect(Array.isArray(rows), "the list is an array under data").toBe(true);
    const mine = rows.find((r) => r.evidenceKey === key);
    expect(mine, "the stuck key is listed").toMatchObject({
      evidenceKey: key,
      batchId: w.batchId,
      reason: "unreadable",
      attempts: 3,
      closure: null,
    });
    expect(typeof mine!.firstSeenAt).toBe("string");

    const proposed = await propose(one, key);
    expectOk(proposed, "propose");
    const after = await listStuck(two.client, "?limit=100");
    const row = (after.body.data as unknown as Row[]).find(
      (r) => r.evidenceKey === key,
    );
    expect(row?.closure).toMatchObject({
      id: proposed.body.data!.closureId,
      stage: "proposed",
      closedAt: null,
    });
  });
});

// =========================================================================
// Two people close it; the gate returns false after the last one
// =========================================================================

describe("905 card 3: two finance people close a stuck key", () => {
  it("[905-closure-two-person-gate-false] two stuck keys: after the first closure the gate still holds (the second key), after the second it answers false; proposer and approver differ, the stuck rows are resolved and no item changes", async () => {
    const w = await exportedBatch();
    const k1 = await stuck(w.batchId, "unreadable");
    const k2 = await stuck(w.batchId, "hash_conflict");
    const itemBefore = await itemOf(w.itemId);
    expect(
      (await gate()).history_pending,
      "premise: the stuck keys hold the gate",
    ).toBe(true);

    const proposed = await propose(one, k1);
    expectOk(proposed, "propose k1");
    expect(proposed.body.data).toMatchObject({ stage: "proposed" });
    expect(typeof proposed.body.data!.closureId).toBe("string");
    expect((await closuresOf(k1))[0]!.closed_at, "only proposed").toBeNull();
    expect((await stuckOf(k1))!.resolved_at, "not resolved yet").toBeNull();
    expect((await gate()).history_pending).toBe(true);

    const approved = await approve(
      two,
      proposed.body.data!.closureId as string,
    );
    expectOk(approved, "approve k1");
    expect(approved.body.data).toMatchObject({
      closureId: proposed.body.data!.closureId,
      stage: "closed",
      gatePending: true,
    });
    expect((await closuresOf(k1))[0]!.closed_at).not.toBeNull();
    expect((await stuckOf(k1))!.resolved_at).not.toBeNull();
    expect(
      (await gate()).history_pending,
      "k2 still holds the global gate",
    ).toBe(true);

    // Other direction of people for the second key.
    const second = await close(k2, two, one);
    expect(second.approved.body.data).toMatchObject({
      stage: "closed",
      gatePending: false,
    });
    expect((await stuckOf(k2))!.resolved_at).not.toBeNull();
    expect(await gate(), "all stuck keys closed: the gate is false").toEqual({
      history_pending: false,
      tenant_pending: false,
    });
    expect(await itemOf(w.itemId), "closing never changes an item").toEqual(
      itemBefore,
    );
  });

  it("[905-closure-same-person] the proposer cannot approve its own closure: 403 PAYOUT_CLOSURE_SAME_PERSON, nothing is closed and the gate holds; a different person then closes it", async () => {
    const w = await exportedBatch();
    const key = await stuck(w.batchId, "legacy_duplicate");
    const proposed = await propose(one, key);
    expectOk(proposed, "propose");
    const closureId = proposed.body.data!.closureId as string;

    const own = await approve(one, closureId);
    expect(own.status, detail(own)).toBe(403);
    expect(codeOf(own)).toBe("PAYOUT_CLOSURE_SAME_PERSON");
    expect((await closuresOf(key))[0]!.closed_at).toBeNull();
    expect((await stuckOf(key))!.resolved_at).toBeNull();
    expect((await gate()).history_pending).toBe(true);

    expectOk(await approve(two, closureId), "control: another person");
    expect((await closuresOf(key))[0]!.closed_at).not.toBeNull();
    expect((await gate()).history_pending).toBe(false);
  });

  it("[905-closure-requester] the person who requested the batch cannot approve the closure: 403 PAYOUT_CLOSURE_REQUESTER and nothing is closed; a non-requester then closes it", async () => {
    const w = await exportedBatch(three.userId);
    expect(
      (await W.batchById(w.batchId)).requested_by,
      "premise: the HTTP user requested the batch",
    ).toBe(three.userId);
    const key = await stuck(w.batchId, "unreadable");
    const proposed = await propose(one, key);
    expectOk(proposed, "propose");
    const closureId = proposed.body.data!.closureId as string;

    const refused = await approve(three, closureId);
    expect(refused.status, detail(refused)).toBe(403);
    expect(codeOf(refused)).toBe("PAYOUT_CLOSURE_REQUESTER");
    expect((await closuresOf(key))[0]!.closed_at).toBeNull();
    expect((await gate()).history_pending).toBe(true);

    expectOk(await approve(two, closureId), "control: a non-requester");
    expect((await closuresOf(key))[0]!.closed_at).not.toBeNull();
  });

  it("[905-closure-password-stepup] a session whose second factor only comes from the enrollment needs the account password on both steps: 401 REAUTH_REQUIRED without, 401/403 with a wrong one, nothing changes; with the right one it goes through", async () => {
    const w = await exportedBatch();
    const key = await stuck(w.batchId, "unreadable");

    const noPassword = await propose(one, key, null);
    expect(noPassword.status, detail(noPassword)).toBe(401);
    expect(codeOf(noPassword)).toBe("REAUTH_REQUIRED");
    const wrongPassword = await propose(one, key, WRONG);
    expect([401, 403], detail(wrongPassword)).toContain(wrongPassword.status);
    expect(await closuresOf(key), "no proposal was recorded").toHaveLength(0);

    const proposed = await propose(one, key);
    expectOk(proposed, "propose with the password");
    const closureId = proposed.body.data!.closureId as string;

    const noSecond = await approve(two, closureId, null);
    expect(noSecond.status, detail(noSecond)).toBe(401);
    expect(codeOf(noSecond)).toBe("REAUTH_REQUIRED");
    const wrongSecond = await approve(two, closureId, WRONG);
    expect([401, 403], detail(wrongSecond)).toContain(wrongSecond.status);
    expect(
      (await closuresOf(key))[0]!.closed_at,
      "still only proposed",
    ).toBeNull();
    expect((await stuckOf(key))!.resolved_at).toBeNull();
    expect((await gate()).history_pending).toBe(true);

    expectOk(await approve(two, closureId), "approve with the password");
    expect((await closuresOf(key))[0]!.closed_at).not.toBeNull();
  });

  it("[905-closure-permission] without payroll.disburse.approve both POST routes answer 403 and nothing is recorded", async () => {
    const w = await exportedBatch();
    const key = await stuck(w.batchId, "unreadable");
    const proposedOnce = await propose(one, key);
    expectOk(proposedOnce, "control: a permitted person proposes");
    const asViewer = {
      client: viewer.client,
      userId: viewer.userId,
    } as Person;

    const other = await stuck(w.batchId, "hash_conflict");
    const refusedPropose = await propose(asViewer, other);
    expect(refusedPropose.status, detail(refusedPropose)).toBe(403);
    expect(await closuresOf(other)).toHaveLength(0);
    const refusedApprove = await approve(
      asViewer,
      proposedOnce.body.data!.closureId as string,
    );
    expect(refusedApprove.status, detail(refusedApprove)).toBe(403);
    expect((await closuresOf(key))[0]!.closed_at).toBeNull();
  });
});

// =========================================================================
// Idempotent, not found, tenant scope
// =========================================================================

describe("905 card 3: idempotent, unknown keys, tenant scope", () => {
  it("[905-closure-idempotent] approving again (also in parallel) and proposing again over a closed key never create a second closure, never move closed_at and never 5xx; the gate stays false", async () => {
    const w = await exportedBatch();
    const key = await stuck(w.batchId, "unreadable");
    const { closureId } = await close(key, one, two);
    const closedAt = (await closuresOf(key))[0]!.closed_at;
    expect(closedAt).not.toBeNull();

    const again = await approve(two, closureId);
    expect([200, 201, 409], detail(again)).toContain(again.status);
    if (again.status === 409)
      expect(codeOf(again)).toBe("PAYOUT_CLOSURE_ALREADY_CLOSED");
    else expect(again.body.data).toMatchObject({ closureId, stage: "closed" });
    const parallel = await Promise.all([
      approve(two, closureId),
      approve(three, closureId),
    ]);
    for (const res of parallel) {
      expect(res.status, detail(res)).toBeLessThan(500);
      expect([200, 201, 409], detail(res)).toContain(res.status);
    }
    const reproposed = await propose(three, key);
    expect(reproposed.status, detail(reproposed)).toBeGreaterThanOrEqual(400);
    expect(reproposed.status, detail(reproposed)).toBeLessThan(500);

    const rows = await closuresOf(key);
    expect(rows, "one closure for the key").toHaveLength(1);
    expect(rows[0]!.closed_at, "closed_at never moves").toEqual(closedAt);
    expect((await gate()).history_pending).toBe(false);
  });

  it("[905-closure-not-found] a key without an open stuck row (never stuck, or already resolved) is 404 PAYOUT_PROOF_STUCK_NOT_FOUND and records nothing; approving an unknown closure is 404; an empty note is a 4xx", async () => {
    const w = await exportedBatch();
    const neverStuck = trackKey(
      uploadEvidence(w.batchId, `none-${randomUUID()}.pdf`),
    );
    const unknown = await propose(one, neverStuck);
    expect(unknown.status, detail(unknown)).toBe(404);
    expect(codeOf(unknown)).toBe("PAYOUT_PROOF_STUCK_NOT_FOUND");
    expect(await closuresOf(neverStuck)).toHaveLength(0);

    const resolved = await stuck(w.batchId, "unreadable");
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE ${STUCK} SET resolved_at = now() WHERE tenant_id = $1 AND evidence_key = $2`,
          [W.tenantId, resolved],
        ),
      true,
    );
    const done = await propose(one, resolved);
    expect(done.status, detail(done)).toBe(404);
    expect(codeOf(done)).toBe("PAYOUT_PROOF_STUCK_NOT_FOUND");
    expect(await closuresOf(resolved)).toHaveLength(0);

    const ghost = await approve(two, randomUUID());
    expect(ghost.status, detail(ghost)).toBe(404);

    const live = await stuck(w.batchId, "hash_conflict");
    const noNote = await propose(one, live, PASSWORD, "");
    expect([400, 422], detail(noNote)).toContain(noNote.status);
    expect(await closuresOf(live)).toHaveLength(0);
  });

  it("[905-closure-tenant-scope] another PT's stuck key is not listed and cannot be proposed (404); closing this PT's key reports the global gate as still pending while the other PT holds it", async () => {
    const w = await exportedBatch();
    const own = await stuck(w.batchId, "unreadable");
    const b = await tenantB(w.batchId);
    const foreign = trackKey(
      `tenants/${b.tenant}/payroll-payout/${b.batch}/x-${randomUUID()}.pdf`,
    );
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason)
           VALUES ($1, $2, $3, 'unreadable')`,
          [b.tenant, b.batch, foreign],
        ),
      true,
    );
    // 905: PT B holds the gate through its pending upload record (see `stuck`).
    await pendingUpload(b.batch, foreign, b.tenant);

    const listed = await listStuck(one.client, "?limit=100");
    const keys = (listed.body.data as unknown as Row[]).map(
      (r) => r.evidenceKey,
    );
    expect(keys).toContain(own);
    expect(keys, "no row of another PT").not.toContain(foreign);

    const probe = await propose(one, foreign);
    expect(probe.status, detail(probe)).toBe(404);
    expect(await closuresOf(foreign)).toHaveLength(0);
    expect((await stuckOf(foreign, b.tenant))!.resolved_at).toBeNull();

    const { approved } = await close(own, one, two);
    expect(approved.body.data).toMatchObject({
      stage: "closed",
      gatePending: true,
    });
    expect(
      (await gate()).history_pending,
      "PT B still holds the global gate",
    ).toBe(true);
  });
});

// =========================================================================
// Money: a closed key never lets a slip pay
// =========================================================================

describe("905 card 3: a closed key never moves money", () => {
  it("[905-closure-money-correct-overpaid] closed key, gate false: a correction and an overpaid record over the same bytes are refused for the key (not for the gate); the failed item stays failed with no correction, proposal, posting or journal", async () => {
    const w = await failedBatch();
    const key = await stuck(w.batchId, "unreadable");
    // 905: the fixture bytes stay readable, so the call below would complete the
    // seeded upload record itself (stored_sha256 NULL to a value) and clear the
    // gate. A return claim from before the fingerprints (no hashes) over the
    // same key is history the call cannot complete; only the closure clears it.
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO payroll_payout_return_claims
             (tenant_id, batch_id, evidence_key, item_set_hash, status, created_by)
           VALUES ($1, $2, $3, $4, 'open', $5)`,
          [
            W.tenantId,
            w.batchId,
            key,
            createHash("sha256").update(w.itemId).digest("hex"),
            APP,
          ],
        ),
      true,
    );

    // Control: while the key holds the gate, the same call is refused by the gate.
    const gated = await itemCall(
      one,
      "correct-failed",
      w.batchId,
      [w.itemId],
      key,
    );
    expect(gated.status, detail(gated)).toBe(409);
    expect(codeOf(gated)).toBe("PAYOUT_PROOF_FINGERPRINT_PENDING");

    await close(key, one, two);
    expect((await gate()).history_pending, "premise: the gate is clear").toBe(
      false,
    );
    const itemBefore = await itemOf(w.itemId);
    const trailBefore = await trailOf(w.batchId);

    for (const route of ["correct-failed", "overpaid"] as const) {
      const first = await itemCall(three, route, w.batchId, [w.itemId], key);
      expectKeyRefused(first, `${route} step 1`);
      const second = await itemCall(two, route, w.batchId, [w.itemId], key);
      expectKeyRefused(second, `${route} step 2`);
    }
    expect(await itemOf(w.itemId), "still failed, nothing confirmed").toEqual(
      itemBefore,
    );
    expect(itemBefore.status).toBe("failed");
    expect(
      await trailOf(w.batchId),
      "no correction, proposal, posting or journal",
    ).toEqual(trailBefore);
  });

  it("[905-closure-money-return] closed key, gate false: a return over the same bytes is refused for the key; the paid item stays succeeded with no claim, no return fields and no journal", async () => {
    const w = await paidBatch();
    const key = await stuck(w.batchId, "hash_conflict");
    await close(key, one, two);
    expect((await gate()).history_pending).toBe(false);
    const itemBefore = await itemOf(w.itemId);
    const trailBefore = await trailOf(w.batchId);

    const first = await itemCall(three, "return", w.batchId, [w.itemId], key);
    expectKeyRefused(first, "return step 1");
    const second = await itemCall(two, "return", w.batchId, [w.itemId], key);
    expectKeyRefused(second, "return step 2");

    expect(await itemOf(w.itemId)).toEqual(itemBefore);
    expect(itemBefore.status).toBe("succeeded");
    expect(await trailOf(w.batchId)).toEqual(trailBefore);
  });

  it("[905-closure-open-proposal-cannot-finish] a correction proposed before the key got stuck cannot be completed once the key is closed: the second person is refused and the item stays failed with no posting and no journal", async () => {
    const w = await failedBatch();
    const key = trackKey(
      uploadEvidence(w.batchId, `proposal-${randomUUID()}.pdf`),
    );
    const proposal = await itemCall(
      one,
      "correct-failed",
      w.batchId,
      [w.itemId],
      key,
    );
    expectOk(proposal, "premise: first step recorded");
    expect(proposal.body.data).toMatchObject({ stage: "proposed" });

    await stuck(w.batchId, "shared_key", key);
    await close(key, two, three);
    expect((await gate()).history_pending, "premise: gate clear").toBe(false);
    const itemBefore = await itemOf(w.itemId);
    const trailBefore = await trailOf(w.batchId);

    const finish = await itemCall(
      two,
      "correct-failed",
      w.batchId,
      [w.itemId],
      key,
    );
    expectKeyRefused(finish, "second step over a closed key");
    expect(await itemOf(w.itemId)).toEqual(itemBefore);
    expect(itemBefore.status, "never paid").toBe("failed");
    expect(await trailOf(w.batchId)).toEqual(trailBefore);
  });
});

// ---- A second tenant (PT B): a copy of a batch under a new tenant, removed in afterEach ----

async function tenantB(batchIdA: string) {
  const tenant = randomUUID();
  const batch = randomUUID();
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'PT B 905', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `pt-b-905-${tenant}`, W.tenantId],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payroll_disbursement_batches
       SELECT (jsonb_populate_record(b, jsonb_build_object('id', $1::uuid, 'tenant_id', $2::uuid))).*
         FROM payroll_disbursement_batches b WHERE b.tenant_id = $3 AND b.id = $4`,
      [batch, tenant, W.tenantId, batchIdA],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  cleanups.push(async () => {
    const owner = await W.owner.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        CLOSURES,
        STUCK,
        "payroll_payout_evidence_files", // 905: the pending upload record
        "payroll_disbursement_batches",
      ])
        await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenant,
        ]);
      await owner.query("DELETE FROM tenants WHERE id = $1", [tenant]);
      await owner.query("COMMIT");
    } catch {
      await owner.query("ROLLBACK").catch(() => undefined);
    } finally {
      owner.release();
    }
  });
  return { tenant, batch };
}
