// Payout 911, finding P1-2 (second-opinion on the 905 branch; brief-911 "P1-2").
// Written fail-first from the brief, the finding and the 905 design
// (docs/briefs/905/design.md: "Slip dengan proposal koreksi/overpaid terbuka atas
// key tertutup ditahan dari retry"), not from the implementation.
//
// Scenario: a failed slip has an OPEN correction (or overpaid) proposal over
// proof key K. K gets stuck and two finance people close it for good. A retry
// batch for the slip is refused while the proposal points at K. The proposer
// then swaps the proposal to another key K2 (official flow, or raw SQL as the
// app role). The hold must not vanish: the retry stays refused, because a
// retry would pay the same slip a second time (the first transfer may have
// arrived). Founder rule: when in doubt, limit the payment.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The official swap is the SAME proposer sending the same HTTP step again with
//   another `evidenceKey` (POST .../correct-failed or .../overpaid, step 1).
//   The finding names that path as the service path; there is no cancel route
//   I know of, so the "cancel + new proposal" fallback of the CTO decision
//   cannot be exercised here.
// - Both designs of the CTO are accepted: the swap is refused with a 4xx
//   (forbid replacement) OR it is accepted but the hold persists. What is
//   asserted either way: never a 5xx, the retry stays refused (409), the item
//   stays `failed`, and the count of batches, items, postings and payout
//   journals of the run does not move.
// - Retry = `createDisbursementBatch` of the same payroll run as the fixture
//   requester over HTTP-free service call (like payroll-payout-905-recon):
//   refused with a 409 HttpError while a hold exists.
// - The app role has no DML on the proposal tables (905 trusted boundary,
//   42501); the SQL swap must therefore fail with any error, and the row keeps
//   key K. Any error code is accepted (42501 or a guard 23514).
// - Control: a swap between two open healthy keys either works (the row then
//   points to the new key and the second person finishes it over that key) or
//   is refused 4xx (then the original proposal still finishes). Both prove
//   that the healthy path is not blocked by this fix.
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  REQ,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("911swap");
const PASSWORD = "Test-password-123!";
const NET = 1_000_000;
const STUCK = "payroll_payout_proof_backfill_stuck";
const CLOSURES = "payroll_payout_proof_closures";
const PROOFS = "/api/hris/payroll/payout-proofs";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const NOTE_CLOSE =
  "Bukti macet, file tidak bisa dibaca lagi, kasus ditutup permanen";
const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];

// ---- People (HTTP, TOTP enrolled in this very session) -------------------------------

type Person = Awaited<ReturnType<typeof finance>>;
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Swap911 ${label}`);
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

let one: Person; // proposes the item operation, then swaps
let two: Person; // proposes the closure / finishes the control
let three: Person; // approves the closure

// ---- Cleanup --------------------------------------------------------------------------

const trackedKeys: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);
const seededFiles: string[] = [];

afterEach(async () => {
  const keys = trackedKeys.splice(0);
  const files = seededFiles.splice(0);
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

const gate = async () =>
  (
    await W.rowsOf(
      `SELECT app.payout_proof_history_pending() AS history_pending`,
    )
  )[0]!.history_pending as boolean;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await finance("One");
  two = await finance("Two");
  three = await finance("Three");
  expect(
    await gate(),
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

// ---- legend_app transaction (real COMMIT; first error, if any) ---------------------

async function appTx(work: (client: PoolClient) => Promise<void>) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      await work(client);
      await client.query("COMMIT");
      return { code: undefined as string | undefined, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

// ---- Worlds -------------------------------------------------------------------------------

/**
 * A run with one bank slip (Budi), exported and closed `failed` by two people.
 * `paidSibling`: a follow-up batch for the slip is exported and confirmed, so
 * the first (failed) transfer is a real double payment candidate; only then
 * the overpaid route accepts step 1 (PAYOUT_ITEM_NOT_OVERPAYABLE otherwise, as
 * payroll-payout-888-overpaid-route.test.ts shows). The failed item stays in
 * the first batch (`batchId`, `itemId`).
 */
async function failedWorld(paidSibling = false) {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  expect((await itemOf(itemId)).status, "premise: failed").toBe("failed");
  if (paidSibling) {
    const followUp = await W.exportedBatch(runId);
    const followItems = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    expect(followItems, "premise: one retry item").toHaveLength(1);
    await W.confirm(followUp, W.succeedItems(followUp, followItems));
    expect(
      (await itemOf(itemId)).status,
      "premise: the first item stays failed after the retry is paid",
    ).toBe("failed");
  }
  return { runId, batchId, itemId };
}

const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, gl_posting_id, resolution_evidence_key
         FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;

const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);

/** Everything a retry or a swap must not move: attempts (batches, items), postings and payout journals. */
const trailOf = async (runId: string) => ({
  batches: await count(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2`,
    [W.tenantId, runId],
  ),
  items: await count(
    `SELECT count(*)::int AS n FROM payroll_disbursement_items
      WHERE tenant_id = $1 AND payroll_run_id = $2`,
    [W.tenantId, runId],
  ),
  postings: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND batch_id IN
        (SELECT id FROM payroll_disbursement_batches
          WHERE tenant_id = $1 AND payroll_run_id = $2)`,
    [W.tenantId, runId],
  ),
  journals: await count(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
    [W.tenantId],
  ),
});

// ---- Calls ---------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const expectOk = (res: Res, label = "") =>
  expect([200, 201], `${label} ${detail(res)}`).toContain(res.status);

type Route = "correct-failed" | "overpaid";
const itemCall = (
  who: Person,
  route: Route,
  batchId: string,
  itemId: string,
  evidenceKey: string,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/${route}`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      evidenceKey,
      note: NOTE_ITEM,
      password: PASSWORD,
    }) as unknown as Promise<Res>;

const ROUTES: { route: Route; table: string }[] = [
  { route: "correct-failed", table: "payroll_payout_failed_corrections" },
  { route: "overpaid", table: "payroll_payout_overpaid_proposals" },
];

/** The proposal row(s) of the item: evidence key and status. */
const proposalsOf = (table: string, itemId: string) =>
  W.rowsOf(
    `SELECT evidence_key, status FROM ${table} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );

/** Retry = a new batch for the same run as the fixture requester. */
const retry = (runId: string) =>
  W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(REQ), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );

/** A stuck row as the fingerprint backfill leaves it (owner, guards off), with its pending upload record. */
async function stuck(batchId: string, key: string) {
  const sha = createHash("sha256")
    .update(`fixture proof ${W.tenantId}/${key}`)
    .digest("hex");
  await W.asTenant(async (c) => {
    const inserted = await c.query(
      `INSERT INTO payroll_payout_evidence_files
         (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (tenant_id, evidence_key) DO NOTHING RETURNING id`,
      [W.tenantId, batchId, key, sha, APP],
    );
    if (inserted.rowCount) seededFiles.push(key);
    await c.query(
      `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason, attempts)
       VALUES ($1, $2, $3, 'shared_key', 3)`,
      [W.tenantId, batchId, key],
    );
  }, true);
}

/** Two people (propose, approve) close the stuck key for good. */
async function closeKey(key: string) {
  const proposed = (await two.client
    .post(`${PROOFS}/closures`)
    .set(originHeader)
    .send({
      evidenceKey: key,
      note: NOTE_CLOSE,
      password: PASSWORD,
    })) as unknown as Res;
  expectOk(proposed, "closure propose");
  const approved = (await three.client
    .post(`${PROOFS}/closures/${proposed.body.data!.closureId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD })) as unknown as Res;
  expectOk(approved, "closure approve");
  expect(approved.body.data, "premise: closed").toMatchObject({
    stage: "closed",
  });
}

/**
 * A failed slip with an open proposal (`route`) over K by `one`; K stuck and
 * closed by two others; the retry is refused while the proposal points at K.
 * Overpaid world: the slip also has a paid follow-up batch (a real double
 * payment candidate, as the overpaid route requires). Assumption: there the
 * retry is refused with 409 anyway (PAYOUT_NOTHING_TO_PAY), so the retry
 * assertions are weaker for `overpaid`; the strong ones are that the swap
 * never 5xx, the item stays `failed` (never recorded `overpaid` by the
 * swap) and nothing moves. Correct-failed world: the retry must be an
 * HttpError 409 (not a raw database error) while the proposal holds K.
 */
async function heldWorld(route: Route, table: string) {
  const w = await failedWorld(route === "overpaid");
  const key = trackKey(uploadEvidence(w.batchId, `swap-k-${randomUUID()}.pdf`));
  expectOk(
    await itemCall(one, route, w.batchId, w.itemId, key),
    "premise: step 1 recorded over K",
  );
  const rows = await proposalsOf(table, w.itemId);
  expect(rows, "premise: one proposal over K").toHaveLength(1);
  expect(rows[0]!.evidence_key).toBe(key);

  await stuck(w.batchId, key);
  await closeKey(key);
  expect(await gate(), "premise: the gate is clear again").toBe(false);

  await W.expectRefused(retry(w.runId), { status: 409 });
  expect(
    (await itemOf(w.itemId)).status,
    "premise: the retry did not release the slip",
  ).toBe("failed");
  return { ...w, key };
}

// =========================================================================
// P1-2: swapping the proposal to another key does not release the hold
// =========================================================================

describe("911 P1-2: an open proposal over a closed key keeps its hold when swapped to another key", () => {
  for (const { route, table } of ROUTES) {
    it(`[911-swap-closed-key-service-${route}] proposal over K, K closed, retry refused: the proposer sends step 1 again with K2 (official flow): never a 5xx, the retry stays refused (409), the item stays failed, batches/items/postings/journals do not move`, async () => {
      const w = await heldWorld(route, table);
      const k2 = trackKey(
        uploadEvidence(w.batchId, `swap-k2-${randomUUID()}.pdf`),
      );
      const before = await trailOf(w.runId);

      const swap = await itemCall(one, route, w.batchId, w.itemId, k2);
      expect(
        swap.status,
        `the swap is refused (4xx) or accepted with the hold kept, never a 5xx: ${detail(swap)}`,
      ).toBeLessThan(500);
      expect(
        await trailOf(w.runId),
        "the swap moves no attempt, posting or journal",
      ).toEqual(before);
      expect((await itemOf(w.itemId)).status).toBe("failed");

      // The money line: the slip is still held from a second payment.
      await W.expectRefused(retry(w.runId), { status: 409 });
      expect(
        await trailOf(w.runId),
        "the refused retry created no batch, item, posting or journal",
      ).toEqual(before);
      expect((await itemOf(w.itemId)).status).toBe("failed");
    });

    it(`[911-swap-closed-key-sql-${route}] the same swap as legend_app SQL (UPDATE evidence_key to K2) is refused: the proposal keeps K, the retry stays refused, nothing moves`, async () => {
      const w = await heldWorld(route, table);
      const k2 = trackKey(
        uploadEvidence(w.batchId, `swap-k2-${randomUUID()}.pdf`),
      );
      const before = await trailOf(w.runId);

      const swap = await appTx(async (client) => {
        await client.query(
          `UPDATE ${table} SET evidence_key = $3
            WHERE tenant_id = $1 AND item_id = $2`,
          [W.tenantId, w.itemId, k2],
        );
      });
      expect(
        swap.code,
        `legend_app must not be able to move the proposal to another key: ${swap.message}`,
      ).toBeDefined();
      const rows = await proposalsOf(table, w.itemId);
      expect(rows, "still one proposal").toHaveLength(1);
      expect(rows[0]!.evidence_key, "still over the closed key K").toBe(w.key);

      await W.expectRefused(retry(w.runId), { status: 409 });
      expect(await trailOf(w.runId)).toEqual(before);
      expect((await itemOf(w.itemId)).status).toBe("failed");
    });
  }

  it("[911-swap-control-retry-free] control: a failed slip with no proposal and no closed key can get a retry batch, so the refusals above come from the hold", async () => {
    const w = await failedWorld();
    const before = await trailOf(w.runId);
    expect(
      await W.httpFailure(retry(w.runId)),
      "a failed slip without a hold can be retried",
    ).toBeNull();
    expect((await trailOf(w.runId)).batches).toBe(before.batches + 1);
  });

  it("[911-swap-control-open-keys] control: a swap between two open healthy keys is not broken: either the proposal moves to the new key and the second person finishes it over that key, or the swap is a 4xx and the original proposal still finishes; the item ends succeeded with one new journal trail", async () => {
    const w = await failedWorld();
    const ka = trackKey(
      uploadEvidence(w.batchId, `swap-a-${randomUUID()}.pdf`),
    );
    const kb = trackKey(
      uploadEvidence(w.batchId, `swap-b-${randomUUID()}.pdf`),
    );
    expectOk(
      await itemCall(one, "correct-failed", w.batchId, w.itemId, ka),
      "step 1 over Ka",
    );
    const journalsBefore = (await trailOf(w.runId)).journals;

    const swap = await itemCall(one, "correct-failed", w.batchId, w.itemId, kb);
    expect(swap.status, detail(swap)).toBeLessThan(500);
    let finalKey = ka;
    if (swap.status >= 400) {
      // Replacement forbidden by design: the first proposal is untouched.
      const rows = await proposalsOf(
        "payroll_payout_failed_corrections",
        w.itemId,
      );
      expect(rows, "one proposal, still over Ka").toHaveLength(1);
      expect(rows[0]!.evidence_key).toBe(ka);
    } else {
      finalKey = kb;
      const rows = await proposalsOf(
        "payroll_payout_failed_corrections",
        w.itemId,
      );
      expect(rows, "the swap replaced, not duplicated").toHaveLength(1);
      expect(rows[0]!.evidence_key, "the proposal moved to Kb").toBe(kb);
    }

    const finish = await itemCall(
      two,
      "correct-failed",
      w.batchId,
      w.itemId,
      finalKey,
    );
    expectOk(finish, "the second person finishes over the live key");
    expect((await itemOf(w.itemId)).status).toBe("succeeded");
    expect(
      (await trailOf(w.runId)).journals,
      "the correction journaled",
    ).toBeGreaterThan(journalsBefore);
  });
});
