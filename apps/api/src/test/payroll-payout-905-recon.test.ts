// Payout 905 card 1, part C4: the nightly trusted-boundary recon (bead
// legend-i01jp; docs/briefs/905/brief.md "Rekonsiliasi detektif malam" and
// docs/briefs/905/design.md "Recon malam (C4)", "Yang tidak bisa dibuktikan SQL"
// and "Asumsi pemanggil"). Written fail-first from the brief, the design and the
// shared contract (finance exception kind `payout_recon_flag`), NOT from the
// implementation of the recon service.
//
// Rules proven here (founder: nobody is paid twice or without money moving; the
// GL matches what moved; when in doubt, hold the payment):
// - A legit corrected / overpaid / returned item (two people, two sessions, fresh
//   step-up, one binding, balanced journal, proof bytes unchanged) is not flagged.
// - Each difference the database cannot prove is caught by the night run and
//   becomes (1) a row of payroll_payout_recon_exceptions (insert-only, holds the
//   slip), (2) a finance exception of kind `payout_recon_flag`:
//     * the second attestation is missing,
//     * both attestations come from the same session,
//     * the journal of the transition does not exist,
//     * the journal was reversed,
//     * the proof file no longer matches the recorded hash.
// - A flagged slip cannot get a new batch (retry hold, no second payment).
// - An item changed before the trusted boundary (`app.payout_trusted_since()`),
//   which has no attestations by design, is skipped; the same shape after the
//   boundary is flagged (so the skip is the boundary, not blindness).
//
// Assumptions (the brief/design leave them open; stated so they can be contested):
// - ENTRY POINT. I did not read the recon service. `runRecon()` below is the one
//   adapter: it calls the first existing export of
//   `services/payroll-payout-recon.service.ts` among the names in RECON_EXPORTS
//   with one options object {tenantId, storage, context, scope, proofs}. If the
//   real name/signature differs, only `runRecon` needs to change. It must scan
//   the whole tenant and finish before it returns (no queue).
// - The attestation table is `payroll_payout_attestations` with columns
//   tenant_id, operation_id, step, item_ids (uuid[]), session_id, attested_at
//   (design "Peran (0644)"); the recon-exception table has tenant_id and
//   item_id (design "Asumsi pemanggil" C2); the proof tables are
//   payroll_payout_proof_bindings(evidence_key, tenant_id) and
//   payroll_payout_proof_hashes(binding_id, sha256 as 64 hex text).
// - The transition journal of an item is the posting `item.gl_posting_id`
//   (else the newest posting of its batch), found by `payroll_payout_gl_postings
//   .journal_key` -> `journal_entries.idempotency_key` (as in 905-gl-insert).
// - Age of an item for the boundary is judged by its `updated_at`/`settled_at`;
//   an item with status `overpaid` and no attestations counts as one of the
//   three kinds the recon scans.
// - The finance exception for a flag mentions the item id or the operation id
//   in refId/detail (checked on the JSON of the items, like 897/900 do for
//   `payout_proof_stuck`).
// - The retry-hold control calls `app.payout_recon_flag(tenant, 'correction',
//   <random op>, item, reason)` as the table owner with kind 'correction'.
// - Tampering is done as the table owner with `session_replication_role =
//   replica` (guards off), what a forger with write access to the rows could do;
//   that is exactly the gap the recon exists to close.
// - Not covered here: `posting_source` flags (needs the 0646 flow), and the job
//   registration (`payout-trusted-recon.job.ts`, like `payout-gl-recovery`).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import { totpCode, totpStep } from "../lib/totp.ts";
import { reverseJournal } from "../services/accounting-journal.service.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
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

const W = installPayoutWorld("905rec");
const PASSWORD = "Test-password-123!";
const NET = 1_000_000;
const BATCHES = "/api/hris/payroll/disbursement-batches";
const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
  "reconcilePayoutTrustedBoundary",
  "reconcilePayoutTrusted",
  "runPayoutReconciliation",
];

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];

// ---- People -----------------------------------------------------------------------

type Person = Awaited<ReturnType<typeof finance>>;

/** Signed in with the approve permission, TOTP enrolled in this very session. */
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Recon905 ${label}`);
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

// ---- Cleanup ------------------------------------------------------------------------

const trackedKeys: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);

afterEach(async () => {
  // 905: the proof rows of the keys are kept. Deleting a binding or a return
  // claim while the item still carries the key leaves an unbound operation in
  // app.payout_proof_operations(), and the global gate then holds every later
  // step (PAYOUT_PROOF_FINGERPRINT_PENDING), in this file and the next ones.
  trackedKeys.splice(0);
  await W.asTenant(async (c) => {
    // Insert-only rows of this file: every test starts without recon exceptions.
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
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

// ---- The recon (single adapter, see the header) ---------------------------------------

async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = RECON_EXPORTS.find((n) => typeof mod[n] === "function");
  expect(
    name,
    `payroll-payout-recon.service.ts must export the night run (one of ${RECON_EXPORTS.join(", ")}); it exports: ${Object.keys(mod).join(", ")}`,
  ).toBeDefined();
  const { storage } = W.proofs();
  // 905: the real night run is reconcileTrustedPayouts(context, options), one
  // page per call; page through the whole tenant before returning.
  const run = mod[name!] as (
    context: unknown,
    options: unknown,
  ) => Promise<{ operations: number; last: string | null }>;
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

// ---- Worlds ----------------------------------------------------------------------------

/** An exported batch of Budi, requested by the fixture requester. */
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

/** The only item was closed `failed` by two people. */
async function failedWorld() {
  const w = await exportedBatch();
  await W.resolve(w.batchId, [w.itemId], "failed", APP);
  await W.resolve(w.batchId, [w.itemId], "failed", APP3);
  expect((await itemOf(w.itemId)).status, "premise: failed").toBe("failed");
  return w;
}

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const itemCall = (
  who: Person,
  route: "correct-failed" | "overpaid" | "return",
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

/** Two different finance people take the two steps over one proof. */
async function twoSteps(
  route: "correct-failed" | "overpaid" | "return",
  w: { batchId: string; itemId: string },
) {
  const key = trackKey(uploadEvidence(w.batchId, `recon-${randomUUID()}.pdf`));
  const first = await itemCall(one, route, w.batchId, w.itemId, key);
  expect([200, 201], `${route} step 1 ${detail(first)}`).toContain(
    first.status,
  );
  const second = await itemCall(two, route, w.batchId, w.itemId, key);
  expect([200, 201], `${route} step 2 ${detail(second)}`).toContain(
    second.status,
  );
  return key;
}

/** A corrected item: failed, then corrected by two people. */
async function correctedWorld() {
  const w = await failedWorld();
  const key = await twoSteps("correct-failed", w);
  expect((await itemOf(w.itemId)).status, "premise: corrected").toBe(
    "succeeded",
  );
  return { ...w, key };
}
/** An overpaid item: failed on paper, but the money moved. */
async function overpaidWorld() {
  const w = await failedWorld();
  // 905: an overpaid record needs another succeeded attempt of the same slip
  // (PAYOUT_ITEM_NOT_OVERPAYABLE otherwise): a follow-up batch pays it first.
  const followUp = await W.exportedBatch(w.runId);
  const followItems = (await W.itemsOf(followUp)).filter(
    (i) => i.status === "exported",
  );
  expect(followItems, "premise: one follow-up attempt").toHaveLength(1);
  await W.confirm(followUp, W.succeedItems(followUp, followItems));
  const key = await twoSteps("overpaid", w);
  expect((await itemOf(w.itemId)).status, "premise: overpaid").toBe("overpaid");
  return { ...w, key };
}
/** A returned item: paid, then the bank returned the money. */
async function returnedWorld() {
  const w = await exportedBatch();
  await W.confirm(
    w.batchId,
    W.succeedItems(w.batchId, await W.itemsOf(w.batchId)),
  );
  expect((await itemOf(w.itemId)).status, "premise: succeeded").toBe(
    "succeeded",
  );
  const key = await twoSteps("return", w);
  expect((await itemOf(w.itemId)).status, "premise: returned").toBe("returned");
  return { ...w, key };
}

// ---- Observations ----------------------------------------------------------------------

const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, gl_posting_id, batch_id FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const exceptionsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const attestationsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${ATTESTATIONS}
      WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids) ORDER BY attested_at, step`,
    [W.tenantId, itemId],
  );
const financeFlags = async () => {
  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const result = await listFinanceExceptions(W.scope(), {
    from: day(-2),
    to: day(2),
    kind: "payout_recon_flag",
  } as never);
  return JSON.stringify(result.items);
};

/** A flag exists as a recon exception row and as a finance exception. */
async function expectFlagged(itemId: string, label: string) {
  const rows = await exceptionsOf(itemId);
  expect(
    rows.length,
    `${label}: recon exception row for the item`,
  ).toBeGreaterThan(0);
  const operations = (await attestationsOf(itemId)).map(
    (a) => a.operation_id as string,
  );
  const shown = await financeFlags();
  expect(
    [itemId, ...operations].some((id) => shown.includes(id)),
    `${label}: finance exception payout_recon_flag mentions the item or operation: ${shown}`,
  ).toBe(true);
}
async function expectNotFlagged(itemId: string, label: string) {
  expect(
    await exceptionsOf(itemId),
    `${label}: no recon exception`,
  ).toHaveLength(0);
  expect(await financeFlags(), `${label}: no finance exception`).not.toContain(
    itemId,
  );
}

// ---- Tampering (owner, guards off: the forger the recon exists for) --------------------

const tamper = (run: (c: import("pg").PoolClient) => Promise<unknown>) =>
  W.asTenant(run, true);

/** Deletes the later attestation(s): only the first step is on record. */
const dropSecondAttestation = (itemId: string) =>
  tamper((c) =>
    c.query(
      `DELETE FROM ${ATTESTATIONS}
        WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids)
          AND attested_at > (SELECT min(attested_at) FROM ${ATTESTATIONS}
                              WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids))`,
      [W.tenantId, itemId],
    ),
  );
/** Both steps appear to come from one session (one person with two hats). */
const sameSession = (itemId: string) =>
  tamper((c) =>
    c.query(
      `UPDATE ${ATTESTATIONS} SET session_id =
         (SELECT session_id FROM ${ATTESTATIONS}
           WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids)
           ORDER BY attested_at LIMIT 1)
        WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids)`,
      [W.tenantId, itemId],
    ),
  );
async function journalKeyOf(itemId: string) {
  const [row] = await W.rowsOf(
    `SELECT p.journal_key FROM payroll_payout_gl_postings p
      WHERE p.tenant_id = $1
        AND p.id = COALESCE(
              (SELECT i.gl_posting_id FROM payroll_disbursement_items i
                WHERE i.tenant_id = $1 AND i.id = $2),
              (SELECT p2.id FROM payroll_payout_gl_postings p2
                WHERE p2.tenant_id = $1 AND p2.batch_id =
                      (SELECT i.batch_id FROM payroll_disbursement_items i
                        WHERE i.tenant_id = $1 AND i.id = $2)
                ORDER BY p2.posted_at DESC LIMIT 1))`,
    [W.tenantId, itemId],
  );
  expect(
    row?.journal_key,
    "premise: the transition has a posted journal",
  ).toBeTruthy();
  return row!.journal_key as string;
}
const dropJournal = async (itemId: string) => {
  const key = await journalKeyOf(itemId);
  await tamper(async (c) => {
    await c.query(
      `DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id IN
         (SELECT id FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2)`,
      [W.tenantId, key],
    );
    await c.query(
      `DELETE FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
      [W.tenantId, key],
    );
  });
};
const reverseTheJournal = async (itemId: string) => {
  const key = await journalKeyOf(itemId);
  const [entry] = await W.rowsOf(
    `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS day FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key = $2`,
    [W.tenantId, key],
  );
  expect(
    entry,
    "premise: the journal exists before it is reversed",
  ).toBeDefined();
  await reverseJournal(
    W.scope(),
    entry!.id as string,
    {
      entryDate: entry!.day as string,
      reason: "Koreksi keuangan",
      idempotencyKey: `recon-${randomUUID()}`,
    },
    userIdSchema.parse(one.userId),
  );
};
/** The recorded hash of the proof no longer matches the stored file. */
const tamperProof = (key: string) =>
  tamper((c) =>
    c.query(
      `UPDATE payroll_payout_proof_hashes
          SET sha256 = md5(random()::text) || md5(random()::text)
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND evidence_key = $2)`,
      [W.tenantId, key],
    ),
  );

// =========================================================================
// Legit items are left alone
// =========================================================================

describe("905 recon: a legit trusted transition is not flagged", () => {
  it("[905-recon-clean-corrected] a failed item corrected by two people in two sessions: the night run flags nothing", async () => {
    const w = await correctedWorld();
    const attestations = await attestationsOf(w.itemId);
    expect(
      attestations.length,
      "premise: two attestations",
    ).toBeGreaterThanOrEqual(2);
    await runRecon();
    await expectNotFlagged(w.itemId, "corrected");
  });

  it("[905-recon-clean-overpaid] an overpaid item recorded by two people: the night run flags nothing", async () => {
    const w = await overpaidWorld();
    expect((await attestationsOf(w.itemId)).length).toBeGreaterThanOrEqual(2);
    await runRecon();
    await expectNotFlagged(w.itemId, "overpaid");
  });

  it("[905-recon-clean-returned] a returned item confirmed by two people: the night run flags nothing", async () => {
    const w = await returnedWorld();
    expect((await attestationsOf(w.itemId)).length).toBeGreaterThanOrEqual(2);
    await runRecon();
    await expectNotFlagged(w.itemId, "returned");
  });
});

// =========================================================================
// Every difference is a flag
// =========================================================================

describe("905 recon: a difference becomes a flag and a finance exception", () => {
  it("[905-recon-missing-second-attestation] a returned item with only one attestation: flagged (row and finance exception)", async () => {
    const w = await returnedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await dropSecondAttestation(w.itemId);
    expect((await attestationsOf(w.itemId)).length, "premise").toBe(1);
    await runRecon();
    await expectFlagged(w.itemId, "missing second attestation");
  });

  it("[905-recon-same-session] an overpaid item whose two attestations share one session: flagged", async () => {
    const w = await overpaidWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await sameSession(w.itemId);
    const sessions = new Set(
      (await attestationsOf(w.itemId)).map((a) => a.session_id),
    );
    expect(sessions.size, "premise: one session").toBe(1);
    await runRecon();
    await expectFlagged(w.itemId, "same session");
  });

  it("[905-recon-no-journal] a corrected item whose journal does not exist: flagged", async () => {
    const w = await correctedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await dropJournal(w.itemId);
    await runRecon();
    await expectFlagged(w.itemId, "no journal");
  });

  it("[905-recon-reversed-journal] a corrected item whose journal was reversed: flagged", async () => {
    const w = await correctedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the reversal");

    await reverseTheJournal(w.itemId);
    await runRecon();
    await expectFlagged(w.itemId, "reversed journal");
  });

  it("[905-recon-tampered-proof] a corrected item whose recorded proof hash no longer matches the stored file: flagged", async () => {
    const w = await correctedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await tamperProof(w.key);
    await runRecon();
    await expectFlagged(w.itemId, "tampered proof");
  });
});

// =========================================================================
// The flagged slip is held
// =========================================================================

describe("905 recon: a flagged slip is held from a new batch", () => {
  it("[905-recon-flag-holds-slip] a failed slip can get a follow-up batch; once a recon flag exists for it, the follow-up batch is refused and no batch appears", async () => {
    const control = await failedWorld();
    const ok = await W.httpFailure(
      W.inTx((tx) =>
        createDisbursementBatch(tx, actorOf(REQ), {
          payrollRunId: control.runId,
          channel: "manual_bank",
        } as never),
      ),
    );
    expect(ok, "control: a failed slip without flag can be retried").toBeNull();

    const held = await failedWorld();
    await tamper((c) =>
      c.query(`SELECT app.payout_recon_flag($1, 'correction', $2, $3, $4)`, [
        W.tenantId,
        randomUUID(),
        held.itemId,
        "recon test: forged transition",
      ]),
    );
    expect(
      (await exceptionsOf(held.itemId)).length,
      "premise: the flag is on record",
    ).toBeGreaterThan(0);
    const batchesBefore = (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM payroll_disbursement_batches
          WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [W.tenantId, held.runId],
      )
    )[0]!.n;
    await W.expectRefused(
      W.inTx((tx) =>
        createDisbursementBatch(tx, actorOf(REQ), {
          payrollRunId: held.runId,
          channel: "manual_bank",
        } as never),
      ),
      { status: 409 },
    );
    expect(
      (
        await W.rowsOf(
          `SELECT count(*)::int AS n FROM payroll_disbursement_batches
            WHERE tenant_id = $1 AND payroll_run_id = $2`,
          [W.tenantId, held.runId],
        )
      )[0]!.n,
      "no new batch for the held slip",
    ).toBe(batchesBefore);
  });
});

// =========================================================================
// Before the boundary
// =========================================================================

describe("905 recon: items from before the trusted boundary", () => {
  it("[905-recon-pre-boundary-skipped] an overpaid item last changed before app.payout_trusted_since() has no attestations and is skipped; the same shape after the boundary is flagged", async () => {
    const old = await failedWorld();
    const fresh = await failedWorld();
    const [since] = await W.rowsOf(
      `SELECT app.payout_trusted_since() AS since`,
    );
    expect(since?.since, "premise: the boundary exists").toBeTruthy();

    // Both look like an overpaid item that nobody attested (the legacy shape);
    // only one of them is older than the boundary.
    await tamper(async (c) => {
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'overpaid',
                settled_at = $3::timestamptz - interval '2 days',
                updated_at = $3::timestamptz - interval '2 days'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, old.itemId, since!.since],
      );
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'overpaid', settled_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, fresh.itemId],
      );
    });
    // The resolve to failed (911) is itself attested (kind 'resolve'); the
    // legacy shape is an overpaid item without an 'overpaid' attestation.
    const overpaidAttestations = async (itemId: string) =>
      (await attestationsOf(itemId)).filter((a) => a.kind === "overpaid");
    expect(
      await overpaidAttestations(old.itemId),
      "premise: legacy, no overpaid attestations",
    ).toHaveLength(0);
    expect(await overpaidAttestations(fresh.itemId)).toHaveLength(0);

    await runRecon();
    await expectNotFlagged(old.itemId, "pre-boundary item");
    await expectFlagged(
      fresh.itemId,
      "post-boundary item without attestations",
    );
  });
});

// =========================================================================
// Step grants (legend-911 design-p1-1 4.11)
// =========================================================================

describe("911 recon: attestations after the grant cutover need their grant", () => {
  it("[911-recon-grant] a clean granted operation gives zero flags; a grant whose actor was changed gives grant_mismatch and holds the slip", async () => {
    const w = await correctedWorld();
    const [since] = await W.rowsOf(`SELECT app.payout_grants_since() AS since`);
    const checked = (await attestationsOf(w.itemId)).filter(
      (a) => (a.attested_at as Date) >= (since!.since as Date),
    );
    expect(
      checked.length,
      "premise: attestations at or after the grant cutover",
    ).toBeGreaterThanOrEqual(2);
    expect(
      checked.every((a) => a.grant_id !== null),
      "premise: every one of them has a grant",
    ).toBe(true);
    await runRecon();
    await expectNotFlagged(w.itemId, "clean granted operation");

    const grantId = checked[0]!.grant_id as string;
    const actorOfGrant = async () =>
      (
        await W.rowsOf(
          `SELECT actor FROM payroll_payout_grants WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, grantId],
        )
      )[0]!.actor as string;
    const original = await actorOfGrant();
    try {
      // Superuser fixture, FK and guard triggers off for this statement only.
      await tamper((c) =>
        c.query(
          `UPDATE payroll_payout_grants SET actor = $3 WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, grantId, randomUUID()],
        ),
      );
      await runRecon();
      await expectFlagged(w.itemId, "grant actor changed");
      const rows = await exceptionsOf(w.itemId);
      expect(
        rows.map((r) => r.reason),
        "reason of the flag",
      ).toContain("grant_mismatch");
      expect(
        rows.every((r) => r.payslip_id !== null),
        "the flag carries the payslip, so the slip is held",
      ).toBe(true);
    } finally {
      await tamper((c) =>
        c.query(
          `UPDATE payroll_payout_grants SET actor = $3 WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, grantId, original],
        ),
      );
    }
  });
});
