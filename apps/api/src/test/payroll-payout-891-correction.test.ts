// Payout 891 (bead legend-mejr2; brief scratchpad b888/brief891.md, CTO decision
// "option B"): a `failed` item whose bank result turns out to be a SUCCESS, with
// no later payment for the same slip, is corrected to `succeeded` without paying
// the employee a second time. Written fail-first over HTTP from the brief, not
// from the implementation: the route
// POST /api/hris/payroll/disbursement-batches/:id/correct-failed does not exist.
//
// Rules proven here (founder: nobody is paid twice, the PT is not short, the GL
// matches the money that moved):
// - Same access chain as the overpaid route: `payroll.disburse.approve`, a
//   trusted origin, step-up with the password, strict body.
// - Two different people: the first call is stage `proposed` (the item stays
//   `failed`, nothing booked), the second (other person, SAME evidence) is
//   stage `corrected`: the item becomes `succeeded` and ONE settle journal
//   (Dr frozen salaries payable 2103 / Cr source bank 1103, the net) plus the
//   fee journal (Dr 8101 / Cr 1103) are booked. No `overpaid` posting, no new
//   item, batch or payment.
// - Neither person may be a person who resolved the item `failed`
//   (resolved_by, resolved_by_2) nor the requester of the batch (403).
// - Only a failed item with a final resolution, of the URL batch, with NO
//   other live/succeeded item for the same payslip (open retry, paid retry,
//   replacement item in another batch): else 409 PAYOUT_ITEM_NOT_CORRECTABLE
//   (a paid sibling is the overpaid path).
// - The proof is bound to ONE correction and is refused when it is already a
//   return claim, an overpaid proposal or another correction: 409
//   PAYOUT_PROOF_REUSED (legend-so897: one code for the three operations).
// - After a correction no retry/follow-up batch can be created (409, never 500).
// - A correction racing a retry: exactly one wins. Two corrections racing: one
//   journal. Replays book nothing more.
// - Accounting off or the lock journal not posted yet: the settlement is
//   `settle_pending` (never the final `settle_skipped`) and resolves exactly
//   once when the lock journal posts.
// - DB guard: `failed -> succeeded` is refused (23514) without an approved
//   (`corrected`) correction row, also with the transaction setting
//   app.payout_correction=on.
//
// Assumptions (the brief is silent, stated so they can be contested):
// - Response `data`: { batchStatus: string, stage: "proposed"|"corrected",
//   corrected: number, proposed: number } (the CTO contract).
// - Table payroll_payout_failed_corrections has columns tenant_id, item_id,
//   status, proposed_by, corrected_by, evidence_key, as in the contract.
// - The corrected item gets its own settle posting (new row in
//   payroll_payout_gl_postings, kind `settle`), whose journal has the same
//   shape as an ordinary settle (journal_key) plus the fee journal keyed
//   `payroll-payout-fee:<item_set_hash>`; the transfer fee (Rp5.000 for a "014"
//   bank) is booked like any settled bank transfer because the money moved.
// - Every call carries exactly ONE item: a call with several items and a
//   single proof would need the proof bound to several corrections.
// - A DEAD replacement (a retry that itself ended `failed`) is not a "live or
//   succeeded" sibling, so the first item stays correctable.
// - A call where both the proposer and the approver of a stage are refused for
//   being a resolver of the item is 403 for either resolution step person.
// - Reusing a correction proof as a return proof is refused with some 4xx
//   (the code is not pinned).
// - Under "accounting off + lock event still queued" the correction is accepted
//   and stored as `settle_pending` (brief: follow the existing pending pattern).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { originHeader } from "./helpers.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  exportManualBatch,
  returnManualItems,
} from "../services/payroll-payout-manual.service.ts";
import { settleBatchPayouts } from "../services/payroll-payout-gl.service.ts";
import {
  __resetRecoveryCursorsForTest,
  runPayoutGlRecoverySweep,
} from "../worker/payout-gl-recovery.job.ts";
import {
  ANDI,
  APP,
  APP2,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  runTotals,
  uploadEvidence,
  type Person,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("correction-891");
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const BASE = "/api/hris/payroll/disbursement-batches";
const NOW = new Date("2026-11-30T03:00:00Z");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const TOTAL = BUDI_NET + SITI_NET + ANDI_NET;
const FEE = 5_000;
const slipsOf = () => [
  bank(BUDI, BUDI_NET),
  bank(SITI, SITI_NET),
  bank(ANDI, ANDI_NET),
];
const idOf = (row: Row) => row.id as string;
const errorCodeOf = (body: { error?: { code?: string } }) => body.error?.code;

beforeEach(() => {
  __resetRecoveryCursorsForTest();
});

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- HTTP people (same shape as the overpaid route test) ---------------------

/**
 * A staff member with payroll.disburse.approve whose only second-factor proof
 * is the enrollment itself, so the password is the real step-up.
 */
async function approverClient(label: string) {
  const { client, userId } = await W.signedInClient(`Correct ${label}`);
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
type Approver = Awaited<ReturnType<typeof approverClient>>;
const trio = async (label: string) => ({
  requester: await approverClient(`${label} Requester`),
  first: await approverClient(`${label} First`),
  second: await approverClient(`${label} Second`),
});

// ---- Ledger -------------------------------------------------------------------

const CODES = ["1103", "2103", "8101", "1204"] as const;
type Balance = { debit: number; credit: number };
type Books = Record<(typeof CODES)[number], Balance>;
const untouched: Balance = { debit: 0, credit: 0 };
async function account(code: string): Promise<Balance> {
  const [row] = await W.rowsOf(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS debit,
            COALESCE(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND a.code = $3`,
    [W.tenantId, W.entityId(), code],
  );
  return { debit: Number(row!.debit), credit: Number(row!.credit) };
}
async function books(): Promise<Books> {
  const out = {} as Books;
  for (const code of CODES) out[code] = await account(code);
  return out;
}
function movedSince(before: Books, after: Books): Books {
  const out = {} as Books;
  for (const code of CODES)
    out[code] = {
      debit: after[code].debit - before[code].debit,
      credit: after[code].credit - before[code].credit,
    };
  return out;
}
/** Every journal line of the PT balances: total debits equal total credits. */
async function expectLedgerBalanced() {
  const [row] = await W.rowsOf(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS debit,
            COALESCE(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  expect(row!.debit, "the GL stays balanced").toBe(row!.credit);
}

// ---- Observations -------------------------------------------------------------

const countOf = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
// The settle key is `payroll-payout:<hash>` (colon), the fee, return and overpaid
// keys are `payroll-payout-...` (hyphen): count both families.
const payoutJournals = async () =>
  (await W.countJournals("payroll-payout:%")) +
  (await W.countJournals("payroll-payout-%"));
const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
const runCounts = async (runId: string) => ({
  items: await countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_items WHERE payroll_run_id = $1`,
    [runId],
  ),
  batches: await countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches WHERE payroll_run_id = $1`,
    [runId],
  ),
});
/** Items of the slip of this person that took (or may take) the money out. */
const moneyOutItems = (runId: string, person: Person) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_items
      WHERE payroll_run_id = $1 AND employee_id = $2
        AND status IN ('succeeded', 'overpaid')`,
    [runId, person.id],
  );
const correctionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM payroll_payout_failed_corrections
      WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const reverseRun = (runId: string) =>
  W.rowsOf(
    `UPDATE payroll_runs SET status = 'reversed', reversal = $2::jsonb WHERE id = $1`,
    [
      runId,
      JSON.stringify({
        status: "approved",
        reason: "Uji langsung lewat SQL",
        requestedBy: "req-user",
        requestedAt: "2041-11-30T00:00:00.000Z",
        decidedBy: "dec-user",
        decidedAt: "2041-11-30T00:01:00.000Z",
      }),
    ],
  );
const kindPostings = (batchId: string, kind: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND batch_id = $2 AND kind = $3`,
    [W.tenantId, batchId, kind],
  );

// ---- Accounting switch ----------------------------------------------------------

async function tenantFlags() {
  const rows = await W.owner.query(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [W.tenantId],
  );
  return rows.rows[0]!.flags as { modules: string[] } & Record<string, unknown>;
}
async function setFlags(flags: unknown) {
  await W.owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [W.tenantId, JSON.stringify(flags)],
  );
}
async function withAccountingOff<T>(work: () => Promise<T>) {
  const original = await tenantFlags();
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await setFlags({
    ...original,
    modules: original.modules.filter((m) => m !== "accounting"),
  });
  try {
    return await work();
  } finally {
    await setFlags(original);
  }
}

// ---- Lock journal queued (the consumer has not run yet) ------------------------

function lockedEnvelope(runId: string, slips: Slip[]) {
  const lockedAt = "2026-10-26T05:00:00.000Z";
  return payrollLocked.envelopeSchema.parse({
    id: createUlid(),
    tenantId: W.tenantId,
    outletId: null,
    name: "payroll.locked",
    version: 1,
    aggregateType: "payroll",
    aggregateId: runId,
    sequence: 1,
    occurredAt: lockedAt,
    actor: { type: "user", id: randomUUID() },
    deviceId: null,
    idempotencyKey: `payroll.locked-${runId}-${randomUUID()}`,
    payloadSchemaRef: "payroll.locked.v1",
    payload: {
      payrollRunId: runId,
      legalEntityId: W.entityId(),
      runType: "regular",
      periodStart: "2026-09-26",
      periodEnd: "2026-10-25",
      payDate: "2026-10-27",
      totals: runTotals(slips),
      lockedBy: randomUUID(),
      lockedAt,
    },
  });
}
async function queueLockedEvent(runId: string, slips: Slip[]) {
  const event = lockedEnvelope(runId, slips);
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO domain_event_outbox
           (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
         VALUES ($1, $2, NULL, $3, 'payroll', $4, 1, $5, 'cloud-sync')`,
        [W.tenantId, randomUUID(), randomUUID(), runId, JSON.stringify(event)],
      ),
    true,
  );
  return event;
}

// ---- Worlds ---------------------------------------------------------------------

const currentSourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;

type WorldOptions = {
  /** People whose transfer is resolved `failed` by two people. Default Budi. */
  failed?: Person[];
  /** People whose item stays `exported` (no bank result yet). */
  open?: Person[];
  /** The two people who resolve the failed items (default pseudo ids). */
  resolvers?: [string, string];
  /** "posted" = lock journal in the GL; "queued" = event waiting in the outbox. */
  lock?: "posted" | "queued";
};

/**
 * Batch 1 created by a REAL user (the requester), approved by APP, exported.
 * Failed people are resolved failed by two people, the others are paid.
 * `before` is the ledger before the run, so a test can judge the whole run.
 */
async function failedWorld(requester: Approver, options: WorldOptions = {}) {
  const failed = options.failed ?? [BUDI];
  const open = options.open ?? [];
  const [resolverOne, resolverTwo] = options.resolvers ?? [APP, APP3];
  const slips = slipsOf();
  const before = await books();
  const runId = await W.seedRun(slips);
  let event: ReturnType<typeof lockedEnvelope> | undefined;
  if (options.lock === "queued") event = await queueLockedEvent(runId, slips);
  else await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [batch] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = batch!.id as string;
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requester.userId), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const sourceBankAccountId = await currentSourceBank();
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId,
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  const of = (p: Person) => items.find((i) => i.employee_id === p.id)!;
  const isIn = (list: Person[], i: Row) =>
    list.some((p) => p.id === i.employee_id);
  const paid = items.filter((i) => !isIn(failed, i) && !isIn(open, i));
  if (paid.length > 0) await W.confirm(batchId, W.succeedItems(batchId, paid));
  const failedIds = failed.map((p) => idOf(of(p)));
  if (failedIds.length > 0) {
    await W.resolve(batchId, failedIds, "failed", resolverOne);
    await W.resolve(batchId, failedIds, "failed", resolverTwo);
  }
  return {
    runId,
    batchId,
    before,
    event,
    slips,
    budi: idOf(of(BUDI)),
    siti: idOf(of(SITI)),
    andi: idOf(of(ANDI)),
  };
}
type World = Awaited<ReturnType<typeof failedWorld>>;

// ---- HTTP calls -----------------------------------------------------------------

type CallOptions = {
  /** undefined = the right password; null = no password in the body. */
  password?: string | null;
  file?: string;
  evidenceKey?: string;
};
const correctBody = (
  batchId: string,
  itemIds: string[],
  options: CallOptions = {},
) => ({
  itemIds,
  evidenceKey:
    options.evidenceKey ??
    uploadEvidence(batchId, options.file ?? "koreksi.pdf"),
  note: "Mutasi bank menunjukkan transfer ternyata berhasil, tidak ada transfer lain",
  ...(options.password === null
    ? {}
    : { password: options.password ?? PASSWORD }),
});
const postCorrect = (
  who: Approver,
  batchId: string,
  itemIds: string[],
  options: CallOptions = {},
) =>
  who.client
    .post(`${BASE}/${batchId}/correct-failed`)
    .set(originHeader)
    .send(correctBody(batchId, itemIds, options));

type Res = Awaited<ReturnType<typeof postCorrect>>;
type Data = {
  batchStatus?: string;
  stage?: string;
  corrected?: number;
  proposed?: number;
};
const dataOf = (res: Res) => (res.body.data ?? {}) as Data;
const expectProposed = (res: Res) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(dataOf(res).stage).toBe("proposed");
};
const expectCorrected = (res: Res) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(dataOf(res).stage).toBe("corrected");
};
/** A refusal by the product itself: 4xx, and not "no such route". */
const expectRefused = (res: Res, label = "") => {
  expect(
    res.status,
    `${label} ${JSON.stringify(res.body)}`,
  ).toBeGreaterThanOrEqual(400);
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBeLessThan(500);
  expect(
    [404, 405],
    `${label}: the route must exist, got ${res.status}`,
  ).not.toContain(res.status);
};
const expectForbidden = (res: Res, label = "") =>
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(403);
const expectNotCorrectable = (res: Res, label = "") => {
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(409);
  expect(errorCodeOf(res.body), label).toBe("PAYOUT_ITEM_NOT_CORRECTABLE");
};
const expectProofReused = (res: Res, label = "") => {
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(409);
  expect(errorCodeOf(res.body), label).toBe("PAYOUT_PROOF_REUSED");
};

// ---- State checks -----------------------------------------------------------------

async function snapshotOf(world: World) {
  return {
    journals: await payoutJournals(),
    postings: (await W.postingsOf(world.batchId)).map(idOf),
    counts: await runCounts(world.runId),
    books: await books(),
  };
}
type Snapshot = Awaited<ReturnType<typeof snapshotOf>>;

/** Nothing happened: the item is `failed`, no correction row, nothing booked or created. */
async function expectUntouched(
  world: World,
  itemId: string,
  snapshot: Snapshot,
  person: Person = BUDI,
) {
  expect((await W.itemOfPerson(world.batchId, person)).status).toBe("failed");
  expect(await correctionRows(itemId), "no correction row").toHaveLength(0);
  expect(await payoutJournals(), "no journal").toBe(snapshot.journals);
  expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
    snapshot.postings,
  );
  expect(await runCounts(world.runId)).toEqual(snapshot.counts);
  expect(await books(), "no ledger line").toEqual(snapshot.books);
}

/** The exact books of one correction on top of `snapshot`, each exactly once. */
async function expectCorrectionBooksOnce(world: World, snapshot: Snapshot) {
  expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("succeeded");
  const fresh = (await W.postingsOf(world.batchId)).filter(
    (p) => !snapshot.postings.includes(idOf(p)),
  );
  expect(fresh, "one new settle posting for the corrected item").toHaveLength(
    1,
  );
  const posting = fresh[0]!;
  expect(posting.kind).toBe("settle");
  expect(await W.journalByKey(posting.journal_key as string)).toEqual({
    "2103": { debit: BUDI_NET, credit: 0 },
    "1103": { debit: 0, credit: BUDI_NET },
  });
  expect(await W.countJournals(posting.journal_key as string)).toBe(1);
  expect(await W.journalByKey(feeKey(posting))).toEqual({
    "8101": { debit: FEE, credit: 0 },
    "1103": { debit: 0, credit: FEE },
  });
  expect(await W.countJournals(feeKey(posting))).toBe(1);
  expect(await payoutJournals(), "exactly the settle and the fee journal").toBe(
    snapshot.journals + 2,
  );
  const moved = movedSince(snapshot.books, await books());
  expect(moved["2103"], "the frozen salary debt is paid off once").toEqual({
    debit: BUDI_NET,
    credit: 0,
  });
  expect(moved["1103"], "source bank credited net + fee once").toEqual({
    debit: 0,
    credit: BUDI_NET + FEE,
  });
  expect(moved["8101"]).toEqual({ debit: FEE, credit: 0 });
  expect(moved["1204"], "no receivable: nobody is paid twice").toEqual(
    untouched,
  );
  expect(await kindPostings(world.batchId, "overpaid")).toBe(0);
  // Nothing was paid by the API: no new item, batch; one money-out item.
  expect(await runCounts(world.runId)).toEqual(snapshot.counts);
  expect(await moneyOutItems(world.runId, BUDI)).toBe(1);
  await expectLedgerBalanced();
  return posting;
}

// =========================================================================
// access and step-up
// =========================================================================

describe("correcting a failed transfer over HTTP: access and step-up (legend-mejr2)", () => {
  it("[891-permission] without payroll.disburse.approve it is 403 and changes nothing", async () => {
    const { requester, first } = await trio("Perm");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);
    const viewer = await W.signedInClient("Correct Viewer");
    await W.grantRole(viewer.userId, ["payroll.view"]);

    const res = await viewer.client
      .post(`${BASE}/${world.batchId}/correct-failed`)
      .set(originHeader)
      .send(correctBody(world.batchId, [world.budi]));
    expectForbidden(res);
    await expectUntouched(world, world.budi, snap);

    // Control: a permitted person gets through, so the 403 was the permission.
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
  });

  it("[891-origin] a request from an untrusted origin is refused and records nothing", async () => {
    const { requester, first, second } = await trio("Origin");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    const res = await first.client
      .post(`${BASE}/${world.batchId}/correct-failed`)
      .set({ Origin: "https://evil.example" })
      .send(correctBody(world.batchId, [world.budi]));
    expectForbidden(res);
    await expectUntouched(world, world.budi, snap);
    // No first step was recorded: the next person's call is a first step.
    expectProposed(await postCorrect(second, world.batchId, [world.budi]));
  });

  it("[891-stepup] without the password (enrollment only) it is 401 REAUTH_REQUIRED, with a wrong password refused, and no first step is recorded; the second step without it is refused too", async () => {
    const { requester, first, second } = await trio("Step");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    const without = await postCorrect(first, world.batchId, [world.budi], {
      password: null,
    });
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
    const wrong = await postCorrect(first, world.batchId, [world.budi], {
      password: WRONG_PASSWORD,
    });
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
    await expectUntouched(world, world.budi, snap);

    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    const noPassword = await postCorrect(second, world.batchId, [world.budi], {
      password: null,
    });
    expect(noPassword.status, JSON.stringify(noPassword.body)).toBe(401);
    expect(errorCodeOf(noPassword.body)).toBe("REAUTH_REQUIRED");
    const wrongSecond = await postCorrect(second, world.batchId, [world.budi], {
      password: WRONG_PASSWORD,
    });
    expect([401, 403], JSON.stringify(wrongSecond.body)).toContain(
      wrongSecond.status,
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await payoutJournals()).toBe(snap.journals);

    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));
    await expectCorrectionBooksOnce(world, snap);
  });

  it("[891-strict-body] an unknown field, a bad item list, a missing or oversized evidence key or note is refused and records nothing", async () => {
    const { requester, first } = await trio("Body");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);
    const send = (body: Record<string, unknown>) =>
      first.client
        .post(`${BASE}/${world.batchId}/correct-failed`)
        .set(originHeader)
        .send(body);
    const good = correctBody(world.batchId, [world.budi]);

    expectRefused(await send({ ...good, payAgain: true }), "unknown field");
    expectRefused(await send({ ...good, itemIds: [] }), "empty items");
    expectRefused(
      await send({ ...good, itemIds: [world.budi, world.budi] }),
      "same item twice",
    );
    expectRefused(
      await send({ ...good, itemIds: ["not-a-uuid"] }),
      "not a uuid",
    );
    expectRefused(
      await send({
        ...good,
        itemIds: Array.from({ length: 51 }, () => randomUUID()),
      }),
      "more than 50 items",
    );
    const noEvidence: Record<string, unknown> = { ...good };
    delete noEvidence.evidenceKey;
    expectRefused(await send(noEvidence), "no evidence");
    const noNote: Record<string, unknown> = { ...good };
    delete noNote.note;
    expectRefused(await send(noNote), "no note");
    expectRefused(
      await send({ ...good, note: "x".repeat(501) }),
      "note longer than 500",
    );
    expectRefused(
      await send({ ...good, evidenceKey: "k".repeat(201) }),
      "evidence key longer than 200",
    );
    await expectUntouched(world, world.budi, snap);

    // Control: the same request without the defect is a first step.
    expectProposed(await send(good));
  });
});

// =========================================================================
// the correction itself
// =========================================================================

describe("correcting a failed transfer over HTTP: two different people (legend-mejr2)", () => {
  it("[891-correct-success] the first person only proposes, the second corrects: item succeeded, ONE settle journal and the fee, the salary debt closed, no overpaid row, no new payment", async () => {
    const { requester, first, second } = await trio("Success");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);
    // Premise: the failed item carries nothing in the books yet.
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await moneyOutItems(world.runId, BUDI)).toBe(0);

    const one = await postCorrect(first, world.batchId, [world.budi]);
    expectProposed(one);
    expect(dataOf(one)).toMatchObject({ proposed: 1, corrected: 0 });
    expect(typeof dataOf(one).batchStatus).toBe("string");
    expect(
      (await W.itemOfPerson(world.batchId, BUDI)).status,
      "one person is not enough",
    ).toBe("failed");
    expect(await payoutJournals(), "a proposal books nothing").toBe(
      snap.journals,
    );
    expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
      snap.postings,
    );
    const [proposal] = await correctionRows(world.budi);
    expect(proposal).toMatchObject({
      status: "proposed",
      proposed_by: first.userId,
    });

    const two = await postCorrect(second, world.batchId, [world.budi]);
    expectCorrected(two);
    expect(dataOf(two)).toMatchObject({ corrected: 1 });
    expect(typeof dataOf(two).batchStatus).toBe("string");
    const posting = await expectCorrectionBooksOnce(world, snap);
    const [row] = await correctionRows(world.budi);
    expect(row).toMatchObject({
      status: "corrected",
      proposed_by: first.userId,
      corrected_by: second.userId,
    });
    expect(row!.evidence_key).toBe(
      uploadEvidence(world.batchId, "koreksi.pdf"),
    );
    expect(await correctionRows(world.siti)).toHaveLength(0);
    expect((await W.itemOfPerson(world.batchId, BUDI)).gl_posting_id).toBe(
      posting.id,
    );

    // The whole run: the lock debt (2103) is closed, the bank paid the three
    // nets and three fees, nothing else.
    const run = movedSince(world.before, await books());
    expect(run["2103"]).toEqual({ debit: TOTAL, credit: TOTAL });
    expect(run["1103"]).toEqual({ debit: 0, credit: TOTAL + 3 * FEE });
    expect(run["8101"]).toEqual({ debit: 3 * FEE, credit: 0 });
    expect(run["1204"]).toEqual(untouched);
    // The paid siblings are untouched.
    expect((await W.itemOfPerson(world.batchId, SITI)).status).toBe(
      "succeeded",
    );
    expect((await W.itemOfPerson(world.batchId, ANDI)).status).toBe(
      "succeeded",
    );
  });

  it("[891-same-person] the same person twice, and the requester in either step, never complete it", async () => {
    const { requester, first, second } = await trio("Same");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    expectForbidden(
      await postCorrect(requester, world.batchId, [world.budi]),
      "requester as first step",
    );
    await expectUntouched(world, world.budi, snap);

    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    expectForbidden(
      await postCorrect(first, world.batchId, [world.budi]),
      "the same person twice",
    );
    expectForbidden(
      await postCorrect(requester, world.batchId, [world.budi]),
      "requester as second step",
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await payoutJournals()).toBe(snap.journals);

    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));
    await expectCorrectionBooksOnce(world, snap);
  });

  it("[891-resolver-forbidden] the people who resolved the item failed can neither propose nor approve its correction (403); two other people can", async () => {
    const resolverOne = await approverClient("Res One");
    const resolverTwo = await approverClient("Res Two");
    const { requester, first, second } = await trio("Res");
    const world = await failedWorld(requester, {
      resolvers: [resolverOne.userId, resolverTwo.userId],
    });
    const snap = await snapshotOf(world);
    const [stored] = await W.rowsOf(
      `SELECT resolved_by, resolved_by_2 FROM payroll_disbursement_items WHERE id = $1`,
      [world.budi],
    );
    expect([stored!.resolved_by, stored!.resolved_by_2].sort()).toEqual(
      [resolverOne.userId, resolverTwo.userId].sort(),
    );

    expectForbidden(
      await postCorrect(resolverOne, world.batchId, [world.budi]),
      "first resolver proposes",
    );
    expectForbidden(
      await postCorrect(resolverTwo, world.batchId, [world.budi]),
      "second resolver proposes",
    );
    await expectUntouched(world, world.budi, snap);

    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    expectForbidden(
      await postCorrect(resolverOne, world.batchId, [world.budi]),
      "first resolver approves",
    );
    expectForbidden(
      await postCorrect(resolverTwo, world.batchId, [world.budi]),
      "second resolver approves",
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await payoutJournals()).toBe(snap.journals);

    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));
    await expectCorrectionBooksOnce(world, snap);
  });

  it("[891-evidence-mismatch] the second step with other evidence than the first is refused and the item stays failed; the same evidence passes", async () => {
    const { requester, first, second } = await trio("Evidence");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    expectProposed(
      await postCorrect(first, world.batchId, [world.budi], {
        file: "mutasi-a.pdf",
      }),
    );
    expectRefused(
      await postCorrect(second, world.batchId, [world.budi], {
        file: "mutasi-b.pdf",
      }),
      "another evidence key",
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await payoutJournals()).toBe(snap.journals);
    expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
      snap.postings,
    );

    expectCorrected(
      await postCorrect(second, world.batchId, [world.budi], {
        file: "mutasi-a.pdf",
      }),
    );
    await expectCorrectionBooksOnce(world, snap);
  });
});

// =========================================================================
// the proof is bound to one correction
// =========================================================================

describe("correcting a failed transfer over HTTP: a proof is used once (legend-mejr2)", () => {
  it("[891-proof-reuse-return] a proof that started a return of another item cannot back a correction: 409 PAYOUT_PROOF_REUSED, nothing recorded; another proof works", async () => {
    const { requester, first } = await trio("ReuseRet");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);
    const key = uploadEvidence(world.batchId, "dana-kembali.pdf");
    await W.inTx((tx) =>
      returnManualItems(
        tx,
        actorOf(APP),
        world.batchId,
        {
          itemIds: [world.siti],
          evidenceKey: key,
          note: "Bank mengembalikan dana, rekening tujuan ditutup",
        } as never,
        W.proofs(),
      ),
    );
    const afterReturnStart = await snapshotOf(world);

    expectProofReused(
      await postCorrect(first, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await correctionRows(world.budi)).toHaveLength(0);
    expect(await payoutJournals()).toBe(afterReturnStart.journals);
    expect(snap.counts).toEqual(afterReturnStart.counts);

    expectProposed(
      await postCorrect(first, world.batchId, [world.budi], {
        file: "bukti-lain.pdf",
      }),
    );
  });

  it("[891-proof-reuse-correction] a proof bound to one correction (even only proposed) cannot back another item's correction; it still completes its own", async () => {
    const { requester, first, second } = await trio("ReuseCor");
    const world = await failedWorld(requester, { failed: [BUDI, ANDI] });
    const snap = await snapshotOf(world);
    const key = uploadEvidence(world.batchId, "satu-bukti.pdf");

    expectProposed(
      await postCorrect(first, world.batchId, [world.andi], {
        evidenceKey: key,
      }),
    );
    expectProofReused(
      await postCorrect(second, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
      "another item, same proof, other person",
    );
    expectProofReused(
      await postCorrect(first, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
      "another item, same proof, same person",
    );
    expect(await correctionRows(world.budi)).toHaveLength(0);
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");

    // The proof still completes the correction it is bound to.
    expectCorrected(
      await postCorrect(second, world.batchId, [world.andi], {
        evidenceKey: key,
      }),
    );
    expect((await W.itemOfPerson(world.batchId, ANDI)).status).toBe(
      "succeeded",
    );
    // After the correction is final the proof is still used.
    expectProofReused(
      await postCorrect(first, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
      "after the correction is final",
    );
    expect(await correctionRows(world.budi)).toHaveLength(0);
    // Exactly one correction was booked.
    expect(await payoutJournals()).toBe(snap.journals + 2);
    const moved = movedSince(snap.books, await books());
    expect(moved["2103"]).toEqual({ debit: ANDI_NET, credit: 0 });
    expect(moved["1103"]).toEqual({ debit: 0, credit: ANDI_NET + FEE });
  });

  it("[891-proof-reuse-overpaid] a proof of an overpaid proposal cannot back a correction: 409 PAYOUT_PROOF_REUSED, nothing recorded; another proof works", async () => {
    const { requester, first, second } = await trio("ReuseOver");
    const world = await failedWorld(requester, { failed: [BUDI, ANDI] });
    // A follow-up batch for both; Andi's retry is paid, Budi's retry fails again:
    // Andi's first item is a double transfer (overpaid path), Budi's first item
    // has only a dead replacement left (still correctable, see assumptions).
    const followUp = await W.exportedBatch(world.runId);
    const followItems = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    expect(followItems).toHaveLength(2);
    const andiRetry = followItems.find((i) => i.employee_id === ANDI.id)!;
    const budiRetry = followItems.find((i) => i.employee_id === BUDI.id)!;
    await W.confirm(followUp, W.succeedItems(followUp, [andiRetry]));
    await W.resolve(followUp, [idOf(budiRetry)], "failed", APP);
    await W.resolve(followUp, [idOf(budiRetry)], "failed", APP3);
    const snap = await snapshotOf(world);
    const key = uploadEvidence(world.batchId, "mutasi-ganda.pdf");

    const overpaid = await first.client
      .post(`${BASE}/${world.batchId}/overpaid`)
      .set(originHeader)
      .send({
        itemIds: [world.andi],
        evidenceKey: key,
        note: "Mutasi bank menunjukkan transfer pertama ternyata berhasil",
        password: PASSWORD,
      });
    expect(overpaid.status, JSON.stringify(overpaid.body)).toBe(200);

    expectProofReused(
      await postCorrect(second, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await correctionRows(world.budi)).toHaveLength(0);
    expect(await payoutJournals()).toBe(snap.journals);

    // Control: with another proof Budi's first item is correctable.
    expectProposed(
      await postCorrect(second, world.batchId, [world.budi], {
        file: "bukti-budi.pdf",
      }),
    );
  });

  it("[891-proof-reuse-overpaid-reverse] a proof bound to a correction cannot back the overpaid record of another item: 409 PAYOUT_PROOF_REUSED, nothing recorded; another proof works", async () => {
    const { requester, first, second } = await trio("ReuseOverRev");
    const world = await failedWorld(requester, { failed: [BUDI, ANDI] });
    const followUp = await W.exportedBatch(world.runId);
    const followItems = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    const andiRetry = followItems.find((i) => i.employee_id === ANDI.id)!;
    const budiRetry = followItems.find((i) => i.employee_id === BUDI.id)!;
    await W.confirm(followUp, W.succeedItems(followUp, [andiRetry]));
    await W.resolve(followUp, [idOf(budiRetry)], "failed", APP);
    await W.resolve(followUp, [idOf(budiRetry)], "failed", APP3);
    const key = uploadEvidence(world.batchId, "bukti-koreksi-budi.pdf");
    expectProposed(
      await postCorrect(first, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
    );
    const snap = await snapshotOf(world);
    const overpaid = (who: Approver, evidenceKey: string) =>
      who.client
        .post(`${BASE}/${world.batchId}/overpaid`)
        .set(originHeader)
        .send({
          itemIds: [world.andi],
          evidenceKey,
          note: "Mutasi bank menunjukkan transfer pertama ternyata berhasil",
          password: PASSWORD,
        });

    const refused = await overpaid(second, key);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCodeOf(refused.body)).toBe("PAYOUT_PROOF_REUSED");
    expect((await W.itemOfPerson(world.batchId, ANDI)).status).toBe("failed");
    expect(
      await countOf(
        `SELECT count(*)::int AS n FROM payroll_payout_overpaid_proposals
          WHERE tenant_id = $1 AND item_id = $2`,
        [W.tenantId, world.andi],
      ),
    ).toBe(0);
    expect(await payoutJournals()).toBe(snap.journals);

    // Control: another proof starts the overpaid record.
    const ok = await overpaid(
      second,
      uploadEvidence(world.batchId, "mutasi-ganda-andi.pdf"),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("[891-proof-reuse-reverse] a proof bound to a correction cannot start a return of another item (refused, item stays succeeded)", async () => {
    const { requester, first } = await trio("ReuseRev");
    const world = await failedWorld(requester);
    const key = uploadEvidence(world.batchId, "bukti-koreksi.pdf");
    expectProposed(
      await postCorrect(first, world.batchId, [world.budi], {
        evidenceKey: key,
      }),
    );
    const journals = await payoutJournals();

    await W.expectRefused(
      W.inTx((tx) =>
        returnManualItems(
          tx,
          actorOf(APP),
          world.batchId,
          {
            itemIds: [world.siti],
            evidenceKey: key,
            note: "Bank mengembalikan dana, rekening tujuan ditutup",
          } as never,
          W.proofs(),
        ),
      ),
    );
    expect((await W.itemOfPerson(world.batchId, SITI)).status).toBe(
      "succeeded",
    );
    expect(await payoutJournals()).toBe(journals);
  });
});

// =========================================================================
// which items can be corrected
// =========================================================================

describe("correcting a failed transfer over HTTP: only a failed item with no later payment (legend-mejr2)", () => {
  for (const sibling of ["draft", "open", "paid"] as const) {
    it(`[891-later-payment-${sibling}] ${
      {
        draft:
          "a replacement item exists in a follow-up batch not yet exported",
        open: "the retry batch is exported, not confirmed",
        paid: "the retry is paid (the overpaid path)",
      }[sibling]
    }: 409 PAYOUT_ITEM_NOT_CORRECTABLE for both people, nothing booked`, async () => {
      const { requester, first, second } = await trio(`Later ${sibling}`);
      const world = await failedWorld(requester);
      if (sibling === "draft") await W.createBatch(world.runId);
      else {
        const followUp = await W.exportedBatch(world.runId);
        if (sibling === "paid") {
          const retry = (await W.itemsOf(followUp)).filter(
            (i) => i.status === "exported",
          );
          expect(retry).toHaveLength(1);
          await W.confirm(followUp, W.succeedItems(followUp, retry));
        }
      }
      const snap = await snapshotOf(world);
      const retryCounts = await runCounts(world.runId);

      expectNotCorrectable(
        await postCorrect(first, world.batchId, [world.budi]),
        "first step",
      );
      expectNotCorrectable(
        await postCorrect(second, world.batchId, [world.budi]),
        "second step",
      );
      expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
      expect(await correctionRows(world.budi)).toHaveLength(0);
      expect(await payoutJournals()).toBe(snap.journals);
      expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
        snap.postings,
      );
      expect(await runCounts(world.runId)).toEqual(retryCounts);
    });
  }

  it("[891-later-payment-after-proposal] proposed first, then the retry is paid: the second step is re-checked and refused 409, the item stays failed, nothing is booked", async () => {
    const { requester, first, second } = await trio("LaterProp");
    const world = await failedWorld(requester);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));

    const followUp = await W.exportedBatch(world.runId);
    const retry = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    expect(retry).toHaveLength(1);
    await W.confirm(followUp, W.succeedItems(followUp, retry));
    const snap = await snapshotOf(world);

    expectNotCorrectable(
      await postCorrect(second, world.batchId, [world.budi]),
    );
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(
      (await correctionRows(world.budi)).filter(
        (r) => r.status === "corrected",
      ),
    ).toHaveLength(0);
    expect(await payoutJournals()).toBe(snap.journals);
    expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
      snap.postings,
    );
    // Budi was paid once (the retry); the overpaid path is the way forward.
    expect(await moneyOutItems(world.runId, BUDI)).toBe(1);
  });

  it("[891-run-reversed] the run was reversed (its period freed for a rerun): both steps are refused 409 PAYOUT_RUN_NOT_PAYABLE and the database refuses the flip too; nothing is booked", async () => {
    const { requester, first, second } = await trio("Reversed");
    const world = await failedWorld(requester, {
      failed: [BUDI, SITI, ANDI],
    });
    // The first step happened while the run was still locked.
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    await reverseRun(world.runId);
    const snap = await snapshotOf(world);

    const late = await postCorrect(second, world.batchId, [world.budi]);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(errorCodeOf(late.body)).toBe("PAYOUT_RUN_NOT_PAYABLE");
    const fresh = await postCorrect(first, world.batchId, [world.siti]);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(409);
    expect(errorCodeOf(fresh.body)).toBe("PAYOUT_RUN_NOT_PAYABLE");
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect((await correctionRows(world.budi))[0]!.status).toBe("proposed");
    expect(await correctionRows(world.siti)).toHaveLength(0);
    expect(await payoutJournals()).toBe(snap.journals);
    expect(await books()).toEqual(snap.books);

    // Database net: an approved correction row on a reversed run still cannot
    // move the item (everything else the guard asks for is in place).
    const error = await W.asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_payout_failed_corrections
            SET status = 'corrected', corrected_by = 'sql-approver', corrected_at = now()
          WHERE tenant_id = $1 AND item_id = $2`,
        [W.tenantId, world.budi],
      );
      await c.query("SELECT set_config('app.payout_correction', 'on', true)");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(),
                confirmed_by = 'sql-approver', confirmation_ref = 'SQL-REF',
                confirmation_evidence_key = (
                  SELECT evidence_key FROM payroll_payout_failed_corrections
                   WHERE tenant_id = $1 AND item_id = $2)
          WHERE id = $2`,
        [W.tenantId, world.budi],
      );
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(error, "a reversed run cannot take the correction").not.toBeNull();
    expect(error!.code).toBe("23514");
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect((await correctionRows(world.budi))[0]!.status).toBe("proposed");
  });

  it("[891-not-failed] a paid or unresolved item, an item with only one resolution step, an item of another batch and an overpaid item are refused and unchanged", async () => {
    const { requester, first, second } = await trio("States");
    const world = await failedWorld(requester, {
      failed: [BUDI],
      open: [ANDI],
    });
    const snap = await snapshotOf(world);

    // Paid (succeeded).
    expectRefused(
      await postCorrect(first, world.batchId, [world.siti]),
      "paid item, first",
    );
    expectRefused(
      await postCorrect(second, world.batchId, [world.siti]),
      "paid item, second",
    );
    expect((await W.itemOfPerson(world.batchId, SITI)).status).toBe(
      "succeeded",
    );
    // Still exported: no bank result.
    expectRefused(
      await postCorrect(first, world.batchId, [world.andi]),
      "exported item",
    );
    // One resolution step only: not final.
    await W.resolve(world.batchId, [world.andi], "failed", APP);
    expect((await W.itemOfPerson(world.batchId, ANDI)).status).toBe("exported");
    expectRefused(
      await postCorrect(first, world.batchId, [world.andi]),
      "resolution not final",
    );
    expectRefused(
      await postCorrect(second, world.batchId, [world.andi]),
      "resolution not final, second",
    );
    expect((await W.itemOfPerson(world.batchId, ANDI)).status).toBe("exported");
    expect(await correctionRows(world.siti)).toHaveLength(0);
    expect(await correctionRows(world.andi)).toHaveLength(0);
    expect(await payoutJournals()).toBe(snap.journals);

    // An item of ANOTHER batch with this batch's URL.
    const other = await failedWorld(requester);
    const otherSnap = await snapshotOf(other);
    expectRefused(
      await postCorrect(first, world.batchId, [other.budi]),
      "item of another batch, first",
    );
    expectRefused(
      await postCorrect(second, world.batchId, [other.budi]),
      "item of another batch, second",
    );
    await expectUntouched(other, other.budi, otherSnap);
    // Control: the right URL accepts it, so the refusals were about the item.
    expectProposed(await postCorrect(first, other.batchId, [other.budi]));
  });

  it("[891-not-overpaid] an item already recorded as overpaid cannot be corrected: refused, still overpaid, nothing more booked", async () => {
    const { requester, first, second } = await trio("NotOver");
    const world = await failedWorld(requester);
    const followUp = await W.exportedBatch(world.runId);
    const retry = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    await W.confirm(followUp, W.succeedItems(followUp, retry));
    for (const who of [first, second]) {
      const res = await who.client
        .post(`${BASE}/${world.batchId}/overpaid`)
        .set(originHeader)
        .send({
          itemIds: [world.budi],
          evidenceKey: uploadEvidence(world.batchId, "mutasi-ganda.pdf"),
          note: "Mutasi bank menunjukkan transfer pertama ternyata berhasil",
          password: PASSWORD,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("overpaid");
    const snap = await snapshotOf(world);
    const third = await approverClient("NotOver Third");
    const fourth = await approverClient("NotOver Fourth");

    expectRefused(await postCorrect(third, world.batchId, [world.budi]));
    expectRefused(await postCorrect(fourth, world.batchId, [world.budi]));
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("overpaid");
    expect(await payoutJournals()).toBe(snap.journals);
    expect(await kindPostings(world.batchId, "overpaid")).toBe(1);
    expect(
      (await correctionRows(world.budi)).filter(
        (r) => r.status === "corrected",
      ),
    ).toHaveLength(0);
  });
});

// =========================================================================
// after the correction
// =========================================================================

describe("correcting a failed transfer over HTTP: a corrected slip is settled for good (legend-mejr2)", () => {
  it("[891-retry-after] after the correction no follow-up batch can be created for the slip: 409 (not 500), nothing is created", async () => {
    const { requester, first, second } = await trio("RetryAfter");
    const world = await failedWorld(requester);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));
    const counts = await runCounts(world.runId);
    const journals = await payoutJournals();

    await W.expectRefused(W.createBatch(world.runId), { status: 409 });
    expect(await runCounts(world.runId)).toEqual(counts);
    expect(await payoutJournals()).toBe(journals);
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe(
      "succeeded",
    );
    expect(await moneyOutItems(world.runId, BUDI)).toBe(1);
  });

  it("[891-replay] after it is corrected any replay books nothing more and creates nothing", async () => {
    const { requester, first, second } = await trio("Replay");
    const third = await approverClient("Replay Third");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));
    await expectCorrectionBooksOnce(world, snap);
    const after = await snapshotOf(world);

    for (const who of [first, second, third]) {
      const again = await postCorrect(who, world.batchId, [world.budi]);
      expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
      expect([404, 405]).not.toContain(again.status);
    }
    // Settling again, however it is triggered, adds nothing either.
    await W.inTx((tx) => settleBatchPayouts(tx, actorOf(APP2), world.batchId));
    await Promise.all([
      W.inTx((tx) => settleBatchPayouts(tx, actorOf(APP2), world.batchId)),
      W.inTx((tx) => settleBatchPayouts(tx, actorOf(APP3), world.batchId)),
    ]);
    await runPayoutGlRecoverySweep(W.scope(), NOW);

    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe(
      "succeeded",
    );
    expect(await payoutJournals()).toBe(after.journals);
    expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
      after.postings,
    );
    expect(await runCounts(world.runId)).toEqual(after.counts);
    expect(await books()).toEqual(after.books);
    expect(await moneyOutItems(world.runId, BUDI)).toBe(1);
  });

  it("[891-replay-first-step] the first step repeated by the same person and by a third before the second step books nothing", async () => {
    const { requester, first, second } = await trio("Replay1");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    for (let i = 0; i < 3; i += 1) {
      const again = await postCorrect(first, world.batchId, [world.budi]);
      expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
      expect([404, 405]).not.toContain(again.status);
      expect(
        (await W.itemOfPerson(world.batchId, BUDI)).status,
        "the same person never completes it",
      ).toBe("failed");
    }
    expect(await payoutJournals()).toBe(snap.journals);
    expect(await correctionRows(world.budi)).toHaveLength(1);

    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));
    await expectCorrectionBooksOnce(world, snap);
  });
});

// =========================================================================
// parallel calls
// =========================================================================

describe("correcting a failed transfer over HTTP: parallel calls (legend-mejr2)", () => {
  it("[891-concurrent-corrections] two different second people at the same moment: one correction, one settle journal, one fee, one bank credit", async () => {
    const { requester, first, second } = await trio("Race");
    const third = await approverClient("Race Third");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));

    const [b, c] = await Promise.all([
      postCorrect(second, world.batchId, [world.budi]),
      postCorrect(third, world.batchId, [world.budi]),
    ]);
    expect(Math.max(b.status, c.status)).toBeLessThan(500);
    expect(
      [b, c].filter((r) => r.status === 200 && dataOf(r).stage === "corrected")
        .length,
      `${JSON.stringify(b.body)} ${JSON.stringify(c.body)}`,
    ).toBeGreaterThanOrEqual(1);
    await expectCorrectionBooksOnce(world, snap);
    expect(
      (await correctionRows(world.budi)).filter(
        (r) => r.status === "corrected",
      ),
    ).toHaveLength(1);
  });

  it("[891-concurrent-first-steps] two different people start at the same moment: nothing is booked twice, and it ends corrected exactly once", async () => {
    const { requester, first, second } = await trio("Race1");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    const results = await Promise.all([
      postCorrect(first, world.batchId, [world.budi]),
      postCorrect(second, world.batchId, [world.budi]),
    ]);
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      expect([404, 405]).not.toContain(res.status);
    }
    expect(await payoutJournals()).toBeLessThanOrEqual(snap.journals + 2);
    expect(await moneyOutItems(world.runId, BUDI)).toBeLessThanOrEqual(1);

    // Make sure it ends corrected: the other person completes it if needed.
    if ((await W.itemOfPerson(world.batchId, BUDI)).status !== "succeeded") {
      const stillOpen = await Promise.all([
        postCorrect(first, world.batchId, [world.budi]),
        postCorrect(second, world.batchId, [world.budi]),
      ]);
      expect(
        stillOpen.some(
          (res) => res.status === 200 && dataOf(res).stage === "corrected",
        ),
        JSON.stringify(stillOpen.map((res) => res.body)),
      ).toBe(true);
    }
    await expectCorrectionBooksOnce(world, snap);
  });

  for (const round of [1, 2]) {
    it(`[891-race-retry-${round}] a correction and a retry batch at the same moment: exactly one wins, the money leaves at most once`, async () => {
      const { requester, first, second } = await trio(`RaceRetry${round}`);
      const world = await failedWorld(requester);
      expectProposed(await postCorrect(first, world.batchId, [world.budi]));
      const snap = await snapshotOf(world);

      const [correction, retry] = await Promise.all([
        postCorrect(second, world.batchId, [world.budi]),
        W.httpFailure(W.createBatch(world.runId)),
      ]);
      expect(correction.status, JSON.stringify(correction.body)).toBeLessThan(
        500,
      );
      if (retry) {
        expect(retry.status, "a lost retry is a clean refusal").toBe(409);
      }
      const correctionWon =
        correction.status === 200 && dataOf(correction).stage === "corrected";
      const retryWon = retry === null;
      expect(
        Number(correctionWon) + Number(retryWon),
        `exactly one wins: ${JSON.stringify(correction.body)} ${String(retry?.message)}`,
      ).toBe(1);

      if (correctionWon) {
        await expectCorrectionBooksOnce(world, snap);
        expect((await runCounts(world.runId)).batches).toBe(1);
      } else {
        expectNotCorrectable(correction);
        expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe(
          "failed",
        );
        expect(await payoutJournals()).toBe(snap.journals);
        expect((await W.postingsOf(world.batchId)).map(idOf)).toEqual(
          snap.postings,
        );
        expect(await moneyOutItems(world.runId, BUDI)).toBe(0);
        expect(
          (await correctionRows(world.budi)).filter(
            (r) => r.status === "corrected",
          ),
        ).toHaveLength(0);
      }
    });
  }
});

// =========================================================================
// accounting off / lock journal not posted yet
// =========================================================================

describe("correcting a failed transfer over HTTP: the books follow later when the lock journal is not there (legend-mejr2)", () => {
  /** Resolves the held settlement: lock event consumed, sweep, replays. */
  async function resolveLock(world: World) {
    await W.deliverGl(world.event);
    await W.deliverGl(
      W.paidEnvelope(world.runId, world.slips, { settledPerItem: true }),
    );
    await runPayoutGlRecoverySweep(W.scope(), NOW);
    await runPayoutGlRecoverySweep(W.scope(), NOW);
    await Promise.all([
      runPayoutGlRecoverySweep(W.scope(), NOW),
      runPayoutGlRecoverySweep(W.scope(), NOW),
    ]);
  }

  async function expectSettledOnceAfterLock(world: World, postingId: string) {
    const postings = await W.postingsOf(world.batchId);
    for (const posting of postings) expect(posting.kind).toBe("settle");
    const posting = postings.find((p) => idOf(p) === postingId)!;
    expect(await W.journalByKey(posting.journal_key as string)).toEqual({
      "2103": { debit: BUDI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET },
    });
    expect(await W.countJournals(posting.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
    const run = movedSince(world.before, await books());
    expect(
      run["2103"],
      "the lock debt of the run is closed, nothing more",
    ).toEqual({ debit: TOTAL, credit: TOTAL });
    expect(run["1103"]).toEqual({ debit: 0, credit: TOTAL + 3 * FEE });
    expect(run["8101"]).toEqual({ debit: 3 * FEE, credit: 0 });
    expect(run["1204"]).toEqual(untouched);
    expect(await moneyOutItems(world.runId, BUDI)).toBe(1);
    await expectLedgerBalanced();
  }

  it("[891-lock-pending] the lock event is still queued: the item is succeeded with a settle_pending posting and no journal; when the lock posts the settlement resolves exactly once", async () => {
    const { requester, first, second } = await trio("LockPend");
    const world = await failedWorld(requester, { lock: "queued" });
    const snap = await snapshotOf(world);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    expectCorrected(await postCorrect(second, world.batchId, [world.budi]));

    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe(
      "succeeded",
    );
    const fresh = (await W.postingsOf(world.batchId)).filter(
      (p) => !snap.postings.includes(idOf(p)),
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.kind, "pending, never the final skipped").toBe(
      "settle_pending",
    );
    expect(await W.journalByKey(fresh[0]!.journal_key as string)).toBe(
      undefined,
    );
    // Same as any confirmed payment (settleBatchPayouts): the net waits for the
    // lock journal, but the bank fee is real money the PT paid and is journaled
    // at once, exactly once (Dr 8101 / Cr 1103). The net debt side stays open.
    const pendingMoved = movedSince(snap.books, await books());
    expect(pendingMoved["2103"], "salary debt untouched while pending").toEqual(
      untouched,
    );
    expect(pendingMoved["1103"], "only the fee left the bank so far").toEqual({
      debit: 0,
      credit: FEE,
    });
    expect(pendingMoved["8101"]).toEqual({ debit: FEE, credit: 0 });
    expect(await W.countJournals(feeKey(fresh[0]!))).toBe(1);

    await resolveLock(world);
    await expectSettledOnceAfterLock(world, idOf(fresh[0]!));
    // Replays after resolution add nothing.
    const journals = await payoutJournals();
    await resolveLock(world);
    expect(await payoutJournals()).toBe(journals);
    await expectSettledOnceAfterLock(world, idOf(fresh[0]!));
  });

  it("[891-accounting-off] accounting switched off at the second step (lock still queued): the correction stands as settle_pending, never settle_skipped; once accounting is back and the lock posts it resolves exactly once", async () => {
    const { requester, first, second } = await trio("AcctOff");
    const world = await failedWorld(requester, { lock: "queued" });
    const snap = await snapshotOf(world);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));

    const res = await withAccountingOff(() =>
      postCorrect(second, world.batchId, [world.budi]),
    );
    expectCorrected(res);
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe(
      "succeeded",
    );
    const fresh = (await W.postingsOf(world.batchId)).filter(
      (p) => !snap.postings.includes(idOf(p)),
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.kind).toBe("settle_pending");
    expect(await kindPostings(world.batchId, "settle_skipped")).toBe(0);
    expect(await W.journalByKey(fresh[0]!.journal_key as string)).toBe(
      undefined,
    );

    await resolveLock(world);
    await expectSettledOnceAfterLock(world, idOf(fresh[0]!));
  });
});

// =========================================================================
// database guard
// =========================================================================

describe("correcting a failed transfer: the database guard (legend-mejr2)", () => {
  const flip = (itemId: string, guc: boolean) =>
    W.asTenant(async (c) => {
      if (guc)
        await c.query("SELECT set_config('app.payout_correction', 'on', true)");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(),
                confirmed_by = 'sql', confirmation_ref = 'SQL-REF'
          WHERE id = $1`,
        [itemId],
      );
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

  it("[891-db-guard-flip] failed -> succeeded straight in SQL is refused (23514) without an approved correction row, also with app.payout_correction=on and with only a proposal; no correction row appears", async () => {
    const { requester, first } = await trio("Guard");
    const world = await failedWorld(requester);
    const snap = await snapshotOf(world);

    const plain = await flip(world.budi, false);
    expect(plain, "no setting, no row").not.toBeNull();
    expect(plain!.code).toBe("23514");
    const gucOnly = await flip(world.budi, true);
    expect(gucOnly, "setting alone is not enough").not.toBeNull();
    expect(gucOnly!.code).toBe("23514");
    await expectUntouched(world, world.budi, snap);
    expect(
      await countOf(
        `SELECT count(*)::int AS n FROM payroll_payout_failed_corrections
          WHERE tenant_id = $1 AND batch_id = $2`,
        [W.tenantId, world.batchId],
      ),
      "the refused flips left no correction row",
    ).toBe(0);

    // A proposal is not an approved correction.
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    const proposed = await flip(world.budi, true);
    expect(proposed, "only a proposal").not.toBeNull();
    expect(proposed!.code).toBe("23514");
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
    expect(await payoutJournals()).toBe(snap.journals);
  });

  it("[891-db-guard-two-people] a correction row cannot be approved by its proposer in SQL (23514) and stays proposed", async () => {
    const { requester, first } = await trio("GuardRow");
    const world = await failedWorld(requester);
    expectProposed(await postCorrect(first, world.batchId, [world.budi]));
    const [row] = await correctionRows(world.budi);
    expect(row!.status).toBe("proposed");

    const error = await W.asTenant((c) =>
      c.query(
        `UPDATE payroll_payout_failed_corrections
            SET status = 'corrected', corrected_by = proposed_by, corrected_at = now()
          WHERE id = $1`,
        [row!.id],
      ),
    ).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(error, "the same person cannot approve").not.toBeNull();
    expect(error!.code).toBe("23514");
    expect((await correctionRows(world.budi))[0]!.status).toBe("proposed");
    expect((await W.itemOfPerson(world.batchId, BUDI)).status).toBe("failed");
  });

  it("[891-db-guard-insert] a correction row cannot be inserted already `corrected` with an invented approver (23514); an open proposal can", async () => {
    const { requester } = await trio("GuardInsert");
    const world = await failedWorld(requester);
    const insert = (status: string, correctedBy: string | null) => {
      const id = randomUUID();
      return W.asTenant((c) =>
        c.query(
          `INSERT INTO payroll_payout_failed_corrections
             (id, tenant_id, batch_id, item_id, operation_id, evidence_key,
              content_sha256, stored_sha256, note, status, proposed_by,
              proposed_at, corrected_by, corrected_at)
           VALUES ($1, $2, $3, $4, $1, $5, $6, $6, 'catatan', $7, 'sql-one',
                   now(), $8::text, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)`,
          [
            id,
            W.tenantId,
            world.batchId,
            world.budi,
            uploadEvidence(world.batchId, `sql-insert-${status}.pdf`),
            "a".repeat(64),
            status,
            correctedBy,
          ],
        ),
      ).then(
        () => null,
        (e: unknown) => e as { code?: string },
      );
    };

    const forged = await insert("corrected", "sql-two");
    expect(forged, "an invented approver").not.toBeNull();
    expect(forged!.code).toBe("23514");
    expect(await correctionRows(world.budi)).toHaveLength(0);

    try {
      expect(await insert("proposed", null), "an open proposal is fine").toBe(
        null,
      );
      expect((await correctionRows(world.budi))[0]!.status).toBe("proposed");
    } finally {
      // The SQL proposal has no proof binding: left behind it would hold every
      // later payout operation of the shared fixture tenant (legend-so897 gate).
      await W.owner.query(
        `DELETE FROM payroll_payout_failed_corrections
          WHERE tenant_id = $1 AND item_id = $2`,
        [W.tenantId, world.budi],
      );
    }
  });
});
