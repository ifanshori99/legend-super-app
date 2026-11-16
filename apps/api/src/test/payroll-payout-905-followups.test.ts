// Payout 905 follow-ups P2-1, P2-2 and P2-4 of the first architect review
// (docs/briefs/905/design.md "Review awal architect", migration 0415). Written
// fail-first from that review and the design, not from the implementation.
// Everything adversarial runs as the app role (`SET LOCAL ROLE legend_app`) with
// a REAL COMMIT, so the database is what is proven, not the service.
//
// Rules proven here (founder: the GL matches the money that moved; nobody is
// paid twice; when in doubt, limit the payment):
// - P2-1 [905-fu-insert-*]. A cash posting inserted straight into the table by
//   the app role cannot carry a source account that is neither written by the
//   payout role nor the account the tenant mapped (petty cash, 1102). Neither as
//   a held posting nor as a settled one with a journal Dr 2103 / Cr <foreign>.
//   Control: the mapped account commits.
// - P2-2 [905-fu-correction-*]. Approving a correction must come with a settle
//   posting of THAT operation's item set. A settle posting of other items in the
//   same batch does not satisfy the commit check. Control: the legitimate
//   two-person HTTP correction (also of two items at once) commits and journals.
// - P2-4 [905-fu-closed-key-*]. An item whose first resolve step recorded a proof
//   key that is later closed (stuck proof, two-person closure) cannot be moved to
//   `failed` / `not_sent` (which frees the slip for a retry batch) by the second
//   step. Control: an open key finishes the same resolve.
//
// Assumptions (the review leaves them open, stated so they can be contested):
// - A refusal of an insert is guard code 23514 at statement or COMMIT (as the
//   other 905 files); the proof is also the end state (nothing stays).
// - The cash origin the tenant mapped is petty cash 1102 (as 905-gl-insert); the
//   foreign accounts used are 1101 and 1103 (active cash-and-equivalent
//   accounts that are not the mapping). A held posting with source NULL stays
//   legal, so it is not asserted here.
// - Trusted functions are called as `app.payout_correction_approve(operation
//   uuid, key varchar, grant text)` (911: the grant carries actor and session),
//   with a grant of the second finance person and a live MFA session from
//   `payoutActorSession`; the permission checked is `payroll.disburse.approve`.
//   The call is first proven to be accepted (rolled back), so a refusal of the
//   COMMIT can only come from the missing posting.
// - P2-4: the refusal of the second resolve step is any 4xx and the item stays
//   `exported` (status quo), whatever the code (409 expected).
// - Not covered: the recon part of P2-1 (its exception shape is not in the
//   design) and P2-3 (scope, separate bead).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../lib/http-error.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP2,
  APP3,
  ANDI,
  BUDI,
  CASHIER,
  SITI,
  bank,
  cash,
  installPayoutWorld,
  payoutActorSession,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("905fu");
const tenantId = () => W.tenantId;
const GUARD_CODE = "23514";
const PASSWORD = "Test-password-123!";
const NET = 1_000_000;
const NET_CASH = 750_000;
const BATCHES = "/api/hris/payroll/disbursement-batches";
const PROOFS = "/api/hris/payroll/payout-proofs";
const STUCK = "payroll_payout_proof_backfill_stuck";
const CLOSURES = "payroll_payout_proof_closures";
const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";
const NOTE_CLOSE =
  "Bukti macet, file tidak bisa dibaca lagi, kasus ditutup permanen";

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];

// ---- People (HTTP, TOTP enrolled in this very session) -------------------------

type Person = Awaited<ReturnType<typeof finance>>;
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Followup905 ${label}`);
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

// ---- Cleanup --------------------------------------------------------------------

const trackedKeys: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);

afterEach(async () => {
  const keys = trackedKeys.splice(0);
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
});

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- legend_app helpers (patterns of 905-gl-insert) -------------------------------

type Outcome = { code: string | undefined; message: string };
/** A legend_app transaction; real COMMIT unless `rollback`; the first error (statement or commit), if any. */
async function appTx(
  work: (client: PoolClient) => Promise<void>,
  rollback = false,
): Promise<Outcome> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId()],
    );
    try {
      await work(client);
      await client.query(rollback ? "ROLLBACK" : "COMMIT");
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

type Line = { accountId: string; debit: number; credit: number };
type Header = { sourceType: string; sourceId: string | null };
let periodId = "";
const accountIds: Record<string, string> = {};
const accountOf = (code: string) => accountIds[code]!;
beforeAll(async () => {
  for (const code of ["1101", "1102", "1103", "2103"])
    accountIds[code] = (
      await W.rowsOf(
        `SELECT id FROM chart_of_accounts
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
        [tenantId(), W.entityId(), code],
      )
    )[0]!.id as string;
  periodId = (
    await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
});

async function insertEntry(client: PoolClient, key: string, header: Header) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 905 followup test',
             NULL, $6, $7)
     RETURNING id`,
    [
      tenantId(),
      W.entityId(),
      periodId,
      header.sourceType,
      header.sourceId,
      key,
      randomBytes(32).toString("hex"),
    ],
  );
  return rows[0]!.id;
}
async function addLines(client: PoolClient, entryId: string, lines: Line[]) {
  const values = lines
    .map(
      (_, i) =>
        `($1, $2, $${i * 3 + 3}, ${1 + i}, $${i * 3 + 4}, $${i * 3 + 5}, NULL)`,
    )
    .join(", ");
  await client.query(
    `INSERT INTO journal_lines
       (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
     VALUES ${values}`,
    [
      tenantId(),
      entryId,
      ...lines.flatMap((l) => [l.accountId, l.debit, l.credit]),
    ],
  );
}

const SETTLE_KEY = (hash: string) => `payroll-payout:${hash}`;
const postingRowsByHash = (hash: string) =>
  W.rowsOf(
    `SELECT id, kind, source_gl_account_id FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND item_set_hash = $2`,
    [tenantId(), hash],
  );

// =========================================================================
// P2-1: a cash posting's source is the mapped account or the payout role's
// =========================================================================

/** A normally settled cash posting (lock journal present, source = petty cash 1102): the template to copy. */
async function settledCash() {
  const slips = [cash(CASHIER, NET_CASH)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await W.handover(batchId, itemIds, APP2);
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: settled").toBe("settle");
  expect(
    posting!.source_gl_account_id,
    "premise: source is the mapped petty cash",
  ).toBe(accountOf("1102"));
  const [entry] = await W.rowsOf(
    `SELECT source_type, source_id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId(), W.entityId(), posting!.journal_key],
  );
  expect(entry, "premise: the real settle journal exists").toBeDefined();
  return {
    posting: posting!,
    header: {
      sourceType: entry!.source_type as string,
      sourceId: (entry!.source_id as string | null) ?? null,
    } as Header,
  };
}

/** Insert, as the app role, a copy of the template with a new hash/key, kind and source account. */
async function insertCashPosting(
  ctx: Awaited<ReturnType<typeof settledCash>>,
  options: { kind: "settle" | "settle_pending"; sourceCode: string },
  hash = randomBytes(32).toString("hex"),
) {
  const outcome = await appTx(async (client) => {
    const columns = (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'
            AND is_generated = 'NEVER' ORDER BY ordinal_position`,
      )
    ).rows.map((r) => r.column_name);
    const values: Record<string, string> = {
      id: "gen_random_uuid()",
      item_set_hash: `'${hash}'`,
      journal_key: `'${SETTLE_KEY(hash)}'`,
      kind: `'${options.kind}'`,
      source_gl_account_id: `'${accountOf(options.sourceCode)}'::uuid`,
    };
    await client.query(
      `INSERT INTO payroll_payout_gl_postings (${columns.map((c) => `"${c}"`).join(", ")})
       SELECT ${columns.map((c) => values[c] ?? `"${c}"`).join(", ")}
         FROM payroll_payout_gl_postings WHERE id = $1`,
      [ctx.posting.id],
    );
    if (options.kind === "settle") {
      const entry = await insertEntry(client, SETTLE_KEY(hash), ctx.header);
      await addLines(client, entry, [
        { accountId: accountOf("2103"), debit: NET_CASH, credit: 0 },
        {
          accountId: accountOf(options.sourceCode),
          debit: 0,
          credit: NET_CASH,
        },
      ]);
    }
  });
  return { hash, ...outcome };
}

describe("905 follow-up P2-1: a cash posting inserted by the app role names only the mapped source", () => {
  it("[905-fu-insert-cash-foreign-source-held] INSERT a held cash posting whose source is an account the tenant did not map (1101, 1103) as legend_app: refused (23514) and the posting does not stay", async () => {
    const ctx = await settledCash();
    for (const code of ["1101", "1103"]) {
      const result = await insertCashPosting(ctx, {
        kind: "settle_pending",
        sourceCode: code,
      });
      expect(result.code, `${code}: a foreign source is refused`).toBe(
        GUARD_CODE,
      );
      expect(await postingRowsByHash(result.hash)).toHaveLength(0);
    }
  });

  it("[905-fu-insert-cash-foreign-source-settled] INSERT a settled cash posting with its own journal Dr 2103 / Cr <foreign account> for the net: the COMMIT fails (23514); no posting and no journal stay", async () => {
    const ctx = await settledCash();
    for (const code of ["1101", "1103"]) {
      const result = await insertCashPosting(ctx, {
        kind: "settle",
        sourceCode: code,
      });
      expect(
        result.code,
        `${code}: cash cannot be journaled out of an unmapped account`,
      ).toBe(GUARD_CODE);
      expect(await postingRowsByHash(result.hash)).toHaveLength(0);
      expect(await W.countJournals(SETTLE_KEY(result.hash))).toBe(0);
    }
  });

  it("[905-fu-insert-cash-mapped-source-control] control: the same settled posting with the mapped petty cash 1102 commits once, journal Dr 2103 / Cr 1102 for the net; replaying the same keys adds nothing", async () => {
    const ctx = await settledCash();
    const first = await insertCashPosting(ctx, {
      kind: "settle",
      sourceCode: "1102",
    });
    expect(first.code, first.message).toBeUndefined();
    expect(await postingRowsByHash(first.hash)).toHaveLength(1);
    expect(await W.journalByKey(SETTLE_KEY(first.hash))).toEqual({
      "2103": { debit: NET_CASH, credit: 0 },
      "1102": { debit: 0, credit: NET_CASH },
    });

    const replay = await insertCashPosting(
      ctx,
      { kind: "settle", sourceCode: "1102" },
      first.hash,
    );
    expect(replay.code, "same keys are refused").toBeDefined();
    expect(await postingRowsByHash(first.hash)).toHaveLength(1);
    expect(await W.countJournals(SETTLE_KEY(first.hash))).toBe(1);
  });
});

// =========================================================================
// P2-2: the correction commit check wants the posting of ITS item set
// =========================================================================

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const itemCall = (
  who: Person,
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/correct-failed`)
    .set(originHeader)
    .send({
      itemIds,
      evidenceKey,
      note: NOTE_ITEM,
      password: PASSWORD,
    }) as unknown as Promise<Res>;

const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, gl_posting_id, resolution_evidence_key
         FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), itemId],
    )
  )[0]!;
const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const payoutJournals = () =>
  count(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key LIKE 'payroll-payout%'`,
    [tenantId(), W.entityId()],
  );
const postingsCount = (batchId: string) =>
  count(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND batch_id = $2`,
    [tenantId(), batchId],
  );

/**
 * A batch of three bank slips, exported: Andi is paid (succeeded: the batch has
 * a settle posting of its own), Budi and Siti are closed `failed` by two people.
 */
async function mixedBatch() {
  const slips = [bank(BUDI, NET), bank(SITI, NET), bank(ANDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  const idOf = (p: { id: string }) =>
    items.find((i) => i.employee_id === p.id)!.id as string;
  const budi = idOf(BUDI);
  const siti = idOf(SITI);
  const andi = idOf(ANDI);
  await W.confirm(
    batchId,
    W.succeedItems(
      batchId,
      items.filter((i) => i.id === andi),
    ),
  );
  for (const id of [budi, siti]) {
    await W.resolve(batchId, [id], "failed", APP);
    await W.resolve(batchId, [id], "failed", APP3);
  }
  expect((await itemOf(andi)).status, "premise: Andi paid").toBe("succeeded");
  expect((await itemOf(budi)).status, "premise: Budi failed").toBe("failed");
  expect((await itemOf(siti)).status, "premise: Siti failed").toBe("failed");
  const postings = await W.postingsOf(batchId);
  expect(
    postings.filter((p) => p.kind === "settle"),
    "premise: the batch already has a settle posting (Andi's)",
  ).not.toHaveLength(0);
  return { runId, batchId, budi, siti, andi };
}

describe("905 follow-up P2-2: approving a correction needs the settle posting of its own items", () => {
  it("[905-fu-correction-needs-own-posting] the second step is taken in SQL (trusted function, a real person and live session) and the transaction commits without the correction's own settle posting although the batch has another settle posting: the COMMIT fails (23514); Budi stays failed, the correction stays proposed, no journal", async () => {
    const w = await mixedBatch();
    const key = trackKey(uploadEvidence(w.batchId, `fu-${randomUUID()}.pdf`));
    const first = await itemCall(one, w.batchId, [w.budi], key);
    expect([200, 201], detail(first)).toContain(first.status);
    expect(first.body.data).toMatchObject({ stage: "proposed" });
    const [correction] = await W.rowsOf(
      `SELECT operation_id, evidence_key, status FROM payroll_payout_failed_corrections
        WHERE tenant_id = $1 AND item_id = $2`,
      [tenantId(), w.budi],
    );
    expect(correction!.status, "premise: proposed").toBe("proposed");
    const session = await payoutActorSession(tenantId(), two.userId);
    // 911: one grant, issued by the grantor login before the payout
    // transaction. A rolled-back call leaves it unconsumed, so the premise run
    // and the real run use the same one.
    const grant = await session.grants.issue({
      kind: "correction",
      step: "approve",
      batchId: w.batchId,
      itemIds: [w.budi],
      evidenceKey: correction!.evidence_key as string,
      refId: correction!.operation_id as string,
      targetId: null,
    });
    const approve = async (client: PoolClient) => {
      await client.query(
        `SELECT app.payout_correction_approve($1::uuid, $2::varchar, $3::text)`,
        [correction!.operation_id, correction!.evidence_key, grant],
      );
    };
    const accepted = await appTx(approve, true);
    expect(
      accepted,
      "premise: the trusted function accepts the second person (rolled back)",
    ).toEqual({ code: undefined, message: "" });

    const journalsBefore = await payoutJournals();
    const postingsBefore = await postingsCount(w.batchId);
    const result = await appTx(approve);

    expect(
      result.code,
      `another item's settle posting is not this correction's journal: ${result.message}`,
    ).toBe(GUARD_CODE);
    expect((await itemOf(w.budi)).status).toBe("failed");
    expect(
      (
        await W.rowsOf(
          `SELECT status FROM payroll_payout_failed_corrections WHERE tenant_id = $1 AND item_id = $2`,
          [tenantId(), w.budi],
        )
      )[0]!.status,
    ).toBe("proposed");
    expect(await payoutJournals()).toBe(journalsBefore);
    expect(await postingsCount(w.batchId)).toBe(postingsBefore);
  });

  // 905: the correction contract takes one item per operation (shared
  // validator: itemIds max 1), so the control corrects one failed item.
  it("[905-fu-correction-two-items-control] control: one failed item corrected over HTTP by two people commits: it is succeeded with ONE new settle posting and its journal; the other failed item and Andi's earlier posting are untouched", async () => {
    const w = await mixedBatch();
    const key = trackKey(uploadEvidence(w.batchId, `fu-${randomUUID()}.pdf`));
    const ids = [w.budi];
    const postingsBefore = await postingsCount(w.batchId);
    const journalsBefore = await payoutJournals();
    const andiPosting = (await itemOf(w.andi)).gl_posting_id;

    const first = await itemCall(one, w.batchId, ids, key);
    expect([200, 201], detail(first)).toContain(first.status);
    const second = await itemCall(two, w.batchId, ids, key);
    expect([200, 201], detail(second)).toContain(second.status);

    expect((await itemOf(w.budi)).status).toBe("succeeded");
    expect((await itemOf(w.siti)).status, "not in the operation").toBe(
      "failed",
    );
    expect((await itemOf(w.andi)).status).toBe("succeeded");
    expect(await postingsCount(w.batchId), "one posting for the item").toBe(
      postingsBefore + 1,
    );
    expect(
      await payoutJournals(),
      "the correction journaled (principal; the fee may add one)",
    ).toBeGreaterThan(journalsBefore);
    const budiPosting = (await itemOf(w.budi)).gl_posting_id;
    expect(budiPosting).not.toBeNull();
    expect((await itemOf(w.siti)).gl_posting_id).toBeNull();
    expect(
      (await itemOf(w.andi)).gl_posting_id,
      "Andi keeps his own posting",
    ).toBe(andiPosting);
    expect(andiPosting).not.toBe(budiPosting);
  });
});

// =========================================================================
// P2-4: a closed key does not free the slip for a retry
// =========================================================================

async function exportedBatch() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  return {
    runId,
    batchId,
    itemId: (await W.itemsOf(batchId))[0]!.id as string,
  };
}

const gate = async () =>
  (
    await W.rowsOf(
      `SELECT app.payout_proof_history_pending() AS history_pending`,
    )
  )[0]!.history_pending as boolean;

/** Closes the proof key as the stuck-proof procedure does: a stuck row, then two people (propose, approve). */
async function closeKey(batchId: string, key: string) {
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason, attempts)
         VALUES ($1, $2, $3, 'unreadable', 3)`,
        [tenantId(), batchId, key],
      ),
    true,
  );
  const proposed = (await one.client
    .post(`${PROOFS}/closures`)
    .set(originHeader)
    .send({
      evidenceKey: key,
      note: NOTE_CLOSE,
      password: PASSWORD,
    })) as unknown as Res;
  expect([200, 201], detail(proposed)).toContain(proposed.status);
  const approved = (await two.client
    .post(`${PROOFS}/closures/${proposed.body.data!.closureId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD })) as unknown as Res;
  expect([200, 201], detail(approved)).toContain(approved.status);
  expect(approved.body.data, "premise: closed").toMatchObject({
    stage: "closed",
  });
}

describe("905 follow-up P2-4: a closed proof key cannot finish a resolve that frees the slip", () => {
  for (const outcome of ["failed", "not_sent"] as const) {
    it(`[905-fu-closed-key-resolve-${outcome}] the first resolve step recorded key K, then K is closed (gate clear): the second person's ${outcome} is refused (4xx) and the item stays exported; control: an open key finishes the same resolve`, async () => {
      const w = await exportedBatch();
      const key = trackKey(
        uploadEvidence(w.batchId, `fu-closed-${randomUUID()}.pdf`),
      );
      await W.resolve(w.batchId, [w.itemId], outcome, APP, key);
      const afterFirst = await itemOf(w.itemId);
      expect(afterFirst.status, "premise: one step is not final").toBe(
        "exported",
      );
      expect(
        afterFirst.resolution_evidence_key,
        "premise: step 1 recorded the key",
      ).toBe(key);

      await closeKey(w.batchId, key);
      expect(await gate(), "premise: the gate is clear again").toBe(false);

      // 905: W.resolve calls the service directly, so the Express mapper that
      // turns the guard's 23514 into 409 (payoutGuardErrorMapper) is not in
      // the path. Either form is the refusal: the PAYOUT-72 message of the
      // 0415(c) guard, or an HttpError with code PAYOUT_GUARD_REFUSED.
      const refusal = (await W.resolve(
        w.batchId,
        [w.itemId],
        outcome,
        APP3,
        key,
      ).then(
        () => null,
        (error: unknown) => error,
      )) as {
        status?: number;
        code?: string;
        message?: string;
        cause?: { code?: string; message?: string };
      } | null;
      expect(refusal, "the call must be refused").not.toBeNull();
      const refusedHttp =
        refusal instanceof HttpError && refusal.code === "PAYOUT_GUARD_REFUSED";
      const refusedPg =
        (refusal?.message?.includes("PAYOUT-72") ?? false) ||
        (refusal?.cause?.message?.includes("PAYOUT-72") ?? false);
      expect(
        refusedHttp || refusedPg,
        `PAYOUT-72 or PAYOUT_GUARD_REFUSED: ${String(refusal)}`,
      ).toBe(true);
      const after = await itemOf(w.itemId);
      expect(after.status, "the slip is not released for a retry").toBe(
        "exported",
      );
      expect(after.gl_posting_id).toBeNull();

      // Control: another batch, an open key, the same two steps finish.
      const open = await exportedBatch();
      const openKey = trackKey(
        uploadEvidence(open.batchId, `fu-open-${randomUUID()}.pdf`),
      );
      await W.resolve(open.batchId, [open.itemId], outcome, APP, openKey);
      await W.resolve(open.batchId, [open.itemId], outcome, APP3, openKey);
      expect((await itemOf(open.itemId)).status).not.toBe("exported");
    });
  }
});
