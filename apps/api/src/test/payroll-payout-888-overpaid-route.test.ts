// Payout area final, slice D1 (bead legend-v6gtp; brief scratchpad b888/brief.md,
// finding "P1: no product path to record a double transfer learned later" in
// docs/qa/second-opinion-payout-area-final.md). Written fail-first over HTTP from
// the brief and the CTO decisions, not from the implementation: the route
// POST /api/hris/payroll/disbursement-batches/:id/overpaid does not exist yet.
//
// Rules proven here (money: nobody is paid twice without a record, nothing extra
// is paid automatically, the PT does not lose):
// - The route needs `payroll.disburse.approve`, a trusted origin and step-up
//   (the password, because a second-factor enrollment alone never proves the
//   person), exactly like the return route.
// - Two different people who are not the requester: the first call is stage
//   `proposed` (the item stays `failed`, no journal), the second is `recorded`
//   (the item becomes `overpaid`: Dr 1204 receivable / Cr source bank net pay,
//   Dr 8101 / Cr source bank the transfer fee, each exactly once).
// - Replays and parallel calls post nothing more. No new item, batch or payout
//   is ever created: the API never pays anything by itself.
//
// Assumptions (the spec is silent, stated so they can be contested):
// - The response `data` names the stage in `data.stage` (fallback
//   `data.status`) as "proposed" or "recorded", as the brief says.
// - Reporting a late success when the slip has NO other paid attempt (no
//   follow-up batch yet) or while the follow-up batch is still open (exported,
//   not yet confirmed) is refused with a 4xx and changes nothing: the most
//   restrictive rule, because only a paid sibling makes the first transfer a
//   double payment. After the follow-up is confirmed the same report works.
// - A different evidence key in the second step than in the first is refused
//   (like PAYOUT_RETURN_EVIDENCE_MISMATCH), the item stays `failed`.
// - A replay on an already `overpaid` item is refused 4xx or answered 200
//   idempotently; either way nothing more is booked.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { originHeader } from "./helpers.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import {
  ANDI,
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  uploadEvidence,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("overpaid-route");
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const BASE = "/api/hris/payroll/disbursement-batches";

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const FEE = 5_000;
const slipsOf = () => [
  bank(BUDI, BUDI_NET),
  bank(SITI, SITI_NET),
  bank(ANDI, ANDI_NET),
];
const idOf = (row: Row) => row.id as string;
const errorCodeOf = (body: { error?: { code?: string } }) => body.error?.code;

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

// ---- HTTP people (same shape as payroll-payout-hardening) -------------------

/**
 * A staff member with payroll.disburse.approve whose only second-factor proof
 * is the enrollment itself, so the password is the real step-up.
 */
async function approverClient(label: string) {
  const { client, userId } = await W.signedInClient(`Overpaid ${label}`);
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

// ---- World setup ----------------------------------------------------------

const currentSourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;

/** Batch 1 created by a REAL user (the requester), approved by APP, exported. */
async function exportedBatchCreatedBy(requester: Approver) {
  const slips = slipsOf();
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
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
  return { runId, batchId, items };
}

/**
 * Budi's first transfer is resolved `failed` by two people, the other two
 * slips are paid. `followUp`: "none" = no retry batch yet, "open" = a retry
 * batch is exported but not confirmed, "paid" = the retry batch is confirmed.
 */
async function lateSuccessWorld(
  requester: Approver,
  followUp: "none" | "open" | "paid",
) {
  const { runId, batchId, items } = await exportedBatchCreatedBy(requester);
  const budiFirst = items.find((i) => i.employee_id === BUDI.id)!;
  await W.confirm(
    batchId,
    W.succeedItems(
      batchId,
      items.filter((i) => i.employee_id !== BUDI.id),
    ),
  );
  await W.resolve(batchId, [idOf(budiFirst)], "failed", APP);
  await W.resolve(batchId, [idOf(budiFirst)], "failed", APP3);

  let followUpBatch: string | null = null;
  const confirmFollowUp = async () => {
    const followItems = (await W.itemsOf(followUpBatch!)).filter(
      (i) => i.status === "exported",
    );
    expect(followItems).toHaveLength(1);
    await W.confirm(
      followUpBatch!,
      W.succeedItems(followUpBatch!, followItems),
    );
  };
  if (followUp !== "none") {
    followUpBatch = await W.exportedBatch(runId);
    if (followUp === "paid") await confirmFollowUp();
  }
  return {
    runId,
    batchId,
    itemId: idOf(budiFirst),
    followUpBatch,
    confirmFollowUp,
  };
}

// ---- HTTP calls -----------------------------------------------------------

const overpaidBody = (
  batchId: string,
  itemIds: string[],
  options: { password?: string; file?: string } = {},
) => ({
  itemIds,
  evidenceKey: uploadEvidence(batchId, options.file ?? "mutasi-bank.pdf"),
  note: "Mutasi bank menunjukkan transfer pertama ternyata berhasil",
  ...(options.password === undefined ? {} : { password: options.password }),
});
const postOverpaid = (
  who: Approver,
  batchId: string,
  itemIds: string[],
  options: { password?: string; file?: string } = {},
) =>
  who.client
    .post(`${BASE}/${batchId}/overpaid`)
    .set(originHeader)
    .send(overpaidBody(batchId, itemIds, options));

type Res = Awaited<ReturnType<typeof postOverpaid>>;
const stageOf = (res: Res) =>
  (res.body.data as { stage?: string; status?: string } | undefined)?.stage ??
  (res.body.data as { status?: string } | undefined)?.status;
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
const expectProposed = (res: Res) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(stageOf(res)).toBe("proposed");
};
const expectRecorded = (res: Res) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(stageOf(res)).toBe("recorded");
};

// ---- Observations ---------------------------------------------------------

const overpaidKey = (itemId: string) => `payroll-payout-overpaid:${itemId}`;
const countOf = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
/** Every payout journal of this legal entity (settle, fee, return, overpaid). */
const payoutJournals = () => W.countJournals("payroll-payout-%");
const runCounts = async (runId: string) => ({
  items: await countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_items WHERE payroll_run_id = $1`,
    [runId],
  ),
  batches: await countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches WHERE payroll_run_id = $1`,
    [runId],
  ),
  liveSuccess: await countOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_items
      WHERE payroll_run_id = $1 AND employee_id = $2 AND status = 'succeeded'`,
    [runId, BUDI.id],
  ),
  paidEvents: (await W.paidEventsOf(runId)).length,
});
async function ledgerOfItem(itemId: string) {
  const lines = await W.rowsOf(
    `SELECT a.code, sum(l.debit_idr)::text AS debit, sum(l.credit_idr)::text AS credit
       FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
        AND e.idempotency_key LIKE '%' || $3 || '%'
      GROUP BY a.code`,
    [W.tenantId, W.entityId(), itemId],
  );
  const byCode: Record<string, { debit: number; credit: number }> = {};
  for (const line of lines)
    byCode[line.code as string] = {
      debit: Number(line.debit),
      credit: Number(line.credit),
    };
  const feeEntries = await countOf(
    `SELECT count(DISTINCT e.id)::int AS n
       FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
        AND e.idempotency_key LIKE '%' || $3 || '%'
        AND a.code = '8101' AND l.debit_idr > 0`,
    [W.tenantId, W.entityId(), itemId],
  );
  return { byCode, feeEntries };
}
const overpaidPostings = (batchId: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'overpaid'`,
    [W.tenantId, batchId],
  );

/** Nothing happened: the item is still `failed`, no overpaid journal or posting. */
async function expectUntouched(batchId: string, itemId: string) {
  const row = await W.itemOfPerson(batchId, BUDI);
  expect(row.status, "the item stays failed").toBe("failed");
  expect(await W.countJournals(`%${itemId}%`), "no journal").toBe(0);
  expect(await overpaidPostings(batchId), "no overpaid posting").toBe(0);
}

/** The exact books of one recorded double transfer. */
async function expectBooksOnce(batchId: string, itemId: string) {
  expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
  expect(await W.countJournals(overpaidKey(itemId))).toBe(1);
  expect(await overpaidPostings(batchId)).toBe(1);
  const { byCode, feeEntries } = await ledgerOfItem(itemId);
  expect(byCode["1204"], "employee receivable = net pay once").toEqual({
    debit: BUDI_NET,
    credit: 0,
  });
  expect(byCode["8101"], "bank charges expense = Rp5.000 once").toEqual({
    debit: FEE,
    credit: 0,
  });
  expect(byCode["1103"], "source bank credited net pay + fee once").toEqual({
    debit: 0,
    credit: BUDI_NET + FEE,
  });
  expect(Object.keys(byCode).sort()).toEqual(["1103", "1204", "8101"]);
  expect(feeEntries, "one fee entry").toBe(1);
}

// =========================================================================
// access and step-up
// =========================================================================

describe("reporting a late transfer over HTTP: access and step-up (legend-v6gtp)", () => {
  it("[overpaid-route-permission] without payroll.disburse.approve it is 403 and changes nothing", async () => {
    const requester = await approverClient("Perm Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const viewer = await W.signedInClient("Overpaid Viewer");
    await W.grantRole(viewer.userId, ["payroll.view"]);

    const res = await viewer.client
      .post(`${BASE}/${batchId}/overpaid`)
      .set(originHeader)
      .send(overpaidBody(batchId, [itemId], { password: PASSWORD }));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    await expectUntouched(batchId, itemId);

    // Control: a permitted person gets through, so the 403 was the permission.
    const first = await approverClient("Perm First");
    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
  });

  it("[overpaid-route-origin] a request from an untrusted origin is refused and changes nothing", async () => {
    const requester = await approverClient("Origin Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const first = await approverClient("Origin First");

    const res = await first.client
      .post(`${BASE}/${batchId}/overpaid`)
      .set({ Origin: "https://evil.example" })
      .send(overpaidBody(batchId, [itemId], { password: PASSWORD }));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    await expectUntouched(batchId, itemId);
    // No first step was recorded: the next person's call is a first step.
    const second = await approverClient("Origin Second");
    expectProposed(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
  });

  it("[overpaid-route-stepup] without the password (enrollment only) it is 401 REAUTH_REQUIRED, with a wrong password refused, and no first step is recorded; the second step without it is refused too", async () => {
    const requester = await approverClient("Step Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const first = await approverClient("Step First");
    const second = await approverClient("Step Second");

    const without = await postOverpaid(first, batchId, [itemId]);
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
    const wrong = await postOverpaid(first, batchId, [itemId], {
      password: WRONG_PASSWORD,
    });
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
    await expectUntouched(batchId, itemId);

    // The refused calls recorded no first step: a correct call is a FIRST step.
    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
    expect(await W.countJournals(`%${itemId}%`)).toBe(0);

    // The second person without the password cannot complete it.
    const noPassword = await postOverpaid(second, batchId, [itemId]);
    expect(noPassword.status, JSON.stringify(noPassword.body)).toBe(401);
    expect(errorCodeOf(noPassword.body)).toBe("REAUTH_REQUIRED");
    const wrongSecond = await postOverpaid(second, batchId, [itemId], {
      password: WRONG_PASSWORD,
    });
    expect([401, 403], JSON.stringify(wrongSecond.body)).toContain(
      wrongSecond.status,
    );
    await expectUntouched(batchId, itemId);

    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    await expectBooksOnce(batchId, itemId);
  });

  it("[overpaid-route-strict-body] an unknown field, an empty item list or a missing evidence key is refused and changes nothing", async () => {
    const requester = await approverClient("Body Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const first = await approverClient("Body First");
    const send = (body: Record<string, unknown>) =>
      first.client
        .post(`${BASE}/${batchId}/overpaid`)
        .set(originHeader)
        .send(body);
    const good = { ...overpaidBody(batchId, [itemId], { password: PASSWORD }) };

    expectRefused(await send({ ...good, payAgain: true }), "unknown field");
    expectRefused(await send({ ...good, itemIds: [] }), "empty items");
    expectRefused(await send({ ...good, itemIds: [itemId, itemId] }), "twice");
    const noEvidence: Record<string, unknown> = { ...good };
    delete noEvidence.evidenceKey;
    expectRefused(await send(noEvidence), "no evidence");
    await expectUntouched(batchId, itemId);

    // Control: the same request without the defect is a first step.
    expectProposed(await send(good));
  });
});

// =========================================================================
// two people
// =========================================================================

describe("reporting a late transfer over HTTP: two different people (legend-v6gtp)", () => {
  it("[overpaid-route-two-people] the first person only proposes, the second records: receivable, bank credit and fee exactly once, no new payment", async () => {
    const requester = await approverClient("Two Requester");
    const { runId, batchId, followUpBatch, itemId } = await lateSuccessWorld(
      requester,
      "paid",
    );
    const first = await approverClient("Two First");
    const second = await approverClient("Two Second");
    const before = await runCounts(runId);
    expect(before.batches).toBe(2);
    expect(before.liveSuccess).toBe(1);
    const journalsBefore = await payoutJournals();
    const followUpPostings = (await W.postingsOf(followUpBatch!)).map(idOf);

    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
    expect(
      (await W.itemOfPerson(batchId, BUDI)).status,
      "one person is not enough",
    ).toBe("failed");
    expect(await payoutJournals(), "a proposal books nothing").toBe(
      journalsBefore,
    );
    expect(await W.countJournals(`%${itemId}%`)).toBe(0);

    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    await expectBooksOnce(batchId, itemId);
    expect(
      await payoutJournals(),
      "exactly the overpaid and fee journals",
    ).toBe(journalsBefore + 2);
    const posting = (
      await W.rowsOf(
        `SELECT id, journal_key FROM payroll_payout_gl_postings
          WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'overpaid'`,
        [W.tenantId, batchId],
      )
    )[0]!;
    expect(posting.journal_key).toBe(overpaidKey(itemId));
    expect((await W.itemOfPerson(batchId, BUDI)).gl_posting_id).toBe(
      posting.id,
    );

    // Nothing was paid by the API: no item, batch, live success, paid event.
    expect(await runCounts(runId)).toEqual(before);
    expect((await W.postingsOf(followUpBatch!)).map(idOf)).toEqual(
      followUpPostings,
    );
    expect((await W.runRow(runId)).status).toBe("paid");
    // The paid siblings are untouched.
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("succeeded");
  });

  it("[overpaid-route-same-person] the same person twice, and the requester in either step, never complete it", async () => {
    const requester = await approverClient("Same Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const first = await approverClient("Same First");
    const second = await approverClient("Same Second");

    // The requester of the batch never counts, even with every credential.
    expectRefused(
      await postOverpaid(requester, batchId, [itemId], { password: PASSWORD }),
      "requester as first step",
    );
    await expectUntouched(batchId, itemId);

    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
    expectRefused(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
      "the same person twice",
    );
    expectRefused(
      await postOverpaid(requester, batchId, [itemId], { password: PASSWORD }),
      "requester as second step",
    );
    await expectUntouched(batchId, itemId);

    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    await expectBooksOnce(batchId, itemId);
  });

  it("[overpaid-route-evidence-mismatch] the second step with other evidence than the first is refused and the item stays failed; the same evidence passes", async () => {
    const requester = await approverClient("Evidence Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const first = await approverClient("Evidence First");
    const second = await approverClient("Evidence Second");

    expectProposed(
      await postOverpaid(first, batchId, [itemId], {
        password: PASSWORD,
        file: "mutasi-bank.pdf",
      }),
    );
    expectRefused(
      await postOverpaid(second, batchId, [itemId], {
        password: PASSWORD,
        file: "lain.pdf",
      }),
      "another evidence key",
    );
    await expectUntouched(batchId, itemId);

    expectRecorded(
      await postOverpaid(second, batchId, [itemId], {
        password: PASSWORD,
        file: "mutasi-bank.pdf",
      }),
    );
    await expectBooksOnce(batchId, itemId);
  });
});

// =========================================================================
// which items can be reported
// =========================================================================

describe("reporting a late transfer over HTTP: only a failed item of a slip that was paid another way (legend-v6gtp)", () => {
  it("[overpaid-route-before-retry] no follow-up batch yet: nothing is double paid, so it is refused for both people, nothing is booked and nothing is paid", async () => {
    const requester = await approverClient("Before Requester");
    const { runId, batchId, itemId } = await lateSuccessWorld(
      requester,
      "none",
    );
    const first = await approverClient("Before First");
    const second = await approverClient("Before Second");
    const before = await runCounts(runId);
    const journalsBefore = await payoutJournals();

    // Stage one may or may not be accepted, but the second step never records.
    const one = await postOverpaid(first, batchId, [itemId], {
      password: PASSWORD,
    });
    expect(one.status, JSON.stringify(one.body)).toBeLessThan(500);
    expect([404, 405]).not.toContain(one.status);
    expectRefused(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
      "second step without a paid sibling",
    );
    await expectUntouched(batchId, itemId);
    expect(await payoutJournals()).toBe(journalsBefore);
    expect(await runCounts(runId)).toEqual(before);
  });

  it("[overpaid-route-retry-open] the follow-up batch is still open: refused, nothing booked, no extra payment; once the follow-up is confirmed the same report records exactly once", async () => {
    const requester = await approverClient("Open Requester");
    const world = await lateSuccessWorld(requester, "open");
    const { runId, batchId, itemId } = world;
    const first = await approverClient("Open First");
    const second = await approverClient("Open Second");
    const before = await runCounts(runId);
    const journalsBefore = await payoutJournals();

    const one = await postOverpaid(first, batchId, [itemId], {
      password: PASSWORD,
    });
    expect(one.status, JSON.stringify(one.body)).toBeLessThan(500);
    expect([404, 405]).not.toContain(one.status);
    expectRefused(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
      "second step while the retry is open",
    );
    await expectUntouched(batchId, itemId);
    expect(await payoutJournals()).toBe(journalsBefore);
    expect(await runCounts(runId)).toEqual(before);

    // The retry is paid at the bank: now the first transfer is a double payment.
    await world.confirmFollowUp();
    const afterRetry = await runCounts(runId);
    expect(afterRetry.liveSuccess).toBe(1);

    const again = await postOverpaid(first, batchId, [itemId], {
      password: PASSWORD,
    });
    expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    await expectBooksOnce(batchId, itemId);
    expect(await runCounts(runId)).toEqual(afterRetry);
  });

  it("[overpaid-route-after-retry] after the follow-up batch is paid the report records the receivable, bank credit and fee once, and a new batch for the run has nothing to pay", async () => {
    const requester = await approverClient("After Requester");
    const { runId, batchId, itemId } = await lateSuccessWorld(
      requester,
      "paid",
    );
    const first = await approverClient("After First");
    const second = await approverClient("After Second");
    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    await expectBooksOnce(batchId, itemId);

    // The slip is settled for good: no new attempt may be created for it.
    await W.expectRefused(W.createBatch(runId), {
      status: 409,
      code: "PAYOUT_NOTHING_TO_PAY",
    });
  });

  it("[overpaid-route-paid-item] a paid (succeeded) item cannot be reported as overpaid: refused for both people, it stays paid, nothing is booked", async () => {
    const requester = await approverClient("Paid Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const siti = await W.itemOfPerson(batchId, SITI);
    const first = await approverClient("Paid First");
    const second = await approverClient("Paid Second");
    const journalsBefore = await payoutJournals();

    const one = await postOverpaid(first, batchId, [idOf(siti)], {
      password: PASSWORD,
    });
    expect(one.status, JSON.stringify(one.body)).toBeLessThan(500);
    expectRefused(
      await postOverpaid(second, batchId, [idOf(siti)], { password: PASSWORD }),
      "a paid item",
    );
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect(await W.countJournals(overpaidKey(idOf(siti)))).toBe(0);
    expect(await payoutJournals()).toBe(journalsBefore);
    expect(await overpaidPostings(batchId)).toBe(0);
    // Budi's item is unaffected by the refused call on Siti.
    await expectUntouched(batchId, itemId);
  });

  it("[overpaid-route-wrong-batch] an item that belongs to another batch is refused for the URL batch and changes nothing", async () => {
    const requester = await approverClient("Wrong Requester");
    const { batchId, followUpBatch, itemId } = await lateSuccessWorld(
      requester,
      "paid",
    );
    const first = await approverClient("Wrong First");
    const second = await approverClient("Wrong Second");
    const budiRetry = await W.itemOfPerson(followUpBatch!, BUDI);

    // The retry item belongs to the follow-up batch, not to `batchId`.
    const one = await postOverpaid(first, batchId, [idOf(budiRetry)], {
      password: PASSWORD,
    });
    expect(one.status, JSON.stringify(one.body)).toBeLessThan(500);
    expectRefused(
      await postOverpaid(second, batchId, [idOf(budiRetry)], {
        password: PASSWORD,
      }),
      "an item of another batch",
    );
    expect((await W.itemOfPerson(followUpBatch!, BUDI)).status).toBe(
      "succeeded",
    );
    expect(await W.countJournals(overpaidKey(idOf(budiRetry)))).toBe(0);

    // Control: the right item of the right batch records normally, so the route
    // exists and the refusals above were about the item.
    const third = await approverClient("Wrong Third");
    const fourth = await approverClient("Wrong Fourth");
    // The refused calls above were about another item: this pair completes Budi's.
    await postOverpaid(third, batchId, [itemId], { password: PASSWORD });
    const done = await postOverpaid(fourth, batchId, [itemId], {
      password: PASSWORD,
    });
    expectRecorded(done);
    await expectBooksOnce(batchId, itemId);
  });
});

// =========================================================================
// replay and parallel calls
// =========================================================================

describe("reporting a late transfer over HTTP: replays and parallel calls are idempotent (legend-v6gtp)", () => {
  it("[overpaid-route-replay] after it is recorded any replay books nothing more and creates nothing", async () => {
    const requester = await approverClient("Replay Requester");
    const { runId, batchId, itemId } = await lateSuccessWorld(
      requester,
      "paid",
    );
    const first = await approverClient("Replay First");
    const second = await approverClient("Replay Second");
    const third = await approverClient("Replay Third");
    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    const journals = await payoutJournals();
    const ledger = (await ledgerOfItem(itemId)).byCode;
    const counts = await runCounts(runId);

    for (const who of [first, second, third]) {
      const again = await postOverpaid(who, batchId, [itemId], {
        password: PASSWORD,
      });
      expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
      expect([404, 405]).not.toContain(again.status);
    }

    await expectBooksOnce(batchId, itemId);
    expect(await payoutJournals()).toBe(journals);
    expect((await ledgerOfItem(itemId)).byCode).toEqual(ledger);
    expect(await runCounts(runId)).toEqual(counts);
  });

  it("[overpaid-route-replay-first-step] the first step repeated by the same person and by a third person before the second step books nothing", async () => {
    const requester = await approverClient("Replay1 Requester");
    const { batchId, itemId } = await lateSuccessWorld(requester, "paid");
    const first = await approverClient("Replay1 First");
    const second = await approverClient("Replay1 Second");
    const journals = await payoutJournals();

    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );
    for (let i = 0; i < 3; i += 1) {
      const again = await postOverpaid(first, batchId, [itemId], {
        password: PASSWORD,
      });
      expect(again.status, JSON.stringify(again.body)).toBeLessThan(500);
      expect([404, 405]).not.toContain(again.status);
      expect(
        (await W.itemOfPerson(batchId, BUDI)).status,
        "the same person never completes it",
      ).toBe("failed");
    }
    expect(await payoutJournals()).toBe(journals);

    expectRecorded(
      await postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
    );
    await expectBooksOnce(batchId, itemId);
  });

  it("[overpaid-route-concurrent] two different second people at the same moment: one record, one receivable, one bank credit, one fee", async () => {
    const requester = await approverClient("Race Requester");
    const { runId, batchId, itemId } = await lateSuccessWorld(
      requester,
      "paid",
    );
    const first = await approverClient("Race First");
    const second = await approverClient("Race Second");
    const third = await approverClient("Race Third");
    const counts = await runCounts(runId);
    expectProposed(
      await postOverpaid(first, batchId, [itemId], { password: PASSWORD }),
    );

    const [b, c] = await Promise.all([
      postOverpaid(second, batchId, [itemId], { password: PASSWORD }),
      postOverpaid(third, batchId, [itemId], { password: PASSWORD }),
    ]);
    expect(Math.max(b.status, c.status)).toBeLessThan(500);
    expect(
      [b.status, c.status].filter((s) => s === 200).length,
      `${JSON.stringify(b.body)} ${JSON.stringify(c.body)}`,
    ).toBeGreaterThanOrEqual(1);
    await expectBooksOnce(batchId, itemId);
    expect(await runCounts(runId)).toEqual(counts);
  });

  it("[overpaid-route-concurrent-first-steps] two different people start at the same moment: nothing is booked until a person has seen the other's step; at the end exactly one record", async () => {
    const requester = await approverClient("Race1 Requester");
    const { runId, batchId, itemId } = await lateSuccessWorld(
      requester,
      "paid",
    );
    const a = await approverClient("Race1 A");
    const b = await approverClient("Race1 B");
    const counts = await runCounts(runId);

    const results = await Promise.all([
      postOverpaid(a, batchId, [itemId], { password: PASSWORD }),
      postOverpaid(b, batchId, [itemId], { password: PASSWORD }),
    ]);
    for (const res of results) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
      expect([404, 405]).not.toContain(res.status);
    }
    // Whatever the interleaving: at most one overpaid journal and one fee.
    expect(await W.countJournals(overpaidKey(itemId))).toBeLessThanOrEqual(1);
    expect((await ledgerOfItem(itemId)).feeEntries).toBeLessThanOrEqual(1);

    // Make sure it ends recorded: the other person completes it if needed.
    if ((await W.itemOfPerson(batchId, BUDI)).status !== "overpaid") {
      const stillOpen = await Promise.all([
        postOverpaid(a, batchId, [itemId], { password: PASSWORD }),
        postOverpaid(b, batchId, [itemId], { password: PASSWORD }),
      ]);
      expect(
        stillOpen.some(
          (res) => res.status === 200 && stageOf(res) === "recorded",
        ),
        JSON.stringify(stillOpen.map((res) => res.body)),
      ).toBe(true);
    }
    await expectBooksOnce(batchId, itemId);
    expect(await runCounts(runId)).toEqual(counts);
  });
});
