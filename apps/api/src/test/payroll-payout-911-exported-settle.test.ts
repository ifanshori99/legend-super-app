// Payout 911 (beads legend-r86qa and legend-izza4; docs/briefs/905/design.md
// "Review awal architect" P2-3 and the 905 follow-up "GUC app.payout_settle").
// Written fail-first from the beads and the CTO decisions, not from the
// implementation. Everything adversarial runs as the app role
// (`SET LOCAL ROLE legend_app`) with a REAL COMMIT, so the database boundary is
// what is proven, not the service.
//
// Rules proven here (founder: nobody is paid twice, nobody is paid without money
// moving; when in doubt, limit the payment):
// - [911-exported-*] The app role cannot move an item out of `exported` by
//   itself: exported -> failed, exported -> not_sent (both free the slip for a
//   retry batch, so a really paid slip could be paid again) and exported ->
//   succeeded are refused, even when the same transaction fills the two-person
//   resolution fields by hand with real user ids.
// - [911-free-text-resolver-refused] The app role cannot write the resolution
//   record (resolved_by / resolved_by_2 / resolution_* free text) on an exported
//   item at all; only the trusted path records it.
// - [911-guc-*] The self-set GUC `app.payout_settle = 'on'` (the value the
//   guard reads, migration 0344 `app.payroll_runs_payout_guard`) buys the app
//   role nothing: it neither flips an item out of `exported` nor lets it mark a
//   run `paid` by hand.
// - Controls: the legitimate service paths (two-person resolve, the bank
//   confirmation that settles items and then the run) still work, and the app
//   role can still READ the items.
//
// Assumptions (the beads leave them open, stated so they can be contested):
// - A refusal is any database error (42501 or guard 23514, statement or COMMIT);
//   the proof is the end state: item status and resolution fields unchanged, no
//   posting, no journal, run still `locked`.
// - "legend-r86qa: revoke remaining legend_app rights" is read as: no direct
//   UPDATE of `status` out of `exported`, and none of the resolution record
//   columns (resolved_by, resolved_by_2, resolution_outcome,
//   resolution_evidence_key, resolution_note), by the app role. If the architect
//   keeps the first (non-status) step of a resolve as a plain UPDATE, the
//   [911-free-text-resolver-refused] case must be narrowed.
// - The forged resolve uses real actor user ids (APP, APP3: neither is the batch
//   requester), a stored proof key and a legal-looking note, so that the old
//   guard accepted it; a refusal can then only come from the new boundary.
// - The existing run guard (PAYOUT-22) refuses a hand-made `paid` without the
//   GUC; that premise is asserted so the GUC case proves the GUC alone is no
//   longer a key.
// - Not covered here (names of the new trusted function and of its approval
//   proof are not fixed yet): see the `it.todo` list at the bottom, to be filled
//   in once the architect names them.
// - Existing tests that set the GUC as the owner and expect the run to become
//   paid (payroll-payout-core.test.ts, "r10-paid-needs-settle" and the one near
//   line 1704) encode the old trust and were updated with the new design.
//
// Section 4 (design docs/briefs/911/design-r86qa-izza4.md sections 1 to 4) was
// filled in from the design, not from the implementation:
// - Error mapping: a forged resolve (any status or free text) is PAYOUT-74
//   (23514, the resolution record is written only by the payout role); a forged
//   bank confirmation is 42501 (confirmation_ref is revoked from legend_app, a
//   column privilege error before any trigger); a hand-made `paid` is PAYOUT-22
//   (with and without the old GUC). A bad, missing, stale, replayed or
//   mismatched grant is PAYOUT-70 (42501, as in 911-grants); the same person
//   twice is PAYOUT-64; a pre-cutover step one is PAYOUT-71; a held slip is
//   PAYOUT-62. Messages are matched by their PAYOUT code.
// - The trusted functions are called as legend_app with a REAL COMMIT and a
//   grant issued by the fixture grantor stand-in (`actorOf(...).grants`). The
//   proof file of the batch is an `payroll_payout_evidence_files` row (as the
//   911-grants `recordUpload`), because the SQL checks the upload record.
// - APP (first person), APP3 (second person) and APP2 (bank confirmer) are
//   fixture users with live, fresh-MFA sessions; none is the batch requester.
// - [911-retry-overpaid-held-sql] clones the overpaid item as a `prepared`
//   attempt 2 (known step columns cleared) and inserts it with the triggers ON
//   as the table owner; any other column of the clone that the insert guard
//   dislikes would change the message, so only the PAYOUT-62 message and the
//   unchanged item count are asserted.
// - [911-settle-fn] closes the batch by hand (`completed`, triggers off) in the
//   true case, because the function itself refuses while a batch is open (L3).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PayoutGrantBinding } from "../services/payroll-payout-grant.service.ts";
import { recordOverpaidItems } from "../services/payroll-payout-overpaid-route.service.ts";
import {
  APP,
  APP2,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("911xs");
const NET = 1_000_000;
const NOTE = "Bank menolak transfer, tidak ada dana keluar";

const batchIds: string[] = [];

// ---- legend_app helper (pattern of the 905 files) ---------------------------------

type Outcome = { code: string | undefined; message: string };
/** A legend_app transaction with a real COMMIT; the first error (statement or commit), if any. */
async function appTx(
  work: (client: PoolClient) => Promise<void>,
): Promise<Outcome> {
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
      return { code: undefined, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

/** One statement as legend_app with a real COMMIT; the first error, if any, and the rows. */
async function appCall(
  sql: string,
  params: unknown[] = [],
): Promise<Outcome & { rows: Row[] }> {
  let rows: Row[] = [];
  const outcome = await appTx(async (c) => {
    rows = (await c.query(sql, params)).rows as Row[];
  });
  return { ...outcome, rows };
}

const PRIVILEGE = "42501";
const GUARD = "23514";
const hex = () => randomBytes(32).toString("hex");
const sha = (secret: string) =>
  createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");

// ---- Fixtures ----------------------------------------------------------------------

/** A run with one bank slip and its batch exported (waiting for the bank result). */
async function exportedBatch() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  batchIds.push(batchId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  return { runId, batchId, itemId };
}

const itemRow = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, settled_at, gl_posting_id, confirmed_by, confirmation_ref,
              confirmation_evidence_key, resolved_by, resolved_by_2,
              resolution_outcome, resolution_evidence_key, resolution_note,
              failure_class
         FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const trailOf = async (batchId: string) => ({
  postings: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  journals: await count(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
    [W.tenantId],
  ),
});

/** The item is exactly as the setup left it: exported, nothing recorded on it. */
function expectUntouched(item: Row, why: string) {
  expect(item.status, `${why}: still exported`).toBe("exported");
  expect(item.settled_at).toBeNull();
  expect(item.gl_posting_id).toBeNull();
  expect(item.confirmed_by).toBeNull();
  expect(item.confirmation_ref).toBeNull();
  expect(item.confirmation_evidence_key).toBeNull();
  expect(item.resolved_by).toBeNull();
  expect(item.resolved_by_2).toBeNull();
  expect(item.resolution_outcome).toBeNull();
  expect(item.resolution_evidence_key).toBeNull();
  expect(item.resolution_note).toBeNull();
}

/** The two-person resolve done by hand in SQL, as the app role: step 1 records the proposal, step 2 flips the status. */
async function forgeResolve(
  client: PoolClient,
  ids: { batchId: string; itemId: string },
  outcome: "failed" | "not_sent",
  key: string,
) {
  await client.query(
    `UPDATE payroll_disbursement_items
        SET resolved_by = $3, resolution_outcome = $4,
            resolution_evidence_key = $5, resolution_note = $6
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, ids.itemId, APP, outcome, key, NOTE],
  );
  await client.query(
    `UPDATE payroll_disbursement_items
        SET resolved_by_2 = $3, status = $4
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, ids.itemId, APP3, outcome],
  );
}

/** A bank confirmation done by hand in SQL, as the app role (what the settle code writes). */
async function forgeConfirm(client: PoolClient, itemId: string, key: string) {
  await client.query(
    `UPDATE payroll_disbursement_items
        SET status = 'succeeded', settled_at = now(), confirmed_by = $3,
            confirmation_ref = $4, confirmation_evidence_key = $5
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId, APP2, `FORGED-${randomBytes(4).toString("hex")}`, key],
  );
}

// ---- Cleanup (pattern of the 905 trusted-boundary file) -------------------------------

async function cleanBatches(ids: string[]) {
  if (ids.length === 0) return;
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_proof_hashes
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND batch_id = ANY($2))`,
      [W.tenantId, ids],
    );
    for (const table of [
      "payroll_payout_proof_bindings",
      "payroll_payout_failed_corrections",
      "payroll_payout_overpaid_proposals",
    ])
      await c.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, ids],
      );
  }, true);
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

// Registered after the world's own hook: runs first (stack order), so rows that
// reference the batches are gone before the world deletes the batches.
afterAll(async () => {
  await cleanBatches(batchIds);
});

// =========================================================================
// 1. exported -> failed / not_sent / succeeded is not the app role's to do
// =========================================================================

describe("911 the app role cannot move an exported item on its own", () => {
  for (const outcome of ["failed", "not_sent"] as const) {
    it(`[911-exported-to-${outcome}-refused] the two-person resolve done by hand in SQL as legend_app (real actors, stored proof, resolution fields filled, status -> ${outcome}) is refused; the item stays exported and the slip is not freed for a retry`, async () => {
      const w = await exportedBatch();
      const key = uploadEvidence(w.batchId, `911-${outcome}.pdf`);
      const before = await trailOf(w.batchId);

      const attempt = await appTx((c) => forgeResolve(c, w, outcome, key));

      expect(
        attempt.code,
        `a hand-made ${outcome} must be refused (statement or commit): ${attempt.message}`,
      ).toBe(GUARD);
      expect(attempt.message).toMatch(/PAYOUT-74/);
      expectUntouched(await itemRow(w.itemId), outcome);
      expect(await trailOf(w.batchId)).toEqual(before);
    });
  }

  it("[911-exported-to-succeeded-refused] a hand-made bank confirmation (status -> succeeded with settled_at, confirmed_by, ref and proof key) as legend_app is refused; the item stays exported, no posting, no journal", async () => {
    const w = await exportedBatch();
    const key = uploadEvidence(w.batchId, "911-succeeded.pdf");
    const before = await trailOf(w.batchId);

    const attempt = await appTx((c) => forgeConfirm(c, w.itemId, key));

    // confirmation_ref is revoked from legend_app: a column privilege error.
    expect(
      attempt.code,
      `a hand-made succeeded must be refused: ${attempt.message}`,
    ).toBe(PRIVILEGE);
    expectUntouched(await itemRow(w.itemId), "succeeded");
    expect(await trailOf(w.batchId)).toEqual(before);
  });

  it("[911-free-text-resolver-refused] writing the resolution record by hand (resolved_by an invented name, outcome, proof key and free-text note) on an exported item as legend_app is refused; nothing is recorded on the item", async () => {
    const w = await exportedBatch();
    const key = uploadEvidence(w.batchId, "911-free-text.pdf");

    const attempt = await appTx(async (c) => {
      await c.query(
        `UPDATE payroll_disbursement_items
            SET resolved_by = 'orang-karangan', resolution_outcome = 'failed',
                resolution_evidence_key = $3,
                resolution_note = 'Catatan bebas yang tidak diperiksa siapa pun'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.itemId, key],
      );
    });

    expect(
      attempt.code,
      `the resolution record is written by the trusted path only: ${attempt.message}`,
    ).toBe(GUARD);
    expect(attempt.message).toMatch(/PAYOUT-74/);
    expectUntouched(await itemRow(w.itemId), "free-text resolver");
  });
});

// =========================================================================
// 2. the self-set GUC app.payout_settle is no key
// =========================================================================

describe("911 the self-set app.payout_settle GUC is not trusted", () => {
  for (const outcome of ["failed", "not_sent"] as const) {
    it(`[911-guc-no-item-${outcome}] with app.payout_settle = 'on' set by legend_app itself, the hand-made ${outcome} is still refused and the item stays exported`, async () => {
      const w = await exportedBatch();
      const key = uploadEvidence(w.batchId, `911-guc-${outcome}.pdf`);
      const before = await trailOf(w.batchId);

      const attempt = await appTx(async (c) => {
        await c.query("SELECT set_config('app.payout_settle', 'on', true)");
        await forgeResolve(c, w, outcome, key);
      });

      expect(attempt.code, attempt.message).toBe(GUARD);
      expect(attempt.message).toMatch(/PAYOUT-74/);
      expectUntouched(await itemRow(w.itemId), `GUC + ${outcome}`);
      expect(await trailOf(w.batchId)).toEqual(before);
    });
  }

  it("[911-guc-no-item-succeeded] with app.payout_settle = 'on' set by legend_app itself, the hand-made succeeded is still refused and the item stays exported", async () => {
    const w = await exportedBatch();
    const key = uploadEvidence(w.batchId, "911-guc-succeeded.pdf");
    const before = await trailOf(w.batchId);

    const attempt = await appTx(async (c) => {
      await c.query("SELECT set_config('app.payout_settle', 'on', true)");
      await forgeConfirm(c, w.itemId, key);
    });

    expect(attempt.code, attempt.message).toBe(PRIVILEGE);
    expectUntouched(await itemRow(w.itemId), "GUC + succeeded");
    expect(await trailOf(w.batchId)).toEqual(before);
  });

  it("[911-guc-no-run-paid] a run whose batch closed with failed items stays locked: marking it paid by hand as legend_app is refused without the GUC (premise) and with app.payout_settle = 'on' set by legend_app itself", async () => {
    const w = await exportedBatch();
    // Close the batch the legitimate way (two people, service path): no item is
    // open any more, so only the GUC gate stands between the app role and `paid`.
    await W.resolve(w.batchId, [w.itemId], "failed", APP);
    await W.resolve(w.batchId, [w.itemId], "failed", APP3);
    expect((await itemRow(w.itemId)).status, "premise: failed").toBe("failed");
    expect((await W.runRow(w.runId)).status, "premise: run locked").toBe(
      "locked",
    );

    const markPaid = (c: PoolClient) =>
      c
        .query(
          `UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = 'forged'
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.runId],
        )
        .then(() => undefined);

    const plain = await appTx(markPaid);
    expect(
      plain.code,
      `premise: no GUC, no paid: ${plain.message}`,
    ).toBeDefined();
    expect(plain.message).toMatch(/PAYOUT-22/);

    const withGuc = await appTx(async (c) => {
      await c.query("SELECT set_config('app.payout_settle', 'on', true)");
      await markPaid(c);
    });
    expect(
      withGuc.code,
      `the self-set GUC must not mark the run paid: ${withGuc.message}`,
    ).toBeDefined();
    expect(withGuc.message).toMatch(/PAYOUT-22/);
    const run = await W.runRow(w.runId);
    expect(run.status).toBe("locked");
    expect(run.paid_by).toBeNull();
    expect(run.paid_at).toBeNull();
  });
});

// =========================================================================
// 3. controls: the legitimate paths still work
// =========================================================================

describe("911 controls: the legitimate paths still work", () => {
  for (const outcome of ["failed", "not_sent"] as const) {
    it(`[911-control-service-resolve-${outcome}] two different people resolving through the service path (first step keeps the item exported, second moves it to ${outcome}) still works`, async () => {
      const w = await exportedBatch();
      const key = uploadEvidence(w.batchId, `911-ctl-${outcome}.pdf`);

      await W.resolve(w.batchId, [w.itemId], outcome, APP, key);
      const afterFirst = await itemRow(w.itemId);
      expect(afterFirst.status, "one step is not final").toBe("exported");
      expect(afterFirst.resolved_by).toBe(APP);

      await W.resolve(w.batchId, [w.itemId], outcome, APP3, key);
      const done = await itemRow(w.itemId);
      expect(done.status).toBe(outcome);
      expect(done.resolved_by).toBe(APP);
      expect(done.resolved_by_2).toBe(APP3);
      expect(done.resolution_outcome).toBe(outcome);
    });
  }

  it("[911-control-service-confirm-pays-run] the bank confirmation through the service path still settles the item (succeeded, posting) and then the run becomes paid", async () => {
    const w = await exportedBatch();
    const items = await W.itemsOf(w.batchId);
    await W.confirm(w.batchId, W.succeedItems(w.batchId, items));

    const item = await itemRow(w.itemId);
    expect(item.status).toBe("succeeded");
    expect(item.settled_at).not.toBeNull();
    expect(item.gl_posting_id).not.toBeNull();
    const run = await W.runRow(w.runId);
    expect(run.status).toBe("paid");
    expect(run.paid_at).not.toBeNull();
  });

  it("[911-control-app-role-still-reads] legend_app can still read the items of its tenant (the screens list them)", async () => {
    const w = await exportedBatch();
    let seen = 0;
    const read = await appTx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.itemId],
      );
      seen = rows.length;
    });
    expect(read.code, read.message).toBeUndefined();
    expect(seen).toBe(1);
  });
});

// =========================================================================
// 4. the trusted functions (design-r86qa-izza4.md section 2)
// =========================================================================

const RESOLVE_PROPOSE = `SELECT app.payout_resolve_propose($1::uuid, $2::uuid[], $3::text, $4::varchar, $5::text, $6::text) AS id`;
const RESOLVE_APPROVE = `SELECT app.payout_resolve_approve($1::uuid, $2::uuid[], $3::text, $4::varchar, $5::text) AS moved`;
const BANK_CONFIRM = `SELECT app.payout_bank_confirm($1::uuid, $2::uuid[], $3::text[], $4::varchar[], $5::text) AS moved`;
const RUN_SETTLE = `SELECT app.payout_run_settle($1::uuid, $2::uuid[]) AS paid`;

const ONE = actorOf(APP);
const TWO = actorOf(APP3);
const CONFIRMER = actorOf(APP2);

type World = { runId: string; batchId: string; itemId: string };

/** The upload record of one proof file of the batch (what a real upload leaves). */
async function recordUpload(batchId: string, name = "bukti") {
  const key = evidenceKeyFor(
    W.tenantId,
    batchId,
    `${name}-${randomUUID()}.pdf`,
  );
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, 'upload-911-xs')`,
        [W.tenantId, batchId, key, hex(), hex()],
      ),
    true,
  );
  return key;
}

const resolveBinding = (
  w: World,
  step: "propose" | "approve",
  key: string,
  detail: "failed" | "not_sent",
): PayoutGrantBinding => ({
  kind: "resolve",
  step,
  batchId: w.batchId,
  itemIds: [w.itemId],
  evidenceKey: key,
  refId: null,
  targetId: null,
  detail,
});
const confirmBinding = (w: World): PayoutGrantBinding => ({
  kind: "bank_confirm",
  step: "record",
  batchId: w.batchId,
  itemIds: [w.itemId],
  evidenceKey: null,
  refId: null,
  targetId: null,
  detail: "succeeded",
});

const grantRow = async (secret: string) =>
  (
    await W.rowsOf(
      `SELECT consumed_at FROM payroll_payout_grants WHERE tenant_id = $1 AND secret_sha256 = $2`,
      [W.tenantId, sha(secret)],
    )
  )[0];

/** The grant check refused the call (PAYOUT-70, 42501). */
function expectGrantRefused(outcome: Outcome, label: string) {
  expect(outcome.code, `${label}: ${outcome.message}`).toBe(PRIVILEGE);
  expect(outcome.message, label).toMatch(/PAYOUT-70:/);
}

/** Step one of a resolve by ONE with a real grant; returns the proof key. */
async function proposeAsOne(w: World, outcome: "failed" | "not_sent") {
  const key = await recordUpload(w.batchId);
  const grant = await ONE.grants.issue(
    resolveBinding(w, "propose", key, outcome),
  );
  const result = await appCall(RESOLVE_PROPOSE, [
    w.batchId,
    [w.itemId],
    outcome,
    key,
    NOTE,
    grant,
  ]);
  expect(result.code, `premise: step one accepted, ${result.message}`).toBe(
    undefined,
  );
  const item = await itemRow(w.itemId);
  expect(item.status, "premise: one step is not final").toBe("exported");
  expect(item.resolved_by).toBe(APP);
  return key;
}
const approveArgs = (
  w: World,
  outcome: "failed" | "not_sent",
  key: string,
  grant: string | null,
) => [w.batchId, [w.itemId], outcome, key, grant];

/** The item is still waiting for step two: exported, proposed by APP, nothing else. */
async function expectStillProposed(w: World, why: string) {
  const item = await itemRow(w.itemId);
  expect(item.status, `${why}: still exported`).toBe("exported");
  expect(item.resolved_by).toBe(APP);
  expect(item.resolved_by_2).toBeNull();
  expect(item.settled_at).toBeNull();
  expect(item.confirmed_by).toBeNull();
}

describe("911 the trusted resolve and confirm functions", () => {
  it("[911-trusted-fn-no-proof-refused] legend_app calling resolve approve or bank confirm with no grant (NULL) is refused with PAYOUT-70; the item is unchanged", async () => {
    const w = await exportedBatch();
    const key = await proposeAsOne(w, "failed");

    expectGrantRefused(
      await appCall(RESOLVE_APPROVE, approveArgs(w, "failed", key, null)),
      "approve without grant",
    );
    await expectStillProposed(w, "approve without grant");

    const other = await exportedBatch();
    expectGrantRefused(
      await appCall(BANK_CONFIRM, [
        other.batchId,
        [other.itemId],
        ["BCA-NOGRANT"],
        [null],
        null,
      ]),
      "bank confirm without grant",
    );
    expectUntouched(await itemRow(other.itemId), "bank confirm without grant");
  });

  it("[911-trusted-fn-fabricated-proof-refused] a made-up 64-hex grant is refused with PAYOUT-70 for resolve propose, resolve approve and bank confirm; nothing changes", async () => {
    const w = await exportedBatch();
    const key = await recordUpload(w.batchId);
    const forged = hex();

    expectGrantRefused(
      await appCall(RESOLVE_PROPOSE, [
        w.batchId,
        [w.itemId],
        "failed",
        key,
        NOTE,
        forged,
      ]),
      "propose with a fabricated grant",
    );
    expectUntouched(await itemRow(w.itemId), "fabricated propose");

    const proposed = await exportedBatch();
    const proposedKey = await proposeAsOne(proposed, "not_sent");
    expectGrantRefused(
      await appCall(
        RESOLVE_APPROVE,
        approveArgs(proposed, "not_sent", proposedKey, forged),
      ),
      "approve with a fabricated grant",
    );
    await expectStillProposed(proposed, "fabricated approve");

    expectGrantRefused(
      await appCall(BANK_CONFIRM, [
        w.batchId,
        [w.itemId],
        ["BCA-FORGED"],
        [null],
        forged,
      ]),
      "bank confirm with a fabricated grant",
    );
    expectUntouched(await itemRow(w.itemId), "fabricated confirm");
  });

  it("[911-trusted-fn-stale-proof-refused] a grant past expires_at is refused with PAYOUT-70, stays unconsumed, and the item is unchanged", async () => {
    const w = await exportedBatch();
    const key = await proposeAsOne(w, "failed");
    const grant = await TWO.grants.issue(
      resolveBinding(w, "approve", key, "failed"),
    );
    // Fixture only (as 911-grants "grant-expired"): the superuser moves the
    // validity window into the past (replica mode).
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_grants
              SET issued_at = now() - interval '10 minutes',
                  expires_at = now() - interval '8 minutes'
            WHERE secret_sha256 = $1`,
          [sha(grant)],
        ),
      true,
    );
    expectGrantRefused(
      await appCall(RESOLVE_APPROVE, approveArgs(w, "failed", key, grant)),
      "expired",
    );
    expect((await grantRow(grant))!.consumed_at).toBeNull();
    await expectStillProposed(w, "expired");
  });

  it("[911-trusted-fn-reused-proof-refused] a grant that already moved an item cannot be spent again: propose and bank confirm replays give PAYOUT-70 and change nothing more", async () => {
    // resolve propose replay
    const w = await exportedBatch();
    const key = await recordUpload(w.batchId);
    const grant = await ONE.grants.issue(
      resolveBinding(w, "propose", key, "failed"),
    );
    const args = [w.batchId, [w.itemId], "failed", key, NOTE, grant];
    const first = await appCall(RESOLVE_PROPOSE, args);
    expect(first.code, `premise: first call, ${first.message}`).toBe(undefined);
    expect(
      (await grantRow(grant))!.consumed_at,
      "premise: spent",
    ).not.toBeNull();
    expectGrantRefused(await appCall(RESOLVE_PROPOSE, args), "propose replay");
    await expectStillProposed(w, "propose replay");

    // bank confirm replay
    const paid = await exportedBatch();
    const confirmGrant = await CONFIRMER.grants.issue(confirmBinding(paid));
    const confirmArgs = [
      paid.batchId,
      [paid.itemId],
      ["BCA-REPLAY"],
      [null],
      confirmGrant,
    ];
    const confirmed = await appCall(BANK_CONFIRM, confirmArgs);
    expect(confirmed.code, `premise: confirm, ${confirmed.message}`).toBe(
      undefined,
    );
    const afterFirst = await itemRow(paid.itemId);
    expect(afterFirst.status).toBe("succeeded");
    expectGrantRefused(
      await appCall(BANK_CONFIRM, confirmArgs),
      "confirm replay",
    );
    expect(await itemRow(paid.itemId)).toEqual(afterFirst);
  });

  it("[911-trusted-fn-same-actor-refused] the person who proposed cannot approve: even with a real grant of their own the call gives PAYOUT-64, the item stays exported and the grant is not consumed", async () => {
    const w = await exportedBatch();
    const key = await proposeAsOne(w, "failed");
    const grant = await ONE.grants.issue(
      resolveBinding(w, "approve", key, "failed"),
    );
    const refused = await appCall(
      RESOLVE_APPROVE,
      approveArgs(w, "failed", key, grant),
    );
    expect(refused.code, refused.message).toBeDefined();
    expect(refused.message).toMatch(/PAYOUT-64/);
    expect((await grantRow(grant))!.consumed_at).toBeNull();
    await expectStillProposed(w, "same actor");
  });

  for (const outcome of ["failed", "not_sent"] as const) {
    it(`[911-trusted-fn-valid-proof-accepted-${outcome}] two people with their own grants (propose by APP, approve by APP3) move the exported item to ${outcome}; the record carries both people`, async () => {
      const w = await exportedBatch();
      const key = await proposeAsOne(w, outcome);
      const grant = await TWO.grants.issue(
        resolveBinding(w, "approve", key, outcome),
      );
      const approved = await appCall(
        RESOLVE_APPROVE,
        approveArgs(w, outcome, key, grant),
      );
      expect(approved.code, approved.message).toBeUndefined();
      expect(Number(approved.rows[0]!.moved)).toBe(1);

      const item = await itemRow(w.itemId);
      expect(item.status).toBe(outcome);
      expect(item.resolved_by).toBe(APP);
      expect(item.resolved_by_2).toBe(APP3);
      expect(item.resolution_outcome).toBe(outcome);
      expect(item.resolution_evidence_key).toBe(key);
      expect(item.failure_class).toBe(
        outcome === "failed" ? "definitive" : null,
      );
      expect((await grantRow(grant))!.consumed_at).not.toBeNull();
    });
  }

  it("[911-trusted-fn-valid-proof-accepted-succeeded] a bank_confirm grant of a person who is not the requester moves the exported item to succeeded, with the bank reference, proof key, settled_at and confirmed_by of that person", async () => {
    const w = await exportedBatch();
    const key = await recordUpload(w.batchId);
    const grant = await CONFIRMER.grants.issue(confirmBinding(w));
    const confirmed = await appCall(BANK_CONFIRM, [
      w.batchId,
      [w.itemId],
      ["BCA-911-OK"],
      [key],
      grant,
    ]);
    expect(confirmed.code, confirmed.message).toBeUndefined();
    expect(Number(confirmed.rows[0]!.moved)).toBe(1);
    const item = await itemRow(w.itemId);
    expect(item.status).toBe("succeeded");
    expect(item.confirmed_by).toBe(APP2);
    expect(item.confirmation_ref).toBe("BCA-911-OK");
    expect(item.confirmation_evidence_key).toBe(key);
    expect(item.settled_at).not.toBeNull();
  });

  it("[911-trusted-fn-recon-flagged-slip-held] a slip with a recon exception cannot be released for a retry: approve gives PAYOUT-62 and the item stays exported", async () => {
    const w = await exportedBatch();
    const key = await proposeAsOne(w, "failed");
    // The recon flag (what the night recon writes); the superuser stands in.
    await W.asTenant(
      (c) =>
        c.query(`SELECT app.payout_recon_flag($1, 'correction', $2, $3, $4)`, [
          W.tenantId,
          randomUUID(),
          w.itemId,
          "911 test: flagged slip",
        ]),
      true,
    );
    const grant = await TWO.grants.issue(
      resolveBinding(w, "approve", key, "failed"),
    );
    const refused = await appCall(
      RESOLVE_APPROVE,
      approveArgs(w, "failed", key, grant),
    );
    expect(refused.code, refused.message).toBeDefined();
    expect(refused.message).toMatch(/PAYOUT-62/);
    await expectStillProposed(w, "flagged slip");
  });

  it("[911-resolve-outcome-bound] a grant issued for failed cannot be spent on not_sent (propose or approve): PAYOUT-70, the grant stays unconsumed, nothing changes", async () => {
    const w = await exportedBatch();
    const key = await recordUpload(w.batchId);
    const failedGrant = await ONE.grants.issue(
      resolveBinding(w, "propose", key, "failed"),
    );
    expectGrantRefused(
      await appCall(RESOLVE_PROPOSE, [
        w.batchId,
        [w.itemId],
        "not_sent",
        key,
        NOTE,
        failedGrant,
      ]),
      "propose: failed grant spent on not_sent",
    );
    expect((await grantRow(failedGrant))!.consumed_at).toBeNull();
    expectUntouched(await itemRow(w.itemId), "outcome-bound propose");

    const approveWorld = await exportedBatch();
    const approveKey = await proposeAsOne(approveWorld, "failed");
    const approveGrant = await TWO.grants.issue(
      resolveBinding(approveWorld, "approve", approveKey, "failed"),
    );
    expectGrantRefused(
      await appCall(
        RESOLVE_APPROVE,
        approveArgs(approveWorld, "not_sent", approveKey, approveGrant),
      ),
      "approve: failed grant spent on not_sent",
    );
    expect((await grantRow(approveGrant))!.consumed_at).toBeNull();
    await expectStillProposed(approveWorld, "outcome-bound approve");
  });

  it("[911-resolve-legacy-step-one] a step one written before the cutover (by a superuser fixture, no grant, no attestation) cannot be approved: PAYOUT-71, the grant is not consumed and the item stays exported; it must be withdrawn and proposed again", async () => {
    const w = await exportedBatch();
    const key = await recordUpload(w.batchId);
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_items
              SET resolved_by = $3, resolution_outcome = 'failed',
                  resolution_evidence_key = $4, resolution_note = $5
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.itemId, APP, key, NOTE],
        ),
      true,
    );
    const grant = await TWO.grants.issue(
      resolveBinding(w, "approve", key, "failed"),
    );
    const refused = await appCall(
      RESOLVE_APPROVE,
      approveArgs(w, "failed", key, grant),
    );
    expect(refused.code, refused.message).toBeDefined();
    expect(refused.message).toMatch(/PAYOUT-71/);
    expect((await grantRow(grant))!.consumed_at).toBeNull();
    await expectStillProposed(w, "legacy step one");
  });

  it("[911-retry-overpaid-held-sql] a slip with an overpaid attempt gets no new attempt: inserting one (triggers on) gives PAYOUT-62 and the item count of the slip is unchanged", async () => {
    const w = await exportedBatch();
    // The slip's first attempt is failed (two people), then recorded overpaid
    // (two people, service path): it is settled by hand, never by a new attempt.
    await W.resolve(w.batchId, [w.itemId], "failed", APP);
    await W.resolve(w.batchId, [w.itemId], "failed", APP3);
    // The retry attempt is paid: only then is the first attempt a double
    // payment the service may record (assertOtherAttemptPaid).
    const retryBatch = await W.exportedBatch(w.runId);
    batchIds.push(retryBatch);
    await W.confirm(
      retryBatch,
      W.succeedItems(
        retryBatch,
        (await W.itemsOf(retryBatch)).filter((i) => i.status === "exported"),
      ),
    );
    const key = uploadEvidence(w.batchId, "mutasi-bank-911.pdf");
    const note = "Mutasi bank menunjukkan transfer ternyata berhasil";
    await W.proposeOverpaid(w.batchId, w.itemId, key, note, APP);
    await W.inTx((tx) =>
      recordOverpaidItems(
        tx,
        actorOf(APP),
        w.batchId,
        { itemIds: [w.itemId], evidenceKey: key, note },
        W.proofs(),
      ),
    );
    expect((await itemRow(w.itemId)).status, "premise: overpaid").toBe(
      "overpaid",
    );
    const slip = (
      await W.rowsOf(
        `SELECT payslip_id FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.itemId],
      )
    )[0]!.payslip_id as string;
    const countOf = async () =>
      count(
        `SELECT count(*)::int AS n FROM payroll_disbursement_items WHERE tenant_id = $1 AND payslip_id = $2`,
        [W.tenantId, slip],
      );
    const before = await countOf();

    // A new attempt can only join a draft batch (PAYOUT-11 comes first), so a
    // draft copy of the first batch (history, replica: no new payment) holds it.
    const draftBatch = await W.asTenant(async (c) => {
      await c.query(
        `CREATE TEMP TABLE draft_batch_clone ON COMMIT DROP AS
           SELECT * FROM payroll_disbursement_batches WHERE id = $1`,
        [w.batchId],
      );
      const { rows } = await c.query(
        `UPDATE draft_batch_clone
            SET id = gen_random_uuid(), status = 'draft', approved_by = NULL,
                approved_at = NULL, approval_expires_at = NULL, content_hash = NULL,
                exported_by = NULL, exported_at = NULL, export_checksum_sha256 = NULL,
                halt_reason = NULL
          RETURNING id`,
      );
      await c.query(
        `INSERT INTO payroll_disbursement_batches SELECT * FROM draft_batch_clone`,
      );
      return rows[0]!.id as string;
    }, true);
    batchIds.push(draftBatch);

    const attempt = await W.asTenant(async (c) => {
      try {
        await c.query(
          `CREATE TEMP TABLE retry_clone ON COMMIT DROP AS
             SELECT * FROM payroll_disbursement_items WHERE id = $1`,
          [w.itemId],
        );
        await c.query(
          `UPDATE retry_clone
              SET id = gen_random_uuid(), batch_id = '${draftBatch}'::uuid, attempt_no = 3, status = 'prepared',
                  idempotency_key = 'payslip:' || payslip_id::text || ':attempt:3',
                  settled_at = NULL, confirmed_by = NULL, confirmation_ref = NULL,
                  confirmation_evidence_key = NULL, resolved_by = NULL,
                  resolved_by_2 = NULL, resolution_outcome = NULL,
                  resolution_evidence_key = NULL, resolution_note = NULL,
                  failure_class = NULL, gl_posting_id = NULL`,
        );
        await c.query(
          `INSERT INTO payroll_disbursement_items SELECT * FROM retry_clone`,
        );
        return null;
      } catch (error) {
        return error as { code?: string; message?: string };
      }
    });
    expect(attempt, "the new attempt must be refused").not.toBeNull();
    expect(attempt!.message).toMatch(/PAYOUT-62/);
    expect(await countOf()).toBe(before);
  });

  it("[911-settle-fn] app.payout_run_settle: false while a slip has only a failed item (also when listed as zero net, because it has an item); true once every slip has a succeeded item and the batch is closed, and paid_by is the batch approver", async () => {
    // Two slips: Budi paid through the bank confirmation, Siti failed.
    const slips = [bank(BUDI, NET), bank(SITI, NET)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.exportedBatch(runId);
    batchIds.push(batchId);
    const items = await W.itemsOf(batchId);
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    await W.confirm(batchId, W.succeedItems(batchId, [budi]));
    await W.resolve(batchId, [siti.id as string], "failed", APP);
    await W.resolve(batchId, [siti.id as string], "failed", APP3);
    expect((await W.runRow(runId)).status, "premise: run locked").toBe(
      "locked",
    );

    const settle = async (zeroNet: string[]) => {
      const result = await appCall(RUN_SETTLE, [batchId, zeroNet]);
      expect(result.code, result.message).toBeUndefined();
      return result.rows[0]!.paid as boolean;
    };
    expect(await settle([]), "a failed slip blocks").toBe(false);
    expect(
      await settle([siti.payslip_id as string]),
      "a slip with an item is never zero net",
    ).toBe(false);
    expect((await W.runRow(runId)).status).toBe("locked");

    // True case: a single-slip run, confirmed through the trusted function
    // (it does not settle the run), batch closed by hand.
    const w = await exportedBatch();
    const grant = await CONFIRMER.grants.issue(confirmBinding(w));
    const confirmed = await appCall(BANK_CONFIRM, [
      w.batchId,
      [w.itemId],
      ["BCA-911-SETTLE"],
      [null],
      grant,
    ]);
    expect(confirmed.code, confirmed.message).toBeUndefined();
    expect((await W.runRow(w.runId)).status, "premise: not paid yet").toBe(
      "locked",
    );
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches SET status = 'completed' WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.batchId],
        ),
      true,
    );
    const result = await appCall(RUN_SETTLE, [w.batchId, []]);
    expect(result.code, result.message).toBeUndefined();
    expect(result.rows[0]!.paid).toBe(true);
    const run = await W.runRow(w.runId);
    expect(run.status).toBe("paid");
    expect(run.paid_at).not.toBeNull();
    expect(run.paid_by).toBe((await W.batchById(w.batchId)).approved_by);
  });

  it("[911-settle-generic-plan] app.payout_run_settle also works under a generic plan: the rapel reversal trigger reads the rapel tables as the payout role even when the status is not 'reversed'", async () => {
    // A custom plan folds `NEW.status = 'reversed'` to false and drops the EXISTS
    // over payroll_rapel_items / payroll_rapels; a generic plan keeps it, and the
    // permission check then needs SELECT for legend_payout on both tables.
    const w = await exportedBatch();
    const grant = await CONFIRMER.grants.issue(confirmBinding(w));
    const confirmed = await appCall(BANK_CONFIRM, [
      w.batchId,
      [w.itemId],
      ["BCA-911-GENERIC"],
      [null],
      grant,
    ]);
    expect(confirmed.code, confirmed.message).toBeUndefined();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_batches SET status = 'completed' WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.batchId],
        ),
      true,
    );
    const result = await appTx(async (c) => {
      await c.query("SET LOCAL plan_cache_mode = force_generic_plan");
      const r = await c.query(RUN_SETTLE, [w.batchId, []]);
      expect(r.rows[0]!.paid).toBe(true);
    });
    expect(result.code, result.message).toBeUndefined();
    expect((await W.runRow(w.runId)).status).toBe("paid");
  });

  it("[911-withdraw-clear-still-app] legend_app can still withdraw a step-one proposal: clearing the four proposal columns on an exported item with no step two succeeds and changes nothing else", async () => {
    const w = await exportedBatch();
    await W.resolve(w.batchId, [w.itemId], "failed", APP);
    expect((await itemRow(w.itemId)).resolved_by, "premise: proposed").toBe(
      APP,
    );

    const cleared = await appTx(async (c) => {
      await c.query(
        `UPDATE payroll_disbursement_items
            SET resolved_by = NULL, resolution_outcome = NULL,
                resolution_evidence_key = NULL, resolution_note = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.itemId],
      );
    });
    expect(cleared.code, cleared.message).toBeUndefined();
    expectUntouched(await itemRow(w.itemId), "after the withdraw clear");
  });

  it("[911-old-guc-ignored-owner] the old app.payout_settle setting is read nowhere: even the table owner with it set cannot mark a batched run paid (PAYOUT-22) or move an exported item out of exported; the payout role without it can mark the closed run paid", async () => {
    const w = await exportedBatch();
    const key = uploadEvidence(w.batchId, "911-owner-guc.pdf");
    await W.resolve(w.batchId, [w.itemId], "failed", APP, key);
    await W.resolve(w.batchId, [w.itemId], "failed", APP3, key);
    expect((await itemRow(w.itemId)).status, "premise: failed").toBe("failed");

    const ownerPaid = (guc: boolean) =>
      W.asTenant(async (c) => {
        if (guc)
          await c.query("SELECT set_config('app.payout_settle', 'on', true)");
        await c.query(
          `UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = 'forged'
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.runId],
        );
      }).then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string },
      );
    const plain = await ownerPaid(false);
    expect(plain?.message ?? "premise: refused").toMatch(/PAYOUT-22/);
    const withGuc = await ownerPaid(true);
    expect(withGuc, "the GUC is no key for the owner either").not.toBeNull();
    expect(withGuc!.message).toMatch(/PAYOUT-22/);
    expect((await W.runRow(w.runId)).status).toBe("locked");

    // An exported item of another batch: owner + GUC cannot move it.
    const x = await exportedBatch();
    const xKey = uploadEvidence(x.batchId, "911-owner-guc-item.pdf");
    const moved = await W.asTenant(async (c) => {
      await c.query("SELECT set_config('app.payout_settle', 'on', true)");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET resolved_by = $3, resolved_by_2 = $4, resolution_outcome = 'failed',
                resolution_evidence_key = $5, resolution_note = $6,
                failure_class = 'definitive', status = 'failed'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, x.itemId, APP, APP3, xKey, NOTE],
      );
    }).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );
    expect(moved, "owner + GUC cannot leave exported").not.toBeNull();
    expectUntouched(await itemRow(x.itemId), "owner + GUC");

    // Control: the payout role needs no GUC to mark the closed run paid.
    await W.asPayoutRole(async (c) => {
      await c.query(
        `UPDATE payroll_runs SET status = 'paid', paid_at = now(), paid_by = 'tester'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, w.runId],
      );
    });
    expect((await W.runRow(w.runId)).status).toBe("paid");
  });
});
