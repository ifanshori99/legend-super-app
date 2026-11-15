// Second-opinion finding legend-w3691 (P2): a return payment proof must be
// bound to ONE return operation, not reusable for another.
//
// Scenario: A and B were paid in the same batch; only A's funds came back. Two
// authorised people (not the batch requester) finish the return of A with proof
// K, then use the same K for a two-step return of B. The only existing check
// is that the proof object exists in the batch folder and both steps use the
// same key, so B was marked `returned` and got a return journal although its
// money never came back; as `returned` it left the one-live-attempt index and
// could be paid a second time in a follow-up batch.
//
// Decision (final): a proof is bound to one return operation (the item set and
// the total funds) and consumed atomically.
// - After the return of A with K is done, a two-step return of B with K is
//   rejected: B stays `succeeded`, no return journal for B, and B is not
//   offered to a follow-up batch.
// - Control: ONE proof K for several items in the SAME operation (same request,
//   both steps) stays valid and journals every item exactly once (a bank result
//   report with several rows is legitimate, design 296).
// - Control: uploading identical bytes again yields a different key (fixtures
//   model it as another file name). That is not a bypass of the binding: B with
//   the new key K2 is its own operation and passes.
//
// Assumptions:
// - Which of B's two steps is refused is not specified; the test only requires
//   that the operation does not complete (at least one step refused with a 4xx
//   HttpError) and that the end state is unchanged.
// - Items and people: the first/second step users are APP and APP3 (any two
//   non-requesters work; they are the pair used by payroll-payout-gl.test.ts).
// - Cross-tenant/batch keys are already refused by the existing evidence tests
//   and are not repeated here.
import { describe, expect, it } from "vitest";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import {
  ANDI,
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("870proof");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const idOf = (row: Row) => row.id as string;
const returnKey = (itemId: string) => `payroll-payout-return:${itemId}`;

const returnWith = (
  batchId: string,
  itemIds: string[],
  by: string,
  evidenceKey: string,
) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey,
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );
/** Both steps of one return operation. */
async function returnBothSteps(
  batchId: string,
  itemIds: string[],
  evidenceKey: string,
) {
  await returnWith(batchId, itemIds, APP, evidenceKey);
  await returnWith(batchId, itemIds, APP3, evidenceKey);
}

/** Three items paid in one batch (Budi = A, Siti = B, Andi = C). */
async function paidBatch() {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return {
    runId,
    batchId,
    a: await W.itemOfPerson(batchId, BUDI),
    b: await W.itemOfPerson(batchId, SITI),
    c: await W.itemOfPerson(batchId, ANDI),
  };
}

/** Return of A is done with proof K; returns the K and the batch. */
async function afterReturnOfA() {
  const paid = await paidBatch();
  const k = uploadEvidence(paid.batchId, "dana-kembali-A.pdf");
  await returnBothSteps(paid.batchId, [idOf(paid.a)], k);
  expect((await W.itemOfPerson(paid.batchId, BUDI)).status).toBe("returned");
  return { ...paid, k };
}

describe("legend-w3691: a return proof is bound to one return operation", () => {
  it("[w3691-proof-not-reusable] after the return of A with proof K, a two-step return of B with the same K is rejected: B stays succeeded, no return journal for B", async () => {
    const { batchId, b, k } = await afterReturnOfA();

    const failures = [
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP, k)),
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP3, k)),
    ];
    expect(
      failures.some((error) => error !== null),
      "reusing the consumed proof for another item must be refused",
    ).toBe(true);
    for (const error of failures.filter((e) => e !== null)) {
      expect(error!.status).toBeGreaterThanOrEqual(400);
      expect(error!.status).toBeLessThan(500);
    }

    const row = await W.itemOfPerson(batchId, SITI);
    expect(row.status, "B's funds never came back").toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
    // A's own return is intact and journaled once.
    expect(
      await W.countJournals(
        returnKey(idOf(await W.itemOfPerson(batchId, BUDI))),
      ),
    ).toBe(1);
  });

  it("[w3691-no-second-payment] B is not offered to a follow-up batch after the replay: only A (really returned) is paid again", async () => {
    const { runId, batchId, b, k } = await afterReturnOfA();
    await W.httpFailure(returnWith(batchId, [idOf(b)], APP, k));
    await W.httpFailure(returnWith(batchId, [idOf(b)], APP3, k));

    const followUp = await W.createBatch(runId);
    const items = await W.itemsOf(followUp);
    expect(items.map((i) => i.employee_id)).toEqual([BUDI.id]);
    expect(
      (await W.itemOfPerson(batchId, SITI)).status,
      "B keeps its single successful payment",
    ).toBe("succeeded");
  });

  it("[w3691-control-one-proof-several-items] one proof K for A and B in the SAME operation stays valid: both returned, each journaled exactly once with its own net", async () => {
    const { batchId, a, b, c } = await paidBatch();
    const k = uploadEvidence(batchId, "dana-kembali-AB.pdf");

    await returnBothSteps(batchId, [idOf(a), idOf(b)], k);

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("succeeded");
    expect(await W.journalByKey(returnKey(idOf(a)))).toEqual({
      "1103": { debit: BUDI_NET, credit: 0 },
      "2103": { debit: 0, credit: BUDI_NET },
    });
    expect(await W.journalByKey(returnKey(idOf(b)))).toEqual({
      "1103": { debit: SITI_NET, credit: 0 },
      "2103": { debit: 0, credit: SITI_NET },
    });
    expect(await W.countJournals(returnKey(idOf(c)))).toBe(0);
    expect(await W.countJournals(returnKey(idOf(a)))).toBe(1);
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });

  it("[w3691-control-new-key-new-operation] a re-uploaded proof has a different key (K2); B returned in its own operation with K2 passes, so the binding is per operation, not a ban on proofs", async () => {
    const { batchId, b, k } = await afterReturnOfA();
    const k2 = uploadEvidence(batchId, "dana-kembali-A-unggah-ulang.pdf");
    expect(k2).not.toBe(k);

    await returnBothSteps(batchId, [idOf(b)], k2);

    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect(await W.journalByKey(returnKey(idOf(b)))).toEqual({
      "1103": { debit: SITI_NET, credit: 0 },
      "2103": { debit: 0, credit: SITI_NET },
    });
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F3 (P2): one proof must not free two payslips across flows.
//
// A proof K that resolved item C as failed (two-step resolve, K is C's
// resolution evidence) must not then return item B, and the reverse order
// (K returned B, then K resolves C) is refused as well. A proof used for
// several items inside ONE operation stays valid (control above).
//
// Assumptions: which step is refused is not specified; the operation must not
// complete (at least one step refused with a 4xx) and the end state is
// unchanged. Item C is left `exported` (no bank result) so it can be resolved;
// A and B are confirmed paid.
// ---------------------------------------------------------------------------

/** A, B paid (succeeded); C still exported, waiting for the bank result. */
async function paidAbPendingC() {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(
    batchId,
    W.succeedItems(
      batchId,
      items.filter((i) => i.employee_id !== ANDI.id),
    ),
  );
  return {
    runId,
    batchId,
    a: await W.itemOfPerson(batchId, BUDI),
    b: await W.itemOfPerson(batchId, SITI),
    c: await W.itemOfPerson(batchId, ANDI),
  };
}

const resolveWith = (
  batchId: string,
  itemIds: string[],
  by: string,
  k: string,
) => W.resolve(batchId, itemIds, "failed", by, k);

describe("review F3: a proof is not reusable across resolve and return flows", () => {
  it("[f3-resolve-then-return] K resolved C as failed; a two-step return of B with the same K is refused: B stays succeeded, no return journal", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = uploadEvidence(batchId, "bukti-gagal-C.pdf");
    await resolveWith(batchId, [idOf(c)], APP, k);
    await resolveWith(batchId, [idOf(c)], APP3, k);
    expect((await W.itemOfPerson(batchId, ANDI)).status, "premise").toBe(
      "failed",
    );

    const failures = [
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP, k)),
      await W.httpFailure(returnWith(batchId, [idOf(b)], APP3, k)),
    ];
    expect(
      failures.some((error) => error !== null),
      "a proof that already freed C must not return B",
    ).toBe(true);
    for (const error of failures.filter((e) => e !== null)) {
      expect(error!.status).toBeGreaterThanOrEqual(400);
      expect(error!.status).toBeLessThan(500);
    }
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(0);
  });

  it("[f3-return-then-resolve] K returned B; a two-step resolve of C as failed with the same K is refused: C stays exported (not freed for a second payment)", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = uploadEvidence(batchId, "dana-kembali-B.pdf");
    await returnBothSteps(batchId, [idOf(b)], k);
    expect((await W.itemOfPerson(batchId, SITI)).status, "premise").toBe(
      "returned",
    );

    const failures = [
      await W.httpFailure(resolveWith(batchId, [idOf(c)], APP, k)),
      await W.httpFailure(resolveWith(batchId, [idOf(c)], APP3, k)),
    ];
    expect(
      failures.some((error) => error !== null),
      "a proof that already returned B must not free C",
    ).toBe(true);
    for (const error of failures.filter((e) => e !== null)) {
      expect(error!.status).toBeGreaterThanOrEqual(400);
      expect(error!.status).toBeLessThan(500);
    }
    expect((await W.itemOfPerson(batchId, ANDI)).status).toBe("exported");
  });
});

// Review round 2, F6: the same binding applies to payment confirmation. A key
// used by step 1 of a return of B must not be accepted as the payment proof of
// another exported item C. Assumptions: the confirmer is the second approver
// (APP3); the refusal is 409 PAYOUT_RETURN_PROOF_REUSED; the refused confirm
// leaves C exported, and the return of B can then be finished with the same K.
describe("review F6: a return proof is not reusable as a payment confirmation proof", () => {
  it("[f6-confirm-with-return-proof] K started the return of B; confirming exported C with K is refused (409 PAYOUT_RETURN_PROOF_REUSED), C stays exported; step 2 of B with K still succeeds with one return journal", async () => {
    const { batchId, b, c } = await paidAbPendingC();
    const k = uploadEvidence(batchId, "dana-kembali-B.pdf");
    await returnWith(batchId, [idOf(b)], APP, k);

    await W.expectRefused(
      W.confirm(
        batchId,
        [
          {
            itemId: idOf(c),
            result: "succeeded",
            bankRef: `BCA-${batchId.slice(0, 8)}-C`,
            evidenceKey: k,
          },
        ],
        APP3,
      ),
      { status: 409, code: "PAYOUT_RETURN_PROOF_REUSED" },
    );
    expect(
      (await W.itemOfPerson(batchId, ANDI)).status,
      "C is not marked paid with a return proof",
    ).toBe("exported");

    await returnWith(batchId, [idOf(b)], APP3, k);
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("returned");
    expect(await W.countJournals(returnKey(idOf(b)))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F4 (P3): the claims table has a write guard (like the GL
// postings guard). Only `open -> consumed` with consumed_at set and every
// other column unchanged is allowed; anything else raises 23514 with a
// message that starts with PAYOUT-31. The service flow itself (open ->
// consumed) is covered by the return tests above. Rewritten rows are
// attempted without disabling triggers (no session_replication_role).
// ---------------------------------------------------------------------------

describe("review F4: return claims cannot be rewritten", () => {
  async function consumedClaim() {
    const { batchId, k } = await afterReturnOfA();
    const [claim] = await W.rowsOf(
      `SELECT * FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, k],
    );
    expect(claim, "premise: the return left a claim").toBeDefined();
    expect(claim!.status, "premise: the claim is consumed").toBe("consumed");
    return { batchId, claim: claim! };
  }
  const update = (sql: string, params: unknown[]) =>
    W.asTenant((c) => c.query(sql, params)).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

  it("[f4-reopen-consumed] reopening a consumed claim (status open, consumed_at null) raises PAYOUT-31 / 23514", async () => {
    const { claim } = await consumedClaim();
    const error = await update(
      `UPDATE payroll_payout_return_claims SET status = 'open', consumed_at = NULL WHERE id = $1`,
      [claim.id],
    );
    expect(error, "the write must be rejected").not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.message).toContain("PAYOUT-31");
    const [after] = await W.rowsOf(
      `SELECT status FROM payroll_payout_return_claims WHERE id = $1`,
      [claim.id],
    );
    expect(after!.status).toBe("consumed");
  });

  it("[f4-rebind-claim] rewriting the proof key, item-set hash or owner of a claim raises PAYOUT-31 / 23514", async () => {
    const { claim } = await consumedClaim();
    for (const [column, value] of [
      ["evidence_key", `${claim.evidence_key as string}-other`],
      ["item_set_hash", "a".repeat(64)],
      ["created_by", "someone-else"],
    ] as const) {
      const error = await update(
        `UPDATE payroll_payout_return_claims SET ${column} = $2 WHERE id = $1`,
        [claim.id, value],
      );
      expect(error, `${column} must not change`).not.toBeNull();
      expect(error!.code).toBe("23514");
      expect(error!.message).toContain("PAYOUT-31");
    }
  });
});
